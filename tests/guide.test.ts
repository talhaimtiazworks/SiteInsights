import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PUBLIC_PATHS } from "@/lib/config/metadata";
import GuidePage from "@/app/guide/page";
import { NicheComparison } from "@/app/guide/visuals";
import { GUIDE_TOC, FINAL_CHECKLIST, WEAKNESSES, NICHES } from "@/app/guide/data";

const root = process.cwd();

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);


describe("guide layout — mobile blank-gutter regression", () => {
  it("every sr-only annotation inside the wide niche table is confined to a positioned cell", () => {
    // Regression: `.sr-only` is absolutely positioned with no offsets, so its static
    // position used to land ~x≈610px inside the 42rem-min-width scrolling table. The
    // table's overflow-x:auto is NOT in those spans' containing-block chain, so it never
    // clipped them — the document scrollable overflow grew to ~611px and mobile browsers
    // shrank/guttered the whole page. Anchoring each such cell with `relative` confines
    // the 1px box to the scrolled content. Verified live: scrollWidth==viewport at
    // 320–430px after adding `relative`; any future sr-only placed inside this table
    // without a positioned ancestor would reopen the bug.
    const html = render(createElement(NicheComparison));
    const cells = html.match(/<td class="relative;[^"]*"[^>]*><span class="sr-only"/g) ?? [];
    expect(html).toContain('class="relative py-2.5 pl-3 pr-1"');
    expect(cells.length).toBe(0); // belt & braces against ordering drift; the structural assertions below are authoritative
    const cellsRe = /<td class="relative py-2\.5 pl-3 pr-1">\s*<span class="sr-only">/g;
    const fixed = html.match(cellsRe) ?? [];
    expect(fixed.length).toBe(NICHES.length * 5);
  });

  it("no screen-reader-only element inside a scrollable guide table sits in an unpositioned cell", () => {
    const html = render(createElement(NicheComparison));
    const tdWithSrOnly = html.match(/<td class="([^"]*)"><span class="sr-only"/g) ?? [];
    for (const m of tdWithSrOnly) {
      const cls = m.match(/<td class="([^"]*)"/)![1];
      expect(cls.split(/\s+/)).toContain("relative");
    }
  });
});

describe("guide page", () => {
  it("renders all 15 sections with the toc-declared ids, in order", () => {
    const html = render(createElement(GuidePage));
    let lastIdx = -1;
    for (const entry of GUIDE_TOC) {
      const idx = html.indexOf(`id="${entry.id}"`);
      expect(idx, `section #${entry.id}`).toBeGreaterThan(lastIdx);
      expect(html).toContain(`href="#${entry.id}"`);
      lastIdx = idx;
    }
    // Table of contents has exactly the 15 section anchors.
    const tocLinks = html.match(/href="#[a-z-]+"/g) ?? [];
    const tocIds = new Set(GUIDE_TOC.map((t) => `#${t.id}`));
    for (const link of tocLinks) expect(tocIds.has(link.slice(6, -1)), `toc link ${link} resolves to a section`).toBe(true);
  });

  it("is public and flows into the sitemap, /ebooks does not", () => {
    expect(PUBLIC_PATHS).toContain("/guide");
    expect(PUBLIC_PATHS).not.toContain("/ebooks");
    const text = readFileSync(path.join(root, "src/app/sitemap.ts"), "utf8");
    expect(text).not.toMatch(/["'`]\/ebooks["'`]/);
    expect(text).toContain("PUBLIC_PATHS");
  });

  it("marks illustrative ratings as illustrative", () => {
    const html = render(createElement(GuidePage));
    expect(html.toLowerCase()).toContain("illustrative");
  });

  it("copy controls and the checklist are wired to real behavior", () => {
    const interactive = readFileSync(path.join(root, "src/app/guide/interactive.tsx"), "utf8");
    expect(interactive).toContain("clipboard"); // Clipboard API
    expect(interactive).toContain("execCommand"); // fallback path
    expect(interactive).toContain("localStorage"); // checklist persistence, stated as this-browser
    const html = render(createElement(GuidePage));
    expect(html).toContain("saved in this browser");
  });

  it("covers the required content: weaknesses, scripts, emails, pipeline, plan, checklist", () => {
    expect(WEAKNESSES.length).toBe(12);
    expect(FINAL_CHECKLIST.length).toBe(12);
    const guideSrc = ["data.ts", "sections.tsx", "page.tsx"].map((f) => readFileSync(path.join(root, "src/app/guide", f), "utf8")).join("\n");
    expect(guideSrc).toContain("/audit/new");
    expect(guideSrc).toContain("/dashboard/prospects");
    expect(guideSrc).toContain("Client report links");
  });
});

describe("ebook removal", () => {
  it("ebooks directory trees are gone", () => {
    for (const gone of [
      "src/app/ebooks", "src/app/api/ebooks", "src/components/ebooks", "src/lib/ebooks",
      "public/ebooks", "storage/ebooks", "assets/ebooks",
    ]) {
      expect(existsSync(path.join(root, gone)), gone).toBe(false);
    }
    // Nothing anywhere in the repo (excluding build/dependency caches) keeps an ebook filename.
    let find: string;
    try {
      find = execFileSync(
        "find", [".", "-path", "./node_modules", "-prune", "-o", "-path", "./.next", "-prune", "-o", "-path", "./.git", "-prune", "-o", "-iname", "*ebook*", "-print"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      find = "";
    }
    expect(find.split("\n").filter(Boolean), "files with 'ebook' in the path").toEqual([]);
  });

  it("no source file references ebook modules or /ebooks links (except explicit absence pins)", () => {
    // "ebook" not preceded by a letter — excludes facebook-style false positives.
    let hits: string[] = [];
    try {
      hits = execFileSync(
        "grep", ["-rliE", "(^|[^a-zA-Z])ebook", "src", "docs", "config", "db", "public", "--include=*.ts", "--include=*.tsx", "--include=*.md", "--include=*.txt", "--include=*.css", "--include=*.sql"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim().split("\n").filter(Boolean).map((f) => path.relative(root, f));
    } catch {
      hits = []; // grep exit 1 = zero matches
    }
    const allowed = new Set([
      // Intentional absence-pins in tests keep the removal regression-proof.
      "tests/product-ui.test.ts",
      "tests/guide.test.ts",
      "tests/session-refresh.test.ts",
    ]);
    for (const f of hits.filter((f) => !f.startsWith("tests/"))) {
      expect(allowed.has(f), `${f} still references ebooks — remove or justify`).toBe(true);
    }
  });

  it("page-level sources contain no /ebooks hrefs", () => {
    const offenders = walk(path.join(root, "src"))
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .filter((f) => /href=["'`{]/s.test(readFileSync(f, "utf8")) && /\/ebooks/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("env/config docs no longer document ebook settings", () => {
    const env = readFileSync(path.join(root, "config/environment.example.txt"), "utf8");
    expect(env).not.toMatch(/EBOOKS_/i);
    const docs = readFileSync(path.join(root, "docs/ENVIRONMENT.md"), "utf8");
    expect(docs).not.toMatch(/ebook/i);
  });
});
