import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertAuditAccount, isAccountPrincipal } from "../auth/audit-policy";
import { supportedProviders } from "../ai/registry";
import { getConfig } from "../config/env";
import { deriveMetrics } from "../audit/metrics";
import { getRepository, maybeAccountRepository, storageInfo } from "../db";
import { DuplicateScanError, type Repository } from "../db/types";
import { ApiError } from "../http/api";
import type { RequestContext } from "../http/context";
import { resolvePublicHost } from "../security/safe-fetch";
import { validatePublicUrl } from "../security/url";
import { renderPage } from "../browser/client";
import { runPageSpeed } from "../performance/pagespeed";
import { advanceScan, createScanJob, type EngineDeps } from "../scanner/engine";
import type { ScanJob, ScanLimits } from "../scanner/types";
import { hasResults, isTerminal } from "../scans/state-machine";
import type { PerformanceRun } from "../performance/pagespeed";
import { logger } from "../logger";
import type { Entitlements } from "../usage/entitlements";
import { entitlementsForPrincipal as resolveEntitlements } from "./plan";
import { auditSettleKey, settleAuditCreditsSafe } from "../credits/service";
import { consumeUsage } from "../usage/meter";
import { ensureAccountReady } from "./dashboard";
import { refundUsageSafe } from "../usage/refund";

/** A scan is considered abandoned (not counted as active) after this long without progress. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

/** Supported BYOK providers (static metadata: labels, default models, key-help links). */
export function aiProviderSupport() {
  return supportedProviders(getConfig().ai);
}

/**
 * True when AI explanations can be offered: with strict BYOK that means the
 * providers are supported — the USER must then supply their own key per
 * session (there is no server key to check here).
 */
export function aiAvailable(): boolean {
  return aiProviderSupport().length > 0;
}

/**
 * Plan and limits for a principal, decided on the server only from verified
 * subscription data (see services/plan.ts). Anonymous browsers get Free.
 */
export async function entitlementsForPrincipal(principalId: string): Promise<Entitlements> {
  return resolveEntitlements(principalId);
}

export function entitlementsFor(ctx: Pick<RequestContext, "principalId">): Promise<Entitlements> {
  return entitlementsForPrincipal(ctx.principalId);
}

export interface Viewer {
  /** May rename, delete, re-run, share and triage issues. */
  canEdit: boolean;
  /** Read access through an organization (not the owner). */
  viaOrganization: boolean;
}

export function toPublicScan(scan: ScanJob, viewer: Viewer = { canEdit: true, viaOrganization: false }) {
  const { state, principalId, access: _a, ipHash: _i, ...rest } = scan;
  void _a;
  void _i;
  return {
    ...rest,
    title: scan.title ?? null,
    rerunOf: scan.rerunOf ?? null,
    organizationId: scan.organizationId ?? null,
    overallScore: scan.overallScore ?? null,
    ownedByAccount: principalId.startsWith("user:"),
    viewer,
    hasResults: hasResults(scan.status),
    persistent: storageInfo().persistent,
    limits: {
      maxPages: scan.limits.maxPages,
      maxDepth: scan.limits.maxDepth,
      maxLinksToCheck: scan.limits.maxLinksToCheck,
      maxDurationMs: scan.limits.maxDurationMs,
      requestedPages: scan.limits.requestedPages ?? scan.limits.maxPages,
      browserPages: scan.limits.browserPages ?? 0,
      accessibility: !!scan.limits.accessibility && (scan.limits.browserPages ?? 0) > 0,
      performanceStrategies: scan.limits.performanceStrategies ?? [],
    },
    crawl: {
      skipped: state.skipped,
      robots: state.robots ? { status: state.robots.status, url: state.robots.url, httpStatus: state.robots.httpStatus, sitemaps: state.robots.sitemaps, crawlDelayMs: state.robots.crawlDelayMs } : null,
      sitemap: state.sitemap ? { status: state.sitemap.status, checked: state.sitemap.checked, urlsFound: state.sitemap.pageUrls.length, offHostUrls: state.sitemap.offHostUrls } : null,
      allowedHosts: state.allowedHosts,
      crawlTruncated: state.crawlTruncated,
    },
  };
}
export type PublicScan = ReturnType<typeof toPublicScan>;

