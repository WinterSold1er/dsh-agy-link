import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SubagentBridge, defaultBrainDir, type DshSession, type DshSessionManager, uriToPath } from '../src/host/subagent-bridge.ts'
import { EventMapper, parseSubagentOutput } from '../src/host/mapper.ts'
import { RunRecording } from '../src/host/recording.ts'

interface MockSessionRecord {
  id: string
  meta: Record<string, unknown> | undefined
  events: Array<{ type: string; data: unknown; opts?: unknown }>
}

function createMockSessionManager(): {
  manager: DshSessionManager
  sessions: Map<string, MockSessionRecord>
} {
  const sessions = new Map<string, MockSessionRecord>()

  const manager: DshSessionManager = {
    get(id: string): DshSession | undefined {
      const rec = sessions.get(id)
      if (!rec) return undefined
      return {
        id: rec.id,
        meta: rec.meta,
        header: rec.meta,
        append(type: string, data: unknown, opts?: unknown) {
          rec.events.push({ type, data, opts })
        },
      }
    },
    create(id?: string, options?: { meta?: Record<string, unknown> }): DshSession {
      const sessId = id ?? `mock-session-${sessions.size + 1}`
      const rec: MockSessionRecord = {
        id: sessId,
        meta: options?.meta,
        events: [],
      }
      sessions.set(sessId, rec)
      return {
        id: sessId,
        meta: rec.meta,
        header: rec.meta,
        append(type: string, data: unknown, opts?: unknown) {
          rec.events.push({ type, data, opts })
        },
      }
    },
  }

  return { manager, sessions }
}

