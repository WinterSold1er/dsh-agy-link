/**
 * Streaming thinking keepalive & anti-hang generator.
 * Emits reasoning-delta pulses (e.g. `[Thinking · Xs elapsed]\n`) every 3 seconds
 * while awaiting agy CLI responses, maintaining live frontend thinking count
 * and preventing connection timeouts in proxies or harness clients.
 */

export interface HeartbeatOptions {
  /** Pulse interval in milliseconds (default: 3000ms). */
  intervalMs?: number
  /** Callback on each beat with whole elapsed seconds. */
  onBeat: (elapsedSeconds: number) => void
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null
  private readonly startedAt: number
  private stopped = false

  constructor(private readonly opts: HeartbeatOptions) {
    this.startedAt = Date.now()
  }

  start(): this {
    if (this.stopped || this.timer) return this
    const interval = this.opts.intervalMs ?? 3000
    this.timer = setInterval(() => {
      if (this.stopped) {
        this.stop()
        return
      }
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000))
      this.opts.onBeat(elapsedSeconds)
    }, interval)
    this.timer.unref?.()
    return this
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  get isRunning(): boolean {
    return !this.stopped && this.timer !== null
  }
}
