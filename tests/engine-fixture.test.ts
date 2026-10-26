import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config/env";
import { MemoryRepository } from "@/lib/db/memory";
import { advanceScan, createScanJob } from "@/lib/scanner/engine";
import type { ScanJob, ScanLimits } from "@/lib/scanner/types";
import { fixtureLookup, fixturePolicy, startFixtureServer, type FixtureServer } from "./helpers/fixture-server";

let srv: FixtureServer;
let repo: MemoryRepository;
let scan: ScanJob;
let steps = 0;

function limits(port: number, overrides: Partial<ScanLimits> = {}): ScanLimits {
  const s = loadConfig({}).scanner;
  return {
    maxPages: s.maxPages, maxDepth: s.maxDepth, maxRedirects: s.maxRedirects, concurrency: 3, requestTimeoutMs: 1500, maxBodyBytes: s.maxBodyBytes,
    maxDurationMs: 60_000, maxRetries: 0, hostMinIntervalMs: 0, maxLinksToCheck: 100, stepBudgetMs: 5000, allowedPorts: [port, 80],
    maxQueryVariantsPerPath: 3, maxSitemapFiles: 4, maxSitemapUrls: 100, ...overrides,
  };
}


async function runToEnd(r: MemoryRepository, id: string) {
  let s: ScanJob | null = null;
  for (let i = 0; i < 60; i++) {
    const res = await advanceScan(id, { repo: r, userAgent: "SiteLensAI-test/1.0", aiAvailable: false, fetchOverrides: { lookup: fixtureLookup(), addressPolicy: fixturePolicy } });
    s = res.scan;
    steps++;
    if (s && ["completed", "completed_with_warnings", "failed", "cancelled"].includes(s.status)) break;
  }
  return s!;
}

beforeAll(async () => {
  srv = await startFixtureServer();
  repo = new MemoryRepository();
  const job = createScanJob({ principalId: "p1", websiteId: null, targetUrl: `${srv.origin}/`, limits: limits(srv.port, { stepBudgetMs: 1 }) });
  await repo.createScan(job);
  scan = await runToEnd(repo, job.id);
}, 60_000);
afterAll(() => srv.close());

describe("scanner end-to-end (fixture site)", () => {
  it("completes in multiple bounded steps", () => {
    expect(["completed", "completed_with_warnings"]).toContain(scan.status);
    expect(steps).toBeGreaterThan(1);
    expect(scan.summary).not.toBeNull();
  });

  it("crawls same-site pages, including sitemap-only pages, and respects robots.txt", async () => {
    const pages = await repo.listPages(scan.id);
    const paths = pages.map((p) => new URL(p.url).pathname).sort();
    expect(paths).toEqual(expect.arrayContaining(["/", "/about", "/blog", "/orphan"]));
    expect(paths).not.toContain("/private/secret");
    expect(srv.requests.some((r) => r.path.startsWith("/private/"))).toBe(false);
    // Sends our user agent and fetches robots.txt first.
    expect(srv.requests[0].path).toBe("/robots.txt");
    expect(srv.requests.every((r) => r.ua === "SiteLensAI-test/1.0")).toBe(true);
  });

  it("deduplicates URLs (tracking parameters) and skips trap URLs", async () => {
    const pages = await repo.listPages(scan.id);
    // /about is fetched once; /old-page is recorded separately as a redirect to it.
    expect(pages.filter((p) => p.url.endsWith("/about")).length).toBe(1);
    const old = pages.find((p) => p.url.endsWith("/old-page"))!;
    expect(old.finalUrl.endsWith("/about")).toBe(true);
    expect(old.redirectChain).toHaveLength(1);
    // ...and is not double counted as an HTML page in the analysis.
    expect(scan.summary!.htmlPages).toBe(4);
    expect(pages.some((p) => p.url.includes("utm_source"))).toBe(false);
    expect(pages.some((p) => p.url.includes("/search?"))).toBe(false); // q/sort parameters are crawl traps
    expect(scan.state.skipped.robots).toBeGreaterThanOrEqual(1);
  });

  it("collects per-page evidence with timestamps", async () => {
    const pages = await repo.listPages(scan.id);
    const home = pages.find((p) => new URL(p.url).pathname === "/")!;
    expect(home.statusCode).toBe(200);
    expect(home.title).toBe("Fixture Bakery — Fresh bread and cakes daily");
    expect(home.imagesMissingAlt).toBe(1);
    expect(Date.parse(home.fetchedAt)).not.toBeNaN();
  });

  it("classifies links: 404/410 broken, 403 blocked (not broken), HEAD→GET fallback, loops, DNS, unsafe redirects", async () => {
    const links = await repo.listLinkChecks(scan.id);
    const byPath = (p: string) => links.find((l) => l.url.endsWith(p));
    expect(byPath("/missing-page")?.category).toBe("not_found");
    expect(byPath("/gone")?.category).toBe("not_found");
    expect(byPath("/forbidden")?.category).toBe("blocked");
    expect(byPath("/forbidden")?.verification).toBe("inconclusive");
    expect(byPath("/no-head")?.category).toBe("ok");
    expect(byPath("/no-head")?.method).toBe("HEAD+GET");
    expect(byPath("/loop-a")?.category).toBe("redirect_loop");
    expect(byPath("/old-page")?.category).toBe("redirect");
    expect(byPath("/to-metadata")?.category).toBe("unsafe_destination");
    expect(links.find((l) => l.url.includes("nxdomain"))?.category).toBe("dns_error");
    expect(byPath("/private/secret")?.category).toBe("skipped_robots");
    expect(srv.requests.some((r) => r.path.includes("meta-data"))).toBe(false);
  });

  it("produces the expected findings with evidence", async () => {
    const f = await repo.listFindings(scan.id);
    const ids = new Set(f.map((x) => x.ruleId));
    for (const id of ["links.broken", "links.dns_error", "links.redirect_problem", "links.unverified", "links.internal_redirects", "seo.title_missing", "seo.h1_missing", "seo.h1_multiple", "seo.heading_skip", "seo.meta_description_missing", "seo.meta_description_duplicate", "indexability.canonical_invalid", "indexability.noindex", "accessibility.img_alt_missing", "accessibility.lang_missing", "security.no_https"]) {
      expect(ids, `expected finding ${id}`).toContain(id);
    }
    // The 403 partner link is never reported as broken.
    expect(f.filter((x) => x.ruleId === "links.broken").some((x) => x.evidence.summary.includes("/forbidden"))).toBe(false);
    // A robots-disallowed page could link to /orphan, so the crawl counts as partial and
    // orphan candidates are conservatively not reported.
    expect(scan.state.crawlTruncated).toBe(true);
    expect(ids).not.toContain("indexability.orphan_candidate");
    expect(f.length).toBeGreaterThan(10);
  });

  it("computes scores with the documented formula and counts in the summary", () => {
    const s = scan.summary!;
    expect(s.pagesScanned).toBeGreaterThanOrEqual(4);
    expect(s.brokenLinks).toBeGreaterThanOrEqual(3);
    for (const v of Object.values(s.scores)) if (v !== null) expect(v).toBeGreaterThanOrEqual(0);
    expect(s.scores.links).toBeLessThan(100);
  });
});

