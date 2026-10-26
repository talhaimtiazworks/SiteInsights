# Plans, credits and billing — DEPRECATED (free product)

> **As of the free-product conversion, SiteInsights is free for everyone.**
> All features (AI explanations, PDF reports, prospects, batch audits, share
> links) are included without any plan, subscription or credits.
> Audits are governed only by technical safeguards (per-visitor rolling
> windows, page caps, concurrency limits) described in `ENVIRONMENT.md`.
>
> **This document is retained for migration history only.** It explains how
> the retired plans/credits/billing layer worked and why its data must not be
> deleted: the `subscriptions`, `credit_accounts`, `credit_ledger`,
> billing-webhook events and customer records are PRESERVED and continue to be
> readable (e.g. on the Account & history page). Nothing in this file
> describes a purchase path — checkout is disabled product-wide and paid-plan
> activation no longer grants any extra capability. Safe cleanup of the
> historical rows must be done separately by maintainers; do not delete them
> as part of normal operation.

# (Legacy reference) Plans, credits and billing

SiteInsights had three plans (Free, Pro, Business), a monthly credit allowance
and a provider-agnostic billing layer. **No payment provider is integrated.**
Until one is added and configured, paid checkout is disabled everywhere
("Payments coming soon"), webhooks answer 404, and Pro or Business can only be
activated by an operator with the audited CLI described below. The Free plan
needs no billing configuration and is fully usable. The catalog currently displays
Free at **$0/month**, Pro at **$5/month**, and Business at **$10/month**. These are
display/catalog values only: paid checkout remains disabled, and changing catalog
prices does not alter existing subscriptions, customer records, credits or plan
entitlements.

## What is enforced where

| Concern | Source of truth |
|---|---|
| Plan catalog (limits, features, display prices) | `src/lib/billing/plans.ts` (defaults; only the documented limit/cost values below have environment overrides) |
| The plan a user is on | `src/lib/services/plan.ts` → `resolvePlan()`, read from the `subscriptions` table on the server only |
| Entitlements (pages, depth, features, daily limits) | `src/lib/usage/entitlements.ts` → `getEntitlements()` |
| Credits (grant, reserve, settle, charge, refund) | `src/lib/credits/service.ts` on the `credit_accounts` / `credit_ledger` tables |
| Subscription state machine | `src/lib/billing/reducer.ts` (pure, unit tested) |
| Provider adapters | `src/lib/billing/registry.ts` (currently empty) |

The browser never sends a plan or a balance. Every audit, AI request, PDF,
prospect, batch and share-link endpoint resolves entitlements and credits on the
server.

## Plans (defaults)

| | Free | Pro | Business |
|---|---|---|---|
| Price | $0 / month | $5 / month | $10 / month |
| Credits per month | 100 | 1,000 | 3,000 |
| Pages per audit | 25 | 150 | 500 |
| Crawl depth / links checked | 3 / 150 | 5 / 750 | 8 / 2,000 |
| Max audit duration | 3 min | 10 min | 25 min |
| Concurrent audits / audits per day | 1 / 10 | 2 / 50 | 3 / 200 |
| Audits kept in history | 100 | 500 | 2,000 |
| AI explanations, branded PDF | No | Yes (100 AI + 100 PDF per day) | Yes (300 + 300 per day) |
| Prospects, CSV export, share links, batch audits (10), opportunity ranking and advanced filters | No | No | Yes |

There is no priority queue. Audits from all plans are processed the same way;
paid plans get larger limits and more concurrency, not queue priority.

## Credits

| Operation | Cost |
|---|---|
| Start an audit | 10 |
| Each page successfully processed (unique final URL that returned a response) | 1 |
| AI explanation or summary | 2 |
| PDF report | 0 |

* **Before an audit starts**, the maximum cost (`10 + maxPages × 1`) is shown
  and reserved atomically. If the balance is too low, the API returns
  `402 insufficient_credits` with the largest affordable page count, and the
  UI offers that smaller audit instead.
