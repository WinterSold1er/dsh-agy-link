import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgyProcessSupervisor,
  extractConfigSignature,
  extractConversationId,
} from '../src/host/runner.ts'
import { RunRecording } from '../src/host/recording.ts'
import { AgyAdapter, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

async function waitFor<T>(f: () => T | undefined, ms = 5_000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = f()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('waitFor timed out')
}

test('extractConfigSignature: signature isolation ignores --conversation and -c context flags', () => {
  const baseArgs = ['agy', '--permission-mode', 'plan', '--model', 'gemini-2.5-pro']
  const sigBase = extractConfigSignature(baseArgs)

  // Adding --conversation should NOT alter config signature
  const withConv = ['agy', '--permission-mode', 'plan', '--model', 'gemini-2.5-pro', '--conversation', 'conv-12345']
  assert.equal(extractConfigSignature(withConv), sigBase)

  // Short flag -c should NOT alter config signature
  const withShortConv = ['agy', '-c', 'conv-12345', '--permission-mode', 'plan', '--model', 'gemini-2.5-pro']
  assert.equal(extractConfigSignature(withShortConv), sigBase)

  // Equals syntax --conversation=id should NOT alter config signature
  const withEqualsConv = ['agy', '--permission-mode', 'plan', '--model', 'gemini-2.5-pro', '--conversation=conv-12345']
  assert.equal(extractConfigSignature(withEqualsConv), sigBase)

  // Changing conversation ID should NOT alter config signature
  const withAnotherConv = ['agy', '--permission-mode', 'plan', '--model', 'gemini-2.5-pro', '--conversation', 'conv-67890']
  assert.equal(extractConfigSignature(withAnotherConv), sigBase)

  // Changing permission-mode DOES alter config signature
  const withDangerMode = ['agy', '--permission-mode', 'danger-full-access', '--model', 'gemini-2.5-pro', '--conversation', 'conv-12345']
  assert.notEqual(extractConfigSignature(withDangerMode), sigBase)

  // Changing model DOES alter config signature
  const withOtherModel = ['agy', '--permission-mode', 'plan', '--model', 'claude-sonnet-4-6', '--conversation', 'conv-12345']
  assert.notEqual(extractConfigSignature(withOtherModel), sigBase)
})

test('extractConversationId: extracts conversation ID from argv correctly', () => {
  assert.equal(extractConversationId(['--conversation', 'conv-abc']), 'conv-abc')
  assert.equal(extractConversationId(['-c', 'conv-xyz']), 'conv-xyz')
  assert.equal(extractConversationId(['--conversation=conv-eq']), 'conv-eq')
  assert.equal(extractConversationId(['--other-flag', 'val']), undefined)
  assert.equal(extractConversationId([]), undefined)
})

test('Supervisor: Turn 1 produces conversationId, mode change retires old channel, Turn 2 inherits --conversation across process boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conv-inherit-sup-'))
  const stubBin = join(dir, 'resident-worker.mjs')
  const argvLogFile = join(dir, 'argv-history.jsonl')

  // Worker records process.argv on startup and handles resident turns
  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const logFile = ${JSON.stringify(argvLogFile)};
