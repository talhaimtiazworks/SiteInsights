import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);
vi.mock("@/lib/security/safe-fetch", async (original) => ({ ...await original<typeof import("@/lib/security/safe-fetch")>(), resolvePublicHost: async () => ({ ok: true as const, addresses: ["203.0.113.10"] }) }));

import { __resetConfigForTests, getConfig } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository } from "@/lib/db";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import { startScan, runScanStep, hashScanKey, newScanKey } from "@/lib/services/scans";
import { driveScan } from "@/lib/services/background";
import { assertAuditAccount, isAccountClaims } from "@/lib/auth/audit-policy";
import { createScanJob } from "@/lib/scanner/engine";
import { startAuthFixture } from "./helpers/auth-fixture";
import { TestBrowser } from "./helpers/route-harness";
import * as scans from "@/app/api/scans/route";
import * as scan from "@/app/api/scans/[id]/route";
import * as advance from "@/app/api/scans/[id]/advance/route";
import * as rerun from "@/app/api/scans/[id]/rerun/route";
import * as background from "@/app/api/internal/process/route";
import * as session from "@/app/api/auth/session/route";

const SAVED = { ...process.env };
const ID = "11111111-2222-4333-8444-555555555555";
let auth: Awaited<ReturnType<typeof startAuthFixture>>;

