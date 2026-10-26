/**
 * Regression tests for the production incident "Something went wrong on our
 * side. Please try again. (Reference: d50d231d)" on Start audit.
 *
 * Evidence from production (black-box, no logs available): every endpoint that
 * touches the database (/api/scans, /api/usage, /api/system/status,
 * /api/ai/providers, /api/scans/:id) returned the generic 500 within ~200 ms,
 * while endpoints without database access worked. The only code outside the
 * error classifier on all of those paths is getRepository() creating the
 * postgres.js client, which parses the URL synchronously. The driver throws
 * `URIError: URI malformed` for a password containing a "%" that is not a
 * valid %XX escape — a URL our previous validation (WHATWG new URL) accepted.
 *
 * Covered here:
 *  1. driver parity: every URL we accept can be handed to the real driver;
 *     the old normalisation demonstrably produced a URL the driver rejects;
 *  2. REPRO_PERCENT_URL (real Postgres behind PgBouncer in transaction mode,
 *     role password "…50%off!" written unencoded): account-only and signed-in
 *     audits start, persist and are listed; status names the variable;
 *  3. an unusable database URL gives 503 database_misconfigured, not a 500;
 *  4. a failure after the daily allowance was taken refunds it, and a retry
 *     with the same Idempotency-Key creates exactly one audit.
 */
import { startAuthFixture } from "./helpers/auth-fixture";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./helpers/route-harness")).nextHeadersMock);
vi.mock("@/lib/security/safe-fetch", async (orig) => {
  const m = await orig<typeof import("@/lib/security/safe-fetch")>();
  return { ...m, resolvePublicHost: async (host: string) => (host === "example.com" ? { ok: true as const, addresses: ["93.184.215.14"] } : m.resolvePublicHost(host)) };
});

import * as signInRoute from "@/app/api/auth/sign-in/route";
import * as auditsRoute from "@/app/api/audits/route";
import * as dashboardRoute from "@/app/api/dashboard/route";
import * as scansRoute from "@/app/api/scans/route";
import * as statusRoute from "@/app/api/system/status/route";
import * as usageRoute from "@/app/api/usage/route";
import { __resetConfigForTests, loadConfig } from "@/lib/config/env";
import { __resetRepositoryForTests, getRepository } from "@/lib/db";
import { classifyDatabaseError } from "@/lib/db/errors";
import { MemoryRepository } from "@/lib/db/memory";
import type { PostgresRepository } from "@/lib/db/postgres";
import { driverAcceptsUrl, prepareDatabaseUrl } from "@/lib/db/url";
import { errorResponse } from "@/lib/http/api";
import { __resetRateLimitsForTests } from "@/lib/http/rate-limit";
import { __resetAccountReadyForTests } from "@/lib/services/dashboard";
import { __resetDiagnosticsCache } from "@/lib/services/diagnostics";
import { TestBrowser } from "./helpers/route-harness";

let auth: Awaited<ReturnType<typeof startAuthFixture>>;
function signedBrowser(name?: string) { const browser = new TestBrowser(name); auth.signIn(browser); return browser; }
beforeAll(async () => { auth = await startAuthFixture(); });
const SAVED_ENV = { ...process.env };
const PERCENT = process.env.REPRO_PERCENT_URL; // unencoded, exactly as an operator might paste it
const SUPA_URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const created: string[] = [];
const H = "aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
const LEAKS = /relation|column|constraint|violates|syntax|postgres:\/\/|127\.0\.0\.1|password|URIError|malformed|sb_secret|service_role/i;

/** The pre-fix normalisation (config/env.ts ≤ 0.3.2), kept to prove the defect. */
function oldNormalize(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  for (const p of ["supa", "pgbouncer"]) u.searchParams.delete(p);
  return u.toString();
}
const driverThrows = (url: string) => {
  try {
    void postgres(url, { max: 1 });
    return false;
  } catch {
    return true;
  }
};

async function reset() {
  try {
    const old = getRepository();
    if (old.kind === "postgres") await (old as PostgresRepository).close();
  } catch {
    /* unconfigured / misconfigured */
  }
  __resetConfigForTests();
  __resetRepositoryForTests();
  __resetAccountReadyForTests();
  __resetDiagnosticsCache();
}

async function useEnv(vars: Record<string, string | undefined>) {
  await reset();
  for (const k of ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_URL_NON_POOLING", "MIGRATION_DATABASE_URL", "VERCEL", "CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "ALLOW_MEMORY_STORAGE"]) delete process.env[k];
  Object.assign(process.env, { DATABASE_SSL: "disable", DB_AUTO_MIGRATE: "false", BACKGROUND_PROCESSING: "false", API_RATE_LIMIT_PER_MINUTE: "10000", AUDIT_BURST_LIMIT: "50", SESSION_SECRET: "database-url-test-secret-0123456789" });
  auth.configure();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetConfigForTests();
}

