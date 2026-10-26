import type { NextRequest } from "next/server";
import { billingStatus } from "@/lib/billing/registry";
import { PLAN_IDS } from "@/lib/billing/plans";
import { getConfig } from "@/lib/config/env";
import { ok, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public plan catalog, credit costs and payment availability (no secrets, no per-user data). */
export const GET = route(async (req: NextRequest) => {
  throttle(req, await getRequestContext(req));
  const { plans, costs, currency } = getConfig().plans;
  const status = billingStatus();
  return ok({ currency, costs, plans: PLAN_IDS.map((id) => plans[id]), payments: { available: status.state === "ready", message: status.state === "ready" ? null : status.message } });
});
