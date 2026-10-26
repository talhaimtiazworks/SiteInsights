import "server-only";
import type { AuthUser } from "../auth/server";
import type { RequestContext } from "../http/context";
import { ApiError } from "../http/api";

/**
 * Private owner authorization — single-email administrator allowlist.
 *
 * The ONLY authorized administrator is the address below. There is no role
 * column, no public admin sign-in/sign-up, no role selector and no self-service
 * promotion path anywhere in the app: this module is the central, server-side
 * source of truth. Comparison rules:
 *   1. The identity comes from the server's verified Supabase session claims
 *      (validated by auth.getClaims() upstream) — never from request bodies,
 *      query params, headers, browser storage or client-supplied email.
 *   2. The email is normalized (trim + Unicode NFKC + lower-case) before the
 *      exact comparison, so case/whitespace variants cannot miss (and cannot
 *      be used to LOOK like the address for other addresses).
 *   3. Every check fails closed: missing identity, missing email, disabled
 *      accounts deployments, or any exception results in access denied.
 *
 * Ordinary users hitting protected resources receive honest 403 responses from
 * the APIs; the page route renders 404 (the address exists but is not
 * advertised — hiding is cosmetics, this module is the enforcement).
 */
export const ADMIN_ALLOWLIST: readonly string[] = ["talha.imtiaz2111@gmail.com"] as const;

/** Canonical form used for every email comparison in this module. */
export function normalizeEmail(raw: string): string {
  return raw.trim().normalize("NFKC").toLowerCase();
}

const ALLOWED = new Set(ADMIN_ALLOWLIST.map(normalizeEmail));

/** True when this verified user is the authorized owner. Pure and total — never throws. */
export function isAdminUser(user: Pick<AuthUser, "email"> | null | undefined): boolean {
  try {
    if (!user || typeof user.email !== "string") return false;
    return ALLOWED.has(normalizeEmail(user.email));
  } catch {
    return false; // fail closed on any normalization problem
  }
}

/** Page-level decision from an already-resolved server session. Never throws. */
export function isAdminContext(ctx: Pick<RequestContext, "user" | "auth">): boolean {
  try {
    return ctx.auth === "signed_in" && isAdminUser(ctx.user);
  } catch {
    return false;
  }
}

/**
 * API-level gate: requires a fully verified signed-in owner session.
 * 401 for missing/expired sessions, 403 for authenticated non-owners. Fails closed.
 */
export function requireAdmin(ctx: RequestContext): void {
  if (!ctx.user || ctx.auth !== "signed_in") {
    throw new ApiError(401, "sign_in_required", "Sign in is required for this resource.");
  }
  if (!isAdminUser(ctx.user)) {
    throw new ApiError(403, "forbidden", "You do not have access to this resource.");
  }
}
