// AgyAdapter — the LlmAdapter implementation at the heart of the plugin
// (spec section 3). Translates one DSH model call into a short-lived
// `agy -p --output-format stream-json` child process, maps the NDJSON event
// stream onto StreamChunks, and binds DSH sessions to agy conversations for
// multi-turn continuity (ADR-4). Only the trailing user messages become the
// prompt; earlier context rides agy-native history plus a digest prefix on
// first bind (ADR-7).
import { isAbsolute, join, resolve } from 'node:path'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Err, looksLikeAuthFailure, looksLikeHardRateLimit, looksLikeRateLimit, PROVIDER_ID, type PluginConfig } from '../common/types.ts'
import { modelFamilyOf } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { diffConversations, snapshotConversations } from './discovery.ts'
import { EventMapper } from './mapper.ts'
import { parseMirrorCallId, type RunRecording, type RunRegistry } from './recording.ts'
import { defaultEffortFor, findEntry, ModelCatalog, resolveModelSlug } from './models.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir, stageImages, type ImageRefLike } from './media.ts'
import { isolatedHomeEnv, startAgyProcess, type AgyProcessSupervisor, type RunOutcome } from './runner.ts'
import { sanitizePromptForAgy } from './skills-bridge.ts'
import type { SubagentBridge } from './subagent-bridge.ts'

export const SYSTEM_BACKGROUND_SERVICE_DIRECTIVE = `<SYSTEM_BACKGROUND_SERVICE_DIRECTIVE>
CRITICAL OPERATIONAL DIRECTIVE:
You have access to the "background_service" tool (also exposed as "mcp_dsh_managed__dsh_tools_background_service" depending on the client tool naming convention) to manage long-running background processes (such as dev servers, mock APIs, emulators, daemons, and file watchers).
NEVER launch long-running or blocking background processes directly using "run_command" or terminal commands (e.g. npm start, vite, node server.js, python -m http.server, etc. without background management). Doing so hangs the execution pipeline.
Always use "background_service" (or "mcp_dsh_managed__dsh_tools_background_service") with action="start" to launch long-running tasks, and use action="status", "logs", and "stop" to manage them.
</SYSTEM_BACKGROUND_SERVICE_DIRECTIVE>`
import { Heartbeat } from './heartbeat.ts'
import { stateDir } from '../common/config.ts'
import type { SessionStore } from './sessions.ts'

type ForeignSource = { source?: { kind?: string; provider?: string } }

function textOf(m: Message): string {
  const parts: string[] = []
  for (const b of m.content) {
    if (b.type === 'text') {
      parts.push(b.text)
    } else if (b.type === 'tool-result') {
      const anyB = b as { content?: unknown[]; text?: string; output?: string; error?: string }
      if (Array.isArray(anyB.content)) {
        for (const inner of anyB.content) {
          if (typeof inner === 'string') parts.push(inner)
          else if (inner && typeof inner === 'object' && 'text' in inner && typeof (inner as { text: unknown }).text === 'string') {
            parts.push((inner as { text: string }).text)
          }
        }
      } else if (typeof anyB.content === 'string') {
        parts.push(anyB.content)
      } else if (typeof anyB.text === 'string') {
        parts.push(anyB.text)
      } else if (typeof anyB.output === 'string') {
        parts.push(anyB.output)
      } else if (typeof anyB.error === 'string') {
        parts.push(anyB.error)
      }
    }
  }
  return parts.filter((s) => s !== '').join('\n')
}

function isForeignAssistant(m: Message): boolean {
  if (m.role !== 'assistant') return false
  const src = (m as unknown as ForeignSource).source
  return !src || src.provider !== PROVIDER_ID
}

/** Rolling digest of turns this agy conversation has not seen (ADR-7). */
export function buildDigest(messages: readonly Message[], fromIdx: number, maxChars: number): string {
  const parts: string[] = []
  let budget = maxChars
  for (let i = messages.length - 1; i >= fromIdx; i--) {
    const m = messages[i]
    if (m === undefined || m.role === 'system') continue
    const text = textOf(m)
    if (text === '') continue
    const line = (m.role === 'user' ? 'User: ' : 'Assistant: ') + text
    if (line.length > budget) {
      parts.unshift(line.slice(0, Math.max(0, budget)))
      break
    }
    budget -= line.length
    parts.unshift(line)
  }
  if (parts.length === 0) return ''
  return '[conversation so far]\n' + parts.join('\n\n') + '\n[end of conversation so far]\n\n'
}

export interface AgyAdapterDeps {
  getConfig: () => PluginConfig
  catalog: ModelCatalog
  store: SessionStore
  pool?: AccountPoolManager
  bin: () => string | null
  /** Shared semaphore for cross-session concurrency (ADR-12). */
  acquire: () => Promise<() => void>
  log?: (msg: string) => void
  /** Recordings shared with the agy_tool mirror (native tool-card mirroring). */
  runs: RunRegistry
  /** Resident channel supervisor for full-duplex persistent stream connection. */
  supervisor?: AgyProcessSupervisor
  /** Subagent bridge for invoke_subagent dispatch and transcript streaming. */
  subagentBridge?: SubagentBridge
  /** Provider for staged skills directory path (mounted via --add-dir). */
  skillsStagingDir?: () => string | undefined
  /**
   * Resolve the DSH session's working directory. Called with the raw
   * session id; return an absolute path to run agy inside that workspace.
   * Explicit config `workspaceRoot` still wins over this value.
   */
  sessionCwd?: (sessionId: string) => string | undefined
  /** Last-run telemetry surfaced by /agy status. */
  onRun?: (info: { ok: boolean; code: string; durationMs: number; model: string }) => void
  /** Reads image bytes from DSH attachment storage (multimodal staging). */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
  /** Called with each run's parser so the host can keep the last stdout ring for /agy doctor. */
  onParser?: (parser: StreamJsonParser) => void
}

