import type { NextRequest } from "next/server";
import { getRepository, maybeAccountRepository } from "@/lib/db";
import { ApiError, assertScanId, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { buildOpportunityBrief, OPPORTUNITY_FORMULA, rankByOpportunity } from "@/lib/leads/opportunity";
import { buildReportPersonalization, loadProfessionalData } from "@/lib/services/professional-profile";
import { hasResults } from "@/lib/scans/state-machine";
import { entitlementsFor, loadScanAccess } from "@/lib/services/scans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deterministic opportunity brief built only from this audit's verified findings. */
export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuditContext(req);
  const { id } = await params;
  assertScanId(id);
  throttle(req, ctx);
  const repo = getRepository();
  const { scan } = await loadScanAccess(repo, id, ctx, "read");
  const ent = await entitlementsFor(ctx);
  if (!ent.features.prospects || !ent.features.advancedFilters) throw new ApiError(403, "feature_unavailable", "Opportunity briefs are disabled on this deployment.", { feature: "advancedFilters" });
  if (!hasResults(scan.status)) throw new ApiError(409, "results_unavailable", "The audit has not finished yet.");
  const findings = await repo.listFindings(id);
  const brief = buildOpportunityBrief(scan, findings);
  // Score for every finding (advanced filters rank the whole issue list, not just the top five).
  const ranking = rankByOpportunity(findings).map((f) => ({ findingId: f.id, opportunity: Math.round(f.opportunity * 10) / 10 }));
  const prospect = await repo.commerce.findProspectByHostname(ctx.principalId, new URL(scan.targetUrl).hostname);
  let personalization = { professional: null, matchedServices: [], portfolio: [] } as ReturnType<typeof buildReportPersonalization>;
  if (ctx.user && scan.principalId === ctx.principalId) {
    const accounts = maybeAccountRepository();
    if (accounts) {
      const professional = await loadProfessionalData(accounts, ctx.user.id);
      personalization = buildReportPersonalization(professional, findings);
    }
  }
  return ok({ brief, ranking, formula: OPPORTUNITY_FORMULA, prospect: prospect ? { id: prospect.id, status: prospect.status, auditId: prospect.auditId } : null, source: "verified_findings", personalization });
});
