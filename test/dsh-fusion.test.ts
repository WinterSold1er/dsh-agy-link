// Comprehensive test suite for DSH deep fusion:
// 1. ResidentAgyChannel & AgyProcessSupervisor (full-duplex stream, crash self-healing, teardown)
// 2. MCP shadow merge & lossless restore (dsh_managed__ prefix, user config preservation)
// 3. Skills dynamic staging & prompt purification (frontmatter standardization, virtual Skill() elimination)
// 4. Subagent bridge (invoke_subagent capture, lifecycle events, transcript.jsonl incremental streaming)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResidentAgyChannel, AgyProcessSupervisor, extractConfigSignature, isProcessAlive } from '../src/host/runner.ts'
import { RunRecording } from '../src/host/recording.ts'
import { shadowMergeGeminiMcpConfig, cleanOrphanMcpConfigs, writeJsonFileAtomic, findExecutable, DSH_MANAGED_PREFIX } from '../src/host/mcp-bridge.ts'
import { scanAndStageSkills, sanitizePromptForAgy, normalizeSkillMarkdown, sanitizeSkillName } from '../src/host/skills-bridge.ts'
import { StreamJsonParser } from '../src/host/parser.ts'
import { SubagentBridge, defaultBrainDir, type SubagentEventEmitter } from '../src/host/subagent-bridge.ts'
import { EventMapper } from '../src/host/mapper.ts'

// ---- 1. Resident Channel & Supervisor Tests ----

test('ResidentAgyChannel: full-duplex stream-json turn execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-resident-'))
  const stubBin = join(dir, 'fake-resident-agy.mjs')

  // Create a stub resident agy CLI that responds to NDJSON stream on stdin
  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.event === 'user') {
      process.stdout.write(JSON.stringify({
        event: 'step_update',
        idx: 1,
        step_type: 'text',
        text: 'Echo: ' + msg.message.content
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-resident-1',
          status: 'DONE',
          response: 'Echo: ' + msg.message.content,
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      }) + '\\n');
    }
  } catch {}
});
`,
  )

  const channel = new ResidentAgyChannel({
    bin: process.execPath,
    args: [stubBin],
    cwd: dir,
  })

  const rec = new RunRecording()
  const outcome = await channel.sendTurn({
    prompt: 'hello world',
    recording: rec,
  })

  assert.equal(outcome.aborted, false)
  assert.equal(rec.hasResult, true)
  assert.equal(rec.getResultEvent()?.ok, true)
  assert.equal(rec.getResultEvent()?.response, 'Echo: hello world')

  channel.close()
  rmSync(dir, { recursive: true, force: true })
})

test('AgyProcessSupervisor: crash self-healing automatically resurrects dead channels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-supervisor-'))
  const stubBin = join(dir, 'crashing-agy.mjs')

  // Script that exits on the first turn, but succeeds on subsequent runs
  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.message.content === 'crash') {
    process.exit(42);
  }
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: { status: 'DONE', response: 'healed!' }
  }) + '\\n');
});
`,
  )

  const supervisor = new AgyProcessSupervisor()
  const spawnOpts = { bin: process.execPath, args: [stubBin], cwd: dir }

  // 1. First turn crashes the process
  const rec1 = new RunRecording()
  const outcome1 = await supervisor.runTurn('chan-1', spawnOpts, {
    prompt: 'crash',
    recording: rec1,
  })
  assert.equal(outcome1.code, 42)

  // 2. Supervisor self-heals on next turn by spawning a fresh resident process
  const rec2 = new RunRecording()
  const outcome2 = await supervisor.runTurn('chan-1', spawnOpts, {
    prompt: 'resurrect',
    recording: rec2,
  })

  assert.equal(outcome2.code, 0)
  assert.equal(rec2.getResultEvent()?.response, 'healed!')

  await supervisor.dispose()
  rmSync(dir, { recursive: true, force: true })
})

// ---- 2. MCP Shadow Merge Tests ----