beforeAll(async () => { auth = await startAuthFixture(); });
afterAll(async () => { await auth.close(); process.env = { ...SAVED }; __resetConfigForTests(); __resetRepositoryForTests(); });
beforeEach(() => {
  process.env = { ...SAVED, NODE_ENV: "test", ALLOW_MEMORY_STORAGE: "true", BACKGROUND_PROCESSING: "false", ANONYMOUS_AUDITS_ENABLED: "true", API_RATE_LIMIT_PER_MINUTE: "10000", CRON_SECRET: "local-test-only-cron-authorization-value" };
  for (const key of ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_URL_NON_POOLING", "VERCEL"]) delete process.env[key];
  auth.configure(); __resetConfigForTests(); __resetRepositoryForTests(); __resetRateLimitsForTests();
});

const start = (browser: TestBrowser, json: unknown = { url: "https://example.com/" }) => browser.call<{ id: string; accessKey: string }>(scans.POST, "POST", "/api/scans", { json, headers: { "idempotency-key": "mandatory-auth-test" } });
function signed(options: Parameters<typeof auth.signIn>[1] = {}) { const browser = new TestBrowser(); auth.signIn(browser, options); return browser; }

// Every public audit verb is covered, including read, export and mutation paths, not just the start button.
const endpoints = [
  ["/api/scans", "GET", () => import("@/app/api/scans/route")],
  ["/api/scans", "POST", () => import("@/app/api/scans/route")],
  ["/api/scans/compare", "GET", () => import("@/app/api/scans/compare/route")],
  ["/api/audits", "GET", () => import("@/app/api/audits/route")],
  ["/api/dashboard", "GET", () => import("@/app/api/dashboard/route")],
  [`/api/scans/${ID}`, "GET", () => import("@/app/api/scans/[id]/route")],
  [`/api/scans/${ID}`, "PATCH", () => import("@/app/api/scans/[id]/route")],
  [`/api/scans/${ID}`, "DELETE", () => import("@/app/api/scans/[id]/route")],
  [`/api/scans/${ID}/advance`, "POST", () => import("@/app/api/scans/[id]/advance/route")],
  [`/api/scans/${ID}/rerun`, "POST", () => import("@/app/api/scans/[id]/rerun/route")],
  [`/api/scans/${ID}/cancel`, "POST", () => import("@/app/api/scans/[id]/cancel/route")],
  [`/api/scans/${ID}/results`, "GET", () => import("@/app/api/scans/[id]/results/route")],
  [`/api/scans/${ID}/findings`, "GET", () => import("@/app/api/scans/[id]/findings/route")],
  [`/api/scans/${ID}/findings/${ID}`, "GET", () => import("@/app/api/scans/[id]/findings/[findingId]/route")],
  [`/api/scans/${ID}/findings/${ID}`, "PATCH", () => import("@/app/api/scans/[id]/findings/[findingId]/route")],
  [`/api/scans/${ID}/findings/${ID}/ai`, "POST", () => import("@/app/api/scans/[id]/findings/[findingId]/ai/route")],
  [`/api/scans/${ID}/ai-summary`, "GET", () => import("@/app/api/scans/[id]/ai-summary/route")],
  [`/api/scans/${ID}/ai-summary`, "POST", () => import("@/app/api/scans/[id]/ai-summary/route")],
  [`/api/scans/${ID}/links`, "GET", () => import("@/app/api/scans/[id]/links/route")],
  [`/api/scans/${ID}/pages`, "GET", () => import("@/app/api/scans/[id]/pages/route")],
  [`/api/scans/${ID}/report.pdf`, "GET", () => import("@/app/api/scans/[id]/report.pdf/route")],
] as const;

describe("mandatory account sessions: no anonymous audit execution", () => {
  it.each(endpoints)("rejects logged-out %s %s before reading or changing audit data", async (path, method, load) => {
    const handlers = await load();
    const handler = (handlers as Record<string, unknown>)[method] as Parameters<TestBrowser["call"]>[0];
    expect(handler, `handler missing for ${method} ${path}`).toBeTypeOf("function");
    const browser = new TestBrowser();
    await browser.visit("/"); // anonymous cookie is NOT authentication
    const response = await browser.call(handler, method, path, { params: { id: ID, findingId: ID }, json: method === "GET" ? undefined : { url: "https://example.com/", userId: ID, isAuthenticated: true }, headers: { "x-user-id": ID, "x-is-authenticated": "true", "x-scan-key": "sk_" + "A".repeat(43) } });
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(response.body.error?.code).toBe("auth_required");
    expect(await getRepository().countScans(browser.cookies.get("sl_pid")!)).toBe(0);
  });

  it("fails closed with Auth absent, even if anonymous audits are explicitly enabled", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    __resetConfigForTests();
    expect(getConfig().auth.anonymousAudits).toBe(false);
    const browser = new TestBrowser();
    expect((await start(browser)).status).toBe(401);
    expect((await browser.call(advance.POST, "POST", `/api/scans/${ID}/advance`, { params: { id: ID }, json: {} })).status).toBe(401);
    expect((await browser.call(rerun.POST, "POST", `/api/scans/${ID}/rerun`, { params: { id: ID }, json: {} })).status).toBe(401);
  });

  it.each([{ expired: true }, { tampered: true }, { anonymous: true }])("rejects invalid, expired or Supabase-anonymous JWTs: %j", async (options) => {
    const response = await start(signed(options));
    expect(response.status, JSON.stringify(response.body)).toBe(401);
    expect(["session_expired", "auth_required"]).toContain(response.body.error?.code);
  });

  it("verifies a valid RSA session through the real SDK, creates one account-owned audit, and safely replays an authenticated request", async () => {
    const browser = signed();
    const info = await browser.call<{ status: string; user: { id: string } }>(session.GET, "GET", "/api/auth/session");
    expect(info.body.data?.status).toBe("signed_in");
    const first = await start(browser);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const saved = await getRepository().getScan(first.body.data!.id);
    expect(saved?.principalId).toBe(`user:${info.body.data!.user.id}`);
    expect(saved?.status).toBe("queued");
    const replay = await start(browser);
    expect(replay.status).toBe(200);
    expect(replay.body.data!.id).toBe(first.body.data!.id);
    browser.clearCookies();
    const anonymousReplay = await start(browser);
    expect(anonymousReplay.status).toBe(401); // an idempotency key cannot bypass authentication
  });

  it("another signed-in account cannot read, change or advance a report even with the owner's real legacy key", async () => {
    const owner = signed(); const other = signed();
    const created = (await start(owner)).body.data!;
    other.scanKeys.set(created.id, created.accessKey);
    const result = await other.call(scan.GET, "GET", `/api/scans/${created.id}`, { params: { id: created.id } });
    expect(result.status).toBe(404);
    expect((await other.call(advance.POST, "POST", `/api/scans/${created.id}/advance`, { params: { id: created.id }, json: {} })).status).toBe(404);
    expect((await other.call(scan.DELETE, "DELETE", `/api/scans/${created.id}`, { params: { id: created.id } })).status).toBe(404);
    expect((await owner.call(scan.GET, "GET", `/api/scans/${created.id}`, { params: { id: created.id } })).status).toBe(200);
  });

  it("denies external background triggers without the trusted service secret", async () => {
    const browser = new TestBrowser();
    for (const method of ["GET", "POST"] as const) {
      const response = await browser.call(background[method], method, "/api/internal/process", { json: method === "POST" ? { scanId: ID, hop: 0 } : undefined });
      expect(response.status).toBe(401);
    }
  });

  it("fails closed when the trusted background secret is unconfigured", async () => {
    delete process.env.CRON_SECRET;
    __resetConfigForTests();
    const browser = new TestBrowser();
    for (const method of ["GET", "POST"] as const) expect((await browser.call(background[method], method, "/api/internal/process", { json: method === "POST" ? {} : undefined })).status).toBe(401);
  });

  it("never executes an old anonymous job, even through the trusted background service", async () => {
    const cfg = getConfig();
    const limits = { ...cfg.scanner, stepBudgetMs: 1 };
    const job = createScanJob({ principalId: ID, websiteId: null, targetUrl: "https://example.com/", limits });
    const key = newScanKey(); job.access = { keyHash: hashScanKey(key), idempotencyKey: null };
    await getRepository().createScan(job);
    expect(await driveScan(job.id, 100)).toBe(true);
    expect((await getRepository().getScan(job.id))?.status).toBe("queued");
    await expect(runScanStep(job, { ipHash: "test" })).rejects.toMatchObject({ status: 401, code: "auth_required" });
  });

  it("service-level defense rejects forged identity mismatches before touching storage or DNS", async () => {
    expect(() => assertAuditAccount({ principalId: `user:${ID}`, user: { id: ID }, auth: "anonymous" })).toThrow();
    expect(() => assertAuditAccount({ principalId: "different", user: { id: ID }, auth: "signed_in" })).toThrow();
    expect(isAccountClaims({ sub: ID, role: "service_role", exp: Date.now() / 1000 + 1000 })).toBe(false);
    await expect(startScan({ principalId: ID, anonymousPrincipalId: ID, auth: "disabled", user: null, scanKey: null, ipHash: "test", isNewPrincipal: false }, "https://example.com/")).rejects.toMatchObject({ status: 401 });
  });
});
