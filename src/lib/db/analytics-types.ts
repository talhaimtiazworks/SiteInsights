import type { DeviceCategory, TrafficSource } from "../analytics/classify";

/**
 * Analytics data model (shared by the memory and PostgreSQL implementations).
 *
 * COUNTING DEFINITIONS (single source of truth — docs/ANALYTICS.md repeats them):
 *  - Event: a validated client-reported interaction. Only "pageview" and
 *    "session_start" exist today; both carry visitor/session hashes.
 *  - Unique visitor: distinct visitor_hash in the range (first-party id stored
 *    in the visitor's own browser; an estimate, never a cross-device identity).
 *  - Session: distinct session_hash in the range. The client rotates the
 *    session id after 30 minutes of inactivity (documented client timeout).
 *  - Page view: 1 event of type "pageview". Hydration/remount duplicates are
 *    suppressed by client mount flags; retry/back-pressure duplicates are
 *    deduplicated on the server by client_event_id (unique).
 *  - Returning visitor: a visitor_hash with any event strictly before the
 *    range start that also has ≥1 pageview inside the range.
 *  - Landing page: path of the session's earliest pageview in the range.
 *  - Attribution: every event carries the session's classified source bucket
 *    (direct/search/social/referral/campaign); counts are per-event.
 */

export type AnalyticsEventType = "pageview" | "session_start";

export interface AnalyticsEventInsert {
  /** Client-generated UUID; unique constraint gives at-least-once delivery without duplicates. */
  clientEventId: string;
  /** HMAC-derived hashes — raw ids never leave the client environment in plaintext storage. */
  visitorHash: string;
  sessionHash: string;
  eventType: AnalyticsEventType;
  path: string;
  referrerHost: string | null;
  source: TrafficSource;
  device: DeviceCategory;
  browser: string;
  os: string;
  /** Client-side timestamp (validated to be within a sane drift). */
  at?: Date;
}

export interface AnalyticsEventRow extends Required<Omit<AnalyticsEventInsert, "at">> {
  createdAt: Date;
}

export type AnalyticsBucket = "hour" | "day";

export interface AnalyticsRange {
  from: Date;
  to: Date;
  bucket: AnalyticsBucket;
}

export interface TimeseriesPoint {
  /** Bucket start (UTC ISO). */
  t: string;
  visitors: number;
  sessions: number;
  pageviews: number;
}

export interface BreakdownRow {
  key: string;
  pageviews: number;
  visitors: number;
  sessions: number;
  /** Share of total pageviews (0–1), computed from real counts. Null when the total is 0. */
  share: number | null;
}

export interface PopularPageRow {
  path: string;
  pageviews: number;
  uniqueVisitors: number;
  sessions: number;
}

export interface RecentActivityRow {
  /** Privacy-conscious — no visitor id, no IP, no email. */
  eventType: AnalyticsEventType;
  path: string;
  device: DeviceCategory;
  browser: string;
  os: string;
  source: TrafficSource;
  referrerHost: string | null;
  createdAt: string;
}

export interface PeriodComparison {
  current: number;
  /** Null when the previous period cannot support a comparison (no baseline). Never fabricated. */
  previous: number | null;
  delta: number | null;
}

export interface ProductTimeseriesPoint {
  t: string;
  registrations: number;
  auditsCreated: number;
  auditsCompleted: number;
  auditsFailed: number;
  reportsExported: number;
}

export interface ConversionMetric {
  id: string;
  label: string;
  /** 0–1, or null when the denominator is 0 (undefined, never a fabricated score). */
  rate: number | null;
  numerator: number;
  denominator: number;
  definition: string;
}

export interface AnalyticsOverview {
  range: { from: string; to: string; bucket: AnalyticsBucket };
  generatedAt: string;
  totals: {
    uniqueVisitors: PeriodComparison;
    sessions: PeriodComparison;
    pageviews: PeriodComparison;
    newRegistrations: PeriodComparison;
    auditsCompleted: PeriodComparison;
    returningRate: { current: number | null; previous: number | null; numerator: number; denominator: number };
  };
  timeseries: TimeseriesPoint[];
  sources: BreakdownRow[];
  devices: BreakdownRow[];
  productTimeseries: ProductTimeseriesPoint[];
  conversions: ConversionMetric[];
}

