/** Lightweight, isomorphic parsing and normalization for user-entered HTTP(S) URLs. */

export const MAX_URL_LENGTH = 2048;

export type UrlInputRejectReason = "empty" | "too_long" | "malformed" | "unsupported_scheme" | "credentials_not_allowed";
export type UrlInputCheck =
  | { ok: true; url: URL; normalized: string }
  | { ok: false; reason: UrlInputRejectReason; message: string };

const TRACKING_PARAMS = /^(utm_[a-z_]+|gclid|dclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|igshid|ref_src)$/i;
const OTHER_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const HAS_HTTP_SCHEME = /^https?:\/\//i;
const DANGEROUS_SCHEMES = new Set(["javascript", "data", "file", "ftp", "ftps", "mailto", "vbscript", "blob", "about", "ws", "wss", "gopher", "tel", "sms", "chrome", "view-source", "dict", "ldap", "smb", "ssh", "sftp", "jar", "netdoc"]);

/**
 * Normalises a URL for de-duplication: lowercase scheme/host, remove fragments
 * and known tracking parameters, sort the remaining query, and keep a root slash.
 */
export function normalizeUrl(input: URL | string): string {
  const url = typeof input === "string" ? new URL(input) : new URL(input.href);
  url.hash = "";
  url.username = "";
  url.password = "";
  // Always rewrite the query: a bare "?" has search === "" but survives in href.
  const params = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.test(key));
  params.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = new URLSearchParams(params).toString();
  url.search = query ? `?${query}` : "";
  if (!url.pathname) url.pathname = "/";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return url.href;
}

/**
 * Parses a typed URL using the same scheme/normalization policy as the server.
 * Bare domains default to HTTPS. Host, port, public-IP and DNS safety remain
 * authoritative server checks in `validatePublicUrl`/`startScan`.
 */
export function parseHttpUrlInput(raw: string, opts: { assumeHttps?: boolean } = {}): UrlInputCheck {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, reason: "empty", message: "Enter a website URL." };
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: "too_long", message: "The URL is too long." };
  if (/[\u0000-\u001f\u007f\s]/.test(input)) return { ok: false, reason: "malformed", message: "The URL contains spaces or control characters." };

  let candidate = input;
  if (!HAS_HTTP_SCHEME.test(candidate)) {
    const match = OTHER_SCHEME.exec(candidate);
    if (match && (DANGEROUS_SCHEMES.has(match[1].toLowerCase()) || candidate.slice(match[0].length).startsWith("//"))) {
      return { ok: false, reason: "unsupported_scheme", message: "Only http:// and https:// URLs can be scanned." };
    }
    if (opts.assumeHttps === false) return { ok: false, reason: "malformed", message: "The URL must start with http:// or https://." };
    if (candidate.startsWith("//")) candidate = candidate.slice(2);
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "malformed", message: "That does not look like a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme", message: "Only http:// and https:// URLs can be scanned." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials_not_allowed", message: "URLs containing usernames or passwords are not allowed." };
  }
  if (!url.hostname) return { ok: false, reason: "malformed", message: "The URL has no hostname." };
  return { ok: true, url, normalized: normalizeUrl(url) };
}