export const hashScanKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const newScanKey = () => `sk_${randomBytes(32).toString("base64url")}`;

export interface ScanAccessContext {
  principalId: string;
  /** This browser's anonymous ID (audits started here before signing in). */
  anonymousPrincipalId?: string;
  isNewPrincipal?: boolean;
  scanKey?: string | null;
  user?: { id: string } | null;
  auth?: RequestContext["auth"];
}

export interface OwnedScan {
  scan: ScanJob;
  viewer: Viewer;
}

/** Account owner or verified organization membership; legacy private-link keys never grant access. */
export async function loadScanAccess(repo: Repository, id: string, ctx: ScanAccessContext, mode: "read" | "write" = "write"): Promise<OwnedScan> {
  assertAuditAccount(ctx);
  const scan = await repo.getScan(id);
  if (scan) {
    if (scan.principalId === ctx.principalId) return { scan, viewer: { canEdit: true, viaOrganization: false } };
    if (mode === "read" && scan.organizationId) {
      const accounts = maybeAccountRepository();
      if (accounts && (await accounts.getMembership(scan.organizationId, ctx.user.id))) return { scan, viewer: { canEdit: false, viaOrganization: true } };
    }
  }
  // Identical for missing and foreign IDs: do not disclose another account's audits.
  throw new ApiError(404, "not_found", "Audit not found.");
}

/** Owner-level access (see loadScanAccess). */
export async function loadOwnedScan(repo: Repository, id: string, ctx: ScanAccessContext): Promise<ScanJob> {
  return (await loadScanAccess(repo, id, ctx, "write")).scan;
}

/** Optional checks requested for an audit (each only runs if the deployment supports it). */
export interface ScanChecks {
  browser?: boolean;
  accessibility?: boolean;
  performance?: boolean;
}

/** Which optional checks this deployment can run. */
export function availableChecks() {
  const cfg = getConfig();
  const browser = !!cfg.browser.workerUrl && cfg.browser.maxPagesPerScan > 0;
  return { browser, accessibility: browser && cfg.browser.accessibility, performance: cfg.performance.enabled, browserPages: browser ? cfg.browser.maxPagesPerScan : 0, performanceStrategies: cfg.performance.enabled ? cfg.performance.strategies : [] };
}

export interface StartScanResult {
  scan: ScanJob;
  /** Returned once, to the creating browser only. null when an earlier identical request is replayed. */
  accessKey: string | null;
  /** True when an earlier request with the same idempotency key already created this scan. */
  replayed: boolean;
}

