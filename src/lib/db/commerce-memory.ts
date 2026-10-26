import { randomUUID } from "node:crypto";
import {
  PROSPECT_STATUSES,
  type AuditBatch,
  type BatchItem,
  type ReportShare,
  type CommerceRepository,
  type CreditAccount,
  type CreditInput,
  type CreditPeriod,
  type CreditResult,
  type LedgerEntry,
  type Prospect,
  type ProspectInput,
  type ProspectPatch,
  type ProspectQuery,
  type ProspectStatus,
  type SpendInput,
  type SpendResult,
} from "./commerce-types";
import type { ClientReportSnapshot, ClientReportSnapshotContent } from "../report/snapshot-types";

/**
 * In-memory commerce store. Every method runs synchronously between awaits,
 * so check-and-update sequences are atomic within this (single) process —
 * the same guarantees the PostgreSQL implementation gets from row locks.
 */
export interface CommerceStore {
  accounts: Map<string, CreditAccount>;
  ledger: LedgerEntry[];
  prospects: Map<string, Prospect>;
  batches: Map<string, Omit<AuditBatch, "items">>;
  batchItems: Map<string, BatchItem>;
  shares?: Map<string, ReportShare>;
  snapshots?: Map<string, ClientReportSnapshot>;
}

export const emptyCommerceStore = (): CommerceStore => ({ accounts: new Map(), ledger: [], prospects: new Map(), batches: new Map(), batchItems: new Map(), shares: new Map(), snapshots: new Map() });

const clone = <T>(v: T): T => structuredClone(v);
const nowIso = () => new Date().toISOString();

export class MemoryCommerce implements CommerceRepository {
  private seq = 0;
  constructor(private s: CommerceStore = emptyCommerceStore()) {}

  private findEntry(principalId: string, key: string) {
    return this.s.ledger.find((e) => e.principalId === principalId && e.idempotencyKey === key) ?? null;
  }

  private push(acc: CreditAccount, e: Omit<LedgerEntry, "id" | "balanceAfter" | "createdAt" | "periodKey" | "principalId">): LedgerEntry {
    acc.balance += e.delta;
    if (acc.balance < 0) throw new Error("credit balance would become negative");
    acc.updatedAt = nowIso();
    const entry: LedgerEntry = { ...e, id: String(++this.seq), principalId: acc.principalId, periodKey: acc.periodKey, balanceAfter: acc.balance, createdAt: nowIso() };
    this.s.ledger.push(entry);
    return entry;
  }

  async ensureCreditPeriod(principalId: string, p: CreditPeriod): Promise<CreditAccount> {
    let acc = this.s.accounts.get(principalId);
    if (acc && acc.periodKey === p.periodKey) {
      if (acc.planId !== p.planId || acc.allowance !== p.allowance) Object.assign(acc, { planId: p.planId, allowance: p.allowance });
      return clone(acc);
    }
    if (!acc) {
      acc = { principalId, planId: p.planId, balance: 0, allowance: p.allowance, periodKey: p.periodKey, periodStart: p.periodStart.toISOString(), periodEnd: p.periodEnd.toISOString(), updatedAt: nowIso() };
      this.s.accounts.set(principalId, acc);
    } else {
      if (acc.balance > 0) this.push(acc, { delta: -acc.balance, entryType: "expire", operation: "period_end", auditId: null, idempotencyKey: `expire:${acc.periodKey}`, detail: { reason: "Unused credits from the previous period expired." } });
      Object.assign(acc, { planId: p.planId, allowance: p.allowance, periodKey: p.periodKey, periodStart: p.periodStart.toISOString(), periodEnd: p.periodEnd.toISOString() });
    }
    const key = `grant:${p.periodKey}`;
    if (!this.findEntry(principalId, key) && p.allowance > 0) {
      this.push(acc, { delta: p.allowance, entryType: "grant", operation: "monthly_grant", auditId: null, idempotencyKey: key, detail: { plan: p.planId } });
    }
    return clone(acc);
  }

  async getCreditAccount(principalId: string) {
    const a = this.s.accounts.get(principalId);
    return a ? clone(a) : null;
  }

