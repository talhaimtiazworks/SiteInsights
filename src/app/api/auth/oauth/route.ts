import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { getAuthProviders } from "@/lib/auth/providers";
import { safeNext } from "@/lib/auth/redirects";
import { authPreflight, callbackUrl } from "@/lib/auth/route-helpers";
import { OAUTH_PROVIDER_STATE_COOKIE, OAUTH_PROVIDER_STATE_TTL_SECONDS, createOAuthProviderState, providerCookieOptions } from "@/lib/auth/session-provider";
import { requireUser, supabaseForRequest } from "@/lib/auth/server";
import { getConfig } from "@/lib/config/env";
import { isHttps } from "@/lib/http/session";
import { ApiError, ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ provider: z.enum(["google", "github"]), next: z.string().max(512).optional(), mode: z.enum(["sign_in", "sign_up", "link"]).default("sign_in") });

/**
 * Starts Google/GitHub sign-in (or connects the provider to the signed-in
 * account). The existing PKCE verifier stays in an HttpOnly Supabase cookie.
 * A separate signed marker records which provider this OAuth flow requested;
 * the callback binds it to the verified Supabase session before using it.
 */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "oauth", 10);
  const body = schema.parse(await readJson(req));
  const providers = await getAuthProviders();
  if (body.mode === "sign_up" && providers.signupDisabled) throw new ApiError(403, "signup_disabled", "New accounts can't be created on this deployment right now.");
  if (!providers[body.provider]) throw new ApiError(400, "provider_disabled", `${body.provider === "google" ? "Google" : "GitHub"} sign-in isn't enabled on this deployment.`);
  const supabase = supabaseForRequest(req);

  if (body.mode === "link") {
    await requireUser(req);
    const providerState = createOAuthProviderState(body.provider, getConfig().sessionSecret, "link");
    const redirect = new URL(callbackUrl(req, "/account/connections?linked=" + body.provider));
    if (providerState) redirect.searchParams.set("oauth_provider_state", providerState);
    const { data, error } = await supabase.auth.linkIdentity({ provider: body.provider, options: { redirectTo: redirect.toString(), skipBrowserRedirect: true } });
    if (error || !data?.url) throw authError(error, "link-identity");
    const response = ok({ url: data.url });
    response.cookies.set(
      OAUTH_PROVIDER_STATE_COOKIE,
      providerState ?? "",
      providerCookieOptions(isHttps(req), providerState ? OAUTH_PROVIDER_STATE_TTL_SECONDS : 0),
    );
    return response;
  }

  const providerState = createOAuthProviderState(body.provider, getConfig().sessionSecret, body.mode);
  if (body.mode === "sign_up" && !providerState) {
    throw new ApiError(503, "auth_unavailable", "Secure registration state is unavailable. Please try email sign-up or try again later.");
  }
  const redirect = new URL(callbackUrl(req, safeNext(body.next)));
  if (providerState) redirect.searchParams.set("oauth_provider_state", providerState);
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: body.provider, options: { redirectTo: redirect.toString(), skipBrowserRedirect: true } });
  if (error || !data?.url) throw authError(error, "oauth");

  const response = ok({ url: data.url });
  if (providerState) {
    response.cookies.set(
      OAUTH_PROVIDER_STATE_COOKIE,
      providerState,
      providerCookieOptions(isHttps(req), OAUTH_PROVIDER_STATE_TTL_SECONDS),
    );
  }
  return response;
});
