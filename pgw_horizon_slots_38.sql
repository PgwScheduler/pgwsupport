-- =====================================================================
-- PGW Support Portal — Horizon slot persistence, sandbox isolation,
-- and the Florida stores                                    (Brief 38)
-- Run AFTER pgw_report_cars_vs_py_fix_37.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Horizon TMG addresses exactly 20 technician slots per shop. The upload
-- writes tech data INTO those numbered slots, so if the portal invents
-- its own numbering the first upload overwrites technician history that
-- is already sitting in Horizon for every store. Everything in Part 2
-- and Part 3 exists to stop that.
--
-- TWO ALLOCATION RULES, set by operations:
--   1. Never-used slots are consumed before freed slots are reused. A
--      store with 15 techs where tech 2 was terminated puts the next
--      hire in slot 16, not slot 2. The longer a terminated tech's slot
--      goes unreused, the longer his Horizon history stays attributable.
--   2. A rehired technician takes the next slot in the queue. He does
--      not reclaim his old slot even if it is still free.
--
-- *** location_horizon_slots IS NOT tech_slots. ***
-- Three tables, three cardinalities, three masters:
--   employees               unbounded  PGW          the actual roster
--   tech_slots (mig. 24)    9          the Excel    daily entry grid,
--                                      sheet        freely reassignable
--   location_horizon_slots  20         Horizon TMG  external address
--                                                   space, allocation-
--                                                   disciplined
-- Millwood runs 15 technicians against 9 tech_slots rows, which is the
-- proof tech_slots is an entry grid and not a roster. Migration 29's
-- tech_reassign_slot() permits free movement -- correct for a grid,
-- forbidden for Horizon.
--
-- THE TWO SLOT TABLES MUST NEVER BE JOINED TO EACH OTHER. Both join to
-- employees; the upload resolves employee_id -> Horizon slot. Any query
-- joining tech_slots.slot_index to location_horizon_slots.slot_number is
-- a defect regardless of the result it returns.
--
-- Unrelated despite the name: public.service_categories.horizon_key
-- (migration 18) is the KPI service-line mapping ('kpi_su_tires'), not a
-- shop identifier. It has nothing to do with horizon_shop_number.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. PREFLIGHT
--    The partial unique index in 1.4 cannot be created over duplicate
--    store numbers. Fail loudly here rather than half-applying the
--    migration; resolving duplicates is a data decision, not this
--    migration's job.
-- ---------------------------------------------------------------------
do $preflight$
declare v_dupes text;
begin
  select string_agg(store_number, ', ' order by store_number) into v_dupes
    from (select store_number from public.locations
           where store_number is not null
           group by store_number having count(*) > 1) q;
  if v_dupes is not null then
    raise exception
      'Duplicate store_number(s) present: %. Resolve these before running migration 38.',
      v_dupes using errcode = 'P0001';
  end if;
end
$preflight$;


-- ---------------------------------------------------------------------
-- 1. LOCATIONS
-- ---------------------------------------------------------------------

-- 1.1 Horizon shop number.
--     NULLABLE because most stores have no credentials loaded yet.
--     UNIQUE because two locations pointing at one Horizon shop is
--     precisely the silent-overwrite scenario this brief exists to stop.
--
--     Shop number is DATA, NEVER DERIVED. There is no formula that turns
--     a store number into a shop number -- Value Service's is 'b306006',
--     which is not numeric and matches no store number pattern. Any code
--     that constructs a shop number from a store number is a bug.
alter table public.locations
  add column if not exists horizon_shop_number text null;

create unique index if not exists locations_horizon_shop_number_key
  on public.locations (horizon_shop_number)
  where horizon_shop_number is not null;

