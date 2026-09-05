// Subagent bridge for Antigravity (agy CLI).
// Captures agy's invoke_subagent tool calls, emits subagent/start and subagent/end
// lifecycle events to DSH context, and streams incremental transcript.jsonl steps
// to DSH UI for real-time subagent card and step rendering.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export interface SubagentEventEmitter {
  emit(event: string, ...args: unknown[]): void
}

export interface SubagentStartInfo {
  runId: string
  provider: string
  id: string
  local: boolean
  task?: string
  description?: string
  subagentType?: string
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
 * Manages active subagents dispatched by agy and streams their transcripts.
 */
export class SubagentBridge {
  private readonly activeSubagents = new Map<string, SubagentSession>()

  constructor(
    private readonly emitter?: SubagentEventEmitter,
    private readonly log?: (msg: string) => void,
  ) {}

  /**
   * Start a subagent session when agy calls invoke_subagent.
   * Emits subagent/start and tails the subagent's transcript.jsonl.
   */
  startSubagent(opts: {
    toolName: string
    toolArgs?: unknown
    accountHome?: string
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

    const startPayload: SubagentStartInfo = {
      runId,
      provider: 'antigravity',
      id: subagentId,
      local: true,
      task,
      description,
      subagentType,
    }

    this.log?.(`Subagent started: [${subagentType}] ${description} (runId=${runId})`)
    this.emitter?.emit('subagent/start', startPayload)

    // Poll / tail transcript.jsonl from agy's brain directory
    const brainDir = defaultBrainDir(opts.accountHome)
    let transcriptFile: string | null = null
    let fileOffset = 0
    let stopped = false
    let pollTimer: NodeJS.Timeout | null = null

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
          // Find newest brain directory modified around or after subagent start
          .sort((a, b) => b.mtime - a.mtime)

        for (const candidate of dirs) {
          if (candidate.mtime < startedAt - 1000) {
            // Historic run directory before this subagent started — skip to avoid binding stale logs
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
      }
    }

    // Start polling for transcript lines
    pollTimer = setTimeout(poll, 50)

    const session: SubagentSession = {
      runId,
      subagentId,
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
                } catch {}
              }
            }
          }
        } catch {}

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
