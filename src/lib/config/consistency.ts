/**
 * Supabase configuration consistency checks.
 *
 * Every Supabase-related variable identifies a project:
 *   https://<ref>.supabase.co                                (API URL)
 *   postgres://postgres.<ref>:…@aws-0-…pooler.supabase.com   (Supavisor pooler; port 6543 = transaction, 5432 = session)
 *   postgres://postgres:…@db.<ref>.supabase.co:5432          (direct connection, IPv6-only)
 *   legacy anon / service_role JWT keys carry a `ref` claim  (sb_publishable_/sb_secret_ keys don't)
 * If they disagree, sign-in happens in one project while audits are written to
 * another — the app then fails on its first account write. These checks name
 * variables only; values are never included in the output.
 */

type Env = Record<string, string | undefined>;

export interface ConfigIssue {
  severity: "error" | "warning";
  /** Environment variable(s) to change. */
  variables: string[];
  problem: string;
  fix: string;
}

export type DbConnectionKind = "supabase-transaction-pooler" | "supabase-session-pooler" | "supabase-direct" | "supabase-dedicated-pooler" | "other";

export interface DbUrlInfo {
  ref: string | null;
  kind: DbConnectionKind;
  host: string;
  port: number;
  database: string;
  user: string;
}

const REF = /^[a-z0-9]{20}$/;
const URL_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"] as const;
const PUBLIC_KEY_VARS = ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"] as const;
const SECRET_KEY_VARS = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;
export const RUNTIME_DB_VARS = ["DATABASE_URL", "POSTGRES_URL"] as const;
export const MIGRATION_DB_VARS = ["MIGRATION_DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED"] as const;
const OTHER_DB_VARS = ["POSTGRES_PRISMA_URL"] as const;

const val = (env: Env, n: string) => env[n]?.trim() || null;

/** Project ref from a Supabase API URL (https://<ref>.supabase.co). */
export function refFromSupabaseUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const m = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(new URL(raw).hostname);
    return m && REF.test(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

/** Parses a Postgres URL into its Supabase project ref and connection kind. */
export function parseDbUrl(raw: string | null): DbUrlInfo | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  const host = u.hostname.toLowerCase();
  const port = Number(u.port || 5432);
  const user = decodeURIComponent(u.username);
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  const direct = /^db\.([a-z0-9]+)\.supabase\.(co|in)$/.exec(host);
  if (direct && REF.test(direct[1])) return { ref: direct[1], kind: port === 6543 ? "supabase-dedicated-pooler" : "supabase-direct", host, port, database, user };
  if (/\.pooler\.supabase\.com$/.test(host)) {
    const m = /^[^.]+\.([a-z0-9]+)$/.exec(user);
    return { ref: m && REF.test(m[1]) ? m[1] : null, kind: port === 6543 ? "supabase-transaction-pooler" : "supabase-session-pooler", host, port, database, user };
  }
  return { ref: null, kind: "other", host, port, database, user };
}

function jwtClaims(key: string | null): { ref?: string; role?: string } | null {
  if (!key || !/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) return null;
  try {
    const json = typeof atob === "function" ? atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")) : Buffer.from(key.split(".")[1], "base64url").toString("utf8");
    const c = JSON.parse(json) as { ref?: unknown; role?: unknown };
    return { ref: typeof c.ref === "string" ? c.ref : undefined, role: typeof c.role === "string" ? c.role : undefined };
  } catch {
    return null;
  }
}

