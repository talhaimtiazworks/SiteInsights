import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";
import { MAX_OWNED_ORGANIZATIONS_PER_USER } from "@/lib/db/account-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const { user, accounts } = await requireAccount(req);
  const organizations = await accounts.listOrganizations(user.id);
  if (req.nextUrl.searchParams.get("includeMembers") === "true") {
    // One membership query replaces one request/database lookup per team.
    const members = await accounts.listMembersForUserOrganizations(user.id);
    return ok({ organizations, members });
  }
  return ok({ organizations });
});

const schema = z.object({ name: z.string().trim().min(1, "Enter a name.").max(80) });

/** Creates an organization; the creator becomes its owner. */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "org-create", 5);
  const { user, accounts } = await requireAccount(req);
  const { name } = schema.parse(await readJson(req));
  const organization = await accounts.createOrganization(user.id, name);
  if (!organization) throw new ApiError(400, "organization_limit", `You can own up to ${MAX_OWNED_ORGANIZATIONS_PER_USER} organizations.`);
  return ok({ organization }, { status: 201 });
});
