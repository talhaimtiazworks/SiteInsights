# Changelog

## Unreleased — 2026-10-21 — Provider-derived profile avatars
- Replaced manual profile-photo uploads with a single provider-avatar policy: only a validated current GitHub OAuth session and a trusted GitHub avatar URL can provide an image; email/password, Google, SSO and other providers use initials, and image errors fall back to initials.
- Removed the upload UI, signed-upload API/client, B2 storage adapter, avatar-object copier, B2 diagnostics/configuration, and avatar-only AWS SDK dependencies. Profile PATCH rejects client-supplied `avatarUrl`; account/session APIs use the validated session avatar, not persisted profile data.
- Kept existing `profiles.avatar_url` data and the legacy migration SQL untouched. Moved migration 007 to `db/optional/` so it is not bundled into automatic migrations pending compatibility review. No production database, environment setting, B2 bucket, key or object was changed.
- Local verification for this source update is recorded in `docs/RELEASE-VERIFICATION.md`; no deployment or hosted-provider acceptance is claimed.

## 2026-10-18 — TalhaImtiazWorks redesign & account-only audits

- Mandatory verified, unexpired, non-anonymous Supabase accounts for every audit API/service execution path; fail-closed missing configuration, account-only background jobs, owner/team authorization and no legacy-key bypass. No schema/RLS/provider replacement.
- Exact supplied official PNG and proportional derivatives across shared branding, Auth, genuine loading, PDF, email and supporting assets; canonical maroon/cyan/warm-neutral light/dark design tokens, accessible controls/links/focus and responsive layouts.
- Actual pdf-lib generator: complete multi-page findings/evidence, width-aware long URLs/Unicode, official logo/palette/metadata, running headers/page footers, lossless JSON attachment and statically traced local assets. Adds `@pdf-lib/fontkit` and licensed Noto fallback fonts.
- Session invalidation, duplicate-action locks, safe sign-in return without automatic audit replay, permanent auth-error recovery and reduced-motion branded async feedback.
- Updated privacy/help/config/deployment/testing guidance, cryptographic/auth/branding regressions and real local-service/browser verification. See `docs/RELEASE-VERIFICATION.md` for actual results and limitations.
- Strict release packaging excludes every `.env*`/credential/dependency/cache/build/Git file; blank sample moved to `config/environment.example.txt`. ZIP CRC/path/extraction/all-file hash verification retained.


## Unreleased — 2026-10-18 — Mailjet SMTP replacement
- Updated the existing operator adapter to **in-v3.mailjet.com / 587 / mandatory STARTTLS**; alternative 465 / implicit TLS. Kept the six variable names and pinned Nodemailer; no dependency or database changes.
- `SMTP_USER` is now a private Mailjet API key; `SMTP_PASS` is its Secret Key. Preserve opaque key bytes/case, reject unsafe whitespace/controls, remove former mailbox/password-format assumptions. `EMAIL_FROM` is an independent Mailjet-verified sender, chosen privately by the operator.
- Restricted the explicit self-test to EMAIL_FROM, never the API key, with verified TLS, safe acceptance/error/unknown outcomes, no retries and no public endpoint. Hosted Supabase still generates/sends authentication mail; no second sender or changed Auth/UI/recipient behavior.
- Strengthened Mailjet API/Secret Key label, raw/encoded/combined-auth redaction and build-canary tests; retained all prior anti-enumeration/CSRF/rate-limit protections and byte-identical auth flows/templates/database/production config.
- Added `docs/MAILJET-SMTP.md` with account/sender/domain/SPF/DKIM/activation steps, separate Supabase setup and actual variable consumers. No unused Vercel SMTP variables are required for hosted Auth; optional private operator workflows only. Database credentials stay unchanged.
- Updated automated mocks, TLS/config/secret/auth boundaries and complete-source ZIP requirements. Actual executed counts and fresh-archive results: `docs/RELEASE-VERIFICATION.md`. No credentials requested/invented, live provider changes, DNS changes or real messages; delivery acceptance remains pending private configuration and a controlled test.

