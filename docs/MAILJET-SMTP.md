# Mailjet SMTP — SiteInsights

**AI-Powered Website Auditing · A TalhaImtiazWorks Product**

**Status:** source implementation is Mailjet-compatible and ready for private setup. No credentials were requested/supplied, no live SMTP handshake or message was attempted, and no Mailjet/Supabase/Vercel/DNS settings or user data were changed. **Actual Mailjet inbox delivery remains unverified.**

## 1. Architecture and where configuration is actually consumed

The existing Next.js 16 / React 19 / TypeScript app still uses **Supabase Auth and PostgreSQL**. Nodemailer 10.1.4 remains pinned; no Mailjet REST SDK, second authentication sender, public SMTP endpoint or background mail queue was added.

| Location | What it actually does / required settings |
|---|---|
| **Supabase Auth custom SMTP** | Sends verification, resend, recovery, email-change, magic-link, invitation, reauthentication and enabled security emails. Configure Mailjet here separately; this is the essential mail configuration for hosted Auth. |
| **Operator Node scripts** | `scripts/email/check-smtp.mjs` and `scripts/supabase/configure-auth.mjs` explicitly read the existing six `SMTP_*` / `EMAIL_FROM` variables. Offline validation is the diagnostic default. The optional setup command uses the Management API, not an email sender. |
| **Vercel web application** | Existing auth routes call Supabase, not Nodemailer. No current Vercel runtime route/build/startup hook sends mail or copies SMTP values to Supabase. **Do not create unused SMTP variables in Vercel just to enable Auth.** The server logger can redact privately supplied SMTP values; that is not a sender or a mail configuration requirement. |
| **Database** | `DATABASE_URL` / `POSTGRES_URL` and existing migration/connection settings remain unchanged. They are not Mailjet SMTP credentials. |

The same Supabase SDK calls, recipient policy (including secure email change), token generation, click-to-confirm routes, callback paths and all 10 branded template pairs/subjects are retained. Optional notifications keep their existing enable flags. The app's compatible request acknowledgements remain generic to prevent account enumeration; they are not delivery receipts.

## 2. Mailjet account, keys and sender/domain approval

Perform these later, privately, using an account/domain you control:

1. Create or access your **Mailjet account** and complete its account/email activation requirements.
2. Open **Account settings → SMTP and SEND API settings** / **API Key Management**. Use the **API key as SMTP username** and the paired **Secret Key as SMTP password**. Do not use the Mailjet account login email/password, an old provider password, a Supabase key or a database password. Store both values securely; the Secret Key may be shown only at creation. Do not rotate a key used by other clients merely to follow this guide.
3. Open **Senders & Domains** and add/verify the exact sender address, or verify a sending domain you own using Mailjet's current instructions. Sender approval must apply to the account/API key or subaccount you actually use. **You choose `EMAIL_FROM`; no sender address or `@siteinsight.xyz` mailbox is assumed to exist.**
4. For your sending domain, open Mailjet's **SPF/DKIM authentication** setup. Copy the **exact record type, name/host and value/target provided for that domain** to its DNS provider, then check Mailjet's status after propagation. No DNS record values are supplied by this project. Preserve existing mail authorization; have the domain administrator merge/update an existing SPF record rather than blindly creating conflicting records. Review the domain's existing DMARC policy as applicable.
5. Check account/plan/subaccount sending limits, recipient restrictions, anti-abuse review/activation requirements and sending status before production use. Also preserve Supabase's independent rate limits, CAPTCHA and minimum send interval. Do not disable protections to force a test through.
6. Review any Mailjet tracking settings for authentication mail: token links must not be unintentionally rewritten or exposed. Test the real link flow later. The adapter adds no tracking headers or provider-side template overrides.

Configuration syntax cannot prove a key's validity, sender/domain approval, DNS authentication, account activation or inbox placement. These remain live operator acceptance checks, not claims made by the offline diagnostic.

## 3. Existing six variables — names unchanged

For the **explicit operator scripts**, use a private ignored file such as `.env.smtp.local`, not source, screenshots or command-line values. The distributed `config/environment.example.txt` has defaults plus **empty placeholders**:

```dotenv
SMTP_HOST=in-v3.mailjet.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=
```

| Variable | Meaning / validation |
|---|---|
| `SMTP_HOST` | Only `in-v3.mailjet.com`; arbitrary hosts/URLs and old provider hosts are rejected before network access. |
| `SMTP_PORT` / `SMTP_SECURE` | Preferred **587 / `false`**, with **mandatory STARTTLS**. Alternative **465 / `true`**, with implicit TLS. No mismatched pairing, other port or TLS-off fallback. |
| `SMTP_USER` | The Mailjet **API key**, not an email address. Treated as private even if the provider calls it a public key. |
| `SMTP_PASS` | The paired Mailjet **Secret Key**. No account password or whitespace normalization. |
| `EMAIL_FROM` | One bare **Mailjet-verified sender** address, independent of the API key. No display-name syntax, address list or header characters. Sender display name stays **SiteInsights**. |