describe("scanner edge cases", () => {
  it("fails with robots_disallowed when the start URL is disallowed", async () => {
    const r = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `${srv.origin}/private/secret`, limits: limits(srv.port) });
    await r.createScan(job);
    const s = await runToEnd(r, job.id);
    expect(s.status).toBe("failed");
    expect(s.error?.code).toBe("robots_disallowed");
  });

  it("fails cleanly when the start host does not resolve", async () => {
    const r = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `http://nxdomain.sitelens-fixture.com:${srv.port}/`, limits: limits(srv.port) });
    await r.createScan(job);
    const s = await runToEnd(r, job.id);
    expect(s.status).toBe("failed");
  });

  it("respects the page limit and depth limit", async () => {
    const r = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `${srv.origin}/`, limits: limits(srv.port, { maxPages: 2, maxLinksToCheck: 5 }) });
    await r.createScan(job);
    const s = await runToEnd(r, job.id);
    expect(["completed", "completed_with_warnings"]).toContain(s.status);
    expect((await r.listPages(job.id)).length).toBeLessThanOrEqual(2);
    const checked = (await r.listLinkChecks(job.id)).filter((l) => l.verification !== "not_checked" && l.method !== "crawl" && l.method !== "none");
    expect(checked.length).toBeLessThanOrEqual(5);
  });

  it("supports cancellation between steps", async () => {
    const r = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `${srv.origin}/`, limits: limits(srv.port, { stepBudgetMs: 1 }) });
    await r.createScan(job);
    await advanceScan(job.id, { repo: r, userAgent: "t", aiAvailable: false, fetchOverrides: { lookup: fixtureLookup(), addressPolicy: fixturePolicy } });
    expect(await r.transitionScan(job.id, ["queued", "running"], "cancelled", { finishedAt: new Date().toISOString() })).toBe(true);
    const after = await advanceScan(job.id, { repo: r, userAgent: "t", aiAvailable: false, fetchOverrides: { lookup: fixtureLookup(), addressPolicy: fixturePolicy } });
    expect(after.scan?.status).toBe("cancelled");
  });

  it("without test overrides, the engine refuses to scan a host that resolves to loopback", async () => {
    const r = new MemoryRepository();
    const job = createScanJob({ principalId: "p", websiteId: null, targetUrl: `${srv.origin}/`, limits: limits(srv.port) });
    await r.createScan(job);
    const before = srv.requests.length;
    let s: ScanJob | null = null;
    for (let i = 0; i < 20; i++) {
      s = (await advanceScan(job.id, { repo: r, userAgent: "t", aiAvailable: false, fetchOverrides: { lookup: fixtureLookup() } })).scan;
      if (s && ["completed", "completed_with_warnings", "failed"].includes(s.status)) break;
    }
    expect(s!.status).toBe("failed");
    expect(srv.requests.length).toBe(before);
  });
});
