import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPaddleEnv, type PaddleConfig } from "@/lib/config/env";
import { createPaddleProvider } from "@/lib/billing/providers/paddle";
import { BillingSignatureError } from "@/lib/billing/types";

const SECRET = "pdl_ntfset_testsecret_27chars_ok";
const cfg = (over: Partial<PaddleConfig> = {}): PaddleConfig => ({
  environment: "sandbox",
  apiKey: "pdl_sdbx_apikey_test123456",
  webhookSecret: SECRET,
  pricePro: "pri_01protestprice00000000001",
  priceBusiness: "pri_01businesstestprice0000001",
  ...over,
});

const sign = (body: string, secret = SECRET, tsSec = Math.floor(Date.now() / 1000)) =>
  `ts=${tsSec};h1=${createHmac("sha256", secret).update(`${tsSec}:${body}`, "utf8").digest("hex")}`;
const headersFor = (body: string, secret?: string) => new Headers({ "paddle-signature": sign(body, secret) });

const T0 = "2026-10-01T00:00:00.000000Z";
const T1 = "2026-10-31T00:00:00.000000Z";
const envelope = (eventType: string, data: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ event_id: `evt_${Math.random().toString(36).slice(2, 12)}`, event_type: eventType, occurred_at: T0, notification_id: "ntf_01x", data, ...over });

const subData = (over: Record<string, unknown> = {}) => ({
  id: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz",
  customer_id: "ctm_01hyyyyyyyyyyyyyyyyyyyyy",
  status: "active",
  items: [{ price: { id: "pri_01protestprice00000000001", product_id: "pro_01x" }, quantity: 1 }],
  custom_data: { userId: "user-1", planId: "pro" },
  current_billing_period: { starts_at: T0, ends_at: T1 },
  scheduled_change: null,
  ...over,
});

const provider = () => {
  const p = createPaddleProvider(cfg());
  expect(p).not.toBeNull();
  return p!;
};

describe("readPaddleEnv", () => {
  it("defaults to sandbox and reads all variables", () => {
    const c = readPaddleEnv({ PADDLE_API_KEY: "k", PADDLE_NOTIFICATION_WEBHOOK_SECRET: "s", PADDLE_PRICE_PRO: "pri_p", PADDLE_PRICE_BUSINESS: "pri_b" });
    expect(c).toEqual({ environment: "sandbox", apiKey: "k", webhookSecret: "s", pricePro: "pri_p", priceBusiness: "pri_b" });
  });
  it("honours PADDLE_ENV=production and the NEXT_PUBLIC_ fallback", () => {
    expect(readPaddleEnv({ PADDLE_ENV: "production" }).environment).toBe("production");
    expect(readPaddleEnv({ NEXT_PUBLIC_PADDLE_ENV: "production" }).environment).toBe("production");
    expect(readPaddleEnv({ PADDLE_ENV: "PRODUCTION" }).environment).toBe("production");
    expect(readPaddleEnv({ PADDLE_ENV: "sandbox" }).environment).toBe("sandbox");
    expect(readPaddleEnv({ PADDLE_ENV: "garbage" }).environment).toBe("sandbox");
    expect(readPaddleEnv({ PADDLE_ENV: "production", NEXT_PUBLIC_PADDLE_ENV: "sandbox" }).environment).toBe("production");
  });
  it("treats blank values as unset", () => {
    expect(readPaddleEnv({ PADDLE_API_KEY: "   " }).apiKey).toBeNull();
    expect(readPaddleEnv({}).webhookSecret).toBeNull();
  });
});

describe("adapter readiness", () => {
  it("returns null until every credential and price is present", () => {
    expect(createPaddleProvider(cfg({ apiKey: null }))).toBeNull();
    expect(createPaddleProvider(cfg({ webhookSecret: null }))).toBeNull();
    expect(createPaddleProvider(cfg({ pricePro: null }))).toBeNull();
    expect(createPaddleProvider(cfg({ priceBusiness: null }))).toBeNull();
    expect(createPaddleProvider(cfg())).not.toBeNull();
    expect(provider().displayName).toBe("Paddle");
  });

  it("fails closed when PADDLE_ENV and the API key point at different environments (Sandbox key in Live or live key in Sandbox)", () => {
    expect(createPaddleProvider(cfg({ environment: "production" }))).toBeNull(); // sandbox key prefix with production env
    expect(createPaddleProvider(cfg({ environment: "sandbox", apiKey: "pdl_live_apikey_wrongenv" }))).toBeNull();
    expect(createPaddleProvider(cfg({ environment: "production", apiKey: "pdl_live_apikey_ok12345" }))).not.toBeNull();
  });

  it("requires Paddle-shaped live price ids from the environment (never invented inside the adapter)", () => {
    expect(createPaddleProvider(cfg({ pricePro: "5usd-monthly" }))).toBeNull();
    expect(createPaddleProvider(cfg({ priceBusiness: "price_business" }))).toBeNull();
  });
});

