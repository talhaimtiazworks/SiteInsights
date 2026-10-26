import type { ScanJob } from "../scanner/types";
import type {
  AnalyticsBucket, AnalyticsEventInsert, AnalyticsEventRow, AnalyticsRange, AnalyticsRepository,
  ConversionMetric, ProductTimeseriesPoint, RecentActivityRow,
} from "./analytics-types";
import { aggregateOverview, aggregatePopular, aggregateLandings } from "./analytics-types";
import type { UsageKind } from "./types";
import type { TrafficSource } from "../analytics/classify";

/**
 * In-memory analytics repository (development + tests). NOT durable — the
 * dashboard labels in-memory storage accordingly elsewhere. Events are kept
 * in the shared store so harness-seeded scans/users can be reflected in
 * product metrics exactly like the PostgreSQL implementation reads tables.
 */
export interface AnalyticsStoreShape {
  events?: AnalyticsEventRow[];
  scans?: Map<string, ScanJob & { leaseUntil: number }>;
  principals?: Map<string, { ipHash: string; createdAt: string }>;
  usage?: Array<{ kind: UsageKind; principalId: string; at: number; amount?: number }>;
}

export class MemoryAnalytics implements AnalyticsRepository {
  constructor(private store: AnalyticsStoreShape) {
    this.store.events ??= [];
  }

  async insertEvent(e: AnalyticsEventInsert): Promise<boolean> {
    const list = this.store.events!;
    if (list.some((x) => x.clientEventId === e.clientEventId)) return false;
    list.push({
      clientEventId: e.clientEventId,
      visitorHash: e.visitorHash,
      sessionHash: e.sessionHash,
      eventType: e.eventType,
      path: e.path,
      referrerHost: e.referrerHost,
      source: e.source,
      device: e.device,
      browser: e.browser,
      os: e.os,
      createdAt: e.at ?? new Date(),
    });
    return true;
  }

  async countEventsBefore(when: Date): Promise<number> {
    return this.store.events!.filter((e) => e.createdAt < when).length;
  }

  async sessionSource(sessionHash: string): Promise<TrafficSource | null> {
    const first = this.store
      .events!.filter((e) => e.sessionHash === sessionHash)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    return first ? first.source : null;
  }

  private inRange(range: AnalyticsRange): AnalyticsEventRow[] {
    return this.store.events!.filter((e) => e.createdAt >= range.from && e.createdAt <= range.to);
  }

