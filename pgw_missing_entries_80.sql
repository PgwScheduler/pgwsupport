-- =====================================================================
-- PGW Support Portal — Missing tic sheet entry alerts (migration 80)
-- Run AFTER pgw_all_celebrations_79.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- WHY: every scorecard, the bonus tracker and Tech Ranks read the daily
-- tic sheet (daily_kpi), and nothing checked that stores fill it in.
-- This adds:
--
--   1. missing_entry_config   one-row switch for the morning email.
--                             email_enabled starts OFF: turn it on once
--                             stores are actually entering daily, or
--                             every DM gets every store, every morning.
--   2. tic_day_entered()      THE definition of "entered", used by both
--                             the panel and the email.
--   3. tic_working_days()     the last N working days before a date
--                             (Mon-Sat, not a holiday -- the same rule as
--                             derived_days_open() and lib/workdays.js).
--   4. tic_entry_status()     the dashboard panel: every store the caller
--                             may see x the last N working days.
--   5. missing_entry_digest() one row per recipient with the stores they
--                             manage that missed the last working day.
--                             service_role ONLY -- it reads every
--                             manager's email address and every store.
--   6. missing_entry_email_log what was sent, to whom, and Resend's id;
--                             also stops a second send for the same day.
--
-- DECISIONS (change here if they are wrong):
--   * "Entered" = cars (ro_count) > 0, or any labor / parts / tire sales.
--     A row with only zeros is NOT entered: the tic sheet inserts an
--     empty row as soon as someone tabs into a day.
--   * "Yesterday" = the last working day before today, Eastern time
--     (every store is Eastern). Monday morning checks Saturday. Sundays
--     and the holidays table are never "missing".
--   * The Home Office and the sandbox are never checked.
--   * Recipients = district managers (their district) and regional
--     managers (their region), by default. Add 'master' to
--     recipient_roles for a company-wide copy.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. CONFIG
-- ---------------------------------------------------------------------
create table if not exists public.missing_entry_config (
  id              boolean primary key default true check (id),
  email_enabled   boolean  not null default false,
  send_hour_et    smallint not null default 8 check (send_hour_et between 5 and 11),
  recipient_roles text[]   not null default '{district,regional}'
                  check (recipient_roles <@ array['district','regional','admin','master']::text[]),
  updated_at      timestamptz not null default now()
);

insert into public.missing_entry_config (id) values (true) on conflict (id) do nothing;

alter table public.missing_entry_config enable row level security;

drop policy if exists "missing_entry_config_select" on public.missing_entry_config;
create policy "missing_entry_config_select" on public.missing_entry_config
  for select to authenticated using (true);

drop policy if exists "missing_entry_config_master_write" on public.missing_entry_config;
create policy "missing_entry_config_master_write" on public.missing_entry_config
  for update to authenticated
  using (public.current_user_role() = 'master')
  with check (public.current_user_role() = 'master');

comment on table public.missing_entry_config is
  'Single-row switch for the morning missing-tic-sheet email (migration 80). email_enabled starts false. Turn on: update public.missing_entry_config set email_enabled = true, updated_at = now() where id;';


-- ---------------------------------------------------------------------
-- 2. WHAT "ENTERED" MEANS -- one place, used by sections 4 and 5
-- ---------------------------------------------------------------------
create or replace function public.tic_day_entered(
  p_ro_count int, p_labor numeric, p_parts numeric, p_tires numeric)
returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_ro_count, 0) > 0
      or coalesce(p_labor, 0) <> 0
      or coalesce(p_parts, 0) <> 0
      or coalesce(p_tires, 0) <> 0;
$$;

comment on function public.tic_day_entered(int, numeric, numeric, numeric) is
  'Migration 80: a tic sheet day counts as entered when it has cars or any labor/parts/tire sales. An all-zero row (created by tabbing into a day) does not.';


-- ---------------------------------------------------------------------
-- 3. WORKING DAYS -- the last p_days working days strictly before p_before
-- ---------------------------------------------------------------------
create or replace function public.tic_working_days(p_before date, p_days int)
returns table (business_date date)
language sql stable set search_path = '' as $$
  select d::date
    from generate_series(p_before - 1, p_before - (p_days * 2 + 14), interval '-1 day') as g(d)
   where extract(dow from d) <> 0
     and not exists (select 1 from public.holidays h where h.holiday_date = d::date)
   order by d desc
   limit greatest(p_days, 0);
