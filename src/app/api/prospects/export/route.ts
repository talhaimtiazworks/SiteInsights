import type { NextRequest } from "next/server";
import { z } from "zod";
import { PROSPECT_STATUSES } from "@/lib/db/commerce-types";
import { route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { exportProspectsCsv } from "@/lib/services/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CSV export for manual outreach (formula-injection safe). Owner only. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx, "prospects:export", 10);
  const status = z.enum([...PROSPECT_STATUSES, "all"]).catch("all").parse(req.nextUrl.searchParams.get("status") ?? "all");
  const csv = await exportProspectsCsv(ctx, status, req.nextUrl.origin);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="siteinsights-prospects-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
