"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyticsOverview, BreakdownRow, PopularPageRow, RecentActivityRow } from "@/lib/db/analytics-types";
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader, Spinner, Stat } from "@/components/ui";
import { AnalyticsPoller } from "@/lib/analytics/poller";
import { fetchActivityPage, fetchDashboardCore } from "@/lib/analytics/api";

/** Poll cadence — dashboard is near-real-time, not real-time (docs/ANALYTICS.md). */
const POLL_MS = 20_000;
/** Hard bound for any single request so no spinner can hang forever. */
const FETCH_TIMEOUT_MS = 12_000;
const ACTIVITY_PER_PAGE = 25;
const DOWN_FOR = "No data for this period. Try a longer range or refresh.";

type Preset = "7" | "30" | "90" | "custom";
type LoadStatus = "idle" | "loading" | "ready" | "failed";

interface CoreBundle {
  overview: AnalyticsOverview;
  popular: { rows: PopularPageRow[]; total: number };
  landings: { rows: PopularPageRow[]; total: number };
}
interface ActivityBundle {
  rows: RecentActivityRow[];
  total: number;
}

const nf = new Intl.NumberFormat("en-US");
const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : nf.format(n));
const pct = (n: number | null | undefined) => (n === null || n === undefined || !isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`);

export function rangeQuery(preset: Preset, from: string, to: string): string {
  if (preset === "custom" && from && to) return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(`${to}T23:59:59Z`).toISOString())}`;
  return `days=${preset === "custom" ? "30" : preset}`;
}

const isAbort = (e: unknown) => (e as Error).name === "AbortError";
const ERROR_TEXT = "The statistics could not be loaded. The dashboard will keep retrying on its normal schedule.";

/* ---------------------------------------------------------------------------
 * Data layer — rebuilt to fix the repeated-loading defect at its roots:
 *
 *  (1) OLD BUG: a single `load` closure depended on (preset, from, to,
 *      activityPage) and the poll effect depended on `load` — so turning one
 *      activity page re-created the interval AND re-fetched all four
 *      endpoints. FIX: one AnalyticsPoller instance is created once per mount
 *      and owns one interval; activity pagination lives in its own channel.
 *  (2) OLD BUG: `setLoading(true)` fired on EVERY poll → the refresh button
 *      spun every 20s and sections flashed their loading placeholders. FIX:
 *      `status` is only the *initial* gate; polls never touch it. Poll
 *      failures keep the last successful data and only surface a quiet note.
 *  (3) OLD BUG: the visibilitychange handler both called load() AND restarted
 *      the interval while cleanup dropped the id (double channels). FIX: the
 *      poller pauses while hidden and issues at most one catch-up refresh.
 *  (4) OLD BUG: no request timeout — a hung fetch kept `loading` forever.
 *      FIX: every refresh (poll/manual/initial) is bounded by AbortSignal.
 *  (5) OLD BUG: 3+1 request waterfall (activity awaited the other three).
 *      FIX: overview/popular/landings run in one parallel batch; the activity
 *      feed is fetched in the same refresh, also in parallel.
 * ------------------------------------------------------------------------- */

