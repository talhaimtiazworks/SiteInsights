# TalhaImtiazWorks redesign & mandatory authentication

**2026-10-18 · SiteInsights · implemented in the existing application**

This is not a rebuild. Next.js App Router, scanner phases/rules/scores, API names, PostgreSQL schema/migrations/RLS, Supabase providers, account features, durable limits, background leases, worker protocol, AI integrations and deployment model are retained. The intended production domain is not automatically forced or claimed live.

Actual verification results and explicit limitations are recorded in [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md). Historical rebrand/provider reports are not evidence for this release.

## 1. Authentication is mandatory, not a frontend suggestion

- `src/lib/auth/server.ts` and `page-guard.ts` use the real Supabase SDK's server-side `getClaims` verification, not a client user ID or `getSession` alone. Verified claims require an unexpired UUID account subject, `authenticated` role and a non-anonymous account.
- `getAuditContext` rejects missing, invalid, expired and Supabase-anonymous sessions **before** any audit identifier/query/body is processed. Start, list, read, advance, rerun, cancel, delete, title/share/status, findings/pages/links, AI, comparison, dashboard/history and PDF paths are protected.
- `assertAuditAccount` guards the initiation service itself before storage/DNS/metering/idempotency replay/enqueueing. Missing Auth configuration never opens an anonymous mode. `ANONYMOUS_AUDITS_ENABLED=true` is ignored; effective policy is always false.
- Owners may change their audits. Explicit verified organization members have read-only access. Other authenticated accounts receive 404; unauthenticated/invalid/expired callers receive 401.
- The existing internal processor retains trusted cron/service-bearer authentication; absent/wrong/unconfigured secrets are 401. The renderer retains its own bearer token and SSRF egress proxy. Background processing additionally skips jobs that are not account-owned. No public endpoint can create an anonymous job or turn a client-supplied user ID into ownership.
- Legacy keys, `#access` fragments and anonymous cookies are not authority. “Copy report URL” copies only an account-protected URL. Existing database fields/cookies are retained for compatibility and explicit same-browser, signed-in legacy claims; historical queued anonymous jobs cannot execute until account-owned.
- Server layouts guard audit, scan/report, settings, dashboard and account pages. Public information and authentication pages remain accessible.
- Same-origin mutation checks, HttpOnly/SameSite cookies, session refresh, rate/usage limits and owner checks remain in place.

## 2. Safe login return and session state

Sign-in/sign-up preserve a safe same-site destination. Returning to `/audit/new` shows an empty form; **no previous URL, queued request or pre-login submission is automatically executed**. The user explicitly submits a website after sign-in. Session verification is repeated immediately before submission. A versioned client session store drops stale privileges on refresh failure, invalidation and logout. API 401 responses clear cached client authority. Permanent auth errors stop scan retries immediately and present sign-in recovery.

Submission/rerun/PDF locks prevent reentrant actions; start/rerun idempotency remains server enforced. Fetches are time-bounded (normal API 45 s, legitimate advance up to 95 s, PDF 90 s). Logout retains bounded server revocation and full navigation, with a recoverable error when necessary.

## 3. The exact supplied official logo

`public/brand/talhaimtiazworks-logo.png` is the original **1141 × 1141 RGBA** supplied PNG. SHA-256:

`ad7e9c8c39e925449fff71b57e7efe89244a8a7ec9da20aa2aada1e24b5b8c50`

Its white circular field, navy/blue/teal artwork, transparent corners and 1:1 canvas are retained. It is never cropped, stretched, filtered, recolored or reconstructed. The original's colors are artwork, not leftover interface colors.

Full-canvas 160/320/640 derivatives support responsive rendering, header, Auth cards, loading feedback, footer, PDF and email. Favicon/social assets and legacy SVG aliases embed that same official image. There is no generated substitute mark. See [the asset guide](../public/brand/README.md) and `official-logo.json` for provenance. Asset generation is optional maintenance; normal builds need neither Python nor Chromium.

## 4. Central light/dark palette

`src/lib/design-tokens.json` is canonical for Tailwind/CSS, PDF and email. `scripts/brand/generate-tokens.mjs` emits `src/app/brand-tokens.css`; `--check` rejects drift. Named `--color-*` tokens expose both the requested colors and theme-aware surfaces/text/borders.

| Role | Exact base color |
|---|---|
| Primary/action/selected navigation | Deep Maroon `#5D0217` |
| Accent/progress | Cyan `#03D2D2` |
| Highlights | Yellow `#FFC422`, Amber `#FFA500`, Orange `#FF8200` |
| Dark surfaces | Navy `#1B1931`, Charcoal `#14122A` |
| Light surfaces | Ivory `#F8F7F3`, White `#FFFFFF`, Champagne `#F3EEE6` |
| Light text | Main `#171717`, Secondary `#5D5852`, Muted `#6F6B63` |
| Light border | `#E6E1D8` |

