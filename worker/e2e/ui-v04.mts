/**
 * Browser checks for the v0.4 auth-link, audit-start and loading behaviour
 * against a running SiteInsight server + Supabase Auth + the local email sink.
 *
 *   cd worker && BASE_URL=http://127.0.0.1:3000 SINK_URL=http://127.0.0.1:2501 SHOTS_DIR=/home/user/shots/v04 npx tsx e2e/ui-v04.mts
 *
 * Everything runs against the real server and database except ONE step that
 * injects a single 503 response in the browser (marked "injected") to exercise
 * the client's retry path; the retried request goes to the real server.
 */
import { mkdirSync } from "node:fs";
import { chromium, type Page, type Request } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SINK = process.env.SINK_URL ?? "http://127.0.0.1:2501";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/sitelens-shots-v04";
mkdirSync(SHOTS, { recursive: true });
const rnd = Math.random().toString(36).slice(2, 8);
const email = `v04-${rnd}@sitelens.localtest`;
const password = `V04-${rnd}-Pass1!`;
const results: Array<{ name: string; ok: boolean }> = [];
const pageErrors: string[] = [];
const pages: Page[] = [];

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    for (const p of pages) await p.screenshot({ path: `${SHOTS}/fail-${results.length}.png`, fullPage: true }).catch(() => {});
    console.log(`  ✗ ${name}\n      ${(e as Error).message.split("\n")[0]}`);
  }
}
function watch(page: Page, label: string) {
  pages.push(page);
  page.on("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`));
}
async function emailLink(since: number) {
  for (let i = 0; i < 40; i++) {
    const msgs = (await fetch(`${SINK}/messages`).then((r) => r.json())) as Array<{ to: string[]; html: string; receivedAt: string }>;
    const m = msgs.filter((x) => x.to.join(",").includes(email) && new Date(x.receivedAt).getTime() >= since - 2000).pop();
    const href = m && /href="([^"]*\/auth\/confirm[^"]*)"/.exec(m.html)?.[1];
    if (href) return href.replace(/&amp;/g, "&");
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("email not received");
}
const assert = (ok: unknown, msg: string) => {
  if (!ok) throw new Error(msg);
};
const overflow = (page: Page) => page.evaluate("document.documentElement.scrollWidth - window.innerWidth") as Promise<number>;

console.log(`SiteInsight v0.4 UI checks against ${BASE}`);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
watch(page, "desktop");
let confirmUrl = "";
let reportUrl = "";

await step("sign up → branded email link → click-to-confirm → dashboard", async () => {
  await page.goto(BASE + "/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("checkbox").check();
  const since = Date.now();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 15000 });
  confirmUrl = await emailLink(since);
  assert(confirmUrl.startsWith(`${BASE}/auth/confirm?`), "email link does not point at this app");
  await page.goto(confirmUrl);
  await page.screenshot({ path: `${SHOTS}/01-confirm-page.png` });
  await page.getByRole("button", { name: "Confirm email" }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 15000 });
});

await step("re-opening the used link shows the branded invalid/expired message; token not shown or leaked via Referer", async () => {
  const other = await browser.newContext();
  const p = await other.newPage();
  watch(p, "reuse");
  await p.goto(confirmUrl);
  await p.getByRole("button", { name: "Confirm email" }).click();
  await p.getByText(/invalid or has expired/i).waitFor({ timeout: 10000 });
  await p.getByRole("link", { name: /sign in/i }).first().waitFor();
  // The token is in the visitor's own address bar (the page must POST it); it must not be shown as text
  // or sent to other sites in the Referer header.
  const token = new URL(confirmUrl).searchParams.get("token_hash")!;
  assert(!(await p.evaluate("document.body.innerText")).toString().includes(token), "token hash is shown on the page");
  const res = await p.request.get(confirmUrl, { maxRedirects: 0 });
  const policy = res.headers()["referrer-policy"] ?? "";
  assert(/no-referrer|same-origin|strict-origin/.test(policy), `Referrer-Policy on /auth/confirm is "${policy}"`);
  await p.screenshot({ path: `${SHOTS}/02-used-link.png` });
  await other.close();
});

