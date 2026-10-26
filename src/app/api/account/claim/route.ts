import type { NextRequest } from "next/server";
import { authPreflight } from "@/lib/auth/route-helpers";
import { getRepository } from "@/lib/db";
import { ApiError, ok, route } from "@/lib/http/api";
import { getRequestContext } from "@/lib/http/context";
import { requireAccount } from "@/lib/services/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Moves the audits this browser ran before signing in (anonymous session
 * cookie) into the signed-in account, together with their usage records, so
 * limits can't be reset by signing up. Only the browser holding that cookie
 * can claim them.
 */
export const POST = route(async (req: NextRequest) => {
  authPreflight(req, "claim", 5);
  const { user } = await requireAccount(req);
  const ctx = await getRequestContext(req);
  if (!ctx.anonymousPrincipalId || ctx.anonymousPrincipalId.startsWith("user:")) throw new ApiError(400, "nothing_to_claim", "There are no audits from this browser to add.");
  const repo = getRepository();
  await repo.ensurePrincipal(`user:${user.id}`, ctx.ipHash);
  const moved = await repo.reassignPrincipal(ctx.anonymousPrincipalId, `user:${user.id}`);
  return ok({ moved });
});
