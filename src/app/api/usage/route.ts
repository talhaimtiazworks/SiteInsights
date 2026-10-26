import type { NextRequest } from "next/server";
import { ok, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";
import { usageSnapshot } from "@/lib/services/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current plan, limits and usage for the caller. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await getRequestContext(req);
  throttle(req, ctx);
  return ok(await usageSnapshot(ctx));
});
