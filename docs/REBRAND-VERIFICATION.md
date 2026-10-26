# Official logo, palette and interface verification

**2026-10-18 · SiteInsights / TalhaImtiazWorks redesign**

This is the current branding result, replacing older SVG-only/import rebrand verification. Actual security/build/PDF test results and limitations are in [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md); implementation is in [REDESIGN.md](REDESIGN.md).

## Supplied artwork: preserved, not recreated

- Original supplied `download.png`: **1141 × 1141 RGBA, 1:1**, transparent corners, original white circular field and navy/blue/teal artwork.
- Distributed byte-identical source: `public/brand/talhaimtiazworks-logo.png`.
- SHA-256: **`ad7e9c8c39e925449fff71b57e7efe89244a8a7ec9da20aa2aada1e24b5b8c50`**.
- 160/320/640 PNGs resample the **entire canvas** proportionally. No crop, filter, recolor, vector imitation, generated replacement or theme-specific reinterpretation.
- Header/Auth/loading/footer/email/report use that official artwork. Favicons/social assets and existing SVG filenames derive from/embed the same image. SVG names containing `dark` or `mono` are retained compatibility aliases, not alternate artwork.
- PDF embedded pixels/alpha exactly match the official 640 derivative and all displayed logo rectangles are square. Original logo integrity and complete alpha/provenance are checked in regression tests.

## Canonical palette and both themes

`src/lib/design-tokens.json` is canonical; generated `src/app/brand-tokens.css`, Tailwind, PDF and email use it. Named `--color-*` tokens expose these exact base colors:

| Name | Value |
|---|---|
| Deep Maroon / primary | `#5D0217` |
| Cyan / accent | `#03D2D2` |
| Yellow | `#FFC422` |
| Amber | `#FFA500` |
| Orange | `#FF8200` |
| Navy | `#1B1931` |
| Ivory | `#F8F7F3` |
| White | `#FFFFFF` |
| Main text | `#171717` |
| Secondary text | `#5D5852` |
| Muted text | `#6F6B63` |
| Border | `#E6E1D8` |
| Charcoal | `#14122A` |
| Champagne | `#F3EEE6` |

Theme-aware semantic danger/warning/success/info tokens retain meaning. Maroon remains the action/selected-navigation color in both themes; a readable light tint handles primary-associated text on dark surfaces. Pure cyan is an accent/progress color, not unreadable body text on white. Print resets to light tokens. Inline prose links are underlined and focus-visible states remain distinct.

The original logo's blue/teal pixels and technical compatibility identifiers are deliberately unchanged; they are not retired interface primary colors. SQL history, crawler directives and fixtures were not mechanically rewritten.

## Executed visual/browser checks

- Canonical token synchronization and the 31 required assets/routes passed `npm run brand:check`.
- Actual public production pages: **36 visits/layout checks**, including both themes, desktop and extra 320/375/768 px layouts; no detected overflow or runtime errors. The 24 public axe page/theme checks detected zero WCAG A/AA violations.
- Actual authenticated dashboard/history/new-audit/settings/profile/security/connections/usage/appearance/teams/delete/report/issue-detail screens: **57 axe/layout visits**, covering both themes at 1440/375 px plus extra 320 px checks; zero detected violations/overflow/runtime errors.
- The signed-in account label was corrected to include the visible initials without punctuation that confused label-in-name checking. The 320 px signed-in header was corrected with proportional logo sizing/spacing. Both fixes were in the subsequently passing full matrix.
- Keyboard-only acceptance verified visible skip-link focus, mobile navigation and return to the audit list at 320 px. Controlled pending requests verified genuine route/history/dashboard/report loading and clean error/completion.
- Session/loading reduced-motion treatment, actual signup/confirmation, audit initiation, active progress, PDF preparation, logout and duplicate-submit locks were observed. No ready content is intentionally held for a cosmetic progress effect.
- Selected public/Auth/dashboard/profile/report screenshots in both themes and PDF pages were visually reviewed. Automated scans are not a substitute for comprehensive screen-reader/manual review.

Machine-readable summaries: [public](verification/public-browser.json), [authenticated](verification/authenticated-browser.json), [loading](verification/loading-browser.json), [PDF](verification/pdf-layout.json).

## PDF, email and deployment boundaries

The actual authenticated example.com report download contains **3 pages and all 7 scanner findings**, with the official logo, canonical palette, genuine metadata and page numbering. Two clearly labelled synthetic **14-page** fixtures test long content and the separate static Unicode font paths. Every page rendered with zero font warnings; the prior CFF/subset outline errors were repaired, not waived. Font licenses/provenance and runtime tracing are included. Rarer unbundled characters are explicitly coded, with originals retained in the attachment; universal language support is not claimed.

All ten Auth template pairs/subjects were regenerated using the official image/palette. Real local GoTrue confirmation capture verified the branded template path. No hosted template/SMTP change or external email-delivery claim is made.

Safe return URLs, account-only audits, server guards, ownership, real providers and background/worker security remain functional. The app is not rebuilt from scratch. No forced production domain, OAuth/account connector, cloud deployment, schema migration or credential is bundled. The actual ZIP and post-packaging fresh-directory results are identified in [RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md).
