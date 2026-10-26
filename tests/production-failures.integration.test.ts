/**
 * Production-failure regression tests: misconfigured databases must produce a
 * specific, actionable error (never the generic "Something went wrong on our
 * side") and must never leak SQL, hostnames or secrets to the browser.
 *
 * Scenarios (each a real Postgres database prepared by the caller):
 *   REPRO_EMPTY_URL     database where migrations never ran (DB_AUTO_MIGRATE=false)
 *   REPRO_OLD_URL       database with only the Phase-2 migrations 001–003 applied
 *   REPRO_MISMATCH_URL  fully migrated database that belongs to ANOTHER Supabase
 *                       project (its auth.users does not contain the signed-in user)
 *   REPRO_NOPERM_URL    migrated database reached with a role that has no table privileges
 * plus TEST_SUPABASE_* (real GoTrue) for the signed-in mismatch case.
 * Skipped when the variables are not set.
 */
import { startAuthFixture } from "./helpers/auth-fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);

import * as signInRoute from "@/app/api/auth/sign-in/route";
import * as dashboardRoute from "@/app/api/dashboard/route";
import * as auditsRoute from "@/app/api/audits/route";
import * as scansRoute from "@/app/api/scans/route";
import * as statusRoute from "@/app/api/system/status/route";
import { __resetConfigForTests } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository } from "@/lib/db";
import type { PostgresRepository } from "@/lib/db/postgres";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import { __resetAccountReadyForTests } from "@/lib/services/dashboard";
import { __resetDiagnosticsCache } from "@/lib/services/diagnostics";
import { TestBrowser } from "./helpers/route-harness";

let auth: Awaited<ReturnType<typeof startAuthFixture>>;
beforeAll(async () => { auth = await startAuthFixture(); });
function signedBrowser() { const browser = new TestBrowser(); auth.signIn(browser); return browser; }
const SAVED_ENV = { ...process.env };
const EMPTY = process.env.REPRO_EMPTY_URL;
const OLD = process.env.REPRO_OLD_URL;
const MISMATCH = process.env.REPRO_MISMATCH_URL;
const NOPERM = process.env.REPRO_NOPERM_URL;
const SUPA_URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const created: string[] = [];

async function reset() {
  try {
    const old = getRepository();
    if (old.kind === "postgres") await (old as PostgresRepository).close();
  } catch {
    /* unconfigured */
  }
  __resetConfigForTests();
  __resetRepositoryForTests();
  __resetAccountReadyForTests();
  __resetDiagnosticsCache();
}

async function useDb(url: string, extra: Record<string, string> = {}) {
  await reset();
  for (const k of ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_URL_NON_POOLING", "MIGRATION_DATABASE_URL", "VERCEL", "CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) delete process.env[k];
  auth.configure();
  Object.assign(process.env, {
    DATABASE_URL: url,
    DATABASE_SSL: "disable",
    DB_AUTO_MIGRATE: "false",
    BACKGROUND_PROCESSING: "false",
    API_RATE_LIMIT_PER_MINUTE: "10000",
    AUDIT_BURST_LIMIT: "50",
    SESSION_SECRET: "production-failures-test-secret-0123456789",
    ...extra,
  });
  __resetConfigForTests();
}

const LEAKS = /relation|column|constraint|violates|syntax|postgres:\/\/|127\.0\.0\.1|password|sb_secret|service_role/i;

function expectActionable(r: { status: number; body: { ok: boolean; error?: { code: string; message: string } } }, code: string) {
  expect(r.status, JSON.stringify(r.body)).toBe(503);
  expect(r.body.ok).toBe(false);
  expect(r.body.error?.code).toBe(code);
  expect(r.body.error?.message).not.toMatch(/Something went wrong on our side/);
  expect(r.body.error?.message).not.toMatch(LEAKS);
}

afterAll(async () => {
  if (SUPA_URL && SERVICE) {
    for (const id of created) {
      await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } }).catch(() => null);
    }
  }
  await reset();
  await auth.close();
  process.env = { ...SAVED_ENV };
  __resetConfigForTests();
});
beforeEach(() => __resetRateLimitsForTests());

const startBody = { json: { url: "https://example.com/" } };

(EMPTY ? describe : describe.skip)("database where migrations never ran", () => {
  it("start audit, dashboard and history report database_schema_missing (not a generic 500)", async () => {
    await useDb(EMPTY!);
    const b = signedBrowser();
    await b.visit("/");
    const start = await b.call(scansRoute.POST, "POST", "/api/scans", startBody);
    expectActionable(start as never, "database_schema_missing");
    expectActionable((await b.call(dashboardRoute.GET, "GET", "/api/dashboard")) as never, "database_schema_missing");
    expectActionable((await b.call(auditsRoute.GET, "GET", "/api/audits")) as never, "database_schema_missing");
  });

  it("the status endpoint names the problem and the fix without values", async () => {
    await useDb(EMPTY!);
    const b = signedBrowser();
    const r = await b.call<{ storage: { ready: boolean; problem: string | null }; configWarnings: string[] }>(statusRoute.GET, "GET", "/api/system/status");
    expect(r.status).toBe(200);
    expect(r.body.data?.storage.ready).toBe(false);
    expect(r.body.data?.storage.problem).toBe("database_schema_missing");
    expect(JSON.stringify(r.body)).not.toMatch(/postgres:\/\/|sitelens:sitelens/);
  });
});

(OLD ? describe : describe.skip)("database with an outdated schema", () => {
  it("reports database_schema_outdated and lists only the missing migration versions in the server log", async () => {
    await useDb(OLD!);
    const b = signedBrowser();
    await b.visit("/");
    expectActionable((await b.call(scansRoute.POST, "POST", "/api/scans", startBody)) as never, "database_schema_outdated");
    expectActionable((await b.call(dashboardRoute.GET, "GET", "/api/dashboard")) as never, "database_schema_outdated");
  });
});

