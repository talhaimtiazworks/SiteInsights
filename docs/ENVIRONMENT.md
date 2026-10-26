# SiteInsights environment variable reference

**A TalhaImtiazWorks Product.** Intended production origin: `https://siteinsight.xyz` (not verified live). See [REBRAND.md](REBRAND.md) before changing any production URL. No credential rotation or database migration is required for the rebrand.

The public app **starts** with no variables, but every audit requires a **verified non-anonymous Supabase account**. This is mandatory even locally; no anonymous allowance or configuration bypass exists. Production additionally requires persistent PostgreSQL storage. AI, browser rendering and PageSpeed are optional. Use the blank `config/environment.example.txt` as a private `.env.local` starting point; `.env*` files are intentionally excluded from release archives. Setup: `docs/SUPABASE.md`.

API keys are read **only on the server**. Never create `NEXT_PUBLIC_*` variables for secret keys; anything prefixed `NEXT_PUBLIC_` is embedded in browser code. The only public values are the Supabase project URL and **publishable** key, which are designed to be public and are protected by Row Level Security.

### Minimum production set
| Variable | Why |
|---|---|
| `DATABASE_URL` *or* `POSTGRES_URL` | persistent storage (the integration sets `POSTGRES_URL`) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | sign-in, accounts, dashboard |
| `SUPABASE_SECRET_KEY` | account deletion (server only) |
| `NEXT_PUBLIC_APP_URL`, `SESSION_SECRET` | auth email links, IP hashing, signed provider-avatar provenance |
| `CRON_SECRET` | audits finish in the background on Vercel |

## App

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | on Vercel production: `https://$VERCEL_PROJECT_PRODUCTION_URL` | Public base URL, origin only (intended after domain cutover: `https://siteinsight.xyz`; retain the existing working origin until then). Used for the redirect targets in confirmation, reset and email-change emails, OAuth/SSO callbacks, metadata, the crawler user-agent link, the OpenRouter `HTTP-Referer` header and same-origin checks. **Set it for Production only**: previews then use their own host, which must match a Redirect URL pattern in Supabase. On any Vercel deployment a development address (`localhost`, `127.x`, `0.0.0.0`, `::1`, `*.local`) is **ignored** and reported as an error in `/api/system/status` → `configIssues`, so a copied `.env` can't make emails link to localhost. A path, query or `http://` in production is reported as a warning. Keep `http://localhost:3000` only in your local `.env.local`. |
| `SESSION_SECRET` | built-in salt (warning in production) | HMAC key used to hash client IPs, sign OAuth provider provenance for avatars, and hash the owner-analytics visitor/session ids (see `docs/ANALYTICS.md`). Use at least 32 random bytes; without a strong value, the app safely uses the default avatar and non-persistent analytics hashes. |
| `NEXT_PUBLIC_CONTACT_EMAIL` | – | Public address shown on `/contact`. Not a secret. |
| `FRAME_ANCESTORS` | `'self'` | CSP `frame-ancestors` value. Compiled by `next build`; rebuild/redeploy after changes. Keep the default in production; permissive embedding, if used for sandbox-only visual QA, is not a deployment recommendation. |

## Accounts (Supabase Auth)

Names follow Supabase's current conventions and the Supabase ↔ Vercel integration. For each value the first variable that is set wins. Sign-in methods (email, Google, GitHub, SAML) are **not** configured here: the app reads them from the project's Auth settings and shows only enabled methods.

