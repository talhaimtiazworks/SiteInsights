import type { NextRequest } from "next/server";
import { z } from "zod";
import { authError } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirects";
import { authPreflight, callbackUrl, emailSchema } from "@/lib/auth/route-helpers";
import { supabaseForRequest } from "@/lib/auth/server";
import { ok, readJson, route } from "@/lib/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: emailSchema, next: z.string().max(512).optional() });

/** Re-sends the sign-up confirmation email. Always answers the same way (no account enumeration). */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "resend", 3);
  const body = schema.parse(await readJson(req));
  const { error } = await supabaseForRequest(req).auth.resend({ type: "signup", email: body.email, options: { emailRedirectTo: callbackUrl(req, safeNext(body.next)) } });
  if (error) {
    const mapped = authError(error, "resend");
    // Same response whether or not the address has an account (no enumeration);
    // an undeliverable address (email_unavailable) is logged for the operator only.
    if (mapped.status === 429 || (mapped.status === 503 && mapped.code !== "email_unavailable")) throw mapped;
  }
  // `sent` is the legacy request acknowledgement, not proof of SMTP/inbox delivery.
  // Keep the same generic response for unknown/undeliverable accounts.
  return ok({ sent: true, delivery: "unverified" });
});