describe("catalog integrity for the recorded operator-provided Live ids", () => {
  it("price and product ids come ONLY from the environment — the source hard-codes no Paddle catalog entry, sandbox or live", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/lib/billing/providers/paddle.ts"), "utf8")
      + readFileSync(path.resolve(__dirname, "../src/lib/billing/service.ts"), "utf8")
      + readFileSync(path.resolve(__dirname, "../src/lib/config/env.ts"), "utf8");
    for (const operatorId of ["pro_01m5hyjd0q4x20deprhgwfpd75", "pri_01m5hyrz2y48g8x550kwap9dtc", "pro_01m5hyxf5cmr5qt9dmp45dyv58", "pri_01m5hyyt5mh8vy7sjatbcqex84"]) {
      expect(source, operatorId).not.toContain(operatorId); // see report / docs/BILLING.md — never hard-coded, never substituted
    }
    expect(source).not.toMatch(/\bpri_[0-9a-z]{24,}\b/i); // no anonymous paddle price literals at all
    expect(source).not.toMatch(/\bpro_[0-9a-z]{24,}\b/i);
  });

  it("the environment reader picks up the exact recorded Live ids verbatim when the operator supplies them", () => {
    const c = readPaddleEnv({
      PADDLE_ENV: "production",
      PADDLE_PRICE_PRO: "pri_01m5hyrz2y48g8x550kwap9dtc",
      PADDLE_PRICE_BUSINESS: "pri_01m5hyyt5mh8vy7sjatbcqex84",
    });
    expect(c.pricePro).toBe("pri_01m5hyrz2y48g8x550kwap9dtc");
    expect(c.priceBusiness).toBe("pri_01m5hyyt5mh8vy7sjatbcqex84");
    expect(c.environment).toBe("production");
  });

  it("checkout passes the configured price id to Paddle verbatim (no substitution, no duplicate-catalog creation)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { checkout: { url: "https://checkout.paddle.com/x?_ptxn=t" } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const p = createPaddleProvider(cfg({ environment: "production", apiKey: "pdl_live_apikey_test000", pricePro: "pri_01m5hyrz2y48g8x550kwap9dtc", priceBusiness: "pri_01m5hyyt5mh8vy7sjatbcqex84" }))!;
      await p.createCheckout({ userId: "u", email: null, planId: "business", successUrl: "s", cancelUrl: "c" });
      expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).items).toEqual([{ price_id: "pri_01m5hyyt5mh8vy7sjatbcqex84", quantity: 1 }]);
      await p.createCheckout({ userId: "u", email: null, planId: "pro", successUrl: "s", cancelUrl: "c" });
      expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)).items).toEqual([{ price_id: "pri_01m5hyrz2y48g8x550kwap9dtc", quantity: 1 }]);
      expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://api.paddle.com/transactions");
      // Nothing else is created in the account: a single POST /transactions per checkout, no product/price mutations.
      for (const call of fetchMock.mock.calls) expect((call as unknown as [string])[0]).toMatch(/\/transactions$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("webhook signature verification", () => {
  const body = envelope("customer.created", { id: "ctm_01x", email: "a@example.com" });
  it("accepts a correctly signed request", async () => {
    await expect(provider().verifyWebhook(body, headersFor(body))).resolves.toEqual([]);
  });
  it("rejects a missing signature header", async () => {
    await expect(provider().verifyWebhook(body, new Headers())).rejects.toBeInstanceOf(BillingSignatureError);
  });
  it("rejects a malformed signature header", async () => {
    await expect(provider().verifyWebhook(body, new Headers({ "paddle-signature": "nonsense" }))).rejects.toBeInstanceOf(BillingSignatureError);
    await expect(provider().verifyWebhook(body, new Headers({ "paddle-signature": "ts=123" }))).rejects.toBeInstanceOf(BillingSignatureError);
    await expect(provider().verifyWebhook(body, new Headers({ "paddle-signature": "ts=abc;h1=00" }))).rejects.toBeInstanceOf(BillingSignatureError);
  });
  it("rejects a signature computed with the wrong secret", async () => {
    await expect(provider().verifyWebhook(body, headersFor(body, "pdl_ntfset_wrongsecret________"))).rejects.toBeInstanceOf(BillingSignatureError);
  });
  it("rejects a tampered body", async () => {
    const sealed = headersFor(body);
    await expect(provider().verifyWebhook(body.replace("a@example.com", "b@example.com"), sealed)).rejects.toBeInstanceOf(BillingSignatureError);
  });
  it("rejects stale and future timestamps", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(provider().verifyWebhook(body, new Headers({ "paddle-signature": sign(body, SECRET, now - 30) }))).rejects.toBeInstanceOf(BillingSignatureError);
    await expect(provider().verifyWebhook(body, new Headers({ "paddle-signature": sign(body, SECRET, now + 30) }))).rejects.toBeInstanceOf(BillingSignatureError);
  });
  it("rejects an h1 of the wrong length without throwing a system error", async () => {
    const ts = Math.floor(Date.now() / 1000);
    await expect(provider().verifyWebhook(body, new Headers({ "paddle-signature": `ts=${ts};h1=abcd` }))).rejects.toBeInstanceOf(BillingSignatureError);
  });
});

