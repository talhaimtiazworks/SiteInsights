import type { NextRequest } from "next/server";
import { processBillingWebhook } from "@/lib/billing/service";
import { ApiError, ok, route } from "@/lib/http/api";
import { getRequestContext, throttle } from "@/lib/http/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Payment provider webhooks. The adapter verifies the signature over the raw
 * body before anything is parsed; events are applied idempotently. Responds
 * 404 while no provider is configured.
 */
export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ provider: string }> }) => {
  const { provider } = await params;
  if (!/^[a-z0-9_-]{2,32}$/.test(provider)) throw new ApiError(404, "not_found", "Not found.");
  throttle(req, await getRequestContext(req), "billing:webhook", 300);
  return ok(await processBillingWebhook(provider, req));
});
