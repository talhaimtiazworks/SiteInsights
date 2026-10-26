#!/usr/bin/env bash
# Creates the local databases used by the integration tests (no Docker needed):
#   sitelens  plain Postgres (TEST_DATABASE_URL)
#   supa      Supabase-shaped database: auth schema (GoTrue migrations),
#             anon / authenticated / service_role roles, and the SiteInsight
#             migrations with RLS (TEST_SUPABASE_DATABASE_URL)
#
# Usage: GOTRUE_DIR=/path/with/auth-binary-and-gotrue.env scripts/local-supabase/setup-db.sh
# Requires: a local PostgreSQL server you can reach with `sudo -u postgres psql`,
#           the GoTrue (supabase/auth) binary and its gotrue.env in $GOTRUE_DIR.
# Idempotent: safe to re-run. Development use only (fixed local passwords).
# RESET_SUPA=1 drops and recreates the supa database first (stop GoTrue before).
set -euo pipefail
GOTRUE_DIR="${GOTRUE_DIR:-$HOME/.gotrue}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$@"; }

# Password GoTrue uses (taken from its own config; never printed).
AUTH_PW="$(sed -nE 's#^DATABASE_URL=postgres://supabase_auth_admin:([^@]+)@.*#\1#p' "$GOTRUE_DIR/gotrue.env")"
[ -n "$AUTH_PW" ] || { echo "Could not read the supabase_auth_admin password from $GOTRUE_DIR/gotrue.env" >&2; exit 1; }

psql_su -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitelens') THEN CREATE ROLE sitelens LOGIN PASSWORD 'sitelens'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN CREATE ROLE app_owner LOGIN PASSWORD 'appowner'; END IF;
END \$\$;
ALTER ROLE supabase_auth_admin PASSWORD '${AUTH_PW}';
GRANT anon, authenticated, service_role TO app_owner;
SQL
if [ "${RESET_SUPA:-0}" = "1" ]; then
  psql_su -d postgres -c "DROP DATABASE IF EXISTS supa WITH (FORCE)"
fi
psql_su -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='sitelens'" | grep -q 1 || psql_su -d postgres -c "CREATE DATABASE sitelens OWNER sitelens"
psql_su -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='supa'" | grep -q 1 || psql_su -d postgres -c "CREATE DATABASE supa OWNER app_owner"

psql_su -d supa <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT CREATE ON DATABASE supa TO supabase_auth_admin;
ALTER ROLE supabase_auth_admin SET search_path = auth;
SQL

# GoTrue's own migrations (creates auth.users, auth.uid(), …).
[ -x "$GOTRUE_DIR/auth" ] || chmod +x "$GOTRUE_DIR/auth"
(cd "$GOTRUE_DIR" && ./auth migrate -c gotrue.env)

psql_su -d supa <<'SQL'
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, app_owner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role, app_owner;
GRANT SELECT, REFERENCES ON auth.users TO app_owner;
SQL

# Mirror hosted Supabase: objects created in "public" are granted to the API roles
# by default (default privileges), so the migrations must revoke what they don't
# want exposed. Without this, local RLS/privilege tests would be too optimistic.
psql_su -d supa <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL

# SiteInsight migrations (including RLS policies and API-role privileges).
(cd "$ROOT" && DATABASE_SSL=disable MIGRATION_DATABASE_URL="postgres://app_owner:appowner@127.0.0.1:5432/supa" node scripts/migrate.mjs)
(cd "$ROOT" && DATABASE_SSL=disable MIGRATION_DATABASE_URL="postgres://sitelens:sitelens@127.0.0.1:5432/sitelens" node scripts/migrate.mjs)
echo "Local databases ready: sitelens, supa"
