import type { PlanId } from "./plans";

/**
 * Provider-agnostic billing contracts. A payment provider (Lemon Squeezy,
 * Paddle, Stripe, …) is integrated by implementing `BillingProvider` and
 * registering it in billing/registry.ts. Plan and credit logic never depends
 * on a specific provider: adapters only translate VERIFIED provider webhooks
 * into `NormalizedBillingEvent`s, which billing/reducer.ts applies.
 */

export type PaidPlanId = Exclude<PlanId, "free">;

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "incomplete";

export type BillingEventType =
  /** First successful payment of a new subscription. */
  | "subscription.activated"
  /** A renewal payment succeeded; the billing period advanced. */
  | "subscription.renewed"
  /** Plan change or cancel-at-period-end toggle (no payment implied). */
  | "subscription.updated"
  /** The customer cancelled. With cancelAtPeriodEnd the plan stays active until periodEnd. */
  | "subscription.canceled"
  /** The subscription ended (period over after cancellation, or unpaid). */
  | "subscription.expired"
  /** A renewal payment failed: status past_due, no new credits until it is paid. */
  | "payment.failed"
  /** A previously failed payment succeeded. */
  | "payment.recovered";

export interface NormalizedBillingEvent {
  provider: string;
  /** Provider's unique event id (used for idempotency). */
  eventId: string;
  type: BillingEventType;
  occurredAt: Date;
  /** SiteInsights account id. Adapters must take it from data SiteInsights attached at checkout, never from free-form customer input. */
  userId: string;
  /** Provider subscription id. */
  subscriptionRef: string;
  planId?: PaidPlanId | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}

export interface StoredSubscription {
  id: string;
  userId: string;
  planId: string;
  status: SubscriptionStatus;
  provider: string;
  providerReference: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean;
  endedAt: Date | null;
  lastEventAt: Date | null;
}

export type BillingOutcome =
  | "applied"
  | "duplicate"
  | "ignored_stale"
  | "ignored_unknown_subscription"
  | "rejected_invalid"
  | "rejected_unknown_user";

export interface ApplyBillingResult {
  outcome: BillingOutcome;
  subscription: StoredSubscription | null;
  message?: string;
}

export class BillingSignatureError extends Error {
  constructor(message = "Webhook signature verification failed.") {
    super(message);
  }
}

export interface CheckoutInput {
  userId: string;
  email: string | null;
  planId: PaidPlanId;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingProvider {
  readonly id: string;
  readonly displayName: string;
  /** Hosted checkout. The provider collects card details; SiteInsights never sees them. */
  createCheckout(input: CheckoutInput): Promise<{ url: string }>;
  /** Hosted customer portal (update card, cancel, invoices). */
  createPortal?(input: { userId: string; subscriptionRef: string; returnUrl: string }): Promise<{ url: string }>;
  /** Verifies the provider signature over the RAW request body. Throws BillingSignatureError when invalid. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<NormalizedBillingEvent[]>;
}