-- 1.2 Sandbox flag.
--     SANDBOX IS NOT DIVESTED. They are different rules and must never
--     share a column:
--       divested  historical data is REAL and must still appear in
--                 prior-period reporting; excluded from current periods
--                 only; historically included in bonus/GP rollups.
--       sandbox   data is FAKE; excluded from all periods, always;
--                 never included in any rollup.
--     Collapsing them either resurrects fake data into a rollup or
--     erases real divested history.
--
--     NOTE: no divested mechanism exists in this schema today. Rabon Rd,
--     Broad River and Old Bush were never seeded as locations (see the
--     header of pgw_seed_bonus_2026.sql). The rule above is forward-
--     looking and is deliberately NOT implemented here.
--     Midas Bush River (#3936) is a LIVE store with 2026 goals and a
--     bonus plan. It is not "Old Bush" / "SD Bush". Never flag
--     divestiture by name match.
alter table public.locations
  add column if not exists is_sandbox boolean not null default false;

-- 1.3 Phone. Free text, no format enforcement.
alter table public.locations
  add column if not exists phone text null;

-- 1.4 Store number uniqueness.
--     PARTIAL because Value Service has no store number and future
--     sandbox rows will not either; a total unique index would block
--     more than one of them.
create unique index if not exists locations_store_number_key
  on public.locations (store_number)
  where store_number is not null;


-- ---------------------------------------------------------------------
-- 2. SLOT STATE
--    Slot state persists INDEPENDENTLY of technician records. A slot
--    that was used and freed has different queue priority than a slot
--    never touched, and with no technician row pointing at it there is
--    nowhere else to keep that distinction.
-- ---------------------------------------------------------------------
create table if not exists public.location_horizon_slots (
  location_id           uuid not null references public.locations (id) on delete cascade,
  slot_number           smallint not null check (slot_number between 1 and 20),
  current_technician_id uuid null references public.employees (id) on delete set null,
  ever_used             boolean not null default false,
  last_released_at      timestamptz null,
  primary key (location_id, slot_number)
);

-- One technician cannot occupy two slots at one store. Structurally the
-- same guard as migration 29's tech_slots_one_slot_per_employee, on a
-- different table -- hence the distinct name.
create unique index if not exists location_horizon_slots_occupant_key
  on public.location_horizon_slots (location_id, current_technician_id)
  where current_technician_id is not null;

create index if not exists location_horizon_slots_occupant_idx
  on public.location_horizon_slots (current_technician_id)
  where current_technician_id is not null;

comment on table public.location_horizon_slots is
  'Horizon TMG 20 addressed technician slots per shop. External address space, allocation-disciplined: never-used slots are consumed before freed slots are reused, and a rehired technician takes the next queue slot rather than reclaiming his old one. NOT the same thing as public.tech_slots (the 9-row Excel entry grid) and MUST NEVER BE JOINED TO IT -- both join to public.employees instead.';

comment on table public.tech_slots is
  'The 9-row per-store Excel "Technician Tracking" entry grid. Freely reassignable via tech_reassign_slot(). NOT the same thing as public.location_horizon_slots (Horizon TMG 20 addressed slots) and MUST NEVER BE JOINED TO IT -- both join to public.employees instead.';

-- 2.1 Twenty rows per location, occupied or not, at creation.
--     SECURITY DEFINER because location_horizon_slots carries RLS with
--     no write policy -- every write goes through a definer function.
--     Without this the trigger would run as the master creating the
--     store and be blocked by that table's own policies.
create or replace function public.provision_horizon_slots()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  insert into public.location_horizon_slots (location_id, slot_number)
  select new.id, s.n from generate_series(1, 20) as s(n)
  on conflict (location_id, slot_number) do nothing;
  return new;
end
$fn$;

drop trigger if exists provision_horizon_slots on public.locations;
create trigger provision_horizon_slots
  after insert on public.locations
  for each row execute function public.provision_horizon_slots();

-- Backfill every location that already exists.
insert into public.location_horizon_slots (location_id, slot_number)
select l.id, s.n
from public.locations l cross join generate_series(1, 20) as s(n)
on conflict (location_id, slot_number) do nothing;

-- 2.2 location_horizon_slots is the SOURCE OF TRUTH. horizon_slot is
--     deliberately NOT denormalized onto employees or tech_slots: a
--     mirrored column drifts, and a drifted slot number is exactly the
--     overwrite this migration exists to prevent. Read through the view.
create or replace view public.technician_horizon_slots
  with (security_invoker = true) as
select s.location_id, s.slot_number, s.current_technician_id as technician_id
from public.location_horizon_slots s
where s.current_technician_id is not null;

-- 2.3 Terminated technicians still holding a slot.
--     Releasing is NOT triggered by employees.active -- see section 3.3.
--     This view backs the standing indicator that makes an unreleased
--     slot visible instead of silent.
create or replace view public.horizon_slots_held_by_inactive
  with (security_invoker = true) as
select s.location_id, s.slot_number,
       e.id as employee_id, e.full_name, e.position
from public.location_horizon_slots s
join public.employees e on e.id = s.current_technician_id
where not e.active;


-- ---------------------------------------------------------------------
-- 3. ASSIGNMENT AND RELEASE
-- ---------------------------------------------------------------------

-- 3.1 Next-slot selection. The whole queue rule is one ORDER BY:
--       ever_used asc          false first -> never-used before freed
--       last_released_at asc   among freed, oldest release first, which
--                              gives a terminated tech's slot the
--                              longest possible life before reuse
--       slot_number asc        deterministic tiebreak
create or replace function public.next_horizon_slot(p_location_id uuid)
returns smallint
language sql stable
set search_path = public, pg_temp
as $fn$
  select slot_number
  from public.location_horizon_slots
  where location_id = p_location_id
    and current_technician_id is null
  order by ever_used asc,
           last_released_at asc nulls first,
           slot_number asc
  limit 1
$fn$;

-- 3.2 Assignment.
--     THE FULL-STORE CASE FAILS LOUDLY. Twenty active technicians with a
--     twenty-first hired is a real situation at larger stores. Returning
--     null, silently reusing a slot, or defaulting to slot 1 all cause
--     the data loss this migration prevents. Raise, surface it in the
--     UI, and make the manager release someone first.
--
--     Rehire is NOT a special case: a rehired technician calls this like
--     any new hire and takes whatever the queue returns. There is
--     deliberately no lookup of a prior slot.
create or replace function public.assign_horizon_slot(
  p_location_id   uuid,
  p_technician_id uuid
) returns smallint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_slot smallint;
begin
  -- Admin/master, following migration 29's precedent for tech_slots
  -- writes. That reasoning applies more strongly here: a tech_slots
  -- mistake mis-costs a month, a Horizon slot mistake overwrites
  -- technician history inside an external system. Loosening this later
  -- costs nothing; discovering it was too loose is not recoverable.
  -- POLICY CHOICE -- confirm with BDC alongside the Part 5 role scoping.
  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can assign a Horizon slot' using errcode = '42501';
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for that location' using errcode = '42501';
  end if;
  if p_technician_id is null then
    raise exception 'a technician is required' using errcode = '22023';
  end if;

  -- Readable message instead of a raw constraint-violation string; the
  -- partial unique index catches it too.
  if exists (
    select 1 from public.location_horizon_slots
     where location_id = p_location_id
       and current_technician_id = p_technician_id
  ) then
    raise exception 'That technician already holds a Horizon slot at this store'
      using errcode = '23505';
  end if;

  select public.next_horizon_slot(p_location_id) into v_slot;
  if v_slot is null then
    raise exception
      'All 20 Horizon slots are occupied at location %. A technician must be released before another can be assigned.',
      p_location_id
      using errcode = 'P0001';
  end if;

  update public.location_horizon_slots
     set current_technician_id = p_technician_id,
         ever_used             = true,
         last_released_at      = null
   where location_id = p_location_id and slot_number = v_slot;

  return v_slot;
end
$fn$;

-- 3.3 Release.
--     ever_used stays true permanently. It is a high-water mark, never
--     reset.
--
--     RELEASE IS A DELIBERATE ACTION. There is deliberately NO trigger
--     connecting employees.active to slot occupancy, because the two
--     directions are not symmetric: a terminated technician HOLDING a
--     slot is the safe state (his history stays attributable, and it
--     costs nothing until the store needs a 21st slot), while RELEASING
--     is destructive and, under the rehire rule, effectively
--     irreversible -- flipping active back does not restore the slot,
--     the technician goes to the end of the queue, and slot ordering is
--     permanently altered. employees.active exists for payroll
--     filtering; coupling it here would let a payroll correction
--     silently reorder the Horizon queue.
--     The compensating control is the standing indicator backed by
--     public.horizon_slots_held_by_inactive (section 2.3).
create or replace function public.release_horizon_slot(
  p_location_id   uuid,
  p_technician_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can release a Horizon slot' using errcode = '42501';
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for that location' using errcode = '42501';
  end if;

  update public.location_horizon_slots
     set current_technician_id = null,
         last_released_at      = now()
   where location_id = p_location_id
     and current_technician_id = p_technician_id;
end
$fn$;

-- 3.4 Seeding, for the Millwood template import.
--     Existing stores have assignments already live in Horizon; those
--     are imported AS-IS, never generated by the queue. Note this always
--     sets ever_used = true, INCLUDING for a vacated slot with no
--     occupant -- that is the entire reason the seeding path is separate
--     from the assignment path.
create or replace function public.seed_horizon_slot(
  p_location_id   uuid,
  p_slot_number   smallint,
  p_technician_id uuid,        -- null for a vacated slot
  p_released_at   timestamptz  -- null when occupied
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if public.current_user_role() not in ('admin','master') then
    raise exception 'Only an admin can seed Horizon slots' using errcode = '42501';
  end if;
  if not public.can_access_location(p_location_id) then
    raise exception 'not authorized for that location' using errcode = '42501';
  end if;

  update public.location_horizon_slots
     set current_technician_id = p_technician_id,
         ever_used             = true,
         last_released_at      = case when p_technician_id is null then p_released_at else null end
   where location_id = p_location_id and slot_number = p_slot_number;
end
$fn$;

revoke all on function public.next_horizon_slot(uuid) from public, anon;
revoke all on function public.assign_horizon_slot(uuid, uuid) from public, anon;
revoke all on function public.release_horizon_slot(uuid, uuid) from public, anon;
revoke all on function public.seed_horizon_slot(uuid, smallint, uuid, timestamptz) from public, anon;
grant execute on function public.next_horizon_slot(uuid) to authenticated;
grant execute on function public.assign_horizon_slot(uuid, uuid) to authenticated;
grant execute on function public.release_horizon_slot(uuid, uuid) to authenticated;
grant execute on function public.seed_horizon_slot(uuid, smallint, uuid, timestamptz) to authenticated;


-- ---------------------------------------------------------------------
-- 4. BIDIRECTIONAL UPLOAD GUARD
--    A distinct shop number stops sandbox data landing on a real store.
--    It does NOT stop the reverse -- a real store's data sent under the
--    sandbox shop number, which Horizon would accept, returning success
--    while a month of real reporting quietly vanishes. Guard both ways.
--
--    The transport (endpoint, auth, payload encoding) is out of scope.
--    What lands here is the part that must not live in the transport:
--    the shop number resolves from the location row, the pairing is
--    asserted before any network call, and every attempt is logged.
-- ---------------------------------------------------------------------
create table if not exists public.horizon_upload_log (
  id           bigint generated always as identity primary key,
  location_id  uuid not null references public.locations (id) on delete cascade,
  shop_number  text,
  is_sandbox   boolean,
  outcome      text not null check (outcome in ('authorized','refused')),
  detail       text,
  attempted_by uuid references auth.users (id),
  attempted_at timestamptz not null default now()
);
create index if not exists horizon_upload_log_loc_idx
  on public.horizon_upload_log (location_id, attempted_at desc);

-- horizon_upload_target()
--   1. SHOP NUMBER IS NEVER A PARAMETER. It is read from the location
--      row being uploaded. p_intended_shop is an ASSERTION input, not a
--      source: when supplied it must equal the resolved value, which is
--      what makes a caller that thinks it knows the shop number fail
--      instead of overriding.
--   2. THE PAIRING IS ASSERTED before transmit -- the location's
--      is_sandbox must agree with the sandbox flag of whoever owns that
--      shop number. The unique index makes a shared shop number
--      impossible, so this catches a shop number re-pointed between a
--      real store and the sandbox.
--   3. NULL IS REFUSED. A location with no horizon_shop_number cannot
--      upload; transmitting to an empty or default shop is the failure
--      mode this exists to stop.
--
-- WHY THIS RETURNS A VERDICT INSTEAD OF RAISING.
-- The brief asks for two things that a raise cannot both deliver:
-- abort before the network call, AND log every attempt including
-- refusals. Postgres has no autonomous transactions, so an exception
-- rolls back the log row it was meant to leave behind -- a guard that
-- raises keeps no evidence of exactly the events worth auditing.
--
-- So the refusal is expressed in the return value, and it is expressed
-- in the one field the transport cannot proceed without: on any refusal
-- shop_number comes back NULL. A caller that ignores `authorized`
-- still has no shop to transmit to. The abort is structural rather than
-- advisory, and the log row survives.
--
-- The transport MUST treat `authorized = false` as a hard stop and MUST
-- NOT substitute a shop number from any other source.
create or replace function public.horizon_upload_target(
  p_location_id   uuid,
  p_intended_shop text default null
)
returns table (shop_number text, authorized boolean, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_shop     text;
  v_sandbox  boolean;
  v_conflict text;
  v_reason   text;
begin
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

  -- (3) refuse null
  if v_shop is null then
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
    end if;
  end if;

  insert into public.horizon_upload_log
    (location_id, shop_number, is_sandbox, outcome, detail, attempted_by)
  values
    (p_location_id, v_shop, v_sandbox,
     case when v_reason is null then 'authorized' else 'refused' end,
     v_reason, auth.uid());

  -- On refusal the shop number is withheld, not merely flagged. There is
  -- nothing to transmit to.
  shop_number := case when v_reason is null then v_shop else null end;
  authorized  := v_reason is null;
  reason      := v_reason;
  return next;
end
$fn$;

revoke all on function public.horizon_upload_target(uuid, text) from public, anon;
grant execute on function public.horizon_upload_target(uuid, text) to authenticated;


-- ---------------------------------------------------------------------
-- 5a. VISIBILITY — sandbox locations are admin/master only
--     Part 5 needs TWO mechanisms, not one, and this is the first.
--     can_access_location() cannot do rollup exclusion, because it
--     returns true for admin/master by design; section 5b handles that
--     separately in the query layer.
--
--     Blast radius is deliberate and accepted: this function backs the
--     RLS `using` clause of essentially every table in the portal
--     (including locations_select itself), so one sandbox clause here
--     hides Value Service from store, district and regional users
--     uniformly -- pickers, lists, and every scoped table at once.
--
--     SECURITY DEFINER, so the self-read of public.locations bypasses
--     RLS and cannot recurse through locations_select. The existing body
--     already read public.locations for the district/region lookups;
--     that pattern is unchanged.
--     search_path = '' is preserved and every name stays qualified
--     (auth.uid() is already schema-qualified).
-- ---------------------------------------------------------------------
create or replace function public.can_access_location(loc uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and (
        p.role in ('admin','master')
        or (p.role = 'store'    and p.location_id = loc)
        or (p.role = 'district' and p.district_id =
              (select l.district_id from public.locations l where l.id = loc))
        or (p.role = 'regional' and p.region_id =
              (select d.region_id
                 from public.districts d
                 join public.locations l on l.district_id = d.id
                where l.id = loc))
      )
      -- A sandbox store is fake data. Only admin and master may reach it.
      and (
        p.role in ('admin','master')
        or not coalesce(
             (select l.is_sandbox from public.locations l where l.id = loc), false)
      )
  );
$$;
grant execute on function public.can_access_location(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 5b. ROLLUP EXCLUSION — `and l.is_sandbox = false` at every scope site
--
--     Every cross-location scan in this schema uses one idiom:
--       where public.can_access_location(l.id) and (<loc filter>)
--     so the sandbox predicate goes in exactly there. Enforced in the
--     query layer, not by hoping the UI never selects the store.
--
--     THIRTEEN SITES ACROSS SEVEN FUNCTIONS, not the nine the audit
--     first reported. payroll_to_sales_range has SIX, not three: beyond
--     store_count, the wages scope and the gross denominator, three more
--     compute the hours_thru / sales_thru watermarks by joining
--     payroll_daily, tech_daily and daily_kpi to locations. Sandbox
--     activity would have dragged those watermarks forward.
--
--     EVERY BODY BELOW IS COPIED VERBATIM FROM THE LIVE SOURCE, with the
--     predicate inserted and nothing else changed. In particular
--     report_build comes from migration 37 -- migrations 35 and 36 each
--     define an older body, and resurrecting one silently reverts the
--     cars-vs-prior-year fix.
--
--     Authorization guards of the form can_access_location(loc) are left
--     ALONE on purpose. They authorize an explicitly named location, and
--     an admin naming Value Service deliberately is allowed to.
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- _tech_pay_range  --  body copied VERBATIM from migration 33; 1 scope site(s) filtered.
-- ---------------------------------------------------------------------
create or replace function public._tech_pay_range(d_from date, d_to date, loc uuid default null)
returns table (
  location_id  uuid,
  labor_sales  numeric,
  labor_cost   numeric,
  flag_hours   numeric,
  hours_worked numeric
)
language sql stable security definer set search_path = '' as $$
  with scope as (
    select l.id
      from public.locations l
     where public.can_access_location(l.id) and l.is_sandbox = false
       and (loc is null or l.id = loc)
  ),
  -- Every day of every WHOLE week the range touches, so the engine sees
  -- complete weeks even when the range does not.
  d as (
    select
      td.location_id                                                as loc_id,
      td.tech_slot_id                                               as slot,
      (td.work_date - (extract(dow from td.work_date)::int))::date  as week_start,
      td.hours_worked                                               as hours,
      td.flag_hours                                                 as flag,
      td.labor_sales                                                as labor,
      td.hours_worked * coalesce(r.guarantee_rate, 0)               as guar_pay,
      td.flag_hours   * coalesce(r.flat_rate, 0)                    as commission,
      coalesce(r.guarantee_rate, 0)                                 as guar_rate,
      (td.work_date >= d_from and td.work_date <= d_to)             as in_range
    from public.tech_daily td
    join scope s on s.id = td.location_id
    left join lateral (
      select pr.flat_rate, pr.guarantee_rate
        from public.tech_pay_rates pr
       where pr.employee_id = td.employee_id
         and pr.effective_date <= td.work_date
       order by pr.effective_date desc
       limit 1
    ) r on true
    -- The WHOLE weeks the range touches: Sunday on-or-before d_from
    -- through Saturday on-or-after d_to.
    where td.work_date >= (d_from - (extract(dow from d_from)::int))
      and td.work_date <= (d_to + (6 - extract(dow from d_to)::int))
  ),
  per_week as (
    select
      d.loc_id, d.slot, d.week_start,
      sum(d.hours)                                          as ht,
      sum(d.guar_pay)                                       as gt,
      sum(d.commission)                                     as ct,
      max(d.guar_rate)                                      as gr,
      sum(d.hours) filter (where d.in_range)                as hours_in_range,
      sum(d.labor) filter (where d.in_range)                as labor_in_range,
      sum(d.flag)  filter (where d.in_range)                as flag_in_range
    from d
    group by d.loc_id, d.slot, d.week_start
  ),
  paid as (
    select
      pw.*,
      coalesce(tw.other_pay, 0) as op,
      -- Whole-week overtime. Below 40 hours there is none, by definition.
      case when pw.ht < 40 then 0
           when pw.gt > pw.ct then (pw.ht - 40) * pw.gr * 0.5
           else (pw.ht - 40) * (pw.ct / nullif(pw.ht, 0)) * 0.5 end as ot
    from per_week pw
    left join public.tech_weekly tw
      on tw.tech_slot_id = pw.slot and tw.week_start = pw.week_start
  ),
  attributed as (
    select
      paid.loc_id,
      coalesce(paid.labor_in_range, 0) as a_labor_sales,
      -- Whole-week pay, pro-rated by the hours inside the range.
      case when paid.ht = 0 then 0
           else (greatest(paid.gt + paid.ot, paid.ct) + paid.op)
                * (coalesce(paid.hours_in_range, 0) / paid.ht)
      end                              as a_labor_cost,
      coalesce(paid.flag_in_range, 0)  as a_flag,
      coalesce(paid.hours_in_range, 0) as a_hours
    from paid
  )
  select attributed.loc_id,
         coalesce(sum(attributed.a_labor_sales), 0),
         coalesce(sum(attributed.a_labor_cost), 0),
         coalesce(sum(attributed.a_flag), 0),
         coalesce(sum(attributed.a_hours), 0)
    from attributed
   group by attributed.loc_id;
$$;
revoke all on function public._tech_pay_range(date, date, uuid) from public;

-- ---------------------------------------------------------------------
-- dashboard_range_metrics  --  body copied VERBATIM from migration 33; 1 scope site(s) filtered.
-- ---------------------------------------------------------------------
create or replace function public.dashboard_range_metrics(d_from date, d_to date, loc uuid default null)
returns table (
  store_count       int,
  gross_sales       numeric,
  labor_sales       numeric,
  labor_cost        numeric,
  parts_cost        numeric,
  tire_cost         numeric,
  cost_of_sales     numeric,
  gross_profit      numeric,
  gross_profit_pct  numeric,
  groupon           numeric,
  tire_units        numeric,
  days_with_data    int,
  tires_per_day     numeric,
  credit_apps       numeric,
  ro_count          numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  -- BIGINT, not uuid. service_categories and daily_kpi both use
  -- `bigint generated always as identity` (migration 18); only the
  -- location/employee tables are uuid-keyed. Declaring this uuid made
  -- the whole function fail with "invalid input syntax for type uuid".
  v_tire_cat bigint;
begin
  if d_from is null or d_to is null or d_from > d_to then
    raise exception 'invalid range % .. %', d_from, d_to using errcode = '22007';
  end if;
  if loc is not null and not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc using errcode = '42501';
  end if;

  select id into v_tire_cat
    from public.service_categories where horizon_key = 'kpi_su_tires' limit 1;

  return query
  with scope as (
    select l.id from public.locations l
     where public.can_access_location(l.id) and l.is_sandbox = false
       and (loc is null or l.id = loc)
  ),
  k as (
    select dk.*
      from public.daily_kpi dk
      join scope s on s.id = dk.location_id
     where dk.business_date >= d_from and dk.business_date <= d_to
  ),
  -- A day the store actually traded, not merely a row that exists.
  --
  -- Every column below is QUALIFIED with its table alias on purpose. In
  -- plpgsql an OUT parameter is a variable, and this function has OUT
  -- parameters called ro_count, credit_apps, tire_units and others; a
  -- bare reference matching one of them raises 42702 or, worse, reads
  -- the variable instead of the column. Same trap noted in migration 32.
  entered as (
    select distinct k.business_date
      from k
     where coalesce(k.ro_count, 0) <> 0
        or coalesce(k.sales_parts, 0) <> 0
        or coalesce(k.sales_tires, 0) <> 0
        or coalesce(k.sales_supplies, 0) <> 0
        or coalesce(k.sales_discounts, 0) <> 0
        or coalesce(k.sales_groupon, 0) <> 0
  ),
  kpi as (
    select
      coalesce(sum(k.sales_parts), 0)     as parts,
      coalesce(sum(k.sales_tires), 0)     as tires,
      coalesce(sum(k.sales_supplies), 0)  as supplies,
      coalesce(sum(k.sales_groupon), 0)   as k_groupon,
      coalesce(sum(k.sales_discounts), 0) as discounts,
      coalesce(sum(k.cost_parts), 0)      as k_parts_cost,
      coalesce(sum(k.cost_tires), 0)      as k_tire_cost,
      -- ::numeric is NOT cosmetic. credit_apps, ro_count and units are
      -- int columns, so sum() returns BIGINT. Two things go wrong without
      -- the cast: the row fails to match this function's numeric result
      -- type, and — far worse — `tire_units / days_with_data` below
      -- becomes INTEGER DIVISION. 95 tires over 9 days would silently
      -- report 10 instead of 10.56, and nothing would look broken.
      coalesce(sum(k.credit_apps), 0)::numeric as k_credit_apps,
      coalesce(sum(k.ro_count), 0)::numeric    as k_ro_count
    from k
  ),
  units as (
    select coalesce(sum(dsu.units), 0)::numeric as k_tire_units
      from public.daily_service_units dsu
      join k on k.id = dsu.daily_kpi_id
     where v_tire_cat is not null and dsu.service_category_id = v_tire_cat
  ),
  tech as (
    select coalesce(sum(t.labor_sales), 0) as t_labor_sales,
           coalesce(sum(t.labor_cost), 0)  as t_labor_cost
      from public._tech_pay_range(d_from, d_to, loc) t
  ),
  agg as (
    select
      (select count(*)::int from scope)   as n_stores,
      (select count(*)::int from entered) as n_days,
      kpi.*, units.k_tire_units, tech.t_labor_sales, tech.t_labor_cost
    from kpi, units, tech
  )
  select
    -- EVERY column is cast explicitly. RETURNS TABLE matches by position
    -- AND by type, and the inference here is not obvious: sum() over an
    -- int column yields BIGINT, count() yields bigint, and a CASE whose
    -- first branch is a bare NULL takes its type from the other branch.
    -- Leaving any of it implicit produces "structure of query does not
    -- match function result type" — an error that names no column, so it
    -- tells you nothing about which one is wrong. Casting all fifteen
    -- costs nothing and removes the guessing.
    agg.n_stores::int,
    -- Tic-sheet Sales: labour + parts + tires + supplies + discounts.
    -- Groupon is EXCLUDED (migration 25) and returned separately.
    -- Discounts are stored signed and added algebraically.
    (agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts)::numeric,
    agg.t_labor_sales::numeric,
    agg.t_labor_cost::numeric,
    agg.k_parts_cost::numeric,
    agg.k_tire_cost::numeric,
    (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost)::numeric,
    -- Gross profit INCLUDING technician labour cost. The old pre-labour
    -- figure (migration 22) subtracted only parts and tyres; if this
    -- equals that, it is reading the wrong source.
    ((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) - (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost))::numeric,
    (case when (agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) = 0 then null
          else ((agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) - (agg.t_labor_cost + agg.k_parts_cost + agg.k_tire_cost)) / (agg.t_labor_sales + agg.parts + agg.tires + agg.supplies + agg.discounts) end)::numeric,
    agg.k_groupon::numeric,
    agg.k_tire_units::numeric,
    agg.n_days::int,
    -- UNITS per day WITH DATA, never dollars and never per calendar day.
    -- 90 tires over 9 traded days reads 10.0; the same 90 spread over a
    -- 31-day August would read 2.9 and be useless on the 12th.
    (case when agg.n_days = 0 then null
          else agg.k_tire_units::numeric / agg.n_days::numeric end)::numeric,
    agg.k_credit_apps::numeric,
    agg.k_ro_count::numeric
  from agg;
end;
$$;
grant execute on function public.dashboard_range_metrics(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- payroll_to_sales_range  --  body copied VERBATIM from migration 33; 6 scope site(s) filtered.
-- ---------------------------------------------------------------------
create or replace function public.payroll_to_sales_range(d_from date, d_to date, loc uuid default null)
returns table (
  window_start      date,
  window_end        date,
  hours_thru        date,
  sales_thru        date,
  wages_non_tech    numeric,
  wages_tech        numeric,
  wages_total       numeric,
  gross_sales       numeric,
  payroll_to_sales  numeric,
  techs_included    boolean,
  store_count       int
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_techs  boolean;
  v_cut    date;
  v_start  date;
  v_hours  date;
  v_sales  date;
  v_end    date;
  v_non    numeric := 0;
  v_tech   numeric := 0;
  v_gross  numeric := 0;
begin
  if d_from is null or d_to is null or d_from > d_to then
    raise exception 'invalid range % .. %', d_from, d_to using errcode = '22007';
  end if;
  if loc is not null and not public.can_access_location(loc) then
    raise exception 'not authorized for location %', loc using errcode = '42501';
  end if;

  select include_technicians, daily_cutover_date into v_techs, v_cut
    from public.payroll_config where id;

  -- Daily hours begin at the cutover; earlier days cannot contribute.
  v_start := greatest(d_from, v_cut);

  window_start   := v_start;
  techs_included := v_techs;
  select count(*)::int into store_count
    from public.locations l
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc);

  if v_start > d_to then
    window_end := null; hours_thru := null; sales_thru := null;
    wages_non_tech := null; wages_tech := null; wages_total := null;
    gross_sales := null; payroll_to_sales := null;
    return next; return;
  end if;

  select max(pd.work_date) into v_hours
    from public.payroll_daily pd
    join public.employees e on e.id = pd.employee_id
    join public.locations l on l.id = pd.location_id
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
     and not e.is_store_manager
     and pd.work_date >= v_start and pd.work_date <= d_to
     and (pd.hours_worked + pd.hours_worked_other) > 0;

  select greatest(v_hours, max(td.work_date)) into v_hours
    from public.tech_daily td
    join public.locations l on l.id = td.location_id
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
     and td.employee_id is not null
     and td.work_date >= v_start and td.work_date <= d_to
     and td.hours_worked > 0;

  select max(dk.business_date) into v_sales
    from public.daily_kpi dk
    join public.locations l on l.id = dk.location_id
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
     and dk.business_date >= v_start and dk.business_date <= d_to
     and (coalesce(dk.ro_count, 0) <> 0
          or coalesce(dk.sales_parts, 0) <> 0
          or coalesce(dk.sales_tires, 0) <> 0
          or coalesce(dk.sales_supplies, 0) <> 0
          or coalesce(dk.sales_discounts, 0) <> 0);

  -- NOT least(): SQL's LEAST ignores nulls and would return the other
  -- bound, so a side with no data at all would silently not constrain
  -- the window. If either side is empty there is no overlap.
  if v_hours is null or v_sales is null then
    v_end := null;
  else
    v_end := least(v_hours, v_sales);
  end if;

  window_end := v_end;
  hours_thru := v_hours;
  sales_thru := v_sales;

  if v_end is null or v_end < v_start then
    wages_non_tech := null; wages_tech := null; wages_total := null;
    gross_sales := null; payroll_to_sales := null;
    return next; return;
  end if;

  -- ---- non-technician wages, whole-week overtime, pro-rated ---------
  with scope as (
    select l.id from public.locations l
     where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc)
  ),
  wk as (
    select
      pd.employee_id,
      (pd.work_date - (extract(dow from pd.work_date)::int))::date as week_start,
      sum(pd.hours_worked + pd.hours_worked_other)                 as week_hours,
      sum(pd.hours_turned)                                         as week_turned,
      sum((pd.hours_worked + pd.hours_worked_other))
        filter (where pd.work_date >= v_start and pd.work_date <= v_end) as hours_in,
      sum(pd.hours_turned)
        filter (where pd.work_date >= v_start and pd.work_date <= v_end) as turned_in
    from public.payroll_daily pd
    join scope s on s.id = pd.location_id
    join public.employees e on e.id = pd.employee_id
   where not e.is_store_manager
     and pd.work_date >= (v_start - (extract(dow from v_start)::int))
     and pd.work_date <= (v_end + (6 - extract(dow from v_end)::int))
   group by pd.employee_id, (pd.work_date - (extract(dow from pd.work_date)::int))::date
  )
  select coalesce(sum(
    case when wk.week_hours = 0 then 0
         else greatest(
                coalesce(r.hourly_rate, 0) * least(wk.week_hours, 40)
                  + coalesce(r.hourly_rate, 0) * 1.5 * greatest(wk.week_hours - 40, 0),
                coalesce(r.flat_rate_per_hour, 0) * wk.week_turned)
              * (coalesce(wk.hours_in, 0) / wk.week_hours)
    end), 0)
    into v_non
    from wk
    left join public.employee_pay_rates r on r.employee_id = wk.employee_id;

  -- ---- technician wages, from the engine, already whole-week --------
  if v_techs then
    select coalesce(sum(t.labor_cost), 0) into v_tech
      from public._tech_pay_range(v_start, v_end, loc) t;
  else
    v_tech := 0;
  end if;

  -- ---- denominator: the tic sheet's own Sales ------------------------
  select coalesce(sum(
           coalesce(lab.labor, 0) + coalesce(k.sales_parts, 0) + coalesce(k.sales_tires, 0)
           + coalesce(k.sales_supplies, 0) + coalesce(k.sales_discounts, 0)), 0)
    into v_gross
    from public.locations l
    left join public.daily_kpi k
           on k.location_id = l.id and k.business_date >= v_start and k.business_date <= v_end
    left join lateral (
      select sum(td.labor_sales) as labor
        from public.tech_daily td
       where td.location_id = l.id and td.work_date = k.business_date
    ) lab on true
   where public.can_access_location(l.id) and l.is_sandbox = false and (loc is null or l.id = loc);

  wages_non_tech   := v_non;
  wages_tech       := v_tech;
  wages_total      := v_non + v_tech;
  gross_sales      := v_gross;
  payroll_to_sales := case when v_gross = 0 then null else (v_non + v_tech) / v_gross end;
  return next;
end;
$$;
grant execute on function public.payroll_to_sales_range(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- _report_tech_daily  --  body copied VERBATIM from migration 35; 1 scope site(s) filtered.
-- ---------------------------------------------------------------------
create or replace function public._report_tech_daily(
  d_from date,
  d_to   date,
  p_locs uuid[] default null
)
returns table (
  loc_id        uuid,
  d             date,
  hours_worked  numeric,
  flag_hours    numeric,
  labor_sales   numeric,
  guarantee_pay numeric,
  commission    numeric,
  overtime      numeric,
  other_pay     numeric,
  total_pay     numeric
)
language sql stable security definer set search_path = '' as $fn$
  with scope as (
    select l.id
      from public.locations l
     where public.can_access_location(l.id) and l.is_sandbox = false
       and (p_locs is null or l.id = any(p_locs))
  ),
  -- Every day of every WHOLE Sunday–Saturday week the range touches, so
  -- the 40-hour threshold is always evaluated against a complete week
  -- even when the range cuts one in half.
  raw as (
    select
      td.location_id                                                 as l_id,
      td.tech_slot_id                                                as slot,
      td.work_date                                                   as wd,
      (td.work_date - (extract(dow from td.work_date)::int))::date    as wk,
      td.hours_worked                                                as hours,
      td.flag_hours                                                  as flag,
      td.labor_sales                                                 as labor,
      td.hours_worked * coalesce(r.guarantee_rate, 0)                as guar_pay,
      td.flag_hours   * coalesce(r.flat_rate, 0)                     as comm,
      coalesce(r.guarantee_rate, 0)                                  as guar_rate,
      (td.work_date >= d_from and td.work_date <= d_to)              as in_range
    from public.tech_daily td
    join scope s on s.id = td.location_id
    -- The rate of the person who WORKED the day (migration 29), never
    -- of whoever holds the slot today. Reassigning a slot must not
    -- re-cost history.
    left join lateral (
      select pr.flat_rate, pr.guarantee_rate
        from public.tech_pay_rates pr
       where pr.employee_id = td.employee_id
         and pr.effective_date <= td.work_date
       order by pr.effective_date desc
       limit 1
    ) r on true
    where td.work_date >= (d_from - (extract(dow from d_from)::int))
      and td.work_date <= (d_to   + (6 - extract(dow from d_to)::int))
  ),
  per_week as (
    select raw.l_id, raw.slot, raw.wk,
           sum(raw.hours)     as ht,
           sum(raw.guar_pay)  as gt,
           sum(raw.comm)      as ct,
           max(raw.guar_rate) as gr
      from raw
     group by raw.l_id, raw.slot, raw.wk
  ),
  paid as (
    select pw.l_id, pw.slot, pw.wk, pw.ht, pw.gt, pw.ct,
           coalesce(tw.other_pay, 0) as op,
           -- Below 40 hours there is no overtime, by definition. Above
           -- it, the half-time premium rides on whichever basis the
           -- technician is actually being paid on that week.
           case when pw.ht < 40    then 0
                when pw.gt > pw.ct then (pw.ht - 40) * pw.gr * 0.5
                else (pw.ht - 40) * (pw.ct / nullif(pw.ht, 0)) * 0.5
           end as ot
      from per_week pw
      left join public.tech_weekly tw
        on tw.tech_slot_id = pw.slot and tw.week_start = pw.wk
  )
  select
    raw.l_id,
    raw.wd,
    raw.hours,
    raw.flag,
    raw.labor,
    raw.guar_pay,
    raw.comm,
    case when p.ht = 0 then 0 else p.ot * (raw.hours / p.ht) end,
    case when p.ht = 0 then 0 else p.op * (raw.hours / p.ht) end,
    case when p.ht = 0 then 0
         else (greatest(p.gt + p.ot, p.ct) + p.op) * (raw.hours / p.ht) end
  from raw
  join paid p
    on p.l_id = raw.l_id and p.slot = raw.slot and p.wk = raw.wk
  where raw.in_range;
$fn$;

revoke all on function public._report_tech_daily(date, date, uuid[])
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- _report_grain  --  body copied VERBATIM from migration 35; 1 scope site(s) filtered.
-- ---------------------------------------------------------------------
create or replace function public._report_grain(
  d_from date,
  d_to   date,
  p_locs uuid[] default null
)
returns table (loc_id uuid, d date)
language sql stable security definer set search_path = '' as $fn$
  with scope as (
    select l.id
      from public.locations l
     where public.can_access_location(l.id) and l.is_sandbox = false
       and (p_locs is null or l.id = any(p_locs))
  )
  select k.location_id, k.business_date
    from public.daily_kpi k join scope s on s.id = k.location_id
   where k.business_date between d_from and d_to
  union
  select t.location_id, t.work_date
    from public.tech_daily t join scope s on s.id = t.location_id
   where t.work_date between d_from and d_to
  union
  select c.location_id, c.business_date
    from public.cash_drawer_closeouts c join scope s on s.id = c.location_id
   where c.business_date between d_from and d_to;
$fn$;

revoke all on function public._report_grain(date, date, uuid[])
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- _report_store_scalars  --  body copied VERBATIM from migration 36; 1 scope site(s) filtered.
-- ---------------------------------------------------------------------
create or replace function public._report_store_scalars(
  p_year  int,
  p_month int,
  p_locs  uuid[] default null
)
returns table (
  loc_id        uuid,
  days_open     numeric,
  gp_budget     numeric,
  gold_thr      numeric,
  silver_thr    numeric,
  bronze_thr    numeric,
  py_sales      numeric,
  py_gross      numeric,
  py_cars       numeric
)
language sql stable security definer set search_path = '' as $fn$
  select
    l.id,
    coalesce(b.days_open, v.days_open)::numeric,
    coalesce(b.gp_budget, v.gp_target)::numeric,
    b.gold_threshold,
    b.silver_threshold,
    b.bronze_threshold,
    p.sales,
    p.gross_profit,
    p.cars::numeric
  from public.locations l
  left join public.bonus_monthly_targets b
    on b.location_id = l.id and b.plan_year = p_year and b.month = p_month
  left join public.v_store_monthly_gp_target v
    on v.location_id = l.id and v.goal_year = p_year and v.goal_month = p_month
  left join public.prior_year_actuals p
    on p.location_id = l.id and p.year = p_year - 1 and p.month = p_month
 where public.can_access_location(l.id) and l.is_sandbox = false
   and (p_locs is null or l.id = any(p_locs));
$fn$;

revoke all on function public._report_store_scalars(int, int, uuid[])
  from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- report_build  --  body copied VERBATIM from migration 37; 2 scope site(s) filtered.
-- ---------------------------------------------------------------------
create or replace function public.report_build(
  p_from           date,
  p_to             date,
  p_group_by       text,
  p_measures       text[],
  p_locations      uuid[] default null,
  p_split_by_store boolean default false,
  p_max_rows       int     default 5000,
  p_sort_measure   text    default null,
  p_sort_dir       text    default 'desc',
  p_alt_from       date    default null,
  p_alt_to         date    default null,
  p_alt_measures   text[]  default null
)
returns table (
  bucket_key   text,
  bucket_label text,
  bucket_sort  text,
  store_id     uuid,
  store_label  text,
  is_total     boolean,
  measures     jsonb
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_split  boolean;
  v_bad    text;
  v_rows   int;
  v_cap    int;
  v_afrom  date;
  v_ato    date;
  v_gfrom  date;
  v_gto    date;
  v_year   int;
  v_month  int;
  v_alt    text[];
  v_dir    text;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid range % .. %', p_from, p_to using errcode = '22007';
  end if;
  if p_group_by is null
     or p_group_by not in ('day', 'week', 'month', 'store', 'district', 'region') then
    raise exception 'unknown grouping %', coalesce(p_group_by, '(null)') using errcode = '22023';
  end if;
  if p_measures is null or cardinality(p_measures) = 0 then
    raise exception 'no measures requested' using errcode = '22023';
  end if;

  select string_agg(m.k, ', ') into v_bad
    from unnest(p_measures) as m(k)
   where m.k not in (select c.measure_key from public.report_measure_catalog() c);
  if v_bad is not null then
    raise exception 'unknown measure(s): %', v_bad using errcode = '22023';
  end if;

  -- THE RESTRICTION, ENFORCED IN THE QUERY (migration 35, unchanged).
  if coalesce(public.current_user_role(), '') not in ('admin', 'master') then
    select string_agg(c.label, ', ' order by c.sort_order) into v_bad
      from public.report_measure_catalog() c
     where c.restricted and c.measure_key = any(p_measures);
    if v_bad is not null then
      raise exception 'not authorized for measure(s): %', v_bad using errcode = '42501';
    end if;
  end if;

  v_dir := lower(coalesce(p_sort_dir, 'desc'));
  if v_dir not in ('asc', 'desc') then
    raise exception 'sort direction must be asc or desc, got %', p_sort_dir using errcode = '22023';
  end if;
  if p_sort_measure is not null and not (p_sort_measure = any(p_measures)) then
    raise exception 'cannot sort by %, it is not one of the selected measures', p_sort_measure
      using errcode = '22023';
  end if;

  v_alt   := coalesce(p_alt_measures, '{}');
  v_afrom := coalesce(p_alt_from, p_from);
  v_ato   := coalesce(p_alt_to,   p_to);
  if v_afrom > v_ato then
    raise exception 'invalid alternate range % .. %', v_afrom, v_ato using errcode = '22007';
  end if;
  v_gfrom := least(p_from, v_afrom);
  v_gto   := greatest(p_to, v_ato);

  v_year  := extract(year  from p_to)::int;
  v_month := extract(month from p_to)::int;

  v_cap   := least(greatest(coalesce(p_max_rows, 5000), 1), 20000);
  v_split := coalesce(p_split_by_store, false) and p_group_by in ('day', 'week', 'month');

  -- ---- size the answer before computing it (main window only) --------
  if p_group_by in ('store', 'district', 'region') then
    select count(*)::int into v_rows from (
      select distinct
        case p_group_by
          when 'store'    then l.id::text
          when 'district' then coalesce(l.district_id::text, '~unassigned')
          else                 coalesce(dd.region_id::text, '~unassigned')
        end as k
        from public.locations l
        left join public.districts dd on dd.id = l.district_id
       where public.can_access_location(l.id) and l.is_sandbox = false
         and (p_locations is null or l.id = any(p_locations))
    ) q;
  else
    select count(*)::int into v_rows from (
      select distinct
        case p_group_by
          when 'day'  then to_char(g.d, 'YYYY-MM-DD')
          when 'week' then to_char((g.d - (extract(dow from g.d)::int))::date, 'YYYY-MM-DD')
          else             to_char(g.d, 'YYYY-MM')
        end as k,
        case when v_split then g.loc_id else null::uuid end as s
        from public._report_grain(p_from, p_to, p_locations) g
    ) q;
  end if;

  if v_rows > v_cap then
    raise exception
      'That report would return % rows, over the limit of %. Narrow the date range, pick fewer stores, or group by a coarser period.',
      v_rows, v_cap
      using errcode = '54000';
  end if;

  return query
  with scope as (
    select l.id as lid, l.store_number as snum, l.name as sname, l.brand as brnd,
           l.district_id as did, dd.name as dname,
           dd.region_id as rid, rr.name as rname
      from public.locations l
      left join public.districts dd on dd.id = l.district_id
      left join public.regions   rr on rr.id = dd.region_id
     where public.can_access_location(l.id) and l.is_sandbox = false
       and (p_locations is null or l.id = any(p_locations))
  ),
  -- Every month the range touches, so a month grouping gets its own
  -- budget and prior year rather than the last month's.
  months as (
    select extract(year from d)::int as yy, extract(month from d)::int as mm
      from generate_series(date_trunc('month', p_from::timestamp),
                           date_trunc('month', p_to::timestamp),
                           interval '1 month') d
  ),
  scal as (
    select m.yy, m.mm, s.loc_id, s.days_open, s.gp_budget,
           s.gold_thr, s.silver_thr, s.bronze_thr, s.py_sales, s.py_gross, s.py_cars
      from months m
      cross join lateral public._report_store_scalars(m.yy, m.mm, p_locations) s
  ),
  bmap as (
    select g.loc_id as lid, g.d as dd,
      case p_group_by
        when 'day'      then to_char(g.d, 'YYYY-MM-DD')
        when 'week'     then to_char((g.d - (extract(dow from g.d)::int))::date, 'YYYY-MM-DD')
        when 'month'    then to_char(g.d, 'YYYY-MM')
        when 'store'    then s.lid::text
        when 'district' then coalesce(s.did::text, '~unassigned')
        else                 coalesce(s.rid::text, '~unassigned')
      end as bkey,
      case when v_split then g.loc_id else null::uuid end as skey
      from public._report_grain(v_gfrom, v_gto, p_locations) g
      join scope s on s.lid = g.loc_id
  ),
  facts (
    bkey, skey, f_loc, f_date,
    f_ro, f_zdt, f_parts, f_tires, f_supplies, f_disc, f_groupon,
    f_declined, f_capps, f_cdollars, f_cparts, f_ctires, f_entered, f_traded,
    f_hours, f_flag, f_labor, f_guar, f_comm, f_ot, f_other, f_total,
    f_cash, f_checks, f_cards, f_bread, f_sync, f_amfirst, f_koalifi,
    f_snap, f_fleet, f_tireunits, f_alignunits
  ) as (
    select bm.bkey, bm.skey, k.location_id, k.business_date,
      k.ro_count::numeric, k.zero_dollar_tickets::numeric,
      k.sales_parts, k.sales_tires, k.sales_supplies, k.sales_discounts, k.sales_groupon,
      k.declined_sales, k.credit_apps::numeric, k.credit_dollars,
      k.cost_parts, k.cost_tires,
      case when coalesce(k.ro_count, 0)        <> 0
             or coalesce(k.sales_parts, 0)     <> 0
             or coalesce(k.sales_tires, 0)     <> 0
             or coalesce(k.sales_supplies, 0)  <> 0
             or coalesce(k.sales_discounts, 0) <> 0
             or coalesce(k.sales_groupon, 0)   <> 0
           then k.business_date else null::date end,
      -- "Traded" is the tic sheet's PACE rule and the bonus rule: a day
      -- with repair orders. It drives every projection below.
      case when coalesce(k.ro_count, 0) <> 0 then k.business_date else null::date end,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric,
      coalesce((select sum(u.units) from public.daily_service_units u
                 join public.service_categories c on c.id = u.service_category_id
                where u.daily_kpi_id = k.id and c.horizon_key = 'kpi_su_tires'), 0)::numeric,
      coalesce((select sum(u.units) from public.daily_service_units u
                 join public.service_categories c on c.id = u.service_category_id
                where u.daily_kpi_id = k.id and c.horizon_key = 'kpi_su_wheel_alignments'), 0)::numeric
      from public.daily_kpi k
      join bmap bm on bm.lid = k.location_id and bm.dd = k.business_date
    union all
    select bm.bkey, bm.skey, t.loc_id, t.d,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null::date, null::date,
      t.hours_worked, t.flag_hours, t.labor_sales,
      t.guarantee_pay, t.commission, t.overtime, t.other_pay, t.total_pay,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric
      from public._report_tech_daily(v_gfrom, v_gto, p_locations) t
      join bmap bm on bm.lid = t.loc_id and bm.dd = t.d
    union all
    select bm.bkey, bm.skey, c.location_id, c.business_date,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null::date, null::date,
      0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
      c.cash, c.checks, c.cards, c.bread, c.synchrony, c.american_first, c.koalifi, c.snap,
      (select coalesce(sum(case when (e ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
                                then (e ->> 'amount')::numeric else 0 end), 0)
         from jsonb_array_elements(c.fleet) e),
      0::numeric, 0::numeric
      from public.cash_drawer_closeouts c
      join bmap bm on bm.lid = c.location_id and bm.dd = c.business_date
  ),
  -- A row lands in the main window, the alt window, or both.
  long as (
    select f.*, w.win
      from facts f
      cross join lateral (
        select 'main'::text as win where f.f_date between p_from and p_to
        union all
        select 'alt'::text  where f.f_date between v_afrom and v_ato
      ) w
  ),
  -- PER STORE first, so a projection is a store's own and a market's is
  -- the sum of its stores'.
  per_store as (
    select long.bkey, long.skey, long.f_loc as loc, long.win,
           sum(long.f_ro)       as ro,
           sum(long.f_parts)    as parts,
           sum(long.f_tires)    as tires,
           sum(long.f_supplies) as supplies,
           sum(long.f_disc)     as disc,
           sum(long.f_groupon)  as groupon,
           sum(long.f_cparts)   as cparts,
           sum(long.f_ctires)   as ctires,
           sum(long.f_labor)    as labor,
           sum(long.f_total)    as total_pay,
           count(distinct long.f_traded)::numeric as traded_days
      from long
     group by long.bkey, long.skey, long.f_loc, long.win
  ),
  -- Each store's own projection, ready to be summed.
  per_store_proj as (
    select ps.bkey, ps.skey, ps.win,
           public.report_pace(
             (ps.labor + ps.parts + ps.tires + ps.supplies + ps.disc + ps.groupon)
             - (ps.total_pay + ps.cparts + ps.ctires),
             ps.traded_days, sc.days_open)                         as p_gp,
           public.report_pace(
             ps.labor + ps.parts + ps.tires + ps.supplies + ps.disc,
             ps.traded_days, sc.days_open)                         as p_sales
      from per_store ps
      left join scal sc
        on sc.loc_id = ps.loc
       and sc.yy = case when p_group_by = 'month' then split_part(ps.bkey, '-', 1)::int else v_year end
       and sc.mm = case when p_group_by = 'month' then split_part(ps.bkey, '-', 2)::int else v_month end
  ),
  proj as (
    select per_store_proj.bkey, per_store_proj.skey, per_store_proj.win,
           grouping(per_store_proj.bkey) as g_b, grouping(per_store_proj.skey) as g_s,
           sum(per_store_proj.p_gp)    as a_proj_gp,
           sum(per_store_proj.p_sales) as a_proj_sales
      from per_store_proj
     group by grouping sets (
       (per_store_proj.bkey, per_store_proj.skey, per_store_proj.win),
       (per_store_proj.skey, per_store_proj.win),
       (per_store_proj.win)
     )
  ),
  agg as (
    select
      long.bkey as bkey, long.skey as skey, long.win as win,
      grouping(long.bkey) as g_b, grouping(long.skey) as g_s,
      coalesce(sum(long.f_ro), 0)        as a_ro,
      coalesce(sum(long.f_zdt), 0)       as a_zdt,
      coalesce(sum(long.f_parts), 0)     as a_parts,
      coalesce(sum(long.f_tires), 0)     as a_tires,
      coalesce(sum(long.f_supplies), 0)  as a_supplies,
      coalesce(sum(long.f_disc), 0)      as a_disc,
      coalesce(sum(long.f_groupon), 0)   as a_groupon,
      coalesce(sum(long.f_declined), 0)  as a_declined,
      coalesce(sum(long.f_capps), 0)     as a_capps,
      coalesce(sum(long.f_cdollars), 0)  as a_cdollars,
      coalesce(sum(long.f_cparts), 0)    as a_cparts,
      coalesce(sum(long.f_ctires), 0)    as a_ctires,
      count(distinct long.f_entered)::numeric as a_days,
      count(distinct long.f_traded)::numeric  as a_traded,
      coalesce(sum(long.f_hours), 0)     as a_hours,
      coalesce(sum(long.f_flag), 0)      as a_flag,
      coalesce(sum(long.f_labor), 0)     as a_labor,
      coalesce(sum(long.f_guar), 0)      as a_guar,
      coalesce(sum(long.f_comm), 0)      as a_comm,
      coalesce(sum(long.f_ot), 0)        as a_ot,
      coalesce(sum(long.f_other), 0)     as a_other,
      coalesce(sum(long.f_total), 0)     as a_total,
      coalesce(sum(long.f_cash), 0)      as a_cash,
      coalesce(sum(long.f_checks), 0)    as a_checks,
      coalesce(sum(long.f_cards), 0)     as a_cards,
      coalesce(sum(long.f_bread), 0)     as a_bread,
      coalesce(sum(long.f_sync), 0)      as a_sync,
      coalesce(sum(long.f_amfirst), 0)   as a_amfirst,
      coalesce(sum(long.f_koalifi), 0)   as a_koalifi,
      coalesce(sum(long.f_snap), 0)      as a_snap,
      coalesce(sum(long.f_fleet), 0)     as a_fleet,
      coalesce(sum(long.f_tireunits), 0) as a_tireunits,
      coalesce(sum(long.f_alignunits), 0) as a_alignunits
      from long
     group by grouping sets ((long.bkey, long.skey, long.win), (long.skey, long.win), (long.win))
  ),
  -- Which stores belong to which bucket. For store/district/region this
  -- is EVERY store in scope, so a store that reported nothing still gets
  -- a row with its budget on it — a district comparison has to be able
  -- to say "this one sent nothing".
  sloc as (
    select distinct bm.bkey as bkey, bm.skey as skey, bm.lid as lid
      from bmap bm
     where p_group_by in ('day', 'week', 'month')
       and bm.dd between p_from and p_to
    union
    select distinct
      case p_group_by
        when 'store'    then s.lid::text
        when 'district' then coalesce(s.did::text, '~unassigned')
        else                 coalesce(s.rid::text, '~unassigned')
      end,
      null::uuid, s.lid
      from scope s
     where p_group_by in ('store', 'district', 'region')
  ),
  sagg as (
    select sloc.bkey as bkey, sloc.skey as skey,
           grouping(sloc.bkey) as g_b, grouping(sloc.skey) as g_s,
           count(*)::numeric              as n_stores,
           sum(sc.days_open)              as s_days_open,
           sum(sc.gp_budget)              as s_budget,
           sum(sc.gold_thr)               as s_gold,
           sum(sc.silver_thr)             as s_silver,
           sum(sc.bronze_thr)             as s_bronze,
           sum(sc.py_sales)               as s_py_sales,
           sum(sc.py_gross)               as s_py_gross,
           sum(sc.py_cars)                as s_py_cars
      from sloc
      left join scal sc
        on sc.loc_id = sloc.lid
       and sc.yy = case when p_group_by = 'month' then split_part(sloc.bkey, '-', 1)::int else v_year end
       and sc.mm = case when p_group_by = 'month' then split_part(sloc.bkey, '-', 2)::int else v_month end
     group by grouping sets ((sloc.bkey, sloc.skey), (sloc.skey), ())
  ),
  units_long as (
    select bm.bkey as bkey, bm.skey as skey,
           grouping(bm.bkey) as g_b, grouping(bm.skey) as g_s,
           sc.horizon_key as hkey,
           coalesce(sum(dsu.units), 0)::numeric as u
      from public.daily_service_units dsu
      join public.daily_kpi k on k.id = dsu.daily_kpi_id
      join bmap bm on bm.lid = k.location_id and bm.dd = k.business_date
      join public.service_categories sc on sc.id = dsu.service_category_id
     where k.business_date between p_from and p_to
       and (('cat_units_' || sc.horizon_key) = any(p_measures)
         or ('cat_pct_'   || sc.horizon_key) = any(p_measures))
     group by grouping sets (
       (bm.bkey, bm.skey, sc.horizon_key),
       (bm.skey, sc.horizon_key),
       (sc.horizon_key)
     )
  ),
  units_obj as (
    select ul.bkey as bkey, ul.skey as skey, ul.g_b as g_b, ul.g_s as g_s,
           jsonb_object_agg('cat_units_' || ul.hkey, ul.u) as o_units,
           jsonb_object_agg('cat_pct_'   || ul.hkey,
             case when coalesce(a.a_ro, 0) = 0 then null else ul.u / a.a_ro end) as o_pct
      from units_long ul
      join agg a
        on a.win = 'main' and a.g_b = ul.g_b and a.g_s = ul.g_s
       and a.bkey is not distinct from ul.bkey
       and a.skey is not distinct from ul.skey
     group by ul.bkey, ul.skey, ul.g_b, ul.g_s
  ),
  -- A BUCKET WITH NO DATA STILL HAS A BUDGET.
  --
  -- Caught in verification: `agg` is built from facts, so a store or
  -- market that entered nothing produced no row at all, and the report
  -- lost not just its (correctly empty) sales but its GP Budget, its
  -- Gold, Silver and Bronze thresholds and its planned days — none of
  -- which depend on anyone entering anything. With one store currently
  -- carrying data, the Month Total GP report would have rendered 35 of
  -- 36 rows completely blank, which is precisely the report somebody
  -- needs when a store has not reported.
  --
  -- The universe of rows is therefore every bucket that has SCALARS, in
  -- both windows, unioned with every bucket that has facts. `aggu`
  -- coalesces the fact sums to zero once, here, so the measure
  -- expressions below stay readable instead of carrying sixty coalesces.
  universe as (
    select sg.bkey as bkey, sg.skey as skey, sg.g_b as g_b, sg.g_s as g_s, w.win as win
      from sagg sg cross join (values ('main'), ('alt')) as w(win)
    union
    select a.bkey, a.skey, a.g_b, a.g_s, a.win from agg a
  ),
  aggu as (
    select u.bkey as bkey, u.skey as skey, u.win as win, u.g_b as g_b, u.g_s as g_s,
      coalesce(a.a_ro, 0) as a_ro,               coalesce(a.a_zdt, 0) as a_zdt,
      coalesce(a.a_parts, 0) as a_parts,         coalesce(a.a_tires, 0) as a_tires,
      coalesce(a.a_supplies, 0) as a_supplies,   coalesce(a.a_disc, 0) as a_disc,
      coalesce(a.a_groupon, 0) as a_groupon,     coalesce(a.a_declined, 0) as a_declined,
      coalesce(a.a_capps, 0) as a_capps,         coalesce(a.a_cdollars, 0) as a_cdollars,
      coalesce(a.a_cparts, 0) as a_cparts,       coalesce(a.a_ctires, 0) as a_ctires,
      coalesce(a.a_days, 0) as a_days,           coalesce(a.a_traded, 0) as a_traded,
      coalesce(a.a_hours, 0) as a_hours,         coalesce(a.a_flag, 0) as a_flag,
      coalesce(a.a_labor, 0) as a_labor,         coalesce(a.a_guar, 0) as a_guar,
      coalesce(a.a_comm, 0) as a_comm,           coalesce(a.a_ot, 0) as a_ot,
      coalesce(a.a_other, 0) as a_other,         coalesce(a.a_total, 0) as a_total,
      coalesce(a.a_cash, 0) as a_cash,           coalesce(a.a_checks, 0) as a_checks,
      coalesce(a.a_cards, 0) as a_cards,         coalesce(a.a_bread, 0) as a_bread,
      coalesce(a.a_sync, 0) as a_sync,           coalesce(a.a_amfirst, 0) as a_amfirst,
      coalesce(a.a_koalifi, 0) as a_koalifi,     coalesce(a.a_snap, 0) as a_snap,
      coalesce(a.a_fleet, 0) as a_fleet,         coalesce(a.a_tireunits, 0) as a_tireunits,
      coalesce(a.a_alignunits, 0) as a_alignunits
      from universe u
      left join agg a
        on a.win = u.win and a.g_b = u.g_b and a.g_s = u.g_s
       and a.bkey is not distinct from u.bkey
       and a.skey is not distinct from u.skey
  ),
  shaped as (
    select a.bkey as bkey, a.skey as skey, a.win as win, a.g_b as g_b, a.g_s as g_s,
      (
        jsonb_build_object(
          'ro_count',              a.a_ro,
          'zero_dollar_tickets',   a.a_zdt,
          'zero_dollar_pct',       case when a.a_ro = 0 then null else a.a_zdt / a.a_ro end,
          'sales_parts',           a.a_parts,
          'sales_tires',           a.a_tires,
          'sales_supplies',        a.a_supplies,
          'sales_discounts',       a.a_disc,
          'sales_groupon',         a.a_groupon,
          'declined_sales',        a.a_declined,
          'credit_apps',           a.a_capps,
          'credit_dollars',        a.a_cdollars,
          'cost_parts',            a.a_cparts,
          'cost_tires',            a.a_ctires,
          'days_with_data',        a.a_days,
          'days_elapsed',          a.a_traded,
          'tech_hours_worked',     a.a_hours,
          'tech_flag_hours',       a.a_flag,
          'tech_labor_sales',      a.a_labor,
          'tech_labor_cost',       a.a_total,
          'tech_guarantee_pay',    a.a_guar,
          'tech_commission',       a.a_comm,
          'tech_overtime',         a.a_ot,
          'tech_other_pay',        a.a_other,
          'tech_proficiency',      case when a.a_hours = 0 then null else a.a_flag / a.a_hours end,
          'tech_elr',              case when a.a_flag  = 0 then null
                                        else (a.a_labor + 0.5 * a.a_groupon) / a.a_flag end,
          'tech_cost_per_sold_hr', case when a.a_flag  = 0 then null else a.a_total / a.a_flag end,
          'drawer_cash',           a.a_cash,
          'drawer_checks',         a.a_checks,
          'drawer_cards',          a.a_cards,
          'drawer_bread',          a.a_bread,
          'drawer_synchrony',      a.a_sync,
          'drawer_american_first', a.a_amfirst,
          'drawer_koalifi',        a.a_koalifi,
          'drawer_snap',           a.a_snap,
          'drawer_fleet',          a.a_fleet
        )
        ||
        jsonb_build_object(
          'sales',           (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc),
          'total_potential', (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined,
          'capture_rate',
            case when ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) = 0 then null
                 else (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc)
                      / ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) end,
          -- Est / Car is TOTAL POTENTIAL over repair orders, not sales
          -- over cars. With no declined sales recorded, potential IS
          -- sales and the figure would be sales-per-car wearing the
          -- wrong name — so it is NULL, which is what renders blank for
          -- the SpeeDee stores in the sample. FLAGGED for BDC: if
          -- SpeeDee must stay blank even once it records declines, that
          -- is a brand rule and one more condition here.
          'ave_estimate',
            case when a.a_ro = 0 or a.a_declined = 0 then null
                 else ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_declined) / a.a_ro end,
          'gross_sales',   (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon,
          'cost_of_sales', a.a_total + a.a_cparts + a.a_ctires,
          'gross_profit',
            ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
            - (a.a_total + a.a_cparts + a.a_ctires),
          'gross_profit_pct',
            case when ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon) = 0 then null
                 else (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                       - (a.a_total + a.a_cparts + a.a_ctires))
                      / ((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon) end,
          'tires_per_day', case when a.a_days = 0 then null else a.a_tireunits / a.a_days end
        )
        ||
        jsonb_build_object(
          'store_count',    sg.n_stores,
          'days_open',      sg.s_days_open,
          'days_left',      case when sg.s_days_open is null then null
                                 else greatest(sg.s_days_open - (a.a_traded * coalesce(sg.n_stores, 1)), 0) end,
          'gp_budget',      sg.s_budget,
          'projected_gp',   pr.a_proj_gp,
          'projected_sales',pr.a_proj_sales,
          'pct_of_budget',  case when coalesce(sg.s_budget, 0) = 0 then null
                                 else pr.a_proj_gp / sg.s_budget end,
          'cars_per_store',  case when coalesce(sg.n_stores, 0) = 0 then null else a.a_ro / sg.n_stores end,
          'sales_per_store', case when coalesce(sg.n_stores, 0) = 0 then null
                                  else (a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) / sg.n_stores end,
          'gp_per_store',    case when coalesce(sg.n_stores, 0) = 0 then null
                                  else (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                        - (a.a_total + a.a_cparts + a.a_ctires)) / sg.n_stores end,
          'py_sales',        sg.s_py_sales,
          'py_gross_profit', sg.s_py_gross,
          'py_cars',         sg.s_py_cars,
          -- Month-end projection against the FULL prior month: both are
          -- whole-month figures, so no proration is needed or wanted.
          'sales_vs_py',     case when sg.s_py_sales is null then null else pr.a_proj_sales - sg.s_py_sales end,
          'sales_vs_py_pct', case when coalesce(sg.s_py_sales, 0) = 0 then null
                                  else (pr.a_proj_sales - sg.s_py_sales) / sg.s_py_sales end,
          -- Cars per store is MONTH-TO-DATE, so last year is PRORATED to
          -- the same share of the month. Comparing a part-month against
          -- a whole one would show every store collapsing. FLAGGED for
          -- BDC: if the sample compares against the whole prior month
          -- instead, drop the proration factor here.
          -- FIXED in migration 37. When nothing has traded, a_traded is
          -- 0, the proration factor is 0, and this collapsed to 0 - 0 = 0
          -- — a market that reported nothing claiming parity with a real
          -- prior year. The helper returns NULL for that case instead.
          'cars_per_store_vs_py',
            public.report_cars_vs_prior_year(
              a.a_ro, sg.n_stores, sg.s_py_cars, a.a_traded, sg.s_days_open)
        )
        ||
        jsonb_build_object(
          'gp_budget_remaining', case when sg.s_budget is null then null
            else sg.s_budget - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'gp_budget_per_day',   case when sg.s_budget is null then null else
            public.report_remaining_per_day(
              sg.s_budget - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                             - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end,
          'gold_threshold',   sg.s_gold,
          'gold_remaining',   case when sg.s_gold is null then null
            else sg.s_gold - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                              - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'gold_per_day',     case when sg.s_gold is null then null else
            public.report_remaining_per_day(
              sg.s_gold - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                           - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end,
          'silver_threshold', sg.s_silver,
          'silver_remaining', case when sg.s_silver is null then null
            else sg.s_silver - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'silver_per_day',   case when sg.s_silver is null then null else
            public.report_remaining_per_day(
              sg.s_silver - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                             - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end,
          'bronze_threshold', sg.s_bronze,
          'bronze_remaining', case when sg.s_bronze is null then null
            else sg.s_bronze - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                                - (a.a_total + a.a_cparts + a.a_ctires)) end,
          'bronze_per_day',   case when sg.s_bronze is null then null else
            public.report_remaining_per_day(
              sg.s_bronze - (((a.a_labor + a.a_parts + a.a_tires + a.a_supplies + a.a_disc) + a.a_groupon)
                             - (a.a_total + a.a_cparts + a.a_ctires)),
              sg.s_days_open, a.a_traded, sg.n_stores) end
        )
      )
      || coalesce(uo.o_units, '{}'::jsonb)
      || coalesce(uo.o_pct,   '{}'::jsonb) as full_o
      from aggu a
      left join proj pr
        on pr.win = a.win and pr.g_b = a.g_b and pr.g_s = a.g_s
       and pr.bkey is not distinct from a.bkey
       and pr.skey is not distinct from a.skey
      left join sagg sg
        on sg.g_b = a.g_b and sg.g_s = a.g_s
       and sg.bkey is not distinct from a.bkey
       and sg.skey is not distinct from a.skey
      left join units_obj uo
        on a.win = 'main' and uo.g_b = a.g_b and uo.g_s = a.g_s
       and uo.bkey is not distinct from a.bkey
       and uo.skey is not distinct from a.skey
  ),
  -- Main-window values for every measure except those the caller marked
  -- as alt-window, which come from the alt shape instead.
  picked as (
    select m.bkey as bkey, m.skey as skey, m.g_b as g_b, m.g_s as g_s,
      coalesce((select jsonb_object_agg(e.key, e.value)
                  from jsonb_each(m.full_o) e
                 where e.key = any(p_measures) and not (e.key = any(v_alt))), '{}'::jsonb)
      ||
      coalesce((select jsonb_object_agg(e.key, e.value)
                  from jsonb_each(al.full_o) e
                 where e.key = any(v_alt)), '{}'::jsonb) as obj
      from shaped m
      left join shaped al
        on al.win = 'alt' and al.g_b = m.g_b and al.g_s = m.g_s
       and al.bkey is not distinct from m.bkey
       and al.skey is not distinct from m.skey
     where m.win = 'main'
  ),
  keys as (
    select distinct bm.bkey as bkey, bm.skey as skey
      from bmap bm
     where p_group_by in ('day', 'week', 'month')
       and bm.dd between p_from and p_to
    union
    select distinct
      case p_group_by
        when 'store'    then s.lid::text
        when 'district' then coalesce(s.did::text, '~unassigned')
        else                 coalesce(s.rid::text, '~unassigned')
      end,
      null::uuid
      from scope s
     where p_group_by in ('store', 'district', 'region')
  ),
  bmeta as (
    select s.lid::text as bkey,
           '#' || s.snum || ' · ' || s.sname as blabel,
           s.snum as bsort
      from scope s where p_group_by = 'store'
    union all
    select distinct coalesce(s.did::text, '~unassigned'),
           coalesce(s.dname, 'Unassigned'),
           coalesce(s.dname, 'zzzz')
      from scope s where p_group_by = 'district'
    union all
    select distinct coalesce(s.rid::text, '~unassigned'),
           coalesce(s.rname, 'Unassigned'),
           coalesce(s.rname, 'zzzz')
      from scope s where p_group_by = 'region'
  ),
  labelled as (
    select k.bkey as bkey, k.skey as skey,
      case p_group_by
        when 'day'   then to_char(to_date(k.bkey, 'YYYY-MM-DD'), 'MM/DD/YYYY')
        when 'week'  then to_char(to_date(k.bkey, 'YYYY-MM-DD'), 'MM/DD')
                          || ' – ' || to_char(to_date(k.bkey, 'YYYY-MM-DD') + 6, 'MM/DD/YYYY')
        when 'month' then to_char(to_date(k.bkey, 'YYYY-MM'), 'Mon YYYY')
        else bm.blabel
      end as blabel,
      coalesce(bm.bsort, k.bkey) as bsort
      from keys k
      left join bmeta bm on bm.bkey = k.bkey
  ),
  emitted as (
    select l.bkey as o_key, l.blabel as o_label, l.bsort as o_sort,
           l.skey as o_store, sc.sname as o_store_label,
           false as o_total, coalesce(p.obj, '{}'::jsonb) as o_obj
      from labelled l
      left join picked p
        on p.g_b = 0 and p.g_s = 0
       and p.bkey = l.bkey
       and p.skey is not distinct from l.skey
      left join scope sc on sc.lid = l.skey
    union all
    select '~total', 'TOTAL', '~~1', p.skey, sc.sname, true, p.obj
      from picked p
      left join scope sc on sc.lid = p.skey
     where v_split and p.g_b = 1 and p.g_s = 0 and p.skey is not null
    union all
    select '~total', 'TOTAL', '~~2', null::uuid, null::text, true, p.obj
      from picked p
     where p.g_b = 1 and p.g_s = 1
  )
  select e.o_key::text, e.o_label::text, e.o_sort::text,
         e.o_store::uuid, e.o_store_label::text, e.o_total::boolean, e.o_obj::jsonb
    from emitted e
   order by
     e.o_total,
     e.o_store_label nulls first,
     -- The sort IS the message. A row with no value for the sort measure
     -- goes last in both directions: a blank is not a zero and does not
     -- belong at either end of a ranking.
     case when p_sort_measure is not null and v_dir = 'asc'
          then (e.o_obj ->> p_sort_measure)::numeric end asc nulls last,
     case when p_sort_measure is not null and v_dir = 'desc'
          then (e.o_obj ->> p_sort_measure)::numeric end desc nulls last,
     e.o_sort, e.o_key;
end;
$fn$;
grant execute on function public.report_build(
  date, date, text, text[], uuid[], boolean, int, text, text, date, date, text[]
) to authenticated;



-- ---------------------------------------------------------------------
-- 5c. ROW LEVEL SECURITY on the new tables
--     SELECT follows can_access_location (which now hides sandbox rows
--     from store/district/regional by itself).
--     There is deliberately NO write policy on either table: every write
--     goes through a SECURITY DEFINER function in sections 2.1, 3 and 4,
--     which re-checks role and location access itself. Slot allocation
--     decides Horizon addressing, so it must not be reachable straight
--     through the API the way tech_slots was before migration 29.
-- ---------------------------------------------------------------------
alter table public.location_horizon_slots enable row level security;

drop policy if exists "location_horizon_slots_select" on public.location_horizon_slots;
create policy "location_horizon_slots_select" on public.location_horizon_slots
  for select to authenticated
  using (public.can_access_location(location_id));

alter table public.horizon_upload_log enable row level security;

drop policy if exists "horizon_upload_log_select" on public.horizon_upload_log;
create policy "horizon_upload_log_select" on public.horizon_upload_log
  for select to authenticated
  using (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 6. SEED
--
--    Store 2320 IS NOT SEEDED HERE -- it lives in its own file,
--    pgw_horizon_seed_2320_38a.sql, which is now confirmed as
--    "Midas Semoran" and ready. RUN THIS FILE FIRST, THEN 38a: the 38a
--    seed depends on the columns and the slot-provisioning trigger this
--    migration creates.
--    (It was split out because the name was unsettled -- the bonus sheet
--    tab read "Semoran", BDC said "Orlando" -- and a guessed store name
--    is one that fails to match every handout and CSV that follows.)
-- ---------------------------------------------------------------------

-- 6.1 Value Service (sandbox).
--     Its own Horizon credentials, confirmed not shared with any live
--     store. Region and district stay NULL so it cannot roll into
--     Florida -- region is derived through the district join, so a null
--     district yields no region with no workaround needed. No
--     bonus_plans row (that is what "bonus model null" means here) and
--     no goals rows. brand is left at its 'midas' default; the check
--     constraint is not touched.
insert into public.locations (name, is_sandbox, horizon_shop_number, district_id, store_number)
select 'Value Service', true, 'b306006', null::uuid, null::text
where not exists (select 1 from public.locations where name = 'Value Service');

-- Idempotent re-run: make sure the flags are right even if the row
-- pre-existed from a partial run.
update public.locations
   set is_sandbox = true, horizon_shop_number = 'b306006',
       district_id = null, store_number = null
 where name = 'Value Service';

-- 6.2 Store 2322 — Midas Oviedo.
--     Acquired from a non-Midas operator and NEW TO HORIZON ENTIRELY:
--     no prior slot history, so its 20 rows provision empty with
--     ever_used = false and its first technician takes slot 1 from the
--     normal queue. Not part of the Millwood slot collection.
--     horizon_shop_number stays null until credentials are loaded.
--     Name prefix matches the existing convention ('Midas Bush River').
insert into public.locations
  (name, store_number, address, phone, drawer_float, district_id, brand)
select 'Midas Oviedo', '2322',
       '385 West Mitchell Hammock Road, Oviedo, FL 32765',
       '689.399.3918', 200.00,
       (select id from public.districts where name = 'Florida'),
       'midas'
where not exists (select 1 from public.locations where store_number = '2322');

update public.locations
   set name         = 'Midas Oviedo',
       address      = '385 West Mitchell Hammock Road, Oviedo, FL 32765',
       phone        = '689.399.3918',
       drawer_float = 200.00,
       district_id  = (select id from public.districts where name = 'Florida')
 where store_number = '2322';

-- 6.3 Bonus plan — Model A.
insert into public.bonus_plans (location_id, plan_year, model)
select l.id, 2026, 'A' from public.locations l where l.store_number = '2322'
on conflict (location_id, plan_year) do update
  set model = excluded.model, updated_at = now();

-- 6.4 Goals — SEPTEMBER THROUGH DECEMBER 2026 ONLY.
--     This is a FOUR-MONTH set, not an annual one. Both Florida stores
--     expire 2026-12-31 and need new sheets for 2027.
--
--     *** DO NOT CREATE A store_annual_goals ROW FOR THIS STORE. ***
--     v_store_monthly_gp_target is driven by store_annual_goals: it
--     divides gp_target by annual_days_open(2026) and spreads the result
--     across all twelve months. An annual row would therefore invent
--     Jan-Aug targets for a store that was not open. With no annual row
--     the view produces nothing, and _report_store_scalars'
--     coalesce(b.days_open, v.days_open) / coalesce(b.gp_budget, v.gp_target)
--     falls through to these four rows for Sep-Dec and returns null for
--     Jan-Aug, which is correct.
--
--     No loader change is needed. bonus_monthly_targets is keyed
--     (location_id, plan_year, month) and has never required twelve
--     rows; the brief's instruction to "fix the loader if it assumes
--     twelve months" was withdrawn once the audit showed it does not.
--
--     days_open is stored alongside the goals because the PACE row needs
--     it. All four counts agree with derived_days_open(2026, m):
--       Sep 25 (Labor Day), Oct 27, Nov 24 (Thanksgiving), Dec 26
--       (Christmas). Sundays closed.
--     Derived from $928,503 sales / $527,651 GP annualized over the 308
--     days annual_days_open(2026) computes -> $3,014.6201 and $1,713.1526
--     per day. Gold/Silver/Bronze are 95/90/80% of GP budget.
insert into public.bonus_monthly_targets
  (location_id, plan_year, month, days_open, daily_car_goal,
   sales_goal, gp_budget, gold_threshold, silver_threshold, bronze_threshold, last_year_gp)
select l.id, 2026, v.month, v.days_open, v.daily_car_goal,
       v.sales_goal, v.gp_budget, v.gold, v.silver, v.bronze, null::numeric
from (values
  ( 9, 25, 11.0, 75365.50, 42828.81, 40687.37, 38545.93, 34263.05),
  (10, 27, 11.0, 81394.74, 46255.12, 43942.36, 41629.61, 37004.10),
  (11, 24, 11.0, 72350.88, 41115.66, 39059.88, 37004.10, 32892.53),
  (12, 26, 11.0, 78380.12, 44541.97, 42314.87, 40087.77, 35633.57)
) as v(month, days_open, daily_car_goal, sales_goal, gp_budget, gold, silver, bronze)
join public.locations l on l.store_number = '2322'
on conflict (location_id, plan_year, month) do update set
  days_open        = excluded.days_open,
  daily_car_goal   = excluded.daily_car_goal,
  sales_goal       = excluded.sales_goal,
  gp_budget        = excluded.gp_budget,
  gold_threshold   = excluded.gold_threshold,
  silver_threshold = excluded.silver_threshold,
  bronze_threshold = excluded.bronze_threshold,
  last_year_gp     = excluded.last_year_gp;

-- Cars/day goal on the goals strip, same four months. store_monthly_goals
-- is safe without an annual row: v_store_monthly_gp_target is driven by
-- store_annual_goals, so these rows produce no view output on their own.
insert into public.store_monthly_goals (location_id, goal_year, goal_month, days_open_override, cars_per_day_goal)
select l.id, 2026, v.m, v.d, 11.0
from (values (9,25),(10,27),(11,24),(12,26)) as v(m, d)
join public.locations l on l.store_number = '2322'
on conflict (location_id, goal_year, goal_month) do update set
  days_open_override = excluded.days_open_override,
  cars_per_day_goal  = excluded.cars_per_day_goal,
  updated_at         = now();

-- 6.5 Bonus components.
--     The company-wide scalars are ALREADY DATA in bonus_policy from
--     migration 26 and match this brief exactly -- google_per_review 10,
--     google_min_reviews 15, credit_penalty_per_app 75,
--     credit_penalty_floor 35, phone_conversion_waiver 0.40. They are
--     not re-created here.
--     What IS per-store is the incentive scale. These are the standard
--     Model A tiers (identical to Millwood #3303): tires 5/6/7/8 per day
--     at 1250/1500/2000/2500 with each unit above 8 adding 500, and
--     credit apps 50 -> 500, 100 -> 1500. The Silver-GP gate on the
--     credit kicker is bonus math, not data.
insert into public.bonus_incentive_tiers
  (location_id, plan_year, kind, tier_index, threshold, payout, increment_above)
select l.id, 2026, v.kind, v.tier_index, v.threshold, v.payout, v.increment_above
from (values
  ('tire',       1,  5.00, 1250.00, null),
  ('tire',       2,  6.00, 1500.00, null),
  ('tire',       3,  7.00, 2000.00, null),
  ('tire',       4,  8.00, 2500.00, 500.00),
  ('credit_app', 1, 50.00,  500.00, null),
  ('credit_app', 2,100.00, 1500.00, null)
) as v(kind, tier_index, threshold, payout, increment_above)
join public.locations l on l.store_number = '2322'
on conflict (location_id, plan_year, kind, tier_index) do update set
  threshold       = excluded.threshold,
  payout          = excluded.payout,
  increment_above = excluded.increment_above;

-- 6.6 Components that cannot yet be computed.
--     Five-star Google review count is blocked on the Qualtrics feed
--     pending TBC brand-admin approval; phone conversion percentage has
--     no tracking anywhere. Both already exist as nullable columns on
--     bonus_monthly_inputs, where null means "never entered" -- no rows
--     are seeded, on purpose. A zero is a computed result meaning
--     "earned nothing"; displaying one here would understate real payout
--     and a store manager would read it as fact. The UI renders
--     "Pending data source" instead (bonusMath.js).


-- =====================================================================
-- VERIFY  — run in order, in the SQL Editor.
--
--  2) Columns and indexes:
--       select column_name, data_type, is_nullable, column_default
--         from information_schema.columns
--        where table_name = 'locations'
--          and column_name in ('horizon_shop_number','is_sandbox','phone');
--       select indexname from pg_indexes where tablename = 'locations';
--     Expect is_sandbox not null default false, and the two partial
--     unique indexes.
--
--  3) Divested flag: there is none, and none was added. Confirm the only
--     new boolean on locations is is_sandbox:
--       select count(*) from information_schema.columns
--        where table_name='locations' and data_type='boolean';   -- 1
--
--  4) Twenty rows per location, no exceptions:
--       select count(*) from (
--         select location_id from public.location_horizon_slots
--          group by location_id having count(*) <> 20) q;        -- 0
--       select count(*) from public.locations;                   -- n
--       select count(*)/20 from public.location_horizon_slots;   -- n
--
--  5..12) Queue rules. Use a scratch location and a scratch employee set;
--     assign_horizon_slot() requires admin/master and location access.
--       -- 5  never-used before freed
--       --    seed 1..15 occupied, release slot 2, then:
--       --      select public.next_horizon_slot(<loc>);           -- 16
--       -- 6  ascending fill: assign 4 more                       -- 17,18,19,20
--       -- 7  all 20 touched, only 2 free: next assignment        -- 2
--       -- 8  release 5, then 9, then 3; next three assignments   -- 5,9,3
--       --    (release order, NOT numeric order)
--       -- 9  rehire: release 7, assign three new techs, then
--       --    reassign the released technician                    -- a queue
--       --    slot, NOT 7
--       -- 10 full store: all 20 occupied -> assign_horizon_slot() raises
--       --    P0001 'All 20 Horizon slots are occupied...'. Confirm the
--       --    message reaches the UI and is not swallowed.
--       -- 11 duplicate occupancy: assign one technician twice at one
--       --    store -> 23505 'already holds a Horizon slot'.
--       -- 12 new store: insert a test location, then
--       --      select count(*) filter (where ever_used) from
--       --        public.location_horizon_slots where location_id=<new>; -- 0
--       --      select public.next_horizon_slot(<new>);                  -- 1
--
--  13) select store_number, name, is_sandbox, horizon_shop_number
--        from public.locations where is_sandbox;
--      -- Value Service / true / b306006, district_id null.
--
--  14/25) Sandbox excluded from every rollup. Check EACH individually,
--      not as a group. As MASTER, with Value Service carrying data:
--        select store_count from public.dashboard_range_metrics('2026-09-01','2026-09-30');
--        select store_count from public.payroll_to_sales_range('2026-09-01','2026-09-30');
--      Neither may count it. Then confirm all thirteen sites are filtered:
--        select p.proname, count(*)
--          from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname = 'public'
--           and p.prosrc like '%is_sandbox = false%'
--         group by p.proname order by p.proname;
--      Expect: _report_grain 1, _report_store_scalars 1,
--              _report_tech_daily 1, _tech_pay_range 1,
--              dashboard_range_metrics 1, payroll_to_sales_range 6,
--              report_build 2.
--
--  15) Sandbox invisible at the RLS layer, not the UI. Query AS each
--      role (set the JWT, do not just log in and look):
--        select count(*) from public.locations where is_sandbox;
--      store / district / regional -> 0.   admin / master -> 1.
--      Also: select public.can_access_location('<value service id>');
--
--      NOTE for 16-18: the guard returns a verdict rather than raising,
--      so that the log row survives -- an exception would roll back the
--      very record worth auditing. A refusal is still a hard stop
--      because shop_number comes back NULL: there is nothing to transmit
--      to. Check BOTH columns each time.
--
--  16) Guard, forward — a real store cannot go out under b306006. The
--      shop number is not a parameter, so the attempt takes two forms
--      and both fail:
--        update public.locations set horizon_shop_number = 'b306006'
--          where store_number = '3303';        -- 23505, unique index
--        select * from public.horizon_upload_target(
--          (select id from public.locations where store_number='3303'),
--          'b306006');
--        -- shop_number null, authorized false, reason 'mismatch...'
--
--  17) Guard, reverse — Value Service cannot go out under a real shop:
--        select * from public.horizon_upload_target(
--          (select id from public.locations where name='Value Service'),
--          '<a real shop number>');
--        -- shop_number null, authorized false, reason 'mismatch...'
--
--  18) Guard, null — no shop number, no transmit:
--        select * from public.horizon_upload_target(
--          (select id from public.locations where store_number='2322'));
--        -- shop_number null, authorized false,
--        --   reason 'has no Horizon shop number...'
--
--  18b) Every attempt is logged, refusals included. After 16-18:
--        select outcome, shop_number, is_sandbox, detail
--          from public.horizon_upload_log order by attempted_at desc limit 3;
--        -- three 'refused' rows. This is the check that the verdict
--        -- design bought us; a raising guard would show none.
--
--  18c) The happy path still authorizes and logs:
--        update public.locations set horizon_shop_number = 'test999'
--          where store_number = '2322';
--        select * from public.horizon_upload_target(
--          (select id from public.locations where store_number='2322'));
--        -- shop_number 'test999', authorized true, reason null
--        -- then put it back: set horizon_shop_number = null
--
--  19) select store_number, name, address, phone, drawer_float, brand,
--             horizon_shop_number
--        from public.locations where store_number in ('2320','2322');
--      -- 2322 after this file; 2320 ("Midas Semoran") after 38a.
--      -- Both: Florida district, $200 float, midas, shop number null.
--
--  20) Four months, no more, no padding:
--        select month, days_open, daily_car_goal, sales_goal, gp_budget,
--               gold_threshold, silver_threshold, bronze_threshold
--          from public.bonus_monthly_targets
--         where location_id = (select id from public.locations where store_number='2322')
--         order by month;                       -- exactly 9,10,11,12
--
--  22) tech_slots untouched:
--        select min(slot_index), max(slot_index), count(*)
--          from public.tech_slots;              -- 1, 9, unchanged
--      and tech_daily's FK to it still resolves.
--
--  23) Nothing joins the two slot tables:
--        select p.proname from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname='public'
--           and p.prosrc like '%tech_slots%'
--           and p.prosrc like '%location_horizon_slots%';   -- 0 rows
--
--  24) report_build still behaves as migration 37 did. Run a cars-vs-PY
--      report BEFORE applying this migration and again after; the output
--      must be identical. (The body here was copied verbatim from
--      migration 37 with only the predicate added, so the only expected
--      difference is the absence of sandbox rows.)
--
--  27) Jan-Aug is null, not prorated:
--        select * from public.store_annual_goals
--         where location_id = (select id from public.locations where store_number='2322');
--        -- 0 rows, and must stay that way
--        select goal_month, gp_target from public.v_store_monthly_gp_target
--         where location_id = (select id from public.locations where store_number='2322');
--        -- 0 rows
--
--  29/30) employees.active does not touch slots:
--        update public.employees set active = false where id = <occupant>;
--        select current_technician_id from public.location_horizon_slots
--         where current_technician_id = <occupant>;   -- still occupied
--        select * from public.horizon_slots_held_by_inactive
--         where location_id = <loc>;                  -- now lists him
--      The indicator clears only after release_horizon_slot().
-- =====================================================================