test('shadowMergeGeminiMcpConfig: adds dsh_managed__ prefix and losslessly restores user config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-mcp-'))
  const configPath = join(dir, 'mcp_config.json')

  // Initial user mcp_config.json with existing user server
  const initialUserConfig = {
    mcpServers: {
      user_custom_server: {
        command: 'custom-bin',
        args: ['--run'],
      },
    },
  }
  writeFileSync(configPath, JSON.stringify(initialUserConfig, null, 2) + '\n', 'utf8')

  // Execute shadow merge
  const restore = shadowMergeGeminiMcpConfig({
    targetPaths: [configPath],
    servers: {
      github: { command: 'github-server', args: ['stdio'] },
      vectr: { command: 'vectr', args: ['mcp-stdio'] },
    },
  })

  // Verify merged state
  const merged = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.ok(merged.mcpServers.user_custom_server, 'user custom server preserved')
  assert.ok(merged.mcpServers[`${DSH_MANAGED_PREFIX}github`], 'dsh_managed__github added')
  assert.ok(merged.mcpServers[`${DSH_MANAGED_PREFIX}vectr`], 'dsh_managed__vectr added')

  // Teardown restore
  restore()

  // Verify restored state
  const restored = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.ok(restored.mcpServers.user_custom_server, 'user custom server still intact')
  assert.equal(restored.mcpServers[`${DSH_MANAGED_PREFIX}github`], undefined, 'dsh_managed__github removed')
  assert.equal(restored.mcpServers[`${DSH_MANAGED_PREFIX}vectr`], undefined, 'dsh_managed__vectr removed')

  rmSync(dir, { recursive: true, force: true })
})

test('shadowMergeGeminiMcpConfig: cleans up target file completely if it was non-existent before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-mcp-empty-'))
  const configPath = join(dir, 'mcp_config.json')

  assert.equal(existsSync(configPath), false)

  const restore = shadowMergeGeminiMcpConfig({
    targetPaths: [configPath],
    servers: {
      vectr: { command: 'vectr', args: ['mcp-stdio'] },
    },
  })

  assert.equal(existsSync(configPath), true)
  restore()
  assert.equal(existsSync(configPath), false, 'non-existent file is unlinked on restore')

  rmSync(dir, { recursive: true, force: true })
})

// ---- 3. Skills Bridge Tests ----

test('normalizeSkillMarkdown: parses valid frontmatter or synthesizes missing metadata', () => {
  const withFm = `---
name: my-cool-skill
description: Does awesome things
---
# Instructions
Do work.
`
  const parsed1 = normalizeSkillMarkdown(withFm, 'fallback')
  assert.equal(parsed1.name, 'my-cool-skill')
  assert.equal(parsed1.description, 'Does awesome things')

  const withoutFm = `# Simple Title
This skill teaches how to write concise code.
`
  const parsed2 = normalizeSkillMarkdown(withoutFm, 'concise-code')
  assert.equal(parsed2.name, 'concise-code')
  assert.ok(parsed2.description.includes('concise code'))
  assert.ok(parsed2.normalized.startsWith('---\nname: concise-code'))
})

test('scanAndStageSkills: stages skills with standard YAML frontmatter into staging dir', () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'skills-src-'))
  const stagingDir = mkdtempSync(join(tmpdir(), 'skills-stage-'))

  // Skill 1: in folder with SKILL.md
  mkdirSync(join(sourceDir, 'skill-one'))
  writeFileSync(join(sourceDir, 'skill-one', 'SKILL.md'), '---\nname: skill-one\ndescription: First skill\n---\nBody')

  // Skill 2: standalone .md file
  writeFileSync(join(sourceDir, 'skill-two.md'), '# Skill Two\nStandalone skill content')

  const res = scanAndStageSkills({
    sourceDirs: [sourceDir],
    stagingDir,
  })

  assert.equal(res.skills.length, 2)
  assert.ok(existsSync(join(stagingDir, '.agents', 'skills', 'skill-one', 'SKILL.md')), 'skill-one staged in .agents/skills')
  assert.ok(existsSync(join(stagingDir, '.agents', 'skills', 'skill-two', 'SKILL.md')), 'skill-two staged in .agents/skills')
  assert.equal(existsSync(join(stagingDir, 'skill-one', 'SKILL.md')), false, 'redundant root copy removed')
  assert.equal(existsSync(join(stagingDir, 'skills', 'skill-one', 'SKILL.md')), false, 'redundant skills copy removed')

  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(stagingDir, { recursive: true, force: true })
})

test('sanitizeSkillName: neutralizes path traversal characters', () => {
  assert.equal(sanitizeSkillName('../../../etc/evil'), 'etc-evil')
  assert.equal(sanitizeSkillName('my skill/name'), 'my-skill-name')
  assert.equal(sanitizeSkillName('..\\..\\bad'), 'bad')
  assert.equal(sanitizeSkillName('valid_name-123'), 'valid_name-123')
})

