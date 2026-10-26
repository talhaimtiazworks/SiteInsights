import type { Sql } from "postgres";
import type {
  AnalyticsBucket, AnalyticsEventInsert, AnalyticsEventRow, AnalyticsOverview, AnalyticsRange, AnalyticsRepository,
  BreakdownRow, ConversionMetric, PopularPageRow, ProductTimeseriesPoint, RecentActivityRow, TimeseriesPoint,
} from "./analytics-types";

type Runner = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

/**
 * Product-metric queries degrade to empty slices (traffic analytics still render),
 * but the failure is logged server-side with the sanitized DB message so silent
 * drift (wrong table/column) is diagnosable without exposing data.
 */
function tolerated<T extends Record<string, unknown>[]>(err: unknown, fallback: T): T {
  const msg = err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 200) : String(err).slice(0, 200);
  console.error("[analytics] tolerated_query_failure", JSON.stringify({ message: msg }));
  return fallback;
}


/**
 * PostgreSQL analytics repository. All aggregation executes server-side in SQL
 * over bounded date ranges; the browser only ever receives the aggregates.
 */
export class PostgresAnalytics implements AnalyticsRepository {
  constructor(private run: Runner) {}

  async insertEvent(e: AnalyticsEventInsert): Promise<boolean> {
    return this.run(async (sql) => {
      const rows = await sql`
        INSERT INTO analytics_events
          (id, client_event_id, visitor_hash, session_hash, event_type, path, referrer_host, source, device, browser, os, created_at)
        VALUES
          (${crypto.randomUUID()}, ${e.clientEventId}, ${e.visitorHash}, ${e.sessionHash}, ${e.eventType}, ${e.path}, ${e.referrerHost}, ${e.source}, ${e.device}, ${e.browser}, ${e.os}, ${(e.at ?? new Date()).toISOString()})
        ON CONFLICT (client_event_id) DO NOTHING
        RETURNING id`;
      return rows.length > 0;
    });
  }

  async countEventsBefore(when: Date): Promise<number> {
    return this.run(async (sql) => {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::bigint AS n FROM analytics_events WHERE created_at < ${when.toISOString()}`;
      return Number(rows[0]?.n ?? 0);
    });
  }

  private zeroSeries(range: AnalyticsRange): Map<string, TimeseriesPoint> {
    const map = new Map<string, TimeseriesPoint>();
    const step = range.bucket === "hour" ? 3_600_000 : 86_400_000;
    const start = range.bucket === "hour" ? Math.floor(range.from.getTime() / step) * step : Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate());
    for (let t = start; t <= range.to.getTime(); t += step) {
      const iso = new Date(t).toISOString();
      map.set(iso, { t: iso, visitors: 0, sessions: 0, pageviews: 0 });
    }
    return map;
  }

  private zeroProductSeries(range: AnalyticsRange): Map<string, ProductTimeseriesPoint> {
    const map = new Map<string, ProductTimeseriesPoint>();
    const step = range.bucket === "hour" ? 3_600_000 : 86_400_000;
    const start = range.bucket === "hour" ? Math.floor(range.from.getTime() / step) * step : Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate());
    for (let t = start; t <= range.to.getTime(); t += step) {
      const iso = new Date(t).toISOString();
      map.set(iso, { t: iso, registrations: 0, auditsCreated: 0, auditsCompleted: 0, auditsFailed: 0, reportsExported: 0 });
    }
    return map;
  }

  private bucketExpr(bucket: AnalyticsBucket): string {
    return bucket === "hour" ? "date_trunc('hour', created_at)" : "date_trunc('day', created_at AT TIME ZONE 'UTC')";
  }

  async sessionSource(sessionHash: string): Promise<import("../analytics/classify").TrafficSource | null> {
    return this.run(async (sql) => {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT source FROM analytics_events WHERE session_hash = ${sessionHash} ORDER BY created_at ASC LIMIT 1`;
      return rows.length ? (String(rows[0]!.source) as import("../analytics/classify").TrafficSource) : null;
    });
  }

