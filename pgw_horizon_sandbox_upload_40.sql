-- =====================================================================
-- PGW Support Portal — the sandbox can upload, and ONLY the sandbox
--                                     (Horizon upload, step 1 of the build)
-- Run AFTER pgw_horizon_freeze_order_39c.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Two changes, both so the Horizon upload can be built and tested
-- against Value Service (shop b306006) without any chance of touching a
-- real store's data in Horizon while the stores keep uploading from
-- their own workbooks.
--
--   1. VALUE SERVICE GETS ITS FRONT STAFF RESERVATION.
--      horizon_upload_target() refuses a location without exactly one
--      front_staff reservation (migration 39, precondition 3). 39a left
--      the sandbox without one on purpose: "reserve one deliberately
--      when the sandbox is next used". This is that.
--
--      SLOT 6, NOT 20. The sandbox's first job is the July comparison
--      (Millwood -> Value Service): upload Millwood's July into the
--      sandbox and compare the two shops side by side in Horizon.
--      Millwood's Front Staff is slot 6 -- its workbook's "MANAGER OR SA"
--      sheet feeds kpi_tech_6_* -- so mirroring it makes the two shops
--      line up slot for slot. Slot 6 is also inside the 12 technician
--      blocks the store workbook's macro sends; 20 is not.
--
--      Written directly, not through reserve_horizon_slot(): that
--      function gates on current_user_role(), which is null in the SQL
--      Editor (auth.uid() is null there), so every call raises. The
--      check constraints and location_horizon_slots_one_per_kind still
--      enforce the invariants on a direct write.
--
--   2. UPLOADS ARE SANDBOX-ONLY UNTIL SOMEONE SAYS OTHERWISE.
--      Preconditions 1-3 stop data going to the WRONG shop. None of them
--      stops a CORRECT upload to a real store -- and a correct upload
--      from the portal still overwrites what that store's manager sent
--      from the workbook, for every day of the month sent. Until the
--      portal's payload has been proven against the sandbox, no real
--      store may be a target at all.
--
--      New column horizon_config.upload_sandbox_only, DEFAULT TRUE, and
--      a fourth refusal in horizon_upload_target(). It is a verdict
--      (refused + logged), not a raise, like the other three -- see
--      migration 38's note that Postgres cannot raise and keep the log
--      row. It sits AFTER the role check (39c's lesson): only an admin
--      or master ever reaches it, so the reason text leaks nothing.
--
--      FAILS CLOSED. A missing horizon_config row reads as "sandbox
--      only", not as "open".
--
--      Lifting it is one UPDATE, printed at the bottom. Do not lift it
--      until the sandbox comparison matches Millwood.
--
-- WHAT THIS DOES NOT DO
--   * No transport. Nothing here sends anything anywhere. The upload is
--     an HTTP POST (see the note at the bottom); it gets built next and
--     must call horizon_upload_target() and use only what it returns.
--   * No credentials. Horizon wants a per-shop password IN the request.
--     It goes in Vault or an admin-only table in its own change -- never
--     in a migration file.
--   * Slot assignment stays frozen (39b). Unrelated to uploads.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. FRONT STAFF AT VALUE SERVICE, SLOT 6
-- ---------------------------------------------------------------------
do $$
declare
  v_loc      uuid;
  v_count    int;
  v_existing smallint;
  v_occupant uuid;
begin
  select count(*), min(id::text)::uuid into v_count, v_loc
    from public.locations where is_sandbox;
  if v_count <> 1 then
    raise exception 'Expected exactly one sandbox location, found %. Stopping.', v_count;
  end if;

  -- Already reserved (a re-run, or someone reserved it by hand):
  -- leave it where it is. Moving a reservation strands whatever labor
  -- sales were already written to the old slot.
  select slot_number into v_existing
    from public.location_horizon_slots
   where location_id = v_loc and is_reserved and reservation_kind = 'front_staff';
  if found then
    raise notice 'Value Service already has Front Staff at slot %; left unchanged.', v_existing;
    return;
  end if;

  select current_technician_id into v_occupant
    from public.location_horizon_slots
   where location_id = v_loc and slot_number = 6;
  if not found then
    raise exception 'Value Service has no slot 6 row. Migration 38 should have provisioned 20. Stopping.';
  end if;
  if v_occupant is not null then
    raise exception 'Value Service slot 6 is held by technician %. Release it deliberately first. Stopping.', v_occupant;
  end if;

  -- Clearing or setting a reservation is not a release: ever_used and
  -- last_released_at are left alone (migration 39, section 4).
  update public.location_horizon_slots
     set is_reserved       = true,
         reservation_kind  = 'front_staff',
         reservation_label = 'Front Staff'
   where location_id = v_loc and slot_number = 6;

  raise notice 'Value Service: Front Staff reserved at slot 6.';
end
$$;


-- ---------------------------------------------------------------------
-- 2. THE SANDBOX-ONLY SWITCH
-- ---------------------------------------------------------------------
alter table public.horizon_config
  add column if not exists upload_sandbox_only boolean not null default true;
alter table public.horizon_config
  add column if not exists upload_lock_reason text;

-- The row exists since 39b; the insert only matters on a database where
-- it somehow does not. `add column ... default true` already set TRUE on
-- the existing row, so nothing is overwritten on a re-run.
insert into public.horizon_config (id, upload_sandbox_only, upload_lock_reason)
values (true, true, null)
on conflict (id) do nothing;

update public.horizon_config
   set upload_lock_reason = 'The portal''s Horizon upload has not yet been proven against the sandbox (Value Service, b306006). Until it is, stores keep uploading from their own workbooks and the portal may target the sandbox only.',
       updated_at = now()
 where id and upload_lock_reason is null;

comment on column public.horizon_config.upload_sandbox_only is
  'When true (the default), horizon_upload_target() refuses every location that is not is_sandbox. Real stores are protected from portal uploads until this is lifted deliberately.';

comment on table public.horizon_config is
  'Single-row switches for Horizon. slot_assignment_frozen blocks assign_horizon_slot() while the roster load is outstanding. upload_sandbox_only blocks portal uploads to every real store.';


-- 2.1 horizon_upload_target() -- migration 39's body plus check (0).
--     Same signature and return type, so create-or-replace replaces it
--     rather than adding an overload.
create or replace function public.horizon_upload_target(
  p_location_id   uuid,
  p_intended_shop text default null
)
returns table (shop_number text, authorized boolean, front_staff_slot smallint, reason text)
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

  -- (0) sandbox-only. FIRST, so a real store is refused for this reason
  --     even when it would also fail another check. Missing row = on.
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
     v_reason, auth.uid());

  -- On refusal nothing usable comes back -- neither the shop to
  -- transmit to nor the slot to write into.
  shop_number      := case when v_reason is null then v_shop else null end;
  authorized       := v_reason is null;
  front_staff_slot := case when v_reason is null then v_fs_slot else null end;
  reason           := v_reason;
  return next;
