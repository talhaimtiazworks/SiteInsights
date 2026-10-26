import "server-only";
import { ApiError } from "../http/api";
import { UUID_RE } from "../http/session";

/** A context is built only by server-side session verification, never request JSON/headers. */
export interface AuditIdentity {
  principalId: string;
  auth?: string;
  user?: { id: string } | null;
}

/** Fail closed even when Auth is unconfigured or a legacy anonymous-audit flag is set. */
export function assertAuditAccount(ctx: AuditIdentity): asserts ctx is AuditIdentity & { auth: "signed_in"; user: { id: string } } {
  if (ctx.auth === "signed_in" && ctx.user && UUID_RE.test(ctx.user.id) && ctx.principalId === `user:${ctx.user.id}`) return;
  const expired = ctx.auth === "expired";
  throw new ApiError(401, expired ? "session_expired" : "auth_required", expired ? "Your session has expired. Please sign in again before running an audit." : "Sign in or create an account to run audits and access your reports.");
}

/** Only account-owned jobs may be executed, including by the trusted cron processor. */
export function isAccountPrincipal(principalId: string): boolean {
  return principalId.startsWith("user:") && UUID_RE.test(principalId.slice(5));
}

/** Applied AFTER Supabase verifies the signature. Anonymous Supabase users are not accounts. */
export function isAccountClaims(claims: Record<string, unknown> | undefined): claims is Record<string, unknown> & { sub: string } {
  return !!claims && typeof claims.sub === "string" && UUID_RE.test(claims.sub) && claims.role === "authenticated" && claims.is_anonymous !== true && typeof claims.exp === "number" && claims.exp > Math.floor(Date.now() / 1000);
}
