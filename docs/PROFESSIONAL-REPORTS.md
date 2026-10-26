# Professional profiles, report publication, and prospects

## Professional onboarding and profile

Signed-in account owners can keep a freelancer or agency profile, services, portfolio items, and optional branding. Profile fields and services are private by default. A field is copied into a new client-report snapshot only when the owner explicitly selects it for publication; contact details are never inferred from the account email. The owner can edit or remove their profile, services, publication choices, and portfolio at any time. Existing report links keep their captured data until they expire or are revoked.

A service can be published and matched only when an audit has open, non-observation scanner findings in one of its selected categories or when a configured keyword exactly matches normalized verified finding text. Resolved and ignored findings are excluded. Matching is deterministic; it does not use AI, verify a provider's credentials, guarantee results, or imply that work has been completed. Only public portfolio entries related to a service/category that actually matched are included. Matching now normalizes eligible finding text once per finding before testing it against the configured services; this reduces repeated evidence normalization but has not been runtime-benchmarked against a live report workload.

Brand colors are stored in the existing `brand_colors` JSONB array as `{ name, value }` entries, with names kept private to the profile editor. Legacy string-only entries are read as `Brand color 1`, etc., so existing palettes are retained. The editor accepts six-digit hex values with or without `#`, normalizes saved values to uppercase `#RRGGBB`, prevents duplicate values case-insensitively, and supports up to 10 entries. Report snapshots receive only the hex values, and only when `brandColors` is selected for publication. The optional logo is a private PNG/JPEG data URI, at most 1 MiB (1,048,576 decoded bytes), no more than 2,048 pixels on either side, and at most 2 million pixels total. The data-URI character bound is derived from that raw-byte limit; the profile API accepts a bounded 2 MiB JSON body to allow for base64 and the surrounding validated profile data. SVG, remote logo URLs, non-canonical base64, oversized files and image headers with unsafe dimensions are rejected. The editor accepts drag/drop or file selection, checks bounded image headers before browser decoding, and shows a preview, filename (for the current selection), dimensions and size. The server performs a bounded full PNG/JPEG decode (not merely a header check) before persistence and again before PDF embedding; client checks are only early usability checks. The database constraint also decodes the Base64 payload and rejects stored image bytes above exactly 1,048,576. A route test covers profile save/read across separate requests with named colors and a PNG using a persistent test repository; a real Postgres refresh remains unverified because no disposable database is configured. The PostgreSQL reader runs the profile, services and portfolio reads concurrently; saves keep the same transaction but replace child rows with one multi-row insert per table rather than one insert per item. This is a query-count reduction, not a measured latency claim. Publication remains opt-in and report snapshots embed the validated data only when selected. No database migration is needed for named colors because the existing JSONB column already permits an array of objects with the same 10-entry bound.

## Report snapshots and access

Creating a new share link creates a server-built, versioned snapshot for that audit and owner. The snapshot freezes the curated scan projection, findings/resolution state, rendering/performance artifacts, and only explicitly published professional data, matched services, and relevant portfolio entries. The shared HTML report and permitted PDF use the same snapshot. A later profile edit or audit change does not rewrite an existing snapshot. Each new snapshot increments the per-audit version. Legacy links without a snapshot retain their previous live-view behavior.

Snapshot tables are server-only: row-level security is enabled and direct `anon`/`authenticated` grants are revoked. Existing plan gating, ownership checks, share expiry/revocation, PDF entitlement, and export limits remain in force. Migrations `007_professional_reports_and_prospects.sql` and `008_team_collaboration.sql` must be applied by an authorized operator before the matching Postgres-backed profile/snapshot/team changes can be used. Both are present in the generated migration artifacts and were **not applied** as part of this work.

## Prospect entry and discovery-provider requirements

