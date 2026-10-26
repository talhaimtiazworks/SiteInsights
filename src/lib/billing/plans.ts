/**
 * The single, authoritative plan catalog for SiteInsights.
 *
 * Every limit, credit allowance, credit cost and feature flag used anywhere in
 * the application (API validation, crawler, background worker, UI, PDF,
 * pricing page) is derived from here. The values below are the LAUNCH
 * DEFAULTS; operators can tune them with PLAN_* / CREDIT_COST_* environment
 * variables after measuring real usage and infrastructure cost, without code
 * changes. Clients never choose a plan: the server resolves it from verified
 * subscription data (see services/scans.ts → entitlementsForPrincipal).
 *
 * Pure module (no server-only imports) so the catalog can be rendered by
 * server components and unit-tested; environment overrides are applied by
 * `buildPlanCatalog(env)`.
 */

export const PLAN_IDS = ["free", "pro", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const isPlanId = (v: unknown): v is PlanId => typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);

export interface PlanFeatures {
  /** Downloadable branded PDF report. */
  pdfExport: boolean;
  /** AI explanation of a single verified finding (costs credits). */
  aiExplanations: boolean;
  /** AI summary / action plan of a whole audit (costs credits). */
  aiSummary: boolean;
  /** Machine-readable JSON export of an audit's verified data. */
  jsonExport: boolean;
  /** Prospect list (lead-generation workflow): save, annotate, track and export sites. */
  prospects: boolean;
  /** Queue several audits in one submission (executed safely in sequence). */
  batchAudits: boolean;
  /** Opportunity ranking and advanced issue filters on the report. */
  advancedFilters: boolean;
  /** Read-only, revocable, expiring report links (with PDF download) to send to a client. */
  shareLinks: boolean;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Price in whole US dollars per billing interval. Display only — charging is done by the billing provider. */
  priceUsd: number;
  interval: "month";
  tagline: string;
  /** Credits granted at the start of every billing period (not rolled over). */
  monthlyCredits: number;
  /** Maximum unique pages crawled in one audit. */
  maxPagesPerAudit: number;
  maxDepth: number;
  maxLinksToCheck: number;
  /** Wall-clock budget of one audit (larger crawls need longer). */
  maxDurationMs: number;
  maxConcurrentAudits: number;
  /** Abuse protection on top of credits: audits that may be STARTED per rolling day. */
  auditsPerDay: number;
  aiRequestsPerDay: number;
  pdfExportsPerDay: number;
  /** Completed audits retained per account. */
  historyLimit: number;
  /** URLs accepted in one batch submission (0 = batch audits unavailable). */
  maxBatchSize: number;
  /** Saved prospects (0 = prospect list unavailable). */
  maxProspects: number;
  features: PlanFeatures;
  /** Short, verifiable bullet points for the pricing page. */
  highlights: string[];
  recommended: boolean;
}

export interface CreditCosts {
  /** Charged once when an audit starts (covers discovery, robots.txt, sitemap and analysis). */
  auditStart: number;
  /** Charged per unique page actually processed. */
  perPage: number;
  /** Charged per AI explanation or AI summary request that reaches a provider. */
  aiRequest: number;
  /** Charged per PDF download (0 at launch: included in the plan). */
  pdfExport: number;
}

export interface PlanCatalog {
  plans: Record<PlanId, PlanDefinition>;
  costs: CreditCosts;
  /** Operator-wide hard cap no plan can exceed (SCAN_HARD_MAX_PAGES). */
  hardMaxPages: number;
  currency: "USD";
}

