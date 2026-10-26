import { describe, expect, it } from "vitest";
import { checkSupabaseConsistency, parseDbUrl, refFromSupabaseUrl } from "@/lib/config/consistency";
import { classifyDatabaseError, DatabaseProblemError, PROBLEMS } from "@/lib/db/errors";

const A = "abcdefghijklmnopqrst"; // 20-char project refs
const B = "zyxwvutsrqponmlkjihg";
const pooler = (ref: string, port = 6543) => `postgres://postgres.${ref}:pw-${ref}@aws-0-eu-central-1.pooler.supabase.com:${port}/postgres?sslmode=require`;
const direct = (ref: string) => `postgresql://postgres:pw-${ref}@db.${ref}.supabase.co:5432/postgres`;
const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJl`;

describe("Supabase URL parsing", () => {
  it("extracts project refs from API and database URLs", () => {
    expect(refFromSupabaseUrl(`https://${A}.supabase.co`)).toBe(A);
    expect(refFromSupabaseUrl("http://127.0.0.1:54321")).toBeNull();
    expect(parseDbUrl(pooler(A))).toMatchObject({ ref: A, kind: "supabase-transaction-pooler", port: 6543 });
    expect(parseDbUrl(pooler(A, 5432))).toMatchObject({ ref: A, kind: "supabase-session-pooler" });
    expect(parseDbUrl(direct(A))).toMatchObject({ ref: A, kind: "supabase-direct" });
    expect(parseDbUrl("postgres://u:p@localhost:5432/app")).toMatchObject({ ref: null, kind: "other" });
    expect(parseDbUrl("not a url")).toBeNull();
  });
});

