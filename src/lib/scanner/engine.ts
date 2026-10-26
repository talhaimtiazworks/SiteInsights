import { randomUUID } from "node:crypto";
import { analyzeScan, isOkHtmlPage, uniqueOkHtmlPages } from "../audit/analyze";
import { performanceScore } from "../audit/analyze-performance";
import { computeScores, SCORE_FORMULA_VERSION } from "../audit/scoring";
import { CATEGORIES, type Finding } from "../audit/types";
import type { RenderOutcome } from "../browser/client";
import type { RenderRequestInput, RenderResult } from "../browser/protocol";
import type { Repository, ScanArtifact } from "../db/types";
import type { PerformanceRun } from "../performance/pagespeed";
import { classifyDatabaseError } from "../db/errors";
import { logger } from "../logger";
import { decodeBody, safeFetch, type SafeFetchOptions, type SafeFetchResult } from "../security/safe-fetch";
import { normalizeUrl, sameSiteHost, validatePublicUrl } from "../security/url";
import { assertTransition, isTerminal } from "../scans/state-machine";
import { evaluateCrawlCandidate } from "./frontier";
import { isHtmlContentType, parseHtml, type ParsedHtml } from "./html";
import { classifyFetchResult, HEAD_FALLBACK_STATUSES } from "./link-classify";
import { HostRateLimiter } from "./pool";
import { buildRobotsChecker, extractRobotsSitemaps, type RobotsChecker } from "./robots";
import { maybeGunzip, parseSitemap } from "./sitemap";
import { BROKEN_CATEGORIES, INCONCLUSIVE_CATEGORIES, type DiscoverySource, type FrontierItem, type LinkCheckRecord, type LinkTarget, type PageRecord, type ScanJob, type ScanLimits, type ScanState } from "./types";

/**
 * Scan engine.
 *
 * A scan is executed as a series of bounded STEPS. Each call to `advanceScan`
 * holds a lease on the scan, performs work until `stepBudgetMs` elapses, saves
 * all state, and returns. This keeps every invocation well inside serverless
 * function limits. The same function can be called from a browser-driven loop
 * (current deployment), a cron job, or a dedicated worker service later.
 */

export type MeteredKind = "browser_page" | "accessibility_test" | "performance_test";

export interface EngineDeps {
  repo: Repository;
  userAgent: string;
  aiAvailable: boolean;
  /** External browser worker. Absent = rendering is skipped (HTTP crawl still runs). */
  browser?: { render(req: RenderRequestInput): Promise<RenderOutcome> } | null;
  /** PageSpeed Insights. Absent = performance is "Not evaluated". */
  performance?: { run(url: string, strategy: "mobile" | "desktop"): Promise<PerformanceRun> } | null;
  /** Server-side allowance for costly checks, charged when the work actually runs. */
  usage?: { consume(kind: MeteredKind): Promise<boolean>; refund(kind: MeteredKind): Promise<void> } | null;
  /** Test-only overrides (address policy / DNS). Never derived from user input or env. */
  fetchOverrides?: Pick<SafeFetchOptions, "addressPolicy" | "lookup">;
  now?: () => number;
}

const MAX_SEEN = 20_000;
const MAX_RECENT = 6;

export function initialState(startUrl: string): ScanState {
  return {
    frontier: [],
    seen: [],
    queryVariantCounts: {},
    allowedHosts: [new URL(startUrl).hostname],
    robots: null,
    sitemap: null,
    linkTargets: [],
    linkCursor: 0,
    linkTargetsBuilt: false,
    skipped: { robots: 0, limit: 0, traps: 0, offHost: 0, depth: 0, duplicates: 0 },
    processed: [],
    failedFetches: 0,
    httpErrors: 0,
    crawlTruncated: false,
    durationExceeded: false,
  };
}