* **When the audit ends**, the reservation is settled once (idempotency key
  `audit:<id>:settle`):
  * completed: charged `10 + processed pages`, the rest is returned;
  * cancelled: charged only for pages already processed;
  * failed, stalled or deleted before finishing: **full refund**.
* A failed AI request or PDF build is refunded automatically.
* Balances can never go negative (database `CHECK` plus a conditional update),
  and every movement is a ledger row with an idempotency key, so retries never
  double-charge or double-grant.
* **Monthly allowance**: one grant per billing period. Free periods are
  calendar months (UTC). Paid periods follow the subscription period. Unused
  credits expire at the end of the period (recorded as an `expire` entry).
  There is no rollover.

## Subscription lifecycle

| Event | Effect |
|---|---|
| `subscription.activated` | Plan becomes active for the paid period, and that period's credits are granted on the next request |
| `subscription.renewed` | New period, new allowance |
| `subscription.updated` | Plan or period change (upgrade or downgrade) |
| `subscription.canceled` (at period end) | Access continues until the paid period ends, then Free |
| `subscription.canceled` (immediate) / `subscription.expired` | Free from the next request |
| `payment.failed` | Status `past_due`. The plan stays until the already-paid period ends, but no new period or allowance starts until payment succeeds |
| `payment.recovered` | Back to `active` |

Events older than the last applied event are ignored (out-of-order delivery).
Each `(provider, event_id)` is stored once in `billing_events`, so retried
webhooks are no-ops. **Downgrades keep history**: audits are not deleted, and
for 30 days the previous plan's history limit still applies (`historyFloor`).
Prospects created on Business stay readable, exportable and deletable after a
downgrade, but they cannot be edited.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `BILLING_PROVIDER` | No | Id of an installed adapter (for example `paddle`). Unset means payments are disabled. If it is set to an id without an adapter, the status is "misconfigured" and checkout stays disabled. |
| *Provider credentials* | With an adapter | Defined by the adapter you add (API key, webhook signing secret, price ids). **None exist yet; do not invent them.** Keep them server-only (never `NEXT_PUBLIC_*`). |
| `CRON_SECRET` | Yes on serverless | Protects `/api/internal/process` and the daily sweep that settles stalled reservations and continues batches. |
| `PLAN_{FREE,PRO,BUSINESS}_{CREDITS,MAX_PAGES,MAX_DEPTH,MAX_LINKS,MAX_DURATION_MS,CONCURRENT_AUDITS,AUDITS_PER_DAY,HISTORY_LIMIT}` | No | Override plan limits. |
| `PLAN_{PRO,BUSINESS}_{AI_PER_DAY,PDF_PER_DAY}` | No | Daily AI and PDF caps for paid plans. |
| `CREDIT_COST_AUDIT_START`, `CREDIT_COST_PAGE`, `CREDIT_COST_AI`, `CREDIT_COST_PDF` | No | Override credit costs. |
| `SCAN_HARD_MAX_PAGES` (default 500, max 1000), `SCAN_HARD_MAX_DEPTH` | No | Operator-wide caps that no plan can exceed. |

## Database migration

`db/migrations/006_plans_credits_prospects.sql` is additive. It adds
`cancel_at_period_end`, `ended_at` and `last_event_at` to the existing
`subscriptions` table and creates `billing_events`, `credit_accounts`,
`credit_ledger`, `prospects`, `audit_batches`, `audit_batch_items` and
`report_shares` (RLS enabled; service-role access only). Existing users,
audits and history are untouched. Users without a subscription are on Free,
and their first request creates their credit account.

```bash
DATABASE_URL=postgres://… npm run db:migrate        # or paste db/supabase-setup.sql into the Supabase SQL editor
```

## Manual activation (operator CLI)

Use this for pilots, invoices paid outside the app, or support corrections. It
writes an audit record to `billing_events` (operator, reason, plan, months).

