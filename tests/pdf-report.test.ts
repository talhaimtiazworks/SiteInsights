import { randomUUID } from "node:crypto";
import { startAuthFixture } from "./helpers/auth-fixture";
import { extractPdfText } from "./helpers/pdf-text";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);
vi.mock("@/lib/services/plan", async (orig) => (await import("./helpers/plan-override")).planModuleMock(await orig()));
// Lets one test simulate a PDF build failure; all other tests use the real builder.
const failBuild = { on: false };
vi.mock("@/lib/report/pdf", async (orig) => {
  const m = await orig<typeof import("@/lib/report/pdf")>();
  return { ...m, buildReportPdf: async (...a: Parameters<typeof m.buildReportPdf>) => (failBuild.on ? new Uint8Array(0) : m.buildReportPdf(...a)) };
});

import { PDFDocument } from "pdf-lib";
import * as pdfRoute from "@/app/api/scans/[id]/report.pdf/route";
import * as usageRoute from "@/app/api/usage/route";
import { analyzeScan } from "@/lib/audit/analyze";
import type { Finding } from "@/lib/audit/types";
import { __resetConfigForTests, loadConfig } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository } from "@/lib/db";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import { parsePageSpeed } from "@/lib/performance/pagespeed";
import { buildReportPdf, pdfText, type PdfReportInput } from "@/lib/report/pdf";
import { createScanJob } from "@/lib/scanner/engine";
import type { ScanSummary } from "@/lib/scanner/types";
import { hashScanKey, newScanKey } from "@/lib/services/scans";
import { analysisInput, makePage } from "./helpers/factories";
import { TestBrowser } from "./helpers/route-harness";
import { planOverrides } from "./helpers/plan-override";

/** Inflates every content stream and returns the text drawn with Tj operators. */
const extractText = extractPdfText;

const PSI = {
  lighthouseResult: {
    lighthouseVersion: "12.8.2",
    fetchTime: "2026-10-16T05:00:00.000Z",
    finalDisplayedUrl: "https://shop.example.com/",
    categories: { performance: { score: 0.61 } },
    audits: { "largest-contentful-paint": { numericValue: 3100 }, "total-blocking-time": { numericValue: 420 }, "cumulative-layout-shift": { numericValue: 0.05 } },
  },
};

function summary(over: Partial<ScanSummary> = {}): ScanSummary {
  return {
    pagesScanned: 3, htmlPages: 3, linksChecked: 12, brokenLinks: 1, inconclusiveLinks: 0,
    findingsBySeverity: { high: 1, medium: 2 }, findingsByCategory: { seo: 2, links: 1 }, totalFindings: 3,
    scores: { links: 85, seo: 72, indexability: 100, accessibility: 90, security: 100, browser: null, performance: 61 },
    scoreFormulaVersion: "v2", robotsStatus: "found", sitemapStatus: "found", crawlTruncated: false, durationMs: 42_000,
    coverage: {
      browser: { requested: 0, attempted: 0, succeeded: 0, failed: 0, skippedReason: "browser rendering is not available on this server" },
      accessibility: { pages: 0, engine: null, skippedReason: "browser rendering is not available on this server" },
      performance: { url: "https://shop.example.com/", runs: [{ strategy: "mobile", ok: true, error: null }], skippedReason: null },
    },
    ...over,
  };
}

function input(over: Partial<PdfReportInput> = {}, findings?: Finding[]): PdfReportInput {
  const S = "https://shop.example.com";
  const f = findings ?? analyzeScan(analysisInput({ startUrl: `${S}/`, siteHost: "shop.example.com", pages: [makePage(`${S}/`, { title: null, metaDescription: null }), makePage(`${S}/a`, { title: "Home", imagesMissingAlt: 2, imageCount: 2 })] })).map((x) => ({ ...x, scanId: "s" }));
  return {
    scan: {
      id: "11111111-2222-4333-8444-555555555555",
      targetUrl: `${S}/`,
      status: "completed",
      finishedAt: "2026-10-16T05:00:00.000Z",
      createdAt: "2026-10-16T04:59:00.000Z",
      warnings: [],
      summary: summary(),
      crawl: { crawlTruncated: false, skipped: { robots: 0, limit: 0, depth: 0, traps: 0 } },
      limits: { maxPages: 25, maxDepth: 3, maxLinksToCheck: 300 },
    },
    findings: f,
    performance: [parsePageSpeed(PSI, `${S}/`, "mobile")],
    renders: [],
    generatedAt: new Date("2026-10-16T06:00:00Z"),
    ...over,
  };
}

