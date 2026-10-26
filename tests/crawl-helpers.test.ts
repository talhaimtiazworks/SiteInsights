import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCrawlCandidate } from "@/lib/scanner/frontier";
import { parseHtml } from "@/lib/scanner/html";
import { buildRobotsChecker, extractRobotsSitemaps } from "@/lib/scanner/robots";
import { parseSitemap } from "@/lib/scanner/sitemap";

describe("crawl-trap avoidance", () => {
  const ok = (u: string, counts: Record<string, number> = {}) => evaluateCrawlCandidate(u, counts, 3).ok;
  it("accepts normal pages", () => {
    expect(ok("https://e.com/")).toBe(true);
    expect(ok("https://e.com/blog/post-1")).toBe(true);
    expect(ok("https://e.com/products?page=2")).toBe(true);
  });
  it("skips non-HTML resources and protected areas", () => {
    expect(evaluateCrawlCandidate("https://e.com/file.pdf", {}, 3)).toEqual({ ok: false, reason: "non_html" });
    expect(evaluateCrawlCandidate("https://e.com/wp-admin/", {}, 3)).toEqual({ ok: false, reason: "protected" });
    expect(evaluateCrawlCandidate("https://e.com/cart", {}, 3)).toEqual({ ok: false, reason: "protected" });
  });
  it("skips calendar/faceted/session parameters and repeating path segments", () => {
    expect(ok("https://e.com/events?month=2026-05")).toBe(false);
    expect(ok("https://e.com/shop?sort=price")).toBe(false);
    expect(ok("https://e.com/p?sessionid=abc")).toBe(false);
    expect(ok("https://e.com/a/b/a/b/a/")).toBe(false);
    expect(ok("https://e.com/x?a=1&b=2&c=3&d=4")).toBe(false);
  });
  it("caps query-string variants of the same path", () => {
    expect(ok("https://e.com/list?page=9", { "e.com/list": 3 })).toBe(false);
    expect(ok("https://e.com/list?page=2", { "e.com/list": 1 })).toBe(true);
  });
});

describe("parseHtml", () => {
  const fixture = readFileSync(path.join(__dirname, "fixtures/site/index.html"), "utf8").replaceAll("{{ORIGIN}}", "https://e.com").replaceAll("{{EXT}}", "https://partner.org");
  const p = parseHtml(fixture, "https://e.com/", (u) => new URL(u).hostname === "e.com");

  it("extracts title, description, headings, canonical and lang", () => {
    expect(p.title).toBe("Fixture Bakery — Fresh bread and cakes daily");
    expect(p.metaDescription).toMatch(/^Fixture Bakery bakes/);
    expect(p.h1).toEqual(["Fixture Bakery"]);
    expect(p.headings.map((h) => h.level)).toEqual([1, 2]);
    expect(p.canonical).toBe("https://e.com/");
    expect(p.lang).toBe("en");
  });

  it("resolves links, separates internal/external and ignores mailto/javascript", () => {
    const urls = p.links.map((l) => l.url);
    expect(urls).toContain("https://e.com/about");
    expect(urls).toContain("https://partner.org/forbidden");
    expect(urls.some((u) => u.startsWith("mailto:") || u.startsWith("javascript:"))).toBe(false);
    expect(p.internalLinkCount).toBeGreaterThan(5);
    expect(p.externalLinkCount).toBeGreaterThanOrEqual(4);
  });

  it("counts images without alt (empty alt is decorative and allowed)", () => {
    const html = `<html><body><img src="/a.png"><img src="/b.png" alt=""><img src="/c.png" alt="C"></body></html>`;
    const r = parseHtml(html, "https://e.com/", () => true);
    expect(r.imageCount).toBe(3);
    expect(r.imagesMissingAlt).toBe(1);
  });

  it("detects mixed content on HTTPS pages", () => {
    const r = parseHtml(`<html><body><img src="http://cdn.e.com/x.png" alt="x"><script src="http://cdn.e.com/a.js"></script></body></html>`, "https://e.com/", () => true);
    expect(r.mixedContent.length).toBeGreaterThanOrEqual(1);
  });

  it("records invalid canonicals", () => {
    const r = parseHtml(`<html><head><link rel="canonical" href="http://[invalid"></head></html>`, "https://e.com/", () => true);
    expect(r.canonicalRaw).toBe("http://[invalid");
    expect(r.canonical).toBeNull();
  });
});

describe("robots.txt", () => {
  const info = {
    status: "found" as const,
    url: "https://e.com/robots.txt",
    httpStatus: 200,
    body: "User-agent: *\nDisallow: /private/\n\nUser-agent: SiteLensAI\nDisallow: /no-sitelens/\nCrawl-delay: 2\nSitemap: https://e.com/sm.xml",
    crawlDelayMs: null,
    sitemaps: [],
    error: null,
    disallowAll: false,
  };
  it("applies the SiteLensAI group", () => {
    const c = buildRobotsChecker(info);
    expect(c.isAllowed("https://e.com/no-sitelens/x")).toBe(false);
    expect(c.isAllowed("https://e.com/ok")).toBe(true);
    expect(c.crawlDelayMs).toBe(2000);
  });
  it("allows everything when robots.txt is missing and blocks everything when disallowAll", () => {
    expect(buildRobotsChecker({ ...info, status: "not_found", body: null }).isAllowed("https://e.com/private/")).toBe(true);
    expect(buildRobotsChecker({ ...info, disallowAll: true }).isAllowed("https://e.com/")).toBe(false);
  });
  it("extracts sitemap declarations", () => {
    expect(extractRobotsSitemaps("https://e.com/robots.txt", info.body)).toEqual(["https://e.com/sm.xml"]);
  });
});

describe("parseSitemap", () => {
  it("parses urlsets and sitemap indexes", () => {
    const u = parseSitemap(`<?xml version="1.0"?><urlset><url><loc>https://e.com/a?x=1&amp;y=2</loc></url><url><loc> https://e.com/b </loc></url></urlset>`, 100);
    expect(u).toEqual({ type: "urlset", locs: ["https://e.com/a?x=1&y=2", "https://e.com/b"] });
    const i = parseSitemap(`<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>`, 100);
    expect(i.type).toBe("index");
    expect(i.locs).toEqual(["https://e.com/s1.xml"]);
  });
  it("is bounded and rejects non-sitemaps", () => {
    const many = `<urlset>${Array.from({ length: 50 }, (_, k) => `<url><loc>https://e.com/${k}</loc></url>`).join("")}</urlset>`;
    expect(parseSitemap(many, 10).locs).toHaveLength(10);
    expect(parseSitemap("<html><body>hi</body></html>", 10).type).toBe("invalid");
  });
});