const DEFAULT_PLANS: Record<PlanId, PlanDefinition> = {
  // SiteInsights is a free product: the Free plan carries every feature and the
  // technical headroom of the former top tier from launch. The pro/business
  // definitions below are kept (with their historical values ONLY) so old
  // subscription rows and their UX snapshots keep displaying coherently; they
  // gate nothing — no route checks plan names for access.
  free: {
    id: "free",
    name: "Free",
    priceUsd: 0,
    interval: "month",
    tagline: "Everything, forever free.",
    monthlyCredits: 100_000,
    maxPagesPerAudit: 500,
    maxDepth: 8,
    maxLinksToCheck: 2000,
    maxDurationMs: 1_500_000,
    maxConcurrentAudits: 3,
    auditsPerDay: 200,
    aiRequestsPerDay: 300,
    pdfExportsPerDay: 300,
    historyLimit: 2000,
    maxBatchSize: 10,
    maxProspects: 1000,
    features: { pdfExport: true, aiExplanations: true, aiSummary: true, jsonExport: true, prospects: true, batchAudits: true, advancedFilters: true, shareLinks: true },
    highlights: ["Up to 500 pages per audit", "Every feature included", "No card, no subscription, no quotas to buy", "Prospects, batch audits, shareable reports", "Free forever for everyone"],
    recommended: false,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsd: 5,
    interval: "month",
    tagline: "For professionals.",
    monthlyCredits: 1000,
    maxPagesPerAudit: 150,
    maxDepth: 5,
    maxLinksToCheck: 750,
    maxDurationMs: 600_000,
    maxConcurrentAudits: 2,
    auditsPerDay: 50,
    aiRequestsPerDay: 100,
    pdfExportsPerDay: 100,
    historyLimit: 500,
    maxBatchSize: 0,
    maxProspects: 0,
    features: { pdfExport: true, aiExplanations: true, aiSummary: true, jsonExport: true, prospects: false, batchAudits: false, advancedFilters: false, shareLinks: false },
    highlights: ["Up to 150 pages per audit", "1,000 credits every month", "Branded PDF reports", "AI explanations of verified findings", "500 audits of history"],
    recommended: false,
  },
  business: {
    id: "business",
    name: "Business",
    priceUsd: 10,
    interval: "month",
    tagline: "For growing teams and businesses.",
    monthlyCredits: 3000,
    maxPagesPerAudit: 500,
    maxDepth: 8,
    maxLinksToCheck: 2000,
    maxDurationMs: 1_500_000,
    maxConcurrentAudits: 3,
    auditsPerDay: 200,
    aiRequestsPerDay: 300,
    pdfExportsPerDay: 300,
    historyLimit: 2000,
    maxBatchSize: 10,
    maxProspects: 1000,
    features: { pdfExport: true, aiExplanations: true, aiSummary: true, jsonExport: true, prospects: true, batchAudits: true, advancedFilters: true, shareLinks: true },
    highlights: ["Up to 500 pages per audit", "3,000 credits every month", "Prospect list with status, notes and CSV export", "Shareable client report links with PDF", "Batch audits of up to 10 sites", "Opportunity ranking and advanced filters", "Everything in Pro"],
    recommended: true,
  },
};

export const DEFAULT_COSTS: CreditCosts = { auditStart: 10, perPage: 1, aiRequest: 2, pdfExport: 0 };

type Env = Record<string, string | undefined>;

function envInt(env: Env, warnings: string[], name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    warnings.push(`${name} is invalid (expected an integer between ${min} and ${max}); using default ${def}.`);
    return def;
  }
  return n;
}

/**
 * Builds the catalog with environment overrides. Recognised variables
 * (X = FREE | PRO | BUSINESS): PLAN_X_CREDITS, PLAN_X_MAX_PAGES, PLAN_X_MAX_DEPTH,
 * PLAN_X_MAX_LINKS, PLAN_X_MAX_DURATION_MS, PLAN_X_CONCURRENT_AUDITS,
 * PLAN_X_AUDITS_PER_DAY, PLAN_X_HISTORY_LIMIT, PLAN_X_AI_PER_DAY and
 * PLAN_X_PDF_PER_DAY (paid plans); CREDIT_COST_AUDIT_START,
 * CREDIT_COST_PAGE, CREDIT_COST_AI, CREDIT_COST_PDF; SCAN_HARD_MAX_PAGES.
 * Legacy free-plan variables (SCAN_MAX_PAGES, SCAN_MAX_DEPTH,
 * FREE_SCANS_PER_WINDOW, FREE_MAX_CONCURRENT_SCANS, FREE_ACCOUNT_HISTORY_LIMIT)
 * are still honoured for the Free plan when the PLAN_FREE_* variable is unset.
 */
