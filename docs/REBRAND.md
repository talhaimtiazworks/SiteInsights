# SiteInsights rebrand and safe domain transition

**Delivery date: 2026-10-18**

## Official identity

| Element | Exact identity |
|---|---|
| Product | **SiteInsights** |
| Category | **AI-Powered Website Auditing** |
| Parent brand / creator | **TalhaImtiazWorks** |
| Attribution | **A TalhaImtiazWorks Product** |
| Tagline | **Find website issues. Understand them. Fix them.** |
| Intended production origin | **https://siteinsight.xyz** — not confirmed live by this delivery |
| Footer | **© [current year] TalhaImtiazWorks. SiteInsights is a TalhaImtiazWorks product.** |

SiteInsights is a product, **not a separate company**. The supplied official logo is preserved byte-for-byte and used as a whole-canvas image; product and parent text remain accessible supporting labels. See `public/brand/official-logo.json` and `docs/REDESIGN.md`. Web footer copyright uses the current year; PDF copyright uses the report generation year. The generated email year is recorded in `supabase/templates/subjects.json` and can be refreshed annually with `--year`.

## Implemented scope

- Shared header/logo, footer, auth cards, account screens, audit UI, loading/error copy, help, contact and legal/product information pages.
- `/about` explains the product/parent relationship without fabricated business or contact details.
- The specified deep-maroon/cyan/yellow/amber/orange/navy/ivory/champagne design tokens replace the former theme in both modes. Favicon/social/compatibility SVG assets embed the supplied official artwork, never the retired generated mark.
- Page titles/descriptions, manifest, parent author/publisher metadata, WebApplication structured data, public-only sitemap and robots metadata.
- PDF cover/footer/metadata and download filename; JSON generator/parent attribution and filename. Findings, scoring and allowances are preserved; access is intentionally account-only, including direct initiation/execution/export calls.
- All ten Supabase HTML/plain-text template pairs and subjects. Templates preserve token-hash, email types, click-to-confirm behavior and relative post-auth destinations.
- OpenRouter's public `X-Title`, the AI assistant's product introduction, worker display copy, private npm package labels and documentation. Provider request structure and key handling are unchanged.
- Node 22+ requirement reflects the existing locked Supabase SDK, not a dependency upgrade. Existing dependencies are retained; `@pdf-lib/fontkit` is the one required runtime addition for embedded Unicode PDF fonts.
- Reduced-motion spinners/pulses are static; existing accessible busy text, retries and progress updates remain.

## Intentionally preserved old technical identifiers

Old display branding is removed from active UI/assets/templates. The following references are **not** product branding and must not be blindly renamed:

| Reference | Why it remains |
|---|---|
| `SiteLensAI`, `sitelensai` | Crawler User-Agent / robots.txt group and crawler-specific meta directives. Preserves existing site-owner exclusions; help explains the compatibility token. |
| `sl_pid`, `sitelens:scan-keys`, `sitelens-theme`, other `sl_*` client keys | Retains theme/preferences and legacy claim compatibility. Anonymous cookies and private keys no longer grant report access or audit execution. |
| `sitelens_private`, `sitelens_audit_history`, `sitelens_migrations` | Existing PostgreSQL schema/functions/advisory locks and RLS policies. Historical migration SQL and embedded copies are unchanged. |
| `sitelens_rules` | Existing persisted metric-source values and exported data compatibility. |
| `sitelens_cron_secret`, `sitelens-process` | Existing optional Vault/pg_cron secret and job names; no duplicate schedules or secret changes. |
| `__sitelens*`, `sitelens-ai-default-ip-salt` | Existing in-process state / fallback hashing identity. Explicit production `SESSION_SECRET` is still recommended; no salt rotation is introduced. |
| `x-sitelens-*`, `ESITELENS_UNSAFE` | Internal HTTP/egress safety signaling and error codes, including compatibility with an already-running worker. |
| `.sitelens-fixture.*`, `sitelens.localtest`, test-only database/shot paths | Local test fixtures shared by crawler, auth and worker suites; not public endpoints or credentials. |
| `https://sitelens-ai.vercel.app` and existing preview patterns | Legacy deployment / transition and compatibility regression cases. Keep these allowed while old links are in circulation. |
| Older changelog and migration headings | Historical record. The generated SQL bundle has a new product heading; migration statements and policies are not rewritten. |

`npm run brand:check` audits active display copy and assets, while the default tests verify compatible URL generation, shared branding and the retained crawler token. `docs/RELEASE-VERIFICATION.md` records the final search and executed checks.

## What was NOT changed externally

This is a source-package implementation. No Vercel project settings, DNS records, Supabase project/auth settings, database rows, provider apps, SMTP settings, secrets, or live deployments were changed. The existing deployment was not rebuilt, removed or redirected remotely. Domain ownership, DNS propagation, HTTPS issuance and live routing for `siteinsight.xyz` are **unverified**.

Do not claim a live cutover based on a local build or metadata test.

## Staged production checklist

### 1. Rebrand on the existing deployment first

