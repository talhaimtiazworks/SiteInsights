/**
 * Crawler scale and correctness against a generated 700-page site:
 * plan page limits (25 / 150 / 500) are honoured exactly, counts are accurate
 * and deduplicated, robots.txt / traps / external hosts are respected, and a
 * transient 503 is retried.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { MemoryRepository } from "@/lib/db/memory";
import { advanceScan, createScanJob } from "@/lib/scanner/engine";
import type { ScanJob, ScanLimits } from "@/lib/scanner/types";
import { getEntitlements } from "@/lib/usage/entitlements";
import { uniqueProcessedPages } from "@/lib/credits/service";
import { BIG_EXT_HOST, BIG_HOST, bigSiteLookup, bigSitePolicy, startBigSite, type BigSite } from "./helpers/big-site";

let site: BigSite;
const cfg = loadConfig({});

function limitsFor(plan: "free" | "pro" | "business", over: Partial<ScanLimits> = {}): ScanLimits {
  const ent = getEntitlements({ id: "user:x", plan, isUser: true }, cfg);
  const s = cfg.scanner;
  return {
    maxPages: ent.maxPagesPerScan,
    requestedPages: ent.maxPagesPerScan,
    maxDepth: ent.maxDepth,
    maxRedirects: s.maxRedirects,
    concurrency: 6,
    requestTimeoutMs: 3000,
    maxBodyBytes: s.maxBodyBytes,
    maxDurationMs: ent.maxDurationMs,
    maxRetries: 1,
    hostMinIntervalMs: 0,
    maxLinksToCheck: 30,
    stepBudgetMs: 4000,
    allowedPorts: [site.port, 80, 443],
    maxQueryVariantsPerPath: 3,
    maxSitemapFiles: 2,
    maxSitemapUrls: 2000,
    ...over,
  };
}

async function runToEnd(repo: MemoryRepository, id: string): Promise<ScanJob> {
  let s: ScanJob | null = null;
  for (let i = 0; i < 400; i++) {
    s = (await advanceScan(id, { repo, userAgent: "SiteLensAI-test/1.0", aiAvailable: false, fetchOverrides: { lookup: bigSiteLookup(), addressPolicy: bigSitePolicy } })).scan;
    if (s && ["completed", "completed_with_warnings", "failed", "cancelled"].includes(s.status)) return s;
  }
  throw new Error("scan did not finish");
}

async function audit(plan: "free" | "pro" | "business", over: Partial<ScanLimits> = {}) {
  const repo = new MemoryRepository();
  const job = createScanJob({ principalId: "user:00000000-0000-4000-8000-000000000001", websiteId: null, targetUrl: `${site.origin}/`, limits: limitsFor(plan, over) });
  await repo.createScan(job);
  const before = site.requests.length;
  const scan = await runToEnd(repo, job.id);
  const pages = await repo.listPages(job.id);
  return { scan, pages, requests: site.requests.slice(before), repo };
}

beforeAll(async () => {
  site = await startBigSite(700);
});
afterAll(async () => {
  await site.close();
});

describe("plan page limits are enforced exactly by the crawler", () => {
  it("Free (everyone): stops at 500 unique pages and says why", async () => {
    const { scan, pages } = await audit("free");
    expect(scan.status).toBe("completed_with_warnings");
    expect(scan.progress.pagesCrawled).toBe(500);
    expect(uniqueProcessedPages(pages)).toBe(500);
    expect(scan.summary!.pagesScanned).toBe(500);
    expect(scan.progress.pagesLimit).toBe(500);
    expect(scan.progress.pagesRemaining).toBe(0);
    expect(scan.progress.pagesSkipped!).toBeGreaterThan(0);
    expect(scan.warnings.join(" ")).toMatch(/page limit \(500\) was reached/);
  }, 240_000);

  it("Pro (historical catalog entry): crawls more than 100 pages, up to 150", async () => {
    const { scan, pages } = await audit("pro");
    expect(scan.progress.pagesCrawled).toBe(150);
    expect(uniqueProcessedPages(pages)).toBe(150);
    expect(scan.summary!.pagesScanned).toBe(150);
  }, 120_000);

  it("Business: crawls more than 100 pages, up to 500", async () => {
    const { scan, pages } = await audit("business");
    expect(scan.progress.pagesCrawled).toBe(500);
    expect(uniqueProcessedPages(pages)).toBe(500);
    expect(scan.summary!.pagesScanned).toBe(500);
    // Never more page fetches than the limit (+ robots.txt, sitemap and link checks, which are not pages).
    expect(pages.length).toBeLessThanOrEqual(500 + (scan.progress.pagesSkipped ?? 0));
  }, 240_000);

  it("a user-chosen smaller limit is honoured", async () => {
    const { scan } = await audit("business", { maxPages: 40, requestedPages: 40 });
    expect(scan.progress.pagesCrawled).toBe(40);
  }, 60_000);
});

describe("crawl correctness", () => {
  let result: Awaited<ReturnType<typeof audit>>;
  beforeAll(async () => {
    result = await audit("pro", { maxPages: 60, requestedPages: 60 });
  }, 120_000);

  it("deduplicates redirects and tracking-parameter variants", () => {
    const { pages, scan } = result;
    const p1 = pages.filter((p) => p.finalUrl === `${site.origin}/p/1`);
    // /p/1 may be fetched directly and reached via /old; it is counted once.
    expect(new Set(pages.filter((p) => p.statusCode !== null).map((p) => p.finalUrl)).size).toBe(scan.progress.pagesCrawled);
    expect(p1.length).toBeGreaterThanOrEqual(1);
    expect(pages.some((p) => p.url.includes("utm_source"))).toBe(false); // tracking parameters are normalised away
  });

  it("respects robots.txt, avoids calendar traps and never crawls external hosts", () => {
    const { requests, scan } = result;
    expect(requests.some((r) => r.path.startsWith("/private/"))).toBe(false);
    expect(scan.state.skipped.robots).toBeGreaterThanOrEqual(1);
    expect(requests.filter((r) => r.path.startsWith("/calendar")).length).toBeLessThanOrEqual(1);
    // The external site is only link-checked (HEAD/GET of one URL), never crawled as part of the site.
    expect(result.pages.every((p) => new URL(p.url).hostname === BIG_HOST)).toBe(true);
    expect(requests.filter((r) => r.host === BIG_EXT_HOST).length).toBeLessThanOrEqual(2);
  });

  it("retries a transient 503 and records the recovered page", () => {
    const flaky = result.pages.find((p) => p.url.endsWith("/flaky"));
    expect(flaky?.statusCode).toBe(200);
  });

  it("reports consistent, honest progress counts", () => {
    const p = result.scan.progress;
    expect(p.pagesCrawled + (p.pagesFailed ?? 0)).toBeLessThanOrEqual(60);
    expect(p.pagesDiscovered).toBeGreaterThanOrEqual(p.pagesCrawled);
    expect(p.pagesRemaining).toBe(0);
    expect(p.pagesFailed).toBe(0);
    // Every discovered internal URL is accounted for exactly once once crawling ends.
    expect(p.pagesSkipped, JSON.stringify(p)).toBeLessThanOrEqual(p.pagesDiscovered - p.pagesCrawled);
    expect(p.pagesCrawled + (p.pagesFailed ?? 0) + (p.pagesSkipped ?? 0), JSON.stringify(p)).toBe(p.pagesDiscovered);
  });
});
