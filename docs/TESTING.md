# Testing SiteInsights

**A TalhaImtiazWorks Product · Node 22+**

These are reproducible procedures, not claims that hosted services have been tested. Current actual results and known skips are in [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md). Use only disposable local/test services: integration and UI checks create/delete users and audit data. Never run them against production.

## Offline / local fixture checks

```sh
npm ci
(cd worker && npm ci && npx playwright-core install --with-deps chromium)
npm run brand:check
npm run typecheck
npm run lint
npm test
npm run build
# Or all application checks in order:
npm run verify
(cd worker && npm run typecheck)
```

Root dependencies must be installed before worker typechecking, because the worker reuses shared root modules. A normal application production build does not require Chromium. The browser-worker integration suite does; it explicitly skips if its browser prerequisite is absent.

The standard suite uses real route handlers, repositories, cryptographic verification, the actual scanner and local HTTP fixtures. AI/PageSpeed responses are injected test doubles; these do not prove hosted provider access. `tests/helpers/auth-fixture.ts` creates a test-only RSA issuer/JWKS endpoint and signs test sessions verified by the actual Supabase SDK; this is not a production authentication bypass. Production continues to use the configured Supabase service.

### Focused regressions

- `mandatory-auth.test.ts`: all public audit verbs refuse anonymous users (including when the deprecated anonymous flag is true); missing/unconfigured/invalid/expired/anonymous-JWT sessions, user-ID/header forgery, ownership, idempotency, legacy-key denial, service guard and trusted background defenses.
- `brand-system.test.ts` / `branding.test.ts`: exact supplied logo SHA/canvas/alpha, canonical palette/CSS synchronization, light/dark text and state contrast, assets, preserved crawler token, metadata and reduced-motion status markup.
- `scan-lifecycle.test.ts`: real scanner against local fixture HTTP, persistence boundaries, retries, leases, idempotency and authenticated ownership. No production fetch override is introduced.
- `invitation-email-verification.test.ts` / `invitation-response-routes.test.ts`: fresh request-scoped Auth user, matching user ID, confirmed-email timestamp, fail-closed errors, and accept/reject use of the server-confirmed email; also checks combined organization/member prefetch avoids one route call per team.
- `brand-colors.test.ts` / `logo-client.test.ts`: add/edit/remove and persist named colors; normalize hex input, reject invalid/duplicate/over-limit values, preserve legacy palettes, and check browser-side PNG/JPEG dimensions before decode.
- `professional-profile-persistence.test.ts` / `logo-validation.test.ts` / `professional-profile.test.ts`: round-trip named colors and validated PNG logo data; exact 1 MiB bound, MIME/content mismatch, SVG, pixel/dimension caps, full server decode, and publication opt-in behavior. `accounts.integration.test.ts` includes opt-in real Postgres round-trips for professional data and audit sharing; it requires the documented disposable Supabase/Auth/Postgres prerequisites.
- `audit-sharing.test.ts`: local repository/API coverage for private-by-default state, explicit share/unshare, current-member audit listing and read-only direct API access, outsider and removed-member denial, stale/competing compare-and-set requests, and owner-only edits. `accounts.integration.test.ts` exercises full report/findings/evidence reads, team member removal and deletion with real Auth/Postgres; `rls.integration.test.ts` verifies unshare/removal visibility on the audit and child evidence tables when the disposable Supabase database is configured.
- `brand-system.test.ts` / `product-ui.test.ts`: loading skeletons keep an accessible status without duplicating visible loading boxes, reduced-motion rules disable entrance animation, controls wrap at narrow widths, and prospect status filters use `aria-pressed`.
- `avatar.test.ts`, `auth-avatar.test.ts`, `session-provider.test.ts`, `oauth-provider-flow.test.ts`, and `profile-avatar.test.ts`: GitHub-only trusted HTTPS avatar URL policy; signed OAuth-start provenance and session-id binding; sign-in versus account-link flow handling; linked-provider, ambiguous-identity and non-GitHub fallback; client URL rejection; profile/session behavior independent of legacy stored avatar data; image-load fallback; upload-flow removal; and preservation of migration 007 outside automatic migrations.
- `pdf-report.test.ts`: real `pdf-lib` output/metadata, all report sections/findings, route authorization/content length/allowance refunds, long URLs, Unicode and 260-finding stress case under 30 seconds. The retained `pdfText` tests cover an old compatibility helper, not the new Unicode renderer.
- `worker-render.integration.test.ts`: real Chromium, mobile/axe rendering, request limits, private-address/subresource/rebinding protection and resource cleanup.
- SMTP/template/Auth configuration tests remain offline: no real Mailjet credentials, connection or external messages.

