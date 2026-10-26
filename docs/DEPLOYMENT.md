# Deploying SiteInsights

**A TalhaImtiazWorks Product** · Intended origin: `https://siteinsight.xyz`. **Not verified live.** Existing installations must follow [REBRAND.md](REBRAND.md) before changing production URLs; keep the existing Vercel alias, Supabase project, database and OAuth credentials. Do not provision replacements just to rename the product.

> These are the exact steps. The authors have **not** deployed this repository to any Vercel project or container host as part of delivery; you run these steps in your own accounts.

SiteInsights has up to three parts:

| Part | Where | Required? |
|---|---|---|
| Next.js app (UI + API) | Vercel (or any Node 22+ host) | Yes |
| Supabase (Postgres + Auth) | supabase.com, connected via the Vercel integration | **Yes.** Verified Supabase Auth is mandatory for all audits; persistent PostgreSQL is required in production. |
| Browser worker (`worker/`) | Any Docker host: Fly.io, Railway, Render, Google Cloud Run, a VPS | Optional — enables JavaScript rendering, mobile checks and axe-core |

PageSpeed Insights (performance) and the AI providers are external APIs configured with keys only. Profile avatars come from validated GitHub OAuth session data when the current session is GitHub; there is no avatar upload or object-storage service.

> **Accounts, database, auth redirects, OAuth/SSO and verification are covered step by step in [`docs/SUPABASE.md`](SUPABASE.md).** This page covers the Vercel project, the browser worker and function limits.

## 1. Prerequisites
- A Vercel account and the code in a Git repository (or the Vercel CLI: `npm i -g vercel`).
- A Supabase project (`docs/SUPABASE.md` §1–2), or any Postgres database with a **pooled** connection string if you don't need accounts.
- Optional: OpenRouter and/or Google AI Studio (Gemini) API key; a Google Cloud API key with the **PageSpeed Insights API** enabled; a Docker host for the worker.
- Node.js **22+** locally (required by the locked `@supabase/supabase-js` dependencies) if you want to verify first: `npm ci && npm run verify`. On Vercel, keep the project's Node.js version at 22.x or newer (Settings → Build and Deployment).

## 2. Create the Vercel project
**Dashboard:** *Add New… → Project* → import the repository. The **Next.js** preset is detected (also pinned in `vercel.json`: `npm ci`, `npm run build`). Root directory: the folder containing `package.json`. The `worker/` folder is ignored by the app build (excluded in `tsconfig.json`).

**CLI:** `vercel link` in the project folder.

## 3. Environment variables (Vercel → Settings → Environment Variables)
Connect the **Supabase integration** first (Vercel → Integrations/Storage → Supabase). It sets `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` (exact list: `docs/SUPABASE.md` §3). Then add:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://siteinsight.xyz` is the **intended post-cutover** value (Production environment only). Until verified, keep the existing working origin. Must match Supabase's Site URL. Never `localhost`: it's ignored on Vercel and reported in `configIssues`. |
| `SESSION_SECRET` | output of `openssl rand -hex 32` |
| `CRON_SECRET` | output of `openssl rand -hex 32`. Lets audits finish in the background. |
| `DATABASE_URL` | only if you are **not** using the integration (pooled URL, port 6543 for Supabase) |

There are no avatar-specific environment variables or external storage settings. Enable GitHub OAuth in the existing Supabase project if you want GitHub avatars. This source update does not modify any previously configured B2 environment settings or remote storage resources. After changing actual application variables, redeploy.

AI is strict BYOK — users connect their own keys; no owner key is needed or used. You may still tune `OPENROUTER_MODEL`, `GEMINI_MODEL`, `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_MAX_OUTPUT_TOKENS`. Remove any legacy `OPENROUTER_API_KEY`/`GEMINI_API_KEY`/`AI_PROVIDER`/`AI_FALLBACK_ENABLED` from the environment.

Optional performance: `PAGESPEED_API_KEY` (enables performance tests), `PAGESPEED_STRATEGIES` (`mobile,desktop`).

Optional browser worker (after step 6): `BROWSER_WORKER_URL`, `BROWSER_WORKER_TOKEN`.