The local key-safety policy accepts **16–256 printable ASCII characters without whitespace/control characters**; it deliberately does not impose a fixed hex length. Issued credential bytes/case are preserved exactly. A valid-looking value is not proof it was issued by Mailjet. Sender syntax is checked offline; Mailjet must enforce sender/domain authorization. `EMAIL_FROM` must **not** equal an API key.

For port 587 the Node transport uses `secure=false`, **`requireTLS=true`**, `ignoreTLS=false` and `opportunisticTLS=false`: false does **not** mean unencrypted delivery. Both ports enforce certificate validation, TLS 1.2 minimum and the expected server name. Do not set a certificate-bypass option or public SMTP variable.

Never use `NEXT_PUBLIC_SMTP_*`, `NEXT_PUBLIC_MAILJET_*`, `NEXT_PUBLIC_MJ_APIKEY_*` or `NEXT_PUBLIC_EMAIL_FROM`. The extra names are rejected as public aliases, **not supported server-side configuration alternatives**. Keep the established six names; do not create unused Mailjet-specific aliases. Do not put secrets in `next.config.ts`'s `env`, API responses, browser bundles, logs or email content.

## 4. Configure Mailjet in the correct Supabase project

Identify the project already used by the deployed app's `NEXT_PUBLIC_SUPABASE_URL`; verify the matching project in the dashboard. **Do not create a new project or change database connection strings.**

Open that project's **Authentication → Email / Emails → SMTP Settings (Custom SMTP)**; dashboard labels can vary. Enable custom SMTP and privately set:

| Supabase field | Value |
|---|---|
| SMTP host | `in-v3.mailjet.com` |
| SMTP port | **`587`** (STARTTLS); alternative `465` for implicit TLS if needed |
| SMTP username | Your Mailjet **API key** (`SMTP_USER` in operator scripts) |
| SMTP password | Your Mailjet **Secret Key** (`SMTP_PASS`) |
| Sender email | **Your chosen Mailjet-verified address** (`EMAIL_FROM`) |
| Sender name | **`SiteInsights`** |

Save only when sender/domain/account setup is ready. Preserve email confirmation, secure email change, notification flags, CAPTCHA, providers, rate limits, Site URL and redirect allowlist. Supabase owns its own connections/TLS behavior/timeouts; the Node diagnostic's options do not configure hosted Auth. Supabase has no documented `smtp_secure` Management API field, so the helper validates the supported port/pair locally and patches only the documented SMTP fields.

**Setting SMTP variables in Vercel does not perform this step.** Conversely, missing Vercel SMTP values do not disable independently configured Supabase mail. Deploying the replacement source does not automatically switch your existing live provider: hosted Auth keeps its existing settings until an authorized operator changes them.

### Optional explicit Management API setup (instead of dashboard)

The existing setup script consumes the six variables above plus private operator `SUPABASE_ACCESS_TOKEN` and the **existing** `SUPABASE_PROJECT_REF` (or derives the ref from the existing public project URL). The token is a personal Management API token, **not** a database password, publishable key, service key or Mailjet key. It is not a Vercel runtime requirement; never add it there.

```bash
# With a private .env.auth-setup.local filled by the operator:
# Redacted DRY RUN: reads Supabase settings; no write or email.
node --env-file=.env.auth-setup.local scripts/supabase/configure-auth.mjs --smtp

# LATER ONLY, after explicit authorization/review: saves exactly six SMTP fields.
node --env-file=.env.auth-setup.local scripts/supabase/configure-auth.mjs --smtp --apply
```

The script was tested only against injected/loopback stubs in this delivery. SMTP-only requires no `--app-url` and changes only `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_admin_email`, `smtp_sender_name`. It validates before requests, rejects production API-host overrides/redirects, bounds each request to 15 seconds, hides credentials/sender/template bodies and never automatically retries a PATCH. A timed-out update may already have applied: inspect the dashboard before another manual attempt. Non-secret read-back is not authentication/delivery proof.

## 5. Vercel deployment — no unused variables or database changes

1. Deploy this complete project to the **existing** Vercel project using the established build command and Node 22+. Leave Supabase URL/publishable key, server secret key, database URLs, OAuth/SSO, session, cron, application URL and current callbacks unchanged. No new migration or data reset is required.
2. **Hosted Auth only:** configure section 4 in Supabase. **No new SMTP variables need to be added in Vercel** for the current web application. If the old Gmail SMTP variables were stored there solely for Auth, they were not what configured hosted Auth; remove unused copies only after checking that your private operator workflow does not depend on them. Do not disable the still-working Supabase provider before Mailjet is ready.
3. **Only if you actually use Vercel as private environment storage for these operator scripts:** under **Project → Settings → Environment Variables**, update the existing six server-only names to the Mailjet defaults/keys/verified sender above, for **Production**. Keep both keys private/Sensitive where available. Configure **Preview** separately only if an actual operator/test workflow needs it, preferably with a separate Mailjet test key/subaccount and Supabase test project. Do not create copies for environments that do not consume them; no Mailjet aliases or Management API PAT are required in Vercel.
4. Vercel environment changes affect new deployments only: **Deployments → intended deployment → ⋯ → Redeploy** or deploy a reviewed commit. This makes relevant server-side environment updates available; it still does **not** update Supabase SMTP or invoke a diagnostic. Operator scripts use whichever private environment you explicitly load when you run them.
5. Keep the currently verified production origin and callbacks. Do not assume `siteinsight.xyz` is live, force a redirect or remove the legacy deployment/allowlist as part of SMTP migration. Domain cutover remains separate in `REBRAND.md`.

