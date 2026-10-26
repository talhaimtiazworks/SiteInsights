# TalhaImtiazWorks redesign — release verification

**Historical redesign verification:** locally run 2026-10-18 against baseline `d5ff08970eea1d23d976d163b6149ff050a8dfc6`. The provider-avatar replacement verification for 2026-10-21 is recorded below; the B2 avatar-upload supplement is retained only as a historical record of the superseded implementation. None of these sections certifies hosted production readiness.

Implementation and configuration details: [REDESIGN.md](REDESIGN.md). Reproduction commands and optional prerequisites: [TESTING.md](TESTING.md). Branding evidence: [REBRAND-VERIFICATION.md](REBRAND-VERIFICATION.md).

## Follow-up — AI settings, shared-audit UI, and professional branding — 2026-10-22

**Newest local source-only verification.** Ran `npm run verify` with isolated Node `v22.23.4` and a cleared environment (`env -i`, with only runtime path/home and telemetry opt-out). No database, Supabase/Auth, AI provider, or production service was contacted; no environment values or secrets were inspected. This is not a deployment or production readiness check.

| Check | Actual result |
|---|---|
| Branding | `npm run brand:check` passed; 387 active text files and 31 required assets/routes checked |
| TypeScript / ESLint | `npm run typecheck` and `npm run lint` passed |
| Full Vitest suite | **788 passed, 65 skipped; 57 files passed, 3 fully skipped; 853 total tests** |
| Production build | `npm run build` passed with Next.js 16.4.2/Turbopack; the existing `metadataBase` fallback warning still names `http://localhost:3000` |
| Browser acceptance | Seven `worker-render.integration.test.ts` cases skipped because no browser runtime is available. Desktop/mobile visual, viewport, keyboard, screen-reader and axe acceptance is not claimed |
| Database integration | Real Postgres/Supabase and RLS integration cases were skipped because no disposable services were configured; in-memory/API access-boundary tests passed |
| Whitespace | `git diff --check` passed |
| Migrations / deployment | No migration or database policy was added or applied for this follow-up. Existing migration artifacts `007`/`008` remain unapplied. No deployment, commit, or production access was performed |

The AI operator-enablement panel and its setup copy were removed while provider selection, integrations and health checks remain. Team audit sharing continues through the existing organization/membership/owner checks; the UI identifies private/shared audits and gives owners a share/unshare control. Professional palettes now store editable `{ name, value }` entries in the existing JSONB field, accept legacy hex-only entries, and publish only selected hex values. The profile editor implements logo click/drop, preview and metadata; exact PNG/JPEG size, dimension and server content-validation rules are covered by passing route/unit tests. The account dropdown's source-level contrast assertion passes, but it was not visually checked in a browser.

## Phase 4 — application redesign and secure team audit sharing — 2026-10-21

**Historical Phase 4 implementation record; the 2026-10-22 follow-up above is the newest source verification.** This section preserves the earlier Phase 4 implementation and local performance notes. Verification used isolated Node `v22.23.3`; system Node remains `v20.20.2`. No `TEST_*`, database, or Supabase connection variable names were present in the environment (names only were checked; environment values were never inspected). The local preview was separately started with `env -i`, so it received no inherited service configuration. No external service/database was contacted, no migration was applied, and no deployment was performed.

| Check | Actual result |
|---|---|
| Branding | `npm run brand:check` passed; 385 active text files and 31 required assets/routes checked |
| TypeScript / ESLint | `npm run typecheck` and `npm run lint` passed |
| Full Vitest suite | **775 passed, 65 skipped; 55 files passed, 3 fully skipped; 840 total tests** |
| Production build | `npm run build` passed with Next.js 16.4.2/Turbopack; route manifest marks `/contact` and `/help` static, `/teams` and `/` dynamic. Existing `metadataBase` fallback warning still points to `http://localhost:3000` without a configured deployment origin |
| Focused Phase 4 regressions | Local sharing, UI/profile/navigation and optional-integration harnesses passed; real account/Postgres/RLS cases were skipped because no disposable Auth/Postgres fixture was configured |
| Browser acceptance | No Chromium/Firefox or Playwright/Puppeteer package was available; all seven `worker-render.integration.test.ts` cases skipped. No screenshot, viewport, axe, keyboard, or screen-reader acceptance is claimed |
| Whitespace | `git diff --check` passed |
| Application / migrations | Source builds locally; no deployment. Phase 4 added no migration. Existing source migrations `007`/`008` remain unapplied and require the approved operator migration process before deploying matching profile/team code |

