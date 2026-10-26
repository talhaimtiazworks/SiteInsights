import type { NextRequest } from "next/server";
import { getRepository } from "@/lib/db";
import { ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { dashboardAccess } from "@/lib/services/dashboard";
import { ACTIVE_WINDOW_MS } from "@/lib/services/scans";
import { usageSnapshot } from "@/lib/services/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Overview: real totals, score, severity distribution, latest issues, activity, usage and plan. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  const principalId = await dashboardAccess(ctx);
  const repo = getRepository();
  const [stats, latestIssues, activity, usage, claimable] = await Promise.all([
    repo.auditStats(principalId, new Date(Date.now() - ACTIVE_WINDOW_MS)),
    repo.latestIssues(principalId, 8),
    repo.recentActivity(principalId, 12),
    usageSnapshot(ctx),
    ctx.user && ctx.anonymousPrincipalId !== principalId ? repo.countScans(ctx.anonymousPrincipalId) : Promise.resolve(0),
  ]);
  return ok({
    stats,
    latestIssues,
    activity: activity.map((h) => ({ ...h, detail: { rerun_of: h.detail.rerun_of ?? null, error_code: h.detail.error_code ?? null, title: h.detail.title ?? null, rule_id: h.detail.rule_id ?? null } })),
    usage,
    claimable,
  });
});
