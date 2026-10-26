import type { NextRequest } from "next/server";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, route } from "@/lib/http/api";
import { requireAccount, requireConfirmedAccountEmail } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recipient inbox; matching uses the current Auth-confirmed address, not a JWT/profile claim. */
export const GET = route(async (req: NextRequest) => {
  authPreflight(req, "organization-invitation-inbox", 30);
  const { user, accounts } = await requireAccount(req);
  const email = await requireConfirmedAccountEmail(req, user);
  if (!email) throw new ApiError(403, "email_unverified", "Confirm your sign-in email before viewing team invitations.");
  return ok({ invitations: await accounts.listRecipientInvitations(email) });
});
