import "server-only";
import { applyPendingAuth } from "../auth/pending";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { AIProviderError } from "../ai/errors";
import { AccountsNeedDatabaseError, StorageNotConfiguredError } from "../db";
import { classifyDatabaseError, DatabaseProblemError, PROBLEMS } from "../db/errors";
import { logger } from "../logger";

/**
 * Consistent API envelope:
 *   success → { ok: true, data }
 *   error   → { ok: false, error: { code, message, details? } }
 * Stack traces and internal details are never returned to clients.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export function ok<T>(data: T, init?: { status?: number; headers?: Record<string, string> }) {
  return NextResponse.json({ ok: true, data }, { status: init?.status ?? 200, headers: { "Cache-Control": "no-store", ...init?.headers } });
}

export function fail(status: number, code: string, message: string, details?: Record<string, unknown>, headers?: Record<string, string>) {
  return NextResponse.json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

const AI_STATUS: Record<string, number> = {
  not_configured: 503,
  auth_failed: 502,
  rate_limited: 429,
  quota_exhausted: 503,
  timeout: 504,
  invalid_response: 502,
  model_not_found: 502,
  content_blocked: 422,
  bad_request: 502,
  provider_unavailable: 503,
  network_error: 502,
};

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) return fail(err.status, err.code, err.message, err.details);
  if (err instanceof ZodError) {
    return fail(400, "validation_error", "The request is invalid.", { issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  if (err instanceof DatabaseProblemError) {
    // Already logged with the operator hint where it was classified.
    const info = PROBLEMS[err.problem];
    return fail(info.status, err.problem, info.message, undefined, info.retryable ? { "Retry-After": "5" } : undefined);
  }
  if (err instanceof StorageNotConfiguredError) {
    return fail(503, "storage_not_configured", "This deployment has no database configured, so audits can't be saved. The site operator needs to connect Supabase (POSTGRES_URL) or set DATABASE_URL.");
  }
  if (err instanceof AccountsNeedDatabaseError) {
    return fail(503, "accounts_need_database", "Accounts need a PostgreSQL database. The site operator needs to connect Supabase or set DATABASE_URL.");
  }
  if (err instanceof AIProviderError) {
    return fail(AI_STATUS[err.code] ?? 502, `ai_${err.code}`, err.message, { provider: err.provider });
  }
  // A raw database error that escaped the query layer (e.g. inside a transaction): classify it anyway.
  const problem = classifyDatabaseError(err);
  if (problem) {
    const info = PROBLEMS[problem];
    logger.error(`Database error (${problem}). ${info.hint}`, err);
    return fail(info.status, problem, info.message, undefined, info.retryable ? { "Retry-After": "5" } : undefined);
  }
  // A genuine bug. The reference lets the operator find the matching (redacted) log entry.
  const ref = randomUUID().slice(0, 8);
  logger.error(`Unhandled API error [ref ${ref}]`, err);
  return fail(500, "internal_error", `Something went wrong on our side. Please try again. (Reference: ${ref})`, { ref });
}

export function route<C>(handler: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (err) {
      res = errorResponse(err);
    }
    // Session cookies refreshed or changed while handling this request.
    return applyPendingAuth(req, res);
  };
}

/** Read a request body with a streaming byte limit (Content-Length is only an early hint). */
export async function readBodyText(req: Request, maxBytes = 16_384): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new ApiError(413, "payload_too_large", "The request body is too large.");
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ApiError(413, "payload_too_large", "The request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* A cancelled stream may already be released. */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function readJson(req: NextRequest, maxBytes = 16_384): Promise<unknown> {
  const text = await readBodyText(req, maxBytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body must be valid JSON.");
  }
}

/** Basic CSRF defence for state-changing requests (in addition to SameSite=Lax cookies). */
export function assertSameOrigin(req: NextRequest, appUrl: string | null) {
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients; cookies are SameSite=Lax
  // Browsers set Sec-Fetch-Site themselves (pages cannot forge it). This keeps
  // same-origin requests working behind proxies that rewrite the Host header.
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin") return;
  if (site === "cross-site" || site === "same-site") throw new ApiError(403, "forbidden_origin", "Cross-origin requests are not allowed.");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "forbidden_origin", "Cross-origin requests are not allowed.");
  }
  const allowed = new Set<string>();
  const host = req.headers.get("host");
  const fwd = req.headers.get("x-forwarded-host");
  if (host) allowed.add(host);
  if (fwd) for (const h of fwd.split(",")) allowed.add(h.trim());
  if (appUrl) allowed.add(new URL(appUrl).host);
  allowed.add(req.nextUrl.host);
  if (!allowed.has(originHost)) throw new ApiError(403, "forbidden_origin", "Cross-origin requests are not allowed.");
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertScanId(id: string) {
  if (!ID_RE.test(id)) throw new ApiError(404, "not_found", "Audit not found.");
}

/** Optional client-supplied Idempotency-Key header (8–64 URL-safe characters). */
export function readIdempotencyKey(req: Request): string | null {
  const idem = req.headers.get("idempotency-key");
  if (idem !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(idem)) {
    throw new ApiError(400, "invalid_idempotency_key", "The Idempotency-Key header must be 8–64 letters, digits, '-' or '_'.");
  }
  return idem;
}
