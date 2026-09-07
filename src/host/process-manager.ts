import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, promises as fsPromises } from 'node:fs'
import { join, basename } from 'node:path'
import os, { tmpdir } from 'node:os'
import { isCmdShim, isProcessAlive, windowsQuote } from './runner.ts'
import { writeJsonFileAtomic } from './mcp-bridge.ts'

export interface ManagedProcessRecord {
  id: string
  command: string
  args: string[]
  cwd: string
  pid: number
  pgid?: number
  startedAt: number
  logPath: string
  status: 'running' | 'stopped' | 'crashed'
  exitCode?: number | null
}

export interface RegistryData {
  services: Record<string, ManagedProcessRecord>
}

export interface StartProcessOptions {
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  readyPattern?: string
  readyTimeoutMs?: number
}

export interface StopProcessOptions {
  signal?: NodeJS.Signals | string
  timeoutMs?: number
}

export interface ProcessManagerOptions {
  /** Base isolation directory for registry and service logs. Defaults to OS tmpdir with UID. */
  baseDir?: string
  log?: (msg: string) => void
  graceMs?: number
}

export interface StartResult extends ManagedProcessRecord {
  ready?: boolean
}

export const VALID_SERVICE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/

export function assertValidServiceId(id: string): void {
  if (!VALID_SERVICE_ID_REGEX.test(id)) {
    throw new Error(`Invalid service id "${id}": must match /^[a-zA-Z0-9_-]{1,64}$/`)
  }
}

export const DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024 // 2MB backtrack limit

/**
 * Returns the default isolated directory for background services:
 * e.g. /tmp/dsh-agy-link-<uid>/services (POSIX) or %TEMP%\dsh-agy-link-<username>\services (Win).
 */
export function getDefaultServiceDir(): string {
  const uid = typeof process.getuid === 'function'
    ? String(process.getuid())
    : (process.env.USER || process.env.USERNAME || 'default')
  return join(tmpdir(), `dsh-agy-link-${uid}`, 'services')
}

/**
 * Read the last `maxLines` from a file asynchronously without reading the full file.
 * Bounds backtracking to maxBytesToRead (default 2MB) to prevent OOM when logs contain continuous `\r`.
 */
