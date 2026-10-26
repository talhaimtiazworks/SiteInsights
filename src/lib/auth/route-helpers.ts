import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "../config/env";
import { maybeAccountRepository } from "../db";
import { DatabaseProblemError } from "../db/errors";
import { logger } from "../logger";
import { ApiError, assertSameOrigin } from "../http/api";
import { clientIp, hashIp } from "../http/context";
import { requestOrigin } from "../http/origin";
import { rateLimit } from "../http/rate-limit";
import type { AuthUser } from "./server";

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: "Please enter a valid email address." }));
/** Mirrors Supabase's default minimum; Supabase enforces its own (stricter, if configured) policy too. */
export const passwordSchema = z.string().min(8, "Use at least 8 characters.").max(72, "Use at most 72 characters.");

/** Common checks for state-changing auth endpoints: accounts enabled, same-origin, per-IP throttle. */
export function authPreflight(req: NextRequest, bucket: string, perMinute = 10) {
  const cfg = getConfig();
  if (!cfg.auth.supabase.authEnabled) throw new ApiError(503, "auth_not_configured", "Accounts are not enabled on this deployment.");
  assertSameOrigin(req, cfg.appUrl);
  const ip = hashIp(clientIp(req.headers), cfg.sessionSecret);
  const r = rateLimit(`auth:${bucket}:${ip}`, perMinute, 60_000);
  if (!r.ok) throw new ApiError(429, "auth_rate_limited", "Too many attempts. Please wait a minute and try again.", { retryAfterSeconds: r.retryAfterSeconds });
}

/** Origin used in links sent by email / OAuth redirects (must be in Supabase's Redirect URL allow list). */
export function siteOrigin(req: NextRequest): string {
  return requestOrigin(req, getConfig().appUrl);
}

export function callbackUrl(req: NextRequest, next: string): string {
  return `${siteOrigin(req)}/auth/callback?next=${encodeURIComponent(next)}`;
}

/** Creates/refreshes the profile row for a signed-in user (best effort when accounts storage is unavailable). */
export async function syncProfile(user: AuthUser | { id: string; email?: string | null; user_metadata?: Record<string, unknown> }) {
  const accounts = maybeAccountRepository();
  if (!accounts) return null;
  if ("user_metadata" in user) {
    const m = user.user_metadata ?? {};
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return accounts.ensureProfile({ id: user.id, email: user.email ?? null, displayName: s(m.full_name) ?? s(m.name) ?? s(m.user_name) });
  }
  const u = user as AuthUser;
  return accounts.ensureProfile({ id: u.id, email: u.email, displayName: u.displayName });
}

/**
 * Profile sync right after a successful sign-in. A database problem must not
 * undo a sign-in that Supabase Auth already completed (the session cookie is
 * set); it is logged, and the dashboard/start-audit report the precise problem
 * (e.g. supabase_project_mismatch) on the next request.
 */
export async function syncProfileAfterSignIn(user: Parameters<typeof syncProfile>[0]): Promise<void> {
  try {
    await syncProfile(user);
  } catch (err) {
    if (!(err instanceof DatabaseProblemError)) throw err;
    logger.warn(`Signed in, but the profile could not be saved (${err.problem}).`);
  }
}

/**
 * Checks a password without touching the caller's session: signs in on a
 * throwaway, non-persistent client, then revokes that extra session.
 */
export async function verifyPassword(email: string, password: string): Promise<boolean> {
  const env = getConfig().auth.supabase;
  const c = createClient(env.url!, env.publishableKey!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  await c.auth.signOut({ scope: "local" }).catch(() => {});
  return true;
}
