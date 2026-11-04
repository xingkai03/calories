-- Reliable hourly Garmin sync trigger for the existing Calories project.
-- Run after garmin.sql as postgres.
--
-- GitHub's own `schedule:` trigger is best effort: under load it starts runs
-- late or drops them, so an hourly cron can end up running every few hours.
-- This script makes Supabase start the private sync workflow every hour through
-- GitHub's workflow_dispatch API instead. The workflow's own schedule stays as
-- a backup; its concurrency group and the server lease keep runs from
-- overlapping.
--
-- Before running, create a fine-grained GitHub token limited to the private
-- xingkai03/calories-garmin-sync repository with "Actions: Read and write"
-- permission, then store it once in Vault (never commit it):
--
--   select vault.create_secret('<token>', 'calories_garmin_dispatch_token',
--     'Starts the private Garmin sync workflow');
--
-- To replace an expired token later:
--
--   select vault.update_secret(id, '<new token>')
--   from vault.secrets where name = 'calories_garmin_dispatch_token';

create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists private;

create or replace function private.dispatch_garmin_sync()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
begin
  select decrypted_secret into token
  from vault.decrypted_secrets
  where name = 'calories_garmin_dispatch_token';

  if token is null or token = '' then
    raise warning 'calories_garmin_dispatch_token is not set in Vault; Garmin sync not started.';
    return null;
  end if;

  return net.http_post(
    url := 'https://api.github.com/repos/xingkai03/calories-garmin-sync/actions/workflows/sync.yml/dispatches',
    headers := jsonb_build_object(
      'Accept', 'application/vnd.github+json',
      'Authorization', 'Bearer ' || token,
      'User-Agent', 'calories-garmin-cron',
      'X-GitHub-Api-Version', '2022-11-28'
    ),
    body := '{"ref":"main"}'::jsonb,
    timeout_milliseconds := 10000
  );
end;
$$;

revoke all on function private.dispatch_garmin_sync() from public, anon, authenticated, service_role;

-- Minute 5 of every hour. cron.schedule replaces an existing job of the same name.
select cron.schedule(
  'calories-garmin-sync',
  '5 * * * *',
  'select private.dispatch_garmin_sync()'
);

-- Check it worked a few minutes after the hour. GitHub answers 204 on success:
--   select status_code, content, created
--   from net._http_response order by created desc limit 5;
--   select status, return_message, start_time
--   from cron.job_run_details order by start_time desc limit 5;
