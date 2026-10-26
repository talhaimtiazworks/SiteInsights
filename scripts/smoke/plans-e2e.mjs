#!/usr/bin/env node
/**
 * End-to-end check of plans, credits, crawling limits, PDF, prospects and
 * share links against a REAL production build (`next build` first) and a
 * real PostgreSQL database, auditing a real public website.
 *
 *   DATABASE_URL=postgres://…/scratch_db AUDIT_URL=https://books.toscrape.com/ \
 *   node scripts/smoke/plans-e2e.mjs
 *
 * Sign-in uses a throwaway RSA key pair. This script serves the JWKS and
 * starts `next start` pointed at it, so the real Supabase SDK verifies the
 * tokens. It is the same approach as tests/helpers/auth-fixture.ts. No
 * Supabase project, password or production secret is involved. Business is
 * granted with the operator CLI (scripts/billing/manage-subscription.mjs),
 * the same path an operator would use. USE A SCRATCH DATABASE: it creates
 * users, audits and ledger entries.
 */
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";

const DB = process.env.DATABASE_URL;
const AUDIT_URL = process.env.AUDIT_URL ?? "https://books.toscrape.com/";
const PORT = Number(process.env.PORT ?? 3100);
const BIG_PAGES = Number(process.env.BIG_PAGES ?? 120);
const OUT = process.env.OUT_DIR ?? ".";
if (!DB) throw new Error("DATABASE_URL (scratch database) is required.");
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function step(name, fn) {
  const t = Date.now();
  try {
    const v = await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`PASS ${name}`);
    return v;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, error: e.message });
    console.log(`FAIL ${name}\n     ${e.message}`);
    throw e;
  }
}

// ---- Test-only JWKS issuer
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
const jwks = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/auth/v1/.well-known/jwks.json")) return void res.end(JSON.stringify({ keys: [jwk] }));
  res.writeHead(401).end(JSON.stringify({ error: "invalid_grant", msg: "Test issuer has no refresh endpoint" }));
});
await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
const ISSUER = `http://127.0.0.1:${jwks.address().port}`;

