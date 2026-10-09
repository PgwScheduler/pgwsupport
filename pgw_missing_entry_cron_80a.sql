-- =====================================================================
-- PGW Support Portal — schedule the missing-entry email (80a)
-- Run AFTER migration 80, AFTER the Edge Function missing-entry-alerts
-- is deployed, and AFTER its secrets are set. Supabase SQL Editor.
-- Safe to re-run.
-- =====================================================================
-- Calls the Edge Function every hour from 9:00 to 16:00 UTC, Monday to
-- Saturday. The FUNCTION decides whether this is the hour to send
-- (missing_entry_config.send_hour_et, default 8 Eastern), so daylight
-- saving needs no second schedule, and nothing goes out at all while
-- missing_entry_config.email_enabled is off.
--
-- BEFORE RUNNING: replace PASTE-THE-SAME-SECRET-HERE below with the exact
-- value you saved as the Edge Function secret MISSING_ENTRY_CRON_SECRET.
-- It is stored in Vault, never in this file or the cron job's text.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. The shared secret, in Vault (update it if it already exists).
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'missing_entry_cron_secret';
  if v_id is null then
    perform vault.create_secret('PASTE-THE-SAME-SECRET-HERE', 'missing_entry_cron_secret',
      'x-cron-secret for the missing-entry-alerts Edge Function (migration 80a)');
  else
    perform vault.update_secret(v_id, 'PASTE-THE-SAME-SECRET-HERE');
  end if;
end $$;

-- 2. The job. cron.schedule with an existing name replaces it.
select cron.schedule(
  'missing-entry-alerts',
  '0 9-16 * * 1-6',
  $job$
  select net.http_post(
    url     := 'https://ledmjsfjhvlwjyxjhlyi.supabase.co/functions/v1/missing-entry-alerts',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'missing_entry_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);


-- ---------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------
-- select jobname, schedule, active from cron.job where jobname = 'missing-entry-alerts';
-- After the next whole hour (9-16 UTC, Mon-Sat):
-- select status_code, content from net._http_response order by created desc limit 3;
--   -> 200 {"skipped":"email_enabled is off"}   until you switch it on
--
-- SWITCH ON (when stores are entering daily):
-- update public.missing_entry_config set email_enabled = true, updated_at = now() where id;
--
-- STOP the schedule entirely:
-- select cron.unschedule('missing-entry-alerts');
