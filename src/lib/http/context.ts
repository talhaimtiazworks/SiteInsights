import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getAuthState, type AuthUser } from "../auth/server";
import { assertAuditAccount } from "../auth/audit-policy";
import { getConfig } from "../config/env";
import { ApiError } from "./api";
import { rateLimit } from "./rate-limit";

export { PRINCIPAL_COOKIE, NEW_PRINCIPAL_HEADER } from "./session";
import { NEW_PRINCIPAL_HEADER, PRINCIPAL_COOKIE, principalCookieOptions, UUID_RE } from "./session";

/** Header carrying a scan access key (capability issued to the browser that started the scan). */
export const SCAN_KEY_HEADER = "x-scan-key";
const SCAN_KEY_RE = /^sk_[A-Za-z0-9_-]{43}$/;

export interface RequestContext {
  /** Who owns what this request creates: "user:<uuid>" when signed in, else the anonymous browser ID. */
  principalId: string;
  /** This browser's anonymous ID (audits started before signing in belong to it). */
  anonymousPrincipalId: string;
  ipHash: string;
  /** True when this request arrived without any session (a new anonymous cookie was just issued). */
  isNewPrincipal: boolean;
  /** Optional scan access key supplied by the client. */
  scanKey: string | null;
  /** Signed-in user, validated server-side (null when anonymous). */
  user: AuthUser | null;
  /** "disabled" = accounts not configured on this deployment. */
  auth: "disabled" | "anonymous" | "expired" | "signed_in";
}

export function clientIp(headers: Headers): string {
  const candidates = [headers.get("x-vercel-forwarded-for"), headers.get("x-real-ip"), headers.get("x-forwarded-for")];
  for (const c of candidates) {
    const first = c?.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return "unknown";
}

export function hashIp(ip: string, secret: string | null): string {
  return createHmac("sha256", secret ?? "sitelens-ai-default-ip-salt").update(ip).digest("hex").slice(0, 32);
}

/**
 * Identifies the caller: a signed-in Supabase user (session validated on the
 * server) or an anonymous principal (random 128-bit ID in an HttpOnly,
 * SameSite=Lax cookie), plus a salted hash of their IP address.
 * Raw IP addresses are never stored. Owner and plan never come from the client.
 */
export async function getRequestContext(req: NextRequest): Promise<RequestContext> {
  const store = await cookies();
  let id = store.get(PRINCIPAL_COOKIE)?.value;
  // proxy.ts issues the cookie before the request reaches us and flags it.
  let isNew = req.headers.get(NEW_PRINCIPAL_HEADER) === "1";
  if (!id || !UUID_RE.test(id)) {
    // Fallback (e.g. proxy not matched): issue the cookie here.
    id = randomUUID();
    isNew = true;
    store.set(PRINCIPAL_COOKIE, id, principalCookieOptions(req));
  }
  const rawKey = req.headers.get(SCAN_KEY_HEADER)?.trim() ?? "";
  const auth = await getAuthState(req);
  const user = auth.status === "signed_in" ? auth.user : null;
  return {
    principalId: user ? `user:${user.id}` : id,
    anonymousPrincipalId: id,
    ipHash: hashIp(clientIp(req.headers), getConfig().sessionSecret),
    isNewPrincipal: user ? false : isNew,
    scanKey: SCAN_KEY_RE.test(rawKey) ? rawKey : null,
    user,
    auth: auth.status,
  };
}

/** Mandatory gate for all public audit execution, history, report and mutation endpoints. */
export async function getAuditContext(req: NextRequest): Promise<RequestContext & { user: AuthUser; auth: "signed_in" }> {
  const ctx = await getRequestContext(req);
  assertAuditAccount(ctx);
  return ctx as RequestContext & { user: AuthUser; auth: "signed_in" };
}

/** Applies the general per-IP API throttle and, optionally, a stricter per-route limit. */
export function throttle(req: NextRequest, ctx: RequestContext, routeKey?: string, routeLimitPerMinute?: number) {
  const cfg = getConfig();
  const general = rateLimit(`api:${ctx.ipHash}`, cfg.usage.apiRequestsPerMinute, 60_000);
  if (!general.ok) throw new ApiError(429, "too_many_requests", "Too many requests. Please slow down.", { retryAfterSeconds: general.retryAfterSeconds });
  if (routeKey && routeLimitPerMinute) {
    const r = rateLimit(`${routeKey}:${ctx.ipHash}`, routeLimitPerMinute, 60_000);
    if (!r.ok) throw new ApiError(429, "too_many_requests", "Too many requests for this action. Please wait a moment.", { retryAfterSeconds: r.retryAfterSeconds });
  }
}
