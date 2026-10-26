/**
 * Supabase SSR client construction shared by proxy.ts and route handlers.
 * No "server-only"/Node imports so it can run in the proxy.
 *
 * Auth cookies are HttpOnly: SiteInsights never uses the Supabase client in the
 * browser — all auth calls go through our server routes — so page scripts
 * never need (or get) access to the session tokens.
 */
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseEnv } from "./supabase-env";

export const AUTH_COOKIE_RE = /^sb-[A-Za-z0-9_-]+-auth-token(?:\.\d+)?$/;

export function hasAuthCookie(cookies: Array<{ name: string }>): boolean {
  return cookies.some((c) => AUTH_COOKIE_RE.test(c.name));
}

export type CookieToSet = { name: string; value: string; options: CookieOptions };

export interface CookieBridge {
  getAll(): Array<{ name: string; value: string }>;
  setAll(cookies: CookieToSet[], headers: Record<string, string>): void;
}

export function createSupabaseForRequest(env: SupabaseEnv, bridge: CookieBridge, secure: boolean) {
  if (!env.url || !env.publishableKey) throw new Error("Supabase is not configured");
  return createServerClient(env.url, env.publishableKey, {
    cookies: { getAll: () => bridge.getAll(), setAll: (c, h) => bridge.setAll(c, h) },
    cookieOptions: { httpOnly: true, secure, sameSite: "lax", path: "/" },
    auth: { flowType: "pkce", detectSessionInUrl: false },
  });
}
