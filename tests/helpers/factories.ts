import type { PageRecord, LinkCheckRecord, RobotsInfo, SitemapInfo } from "@/lib/scanner/types";
import type { AnalysisInput } from "@/lib/audit/analyze";

let n = 0;
export function makePage(url: string, overrides: Partial<PageRecord> = {}): PageRecord {
  n++;
  return {
    id: `p${n}`,
    scanId: "scan-1",
    url,
    finalUrl: url,
    statusCode: 200,
    responseTimeMs: 100,
    contentType: "text/html; charset=utf-8",
    isHtml: true,
    depth: 1,
    discoveredVia: "link",
    sourceUrl: "https://example.com/",
    redirectChain: [],
    bodyTruncated: false,
    fetchError: null,
    offSiteRedirect: false,
    title: `A sufficiently descriptive title for ${url}`.slice(0, 60),
    titleCount: 1,
    metaDescription: `A unique meta description for ${url} that is long enough to be useful to searchers.`,
    metaDescriptionCount: 1,
    h1: ["Main heading"],
    headings: [{ level: 1, text: "Main heading" }, { level: 2, text: "Section" }],
    canonicalRaw: url,
    canonical: url,
    canonicalCount: 1,
    robotsMeta: null,
    xRobotsTag: null,
    lang: "en",
    internalLinkCount: 0,
    externalLinkCount: 0,
    links: [],
    invalidLinks: [],
    imageCount: 0,
    imagesMissingAlt: 0,
    images: [],
    mixedContent: [],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeLink(url: string, overrides: Partial<LinkCheckRecord> = {}): LinkCheckRecord {
  n++;
  return {
    id: `l${n}`,
    scanId: "scan-1",
    url,
    kind: "page_link",
    internal: true,
    sources: ["https://example.com/"],
    occurrences: 1,
    statusCode: 200,
    finalUrl: url,
    redirectChain: [],
    category: "ok",
    verification: "verified",
    method: "HEAD",
    message: "HTTP 200",
    responseTimeMs: 50,
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export const okRobots: RobotsInfo = {
  url: "https://example.com/robots.txt",
  status: "found",
  httpStatus: 200,
  body: "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml",
  sitemaps: ["https://example.com/sitemap.xml"],
  crawlDelayMs: null,
  error: null,
  disallowAll: false,
};

export const okSitemap: SitemapInfo = {
  status: "found",
  checked: [{ url: "https://example.com/sitemap.xml", type: "urlset", urlCount: 2, httpStatus: 200, error: null, declaredInRobots: true }],
  pageUrls: ["https://example.com/", "https://example.com/about"],
  offHostUrls: 0,
};

export function analysisInput(overrides: Partial<AnalysisInput>): AnalysisInput {
  return {
    scanId: "scan-1",
    startUrl: "https://example.com/",
    siteHost: "example.com",
    pages: [],
    links: [],
    robots: okRobots,
    sitemap: okSitemap,
    crawlTruncated: false,
    aiAvailable: false,
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