The UI includes the responsive header/account menu, shared app surfaces and restrained reduced-motion-safe movement, skeleton/region loading states, freelancer/agency radio selection, agency-only field display with retained data, a reusable owner-only team-share dialog, the authenticated `/teams` entry into the existing organization client, and `/contact`. `/help` content is unchanged. `/contact` links to existing internal `/help#faq`, `/help#crawler`, `/usage` and `/about` routes, uses only a syntactically validated optional deployment contact email, and lists no invented social account. No actual deployment contact address was verified or disclosed; the mail link appears only when `NEXT_PUBLIC_CONTACT_EMAIL` passes validation, and environment values were not inspected.

### Audit sharing and authorization

The memory/API regressions passed for private-by-default audits, explicit share/unshare, required expected-organization compare-and-set (including a competing-write race), foreign-team refusal, read-only current-member findings access, outsider denial, and owner-only edits. `accounts.integration.test.ts` now covers the full shared results/findings/detail/evidence reads, unshare, a stale `409`, member removal, team deletion and owner persistence; `rls.integration.test.ts` tests that unshare/removal hides audits and child evidence. These real Auth/Postgres/RLS paths were **not executed** in this environment. No audit ownership, share-link/PDF snapshot rules, expiry/revocation, credits, or PDF branding were changed, and no database migration was introduced for the Phase 4 sharing follow-up.

### Local performance investigation — not field/Web Vitals data

The reported slowness could not be reproduced against a real deployment or authenticated database, so no latency improvement or Core Web Vitals result is claimed. I measured only a local production build/server and reviewed request structure:

- Environment: `npm run build` output from Next.js 16.4.2, then `next start` on `0.0.0.0:3000` under `env -i` with only Node/npm/runtime variables. No Auth, database, provider, CDN, or telemetry configuration was supplied. The final-build server reported ready in **137 ms**.
- Method: `curl --noproxy '*'` against loopback HTTP, 11 sequential GETs per route; discarded the first sample and computed median and maximum from the next 10. No `Accept-Encoding` was sent (HTML byte counts are uncompressed), no browser/CPU/network throttling was used. Timings are same-sandbox microbenchmarks, not Internet/user timings.

| Route/state | HTTP | HTML bytes | TTFB median / max | Full-response median / max |
|---|---:|---:|---:|---:|
| `/` | 200 | 65,826 | 18.81 / 42.99 ms | 19.05 / 43.03 ms |
| `/contact` | 200 | 46,515 | 3.23 / 4.00 ms | 3.26 / 4.03 ms |

The referenced initial script and stylesheet assets were summed from each HTML document, fetched locally, and gzip-compressed with Python `gzip.compress(..., compresslevel=9, mtime=0)` (an estimate, not a measured CDN transfer):

| Route | JavaScript raw / gzip | CSS raw / gzip |
|---|---:|---:|
| `/` | 617,292 / 192,235 bytes | 49,565 / 9,905 bytes |
| `/contact` | 601,713 / 185,916 bytes | 49,565 / 9,905 bytes |

These sums include Next runtime/polyfill chunks, but exclude HTML/inline data, local fonts, caching, network transfer behavior and browser execution. They are not LCP/INP/CLS. The anonymous `/teams` and professional-profile requests were not counted as rendered protected pages: Next returned a streamed sign-in redirect inside HTTP 200 and the HTML contained no team/profile content. Source review shows session observers share the client store's in-flight `/api/auth/session` request, and the teams list loads once with detail fetched on selection; this is code inspection, not a database-latency measurement. No real backend/API timing, authenticated browser rendering, or field telemetry was available, so the original slowness remains unconfirmed and requires a same-environment authenticated trace (browser + test database/provider) or production RUM evidence.

