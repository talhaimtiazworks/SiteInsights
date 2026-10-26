/**
 * Row Level Security tests on a database with the Supabase schema.
 *
 * The app's own server enforces ownership on every route (see
 * accounts.integration.test.ts). RLS is the second layer: even with the
 * public (anon) key and a user's own JWT — i.e. direct PostgREST access from a
 * browser — a user can only read their own rows (or audits shared with an
 * organization they belong to) and can never write audits, results or usage.
 *
 * Runs when TEST_SUPABASE_DATABASE_URL (role that can SET ROLE authenticated/anon),
 * TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY (to create auth users) are set.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB = process.env.TEST_SUPABASE_DATABASE_URL;
const SUPA_URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const enabled = !!(DB && SUPA_URL && SERVICE);
const d = enabled ? describe : describe.skip;

let sql: postgres.Sql;
const users: string[] = [];
let A = "";
let B = "";
let C = "";
const auditA = `rls-a-${randomUUID()}`;
const auditShared = `rls-s-${randomUUID()}`;
const auditB = `rls-b-${randomUUID()}`;
const orgId = randomUUID();

async function createUser(label: string) {
  const res = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email: `rls-${label}-${randomUUID().slice(0, 8)}@sitelens.localtest`, password: `Rls-${randomUUID()}`, email_confirm: true }),
  });
  const body = (await res.json()) as { id: string };
  expect(res.status).toBe(200);
  users.push(body.id);
  return body.id;
}

/** Runs `fn` as the given Postgres role with Supabase-style JWT claims, then rolls back. */
async function as<T>(role: "authenticated" | "anon", sub: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let out: T;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out!;
}
class Rollback extends Error {}

async function visibleSharedRowsAfterMutation(userId: string, mutate: (tx: postgres.TransactionSql) => Promise<void>) {
  let rows!: { audits: number; pages: number; issues: number };
  try {
    await sql.begin(async (tx) => {
      await mutate(tx); // test-owned mutation is rolled back after the RLS read
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
      rows = {
        audits: (await tx`SELECT id FROM audits WHERE id = ${auditShared}`).length,
        pages: (await tx`SELECT audit_id FROM audit_pages WHERE audit_id = ${auditShared}`).length,
        issues: (await tx`SELECT audit_id FROM audit_issues WHERE audit_id = ${auditShared}`).length,
      };
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return rows;
}

async function seedAudit(id: string, owner: string, org: string | null) {
  const principal = `user:${owner}`;
  await sql`INSERT INTO principals (id) VALUES (${principal}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO audits (id, principal_id, target_url, hostname, status, phase, limits, progress, state, organization_id)
            VALUES (${id}, ${principal}, 'https://rls.example.org/', 'rls.example.org', 'completed', 'done', '{}', '{}', '{}', ${org})`;
  await sql`INSERT INTO audit_pages (id, audit_id, url, final_url, depth, fetched_at, data) VALUES (${id + "-p"}, ${id}, 'https://rls.example.org/', 'https://rls.example.org/', 0, now(), '{}')`;
  await sql`INSERT INTO audit_issues (id, audit_id, rule_id, category, severity, page_url, created_at, data) VALUES (${id + "-i"}, ${id}, 'missing-h1', 'seo', 'medium', 'https://rls.example.org/', now(), '{}')`;
}

beforeAll(async () => {
  if (!enabled) return;
  sql = postgres(DB!, { ssl: false, max: 2, prepare: false, onnotice: () => {} });
  [A, B, C] = [await createUser("a"), await createUser("b"), await createUser("c")];
  for (const u of [A, B, C]) await sql`INSERT INTO profiles (id) VALUES (${u}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO organizations (id, name) VALUES (${orgId}, 'RLS Team')`;
  await sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${orgId}, ${A}, 'owner'), (${orgId}, ${C}, 'member')`;
  await seedAudit(auditA, A, null);
  await seedAudit(auditShared, A, orgId);
  await seedAudit(auditB, B, null);
  await sql`INSERT INTO usage_records (principal_id, ip_hash, kind) VALUES (${"user:" + A}, 'rls-ip', 'scan'), (${"user:" + B}, 'rls-ip', 'scan')`;
  await sql`INSERT INTO user_settings (principal_id) VALUES (${"user:" + A}), (${"user:" + B}) ON CONFLICT DO NOTHING`;
});

afterAll(async () => {
  if (!enabled) return;
  await sql`DELETE FROM audits WHERE id IN (${auditA}, ${auditShared}, ${auditB})`.catch(() => null);
  await sql`DELETE FROM organizations WHERE id = ${orgId}`.catch(() => null);
  for (const u of users) {
    await sql`DELETE FROM principals WHERE id = ${"user:" + u}`.catch(() => null);
    await fetch(`${SUPA_URL}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: { apikey: SERVICE!, authorization: `Bearer ${SERVICE}` } }).catch(() => null);
  }
  await sql?.end();
});

