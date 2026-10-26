import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authPreflight, emailSchema } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";
import { createInvitationToken, hashInvitationToken, ORGANIZATION_INVITATION_TTL_MS } from "@/lib/services/organization-invitations";
import { ORGANIZATION_INVITATION_EMAIL_NOT_CONFIGURED } from "@/lib/services/organization-invitation-email";
import { MAX_ORGANIZATION_MEMBERS } from "@/lib/db/account-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.uuid();
const inviteSchema = z.object({ email: emailSchema, role: z.enum(["admin", "member"]).default("member") }).strict();

async function manager(req: NextRequest, orgId: string) {
  if (!uuid.safeParse(orgId).success) throw new ApiError(404, "organization_not_found", "Organization not found.");
  const { user, accounts } = await requireAccount(req);
  const role = await accounts.getMembership(orgId, user.id);
  if (!role) throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (role === "member") throw new ApiError(403, "forbidden", "Only owners and admins can manage invitations.");
  return { user, accounts, role };
}

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  authPreflight(req, "organization-invitations-read", 60);
  const { orgId } = await params;
  const { accounts } = await manager(req, orgId);
  return ok({ invitations: await accounts.listInvitations(orgId) });
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  authPreflight(req, "organization-invitations", 5);
  const { orgId } = await params;
  const { user, accounts, role: myRole } = await manager(req, orgId);
  const input = inviteSchema.parse(await readJson(req));
  if (input.role === "admin" && myRole !== "owner") throw new ApiError(403, "forbidden", "Only an owner can invite an admin.");

  const delivery = ORGANIZATION_INVITATION_EMAIL_NOT_CONFIGURED;
  const token = createInvitationToken();
  const expiresAt = new Date(Date.now() + ORGANIZATION_INVITATION_TTL_MS);
  const created = await accounts.createInvitation({
    id: randomUUID(),
    organizationId: orgId,
    email: input.email,
    role: input.role,
    tokenHash: hashInvitationToken(token),
    invitedByUserId: user.id,
    expiresAt,
    emailDeliveryStatus: delivery.status,
    emailErrorCode: delivery.errorCode,
  });
  if (created.outcome === "not_found") throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (created.outcome === "forbidden") throw new ApiError(403, "forbidden", "Your team role cannot send this invitation.");
  if (created.outcome === "member_exists") throw new ApiError(409, "already_member", "That email already belongs to a team member.");
  if (created.outcome === "member_limit") throw new ApiError(409, "member_limit", `Teams can have up to ${MAX_ORGANIZATION_MEMBERS} members and pending invitations combined.`);
  if (!created.invitation) throw new ApiError(500, "invitation_failed", "The invitation could not be prepared.");

  return ok({ invitation: created.invitation, emailDelivery: delivery }, { status: created.outcome === "created" ? 201 : 200 });
});
