# SiteInsights architecture

**AI-Powered Website Auditing · A TalhaImtiazWorks Product.** The redesign preserves the scanner, schema, RLS, metering and providers, while intentionally making verified authentication mandatory for all audit paths.

## Product identity and public routes
- `src/lib/brand.ts`: exact product name, parent, category, tagline and intended domain. The intended origin is not a runtime fallback.
- `src/components/brand.tsx`, `site-footer.tsx`, `auth-ui.tsx`: responsive product-first identity, shared parent attribution. The exact supplied official PNG is used in the header, auth, loading, footer, email and PDF. Central light/dark palette: `src/lib/design-tokens.json`.
- `src/lib/config/metadata.ts`: canonical/social URLs follow the configured deployment. `/about`, `/help`, `/contact`, `/privacy`, `/terms` and `/` form the public sitemap. Private reports and accounts are excluded.
- `src/app/robots.ts`, `sitemap.ts`, `manifest.ts`: App Router metadata routes. Robots directives are indexing guidance, **not** an authorization boundary.
- Auth routes, callbacks, API paths and JSON data remain compatible. JSON/PDF download filenames now start `siteinsight-`; PDF authorship and export metadata identify TalhaImtiazWorks.
- Committed emails use `{{ .SiteURL }}` until external setup is complete. Details and preserved technical identifiers: [REBRAND.md](REBRAND.md).

## Existing runtime architecture

```
Browser (React client pages; no Supabase client in the browser: OAuth/SSO start in server routes)
  │  fetch /api/*  (JSON envelope {ok,data} | {ok:false,error})
  ▼
src/proxy.ts  refreshes the verified Supabase session (getClaims); retains legacy sl_pid compatibility
  ▼
Next.js App Router route handlers (src/app/api/**)        runtime=nodejs, dynamic
  │  getAuditContext → verified, unexpired, non-anonymous account → principal "user:<uuid>"
  │                      else 401; HMAC'd IP for abuse limits
  │  throttle, assertSameOrigin (mutations), Zod validation
  ▼
Services (src/lib/services)  scans · background · dashboard · compare · account · usage · ai · views
  │                 │                       │
  ▼                 ▼                       ▼
Scanner engine   AI layer               Usage / entitlements
(src/lib/scanner) (src/lib/ai)          (src/lib/usage)
  │ safeFetch      │ registry → OpenRouter | Gemini adapters
  │ (src/lib/      │ structured.ts (Zod-validated, bounded retry)
  │  security)     │ prompts.ts (untrusted data delimiting)
  ▼                ▼
Audit (src/lib/audit): rules catalogue → analyze → findings → scoring
  ▼
Repository interface (src/lib/db/types.ts)
  ├─ PostgresRepository (DATABASE_URL or POSTGRES_URL; Supabase transaction pooler, prepare:false;
  │                      migrations in db/migrations + src/lib/db/migrations.ts)
  └─ MemoryRepository (development only, or ALLOW_MEMORY_STORAGE on a single self-hosted process;
                        never on serverless; otherwise 503 storage_not_configured)

Supabase Auth (GoTrue): sign-up/in, email links, OAuth (Google/GitHub), SAML SSO. Called with the
  publishable key; the secret key is used server-side only to delete the user's own account.

External services (all optional, all bounded by timeouts, the app works without them):
  Browser worker (worker/, separate Docker service) ← POST /v1/render, Bearer token
     └─ per render: SSRF egress proxy + fresh Chromium (Playwright) + axe-core
  Google PageSpeed Insights API (Lighthouse lab + CrUX field data)
  OpenRouter / Gemini (AI explanations)
```

