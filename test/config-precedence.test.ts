import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveConfig, overridesPath, dshHome, stateDir } from '../src/common/config.ts'

test('config precedence: runtime-overrides takes precedence over entryConfig', () => {
  const entry = {
    permissionMode: 'skip',
    defaultModel: 'gemini-2.5-pro',
    defaultEffort: 'medium',
    askTool: false,
    workspaceRoot: '/entry/workspace',
  }
  const overrides = {
    permissionMode: 'plan',
    defaultModel: 'gemini-3.0-flash',
    defaultEffort: 'high',
    askTool: true,
    workspaceRoot: '/override/workspace',
  }

  const cfg = resolveConfig(entry, {}, overrides)

  // Overrides must win over entryConfig
  assert.equal(cfg.permissionMode, 'plan')
  assert.equal(cfg.defaultModel, 'gemini-3.0-flash')
  assert.equal(cfg.defaultEffort, 'high')
  assert.equal(cfg.askTool, true)
  assert.equal(cfg.workspaceRoot, '/override/workspace')
})

test('config precedence: keys absent in runtime-overrides fall back to entryConfig and defaults', () => {
  const entry = {
    permissionMode: 'skip',
    defaultModel: 'gemini-2.5-pro',
  }
  // overrides only changes permissionMode
  const overrides = {
    permissionMode: 'accept-edits',
  }

  const cfg = resolveConfig(entry, {}, overrides)

  assert.equal(cfg.permissionMode, 'accept-edits') // from overrides
  assert.equal(cfg.defaultModel, 'gemini-2.5-pro') // from entry
  assert.equal(cfg.timeoutMs, 600_000) // from defaultConfig()
  assert.equal(cfg.maxConcurrent, 3) // from defaultConfig()
})

test('config precedence: process.env wins over runtime-overrides and entryConfig (ADR-13)', () => {
  const entry = { permissionMode: 'skip' }
  const overrides = { permissionMode: 'plan' }
  const env: NodeJS.ProcessEnv = { DSH_AGY_MODE: 'accept-edits' }

  const cfg = resolveConfig(entry, env, overrides)

  assert.equal(cfg.permissionMode, 'accept-edits')
})

test('config precedence: DSH_AGY_SKIP_PERMISSIONS in env wins over runtime-overrides', () => {
  const entry = { permissionMode: 'plan' }
  const overrides = { permissionMode: 'plan' }
  const env: NodeJS.ProcessEnv = { DSH_AGY_SKIP_PERMISSIONS: 'true' }

  const cfg = resolveConfig(entry, env, overrides)

  assert.equal(cfg.permissionMode, 'skip')
})

test('config precedence: explicit empty reset in overrides clears entryConfig values', () => {
  const entry = {
    workspaceRoot: '/pinned/workspace',
    defaultEffort: 'high',
  }
  const overrides = {
    workspaceRoot: '',
    defaultEffort: '',
  }

  const cfg = resolveConfig(entry, {}, overrides)

  assert.equal(cfg.workspaceRoot, '', 'workspaceRoot should reset to empty (cwd mode)')
  assert.equal(cfg.defaultEffort, '', 'defaultEffort should reset to empty (model default)')
})

test('config hot reload: subsequent resolveConfig reads updated runtime-overrides.json from disk immediately', () => {
  const tempDsh = mkdtempSync(join(tmpdir(), 'dsh-cfg-test-'))
  const env: NodeJS.ProcessEnv = { DSH_HOME: tempDsh }
  const targetDir = stateDir(env)
  mkdirSync(targetDir, { recursive: true })
  const targetFile = overridesPath(env)

  try {
    const entry = {
      permissionMode: 'skip',
      defaultModel: 'gemini-2.5-pro',
    }

    // 1. Initial state: runtime-overrides.json not present
    const initialCfg = resolveConfig(entry, env)
    assert.equal(initialCfg.permissionMode, 'skip')
    assert.equal(initialCfg.defaultModel, 'gemini-2.5-pro')

    // 2. Dynamic write (e.g. POST /plugins/agy-link/config {"key": "permissionMode", "value": "plan"})
    writeFileSync(targetFile, JSON.stringify({ permissionMode: 'plan' }), 'utf8')

    // Subsequent call must immediately read new override without caching
    const updatedCfg = resolveConfig(entry, env)
    assert.equal(updatedCfg.permissionMode, 'plan', 'overrides must override entryConfig hot from disk')
    assert.equal(updatedCfg.defaultModel, 'gemini-2.5-pro', 'non-overridden key stays from entryConfig')

    // 3. Dynamic secondary update (e.g. switching to accept-edits and updating defaultModel)
    writeFileSync(
      targetFile,
      JSON.stringify({ permissionMode: 'accept-edits', defaultModel: 'gemini-3.0-pro' }),
      'utf8',
    )

    const updatedCfg2 = resolveConfig(entry, env)
    assert.equal(updatedCfg2.permissionMode, 'accept-edits')
    assert.equal(updatedCfg2.defaultModel, 'gemini-3.0-pro')

    // 4. Overrides cleared on disk -> falls back to entryConfig
    unlinkSync(targetFile)
    const revertedCfg = resolveConfig(entry, env)
    assert.equal(revertedCfg.permissionMode, 'skip')
    assert.equal(revertedCfg.defaultModel, 'gemini-2.5-pro')
  } finally {
    rmSync(tempDsh, { recursive: true, force: true })
  }
})
