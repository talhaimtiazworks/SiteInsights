import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { ApiError, assertScanId, ok, readJson, route } from "@/lib/http/api";
import { driveScan, handOff, isAuthorizedCron, nextActiveAudit, runAfterResponse, sweep } from "@/lib/services/background";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Budget (BACKGROUND_BUDGET_MS, default 50 s) + one bounded step (≤ 90 s).
export const maxDuration = 300;

function authorize(req: NextRequest) {
  if (!isAuthorizedCron(req.headers.get("authorization"))) throw new ApiError(401, "unauthorized", "Unauthorized.");
}

/** Scheduled sweep (Vercel Cron sends GET with Authorization: Bearer $CRON_SECRET). */
export const GET = route(async (req: NextRequest) => {
  authorize(req);
  const result = await sweep(getConfig().background.budgetMs);
  return ok(result);
});

const handOffSchema = z.object({ scanId: z.string(), hop: z.number().int().min(0).max(100) });

/** Continues one unfinished audit in a fresh invocation (called by the app itself). */
export const POST = route(async (req: NextRequest) => {
  authorize(req);
  const { scanId, hop } = handOffSchema.parse(await readJson(req));
  assertScanId(scanId);
  const origin = req.nextUrl.origin;
  const scheduled = runAfterResponse(async () => {
    const done = await driveScan(scanId, getConfig().background.budgetMs);
    if (!done) {
      await handOff(origin, scanId, hop + 1);
      return;
    }
    // Continue with the owner's next queued batch audit, if one started.
    const next = await nextActiveAudit(scanId);
    if (next) await handOff(origin, next, 0);
  });
  if (!scheduled) throw new ApiError(503, "background_unavailable", "Background processing is disabled.");
  return ok({ accepted: true }, { status: 202 });
});
