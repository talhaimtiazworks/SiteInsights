import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import { ApiError, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { dashboardAccess } from "@/lib/services/dashboard";
import { toPublicScan } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A batch with the live status of each audit it started. Owner only. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) throw new ApiError(404, "not_found", "Batch not found.");
  const principalId = await dashboardAccess(ctx);
  const repo = getRepository();
  const batch = await repo.commerce.getBatch(principalId, id);
  if (!batch) throw new ApiError(404, "not_found", "Batch not found.");
  const audits = await Promise.all(batch.items.map(async (i) => (i.auditId ? repo.getScan(i.auditId) : null)));
  return ok({ batch: { id: batch.id, createdAt: batch.createdAt, items: batch.items.map((i, n) => ({ ...i, audit: audits[n] && audits[n]!.principalId === principalId ? toPublicScan(audits[n]!) : null })) } });
});
