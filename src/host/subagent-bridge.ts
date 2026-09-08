// Subagent bridge for Antigravity (agy CLI).
// Captures agy's invoke_subagent and define_subagent tool calls, creates authentic
// DSH child sessions with authoritative `subagent/descriptor` metadata, and streams
// incremental transcript.jsonl steps for deep native DSH lineage & card rendering.

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

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

export interface DshSessionHeader {
  cwd?: string
  delegationDepth?: number
  parentSession?: string
  origin?: string
  [key: string]: unknown
}

export interface DshSession {
  readonly id: string
  readonly header?: DshSessionHeader
  readonly meta?: DshSessionMeta
  append(type: string, data: unknown, opts?: { surfaceOp?: string | object; [key: string]: unknown }): unknown
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
  readonly conversationId?: string
  readonly logAbsoluteUri?: string
  readonly childSession?: DshSession
  readonly task: string
  readonly description: string
  readonly subagentType: string
  readonly startedAt: number
  readonly isStopped: boolean
  bindLogUri(uri: string, conversationId?: string): void
  stop(error?: string, resultText?: string): void
}

export interface StartSubagentOptions {
  toolName: string
  toolArgs?: unknown
  conversationId?: string
  logAbsoluteUri?: string
  parentSessionId?: string
  accountHome?: string
  cwd?: string
  model?: string
  stepKey?: string
  onStep?: (step: Record<string, unknown>) => void
  onStop?: (session: SubagentSession, error?: string, resultText?: string) => void
}