appendFileSync(logFile, JSON.stringify({ pid: process.pid, argv: process.argv }) + '\\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.event === 'user') {
    const prompt = msg.message?.content || '';
    if (prompt.includes('turn-1')) {
      // Emit init with conversationId
      process.stdout.write(JSON.stringify({
        event: 'init',
        conversationId: 'conv-12345',
      }) + '\\n');

      // Delay to simulate ongoing active turn
      await new Promise((r) => setTimeout(r, 300));

      process.stdout.write(JSON.stringify({
        event: 'result',
        conversationId: 'conv-12345',
        result: { status: 'DONE', response: 'turn-1 completed smoothly' },
      }) + '\\n');
    } else {
      // Turn 2
      process.stdout.write(JSON.stringify({
        event: 'result',
        conversationId: 'conv-12345',
        result: { status: 'DONE', response: 'turn-2 completed smoothly: ' + prompt },
      }) + '\\n');
    }
  }
});
`,
  )
  chmodSync(stubBin, 0o755)

  const supervisor = new AgyProcessSupervisor()
  const optsDanger = {
    bin: process.execPath,
    args: [stubBin, '--permission-mode', 'danger-full-access'],
    cwd: dir,
  }

  try {
    // 1. Start Turn 1 with danger-full-access mode
    const chan1 = supervisor.getChannel('session-test-1', optsDanger)
    const rec1 = new RunRecording()
    const turn1Promise = chan1.sendTurn({
      prompt: 'run turn-1 work',
      recording: rec1,
      timeoutMs: 5000,
    })

    // Wait for worker to emit init event and supervisor to record conversationId
    await waitFor(() => supervisor.getConversationId('session-test-1'))

    assert.equal(chan1.isRunning, true, 'Channel 1 must be active while running Turn 1')
    assert.equal(supervisor.getConversationId('session-test-1'), 'conv-12345', 'Supervisor must capture conversationId from Turn 1')

    // 2. Switch permission mode: danger-full-access -> plan
    // Note: optsPlan does NOT explicitly pass --conversation, supervisor must inherit it automatically
    const optsPlan = {
      bin: process.execPath,
      args: [stubBin, '--permission-mode', 'plan'],
      cwd: dir,
    }

    const chan2 = supervisor.getChannel('session-test-1', optsPlan)
    assert.notEqual(chan2.channelId, chan1.channelId, 'Must allocate new channel for changed config signature')
    assert.equal(chan1.isRetired(), true, 'Active busy channel must be marked retired')
    assert.equal(chan1.isAlive(), true, 'Active channel must NOT be killed prematurely while running')

    // Verify chan2 command args automatically inherited --conversation conv-12345
    assert.ok(chan2.args.includes('--conversation'), 'chan2 args must include --conversation')
    const convIdx = chan2.args.indexOf('--conversation')
    assert.equal(chan2.args[convIdx + 1], 'conv-12345', 'chan2 must carry the inherited conversationId')

    // 3. Verify Turn 1 completes smoothly without abort
    const outcome1 = await turn1Promise
    assert.equal(outcome1.aborted, false, 'Turn 1 must not be aborted by config change')
    assert.equal(outcome1.timedOut, false)
    assert.equal(rec1.getResultEvent()?.response, 'turn-1 completed smoothly')

    // 4. After Turn 1 completes, retired channel is closed
    assert.equal(chan1.isAlive(), false, 'Retired channel must close itself after turn completion')

    // 5. Execute Turn 2 on the new channel
    const rec2 = new RunRecording()
    const outcome2 = await chan2.sendTurn({
      prompt: 'run turn-2 work',
      recording: rec2,
      timeoutMs: 5000,
    })
    assert.equal(outcome2.aborted, false, 'Turn 2 must complete without error')
    assert.equal(rec2.getResultEvent()?.response, 'turn-2 completed smoothly: run turn-2 work')

    // 6. Inspect logged process.argv for both child processes
    const rawLogs = readFileSync(argvLogFile, 'utf8').trim().split('\n')
    assert.equal(rawLogs.length, 2, 'Exactly two child processes must have been spawned')

    const proc1 = JSON.parse(rawLogs[0]!) as { pid: number; argv: string[] }
    const proc2 = JSON.parse(rawLogs[1]!) as { pid: number; argv: string[] }

    assert.notEqual(proc1.pid, proc2.pid, 'Turn 1 and Turn 2 must run in distinct OS child processes')
    assert.ok(proc1.argv.includes('danger-full-access'), 'Child 1 argv must contain danger-full-access')
    assert.ok(proc2.argv.includes('plan'), 'Child 2 argv must contain plan mode')
    assert.ok(proc2.argv.includes('--conversation'), 'Child 2 argv must contain --conversation')
    assert.equal(proc2.argv[proc2.argv.indexOf('--conversation') + 1], 'conv-12345', 'Child 2 must receive conv-12345')
  } finally {
    await supervisor.dispose()
  }
})

test('AgyAdapter end-to-end: Turn 1 creates conversationId, config switch retires channel, Turn 2 inherits conversationId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conv-inherit-adapter-'))
  const stubBin = join(dir, 'adapter-worker.mjs')
  const argvLogFile = join(dir, 'adapter-argv.jsonl')

  // Stub worker handles resident stream-json
  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const logFile = ${JSON.stringify(argvLogFile)};
appendFileSync(logFile, JSON.stringify({ pid: process.pid, argv: process.argv }) + '\\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.event === 'user') {
    const prompt = msg.message?.content || '';
    if (prompt.includes('turn-1-prompt')) {
      process.stdout.write(JSON.stringify({
        event: 'init',
        conversationId: 'conv-e2e-8888',
      }) + '\\n');

      await new Promise((r) => setTimeout(r, 300));

      process.stdout.write(JSON.stringify({
        event: 'step_update',
        idx: 1,
        step_type: 'text',
        text: 'response from turn 1',
      }) + '\\n');

      process.stdout.write(JSON.stringify({
        event: 'result',
        conversationId: 'conv-e2e-8888',
        result: { status: 'DONE', response: 'response from turn 1' },
      }) + '\\n');
    } else {
      // Turn 2
      process.stdout.write(JSON.stringify({
        event: 'step_update',
        idx: 1,
        step_type: 'text',
        text: 'response from turn 2',
      }) + '\\n');

      process.stdout.write(JSON.stringify({
        event: 'result',
        conversationId: 'conv-e2e-8888',
        result: { status: 'DONE', response: 'response from turn 2' },
      }) + '\\n');
    }
  }
});
`,
  )
  chmodSync(stubBin, 0o755)

  let currentPermissionMode: PluginConfig['permissionMode'] = 'skip'
  const cfg: PluginConfig = {
    ...defaultConfig(),
    agyBin: stubBin,
    workspaceRoot: dir,
    get permissionMode() {
      return currentPermissionMode
    },
    set permissionMode(v) {
      currentPermissionMode = v
    },
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
    // 1. Launch Turn 1 with permissionMode: 'skip'
    cfg.permissionMode = 'skip'
    const turn1Opts: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'turn-1-prompt' }] } as unknown as Message],
      sessionId: 'session-adapter-inherit-1' as never,
    }

    const gen1 = adapter.stream(turn1Opts)
    const chunks1: string[] = []
    for await (const chunk of gen1) {
      if (chunk.type === 'text-delta' && chunk.text) {
        chunks1.push(chunk.text)
      }
    }

    assert.ok(chunks1.join('').includes('response from turn 1'), 'Turn 1 must succeed and yield text')
    assert.equal(adapter.getLastConversationId('session-adapter-inherit-1'), 'conv-e2e-8888')

    // 2. User switches permission mode to 'plan' in DSH settings for next turn
    cfg.permissionMode = 'plan'

    // 3. Launch Turn 2 with changed permission mode
    const turn2Opts: GenerateOptions = {
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'turn-1-prompt' }] } as unknown as Message,
        { role: 'assistant', content: [{ type: 'text', text: 'response from turn 1' }] } as unknown as Message,
        { role: 'user', content: [{ type: 'text', text: 'turn-2-prompt' }] } as unknown as Message,
      ],
      sessionId: 'session-adapter-inherit-1' as never,
    }

    const gen2 = adapter.stream(turn2Opts)
    const chunks2: string[] = []
    for await (const chunk of gen2) {
      if (chunk.type === 'text-delta' && chunk.text) {
        chunks2.push(chunk.text)
      }
    }

    assert.ok(chunks2.join('').includes('response from turn 2'), 'Turn 2 must succeed and yield text')

    // 5. Verify process.argv of spawned children
    assert.ok(existsSync(argvLogFile))
    const lines = readFileSync(argvLogFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, 'Exactly two child processes must be spawned')

    const proc1 = JSON.parse(lines[0]!) as { pid: number; argv: string[] }
    const proc2 = JSON.parse(lines[1]!) as { pid: number; argv: string[] }

    assert.notEqual(proc1.pid, proc2.pid, 'Turn 1 and Turn 2 ran in different processes')
    assert.ok(proc1.argv.includes('--dangerously-skip-permissions'), 'Child 1 had skip mode')
    assert.ok(proc2.argv.includes('--mode') && proc2.argv.includes('plan'), 'Child 2 had plan mode')
    assert.ok(proc2.argv.includes('--conversation'), 'Child 2 argv included --conversation')
    assert.equal(proc2.argv[proc2.argv.indexOf('--conversation') + 1], 'conv-e2e-8888', 'Child 2 inherited conv-e2e-8888')

    // SessionStore also persisted the binding
    assert.equal(store.get('session-adapter-inherit-1')?.conversationId, 'conv-e2e-8888')
  } finally {
    await supervisor.dispose()
  }
})

