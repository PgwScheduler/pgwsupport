-- =====================================================================
-- PGW Support Portal — district and regional managers send too
-- Run AFTER pgw_horizon_store_uploads_46.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Migration 46 opened the Horizon upload to store managers for their
-- own store and left district and regional managers out, only because
-- no account existed to verify them. They are now in, decided by the
-- user (2026-09-16).
--
-- WHAT A DISTRICT OR REGIONAL MANAGER GETS -- the same as a store
-- manager, across the stores they manage:
--   * any store can_access_location() gives them: a district manager
--     the stores in their district, a regional manager the stores in
--     their region. Never the sandbox (can_access_location refuses it to
--     every non-admin role, migration 38).
--   * review is not blocked by the sandbox-only switch; send is.
--   * plain refusal messages (the full reason is still logged).
--   * horizon_last_upload() for those stores.
--   And, in the Edge Function (deployed alongside this migration):
--   * this month or last month only, like a store manager;
--   * NO per-technician pay. The portal restricts the pay breakdown to
--     admin and master (migration 35); district and regional are not
--     admins, so the review hides individual pay from them too.
--
-- The functions keep their signatures, so this is create-or-replace;
-- the bodies are migration 46's with the role lists widened and the
-- store-only wording made role-neutral. Nothing else changes.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. horizon_upload_target()
-- ---------------------------------------------------------------------
create or replace function public.horizon_upload_target(
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
  if v_role is null or v_role not in ('admin', 'master', 'store', 'district', 'regional') then
    raise exception 'You do not have permission to send numbers to Horizon.' using errcode = '42501';
  end if;
  -- Managers (store, district, regional) reach only the stores
  -- can_access_location() gives them, which never includes the sandbox.
  if v_role not in ('admin', 'master') and not public.can_access_location(p_location_id) then
    raise exception 'You can only send numbers for stores you manage.' using errcode = '42501';
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
  reason           := case when v_role in ('admin', 'master') then v_reason else v_public end;
  attempt_id       := v_attempt;
  caller_role      := v_role;
  return next;
end
$fn$;

revoke all on function public.horizon_upload_target(uuid, text, text) from public, anon;
grant execute on function public.horizon_upload_target(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------
-- 2. horizon_last_upload()
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
  if v_role is null or v_role not in ('admin', 'master', 'store', 'district', 'regional')
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
--  [1] Both functions name the two new roles (true, true):
--        select pg_get_functiondef('public.horizon_upload_target(uuid,text,text)'::regprocedure) like '%''district'', ''regional''%' as upload_check,
--               pg_get_functiondef('public.horizon_last_upload(uuid)'::regprocedure)          like '%''district'', ''regional''%' as last_upload;
--
--  [2] Still exactly one upload check (1):
--        select count(*) from pg_proc where proname = 'horizon_upload_target';
--
--  [3] The switch is still on (true):
--        select upload_sandbox_only from public.horizon_config;
--
--  From the portal: needs a district (and a regional) test account --
--  review works for their stores and not for others or the sandbox, no
--  per-technician pay, send refused by the switch.
-- =====================================================================
