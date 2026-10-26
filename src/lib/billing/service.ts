import "server-only";
import { ensureCreditAccount, summarize } from "../credits/service";
import { getRepository, maybeAccountRepository } from "../db";
import { ApiError, readBodyText } from "../http/api";
import type { RequestContext } from "../http/context";
import { logger } from "../logger";
import { dashboardAccess } from "../services/dashboard";
import { getConfig } from "../config/env";
import { isPlanId } from "./plans";
import { billingStatus, getBillingProvider, PAYMENTS_COMING_SOON } from "./registry";
import { BillingSignatureError, type ApplyBillingResult, type PaidPlanId } from "./types";

/**
 * Provider-agnostic billing service.
 *
 * Paid access is granted ONLY by `applyBillingEvent` with an event that came
 * from (a) a provider webhook whose signature was verified by the adapter, or
 * (b) the operator CLI (scripts/billing/manage-subscription.mjs), which
 * requires direct database access. There is no client-side path, no
 * development bypass, and no "success URL" grant: returning from checkout
 * changes nothing until the verified webhook arrives.
 */

const MAX_WEBHOOK_BYTES = 256 * 1024;

export async function processBillingWebhook(providerId: string, req: Request): Promise<{ received: number; results: Array<{ eventId: string; outcome: ApplyBillingResult["outcome"] }> }> {
  const provider = getBillingProvider(providerId);
  // Same response for "no provider", "wrong provider" and "misconfigured": nothing to probe.
  if (!provider) throw new ApiError(404, "not_found", "Not found.");
  const accounts = maybeAccountRepository();
  if (!accounts) throw new ApiError(503, "database_required", "Billing requires the PostgreSQL database.");
  const raw = await readBodyText(req, MAX_WEBHOOK_BYTES);
  let events;
  try {
    events = await provider.verifyWebhook(raw, req.headers);
  } catch (err) {
    if (err instanceof BillingSignatureError) {
      logger.warn("Rejected billing webhook with an invalid signature", { provider: providerId });
      throw new ApiError(401, "invalid_signature", "Invalid signature.");
    }
    throw err;
  }
  const results = [];
  for (const ev of events) {
    if (ev.provider !== provider.id) throw new ApiError(400, "invalid_event", "Event provider mismatch.");
    const res = await accounts.applyBillingEvent(ev);
    results.push({ eventId: ev.eventId, outcome: res.outcome });
    if (res.outcome === "applied") {
      // Start the new credit period immediately (it would otherwise start on the next request).
      await ensureCreditAccount(`user:${ev.userId}`, getRepository()).catch((err) => logger.warn("Could not refresh credits after a billing event", err));
    }
  }
  return { received: events.length, results };
}

export async function startCheckout(ctx: RequestContext, planId: string, origin: string): Promise<{ url: string }> {
  await dashboardAccess(ctx);
  if (!isPlanId(planId) || planId === "free") throw new ApiError(400, "invalid_plan", "Choose the Pro or Business plan.");
  const status = billingStatus();
  const provider = getBillingProvider();
  if (status.state !== "ready" || !provider) throw new ApiError(503, "payments_not_configured", PAYMENTS_COMING_SOON, { billing: status.state });
  const base = (getConfig().appUrl ?? origin).replace(/\/$/, "");
  return provider.createCheckout({ userId: ctx.user!.id, email: ctx.user!.email, planId: planId as PaidPlanId, successUrl: `${base}/billing?checkout=returned`, cancelUrl: `${base}/billing` });
}

/** Everything the billing page needs, from trusted server data. */
export async function billingOverview(ctx: RequestContext) {
  const principalId = await dashboardAccess(ctx);
  const credits = await ensureCreditAccount(principalId, getRepository());
  const status = billingStatus();
  const sub = credits.subscription;
  return {
    plan: { id: credits.ent.plan, name: credits.ent.planLabel, priceUsd: credits.ent.priceUsd },
    subscription: sub
      ? { status: sub.status, provider: sub.provider, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd }
      : null,
    credits: summarize(credits),
    payments: { state: status.state, message: status.state === "ready" ? null : PAYMENTS_COMING_SOON },
  };
}
