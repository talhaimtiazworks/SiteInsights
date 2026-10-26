#!/usr/bin/env node
/**
 * Triggers every Supabase Auth email the app uses against a real Supabase Auth
 * (GoTrue) server and checks what actually arrives at the SMTP sink: subject,
 * branded layout, rendered template variables, link target and token type.
 * Saves each received HTML to OUT_DIR for screenshots.
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… SUPABASE_SERVICE_KEY=… \
 *   SINK_URL=http://127.0.0.1:2501 APP_URL=http://127.0.0.1:3000 OUT_DIR=/tmp/emails \
 *   node scripts/smoke/email-render.mjs
 *
 * Local test tool: needs GoTrue configured with the templates built for APP_URL
 * (scripts/email/build-templates.mjs --app-url $APP_URL --out …). It never
 * prints tokens or keys.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, SINK_URL = "http://127.0.0.1:2501", APP_URL = "http://127.0.0.1:3000", OUT_DIR = "/tmp/emails" } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY are required");
const subjects = JSON.parse(await readFile(new URL("../../supabase/templates/subjects.json", import.meta.url), "utf8")).subjects;
await mkdir(OUT_DIR, { recursive: true });

let passed = 0, failed = 0;
const check = (name, ok, info = "") => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !info ? "" : ` — ${info}`}`);
};

async function auth(pathname, { method = "POST", body, token, admin } = {}) {
  const key = admin ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/auth/v1${pathname}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${token ?? key}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${json.error_code ?? json.code ?? ""}`);
  return json;
}
const messages = async () => (await (await fetch(`${SINK_URL}/messages`)).json());
async function waitFor(to, subject, since) {
  for (let i = 0; i < 40; i++) {
    const m = (await messages()).filter((x) => x.id > since && x.to.some((t) => t.toLowerCase() === to.toLowerCase()) && x.subject === subject);
    if (m.length) return m[m.length - 1];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
const lastId = async () => Math.max(0, ...(await messages()).map((m) => m.id));
const stamp = Date.now().toString(36);
const addr = (tag) => `email-${tag}-${stamp}@sitelens.localtest`;
const PASSWORD = `Render-${stamp}-Pw!9`;
const redirect = `${APP_URL}/auth/callback?next=%2Fdashboard`;

async function verifyEmail(key, msg, { to, type, expect = [] }) {
  check(`${key}: delivered to ${to.replace(stamp, "…")}`, !!msg);
  if (!msg) return;
  const html = msg.html;
  await writeFile(path.join(OUT_DIR, `${key}.html`), html);
  check(`${key}: subject "${subjects[key]}"`, msg.subject === subjects[key], msg.subject);
  check(`${key}: branded layout + security note + footer`, html.includes("SiteInsights") && html.includes("Security note:") && html.includes("TalhaImtiazWorks"));
  check(`${key}: no unrendered template actions`, !/\{\{|\}\}/.test(html));
  check(`${key}: no mojibake (charset intact)`, !/â€|Â·|Ã/.test(html));
  check(`${key}: no "<no value>" placeholders`, !html.includes("&lt;no value&gt;") && !html.includes("<no value>"));
  for (const e of expect) check(`${key}: contains ${e.label}`, e.test(html));
  if (type) {
    const links = [...html.matchAll(/href="([^"]+\/auth\/confirm\?[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    check(`${key}: button + fallback link to ${APP_URL}/auth/confirm`, links.length === 2 && links.every((l) => l.startsWith(`${APP_URL}/auth/confirm?`)), `${links.length} links`);
    const u = links[0] ? new URL(links[0]) : null;
    check(`${key}: type=${type}, token_hash present`, u?.searchParams.get("type") === type && (u?.searchParams.get("token_hash") ?? "").length >= 20);
    const next = u?.searchParams.get("next") ?? "";
    check(`${key}: next is the app callback (allow-listed RedirectTo, not Site URL fallback)`, next.startsWith(`${APP_URL}/auth/callback`), next ? "different redirect" : "missing");
  }
  check(`${key}: only one MIME part (Supabase sends HTML only)`, JSON.stringify(msg.contentTypes) === '["text/html"]', JSON.stringify(msg.contentTypes));
}

// 1) Signup confirmation
{
  const to = addr("signup"), since = await lastId();
  await auth(`/signup?redirect_to=${encodeURIComponent(redirect)}`, { body: { email: to, password: PASSWORD } });
  await verifyEmail("confirmation", await waitFor(to, subjects.confirmation, since), { to, type: "email" });
}
// A confirmed user for the remaining flows
const user = addr("user");
await auth("/admin/users", { admin: true, body: { email: user, password: PASSWORD, email_confirm: true } });
const login = async (email, password) => (await auth("/token?grant_type=password", { body: { email, password } })).access_token;
let token = await login(user, PASSWORD);

// 2) Password reset
{
  const since = await lastId();
  await auth(`/recover?redirect_to=${encodeURIComponent(redirect)}`, { body: { email: user } });
  await verifyEmail("recovery", await waitFor(user, subjects.recovery, since), { to: user, type: "recovery", expect: [{ label: "the account email", test: (h) => h.includes(user) }] });
}
// 3) Magic link (+ one-time code)
{
  await new Promise((r) => setTimeout(r, 1100)); // per-user email frequency limit
  const since = await lastId();
  await auth(`/otp?redirect_to=${encodeURIComponent(redirect)}`, { body: { email: user, create_user: false } });
  await verifyEmail("magic_link", await waitFor(user, subjects.magic_link, since), { to: user, type: "magiclink", expect: [{ label: "a 6+ digit code", test: (h) => /letter-spacing:6px[^>]*>\d{6,10}</.test(h) }] });
}
// 4) Invite
{
  const to = addr("invite"), since = await lastId();
  // GoTrue reads redirect_to for /invite from the query string (supabase-js inviteUserByEmail does the same).
  await auth(`/invite?redirect_to=${encodeURIComponent(redirect)}`, { admin: true, body: { email: to } });
  await verifyEmail("invite", await waitFor(to, subjects.invite, since), { to, type: "invite" });
}
// 5) Email change (secure change: GoTrue mails the current and the new address)
{
  await new Promise((r) => setTimeout(r, 1100));
  const to = addr("new"), since = await lastId();
  await auth(`/user?redirect_to=${encodeURIComponent(redirect)}`, { method: "PUT", token, body: { email: to } });
  const toNew = await waitFor(to, subjects.email_change, since);
  await verifyEmail("email_change", toNew, { to, type: "email_change", expect: [{ label: "old and new addresses", test: (h) => h.includes(user) && h.includes(to) }] });
  const toOld = await waitFor(user, subjects.email_change, since);
  check("email_change: current address is also notified (secure email change)", !!toOld && toOld.html.includes(to), toOld ? "" : "not received (secure email change may be off)");
}
// 6) Reauthentication code
{
  await new Promise((r) => setTimeout(r, 1100));
  const since = await lastId();
  await auth("/reauthenticate", { method: "GET", token });
  await verifyEmail("reauthentication", await waitFor(user, subjects.reauthentication, since), { to: user, expect: [{ label: "a 6+ digit code", test: (h) => /letter-spacing:6px[^>]*>\d{6,10}</.test(h) }] });
}
// 7) Password changed notification (only sent when the notification is enabled)
{
  await new Promise((r) => setTimeout(r, 1100));
  const pwUser = addr("pw");
  await auth("/admin/users", { admin: true, body: { email: pwUser, password: PASSWORD, email_confirm: true } });
  const t = await login(pwUser, PASSWORD);
  const since = await lastId();
  await auth("/user", { method: "PUT", token: t, body: { password: `${PASSWORD}-new` } });
  const msg = await waitFor(pwUser, subjects.password_changed_notification, since);
  if (msg) await verifyEmail("password_changed_notification", msg, { to: pwUser, expect: [{ label: "the account email", test: (h) => h.includes(pwUser) }] });
  else console.log("SKIP  password_changed_notification: not sent (notifications not enabled on this Auth server)");
}

console.log(`\n${passed} passed, ${failed} failed. HTML saved to ${OUT_DIR}`);
process.exit(failed ? 1 : 0);
