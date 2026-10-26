import type { NextRequest } from "next/server";
import { z } from "zod";
import { pendingFor } from "@/lib/auth/pending";
import { OAUTH_PROVIDER_STATE_COOKIE, SESSION_PROVIDER_COOKIE, providerCookieOptions } from "@/lib/auth/session-provider";
import { supabaseForRequest } from "@/lib/auth/server";
import { getConfig } from "@/lib/config/env";
import { assertSameOrigin, ok, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** scope "global" also revokes the user's sessions on every other device. */
const schema = z.object({ scope: z.enum(["local", "global"]).default("local") });

/** Session cookies written by @supabase/ssr (incl. chunks ".0", ".1"… and the PKCE verifier). */
const AUTH_COOKIE = /^sb-[A-Za-z0-9-]+-auth-token(?:-code-verifier)?(?:\.\d+)?$/;
/** How long to wait for Supabase to revoke the session before answering anyway. */
const REVOKE_WAIT_MS = 4000;

/**
 * Signs this browser out. The session is revoked in Supabase Auth when it can
 * be (within REVOKE_WAIT_MS), and the auth cookies are ALWAYS expired — even if
 * the session is expired and Auth is unreachable, where supabase-js would keep
 * retrying the refresh for ~30 s and then return without clearing them.
 */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req, getConfig().appUrl);
  const body = schema.safeParse(await req.json().catch(() => ({})));
  const scope = body.success ? body.data.scope : "local";
  // Capture the names first: supabase-js deletes them from the request view as it signs out.
  const authCookies = req.cookies.getAll().map((c) => c.name).filter((n) => AUTH_COOKIE.test(n));

  let sessionRevoked = false;
  if (getConfig().auth.supabase.authEnabled && authCookies.length) {
    const attempt = supabaseForRequest(req).auth.signOut({ scope }).then((r) => !r.error, () => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), REVOKE_WAIT_MS); });
    sessionRevoked = await Promise.race([attempt, timeout]);
    clearTimeout(timer);
  }

  // Expire every auth cookie as the last pending write, so nothing written by a
  // late refresh can re-create the session on this response.
  const pending = pendingFor(req);
  const secure = req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  for (const name of authCookies) {
    pending.cookies = pending.cookies.filter((c) => c.name !== name);
    pending.cookies.push({ name, value: "", options: { path: "/", maxAge: 0, httpOnly: true, secure, sameSite: "lax" } });
  }
  const response = ok({ signedOut: true, sessionRevoked });
  response.cookies.set(SESSION_PROVIDER_COOKIE, "", providerCookieOptions(secure, 0));
  response.cookies.set(OAUTH_PROVIDER_STATE_COOKIE, "", providerCookieOptions(secure, 0));
  return response;
});
