#!/usr/bin/env node
/**
 * Browser acceptance for the real team-invitation UI against local SiteInsights,
 * GoTrue and PostgreSQL only. Creates throwaway Auth users and one team; deletes
 * both at the end. Invitation email is expected to remain not_configured.
 *
 * Required (private): BASE_URL, TEST_SUPABASE_URL,
 * TEST_SUPABASE_SERVICE_ROLE_KEY. Both URLs must be loopback.
 * Run from the repository after a local production build and local Auth setup:
 *   node scripts/smoke/invitations-e2e.mjs
 * The result file contains step names/statuses only, never credentials or users.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import playwright from "../../worker/node_modules/playwright-core/index.js";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const AUTH = process.env.TEST_SUPABASE_URL ?? "";
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "";
const OUT = process.env.INVITATION_E2E_RESULTS ?? "/tmp/siteinsights-invitations-e2e-results.json";
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
function assertLocal(raw, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid loopback URL.`); }
  assert(loopback.has(url.hostname), `${label} must be loopback; hosted services are forbidden.`);
  assert(url.protocol === "http:", `${label} must use local HTTP for this disposable check.`);
  return url;
}
const baseUrl = assertLocal(BASE, "BASE_URL");
assertLocal(AUTH, "TEST_SUPABASE_URL");
assert(SERVICE, "A private local TEST_SUPABASE_SERVICE_ROLE_KEY is required.");

const results = [];
const users = [];
const sensitive = new Set([SERVICE]);
let browser;
let ownerPage;
let organizationId;
let firstInvitationId;
let failure;
const safeError = (error) => {
  let text = error instanceof Error ? error.message : "Browser check failed.";
  for (const value of sensitive) if (value) text = text.split(value).join("[redacted]");
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/postgres(?:ql)?:\/\/\S+/gi, "[database URL]");
  return text.slice(0, 600);
};
async function step(name, action) {
  const started = Date.now();
  try {
    await action();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: safeError(error), ms: Date.now() - started });
    console.error(`FAIL ${name}: ${safeError(error)}`);
    throw error;
  }
}
async function createUser(label) {
  const email = `invite-ui-${label}-${randomUUID().slice(0, 8)}@sitelens.localtest`;
  const password = `Local-Invite-${randomUUID()}-Aa1!`;
  sensitive.add(email);
  sensitive.add(password);
  const response = await fetch(`${AUTH}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: `Invite ${label}` } }),
  });
  if (!response.ok) throw new Error(`Local Auth user creation returned HTTP ${response.status}.`);
  const body = await response.json();
  const user = { id: body.id, email, password };
  users.push(user);
  return user;
}
async function signIn(page, user) {
  await page.goto(`${BASE}/sign-in?next=${encodeURIComponent("/teams")}`, { waitUntil: "networkidle" });
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.locator("#password").fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.origin === baseUrl.origin && url.pathname === "/teams", { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
}
async function createInvitation(email, expectedOrganizationId) {
  await ownerPage.getByPlaceholder("teammate@company.com").fill(email);
  const responsePromise = ownerPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && /^\/api\/organizations\/[0-9a-f-]+\/invitations$/.test(url.pathname);
  });
  await ownerPage.getByRole("button", { name: "Create invitation", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, "Invitation creation must succeed locally.");
  const path = new URL(response.url()).pathname;
  const match = /^\/api\/organizations\/([0-9a-f-]+)\/invitations$/.exec(path);
  assert(match, "Invitation request must target a local organization.");
  assert.equal(match[1], expectedOrganizationId, "Invitation must belong to the new local team.");
  const body = await response.json();
  assert.equal(body.data?.invitation?.emailDeliveryStatus, "not_configured", "Team email must remain disabled.");
  assert.equal(body.data?.emailDelivery?.status, "not_configured", "No invitation email may be sent.");
  await ownerPage.getByRole("alert").filter({ hasText: "team email is not configured" }).waitFor({ timeout: 10_000 });
  await ownerPage.getByText(email, { exact: true }).waitFor({ timeout: 10_000 });
  return body.data.invitation.id;
}
async function deleteUsers() {
  for (const user of users) {
    try {
      await fetch(`${AUTH}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` },
      });
    } catch { /* best-effort cleanup; the test remains local and disposable */ }
  }
}

