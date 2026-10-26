import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { getConfig } from "../config/env";
import { ApiError } from "../http/api";
import { isHttps } from "../http/session";
import { logger } from "../logger";
import { pendingFor } from "./pending";
import { isAccountClaims } from "./audit-policy";
import { createSupabaseForRequest, hasAuthCookie } from "./ssr";
import { readSessionProviderMarker, type SessionProviderMarker, SESSION_PROVIDER_COOKIE } from "./session-provider";
import { trustedProviderAvatarUrl } from "../avatar";

export interface AuthUser {
  id: string;
  email: string | null;
  /** Existing session-method summary; OAuth provider values may describe the first linked provider, so they are not avatar evidence. */
  sessionMethod: string | null;
  /** All providers linked to the account (from app_metadata). */
  providers: string[];
  isSso: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}

export type AuthState =
  | { status: "disabled" }
  | { status: "anonymous" }
  /** Auth cookies were present but the session can no longer be validated or refreshed. */
  | { status: "expired" }
  | { status: "signed_in"; user: AuthUser };

const clients = new WeakMap<NextRequest, ReturnType<typeof createSupabaseForRequest>>();
const states = new WeakMap<NextRequest, Promise<AuthState>>();

export function authEnabled(): boolean {
  return getConfig().auth.supabase.authEnabled;
}

/** Supabase client bound to this request's cookies. Cookie writes are applied to the route's response. */
export function supabaseForRequest(req: NextRequest) {
  let c = clients.get(req);
  if (!c) {
    const pending = pendingFor(req);
    c = createSupabaseForRequest(
      getConfig().auth.supabase,
      {
        getAll: () => req.cookies.getAll().map(({ name, value }) => ({ name, value })),
        setAll: (cookies, headers) => {
          for (const k of cookies) {
            // Later writes of the same cookie win.
            pending.cookies = pending.cookies.filter((x) => x.name !== k.name);
            pending.cookies.push(k);
            // Keep the request view consistent for the rest of this handler.
            if (k.value) req.cookies.set(k.name, k.value);
            else req.cookies.delete(k.name);
          }
          Object.assign(pending.headers, headers);
        },
      },
      isHttps(req),
    );
    clients.set(req, c);
  }
  return c;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function userFromClaims(claims: Record<string, unknown>, verifiedSessionProvider?: SessionProviderMarker | null): AuthUser {
  const app = (claims.app_metadata ?? {}) as Record<string, unknown>;
  const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
  const amr = Array.isArray(claims.amr) ? (claims.amr as Array<{ method?: string; provider?: string }>) : [];
  const first = amr[0];
  const isSso = first?.method === "sso/saml" || String(app.provider ?? "").startsWith("sso:");
  const providers = Array.isArray(app.providers) ? (app.providers as unknown[]).filter((p): p is string => typeof p === "string") : str(app.provider) ? [String(app.provider)] : [];
  // Keep the existing sessionMethod semantics (also used by recovery/security flows).
  // It is intentionally not avatar evidence: app_metadata.provider can describe
  // the first linked provider rather than the provider used for this session.
  const sessionMethod = isSso ? `sso:${first?.provider ?? ""}` : (first?.method === "oauth" ? str(app.provider) : first?.method ?? str(app.provider));
  return {
    id: String(claims.sub),
    email: str(claims.email),
    sessionMethod,
    providers,
    isSso,
    displayName: str(meta.full_name) ?? str(meta.name) ?? str(meta.user_name),
    // The session provider is recorded only by the OAuth callback, signed with
    // SESSION_SECRET, and bound to this validated JWT session_id. app_metadata
    // can list a user's first/linked provider, so it is never avatar evidence.
    avatarUrl: !isSso && first?.method === "oauth" && verifiedSessionProvider?.provider === "github"
      ? trustedProviderAvatarUrl("github", verifiedSessionProvider.avatarUrl)
      : null,
  };
}

/**
 * Validates the session server-side with supabase.auth.getClaims() (verifies
 * the JWT signature — never trusts the cookie contents). Memoised per request.
 * Throws 503 auth_unavailable if Supabase Auth cannot be reached.
 */
export function getAuthState(req: NextRequest): Promise<AuthState> {
  let p = states.get(req);
  if (!p) {
    p = (async (): Promise<AuthState> => {
      if (!authEnabled()) return { status: "disabled" };
      if (!hasAuthCookie(req.cookies.getAll())) return { status: "anonymous" };
      const { data, error } = await supabaseForRequest(req).auth.getClaims();
      const claims = data?.claims as Record<string, unknown> | undefined;
      if (!error && isAccountClaims(claims)) {
        const sessionProvider = readSessionProviderMarker(
          req.cookies.get(SESSION_PROVIDER_COOKIE)?.value,
          typeof claims.session_id === "string" ? claims.session_id : null,
          getConfig().sessionSecret,
        );
        return { status: "signed_in", user: userFromClaims(claims, sessionProvider) };
      }
      if (error && isUnavailable(error)) {
        logger.error("Supabase Auth unreachable while validating a session", error);
        throw new ApiError(503, "auth_unavailable", "Sign-in is temporarily unavailable. Please try again in a moment.");
      }
      return { status: "expired" };
    })();
    states.set(req, p);
  }
  return p;
}

function isUnavailable(err: unknown): boolean {
  const e = err as { name?: string; status?: number };
  return e?.name === "AuthRetryableFetchError" || (typeof e?.status === "number" && e.status >= 500);
}

/** Requires a signed-in user (401 auth_required / session_expired otherwise). */
export async function requireUser(req: NextRequest): Promise<AuthUser> {
  const s = await getAuthState(req);
  if (s.status === "signed_in") return s.user;
  if (s.status === "disabled") throw new ApiError(503, "auth_not_configured", "Accounts are not enabled on this deployment.");
  if (s.status === "expired") throw new ApiError(401, "session_expired", "Your session has expired. Please sign in again.");
  throw new ApiError(401, "auth_required", "Please sign in to continue.");
}

/**
 * Server-only admin client (Auth admin API). Uses SUPABASE_SECRET_KEY /
 * SUPABASE_SERVICE_ROLE_KEY, which never leaves the server. Used only where
 * a user action needs elevated rights: deleting the user's own account.
 */
export function supabaseAdmin() {
  const env = getConfig().auth.supabase;
  if (!env.url || !env.secretKey) return null;
  return createClient(env.url, env.secretKey, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}