export interface AnalyticsRepository {
  /** Inserts one event; returns false when clientEventId was already stored (duplicate delivery is not an error). */
  insertEvent(e: AnalyticsEventInsert): Promise<boolean>;
  /** Aggregated overview for the dashboard. Buckets are UTC; ranges are [from, to]. */
  overview(range: AnalyticsRange): Promise<AnalyticsOverview>;
  landingPages(range: AnalyticsRange, limit: number, offset: number): Promise<{ rows: PopularPageRow[]; total: number }>;
  popularPages(range: AnalyticsRange, limit: number, offset: number): Promise<{ rows: PopularPageRow[]; total: number }>;
  recentActivity(range: AnalyticsRange, limit: number, offset: number): Promise<{ rows: RecentActivityRow[]; total: number }>;
  /** Earliest recorded non-direct source for a session (attribution carry-forward for in-session pageviews). */
  sessionSource(sessionHash: string): Promise<TrafficSource | null>;
  /** How many tracked events exist before a timestamp (used for previous-period comparison sufficiency). */
  countEventsBefore(when: Date): Promise<number>;
}

// ─── Shared in-memory aggregation (used by the memory impl and unit tests) ──

export function zeroSeries(range: AnalyticsRange): Map<string, { visitors: Set<string>; sessions: Set<string>; pageviews: number }> {
  const map = new Map<string, { visitors: Set<string>; sessions: Set<string>; pageviews: number }>();
  const step = range.bucket === "hour" ? 3_600_000 : 86_400_000;
  const start = step === 3_600_000 ? Math.floor(range.from.getTime() / step) * step : HmUTCDay(range.from);
  for (let t = start; t <= range.to.getTime(); t += step) {
    map.set(new Date(t).toISOString(), { visitors: new Set(), sessions: new Set(), pageviews: 0 });
  }
  return map;
}

function HmUTCDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function bucketStart(t: Date, bucket: AnalyticsBucket): string {
  if (bucket === "hour") return new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000).toISOString();
  return new Date(HmUTCDay(t)).toISOString();
}

