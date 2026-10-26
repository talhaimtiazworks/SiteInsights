import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.uuid();
const roleSchema = z.object({ role: z.enum(["admin", "member"]) }).strict();

/** Changes a non-owner member's role; only the current owner may do so. */
export const PATCH = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string; userId: string }> }) => {
  authPreflight(req, "org-members", 20);
  const { orgId, userId } = await params;
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(userId).success) throw new ApiError(404, "member_not_found", "Member not found.");
  const { user, accounts } = await requireAccount(req);
  const myRole = await accounts.getMembership(orgId, user.id);
  if (!myRole) throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (myRole !== "owner") throw new ApiError(403, "forbidden", "Only an owner can change member roles.");
  const { role } = roleSchema.parse(await readJson(req));
  const result = await accounts.updateMemberRole(orgId, userId, role, user.id);
  if (result === "forbidden") throw new ApiError(403, "forbidden", "Only the current owner can change member roles.");
  if (result === "owner") throw new ApiError(409, "owner_role", "Ownership changes must use the ownership-transfer action.");
  if (result === "not_found") throw new ApiError(404, "member_not_found", "Member not found.");
  return ok({ updated: true, role });
});

/** Removes a member (owners/admins), or leaves the organization (yourself). */
export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string; userId: string }> }) => {
  authPreflight(req, "org-members", 20);
  const { orgId, userId } = await params;
  if (!uuid.safeParse(orgId).success) throw new ApiError(404, "organization_not_found", "Organization not found.");
  const { user, accounts } = await requireAccount(req);
  const myRole = await accounts.getMembership(orgId, user.id);
  if (!myRole) throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (!uuid.safeParse(userId).success) throw new ApiError(404, "member_not_found", "Member not found.");
  const theirRole = await accounts.getMembership(orgId, userId);
  if (!theirRole) throw new ApiError(404, "member_not_found", "Member not found.");
  const self = userId === user.id;
  if (!self && myRole === "member") throw new ApiError(403, "forbidden", "Only owners and admins can remove members.");
  if (!self && (theirRole === "owner" || theirRole === "admin") && myRole !== "owner") throw new ApiError(403, "forbidden", "Only an owner can remove another owner or admin.");
  const result = await accounts.removeMember(orgId, userId, user.id);
  if (result === "last_owner") throw new ApiError(409, "last_owner", "Transfer ownership or delete the team before its last owner leaves.");
  if (result === "forbidden") throw new ApiError(403, "forbidden", "Your team role cannot remove this member.");
  if (result === "not_found") throw new ApiError(404, "member_not_found", "Member not found.");
  return ok({ removed: true, left: self });
});