| Variable (accepted names, in priority order) | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL` | Project URL `https://<ref>.supabase.co`. Must be `https` (except `localhost`/`127.0.0.1`). |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY` | Publishable key `sb_publishable_…` (or the legacy `anon` JWT). Public by design. Sign-in is disabled with a warning if a `sb_secret_` key is put here. |
| `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Secret key `sb_secret_…` (or the legacy `service_role` JWT). **Server only.** Used for one thing: deleting the signed-in user's own Auth account. Without it, the delete-account page explains that deletion is unavailable. |
| `ANONYMOUS_AUDITS_ENABLED` | Deprecated compatibility input; ignored. The effective policy is always **false**: every audit and private report requires a verified account. Setting `true` cannot permit anonymous execution. |

Accounts require a database: with Supabase configured but no database URL, `/api/system/status` warns and account APIs return `503 accounts_need_database`.

## Provider avatars

The shared account menu (including the dashboard header) and profile settings use the same avatar policy. After an OAuth callback, the server accepts provider provenance only when the signed OAuth-start state matches its HttpOnly cookie, Supabase Auth's server-returned identity data uniquely agrees with that provider, and a signed marker is bound to the validated JWT `session_id`. The avatar itself comes only from the server-returned GitHub identity's `identity_data.avatar_url`, restricted to HTTPS `avatars.githubusercontent.com` user-avatar paths. A missing/weak `SESSION_SECRET`, ambiguous linked identities, missing GitHub image data, Google `picture` values, email/password, SSO, other providers, and image-load failures use the existing initials avatar. The profile API does not accept client-provided `avatarUrl` values; the app does not infer images from email addresses or construct avatar URLs from usernames.

There is no avatar upload/storage configuration or runtime B2 dependency. The legacy `profiles.avatar_url` column and any values already stored there are left untouched, but are no longer read for avatar display or updated by profile sync. The old `db/migrations/007_avatar_storage.sql` is preserved as `db/optional/007_avatar_storage.sql`; it is excluded from automatic migrations pending compatibility review. No production migration or database change was performed.

The app source no longer reads avatar-specific B2 variables or contacts B2. This code change does not delete or modify any B2 environment settings, bucket, application key, or object. Before retiring any remote configuration or resource, privately confirm it has no other consumers; no remote cleanup was performed here.

## Mailjet SMTP (explicit server/operator tools, not Auth runtime variables)

**Supabase Auth still sends authentication mail.** Vercel variables do not update its provider. The current web app has no Nodemailer sender/public SMTP endpoint; the six variables below are consumed only by the explicit operator diagnostic / Supabase setup scripts. **Do not create unused Vercel SMTP variables solely for hosted Auth.** Configure the existing Supabase project's custom SMTP settings independently. Scope-specific instructions: [MAILJET-SMTP.md](MAILJET-SMTP.md).

| Variable | Shipped default | Operator behavior |
|---|---|---|
| `SMTP_HOST` | `in-v3.mailjet.com` | Allowlisted relays only: `in-v3.mailjet.com` (Mailjet) or `smtp-relay.brevo.com` (Brevo); other hosts/URLs are rejected before network access |
| `SMTP_PORT` | `587` | Only 587 (mandatory STARTTLS) or 465 (implicit TLS) |
| `SMTP_SECURE` | `false` | Exactly `false` with 587 or `true` with 465; false is not plaintext fallback |
| `SMTP_USER` | empty | Mailjet API key, not an email address/account login; private even if called public by the provider |
| `SMTP_PASS` | empty | Paired Mailjet Secret Key; never account/DB passwords; no trimming/space removal |
| `EMAIL_FROM` | empty | One bare, independently Mailjet-verified sender chosen by the operator; display name SiteInsights |

The local safety policy permits opaque **16–256 printable ASCII** key characters, no whitespace/control characters; key bytes/case remain unchanged. It does not guess an exact hex length or prove account validity. Sender syntax is checked, but Mailjet must verify sender/domain authorization. Both port modes retain certificate validation/TLS 1.2 in the Node diagnostic; 587 requires STARTTLS. No public SMTP/Mailjet aliases, raw transport logging or config serialization.

Use a private ignored operator file such as `.env.smtp.local`. If you deliberately use Vercel as environment storage for a real operator workflow, update these same six private names for that workflow only, Production/Preview separately as actually needed, then redeploy relevant workloads; this still does not change Supabase settings. Missing/invalid operator SMTP config fails the explicit command safely but does not disable independently configured Supabase mail or make a build send mail.

Optional `SUPABASE_ACCESS_TOKEN` / existing `SUPABASE_PROJECT_REF` are operator Management API setup inputs, not database/Mailjet credentials or Vercel app requirements. Never add the PAT to Vercel. All current database/Auth/OAuth/session/cron variables below retain their purposes and values. Actual Mailjet acceptance/inbox delivery and sender/SPF/DKIM status remain pending private configuration and controlled testing.

## Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | – | Postgres connection string (use a **pooled** URL on Vercel, e.g. Supabase's transaction pooler on port 6543). **Required in production** unless `POSTGRES_URL` is set. If set but unreachable, APIs return `503 database_unavailable` with `Retry-After` — never a silent fallback to memory and never "not found". |
| | | **Special characters in the password** must be URL-encoded (`%` → `%25`, `@` → `%40`, `#` → `%23`, `/` → `%2F`). Since 0.4.0 a stray `%` that isn't a valid `%XX` escape (e.g. `Summer50%off`) is encoded automatically and reported in `configIssues`. In 0.3.x it made the Postgres driver throw `URI malformed`, and every database route answered "Something went wrong on our side". Other unparsable URLs give `503 database_misconfigured` with a fix instead of a 500. |
| `POSTGRES_URL` | – | Used when `DATABASE_URL` is not set. This is the pooled URL created by the Supabase ↔ Vercel integration. Pooler-only parameters (`pgbouncer`, `supa`, …) are removed automatically, and the driver runs with `prepare: false` (required by transaction poolers). |
| `POSTGRES_URL_NON_POOLING` | – | Session/direct connection (set by the integration). `npm run db:migrate` order: `MIGRATION_DATABASE_URL`, `POSTGRES_URL_NON_POOLING`, `DATABASE_URL_UNPOOLED`, `DATABASE_URL`, `POSTGRES_URL`. The running app uses the first of `MIGRATION_DATABASE_URL`, `POSTGRES_URL_NON_POOLING`, `DATABASE_URL_UNPOOLED` **only for automatic migrations**, and only when the runtime URL is a Supabase transaction pooler and the migration URL points to the **same** project. It skips the IPv6-only direct host on Vercel and falls back to the runtime connection if the migration URL is unreachable. Runtime queries always use `DATABASE_URL`/`POSTGRES_URL`. |
| `MIGRATION_DATABASE_URL` | – | Explicit session/direct URL for migrations (see above). A transaction-pooler URL here triggers a warning. |
| `ALLOW_MEMORY_STORAGE` | `true` in development, `false` in production | Allows temporary, per-process memory storage when `DATABASE_URL` is unset. **Ignored on serverless hosting** (Vercel, Lambda, Netlify), where instances don't share memory. Only for local development or a single self-hosted process. When storage is unavailable, audit APIs return `503 storage_not_configured` and the UI shows a setup message. |
| `DATABASE_SSL` | auto | `require`, `prefer` or `disable`. Auto = `require` for non-local hosts, unless the URL contains `sslmode=` (then the URL wins). |
| `DB_AUTO_MIGRATE` | `true` | Apply migrations on first connection (guarded by a Postgres advisory lock). Set `false` and run `npm run db:migrate` if you prefer explicit migrations. |

