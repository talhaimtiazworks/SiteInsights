import type { SafeFetchResult } from "../security/safe-fetch";
import type { LinkCategory, LinkVerification } from "./types";

/**
 * Status codes that indicate the scanner was refused (bot protection,
 * authentication, rate limiting, geo/legal blocks). These are NOT reported as
 * broken links because a human visitor may well be able to open them.
 * 999 is used by some social networks for automated clients.
 */
export const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 451, 999]);

/** Statuses for which a HEAD response is unreliable and a GET retry is made. */
export const HEAD_FALLBACK_STATUSES = new Set([400, 401, 403, 404, 405, 406, 409, 410, 429, 500, 501, 502, 503, 999]);

export interface LinkClassification {
  category: LinkCategory;
  verification: LinkVerification;
  message: string;
}

export function classifyFetchResult(r: Pick<SafeFetchResult, "status" | "error" | "redirectChain">): LinkClassification {
  if (r.error) {
    switch (r.error.code) {
      case "invalid_url":
        return { category: "invalid_url", verification: "verified", message: r.error.message };
      case "unsafe_destination":
        return { category: "unsafe_destination", verification: "not_checked", message: "Points to a private or reserved address; not contacted for security reasons." };
      case "dns_error":
        return { category: "dns_error", verification: "verified", message: "The domain does not resolve (DNS lookup failed)." };
      case "dns_temporary":
        return { category: "inconclusive", verification: "inconclusive", message: "DNS lookup failed temporarily; could not verify." };
      case "timeout":
        return { category: "timeout", verification: "inconclusive", message: "The server did not respond in time." };
      case "tls_error":
        return { category: "tls_error", verification: "verified", message: "The TLS/SSL certificate could not be verified; browsers will show a security warning." };
      case "redirect_loop":
        return { category: "redirect_loop", verification: "verified", message: "The URL redirects in a loop." };
      case "too_many_redirects":
        return { category: "too_many_redirects", verification: "verified", message: r.error.message };
      case "unsupported_redirect":
        return { category: "inconclusive", verification: "inconclusive", message: r.error.message };
      case "connection_error":
      case "protocol_error":
        return { category: "connection_error", verification: "inconclusive", message: r.error.message };
      default:
        return { category: "inconclusive", verification: "inconclusive", message: r.error.message };
    }
  }
  const s = r.status;
  if (s === null) return { category: "inconclusive", verification: "inconclusive", message: "No HTTP status was obtained." };
  if (s >= 200 && s < 300) {
    if (r.redirectChain.length > 0) return { category: "redirect", verification: "verified", message: `Redirects (${r.redirectChain.length} hop${r.redirectChain.length > 1 ? "s" : ""}) to a working page.` };
    return { category: "ok", verification: "verified", message: `HTTP ${s}` };
  }
  if (s === 404 || s === 410) return { category: "not_found", verification: "verified", message: `HTTP ${s} ${s === 404 ? "Not Found" : "Gone"}` };
  if (BLOCKED_STATUSES.has(s)) return { category: "blocked", verification: "inconclusive", message: `HTTP ${s}: the server refused the automated request (may require login or block bots).` };
  if (s >= 500) return { category: "server_error", verification: "verified", message: `HTTP ${s} server error (confirmed after retry; may be temporary).` };
  if (s >= 400) return { category: "client_error", verification: "inconclusive", message: `HTTP ${s}: the server rejected the request; this may be specific to automated clients.` };
  if (s >= 300) return { category: "inconclusive", verification: "inconclusive", message: `HTTP ${s} without a usable redirect destination.` };
  return { category: "inconclusive", verification: "inconclusive", message: `Unexpected HTTP ${s}.` };
}
