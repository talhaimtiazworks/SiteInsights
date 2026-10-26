/**
 * Classification of PostgreSQL failures into specific, actionable problems.
 *
 * Before this existed, only connection-level errors were recognised; every
 * other SQL error (missing tables, missing privileges, a database belonging to
 * a different Supabase project …) fell through to the generic HTTP 500
 * "Something went wrong on our side". Each problem below has
 *   - a stable code returned to the browser,
 *   - a short user-facing message (no SQL, hostnames or values),
 *   - an operator hint that is only written to the server log / diagnostics.
 */

export type DatabaseProblem =
  | "database_unavailable"
  | "database_busy"
  | "database_misconfigured"
  | "database_schema_missing"
  | "database_schema_outdated"
  | "database_migration_failed"
  | "database_permission_denied"
  | "database_read_only"
  | "supabase_project_mismatch";

export interface ProblemInfo {
  status: number;
  /** Safe to show to anyone. */
  message: string;
  /** Whether trying again later can help without operator action. */
  retryable: boolean;
  /** For the operator (server log, /api/system/diagnostics). Never sent to browsers. */
  hint: string;
}

const OWNER = "If you run this site, the server log and /api/system/diagnostics show the exact fix.";

export const PROBLEMS: Record<DatabaseProblem, ProblemInfo> = {
  database_unavailable: {
    status: 503,
    retryable: true,
    message: "Audit storage is temporarily unavailable. Your audits are safe — please try again in a moment.",
    hint: "The database could not be reached. On Vercel use the Supabase transaction pooler URL (port 6543) — the direct db.<ref>.supabase.co host is IPv6-only and unreachable from Vercel.",
  },
  database_busy: {
    status: 503,
    retryable: true,
    message: "Audit storage is busy right now. Please try again in a few seconds.",
    hint: "The database refused new connections (connection limit or statement timeout). On serverless hosting use the Supabase transaction pooler (port 6543), not the session pooler (port 5432).",
  },
  database_misconfigured: {
    status: 503,
    retryable: false,
    message: `Audit storage isn't configured correctly on this server. ${OWNER}`,
    hint: "The database rejected the connection settings (user, password, database name or pooler tenant). Copy the connection string again from Supabase → Connect → Transaction pooler; the pooler user must be postgres.<project-ref>.",
  },
  database_schema_missing: {
    status: 503,
    retryable: false,
    message: `Audit storage hasn't been set up yet — the database tables are missing. ${OWNER}`,
    hint: "No SiteInsights tables exist in this database. Run `npm run db:migrate` with MIGRATION_DATABASE_URL set to the project's session/direct connection, paste db/supabase-setup.sql into the Supabase SQL editor of THIS project, or remove DB_AUTO_MIGRATE=false so the app migrates on start.",
  },
  database_schema_outdated: {
    status: 503,
    retryable: false,
    message: `Audit storage needs a database update before audits can be saved. ${OWNER}`,
    hint: "The database schema is older than this version of the app. Apply the missing migrations (`npm run db:migrate`, or db/supabase-setup.sql in the Supabase SQL editor — it is safe to re-run and never deletes data).",
  },
  database_migration_failed: {
    status: 503,
    retryable: false,
    message: `Audit storage couldn't be updated automatically. ${OWNER}`,
    hint: "Automatic migration failed. Run `npm run db:migrate` with MIGRATION_DATABASE_URL set to the session/direct connection and read its error, or paste db/supabase-setup.sql into the Supabase SQL editor.",
  },
  database_permission_denied: {
    status: 503,
    retryable: false,
    message: `Audit storage is misconfigured: the database user lacks the required permissions. ${OWNER}`,
    hint: "The runtime database role cannot read or write the SiteInsights tables. Use the project's `postgres` connection string from Supabase → Connect (the pooler user is postgres.<project-ref>), not a restricted role.",
  },
  database_read_only: {
    status: 503,
    retryable: false,
    message: `Audit storage is read-only on this server. ${OWNER}`,
    hint: "The database URL points at a read replica or a read-only session. Use the primary database's transaction pooler URL.",
  },
  supabase_project_mismatch: {
    status: 503,
    retryable: false,
    message: `Sign-in and audit storage are connected to different Supabase projects, so your account can't be saved. ${OWNER}`,
    hint: "The signed-in user exists in the Supabase Auth project from NEXT_PUBLIC_SUPABASE_URL but not in auth.users of the database from DATABASE_URL/POSTGRES_URL. Point the database URL at the same project (DATABASE_URL takes precedence over the integration's POSTGRES_URL).",
  },
};

export class DatabaseProblemError extends Error {
  readonly problem: DatabaseProblem;
  /** Extra operator context (e.g. missing migration versions). Never sent to browsers. */
  readonly context: Record<string, unknown>;
  constructor(problem: DatabaseProblem, context: Record<string, unknown> = {}) {
    super(PROBLEMS[problem].message);
    this.name = "DatabaseProblemError";
    this.problem = problem;
    this.context = context;
  }
  get info(): ProblemInfo {
    return PROBLEMS[this.problem];
  }
}

const CONNECTION = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|CONNECT_TIMEOUT|CONNECTION_(?:CLOSED|ENDED|DESTROYED)|57P0[1-3]|08\d{3})$/;

/**
 * Maps a driver/server error to a problem, or null when it is not a
 * configuration/infrastructure problem (a genuine bug → HTTP 500).
 */
export function classifyDatabaseError(err: unknown): DatabaseProblem | null {
  if (err instanceof DatabaseProblemError) return err.problem;
  const e = (err ?? {}) as { code?: string; message?: string; constraint_name?: string; constraint?: string };
  const code = String(e.code ?? "");
  const message = String(e.message ?? "");
  if (CONNECTION.test(code)) return "database_unavailable";
  // Wrong password / user / database, or a Supavisor tenant that doesn't exist.
  if (/^(28P01|28000|3D000)$/.test(code)) return "database_misconfigured";
  if (code === "XX000" && /tenant or user not found|password authentication failed/i.test(message)) return "database_misconfigured";
  // TLS failures (certificate verification / sslmode) and SCRAM negotiation failures are configuration.
  if (/^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|ERR_SSL_[A-Z_]+|SASL_SIGNATURE_MISMATCH|AUTH_TYPE_NOT_IMPLEMENTED)$/.test(code)) return "database_misconfigured";
  if (code === "XX000" && /circuit breaker open/i.test(message)) return "database_misconfigured"; // Supavisor after repeated auth failures
  // Serialization failure / deadlock: safe to retry.
  if (code === "53300" || code === "53400" || code === "57014" || code === "40001" || code === "40P01") return "database_busy";
  if (code === "XX000" && /max ?clients|too many (clients|connections)|pool_size/i.test(message)) return "database_busy";
  // Undefined table / column / function / object / schema.
  if (/^(42P01|42703|42883|42704|3F000)$/.test(code)) return "database_schema_outdated";
  if (code === "42501") return "database_permission_denied";
  if (code === "25006") return "database_read_only";
  if (code === "23503" && (e.constraint_name ?? e.constraint) === "profiles_id_auth_users_fkey") return "supabase_project_mismatch";
  return null;
}
