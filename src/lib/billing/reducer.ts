import { randomUUID } from "node:crypto";
import { isPlanId } from "./plans";
import type { ApplyBillingResult, NormalizedBillingEvent, StoredSubscription } from "./types";

/**
 * Pure state transition for one VERIFIED billing event. Persistence layers call
 * this inside a transaction after recording the event id (idempotency), so the
 * same rules apply to every provider and to the audited manual process.
 *
 * Rules:
 *  - Events older than the last applied event for the subscription are ignored
 *    (providers may deliver out of order).
 *  - Paid access requires activation or renewal with a known paid plan and a
 *    future period end. Nothing here grants access from an unverified source:
 *    callers must have verified the provider signature first.
 *  - Failed payments mark the subscription past_due. Entitlements remain until
 *    the already-paid period ends; no new period (and therefore no new credit
 *    grant) starts until a renewal payment succeeds.
 *  - Cancellation at period end keeps access until the paid period ends;
 *    immediate cancellation or expiry ends access now.
 */
export function reduceSubscription(current: StoredSubscription | null, ev: NormalizedBillingEvent): ApplyBillingResult & { next: StoredSubscription | null } {
  const reject = (outcome: ApplyBillingResult["outcome"], message: string) => ({ outcome, subscription: current, next: null, message });
  if (!ev.subscriptionRef || !ev.userId) return reject("rejected_invalid", "Event is missing the subscription or account reference.");
  if (current && current.userId !== ev.userId) return reject("rejected_invalid", "Event account does not match the subscription's account.");
  if (current?.lastEventAt && ev.occurredAt.getTime() < current.lastEventAt.getTime()) return { outcome: "ignored_stale", subscription: current, next: null };

  const base: StoredSubscription =
    current ??
    ({
      id: randomUUID(),
      userId: ev.userId,
      planId: "free",
      status: "incomplete",
      provider: ev.provider,
      providerReference: ev.subscriptionRef,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAt: null,
      cancelAtPeriodEnd: false,
      endedAt: null,
      lastEventAt: null,
    } satisfies StoredSubscription);
  const next: StoredSubscription = { ...base, lastEventAt: ev.occurredAt };

  const needPeriod = () => {
    if (!ev.periodStart || !ev.periodEnd || ev.periodEnd.getTime() <= ev.periodStart.getTime()) return "A valid billing period is required.";
    return null;
  };

  switch (ev.type) {
    case "subscription.activated":
    case "subscription.renewed": {
      if (!ev.planId || !isPlanId(ev.planId) || ev.planId === ("free" as string)) return reject("rejected_invalid", "A paid plan is required.");
      const bad = needPeriod();
      if (bad) return reject("rejected_invalid", bad);
      if (ev.type === "subscription.renewed" && !current) return { outcome: "ignored_unknown_subscription", subscription: null, next: null };
      Object.assign(next, { planId: ev.planId, status: "active", currentPeriodStart: ev.periodStart, currentPeriodEnd: ev.periodEnd, endedAt: null });
      next.cancelAtPeriodEnd = ev.cancelAtPeriodEnd ?? false;
      next.cancelAt = next.cancelAtPeriodEnd ? ev.periodEnd! : null;
      break;
    }
    case "subscription.updated": {
      if (!current) return { outcome: "ignored_unknown_subscription", subscription: null, next: null };
      if (ev.planId) {
        if (!isPlanId(ev.planId) || ev.planId === ("free" as string)) return reject("rejected_invalid", "Unknown plan.");
        next.planId = ev.planId;
      }
      if (ev.cancelAtPeriodEnd !== undefined) {
        next.cancelAtPeriodEnd = ev.cancelAtPeriodEnd;
        next.cancelAt = ev.cancelAtPeriodEnd ? next.currentPeriodEnd : null;
      }
      break;
    }
    case "subscription.canceled": {
      if (!current) return { outcome: "ignored_unknown_subscription", subscription: null, next: null };
      const end = next.currentPeriodEnd;
      if (ev.cancelAtPeriodEnd !== false && end && end.getTime() > ev.occurredAt.getTime()) {
        next.cancelAtPeriodEnd = true;
        next.cancelAt = end;
      } else {
        Object.assign(next, { status: "canceled", endedAt: ev.occurredAt, cancelAt: ev.occurredAt, cancelAtPeriodEnd: false });
        if (!end || end.getTime() > ev.occurredAt.getTime()) next.currentPeriodEnd = ev.occurredAt;
      }
      break;
    }
    case "subscription.expired": {
      if (!current) return { outcome: "ignored_unknown_subscription", subscription: null, next: null };
      Object.assign(next, { status: "canceled", endedAt: ev.occurredAt, cancelAtPeriodEnd: false });
      if (!next.currentPeriodEnd || next.currentPeriodEnd.getTime() > ev.occurredAt.getTime()) next.currentPeriodEnd = ev.occurredAt;
      break;
    }
    case "payment.failed": {
      if (!current) return { outcome: "ignored_unknown_subscription", subscription: null, next: null };
      if (next.status !== "canceled") next.status = "past_due";
      break;
    }
    case "payment.recovered": {
      if (!current) return { outcome: "ignored_unknown_subscription", subscription: null, next: null };
      if (next.status === "past_due") next.status = "active";
      if (ev.periodStart && ev.periodEnd && !needPeriod()) Object.assign(next, { currentPeriodStart: ev.periodStart, currentPeriodEnd: ev.periodEnd });
      break;
    }
    default:
      return reject("rejected_invalid", "Unsupported event type.");
  }
  return { outcome: "applied", subscription: next, next };
}

/** Whether a stored subscription currently grants its paid plan. */
export function grantsPaidAccess(sub: Pick<StoredSubscription, "status" | "currentPeriodEnd" | "planId">, now = new Date()): boolean {
  if (sub.planId === "free") return false;
  if (!["active", "trialing", "past_due"].includes(sub.status)) return false;
  return !!sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime();
}
