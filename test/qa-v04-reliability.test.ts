import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type AgyEvent } from '../src/common/types.ts'
import { DEFAULT_ACTIVITY_TIMEOUT_MS } from '../src/host/runner.ts'
import { Heartbeat } from '../src/host/heartbeat.ts'
import { EventMapper } from '../src/host/mapper.ts'
import { RunRegistry, RunRecording, parseMirrorCallId } from '../src/host/recording.ts'
import { AgyAdapter, detectContinuation, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { SubagentBridge, type DshSession, type DshSessionManager } from '../src/host/subagent-bridge.ts'
import { presentMirrorCall, presentMirrorResult } from '../src/host/mirror-tool.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'

// Helpers
function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as Message
}

function toolResult(callId: string, outputText = 'file written'): Message {
  return {
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: outputText }] }],
    source: { kind: 'tool', callId },
  } as unknown as Message
}

function mockCatalog(): ModelCatalog {
  return new ModelCatalog(async () => { throw new Error('no disc') }, defaultConfig().fallbackModels, 300_000)
}

test('活动看门狗强杀逻辑彻底拔除：允许长时思考，只认主动中止或进程崩溃', () => {
  const cfg = defaultConfig()
  // timeoutMs defaults to 600_000ms; activityTimeoutMs is deprecated and removed from default config
  assert.equal(cfg.timeoutMs, 600_000, 'PluginConfig.timeoutMs must default to 600_000ms (10 minutes)')
  assert.equal(cfg.activityTimeoutMs, undefined, 'activityTimeoutMs must be removed from default config')
})

test('死尸重放死锁根治 (Tombstone Guard): 已死亡的 Run 严禁瞬间重放错误，必须驱逐并降级为全新轮次', async () => {
  const runs = new RunRegistry(20, 60_000)
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), 'tombstone-test-')), 'sessions.json'))
  const catalog = mockCatalog()

  // Create a run that failed previously (e.g. process died or timed out)
  const deadRec = runs.create()
  deadRec.settle({ kind: 'error', code: 'PROCESS_EXIT', message: 'agy exited 1: broken' })

  // Verify run is in registry and dead
  assert.ok(runs.get(deadRec.runId))
  assert.ok(deadRec.failureInfo !== null)

  const fakeBin = join(tmpdir(), 'fake-agy-tombstone.sh')
  writeFileSync(fakeBin, '#!/bin/sh\necho \'{"type":"result","status":"success"}\'\n', { mode: 0o755 })

  const logs: string[] = []
  const deps: AgyAdapterDeps = {
    getConfig: () => ({ ...defaultConfig(), agyBin: fakeBin }),
    catalog,
    store,
    bin: () => fakeBin,
    acquire: async () => () => {},
    runs,
    log: (m) => logs.push(m),
  }

  const adapter = new AgyAdapter(deps)

  // Request comes in with trailing tool-result targeting the dead run's cursor
  const deadCallId = `agytc-${deadRec.runId}-0`
  const messages: Message[] = [
    msg('user', 'Please edit file.ts'),
    msg('assistant', 'I will write file.ts'),
    toolResult(deadCallId, 'file edit content applied'),
  ]

  const chunks: StreamChunk[] = []
  for await (const ch of adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    messages,
    tools: [{ name: 'bash', description: 'run shell', parameters: {} }],
    sessionId: 'sess-tombstone-1' as never,
  })) {
    chunks.push(ch)
  }

  // 1. Tombstone guard must evict the dead corpse from runs
  assert.equal(runs.get(deadRec.runId), undefined, 'Tombstone guard must call runs.forget to evict dead corpse')

  // 2. Tombstone guard must log the eviction
  assert.ok(logs.some((l) => l.includes('Tombstone guard')), 'Must log tombstone guard eviction')

  // 3. Must NOT replay the dead error (PROCESS_EXIT / broken)
  const finishChunk = chunks.find((c) => c.type === 'finish') as { type: 'finish'; reason: { kind: string } } | undefined
  assert.ok(finishChunk, 'Must produce a finish chunk')
  assert.notEqual(finishChunk.reason.kind, 'error', 'Must not replay dead error to frontend in 84ms')
})

