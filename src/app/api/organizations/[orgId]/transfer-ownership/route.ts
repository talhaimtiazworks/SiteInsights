import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ newOwnerId: z.uuid(), formerOwnerRole: z.enum(["admin", "member"]).default("admin") }).strict();

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  authPreflight(req, "org-ownership", 5);
  const { orgId } = await params;
  if (!z.uuid().safeParse(orgId).success) throw new ApiError(404, "organization_not_found", "Organization not found.");
  const { user, accounts } = await requireAccount(req);
  const role = await accounts.getMembership(orgId, user.id);
  if (!role) throw new ApiError(404, "organization_not_found", "Organization not found.");
  if (role !== "owner") throw new ApiError(403, "forbidden", "Only the current owner can transfer ownership.");
  const body = schema.parse(await readJson(req));
  if (body.newOwnerId === user.id) throw new ApiError(400, "invalid_owner", "Choose another current team member.");
  const result = await accounts.transferOwnership(orgId, user.id, body.newOwnerId, body.formerOwnerRole);
  if (result === "not_owner") throw new ApiError(403, "forbidden", "Only the current owner can transfer ownership.");
  if (result === "member_not_found") throw new ApiError(404, "member_not_found", "Choose an existing non-owner team member.");
  return ok({ transferred: true });
});