await step("Supabase error fragment (#error_code=otp_expired) → sign-in with a clear message", async () => {
  const other = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p = await other.newPage();
  watch(p, "fragment");
  await p.goto(`${BASE}/?next=%2F%2Fevil.example#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
  await p.waitForURL(/\/sign-in\?error=otp_expired$/, { timeout: 10000 });
  await p.getByText("This link is invalid or has expired. Request a new one.").waitFor();
  assert((await overflow(p)) <= 0, "sign-in overflows on mobile");
  await p.screenshot({ path: `${SHOTS}/03-expired-link-mobile.png` });
  await other.close();
});

await step("Start audit: double submit sends one request; button disabled with a status announcement", async () => {
  await page.goto(BASE + "/dashboard");
  const posts: Request[] = [];
  const onReq = (r: Request) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/scans") posts.push(r);
  };
  page.on("request", onReq);
  // Hold the (real) request briefly so the busy state is observable.
  await page.route("**/api/scans", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.getByRole("textbox", { name: "Website URL" }).fill("https://example.com/?v04=double");
  const input = page.getByRole("textbox", { name: "Website URL" });
  await input.press("Enter");
  await input.press("Enter").catch(() => {});
  await page.getByRole("button", { name: "Starting…" }).waitFor({ timeout: 3000 });
  assert(await page.getByRole("button", { name: "Starting…" }).isDisabled(), "submit button not disabled while starting");
  assert((await page.getByRole("status").filter({ hasText: "Starting your audit…" }).count()) === 1, "no status announcement");
  await page.waitForURL(/\/scans\/[0-9a-f-]+\/progress/, { timeout: 20000 });
  page.off("request", onReq);
  await page.unroute("**/api/scans");
  assert(posts.length === 1, `expected 1 POST /api/scans, saw ${posts.length}`);
});

await step("progress page: real phases, percentage, accessible status; opens the report when done", async () => {
  await page.getByRole("progressbar", { name: "Audit progress" }).waitFor({ timeout: 10000 });
  const live = page.locator('p[role="status"][aria-live="polite"]');
  assert((await live.count()) >= 1, "no live status region on the progress page");
  await page.screenshot({ path: `${SHOTS}/04-progress-desktop.png` });
  await page.waitForURL(/\/scans\/[0-9a-f-]+$/, { timeout: 180000 });
  await page.getByRole("button", { name: "Rename" }).waitFor({ timeout: 15000 });
  reportUrl = page.url();
  await page.screenshot({ path: `${SHOTS}/05-report.png` });
});

await step("transient failure (injected 503) → 'Try again' reuses the idempotency key → one audit", async () => {
  await page.goto(BASE + "/dashboard");
  const keys: string[] = [];
  let failNext = true;
  await page.route("**/api/scans", async (route) => {
    const r = route.request();
    if (r.method() !== "POST") return route.continue();
    keys.push(r.headers()["idempotency-key"] ?? "");
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, contentType: "application/json", headers: { "retry-after": "1" }, body: JSON.stringify({ error: { code: "database_busy", message: "The database is busy right now. Please try again in a moment.", retryable: true } }) });
    }
    return route.continue();
  });
  await page.getByRole("textbox", { name: "Website URL" }).fill("https://example.com/?v04=retry");
  await page.getByRole("button", { name: "Start audit", exact: true }).click();
  await page.getByText("The database is busy right now").waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/06-retryable-error.png` });
  const retry = page.getByRole("button", { name: "Try again" });
  await retry.click();
  await page.waitForURL(/\/scans\/[0-9a-f-]+\/progress/, { timeout: 20000 });
  await page.unroute("**/api/scans");
  assert(keys.length === 2 && keys[0] && keys[0] === keys[1], `retry used a different idempotency key (${keys.length} requests)`);
  // The server also replays: the same key returns the same audit instead of creating another.
  const id = /\/scans\/([0-9a-f-]+)\/progress/.exec(page.url())![1];
  const replay = (await page.evaluate(`fetch('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': ${JSON.stringify(keys[0])} }, body: JSON.stringify({ url: 'https://example.com/?v04=retry' }) }).then((r) => r.json()).then((b) => b.data ?? {})`)) as { id?: string };
  assert(replay.id === id, "server did not replay the same audit for the same idempotency key");
  await page.waitForURL(/\/scans\/[0-9a-f-]+$/, { timeout: 180000 });
});

await step("rejected input (4xx) shows the message without a 'Try again' button", async () => {
  await page.goto(BASE + "/dashboard");
  await page.getByRole("textbox", { name: "Website URL" }).fill("http://127.0.0.1/");
  await page.getByRole("button", { name: "Start audit", exact: true }).click();
  await page.locator("#url-error").waitFor({ timeout: 10000 });
  assert((await page.getByRole("button", { name: "Try again" }).count()) === 0, "a rejected URL offers 'Try again'");
  assert(await page.getByRole("button", { name: "Start audit", exact: true }).isEnabled(), "form stayed disabled after an error");
});

