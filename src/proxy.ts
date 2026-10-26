import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseForRequest, hasAuthCookie, type CookieToSet } from "@/lib/auth/ssr";
import { readSupabaseEnv } from "@/lib/auth/supabase-env";
import { proxyShouldRefreshSession } from "@/lib/auth/session-refresh";
import { isHttps, NEW_PRINCIPAL_HEADER, PATH_HEADER, PRINCIPAL_COOKIE, principalCookieOptions, UUID_RE } from "@/lib/http/session";

/**
 * Runs before every page and API request:
 *
 * 1. Protected/dynamic requests refresh Supabase cookies when present; public
 *    shell pages defer that check until the non-blocking client session request.
 *    The auth-session endpoint validates and refreshes in its own route handler,
 *    so proxy does not duplicate it. Authorization is never decided here—every
 *    private route/page still validates the session server-side.
 *
 * 2. Issues the anonymous session cookie on the first request, so every later
 *    API call carries the same identity. (Without this, parallel first-visit
 *    requests each got a different random ID and an audit could look like it
 *    belonged to someone else.)
 */
export async function proxy(req: NextRequest) {
  const sb = readSupabaseEnv();

  // Private owner analytics area: requests WITHOUT any auth cookie can never
  // belong to the allowlisted owner, so they receive a true 404 (rewritten to
  // an unmatched path — the styled not-found page, real 404 status code) at
  // the edge without waking the app. This is an optimization ONLY: requests
  // WITH cookies continue, and the page guard + every /api/admin/* route still
  // enforce the owner allowlist against the verified session.
  if (sb.authEnabled && req.nextUrl.pathname.startsWith("/admin") && !hasAuthCookie(req.cookies.getAll())) {
    return NextResponse.rewrite(new URL("/__private-area-not-found", req.url));
  }

  const authCookies: CookieToSet[] = [];
  const authHeaders: Record<string, string> = {};
  if (sb.authEnabled && hasAuthCookie(req.cookies.getAll()) && proxyShouldRefreshSession(req.nextUrl.pathname)) {
    try {
      const supabase = createSupabaseForRequest(
        sb,
        {
          getAll: () => req.cookies.getAll().map(({ name, value }) => ({ name, value })),
          setAll: (cookies, headers) => {
            for (const c of cookies) {
              if (c.value) req.cookies.set(c.name, c.value);
              else req.cookies.delete(c.name);
              authCookies.push(c);
            }
            Object.assign(authHeaders, headers);
          },
        },
        isHttps(req),
      );
      await supabase.auth.getClaims();
    } catch {
      // Auth outage: continue; route handlers report it (503 auth_unavailable).
    }
  }

  const headers = new Headers(req.headers); // includes cookies updated by a refresh
  headers.delete(NEW_PRINCIPAL_HEADER); // never trust a client-supplied value
  // Lets protected layouts send users back to the exact page after signing in.
  headers.set(PATH_HEADER, (req.nextUrl.pathname + req.nextUrl.search).slice(0, 512));
  const existing = req.cookies.get(PRINCIPAL_COOKIE)?.value;
  let newId: string | null = null;
  if (!existing || !UUID_RE.test(existing)) {
    newId = crypto.randomUUID();
    // Make the new cookie visible to the route handler for this same request.
    const others = (headers.get("cookie") ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${PRINCIPAL_COOKIE}=`));
    headers.set("cookie", [...others, `${PRINCIPAL_COOKIE}=${newId}`].join("; "));
    headers.set(NEW_PRINCIPAL_HEADER, "1");
  }
  const res = NextResponse.next({ request: { headers } });
  if (newId) res.cookies.set(PRINCIPAL_COOKIE, newId, principalCookieOptions(req));
  for (const c of authCookies) res.cookies.set(c.name, c.value, c.options);
  for (const [k, v] of Object.entries(authHeaders)) res.headers.set(k, v);
  return res;
}

export const config = {
  // Everything except static assets and metadata files.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|favicon\\.svg|icon|apple-icon|brand/|robots\\.txt|sitemap\\.xml).*)"],
};