/** Converts file:// URI or plain path to local absolute file path. */
export function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri)
    } catch {
      return uri.replace(/^file:\/\//, '')
    }
  }
  return uri
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
  private readonly sessionsByStepKey = new Map<string, SubagentSession>()
  private readonly sessionsByConversationId = new Map<string, SubagentSession>()
  private readonly claimedTranscriptPaths = new Set<string>()
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

  private logError(context: string, err: unknown): void {
    const message = err instanceof Error ? (err.stack || err.message) : String(err)
    const fullMsg = `[subagent-bridge] ${context}: ${message}`
    if (this.log) {
      this.log(fullMsg)
    } else {
      console.error(fullMsg)
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
   * Get existing active subagent session or start a new one.
   * Performs global deduplication by conversationId and stepKey.
   */
  getOrStartSubagent(opts: StartSubagentOptions & { stepKey?: string }): SubagentSession {
    const rawArgs = (opts.toolArgs && typeof opts.toolArgs === 'object'
      ? opts.toolArgs
      : {}) as Record<string, unknown>

    let subagentItem: Record<string, unknown> | undefined
    const subagentsField = rawArgs.Subagents ?? rawArgs.subagents
    if (typeof subagentsField === 'string') {
      try {
        const parsed = JSON.parse(subagentsField)
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
          subagentItem = parsed[0] as Record<string, unknown>
        }
      } catch {
        // ignore malformed JSON string
      }
    } else if (Array.isArray(subagentsField) && subagentsField.length > 0 && typeof subagentsField[0] === 'object' && subagentsField[0] !== null) {
      subagentItem = subagentsField[0] as Record<string, unknown>
    }

    const item = subagentItem ?? {}
    const rawPrompt = item.Prompt ?? item.prompt ?? item.task ?? item.instruction ?? item.description ??
      rawArgs.Prompt ?? rawArgs.prompt ?? rawArgs.task ?? rawArgs.instruction ?? rawArgs.description
    const promptText = typeof rawPrompt === 'string' ? rawPrompt : ''

    // Deduplication check:
    // 1. By conversationId
    const itemCid = (typeof item.conversationId === 'string' ? item.conversationId : undefined) ??
      (typeof item.conversation_id === 'string' ? item.conversation_id : undefined) ??
      (typeof rawArgs.conversationId === 'string' ? rawArgs.conversationId : undefined) ??
      (typeof rawArgs.conversation_id === 'string' ? rawArgs.conversation_id : undefined)
    const effectiveConvId = opts.conversationId ?? itemCid

    if (effectiveConvId) {
      const existingByConv = this.sessionsByConversationId.get(effectiveConvId)
      if (existingByConv) {
        if (opts.logAbsoluteUri) {
          existingByConv.bindLogUri(opts.logAbsoluteUri, effectiveConvId)
        }
        if (opts.stepKey) {
          this.sessionsByStepKey.set(opts.stepKey, existingByConv)
        }
        return existingByConv
      }
    }

    // 2. By stepKey
    if (opts.stepKey) {
      const existingByStep = this.sessionsByStepKey.get(opts.stepKey)
      if (existingByStep) {
        if (effectiveConvId) {
          existingByStep.bindLogUri(opts.logAbsoluteUri ?? existingByStep.logAbsoluteUri ?? '', effectiveConvId)
        } else if (opts.logAbsoluteUri) {
          existingByStep.bindLogUri(opts.logAbsoluteUri)
        }
        if (effectiveConvId && !this.sessionsByConversationId.has(effectiveConvId)) {
          this.sessionsByConversationId.set(effectiveConvId, existingByStep)
        }
        return existingByStep
      }
    }

    const promptClean = promptText.replace(/\r?\n+/g, ' ').trim()
    const promptSummary = promptClean.length > 50
      ? promptClean.slice(0, 48).trim() + '...'
      : promptClean

    const task = String(rawArgs.task ?? item.task ?? promptText ?? rawArgs.prompt ?? rawArgs.instruction ?? 'Subagent Task')
    const description = String(rawArgs.description ?? rawArgs.summary ?? item.description ?? item.summary ?? (promptSummary || task))
    const label = String(rawArgs.description ?? item.description ?? promptSummary ?? description ?? task)

    const rawRole = item.subagent_type ?? item.subagentType ?? item.agent_type ?? item.role ?? item.Role ?? item.Name ?? item.name ??
      rawArgs.subagent_type ?? rawArgs.agent_type ?? rawArgs.role
    let subagentType = typeof rawRole === 'string' && rawRole.trim() !== '' ? rawRole.trim() : ''

    if (!subagentType) {
      const definedList = this.listRoles()
      if (definedList.length === 1) {
        subagentType = definedList[0]!.name
      } else if (definedList.length > 1) {
        const matched = definedList.find((r) => task.includes(r.name) || (r.description && task.includes(r.description)))
        subagentType = matched ? matched.name : definedList[definedList.length - 1]!.name
      } else {
        subagentType = 'subagent'
      }
    }

    const rawModel = opts.model ??
      (typeof item.model === 'string' && item.model.trim() !== '' ? item.model.trim() : undefined) ??
      (typeof item.Model === 'string' && item.Model.trim() !== '' && item.Model.trim() !== 'inherit' ? item.Model.trim() : undefined) ??
      (typeof rawArgs.model === 'string' && rawArgs.model.trim() !== '' ? rawArgs.model.trim() : undefined) ??
      (typeof rawArgs.Model === 'string' && rawArgs.Model.trim() !== '' && rawArgs.Model.trim() !== 'inherit' ? rawArgs.Model.trim() : undefined)
    const subagentModel = rawModel || 'gemini-2.5-flash'

    const runId = 'subagent-run-' + randomUUID()
    let conversationId = effectiveConvId
    let logAbsoluteUri = opts.logAbsoluteUri
    const subagentId = conversationId
      ? (conversationId.startsWith('agy-') ? conversationId : `agy-${conversationId}`)
      : `subagent-session-${randomUUID()}`
    const startedAt = Date.now()

    // 1. Lineage resolution
    const parentSessionId = opts.parentSessionId
    let delegationDepth = 1
    let parentSession: DshSession | undefined
    const sessionsSvc = this.sessionsService
    if (parentSessionId && sessionsSvc?.get) {
      try {
        parentSession = sessionsSvc.get(parentSessionId)
        const parentDepth = parentSession?.header?.delegationDepth ?? parentSession?.meta?.delegationDepth
        if (parentDepth !== undefined) {
          delegationDepth = Number(parentDepth) + 1
        }
      } catch {
        // ignore
      }
    }

    // Strict absolute cwd resolution
    const parentCwd = parentSession?.header?.cwd ?? (parentSession?.meta?.cwd as string | undefined)
    const rawCwd = (opts.cwd && opts.cwd.trim() !== '')
      ? opts.cwd.trim()
      : (parentCwd && parentCwd.trim() !== '')
      ? parentCwd.trim()
      : process.cwd()
    const safeCwd = resolve(rawCwd) // 必须为规范化绝对路径

    // 2. Create authoritative DSH sub-session
    let childSession: DshSession | undefined
    if (sessionsSvc?.create) {
      try {
        childSession = sessionsSvc.create(subagentId, {
          meta: {
            origin: 'subagent',
            parentSession: parentSessionId,
            delegationDepth,
            cwd: safeCwd,
          },
        })
      } catch (err) {
        this.log?.(`Failed to create DSH subagent session: ${String(err)}`)
      }
    }

    // 3. Write authoritative subagent descriptor and user prompt (DSH Subagent Seam)
    if (childSession?.append) {
      try {
        childSession.append('turn/start', { turn: 1 })
        childSession.append('subagent/descriptor', {
          version: 3,
          mode: 'one-shot',
          provider: 'antigravity',
          label: label || description || task,
        })
        childSession.append('user/message', {
          id: `msg-user-${randomUUID()}`,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: promptText || task || description || 'Subagent execution' }],
        }, { surfaceOp: 'append' })
      } catch (err) {
        this.logError('Failed to initialize subagent turn and user/message in child session', err)
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

    // 5. Targeted Transcript Tailer
    let transcriptFile: string | null = logAbsoluteUri ? uriToPath(logAbsoluteUri) : null
    if (transcriptFile) {
      this.claimedTranscriptPaths.add(transcriptFile)
    }

    let fileOffset = 0
    let carryover = ''
    let stopped = false
    let pollTimer: NodeJS.Timeout | null = null
    let currentStep = 1
    let stepIsOpen = false
    const decoder = new StringDecoder('utf8')

    // Tool call / result FIFO pairing queue and step tracking
    const pendingToolCallIds: string[] = []
    const pendingCallsInStep = new Set<string>()
    let hasStreamedAssistantChunk = false
    let accumulatedAssistantText = ''

    const ensureStepOpen = () => {
      if (!stepIsOpen && childSession?.append) {
        try {
          childSession.append('step/start', { turn: 1, step: currentStep })
          stepIsOpen = true
        } catch (err) {
          this.logError('Failed to append step/start to child session', err)
        }
      }
    }

    const ensureStepClosed = () => {
      if (stepIsOpen && childSession?.append) {
        try {
          childSession.append('step/end', { turn: 1, step: currentStep })
          stepIsOpen = false
          pendingCallsInStep.clear()
          currentStep += 1
        } catch (err) {
          this.logError('Failed to append step/end to child session', err)
        }
      }
    }

    const findTranscript = (): string | null => {
      const brainDir = defaultBrainDir(opts.accountHome)
      if (!existsSync(brainDir)) return null

      // 1. Direct path probing when conversationId is known
      if (conversationId) {
        const directFile = join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl')
        if (existsSync(directFile)) {
          this.claimedTranscriptPaths.add(directFile)
          return directFile
        }
      }

      // 2. Fallback to mtime directory detection only when conversationId is unknown
      if (!conversationId) {
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
            if (this.claimedTranscriptPaths.has(tFile)) {
              continue
            }
            if (existsSync(tFile)) {
              this.claimedTranscriptPaths.add(tFile)
              return tFile
            }
          }
        } catch {
          // ignore
        }
      }
      return null
    }

    const appendStepToChildSession = (stepObj: Record<string, unknown>) => {
      if (!childSession?.append) return
      try {
        // Thinking / reasoning
        if (typeof stepObj.thinking === 'string' && stepObj.thinking.length > 0) {
          ensureStepOpen()
          childSession.append('assistant/chunk', {
            turn: 1,
            step: currentStep,
            chunk: {
              type: 'reasoning-delta',
              index: 0,
              text: stepObj.thinking,
            },
          })
        }

        // Tool calls
        if (Array.isArray(stepObj.tool_calls) && stepObj.tool_calls.length > 0) {
          ensureStepOpen()
          for (const tc of stepObj.tool_calls) {
            if (tc && typeof tc === 'object') {
              const tcObj = tc as Record<string, unknown>
              const callName = String(tcObj.name ?? 'tool')
              const callArgs = typeof tcObj.args === 'string' ? tcObj.args : JSON.stringify(tcObj.args ?? {})
              const callId = String(tcObj.id ?? tcObj.call_id ?? `agytc-sub-${randomUUID()}`)
              pendingToolCallIds.push(callId)
              pendingCallsInStep.add(callId)
              childSession.append('tool/call', {
                turn: 1,
                step: currentStep,
                callId,
                name: callName,
                arguments: callArgs,
              })
            }
          }
        } else if (stepObj.tool || stepObj.type === 'tool' || stepObj.tool_name) {
          ensureStepOpen()
          const callId = String(stepObj.call_id ?? stepObj.callId ?? `agytc-sub-${randomUUID()}`)
          pendingToolCallIds.push(callId)
          pendingCallsInStep.add(callId)
          childSession.append('tool/call', {
            turn: 1,
            step: currentStep,
            callId,
            name: String(stepObj.tool ?? stepObj.tool_name ?? 'tool'),
            arguments: typeof stepObj.args === 'string' ? stepObj.args : JSON.stringify(stepObj.args ?? {}),
          })
        }

        // Tool results (GENERIC or tool_result)
        if (stepObj.type === 'GENERIC' || stepObj.type === 'tool_result' || stepObj.event === 'tool_result') {
          const rawCallId = stepObj.call_id ?? stepObj.callId ?? stepObj.tool_call_id
          const hasExplicitCallId = rawCallId !== undefined && rawCallId !== null && String(rawCallId).trim() !== ''

          if (stepObj.type === 'GENERIC' && !hasExplicitCallId && pendingToolCallIds.length === 0) {
            // Treat as regular text stream (assistant/chunk) - forbid forging fake tool/call ghost cards
            const text = typeof stepObj.content === 'string'
              ? stepObj.content
              : typeof stepObj.output === 'string'
              ? stepObj.output
              : typeof stepObj.text === 'string'
              ? stepObj.text
              : undefined

            if (text !== undefined && text.length > 0) {
              hasStreamedAssistantChunk = true
              accumulatedAssistantText += text.endsWith('\n') ? text : text + '\n'
              ensureStepOpen()
              childSession.append('assistant/chunk', {
                turn: 1,
                step: currentStep,
                chunk: {
                  type: 'text-delta',
                  index: 0,
                  text: text.endsWith('\n') ? text : text + '\n',
                },
              })
            }
          } else {
            ensureStepOpen()
            const resText = typeof stepObj.content === 'string'
              ? stepObj.content
              : typeof stepObj.output === 'string'
              ? stepObj.output
              : JSON.stringify(stepObj)
            
            let matchedCallId: string
            if (hasExplicitCallId) {
              matchedCallId = String(rawCallId)
              const idx = pendingToolCallIds.indexOf(matchedCallId)
              if (idx >= 0) {
                pendingToolCallIds.splice(idx, 1)
              }
            } else if (pendingToolCallIds.length > 0) {
              matchedCallId = pendingToolCallIds.shift()!
            } else {
              matchedCallId = `agytc-sub-${randomUUID()}`
            }

            // Invariant requirement: tool/result must pair with a prior tool/call in this open step
            if (!pendingCallsInStep.has(matchedCallId)) {
              childSession.append('tool/call', {
                turn: 1,
                step: currentStep,
                callId: matchedCallId,
                name: 'tool',
                arguments: '{}',
              })
              pendingCallsInStep.add(matchedCallId)
            }

            childSession.append('tool/result', {
              turn: 1,
              step: currentStep,
              callId: matchedCallId,
              output: resText,
              isError: stepObj.status === 'ERROR',
              message: {
                id: `msg-tool-${randomUUID()}`,
                role: 'user',
                source: { kind: 'tool', callId: matchedCallId },
                content: [{
                  type: 'tool-result',
                  toolCallId: matchedCallId,
                  content: [{ type: 'text', text: resText }],
                  isError: stepObj.status === 'ERROR',
                }],
              },
            }, { surfaceOp: 'append' })

            pendingCallsInStep.delete(matchedCallId)
          }
        }

        // Assistant response text (if not USER_INPUT and not GENERIC tool result)
        if (
          stepObj.type !== 'USER_INPUT' &&
          stepObj.source !== 'USER_EXPLICIT' &&
          stepObj.type !== 'GENERIC' &&
          stepObj.type !== 'tool_result' &&
          stepObj.event !== 'tool_result'
        ) {
          const text = typeof stepObj.text === 'string'
            ? stepObj.text
            : typeof stepObj.content === 'string'
            ? stepObj.content
            : typeof stepObj.step === 'string'
            ? stepObj.step
            : typeof stepObj.message === 'string'
            ? stepObj.message
            : undefined

          if (text !== undefined && text.length > 0) {
            hasStreamedAssistantChunk = true
            accumulatedAssistantText += text.endsWith('\n') ? text : text + '\n'
            ensureStepOpen()
            childSession.append('assistant/chunk', {
              turn: 1,
              step: currentStep,
              chunk: {
                type: 'text-delta',
                index: 0,
                text: text.endsWith('\n') ? text : text + '\n',
              },
            })
          }
        }
      } catch (err) {
        this.logError('Failed to append step to child session', err)
      }
    }

    const isTerminalStep = (parsed: Record<string, unknown>): boolean => {
      const isToolResult =
        parsed.type === 'GENERIC' ||
        parsed.type === 'tool_result' ||
        parsed.event === 'tool_result'

      if (parsed.status === 'ERROR') {
        if (isToolResult) return false
        return true
      }
      if (parsed.event === 'result' || parsed.type === 'result' || parsed.type === 'final') return true
      if (
        (parsed.status === 'DONE' || parsed.status === 'COMPLETED') &&
        (parsed.type === 'PLANNER_RESPONSE' || parsed.type === 'agent_response') &&
        (!parsed.tool_calls || (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length === 0))
      ) {
        return true
      }
      return false
    }

    const CHUNK_SIZE = 64 * 1024

    const poll = () => {
      if (stopped) return
      let hasMoreToRead = false
      try {
        if (!transcriptFile) {
          transcriptFile = findTranscript()
        }
        if (transcriptFile && existsSync(transcriptFile)) {
          const st = statSync(transcriptFile)
          if (st.size < fileOffset) {
            fileOffset = 0
            carryover = ''
          }
          if (st.size > fileOffset) {
            const fd = openSync(transcriptFile, 'r')
            try {
              const bytesToRead = Math.min(st.size - fileOffset, CHUNK_SIZE)
              const buf = Buffer.alloc(bytesToRead)
              const bytesRead = readSync(fd, buf, 0, bytesToRead, fileOffset)
              fileOffset += bytesRead
              hasMoreToRead = st.size > fileOffset
              const chunkStr = carryover + decoder.write(buf.subarray(0, bytesRead))
              const lastNl = chunkStr.lastIndexOf('\n')
              if (lastNl >= 0) {
                const completeLines = chunkStr.slice(0, lastNl).split('\n')
                carryover = chunkStr.slice(lastNl + 1)
                for (const line of completeLines) {
                  const trimmed = line.trim()
                  if (!trimmed) continue
                  try {
                    const parsed = JSON.parse(trimmed) as Record<string, unknown>
                    opts.onStep?.(parsed)
                    this.emitter?.emit('subagent/step', {
                      runId,
                      id: subagentId,
                      step: parsed,
                    })
                    appendStepToChildSession(parsed)

                    if (isTerminalStep(parsed) && !stopped) {
                      const errText = parsed.status === 'ERROR'
                        ? String(parsed.error ?? parsed.message ?? 'subagent error')
                        : undefined
                      const resText = typeof parsed.content === 'string'
                        ? parsed.content
                        : typeof parsed.response === 'string'
                        ? parsed.response
                        : undefined
                      session.stop(errText, resText)
                      return
                    }
                  } catch (lineErr) {
                    this.logError('Failed to parse and process transcript line in poll', lineErr)
                  }
                }
              } else {
                carryover = chunkStr
              }
            } finally {
              closeSync(fd)
            }
          }
        }
      } catch (pollErr) {
        this.logError('Transcript polling cycle encountered error', pollErr)
      }
      if (!stopped) {
        pollTimer = setTimeout(poll, hasMoreToRead ? 5 : 150)
        pollTimer.unref?.()
      }
    }

    // Start polling
    pollTimer = setTimeout(poll, 50)
    pollTimer.unref?.()

    const session: SubagentSession = {
      runId,
      subagentId,
      get conversationId() { return conversationId },
      get logAbsoluteUri() { return logAbsoluteUri },
      childSession,
      task,
      description,
      subagentType,
      startedAt,
      get isStopped() { return stopped },
      bindLogUri: (uri: string, convId?: string) => {
        if (convId && !conversationId) {
          conversationId = convId
          this.sessionsByConversationId.set(convId, session)
        }
        logAbsoluteUri = uri
        const resolved = uriToPath(uri)
        if (transcriptFile !== resolved) {
          if (transcriptFile) {
            this.claimedTranscriptPaths.delete(transcriptFile)
          }
          transcriptFile = resolved
          this.claimedTranscriptPaths.add(resolved)
          fileOffset = 0
          carryover = ''
          if (pollTimer) clearTimeout(pollTimer)
          pollTimer = setTimeout(poll, 10)
          pollTimer.unref?.()
        }
      },
      stop: (error?: string, resultText?: string) => {
        if (stopped) return
        stopped = true
        if (pollTimer) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
        if (transcriptFile) {
          this.claimedTranscriptPaths.delete(transcriptFile)
        }

        // Read remaining lines in bounded chunks
        try {
          if (transcriptFile && existsSync(transcriptFile)) {
            const st = statSync(transcriptFile)
            if (st.size > fileOffset) {
              const fd = openSync(transcriptFile, 'r')
              try {
                while (st.size > fileOffset) {
                  const bytesToRead = Math.min(st.size - fileOffset, CHUNK_SIZE)
                  const buf = Buffer.alloc(bytesToRead)
                  const bytesRead = readSync(fd, buf, 0, bytesToRead, fileOffset)
                  fileOffset += bytesRead
                  const chunkStr = carryover + decoder.write(buf.subarray(0, bytesRead))
                  const lastNl = chunkStr.lastIndexOf('\n')
                  if (lastNl >= 0) {
                    const completeLines = chunkStr.slice(0, lastNl).split('\n')
                    carryover = chunkStr.slice(lastNl + 1)
                    for (const line of completeLines) {
                      const trimmed = line.trim()
                      if (!trimmed) continue
                      try {
                        const parsed = JSON.parse(trimmed) as Record<string, unknown>
                        opts.onStep?.(parsed)
                        this.emitter?.emit('subagent/step', {
                          runId,
                          id: subagentId,
                          step: parsed,
                        })
                        appendStepToChildSession(parsed)
                      } catch (drainLineErr) {
                        this.logError('Failed to parse drained transcript line on stop', drainLineErr)
                      }
                    }
                  } else {
                    carryover = chunkStr
                  }
                }
              } finally {
                closeSync(fd)
              }
            }
          }
        } catch (drainErr) {
          this.logError('Failed to drain transcript file on stop', drainErr)
        }

        if (carryover.trim()) {
          const remaining = carryover + decoder.end()
          carryover = ''
          const lines = remaining.split('\n').map((l) => l.trim()).filter(Boolean)
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
            } catch (resLineErr) {
              this.logError('Failed to parse residual transcript line on stop', resLineErr)
            }
          }
        }

        // Append final result and turn/end to DSH child session
        if (childSession?.append) {
          try {
            try {
              const finalText = (resultText && resultText.trim().length > 0)
                ? resultText
                : accumulatedAssistantText.trim()

              if (finalText.length > 0) {
                ensureStepOpen()
                childSession.append('assistant/message', {
                  turn: 1,
                  step: currentStep,
                  message: {
                    id: `msg-subagent-${randomUUID()}`,
                    role: 'assistant',
                    source: {
                      kind: 'model',
                      provider: 'antigravity',
                      model: subagentModel,
                    },
                    content: [{ type: 'text', text: finalText }],
                  },
                }, { surfaceOp: 'append' })
              }
            } finally {
              try {
                ensureStepClosed()
              } catch (stepCloseErr) {
                this.logError('Failed to close step in child session on stop', stepCloseErr)
              }
              try {
                const isAborted = error === 'aborted'
                childSession.append('turn/end', {
                  turn: 1,
                  reason: { kind: isAborted ? 'aborted' : (error ? 'error' : 'completed') },
                })
              } catch (turnEndErr) {
                this.logError('Failed to append turn/end to child session on stop', turnEndErr)
              }
            }
          } catch (err) {
            this.logError('Failed to append terminal state to child session', err)
          }
        }

        const isAborted = error === 'aborted'
        const endPayload: SubagentEndInfo = {
          runId,
          provider: 'antigravity',
          id: subagentId,
          local: true,
          stopReason: isAborted ? 'aborted' : (error ? 'error' : 'endTurn'),
          lastAssistantMessage: resultText ? [{ type: 'text', text: resultText }] : undefined,
        }

        this.log?.(`Subagent completed: ${runId} (stopReason=${endPayload.stopReason})`)
        this.emitter?.emit('subagent/end', endPayload)
        this.activeSubagents.delete(runId)
        if (opts.stepKey) {
          this.sessionsByStepKey.delete(opts.stepKey)
        }
        if (conversationId) {
          this.sessionsByConversationId.delete(conversationId)
        }
        opts.onStop?.(session, error, resultText)
      },
    }

    this.activeSubagents.set(runId, session)
    if (conversationId) {
      this.sessionsByConversationId.set(conversationId, session)
    }
    if (opts.stepKey) {
      this.sessionsByStepKey.set(opts.stepKey, session)
    }

    return session
  }

  /**
   * Start a subagent session when agy calls invoke_subagent.
   * Backwards compatible delegate to getOrStartSubagent.
   */
  startSubagent(opts: StartSubagentOptions & { stepKey?: string }): SubagentSession {
    return this.getOrStartSubagent(opts)
  }

  getActive(runId: string): SubagentSession | undefined {
    const s = this.activeSubagents.get(runId)
    return s && !s.isStopped ? s : undefined
  }

  getActiveSubagents(): readonly SubagentSession[] {
    return Array.from(this.activeSubagents.values()).filter((s) => !s.isStopped)
  }

  hasActiveSubagents(): boolean {
    return this.getActiveSubagents().length > 0
  }

  getActiveByConversationId(conversationId: string): SubagentSession | undefined {
    const s = this.sessionsByConversationId.get(conversationId)
    if (s && !s.isStopped) return s
    for (const sub of this.activeSubagents.values()) {
      if (sub.conversationId === conversationId && !sub.isStopped) return sub
    }
    return undefined
  }

  getActiveByStepKey(stepKey: string): SubagentSession | undefined {
    const s = this.sessionsByStepKey.get(stepKey)
    if (s && !s.isStopped) return s
    return undefined
  }

  stopSubagentByConversationId(conversationId: string, error?: string, resultText?: string): boolean {
    const s = this.getActiveByConversationId(conversationId)
    if (s) {
      s.stop(error, resultText)
      return true
    }
    return false
  }

  stopAllSubagents(error?: string, resultText?: string, parentSessionId?: string): void {
    for (const s of Array.from(this.activeSubagents.values())) {
      if (!s.isStopped) {
        if (parentSessionId && s.childSession?.meta?.parentSession && s.childSession.meta.parentSession !== parentSessionId) {
          continue
        }
        s.stop(error, resultText)
      }
    }
  }

  bindSubagentLogUri(keyOrConversationId: string, uri: string, conversationId?: string): boolean {
    const s = this.getActiveByConversationId(keyOrConversationId) ??
      this.getActiveByStepKey(keyOrConversationId) ??
      this.getActive(keyOrConversationId)
    if (s) {
      s.bindLogUri(uri, conversationId)
      return true
    }
    return false
  }

  dispose(): void {
    for (const sub of Array.from(this.activeSubagents.values())) {
      if (!sub.isStopped) {
        sub.stop('aborted', 'Host unloaded')
      }
    }
    this.activeSubagents.clear()
    this.sessionsByStepKey.clear()
    this.sessionsByConversationId.clear()
    this.claimedTranscriptPaths.clear()
  }
}
