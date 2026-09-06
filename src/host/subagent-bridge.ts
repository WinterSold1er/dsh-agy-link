// Subagent bridge for Antigravity (agy CLI).
// Captures agy's invoke_subagent and define_subagent tool calls, creates authentic
// DSH child sessions with authoritative `subagent/descriptor` metadata, and streams
// incremental transcript.jsonl steps for deep native DSH lineage & card rendering.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export interface SubagentEventEmitter {
  emit(event: string, ...args: unknown[]): void
}

export interface DshSessionMeta {
  origin?: string
  parentSession?: string
  delegationDepth?: number
  cwd?: string
  [key: string]: unknown
}

export interface DshSession {
  readonly id: string
  readonly meta?: DshSessionMeta
  append(type: string, data: unknown): void
}

export interface DshSessionManager {
  get?(id: string): DshSession | undefined
  create(id?: string, options?: { meta?: DshSessionMeta }): DshSession
}

export interface SubagentBridgeContext {
  emit?(event: string, ...args: unknown[]): void
  sessions?: DshSessionManager
}

export interface SubagentRoleDefinition {
  name: string
  description?: string
  instructions?: string
  tools?: readonly string[]
  raw?: Record<string, unknown>
  definedAt: number
}

export interface SubagentStartInfo {
  runId: string
  provider: string
  id: string
  local: boolean
  task?: string
  description?: string
  subagentType?: string
  parentSessionId?: string
  delegationDepth?: number
}

export interface SubagentEndInfo {
  runId: string
  provider: string
  id: string
  local: boolean
  stopReason: 'endTurn' | 'error' | 'aborted'
  lastAssistantMessage?: Array<{ type: string; text?: string }>
}

export interface SubagentStepInfo {
  runId: string
  id: string
  step: Record<string, unknown>
}

export interface SubagentSession {
  readonly runId: string
  readonly subagentId: string
  readonly childSession?: DshSession
  readonly task: string
  readonly description: string
  readonly subagentType: string
  readonly startedAt: number
  stop(error?: string, resultText?: string): void
}

/** Resolves brain directory where agy writes subagent transcripts. */
export function defaultBrainDir(accountHome?: string): string {
  const base = accountHome ?? homedir()
  return join(base, '.gemini', 'antigravity-cli', 'brain')
}

/**
 * Manages active subagents dispatched by agy, creates native DSH sessions,
 * and streams their transcripts.
 */
export class SubagentBridge {
  private readonly definedRoles = new Map<string, SubagentRoleDefinition>()
  private readonly activeSubagents = new Map<string, SubagentSession>()
  private readonly emitter?: SubagentEventEmitter
  private readonly sessions?: DshSessionManager
  private readonly ctx?: SubagentBridgeContext | SubagentEventEmitter

  constructor(
    ctxOrEmitter?: SubagentBridgeContext | SubagentEventEmitter,
    private readonly log?: (msg: string) => void,
  ) {
    this.ctx = ctxOrEmitter
    if (ctxOrEmitter) {
      try {
        if ('emit' in ctxOrEmitter && typeof ctxOrEmitter.emit === 'function') {
          this.emitter = ctxOrEmitter as SubagentEventEmitter
        }
      } catch {}
      try {
        const anyObj = ctxOrEmitter as Record<string, unknown>
        const s = anyObj.sessions ?? (typeof anyObj.get === 'function' ? (anyObj.get as (k: string) => unknown)('sessions') : undefined)
        if (s) {
          this.sessions = s as DshSessionManager
        }
      } catch {}
    }
  }

  private get sessionsService(): DshSessionManager | undefined {
    if (this.sessions) return this.sessions
    if (this.ctx && typeof this.ctx === 'object') {
      const anyCtx = this.ctx as Record<string, unknown>
      try {
        const s = anyCtx.sessions ?? (typeof anyCtx.get === 'function' ? (anyCtx.get as (k: string) => unknown)('sessions') : undefined)
        if (s && typeof s === 'object') return s as DshSessionManager
      } catch {}
    }
    return undefined
  }

  /**
   * Save a subagent role definition (from define_subagent tool call).
   */
  defineRole(args: unknown): SubagentRoleDefinition {
    const raw = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    const name = String(raw.name ?? raw.role ?? raw.subagent_type ?? raw.agent_type ?? 'subagent')
    const description = raw.description ? String(raw.description) : (raw.summary ? String(raw.summary) : undefined)
    const instructions = raw.instructions ? String(raw.instructions) : (raw.prompt ? String(raw.prompt) : (raw.system_prompt ? String(raw.system_prompt) : undefined))
    const tools = Array.isArray(raw.tools)
      ? (raw.tools as unknown[]).map(String)
      : Array.isArray(raw.allowed_tools)
      ? (raw.allowed_tools as unknown[]).map(String)
      : undefined

    const roleDef: SubagentRoleDefinition = {
      name,
      description,
      instructions,
      tools,
      raw,
      definedAt: Date.now(),
    }

    this.definedRoles.set(name, roleDef)
    this.log?.(`Subagent role defined: [${name}] ${description ?? ''}`)
    this.emitter?.emit('subagent/defined', roleDef)
    return roleDef
  }

