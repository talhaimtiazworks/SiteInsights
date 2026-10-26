import type { PageRecord } from "../scanner/types";

/** Lightweight page projection for lists (omits full link/image arrays). */
export function pageSummary(p: PageRecord) {
  return {
    id: p.id,
    url: p.url,
    finalUrl: p.finalUrl,
    statusCode: p.statusCode,
    responseTimeMs: p.responseTimeMs,
    contentType: p.contentType,
    isHtml: p.isHtml,
    depth: p.depth,
    discoveredVia: p.discoveredVia,
    sourceUrl: p.sourceUrl,
    redirectChain: p.redirectChain,
    fetchError: p.fetchError,
    offSiteRedirect: p.offSiteRedirect,
    bodyTruncated: p.bodyTruncated,
    title: p.title,
    metaDescription: p.metaDescription,
    h1: p.h1,
    headings: p.headings.slice(0, 30),
    canonical: p.canonical,
    robotsMeta: p.robotsMeta,
    xRobotsTag: p.xRobotsTag,
    lang: p.lang,
    internalLinkCount: p.internalLinkCount,
    externalLinkCount: p.externalLinkCount,
    imageCount: p.imageCount,
    imagesMissingAlt: p.imagesMissingAlt,
    fetchedAt: p.fetchedAt,
  };
}
export type PageSummary = ReturnType<typeof pageSummary>;

import type { RenderResult } from "../browser/protocol";

/** Compact per-page browser-render summary for the report (full evidence lives in findings). */
export function renderSummary(url: string, r: RenderResult) {
  return {
    url,
    finalUrl: r.finalUrl,
    ok: r.ok,
    status: r.status,
    error: r.error,
    viewport: r.viewport,
    readiness: r.readiness,
    totalMs: r.timing.totalMs,
    requestCount: r.requestCount,
    blockedRequestCount: r.blockedRequestCount,
    requestBudgetExceeded: r.requestBudgetExceeded,
    consoleErrors: r.consoleTotal,
    failedRequests: r.failedRequests.filter((f) => !f.blockedBySafety && f.failure !== "net::ERR_ABORTED").length,
    brokenImages: r.images.filter((i) => i.broken).length,
    renderedLinks: r.linksTotal,
    wordCount: r.dom?.wordCount ?? null,
    mobile: r.mobile ? { horizontalOverflow: r.mobile.horizontalOverflow, smallTapTargets: r.mobile.smallTapTargetsTotal, smallText: r.mobile.smallTextTotal } : null,
    axe: r.axe ? { version: r.axe.version, violations: r.axe.violations.length, affectedNodes: r.axe.violations.reduce((n, v) => n + v.nodeCount, 0), passes: r.axe.passes, incomplete: r.axe.incomplete } : null,
    axeError: r.axeError,
  };
}
export type RenderSummary = ReturnType<typeof renderSummary>;
