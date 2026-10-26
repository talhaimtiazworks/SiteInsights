# Private Owner Analytics

SiteInsight ships a built-in, first-party web analytics view for the site owner
at the unadvertised route `/admin/analytics`. It replaces third-party analytics
(no external service receives visitor data) with a small event pipeline stored
in the existing PostgreSQL database.

## Access control (owner allowlist)

- Exactly one email is authorized: see `ADMIN_ALLOWLIST` in
  `src/lib/admin/allowlist.ts` (`talha.imtiaz2111@gmail.com`).
- Hiding the URL is **not** the security. Enforcement happens in three
  independent layers:
  1. `src/app/admin/analytics/page.tsx` — server-rendered gate; anyone outside
     the allowlist receives the plain site 404 (no redirects, no hints).
  2. Every `/api/admin/analytics/*` endpoint re-validates the **verified
     session email** via `requireAdmin(ctx)` (401 when not signed in,
     403 when signed in as someone else). The client never submits an email.
  3. The `analytics_events` table grants nothing to the Data API roles
     (RLS enabled, `REVOKE ALL` from `PUBLIC`/`anon`/`authenticated`), so the
     rows are only reachable through the app's server-side client.
- Signing out, session expiry, or a tampered token revokes access immediately
  (all covered by tests in `tests/admin-analytics.test.ts`).
- There is intentionally **no** public admin sign-in, no admin role selector,
  and no way to self-promote an account. Changing the owner means editing the
  constant and redeploying (documented, auditable).

## Data model

`db/migrations/011_analytics.sql` creates `analytics_events`:

| Column | Notes |
| --- | --- |
| `id` | server UUID |
| `client_event_id` | client UUID, **unique** — retries/beacons can never duplicate an event |
| `visitor_hash` / `session_hash` | HMAC-SHA256 (salted with `SESSION_SECRET`, per-kind domain separator) of the client-generated ids. Raw ids and IP addresses are **never stored**. |
| `event_type` | `pageview` \| `session_start` |
| `path` | sanitized, query/hash stripped, ≤ 200 chars, private areas excluded |
| `referrer_host` | hostname only, never the full referrer URL |
| `source` | `direct` \| `search` \| `social` \| `referral` \| `campaign` \| `other` |
| `device` | `desktop` \| `mobile` \| `tablet` \| `unknown` |
| `browser`, `os` | coarse family names (`chrome`, `safari`, `windows`, `macos`, …) |
| `created_at` | server timestamp (UTC) |

Events are written only through `src/app/api/analytics/track/route.ts` (strict
zod allowlist, 4 KB body cap, per-IP throttle, bot user-agents skipped).
**The intake route never fails loudly** — after server-side logging, tracking
errors return silence so analytics can never break the site.

## Metric definitions (single source of truth)

Also stated in `src/lib/db/analytics-types.ts`; keep both in sync.

- **Event** — one validated client report (`pageview` or `session_start`).
- **Unique visitors** — distinct `visitor_hash` in the range. The visitor id
  is a random UUID in the visitor's own browser storage
  (`localStorage["sitelens.vid"]`, ~13-month refresh). It is a **first-party
  estimate**: clearing storage means a new visitor; the same person on two
  devices counts as two. No cross-device identity is claimed.
- **Sessions** — distinct `session_hash` in the range. The session id lives in
  `sessionStorage["sitelens.sid"]` and rotates after **30 minutes of
  inactivity** (sliding window, `SESSION_IDLE_MS` in
  `src/components/analytics-tracker.tsx`) or when the tab/storage closes.
- **Page views** — events of type `pageview`. Client mount/hydration
  duplicates are suppressed in the tracker; delivery duplicates (beacon
  retries, back-pressure) are deduplicated server-side by the unique
  `client_event_id`.
- **Returning visitors / returning rate** — distinct visitors with any event
  *strictly before* the range start AND ≥ 1 pageview inside the range, divided
  by unique visitors in the range. When the previous period has no data at
  all, comparison deltas render as **null** ("No previous period"), not as
  invented percentages.
- **Landing page** — path of a session's earliest pageview inside the range
  (on ties, the first seen).
- **Sources** — per-event classification. UTM source/medium overrides referrer
  classification for campaign traffic; known search/social hosts classify by
  hostname; anything else external is `referral`. In-session pageviews (which
  carry no referrer) **inherit their session's first recorded source** so
  attribution stays session-scoped.
- **Product metrics** — derived from authoritative records, never from the
  visitor events: `profiles`/principals (registrations), `audits`
  (created/completed/failed), `usage_records` (renamed from `usage_events` by migration 004) with kind `pdf_export`
  (report exports).
- **Conversion rates** (visible numerators and denominators in the UI):
  - *Registration → first audit*: accounts created in the range that started
    ≥ 1 audit by the range end.
  - *Audit completion*: audits created in the range whose final status is
    `completed` or `completed_with_warnings`.
  - *Completed audit → PDF export*: accounts with a completed audit in the
    range that also exported ≥ 1 PDF in the range.
- **Time zone** — every range, bucket and boundary is computed in UTC.

## Near-real-time behavior

The dashboard polls all four aggregates every **20 seconds** while the tab is
visible, pauses entirely when hidden (and refetches once on return), aborts
stale requests, and shows the last-updated clock. It is
**near-real-time, not real-time**: a recorded event appears within ≤ ~20 s plus
query latency. No WebSocket/SSE was added; the existing HTTP routes bound cost.

## Privacy & retention

- First-party only; nothing leaves this deployment. No cookies are set by the
  tracker (browser storage only); the site honors `navigator.doNotTrack`.
- No IP addresses, emails, raw visitor/session ids, full URLs, or query
  parameters are persisted; the public activity feed shows only event type,
  path, source, device/browser/os class and time.
- **Retention**: keep 400 days of raw events; aggregates in the UI never span
  more than 366 days. Cleanup (run manually or via your scheduler):

  ```sql
  DELETE FROM analytics_events WHERE created_at < now() - interval '400 days';
  ```
- GDPR/CCPA note: the stored data is hashed, coarse and first-party, but I am
  not making universal compliance claims — assess against your own policy.

## Storage implementations & degradation

`AnalyticsRepository` ships twice: PostgreSQL (`analytics-postgres.ts`, used
when `DATABASE_URL` is set) and memory (`analytics-memory.ts`, development and
tests). With memory storage the dashboard works but data is per-process and
lost on restart — exactly like the audit store behaves without a database.

Range/pagination bounds: presets 7/30/90 days, custom ranges ≤ 366 days,
table pages of ≤ 50 rows, offset < 10 000. All aggregation runs server-side.

## Environment variables

No **new** variables are required. Reused:

| Variable | Use |
| --- | --- |
| `SESSION_SECRET` (existing) | HMAC salt for visitor/session hashes (dev fallback is hardcoded, production already requires it). |
| `DATABASE_URL` (existing) | persistence of `analytics_events`. |
| `API_RATE_LIMIT_PER_MINUTE` (existing) | general per-IP throttle that also protects intake; the route adds its own 240/min budget. |

See `docs/ENVIRONMENT.md`.

## Migrations

`npm run db:migrate` (or the Supabase editor bundle) applies
`011_analytics.sql`. `src/lib/db/migrations.ts` is generated — regenerate with
`npm run db:generate` after editing SQL. A freshness unit test fails if the
generated file is stale.