end
$fn$;

revoke all on function public.horizon_upload_target(uuid, text) from public, anon;
grant execute on function public.horizon_upload_target(uuid, text) to authenticated;


-- =====================================================================
-- VERIFY — in the SQL Editor. (horizon_upload_target() itself needs a
-- signed-in admin, so [4]-[6] are checked from the portal session.)
--
--  [1] Value Service has exactly one reservation, Front Staff at 6:
--        select s.slot_number, s.reservation_kind, s.reservation_label,
--               s.ever_used, s.last_released_at
--          from public.location_horizon_slots s
--          join public.locations l on l.id = s.location_id
--         where l.is_sandbox and s.is_reserved;
--      One row: 6 / front_staff / Front Staff / false / null.
--
--  [2] The switch is on, with its reason:
--        select slot_assignment_frozen, upload_sandbox_only, upload_lock_reason
--          from public.horizon_config;
--      true / true / 'The portal''s Horizon upload has not yet ...'
--
--  [3] No other store's reservations moved (38 stores, 42 rows, as 39a):
--        select count(*) from public.location_horizon_slots s
--          join public.locations l on l.id = s.location_id
--         where s.is_reserved and not l.is_sandbox;          -- 42
--
--  As admin/master, signed in:
--  [4] Sandbox authorized: horizon_upload_target(<value service id>)
--      -> b306006 / true / 6 / null
--  [5] Millwood REFUSED by the switch, shop withheld:
--      horizon_upload_target(<3303 id>)
--      -> null / false / null / 'Portal uploads are limited to the sandbox. ...'
--  [6] Both attempts are in horizon_upload_log, Millwood's as 'refused'.
--  [7] As a store user: still 42501, no mention of the switch.
--
-- LIFT (only after the sandbox comparison matches Millwood):
--   update public.horizon_config
--      set upload_sandbox_only = false, updated_at = now()
--    where id;
-- =====================================================================
--
-- NOTE FOR THE TRANSPORT (from the store workbook's macro, Module1):
--   POST https://coaching.horizontmg.com/importer/coaching.php
--   body application/x-www-form-urlencoded:
--     data[SHOP_STORENUMBER]=<shop>  data[PASSWORD]=<shop password>
--     data[kpi][<days since 1970-01-01>][<kpi key>]=<value>   per day
--     data[monthly][<first-of-month days>][kpi_su_*]=<goal pct>
--     data[monthly][<first-of-month days>][kpi_tech_N_name]=<name>  N=1..12
--   Days sent = 1st of month through today, capped at month end.
--   The shop number MUST come from horizon_upload_target(), never from
--   the caller.
-- =====================================================================