// ---- stream() -------------------------------------------------------------

class ChunkQueue {
  private chunks: StreamChunk[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(ch: StreamChunk): void {
    this.chunks.push(ch)
    this.wake?.()
    this.wake = null
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = null
  }

  async *drain(): AsyncIterable<StreamChunk> {
    for (;;) {
      while (this.chunks.length > 0) {
        const ch = this.chunks.shift()
        if (ch !== undefined) yield ch
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      });
    }
  }
}

function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

function sawAuthFailure(parser: StreamJsonParser, outcome: { stderrTail: string; stdout: string }): boolean {
  if (parser.stats.sawAuthFailure) return true
  return looksLikeAuthFailure(outcome.stderrTail) || looksLikeAuthFailure(outcome.stdout.slice(0, 4000))
}

export class AgyAdapter extends LlmAdapter {
  private readonly warnedKeys = new Set<string>()
  /** sessionKey -> in-flight run, for steer-time preemption. */
  private readonly activeRuns = new Map<string, RunRecording>()
  /** sessionKey -> last seen conversationId for cross-process conversation inheritance */
  private readonly lastConversationIds = new Map<string, string>()
  /** sessionKey -> last seen model for cross-process model switch detection */
  private readonly lastSessionModels = new Map<string, string>()
  /** sessionKey -> prompt info for duplicate submission debounce */
  private readonly activeSessionPrompts = new Map<string, { prompt: string; startedAt: number }>()
  /** accountId -> timestamp of last spawn for spacing throttling */
  private readonly lastAccountSpawnTime = new Map<string, number>()
  private readonly minSpawnIntervalMs = 500
  /** Global sliding window timestamps for batch rate-limiting protection */
  private readonly requestTimestamps: number[] = []

  constructor(private readonly deps: AgyAdapterDeps) {
    super()
  }

  getLastConversationId(sessionKey: string): string | undefined {
    return this.lastConversationIds.get(sessionKey)
  }

