import { describe, expect, it } from "vitest";
import { analyzeScan } from "@/lib/audit/analyze";
import { ALL_RULES, getRule } from "@/lib/audit/rules";
import { computeScores, SEVERITY_WEIGHTS } from "@/lib/audit/scoring";
import { findingSchema, type Finding } from "@/lib/audit/types";
import { analysisInput, makeLink, makePage } from "./helpers/factories";

const S = "https://example.com";
const ids = (f: Finding[]) => new Set(f.map((x) => x.ruleId));
const byRule = (f: Finding[], id: string) => f.filter((x) => x.ruleId === id);

describe("SEO rules", () => {
  it("produces no findings for a clean site", () => {
    const pages = [makePage(`${S}/`, { depth: 0, discoveredVia: "start" }), makePage(`${S}/about`)];
    pages[0].links = [{ url: `${S}/about`, text: "About", internal: true, nofollow: false }] as never;
    pages[1].links = [{ url: `${S}/`, text: "Home", internal: true, nofollow: false }] as never;
    const f = analyzeScan(analysisInput({ pages, links: [makeLink(`${S}/about`), makeLink(`${S}/`)] }));
    expect(f.filter((x) => x.severity !== "info")).toEqual([]);
  });

  it("detects missing, empty, duplicate and badly sized titles", () => {
    const pages = [
      makePage(`${S}/`, { title: null, titleCount: 0 }),
      makePage(`${S}/a`, { title: "", titleCount: 1 }),
      makePage(`${S}/b`, { title: "Same title for two different pages" }),
      makePage(`${S}/c`, { title: "Same title for two different pages" }),
      makePage(`${S}/d`, { title: "Hi" }),
      makePage(`${S}/e`, { title: "x".repeat(90) }),
    ];
    const f = analyzeScan(analysisInput({ pages }));
    const r = ids(f);
    expect(r.has("seo.title_missing")).toBe(true);
    expect(r.has("seo.title_empty")).toBe(true);
    expect(r.has("seo.title_duplicate")).toBe(true);
    expect(byRule(f, "seo.title_duplicate")[0].affectedUrls.sort()).toEqual([`${S}/b`, `${S}/c`]);
    const len = byRule(f, "seo.title_length");
    expect(len).toHaveLength(1); // grouped: one finding, every affected page listed
    expect([...len[0].affectedUrls].sort()).toEqual([`${S}/d`, `${S}/e`]);
  });

  it("detects missing and duplicate meta descriptions", () => {
    const d = "An identical meta description shared between two separate pages of the site.";
    const f = analyzeScan(analysisInput({ pages: [makePage(`${S}/`, { metaDescription: null, metaDescriptionCount: 0 }), makePage(`${S}/a`, { metaDescription: d }), makePage(`${S}/b`, { metaDescription: d })] }));
    expect(ids(f).has("seo.meta_description_missing")).toBe(true);
    expect(ids(f).has("seo.meta_description_duplicate")).toBe(true);
  });

  it("flags missing H1 as an issue and multiple H1 only as a review observation", () => {
    const f = analyzeScan(analysisInput({ pages: [makePage(`${S}/`, { h1: [], headings: [{ level: 2, text: "x" }] }), makePage(`${S}/a`, { h1: ["One", "Two"], headings: [{ level: 1, text: "One" }, { level: 1, text: "Two" }] })] }));
    const missing = byRule(f, "seo.h1_missing")[0];
    const multiple = byRule(f, "seo.h1_multiple")[0];
    expect(missing).toBeDefined();
    expect(multiple).toBeDefined();
    expect(multiple.type).toBe("observation");
    expect(multiple.severity === "info" || multiple.severity === "low").toBe(true);
    expect(["error", "recommendation"]).toContain(missing.type);
  });

  it("detects skipped heading levels", () => {
    const f = analyzeScan(analysisInput({ pages: [makePage(`${S}/`, { headings: [{ level: 1, text: "A" }, { level: 3, text: "C" }] })] }));
    expect(ids(f).has("seo.heading_skip")).toBe(true);
  });

  it("detects missing, invalid and off-site canonicals and noindex", () => {
    const f = analyzeScan(analysisInput({
      pages: [
        makePage(`${S}/`, { canonical: null, canonicalRaw: null, canonicalCount: 0 }),
        makePage(`${S}/a`, { canonical: null, canonicalRaw: "http://[bad", canonicalCount: 1 }),
        makePage(`${S}/b`, { canonical: "https://other-site.org/b", canonicalRaw: "https://other-site.org/b" }),
        makePage(`${S}/c`, { robotsMeta: "noindex, follow" }),
        makePage(`${S}/d`, { xRobotsTag: "noindex" }),
      ],
    }));
    const r = ids(f);
    expect(r.has("indexability.canonical_missing")).toBe(true);
    expect(r.has("indexability.canonical_invalid")).toBe(true);
    expect(r.has("indexability.canonical_off_site")).toBe(true);
    expect(byRule(f, "indexability.noindex")[0].affectedUrls.sort()).toEqual([`${S}/c`, `${S}/d`]);
  });

  it("reports missing robots.txt and sitemap", () => {
    const f = analyzeScan(analysisInput({
      pages: [makePage(`${S}/`)],
      robots: { status: "not_found", url: `${S}/robots.txt`, httpStatus: 404, body: null, crawlDelayMs: null, sitemaps: [], error: null, disallowAll: false },
      sitemap: { status: "not_found", checked: [], pageUrls: [], offHostUrls: 0 },
    }));
    expect(ids(f).has("indexability.robots_missing")).toBe(true);
    expect(ids(f).has("indexability.sitemap_missing")).toBe(true);
  });

  it("reports broken internal links with their source pages, and never reports blocked links as broken", () => {
    const f = analyzeScan(analysisInput({
      pages: [makePage(`${S}/`)],
      links: [
        makeLink(`${S}/gone`, { statusCode: 404, category: "not_found", sources: [`${S}/`, `${S}/a`], message: "HTTP 404 Not Found" }),
        makeLink("https://partner.org/x", { internal: false, statusCode: 403, category: "blocked", verification: "inconclusive" }),
      ],
    }));
    const broken = byRule(f, "links.broken");
    expect(broken).toHaveLength(1);
    // Affected URLs are the pages that contain the broken link (the pages to edit).
    expect(broken[0].affectedUrls).toEqual([`${S}/`, `${S}/a`]);
    expect(broken[0].evidence.summary).toContain(`${S}/gone`);
    expect(broken[0].title).toBe("Broken internal link (HTTP 404)");
    expect(f.some((x) => x.ruleId.startsWith("links.") && x.ruleId !== "links.unverified" && x.affectedUrls.includes("https://partner.org/x"))).toBe(false);
    const unverified = byRule(f, "links.unverified");
    expect(unverified.length).toBe(1);
    expect(unverified[0].severity).toBe("info");
  });

  it("flags internal redirects, links to non-canonical URLs and HTTP links on HTTPS sites", () => {
    const home = makePage(`${S}/`, { depth: 0 });
    home.links = [
      { url: `${S}/old`, text: "Old", internal: true, nofollow: false },
      { url: `${S}/dup`, text: "Dup", internal: true, nofollow: false },
      { url: "http://example.com/x", text: "Insecure", internal: true, nofollow: false },
    ] as never;
    const dup = makePage(`${S}/dup`, { canonical: `${S}/canonical-version`, canonicalRaw: `${S}/canonical-version` });
    const f = analyzeScan(analysisInput({
      pages: [home, dup, makePage(`${S}/canonical-version`)],
      links: [makeLink(`${S}/old`, { category: "redirect", finalUrl: `${S}/new`, redirectChain: [{ url: `${S}/old`, status: 301 }] }), makeLink(`${S}/dup`), makeLink("http://example.com/x", { category: "redirect" })],
    }));
    const r = ids(f);
    expect(r.has("links.internal_redirects")).toBe(true);
    expect(r.has("indexability.non_canonical_links")).toBe(true);
    expect(r.has("security.internal_http_links")).toBe(true);
  });

  it("flags HTTP-only sites, mixed content, missing alt and lang", () => {
    const f = analyzeScan(analysisInput({
      startUrl: "http://example.com/",
      pages: [makePage("http://example.com/", { imagesMissingAlt: 2, imageCount: 3, lang: null, canonical: "http://example.com/", canonicalRaw: "http://example.com/" }), makePage(`${S}/s`, { mixedContent: ["http://cdn.example.com/a.js"] })],
    }));
    const r = ids(f);
    expect(r.has("security.no_https")).toBe(true);
    expect(r.has("security.mixed_content")).toBe(true);
    expect(r.has("accessibility.img_alt_missing")).toBe(true);
    expect(r.has("accessibility.lang_missing")).toBe(true);
  });

  it("identifies orphan candidates from the sitemap", () => {
    const home = makePage(`${S}/`, { depth: 0, discoveredVia: "start" });
    const orphan = makePage(`${S}/orphan`, { discoveredVia: "sitemap" });
    const f = analyzeScan(analysisInput({ pages: [home, orphan], sitemap: { status: "found", checked: [], pageUrls: [`${S}/`, `${S}/orphan`], offHostUrls: 0 } }));
    const o = byRule(f, "indexability.orphan_candidate");
    expect(o).toHaveLength(1);
    expect(o[0].affectedUrls).toContain(`${S}/orphan`);
    expect(o[0].type).toBe("observation");
  });
});

