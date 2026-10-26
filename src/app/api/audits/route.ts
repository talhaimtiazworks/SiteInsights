import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRepository } from "@/lib/db";
import { ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { hasResults } from "@/lib/scans/state-machine";
import { dashboardAccess, memberOrgIds } from "@/lib/services/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["all", "active", "completed", "failed", "cancelled"]).default("all"),
  sort: z.enum(["newest", "oldest", "score_desc", "score_asc", "name"]).default("newest"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  scope: z.enum(["mine", "all"]).default("mine"),
});

/** Search, filter, sort and paginate the caller's audits (plus audits shared with their organizations when scope=all). */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  const principalId = await dashboardAccess(ctx);
  const q = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const organizationIds = q.scope === "all" ? await memberOrgIds(ctx) : [];
  const { items, total } = await getRepository().listAudits({ principalId, organizationIds, search: q.q || null, status: q.status, sort: q.sort, page: q.page, pageSize: q.pageSize });
  return ok({
    items: items.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      targetUrl: s.targetUrl,
      hostname: s.hostname,
      status: s.status,
      phase: s.phase,
      progress: { pagesCrawled: s.progress.pagesCrawled, pagesDiscovered: s.progress.pagesDiscovered, linksChecked: s.progress.linksChecked, linksTotal: s.progress.linksTotal },
      error: s.error,
      overallScore: s.overallScore ?? null,
      totalFindings: s.summary?.totalFindings ?? null,
      brokenLinks: s.summary?.brokenLinks ?? null,
      hasResults: hasResults(s.status),
      rerunOf: s.rerunOf ?? null,
      organizationId: s.organizationId ?? null,
      mine: s.principalId === principalId,
      createdAt: s.createdAt,
      finishedAt: s.finishedAt,
    })),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  });
});