```bash
DATABASE_URL=postgres://… node scripts/billing/manage-subscription.mjs show  --user someone@example.com
DATABASE_URL=postgres://… node scripts/billing/manage-subscription.mjs grant --user someone@example.com --plan business --months 1 --reason "Invoice 1042" --confirm
DATABASE_URL=postgres://… node scripts/billing/manage-subscription.mjs end   --user someone@example.com --reason "Pilot finished" --confirm
```

* The user must have signed in once (a `profiles` row exists).
* `grant` ends any other live subscription first, then creates a non-renewing
  `manual` subscription for 1–12 months. Credits for the new period are
  granted on the user's next request.
* `end` affects only `manual` subscriptions. Provider subscriptions must be
  cancelled at the provider, and their webhook updates SiteInsights.
* Changes are refused without `--confirm` and a reason of at least 5
  characters. This behaviour is covered by `tests/billing.integration.test.ts`.

## Payments with Paddle (integrated adapter)

A Paddle adapter ships in `src/lib/billing/providers/paddle.ts` (registered in
`registry.ts`). It stays inactive — "Payments coming soon" — until
`BILLING_PROVIDER=paddle` and its five variables below are all set. Setup,
following the vendor skills in `.agents/skills/paddle-*`:

1. **Catalog** (skill *paddle-catalog-setup*): create one product per paid plan
   ("SiteInsights Pro", "SiteInsights Business") with a monthly USD price
   matching the published price. Copy each price id (`pri_…`) into
   `PADDLE_PRICE_PRO` / `PADDLE_PRICE_BUSINESS`. Plan limits and prices charged
   are defined here and by the catalog; the price id on each verified webhook
   decides the plan.
2. **API key** (Paddle > My account > Settings > Authentication → API keys):
   needs `transaction.write` (checkout transactions) plus read access to
   subscriptions and customers (for portal links). Store it as
   `PADDLE_API_KEY`. Server-only, never `NEXT_PUBLIC_`.
3. **Webhook destination** (skill *paddle-webhooks*): Paddle > Events >
   Notifications → New destination, type Webhook, URL
   `https://<your-domain>/api/billing/webhooks/paddle`, usage type **Both** in
   sandbox / Platform in production. Subscribe to `subscription.created`,
   `subscription.activated`, `subscription.updated`, `subscription.canceled`,
   `transaction.completed`, `transaction.payment_failed`. Copy the
   destination's Secret key into `PADDLE_NOTIFICATION_WEBHOOK_SECRET` — every
   destination has its own secret; sandbox and production must differ. The
   adapter acknowledges and ignores events it does not map (e.g.
   `customer.created`), so a broader subscription set is safe.
4. **Checkout configuration**: set the account's **default payment link**
   (Paddle > Checkout > Checkout configuration) to a page on your approved
   domain (live: approve the domain under Settings > Website approval; sandbox
   approves automatically). Paddle-hosted checkout links do not carry
   per-purchase redirect URLs: after paying, the customer is redirected by
   Paddle's configuration, and only the verified webhook activates the plan —
   see *Subscription lifecycle* above.
5. **Environment** (Vercel → Settings → Environment Variables, or
   `.env.local`): set `BILLING_PROVIDER=paddle`, `PADDLE_ENV=production`
   (omit or use `sandbox` for the sandbox environment),
   `PADDLE_API_KEY`, `PADDLE_NOTIFICATION_WEBHOOK_SECRET`,
   `PADDLE_PRICE_PRO`, `PADDLE_PRICE_BUSINESS`; redeploy. With all present the
   adapter reports ready (`/api/plans`, `/api/billing` →
   `payments.state = "ready"`); with any missing the app stays in the regular
   "Payments coming soon" state. `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` is **not**
   needed by this integration (it uses Paddle-hosted links, not Paddle.js); it
   stays unused.
