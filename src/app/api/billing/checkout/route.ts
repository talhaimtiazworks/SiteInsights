import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { getConfig } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FREE PRODUCT: hosted checkout is retired. Every feature is free for every
 * signed-in user, so no plan checkout can ever be initiated — even if legacy
 * provider credentials happen to remain configured. Historical billing data,
 * subscriptions and verified webhook processing are preserved untouched; this
 * route only refuses new sales, plainly.
 */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req);
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "billing:checkout", 10);
  throw new ApiError(503, "payments_not_configured", "SiteInsights is free for everyone — there is nothing to buy and no checkout to start. Every feature is included without a plan.");
});
