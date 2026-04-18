-- Daily cron — invokes the export-to-sheets Edge Function at 03:00 Asia/Jerusalem (00:00 UTC).
-- Requires the pg_cron and pg_net extensions (enable in Supabase dashboard ▸ Database ▸ Extensions).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace these with real values:
--   SUPABASE_URL          → your project URL (e.g. https://abcd.supabase.co)
--   SERVICE_ROLE_KEY      → from Project settings ▸ API. Keep secret.
-- The cleanest pattern is to store them in Vault and read them here. For brevity
-- this snippet uses literal values via current_setting that you set once:
--
--   alter database postgres set "app.supabase_url" = 'https://YOUR.supabase.co';
--   alter database postgres set "app.service_role_key" = 'eyJ...';
--
-- After setting, run this block:

select cron.schedule(
  'export-signings-daily',
  '0 0 * * *',  -- 00:00 UTC = 03:00 Asia/Jerusalem
  $$
    select net.http_post(
      url := current_setting('app.supabase_url') || '/functions/v1/export-to-sheets',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      body := jsonb_build_object('trigger', 'cron')
    );
  $$
);

-- To remove later:
--   select cron.unschedule('export-signings-daily');
