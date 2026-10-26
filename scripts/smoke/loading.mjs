/** Real pending-request/keyboard regressions. Disposable LOOPBACK services only.
 * Requires TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_ROLE_KEY and a production
 * app configured for that isolated provider. Creates/deletes one real test user.
 * Network holds exist only in this QA script, never in application code.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import playwright from "../../worker/node_modules/playwright-core/index.js";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const AUTH = process.env.TEST_SUPABASE_URL;
const KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
assert(AUTH && KEY, "Configure the disposable local Supabase test URL/admin key privately");
for (const value of [BASE, AUTH]) assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname), "This creates/deletes a user: loopback services only");
const OUT = process.env.SHOTS_DIR ?? "/tmp/siteinsights-loading-check";
await mkdir(OUT, { recursive: true });
const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const admin = AUTH + "/auth/v1/admin/users";
const email = `loading-${randomUUID()}@sitelens.localtest`, password = `Verification-${randomUUID()}-Aa1!`;
const created = await fetch(admin, { method: "POST", headers, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: "Loading Verification" } }) });
assert(created.ok, `Local test account creation failed: ${created.status}`);
const account = await created.json(), id = account.id ?? account.user?.id;
assert(id);
const browser = await playwright.chromium.launch({ headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] }).catch(async (error) => {
  await fetch(admin + "/" + id, { method: "DELETE", headers });
  throw error;
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), results = [], errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function step(name, action) {
  await action(); results.push({ name, ok: true }); console.log("PASS", name);
}
async function heldPage(route, pattern, label, finished) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const intercept = async (request) => { await held; await request.continue(); };
  await page.route(pattern, intercept);
  try {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
    const loading = page.locator(".branded-loading").filter({ hasText: label }).first();
    await loading.waitFor();
    assert.equal(await loading.locator("img").getAttribute("src"), "/brand/talhaimtiazworks-logo-320.png");
    await page.screenshot({ path: path.join(OUT, label.toLowerCase().replaceAll(" ", "-") + ".png"), fullPage: false });
    release();
    await page.getByText(finished, { exact: true }).first().waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator(".branded-loading").filter({ hasText: label }).count(), 0);
  } finally { release(); await page.unroute(pattern, intercept); }
}
try {
  const login = await context.request.post(BASE + "/api/auth/sign-in", { headers: { origin: BASE }, data: { email, password, next: "/dashboard" } });
  assert.equal(login.status(), 200);
  await step("real history loading ends in the actual empty account state", () => heldPage("/dashboard/audits", "**/api/audits?*", "Loading audits", "No audits yet"));
  await step("real dashboard pending data has branded feedback and clean completion", () => heldPage("/dashboard", "**/api/dashboard", "Loading statistics", "No open issues"));
  const missing = randomUUID();
  await step("real report loading clears into an honest server 404 error", () => heldPage(`/scans/${missing}`, `**/api/scans/${missing}/results`, "Loading report", "Audit not found"));
  await step("keyboard skip link has visible focus and mobile navigation works without a mouse", async () => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => { const e = document.activeElement, b = e.getBoundingClientRect(), s = getComputedStyle(e); return { text: e.textContent.trim(), width: b.width, height: b.height, outline: s.outlineStyle, shadow: s.boxShadow }; });
    assert.equal(focused.text, "Skip to content"); assert(focused.width > 100 && focused.height > 24); assert(focused.outline !== "none" || focused.shadow !== "none");
    const menu = page.getByRole("button", { name: "Open menu", exact: true });
    await menu.focus(); await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("button", { name: "Close menu", exact: true }).getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.textContent), "Dashboard");
    await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.textContent), "Audits");
    await page.keyboard.press("Enter"); await page.waitForURL(BASE + "/dashboard/audits");
    await page.getByRole("button", { name: "Open menu", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  });
  await step("genuinely pending route navigation shows feedback and clears on arrival", async () => {
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const navigation = await fresh.newPage();
    let release, intercepted = false;
    const held = new Promise((resolve) => { release = resolve; });
    try {
      await navigation.goto(BASE, { waitUntil: "networkidle" });
      await navigation.route("**/contact*", async (route) => { intercepted = true; await held; await route.continue(); });
      await navigation.getByRole("link", { name: "Contact", exact: true }).click();
      const loading = navigation.locator(".branded-loading").filter({ hasText: "Loading your workspace" });
      await loading.waitFor({ timeout: 5000 });
      assert(intercepted, "A real pending route request is required, not a fake spinner event");
      assert.equal(await loading.locator("img").getAttribute("src"), "/brand/talhaimtiazworks-logo-320.png");
      await navigation.screenshot({ path: path.join(OUT, "route-loading.png"), fullPage: false });
      release(); await navigation.waitForURL(BASE + "/contact");
      // SPA URL commitment precedes passive-effect cleanup; wait for the actual ready UI.
      await loading.waitFor({ state: "detached", timeout: 3000 });
      await navigation.waitForLoadState("networkidle");
      assert.equal(await navigation.locator(".branded-loading").count(), 0);
    } finally { release(); await fresh.close(); }
  });
  assert.equal(errors.length, 0);
} catch (error) { results.push({ name: "loading/keyboard acceptance", ok: false, error: error.message }); console.error(error.message); process.exitCode = 1; }
finally {
  try {
    const deleted = await context.request.delete(BASE + "/api/account", { headers: { origin: BASE }, data: { confirmEmail: email } });
    if (deleted.status() !== 200) { await fetch(admin + "/" + id, { method: "DELETE", headers }); throw new Error("Local diagnostic account required admin cleanup"); }
    results.push({ name: "delete isolated loading test account", ok: true });
  } catch (error) { results.push({ name: "cleanup", ok: false, error: error.message }); process.exitCode = 1; }
  await writeFile(path.join(OUT, "loading-results.json"), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