describe("event mapping", () => {
  it("subscription.created activates the plan from the event's price id and billing period", async () => {
    const body = envelope("subscription.created", subData());
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ provider: "paddle", type: "subscription.activated", userId: "user-1", subscriptionRef: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz", planId: "pro", cancelAtPeriodEnd: false });
    expect(ev!.periodStart!.toISOString()).toBe(new Date(T0).toISOString());
    expect(ev!.periodEnd!.toISOString()).toBe(new Date(T1).toISOString());
    expect(ev!.occurredAt.toISOString()).toBe(new Date(T0).toISOString());
  });
  it("subscription.activated (trial conversion) also activates, for the business price", async () => {
    const data = subData({ status: "active", items: [{ price: { id: "pri_01businesstestprice0000001", product_id: "pro_01x" }, quantity: 1 }] });
    const body = envelope("subscription.activated", data);
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "subscription.activated", planId: "business" });
  });
  it("subscription.updated with a scheduled cancel maps to canceled-at-period-end", async () => {
    const body = envelope("subscription.updated", subData({ scheduled_change: { action: "cancel", effective_at: T1 } }));
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "subscription.canceled", cancelAtPeriodEnd: true });
  });
  it("subscription.updated without a scheduled change keeps access and may carry a new plan", async () => {
    const body = envelope("subscription.updated", subData({ scheduled_change: { action: "resume", effective_at: T1 } }));
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "subscription.updated", planId: "pro", cancelAtPeriodEnd: undefined });
  });
  it("subscription.updated reporting a paused subscription ends access", async () => {
    const body = envelope("subscription.updated", subData({ status: "paused" }));
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "subscription.expired" });
  });
  it("subscription.canceled is the terminal expiry", async () => {
    const body = envelope("subscription.canceled", subData({ status: "canceled" }));
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "subscription.expired" });
  });
  it("transaction.completed for a renewal advances the period (plan from price id, even if custom data lies)", async () => {
    const txn = {
      id: "txn_01hxxxxxxxxxxxxxxxxxxxxxxxx",
      status: "completed",
      origin: "subscription_recurring",
      subscription_id: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz",
      items: [{ price: { id: "pri_01businesstestprice0000001", product_id: "pro_01x" }, quantity: 1 }],
      billing_period: { starts_at: T0, ends_at: T1 },
      custom_data: { userId: "user-1", planId: "pro" },
    };
    const body = envelope("transaction.completed", txn);
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "subscription.renewed", subscriptionRef: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz", planId: "business", userId: "user-1" });
    expect(ev!.periodEnd!.toISOString()).toBe(new Date(T1).toISOString());
  });
  it("ignores the first checkout transaction and non-recurring transactions", async () => {
    const first = envelope("transaction.completed", { id: "txn_01", origin: "web", subscription_id: "sub_01", items: [], billing_period: { starts_at: T0, ends_at: T1 }, custom_data: { userId: "user-1" } });
    expect(await provider().verifyWebhook(first, headersFor(first))).toEqual([]);
    const oneOff = envelope("transaction.completed", { id: "txn_02", origin: "web" });
    expect(await provider().verifyWebhook(oneOff, headersFor(oneOff))).toEqual([]);
  });
  it("transaction.payment_failed maps to payment.failed", async () => {
    const body = envelope("transaction.payment_failed", { id: "txn_03", subscription_id: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz", custom_data: { userId: "user-1" } });
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "payment.failed", subscriptionRef: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz", userId: "user-1" });
  });
  it("ignores customer.* and unknown events, and validly-signed non-JSON payloads", async () => {
    const customer = envelope("customer.created", { id: "ctm_01", email: "a@example.com" });
    expect(await provider().verifyWebhook(customer, headersFor(customer))).toEqual([]);
    const unknown = envelope("adjustment.created", { id: "adj_01" });
    expect(await provider().verifyWebhook(unknown, headersFor(unknown))).toEqual([]);
    const garbage = "this is not json";
    expect(await provider().verifyWebhook(garbage, headersFor(garbage))).toEqual([]);
  });
  it("passes a null plan through untouched when the price is not ours (the reducer rejects it safely)", async () => {
    const body = envelope("subscription.created", subData({ items: [{ price: { id: "pri_01someoneelsesprice000000", product_id: "pro_01x" }, quantity: 1 }] }));
    const [ev] = await provider().verifyWebhook(body, headersFor(body));
    expect(ev).toMatchObject({ type: "subscription.activated", planId: null });
  });
});