**Redeploy after changing any variable** — Vercel applies environment variables only to new deployments, and some pages (help, limits) are rendered at build time.

Never prefix keys with `NEXT_PUBLIC_`. All variables: `docs/ENVIRONMENT.md`. CLI: `vercel env add DATABASE_URL production` (repeat per variable).

### Mailjet SMTP — configure hosted Auth, not a second app sender

Follow **[MAILJET-SMTP.md](MAILJET-SMTP.md)** for exact account/API key/Secret Key, verified sender, SPF/DKIM and Supabase setup. In the **same Supabase project the deployed app already uses**, set custom SMTP host `in-v3.mailjet.com`, port **587 / STARTTLS**, username **Mailjet API key**, password **Mailjet Secret Key**, sender email **your Mailjet-verified address**, sender name **SiteInsights**. Alternative 465 uses implicit TLS. Preserve existing protections, limits, templates, links and recipients.

**Vercel env changes do not configure Supabase.** No current Vercel runtime route sends through Nodemailer; do **not** add unused SMTP vars merely for Auth. The unchanged six SMTP vars in `config/environment.example.txt` are inputs for explicit private operator tools. Only if a real operator workflow uses Vercel as private env storage, update those six existing names there (587/false defaults, API/Secret key, verified sender), Production/Preview separately as actually needed, then **Deployments → ⋯ → Redeploy**. Never public-prefix them or put the operator Management API PAT in Vercel. Deployments/env changes do not execute diagnostics or copy settings to Supabase.

Database/Auth/OAuth/session/cron credentials and working-domain callbacks remain unchanged; no new database, migration or reset is required. The ZIP has blank credentials, no live Mailjet delivery proof. Later controlled receipt/link tests are required after private provider setup; no real email is sent by automated checks.

## 4. Database migrations
Run them explicitly before the first deploy (recommended), using the **non-pooled** URL:
```bash
POSTGRES_URL_NON_POOLING="postgres://…:5432/postgres" npm run db:migrate
```
With `DB_AUTO_MIGRATE=true` (default) they also run on the first request that touches the database, guarded by an advisory lock. Without Node, paste `db/supabase-setup.sql` into the Supabase SQL editor (details: `docs/SUPABASE.md` §4). Automatic migrations are `db/migrations/001_initial.sql` … `006_plans_credits_prospects.sql`; the legacy `db/optional/007_avatar_storage.sql` is deliberately excluded pending compatibility review.

## 5. Deploy the app
Dashboard: *Deploy* (or push to the production branch). CLI: `vercel --prod`.

## 6. Deploy the browser worker (optional)
The worker is a small Node service that launches a fresh, sandboxed Chromium for each render behind an SSRF-filtering proxy. **It loads untrusted websites, so run it on its own host/container, never on the same machine as your database or other internal services.**

