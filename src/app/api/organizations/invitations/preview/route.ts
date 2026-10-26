import type { NextRequest } from "next/server";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, route } from "@/lib/http/api";
import { getAccountRepository } from "@/lib/db";
import { ORGANIZATION_INVITATION_COOKIE, invitationCookieOptions, invitationHashFromRequest } from "@/lib/services/organization-invitations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns details only when the request carries a hash placed by the fragment-token prepare step. */
export const GET = route(async (req: NextRequest) => {
  authPreflight(req, "organization-invitation-preview", 30);
  const tokenHash = invitationHashFromRequest(req);
  if (!tokenHash) throw new ApiError(404, "invitation_not_found", "No invitation link is available in this browser.");
  const invitation = await getAccountRepository().getInvitationPreview(tokenHash);
  if (!invitation) {
    const response = ok({ invitation: null });
    response.cookies.set(ORGANIZATION_INVITATION_COOKIE, "", invitationCookieOptions(req, 0));
    return response;
  }
  const response = ok({ invitation });
  if (invitation.status !== "pending" || Date.parse(invitation.expiresAt) <= Date.now()) {
    response.cookies.set(ORGANIZATION_INVITATION_COOKIE, "", invitationCookieOptions(req, 0));
  }
  return response;
});
