-- =====================================================================
-- PGW Support Portal — Groupon becomes Adjustments; district manager+
--                      edit; re-send flag when it changes after a send
-- Run AFTER pgw_horizon_manager_uploads_47.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- DEPLOY THE horizon-upload EDGE FUNCTION IMMEDIATELY AFTER THIS RUNS:
-- the deployed function still reads daily_kpi.sales_groupon, so review
-- and send fail until the new build (which reads sales_adjustments) is
-- live.
-- =====================================================================
-- 1. RENAME. daily_kpi.sales_groupon -> sales_adjustments. Values carry
--    over untouched. The label is global (every store and the sandbox);
--    there is no per-store label and no store list.
--
--    WHAT DOES NOT CHANGE (decided by the user, 2026-09-17):
--      * Horizon. The value was never its own Horizon field; half of it
--        goes into kpi_sales_labor and half into kpi_sales_parts, as the
--        store workbook's uploader does. Same fields, same values.
--      * Report Builder measure key 'sales_groupon' and the
--        dashboard_range_metrics output column `groupon`. Only the
--        labels a person reads change.
--      * Every formula. Sales still excludes the field; the tic sheet
--        modal's gross profit still adds it; the bonus gross profit
--        still splits it 50/50 across labor and parts.
--    The three functions that read the column are recreated below with
--    `k.sales_groupon` -> `k.sales_adjustments` and, in the measure
--    catalog, "Groupon" -> "Adjustments" in the labels. Nothing else in
--    their bodies changes.
--
-- 2. WHO MAY SET IT. District, regional, admin and master, for a store
--    can_access_location() gives them. Row RLS cannot say this (a store
--    user may write every other column of the same row), so a BEFORE
--    trigger refuses an insert with a non-zero value or an update that
--    changes it. The app sends the whole breakdown on save, so an
--    unchanged value passes. A district or regional manager never
--    reaches the sandbox (can_access_location, migration 38), so only
--    admin and master can set Value Service's.
--    Writes with no signed-in user (the SQL Editor, service_role, the
--    seed and sandbox-copy scripts) are allowed, decided by the user.
--    adjustments_updated_by / _at are stamped by the trigger only.
--
-- 3. RE-SEND FLAG. horizon_upload_log is an attempt log with a month on
--    each row, but nothing held a per store-month status, so
--    horizon_month_status is new, keyed (location_id, month). The same
--    trigger raises needs_resend when the value changes on a day whose
--    month has at least one ACCEPTED send. It keeps the earliest
--    needs_resend_since and takes the latest editor.
--    An AFTER UPDATE trigger on horizon_upload_log clears it when a later
--    send is recorded as accepted -- but only if the last change came
--    BEFORE that send's attempt was opened. The payload is built after
--    the attempt is opened, so a change older than the attempt is in
--    what Horizon received; a newer one may not be, and the flag stays.
--    A failed or refused send never clears it.
--
--    "Accepted" was computed inline in horizon_last_upload(). It is now
--    one function, horizon_send_accepted(), so the "Last sent" line and
--    the flag cannot disagree about what accepted means.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. RENAME + AUDIT COLUMNS
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'daily_kpi'
                and column_name = 'sales_groupon') then
    alter table public.daily_kpi rename column sales_groupon to sales_adjustments;
  end if;
end
$$;

alter table public.daily_kpi
  add column if not exists adjustments_updated_by uuid references auth.users (id),
  add column if not exists adjustments_updated_at timestamptz;

comment on column public.daily_kpi.sales_adjustments is
  'Adjustments (was Groupon). Signed. Not in Sales; in gross profit. Set by district manager or above only (daily_kpi_adjustments_guard).';
comment on column public.daily_kpi.adjustments_updated_by is
  'Who last changed sales_adjustments. Stamped by daily_kpi_adjustments_guard; null when the change had no signed-in user.';
comment on column public.daily_kpi.adjustments_updated_at is
  'When sales_adjustments last changed. Stamped by daily_kpi_adjustments_guard.';