Build from the **repository root** (the image includes two shared files from `src/`):
```bash
docker build -f worker/Dockerfile -t siteinsight-worker .
TOKEN=$(openssl rand -hex 32)
docker run -d --name siteinsight-worker -p 8080:8080 \
  -e WORKER_TOKEN="$TOKEN" -e WORKER_CONCURRENCY=2 \
  --memory=2g --restart=unless-stopped siteinsight-worker
curl -s http://localhost:8080/livez                                     # ok
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/healthz  # {"ok":true,"version":...,"busy":0,...}
```
Then put it behind **HTTPS** (your host's TLS, or a reverse proxy) and set on Vercel:
- `BROWSER_WORKER_URL=https://<worker-host>`
- `BROWSER_WORKER_TOKEN=<the same $TOKEN>`

**Where to run it (Vercel can't):** Chromium plus the SSRF proxy needs a long-running container, so Vercel functions are not used for it. Examples:
- **Render**: *New → Web Service → Docker*. Root directory: repository root. Dockerfile path: `worker/Dockerfile`. Instance: 2 GB. Env: `WORKER_TOKEN`. Health check path: `/livez`.
- **Fly.io**: `fly launch --dockerfile worker/Dockerfile --no-deploy`, then `fly secrets set WORKER_TOKEN=…`, `fly scale memory 2048`, `fly deploy`.
- **Railway**: new service from the repo, with `RAILWAY_DOCKERFILE_PATH=worker/Dockerfile`, `WORKER_TOKEN`, 2 GB.
- **Cloud Run**: `IMG=<region>-docker.pkg.dev/<project>/<repo>/siteinsight-worker; docker build -f worker/Dockerfile -t $IMG . && docker push $IMG && gcloud run deploy siteinsight-worker --image $IMG --memory 2Gi --timeout 90 --min-instances 1 --set-env-vars WORKER_TOKEN=…`.

Then set `BROWSER_WORKER_URL` and `BROWSER_WORKER_TOKEN` on Vercel and redeploy. `/api/system/diagnostics` → `browser_worker` confirms the app can reach the worker and that the token matches. Without the worker, the audit form says these checks aren't enabled, and the HTML SEO/link audit runs normally.

Sizing: each concurrent render uses roughly 300–600 MB RAM; `WORKER_CONCURRENCY=2` fits in 2 GB. When busy the worker answers `429` and the app retries a few times, then reports pages as not rendered. Hosts: any that runs a Docker image with ≥1 GB RAM (Fly.io, Railway, Render, Cloud Run with min instances 1 and a 90 s request timeout, or a VPS). The worker needs outbound internet access; it needs no access to your database.

Safety model: every request made by the browser (navigation, redirects, scripts, images, fetch/XHR) goes through a per-render proxy that resolves DNS itself and only connects to public IP addresses on allowed ports; WebRTC, QUIC, service workers and downloads are disabled; each render has a request budget and a hard time limit; the worker never logs URLs or tokens.

## 7. Verify the deployment
Run the account checks in `docs/SUPABASE.md` §14 (sign-up, background audit, sign-out/sign-in reopen, second user gets 404, reset password, delete account). Then:
1. `https://<domain>/api/system/status` →
   - `storage.mode: "postgres"`, `persistent: true`, `ready: true` (if it says `unconfigured`, no database URL is set);
   - `accounts: true` and `background: "full"`;
   - `features.browserRendering` / `features.accessibility` are `true` if the worker is configured; `features.performance` is `true` if PageSpeed is configured;
   - `configWarnings` and `configIssues` are empty, and `storage.problem` is `null`.
1b. `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/system/diagnostics`: every check is `ok` or a deliberate `not_configured`.
2. Test avatars with disposable accounts: a GitHub OAuth session may show its trusted GitHub avatar; email/password, Google, SSO and other providers use initials. Check both profile settings and the shared account menu/dashboard header, then simulate or verify a missing/broken image falls back to initials.
3. `/settings/ai` → **Test connection** for each configured AI provider.
4. Start an audit of a site you own. The form shows the optional checks available on this server; the progress page shows each stage with real counts.
5. On the report, check the **What this audit covered** card, the **Rendering & accessibility** and **Performance** tabs, and **Download PDF**.
6. Refresh the progress and report pages, and open the report in another tab — it must keep working (it is stored in Postgres).

## Function duration
| Route | `maxDuration` | Why |
|---|---|---|
| `POST /api/scans`, `POST /api/scans/[id]/rerun`, `/api/internal/process` | 300 s | Background processing after the response (`BACKGROUND_BUDGET_MS`, 50 s by default), then hand-off to a fresh invocation. |
| `POST /api/scans/[id]/advance` | 90 s | One step: at most `SCAN_STEP_BUDGET_MS` (20 s) of crawling, or one browser render (≤ `BROWSER_WORKER_TIMEOUT_MS`, 45 s) or one PageSpeed test (≤ `PAGESPEED_TIMEOUT_MS`, 60 s). |
| AI routes | 60 s | One AI call with bounded retries. |
| `GET /api/scans/[id]/report.pdf` | 30 s | PDF generation (typically < 2 s). |

Vercel with Fluid compute (the default for new projects) allows these durations on all plans. If your project is limited to 60 s, set `PAGESPEED_TIMEOUT_MS=40000`, `BROWSER_WORKER_TIMEOUT_MS=40000`, `BACKGROUND_BUDGET_MS=30000`, and change `maxDuration` to `60` in the routes above.

**Audits don't depend on an open tab.** Each audit is saved before work starts. It runs in the background after the request responds, hands off to fresh invocations until it finishes (needs `CRON_SECRET`), and an open progress page can also drive it. If any invocation is interrupted, the next one resumes from the last saved step. `vercel.json` schedules a **daily** safety-net sweep, the most Vercel Hobby allows (a more frequent schedule makes Hobby deployments fail). For a per-minute sweep use `db/optional/pg_cron_worker.sql` in Supabase. Details: `docs/SUPABASE.md` §12.

## Troubleshooting: "Something went wrong on our side. Please try again." on Start audit / dashboard
**0.4.0: a `%` in the database password (audit failure d50d231d).** If *every* database-backed route fails instantly with this message (Start audit, dashboard, usage, `/api/system/status` 500) while sign-in works, the database URL is the likely cause. A `%` in the password that isn't URL-encoded (e.g. `…:Summer50%off@…`) passes the app's URL validation, but the Postgres driver decodes the password with `decodeURIComponent` and throws `URIError: URI malformed` while creating the connection. That happened outside any database error handling, so it surfaced as an unclassified 500 with a reference ID. No audit was created and no allowance was used. 0.4.0 encodes a stray `%` automatically (`%25`), lists it in `configIssues`, and turns any other unparsable URL into `503 database_misconfigured` with a fix. To be safe, also replace `%` with `%25` in the Vercel variable. Reproduced and covered by `tests/database-url.integration.test.ts` (driver parity, real signed-in pooler tests when configured, and mandatory anonymous refusal).

**0.3.2: unrecognised database errors.** Only connection failures were recognised as database problems. Every other database error reached the generic HTTP 500 fallback:
- tables missing because migrations ran in another project or not at all;
- an outdated schema;
- a role without privileges;
- a database from a different Supabase project than Auth, where the profile's foreign key to `auth.users` rejects the signed-in user.

All of these were reproduced locally against real Postgres + Supabase Auth and produced exactly that message (`tests/production-failures.integration.test.ts`). Now each one has its own code and message (`database_schema_missing`, `database_schema_outdated`, `database_permission_denied`, `supabase_project_mismatch`, …). The schema is verified on cold start, the configuration is cross-checked (`configIssues`), and the server log carries the fix. Remaining genuine bugs return a reference id that matches the log. Read `/api/system/status` or `/api/system/diagnostics` on your deployment to see which one applies, then follow `docs/SUPABASE.md` › Troubleshooting.

## Troubleshooting: "Scan not found" right after starting an audit
**Root cause (fixed in this version):** without `DATABASE_URL`, earlier versions silently kept scans in the memory of whichever serverless instance created them. Vercel routes the next request to any instance, so the progress or results request often found nothing and returned 404. The fix: production never uses memory storage — without a database the API returns `503 storage_not_configured` and the UI explains how to set it up. Scans are owned by the creating browser (session cookie plus a private per-audit access key), and the UI distinguishes "not found", "no access", "session expired" and "storage temporarily unavailable" instead of showing "not found" for all of them. Regression test: `tests/scan-lifecycle.test.ts` ("per-instance memory storage loses a scan…" and the multi-instance Postgres cases).

If you still see it: check `/api/system/status` (`storage.mode` must be `postgres`), and make sure the database URL is the same for all environments that serve the site.

## Troubleshooting: "No database configured" although Supabase is connected
**Root cause (fixed in this version):** the app only read `DATABASE_URL`, but the Supabase ↔ Vercel integration creates `POSTGRES_URL` (plus `POSTGRES_URL_NON_POOLING`) instead. The app now uses `DATABASE_URL` if set, else `POSTGRES_URL`, removes pooler-only parameters the driver rejects, and reports which variable it used (name only) in server diagnostics. If the banner persists: confirm the variables exist for the **Production** environment (not only Preview), then **redeploy**, because Vercel applies variables only to new deployments. `/api/system/status` must show `storage.mode: "postgres"`. Regression test: `tests/accounts-unit.test.ts` ("database URL resolution").