test('Subagent Pipeline E2E: 5-stage serial execution (Requirement -> Architect -> Developer -> Reviewer -> QA) in real cutOnTool: true environment across Spans', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-pipeline-e2e-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()

  // Seed parent session
  mockSessions.create('parent-session-main', {
    meta: {
      cwd: '/home/csy/Work/dsh-agy-link',
      delegationDepth: 1,
    },
  })

  const bridge = new SubagentBridge({ sessions: mockSessions })

  // Define 5 roles
  const phases = [
    { role: 'requirement', desc: 'Requirement Analyst', prompt: 'Draft PRD and verify acceptance criteria' },
    { role: 'architect', desc: 'System Architect', prompt: 'Design modular service architecture and interface seams' },
    { role: 'developer', desc: 'Development Engineer', prompt: 'Implement targeted tailer and pipeline mapper' },
    { role: 'reviewer', desc: 'Devil Advocate Reviewer', prompt: 'Adversarial code review for boundary and null safety' },
    { role: 'qa', desc: 'Relentless Verifier', prompt: 'Verify all E2E pipeline and multi-subagent tests pass' },
  ]

  for (const p of phases) {
    bridge.defineRole({ name: p.role, description: p.desc })
  }

  try {
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]!
      const convId = `conv-phase-${i + 1}-${phase.role}`
      const phaseLogDir = join(tmpRoot, convId, '.system_generated', 'logs')
      mkdirSync(phaseLogDir, { recursive: true })
      const transcriptFile = join(phaseLogDir, 'transcript.jsonl')

      // Initial empty transcript
      writeFileSync(transcriptFile, '', 'utf8')

      // 1. Span 1 with cutOnTool: true receives invoke_subagent tool call
      const span1Mapper = new EventMapper({
        runId: 'main-pipeline-run',
        cutOnTool: true, // 真实的生产环境配置
        usage: new RunRecording(),
        subagentBridge: bridge,
        parentSessionId: 'parent-session-main',
        cwd: '/home/csy/Work/dsh-agy-link',
      })

      const stepKey = `step-call-${i}`
      const toolOutput = JSON.stringify({
        conversationId: convId,
        logAbsoluteUri: `file://${transcriptFile}`,
      })

      const span1Chunks = Array.from(span1Mapper.map({
        kind: 'step',
        stepKey,
        stepKind: 'tool',
        text: '',
        tool: {
          name: 'invoke_subagent',
          args: {
            subagent_type: phase.role,
            description: phase.desc,
            prompt: phase.prompt,
          },
          output: toolOutput,
        },
        raw: {},
      }, i * 10))

      // Verify that Span 1 cut on tool!
      assert.equal(span1Mapper.isFinished, true, 'Span 1 must be cut when tool completes')
      const finishChunk = span1Chunks.find((c) => c.type === 'finish')
      assert.ok(finishChunk, 'Span 1 must emit finish chunk')
      assert.equal((finishChunk as { reason: { kind: string } }).reason.kind, 'tool-calls')

      // 2. Child writes realistic execution transcript:
      const transcriptContent = [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          content: phase.prompt,
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          thinking: `Thinking in phase ${phase.role}: analyzing instructions and exploring repository...`,
          tool_calls: [
            {
              name: 'read_file',
              args: { path: 'src/host/mapper.ts' },
            },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          content: `File content of src/host/mapper.ts read for ${phase.role}`,
        }),
        JSON.stringify({
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: `Phase ${phase.role} deliverables produced and verified successfully.`,
        }),
      ].join('\n') + '\n'

      writeFileSync(transcriptFile, transcriptContent, 'utf8')

      // 3. Allow tailer poll tick to read the lines
      await new Promise((resolve) => setTimeout(resolve, 250))

      // 4. Continuation Span starts with a NEW EventMapper (span1Mapper is discarded!)
      const continuationMapper = new EventMapper({
        runId: 'main-pipeline-run',
        cutOnTool: true,
        initialSawText: true,
        usage: new RunRecording(),
        subagentBridge: bridge, // bridge is shared across spans!
        parentSessionId: 'parent-session-main',
        cwd: '/home/csy/Work/dsh-agy-link',
      })

      // Parent receives SYSTEM_MESSAGE in the continuation mapper
      const sysMsgText = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-07T06:01:01Z sender=${convId} priority=MESSAGE_PRIORITY_HIGH content=Phase ${phase.role} deliverables verified.\n</SYSTEM_MESSAGE>`
      Array.from(continuationMapper.map({
        kind: 'step',
        stepKey: `step-sys-${i}`,
        stepKind: 'unknown',
        text: sysMsgText,
        raw: {
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          content: sysMsgText,
        },
      }, i * 10 + 1))

      // Assert this phase's child session exists and satisfies all DSH seam requirements
      const childSessionId = `agy-${convId}`
      const childSessionRec = sessions.get(childSessionId)
      assert.ok(childSessionRec, `Child session ${childSessionId} must be registered in DSH session store`)

      const meta = childSessionRec.meta as Record<string, unknown>
      assert.equal(meta?.origin, 'subagent', 'Must set origin: subagent for DSH lineage tracking')
      assert.equal(meta?.parentSession, 'parent-session-main', 'Must link parentSession')
      assert.equal(meta?.delegationDepth, 2, 'Must increment parent delegationDepth from 1 to 2')
      assert.equal(meta?.cwd, '/home/csy/Work/dsh-agy-link', 'cwd must be absolute path')

      // Verify authoritative DSH surface event sequence
      const evTypes = childSessionRec.events.map((e) => e.type)
      assert.ok(evTypes.includes('turn/start'), 'Must include turn/start')
      assert.ok(evTypes.includes('subagent/descriptor'), 'Must include subagent/descriptor')
      assert.ok(evTypes.includes('user/message'), 'Must include user/message')
      assert.ok(evTypes.includes('assistant/chunk'), 'Must stream assistant/chunk from transcript')
      assert.ok(evTypes.includes('tool/call'), 'Must stream tool/call from transcript')
      assert.ok(evTypes.includes('tool/result'), 'Must stream tool/result from transcript')
      assert.ok(evTypes.includes('turn/end'), 'Must close with turn/end')

      // Verify turn/end is completed
      const turnEndEv = childSessionRec.events.find((e) => e.type === 'turn/end')
      assert.deepEqual((turnEndEv?.data as { reason: { kind: string } }).reason, { kind: 'completed' })
    }

    // 5. Assert all 5 subagents were created, zero dropped, and no ghost active sessions left!
    assert.equal(sessions.size, 6, '1 parent session + 5 subagent sessions must exist')
    assert.equal(bridge.hasActiveSubagents(), false, 'All subagents must be closed, zero ghost active subagents')
  } finally {
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Subagent Pipeline E2E [Critical 1]: Parent SYSTEM_MESSAGE across cutOnTool: true Span cleanly closes active subagent session', async () => {
  const { manager: mockSessions, sessions } = createMockSessionManager()

  const bridge = new SubagentBridge({ sessions: mockSessions })
  const convId = 'bf17c78c-7c34-4165-97f5-27252f06fefe'

  // Span 1 with cutOnTool: true
  const span1 = new EventMapper({
    runId: 'sys-msg-run',
    cutOnTool: true,
    usage: new RunRecording(),
    subagentBridge: bridge,
    parentSessionId: 'parent-main',
    cwd: '/home/csy/Work/dsh-agy-link',
  })

  // Start subagent via tool call
  const chunks = Array.from(span1.map({
    kind: 'step',
    stepKey: 'step-sys',
    stepKind: 'tool',
    text: '',
    tool: {
      name: 'invoke_subagent',
      args: { task: 'Task with async delivery' },
      output: JSON.stringify({ conversationId: convId }),
    },
    raw: {},
  }, 0))

  // Span 1 cuts on tool!
  assert.equal(span1.isFinished, true, 'Span 1 cuts on tool invocation')
  assert.equal(bridge.hasActiveSubagents(), true, 'Bridge must have active subagent')
  assert.ok(bridge.getActiveByConversationId(convId), 'Subagent session must be in Bridge')

  // Now span1 is destroyed. Continuation span starts with brand-new EventMapper!
  const span2 = new EventMapper({
    runId: 'sys-msg-run',
    cutOnTool: true,
    initialSawText: false,
    usage: new RunRecording(),
    subagentBridge: bridge,
    parentSessionId: 'parent-main',
    cwd: '/home/csy/Work/dsh-agy-link',
  })

  // Agy parent process receives SYSTEM_MESSAGE indicating subagent completion
  const sysMsgText = `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-07T06:01:01Z sender=${convId} priority=MESSAGE_PRIORITY_HIGH content=Delivery verified and completed