export function createScanJob(p: { id?: string; principalId: string; websiteId: string | null; targetUrl: string; limits: ScanLimits }): ScanJob {
  const now = new Date().toISOString();
  return {
    id: p.id ?? randomUUID(),
    principalId: p.principalId,
    websiteId: p.websiteId,
    targetUrl: p.targetUrl,
    hostname: new URL(p.targetUrl).hostname,
    status: "queued",
    phase: "queued",
    limits: p.limits,
    progress: { pagesCrawled: 0, pagesDiscovered: 1, pagesQueued: 0, pagesFailed: 0, pagesHttpErrors: 0, pagesSkipped: 0, pagesRemaining: 1, pagesLimit: p.limits.maxPages, linksChecked: 0, linksTotal: 0, findings: 0, recentUrls: [] },
    state: initialState(p.targetUrl),
    warnings: [],
    error: null,
    summary: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
}

export async function advanceScan(scanId: string, deps: EngineDeps): Promise<{ scan: ScanJob | null; leaseBusy: boolean }> {
  const scan = await deps.repo.getScan(scanId);
  if (!scan) return { scan: null, leaseBusy: false };
  if (isTerminal(scan.status)) return { scan, leaseBusy: false };
  const external = Math.max(scan.limits.browserTimeoutMs ?? 0, scan.limits.performanceTimeoutMs ?? 0);
  const leaseMs = Math.max(scan.limits.stepBudgetMs + scan.limits.requestTimeoutMs * (scan.limits.maxRetries + 2), external) + 15_000;
  if (!(await deps.repo.acquireLease(scanId, leaseMs))) return { scan, leaseBusy: true };
  try {
    const runner = new ScanRunner(scan, deps);
    await runner.step();
  } catch (err) {
    const problem = classifyDatabaseError(err);
    if (problem === "database_unavailable" || problem === "database_busy") {
      // Transient: everything up to the last completed step is saved. Leave the
      // audit queued/running so the next invocation (cron, hand-off, open page) resumes it.
      logger.warn(`Scan ${scanId} paused (${problem}); it resumes on the next attempt.`);
      throw err;
    }
    if ((await deps.repo.getScan(scanId).catch(() => undefined)) === null) {
      logger.info(`Scan ${scanId} was deleted while it was being processed; stopping.`);
      return { scan: null, leaseBusy: false };
    }
    logger.error(`Scan ${scanId} failed with an internal error`, err);
    await deps.repo.transitionScan(scanId, ["queued", "running"], "failed", {
      error: { code: "internal_error", message: "The scan stopped because of an unexpected internal error. Please try again." },
      finishedAt: new Date().toISOString(),
      phase: "finished",
    });
  } finally {
    await deps.repo.releaseLease(scanId).catch(() => {});
  }
  return { scan: await deps.repo.getScan(scanId), leaseBusy: false };
}

class ScanRunner {
  private now: () => number;
  private limiter: HostRateLimiter;
  private robots: RobotsChecker;
  private seen: Set<string>;
  private processed: Set<string>;
  private stopped = false;

  constructor(private scan: ScanJob, private deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.limiter = new HostRateLimiter(scan.limits.hostMinIntervalMs);
    this.robots = buildRobotsChecker(scan.state.robots);
    if (this.robots.crawlDelayMs) this.limiter.setInterval(this.robots.crawlDelayMs);
    this.seen = new Set(scan.state.seen);
    this.processed = new Set(scan.state.processed ?? []);
  }

  /** Page fetches that used the page budget: unique responses + fetches without a response. */
  private attempted(): number {
    return this.scan.progress.pagesCrawled + (this.s.failedFetches ?? 0);
  }

  private get s(): ScanState {
    return this.scan.state;
  }

  private fetchOpts(over: Partial<SafeFetchOptions> = {}): SafeFetchOptions {
    const l = this.scan.limits;
    return {
      timeoutMs: l.requestTimeoutMs,
      maxBodyBytes: l.maxBodyBytes,
      maxRedirects: l.maxRedirects,
      userAgent: this.deps.userAgent,
      allowedPorts: l.allowedPorts,
      retries: l.maxRetries,
      ...this.deps.fetchOverrides,
      ...over,
    };
  }

  private async fetchLimited(url: string, over: Partial<SafeFetchOptions> = {}): Promise<SafeFetchResult> {
    try {
      await this.limiter.wait(new URL(url).host);
    } catch {
      /* invalid URL: safeFetch reports it */
    }
    return safeFetch(url, this.fetchOpts(over));
  }

  private isAllowedHost(host: string): boolean {
    return this.s.allowedHosts.some((h) => sameSiteHost(h, host));
  }

  private warn(msg: string) {
    if (!this.scan.warnings.includes(msg)) this.scan.warnings.push(msg);
  }

  private async persist(): Promise<boolean> {
    this.s.seen = [...this.seen];
    this.s.processed = [...this.processed];
    const p = this.scan.progress;
    const k = this.s.skipped;
    p.pagesQueued = this.s.frontier.length;
    p.pagesFailed = this.s.failedFetches ?? 0;
    p.pagesHttpErrors = this.s.httpErrors ?? 0;
    p.pagesSkipped = k.robots + k.limit + k.traps + k.depth + (k.duplicates ?? 0);
    p.pagesLimit = this.scan.limits.maxPages;
    p.pagesRemaining = this.scan.phase === "crawling" || this.scan.phase === "discovery" || this.scan.phase === "queued" ? Math.max(0, Math.min(this.s.frontier.length, this.scan.limits.maxPages - this.attempted())) : 0;
    const ok = await this.deps.repo.saveScan(this.scan);
    if (!ok) this.stopped = true; // cancelled (or otherwise finalised) concurrently
    return ok;
  }

  private async cancelledExternally(): Promise<boolean> {
    const cur = await this.deps.repo.getScan(this.scan.id);
    return !cur || cur.status === "cancelled" || isTerminal(cur.status);
  }

  private async fail(code: string, message: string) {
    assertTransition(this.scan.status, "failed");
    this.scan.status = "failed";
    this.scan.phase = "finished";
    this.scan.error = { code, message };
    this.scan.finishedAt = new Date().toISOString();
    await this.persist();
    this.stopped = true;
  }

  async step(): Promise<void> {
    const stepStart = this.now();
    const deadline = stepStart + this.scan.limits.stepBudgetMs;
    if (this.scan.status === "queued") {
      assertTransition("queued", "running");
      this.scan.status = "running";
      this.scan.phase = "discovery";
      this.scan.startedAt = new Date().toISOString();
      if (!(await this.persist())) return;
    }
    while (!this.stopped && this.now() < deadline) {
      if (await this.cancelledExternally()) return;
      const elapsed = this.now() - Date.parse(this.scan.startedAt ?? this.scan.createdAt);
      if (elapsed > this.scan.limits.maxDurationMs && !this.s.durationExceeded && this.scan.phase !== "analyzing") {
        this.s.durationExceeded = true;
        this.warn(`The total scan time limit (${Math.round(this.scan.limits.maxDurationMs / 1000)} s) was reached; results are partial.`);
      }
      switch (this.scan.phase) {
        case "discovery":
          await this.discover();
          this.scan.phase = "crawling";
          break;
        case "crawling":
          await this.crawl(deadline);
          break;
        case "rendering":
        case "performance": {
          // Slow external calls: at most one per step, and only at the start of
          // a step, so a step never exceeds max(step budget, call timeout).
          if (this.now() - stepStart > 1500) return;
          const yielded = this.scan.phase === "rendering" ? await this.renderNext() : await this.performanceNext();
          if (this.stopped) return;
          if (!(await this.persist())) return;
          if (yielded) return;
          continue;
        }
        case "checking_links":
          await this.checkLinks(deadline);
          break;
        case "analyzing":
          await this.analyze();
          return;
        default:
          return;
      }
      if (this.stopped) return;
      if (!(await this.persist())) return;
    }
  }

  // ---------------------------------------------------------------- discovery
  private async discover() {
    const start = new URL(this.scan.targetUrl);
    const robotsUrl = `${start.origin}/robots.txt`;
    const r = await this.fetchLimited(robotsUrl, { accept: "text/plain,*/*;q=0.5", maxBodyBytes: 512_000 });
    if (r.status !== null && r.status >= 200 && r.status < 300 && r.body) {
      const body = decodeBody(r.body, r.contentType).slice(0, 100_000);
      this.s.robots = { status: "found", url: robotsUrl, httpStatus: r.status, body, crawlDelayMs: null, sitemaps: extractRobotsSitemaps(robotsUrl, body), error: null, disallowAll: false };
    } else if (r.status !== null && r.status >= 400 && r.status < 500) {
      this.s.robots = { status: "not_found", url: robotsUrl, httpStatus: r.status, body: null, crawlDelayMs: null, sitemaps: [], error: null, disallowAll: false };
    } else {
      this.s.robots = { status: "error", url: robotsUrl, httpStatus: r.status, body: null, crawlDelayMs: null, sitemaps: [], error: r.error?.message ?? (r.status ? `HTTP ${r.status}` : "No response"), disallowAll: true };
      this.warn("robots.txt could not be fetched (server error or network failure). Following RFC 9309, only the submitted URL was audited.");
    }
    this.robots = buildRobotsChecker(this.s.robots);
    this.s.robots.crawlDelayMs = this.robots.crawlDelayMs;
    if (this.robots.crawlDelayMs) this.limiter.setInterval(this.robots.crawlDelayMs);

    // Start URL first (depth 0)
    this.seen.add(this.scan.targetUrl);
    this.s.frontier.push({ url: this.scan.targetUrl, depth: 0, via: "start", source: null });

    // Sitemaps
    if (this.s.robots.disallowAll || this.scan.limits.maxSitemapFiles === 0) {
      this.s.sitemap = { status: "not_checked", checked: [], pageUrls: [], offHostUrls: 0 };
      return;
    }
    const declared = new Set<string>();
    const queue: string[] = [];
    for (const sm of this.s.robots.sitemaps) {
      const v = validatePublicUrl(sm, { allowedPorts: this.scan.limits.allowedPorts, assumeHttps: false });
      if (v.ok && !declared.has(v.normalized)) {
        declared.add(v.normalized);
        queue.push(v.normalized);
      }
    }
    const fallback = normalizeUrl(`${start.origin}/sitemap.xml`);
    if (!declared.has(fallback)) queue.push(fallback);
    const info: NonNullable<ScanState["sitemap"]> = { status: "not_found", checked: [], pageUrls: [], offHostUrls: 0 };
    const pageSet = new Set<string>();
    const visited = new Set<string>();
    while (queue.length && info.checked.length < this.scan.limits.maxSitemapFiles) {
      const smUrl = queue.shift()!;
      if (visited.has(smUrl)) continue;
      visited.add(smUrl);
      const res = await this.fetchLimited(smUrl, { accept: "application/xml,text/xml,*/*;q=0.5", maxBodyBytes: Math.min(this.scan.limits.maxBodyBytes * 2, 10_000_000) });
      const entry = { url: smUrl, httpStatus: res.status, type: "error" as "urlset" | "index" | "invalid" | "error", urlCount: 0, error: null as string | null, declaredInRobots: declared.has(smUrl) };
      if (res.status !== null && res.status >= 200 && res.status < 300 && res.body) {
        const xml = decodeBody(maybeGunzip(res.body, 10_000_000), null);
        const parsed = parseSitemap(xml, this.scan.limits.maxSitemapUrls);
        entry.type = parsed.type;
        entry.urlCount = parsed.locs.length;
        if (parsed.type === "index") {
          for (const loc of parsed.locs.slice(0, 10)) {
            const v = validatePublicUrl(loc, { allowedPorts: this.scan.limits.allowedPorts, assumeHttps: false });
            if (v.ok && !visited.has(v.normalized)) queue.push(v.normalized);
          }
        } else if (parsed.type === "urlset") {
          for (const loc of parsed.locs) {
            if (pageSet.size >= this.scan.limits.maxSitemapUrls) break;
            const v = validatePublicUrl(loc, { allowedPorts: this.scan.limits.allowedPorts, assumeHttps: false });
            if (!v.ok) continue;
            if (!this.isAllowedHost(v.url.hostname)) {
              info.offHostUrls++;
              continue;
            }
            pageSet.add(v.normalized);
          }
        }
      } else {
        entry.error = res.error?.message ?? (res.status !== null ? `HTTP ${res.status}` : "No response");
      }
      info.checked.push(entry);
    }
    const anyOk = info.checked.some((c) => c.type === "urlset" || c.type === "index");
    info.status = anyOk ? "found" : declared.size > 0 ? "error" : "not_found";
    info.pageUrls = [...pageSet];
    this.s.sitemap = info;
    for (const u of info.pageUrls) this.enqueue(u, 1, "sitemap", null);
  }

  // ---------------------------------------------------------------- crawling
  private enqueue(url: string, depth: number, via: DiscoverySource, source: string | null): void {
    if (this.seen.has(url)) return;
    if (this.seen.size >= MAX_SEEN) return;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    this.seen.add(url);
    if (!this.isAllowedHost(host)) {
      this.s.skipped.offHost++;
      return;
    }
    // Internal URLs that are skipped still count as discovered, so the progress
    // counters reconcile: discovered = scanned + no response + skipped (+ remaining).
    if (depth > this.scan.limits.maxDepth) {
      this.s.skipped.depth++;
      this.scan.progress.pagesDiscovered++;
      return;
    }
    const d = evaluateCrawlCandidate(url, this.s.queryVariantCounts, this.scan.limits.maxQueryVariantsPerPath);
    if (!d.ok) {
      if (d.reason !== "non_html") {
        this.s.skipped.traps++;
        this.scan.progress.pagesDiscovered++;
      }
      return;
    }
    if (this.s.frontier.length >= this.scan.limits.maxPages * 10) {
      this.s.skipped.limit++;
      this.scan.progress.pagesDiscovered++;
      return;
    }
    if (d.variantKey) this.s.queryVariantCounts[d.variantKey] = (this.s.queryVariantCounts[d.variantKey] ?? 0) + 1;
    // Keep frontier ordered by depth (breadth-first), stable within a depth.
    const item: FrontierItem = { url, depth, via, source };
    let i = this.s.frontier.length;
    while (i > 0 && this.s.frontier[i - 1].depth > depth) i--;
    this.s.frontier.splice(i, 0, item);
    this.scan.progress.pagesDiscovered++;
  }

  private async crawl(deadline: number) {
    const l = this.scan.limits;
    while (!this.stopped && this.now() < deadline && this.s.frontier.length > 0 && this.attempted() < l.maxPages && !this.s.durationExceeded) {
      const batch: FrontierItem[] = [];
      while (batch.length < l.concurrency && this.s.frontier.length && this.attempted() + batch.length < l.maxPages) {
        const item = this.s.frontier.shift()!;
        if (item.via === "start") {
          if (this.s.robots?.status === "found" && !this.robots.isAllowed(item.url)) {
            await this.fail("robots_disallowed", "robots.txt on this site disallows crawling the submitted URL for SiteLensAI (or all crawlers), so it was not audited. Site owners can allow the 'SiteLensAI' user agent.");
            return;
          }
        } else if (!this.robots.isAllowed(item.url)) {
          this.s.skipped.robots++;
          continue;
        }
        batch.push(item);
      }
      if (!batch.length) continue;
      const results = await Promise.all(batch.map((item) => this.fetchPage(item)));
      const pages = results.map((r) => r.page);
      await this.deps.repo.insertPages(pages);
      for (const page of pages) {
        if (page.statusCode === null) {
          this.s.failedFetches = (this.s.failedFetches ?? 0) + 1;
        } else if (this.processed.has(page.finalUrl)) {
          // Redirected to a page this audit already scanned: kept as redirect evidence, not counted (or charged) twice.
          this.s.skipped.duplicates = (this.s.skipped.duplicates ?? 0) + 1;
        } else {
          this.processed.add(page.finalUrl);
          this.scan.progress.pagesCrawled++;
          if (page.statusCode >= 400) this.s.httpErrors = (this.s.httpErrors ?? 0) + 1;
        }
      }
      this.scan.progress.recentUrls = [...pages.map((p) => p.url).reverse(), ...this.scan.progress.recentUrls].slice(0, MAX_RECENT);
      for (const { page, parsed, item } of results) {
        if (!parsed) continue;
        for (const link of parsed.links) if (link.internal) this.enqueue(link.url, item.depth + 1, "link", page.finalUrl);
        if (parsed.canonical && parsed.canonical !== page.finalUrl) this.enqueue(parsed.canonical, item.depth + 1, "canonical", page.finalUrl);
      }
      if (!(await this.persist())) return;
    }
    const doneCrawling = this.s.frontier.length === 0 || this.attempted() >= l.maxPages || this.s.durationExceeded;
    if (doneCrawling) {
      if (this.s.frontier.length > 0) {
        this.s.skipped.limit += this.s.frontier.length;
        if (this.attempted() >= l.maxPages) this.warn(`The page limit (${l.maxPages}) was reached; ${this.s.skipped.limit} more discovered URL(s) were not crawled.`);
        this.s.frontier = [];
      }
      if (this.s.skipped.depth > 0) this.warn(`${this.s.skipped.depth} internal URL(s) beyond the maximum crawl depth (${l.maxDepth}) were not crawled.`);
      const failed = this.s.failedFetches ?? 0;
      if (failed > 0) this.warn(`${failed} page(s) could not be fetched (no response after ${l.maxRetries + 1} attempt(s)); they are listed with the error and were not analysed.`);
      this.s.crawlTruncated = this.s.skipped.limit > 0 || this.s.skipped.depth > 0 || this.s.skipped.robots > 0 || this.s.durationExceeded || !!this.s.robots?.disallowAll;
      this.scan.phase = "rendering";
    }
  }

  private async fetchPage(item: FrontierItem): Promise<{ page: PageRecord; parsed: ParsedHtml | null; item: FrontierItem }> {
    const res = await this.fetchLimited(item.url);
    let finalUrl = res.finalUrl;
    try {
      finalUrl = normalizeUrl(res.finalUrl);
    } catch {
      /* keep raw */
    }
    for (const hop of res.redirectChain) {
      try {
        this.seen.add(normalizeUrl(hop.url));
      } catch {
        /* ignore */
      }
    }
    this.seen.add(finalUrl);
    let finalHost = "";
    try {
      finalHost = new URL(finalUrl).hostname;
    } catch {
      /* ignore */
    }
    let offSite = !!finalHost && !this.isAllowedHost(finalHost);
    if (offSite && item.via === "start" && res.status !== null && res.status < 400 && !res.error) {
      // The submitted URL itself redirects to another host: authorise that host for this scan.
      this.s.allowedHosts.push(finalHost);
      this.warn(`The submitted URL redirects to a different host (${finalHost}); that host was audited instead.`);
      offSite = false;
    }
    const ok2xx = res.status !== null && res.status >= 200 && res.status < 300 && !res.error;
    const isHtml = isHtmlContentType(res.contentType);
    let parsed: ParsedHtml | null = null;
    if (ok2xx && isHtml && !offSite && res.body) {
      try {
        parsed = parseHtml(decodeBody(res.body, res.contentType), finalUrl, (u) => {
          try {
            return this.isAllowedHost(new URL(u).hostname);
          } catch {
            return false;
          }
        });
      } catch (err) {
        logger.warn(`HTML parse failed for a page in scan ${this.scan.id}`, err);
      }
    }
    const page: PageRecord = {
      id: randomUUID(),
      scanId: this.scan.id,
      url: item.url,
      finalUrl,
      statusCode: res.status,
      responseTimeMs: res.durationMs,
      contentType: res.contentType?.slice(0, 120) ?? null,
      isHtml,
      depth: item.depth,
      discoveredVia: item.via,
      sourceUrl: item.source,
      redirectChain: res.redirectChain,
      bodyTruncated: res.bodyTruncated,
      fetchError: res.error,
      offSiteRedirect: offSite,
      title: parsed?.title ?? null,
      titleCount: parsed?.titleCount ?? 0,
      metaDescription: parsed?.metaDescription ?? null,
      metaDescriptionCount: parsed?.metaDescriptionCount ?? 0,
      h1: parsed?.h1 ?? [],
      headings: parsed?.headings ?? [],
      canonicalRaw: parsed?.canonicalRaw ?? null,
      canonical: parsed?.canonical ?? null,
      canonicalCount: parsed?.canonicalCount ?? 0,
      robotsMeta: parsed?.robotsMeta ?? null,
      xRobotsTag: res.headers["x-robots-tag"]?.slice(0, 200) ?? null,
      lang: parsed?.lang ?? null,
      internalLinkCount: parsed?.internalLinkCount ?? 0,
      externalLinkCount: parsed?.externalLinkCount ?? 0,
      links: parsed?.links ?? [],
      invalidLinks: parsed?.invalidLinks ?? [],
      imageCount: parsed?.imageCount ?? 0,
      imagesMissingAlt: parsed?.imagesMissingAlt ?? 0,
      images: parsed?.images ?? [],
      mixedContent: parsed?.mixedContent ?? [],
      jsonLd: parsed?.jsonLd ?? [],
      social: parsed?.social ?? {},
      hreflang: parsed?.hreflang ?? [],
      viewport: parsed?.viewport ?? null,
      wordCount: parsed?.wordCount ?? 0,
      contentHash: parsed?.contentHash ?? null,
      fetchedAt: new Date().toISOString(),
    };
    return { page, parsed, item };
  }

  // --------------------------------------------------------------- rendering
  private async consume(kind: MeteredKind): Promise<boolean> {
    return this.deps.usage ? this.deps.usage.consume(kind) : true;
  }
  private async refund(kind: MeteredKind): Promise<void> {
    await this.deps.usage?.refund(kind).catch(() => {});
  }

  /** Renders one page in the browser worker. Returns true when the step should end. */
  private async renderNext(): Promise<boolean> {
    const requested = this.scan.limits.browserPages ?? 0;
    if (!this.s.render) {
      this.s.render = { queue: [], attempted: 0, succeeded: 0, failed: 0, busyRetries: 0, skippedReason: null, accessibilityPages: 0 };
      if (requested <= 0) {
        this.s.render.skippedReason = "Browser rendering is not enabled for this audit.";
      } else if (!this.deps.browser) {
        this.s.render.skippedReason = "The browser worker is not available, so pages were checked from their HTML only.";
        this.warn("Browser rendering was skipped: the browser worker is not configured or not reachable. Pages were checked from their HTML only.");
      } else {
        const pages = uniqueOkHtmlPages(await this.deps.repo.listPages(this.scan.id)).sort((a, b) => a.depth - b.depth);
        this.s.render.queue = pages.slice(0, requested).map((p) => p.finalUrl);
      }
      this.scan.progress.renderTotal = this.s.render.queue.length;
      this.scan.progress.pagesRendered = 0;
      return false;
    }
    const r = this.s.render;
    const skipRest = (reason: string, warning: string) => {
      if (r.queue.length) this.warn(warning.replace("{n}", String(r.queue.length)));
      r.skippedReason = r.skippedReason ?? reason;
      r.queue = [];
    };
    if (this.s.durationExceeded && r.queue.length) skipRest("The audit time limit was reached.", "The audit time limit was reached; {n} page(s) were not rendered in the browser.");
    if (!r.queue.length || !this.deps.browser) {
      this.scan.phase = "checking_links";
      return false;
    }
    const url = r.queue[0];
    if (!(await this.consume("browser_page"))) {
      skipRest("Your browser-rendering allowance for this period is used up.", "Your browser-rendering allowance is used up; {n} page(s) were not rendered.");
      return false;
    }
    let axe = !!this.scan.limits.accessibility;
    if (axe && !(await this.consume("accessibility_test"))) {
      axe = false;
      this.warn("Your accessibility-test allowance is used up; some rendered pages were not tested with axe-core.");
    }
    const outcome = await this.deps.browser.render({
      url,
      viewport: "mobile",
      navigationTimeoutMs: this.scan.limits.browserNavTimeoutMs ?? 20_000,
      accessibility: axe,
      allowedPorts: this.scan.limits.allowedPorts,
      siteHosts: this.s.allowedHosts.slice(0, 10),
      userAgent: this.deps.userAgent,
    });
    if (!outcome.ok) {
      // The worker failed, not the website: give the allowance back.
      await this.refund("browser_page");
      if (axe) await this.refund("accessibility_test");
      if (outcome.code === "worker_busy" && r.busyRetries < 3) {
        r.busyRetries++;
        return true; // retry this page on the next step
      }
      skipRest(`Browser rendering stopped: ${outcome.message}`, `Browser rendering stopped (${outcome.message}); {n} page(s) were not rendered.`);
      return true;
    }
    const result = outcome.result;
    await this.deps.repo.saveArtifact({ id: randomUUID(), scanId: this.scan.id, kind: "render", key: url, data: result, createdAt: new Date().toISOString() } satisfies ScanArtifact<RenderResult>);
    r.queue.shift();
    r.attempted++;
    if (result.ok) r.succeeded++;
    else r.failed++;
    if (result.axe) r.accessibilityPages++;
    else if (axe) await this.refund("accessibility_test");
    this.scan.progress.pagesRendered = r.attempted;
    this.scan.progress.recentUrls = [url, ...this.scan.progress.recentUrls].slice(0, MAX_RECENT);
    if (!r.queue.length) this.scan.phase = "checking_links";
    return true;
  }

  // ------------------------------------------------------------- performance
  /** Runs one PageSpeed Insights strategy. Returns true when the step should end. */
  private async performanceNext(): Promise<boolean> {
    const strategies = this.scan.limits.performanceStrategies ?? [];
    if (!this.s.performance) {
      const pages = await this.deps.repo.listPages(this.scan.id);
      const start = uniqueOkHtmlPages(pages).sort((a, b) => a.depth - b.depth)[0];
      this.s.performance = { url: start?.finalUrl ?? this.scan.targetUrl, queue: [], attempted: 0, succeeded: 0, skippedReason: null };
      if (!strategies.length) this.s.performance.skippedReason = "Performance testing is not enabled for this audit.";
      else if (!this.deps.performance) {
        this.s.performance.skippedReason = "PageSpeed Insights is not configured.";
        this.warn("Performance was not evaluated: PageSpeed Insights is not configured.");
      } else this.s.performance.queue = [...strategies];
      this.scan.progress.performanceTotal = this.s.performance.queue.length;
      this.scan.progress.performanceDone = 0;
      return false;
    }
    const st = this.s.performance;
    if (this.s.durationExceeded && st.queue.length) {
      this.warn("The audit time limit was reached; performance was not fully tested.");
      st.skippedReason = st.skippedReason ?? "The audit time limit was reached.";
      st.queue = [];
    }
    if (!st.queue.length || !this.deps.performance) {
      this.scan.phase = "analyzing";
      return false;
    }
    const strategy = st.queue[0];
    if (!(await this.consume("performance_test"))) {
      this.warn("Your performance-test allowance is used up; performance was not fully tested.");
      st.skippedReason = "Your performance-test allowance for this period is used up.";
      st.queue = [];
      return false;
    }
    const run = await this.deps.performance.run(st.url, strategy);
    const providerFault = !run.ok && run.error && run.error.code !== "lighthouse_failed";
    if (providerFault) await this.refund("performance_test");
    await this.deps.repo.saveArtifact({ id: randomUUID(), scanId: this.scan.id, kind: "performance", key: strategy, data: run, createdAt: new Date().toISOString() } satisfies ScanArtifact<PerformanceRun>);
    st.queue.shift();
    st.attempted++;
    if (run.ok) st.succeeded++;
    else if (run.error && ["auth_failed", "quota_exhausted", "not_configured"].includes(run.error.code) && st.queue.length) {
      this.warn(`Performance testing stopped: ${run.error.message}`);
      st.skippedReason = run.error.message;
      st.queue = [];
    }
    this.scan.progress.performanceDone = st.attempted;
    if (!st.queue.length) this.scan.phase = "analyzing";
    return true;
  }

  // ------------------------------------------------------------ link checking
  private async buildLinkTargets() {
    const pages = await this.deps.repo.listPages(this.scan.id);
    const targets = new Map<string, LinkTarget>();
    const add = (url: string, kind: LinkTarget["kind"], internal: boolean, source: string) => {
      const key = `${kind}|${url}`;
      const t = targets.get(key) ?? { url, kind, internal, sources: [], occurrences: 0 };
      t.occurrences++;
      if (t.sources.length < 20 && !t.sources.includes(source)) t.sources.push(source);
      targets.set(key, t);
    };
    for (const p of pages) {
      if (!isOkHtmlPage(p)) continue;
      for (const l of p.links) add(l.url, "page_link", l.internal, p.finalUrl);
      for (const img of p.images) {
        if (!img.src) continue;
        let internal = false;
        try {
          internal = this.isAllowedHost(new URL(img.src).hostname);
        } catch {
          /* ignore */
        }
        add(img.src, "image", internal, p.finalUrl);
      }
    }
    // Links that only exist after JavaScript runs (from the browser worker).
    const staticLinks = new Map<string, Set<string>>();
    for (const p of pages) if (isOkHtmlPage(p)) staticLinks.set(p.finalUrl, new Set(p.links.map((l) => l.url)));
    const renders = (await this.deps.repo.listArtifacts(this.scan.id, "render")) as ScanArtifact<RenderResult>[];
    for (const a of renders) {
      const r = a.data;
      if (!r.ok) continue;
      const known = staticLinks.get(a.key) ?? new Set<string>();
      for (const l of r.links) {
        if (known.has(l.url)) continue;
        const key = `page_link|${l.url}`;
        const existed = targets.has(key);
        add(l.url, "page_link", l.internal, a.key);
        const t = targets.get(key)!;
        if (!existed) t.discoveredBy = "browser";
      }
    }
    const crawled = new Map<string, PageRecord>();
    for (const p of pages) crawled.set(p.url, p);

    const immediate: LinkCheckRecord[] = [];
    const toCheck: LinkTarget[] = [];
    const now = new Date().toISOString();
    const base = (t: LinkTarget) => ({ id: randomUUID(), scanId: this.scan.id, url: t.url, kind: t.kind, internal: t.internal, sources: t.sources, occurrences: t.occurrences, checkedAt: now, discoveredBy: t.discoveredBy ?? ("html" as const) });

    const all = [...targets.values()];
    const priority = (t: LinkTarget) => (t.internal ? 0 : 2) + (t.kind === "image" ? 1 : 0);
    all.sort((a, b) => priority(a) - priority(b) || b.occurrences - a.occurrences);
    for (const t of all) {
      const page = t.kind === "page_link" ? crawled.get(t.url) : undefined;
      if (page) {
        const c = classifyFetchResult({ status: page.statusCode, error: page.fetchError, redirectChain: page.redirectChain });
        immediate.push({ ...base(t), statusCode: page.statusCode, finalUrl: page.finalUrl, redirectChain: page.redirectChain, category: c.category, verification: c.verification, method: "crawl", message: c.message, responseTimeMs: page.responseTimeMs });
      } else if (t.internal && t.kind === "page_link" && !this.robots.isAllowed(t.url)) {
        immediate.push({ ...base(t), statusCode: null, finalUrl: null, redirectChain: [], category: "skipped_robots", verification: "not_checked", method: "none", message: "Not requested: disallowed by robots.txt.", responseTimeMs: null });
      } else if (toCheck.length < this.scan.limits.maxLinksToCheck) {
        toCheck.push(t);
      } else {
        immediate.push({ ...base(t), statusCode: null, finalUrl: null, redirectChain: [], category: "not_checked", verification: "not_checked", method: "none", message: "Not checked: the per-scan link-check limit was reached.", responseTimeMs: null });
      }
    }
    const overLimit = immediate.filter((r) => r.category === "not_checked").length;
    if (overLimit > 0) this.warn(`The link-check limit (${this.scan.limits.maxLinksToCheck}) was reached; ${overLimit} link destination(s) were not checked.`);
    await this.deps.repo.insertLinkChecks(immediate);
    this.s.linkTargets = toCheck;
    this.s.linkCursor = 0;
    this.s.linkTargetsBuilt = true;
    this.scan.progress.linksTotal = all.length;
    this.scan.progress.linksChecked = immediate.length;
  }

  private async checkLink(t: LinkTarget): Promise<LinkCheckRecord> {
    const timeoutMs = Math.min(this.scan.limits.requestTimeoutMs, 8000);
    let r = await this.fetchLimited(t.url, { method: "HEAD", skipBody: true, timeoutMs, accept: "*/*" });
    let method: LinkCheckRecord["method"] = "HEAD";
    const headUnreliable = (r.status !== null && !r.error && HEAD_FALLBACK_STATUSES.has(r.status)) || (r.error && (r.error.code === "connection_error" || r.error.code === "protocol_error"));
    if (headUnreliable) {
      // Many servers mishandle HEAD; confirm with a GET that stops after headers.
      r = await this.fetchLimited(t.url, { method: "GET", skipBody: true, timeoutMs, retries: 0 });
      method = "HEAD+GET";
    }
    const c = classifyFetchResult(r);
    return {
      id: randomUUID(),
      scanId: this.scan.id,
      url: t.url,
      kind: t.kind,
      internal: t.internal,
      sources: t.sources,
      occurrences: t.occurrences,
      statusCode: r.status,
      finalUrl: r.finalUrl,
      redirectChain: r.redirectChain,
      category: c.category,
      verification: c.verification,
      method,
      message: c.message,
      responseTimeMs: r.durationMs,
      checkedAt: new Date().toISOString(),
      discoveredBy: t.discoveredBy ?? "html",
    };
  }

  private async checkLinks(deadline: number) {
    if (!this.s.linkTargetsBuilt) {
      await this.buildLinkTargets();
      if (!(await this.persist())) return;
    }
    const l = this.scan.limits;
    while (!this.stopped && this.now() < deadline && this.s.linkCursor < this.s.linkTargets.length && !this.s.durationExceeded) {
      const batch = this.s.linkTargets.slice(this.s.linkCursor, this.s.linkCursor + l.concurrency);
      const records = await Promise.all(batch.map((t) => this.checkLink(t)));
      await this.deps.repo.insertLinkChecks(records);
      this.s.linkCursor += batch.length;
      this.scan.progress.linksChecked += records.length;
      this.scan.progress.recentUrls = [...records.map((r) => r.url).reverse(), ...this.scan.progress.recentUrls].slice(0, MAX_RECENT);
      if (!(await this.persist())) return;
    }
    if (this.s.durationExceeded && this.s.linkCursor < this.s.linkTargets.length) {
      const rest = this.s.linkTargets.slice(this.s.linkCursor);
      const now = new Date().toISOString();
      await this.deps.repo.insertLinkChecks(
        rest.map((t) => ({ id: randomUUID(), scanId: this.scan.id, url: t.url, kind: t.kind, internal: t.internal, sources: t.sources, occurrences: t.occurrences, statusCode: null, finalUrl: null, redirectChain: [], category: "not_checked" as const, verification: "not_checked" as const, method: "none" as const, message: "Not checked: the total scan time limit was reached.", responseTimeMs: null, checkedAt: now })),
      );
      this.scan.progress.linksChecked += rest.length;
      this.s.linkCursor = this.s.linkTargets.length;
    }
    if (this.s.linkCursor >= this.s.linkTargets.length) {
      this.s.linkTargets = [];
      this.scan.phase = "performance";
    }
  }

  // ---------------------------------------------------------------- analysis
  private async analyze() {
    const [pages, links, renderArtifacts, perfArtifacts] = await Promise.all([
      this.deps.repo.listPages(this.scan.id),
      this.deps.repo.listLinkChecks(this.scan.id),
      this.deps.repo.listArtifacts(this.scan.id, "render") as Promise<ScanArtifact<RenderResult>[]>,
      this.deps.repo.listArtifacts(this.scan.id, "performance") as Promise<ScanArtifact<PerformanceRun>[]>,
    ]);
    const renders = renderArtifacts.map((a) => ({ url: a.key, result: a.data }));
    const runs = perfArtifacts.map((a) => a.data);
    const okHtml = uniqueOkHtmlPages(pages);
    if (okHtml.length === 0) {
      const start = pages.find((p) => p.discoveredVia === "start");
      let message = "No HTML page could be loaded, so no audit could be produced.";
      let code = "no_pages";
      if (start?.fetchError) {
        code = start.fetchError.code;
        message = `The submitted URL could not be loaded: ${start.fetchError.message}`;
      } else if (start?.statusCode && (start.statusCode === 401 || start.statusCode === 403 || start.statusCode === 429 || start.statusCode === 999)) {
        code = "blocked";
        message = `The website refused the request (HTTP ${start.statusCode}). It may block automated tools or require login; SiteInsights does not bypass access controls.`;
      } else if (start?.statusCode && start.statusCode >= 400) {
        code = "http_error";
        message = `The submitted URL returned HTTP ${start.statusCode}.`;
      } else if (start?.offSiteRedirect) {
        code = "off_site";
        message = "The submitted URL redirected to a different site.";
      } else if (start && !start.isHtml) {
        code = "not_html";
        message = `The submitted URL did not return an HTML page (content type: ${start.contentType ?? "unknown"}).`;
      }
      await this.fail(code, message);
      return;
    }
    const findings: Finding[] = analyzeScan({
      scanId: this.scan.id,
      startUrl: this.scan.targetUrl,
      siteHost: this.scan.hostname,
      pages,
      links,
      robots: this.s.robots,
      sitemap: this.s.sitemap,
      crawlTruncated: this.s.crawlTruncated,
      aiAvailable: this.deps.aiAvailable,
      renders,
      performance: runs,
    });
    await this.deps.repo.insertFindings(findings);
    const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const byCat: Record<string, number> = {};
    for (const c of CATEGORIES) byCat[c] = 0;
    for (const f of findings) {
      bySev[f.severity]++;
      byCat[f.category]++;
    }
    const checkedLinks = links.filter((l) => l.verification !== "not_checked");
    const renderedOk = renders.filter((r) => r.result.ok).length;
    const perf = performanceScore(runs);
    const scores = computeScores(
      findings,
      okHtml.length,
      { links: checkedLinks.length > 0, seo: true, indexability: true, accessibility: true, security: true, browser: renderedOk > 0, performance: perf.score !== null },
      { renderedPages: renderedOk, performance: perf.score },
    );
    const axeVersion = renders.find((r) => r.result.axe)?.result.axe?.version ?? null;
    const rs = this.s.render;
    const ps = this.s.performance;
    const started = Date.parse(this.scan.startedAt ?? this.scan.createdAt);
    this.scan.summary = {
      // Unique pages that returned a response (matches progress and the credits charged).
      pagesScanned: new Set(pages.filter((p) => p.statusCode !== null).map((p) => p.finalUrl)).size,
      htmlPages: okHtml.length,
      linksChecked: checkedLinks.length,
      brokenLinks: links.filter((l) => BROKEN_CATEGORIES.includes(l.category) && l.sources.length > 0).length,
      inconclusiveLinks: links.filter((l) => INCONCLUSIVE_CATEGORIES.includes(l.category)).length,
      findingsBySeverity: bySev,
      findingsByCategory: byCat,
      totalFindings: findings.length,
      scores,
      scoreFormulaVersion: SCORE_FORMULA_VERSION,
      robotsStatus: this.s.robots?.status ?? "not_checked",
      sitemapStatus: this.s.sitemap?.status ?? "not_checked",
      crawlTruncated: this.s.crawlTruncated,
      durationMs: Date.now() - started,
      coverage: {
        browser: { requested: this.scan.limits.browserPages ?? 0, attempted: rs?.attempted ?? 0, succeeded: rs?.succeeded ?? 0, failed: rs?.failed ?? 0, skippedReason: rs?.skippedReason ?? null },
        accessibility: {
          pages: rs?.accessibilityPages ?? 0,
          engine: axeVersion ? `axe-core ${axeVersion}` : null,
          skippedReason: rs?.accessibilityPages ? null : !this.scan.limits.accessibility ? "Accessibility testing in the browser is not enabled for this audit." : (rs?.skippedReason ?? "No page was tested with axe-core."),
        },
        performance: { url: ps?.url ?? null, runs: runs.map((r) => ({ strategy: r.strategy, ok: r.ok, error: r.error?.message ?? null })), skippedReason: ps?.skippedReason ?? null },
      },
    };
    this.scan.progress.findings = findings.length;
    const target = this.scan.warnings.length > 0 ? "completed_with_warnings" : "completed";
    assertTransition(this.scan.status, target);
    this.scan.status = target;
    this.scan.phase = "finished";
    this.scan.finishedAt = new Date().toISOString();
    await this.persist();
    this.stopped = true;
  }
}
