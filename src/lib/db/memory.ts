import { computeOverallScore, type AuditMetric } from "../audit/metrics";
import type { Finding, ResolutionStatus, Severity } from "../audit/types";
import type { ProviderId } from "../config/env";
import type { LinkCheckRecord, PageRecord, ScanJob, ScanStatus } from "../scanner/types";
import {
  DuplicateScanError,
  type AiRecommendationRecord,
  type ArtifactKind,
  type AuditQuery,
  type AuditStats,
  type HistoryEvent,
  type LatestIssue,
  type Repository,
  type RunnableScan,
  type ScanArtifact,
  type ScanListItem,
  type UsageConsumeInput,
  type UsageConsumeResult,
  type UsageCount,
  type UsageKind,
} from "./types";
import { emptyCommerceStore, MemoryCommerce, type CommerceStore } from "./commerce-memory";

/**
 * In-memory repository. Data lives only in this server process and is lost on
 * restart or redeploy; on serverless platforms different requests may hit
 * different instances. Used for local development and tests, and as a
 * single-instance mode when explicitly allowed (ALLOW_MEMORY_STORAGE); it is
 * never used on serverless hosting.
 */

interface UsageEvent {
  kind: UsageKind;
  principalId: string;
  ipHash: string;
  at: number;
}

interface Store {
  principals: Map<string, { ipHash: string; createdAt: string }>;
  websites: Map<string, string>;
  scans: Map<string, ScanJob & { leaseUntil: number }>;
  pages: Map<string, PageRecord[]>;
  links: Map<string, LinkCheckRecord[]>;
  findings: Map<string, Finding[]>;
  artifacts?: Map<string, ScanArtifact[]>;
  ai: Map<string, AiRecommendationRecord>;
  usage: UsageEvent[];
  prefs: Map<string, ProviderId>;
  metrics?: Map<string, AuditMetric[]>;
  history?: HistoryEvent[];
  commerce?: CommerceStore;
  analyticsEvents?: import("./analytics-types").AnalyticsEventRow[];
}

const clone = <T>(v: T): T => structuredClone(v);
const ACTIVE: ScanStatus[] = ["queued", "running"];
import { MemoryAnalytics } from "./analytics-memory";

export class MemoryRepository implements Repository {
  readonly kind = "memory" as const;
  readonly persistent = false;
  private s: Store;
  readonly commerce: MemoryCommerce;
  readonly analytics: MemoryAnalytics;

  constructor(store?: Store) {
    this.s = store ?? MemoryRepository.emptyStore();
    this.s.commerce ??= emptyCommerceStore();
    this.s.analyticsEvents ??= [];
    this.commerce = new MemoryCommerce(this.s.commerce);
    this.analytics = new MemoryAnalytics({
      events: this.s.analyticsEvents,
      scans: this.s.scans,
      principals: this.s.principals,
      usage: this.s.usage,
    });
  }

  static emptyStore(): Store {
    return { principals: new Map(), websites: new Map(), scans: new Map(), pages: new Map(), links: new Map(), findings: new Map(), artifacts: new Map(), ai: new Map(), usage: [], prefs: new Map(), metrics: new Map(), history: [], commerce: emptyCommerceStore(), analyticsEvents: [] };
  }

  async ensurePrincipal(id: string, ipHash: string) {
    if (!this.s.principals.has(id)) this.s.principals.set(id, { ipHash, createdAt: new Date().toISOString() });
  }

  async upsertWebsite(origin: string) {
    let id = this.s.websites.get(origin);
    if (!id) {
      id = crypto.randomUUID();
      this.s.websites.set(origin, id);
    }
    return id;
  }

  async createScan(scan: ScanJob) {
    // Check-and-insert with no await in between, so concurrent requests cannot both pass.
    const key = scan.access?.idempotencyKey;
    if (key && [...this.s.scans.values()].some((v) => v.principalId === scan.principalId && v.access?.idempotencyKey === key)) throw new DuplicateScanError();
    if (this.s.scans.has(scan.id)) throw new Error("Scan id collision");
    this.s.scans.set(scan.id, { ...clone(scan), leaseUntil: 0 });
    this.event(scan.id, "created", null, scan.status, { rerun_of: scan.rerunOf ?? null });
  }