</SYSTEM_MESSAGE>`

  Array.from(span2.map({
    kind: 'step',
    stepKey: 'step-sys-notice',
    stepKind: 'unknown',
    text: sysMsgText,
    raw: {
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content: sysMsgText,
    },
  }, 1))

  // Assert subagent is closed across spans
  assert.equal(bridge.hasActiveSubagents(), false, 'Subagent must be closed after receiving SYSTEM_MESSAGE in continuation span')
  assert.equal(span2.getActiveSubagents().length, 0, 'Continuation mapper reports 0 active subagents')

  const childRec = sessions.get(`agy-${convId}`)
  assert.ok(childRec)

  const msgEv = childRec.events.find((e) => e.type === 'assistant/message')
  assert.ok(msgEv, 'assistant/message must be appended with result text')
  const msgData = msgEv.data as { message: { content: Array<{ text: string }> } }
  assert.equal(msgData.message.content[0]?.text, 'Delivery verified and completed')

  const turnEndEv = childRec.events.find((e) => e.type === 'turn/end')
  assert.ok(turnEndEv, 'turn/end must be appended')
  assert.deepEqual((turnEndEv.data as { reason: { kind: string } }).reason, { kind: 'completed' })

  bridge.dispose()
})

test('Subagent Pipeline E2E [Critical 2]: Tool Call / Result ID FIFO queue pairs multiple tool calls in single step without offset drift', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-fifo-e2e-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()

  const bridge = new SubagentBridge({ sessions: mockSessions })
  const convId = 'cid-fifo-test'
  const logDir = join(tmpRoot, convId, '.system_generated', 'logs')
  mkdirSync(logDir, { recursive: true })
  const transcriptFile = join(logDir, 'transcript.jsonl')

  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: convId,
    logAbsoluteUri: `file://${transcriptFile}`,
    toolArgs: { task: 'Multi-tool batch execution' },
  })

  try {
    // Single step with multiple tool calls in tool_calls array, followed by results
    const transcriptLines = [
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { name: 'read_file', args: { path: 'a.ts' }, id: 'call-custom-1' },
          { name: 'read_file', args: { path: 'b.ts' }, id: 'call-custom-2' },
          { name: 'bash', args: { command: 'npm test' } }, // no explicit id -> agytc-sub-x
        ],
      }),
      // Interleaved thinking and assistant text
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'IN_PROGRESS',
        thinking: 'Interleaved thoughts between call and result',
        text: 'Interleaved progress update',
      }),
      // Result for call 1 (with explicit call_id)
      JSON.stringify({
        step_index: 3,
        type: 'tool_result',
        call_id: 'call-custom-1',
        output: 'content a',
      }),
      // Result for call 2 (no call_id -> should FIFO match call-custom-2)
      JSON.stringify({
        step_index: 4,
        type: 'tool_result',
        output: 'content b',
      }),
      // Result for call 3 (no call_id -> should FIFO match the third call)
      JSON.stringify({
        step_index: 5,
        type: 'tool_result',
        output: 'all tests passed',
      }),
    ].join('\n') + '\n'

    writeFileSync(transcriptFile, transcriptLines, 'utf8')
    await new Promise((r) => setTimeout(r, 250))

    const childRec = sessions.get(`agy-${convId}`)
    assert.ok(childRec)

    const toolCalls = childRec.events.filter((e) => e.type === 'tool/call').map((e) => e.data as { callId: string; name: string })
    const toolResults = childRec.events.filter((e) => e.type === 'tool/result').map((e) => e.data as { callId: string; output: string })

    assert.equal(toolCalls.length, 3, 'Must record 3 tool calls')
    assert.equal(toolResults.length, 3, 'Must record 3 tool results')

    // 1:1 callId matching
    assert.equal(toolCalls[0]?.callId, 'call-custom-1')
    assert.equal(toolResults[0]?.callId, 'call-custom-1')
    assert.equal(toolResults[0]?.output, 'content a')

    assert.equal(toolCalls[1]?.callId, 'call-custom-2')
    assert.equal(toolResults[1]?.callId, 'call-custom-2')
    assert.equal(toolResults[1]?.output, 'content b')

    assert.equal(toolCalls[2]?.callId, toolResults[2]?.callId, 'Third call and result callId must match 1:1')
    assert.equal(toolResults[2]?.output, 'all tests passed')
  } finally {
    session.stop()
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Subagent Pipeline E2E [Critical 3]: Global deduplication prevents duplicate SubagentSession cascade explosion on streamed multi-step packets', () => {
  const { manager: mockSessions, sessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })
  const mapper = new EventMapper({
    runId: 'dedup-run',
    cutOnTool: false,
    subagentBridge: bridge,
    parentSessionId: 'parent-main',
    cwd: '/home/csy/Work/dsh-agy-link',
  })

  const convId = 'cid-dedup-cascade-check'

  // Packet 1: active invocation step
  Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-duplicate-key',
    stepKind: 'tool',
    text: '',
    tool: {
      name: 'invoke_subagent',
      args: { task: 'Deduplication test' },
    },
    raw: {},
  }, 0))

  // Packet 2: done invocation step with conversationId
  Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-duplicate-key',
    stepKind: 'tool',
    text: '',
    tool: {
      name: 'invoke_subagent',
      args: { task: 'Deduplication test' },
      output: JSON.stringify({ conversationId: convId }),
    },
    raw: {},
  }, 1))

  // Packet 3: repeated snapshot step with same conversationId but different stepKey
  Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-duplicate-key-2',
    stepKind: 'tool',
    text: '',
    tool: {
      name: 'invoke_subagent',
      args: { task: 'Deduplication test' },
      output: JSON.stringify({ conversationId: convId }),
    },
    raw: {},
  }, 2))

  // Verify only ONE child session was created
  assert.equal(bridge.getActiveSubagents().length, 1, 'Only ONE active subagent session must exist')
  const activeSub = bridge.getActiveSubagents()[0]!
  const childRec = sessions.get(activeSub.childSession?.id ?? `agy-${convId}`)
  assert.ok(childRec)
  assert.equal(sessions.size, 1, 'Exactly one child session must exist across all duplicate packets')

  // Verify subagent/descriptor is appended only once
  const descriptors = childRec.events.filter((e) => e.type === 'subagent/descriptor')
  assert.equal(descriptors.length, 1, 'Descriptor must be appended exactly once without cascading duplicates')

  bridge.dispose()
})

