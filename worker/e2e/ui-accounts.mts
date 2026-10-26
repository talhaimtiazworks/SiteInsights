/**
 * Browser UI check of the account + dashboard flows against a running
 * SiteInsight server with Supabase Auth and the local email sink.
 *   cd worker && BASE_URL=http://127.0.0.1:3000 SINK_URL=http://127.0.0.1:2501 npx tsx e2e/ui-accounts.mts
 * Screenshots go to SHOTS_DIR (default /tmp/sitelens-shots).
 */
import { chromium, type Page } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SINK = process.env.SINK_URL ?? "http://127.0.0.1:2501";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/sitelens-shots";
const rnd = Math.random().toString(36).slice(2, 8);
const email = `ui-${rnd}@sitelens.localtest`;
const password = `Ui-${rnd}-Pass1!`;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
const pageErrors: string[] = [];
const currentPages: Page[] = [];

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: (e as Error).message });
    for (const p of currentPages) await p.screenshot({ path: `${SHOTS}/fail-${results.length}.png`, fullPage: true }).catch(() => {});
    console.log(`  ✗ ${name}\n      ${(e as Error).message.split("\n")[0]}`);
    throw e;
  }
}
function watch(page: Page, label: string) {
  currentPages.push(page);
  page.on("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/401|404|Failed to load resource/.test(m.text())) pageErrors.push(`${label} console: ${m.text()}`);
  });
}
async function confirmLink(since: number) {
  for (let i = 0; i < 40; i++) {
    const msgs = (await fetch(`${SINK}/messages`).then((r) => r.json())) as Array<{ to: string[]; html: string; receivedAt: string }>;
    const m = msgs.filter((x) => x.to.join(",").includes(email) && new Date(x.receivedAt).getTime() >= since - 2000).pop();
    const href = m && /href="([^"]*\/auth\/confirm[^"]*)"/.exec(m.html)?.[1];
    if (href) return href.replace(/&amp;/g, "&");
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("confirmation email not received");
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  watch(page, "desktop");
  console.log(`SiteInsight UI accounts check against ${BASE}`);

  await step("landing page shows Sign in (accounts enabled)", async () => {
    await page.goto(BASE + "/");
    await page.getByRole("link", { name: "Sign in" }).first().waitFor({ timeout: 10000 });
  });
  await step("sign-up form validates and sends a confirmation email", async () => {
    await page.goto(BASE + "/sign-up");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByText("Enter a valid email address.").waitFor();
    await page.getByLabel("Name (optional)").fill("Ui Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("checkbox").check();
    await page.screenshot({ path: `${SHOTS}/01-sign-up.png` });
    const since = Date.now();
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 15000 });
    const link = await confirmLink(since);
    await page.goto(link);
    await page.getByRole("button", { name: "Confirm email" }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
    await page.getByRole("heading", { name: /Welcome back, Ui/ }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/02-dashboard-empty.png`, fullPage: true });
  });
  await step("start an audit from the dashboard and open the report", async () => {
    await page.getByRole("textbox", { name: "Website URL" }).fill("https://example.com");
    await page.getByRole("button", { name: "Start audit", exact: true }).click();
    await page.waitForURL(/\/scans\/[0-9a-f-]+\/progress/, { timeout: 20000 });
    // The progress page opens the report automatically when the audit completes.
    await page.waitForURL(/\/scans\/[0-9a-f-]+$/, { timeout: 180000 });
    await page.getByRole("button", { name: "Rename" }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/03-report-owner-actions.png` });
  });
  await step("audits list: search, rename via dialog", async () => {
    await page.goto(BASE + "/dashboard/audits");
    await page.getByRole("table").waitFor({ timeout: 15000 });
    await page.getByRole("searchbox", { name: "Search audits" }).fill("example");
    await page.waitForURL(/q=example/, { timeout: 5000 });
    await page.getByRole("button", { name: /Actions for/ }).first().click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename audit" });
    await dialog.getByRole("textbox").fill("Example homepage");
    await dialog.getByRole("button", { name: "Save name" }).click();
    await page.getByRole("link", { name: "Example homepage" }).waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/04-audits-list.png` });
  });
  await step("dashboard overview shows real stats for the account", async () => {
    await page.goto(BASE + "/dashboard");
    await page.getByText("Total audits").waitFor();
    const total = await page.locator("text=Total audits").locator("..").locator("p").nth(1).innerText();
    if (total.trim() !== "1") throw new Error(`Total audits shows ${total}`);
    await page.screenshot({ path: `${SHOTS}/05-dashboard.png`, fullPage: true });
  });
  await step("account pages load; appearance switches theme and persists", async () => {
    for (const p of ["profile", "security", "connections", "ai", "usage", "organizations", "delete"]) {
      await page.goto(`${BASE}/account/${p}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 15000 });
    }
    await page.goto(BASE + "/account/appearance");
    await page.getByRole("radio", { name: /Dark/ }).check();
    await page.getByText("Saved.").waitFor({ timeout: 10000 });
    if (!(await page.evaluate("document.documentElement.classList.contains('dark')"))) throw new Error("dark class not applied");
    await page.screenshot({ path: `${SHOTS}/06-appearance-dark.png` });
    await page.getByRole("radio", { name: /Light/ }).check();
    await page.getByText("Saved.").waitFor({ timeout: 10000 });
  });

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const m = await mobile.newPage();
  watch(m, "mobile");
  await step("mobile: menu navigation, no horizontal overflow", async () => {
    for (const path of ["/dashboard", "/dashboard/audits", "/dashboard/compare", "/account/profile"]) {
      await m.goto(BASE + path);
      await m.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 15000 });
      const overflow = (await m.evaluate("document.documentElement.scrollWidth - window.innerWidth")) as number;
      if (overflow > 1) throw new Error(`${path} overflows horizontally by ${overflow}px`);
    }
    await m.goto(BASE + "/dashboard");
    await m.getByRole("button", { name: "Open menu" }).click();
    await m.getByRole("navigation", { name: "Mobile" }).getByRole("link", { name: "Audits" }).click();
    await m.waitForURL(/\/dashboard\/audits/);
    await m.getByRole("link", { name: "Example homepage" }).first().waitFor({ timeout: 15000 });
    await m.screenshot({ path: `${SHOTS}/07-mobile-audits.png`, fullPage: true });
    await m.getByRole("button", { name: "Account menu" }).click();
    await m.getByRole("menuitem", { name: "Account settings" }).click();
    await m.waitForURL(/\/account\/profile/);
    await m.getByLabel("Display name").waitFor({ timeout: 15000 });
    await m.screenshot({ path: `${SHOTS}/08-mobile-account.png`, fullPage: true });
  });
  await mobile.close();

  await step("sign out from the account menu; protected pages redirect", async () => {
    await page.goto(BASE + "/dashboard");
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
    await page.goto(BASE + "/dashboard/audits");
    await page.waitForURL(/\/sign-in\?next=%2Fdashboard%2Faudits/);
    await page.screenshot({ path: `${SHOTS}/09-sign-in.png` });
  });
  await step("sign in through the form returns to the requested page", async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/dashboard\/audits/, { timeout: 15000 });
    await page.getByRole("link", { name: "Example homepage" }).waitFor({ timeout: 15000 });
  });
  await step("delete account through the confirmation dialog", async () => {
    await page.goto(BASE + "/account/delete");
    await page.getByRole("button", { name: "Delete my account…" }).click();
    const d = page.getByRole("dialog", { name: "Delete your account?" });
    const confirmBtn = d.getByRole("button", { name: "Delete account permanently" });
    if (await confirmBtn.isEnabled()) throw new Error("confirm enabled before typing email");
    await d.getByRole("textbox").fill(email);
    await confirmBtn.click();
    await page.waitForURL(/\/\?account=deleted/, { timeout: 15000 });
  });
  await step("no uncaught page errors", async () => {
    if (pageErrors.length) throw new Error(pageErrors.slice(0, 5).join(" | "));
  });
} catch {
  /* reported above */
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} UI steps passed`);
  process.exit(failed ? 1 : 0);
}
