/**
 * Unit tests for the account/auth/deployment plumbing added for Supabase:
 * redirect safety, Supabase env names, DB URL resolution, auth error mapping,
 * background modes, cron authorization, request origin, free-plan entitlements,
 * the status endpoint (no secrets), and route guards that must stay dynamic.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { authError } from "@/lib/auth/errors";
import { safeNext, unwrapNext } from "@/lib/auth/redirects";
import { readSupabaseEnv } from "@/lib/auth/supabase-env";
import { __resetConfigForTests, loadConfig } from "@/lib/config/env";
import { requestOrigin } from "@/lib/http/origin";
import { backgroundMode, isAuthorizedCron } from "@/lib/services/background";
import { getEntitlements } from "@/lib/usage/entitlements";

import { MAILJET_TEST_USER, MAILJET_TEST_PASS, MAILJET_TEST_FROM } from "./fixtures/mailjet-smtp";

const SAVED = { ...process.env };
function withEnv(vars: Record<string, string | undefined>) {
  for (const k of ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "CRON_SECRET", "BACKGROUND_PROCESSING", "DATABASE_URL", "POSTGRES_URL"]) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetConfigForTests();
}
afterEach(() => {
  process.env = { ...SAVED };
  __resetConfigForTests();
});

describe("post-auth redirects stay on this site", () => {
  it.each([
    ["/dashboard/audits?status=failed", "/dashboard/audits?status=failed"],
    ["https://evil.example/steal", "/steal"],
    ["//evil.example", "/dashboard"],
    ["/\\evil.example", "/dashboard"],
    ["javascript:alert(1)", "/dashboard"],
    ["dashboard", "/dashboard"],
    ["/api/auth/sign-out", "/dashboard"],
    ["/auth/callback?next=/x", "/dashboard"],
    ["/ok\nSet-Cookie: x", "/dashboard"],
    [null, "/dashboard"],
  ])("safeNext(%j) → %j", (input, out) => {
    expect(safeNext(input as string | null)).toBe(out);
  });

  it("unwrapNext extracts the inner path from email-template callback URLs", () => {
    expect(unwrapNext("https://app.example.com/auth/callback?next=%2Faccount%2Freset-password")).toBe("/account/reset-password");
    expect(unwrapNext("https://app.example.com/auth/callback?next=https%3A%2F%2Fevil.example%2Fx")).toBe("/x");
    expect(unwrapNext("https://app.example.com")).toBe("/");
    expect(unwrapNext(undefined)).toBe("/dashboard");
    expect(unwrapNext("//evil.example/auth/callback?next=/a")).toBe("/a"); // origin discarded, path kept
  });
});

describe("Supabase environment variables", () => {
  it("accepts the names created by the Supabase ↔ Vercel integration (new and legacy)", () => {
    const modern = readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x", SUPABASE_SECRET_KEY: "sb_secret_y" });
    expect(modern.authEnabled).toBe(true);
    expect(modern.sources).toEqual({ url: "NEXT_PUBLIC_SUPABASE_URL", publishableKey: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", secretKey: "SUPABASE_SECRET_KEY" });
    const legacy = readSupabaseEnv({ SUPABASE_URL: "https://abc.supabase.co/", NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJ.anon", SUPABASE_SERVICE_ROLE_KEY: "eyJ.service" });
    expect(legacy.authEnabled).toBe(true);
    expect(legacy.url).toBe("https://abc.supabase.co");
    expect(legacy.sources.secretKey).toBe("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("starts with accounts disabled (not crashing) when nothing is configured", () => {
    const none = readSupabaseEnv({});
    expect(none.authEnabled).toBe(false);
    expect(none.warnings).toEqual([]);
  });

  it("refuses a secret key placed in the public-key variable", () => {
    const bad = readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_oops" });
    expect(bad.authEnabled).toBe(false);
    expect(bad.publishableKey).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/SECRET key/);
  });

  it("requires https for non-local project URLs and reports half-configured setups", () => {
    expect(readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" }).authEnabled).toBe(false);
    expect(readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" }).authEnabled).toBe(true);
    expect(readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }).warnings.join(" ")).toMatch(/publishable/);
  });
});

describe("database URL resolution", () => {
  it("uses DATABASE_URL, else the integration's pooled POSTGRES_URL (driver-incompatible params removed)", () => {
    const pooled = loadConfig({ POSTGRES_URL: "postgres://u:p@aws-0-eu.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x&pgbouncer=true" });
    expect(pooled.databaseUrlSource).toBe("POSTGRES_URL");
    expect(pooled.databaseUrl).toMatch(/^postgres:\/\/u:p@aws-0-eu\.pooler\.supabase\.com:6543\/postgres/);
    expect(pooled.databaseUrl).not.toMatch(/supa=|pgbouncer=/);
    const both = loadConfig({ DATABASE_URL: "postgres://a:b@db.example.com:5432/x", POSTGRES_URL: "postgres://c:d@other:5432/y" });
    expect(both.databaseUrlSource).toBe("DATABASE_URL");
  });

  it("warns when sign-in is configured without a database", () => {
    const c = loadConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" });
    expect(c.databaseUrl).toBeNull();
    expect(c.warnings.join(" ")).toMatch(/no database URL/);
  });
});

describe("auth error mapping", () => {
  it("maps Supabase codes to stable API errors", () => {
    expect(authError({ code: "invalid_credentials", status: 400 }, "t")).toMatchObject({ status: 401, code: "invalid_credentials" });
    expect(authError({ code: "email_not_confirmed" }, "t")).toMatchObject({ status: 403, code: "email_not_confirmed" });
    expect(authError({ code: "user_already_exists" }, "t")).toMatchObject({ status: 409, code: "email_in_use" });
    expect(authError({ code: "over_email_send_rate_limit" }, "t")).toMatchObject({ status: 429, code: "auth_rate_limited" });
    expect(authError({ code: "otp_expired" }, "t")).toMatchObject({ status: 400, code: "link_invalid" });
    expect(authError({ code: "sso_provider_not_found" }, "t")).toMatchObject({ code: "sso_not_configured" });
    expect(authError({ code: "email_address_not_authorized", status: 400 }, "sign-up")).toMatchObject({ status: 503, code: "email_unavailable" });
  });

  it("never forwards raw messages of unknown errors", () => {
    const e = authError({ code: "something_new", status: 500, message: "db password=hunter2 at 10.0.0.5" }, "t");
    expect(e.message).not.toMatch(/hunter2|10\.0\.0\.5/);
    expect(e.status).toBeGreaterThanOrEqual(400);
  });
});

describe("background processing mode", () => {
  it("full on a long-running server, limited on serverless without CRON_SECRET, full with it, off when disabled", () => {
    withEnv({});
    expect(backgroundMode()).toBe("full");
    withEnv({ VERCEL: "1" });
    expect(backgroundMode()).toBe("limited");
    withEnv({ VERCEL: "1", CRON_SECRET: "c".repeat(32) });
    expect(backgroundMode()).toBe("full");
    withEnv({ BACKGROUND_PROCESSING: "false" });
    expect(backgroundMode()).toBe("off");
  });

  it("cron endpoint authorization is exact and requires a configured secret of ≥16 chars", () => {
    withEnv({});
    expect(isAuthorizedCron("Bearer anything")).toBe(false);
    withEnv({ CRON_SECRET: "short" });
    expect(isAuthorizedCron("Bearer short")).toBe(false);
    const s = "s3cr3t-".repeat(4);
    withEnv({ CRON_SECRET: s });
    expect(isAuthorizedCron(`Bearer ${s}`)).toBe(true);
    expect(isAuthorizedCron(`Bearer ${s}x`)).toBe(false);
    expect(isAuthorizedCron(s)).toBe(false);
    expect(isAuthorizedCron(null)).toBe(false);
  });
});

describe("request origin for auth links", () => {
  const req = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { headers });
  it("prefers NEXT_PUBLIC_APP_URL, then forwarded/Host headers over the bind address", () => {
    expect(requestOrigin(req("http://0.0.0.0:3000/x", { host: "evil.example" }), "https://app.example.com/")).toBe("https://app.example.com");
    expect(requestOrigin(req("http://0.0.0.0:3000/x", { host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000");
    expect(requestOrigin(req("http://0.0.0.0:3000/x", { host: "internal:3000", "x-forwarded-host": "sitelens.vercel.app", "x-forwarded-proto": "https" }))).toBe("https://sitelens.vercel.app");
  });
  it("ignores malformed host headers", () => {
    expect(requestOrigin(req("http://localhost:3000/x", { "x-forwarded-host": "evil.example/path?x", "x-forwarded-proto": "https" }))).toBe("http://localhost:3000");
    expect(requestOrigin(req("http://localhost:3000/x", { host: "ok.example", "x-forwarded-proto": "gopher" }))).toBe("http://localhost:3000");
  });
});

describe("free plan entitlements", () => {
  it("come from server configuration (FREE_* variables) — free product: every feature is granted", () => {
    const cfg = loadConfig({ FREE_SCANS_PER_WINDOW: "7", FREE_AI_REQUESTS_PER_WINDOW: "4", FREE_MAX_CONCURRENT_SCANS: "2" });
    const e = getEntitlements({ id: "user:x", plan: "free" }, cfg);
    expect(e.scansPerWindow).toBe(7);
    // Free product: the FREE_* technical windows apply to the full feature set.
    expect(e.aiRequestsPerWindow).toBe(300);
    expect(e.features.aiExplanations).toBe(true);
    expect(e.features.pdfExport).toBe(true);
    expect(e.features.prospects).toBe(true);
    expect(e.features.batchAudits).toBe(true);
    expect(e.maxConcurrentScans).toBe(2);
  });
});

describe("guarded pages are rendered per request (never prerendered)", () => {
  // Regression: without this, `next build` froze /dashboard and /account as static HTML.
  it.each(["src/app/dashboard/layout.tsx", "src/app/account/(settings)/layout.tsx", "src/app/account/page.tsx"])("%s exports dynamic = force-dynamic", (file) => {
    const src = readFileSync(path.join(__dirname, "..", file), "utf8");
    expect(src).toMatch(/export const dynamic = "force-dynamic"/);
  });
});

describe("system status endpoint", () => {
  it("reports configuration without exposing any secret values", async () => {
    const secrets = {
      DATABASE_URL: "postgres://user:Sup3rS3cretPw@127.0.0.1:1/db",
      SUPABASE_SECRET_KEY: "sb_secret_DO_NOT_LEAK_123",
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc",
      OPENROUTER_API_KEY: "sk-or-v1-DO_NOT_LEAK",
      GEMINI_API_KEY: "AIzaDO_NOT_LEAK",
      CRON_SECRET: "cron-DO_NOT_LEAK-0123456789",
      SESSION_SECRET: "session-DO_NOT_LEAK-0123456789",
      BROWSER_WORKER_TOKEN: "worker-DO_NOT_LEAK-0123456789",
      SMTP_USER: MAILJET_TEST_USER,
      SMTP_PASS: MAILJET_TEST_PASS,
      EMAIL_FROM: MAILJET_TEST_FROM,
    };
    withEnv(secrets);
    const { GET } = await import("@/app/api/system/status/route");
    const res = await GET(new NextRequest("http://sitelens.localtest/api/system/status"), { params: Promise.resolve({}) } as never);
    const text = await res.text();
    for (const v of Object.values(secrets)) {
      if (v.startsWith("https://abc") || v.startsWith("sb_publishable")) continue;
      expect(text).not.toContain(v);
    }
    expect(text).not.toMatch(/Sup3rS3cretPw|DO_NOT_LEAK/);
  });
});
