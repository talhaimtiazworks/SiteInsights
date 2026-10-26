# SiteInsights

**AI-Powered Website Auditing** · **A TalhaImtiazWorks Product**

> Find website issues. Understand them. Fix them.

SiteInsights is a product created by **TalhaImtiazWorks**, not a separate company.
The intended production domain is **https://siteinsight.xyz**; DNS, HTTPS, Vercel domain verification and live routing have **not** been verified by this source-code delivery. Keep the existing deployment working until the staged [domain transition checklist](docs/REBRAND.md) is complete.

Evidence-based website audits: SiteInsights crawls a public website, detects broken links, technical SEO, accessibility, rendering and performance problems, scores each category with a published formula, exports PDF reports, and (optionally) explains verified findings with AI via **OpenRouter** or **Google Gemini**.

Built with Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS, Zod, and **Supabase** (Postgres + Auth) with the official `@supabase/ssr` client. Deployable to Vercel.

## Features
- **TalhaImtiazWorks design system**: the supplied official logo is preserved byte-for-byte; the light interface uses the canonical maroon/cyan/warm-neutral palette. Route, session, auth, audit and PDF loading feedback stays accessible and respects reduced-motion preferences.
- **Accounts (Supabase Auth)**: email/password sign-up with email verification, sign-in, sign-out, forgot/reset password, persistent server-validated sessions (HttpOnly cookies, JWT verified with `getClaims()`), Google and GitHub sign-in, and SAML SSO with domain discovery (Supabase Pro). Buttons appear only for methods enabled in the Supabase project.
- **Provider avatars**: the shared profile and account-menu avatar uses a validated GitHub image only for a GitHub OAuth session. Email/password, Google, SSO and other sessions use the existing initials avatar; missing or failed images fall back to initials. No custom upload, remote image lookup, or client-provided avatar URL is used.
- **Dashboard with real data**: totals, completed/running/failed, average score (only when valid), severity distribution, latest issues, recent activity, usage with reset times, and plan. The audits list supports search, filter, sort, pagination, rename, delete, retry, rerun, compare, PDF export and explicit team sharing. The comparison view shows score, issue, broken-link and metric changes and flags anything not comparable. Account pages cover profile, security, connected providers, professional-profile and client-report publication settings, AI settings, usage & plan, teams and account deletion.
- **Ownership and isolation**: every audit request checks server-side ownership or current team membership; unrelated users receive the same 404 as a missing audit. Owners can explicitly share or unshare audits, while team access is read-only and never transfers ownership. Row Level Security on all tables is a second layer. Owner and plan are never taken from the client.
- **Background processing**: audits are saved before work starts and finish without an open tab (Vercel-compatible hand-off plus a scheduled sweep).
- **Safe crawler** — DNS-validated, rebinding-resistant (re-checked at socket connect and on every redirect), same-site, robots.txt-respecting, sitemap/sitemap-index discovery, URL normalisation and de-duplication, crawl-trap avoidance, configurable limits (25 pages / depth 3 by default).
- **Broken-link checking** — internal and external links and images, HEAD with GET fallback; distinguishes 404/410, 5xx, DNS, TLS, connection, timeout, redirect loop, too many redirects, invalid URLs. Blocked/auth responses (401/403/429…) are reported as *unverified*, never as broken.
- **Technical SEO & more** — 39 deterministic rules (titles, meta descriptions, H1s, heading hierarchy, canonicals, noindex, robots.txt, sitemap, redirects, orphan candidates, alt text, `lang`, HTTPS, mixed content, links to non-canonical/HTTP URLs). Each finding has severity, type (error / recommendation / observation), evidence, detection method, recommendation and timestamp.
- **JavaScript rendering & mobile (optional)** — an isolated browser worker (`worker/`, Playwright + Chromium, separate Docker service) renders key pages on a mobile viewport: JS errors, failed requests, broken images, JS-only content and links, metadata changed by JS, horizontal overflow, small text and tap targets. SSRF protection applies to every browser request.
- **Accessibility** — HTML checks on every page plus axe-core on rendered pages, with selectors, impact, WCAG criteria and fixes; clearly not a conformance or legal assessment.
- **Performance (optional)** — Google PageSpeed Insights: Lighthouse lab metrics (LCP, CLS, FCP, TBT, Speed Index, resources) and Chrome UX Report field data (LCP, INP, CLS) kept strictly separate, with source, device and time; "Not evaluated" when unavailable.
- **More SEO checks** — 74 rules incl. JSON-LD validity, Open Graph/Twitter tags, hreflang, canonical/robots/sitemap conflicts, redirect chains, duplicate content, generic titles, viewport.
- **Reports** — coverage ("what was evaluated"), action plan, issue table with evidence, and a server-generated **PDF** with the official logo, complete multi-page findings, page numbers, Unicode fallback fonts and an attached lossless JSON export.
- **Scores** — per category, reproducible formula documented at `/help#scoring`; "Not evaluated" instead of invented numbers.
- **AI (optional)** — per-issue explanations and an audit summary from verified findings only; schema-validated output, bounded retries, prompt-injection-safe data delimiting, clear provider errors, opt-in failover, per-user provider preference, server-side keys only.
- **Free plan**: server-enforced, concurrency-safe limits (audits, AI requests, burst caps, AI input size, browser pages, accessibility tests, performance tests, PDF exports, concurrency, history) per verified account, with network abuse protection, with reset times. `plans`/`subscriptions` tables are ready for paid plans (no checkout is included).
- **Runs serverless**: audits proceed in short, lease-protected, resumable steps (≤20 s each by default), idempotent on retries and duplicates.

