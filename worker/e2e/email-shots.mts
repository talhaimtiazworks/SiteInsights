/**
 * Screenshots the auth emails exactly as Supabase Auth delivered them (saved by
 * scripts/smoke/email-render.mjs) at phone and desktop widths, and checks the
 * layout: no horizontal overflow, button reachable (≥ 44 px tall), and the
 * brand name still visible when images are blocked.
 *
 *   EMAIL_DIR=/home/user/shots/email OUT_DIR=/home/user/shots/email npx tsx e2e/email-shots.mts
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const EMAIL_DIR = process.env.EMAIL_DIR ?? "/tmp/emails";
const OUT_DIR = process.env.OUT_DIR ?? EMAIL_DIR;
const files = readdirSync(EMAIL_DIR).filter((f) => f.endsWith(".html"));
if (!files.length) throw new Error(`No emails in ${EMAIL_DIR}`);

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !info ? "" : ` — ${info}`}`);
};

const browser = await chromium.launch();
for (const [label, width, height] of [["mobile", 375, 812], ["desktop", 1200, 900]] as const) {
  for (const blockImages of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: label === "mobile" ? 2 : 1 });
    if (blockImages) await ctx.route("**/*.png", (r) => r.abort());
    const page = await ctx.newPage();
    for (const f of files) {
      const key = f.replace(/\.html$/, "");
      await page.goto(`file://${path.join(EMAIL_DIR, f)}`, { waitUntil: "load" });
      const m = await page.evaluate(`(() => {
        const a = [...document.querySelectorAll('a')].find((x) => x.getAttribute('style')?.includes('padding:14px 28px'));
        const r = a ? a.getBoundingClientRect() : null;
        return { scrollW: document.documentElement.scrollWidth, btnH: r ? r.height : null, btnRight: r ? r.right : null, brand: document.body.innerText.includes('SiteInsight') };
      })()`) as { scrollW: number; btnH: number | null; btnRight: number | null; brand: boolean };
      const tag = `${key} @${label}${blockImages ? " (images blocked)" : ""}`;
      check(`${tag}: no horizontal overflow`, m.scrollW <= width, `scrollWidth ${m.scrollW}`);
      if (m.btnH !== null) check(`${tag}: button ≥ 44px tall and on screen`, m.btnH >= 44 && (m.btnRight ?? 0) <= width, `h=${m.btnH} right=${m.btnRight}`);
      check(`${tag}: brand visible`, m.brand);
      if (!blockImages) await page.screenshot({ path: path.join(OUT_DIR, `${key}-${label}.png`), fullPage: true });
      else if (key === "confirmation") await page.screenshot({ path: path.join(OUT_DIR, `${key}-${label}-no-images.png`), fullPage: true });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed. Screenshots in ${OUT_DIR}`);
process.exit(failed ? 1 : 0);
