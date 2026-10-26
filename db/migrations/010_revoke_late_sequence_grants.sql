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
