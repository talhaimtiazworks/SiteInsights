/**
 * Plans, credits, lead generation and billing — through the REAL route
 * handlers with verified sessions (memory storage). Plan resolution uses the
 * test seam in helpers/plan-override.ts because memory mode has no
 * subscriptions table; the Postgres tests cover subscription-derived plans.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startAuthFixture } from "./helpers/auth-fixture";

vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);
vi.mock("@/lib/services/plan", async (orig) => (await import("./helpers/plan-override")).planModuleMock(await orig()));
vi.mock("@/lib/security/safe-fetch", async (orig) => {
  const m = await orig<typeof import("@/lib/security/safe-fetch")>();
  return { ...m, resolvePublicHost: async (host: string) => (/\.sitelens-fixture\.(com|net)$/.test(host) ? { ok: true as const, addresses: ["203.0.113.10"] } : m.resolvePublicHost(host)) };
});
vi.mock("@/lib/scanner/engine", async (orig) => {
  const m = await orig<typeof import("@/lib/scanner/engine")>();
  const bs = await import("./helpers/big-site");
  return { ...m, advanceScan: (id: string, deps: Parameters<typeof m.advanceScan>[1]) => m.advanceScan(id, { ...deps, fetchOverrides: { lookup: bs.bigSiteLookup(), addressPolicy: bs.bigSitePolicy } }) };
});

import * as advanceRoute from "@/app/api/scans/[id]/advance/route";
import * as cancelRoute from "@/app/api/scans/[id]/cancel/route";
import * as aiRoute from "@/app/api/scans/[id]/findings/[findingId]/ai/route";
import * as opportunityRoute from "@/app/api/scans/[id]/opportunity/route";
import * as sharesRoute from "@/app/api/scans/[id]/shares/route";
import * as shareRevokeRoute from "@/app/api/scans/[id]/shares/[shareId]/route";
import * as scanRoute from "@/app/api/scans/[id]/route";
import * as scansRoute from "@/app/api/scans/route";
import * as creditsRoute from "@/app/api/credits/route";
import * as plansRoute from "@/app/api/plans/route";
import * as billingRoute from "@/app/api/billing/route";
import * as checkoutRoute from "@/app/api/billing/checkout/route";
import * as webhookRoute from "@/app/api/billing/webhooks/[provider]/route";
import * as prospectsRoute from "@/app/api/prospects/route";
import * as prospectImportRoute from "@/app/api/prospects/import/route";
import * as prospectRoute from "@/app/api/prospects/[id]/route";
import * as prospectExportRoute from "@/app/api/prospects/export/route";
import * as batchesRoute from "@/app/api/batches/route";
import * as batchRoute from "@/app/api/batches/[id]/route";
import { __resetConfigForTests } from "@/lib/config/env";
import { __resetRepositoryForTests } from "@/lib/db";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import type { PublicScan } from "@/lib/services/scans";
import { resolveShare } from "@/lib/services/shares";
import type { PlanId } from "@/lib/billing/plans";
import { startBigSite, type BigSite } from "./helpers/big-site";
import { planOverrides } from "./helpers/plan-override";
import { TestBrowser } from "./helpers/route-harness";

const TERMINAL = ["completed", "completed_with_warnings", "failed", "cancelled"];
const SAVED = { ...process.env };
let auth: Awaited<ReturnType<typeof startAuthFixture>>;
let site: BigSite;

interface Summary { balance: number; allowance: number; used: number; affordablePages: number; fullAuditCost: number; plan: { id: string; maxPagesPerAudit: number }; costs: { auditStart: number; perPage: number; aiRequest: number } }
interface LedgerItem { delta: number; balanceAfter: number; type: string; operation: string; auditId: string | null; detail: Record<string, unknown> }

function user(plan: PlanId = "free") {
  const id = randomUUID();
  const b = new TestBrowser(`u-${id.slice(0, 6)}`);
  auth.signIn(b, { userId: id });
  if (plan !== "free") planOverrides.set(`user:${id}`, plan);
  return { b, id, principal: `user:${id}` };
}

const start = (b: TestBrowser, json: Record<string, unknown>, idem?: string) =>
  b.call<PublicScan & { accessKey: string | null }>(scansRoute.POST, "POST", "/api/scans", { json, headers: idem ? { "idempotency-key": idem } : {} });
const credits = (b: TestBrowser) => b.call<{ summary: Summary; ledger: { total: number; items: LedgerItem[] } }>(creditsRoute.GET, "GET", "/api/credits?limit=100");
async function runToEnd(b: TestBrowser, id: string) {
  let last: PublicScan | null = null;
  for (let i = 0; i < 300; i++) {
    const r = await b.call<{ scan: PublicScan | null }>(advanceRoute.POST, "POST", `/api/scans/${id}/advance`, { params: { id }, json: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    last = r.body.data!.scan;
    if (last && TERMINAL.includes(last.status)) return last;
  }
  throw new Error("audit did not finish");
}

beforeAll(async () => {
  auth = await startAuthFixture();
  site = await startBigSite(700);
  process.env = { ...SAVED, NODE_ENV: "test", ALLOW_MEMORY_STORAGE: "true", API_RATE_LIMIT_PER_MINUTE: "100000", SCAN_ALLOWED_PORTS: `${site.port},80,443`, SCAN_CONCURRENCY: "6", SCAN_HOST_MIN_INTERVAL_MS: "0", BACKGROUND_PROCESSING: "false" } as NodeJS.ProcessEnv;
  for (const k of ["DATABASE_URL", "POSTGRES_URL", "BILLING_PROVIDER", "OPENROUTER_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
  auth.configure();
  __resetConfigForTests();
  __resetRepositoryForTests();
}, 30_000);
afterAll(async () => {
  process.env = SAVED;
  __resetConfigForTests();
  __resetRepositoryForTests();
  await site.close();
  await auth.close();
});
beforeEach(() => __resetRateLimitsForTests());

describe("plan limits are enforced on the server", () => {
  it("Free (= everyone) audits are capped at 500 pages; a larger request is refused, not silently clamped", async () => {
    const { b } = user("free");
    const big = await start(b, { url: `${site.origin}/`, maxPages: 501 });
    expect(big.status).toBe(403);
    expect(big.body.error?.code).toBe("page_limit_exceeded");
    expect(big.body.error?.details?.maxPagesPerAudit).toBe(500);
    const r = await start(b, { url: `${site.origin}/`, maxPages: 25 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data!.limits.maxPages).toBe(25);
    const done = await runToEnd(b, r.body.data!.id);
    expect(done.progress.pagesCrawled).toBe(25);
  }, 60_000);

  it("client tampering (plan, credits, limits in the request) cannot raise limits", async () => {
    const { b } = user("free");
    // Unknown fields are rejected outright (400): nothing starts and nothing is reserved.
    for (const extra of [{ plan: "business" }, { credits: 1_000_000 }, { limits: { maxPages: 500 } }]) {
      const r = await start(b, { url: `${site.origin}/`, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    const c = await credits(b);
    expect(c.body.data!.summary.plan.id).toBe("free");
    // The credit balance is inert metadata in the free product: audits don't spend it.
    expect(c.body.data!.summary.balance).toBeGreaterThanOrEqual(0);
    // The deployment cap still decides the technical page limit.
    const ok = await start(b, { url: `${site.origin}/`, maxPages: 25 });
    expect(ok.status).toBe(201);
    expect(ok.body.data!.limits.maxPages).toBe(25);
    await b.call(cancelRoute.POST, "POST", `/api/scans/${ok.body.data!.id}/cancel`, { params: { id: ok.body.data!.id }, json: {} });
  });

  it("Pro audits go beyond 100 pages up to 150", async () => {
    const { b } = user("pro");
    expect((await start(b, { url: `${site.origin}/`, maxPages: 151 })).status).toBe(403);
    const r = await start(b, { url: `${site.origin}/` });
    expect(r.body.data!.limits.maxPages).toBe(150);
    const done = await runToEnd(b, r.body.data!.id);
    expect(done.progress.pagesCrawled).toBe(150);
    expect(done.summary!.pagesScanned).toBe(150);
  }, 120_000);

  it("Business audits go beyond 100 pages up to 500", async () => {
    const { b } = user("business");
    expect((await start(b, { url: `${site.origin}/`, maxPages: 501 })).status).toBe(403);
    const r = await start(b, { url: `${site.origin}/` });
    expect(r.body.data!.limits.maxPages).toBe(500);
    const done = await runToEnd(b, r.body.data!.id);
    expect(done.progress.pagesCrawled).toBe(500);
  }, 240_000);
});

describe("credits", () => {
  it("free product: starting an audit spends nothing — no reservation, no charge, balance untouched", async () => {
    const { b } = user("free");
    const c0 = await credits(b);
    const before = c0.body.data!.summary.balance;
    const r = await start(b, { url: `${site.origin}/`, maxPages: 12 });
    expect(r.status).toBe(201);
    // No reservation happens anymore.
    expect((await credits(b)).body.data!.summary.balance).toBe(before);
    const done = await runToEnd(b, r.body.data!.id);
    expect(done.progress.pagesCrawled).toBe(12);
    // The audit completed with zero charge: the balance is exactly what it was.
    const c1 = await credits(b);
    expect(c1.body.data!.summary.balance).toBe(before);
    // No spend/release ledger entries were created by this audit.
    expect(c1.body.data!.ledger.items.filter((e) => e.auditId === r.body.data!.id && (e.type === "charge" || e.type === "release" || e.type === "reserve"))).toHaveLength(0);
  }, 60_000);

  it("repeated audits are never blocked by a credit balance (402 is gone from the product)", async () => {
    const { b } = user("free");
    for (let i = 0; i < 3; i++) {
      const r = await start(b, { url: `${site.origin}/`, maxPages: 5 });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await runToEnd(b, r.body.data!.id);
    }
    // Nothing can ever report insufficient credits.
    const code = await start(b, { url: `${site.origin}/`, maxPages: 1 });
    expect(code.status).not.toBe(402);
    if (code.status !== 201) expect(code.body.error?.code).not.toBe("insufficient_credits");
    else await runToEnd(b, code.body.data!.id);
  }, 180_000);

  it("cancelling, failing and deleting audits changes nothing in the (inert) credit ledger", async () => {
    const { b } = user("free");
    const before = (await credits(b)).body.data!.summary.balance;
    const r = await start(b, { url: `${site.origin}/`, maxPages: 10 });
    const id = r.body.data!.id;
    const cancel = await b.call<PublicScan>(cancelRoute.POST, "POST", `/api/scans/${id}/cancel`, { params: { id }, json: {} });
    expect(cancel.status).toBe(200);
    let c = await credits(b);
    expect(c.body.data!.summary.balance).toBe(before);
    // robots.txt disallows /private/: the audit fails before any page is fetched.
    const f = await start(b, { url: `${site.origin}/private/secret`, maxPages: 10 });
    const failed = await runToEnd(b, f.body.data!.id);
    expect(failed.status).toBe("failed");
    c = await credits(b);
    expect(c.body.data!.summary.balance).toBe(before);
  }, 60_000);

  it("deleting a running audit is free and idempotent: no charges, no settlement entries", async () => {
    const { b } = user("free");
    const before = (await credits(b)).body.data!.summary.balance;
    const r = await start(b, { url: `${site.origin}/`, maxPages: 30 });
    const id = r.body.data!.id;
    const del = await b.call(scanRoute.DELETE, "DELETE", `/api/scans/${id}`, { params: { id } });
    expect(del.status).toBe(200);
    const c = await credits(b);
    expect(c.body.data!.summary.balance).toBe(before);
    expect(c.body.data!.ledger.items.filter((e) => e.auditId === id)).toHaveLength(0);
  });

  it("concurrent duplicate requests share one audit; distinct parallel requests respect the concurrency cap — never a credit check", async () => {
    const { b } = user("free");
    const dup = await Promise.all([1, 2, 3].map(() => start(b, { url: `${site.origin}/`, maxPages: 10 }, "dupe-key-0001")));
    expect(new Set(dup.map((r) => r.body.data?.id)).size).toBe(1);
    await runToEnd(b, dup[0].body.data!.id);
    // Parallel distinct requests: the technical cap (Free: 1 concurrent) applies; no credit spend anywhere.
    const { b: b2 } = user("free");
    const before = (await credits(b2)).body.data!.summary.balance;
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => start(b2, { url: `${site.origin}/p/${i}`, maxPages: 5 }, `par-key-000${i}`)));
    // None can fail for credits; only the concurrency/capacity codes may appear.
    for (const r of rs) expect(r.body.error?.code, JSON.stringify(r.body)).not.toBe("insufficient_credits");
    const created = rs.filter((r) => r.status === 201).length;
    for (const r of rs.filter((x) => x.status === 201)) await runToEnd(b2, r.body.data!.id);
    expect(created).toBeGreaterThanOrEqual(1);
    const after = (await credits(b2)).body.data!.summary.balance;
    expect(after).toBe(before);
  }, 120_000);

  it("AI explanations are free for every signed-in owner (only a technical window applies)", async () => {
    const { b } = user("free");
    const r = await start(b, { url: `${site.origin}/`, maxPages: 3 });
    const id = r.body.data!.id;
    await runToEnd(b, id);
    const ai = await b.call(aiRoute.POST, "POST", `/api/scans/${id}/findings/f_00000000000000000000/ai`, { params: { id, findingId: "f_00000000000000000000" }, json: {} });
    // Strict BYOK: with no user key the request is rejected BEFORE any plan/provider logic —
    // a 400 with a "bring your own key" message (never a 5xx and never an owner-key fallback).
    expect(ai.status).toBe(400);
    expect(ai.body.error?.code).toBe("ai_key_required");
    expect(String(ai.body.error?.message).toLowerCase()).toContain("your own provider key");
    // With a (test-shaped) key the request proceeds to finding lookup — not a plan gate.
    const withKey = await b.call(aiRoute.POST, "POST", `/api/scans/${id}/findings/f_00000000000000000000/ai`, { params: { id, findingId: "f_00000000000000000000" }, json: { provider: "openrouter", apiKey: "sk-test-user-key-0001" } });
    expect([404, 429]).toContain(withKey.status);
    if (withKey.status === 404) expect(withKey.body.error?.code).toBe("finding_not_found"); // unknown finding id
  }, 60_000);
});

describe("billing without a configured provider", () => {
  it("exposes public plans, refuses checkout with 'payments coming soon' and hides webhooks", async () => {
    const anon = new TestBrowser("anon");
    const plans = await anon.call<{ plans: Array<{ id: string; maxPagesPerAudit: number; monthlyCredits: number; priceUsd: number }>; payments: { available: boolean; message: string } }>(plansRoute.GET, "GET", "/api/plans");
    expect(plans.status).toBe(200);
    // Historical catalog data stays exposed for migration/audit purposes; the Free entry now grants everyone everything.
    expect(plans.body.data!.plans.map((p) => [p.id, p.priceUsd, p.monthlyCredits, p.maxPagesPerAudit])).toEqual([["free", 0, 100_000, 500], ["pro", 5, 1000, 150], ["business", 10, 3000, 500]]);
    expect(plans.body.data!.payments.available).toBe(false);
    const { b } = user("free");
    const co = await b.call(checkoutRoute.POST, "POST", "/api/billing/checkout", { json: { plan: "business" } });
    expect(co.status).toBe(503);
    expect(co.body.error?.code).toBe("payments_not_configured");
    // No sale happens on this deployment and the client is told to use the free product.
    expect(co.body.error?.message).toMatch(/free/i);
    const wh = await anon.call(webhookRoute.POST, "POST", "/api/billing/webhooks/stripe", { params: { provider: "stripe" }, json: { type: "subscription.activated", plan: "business" } });
    expect(wh.status).toBe(404);
    const ov = await b.call<{ plan: { id: string }; payments: { state: string } }>(billingRoute.GET, "GET", "/api/billing");
    expect(ov.body.data!.plan.id).toBe("free");
    expect(ov.body.data!.payments.state).toBe("not_configured");
  });
});

describe("lead generation (Business)", () => {
  let owner: ReturnType<typeof user>;
  let auditId: string;
  beforeAll(async () => {
    owner = user("business");
    const r = await start(owner.b, { url: `${site.origin}/`, maxPages: 8 });
    auditId = r.body.data!.id;
    await runToEnd(owner.b, auditId);
  }, 60_000);

  it("free product: prospects are available to every signed-in user (old plan gates became normal features)", async () => {
    // Free — the plan everyone actually uses — has the prospect list enabled.
    {
      const { b } = user("free");
      const r = await b.call(prospectsRoute.POST, "POST", "/api/prospects", { json: { auditId } });
      expect([200, 201, 404]).toContain(r.status);
      expect(r.body.error?.code).not.toBe("plan_feature_unavailable");
    }
    // The historical Pro catalog entry lacks prospect access and honestly says the feature is disabled.
    {
      const { b } = user("pro");
      const r = await b.call(prospectsRoute.POST, "POST", "/api/prospects", { json: { auditId } });
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toBe("feature_unavailable");
    }
  });

  it("saves a prospect from verified audit data, refreshes instead of duplicating, and keeps it private", async () => {
    const r1 = await owner.b.call<{ prospect: { id: string; status: string; evidence: { pagesScanned: number } }; created: boolean }>(prospectsRoute.POST, "POST", "/api/prospects", { json: { auditId } });
    expect(r1.status).toBe(201);
    expect(r1.body.data!.prospect.status).toBe("new");
    expect(r1.body.data!.prospect.evidence.pagesScanned).toBe(8);
    const r2 = await owner.b.call<{ created: boolean }>(prospectsRoute.POST, "POST", "/api/prospects", { json: { auditId } });
    expect(r2.status).toBe(200);
    expect(r2.body.data!.created).toBe(false);
    const id = r1.body.data!.prospect.id;
    // Another Business account cannot read, change or delete it (identical 404).
    const other = user("business");
    expect((await other.b.call(prospectRoute.GET, "GET", `/api/prospects/${id}`, { params: { id } })).status).toBe(404);
    expect((await other.b.call(prospectRoute.PATCH, "PATCH", `/api/prospects/${id}`, { params: { id }, json: { status: "converted" } })).status).toBe(404);
    expect((await other.b.call(prospectRoute.DELETE, "DELETE", `/api/prospects/${id}`, { params: { id } })).status).toBe(404);
    expect((await other.b.call<{ total: number }>(prospectsRoute.GET, "GET", "/api/prospects")).body.data!.total).toBe(0);
    // Nor save one from somebody else's audit.
    expect((await other.b.call(prospectsRoute.POST, "POST", "/api/prospects", { json: { auditId } })).status).toBe(404);
  });

  it("supports manual prospect entry and validates CSV rows before any writes", async () => {
    const suffix = randomUUID().slice(0, 8);
    const manual = await owner.b.call<{ prospect: { websiteUrl: string; businessName: string; location: string; auditId: string | null; evidence: unknown }; created: boolean }>(prospectsRoute.POST, "POST", "/api/prospects", {
      json: { websiteUrl: `https://manual-${suffix}.example.com/services`, businessName: "Manual Studio", location: "Karachi" },
    });
    expect(manual.status).toBe(201);
    expect(manual.body.data!.prospect).toMatchObject({ websiteUrl: `https://manual-${suffix}.example.com/`, businessName: "Manual Studio", location: "Karachi", auditId: null, evidence: null });
    const imported = await owner.b.call<{ imported: number; created: number; duplicatesSkipped: number }>(prospectImportRoute.POST, "POST", "/api/prospects/import", {
      json: { csv: `website,business name,location\nhttps://import-${suffix}.example.com,Imported Studio,Karachi\nhttps://import-${suffix}.example.com/other,Duplicate,` },
    });
    expect(imported.status).toBe(200);
    expect(imported.body.data).toMatchObject({ imported: 1, created: 1, duplicatesSkipped: 1 });
    const beforeInvalid = (await owner.b.call<{ total: number }>(prospectsRoute.GET, "GET", "/api/prospects")).body.data!.total;
    const invalid = await owner.b.call(prospectImportRoute.POST, "POST", "/api/prospects/import", {
      json: { csv: "website\nhttps://valid.example.com\nhttp://127.0.0.1/admin" },
    });
    expect(invalid.status).toBe(400);
    expect((await owner.b.call<{ total: number }>(prospectsRoute.GET, "GET", "/api/prospects")).body.data!.total).toBe(beforeInvalid);
  });

  it("updates status and notes (sanitised), validates contact fields and exports injection-safe CSV", async () => {
    const list = await owner.b.call<{ items: Array<{ id: string }> }>(prospectsRoute.GET, "GET", "/api/prospects");
    const id = list.body.data!.items[0].id;
    const bad = await owner.b.call(prospectRoute.PATCH, "PATCH", `/api/prospects/${id}`, { params: { id }, json: { contactEmail: "not-an-email" } });
    expect(bad.status).toBe(400);
    const badUrl = await owner.b.call(prospectRoute.PATCH, "PATCH", `/api/prospects/${id}`, { params: { id }, json: { contactUrl: "javascript:alert(1)" } });
    expect(badUrl.status).toBe(400);
    const up = await owner.b.call<{ prospect: { status: string; notes: string; contactEmail: string } }>(prospectRoute.PATCH, "PATCH", `/api/prospects/${id}`, {
      params: { id },
      json: { status: "contacted", notes: "=HYPERLINK(\"http://evil\")\u0000\u202E hidden", contactEmail: "Owner@Example.com" },
    });
    expect(up.status).toBe(200);
    expect(up.body.data!.prospect.status).toBe("contacted");
    expect(up.body.data!.prospect.notes).toBe('=HYPERLINK("http://evil") hidden');
    expect(up.body.data!.prospect.contactEmail).toBe("owner@example.com");
    const filtered = await owner.b.call<{ total: number; items: Array<{ id: string }> }>(prospectsRoute.GET, "GET", "/api/prospects?status=new");
    expect(filtered.body.data!.items.some((prospect) => prospect.id === id)).toBe(false);
    const csv = await owner.b.call(prospectExportRoute.GET, "GET", "/api/prospects/export");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    const text = new TextDecoder().decode(csv.bytes);
    expect(text).toContain(`"'=HYPERLINK(""http://evil"") hidden"`);
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it("builds an opportunity brief only from verified findings, with evidence and caveats", async () => {
    const r = await owner.b.call<{ brief: { headline: string; talkingPoints: Array<{ evidence: string; exampleUrls: string[] }>; caveats: string[] }; source: string }>(opportunityRoute.GET, "GET", `/api/scans/${auditId}/opportunity`, { params: { id: auditId } });
    expect(r.status).toBe(200);
    expect(r.body.data!.source).toBe("verified_findings");
    expect(r.body.data!.brief.headline).toMatch(/8 pages checked/);
    for (const t of r.body.data!.brief.talkingPoints) expect(t.evidence.length).toBeGreaterThan(0);
    expect(r.body.data!.brief.caveats.join(" ")).toMatch(/does not find contact details or send messages/);
  });

  it("creates a revocable client share link for everyone (free product)", async () => {
    const created = await owner.b.call<{ url: string; share: { id: string; active: boolean; snapshotVersion: number } }>(sharesRoute.POST, "POST", `/api/scans/${auditId}/shares`, { params: { id: auditId }, json: { expiresInDays: 7, label: "Acme" } });
    expect(created.status).toBe(201);
    expect(created.body.data!.share.snapshotVersion).toBe(1);
    const token = created.body.data!.url.split("/r/")[1];
    const resolved = await resolveShare(token);
    expect(resolved.scan.id).toBe(auditId);
    expect(resolved.snapshot).toMatchObject({ version: 1, auditId, content: { schemaVersion: 1, scan: { id: auditId } } });
    const second = await owner.b.call<{ share: { snapshotVersion: number } }>(sharesRoute.POST, "POST", `/api/scans/${auditId}/shares`, { params: { id: auditId }, json: { expiresInDays: 7 } });
    expect(second.body.data!.share.snapshotVersion).toBe(2);
    await expect(resolveShare(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).rejects.toMatchObject({ status: 404 });
    const shareId = created.body.data!.share.id;
    expect((await owner.b.call(shareRevokeRoute.DELETE, "DELETE", `/api/scans/${auditId}/shares/${shareId}`, { params: { id: auditId, shareId } })).status).toBe(200);
    await expect(resolveShare(token)).rejects.toMatchObject({ status: 404 });
    const free = user("free");
    const fr = await start(free.b, { url: `${site.origin}/`, maxPages: 2 });
    await runToEnd(free.b, fr.body.data!.id);
    const alsoOk = await free.b.call(sharesRoute.POST, "POST", `/api/scans/${fr.body.data!.id}/shares`, { params: { id: fr.body.data!.id }, json: {} });
    expect(alsoOk.status).toBe(201);
  }, 60_000);

  it("queues batch audits within the concurrency limit and validates every URL", async () => {
    const { b } = user("business");
    const invalid = await b.call(batchesRoute.POST, "POST", "/api/batches", { json: { urls: [`${site.origin}/`, "http://127.0.0.1/admin"] } });
    expect(invalid.status).toBe(400);
    const r = await b.call<{ batch: { id: string; items: Array<{ status: string; auditId: string | null }> } }>(batchesRoute.POST, "POST", "/api/batches", { json: { urls: [`${site.origin}/`, `http://${"elsewhere.sitelens-fixture.net"}:${site.port}/`], maxPages: 3 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const items = r.body.data!.batch.items;
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.status === "started").length).toBeGreaterThanOrEqual(1);
    const got = await b.call<{ batch: { items: Array<{ audit: PublicScan | null }> } }>(batchRoute.GET, "GET", `/api/batches/${r.body.data!.batch.id}`, { params: { id: r.body.data!.batch.id } });
    expect(got.status).toBe(200);
    const free = user("free");
    const fb = await free.b.call(batchesRoute.POST, "POST", "/api/batches", { json: { urls: [`${site.origin}/`] } });
    expect(fb.status).toBe(201);
    expect((fb.body.data as { maxCost: number }).maxCost).toBe(0);
  }, 60_000);
});