  private historySeq = 0;
  private event(scanId: string, event: HistoryEvent["event"], fromStatus: string | null, toStatus: string | null, detail: Record<string, unknown> = {}) {
    (this.s.history ??= []).push({ id: `${Date.now()}-${++this.historySeq}`, scanId, hostname: null, scanTitle: null, event, fromStatus, toStatus, detail, createdAt: new Date().toISOString() });
    if (this.s.history.length > 5000) this.s.history.splice(0, this.s.history.length - 5000);
  }

  async findScanByIdempotencyKey(principalId: string, key: string) {
    for (const v of this.s.scans.values()) {
      if (v.principalId === principalId && v.access?.idempotencyKey === key) return this.getScan(v.id);
    }
    return null;
  }

  async getScan(id: string) {
    const v = this.s.scans.get(id);
    if (!v) return null;
    const { leaseUntil: _l, ...rest } = v;
    void _l;
    return clone(rest);
  }

  async saveScan(scan: ScanJob) {
    const cur = this.s.scans.get(scan.id);
    if (!cur || !ACTIVE.includes(cur.status)) return false;
    if (cur.status !== scan.status) this.event(scan.id, "status_changed", cur.status, scan.status, scan.error ? { error_code: scan.error.code } : {});
    // Owner-managed fields are not part of engine saves.
    this.s.scans.set(scan.id, { ...clone(scan), title: cur.title ?? null, organizationId: cur.organizationId ?? null, overallScore: computeOverallScore(scan.summary), updatedAt: new Date().toISOString(), leaseUntil: cur.leaseUntil });
    return true;
  }

  async transitionScan(id: string, from: ScanStatus[], to: ScanStatus, patch: Partial<Pick<ScanJob, "error" | "finishedAt" | "phase">> = {}) {
    const cur = this.s.scans.get(id);
    if (!cur || !from.includes(cur.status)) return false;
    if (cur.status !== to) this.event(id, "status_changed", cur.status, to, patch.error ? { error_code: patch.error.code } : {});
    Object.assign(cur, patch, { status: to, updatedAt: new Date().toISOString() });
    return true;
  }

