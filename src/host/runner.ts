// Process runner (spec ADR-3): every request spawns a short-lived
// `agy -p` process as its own process group; abort and watchdog kill the
// whole tree (agy re-spawns exec children). stderr is captured as a tail
// for error attribution; stdout is streamed line-by-line to the caller.
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { PluginConfig } from '../common/types.ts'
import type { RunRecording } from './recording.ts'
import { StreamJsonParser } from './parser.ts'

const IS_WIN = process.platform === 'win32'

/** Executable candidates for one PATH entry, per-platform. Exported for tests. */
export function binCandidates(dir: string, platform: string = process.platform): string[] {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  return exts.map((e) => join(dir, 'agy' + e))
}

/** True when the resolved bin is a Windows cmd shim (needs shell wrapping). */
export function isCmdShim(bin: string): boolean {
  return /\.(cmd|bat)$/i.test(bin)
}

/** cmd.exe argument quoting (cross-spawn rules). Exported for tests. */
export function windowsQuote(arg: string): string {
  if (/[ \t\n\v"]/.test(arg) === false) return arg
  let escaped = arg.replace(/(\\+)\"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
  escaped = '"' + escaped.replace(/"/g, '\\"') + '"'
  return escaped
}

/**
 * Environment that relocates the agy home directory for account isolation.
 * On Unix, HOME suffices. On Windows, libuv (Node) and Go both resolve the
 * home directory from USERPROFILE / HOMEDRIVE+HOMEPATH and IGNORE $HOME, so
 * omitting them silently breaks account isolation (every account would share
 * the real user profile). GEMINI_CLI_HOME is honored by the agy CLI on all
 * platforms for its .gemini dir.
 */
export function isolatedHomeEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: dir,
    GEMINI_CLI_HOME: join(dir, '.gemini'),
  }
  if (IS_WIN) {
    env.USERPROFILE = dir
    const m = dir.match(/^([A-Za-z]:)(.*)$/)
    if (m) {
      env.HOMEDRIVE = m[1] as string
      env.HOMEPATH = m[2] as string
    }
  }
  return env
}

export const MIN_AGY_VERSION = '1.1.8'

export function resolveAgyBin(cfg: PluginConfig): string | null {
  const candidates: string[] = [];
  if (cfg.agyBin !== '') candidates.push(cfg.agyBin);
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir !== '') candidates.push(...binCandidates(dir))
  }
  // Per-platform default install locations (GUI apps lack user shell PATH).
  const home = homedir()
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? ''
    const appData = process.env.APPDATA ?? ''
    if (local !== '') {
      candidates.push(join(local, 'Programs', 'agy', 'agy.exe'))
      candidates.push(join(local, 'pnpm', 'agy.cmd'))
      candidates.push(join(local, 'pnpm', 'agy.exe'))
    }
    if (appData !== '') {
      candidates.push(join(appData, 'npm', 'agy.cmd'))
      candidates.push(join(appData, 'Roaming', 'npm', 'agy.cmd'))
    }
    candidates.push(join(home, '.local', 'bin', 'agy.exe'))
    candidates.push(join(home, '.local', 'bin', 'agy.cmd'))
    candidates.push(join(home, '.bun', 'bin', 'agy.exe'))
    candidates.push(join(home, '.cargo', 'bin', 'agy.exe'))
    candidates.push(join(home, 'scoop', 'shims', 'agy.exe'))
  } else {
    // macOS / Linux standard system and package manager paths
    candidates.push(join(home, '.local', 'bin', 'agy'))
    candidates.push('/usr/local/bin/agy')
    candidates.push('/opt/homebrew/bin/agy')
    candidates.push('/opt/homebrew/sbin/agy')
    candidates.push('/home/linuxbrew/.linuxbrew/bin/agy')
    candidates.push(join(home, '.bun', 'bin', 'agy'))
    candidates.push(join(home, '.cargo', 'bin', 'agy'))
    candidates.push(join(home, '.local', 'share', 'pnpm', 'agy'))
    candidates.push(join(home, 'Library', 'pnpm', 'agy'))
    candidates.push(join(home, '.yarn', 'bin', 'agy'))
    candidates.push(join(home, '.npm-global', 'bin', 'agy'))
    candidates.push(join(home, '.volta', 'bin', 'agy'))
    candidates.push(join(home, '.asdf', 'shims', 'agy'))
    candidates.push(join(home, '.nix-profile', 'bin', 'agy'))
    candidates.push('/run/current-system/sw/bin/agy')

    // NVM version directories (~/.nvm/versions/node/*/bin/agy)
    try {
      const nvmNodeDir = join(home, '.nvm', 'versions', 'node')
      if (existsSync(nvmNodeDir)) {
        for (const v of readdirSync(nvmNodeDir)) {
          candidates.push(join(nvmNodeDir, v, 'bin', 'agy'))
        }
      }
    } catch {
      // ignore
    }

    // FNM version directories
    candidates.push(join(home, '.local', 'share', 'fnm', 'current', 'bin', 'agy'))
    candidates.push(join(home, '.fnm', 'current', 'bin', 'agy'))
    candidates.push(join(home, 'Library', 'Application Support', 'fnm', 'current', 'bin', 'agy'))
  }
  // Prefer a real executable over a cmd shim: keep the first hit of each
  // PATH dir but rank .exe/extensionless before .cmd/.bat.
  const hits: string[] = [];
  for (const c of candidates) {
    try {
      accessSync(c, constants.F_OK);
      hits.push(c);
    } catch {
      continue;
    }
  }
  return hits.find((h) => !isCmdShim(h)) ?? hits[0] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/\./).map(Number);
  const pb = b.split(/\./).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;

}

