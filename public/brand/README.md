# Official SiteInsights / TalhaImtiazWorks artwork

The official asset is **`talhaimtiazworks-logo.png`**, the PNG supplied by the project owner in the implementation task. It is preserved **byte-for-byte**, not generated or reconstructed. Its fingerprint and inspection results are in `official-logo.json`.

- Canvas: **1141 × 1141**, square (1:1), RGBA, alpha range 0–255.
- Transparent corners surround the artwork's white circular field. The original includes navy, blue and teal; these are part of the artwork and are **not** recolored to match the interface.
- Never crop, stretch, apply CSS filters, rebuild the mark with vectors, or use a text-only substitute.
- Maintain the entire canvas with `object-fit: contain`, an explicit width/height, and the original 1:1 aspect ratio. The artwork's own neutral field supports both light and dark surfaces.

## Distributed assets

- `talhaimtiazworks-logo.png`: original source.
- `talhaimtiazworks-logo-{160,320,640}.png`: proportional full-canvas derivatives for web, email, loading states and embedded PDFs.
- `icon-{192,512}.png`: full-canvas derivatives for the web manifest.
- The legacy `siteinsight-*.svg` filenames are compatibility aliases embedding the same full-color official PNG. `dark` and `mono` are **filenames retained for compatibility**, not recolored variants.
- The app's PNG/ICO/SVG favicons and social cards are generated from the same official source, without changing it.

Optional maintenance: `python3 scripts/brand/generate.py` (Pillow required). Generated assets are already included: Python/Chromium are **not** application build dependencies. The former rendering/wordmark maintenance entry points delegate to this safe full-canvas packaging script and cannot overwrite the artwork with the retired vector mark.

## Interface palette

`src/lib/design-tokens.json` is the single palette source for CSS, PDF and email. Regenerate CSS with `node scripts/brand/generate-tokens.mjs`; validate with `--check` or `npm run brand:check`.

Deep Maroon `#5D0217` is the primary action/selected-navigation color. Cyan `#03D2D2` supplies progress and selective accents. Ivory, white and champagne provide warm light surfaces; navy and charcoal provide dark surfaces. Accessible light maroon text is used in the dark theme, without altering the primary action color or official logo. Success, warning, danger and information tokens adapt to each theme.

## PDF fonts

PDFs use standard Helvetica/Courier where supported. The locally bundled static TrueType Noto Arabic, SC/KR (CJK) and monochrome Emoji fallbacks in `scripts/brand/fonts/` provide additional glyphs and are embedded only as required. Their individual SIL Open Font License notices ship with the fonts. The original Inter font and license remain for optional social-asset maintenance. These fonts are not required to render the logo itself.

PDF fallback font maintenance: `python3 scripts/brand/prepare-fonts.py` (optional fontTools, network required). To avoid invalid glyph outlines from the old subsetter, required static CJK/emoji fonts are embedded whole; the static Arabic font uses a validated shaping-aware subset; Unicode reports are larger, while Latin-only reports remain compact. Static regular instances and source/output hashes are shipped in `scripts/brand/fonts/provenance.json`; no variable or CFF fallback is used at runtime, because real PDF rendering exposed unreliable subsets in those formats. Font preparation is not part of an application build.
