import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/db";
import { ApiError, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { hasResults } from "@/lib/scans/state-machine";
import { compareAudits } from "@/lib/services/compare";
import { loadScanAccess } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/scans/compare?a=<id>&b=<id> — both audits must be readable by the caller and finished. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  const a = req.nextUrl.searchParams.get("a") ?? "";
  const b = req.nextUrl.searchParams.get("b") ?? "";
  assertScanId(a);
  assertScanId(b);
  if (a === b) throw new ApiError(400, "same_audit", "Choose two different audits to compare.");
  throttle(req, ctx);
  const repo = getRepository();
  const [x, y] = await Promise.all([loadScanAccess(repo, a, ctx, "read"), loadScanAccess(repo, b, ctx, "read")]);
  for (const s of [x.scan, y.scan]) {
    if (!hasResults(s.status) || !s.summary) throw new ApiError(409, "results_unavailable", "Both audits must have finished with results to be compared.", { id: s.id, status: s.status });
  }
  return ok(await compareAudits(repo, x.scan, y.scan));
});
