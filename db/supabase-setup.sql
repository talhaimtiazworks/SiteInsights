-- SiteInsight — complete database setup for the Supabase SQL editor.
-- GENERATED from db/migrations/*.sql by `npm run db:generate` — do not edit by hand.
--
-- Use this ONLY if you cannot run `npm run db:migrate` and have turned off DB_AUTO_MIGRATE.
-- Paste the whole file into Supabase Dashboard → SQL Editor → New query → Run.
-- It refuses to run on a database where the latest migration (012_feedback) is already recorded.
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '012_feedback') THEN
    RAISE EXCEPTION 'SiteInsight database is already up to date (012_feedback applied). Nothing to do.';
  END IF;
END $guard$;

-- ════════ 001_initial ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- SiteLens AI initial schema
CREATE TABLE IF NOT EXISTS principals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'anonymous',
  plan          TEXT NOT NULL DEFAULT 'free',
  ip_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS websites (
  id               TEXT PRIMARY KEY,
  origin           TEXT NOT NULL UNIQUE,
  hostname         TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scans (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  website_id    TEXT REFERENCES websites(id) ON DELETE SET NULL,
  target_url    TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','completed','completed_with_warnings','failed','cancelled')),
  phase         TEXT NOT NULL,
  limits        JSONB NOT NULL,
  progress      JSONB NOT NULL,
  state         JSONB NOT NULL,
  warnings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error         JSONB,
  summary       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scans_principal_created_idx ON scans (principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scans_status_updated_idx ON scans (status, updated_at);

CREATE TABLE IF NOT EXISTS scan_pages (
  id           TEXT PRIMARY KEY,
  scan_id      TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  final_url    TEXT NOT NULL,
  status_code  INTEGER,
  depth        INTEGER NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL,
  data         JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS scan_pages_scan_idx ON scan_pages (scan_id);

CREATE TABLE IF NOT EXISTS link_checks (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  is_internal   BOOLEAN NOT NULL,
  category      TEXT NOT NULL,
  verification  TEXT NOT NULL,
  status_code   INTEGER,
  checked_at    TIMESTAMPTZ NOT NULL,
  data          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS link_checks_scan_idx ON link_checks (scan_id, category);

CREATE TABLE IF NOT EXISTS findings (
  id            TEXT PRIMARY KEY,
  scan_id       TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  rule_id       TEXT NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  affected_url  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  data          JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_scan_idx ON findings (scan_id, severity);

CREATE TABLE IF NOT EXISTS ai_recommendations (
  id             TEXT PRIMARY KEY,
  scan_id        TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  finding_key    TEXT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('openrouter','gemini')),
  model          TEXT NOT NULL,
  fallback_from  TEXT,
  content        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scan_id, finding_key)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id            BIGSERIAL PRIMARY KEY,
  principal_id  TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  amount        INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_principal_idx ON usage_events (kind, principal_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_ip_idx ON usage_events (kind, ip_hash, created_at);

-- Provider configuration REFERENCES only. API keys are never stored in the database.
CREATE TABLE IF NOT EXISTS provider_preferences (
  principal_id  TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('openrouter','gemini')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('001_initial') ON CONFLICT (version) DO NOTHING;

-- ════════ 002_scan_access ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- Scan access keys and idempotent scan creation
ALTER TABLE scans ADD COLUMN IF NOT EXISTS access_key_hash TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS scans_idempotency_idx ON scans (principal_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
INSERT INTO schema_migrations (version) VALUES ('002_scan_access') ON CONFLICT (version) DO NOTHING;

-- ════════ 003_scan_artifacts ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- Browser render and performance results (bounded JSON per page/strategy)
CREATE TABLE IF NOT EXISTS scan_artifacts (
  id          TEXT PRIMARY KEY,
  scan_id     TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('render','performance')),
  key         TEXT NOT NULL,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scan_id, kind, key)
);
CREATE INDEX IF NOT EXISTS scan_artifacts_scan_idx ON scan_artifacts (scan_id, kind);
INSERT INTO schema_migrations (version) VALUES ('003_scan_artifacts') ON CONFLICT (version) DO NOTHING;

-- ════════ 004_supabase_accounts ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- SiteLens AI 004: accounts (Supabase Auth), audit tables, organizations, plans, history and Row Level Security.
-- Idempotent: safe to re-run. Works on Supabase and on plain PostgreSQL (RLS policies are only
-- created where the Supabase roles and auth.uid() exist; RLS itself is always enabled).

-- ── 1. Rename scan tables to audit tables ───────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.scans') IS NOT NULL AND to_regclass('public.audits') IS NULL THEN ALTER TABLE public.scans RENAME TO audits; END IF;
  IF to_regclass('public.scan_pages') IS NOT NULL AND to_regclass('public.audit_pages') IS NULL THEN ALTER TABLE public.scan_pages RENAME TO audit_pages; END IF;
  IF to_regclass('public.findings') IS NOT NULL AND to_regclass('public.audit_issues') IS NULL THEN ALTER TABLE public.findings RENAME TO audit_issues; END IF;
  IF to_regclass('public.link_checks') IS NOT NULL AND to_regclass('public.audit_links') IS NULL THEN ALTER TABLE public.link_checks RENAME TO audit_links; END IF;
  IF to_regclass('public.scan_artifacts') IS NOT NULL AND to_regclass('public.audit_artifacts') IS NULL THEN ALTER TABLE public.scan_artifacts RENAME TO audit_artifacts; END IF;
  IF to_regclass('public.usage_events') IS NOT NULL AND to_regclass('public.usage_records') IS NULL THEN ALTER TABLE public.usage_events RENAME TO usage_records; END IF;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_pages','audit_issues','audit_links','audit_artifacts','ai_recommendations'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'scan_id') THEN
      EXECUTE format('ALTER TABLE public.%I RENAME COLUMN scan_id TO audit_id', t);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_issues' AND column_name = 'affected_url') THEN
    ALTER TABLE public.audit_issues RENAME COLUMN affected_url TO page_url;
  END IF;
END $$;

-- ── 2. Accounts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID PRIMARY KEY,
  email         TEXT,
  display_name  TEXT CHECK (display_name IS NULL OR char_length(display_name) <= 80),
  avatar_url    TEXT CHECK (avatar_url IS NULL OR avatar_url ~ '^https://'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profiles_email_idx ON profiles (lower(email));

-- On Supabase, a profile is removed together with its auth user.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_auth_users_fkey') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_auth_users_fkey FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping profiles → auth.users foreign key (no REFERENCES privilege on auth.users).';
END $$;

-- Principals own audits and usage. Signed-in users are "user:<auth uid>"; anonymous browsers are a random UUID.
ALTER TABLE principals ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES profiles (id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS principals_user_idx ON principals (user_id) WHERE user_id IS NOT NULL;

-- ── 3. Organizations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_by  UUID REFERENCES profiles (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id  UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS organization_members_user_idx ON organization_members (user_id);

-- ── 4. Plans and subscriptions (no payment integration; free = no subscription row) ──
CREATE TABLE IF NOT EXISTS plans (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{1,32}$'),
  name         TEXT NOT NULL,
  description  TEXT,
  -- Optional limit overrides (same keys as the FREE_* environment variables, camelCase). Empty = use env defaults.
  limits       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_public    BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO plans (id, name, description, sort_order) VALUES ('free', 'Free', 'Free plan. Limits are set by the FREE_* environment variables.', 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriptions (
  id                    UUID PRIMARY KEY,
  user_id               UUID REFERENCES profiles (id) ON DELETE CASCADE,
  organization_id       UUID REFERENCES organizations (id) ON DELETE CASCADE,
  plan_id               TEXT NOT NULL REFERENCES plans (id),
  status                TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','incomplete')),
  provider              TEXT,
  provider_reference    TEXT,
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  cancel_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live_per_user ON subscriptions (user_id) WHERE status IN ('trialing','active','past_due') AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_org_idx ON subscriptions (organization_id) WHERE organization_id IS NOT NULL;

-- ── 5. Audits ───────────────────────────────────────────────────────────────
ALTER TABLE audits ADD COLUMN IF NOT EXISTS title TEXT CHECK (title IS NULL OR char_length(title) <= 120);
ALTER TABLE audits ADD COLUMN IF NOT EXISTS owner_id UUID GENERATED ALWAYS AS (CASE WHEN principal_id LIKE 'user:%' THEN substr(principal_id, 6)::uuid END) STORED;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations (id) ON DELETE SET NULL;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS rerun_of TEXT REFERENCES audits (id) ON DELETE SET NULL;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS overall_score INTEGER CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100);
-- Hashed (never raw) IP of the creating request, so background processing can apply per-IP limits.
ALTER TABLE audits ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE audits ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS audits_owner_created_idx ON audits (owner_id, created_at DESC) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audits_org_idx ON audits (organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audits_runnable_idx ON audits (updated_at) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS audits_rerun_idx ON audits (rerun_of) WHERE rerun_of IS NOT NULL;
UPDATE audits a SET overall_score = s.v FROM (
  SELECT id, round(avg(value::numeric))::int AS v
  FROM audits, jsonb_each_text(COALESCE(summary->'scores', '{}'::jsonb)) AS e(key, value)
  WHERE key <> 'performance' AND value ~ '^[0-9]+(\.[0-9]+)?$'
  GROUP BY id
) s WHERE a.id = s.id AND a.overall_score IS NULL;

-- ── 6. Audit detail tables ──────────────────────────────────────────────────
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS canonical_url TEXT;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS title TEXT;
UPDATE audit_pages SET canonical_url = data->>'canonical', title = left(data->>'title', 500) WHERE canonical_url IS NULL AND title IS NULL AND (data ? 'canonical' OR data ? 'title');

ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS recommendation TEXT;
ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS evidence JSONB;
ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS resolution_status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE audit_issues ADD COLUMN IF NOT EXISTS resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_issues_resolution_status_check') THEN
    ALTER TABLE public.audit_issues ADD CONSTRAINT audit_issues_resolution_status_check CHECK (resolution_status IN ('open','resolved','ignored'));
  END IF;
END $$;
UPDATE audit_issues SET title = data->>'title', description = data->>'description', recommendation = data->>'recommendation', evidence = data->'evidence' WHERE title IS NULL;
CREATE INDEX IF NOT EXISTS audit_issues_rule_idx ON audit_issues (audit_id, rule_id);

ALTER TABLE audit_links ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE audit_links ADD COLUMN IF NOT EXISTS final_url TEXT;
ALTER TABLE audit_links ADD COLUMN IF NOT EXISTS redirect_count INTEGER NOT NULL DEFAULT 0;
UPDATE audit_links SET source_url = data->'sources'->>0, final_url = data->>'finalUrl', redirect_count = COALESCE(jsonb_array_length(data->'redirectChain'), 0)
  WHERE source_url IS NULL AND final_url IS NULL AND data ? 'sources';

CREATE TABLE IF NOT EXISTS audit_metrics (
  id          BIGSERIAL PRIMARY KEY,
  audit_id    TEXT NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  -- Stable identity within an audit, e.g. "score:seo" or "pagespeed:mobile:lcp".
  key         TEXT NOT NULL,
  metric      TEXT NOT NULL,
  category    TEXT NOT NULL,
  value       DOUBLE PRECISION,
  unit        TEXT,
  -- Where the number came from: sitelens_rules, crawler, link_checker, pagespeed_lab, crux_field, axe_core, browser.
  source      TEXT NOT NULL,
  -- e.g. {"strategy":"mobile","url":"…"}; never secrets.
  context     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, key)
);

CREATE TABLE IF NOT EXISTS audit_history (
  id           BIGSERIAL PRIMARY KEY,
  audit_id     TEXT NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  event        TEXT NOT NULL CHECK (event IN ('created','status_changed','renamed','issue_status_changed','shared','unshared')),
  from_status  TEXT,
  to_status    TEXT,
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_history_audit_idx ON audit_history (audit_id, created_at);

CREATE OR REPLACE FUNCTION public.sitelens_audit_history() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_history (audit_id, event, to_status, detail) VALUES (NEW.id, 'created', NEW.status, jsonb_build_object('rerun_of', NEW.rerun_of));
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO audit_history (audit_id, event, from_status, to_status, detail)
      VALUES (NEW.id, 'status_changed', OLD.status, NEW.status, CASE WHEN NEW.error IS NOT NULL THEN jsonb_build_object('error_code', NEW.error->>'code') ELSE '{}'::jsonb END);
    END IF;
    IF NEW.title IS DISTINCT FROM OLD.title THEN
      INSERT INTO audit_history (audit_id, event, detail) VALUES (NEW.id, 'renamed', jsonb_build_object('title', NEW.title));
    END IF;
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      INSERT INTO audit_history (audit_id, event, detail) VALUES (NEW.id, CASE WHEN NEW.organization_id IS NULL THEN 'unshared' ELSE 'shared' END, jsonb_build_object('organization_id', COALESCE(NEW.organization_id, OLD.organization_id)));
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS audits_history_trg ON audits;
CREATE TRIGGER audits_history_trg AFTER INSERT OR UPDATE OF status, title, organization_id ON audits FOR EACH ROW EXECUTE FUNCTION public.sitelens_audit_history();

-- ── 7. Settings (provider choice only — API keys are never stored in the database) ──
CREATE TABLE IF NOT EXISTS user_settings (
  principal_id         TEXT PRIMARY KEY REFERENCES principals (id) ON DELETE CASCADE,
  ai_provider          TEXT CHECK (ai_provider IS NULL OR ai_provider IN ('openrouter','gemini')),
  theme                TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  default_browser      BOOLEAN NOT NULL DEFAULT true,
  default_performance  BOOLEAN NOT NULL DEFAULT true,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$
BEGIN
  IF to_regclass('public.provider_preferences') IS NOT NULL THEN
    INSERT INTO public.user_settings (principal_id, ai_provider, updated_at)
      SELECT principal_id, provider, updated_at FROM public.provider_preferences
      ON CONFLICT (principal_id) DO UPDATE SET ai_provider = EXCLUDED.ai_provider;
    DROP TABLE public.provider_preferences;
  END IF;
END $$;

-- ── 8. Row Level Security ───────────────────────────────────────────────────
-- The application server connects as the table owner and enforces ownership in every query.
-- RLS additionally protects the tables from direct access through the Supabase Data API
-- (the publishable key is public): users can read only their own rows, and organization
-- members can read audits shared with their organization. No client writes except own
-- profile and settings.
ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- Supabase API roles (created here only on plain PostgreSQL, when permitted).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot create the anon/authenticated roles; RLS policies will be skipped (RLS stays enabled, so those roles have no access).';
END $$;

-- auth.uid() exists on Supabase. On plain PostgreSQL a compatible function is created (reads request.jwt.claims).
DO $$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
      SELECT nullif(coalesce(current_setting('request.jwt.claim.sub', true), current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid
    $f$;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Cannot create auth.uid(); RLS policies will be skipped.';
END $$;

DO $$
DECLARE
  t TEXT;
  child TEXT[] := ARRAY['audit_pages','audit_issues','audit_links','audit_artifacts','audit_metrics','audit_history','ai_recommendations'];
  all_tables TEXT[] := ARRAY['principals','websites','schema_migrations','profiles','organizations','organization_members','plans','subscriptions','audits','audit_pages','audit_issues','audit_links','audit_artifacts','audit_metrics','audit_history','ai_recommendations','usage_records','user_settings'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE NOTICE 'Supabase roles or auth.uid() unavailable: skipping RLS policies.';
    RETURN;
  END IF;

  -- Private helper schema (not exposed through the Data API). SECURITY DEFINER avoids recursive policy checks.
  CREATE SCHEMA IF NOT EXISTS sitelens_private;
  REVOKE ALL ON SCHEMA sitelens_private FROM PUBLIC;
  GRANT USAGE ON SCHEMA sitelens_private TO authenticated;

  CREATE OR REPLACE FUNCTION sitelens_private.is_org_member(p_org UUID) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$
      SELECT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = p_org AND m.user_id = auth.uid())
    $f$;
  CREATE OR REPLACE FUNCTION sitelens_private.can_read_audit(p_audit TEXT) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $f$
      SELECT EXISTS (
        SELECT 1 FROM public.audits a
        WHERE a.id = p_audit
          AND (a.owner_id = auth.uid()
               OR (a.organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = a.organization_id AND m.user_id = auth.uid())))
      )
    $f$;
  REVOKE ALL ON FUNCTION sitelens_private.is_org_member(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION sitelens_private.can_read_audit(TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION sitelens_private.is_org_member(UUID) TO authenticated;
  GRANT EXECUTE ON FUNCTION sitelens_private.can_read_audit(TEXT) TO authenticated;

  -- Least privilege for the API roles: nothing by default, then explicit grants below.
  FOREACH t IN ARRAY all_tables LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
  REVOKE ALL ON FUNCTION public.sitelens_audit_history() FROM PUBLIC;

  GRANT SELECT ON public.plans TO anon, authenticated;
  GRANT SELECT ON public.profiles, public.organizations, public.organization_members, public.subscriptions, public.audits, public.usage_records, public.user_settings TO authenticated;
  GRANT UPDATE (display_name, avatar_url) ON public.profiles TO authenticated;
  GRANT INSERT, UPDATE ON public.user_settings TO authenticated;
  FOREACH t IN ARRAY child LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;

  -- Policies (dropped and recreated so re-running converges).
  DROP POLICY IF EXISTS plans_read ON public.plans;
  CREATE POLICY plans_read ON public.plans FOR SELECT TO anon, authenticated USING (is_public);

  DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
  CREATE POLICY profiles_select_own ON public.profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
  DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
  CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

  DROP POLICY IF EXISTS organizations_select_member ON public.organizations;
  CREATE POLICY organizations_select_member ON public.organizations FOR SELECT TO authenticated USING (sitelens_private.is_org_member(id));
  DROP POLICY IF EXISTS organization_members_select_member ON public.organization_members;
  CREATE POLICY organization_members_select_member ON public.organization_members FOR SELECT TO authenticated USING (sitelens_private.is_org_member(organization_id));

  DROP POLICY IF EXISTS subscriptions_select_own ON public.subscriptions;
  CREATE POLICY subscriptions_select_own ON public.subscriptions FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()) OR (organization_id IS NOT NULL AND sitelens_private.is_org_member(organization_id)));

  DROP POLICY IF EXISTS audits_select_own_or_org ON public.audits;
  CREATE POLICY audits_select_own_or_org ON public.audits FOR SELECT TO authenticated
    USING (owner_id = (SELECT auth.uid()) OR (organization_id IS NOT NULL AND sitelens_private.is_org_member(organization_id)));

  FOREACH t IN ARRAY child LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_via_audit', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (sitelens_private.can_read_audit(audit_id))', t || '_select_via_audit', t);
  END LOOP;

  DROP POLICY IF EXISTS usage_records_select_own ON public.usage_records;
  CREATE POLICY usage_records_select_own ON public.usage_records FOR SELECT TO authenticated USING (principal_id = 'user:' || (SELECT auth.uid())::text);

  DROP POLICY IF EXISTS user_settings_select_own ON public.user_settings;
  CREATE POLICY user_settings_select_own ON public.user_settings FOR SELECT TO authenticated USING (principal_id = 'user:' || (SELECT auth.uid())::text);
  DROP POLICY IF EXISTS user_settings_insert_own ON public.user_settings;
  CREATE POLICY user_settings_insert_own ON public.user_settings FOR INSERT TO authenticated WITH CHECK (principal_id = 'user:' || (SELECT auth.uid())::text);
  DROP POLICY IF EXISTS user_settings_update_own ON public.user_settings;
  CREATE POLICY user_settings_update_own ON public.user_settings FOR UPDATE TO authenticated
    USING (principal_id = 'user:' || (SELECT auth.uid())::text) WITH CHECK (principal_id = 'user:' || (SELECT auth.uid())::text);
END $$;
INSERT INTO schema_migrations (version) VALUES ('004_supabase_accounts') ON CONFLICT (version) DO NOTHING;

-- ════════ 005_api_privileges ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 005: least-privilege hardening for the Supabase Data API roles.
--
-- Hosted Supabase sets default privileges so that every table, sequence and
-- function created in "public" is granted to anon, authenticated and service_role
-- directly. 004 revoked table privileges, but its function revokes only covered
-- PUBLIC (the direct grants survived) and sequences were not revoked. Rows were
-- always protected by RLS; this closes the remaining privilege gaps:
--   * no EXECUTE for anon/authenticated on app functions except the two RLS
--     helpers (authenticated only);
--   * no privileges on app sequences for anon/authenticated;
--   * audits and usage_records readable through the API column by column, so
--     internal columns (IP hash, access-key hash, idempotency key, lease, crawl
--     state) are never exposed to owners or organization members.
-- The app's server connection (table owner) is unaffected. Safe to re-run;
-- a no-op on plain Postgres without the Supabase roles.
DO $$
DECLARE
  r RECORD;
  audit_cols TEXT;
  usage_cols TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles unavailable: skipping API privilege hardening.';
    RETURN;
  END IF;

  -- Functions in the app's schemas: revoke direct grants too, then re-grant the helpers.
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'sitelens_private')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') -- skip extension functions
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
  END LOOP;
  IF to_regprocedure('sitelens_private.is_org_member(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION sitelens_private.is_org_member(UUID) TO authenticated;
  END IF;
  IF to_regprocedure('sitelens_private.can_read_audit(text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION sitelens_private.can_read_audit(TEXT) TO authenticated;
  END IF;
  IF to_regnamespace('sitelens_private') IS NOT NULL THEN
    REVOKE ALL ON SCHEMA sitelens_private FROM PUBLIC, anon;
  END IF;

  -- Sequences owned by app tables (identity/serial columns): server-only.
  FOR r IN
    SELECT c.oid::regclass AS seq
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon, authenticated', r.seq);
  END LOOP;

  -- audits / usage_records: column-level SELECT without internal columns.
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO audit_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'audits'
    AND column_name NOT IN ('access_key_hash', 'ip_hash', 'idempotency_key', 'lease_until', 'state');
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO usage_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'usage_records' AND column_name <> 'ip_hash';

  REVOKE ALL ON public.audits, public.usage_records FROM anon, authenticated;
  -- Column privileges survive a table-level REVOKE, so clear them explicitly.
  EXECUTE 'REVOKE SELECT (access_key_hash, ip_hash, idempotency_key, lease_until, state) ON public.audits FROM anon, authenticated';
  EXECUTE 'REVOKE SELECT (ip_hash) ON public.usage_records FROM anon, authenticated';
  IF audit_cols IS NOT NULL THEN
    EXECUTE format('GRANT SELECT (%s) ON public.audits TO authenticated', audit_cols);
  END IF;
  IF usage_cols IS NOT NULL THEN
    EXECUTE format('GRANT SELECT (%s) ON public.usage_records TO authenticated', usage_cols);
  END IF;
END $$;
INSERT INTO schema_migrations (version) VALUES ('005_api_privileges') ON CONFLICT (version) DO NOTHING;

-- ════════ 006_plans_credits_prospects ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 006: paid plans, provider-agnostic billing events, credit ledger, prospects and batch audits.
-- Idempotent and additive: existing users, audits and usage records are preserved.
-- All new tables are server-only (the app's table-owner connection); RLS is enabled
-- and the Supabase API roles get no privileges, so nothing is exposed via the Data API.

-- ── 1. Plans (the application catalog in src/lib/billing/plans.ts is authoritative for limits) ──
INSERT INTO plans (id, name, description, sort_order) VALUES
  ('free', 'Free', 'Free plan: monthly credit allowance, up to 25 pages per audit.', 0),
  ('pro', 'Pro', 'Pro plan ($10/month): larger credit allowance, up to 150 pages per audit, PDF reports and AI explanations.', 1),
  ('business', 'Business', 'Business plan ($15/month): largest allowance, up to 500 pages per audit, prospect list and batch audits.', 2)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order;

-- ── 2. Subscriptions: fields needed for verified provider events ──
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
-- Timestamp of the newest applied provider event: older (out-of-order) events never overwrite newer state.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_ref_idx ON subscriptions (provider, provider_reference) WHERE provider_reference IS NOT NULL;

-- Every verified billing event (provider webhook or audited manual operator action), recorded once.
CREATE TABLE IF NOT EXISTS billing_events (
  id               UUID PRIMARY KEY,
  provider         TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  event_id         TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  event_type       TEXT NOT NULL,
  user_id          UUID REFERENCES profiles (id) ON DELETE SET NULL,
  subscription_id  UUID REFERENCES subscriptions (id) ON DELETE SET NULL,
  occurred_at      TIMESTAMPTZ,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome          TEXT NOT NULL,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, event_id)
);

-- ── 3. Credits ──
CREATE TABLE IF NOT EXISTS credit_accounts (
  principal_id  TEXT PRIMARY KEY REFERENCES principals (id) ON DELETE CASCADE,
  plan_id       TEXT NOT NULL,
  balance       INTEGER NOT NULL CHECK (balance >= 0),
  allowance     INTEGER NOT NULL CHECK (allowance >= 0),
  period_key    TEXT NOT NULL,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, auditable record of every credit movement.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal_id     TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  delta            INTEGER NOT NULL,
  balance_after    INTEGER NOT NULL CHECK (balance_after >= 0),
  entry_type       TEXT NOT NULL CHECK (entry_type IN ('grant','expire','reserve','release','charge','refund','adjust')),
  operation        TEXT NOT NULL CHECK (char_length(operation) <= 60),
  audit_id         TEXT, -- no foreign key: the ledger outlives deleted audits
  period_key       TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL CHECK (char_length(idempotency_key) <= 200),
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS credit_ledger_principal_idx ON credit_ledger (principal_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS credit_ledger_reserve_idx ON credit_ledger (audit_id) WHERE entry_type = 'reserve';

-- ── 4. Prospects (lead-generation workflow; contact fields are entered by the user only) ──
CREATE TABLE IF NOT EXISTS prospects (
  id             UUID PRIMARY KEY,
  principal_id   TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  hostname       TEXT NOT NULL CHECK (char_length(hostname) BETWEEN 1 AND 253),
  website_url    TEXT NOT NULL CHECK (char_length(website_url) <= 2048),
  audit_id       TEXT REFERENCES audits (id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','contacted','converted')),
  notes          TEXT CHECK (notes IS NULL OR char_length(notes) <= 4000),
  contact_name   TEXT CHECK (contact_name IS NULL OR char_length(contact_name) <= 120),
  contact_email  TEXT CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  contact_url    TEXT CHECK (contact_url IS NULL OR char_length(contact_url) <= 2048),
  evidence       JSONB,
  audited_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, hostname)
);
CREATE INDEX IF NOT EXISTS prospects_principal_updated_idx ON prospects (principal_id, updated_at DESC);

-- ── 5. Batch audits (queued, executed within the plan's concurrency limit) ──
CREATE TABLE IF NOT EXISTS audit_batches (
  id            UUID PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  ip_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_batch_items (
  id            UUID PRIMARY KEY,
  batch_id      UUID NOT NULL REFERENCES audit_batches (id) ON DELETE CASCADE,
  principal_id  TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  url           TEXT NOT NULL CHECK (char_length(url) <= 2048),
  max_pages     INTEGER NOT NULL CHECK (max_pages > 0),
  status        TEXT NOT NULL CHECK (status IN ('pending','started','skipped','failed')),
  audit_id      TEXT REFERENCES audits (id) ON DELETE SET NULL,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_batch_items_pending_idx ON audit_batch_items (principal_id, created_at, position) WHERE status = 'pending';

-- ── 6. Read-only report share links (only the SHA-256 of the token is stored) ──
CREATE TABLE IF NOT EXISTS report_shares (
  id              UUID PRIMARY KEY,
  principal_id    TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  audit_id        TEXT NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  label           TEXT CHECK (label IS NULL OR char_length(label) <= 120),
  allow_pdf       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  last_viewed_at  TIMESTAMPTZ,
  view_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS report_shares_audit_idx ON report_shares (audit_id, created_at DESC);

-- ── 7. Server-only access ──
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_shares ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'Supabase roles unavailable: skipping API privilege revokes for 006 tables.';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['billing_events','credit_accounts','credit_ledger','prospects','audit_batches','audit_batch_items','report_shares'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
  -- Identity sequence of credit_ledger.
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
END $$;
INSERT INTO schema_migrations (version) VALUES ('006_plans_credits_prospects') ON CONFLICT (version) DO NOTHING;

-- ════════ 007_professional_reports_and_prospects ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 007: authenticated professional profiles, explicit publication controls,
-- deterministic report snapshots, and manual prospect details.
-- All owner data stays server-only; direct Supabase Data API writes are not granted.

-- Remove the old direct avatar-column write grant. Profile/avatar identity is
-- controlled by the server and the trusted GitHub avatar policy only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE UPDATE ON public.profiles FROM authenticated;
    REVOKE UPDATE (avatar_url) ON public.profiles FROM authenticated;
    GRANT UPDATE (display_name) ON public.profiles TO authenticated;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS professional_profiles (
  user_id                 UUID PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
  profile_type            TEXT NOT NULL DEFAULT 'freelancer' CHECK (profile_type IN ('freelancer','agency')),
  professional_name       TEXT NOT NULL DEFAULT '' CHECK (char_length(professional_name) <= 100),
  business_name           TEXT NOT NULL DEFAULT '' CHECK (char_length(business_name) <= 120),
  job_title               TEXT NOT NULL DEFAULT '' CHECK (char_length(job_title) <= 100),
  headline                TEXT NOT NULL DEFAULT '' CHECK (char_length(headline) <= 180),
  biography               TEXT NOT NULL DEFAULT '' CHECK (char_length(biography) <= 2000),
  website_url             TEXT NOT NULL DEFAULT '' CHECK (char_length(website_url) <= 2048),
  contact_email           TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_email) <= 254),
  contact_phone           TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_phone) <= 50),
  location                TEXT NOT NULL DEFAULT '' CHECK (char_length(location) <= 120),
  public_fields           JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(public_fields) = 'array' AND jsonb_array_length(public_fields) <= 12),
  brand_colors            JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(brand_colors) = 'array' AND jsonb_array_length(brand_colors) <= 10),
  logo_data_url           TEXT CHECK (logo_data_url IS NULL OR (char_length(logo_data_url) <= 1398127 AND logo_data_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$' AND octet_length(decode(split_part(logo_data_url, ',', 2), 'base64')) <= 1048576)),
  onboarding_completed    BOOLEAN NOT NULL DEFAULT false,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS professional_services (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1500),
  categories       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) <= 7),
  keywords         JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(keywords) = 'array' AND jsonb_array_length(keywords) <= 10),
  is_public        BOOLEAN NOT NULL DEFAULT false,
  sort_order       INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 49),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS professional_services_user_order_idx ON professional_services (user_id, sort_order, id);

CREATE TABLE IF NOT EXISTS professional_portfolio_items (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  project_url      TEXT NOT NULL CHECK (char_length(project_url) BETWEEN 1 AND 2048),
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1200),
  service_ids      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(service_ids) = 'array' AND jsonb_array_length(service_ids) <= 20),
  categories       JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(categories) = 'array' AND jsonb_array_length(categories) <= 7),
  is_public        BOOLEAN NOT NULL DEFAULT false,
  sort_order       INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 49),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX IF NOT EXISTS professional_portfolio_user_order_idx ON professional_portfolio_items (user_id, sort_order, id);

-- Each new client link pins an immutable, server-built report and the exact
-- explicitly published professional data used when it was created. Legacy
-- links keep snapshot_id NULL and continue rendering their original live view.
CREATE TABLE IF NOT EXISTS client_report_snapshots (
  id             UUID PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  audit_id       TEXT NOT NULL REFERENCES audits (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL CHECK (version > 0),
  content        JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audit_id, user_id, version)
);
CREATE INDEX IF NOT EXISTS client_report_snapshots_owner_audit_idx ON client_report_snapshots (user_id, audit_id, version DESC);
ALTER TABLE report_shares
  ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES client_report_snapshots (id) ON DELETE CASCADE;

-- Prospect discovery has no configured authorized provider by default. These
-- are details the owner enters or imports; nothing is scraped or inferred.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS business_name TEXT CHECK (business_name IS NULL OR char_length(business_name) <= 160);
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS location TEXT CHECK (location IS NULL OR char_length(location) <= 160);

ALTER TABLE professional_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_portfolio_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_report_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE professional_profiles, professional_services, professional_portfolio_items, client_report_snapshots FROM PUBLIC;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['professional_profiles','professional_services','professional_portfolio_items','client_report_snapshots'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
INSERT INTO schema_migrations (version) VALUES ('007_professional_reports_and_prospects') ON CONFLICT (version) DO NOTHING;

-- ════════ 008_team_collaboration ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 008: transactional team collaboration and the 1 MiB private logo bound.
-- No migration is applied automatically by this source change; deployments
-- must use the repository's approved migration process after review.

-- Keep the 1 MiB raw-file limit consistent with the maximum canonical JPEG
-- data URI (23-byte prefix + 1,398,104 base64 characters). The database
-- decodes the Base64 payload to enforce the exact raw-byte cap; application code
-- also validates canonical Base64, the PNG/JPEG signature and raster dimensions.
ALTER TABLE professional_profiles
  DROP CONSTRAINT IF EXISTS professional_profiles_logo_data_url_check;
ALTER TABLE professional_profiles
  ADD CONSTRAINT professional_profiles_logo_data_url_check
  CHECK (logo_data_url IS NULL OR (char_length(logo_data_url) <= 1398127 AND logo_data_url ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$' AND octet_length(decode(split_part(logo_data_url, ',', 2), 'base64')) <= 1048576));

-- A personal prospect can be explicitly shared with one organization and
-- assigned to one current member. Principal ownership (and its plan limits)
-- remains unchanged; leaving a team detaches the member's own shared rows.
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations (id) ON DELETE SET NULL;
ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS assigned_to_user_id UUID REFERENCES profiles (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS prospects_organization_updated_idx ON prospects (organization_id, updated_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospects_assignee_updated_idx ON prospects (assigned_to_user_id, updated_at DESC) WHERE assigned_to_user_id IS NOT NULL;
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_assignee_requires_organization;
ALTER TABLE prospects ADD CONSTRAINT prospects_assignee_requires_organization
  CHECK (assigned_to_user_id IS NULL OR organization_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id                   UUID PRIMARY KEY,
  organization_id      UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  invited_email        TEXT NOT NULL CHECK (char_length(invited_email) BETWEEN 3 AND 254 AND invited_email = lower(btrim(invited_email))),
  role                 TEXT NOT NULL CHECK (role IN ('admin','member')),
  token_hash           TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by_user_id   UUID REFERENCES profiles (id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','revoked','expired')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_by_user_id  UUID REFERENCES profiles (id) ON DELETE SET NULL,
  accepted_at          TIMESTAMPTZ,
  responded_at         TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_pending_email_idx
  ON organization_invitations (organization_id, lower(invited_email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS organization_invitations_org_status_idx
  ON organization_invitations (organization_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS organization_activity (
  id                BIGSERIAL PRIMARY KEY,
  organization_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  actor_user_id     UUID REFERENCES profiles (id) ON DELETE SET NULL,
  event_type        TEXT NOT NULL CHECK (event_type IN (
    'organization_created','organization_renamed',
    'member_added','member_removed','member_left','member_role_changed','ownership_transferred',
    'invitation_sent','invitation_accepted','invitation_rejected','invitation_revoked',
    'prospect_shared','prospect_unshared','prospect_assigned','prospect_updated'
  )),
  subject_user_id   UUID REFERENCES profiles (id) ON DELETE SET NULL,
  prospect_id       UUID REFERENCES prospects (id) ON DELETE SET NULL,
  details           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_activity_recent_idx
  ON organization_activity (organization_id, created_at DESC, id DESC);

-- Collaboration data is accessed only by the app's server-side repository,
-- which verifies the caller's organization membership/role on every request.
-- The Supabase Data API receives no direct table access.
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_invitations, organization_activity FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE organization_invitations, organization_activity FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE organization_invitations, organization_activity FROM authenticated;
  END IF;
END $$;
INSERT INTO schema_migrations (version) VALUES ('008_team_collaboration') ON CONFLICT (version) DO NOTHING;

-- ════════ 009_invitation_email_delivery ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 009: invitation email outcome tracking and recipient-side invitation lookup.
-- No migration is applied automatically by this source change; deployments
-- must use the repository's approved migration process after review.

ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS email_delivery_status TEXT NOT NULL DEFAULT 'not_attempted'
    CHECK (email_delivery_status IN ('not_attempted','accepted','failed','unknown','not_configured'));
ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS email_last_attempt_at TIMESTAMPTZ;
ALTER TABLE organization_invitations
  ADD COLUMN IF NOT EXISTS email_error_code TEXT
    CHECK (email_error_code IS NULL OR email_error_code ~ '^[a-z0-9_]{1,64}$');

-- Recipient inbox queries are restricted to the current server-confirmed
-- address and only active, unexpired invitations.
CREATE INDEX IF NOT EXISTS organization_invitations_pending_recipient_idx
  ON organization_invitations (lower(invited_email), expires_at DESC)
  WHERE status = 'pending';

-- Re-sends are audited distinctly from first-time invitations.
ALTER TABLE organization_activity
  DROP CONSTRAINT IF EXISTS organization_activity_event_type_check;
ALTER TABLE organization_activity
  ADD CONSTRAINT organization_activity_event_type_check CHECK (event_type IN (
    'organization_created','organization_renamed',
    'member_added','member_removed','member_left','member_role_changed','ownership_transferred',
    'invitation_sent','invitation_resent','invitation_accepted','invitation_rejected','invitation_revoked',
    'prospect_shared','prospect_unshared','prospect_assigned','prospect_updated'
  ));
INSERT INTO schema_migrations (version) VALUES ('009_invitation_email_delivery') ON CONFLICT (version) DO NOTHING;

-- ════════ 010_revoke_late_sequence_grants ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 010: re-apply API-role sequence hardening after team collaboration created
-- organization_activity_id_seq in migration 008, after migration 005's sweep.
-- Supabase-style default privileges can grant new public sequences to API roles.
-- Keep every public table sequence server-only for anon/authenticated, including
-- sequences introduced by migrations that ran after 005.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS seq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', r.seq);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon', r.seq);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM authenticated', r.seq);
    END IF;
  END LOOP;
END $$;
INSERT INTO schema_migrations (version) VALUES ('010_revoke_late_sequence_grants') ON CONFLICT (version) DO NOTHING;

-- ════════ 011_analytics ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 011: First-party website analytics events for the private owner dashboard.
--
-- DESIGN NOTES (docs/ANALYTICS.md documents counting + privacy decisions):
--   * One append-mostly table of privacy-conscious events. Raw IP addresses and
--     visitor/session ids are never stored — the app stores salted HMAC hashes,
--     same convention as the existing ip_hash columns.
--   * client_event_id carries a UNIQUE constraint so at-least-once client
--     delivery (sendBeacon retries, flaky networks) can never duplicate a
--     logical event.
--   * Indexes support the dashboard's bounded range scans and group-bys.
--   * Row Level Security is enabled and no access is granted to API roles:
--     analytics rows are reachable ONLY through the app's server-side
--     repository, which itself enforces the single-email owner allowlist.

CREATE TABLE IF NOT EXISTS analytics_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id  TEXT NOT NULL UNIQUE CHECK (client_event_id ~ '^[0-9a-f-]{36}$'),
  visitor_hash     TEXT NOT NULL CHECK (char_length(visitor_hash) BETWEEN 16 AND 64),
  session_hash     TEXT NOT NULL CHECK (char_length(session_hash) BETWEEN 16 AND 64),
  event_type       TEXT NOT NULL CHECK (event_type IN ('pageview','session_start')),
  path             TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 200 AND path ~ '^/'),
  referrer_host    TEXT CHECK (referrer_host IS NULL OR referrer_host = lower(referrer_host)),
  source           TEXT NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','search','social','referral','campaign','other')),
  device           TEXT NOT NULL DEFAULT 'unknown' CHECK (device IN ('desktop','mobile','tablet','unknown')),
  browser          TEXT NOT NULL DEFAULT 'unknown',
  os               TEXT NOT NULL DEFAULT 'unknown',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bounded range scans + the dashboard's group-bys.
CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_source_created_idx ON analytics_events (source, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_device_created_idx ON analytics_events (device, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_path_created_idx ON analytics_events (path, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_session_created_idx ON analytics_events (session_hash, created_at);
CREATE INDEX IF NOT EXISTS analytics_events_visitor_created_idx ON analytics_events (visitor_hash, created_at);

-- No direct access through the Supabase Data API; the app server holds the only key.
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE analytics_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE analytics_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE analytics_events FROM authenticated;
  END IF;
END $$;

-- Retention (documentary): events older than 400 days are eligible for the
-- documented cleanup in docs/ANALYTICS.md. No cron is created here because the
-- schema layer has no scheduling context; operators run the documented DELETE.
INSERT INTO schema_migrations (version) VALUES ('011_analytics') ON CONFLICT (version) DO NOTHING;

-- ════════ 012_feedback ════════
DO $guard$ BEGIN PERFORM pg_advisory_xact_lock(hashtext('sitelens_migrations')); END $guard$;
-- 012: Account-based user feedback with one-time third-audit invitation state
-- and safe email-delivery bookkeeping.
--
-- DESIGN NOTES
--   * feedback_submissions is append-mostly: a row is created BEFORE the email
--     send is attempted, so a temporary provider failure never silently loses
--     the feedback. delivery_status records the provider's verdict only —
--     'accepted' means the provider accepted the message; nothing else is
--     ever reported to the user as success.
--   * (user_id, idempotency_key) is UNIQUE so a retried submit (double-click,
--     flaky network) records — and later sends — the logical feedback at most
--     once. Retries reuse the same row; deliveries with an uncertain outcome
--     are never re-sent (see services/feedback.ts).
--   * feedback_prompts holds the one-time "leave us feedback" invitation
--     offered after the account's third completed audit. One row per user:
--     first creation is an INSERT ... ON CONFLICT DO NOTHING, so concurrent
--     audit completions cannot invite twice.
--   * Row Level Security is enabled and no access is granted to API roles:
--     rows are reachable only through the app's server-side repository, which
--     scopes every query to the request's verified user id.

CREATE TABLE IF NOT EXISTS feedback_submissions (
  id                   TEXT PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  principal_id         TEXT NOT NULL,
  account_email        TEXT,
  category             TEXT NOT NULL CHECK (category IN ('general','bug','feature','other')),
  rating               SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  message              TEXT NOT NULL CHECK (char_length(message) BETWEEN 20 AND 4000),
  goal                 TEXT CHECK (goal IS NULL OR char_length(goal) BETWEEN 1 AND 1000),
  page_url             TEXT CHECK (page_url IS NULL OR (char_length(page_url) <= 300 AND page_url ~ '^/')),
  delivery_status      TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','accepted','failed')),
  delivery_error_code  TEXT CHECK (delivery_error_code IS NULL OR delivery_error_code ~ '^[a-z0-9_]{1,64}$'),
  provider_message_id  TEXT CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200),
  outcome_uncertain    BOOLEAN NOT NULL DEFAULT false,
  idempotency_key      TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f-]{36}$'),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS feedback_submissions_user_created_idx ON feedback_submissions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_submissions_delivery_idx ON feedback_submissions (delivery_status) WHERE delivery_status <> 'accepted';

CREATE TABLE IF NOT EXISTS feedback_prompts (
  user_id           UUID PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
  state             TEXT NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','remind_later','dismissed')),
  first_offered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  remind_after      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No direct access through the Supabase Data API; the app server holds the only key.
ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_prompts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE feedback_submissions, feedback_prompts FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE feedback_submissions, feedback_prompts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE feedback_submissions, feedback_prompts FROM authenticated;
  END IF;
END $$;
INSERT INTO schema_migrations (version) VALUES ('012_feedback') ON CONFLICT (version) DO NOTHING;

COMMIT;