d("Row Level Security (Supabase roles)", () => {
  it("every table in the public schema has RLS enabled", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("a user reads only their own audits, pages, issues, usage and settings", async () => {
    const r = await as("authenticated", B, async (tx) => ({
      audits: (await tx<{ id: string }[]>`SELECT id FROM audits WHERE id IN (${auditA}, ${auditShared}, ${auditB})`).map((x) => x.id),
      pages: (await tx<{ audit_id: string }[]>`SELECT audit_id FROM audit_pages WHERE audit_id IN (${auditA}, ${auditShared}, ${auditB})`).map((x) => x.audit_id),
      issues: (await tx<{ audit_id: string }[]>`SELECT audit_id FROM audit_issues WHERE audit_id IN (${auditA}, ${auditShared}, ${auditB})`).map((x) => x.audit_id),
      usage: (await tx<{ principal_id: string }[]>`SELECT principal_id FROM usage_records WHERE principal_id IN (${"user:" + A}, ${"user:" + B})`).map((x) => x.principal_id),
      settings: (await tx<{ principal_id: string }[]>`SELECT principal_id FROM user_settings WHERE principal_id IN (${"user:" + A}, ${"user:" + B})`).map((x) => x.principal_id),
      profiles: (await tx<{ id: string }[]>`SELECT id FROM profiles WHERE id IN (${A}, ${B}, ${C})`).map((x) => x.id),
      orgs: (await tx<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${orgId}`).length,
    }));
    expect(r.audits).toEqual([auditB]);
    expect(r.pages).toEqual([auditB]);
    expect(r.issues).toEqual([auditB]);
    expect(r.usage).toEqual(["user:" + B]);
    expect(r.settings).toEqual(["user:" + B]);
    expect(r.profiles).toEqual([B]);
    expect(r.orgs).toBe(0);
  });

  it("organization members can read audits shared with the organization — and nothing else of the owner's", async () => {
    const r = await as("authenticated", C, async (tx) => ({
      audits: (await tx<{ id: string }[]>`SELECT id FROM audits WHERE id IN (${auditA}, ${auditShared}, ${auditB}) ORDER BY id`).map((x) => x.id),
      pages: (await tx<{ audit_id: string }[]>`SELECT audit_id FROM audit_pages WHERE audit_id IN (${auditA}, ${auditShared}, ${auditB})`).map((x) => x.audit_id),
      members: (await tx<{ user_id: string }[]>`SELECT user_id FROM organization_members WHERE organization_id = ${orgId}`).length,
      ownerUsage: (await tx`SELECT 1 FROM usage_records WHERE principal_id = ${"user:" + A}`).length,
    }));
    expect(r.audits).toEqual([auditShared]);
    expect(r.pages).toEqual([auditShared]);
    expect(r.members).toBe(2);
    expect(r.ownerUsage).toBe(0);
  });

  it("unsharing an audit or removing a member hides the audit and its evidence under RLS", async () => {
    const afterUnshare = await visibleSharedRowsAfterMutation(C, async (tx) => {
      await tx`UPDATE audits SET organization_id = NULL WHERE id = ${auditShared}`;
    });
    expect(afterUnshare).toEqual({ audits: 0, pages: 0, issues: 0 });

    const afterRemoval = await visibleSharedRowsAfterMutation(C, async (tx) => {
      await tx`DELETE FROM organization_members WHERE organization_id = ${orgId} AND user_id = ${C}`;
    });
    expect(afterRemoval).toEqual({ audits: 0, pages: 0, issues: 0 });
  });

  it("the owner sees both of their audits", async () => {
    const ids = await as("authenticated", A, async (tx) => (await tx<{ id: string }[]>`SELECT id FROM audits WHERE id IN (${auditA}, ${auditShared}, ${auditB}) ORDER BY id`).map((x) => x.id));
    expect(ids.sort()).toEqual([auditA, auditShared].sort());
  });

  it("signed-in users cannot write audits, results or usage directly (server-only)", async () => {
    const attempts: Array<[string, (tx: postgres.TransactionSql) => Promise<unknown>]> = [
      ["update own audit", (tx) => tx`UPDATE audits SET title = 'x' WHERE id = ${auditB}`],
      ["delete own audit", (tx) => tx`DELETE FROM audits WHERE id = ${auditB}`],
      ["insert audit", (tx) => tx`INSERT INTO audits (id, principal_id, target_url, hostname, status, phase, limits, progress, state) VALUES ('rls-x', ${"user:" + B}, 'https://x.org/', 'x.org', 'completed', 'done', '{}', '{}', '{}')`],
      ["insert issue", (tx) => tx`INSERT INTO audit_issues (id, audit_id, rule_id, category, severity, page_url, created_at, data) VALUES ('rls-x', ${auditB}, 'r', 'seo', 'low', 'u', now(), '{}')`],
      ["delete usage (reset own limit)", (tx) => tx`DELETE FROM usage_records WHERE principal_id = ${"user:" + B}`],
      ["join an organization", (tx) => tx`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${orgId}, ${B}, 'owner')`],
      ["grant self a subscription", (tx) => tx`INSERT INTO subscriptions (user_id, plan_id, status) VALUES (${B}, 'pro', 'active')`],
    ];
    for (const [name, fn] of attempts) {
      const err = await as("authenticated", B, async (tx) => {
        try {
          await fn(tx);
          return null;
        } catch (e) {
          return e as { code?: string };
        }
      });
      expect(err, name).not.toBeNull();
      expect(["42501", "42P01", "23502", "23503"], `${name}: ${err?.code}`).toContain(err?.code); // permission denied (or rejected before any write)
    }
  });

  it("settings writes are limited to the user's own row", async () => {
    const err = await as("authenticated", B, async (tx) => {
      try {
        await tx`UPDATE user_settings SET theme = 'dark' WHERE principal_id = ${"user:" + A}`;
        const [row] = await tx<{ theme: string }[]>`SELECT theme FROM user_settings WHERE principal_id = ${"user:" + A}`;
        expect(row).toBeUndefined(); // not even visible
        await tx`INSERT INTO user_settings (principal_id) VALUES (${"user:" + randomUUID()})`;
        return null;
      } catch (e) {
        return e as { code?: string };
      }
    });
    expect(err?.code).toBe("42501"); // new row violates row-level security policy
    const [a] = await sql<{ theme: string }[]>`SELECT theme FROM user_settings WHERE principal_id = ${"user:" + A}`;
    expect(a.theme).not.toBe("dark");
  });

  it("the anon role (public key, no session) cannot read any user data", async () => {
    const r = await as("anon", null, async (tx) => {
      const out: Record<string, string> = {};
      for (const t of ["audits", "audit_pages", "audit_issues", "usage_records", "profiles", "user_settings", "organizations", "subscriptions", "principals"]) {
        try {
          const rows = await tx.savepoint((sp) => sp.unsafe(`SELECT 1 FROM ${t} LIMIT 1`));
          out[t] = rows.length ? "ROWS" : "empty";
        } catch (e) {
          out[t] = (e as { code?: string }).code ?? "error";
        }
      }
      return out;
    });
    for (const [t, v] of Object.entries(r)) expect(["42501", "empty"], t).toContain(v);
  });

  it("no browser-readable table exposes credentials or provider keys", async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT c.table_name, c.column_name FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND (has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'SELECT')
          OR has_column_privilege('anon', format('public.%I', c.table_name), c.column_name, 'SELECT'))
        AND c.column_name ~* '(api_?key|secret|password|token|service_role)'`;
    expect(cols).toEqual([]);
  });

  // Hosted Supabase grants ALL on new public tables, sequences and functions to anon,
  // authenticated and service_role (default privileges); setup-db.sh reproduces that.
  // These checks use effective privileges, so they hold whatever the grant source.
  it("API roles hold only the intended table privileges, even with Supabase's default grants", async () => {
    const child = ["audit_pages", "audit_issues", "audit_links", "audit_artifacts", "audit_metrics", "audit_history", "ai_recommendations"];
    // audits and usage_records are readable column by column (see the next test), so no table-level SELECT.
    const authSelect = new Set(["plans", "profiles", "organizations", "organization_members", "subscriptions", "user_settings", ...child]);
    const expected = (t: string, role: string, priv: string) =>
      role === "anon" ? priv === "SELECT" && t === "plans"
      : priv === "SELECT" ? authSelect.has(t)
      : t === "user_settings" && (priv === "INSERT" || priv === "UPDATE");
    const rows = await sql<{ t: string; role: string; priv: string; ok: boolean }[]>`
      SELECT t.tablename AS t, r.role, p.priv, has_table_privilege(r.role, format('public.%I', t.tablename), p.priv) AS ok
      FROM pg_tables t
      CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
      WHERE t.schemaname = 'public'`;
    expect(rows.length).toBeGreaterThanOrEqual(18 * 2 * 7);
    const unexpected = rows.filter((r) => r.ok !== expected(r.t, r.role, r.priv)).map((r) => `${r.role} ${r.priv} ${r.t} = ${r.ok}`);
    expect(unexpected).toEqual([]);
    // Profiles: only the two editable columns can be updated (by the row owner, via RLS).
    const [prof] = await sql<{ name: boolean; email: boolean; id: boolean }[]>`
      SELECT has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE') AS name,
             has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE') AS email,
             has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE') AS id`;
    expect(prof).toEqual({ name: true, email: false, id: false });
  });

  it("internal audit and usage columns (IP hash, access-key hash, idempotency key, crawl state) are not readable through the API", async () => {
    const hidden = [["audits", "access_key_hash"], ["audits", "ip_hash"], ["audits", "idempotency_key"], ["audits", "lease_until"], ["audits", "state"], ["usage_records", "ip_hash"]];
    for (const [t, c] of hidden) {
      const [r] = await sql<{ a: boolean; n: boolean }[]>`
        SELECT has_column_privilege('authenticated', ${"public." + t}, ${c}, 'SELECT') AS a,
               has_column_privilege('anon', ${"public." + t}, ${c}, 'SELECT') AS n`;
      expect({ col: `${t}.${c}`, ...r }).toEqual({ col: `${t}.${c}`, a: false, n: false });
    }
    // The useful columns stay readable for the owner and org members (rows still filtered by RLS).
    for (const [t, c] of [["audits", "id"], ["audits", "title"], ["audits", "status"], ["audits", "overall_score"], ["audits", "summary"], ["usage_records", "kind"], ["usage_records", "created_at"]]) {
      const [r] = await sql<{ a: boolean }[]>`SELECT has_column_privilege('authenticated', ${"public." + t}, ${c}, 'SELECT') AS a`;
      expect({ col: `${t}.${c}`, ...r }).toEqual({ col: `${t}.${c}`, a: true });
    }
    // Actually selecting a hidden column as a signed-in owner is refused.
    const r = await as("authenticated", A, async (tx) => {
      try { await tx`SELECT ip_hash FROM public.audits LIMIT 1`; return "allowed"; } catch (e) { return (e as { code?: string }).code; }
    });
    expect(r).toBe("42501");
  });

  it("anon can execute no app function; authenticated only the two RLS helpers; no sequence is usable", async () => {
    const fns = await sql<{ f: string; anon: boolean; auth: boolean }[]>`
      SELECT n.nspname || '.' || p.proname AS f,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'sitelens_private') ORDER BY 1`;
    expect(fns.length).toBeGreaterThanOrEqual(3);
    const helpers = new Set(["sitelens_private.is_org_member", "sitelens_private.can_read_audit"]);
    expect(fns.filter((f) => f.anon).map((f) => f.f)).toEqual([]);
    expect(fns.filter((f) => f.auth).map((f) => f.f).sort()).toEqual([...helpers].sort());
    const seqs = await sql<{ s: string }[]>`
      SELECT c.relname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
        AND (has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') OR has_sequence_privilege('authenticated', c.oid, 'USAGE,SELECT,UPDATE'))`;
    expect(seqs.map((x) => x.s)).toEqual([]);
    const [schema] = await sql<{ anon: boolean }[]>`SELECT has_schema_privilege('anon', 'sitelens_private', 'USAGE') AS anon`;
    expect(schema.anon).toBe(false);
  });
});

describe("RLS integration prerequisites", () => {
  it.skipIf(enabled)("skipped: set TEST_SUPABASE_DATABASE_URL, TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY to run", () => {
    expect(enabled).toBe(false);
  });
});
