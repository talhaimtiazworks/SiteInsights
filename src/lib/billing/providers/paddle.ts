import { createHmac, timingSafeEqual } from "node:crypto";
import "server-only";
import type { PaddleConfig } from "../../config/env";
import { BillingSignatureError, type BillingProvider, type CheckoutInput, type NormalizedBillingEvent, type PaidPlanId } from "../types";

/**
 * Paddle billing adapter (hosted checkout + verified webhooks).
 *
 * Implementation follows the vendor skills in `.agents/skills/paddle-*`:
 *  - Checkout: server-side `POST /transactions` (items + custom_data). The
 *    returned `checkout.url` is a Paddle-hosted checkout link; Paddle collects
 *    the card and the customer email, SiteInsights never sees them. Returning
 *    from checkout grants nothing — only the verified webhook does (enforced
 *    by billing/service.ts). Note: Paddle hosted links do not accept
 *    per-transaction success/cancel URLs; the redirect UX is governed by the
 *    account's default payment link (Paddle > Checkout configuration).
 *  - Webhooks: HMAC-SHA256 signature in the `paddle-signature` header
 *    (`ts=<unix>;h1=<hex>`) computed over `${ts}:${rawBody}` with the
 *    notification-destination secret. The timestamp is rejected when more than
 *    SIGNATURE_TS_MAX_SKEW_MS old (matches the official SDK behavior per
 *    paddle-webhooks; keep the server clock on NTP).
 *  - Events are mapped to NormalizedBillingEvent; idempotency, ordering and
 *    unknown-user/subscription handling live in billing/reducer.ts and the
 *    repository, exactly as for every other provider.
 *
 * Renewal transactions: Paddle copies the checkout's custom_data onto the
 * subscription, and subscription custom data onto the transactions Paddle
 * creates for it (renewals/dunning), so the account reference survives the
 * whole lifecycle. Plan identity always comes from the price id on the event
 * items (PADDLE_PRICE_PRO / PADDLE_PRICE_BUSINESS), never from client input.
 */

const SIGNATURE_TS_MAX_SKEW_MS = 5_000;
const API_TIMEOUT_MS = 20_000;

const API_BASE: Record<PaddleConfig["environment"], string> = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
};

interface Envelope {
  event_id?: unknown;
  event_type?: unknown;
  occurred_at?: unknown;
  notification_id?: unknown;
  data?: unknown;
}

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const asString = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

function parseSignatureHeader(header: string): { ts: string; h1: string } | null {
  let ts: string | null = null;
  let h1: string | null = null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "ts") ts = value;
    if (key === "h1") h1 = value;
  }
  return ts && h1 ? { ts, h1 } : null;
}

