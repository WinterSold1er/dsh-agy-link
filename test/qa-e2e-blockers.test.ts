import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ResidentAgyChannel,
  AgyProcessSupervisor,
  isProcessAlive,
  DEFAULT_ACTIVITY_TIMEOUT_MS,
} from '../src/host/runner.ts'
import { RunRecording, RunRegistry } from '../src/host/recording.ts'
import { toMcpName, startMcpBridge, DSH_MANAGED_PREFIX, type ToolsServiceLike } from '../src/host/mcp-bridge.ts'
import { AgyAdapter, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

// ============================================================================
// BLOCKER-1 & BLOCKER-2: Aux Request & Supervisor Channel Safety
// ============================================================================

test('BLOCKER-1 & 2: supervisor.getChannel safely retires busy channel without aborting active turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-blocker1-sig-'))
  const stubBin = join(dir, 'turn-worker.mjs')

  // Worker delays 120ms before completing result
  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  await new Promise((r) => setTimeout(r, 120));
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: { status: 'DONE', response: 'completed: ' + (msg.message?.content || '') }
  }) + '\\n');
});
`,
  )

  const supervisor = new AgyProcessSupervisor()
  const optsDanger = {
    bin: process.execPath,
    args: [stubBin, '--permission-mode', 'danger-full-access'],
    cwd: dir,
  }

  try {
    // 1. Start Turn 1 on Channel Danger
    const chan1 = supervisor.getChannel('sess-key-1', optsDanger)
    const rec1 = new RunRecording()
    const turn1Promise = chan1.sendTurn({
      prompt: 'turn-1-data',
      recording: rec1,
      timeoutMs: 5000,
    })

    // Allow microtask to enter executeTurn
    await new Promise((r) => setTimeout(r, 20))

    // Turn 1 is currently active
    assert.equal(chan1.isRunning, true, 'Channel 1 must report isRunning === true')

    // 2. Aux request or mode change comes in while Turn 1 is running
    const optsPlan = {
      bin: process.execPath,
      args: [stubBin, '--permission-mode', 'plan'],
      cwd: dir,
    }

    // Must NOT kill chan1; chan1 must be retired, and new channel created
    const chan2 = supervisor.getChannel('sess-key-1', optsPlan)
    assert.notEqual(chan2.channelId, chan1.channelId, 'Must allocate new channel for changed config')
    assert.equal(chan1.isRetired(), true, 'Original busy channel must be marked retired')
    assert.equal(chan1.isAlive(), true, 'Original channel must NOT be killed while running')

    // 3. Turn 1 must complete successfully without being aborted!
    const outcome1 = await turn1Promise
    assert.equal(outcome1.aborted, false, 'Turn 1 must NOT be aborted by config change')
    assert.equal(outcome1.timedOut, false)
    assert.equal(rec1.getResultEvent()?.response, 'completed: turn-1-data')

    // 4. After completing, retired channel is automatically closed
    assert.equal(chan1.isAlive(), false, 'Retired channel must close itself after turn completion')

    // 5. New channel is healthy and can execute Turn 2
    const rec2 = new RunRecording()
    const outcome2 = await chan2.sendTurn({
      prompt: 'turn-2-plan',
      recording: rec2,
      timeoutMs: 5000,
    })
    assert.equal(outcome2.aborted, false)
    assert.equal(rec2.getResultEvent()?.response, 'completed: turn-2-plan')
  } catch (err) {
    console.error('TEST ERROR:', err)
    throw err
  } finally {
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BLOCKER-1 & 2: isAux request bypasses resident supervisor channel and does not preempt active main turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-blocker1-aux-'))
  const stubBin = join(dir, 'agy-dual.mjs')

  // Handles both resident stream-json and single-shot process execution
  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const isStream = process.argv.includes('--input-format') && process.argv.includes('stream-json');
if (isStream) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const msg = JSON.parse(line);
    // Main turn runs for 150ms
    await new Promise((r) => setTimeout(r, 150));
    process.stdout.write(JSON.stringify({
      event: 'step_update',
      idx: 1,
      step_type: 'text',
      text: 'main-result: ' + msg.message?.content
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      event: 'result',
      result: { status: 'DONE', response: 'main-result: ' + msg.message?.content }
    }) + '\\n');
  });
} else {
  // One-shot process (for aux requests like title generation)
  const pIdx = process.argv.indexOf('-p');
  const prompt = pIdx >= 0 ? process.argv[pIdx + 1] : '';
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      event: 'step_update',
      idx: 1,
      step_type: 'text',
      text: 'aux-title: ' + prompt
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      event: 'result',
      result: { status: 'DONE', response: 'aux-title: ' + prompt }
    }) + '\\n');
  }, 40);
}
`,
  )
  chmodSync(stubBin, 0o755)

  const cfg: PluginConfig = {
    ...defaultConfig(),
    agyBin: stubBin,
    workspaceRoot: dir,
    permissionMode: 'skip',
  }

  const supervisor = new AgyProcessSupervisor()
  const store = new SessionStore(join(dir, 'sessions.json'))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery in tests') },
    cfg.fallbackModels,
    300_000,
  )
  const runs = new RunRegistry()

  const deps: AgyAdapterDeps = {
    getConfig: () => cfg,
    store,
    catalog,
    bin: () => stubBin,
    runs,
    supervisor,
    acquire: async () => () => {},
  }

  const adapter = new AgyAdapter(deps)

  try {
    // 1. Launch main Turn 1 (isAux: false)
    const mainOpts = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] } as unknown as Message],
      sessionId: 'session-e2e-1' as never,
      purpose: undefined, // main turn
    } as GenerateOptions

    const mainGenerator = adapter.stream(mainOpts)
    const mainChunksPromise = (async () => {
      const chunks: string[] = []
      for await (const chunk of mainGenerator) {
        if (chunk.type === 'text-delta' && chunk.text) {
          chunks.push(chunk.text)
        }
      }
      return chunks
    })()

    // 2. 10ms later, auxiliary title request arrives (isAux: true) with same sessionKey
    await new Promise((r) => setTimeout(r, 10))
    const auxOpts = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'generate title' }] } as unknown as Message],
      sessionId: 'session-e2e-1' as never,
      purpose: 'session-title', // isAux === true
    } as GenerateOptions

    const auxGenerator = adapter.stream(auxOpts)
    const auxChunks: string[] = []
    for await (const chunk of auxGenerator) {
      if (chunk.type === 'text-delta' && chunk.text) {
        auxChunks.push(chunk.text)
      }
    }

    // Aux finishes cleanly
    assert.ok(auxChunks.length > 0, 'Aux title must yield text deltas')
    assert.ok(auxChunks.join('').includes('aux-title'), 'Aux title must yield aux-title result')

    // 3. Main Turn 1 must NOT have been aborted by the aux request!
    const mainChunks = await mainChunksPromise
    assert.ok(mainChunks.length > 0, 'Main turn must yield text deltas')
    assert.ok(mainChunks.join('').includes('main-result'), 'Main turn must complete with main-result')
  } finally {
    await supervisor.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ============================================================================
// BLOCKER-3: Silent Child / Soft-Deny Activity Watchdog
// ============================================================================

test('BLOCKER-3: activity watchdog recovers stuck resident channel when child produces no output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-blocker3-watchdog-'))
  const stubBin = join(dir, 'soft-deny-agy.mjs')

  // Script simulates a soft-deny or subagent hang where no result event is emitted
  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.message?.content === 'hang') {
    // Model soft-denies or hangs: outputs nothing, no result event
    return;
  }
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: { status: 'DONE', response: 'ok' }
  }) + '\\n');
});
`,
  )

  const channel = new ResidentAgyChannel({
    bin: process.execPath,
    args: [stubBin],
    cwd: dir,
    activityTimeoutMs: 120, // 120ms activity watchdog
  })

  // 1. Silent hang turn: must trigger timeout after 120ms
  const rec1 = new RunRecording()
  const outcome1 = await channel.sendTurn({
    prompt: 'hang',
    recording: rec1,
    timeoutMs: 120,
  })

  assert.equal(outcome1.timedOut, true, 'Silent child must time out via activity watchdog')
  assert.equal(channel['child'], null, 'Hanging child process must be reaped and cleared')

  // 2. Next turn: channel spawns fresh child and succeeds cleanly
  const rec2 = new RunRecording()
  const outcome2 = await channel.sendTurn({
    prompt: 'normal',
    recording: rec2,
    timeoutMs: 1200,
  })

  assert.equal(outcome2.timedOut, false)
  assert.equal(rec2.getResultEvent()?.response, 'ok', 'Subsequent turn must succeed with fresh child')

  channel.close()
  rmSync(dir, { recursive: true, force: true })
})

// ============================================================================
// BLOCKER-4: MCP Tool Name Truncation & Google CLI <= 64 RegEx Invariant
// ============================================================================

test('BLOCKER-4: toMcpName truncates tool names to <= 36 characters with hash, keeping Google CLI total <= 64', () => {
  const googleCliPrefix = `mcp_${DSH_MANAGED_PREFIX}dsh_tools_`
  assert.equal(googleCliPrefix.length, 27, 'Prefix mcp_dsh_managed__dsh_tools_ must be exactly 27 chars')

  const testNames = [
    // Standard names
    'read_file',
    'execute_bash',
    'search',
    // DSH prefixed names
    'mcp__dsh_tools_mcp__web_search_with_long_query',
    'mcp_dsh_managed__dsh_tools_mcp__web_search_with_extra_long_parameters_and_options',
    'very_long_tool_name_that_exceeds_sixty_four_characters_on_its_own_without_any_prefix_at_all',
    'a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p.q.r.s.t.u.v.w.x.y.z',
  ]

  const cliRegex = /^[a-zA-Z0-9_-]{1,64}$/

  for (const name of testNames) {
    const mapped = toMcpName(name)
    // 1. Mapped name must be <= 36 characters
    assert.ok(mapped.length <= 36, `Mapped name "${mapped}" (from "${name}") must be <= 36 chars, got ${mapped.length}`)
    assert.match(mapped, /^[a-zA-Z0-9_-]+$/, `Mapped name "${mapped}" must contain only valid chars`)

    // 2. Concatenated with Google CLI prefix must be strictly <= 64 chars
    const fullCliName = googleCliPrefix + mapped
    assert.ok(
      fullCliName.length <= 64,
      `Full Google CLI name "${fullCliName}" must be <= 64 chars, got ${fullCliName.length}`,
    )
    assert.ok(cliRegex.test(fullCliName), `Full Google CLI name "${fullCliName}" must match ^[a-zA-Z0-9_-]{1,64}$`)
  }

  // 3. Distinct long names must not collide thanks to hash
  const nameA = 'mcp__dsh_tools_mcp__tool_variant_alpha_with_long_common_prefix'
  const nameB = 'mcp__dsh_tools_mcp__tool_variant_beta_with_long_common_prefix'
  assert.notEqual(toMcpName(nameA), toMcpName(nameB), 'Distinct long names must produce distinct hashes')
})

test('BLOCKER-4: loopback MCP bridge serves short names and resolves execution by mapped name', async () => {
  const executedCalls: string[] = []

  const testTools: ToolsServiceLike = {
    schemas: () => [
      {
        name: 'mcp__dsh_tools_mcp__very_long_operation_name_that_needs_shortening',
        description: 'a very long tool',
        parameters: { properties: { arg: { type: 'string' } } },
      },
      {
        name: 'short_tool',
        description: 'a short tool',
        parameters: {},
      },
    ],
    execute: async (input) => {
      executedCalls.push(input.name)
      return { ok: true, output: 'executed ' + input.name }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript: '/fake/bridge.mjs',
    tools: () => testTools,
    allowlist: () => '',
  })

  try {
    // 1. Query /tools
    const res = await fetch(bridge.url + '/tools', {
      headers: { authorization: 'Bearer ' + bridge.token },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { tools: Array<{ name: string; dshName: string }> }

    assert.equal(body.tools.length, 2)
    for (const tool of body.tools) {
      assert.ok(tool.name.length <= 36, `Tool name ${tool.name} must be <= 36 characters`)
      assert.match(tool.name, /^[a-zA-Z0-9_-]+$/)
    }

    const longTool = body.tools.find((t) => t.dshName.includes('very_long_operation'))!
    assert.ok(longTool, 'Long tool must be present')
    assert.notEqual(longTool.name, longTool.dshName, 'Long tool must have shortened mapped name')

    // 2. Call via mapped short name
    const callRes = await fetch(bridge.url + '/call', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + bridge.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: longTool.name,
        arguments: { arg: 'val' },
      }),
    })
    assert.equal(callRes.status, 200)
    const callBody = (await callRes.json()) as { ok: boolean; text: string }
    assert.equal(callBody.ok, true)
    assert.ok(callBody.text.includes(longTool.dshName), 'Must resolve execution using original DSH tool name')
    assert.ok(executedCalls.includes(longTool.dshName))
  } finally {
    await bridge.close()
  }
})