test('Subagent Pipeline E2E [High 4]: Direct path probing by conversationId avoids mtime directory collision', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-probing-e2e-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })

  const convIdTarget = 'target-subagent-uuid'
  const targetDir = join(defaultBrainDir(tmpRoot), convIdTarget, '.system_generated', 'logs')
  mkdirSync(targetDir, { recursive: true })
  const targetFile = join(targetDir, 'transcript.jsonl')
  writeFileSync(targetFile, JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'Targeted subagent exact transcript reached',
  }) + '\n', 'utf8')

  // Also create an unrelated directory with newer mtime
  const unrelatedDir = join(defaultBrainDir(tmpRoot), 'unrelated-newer-dir', '.system_generated', 'logs')
  mkdirSync(unrelatedDir, { recursive: true })
  const unrelatedFile = join(unrelatedDir, 'transcript.jsonl')
  writeFileSync(unrelatedFile, JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'Wrong subagent transcript',
  }) + '\n', 'utf8')

  // Start subagent with conversationId but NO logAbsoluteUri
  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: convIdTarget,
    accountHome: tmpRoot,
    toolArgs: { task: 'Direct probe task' },
  })

  try {
    await new Promise((r) => setTimeout(r, 250))

    const childRec = sessions.get(`agy-${convIdTarget}`)
    assert.ok(childRec)

    const chunks = childRec.events
      .filter((e) => e.type === 'assistant/chunk')
      .map((e) => (e.data as { chunk: { text: string } }).chunk.text)
      .join('')

    assert.ok(chunks.includes('Targeted subagent exact transcript reached'), 'Must directly probe target file')
    assert.ok(!chunks.includes('Wrong subagent transcript'), 'Must NEVER read unrelated newer directory')
  } finally {
    session.stop()
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Subagent Pipeline E2E [High 5]: Append authoritative assistant/message with surfaceOp: append for DSH surface projection even when streamed', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-doublewrite-e2e-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })

  const convId = 'cid-doublewrite-check'
  const logDir = join(tmpRoot, convId, '.system_generated', 'logs')
  mkdirSync(logDir, { recursive: true })
  const transcriptFile = join(logDir, 'transcript.jsonl')

  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: convId,
    logAbsoluteUri: `file://${transcriptFile}`,
    toolArgs: { task: 'Double write check' },
  })

  try {
    // Transcript streams assistant text
    writeFileSync(transcriptFile, JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Detailed response streamed via chunks',
    }) + '\n', 'utf8')

    await new Promise((r) => setTimeout(r, 220))

    // session.stop is called with the same resultText
    session.stop(undefined, 'Detailed response streamed via chunks')

    const childRec = sessions.get(`agy-${convId}`)
    assert.ok(childRec)

    const chunks = childRec.events.filter((e) => e.type === 'assistant/chunk')
    assert.ok(chunks.length > 0, 'Must have streamed assistant/chunk')

    const stepStart = childRec.events.find((e) => e.type === 'step/start')
    assert.ok(stepStart, 'Must append step/start before stream/assistant content')

    const stepEnd = childRec.events.find((e) => e.type === 'step/end')
    assert.ok(stepEnd, 'Must append step/end before turn/end')

    const userMsg = childRec.events.find((e) => e.type === 'user/message')
    assert.ok(userMsg, 'Must append user/message')
    assert.deepEqual(userMsg.opts, { surfaceOp: 'append' }, 'user/message must carry surfaceOp: append')

    const messages = childRec.events.filter((e) => e.type === 'assistant/message')
    assert.equal(messages.length, 1, 'Must append authoritative assistant/message for DSH surface projection')
    assert.deepEqual((messages[0] as any).opts, { surfaceOp: 'append' }, 'assistant/message must carry surfaceOp: append')

    const turnEnd = childRec.events.find((e) => e.type === 'turn/end')
    assert.ok(turnEnd, 'Must append turn/end')
    assert.deepEqual((turnEnd.data as { reason: { kind: string } }).reason, { kind: 'completed' })
  } finally {
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Subagent Pipeline E2E [Medium 6]: Bounded 64KB chunk reading smoothly processes large transcripts (>150KB) without OOM or stalling', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-biglog-e2e-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })

  const convId = 'cid-biglog-test'
  const logDir = join(tmpRoot, convId, '.system_generated', 'logs')
  mkdirSync(logDir, { recursive: true })
  const transcriptFile = join(logDir, 'transcript.jsonl')

  // Generate ~180KB of JSONL lines (3 * 64KB chunks)
  const lines: string[] = []
  for (let i = 0; i < 600; i++) {
    lines.push(JSON.stringify({
      step_index: i,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'IN_PROGRESS',
      thinking: `Thinking step iteration ${i}: analyzing AST node and generating bounded diff chunk ${'x'.repeat(250)}`,
    }))
  }
  lines.push(JSON.stringify({
    step_index: 601,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'Large log completed cleanly',
  }))

  writeFileSync(transcriptFile, lines.join('\n') + '\n', 'utf8')

  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: convId,
    logAbsoluteUri: `file://${transcriptFile}`,
    toolArgs: { task: 'Big log ingestion' },
  })

  try {
    // Allow several poll ticks for 64KB bounded chunks to drain
    await new Promise((r) => setTimeout(r, 450))

    const childRec = sessions.get(`agy-${convId}`)
    assert.ok(childRec)

    const chunks = childRec.events.filter((e) => e.type === 'assistant/chunk')
    assert.ok(chunks.length > 500, `Must process over 500 chunks across bounded reads (actual: ${chunks.length})`)

    const turnEnd = childRec.events.find((e) => e.type === 'turn/end')
    assert.ok(turnEnd, 'Must finish cleanly with turn/end')
  } finally {
    session.stop()
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Subagent Pipeline E2E [Medium 7]: parseSubagentOutput handles nested objects, braces in strings, and escaped quotes without truncation', () => {
  // 1. Nested objects
  const nestedText = `Prefix: {"conversationId": "cid-nested", "meta": {"deep": {"level": 3, "obj": {"name": "test"}}}, "logAbsoluteUri": "file:///path/to/t.jsonl"} Suffix text`
  const res1 = parseSubagentOutput(nestedText)
  assert.equal(res1.conversationId, 'cid-nested')
  assert.equal(res1.logAbsoluteUri, 'file:///path/to/t.jsonl')

  // 2. Braces inside string literal
  const bracesInString = `Notice: {"prompt": "Run { something } here", "conversationId": "cid-braces", "logAbsoluteUri": "file:///path/braces.jsonl"}`
  const res2 = parseSubagentOutput(bracesInString)
  assert.equal(res2.conversationId, 'cid-braces')
  assert.equal(res2.logAbsoluteUri, 'file:///path/braces.jsonl')

  // 3. Escaped quotes inside strings
  const escapedQuotes = `Result: {"task": "Verify \\"auth\\" headers", "conversationId": "cid-quotes", "logAbsoluteUri": "file:///path/quotes.jsonl"}`
  const res3 = parseSubagentOutput(escapedQuotes)
  assert.equal(res3.conversationId, 'cid-quotes')
  assert.equal(res3.logAbsoluteUri, 'file:///path/quotes.jsonl')

  // 4. Multiple objects, picking the one with conversationId
  const multipleObjects = `First: {"unrelated": 123} Then: {"conversationId": "cid-second", "logAbsoluteUri": "file:///path/second.jsonl"}`
  const res4 = parseSubagentOutput(multipleObjects)
  assert.equal(res4.conversationId, 'cid-second')
  assert.equal(res4.logAbsoluteUri, 'file:///path/second.jsonl')
})

