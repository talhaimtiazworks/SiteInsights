import type { AuditMetric } from "../audit/metrics";
import type { Finding, ResolutionStatus, Severity } from "../audit/types";
import type { ProviderId } from "../config/env";
import type { LinkCheckRecord, PageRecord, ScanJob, ScanStatus } from "../scanner/types";
import type { CommerceRepository } from "./commerce-types";
import type { AnalyticsRepository } from "./analytics-types";
export type { AnalyticsRepository } from "./analytics-types";

export type UsageKind = "scan" | "ai_request" | "browser_page" | "accessibility_test" | "performance_test" | "pdf_export";

export interface AiRecommendationRecord {
  id: string;
  scanId: string;
  findingId: string | null; // null = overall audit summary
  provider: ProviderId;
  model: string;
  content: unknown;
  fallbackFrom: ProviderId | null;
  createdAt: string;
}

export interface UsageConsumeInput {
  kind: UsageKind;
  principalId: string;
  ipHash: string;
  principalLimit: number;
  ipLimit: number;
  since: Date;
  /** Optional short-window cap per principal (e.g. at most N audits per 10 minutes), checked atomically with the main limit. */
  burst?: { limit: number; since: Date };
}

export interface UsageCount {
  byPrincipal: number;
  byIp: number;
  oldestPrincipal: Date | null;
  oldestIp: Date | null;
}

export interface UsageConsumeResult extends UsageCount {
  allowed: boolean;
  /** True when the burst cap (not the main allowance) refused the request. */
  burstLimited?: boolean;
}

/**
 * Persistence abstraction. Implementations: PostgreSQL (durable) and an
 * in-memory store (NOT durable — clearly labelled as such in the UI).
 */
export type ArtifactKind = "render" | "performance";

/** Bounded JSON result of an external check (one per page render or per performance strategy). */
export interface ScanArtifact<T = unknown> {
  id: string;
  scanId: string;
  kind: ArtifactKind;
  /** Unique per scan and kind, e.g. the rendered URL or "mobile:<url>". Re-saving the same key replaces it. */
  key: string;
  data: T;
  createdAt: string;
}

export interface Repository {
  readonly kind: "postgres" | "memory";
  readonly persistent: boolean;
  /** Credits, prospects and batch audits (owner-scoped). */
  readonly commerce: CommerceRepository;
  /** First-party website analytics events (private owner dashboard). */
  readonly analytics: AnalyticsRepository;

  ensurePrincipal(id: string, ipHash: string): Promise<void>;
  upsertWebsite(origin: string, hostname: string): Promise<string>;

  /**
   * Stores a new scan. Throws DuplicateScanError if the principal already has a
   * scan with the same idempotency key (concurrent duplicate request).
   */
  createScan(scan: ScanJob): Promise<void>;
  findScanByIdempotencyKey(principalId: string, key: string): Promise<ScanJob | null>;
  getScan(id: string): Promise<ScanJob | null>;
  /** Persists mutable scan fields; only succeeds while the stored status is queued/running. */
  saveScan(scan: ScanJob): Promise<boolean>;
  /** Conditional status transition (e.g. cancel). Returns false if the current status is not in `from`. */
  transitionScan(id: string, from: ScanStatus[], to: ScanStatus, patch?: Partial<Pick<ScanJob, "error" | "finishedAt" | "phase">>): Promise<boolean>;
  listScans(principalId: string, limit: number): Promise<ScanJob[]>;
  countActiveScans(opts: { principalId?: string; activeSince: Date }): Promise<number>;
  acquireLease(id: string, ms: number): Promise<boolean>;
  releaseLease(id: string): Promise<void>;
  pruneHistory(principalId: string, keep: number): Promise<number>;

  insertPages(pages: PageRecord[]): Promise<void>;
  listPages(scanId: string): Promise<PageRecord[]>;
  insertLinkChecks(links: LinkCheckRecord[]): Promise<void>;
  listLinkChecks(scanId: string): Promise<LinkCheckRecord[]>;
  insertFindings(findings: Finding[]): Promise<void>;
  listFindings(scanId: string): Promise<Finding[]>;
  getFinding(scanId: string, findingId: string): Promise<Finding | null>;

  saveArtifact(a: ScanArtifact): Promise<void>;
  listArtifacts(scanId: string, kind?: ArtifactKind): Promise<ScanArtifact[]>;