## Quick start
Requires **Node.js 22+ and npm** (`.nvmrc` selects 22). The locked Supabase SDK packages require Node 22, even though Next.js itself can run on older Node releases.

```bash
npm ci
npm run dev            # http://localhost:3000
```
Public pages can be developed without configuration. **Every audit requires verified Supabase authentication**, including local development: set the project URL and publishable key before testing audits. Missing Auth configuration fails closed; no free anonymous scan is permitted. Local authenticated development can use temporary memory storage, but **production requires a persistent database** (`DATABASE_URL`, or `POSTGRES_URL` from the Supabase integration). Missing database setup produces a clear setup error, not lost reports. AI, the browser worker and PageSpeed remain optional; unavailable checks are honestly marked “Not evaluated”.

**Production setup (Supabase + Vercel): follow [docs/SUPABASE.md](docs/SUPABASE.md).** GitHub avatars require the GitHub OAuth provider to be enabled; there is no separate avatar-storage configuration. For local development, copy `config/environment.example.txt` to `.env.local` and fill in what you need (`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`, `OPENROUTER_API_KEY` / `GEMINI_API_KEY`, `PAGESPEED_API_KEY`, `BROWSER_WORKER_URL` + `BROWSER_WORKER_TOKEN`).

Browser worker locally:
```bash
cd worker && npm ci && npx playwright-core install chromium
WORKER_TOKEN=$(openssl rand -hex 32) npm start          # listens on :8080
# app: BROWSER_WORKER_URL=http://127.0.0.1:8080 BROWSER_WORKER_TOKEN=<same token>
```

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | TypeScript |
| `npm run lint` | ESLint |
| `npm test` | Vitest (unit, fixture-server integration; Postgres tests with `TEST_DATABASE_URL`; Supabase Auth + RLS tests with `TEST_SUPABASE_*`) |
| `npm run verify` | brand check + typecheck + lint + test + build |
| `npm run email:check` | Offline Mailjet configuration validation by default; `--verify`/`--send-test` are explicit operator actions, never automated tests |
| `npm run email:check-client` | Inspect a production build for synthetic SMTP credential canaries (see testing guide) |
| `npm run brand:check` | Reject obsolete display branding and missing product assets |
| `npm run release:zip` | Create and independently validate the source ZIP (Python 3) |
| `npm run db:migrate` | Apply migrations incl. RLS (uses `POSTGRES_URL_NON_POOLING`, else `DATABASE_URL`) |
| `npm run db:generate` | Regenerate `src/lib/db/migrations.ts` and `db/supabase-setup.sql` from `db/migrations/` |

## Mailjet SMTP readiness

Hosted **Supabase Auth still sends authentication email**; no duplicate Next.js sender or public test-email endpoint was added. The existing operator adapter/diagnostic now supports **Mailjet** (`in-v3.mailjet.com`, preferred 587 + mandatory STARTTLS; alternative 465 + implicit TLS), an **API key / Secret Key** pair and an independently verified sender. Credentials ship blank; no live Mailjet delivery was tested.

**Vercel variables alone do not configure Supabase.** The current web app does not send with Nodemailer, so do not create unused Vercel SMTP variables solely for Auth. Configure Mailjet in the **existing Supabase project's custom SMTP settings**; use the six private env variables only for the explicit operator tools (or a real private environment-storage workflow). Database/production-origin settings remain unchanged. Follow [docs/MAILJET-SMTP.md](docs/MAILJET-SMTP.md) for account/sender/SPF/DKIM setup, credential scopes, redeployment and pending controlled acceptance.

