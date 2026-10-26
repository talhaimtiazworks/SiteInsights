/**
 * Regression tests for the production "Scan not found" defect.
 *
 * Root cause (reproduced below): with no DATABASE_URL, scans were stored in
 * per-process memory. On serverless hosting each request may run on a
 * different instance, so the progress page's next request could not find the
 * scan that the previous request created → 404 "Scan not found".
 * A second, independent defect: parallel first-visit API calls minted
 * different anonymous IDs, so a scan could appear to belong to someone else.
 *
 * These tests drive the REAL route handlers and proxy.ts through a simulated
 * browser. Postgres variants run when TEST_DATABASE_URL is set.
 */
import { startAuthFixture } from "./helpers/auth-fixture";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);
// The fixture site lives on 127.0.0.1 under public-looking hostnames. Only for
// those test hostnames, DNS answers are substituted; all other validation is real.
vi.mock("@/lib/security/safe-fetch", async (orig) => {
  const m = await orig<typeof import("@/lib/security/safe-fetch")>();
  return {
    ...m,
    resolvePublicHost: async (host: string) =>
      /\.sitelens-fixture\.(com|net)$/.test(host) ? { ok: true as const, addresses: ["203.0.113.10"] } : m.resolvePublicHost(host),
  };
});
vi.mock("@/lib/scanner/engine", async (orig) => {
  const m = await orig<typeof import("@/lib/scanner/engine")>();
  const fx = await import("./helpers/fixture-server");
  return { ...m, advanceScan: (id: string, deps: Parameters<typeof m.advanceScan>[1]) => m.advanceScan(id, { ...deps, fetchOverrides: { lookup: fx.fixtureLookup(), addressPolicy: fx.fixturePolicy } }) };
});

import * as scanRoute from "@/app/api/scans/[id]/route";
import * as advanceRoute from "@/app/api/scans/[id]/advance/route";
import * as cancelRoute from "@/app/api/scans/[id]/cancel/route";
import * as resultsRoute from "@/app/api/scans/[id]/results/route";
import * as scansRoute from "@/app/api/scans/route";
import * as usageRoute from "@/app/api/usage/route";
import { __resetConfigForTests, getConfig, loadConfig } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository, StorageNotConfiguredError, storageInfo } from "@/lib/db";
import type { PostgresRepository } from "@/lib/db/postgres";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import { NEW_PRINCIPAL_HEADER } from "@/lib/http/session";
import type { PublicScan } from "@/lib/services/scans";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server";
import { TestBrowser, type CallResult } from "./helpers/route-harness";

const TERMINAL = ["completed", "completed_with_warnings", "failed", "cancelled"];
const PG_URL = process.env.TEST_DATABASE_URL;
const SAVED_ENV = { ...process.env };

let auth: Awaited<ReturnType<typeof startAuthFixture>>;
function signedBrowser(name?: string) { const browser = new TestBrowser(name); auth.signIn(browser); return browser; }

let srv: FixtureServer;
let target: string;

type Started = PublicScan & { accessKey: string | null };