### Consistency checks (no values are ever shown)
On start the app derives the Supabase project ref from every variable that contains one (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`, the database URLs, legacy JWT keys) and reports problems in `/api/system/status` → `configIssues` as `{severity, variables, problem, fix}`:
- the runtime database belongs to another project than Auth (**error**; this breaks sign-in persistence, Start audit and the dashboard). The fix text says when `DATABASE_URL` is overriding a correct `POSTGRES_URL`;
- any other Supabase variable from a third project (warning);
- a `service_role` key in a publishable/anon variable (**error**), or a public key in `SUPABASE_SECRET_KEY` (warning);
- the direct `db.<ref>.supabase.co` host as the runtime URL on Vercel (IPv6-only, **error**), or the session pooler (port 5432) at runtime (warning: use 6543);
- a pooler URL whose user isn't `postgres.<ref>` (**error**).

`GET /api/system/diagnostics` (header `Authorization: Bearer <CRON_SECRET>`) adds live checks: migrations, privileges, Auth reachability, enabled OAuth providers, a rollback-only proof that Auth users can own rows in the database, the worker, PageSpeed and AI.

## Background processing

| Variable | Default | Description |
|---|---|---|
| `CRON_SECRET` | – | ≥ 16 characters. Authorizes `/api/internal/process` (Vercel Cron sends it as `Authorization: Bearer …`), which is used for the background hand-off and the scheduled sweep. Without it on serverless hosting, `background` is `limited` (see `docs/SUPABASE.md` §12). |
| `BACKGROUND_BUDGET_MS` | 50 000 | 5 000–250 000. Work per background invocation before handing off to a fresh one. The background routes allow 300 s (`maxDuration`, the Vercel Fluid compute limit on all plans); one browser render or PageSpeed test may run up to 60 s past the budget, so keep this ≤ 240 000. |
| `BACKGROUND_PROCESSING` | `true` | `false` disables background work: audits then advance only while their page is open. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | – | Needed only if Vercel Deployment Protection covers the production URL. It lets the background hand-off reach `/api/internal/process`. |

## AI providers

| Variable | Default | Description |
|---|---|---|
| `OPENROUTER_MODEL` | `openrouter/auto` | Default OpenRouter model used with each user's own key. Any OpenRouter model ID. |
| `GEMINI_MODEL` | `gemini-flash-latest` | Default Gemini model used with each user's own key. |

**Strict BYOK (as of v0.4):** SiteInsights holds no AI credential of its own. Each user connects their own OpenRouter or Google Gemini key at **Settings → AI**; the key stays in their browser's memory, is sent (same-origin, HTTPS) with each AI request, and is used server-side for that single request only — never stored in the database, cookies, logs or analytics, and never shared across users. There is NO `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `AI_PROVIDER` or `AI_FALLBACK_ENABLED` anymore: setting them has no effect and produces a startup warning asking for their removal. Core auditing (crawl, link checks, findings, reports, PDF) works with no AI key at all.
| `AI_TIMEOUT_MS` | `45000` | Per-request timeout (5 000–120 000). |
| `AI_MAX_RETRIES` | `2` | Bounded retries for timeouts, 429, 5xx, network errors and schema-invalid output (0–4). |
| `AI_MAX_OUTPUT_TOKENS` | `2000` | Output token cap per request. |

## Browser worker (JavaScript rendering, mobile checks, axe-core)

Optional. Rendering runs in a **separate service** (`worker/`, see `docs/DEPLOYMENT.md`) — never inside the Next.js app. Without these variables audits use the HTML crawler only and the report marks browser and axe-core checks as "Not evaluated".

| Variable | Default | Description |
|---|---|---|
| `BROWSER_WORKER_URL` | – | Base URL of the worker, e.g. `https://siteinsight-worker.example.com`. Use `https` in production (a config warning is shown for plain `http`). |
| `BROWSER_WORKER_TOKEN` | – | Shared secret sent as `Authorization: Bearer …`; **at least 24 characters** and identical to the worker's `WORKER_TOKEN`. Server-side only. Rendering is disabled (with a config warning) if missing or too short. |
| `BROWSER_MAX_PAGES` | 5 | 0–25. Pages rendered per audit (shallowest first). Also capped by the free-plan allowance. `0` disables rendering. |
| `BROWSER_NAV_TIMEOUT_MS` | 20 000 | 5 000–60 000. Navigation timeout inside the browser. |
| `BROWSER_WORKER_TIMEOUT_MS` | 45 000 | 10 000–80 000. Total time the app waits for one render (must stay below the `advance` route's `maxDuration` of 90 s). |
| `BROWSER_ACCESSIBILITY_ENABLED` | `true` | Run axe-core on rendered pages. |

### Worker service variables (set on the worker, not on Vercel)
| Variable | Default | Description |
|---|---|---|
| `WORKER_TOKEN` | – (required) | Same value as `BROWSER_WORKER_TOKEN`; the worker refuses to start if it is shorter than 24 characters. |
| `PORT` | 8080 | Listening port. |
| `WORKER_CONCURRENCY` | 2 | 1–8 simultaneous renders (each launches its own Chromium; budget ~300–600 MB RAM per render). Extra requests get `429` and the app retries a few times. |
| `CHROMIUM_PATH` | bundled | Optional path to a Chromium executable (the Docker image provides one). |

## Performance (PageSpeed Insights)

Optional and **independent of the AI providers**.

| Variable | Default | Description |
|---|---|---|
| `PAGESPEED_API_KEY` | – | Google API key with the PageSpeed Insights API enabled. Sent only in the `X-goog-api-key` header, never in URLs or logs. |
| `PAGESPEED_ENABLED` | `true` if a key is set | Set `true` to use Google's small keyless quota (not recommended), or `false` to disable. |
| `PAGESPEED_STRATEGIES` | `mobile,desktop` | `mobile`, `desktop` or both. Each strategy is one test (and one unit of the performance allowance). |
| `PAGESPEED_TIMEOUT_MS` | 60 000 | 10 000–80 000. Per-test timeout. Lighthouse runs often take 15–40 s. |

## Scanner

| Variable | Default | Range | Description |
|---|---|---|---|
| `SCAN_MAX_PAGES` | 25 | 1–500 | Pages crawled per scan. |
| `SCAN_MAX_DEPTH` | 3 | 0–10 | Click depth from the start URL. |
| `SCAN_MAX_LINKS_TO_CHECK` | 150 | 0–1000 | Unique link/image destinations checked per scan. |
| `SCAN_MAX_REDIRECTS` | 5 | 0–10 | Redirects followed per request. |
| `SCAN_CONCURRENCY` | 4 | 1–10 | Parallel requests. |
| `SCAN_REQUEST_TIMEOUT_MS` | 8000 | 1 000–30 000 | Per-request timeout. |
| `SCAN_MAX_BODY_BYTES` | 2 000 000 | 50 000–10 000 000 | Response bodies are truncated beyond this. |
| `SCAN_MAX_DURATION_MS` | 180 000 | 10 000–900 000 | Total scan time; afterwards results are partial (warning). |
| `SCAN_MAX_RETRIES` | 1 | 0–3 | Retries for transient fetch failures. |
| `SCAN_HOST_MIN_INTERVAL_MS` | 250 | 0–5 000 | Minimum gap between requests to one host (robots `Crawl-delay` raises it). |
| `SCAN_STEP_BUDGET_MS` | 20 000 | 3 000–240 000 | Work per `/advance` call. Keep well below the route's `maxDuration` (90 s in this repo). A single browser render or PageSpeed test may run past the budget, bounded by its own timeout. |
| `SCAN_ALLOWED_PORTS` | `80,443,8080,8443` | – | Destination ports the scanner may connect to. |
| `SCAN_MAX_QUERY_VARIANTS` | 3 | 0–50 | Query-string variants crawled per path (trap avoidance). |
| `SCAN_MAX_SITEMAP_FILES` | 4 | 0–20 | Sitemap / sitemap-index files read. |
| `SCAN_MAX_SITEMAP_URLS` | 500 | 0–5 000 | URLs read from sitemaps. |
| `SCAN_USER_AGENT` | `Mozilla/5.0 (compatible; SiteLensAI/0.2; +<APP_URL>/help#crawler)` (the `+URL` part uses `NEXT_PUBLIC_APP_URL`, else the Vercel host, else is omitted) | – | SiteInsights crawler user agent. The legacy `SiteLensAI` token is intentionally retained so existing robots.txt groups still match; it is not the product display name. |

## Fair use (technical safeguards — no payment involved)

SiteInsights is free for everyone. These windows exist only to stop abuse and
keep the service responsive; none of them can be raised, bought or unlocked.

| Variable | Default | Description |
|---|---|---|
| `FREE_SCANS_PER_WINDOW` / `FREE_SCAN_WINDOW_SECONDS` | 10 / 86 400 | Audits per rolling window per account (or per anonymous browser). Reruns count. The dashboard shows usage and when the oldest use resets. This is a technical throttle, not a paid quota — audits are free and unlimited apart from these windows. |
| `AUDIT_BURST_LIMIT` / `AUDIT_BURST_WINDOW_SECONDS` | 5 / 600 | Short-term cap on audit starts (`429 scan_burst_limited`). |
| `AI_BURST_LIMIT` / `AI_BURST_WINDOW_SECONDS` | 10 / 60 | Short-term cap on AI requests (`429 ai_burst_limited`). |
| `FREE_AI_REQUESTS_PER_WINDOW` | 300 | AI requests per window for every user in the free product (AI is no longer gated by any plan). |
| `FREE_AI_WINDOW_SECONDS` | 86 400 | Shared rolling-window duration for AI plan limits. Failed AI calls are refunded. |
| `FREE_MAX_AI_INPUT_CHARS` | 12 000 | Maximum characters of finding data sent to the AI per request. |
| `FREE_MAX_CONCURRENT_SCANS` | 1 | Active scans per principal. |
| `FREE_HISTORY_LIMIT` | 20 | Most recent audits kept per **anonymous** browser; older ones are deleted. |
| `FREE_ACCOUNT_HISTORY_LIMIT` | 100 | Most recent audits kept per signed-in account. |
| `FREE_IP_LIMIT_MULTIPLIER` | 3 | Per-network allowance = limit × multiplier (stops bypass by clearing cookies, tolerates shared networks). |
| `FREE_ADVANCED_WINDOW_SECONDS` | 86 400 | Rolling window shared by the four allowances below. |
| `FREE_BROWSER_PAGES_PER_WINDOW` | 30 | Browser-rendered pages. Refunded when the worker is unavailable. |
| `FREE_ACCESSIBILITY_TESTS_PER_WINDOW` | 30 | Pages tested with axe-core. Refunded if axe-core did not run. |
| `FREE_PERFORMANCE_TESTS_PER_WINDOW` | 10 | PageSpeed tests (mobile and desktop count separately). Refunded on provider errors; a page Lighthouse cannot load is counted. |
| `FREE_PDF_EXPORTS_PER_WINDOW` | 20 | PDF downloads. Refunded if the PDF cannot be built. |
| `GLOBAL_MAX_CONCURRENT_SCANS` | 25 | Service-wide cap on active scans. |
| `API_RATE_LIMIT_PER_MINUTE` | 120 | Default per-client API throttle (per instance). |

Limits are enforced on the server inside a database transaction with advisory locks, so parallel requests can't exceed them. Refunds use the same locks. Plans and subscriptions no longer affect any capability: checkout is disabled product-wide and the historical `subscriptions` / credit tables below are preserved read-only data.

## Plans, credits and billing — retired

**Free product:** these variables are inert legacy compatibility knobs kept so the preserved tables/services don't crash. They no longer change what any user can do. Full reference for the legacy layer (and why its data must NOT be deleted): [BILLING.md](BILLING.md).

| Variable | Default | Description |
|---|---|---|
| `BILLING_PROVIDER` | unset | Id of an installed payment adapter. Unset means payments are disabled, webhooks return 404, and paid plans can only be granted with `scripts/billing/manage-subscription.mjs`. The built-in adapter id is `paddle` (setup: docs/BILLING.md → “Payments with Paddle”). |
| `PADDLE_API_KEY` | – | Server API key (`pdl_sdbx_apikey_…` sandbox / `pdl_live_apikey_…` live). Server-only. Required for the Paddle adapter. |
| `PADDLE_NOTIFICATION_WEBHOOK_SECRET` | – | Secret of the Paddle notification destination that points to `/api/billing/webhooks/paddle` (`pdl_ntfset_…`). Each destination has its own secret. Required for the Paddle adapter. |
| `PADDLE_ENV` | `sandbox` | `sandbox` or `production`; selects the Paddle API base URL (`NEXT_PUBLIC_PADDLE_ENV` is honoured as a fallback for parity with the vendor skills). |
| `PADDLE_PRICE_PRO` / `PADDLE_PRICE_BUSINESS` | – | Paddle price ids (`pri_…`) for the paid plans; both required for the Paddle adapter. |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` | – | **Unused** by the built-in integration (Paddle-hosted checkout links, not Paddle.js). Listed by the vendor checkout skill for client-side integrations only. |
| `PLAN_{FREE,PRO,BUSINESS}_CREDITS` | 100 / 1000 / 3000 | Monthly credit allowance. |
| `PLAN_{FREE,PRO,BUSINESS}_MAX_PAGES` | 25 / 150 / 500 | Pages per audit (capped by `SCAN_HARD_MAX_PAGES`). |
| `PLAN_{X}_MAX_DEPTH`, `_MAX_LINKS`, `_MAX_DURATION_MS`, `_CONCURRENT_AUDITS`, `_AUDITS_PER_DAY`, `_HISTORY_LIMIT` | see BILLING.md | Other per-plan limits. |
| `PLAN_{PRO,BUSINESS}_AI_PER_DAY`, `_PDF_PER_DAY` | 100 / 300 | Daily AI and PDF caps on paid plans. |
| `CREDIT_COST_AUDIT_START` / `CREDIT_COST_PAGE` / `CREDIT_COST_AI` / `CREDIT_COST_PDF` | 10 / 1 / 2 / 0 | Credit costs. |
| `SCAN_HARD_MAX_PAGES` | 500 (max 1000) | Operator-wide page cap that no plan can exceed. |