Primary buttons and selected navigation retain maroon in both themes, with readable white text. Dark-theme maroon-associated text uses a high-contrast light tint. Theme-aware success/warning/danger/info colors preserve semantic meaning. The official logo never changes with the theme. Print variables reset to a legible light palette.

Shared controls define focus-visible, hover, pressed, disabled and busy behavior. Inline prose links are underlined, not identified by color alone. Public, Auth, dashboard/history, reports/issues/progress, settings/account, teams, forms, dialogs, errors, skeletons and empty states use the shared system. Mobile navigation and horizontally scrolling tables stay inside their containers.

## 5. Genuine, restrained loading feedback

`BrandedLoading` uses the supplied image, an accessible `role=status`/`aria-live`/`aria-busy` message and a cyan indeterminate track. Reduced-motion preference makes the track/spinners static. It never invents scan percentages or imposes a minimum wait.

The shared loading treatment is connected to route boundaries, session verification, sign-in/sign-up/OAuth/SSO/forgot/reset/confirmation, logout, dashboard/history/settings/report skeletons, explicit audit creation, real active audit progress and PDF preparation. Small actions keep concise inline indicators. Navigation feedback appears after a genuine 150 ms pending threshold, clears on route/query commit, and has a bounded safety cleanup. Authentication and fetch errors clear busy state and offer recovery; duplicate submissions remain disabled while pending.

## 6. Actual PDF pipeline

`src/lib/report/pdf.ts` still uses the existing `pdf-lib` server export route, ownership, allowance/refund and download mechanism. It now adds:

- Embedded full-canvas official 640 PNG, SiteInsights/TalhaImtiazWorks identity and canonical palette.
- Actual target URL, audit identifier, run state, created/finished/generated dates and precise coverage/limitations.
- Repeated running headers, readable severity labels, section/table hierarchy, page numbers and copyright footer.
- Width-measured wrapping of long URLs/tokens, complete findings/descriptions/recommendations/evidence and multi-page rows; no findings-count cap or “titles only” fallback.
- Safe clickable HTTP(S) links and a full lossless `audit-data.json` attachment.
- Standard fonts for supported Latin text; locally bundled, licensed TrueType static Noto Arabic/SC/KR (CJK)/monochrome Emoji fallbacks through the sole new runtime dependency, `@pdf-lib/fontkit@1.1.1`. No network font fetch at report time. Unsupported codepoints are explicitly represented as `[U+XXXX]`, not silently omitted.
- Statically named asset reads plus Next output tracing for production/serverless packaging. No project-wide dynamic-directory tracing.

A browser print header also uses the official image; dark-mode print output resets to light colors. PDF's actual runtime/download, real-audit content and separate synthetic pagination/Unicode stress fixtures must be distinguished in verification results.

## 7. Email and compatibility

All ten HTML/plain-text Auth template pairs and subjects use the new display identity/palette/official logo. Token hashes, email types, click-to-confirm, redirect and anti-enumeration behavior remain intact. Supabase Auth remains the sender: no duplicate application sender was introduced. Generated templates do **not** apply themselves to hosted Supabase. SMTP/provider changes and real email require a separate authorized operator action.

Technical `SiteLensAI` robots directives, `sitelens_*` database/internal names, storage keys, route shapes, download prefixes and migration history remain for compatibility. No schema migration, secret rotation, hosted change, connector or account integration was performed for this redesign.

## 8. Build and deploy

Use Node 22+ and the committed lockfiles. Configure the existing Supabase project's URL/publishable key, persistent database, private `SESSION_SECRET`, verified application origin and production background `CRON_SECRET`; account deletion needs the existing server-only secret/service-role key. Preserve enabled OAuth/SSO providers and callback allowlists. Optional worker/AI/PageSpeed integrations remain optional.

The archive excludes **all `.env*` files**, including `.env.example`. A blank non-env-named template is supplied at `config/environment.example.txt`; copy it privately to `.env.local` if needed. Never commit or package real values. No hosted setup or live domain cutover is implied.

```sh
npm ci
(cd worker && npm ci && npm run typecheck)
npm run verify
npm run release:zip
```

The packager verifies essential source/assets/fonts, paths, CRC, exclusions and independent extraction with every file's SHA-256. The ZIP checksum is delivered alongside the artifact, not embedded recursively into itself.

PDF fallback font maintenance: `python3 scripts/brand/prepare-fonts.py` (optional fontTools, network required). To avoid invalid glyph outlines from the old subsetter, required static CJK/emoji fonts are embedded whole; the static Arabic font uses a validated shaping-aware subset; Unicode reports are larger, while Latin-only reports remain compact. Static regular instances and source/output hashes are shipped in `scripts/brand/fonts/provenance.json`; no variable or CFF fallback is used at runtime, because real PDF rendering exposed unreliable subsets in those formats. Font preparation is not part of an application build.
