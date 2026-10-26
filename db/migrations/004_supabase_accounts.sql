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
