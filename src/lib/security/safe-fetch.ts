import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import zlib from "node:zlib";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isPublicIp } from "./ip";
import { checkHostname, effectivePort, hostWithoutBrackets, normalizeUrl, validatePublicUrl, validateRedirectTarget } from "./url";

/**
 * SSRF-hardened HTTP client used for every outbound request made on behalf of
 * a user (pages, robots.txt, sitemaps, link checks).
 *
 * Defences:
 *  1. Syntactic validation of every URL (scheme, credentials, host, port).
 *  2. DNS resolution happens inside the socket `lookup` hook, and EVERY
 *     resolved address must be public. The validated address is the one the
 *     socket connects to, which closes the DNS-rebinding TOCTOU window.
 *  3. Redirects are never followed automatically: each Location is resolved,
 *     re-validated (steps 1–2) and counted against maxRedirects; loops are
 *     detected.
 *  4. Hard limits on total time per hop, decompressed body size and redirects.
 *  5. No connection pooling (agent: false), so sockets are never reused for a
 *     different validated destination.
 */

export type FetchErrorCode =
  | "invalid_url"
  | "unsafe_destination"
  | "dns_error"
  | "dns_temporary"
  | "connection_error"
  | "tls_error"
  | "timeout"
  | "too_many_redirects"
  | "redirect_loop"
  | "unsupported_redirect"
  | "protocol_error"
  | "aborted";

export interface FetchErrorInfo {
  code: FetchErrorCode;
  message: string;
}

export interface RedirectHop {
  url: string;
  status: number;
}

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  headers: Record<string, string>;
  body: Buffer | null;
  bodyTruncated: boolean;
  contentType: string | null;
  redirectChain: RedirectHop[];
  durationMs: number;
  attempts: number;
  error: FetchErrorInfo | null;
}

export type LookupFn = (hostname: string, options: LookupOptions & { all: true }, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  timeoutMs: number;
  maxBodyBytes: number;
  maxRedirects: number;
  userAgent: string;
  allowedPorts: number[];
  /** Do not read the body (link checks). Response is closed after headers. */
  skipBody?: boolean;
  accept?: string;
  /** Number of retries for transient failures (timeouts, resets, 502/503/504). */
  retries?: number;
  signal?: AbortSignal;
  /**
   * Address policy. Defaults to `isPublicIp`. Only tests inject a different
   * policy; it is intentionally not configurable through environment variables.
   */
  addressPolicy?: (ip: string) => boolean;
  /** DNS lookup implementation (tests inject a fake resolver). */
  lookup?: LookupFn;
}

class SafeFetchError extends Error {
  constructor(public code: FetchErrorCode, message: string) {
    super(message);
  }
}

const defaultLookup: LookupFn = (hostname, options, cb) => dns.lookup(hostname, options, cb);

function guardedLookup(policy: (ip: string) => boolean, lookupImpl: LookupFn) {
  return (hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    lookupImpl(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        const e: NodeJS.ErrnoException = new Error(`No addresses for ${hostname}`);
        e.code = "ENOTFOUND";
        return callback(e, "", 0);
      }
      // Reject if ANY resolved address is non-public (mixed answers are a rebinding signal).
      if (list.some((a) => !policy(a.address))) {
        const e: NodeJS.ErrnoException = new Error("Destination resolves to a non-public address");
        e.code = "ESITELENS_UNSAFE";
        return callback(e, "", 0);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function mapError(err: unknown): FetchErrorInfo {
  if (err instanceof SafeFetchError) return { code: err.code, message: err.message };
  const e = err as NodeJS.ErrnoException & { code?: string };
  const code = e?.code ?? "";
  if (code === "ESITELENS_UNSAFE") return { code: "unsafe_destination", message: "The destination resolves to a private or reserved network address and was not contacted." };
  if (code === "ENOTFOUND" || code === "ENODATA") return { code: "dns_error", message: "The domain name could not be resolved (DNS lookup failed)." };
  if (code === "EAI_AGAIN" || code === "ESERVFAIL") return { code: "dns_temporary", message: "DNS lookup failed temporarily." };
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return { code: "timeout", message: "The request timed out." };
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ECONNABORTED|EADDRNOTAVAIL)$/.test(code)) {
    return { code: "connection_error", message: `Connection failed (${code}).` };
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME_MISMATCH|ERR_SSL/i.test(code) || /certificate|ssl|tls/i.test(e?.message ?? "")) {
    return { code: "tls_error", message: "The TLS/SSL certificate could not be verified." };
  }
  if (/^HPE_|ERR_INVALID|ERR_HTTP/.test(code)) return { code: "protocol_error", message: "The server sent an invalid HTTP response." };
  if (e?.name === "AbortError" || code === "ABORT_ERR") return { code: "aborted", message: "The request was cancelled." };
  return { code: "connection_error", message: "The request failed." };
}

interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
  truncated: boolean;
}

function flattenHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function requestHop(url: URL, opts: SafeFetchOptions, method: "GET" | "HEAD"): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: hostWithoutBrackets(url.hostname),
        port: effectivePort(url),
        path: `${url.pathname || "/"}${url.search}`,
        method,
        agent: false,
        lookup: guardedLookup(opts.addressPolicy ?? isPublicIp, opts.lookup ?? defaultLookup) as never,
        headers: {
          "User-Agent": opts.userAgent,
          Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en;q=0.9,*;q=0.5",
          Connection: "close",
        },
      },
      (res) => {
        const headers = flattenHeaders(res.headers);
        const status = res.statusCode ?? 0;
        const isRedirect = status >= 300 && status < 400 && !!headers.location;
        if (method === "HEAD" || opts.skipBody || isRedirect) {
          res.destroy();
          return done(() => resolve({ status, headers, body: null, truncated: false }));
        }
        const encoding = (headers["content-encoding"] ?? "").toLowerCase().trim();
        let stream: NodeJS.ReadableStream = res;
        if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
        else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > opts.maxBodyBytes) {
            const keep = chunk.length - (size - opts.maxBodyBytes);
            if (keep > 0) chunks.push(chunk.subarray(0, keep));
            truncated = true;
            res.destroy();
            done(() => resolve({ status, headers, body: Buffer.concat(chunks), truncated: true }));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => done(() => resolve({ status, headers, body: Buffer.concat(chunks), truncated })));
        stream.on("error", (err) => {
          // A decompression error after some data still yields partial content.
          if (chunks.length > 0) done(() => resolve({ status, headers, body: Buffer.concat(chunks), truncated: true }));
          else done(() => reject(err));
        });
        res.on("error", (err) => done(() => reject(err)));
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new SafeFetchError("timeout", `The request timed out after ${opts.timeoutMs} ms.`)));
    }, opts.timeoutMs);
    const onAbort = () => {
      req.destroy();
      done(() => reject(new SafeFetchError("aborted", "The request was cancelled.")));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err) => done(() => reject(err)));
    req.end();
  });
}

const TRANSIENT_CODES: FetchErrorCode[] = ["timeout", "connection_error", "dns_temporary"];
const TRANSIENT_STATUS = new Set([502, 503, 504]);

