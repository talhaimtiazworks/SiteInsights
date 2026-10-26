import { createHash } from "node:crypto";
import { sameSiteHost } from "../security/url";
import type { RenderResult } from "../browser/protocol";
import type { PerformanceRun } from "../performance/pagespeed";
import { buildRobotsChecker } from "../scanner/robots";
import type { LinkCheckRecord, PageRecord, RobotsInfo, SitemapInfo } from "../scanner/types";
import { analyzeBrowser } from "./analyze-browser";
import { analyzePerformance } from "./analyze-performance";
import { assignSeverity, DESCRIPTION_MAX, DESCRIPTION_MIN, getRule, TITLE_MAX, TITLE_MIN, type RuleDefinition, type RuleId, type SeverityContext } from "./rules";
import { findingSchema, SEVERITY_ORDER, type Evidence, type Finding, type Severity } from "./types";

/**
 * Deterministic analysis: turns crawl data into validated findings.
 * No network, no AI, no randomness — same input always yields same output.
 */

export interface AnalysisInput {
  scanId: string;
  startUrl: string;
  siteHost: string;
  pages: PageRecord[];
  links: LinkCheckRecord[];
  robots: RobotsInfo | null;
  sitemap: SitemapInfo | null;
  crawlTruncated: boolean;
  aiAvailable: boolean;
  now?: string;
  /** Browser worker results keyed by the rendered (final) page URL. */
  renders?: Array<{ url: string; result: RenderResult }>;
  /** PageSpeed Insights runs (one per strategy). */
  performance?: PerformanceRun[];
}

export interface MakeData {
  affectedUrls: string[];
  evidence: Omit<Evidence, "items" | "urls"> & Partial<Evidence>;
  ctx?: SeverityContext;
  title?: string;
  description?: string;
  /** Overrides the rule's deterministic severity (e.g. measured thresholds, axe impact). */
  severity?: Severity;
  /** Stores the finding under a more specific rule id (e.g. accessibility.axe.color-contrast). */
  ruleIdOverride?: string;
  rule?: Partial<Pick<RuleDefinition, "type" | "detectionMethod" | "recommendation">>;
}
export type MakeFn = (ruleId: RuleId, key: string, data: MakeData) => void;

const GENERIC_TITLES = /^(home|home ?page|index|untitled( document| page)?|document|new page|page|welcome|react app|vite \+ react( \+ ts)?|vite app|next\.js app|create next app|my (web)?site|default|test|website|wordpress|just another wordpress site)$/i;
const HREFLANG_RE = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;
const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i;

function robotsTokens(v: string | null): string[] {
  if (!v) return [];
  // X-Robots-Tag may be prefixed with a user agent ("googlebot: noindex").
  return v
    .toLowerCase()
    .split(",")
    .map((t) => t.replace(/^[a-z-]+bot\s*:\s*/, "").trim())
    .filter(Boolean);
}
export function isNoindex(p: Pick<PageRecord, "robotsMeta" | "xRobotsTag">): boolean {
  return [...robotsTokens(p.robotsMeta), ...robotsTokens(p.xRobotsTag)].some((t) => t === "noindex" || t === "none");
}

const MAX_PER_TARGET_LINK_FINDINGS = 60;
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function isOkHtmlPage(p: PageRecord): boolean {
  return p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 300 && p.isHtml && !p.fetchError && !p.offSiteRedirect;
}

/** Successfully loaded HTML pages, de-duplicated by final URL (redirects to an already-crawled page count once). */
export function uniqueOkHtmlPages(pages: PageRecord[]): PageRecord[] {
  const seen = new Set<string>();
  const out: PageRecord[] = [];
  for (const p of pages) {
    if (!isOkHtmlPage(p) || seen.has(p.finalUrl)) continue;
    seen.add(p.finalUrl);
    out.push(p);
  }
  return out;
}