$$;

comment on function public.tic_working_days(date, int) is
  'Migration 80: the last p_days working days (Mon-Sat, not in holidays) strictly before p_before, newest first.';

-- Today in Eastern time: the business date the stores are living in.
create or replace function public.pgw_today()
returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'America/New_York')::date;
$$;


-- ---------------------------------------------------------------------
-- 4. THE PANEL -- every store the caller may see x the last p_days
--    working days. One row per store per day.
--    last_entered: the newest entered day ever, so a store that stopped
--    weeks ago says so instead of just showing seven red dots.
-- ---------------------------------------------------------------------
create or replace function public.tic_entry_status(
  p_days  int  default 7,
  p_as_of date default null)
returns table (
  location_id   uuid,
  store_number  text,
  store_name    text,
  district_name text,
  region_name   text,
  business_date date,
  entered       boolean,
  ro_count      int,
  last_entered  date
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_office_prev text := current_setting('pgw.office_read', true);  -- migration 78 pattern
  v_as_of date := coalesce(p_as_of, public.pgw_today());
begin
  perform set_config('pgw.office_read', 'on', true);  -- office may read, for this call only
  if p_days is null or p_days < 1 or p_days > 31 then
    raise exception 'p_days must be 1..31' using errcode = '22023';
  end if;

  return query
  with days as (
    select w.business_date from public.tic_working_days(v_as_of, p_days) w
  ),
  stores as (
    select l.id, l.store_number::text as store_number, l.name,
           d.name as district_name, r.name as region_name
      from public.locations l
      left join public.districts d on d.id = l.district_id
      left join public.regions   r on r.id = d.region_id
     where not l.is_sandbox
       and not l.is_home_office
       and public.can_access_location(l.id)
  )
  select s.id, s.store_number, s.name, s.district_name, s.region_name,
         dy.business_date,
         coalesce(public.tic_day_entered(k.ro_count, k.sales_labor, k.sales_parts, k.sales_tires), false),
         coalesce(k.ro_count, 0),
         (select max(k2.business_date)
            from public.daily_kpi k2
           where k2.location_id = s.id
             and k2.business_date < v_as_of
             and public.tic_day_entered(k2.ro_count, k2.sales_labor, k2.sales_parts, k2.sales_tires))
    from stores s
    cross join days dy
    left join public.daily_kpi k
      on k.location_id = s.id and k.business_date = dy.business_date
   order by s.store_number, dy.business_date desc;

  perform set_config('pgw.office_read', coalesce(v_office_prev, ''), true);
end
$fn$;

comment on function public.tic_entry_status(int, date) is
  'Migration 80: tic sheet entry status for every store the caller can see (sandbox + Home Office excluded) over the last p_days working days before p_as_of (default today, Eastern).';

revoke all on function public.tic_entry_status(int, date) from public, anon;
grant execute on function public.tic_entry_status(int, date) to authenticated;


-- ---------------------------------------------------------------------
-- 5. THE EMAIL DIGEST -- service_role only.
--    One row per recipient (role in config.recipient_roles, email set),
--    with the stores in their scope that missed the last working day.
--    Every recipient comes back, including ones with nothing missing;
--    the Edge Function decides not to email those.
-- ---------------------------------------------------------------------
create or replace function public.missing_entry_digest(p_as_of date default null)
returns table (
  recipient_id  uuid,
  email         text,
  full_name     text,
  role          text,
  scope_name    text,
  business_date date,
  store_count   int,
  missing       jsonb
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_as_of date := coalesce(p_as_of, public.pgw_today());
  v_day   date;
  v_roles text[];
begin
  select w.business_date into v_day from public.tic_working_days(v_as_of, 1) w;
  select c.recipient_roles into v_roles from public.missing_entry_config c;

  return query
  with stores as (
    select l.id, l.store_number::text as store_number, l.name, l.district_id,
           d.name as district_name, d.region_id
      from public.locations l
      left join public.districts d on d.id = l.district_id
     where not l.is_sandbox and not l.is_home_office
  ),
  missed as (
    select s.*,
           (select max(k2.business_date) from public.daily_kpi k2
             where k2.location_id = s.id and k2.business_date < v_as_of
               and public.tic_day_entered(k2.ro_count, k2.sales_labor, k2.sales_parts, k2.sales_tires)) as last_entered
      from stores s
     where not exists (
       select 1 from public.daily_kpi k
        where k.location_id = s.id and k.business_date = v_day
          and public.tic_day_entered(k.ro_count, k.sales_labor, k.sales_parts, k.sales_tires))
  ),
  recips as (
    select p.id, p.email, p.full_name, p.role, p.district_id, p.region_id,
           case p.role
             when 'district' then (select d.name from public.districts d where d.id = p.district_id)
             when 'regional' then (select r.name from public.regions r where r.id = p.region_id)
             else 'All stores'
           end as scope_name
      from public.profiles p
     where p.role = any (coalesce(v_roles, '{}'))
       and nullif(trim(p.email), '') is not null
       -- A DM/RM with no district/region would get nothing; skip them.
       and (p.role in ('admin','master')
            or (p.role = 'district' and p.district_id is not null)
            or (p.role = 'regional' and p.region_id is not null))
  )
  select rc.id, rc.email, rc.full_name, rc.role, rc.scope_name, v_day,
         count(m.id)::int,
         coalesce(jsonb_agg(jsonb_build_object(
                    'location_id',  m.id,
                    'store_number', m.store_number,
                    'store_name',   m.name,
                    'district_name', m.district_name,
                    'last_entered', m.last_entered,
                    -- working days missed in a row, ending at v_day (capped at 31)
                    'days_missed', (select count(*) from public.tic_working_days(v_as_of, 31) w
                                     where m.last_entered is null or w.business_date > m.last_entered))
                  order by m.store_number) filter (where m.id is not null), '[]'::jsonb)
    from recips rc
    left join missed m
      on (rc.role in ('admin','master'))
      or (rc.role = 'district' and m.district_id = rc.district_id)
      or (rc.role = 'regional' and m.region_id  = rc.region_id)
   group by rc.id, rc.email, rc.full_name, rc.role, rc.scope_name
   order by rc.role, rc.scope_name, rc.email;
end
$fn$;

comment on function public.missing_entry_digest(date) is
  'Migration 80: per-recipient list of stores that missed the last working day before p_as_of. service_role only (Edge Function missing-entry-alerts).';

-- `revoke ... from public` alone is a no-op on Supabase: anon and
-- authenticated hold their own direct grants. Name them.
revoke all on function public.missing_entry_digest(date) from public, anon, authenticated;
grant execute on function public.missing_entry_digest(date) to service_role;


-- ---------------------------------------------------------------------
-- 6. SEND LOG -- written by the Edge Function (service_role).
--    One 'sent' row per recipient per business day: a re-run of the
--    morning job (cron retry, DST double-fire) cannot email twice.
-- ---------------------------------------------------------------------
create table if not exists public.missing_entry_email_log (
  id            bigint generated always as identity primary key,
  business_date date        not null,
  recipient_id  uuid        references public.profiles (id) on delete set null,
  email         text        not null,
  store_count   int         not null,
  status        text        not null check (status in ('sent','failed','test')),
  resend_id     text,
  error         text,
  created_at    timestamptz not null default now()
);

create unique index if not exists missing_entry_email_log_once
  on public.missing_entry_email_log (business_date, recipient_id)
  where status = 'sent';

alter table public.missing_entry_email_log enable row level security;

drop policy if exists "missing_entry_email_log_master_select" on public.missing_entry_email_log;
create policy "missing_entry_email_log_master_select" on public.missing_entry_email_log
  for select to authenticated
  using (public.current_user_role() in ('admin','master'));

comment on table public.missing_entry_email_log is
  'Migration 80: every missing-entry email attempt. Written only by the Edge Function (service_role); admin/master may read.';


notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
-- VERIFY (run after; each should return rows / true)
-- ---------------------------------------------------------------------
-- select * from public.missing_entry_config;                         -- email_enabled = false
-- select * from public.tic_working_days(date '2026-10-12', 3);       -- 10-10 (Sat), 10-09, 10-08
-- select public.tic_day_entered(0, 0, 0, 0), public.tic_day_entered(5, 0, 0, 0);  -- false, true
-- select count(*) from public.missing_entry_digest();                -- one row per DM/RM with an email
