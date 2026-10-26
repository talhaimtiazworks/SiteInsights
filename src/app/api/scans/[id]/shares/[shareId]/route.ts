import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { ApiError, assertSameOrigin, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { revokeShare } from "@/lib/services/shares";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revokes a share link immediately. Owner only. */
export const DELETE = route(async (req: NextRequest, { params }: { params: Promise<{ id: string; shareId: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id, shareId } = await params;
  assertScanId(id);
  if (!z.uuid().safeParse(shareId).success) throw new ApiError(404, "not_found", "Share link not found.");
  throttle(req, ctx);
  await revokeShare(ctx, id, shareId);
  return ok({ revoked: true });
});
