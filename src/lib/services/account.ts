import "server-only";
import type { NextRequest } from "next/server";
import { requireUser, supabaseForRequest, type AuthUser } from "../auth/server";
import { syncProfile } from "../auth/route-helpers";
import { getAccountRepository } from "../db";
import type { AccountRepository, Profile } from "../db/account-types";
import { ApiError } from "../http/api";

/** Signed-in user + their profile row (created on first use). Accounts require PostgreSQL. */
export async function requireAccount(req: NextRequest): Promise<{ user: AuthUser; accounts: AccountRepository; profile: Profile }> {
  const user = await requireUser(req);
  const accounts = getAccountRepository();
  const profile = (await accounts.getProfile(user.id)) ?? (await syncProfile(user))!;
  return { user, accounts, profile };
}

/**
 * Resolve the current email from Supabase Auth, not only the signed JWT claim,
 * and require Auth's server-side confirmation timestamp before using it as an
 * invitation capability. Auth outages fail closed rather than accepting the
 * claim as a fallback.
 */
export async function requireConfirmedAccountEmail(req: NextRequest, user: AuthUser): Promise<string> {
  let response: Awaited<ReturnType<ReturnType<typeof supabaseForRequest>["auth"]["getUser"]>>;
  try {
    response = await supabaseForRequest(req).auth.getUser();
  } catch {
    throw new ApiError(503, "auth_unavailable", "Email verification is temporarily unavailable. Please try again.");
  }
  if (response.error) {
    const status = (response.error as { status?: number }).status;
    if (status === 401 || status === 403) {
      throw new ApiError(401, "session_expired", "Your session has expired. Sign in again before responding to this invitation.");
    }
    throw new ApiError(503, "auth_unavailable", "Email verification is temporarily unavailable. Please try again.");
  }
  const authUser = response.data.user;
  if (!authUser || authUser.id !== user.id) {
    throw new ApiError(401, "session_expired", "Your session could not be verified. Sign in again before responding to this invitation.");
  }
  const email = typeof authUser.email === "string" ? authUser.email.trim().toLowerCase() : "";
  if (!email || !authUser.email_confirmed_at) {
    throw new ApiError(403, "email_unverified", "Confirm the email address on your account before responding to a team invitation.");
  }
  return email;
}
