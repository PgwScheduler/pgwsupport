-- =====================================================================
-- PGW Support Portal — Horizon shop passwords, held in Vault and
--                      released once, only against an authorized upload
-- Run AFTER pgw_horizon_sandbox_upload_40.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Horizon's importer wants the shop's password IN the request body
-- (data[PASSWORD]). Today it sits in plain text in every store workbook.
-- This migration gives the portal somewhere safer to keep it, and a
-- single narrow way to get it back out.
--
-- WHERE THE PASSWORD LIVES
--   Supabase Vault, one secret per shop, named
--       horizon_password:<shop number>        e.g. horizon_password:b306006
--   Vault encrypts at rest; the decrypted view is not exposed through
--   the API. NO PASSWORD IS IN THIS FILE, and none should ever be typed
--   into a migration. Add it through the Dashboard's Vault screen (see
--   the bottom of this file), which keeps it out of SQL Editor history.
--
-- WHO CAN READ IT BACK: NOBODY SIGNED IN. Not a store user, not an
-- admin, not master. The only reader is horizon_release_credentials(),
-- executable by service_role alone -- i.e. by the upload Edge Function,
-- server-side. The password never reaches a browser.
--
-- WHEN IT IS RELEASED: ONLY AGAINST A FRESH, AUTHORIZED, UNUSED UPLOAD
-- ATTEMPT. The upload goes in two steps:
--   1. The signed-in admin's session calls horizon_upload_target(). It
--      checks role, the sandbox-only switch (40), shop number, pairing
--      and Front Staff, logs the attempt, and NOW RETURNS ITS attempt_id.
--   2. The Edge Function, as service_role, calls
--      horizon_release_credentials(attempt_id). That attempt must be
--      'authorized', under 2 minutes old, and never used before. The
--      live state is then checked AGAIN (switch, shop, sandbox flag),
--      because any of it may have changed in those two minutes. The
--      attempt is then marked used, so one authorization releases the
--      password exactly once.
--   So the password cannot be obtained without an audited, authorized
--   attempt by a named admin, and service_role cannot be talked into
--   releasing a real store's password while uploads are sandbox-only.
--
-- WHY horizon_upload_target() IS DROPPED AND RECREATED
--   Its return type gains attempt_id, and Postgres cannot change a
--   function's return type in place. Nothing calls it yet (the portal
--   has no upload screen), so nothing breaks. The body is migration
--   40's, unchanged apart from capturing and returning the log id.
--
-- ALSO HERE
--   * horizon_credential_status(): admin/master can see WHICH shops have
--     a password loaded and when, never the password.
--   * horizon_upload_log gains credential_released_at.
--
-- PREREQUISITE: the Vault extension (supabase_vault). It is on by
-- default in Supabase projects; if it is not, this file stops at the
-- first statement and says how to enable it.
--
-- NOT HERE: the Edge Function itself, and the macro's HTTP basic-auth
-- pair (the workbook sends a placeholder username; confirm with Horizon
-- whether it matters before storing anything for it).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. VAULT MUST BE AVAILABLE
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('vault.decrypted_secrets') is null
     or to_regclass('vault.secrets') is null then
    raise exception 'Supabase Vault is not enabled. Dashboard -> Database -> Extensions -> enable "supabase_vault", then run this file again. Nothing was changed.';
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 1. ONE RELEASE PER ATTEMPT
-- ---------------------------------------------------------------------
alter table public.horizon_upload_log
  add column if not exists credential_released_at timestamptz;

comment on column public.horizon_upload_log.credential_released_at is
  'Set when horizon_release_credentials() hands this attempt''s shop password to the upload Edge Function. An attempt releases at most once.';


-- ---------------------------------------------------------------------
-- 2. horizon_upload_target() -- migration 40's body, plus attempt_id
-- ---------------------------------------------------------------------
drop function if exists public.horizon_upload_target(uuid, text);

