import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureProject,
  loadCodeAssist,
  clearProjectCache,
  stableProjectId,
  extractProjectId,
  antigravityHeaders,
} from '../src/host/client.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService } from '../src/host/quota.ts'

describe('M1: Core Client & Auth', () => {
  beforeEach(() => {
    clearProjectCache()
  })

  it('extractProjectId extracts project id from various payload shapes', () => {
    assert.equal(extractProjectId({ projectId: 'proj-123' }), 'proj-123')
    assert.equal(extractProjectId({ cloudaicompanionProject: { id: 'proj-nested' } }), 'proj-nested')
    assert.equal(extractProjectId({ cloudaicompanionProjects: [{ id: 'proj-arr' }] }), 'proj-arr')
    assert.equal(extractProjectId({ userDefinedCloudaicompanionProject: 'proj-ud' }), 'proj-ud')
  })

  it('stableProjectId produces deterministic UUID-shaped project ID', () => {
    const p1 = stableProjectId('user@example.com')
    const p2 = stableProjectId('user@example.com')
    const p3 = stableProjectId('other@example.com')
    assert.equal(p1, p2)
    assert.notEqual(p1, p3)
    assert.match(p1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('antigravityHeaders produces expected headers', () => {
    const headers = antigravityHeaders('fake-token')
    assert.equal(headers.Authorization, 'Bearer fake-token')
    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Accept, 'text/event-stream')
    assert.match(headers['User-Agent'], /^antigravity\//)
    assert.ok(headers['Client-Metadata'])
    const meta = JSON.parse(headers['Client-Metadata'])
    assert.equal(meta.ideType, 'ANTIGRAVITY')
    assert.equal(meta.pluginType, 'GEMINI')
  })

  it('AccountPoolManager memory token priority and semaphore', async () => {
    const pool = new AccountPoolManager('/tmp/dsh-test-pool-' + Date.now())
    const acc = pool.getAccounts()[0]!
    assert.ok(acc)

    // Initially no memory token
    assert.equal(pool.getMemoryToken(acc.id), null)

    // Set memory token
    pool.setMemoryToken(acc.id, 'mem-token-123', Date.now() + 60_000)
    assert.equal(pool.getMemoryToken(acc.id), 'mem-token-123')

    // Semaphore acquire
    const release = await pool.acquireAccount(acc.id, 2)
    assert.equal(typeof release, 'function')
    release()

    // Expired memory token
    pool.setMemoryToken(acc.id, 'expired-token', Date.now() - 1000)
    assert.equal(pool.getMemoryToken(acc.id), null)
  })

  it('QuotaService checks env ANTIGRAVITY_TOKEN and memory token before disk', async () => {
    const pool = new AccountPoolManager('/tmp/dsh-test-pool-quota-' + Date.now())
    const quota = new QuotaService(pool)
    const acc = pool.getAccounts()[0]!

    // 1. Memory token
    pool.setMemoryToken(acc.id, 'mem-token-abc', Date.now() + 60_000)
    const tok1 = await quota.getValidAccessToken(acc)
    assert.equal(tok1, 'mem-token-abc')

    // 2. Env token override
    process.env.ANTIGRAVITY_TOKEN = 'env-token-xyz'
    try {
      const tok2 = await quota.getValidAccessToken(acc)
      assert.equal(tok2, 'env-token-xyz')
    } finally {
      delete process.env.ANTIGRAVITY_TOKEN
    }
  })
})
