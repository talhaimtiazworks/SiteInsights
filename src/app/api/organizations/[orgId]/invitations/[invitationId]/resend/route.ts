import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string; invitationId: string }> }) => {
  authPreflight(req, "organization-invitation-resend", 5);
  const { orgId, invitationId } = await params;
  if (!z.uuid().safeParse(orgId).success || !z.uuid().safeParse(invitationId).success) throw new ApiError(404, "invitation_not_found", "Invitation not found.");
  const { user, accounts } = await requireAccount(req);
  const role = await accounts.getMembership(orgId, user.id);
  if (!role) throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (role === "member") throw new ApiError(403, "forbidden", "Only owners and admins can manage invitations.");
  const invitation = (await accounts.listInvitations(orgId)).find((item) => item.id === invitationId);
  if (!invitation) throw new ApiError(404, "invitation_not_found", "Invitation not found.");
  if (invitation.status !== "pending" && invitation.status !== "expired") throw new ApiError(409, "invitation_not_pending", "Only pending or expired invitations can be resent.");
  throw new ApiError(503, "email_not_configured", "Team email is not configured. No email was sent, and the invitation was not changed. The recipient can respond from the Invitation inbox in Teams.");
});
