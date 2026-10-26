import type { Finding } from "../audit/types";
import type { AuditSummary, IssueExplanation } from "../ai/schemas";
import type { LinkCheckRecord } from "../scanner/types";
import type { PublicScan } from "../services/scans";
import type { PageSummary, RenderSummary } from "../services/views";
import type { PerformanceRun } from "../performance/pagespeed";
import type { UsageDecision } from "../usage/meter";
import type { Entitlements } from "../usage/entitlements";

export type { PublicScan, PageSummary, RenderSummary, PerformanceRun, Finding, LinkCheckRecord, AuditSummary, IssueExplanation, UsageDecision };

export type ClientFinding = Finding & { aiExplanationCached?: boolean };

export interface AiRecord<T> {
  content: T & { fallbackReason?: string | null };
  provider: "openrouter" | "gemini";
  model: string;
  fallbackFrom: "openrouter" | "gemini" | null;
  createdAt: string;
}

export interface ResultsResponse {
  scan: PublicScan;
  findings: ClientFinding[];
  pages: PageSummary[];
  links: LinkCheckRecord[];
  aiSummary: AiRecord<AuditSummary & { omittedFindings?: number; droppedUnsupported?: number }> | null;
  aiAvailable: boolean;
  /** Absent in responses from older servers. */
  renders?: RenderSummary[];
  performance?: PerformanceRun[];
}

export interface SystemFeatures {
  browserRendering: boolean;
  browserPagesPerScan: number;
  accessibility: boolean;
  performance: boolean;
  performanceStrategies: Array<"mobile" | "desktop">;
}

export interface ProvidersResponse {
  /** Supported BYOK providers (metadata only — never any credentials). */
  providers: Array<{
    id: "openrouter" | "gemini";
    label: string;
    model: string;
    keyHelpUrl: string;
    keyHelpText: string;
    keyFormatHint: string;
  }>;
  userPreference: "openrouter" | "gemini" | null;
  preferencePersistent: boolean;
}