test('sanitizePromptForAgy: strips virtual Skill() declarations and mandatory calling instructions', () => {
  const prompt = `<declaration:default_api:Skill{description: "Load and invoke a skill by name", parameters: {properties: {skill: {type: "STRING"}}, required: ["skill"], type: "OBJECT"}}>
<SUBAGENT-STOP>
If you were dispatched as a subagent, ignore this.
</SUBAGENT-STOP>
If the user names a skill, or the task clearly matches a skill's description, call the skill tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions.
Please refactor the user controller.
`
  const cleaned = sanitizePromptForAgy(prompt)
  assert.ok(!cleaned.includes('declaration:default_api:Skill'), 'Skill tool declaration removed')
  assert.ok(!cleaned.includes('<SUBAGENT-STOP>'), 'SUBAGENT-STOP block removed')
  assert.ok(!cleaned.includes('call the skill tool with the exact skill name'), 'Skill tool call mandate eliminated')
  assert.ok(cleaned.includes('Please refactor the user controller.'), 'User text preserved')
})

// ---- 4. Subagent Bridge Tests ----

test('SubagentBridge: emits subagent/start and subagent/end and streams transcript steps', async () => {
  const events: Array<{ name: string; payload: unknown }> = []
  const emitter: SubagentEventEmitter = {
    emit(name, ...args) {
      events.push({ name, payload: args[0] })
    },
  }

  const bridge = new SubagentBridge(emitter)

  // Start subagent session
  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    toolArgs: {
      task: 'Investigate memory leak',
      description: 'Audit heap snapshots',
      subagent_type: 'investigator',
    },
  })

  assert.ok(session.runId.startsWith('subagent-run-'))
  assert.equal(events.length, 1)
  assert.equal(events[0]?.name, 'subagent/start')
  const startData = events[0]?.payload as { task: string; subagentType: string }
  assert.equal(startData.task, 'Investigate memory leak')
  assert.equal(startData.subagentType, 'investigator')

  // Complete subagent session
  session.stop(undefined, 'Root cause identified: cache leak')

  assert.equal(events.length, 2)
  assert.equal(events[1]?.name, 'subagent/end')
  const endData = events[1]?.payload as { stopReason: string }
  assert.equal(endData.stopReason, 'endTurn')

  bridge.dispose()
})

test('ResidentAgyChannel: abort reaps child process tree and next turn spawns fresh child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-abort-'))
  const stubBin = join(dir, 'hanging-agy.mjs')

  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.message?.content === 'hang') {
      // Hang forever
      return;
    }
    process.stdout.write(JSON.stringify({
      event: 'result',
      result: { status: 'DONE', response: 'ok' }
    }) + '\\n');
  } catch {}
});
`,
  )

  const channel = new ResidentAgyChannel({
    bin: process.execPath,
    args: [stubBin],
    cwd: dir,
  })

  // 1. First turn: send 'hang' and abort it mid-flight
  const ac = new AbortController()
  const rec1 = new RunRecording()
  const turn1Promise = channel.sendTurn({
    prompt: 'hang',
    recording: rec1,
    signal: ac.signal,
  })

  setTimeout(() => ac.abort(), 50)
  const outcome1 = await turn1Promise
  assert.equal(outcome1.aborted, true)

  // 2. Second turn: must spawn a fresh child and succeed cleanly
  const rec2 = new RunRecording()
  const outcome2 = await channel.sendTurn({
    prompt: 'hello',
    recording: rec2,
  })

  assert.equal(outcome2.aborted, false)
  assert.equal(rec2.getResultEvent()?.response, 'ok')

  channel.close()
  rmSync(dir, { recursive: true, force: true })
})

test('ResidentAgyChannel: silent child is not killed by watchdog, and caller abort recycles process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-timeout-'))
  const stubBin = join(dir, 'silent-agy.mjs')

  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {
  // Completely silent, never outputs anything
});
`,
  )

  const channel = new ResidentAgyChannel({
    bin: process.execPath,
    args: [stubBin],
    cwd: dir,
  })

  const rec = new RunRecording()
  const ac = new AbortController()
  const outcomePromise = channel.sendTurn({
    prompt: 'wait',
    recording: rec,
    signal: ac.signal,
  })

  // Verify silent child is allowed to think without being killed by watchdog
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(channel.isRunning, true, 'Channel must stay running during silent thinking')
  assert.notEqual(channel['child'], null, 'Child process must remain alive during silent thinking')

  // Caller abort must cleanly recycle process
  ac.abort()
  const outcome = await outcomePromise

  assert.equal(outcome.aborted, true)
  assert.equal(channel['child'], null, 'aborted process reaped and child reference cleared')

  channel.close()
  rmSync(dir, { recursive: true, force: true })
})

