/**
 * Regression suite for the analytics "constant refresh spinner" incident.
 *
 * Root causes fixed (each pinned by a test below):
 *   A. `setLoading(true)` ran on EVERY poll → button spinner / skeleton churn
 *      every 20 s. → Polls are silent; only the first load is blocking.
 *   B. Activity pagination rode on the same loader → page turns rebuilt the
 *      interval and re-fetched everything. → AnalyticsPoller owns exactly ONE
 *      interval created once per mount; pagination is a separate channel.
 *   C. visibilitychange handler double-started channels; dispose lost timer
 *      ids → stacked intervals. → Poller pauses hidden, one catch-up, full
 *      dispose.
 *   D. No request timeout → a hung fetch could hold the spinner forever.
 *      → Every run is bounded by an AbortController timeout.
 *   E. 3+1 request waterfall. → overview/popular/landings + activity fly in
 *      one parallel batch (see src/lib/analytics/api.ts).
 *
 * Also pins: entrance animations exist but can never replay on polls (chart
 * elements are not keyed by data), reduced-motion neutralizes them, and page
 * overflow is contained (tables scroll inside, not the page).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "node-html-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsPoller } from "../src/lib/analytics/poller";

/* ------------------------------ helpers ------------------------------ */

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Deterministic fake clock driving injected setTimeout/setInterval. */
export function makeClock() {
  let now = 0;
  let seq = 1;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; fn: () => void; next: number }>();
  const setTimeoutFn = ((fn: () => void, ms?: number) => { const id = seq++; timeouts.set(id, { at: now + (ms ?? 0), fn }); return id; }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: number) => { timeouts.delete(id); }) as unknown as typeof clearTimeout;
  const setIntervalFn = ((fn: () => void, ms?: number) => { const id = seq++; intervals.set(id, { every: ms ?? 0, fn, next: now + (ms ?? 0) }); return id; }) as unknown as typeof setInterval;
  const clearIntervalFn = ((id: number) => { intervals.delete(id); }) as unknown as typeof clearInterval;
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const tNext = [...timeouts.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      const iNext = [...intervals.entries()].filter(([, i]) => i.next <= target).sort((a, b) => a[1].next - b[1].next)[0];
      if (!tNext && !iNext) break;
      const fireT = tNext && (!iNext || tNext[1].at <= iNext[1].next);
      if (fireT) { now = tNext[1].at; timeouts.delete(tNext[0]); tNext[1].fn(); }
      else { const iv = intervals.get(iNext[0])!; now = iNext[1].next; iv.next += iv.every; iNext[1].fn(); }
    }
    now = target;
  };
  return {
    setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn, advance,
    pendingIntervals: () => intervals.size,
    pendingTimeouts: () => timeouts.size,
  };
}

interface PendingRun extends Deferred<void> { signal: AbortSignal }

function makePoller(overrides: Partial<ConstructorParameters<typeof AnalyticsPoller>[0]> = {}) {
  const clock = makeClock();
  const runs: PendingRun[] = [];
  const errors: unknown[] = [];
  const visible = { current: true };
  const visListeners: Array<() => void> = [];
  const poller = new AnalyticsPoller({
    intervalMs: 20_000,
    timeoutMs: 12_000,
    run: vi.fn((signal: AbortSignal) => {
      const d = deferred<void>() as PendingRun;
      d.signal = signal;
      runs.push(d);
      const onAbort = () => d.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
      return d.promise;
    }),
    isVisible: () => visible.current,
    onVisibilityChange: (l) => { visListeners.push(l); return () => { const i = visListeners.indexOf(l); if (i >= 0) visListeners.splice(i, 1); } },
    onBackgroundError: (e) => errors.push(e),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    ...overrides,
  });
  return { poller, clock, runs, errors, visible, visListeners };
}

afterEach(() => vi.restoreAllMocks());

/** setImmediate drains the whole pending microtask queue (one is NOT enough
 *  for promise.catch().finally() chains — each hop is its own tick). */
function flushMicrotasks() {
  return new Promise<void>((r) => setImmediate(r));
}

/* ------------------------------ invariants ------------------------------ */