## Phase 3 follow-up — invitation, UX, profile and performance hardening — 2026-10-21

This was the newest verification before Phase 4 and is retained as historical context. It used Node `v22.23.3`, an isolated environment with database/Supabase/provider/test connection values blank, `DB_AUTO_MIGRATE=false`, and telemetry disabled. No external service or database was contacted, no migration was applied, and no deployment was performed.

| Check | Actual result |
|---|---|
| Branding | `npm run brand:check` passed; 383 active text files and 31 required assets/routes checked |
| TypeScript | `npm run typecheck` passed |
| ESLint | `npm run lint` passed |
| Full Vitest suite | **769 passed, 64 skipped; 54 files passed, 3 fully skipped; 833 tests total** |
| Production build | `npm run build` passed with Next.js 16.4.2; Next emitted the existing `metadataBase` fallback warning for `http://localhost:3000` |
| Whitespace | `git diff --check` passed after code and documentation updates |
| Invitation confirmation | Four helper tests and five route tests cover fresh Auth lookup, matching user ID, `email_confirmed_at`, failure behavior, and that accept/reject use the server-confirmed normalized email |
| Logo/profile persistence | The exact 1 MiB tests remain passing; a route test saves a valid PNG and reads it through a separate request using a persistent test repository. A real Postgres profile/service/portfolio round-trip test was added to the opt-in integration suite but was skipped here |
| Browser / database integration | Browser worker tests and disposable Postgres/Supabase integration suites were skipped because those prerequisites are unavailable; no visual viewport or real database result is claimed |

**Changes verified by source and route/unit tests:** invitation accept/reject fail closed unless request-scoped Supabase Auth confirms the matching user and email. The prospect editor now makes one combined organization/member HTTP request; the endpoint performs one organization-list query and one member query scoped to the caller's teams, replacing per-team member fetches. Profile reads are scheduled concurrently; services and portfolio rows use multi-row inserts inside the existing transaction. Finding evidence is normalized once per eligible finding rather than once per service/finding pair. These are measured query/CPU-work reductions in the code path, **not** measured hosted latency improvements; no disposable database was available for a timing benchmark.

The loading/UI follow-up removes the full-screen sign-out overlay and duplicate branded loaders, uses skeletons with a screen-reader status for route loading, retains button/progress/error/retry feedback, wraps long content and button labels, and adds brief entrance/hover motion that is disabled for reduced-motion preferences. `aria-pressed` remains the status-filter state semantic. No browser-based visual, keyboard, or assistive-technology acceptance was possible in this run.

The server now checks `email_confirmed_at` from Supabase Auth, but the hosted project's Auth confirmation settings/provider behavior remain unverified. Apply migrations `007`/`008` only through the authorized operator process; neither was applied here.

## Phase 3 UI/UX, professional profile, and team collaboration — initial local verification — 2026-10-21

This section records the initial Phase 3 baseline. The follow-up record above contains the latest source and verification results.

| Check | Actual result |
|---|---|
| Runtime | Node `v22.23.3` supplied ephemerally with `npx node@22`; project/system Node remains unchanged |
| Full verification | `npm run verify` passed: brand check, TypeScript, ESLint, full Vitest run, and Next.js 16.4.2 production build |
| Vitest | **757 passed, 63 skipped; 51 files passed, 3 skipped; 820 tests total** |
| Focused Phase 3 regressions | **54 passed** across eight files, including type preservation, full image decode/limits, PDF publication, prospect sharing, invitations, migration alignment, and product UI contracts |
| Migration artifacts | Eight source migrations generated into `src/lib/db/migrations.ts` and `db/supabase-setup.sql`; migrations 007/008 **not applied** |
| Database/production safety | `DB_AUTO_MIGRATE=false` and database/Supabase test URLs blank during verification; no production service/database accessed and no migration applied |
| Whitespace check | `git diff --check` passed |

**Measured client-entry asset payload (not runtime performance):** after the production build, route-manifest JavaScript entry assets plus route CSS were summed and gzip-compressed locally at level 9. Dashboard prospects: **99,553 bytes raw / 27,610 gzip**; account teams: **97,442 / 26,956**; professional profile: **215,029 / 61,755**. These counts exclude shared runtime, HTML, fonts, images, network conditions, browser execution, and Web Vitals; no runtime timing benchmark is claimed.

