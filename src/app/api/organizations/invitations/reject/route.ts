import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { requireAccount, requireConfirmedAccountEmail } from "@/lib/services/account";
import { hashInvitationToken, invitationCookieOptions, invitationHashFromRequest, ORGANIZATION_INVITATION_COOKIE } from "@/lib/services/organization-invitations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
  z.object({}).strict(),
]);

export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "organization-invitation-response", 10);
  const body = schema.parse(await readJson(req));
  const tokenHash = "token" in body ? hashInvitationToken(body.token) : invitationHashFromRequest(req);
  if (!tokenHash) throw new ApiError(404, "invitation_not_found", "This invitation is invalid or no longer available.");
  const { user, accounts } = await requireAccount(req);
  const email = await requireConfirmedAccountEmail(req, user);
  const result = await accounts.rejectInvitation(tokenHash, user.id, email);
  if (result === "not_found") throw new ApiError(404, "invitation_not_found", "This invitation is invalid or no longer available.");
  if (result === "email_mismatch") throw new ApiError(403, "invitation_email_mismatch", "Sign in with the verified email address the invitation was sent to.");
  if (result === "expired") throw new ApiError(410, "invitation_expired", "This invitation has expired and can no longer be declined.");
  if (result === "not_pending") throw new ApiError(409, "invitation_not_pending", "This invitation has already been accepted, declined, or revoked.");
  const response = ok({ rejected: true });
  response.cookies.set(ORGANIZATION_INVITATION_COOKIE, "", invitationCookieOptions(req, 0));
  return response;
});