## Historical — 2026-10-18 — prior Gmail SMTP readiness (superseded)
- Replaced the active legacy SMTP setup adapter with strictly validated Gmail/Google Workspace host, TLS/port, App Password and same-account sender settings; credentials remain blank placeholders.
- Preserved hosted Supabase Auth delivery, database, templates, token links/recipients, OAuth/SSO, notification flags and anti-abuse/rate limits. No duplicate app mailer or public SMTP endpoint; no cloud changes or real mail.
- Added pinned Nodemailer 10.1.4 and operator-only offline validation / explicit handshake / explicit one-own-account-message diagnostic. Verified TLS, bounded phase timeouts, safe outcomes, no raw provider logs and no automatic resend after uncertainty.
- Hardened the explicit Supabase configurator: validate before network, 15s deadlines, no redirects or retry, sanitized errors, redacted sender/credentials, SMTP-only no URL mutation/requirement.
- Added `delivery: "unverified"` to compatible forgot/resend acknowledgements; conditional UI copy avoids claiming inbox success. Preserved non-enumeration, safe status codes, real CSRF and throttles.
- Added SMTP/configuration/service/error/boundary/mock integration tests, stronger secret redaction and a compiled-build canary checker. See `docs/RELEASE-VERIFICATION.md` for executed results and pending live acceptance.
- Documented Google prerequisites, exact Vercel Production/Preview/redeploy steps and **separate Supabase custom SMTP** setup in `docs/GMAIL-SMTP.md`. The older 0.4.0 provider notes below are history, not current setup instructions.

## Unreleased — 2026-10-18 — SiteInsight rebrand
- Rebranded the existing product to **SiteInsight — AI-Powered Website Auditing**, with the tagline **Find website issues. Understand them. Fix them.**
- Added **A TalhaImtiazWorks Product** attribution to shared UI, authentication cards, the About page, documentation, HTML/plain-text email templates and PDF/JSON exports. SiteInsight remains the primary product identity; it is not presented as a separate company.
- Adapted the existing indigo/cyan inspection mark with insight bars; regenerated outlined wordmarks, favicon, app icons and social cards. No official parent-brand logo was present, so parent attribution is text only.
- Added deployment-aware public canonical/social metadata, WebApplication structured data, robots and a public-only sitemap. The intended domain is **https://siteinsight.xyz**, **not verified live** by this delivery.
- Kept authentication callbacks and URL resolution compatible. Committed emails follow Supabase's existing Site URL; external domain changes are manual and staged. Retain the existing Vercel deployment and allow-list entries during transition.
- Preserved migration SQL, database/RLS identifiers, session/storage keys, crawler robots token, secrets and provider behavior. No new database migration, production data reset or cloud-configuration change.
- The optional worker Docker build now uses its existing lockfile with `npm ci`; no dependency versions were upgraded.
- Aligned runtime requirements to **Node.js 22+** to match the already-locked Supabase SDK; dependency versions and integrity hashes were not upgraded.
- Made reduced-motion spinners and skeleton pulses static; preserved status text and existing loading/retry behavior.
- Added brand/domain-transition regression checks and source ZIP creation/integrity validation. Executed results and external-test limitations: `docs/RELEASE-VERIFICATION.md`.


## 0.4.0 — audit failure fix, auth redirects, branded emails, loading states
- **Start audit failure (reference d50d231d):**
  - **Root cause:** deduced from production behaviour and a local reproduction (the production logs had expired). A `%` in the database password that isn't URL-encoded passes URL validation, but makes the Postgres driver throw `URIError: URI malformed` when the connection is created. That happened outside database error handling, so every database route returned a generic 500. No audit was created and no allowance used.
  - **Fix:** stray `%` characters are encoded automatically and reported in `configIssues`. Unparsable URLs now give `503 database_misconfigured` with a fix, and are retried instead of cached. TLS/authentication errors are classified as misconfiguration, and serialization/deadlock errors as `database_busy` (retryable).