describe("pdfText (WinAnsi sanitisation)", () => {
  it("keeps Latin-1 and typographic characters, replaces the rest", () => {
    expect(pdfText("Café — “quoted” … • ü ß €")).toBe("Café — “quoted” … • ü ß €");
    expect(pdfText("a → b ≥ c ≈ d")).toBe("a -> b >= c ~ d");
    expect(pdfText("日本語 🚀 ok")).toBe("??? ? ok");
    expect(pdfText("tab\there\nline\u0000\u200b")).toBe("tab here line");
    expect(pdfText("Łódź ő")).toBe("?ódz o"); // ó is Latin-1; Ł has no ASCII base; ź/ő lose accents
    expect(pdfText(null)).toBe("");
  });
});

describe("PDF report builder", () => {
  it("produces a valid, branded PDF with summary, coverage, performance and issues", async () => {
    const bytes = await buildReportPdf(input());
    if (process.env.PDF_SAMPLE_OUT) (await import("node:fs")).writeFileSync(process.env.PDF_SAMPLE_OUT, bytes); // manual visual review
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("SiteInsights report - shop.example.com");
    expect(doc.getAuthor()).toBe("TalhaImtiazWorks");
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    const text = await extractText(bytes);
    expect(text).toContain("A TalhaImtiazWorks Product");
    expect(text).toContain("© 2026 TalhaImtiazWorks. SiteInsights is a TalhaImtiazWorks product.");
    for (const s of ["SiteInsights", "Website audit report", "https://shop.example.com/", "Overview", "Scores", "Coverage", "Action plan", "Performance", "Rendering & accessibility", "Limitations", "Page 1 of"]) expect(text, s).toContain(s);
    expect(text).toContain("Not evaluated"); // browser score is null
    expect(text).toContain("TBT: 420 ms (lab; not INP)");
    expect(text).toMatch(/INP is only measured from real users/);
    expect(text.replace(/\n/g, " ")).toMatch(/do not establish WCAG conformance/);
    expect(text).toContain("Empty page title");
  });

  it("renders only the supplied published profile, matched services, contact details and relevant portfolio", async () => {
    const logoBytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 18, g: 52, b: 86, alpha: 1 } } }).png().toBuffer();
    const logoDataUrl = `data:image/png;base64,${logoBytes.toString("base64")}`;
    const bytes = await buildReportPdf(input({ personalization: {
      professional: {
        profileType: "agency", professionalName: "Ayesha Rahman", businessName: "Northstar Studio", jobTitle: "SEO consultant",
        headline: "Evidence-led technical SEO", biography: "We help teams fix verified search issues.", websiteUrl: "https://northstar.example.com/",
        contactEmail: "hello@northstar.example.com", contactPhone: "+92 300 1234567", location: "Karachi", brandColors: ["#123456"], logoDataUrl,
      },
      matchedServices: [{
        serviceId: "service-1", title: "Technical SEO", description: "Improve crawlability and page metadata.", categories: ["seo"], score: 84,
        matchedFindings: [{ id: "finding-1", title: "Empty page title", ruleId: "seo:title-missing", category: "seo", severity: "high", affectedCount: 2 }],
      }],
      portfolio: [{ id: "portfolio-1", title: "Retail search refresh", projectUrl: "https://northstar.example.com/work/retail", description: "A relevant published project.", serviceIds: ["service-1"], categories: ["seo"] }],
    } }));
    const text = await extractText(bytes);
    for (const value of ["Ayesha Rahman", "Northstar Studio", "Agency", "Technical SEO", "hello@northstar.example.com", "Karachi", "Empty page title", "Retail search refresh", "https://northstar.example.com/work/retail", "#123456"]) {
      expect(text).toContain(value);
    }
    expect(text).toContain("explicitly selected for publication");
  });

  it("handles very long URLs, hundreds of findings and non-Latin text without failing", async () => {
    const longUrl = `https://shop.example.com/${"very-long-path-segment/".repeat(80)}?q=${"x".repeat(500)}`;
    const many: Finding[] = Array.from({ length: 260 }, (_, i) => ({
      id: `f${i}`, scanId: "s", ruleId: `seo.rule_${i}`, category: "seo", type: "error", severity: (["critical", "high", "medium", "low", "info"] as const)[i % 5],
      title: `Problem ${i} — 日本語 タイトル اردو متن العربية 한국어 🚀`, description: "D".repeat(1500), affectedUrl: longUrl, affectedUrls: Array.from({ length: 40 }, () => longUrl), affectedCount: 40,
      evidence: { summary: `Evidence ${i} ${"e".repeat(600)}`, items: Array.from({ length: 30 }, (_, j) => ({ label: `item ${j}`, value: longUrl })), urls: [] },
      detectionMethod: "x", recommendation: "Fix it — properly. ".repeat(40), aiExplanationAvailable: false, createdAt: "2026-10-16T05:00:00.000Z",
    }));
    const t0 = Date.now();
    const bytes = await buildReportPdf(input({ scan: { ...input().scan, targetUrl: longUrl, warnings: ["Some pages could not be fetched → see details."] } }, many));
    const ms = Date.now() - t0;
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(20);
    expect(ms).toBeLessThan(30_000);
    const text = await extractText(bytes);
    expect(text).not.toContain("Further issues (titles only)"); // all findings are detailed now
    expect(text).toContain("Problem 0 — "); // non-Latin runs use embedded Unicode fonts
    expect(text).toContain("Problem 259 — "); // no findings are dropped
    // Every line fits within the page: no drawn line is wider than the content area.
    expect(text.split("\n").every((l) => l.length < 200)).toBe(true);
  }, 60_000);
});