/** True when two database URLs reach the same database (same Supabase project, or same host/port/db). */
export function sameDatabase(a: DbUrlInfo, b: DbUrlInfo): boolean {
  if (a.ref || b.ref) return !!a.ref && a.ref === b.ref && a.database === b.database;
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

export interface ConsistencyReport {
  issues: ConfigIssue[];
  /** Which project each set variable points to (refs are public — they are part of the Supabase URL). */
  projects: Record<string, string | null>;
  runtimeDb: { variable: string; kind: DbConnectionKind } | null;
  /** Variable chosen for migrations by the running app (null = the runtime URL). */
  migrationDb: { variable: string; kind: DbConnectionKind } | null;
}

export function checkSupabaseConsistency(env: Env, opts: { serverless: boolean }): ConsistencyReport {
  const issues: ConfigIssue[] = [];
  const projects: Record<string, string | null> = {};

  const urlVar = URL_VARS.find((n) => val(env, n));
  for (const n of URL_VARS) if (val(env, n)) projects[n] = refFromSupabaseUrl(val(env, n));
  const authRef = urlVar ? projects[urlVar] : null;

  const runtimeVar = RUNTIME_DB_VARS.find((n) => val(env, n)) ?? null;
  const dbInfo: Record<string, DbUrlInfo | null> = {};
  for (const n of [...RUNTIME_DB_VARS, ...MIGRATION_DB_VARS, ...OTHER_DB_VARS]) {
    if (!val(env, n)) continue;
    dbInfo[n] = parseDbUrl(val(env, n));
    projects[n] = dbInfo[n]?.ref ?? null;
  }
  const runtime = runtimeVar ? dbInfo[runtimeVar] : null;

  // 1. Auth project vs runtime database project — the failure that breaks sign-in, start audit and the dashboard.
  if (authRef && runtime?.ref && runtime.ref !== authRef) {
    const other = runtimeVar === "DATABASE_URL" && dbInfo.POSTGRES_URL?.ref === authRef;
    issues.push({
      severity: "error",
      variables: [runtimeVar!, urlVar!],
      problem: `${runtimeVar} points to a different Supabase project than ${urlVar}. Accounts are created in one project and audits saved in another, so signed-in requests fail.`,
      fix: other
        ? `Remove DATABASE_URL (it overrides POSTGRES_URL, which already points to the right project) or replace it with that project's transaction pooler URL, then redeploy.`
        : `Set ${runtimeVar} to the transaction pooler connection string of the project in ${urlVar} (Supabase → Connect → Transaction pooler), then redeploy.`,
    });
  }
  // 2. Any other Supabase variable from yet another project.
  const reference = authRef ?? runtime?.ref ?? null;
  const referenceVar = authRef ? urlVar! : runtimeVar;
  if (reference) {
    for (const [n, ref] of Object.entries(projects)) {
      if (!ref || ref === reference || n === referenceVar || (n === runtimeVar && authRef)) continue;
      issues.push({ severity: "warning", variables: [n, referenceVar!], problem: `${n} belongs to a different Supabase project than ${referenceVar}.`, fix: `Remove ${n} or set it from the same project as ${referenceVar}.` });
    }
  }
  // 3. Keys: legacy JWT keys carry the project ref and role.
  for (const n of PUBLIC_KEY_VARS) {
    const c = jwtClaims(val(env, n));
    if (!c) continue;
    if (c.role === "service_role") issues.push({ severity: "error", variables: [n], problem: `${n} contains the service_role key, which bypasses Row Level Security${n.startsWith("NEXT_PUBLIC_") ? " and is sent to browsers" : ""}.`, fix: `Replace it with the anon/publishable key (Supabase → Settings → API Keys) and rotate the service_role key.` });
    if (c.ref && reference && c.ref !== reference) issues.push({ severity: "error", variables: [n, referenceVar!], problem: `${n} is a key for a different Supabase project than ${referenceVar}.`, fix: `Copy the publishable key from the same project's Settings → API Keys.` });
  }
  for (const n of SECRET_KEY_VARS) {
    const v = val(env, n);
    const c = jwtClaims(v);
    if ((c && c.role && c.role !== "service_role") || (v && /^sb_publishable_/.test(v))) issues.push({ severity: "warning", variables: [n], problem: `${n} contains a public (anon/publishable) key, not a secret key; account deletion will fail.`, fix: `Use the secret (sb_secret_…) or service_role key from Settings → API Keys.` });
    if (c?.ref && reference && c.ref !== reference) issues.push({ severity: "error", variables: [n, referenceVar!], problem: `${n} is a key for a different Supabase project than ${referenceVar}.`, fix: `Copy the secret key from the same project's Settings → API Keys.` });
  }
  // 4. Runtime connection type.
  if (runtime && runtimeVar) {
    if (runtime.kind === "supabase-direct" && opts.serverless) {
      issues.push({ severity: "error", variables: [runtimeVar], problem: `${runtimeVar} uses the direct db.<ref>.supabase.co host, which is IPv6-only and not reachable from Vercel.`, fix: `Use the transaction pooler URL (port 6543) from Supabase → Connect.` });
    } else if (runtime.kind === "supabase-session-pooler" && opts.serverless) {
      issues.push({ severity: "warning", variables: [runtimeVar], problem: `${runtimeVar} uses the session pooler (port 5432); serverless functions can exhaust its connection limit.`, fix: `Use the transaction pooler (same URL with port 6543) for the app; keep the session URL for migrations (MIGRATION_DATABASE_URL).` });
    }
    if ((runtime.kind === "supabase-transaction-pooler" || runtime.kind === "supabase-session-pooler") && !runtime.ref) {
      issues.push({ severity: "error", variables: [runtimeVar], problem: `${runtimeVar} connects to the Supabase pooler without the project ref in the user name.`, fix: `The pooler user must be postgres.<project-ref>; copy the URL again from Supabase → Connect.` });
    }
  }
  // 5. Migration connection: a session/direct URL for the SAME database, if any.
  let migrationDb: ConsistencyReport["migrationDb"] = null;
  for (const n of MIGRATION_DB_VARS) {
    const info = dbInfo[n];
    if (!info) continue;
    if (n === "MIGRATION_DATABASE_URL" && info.kind === "supabase-transaction-pooler") {
      issues.push({ severity: "warning", variables: [n], problem: `${n} uses the transaction pooler (port 6543); migrations should use a session or direct connection.`, fix: `Use the session pooler URL (port 5432) or the direct connection.` });
    }
    if (runtime && !sameDatabase(info, runtime)) {
      if (!issues.some((i) => i.variables[0] === n)) issues.push({ severity: "warning", variables: [n, runtimeVar!], problem: `${n} points to a different database than ${runtimeVar}; it is ignored for automatic migrations.`, fix: `Set ${n} from the same project, or remove it.` });
      continue;
    }
    // The direct host is IPv6-only: unusable from serverless functions.
    if (info.kind === "supabase-direct" && opts.serverless) continue;
    if (info.kind === "supabase-transaction-pooler") continue;
    if (!migrationDb && runtime && runtime.kind === "supabase-transaction-pooler") migrationDb = { variable: n, kind: info.kind };
  }
  return { issues, projects, runtimeDb: runtime && runtimeVar ? { variable: runtimeVar, kind: runtime.kind } : null, migrationDb };
}
