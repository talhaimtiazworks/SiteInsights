/**
 * Real-browser OAuth check: clicks "Continue with GitHub/Google" on the
 * sign-in page and follows the full redirect chain (app → Supabase Auth →
 * provider → Supabase → /auth/callback) to the dashboard. Without real
 * provider credentials it runs against scripts/local-supabase/oauth-mock.mjs
 * (provider hostnames mapped to it; its test certificate is accepted only in
 * this throwaway browser context). See docs/TESTING.md › OAuth end-to-end.
 *   cd worker && BASE_URL=http://127.0.0.1:3000 MOCK_CONTROL=http://127.0.0.1:7443 npx tsx e2e/ui-oauth.mts
 */
import { chromium, type Page } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const CONTROL = process.env.MOCK_CONTROL ?? "http://127.0.0.1:7443";
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/sitelens-shots";
const SUPA = process.env.SUPABASE_URL ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_KEY ?? "";
const rnd = Math.random().toString(36).slice(2, 8);
const results: Array<{ name: string; ok: boolean }> = [];
const created = new Set<string>();
const HOSTS = ["github.com", "api.github.com", "accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com", "www.googleapis.com"];

async function step(name: string, page: Page, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    await page.screenshot({ path: `${SHOTS}/oauth-fail-${results.length}.png`, fullPage: true }).catch(() => {});
    console.log(`  ✗ ${name}\n      ${(e as Error).message.split("\n")[0]}`);
  }
}
async function mock(provider: string, identity: Record<string, unknown>) {
  await fetch(`${CONTROL}/next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, ...identity }) });
}
async function sessionUser(page: Page) {
  const r = await page.request.get(`${BASE}/api/auth/session`);
  const j = (await r.json()) as { data?: { status: string; user?: { id: string; email: string } } };
  return j.data;
}

const browser = await chromium.launch({ args: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(", ")}`] });
try {
  for (const [provider, label, identity] of [
    ["github", "GitHub", { mode: "approve", id: 9_100_000 + Math.floor(Math.random() * 1e5), login: `ui-${rnd}`, name: `UI Octo ${rnd}`, email: `ui-octo-${rnd}@sitelens.localtest`, avatar: "https://avatars.githubusercontent.com/u/2?v=4" }],
    ["google", "Google", { mode: "approve", sub: `ui${Date.now()}`, name: `UI Gloria ${rnd}`, email: `ui-gloria-${rnd}@sitelens.localtest`, picture: "https://lh3.googleusercontent.com/a/ui" }],
  ] as const) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    await step(`${label}: click the button on /sign-in → lands on the requested dashboard page, signed in`, page, async () => {
      await mock(provider, identity);
      await page.goto(`${BASE}/sign-in?next=${encodeURIComponent("/dashboard/audits")}`);
      await page.getByRole("button", { name: `Continue with ${label}` }).click();
      await page.waitForURL((u) => u.origin === new URL(BASE).origin && u.pathname === "/dashboard/audits", { timeout: 20_000 });
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 10_000 });
      const s = await sessionUser(page);
      if (s?.status !== "signed_in" || s.user?.email !== identity.email) throw new Error(`session ${JSON.stringify(s)}`);
      created.add(s.user.id);
      await page.goto(`${BASE}/dashboard`);
      await page.getByText(/no audits yet|start your first audit/i).first().waitFor({ timeout: 10_000 });
      await page.screenshot({ path: `${SHOTS}/oauth-${provider}-dashboard.png` });
    });
    await step(`${label}: account page shows the provider name and connection`, page, async () => {
      await page.goto(`${BASE}/account`);
      const field = page.getByLabel("Display name");
      await field.waitFor({ timeout: 10_000 });
      if ((await field.inputValue()) !== identity.name) throw new Error(`display name is "${await field.inputValue()}"`);
      await page.goto(`${BASE}/account/connections`);
      await page.getByText(label, { exact: true }).first().waitFor({ timeout: 10_000 });
      await page.getByText(/connected/i).first().waitFor({ timeout: 10_000 });
    });
    await step(`${label}: cancel at the provider → sign-in page explains it`, page, async () => {
      const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
      const p2 = await ctx2.newPage();
      await mock(provider, { mode: "deny" });
      await p2.goto(`${BASE}/sign-in?next=/dashboard`);
      await p2.getByRole("button", { name: `Continue with ${label}` }).click();
      await p2.waitForURL((u) => u.pathname === "/sign-in" && u.searchParams.get("error") === "access_denied", { timeout: 20_000 });
      await p2.getByText("Sign-in was cancelled.").waitFor({ timeout: 10_000 });
      await mock(provider, { mode: "approve" });
      await p2.screenshot({ path: `${SHOTS}/oauth-${provider}-cancelled.png` });
      await ctx2.close();
    });
    await ctx.close();
  }
} finally {
  await browser.close();
  if (SUPA && SERVICE) for (const id of created) await fetch(`${SUPA}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } }).catch(() => null);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed`);
  process.exit(failed ? 1 : 0);
}