afterAll(async () => {
  if (SUPA_URL && SERVICE) for (const id of created) await fetch(`${SUPA_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}` } }).catch(() => null);
  await reset();
  await auth?.close();
  process.env = { ...SAVED_ENV };
  __resetConfigForTests();
  vi.restoreAllMocks();
});
beforeEach(() => __resetRateLimitsForTests());

describe("database URL preparation (driver parity)", () => {
  const cases: Record<string, string> = {
    plain: `postgres://postgres.abcdefghijklmnopqrst:Abc123xyz@${H}`,
    integration: `postgres://postgres.abcdefghijklmnopqrst:Abc123xyz@${H}?sslmode=require&supa=base-pooler.x`,
    percent: `postgresql://postgres.abcdefghijklmnopqrst:Summer50%off!@${H}`,
    trailingPercent: `postgresql://postgres.abcdefghijklmnopqrst:abc%@${H}`,
    mixed: `postgresql://postgres.abcdefghijklmnopqrst:50%off%23x@${H}`,
    at: `postgresql://postgres.abcdefghijklmnopqrst:p@ss@${H}`,
    encoded: `postgresql://postgres.abcdefghijklmnopqrst:50%25off@${H}`,
    space: `postgresql://postgres.abcdefghijklmnopqrst:a b@${H}`,
    quoted: `"postgresql://postgres.abcdefghijklmnopqrst:abc@${H}"`,
  };

  it("reproduces the defect: the old normalisation accepted URLs the real driver cannot parse", () => {
    expect(driverThrows(oldNormalize(cases.percent)!)).toBe(true);
    expect(driverThrows(oldNormalize(cases.trailingPercent)!)).toBe(true);
    try {
      postgres(oldNormalize(cases.percent)!);
    } catch (e) {
      expect(e).toBeInstanceOf(URIError); // the unclassified error behind the 500
      expect(classifyDatabaseError(e)).toBeNull();
    }
  });

  it("every accepted URL is accepted by the real driver, and driverAcceptsUrl agrees with it", () => {
    for (const [name, raw] of Object.entries(cases)) {
      const { url } = prepareDatabaseUrl(raw, "DATABASE_URL");
      expect(url, name).not.toBeNull();
      expect(driverThrows(url!), name).toBe(false);
      expect(driverAcceptsUrl(url!), name).toBe(true);
      const old = oldNormalize(raw);
      if (old) expect(driverAcceptsUrl(old), `parity ${name}`).toBe(!driverThrows(old));
    }
  });

  it("keeps the credential: a stray % becomes %25 and decodes to the original password; valid escapes are untouched", async () => {
    const opts = (raw: string) => postgres(prepareDatabaseUrl(raw, "DATABASE_URL").url!, { max: 1 }).options;
    expect(opts(cases.percent).pass).toBe("Summer50%off!");
    expect(opts(cases.mixed).pass).toBe("50%off#x");
    expect(opts(cases.encoded).pass).toBe("50%off");
    expect(opts(cases.at).pass).toBe("p@ss");
    expect(opts(cases.integration).connection).not.toHaveProperty("supa");
  });

  it("reports problems by variable name only, never the value", () => {
    const pct = prepareDatabaseUrl(cases.percent, "POSTGRES_URL");
    expect(pct.issues).toHaveLength(1);
    expect(pct.issues[0]).toMatchObject({ severity: "warning", variables: ["POSTGRES_URL"] });
    const placeholder = prepareDatabaseUrl(`postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@${H}`, "DATABASE_URL");
    expect(placeholder.issues.map((i) => i.severity)).toContain("error");
    const hash = prepareDatabaseUrl(`postgresql://postgres.abc:ab#cd@${H}`, "DATABASE_URL");
    expect(hash.url).toBeNull();
    for (const i of [...pct.issues, ...placeholder.issues, ...hash.issues]) expect(JSON.stringify(i)).not.toMatch(/Summer|Abc123|ab#cd|pooler\.supabase/);
  });

  it("config exposes the issue and keeps DATABASE_URL precedence over POSTGRES_URL", () => {
    const cfg = loadConfig({ DATABASE_URL: cases.percent, POSTGRES_URL: cases.plain, NODE_ENV: "test" });
    expect(cfg.databaseUrlSource).toBe("DATABASE_URL");
    expect(cfg.databaseUrl).toContain("Summer50%25off");
    expect(cfg.configIssues.some((i) => i.variables.includes("DATABASE_URL") && /%/.test(i.problem))).toBe(true);
    const bad = loadConfig({ DATABASE_URL: `postgresql://postgres.abc:ab#cd@${H}`, NODE_ENV: "test" });
    expect(bad.databaseUrl).toBeNull();
    expect(bad.databaseUrlInvalid).toBe("DATABASE_URL"); // never a silent fallback to POSTGRES_URL or memory
  });
});

describe("error classification outside the query layer", () => {
  it("raw driver/server errors become specific 503s, never the generic 500", async () => {
    for (const [code, problem] of [["40001", "database_busy"], ["40P01", "database_busy"], ["SELF_SIGNED_CERT_IN_CHAIN", "database_misconfigured"], ["ECONNRESET", "database_unavailable"]] as const) {
      const res = errorResponse(Object.assign(new Error("x"), { code }));
      expect(res.status, code).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(problem);
    }
    const bug = errorResponse(new TypeError("genuine bug"));
    expect(bug.status).toBe(500);
  });
});

describe("unusable database URL", () => {
  it("start audit and status report database_misconfigured with the variable name, no values", async () => {
    await useEnv({ DATABASE_URL: "postgresql://postgres.abcdefghijklmnopqrst:ab#cd@127.0.0.1:6543/postgres" });
    const b = signedBrowser();
    await b.visit("/");
    const start = await b.call(scansRoute.POST, "POST", "/api/scans", { json: { url: "https://example.com/" } });
    expect(start.status, JSON.stringify(start.body)).toBe(503);
    expect(start.body.error?.code).toBe("database_misconfigured");
    expect(start.body.error?.message).not.toMatch(LEAKS);
    const status = await b.call<{ storage: { ready: boolean; problem: string }; configIssues: { variables: string[] }[] }>(statusRoute.GET, "GET", "/api/system/status");
    expect(status.status).toBe(200);
    expect(status.body.data?.storage).toMatchObject({ ready: false, problem: "database_misconfigured", mode: "postgres" });
    expect(status.body.data?.configIssues.some((i) => i.variables.includes("DATABASE_URL"))).toBe(true);
    expect(JSON.stringify(status.body)).not.toMatch(/ab#cd|abcdefghijklmnopqrst/);
  });
});

describe("daily allowance and retries (memory store)", () => {
  it("a failure after the allowance was taken refunds it; the retry with the same Idempotency-Key creates exactly one audit", async () => {
    await useEnv({ ALLOW_MEMORY_STORAGE: "true" });
    const b = signedBrowser();
    await b.visit("/");
    const spy = vi.spyOn(MemoryRepository.prototype, "upsertWebsite").mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    const key = `retry-${randomUUID().slice(0, 8)}`;
    const send = () => b.call<{ id: string }>(scansRoute.POST, "POST", "/api/scans", { json: { url: "https://example.com/" }, headers: { "idempotency-key": key } });
    const first = await send();
    expect(first.status, JSON.stringify(first.body)).toBe(503);
    expect(first.body.error?.code).toBe("database_unavailable");
    const used = async () => (await b.call<{ usage: { scans: { used: number } } }>(usageRoute.GET, "GET", "/api/usage")).body.data!.usage.scans.used;
    expect(await used()).toBe(0); // nothing was accepted, nothing is charged
    const second = await send();
    expect(second.status).toBe(201);
    const third = await send(); // e.g. a double click or a flaky network retry
    expect(third.status).toBe(200);
    expect(third.body.data?.id).toBe(second.body.data?.id);
    expect(await used()).toBe(1);
    spy.mockRestore();
  });
});

(PERCENT ? describe : describe.skip)("real database whose password contains an unencoded % (PgBouncer, transaction mode)", () => {
  it("a percent-password pool connects, but anonymous execution remains forbidden", async () => {
    await useEnv({ DATABASE_URL: PERCENT });
    expect(driverThrows(oldNormalize(PERCENT!)!)).toBe(true);
    expect((await (getRepository() as PostgresRepository).health()).ok).toBe(true);
    const browser = new TestBrowser("signed-out");
    const response = await browser.call(scansRoute.POST, "POST", "/api/scans", { json: { url: "https://example.com/" } });
    expect(response.status).toBe(401);
  });

  (SUPA_URL && ANON && SERVICE ? it : it.skip)("signed in: sign-in, start audit, dashboard and history show it", async () => {
    await useEnv({ DATABASE_URL: PERCENT, NEXT_PUBLIC_SUPABASE_URL: SUPA_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON, SUPABASE_SECRET_KEY: SERVICE });
    const email = `vt-pct-${randomUUID().slice(0, 8)}@sitelens.localtest`;
    const password = `Vt-${randomUUID()}`;
    const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, { method: "POST", headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
    const user = (await res.json()) as { id: string };
    created.push(user.id);
    const b = signedBrowser();
    await b.visit("/");
    expect((await b.call(signInRoute.POST, "POST", "/api/auth/sign-in", { json: { email, password } })).status).toBe(200);
    const start = await b.call<{ id: string }>(scansRoute.POST, "POST", "/api/scans", { json: { url: "https://example.com/" } });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const dash = await b.call<{ recentAudits?: { id: string }[] }>(dashboardRoute.GET, "GET", "/api/dashboard");
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(JSON.stringify(dash.body)).toContain(start.body.data!.id);
    const audits = await b.call(auditsRoute.GET, "GET", "/api/audits");
    expect(audits.status).toBe(200);
    expect(JSON.stringify(audits.body)).toContain(start.body.data!.id);
  });
});
