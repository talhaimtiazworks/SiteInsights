import type { AppConfig } from "../config/env";
import { isPlanId, type PlanFeatures, type PlanId } from "../billing/plans";

/**
 * Entitlements describe what a principal may do. They are derived ONLY from
 * the authoritative plan catalog (billing/plans.ts, with operator env
 * overrides) and the plan the server resolved from verified subscription data
 * — never from anything a client sends. Unknown plan ids fall back to Free.
 *
 * NOTE (free-product conversion): SiteInsights no longer sells plans. Every
 * catalog entry carries the full feature set, and this module intentionally
 * contains no plan-based gating logic of its own — per-window/browser limits
 * resolve to the same technical safeguards for everyone (abuse protection,
 * never commercial quotas), and AI/PDF availability comes from the catalog.
 */
export type { PlanId };

export interface Entitlements {
  plan: PlanId;
  planLabel: string;
  priceUsd: number;
  monthlyCredits: number;
  maxPagesPerScan: number;
  maxDepth: number;
  maxLinksToCheck: number;
  maxDurationMs: number;
  scansPerWindow: number;
  scanWindowSeconds: number;
  aiRequestsPerWindow: number;
  aiWindowSeconds: number;
  maxAiInputChars: number;
  maxConcurrentScans: number;
  historyLimit: number;
  ipLimitMultiplier: number;
  advancedWindowSeconds: number;
  browserPagesPerWindow: number;
  maxBrowserPagesPerScan: number;
  accessibilityTestsPerWindow: number;
  performanceTestsPerWindow: number;
  pdfExportsPerWindow: number;
  auditBurstLimit: number;
  auditBurstWindowSeconds: number;
  aiBurstLimit: number;
  aiBurstWindowSeconds: number;
  maxBatchSize: number;
  maxProspects: number;
  features: PlanFeatures & { browserRendering: boolean; performance: boolean; accessibility: boolean };
}

export interface PrincipalInfo {
  id: string;
  plan: string;
  /** Signed-in account (anonymous legacy principals keep the small legacy history limit). */
  isUser?: boolean;
  /** Retain at least this many audits (grace period after a downgrade, so history is not deleted abruptly). */
  historyFloor?: number;
}

/** Technical multiplier applied to browser-side check windows for every principal (was the former top tier's rate). */
const PAID_TECH_MULTIPLIER = 10;

export function getEntitlements(principal: PrincipalInfo, cfg: AppConfig): Entitlements {
  const planId: PlanId = isPlanId(principal.plan) ? principal.plan : "free";
  const p = cfg.plans.plans[planId];
  const u = cfg.usage;
  const history = principal.isUser === false ? u.historyLimit : Math.max(p.historyLimit, principal.historyFloor ?? 0);
  // Same technical headroom for every principal: usage windows are abuse-rate
  // safeguards (rolling starts / burst caps), not plan tiers to buy.
  return {
    plan: planId,
    planLabel: p.name,
    priceUsd: p.priceUsd,
    monthlyCredits: p.monthlyCredits,
    maxPagesPerScan: Math.min(p.maxPagesPerAudit, cfg.scanner.maxPages),
    maxDepth: Math.min(p.maxDepth, cfg.scanner.maxDepth),
    maxLinksToCheck: Math.min(p.maxLinksToCheck, cfg.scanner.maxLinksToCheck),
    maxDurationMs: Math.min(p.maxDurationMs, cfg.scanner.maxDurationMs),
    scansPerWindow: p.auditsPerDay,
    scanWindowSeconds: u.scanWindowSeconds,
    aiRequestsPerWindow: p.aiRequestsPerDay,
    aiWindowSeconds: u.aiWindowSeconds,
    maxAiInputChars: u.maxAiInputChars,
    maxConcurrentScans: p.maxConcurrentAudits,
    historyLimit: history,
    ipLimitMultiplier: u.ipLimitMultiplier,
    advancedWindowSeconds: u.advancedWindowSeconds,
    browserPagesPerWindow: u.browserPagesPerWindow * PAID_TECH_MULTIPLIER,
    maxBrowserPagesPerScan: cfg.browser.maxPagesPerScan,
    accessibilityTestsPerWindow: u.accessibilityTestsPerWindow * PAID_TECH_MULTIPLIER,
    performanceTestsPerWindow: u.performanceTestsPerWindow * PAID_TECH_MULTIPLIER,
    pdfExportsPerWindow: p.features.pdfExport ? p.pdfExportsPerDay : 0,
    auditBurstLimit: Math.max(u.auditBurstLimit, p.maxBatchSize + u.auditBurstLimit),
    auditBurstWindowSeconds: u.auditBurstWindowSeconds,
    aiBurstLimit: u.aiBurstLimit,
    aiBurstWindowSeconds: u.aiBurstWindowSeconds,
    maxBatchSize: p.features.batchAudits ? p.maxBatchSize : 0,
    maxProspects: p.features.prospects ? p.maxProspects : 0,
    features: { ...p.features, browserRendering: true, performance: true, accessibility: true },
  };
}
