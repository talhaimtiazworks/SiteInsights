/**
 * Persistence contracts for credits, prospects and batch audits. Implemented
 * by the PostgreSQL repository (durable, transactional) and the in-memory
 * repository (development and tests). Every method is owner-scoped: callers
 * pass the principal that owns the rows and implementations never return
 * another principal's data.
 */

import type { ClientReportSnapshot, ClientReportSnapshotContent } from "../report/snapshot-types";

export type LedgerEntryType = "grant" | "expire" | "reserve" | "release" | "charge" | "refund" | "adjust";

export interface CreditAccount {
  principalId: string;
  planId: string;
  balance: number;
  allowance: number;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  principalId: string;
  delta: number;
  balanceAfter: number;
  entryType: LedgerEntryType;
  /** Machine-readable operation, e.g. "audit", "ai_explanation", "monthly_grant". */
  operation: string;
  auditId: string | null;
  periodKey: string;
  idempotencyKey: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** Desired credit period, computed by the credits service from the verified plan. */
export interface CreditPeriod {
  planId: string;
  allowance: number;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
}

export interface SpendInput {
  principalId: string;
  amount: number;
  entryType: "reserve" | "charge";
  operation: string;
  auditId?: string | null;
  idempotencyKey: string;
  detail?: Record<string, unknown>;
}

export type SpendResult =
  | { ok: true; replayed: boolean; entry: LedgerEntry; balance: number }
  | { ok: false; reason: "insufficient_credits" | "no_account"; balance: number };

export interface CreditInput {
  principalId: string;
  amount: number;
  entryType: "release" | "refund" | "adjust";
  operation: string;
  auditId?: string | null;
  idempotencyKey: string;
  /**
   * Period in which the credited amount was originally spent. When it differs
   * from the account's current period the entry is recorded with delta 0:
   * credits from an expired period are not carried into a new one.
   */
  sourcePeriodKey?: string | null;
  detail?: Record<string, unknown>;
}

export interface CreditResult {
  replayed: boolean;
  entry: LedgerEntry | null;
  balance: number;
}

export const PROSPECT_STATUSES = ["new", "reviewing", "contacted", "converted"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

/** Snapshot of VERIFIED scanner data at the time a prospect was saved or refreshed. */
export interface ProspectEvidence {
  overallScore: number | null;
  pagesScanned: number;
  brokenLinks: number;
  findingsBySeverity: Record<string, number>;
  totalFindings: number;
  topIssues: Array<{ title: string; severity: string; affectedCount: number }>;
  auditStatus: string;
}

export interface Prospect {
  id: string;
  principalId: string;
  /** Nullable organization shares this owner-held record with current members. */
  organizationId: string | null;
  organizationName: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  assignedToEmail: string | null;
  hostname: string;
  websiteUrl: string;
  businessName: string | null;
  location: string | null;
  auditId: string | null;
  status: ProspectStatus;
  notes: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactUrl: string | null;
  evidence: ProspectEvidence | null;
  auditedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProspectInput {
  hostname: string;
  websiteUrl: string;
  auditId: string | null;
  evidence: ProspectEvidence | null;
  auditedAt: string | null;
  businessName?: string | null;
  location?: string | null;
  status?: ProspectStatus;
  notes?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactUrl?: string | null;
}

export type ProspectPatch = Partial<Pick<Prospect, "status" | "notes" | "businessName" | "location" | "contactName" | "contactEmail" | "contactUrl" | "organizationId" | "assignedToUserId">>;

export interface ProspectQuery {
  principalId: string;
  userId?: string | null;
  organizationIds?: string[];
  status?: ProspectStatus | "all";
  search?: string | null;
  limit: number;
  offset: number;
}

export type BatchItemStatus = "pending" | "started" | "skipped" | "failed";

export interface BatchItem {
  id: string;
  batchId: string;
  principalId: string;
  position: number;
  url: string;
  maxPages: number;
  status: BatchItemStatus;
  auditId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditBatch {
  id: string;
  principalId: string;
  ipHash: string | null;
  createdAt: string;
  items: BatchItem[];
}

/** Read-only, revocable, expiring link to one audit report (Business plan). Only the token's SHA-256 is stored. */
export interface ReportShare {
  id: string;
  principalId: string;
  auditId: string;
  /** New links pin an immutable snapshot; null is reserved for legacy live-view links. */
  snapshotId?: string | null;
  snapshotVersion?: number | null;
  tokenHash: string;
  label: string | null;
  allowPdf: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
}

export interface CommerceRepository {
  // ── Credits ──
  /**
   * Atomically makes `period` the account's current period: creates the
   * account if needed, and when the period key changes expires the remaining
   * balance and grants the allowance (idempotent per period key).
   */
  ensureCreditPeriod(principalId: string, period: CreditPeriod): Promise<CreditAccount>;
  getCreditAccount(principalId: string): Promise<CreditAccount | null>;
  /** Atomic debit. Never lets the balance go negative; idempotent per idempotencyKey. */
  spendCredits(input: SpendInput): Promise<SpendResult>;
  /** Atomic credit (release/refund/adjust). Idempotent per idempotencyKey. */
  creditCredits(input: CreditInput): Promise<CreditResult>;
  getLedgerEntry(principalId: string, idempotencyKey: string): Promise<LedgerEntry | null>;
  listLedger(principalId: string, limit: number, offset: number): Promise<{ items: LedgerEntry[]; total: number }>;
  /** Audit reservations that were never settled (for the background sweep). */
  listUnsettledReservations(limit: number): Promise<Array<{ principalId: string; auditId: string; createdAt: string }>>;

  // ── Prospects ──
  /** Inserts, or refreshes the audit link/evidence of the owner's existing prospect for the same hostname. */
  upsertProspect(principalId: string, input: ProspectInput): Promise<{ prospect: Prospect; created: boolean }>;
  getProspect(principalId: string, id: string, organizationIds?: string[], userId?: string | null): Promise<Prospect | null>;
  updateProspect(principalId: string, id: string, patch: ProspectPatch, organizationIds?: string[], actorUserId?: string | null): Promise<Prospect | null>;
  deleteProspect(principalId: string, id: string): Promise<boolean>;
  listProspects(q: ProspectQuery): Promise<{ items: Prospect[]; total: number; byStatus: Record<ProspectStatus, number> }>;
  countProspects(principalId: string): Promise<number>;
  findProspectByHostname(principalId: string, hostname: string): Promise<Prospect | null>;

  // ── Batch audits ──
  createBatch(batch: AuditBatch): Promise<void>;
  getBatch(principalId: string, id: string): Promise<AuditBatch | null>;
  listBatches(principalId: string, limit: number): Promise<AuditBatch[]>;
  /** Atomically claims the next pending item of a principal (oldest batch first) and marks it started. */
  claimNextBatchItem(principalId: string): Promise<BatchItem | null>;
  updateBatchItem(id: string, patch: Partial<Pick<BatchItem, "status" | "auditId" | "error">>): Promise<void>;
  /** Principals that still have pending batch items (for the sweep). */
  listPrincipalsWithPendingBatchItems(limit: number): Promise<Array<{ principalId: string; ipHash: string | null }>>;

  // ── Immutable client-report snapshots and share links ──
  createReportSnapshot(userId: string, auditId: string, content: ClientReportSnapshotContent): Promise<ClientReportSnapshot>;
  getReportSnapshot(userId: string, snapshotId: string): Promise<ClientReportSnapshot | null>;
  deleteReportSnapshot(userId: string, snapshotId: string): Promise<void>;
  createReportShare(share: ReportShare): Promise<void>;
  listReportShares(principalId: string, auditId: string): Promise<ReportShare[]>;
  revokeReportShare(principalId: string, id: string): Promise<boolean>;
  /** Active (not revoked, not expired) share for a token hash; records the view. */
  useReportShare(tokenHash: string): Promise<ReportShare | null>;
}
