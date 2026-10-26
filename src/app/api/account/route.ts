import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { authPreflight } from "@/lib/auth/route-helpers";
import { supabaseAdmin, supabaseForRequest } from "@/lib/auth/server";
import { getRepository } from "@/lib/db";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { getRequestContext } from "@/lib/http/context";
import { logger } from "@/lib/logger";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Account overview for the account pages. */
export const GET = route(async (req: NextRequest) => {
  const { user, accounts, profile } = await requireAccount(req);
  const ctx = await getRequestContext(req);
  const [settings, orgs, auditCount, claimable] = await Promise.all([
    accounts.getUserSettings(`user:${user.id}`),
    accounts.listOrganizations(user.id),
    getRepository().countScans(`user:${user.id}`),
    ctx.anonymousPrincipalId ? getRepository().countScans(ctx.anonymousPrincipalId) : Promise.resolve(0),
  ]);
  const res = ok({
    profile: { ...profile, avatarUrl: user.avatarUrl },
    user: { id: user.id, email: user.email, providers: user.providers, isSso: user.isSso, sessionMethod: user.sessionMethod },
    settings,
    organizations: orgs,
    auditCount,
    claimable,
    deletionAvailable: !!getConfig().auth.supabase.secretKey,
  });
  res.headers.set("cache-control", "private, no-store");
  return res;
});

const deleteSchema = z.object({ confirmEmail: z.string().trim().toLowerCase().max(254) });

/**
 * Permanently deletes the account: audits, usage, settings, profile, sole-owned
 * organizations, and the Supabase Auth user. The user must type their email
 * address to confirm. Requires the Supabase secret key on the server.
 */
export const DELETE = route(async (req: NextRequest) => {
  authPreflight(req, "delete-account", 3);
  const { user, accounts } = await requireAccount(req);
  const body = deleteSchema.parse(await readJson(req));
  if (!user.email || body.confirmEmail !== user.email.toLowerCase()) throw new ApiError(400, "confirmation_mismatch", "Type your account email address exactly to confirm.");
  const admin = supabaseAdmin();
  if (!admin) throw new ApiError(503, "account_deletion_unavailable", "Account deletion isn't available on this deployment yet (the operator must set SUPABASE_SECRET_KEY). Contact support to delete your account.");
  // Remove SiteInsights data first, then the auth user (on Supabase the profile also cascades from auth.users).
  await accounts.deleteAccountData(user.id);
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    logger.error("Supabase user deletion failed after data removal", { status: error.status, code: error.code });
    throw new ApiError(502, "account_deletion_incomplete", "Your SiteInsights data was deleted, but removing the sign-in account failed. Please try again or contact support.");
  }
  await supabaseForRequest(req).auth.signOut({ scope: "local" }).catch(() => {});
  return ok({ deleted: true });
});