## Scan lifecycle
1. `POST /api/scans` verifies a signed-in account before any audit work; anonymous, invalid and expired sessions receive 401. It then validates the URL (syntax, scheme, credentials, hostname rules, port) and resolves DNS — every address must be public. Then capacity, concurrency and scan allowance are checked and a scan job is stored as `queued`.
2. Work happens in **steps**. Each step takes a lease (so steps never overlap), runs at most `SCAN_STEP_BUDGET_MS` of work, persists state (frontier, seen set, robots/sitemap data, progress) and returns. Steps are driven by (a) **background processing** (`src/lib/services/background.ts`): after `POST /api/scans` responds, `after()` keeps running steps for `BACKGROUND_BUDGET_MS`, then hands off by calling `/api/internal/process` (authorized with `CRON_SECRET`), which continues the chain; the Vercel cron (daily) or optional pg_cron (per minute) sweeps audits whose chain broke; and (b) an open progress page, which calls `POST /api/scans/{id}/advance` and polls `GET /api/scans/{id}` for live counts. Because every step is leased and persisted, any mix of drivers is safe, and an interrupted invocation resumes from the last saved step.
3. Phases: `discovery` (robots.txt, sitemaps) → `crawling` (breadth-first, same site, robots-respecting, trap-filtered, depth/page limits) → `rendering` (optional: up to `BROWSER_MAX_PAGES` pages sent one per step to the browser worker; links found only after JavaScript are added to link checking) → `checking_links` (HEAD → GET fallback, bounded) → `performance` (optional: one PageSpeed test per strategy per step, start page) → `analyzing` (rules, scores, coverage) → terminal state. Render and performance results are stored as bounded JSON **artifacts** (`scan_artifacts`, keyed per URL / strategy) so steps can run on different instances.
5. Ownership: all audit APIs use `getAuditContext` before reading identifiers, query strings or payloads. Supabase verifies JWT signatures; `isAccountClaims` requires a UUID subject, authenticated role, non-anonymous account and future expiration. `assertAuditAccount` also guards service-level initiation and direct execution, before storage, DNS, metering or queueing. A job belongs to `user:<uuid>` from the trusted context, never client-supplied ownership. Owners may write; explicit organization members read only; authenticated strangers get 404; signed-out/invalid/expired callers get 401. Legacy `X-Scan-Key`, fragments and anonymous cookies are never authority. `Copy report URL` contains no key. Legacy pre-update records can be explicitly claimed by the original browser after sign-in, but are skipped by background execution until account-owned. Start/rerun retain idempotency and leases. Trusted internal processing retains its constant-time cron bearer check and additionally refuses anonymous jobs. The isolated browser renderer retains its separate bearer token and SSRF proxy.
6. Charging: browser pages, axe-core tests and PageSpeed tests are metered per unit before each call and refunded when the external service fails (not when the site itself fails).
4. States: `queued → running → completed | completed_with_warnings | failed`, and `queued|running → cancelled`. Enforced by `src/lib/scans/state-machine.ts` and conditional updates in the repository.

## SSRF protection (defence in depth)
- Hostname rules: blocks `localhost`, internal suffixes (`.local`, `.internal`, `.test`…), single-label hosts, metadata hostnames, private/reserved IP literals including decimal/hex/octal and IPv4-mapped IPv6 encodings (normalised by the WHATWG URL parser, then checked with `ipaddr.js`).
- DNS: all resolved addresses must be public (mixed answers rejected).
- **Connect time:** the HTTP agent uses a guarded `lookup` that re-validates the addresses actually used for the socket, defeating DNS rebinding.
- Every redirect hop is re-validated (scheme, host, port, then DNS at connect); loops and hop limits enforced.
- Port allowlist, response size cap, timeouts, no cookies/credentials forwarded, GET/HEAD only.
- A regex is never relied on alone.
- **Browser worker:** the target is pre-checked; Chromium is launched with a per-render HTTP/CONNECT proxy that resolves every hostname itself, rejects mixed/private answers and connects to the validated IP (no rebinding window). Navigation, redirects and all sub-resources pass through it; `--host-resolver-rules` prevents Chromium-side DNS, QUIC and non-proxied WebRTC are disabled, service workers and downloads blocked. Site code never runs in the Next.js process.

## Findings & scoring
Rules live in `src/lib/audit/rules.ts` (id, category, type error/recommendation/observation, base severity, optional deterministic severity function, description, detection method, recommendation). `analyze.ts` turns crawl data into findings with evidence; IDs are deterministic hashes. Scores: `src/lib/audit/scoring.ts`, formula v2 documented on `/help#scoring` — browser/axe findings use rendered pages as the denominator, Performance is the Lighthouse score, and unevaluated categories are `null` ("Not evaluated"). `analyze-browser.ts` (rendering, mobile, axe-core with WCAG mapping and de-duplication against HTML rules) and `analyze-performance.ts` (lab vs field, never TBT as INP) add findings from artifacts.

## Reports
`GET /api/scans/{id}/results` returns findings, pages, links, compact render summaries and performance runs. `GET /api/scans/{id}/report.pdf` builds a PDF server-side with the existing `pdf-lib` pipeline: exact embedded official PNG, canonical palette, real metadata, repeated running headers and numbered footers. Width-aware Unicode runs use standard fonts plus locally bundled static Noto Arabic/CJK/Emoji fallbacks via `@pdf-lib/fontkit`; unsupported codepoints are explicitly represented as `[U+XXXX]`. Long URLs, evidence, recommendations and tables paginate without silently dropping findings. A full `audit-data.json` is attached, metered as `pdf_export`, refunded on failure; it never serves an empty file. Coverage and the action plan come from `src/lib/report/summary.ts`, shared by the web report and the PDF.

## AI layer
- Common `AIProvider` interface; adapters for OpenRouter (Chat Completions) and Gemini (`generateContent`, key in `x-goog-api-key` header).
- Errors normalised to `auth_failed`, `rate_limited`, `quota_exhausted`, `timeout`, `invalid_response`, `model_not_found`, `content_blocked`, `bad_request`, `provider_unavailable`, `network_error`, `not_configured`; messages never include provider bodies or keys.
- Strict BYOK: every AI request carries the current user's own OpenRouter/Gemini key (entered on Settings → AI, held in browser memory only) and a request-scoped provider adapter is built for that single request. No server-side key exists and there is no automatic failover across providers.
- Order of operations per request: ownership → cache → provider selection → usage check/consume → call → refund on failure → store.
- Prompts contain only verified finding data, JSON-escaped inside `<scan_data>` tags; the system prompt marks it as untrusted. Output is Zod-validated; summary priorities referencing unknown finding IDs are dropped.

