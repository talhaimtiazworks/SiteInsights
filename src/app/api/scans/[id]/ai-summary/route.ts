import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import { getRepository } from "@/lib/db";
import { assertSameOrigin, assertScanId, ok, readIdempotencyKey, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { parseAiRequest, summarizeForUser } from "@/lib/services/ai";
import { loadScanAccess } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Returns the cached overall AI summary, if any. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const repo = getRepository();
  await loadScanAccess(repo, id, ctx, "read");
  const rec = await repo.getAiRecommendation(id, null);
  return ok({ ai: rec ? { content: rec.content, provider: rec.provider, model: rec.model, fallbackFrom: rec.fallbackFrom, createdAt: rec.createdAt } : null });
});

/** Generates the overall AI audit summary from verified findings. */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx, "ai", 20);
  const body = parseAiRequest(await readJson(req));
  const { record, cached } = await summarizeForUser(ctx, id, body, readIdempotencyKey(req));
  return ok({ cached, ai: { content: record.content, provider: record.provider, model: record.model, fallbackFrom: record.fallbackFrom, createdAt: record.createdAt } });
});
