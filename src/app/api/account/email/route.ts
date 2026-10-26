import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { authPreflight, callbackUrl, emailSchema } from "@/lib/auth/route-helpers";
import { requireUser, supabaseForRequest } from "@/lib/auth/server";
import { ApiError, ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: emailSchema });

/** Starts an email change; Supabase emails a confirmation link (to both addresses if "secure email change" is on). */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "email-change", 3);
  const user = await requireUser(req);
  if (user.isSso) throw new ApiError(400, "managed_by_sso", "Your email is managed by your organization's single sign-on.");
  const { email } = schema.parse(await readJson(req));
  if (email === user.email?.toLowerCase()) throw new ApiError(400, "same_email", "That is already your email address.");
  const { error } = await supabaseForRequest(req).auth.updateUser({ email }, { emailRedirectTo: callbackUrl(req, "/account/profile?email=changed") });
  if (error) throw authError(error, "email-change");
  return ok({ pending: true });
});
