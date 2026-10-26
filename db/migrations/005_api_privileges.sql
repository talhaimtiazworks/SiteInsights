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