await step("route transition shows the branded progress bar on a slow navigation, then removes it", async () => {
  await page.goto(BASE + "/dashboard");
  await page.route("**/dashboard/audits**", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.getByRole("link", { name: /^Audits$|^All audits$|View all/ }).first().click();
  await page.getByRole("progressbar", { name: "Loading page" }).waitFor({ timeout: 3000 });
  await page.screenshot({ path: `${SHOTS}/07-nav-progress.png` });
  await page.waitForURL(/\/dashboard\/audits/, { timeout: 15000 });
  await page.unroute("**/dashboard/audits**");
  await page.getByRole("progressbar", { name: "Loading page" }).waitFor({ state: "detached", timeout: 5000 });
});

await step("prefers-reduced-motion: spinners slow down, transitions and the sliding bar stop", async () => {
  const rm = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 812 }, storageState: await ctx.storageState() });
  const p = await rm.newPage();
  watch(p, "reduced-motion");
  await p.goto(BASE + "/dashboard");
  const m = (await p.evaluate(`(() => {
    const s = document.createElement('div'); s.className = 'animate-spin'; document.body.appendChild(s);
    const b = document.createElement('div'); b.className = 'nav-progress-bar'; document.body.appendChild(b);
    const k = document.createElement('div'); k.className = 'transition-all duration-500'; document.body.appendChild(k);
    return { spin: getComputedStyle(s).animationDuration, bar: getComputedStyle(b).animationName, trans: getComputedStyle(k).transitionDuration };
  })()`)) as { spin: string; bar: string; trans: string };
  assert(m.spin === "2.4s", `spinner duration ${m.spin}`);
  assert(m.bar === "none", `nav bar animation ${m.bar}`);
  assert(parseFloat(m.trans) < 0.001, `transition ${m.trans}`);
  await rm.close();
});

await step("mobile layout: home, dashboard, audits, report, issue, progress and account fit a 375px screen", async () => {
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, storageState: await ctx.storageState() });
  const p = await mob.newPage();
  watch(p, "mobile");
  const report = reportUrl.replace(BASE, "");
  await p.goto(BASE + report);
  const issue = await p.locator('a[href*="/issues/"]').first().getAttribute("href").catch(() => null);
  const targets: Array<[string, string]> = [["/", "08-home-mobile"], ["/dashboard", "09-dashboard-mobile"], ["/dashboard/audits", "10-audits-mobile"], [report, "11-report-mobile"], [`${report}/progress`, "12-progress-done-mobile"], ["/account/security", "13-security-mobile"]];
  if (issue) targets.push([issue, "14-issue-mobile"]);
  // Every other page: overflow check only (no screenshot).
  for (const path of ["/account/profile", "/account/connections", "/account/ai", "/account/usage", "/account/organizations", "/account/appearance", "/account/delete", "/usage", "/settings/ai", "/dashboard/compare", "/audit/new", "/help", "/privacy", "/terms", "/contact"]) targets.push([path, ""]);
  const bad: string[] = [];
  for (const [path, shot] of targets) {
    await p.goto(BASE + path);
    await p.waitForLoadState("networkidle");
    const o = await overflow(p);
    if (o > 0) bad.push(`${path} (+${o}px)`);
    if (shot) await p.screenshot({ path: `${SHOTS}/${shot}.png`, fullPage: true });
  }
  // Signed-out pages
  const out = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const q = await out.newPage();
  for (const path of ["/sign-in", "/sign-up", "/forgot-password", "/sign-in/sso"]) {
    await q.goto(BASE + path);
    await q.waitForLoadState("networkidle");
    const o = await overflow(q);
    if (o > 0) bad.push(`${path} (+${o}px)`);
  }
  await out.close();
  assert(bad.length === 0, `horizontal overflow at 375px: ${bad.join(", ")}`);
  await mob.close();
});

await browser.close();
const failed = results.filter((r) => !r.ok).length;
if (pageErrors.length) console.log(`\nPage errors:\n  ${pageErrors.join("\n  ")}`);
console.log(`\n${results.length - failed}/${results.length} steps passed${pageErrors.length ? `, ${pageErrors.length} page errors` : ""}`);
process.exit(failed || pageErrors.length ? 1 : 0);
