# Supabase + Vercel setup guide

**A TalhaImtiazWorks Product.** Intended domain: `https://siteinsight.xyz` — not verified live. **For an existing deployment, do not create a new Supabase project, reset the database, rotate secrets or replace OAuth apps.** Follow [REBRAND.md](REBRAND.md) first, preserving the existing origin and callbacks until cutover testing succeeds. The examples below target the intended domain **only after** those prerequisites.

This guide takes SiteInsights from an empty Supabase account to a verified production deployment with accounts, saved audits, a dashboard and Row Level Security.

> The authors have **not** created a Supabase project or a Vercel deployment for you. These are the steps you run in your own accounts. Every variable name below is one the app actually reads (see `src/lib/auth/supabase-env.ts` and `src/lib/config/env.ts`).

**What you need:** a Supabase account, a Vercel account, this repository in GitHub/GitLab/Bitbucket (or the Vercel CLI), and Node.js **22+** locally to run migrations.

| Feature | Supabase plan |
|---|---|
| Postgres, email/password, Google, GitHub, RLS | Free plan works |
| Production email (to real users) | Any plan, **plus custom SMTP** (step 6) |
| SAML single sign-on | **Pro plan or above** (step 9) |

---

## 1. Create the Supabase project
1. <https://supabase.com/dashboard> → **New project**.
2. Choose the organization, name (e.g. `siteinsight`; keep the existing project for a rebrand), a strong **database password** (store it in your password manager), and a region close to your Vercel functions (e.g. `us-east-1` for Vercel's default `iad1`).
3. Wait until the project is ready. Note the **project ref**, which is the `<ref>` part of `https://<ref>.supabase.co`.

## 2. Get the keys
Dashboard → **Settings → API Keys**, or the **Connect** button at the top of the project.

| You need | Format | Where it goes |
|---|---|---|
| Project URL | `https://<ref>.supabase.co` | `NEXT_PUBLIC_SUPABASE_URL` |
| **Publishable** key | `sb_publishable_…` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (safe in the browser; RLS protects data) |
| **Secret** key | `sb_secret_…` | `SUPABASE_SECRET_KEY` (**server only**, used only for account deletion) |

If your project only shows legacy keys, click **Create new API keys** (the legacy keys keep working). Legacy names are still accepted, with the new names winning when both are set:
`NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY` for the publishable key, and `SUPABASE_SERVICE_ROLE_KEY` for the secret key. Supabase is deprecating the legacy `anon`/`service_role` keys by the end of 2026, so prefer the new ones.

Never put the secret key in a `NEXT_PUBLIC_` variable. The app refuses to enable sign-in if a `sb_secret_` key is placed in the publishable-key variable, and `/api/system/status` shows a warning.

## 3. Connect the database
The app needs two connection strings: a **pooled** one for the app (serverless functions open many short connections) and a **direct/session** one for migrations.

> **All Supabase variables must come from the same project.** If `DATABASE_URL`/`POSTGRES_URL` points at one project and `NEXT_PUBLIC_SUPABASE_URL` at another, people sign in to project A while audits are written to project B. The first account write then fails, which shows up as "Sign-in and audit storage are connected to different Supabase projects" (`503 supabase_project_mismatch`). Versions before 0.3.2 showed only "Something went wrong on our side". The most common way this happens: `DATABASE_URL` was added by hand from one project, then the Vercel integration was connected to another. **`DATABASE_URL` wins over the integration's `POSTGRES_URL`.** The app compares the project ref in every Supabase variable (`<ref>.supabase.co`, pooler user `postgres.<ref>`, `db.<ref>.supabase.co`, legacy JWT keys) and reports mismatches by variable name in `/api/system/status` → `configIssues`.

### Option A: Supabase ↔ Vercel integration (recommended)
Vercel → your project → **Storage / Integrations → Supabase** → connect the project created in step 1 (or create one from Vercel). The integration sets these variables on Vercel automatically:

| Variable set by the integration | Used by SiteInsights for |
|---|---|
| `POSTGRES_URL` | the app's database (transaction pooler, port 6543); used when `DATABASE_URL` is not set |
| `POSTGRES_URL_NON_POOLING` | `npm run db:migrate`, and the app's automatic migrations (only when it is the session pooler of the **same** project; the IPv6-only direct host is never used from Vercel) |
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | Auth project URL |
| `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (older integrations: `…_ANON_KEY`) | publishable key |
| `SUPABASE_SECRET_KEY` (older integrations: `SUPABASE_SERVICE_ROLE_KEY`) | account deletion only |

The other variables it creates (`POSTGRES_PRISMA_URL`, `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`, `SUPABASE_JWT_SECRET`) are not used by this app and can stay.

### Option B: manual
Supabase → **Connect** → *Connection string*:
- **Transaction pooler** (`…pooler.supabase.com:6543`) → set as `DATABASE_URL` on Vercel.
- **Session pooler** (`…pooler.supabase.com:5432`) or **Direct connection** (`db.<ref>.supabase.co:5432`, IPv6 unless you have the IPv4 add-on) → use for migrations only.

Replace `[YOUR-PASSWORD]` with the database password. The app removes pooler-only URL parameters such as `pgbouncer=true` and `supa=…` that the Postgres driver doesn't understand. It uses `prepare: false`, which the transaction pooler requires, and SSL is required automatically for non-local hosts.

## 4. Run the migrations
From your machine, in the project folder:
```bash
npm ci
# Session/direct connection string from step 3 (NOT the 6543 transaction pooler):
POSTGRES_URL_NON_POOLING="postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" npm run db:migrate
```
The script reads the first URL it finds in `MIGRATION_DATABASE_URL`, `POSTGRES_URL_NON_POOLING`, `DATABASE_URL_UNPOOLED`, `DATABASE_URL`, `POSTGRES_URL`. It applies `db/migrations/001…006` in order, records each in `schema_migrations`, and is safe to re-run (already-applied versions are skipped; an advisory lock prevents parallel runs). The legacy `db/optional/007_avatar_storage.sql` is deliberately outside this automatic migration set pending compatibility review; do not apply it as part of this avatar change.

Migration `004_supabase_accounts.sql` creates `profiles`, `organizations`, `organization_members`, `plans`, `subscriptions`, `audits`, `audit_pages`, `audit_issues` (with resolution status), `audit_links`, `audit_metrics`, `audit_history`, `usage_records` and `user_settings`, with foreign keys, indexes and cascades. It also enables **Row Level Security on every table** (step 10). Migration `005_api_privileges.sql` tightens what the Data API roles may do. Supabase grants new tables, sequences and functions to `anon`/`authenticated` by default; 005 removes everything the app doesn't need (step 10).

**Can't run Node locally?** Paste `db/supabase-setup.sql` (all migrations in one transaction; safe to re-run, never deletes data) into **SQL Editor → Run** of **the project your database URL points to**. Pasting it into a different project is a common cause of `database_schema_missing`. Leaving `DB_AUTO_MIGRATE=true` (the default) also works: migrations then run on the first request that touches the database, over the session connection when one is available.

On every cold start the app checks that each migration this version needs is recorded in `schema_migrations` and that its database role can use the tables. A database that isn't (fully) migrated returns `503 database_schema_missing` / `database_schema_outdated`, and the server log lists the missing versions. It never shows a generic error.

Check: Supabase → **Table Editor** lists the tables above, each with the RLS badge enabled.

## 5. Auth URL configuration (fixes email links that open `localhost`)
Supabase → **Authentication → URL Configuration**. For SiteInsights **after the intended domain is configured and tested** (before then keep the existing Site URL):

| Setting | Value |
|---|---|
| **Site URL** | `https://siteinsight.xyz` |
| **Redirect URLs** | `https://siteinsight.xyz/**`<br>`https://sitelens-ai.vercel.app/**` (**retain the existing deployment**)<br>`https://sitelens-ai-*-<your-team>.vercel.app/**` (preview deployments, optional)<br>`http://localhost:3000/**` (local development, optional) |

**Why links went to localhost:** a new Supabase project's Site URL is `http://localhost:3000`. Supabase uses the Site URL in two places: as the base of `{{ .SiteURL }}` in email templates, and as the fallback when the app's `redirect_to` isn't on the Redirect URLs list. So until the Site URL is your production domain, confirmation and reset emails can point to localhost no matter what the app sends. Any URL on the Site URL's host is allowed automatically; `https://siteinsight.xyz/**` makes it explicit.

The app side is covered as well. On Vercel, a `localhost`/`127.0.0.1` value in `NEXT_PUBLIC_APP_URL` is **ignored** and reported in `/api/system/status` → `configIssues`. Without `NEXT_PUBLIC_APP_URL`, production falls back to Vercel's `VERCEL_PROJECT_PRODUCTION_URL`. Redirect targets inside the app are restricted to same-site paths (`safeNext`), so `?next=https://evil.example` can't send users elsewhere.

Also check **Authentication → Sign In / Providers → Email**: *Enable email provider* on, and *Confirm email* on (recommended).

You can apply the URL settings from your own machine instead of the dashboard (dry run first, then `--apply`; see 6.4):

```bash
SUPABASE_ACCESS_TOKEN=<personal access token> SUPABASE_PROJECT_REF=<ref> \
  node scripts/supabase/configure-auth.mjs --app-url https://siteinsight.xyz --urls
```

## 6. Email: branded templates and SMTP

### 6.1 What you can do right now (no sending domain yet)
Supabase's built-in sender keeps working for testing. It **only delivers to members of your Supabase organization's team** (others get `email_address_not_authorized`, which SiteInsights shows as "We can't send email to this address right now") and sends about **2 emails per hour**. Real users can't confirm accounts until custom SMTP (6.3) is set up.

If **Authentication → Emails → Templates** is read-only for your project, configure custom SMTP first (6.3). The default Supabase templates also work with the app: their links go through Supabase to `/auth/callback`, and they must be opened in the same browser.

### 6.2 The branded templates
`supabase/templates/` contains responsive, branded HTML for every Supabase Auth email. The committed copies are generated with `node scripts/email/build-templates.mjs --app-url '{{ .SiteURL }}' --year 2026`, and tests keep HTML, text and subjects in sync. The current Supabase **Site URL** therefore remains authoritative; deploying this source alone does not switch email links to the intended domain. To pin a **verified** origin explicitly, regenerate with `--app-url https://siteinsight.xyz` after cutover (or the existing origin during transition). `--out <directory>` lets you preview without overwriting committed copies.

| Supabase template | File | Subject | Link |
|---|---|---|---|
| Confirm signup | `confirmation.html` | Confirm your email for SiteInsights | `…/auth/confirm?token_hash={{ .TokenHash }}&type=email&next={{ .RedirectTo }}` |
| Reset password | `recovery.html` | Reset your SiteInsights password | `…&type=recovery…` → "Choose a new password" |
| Change email address | `email_change.html` | Confirm your new SiteInsights email address | `…&type=email_change…` |
| Magic link | `magic_link.html` | Your SiteInsights sign-in link | `…&type=magiclink…` plus the one-time code |
| Invite user | `invite.html` | You've been invited to SiteInsights | `…&type=invite…` → set a password |
| Reauthentication | `reauthentication.html` | Your SiteInsights verification code | one-time code (`{{ .Token }}`) |
| Security notifications (optional) | `password_changed_notification.html`, `email_changed_notification.html`, `identity_linked_notification.html`, `identity_unlinked_notification.html` | see `subjects.json` | link to Account → Security / Connected accounts |

Every email has the SiteInsights logo and wordmark, a heading, a large button when needed, a copy-paste fallback link, a security note and a footer with **A TalhaImtiazWorks Product**, the tagline and the supplied copyright attribution. No address, corporate status or contact details are invented. Links use **`{{ .SiteURL }}`** by default: verify Supabase's Site URL points at the **currently working deployment**, never localhost in production, before uploading templates. At cutover, changing that setting changes future emails only; keep the old deployment available for previously sent links. Links open the app's **click-to-confirm page**: the token is used only when the person clicks *Continue*, so mail security scanners that pre-open links can't burn it, and the link works on any device or browser. Expired or used links show "This link is invalid or has expired" with a way to request a new one; the token is never shown on the page or written to logs.

**Plain-text versions:** `supabase/templates/text/*.txt` contain the same message as text. **Supabase Auth sends HTML only**: hosted projects have no plain-text template field, and a local test confirmed GoTrue sends a single `text/html` part even over custom SMTP. The `.txt` files are the reference copy; the HTML is built to stay readable in text-only and image-blocking clients (live-text brand, a visible link, no CSS-only content).

**Paste them in the dashboard:** **Authentication → Emails → Templates** → for each template, set the subject from the table and paste the whole `.html` file into *Message body (HTML)*. For the security notifications, also switch each one on under **Authentication → Emails → Security notifications** (optional).

**Or upload them with the script** (6.4): `--templates` (and `--notifications` for the security emails).

> Changing the production domain? Default templates follow `{{ .SiteURL }}`; stage and verify the Site URL change first. Only intentionally pinned templates need rebuilding and uploading. Keep the legacy deployment available for existing links.

### 6.3 Mailjet custom SMTP — separate from Vercel

**[MAILJET-SMTP.md](MAILJET-SMTP.md) is the current setup/acceptance guide.** No live credentials, Mailjet settings, DNS or email delivery were verified/changed in this delivery.

1. Create/access your Mailjet account; obtain its **API key and Secret Key** from **SMTP and SEND API settings**. Verify the chosen sender address/domain, apply the exact SPF/DKIM DNS records Mailjet supplies where applicable, and review activation/plan/sending limits. Do not invent a sender identity, DNS records or verification status.
2. In the **existing Supabase project used by this app** → **Authentication → Emails → SMTP Settings**, enable custom SMTP: host **`in-v3.mailjet.com`**, port **`587`** (STARTTLS), username **Mailjet API key**, password **Mailjet Secret Key**, sender email **your verified sender**, sender name **SiteInsights**. Alternative: port 465 / implicit TLS if needed. Preserve confirmation, secure-email-change, providers, notification flags, CAPTCHA, limits and minimum intervals.
3. The operator tools use the unchanged private names: `SMTP_HOST=in-v3.mailjet.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=`, `SMTP_PASS=`, `EMAIL_FROM=`. API credentials are not mailboxes: the verified sender is independent of SMTP_USER. **Vercel variables do not update Supabase.** The app has no independent SMTP sender; do not create unused Vercel SMTP variables for hosted Auth. No PAT belongs in Vercel.
4. Existing templates, signed links, recipients and secure-email-change behavior remain Supabase-owned. SMTP-only setup changes none of them, no URLs and no database credentials. Upload reviewed templates separately if needed (6.2).
5. Later perform the controlled receipt/link/no-duplicate tests in `MAILJET-SMTP.md`. A connection check is not sender verification or Supabase delivery proof; SMTP acceptance is not inbox proof. No message is sent by deployment, validation or automated tests.

Keep the currently working deployment, Site URL, callback allowlist and database connection values unchanged. Intended-domain cutover is separate and not verified by an SMTP source update.

### 6.4 Configuration script reference

`scripts/supabase/configure-auth.mjs` explicitly uses the Supabase Management API (`PATCH /v1/projects/{ref}/config/auth`), changing the same settings as the dashboard. It never runs at startup/build or through a public endpoint.

- **Requirements:** private operator `SUPABASE_ACCESS_TOKEN` (personal access token) and existing `SUPABASE_PROJECT_REF` (or public project URL). Never commit the PAT or add it to Vercel. SMTP-only additionally reads the validated Mailjet settings above.
- **Dry run by default:** `node --env-file=.env.auth-setup.local scripts/supabase/configure-auth.mjs --smtp` reads settings and prints a redacted plan, with no write/email. Add `--apply` only after operator review. Read-back checks non-secret fields, not SMTP credentials or delivery.
- **Safety:** invalid SMTP is rejected before network access, each request has a 15-second deadline, HTTP redirects are rejected, provider errors are sanitized, username/password/sender are hidden, and an uncertain PATCH is never automatically repeated.
- **SMTP-only:** patches exactly six `smtp_*` fields, requires no `--app-url`, and preserves Site URL, redirect allowlist, providers, CAPTCHA, confirmation, secure email change, notification flags and rate limits.
- **URL handling:** only explicit `--urls` changes URLs; it requires a verified public HTTPS origin and merges redirects without removing old entries. Do not pass `--urls` merely to switch SMTP.
- **Templates:** default `{{ .SiteURL }}` templates can be uploaded without forcing a new app URL. Intentionally pinned templates must match the supplied verified origin.
- **Flags:** `--urls`, `--templates`, `--notifications`, `--smtp`, `--app-url`, `--preview-pattern`, `--no-localhost`, `--apply`, `--help`. Notification activation is still opt-in.

## 7. Google sign-in (optional)
1. Google Cloud Console → **APIs & Services → OAuth consent screen** (Google Auth Platform → *Branding / Audience / Data access*): app name "SiteInsights", support email, **Authorized domains**: domains you control and that Google requires for this deployment; do not assume you can verify `supabase.co`. Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (non-sensitive, so no verification is needed). While the app is in **Testing**, only the listed test users can sign in. Click **Publish app** for everyone.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID** → *Web application*:
   - Authorized JavaScript origins: `https://<your-domain>`
   - Authorized redirect URIs: `https://<ref>.supabase.co/auth/v1/callback` (exactly this; **not** your app URL)
3. Supabase → **Authentication → Sign In / Providers → Google** → enable it and paste the **Client ID** and **Client secret**.
4. Supabase → **Authentication → URL Configuration**: Site URL `https://<your-domain>`, and Redirect URLs including `https://<your-domain>/auth/callback` (step 5). Without it, Supabase sends users to the Site URL instead of back to the app.

## 8. GitHub sign-in (optional)
1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - Homepage URL: `https://<your-domain>`
   - Authorization callback URL: `https://<ref>.supabase.co/auth/v1/callback`
2. Generate a client secret. In Supabase → **Authentication → Sign In / Providers → GitHub**, enable it and paste the Client ID and secret.
3. One OAuth App has exactly one callback URL. Use a separate OAuth App for a staging Supabase project.

**Flow:** button → `POST /api/auth/oauth` (PKCE verifier plus a signed, short-lived provider marker in HttpOnly cookies) → Supabase `/auth/v1/authorize` → Google/GitHub → Supabase `/auth/v1/callback` → app `/auth/callback` (code exchange, session cookies, profile name sync, and provider/session binding) → the requested same-site path (`next`). New users get an account; returning users get the same account. A Google sign-in with the verified email of an existing GitHub user may be linked to that account by Supabase. The shared avatar uses a trusted GitHub image only when the callback can bind GitHub provenance to the validated session; other providers use initials. Avatar URLs are not saved from the client into the profile row. Cancelling at the provider returns to `/sign-in` with "Sign-in was cancelled." and the destination kept for a retry. The provider-avatar change's local verification results and the unrun live-OAuth checks are recorded in `docs/RELEASE-VERIFICATION.md`.

**Buttons appear automatically.** The app reads the project's public Auth settings (`/auth/v1/settings`) and only shows Google, GitHub or SSO buttons for methods that are actually enabled. There are no app environment variables for providers.

**Connecting providers to an existing account** (Account → Connected accounts) requires **Authentication → Sign In / Providers → Enable Manual Linking**. Without it, the page explains that linking isn't enabled. The app refuses to unlink a user's last remaining sign-in method.

## 9. SAML single sign-on (optional, Supabase Pro plan or above)
SAML is configured per customer domain with the Supabase CLI (≥ 1.46.4). It has **not** been tested end-to-end with a real identity provider as part of this delivery; test it with your IdP before announcing it.
1. Supabase → **Authentication → Sign In / Providers → SAML 2.0** → enable it.
2. Give your identity provider (Okta, Microsoft Entra ID, Google Workspace, …) these values:
   - Entity ID / metadata URL: `https://<ref>.supabase.co/auth/v1/sso/saml/metadata`
   - ACS (reply) URL: `https://<ref>.supabase.co/auth/v1/sso/saml/acs`
   - Name ID format: email address; include an `email` attribute.
3. Register the provider:
   ```bash
   npx supabase login
   npx supabase sso add --type saml --project-ref <ref> \
     --metadata-url "https://<idp>/app/<id>/sso/saml/metadata" \
     --domains customer.com
   npx supabase sso list --project-ref <ref>
   ```
4. Users sign in at **`/sign-in/sso`** by entering their work email. The domain selects the provider, and unknown domains get "Single sign-on isn't set up for this email domain". The SSO entry is shown only when SAML is enabled on the project. SSO users can't change their password or email in SiteInsights (their IdP manages that), and Supabase doesn't link SSO identities to other accounts.

## 10. Row Level Security: what it protects
The app's server performs every read and write and checks ownership on every route (read, rename, delete, rerun, compare, export/PDF, AI). RLS is a **second layer** for anyone calling Supabase's REST API directly with the public key:

| Table group | `authenticated` (a signed-in user's own JWT) | `anon` (public key, no session) |
|---|---|---|
| `audits` and all result tables (`audit_pages`, `audit_issues`, `audit_links`, `audit_metrics`, `audit_history`, `audit_artifacts`, `ai_recommendations`) | **SELECT only**: own audits, plus audits shared with an organization the user belongs to | nothing |
| `usage_records`, `subscriptions` | SELECT own rows only | nothing |
| `profiles` | SELECT own row; the existing column grant allows UPDATE of `display_name`/legacy `avatar_url` on the user's own row | nothing |
| `user_settings` | SELECT/INSERT/UPDATE own row only | nothing |
| `organizations`, `organization_members` | SELECT where the user is a member | nothing |
| `plans` | SELECT public plans | SELECT public plans |

The legacy `profiles.avatar_url` column and its existing own-row database grant are retained for compatibility, but the application no longer reads that value for display and its profile API accepts no avatar URL. Arbitrary client-supplied URLs therefore cannot control the avatar shown by SiteInsights. No production privilege change or migration is performed by this source update.

Nobody can write audits, results, usage, memberships or subscriptions through the API. Those writes happen only on the server, through the database connection string. The secret key bypasses RLS by design and is used in exactly one place: deleting the signed-in user's own Auth account after a typed-email confirmation. No browser-readable column holds keys, tokens or passwords. Internal columns (`audits.ip_hash`, `access_key_hash`, `idempotency_key`, `lease_until`, `state`, `usage_records.ip_hash`) aren't readable through the API at all, not even by the owner or organization members. `anon` can execute no app function; `authenticated` can execute only the two RLS helper functions; nobody can use the app's sequences. `tests/rls.integration.test.ts` checks all of this with effective privileges, against a database set up with Supabase's default grants. Passwords are handled only by Supabase Auth; the app never stores them.

Check it on your project in **SQL Editor** (expected result: one row, `plans | SELECT`):
```sql
select table_name, privilege_type from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public' order by 1, 2;
```

Owner and plan are never taken from the client. The owner comes from the server-validated session (`getClaims()` verifies the JWT), and the plan comes from the `subscriptions` table, falling back to the free plan.

### 10.1 Provider avatars

Supabase remains responsible for Auth and PostgreSQL. The shared account menu, dashboard header, and profile settings all use the same avatar returned from the server-validated session. The OAuth start route signs the selected provider in a short-lived marker; the callback requires the matching HttpOnly cookie, corroboration from Supabase Auth's server-returned identity data, and a second signed marker bound to the verified JWT `session_id`. Only a GitHub OAuth session may supply an avatar, and the avatar is taken from that GitHub identity's server-returned `identity_data.avatar_url`, restricted to HTTPS `avatars.githubusercontent.com` user-avatar paths. The HMAC markers require `SESSION_SECRET` with at least 32 bytes; if it is unset/weak, provider identity is ambiguous, or GitHub has no usable image data, the app uses initials. Google `picture` values, email/password, SSO and other providers use initials; image-load failure also falls back to initials. The application never constructs an image URL from a username, fetches an image based on email, or accepts a client-provided `avatarUrl` in the profile API.

The legacy `profiles.avatar_url` column and any existing values remain untouched, but profile sync no longer writes it and account/session APIs ignore it for display. The old `db/migrations/007_avatar_storage.sql` is preserved as `db/optional/007_avatar_storage.sql` and is excluded from automatic migrations pending compatibility review. Do not apply it as part of this change. No production database, Auth setting, B2 bucket, key, or object was changed or cleaned up. Any later remote-resource retirement requires a separate review for other consumers.

## 11. Vercel environment variables
Vercel → Project → **Settings → Environment Variables** (Production, and Preview if you use it):

| Variable | Required | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes, for accounts | `https://<ref>.supabase.co` (set by the integration) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes, for accounts | `sb_publishable_…` (set by the integration) |
| `SUPABASE_SECRET_KEY` | for account deletion | `sb_secret_…` (set by the integration). Without it, "Delete account" explains that it's unavailable. |
| `DATABASE_URL` **or** `POSTGRES_URL` | **yes** | pooled URL (`POSTGRES_URL` is set by the integration; `DATABASE_URL` wins if both are set) |
| `NEXT_PUBLIC_APP_URL` | yes | `https://<your-domain>` (used for auth email links and metadata) |
| `SESSION_SECRET` | yes | `openssl rand -hex 32` |
| `CRON_SECRET` | recommended | `openssl rand -hex 32` (≥ 16 characters). Enables full background processing on Vercel (step 12). |
| `ANONYMOUS_AUDITS_ENABLED` | no | Deprecated; ignored. **Every audit requires verified sign-in**, regardless of this value. |
| AI: none (strict BYOK, users bring their own keys). Optional tuning: `OPENROUTER_MODEL`, `GEMINI_MODEL`, `AI_*` budgets | no | remove legacy `OPENROUTER_API_KEY`/`GEMINI_API_KEY`/`AI_PROVIDER`/`AI_FALLBACK_ENABLED`; server-side only |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | SMTP setup only | Operator tools only; not required Vercel runtime variables for hosted Auth. Configure Mailjet in Supabase separately; see `MAILJET-SMTP.md`. |
| Worker / PageSpeed / limits | no | see `docs/ENVIRONMENT.md` |

CLI alternative: `vercel env add NEXT_PUBLIC_APP_URL production` (repeat per variable). Never commit a `.env` file with real values; `config/environment.example.txt` contains placeholders only.

## 12. Background processing on Vercel
Audits are saved **before** any work starts, and they finish **without the browser tab staying open**:
1. The request that starts an audit responds immediately, then keeps working after the response (`after()`) for up to `BACKGROUND_BUDGET_MS` (default 50 s).
2. If the audit isn't finished, it hands off to `/api/internal/process` (authorized with `CRON_SECRET`), which continues in a fresh function invocation, repeatedly, until the audit completes.
3. **Safety net:** `vercel.json` schedules `/api/internal/process` **once a day** (`17 3 * * *`). Vercel Hobby only allows daily cron jobs, and a more frequent schedule makes the whole deployment fail. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically. For a per-minute sweep on any plan, run `db/optional/pg_cron_worker.sql` in Supabase (it uses `pg_cron` + `pg_net` and stores the secret in Supabase Vault). On Vercel Pro you can instead change the schedule in `vercel.json` to `* * * * *`.

| `/api/system/status` → `background` | Meaning |
|---|---|
| `full` | `CRON_SECRET` is set (or the app runs on a long-lived server): audits finish on their own |
| `limited` | serverless without `CRON_SECRET`: the first ~50 s (`BACKGROUND_BUDGET_MS`) run in the background, then the audit continues only while its page is open (the sweep endpoint is disabled without `CRON_SECRET`). The progress page says so. |
| `off` | `BACKGROUND_PROCESSING=false`: audits advance only while their page is open |

If Vercel Deployment Protection is on for production, set `VERCEL_AUTOMATION_BYPASS_SECRET` (Vercel → Settings → Deployment Protection → *Protection Bypass for Automation*) so the hand-off request isn't blocked.

## 13. Deploy / redeploy
Vercel applies environment variable changes **only to new deployments**. After adding or changing variables: **Deployments → ⋯ → Redeploy** (or push a commit, or run `vercel --prod`).

## 14. Verify
1. `https://<your-domain>/api/system/status` should show:
   - `storage.mode: "postgres"`, `persistent: true`, `ready: true` (if `unconfigured`, no database URL is set; if `ready: false`, check the URL and password);
   - `accounts: true` (if `false`, the Supabase URL or publishable key is missing);
   - `background: "full"` (if `limited`, set `CRON_SECRET`);
   - `configWarnings: []` and `configIssues: []`. The response never contains secrets.
   - `storage.problem: null`. Otherwise it names the problem, e.g. `database_schema_missing` or `supabase_project_mismatch`.
1b. **Full diagnostics** (requires `CRON_SECRET`): `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/system/diagnostics`. This runs live checks for the database, migrations, Auth, Google/GitHub enabled, **Auth ↔ database same project** (proved with a real user id, nothing written), the browser worker, PageSpeed and AI. Only variable names and `set`/`unset` are returned, never values.
2. `https://<your-domain>/api/auth/providers` lists the sign-in methods enabled in Supabase.
3. Open `/dashboard` while signed out: you're redirected to `/sign-in?next=/dashboard`.
4. **Sign up** with an address outside your Supabase team, then confirm via the email (this proves custom SMTP works). You land on the dashboard.
5. **Run an audit**, close the tab, wait a minute, reopen `/dashboard`: it has finished in the background.
6. Refresh, **sign out, sign in again**, and reopen the same audit: it loads. There is no "Scan not found".
7. In a private window, sign up as a second user and paste the first user's audit URL: you get **"Audit not found"** (404), and the second user's dashboard shows 0 audits.
8. **Forgot password** → email link → set a new password → sign in with it.
9. Try Google/GitHub buttons if enabled, plus Account → Connected accounts.
10. Account → Delete account (type the email) → the user disappears from Supabase → **Authentication → Users**.
11. Test provider avatars with disposable accounts: a GitHub OAuth session may show the GitHub user avatar; Google, email/password, SSO and other non-GitHub sessions must show initials. Confirm the profile page and shared navigation/account menu match, and that a missing/broken image falls back to initials. No avatar upload/storage configuration is required.

Optional automated check against your deployment (uses a real inbox only for local Supabase; see `docs/TESTING.md`):
`BASE_URL=https://<your-domain> … node scripts/smoke/auth-e2e.mjs`.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Banner "no database configured" / `503 storage_not_configured` | Neither `DATABASE_URL` nor `POSTGRES_URL` is set for this environment. Connect the integration or set `DATABASE_URL`, then redeploy. |
| "Something went wrong on our side" (before 0.3.2) on **Start audit**, sign-in or the dashboard | A database problem that older versions didn't recognise. Update, then read `/api/system/status` → `storage.problem` and `configIssues`, or `/api/system/diagnostics`. Every problem below now has its own message. Real bugs show a reference (`Reference: 1a2b3c4d`) that matches the server log line. |
| `503 supabase_project_mismatch` — "Sign-in and audit storage are connected to different Supabase projects" | `DATABASE_URL`/`POSTGRES_URL` and `NEXT_PUBLIC_SUPABASE_URL` belong to different projects. `configIssues` names the variable. Usually you remove the hand-made `DATABASE_URL`, or replace it with the transaction pooler URL of the project in `NEXT_PUBLIC_SUPABASE_URL`, then redeploy. |
| `503 database_schema_missing` / `database_schema_outdated` | The migrations didn't run in **this** database (e.g. `DB_AUTO_MIGRATE=false` and the SQL was pasted into another project). Run step 4 against the same project, or remove `DB_AUTO_MIGRATE=false`. |
| `503 database_migration_failed` | Automatic migration failed; the server log names the migration. Run `npm run db:migrate` with the session connection to see the full error. |
| `503 database_permission_denied` | The URL uses a restricted role. Use the `postgres` connection string from **Connect** (pooler user `postgres.<ref>`). |
| Profile avatar shows initials | This is expected for email/password, Google, SSO and other non-GitHub sessions. A GitHub image appears only when the current validated OAuth session supplies a trusted GitHub avatar URL; missing data or a failed image falls back to initials. The app intentionally ignores legacy `profiles.avatar_url` values and does not accept avatar URLs from the profile API. |
| `503 database_misconfigured` | Wrong password, database name or pooler user (`Tenant or user not found`). Copy the URL again from **Connect → Transaction pooler**. |
| `503 database_busy` | Connection limit reached. On Vercel use the transaction pooler (6543), not the session pooler (5432). |
| `503 database_unavailable` | Host unreachable. Use the **transaction pooler** URL (port 6543) on Vercel; the direct `db.<ref>.supabase.co` host is IPv6-only and unreachable from Vercel. |
| No confirmation email arrives / "We can't send email to this address" | The built-in sender only mails your team and allows about 2/hour. Configure custom SMTP (step 6). |
| Email link opens `localhost:3000` / `127.0.0.1` | Supabase **Site URL** is still `http://localhost:3000` (step 5). Set it to `https://siteinsight.xyz`, add `https://siteinsight.xyz/**` to Redirect URLs, and use the branded templates (they follow the configured Supabase Site URL). Check `/api/system/status` → `configIssues` for a localhost `NEXT_PUBLIC_APP_URL`. Links in emails sent before the fix stay wrong; request a new one. |
| Email link goes to the home page instead of the app | The redirect URL isn't allowed: add `https://siteinsight.xyz/**` under Redirect URLs, and set the Site URL. Since 0.4.0, a link error Supabase reports on the home page (`#error_code=otp_expired`) is forwarded to the sign-in page with a clear message. |
| Every database route answers "Something went wrong on our side" right after deploy (0.3.x), status endpoint 500 | The database password in `DATABASE_URL`/`POSTGRES_URL` contains a `%` that isn't URL-encoded (e.g. `Summer50%off`). The Postgres driver can't decode it. 0.4.0 encodes it automatically and reports it in `configIssues`; you can also replace `%` with `%25` in the variable. |
| "This link is invalid or has expired" | The link was already used or is older than the OTP expiry. Request a new one. With default templates, open the link in the same browser. |
| Google/GitHub button missing | The provider isn't enabled in **the project `NEXT_PUBLIC_SUPABASE_URL` points to** (buttons follow that project's settings), or the settings endpoint was unreachable (wrong URL/key). `/api/system/diagnostics` → `oauth_google` / `oauth_github` / `auth` tells you which. |
| `redirect_uri_mismatch` from Google | The Google client's redirect URI must be `https://<ref>.supabase.co/auth/v1/callback`, not your app URL. |
| Connect provider says linking isn't enabled | Turn on **Enable Manual Linking** (step 8). |
| Audits stay "running" after the tab closes | `background` is `limited`: set `CRON_SECRET` and redeploy. With Deployment Protection, also set `VERCEL_AUTOMATION_BYPASS_SECRET`. |
| Deployment fails with "Hobby accounts are limited to daily cron jobs" | Keep `vercel.json`'s cron daily. Use `db/optional/pg_cron_worker.sql` for a per-minute sweep. |
