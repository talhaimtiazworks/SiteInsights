import { createHash } from "node:crypto";
import { parse, type HTMLElement } from "node-html-parser";
import { resolveHref } from "../security/url";
import type { HeadingInfo, PageImage, PageLink } from "./types";

/**
 * Extracts SEO-relevant data from an HTML document. Pure function: no network.
 * Crawled content is untrusted; values are length-limited and never executed.
 */

export interface ParsedHtml {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  h1: string[];
  headings: HeadingInfo[];
  canonicalRaw: string | null;
  canonical: string | null;
  canonicalCount: number;
  robotsMeta: string | null;
  lang: string | null;
  links: PageLink[];
  invalidLinks: string[];
  internalLinkCount: number;
  externalLinkCount: number;
  images: PageImage[];
  imageCount: number;
  imagesMissingAlt: number;
  mixedContent: string[];
  /** JSON-LD blocks (syntax + basic shape). */
  jsonLd: JsonLdInfo[];
  /** og:* and twitter:* meta tags (first value of each). */
  social: Record<string, string>;
  hreflang: HreflangInfo[];
  viewport: string | null;
  /** Words of visible body text (scripts/styles excluded). */
  wordCount: number;
  /** sha256 of normalised visible text, for exact-duplicate detection. null when < 50 words. */
  contentHash: string | null;
}

export interface JsonLdInfo {
  valid: boolean;
  error: string | null;
  types: string[];
  /** Top-level items missing @context or @type. */
  missing: string[];
}

export interface HreflangInfo {
  lang: string;
  href: string | null;
  raw: string;
}

export const LIMITS = { links: 400, images: 150, headings: 60, text: 200, mixed: 25, jsonLd: 10, jsonLdBytes: 200_000, hreflang: 60, social: 20 };

const JSON_LD_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

export function inspectJsonLd(raw: string): JsonLdInfo {
  const src = raw.trim().replace(/^<!--/, "").replace(/-->$/, "").trim();
  if (!src) return { valid: false, error: "Empty JSON-LD block", types: [], missing: [] };
  if (src.length > LIMITS.jsonLdBytes) return { valid: false, error: "JSON-LD block is too large to check", types: [], missing: [] };
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch (e) {
    return { valid: false, error: clean((e as Error).message, 160) || "Invalid JSON", types: [], missing: [] };
  }
  const items: unknown[] = Array.isArray(data) ? data : [data];
  const types: string[] = [];
  const missing: string[] = [];
  const addTypes = (o: Record<string, unknown>) => {
    const t = o["@type"];
    for (const v of Array.isArray(t) ? t : [t]) if (typeof v === "string" && types.length < 20 && !types.includes(v)) types.push(clean(v, 60));
  };
  items.forEach((it, i) => {
    if (!it || typeof it !== "object" || Array.isArray(it)) {
      missing.push(`item ${i + 1}: not an object`);
      return;
    }
    const o = it as Record<string, unknown>;
    const graph = Array.isArray(o["@graph"]) ? (o["@graph"] as unknown[]) : null;
    if (!o["@context"]) missing.push(`item ${i + 1}: @context`);
    if (graph) {
      for (const g of graph) if (g && typeof g === "object") addTypes(g as Record<string, unknown>);
      if (!graph.some((g) => g && typeof g === "object" && (g as Record<string, unknown>)["@type"])) missing.push(`item ${i + 1}: @type in @graph`);
    } else {
      if (!o["@type"]) missing.push(`item ${i + 1}: @type`);
      addTypes(o);
    }
  });
  return { valid: true, error: null, types, missing: missing.slice(0, 10) };
}

const clean = (s: string | undefined | null, max = LIMITS.text): string =>
  (s ?? "")
     
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function insideSvg(el: HTMLElement): boolean {
  let p = el.parentNode as HTMLElement | null;
  while (p) {
    if (p.rawTagName?.toLowerCase() === "svg") return true;
    p = p.parentNode as HTMLElement | null;
  }
  return false;
}