No local browser executable, Playwright, or Puppeteer was installed. The browser-worker integration suite therefore skipped all seven browser-dependent tests, and no visual/viewport acceptance was completed at mobile/tablet/desktop widths. Database-backed integration suites requiring disposable Postgres/Supabase fixtures were also skipped. Responsive classes, focus styling, text wrapping, and reduced-motion rules were source-reviewed, but they do not replace browser verification. The build emitted Next.js's existing `metadataBase` fallback warning for `http://localhost:3000` because no local production origin was configured.

**Historical caveat, resolved in the follow-up above:** the initial Phase 3 version trusted the validated session email claim without checking Auth's confirmation timestamp. The current accept/reject routes now call `requireConfirmedAccountEmail`, which re-fetches the current Supabase Auth user, checks the matching user ID and `email_confirmed_at`, normalizes the server-returned email, and fails closed on Auth errors. Unit/route tests cover this behavior. Hosted confirmation settings and provider-specific verification policy remain unverified.

## Provider-avatar replacement verification — 2026-10-21

This section records checks run against the current local worktree. It does not certify hosted Auth, a production deployment, or the state of any external storage resource.

| Check | Actual result |
|---|---|
| Runtime | Node `v22.23.3` supplied for this run with `npx -p node@22`; system Node remains `v20.20.2` |
| Combined verification | `npm run verify` completed successfully from branding through TypeScript, ESLint, full tests and production build |
| Dependency install | `npm ci --no-audit --no-fund` succeeded; 478 packages installed |
| Branding | `npm run brand:check` passed; 365 active text files and 31 required assets/routes checked |
| TypeScript | `npm run typecheck` passed |
| ESLint | `npm run lint` passed |
| Focused avatar/provenance tests | **31 passed** across `avatar.test.ts`, `auth-avatar.test.ts`, `session-provider.test.ts`, `oauth-provider-flow.test.ts`, and `profile-avatar.test.ts` |
| Sign-out cookie regression | `tests/sign-out.test.ts`: **1 passed**, including expiration of provider-provenance cookies |
| Full unit/integration suite | `npm test` within final `npm run verify`: **729 passed, 63 skipped; 43 files passed, 3 skipped; 792 tests total** |
| Production build | `npm run build` passed with Next.js 16.4.2; existing `metadataBase` fallback warning uses `http://localhost:3000` because no production origin is configured locally |
| Whitespace/diff check | `git diff --check` passed |
| Migration generation | Earlier in this update, `node scripts/generate-migrations.mjs` generated six automatic migrations; migration 007 remains excluded under `db/optional/` |
| Source ZIP | `npm run release:zip` passed safe-path/CRC checks, required-file checks, credential/build exclusions, independent extraction and byte-for-byte SHA-256 parity; **512 source files**, 167 required files. ZIP and sidecar: `SiteInsights-TalhaImtiazWorks-Redesign.zip` and `SiteInsights-TalhaImtiazWorks-Redesign.zip.sha256` |

The OAuth identity path now uses a short-lived, signed OAuth-start marker and matching HttpOnly cookie; the callback checks the server-returned Supabase identity and binds a second signed marker to the validated JWT `session_id`. A missing/weak `SESSION_SECRET`, missing provider data, or ambiguous latest-identity data falls back to the default avatar. `app_metadata.provider`, `user_metadata.avatar_url`, and Google `picture` are not used as current-provider/image evidence. The unit tests cover linked-provider and non-GitHub fallback behavior. The existing PKCE cookie and account-link mode remain in place.

### Not run / not verified

- The OAuth end-to-end smoke script was not run against local GoTrue/provider mocks or a real Google/GitHub provider. Test fixtures do not prove actual OAuth provider connectivity or hosted account-linking behavior.
- No hosted Supabase/Auth/Vercel/production checks, deploy, remote diagnostics, or production migration were run. This checkout has no configured Git remote; no deployment is claimed.
- No live B2/API calls, environment inspection, bucket/key/object cleanup, or migration of legacy files was performed.
- Some optional integration tests were skipped because their disposable real-service prerequisites were not configured. The full-suite skips are reported as skips, not passes.

