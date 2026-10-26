// Applies SQL migrations from db/migrations (same runner semantics as the app's auto-migration:
// one transaction per migration, serialised by an advisory lock, recorded in schema_migrations).
//
// Usage (first variable set wins; a direct/session connection is preferred for DDL):
//   POSTGRES_URL_NON_POOLING=postgres://... npm run db:migrate
//   DATABASE_URL=postgres://... npm run db:migrate
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const names = ["MIGRATION_DATABASE_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL_UNPOOLED", "DATABASE_URL", "POSTGRES_URL"];
const name = names.find((n) => process.env[n]?.trim());
if (!name) {
  console.error(`No database URL found. Set one of: ${names.join(", ")}.\nExample: DATABASE_URL=postgres://user:pass@host:5432/postgres npm run db:migrate`);
  process.exit(1);
}
const u = new URL(process.env[name].trim());
for (const p of ["supa", "pgbouncer", "connection_limit", "pool_timeout", "schema", "statement_cache_size"]) u.searchParams.delete(p);
const url = u.toString();
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
const sslEnv = (process.env.DATABASE_SSL || "").toLowerCase();
const ssl = sslEnv === "disable" ? false : sslEnv || (local || u.searchParams.has("sslmode") ? undefined : "require");
const sql = postgres(url, { ssl, max: 1, prepare: false, onnotice: (n) => process.env.MIGRATE_VERBOSE && console.log(`  notice: ${n.message}`) });
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

console.log(`Using ${name} (host ${u.hostname}).`);
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const version = file.replace(/\.sql$/, "");
    const body = readFileSync(path.join(dir, file), "utf8");
    const applied = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('sitelens_migrations'))`;
      if ((await tx`SELECT 1 FROM schema_migrations WHERE version = ${version}`).length) return false;
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
      return true;
    });
    console.log(applied ? `✓ ${version} applied` : `✓ ${version} (already applied)`);
  }
  console.log("Migrations complete.");
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, "[REDACTED]") : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
