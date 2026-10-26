import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { authPreflight, passwordSchema, verifyPassword } from "@/lib/auth/route-helpers";
import { requireUser, supabaseForRequest } from "@/lib/auth/server";
import { ApiError, ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ password: passwordSchema, currentPassword: z.string().max(200).optional() });

/**
 * Sets a new password.
 *  - After a reset link (recovery session): no current password needed.
 *  - Accounts that only use Google/GitHub/SSO can add a password.
 *  - Otherwise the current password is verified first.
 */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "password", 5);
  const user = await requireUser(req);
  const body = schema.parse(await readJson(req));
  const recovery = user.sessionMethod === "recovery" || user.sessionMethod === "otp";
  const hasPassword = user.providers.includes("email");
  if (!recovery && hasPassword) {
    if (!body.currentPassword) throw new ApiError(400, "current_password_required", "Enter your current password.");
    if (!user.email || !(await verifyPassword(user.email, body.currentPassword))) throw new ApiError(400, "current_password_incorrect", "Your current password is incorrect.");
  }
  const { error } = await supabaseForRequest(req).auth.updateUser({ password: body.password });
  if (error) throw authError(error, "update-password");
  return ok({ updated: true });
});