export function parseVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

export interface RunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderrTail: string;
  durationMs: number;
}

export interface RunOptions {
  bin: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  activityTimeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  /** stdin stays writable (auth code injection). */
  keepStdin?: boolean;
}

export interface RunningProcess {
  child: ChildProcess;
  outcome: Promise<RunOutcome>;
  kill(reason: 'timeout' | 'abort'): void;
}

export const GRACE_MS = 800;

/** Check whether a process (or on Unix its process group) is still running. */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the PID exists but belongs to another user/system process (PID reuse defense).
    // ESRCH means process does not exist.
  }
  if (!IS_WIN) {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      // EPERM or ESRCH -> not our process group
    }
  }
  return false;
}

export function killTree(child: ChildProcess, graceMs: number = GRACE_MS): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 1) return;
  if (IS_WIN) {
    // Windows: taskkill /F /T /PID kills the entire process tree.
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
    return;
  }

  // Entrance guard: if the main process already exited and the process group is gone, return immediately.
  const isExited = child.exitCode !== null || child.signalCode !== null || child.killed;
  if (isExited && !isProcessAlive(pid)) {
    return;
  }

  // Phase 1: Send SIGTERM to the process group (-pid).
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  }

  // If already gone immediately after SIGTERM, do not mount any timers.
  if (!isProcessAlive(pid)) {
    return;
  }

  let cleanedUp = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  child.once('exit', () => {
    if (!isProcessAlive(pid)) {
      cleanup();
    }
  });

  // Short grace period with fast polling detection (every 50ms).
  pollTimer = setInterval(() => {
    if (!isProcessAlive(pid)) {
      cleanup();
    }
  }, 50);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }

  // Phase 2: After graceMs, send SIGKILL strictly to the negative process group (-pid).
  // Never send individual SIGKILL to child.pid to avoid killing reused system PIDs.
  graceTimer = setTimeout(() => {
    if (isProcessAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    setTimeout(() => {
      cleanup();
    }, 50).unref?.();
  }, graceMs);

  if (typeof graceTimer.unref === 'function') {
    graceTimer.unref();
  }
}