test('AgyAdapter: model switch invalidates lastConversationId and does not inherit stale conversationId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conv-model-switch-'))
  const stubBin = join(dir, 'model-worker.mjs')
  const argvLogFile = join(dir, 'model-argv.jsonl')

  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const logFile = ${JSON.stringify(argvLogFile)};
appendFileSync(logFile, JSON.stringify({ pid: process.pid, argv: process.argv }) + '\\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.event === 'user') {
    const isModel1 = process.argv.includes('gemini-3.7-flash');
    const cid = isModel1 ? 'conv-model-1' : 'conv-model-2';
    process.stdout.write(JSON.stringify({ event: 'init', conversationId: cid }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'result', conversationId: cid, result: { status: 'DONE', response: 'ok' } }) + '\\n');
  }
});
`,
  )
  chmodSync(stubBin, 0o755)

  const cfg: PluginConfig = {
    ...defaultConfig(),
    agyBin: stubBin,
    workspaceRoot: dir,
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
    // Turn 1: model gemini-3.7-flash
    const gen1 = adapter.stream({
      provider: 'antigravity',
      model: 'gemini-3.7-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'turn 1' }] } as unknown as Message],
      sessionId: 'sess-model-switch' as never,
    })
    for await (const _ of gen1) {}

    assert.equal(adapter.getLastConversationId('sess-model-switch'), 'conv-model-1')

    // Turn 2: switch to claude-sonnet-4-6
    const gen2 = adapter.stream({
      provider: 'antigravity',
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'turn 1' }] } as unknown as Message,
        { role: 'assistant', content: [{ type: 'text', text: 'turn 1 reply' }] } as unknown as Message,
        { role: 'user', content: [{ type: 'text', text: 'turn 2' }] } as unknown as Message,
      ],
      sessionId: 'sess-model-switch' as never,
    })
    for await (const _ of gen2) {}

    const lines = readFileSync(argvLogFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)

    const proc2 = JSON.parse(lines[1]!) as { argv: string[] }
    // When switching model, stale conv-model-1 must NOT be passed to claude
    assert.ok(!proc2.argv.includes('conv-model-1'), 'Turn 2 must NOT inherit conv-model-1 on model switch')
    assert.equal(adapter.getLastConversationId('sess-model-switch'), 'conv-model-2')
  } finally {
    await supervisor.dispose()
  }
})

test('Supervisor: same config signature reuses channel and does not retire channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conv-reuse-'))
  const stubBin = join(dir, 'reuse-worker.mjs')

  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.event === 'user') {
    process.stdout.write(JSON.stringify({ event: 'init', conversationId: 'conv-reuse-1' }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'result', conversationId: 'conv-reuse-1', result: { status: 'DONE', response: 'ok: ' + (msg.message?.content || '') } }) + '\\n');
  }
});
`,
  )
  chmodSync(stubBin, 0o755)

  const supervisor = new AgyProcessSupervisor()
  const opts = {
    bin: process.execPath,
    args: [stubBin, '--permission-mode', 'plan'],
    cwd: dir,
  }

  try {
    const chan1 = supervisor.getChannel('sess-reuse', opts)
    const rec1 = new RunRecording()
    await chan1.sendTurn({ prompt: 'msg 1', recording: rec1 })

    assert.equal(chan1.lastConversationId, 'conv-reuse-1')
    assert.equal(supervisor.getConversationId('sess-reuse'), 'conv-reuse-1')

    // Turn 2 with same config (even with or without explicit conversationId)
    const chan2 = supervisor.getChannel('sess-reuse', opts)
    assert.equal(chan2.channelId, chan1.channelId, 'Channel must be reused for identical signature')
    assert.equal(chan1.isRetired(), false, 'Channel must NOT be retired when signature matches')

    const rec2 = new RunRecording()
    await chan2.sendTurn({ prompt: 'msg 2', recording: rec2 })
    assert.equal(rec2.getResultEvent()?.response, 'ok: msg 2')
  } finally {
    await supervisor.dispose()
  }
})