## Real PostgreSQL + Supabase Auth / RLS

Use a separate disposable database and real Supabase Auth service. Configure privately:

- `TEST_DATABASE_URL` — ordinary PostgreSQL fixture database.
- `TEST_SUPABASE_URL` — Supabase gateway origin.
- `TEST_SUPABASE_ANON_KEY` — publishable/legacy anon key.
- `TEST_SUPABASE_SERVICE_ROLE_KEY` — server-only test admin key (for throwaway users).
- `TEST_SUPABASE_DATABASE_URL` — same test Auth project's PostgreSQL database, with application migrations.

```sh
npm exec vitest run tests/accounts.integration.test.ts tests/postgres.integration.test.ts tests/rls.integration.test.ts
# With the test variables in scope, the complete suite also enables extra lifecycle cases:
npm test
```

Account integration exercises real session cookies and expiry/forgery handling, sign-in/out persistence, cross-user denial on all read/write/export/compare paths, read-only organization sharing/revocation, ignored client owner/plan fields, concurrency/idempotency/limits/refunds, explicit same-browser legacy claims and account deletion. RLS uses real PostgreSQL roles and application schema policies. Two prerequisite-marker tests intentionally remain skipped even when their corresponding real suite runs; they are not failures or extra passes.

### Local stack without Docker

The repository retains existing development helpers under `scripts/local-supabase/`. Use PostgreSQL 15+ and an actual Supabase Auth (GoTrue) binary; configure its credentials privately. Do not package that directory's runtime configuration or database files.

```sh
GOTRUE_DIR=~/gotrue scripts/local-supabase/setup-db.sh
node scripts/local-supabase/smtp-sink.mjs # loopback SMTP 2500; captured inbox/templates HTTP 2501
node scripts/local-supabase/gateway.mjs  # loopback 54321/auth/v1 -> GoTrue 9999
(cd ~/gotrue && ./auth serve -c gotrue.env)
```

The setup helper creates development databases/roles and applies app migrations. Its explicit `RESET_SUPA=1` option destroys the local test database and must never be used for a hosted project. SMTP capture is memory-only and never delivers mail externally. GoTrue template URLs can point to `http://127.0.0.1:2501/templates/<name>.html`.

Optional special databases (`REPRO_EMPTY_URL`, `REPRO_OLD_URL`, `REPRO_MISMATCH_URL`, `REPRO_NOPERM_URL`) enable production-failure regressions. `TEST_PERCENT_DATABASE_URL` enables the special percent-password/PgBouncer suite. Absent fixtures are reported as skips, never passed. The normal URL-driver/error-classification tests still run without these databases.

## Real production UI acceptance

Start a production-mode build connected to the isolated local Auth/PostgreSQL stack. Keep default security headers unless an isolated QA iframe specifically requires a build-time `FRAME_ANCESTORS` override; never weaken production embedding policy for the preview.

```sh
npm run build
npm start -- --hostname 0.0.0.0 --port 3000
# Separate terminal; existing worker dependencies supply Chromium and axe:
BASE_URL=http://127.0.0.1:3000 SINK_URL=http://127.0.0.1:2501 \
SHOTS_DIR=/tmp/siteinsights-redesign-check \
AUDIT_URL=https://example.com/ node scripts/smoke/redesign.mjs
```

Both app and SMTP sink origins are restricted to loopback in this script. It creates real throwaway accounts, clicks actual signup/confirmation/login/logout controls, confirms messages captured from real GoTrue, explicitly submits one real public-site audit, downloads the actual PDF, verifies ownership/invalid sessions, checks light/dark desktop/mobile/account/report layouts and axe rules, and removes its test accounts. No test passwords, sessions, auth links or private keys are saved in its result JSON.

To additionally test a **validly signed expired** local GoTrue session, privately supply `TEST_SUPABASE_JWT_SECRET` matching that disposable service. Otherwise that part is explicitly “not configured”; independently signed expiry regressions still run in Vitest. Never expose a production JWT secret.

Controlled browser interception holds genuinely pending requests to inspect session/Auth/audit/PDF/logout loading and duplicate-submit locks, then releases the real request. One invalid-login response is a deliberate browser error fixture; successful sign-up/session/audit/ownership/PDF flows use actual local services. These QA delays are not application delays. Next loading boundaries may stream a server-rendered redirect inside HTTP 200; the script verifies the redirect and absence of the protected form, while all unauthenticated data/execution APIs must return HTTP 401.

