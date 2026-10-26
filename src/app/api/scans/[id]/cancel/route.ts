import type { NextRequest } from "next/server";
import { getConfig } from "@/lib/config/env";
import { getRepository } from "@/lib/db";
import { ApiError, assertSameOrigin, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { loadOwnedScan, onAuditFinished, toPublicScan } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancels a queued or running scan. */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const repo = getRepository();
  await loadOwnedScan(repo, id, ctx);
  const changed = await repo.transitionScan(id, ["queued", "running"], "cancelled", { finishedAt: new Date().toISOString(), phase: "finished", error: { code: "cancelled", message: "The scan was cancelled before it finished." } });
  if (!changed) throw new ApiError(409, "not_cancellable", "Only queued or running scans can be cancelled.");
  const scan = await repo.getScan(id);
  // Settle credits now (start fee + pages processed so far) and start the next queued batch audit.
  if (scan) await onAuditFinished(repo, scan);
  return ok(toPublicScan(scan!));
});