test('Subagent Pipeline E2E [Medium 8 & 9]: Model inheritance and abort reporting', () => {
  const { manager: mockSessions, sessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })

  // 1. Dynamic model
  const session1 = bridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: 'cid-model-test',
    model: 'gemini-3.7-flash',
    toolArgs: { task: 'Model inheritance test' },
  })

  session1.stop(undefined, 'Result from model')

  const rec1 = sessions.get('agy-cid-model-test')
  assert.ok(rec1)
  const msgEv = rec1.events.find((e) => e.type === 'assistant/message')
  assert.ok(msgEv)
  const msgData = msgEv.data as { message: { source: { model: string } } }
  assert.equal(msgData.message.source.model, 'gemini-3.7-flash', 'Must inherit dynamically specified model')

  // 2. Aborted reporting
  let emittedEndPayload: { stopReason: string } | undefined
  const emitterBridge = new SubagentBridge({
    sessions: mockSessions,
    emit: (ev, data) => {
      if (ev === 'subagent/end') {
        emittedEndPayload = data as { stopReason: string }
      }
    },
  })

  const session2 = emitterBridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: 'cid-abort-test',
    toolArgs: { task: 'Abort test' },
  })

  session2.stop('aborted', 'User cancelled turn')

  const rec2 = sessions.get('agy-cid-abort-test')
  assert.ok(rec2)
  const turnEnd = rec2.events.find((e) => e.type === 'turn/end')
  assert.ok(turnEnd)
  assert.deepEqual((turnEnd.data as { reason: { kind: string } }).reason, { kind: 'aborted' }, 'turn/end reason must be aborted')
  assert.equal(emittedEndPayload?.stopReason, 'aborted', 'subagent/end stopReason must be aborted')

  bridge.dispose()
  emitterBridge.dispose()
})

