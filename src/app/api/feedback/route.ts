import type { NextRequest } from "next/server";
import { getAccountRepository } from "@/lib/db";
import { createFeedbackMailer } from "@/lib/email/feedback-mailer";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/http/api";
import { getAuditContext, throttle } from "@/lib/http/context";
import { getConfig } from "@/lib/config/env";
import { feedbackSubmitSchema, submitFeedback } from "@/lib/services/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/feedback — account-based feedback, delivered by email to a FIXED
 * server-side recipient. Never reports success unless the provider accepted
 * the message; persists the submission idempotently before attempting delivery.
 */
export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuditContext(req); // signed-in accounts only — anonymous 401
  assertSameOrigin(req, getConfig().appUrl);
  throttle(req, ctx, "feedback:submit", 6);
  const input = feedbackSubmitSchema.parse(await readJson(req));

  const outcome = await submitFeedback({
    store: getAccountRepository(),
    mailer: createFeedbackMailer(),
    userId: ctx.user.id,
    accountEmail: ctx.user.email ?? null,
    input,
  });

  switch (outcome.kind) {
    case "delivered":
      return ok({ delivered: true, submissionId: outcome.submissionId }, { status: 201 });
    case "already_recorded":
      return ok({ delivered: true, alreadyRecorded: true, submissionId: outcome.submissionId });
    case "email_not_configured":
      throw new ApiError(503, "email_not_configured", "We saved your feedback, but email delivery is not configured on this deployment, so nothing was sent. Please try again later — or reach us through the contact page.");
    case "delivery_failed":
      throw new ApiError(
        503,
        "feedback_delivery_failed",
        outcome.retryable
          ? "The email provider could not deliver your feedback just now. It is saved; please retry — the same form entry will deliver at most once."
          : "The email delivery outcome could not be confirmed, so it was not retried automatically (that is how duplicate emails happen). Your feedback is saved.",
      );
  }
});
