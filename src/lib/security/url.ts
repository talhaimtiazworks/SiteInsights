import { isIpLiteral, isPublicIp } from "./ip";
import { normalizeUrl, parseHttpUrlInput } from "./url-input";
export { MAX_URL_LENGTH, normalizeUrl } from "./url-input";

/**
 * URL parsing, validation and normalisation.
 *
 * IMPORTANT: syntactic validation here is only the FIRST layer of SSRF
 * protection. Hostnames are additionally resolved and every resolved address
 * is validated at connection time by `safe-fetch.ts` (which also re-validates
 * every redirect hop). A regex or URL parse alone is not sufficient.
 */

export type UrlRejectReason =
  | "empty"
  | "too_long"
  | "malformed"
  | "unsupported_scheme"
  | "credentials_not_allowed"
  | "blocked_host"
  | "private_address"
  | "port_not_allowed";

export type UrlCheck =
  | { ok: true; url: URL; normalized: string }
  | { ok: false; reason: UrlRejectReason; message: string };

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data", "kubernetes", "kubernetes.default"]);
const OTHER_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

export function hostWithoutBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/** Checks hostname rules that do not require DNS. */
export function checkHostname(hostname: string): { ok: true } | { ok: false; reason: UrlRejectReason; message: string } {
  const host = hostWithoutBrackets(hostname.toLowerCase()).replace(/\.$/, "");
  if (!host) return { ok: false, reason: "malformed", message: "The URL has no hostname." };
  if (isIpLiteral(host)) {
    if (!isPublicIp(host)) {
      return { ok: false, reason: "private_address", message: "Private, loopback, link-local and reserved IP addresses cannot be scanned." };
    }
    return { ok: true };
  }
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "blocked_host", message: "Local and internal hostnames cannot be scanned." };
  }
  if (!host.includes(".")) {
    return { ok: false, reason: "blocked_host", message: "Single-label hostnames (for example intranet names) cannot be scanned. Use a public domain name." };
  }
  if (host.length > 253 || host.split(".").some((label) => label.length === 0 || label.length > 63)) {
    return { ok: false, reason: "malformed", message: "The hostname is not valid." };
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    // WHATWG URL converts IDNs to punycode, so anything else is malformed.
    return { ok: false, reason: "malformed", message: "The hostname contains invalid characters." };
  }
  return { ok: true };
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/**
 * Validates a URL that came from a user (or from a crawled page / redirect).
 * Accepts bare domains like "example.com" by assuming https.
 */
export function validatePublicUrl(raw: string, opts: { allowedPorts?: number[]; assumeHttps?: boolean } = {}): UrlCheck {
  const allowedPorts = opts.allowedPorts ?? [80, 443, 8080, 8443];
  const parsed = parseHttpUrlInput(raw, { assumeHttps: opts.assumeHttps });
  if (!parsed.ok) return parsed;
  const hostCheck = checkHostname(parsed.url.hostname);
  if (!hostCheck.ok) return hostCheck;
  const port = effectivePort(parsed.url);
  if (!allowedPorts.includes(port)) {
    return { ok: false, reason: "port_not_allowed", message: `Port ${port} is not allowed. Allowed ports: ${allowedPorts.join(", ")}.` };
  }
  return { ok: true, url: parsed.url, normalized: parsed.normalized };
}

/**
 * Resolves a redirect Location header against the current URL and validates
 * the destination with the same rules as user input (no scheme guessing).
 */
export function validateRedirectTarget(currentUrl: string, location: string, allowedPorts?: number[]): UrlCheck {
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    return { ok: false, reason: "malformed", message: "The redirect destination is not a valid URL." };
  }
  return validatePublicUrl(next.href, { allowedPorts, assumeHttps: false });
}

/** Resolves an href found in HTML. Returns null for non-navigable schemes. */
export function resolveHref(href: string, base: string): { kind: "http"; url: string } | { kind: "ignored"; scheme: string } | { kind: "invalid"; raw: string } {
  const h = href.trim();
  if (!h) return { kind: "ignored", scheme: "empty" };
  if (h.startsWith("#")) return { kind: "ignored", scheme: "fragment" };
  const m = OTHER_SCHEME.exec(h);
  if (m && !/^https?$/i.test(m[1])) return { kind: "ignored", scheme: m[1].toLowerCase() };
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "ignored", scheme: u.protocol.replace(":", "") };
    if (!u.hostname) return { kind: "invalid", raw: h.slice(0, 300) };
    return { kind: "http", url: normalizeUrl(u) };
  } catch {
    return { kind: "invalid", raw: h.slice(0, 300) };
  }
}

/** Treats example.com and www.example.com as the same site. */
export function sameSiteHost(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return strip(a) === strip(b);
}