test('Subagent Pipeline E2E: Targeted Transcript Tailer binds exact logAbsoluteUri with zero cross-directory collision', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-tailer-e2e-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()

  const bridge = new SubagentBridge({ sessions: mockSessions })

  // Create two distinct subagent logs in separate directories
  const logDirA = join(tmpRoot, 'agent-A-dir', '.system_generated', 'logs')
  const logDirB = join(tmpRoot, 'agent-B-dir', '.system_generated', 'logs')
  mkdirSync(logDirA, { recursive: true })
  mkdirSync(logDirB, { recursive: true })

  const fileA = join(logDirA, 'transcript.jsonl')
  const fileB = join(logDirB, 'transcript.jsonl')

  writeFileSync(fileA, '', 'utf8')
  writeFileSync(fileB, '', 'utf8')

  // Start subagent A and subagent B with exact logAbsoluteUri
  const sessionA = bridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: 'agent-A',
    logAbsoluteUri: `file://${fileA}`,
    toolArgs: { task: 'Task A' },
  })

  const sessionB = bridge.startSubagent({
    toolName: 'invoke_subagent',
    conversationId: 'agent-B',
    logAbsoluteUri: `file://${fileB}`,
    toolArgs: { task: 'Task B' },
  })

  try {
    // Write distinct contents to file A and file B
    writeFileSync(fileA, JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Thinking strictly for Agent A',
      content: 'Output from Agent A',
    }) + '\n', 'utf8')

    writeFileSync(fileB, JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Thinking strictly for Agent B',
      content: 'Output from Agent B',
    }) + '\n', 'utf8')

    await new Promise((resolve) => setTimeout(resolve, 250))

    const sessRecA = sessions.get('agy-agent-A')
    const sessRecB = sessions.get('agy-agent-B')

    assert.ok(sessRecA, 'Session agy-agent-A must exist')
    assert.ok(sessRecB, 'Session agy-agent-B must exist')

    // Verify session A contains ONLY agent A's data
    const chunksA = sessRecA.events
      .filter((e) => e.type === 'assistant/chunk')
      .map((e) => (e.data as { chunk: { text: string } }).chunk.text)
      .join('')
    assert.ok(chunksA.includes('Thinking strictly for Agent A'), 'Session A must have Agent A thinking')
    assert.ok(chunksA.includes('Output from Agent A'), 'Session A must have Agent A output')
    assert.ok(!chunksA.includes('Agent B'), 'Session A must NEVER contain Agent B content (zero cross-talk)')

    // Verify session B contains ONLY agent B's data
    const chunksB = sessRecB.events
      .filter((e) => e.type === 'assistant/chunk')
      .map((e) => (e.data as { chunk: { text: string } }).chunk.text)
      .join('')
    assert.ok(chunksB.includes('Thinking strictly for Agent B'), 'Session B must have Agent B thinking')
    assert.ok(chunksB.includes('Output from Agent B'), 'Session B must have Agent B output')
    assert.ok(!chunksB.includes('Agent A'), 'Session B must NEVER contain Agent A content (zero cross-talk)')
  } finally {
    sessionA.stop()
    sessionB.stop()
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Subagent Pipeline E2E: Phase failure does not stall subsequent phases', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-resilience-e2e-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()

  const bridge = new SubagentBridge({ sessions: mockSessions })
  const mapper = new EventMapper({
    runId: 'resilience-run',
    cutOnTool: false,
    usage: new RunRecording(),
    subagentBridge: bridge,
    parentSessionId: 'parent-main',
    cwd: '/home/csy/Work/dsh-agy-link',
  })

  try {
    // 1. Phase 1 (fails due to error in transcript)
    const log1 = join(tmpRoot, 'transcript-fail.jsonl')
    writeFileSync(log1, JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'ERROR',
      error: 'RESOURCE_EXHAUSTED: rate limit hit',
    }) + '\n', 'utf8')

    Array.from(mapper.map({
      kind: 'step',
      stepKey: 'step-fail',
      stepKind: 'tool',
      text: '',
      tool: {
        name: 'invoke_subagent',
        args: { task: 'Phase 1 - Vulnerable' },
        output: JSON.stringify({ conversationId: 'cid-fail', logAbsoluteUri: `file://${log1}` }),
      },
      raw: {},
    }, 0))

    await new Promise((r) => setTimeout(r, 220))

    const failRec = sessions.get('agy-cid-fail')
    assert.ok(failRec)
    const failTurnEnd = failRec.events.find((e) => e.type === 'turn/end')
    assert.ok(failTurnEnd)
    assert.deepEqual((failTurnEnd.data as { reason: { kind: string } }).reason, { kind: 'error' })

    // 2. Phase 2 (subsequent phase dispatched after failure)
    const log2 = join(tmpRoot, 'transcript-ok.jsonl')
    writeFileSync(log2, JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Phase 2 recovered successfully',
    }) + '\n', 'utf8')

    Array.from(mapper.map({
      kind: 'step',
      stepKey: 'step-recover',
      stepKind: 'tool',
      text: '',
      tool: {
        name: 'invoke_subagent',
        args: { task: 'Phase 2 - Recovered' },
        output: JSON.stringify({ conversationId: 'cid-recover', logAbsoluteUri: `file://${log2}` }),
      },
      raw: {},
    }, 1))

    await new Promise((r) => setTimeout(r, 220))

    const okRec = sessions.get('agy-cid-recover')
    assert.ok(okRec, 'Phase 2 subagent must be created successfully even after Phase 1 failed')
    const okTurnEnd = okRec.events.find((e) => e.type === 'turn/end')
    assert.ok(okTurnEnd)
    assert.deepEqual((okTurnEnd.data as { reason: { kind: string } }).reason, { kind: 'completed' })
  } finally {
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Defect P1: Subagent tool result ERROR does not prematurely terminate subagent session', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-tool-err-'))
  const { manager: mockSessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })

  try {
    const logFile = join(tmpRoot, 'transcript-tool-err.jsonl')
    // Tool call followed by non-fatal tool result ERROR (e.g. grep unmatched)
    writeFileSync(logFile, JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      tool_calls: [{ id: 'tc-grep-1', name: 'grep', args: { pattern: 'nonexistent' } }],
    }) + '\n' + JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'ERROR',
      call_id: 'tc-grep-1',
      output: 'exit status 1: pattern not found',
    }) + '\n', 'utf8')

    const sub = bridge.startSubagent({
      toolName: 'invoke_subagent',
      toolArgs: { task: 'Search codebase' },
      conversationId: 'cid-tool-err',
      logAbsoluteUri: `file://${logFile}`,
      stepKey: 'step-tool-err',
    })

    await new Promise((r) => setTimeout(r, 200))

    // Verify subagent is STILL ACTIVE (not killed prematurely)
    assert.strictEqual(sub.isStopped, false, 'Subagent must NOT be stopped by tool ERROR result')
    assert.strictEqual(bridge.getActiveByConversationId('cid-tool-err')?.subagentId, sub.subagentId)

    // Append genuine final response
    appendFileSync(logFile, JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Finished searching, no matches found.',
    }) + '\n', 'utf8')

    await new Promise((r) => setTimeout(r, 200))

    // Now it should be stopped properly
    assert.strictEqual(sub.isStopped, true, 'Subagent stops only on terminal step')
  } finally {
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Defect P1: Subagent stop() cascades to close step and append turn/end even if assistant/message throws', () => {
  const appendedEvents: Array<{ type: string; data: unknown }> = []
  let stepClosed = false

  const throwingSession: DshSession = {
    id: 'mock-throwing-session',
    append(type: string, data: unknown) {
      appendedEvents.push({ type, data })
      if (type === 'assistant/message') {
        throw new Error('Disk full or serialization error on assistant/message')
      }
      if (type === 'step/end') {
        stepClosed = true
      }
    },
  }

  const mockManager: DshSessionManager = {
    create: () => throwingSession,
  }

  const bridge = new SubagentBridge({ sessions: mockManager })
  const sub = bridge.startSubagent({
    toolName: 'invoke_subagent',
    toolArgs: { task: 'Test cascade' },
    conversationId: 'cid-cascade',
  })

  // Calling stop() with result text triggers assistant/message, which will throw
  sub.stop(undefined, 'Final text causing throw')

  // Invariant check: step/end and turn/end MUST be appended despite throw
  const turnEnd = appendedEvents.find((e) => e.type === 'turn/end')
  assert.ok(turnEnd, 'turn/end MUST be appended via finally block')
  assert.strictEqual((turnEnd?.data as { reason: { kind: string } }).reason.kind, 'completed')
  assert.ok(stepClosed, 'step/end MUST be appended via ensureStepClosed in finally block')
  bridge.dispose()
})