-- ---------------------------------------------------------------------
-- 2. horizon_send_accepted() — the one definition of "accepted"
--    Horizon answers 200 even when it refuses; its refusals start with
--    "Error:" (see the upload protocol notes in migration 43).
-- ---------------------------------------------------------------------
create or replace function public.horizon_send_accepted(p_status int, p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(p_status = 200 and coalesce(p_body, '') !~* '^\s*error', false);
$fn$;


-- ---------------------------------------------------------------------
-- 3. horizon_month_status — one row per store-month that has been flagged
--    Read by anyone who can see the store. No write policy: only the two
--    SECURITY DEFINER triggers below write it.
-- ---------------------------------------------------------------------
create table if not exists public.horizon_month_status (
  location_id          uuid not null references public.locations (id) on delete cascade,
  month                date not null,
  needs_resend         boolean not null default false,
  needs_resend_reason  text,
  needs_resend_since   timestamptz,
  needs_resend_by      uuid references auth.users (id),
  needs_resend_last_at timestamptz,
  cleared_at           timestamptz,
  cleared_by_attempt   bigint references public.horizon_upload_log (id) on delete set null,
  primary key (location_id, month),
  constraint hms_month_is_first check (extract(day from month) = 1)
);

comment on table public.horizon_month_status is
  'Per store-month Horizon state. needs_resend is raised when Adjustments change on a month with an accepted send, and cleared by the next accepted send.';
comment on column public.horizon_month_status.needs_resend_since is
  'First change since the flag was last clear. Kept while the flag stays up.';
comment on column public.horizon_month_status.needs_resend_by is
  'The most recent editor.';
comment on column public.horizon_month_status.needs_resend_last_at is
  'The most recent change (clock time). A send clears the flag only if its attempt was opened after this.';

alter table public.horizon_month_status enable row level security;

drop policy if exists "horizon_month_status_select" on public.horizon_month_status;
create policy "horizon_month_status_select" on public.horizon_month_status
  for select to authenticated
  using (public.can_access_location(location_id));


-- ---------------------------------------------------------------------
-- 4. daily_kpi_adjustments_guard() — permission, audit stamp, flag
--    SECURITY DEFINER because it reads horizon_upload_log (admin-only
--    SELECT) and writes horizon_month_status (no write policy). It
--    decides who may act from auth.uid(), never from the executing role.
-- ---------------------------------------------------------------------
create or replace function public.daily_kpi_adjustments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_role    text;
  v_changed boolean;
  v_month   date;
begin
  if tg_op = 'INSERT' then
    v_changed := new.sales_adjustments is distinct from 0;
  else
    -- Moving a row that carries a value counts as setting it.
    v_changed := new.sales_adjustments is distinct from old.sales_adjustments
      or (new.sales_adjustments <> 0
          and (new.location_id   is distinct from old.location_id
            or new.business_date is distinct from old.business_date));
  end if;

  if not v_changed then
    -- The stamp belongs to this trigger, never to the caller.
    if tg_op = 'INSERT' then
      new.adjustments_updated_by := null;
      new.adjustments_updated_at := null;
    else
      new.adjustments_updated_by := old.adjustments_updated_by;
      new.adjustments_updated_at := old.adjustments_updated_at;
    end if;
    return new;
  end if;

  -- No signed-in user = SQL Editor / service_role / scripts: allowed.
  if v_uid is not null then
    v_role := public.current_user_role();
    if v_role is null
       or v_role not in ('district', 'regional', 'admin', 'master')
       or not public.can_access_location(new.location_id) then
      raise exception 'Adjustments are editable by a district manager or above.'
        using errcode = '42501';
    end if;
  end if;

  new.adjustments_updated_by := v_uid;
  new.adjustments_updated_at := clock_timestamp();

  v_month := date_trunc('month', new.business_date)::date;
  if exists (
    select 1
      from public.horizon_upload_log h
     where h.location_id = new.location_id
       and h.month = v_month
       and h.purpose = 'send'
       and h.response_status is not null
       and public.horizon_send_accepted(h.response_status, h.response_body)
  ) then
    insert into public.horizon_month_status as s
      (location_id, month, needs_resend, needs_resend_reason,
       needs_resend_since, needs_resend_by, needs_resend_last_at)
    values
      (new.location_id, v_month, true, 'Adjustments changed after send',
       new.adjustments_updated_at, v_uid, new.adjustments_updated_at)
    on conflict (location_id, month) do update
       set needs_resend         = true,
           needs_resend_reason  = excluded.needs_resend_reason,
           needs_resend_since   = case when s.needs_resend
                                       then s.needs_resend_since
                                       else excluded.needs_resend_since end,
           needs_resend_by      = excluded.needs_resend_by,
           needs_resend_last_at = excluded.needs_resend_last_at;
  end if;

  return new;
end
$fn$;

drop trigger if exists daily_kpi_adjustments_guard on public.daily_kpi;
create trigger daily_kpi_adjustments_guard
  before insert or update on public.daily_kpi
  for each row execute function public.daily_kpi_adjustments_guard();


-- ---------------------------------------------------------------------
-- 5. horizon_upload_log_clear_resend() — an accepted send clears the flag
--    horizon_record_result() writes the reply exactly once (migration
--    43), so old.response_status is null on that update and only then.
-- ---------------------------------------------------------------------
create or replace function public.horizon_upload_log_clear_resend()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.purpose = 'send'
     and new.month is not null
     and new.response_status is not null
     and old.response_status is null
     and public.horizon_send_accepted(new.response_status, new.response_body) then
    update public.horizon_month_status s
       set needs_resend         = false,
           needs_resend_reason  = null,
           needs_resend_since   = null,
           needs_resend_by      = null,
           needs_resend_last_at = null,
           cleared_at           = now(),
           cleared_by_attempt   = new.id
     where s.location_id = new.location_id
       and s.month = new.month
       and s.needs_resend
       and s.needs_resend_last_at < new.attempted_at;
  end if;
  return null;
end
$fn$;

drop trigger if exists horizon_upload_log_clear_resend on public.horizon_upload_log;
create trigger horizon_upload_log_clear_resend
  after update on public.horizon_upload_log
  for each row execute function public.horizon_upload_log_clear_resend();


-- ---------------------------------------------------------------------
-- 6. horizon_last_upload() — migration 47's body, with "accepted" now
--    read from horizon_send_accepted(). Same signature, same result.
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
         public.horizon_send_accepted(h.response_status, h.response_body),
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


-- ---------------------------------------------------------------------
-- 7. horizon_month_resend_status() — what the tic sheet shows
--    Anyone who can see the store sees its flag (the store may be the
--    one who re-sends). changed_days are the days whose Adjustments
--    changed after the month's latest accepted send was opened.
--    changed_by is a name, because store users cannot read other
--    profiles.
-- ---------------------------------------------------------------------
create or replace function public.horizon_month_resend_status(p_location_id uuid, p_month date)
returns table (needs_resend boolean, reason text, since timestamptz,
               last_changed_at timestamptz, changed_by text, changed_days date[])
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_month date := date_trunc('month', p_month)::date;
begin
  if not public.can_access_location(p_location_id) then
    raise exception 'You do not have access to this store.' using errcode = '42501';
  end if;

  return query
  select s.needs_resend,
         s.needs_resend_reason,
         s.needs_resend_since,
         s.needs_resend_last_at,
         case when s.needs_resend_by is null then null
              else coalesce(nullif(p.full_name, ''), p.email, 'unknown') end,
         coalesce((
           select array_agg(k.business_date order by k.business_date)
             from public.daily_kpi k
            where k.location_id = p_location_id
              and k.business_date >= v_month
              and k.business_date <  (v_month + interval '1 month')::date
              and k.adjustments_updated_at > coalesce((
                    select max(h.attempted_at)
                      from public.horizon_upload_log h
                     where h.location_id = p_location_id
                       and h.month = v_month
                       and h.purpose = 'send'
                       and public.horizon_send_accepted(h.response_status, h.response_body)
                  ), 'infinity'::timestamptz)
         ), '{}'::date[])
    from public.horizon_month_status s
    left join public.profiles p on p.id = s.needs_resend_by
   where s.location_id = p_location_id
     and s.month = v_month
     and s.needs_resend;
end
$fn$;

revoke all on function public.horizon_month_resend_status(uuid, date) from public, anon;
grant execute on function public.horizon_month_resend_status(uuid, date) to authenticated;


-- ---------------------------------------------------------------------
-- 8. FUNCTIONS THAT READ THE RENAMED COLUMN — recreated
--    Bodies copied from their latest migrations. Changes: `k.sales_groupon`
--    -> `k.sales_adjustments`; catalog labels "Groupon" -> "Adjustments".
-- ---------------------------------------------------------------------

-- 8a. dashboard_range_metrics -- from migration 38 (column reference only).
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
        or coalesce(k.sales_adjustments, 0) <> 0
  ),
  kpi as (
    select
      coalesce(sum(k.sales_parts), 0)     as parts,
      coalesce(sum(k.sales_tires), 0)     as tires,
      coalesce(sum(k.sales_supplies), 0)  as supplies,
      coalesce(sum(k.sales_adjustments), 0)   as k_groupon,
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


-- 8b. report_measure_catalog -- from migration 36 (labels only; keys unchanged).
create or replace function public.report_measure_catalog()
returns table (
  measure_key   text,
  label         text,
  group_label   text,
  kind          text,
  restricted    boolean,
  sort_order    int
)
language sql stable security definer set search_path = '' as $fn$
  with static_measures(measure_key, label, group_label, kind, restricted, sort_order) as (
    values
      -- Tic sheet — summary ------------------------------------------
      ('ro_count',              'Repair Orders',               'Tic sheet — summary', 'int',   false,  100),
      ('sales',                 'Sales (excl. Adjustments)',       'Tic sheet — summary', 'money', false,  110),
      ('declined_sales',        'Declined',                    'Tic sheet — summary', 'money', false,  120),
      ('total_potential',       'Total Potential',             'Tic sheet — summary', 'money', false,  130),
      ('capture_rate',          'Sales Capture Rate',          'Tic sheet — summary', 'ratio', false,  140),
      ('ave_estimate',          'Est / Car',                   'Tic sheet — summary', 'money', false,  150),
      ('zero_dollar_tickets',   'Zero Dollar Tickets',         'Tic sheet — summary', 'int',   false,  160),
      ('zero_dollar_pct',       'Zero Dollar Tickets % of ROs','Tic sheet — summary', 'ratio', false,  170),
      ('credit_apps',           'Credit Apps',                 'Tic sheet — summary', 'int',   false,  180),
      ('credit_dollars',        'Credit $',                    'Tic sheet — summary', 'money', false,  190),
      ('days_with_data',        'Days Entered (any data)',     'Tic sheet — summary', 'int',   false,  200),
      ('days_elapsed',          'Days Traded (ROs)',           'Tic sheet — summary', 'int',   false,  205),
      ('tires_per_day',         'Tires per Day',               'Tic sheet — summary', 'num',   false,  210),
      -- Tic sheet — sales breakdown ----------------------------------
      ('tech_labor_sales',      'Labor Sales',                 'Tic sheet — sales breakdown', 'money', false, 300),
      ('sales_parts',           'Parts Sales',                 'Tic sheet — sales breakdown', 'money', false, 310),
      ('sales_tires',           'Tire Sales',                  'Tic sheet — sales breakdown', 'money', false, 320),
      ('sales_supplies',        'Supplies',                    'Tic sheet — sales breakdown', 'money', false, 330),
      ('sales_discounts',       'Discounts',                   'Tic sheet — sales breakdown', 'money', false, 340),
      ('sales_groupon',         'Adjustments',                     'Tic sheet — sales breakdown', 'money', false, 350),
      -- Gross profit -------------------------------------------------
      ('gross_sales',           'Gross Sales (incl. Adjustments)', 'Gross profit', 'money', false, 400),
      ('cost_parts',            'Parts Cost',                  'Gross profit', 'money', false, 410),
      ('cost_tires',            'Tire Cost',                   'Gross profit', 'money', false, 420),
      ('tech_labor_cost',       'Labor Cost',                  'Gross profit', 'money', false, 430),
      ('cost_of_sales',         'Cost of Sales',               'Gross profit', 'money', false, 440),
      ('gross_profit',          'Gross Profit (incl. Adjustments)','Gross profit', 'money', false, 450),
      ('gross_profit_pct',      'Gross Profit % (incl. Adjustments)','Gross profit','ratio',false, 460),
      -- Projection & budget ------------------------------------------
      ('days_open',             'Days Open (planned)',         'Projection & budget', 'num',   false, 470),
      ('days_left',             'Days Left',                   'Projection & budget', 'num',   false, 472),
      ('projected_gp',          'Projected Monthly GP',        'Projection & budget', 'money', false, 474),
      ('projected_sales',       'Sales Projection',            'Projection & budget', 'money', false, 476),
      ('gp_budget',             'GP Budget',                   'Projection & budget', 'money', false, 478),
      ('pct_of_budget',         '% of Budget',                 'Projection & budget', 'ratio', false, 480),
      ('gp_budget_remaining',   'Budget Remaining',            'Projection & budget', 'money', false, 482),
      ('gp_budget_per_day',     'Budget Per Day',              'Projection & budget', 'money', false, 484),
      -- Per store (market roll-ups) ----------------------------------
      ('store_count',           'Stores',                      'Per store', 'int',   false, 486),
      ('cars_per_store',        'Cars per Store',              'Per store', 'num',   false, 488),
      ('sales_per_store',       'Sales per Store',             'Per store', 'money', false, 490),
      ('gp_per_store',          'GP per Store',                'Per store', 'money', false, 492),
      -- Prior year ---------------------------------------------------
      ('py_sales',              'Sales Last Year',             'Prior year', 'money', false, 494),
      ('py_gross_profit',       'GP Last Year',                'Prior year', 'money', false, 495),
      ('py_cars',               'Cars Last Year',              'Prior year', 'int',   false, 496),
      ('sales_vs_py',           'vs Last Year ($)',            'Prior year', 'money', false, 497),
      ('sales_vs_py_pct',       'vs Last Year (%)',            'Prior year', 'ratio', false, 498),
      ('cars_per_store_vs_py',  'Cars per Store vs Last Year', 'Prior year', 'num',   false, 499),
      -- Bonus tiers --------------------------------------------------
      ('gold_threshold',        'Gold',                        'Bonus tiers', 'money', false, 900),
      ('gold_remaining',        'Gold Remaining',              'Bonus tiers', 'money', false, 901),
      ('gold_per_day',          'Gold Per Day',                'Bonus tiers', 'money', false, 902),
      ('silver_threshold',      'Silver',                      'Bonus tiers', 'money', false, 903),
      ('silver_remaining',      'Silver Remaining',            'Bonus tiers', 'money', false, 904),
      ('silver_per_day',        'Silver Per Day',              'Bonus tiers', 'money', false, 905),
      ('bronze_threshold',      'Bronze',                      'Bonus tiers', 'money', false, 906),
      ('bronze_remaining',      'Bronze Remaining',            'Bonus tiers', 'money', false, 907),
      ('bronze_per_day',        'Bronze Per Day',              'Bonus tiers', 'money', false, 908),
      -- Technician — operations --------------------------------------
      ('tech_hours_worked',     'Hours Worked',                'Technician — operations', 'hours', false, 500),
      ('tech_flag_hours',       'Flag Hours',                  'Technician — operations', 'hours', false, 510),
      ('tech_proficiency',      'Proficiency',                 'Technician — operations', 'ratio', false, 520),
      ('tech_elr',              'Effective Labor Rate',        'Technician — operations', 'rate',  false, 530),
      ('tech_cost_per_sold_hr', 'Ave Tech Cost / Sold Hour',   'Technician — operations', 'rate',  false, 540),
      -- Technician — pay breakdown (admin/master only) ---------------
      ('tech_guarantee_pay',    'Guarantee Pay',               'Technician — pay breakdown', 'money', true, 600),
      ('tech_commission',       'Commission',                  'Technician — pay breakdown', 'money', true, 610),
      ('tech_overtime',         'Overtime',                    'Technician — pay breakdown', 'money', true, 620),
      ('tech_other_pay',        'Other Pay',                   'Technician — pay breakdown', 'money', true, 630),
      -- Cash drawer — tenders ----------------------------------------
      ('drawer_cash',           'Cash',                        'Cash drawer — tenders', 'money', false, 700),
      ('drawer_checks',         'Customer Checks',             'Cash drawer — tenders', 'money', false, 710),
      ('drawer_cards',          'Visa / Disc / Amex / Debit / MC', 'Cash drawer — tenders', 'money', false, 720),
      ('drawer_bread',          'Midas CC (Bread)',            'Cash drawer — tenders', 'money', false, 730),
      ('drawer_synchrony',      'Sync Car Care',               'Cash drawer — tenders', 'money', false, 740),
      ('drawer_american_first', 'American First',              'Cash drawer — tenders', 'money', false, 750),
      ('drawer_koalifi',        'Koalifi',                     'Cash drawer — tenders', 'money', false, 760),
      ('drawer_snap',           'Snap',                        'Cash drawer — tenders', 'money', false, 770),
      ('drawer_fleet',          'Charges / Fleet Invoices',    'Cash drawer — tenders', 'money', false, 780)
  ),
  cats as (
    select sc.horizon_key as hkey, sc.display_name as dname, min(bsc.display_order) as ord
      from public.service_categories sc
      join public.brand_service_categories bsc
        on bsc.service_category_id = sc.id and bsc.active
     group by sc.horizon_key, sc.display_name
  )
  select sm.measure_key, sm.label, sm.group_label, sm.kind, sm.restricted, sm.sort_order
    from static_measures sm
  union all
  select 'cat_units_' || cats.hkey, cats.dname,
         'Tic sheet — categories (units)', 'int', false, 1000 + cats.ord
    from cats
  union all
  select 'cat_pct_' || cats.hkey, cats.dname || ' — % of cars',
         'Tic sheet — categories (% of cars)', 'ratio', false, 2000 + cats.ord
    from cats;
$fn$;
grant execute on function public.report_measure_catalog() to authenticated;


-- 8c. report_build -- from migration 38 (column reference only).
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
      k.sales_parts, k.sales_tires, k.sales_supplies, k.sales_discounts, k.sales_adjustments,
      k.declined_sales, k.credit_apps::numeric, k.credit_dollars,
      k.cost_parts, k.cost_tires,
      case when coalesce(k.ro_count, 0)        <> 0
             or coalesce(k.sales_parts, 0)     <> 0
             or coalesce(k.sales_tires, 0)     <> 0
             or coalesce(k.sales_supplies, 0)  <> 0
             or coalesce(k.sales_discounts, 0) <> 0
             or coalesce(k.sales_adjustments, 0)   <> 0
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



-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The column is renamed and stamped (sales_adjustments,
--      adjustments_updated_at, adjustments_updated_by; no sales_groupon):
--        select column_name from information_schema.columns
--         where table_name = 'daily_kpi'
--           and (column_name like '%adjust%' or column_name like '%groupon%');
--
--  [2] Values carried over. Value Service 7/1 (the brief's fixture):
--        select k.sales_adjustments from public.daily_kpi k
--          join public.locations l on l.id = k.location_id
--         where l.is_sandbox and k.business_date = '2026-07-01';
--
--  [3] No function still names the old column (0):
--        select count(*) from pg_proc
--         where pronamespace = 'public'::regnamespace
--           and prosrc like '%sales_groupon%' and prosrc like '%k.sales_groupon%';
--
--  [4] Catalog labels (5 rows, none saying Groupon):
--        select measure_key, label from public.report_measure_catalog()
--         where label ilike '%adjust%' or label ilike '%groupon%';
--
--  [5] Both triggers exist:
--        select tgname from pg_trigger
--         where tgname in ('daily_kpi_adjustments_guard', 'horizon_upload_log_clear_resend');
--
--  THEN deploy the Edge Function:
--    npx supabase functions deploy horizon-upload --project-ref ledmjsfjhvlwjyxjhlyi --no-verify-jwt --use-api
-- =====================================================================