function setEnv(vars: Record<string, string | undefined>) {
  for (const k of ["DATABASE_URL", "DATABASE_SSL", "VERCEL", "ALLOW_MEMORY_STORAGE", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY"]) delete process.env[k];
  auth.configure();
  process.env.SCAN_ALLOWED_PORTS = `${srv.port},80,443`;
  process.env.API_RATE_LIMIT_PER_MINUTE = "10000";
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Simulates the next request landing on a fresh server instance. */
async function newInstance(opts: { keepMemory?: boolean } = {}) {
  try {
    const old = getRepository();
    if (old.kind === "postgres") await (old as PostgresRepository).close();
  } catch {
    /* unconfigured */
  }
  __resetConfigForTests();
  __resetRepositoryForTests(opts);
}

async function start(b: TestBrowser, idem?: string): Promise<CallResult<Started>> {
  const r = await b.call<Started>(scansRoute.POST, "POST", "/api/scans", { json: { url: target }, headers: idem ? { "idempotency-key": idem } : {} });
  if (r.body.data?.accessKey) b.scanKeys.set(r.body.data.id, r.body.data.accessKey);
  return r;
}
const status = (b: TestBrowser, id: string, o: { sendScanKey?: boolean } = {}) => b.call<PublicScan>(scanRoute.GET, "GET", `/api/scans/${id}`, { params: { id }, ...o });
const advance = (b: TestBrowser, id: string) => b.call<{ scan: PublicScan | null; leaseBusy: boolean }>(advanceRoute.POST, "POST", `/api/scans/${id}/advance`, { params: { id }, json: {} });
const results = (b: TestBrowser, id: string) => b.call<{ scan: PublicScan; findings: Array<{ id: string }>; pages: Array<{ url: string }> }>(resultsRoute.GET, "GET", `/api/scans/${id}/results`, { params: { id } });

async function runToEnd(b: TestBrowser, id: string, between?: () => Promise<void>) {
  let last: PublicScan | null = null;
  for (let i = 0; i < 80; i++) {
    if (between) await between();
    const r = await advance(b, id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    last = r.body.data!.scan;
    if (last && TERMINAL.includes(last.status)) break;
  }
  return last!;
}

beforeAll(async () => {
  auth = await startAuthFixture();
  srv = await startFixtureServer();
  target = `http://site.sitelens-fixture.com:${srv.port}/`;
});
afterAll(async () => {
  await newInstance();
  process.env = { ...SAVED_ENV };
  __resetConfigForTests();
  await srv?.close();
  await auth?.close();
});
beforeEach(() => __resetRateLimitsForTests());

// ──────────────────────────────────────────────────────────────────────────────
describe("reproduction of the original defect", () => {
  afterEach(() => newInstance());

  it("per-instance memory storage loses a scan when the next request hits another instance (pre-fix behaviour)", async () => {
    setEnv({ ALLOW_MEMORY_STORAGE: "true" });
    await newInstance();
    const b = signedBrowser();
    await b.visit("/");
    const created = await start(b);
    expect(created.status).toBe(201);
    const id = created.body.data!.id;
    expect((await status(b, id)).status).toBe(200); // same instance: found

    await newInstance(); // next request is served by a different instance with empty memory
    const r = await status(b, id);
    expect(r.status).toBe(404); // exactly what users saw: "Scan not found"
    expect(r.body.error?.code).toBe("not_found");
  });

  it("FIX: on serverless hosting without a database, audits are refused with a setup error instead of silently vanishing", async () => {
    setEnv({ VERCEL: "1", ALLOW_MEMORY_STORAGE: "true" }); // the override must not apply on serverless
    await newInstance();
    expect(getConfig().warnings.join(" ")).toMatch(/ALLOW_MEMORY_STORAGE is ignored on serverless/);
    const b = signedBrowser();
    await b.visit("/");
    const r = await start(b);
    expect(r.status).toBe(503);
    expect(r.body.error?.code).toBe("storage_not_configured");
    const g = await status(b, "3f1d2c4b-1a2b-4c3d-8e9f-0a1b2c3d4e5f");
    expect(g.status).toBe(503);
    expect(g.body.error?.code).toBe("storage_not_configured");
  });

  it("FIX: the session cookie is issued on the first page load, so parallel API calls share one identity", async () => {
    setEnv({ ALLOW_MEMORY_STORAGE: "true" });
    await newInstance();
    const b = signedBrowser();
    await b.visit("/");
    const pid = b.cookies.get("sl_pid");
    expect(pid).toMatch(/^[0-9a-f-]{36}$/);
    const before = new Map(b.cookies);
    await Promise.all([b.call(usageRoute.GET, "GET", "/api/usage"), b.call(scansRoute.GET, "GET", "/api/scans"), b.call(usageRoute.GET, "GET", "/api/usage")]);
    expect(b.cookies).toEqual(before);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
describe("storage selection", () => {
  afterEach(() => newInstance());
  const pick = async (vars: Record<string, string | undefined>) => {
    setEnv(vars);
    await newInstance();
    return storageInfo();
  };

  it("uses PostgreSQL whenever DATABASE_URL is set (also on serverless)", async () => {
    expect((await pick({ DATABASE_URL: "postgres://u:p@db.example.com:5432/x", VERCEL: "1" })).mode).toBe("postgres");
    expect(getRepository().kind).toBe("postgres"); // constructed lazily, no connection needed
  });
  it("refuses memory storage on serverless platforms", async () => {
    for (const vars of [{ VERCEL: "1" }, { AWS_LAMBDA_FUNCTION_NAME: "fn" }, { NETLIFY: "true" }]) {
      expect((await pick(vars)).mode).toBe("unconfigured");
      expect(() => getRepository()).toThrow(StorageNotConfiguredError);
    }
  });
  it("requires an explicit opt-in for memory storage on other production servers", () => {
    expect(loadConfig({ NODE_ENV: "production" }).storage.allowMemory).toBe(false);
    expect(loadConfig({ NODE_ENV: "production", ALLOW_MEMORY_STORAGE: "true" }).storage.allowMemory).toBe(true);
    expect(loadConfig({ NODE_ENV: "development" }).storage.allowMemory).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
const MODES: Array<{ name: string; env: () => Record<string, string>; multiInstance: boolean }> = [
  { name: "memory (single server)", env: () => ({ ALLOW_MEMORY_STORAGE: "true" }), multiInstance: false },
  ...(PG_URL ? [{ name: "postgres (multiple instances)", env: () => ({ DATABASE_URL: PG_URL, DATABASE_SSL: "disable" }), multiInstance: true }] : []),
];

describe.each(MODES)("scan lifecycle through the API — $name", ({ env, multiInstance }) => {
  /** Between requests: a different instance when storage is shared, the same instance otherwise. */
  const hop = () => (multiInstance ? newInstance() : Promise.resolve());

  beforeEach(async () => {
    setEnv(env());
    await newInstance();
  });
  afterAll(() => newInstance());

  it("1. starts a scan and returns its status (no server-only data exposed)", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const r = await start(b);
    expect(r.status).toBe(201);
    const data = r.body.data!;
    expect(data.accessKey).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(data)).not.toMatch(/keyHash|principalId|idempotency|"state"/);
    await hop();
    const s = await status(b, data.id);
    expect(s.status).toBe(200);
    expect(s.body.data!.id).toBe(data.id);
    expect(s.body.data!.status).toBe("queued");
  });

  it("2. runs a scan to completion and opens its results", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const id = (await start(b)).body.data!.id;
    const final = await runToEnd(b, id, hop);
    expect(["completed", "completed_with_warnings"]).toContain(final.status);
    await hop();
    const r = await results(b, id);
    expect(r.status).toBe(200);
    expect(r.body.data!.scan.id).toBe(id);
    expect(r.body.data!.findings.length).toBeGreaterThan(5);
  });

  it("3–4. refreshing the progress and results pages returns the same data", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const id = (await start(b)).body.data!.id;
    await runToEnd(b, id);
    const reads = [];
    for (let i = 0; i < 3; i++) {
      await hop();
      reads.push(await status(b, id));
    }
    expect(reads.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(reads.map((r) => `${r.body.data!.status}|${r.body.data!.updatedAt}`)).size).toBe(1);
    await hop();
    const r1 = await results(b, id);
    await hop();
    const r2 = await results(b, id);
    expect(r1.status).toBe(200);
    expect(r2.body.data!.findings.map((f) => f.id)).toEqual(r1.body.data!.findings.map((f) => f.id));
  });

  it("5. an unfinished scan resumes where it stopped instead of restarting", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const id = (await start(b)).body.data!.id;
    // Make each server step tiny so the scan needs many requests (data change only).
    const repo = getRepository();
    if (repo.kind === "postgres") {
      const sql = postgres(PG_URL!, { max: 1, onnotice: () => {} });
      await sql`UPDATE audits SET limits = jsonb_set(limits, '{stepBudgetMs}', '1') WHERE id = ${id}`;
      await sql.end();
    } else {
      const job = (await repo.getScan(id))!;
      job.limits.stepBudgetMs = 1;
      await repo.saveScan(job);
    }

    const first = (await advance(b, id)).body.data!.scan!;
    expect(first.status).toBe("running");
    const startedAt = first.startedAt;
    await hop(); // the browser tab was closed; later it comes back on another instance
    const reopened = (await status(b, id)).body.data!;
    expect(reopened.status).toBe("running");
    expect(reopened.progress.pagesCrawled).toBeGreaterThanOrEqual(first.progress.pagesCrawled);

    let prevCrawled = reopened.progress.pagesCrawled;
    let steps = 1;
    for (; steps < 120; steps++) {
      await hop();
      const s = (await advance(b, id)).body.data!.scan!;
      expect(s.startedAt).toBe(startedAt); // never restarted
      expect(s.progress.pagesCrawled).toBeGreaterThanOrEqual(prevCrawled);
      prevCrawled = s.progress.pagesCrawled;
      if (TERMINAL.includes(s.status)) break;
    }
    expect(steps).toBeGreaterThan(2);
    const list = await b.call<{ scans: Array<{ id: string }> }>(scansRoute.GET, "GET", "/api/scans");
    expect(list.body.data!.scans.map((s) => s.id)).toEqual([id]);
    const pages = (await results(b, id)).body.data!.pages.map((p) => p.url);
    expect(new Set(pages).size).toBe(pages.length); // no page fetched twice
  });

  it.runIf(multiInstance)("6. a scan created on one instance is readable and resumable from others", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const id = (await start(b)).body.data!.id;
    for (let i = 0; i < 3; i++) {
      await newInstance();
      expect((await status(b, id)).status).toBe(200);
    }
    const final = await runToEnd(b, id, () => newInstance());
    expect(["completed", "completed_with_warnings"]).toContain(final.status);
  });

  it("7. another account cannot read or control the scan, even with a legacy access key", async () => {
    const owner = signedBrowser("owner");
    const other = signedBrowser("other");
    await owner.visit("/");
    await other.visit("/");
    const id = (await start(owner)).body.data!.id;
    await hop();
    for (const r of [await status(other, id), await results(other, id), await advance(other, id), await other.call(cancelRoute.POST, "POST", `/api/scans/${id}/cancel`, { params: { id }, json: {} })]) {
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
    other.scanKeys.set(id, "sk_" + "A".repeat(43)); // wrong key
    expect((await status(other, id)).status).toBe(404);
    other.scanKeys.set(id, owner.scanKeys.get(id)!); // a real legacy key is NOT account authorization
    expect((await status(other, id)).status).toBe(404);
    expect((await status(owner, id)).body.data!.status).toBe("queued"); // nothing was changed by the other browser
  });

  it("8. invalid and unknown scan IDs return 404 not_found", async () => {
    const b = signedBrowser();
    await b.visit("/");
    await start(b); // the browser has a real session
    for (const id of ["not-a-uuid", "../../etc/passwd", "3f1d2c4b-1a2b-4c3d-8e9f-0a1b2c3d4e5f"]) {
      const r = await status(b, id);
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
  });

  it("9. clearing the verified session denies access, even with a legacy key", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const id = (await start(b)).body.data!.id;
    b.clearCookies();
    await hop();
    const noKey = await status(b, id, { sendScanKey: false });
    expect(noKey.status).toBe(401);
    expect(noKey.body.error?.code).toBe("auth_required");
    b.clearCookies();
    const withKey = await status(b, id);
    expect(withKey.status).toBe(401);
    // A brand-new visitor asking for any ID gets the same 401 (no existence leak).
    const stranger = new TestBrowser();
    const s = await status(stranger, "3f1d2c4b-1a2b-4c3d-8e9f-0a1b2c3d4e5f");
    expect(s.status).toBe(401);
    // A client cannot pretend to be "new" to change the outcome for its own scan.
    const spoof = await b.call<PublicScan>(scanRoute.GET, "GET", `/api/scans/${id}`, { params: { id }, headers: { [NEW_PRINCIPAL_HEADER]: "1" } });
    expect(spoof.status).toBe(401);
  });

  it("10. a database outage is reported as unavailable, never as 'not found'", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const id = (await start(b)).body.data!.id;
    setEnv({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/unreachable", DATABASE_SSL: "disable" });
    await newInstance();
    for (const r of [await status(b, id), await results(b, id), await advance(b, id), await start(b)]) {
      expect(r.status).toBe(503);
      expect(r.body.error?.code).toBe("database_unavailable");
      expect(r.headers.get("retry-after")).toBe("5");
      expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|postgres:|password|ECONNREFUSED/);
    }
  });

  it("11a. retried start requests with the same Idempotency-Key return the original scan", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const first = await start(b, "retry-key-0001");
    await hop();
    const again = await start(b, "retry-key-0001");
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data!.id).toBe(first.body.data!.id);
    expect(again.body.data!.accessKey).toBeNull();
    const usage = await b.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
    expect(usage.body.data!.usage.scans.used).toBe(1);
  });

  it("11b. concurrent duplicate start requests create exactly one scan and charge once", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const rs = await Promise.all([start(b, "same-key-0002"), start(b, "same-key-0002"), start(b, "same-key-0002")]);
    const ids = new Set(rs.map((r) => r.body.data?.id));
    expect(rs.map((r) => r.status).sort(), JSON.stringify(rs.map((r) => r.body.error))).toEqual([200, 200, 201]);
    expect(ids.size).toBe(1);
    const list = await b.call<{ scans: unknown[] }>(scansRoute.GET, "GET", "/api/scans");
    expect(list.body.data!.scans).toHaveLength(1);
    const usage = await b.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage");
    expect(usage.body.data!.usage.scans.used).toBe(1);
  });

  it("11c. concurrent progress requests never run the same step twice", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const id = (await start(b)).body.data!.id;
    const rs = await Promise.all([advance(b, id), advance(b, id), advance(b, id)]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.data!.leaseBusy).length).toBeGreaterThanOrEqual(2);
    const final = await runToEnd(b, id, hop);
    expect(["completed", "completed_with_warnings"]).toContain(final.status);
    const pages = (await results(b, id)).body.data!.pages.map((p) => p.url);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it("12. malformed Idempotency-Key headers are rejected without creating a scan", async () => {
    const b = signedBrowser();
    await b.visit("/");
    const r = await b.call(scansRoute.POST, "POST", "/api/scans", { json: { url: target }, headers: { "idempotency-key": "bad key!" } });
    expect(r.status).toBe(400);
    const list = await b.call<{ scans: unknown[] }>(scansRoute.GET, "GET", "/api/scans");
    expect(list.body.data!.scans).toHaveLength(0);
  });
});