1. Back up deployment settings and note the current working origin, Supabase Site URL, redirect allow-list and provider callbacks. Do not copy credentials into source or this document.
2. Deploy this code to the **existing** Vercel project using Node 22+, `npm ci`, `npm run build`. Keep the existing Production `NEXT_PUBLIC_APP_URL` and domain aliases until the new domain is ready. Leave Preview `NEXT_PUBLIC_APP_URL` unset unless it intentionally targets a verified preview origin.
3. Keep the same Supabase project, pooled database URL, service/publishable keys, `SESSION_SECRET`, `CRON_SECRET`, worker token and AI keys. No new schema migration or data reset is required by the rebrand. Existing migration behavior remains as before.
4. Check the current site's homepage, accounts, prior audits, PDF/JSON exports, sign-out and password reset before proceeding.

### 2. Configure the intended domain without cutting off the old one

1. In **the existing Vercel project's Settings → Domains**, add `siteinsight.xyz`.
2. Use **only the ownership and DNS values shown for that project by Vercel** at your DNS provider. This package deliberately does not invent A, AAAA, CNAME, TXT, MX, SPF or DKIM records. Resolve any conflicting records with your DNS/provider documentation.
3. Verify Vercel's domain status, HTTPS certificate and actual browser routing. Keep the existing `sitelens-ai.vercel.app` deployment/alias available. Do not enable a forced old-to-new redirect during transition.
4. In Supabase **Authentication → URL Configuration**, **append** `https://siteinsight.xyz/**` to Redirect URLs. Retain the legacy production origin, working preview patterns and intentional local-development entries. Leave the Site URL at the existing origin while preparing.
5. `configure-auth.mjs --urls` changes the Site URL as well as the allow-list. **Do not run it merely to append a preparatory URL**; use the dashboard until the cutover step.

### 3. Review OAuth and email identity

- **GitHub OAuth:** keep the existing client ID/secret and the same Supabase callback (`https://<your-project-ref>.supabase.co/auth/v1/callback`, or your already-configured custom Auth domain). The app's `/auth/callback` route has not changed. Update the provider app's display name/homepage to SiteInsights/new domain when appropriate; do not create a replacement OAuth app just for the rename. Check any provider domain restrictions and complete a real sign-in.
- **Google OAuth:** update branding and controlled authorized domains/origins as needed. Retain existing redirect URIs, including the current Supabase callback. Only add or verify domains you control; do not assume ownership of `supabase.co`. Test a real login after changes. Keep any existing SAML/SSO setup unchanged unless its own administrator requires an update.
- **Supabase emails:** upload the new HTML/subjects manually or with the existing opt-in script. The committed templates use `{{ .SiteURL }}`, so they follow the **currently configured** origin; validate it is not localhost. Updating templates does not resend or rewrite earlier emails.
- **SMTP sender identity:** the identity-only rebrand did not rotate working mail credentials or change the sending domain. The subsequent Mailjet SMTP update is documented separately in **[MAILJET-SMTP.md](MAILJET-SMTP.md)**: only an authorized operator applies the new Supabase Mailjet SMTP settings after private configuration. SiteInsights remains the sender display name; parent attribution stays in the email body. No `@siteinsight.xyz` mailbox or live delivery is assumed to exist.
- **Contact:** retain `NEXT_PUBLIC_CONTACT_EMAIL` if configured. No support email, address, phone number or endpoint has been fabricated.

### 4. Cut over only after verification

1. Set Production `NEXT_PUBLIC_APP_URL=https://siteinsight.xyz` and Supabase Site URL to the same verified origin. Preserve the old origin in Redirect URLs. Review Vercel's primary domain selection too, since the fallback system domain may change when adding aliases.
2. Rebuild/redeploy: canonical URLs, sitemap, social metadata and public configuration may be rendered at build time. The code never uses `BRAND.intendedOrigin` as an automatic runtime/auth fallback.
3. With committed dynamic email templates, future messages now follow the new Site URL. For explicitly pinned templates only, regenerate for the verified domain and upload them:
   ```bash
   node scripts/email/build-templates.mjs --app-url https://siteinsight.xyz --year 2026
   ```
   Do not overwrite your existing Supabase settings automatically. The configurator is dry-run by default and merges allow-list entries, but `--apply` is an intentional operator action; review the diff first.
4. Test sign-up → verification, forgot/reset password, sign-in/out, all enabled OAuth providers, dashboard history, private report access and report downloads on the new domain. Use separate email links for independent tests because tokens are one-time. Check the old domain still serves existing emailed links; do not remove it while they may be valid.
5. Check `/api/system/status` for database/account/background readiness and configuration warnings. Protected diagnostics require your existing `CRON_SECRET`; never publish their authorization header.
6. Verify canonical/OG URLs, `/sitemap.xml`, `/robots.txt`, manifest/icons and link previews against the real domain. Local tests validate code behavior, not DNS.

**Cookies and localStorage are origin-scoped.** Signing in again on the new domain may be necessary; the rebrand cannot transfer browser cookies between origins. Legacy anonymous records require explicit same-browser account claim; old private-link keys no longer grant access. Account-owned history remains in the unchanged database. Do not attempt to solve cross-origin browser state by weakening cookie, token or ownership protections.

### Rollback

Keep a known-good deployment available. If cutover tests fail, return Production `NEXT_PUBLIC_APP_URL` and Supabase Site URL to the previous working origin and redeploy. Keep both redirect allow-list entries, old provider callbacks and the same database/secrets. Dynamic templates follow the restored Site URL. No rollback migration is needed for this rebrand.
