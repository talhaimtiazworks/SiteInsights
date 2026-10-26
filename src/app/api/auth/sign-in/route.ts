import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirects";
import { authPreflight, emailSchema, syncProfileAfterSignIn } from "@/lib/auth/route-helpers";
import { OAUTH_PROVIDER_STATE_COOKIE, SESSION_PROVIDER_COOKIE, providerCookieOptions } from "@/lib/auth/session-provider";
import { supabaseForRequest, userFromClaims } from "@/lib/auth/server";
import { isHttps } from "@/lib/http/session";
import { pendingFor } from "@/lib/auth/pending";
import { ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password.").max(200), next: z.string().max(512).optional() });

/** Email + password sign-in. Session cookies are HttpOnly and refreshed by proxy.ts. */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "sign-in", 10);
  const body = schema.parse(await readJson(req));
  const supabase = supabaseForRequest(req);
  const { error } = await supabase.auth.signInWithPassword({ email: body.email, password: body.password });
  if (error) throw authError(error, "sign-in");
  const pending = pendingFor(req);
  for (const name of [SESSION_PROVIDER_COOKIE, OAUTH_PROVIDER_STATE_COOKIE]) {
    pending.cookies = pending.cookies.filter((cookie) => cookie.name !== name);
    pending.cookies.push({ name, value: "", options: providerCookieOptions(isHttps(req), 0) });
  }
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) await syncProfileAfterSignIn(userFromClaims(data.claims as Record<string, unknown>));
  return ok({ status: "signed_in", next: safeNext(body.next) });
});