async function fetchOnce(rawUrl: string, opts: SafeFetchOptions): Promise<Omit<SafeFetchResult, "attempts">> {
  const started = Date.now();
  const method = opts.method ?? "GET";
  const chain: RedirectHop[] = [];
  const seen = new Set<string>();
  const first = validatePublicUrl(rawUrl, { allowedPorts: opts.allowedPorts, assumeHttps: false });
  const base: Omit<SafeFetchResult, "attempts"> = {
    requestedUrl: rawUrl,
    finalUrl: rawUrl,
    status: null,
    headers: {},
    body: null,
    bodyTruncated: false,
    contentType: null,
    redirectChain: chain,
    durationMs: 0,
    error: null,
  };
  if (!first.ok) {
    const code: FetchErrorCode = first.reason === "private_address" || first.reason === "blocked_host" || first.reason === "port_not_allowed" ? "unsafe_destination" : "invalid_url";
    return { ...base, error: { code, message: first.message }, durationMs: Date.now() - started };
  }
  let current = first.url;
  seen.add(normalizeUrl(current));
  for (let hop = 0; ; hop++) {
    // Re-check the hostname immediately before connecting (defence in depth;
    // DNS-level checks happen inside the socket lookup hook).
    const hc = checkHostname(current.hostname);
    if (!hc.ok) return { ...base, finalUrl: current.href, error: { code: "unsafe_destination", message: hc.message }, durationMs: Date.now() - started };
    let res: HopResult;
    try {
      res = await requestHop(current, opts, method);
    } catch (err) {
      return { ...base, finalUrl: current.href, error: mapError(err), durationMs: Date.now() - started };
    }
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      chain.push({ url: current.href, status: res.status });
      if (hop + 1 > opts.maxRedirects) {
        return { ...base, finalUrl: current.href, status: res.status, headers: res.headers, error: { code: "too_many_redirects", message: `More than ${opts.maxRedirects} redirects.` }, durationMs: Date.now() - started };
      }
      const next = validateRedirectTarget(current.href, location, opts.allowedPorts);
      if (!next.ok) {
        const code: FetchErrorCode = next.reason === "unsupported_scheme" || next.reason === "malformed" ? "unsupported_redirect" : "unsafe_destination";
        return { ...base, finalUrl: current.href, status: res.status, headers: res.headers, error: { code, message: `Redirect blocked: ${next.message}` }, durationMs: Date.now() - started };
      }
      const key = normalizeUrl(next.url);
      if (seen.has(key)) {
        return { ...base, finalUrl: next.url.href, status: res.status, headers: res.headers, error: { code: "redirect_loop", message: "The redirect chain loops back to a URL it already visited." }, durationMs: Date.now() - started };
      }
      seen.add(key);
      current = next.url;
      continue;
    }
    return {
      ...base,
      finalUrl: current.href,
      status: res.status,
      headers: res.headers,
      body: res.body,
      bodyTruncated: res.truncated,
      contentType: res.headers["content-type"] ?? null,
      durationMs: Date.now() - started,
    };
  }
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const retries = Math.max(0, opts.retries ?? 0);
  let attempt = 0;
  let result: Omit<SafeFetchResult, "attempts">;
  for (;;) {
    attempt++;
    result = await fetchOnce(rawUrl, opts);
    const transient = (result.error && TRANSIENT_CODES.includes(result.error.code)) || (result.status !== null && TRANSIENT_STATUS.has(result.status));
    if (!transient || attempt > retries || opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  return { ...result, attempts: attempt };
}

/**
 * Resolves a hostname and verifies all addresses are public. Used to give
 * users a fast, clear error before a scan is queued. (Connection-time checks
 * in safeFetch remain authoritative.)
 */
export async function resolvePublicHost(hostname: string, lookupImpl: LookupFn = defaultLookup): Promise<{ ok: true; addresses: string[] } | { ok: false; code: "dns_error" | "unsafe_destination"; message: string }> {
  const host = hostWithoutBrackets(hostname);
  const hc = checkHostname(host);
  if (!hc.ok) return { ok: false, code: "unsafe_destination", message: hc.message };
  if (isPublicIp(host)) return { ok: true, addresses: [host] };
  return new Promise((resolve) => {
    lookupImpl(host, { all: true }, (err, addresses) => {
      if (err || !addresses?.length) return resolve({ ok: false, code: "dns_error", message: "The domain name could not be resolved. Check the spelling and try again." });
      if (addresses.some((a) => !isPublicIp(a.address))) {
        return resolve({ ok: false, code: "unsafe_destination", message: "This domain resolves to a private or reserved network address and cannot be scanned." });
      }
      resolve({ ok: true, addresses: addresses.map((a) => a.address) });
    });
  });
}

/** Decodes a response body using the declared charset (falls back to UTF-8). */
export function decodeBody(body: Buffer, contentType: string | null): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
  if (!charset) {
    const head = body.subarray(0, 2048).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