- **Allowance and retries:**
  - If saving a new audit fails after the allowance was counted, it is refunded exactly once.
  - A retry with the same idempotency key returns the audit that was already created; it never makes a duplicate.
  - The 25-page, 10-per-day and robots.txt limits are unchanged and enforced on the server.
- **Auth redirects:**
  - `NEXT_PUBLIC_APP_URL` pointing at localhost is ignored on Vercel and reported. Vercel production falls back to `VERCEL_PROJECT_PRODUCTION_URL`.
  - Supabase link errors reported in the URL fragment (`#error_code=otp_expired`) now land on the sign-in page with a clear message.
  - Invitation links continue to "Choose a new password".
- **Branded auth emails** (`supabase/templates/`, generated by `scripts/email/build-templates.mjs`):
  - Templates for confirm signup, reset password, email change, magic link, invite and reauthentication, plus optional security notifications.
  - Responsive HTML with a plain-text twin for each. Links go straight to the production domain's click-to-confirm page.
  - Rendered through real Supabase Auth and checked at phone and desktop widths, with images on and off.
  - Supabase sends HTML only; the plain-text files are reference copies (documented).
- **Supabase setup script:** `scripts/supabase/configure-auth.mjs` sets the Site URL and Redirect URLs, uploads templates, and configures Postmark SMTP through the Management API. It does a dry run by default, never removes existing redirect URLs, and never prints secrets.
- **Docs:** exact Supabase URL settings for `https://sitelens-ai.vercel.app`, a step-by-step Postmark setup (sender/domain verification, DKIM, Return-Path, approval, delivery test), and troubleshooting for localhost email links and the `%` password.
- **Loading and states:**
  - The Start audit form offers "Try again" after temporary failures, reusing the same idempotency key, and announces "Starting your audit…" to screen readers.
  - The progress page announces phase changes and the outcome.
  - `prefers-reduced-motion` slows spinners and stops transitions.
  - Fixed horizontal overflow at phone widths on the dashboard and all account settings pages.
- **Tests:** database-url integration (real Postgres through a pooler plus Supabase Auth); app-URL, link-error, email-template and setup-script unit tests; a real-GoTrue email render run; email screenshots; and a v0.4 browser suite.

## 0.3.2 — production repair
- **Start audit / dashboard "Something went wrong on our side":** database errors other than connection failures fell through to a generic 500. Reproduced locally with four misconfigurations, all producing that exact message: unmigrated database, outdated schema, role without privileges, and a database from a different Supabase project than Auth (the latter also broke password sign-in). Each now has a specific `503` code and message. The schema and privileges are verified on cold start, the server log carries the fix, and genuine bugs return a reference id.
- **Configuration consistency:** project refs from every Supabase variable are compared. Issues are reported by variable name (never value) in `/api/system/status` → `configIssues`: `DATABASE_URL` overriding a correct `POSTGRES_URL`, the IPv6-only direct host or the session pooler at runtime on Vercel, a pooler user without the ref, and a `service_role` key in a public variable.
- **Diagnostics:** `GET /api/system/diagnostics` (Bearer `CRON_SECRET`) runs live checks of the database, migrations, Auth, OAuth providers, the Auth ↔ database same-project proof (rollback-only), the browser worker, PageSpeed and AI.
- **Migrations:** automatic migrations use the session connection of the same project when available, falling back to the runtime connection. Still idempotent; nothing is ever dropped. No new SQL migration in this release.
- **Profiles:** sign-in (password, email link, OAuth) no longer fails on a database problem after Supabase Auth succeeded. Signed-in dashboard and history requests ensure the profile row exists, which repairs missing profiles and surfaces project mismatches instead of showing an empty dashboard.
- **Recoverable audits:** a transient database outage mid-step no longer marks the audit `failed`. It stays queued/running and resumes from the last saved step on the next attempt (cron, hand-off or open page). An audit deleted while processing stops quietly instead of logging an internal error.
- **UI:** clearer storage error states; the start form's optional-checks note no longer uses server jargon.
- **Tests:** production-failure reproductions, config-consistency unit tests, an OAuth end-to-end suite (HTTP and real browser) against a local provider stand-in, and a run of the database suites through a transaction pooler.
