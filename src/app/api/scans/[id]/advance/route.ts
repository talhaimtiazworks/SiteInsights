import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import { getRepository } from "@/lib/db";
import { assertSameOrigin, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { loadOwnedScan, runScanStep, toPublicScan } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A step is bounded by SCAN_STEP_BUDGET_MS (default 20 s), or by one browser /
// PageSpeed call (BROWSER_WORKER_TIMEOUT_MS / PAGESPEED_TIMEOUT_MS, max 80 s).
export const maxDuration = 90;

/**
 * Performs one bounded unit of scan work (lease-protected, idempotent).
 * The progress page calls this repeatedly until the scan reaches a terminal state.
 */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx, "scan:advance", 90);
  const owned = await loadOwnedScan(getRepository(), id, ctx);
  const { scan, leaseBusy } = await runScanStep(owned, ctx);
  if (!scan) return ok({ scan: null, leaseBusy });
  return ok({ scan: toPublicScan(scan), leaseBusy });
});