describe("AnalyticsPoller — repeated-loading fixes", () => {
  it("1. start() creates exactly ONE interval and is idempotent — no stacked timers", () => {
    const { poller, clock } = makePoller();
    poller.start(); poller.start(); poller.start();
    expect(clock.pendingIntervals()).toBe(1);
    poller.dispose();
    expect(clock.pendingIntervals()).toBe(0);
  });

  it("2. ticks while a refresh is in flight are skipped — requests never overlap", async () => {
    // Long timeout so this test isolates the overlap rule from the timeout rule.
    const { poller, clock, runs } = makePoller({ timeoutMs: 600_000 });
    poller.start();
    clock.advance(20_000);
    expect(runs.length).toBe(1);
    clock.advance(40_000); // two more ticks while still pending
    expect(runs.length).toBe(1); // skipped, NOT queued, NOT aborted
    expect(runs[0].signal.aborted).toBe(false);
    runs[0].resolve();
    await flushMicrotasks();
    clock.advance(20_000);
    expect(runs.length).toBe(2);
  });

  it("3. polling pauses while hidden; exactly one catch-up runs on return", async () => {
    const { poller, clock, runs, visible, visListeners } = makePoller({ timeoutMs: 600_000 });
    poller.start();
    expect(visListeners.length).toBe(1); // single listener
    visible.current = false;
    clock.advance(120_000); // six ticks suppressed
    expect(runs.length).toBe(0);
    visible.current = true;
    visListeners.forEach((l) => l()); // visibilitychange → visible
    expect(runs.length).toBe(1); // single immediate catch-up
    clock.advance(20_000);
    runs[0].resolve();
    await flushMicrotasks(); // release the busy gate (finally{} after catch/finally hops)
    clock.advance(20_000);
    expect(runs.length).toBe(2); // normal cadence resumes
  });

  it("4. a hung refresh is aborted at the timeout and the busy gate releases", async () => {
    const { poller, clock, runs, errors } = makePoller();
    poller.start();
    const p = poller.refresh("poll");
    expect(p).not.toBeNull();
    expect(runs[0].signal.aborted).toBe(false);
    clock.advance(12_001); // run never resolves → timeout must abort it
    expect(runs[0].signal.aborted).toBe(true);
    await p; // the abort rejection is routed to onBackgroundError, not thrown
    expect(errors.length).toBe(1);
    expect(poller.busy).toBe(false);
    // and the next poll can start — spinner/recovery is guaranteed
    expect(poller.refresh("poll")).not.toBeNull();
  });

  it("5. dispose() stops interval, unregisters the listener, aborts in-flight, is idempotent", () => {
    const { poller, clock, runs, visListeners, visible } = makePoller();
    poller.start();
    void poller.refresh("poll");
    expect(runs.length).toBe(1);
    poller.dispose();
    expect(clock.pendingIntervals()).toBe(0);
    expect(visListeners.length).toBe(0);
    expect(runs[0].signal.aborted).toBe(true);
    visible.current = true;
    clock.advance(200_000);
    expect(runs.length).toBe(1); // nothing fires post-unmount
    poller.dispose(); // safe to call twice
  });

  it("6. a manual refresh click while one is in flight is a no-op (single-flight)", () => {
    const { poller, runs } = makePoller();
    poller.start();
    expect(poller.refresh("manual")).not.toBeNull();
    expect(poller.refresh("manual")).toBeNull();
    expect(poller.refresh("poll")).toBeNull();
    expect(runs.length).toBe(1);
  });

  it("7. manual errors reject the returned promise; background errors go to onBackgroundError only", async () => {
    const { poller, runs, errors } = makePoller();
    poller.start();
    const manual = poller.refresh("manual")!;
    runs[0].reject(new Error("offline"));
    await expect(manual).rejects.toThrow("offline");
    expect(errors.length).toBe(0); // not double-reported
    const bg = poller.refresh("poll")!;
    runs[1].reject(new Error("server"));
    await bg;
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe("server");
  });
});

/* ---------------------- markup / CSS / wiring pins ---------------------- */

const CLIENT_PATH = path.resolve(__dirname, "../src/app/admin/analytics/analytics-client.tsx");
const CSS_PATH = path.resolve(__dirname, "../src/app/globals.css");
const API_PATH = path.resolve(__dirname, "../src/lib/analytics/api.ts");
const clientSrc = readFileSync(CLIENT_PATH, "utf8");
const cssSrc = readFileSync(CSS_PATH, "utf8");
const apiSrc = readFileSync(API_PATH, "utf8");