test('死尸重放死锁根治 (Tombstone Guard): 已结算且耗尽 (settled && cursor >= length) 的 Run 自动驱逐并降级', async () => {
  const runs = new RunRegistry(20, 60_000)
  const store = new SessionStore(join(mkdtempSync(join(tmpdir(), 'tombstone-exhausted-')), 'sessions.json'))
  const catalog = mockCatalog()

  // Create a run that settled with 1 event
  const settledRec = runs.create()
  settledRec.append({ kind: 'step', stepKey: 's1', stepKind: 'text', text: 'done', raw: {} })
  settledRec.settle(null) // settled without error, length = 1

  assert.ok(settledRec.isSettled)
  assert.equal(settledRec.length, 1)

  const fakeBin = join(tmpdir(), 'fake-agy-exhausted.sh')
  writeFileSync(fakeBin, '#!/bin/sh\necho \'{"type":"result","status":"success"}\'\n', { mode: 0o755 })

  const logs: string[] = []
  const deps: AgyAdapterDeps = {
    getConfig: () => ({ ...defaultConfig(), agyBin: fakeBin }),
    catalog,
    store,
    bin: () => fakeBin,
    acquire: async () => () => {},
    runs,
    log: (m) => logs.push(m),
  }

  const adapter = new AgyAdapter(deps)

  // Continuation cursor eventIndex = 0 -> cursor = 1 >= rec.length (exhausted)
  const exhaustedCallId = `agytc-${settledRec.runId}-0`
  const messages: Message[] = [
    msg('user', 'Run task'),
    toolResult(exhaustedCallId, 'task output'),
  ]

  const chunks: StreamChunk[] = []
  for await (const ch of adapter.stream({
    provider: 'antigravity',
    model: 'gemini-3.8-flash',
    messages,
    sessionId: 'sess-tombstone-2' as never,
  })) {
    chunks.push(ch)
  }

  // Must be evicted
  assert.equal(runs.get(settledRec.runId), undefined, 'Exhausted settled run must be evicted from runs')
  assert.ok(logs.some((l) => l.includes('Tombstone guard')), 'Must log tombstone guard eviction')
})

test('流式思考保活与防假死生成器 (Heartbeat): 脉冲定时发射 reasoning-delta 并在真实事件到达时停止', async () => {
  const beats: number[] = []
  const hb = new Heartbeat({
    intervalMs: 20, // 20ms for fast test
    onBeat: (sec) => beats.push(sec),
  })

  hb.start()
  assert.equal(hb.isRunning, true)

  await new Promise((r) => setTimeout(r, 65))
  assert.ok(beats.length >= 2, 'Heartbeat must have pulsed at least twice')

  hb.stop()
  assert.equal(hb.isRunning, false)
  const countAtStop = beats.length

  await new Promise((r) => setTimeout(r, 40))
  assert.equal(beats.length, countAtStop, 'Stopped heartbeat must not pulse anymore')
})

test('EventMapper: emitHeartbeat 生成规范 reasoning-delta 并与后续事件无缝衔接', () => {
  const mapper = new EventMapper({
    runId: 'test-run-hb',
    cutOnTool: true,
  })

  // 1. Emit heartbeat pulse
  const hbChunks = Array.from(mapper.emitHeartbeat(3))
  assert.equal(hbChunks.length, 2)
  assert.deepEqual(hbChunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(hbChunks[1], { type: 'reasoning-delta', index: 0, text: '[Thinking · 3s elapsed]\n' })

  // 2. Subsequent heartbeat pulse reuses open reasoning block
  const hbChunks2 = Array.from(mapper.emitHeartbeat(6))
  assert.equal(hbChunks2.length, 1)
  assert.deepEqual(hbChunks2[0], { type: 'reasoning-delta', index: 0, text: '[Thinking · 6s elapsed]\n' })

  // 3. Real text event arrives: must cleanly close reasoning block and open text block
  const textChunks = Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-text-1',
    stepKind: 'text',
    text: 'Hello world',
    raw: {},
  }, 0))

  assert.equal(textChunks.length, 3)
  // Closes reasoning block at index 0
  assert.equal(textChunks[0]?.type, 'block-end')
  assert.equal((textChunks[0] as { block: { type: string } }).block.type, 'reasoning')
  // Starts text block at index 1
  assert.deepEqual(textChunks[1], { type: 'block-start', index: 1, blockType: 'text' })
  // Appends text delta
  assert.deepEqual(textChunks[2], { type: 'text-delta', index: 1, text: 'Hello world' })
})