export async function readTailLines(
  filePath: string,
  maxLines = 100,
  maxBytesToRead = DEFAULT_MAX_TAIL_BYTES,
): Promise<string> {
  if (!existsSync(filePath)) return ''
  let handle: fsPromises.FileHandle | null = null
  try {
    handle = await fsPromises.open(filePath, 'r')
    const stat = await handle.stat()
    const fileSize = stat.size
    if (fileSize === 0) return ''

    const chunkSize = 16 * 1024
    let position = fileSize
    let linesFound = 0
    let totalBytesRead = 0
    const chunks: Buffer[] = []

    while (position > 0 && linesFound <= maxLines && totalBytesRead < maxBytesToRead) {
      const remainingBytes = maxBytesToRead - totalBytesRead
      const readSize = Math.min(chunkSize, position, remainingBytes)
      position -= readSize
      const buf = Buffer.alloc(readSize)
      const { bytesRead } = await handle.read(buf, 0, readSize, position)
      if (bytesRead <= 0) break
      const slice = bytesRead < readSize ? buf.subarray(0, bytesRead) : buf
      chunks.unshift(slice)
      totalBytesRead += bytesRead

      for (let i = bytesRead - 1; i >= 0; i--) {
        if (slice[i] === 0x0a) {
          linesFound++
        }
      }
    }

    const fullBuffer = Buffer.concat(chunks)
    const text = fullBuffer.toString('utf8')
    const allLines = text.split('\n')
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop()
    }
    const relevant = allLines.length > maxLines ? allLines.slice(-maxLines) : allLines
    return relevant.join('\n')
  } catch {
    return ''
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * Read newly appended logs since startOffset, bounded by maxBytes to avoid OOM.
 */
export async function readNewLogs(
  filePath: string,
  startOffset: number,
  maxBytes = DEFAULT_MAX_TAIL_BYTES,
): Promise<string> {
  if (!existsSync(filePath)) return ''
  let handle: fsPromises.FileHandle | null = null
  try {
    handle = await fsPromises.open(filePath, 'r')
    const stat = await handle.stat()
    const fileSize = stat.size
    if (fileSize <= startOffset) return ''

    const available = fileSize - startOffset
    const bytesToRead = Math.min(available, maxBytes)
    const readPosition = fileSize - bytesToRead
    const buf = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buf, 0, bytesToRead, readPosition)
    if (bytesRead <= 0) return ''
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/**
 * Verify on Linux that /proc/<pid>/cmdline matches the expected core command name.
 * On non-Linux platforms, returns true.
 */
export function verifyProcessCommand(pid: number, command: string): boolean {
  if (process.platform !== 'linux') {
    return true
  }
  if (typeof pid !== 'number' || pid <= 1) {
    return false
  }
  try {
    const cmdlinePath = `/proc/${pid}/cmdline`
    if (!existsSync(cmdlinePath)) {
      return false
    }
    const raw = readFileSync(cmdlinePath, 'utf8')
    if (!raw || raw.length === 0) {
      return false
    }
    const cleanCmd = command.replace(/^["']|["']$/g, '')
    const baseName = basename(cleanCmd).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
    if (!baseName) return false
    const cmdlineClean = raw.replace(/\0/g, ' ').toLowerCase()
    return cmdlineClean.includes(baseName)
  } catch {
    return false
  }
}

/**
 * Terminate a process group across platforms:
 * - POSIX: process.kill(-pgid, signal)
 * - Windows: taskkill /pid <PID> /T /F
 */
export async function killProcessGroup(
  pid: number,
  signal: NodeJS.Signals | number = 'SIGTERM',
  graceMs = 1000,
): Promise<boolean> {
  if (typeof pid !== 'number' || pid <= 1) return true
  if (!isProcessAlive(pid)) return true

  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      try { process.kill(pid, signal) } catch {}
    }
    return !isProcessAlive(pid)
  }

  // POSIX: detached: true sets the child as leader of a new process group, so pgid === pid.
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }

  if (!isProcessAlive(pid)) return true

  // Grace period poll
  const start = Date.now()
  while (Date.now() - start < graceMs) {
    await new Promise((r) => setTimeout(r, 50))
    if (!isProcessAlive(pid)) return true
  }

  // Escalate to SIGKILL
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }

  const killStart = Date.now()
  while (Date.now() - killStart < 500) {
    await new Promise((r) => setTimeout(r, 50))
    if (!isProcessAlive(pid)) return true
  }

  return !isProcessAlive(pid)
}

/**
 * Poll logs for ready pattern until timeout or process death.
 * Evaluates only content appended after startOffset to avoid false ready hits from past logs.
 */
async function waitForReadyPattern(
  logPath: string,
  pid: number,
  regex: RegExp,
  timeoutMs: number,
  startOffset = 0,
): Promise<{ ready: boolean; error?: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      const tail = await readTailLines(logPath, 20)
      return {
        ready: false,
        error: `Process ${pid} exited prematurely while waiting for readyPattern "${regex.source}". Log tail:\n${tail}`,
      }
    }
    const newLogs = await readNewLogs(logPath, startOffset)
    if (regex.test(newLogs)) {
      return { ready: true }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { ready: false }
}

export class ProcessManager {
  readonly baseDir: string
  readonly logsDir: string
  readonly registryPath: string
  private readonly log: (msg: string) => void
  private readonly graceMs: number
  private readonly services = new Map<string, ManagedProcessRecord>()
  private readonly activeChildren = new Map<string, ChildProcess>()

  constructor(options?: ProcessManagerOptions) {
    this.baseDir = options?.baseDir ?? getDefaultServiceDir()
    this.logsDir = join(this.baseDir, 'logs')
    this.registryPath = join(this.baseDir, 'registry.json')
    this.log = options?.log ?? (() => {})
    this.graceMs = options?.graceMs ?? 1000

    mkdirSync(this.logsDir, { recursive: true })
    this.loadRegistry()
  }

  private isServiceAlive(rec: ManagedProcessRecord): boolean {
    if (typeof rec.pid !== 'number' || rec.pid <= 1) return false
    if (Date.now() - os.uptime() * 1000 > rec.startedAt) return false
    if (!isProcessAlive(rec.pid)) return false
    if (!verifyProcessCommand(rec.pid, rec.command)) return false
    return true
  }

