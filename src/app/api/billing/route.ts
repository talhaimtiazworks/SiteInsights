import type { NextRequest } from "next/server";
import { billingOverview } from "@/lib/billing/service";
import { ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current plan, subscription state, credits and payment availability for the signed-in user. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  throttle(req, ctx);
  return ok(await billingOverview(ctx));
});
