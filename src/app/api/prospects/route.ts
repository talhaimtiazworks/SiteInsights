import type { NextRequest } from "next/server";
import { z } from "zod";
import { getConfig } from "@/lib/config/env";
import { PROSPECT_STATUSES } from "@/lib/db/commerce-types";
import { assertSameOrigin, assertScanId, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { listProspects, manualProspectSchema, saveManualProspect, saveProspectFromAudit } from "@/lib/services/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statusSchema = z.enum([...PROSPECT_STATUSES, "all"]).catch("all");

/** The signed-in user's prospects (Business plan; still readable after a downgrade). */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  const sp = req.nextUrl.searchParams;
  return ok(await listProspects(ctx, { status: statusSchema.parse(sp.get("status") ?? "all"), search: sp.get("q"), limit: Number(sp.get("limit") ?? 50) || 50, offset: Number(sp.get("offset") ?? 0) || 0 }));
});

/** Saves (or refreshes) a prospect from one of the user's finished audits. */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "prospects:write", 60);
  const body = await readJson(req);
  const audit = z.object({ auditId: z.string() }).strict().safeParse(body);
  if (audit.success) {
    assertScanId(audit.data.auditId);
    const { prospect, created } = await saveProspectFromAudit(ctx, audit.data.auditId);
    return ok({ prospect, created }, { status: created ? 201 : 200 });
  }
  const manual = manualProspectSchema.parse(body);
  const { prospect, created } = await saveManualProspect(ctx, manual);
  return ok({ prospect, created }, { status: created ? 201 : 200 });
});
