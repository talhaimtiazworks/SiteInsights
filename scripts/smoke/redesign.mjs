#!/usr/bin/env node
/**
 * Real local production-UI acceptance: Supabase Auth + PostgreSQL, Chromium,
 * captured (never externally delivered) confirmation mail, an explicitly
 * submitted public-site audit, PDF download, ownership, expiry and loading.
 * Uses existing worker dev dependencies. NEVER point this at production.
 * BASE_URL / SINK_URL must both be loopback. Optional AUDIT_URL must be a site
 * you are permitted to audit. TEST_SUPABASE_JWT_SECRET is optional and private.
 * No session state, passwords, email links or keys are written to results.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../worker/node_modules/playwright-core/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SINK = process.env.SINK_URL ?? "http://127.0.0.1:2501";
for (const url of [BASE, SINK]) assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "This creates/deletes test accounts: loopback services only.");
const OUT = process.env.SHOTS_DIR ?? "/tmp/siteinsights-redesign-check";
const PDF = process.env.PDF_OUTPUT ?? path.join(OUT, "real-audit-report.pdf");
const TARGET = process.env.AUDIT_URL ?? "https://example.com/";
const result = { steps: [], accessibility: [], layouts: [], pageErrors: [], expiry: "not configured", audit: null };
await mkdir(OUT, { recursive: true });
const axe = await readFile(path.join(root, "worker/node_modules/axe-core/axe.min.js"), "utf8");
const browser = await playwright.chromium.launch({ headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (error) => result.pageErrors.push(error.message));
const users = [];
let submissions = 0;
page.on("request", (request) => { if (request.url() === `${BASE}/api/scans` && request.method() === "POST") submissions++; });
async function step(name, action) {
  const started = Date.now();
  try { await action(); result.steps.push({ name, ok: true, ms: Date.now() - started }); console.log(`PASS ${name}`); }
  catch (error) { result.steps.push({ name, ok: false, error: error.message }); throw error; }
}
async function api(ctx, method, route, data, headers = {}) {
  return ctx.request.fetch(BASE + route, { method, ...(data === undefined ? {} : { data }), headers: { origin: BASE, ...headers }, maxRedirects: 0 });
}
async function emailToken(email) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const messages = await fetch(`${SINK}/messages`).then((response) => response.json());
    const message = [...(messages.messages ?? messages)].reverse().find((item) => item.to?.includes(email) && /confirm/i.test(item.subject));
    if (message) {
      const match = /\/auth\/confirm\?token_hash=([A-Za-z0-9_-]+)&(?:amp;)?type=([a-z_]+)(?:&(?:amp;)?next=([^"'\s<]*))?/.exec(message.html.replace(/&amp;/g, "&"));
      assert(match, "Local captured confirmation message lacks a confirm link");
      assert(message.html.includes("talhaimtiazworks-logo"), "Captured confirmation message lacks the official logo");
      return { token_hash: match[1], type: match[2], next: match[3] ? decodeURIComponent(match[3]) : undefined };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No confirmation message reached the local SMTP sink");
}
function newUser(ctx) { const value = { ctx, email: `ui-${randomUUID().slice(0, 10)}@sitelens.localtest`, password: `Verification-${randomUUID()}-Aa1!` }; users.push(value); return value; }
async function checkUi(label) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  result.layouts.push({ label, ...dimensions });
  assert(dimensions.scroll <= dimensions.width + 1, `${label}: page-level horizontal overflow`);
  await page.addScriptTag({ content: axe });
  const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.map((node) => ({ target: node.target, html: node.html, summary: node.failureSummary })) })));
  result.accessibility.push({ label, violations });
  // Collect every screen's evidence; assert the full matrix at the end instead of hiding later defects.

}
async function signInUi(user, destination) {
  await page.goto(`${BASE}/sign-in?next=${encodeURIComponent(destination)}`, { waitUntil: "networkidle" });
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${BASE}${destination}`, { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
}
let scanId, findingId;
try {
  await step("anonymous direct initiation, execution, rerun, data and export APIs refuse access", async () => {
    const id = randomUUID();
    for (const [method, route, data] of [["POST", "/api/scans", { url: TARGET }], ["POST", `/api/scans/${id}/advance`, {}], ["POST", `/api/scans/${id}/rerun`, {}], ["GET", "/api/scans"], ["GET", "/api/audits"], ["GET", "/api/dashboard"], ["GET", `/api/scans/${id}`], ["GET", `/api/scans/${id}/results`], ["GET", `/api/scans/${id}/report.pdf`], ["POST", "/api/internal/process", { scanId: id }]]) assert.equal((await api(context, method, route, data)).status(), 401, route);
    for (const route of ["/audit/new", `/scans/${id}/progress`, "/dashboard/audits", "/settings/ai"]) {
      const response = await api(context, "GET", route);
      if (response.status() === 307) assert(response.headers().location?.startsWith("/sign-in?next="));
      else {
        // Next's loading boundaries can stream the SERVER redirect in a 200 document.
        const html = await response.text();
        assert.equal(response.status(), 200, route);
        assert(html.includes('id="__next-page-redirect"') && html.includes("/sign-in?next="), "Protected page lacks its server-rendered redirect");
        assert(!html.includes('id="site-url"'), "Protected audit form must not render for signed-out visitors");
      }
    }
  });
  await step("real pending session state uses the official logo and honors reduced motion", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/auth/session", async (route) => { await held; await route.continue(); });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const loading = page.locator('.branded-loading').filter({ hasText: "Verifying your session" });
    await loading.waitFor();
    assert.equal(await loading.locator("img").getAttribute("src"), "/brand/talhaimtiazworks-logo-320.png");
    assert.equal(await loading.locator(".brand-loading-track").evaluate((element) => getComputedStyle(element).animationName), "none");
    await page.screenshot({ path: path.join(OUT, "session-loading-reduced-motion.png"), fullPage: true });
    release();
    await page.getByRole("link", { name: "Sign in to start", exact: true }).waitFor();
    await page.unroute("**/api/auth/session");
    assert.equal(await loading.count(), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
  });
  await step("auth failure clears branded busy state and duplicate submits stay blocked", async () => {
    await page.goto(BASE + "/sign-in", { waitUntil: "networkidle" });
    let release, calls = 0;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/auth/sign-in", async (route) => { calls++; await held; await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "invalid_credentials", message: "Incorrect email or password." } }) }); });
    await page.getByLabel("Email", { exact: true }).fill("test-invalid@sitelens.localtest");
    await page.locator("#password").fill("test-incorrect-password");
    await page.locator('button[type="submit"]').click();
    await page.locator('.branded-loading').filter({ hasText: "Signing you in securely" }).waitFor();
    assert(await page.locator('button[type="submit"]').isDisabled());
    await page.locator("form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
    assert.equal(calls, 1);
    release();
    await page.getByText("Incorrect email or password.", { exact: true }).waitFor();
    assert(await page.locator('button[type="submit"]').isEnabled());
    assert.equal(await page.locator('.branded-loading').count(), 0);
    await page.unroute("**/api/auth/sign-in");
  });
  const userA = newUser(context);
  await step("real signup, captured confirmation and explicit confirmation preserve return destination", async () => {
    await page.goto(BASE + "/sign-up?next=%2Faudit%2Fnew", { waitUntil: "networkidle" });
    await page.locator("#name").fill("Verification User");
    await page.locator("#email").fill(userA.email);
    await page.locator("#password").fill(userA.password);
    await page.locator("#confirm").fill(userA.password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.getByRole("heading", { name: "Check your email", exact: true }).waitFor();
    const early = await api(context, "POST", "/api/auth/sign-in", { email: userA.email, password: userA.password });
    assert.equal(early.status(), 403);
    assert.equal((await early.json()).error.code, "email_not_confirmed");
    const token = await emailToken(userA.email);
    const params = new URLSearchParams(token);
    await page.goto(`${BASE}/auth/confirm?${params}`, { waitUntil: "networkidle" });
    assert.equal((await (await api(context, "GET", "/api/auth/session")).json()).data.status, "anonymous");
    await page.getByRole("button", { name: "Confirm email", exact: true }).click();
    await page.waitForURL(BASE + "/audit/new");
    await page.getByRole("textbox", { name: "Website URL", exact: true }).waitFor();
    assert.equal(submissions, 0, "Login must never replay an audit");
    const cookies = (await context.cookies()).filter((cookie) => /^sb-.*-auth-token/.test(cookie.name));
    assert(cookies.length > 0 && cookies.every((cookie) => cookie.httpOnly && cookie.sameSite === "Lax"));
  });
  await step("explicit audit submission is account-owned, locked and reaches a real report", async () => {
    await page.getByRole("textbox", { name: "Website URL", exact: true }).fill(TARGET);
    let release, calls = 0;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/scans", async (route) => { if (route.request().method() !== "POST") return route.continue(); calls++; await held; return route.continue(); });
    const responsePromise = page.waitForResponse((response) => response.url() === BASE + "/api/scans" && response.request().method() === "POST");
    await page.getByRole("button", { name: "Start audit", exact: true }).click();
    await page.locator('.branded-loading').filter({ hasText: "Preparing your audit" }).waitFor();
    await page.locator("form").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
    await page.waitForFunction(() => document.querySelector('button[type="submit"]')?.disabled);
    release();
    const response = await responsePromise;
    assert.equal(response.status(), 201);
    const body = await response.json();
    assert.equal(body.data.ownedByAccount, true);
    scanId = body.data.id;
    assert.equal(calls, 1);
    await page.unroute("**/api/scans");
    await page.waitForURL(`**/scans/${scanId}/progress`);
    // A genuinely fast completed audit must not be held on a fake progress screen.
    try {
      await page.locator('.branded-loading').filter({ hasText: "Auditing your website" }).waitFor({ timeout: 1500 });
      await page.screenshot({ path: path.join(OUT, "audit-progress.png"), fullPage: true });
    } catch { result.progress = "audit completed before active-indicator observation; no artificial hold"; }
    await page.waitForURL(BASE + `/scans/${scanId}`, { timeout: 240_000 });
    await page.getByRole("button", { name: "Download PDF", exact: true }).waitFor();
    const actual = await (await api(context, "GET", `/api/scans/${scanId}/results`)).json();
    assert(actual.ok && actual.data.scan.summary);
    findingId = actual.data.findings[0]?.id;
    result.audit = { id: scanId, target: actual.data.scan.targetUrl, status: actual.data.scan.status, summary: actual.data.scan.summary };
    await writeFile(path.join(OUT, "real-audit-data.json"), JSON.stringify(actual.data, null, 2));
    await checkUi("real report light desktop");
    await page.screenshot({ path: path.join(OUT, "audit-report-light-desktop.png"), fullPage: true });
  });
  await step("actual branded PDF download has visible loading, no duplicate request and clean completion", async () => {
    let release, calls = 0;
    const held = new Promise((resolve) => { release = resolve; });
    const routePattern = `**/api/scans/${scanId}/report.pdf`;
    await page.route(routePattern, async (route) => { calls++; await held; return route.continue(); });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PDF", exact: true }).click();
    await page.locator('.branded-loading').filter({ hasText: "Preparing your PDF report" }).waitFor();
    assert(await page.getByRole("button", { name: "Preparing PDF…", exact: true }).isDisabled());
    await page.screenshot({ path: path.join(OUT, "pdf-loading.png"), fullPage: false });
    release();
    const file = await download;
    await file.saveAs(PDF);
    const bytes = await readFile(PDF);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert(bytes.length > 1000);
    assert.equal(calls, 1);
    await page.getByRole("button", { name: "Download PDF", exact: true }).waitFor();
    assert.equal(await page.locator('.branded-loading').count(), 0);
    await page.unroute(routePattern);
    result.audit.pdfBytes = bytes.length;
  });
  await step("authenticated screens load responsively in both themes and collect axe evidence", async () => {
    const routes = ["/dashboard", "/dashboard/audits", "/audit/new", "/settings/ai", "/account/profile", "/account/security", "/account/connections", "/account/usage", "/account/appearance", "/account/organizations", "/account/delete", `/scans/${scanId}`, ...(findingId ? [`/scans/${scanId}/issues/${findingId}`] : [])];
    for (const theme of ["light", "dark"]) {
      assert.equal((await api(context, "PATCH", "/api/account/settings", { theme })).status(), 200);
      await page.evaluate((theme) => localStorage.setItem("sitelens-theme", theme), theme);
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const route of routes) {
          await page.goto(BASE + route, { waitUntil: "networkidle" });
          assert.equal(new URL(page.url()).pathname, route);
          await checkUi(`${theme} ${width}px ${route}`);
          if (route === "/dashboard" || route === `/scans/${scanId}` || route === "/account/profile") await page.screenshot({ path: path.join(OUT, `${route.startsWith('/scans/') ? 'report' : route.slice(1).replaceAll('/', '-')}-${theme}-${width}.png`), fullPage: true });
        }
      }
    }
    await page.setViewportSize({ width: 320, height: 900 });
    for (const route of ["/audit/new", "/dashboard/audits", "/account/profile", `/scans/${scanId}`]) { await page.goto(BASE + route, { waitUntil: "networkidle" }); await checkUi(`dark 320px ${route}`); }
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator("html").evaluate((element) => getComputedStyle(element).getPropertyValue("--foreground").trim()), "23 23 23");
    await page.emulateMedia({ media: "screen" });
  });
  await step("second verified account cannot read, run or export the owner's audit, even with a legacy key", async () => {
    const second = await browser.newContext();
    const userB = newUser(second);
    assert.equal((await api(second, "POST", "/api/auth/sign-up", { email: userB.email, password: userB.password, next: "/dashboard" })).status(), 200);
    assert.equal((await api(second, "POST", "/api/auth/verify", await emailToken(userB.email))).status(), 200);
    for (const [method, route] of [["GET", `/api/scans/${scanId}`], ["GET", `/api/scans/${scanId}/results`], ["GET", `/api/scans/${scanId}/report.pdf`], ["POST", `/api/scans/${scanId}/advance`], ["POST", `/api/scans/${scanId}/rerun`], ["DELETE", `/api/scans/${scanId}`]]) assert.equal((await api(second, method, route, method === "POST" ? {} : undefined, { "X-Scan-Key": "sk_test_not_authority" })).status(), 404, route);
  });
  await step("invalid and, when configured, validly signed expired sessions fail closed", async () => {
    const cookies = await context.cookies();
    const auth = cookies.filter((cookie) => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name));
    assert(auth.length);
    const name = auth[0].name.replace(/\.\d+$/, "");
    for (const kind of ["invalid", ...(process.env.TEST_SUPABASE_JWT_SECRET ? ["expired"] : [])]) {
      const denied = await browser.newContext();
      await denied.addCookies(cookies.filter((cookie) => !/^sb-.*-auth-token/.test(cookie.name)));
      let value = "base64-invalid-session-data";
      if (kind === "expired") {
        const encoded = auth.map((cookie) => cookie.value).join("");
        const session = JSON.parse(Buffer.from(encoded.slice("base64-".length), "base64url").toString());
        const token = session.access_token;
        const [header, payload] = token.split(".");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        claims.iat = Math.floor(Date.now() / 1000) - 3600;
        claims.exp = Math.floor(Date.now() / 1000) - 60;
        const input = header + "." + Buffer.from(JSON.stringify(claims)).toString("base64url");
        session.access_token = input + "." + createHmac("sha256", process.env.TEST_SUPABASE_JWT_SECRET).update(input).digest("base64url");
        session.refresh_token = "expired-test-refresh-token";
        session.expires_at = claims.exp;
        session.expires_in = 0;
        value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
      }
      await denied.addCookies([{ ...auth[0], name, value }]);
      for (const [method, route, data] of [["POST", "/api/scans", { url: TARGET }], ["POST", `/api/scans/${scanId}/advance`, {}], ["GET", `/api/scans/${scanId}/report.pdf`]]) assert.equal((await api(denied, method, route, data)).status(), 401, kind + " " + route);
      const protectedPage = await api(denied, "GET", "/audit/new");
      assert([200, 307].includes(protectedPage.status()));
      if (protectedPage.status() === 200) assert((await protectedPage.text()).includes('id="__next-page-redirect"'));
      if (kind === "expired") result.expiry = "validly signed expired local-provider session + unusable refresh token refused";
      await denied.close();
    }
  });
  await step("real logout denies subsequent requests; login reopens the account report without executing another audit", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(BASE + "/dashboard", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Account menu/ }).click();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/auth/sign-out", async (route) => { await held; return route.continue(); });
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page.locator('.branded-loading').filter({ hasText: "Signing you out securely" }).waitFor();
    await page.screenshot({ path: path.join(OUT, "logout-loading.png"), fullPage: true });
    release();
    await page.waitForURL(BASE + "/");
    await page.unroute("**/api/auth/sign-out");
    assert.equal((await api(context, "GET", `/api/scans/${scanId}`)).status(), 401);
    const before = submissions;
    await signInUi(userA, `/scans/${scanId}`);
    await page.getByRole("button", { name: "Download PDF", exact: true }).waitFor();
    assert.equal(submissions, before);
    assert.equal((await api(context, "GET", `/api/scans/${scanId}/results`)).status(), 200);
  });
  await step("complete accessibility matrix has no detected WCAG A/AA violations", async () => {
    assert.equal(result.accessibility.reduce((n, item) => n + item.violations.length, 0), 0, "See browser-results.json for every detected accessibility violation");
    assert.equal(result.pageErrors.length, 0, "Browser runtime errors occurred");
  });
} catch (error) {
  console.error("FAILED", error.message);
  process.exitCode = 1;
} finally {
  for (const user of users) {
    try { const response = await api(user.ctx, "DELETE", "/api/account", { confirmEmail: user.email }); result.steps.push({ name: "delete isolated verification account", ok: response.status() === 200, status: response.status() }); }
    catch { result.steps.push({ name: "verification account cleanup", ok: false }); }
  }
  if (result.steps.some((item) => !item.ok)) process.exitCode = 1;
  await writeFile(path.join(OUT, "browser-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.steps.filter((item) => item.ok).length, failed: result.steps.filter((item) => !item.ok).length, accessibilityPages: result.accessibility.length, violations: result.accessibility.reduce((n, item) => n + item.violations.length, 0), layouts: result.layouts.length, pageErrors: result.pageErrors.length, expiry: result.expiry, audit: result.audit }, null, 2));
  await browser.close();
}