  /**
   * Retrieve a defined subagent role by name.
   */
  getRole(name: string): SubagentRoleDefinition | undefined {
    return this.definedRoles.get(name)
  }

  /**
   * List all registered subagent roles.
   */
  listRoles(): SubagentRoleDefinition[] {
    return Array.from(this.definedRoles.values())
  }

  /**
   * Start a subagent session when agy calls invoke_subagent.
   * Creates a native DSH child session, writes subagent/descriptor,
   * emits lifecycle events, and tails transcript.jsonl.
   */
  startSubagent(opts: {
    toolName: string
    toolArgs?: unknown
    parentSessionId?: string
    accountHome?: string
    cwd?: string
    onStep?: (step: Record<string, unknown>) => void
  }): SubagentSession {
    const rawArgs = (opts.toolArgs && typeof opts.toolArgs === 'object'
      ? opts.toolArgs
      : {}) as Record<string, unknown>

    const task = String(rawArgs.task ?? rawArgs.prompt ?? rawArgs.instruction ?? 'Subagent Task')
    const description = String(rawArgs.description ?? rawArgs.summary ?? task)
    const subagentType = String(rawArgs.subagent_type ?? rawArgs.agent_type ?? rawArgs.role ?? 'subagent')

    const runId = 'subagent-run-' + randomUUID()
    const subagentId = 'subagent-session-' + randomUUID()
    const startedAt = Date.now()

    // 1. Lineage resolution
    const parentSessionId = opts.parentSessionId
    let delegationDepth = 1
    let parentSession: DshSession | undefined
    const sessionsSvc = this.sessionsService
    if (parentSessionId && sessionsSvc?.get) {
      try {
        parentSession = sessionsSvc.get(parentSessionId)
        if (parentSession?.meta?.delegationDepth !== undefined) {
          delegationDepth = Number(parentSession.meta.delegationDepth) + 1
        }
      } catch {
        // ignore
      }
    }

    // 2. Create authoritative DSH sub-session
    let childSession: DshSession | undefined
    if (sessionsSvc?.create) {
      try {
        childSession = sessionsSvc.create(subagentId, {
          meta: {
            origin: 'subagent',
            parentSession: parentSessionId,
            delegationDepth,
            cwd: opts.cwd ?? (parentSession?.meta?.cwd as string | undefined),
          },
        })
      } catch (err) {
        this.log?.(`Failed to create DSH subagent session: ${String(err)}`)
      }
    }

    // 3. Write authoritative subagent descriptor
    if (childSession?.append) {
      try {
        childSession.append('turn/start', { turn: 1 })
        childSession.append('subagent/descriptor', {
          version: 3,
          mode: 'one-shot',
          provider: 'antigravity',
          label: description || task,
        })
      } catch (err) {
        this.log?.(`Failed to append subagent descriptor to child session: ${String(err)}`)
      }
    }

    // 4. Emit standard subagent/start lifecycle event
    const startPayload: SubagentStartInfo = {
      runId,
      provider: 'antigravity',
      id: subagentId,
      local: true,
      task,
      description,
      subagentType,
      parentSessionId,
      delegationDepth,
    }

    this.log?.(`Subagent started: [${subagentType}] ${description} (runId=${runId}, subagentId=${subagentId})`)
    this.emitter?.emit('subagent/start', startPayload)

    // 5. Poll / tail transcript.jsonl from agy's brain directory
    const brainDir = defaultBrainDir(opts.accountHome)
    let transcriptFile: string | null = null
    let fileOffset = 0
    let stopped = false
    let pollTimer: NodeJS.Timeout | null = null
    let stepCounter = 1

    const findTranscript = (): string | null => {
      if (!existsSync(brainDir)) return null
      try {
        const dirs = readdirSync(brainDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => {
            const p = join(brainDir, d.name)
            try {
              const st = statSync(p)
              return { path: p, mtime: st.mtimeMs }
            } catch {
              return { path: p, mtime: 0 }
            }
          })
          .sort((a, b) => b.mtime - a.mtime)

        for (const candidate of dirs) {
          if (candidate.mtime < startedAt - 1000) {
            // Historic run directory before this subagent started — skip
            continue
          }
          const tFile = join(candidate.path, '.system_generated', 'logs', 'transcript.jsonl')
          if (existsSync(tFile)) {
            return tFile
          }
        }
      } catch {
        // ignore
      }
      return null
    }

    const appendStepToChildSession = (stepObj: Record<string, unknown>) => {
      if (!childSession?.append) return
      try {
        if (stepObj.tool || stepObj.type === 'tool' || stepObj.tool_name) {
          childSession.append('tool/call', {
            turn: 1,
            step: stepCounter++,
            callId: String(stepObj.call_id ?? stepObj.callId ?? `agytc-sub-${stepCounter}`),
            name: String(stepObj.tool ?? stepObj.tool_name ?? 'tool'),
            arguments: typeof stepObj.args === 'string' ? stepObj.args : JSON.stringify(stepObj.args ?? {}),
          })
        } else {
          const text = typeof stepObj.text === 'string'
            ? stepObj.text
            : typeof stepObj.content === 'string'
            ? stepObj.content
            : typeof stepObj.step === 'string'
            ? stepObj.step
            : typeof stepObj.message === 'string'
            ? stepObj.message
            : JSON.stringify(stepObj)
          childSession.append('assistant/chunk', {
            turn: 1,
            step: stepCounter++,
            chunk: {
              type: 'text-delta',
              index: 0,
              text: text.endsWith('\n') ? text : text + '\n',
            },
          })
        }
      } catch (err) {
        this.log?.(`Failed to append step to child session: ${String(err)}`)
      }
    }

    const poll = () => {
      if (stopped) return
      try {
        if (!transcriptFile) {
          transcriptFile = findTranscript()
        }
        if (transcriptFile && existsSync(transcriptFile)) {
          const content = readFileSync(transcriptFile, 'utf8')
          const lastNl = content.lastIndexOf('\n')
          if (lastNl >= fileOffset) {
            const newChunk = content.slice(fileOffset, lastNl)
            fileOffset = lastNl + 1
            const lines = newChunk.split('\n').map((l) => l.trim()).filter(Boolean)
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line) as Record<string, unknown>
                opts.onStep?.(parsed)
                this.emitter?.emit('subagent/step', {
                  runId,
                  id: subagentId,
                  step: parsed,
                })
                appendStepToChildSession(parsed)
              } catch {
                // skip malformed line
              }
            }
          }
        }
      } catch {
        // best effort polling
      }
      if (!stopped) {
        pollTimer = setTimeout(poll, 150)
        pollTimer.unref?.()
      }
    }

    // Start polling for transcript lines
    pollTimer = setTimeout(poll, 50)
    pollTimer.unref?.()

    const session: SubagentSession = {
      runId,
      subagentId,
      childSession,
      task,
      description,
      subagentType,
      startedAt,
      stop: (error?: string, resultText?: string) => {
        if (stopped) return
        stopped = true
        if (pollTimer) clearTimeout(pollTimer)

        // Read remaining lines one last time
        try {
          if (transcriptFile && existsSync(transcriptFile)) {
            const content = readFileSync(transcriptFile, 'utf8')
            if (content.length > fileOffset) {
              const newChunk = content.slice(fileOffset)
              const lines = newChunk.split('\n').map((l) => l.trim()).filter(Boolean)
              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line) as Record<string, unknown>
                  opts.onStep?.(parsed)
                  this.emitter?.emit('subagent/step', {
                    runId,
                    id: subagentId,
                    step: parsed,
                  })
                  appendStepToChildSession(parsed)
                } catch {}
              }
            }
          }
        } catch {}

        // Append final result and turn/end to DSH child session
        if (childSession?.append) {
          try {
            if (resultText) {
              childSession.append('assistant/message', {
                turn: 1,
                step: stepCounter++,
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: resultText }],
                },
              })
            }
            childSession.append('turn/end', {
              turn: 1,
              reason: { kind: error ? 'error' : 'completed' },
            })
          } catch (err) {
            this.log?.(`Failed to append terminal state to child session: ${String(err)}`)
          }
        }

        const endPayload: SubagentEndInfo = {
          runId,
          provider: 'antigravity',
          id: subagentId,
          local: true,
          stopReason: error ? 'error' : 'endTurn',
          lastAssistantMessage: resultText ? [{ type: 'text', text: resultText }] : undefined,
        }

        this.log?.(`Subagent completed: ${runId} (stopReason=${endPayload.stopReason})`)
        this.emitter?.emit('subagent/end', endPayload)
        this.activeSubagents.delete(runId)
      },
    }

    this.activeSubagents.set(runId, session)
    return session
  }

  getActive(runId: string): SubagentSession | undefined {
    return this.activeSubagents.get(runId)
  }

  dispose(): void {
    for (const sub of this.activeSubagents.values()) {
      sub.stop('aborted', 'Host unloaded')
    }
    this.activeSubagents.clear()
  }
}