function sessionCookie(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { sub: userId, role: "authenticated", aud: "authenticated", iss: `${ISSUER}/auth/v1`, iat: now - 10, exp: now + 7200, session_id: randomUUID(), is_anonymous: false, email, app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {} };
  const head = b64({ alg: "RS256", typ: "JWT", kid });
  const body = b64(claims);
  const token = `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  const session = { access_token: token, refresh_token: "none", expires_at: now + 7200, expires_in: 7200, token_type: "bearer", user: { id: userId, email, app_metadata: claims.app_metadata, user_metadata: {} } };
  return `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

// ---- Production server
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: DB,
    DATABASE_SSL: "disable",
    NEXT_PUBLIC_SUPABASE_URL: ISSUER,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_e2e_only",
    NEXT_PUBLIC_APP_URL: BASE,
    SESSION_SECRET: randomUUID() + randomUUID(),
    CRON_SECRET: randomUUID() + randomUUID(),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function call(cookie, path, init = {}) {
  const headers = { accept: "application/json", ...(cookie ? { cookie } : {}), ...(init.json ? { "content-type": "application/json", origin: BASE } : {}), ...(init.headers ?? {}) };
  const res = await fetch(BASE + path, { method: init.method ?? (init.json ? "POST" : "GET"), headers, body: init.json ? JSON.stringify(init.json) : undefined, redirect: "manual" });
  const type = res.headers.get("content-type") ?? "";
  let body = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  if (body && !Buffer.isBuffer(body) && body.ok === true && "data" in body) body = body.data; // { ok, data } envelope
  return { status: res.status, body, headers: res.headers };
}

async function waitForAudit(cookie, id, label) {
  const deadline = Date.now() + 20 * 60_000;
  let last = "";
  for (;;) {
    const r = await call(cookie, `/api/scans/${id}`);
    assert(r.status === 200, `${label}: GET scan ${r.status}`);
    const s = r.body;
    const p = s.progress;
    const line = `${s.status}/${s.phase} scanned=${p.pagesCrawled} discovered=${p.pagesDiscovered} remaining=${p.pagesRemaining ?? "-"} skipped=${p.pagesSkipped ?? "-"} failed=${p.pagesFailed ?? "-"} limit=${p.pagesLimit ?? s.limits.maxPages}`;
    if (line !== last) console.log(`     ${label}: ${line}`);
    last = line;
    if (["completed", "completed_with_warnings", "failed", "cancelled"].includes(s.status)) return s;
    assert(Date.now() < deadline, `${label}: timed out`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const summary = {};
let exitCode = 0;
try {
  await step("production server starts", async () => {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${BASE}/api/plans`)).status === 200) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`server did not start:\n${serverLog.slice(-2000)}`);
  });

  await step("public pages load directly without a session (/, /features, /pricing)", async () => {
    for (const p of ["/", "/features", "/pricing"]) {
      const r = await fetch(BASE + p);
      const html = await r.text();
      assert(r.status === 200, `${p} → ${r.status}`);
      if (p === "/") assert(!/What SiteInsights checks|What a report looks like/.test(html), "the homepage still contains a retired section");
      if (p === "/pricing") assert(/Payments coming soon/.test(html), "pricing must say payments are coming soon");
    }
  });

  await step("unauthenticated audit start is refused (401)", async () => {
    const r = await call(null, "/api/scans", { json: { url: AUDIT_URL } });
    assert(r.status === 401, `expected 401, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  });

  await step("paid checkout is refused while no provider is configured (503)", async () => {
    const free = sessionCookie(randomUUID(), "checkout@example.test");
    const r = await call(free, "/api/billing/checkout", { json: { plan: "business" } });
    assert(r.status === 503 && r.body.error?.code === "payments_not_configured", `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  });

  // ---- Free user
  const freeId = randomUUID();
  const free = sessionCookie(freeId, "free@example.test");
  const freeStart = await step("Free account starts with 100 credits on the Free plan", async () => {
    const r = await call(free, "/api/credits?limit=5");
    assert(r.status === 200, `credits ${r.status}`);
    assert(r.body.summary.plan.id === "free" && r.body.summary.balance === 100, JSON.stringify(r.body.summary));
    return r.body.summary;
  });

  await step("Free cannot request more than 25 pages, and a tampered plan field is rejected", async () => {
    const r = await call(free, "/api/scans", { json: { url: AUDIT_URL, maxPages: 150 } });
    assert(r.status === 403 && r.body.error?.code === "page_limit_exceeded", `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const t = await call(free, "/api/scans", { json: { url: AUDIT_URL, maxPages: 25, plan: "business" } });
    assert(t.status === 400, `tampered body should be 400, got ${t.status}`);
  });

  await step("unsafe targets are rejected (SSRF)", async () => {
    for (const url of ["http://127.0.0.1:5432/", "http://169.254.169.254/latest/meta-data/", "http://localhost/"]) {
      const r = await call(free, "/api/scans", { json: { url } });
      assert(r.status === 400 || r.status === 422, `${url} → ${r.status}`);
    }
  });

  const freeAudit = await step("Free audit runs, is capped at 25 pages and settles credits", async () => {
    const r = await call(free, "/api/scans", { json: { url: AUDIT_URL, maxPages: 25 } });
    assert(r.status === 201 || r.status === 200, `start ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    const s = await waitForAudit(free, r.body.id, "free");
    assert(s.status.startsWith("completed"), `status ${s.status}: ${s.error?.message}`);
    assert(s.progress.pagesCrawled <= 25 && s.progress.pagesCrawled >= 20, `pages ${s.progress.pagesCrawled}`);
    const fp = s.progress;
    assert(fp.pagesCrawled + (fp.pagesFailed ?? 0) + (fp.pagesSkipped ?? 0) === fp.pagesDiscovered, `counts do not reconcile: ${JSON.stringify(fp)}`);
    const c = (await call(free, "/api/credits?limit=10")).body;
    const expected = 100 - (10 + s.progress.pagesCrawled);
    assert(c.summary.balance === expected, `balance ${c.summary.balance}, expected ${expected} (10 + ${s.progress.pagesCrawled} pages)`);
    summary.free = { pages: s.progress.pagesCrawled, discovered: s.progress.pagesDiscovered, skipped: s.progress.pagesSkipped, balanceBefore: freeStart.balance, balanceAfter: c.summary.balance, ledger: c.ledger.items.map((e) => `${e.type}:${e.operation}:${e.delta}`) };
    return s;
  });

  await step("Free cannot download a PDF (403) and is not charged", async () => {
    const r = await call(free, `/api/scans/${freeAudit.id}/report.pdf`);
    assert(r.status === 403, `got ${r.status}`);
  });

  await step("another account cannot read the Free user's audit", async () => {
    const other = sessionCookie(randomUUID(), "other@example.test");
    const r = await call(other, `/api/scans/${freeAudit.id}`);
    assert(r.status === 404 || r.status === 403, `got ${r.status}`);
  });

  // ---- Business user (granted by the operator CLI)
  const bizId = randomUUID();
  const biz = sessionCookie(bizId, "business@example.test");
  await step("operator CLI grants Business; the server then reports Business with 3,000 credits", async () => {
    assert((await call(biz, "/api/billing")).status === 200, "first request creates the profile");
    execFileSync(process.execPath, ["scripts/billing/manage-subscription.mjs", "grant", "--user", bizId, "--plan", "business", "--months", "1", "--reason", "Local end-to-end check", "--confirm"], { env: { ...process.env, DATABASE_URL: DB, DATABASE_SSL: "disable" }, stdio: "pipe" });
    const b = (await call(biz, "/api/billing")).body;
    assert(b.plan.id === "business" && b.credits.balance === 3000 && b.credits.plan.maxPagesPerAudit === 500, JSON.stringify(b).slice(0, 400));
    assert(b.payments.state !== "ready", "payments must not be ready");
  });

  const bigAudit = await step(`Business audit crawls more than 100 pages (requested ${BIG_PAGES})`, async () => {
    const r = await call(biz, "/api/scans", { json: { url: AUDIT_URL, maxPages: BIG_PAGES } });
    assert(r.status === 201 || r.status === 200, `start ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    const s = await waitForAudit(biz, r.body.id, "business");
    assert(s.status.startsWith("completed"), `status ${s.status}: ${s.error?.message}`);
    assert(s.progress.pagesCrawled > 100 && s.progress.pagesCrawled <= BIG_PAGES, `pages ${s.progress.pagesCrawled}`);
    const bp = s.progress;
    assert(bp.pagesCrawled + (bp.pagesFailed ?? 0) + (bp.pagesSkipped ?? 0) === bp.pagesDiscovered, `counts do not reconcile: ${JSON.stringify(bp)}`);
    const pages = (await call(biz, `/api/scans/${s.id}/pages?limit=500`));
    const c = (await call(biz, "/api/credits?limit=10")).body;
    const expected = 3000 - (10 + s.progress.pagesCrawled);
    assert(c.summary.balance === expected, `balance ${c.summary.balance}, expected ${expected}`);
    summary.business = { pages: s.progress.pagesCrawled, discovered: s.progress.pagesDiscovered, skipped: s.progress.pagesSkipped, failed: s.progress.pagesFailed, httpErrors: s.progress.pagesHttpErrors, findings: s.summary?.totalFindings, balanceAfter: c.summary.balance, pagesEndpoint: pages.status };
    return s;
  });

  await step("Business downloads a real branded PDF (%PDF, multiple KB)", async () => {
    const r = await call(biz, `/api/scans/${bigAudit.id}/report.pdf`);
    assert(r.status === 200 && Buffer.isBuffer(r.body), `got ${r.status}`);
    assert(r.body.subarray(0, 5).toString() === "%PDF-" && r.body.length > 5000, `bad PDF (${r.body.length} B)`);
    writeFileSync(`${OUT}/e2e-business-report.pdf`, r.body);
    summary.pdfBytes = r.body.length;
  });

  await step("opportunity brief, save as prospect, update status and notes, CSV export", async () => {
    const o = await call(biz, `/api/scans/${bigAudit.id}/opportunity`);
    assert(o.status === 200 && o.body.brief?.headline && Array.isArray(o.body.ranking), `opportunity ${o.status}`);
    const p = await call(biz, "/api/prospects", { json: { auditId: bigAudit.id } });
    assert(p.status === 201, `save ${p.status} ${JSON.stringify(p.body).slice(0, 200)}`);
    const id = p.body.prospect.id;
    const u = await call(biz, `/api/prospects/${id}`, { method: "PATCH", json: { status: "contacted", notes: "=HYPERLINK(\"http://evil\")\nCalled on Monday" } });
    assert(u.status === 200 && u.body.prospect.status === "contacted", `patch ${u.status}`);
    const csv = await call(biz, "/api/prospects/export?status=contacted");
    const text = csv.body.toString("utf8");
    assert(csv.status === 200 && text.includes("books.toscrape.com") && text.includes("'=HYPERLINK"), "CSV must contain the prospect with formula-escaped notes");
    const leak = await call(free, `/api/prospects/${id}`);
    assert(leak.status === 404 || leak.status === 403, `another user read the prospect: ${leak.status}`);
    summary.prospect = { headline: o.body.brief.headline, talkingPoints: o.body.brief.talkingPoints.length };
  });

  await step("share link: public read-only page and PDF work without a session; revoked link 404s", async () => {
    const s = await call(biz, `/api/scans/${bigAudit.id}/shares`, { json: { expiresInDays: 7, label: "Client", allowPdf: true } });
    assert(s.status === 201 && s.body.url, `create ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`);
    const token = new URL(s.body.url).pathname.split("/").pop();
    const page = await fetch(`${BASE}/r/${token}`);
    const html = await page.text();
    assert(page.status === 200 && html.includes("books.toscrape.com") && /noindex/.test(html), `share page ${page.status}`);
    const pdf = await fetch(`${BASE}/api/share/${token}/report.pdf`);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert(pdf.status === 200 && bytes.subarray(0, 5).toString() === "%PDF-", `share pdf ${pdf.status}`);
    const del = await call(biz, `/api/scans/${bigAudit.id}/shares/${s.body.share.id}`, { method: "DELETE", headers: { origin: BASE } });
    assert(del.status === 200, `revoke ${del.status}`);
    // The app's root loading.tsx streams pages, so notFound() renders the 404 page with HTTP 200
    // (a "soft 404"). What matters is that no report content is served; the PDF route returns a real 404.
    const gone = await fetch(`${BASE}/r/${token}`);
    const goneHtml = await gone.text();
    assert(/Page not found/.test(goneHtml) && !goneHtml.includes("books.toscrape.com") && /noindex/.test(goneHtml), `revoked share still shows content (${gone.status})`);
    const gonePdf = await fetch(`${BASE}/api/share/${token}/report.pdf`);
    assert(gonePdf.status === 404, `revoked share PDF → ${gonePdf.status}`);
    summary.revokedShare = { pageStatus: gone.status, pdfStatus: gonePdf.status };
  });

  await step("insufficient credits block an audit and offer a smaller one (402)", async () => {
    const poorId = randomUUID();
    const poor = sessionCookie(poorId, "poor@example.test");
    // Spend the Free allowance down with real audits would take long; instead request more than 100 credits' worth on Free.
    const r = await call(poor, "/api/scans", { json: { url: AUDIT_URL, maxPages: 25 } });
    assert(r.status === 201 || r.status === 200, `first audit ${r.status}`);
    await waitForAudit(poor, r.body.id, "poor-1");
    const r2 = await call(poor, "/api/scans", { json: { url: AUDIT_URL, maxPages: 25 } });
    if (r2.status === 201 || r2.status === 200) await waitForAudit(poor, r2.body.id, "poor-2");
    const r3 = await call(poor, "/api/scans", { json: { url: AUDIT_URL, maxPages: 25 } });
    assert(r3.status === 402 && r3.body.error?.code === "insufficient_credits", `expected 402, got ${r3.status} ${JSON.stringify(r3.body).slice(0, 300)}`);
    const d = r3.body.error.details;
    assert(typeof d.affordablePages === "number" && d.balance < d.required, JSON.stringify(d));
    summary.insufficient = d;
  });
} catch {
  exitCode = 1;
} finally {
  server.kill("SIGTERM");
  jwks.close();
  writeFileSync(`${OUT}/e2e-results.json`, JSON.stringify({ when: new Date().toISOString(), auditUrl: AUDIT_URL, results, summary }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} steps passed`);
  if (exitCode) console.log(serverLog.split("\n").filter((l) => /error|warn/i.test(l)).slice(-20).join("\n"));
  process.exit(exitCode);
}