/** Aggregates an event slice into the shared overview shape. Single implementation for memory + tests. */
export function aggregateOverview(args: {
  range: AnalyticsRange;
  events: AnalyticsEventRow[]; // only those inside the range
  firstEventTimes: Map<string, number>; // visitorHash → earliest known event time (any range; epoch ms)
  previousPeriod: { uniqueVisitors: number; sessions: number; pageviews: number } | null;
  product: ProductTimeseriesPoint[];
  conversions: ConversionMetric[];
  productTotals: { newRegistrations: PeriodComparison; auditsCompleted: PeriodComparison };
}): AnalyticsOverview {
  const { range, events } = args;
  const series = zeroSeries(range);
  const visitors = new Set<string>();
  const sessions = new Set<string>();
  let pageviews = 0;

  const srcMap = new Map<string, { pageviews: number; visitors: Set<string>; sessions: Set<string> }>();
  const devMap = new Map<string, { pageviews: number; visitors: Set<string>; sessions: Set<string> }>();
  const addB = (map: Map<string, { pageviews: number; visitors: Set<string>; sessions: Set<string> }>, key: string, e: AnalyticsEventRow) => {
    let b = map.get(key);
    if (!b) { b = { pageviews: 0, visitors: new Set(), sessions: new Set() }; map.set(key, b); }
    b.visitors.add(e.visitorHash);
    b.sessions.add(e.sessionHash);
    if (e.eventType === "pageview") b.pageviews += 1;
  };

  let returning = 0;
  const seenReturning = new Set<string>();
  for (const e of events) {
    visitors.add(e.visitorHash);
    sessions.add(e.sessionHash);
    if (e.eventType === "pageview") pageviews += 1;
    const key = bucketStart(e.createdAt, range.bucket);
    const s = series.get(key);
    if (s) {
      s.visitors.add(e.visitorHash);
      s.sessions.add(e.sessionHash);
      if (e.eventType === "pageview") s.pageviews += 1;
    }
    addB(srcMap, e.source, e);
    addB(devMap, e.device, e);
    const first = args.firstEventTimes.get(e.visitorHash);
    if (e.eventType === "pageview" && first !== undefined && first < range.from.getTime() && !seenReturning.has(e.visitorHash)) {
      returning += 1;
      seenReturning.add(e.visitorHash);
    }
  }

  const breakdown = (m: Map<string, { pageviews: number; visitors: Set<string>; sessions: Set<string> }>): BreakdownRow[] =>
    [...m.entries()].map(([key, v]) => ({
      key,
      pageviews: v.pageviews,
      visitors: v.visitors.size,
      sessions: v.sessions.size,
      share: pageviews > 0 ? v.pageviews / pageviews : null,
    })).sort((a, b) => b.pageviews - a.pageviews || a.key.localeCompare(b.key));

  const cmp = (current: number, prev: { uniqueVisitors: number; sessions: number; pageviews: number } | null, key: "uniqueVisitors" | "sessions" | "pageviews"): PeriodComparison => {
    const previous = prev ? prev[key] : null;
    return { current, previous, delta: previous === null ? null : current - previous };
  };

  // Previous-period returning-rate numerator/denominator need the deep tables; report current only.
  const unique = visitors.size;
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), bucket: range.bucket },
    generatedAt: new Date().toISOString(),
    totals: {
      uniqueVisitors: cmp(unique, args.previousPeriod, "uniqueVisitors"),
      sessions: cmp(sessions.size, args.previousPeriod, "sessions"),
      pageviews: cmp(pageviews, args.previousPeriod, "pageviews"),
      newRegistrations: args.productTotals.newRegistrations,
      auditsCompleted: args.productTotals.auditsCompleted,
      returningRate: { current: unique > 0 ? returning / unique : null, previous: null, numerator: returning, denominator: unique },
    },
    timeseries: [...series.entries()].map(([t, v]) => ({ t, visitors: v.visitors.size, sessions: v.sessions.size, pageviews: v.pageviews })),
    sources: breakdown(srcMap),
    devices: breakdown(devMap),
    productTimeseries: args.product,
    conversions: args.conversions,
  };
}

export function aggregatePopular(events: AnalyticsEventRow[], limit: number, offset: number): { rows: PopularPageRow[]; total: number } {
  const byPath = new Map<string, { pageviews: number; visitors: Set<string>; sessions: Set<string> }>();
  for (const e of events) {
    let p = byPath.get(e.path);
    if (!p) { p = { pageviews: 0, visitors: new Set(), sessions: new Set() }; byPath.set(e.path, p); }
    p.visitors.add(e.visitorHash);
    p.sessions.add(e.sessionHash);
    if (e.eventType === "pageview") p.pageviews += 1;
  }
  const rows = [...byPath.entries()]
    .filter(([, p]) => p.pageviews > 0)
    .sort((a, b) => b[1].pageviews - a[1].pageviews || a[0].localeCompare(b[0]))
    .slice(offset, offset + limit)
    .map(([path, p]) => ({ path, pageviews: p.pageviews, uniqueVisitors: p.visitors.size, sessions: p.sessions.size }));
  return { rows, total: byPath.size };
}

/** Landing page = earliest pageview path per session (in range). */
export function aggregateLandings(events: AnalyticsEventRow[], limit: number, offset: number): { rows: PopularPageRow[]; total: number } {
  const firstSeen = new Map<string, string>(); // sessionHash → earliest path
  const stamp = new Map<string, number>();
  for (const e of events.filter((x) => x.eventType === "pageview")) {
    const t = e.createdAt.getTime();
    if (!stamp.has(e.sessionHash) || t < stamp.get(e.sessionHash)!) {
      stamp.set(e.sessionHash, t);
      firstSeen.set(e.sessionHash, e.path);
    }
  }
  const counts = new Map<string, number>();
  for (const path of firstSeen.values()) counts.set(path, (counts.get(path) ?? 0) + 1);
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(offset, offset + limit)
    .map(([path, sessions]) => ({ path, pageviews: sessions, uniqueVisitors: sessions, sessions }));
  return { rows, total: counts.size };
}