  private productPoint(map: Map<string, ProductTimeseriesPoint>, t: Date, bucket: AnalyticsBucket): ProductTimeseriesPoint {
    const key = bucket === "hour" ? new Date(Math.floor(t.getTime() / 3_600_000) * 3_600_000).toISOString() : new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())).toISOString();
    let p = map.get(key);
    if (!p) {
      p = { t: key, registrations: 0, auditsCreated: 0, auditsCompleted: 0, auditsFailed: 0, reportsExported: 0 };
      map.set(key, p);
    }
    return p;
  }

  private productSeries(range: AnalyticsRange): ProductTimeseriesPoint[] {
    const map = new Map<string, ProductTimeseriesPoint>();
    const endMs = range.to.getTime();
    const step = range.bucket === "hour" ? 3_600_000 : 86_400_000;
    const start = range.bucket === "hour" ? Math.floor(range.from.getTime() / step) * step : Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate());
    for (let t = start; t <= endMs; t += step) {
      const iso = new Date(t).toISOString();
      if (!map.has(iso)) map.set(iso, { t: iso, registrations: 0, auditsCreated: 0, auditsCompleted: 0, auditsFailed: 0, reportsExported: 0 });
    }
    const scans = [...(this.store.scans?.values() ?? [])];
    for (const j of scans) {
      const created = new Date(j.createdAt);
      if (created >= range.from && created <= range.to) this.productPoint(map, created, range.bucket).auditsCreated += 1;
      if (j.finishedAt) {
        const fin = new Date(j.finishedAt);
        if (fin >= range.from && fin <= range.to) {
          if (j.status === "completed" || j.status === "completed_with_warnings") this.productPoint(map, fin, range.bucket).auditsCompleted += 1;
          else if (j.status === "failed") this.productPoint(map, fin, range.bucket).auditsFailed += 1;
        }
      }
    }
    for (const [id, p] of this.store.principals ?? []) {
      if (!id.startsWith("user:")) continue;
      const created = new Date(p.createdAt);
      if (created >= range.from && created <= range.to) this.productPoint(map, created, range.bucket).registrations += 1;
    }
    for (const u of this.store.usage ?? []) {
      const at = new Date(u.at);
      if (u.kind === "pdf_export" && at >= range.from && at <= range.to) this.productPoint(map, at, range.bucket).reportsExported += 1;
    }
    return [...map.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  private auditCount(range: AnalyticsRange, statuses: ScanJob["status"][]): number {
    let n = 0;
    for (const j of this.store.scans?.values() ?? []) {
      if (!j.finishedAt) continue;
      const fin = new Date(j.finishedAt);
      if (fin >= range.from && fin <= range.to && statuses.includes(j.status)) n += 1;
    }
    return n;
  }

  private conversions(range: AnalyticsRange): ConversionMetric[] {
    const scans = [...(this.store.scans?.values() ?? [])];
    let regWithAudit = 0;
    let regs = 0;
    for (const [id, p] of this.store.principals ?? []) {
      if (!id.startsWith("user:")) continue;
      const created = new Date(p.createdAt);
      if (created < range.from || created > range.to) continue;
      regs += 1;
      const firstAudit = scans.filter((j) => j.principalId === id).map((j) => new Date(j.createdAt).getTime()).sort((a, b) => a - b)[0];
      if (firstAudit !== undefined && firstAudit <= range.to.getTime()) regWithAudit += 1;
    }
    const created = scans.filter((j) => {
      const c = new Date(j.createdAt);
      return c >= range.from && c <= range.to;
    }).length;
    const completedAll = scans.filter((j) => {
      if (!j.finishedAt) return false;
      const c = new Date(j.createdAt);
      return c >= range.from && c <= range.to && (j.status === "completed" || j.status === "completed_with_warnings");
    }).length;
    const ownersCompleted = new Set(scans.filter((j) => j.finishedAt && new Date(j.finishedAt) >= range.from && new Date(j.finishedAt) <= range.to && (j.status === "completed" || j.status === "completed_with_warnings")).map((j) => j.principalId));
    const exporters = new Set((this.store.usage ?? []).filter((u) => u.kind === "pdf_export" && new Date(u.at) >= range.from && new Date(u.at) <= range.to).map((u) => u.principalId));
    let converted = 0;
    for (const id of ownersCompleted) if (exporters.has(id)) converted += 1;

    return [
      {
        id: "signup_to_first_audit",
        label: "Registration → first audit",
        rate: regs > 0 ? regWithAudit / regs : null,
        numerator: regWithAudit,
        denominator: regs,
        definition: "Accounts created in the period that started their first audit by the period end.",
      },
      {
        id: "audit_completion",
        label: "Audit completion rate",
        rate: created > 0 ? completedAll / created : null,
        numerator: completedAll,
        denominator: created,
        definition: "Audits started in the period whose final status is completed or completed with warnings.",
      },
      {
        id: "completed_to_export",
        label: "Completed audit → PDF export",
        rate: ownersCompleted.size > 0 ? converted / ownersCompleted.size : null,
        numerator: converted,
        denominator: ownersCompleted.size,
        definition: "Accounts with a completed audit in the period that also exported at least one PDF report in the period.",
      },
    ];
  }

  async overview(range: AnalyticsRange): Promise<ReturnType<typeof aggregateOverview>> {
    const events = this.inRange(range);
    const firstEventTimes = new Map<string, number>();
    for (const e of this.store.events!) {
      const t = e.createdAt.getTime();
      if (!firstEventTimes.has(e.visitorHash) || t < firstEventTimes.get(e.visitorHash)!) firstEventTimes.set(e.visitorHash, t);
    }
    const prevSlice = await this.previousSlice(range);
    const prev = prevSlice
      ? {
          uniqueVisitors: new Set(prevSlice.map((e) => e.visitorHash)).size,
          sessions: new Set(prevSlice.map((e) => e.sessionHash)).size,
          pageviews: prevSlice.filter((e) => e.eventType === "pageview").length,
        }
      : null;
    const dur = range.to.getTime() - range.from.getTime();
    const regsNow = [...(this.store.principals ?? [])].filter(([id, p]) => id.startsWith("user:") && new Date(p.createdAt) >= range.from && new Date(p.createdAt) <= range.to).length;
    const regsPrev = [...(this.store.principals ?? [])].filter(([id, p]) => id.startsWith("user:") && new Date(p.createdAt) >= new Date(range.from.getTime() - dur) && new Date(p.createdAt) < range.from).length;
    const compNow = this.auditCount(range, ["completed", "completed_with_warnings"]);
    const compPrev = this.auditCount({ from: new Date(range.from.getTime() - dur), to: range.from, bucket: range.bucket }, ["completed", "completed_with_warnings"]);
    return aggregateOverview({
      range,
      events,
      firstEventTimes,
      previousPeriod: prev,
      product: this.productSeries(range),
      conversions: this.conversions(range),
      productTotals: {
        newRegistrations: { current: regsNow, previous: regsPrev, delta: regsNow - regsPrev },
        auditsCompleted: { current: compNow, previous: compPrev, delta: compNow - compPrev },
      },
    });
  }

  private async previousSlice(range: AnalyticsRange): Promise<AnalyticsEventRow[] | null> {
    const dur = range.to.getTime() - range.from.getTime();
    const slice = this.store.events!.filter((e) => e.createdAt >= new Date(range.from.getTime() - dur) && e.createdAt < range.from);
    return slice.length ? slice : null;
  }

  async landingPages(range: AnalyticsRange, limit: number, offset: number) {
    return aggregateLandings(this.inRange(range), limit, offset);
  }

  async popularPages(range: AnalyticsRange, limit: number, offset: number) {
    return aggregatePopular(this.inRange(range), limit, offset);
  }

  async recentActivity(range: AnalyticsRange, limit: number, offset: number): Promise<{ rows: RecentActivityRow[]; total: number }> {
    const rows = this.inRange(range)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((e) => ({ eventType: e.eventType, path: e.path, device: e.device, browser: e.browser, os: e.os, source: e.source, referrerHost: e.referrerHost, createdAt: e.createdAt.toISOString() }));
    return { rows, total: this.inRange(range).length };
  }
}
