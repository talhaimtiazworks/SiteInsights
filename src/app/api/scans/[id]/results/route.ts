import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/db";
import { ApiError, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { pageSummary, renderSummary } from "@/lib/services/views";
import type { RenderResult } from "@/lib/browser/protocol";
import type { PerformanceRun } from "@/lib/performance/pagespeed";
import { aiAvailable, loadScanAccess, toPublicScan } from "@/lib/services/scans";
import { hasResults } from "@/lib/scans/state-machine";
import { SEVERITY_ORDER } from "@/lib/audit/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Full results of a completed scan. Not available until the scan has completed. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const repo = getRepository();
  const { scan, viewer } = await loadScanAccess(repo, id, ctx, "read");
  if (!hasResults(scan.status)) {
    throw new ApiError(409, "results_unavailable", scan.status === "failed" || scan.status === "cancelled" ? `This scan ${scan.status === "failed" ? "failed" : "was cancelled"} and has no audit results.` : "The scan has not finished yet.", { status: scan.status });
  }
  const [findings, pages, links, recs, renders, perf] = await Promise.all([repo.listFindings(id), repo.listPages(id), repo.listLinkChecks(id), repo.listAiRecommendations(id), repo.listArtifacts(id, "render"), repo.listArtifacts(id, "performance")]);
  const aiOk = aiAvailable();
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.affectedCount - a.affectedCount);
  const explained = new Set(recs.filter((r) => r.findingId).map((r) => r.findingId));
  const summary = recs.find((r) => r.findingId === null);
  return ok({
    scan: toPublicScan(scan, viewer),
    findings: findings.map((f) => ({ ...f, aiExplanationAvailable: aiOk, aiExplanationCached: explained.has(f.id) })),
    pages: pages.map(pageSummary),
    links,
    aiSummary: summary ? { content: summary.content, provider: summary.provider, model: summary.model, fallbackFrom: summary.fallbackFrom, createdAt: summary.createdAt } : null,
    aiAvailable: aiOk,
    renders: renders.map((a) => renderSummary(a.key, a.data as RenderResult)),
    performance: perf.map((a) => a.data as PerformanceRun).sort((a, b) => Number(a.strategy !== "mobile") - Number(b.strategy !== "mobile")),
  });
});