6. **Sandbox testing** (skill *paddle-sandbox-testing*): use a sandbox API key
   and a sandbox destination (own secret). Buy Pro with Paddle's test card
   (`4242 4242 4242 4242`) and see `/billing` turn Pro; use the simulator for
   cancellation and payment-failure deliveries; confirm duplicate and
   out-of-order deliveries are no-ops in the `billing_events` ledger; deploy
   production credentials only after the sandbox cycle passes.

### Going live (production)

The same adapter serves production — no code change, no second webhook
handler, no duplicated catalog wiring. The cutover is configuration only:

1. **Live catalog**: create the Pro and Business products/prices in the
   *production* Paddle account (or promote them) and copy the **live** price
   ids (`pri_…`) into `PADDLE_PRICE_PRO` / `PADDLE_PRICE_BUSINESS`.
2. **Live API key** (`pdl_live_apikey_…`), `PADDLE_ENV=production` (selects
   `https://api.paddle.com`).
3. **Live webhook destination** to `https://<your-domain>/api/billing/webhooks/paddle`
   and put that destination's own secret into `PADDLE_NOTIFICATION_WEBHOOK_SECRET`.
4. **Approved domain + default payment link** for the live account (step 4
   above) — sandbox domains are not inherited.
5. Redeploy.

**Coherence is enforced, fail-closed.** If `PADDLE_ENV` and the API key point
at different environments (a `pdl_sdbx_apikey_…` key under `production`, or a
`pdl_live_apikey_…` key under `sandbox`), the adapter refuses to build and the
deployment stays in the "Payments coming soon" state — with a startup warning
naming the variables (never the values) — instead of charging the wrong
environment. The same refusal applies when a configured price id is not
shaped like `pri_…`. And the adapter never substitutes catalog ids: checkout
sends the env-provided price id to Paddle verbatim, so an invalid id surfaces
as a Paddle API error rather than silently falling back to a different (e.g.
sandbox) product.

Card data never reaches SiteInsights; checkout and the portal are hosted by
Paddle as Paddle, Inc. is the merchant of record (Paddle handles sales tax /
VAT registration and remittance, which the provider-choice note mentions for
merchants based in Pakistan). There is no client-side or "test mode" grant
path: the only ways to a paid plan remain a verified webhook and the operator
CLI.

## Adding another payment provider

1. Confirm that the provider supports your business location (merchant account
   and payouts), recurring subscriptions and signed webhooks.
2. Create `src/lib/billing/providers/<id>.ts` implementing `BillingProvider`
   (`src/lib/billing/types.ts`):
   * `createCheckout()` returns a hosted checkout URL (HTTPS). Pass the
     SiteInsights user id as metadata. Success URL: `/billing?checkout=returned`.
   * `verifyWebhook(rawBody, headers)` verifies the signature over the raw
     body with the provider's signing secret (constant-time), throws
     `BillingSignatureError` when invalid, and maps events to
     `NormalizedBillingEvent` (`userId`, `subscriptionRef`, `planId`,
     `periodStart`, `periodEnd`, `occurredAt`, unique `eventId`).
   * Optionally `createPortal()` for card updates and cancellation.
3. Register it in `ADAPTERS` in `src/lib/billing/registry.ts`, reading its
   credentials from server-side environment variables. Return `null` if any
   are missing.
4. Configure the provider's webhook endpoint as
   `https://<your-domain>/api/billing/webhooks/<id>`.
5. Set `BILLING_PROVIDER=<id>` plus the adapter's credentials, then redeploy.
   `/api/plans` and `/api/billing` now report `payments.state = "ready"`, and
   the pricing and billing pages show real upgrade buttons.
6. Test in the provider's sandbox: activation, renewal, failed payment,
   recovery, cancellation at period end, and a duplicate webhook delivery.
   Check `/billing` and the ledger after each step.

Card data never reaches SiteInsights; checkout and the portal are hosted by
the provider. Do not add a client-side or "test mode" path that grants a plan.
The only paths to a paid plan are a verified webhook and the operator CLI.
