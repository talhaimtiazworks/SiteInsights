import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { PATH_HEADER } from "../http/session";
import { getConfig } from "../config/env";
import { SESSION_PROVIDER_COOKIE, readSessionProviderMarker } from "./session-provider";
import { safeNext } from "./redirects";
import { authEnabled, userFromClaims, type AuthUser } from "./server";
import { createSupabaseForRequest, hasAuthCookie } from "./ssr";
import { readSupabaseEnv } from "./supabase-env";
import { isAccountClaims } from "./audit-policy";

export type PageSession =
  | { accounts: false; user: null; expired: false }
  | { accounts: true; user: AuthUser; expired: false }
  | { accounts: true; user: null; expired: boolean };

/**
 * Validates the session for a server-rendered page (layouts of protected
 * sections). proxy.ts has already refreshed the tokens for this request, so
 * this only verifies them — it never writes cookies.
 */
export async function getPageSession(): Promise<PageSession> {
  if (!authEnabled()) return { accounts: false, user: null, expired: false };
  const store = await cookies();
  const all = store.getAll();
  if (!hasAuthCookie(all)) return { accounts: true, user: null, expired: false };
  const h = await headers();
  const secure = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
  try {
    const supabase = createSupabaseForRequest(readSupabaseEnv(), { getAll: () => all.map(({ name, value }) => ({ name, value })), setAll: () => {} }, secure);
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims as Record<string, unknown> | undefined;
    if (error || !data || !isAccountClaims(claims)) return { accounts: true, user: null, expired: true };
    const sessionProvider = readSessionProviderMarker(
      store.get(SESSION_PROVIDER_COOKIE)?.value,
      typeof claims.session_id === "string" ? claims.session_id : null,
      getConfig().sessionSecret,
    );
    return { accounts: true, user: userFromClaims(claims, sessionProvider), expired: false };
  } catch {
    return { accounts: true, user: null, expired: true };
  }
}

/** All private pages fail closed; missing Auth configuration never enables anonymous audits. */
export async function requirePageSession(fallbackPath: string): Promise<PageSession> {
  const s = await getPageSession();
  if (!s.user) {
    const path = safeNext((await headers()).get(PATH_HEADER), fallbackPath);
    redirect(`/sign-in?next=${encodeURIComponent(path)}${s.expired ? "&reason=expired" : ""}`);
  }
  return s;
}
