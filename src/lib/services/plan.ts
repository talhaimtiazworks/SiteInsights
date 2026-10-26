import "server-only";
import { getConfig } from "../config/env";
import { maybeAccountRepository } from "../db";
import type { SubscriptionInfo } from "../db/account-types";
import { isPlanId } from "../billing/plans";
import { getEntitlements, type Entitlements } from "../usage/entitlements";

/** History is not pruned below the previous plan's limit for this long after a paid plan ends. */
export const DOWNGRADE_HISTORY_GRACE_MS = 30 * 86_400_000;

export interface PlanResolution {
  ent: Entitlements;
  /** The verified subscription granting the paid plan (null = Free). */
  subscription: SubscriptionInfo | null;
}

/**
 * Resolves a principal's plan from TRUSTED server data only: a subscription
 * row written by a verified billing event (or the audited operator CLI) whose
 * paid period has not ended. Anything else — including every client-supplied
 * value — yields the Free plan.
 */
export async function resolvePlan(principalId: string): Promise<PlanResolution> {
  const cfg = getConfig();
  if (!principalId.startsWith("user:")) return { ent: getEntitlements({ id: principalId, plan: "free", isUser: false }, cfg), subscription: null };
  const userId = principalId.slice(5);
  const accounts = maybeAccountRepository();
  if (accounts) {
    const sub = await accounts.getActiveSubscription(userId);
    if (sub && isPlanId(sub.planId) && sub.planId !== "free") {
      return { ent: getEntitlements({ id: principalId, plan: sub.planId, isUser: true }, cfg), subscription: sub };
    }
    const ended = await accounts.getRecentlyEndedSubscription(userId, new Date(Date.now() - DOWNGRADE_HISTORY_GRACE_MS)).catch(() => null);
    const floor = ended && isPlanId(ended.planId) ? cfg.plans.plans[ended.planId].historyLimit : 0;
    return { ent: getEntitlements({ id: principalId, plan: "free", isUser: true, historyFloor: floor }, cfg), subscription: null };
  }
  return { ent: getEntitlements({ id: principalId, plan: "free", isUser: true }, cfg), subscription: null };
}

export async function entitlementsForPrincipal(principalId: string): Promise<Entitlements> {
  return (await resolvePlan(principalId)).ent;
}
