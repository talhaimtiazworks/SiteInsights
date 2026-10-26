import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { getAccountRepository } from "@/lib/db";
import { ORGANIZATION_INVITATION_COOKIE, hashInvitationToken, invitationCookieOptions } from "@/lib/services/organization-invitations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/) }).strict();

/** Validates a fragment token without accepting/rejecting it, then keeps only its hash in an HttpOnly cookie. */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "organization-invitation-prepare", 20);
  const { token } = schema.parse(await readJson(req));
  const tokenHash = hashInvitationToken(token);
  const invitation = await getAccountRepository().getInvitationPreview(tokenHash);
  if (!invitation) throw new ApiError(404, "invitation_not_found", "This invitation link is invalid or no longer available.");

  const response = ok({ invitation });
  const remainingSeconds = Math.floor((Date.parse(invitation.expiresAt) - Date.now()) / 1000);
  if (invitation.status === "pending" && remainingSeconds > 0) {
    response.cookies.set(ORGANIZATION_INVITATION_COOKIE, tokenHash, invitationCookieOptions(req, remainingSeconds));
  } else {
    response.cookies.set(ORGANIZATION_INVITATION_COOKIE, "", invitationCookieOptions(req, 0));
  }
  return response;
});