describe("findings shape and severity", () => {
  const pages = [makePage(`${S}/`, { title: null, titleCount: 0, h1: [] }), makePage(`${S}/a`, { metaDescription: null, metaDescriptionCount: 0 })];
  const input = analysisInput({ pages, links: [makeLink(`${S}/gone`, { category: "not_found", statusCode: 404 })] });

  it("every finding validates against the schema and carries evidence, method and recommendation", () => {
    const f = analyzeScan(input);
    expect(f.length).toBeGreaterThan(2);
    for (const x of f) {
      expect(findingSchema.safeParse(x).success).toBe(true);
      expect(x.evidence.summary.length).toBeGreaterThan(0);
      expect(x.detectionMethod.length).toBeGreaterThan(0);
      expect(x.recommendation.length).toBeGreaterThan(0);
      expect(x.createdAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("is deterministic: same input → same findings, ids and severities", () => {
    const a = analyzeScan(input);
    const b = analyzeScan(input);
    expect(a.map((x) => [x.id, x.severity])).toEqual(b.map((x) => [x.id, x.severity]));
  });

  it("uses rule catalogue severities and ids are unique", () => {
    const f = analyzeScan(input);
    expect(new Set(f.map((x) => x.id)).size).toBe(f.length);
    for (const x of f) {
      const rule = getRule(x.ruleId as Parameters<typeof getRule>[0]);
      expect(rule).toBeDefined();
      if (!rule!.severityFor) expect(x.severity).toBe(rule!.baseSeverity);
      expect(x.category).toBe(rule!.category);
      expect(x.type).toBe(rule!.type);
    }
  });

  it("rule catalogue is complete and consistent", () => {
    expect(new Set(ALL_RULES.map((r) => r.id)).size).toBe(ALL_RULES.length);
    for (const r of ALL_RULES) expect(r.id.startsWith(`${r.category}.`)).toBe(true);
    expect(getRule("links.broken")!.baseSeverity).toBe("high");
  });
});

describe("scoring (formula v1)", () => {
  const all = { links: true, seo: true, indexability: true, accessibility: true, security: true };
  const fnd = (ruleId: string, severity: Finding["severity"], category: Finding["category"], affected: number): Finding =>
    ({ id: `f_${ruleId}`, ruleId, severity, category, affectedCount: affected, affectedUrls: Array.from({ length: affected }, (_, i) => `${S}/${i}`) }) as unknown as Finding;

  it("gives 100 with no findings and null for unevaluated categories", () => {
    const s = computeScores([], 10, { ...all, security: false });
    expect(s.seo).toBe(100);
    expect(s.security).toBeNull();
  });

  it("applies weight × (0.5 + 0.5 × coverage)", () => {
    // high (15) on 10/10 pages → 15; medium (7) on 1/10 → 7 × 0.55 = 3.85 → total 18.85 → 81
    const s = computeScores([fnd("seo.title_missing", "high", "seo", 10), fnd("seo.meta_description_missing", "medium", "seo", 1)], 10, all);
    expect(s.seo).toBe(81);
    expect(SEVERITY_WEIGHTS.critical).toBe(30);
  });

  it("info findings do not reduce the score and scores never go below 0", () => {
    expect(computeScores([fnd("links.unverified", "info", "links", 5)], 5, all).links).toBe(100);
    const many = Array.from({ length: 10 }, (_, i) => fnd(`links.r${i}`, "critical", "links", 5));
    expect(computeScores(many, 5, all).links).toBe(0);
  });
});
