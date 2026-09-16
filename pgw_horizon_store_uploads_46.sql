-- =====================================================================
-- PGW Support Portal — store managers send their own numbers to Horizon
-- Run AFTER pgw_sandbox_shop_number_B306006_45.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Store managers close out each working day by sending the month so
-- far to Horizon -- the same thing the workbook's macro does. Until now
-- only admin/master could run the upload. This file opens it to the
-- store role, for THEIR OWN STORE ONLY, and keeps every existing guard.
--
-- WHO MAY RUN AN UPLOAD ATTEMPT
--   admin, master   any store they can reach (the sandbox included)
--   store           only their own store (can_access_location, which
--                   already refuses a store user the sandbox)
--   district, regional -- NOT YET. No account exists for either role,
--                   so nothing about them has been verified; adding
--                   them is one line here when they are.
--
-- PREVIEW IS NO LONGER BLOCKED BY THE SANDBOX-ONLY SWITCH; SEND STILL IS.
--   horizon_upload_target() gains p_purpose ('preview' | 'send',
--   default 'send'). A preview sends nothing and -- since migration 43 --
--   an attempt recorded as a preview can never release a password. So a
--   store manager can review their numbers today, while sending real
--   stores stays switched off until upload_sandbox_only is lifted.
--   The purpose asked for is stored on the log row (requested_purpose)
--   and horizon_release_credentials() now releases ONLY for an attempt
--   that asked to send. A preview attempt cannot be turned into a send
--   even before its result is recorded.
--
-- STORE USERS GET PLAIN MESSAGES. The detailed refusal (which names
--   shop numbers, location ids and the SQL that lifts the switch) is
--   still written to horizon_upload_log for admins; a store user is told
--   what to do instead.
--
-- THE RETURN GAINS caller_role, so the Edge Function can hide
--   per-technician pay from a store user (the portal never shows a store
--   user individual pay; see migrations 14 and 34). Because the return
--   type changes, the function is dropped and recreated. The deployed
--   Edge Function calls it by NAMED argument (p_location_id only), so it
--   keeps working across this change.
--
-- NEW: horizon_last_upload(location) -- the store's most recent send
--   and what Horizon said, for the "last sent" line on the Tic Sheet.
--   Store users may read their own store's; nothing about passwords.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. WHAT THE ATTEMPT ASKED FOR
-- ---------------------------------------------------------------------
alter table public.horizon_upload_log
  add column if not exists requested_purpose text;

alter table public.horizon_upload_log drop constraint if exists hul_requested_purpose_valid;
alter table public.horizon_upload_log add constraint hul_requested_purpose_valid
  check (requested_purpose is null or requested_purpose in ('preview', 'send'));

comment on column public.horizon_upload_log.requested_purpose is
  'What the caller asked horizon_upload_target() for. Only a ''send'' attempt can ever release a password.';


-- ---------------------------------------------------------------------
-- 2. horizon_upload_target() -- store role, purpose, friendly reasons
-- ---------------------------------------------------------------------
drop function if exists public.horizon_upload_target(uuid, text);
drop function if exists public.horizon_upload_target(uuid, text, text);

create function public.horizon_upload_target(
  p_location_id   uuid,
  p_intended_shop text default null,
  p_purpose       text default 'send'
)
returns table (shop_number text, authorized boolean, front_staff_slot smallint,
               reason text, attempt_id bigint, caller_role text)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role     text := public.current_user_role();
  v_shop     text;
  v_sandbox  boolean;
  v_conflict text;
  v_reason   text;   -- the full reason, always logged
  v_public   text;   -- what the caller is told
  v_fs_slot  smallint;
  v_fs_count int;
  v_only     boolean;
  v_why      text;
  v_attempt  bigint;
