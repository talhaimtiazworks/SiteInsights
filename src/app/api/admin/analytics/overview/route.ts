import "server-only";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin/allowlist";
import { analyticsFailure } from "@/lib/analytics/errors";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { getRepository } from "@/lib/db";
import { ok, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Aggregated dashboard payload. Owner-allowlist enforced server-side. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getRequestContext(req);
  requireAdmin(ctx);
  throttle(req, ctx, "admin:analytics", 60);
  try {
    return ok(await getRepository().analytics.overview(parseAnalyticsRange(new URL(req.url))));
  } catch (err) {
    analyticsFailure("overview", err);
  }
});
