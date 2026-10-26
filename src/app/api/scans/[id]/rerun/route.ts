import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import { getRepository } from "@/lib/db";
import { ApiError, assertSameOrigin, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { isTerminal } from "@/lib/scans/state-machine";
import { processInBackground } from "@/lib/services/background";
import { loadOwnedScan, startScan, toPublicScan } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Re-runs a finished audit (or retries a failed/cancelled one) as a NEW audit
 * of the same URL with the same optional checks, linked via rerunOf. Counts
 * against the audit allowance like any other audit. Owner only.
 */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx, "scan:start", 10);
  const original = await loadOwnedScan(getRepository(), id, ctx);
  if (!isTerminal(original.status)) throw new ApiError(409, "audit_in_progress", "This audit is still running. Wait for it to finish or cancel it first.");
  const idem = req.headers.get("idempotency-key");
  if (idem !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(idem)) throw new ApiError(400, "invalid_idempotency_key", "The Idempotency-Key header must be 8–64 letters, digits, '-' or '_'.");
  const checks = {
    browser: (original.limits.browserPages ?? 0) > 0,
    accessibility: !!original.limits.accessibility,
    performance: (original.limits.performanceStrategies ?? []).length > 0,
  };
  const { scan, accessKey, replayed } = await startScan(ctx, original.targetUrl, { idempotencyKey: idem, checks, rerunOf: original.id, title: original.title ?? null });
  if (!replayed) processInBackground(req.nextUrl.origin, scan.id);
  return ok({ ...toPublicScan(scan), accessKey }, { status: replayed ? 200 : 201 });
});
