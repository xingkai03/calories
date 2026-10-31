-- Run in your Supabase project's SQL Editor as the postgres role.
-- Configured for the confirmed email/password account supplied by the owner.
-- Run this entire script in the calories project (wjobefnfswnftvthybiv).
-- Keep the private schema out of the API's Exposed schemas setting.
-- This script is repeatable and preserves existing data and members.
--
-- Several people can share one project. Each approved account (a "member")
-- gets its own private journal row; nobody can read or change another
-- member's journal. The owner below is always a member. To approve someone
-- else, create their account in Authentication > Users, then run:
--   insert into private.calories_members (user_id)
--     select id from auth.users where email = 'friend@example.com'
--     on conflict do nothing;
-- To remove access (their journal is kept until you delete it):
--   delete from private.calories_members
--     where user_id = (select id from auth.users where email = 'friend@example.com');

begin;

do $$
declare
  owner_uuid uuid := '8c0b4ad9-f74f-4951-bb9d-a4a3d4d1f686'::uuid;
begin
  if not exists (select 1 from auth.users where id = owner_uuid) then
    raise exception 'Create the owner in Authentication > Users before running this script.';
  end if;
  perform set_config('calories.setup_owner', owner_uuid::text, true);
end;
$$;

create schema if not exists private;
grant usage on schema private to authenticated;

-- Approved accounts. The browser has no access to this table; only the
-- security-definer check below reads it, and only for the caller's own ID.
create table if not exists private.calories_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
revoke all on table private.calories_members from public, anon, authenticated;
alter table private.calories_members enable row level security;
insert into private.calories_members (user_id)
  values (current_setting('calories.setup_owner')::uuid)
  on conflict (user_id) do nothing;

create or replace function private.calories_is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and exists (select 1 from private.calories_members as member where member.user_id = auth.uid());
$$;

revoke all on function private.calories_is_member() from public, anon, authenticated;
grant execute on function private.calories_is_member() to authenticated;

-- This function returns only a boolean for the caller's own session. It does
-- not expose Auth records, accept another user's ID, or allow session writes.
-- The session's original creation time sets an absolute 30-day maximum.
create or replace function private.calories_session_active()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  session_uuid uuid;
begin
  begin
    session_uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if session_uuid is null or auth.uid() is null then
    return false;
  end if;
  return exists (
    select 1
    from auth.sessions as session
    where session.id = session_uuid
      and session.user_id = auth.uid()
      and session.created_at > now() - interval '30 days'
      and (session.not_after is null or session.not_after > now())
  );
end;
$$;

revoke all on function private.calories_session_active() from public, anon, authenticated;
grant execute on function private.calories_session_active() to authenticated;

-- A small non-privileged RPC lets the app distinguish a genuinely new account
-- from an empty result caused by denied RLS access. It reveals only a boolean.
create or replace function public.calories_access_allowed()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select private.calories_is_member())
    and (select private.calories_session_active()),
    false
  );
$$;
revoke all on function public.calories_access_allowed() from public, anon, authenticated;
grant execute on function public.calories_access_allowed() to authenticated;

create table if not exists public.calories_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb
    constraint calories_state_data_object check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 1
    constraint calories_state_positive_revision check (revision > 0),
  updated_at timestamptz not null default now()
);

-- Earlier versions pinned the table to a single owner. Membership and the
-- per-user RLS gate below replace that pin. All changes roll back on failure.
alter table public.calories_state drop constraint if exists calories_state_single_owner;

-- The browser writes only data. The database owns revisions and timestamps,
-- making a conditional PATCH using revision safe against stale device writes.
create or replace function private.calories_state_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  else
    if new.user_id <> old.user_id then
      raise exception 'The calories owner cannot be changed.';
    end if;
    new.revision := old.revision + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.calories_state_version() from public, anon, authenticated;
drop trigger if exists calories_state_version on public.calories_state;
create trigger calories_state_version
  before insert or update on public.calories_state
  for each row execute function private.calories_state_version();

alter table public.calories_state enable row level security;

-- Remove default privileges, including any previous column-level grants.
revoke all on table public.calories_state from public, anon, authenticated;
revoke all (user_id, data, revision, updated_at) on public.calories_state from public, anon, authenticated;
grant select on public.calories_state to authenticated;
grant insert (user_id, data) on public.calories_state to authenticated;
grant update (data) on public.calories_state to authenticated;

-- The restrictive gate still applies if a permissive policy is added later.
-- Each member reaches only the row whose user_id is their own account.
drop policy if exists calories_owner_gate on public.calories_state;
drop policy if exists calories_member_gate on public.calories_state;
create policy calories_member_gate on public.calories_state
  as restrictive for all to authenticated
  using ((select auth.uid()) = user_id and (select private.calories_is_member()) and (select private.calories_session_active()))
  with check ((select auth.uid()) = user_id and (select private.calories_is_member()) and (select private.calories_session_active()));

drop policy if exists calories_owner_select on public.calories_state;
create policy calories_owner_select on public.calories_state
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists calories_owner_insert on public.calories_state;
create policy calories_owner_insert on public.calories_state
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists calories_owner_update on public.calories_state;
create policy calories_owner_update on public.calories_state
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

comment on table public.calories_state is
  'Calorie tracker state, one private row per approved member. Each member reaches only their own row; no anonymous access or browser DELETE. Revision is advanced by the database.';

notify pgrst, 'reload schema';
commit;