test('Defect P2: GENERIC step without call_id and empty pendingToolCallIds emits assistant/chunk without fake tool/call', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agy-no-ghost-'))
  const { manager: mockSessions, sessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })

  try {
    const logFile = join(tmpRoot, 'transcript-ghost.jsonl')
    writeFileSync(logFile, JSON.stringify({
      step_index: 1,
      type: 'GENERIC',
      content: 'Informational status message from agent',
    }) + '\n', 'utf8')

    bridge.startSubagent({
      toolName: 'invoke_subagent',
      toolArgs: { task: 'Ghost check' },
      conversationId: 'cid-ghost',
      logAbsoluteUri: `file://${logFile}`,
    })

    await new Promise((r) => setTimeout(r, 200))

    const rec = sessions.get('agy-cid-ghost')
    assert.ok(rec, 'Session must exist')

    // Must NOT contain any forged tool/call
    const toolCalls = rec.events.filter((e) => e.type === 'tool/call')
    assert.strictEqual(toolCalls.length, 0, 'Must NOT forge fake tool/call card')

    // Must be emitted as assistant/chunk
    const chunks = rec.events.filter((e) => e.type === 'assistant/chunk')
    assert.ok(chunks.length > 0, 'Must emit as assistant/chunk')
    const text = chunks.map((c) => (c.data as { chunk: { text: string } }).chunk.text).join('')
    assert.ok(text.includes('Informational status message from agent'))
  } finally {
    bridge.dispose()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('Defect P2: Subagent session.stop() cleans up internal sessionsByStepKey and sessionsByConversationId maps', () => {
  const { manager: mockSessions } = createMockSessionManager()
  const bridge = new SubagentBridge({ sessions: mockSessions })

  const sub = bridge.startSubagent({
    toolName: 'invoke_subagent',
    toolArgs: { task: 'Cleanup test' },
    conversationId: 'conv-cleanup-test',
    stepKey: 'step-cleanup-test',
  })

  // Pre-condition: active lookups resolve subagent
  assert.strictEqual(bridge.getActiveByConversationId('conv-cleanup-test')?.subagentId, sub.subagentId)
  assert.strictEqual(bridge.getActiveByStepKey('step-cleanup-test')?.subagentId, sub.subagentId)

  // Act: stop subagent
  sub.stop(undefined, 'All done')

  // Post-condition: internal maps cleaned up, no zombie reuse
  assert.strictEqual(bridge.getActiveByConversationId('conv-cleanup-test'), undefined, 'sessionsByConversationId must be cleaned up')
  assert.strictEqual(bridge.getActiveByStepKey('step-cleanup-test'), undefined, 'sessionsByStepKey must be cleaned up')
  bridge.dispose()
})
