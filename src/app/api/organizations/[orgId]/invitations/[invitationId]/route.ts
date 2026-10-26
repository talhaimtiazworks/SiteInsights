import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string; invitationId: string }> }) => {
  authPreflight(req, "organization-invitations", 20);
  const { orgId, invitationId } = await params;
  if (!z.uuid().safeParse(orgId).success || !z.uuid().safeParse(invitationId).success) throw new ApiError(404, "invitation_not_found", "Invitation not found.");
  const { user, accounts } = await requireAccount(req);
  const role = await accounts.getMembership(orgId, user.id);
  if (!role) throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (role === "member") throw new ApiError(403, "forbidden", "Only owners and admins can revoke invitations.");
  const result = await accounts.revokeInvitation(orgId, invitationId, user.id);
  if (result === "forbidden") throw new ApiError(403, "forbidden", "Only owners and admins can revoke invitations.");
  if (result === "not_found") throw new ApiError(404, "invitation_not_found", "Invitation not found or no longer pending.");
  return ok({ revoked: true });
});