describe("hosted checkout", () => {
  afterEach(() => vi.unstubAllGlobals());
  const okJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

  it("creates a transaction and returns the hosted checkout URL, using the sandbox API base", async () => {
    const fetchMock = vi.fn(async () => okJson({ data: { id: "txn_01hzzzzzzzzzzzzzzzzzzzzzzz", checkout: { url: "https://sandbox-checkout.paddle.com/transaction?_ptxn=txn_01" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await provider().createCheckout({ userId: "user-1", email: "u@example.com", planId: "pro", successUrl: "https://app/billing", cancelUrl: "https://app/pricing" });
    expect(out).toEqual({ url: "https://sandbox-checkout.paddle.com/transaction?_ptxn=txn_01" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox-api.paddle.com/transactions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer pdl_sdbx_apikey_test123456`);
    expect((init.headers as Record<string, string>)["Paddle-Version"]).toBe("1");
    const sent = JSON.parse(String(init.body));
    expect(sent.items).toEqual([{ price_id: "pri_01protestprice00000000001", quantity: 1 }]);
    expect(sent.custom_data).toEqual({ userId: "user-1", planId: "pro" });
  });
  it("uses the production API base in production and never leaks the secret", async () => {
    const fetchMock = vi.fn(async () => okJson({ data: { checkout: { url: "https://checkout.paddle.com/x?_ptxn=txn_02" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const p = createPaddleProvider(cfg({ environment: "production", apiKey: "pdl_live_apikey_shouldnotleak" }))!;
    await p.createCheckout({ userId: "user-2", email: null, planId: "business", successUrl: "https://app/billing", cancelUrl: "https://app/pricing" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.paddle.com/transactions");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("pdl_ntfset");
  });
  it("throws a Paddle error code on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ error: { code: "transaction_checkout_not_enabled", detail: "x" } }, 400)));
    await expect(provider().createCheckout({ userId: "u", email: null, planId: "pro", successUrl: "s", cancelUrl: "c" })).rejects.toThrow(/HTTP 400, transaction_checkout_not_enabled/);
  });
  it("explains the missing default payment link when no checkout URL is returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ data: { id: "txn_03", checkout: { url: null } } })));
    await expect(provider().createCheckout({ userId: "u", email: null, planId: "pro", successUrl: "s", cancelUrl: "c" })).rejects.toThrow(/default payment link/);
  });
});

describe("customer portal", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("creates a portal session for the subscription's customer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz", customer_id: "ctm_01hyyyyyyyyyyyyyyyyyyyyy" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { urls: { general: { overview: "https://customer-portal.paddle.com/cpl_01?token=t" } } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await provider().createPortal!({ userId: "user-1", subscriptionRef: "sub_01hzzzzzzzzzzzzzzzzzzzzzzz", returnUrl: "https://app/billing" });
    expect(out.url).toBe("https://customer-portal.paddle.com/cpl_01?token=t");
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://sandbox-api.paddle.com/subscriptions/sub_01hzzzzzzzzzzzzzzzzzzzzzzz");
    const [portalUrl, portalInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(portalUrl).toBe("https://sandbox-api.paddle.com/customers/ctm_01hyyyyyyyyyyyyyyyyyyyyy/portal-sessions");
    expect(JSON.parse(String(portalInit.body))).toEqual({ subscription_ids: ["sub_01hzzzzzzzzzzzzzzzzzzzzzzz"] });
  });
  it("fails cleanly when the subscription cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(provider().createPortal!({ userId: "u", subscriptionRef: "sub_missing", returnUrl: "r" })).rejects.toThrow(/HTTP 404/);
  });
});