Database settings (`DATABASE_URL`, `POSTGRES_URL`, existing migration URLs, `DATABASE_SSL`) are untouched. `SUPABASE_SECRET_KEY` / service role and public Auth keys retain their existing purposes; none is a Mailjet SMTP credential.

## 6. Safe operator diagnostic — offline by default

```bash
# OFFLINE: safe validation only. Blank/invalid values return nonzero; no connection/mail.
node --env-file=.env.smtp.local scripts/email/check-smtp.mjs --config-only
# Equivalent when the private environment is already loaded: npm run email:check
```

The commands below were **NOT executed against Mailjet** for this delivery. Use them only later when you explicitly authorize contact with your account and, for the second command, one email:

```bash
# LATER / EXPLICIT: checks connection + authentication; sends NO email.
node --env-file=.env.smtp.local scripts/email/check-smtp.mjs --verify

# LATER / EXPLICIT: sends ONE test only to EMAIL_FROM itself. No retries.
node --env-file=.env.smtp.local scripts/email/check-smtp.mjs --send-test
```

The API key is never a recipient. To use the self-test, `EMAIL_FROM` must be a verified sender mailbox **you control and can receive at**; if the production sender is non-receiving, do not run that self-test. Instead use the controlled Supabase acceptance flow below (or a private diagnostic configuration with another sender you own and have verified in the same Mailjet account). No extra recipient variable or public send/test API was introduced. There is no arbitrary recipient/body/file/URL option.

- `smtp_configuration_valid`: local format only; no key or sender approval verified.
- `smtp_connection_verified`: connection/authentication only; no mail, sender approval, Supabase sending or inbox proof.
- `smtp_message_accepted`: actual SMTP acceptance of the configured sender-recipient was reported; **not inbox delivery proof**. Check receipt/spam separately.
- Auth, DNS/connect, TLS/certificate, timeout and rejected-message paths return safe codes and nonzero exit. A post-DATA timeout/disconnection means **unknown**, not necessarily failed delivery: inspect the inbox/activity privately before another manual attempt. No automatic resend.

Existing 10s DNS/connection/greeting and 20s socket timeouts, no pooling, verified TLS and disabled debug/raw logging remain. Audit events contain controlled operation/outcome fields only, never provider response bodies, keys, recipients, auth links or sensitive message content. Known raw/encoded credentials and common Mailjet key labels are also redacted defensively by the server-only logger.

## 7. Pending controlled acceptance checklist

After private setup, on a controlled deployment with consent and accounts you own:

1. Confirm the correct Mailjet key/subaccount, sender/domain verification, SPF/DKIM status, account activation/limits and correct Supabase SMTP settings. Never publish keys, raw provider logs, auth tokens or complete email links as evidence.
2. If appropriate, authorize a local connection check and one sender-to-itself diagnostic. Record SMTP acceptance and separately observed inbox receipt; a local check cannot prove Supabase can send.
3. Sign up a controlled user through the app; receive exactly the expected Supabase confirmation email, check SiteInsights/parent branding, intended recipient and current working-domain link, and complete click-to-confirm/sign-in. Test expiry/reuse safely.
4. Test resend within existing limits, password reset/recovery/new-password sign-in, and secure email change with both owned addresses. Confirm no second application message appears. Check enabled security notifications and other invitation/magic-link/reauth flows you actually use.
5. Check private Mailjet activity and Supabase Auth logs for rejection/bounce/limits; do not equate an accepted message with inbox delivery. Verify safe `429`/`503` behavior in staging, not by disabling controls.
6. Inspect actual browser responses/bundles/console/logs for credentials; confirm account/database behavior, existing OAuth/SSO and callbacks remain intact. DNS/HTTPS/domain cutover are separate checks.

**Acceptance remains: Mailjet-compatible and ready for configuration; live Mailjet/Supabase delivery pending valid privately configured credentials, verified sender/domain/account and a controlled successful delivery test.** No live configuration or user data was changed here.

## References and reproducible verification

- [Mailjet standard SMTP configuration](https://dev.mailjet.com/docs/smtp-relay/configuration/)
- [Mailjet SMTP credentials/settings](https://documentation.mailjet.com/hc/en-us/articles/360043229473-How-can-I-configure-my-SMTP-parameters)
- [Mailjet account/sender/domain setup](https://documentation.mailjet.com/hc/en-us/articles/37251169295003--Quick-Start-with-Mailjet)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Nodemailer SMTP TLS/timeouts](https://nodemailer.com/smtp)

Executed results, changed files, archive checks and limitations: [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md). Reproducible mocked tests/canary build: [TESTING.md](TESTING.md). No automated test sends real mail.
