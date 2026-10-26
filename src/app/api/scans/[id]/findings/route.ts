import type { NextRequest } from "next/server";
import { z } from "zod";
import { CATEGORIES, FINDING_TYPES, SEVERITIES, SEVERITY_ORDER } from "@/lib/audit/types";
import { getRepository } from "@/lib/db";
import { ApiError, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { hasResults } from "@/lib/scans/state-machine";
import { aiAvailable, loadScanAccess } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  severity: z.enum(SEVERITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  type: z.enum(FINDING_TYPES).optional(),
  q: z.string().max(200).optional(),
});

/** Lists findings with optional severity/category/type/text filters. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const q = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const repo = getRepository();
  const { scan } = await loadScanAccess(repo, id, ctx, "read");
  if (!hasResults(scan.status)) throw new ApiError(409, "results_unavailable", "Findings are only available for completed scans.");
  const needle = q.q?.toLowerCase().trim();
  const ai = aiAvailable();
  const findings = (await repo.listFindings(id))
    .filter((f) => (!q.severity || f.severity === q.severity) && (!q.category || f.category === q.category) && (!q.type || f.type === q.type))
    .filter((f) => !needle || `${f.title} ${f.description} ${f.affectedUrls.join(" ")}`.toLowerCase().includes(needle))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.affectedCount - a.affectedCount)
    .map((f) => ({ ...f, aiExplanationAvailable: ai }));
  return ok({ findings, count: findings.length });
});