describe("checkSupabaseConsistency", () => {
  const vercel = { serverless: true };

  it("accepts a consistent Vercel + Supabase integration setup and uses the session URL for migrations", () => {
    const r = checkSupabaseConsistency({ NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`, POSTGRES_URL: pooler(A), POSTGRES_URL_NON_POOLING: pooler(A, 5432) }, vercel);
    expect(r.issues).toEqual([]);
    expect(r.runtimeDb).toEqual({ variable: "POSTGRES_URL", kind: "supabase-transaction-pooler" });
    expect(r.migrationDb).toEqual({ variable: "POSTGRES_URL_NON_POOLING", kind: "supabase-session-pooler" });
  });

  it("flags DATABASE_URL from another project overriding a correct POSTGRES_URL — and says so", () => {
    const r = checkSupabaseConsistency({ NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`, DATABASE_URL: pooler(B), POSTGRES_URL: pooler(A) }, vercel);
    const e = r.issues.find((i) => i.severity === "error")!;
    expect(e.variables).toEqual(["DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
    expect(e.fix).toMatch(/Remove DATABASE_URL \(it overrides POSTGRES_URL/);
  });

  it("flags POSTGRES_URL from another project when DATABASE_URL is unset", () => {
    const r = checkSupabaseConsistency({ NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`, POSTGRES_URL: pooler(B) }, vercel);
    expect(r.issues.some((i) => i.severity === "error" && i.variables[0] === "POSTGRES_URL")).toBe(true);
  });

  it("warns about SUPABASE_URL / keys from another project and never echoes values", () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`,
      SUPABASE_URL: `https://${B}.supabase.co`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ ref: B, role: "anon" }),
      SUPABASE_SERVICE_ROLE_KEY: jwt({ ref: B, role: "service_role" }),
      DATABASE_URL: pooler(A),
    };
    const r = checkSupabaseConsistency(env, vercel);
    expect(r.issues.map((i) => i.variables[0]).sort()).toEqual(["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"]);
    const text = JSON.stringify(r.issues);
    for (const v of Object.values(env)) expect(text).not.toContain(v);
    expect(text).not.toContain("pw-");
  });

  it("rejects a service_role key in a public variable", () => {
    const r = checkSupabaseConsistency({ NEXT_PUBLIC_SUPABASE_URL: `https://${A}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt({ ref: A, role: "service_role" }) }, vercel);
    expect(r.issues[0]).toMatchObject({ severity: "error", variables: ["NEXT_PUBLIC_SUPABASE_ANON_KEY"] });
    expect(r.issues[0].problem).toMatch(/sent to browsers/);
  });

  it("flags the IPv6-only direct host and the session pooler for serverless runtime", () => {
    expect(checkSupabaseConsistency({ DATABASE_URL: direct(A) }, vercel).issues[0]).toMatchObject({ severity: "error", variables: ["DATABASE_URL"] });
    expect(checkSupabaseConsistency({ DATABASE_URL: direct(A) }, { serverless: false }).issues).toEqual([]);
    expect(checkSupabaseConsistency({ DATABASE_URL: pooler(A, 5432) }, vercel).issues[0].problem).toMatch(/session pooler/);
  });

  it("flags a pooler URL without the project ref in the user name", () => {
    const r = checkSupabaseConsistency({ DATABASE_URL: "postgres://postgres:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres" }, vercel);
    expect(r.issues[0].problem).toMatch(/without the project ref/);
  });

  it("never uses a migration URL from another database, a transaction pooler, or (on serverless) the direct host", () => {
    expect(checkSupabaseConsistency({ DATABASE_URL: pooler(A), MIGRATION_DATABASE_URL: pooler(B, 5432) }, vercel).migrationDb).toBeNull();
    expect(checkSupabaseConsistency({ DATABASE_URL: pooler(A), MIGRATION_DATABASE_URL: pooler(A) }, vercel).migrationDb).toBeNull();
    expect(checkSupabaseConsistency({ DATABASE_URL: pooler(A), POSTGRES_URL_NON_POOLING: direct(A) }, vercel).migrationDb).toBeNull();
    expect(checkSupabaseConsistency({ DATABASE_URL: pooler(A), POSTGRES_URL_NON_POOLING: direct(A) }, { serverless: false }).migrationDb?.variable).toBe("POSTGRES_URL_NON_POOLING");
  });
});

describe("classifyDatabaseError", () => {
  const pg = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("x"), { code, ...extra });
  it.each([
    ["ECONNREFUSED", "database_unavailable"],
    ["08006", "database_unavailable"],
    ["28P01", "database_misconfigured"],
    ["3D000", "database_misconfigured"],
    ["53300", "database_busy"],
    ["57014", "database_busy"],
    ["42P01", "database_schema_outdated"],
    ["42703", "database_schema_outdated"],
    ["42501", "database_permission_denied"],
    ["25006", "database_read_only"],
  ])("%s → %s", (code, problem) => {
    expect(classifyDatabaseError(pg(code))).toBe(problem);
  });
  it("recognises Supavisor messages and the profiles → auth.users foreign key", () => {
    expect(classifyDatabaseError(pg("XX000", { message: "Tenant or user not found" }))).toBe("database_misconfigured");
    expect(classifyDatabaseError(pg("XX000", { message: "(EMAXCONNSESSION) max clients reached in session mode" }))).toBe("database_busy");
    expect(classifyDatabaseError(pg("23503", { constraint_name: "profiles_id_auth_users_fkey" }))).toBe("supabase_project_mismatch");
  });
  it("leaves genuine bugs unclassified (→ HTTP 500 with a reference)", () => {
    expect(classifyDatabaseError(pg("23505"))).toBeNull();
    expect(classifyDatabaseError(pg("23503", { constraint_name: "audit_pages_audit_id_fkey" }))).toBeNull();
    expect(classifyDatabaseError(new TypeError("boom"))).toBeNull();
  });
  it("user-facing messages contain no SQL, hosts or variable values", () => {
    for (const [k, p] of Object.entries(PROBLEMS)) {
      expect(new DatabaseProblemError(k as never).message).toBe(p.message);
      expect(p.message).not.toMatch(/relation|column|postgres:\/\/|DATABASE_URL|POSTGRES_URL|42P01/);
    }
  });
});
