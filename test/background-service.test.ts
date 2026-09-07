import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os, { tmpdir } from 'node:os'
import {
  ProcessManager,
  readTailLines,
  assertValidServiceId,
  VALID_SERVICE_ID_REGEX,
  verifyProcessCommand,
  readNewLogs,
  DEFAULT_MAX_TAIL_BYTES,
} from '../src/host/process-manager.ts'
import { DaemonToolFacade } from '../src/host/daemon-tool.ts'
import { startMcpBridge, writeJsonFileAtomic, type ToolsServiceLike } from '../src/host/mcp-bridge.ts'
import { isProcessAlive, isCmdShim, windowsQuote } from '../src/host/runner.ts'
import { AgyAdapter, SYSTEM_BACKGROUND_SERVICE_DIRECTIVE } from '../src/host/adapter.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'

function createTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test('ProcessManager: start, readyPattern, logs, status, and stop', async () => {
  const baseDir = createTempDir('pm-lifecycle')
  const pm = new ProcessManager({ baseDir, graceMs: 500 })

  try {
    // 1. Start a long-running process with readyPattern
    const script = `
      console.log('INITIALIZING');
      setTimeout(() => console.log('SERVER_ONLINE: port 9090'), 50);
      setInterval(() => {}, 1000);
    `
    const res = await pm.start({
      id: 'web-server',
      command: process.execPath,
      args: ['-e', script],
      readyPattern: 'SERVER_ONLINE: port \\d+',
      readyTimeoutMs: 5000,
    })

    assert.equal(res.id, 'web-server')
    assert.equal(res.status, 'running')
    assert.equal(res.ready, true)
    assert.ok(typeof res.pid === 'number' && res.pid > 0)
    assert.ok(isProcessAlive(res.pid), 'OS process must be alive')

    // 2. Query status
    const st = await pm.status('web-server')
    assert.ok(st)
    assert.equal(st.status, 'running')
    assert.equal(st.pid, res.pid)

    const list = await pm.listStatus()
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, 'web-server')

    // 3. Read logs
    const logs = await pm.getLogs('web-server', 10)
    assert.ok(logs.includes('INITIALIZING'))
    assert.ok(logs.includes('SERVER_ONLINE: port 9090'))

    // 4. Duplicate start must be rejected
    await assert.rejects(
      pm.start({
        id: 'web-server',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      }),
      /already running/,
    )

    // 5. Stop process
    const stopped = await pm.stop('web-server')
    assert.equal(stopped.status, 'stopped')
    assert.ok(!isProcessAlive(res.pid), 'OS process must be terminated after stop')

    const stAfter = await pm.status('web-server')
    assert.ok(stAfter)
    assert.equal(stAfter.status, 'stopped')
  } finally {
    await pm.dispose()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
  }
})