### Remaining B2/storage dependencies

The current `src/`, `scripts/`, and package manifests contain no avatar-specific B2 configuration, B2 runtime client, signed-upload endpoint, or upload flow. No avatar-only AWS SDK dependency remains. B2 references left in documentation are historical. The preserved `db/optional/007_avatar_storage.sql` is legacy **Supabase Storage** SQL (not B2) and stays outside automatic migrations; the `profiles.avatar_url` column and existing values are also untouched. This source inspection cannot establish whether B2 variables, buckets, keys, or objects still exist in an external account; any such remote resources were neither inspected nor deleted and should be privately checked before retirement.

## Historical — B2 avatar-upload implementation / incident supplement (superseded 2026-10-21)

**Historical only:** the upload/storage implementation described below has been removed from the current source. Its old test counts, diagnostics and live-probe notes do not verify the provider-avatar replacement, and they do not authorize cleanup of any remote setting or object.

The existing avatar lifecycle was adapted to private Backblaze B2's S3-compatible API; Supabase Auth/PostgreSQL and the existing `storage://avatars/<user-id>/avatar-<uuid>.<extension>` profile reference remain in place. No new database migration was added. The code now issues five-minute signed PUT/GET URLs, keeps B2 credentials server-only, validates owner/path, declared size and content signature before saving the profile reference, and retains legacy HTTPS avatars. This workspace's previous avatar provider was Supabase Storage (not the Cloudflare R2/AWS-S3 implementation described in the request); a source-preserving one-time copy script is documented for any old Supabase objects.

### Local verification actually run

| Check | Actual result |
|---|---|
| Runtime | Node `v22.23.3` supplied for this run with `npx -p node@22` (system Node remains `v20.20.2`) |
| `npm run brand:check` | Passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | **735 passed, 63 skipped; 43 files passed, 3 skipped; 798 tests total** |
| `npm run build` | Passed (Next.js 16.4.2, production build); Next emitted its existing `metadataBase` fallback warning for localhost |
| B2-focused tests | **37 passed** across avatar validation/config, offline SigV4 URL signing, route ownership/replacement/removal, and browser header boundaries; included in the full-suite totals |
| Migration CLI syntax | `node --check scripts/migrate-avatar-objects-to-b2.mjs` passed |
| Release packager | Passed safe-path/CRC/essential-file/exclusion checks and independent byte-for-byte extraction; **515 source files**, 157 essential files; refreshed release ZIP and `.sha256` sidecar produced in the workspace |

The B2 URL tests use dummy credentials and a fake endpoint and make no network request. `npm install` reported **12 dependency audit findings (3 moderate, 7 high, 2 critical)**; they were not investigated or remediated as part of this scoped update.

### Incident diagnosis — 2026-10-21

The supplied production log's `bucketMissing: true` was a **false-positive classification**, not evidence that the configured bucket did not exist. In `src/app/api/account/avatar/route.ts`, the old classifier set `bucketMissing` when the thrown error was named `AvatarStorageConfigError`. That exception is raised locally in `src/lib/avatar-storage.ts` before any request to B2 when `getConfig().avatarStorage.configured` is false or a required parsed field is empty. `src/lib/config/env.ts` reads the exact five names `B2_ENDPOINT`, `B2_REGION`, `B2_ACCESS_KEY_ID`, `B2_SECRET_ACCESS_KEY`, and `B2_BUCKET_NAME`; it validates the HTTPS S3 endpoint format and exact endpoint/region match. URL presigning is local, so that specific log cannot establish bucket existence or B2 permissions.

The classifier now emits `configurationError: true`, and logs only missing/invalid **variable names** from the parser; it sets `bucketMissing: true` only for an actual provider `NoSuchBucket`-type response. A separate `avatar_storage_config_invalid` API code distinguishes local configuration from `avatar_storage_bucket_missing`. Regression tests cover both paths and verify that neither raw error messages nor unrecognized names are logged. `getConfig()` is memoized per process; changed Vercel variables take effect only in a new serving deployment/process.

