/**
 * Auth cookies written while handling a request (session refresh, sign-in,
 * sign-out) are collected per request and copied onto whatever response the
 * route returns (see route() in http/api.ts). Responses that set auth cookies
 * are marked uncacheable so a CDN can never serve one user's session to another.
 */
import type { CookieToSet } from "./ssr";

interface Pending {
  cookies: CookieToSet[];
  headers: Record<string, string>;
}
const store = new WeakMap<object, Pending>();

export function pendingFor(req: object): Pending {
  let p = store.get(req);
  if (!p) store.set(req, (p = { cookies: [], headers: {} }));
  return p;
}

export function applyPendingAuth(req: object, res: Response): Response {
  const p = store.get(req);
  if (!p || (!p.cookies.length && !Object.keys(p.headers).length)) return res;
  const withCookies = res as Response & { cookies?: { set(name: string, value: string, options?: object): void } };
  for (const c of p.cookies) {
    if (withCookies.cookies?.set) withCookies.cookies.set(c.name, c.value, c.options);
    else res.headers.append("set-cookie", serialize(c));
  }
  for (const [k, v] of Object.entries(p.headers)) res.headers.set(k, v);
  if (p.cookies.length) res.headers.set("cache-control", "private, no-cache, no-store, must-revalidate, max-age=0");
  return res;
}

function serialize(c: CookieToSet): string {
  const o = c.options ?? {};
  const parts = [`${c.name}=${encodeURIComponent(c.value)}`, `Path=${o.path ?? "/"}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  if (o.expires) parts.push(`Expires=${new Date(o.expires).toUTCString()}`);
  if (o.httpOnly) parts.push("HttpOnly");
  if (o.secure) parts.push("Secure");
  if (o.sameSite) parts.push(`SameSite=${typeof o.sameSite === "string" ? o.sameSite[0].toUpperCase() + o.sameSite.slice(1) : "Lax"}`);
  return parts.join("; ");
}
