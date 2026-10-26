import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { getAuthProviders } from "@/lib/auth/providers";
import { safeNext } from "@/lib/auth/redirects";
import { authPreflight, callbackUrl } from "@/lib/auth/route-helpers";
import { supabaseForRequest } from "@/lib/auth/server";
import { ApiError, ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().max(254), next: z.string().max(512).optional() });

/**
 * Enterprise SSO (SAML 2.0) via Supabase Auth: finds the identity provider
 * registered for the email's domain and returns its sign-in URL.
 * Requires SAML to be enabled on the Supabase project (Pro plan or above) and
 * the organization's IdP to be added with the Supabase CLI.
 */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "sso", 10);
  const body = schema.parse(await readJson(req));
  const domain = (body.email.includes("@") ? body.email.split("@").pop()! : body.email).trim().toLowerCase();
  if (!/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/.test(domain)) throw new ApiError(400, "invalid_domain", "Enter your work email address (for example name@company.com).");
  const providers = await getAuthProviders();
  if (!providers.saml) throw new ApiError(404, "sso_not_configured", "Single sign-on isn't enabled for this deployment.");
  const { data, error } = await supabaseForRequest(req).auth.signInWithSSO({ domain, options: { redirectTo: callbackUrl(req, safeNext(body.next)) } });
  if (error || !data?.url) throw authError(error, "sso");
  return ok({ url: data.url });
});
