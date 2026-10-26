import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuid = z.uuid();

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  authPreflight(req, "org-members-read", 60);
  const { orgId } = await params;
  if (!uuid.safeParse(orgId).success) throw new ApiError(404, "organization_not_found", "Organization not found.");
  const { user, accounts } = await requireAccount(req);
  if (!(await accounts.getMembership(orgId, user.id))) throw new ApiError(404, "organization_not_found", "Organization not found.");
  return ok({ members: await accounts.listMembers(orgId) });
});

/**
 * Legacy direct-add endpoint retained only as an explicit, non-mutating response.
 * All membership grants must pass through an invitation the recipient accepts.
 */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  authPreflight(req, "org-members", 20);
  const { orgId } = await params;
  if (!uuid.safeParse(orgId).success) throw new ApiError(404, "organization_not_found", "Organization not found.");
  const { user, accounts } = await requireAccount(req);
  const role = await accounts.getMembership(orgId, user.id);
  if (!role) throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (role === "member") throw new ApiError(403, "forbidden", "Only owners and admins can manage team membership.");
  throw new ApiError(410, "invitation_required", "Direct member additions are disabled. Send an invitation; the recipient must explicitly accept before joining.");
});
