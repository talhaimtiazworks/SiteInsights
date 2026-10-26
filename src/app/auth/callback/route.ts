import { NextResponse, type NextRequest } from "next/server";
import { applyPendingAuth } from "@/lib/auth/pending";
import { OAUTH_PROVIDER_STATE_COOKIE, SESSION_PROVIDER_COOKIE, SESSION_PROVIDER_COOKIE_TTL_SECONDS, createSessionProviderMarker, latestOAuthIdentityProvider, providerCookieOptions, verifyOAuthProviderState } from "@/lib/auth/session-provider";
import { INVITATION_CONTINUATION_PATH, NEW_ACCOUNT_ONBOARDING_PATH, safeNext } from "@/lib/auth/redirects";
import { isAccountClaims } from "@/lib/auth/audit-policy";
import { syncProfileAfterSignIn } from "@/lib/auth/route-helpers";
import { authEnabled, getAuthState, supabaseForRequest } from "@/lib/auth/server";
import { getConfig } from "@/lib/config/env";
import { trustedGithubIdentityAvatar } from "@/lib/avatar";
import { isHttps } from "@/lib/http/session";
import { requestOrigin } from "@/lib/http/origin";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_ERRORS = new Set(["access_denied", "identity_already_exists", "email_not_confirmed", "otp_expired", "flow_state_expired", "bad_code_verifier", "provider_disabled", "manual_linking_disabled", "server_error", "signup_disabled"]);

/**
 * OAuth / SSO / email-link (PKCE) callback: exchanges the one-time code for a
 * session (HttpOnly cookies) and redirects to a same-site path. A signed
 * provider marker is accepted only when it matches the OAuth-start cookie,
 * the uniquely most-recent identity returned by Supabase Auth, and the
 * validated session_id returned by Supabase.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const next = safeNext(url.searchParams.get("next"));
  const origin = requestOrigin(req, getConfig().appUrl);
  const secure = isHttps(req);
  const config = getConfig();
  const clearCookie = (response: NextResponse, name: string) => {
    response.cookies.set(name, "", providerCookieOptions(secure, 0));
    return response;
  };
  const finish = (response: NextResponse, sessionMarker?: string | null, clearSessionMarker = false) => {
    clearCookie(response, OAUTH_PROVIDER_STATE_COOKIE);
    if (sessionMarker) {
      response.cookies.set(SESSION_PROVIDER_COOKIE, sessionMarker, providerCookieOptions(secure, SESSION_PROVIDER_COOKIE_TTL_SECONDS));
    } else if (clearSessionMarker) {
      clearCookie(response, SESSION_PROVIDER_COOKIE);
    }
    return applyPendingAuth(req, response);
  };
  const fail = (code: string) => {
    const linking = next.startsWith("/account/connections");
    const dest = new URL(linking ? "/account/connections" : "/sign-in", origin);
    dest.searchParams.set("error", KNOWN_ERRORS.has(code) ? code : "callback_failed");
    if (!linking) dest.searchParams.set("next", next);
    return finish(NextResponse.redirect(dest));
  };
  if (!authEnabled()) return finish(NextResponse.redirect(new URL("/", origin)));

  const providerError = url.searchParams.get("error_code") ?? url.searchParams.get("error");
  if (providerError) return fail(providerError);

  const code = url.searchParams.get("code");
  if (!code) {
    // Email templates that verify first and then land here already created the session.
    const s = await getAuthState(req).catch(() => null);
    if (s?.status !== "signed_in") return fail("missing_code");
    const response = NextResponse.redirect(new URL(next, origin));
    // This is a non-OAuth callback (e.g. email verification), so a prior
    // provider marker must not survive it as current-session evidence.
    clearCookie(response, SESSION_PROVIDER_COOKIE);
    return finish(response);
  }

  const stateCookie = req.cookies.get(OAUTH_PROVIDER_STATE_COOKIE)?.value ?? null;
  const stateQuery = url.searchParams.get("oauth_provider_state");
  const flowState = stateCookie && stateQuery === stateCookie
    ? verifyOAuthProviderState(stateCookie, config.sessionSecret)
    : null;
  const provider = flowState?.mode === "sign_in" || flowState?.mode === "sign_up" ? flowState.provider : null;

  const supabase = supabaseForRequest(req);
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    logger.warn("Auth code exchange failed", { code: error?.code, status: error?.status });
    return fail(error?.code ?? "callback_failed");
  }

  try {
    await syncProfileAfterSignIn(data.user);
  } catch (err) {
    logger.error("Profile sync after sign-in failed", err);
  }

  let sessionMarker: string | null = null;
  if (provider) {
    try {
      const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
      const claims = claimsData?.claims as Record<string, unknown> | undefined;
      const identities = data.user?.identities;
      // app_metadata.provider can be the first/linked provider, not this login.
      // Supabase's most-recent identity timestamp is server returned; ties or
      // missing identity timestamps deliberately fall back to the default avatar.
      if (!claimsError && isAccountClaims(claims) && latestOAuthIdentityProvider(identities) === provider) {
        const sessionId = typeof claims.session_id === "string" ? claims.session_id : null;
        const githubIdentity = provider === "github" ? identities?.find((identity) => identity.provider === "github") : null;
        const avatarCandidate = provider === "github" ? trustedGithubIdentityAvatar(githubIdentity) : null;
        if (sessionId) sessionMarker = createSessionProviderMarker(provider, sessionId, avatarCandidate, config.sessionSecret);
      }
    } catch (err) {
      logger.warn("Could not bind OAuth provider to validated session", { error: err instanceof Error ? err.message : "unknown" });
    }
  }

  // A provider can return either a brand-new OAuth account or an existing
  // account even when the user clicked "Sign up". Onboard only when the
  // server-verified Auth creation timestamp proves this account was created
  // during the short-lived, signed OAuth flow (whether it began on sign-in or
  // sign-up). Any uncertain case follows the original login destination instead
  // of forcing an existing user through
  // onboarding.
  const createdAt = typeof data.user?.created_at === "string" ? Date.parse(data.user.created_at) : NaN;
  const oauthIssuedAt = flowState && flowState.mode !== "link" ? flowState.issuedAt * 1000 : null;
  const isNewOAuthRegistration = oauthIssuedAt !== null && Number.isFinite(createdAt) &&
    createdAt >= oauthIssuedAt - 5_000 && createdAt <= Date.now() + 5_000;
  const destination = isNewOAuthRegistration && next !== INVITATION_CONTINUATION_PATH ? NEW_ACCOUNT_ONBOARDING_PATH : next;
  const response = NextResponse.redirect(new URL(destination, origin));
  // A linking callback should not replace the current session's sign-in marker.
  // An ordinary OAuth callback without a strong, verifiable marker clears stale
  // provenance so a previous GitHub session cannot survive a provider switch.
  const isLinking = flowState?.mode === "link";
  return finish(response, sessionMarker, !sessionMarker && !isLinking);
}
