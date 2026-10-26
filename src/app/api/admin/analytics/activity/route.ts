import "server-only";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin/allowlist";
import { analyticsFailure } from "@/lib/analytics/errors";
import { parseAnalyticsRange, parsePagination } from "@/lib/analytics/range";
import { getRepository } from "@/lib/db";
import { ok, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Privacy-conscious recent activity rows: event type, sanitized path,
 * device/browser/os class, source bucket and timestamp. Emails, IPs, raw
 * visitor/session ids are never included.
 */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getRequestContext(req);
  requireAdmin(ctx);
  throttle(req, ctx, "admin:analytics", 60);
  const url = new URL(req.url);
  const { limit, offset } = parsePagination(url);
  try {
    return ok(await getRepository().analytics.recentActivity(parseAnalyticsRange(url), limit, offset));
  } catch (err) {
    analyticsFailure("activity", err);
  }
});
