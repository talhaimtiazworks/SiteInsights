import type { NextRequest } from "next/server";
import { z } from "zod";
import { authPreflight } from "@/lib/auth/route-helpers";
import { ApiError, ok, readJson, route } from "@/lib/http/api";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    displayName: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

export const PATCH = route(async (req: NextRequest) => {
  authPreflight(req, "profile", 20);
  const { user, accounts } = await requireAccount(req);
  const body = schema.parse(await readJson(req));
  const profile = await accounts.updateProfile(user.id, {
    displayName: body.displayName === undefined ? undefined : body.displayName || null,
  });
  if (!profile) throw new ApiError(404, "profile_not_found", "Your profile could not be found. Refresh the page and try again.");
  return ok({ profile: { ...profile, avatarUrl: user.avatarUrl } });
});
