import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, route } from "@/lib/http/api";
import { requireAccount, requireConfirmedAccountEmail } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ invitationId: string }> }) => {
  authPreflight(req, "organization-invitation-response", 10);
  const { invitationId } = await params;
  if (!z.uuid().safeParse(invitationId).success) throw new ApiError(404, "invitation_not_found", "This invitation is invalid or no longer available.");
  const { user, accounts } = await requireAccount(req);
  const email = await requireConfirmedAccountEmail(req, user);
  const result = await accounts.acceptInvitationById(invitationId, user.id, email);
  if (result === "not_found") throw new ApiError(404, "invitation_not_found", "This invitation is invalid or no longer available.");
  if (result === "email_mismatch") throw new ApiError(403, "invitation_email_mismatch", "Sign in with the verified email address the invitation was sent to.");
  if (result === "expired") throw new ApiError(410, "invitation_expired", "This invitation has expired. Ask a team owner to send a new one.");
  if (result === "member_limit") throw new ApiError(409, "member_limit", "The team is full. Ask an owner to remove a member or pending invitation.");
  if (result === "not_pending") throw new ApiError(409, "invitation_not_pending", "This invitation has already been accepted, declined, or revoked.");
  return ok({ accepted: true });
});
