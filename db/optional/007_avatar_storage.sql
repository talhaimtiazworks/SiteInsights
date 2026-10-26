-- SiteInsights 007: private avatar Storage and user-owned object policies.
-- Existing avatar_url HTTPS values remain valid. Uploaded image references are stored as
-- storage://avatars/<auth-user-id>/avatar-<uuid>.<extension> in profiles.avatar_url.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_avatar_url_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_avatar_url_check CHECK (
    avatar_url IS NULL
    OR avatar_url ~ '^https://'
    OR avatar_url ~* '^storage://avatars/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
  );

DO $avatar_storage$
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'Supabase Storage is not present; avatar bucket/policies were not created.';
    RETURN;
  END IF;
  IF to_regprocedure('auth.uid()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE NOTICE 'Supabase auth roles/function are not present; avatar bucket/policies were not created.';
    RETURN;
  END IF;

  BEGIN
    -- New buckets are private. If an avatars bucket already exists, reuse it and preserve
    -- its existing public/private setting; this migration never makes a private bucket public.
    EXECUTE $bucket$
      INSERT INTO storage.buckets AS current_bucket
        (id, name, public, file_size_limit, allowed_mime_types)
      VALUES
        ('avatars', 'avatars', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp']::text[])
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types
    $bucket$;

    EXECUTE 'ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS sitelens_avatars_directory_guard ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS sitelens_avatars_select_own ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS sitelens_avatars_insert_own ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS sitelens_avatars_update_own ON storage.objects';
    EXECUTE 'DROP POLICY IF EXISTS sitelens_avatars_delete_own ON storage.objects';

    -- A restrictive guard composes with any existing permissive policies: even a broader
    -- policy cannot let anon/authenticated users access another user's avatar directory.
    EXECUTE $policy$
      CREATE POLICY sitelens_avatars_directory_guard ON storage.objects
        AS RESTRICTIVE FOR ALL TO anon, authenticated
        USING (
          bucket_id <> 'avatars'
          OR (
            auth.uid() IS NOT NULL
            AND (storage.foldername(name))[1] = auth.uid()::text
            AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
          )
        )
        WITH CHECK (
          bucket_id <> 'avatars'
          OR (
            auth.uid() IS NOT NULL
            AND (storage.foldername(name))[1] = auth.uid()::text
            AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
          )
        )
    $policy$;

    -- SELECT is needed for authenticated signed URLs and server-side verification.
    EXECUTE $policy$
      CREATE POLICY sitelens_avatars_select_own ON storage.objects
        FOR SELECT TO authenticated
        USING (
          bucket_id = 'avatars'
          AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
          AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
        )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY sitelens_avatars_insert_own ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (
          bucket_id = 'avatars'
          AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
          AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
        )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY sitelens_avatars_update_own ON storage.objects
        FOR UPDATE TO authenticated
        USING (
          bucket_id = 'avatars'
          AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
          AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
        )
        WITH CHECK (
          bucket_id = 'avatars'
          AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
          AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
        )
    $policy$;
    EXECUTE $policy$
      CREATE POLICY sitelens_avatars_delete_own ON storage.objects
        FOR DELETE TO authenticated
        USING (
          bucket_id = 'avatars'
          AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
          AND name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
        )
    $policy$;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Insufficient privilege to configure Supabase Storage. Apply db/optional/007_avatar_storage.sql in the Supabase SQL Editor with an owner role.';
  END;
END
$avatar_storage$;