export interface UsageResponse {
  entitlements: Omit<Entitlements, "ipLimitMultiplier">;
  usage: { scans: UsageDecision; ai: UsageDecision; browserPages?: UsageDecision; accessibility?: UsageDecision; performance?: UsageDecision; pdf?: UsageDecision };
  available?: { browserRendering: boolean; accessibility: boolean; performance: boolean };
  activeScans: number;
  storage: { mode: "postgres" | "memory" | "unconfigured"; persistent: boolean; ready?: boolean };
  plan?: { id: string; label: string; subscription: { planId: string; status: string; currentPeriodEnd: string | null; cancelAt: string | null } | null; billingAvailable: boolean };
  account?: { signedIn: boolean; accountsEnabled: boolean };
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface AuditListItem {
  id: string;
  title: string | null;
  targetUrl: string;
  hostname: string;
  status: PublicScan["status"];
  phase: string;
  progress: { pagesCrawled: number; pagesDiscovered: number; linksChecked: number; linksTotal: number };
  error: PublicScan["error"];
  overallScore: number | null;
  totalFindings: number | null;
  brokenLinks: number | null;
  hasResults: boolean;
  rerunOf: string | null;
  organizationId: string | null;
  mine: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface AuditListResponse {
  items: AuditListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DashboardResponse {
  stats: { total: number; completed: number; running: number; failed: number; cancelled: number; averageScore: number | null; scoredSites: number; severity: Record<Severity, number>; sites: number };
  latestIssues: Array<{ scanId: string; scanTitle: string | null; hostname: string; createdAt: string; finding: { id: string; ruleId: string; title: string; severity: Severity; category: string; affectedUrl: string; affectedCount?: number } }>;
  activity: Array<{ id: string; scanId: string; hostname: string | null; scanTitle: string | null; event: "created" | "status_changed" | "renamed" | "issue_status_changed" | "shared" | "unshared"; fromStatus: string | null; toStatus: string | null; detail: { rerun_of: string | null; error_code: string | null; title: string | null; rule_id: string | null }; createdAt: string }>;
  usage: UsageResponse;
  claimable: number;
}

export interface SessionInfo {
  status: "disabled" | "anonymous" | "signed_in" | "expired" | "unavailable";
  accountsEnabled: boolean;
  /** Saved appearance preference of the signed-in user. */
  theme: "system" | "light" | "dark" | null;
  settings: { theme: "system" | "light" | "dark"; defaultBrowser: boolean; defaultPerformance: boolean } | null;
  user: { id: string; email: string | null; displayName: string | null; avatarUrl: string | null; isSso: boolean } | null;
}

export interface AuthProvidersInfo {
  enabled: boolean;
  email: boolean;
  google: boolean;
  github: boolean;
  saml: boolean;
  signupDisabled: boolean;
  unavailable: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  createdAt: string;
  role: "owner" | "admin" | "member";
  memberCount: number;
}

export interface AccountResponse {
  profile: { id: string; email: string | null; displayName: string | null; avatarUrl: string | null; createdAt: string; updatedAt: string };
  user: { id: string; email: string | null; providers: string[]; isSso: boolean; sessionMethod: string | null };
  settings: { theme: "system" | "light" | "dark"; defaultBrowser: boolean; defaultPerformance: boolean; updatedAt: string | null };
  organizations: OrganizationSummary[];
  auditCount: number;
  claimable: number;
  deletionAvailable: boolean;
}

export type CompareStatus = "compared" | "not_evaluated_in_baseline" | "not_evaluated_in_latest" | "not_evaluated" | "unavailable_in_baseline" | "unavailable_in_latest" | "unavailable";
export interface ComparePair { baseline: number | null; latest: number | null; delta: number | null; status: CompareStatus }
interface CompareSide { id: string; title: string | null; targetUrl: string; hostname: string; createdAt: string; status: string; pagesScanned: number | null; checks: { browserPages: number; accessibility: boolean; performance: string[] } }
interface BriefIssue { id: string; ruleId: string; title: string; severity: Severity; category: string; affectedUrl: string }
export interface CompareResponse {
  baseline: CompareSide;
  latest: CompareSide;
  comparable: { sameSite: boolean; sameCategories: boolean; sameFormula: boolean; notes: string[] };
  overall: ComparePair;
  categories: Array<ComparePair & { category: string; label: string }>;
  severity: Array<ComparePair & { severity: Severity }>;
  issues: { baselineTotal: number; latestTotal: number; added: BriefIssue[]; addedCount: number; fixed: BriefIssue[]; fixedCount: number; persisting: number };
  links: { checked: ComparePair; broken: ComparePair; inconclusive: ComparePair; newlyBroken: string[]; newlyBrokenCount: number; fixed: string[]; fixedCount: number; noLongerChecked: number; newlyChecked: number };
  metrics: Array<ComparePair & { key: string; metric: string; unit: string; source: string; strategy: string | null }>;
}

// ---- Plans, credits, billing, prospects (mirrors the server responses) ----
export interface CreditCostsInfo { auditStart: number; perPage: number; aiRequest: number; pdfExport: number }
export interface CreditSummaryInfo {
  balance: number;
  allowance: number;
  used: number;
  periodStart: string;
  periodEnd: string;
  resetsAt: string;
  low: boolean;
  costs: CreditCostsInfo;
  plan: { id: "free" | "pro" | "business"; label: string; maxPagesPerAudit: number };
  affordablePages: number;
  fullAuditCost: number;
}
export interface LedgerItem { id: string; delta: number; balanceAfter: number; type: string; operation: string; auditId: string | null; detail: Record<string, unknown> | null; createdAt: string }
export interface CreditsResponse { summary: CreditSummaryInfo; ledger: { total: number; items: LedgerItem[] } }
export type ProspectStatus = "new" | "reviewing" | "contacted" | "converted";
export interface BillingResponse {
  plan: { id: "free" | "pro" | "business"; name: string; priceUsd: number };
  subscription: { status: string; provider: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  credits: CreditSummaryInfo;
  payments: { state: string; message: string | null };
}
export interface ProspectEvidenceInfo { overallScore: number | null; pagesScanned: number; brokenLinks: number; findingsBySeverity: Record<string, number>; totalFindings: number; topIssues: Array<{ title: string; severity: string; affectedCount: number }>; auditStatus: string }
export interface ProspectInfo {
  id: string; hostname: string; websiteUrl: string; businessName: string | null; location: string | null; auditId: string | null; status: ProspectStatus; notes: string | null;
  organizationId: string | null; organizationName: string | null; assignedToUserId: string | null; assignedToName: string | null; assignedToEmail: string | null;
  canManageSharing?: boolean; canDelete?: boolean;
  contactName: string | null; contactEmail: string | null; contactUrl: string | null; evidence: ProspectEvidenceInfo | null;
  auditedAt: string | null; createdAt: string; updatedAt: string;
}
export interface ProspectsResponse { items: ProspectInfo[]; total: number; byStatus: Record<ProspectStatus, number>; canEdit: boolean; limit: number }
export type BatchItemStatus = "pending" | "started" | "skipped" | "failed";
export interface BatchItemInfo { id: string; position: number; url: string; maxPages: number; status: BatchItemStatus; auditId: string | null; error: string | null; createdAt: string; updatedAt: string; audit?: PublicScan | null }
export interface BatchInfo { id: string; createdAt: string; items: BatchItemInfo[] }
