-- OPTIONAL: run the SiteInsight background sweep every minute from Supabase.
--
-- Audits normally run to completion in the background without this (the
-- request that starts an audit keeps working after responding and hands off
-- to /api/internal/process). Vercel Hobby only allows a DAILY cron, so this
-- script adds a per-minute safety net that resumes any audit whose worker was
-- interrupted (deploys, timeouts, crashes).
--
-- Prerequisites (Supabase dashboard → Database → Extensions): pg_cron, pg_net.
-- Replace the two placeholders below, then run this in the SQL editor.
-- The secret is stored in Supabase Vault, not in the job definition.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Same value as the CRON_SECRET environment variable on Vercel.
select vault.create_secret('REPLACE_WITH_YOUR_CRON_SECRET', 'sitelens_cron_secret')
where not exists (select 1 from vault.secrets where name = 'sitelens_cron_secret');

select cron.unschedule('sitelens-process')
where exists (select 1 from cron.job where jobname = 'sitelens-process');

select cron.schedule(
  'sitelens-process',
  '* * * * *',
  $job$
  select net.http_get(
    url := 'https://REPLACE_WITH_YOUR_DOMAIN/api/internal/process',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sitelens_cron_secret' limit 1)
    ),
    timeout_milliseconds := 5000
  );
  $job$
);

-- To remove:  select cron.unschedule('sitelens-process');
-- If Vercel Deployment Protection is on, add an 'x-vercel-protection-bypass'
-- header with your VERCEL_AUTOMATION_BYPASS_SECRET.
