/**
 * Anonymous session cookie shared by proxy.ts (which issues it on the first
 * request, before any API call can race) and the API request context.
 * Kept free of Node-only imports so it can run in the proxy.
 */
export const PRINCIPAL_COOKIE = "sl_pid";
/** Set by proxy.ts on the forwarded request when it has just issued a new cookie. */
export const NEW_PRINCIPAL_HEADER = "x-sitelens-new-principal";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHttps(req: { nextUrl: { protocol: string }; headers: Headers }): boolean {
  return req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https";
}

export function principalCookieOptions(req: { nextUrl: { protocol: string }; headers: Headers }) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Only mark Secure on HTTPS; otherwise browsers drop the cookie on plain-http hosts.
    secure: isHttps(req),
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };
}

/** Request header (set only by proxy.ts) carrying the requested path + query for post-sign-in redirects. */
export const PATH_HEADER = "x-sitelens-path";