begin
  -- Authorization first (39c): a caller who may not upload learns
  -- nothing about state.
  if v_role is null or v_role not in ('admin', 'master', 'store') then
    raise exception 'You do not have permission to send numbers to Horizon.' using errcode = '42501';
  end if;
  if v_role = 'store' and not public.can_access_location(p_location_id) then
    raise exception 'You can only send numbers for your own store.' using errcode = '42501';
  end if;
  if p_purpose is null or p_purpose not in ('preview', 'send') then
    raise exception 'purpose must be preview or send' using errcode = '22023';
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

  -- (0) sandbox-only (40) -- for SENDS. Missing config row = on.
  if p_purpose = 'send' and coalesce(v_only, true) and not v_sandbox then
    v_reason := format('Portal uploads are limited to the sandbox. %s  Lift with: update public.horizon_config set upload_sandbox_only = false, updated_at = now() where id;',
                       coalesce(v_why, ''));
    v_public := 'Sending to Horizon from the portal is not switched on yet. Keep sending from your workbook for now. You can still review your numbers here.';

  -- (3) refuse null
  elsif v_shop is null then
    v_reason := 'Location has no Horizon shop number, so it cannot upload. Load its credentials first.';
    v_public := 'This store has no Horizon shop number in the portal yet. Ask an admin to set it up.';

  -- (1) the caller may assert, never override
  elsif p_intended_shop is not null and p_intended_shop <> v_shop then
    v_reason := format('Horizon shop number mismatch: caller asserted %L but the location resolves to %L.',
                       p_intended_shop, v_shop);
    v_public := 'The Horizon shop number did not match. Nothing was sent. Ask an admin.';

  else
    -- (2) assert the pairing
    select string_agg(l2.id::text, ', ') into v_conflict
      from public.locations l2
     where l2.horizon_shop_number = v_shop
       and l2.is_sandbox is distinct from v_sandbox;
    if v_conflict is not null then
      v_reason := format('Horizon sandbox pairing violated: shop %L is also claimed by location(s) %s with a different sandbox flag.',
                         v_shop, v_conflict);
      v_public := 'This store cannot send to Horizon right now because of a setup problem. Ask an admin.';

    -- (4) a Front Staff slot must exist to receive uncosted
    --     front-of-house labor sales.
    elsif v_fs_count <> 1 then
      v_reason := format('Location has %s Front Staff reservations, expected exactly 1. Front-of-house labor sales have nowhere to go; reserve a Front Staff slot before uploading.',
                         v_fs_count);
      v_public := 'This store has no Front Staff slot set up for Horizon. Ask an admin.';
    end if;
  end if;

  insert into public.horizon_upload_log
    (location_id, shop_number, is_sandbox, outcome, detail, attempted_by, requested_purpose)
  values
    (p_location_id, v_shop, v_sandbox,
     case when v_reason is null then 'authorized' else 'refused' end,
     v_reason, auth.uid(), p_purpose)
  returning id into v_attempt;

  -- On refusal nothing usable comes back -- neither the shop to
  -- transmit to nor the slot to write into.
  shop_number      := case when v_reason is null then v_shop else null end;
  authorized       := v_reason is null;
  front_staff_slot := case when v_reason is null then v_fs_slot else null end;
  reason           := case when v_role = 'store' then v_public else v_reason end;
  attempt_id       := v_attempt;
  caller_role      := v_role;
  return next;
end
$fn$;

revoke all on function public.horizon_upload_target(uuid, text, text) from public, anon;
grant execute on function public.horizon_upload_target(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------
-- 3. horizon_release_credentials() -- migration 43's body, plus one rule:
--    the attempt must have been requested as a send.
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
  -- NEW in 46: only an attempt that ASKED to send may release. A
  -- preview attempt never can, even before its result is recorded.
  if v_log.requested_purpose is distinct from 'send' then
    raise exception 'Upload attempt % was not requested as a send; no credentials are released for it.', p_attempt_id
      using errcode = '42501';
  end if;
  -- NEW in 43: an attempt already recorded (a preview, or a send that
  -- was stopped before release) never releases a password afterwards.
  if v_log.purpose is not null then
    raise exception 'Upload attempt % was already recorded as a %; no credentials are released for it.',
      p_attempt_id, v_log.purpose using errcode = '42501';
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
-- 4. horizon_last_upload() -- the store's latest send, for the page
-- ---------------------------------------------------------------------
create or replace function public.horizon_last_upload(p_location_id uuid)
returns table (sent_at timestamptz, month date, accepted boolean,
               horizon_reply text, sent_by text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_role text := public.current_user_role();
begin
  if v_role is null or v_role not in ('admin', 'master', 'store')
     or not public.can_access_location(p_location_id) then
    raise exception 'You do not have access to this store''s Horizon uploads.' using errcode = '42501';
  end if;

  return query
  select h.completed_at,
         h.month,
         (h.response_status = 200 and coalesce(h.response_body, '') !~* '^\s*error'),
         left(h.response_body, 300),
         coalesce(nullif(p.full_name, ''), p.email, 'unknown')
    from public.horizon_upload_log h
    left join public.profiles p on p.id = h.attempted_by
   where h.location_id = p_location_id
     and h.purpose = 'send'
     and h.response_status is not null
   order by h.completed_at desc
   limit 1;
end
$fn$;

revoke all on function public.horizon_last_upload(uuid) from public, anon;
grant execute on function public.horizon_last_upload(uuid) to authenticated;


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The new column, and the three-argument upload check:
--        select count(*) from information_schema.columns
--         where table_name = 'horizon_upload_log'
--           and column_name = 'requested_purpose';             -- 1
--        select pg_get_function_identity_arguments(oid)
--          from pg_proc where proname = 'horizon_upload_target';
--        -- exactly one row: p_location_id uuid, p_intended_shop text, p_purpose text
--
--  [2] Release is still service-role only (false, false):
--        select has_function_privilege('authenticated','public.horizon_release_credentials(bigint)','execute'),
--               has_function_privilege('anon','public.horizon_release_credentials(bigint)','execute');
--
--  [3] The switch is still on (true):
--        select upload_sandbox_only from public.horizon_config;
--
--  From the portal (checked by Claude):
--   as teststore: preview of #3303 works, without per-tech pay; send is
--     refused with the plain message; another store and the sandbox are
--     refused; horizon_last_upload works for #3303 only.
--   as master: sandbox preview and send unchanged; Millwood send still
--     refused by the switch; a preview attempt cannot release.
-- =====================================================================