### Not verified live

No B2 account, real bucket endpoint/region, credentials, authenticated user session, or Vercel deployment connection was available. Public, unauthenticated probes to the supplied production URL did run: `GET /api/account/avatar` returned the expected `401 auth_required`, and `GET /api/system/status` returned `200` with app version `0.4.0`, accounts enabled, and Postgres ready. That public status endpoint does not expose B2 configuration or source commit; the response's Vercel request ID cannot prove the deployed revision. The Vercel connector was disconnected, so deployment-specific environment values, alias target, and logs could not be inspected. No live B2 request, CORS preflight, upload, download, delete, object migration, authenticated avatar acceptance, or deployment was performed. The `avatar_storage` diagnostic checks configuration presence/format and endpoint-region agreement only; it cannot prove credentials, bucket existence, key capabilities, or CORS. Never put B2 credentials in chat or a public/browser variable.

Existing `storage://` profile references continue to work only after their object keys exist in the configured B2 bucket. For any old Supabase Storage objects, use the documented dry-run/explicit `--apply` migration script, verify the photos, and retain the source until the move is accepted. No live object bytes were copied here.

## Historical redesign checks — 2026-10-18

| Check | Actual result |
|---|---|
| Root TypeScript | `npm run typecheck` passed |
| ESLint | `npm run lint` passed |
| Worker TypeScript | `npm run typecheck --prefix worker` passed |
| Canonical palette/assets | `npm run brand:check` passed; 31 required assets/routes present |
| Complete suite with disposable real Auth/PostgreSQL fixtures | **699 passed, 13 skipped; 36 files passed; 109.20 s** |
| Included real GoTrue/PostgreSQL/RLS suites | **33 passed**, two prerequisite-marker cases skipped; these passes are included in 699, not additional |
| Included actual Chromium worker integration | All 7 tests passed, including SSRF/private-subresource/rebinding/resource controls |
| Included PDF regressions | All 7 passed; the 260-finding/long-URL/Unicode stress case stayed within the 30 s budget (whole PDF test file: 20.449 s) |
| Production build of the browser-tested implementation | Passed, including TypeScript; incremental optimized compilation 4.0 s |
| Public browser matrix | **36 visits/layout checks**, 24 axe page/theme checks; no detected violations, page overflow or runtime errors |
| Authenticated browser acceptance | **13 successful steps**, including two account cleanups; **57 axe/layout checks**, no detected violations/overflow/runtime errors |
| Additional loading/keyboard acceptance | Five scenarios plus successful account cleanup; all passed |
| Compiled SMTP canary boundary | **1,593 files checked, zero matches** in browser/compiled server output |
| Literal private-test-credential scan of compiled output | 43 client files + 1,550 server files checked; zero matches; values were never printed |
| PDF serverless trace | 149 dependencies; all four local fallback fonts, licenses and provenance present; zero env-file paths |
| Whitespace/diff check | `git diff --check` passed |

These are actual runs, not inferred results. Offline provider fixtures do not establish hosted provider connectivity. Automated axe results are not a WCAG certification or a substitute for assistive-technology review.

### Skips, not successes

The 13 skipped cases were: eight optional production-failure database reproductions, two special percent-password/pooler database cases, one inapplicable in-memory database-outage case, and the Auth/RLS prerequisite-marker cases. Their corresponding prerequisites were not invented. Ordinary PostgreSQL, verified Auth, cross-user access and RLS tests did execute against disposable **real local** services. No production database was tested or modified.

## Historical redesign — mandatory authentication and ownership

Actual browser acceptance used a production Next build, real local Supabase Auth (GoTrue), PostgreSQL and a loopback SMTP capture service. No mocked production authentication backend was substituted.

Verified behavior:

