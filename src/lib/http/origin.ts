import type { NextRequest } from "next/server";

/**
 * The public origin the browser used for this request.
 *
 * NEXT_PUBLIC_APP_URL wins. Otherwise the forwarded/Host headers are used:
 * `req.nextUrl.origin` can be the server's bind address (e.g. http://0.0.0.0:3000
 * under `next start -H 0.0.0.0`). Links built from this are only ever sent to
 * the same browser or validated by Supabase's Redirect URL allow list.
 */
export function requestOrigin(req: NextRequest, appUrl: string | null = null): string {
  if (appUrl) return new URL(appUrl).origin;
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  const host = first(req.headers.get("x-forwarded-host")) ?? first(req.headers.get("host"));
  const proto = first(req.headers.get("x-forwarded-proto")) ?? req.nextUrl.protocol.replace(/:$/, "");
  if (host && /^[A-Za-z0-9.\-:[\]]+$/.test(host) && (proto === "http" || proto === "https")) return `${proto}://${host}`;
  return req.nextUrl.origin;
}