/** Verifies `paddle-signature` over the raw body. Throws BillingSignatureError on ANY verification failure. */
function verifySignature(rawBody: string, header: string | null, secret: string, nowMs: number): void {
  if (!header) throw new BillingSignatureError("Paddle webhook is missing the paddle-signature header.");
  const parsed = parseSignatureHeader(header);
  if (!parsed) throw new BillingSignatureError("Paddle webhook signature header is malformed.");
  const tsMs = Number(parsed.ts) * 1000;
  if (!Number.isFinite(tsMs)) throw new BillingSignatureError("Paddle webhook signature timestamp is malformed.");
  if (Math.abs(nowMs - tsMs) > SIGNATURE_TS_MAX_SKEW_MS) throw new BillingSignatureError("Paddle webhook signature timestamp is outside the accepted window.");
  const expected = createHmac("sha256", secret).update(`${parsed.ts}:${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parsed.h1, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BillingSignatureError();
}

function planForPrice(cfg: PaddleConfig, priceId: string | null): PaidPlanId | null {
  if (!priceId) return null;
  if (priceId === cfg.pricePro) return "pro";
  if (priceId === cfg.priceBusiness) return "business";
  return null;
}

function priceForPlan(cfg: PaddleConfig, planId: PaidPlanId): string | null {
  return planId === "pro" ? cfg.pricePro : cfg.priceBusiness;
}

function firstPriceId(data: Json | null): string | null {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const first = asObject(items[0]);
  const price = first ? asObject(first.price) : null;
  return price ? asString(price.id) : null;
}

function periodFrom(obj: Json | null): { periodStart: Date | null; periodEnd: Date | null } {
  const p = obj ? asObject(obj.current_billing_period) ?? asObject(obj.billing_period) : null;
  const starts = p ? asString(p.starts_at) : null;
  const ends = p ? asString(p.ends_at) : null;
  const periodStart = starts ? new Date(starts) : null;
  const periodEnd = ends ? new Date(ends) : null;
  return {
    periodStart: periodStart && !Number.isNaN(periodStart.getTime()) ? periodStart : null,
    periodEnd: periodEnd && !Number.isNaN(periodEnd.getTime()) ? periodEnd : null,
  };
}

/**
 * Maps one verified Paddle envelope to a NormalizedBillingEvent, or returns
 * null for event types the plan-billing flow does not use (customer.*,
 * subscription.paused interstitials, one-off transactions, …). Unmapped
 * events are acknowledged and ignored, never fatal.
 */
function mapEvent(cfg: PaddleConfig, envelope: Json): NormalizedBillingEvent | null {
  const eventType = asString(envelope.event_type);
  const eventId = asString(envelope.event_id);
  const occurredAtRaw = asString(envelope.occurred_at);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : null;
  const data = asObject(envelope.data);
  if (!eventType || !eventId || !occurredAt || Number.isNaN(occurredAt.getTime()) || !data) {
    return null;
  }
  const custom = asObject(data.custom_data);
  const userId = (custom && asString(custom.userId)) ?? "";
  const base = { provider: "paddle", eventId, occurredAt, userId };

  if (eventType === "subscription.created" || eventType === "subscription.activated") {
    const subscriptionRef = asString(data.id);
    if (!subscriptionRef) return null;
    const { periodStart, periodEnd } = periodFrom(data);
    return {
      ...base,
      type: "subscription.activated",
      subscriptionRef,
      planId: planForPrice(cfg, firstPriceId(data)),
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: asObject(data.scheduled_change)?.action === "cancel",
    };
  }
  if (eventType === "subscription.updated") {
    const subscriptionRef = asString(data.id);
    if (!subscriptionRef) return null;
    const action = asObject(data.scheduled_change)?.action ?? null;
    if (asString(data.status) === "paused") return { ...base, type: "subscription.expired", subscriptionRef };
    if (action === "cancel") return { ...base, type: "subscription.canceled", subscriptionRef, cancelAtPeriodEnd: true };
    return { ...base, type: "subscription.updated", subscriptionRef, planId: planForPrice(cfg, firstPriceId(data)), cancelAtPeriodEnd: action !== "resume" ? false : undefined };
  }
  if (eventType === "subscription.canceled") {
    const subscriptionRef = asString(data.id);
    return subscriptionRef ? { ...base, type: "subscription.expired", subscriptionRef } : null;
  }
  if (eventType === "transaction.completed") {
    const subscriptionRef = asString(data.subscription_id);
    // One-off sales and the subscription's own first payment are covered by
    // subscription.created; only true renewals advance the billing period.
    if (!subscriptionRef || asString(data.origin) !== "subscription_recurring") return null;
    const { periodStart, periodEnd } = periodFrom(data);
    return { ...base, type: "subscription.renewed", subscriptionRef, planId: planForPrice(cfg, firstPriceId(data)), periodStart, periodEnd };
  }
  if (eventType === "transaction.payment_failed") {
    const subscriptionRef = asString(data.subscription_id);
    return subscriptionRef ? { ...base, type: "payment.failed", subscriptionRef } : null;
  }
  return null;
}

async function apiRequest(cfg: PaddleConfig, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json | null }> {
  const res = await fetch(`${API_BASE[cfg.environment]}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
      "Paddle-Version": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  let json: Json | null = null;
  try {
    json = text ? (asObject(JSON.parse(text)) ?? null) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** API key prefixes per Paddle environment (public format information — not secrets). */
export const PADDLE_KEY_PREFIX: Record<PaddleConfig["environment"], string> = {
  sandbox: "pdl_sdbx_apikey_",
  production: "pdl_live_apikey_",
};

/**
 * Builds the Paddle adapter, or null when the required credentials/prices are
 * incomplete. Fails closed when PADDLE_ENV and the API key point at different
 * environments (sdbx key in Live or live key in Sandbox) — a mismatched pair
 * can never create a real or expected checkout; it stays disabled instead.
 */
export function createPaddleProvider(cfg: PaddleConfig): BillingProvider | null {
  if (!cfg.apiKey || !cfg.webhookSecret || !cfg.pricePro || !cfg.priceBusiness) return null;
  if (!cfg.apiKey.startsWith(PADDLE_KEY_PREFIX[cfg.environment])) return null;
  if (!cfg.pricePro.startsWith("pri_") || !cfg.priceBusiness.startsWith("pri_")) return null;
  const secret = cfg.webhookSecret;
  return {
    id: "paddle",
    displayName: "Paddle",
    async createCheckout(input: CheckoutInput): Promise<{ url: string }> {
      const priceId = priceForPlan(cfg, input.planId);
      if (!priceId) throw new Error(`Paddle price id is not configured for plan "${input.planId}".`);
      void input.successUrl;
      void input.cancelUrl;
      const { status, json } = await apiRequest(cfg, "POST", "/transactions", {
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: { userId: input.userId, planId: input.planId },
      });
      // Error payloads never contain the API key; surface Paddle's opaque error code only.
      const errObj = asObject(json?.error);
      const code = errObj ? asString(errObj.code) : null;
      if (status < 200 || status >= 300) throw new Error(`Paddle checkout creation failed (HTTP ${status}${code ? `, ${code}` : ""}).`);
      const checkout = asObject(asObject(json?.data)?.checkout);
      const checkoutUrl = checkout ? asString(checkout.url) : null;
      if (!checkoutUrl) {
        throw new Error("Paddle did not return a hosted checkout URL. Set the account default payment link (Paddle > Checkout configuration) and approve the checkout domain, then try again.");
      }
      return { url: checkoutUrl };
    },
    async createPortal(input: { userId: string; subscriptionRef: string; returnUrl: string }): Promise<{ url: string }> {
      void input.userId;
      void input.returnUrl;
      const sub = await apiRequest(cfg, "GET", `/subscriptions/${encodeURIComponent(input.subscriptionRef)}`);
      const customerId = asString(asObject(sub.json?.data)?.customer_id);
      if (sub.status < 200 || sub.status >= 300 || !customerId) throw new Error(`Paddle portal is unavailable (subscription lookup failed, HTTP ${sub.status}).`);
      const session = await apiRequest(cfg, "POST", `/customers/${encodeURIComponent(customerId)}/portal-sessions`, { subscription_ids: [input.subscriptionRef] });
      const urls = asObject(asObject(session.json?.data)?.urls);
      const general = urls ? asObject(urls.general) : null;
      const url = general ? asString(general.overview) : null;
      if (session.status < 200 || session.status >= 300 || !url) throw new Error(`Paddle portal session creation failed (HTTP ${session.status}).`);
      return { url };
    },
    async verifyWebhook(rawBody: string, headers: Headers): Promise<NormalizedBillingEvent[]> {
      verifySignature(rawBody, headers.get("paddle-signature"), secret, Date.now());
      let envelope: Json;
      try {
        const parsed = JSON.parse(rawBody) as Envelope;
        const obj = asObject(parsed);
        if (!obj) throw new Error("not an object");
        envelope = obj;
      } catch {
        // A validly-signed but unparseable payload cannot form a billing event.
        return [];
      }
      const event = mapEvent(cfg, envelope);
      return event ? [event] : [];
    },
  };
}