  saveAiRecommendation(rec: AiRecommendationRecord): Promise<void>;
  getAiRecommendation(scanId: string, findingId: string | null): Promise<AiRecommendationRecord | null>;
  listAiRecommendations(scanId: string): Promise<AiRecommendationRecord[]>;

  countUsage(kind: UsageKind, principalId: string, ipHash: string, since: Date): Promise<UsageCount>;
  /** Atomically checks limits and records one usage event if allowed. */
  consumeUsage(input: UsageConsumeInput): Promise<UsageConsumeResult>;
  /** Removes a previously recorded event (e.g. AI call failed before contacting provider). */
  refundUsage(kind: UsageKind, principalId: string, ipHash: string): Promise<void>;

  getProviderPreference(principalId: string): Promise<ProviderId | null>;
  setProviderPreference(principalId: string, provider: ProviderId | null): Promise<void>;

  // ── Audit management (dashboard) ──
  /** Owner-editable fields. Ownership, sharing membership, and optional compare-and-set state are checked by the repository. */
  updateScanMeta(
    id: string,
    patch: { title?: string | null; organizationId?: string | null },
    access: { principalId: string; organizationMemberUserId?: string; expectedOrganizationId?: string | null },
  ): Promise<boolean>;
  /** Deletes an audit and (by cascade) all its pages, links, issues, metrics, artifacts and history. */
  deleteScan(id: string): Promise<boolean>;
  /** Search / filter / sort / paginate the audits of one principal (optionally plus audits shared with organizations). */
  listAudits(q: AuditQuery): Promise<{ items: ScanListItem[]; total: number }>;
  auditStats(principalId: string, activeSince: Date): Promise<AuditStats>;
  latestIssues(principalId: string, limit: number): Promise<LatestIssue[]>;
  recentActivity(principalId: string, limit: number): Promise<HistoryEvent[]>;
  listHistory(scanId: string): Promise<HistoryEvent[]>;
  setIssueResolution(scanId: string, findingId: string, status: ResolutionStatus, note: string | null): Promise<Finding | null>;
  /** Idempotent: replaces metrics with the same key. */
  saveMetrics(scanId: string, metrics: AuditMetric[]): Promise<void>;
  listMetrics(scanId: string): Promise<AuditMetric[]>;
  /** Moves audits, usage and settings from one principal to another (anonymous → account). Returns audits moved. */
  reassignPrincipal(from: string, to: string): Promise<number>;
  countScans(principalId: string): Promise<number>;
  /** Queued/running audits whose lease is free, oldest first (background processing). */
  listRunnableScans(limit: number, maxAgeMs: number): Promise<RunnableScan[]>;
  /** Removes every row owned by a principal (account deletion). */
  deletePrincipalData(principalId: string): Promise<void>;
}

/** An audit without its (large) internal crawl state — for lists. */
export type ScanListItem = Omit<ScanJob, "state">;

export type AuditSort = "newest" | "oldest" | "score_desc" | "score_asc" | "name";
export type AuditStatusFilter = "all" | "active" | "completed" | "failed" | "cancelled";

export interface AuditQuery {
  principalId: string;
  /** Organizations whose shared audits should be included (caller must have verified membership). */
  organizationIds?: string[];
  search?: string | null;
  status?: AuditStatusFilter;
  sort?: AuditSort;
  page: number;
  pageSize: number;
}

export interface AuditStats {
  total: number;
  completed: number;
  /** Queued or running and still making progress. */
  running: number;
  failed: number;
  cancelled: number;
  /** Mean overall score over the latest scored audit of each site; null when none is scored. */
  averageScore: number | null;
  scoredSites: number;
  /** Open issues in the latest completed audit of each site. */
  severity: Record<Severity, number>;
  sites: number;
}

export interface LatestIssue {
  scanId: string;
  scanTitle: string | null;
  hostname: string;
  finding: Pick<Finding, "id" | "ruleId" | "title" | "severity" | "category" | "affectedUrl" | "affectedCount">;
  createdAt: string;
}

export interface HistoryEvent {
  id: string;
  scanId: string;
  hostname: string | null;
  scanTitle: string | null;
  event: "created" | "status_changed" | "renamed" | "issue_status_changed" | "shared" | "unshared";
  fromStatus: string | null;
  toStatus: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface RunnableScan {
  id: string;
  principalId: string;
  ipHash: string | null;
}

/** A scan with the same (principal, idempotency key) already exists. */
export class DuplicateScanError extends Error {
  constructor() {
    super("A scan with this idempotency key already exists.");
  }
}