  async spendCredits(input: SpendInput): Promise<SpendResult> {
    if (!Number.isInteger(input.amount) || input.amount < 0) throw new Error("invalid credit amount");
    const acc = this.s.accounts.get(input.principalId);
    if (!acc) return { ok: false, reason: "no_account", balance: 0 };
    const existing = this.findEntry(input.principalId, input.idempotencyKey);
    if (existing) return { ok: true, replayed: true, entry: clone(existing), balance: acc.balance };
    if (acc.balance < input.amount) return { ok: false, reason: "insufficient_credits", balance: acc.balance };
    const entry = this.push(acc, { delta: -input.amount, entryType: input.entryType, operation: input.operation, auditId: input.auditId ?? null, idempotencyKey: input.idempotencyKey, detail: input.detail ?? {} });
    return { ok: true, replayed: false, entry: clone(entry), balance: acc.balance };
  }

  async creditCredits(input: CreditInput): Promise<CreditResult> {
    if (!Number.isInteger(input.amount) || input.amount < 0) throw new Error("invalid credit amount");
    const acc = this.s.accounts.get(input.principalId);
    if (!acc) return { replayed: false, entry: null, balance: 0 };
    const existing = this.findEntry(input.principalId, input.idempotencyKey);
    if (existing) return { replayed: true, entry: clone(existing), balance: acc.balance };
    const stale = !!input.sourcePeriodKey && input.sourcePeriodKey !== acc.periodKey;
    const detail = { ...(input.detail ?? {}), ...(stale && input.amount > 0 ? { expiredAmount: input.amount, note: "Credits from an earlier billing period are not carried over." } : {}) };
    const entry = this.push(acc, { delta: stale ? 0 : input.amount, entryType: input.entryType, operation: input.operation, auditId: input.auditId ?? null, idempotencyKey: input.idempotencyKey, detail });
    return { replayed: false, entry: clone(entry), balance: acc.balance };
  }

  async getLedgerEntry(principalId: string, key: string) {
    const e = this.findEntry(principalId, key);
    return e ? clone(e) : null;
  }

  async listLedger(principalId: string, limit: number, offset: number) {
    const all = this.s.ledger.filter((e) => e.principalId === principalId).reverse();
    return { items: clone(all.slice(offset, offset + limit)), total: all.length };
  }

