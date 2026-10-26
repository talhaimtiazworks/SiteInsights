# SiteInsights project guidance

SiteInsights is **AI-Powered Website Auditing**, **A TalhaImtiazWorks Product**. It is a product, not a separate company. Tagline: **Find website issues. Understand them. Fix them.** Keep product identity primary and the parent wordmark secondary.

- Work in the existing Next.js 16 / React 19 / TypeScript application. Do not replace the scanner, accounts, database or provider adapters with mocks.
- Use Node.js 22+ and npm lockfiles. Run `npm ci`, `npm run verify`; worker checks: `(cd worker && npm ci && npm run typecheck)`.
- Central web identity: `src/lib/brand.ts`; official-image components: `src/components/brand.tsx`, `scripts/brand/generate.py`; canonical palette: `src/lib/design-tokens.json`; generated email source: `scripts/email/build-templates.mjs`.
- Intended production origin: `https://siteinsight.xyz`. It is **not** confirmed live by the source package. Follow `docs/REBRAND.md`, preserve the existing deployment and do not force domain redirects before testing.
- Preserve database/RLS names, `SiteLensAI` robots token, session/storage keys, internal safety headers and historical migrations. See the documented compatibility exceptions before renaming technical identifiers.
- Never rotate secrets, reset a database, run destructive integration tests on production, or apply cloud configuration merely for a cosmetic change. External setup requires an explicit operator action.
- Generate branded emails with `--app-url '{{ .SiteURL }}'` to preserve the configured origin, or pin an already-verified origin intentionally. Update HTML, plain text and subjects together; include supplied parent attribution, not invented company/contact details.
- Completed assets are distributed; asset generation is optional and documented in `public/brand/README.md`. Do not require Python or Chromium to build the Next.js app.
- `npm run release:zip` creates the source ZIP without dependencies, build output, Git internals or credential files. Recheck `docs/RELEASE-VERIFICATION.md` after changes and never describe skipped/unexecuted external checks as passed.

- Mailjet SMTP: hosted Supabase Auth owns authentication delivery. Do not replace it with a second Next.js sender or expose setup/send endpoints. `scripts/email/*` are Node/operator-only; `email:check` is offline by default. Never run `--verify`, `--send-test` or `configure-auth --apply` without explicit operator authorization. No real email in automated tests.
- Mailjet uses an API key as SMTP_USER, its Secret Key as SMTP_PASS and an independent verified EMAIL_FROM. Preserve key bytes; never normalize whitespace or use API keys as recipients. Credentials stay private. The six SMTP variables are operator-tool inputs, not new Vercel runtime requirements; do not tell users to create unused vars. Configure hosted Supabase separately; follow `docs/MAILJET-SMTP.md`.

- Never re-enable anonymous audits: `getAuditContext` and `assertAuditAccount` must precede any scan parsing/execution. The deprecated anonymous flag cannot override account-only policy. Preserve the trusted cron/worker protocol, but execute only account-owned jobs. Legacy report keys are not authority.
- Use the supplied `public/brand/talhaimtiazworks-logo.png` unchanged (fingerprint in `official-logo.json`), full-canvas derivatives and the central palette. No generated, recolored, cropped or text-only substitute.
- Release archives exclude ALL `.env*` files, including examples. Ship the blank `config/environment.example.txt` instead.