export function analyzeScan(input: AnalysisInput): Finding[] {
  const now = input.now ?? new Date().toISOString();
  const findings: Finding[] = [];

  const make: MakeFn = (ruleId, key, data) => {
    const rule = { ...getRule(ruleId), ...data.rule };
    const storedId = data.ruleIdOverride ?? ruleId;
    const urls = [...new Set(data.affectedUrls)];
    const id = "f_" + createHash("sha256").update(`${input.scanId}|${storedId}|${key}`).digest("hex").slice(0, 20);
    const finding = findingSchema.parse({
      id,
      scanId: input.scanId,
      ruleId: storedId,
      category: rule.category,
      type: rule.type,
      title: data.title ?? rule.title,
      severity: data.severity ?? assignSeverity(ruleId, data.ctx ?? {}),
      description: data.description ?? rule.description,
      affectedUrl: urls[0] ?? input.startUrl,
      affectedUrls: urls.slice(0, 200),
      affectedCount: urls.length,
      evidence: {
        summary: data.evidence.summary.slice(0, 1000),
        items: (data.evidence.items ?? []).slice(0, 40).map((i) => ({ label: i.label.slice(0, 120), value: i.value.slice(0, 1000) })),
        urls: (data.evidence.urls ?? []).slice(0, 50),
      },
      detectionMethod: rule.detectionMethod,
      recommendation: rule.recommendation,
      aiExplanationAvailable: input.aiAvailable,
      createdAt: now,
    });
    findings.push(finding);
  };

  // Unique successfully-loaded HTML pages, keyed by final URL.
  const okPages = uniqueOkHtmlPages(input.pages);
  const pageByUrl = new Map<string, PageRecord>();
  for (const p of input.pages) {
    pageByUrl.set(p.url, p);
    if (!pageByUrl.has(p.finalUrl)) pageByUrl.set(p.finalUrl, p);
  }
  const startPage = input.pages.find((p) => p.discoveredVia === "start") ?? null;
  const isStart = (p: PageRecord) => startPage !== null && (p.url === startPage.url || p.finalUrl === startPage.finalUrl);

  // ---- Per-page rules, grouped by rule --------------------------------------
  type Hit = { url: string; detail: string };
  const groups: Partial<Record<RuleId, Hit[]>> = {};
  const hit = (rule: RuleId, url: string, detail: string) => {
    (groups[rule] ??= []).push({ url, detail });
  };

  for (const p of okPages) {
    const u = p.finalUrl;
    if (p.titleCount === 0) hit("seo.title_missing", u, "No <title> element");
    else if (!p.title) hit("seo.title_empty", u, "<title></title> is empty");
    else {
      if (p.titleCount > 1) hit("seo.title_multiple", u, `${p.titleCount} <title> elements`);
      const len = p.title.length;
      if (len < TITLE_MIN || len > TITLE_MAX) hit("seo.title_length", u, `${len} characters: “${p.title.slice(0, 120)}”`);
    }
    if (!p.metaDescription) hit("seo.meta_description_missing", u, p.metaDescriptionCount > 0 ? "Meta description present but empty" : "No meta description element");
    else if (p.metaDescription.length < DESCRIPTION_MIN || p.metaDescription.length > DESCRIPTION_MAX) hit("seo.meta_description_length", u, `${p.metaDescription.length} characters`);
    if (p.h1.length === 0) hit("seo.h1_missing", u, "No <h1> element");
    else if (p.h1.length > 1) hit("seo.h1_multiple", u, `${p.h1.length} H1s: ${p.h1.slice(0, 3).map((h) => `“${h.slice(0, 60)}”`).join(", ")}`);
    let prev = 0;
    for (const h of p.headings) {
      if (prev > 0 && h.level > prev + 1) {
        hit("seo.heading_skip", u, `<h${prev}> followed by <h${h.level}> (“${h.text.slice(0, 60)}”)`);
        break;
      }
      prev = h.level;
    }
    if (p.canonicalCount === 0) hit("indexability.canonical_missing", u, "No canonical link element");
    else {
      if (p.canonicalCount > 1) hit("indexability.canonical_multiple", u, `${p.canonicalCount} canonical tags`);
      if (p.canonicalRaw && !p.canonical) hit("indexability.canonical_invalid", u, `href="${p.canonicalRaw.slice(0, 200)}"`);
      if (p.canonical) {
        const ch = new URL(p.canonical).hostname;
        if (!sameSiteHost(ch, input.siteHost)) hit("indexability.canonical_off_site", u, `Canonical: ${p.canonical}`);
        else {
          const target = pageByUrl.get(p.canonical);
          if (target && target.url !== p.url && (!isOkHtmlPage(target) || target.redirectChain.length > 0)) {
            const why = target.fetchError ? target.fetchError.message : target.redirectChain.length ? `redirects to ${target.finalUrl}` : `HTTP ${target.statusCode}`;
            hit("indexability.canonical_to_error", u, `Canonical ${p.canonical} → ${why}`);
          }
        }
      }
    }
    const directives = `${p.robotsMeta ?? ""}, ${p.xRobotsTag ?? ""}`.toLowerCase();
    if (/\b(noindex|none)\b/.test(directives)) {
      const src = p.robotsMeta && /\b(noindex|none)\b/.test(p.robotsMeta) ? `meta robots="${p.robotsMeta}"` : `X-Robots-Tag: ${p.xRobotsTag}`;
      hit(isStart(p) ? ("indexability.noindex#start" as RuleId) : "indexability.noindex", u, src);
    }
    if (!p.lang) hit("accessibility.lang_missing", u, "<html> has no lang attribute");
    else if (!LANG_RE.test(p.lang.trim())) hit("accessibility.lang_invalid", u, `lang="${p.lang}"`);
    if (p.viewport !== undefined && !p.viewport) hit("seo.viewport_missing", u, "No <meta name=\"viewport\"> element");
    if (p.title && (GENERIC_TITLES.test(p.title.trim()) || norm(p.title) === norm(new URL(u).hostname) || norm(p.title) === norm(new URL(u).hostname.replace(/^www\./, "")))) hit("seo.title_generic", u, `“${p.title.slice(0, 120)}”`);
    for (const [i, b] of (p.jsonLd ?? []).entries()) {
      if (!b.valid) hit("seo.structured_data_invalid", u, `Block ${i + 1}: ${b.error ?? "invalid JSON"}`);
      else if (b.missing.length) hit("seo.structured_data_incomplete", u, `Block ${i + 1}${b.types.length ? ` (${b.types.join(", ")})` : ""}: missing ${b.missing.join("; ")}`);
    }
    if (p.social) {
      const missing = ["og:title", "og:image"].filter((k) => !p.social![k]);
      if (missing.length) hit("seo.social_tags_missing", u, `Missing ${missing.join(", ")}`);
      const bad: string[] = [];
      for (const k of ["og:image", "og:url"]) if (p.social[k] && !/^https?:\/\/[^\s]+$/i.test(p.social[k])) bad.push(`${k}="${p.social[k].slice(0, 120)}" is not an absolute URL`);
      const card = p.social["twitter:card"];
      if (card && !["summary", "summary_large_image", "app", "player"].includes(card.toLowerCase())) bad.push(`twitter:card="${card.slice(0, 60)}" is not a known card type`);
      if (bad.length) hit("seo.social_tags_invalid", u, bad.join("; "));
    }
    const badHreflang = (p.hreflang ?? []).filter((h) => !HREFLANG_RE.test(h.lang) || !h.href || !/^https?:\/\//i.test(h.raw));
    if (badHreflang.length) hit("seo.hreflang_invalid", u, badHreflang.slice(0, 5).map((h) => `hreflang="${h.lang}" href="${h.raw.slice(0, 120)}"`).join("; "));
    const metaT = robotsTokens(p.robotsMeta);
    const headerT = robotsTokens(p.xRobotsTag);
    const all = [...metaT, ...headerT];
    const conflict = (all.includes("index") && (all.includes("noindex") || all.includes("none"))) || (all.includes("follow") && (all.includes("nofollow") || all.includes("none")));
    if (conflict) hit("indexability.robots_directive_conflict", u, [p.robotsMeta ? `meta robots="${p.robotsMeta}"` : null, p.xRobotsTag ? `X-Robots-Tag: ${p.xRobotsTag}` : null].filter(Boolean).join("; "));
    if (p.canonical && u.startsWith("https:") && p.canonical.startsWith("http:")) hit("indexability.canonical_http", u, `Canonical: ${p.canonical}`);
    if (p.canonical && sameSiteHost(new URL(p.canonical).hostname, input.siteHost)) {
      const target = pageByUrl.get(p.canonical);
      if (target && target.finalUrl !== u && isOkHtmlPage(target) && isNoindex(target)) hit("indexability.canonical_to_noindex", u, `Canonical ${p.canonical} is marked noindex`);
    }
    if (p.imagesMissingAlt > 0) {
      const examples = p.images.filter((i) => !i.hasAlt).slice(0, 3).map((i) => i.src ?? "(inline or lazy-loaded image)");
      hit("accessibility.img_alt_missing", u, `${p.imagesMissingAlt} of ${p.imageCount} images. e.g. ${examples.join(", ")}`);
    }
    if (u.startsWith("http:")) hit("security.no_https", u, "Final URL uses http://");
    if (p.mixedContent.length) hit("security.mixed_content", u, `${p.mixedContent.length} insecure resource(s): ${p.mixedContent.slice(0, 3).join(", ")}`);
    if (u.startsWith("https:")) {
      const httpLinks = p.links.filter((l) => l.internal && l.url.startsWith("http:"));
      if (httpLinks.length) hit("security.internal_http_links", u, `${httpLinks.length} link(s), e.g. ${httpLinks.slice(0, 3).map((l) => l.url).join(", ")}`);
    }
    if (p.invalidLinks.length) hit("links.invalid_href", u, p.invalidLinks.slice(0, 5).map((h) => `href="${h.slice(0, 120)}"`).join("; "));
  }

  // Emit grouped per-page findings
  for (const [ruleKey, hits] of Object.entries(groups) as Array<[string, Hit[]]>) {
    const isStartNoindex = ruleKey === "indexability.noindex#start";
    const ruleId = (isStartNoindex ? "indexability.noindex" : ruleKey) as RuleId;
    const n = hits.length;
    make(ruleId, ruleKey, {
      affectedUrls: hits.map((h) => h.url),
      ctx: { isStartPage: isStartNoindex, count: n },
      title: isStartNoindex ? "Start page is set to noindex" : undefined,
      evidence: {
        summary: `Detected on ${n} of ${okPages.length} successfully loaded HTML page${okPages.length === 1 ? "" : "s"}.`,
        items: hits.map((h) => ({ label: h.url, value: h.detail })),
      },
    });
  }

  // ---- Duplicate titles / descriptions -------------------------------------
  const dupGroups = (pick: (p: PageRecord) => string | null) => {
    const m = new Map<string, PageRecord[]>();
    for (const p of okPages) {
      const v = pick(p);
      if (!v) continue;
      const k = norm(v);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return [...m.entries()].filter(([, ps]) => ps.length > 1);
  };
  for (const [k, ps] of dupGroups((p) => p.title)) {
    make("seo.title_duplicate", `title:${k}`, {
      affectedUrls: ps.map((p) => p.finalUrl),
      evidence: { summary: `${ps.length} pages share the title “${ps[0].title!.slice(0, 150)}”.`, items: ps.map((p) => ({ label: p.finalUrl, value: p.title ?? "" })) },
    });
  }
  for (const [k, ps] of dupGroups((p) => p.metaDescription)) {
    make("seo.meta_description_duplicate", `desc:${k}`, {
      affectedUrls: ps.map((p) => p.finalUrl),
      evidence: { summary: `${ps.length} pages share the same meta description.`, items: ps.map((p) => ({ label: p.finalUrl, value: p.metaDescription ?? "" })) },
    });
  }

  // ---- Links ----------------------------------------------------------------
  let perTarget = 0;
  const unverified: LinkCheckRecord[] = [];
  const internalRedirects: LinkCheckRecord[] = [];
  for (const l of input.links) {
    if (l.sources.length === 0) continue; // discovered only via sitemap: handled below
    const where = l.internal ? "internal" : "external";
    const ctx = { internal: l.internal };
    const linkEvidence = (summary: string): Evidence => ({
      summary,
      items: [
        { label: "Destination", value: l.url },
        { label: "Result", value: l.statusCode !== null ? `HTTP ${l.statusCode}` : l.category },
        { label: "Detail", value: l.message },
        { label: "Check method", value: l.method },
        { label: "Verification", value: l.verification },
        ...(l.redirectChain.length ? [{ label: "Redirect chain", value: [...l.redirectChain.map((h) => `${h.url} (${h.status})`), l.finalUrl ?? ""].join(" → ") }] : []),
        { label: "Linked from", value: `${l.occurrences} occurrence(s) on ${l.sources.length} page(s)` },
        { label: "Checked at", value: l.checkedAt },
      ],
      urls: l.sources,
    });
    let rule: RuleId | null = null;
    let title: string | undefined;
    switch (l.category) {
      case "not_found":
        rule = l.kind === "image" ? "links.broken_image" : "links.broken";
        title = l.kind === "image" ? undefined : `Broken ${where} link (HTTP ${l.statusCode})`;
        break;
      case "server_error":
        rule = "links.server_error";
        title = `${l.internal ? "Internal" : "External"} link returns HTTP ${l.statusCode}`;
        break;
      case "dns_error":
        rule = "links.dns_error";
        break;
      case "redirect_loop":
      case "too_many_redirects":
        rule = "links.redirect_problem";
        break;
      case "tls_error":
        rule = "links.tls_error";
        break;
      case "blocked":
      case "client_error":
      case "connection_error":
      case "timeout":
      case "inconclusive":
        unverified.push(l);
        break;
      case "redirect":
        if (l.internal && l.kind === "page_link" && l.redirectChain.length < 2) internalRedirects.push(l);
        break;
      default:
        break;
    }
    if (rule && l.kind === "image" && rule !== "links.broken_image" && ["links.server_error", "links.dns_error", "links.redirect_problem", "links.tls_error"].includes(rule)) {
      rule = "links.broken_image";
      title = undefined;
    }
    if (rule) {
      if (perTarget >= MAX_PER_TARGET_LINK_FINDINGS) continue;
      perTarget++;
      make(rule, `link:${l.kind}:${l.url}`, {
        affectedUrls: l.sources,
        ctx,
        title,
        evidence: linkEvidence(`${l.kind === "image" ? "Image" : "Link"} destination ${l.url} — ${l.message}`),
      });
    }
  }
  if (unverified.length) {
    make("links.unverified", "unverified", {
      affectedUrls: unverified.flatMap((l) => l.sources),
      evidence: {
        summary: `${unverified.length} destination(s) could not be verified and are not counted as broken.`,
        items: unverified.slice(0, 40).map((l) => ({ label: l.url, value: `${l.statusCode !== null ? `HTTP ${l.statusCode}` : l.category}: ${l.message}` })),
      },
    });
  }
  if (internalRedirects.length) {
    make("links.internal_redirects", "internal_redirects", {
      affectedUrls: internalRedirects.flatMap((l) => l.sources),
      evidence: {
        summary: `${internalRedirects.length} internal link destination(s) redirect before reaching the final page.`,
        items: internalRedirects.slice(0, 40).map((l) => ({ label: l.url, value: `→ ${l.finalUrl ?? "?"} (${l.redirectChain.map((h) => h.status).join(" → ")})` })),
      },
    });
  }

  // Internal links that point at non-canonical URLs
  const nonCanonical: Hit[] = [];
  for (const p of okPages) {
    for (const link of p.links) {
      if (!link.internal) continue;
      const target = pageByUrl.get(link.url);
      if (!target || !isOkHtmlPage(target) || !target.canonical) continue;
      if (target.canonical !== link.url && target.canonical !== target.finalUrl && sameSiteHost(new URL(target.canonical).hostname, input.siteHost)) {
        nonCanonical.push({ url: p.finalUrl, detail: `${link.url} declares canonical ${target.canonical}` });
      }
    }
  }
  if (nonCanonical.length) {
    make("indexability.non_canonical_links", "non_canonical", {
      affectedUrls: nonCanonical.map((h) => h.url),
      evidence: { summary: `${nonCanonical.length} internal link(s) point to URLs that declare a different canonical.`, items: nonCanonical.slice(0, 40).map((h) => ({ label: h.url, value: h.detail })) },
    });
  }

  // ---- Robots / sitemap / start URL ------------------------------------------
  const r = input.robots;
  if (r?.status === "not_found") {
    make("indexability.robots_missing", "robots_missing", { affectedUrls: [r.url], evidence: { summary: `${r.url} returned HTTP ${r.httpStatus}.`, items: [{ label: "robots.txt", value: `HTTP ${r.httpStatus}` }] } });
  } else if (r?.status === "error") {
    make("indexability.robots_unreachable", "robots_unreachable", { affectedUrls: [r.url], evidence: { summary: `${r.url}: ${r.error ?? `HTTP ${r.httpStatus}`}`, items: [{ label: "Result", value: r.error ?? `HTTP ${r.httpStatus}` }] } });
  }
  const s = input.sitemap;
  if (s) {
    if (s.status === "not_found") {
      make("indexability.sitemap_missing", "sitemap_missing", {
        affectedUrls: [input.startUrl],
        evidence: { summary: "No sitemap was declared in robots.txt and /sitemap.xml was not available.", items: s.checked.map((c) => ({ label: c.url, value: c.httpStatus !== null ? `HTTP ${c.httpStatus}` : c.error ?? "error" })) },
      });
    }
    const bad = s.checked.filter((c) => c.type === "invalid" || (c.type === "error" && (c.declaredInRobots || (c.httpStatus !== null && c.httpStatus >= 500))));
    if (bad.length) {
      make("indexability.sitemap_invalid", "sitemap_invalid", {
        affectedUrls: bad.map((c) => c.url),
        evidence: { summary: `${bad.length} sitemap file(s) could not be read.`, items: bad.map((c) => ({ label: c.url, value: c.type === "invalid" ? `HTTP ${c.httpStatus}, but not valid sitemap XML` : c.error ?? `HTTP ${c.httpStatus}` })) },
      });
    }
    const sitemapSet = new Set(s.pageUrls);
    const badSitemapPages = input.pages.filter((p) => sitemapSet.has(p.url) && (p.fetchError || p.statusCode === null || p.statusCode >= 400 || p.redirectChain.length > 0));
    if (badSitemapPages.length) {
      make("indexability.sitemap_url_error", "sitemap_urls", {
        affectedUrls: badSitemapPages.map((p) => p.url),
        evidence: {
          summary: `${badSitemapPages.length} URL(s) listed in the sitemap did not return a direct 2xx response.`,
          items: badSitemapPages.slice(0, 40).map((p) => ({ label: p.url, value: p.fetchError ? p.fetchError.message : p.redirectChain.length ? `Redirects to ${p.finalUrl}` : `HTTP ${p.statusCode}` })),
        },
      });
    }
    if (!input.crawlTruncated && s.pageUrls.length > 0 && okPages.length > 1) {
      const linked = new Set<string>();
      for (const p of okPages) for (const l of p.links) if (l.internal) linked.add(l.url);
      const orphans = okPages.filter((p) => sitemapSet.has(p.url) && !isStart(p) && !linked.has(p.url) && !linked.has(p.finalUrl));
      if (orphans.length) {
        make("indexability.orphan_candidate", "orphans", {
          affectedUrls: orphans.map((p) => p.finalUrl),
          evidence: { summary: `${orphans.length} sitemap URL(s) received no internal links from the ${okPages.length} crawled pages. The crawl was complete within limits.`, items: orphans.slice(0, 40).map((p) => ({ label: p.finalUrl, value: "Listed in sitemap; 0 internal inlinks found" })) },
        });
      }
    }
  }
  if (startPage && startPage.redirectChain.length > 0) {
    const n = startPage.redirectChain.length;
    make("indexability.start_redirect", "start_redirect", {
      affectedUrls: [startPage.url],
      ctx: { count: n },
      evidence: { summary: `${startPage.url} redirects ${n} time${n > 1 ? "s" : ""} before reaching ${startPage.finalUrl}.`, items: [...startPage.redirectChain.map((h, i) => ({ label: `Hop ${i + 1}`, value: `${h.url} → HTTP ${h.status}` })), { label: "Final", value: startPage.finalUrl }] },
    });
  }

  // ---- Duplicate content (exact visible-text match) ------------------------
  const byHash = new Map<string, PageRecord[]>();
  for (const p of okPages) if (p.contentHash) byHash.set(p.contentHash, [...(byHash.get(p.contentHash) ?? []), p]);
  for (const [hash, ps] of byHash) {
    if (ps.length < 2) continue;
    const canon = new Set(ps.map((p) => p.canonical ?? p.finalUrl));
    if (canon.size === 1) continue; // consolidated with one shared canonical
    make("seo.duplicate_content", `dup:${hash}`, {
      affectedUrls: ps.map((p) => p.finalUrl),
      evidence: { summary: `${ps.length} pages have identical visible text (${ps[0].wordCount ?? 0} words) and no shared canonical URL.`, items: ps.slice(0, 40).map((p) => ({ label: p.finalUrl, value: p.canonical ? `canonical: ${p.canonical}` : "no canonical" })) },
    });
  }

  // ---- hreflang return links ---------------------------------------------------
  const missingReturn: Hit[] = [];
  for (const p of okPages) {
    for (const h of p.hreflang ?? []) {
      if (!h.href || h.href === p.finalUrl) continue;
      const target = pageByUrl.get(h.href);
      if (!target || !isOkHtmlPage(target) || !target.hreflang) continue;
      if (!target.hreflang.some((t) => t.href === p.finalUrl || t.href === p.url)) missingReturn.push({ url: p.finalUrl, detail: `hreflang="${h.lang}" → ${h.href}, which has no hreflang back to this page` });
    }
  }
  if (missingReturn.length) {
    make("seo.hreflang_missing_return", "hreflang_return", { affectedUrls: missingReturn.map((h) => h.url), evidence: { summary: `${missingReturn.length} hreflang annotation(s) are not reciprocated by the crawled target page.`, items: missingReturn.slice(0, 40).map((h) => ({ label: h.url, value: h.detail })) } });
  }

  // ---- Sitemap consistency -------------------------------------------------------
  if (s && s.pageUrls.length) {
    const sm = new Set(s.pageUrls);
    const inSitemap = okPages.filter((p) => sm.has(p.url) || sm.has(p.finalUrl));
    const noindexed = inSitemap.filter((p) => isNoindex(p));
    if (noindexed.length) make("indexability.noindex_in_sitemap", "sitemap_noindex", { affectedUrls: noindexed.map((p) => p.finalUrl), evidence: { summary: `${noindexed.length} sitemap URL(s) are marked noindex.`, items: noindexed.slice(0, 40).map((p) => ({ label: p.finalUrl, value: p.robotsMeta ? `meta robots="${p.robotsMeta}"` : `X-Robots-Tag: ${p.xRobotsTag}` })) } });
    const canonicalized = inSitemap.filter((p) => p.canonical && p.canonical !== p.finalUrl && p.canonical !== p.url && sameSiteHost(new URL(p.canonical).hostname, input.siteHost));
    if (canonicalized.length) make("indexability.canonicalized_in_sitemap", "sitemap_canonical", { affectedUrls: canonicalized.map((p) => p.finalUrl), evidence: { summary: `${canonicalized.length} sitemap URL(s) declare a different canonical URL.`, items: canonicalized.slice(0, 40).map((p) => ({ label: p.finalUrl, value: `canonical: ${p.canonical}` })) } });
    if (input.robots?.status === "found") {
      const checker = buildRobotsChecker(input.robots);
      const blocked = s.pageUrls.filter((u) => !checker.isAllowed(u));
      if (blocked.length) make("indexability.robots_blocked_in_sitemap", "sitemap_robots", { affectedUrls: blocked.slice(0, 200), evidence: { summary: `${blocked.length} sitemap URL(s) are disallowed by robots.txt.`, items: blocked.slice(0, 40).map((u) => ({ label: u, value: "Disallowed by robots.txt" })) } });
    }
  }

  // ---- Redirect chains (2+ hops) ---------------------------------------------------
  const chains = new Map<string, { hops: number; detail: string; sources: string[] }>();
  for (const p of input.pages) {
    if (p.discoveredVia === "start" || p.redirectChain.length < 2) continue;
    chains.set(p.url, { hops: p.redirectChain.length, detail: [...p.redirectChain.map((h) => `${h.url} (${h.status})`), p.finalUrl].join(" → "), sources: p.sourceUrl ? [p.sourceUrl] : [] });
  }
  for (const l of input.links) {
    if (!l.internal || l.kind !== "page_link" || l.redirectChain.length < 2 || chains.has(l.url)) continue;
    chains.set(l.url, { hops: l.redirectChain.length, detail: [...l.redirectChain.map((h) => `${h.url} (${h.status})`), l.finalUrl ?? "?"].join(" → "), sources: l.sources });
  }
  if (chains.size) {
    const list = [...chains.entries()];
    const maxHops = Math.max(...list.map(([, c]) => c.hops));
    make("indexability.redirect_chain", "redirect_chain", {
      affectedUrls: list.flatMap(([u, c]) => (c.sources.length ? c.sources : [u])),
      ctx: { count: maxHops },
      evidence: { summary: `${list.length} internal URL(s) redirect 2 or more times (longest: ${maxHops} hops).`, items: list.slice(0, 40).map(([u, c]) => ({ label: u, value: c.detail })) },
    });
  }

  // ---- Browser rendering, mobile, accessibility (axe), performance ------------------
  if (input.renders?.length) analyzeBrowser({ make, renders: input.renders, pageByUrl, links: input.links, staticFindings: findings });
  if (input.performance?.length) analyzePerformance({ make, runs: input.performance });

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.affectedCount - a.affectedCount || a.title.localeCompare(b.title));
  return findings;
}