  async listUnsettledReservations(limit: number) {
    const out: Array<{ principalId: string; auditId: string; createdAt: string }> = [];
    for (const e of this.s.ledger) {
      if (e.entryType !== "reserve" || !e.auditId) continue;
      if (this.findEntry(e.principalId, `audit:${e.auditId}:settle`)) continue;
      out.push({ principalId: e.principalId, auditId: e.auditId, createdAt: e.createdAt });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── Prospects ──
  async upsertProspect(principalId: string, input: ProspectInput) {
    const existing = [...this.s.prospects.values()].find((p) => p.principalId === principalId && p.hostname === input.hostname);
    if (existing) {
      existing.websiteUrl = input.websiteUrl;
      if (input.businessName !== undefined) existing.businessName = input.businessName;
      if (input.location !== undefined) existing.location = input.location;
      if (input.auditId) {
        existing.auditId = input.auditId;
        existing.evidence = input.evidence;
        existing.auditedAt = input.auditedAt;
      }
      existing.updatedAt = nowIso();
      return { prospect: clone(existing), created: false };
    }
    const now = nowIso();
    const p: Prospect = {
      id: randomUUID(),
      principalId,
      organizationId: null,
      organizationName: null,
      assignedToUserId: null,
      assignedToName: null,
      assignedToEmail: null,
      hostname: input.hostname,
      websiteUrl: input.websiteUrl,
      businessName: input.businessName ?? null,
      location: input.location ?? null,
      auditId: input.auditId,
      status: input.status ?? "new",
      notes: input.notes ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactUrl: input.contactUrl ?? null,
      evidence: input.evidence,
      auditedAt: input.auditedAt,
      createdAt: now,
      updatedAt: now,
    };
    this.s.prospects.set(p.id, p);
    return { prospect: clone(p), created: true };
  }

  async getProspect(principalId: string, id: string, organizationIds: string[] = [], _userId?: string | null) {
    void _userId;
    const p = this.s.prospects.get(id);
    const shared = !!p?.organizationId && organizationIds.includes(p.organizationId);
    return p && (p.principalId === principalId || shared) ? clone(p) : null;
  }

  async updateProspect(principalId: string, id: string, patch: ProspectPatch, organizationIds: string[] = [], actorUserId?: string | null) {
    const p = this.s.prospects.get(id);
    if (!p || (p.principalId !== principalId && (!actorUserId || !p.organizationId || !organizationIds.includes(p.organizationId)))) return null;
    if (p.principalId !== principalId && (patch.organizationId !== undefined || patch.assignedToUserId !== undefined)) return null;
    const previousOrganization = p.organizationId;
    const targetOrganization = patch.organizationId !== undefined ? patch.organizationId : p.organizationId;
    if (targetOrganization && !organizationIds.includes(targetOrganization)) return null;
    if (patch.assignedToUserId && !targetOrganization) return null;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
    if (patch.organizationId !== undefined && targetOrganization !== previousOrganization && patch.assignedToUserId === undefined) p.assignedToUserId = null;
    if (patch.organizationId === null && patch.assignedToUserId === undefined) p.assignedToUserId = null;
    if (patch.assignedToUserId !== undefined || targetOrganization !== previousOrganization) {
      p.assignedToName = null;
      p.assignedToEmail = null;
    }
    p.updatedAt = nowIso();
    return clone(p);
  }

  async deleteProspect(principalId: string, id: string) {
    const p = this.s.prospects.get(id);
    if (!p || p.principalId !== principalId) return false;
    return this.s.prospects.delete(id);
  }

  async listProspects(q: ProspectQuery) {
    const orgIds = q.organizationIds ?? [];
    const visible = [...this.s.prospects.values()].filter((p) => p.principalId === q.principalId || (!!q.userId && !!p.organizationId && orgIds.includes(p.organizationId)));
    const byStatus = Object.fromEntries(PROSPECT_STATUSES.map((s) => [s, visible.filter((p) => p.status === s).length])) as Record<ProspectStatus, number>;
    const term = q.search?.trim().toLowerCase();
    const filtered = visible
      .filter((p) => !q.status || q.status === "all" || p.status === q.status)
      .filter((p) => !term || p.hostname.includes(term) || (p.businessName ?? "").toLowerCase().includes(term) || (p.location ?? "").toLowerCase().includes(term) || (p.notes ?? "").toLowerCase().includes(term) || (p.contactName ?? "").toLowerCase().includes(term))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return { items: clone(filtered.slice(q.offset, q.offset + q.limit)), total: filtered.length, byStatus };
  }

  async countProspects(principalId: string) {
    return [...this.s.prospects.values()].filter((p) => p.principalId === principalId).length;
  }

  async findProspectByHostname(principalId: string, hostname: string) {
    const p = [...this.s.prospects.values()].find((x) => x.principalId === principalId && x.hostname === hostname);
    return p ? clone(p) : null;
  }

  // ── Batches ──
  async createBatch(batch: AuditBatch) {
    const { items, ...rest } = batch;
    this.s.batches.set(batch.id, clone(rest));
    for (const it of items) this.s.batchItems.set(it.id, clone(it));
  }

  private withItems(b: Omit<AuditBatch, "items">): AuditBatch {
    const items = [...this.s.batchItems.values()].filter((i) => i.batchId === b.id).sort((a, c) => a.position - c.position);
    return clone({ ...b, items });
  }

  async getBatch(principalId: string, id: string) {
    const b = this.s.batches.get(id);
    return b && b.principalId === principalId ? this.withItems(b) : null;
  }

  async listBatches(principalId: string, limit: number) {
    return [...this.s.batches.values()]
      .filter((b) => b.principalId === principalId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((b) => this.withItems(b));
  }

  async claimNextBatchItem(principalId: string) {
    const pending = [...this.s.batchItems.values()]
      .filter((i) => i.principalId === principalId && i.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.position - b.position);
    const next = pending[0];
    if (!next) return null;
    next.status = "started";
    next.updatedAt = nowIso();
    return clone(next);
  }

  async updateBatchItem(id: string, patch: Partial<Pick<BatchItem, "status" | "auditId" | "error">>) {
    const it = this.s.batchItems.get(id);
    if (it) Object.assign(it, patch, { updatedAt: nowIso() });
  }

  async listPrincipalsWithPendingBatchItems(limit: number) {
    const seen = new Map<string, string | null>();
    for (const it of this.s.batchItems.values()) {
      if (it.status !== "pending" || seen.has(it.principalId)) continue;
      seen.set(it.principalId, this.s.batches.get(it.batchId)?.ipHash ?? null);
      if (seen.size >= limit) break;
    }
    return [...seen].map(([principalId, ipHash]) => ({ principalId, ipHash }));
  }

  // ── Immutable report snapshots ──
  private get snapshots() {
    return (this.s.snapshots ??= new Map());
  }

  async createReportSnapshot(userId: string, auditId: string, content: ClientReportSnapshotContent) {
    const version = Math.max(0, ...[...this.snapshots.values()].filter((s) => s.userId === userId && s.auditId === auditId).map((s) => s.version)) + 1;
    const snapshot: ClientReportSnapshot = { id: randomUUID(), userId, auditId, version, content: clone(content), createdAt: nowIso() };
    this.snapshots.set(snapshot.id, snapshot);
    return clone(snapshot);
  }

  async getReportSnapshot(userId: string, snapshotId: string) {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot && snapshot.userId === userId ? clone(snapshot) : null;
  }

  async deleteReportSnapshot(userId: string, snapshotId: string) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.userId !== userId) return;
    this.snapshots.delete(snapshotId);
    for (const [id, share] of this.shares) if (share.snapshotId === snapshotId) this.shares.delete(id);
  }

  // ── Report shares ──
  private get shares() {
    return (this.s.shares ??= new Map());
  }

  async createReportShare(share: ReportShare) {
    this.shares.set(share.id, clone(share));
  }

  async listReportShares(principalId: string, auditId: string) {
    return [...this.shares.values()].filter((x) => x.principalId === principalId && x.auditId === auditId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async revokeReportShare(principalId: string, id: string) {
    const x = this.shares.get(id);
    if (!x || x.principalId !== principalId || x.revokedAt) return false;
    x.revokedAt = new Date().toISOString();
    return true;
  }

  async useReportShare(tokenHash: string) {
    const x = [...this.shares.values()].find((v) => v.tokenHash === tokenHash);
    if (!x || x.revokedAt || Date.parse(x.expiresAt) <= Date.now()) return null;
    x.viewCount++;
    x.lastViewedAt = new Date().toISOString();
    return clone(x);
  }

  /** Account deletion / anonymous→account merges. */
  deletePrincipal(principalId: string) {
    this.s.accounts.delete(principalId);
    this.s.ledger = this.s.ledger.filter((e) => e.principalId !== principalId);
    for (const [id, p] of this.s.prospects) if (p.principalId === principalId) this.s.prospects.delete(id);
    for (const [id, b] of this.s.batches) if (b.principalId === principalId) this.s.batches.delete(id);
    for (const [id, i] of this.s.batchItems) if (i.principalId === principalId) this.s.batchItems.delete(id);
    for (const [id, x] of this.shares) if (x.principalId === principalId) this.shares.delete(id);
    const userId = principalId.startsWith("user:") ? principalId.slice(5) : null;
    if (userId) for (const [id, snapshot] of this.snapshots) if (snapshot.userId === userId) this.snapshots.delete(id);
  }

  /** Audit deletion: prospects keep their evidence snapshot but lose the link. */
  detachAudit(auditId: string) {
    for (const p of this.s.prospects.values()) if (p.auditId === auditId) p.auditId = null;
    for (const i of this.s.batchItems.values()) if (i.auditId === auditId) i.auditId = null;
    for (const [id, x] of this.shares) if (x.auditId === auditId) this.shares.delete(id);
    for (const [id, snapshot] of this.snapshots) if (snapshot.auditId === auditId) this.snapshots.delete(id);
  }
}