- Anonymous direct start/advance/rerun/list/dashboard/audit-data/results/PDF calls returned **401**. Missing internal processor credentials also returned 401. Protected server pages redirected to sign-in without rendering the protected audit form; Next may stream that server redirect inside HTTP 200.
- Invalid cookies and a **validly HMAC-signed, expired local-provider session with an unusable refresh token** could not start, advance or export an audit (401).
- Actual signup produced a real confirmation message in the local capture inbox with the official-logo template. The user clicked confirmation, returned safely to `/audit/new`, and **no audit ran until an explicit post-login submission**.
- Explicit submission created an account-owned audit. A second separately verified account received **404** for the first account's reads, results, export, advance, rerun and delete, including with a legacy access-key header.
- Actual logout removed access (401). Subsequent real login reopened the owned report without submitting another audit.
- Session cookies were HttpOnly/SameSite; the normal HTTPS secure-cookie logic was retained. Client-supplied owner/plan IDs, legacy URLs/cookies and public keys alone are not audit authority.
- Additional cryptographic/route/service tests cover absent configuration, anonymous Supabase JWTs, forged identity, direct service calls, mutations, quota/idempotency ordering, explicit legacy claims, organization read-only access and revocation.

The internal cron/worker is **trusted server infrastructure**, not an anonymous user endpoint: it retains its private bearer authorization and processes only account-owned work; every new audit initiation is authenticated. Historical anonymous jobs are skipped. The independent renderer retains bearer authentication, egress isolation and SSRF controls.

## Historical redesign — real audit and actual downloaded PDF

One final browser-initiated audit of `https://example.com/` completed in **665 ms**, with **1 fetched HTML page and 7 findings** (2 medium, 5 low), as reported by the existing scanner. Audit ID: `fd95eae9-864d-4697-9e22-6621daa4de69`. Its disposable owner and the second verification account were subsequently deleted. The exported report remains an evidence artifact, not an accessible hosted report URL.

**`SiteInsights-real-audit-report.pdf`** was downloaded through the actual authenticated UI/export API, not created by renaming another file:

- 298,519 bytes; 3 pages.
- SHA-256: `663ad13ebb175b5e703e141b6b423f117dd02cda4d62fd98e661f5fb8a8fda7c`.
- Actual URL, creation/run/generated timestamps, coverage, limits, findings and evidence; no fabricated scan numbers or dates.
- All seven titles present; page numbering and official logo on every page; full JSON attachment.
- Browser/PageSpeed checks were **not enabled** on that real audit and were honestly reported as not evaluated. Separate worker/UI accessibility tests must not be mistaken for measurements of example.com.

### Rendering, not just successful generation

Every page of the actual download, a second real-data generator output, and **two explicitly labelled 14-page synthetic pagination/font fixtures** was rendered with MuPDF. The fixtures are layout evidence, **not website findings**. They exercise long URLs/descriptions, row/page boundaries, Japanese/Chinese, Korean, Arabic/Urdu, accented Latin and emoji; a second fixture forces the separate SC font path without Korean.

Final results: **zero renderer/font warnings, blank pages, out-of-page text spans or unsupported-character markers in these inputs**. Original 640-pixel full-canvas derivative pixels and alpha matched the embedded PDF image exactly; displayed aspect ratios were 1:1. Sampled pages were visually reviewed, including Unicode shaping, spacing and page breaks. Structured evidence is in [verification/pdf-layout.json](verification/pdf-layout.json).

A real rendering check found broken CFF/variable/composite font subsets earlier in implementation. These were not accepted as passing: static regular TrueType assets now ship, CJK/emoji fonts are embedded whole when needed, and Arabic uses a validated contextual subset with complete phrase shaping. No runtime font network fetch or Python dependency was introduced. Fonts have licenses/provenance and explicit production output tracing.

Unicode coverage is not universal: rarer unsupported codepoints appear explicitly as `[U+XXXX]`, while the original content is retained losslessly in the JSON attachment. Full language/assistive-reader coverage is not claimed. Whole CJK fonts make Unicode-heavy PDFs larger (the tested fixtures were about 4.1 MB and 7.4 MB); ordinary Latin reports remain compact. The legacy `maxDetailedFindings` option no longer truncates findings.

## Historical redesign — loading, keyboard and responsive acceptance

Real pending requests were held only by QA interception, then released to the real backend. Application code contains no artificial success delay.