function useAnalytics(preset: Preset, from: string, to: string) {
  const [core, setCore] = useState<CoreBundle | null>(null);
  const [coreStatus, setCoreStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);      // blocking — only when nothing to show
  const [pollError, setPollError] = useState<string | null>(null); // quiet — data stays on screen
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);           // manual button spinner only

  const [activity, setActivity] = useState<ActivityBundle | null>(null);
  const [activityStatus, setActivityStatus] = useState<LoadStatus>("idle");
  const [activityPage, setActivityPage] = useState(0);

  const pollerRef = useRef<AnalyticsPoller | null>(null);
  const activityAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const queryRef = useRef("");
  const pageRef = useRef(0);
  // Keep request parameters in refs so the poller (created once) always reads
  // the CURRENT range/page without the effect ever re-running. Refs are only
  // written inside effects — never during render.
  useEffect(() => {
    queryRef.current = rangeQuery(preset, from, to);
    pageRef.current = activityPage;
  });

  const applyCore = useCallback((data: CoreBundle | null, signal: AbortSignal) => {
    if (!mountedRef.current || signal.aborted || !data) return;
    setCore(data);
    setCoreStatus("ready");
    setError(null);
    setPollError(null);
    setLastUpdated(new Date());
  }, []);

  const applyActivity = useCallback((data: ActivityBundle | null, signal: AbortSignal) => {
    if (!mountedRef.current || signal.aborted || !data) return;
    setActivity(data);
    setActivityStatus("ready");
  }, []);

  /** One full refresh = core batch + activity feed, all in parallel. */
  const runRefresh = useCallback(async (signal: AbortSignal) => {
    const [coreData, activityData] = await Promise.all([
      fetchDashboardCore(queryRef.current, signal),
      fetchActivityPage(queryRef.current, pageRef.current, ACTIVITY_PER_PAGE, signal).catch((e) => e as Error),
    ]);
    applyCore(coreData, signal);
    if (activityData instanceof Error) {
      if (!isAbort(activityData) && mountedRef.current && !signal.aborted) setActivityStatus("failed");
    } else {
      applyActivity(activityData, signal);
    }
  }, [applyCore, applyActivity]);

  const manualRefresh = useCallback(() => {
    const poller = pollerRef.current;
    if (!poller) return;
    setRefreshing(true);
    const p = poller.refresh("manual");
    void (p ?? Promise.resolve())
      .catch(() => { if (mountedRef.current) setPollError(ERROR_TEXT); })
      .finally(() => { if (mountedRef.current) setRefreshing(false); });
  }, []);

  // Mount: create the single poller, schedule the initial (blocking) load.
  useEffect(() => {
    mountedRef.current = true;
    const poller = new AnalyticsPoller({
      intervalMs: POLL_MS,
      timeoutMs: FETCH_TIMEOUT_MS,
      run: runRefresh,
      onBackgroundError: (e) => { if (!isAbort(e) && mountedRef.current) setPollError(ERROR_TEXT); },
      onVisibilityChange: (listener) => {
        const onVis = () => listener();
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
      },
    });
    pollerRef.current = poller;
    poller.start();
    // Deferred — a deferred function call, not a synchronous setState cascade.
    const initial = setTimeout(() => {
      const p = poller.refresh("manual");
      void p?.catch(() => {
        if (!mountedRef.current) return;
        setCoreStatus("failed");
        setActivityStatus("failed");
        setError(ERROR_TEXT);
      });
      // Only the FIRST load is ever blocking; polls never enter this path.
      setCoreStatus((s) => (s === "ready" || s === "failed" ? s : "loading"));
      setActivityStatus((s) => (s === "ready" || s === "failed" ? s : "loading"));
    }, 0);
    return () => {
      mountedRef.current = false;
      clearTimeout(initial);
      poller.dispose();
      pollerRef.current = null;
      activityAbortRef.current?.abort();
    };
  }, [runRefresh]);

  // Date-range changes refresh data once, without rebuilding poll machinery.
  const firstRange = useRef(true);
  useEffect(() => {
    if (firstRange.current) { firstRange.current = false; return; }
    const poller = pollerRef.current;
    if (!poller) return;
    const t = setTimeout(() => {
      const p = poller.refresh("manual");
      void p?.catch(() => {
        if (!mountedRef.current) return;
        if (core === null) { setCoreStatus("failed"); setActivityStatus("failed"); setError(ERROR_TEXT); }
        else setPollError(ERROR_TEXT);
      });
      if (core === null) {
        setCoreStatus((s) => (s === "ready" || s === "failed" ? s : "loading"));
        setActivityStatus((s) => (s === "ready" || s === "failed" ? s : "loading"));
      }
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, from, to]);

  // Activity pagination channel: independent from core/charts.
  const goToPage = useCallback((page: number) => {
    if (page < 0) return;
    setActivityPage(page);
    activityAbortRef.current?.abort();
    const ac = new AbortController();
    activityAbortRef.current = ac;
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    setActivityStatus((s) => (s === "ready" || s === "failed" ? s : "loading"));
    void fetchActivityPage(queryRef.current, page, ACTIVITY_PER_PAGE, ac.signal)
      .then((data) => {
        if (!mountedRef.current || ac.signal.aborted) return;
        setActivity(data);
        setActivityStatus("ready");
      })
      .catch((e) => {
        if (!mountedRef.current || ac.signal.aborted || isAbort(e)) return;
        setActivityStatus("failed");
        if (core === null) setError(ERROR_TEXT);
      })
      .finally(() => clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initialLoading = coreStatus === "loading" && core === null;

  return {
    data: core,
    activity, activityPage, goToPage, activityStatus,
    error: core === null ? error : null,
    pollError,
    lastUpdated,
    loading: initialLoading,
    refreshing,
    reload: manualRefresh,
  };
}

/* ---------------------------------- charts ---------------------------------- */

function LineChart({ points }: { points: AnalyticsOverview["timeseries"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 260;
  const PAD = { l: 44, r: 12, t: 16, b: 28 };
  const series = useMemo(
    () => [
      { key: "pageviews" as const, label: "Page views", color: "var(--color-primary)" },
      { key: "visitors" as const, label: "Unique visitors", color: "var(--color-accent)" },
      { key: "sessions" as const, label: "Sessions", color: "var(--color-success)" },
    ],
    [],
  );
  if (!points.length) return <EmptyState title={DOWN_FOR} />;
  const max = Math.max(1, ...points.map((p) => Math.max(p.pageviews, p.visitors, p.sessions)));
  const x = (i: number) => PAD.l + (i / Math.max(1, points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = 4;
  const hoverPoint = hover !== null ? points[hover] : null;

  return (
    <figure aria-label="Traffic over time" className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-hidden="true" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = (max / ticks) * i;
          const yy = y(v);
          return (
            <g key={i}>
              <line x1={PAD.l} y1={yy} x2={W - PAD.r} y2={yy} stroke="var(--color-border)" strokeDasharray={i === 0 ? "" : "3 4"} strokeWidth="1" />
              <text x={PAD.l - 8} y={yy + 4} textAnchor="end" fontSize="10" fill="var(--color-muted)">{num(Math.round(v))}</text>
            </g>
          );
        })}
        {/* pathLength=1 lets the CSS keyframe draw each line once on first
            mount; later poll-driven point updates do NOT replay the draw. */}
        {series.map((s) => (
          <polyline key={s.key} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" pathLength={1} className="analytics-draw" points={points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(" ")} />
        ))}
        {points.map((p, i) => (
          <rect key={p.t} x={x(i) - (W - PAD.l - PAD.r) / points.length / 2} y={PAD.t} width={(W - PAD.l - PAD.r) / points.length} height={H - PAD.t - PAD.b} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
        {hover !== null ? <line x1={x(hover)} y1={PAD.t} x2={x(hover)} y2={H - PAD.b} stroke="var(--color-border)" /> : null}
        <text x={PAD.l} y={H - 8} fontSize="10" fill="var(--color-muted)">{new Date(points[0].t).toLocaleDateString()}</text>
        <text x={W - PAD.r} y={H - 8} fontSize="10" fill="var(--color-muted)" textAnchor="end">{new Date(points[points.length - 1].t).toLocaleDateString()}</text>
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}{hoverPoint ? `: ${(s.key === "pageviews" ? hoverPoint.pageviews : s.key === "visitors" ? hoverPoint.visitors : hoverPoint.sessions).toLocaleString()}` : ""}
          </span>
        ))}
        {hoverPoint ? <span>{new Date(hoverPoint.t).toLocaleString()}</span> : null}
      </figcaption>
    </figure>
  );
}

const DONUT_COLORS = ["var(--color-primary)", "var(--color-accent)", "var(--color-success)", "var(--color-amber)", "var(--color-orange)", "var(--color-muted)"];

function Donut({ rows, label }: { rows: BreakdownRow[]; label: string }) {
  if (!rows.length || rows.every((r) => r.pageviews === 0)) return <EmptyState title={DOWN_FOR} />;
  const total = rows.reduce((a, r) => a + r.pageviews, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  const segments = rows.reduce<Array<{ row: BreakdownRow; frac: number; offset: number }>>((list, row) => {
    const frac = row.pageviews / total;
    const prev = list.length ? list[list.length - 1]!.offset + list[list.length - 1]!.frac : 0;
    list.push({ row, frac, offset: prev });
    return list;
  }, []);
  return (
    <figure aria-label={label} className="flex flex-wrap items-center gap-6 analytics-enter min-w-0">
      <svg viewBox="0 0 140 140" className="h-36 w-36 shrink-0" role="img" aria-hidden="true">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--color-border)" strokeWidth="16" />
        {segments.map((s, i) => (
          <circle key={s.row.key} cx="70" cy="70" r={R} fill="none" stroke={DONUT_COLORS[i % DONUT_COLORS.length]} strokeWidth="16" strokeDasharray={`${s.frac * C} ${C}`} strokeDashoffset={-(s.offset * C) + C * 0.25} />
        ))}
      </svg>
      <figcaption className="min-w-40 flex-1">
        <ul className="space-y-1.5 text-sm">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center justify-between gap-3">
              <span className="inline-flex min-w-0 items-center gap-2">
                <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                <span className="truncate capitalize">{r.key}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{num(r.pageviews)} · {pct(r.share)}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function HBar({ label, value, max, detail }: { label: string; value: number; max: number; detail?: string }) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,13rem)_1fr_auto]">
      <span className="truncate" title={label}>{label}</span>
      <div className="h-3 min-w-0 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${value}`}>
        <div className="h-full rounded-full bg-primary analytics-bar-fill" style={{ width: `${width}%` }} />
      </div>
      <span className="shrink-0 tabular-nums text-muted-foreground">{num(value)}{detail ? ` · ${detail}` : ""}</span>
    </div>
  );
}

/* ---------------------------------- tables ---------------------------------- */

function PagesTable({ rows, metricHeader, metric }: { rows: PopularPageRow[]; metricHeader: string; metric: (r: PopularPageRow) => number }) {
  if (!rows.length) return <EmptyState title={DOWN_FOR} />;
  return (
    /* Contained horizontal scroll — the PAGE never overflows. */
    <div className="overflow-x-auto">
      <table className="w-full min-w-[20rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-5 py-2.5 font-medium">Page</th>
            <th className="px-5 py-2.5 text-right font-medium">{metricHeader}</th>
            <th className="px-5 py-2.5 text-right font-medium">Unique visitors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.path} className="border-b last:border-0">
              <td className="max-w-0 truncate px-5 py-2.5 font-mono text-xs" title={r.path}>{r.path}</td>
              <td className="px-5 py-2.5 text-right tabular-nums">{num(metric(r))}</td>
              <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">{num(r.uniqueVisitors)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function downloadCsv(name: string, rows: string[][]): void {
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Delta({ current, previous }: { current: number | null | undefined; previous: number | null | undefined }) {
  if (previous === null || previous === undefined || current === null || current === undefined) {
    return <span className="text-muted-foreground">No previous period</span>;
  }
  const diff = current - previous;
  const tone = diff > 0 ? "text-success" : diff < 0 ? "text-danger" : "text-muted-foreground";
  return <span className={tone}>{diff > 0 ? "▲" : diff < 0 ? "▼" : "="} {num(Math.abs(diff))} vs previous period</span>;
}

/* ---------------------------------- page ---------------------------------- */

export function AdminAnalyticsClient() {
  const [preset, setPreset] = useState<Preset>("30");
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const { data, activity, activityPage, goToPage, activityStatus, error, pollError, lastUpdated, loading, refreshing, reload } =
    useAnalytics(preset, from, to);

  const ov = data?.overview ?? null;
  const productTotals = useMemo(() => {
    if (!ov) return null;
    return ov.productTimeseries.reduce(
      (a, p) => ({
        registrations: a.registrations + p.registrations,
        auditsCreated: a.auditsCreated + p.auditsCreated,
        auditsCompleted: a.auditsCompleted + p.auditsCompleted,
        auditsFailed: a.auditsFailed + p.auditsFailed,
        reportsExported: a.reportsExported + p.reportsExported,
      }),
      { registrations: 0, auditsCreated: 0, auditsCompleted: 0, auditsFailed: 0, reportsExported: 0 },
    );
  }, [ov]);

  const activityRows = activity?.rows ?? [];
  const activityTotal = activity?.total ?? 0;

  const setRange = (p: Preset) => {
    setPreset(p);
    goToPage(0);
  };

  return (
    <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 space-y-6 overflow-x-clip px-4 py-8 sm:px-6">
      <div className="analytics-enter">
        <PageHeader
          title="Site statistics"
          description="Private first-party analytics. Numbers come from server-side records — nothing is estimated except unique visitors, which are first-party-browser estimates."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-border/80 p-0.5" role="group" aria-label="Period">
                {(["7", "30", "90"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setRange(d)}
                    aria-pressed={preset === d}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${preset === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {d}d
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setRange("custom")}
                  aria-pressed={preset === "custom"}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${preset === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  Custom
                </button>
              </div>
              {preset === "custom" ? (
                <>
                  <Input type="date" value={from} max={today} onChange={(e) => { setFrom(e.target.value); goToPage(0); }} aria-label="From date" className="w-auto" />
                  <Input type="date" value={to} max={today} onChange={(e) => { setTo(e.target.value); goToPage(0); }} aria-label="To date" className="w-auto" />
                </>
              ) : null}
              {/* One click = exactly one refresh; spinner appears only for a
                  manual click or the initial load — never for background polls. */}
              <Button variant="secondary" size="sm" onClick={reload} disabled={refreshing || loading} aria-label="Refresh statistics" aria-busy={refreshing || loading}>
                {refreshing || loading ? <Spinner className="size-4" /> : null} Refresh
              </Button>
            </div>
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span aria-live="polite">{lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}` : "Loading…"}</span>
        <span>Refreshes every {POLL_MS / 1000} seconds while this tab is visible.</span>
        {pollError ? <span className="text-warning">Last refresh failed — showing the most recent successful data.</span> : null}
      </div>

      {error ? <Alert tone="warning" title="Statistics temporarily unavailable">{error}</Alert> : null}
      {!ov && !loading && !error ? <Alert tone="info" title="No traffic recorded yet">{"Once the site receives visits, they will appear here."}</Alert> : null}

      {/* Row A — summary cards (staggered entrance, plays once) */}
      <section aria-label="Summary" className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {[
          <Stat key="uv" label="Unique visitors" value={num(ov?.totals.uniqueVisitors.current)} hint={<Delta current={ov?.totals.uniqueVisitors.current} previous={ov?.totals.uniqueVisitors.previous} />} />,
          <Stat key="se" label="Sessions" value={num(ov?.totals.sessions.current)} hint={<Delta current={ov?.totals.sessions.current} previous={ov?.totals.sessions.previous} />} />,
          <Stat key="pv" label="Page views" value={num(ov?.totals.pageviews.current)} hint={<Delta current={ov?.totals.pageviews.current} previous={ov?.totals.pageviews.previous} />} />,
          <Stat key="na" label="New accounts" value={num(ov?.totals.newRegistrations.current)} hint={<Delta current={ov?.totals.newRegistrations.current} previous={ov?.totals.newRegistrations.previous} />} />,
          <Stat key="ac" label="Audits completed" value={num(ov?.totals.auditsCompleted.current)} hint={<Delta current={ov?.totals.auditsCompleted.current} previous={ov?.totals.auditsCompleted.previous} />} />,
          <Stat
            key="rr"
            label="Returning rate"
            value={pct(ov?.totals.returningRate.current)}
            hint={ov ? `${num(ov.totals.returningRate.numerator)} of ${num(ov.totals.returningRate.denominator)} visitors had visited before` : undefined}
          />,
        ].map((el, i) => (
          <div key={el.key} className="analytics-enter" style={{ animationDelay: `${i * 45}ms` }}>{el}</div>
        ))}
      </section>

      {/* Row B — traffic chart */}
      <Card className="min-w-0 analytics-enter" style={{ animationDelay: "120ms" }}>
        <CardHeader
          title="Traffic"
          description={ov ? `${ov.range.bucket === "hour" ? "Hourly" : "Daily"} totals, UTC` : undefined}
          action={
            ov && ov.timeseries.length ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  downloadCsv(
                    `siteinsight-traffic-${Date.now()}.csv`,
                    [["bucket_start_utc", "unique_visitors", "sessions", "pageviews"], ...ov.timeseries.map((p) => [p.t, String(p.visitors), String(p.sessions), String(p.pageviews)])],
                  )
                }
              >
                Export CSV
              </Button>
            ) : undefined
          }
        />
        <div className="min-w-0 p-5">{ov ? <LineChart points={ov.timeseries} /> : <div className="h-64 animate-pulse rounded-lg bg-muted" />}</div>
      </Card>

      {/* Row C — sources + devices */}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Card className="min-w-0 analytics-enter" style={{ animationDelay: "160ms" }}>
          <CardHeader title="Traffic sources" description="Direct, search, social, referral and campaign traffic" />
          <div className="min-w-0 p-5">{ov ? <Donut rows={ov.sources} label="Traffic sources" /> : <div className="h-40 animate-pulse rounded-lg bg-muted" />}</div>
        </Card>
        <Card className="min-w-0 analytics-enter" style={{ animationDelay: "200ms" }}>
          <CardHeader title="Devices" description="Visitor device classes" />
          <div className="min-w-0 p-5">{ov ? <Donut rows={ov.devices} label="Devices" /> : <div className="h-40 animate-pulse rounded-lg bg-muted" />}</div>
        </Card>
      </div>

      {/* Row D — pages */}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Card className="min-w-0 analytics-enter" style={{ animationDelay: "240ms" }}>
          <CardHeader title="Popular pages" description="Most viewed pages (top 10)" />
          {data ? <PagesTable rows={data.popular.rows} metricHeader="Views" metric={(r) => r.pageviews} /> : <div className="h-48 animate-pulse p-5" />}
        </Card>
        <Card className="min-w-0 analytics-enter" style={{ animationDelay: "280ms" }}>
          <CardHeader title="Landing pages" description="First page of each session (top 10)" />
          {data ? <PagesTable rows={data.landings.rows} metricHeader="Landings" metric={(r) => r.sessions} /> : <div className="h-48 animate-pulse p-5" />}
        </Card>
      </div>

      {/* Row E — product usage */}
      <Card className="min-w-0 analytics-enter" style={{ animationDelay: "320ms" }}>
        <CardHeader title="Product usage" description="Authoritative records for the selected period" />
        <div className="space-y-3 p-5">
          {productTotals ? (
            (() => {
              const rows = [
                { label: "New accounts", value: productTotals.registrations },
                { label: "Audits created", value: productTotals.auditsCreated },
                { label: "Audits completed", value: productTotals.auditsCompleted },
                { label: "Audits failed", value: productTotals.auditsFailed },
                { label: "PDF reports exported", value: productTotals.reportsExported },
              ];
              const max = Math.max(1, ...rows.map((r) => r.value));
              return rows.every((r) => r.value === 0) ? <EmptyState title={DOWN_FOR} /> : rows.map((r) => <HBar key={r.label} label={r.label} value={r.value} max={max} />);
            })()
          ) : (
            <div className="h-32 animate-pulse rounded-lg bg-muted" />
          )}
        </div>
      </Card>

      {/* Row F — conversions */}
      <Card className="min-w-0 analytics-enter" style={{ animationDelay: "360ms" }}>
        <CardHeader title="Conversions" description="Numerator and denominator for every rate are shown — no invented percentages" />
        <div className="space-y-4 p-5">
          {ov ? (
            ov.conversions.length ? (
              ov.conversions.map((c) => (
                <div key={c.id}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium">{c.label}</p>
                    <p className="shrink-0 text-sm tabular-nums">
                      <span className="font-semibold">{pct(c.rate)}</span>{" "}
                      <span className="text-muted-foreground">({num(c.numerator)} of {num(c.denominator)})</span>
                    </p>
                  </div>
                  <div className="mt-1.5 h-2.5 min-w-0 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${c.label}: ${pct(c.rate)}`}>
                    <div className="h-full rounded-full bg-accent analytics-bar-fill" style={{ width: c.rate === null ? "0%" : `${Math.max(1, c.rate * 100)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{c.definition}</p>
                </div>
              ))
            ) : (
              <EmptyState title={DOWN_FOR} />
            )
          ) : (
            <div className="h-28 animate-pulse rounded-lg bg-muted" />
          )}
        </div>
      </Card>

      {/* Row G — recent activity (independent pagination channel) */}
      <Card className="min-w-0 analytics-enter" style={{ animationDelay: "400ms" }}>
        <CardHeader
          title="Recent activity"
          description="Privacy-conscious event feed — no emails, IPs or visitor identifiers"
          action={
            activityTotal > 0 ? (
              <div className="flex items-center gap-2 text-sm">
                <Button variant="ghost" size="sm" disabled={activityPage === 0 || activityStatus === "loading"} onClick={() => goToPage(activityPage - 1)}>Previous</Button>
                <span className="tabular-nums text-muted-foreground">Page {activityPage + 1}{activityStatus === "loading" ? " ·" : ""}</span>
                <Button variant="ghost" size="sm" disabled={(activityPage + 1) * ACTIVITY_PER_PAGE >= activityTotal || activityRows.length < ACTIVITY_PER_PAGE || activityStatus === "loading"} onClick={() => goToPage(activityPage + 1)}>Next</Button>
              </div>
            ) : undefined
          }
        />
        {activityRows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Time</th>
                  <th className="px-5 py-2.5 font-medium">Event</th>
                  <th className="px-5 py-2.5 font-medium">Page</th>
                  <th className="px-5 py-2.5 font-medium">Source</th>
                  <th className="px-5 py-2.5 font-medium">Device</th>
                  <th className="hidden px-5 py-2.5 font-medium md:table-cell">Browser / OS</th>
                </tr>
              </thead>
              <tbody>
                {activityRows.map((e, i) => (
                  <tr key={`${e.createdAt}-${i}`} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-5 py-2.5 tabular-nums text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className="px-5 py-2.5"><Badge className="border-border bg-muted text-secondary">{e.eventType === "pageview" ? "Page view" : "Session start"}</Badge></td>
                    <td className="max-w-0 truncate px-5 py-2.5 font-mono text-xs" title={e.path}>{e.path}</td>
                    <td className="px-5 py-2.5 capitalize">{e.source}{e.referrerHost ? <span className="text-muted-foreground">{` · ${e.referrerHost}`}</span> : null}</td>
                    <td className="px-5 py-2.5 capitalize">{e.device}</td>
                    <td className="hidden px-5 py-2.5 text-muted-foreground md:table-cell">{e.browser} / {e.os}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : activityStatus === "loading" ? (
          <div className="h-40 animate-pulse p-5" />
        ) : (
          <EmptyState title={DOWN_FOR} />
        )}
      </Card>

      <p className="pb-6 text-xs text-muted-foreground">
        Privacy: events store hashed visitor/session ids and device classes only — never emails, IP addresses or query parameters. Counts of unique visitors are first-party-browser estimates.
      </p>
    </main>
  );
}

/* Named exports for the SSR markup assertions in tests/analytics-refresh.test.ts
   (pure presentational components — no behavior change). */
export const __LineChartForTest = LineChart;
export const __HBarForTest = HBar;
export const __DonutForTest = Donut;
export { PagesTable };
