/**
 * Single-owner background poller used by the private analytics dashboard.
 *
 * Design invariants (each one pinned by tests/analytics-refresh.test.ts):
 *  1. exactly ONE interval exists per instance, created once at start();
 *  2. a tick while a previous request is still in flight is SKIPPED, never
 *     queued and never aborts the running request — no overlapping requests;
 *  3. polling pauses while the document is hidden and performs at most one
 *     immediate catch-up refresh when it becomes visible again;
 *  4. every run is bounded by a timeout so the UI can never spin forever;
 *  5. dispose() clears the interval, the visibility listener and any pending
 *     catch-up timer — nothing fires after unmount;
 *  6. start() is idempotent and never stacks intervals.
 */
export interface PollerOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Runs one refresh. Receives an AbortSignal tied to the timeout/dispose. */
  run: (signal: AbortSignal) => Promise<void>;
  /** Reads document.visibilityState (injectable for tests). */
  isVisible?: () => boolean;
  /** Registers a visibilitychange listener; must return an unsubscribe fn. */
  onVisibilityChange?: (listener: () => void) => () => void;
  /** Background (poll/catch-up) failure hook; manual errors reject the returned promise instead. */
  onBackgroundError?: (err: unknown) => void;
  /** Fires with true while a refresh is in flight. */
  onActivity?: (active: boolean) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export type RefreshReason = "poll" | "catch-up" | "manual";

export class AnalyticsPoller {
  private inFlight: AbortController | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private removeVisibilityListener: (() => void) | null = null;
  private disposed = false;
  private readonly isVisible: () => boolean;
  private readonly st: typeof setTimeout;
  private readonly ct: typeof clearTimeout;
  private readonly si: typeof setInterval;
  private readonly ci: typeof clearInterval;

  constructor(private opts: PollerOptions) {
    this.isVisible = opts.isVisible ?? (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
    this.st = opts.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
    this.ct = opts.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
    this.si = opts.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
    this.ci = opts.clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);
  }

  /** True while ANY refresh (background or manual) is running. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Starts the single interval + visibility handling. Idempotent. */
  start(): void {
    if (this.disposed || this.interval) return;
    this.interval = this.si(() => this.tick(), this.opts.intervalMs);
    if (this.opts.onVisibilityChange) {
      this.removeVisibilityListener = this.opts.onVisibilityChange(() => {
        if (this.disposed) return;
        if (this.isVisible()) void this.refresh("catch-up"); // at most one immediate catch-up
      });
    }
  }

  /**
   * One bounded refresh. Returns null when skipped because another refresh is
   * still in flight (polls are skipped silently; a manual call can surface
   * that it is already running).
   */
  refresh(reason: RefreshReason): Promise<void> | null {
    if (this.disposed || this.inFlight) return null;
    const ac = new AbortController();
    this.inFlight = ac;
    const timer = this.st(() => ac.abort(), this.opts.timeoutMs);
    this.opts.onActivity?.(true);
    const done = this.opts.run(ac.signal);
    return done
      .catch((err) => {
        if (reason === "manual") throw err;
        this.opts.onBackgroundError?.(err);
      })
      .finally(() => {
        this.ct(timer);
        if (this.inFlight === ac) this.inFlight = null;
        this.opts.onActivity?.(false);
        if (this.disposed) ac.abort();
      });
  }

  private tick(): void {
    if (this.disposed || !this.isVisible()) return; // paused while hidden
    void this.refresh("poll");
  }

  /** Aborts an in-flight request and stops all timers/listeners. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.interval) {
      this.ci(this.interval);
      this.interval = null;
    }
    this.removeVisibilityListener?.();
    this.removeVisibilityListener = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }
}