// ------------------------------------------------------------------ route
describe("GET /api/scans/:id/report.pdf", () => {
  let auth: Awaited<ReturnType<typeof startAuthFixture>>;
  function signedBrowser(name: string, userId?: string) { const browser = new TestBrowser(name); auth.signIn(browser, { userId }); return browser; }
  const SAVED = { ...process.env };
  beforeAll(async () => {
    auth = await startAuthFixture();
    process.env = { ...SAVED, NODE_ENV: "test", ALLOW_MEMORY_STORAGE: "true", API_RATE_LIMIT_PER_MINUTE: "10000", PLAN_PRO_PDF_PER_DAY: "2" } as NodeJS.ProcessEnv;
    auth.configure();
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    __resetConfigForTests();
    __resetRepositoryForTests();
  });
  afterAll(async () => {
    await auth.close();
    process.env = SAVED;
    __resetConfigForTests();
    __resetRepositoryForTests();
  });
  beforeEach(() => __resetRateLimitsForTests());

  async function seed(status: "completed" | "running" = "completed") {
    const repo = getRepository();
    const s = loadConfig({}).scanner;
    const ownerId = randomUUID();
    const job = createScanJob({ principalId: `user:${ownerId}`, websiteId: null, targetUrl: "https://shop.example.com/", limits: { maxPages: 5, maxDepth: 2, maxRedirects: 5, concurrency: 2, requestTimeoutMs: 1000, maxBodyBytes: s.maxBodyBytes, maxDurationMs: 60_000, maxRetries: 0, hostMinIntervalMs: 0, maxLinksToCheck: 50, stepBudgetMs: 5000, allowedPorts: [80, 443], maxQueryVariantsPerPath: 3, maxSitemapFiles: 2, maxSitemapUrls: 50 } });
    const key = newScanKey();
    job.access = { keyHash: hashScanKey(key), idempotencyKey: null };
    await repo.createScan(job);
    planOverrides.set(`user:${ownerId}`, "pro"); // PDF reports are a Pro/Business feature
    if (status === "completed") {
      job.status = "running";
      job.summary = summary();
      job.finishedAt = new Date().toISOString();
      await repo.saveScan(job);
      await repo.transitionScan(job.id, ["running"], "completed", { phase: "finished", finishedAt: job.finishedAt });
      await repo.insertFindings(input().findings.map((f) => ({ ...f, scanId: job.id })));
      await repo.saveArtifact({ scanId: job.id, kind: "performance", key: "mobile", data: parsePageSpeed(PSI, job.targetUrl, "mobile"), createdAt: new Date().toISOString() } as never);
    }
    return { id: job.id, key, ownerId };
  }
  const get = (b: TestBrowser, id: string) => b.call(pdfRoute.GET, "GET", `/api/scans/${id}/report.pdf`, { params: { id } });

  it("serves a real PDF to an authorised browser and counts the export", async () => {
    const { id, key, ownerId } = await seed();
    const b = signedBrowser("owner", ownerId);
    b.scanKeys.set(id, key);
    const r = await get(b, id);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="siteinsight-shop\.example\.com-[0-9a-f]{8}\.pdf"$/);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(r.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(Number(r.headers.get("content-length"))).toBe(r.bytes.byteLength);
    expect(await extractText(r.bytes)).toContain("Lab data (Lighthouse 12.8.2");
    const u = await b.call<{ usage: { pdf: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
    expect(u.body.data!.usage.pdf.used).toBe(1);
  });

  it("free product: every signed-in owner gets the PDF (no plan gate); the owner window is metered", async () => {
    const { id, key, ownerId } = await seed();
    planOverrides.delete(`user:${ownerId}`);
    const b = signedBrowser("free-owner", ownerId);
    b.scanKeys.set(id, key);
    const r = await get(b, id);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/pdf/);
    const u = await b.call<{ usage: { pdf: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
    expect(u.body.data!.usage.pdf.used).toBe(1);
  });

  it("refuses other browsers, unfinished audits and bad IDs", async () => {
    const { id } = await seed();
    const stranger = signedBrowser("stranger");
    await stranger.visit("/");
    const r = await get(stranger, id);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toMatch(/json/);
    const running = await seed("running");
    const owner = signedBrowser("owner2", running.ownerId);
    owner.scanKeys.set(running.id, running.key);
    expect((await get(owner, running.id)).body.error?.code).toBe("results_unavailable");
    const bad = await get(owner, "not-a-uuid");
    expect(bad.status).toBe(404); // same contract as every scan route
    expect(bad.body.error?.code).toBe("not_found");
  });

  it("reports a failed build as an error, never an empty file, and refunds the allowance", async () => {
    const { id, key, ownerId } = await seed();
    const b = signedBrowser("failing", ownerId);
    b.scanKeys.set(id, key);
    failBuild.on = true;
    try {
      const r = await get(b, id);
      expect(r.status).toBe(500);
      expect(r.body.error?.code).toBe("pdf_failed");
      expect(r.headers.get("content-type")).not.toContain("pdf");
    } finally {
      failBuild.on = false;
    }
    const u = await b.call<{ usage: { pdf: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
    expect(u.body.data!.usage.pdf.used).toBe(0);
  });

  it("enforces the PDF export allowance on the server", async () => {
    const { id, key, ownerId } = await seed();
    const b = signedBrowser("heavy", ownerId);
    b.scanKeys.set(id, key);
    expect((await get(b, id)).status).toBe(200);
    expect((await get(b, id)).status).toBe(200);
    const third = await get(b, id);
    expect(third.status).toBe(429);
    expect(third.body.error?.code).toBe("pdf_limit_reached");
  });
});