## Usage & entitlements
`src/lib/usage/entitlements.ts` maps a principal's plan to limits and features. The plan comes from `subscriptions` (server-side; `free` if none), never from the client; `plans` holds the catalogue for future paid plans (no payment provider is integrated). `meter.ts` performs atomic check-and-consume in a transaction with advisory locks (network, then principal, in a fixed order). Refunds take the same locks, so concurrent requests can't exceed a limit or lose a refund. Legacy anonymous metering structures remain for data/API compatibility but cannot initiate audits. Network limits remain as abuse protection. Short-term burst caps (`AUDIT_BURST_*`, `AI_BURST_*`) are enforced the same way.

## Authentication
- `@supabase/ssr` server client with `getAll`/`setAll` cookies. `src/proxy.ts` refreshes tokens on navigation; route handlers and guarded pages validate the JWT with `getClaims()` (never `getSession()` alone). Guarded pages are `force-dynamic` and redirect on the server (`src/lib/auth/page-guard.ts`), so protection never depends on client code.
- Sign-up, sign-in, reset and email change run through server routes (`/api/auth/*`, `/api/account/*`) with per-IP throttles, same-origin checks and mapped error codes (raw provider messages are never shown). Forgot-password and resend always answer "sent" so they don't reveal which emails exist. Sign-out (POST, same-origin) revokes the session when Supabase answers within 4 s and **always** expires every `sb-…-auth-token*` cookie, including when Auth is unreachable and the session is expired (supabase-js would otherwise retry for ~30 s and keep the cookies). If "sign out everywhere" can't be confirmed, the sign-in page says so.
- Email links go to `/auth/confirm` (token hash, works across browsers) or `/auth/callback` (PKCE code, OAuth/SSO). The post-auth `next` is restricted to same-origin paths (`safeNext`). Redirect URLs use `NEXT_PUBLIC_APP_URL`, else the request's Host header origin (`requestOrigin`), never the bind address.
- Available methods come from `GET <supabase>/auth/v1/settings` (cached 60 s): buttons exist only for enabled providers; SAML is shown only when the project has SAML enabled.

## Row Level Security
RLS is enabled on every public table (migration 004). The app's server connection owns the tables and enforces ownership in SQL `WHERE` clauses. RLS is the second layer for anything that uses the Data API with a user's JWT: `authenticated` users can **read** only their own rows (`auth.uid()`), plus audits shared with an organization they belong to (`sitelens_private.is_org_member` / `can_read_audit`, `SECURITY DEFINER` with a fixed `search_path`). Direct writes are denied except to the user's own `user_settings` row and the `display_name`/legacy `avatar_url` columns of their own `profiles` row (all other changes go through the server API). The app only accepts profile display-name updates, never uses the stored `avatar_url` value for display, and only returns an avatar derived from a validated GitHub OAuth session. Migration 005 removes the privileges Supabase grants to API roles by default: `audits`/`usage_records` are readable only column by column without internal columns (IP hash, access-key hash, idempotency key, lease, crawl state); app functions are not executable by `anon` (only the two RLS helpers by `authenticated`); sequences are server-only. `anon` reads only the public `plans` catalogue. Tested in `tests/rls.integration.test.ts`.

## Persistence
Tables (after migration 004, which renamed the Phase 1–2 tables in place, keeping data): `principals`, `websites`, `audits` (incl. hashed access key, idempotency key, `rerun_of`, optional `organization_id`), `audit_pages`, `audit_links`, `audit_issues` (with resolution status), `audit_metrics` (value, unit, source and context such as device/strategy), `audit_artifacts`, `audit_history` (status transitions and events), `ai_recommendations`, `usage_records`, `user_settings` (provider *references* only, no keys), `profiles` (FK to `auth.users`, cascade), `organizations`, `organization_members`, `plans`, `subscriptions`, plus `schema_migrations`. New audit history is pruned to `FREE_ACCOUNT_HISTORY_LIMIT`; legacy anonymous settings remain compatibility-only. Deleting an account removes the user's audits and all dependent rows by cascade, then the Auth user.

## Logging
`src/lib/logger.ts` passes every message and error through `redact()`, which removes API keys (OpenRouter, Google, Supabase `sb_secret_`/`sb_publishable_`), JWTs, bearer tokens, Supabase session and PKCE cookies, whole `Cookie`/`Set-Cookie` values, `token_hash`/`code`/refresh-token parameters, passwords and database URLs, and masks email addresses (`j***@example.com`). Route errors return mapped codes and generic messages, never stack traces, SQL or provider bodies. Covered by `tests/logger-redaction.test.ts`.