  private loadRegistry(): void {
    if (!existsSync(this.registryPath)) return
    try {
      const raw = readFileSync(this.registryPath, 'utf8')
      const data = JSON.parse(raw) as RegistryData
      if (data && typeof data === 'object' && data.services && typeof data.services === 'object') {
        for (const [id, rec] of Object.entries(data.services)) {
          if (VALID_SERVICE_ID_REGEX.test(id)) {
            this.services.set(id, rec)
          }
        }
      }
    } catch (e) {
      this.log('failed to load registry.json: ' + String(e))
    }
  }

  private persistRegistry(): void {
    const data: RegistryData = {
      services: Object.fromEntries(this.services.entries()),
    }
    try {
      writeJsonFileAtomic(this.registryPath, data)
    } catch (e) {
      this.log('failed to write registry.json: ' + String(e))
    }
  }

  /**
   * Clean orphan processes left behind by prior crashes.
   * Defensively checks reboot boundary and command identity before sending signals.
   * Unconditionally writes updated registry.json to disk.
   */
  async cleanOrphanProcesses(): Promise<number> {
    let cleaned = 0
    for (const [id, rec] of this.services.entries()) {
      if (rec.status === 'running') {
        const isDeadBeforeReboot = Date.now() - os.uptime() * 1000 > rec.startedAt
        if (!isDeadBeforeReboot && isProcessAlive(rec.pid) && verifyProcessCommand(rec.pid, rec.command)) {
          this.log(`cleaning orphaned background service "${id}" (PID ${rec.pid})`)
          await killProcessGroup(rec.pid, 'SIGTERM', this.graceMs)
          cleaned++
        }
        rec.status = 'stopped'
      }
    }
    this.persistRegistry()
    return cleaned
  }