test('readTailLines: correctly slices ring buffer logs by line count', async () => {
  const dir = createTempDir('tail-test')
  const file = join(dir, 'test.log')
  const lines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')

  try {
    const tail2 = await readTailLines(file, 2)
    assert.equal(tail2, 'line 4\nline 5')

    const tailAll = await readTailLines(file, 10)
    assert.equal(tailAll, lines.join('\n'))

    const tail1 = await readTailLines(file, 1)
    assert.equal(tail1, 'line 5')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('ProcessManager: cleanOrphanProcesses reaps leftover processes from crashes', async () => {
  const baseDir = createTempDir('pm-orphan')
  const logsDir = join(baseDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  // Spawn an external detached orphan process that will survive in OS
  const orphanChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  orphanChild.unref()
  const orphanPid = orphanChild.pid!
  assert.ok(isProcessAlive(orphanPid), 'Orphan child must be alive')

  // Manually synthesize a registry.json simulating a prior crash where status was 'running'
  const registryFile = join(baseDir, 'registry.json')
  writeJsonFileAtomic(registryFile, {
    services: {
      'crashed-service': {
        id: 'crashed-service',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: baseDir,
        pid: orphanPid,
        pgid: orphanPid,
        startedAt: Date.now() - 10_000,
        logPath: join(logsDir, 'crashed-service.log'),
        status: 'running',
      },
    },
  })

  // Start a new ProcessManager instance pointing to the same directory
  const pm = new ProcessManager({ baseDir, graceMs: 500 })
  try {
    const cleaned = await pm.cleanOrphanProcesses()
    assert.equal(cleaned, 1, 'Must have cleaned exactly 1 orphan process')
    assert.ok(!isProcessAlive(orphanPid), 'Orphan process must be reaped in the OS')

    const st = await pm.status('crashed-service')
    assert.ok(st)
    assert.equal(st.status, 'stopped')
  } finally {
    await pm.dispose()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
  }
})

test('ProcessManager: dispose gracefully terminates all running services', async () => {
  const baseDir = createTempDir('pm-dispose')
  const pm = new ProcessManager({ baseDir, graceMs: 500 })

  try {
    const s1 = await pm.start({
      id: 'srv-1',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })
    const s2 = await pm.start({
      id: 'srv-2',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    })

    assert.ok(isProcessAlive(s1.pid))
    assert.ok(isProcessAlive(s2.pid))

    await pm.dispose()

    assert.ok(!isProcessAlive(s1.pid), 's1 must be terminated on dispose')
    assert.ok(!isProcessAlive(s2.pid), 's2 must be terminated on dispose')
  } finally {
    try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
  }
})

test('DaemonToolFacade: implements InternalTool contract and dispatches actions', async () => {
  const baseDir = createTempDir('facade-test')
  const pm = new ProcessManager({ baseDir, graceMs: 500 })
  const facade = new DaemonToolFacade(pm)

  assert.equal(facade.name, 'background_service')
  assert.ok(facade.description.includes('Manage persistent background processes'))
  assert.equal(facade.parameters.type, 'object')

  try {
    // 1. Action: start
    const startRes = (await facade.execute({
      action: 'start',
      id: 'facade-daemon',
      command: process.execPath,
      args: ['-e', 'console.log("HELLO_DAEMON"); setInterval(() => {}, 1000)'],
      readyPattern: 'HELLO_DAEMON',
    })) as { ok: boolean; id: string; pid: number; status: string }

    assert.equal(startRes.ok, true)
    assert.equal(startRes.id, 'facade-daemon')
    assert.equal(startRes.status, 'running')
    assert.ok(startRes.pid > 0)

    // 2. Action: status (single)
    const stRes = (await facade.execute({
      action: 'status',
      id: 'facade-daemon',
    })) as { ok: boolean; service: { status: string; pid: number } }
    assert.equal(stRes.ok, true)
    assert.equal(stRes.service.status, 'running')
    assert.equal(stRes.service.pid, startRes.pid)

    // 3. Action: status (all)
    const listRes = (await facade.execute({
      action: 'status',
    })) as { ok: boolean; count: number; services: Array<{ id: string }> }
    assert.equal(listRes.ok, true)
    assert.equal(listRes.count, 1)
    assert.equal(listRes.services[0]?.id, 'facade-daemon')

    // 4. Action: logs
    const logRes = (await facade.execute({
      action: 'logs',
      id: 'facade-daemon',
      lines: 10,
    })) as { ok: boolean; content: string }
    assert.equal(logRes.ok, true)
    assert.ok(logRes.content.includes('HELLO_DAEMON'))

    // 5. Action: stop
    const stopRes = (await facade.execute({
      action: 'stop',
      id: 'facade-daemon',
    })) as { ok: boolean; status: string }
    assert.equal(stopRes.ok, true)
    assert.equal(stopRes.status, 'stopped')

    // 6. Invalid action
    await assert.rejects(
      facade.execute({ action: 'explode' }),
      /Unsupported action "explode"/,
    )
  } finally {
    await pm.dispose()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
  }
})

test('MCP Bridge: loopback prioritizes internalTools and isolates from DSH ToolsService', async () => {
  const baseDir = createTempDir('mcp-isolation')
  const pm = new ProcessManager({ baseDir, graceMs: 500 })
  const daemonFacade = new DaemonToolFacade(pm)

  let dshExecutedCount = 0
  const mockDshTools: ToolsServiceLike = {
    schemas: () => [
      {
        name: 'dsh_read_file',
        description: 'Read a file in workspace',
        parameters: { properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    execute: async (input) => {
      dshExecutedCount++
      return { output: `dsh executed ${input.name}` }
    },
  }

  const bridge = await startMcpBridge({
    bridgeScript: 'dummy.mjs',
    tools: () => mockDshTools,
    internalTools: () => [daemonFacade],
    allowlist: () => '',
  })

  try {
    // 1. Check GET /tools exposes both background_service and dsh_read_file
    const toolsRes = await fetch(`${bridge.url}/tools`, {
      headers: { Authorization: `Bearer ${bridge.token}` },
    })
    assert.equal(toolsRes.status, 200)
    const toolsBody = (await toolsRes.json()) as { tools: Array<{ name: string; dshName: string }> }
    const toolNames = toolsBody.tools.map((t) => t.dshName)
    assert.ok(toolNames.includes('background_service'), 'background_service must be in MCP tools list')
    assert.ok(toolNames.includes('dsh_read_file'), 'dsh_read_file must be in MCP tools list')

    // 2. Call background_service via loopback POST /call
    const callRes = await fetch(`${bridge.url}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify({
        dshName: 'background_service',
        arguments: {
          action: 'start',
          id: 'isolated-srv',
          command: process.execPath,
          args: ['-e', 'console.log("MCP_ISOLATED"); setInterval(() => {}, 1000)'],
        },
      }),
    })

    assert.equal(callRes.status, 200)
    const callBody = (await callRes.json()) as { ok: boolean; text?: string; error?: string }
    assert.equal(callBody.ok, true)
    assert.ok(callBody.text?.includes('Service "isolated-srv" started'))

    // CRITICAL: DSH ToolsService must NEVER have been called for background_service!
    assert.equal(
      dshExecutedCount,
      0,
      'Internal tool calls MUST NOT report to DSH ToolsService (Web UI isolation)',
    )

    // 3. Call standard DSH tool via loopback POST /call -> verify DSH ToolsService receives it
    const dshCallRes = await fetch(`${bridge.url}/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bridge.token}`,
      },
      body: JSON.stringify({
        dshName: 'dsh_read_file',
        arguments: { path: 'package.json' },
      }),
    })
    assert.equal(dshCallRes.status, 200)
    assert.equal(dshExecutedCount, 1, 'Regular DSH tools must route to DSH ToolsService')

    // Clean up running service
    await facadeStop(daemonFacade, 'isolated-srv')
  } finally {
    await bridge.close()
    await pm.dispose()
    try { rmSync(baseDir, { recursive: true, force: true }) } catch {}
  }
})

async function facadeStop(facade: DaemonToolFacade, id: string): Promise<void> {
  try {
    await facade.execute({ action: 'stop', id })
  } catch {}
}

test('AgyAdapter: injects SYSTEM_BACKGROUND_SERVICE_DIRECTIVE into system instructions', async () => {
  const cfg: PluginConfig = {
    ...defaultConfig(),
    forwardSystemPrompt: true,
  }
  const store = new SessionStore(join(tmpdir(), `test-sess-${Date.now()}.json`))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery') },
    cfg.fallbackModels,
    300_000,
  )
  const runs = new RunRegistry()

  let receivedPrompt = ''
  const adapter = new AgyAdapter({
    getConfig: () => cfg,
    catalog,
    store,
    bin: () => process.execPath,
    acquire: () => Promise.resolve(() => {}),
    runs,
  })

  // Spy on buildArgs to inspect assembled prompt
  const origBuildArgs = adapter['buildArgs'].bind(adapter)
  adapter['buildArgs'] = (opts) => {
    receivedPrompt = opts.prompt
    return origBuildArgs(opts)
  }

  const userPrompt = 'Run a test background service.'
  const systemPrompt = 'You are an autonomous engineering agent.'

  const prepared = await adapter.prepareCall('antigravity', 'gemini-3-6-flash')
  assert.ok(prepared)

  try {
    const iter = prepared.stream({
      provider: 'antigravity',
      model: 'gemini-3-6-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] } as never],
      system: systemPrompt,
    })[Symbol.asyncIterator]()
    await iter.next()
  } catch {}

  assert.ok(
    receivedPrompt.includes('System instructions:\n' + systemPrompt),
    'Original system instructions must be preserved',
  )
  assert.ok(
    receivedPrompt.includes(SYSTEM_BACKGROUND_SERVICE_DIRECTIVE),
    '<SYSTEM_BACKGROUND_SERVICE_DIRECTIVE> must be injected into system instructions',
  )
  assert.ok(
    receivedPrompt.includes('NEVER launch long-running or blocking background processes directly using "run_command"'),
    'Operational directive iron rule must be present',
  )
  assert.ok(
    receivedPrompt.endsWith(userPrompt),
    'User prompt must remain at the end',
  )
})

test('Defect 1 & 7: SYSTEM_BACKGROUND_SERVICE_DIRECTIVE injected unconditionally when mcpBridge && !isAux, and contains Google CLI full tool name', async () => {
  // Verify tool name prompt alignment (Defect 7)
  assert.ok(SYSTEM_BACKGROUND_SERVICE_DIRECTIVE.includes('mcp_dsh_managed__dsh_tools_background_service'))
  assert.ok(SYSTEM_BACKGROUND_SERVICE_DIRECTIVE.includes('background_service'))

  // Case A: forwardSystemPrompt is FALSE, mcpBridge is TRUE -> MUST inject directive
  const cfg1: PluginConfig = {
    ...defaultConfig(),
    forwardSystemPrompt: false,
    mcpBridge: true,
  }
  const store = new SessionStore(join(tmpdir(), `test-sess-${Date.now()}.json`))
  const catalog = new ModelCatalog(async () => { throw new Error('no disc') }, cfg1.fallbackModels, 300_000)
  const runs = new RunRegistry()

  let receivedPrompt1 = ''
  const adapter1 = new AgyAdapter({
    getConfig: () => cfg1,
    catalog,
    store,
    bin: () => process.execPath,
    acquire: () => Promise.resolve(() => {}),
    runs,
  })
  const origBuildArgs1 = adapter1['buildArgs'].bind(adapter1)
  adapter1['buildArgs'] = (opts) => {
    receivedPrompt1 = opts.prompt
    return origBuildArgs1(opts)
  }

  const prep1 = await adapter1.prepareCall('antigravity', 'gemini-3-6-flash')
  assert.ok(prep1)
  try {
    const iter = prep1.stream({
      provider: 'antigravity',
      model: 'gemini-3-6-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
    })[Symbol.asyncIterator]()
    await iter.next()
  } catch {}

  assert.ok(
    receivedPrompt1.includes(SYSTEM_BACKGROUND_SERVICE_DIRECTIVE),
    'Directive must be injected even when forwardSystemPrompt is false',
  )
  assert.ok(receivedPrompt1.endsWith('hello'))

  // Case B: mcpBridge is FALSE -> MUST NOT inject directive
  const cfg2: PluginConfig = {
    ...defaultConfig(),
    forwardSystemPrompt: false,
    mcpBridge: false,
  }
  let receivedPrompt2 = ''
  const adapter2 = new AgyAdapter({
    getConfig: () => cfg2,
    catalog,
    store,
    bin: () => process.execPath,
    acquire: () => Promise.resolve(() => {}),
    runs,
  })
  adapter2['buildArgs'] = (opts) => {
    receivedPrompt2 = opts.prompt
    return origBuildArgs1(opts)
  }
  const prep2 = await adapter2.prepareCall('antigravity', 'gemini-3-6-flash')
  assert.ok(prep2)
  try {
    const iter = prep2.stream({
      provider: 'antigravity',
      model: 'gemini-3-6-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
    })[Symbol.asyncIterator]()
    await iter.next()
  } catch {}

  assert.ok(
    !receivedPrompt2.includes(SYSTEM_BACKGROUND_SERVICE_DIRECTIVE),
    'Directive must NOT be injected when mcpBridge is false',
  )

  // Case C: isAux is TRUE (purpose: 'session-title' or 'compaction') -> MUST NOT inject directive
  let receivedPrompt3 = ''
  adapter1['buildArgs'] = (opts) => {
    receivedPrompt3 = opts.prompt
    return origBuildArgs1(opts)
  }
  try {
    const iter = prep1.stream({
      provider: 'antigravity',
      model: 'gemini-3-6-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'aux-call' }] } as never],
      purpose: 'session-title' as never,
    })[Symbol.asyncIterator]()
    await iter.next()
  } catch {}

  assert.ok(
    !receivedPrompt3.includes(SYSTEM_BACKGROUND_SERVICE_DIRECTIVE),
    'Directive must NOT be injected for auxiliary calls',
  )
})

test('Defect 2: PID reuse verification, reboot boundary check, and registry persistence', async () => {
  // 1. Linux /proc/<pid>/cmdline verification
  if (process.platform === 'linux') {
    // Current node process matches 'node'
    assert.ok(verifyProcessCommand(process.pid, 'node'))
    assert.ok(verifyProcessCommand(process.pid, process.execPath))
    // Current node process does NOT match postgres or ssh
    assert.ok(!verifyProcessCommand(process.pid, 'postgres'))
    assert.ok(!verifyProcessCommand(process.pid, 'sshd'))
    assert.ok(!verifyProcessCommand(process.pid, 'python3'))
  }
  assert.ok(!verifyProcessCommand(999999999, 'node'))

  // 2. Reboot boundary check
  const baseDir = createTempDir('pm-reboot')
  const pm = new ProcessManager({ baseDir, graceMs: 200 })

  // Write a registry entry that was started BEFORE system boot
  const bootTime = Date.now() - os.uptime() * 1000
  const fakeOldRecord = {
    id: 'pre-reboot-service',
    command: 'node',
    args: [],
    cwd: process.cwd(),
    pid: process.pid, // alive PID! But started before boot
    startedAt: bootTime - 3600_000, // 1 hour before boot
    logPath: join(baseDir, 'logs', 'pre-reboot-service.log'),
    status: 'running' as const,
  }
  pm['services'].set('pre-reboot-service', fakeOldRecord)
  pm['persistRegistry']()

  // cleanOrphanProcesses should mark it stopped WITHOUT killing our own process.pid!
  const cleaned = await pm.cleanOrphanProcesses()
  assert.equal(cleaned, 0, 'Must not send kill signal to pre-reboot process')
  const rec = await pm.status('pre-reboot-service')
  assert.equal(rec?.status, 'stopped')

  // 3. State persistence: registry.json on disk must be updated even when cleaned === 0
  const diskRaw = readFileSync(pm.registryPath, 'utf8')
  const diskData = JSON.parse(diskRaw)
  assert.equal(diskData.services['pre-reboot-service'].status, 'stopped')
})

test('Defect 3: Path traversal and invalid ID whitelist validation', async () => {
  const baseDir = createTempDir('pm-traversal')
  const pm = new ProcessManager({ baseDir })
  const facade = new DaemonToolFacade(pm)

  const invalidIds = [
    '../../etc/passwd',
    '../foo',
    '/root/secret',
    'foo/bar',
    'foo\\bar',
    'has space',
    'semi;colon',
    'pipe|cmd',
    'a'.repeat(65), // > 64 chars
    '',
  ]

  for (const badId of invalidIds) {
    // ProcessManager direct methods
    if (badId) {
      await assert.rejects(pm.start({ id: badId, command: process.execPath }), /Invalid service id/)
      await assert.rejects(pm.stop(badId), /Invalid service id/)
      await assert.rejects(pm.status(badId), /Invalid service id/)
      await assert.rejects(pm.getLogs(badId), /Invalid service id/)
    }

    // Facade actions
    await assert.rejects(
      facade.execute({ action: 'start', id: badId, command: process.execPath }),
      /Invalid service id|Missing required parameter/,
    )
    await assert.rejects(
      facade.execute({ action: 'stop', id: badId }),
      /Invalid service id|Missing required parameter/,
    )
    if (badId) {
      await assert.rejects(facade.execute({ action: 'status', id: badId }), /Invalid service id/)
      await assert.rejects(facade.execute({ action: 'logs', id: badId }), /Invalid service id/)
    }
  }

  // Valid ID accepted
  assert.ok(VALID_SERVICE_ID_REGEX.test('dev-server-123_test'))
  assertValidServiceId('dev-server-123_test')
})

test('Defect 4: readyPattern syntax pre-check and old log tail pseudo-readiness prevention', async () => {
  const baseDir = createTempDir('pm-ready')
  const pm = new ProcessManager({ baseDir })

  // 1. Invalid regex must reject BEFORE spawn
  await assert.rejects(
    pm.start({
      id: 'bad-regex-service',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      readyPattern: '[invalid(regex',
    }),
    /Invalid readyPattern/,
  )
  // No child spawned in registry or activeChildren
  assert.equal(pm['activeChildren'].size, 0)
  assert.equal(pm['services'].size, 0)

  // 2. Historic logs must NOT trigger false ready condition
  const logDir = join(baseDir, 'logs')
  const logPath = join(logDir, 'historic-service.log')
  // Write historic logs containing the ready token
  writeFileSync(logPath, 'HISTORIC_RUN: READY_EVENT_TRIGGERED\n')

  // Spawn process that does NOT print READY_EVENT_TRIGGERED for 300ms
  const delayedScript = `
    setTimeout(() => console.log('NEW_RUN: READY_EVENT_TRIGGERED'), 300);
    setInterval(() => {}, 1000);
  `
  const startTime = Date.now()
  const res = await pm.start({
    id: 'historic-service',
    command: process.execPath,
    args: ['-e', delayedScript],
    readyPattern: 'READY_EVENT_TRIGGERED',
    readyTimeoutMs: 3000,
  })

  const elapsed = Date.now() - startTime
  assert.ok(res.ready)
  // If it matched historic log, elapsed would be ~0ms. Since it waited for new log, elapsed >= 200ms.
  assert.ok(elapsed >= 200, `Must wait for new log output, elapsed=${elapsed}ms`)
  await pm.stop('historic-service')
})

test('Defect 5: readTailLines bounds backtrack and avoids OOM on carriage returns', async () => {
  const baseDir = createTempDir('pm-oom')
  const hugeCrPath = join(baseDir, 'progress-bar.log')

  // Write a 4MB file containing only '\r' and progress indicators, zero '\n'
  const chunk = Buffer.from('downloading 50%\r')
  const repeatCount = Math.ceil((4 * 1024 * 1024) / chunk.length)
  const fullBuf = Buffer.alloc(repeatCount * chunk.length)
  for (let i = 0; i < repeatCount; i++) {
    chunk.copy(fullBuf, i * chunk.length)
  }
  writeFileSync(hugeCrPath, fullBuf)

  // readTailLines with small maxBytes ceiling (e.g. 64KB)
  const startTime = Date.now()
  const tail = await readTailLines(hugeCrPath, 100, 64 * 1024)
  const duration = Date.now() - startTime

  assert.ok(tail.length <= 64 * 1024)
  assert.ok(tail.includes('downloading 50%'))
  assert.ok(duration < 1000, `Must complete bounded read fast, elapsed=${duration}ms`)

  // Default DEFAULT_MAX_TAIL_BYTES is 2MB
  assert.equal(DEFAULT_MAX_TAIL_BYTES, 2 * 1024 * 1024)
})

test('Defect 6: Windows .cmd compatibility helper and quoting verification', () => {
  assert.ok(isCmdShim('npm.cmd'))
  assert.ok(isCmdShim('build.bat'))
  assert.ok(isCmdShim('C:\\tools\\pnpm.CMD'))
  assert.ok(!isCmdShim('node.exe'))
  assert.ok(!isCmdShim('python'))

  // windowsQuote
  assert.equal(windowsQuote('simple'), 'simple')
  assert.equal(windowsQuote('path with spaces'), '"path with spaces"')
  assert.equal(windowsQuote('has"quote'), '"has\\"quote"')
})