## Documentation
- [docs/MAILJET-SMTP.md](docs/MAILJET-SMTP.md): Mailjet sender/domain setup, Supabase SMTP, actual env consumers, safe diagnostics and pending live-delivery acceptance
- [docs/REBRAND.md](docs/REBRAND.md): official identity, compatibility exceptions, safe domain cutover, OAuth and email checklist
- [docs/RELEASE-VERIFICATION.md](docs/RELEASE-VERIFICATION.md): actual checks and limitations for this delivery

The source ZIP excludes **every `.env*` file**, including examples. Copy the blank text template with `cp config/environment.example.txt .env.local` and configure privately. See [docs/REDESIGN.md](docs/REDESIGN.md) for the authentication, logo, palette, PDF and loading implementation.

See also `CHANGELOG.md`. Production problems: `/api/system/status` (public, no values) and `/api/system/diagnostics` (needs `CRON_SECRET`).

- [docs/SUPABASE.md](docs/SUPABASE.md): Supabase + Vercel setup (project, keys, database, migrations, auth redirects, SMTP and templates, Google/GitHub/SAML, RLS, variables, redeploy, verification)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Vercel project, browser worker, function limits, troubleshooting
- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — every environment variable
- [docs/TESTING.md](docs/TESTING.md) — automated tests and the manual test procedure
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it fits together
- In-app: `/help` (checks, severities, link statuses, scoring, crawler, AI & privacy, limitations)

## Project layout
```
src/app/            pages and API route handlers (incl. /about, robots.txt, sitemap.xml)
src/lib/brand.ts    public SiteInsights / TalhaImtiazWorks identity
src/lib/config/metadata.ts deployment-aware canonical / social metadata and public paths
src/components/     UI components
src/lib/security/   URL / IP validation, SSRF-safe fetch
src/lib/scanner/    crawl engine, robots, sitemaps, HTML parsing, link classification
src/lib/audit/      rule catalogue, analysis (HTML, browser, performance), scoring
src/lib/browser/    worker protocol (shared) and app-side client
src/lib/performance/ PageSpeed Insights client
src/lib/report/     report summaries and PDF builder
src/lib/ai/         provider interface, OpenRouter & Gemini adapters, prompts, schemas
src/lib/usage/      entitlements and metering
src/lib/auth/       Supabase SSR clients, session validation, redirects, providers
src/lib/avatar.ts provider-gated GitHub avatar URL validation and fallback policy
src/lib/services/   audits, background processing, dashboard, compare, account logic
src/proxy.ts        verified-session refresh (getClaims); legacy cookie compatibility
src/lib/db/         repository interface, Postgres & in-memory implementations, migrations
db/migrations/      SQL migrations (001–006; 007 remains outside automatic migrations pending compatibility review)
db/optional/        legacy avatar Storage SQL and pg_cron per-minute sweep for Supabase
supabase/templates/ recommended auth email templates
scripts/            migrations, local Supabase stack, live e2e smoke tests
tests/              Vitest suites, HTML fixtures, fixture server
worker/             browser worker service (Dockerfile, egress proxy, renderer)
public/brand/       logo and icon assets (scripts/brand/ generates them)
```

## Known limitations
- Without the browser worker, JavaScript is not executed; client-rendered content and links are invisible. With it, only the first `BROWSER_MAX_PAGES` pages are rendered.
- Performance is measured for the start page only; lab results vary between runs. Field data exists only for sites with enough Chrome traffic.
- Automated accessibility tests find only part of all barriers; results are not a WCAG conformance claim.
- On Vercel, audits finish in the background only when `CRON_SECRET` is set. Without it, only the first ~50 s run in the background, after which an audit continues only while its page is open. Vercel Hobby allows only a daily cron; use `db/optional/pg_cron_worker.sql` for a per-minute safety net.
- SAML SSO needs a Supabase Pro plan and a configured identity provider; it has not been tested end-to-end against a real IdP here. Production email needs custom SMTP in Supabase (the built-in sender only mails your own team).
- A database is required in production (memory storage is refused on serverless hosting, where instances don't share memory).
- The in-process API throttle is per instance; durable limits (scans, AI) are enforced in the database.
- Orphan detection is limited to sitemap URLs and is suppressed when the crawl was partial.
- External sites that block bots are reported as unverified.
- **No anonymous audits.** Every start, advance, rerun, results/read/write/export/compare path verifies an account server-side. Invalid/expired/signed-out callers receive 401; foreign authenticated accounts receive 404. Report URLs and old private keys grant no authority. Legacy records can only be explicitly claimed by their original browser after sign-in; they cannot execute anonymously.