Other retained smoke scripts:
- `scripts/smoke/oauth-e2e.mjs`: drives the actual PKCE callback through local OAuth provider mocks (or real providers when explicitly configured), including GitHub-avatar acceptance, Google default-avatar behavior, Google-to-GitHub-linked-account default-avatar behavior, cancellation and safe redirects. It creates disposable Auth users and only deletes them when a private test admin key is supplied; never point it at production. A run with provider mocks is still not proof of hosted Google/GitHub connectivity.
- `scripts/smoke/loading.mjs`: real pending dashboard/history/report requests, honest report 404 cleanup, keyboard skip-link/mobile navigation and pending route-transition cleanup. Requires private `TEST_SUPABASE_URL` / `TEST_SUPABASE_SERVICE_ROLE_KEY`; both app and provider must be loopback. Creates/deletes one actual local provider user and never sends mail. Use `SHOTS_DIR` for its screenshots/results.
- `scripts/smoke/plans-e2e.mjs`: plans, credits and lead-generation acceptance against a real `next start` production build and a real PostgreSQL database. It runs real audits of a public site (default `AUDIT_URL=https://books.toscrape.com/`) and checks: Free is capped at 25 pages and Business crawls more than 100 (`BIG_PAGES`, default 120); credits settle as 10 + processed pages; progress counters reconcile; tampered request fields are rejected; SSRF targets are refused; cross-account reads 404; the operator CLI grant works; the PDF, prospects and CSV export work; share links can be revoked; and insufficient credits return 402 with an affordable page count. It signs sessions with a **test-only JWKS issuer** (no real Supabase project is involved). Point `DATABASE_URL` only at a disposable, freshly migrated database; the script creates accounts and audits there. Results go to `OUT_DIR` (`e2e-results.json`, `e2e-business-report.pdf`). Run `npm run build` first.
- `scripts/smoke/auth-e2e.mjs`: local API account/signup/reset/team/history/rerun lifecycle; requires background processing and local SMTP capture.
- `scripts/smoke/branding.mjs`: public route/assets/mobile/reduced-motion checks. Optional `AUDIT_URL` now requires an existing verified test account through privately supplied `SMOKE_AUTH_EMAIL` / `SMOKE_AUTH_PASSWORD`—there is no anonymous execution.
- `scripts/smoke/email-render.mjs`, `worker/e2e/email-shots.mts`: optional local captured-mail rendering; not proof of real inbox delivery.
- Older worker UI scripts are historical maintenance aids; check their expectations against the mandatory-auth policy before using them.

## Manual release matrix

1. Public pages remain accessible; direct start/advance/rerun/results/export/history calls without a verified account return 401, even when legacy access keys/user-ID headers are supplied.
2. Invalid/expired sessions fail closed. Auth outage is a retryable 503, not permission. No stale busy state or pre-login replay occurs.
3. Sign-up, explicit confirmation, safe return, login, logout and persistence work. Test every **actually enabled** Google/GitHub/SAML provider with its operator; local mocks do not prove external OAuth/SSO.
4. Owners can edit, export and explicitly share/unshare; current team members can read the shared report, findings and page/link evidence but cannot mutate it. Unshare, membership removal and team deletion revoke access; unrelated users still get 404.
   - Avatar: a validated GitHub OAuth session can show the provider-supplied GitHub avatar; email/password, Google, SSO and all other sessions use initials, including when a legacy profile row contains an avatar URL. Verify profile settings, the shared navigation/account menu and dashboard header agree, a failed image falls back to initials, and profile PATCH rejects client-provided `avatarUrl`.
5. View header/Auth/loading/footer at desktop/tablet/320–375 px. Check original logo proportions/alpha/artwork, keyboard focus, inline links, mobile menu and reduced-motion behavior.
6. Observe real route/session/auth/audit/history/report/PDF loading and clear completion/error/timeout. Route boundaries should show layout-matched skeletons, audit progress should retain its measurable progress bar, and small actions should use button-level feedback rather than a second loader box. Verify reduced-motion preferences, top-edge navigation/sign-out progress, visible retry errors, and duplicate-submit locking. Slow a request only in QA, never in product code.
7. Generate a real report and inspect its PDF visually: actual URL/dates/summary/findings, complete evidence, correct logo/colors, page numbering, table continuations and no blank/clipped pages. Separately stress long URLs, Unicode and large synthetic fixtures, clearly labelled as fixtures.
8. Preserve scanner/DB/RLS/provider integrations; test configured optional services separately. No fictional scores, field metrics, findings or live-service success.
9. Build the ZIP, inspect exclusions, independently extract it, install with lockfiles and rerun essential checks. Configure private environment values only after extraction.

Automated axe results cover a subset of accessibility requirements and are **not** a WCAG conformance/legal claim. A local production build is not DNS/HTTPS/Vercel/Supabase cloud/SMTP readiness proof.