export function buildPlanCatalog(env: Env = {}, warnings: string[] = []): PlanCatalog {
  const hardMaxPages = envInt(env, warnings, "SCAN_HARD_MAX_PAGES", 500, 1, 1000);
  const plans = structuredClone(DEFAULT_PLANS);
  const legacyFree: Record<string, string | undefined> = {
    MAX_PAGES: env.SCAN_MAX_PAGES,
    MAX_DEPTH: env.SCAN_MAX_DEPTH,
    AUDITS_PER_DAY: env.FREE_SCANS_PER_WINDOW,
    CONCURRENT_AUDITS: env.FREE_MAX_CONCURRENT_SCANS,
    HISTORY_LIMIT: env.FREE_ACCOUNT_HISTORY_LIMIT,
  };
  for (const id of PLAN_IDS) {
    const p = plans[id];
    const X = id.toUpperCase();
    const named = (suffix: string, def: number, min: number, max: number) => {
      const name = `PLAN_${X}_${suffix}`;
      const value = env[name]?.trim() ? env[name] : id === "free" ? legacyFree[suffix] : undefined;
      return envInt({ [name]: value }, warnings, name, def, min, max);
    };
    p.monthlyCredits = named("CREDITS", p.monthlyCredits, 0, 1_000_000);
    p.maxPagesPerAudit = Math.min(named("MAX_PAGES", p.maxPagesPerAudit, 1, 1000), hardMaxPages);
    p.maxDepth = named("MAX_DEPTH", p.maxDepth, 0, 15);
    p.maxLinksToCheck = named("MAX_LINKS", p.maxLinksToCheck, 0, 5000);
    p.maxDurationMs = named("MAX_DURATION_MS", p.maxDurationMs, 10_000, 1_800_000);
    p.maxConcurrentAudits = named("CONCURRENT_AUDITS", p.maxConcurrentAudits, 1, 50);
    p.auditsPerDay = named("AUDITS_PER_DAY", p.auditsPerDay, 0, 100_000);
    p.historyLimit = named("HISTORY_LIMIT", p.historyLimit, 1, 100_000);
    if (id !== "free") {
      p.aiRequestsPerDay = named("AI_PER_DAY", p.aiRequestsPerDay, 0, 100_000);
      p.pdfExportsPerDay = named("PDF_PER_DAY", p.pdfExportsPerDay, 0, 100_000);
    }
  }
  const costs: CreditCosts = {
    auditStart: envInt(env, warnings, "CREDIT_COST_AUDIT_START", DEFAULT_COSTS.auditStart, 0, 10_000),
    perPage: envInt(env, warnings, "CREDIT_COST_PAGE", DEFAULT_COSTS.perPage, 0, 1000),
    aiRequest: envInt(env, warnings, "CREDIT_COST_AI", DEFAULT_COSTS.aiRequest, 0, 10_000),
    pdfExport: envInt(env, warnings, "CREDIT_COST_PDF", DEFAULT_COSTS.pdfExport, 0, 10_000),
  };
  return { plans, costs, hardMaxPages, currency: "USD" };
}

/** Maximum credits an audit of `maxPages` pages can cost (reserved up front). */
export function estimateAuditCredits(costs: CreditCosts, maxPages: number): number {
  return costs.auditStart + Math.max(0, Math.floor(maxPages)) * costs.perPage;
}

/** The largest page count affordable with `balance` credits, capped by the plan limit. 0 = cannot afford any audit. */
export function affordablePages(costs: CreditCosts, balance: number, planMaxPages: number): number {
  if (balance < costs.auditStart + (costs.perPage > 0 ? costs.perPage : 0)) return 0;
  if (costs.perPage === 0) return planMaxPages;
  return Math.max(0, Math.min(planMaxPages, Math.floor((balance - costs.auditStart) / costs.perPage)));
}

export function formatCredits(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
