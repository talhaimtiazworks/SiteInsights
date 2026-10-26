import type { NextRequest } from "next/server";
import { getAccountRepository } from "@/lib/db";
import { createFeedbackMailer } from "@/lib/email/feedback-mailer";
import { ApiError, assertSameOrigin, ok, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { getConfig } from "@/lib/config/env";
import { retryFeedbackDeliveries } from "@/lib/services/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/feedback/retry — recover this account's saved-but-undelivered
 * feedback submissions WITHOUT any resubmission. The repository selects only
 * rows with delivery_status='failed' AND outcome_uncertain=false, so a retry
 * can never email already-delivered feedback twice or blindly re-send a row
 * whose provider acceptance was unconfirmed. Response counts are honest:
 * `delivered` counts provider-accepted messages only.
 */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req); // signed-in accounts only — anonymous 401
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "feedback:retry", 10);

  const outcome = await retryFeedbackDeliveries({
    store: getAccountRepository(),
    mailer: createFeedbackMailer(),
    userId: ctx.user.id,
    accountEmail: ctx.user.email ?? null,
  });

  if (outcome.kind === "email_not_configured") {
    throw new ApiError(
      503,
      "email_not_configured",
      `Email delivery is still not configured on this deployment, so ${outcome.pending === 1 ? "your saved feedback remains" : `${outcome.pending} saved submissions remain`} queued. Please try again after the deployment is updated.`,
    );
  }
  return ok({
    delivered: outcome.delivered,
    stillPending: outcome.stillFailed,
    attempted: outcome.attempted,
  });
});
