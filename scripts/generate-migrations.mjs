// Regenerates src/lib/db/migrations.ts and db/supabase-setup.sql from db/migrations/*.sql.
// Usage: npm run db:generate   (a unit test fails if the generated files are stale)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const migrations = files.map((f) => ({ version: f.replace(/\.sql$/, ""), sql: readFileSync(path.join(dir, f), "utf8") }));

const ts = `/**
 * Database migrations. Each entry is applied once, in order, inside a
 * transaction, and recorded in schema_migrations.
 *
 * GENERATED from db/migrations/*.sql by \`npm run db:generate\` — do not edit by hand.
 * A unit test fails if this file is out of date.
 */
export interface Migration {
  version: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = ${JSON.stringify(migrations, null, 2)};
`;
writeFileSync(path.join(root, "src", "lib", "db", "migrations.ts"), ts);

const last = migrations[migrations.length - 1].version;
const bundle = `-- SiteInsight — complete database setup for the Supabase SQL editor.
-- GENERATED from db/migrations/*.sql by \`npm run db:generate\` — do not edit by hand.
--
-- Use this ONLY if you cannot run \`npm run db:migrate\` and have turned off DB_AUTO_MIGRATE.
-- Paste the whole file into Supabase Dashboard → SQL Editor → New query → Run.
-- It refuses to run on a database where the latest migration (${last}) is already recorded.
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '${last}') THEN
    RAISE EXCEPTION 'SiteInsight database is already up to date (${last} applied). Nothing to do.';
  END IF;
END $guard$;
${migrations
  .map(
    (m) => `
-- ════════ ${m.version} ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
${m.sql.trim()}
INSERT INTO schema_migrations (version) VALUES ('${m.version}') ON CONFLICT (version) DO NOTHING;
`,
  )
  .join("")}
COMMIT;
`;
writeFileSync(path.join(root, "db", "supabase-setup.sql"), bundle);
console.log(`Generated ${migrations.length} migrations → src/lib/db/migrations.ts, db/supabase-setup.sql`);
