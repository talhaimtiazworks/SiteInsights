import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { unwrapNext } from "@/lib/auth/redirects";
import { authPreflight, syncProfileAfterSignIn } from "@/lib/auth/route-helpers";
import { supabaseForRequest } from "@/lib/auth/server";
import { ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  token_hash: z.string().min(10).max(200).regex(/^[A-Za-z0-9_-]+$/),
  type: z.enum(["email", "signup", "recovery", "email_change", "invite", "magiclink"]),
  next: z.string().max(1024).optional(),
});

/**
 * Verifies an emailed token (confirmation, password recovery, email change).
 * Called by the /auth/confirm page after the user clicks "Continue", so email
 * security scanners that pre-fetch links cannot use up the one-time token.
 */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "verify", 10);
  const body = schema.parse(await readJson(req));
  const { data, error } = await supabaseForRequest(req).auth.verifyOtp({ type: body.type, token_hash: body.token_hash });
  if (error) throw authError(error, "verify");
  if (data.user) await syncProfileAfterSignIn(data.user);
  let next = unwrapNext(body.next);
  // Recovery links lead to password setup. For a new team invite, preserve the
  // validated invitation destination through password setup so the user can
  // still accept the email-bound organization token afterwards.
  if (body.type === "recovery") next = "/account/reset-password";
  if (body.type === "invite") next = `/account/reset-password?next=${encodeURIComponent(next)}`;
  return ok({ next, signedIn: !!data.session });
});
