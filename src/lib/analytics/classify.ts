/**
 * Pure analytics classification: traffic-source attribution, device/browser/OS
 * bucketing from a User-Agent string, and path/query sanitization.
 *
 * No network, no logging side effects — fully unit-testable.
 *
 * Documented attribution rules (checked in order):
 *   1. A missing referrer → "direct" (typed URL / bookmark / app). UTM values
 *      without a referrer still classify by their medium (see 2/3/4).
 *   2. utm_source present (any grouping where the medium is social or the
 *      source is a known social host) → "social".
 *   3. utm_source/medium present otherwise → "campaign".
 *   4. A referrer host matching a known search engine → "search".
 *   5. Any other external referrer → "referral".
 *   6. Otherwise / referrer equals our own host → "direct".
 *
 * A page's first contact in a session (landing) carries the attribution; the
 * dashboard aggregates events under these categories — events without usable
 * attribution stay under their "direct"/"referral" outcome so nothing is
 * silently dropped.
 */

export type TrafficSource = "direct" | "search" | "social" | "referral" | "campaign" | "other";
export type DeviceCategory = "desktop" | "mobile" | "tablet" | "unknown";

const SEARCH_HOSTS = new Set(["google", "bing", "duckduckgo", "brave", "yahoo", "yandex", "baidu", "ecosia", "startpage", "qwant", "mojeek"]);
const SOCIAL_HOSTS = new Set(["facebook", "twitter", "x", "instagram", "linkedin", "threads", "pinterest", "tiktok", "youtube", "snapchat", "reddit", "whatsapp", "telegram", "t", "m"]);

/** Extracts the registrable core of a hostname ("blog.acme.co.uk" → "acme.co.uk"). A heuristic — sufficient for bucketing display. */
function registrable(host: string): string {
  const h = host.toLowerCase();
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return h;
  const sld = parts[parts.length - 2];
  // Treat well-known two-part TLD endings as one segment (co.uk, com.au, …).
  const twoPartTld = parts[parts.length - 1].length === 2 && parts.length >= 3 && sld.length <= 3;
  return parts.slice(twoPartTld ? -3 : -2).join(".");
}

export function classifySource(opts: { referrerHost: string | null; ownHost?: string | null; utmSource?: string | null; utmMedium?: string | null }): TrafficSource {
  const ref = opts.referrerHost?.toLowerCase() ?? null;
  const utmSource = opts.utmSource?.toLowerCase().slice(0, 100) ?? null;
  const utmMedium = opts.utmMedium?.toLowerCase().slice(0, 100) ?? null;

  if (ref && opts.ownHost && ref === opts.ownHost) return "direct"; // internal navigation is not a source

  if (utmSource || utmMedium) {
    if (utmMedium === "social" || (utmSource && SOCIAL_HOSTS.has(utmSource.split(".")[0]))) return "social";
    return "campaign";
  }
  if (!ref) return "direct";

  const core = registrable(ref);
  const first = core.split(".")[0];
  if (SEARCH_HOSTS.has(first)) return "search";
  if (SOCIAL_HOSTS.has(first)) return "social";
  return "referral";
}

/** UA device bucketing: tablet first (iPad/Android tablets), then mobile, then desktop. */
export function uaDevice(ua: string): DeviceCategory {
  if (!ua) return "unknown";
  const s = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|kindle/.test(s)) return "tablet";
  if (/android/.test(s)) return /mobile/.test(s) ? "mobile" : "tablet";
  if (/mobi|iphone|ipod|windows phone|blackberry|opera mini/.test(s)) return "mobile";
  if (/mozilla|chrome|safari|firefox|edge|vivaldi|opera/.test(s)) return "desktop";
  return "unknown";
}

/** High-level browser family for reporting. */
export function uaBrowser(ua: string): string {
  const s = ua.toLowerCase();
  if (!s) return "unknown";
  if (/edg\//.test(s)) return "edge";
  if (/opr\/|opera/.test(s)) return "opera";
  if (/samsungbrowser/.test(s)) return "samsung-internet";
  if (/chrome\/|crios\//.test(s)) return "chrome";
  if (/fxios\/|firefox\//.test(s)) return "firefox";
  if (/version\/.*safari|safari\//.test(s) && !/chrome/.test(s)) return "safari";
  return "other";
}

/** High-level OS family for reporting. */
export function uaOs(ua: string): string {
  const s = ua.toLowerCase();
  if (!s) return "unknown";
  if (/windows/.test(s)) return "windows";
  if (/android/.test(s)) return "android";
  if (/iphone|ipad|ipod/.test(s)) return "ios";
  if (/mac os x|macintosh/.test(s)) return "macos";
  if (/cros/.test(s)) return "chromeos";
  if (/linux/.test(s)) return "linux";
  return "other";
}

/**
 * Route for analytics purposes: path only, normalized trailing slash, capped
 * at 200 chars. Everything after ? or # is discarded (queries may carry
 * tokens); admin/API/auth machinery routes are not tracked at all.
 */
export const TRACK_EXCLUDE_PREFIXES = ["/api", "/admin", "/auth", "/_next", "/r/", "/favicon", "/manifest", "/robots", "/sitemap", "/sign-in", "/sign-up", "/account", "/settings"];

export function sanitizePath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let p = raw.trim();
  if (!p.startsWith("/")) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  p = p.split(/[?#]/)[0];
  if (!/^\/[ -~]{0,199}$/.test(p)) return null; // printable ASCII only, bounded
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (/\.(ico|png|jpe?g|svg|webp|gif|txt|xml|json|css|js|map|webmanifest|woff2?)$/i.test(p)) return null; // asset-like
  // Prefix exclusions are path-SEGMENT aware: "/auth" excludes "/auth/x" but
  // never "/audit". (Over-matching here silently dropped real public pages.)
  if (TRACK_EXCLUDE_PREFIXES.some((x) => (x.endsWith("/") ? p.startsWith(x) : p === x || p.startsWith(x + "/")))) return null;
  return p.slice(0, 200);
}

/** Hostname of the referrer with caps; never contains userinfo or query fragments. */
export function sanitizeReferrerHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase();
    if (!/^[a-z0-9.-]{1,200}$/.test(host) || !host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

/** UTM parameters (source/medium/campaign only), lower-cased, bounded. Campaign names are stored as-is for the owner report. */
export function sanitizeUtm(searchParams: URLSearchParams | null): { source: string | null; medium: string | null; campaign: string | null } {
  if (!searchParams) return { source: null, medium: null, campaign: null };
  const get = (k: string) => {
    const v = searchParams.get(k)?.trim().toLowerCase() ?? "";
    return v && /^[\w.:/-]{1,64}$/.test(v) ? v : null;
  };
  return { source: get("utm_source"), medium: get("utm_medium"), campaign: get("utm_campaign") };
}
