import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { RESOLUTION_STATUSES } from "@/lib/audit/types";
import { getRepository } from "@/lib/db";
import { ApiError, assertSameOrigin, assertScanId, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { hasResults } from "@/lib/scans/state-machine";
import { aiAvailable, loadOwnedScan, loadScanAccess, toPublicScan } from "@/lib/services/scans";
import { pageSummary } from "@/lib/services/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One finding with the affected page's recorded data and any cached AI explanation. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string; findingId: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id, findingId } = await params;
  assertScanId(id);
  if (!/^f_[0-9a-f]{20}$/.test(findingId)) throw new ApiError(404, "finding_not_found", "Issue not found.");
  throttle(req, ctx);
  const repo = getRepository();
  const { scan, viewer } = await loadScanAccess(repo, id, ctx, "read");
  if (!hasResults(scan.status)) throw new ApiError(409, "results_unavailable", "Findings are only available for completed scans.");
  const finding = await repo.getFinding(id, findingId);
  if (!finding) throw new ApiError(404, "finding_not_found", "Issue not found.");
  const pages = await repo.listPages(id);
  const page = pages.find((p) => p.finalUrl === finding.affectedUrl || p.url === finding.affectedUrl);
  const ai = await repo.getAiRecommendation(id, findingId);
  return ok({
    scan: toPublicScan(scan, viewer),
    finding: { ...finding, aiExplanationAvailable: aiAvailable() },
    page: page ? pageSummary(page) : null,
    ai: ai ? { content: ai.content, provider: ai.provider, model: ai.model, fallbackFrom: ai.fallbackFrom, createdAt: ai.createdAt } : null,
  });
});

const resolutionSchema = z.object({ status: z.enum(RESOLUTION_STATUSES), note: z.string().trim().max(500).nullable().optional() }).strict();

/** Mark an issue resolved / ignored / open again (owner only). Recorded in the audit history. */
export const PATCH = route(async (req: NextRequest, { params }: { params: Promise<{ id: string; findingId: string }> }) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  const { id, findingId } = await params;
  assertScanId(id);
  if (!/^f_[0-9a-f]{20}$/.test(findingId)) throw new ApiError(404, "finding_not_found", "Issue not found.");
  throttle(req, ctx);
  const body = resolutionSchema.parse(await readJson(req));
  const repo = getRepository();
  const scan = await loadOwnedScan(repo, id, ctx);
  if (!hasResults(scan.status)) throw new ApiError(409, "results_unavailable", "Findings are only available for completed scans.");
  const finding = await repo.setIssueResolution(id, findingId, body.status, body.note ? body.note : null);
  if (!finding) throw new ApiError(404, "finding_not_found", "Issue not found.");
  return ok({ finding: { id: finding.id, resolution: finding.resolution } });
});