test('AgyProcessSupervisor: recycles resident channel when config signature changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-sig-'))
  const stubBin = join(dir, 'echo-model.mjs')

  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: { status: 'DONE', response: 'done' }
  }) + '\\n');
});
`,
  )

  const supervisor = new AgyProcessSupervisor()

  // 1. Initial config with model A
  const optsA = { bin: process.execPath, args: [stubBin, '--model', 'model-a', '--effort', 'low'], cwd: dir }
  const chanA = supervisor.getChannel('session-1', optsA)
  const idA = chanA.channelId

  // Same config reuses the same channel
  const chanA2 = supervisor.getChannel('session-1', optsA)
  assert.equal(chanA2.channelId, idA)

  // 2. Config changes to model B: must recycle old channel and create a new one
  const optsB = { bin: process.execPath, args: [stubBin, '--model', 'model-b', '--effort', 'high'], cwd: dir }
  const chanB = supervisor.getChannel('session-1', optsB)
  assert.notEqual(chanB.channelId, idA, 'channel must be recycled when model/effort signature changes')
  assert.equal(chanA.isAlive(), false, 'old channel with outdated config must be closed')

  await supervisor.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('EventMapper: regular tool completion does not mistakenly kill active subagent session', () => {
  let subagentStopped = false
  let subagentError: string | undefined
  const fakeBridge = {
    startSubagent: () => ({
      runId: 'sub-1',
      subagentId: 'session-1',
      task: 'task',
      description: 'desc',
      subagentType: 'agent',
      startedAt: Date.now(),
      stop: (err?: string) => {
        subagentStopped = true
        subagentError = err
      },
    }),
  }

  const mapper = new EventMapper({
    cutOnTool: false,
    runId: 'run-1',
    usage: new RunRecording(),
    subagentBridge: fakeBridge as never,
  })

  // 1. invoke_subagent tool step begins
  Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-0',
    stepKind: 'tool',
    text: '',
    tool: { name: 'invoke_subagent', args: { task: 'inspect' } }, raw: {}
  }, 0))

  assert.equal(subagentStopped, false, 'subagent must be active')

  // 2. An unrelated regular tool completes (e.g. read_file)
  Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-1',
    stepKind: 'tool',
    text: '',
    tool: { name: 'read_file', args: { path: 'foo.ts' }, output: 'file contents' }, raw: {}
  }, 1))

  assert.equal(subagentStopped, false, 'read_file completion must NOT stop the active subagent!')

  // 3. invoke_subagent tool completes
  Array.from(mapper.map({
    kind: 'step',
    stepKey: 'step-0',
    stepKind: 'tool',
    text: '',
    tool: { name: 'invoke_subagent', args: { task: 'inspect' }, output: 'inspection done' }, raw: {}
  }, 2))

  assert.equal(subagentStopped, true, 'invoke_subagent completion correctly stops the subagent')
})

test('cleanOrphanMcpConfigs and writeJsonFileAtomic: cleans leftover dsh_managed__ entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-mcp-'))
  const configPath = join(dir, '.gemini', 'config', 'mcp_config.json')

  // Create a config simulating a previous session crash with dsh_managed__ entries
  const dirtyConfig = {
    mcpServers: {
      user_server: { command: 'node', args: ['server.js'] },
      [`${DSH_MANAGED_PREFIX}github`]: { command: 'github' },
      [`${DSH_MANAGED_PREFIX}dsh_tools`]: { command: 'bridge' },
    },
  }

  writeJsonFileAtomic(configPath, dirtyConfig)
  assert.ok(existsSync(configPath))

  // Run orphan cleaner
  const oldGeminiHome = process.env.GEMINI_CLI_HOME
  process.env.GEMINI_CLI_HOME = join(dir, '.gemini')
  try {
    const cleaned = cleanOrphanMcpConfigs({ dshHomeDir: dir })
    assert.ok(cleaned >= 1)

    const cleanedData = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.ok(cleanedData.mcpServers.user_server, 'user server preserved')
    assert.equal(cleanedData.mcpServers[`${DSH_MANAGED_PREFIX}github`], undefined, 'orphan github removed')
    assert.equal(cleanedData.mcpServers[`${DSH_MANAGED_PREFIX}dsh_tools`], undefined, 'orphan bridge removed')
  } finally {
    if (oldGeminiHome !== undefined) process.env.GEMINI_CLI_HOME = oldGeminiHome
    else delete process.env.GEMINI_CLI_HOME
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SubagentBridge: findTranscript ignores older historic runs and waits for new directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-test-'))
  const brainDir = defaultBrainDir(dir)
  mkdirSync(brainDir, { recursive: true })

  // 1. Create an old historic run directory from 1 hour ago
  const oldDir = join(brainDir, 'old-run-dir', '.system_generated', 'logs')
  mkdirSync(oldDir, { recursive: true })
  writeFileSync(join(oldDir, 'transcript.jsonl'), '{"old":"data"}\n')
  // Artificially age the old directory mtime to 1 hour ago
  const oneHourAgo = new Date(Date.now() - 3600_000)
  const { utimesSync } = await import('node:fs')
  utimesSync(join(brainDir, 'old-run-dir'), oneHourAgo, oneHourAgo)

  let stepReceived = false
  const emitter: SubagentEventEmitter = {
    emit(name) {
      if (name === 'subagent/step') stepReceived = true
    },
  }

  const bridge = new SubagentBridge(emitter)
  const session = bridge.startSubagent({
    toolName: 'invoke_subagent',
    accountHome: dir,
  })

  // Allow one polling tick
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(stepReceived, false, 'findTranscript must NOT bind to historic old directory')

  // 2. Now create a new fresh run directory modified right now
  const newDir = join(brainDir, 'new-run-dir', '.system_generated', 'logs')
  mkdirSync(newDir, { recursive: true })
  writeFileSync(join(newDir, 'transcript.jsonl'), '{"step":"new-data"}\n')

  // Allow next polling tick to pick up new directory
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(stepReceived, true, 'findTranscript successfully picked up new subagent directory')

  session.stop()
  bridge.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test('findExecutable: detects binaries dynamically across PATH without hardcoded user paths', () => {
  const nodeBin = findExecutable('node')
  assert.ok(nodeBin !== null, 'node binary should be found on system PATH')
  assert.ok(!nodeBin.includes('/home/csy/.local/bin/vectr'), 'no hardcoded /home/csy user paths')
})

test('ResidentAgyChannel: does not duplicate events in RunRecording', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-single-ev-'))
  const stubBin = join(dir, 'echo-events.mjs')

  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => {
  process.stdout.write(JSON.stringify({
    event: 'step_update',
    idx: 1,
    step_type: 'text',
    text: 'single text'
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: { status: 'DONE', response: 'single text' }
  }) + '\\n');
});
`,
  )

  const channel = new ResidentAgyChannel({
    bin: process.execPath,
    args: [stubBin],
    cwd: dir,
  })

  const rec = new RunRecording()
  const parser = new StreamJsonParser()
  try {
    await channel.sendTurn({
      prompt: 'test',
      recording: rec,
      parser,
    })

    const allEvents = []
    for (let i = 0; i < rec.length; i++) {
      allEvents.push(rec.eventAt(i))
    }

    const textSteps = allEvents.filter((e) => e?.kind === 'step' && e.stepKind === 'text')
    assert.equal(textSteps.length, 1, 'text step must appear exactly once in recording, no duplication')
    const results = allEvents.filter((e) => e?.kind === 'result')
    assert.equal(results.length, 1, 'result must appear exactly once in recording')
  } finally {
    channel.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ResidentAgyChannel: handles stdin error gracefully without process crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-epipe-'))
  const stubBin = join(dir, 'quick-exit.mjs')

  writeFileSync(
    stubBin,
    `#!/usr/bin/env node
process.exit(0);
`,
  )

  const channel = new ResidentAgyChannel({
    bin: process.execPath,
    args: [stubBin],
    cwd: dir,
  })

  const rec = new RunRecording()
  try {
    const outcome = await channel.sendTurn({
      prompt: 'hello',
      recording: rec,
    })
    assert.ok(outcome.code !== undefined || outcome.aborted)
  } catch (err) {
    assert.ok(err instanceof Error)
  }

  channel.close()
  rmSync(dir, { recursive: true, force: true })
})