Prospects can be entered manually or imported from CSV. Imports accept up to 100 rows and 100 KB, with a website/URL column and optional business name/location columns. Every URL is validated and the whole import is rejected if any URL is invalid; duplicate hosts in one file are coalesced. The app does not scrape Google Maps, guess contact details, contact businesses, or call a discovery/paid API. Saving a finished audit can attach its verified evidence to the matching prospect.

Automated discovery is intentionally not implemented because no authorized, configured provider was available. Use only a provider that is already authorized and configured; any newly added provider requires separate explicit authorization and review. Before enabling one, document the provider and account owner, allowed use and applicable terms, the exact server-side configuration/secret names (never expose credentials to the browser), query and result limits, retention/deletion behavior, source attribution, rate/cost controls, and opt-out behavior. Do not implement scraping or silently introduce a paid provider.

## Operational note

The existing general API/auth rate limiter uses process-local buckets. It remains useful as a per-process guard but does **not** provide a global limit across multiple instances or restarts. No compatible distributed limiter was configured, so this change did not add a Redis/Upstash or other external dependency. A deployment that requires global throttling should configure an approved shared limiter before relying on cross-instance enforcement.

## Latest follow-up verification and rollout

The newest local source-only verification is recorded in [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md). On 2026-10-22 with isolated Node `v22.23.4`, `npm run verify` passed branding, TypeScript, ESLint, the complete Vitest suite (**788 passed, 65 skipped; 57 files passed, 3 fully skipped; 853 tests total**) and the Next.js 16.4.2 production build. The run used `env -i` with only runtime path/home and telemetry opt-out; no production service or database was accessed, and no migration was applied. Real Postgres/Supabase/RLS integration and browser-worker tests remain skipped because their prerequisites are unavailable.

The prospect member-loading and professional-profile query changes reduce source-level request/query/normalization work, but no live database or browser timing benchmark was available. Treat these as code-path reductions, not measured latency gains. The local build's existing `metadataBase` warning for `http://localhost:3000` remains unresolved because no production origin is configured here.

### Initial Phase 3 verification baseline (historical)

Initial Phase 3 verification was run on 2026-10-21 with Node `v22.23.3`. At that point `npm run verify` passed and Vitest reported **757 passed, 63 skipped** (51 files passed, 3 fully skipped; 820 tests total). This is retained as a historical baseline, not the latest test count. The initial focused regressions passed across eight files (54 tests), covering professional-profile type preservation, logo bounds/full decode, PDF publication, prospect sharing and plan behavior, invitation token handling, migration consistency, and public UI contracts.

**Invitation confirmation caveat:** the initial Phase 3 version matched only the validated session claim. The current accept/reject handlers re-fetch the request-scoped Supabase Auth user, require the same user ID and `email_confirmed_at`, and pass only the normalized server-returned email into the email-bound invitation operation. Unit/route tests cover this check. The hosted project's confirmation settings and provider-specific verification policy remain unverified.

### Measured client-entry asset sizes

From the completed Next.js 16.4.2 production build, the route client-manifest JavaScript entries plus route CSS were summed, then gzip-compressed locally at level 9. This measures build artifact payload only; it is **not** a browser timing/Web Vitals benchmark and excludes shared runtime, HTML, fonts, images, network conditions, and execution cost.

| Route entry | Raw JS + CSS | Gzip (level 9) |
| --- | ---: | ---: |
| Dashboard prospects | 99,553 bytes | 27,610 bytes |
| Account teams | 97,442 bytes | 26,956 bytes |
| Professional profile | 215,029 bytes | 61,755 bytes |

No browser executable, Playwright, or Puppeteer was installed. The browser-worker integration tests were consequently skipped; mobile/tablet/desktop viewport and visual acceptance for these screens remains **unverified**. Responsive breakpoints and wrapping are present in the UI source, but are not a substitute for that browser check.

Before rollout, an authorized operator must review and apply migrations `007` and `008` through the approved process. Neither was applied during this work. The generated setup/migration files are source artifacts only; they do not prove a database schema is ready.