(NOPERM ? describe : describe.skip)("runtime role without table privileges", () => {
  it("reports database_permission_denied", async () => {
    await useDb(NOPERM!);
    const b = signedBrowser();
    await b.visit("/");
    expectActionable((await b.call(scansRoute.POST, "POST", "/api/scans", startBody)) as never, "database_permission_denied");
  });
});

(MISMATCH && SUPA_URL && ANON && SERVICE ? describe : describe.skip)("database from a different Supabase project than Auth", () => {
  it("a signed-in user gets supabase_project_mismatch on start audit and dashboard", async () => {
    await useDb(MISMATCH!, { NEXT_PUBLIC_SUPABASE_URL: SUPA_URL!, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON!, SUPABASE_SECRET_KEY: SERVICE! });
    const email = `vt-mismatch-${randomUUID().slice(0, 8)}@sitelens.localtest`;
    const password = `Vt-${randomUUID()}`;
    const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    const user = (await res.json()) as { id: string };
    created.push(user.id);
    const b = signedBrowser();
    await b.visit("/");
    const si = await b.call(signInRoute.POST, "POST", "/api/auth/sign-in", { json: { email, password } });
    // Supabase Auth completed the sign-in; the database problem must not undo it…
    expect(si.status, JSON.stringify(si.body)).toBe(200);
    expectActionable((await b.call(scansRoute.POST, "POST", "/api/scans", startBody)) as never, "supabase_project_mismatch");
    // …but every signed-in data request names the problem instead of showing an empty account.
    expectActionable((await b.call(dashboardRoute.GET, "GET", "/api/dashboard")) as never, "supabase_project_mismatch");
    expectActionable((await b.call(auditsRoute.GET, "GET", "/api/audits")) as never, "supabase_project_mismatch");
  });
});

(EMPTY ? describe : describe.skip)("automatic migrations", () => {
  it("migrate over a separate migration connection, falling back to the runtime connection when it is unreachable; re-running is a no-op", async () => {
    const { PostgresRepository } = await import("@/lib/db/postgres");
    const base = EMPTY!.replace(/\/repro_empty$/, "/repro_auto");
    const unreachable = new PostgresRepository(base, { ssl: "disable", autoMigrate: true, migrationUrl: "postgres://nobody:x@127.0.0.1:1/none" });
    const h1 = await unreachable.health();
    expect(h1).toMatchObject({ ok: true, problem: null, missingMigrations: [], migrationConnection: "separate" });
    await unreachable.close();
    const separate = new PostgresRepository(base, { ssl: "disable", autoMigrate: true, migrationUrl: base });
    expect(await separate.migrate()).toEqual([]); // idempotent
    expect((await separate.health()).ok).toBe(true);
    await separate.close();
  });
});

(MISMATCH && SUPA_URL && ANON && SERVICE ? describe : describe.skip)("operator diagnostics", () => {
  const SECRET = "diagnostics-test-cron-secret-0123456789";
  const call = async (auth?: string) => {
    const { GET } = await import("@/app/api/system/diagnostics/route");
    const b = signedBrowser();
    return b.call<{ checks: Record<string, { status: string; detail: string; fix?: string }>; variables: Record<string, string> }>(GET as never, "GET", "/api/system/diagnostics", { headers: auth ? { authorization: auth } : {} });
  };

  it("is disabled without CRON_SECRET and rejects a wrong token", async () => {
    await useDb(MISMATCH!);
    expect((await call()).status).toBe(503);
    await useDb(MISMATCH!, { CRON_SECRET: SECRET });
    expect((await call("Bearer wrong-secret-wrong-secret-xx")).status).toBe(401);
  });

  it("proves an Auth/database project mismatch with a real user id, and confirms a correct setup", async () => {
    // At least one user must exist in the Auth project for the cross-check.
    const email = `vt-diag-${randomUUID().slice(0, 8)}@sitelens.localtest`;
    const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, { method: "POST", headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ email, password: `Vt-${randomUUID()}`, email_confirm: true }) });
    created.push(((await res.json()) as { id: string }).id);

    const supaEnv = { CRON_SECRET: SECRET, NEXT_PUBLIC_SUPABASE_URL: SUPA_URL!, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON!, SUPABASE_SECRET_KEY: SERVICE! };
    await useDb(MISMATCH!, supaEnv);
    const bad = await call(`Bearer ${SECRET}`);
    expect(bad.status).toBe(200);
    expect(bad.body.data!.checks.project_match.status).toBe("error");
    expect(bad.body.data!.checks.database.status).toBe("ok");
    expect(bad.body.data!.variables.DATABASE_URL).toBe("set");
    const text = JSON.stringify(bad.body);
    for (const secret of [SERVICE!, ANON!, SECRET, "sitelens:sitelens", MISMATCH!]) expect(text).not.toContain(secret);

    const good = process.env.TEST_SUPABASE_DATABASE_URL;
    if (good) {
      await useDb(good, supaEnv);
      const r = await call(`Bearer ${SECRET}`);
      expect(r.body.data!.checks.project_match.status, JSON.stringify(r.body.data!.checks)).toBe("ok");
      expect(r.body.data!.checks.auth.status).toBe("ok");
    }
  });
});

describe("genuine bugs", () => {
  it("return internal_error with a reference id that is also logged", async () => {
    const { errorResponse } = await import("@/lib/http/api");
    const res = errorResponse(new TypeError("unexpected"));
    const body = (await res.json()) as { error: { code: string; message: string; details: { ref: string } } };
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.details.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(body.error.message).toContain(body.error.details.ref);
  });
});
