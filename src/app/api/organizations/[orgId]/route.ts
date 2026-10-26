import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function membership(req: NextRequest, orgId: string) {
  if (!UUID.test(orgId)) throw new ApiError(404, "organization_not_found", "Organization not found.");
  const acc = await requireAccount(req);
  const role = await acc.accounts.getMembership(orgId, acc.user.id);
  if (!role) throw new ApiError(404, "organization_not_found", "Organization not found.");
  return { ...acc, role };
}

/** Organization details and members (members only). */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  const { orgId } = await params;
  const { accounts, role, user } = await membership(req, orgId);
  const orgs = await accounts.listOrganizations(user.id);
  const [members, activity] = await Promise.all([accounts.listMembers(orgId), accounts.listOrganizationActivity(orgId, 40)]);
  const invitations = role === "member" ? [] : await accounts.listInvitations(orgId);
  return ok({ organization: orgs.find((o) => o.id === orgId), role, members, invitations, activity });
});

const patchSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const PATCH = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  authPreflight(req, "org-edit", 20);
  const { orgId } = await params;
  const { accounts, role, user } = await membership(req, orgId);
  if (role === "member") throw new ApiError(403, "forbidden", "Only owners and admins can rename the organization.");
  const { name } = patchSchema.parse(await readJson(req));
  if (!(await accounts.renameOrganization(orgId, name, user.id))) throw new ApiError(403, "forbidden", "Only current team owners and admins can rename the organization.");
  return ok({ renamed: true });
});

/** Deletes the organization (owners only). Shared audits stay with their owners and stop being shared. */
export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) => {
  authPreflight(req, "org-delete", 5);
  const { orgId } = await params;
  const { accounts, role, user } = await membership(req, orgId);
  if (role !== "owner") throw new ApiError(403, "forbidden", "Only owners can delete the organization.");
  if (!(await accounts.deleteOrganization(orgId, user.id))) throw new ApiError(403, "forbidden", "Only the current owner can delete the organization.");
  return ok({ deleted: true });
});