export function parseHtml(html: string, pageUrl: string, isInternal: (url: string) => boolean): ParsedHtml {
  const root = parse(html, {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: { script: false, style: false, noscript: false, template: false, pre: true },
  });

  const baseHref = root.querySelector("base[href]")?.getAttribute("href");
  let base = pageUrl;
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).href;
    } catch {
      /* keep page URL */
    }
  }

  const titles = root.querySelectorAll("title").filter((t) => !insideSvg(t));
  const title = titles.length ? clean(titles[0].text, 300) : null;

  const metas = root.querySelectorAll("meta");
  const descMetas = metas.filter((m) => (m.getAttribute("name") ?? "").toLowerCase() === "description");
  const metaDescription = descMetas.length ? clean(descMetas[0].getAttribute("content"), 500) : null;
  const robotsMetas = metas.filter((m) => ["robots", "sitelensai"].includes((m.getAttribute("name") ?? "").toLowerCase()));
  const robotsMeta = robotsMetas.length ? clean(robotsMetas.map((m) => m.getAttribute("content") ?? "").join(", "), 200).toLowerCase() : null;

  const canonEls = root.querySelectorAll("link[rel]").filter((l) => (l.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const canonicalRaw = canonEls.length ? clean(canonEls[0].getAttribute("href"), 500) : null;
  let canonical: string | null = null;
  if (canonicalRaw) {
    const r = resolveHref(canonicalRaw, base);
    canonical = r.kind === "http" ? r.url : null;
  }

  const headingEls = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  const headings: HeadingInfo[] = headingEls.slice(0, LIMITS.headings).map((h) => ({ level: Number(h.rawTagName.slice(1)), text: clean(h.text, 160) }));
  const h1 = headingEls.filter((h) => h.rawTagName.toLowerCase() === "h1").map((h) => clean(h.text, 160));

  const links: PageLink[] = [];
  const invalidLinks: string[] = [];
  const seenLinks = new Set<string>();
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const r = resolveHref(href, base);
    if (r.kind === "ignored") continue;
    if (r.kind === "invalid") {
      if (invalidLinks.length < 20) invalidLinks.push(r.raw);
      continue;
    }
    const internal = isInternal(r.url);
    if (internal) internalLinkCount++;
    else externalLinkCount++;
    if (seenLinks.has(r.url) || links.length >= LIMITS.links) continue;
    seenLinks.add(r.url);
    const rel = (a.getAttribute("rel") ?? "").toLowerCase();
    links.push({ url: r.url, internal, text: clean(a.text || a.getAttribute("aria-label") || a.getAttribute("title"), 100), nofollow: /\bnofollow\b/.test(rel) });
  }

  const imgEls = root.querySelectorAll("img");
  const images: PageImage[] = [];
  let imagesMissingAlt = 0;
  for (const img of imgEls) {
    const hasAlt = img.hasAttribute("alt");
    if (!hasAlt) imagesMissingAlt++;
    if (images.length >= LIMITS.images) continue;
    const srcRaw = img.getAttribute("src") ?? "";
    let src: string | null = null;
    if (srcRaw && !srcRaw.trim().toLowerCase().startsWith("data:")) {
      const r = resolveHref(srcRaw, base);
      src = r.kind === "http" ? r.url : null;
    }
    images.push({ src, hasAlt, alt: hasAlt ? clean(img.getAttribute("alt"), 150) : null });
  }

  const mixedContent: string[] = [];
  if (pageUrl.startsWith("https:")) {
    const candidates: Array<[string, string]> = [
      ["img[src]", "src"],
      ["script[src]", "src"],
      ["iframe[src]", "src"],
      ["source[src]", "src"],
      ["video[src]", "src"],
      ["audio[src]", "src"],
      ["embed[src]", "src"],
    ];
    for (const [sel, attr] of candidates) {
      for (const el of root.querySelectorAll(sel)) {
        const v = (el.getAttribute(attr) ?? "").trim();
        if (/^http:\/\//i.test(v) && mixedContent.length < LIMITS.mixed) mixedContent.push(v.slice(0, 300));
      }
    }
    for (const l of root.querySelectorAll("link[href]")) {
      const rel = (l.getAttribute("rel") ?? "").toLowerCase();
      const v = (l.getAttribute("href") ?? "").trim();
      if (/stylesheet|icon|preload/.test(rel) && /^http:\/\//i.test(v) && mixedContent.length < LIMITS.mixed) mixedContent.push(v.slice(0, 300));
    }
  }

  const jsonLd: JsonLdInfo[] = [];
  for (const m of html.matchAll(JSON_LD_RE)) {
    if (jsonLd.length >= LIMITS.jsonLd) break;
    jsonLd.push(inspectJsonLd(m[1] ?? ""));
  }

  const social: Record<string, string> = {};
  for (const m of metas) {
    const key = ((m.getAttribute("property") ?? m.getAttribute("name") ?? "") as string).trim().toLowerCase();
    if (!/^(og|twitter):[a-z_:]+$/.test(key) || key in social || Object.keys(social).length >= LIMITS.social) continue;
    social[key] = clean(m.getAttribute("content"), 500);
  }

  const hreflang: HreflangInfo[] = [];
  for (const l of root.querySelectorAll("link[hreflang]")) {
    if (hreflang.length >= LIMITS.hreflang) break;
    if (!(l.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")) continue;
    const raw = clean(l.getAttribute("href"), 500);
    const r = raw ? resolveHref(raw, base) : null;
    hreflang.push({ lang: clean(l.getAttribute("hreflang"), 40), href: r && r.kind === "http" ? r.url : null, raw });
  }

  const viewportMeta = metas.find((m) => (m.getAttribute("name") ?? "").toLowerCase() === "viewport");
  const body = root.querySelector("body") ?? root;
  const bodyText = body.structuredText.replace(/\s+/g, " ").trim();
  const words = bodyText ? bodyText.split(" ").length : 0;
  const contentHash = words >= 50 ? createHash("sha256").update(bodyText.toLowerCase()).digest("hex") : null;

  const htmlEl = root.querySelector("html");
  return {
    title,
    titleCount: titles.length,
    metaDescription,
    metaDescriptionCount: descMetas.length,
    h1,
    headings,
    canonicalRaw,
    canonical,
    canonicalCount: canonEls.length,
    robotsMeta,
    lang: htmlEl?.getAttribute("lang")?.slice(0, 20) ?? null,
    links,
    invalidLinks,
    internalLinkCount,
    externalLinkCount,
    images,
    imageCount: imgEls.length,
    imagesMissingAlt,
    mixedContent,
    jsonLd,
    social,
    hreflang,
    viewport: viewportMeta ? clean(viewportMeta.getAttribute("content"), 300) : null,
    wordCount: words,
    contentHash,
  };
}

export function isHtmlContentType(ct: string | null): boolean {
  if (!ct) return false;
  return /text\/html|application\/xhtml\+xml/i.test(ct);
}