  async overview(range: AnalyticsRange): Promise<AnalyticsOverview> {
    const bucket = this.bucketExpr(range.bucket);
    return this.run(async (sql) => {
      const from = range.from.toISOString();
      const to = range.to.toISOString();
      const dur = range.to.getTime() - range.from.getTime();
      const prevFrom = new Date(range.from.getTime() - dur).toISOString();

      type Row = Record<string, unknown>;
      const [totalsRows, prevTotalsRows, returningRows, srcRows, devRows, productRows] = await Promise.all([
        sql<Row[]>`
          SELECT count(DISTINCT visitor_hash)::bigint AS unique_visitors,
                 count(DISTINCT session_hash)::bigint AS sessions,
                 count(*) FILTER (WHERE event_type = 'pageview')::bigint AS pageviews
          FROM analytics_events WHERE created_at >= ${from} AND created_at <= ${to}`,
        sql<Row[]>`
          SELECT count(DISTINCT visitor_hash)::bigint AS unique_visitors,
                 count(DISTINCT session_hash)::bigint AS sessions,
                 count(*) FILTER (WHERE event_type = 'pageview')::bigint AS pageviews
          FROM analytics_events WHERE created_at >= ${prevFrom} AND created_at < ${from}`,
        sql<Row[]>`
          SELECT count(DISTINCT visitor_hash)::bigint AS returning
          FROM analytics_events
          WHERE created_at >= ${from} AND created_at <= ${to}
            AND event_type = 'pageview'
            AND visitor_hash IN (SELECT DISTINCT visitor_hash FROM analytics_events WHERE created_at < ${from})`,
        sql<Row[]>`
          SELECT source AS key,
                 count(*) FILTER (WHERE event_type = 'pageview')::bigint AS pageviews,
                 count(DISTINCT visitor_hash)::bigint AS visitors,
                 count(DISTINCT session_hash)::bigint AS sessions
          FROM analytics_events WHERE created_at >= ${from} AND created_at <= ${to}
          GROUP BY source`,
        sql<Row[]>`
          SELECT device AS key,
                 count(*) FILTER (WHERE event_type = 'pageview')::bigint AS pageviews,
                 count(DISTINCT visitor_hash)::bigint AS visitors,
                 count(DISTINCT session_hash)::bigint AS sessions
          FROM analytics_events WHERE created_at >= ${from} AND created_at <= ${to}
          GROUP BY device`,
        Promise.all([
          sql<Row[]>`SELECT to_char(date_trunc(${range.bucket === "hour" ? "hour" : "day"}, created_at)::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t, count(*)::bigint AS n
                     FROM profiles WHERE created_at >= ${from} AND created_at <= ${to} GROUP BY 1`.catch((e) => tolerated<Row[]>(e, [])),
          sql<Row[]>`SELECT to_char(date_trunc(${range.bucket === "hour" ? "hour" : "day"}, created_at)::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t, count(*)::bigint AS n
                     FROM audits WHERE created_at >= ${from} AND created_at <= ${to} GROUP BY 1`.catch((e) => tolerated<Row[]>(e, [])),
          sql<Row[]>`SELECT to_char(date_trunc(${range.bucket === "hour" ? "hour" : "day"}, finished_at)::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t, count(*)::bigint AS n
                     FROM audits WHERE finished_at >= ${from} AND finished_at <= ${to} AND status IN ('completed','completed_with_warnings') GROUP BY 1`.catch((e) => tolerated<Row[]>(e, [])),
          sql<Row[]>`SELECT to_char(date_trunc(${range.bucket === "hour" ? "hour" : "day"}, finished_at)::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t, count(*)::bigint AS n
                     FROM audits WHERE finished_at >= ${from} AND finished_at <= ${to} AND status = 'failed' GROUP BY 1`.catch((e) => tolerated<Row[]>(e, [])),
          sql<Row[]>`SELECT to_char(date_trunc(${range.bucket === "hour" ? "hour" : "day"}, created_at)::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t, coalesce(sum(amount),0)::bigint AS n
                     FROM usage_records WHERE kind = 'pdf_export' AND created_at >= ${from} AND created_at <= ${to} GROUP BY 1`.catch((e) => tolerated<Row[]>(e, [])),
          sql<Row[]>`SELECT count(*)::bigint AS n FROM profiles WHERE created_at >= ${from} AND created_at <= ${to}`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(*)::bigint AS n FROM profiles WHERE created_at >= ${prevFrom} AND created_at < ${from}`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(*)::bigint AS n FROM audits WHERE finished_at >= ${from} AND finished_at <= ${to} AND status IN ('completed','completed_with_warnings')`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(*)::bigint AS n FROM audits WHERE finished_at >= ${prevFrom} AND finished_at < ${from} AND status IN ('completed','completed_with_warnings')`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(DISTINCT p.id)::bigint AS n FROM profiles p
                     WHERE p.created_at >= ${from} AND p.created_at <= ${to}
                       AND EXISTS (SELECT 1 FROM audits a WHERE a.principal_id = 'user:' || p.id::text AND a.created_at <= ${to})`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(*)::bigint AS n FROM audits WHERE created_at >= ${from} AND created_at <= ${to}`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(*)::bigint AS n FROM audits WHERE created_at >= ${from} AND created_at <= ${to} AND status IN ('completed','completed_with_warnings')`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(DISTINCT a.principal_id)::bigint AS n FROM audits a
                     WHERE a.finished_at >= ${from} AND a.finished_at <= ${to} AND a.status IN ('completed','completed_with_warnings')`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
          sql<Row[]>`SELECT count(DISTINCT a.principal_id)::bigint AS n FROM audits a
                     WHERE a.finished_at >= ${from} AND a.finished_at <= ${to} AND a.status IN ('completed','completed_with_warnings')
                       AND EXISTS (SELECT 1 FROM usage_records u WHERE u.principal_id = a.principal_id AND u.kind = 'pdf_export' AND u.created_at >= ${from} AND u.created_at <= ${to})`.catch((e) => tolerated<Row[]>(e, [{ n: "0" }])),
        ]),
      ]);

      const ts: TimeseriesPoint[] = [];
      const series = this.zeroSeries(range);
      // Timeseries of visitors/sessions/pageviews per bucket.
      const tsRows = await sql<Row[]>`
        SELECT to_char(date_trunc(${range.bucket === "hour" ? "hour" : "day"}, created_at)::timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
               count(DISTINCT visitor_hash)::bigint AS visitors,
               count(DISTINCT session_hash)::bigint AS sessions,
               count(*) FILTER (WHERE event_type = 'pageview')::bigint AS pageviews
        FROM analytics_events
        WHERE created_at >= ${from} AND created_at <= ${to}
        GROUP BY 1`;
      for (const r of tsRows) {
        const p = series.get(String(r.t));
        if (p) {
          p.visitors = Number(r.visitors);
          p.sessions = Number(r.sessions);
          p.pageviews = Number(r.pageviews);
        }
      }
      ts.push(...series.values());

      const totals = totalsRows[0] ?? {};
      const prevTotals = prevTotalsRows[0] ?? {};
      const unique = Number(totals.unique_visitors ?? 0);
      const sessionsT = Number(totals.sessions ?? 0);
      const viewsT = Number(totals.pageviews ?? 0);
      const prevUnique = prevTotals.unique_visitors !== undefined ? Number(prevTotals.unique_visitors) : null;
      const prevSessions = prevTotals.sessions !== undefined ? Number(prevTotals.sessions) : null;
      const prevViews = prevTotals.pageviews !== undefined ? Number(prevTotals.pageviews) : null;
      const returning = Number(returningRows[0]?.returning ?? 0);
      const hasPrev = !!(prevTotals.unique_visitors !== undefined || prevTotals.sessions !== undefined || prevTotals.pageviews !== undefined) && (Number(prevUnique) + Number(prevSessions) + Number(prevViews)) > 0;
      const cmp = (current: number, previous: number | null) => ({ current, previous: previous === null ? null : previous, delta: previous === null ? null : current - previous });

      const [regsSeries, auditsCreatedSeries, auditsDoneSeries, auditsFailedSeries, exportsSeries, regsNow, regsPrev, compNow, compPrev, convRegsWithAudit, convCreated, convCompleted, convOwners, convConverted] = productRows;

      const toBreakdown = (rows: Row[], total: number): BreakdownRow[] =>
        rows
          .map((r) => ({
            key: String(r.key),
            pageviews: Number(r.pageviews),
            visitors: Number(r.visitors),
            sessions: Number(r.sessions),
            share: total > 0 ? Number(r.pageviews) / total : null,
          }))
          .sort((a, b) => b.pageviews - a.pageviews || a.key.localeCompare(b.key));

      const productSeries = this.zeroProductSeries(range);
      const applySeries = (rows: Row[], pick: (p: ProductTimeseriesPoint, n: number) => void) => {
        for (const r of rows) {
          const p = productSeries.get(String(r.t));
          if (p) pick(p, Number(r.n));
        }
      };
      applySeries(regsSeries as Row[], (p, n) => { p.registrations = n; });
      applySeries(auditsCreatedSeries as Row[], (p, n) => { p.auditsCreated = n; });
      applySeries(auditsDoneSeries as Row[], (p, n) => { p.auditsCompleted = n; });
      applySeries(auditsFailedSeries as Row[], (p, n) => { p.auditsFailed = n; });
      applySeries(exportsSeries as Row[], (p, n) => { p.reportsExported = n; });

      const regs = Number((regsNow as Row[])[0]?.n ?? 0);
      const regsP = Number((regsPrev as Row[])[0]?.n ?? 0);
      const auditsDone = Number((compNow as Row[])[0]?.n ?? 0);
      const auditsDoneP = Number((compPrev as Row[])[0]?.n ?? 0);
      const convRegsWithAuditN = Number((convRegsWithAudit as Row[])[0]?.n ?? 0);
      const convCreatedN = Number((convCreated as Row[])[0]?.n ?? 0);
      const convCompletedN = Number((convCompleted as Row[])[0]?.n ?? 0);
      const convOwnersN = Number((convOwners as Row[])[0]?.n ?? 0);
      const convConvertedN = Number((convConverted as Row[])[0]?.n ?? 0);
      const conv: ConversionMetric[] = [
        { id: "signup_to_first_audit", label: "Registration → first audit", rate: regs > 0 ? convRegsWithAuditN / regs : null, numerator: convRegsWithAuditN, denominator: regs, definition: "Accounts created in the period that started their first audit by the period end." },
        { id: "audit_completion", label: "Audit completion rate", rate: convCreatedN > 0 ? convCompletedN / convCreatedN : null, numerator: convCompletedN, denominator: convCreatedN, definition: "Audits started in the period whose final status is completed or completed with warnings." },
        { id: "completed_to_export", label: "Completed audit → PDF export", rate: convOwnersN > 0 ? convConvertedN / convOwnersN : null, numerator: convConvertedN, denominator: convOwnersN, definition: "Accounts with a completed audit in the period that also exported at least one PDF report in the period." },
      ];

      void bucket;
      return {
        range: { from, to, bucket: range.bucket },
        generatedAt: new Date().toISOString(),
        totals: {
          uniqueVisitors: cmp(unique, hasPrev ? prevUnique : null),
          sessions: cmp(sessionsT, hasPrev ? prevSessions : null),
          pageviews: cmp(viewsT, hasPrev ? prevViews : null),
          newRegistrations: { current: regs, previous: regsP, delta: regs - regsP },
          auditsCompleted: { current: auditsDone, previous: auditsDoneP, delta: auditsDone - auditsDoneP },
          returningRate: { current: unique > 0 ? returning / unique : null, previous: null, numerator: returning, denominator: unique },
        },
        timeseries: ts,
        sources: toBreakdown(srcRows, viewsT),
        devices: toBreakdown(devRows, viewsT),
        productTimeseries: [...productSeries.values()],
        conversions: conv,
      };
    });
  }

  async landingPages(range: AnalyticsRange, limit: number, offset: number): Promise<{ rows: PopularPageRow[]; total: number }> {
    return this.run(async (sql) => {
      const rows = await sql<Record<string, unknown>[]>`
        WITH s AS (
          SELECT session_hash, min(created_at) AS first_at
          FROM analytics_events
          WHERE event_type = 'pageview' AND created_at >= ${range.from.toISOString()} AND created_at <= ${range.to.toISOString()}
          GROUP BY session_hash
        ), l AS (
          SELECT e.path FROM analytics_events e JOIN s ON e.session_hash = s.session_hash AND e.created_at = s.first_at
          WHERE e.event_type = 'pageview'
        )
        SELECT path, count(*)::bigint AS n FROM l GROUP BY path ORDER BY n DESC, path LIMIT ${limit} OFFSET ${offset}`;
      const totalRows = await sql<Record<string, unknown>[]>`
        WITH s AS (
          SELECT session_hash, min(created_at) AS first_at
          FROM analytics_events
          WHERE event_type = 'pageview' AND created_at >= ${range.from.toISOString()} AND created_at <= ${range.to.toISOString()}
          GROUP BY session_hash
        )
        SELECT count(DISTINCT (SELECT e.path FROM analytics_events e WHERE e.session_hash = s.session_hash AND e.created_at = s.first_at ORDER BY e.created_at LIMIT 1))::bigint AS n FROM s`.catch((e) => tolerated<Record<string, unknown>[]>(e, [{ n: String(rows.length) }]));
      return { rows: rows.map((r) => ({ path: String(r.path), pageviews: Number(r.n), uniqueVisitors: Number(r.n), sessions: Number(r.n) })), total: Number(totalRows[0]?.n ?? rows.length) };
    });
  }

  async popularPages(range: AnalyticsRange, limit: number, offset: number): Promise<{ rows: PopularPageRow[]; total: number }> {
    return this.run(async (sql) => {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT path,
               count(*) FILTER (WHERE event_type = 'pageview')::bigint AS pageviews,
               count(DISTINCT visitor_hash)::bigint AS visitors,
               count(DISTINCT session_hash)::bigint AS sessions
        FROM analytics_events
        WHERE created_at >= ${range.from.toISOString()} AND created_at <= ${range.to.toISOString()}
        GROUP BY path HAVING count(*) FILTER (WHERE event_type = 'pageview') > 0
        ORDER BY pageviews DESC, path
        LIMIT ${limit} OFFSET ${offset}`;
      const totalRows = await sql<Record<string, unknown>[]>`
        SELECT count(DISTINCT path)::bigint AS n FROM analytics_events
        WHERE created_at >= ${range.from.toISOString()} AND created_at <= ${range.to.toISOString()} AND event_type = 'pageview'`;
      return { rows: rows.map((r) => ({ path: String(r.path), pageviews: Number(r.pageviews), uniqueVisitors: Number(r.visitors), sessions: Number(r.sessions) })), total: Number(totalRows[0]?.n ?? rows.length) };
    });
  }

  async recentActivity(range: AnalyticsRange, limit: number, offset: number): Promise<{ rows: RecentActivityRow[]; total: number }> {
    return this.run(async (sql) => {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT event_type, path, device, browser, os, source, referrer_host, created_at
        FROM analytics_events
        WHERE created_at >= ${range.from.toISOString()} AND created_at <= ${range.to.toISOString()}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      const totals = await sql<Record<string, unknown>[]>`SELECT count(*)::bigint AS n FROM analytics_events WHERE created_at >= ${range.from.toISOString()} AND created_at <= ${range.to.toISOString()}`;
      return {
        rows: rows.map((r) => ({
          eventType: r.event_type as RecentActivityRow["eventType"],
          path: String(r.path),
          device: r.device as RecentActivityRow["device"],
          browser: String(r.browser),
          os: String(r.os),
          source: r.source as RecentActivityRow["source"],
          referrerHost: (r.referrer_host as string | null) ?? null,
          createdAt: new Date(String(r.created_at)).toISOString(),
        })),
        total: Number(totals[0]?.n ?? rows.length),
      };
    });
  }
}

export type { AnalyticsEventRow };
