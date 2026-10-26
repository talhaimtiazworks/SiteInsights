import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import { ApiError, assertSameOrigin, assertScanId, ok, readIdempotencyKey, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { explainFindingForUser, parseAiRequest } from "@/lib/services/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Generates (or returns the cached) AI explanation for one verified finding. */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string; findingId: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id, findingId } = await params;
  assertScanId(id);
  if (!/^f_[0-9a-f]{20}$/.test(findingId)) throw new ApiError(404, "finding_not_found", "Issue not found.");
  throttle(req, ctx, "ai", 20);
  const body = parseAiRequest(await readJson(req));
  const { record, cached } = await explainFindingForUser(ctx, id, findingId, body, readIdempotencyKey(req));
  return ok({ cached, ai: { content: record.content, provider: record.provider, model: record.model, fallbackFrom: record.fallbackFrom, createdAt: record.createdAt } });
});