  setLastConversationId(sessionKey: string, conversationId: string): void {
    if (sessionKey && conversationId) {
      this.lastConversationIds.set(sessionKey, conversationId)
    }
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warnedKeys.has(key)) return
    this.warnedKeys.add(key)
    this.deps.log?.('WARNING: ' + msg)
  }

  /**
   * Fail fast on auth and abort; allow one retry for transient process
   * failures (timeout, crash, malformed stream) per ADR-11.
   */
  override providerRetryPolicy(_provider: string) {
    return {
      mode: 'normal' as const,
      maxRetries: 1,
      retryableCodes: [Err.TIMEOUT, Err.PROCESS_EXIT, Err.INVALID_OUTPUT],
      initialDelayMs: 2_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER_ID, name: 'Antigravity (agy CLI)' }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    void this.deps.catalog.refreshIfNeeded()
    const cat = this.deps.catalog.get()
    // DSH's llm.listModels rejects a provider catalog containing any
    // duplicate model id or invalid id (INVALID_CATALOG) and the model picker then drops
    // the whole Antigravity group — dedupe and sanitize as a final guard over every
    // catalog source (discovered, fallback, user-configured fallbackModels).
    const seen = new Set<string>()
    const models: LlmModelInfo[] = []
    const dropped: string[] = []
    for (const m of cat.models) {
      if (!m || typeof m.id !== 'string') continue
      const id = m.id.trim()
      if (id === '') continue
      if (seen.has(id)) {
        dropped.push(id)
        continue
      }
      seen.add(id)
      const name = (typeof m.name === 'string' && m.name.trim() !== '') ? m.name.trim() : id
      models.push({
        provider: PROVIDER_ID,
        id,
        name,
        inputModalities: ['text', 'image'] as const,
      })
    }
    if (dropped.length > 0) {
      // Observable on purpose: without this the guard silently masks the
      // catalog duplication that would otherwise remove every Antigravity
      // model from the picker (issue #1).
      this.warnOnce(
        'catalog-dupes',
        'model catalog contained duplicate ids [' + dropped.join(', ') + '] — kept first occurrence so DSH does not drop the whole provider group (INVALID_CATALOG)',
      )
    }
    return models
  }

  override async resolveModel(_provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const cfg = this.deps.getConfig()
    const cat = this.deps.catalog.get()
    const rawModel = typeof model === 'string' ? model.trim() : ''
    const cleanId = rawModel !== '' ? rawModel : cfg.defaultModel
    const entry = findEntry(cat, cleanId)
    const rawName = entry ? entry.name : cleanId
    const name = (typeof rawName === 'string' && rawName.trim() !== '') ? rawName.trim() : cleanId
    const contextWindow = typeof cfg.contextWindowDefault === 'number' && cfg.contextWindowDefault > 0 ? cfg.contextWindowDefault : 200_000
    const resolved: LlmResolvedModelInfo = {
      provider: PROVIDER_ID,
      id: cleanId,
      name,
      inputModalities: ['text', 'image'] as const,
      context: { contextWindow },
      defaultMaxTokens: typeof cfg.maxTokensDefault === 'number' && cfg.maxTokensDefault > 0 ? cfg.maxTokensDefault : 8192,
    }
    if (entry && Array.isArray(entry.efforts) && entry.efforts.length > 0) {
      const cleanEfforts = Array.from(new Set(entry.efforts.filter((e) => typeof e === 'string' && e.trim() !== '')))
      if (cleanEfforts.length > 0) {
        const def = defaultEffortFor({ ...entry, efforts: cleanEfforts }, cfg)
        const validDef = def && cleanEfforts.includes(def) ? def : cleanEfforts[0]
        resolved.reasoning = {
          efforts: cleanEfforts.map((e) => ({ id: e as never, name: e })),
          ...(validDef ? { defaultEffort: validDef as never } : {}),
        }
      }
    }
    return resolved
  }

  /**
   * Bind exact model metadata and dispatch to ONE adapter generation.
   * Required by dsh-llm >= 0.1.1-rc.2: LlmRuntime.prepareCall calls
   * registration.adapter.prepareCall(provider, model, signal) unconditionally,
   * so an adapter compiled against the old base class (no prepareCall) crashed
   * with "registration.adapter.prepareCall is not a function" on new hosts.
   * Implemented explicitly here so both old and new runtimes work: the old
   * runtime never calls it, the new runtime gets the capability-bound handle.
   * Declared without `override`/imported types on purpose: the plugin still
   * typechecks against dsh-llm ^0.1.0-rc.6 (no prepareCall in the base), while
   * the runtime contract matches the 0.1.1-rc.2 PreparedAdapterCall shape
   * { model: LlmResolvedModelInfo; stream(options): AsyncIterable<StreamChunk> }.
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }> {
    const modelInfo = await this.resolveModel(provider, model, signal)
    return {
      model: modelInfo,
      stream: (options) => this.stream(options),
    }
  }

  /** Build the agy argv for one call. Exported for tests. */
  buildArgs(opts: {
    prompt: string
    model: string
    effort?: string
    conversationId?: string
    permissionMode: PluginConfig['permissionMode']
    timeoutMs: number
    extraArgs: readonly string[]
    addDirs?: readonly string[]
    printTimeoutMinutes?: number
  }): string[] {
    const ptMins = opts.printTimeoutMinutes ?? Math.max(1, Math.ceil(opts.timeoutMs / 60_000))
    const args: string[] = ['--output-format', 'stream-json', '--print-timeout', ptMins + 'm']
    if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
    else args.push('--mode', opts.permissionMode)
    const effectiveModel = resolveModelSlug(opts.model)
    if (effectiveModel !== '') args.push('--model', effectiveModel)
    const isGemini = effectiveModel !== '' && effectiveModel.toLowerCase().startsWith('gemini')
    const trimmedEffort = typeof opts.effort === 'string' ? opts.effort.trim() : ''
    if (isGemini && trimmedEffort !== '') args.push('--effort', trimmedEffort)
    if (opts.conversationId) args.push('--conversation', opts.conversationId)
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d)
    args.push(...opts.extraArgs)
    args.push('-p', opts.prompt)
    return args
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cfg = this.deps.getConfig()
    const bin = this.deps.bin()
    if (!bin) throw new LlmError('agy binary not found on PATH — install it via https://antigravity.google/docs/cli/install', Err.AGY_NOT_INSTALLED)
    const isAux = options.purpose === 'compaction' || options.purpose === 'session-title'
    if (isAux && !cfg.allowAuxiliary) {
      throw new LlmError('auxiliary calls are disabled for the antigravity route (allowAuxiliary: false)', Err.AUX_DISABLED)
    }
    const isCodeMode = options.tools ? options.tools.some((t) => t.name === 'run_code') : false
    const sessionKey = options.sessionId !== undefined ? String(options.sessionId) : ''
    // cwd precedence: explicit config > the DSH session's own workspace >
    // the host process cwd. The last fallback can land agy in an UNRELATED
    // directory (wherever the DSH server was started) — with permissionMode
    // 'skip' that is a silent wrong-workspace write path, so log it loudly
    // once per session instead of failing the turn.
    let workspaceRoot = cfg.workspaceRoot
    if (!workspaceRoot || workspaceRoot.trim() === '') {
      const fromSession = sessionKey !== '' ? this.deps.sessionCwd?.(sessionKey) : undefined
      if (fromSession && fromSession.trim() !== '') {
        workspaceRoot = fromSession.trim()
      } else {
        workspaceRoot = process.cwd()
        this.warnOnce(
          'cwd:' + (sessionKey || 'anon'),
          'session workspace unresolved (sessionId=' + (sessionKey || 'none') + ') — running agy in the DSH process cwd: ' + workspaceRoot,
        )
      }
    }
    if (!isAbsolute(workspaceRoot)) {
      workspaceRoot = resolve(workspaceRoot)
    }

    // ---- native tool mirroring: continuation spans (v0.3) ----
    // When the previous span cut on a completed agy tool step, DSH dispatched
    // the agy_tool mirror (which replayed the recorded output) and is now
    // calling us again to continue the SAME run. Resume the recording from
    // the cursor encoded in the trailing tool-result callId — no new process,
    // no prompt assembly, no digest.
    const continuation = detectContinuation(options.messages)
    if (continuation !== null) {
      const rec = this.deps.runs.get(continuation.runId)
      const cursor = continuation.eventIndex + 1
      const isDead = rec !== undefined && (rec.failureInfo !== null || (rec.isSettled && cursor >= rec.length))

      if (isDead || rec === undefined) {
        if (rec !== undefined) {
          this.deps.runs.forget(continuation.runId)
        }
        this.deps.log?.(
          `Tombstone guard: run ${continuation.runId} is ${rec === undefined ? 'absent' : rec.failureInfo !== null ? 'failed' : 'exhausted'} — evicted dead corpse, falling through to clean model turn`,
        )
      } else {
        this.deps.runs.markActive(rec.runId, true)
        let isWaitingForNextTool = false
        try {
          for await (const ch of this.driveSpan(rec, cursor, true, isCodeMode, sessionKey, undefined, workspaceRoot)) {
            if (ch.type === 'finish' && ch.reason.kind === 'tool-calls') {
              isWaitingForNextTool = true
            }
            yield ch
          }
        } finally {
          if (!isWaitingForNextTool) {
            this.deps.runs.markActive(rec.runId, false)
          }
        }
        return
      }
    }
    // Mid-turn steer preemption: DSH claims the steered message at the next
    // step boundary and calls stream() again (a NEW run, not a continuation).
    // The previous run's agy process is still alive and would keep appending
    // to the SAME conversation concurrently — abort it first. Auxiliary calls
    // (compaction/title) neither preempt nor get tracked.
    if (!isAux && sessionKey !== '') {
      const prev = this.activeRuns.get(sessionKey)
      if (prev !== undefined && !prev.isSettled) prev.requestAbort?.()
    }
    const catalog = this.deps.catalog.get()
    const rawModel = options.model
    const model = resolveModelSlug(rawModel)
    const effectiveModel = model !== '' ? model : (cfg.defaultModel ? resolveModelSlug(cfg.defaultModel) : '')
    const entry = findEntry(catalog, effectiveModel !== '' ? effectiveModel : model)
    const isGemini = effectiveModel !== '' && effectiveModel.toLowerCase().startsWith('gemini')

    // Defensive normalization of options.reasoningEffort:
    // null -> explicitly disabled reasoning (do not stringify to "null")
    // undefined -> unprovided
    // string -> trim and lowercase
    let wantedEffort: string | undefined
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== null) {
      const trimmed = String(options.reasoningEffort).trim().toLowerCase()
      if (trimmed !== '' && trimmed !== 'null' && trimmed !== 'undefined' && trimmed !== 'none') {
        wantedEffort = trimmed
      }
    }

    let effort: string | undefined
    if (entry && entry.efforts === null) {
      if (wantedEffort !== undefined) {
        throw new LlmError('model ' + (model || effectiveModel) + ' has no selectable reasoning efforts', Err.UNSUPPORTED_REASONING_EFFORT)
      }
      effort = undefined
    } else if (entry && entry.efforts && entry.efforts.length > 0) {
      if (wantedEffort !== undefined) {
        const matched = entry.efforts.find((e) => e.toLowerCase() === wantedEffort)
        if (!matched) {
          throw new LlmError('reasoning effort ' + wantedEffort + ' is not supported by ' + (model || effectiveModel), Err.UNSUPPORTED_REASONING_EFFORT)
        }
        effort = matched
      } else if (options.reasoningEffort === null) {
        // null explicitly disables reasoning
        effort = undefined
      } else if (isAux) {
        effort = entry.efforts.includes('low') ? 'low' : entry.efforts[0]
      } else {
        effort = defaultEffortFor(entry, cfg) ?? (entry.efforts.includes('high') ? 'high' : entry.efforts[0])
      }
    } else if (!entry) {
      // Unrecognized model in catalog
      if (wantedEffort !== undefined) {
        if (isGemini) {
          effort = wantedEffort
        } else {
          effort = undefined
        }
      } else if (options.reasoningEffort === null) {
        effort = undefined
      } else if (isGemini) {
        if (isAux) {
          effort = 'low'
        } else if (cfg.defaultEffort && cfg.defaultEffort.trim() !== '') {
          effort = cfg.defaultEffort.trim().toLowerCase()
        } else {
          effort = undefined
        }
      } else {
        effort = undefined
      }
    } else {
      effort = undefined
    }

    // ---- prompt assembly (ADR-7) ----
    const messages = options.messages
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const mm = messages[i]
      if (mm !== undefined && mm.role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    const trailingUser = messages.slice(lastAssistantIdx + 1).filter((m) => m.role === 'user')

    // Sliding-window rate limit protection per minute (for overnight batch / /goal stability)
    if (!isAux && cfg.rateLimitPerMinute > 0) {
      const now = Date.now()
      const windowStart = now - 60_000
      while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < windowStart) {
        this.requestTimestamps.shift()
      }
      if (this.requestTimestamps.length >= cfg.rateLimitPerMinute) {
        const delayMs = this.requestTimestamps[0]! + 60_000 - now
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
      this.requestTimestamps.push(Date.now())
    }

    let activeModel = model === '' ? cfg.defaultModel : model
    let family = modelFamilyOf(activeModel)
    let account = this.deps.pool ? this.deps.pool.selectAccount(family) : undefined
    if (this.deps.pool && this.deps.pool.getAccounts().length > 0 && !account) {
      if (cfg.autoFallbackModel) {
        const fallbackSlugs = ['gemini-3.5-flash', 'gemini-3.6-flash']
        for (const fb of fallbackSlugs) {
          const fbFam = modelFamilyOf(fb)
          const fbAcc = this.deps.pool.selectAccount(fbFam)
          if (fbAcc) {
            account = fbAcc
            family = fbFam
            activeModel = fb
            break
          }
        }
      }
      if (!account) {
        const countdown = this.deps.pool.getEarliestResetCountdown(family)
        const waitStr = countdown ? ` (earliest reset in ${Math.ceil(countdown / 1000)}s)` : ''
        throw new LlmError(`All Antigravity accounts in pool are in cooldown for ${family}${waitStr}. Add an account or wait for reset.`, Err.AGY_ERROR)
      }
    }

    const sessionAccountKey = account ? `${sessionKey}:${account.id}` : sessionKey
    let binding = sessionAccountKey !== '' ? this.deps.store.get(sessionAccountKey) : undefined

    // Model switch detection: If model changed in the session, drop stale agy conversation binding
    const currentModel = activeModel === '' ? cfg.defaultModel : activeModel
    const prevModel = binding?.model ?? (sessionKey !== '' ? this.lastSessionModels.get(sessionKey) : undefined)
    if (!isAux && prevModel && prevModel !== currentModel) {
      if (sessionAccountKey !== '') {
        this.deps.store.delete(sessionAccountKey)
        this.deps.supervisor?.deleteConversationId(sessionAccountKey)
      }
      if (sessionKey !== '') {
        this.lastConversationIds.delete(sessionKey)
        this.deps.supervisor?.deleteConversationId(sessionKey)
      }
      binding = undefined
    }
    if (!isAux && sessionKey !== '') {
      this.lastSessionModels.set(sessionKey, currentModel)
    }

    // Compaction detection (ADR-013): If DSH compacted history or cleared earlier turns,
    // messages.length drops below the recorded watermark. Invalidate the stale agy
    // conversation binding so a clean agy session is started and seeded with the compacted summary.
    if (!isAux && binding !== undefined && messages.length < binding.lastMessageCount) {
      if (sessionAccountKey !== '') {
        this.deps.store.delete(sessionAccountKey)
        this.deps.supervisor?.deleteConversationId(sessionAccountKey)
      }
      if (sessionKey !== '') {
        this.lastConversationIds.delete(sessionKey)
        this.deps.supervisor?.deleteConversationId(sessionKey)
      }
      binding = undefined
    }

    let prompt = ''
    if (isAux && options.purpose === 'compaction') {
      const cap = cfg.compactionMaxChars > 0 ? cfg.compactionMaxChars : 800_000
      const parts: string[] = []
      let used = 0
      for (const m of messages) {
        const text = textOf(m)
        if (text === '') continue
        const line = (m.role === 'user' ? 'User: ' : 'Assistant: ') + text
        parts.push(line)
        used += line.length
        if (used > cap) break
      }
      prompt = '[summarize this conversation for context compaction]\n\n' + parts.join('\n\n') + '\n\nProduce a compact summary that preserves decisions, file paths, and open tasks.'
    } else {
      const trailingText = trailingUser.map(textOf).filter((s) => s !== '')
      prompt = trailingText.join('\n\n')
      if (binding === undefined && lastAssistantIdx >= 0) {
        // First contact: bring agy up to speed with a bounded digest.
        prompt = buildDigest(messages, 0, cfg.digestMaxChars) + prompt
      } else if (binding !== undefined) {
        // Returning session: digest only the foreign turns since our
        // watermark (the user may have talked to another model in between).
        // Our own agy replies ride the native conversation history, and the
        // trailing user run is already the live prompt below.
        const from = Math.min(binding.lastMessageCount, messages.length)
        const end = Math.max(from, lastAssistantIdx + 1)
        const span = messages
          .slice(from, end)
          .filter((m) => m.role !== 'assistant' || isForeignAssistant(m))
        if (span.some((m) => m.role === 'assistant')) {
          prompt = buildDigest(span, 0, cfg.digestMaxChars) + prompt
        }
      }
    }

    // ---- multimodal staging (v0.2): images ride as staged files ----
    let stagedDirs: string[] = []
    if (!isAux) {
      const imageRefs: ImageRefLike[] = []
      for (const m of trailingUser) {
        for (const b of (m as { content?: readonly unknown[] }).content ?? []) {
          const blk = b as { type?: string; attachment?: ImageRefLike; attachmentId?: string }
          if (blk && blk.type === 'image') {
            if (blk.attachment && typeof blk.attachment === 'object') {
              imageRefs.push(blk.attachment)
            } else if (typeof blk.attachmentId === 'string') {
              imageRefs.push(blk as unknown as ImageRefLike)
            }
          }
        }
      }
      if (imageRefs.length > 0 && this.deps.readImage) {
        const dir = cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
        const key = (sessionKey !== '' ? sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : 'anon') + '-' + messages.length
        const res = await stageImages({
          dir,
          key,
          images: imageRefs,
          readImage: this.deps.readImage,
          maxImages: cfg.mediaMaxImages,
          maxBytes: cfg.mediaMaxBytes,
        })
        if (res.promptSuffix !== '') {
          prompt = prompt === ''
            ? (res.promptSuffix + '\n\n[Please inspect the attached image(s) using view_file and assist the user.]')
            : (prompt + '\n\n' + res.promptSuffix)
        }
        if (res.staged.length > 0) stagedDirs = [dir]
      }
      if (prompt.trim() === '' && trailingUser.some((m) => m.content?.some((b) => b.type === 'tool-result'))) {
        prompt = '[Tool execution completed]'
      }
      if (prompt.trim() === '') {
        throw new LlmError('request carries no user text or images to forward to agy', Err.AGY_ERROR)
      }
    } else if (prompt.trim() === '') {
      throw new LlmError('request carries no user text to forward to agy', Err.AGY_ERROR)
    }

    const hasForwardedSystem = Boolean(cfg.forwardSystemPrompt && options.system)
    const hasServiceDirective = Boolean(cfg.mcpBridge && !isAux)

    if (hasForwardedSystem && hasServiceDirective) {
      prompt = 'System instructions:\n' + sanitizePromptForAgy(options.system!) + '\n\n' + SYSTEM_BACKGROUND_SERVICE_DIRECTIVE + '\n\n' + prompt
    } else if (hasForwardedSystem) {
      prompt = 'System instructions:\n' + sanitizePromptForAgy(options.system!) + '\n\n' + prompt
    } else if (hasServiceDirective) {
      prompt = 'System instructions:\n' + SYSTEM_BACKGROUND_SERVICE_DIRECTIVE + '\n\n' + prompt
    }

    // In-flight duplicate submission debounce (prevents double-clicks / network repeat loops)
    if (!isAux && sessionKey !== '') {
      const activePrompt = this.activeSessionPrompts.get(sessionKey)
      if (activePrompt !== undefined && activePrompt.prompt === prompt && Date.now() - activePrompt.startedAt < 3000) {
        throw new LlmError(
          'Duplicate request ignored: an identical request is already running for this session.',
          Err.BUSY,
        )
      }
      this.activeSessionPrompts.set(sessionKey, { prompt, startedAt: Date.now() })
    }

    // ---- spawn + record (v0.3: spans consume a shared recording) ----
    const before = snapshotConversations()
    const rec = this.deps.runs.create()
    this.deps.runs.markActive(rec.runId, true)
    const parser = new StreamJsonParser()
    this.deps.onParser?.(parser)
    let streamCid: string | null = null
    const stagedSkillsDir = this.deps.skillsStagingDir?.()
    const allAddDirs = [...stagedDirs]
    if (stagedSkillsDir && !allAddDirs.includes(stagedSkillsDir)) {
      allAddDirs.push(stagedSkillsDir)
    }

    const existingConversationId = !isAux
      ? (binding?.conversationId ?? (sessionKey !== '' ? this.lastConversationIds.get(sessionKey) : undefined))
      : undefined

    const args = this.buildArgs({
      prompt,
      model: activeModel === '' ? cfg.defaultModel : activeModel,
      effort,
      conversationId: existingConversationId,
      permissionMode: isAux ? 'plan' : cfg.permissionMode,
      timeoutMs: cfg.timeoutMs,
      printTimeoutMinutes: Math.max(240, Math.ceil(cfg.timeoutMs / 60_000)),
      extraArgs: cfg.extraArgs,
      addDirs: allAddDirs,
    })

    if (!isAux && existingConversationId && !args.includes('--conversation') && !args.some((a) => a.startsWith('--conversation='))) {
      const pIdx = args.indexOf('-p')
      if (pIdx >= 0) {
        args.splice(pIdx, 0, '--conversation', existingConversationId)
      } else {
        args.push('--conversation', existingConversationId)
      }
    }
    const release = await this.deps.acquire()
    let released = false
    const releaseOnce = (): void => {
      if (released) return
      released = true
      release()
    }
    // Only SECONDARY pool accounts get an isolated HOME. The primary
    // account rides the real system HOME (agy 1.1.15 keeps credentials in
    // the macOS Keychain); injecting HOME there signs agy out ("Please
    // sign in") and every turn fails with an auth error.
    const env = {
      ...process.env,
      ...(cfg.disableTelemetry
        ? {
            DO_NOT_TRACK: '1',
            DISABLE_TELEMETRY: '1',
            GOOGLE_CLOUD_DISABLE_TELEMETRY: '1',
            ANTIGRAVITY_DISABLE_TELEMETRY: '1',
          }
        : {}),
      ...(account && account.dir ? isolatedHomeEnv(account.dir) : {}),
      ...(account?.proxyUrl
        ? {
            ALL_PROXY: account.proxyUrl,
            HTTPS_PROXY: account.proxyUrl,
            HTTP_PROXY: account.proxyUrl,
            all_proxy: account.proxyUrl,
            https_proxy: account.proxyUrl,
            http_proxy: account.proxyUrl,
          }
        : {}),
    }

    // Per-account burst spacing throttle with randomized jitter (prevents high-frequency flood to Google endpoints)
    if (account) {
      const lastSpawn = this.lastAccountSpawnTime.get(account.id) ?? 0
      const elapsed = Date.now() - lastSpawn
      const jitter = Math.floor(Math.random() * 300) // 100~400ms organic jitter
      const targetInterval = this.minSpawnIntervalMs + jitter
      if (elapsed < targetInterval) {
        await new Promise((r) => setTimeout(r, targetInterval - elapsed))
      }
      this.lastAccountSpawnTime.set(account.id, Date.now())
    }

    let proc: ReturnType<typeof startAgyProcess> | undefined
    let residentOutcome: Promise<RunOutcome> | undefined
    try {
      if (this.deps.supervisor && !isAux) {
        residentOutcome = this.deps.supervisor.runTurn(
          sessionAccountKey !== '' ? sessionAccountKey : workspaceRoot,
          {
            bin,
            args,
            cwd: workspaceRoot,
            env,
            log: this.deps.log,
          },
          {
            prompt,
            recording: rec,
            signal: options.signal,
            parser,
            onInit: (cid) => {
              streamCid = cid
              if (sessionKey !== '' && cid) {
                this.lastConversationIds.set(sessionKey, cid)
              }
            },
          },
        )
      } else {
        proc = startAgyProcess({
          bin,
          args,
          cwd: workspaceRoot,
          signal: options.signal,
          env,
          onLine: (line) => {
            for (const ev of parser.feed(line + '\n')) {
              if (ev.kind === 'init' && ev.conversationId) {
                streamCid = ev.conversationId
                if (sessionKey !== '') this.lastConversationIds.set(sessionKey, ev.conversationId)
              }
              if (ev.kind === 'result' && ev.conversationId !== '') {
                streamCid = ev.conversationId
                if (sessionKey !== '') this.lastConversationIds.set(sessionKey, ev.conversationId)
              }
              rec.append(ev)
            }
          },
        })
      }
      if (!isAux && sessionKey !== '') {
        if (proc) {
          rec.requestAbort = () => proc?.kill('abort')
        }
        this.activeRuns.set(sessionKey, rec)
      } else if (proc) {
        rec.requestAbort = () => proc?.kill('abort')
      }
    } catch (e) {
      releaseOnce()
      throw new LlmError('failed to spawn agy: ' + brief(String(e)), Err.PROCESS_EXIT)
    }

    void (async () => {
      let outcome: RunOutcome
      try {
        outcome = await (residentOutcome ?? proc!.outcome)
      } catch (e) {
        releaseOnce()
        if (this.activeRuns.get(sessionKey) === rec) this.activeRuns.delete(sessionKey)
        if (!isAux && sessionKey !== '') this.activeSessionPrompts.delete(sessionKey)
        rec.settle({
          kind: 'error',
          code: Err.PROCESS_EXIT,
          message: 'resident agy channel error: ' + brief(String(e)),
        })
        return
      }
      releaseOnce()
      if (this.activeRuns.get(sessionKey) === rec) this.activeRuns.delete(sessionKey)
      if (!isAux && sessionKey !== '') this.activeSessionPrompts.delete(sessionKey)
      for (const ev of parser.flush()) {
        if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
        rec.append(ev)
      }
      if (!streamCid) {
        for (let i = rec.length - 1; i >= 0; i--) {
          const ev = rec.eventAt(i)
          if (ev && (ev.kind === 'result' || ev.kind === 'init') && ev.conversationId) {
            streamCid = ev.conversationId
            break
          }
        }
      }
      const diffed = diffConversations(before).conversationId
      const conversationId = streamCid ?? diffed
      if (sessionKey !== '' && conversationId) {
        this.lastConversationIds.set(sessionKey, conversationId)
      }
      // A result envelope the mapper will finish on: ok, or an error that
      // still carries a usable response. Anything else leaves the live span
      // un-finished, so the failure below reaches it through the recording.
      const r = rec.getResultEvent()
      const consumable = r !== null && (r.ok || r.response !== '')
      // Error classification scans ONLY stderr and the result envelope's
      // error field. stdout is model prose + event JSON: a run whose streamed
      // text merely MENTIONED "rate limit"/"quota" (or contained a hash with
      // "429") used to be misclassified as a quota failure, masking the real
      // error and slapping a ghost cooldown on a healthy account.
      const rawErrText = [outcome.stderrTail, parser.stats.lastResultError].filter(Boolean).join(' ')
      const isRateLimit = looksLikeRateLimit(rawErrText)
      let failure: { kind: 'error' | 'aborted'; code: string; message: string } | null = null
      if (outcome.aborted) {
        failure = { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' }
      } else if (sawAuthFailure(parser, outcome)) {
        failure = { kind: 'error', code: Err.AUTH, message: 'agy is not signed in — run /agy auth (or run agy once in a terminal) to login' }
      } else if (isRateLimit) {
        const bestMsg = parser.stats.lastResultError || (outcome.stderrTail ? brief(outcome.stderrTail) : 'Rate limit or quota reached')
        failure = { kind: 'error', code: Err.AGY_ERROR, message: 'Google Antigravity quota / rate limit reached: ' + bestMsg }
      } else if (!consumable) {
        if (outcome.code !== 0) {
          // agy reports its failure on STDOUT as a result envelope and often
          // exits 1 with EMPTY stderr; dropping the envelope here used to
          // leave users with a bare "agy exited with code 1" and no cause.
          // Prefer the envelope's error text, then the stderr tail.
          const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : '')
          failure = { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + outcome.code + (detail !== '' ? ': ' + detail : '') }
        } else if (parser.stats.lastResultError) {
          failure = { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + parser.stats.lastResultError }
        } else {
          failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + parser.stats.garbage + ' unparseable lines)' }
        }
      }
      rec.settle(failure)
      if (failure !== null) {
        this.deps.runs.markActive(rec.runId, false)
      } else {
        // If settled without failure, check if any completed tool step exists in rec
        let hasTool = false
        for (let i = 0; i < rec.length; i++) {
          const ev = rec.eventAt(i)
          if (ev?.kind === 'step' && ev.stepKind === 'tool' && ev.tool && (ev.tool.output !== undefined || ev.tool.error !== undefined)) {
            hasTool = true
            break
          }
        }
        if (!hasTool) {
          this.deps.runs.markActive(rec.runId, false)
        }
      }
      if (failure === null) {
        if (account) this.deps.pool?.recordSuccess(account.id, family)
        if (!isAux && sessionAccountKey !== '') {
          const finalId = binding !== undefined ? binding.conversationId : conversationId
          if (finalId) {
            if (sessionKey !== '') this.lastConversationIds.set(sessionKey, finalId)
            this.deps.store.set(sessionAccountKey, {
              conversationId: finalId,
              lastMessageCount: messages.length,
              updatedAt: Date.now(),
              model: activeModel,
            })
          }
        }
      } else {
        const effectiveRateLimit = isRateLimit || looksLikeRateLimit(failure.message)
        // Cooldown is a costly local penalty (account leaves rotation): only
        // HARD server-issued signatures may trigger it. Soft signals (model
        // overloaded) shape the message above but never cool the account.
        if (account && looksLikeHardRateLimit(rawErrText)) {
          this.deps.pool?.recordFailure(account.id, family, failure.message)
        }
        if (account && (failure.code === Err.AUTH || /invalid_grant|not signed in|auth/i.test(failure.message))) {
          this.deps.pool?.markAuthRequired(account.id, failure.message)
        }
        if (!isAux && sessionAccountKey !== '') {
          if (
            failure.code === Err.AUTH ||
            effectiveRateLimit ||
            (failure.message && /conversation.*(not found|invalid|not recognized|expired|does not exist)|session.*(expired|invalid)/i.test(failure.message))
          ) {
            // If auth expired or rate limit hit or conversation rejected, drop stale binding
            this.deps.store.delete(sessionAccountKey)
            if (sessionKey !== '') this.lastConversationIds.delete(sessionKey)
            this.deps.supervisor?.deleteConversationId(sessionAccountKey)
            if (sessionKey !== '') this.deps.supervisor?.deleteConversationId(sessionKey)
          }
        }
      }
      this.deps.onRun?.({
        ok: failure === null,
        code: failure !== null ? failure.code : 'OK',
        durationMs: outcome.durationMs,
        model,
      })
    })().catch((err) => {
      releaseOnce()
      rec.settle({ kind: 'error', code: Err.PROCESS_EXIT, message: 'internal error: ' + brief(String(err)) })
      this.deps.runs.markActive(rec.runId, false)
    })

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it).
    let isWaitingForTool = false
    try {
      for await (const ch of this.driveSpan(rec, 0, !isAux, isCodeMode, sessionKey, account?.dir, workspaceRoot)) {
        if (ch.type === 'finish' && ch.reason.kind === 'tool-calls') {
          isWaitingForTool = true
        }
        yield ch
      }
    } finally {
      if (!isWaitingForTool) {
        this.deps.runs.markActive(rec.runId, false)
      }
    }
  }

  /**
   * Stream one span of a recording: map events from `from` until the mapper
   * finishes (tool-calls cut or result stop), then let the queue drain. When
   * the recording settles without a consumable result, surface its failure
   * as this span's terminal chunk — the turn ends exactly like a native
   * provider error.
   */
  private async *driveSpan(
    rec: RunRecording,
    from: number,
    cutOnTool: boolean,
    useCodeWrapper: boolean,
    parentSessionId?: string,
    accountHome?: string,
    cwd?: string,
  ): AsyncIterable<StreamChunk> {
    const rawCwd = (cwd && cwd.trim() !== '') ? cwd.trim() : process.cwd()
    const safeCwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
    const queue = new ChunkQueue()
    void (async () => {
      const mapper = new EventMapper({
        runId: rec.runId,
        cutOnTool,
        initialSawText: rec.sawTextBefore(from),
        useCodeWrapper,
        usage: rec,
        subagentBridge: this.deps.subagentBridge,
        parentSessionId: parentSessionId !== '' ? parentSessionId : undefined,
        accountHome,
        cwd: safeCwd,
      })

      const heartbeat = new Heartbeat({
        intervalMs: 3000,
        onBeat: (elapsedSeconds) => {
          for (const ch of mapper.emitHeartbeat(elapsedSeconds)) {
            queue.push(ch)
          }
        },
      })
      heartbeat.start()

      let i = from
      try {
        for await (const ev of rec.eventsFrom(from)) {
          heartbeat.stop()
          for (const ch of mapper.map(ev, i)) queue.push(ch)
          i++
          if (mapper.isFinished) break
        }
        if (!mapper.isFinished) {
          const f = rec.failureInfo
          if (f !== null) {
            for (const ch of mapper.emitFailure(f.kind, f.code, f.message)) queue.push(ch)
          } else {
            for (const ch of mapper.emitFailure('error', Err.INVALID_OUTPUT, 'agy stream ended without a result event')) queue.push(ch)
          }
        }
      } catch (err) {
        for (const ch of mapper.emitFailure('error', Err.PROCESS_EXIT, 'internal error: ' + brief(String(err)))) queue.push(ch)
      } finally {
        heartbeat.stop()
      }
      queue.close()
    })()
    yield* queue.drain()
  }
}

/**
 * Detect a continuation span: the request's LAST message is the tool result
 * of one of our mirrored agy tool calls. Its callId encodes the recording
 * run and the event index to resume after.
 */
export function detectContinuation(messages: readonly Message[]): { runId: string; eventIndex: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== 'user') return null
    const src = (m as unknown as { source?: { kind?: string; callId?: string } }).source
    if (src?.kind === 'plugin') continue
    if (src?.kind === 'tool' && typeof src.callId === 'string') {
      return parseMirrorCallId(src.callId)
    }
    return null
  }
  return null
}
