import "server-only";
import { getConfig } from "../config/env";
import { createPaddleProvider } from "./providers/paddle";
import type { BillingProvider } from "./types";

/**
 * Billing provider registry.
 *
 * The Paddle adapter is installed (src/lib/billing/providers/paddle.ts). Paid
 * checkout stays disabled until the operator sets `BILLING_PROVIDER=paddle`
 * AND the adapter's credentials are complete (PADDLE_API_KEY,
 * PADDLE_NOTIFICATION_WEBHOOK_SECRET, PADDLE_PRICE_PRO, PADDLE_PRICE_BUSINESS).
 * Until then the pricing page shows "Payments coming soon", webhooks are
 * refused and paid plans can only be activated through the audited operator
 * CLI (scripts/billing/manage-subscription.mjs). See docs/BILLING.md.
 */
const ADAPTERS: Record<string, () => BillingProvider | null> = {
  paddle: () => createPaddleProvider(getConfig().billing.paddle),
};

export type BillingStatus =
  | { state: "not_configured"; provider: null; message: string }
  | { state: "misconfigured"; provider: string; message: string }
  | { state: "ready"; provider: string; displayName: string; message: string };

export const PAYMENTS_COMING_SOON = "SiteInsights is free for everyone — payments are retired. Historical billing records stay readable, but nothing can be purchased.";

export function billingStatus(): BillingStatus {
  const id = getConfig().billing.provider;
  if (!id) return { state: "not_configured", provider: null, message: PAYMENTS_COMING_SOON };
  const factory = ADAPTERS[id];
  const adapter = factory ? factory() : null;
  if (!adapter) return { state: "misconfigured", provider: id, message: `BILLING_PROVIDER is set to "${id}", but no verified adapter for it is installed or its credentials are missing. ${PAYMENTS_COMING_SOON}` };
  return { state: "ready", provider: id, displayName: adapter.displayName, message: "" };
}

/** The configured, fully initialised provider — or null (checkout disabled). */
export function getBillingProvider(id?: string): BillingProvider | null {
  const configured = getConfig().billing.provider;
  if (!configured || (id && id !== configured)) return null;
  const factory = ADAPTERS[configured];
  return factory ? factory() : null;
}