export function startAgyProcess(opts: RunOptions): RunningProcess {
  const started = Date.now();
  const viaCmd = IS_WIN && isCmdShim(opts.bin)
  const env = opts.env ?? process.env
  const child = viaCmd
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [opts.bin, ...opts.args].map(windowsQuote).join(' ')], {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: true,
        windowsHide: true,
      })
    : spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env,
        detached: !IS_WIN,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let settled = false;

  // agy reads stdin when it is a pipe and never sees EOF (observed on
  // 1.1.15: `agy models` hangs forever with an open pipe stdin, which is
  // why model discovery silently timed out). Close stdin immediately for
  // every spawn that does not explicitly need to write to it.
  if (!opts.keepStdin) {
    try {
      child.stdin?.end();
    } catch {
      // ignore — child may have exited already
    }
  }

  let watchdog: NodeJS.Timeout | null = null;
  const refreshWatchdog = () => {
    const timeout = opts.activityTimeoutMs ?? opts.timeoutMs;
    if (!timeout || timeout <= 0 || settled) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    watchdog.unref?.();
  };
  refreshWatchdog();

  const onAbort = () => {
    aborted = true;
    killTree(child);
  };
  if (opts.signal?.aborted) {
    onAbort();
  } else {
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  }

  if (child.stdout) child.stdout.setEncoding('utf8');
  if (child.stderr) child.stderr.setEncoding('utf8');
  let pending = '';
  child.stdout?.on('data', (chunk: string) => {
    refreshWatchdog();
    stdout += chunk;
    if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    pending += chunk;
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '');
      pending = pending.slice(nl + 1);
      opts.onLine?.(line);
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    refreshWatchdog();
    stderr = (stderr + chunk).slice(-4096);
  });

  const outcome = new Promise<RunOutcome>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      opts.signal?.removeEventListener('abort', onAbort);
      if (pending !== '') {
        opts.onLine?.(pending);
        pending = '';
      }
      resolve({
        code,
        signal,
        timedOut,
        aborted,
        stdout,
        stderrTail: stderr,
        durationMs: Date.now() - started,
      });
    };
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', (err) => {
      stderr = (stderr + String(err)).slice(-4096);
      finish(null, null);
    });
  });

  return {
    child,
    outcome,
    kill: (reason) => {
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      if (watchdog) clearTimeout(watchdog);
      killTree(child);
    },
  };
}

/** Simple one-shot helper for --version / models probes. */
export async function probeProcess(
  bin: string,
  args: readonly string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<RunOutcome> {
  const p = startAgyProcess({ bin, args, timeoutMs, signal, env });
  return p.outcome;
}

export function extractConversationId(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--conversation' || a === '-c') {
      return args[i + 1];
    }
    if (a.startsWith('--conversation=')) {
      return a.slice('--conversation='.length);
    }
  }
  return undefined;
}

export function extractConfigSignature(args: readonly string[]): string {
  let model = '';
  let effort = '';
  let mode = '';
  const addDirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--model' || a === '-m') {
      model = args[++i] ?? '';
    } else if (a.startsWith('--model=')) {
      model = a.slice('--model='.length);
    } else if (a === '--effort') {
      effort = args[++i] ?? '';
    } else if (a.startsWith('--effort=')) {
      effort = a.slice('--effort='.length);
    } else if (a === '--mode' || a === '--permission-mode') {
      mode = args[++i] ?? '';
    } else if (a.startsWith('--mode=')) {
      mode = a.slice('--mode='.length);
    } else if (a.startsWith('--permission-mode=')) {
      mode = a.slice('--permission-mode='.length);
    } else if (a === '--dangerously-skip-permissions') {
      mode = 'skip';
    } else if (a === '--add-dir') {
      const d = args[++i];
      if (d) addDirs.push(d);
    } else if (a.startsWith('--add-dir=')) {
      addDirs.push(a.slice('--add-dir='.length));
    } else if (a === '--conversation' || a === '-c') {
      i++;
    } else if (a.startsWith('--conversation=')) {
      // skip runtime conversation context flag
    }
  }
  return JSON.stringify({ model, effort, mode, addDirs: addDirs.sort() });
}

export const DEFAULT_ACTIVITY_TIMEOUT_MS = 600_000;