export async function startScan(
  ctx: RequestContext,
  rawUrl: string,
  opts: { idempotencyKey?: string | null; resolveHost?: typeof resolvePublicHost; checks?: ScanChecks; rerunOf?: string | null; title?: string | null; maxPages?: number | null; /** Server-internal: owner-authorised batch item started without a live request (profile already exists). */ trustedOwner?: boolean } = {},
): Promise<StartScanResult> {
  // Defense in depth: reject before storage, DNS, metering, idempotency replay or enqueueing.
  assertAuditAccount(ctx);
  const cfg = getConfig();
  const repo = getRepository();
  const ent = await entitlementsFor(ctx);

  const v = validatePublicUrl(rawUrl, { allowedPorts: cfg.scanner.allowedPorts });
  if (!v.ok) throw new ApiError(400, `invalid_url`, v.message, { reason: v.reason });

  // Per-audit page limit: the plan's limit, or a smaller limit the user chose. Never larger.
  const requestedPages = opts.maxPages ?? ent.maxPagesPerScan;
  if (!Number.isInteger(requestedPages) || requestedPages < 1) throw new ApiError(400, "invalid_page_limit", "The page limit must be a whole number of at least 1.");
  if (requestedPages > ent.maxPagesPerScan) {
    throw new ApiError(403, "page_limit_exceeded", `Audits are limited to ${ent.maxPagesPerScan} pages for this deployment. Choose ${ent.maxPagesPerScan} or fewer.`, { maxPagesPerAudit: ent.maxPagesPerScan });
  }

  // A retried request (double click, flaky network) returns the original scan.
  const idem = opts.idempotencyKey ?? null;
  if (idem) {
    const existing = await repo.findScanByIdempotencyKey(ctx.principalId, idem);
    if (existing) return { scan: existing, accessKey: null, replayed: true };
  }

  const dns = await (opts.resolveHost ?? resolvePublicHost)(v.url.hostname);
  if (!dns.ok) throw new ApiError(400, dns.code === "dns_error" ? "dns_error" : "unsafe_url", dns.message);

  const activeSince = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const globalActive = await repo.countActiveScans({ activeSince });
  if (globalActive >= cfg.usage.globalMaxConcurrentScans) {
    throw new ApiError(503, "capacity_reached", "SiteInsights is at capacity right now. Please try again in a few minutes.");
  }
  // An identical request (same idempotency key) that is still being created
  // must be replayed, not rejected because it now counts as "in progress".
  const replayOr = async (err: ApiError) => {
    if (idem) {
      const existing = await repo.findScanByIdempotencyKey(ctx.principalId, idem);
      if (existing) return { scan: existing, accessKey: null, replayed: true } as const;
    }
    throw err;
  };
  const concurrentError = (n: number) =>
    new ApiError(429, "concurrent_scan_limit", `You already have ${n} audit${n === 1 ? "" : "s"} in progress. Up to ${ent.maxConcurrentScans} can run at the same time — wait for one to finish or cancel it.`);
  const mine = await repo.countActiveScans({ principalId: ctx.principalId, activeSince });
  if (mine >= ent.maxConcurrentScans) return replayOr(concurrentError(mine));

  if (!opts.trustedOwner) await ensureAccountReady(ctx);
  await repo.ensurePrincipal(ctx.principalId, ctx.ipHash);
  // With an Idempotency-Key the audit id is derived from it, so concurrent or
  // retried duplicates resolve to ONE audit (no double-run).
  let scanId: string = randomUUID();
  if (idem) {
    // Attempt 0 is the plain key. An attempt that failed before its audit was
    // stored moves on to the next deterministic attempt id so the client's
    // retry still succeeds.
    let chosen: string | null = null;
    for (let attempt = 0; attempt < MAX_IDEMPOTENT_ATTEMPTS && !chosen; attempt++) {
      const id = idempotentScanId(ctx.principalId, idem, attempt);
      const existing = await waitForScan(repo, ctx.principalId, id);
      if (existing) {
        if (existing.principalId === ctx.principalId) return { scan: existing, accessKey: null, replayed: true };
        throw new ApiError(409, "idempotency_conflict", "This Idempotency-Key cannot be used.");
      }
      chosen = id;
    }
    if (!chosen) throw new ApiError(409, "idempotency_key_exhausted", "This request failed too many times. Please submit the audit again without retrying the same request.");
    scanId = chosen;
  }
  // Usage windows: rolling technical safeguards against runaway/abusive
  // workloads — never commercial quotas (SiteInsights is free for everyone).
  const usage = await consumeUsage(repo, ctx, "scan", ent);
  if (!usage.allowed) {
    if (idem) {
      const existing = await repo.findScanByIdempotencyKey(ctx.principalId, idem);
      if (existing) return { scan: existing, accessKey: null, replayed: true };
    }
    if (usage.limitedBy === "burst") {
      throw new ApiError(429, "scan_burst_limited", `You can start up to ${ent.auditBurstLimit} audits every ${Math.round(ent.auditBurstWindowSeconds / 60)} minutes. Please wait a few minutes and try again.`, { resetAt: usage.resetAt, burstLimit: ent.auditBurstLimit, burstWindowSeconds: ent.auditBurstWindowSeconds });
    }
    throw new ApiError(429, "scan_limit_reached", `You have started ${usage.limit} audits in the current window. Please try again a little later.`, { resetAt: usage.resetAt, limit: usage.limit, windowSeconds: usage.windowSeconds });
  }

  const accessKey = newScanKey();
  /** Clean up a half-created audit when inserting it failed (a concurrent duplicate may own the id). */
  const releaseIfOrphaned = async () => {
    if (!(await repo.getScan(scanId).catch(() => null))) await settleAuditCreditsSafe(repo, { principalId: ctx.principalId, auditId: scanId }, null);
  };
  const create = async (): Promise<ScanJob> => {
    const limits: ScanLimits = {
      maxPages: requestedPages,
      requestedPages,
      maxDepth: ent.maxDepth,
      maxRedirects: cfg.scanner.maxRedirects,
      concurrency: cfg.scanner.concurrency,
      requestTimeoutMs: cfg.scanner.requestTimeoutMs,
      maxBodyBytes: cfg.scanner.maxBodyBytes,
      maxDurationMs: ent.maxDurationMs,
      maxRetries: cfg.scanner.maxRetries,
      hostMinIntervalMs: cfg.scanner.hostMinIntervalMs,
      maxLinksToCheck: ent.maxLinksToCheck,
      stepBudgetMs: cfg.scanner.stepBudgetMs,
      allowedPorts: cfg.scanner.allowedPorts,
      maxQueryVariantsPerPath: cfg.scanner.maxQueryVariantsPerPath,
      maxSitemapFiles: cfg.scanner.maxSitemapFiles,
      maxSitemapUrls: Math.max(cfg.scanner.maxSitemapUrls, requestedPages),
    };
    const avail = availableChecks();
    const want = { browser: true, accessibility: true, performance: true, ...opts.checks };
    limits.browserPages = avail.browser && want.browser ? Math.min(avail.browserPages, ent.maxBrowserPagesPerScan, limits.maxPages) : 0;
    limits.accessibility = avail.accessibility && want.accessibility && limits.browserPages > 0;
    limits.performanceStrategies = avail.performance && want.performance ? [...avail.performanceStrategies] : [];
    if (limits.browserPages > 0) {
      limits.browserTimeoutMs = cfg.browser.workerTimeoutMs;
      limits.browserNavTimeoutMs = cfg.browser.navigationTimeoutMs;
    }
    if (limits.performanceStrategies.length) limits.performanceTimeoutMs = cfg.performance.timeoutMs;
    const websiteId = await repo.upsertWebsite(v.url.origin, v.url.hostname);
    const scan = createScanJob({ id: scanId, principalId: ctx.principalId, websiteId, targetUrl: v.normalized, limits });
    scan.access = { keyHash: hashScanKey(accessKey), idempotencyKey: idem };
    scan.ipHash = ctx.ipHash;
    scan.rerunOf = opts.rerunOf ?? null;
    scan.title = opts.title ?? null;
    // The scan is durably stored before success is reported to the client.
    await repo.createScan(scan);
    return scan;
  };
  let scan: ScanJob;
  try {
    // Everything between taking the allowance and storing the audit is covered:
    // a failure here (website upsert, insert, outage) gives the allowance back.
    scan = await create();
  } catch (err) {
    await refundUsageSafe(repo, ctx, "scan"); // exactly once
    await releaseIfOrphaned(); // full refund when no audit was stored
    if (err instanceof DuplicateScanError && idem) {
      // A concurrent identical request won the race: give back its scan.
      const existing = await repo.findScanByIdempotencyKey(ctx.principalId, idem);
      if (existing) return { scan: existing, accessKey: null, replayed: true };
    }
    throw err;
  }
  // Defensive historical guard (inert in the free-product model, kept so a
  // residual race can never run two half-created copies of the same audit).
  if (await repo.commerce.getLedgerEntry(ctx.principalId, auditSettleKey(scan.id))) {
    await repo.deleteScan(scan.id).catch(() => false);
    await refundUsageSafe(repo, ctx, "scan");
    throw new ApiError(503, "retry", "The audit could not be started. Please try again.");
  }
  // Two different requests can pass the concurrency check at the same moment;
  // re-count after the insert and roll this one back if the cap is exceeded.
  const after = await repo.countActiveScans({ principalId: ctx.principalId, activeSince });
  if (after > ent.maxConcurrentScans) {
    await repo.deleteScan(scan.id).catch(() => false);
    await refundUsageSafe(repo, ctx, "scan");
    await settleAuditCreditsSafe(repo, { principalId: ctx.principalId, auditId: scan.id }, null);
    throw concurrentError(after - 1);
  }
  await repo.pruneHistory(ctx.principalId, ent.historyLimit).catch(() => 0);
  return { scan, accessKey, replayed: false };
}