create function public.horizon_upload_target(
  p_location_id   uuid,
  p_intended_shop text default null
)
returns table (shop_number text, authorized boolean, front_staff_slot smallint,
               reason text, attempt_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_shop     text;
  v_sandbox  boolean;
  v_conflict text;
  v_reason   text;
  v_fs_slot  smallint;
  v_fs_count int;
  v_only     boolean;
  v_why      text;
  v_attempt  bigint;
begin
  -- Authorization first (39c): a non-admin learns nothing about state.
  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can upload to Horizon' using errcode = '42501';
  end if;

  select l.horizon_shop_number, l.is_sandbox
    into v_shop, v_sandbox
    from public.locations l
   where l.id = p_location_id;

  if not found then
    raise exception 'location % not found', p_location_id using errcode = '42704';
  end if;

  select c.upload_sandbox_only, c.upload_lock_reason
    into v_only, v_why
    from public.horizon_config c
   where c.id;

  select count(*), min(s.slot_number)
    into v_fs_count, v_fs_slot
    from public.location_horizon_slots s
   where s.location_id = p_location_id
     and s.is_reserved = true
     and s.reservation_kind = 'front_staff';

  -- (0) sandbox-only (40). Missing config row = on.
  if coalesce(v_only, true) and not v_sandbox then
    v_reason := format('Portal uploads are limited to the sandbox. %s  Lift with: update public.horizon_config set upload_sandbox_only = false, updated_at = now() where id;',
                       coalesce(v_why, ''));

  -- (3) refuse null
  elsif v_shop is null then
    v_reason := 'Location has no Horizon shop number, so it cannot upload. Load its credentials first.';

  -- (1) the caller may assert, never override
  elsif p_intended_shop is not null and p_intended_shop <> v_shop then
    v_reason := format('Horizon shop number mismatch: caller asserted %L but the location resolves to %L.',
                       p_intended_shop, v_shop);

  else
    -- (2) assert the pairing
    select string_agg(l2.id::text, ', ') into v_conflict
      from public.locations l2
     where l2.horizon_shop_number = v_shop
       and l2.is_sandbox is distinct from v_sandbox;
    if v_conflict is not null then
      v_reason := format('Horizon sandbox pairing violated: shop %L is also claimed by location(s) %s with a different sandbox flag.',
                         v_shop, v_conflict);

    -- (4) a Front Staff slot must exist to receive uncosted
    --     front-of-house labor sales.
    elsif v_fs_count <> 1 then
      v_reason := format('Location has %s Front Staff reservations, expected exactly 1. Front-of-house labor sales have nowhere to go; reserve a Front Staff slot before uploading.',
                         v_fs_count);
    end if;
  end if;

  insert into public.horizon_upload_log
    (location_id, shop_number, is_sandbox, outcome, detail, attempted_by)
  values
    (p_location_id, v_shop, v_sandbox,
     case when v_reason is null then 'authorized' else 'refused' end,
     v_reason, auth.uid())
  returning id into v_attempt;

  -- On refusal nothing usable comes back -- neither the shop to
  -- transmit to nor the slot to write into. attempt_id is returned
  -- either way (it is only an audit reference), but a refused attempt
  -- can never release a password.
  shop_number      := case when v_reason is null then v_shop else null end;
  authorized       := v_reason is null;
  front_staff_slot := case when v_reason is null then v_fs_slot else null end;
  reason           := v_reason;
  attempt_id       := v_attempt;
  return next;
end
$fn$;

-- Supabase grants EXECUTE on new public functions to anon and
-- authenticated directly, so `from public` alone is a no-op (see 34).
revoke all on function public.horizon_upload_target(uuid, text) from public, anon;
grant execute on function public.horizon_upload_target(uuid, text) to authenticated;


-- ---------------------------------------------------------------------
-- 3. horizon_release_credentials() -- service_role ONLY
--
--    Raises rather than returning a verdict: the caller is the Edge
--    Function, not a person, and the attempt it names is already in
--    the log, so a refusal here loses no evidence.
-- ---------------------------------------------------------------------
create or replace function public.horizon_release_credentials(
  p_attempt_id bigint
)
returns table (shop_number text, password text, front_staff_slot smallint,
               location_id uuid, is_sandbox boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_log      public.horizon_upload_log%rowtype;
  v_shop     text;
  v_sandbox  boolean;
  v_only     boolean;
  v_fs_slot  smallint;
  v_fs_count int;
  v_pw       text;
begin
  -- Lock the row so two concurrent calls cannot both release it.
  select * into v_log
    from public.horizon_upload_log
   where id = p_attempt_id
   for update;

  if not found then
    raise exception 'Upload attempt % does not exist.', p_attempt_id using errcode = '42704';
  end if;
  if v_log.outcome <> 'authorized' then
    raise exception 'Upload attempt % was refused; no credentials are released for it.', p_attempt_id
      using errcode = '42501';
  end if;
  if v_log.credential_released_at is not null then
    raise exception 'Upload attempt % already released its credentials at %. Start a new upload.',
      p_attempt_id, v_log.credential_released_at using errcode = '42501';
  end if;
  if v_log.attempted_at < now() - interval '2 minutes' then
    raise exception 'Upload attempt % is older than 2 minutes. Start a new upload.', p_attempt_id
      using errcode = '42501';
  end if;

  -- Re-check live state: any of it may have changed since the attempt.
  select l.horizon_shop_number, l.is_sandbox into v_shop, v_sandbox
    from public.locations l where l.id = v_log.location_id;

  if v_shop is null or v_shop is distinct from v_log.shop_number
     or v_sandbox is distinct from v_log.is_sandbox then
    raise exception 'The location''s Horizon shop or sandbox flag changed since attempt %. Start a new upload.', p_attempt_id
      using errcode = '42501';
  end if;

  select c.upload_sandbox_only into v_only
    from public.horizon_config c where c.id;
  if coalesce(v_only, true) and not v_sandbox then
    raise exception 'Portal uploads are limited to the sandbox; no password is released for a real store.'
      using errcode = '42501';
  end if;

  select count(*), min(s.slot_number) into v_fs_count, v_fs_slot
    from public.location_horizon_slots s
   where s.location_id = v_log.location_id
     and s.is_reserved and s.reservation_kind = 'front_staff';
  if v_fs_count <> 1 then
    raise exception 'Location now has % Front Staff reservations, expected exactly 1.', v_fs_count
      using errcode = '42501';
  end if;

  select d.decrypted_secret into v_pw
    from vault.decrypted_secrets d
   where d.name = 'horizon_password:' || v_shop;

  if v_pw is null or v_pw = '' then
    raise exception 'No Horizon password is stored for shop %. Add a Vault secret named horizon_password:%.', v_shop, v_shop
      using errcode = 'P0002';
  end if;

  update public.horizon_upload_log
     set credential_released_at = now()
   where id = p_attempt_id;

  shop_number      := v_shop;
  password         := v_pw;
  front_staff_slot := v_fs_slot;
  location_id      := v_log.location_id;
  is_sandbox       := v_sandbox;
  return next;
end
$fn$;

revoke all on function public.horizon_release_credentials(bigint) from public, anon, authenticated;
grant execute on function public.horizon_release_credentials(bigint) to service_role;


-- ---------------------------------------------------------------------
-- 4. horizon_credential_status() -- which shops have a password,
--    never the password. Reads vault.secrets (the ENCRYPTED table),
--    not the decrypted view.
-- ---------------------------------------------------------------------
create or replace function public.horizon_credential_status()
returns table (location_id uuid, location_name text, store_number text,
               shop_number text, is_sandbox boolean,
               has_password boolean, password_updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can view Horizon credential status' using errcode = '42501';
  end if;

  return query
  select l.id, l.name, l.store_number, l.horizon_shop_number, l.is_sandbox,
         s.id is not null,
         s.updated_at
    from public.locations l
    left join vault.secrets s
      on l.horizon_shop_number is not null
     and s.name = 'horizon_password:' || l.horizon_shop_number
   order by l.is_sandbox desc, l.store_number nulls first;
end
$fn$;

revoke all on function public.horizon_credential_status() from public, anon;
grant execute on function public.horizon_credential_status() to authenticated;


-- =====================================================================
-- ADD THE VALUE SERVICE PASSWORD (you, in the Dashboard -- not here)
--
--   Supabase Dashboard -> Project Settings -> Vault (or Integrations ->
--   Vault) -> "Add new secret"
--       Name:        horizon_password:b306006
--       Secret:      <Value Service's Horizon password>
--       Description: Horizon importer password, Value Service (sandbox)
--
--   The name must match exactly: lower case, colon, no spaces.
--   Do not add any real store's password yet -- uploads are
--   sandbox-only, so nothing would read it, and every stored password
--   is one more thing to protect.
--
-- VERIFY — in the SQL Editor
--
--  [1] The new column exists:
--        select column_name from information_schema.columns
--         where table_name = 'horizon_upload_log'
--           and column_name = 'credential_released_at';      -- one row
--
--  [2] The release function is service_role only (both false):
--        select has_function_privilege('authenticated',
--                 'public.horizon_release_credentials(bigint)', 'execute'),
--               has_function_privilege('anon',
--                 'public.horizon_release_credentials(bigint)', 'execute');
--
--  [3] After adding the secret, it is there -- WITHOUT decrypting it:
--        select name, updated_at from vault.secrets
--         where name like 'horizon_password:%';     -- one row, b306006
--
--  As admin/master, signed in (checked from the portal session):
--  [4] horizon_credential_status(): Value Service has_password true,
--      every real store false.
--  [5] horizon_upload_target(<value service>) now returns attempt_id.
--  [6] Calling horizon_release_credentials() from the browser, as
--      master, is refused (permission denied) -- no password.
--  As teststore:
--  [7] horizon_credential_status() -> 42501.
--
--  The service_role path (release once, 2-minute window, re-checks)
--  is proven in the local dry run and exercised for real by the Edge
--  Function's first sandbox upload.
-- =====================================================================
