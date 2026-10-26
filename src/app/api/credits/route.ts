import type { NextRequest } from "next/server";
import { ensureCreditAccount, summarize } from "@/lib/credits/service";
import { getRepository } from "@/lib/db";
import { ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { dashboardAccess } from "@/lib/services/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Credit balance, allowance, reset date, costs and the ledger (newest first). Signed-in owner only. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  const principalId = await dashboardAccess(ctx);
  const repo = getRepository();
  const credits = await ensureCreditAccount(principalId, repo);
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 25) || 25));
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") ?? 0) || 0);
  const ledger = await repo.commerce.listLedger(principalId, limit, offset);
  return ok({
    summary: summarize(credits),
    ledger: {
      total: ledger.total,
      items: ledger.items.map((e) => ({ id: e.id, delta: e.delta, balanceAfter: e.balanceAfter, type: e.entryType, operation: e.operation, auditId: e.auditId, detail: e.detail, createdAt: e.createdAt })),
    },
  });
});