export interface ResidentChannelOptions {
  bin: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  activityTimeoutMs?: number;
  onCrash?: (channel: ResidentAgyChannel, error: Error | null) => void;
}

export interface ResidentTurnOptions {
  prompt: string;
  recording: RunRecording;
  signal?: AbortSignal;
  timeoutMs?: number;
  activityTimeoutMs?: number;
  parser?: StreamJsonParser;
  onLine?: (line: string) => void;
  onInit?: (cid: string) => void;
}

/**
 * Resident long-lived agy channel communicating via full-duplex stream-json.
 * Binds lifecycle to host: no 10-minute idle watchdog, reaped with negative process group SIGTERM.
 */
export class ResidentAgyChannel {
  readonly channelId: string;
  readonly configSignature: string;
  private opts: ResidentChannelOptions;
  private _lastConversationId?: string;
  private child: ChildProcess | null = null;
  private readonly parser = new StreamJsonParser();
  private stdoutBuffer = '';
  private stderrTail = '';
  private closed = false;
  private retired = false;
  private queue = Promise.resolve();
  private watchdog: NodeJS.Timeout | null = null;

  private runningTurn: {
    recording: RunRecording;
    resolve: (outcome: RunOutcome) => void;
    reject: (err: Error) => void;
    startedAt: number;
    timeoutMs?: number;
    activityTimeoutMs?: number;
    parser?: StreamJsonParser;
    onLine?: (line: string) => void;
    onInit?: (cid: string) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  } | null = null;

  constructor(opts: ResidentChannelOptions) {
    this.opts = opts;
    this.channelId = randomUUID();
    this.configSignature = extractConfigSignature(opts.args);
    this._lastConversationId = extractConversationId(opts.args);
  }

  get args(): readonly string[] {
    return this.opts.args;
  }

  get lastConversationId(): string | undefined {
    return this._lastConversationId;
  }

  setLastConversationId(cid: string): void {
    if (cid) {
      this._lastConversationId = cid;
    }
  }

  updateOptions(opts: ResidentChannelOptions): void {
    this.opts = opts;
    const cid = extractConversationId(opts.args);
    if (cid) {
      this._lastConversationId = cid;
    }
  }

  get isRunning(): boolean {
    return this.runningTurn !== null;
  }

  retire(): void {
    this.retired = true;
  }

  isRetired(): boolean {
    return this.retired;
  }

  isAlive(): boolean {
    if (this.closed) return false;
    if (!this.child) return true;
    return isProcessAlive(this.child.pid ?? 0);
  }