Observed official-logo feedback for session verification, failed Auth, audit initiation, genuinely active progress, PDF preparation and logout. Duplicate submission was blocked; error/completion removed busy feedback. Reduced-motion loading was static. Additional acceptance held actual history/dashboard/report requests: they ended in the real empty account state or an honest 404, with no stale loader. A genuinely pending route navigation displayed feedback and cleared on arrival.

Keyboard acceptance exercised the visible skip-link focus ring and 320 px mobile navigation using Tab/Enter only. Authenticated views were checked at 1440/375 px in both themes, with extra 320 px checks. Public pages were checked in both themes with extra 320/375/768 px layouts. The final 93 layout visits and 81 axe page/theme checks had no detected overflow/violations. The account accessible name and narrow signed-in header issues discovered during acceptance were fixed and rerun successfully.

Machine-readable evidence (no passwords, tokens or private keys): [public browser](verification/public-browser.json), [authenticated browser](verification/authenticated-browser.json), [loading/keyboard](verification/loading-browser.json), [compiled boundary](verification/compiled-boundary.json).

## Historical archive and fresh-directory validation — 2026-10-18

The earlier redesign run also delivered **`SiteInsights-TalhaImtiazWorks-Redesign.zip`**, with a single `SiteInsights/` root. The historical B2 supplement above recorded a refreshed archive for that former implementation; it predates the provider-avatar replacement. A current archive of the provider-avatar source was generated and independently verified; see the ZIP row in the verification table above. A source ZIP is a convenience, not a Vercel deployment input. `scripts/package-release.py` checks safe unique paths, CRC, essential source/assets/fonts/licenses/config, strict exclusions and independent extraction with SHA-256 equality for every file. It emits a `.zip.sha256` sidecar.

It excludes all `.env*` files (including `.env.example`), env-suffixed/embedded env paths, credentials/private-key files, Git internals, dependencies, build/cache output and runtime logs. **`config/environment.example.txt`** supplies the blank distributable environment template. Source, both manifests/lockfiles, worker/deployment files, DB migrations, scripts/tests, documentation and official assets/fonts remain included.

Fresh installation/verification happens **after packaging**, against an extraction of that exact ZIP. Actual outcomes and the final ZIP hash are recorded alongside the artifact in **`SiteInsights-Release-Validation.json`** and **`SiteInsights-Implementation-Report.md`**, not recursively embedded into the already-verified ZIP. Reproduction does not require a Git checkout. A fresh directory shares the installed Node/Chromium/system tooling; it is not a new operating-system or hosted deployment test.

## Operator requirements and limitations

Before a real deployment, privately configure the existing Supabase URL/publishable key, persistent database/SSL, application HTTPS origin, session/cron secrets and enabled provider callbacks. The server-only Supabase admin key remains necessary for account deletion. Follow [ENVIRONMENT.md](ENVIRONMENT.md), [SUPABASE.md](SUPABASE.md) and [DEPLOYMENT.md](DEPLOYMENT.md); do not reset or overwrite an existing production schema.

- **Not verified:** hosted Supabase/Vercel/DNS/HTTPS/domain cutover; real external inbox delivery/Mailjet/Gmail; actual Google/GitHub/SAML login; hosted AI/PageSpeed credentials; optional special database/pooler fixtures; exhaustive manual assistive-technology testing.
- Generated email templates were not applied to hosted Supabase, and no external email was sent or SMTP/cloud configuration changed.
- The preview uses genuine but isolated local Auth/PostgreSQL, not the operator's hosted credentials. Optional real-audit browser/performance integrations were disabled and marked not evaluated.
- **This bullet describes only the 2026-10-18 redesign baseline:** no account connector/OAuth app integration, secret rotation, hosted migration, database-schema change or scanner-rule/scoring rewrite was performed; scanner changes were a display-name string and a comment. The historical B2 supplement above describes a subsequent, now-removed upload adapter. The 2026-10-21 provider-avatar replacement changes app code/docs/tests only: it leaves Supabase Auth/OAuth/linking protections, production settings/data, schema, RLS and scanner/provider behavior unchanged. Migration 007 remains preserved outside automatic migrations pending compatibility review.