  async listScans(principalId: string, limit: number) {
    return [...this.s.scans.values()]
      .filter((x) => x.principalId === principalId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(({ leaseUntil: _l, ...rest }) => {
        void _l;
        return clone(rest);
      });
  }

  async countActiveScans(opts: { principalId?: string; activeSince: Date }) {
    const since = opts.activeSince.toISOString();
    return [...this.s.scans.values()].filter((x) => ACTIVE.includes(x.status) && x.updatedAt >= since && (!opts.principalId || x.principalId === opts.principalId)).length;
  }

  async acquireLease(id: string, ms: number) {
    const cur = this.s.scans.get(id);
    if (!cur) return false;
    const now = Date.now();
    if (cur.leaseUntil > now) return false;
    cur.leaseUntil = now + ms;
    return true;
  }

  async releaseLease(id: string) {
    const cur = this.s.scans.get(id);
    if (cur) cur.leaseUntil = 0;
  }

  async pruneHistory(principalId: string, keep: number) {
    const all = [...this.s.scans.values()].filter((x) => x.principalId === principalId && !ACTIVE.includes(x.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const remove = all.slice(keep);
    for (const r of remove) this.dropScan(r.id);
    return remove.length;
  }

  private dropScan(id: string) {
    this.commerce.detachAudit(id);
    this.s.scans.delete(id);
    this.s.pages.delete(id);
    this.s.links.delete(id);
    this.s.findings.delete(id);
    this.s.artifacts?.delete(id);
    this.s.metrics?.delete(id);
    if (this.s.history) this.s.history = this.s.history.filter((h) => h.scanId !== id);
    for (const [k, v] of this.s.ai) if (v.scanId === id) this.s.ai.delete(k);
    for (const v of this.s.scans.values()) if (v.rerunOf === id) v.rerunOf = null;
  }

  async saveArtifact(a: ScanArtifact) {
    const map = (this.s.artifacts ??= new Map<string, ScanArtifact[]>());
    const arr = (map.get(a.scanId) ?? []).filter((x) => !(x.kind === a.kind && x.key === a.key));
    arr.push(clone(a));
    map.set(a.scanId, arr);
  }
  async listArtifacts(scanId: string, kind?: ArtifactKind) {
    return clone((this.s.artifacts?.get(scanId) ?? []).filter((a) => !kind || a.kind === kind));
  }

  async insertPages(pages: PageRecord[]) {
    for (const p of pages) {
      const arr = this.s.pages.get(p.scanId) ?? [];
      arr.push(clone(p));
      this.s.pages.set(p.scanId, arr);
    }
  }
  async listPages(scanId: string) {
    return clone(this.s.pages.get(scanId) ?? []);
  }
  async insertLinkChecks(links: LinkCheckRecord[]) {
    for (const l of links) {
      const arr = this.s.links.get(l.scanId) ?? [];
      arr.push(clone(l));
      this.s.links.set(l.scanId, arr);
    }
  }
  async listLinkChecks(scanId: string) {
    return clone(this.s.links.get(scanId) ?? []);
  }
  async insertFindings(findings: Finding[]) {
    for (const f of findings) {
      const arr = this.s.findings.get(f.scanId) ?? [];
      arr.push(clone(f));
      this.s.findings.set(f.scanId, arr);
    }
  }
  async listFindings(scanId: string) {
    return clone(this.s.findings.get(scanId) ?? []);
  }
  async getFinding(scanId: string, findingId: string) {
    const f = (this.s.findings.get(scanId) ?? []).find((x) => x.id === findingId);
    return f ? clone(f) : null;
  }

  private aiKey(scanId: string, findingId: string | null) {
    return `${scanId}::${findingId ?? "__summary__"}`;
  }
  async saveAiRecommendation(rec: AiRecommendationRecord) {
    this.s.ai.set(this.aiKey(rec.scanId, rec.findingId), clone(rec));
  }
  async getAiRecommendation(scanId: string, findingId: string | null) {
    const v = this.s.ai.get(this.aiKey(scanId, findingId));
    return v ? clone(v) : null;
  }
  async listAiRecommendations(scanId: string) {
    return [...this.s.ai.values()].filter((r) => r.scanId === scanId).map(clone);
  }

  async countUsage(kind: UsageKind, principalId: string, ipHash: string, since: Date): Promise<UsageCount> {
    const t = since.getTime();
    const ev = this.s.usage.filter((e) => e.kind === kind && e.at >= t);
    const p = ev.filter((e) => e.principalId === principalId);
    const i = ev.filter((e) => e.ipHash === ipHash);
    const oldest = (list: UsageEvent[]) => (list.length ? new Date(Math.min(...list.map((e) => e.at))) : null);
    return { byPrincipal: p.length, byIp: i.length, oldestPrincipal: oldest(p), oldestIp: oldest(i) };
  }

  async consumeUsage(input: UsageConsumeInput): Promise<UsageConsumeResult> {
    // Single-threaded event loop: check + record is atomic within this process.
    const c = await this.countUsage(input.kind, input.principalId, input.ipHash, input.since);
    let allowed = c.byPrincipal < input.principalLimit && c.byIp < input.ipLimit;
    let burstLimited = false;
    if (allowed && input.burst) {
      const since = input.burst.since.getTime();
      if (this.s.usage.filter((e) => e.kind === input.kind && e.principalId === input.principalId && e.at >= since).length >= input.burst.limit) {
        allowed = false;
        burstLimited = true;
      }
    }
    if (allowed) this.s.usage.push({ kind: input.kind, principalId: input.principalId, ipHash: input.ipHash, at: Date.now() });
    // Bound memory: drop events older than 31 days.
    const cutoff = Date.now() - 31 * 86_400_000;
    if (this.s.usage.length > 5000) this.s.usage = this.s.usage.filter((e) => e.at >= cutoff);
    return { ...c, allowed, burstLimited };
  }

  async refundUsage(kind: UsageKind, principalId: string, ipHash: string) {
    for (let i = this.s.usage.length - 1; i >= 0; i--) {
      const e = this.s.usage[i];
      if (e.kind === kind && e.principalId === principalId && e.ipHash === ipHash) {
        this.s.usage.splice(i, 1);
        return;
      }
    }
  }

  async getProviderPreference(principalId: string) {
    return this.s.prefs.get(principalId) ?? null;
  }
  async setProviderPreference(principalId: string, provider: ProviderId | null) {
    if (provider) this.s.prefs.set(principalId, provider);
    else this.s.prefs.delete(principalId);
  }

  // ── Audit management ──────────────────────────────────────────────────────

  private item(v: ScanJob & { leaseUntil: number }): ScanListItem {
    const { leaseUntil: _l, state: _s, ...rest } = v;
    void _l;
    void _s;
    return clone(rest);
  }

  async updateScanMeta(
    id: string,
    patch: { title?: string | null; organizationId?: string | null },
    access: { principalId: string; organizationMemberUserId?: string; expectedOrganizationId?: string | null },
  ) {
    const cur = this.s.scans.get(id);
    if (!cur || cur.principalId !== access.principalId) return false;
    if (patch.organizationId !== undefined) {
      // Sharing updates use compare-and-set semantics. The memory repository
      // cannot resolve organization memberships (accounts require Postgres),
      // but it still enforces the owner and expected current share state.
      if (access.expectedOrganizationId === undefined || (cur.organizationId ?? null) !== access.expectedOrganizationId) return false;
      if (patch.organizationId !== null && !access.organizationMemberUserId) return false;
    }
    if (patch.title !== undefined && patch.title !== (cur.title ?? null)) {
      cur.title = patch.title;
      this.event(id, "renamed", null, null, { title: patch.title });
    }
    if (patch.organizationId !== undefined && patch.organizationId !== (cur.organizationId ?? null)) {
      this.event(id, patch.organizationId ? "shared" : "unshared", null, null, { organization_id: patch.organizationId ?? cur.organizationId });
      cur.organizationId = patch.organizationId;
    }
    return true;
  }

  async deleteScan(id: string) {
    if (!this.s.scans.has(id)) return false;
    this.dropScan(id);
    return true;
  }

  async listAudits(q: AuditQuery) {
    const term = q.search?.trim().toLowerCase().slice(0, 100) || null;
    const orgs = new Set(q.organizationIds ?? []);
    const statusOk = (st: ScanStatus) =>
      q.status === "active" ? ACTIVE.includes(st)
      : q.status === "completed" ? st === "completed" || st === "completed_with_warnings"
      : q.status === "failed" ? st === "failed"
      : q.status === "cancelled" ? st === "cancelled"
      : true;
    const rows = [...this.s.scans.values()].filter(
      (x) => (x.principalId === q.principalId || (x.organizationId && orgs.has(x.organizationId))) && statusOk(x.status) && (!term || [x.title ?? "", x.hostname, x.targetUrl].some((f) => f.toLowerCase().includes(term))),
    );
    const byNew = (a: ScanJob, b: ScanJob) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    const score = (x: ScanJob) => x.overallScore ?? null;
    const cmp: Record<string, (a: ScanJob, b: ScanJob) => number> = {
      newest: byNew,
      oldest: (a, b) => -byNew(a, b),
      score_desc: (a, b) => (score(a) === null ? 1 : 0) - (score(b) === null ? 1 : 0) || (score(b) ?? 0) - (score(a) ?? 0) || byNew(a, b),
      score_asc: (a, b) => (score(a) === null ? 1 : 0) - (score(b) === null ? 1 : 0) || (score(a) ?? 0) - (score(b) ?? 0) || byNew(a, b),
      name: (a, b) => (a.title ?? a.hostname).toLowerCase().localeCompare((b.title ?? b.hostname).toLowerCase()) || byNew(a, b),
    };
    rows.sort(cmp[q.sort ?? "newest"] ?? byNew);
    const start = (q.page - 1) * q.pageSize;
    return { items: rows.slice(start, start + q.pageSize).map((x) => this.item(x)), total: rows.length };
  }

  private latestPerSite(principalId: string) {
    const best = new Map<string, ScanJob & { leaseUntil: number }>();
    for (const x of this.s.scans.values()) {
      if (x.principalId !== principalId || (x.status !== "completed" && x.status !== "completed_with_warnings")) continue;
      const cur = best.get(x.hostname);
      if (!cur || x.createdAt > cur.createdAt) best.set(x.hostname, x);
    }
    return [...best.values()];
  }

  async auditStats(principalId: string, activeSince: Date): Promise<AuditStats> {
    const mine = [...this.s.scans.values()].filter((x) => x.principalId === principalId);
    const since = activeSince.toISOString();
    const latest = this.latestPerSite(principalId);
    const scored = latest.map((x) => x.overallScore).filter((v): v is number => typeof v === "number");
    const severity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const x of latest) for (const f of this.s.findings.get(x.id) ?? []) if ((f.resolution?.status ?? "open") === "open") severity[f.severity]++;
    return {
      total: mine.length,
      completed: mine.filter((x) => x.status === "completed" || x.status === "completed_with_warnings").length,
      running: mine.filter((x) => ACTIVE.includes(x.status) && x.updatedAt >= since).length,
      failed: mine.filter((x) => x.status === "failed").length,
      cancelled: mine.filter((x) => x.status === "cancelled").length,
      averageScore: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
      scoredSites: scored.length,
      severity,
      sites: new Set(mine.map((x) => x.hostname)).size,
    };
  }

  async latestIssues(principalId: string, limit: number): Promise<LatestIssue[]> {
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const out: LatestIssue[] = [];
    for (const x of this.latestPerSite(principalId)) {
      for (const f of this.s.findings.get(x.id) ?? []) {
        if (f.severity === "info" || (f.resolution?.status ?? "open") !== "open") continue;
        out.push({ scanId: x.id, scanTitle: x.title ?? null, hostname: x.hostname, finding: { id: f.id, ruleId: f.ruleId, title: f.title, severity: f.severity, category: f.category, affectedUrl: f.affectedUrl, affectedCount: f.affectedCount }, createdAt: x.createdAt });
      }
    }
    return out.sort((a, b) => order[a.finding.severity] - order[b.finding.severity] || b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  private decorate(h: HistoryEvent): HistoryEvent {
    const s = this.s.scans.get(h.scanId);
    return { ...clone(h), hostname: s?.hostname ?? null, scanTitle: s?.title ?? null };
  }

  async recentActivity(principalId: string, limit: number) {
    return (this.s.history ?? [])
      .filter((h) => this.s.scans.get(h.scanId)?.principalId === principalId)
      .slice(-limit)
      .reverse()
      .map((h) => this.decorate(h));
  }

  async listHistory(scanId: string) {
    return (this.s.history ?? []).filter((h) => h.scanId === scanId).map((h) => this.decorate(h));
  }

  async setIssueResolution(scanId: string, findingId: string, status: ResolutionStatus, note: string | null) {
    const f = (this.s.findings.get(scanId) ?? []).find((x) => x.id === findingId);
    if (!f) return null;
    const before = f.resolution?.status ?? "open";
    f.resolution = { status, note, resolvedAt: status === "open" ? null : before === status ? (f.resolution?.resolvedAt ?? new Date().toISOString()) : new Date().toISOString() };
    if (before !== status) this.event(scanId, "issue_status_changed", before, status, { finding_id: findingId, rule_id: f.ruleId });
    return clone(f);
  }

  async saveMetrics(scanId: string, metrics: AuditMetric[]) {
    const map = (this.s.metrics ??= new Map<string, AuditMetric[]>());
    const byKey = new Map((map.get(scanId) ?? []).map((m) => [m.key, m]));
    for (const m of metrics) byKey.set(m.key, clone(m));
    map.set(scanId, [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)));
  }

  async listMetrics(scanId: string) {
    return clone(this.s.metrics?.get(scanId) ?? []);
  }

  async reassignPrincipal(from: string, to: string) {
    if (from === to) return 0;
    let n = 0;
    for (const x of this.s.scans.values()) if (x.principalId === from) {
      x.principalId = to;
      n++;
    }
    for (const e of this.s.usage) if (e.principalId === from) e.principalId = to;
    const pref = this.s.prefs.get(from);
    if (pref && !this.s.prefs.has(to)) this.s.prefs.set(to, pref);
    this.s.prefs.delete(from);
    return n;
  }

  async countScans(principalId: string) {
    return [...this.s.scans.values()].filter((x) => x.principalId === principalId).length;
  }

  async listRunnableScans(limit: number, maxAgeMs: number): Promise<RunnableScan[]> {
    const now = Date.now();
    return [...this.s.scans.values()]
      .filter((x) => ACTIVE.includes(x.status) && x.leaseUntil <= now && now - Date.parse(x.createdAt) <= maxAgeMs)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map((x) => ({ id: x.id, principalId: x.principalId, ipHash: x.ipHash ?? null }));
  }

  async deletePrincipalData(principalId: string) {
    for (const x of [...this.s.scans.values()]) if (x.principalId === principalId) this.dropScan(x.id);
    this.s.usage = this.s.usage.filter((e) => e.principalId !== principalId);
    this.s.prefs.delete(principalId);
    this.commerce.deletePrincipal(principalId);
    this.s.principals.delete(principalId);
  }
}
