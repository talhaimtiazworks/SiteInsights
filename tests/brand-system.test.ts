import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import tokens from "@/lib/design-tokens.json";
import { BrandedLoading } from "@/components/branded-loading";
import { LoadingRegion, Skeleton } from "@/components/ui";
import { BRAND } from "@/lib/brand";

const root = process.cwd();
function luminance(hex: string) {
  const rgb = [1, 3, 5].map((n) => parseInt(hex.slice(n, n + 2), 16) / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
const contrast = (a: string, b: string) => { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + .05) / (values[1] + .05); };

describe("official artwork, central palette and loading system", () => {
  it("preserves the supplied logo's exact original fingerprint, canvas and alpha mode", () => {
    const image = readFileSync(path.join(root, "public/brand/talhaimtiazworks-logo.png"));
    const metadata = JSON.parse(readFileSync(path.join(root, "public/brand/official-logo.json"), "utf8"));
    expect(createHash("sha256").update(image).digest("hex")).toBe("ad7e9c8c39e925449fff71b57e7efe89244a8a7ec9da20aa2aada1e24b5b8c50");
    expect(metadata.originalSHA256).toBe(createHash("sha256").update(image).digest("hex"));
    expect([image.readUInt32BE(16), image.readUInt32BE(20), image[25]]).toEqual([1141, 1141, 6]); // PNG RGBA color type
  });

  it("ships valid static TrueType fallbacks and their exact provenance, never unreliable variable/CFF subsets", () => {
    const directory = path.join(root, "scripts/brand/fonts");
    const provenance = JSON.parse(readFileSync(path.join(directory, "provenance.json"), "utf8"));
    expect(provenance.fonts).toHaveLength(4);
    for (const font of provenance.fonts) {
      const bytes = readFileSync(path.join(directory, font.file));
      expect(bytes.readUInt32BE(0)).toBe(0x00010000);
      const tables = Array.from({ length: bytes.readUInt16BE(4) }, (_, i) => bytes.subarray(12 + i * 16, 16 + i * 16).toString());
      expect(tables).not.toContain("fvar");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(font.staticSHA256);
      expect(readFileSync(path.join(directory, font.license), "utf8")).toContain("SIL OPEN FONT LICENSE");
    }
  });

  it("uses the exact requested core palette and synchronized generated CSS", () => {
    // Golden Yellow accent, Deep Blue brand/interactive, Charcoal text, White, plus neutral tints.
    expect(tokens.colors).toMatchObject({ primary: "#0E436B", accent: "#F4B43B", charcoal: "#1B2631", text: "#1B2631", white: "#FFFFFF" });
    expect(Object.keys(tokens.themes)).toEqual(["light"]); // the dark theme was removed
    execFileSync(process.execPath, ["scripts/brand/generate-tokens.mjs", "--check"]);
    const css = readFileSync(path.join(root, "src/app/brand-tokens.css"), "utf8");
    for (const name of ["primary", "accent", "background", "surface", "text", "muted", "border"]) expect(css).toContain(`--color-${name}:`);
  });

  it("keeps text, semantic status text and primary controls at WCAG AA contrast", () => {
    const colors: Record<string, string> = tokens.colors;
    for (const theme of Object.values(tokens.themes)) {
      for (const text of ["foreground", "secondary", "muted-foreground", "primary"] as const) {
        expect(contrast(colors[theme[text]], colors[theme.background]), `${text} on ${theme.background}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors[theme[text]], colors[theme.card]), `${text} on ${theme.card}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const name of ["success", "warning", "danger", "info"] as const) expect(contrast(colors[theme[name]], colors[theme[`${name}-soft`]])).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens.colors.white, tokens.colors.primary)).toBeGreaterThanOrEqual(7);
  });

  it("bundles the product typefaces with OFL licenses and provenance for web and PDF", () => {
    for (const dir of ["src/app/fonts", "scripts/brand/fonts/ui"]) {
      const provenance = JSON.parse(readFileSync(path.join(root, dir, "provenance.json"), "utf8"));
      for (const font of provenance.fonts) {
        const bytes = readFileSync(path.join(root, font.file));
        expect(createHash("sha256").update(bytes).digest("hex"), font.file).toBe(font.sha256);
        expect(readFileSync(path.join(root, dir, font.license), "utf8")).toContain("SIL OPEN FONT LICENSE");
        if (font.file.endsWith(".ttf")) {
          expect(bytes.readUInt32BE(0)).toBe(0x00010000);
          const tables = Array.from({ length: bytes.readUInt16BE(4) }, (_, i) => bytes.subarray(12 + i * 16, 16 + i * 16).toString());
          expect(tables).not.toContain("fvar"); // static instances only in PDFs
        } else expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
      }
    }
    const layout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    for (const f of ["BricolageGrotesque.woff2", "Inter.woff2", "JetBrainsMono.woff2"]) expect(layout).toContain(f);
    expect(layout).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });

  it("renders the supplied image with accessible honest loading status and reduced-motion CSS", () => {
    const markup = renderToStaticMarkup(createElement(BrandedLoading, { label: "Preparing your audit…" }));
    expect(markup).toContain(BRAND.logo);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Preparing your audit…");
    const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
    const ui = readFileSync(path.join(root, "src/components/ui.tsx"), "utf8");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(".brand-loading-track { animation: none !important;");
    expect(css).toContain(".ui-enter { animation: ui-enter");
    expect(css).toContain(".ui-enter { animation: none !important;");
    expect(css).toContain("line-height: 1.55;");
    expect(css).toContain("overflow-wrap: anywhere;");
    expect(ui).toContain("whitespace-normal");
    expect(ui).toContain("motion-safe:hover:-translate-y-px");
  });

  it("uses skeletons instead of a second visible branded loading box", () => {
    const markup = renderToStaticMarkup(createElement(LoadingRegion, { label: "Loading audits" }, createElement(Skeleton, { className: "h-4" })));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Loading audits");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain(BRAND.logo);
  });

  it("has no retired indigo/slate theme colors or fixed legacy hue utilities in active UI styles", () => {
    function walk(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.(tsx?|css)$/.test(entry.name) ? [path.join(dir, entry.name)] : []); }
    for (const file of walk(path.join(root, "src"))) {
      const content = readFileSync(file, "utf8");
      expect(content, file).not.toMatch(/#(?:4f46e5|4338ca|06b6d4|0f172a|090d1a|818cf8|c7d2fe|e2e8f0|f8fafc)\b/i);
      expect(content, file).not.toMatch(/(?:bg|text|border)-(?:slate|indigo|sky|blue|violet|red|emerald|amber)-\d/);
    }
  });
});