test('agy 子代理完全映射到 DSH 原生子代理: define_subagent 角色保存与卡片化呈现', () => {
  const events: Array<{ name: string; payload: unknown }> = []
  const bridge = new SubagentBridge({
    emit: (name, payload) => events.push({ name, payload }),
  })

  // 1. define_subagent tool call
  const role = bridge.defineRole({
    name: 'architect',
    description: 'System Architect',
    instructions: 'Output system architecture module diagrams',
    tools: ['read', 'grep', 'bash'],
  })

  assert.equal(role.name, 'architect')
  assert.equal(role.description, 'System Architect')
  assert.deepEqual(role.tools, ['read', 'grep', 'bash'])

  // Verify registry lookup
  assert.equal(bridge.getRole('architect')?.name, 'architect')
  assert.equal(bridge.listRoles().length, 1)
  assert.ok(events.some((e) => e.name === 'subagent/defined'))

  // 2. Card presentation in mirror-tool
  const callCard = presentMirrorCall({
    tool: 'define_subagent',
    input: {
      name: 'architect',
      description: 'System Architect',
    },
  })
  assert.ok(callCard)
  assert.equal(callCard.card, 'generic')
  assert.equal(callCard.title, 'Define Subagent: architect (System Architect)')

  const resultCard = presentMirrorResult({ tool: 'define_subagent' }, { content: [{ type: 'text', text: 'Role defined' }], isError: false })
  assert.ok(resultCard)
  assert.equal(resultCard.card, 'generic')
})

test('agy 子代理完全映射到 DSH 原生子代理: invoke_subagent 创建 DSH 子会话并注入权威 subagent/descriptor', async () => {
  const createdSessions: Array<{ id: string; meta: unknown }> = []
  const appendedEvents: Array<{ sessionId: string; type: string; data: unknown }> = []

  const mockSessionManager: DshSessionManager = {
    get: (id: string) => {
      if (id === 'parent-sess-42') {
        return {
          id,
          meta: { cwd: '/workspace/project', delegationDepth: 1 },
          append: (type, data) => appendedEvents.push({ sessionId: id, type, data }),
        }
      }
      return undefined
    },
    create: (id, options) => {
      const sessId = id ?? 'generated-sess'
      const meta = options?.meta
      createdSessions.push({ id: sessId, meta })
      return {
        id: sessId,
        meta,
        append: (type, data) => appendedEvents.push({ sessionId: sessId, type, data }),
      }
    },
  }

  const events: Array<{ name: string; payload: unknown }> = []
  const bridge = new SubagentBridge({
    emit: (name, payload) => events.push({ name, payload }),
    sessions: mockSessionManager,
  })

  // Start subagent with parentSessionId
  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    toolArgs: {
      subagent_type: 'architect',
      description: 'Design Link Layer',
      instruction: 'Design link layer protocol',
    },
    parentSessionId: 'parent-sess-42',
    cwd: '/workspace/project',
  })

  assert.ok(session.childSession, 'Must hold reference to native DshSession')
  assert.equal(createdSessions.length, 1, 'Must create DSH child session via ctx.sessions.create')

  const childMeta = createdSessions[0]?.meta as { origin: string; parentSession: string; delegationDepth: number; cwd: string }
  assert.equal(childMeta.origin, 'subagent', 'Must set origin: subagent for DSH lineage tracking')
  assert.equal(childMeta.parentSession, 'parent-sess-42', 'Must link parentSession')
  assert.equal(childMeta.delegationDepth, 2, 'Must increment parent delegationDepth from 1 to 2')
  assert.equal(childMeta.cwd, '/workspace/project')

  // Verify authoritative subagent/descriptor event v3
  const descEvent = appendedEvents.find((e) => e.type === 'subagent/descriptor')
  assert.ok(descEvent, 'Must append subagent/descriptor event to child session')
  const descData = descEvent.data as { version: number; mode: string; provider: string; label: string }
  assert.equal(descData.version, 3, 'Descriptor version must be 3')
  assert.equal(descData.mode, 'one-shot', 'Descriptor mode must be one-shot')
  assert.equal(descData.provider, 'antigravity')
  assert.equal(descData.label, 'Design Link Layer')

  // Simulate subagent completion
  session.stop(undefined, 'Architecture blueprint created')

  // Verify terminal event in child session
  const msgEvent = appendedEvents.find((e) => e.type === 'assistant/message')
  assert.ok(msgEvent, 'Must append assistant/message with resultText')
  const turnEndEvent = appendedEvents.find((e) => e.type === 'turn/end')
  assert.ok(turnEndEvent, 'Must append turn/end event')
  assert.deepEqual((turnEndEvent.data as { reason: { kind: string } }).reason, { kind: 'completed' })
})