try {
  browser = await playwright.chromium.launch({ headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  const ownerContext = await browser.newContext();
  const wrongContext = await browser.newContext();
  const acceptContext = await browser.newContext();
  const declineContext = await browser.newContext();
  const revokedContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  const wrongPage = await wrongContext.newPage();
  const acceptPage = await acceptContext.newPage();
  const declinePage = await declineContext.newPage();
  const revokedPage = await revokedContext.newPage();

  const owner = await createUser("owner");
  const wrong = await createUser("wrong-recipient");
  const accept = await createUser("accept-recipient");
  const decline = await createUser("decline-recipient");
  const revoked = await createUser("revoked-recipient");
  const teamName = `VT Browser Team ${randomUUID().slice(0, 6)}`;
  for (const value of [teamName]) sensitive.add(value);

  await step("owner creates a team and a pending invitation in the UI; email stays disabled", async () => {
    await signIn(ownerPage, owner);
    await ownerPage.getByRole("heading", { name: "Create a team", exact: true }).waitFor();
    await ownerPage.getByRole("textbox", { name: "Team name", exact: true }).fill(teamName);
    const responsePromise = ownerPage.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/organizations" && response.request().method() === "POST");
    await ownerPage.getByRole("button", { name: "Create team", exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 201, "Local team creation must succeed.");
    const body = await response.json();
    organizationId = body.data?.organization?.id;
    assert(organizationId, "Local team response must include an id.");
    await ownerPage.getByText("Invite by email", { exact: true }).waitFor();
    firstInvitationId = await createInvitation(accept.email, organizationId);
    assert.match(firstInvitationId, /^[0-9a-f-]{36}$/i, "Invitation id must be a UUID.");
  });

  await step("wrong account has no inbox entry and cannot accept another email's invitation", async () => {
    await signIn(wrongPage, wrong);
    await wrongPage.getByText("No pending invitations for your verified email.", { exact: true }).waitFor({ timeout: 15_000 });
    const response = await wrongPage.evaluate(async (id) => {
      const res = await fetch(`/api/organizations/invitations/${id}/accept`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      const body = await res.json();
      return { status: res.status, code: body.error?.code };
    }, firstInvitationId);
    assert.equal(response.status, 403, "Wrong verified email must be rejected.");
    assert.equal(response.code, "invitation_email_mismatch");
  });

  await step("verified recipient accepts the invitation from Teams → Invitation inbox", async () => {
    await signIn(acceptPage, accept);
    const invitation = acceptPage.locator("li").filter({ hasText: teamName });
    await invitation.waitFor({ timeout: 15_000 });
    await invitation.getByRole("button", { name: "Accept", exact: true }).click();
    await acceptPage.getByRole("alert").filter({ hasText: `You joined ${teamName}.` }).waitFor({ timeout: 15_000 });
    await acceptPage.getByText("No pending invitations for your verified email.", { exact: true }).waitFor({ timeout: 15_000 });
  });

  await step("verified recipient declines a different invitation from the inbox", async () => {
    const invitationId = await createInvitation(decline.email, organizationId);
    await signIn(declinePage, decline);
    const invitation = declinePage.locator("li").filter({ hasText: teamName });
    await invitation.waitFor({ timeout: 15_000 });
    await invitation.getByRole("button", { name: "Decline", exact: true }).click();
    await declinePage.getByRole("alert").filter({ hasText: `You declined the invitation to ${teamName}.` }).waitFor({ timeout: 15_000 });
    await declinePage.getByText("No pending invitations for your verified email.", { exact: true }).waitFor({ timeout: 15_000 });
    assert.match(invitationId, /^[0-9a-f-]{36}$/i);
  });

  await step("owner revokes a pending invitation and the recipient inbox stays empty", async () => {
    await createInvitation(revoked.email, organizationId);
    const row = ownerPage.locator("li").filter({ hasText: revoked.email });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await ownerPage.getByRole("alert").filter({ hasText: "revoked" }).waitFor({ timeout: 15_000 });
    await signIn(revokedPage, revoked);
    await revokedPage.getByText("No pending invitations for your verified email.", { exact: true }).waitFor({ timeout: 15_000 });
  });
} catch (error) {
  failure = error;
} finally {
  if (ownerPage && organizationId) {
    try {
      const status = await ownerPage.evaluate(async (id) => {
        const response = await fetch(`/api/organizations/${id}`, { method: "DELETE" });
        return response.status;
      }, organizationId);
      results.push({ name: "cleanup local team", ok: status === 200, status });
    } catch { results.push({ name: "cleanup local team", ok: false }); }
  }
  if (browser) await browser.close().catch(() => {});
  await deleteUsers();
  try { await writeFile(OUT, JSON.stringify({ steps: results }, null, 2), { mode: 0o600 }); } catch { /* result path is optional */ }
}

if (failure) process.exitCode = 1;
else {
  const failed = results.filter((item) => !item.ok);
  console.log(`Invitation browser smoke: ${results.filter((item) => item.ok).length} passed, ${failed.length} failed.`);
  console.log(`Sanitized result: ${OUT}`);
  if (failed.length) process.exitCode = 1;
}
