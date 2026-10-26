/**
 * Crawl-frontier helpers: filters that keep the crawler away from non-HTML
 * resources, authentication/transactional areas and infinite URL spaces
 * (calendars, faceted navigation, session IDs, sort orders …).
 */

const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|avif|heic|mp4|m4v|mp3|wav|ogg|webm|mov|avi|wmv|flv|zip|gz|tgz|bz2|rar|7z|tar|exe|dmg|msi|pkg|deb|rpm|apk|iso|bin|css|js|mjs|map|json|xml|rss|atom|txt|csv|tsv|xlsx?|docx?|pptx?|odt|ods|rtf|epub|woff2?|ttf|eot|otf|swf)$/i;

const PROTECTED_PATH = /(^|\/)(wp-admin|wp-login\.php|xmlrpc\.php|login|log-in|signin|sign-in|logout|log-out|signout|sign-out|register|signup|sign-up|cart|basket|checkout|my-account|account|admin|administrator|user\/login|user\/register|auth|oauth|sso|cgi-bin|password-reset|reset-password)(\/|$|\?|\.)/i;

const TRAP_PARAMS = /^(sort|sortby|sort_by|order|orderby|order_by|dir|direction|filter|filters|facet|facets|view|layout|sessionid|session_id|sid|phpsessid|jsessionid|aspsessionid|replytocom|share|print|calendar|ical|month|year|date|day|week|time|add-to-cart|add_to_cart|add-to-wishlist|action|redirect|redirect_to|redirect_uri|return|returnurl|return_url|returnto|next|lang_switch|currency|q|s|search|query)$/i;

const MAX_URL_LENGTH = 400;
const MAX_QUERY_PARAMS = 3;
const MAX_PATH_SEGMENTS = 12;

export type CrawlDecision = { ok: true; variantKey: string | null } | { ok: false; reason: "trap" | "non_html" | "protected" };

export function evaluateCrawlCandidate(rawUrl: string, queryVariantCounts: Record<string, number>, maxQueryVariantsPerPath: number): CrawlDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "trap" };
  }
  if (rawUrl.length > MAX_URL_LENGTH) return { ok: false, reason: "trap" };
  if (NON_HTML_EXT.test(url.pathname)) return { ok: false, reason: "non_html" };
  if (PROTECTED_PATH.test(url.pathname)) return { ok: false, reason: "protected" };

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length > MAX_PATH_SEGMENTS) return { ok: false, reason: "trap" };
  const counts = new Map<string, number>();
  for (const s of segments) {
    const c = (counts.get(s) ?? 0) + 1;
    if (c >= 3) return { ok: false, reason: "trap" }; // /a/b/a/b/a/… loops
    counts.set(s, c);
  }

  const keys = [...url.searchParams.keys()];
  if (keys.length > 0) {
    if (keys.length > MAX_QUERY_PARAMS) return { ok: false, reason: "trap" };
    if (keys.some((k) => TRAP_PARAMS.test(k))) return { ok: false, reason: "trap" };
    const variantKey = `${url.host}${url.pathname}`;
    if ((queryVariantCounts[variantKey] ?? 0) >= maxQueryVariantsPerPath) return { ok: false, reason: "trap" };
    return { ok: true, variantKey };
  }
  return { ok: true, variantKey: null };
}

export function looksLikeHtmlPath(rawUrl: string): boolean {
  try {
    return !NON_HTML_EXT.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}