test('Defect 1 & 2: SubagentBridge reads parentSession.header and guarantees isAbsolute(cwd)', () => {
  let createdMeta: { cwd?: string; delegationDepth?: number; origin?: string; parentSession?: string } | undefined

  const mockSessions: DshSessionManager = {
    get: (id: string) => {
      if (id === 'parent-with-header') {
        return {
          id,
          header: { cwd: '/home/csy/Work/twoplus', delegationDepth: 3 },
          append: () => {},
        }
      }
      return undefined
    },
    create: (id, options) => {
      createdMeta = options?.meta as typeof createdMeta
      return {
        id: id ?? 'sub-sess',
        append: () => {},
      }
    },
  }

  const bridge = new SubagentBridge({ sessions: mockSessions })

  // 1. When cwd is empty string, fall back to parentSession.header.cwd
  bridge.startSubagent({
    toolName: 'invoke_subagent',
    toolArgs: { task: 'Analyze topology' },
    parentSessionId: 'parent-with-header',
    cwd: '',
  })

  assert.ok(createdMeta)
  assert.equal(createdMeta.delegationDepth, 4, 'Must increment header.delegationDepth')
  assert.equal(createdMeta.cwd, '/home/csy/Work/twoplus', 'Must fall back to header.cwd when cwd is empty string')
  assert.ok(createdMeta.cwd.startsWith('/'), 'Must be an absolute path')

  // 2. When cwd is a relative path, resolve to absolute
  bridge.startSubagent({
    toolName: 'invoke_subagent',
    toolArgs: { task: 'Analyze relative path' },
    cwd: 'relative/sub/dir',
  })

  assert.ok(createdMeta)
  assert.ok(createdMeta.cwd?.startsWith('/'), 'Relative path must be resolved to absolute path')
})

test('Defect 3: SubagentBridge parses agy native { Subagents: "[{\\"Model\\":...,\\"Prompt\\":...}]" } and synthesizes label', () => {
  let createdDesc: { version: number; mode: string; provider: string; label: string } | undefined
  const appended: Array<{ type: string; data: unknown }> = []

  const mockSessions: DshSessionManager = {
    create: (id) => ({
      id: id ?? 'sub-sess',
      append: (type, data) => {
        appended.push({ type, data })
        if (type === 'subagent/descriptor') {
          createdDesc = data as typeof createdDesc
        }
      },
    }),
  }

  const bridge = new SubagentBridge({ sessions: mockSessions })
  // Define role beforehand
  bridge.defineRole({ name: 'vnm_gui_specialist', description: 'VNM specialist' })

  // Long prompt simulating agy native payload
  const nativeSubagentsJson = JSON.stringify([
    {
      Model: 'inherit',
      Prompt: '接力继续执行并彻底完成 vnm_gui 首页纯净拓扑改造、拓扑图美化与标签完整展示、Sim 环境联调与 Tauri MCP 全页面截图验证任务。\n\n【前序进展与关键上下文】\n1. 本地仓库：/home/csy/Work/vnm_gui',
    },
  ])

  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    toolArgs: {
      Subagents: nativeSubagentsJson,
    },
  })

  assert.equal(session.subagentType, 'vnm_gui_specialist', 'Must inherit defined role when subagent_type omitted in item')
  assert.ok(createdDesc, 'Must append subagent/descriptor')
  assert.equal(createdDesc.version, 3)
  assert.equal(createdDesc.mode, 'one-shot')
  assert.equal(createdDesc.provider, 'antigravity')
  assert.ok(createdDesc.label.length <= 55, 'Label must be truncated to concise 40~50 chars')
  assert.ok(createdDesc.label.includes('接力继续执行并彻底完成 vnm_gui 首页纯净拓扑改造'), 'Label must capture prompt start')
})

test('Defect 5: EventMapper bridges step_type: "subagent" to SubagentBridge', () => {
  let subagentStarted = false
  let receivedArgs: unknown

  const fakeBridge = {
    startSubagent: (opts: { toolArgs?: unknown }) => {
      subagentStarted = true
      receivedArgs = opts.toolArgs
      return {
        runId: 'sub-run',
        subagentId: 'sub-sess',
        task: 'task',
        description: 'desc',
        subagentType: 'subagent',
        startedAt: Date.now(),
        stop: () => {},
      }
    },
  }

  const mapper = new EventMapper({
    cutOnTool: false,
    runId: 'run-1',
    usage: new RunRecording(),
    subagentBridge: fakeBridge as never,
  })

  // agy emits step_update with step_type: subagent and payload
  Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-sub',
    stepKind: 'subagent',
    text: 'analyzing',
    raw: {
      step_update: {
        step_type: 'subagent',
        payload: {
          subagent_type: 'security_auditor',
          task: 'Scan open ports',
        },
      },
    },
  }, 0))

  assert.equal(subagentStarted, true, 'step_type: "subagent" must trigger subagentBridge.startSubagent')
  assert.deepEqual(receivedArgs, { subagent_type: 'security_auditor', task: 'Scan open ports' })
})
