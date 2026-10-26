#!/usr/bin/env node
/**
 * End-to-end check of accounts + persistence against a RUNNING SiteInsights
 * server connected to Supabase Auth (local GoTrue or a real project).
 *
 *   BASE_URL=http://127.0.0.1:3000 SINK_URL=http://127.0.0.1:2501 \
 *   AUDIT_URL=https://example.com node scripts/smoke/auth-e2e.mjs
 *
 * SINK_URL is the local SMTP sink (scripts/local-supabase/smtp-sink.mjs) used
 * to read confirmation / reset emails. Without it, email steps are skipped.
 * Creates two throwaway users and deletes them at the end.
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SINK = process.env.SINK_URL ?? "";
const AUDIT_URL = process.env.AUDIT_URL ?? "https://example.com/";
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    const v = await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✓ ${name}`);
    return v;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
    throw e;
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

class Browser {
  jar = new Map();
  constructor(name) {
    this.name = name;
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || (/expires=/i.test(a) && new Date(a.split("=")[1]) < new Date()));
      if (!v || expired) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async req(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, {
      method,
      redirect: "manual",
      headers: { origin: BASE, cookie: this.cookieHeader(), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.absorb(res);
    const ct = res.headers.get("content-type") ?? "";
    const json = ct.includes("json") ? await res.json() : null;
    return { status: res.status, json, headers: res.headers };
  }
  get authCookieNames() {
    return [...this.jar.keys()].filter((k) => /^sb-.*-auth-token/.test(k));
  }
}

async function latestEmail(to, subjectRe, since) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${SINK}/messages`).then((x) => x.json());
    const list = (r.messages ?? r).filter((m) => (m.to ?? []).join(",").includes(to) && subjectRe.test(m.subject ?? "") && new Date(m.receivedAt ?? m.date ?? 0).getTime() >= since - 2000);
    if (list.length) return list[list.length - 1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email for ${to} matching ${subjectRe}`);
}
const tokenFrom = (msg) => {
  const body = (msg.html ?? msg.text ?? msg.body ?? "").replace(/&amp;/g, "&");
  const m = /\/auth\/confirm\?token_hash=([A-Za-z0-9_-]+)&(?:amp;)?type=([a-z_]+)(?:&(?:amp;)?next=([^"'\s<]*))?/.exec(body);
  if (!m) throw new Error("confirmation link not found in email");
  return { token_hash: m[1], type: m[2], next: m[3] ? decodeURIComponent(m[3]) : undefined };
};

const rnd = Math.random().toString(36).slice(2, 8);
const userA = { email: `e2e-a-${rnd}@sitelens.localtest`, password: `Pw-${rnd}-Aa1!x` };
const userB = { email: `e2e-b-${rnd}@sitelens.localtest`, password: `Pw-${rnd}-Bb2!y` };

async function signUpAndConfirm(br, u) {
  const since = Date.now();
  const r = await br.req("POST", "/api/auth/sign-up", { ...u, displayName: "E2E User", next: "/dashboard" });
  assert(r.status === 200, `sign-up HTTP ${r.status} ${JSON.stringify(r.json)}`);
  if (r.json.data.status === "signed_in") return;
  assert(r.json.data.status === "confirmation_required", "unexpected sign-up status");
  assert(SINK, "email confirmation required but SINK_URL not set");
  // Signing in before confirming is refused with a clear code.
  const early = await br.req("POST", "/api/auth/sign-in", u);
  assert(early.status === 403 && early.json.error.code === "email_not_confirmed", `expected email_not_confirmed, got ${early.status} ${early.json?.error?.code}`);
  const tok = tokenFrom(await latestEmail(u.email, /confirm/i, since));
  const v = await br.req("POST", "/api/auth/verify", tok);
  assert(v.status === 200 && v.json.data.signedIn, `verify HTTP ${v.status} ${JSON.stringify(v.json)}`);
  assert(v.json.data.next === "/dashboard", `verify next should be /dashboard, got ${v.json.data.next}`);
}

async function waitForAudit(br, id, timeoutMs = 240_000) {
  const t = Date.now();
  let last;
  while (Date.now() - t < timeoutMs) {
    // Reads only — never calls /advance — so completion proves background processing.
    const r = await br.req("GET", `/api/scans/${id}`);
    assert(r.status === 200, `GET scan HTTP ${r.status}`);
    last = r.json.data;
    if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`audit still ${last?.status} after ${timeoutMs} ms`);
}

const main = async () => {
  console.log(`SiteInsights auth e2e against ${BASE}`);
  const a = new Browser("A");
  const b = new Browser("B");
  let scanId, rerunId;

  await step("protected page redirects to sign-in server-side", async () => {
    const r = await a.req("GET", "/dashboard/audits?status=failed");
    assert(r.status === 307 || r.status === 308, `expected redirect, got ${r.status}`);
    assert((r.headers.get("location") ?? "").includes("/sign-in?next=%2Fdashboard%2Faudits%3Fstatus%3Dfailed"), `bad location ${r.headers.get("location")}`);
  });
  await step("dashboard API requires sign-in (401)", async () => {
    const r = await a.req("GET", "/api/dashboard");
    assert(r.status === 401 && r.json.error.code === "auth_required", `got ${r.status}`);
  });
  await step("sign-up + email confirmation creates a session", async () => {
    await signUpAndConfirm(a, userA);
    assert(a.authCookieNames.length > 0, "no auth cookie set");
    const s = await a.req("GET", "/api/auth/session");
    assert(s.json.data.status === "signed_in" && s.json.data.user.email === userA.email, "session not signed in");
  });
  await step("auth cookies are HttpOnly and SameSite=Lax", async () => {
    const r = await fetch(BASE + "/api/auth/sign-in", { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify(userA) });
    const sc = r.headers.getSetCookie().filter((c) => /^sb-/.test(c));
    assert(sc.length && sc.every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)), "auth cookie flags missing");
    assert(!JSON.stringify(await r.json()).includes("access_token"), "token leaked in body");
  });
  await step("wrong password → invalid_credentials", async () => {
    const r = await new Browser("x").req("POST", "/api/auth/sign-in", { email: userA.email, password: "wrong-password-1" });
    assert(r.status === 401 && r.json.error.code === "invalid_credentials", `got ${r.status}`);
  });
  await step("cross-origin auth POST is rejected", async () => {
    const r = await new Browser("x").req("POST", "/api/auth/sign-in", userA, { origin: "https://evil.example" });
    assert(r.status === 403, `got ${r.status}`);
  });
  await step("start an audit (saved before work starts)", async () => {
    const r = await a.req("POST", "/api/scans", { url: AUDIT_URL, checks: { browser: true, accessibility: true, performance: false } }, { "idempotency-key": `e2e-${rnd}-0001` });
    assert(r.status === 201, `start HTTP ${r.status} ${JSON.stringify(r.json)}`);
    scanId = r.json.data.id;
    assert(r.json.data.ownedByAccount === true, "audit not owned by account");
    const again = await a.req("GET", `/api/scans/${scanId}`);
    assert(again.status === 200, "freshly created audit not readable");
  });
  const done = await step("audit completes in the background (no tab driving it)", async () => {
    const s = await waitForAudit(a, scanId);
    assert(["completed", "completed_with_warnings"].includes(s.status), `audit ended ${s.status}: ${s.error?.message}`);
    return s;
  });
  await step("results, PDF export and dashboard reflect the audit", async () => {
    const r = await a.req("GET", `/api/scans/${scanId}/results`);
    assert(r.status === 200 && Array.isArray(r.json.data.findings), "results missing");
    const pdf = await fetch(`${BASE}/api/scans/${scanId}/report.pdf`, { headers: { cookie: a.cookieHeader() } });
    assert(pdf.status === 200 && (pdf.headers.get("content-type") ?? "").includes("pdf"), `pdf HTTP ${pdf.status}`);
    const d = await a.req("GET", "/api/dashboard");
    assert(d.status === 200 && d.json.data.stats.total >= 1 && d.json.data.stats.completed >= 1, "dashboard stats wrong");
    assert(d.json.data.stats.averageScore === null || typeof d.json.data.stats.averageScore === "number", "bad average");
    const list = await a.req("GET", `/api/audits?q=${encodeURIComponent(new URL(AUDIT_URL).hostname)}&status=completed`);
    assert(list.json.data.items.some((x) => x.id === scanId), "audit not found by search");
  });
  await step("sign out → the private audit requires sign-in (401)", async () => {
    const r = await a.req("POST", "/api/auth/sign-out", {});
    assert(r.status === 200 && a.authCookieNames.length === 0, "auth cookies not cleared");
    const g = await a.req("GET", `/api/scans/${scanId}`);
    assert(g.status === 401 && ["auth_required", "session_expired"].includes(g.json.error.code), `expected 401, got ${g.status}`);
  });
  await step("sign in again → reopen the same audit (no 'Scan not found')", async () => {
    const r = await a.req("POST", "/api/auth/sign-in", userA);
    assert(r.status === 200, `sign-in HTTP ${r.status}`);
    const g = await a.req("GET", `/api/scans/${scanId}`);
    assert(g.status === 200 && g.json.data.id === scanId && g.json.data.status === "completed", `reopen failed ${g.status}`);
    const res = await a.req("GET", `/api/scans/${scanId}/results`);
    assert(res.status === 200 && res.json.data.scan.summary.pagesScanned === done.summary.pagesScanned, "results changed after re-login");
  });
  await step("a second user guessing the audit ID gets 404 everywhere", async () => {
    await signUpAndConfirm(b, userB);
    for (const p of ["", "/results", "/links", "/pages", "/ai-summary"]) {
      const r = await b.req("GET", `/api/scans/${scanId}${p}`);
      assert(r.status === 404, `GET ${p || "/"} → ${r.status}`);
    }
    const pdf = await fetch(`${BASE}/api/scans/${scanId}/report.pdf`, { headers: { cookie: b.cookieHeader() } });
    assert(pdf.status === 404, `pdf → ${pdf.status}`);
    for (const [m, p, body] of [["PATCH", "", { title: "pwned" }], ["DELETE", "", undefined], ["POST", "/rerun", {}], ["POST", "/cancel", {}]]) {
      const r = await b.req(m, `/api/scans/${scanId}${p}`, body);
      assert(r.status === 404, `${m} ${p || "/"} → ${r.status}`);
    }
    const cmp = await b.req("GET", `/api/scans/compare?a=${scanId}&b=${scanId}`);
    assert(cmp.status === 400 || cmp.status === 404, `compare → ${cmp.status}`);
    const list = await b.req("GET", "/api/audits");
    assert(list.json.data.total === 0, "second user sees audits");
    const still = await a.req("GET", `/api/scans/${scanId}`);
    assert(still.status === 200 && still.json.data.title !== "pwned", "owner's audit was modified");
  });
  await step("rename + rerun + compare", async () => {
    const p = await a.req("PATCH", `/api/scans/${scanId}`, { title: "Example homepage" });
    assert(p.status === 200 && p.json.data.title === "Example homepage", "rename failed");
    const r = await a.req("POST", `/api/scans/${scanId}/rerun`, {}, { "idempotency-key": `e2e-${rnd}-rerun` });
    assert(r.status === 201 && r.json.data.rerunOf === scanId, `rerun HTTP ${r.status} ${JSON.stringify(r.json?.error)}`);
    rerunId = r.json.data.id;
    const s = await waitForAudit(a, rerunId);
    assert(["completed", "completed_with_warnings"].includes(s.status), `rerun ended ${s.status}`);
    const c = await a.req("GET", `/api/scans/compare?a=${scanId}&b=${rerunId}`);
    assert(c.status === 200 && c.json.data.baseline.id === scanId && c.json.data.latest.id === rerunId, `compare HTTP ${c.status}`);
    assert(["compared", "not_evaluated"].includes(c.json.data.overall.status), "overall compare status");
  });
  await step("delete (with ownership) removes the audit", async () => {
    const d = await a.req("DELETE", `/api/scans/${rerunId}`);
    assert(d.status === 200, `delete HTTP ${d.status}`);
    const g = await a.req("GET", `/api/scans/${rerunId}`);
    assert(g.status === 404, "deleted audit still readable");
  });
  if (SINK) {
    await step("forgot password → reset link → new password works", async () => {
      const x = new Browser("reset");
      const since = Date.now();
      const r = await x.req("POST", "/api/auth/forgot-password", { email: userA.email });
      assert(r.status === 200, `forgot HTTP ${r.status}`);
      const unknown = await x.req("POST", "/api/auth/forgot-password", { email: `nobody-${rnd}@sitelens.localtest` });
      assert(unknown.status === 200, "unknown email must look identical");
      const tok = tokenFrom(await latestEmail(userA.email, /reset/i, since));
      assert(tok.type === "recovery", "not a recovery link");
      const v = await x.req("POST", "/api/auth/verify", tok);
      assert(v.status === 200 && v.json.data.next === "/account/reset-password", `verify ${v.status} ${JSON.stringify(v.json)}`);
      userA.password = `New-${rnd}-Cc3!z`;
      const u = await x.req("POST", "/api/auth/update-password", { password: userA.password });
      assert(u.status === 200, `update-password HTTP ${u.status} ${JSON.stringify(u.json)}`);
      const reuse = await new Browser("y").req("POST", "/api/auth/verify", tok);
      assert(reuse.status === 400, "reset link reusable");
      const s = await new Browser("z").req("POST", "/api/auth/sign-in", userA);
      assert(s.status === 200, "new password rejected");
    });
    await step("changing password from settings requires the current password", async () => {
      await a.req("POST", "/api/auth/sign-in", userA);
      const no = await a.req("POST", "/api/auth/update-password", { password: "Another-pass-123" });
      assert(no.status === 400 && no.json.error.code === "current_password_required", `got ${no.status} ${no.json?.error?.code}`);
      const bad = await a.req("POST", "/api/auth/update-password", { password: "Another-pass-123", currentPassword: "nope-nope-nope" });
      assert(bad.status === 400 && bad.json.error.code === "current_password_incorrect", `got ${bad.status}`);
    });
  }
  await step("account settings + profile persist", async () => {
    const s = await a.req("PATCH", "/api/account/settings", { theme: "dark", defaultPerformance: false });
    assert(s.status === 200 && s.json.data.settings.theme === "dark", "settings");
    const p = await a.req("PATCH", "/api/account/profile", { displayName: "Ada E2E" });
    assert(p.status === 200 && p.json.data.profile.displayName === "Ada E2E", "profile");
    const sess = await a.req("GET", "/api/auth/session");
    assert(sess.json.data.theme === "dark", "theme not in session");
  });
  await step("teams: share an audit with a member (read-only access)", async () => {
    const o = await a.req("POST", "/api/organizations", { name: "E2E Team" });
    assert(o.status === 201, `create org ${o.status}`);
    const orgId = o.json.data.organization.id;
    const m = await a.req("POST", `/api/organizations/${orgId}/members`, { email: userB.email, role: "member" });
    assert(m.status === 201, `add member ${m.status} ${JSON.stringify(m.json)}`);
    const sh = await a.req("PATCH", `/api/scans/${scanId}`, { organizationId: orgId });
    assert(sh.status === 200 && sh.json.data.organizationId === orgId, "share");
    const g = await b.req("GET", `/api/scans/${scanId}`);
    assert(g.status === 200 && g.json.data.viewer.viaOrganization === true && g.json.data.viewer.canEdit === false, `member read ${g.status}`);
    const del = await b.req("DELETE", `/api/scans/${scanId}`);
    assert(del.status === 404 || del.status === 403, `member delete → ${del.status}`);
    const leave = await b.req("DELETE", `/api/organizations/${orgId}/members/${(await b.req("GET", "/api/auth/session")).json.data.user.id}`);
    assert(leave.status === 200, "leave");
    const after = await b.req("GET", `/api/scans/${scanId}`);
    assert(after.status === 404, "access remained after leaving");
    const d = await a.req("DELETE", `/api/organizations/${orgId}`);
    assert(d.status === 200, "delete org");
  });
  await step("delete account (typed confirmation) removes the user and their data", async () => {
    const wrong = await a.req("DELETE", "/api/account", { confirmEmail: "someone@else.com" });
    assert(wrong.status === 400, "accepted wrong confirmation");
    const r = await a.req("DELETE", "/api/account", { confirmEmail: userA.email });
    assert(r.status === 200, `delete HTTP ${r.status} ${JSON.stringify(r.json)}`);
    const s = await new Browser("q").req("POST", "/api/auth/sign-in", userA);
    assert(s.status === 401, `deleted user can still sign in (${s.status})`);
    const rb = await b.req("DELETE", "/api/account", { confirmEmail: userB.email });
    assert(rb.status === 200, "cleanup user B");
  });
};

main()
  .catch(() => {})
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
    process.exit(failed.length ? 1 : 0);
  });
