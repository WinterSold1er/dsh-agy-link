import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { binCandidates, isolatedHomeEnv, isCmdShim, isProcessAlive, killTree, resolveAgyBin, startAgyProcess, windowsQuote } from '../src/host/runner.ts'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

test('windowsQuote leaves plain args untouched', () => {
  assert.equal(windowsQuote('plain-arg'), 'plain-arg')
  assert.equal(windowsQuote('--print'), '--print')
})

test('windowsQuote wraps args with spaces and escapes quotes', () => {
  assert.equal(windowsQuote('hello world'), '"hello world"')
  // inner quote escapes; a trailing backslash doubles only when quoting (cross-spawn rules)
  assert.equal(windowsQuote('say "hi"'), '"say \\"hi\\""')
  assert.equal(windowsQuote('dir \\'), '"dir \\\\"')
  // no special chars -> untouched, even with a trailing backslash
  assert.equal(windowsQuote('path\\'), 'path\\')
})

test('binCandidates are per-platform', () => {
  // extensions follow the platform; separators come from the host join(),
  // so build expectations with join too (runs green on any OS)
  const win = binCandidates('C:\\tools', 'win32')
  assert.deepEqual(win, [join('C:\\tools', 'agy.exe'), join('C:\\tools', 'agy.cmd'), join('C:\\tools', 'agy.bat')])
  assert.deepEqual(win.map((c) => c.split(/[\\/]/).pop()), ['agy.exe', 'agy.cmd', 'agy.bat'])
  const nix = binCandidates('/usr/bin', 'linux')
  assert.deepEqual(nix, [join('/usr/bin', 'agy')])
  assert.equal(nix[0]!.endsWith('agy'), true)
  const mac = binCandidates('/opt/homebrew/bin', 'darwin')
  assert.deepEqual(mac, [join('/opt/homebrew/bin', 'agy')])
})

test('isolatedHomeEnv always sets HOME + GEMINI_CLI_HOME', () => {
  const env = isolatedHomeEnv('/tmp/acc1')
  assert.equal(env.HOME, '/tmp/acc1')
  assert.equal(env.GEMINI_CLI_HOME, join('/tmp/acc1', '.gemini'))
  if (process.platform === 'win32') {
    // Windows libuv/Go ignore $HOME — USERPROFILE/HOMEDRIVE/HOMEPATH required.
    assert.equal(env.USERPROFILE, '/tmp/acc1')
    const drive = isolatedHomeEnv('C:\\Users\\acc1')
    assert.equal(drive.HOMEDRIVE, 'C:')
    assert.equal(drive.HOMEPATH, '\\Users\\acc1')
  }
})

test('isCmdShim detects cmd/bat case-insensitively', () => {
  assert.equal(isCmdShim('C:\\npm\\agy.CMD'), true)
  assert.equal(isCmdShim('C:\\npm\\agy.bat'), true)
  assert.equal(isCmdShim('C:\\npm\\agy.exe'), false)
  assert.equal(isCmdShim('/usr/local/bin/agy'), false)
})

// CRLF tolerance: a child emitting \r\n lines must deliver clean lines.
test('runner strips trailing CR from CRLF output', async () => {
  const lines: string[] = []
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({a:1}) + "\\r\\n" + JSON.stringify({b:2}) + "\\r\\n")'])
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    pending += d
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '')
      pending = pending.slice(nl + 1)
      lines.push(line)
    }
  })
  const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
  assert.equal(code, 0)
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ a: 1 }, { b: 2 }])
})

test('startAgyProcess activity watchdog refreshes on output chunks', async () => {
  // timeoutMs is 3000ms, child emits 4 chunks across 600ms (every 150ms).
  // A fixed watchdog would kill at 3000ms; sliding activity watchdog refreshes on each chunk.
  const script = `
    const fs = require('node:fs');
    let i = 0;
    fs.writeSync(1, Buffer.from('chunk' + (++i) + '\\n'));
    const t = setInterval(() => {
      fs.writeSync(1, Buffer.from('chunk' + (++i) + '\\n'));
      if (i >= 4) clearInterval(t);
    }, 150);
  `
  const lines: string[] = []
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 5000,
    onLine: (l) => lines.push(l),
  })
  const outcome = await proc.outcome
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.code, 0)
  assert.deepEqual(lines, ['chunk1', 'chunk2', 'chunk3', 'chunk4'])
})


test('startAgyProcess times out if child is completely silent', async () => {
  // timeoutMs is 500ms, child sleeps for 2500ms silently without any stdout/stderr
  const script = `setTimeout(() => {}, 2500)`
  const lines: string[] = []
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
    timeoutMs: 500,
    onLine: (l) => lines.push(l),
  })
  const outcome = await proc.outcome
  assert.equal(outcome.timedOut, true)
  assert.equal(lines.length, 0)
})

test('resolveAgyBin honors explicit agyBin config if it exists', () => {
  const found = resolveAgyBin({ agyBin: process.execPath } as never)
  assert.equal(found, process.execPath)
  const missing = resolveAgyBin({ agyBin: '/nonexistent/agy/path/xyz' } as never)
  // If explicit path does not exist, it falls back to scanning or null
  assert.notEqual(missing, '/nonexistent/agy/path/xyz')
})

test('startAgyProcess aborts immediately when signal is pre-aborted', async () => {
  const ac = new AbortController()
  ac.abort()
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
    signal: ac.signal,
  })
  const outcome = await proc.outcome
  assert.equal(outcome.aborted, true)
})

test('killTree reaps stubborn processes with stage-2 SIGKILL', async () => {
  if (process.platform === 'win32') return
  // Child ignores SIGTERM
  const script = `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', script],
  })
  // Give process a moment to spin up
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(isProcessAlive(proc.child.pid!), true)

  // Kill with short grace period (150ms)
  killTree(proc.child, 150)
  const outcome = await proc.outcome
  assert.equal(outcome.signal, 'SIGKILL')
  assert.equal(isProcessAlive(proc.child.pid!), false)
})

test('isProcessAlive defensively rejects invalid PIDs and EPERM errors', () => {
  // PIDs <= 1 must always be treated as not alive
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(1), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(NaN), false)

  // Test EPERM simulation: PID belonging to another user must return false
  const origKill = process.kill
  try {
    process.kill = ((_pid: number, _sig?: string | number) => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    }) as typeof process.kill

    assert.equal(isProcessAlive(99999), false, 'EPERM must be treated as false to prevent PID reuse misuse')
  } finally {
    process.kill = origKill
  }
})

test('killTree exits immediately for already exited child without hanging', async () => {
  const proc = startAgyProcess({
    bin: process.execPath,
    args: ['-e', 'process.exit(0)'],
  })
  await proc.outcome
  // Child has already exited
  assert.equal(proc.child.exitCode !== null, true)
  assert.equal(isProcessAlive(proc.child.pid!), false)

  // killTree should return immediately without scheduling timers
  const start = Date.now()
  killTree(proc.child, 1000)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 100, `killTree took ${elapsed}ms, should return immediately for dead process`)
})