  /**
   * Start a long-running background process.
   */
  async start(options: StartProcessOptions): Promise<StartResult> {
    const id = options.id.trim()
    const command = options.command.trim()
    if (!id) throw new Error('Missing service id')
    assertValidServiceId(id)
    if (!command) throw new Error('Missing service command')

    // Syntax pre-check on readyPattern before spawn to prevent orphan process leak
    let readyRegex: RegExp | undefined
    if (options.readyPattern) {
      try {
        readyRegex = new RegExp(options.readyPattern)
      } catch (err) {
        throw new Error(
          `Invalid readyPattern "${options.readyPattern}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // Check existing
    const existing = this.services.get(id)
    if (existing && existing.status === 'running' && this.isServiceAlive(existing)) {
      throw new Error(`Service "${id}" is already running with PID ${existing.pid}`)
    }

    const logPath = join(this.logsDir, `${id}.log`)
    // Record log file cursor before spawn so readyPattern only matches newly appended logs
    const startOffset = existsSync(logPath) ? statSync(logPath).size : 0

    const logFd = openSync(logPath, 'a')
    let child: ChildProcess
    try {
      const isWin = process.platform === 'win32'
      const viaCmd = isWin && isCmdShim(command)
      if (viaCmd) {
        const comSpec = process.env.ComSpec || 'cmd.exe'
        const fullCmd = [command, ...(options.args ?? [])].map(windowsQuote).join(' ')
        child = spawn(comSpec, ['/d', '/s', '/c', fullCmd], {
          cwd: options.cwd || process.cwd(),
          env: { ...process.env, ...(options.env ?? {}) },
          detached: true,
          stdio: ['ignore', logFd, logFd],
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
      } else {
        child = spawn(command, options.args ?? [], {
          cwd: options.cwd || process.cwd(),
          env: { ...process.env, ...(options.env ?? {}) },
          detached: true,
          stdio: ['ignore', logFd, logFd],
          windowsHide: isWin,
        })
      }
    } finally {
      try {
        closeSync(logFd)
      } catch {}
    }

    const pid = child.pid
    if (typeof pid !== 'number' || pid <= 1) {
      throw new Error(`Failed to spawn background service "${id}": invalid PID`)
    }

    let spawnError: Error | null = null
    child.on('error', (err) => {
      spawnError = err
    })
    child.unref()

    const record: ManagedProcessRecord = {
      id,
      command,
      args: options.args ?? [],
      cwd: options.cwd || process.cwd(),
      pid,
      pgid: pid,
      startedAt: Date.now(),
      logPath,
      status: 'running',
    }

    child.once('exit', (code) => {
      this.activeChildren.delete(id)
      const current = this.services.get(id)
      if (current && current.pid === pid) {
        current.status = code === 0 ? 'stopped' : 'crashed'
        current.exitCode = code
        this.persistRegistry()
      }
    })

    this.services.set(id, record)
    this.activeChildren.set(id, child)

    let ready = true
    if (readyRegex) {
      const readyTimeoutMs = options.readyTimeoutMs ?? 10_000
      const readyRes = await waitForReadyPattern(logPath, pid, readyRegex, readyTimeoutMs, startOffset)
      if (readyRes.error) {
        record.status = 'crashed'
        this.persistRegistry()
        throw new Error(readyRes.error)
      }
      ready = readyRes.ready
    } else {
      // Brief check for immediate spawn failures (e.g. command not found)
      await new Promise((r) => setTimeout(r, 60))
      if (spawnError) {
        record.status = 'crashed'
        this.persistRegistry()
        throw spawnError
      }
      if (!isProcessAlive(pid)) {
        record.status = 'crashed'
        this.persistRegistry()
        const tail = await readTailLines(logPath, 20)
        throw new Error(`Service "${id}" exited immediately after start. Log tail:\n${tail}`)
      }
    }

    this.persistRegistry()
    return { ...record, ready }
  }

  /**
   * Stop a running service.
   */
  async stop(id: string, options?: StopProcessOptions): Promise<ManagedProcessRecord> {
    const trimmedId = id.trim()
    assertValidServiceId(trimmedId)
    const record = this.services.get(trimmedId)
    if (!record) {
      throw new Error(`Service "${trimmedId}" not found`)
    }

    const isDeadBeforeReboot = Date.now() - os.uptime() * 1000 > record.startedAt
    if (!isDeadBeforeReboot && isProcessAlive(record.pid) && verifyProcessCommand(record.pid, record.command)) {
      await killProcessGroup(
        record.pid,
        (options?.signal as NodeJS.Signals) ?? 'SIGTERM',
        options?.timeoutMs ?? this.graceMs,
      )
    }

    this.activeChildren.delete(trimmedId)
    record.status = 'stopped'
    this.persistRegistry()
    return record
  }

  /**
   * Get status of a single service.
   */
  async status(id: string): Promise<ManagedProcessRecord | null> {
    const trimmedId = id.trim()
    assertValidServiceId(trimmedId)
    const record = this.services.get(trimmedId)
    if (!record) return null

    if (record.status === 'running' && !this.isServiceAlive(record)) {
      record.status = 'stopped'
      this.persistRegistry()
    }
    return { ...record }
  }

  /**
   * List status of all known services.
   */
  async listStatus(): Promise<ManagedProcessRecord[]> {
    let changed = false
    const results: ManagedProcessRecord[] = []
    for (const record of this.services.values()) {
      if (record.status === 'running' && !this.isServiceAlive(record)) {
        record.status = 'stopped'
        changed = true
      }
      results.push({ ...record })
    }
    if (changed) {
      this.persistRegistry()
    }
    return results
  }

  /**
   * Read the last lines from a service log.
   */
  async getLogs(id: string, lines = 100): Promise<string> {
    const trimmedId = id.trim()
    assertValidServiceId(trimmedId)
    const record = this.services.get(trimmedId)
    const logPath = record?.logPath ?? join(this.logsDir, `${trimmedId}.log`)
    if (!existsSync(logPath)) {
      if (!record) throw new Error(`Service "${trimmedId}" not found`)
      return ''
    }
    return readTailLines(logPath, lines)
  }

  /**
   * Gracefully stop all active background services.
   */
  async dispose(): Promise<void> {
    const bootTime = Date.now() - os.uptime() * 1000
    for (const [id, record] of this.services.entries()) {
      const isDeadBeforeReboot = bootTime > record.startedAt
      if (
        record.status === 'running' &&
        !isDeadBeforeReboot &&
        isProcessAlive(record.pid) &&
        verifyProcessCommand(record.pid, record.command)
      ) {
        this.log(`stopping background service "${id}" (PID ${record.pid})`)
        try {
          await killProcessGroup(record.pid, 'SIGTERM', this.graceMs)
        } catch {}
      }
      record.status = 'stopped'
    }
    this.activeChildren.clear()
    this.persistRegistry()
  }
}