  private spawnChild(): void {
    const viaCmd = IS_WIN && isCmdShim(this.opts.bin);
    const env = this.opts.env ?? process.env;

    const residentArgs = [...this.opts.args];
    const isNode = this.opts.bin.endsWith('node') || this.opts.bin.endsWith('node.exe');
    const scriptIdx = isNode ? residentArgs.findIndex((a) => a.endsWith('.mjs') || a.endsWith('.js')) : -1;

    if (!residentArgs.includes('--input-format')) {
      if (scriptIdx >= 0) {
        residentArgs.splice(scriptIdx + 1, 0, '--input-format', 'stream-json');
      } else {
        residentArgs.unshift('--input-format', 'stream-json');
      }
    }
    if (!residentArgs.includes('--output-format')) {
      if (scriptIdx >= 0) {
        residentArgs.splice(scriptIdx + 3, 0, '--output-format', 'stream-json');
      } else {
        residentArgs.unshift('--output-format', 'stream-json');
      }
    }

    // Filter out prompt flags (-p / --print) since prompts are piped via stdin stream
    const cleanArgs: string[] = [];
    for (let i = 0; i < residentArgs.length; i++) {
      const arg = residentArgs[i]!;
      if (arg === '-p' || arg === '--print' || arg === '--prompt') {
        if (i + 1 < residentArgs.length && !residentArgs[i + 1]!.startsWith('-')) {
          i++;
        }
        continue;
      }
      if (arg.startsWith('-p=') || arg.startsWith('--print=') || arg.startsWith('--prompt=')) {
        continue;
      }
      cleanArgs.push(arg);
    }

    if (this._lastConversationId && !cleanArgs.includes('--conversation') && !cleanArgs.some((a) => a.startsWith('--conversation='))) {
      cleanArgs.push('--conversation', this._lastConversationId);
    }

    this.stdoutBuffer = '';
    this.stderrTail = '';

    this.child = viaCmd
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [this.opts.bin, ...cleanArgs].map(windowsQuote).join(' ')], {
          cwd: this.opts.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
      : spawn(this.opts.bin, cleanArgs, {
          cwd: this.opts.cwd,
          env,
          detached: !IS_WIN,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

    if (this.child.stdout) this.child.stdout.setEncoding('utf8');
    if (this.child.stderr) this.child.stderr.setEncoding('utf8');

    if (this.child.stdin) {
      this.child.stdin.on('error', (err) => {
        this.handleError(err);
      });
    }

    const currentChild = this.child;
    currentChild.stdout?.on('data', (chunk: string) => {
      if (this.child !== currentChild) return;
      this.refreshWatchdog();
      this.handleStdout(chunk);
    });

    currentChild.stderr?.on('data', (chunk: string) => {
      if (this.child !== currentChild) return;
      this.refreshWatchdog();
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });

    currentChild.on('exit', (code, signal) => {
      if (this.child !== currentChild) return;
      this.handleExit(code, signal);
    });

    currentChild.on('error', (err) => {
      if (this.child !== currentChild) return;
      this.handleError(err);
    });
  }

  private refreshWatchdog(): void {
    if (!this.runningTurn) {
      if (this.watchdog) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }
      return;
    }
    let timeoutMs = this.runningTurn.activityTimeoutMs ?? this.opts.activityTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS;
    if (this.runningTurn.timeoutMs && this.runningTurn.timeoutMs > 0) {
      timeoutMs = Math.min(timeoutMs, this.runningTurn.timeoutMs);
    }
    if (timeoutMs <= 0) return;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.opts.log?.(`Resident channel (${this.channelId}) turn timed out after ${timeoutMs}ms of inactivity — recycling process`);
      this.finishTurn(null, null, true, false);
    }, timeoutMs);
    this.watchdog.unref?.();
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (this.runningTurn?.onLine) {
        this.runningTurn.onLine(line);
      }
      const parser = this.runningTurn?.parser ?? this.parser;
      const events = parser.feed(line + '\n');
      for (const ev of events) {
        if (this.runningTurn) {
          this.runningTurn.recording.append(ev);
          if (ev.kind === 'step' && ev.usage) {
            this.runningTurn.recording.noteStepUsage(ev.usage);
          }
          if (ev.kind === 'init' && ev.conversationId) {
            this._lastConversationId = ev.conversationId;
            this.runningTurn.onInit?.(ev.conversationId);
          }
          if (ev.kind === 'result') {
            if (ev.conversationId !== '') {
              this._lastConversationId = ev.conversationId;
              this.runningTurn.onInit?.(ev.conversationId);
            }
            this.finishTurn(0, null, false, false);
          }
        }
      }
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.runningTurn) {
      this.finishTurn(code, signal, false, false);
    }
    if (!this.closed) {
      this.opts.log?.(`Resident agy channel (${this.channelId}) process exited (code=${code}, sig=${signal})`);
      this.opts.onCrash?.(this, null);
    }
  }

  private handleError(err: Error): void {
    this.stderrTail = (this.stderrTail + String(err)).slice(-4096);
    if (this.runningTurn) {
      this.finishTurn(null, null, false, false, err);
    }
    if (!this.closed) {
      this.opts.onCrash?.(this, err);
    }
  }

  private finishTurn(
    code: number | null,
    signal: NodeJS.Signals | null,
    timedOut: boolean,
    aborted: boolean,
    err?: Error,
  ): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (aborted || timedOut || err) {
      if (this.child) {
        const childToKill = this.child;
        this.child = null;
        childToKill.removeAllListeners();
        childToKill.stdout?.removeAllListeners();
        childToKill.stderr?.removeAllListeners();
        childToKill.stdin?.removeAllListeners();
        childToKill.on('error', () => {});
        try {
          childToKill.stdin?.end();
        } catch {}
        killTree(childToKill);
      }
    }
    if (!this.runningTurn) return;
    const turn = this.runningTurn;
    this.runningTurn = null;
    if (turn.signal && turn.onAbort) {
      turn.signal.removeEventListener('abort', turn.onAbort);
    }

    const durationMs = Date.now() - turn.startedAt;
    if (err) {
      turn.resolve({
        code: code ?? 1,
        signal,
        timedOut,
        aborted,
        stdout: "",
        stderrTail: this.stderrTail || String(err),
        durationMs,
      });
      if (this.retired) {
        this.close();
      }
      return;
    }
    turn.resolve({
      code,
      signal,
      timedOut,
      aborted,
      stdout: '',
      stderrTail: this.stderrTail,
      durationMs,
    });
    if (this.retired) {
      this.close();
    }
  }

  async sendTurn(opts: ResidentTurnOptions): Promise<RunOutcome> {
    if (this.closed || this.retired) {
      throw new Error('Resident agy channel is closed');
    }
    const prev = this.queue;
    let resolveQueue!: () => void;
    this.queue = new Promise<void>((r) => { resolveQueue = r; });
    await prev;
    try {
      return await this.executeTurn(opts);
    } finally {
      resolveQueue();
    }
  }

  private async executeTurn(opts: ResidentTurnOptions): Promise<RunOutcome> {
    if (!this.child || !isProcessAlive(this.child.pid ?? 0)) {
      this.spawnChild();
    }

    return new Promise<RunOutcome>((resolve, reject) => {
      const startedAt = Date.now();
      let onAbort: (() => void) | undefined;
      if (opts.signal) {
        if (opts.signal.aborted) {
          if (this.child) {
            const childToKill = this.child;
            this.child = null;
            childToKill.removeAllListeners();
            childToKill.stdout?.removeAllListeners();
            childToKill.stderr?.removeAllListeners();
            childToKill.stdin?.removeAllListeners();
            childToKill.on('error', () => {});
            try { childToKill.stdin?.end(); } catch {}
            killTree(childToKill);
          }
          resolve({
            code: null,
            signal: null,
            timedOut: false,
            aborted: true,
            stdout: '',
            stderrTail: '',
            durationMs: 0,
          });
          return;
        }
        onAbort = () => {
          if (this.runningTurn) {
            this.finishTurn(null, null, false, true);
          }
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.runningTurn = {
        recording: opts.recording,
        resolve,
        reject,
        startedAt,
        timeoutMs: opts.timeoutMs,
        activityTimeoutMs: opts.activityTimeoutMs,
        parser: opts.parser,
        onLine: opts.onLine,
        onInit: opts.onInit,
        signal: opts.signal,
        onAbort,
      };

      opts.recording.requestAbort = () => {
        if (this.runningTurn) {
          this.finishTurn(null, null, false, true);
        }
      };

      const payload = JSON.stringify({
        event: 'user',
        message: {
          role: 'user',
          content: opts.prompt,
        },
      }) + '\n';

      const stdin = this.child?.stdin;
      if (!stdin || !stdin.writable) {
        this.finishTurn(null, null, false, false, new Error('Child stdin is not writable'));
        return;
      }

      this.refreshWatchdog();
      const ok = stdin.write(payload, 'utf8', (err) => {
        if (err) {
          this.handleError(err);
        }
      });
      if (!ok) {
        stdin.once('drain', () => {
          // drain handled
        });
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (this.runningTurn) {
      this.finishTurn(null, null, false, true);
    }
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {
        // ignore
      }
      killTree(this.child);
      this.child = null;
    }
  }
}

/**
 * Supervisor managing resident agy channels. Binds lifecycle to host, provides crash self-healing.
 */
export class AgyProcessSupervisor {
  private readonly channels = new Map<string, ResidentAgyChannel>();
  private readonly retiredChannels = new Set<ResidentAgyChannel>();
  private readonly conversationIds = new Map<string, string>();

  constructor(private readonly defaultLog?: (msg: string) => void) {}

  getConversationId(key: string): string | undefined {
    return this.conversationIds.get(key) ?? this.channels.get(key)?.lastConversationId;
  }

  setConversationId(key: string, conversationId: string): void {
    if (conversationId) {
      this.conversationIds.set(key, conversationId);
      this.channels.get(key)?.setLastConversationId(conversationId);
    }
  }

  deleteConversationId(key: string): void {
    this.conversationIds.delete(key);
  }

  getChannel(key: string, opts: ResidentChannelOptions): ResidentAgyChannel {
    let chan = this.channels.get(key);
    const targetSignature = extractConfigSignature(opts.args);
    const newSig = JSON.parse(targetSignature) as { model?: string };

    if (chan && chan.isAlive()) {
      const oldSig = JSON.parse(chan.configSignature) as { model?: string };
      const modelChanged = Boolean(oldSig.model && newSig.model && oldSig.model !== newSig.model);
      if (modelChanged) {
        this.conversationIds.delete(key);
      }
      if (chan.configSignature !== targetSignature) {
        if (!modelChanged && chan.lastConversationId && !this.conversationIds.has(key)) {
          this.conversationIds.set(key, chan.lastConversationId);
        }
        if (chan.isRunning) {
          this.defaultLog?.(`Resident channel busy with running turn for key ${key}; preserving active turn on retired channel`);
          chan.retire();
          this.retiredChannels.add(chan);
          this.channels.delete(key);
          chan = undefined;
        } else {
          this.defaultLog?.(`Resident channel config signature changed for key ${key}; recycling channel`);
          chan.close();
          chan = undefined;
        }
      }
    }

    const explicitCid = extractConversationId(opts.args);
    if (explicitCid) {
      this.conversationIds.set(key, explicitCid);
    }
    const knownCid = explicitCid ?? this.conversationIds.get(key);
    let effectiveOpts = opts;
    if (knownCid && !opts.args.includes('--conversation') && !opts.args.some((a) => a.startsWith('--conversation='))) {
      const args = [...opts.args];
      const pIdx = args.indexOf('-p');
      if (pIdx >= 0) {
        args.splice(pIdx, 0, '--conversation', knownCid);
      } else {
        args.push('--conversation', knownCid);
      }
      effectiveOpts = { ...opts, args };
    }

    if (chan && chan.isAlive()) {
      chan.updateOptions(effectiveOpts);
    } else {
      if (chan) {
        chan.close();
      }
      chan = new ResidentAgyChannel({
        ...effectiveOpts,
        log: effectiveOpts.log ?? this.defaultLog,
        onCrash: (c, err) => {
          effectiveOpts.onCrash?.(c, err);
          this.retiredChannels.delete(c);
          if (this.channels.get(key) === c) {
            this.channels.delete(key);
          }
        },
      });
      if (knownCid) {
        chan.setLastConversationId(knownCid);
      }
      this.channels.set(key, chan);
    }
    return chan;
  }

  async runTurn(key: string, spawnOpts: ResidentChannelOptions, turnOpts: ResidentTurnOptions): Promise<RunOutcome> {
    const channel = this.getChannel(key, spawnOpts);
    const wrappedOnInit = (cid: string) => {
      if (cid) {
        this.conversationIds.set(key, cid);
      }
      turnOpts.onInit?.(cid);
    };
    return channel.sendTurn({
      ...turnOpts,
      onInit: wrappedOnInit,
    });
  }

  async dispose(): Promise<void> {
    for (const chan of this.channels.values()) {
      chan.close();
    }
    for (const chan of this.retiredChannels) {
      chan.close();
    }
    this.channels.clear();
    this.retiredChannels.clear();
    this.conversationIds.clear();
  }

  get size(): number {
    return this.channels.size;
  }
}


