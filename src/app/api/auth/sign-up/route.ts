import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { INVITATION_CONTINUATION_PATH, NEW_ACCOUNT_ONBOARDING_PATH } from "@/lib/auth/redirects";
import { authPreflight, callbackUrl, emailSchema, passwordSchema, syncProfileAfterSignIn } from "@/lib/auth/route-helpers";
import { OAUTH_PROVIDER_STATE_COOKIE, SESSION_PROVIDER_COOKIE, providerCookieOptions } from "@/lib/auth/session-provider";
import { supabaseForRequest, userFromClaims } from "@/lib/auth/server";
import { isHttps } from "@/lib/http/session";
import { pendingFor } from "@/lib/auth/pending";
import { ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: emailSchema, password: passwordSchema, displayName: z.string().trim().max(80).optional(), next: z.string().max(512).optional() });

/**
 * Email + password sign-up. Passwords go straight to Supabase Auth (never
 * stored or logged by SiteInsights). When email confirmation is on, the user
 * must click the emailed link before they can sign in.
 */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "sign-up", 5);
  const body = schema.parse(await readJson(req));
  // New registrations normally land in professional-profile setup. The only
  // alternate destination is the same-site pending-invitation page, so a new
  // invitee can accept without filling optional profile fields first.
  const next = body.next === INVITATION_CONTINUATION_PATH ? INVITATION_CONTINUATION_PATH : NEW_ACCOUNT_ONBOARDING_PATH;
  const supabase = supabaseForRequest(req);
  const { data, error } = await supabase.auth.signUp({
    email: body.email,
    password: body.password,
    options: { emailRedirectTo: callbackUrl(req, next), data: body.displayName ? { full_name: body.displayName } : undefined },
  });
  if (error) throw authError(error, "sign-up");
  if (data.session) {
    const pending = pendingFor(req);
    for (const name of [SESSION_PROVIDER_COOKIE, OAUTH_PROVIDER_STATE_COOKIE]) {
      pending.cookies = pending.cookies.filter((cookie) => cookie.name !== name);
      pending.cookies.push({ name, value: "", options: providerCookieOptions(isHttps(req), 0) });
    }
    const { data: c } = await supabase.auth.getClaims();
    if (c?.claims) await syncProfileAfterSignIn(userFromClaims(c.claims as Record<string, unknown>));
    return ok({ status: "signed_in", next });
  }
  // Same response whether or not the address was already registered (no account enumeration).
  return ok({ status: "confirmation_required", email: body.email });
});