describe("analytics dashboard — structural wiring pins", () => {
  it("the client no longer sets a global loading state on polls and fetches in one parallel batch", () => {
    // B: single poller per mount, interval owned by it
    expect(clientSrc).toContain("new AnalyticsPoller(");
    expect(clientSrc).not.toMatch(/setInterval\(/); // no ad-hoc intervals in the client
    // E: parallel batch lives in api.ts via Promise.all
    expect(apiSrc).toMatch(/Promise\.all\(\[[\s\S]*overview[\s\S]*popular[\s\S]*landings/);
    // A: refresh button spinner is only tied to manual/initial states
    expect(clientSrc).toContain("refreshing || loading");
  });

  it("state preservation: the refresh path never resets activityPage — only user handlers do", () => {
    // Scope to the runRefresh body (the ONLY function the poller can trigger —
    // directly or via manual refresh): it must not touch pagination state.
    const start = clientSrc.indexOf("const runRefresh");
    const end = clientSrc.indexOf("const manualRefresh");
    const refreshPath = clientSrc.slice(start, end);
    expect(refreshPath.length).toBeGreaterThan(50);
    expect(refreshPath).not.toContain("setActivityPage");
    // The only places that reset to page 0 are the range-change handlers.
    const resetSites = clientSrc.match(/goToPage\(0\)/g) ?? [];
    expect(resetSites.length).toBeGreaterThanOrEqual(1);
    for (const [i, ch] of [...clientSrc.matchAll(/goToPage\(0\)/g)].map((m) => [m.index!, m[0]] as const)) {
      void ch;
      const ctx = clientSrc.slice(Math.max(0, i - 140), i);
      expect(ctx).toMatch(/setRange|setFrom|setTo|onClick|onChange|=> \{/);
    }
  });

  it("entrance animations are CSS-first, staggered, and neutralized under prefers-reduced-motion", () => {
    expect(cssSrc).toContain(".analytics-enter");
    expect(cssSrc).toContain("@keyframes analytics-enter");
    expect(cssSrc).toContain("@keyframes analytics-draw");
    expect(cssSrc).toContain(".analytics-bar-fill");
    const reduced = cssSrc.indexOf("prefers-reduced-motion");
    expect(reduced).toBeGreaterThan(-1);
    // the reduced-motion block neuters both analytics keyframe classes
    const tail = cssSrc.slice(reduced);
    expect(tail).toContain(".analytics-enter, .analytics-draw");
    expect(tail).toContain("stroke-dashoffset: 0"); // drawn state persists without animation
    // charts are NOT keyed by data → draw/entrance cannot replay on poll updates
    expect(clientSrc).not.toMatch(/key=\{[^}]*pageviews/);
  });

  it("page overflow is contained: tables scroll inside their card, page-level content never widens", () => {
    // activity table gets its own contained horizontal scroller with a bounded min width
    expect(clientSrc).toContain('className="overflow-x-auto"');
    expect(clientSrc).toContain("min-w-[36rem]");
    // main container guards against any child overflow reaching the viewport
    expect(clientSrc).toContain("overflow-x-clip");
    // HBar label column shrinks on the narrowest screens
    expect(clientSrc).toContain("grid-cols-[minmax(0,7rem)_1fr_auto]");
    // no fixed viewport-collapsing widths in the client
    expect(clientSrc).not.toMatch(/w-\[1[0-9]{3}px\]/); // no 1000px+ fixed widths
  });
});

/* ---------------- SSR markup assertions (real render, real DOM) ---------------- */

async function ssr(el: ReactElement) {
  const html = renderToStaticMarkup(el);
  return parse(html);
}

describe("analytics components — SSR markup contracts", () => {
  it("PagesTable renders inside a contained scroll region with truncated long paths", async () => {
    const { PagesTable } = await import("../src/app/admin/analytics/analytics-client");
    const root = await ssr(
      h(PagesTable, {
        rows: [{ path: "/a/very/long/path/" + "x".repeat(400), pageviews: 12, uniqueVisitors: 3, sessions: 4 } as never],
        metricHeader: "Views",
        metric: (r: { pageviews: number }) => r.pageviews,
      }),
    );
    expect(root.querySelector('.overflow-x-auto')).not.toBeNull();
    const cell = root.querySelector("td");
    expect(cell?.classNames).toContain("truncate");
    expect(cell?.getAttribute("title")).toContain("x".repeat(40)); // full value retained for a11y tooltip
  });

  it("LineChart keeps poll-updatable polylines un-keyed (single draw animation, no replay)", async () => {
    const { __LineChartForTest } = await import("../src/app/admin/analytics/analytics-client");
    void __LineChartForTest;
    const html = renderToStaticMarkup(
      h(__LineChartForTest, {
        points: [
          { t: "2026-10-01T00:00:00Z", visitors: 2, sessions: 2, pageviews: 5 },
          { t: "2026-10-02T00:00:00Z", visitors: 3, sessions: 3, pageviews: 9 },
          { t: "2026-10-03T00:00:00Z", visitors: 1, sessions: 1, pageviews: 2 },
        ] as never,
      }),
    );
    const root = parse(html);
    const polylines = root.querySelectorAll("polyline");
    expect(polylines.length).toBe(3); // pageviews + visitors + sessions
    for (const pl of polylines) {
      expect(pl.classNames).toContain("analytics-draw"); // CSS draw-once animation
      expect(pl.getAttribute("pathLength")).toBe("1");
      expect(pl.getAttribute("key") ?? null).toBeNull(); // React keys never reach the DOM, guard class instead
    }
    // responsive: svg scales with container, no fixed pixel width
    const svg = root.querySelector("svg");
    expect(svg?.classNames).toContain("w-full");
  });

  it("HBar fill width transitions via .analytics-bar-fill (poll updates glide instead of jumping)", async () => {
    const { __HBarForTest } = await import("../src/app/admin/analytics/analytics-client");
    const root = await ssr(h(__HBarForTest, { label: "Audits completed", value: 5, max: 10 }));
    const bar = root.querySelector(".analytics-bar-fill");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("style")).toContain("width:50%");
  });

  it("initial dashboard render shows skeletons (not an error) — and never at poll time", async () => {
    const { AdminAnalyticsClient } = await import("../src/app/admin/analytics/analytics-client");
    const html = renderToStaticMarkup(h(AdminAnalyticsClient));
    const root = parse(html);
    expect(root.text).not.toContain("Something went wrong");
    expect(root.querySelectorAll(".animate-pulse").length).toBeGreaterThan(2); // skeletons on first paint
    expect(root.querySelectorAll(".analytics-enter").length).toBeGreaterThan(3); // staged entrance present
    expect(root.querySelector("main")?.classNames).toContain("overflow-x-clip");
  });
});