/** Deterministic audit id for (principal, Idempotency-Key), formatted as a UUID. */
const MAX_IDEMPOTENT_ATTEMPTS = 5;

export function idempotentScanId(principalId: string, idem: string, attempt = 0): string {
  const h = createHash("sha256").update(`audit\n${principalId}\n${idem}${attempt ? `\n#${attempt}` : ""}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Waits briefly for a concurrent duplicate request to finish storing its audit. */
async function waitForScan(repo: Repository, principalId: string, id: string): Promise<ScanJob | null> {
  for (let i = 0; i < 20; i++) {
    const s = await repo.getScan(id);
    if (s) return s;
    if (await repo.commerce.getLedgerEntry(principalId, auditSettleKey(id))) return null; // the earlier attempt failed and was refunded
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/**
 * Runs one bounded step of a scan. Costly checks (browser pages, axe-core,
 * PageSpeed) are charged to the scan's owner — and the caller's IP — when the
 * work actually runs, and refunded if the external service fails.
 */
export async function runScanStep(scan: Pick<ScanJob, "id" | "principalId">, ctx: Pick<RequestContext, "ipHash">) {
  if (!isAccountPrincipal(scan.principalId)) throw new ApiError(401, "auth_required", "Legacy anonymous audits must be claimed by an account before they can continue.");
  const cfg = getConfig();
  const repo = getRepository();
  const ent = await entitlementsForPrincipal(scan.principalId);
  const who = { principalId: scan.principalId, ipHash: ctx.ipHash };
  const deps: EngineDeps = {
    repo,
    userAgent: cfg.scanner.userAgent,
    aiAvailable: aiAvailable(),
    browser: cfg.browser.workerUrl && cfg.browser.workerToken ? { render: (req) => renderPage(req, { workerUrl: cfg.browser.workerUrl!, token: cfg.browser.workerToken!, timeoutMs: cfg.browser.workerTimeoutMs }) } : null,
    performance: cfg.performance.enabled ? { run: (url, strategy) => runPageSpeed(url, strategy, { apiKey: cfg.performance.apiKey, timeoutMs: cfg.performance.timeoutMs }) } : null,
    usage: {
      consume: async (kind) => (await consumeUsage(repo, who, kind, ent)).allowed,
      refund: (kind) => refundUsageSafe(repo, who, kind),
    },
  };
  const res = await advanceScan(scan.id, deps);
  if (res.scan && isTerminal(res.scan.status) && !res.leaseBusy) {
    await recordMetricsSafe(repo, res.scan);
    await onAuditFinished(repo, res.scan);
  }
  return res;
}

/** Credit settlement and the next queued batch audit (both idempotent, never throw). */
export async function onAuditFinished(repo: Repository, scan: ScanJob) {
  await settleAuditCreditsSafe(repo, { principalId: scan.principalId, auditId: scan.id }, scan);
  try {
    const { pumpBatchQueue } = await import("./batches");
    await pumpBatchQueue(scan.principalId, scan.ipHash ?? null);
  } catch (err) {
    logger.warn("Could not start the next queued batch audit", err);
  }
}

/** Persists source-attributed metrics for a finished audit (idempotent; failures never affect the audit). */
export async function recordMetricsSafe(repo: Repository, scan: ScanJob) {
  try {
    if ((await repo.listMetrics(scan.id)).length) return;
    const perf = (await repo.listArtifacts(scan.id, "performance")).map((a) => a.data as PerformanceRun);
    await repo.saveMetrics(scan.id, deriveMetrics(scan.summary, perf));
  } catch (err) {
    logger.warn("Could not record audit metrics", err);
  }
}
