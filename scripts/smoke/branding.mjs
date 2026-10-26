#!/usr/bin/env node
/**
 * Browser branding/responsiveness smoke test of a RUNNING local app.
 * Does not configure any external service or fake a production integration.
 * Optional AUDIT_URL runs one real public-site audit with the server's limits.
 * Optional BRAND_FIXTURES_DIR renders offline actual auth-component fixtures;
 * these check appearance only, never sign-in/token delivery.
 * Requires: cd worker && npm ci && npx playwright-core install chromium
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../worker/node_modules/playwright-core/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT = process.env.SHOTS_DIR ?? "/tmp/siteinsight-branding-shots";
const FIXTURES = process.env.BRAND_FIXTURES_DIR;
const pages = ["/", "/about", "/help", "/contact", "/privacy", "/terms", "/dashboard", "/dashboard/audits", "/settings/ai", "/usage", "/audit/new", "/sign-in", "/sign-up", "/forgot-password", "/auth/confirm", "/account/reset-password"];
const result = { routes: [], fixtures: [], assets: [], pageErrors: [], accessibility: [], audit: null };
await mkdir(OUT, { recursive: true });
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ reducedMotion: "reduce", acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (error) => result.pageErrors.push(error.message));
async function noOverflow(label) {
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(layout.scroll <= layout.width + 1, `${label}: horizontal overflow ${JSON.stringify(layout)}`);
}
async function axeCheck(label) {
  await page.addScriptTag({ path: path.join(root, "worker/node_modules/axe-core/axe.min.js") });
  const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })));
  result.accessibility.push({ label, violations });
  assert.equal(violations.filter((v) => ["serious", "critical"].includes(v.impact)).length, 0, `${label}: serious accessibility violations ${JSON.stringify(violations)}`);
}
try {
  for (const width of [1440, 375, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
    for (const route of pages) {
      const response = await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
      assert(response && response.status() < 400, `${route}: HTTP ${response?.status()}`);
      assert((await page.title()).includes("SiteInsights"), `${route}: missing product in page title`);
      const text = await page.locator("body").innerText();
      assert(!/SiteLens AI/.test(text), `${route}: old display brand`);
      assert(text.includes("A TalhaImtiazWorks Product"), `${route}: missing parent attribution`);
      await noOverflow(`${width}px ${route}`);
      result.routes.push({ route, width, status: response.status() });
      if (width !== 320) await page.screenshot({ path: path.join(OUT, `${route === "/" ? "home" : route.slice(1).replaceAll("/", "-")}-${width}.png`), fullPage: true });
    }
  }
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  assert(await page.getByRole("navigation", { name: "Mobile", exact: true }).isVisible(), "mobile navigation does not open");
  await page.getByRole("navigation", { name: "Mobile", exact: true }).getByRole("link", { name: "Help", exact: true }).click();
  await page.waitForURL("**/help");
  assert.equal(await page.getByRole("button", { name: "Open menu", exact: true }).getAttribute("aria-expanded"), "false");
  const animation = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "animate-spin animate-pulse";
    document.body.append(probe);
    const value = getComputedStyle(probe).animationName;
    probe.remove();
    return value;
  });
  assert.equal(animation, "none", "reduced motion still animates busy indicators");
  for (const asset of ["/favicon.ico", "/favicon.svg", "/icon.svg", "/apple-icon.png", "/brand/siteinsight-logo.svg", "/brand/siteinsight-logo-dark.svg", "/brand/siteinsight-logo-mono.svg", "/brand/icon-192.png", "/brand/icon-512.png", "/opengraph-image.png", "/twitter-image.png", "/manifest.webmanifest", "/robots.txt", "/sitemap.xml"]) {
    const response = await context.request.get(`${BASE}${asset}`);
    assert.equal(response.status(), 200, `${asset}: asset missing`);
    assert((await response.body()).length > 0, `${asset}: empty asset`);
    result.assets.push(asset);
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await axeCheck("homepage 375px");
  await page.evaluate(() => localStorage.setItem("sitelens-theme", "dark"));
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.locator("html").evaluate((html) => html.classList.contains("dark")), "existing saved theme key no longer works");
  await page.screenshot({ path: path.join(OUT, "home-dark-375.png"), fullPage: true });
  await axeCheck("homepage dark 375px");
  await page.evaluate(() => localStorage.setItem("sitelens-theme", "light"));

  if (FIXTURES) {
    for (const name of ["sign-in", "sign-up", "forgot-password", "confirm-invalid", "reset-password"]) {
      for (const width of [1440, 375, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.setContent(await readFile(path.join(FIXTURES, `${name}.html`), "utf8"), { waitUntil: "networkidle" });
        assert((await page.locator("body").innerText()).includes("Offline component QA fixture"));
        assert((await page.locator("body").innerText()).includes("A TalhaImtiazWorks Product"));
        await noOverflow(`${name} component fixture ${width}px`);
        if (width !== 320) await page.screenshot({ path: path.join(OUT, `fixture-${name}-${width}.png`), fullPage: true });
        result.fixtures.push({ name, width, scope: "offline actual-component appearance only" });
      }
      await axeCheck(`${name} component fixture 320px`);
    }
  }

  if (process.env.AUDIT_URL) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert(process.env.SMOKE_AUTH_EMAIL && process.env.SMOKE_AUTH_PASSWORD, "AUDIT_URL requires an existing verified test account: privately set SMOKE_AUTH_EMAIL and SMOKE_AUTH_PASSWORD");
    await page.goto(`${BASE}/sign-in?next=%2Faudit%2Fnew`, { waitUntil: "networkidle" });
    await page.locator("#email").fill(process.env.SMOKE_AUTH_EMAIL);
    await page.locator("#password").fill(process.env.SMOKE_AUTH_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${BASE}/audit/new`);
    await page.getByRole("textbox", { name: "Website URL" }).fill(process.env.AUDIT_URL);
    const created = page.waitForResponse((r) => r.url() === `${BASE}/api/scans` && r.request().method() === "POST");
    await page.getByRole("button", { name: "Start audit", exact: true }).click();
    const response = await created;
    const body = await response.json();
    assert.equal(response.status(), 201, `audit creation failed: ${JSON.stringify(body)}`);
    const id = body.data.id;
    await page.waitForURL(`**/scans/${id}/progress`);
    await page.getByRole("progressbar", { name: "Audit progress" }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, "audit-progress-desktop.png"), fullPage: true });
    await page.waitForURL(`**/scans/${id}`, { timeout: 120_000 });
    await page.getByRole("button", { name: "Download JSON", exact: true }).waitFor({ timeout: 15_000 });
    await noOverflow("real audit report desktop");
    await page.screenshot({ path: path.join(OUT, "audit-report-desktop.png"), fullPage: true });
    const results = await (await context.request.get(`${BASE}/api/scans/${id}/results`)).json();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON", exact: true }).click();
    const jsonFile = await downloadPromise;
    assert(jsonFile.suggestedFilename().startsWith("siteinsight-"));
    const json = JSON.parse(await readFile(await jsonFile.path(), "utf8"));
    assert.equal(json.generator, "SiteInsights");
    assert.equal(json.parentBrand, "TalhaImtiazWorks");
    const pdfDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF", exact: true }).click();
    const pdfFile = await pdfDownloadPromise;
    assert(pdfFile.suggestedFilename().startsWith("siteinsight-"));
    assert((await readFile(await pdfFile.path())).subarray(0, 5).toString() === "%PDF-");
    await page.setViewportSize({ width: 375, height: 900 });
    await noOverflow("real audit report mobile");
    await page.screenshot({ path: path.join(OUT, "audit-report-mobile.png"), fullPage: true });
    await page.goto(`${BASE}/dashboard/audits`, { waitUntil: "networkidle" });
    assert((await page.locator("body").innerText()).includes(new URL(process.env.AUDIT_URL).hostname));
    result.audit = { target: process.env.AUDIT_URL, id, status: results.data.scan.status, pages: results.data.scan.summary?.pagesScanned, json: jsonFile.suggestedFilename(), pdf: pdfFile.suggestedFilename(), scope: "local self-hosted temporary storage; not production database persistence" };
  }
  assert.equal(result.pageErrors.length, 0, `browser page errors: ${result.pageErrors.join("; ")}`);
  console.log(`PASS: ${result.routes.length} route/viewport checks, ${result.fixtures.length} offline component/viewport checks, ${result.assets.length} assets, ${result.accessibility.length} axe checks, mobile navigation, existing theme preference, reduced motion, zero page errors.`);
  if (result.audit) console.log(`PASS: real anonymous audit ${result.audit.status}; ${result.audit.pages} pages; JSON/PDF download names and parent attribution.`);
} finally {
  await writeFile(path.join(OUT, "branding-smoke-results.json"), JSON.stringify(result, null, 2) + "\n");
  await browser.close();
}
