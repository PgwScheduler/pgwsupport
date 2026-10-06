-- =====================================================================
-- Migration 75 — Tech Ranks: managers are not ranked
--
-- User decision 2026-10-01: take managers out of the Tech Ranks report.
-- Recreates tech_ranks() from migration 74 with ONE change: the ranked
-- people exclude anyone whose employees.position is 'manager'. Service
-- advisors ('front') who turned hours stay in -- only managers were
-- asked to go.
--
-- It is the person's position TODAY, not on the day worked (the portal
-- keeps no position history): a tech later promoted to manager drops
-- out of past periods too.
--
-- At the time of writing it changes no live result: none of the 37
-- portal managers, and none of the 36 store managers on the September
-- roster, have Tech Tracker hours under their own name.
--
-- Everything else -- access (district and above, company-wide),
-- Midas-only scope, the store a tech is ranked under, the output shape
-- -- is unchanged. Safe to re-run.
-- =====================================================================

create or replace function public.tech_ranks(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_role text := public.current_user_role();
  v_out  jsonb;
begin
  if v_role is null or v_role not in ('district', 'regional', 'admin', 'master') then
    raise exception 'Tech Ranks is available to district managers and above.'
      using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid range % .. %', p_from, p_to using errcode = '22007';
  end if;

  with stores as (
    select l.id, l.store_number, l.district_id,
           coalesce(srp.report_display_name, regexp_replace(l.name, '^Midas\s+', '')) as short_name
      from public.locations l
      left join public.store_report_profile srp on srp.location_id = l.id
     where l.brand = 'midas'
       and not l.is_sandbox
       and not l.is_home_office
       and l.district_id is not null
  ),
  -- one row per person per store over the range
  per_store as (
    select td.employee_id, td.location_id,
           sum(td.flag_hours)   as turned,
           sum(td.hours_worked) as worked
      from public.tech_daily td
      join stores s on s.id = td.location_id
     where td.work_date between p_from and p_to
       and td.employee_id is not null
     group by td.employee_id, td.location_id
  ),
  -- the store each person is ranked under: most hours worked, then most
  -- turned, then store number, so a tie can never split them
  home as (
    select distinct on (ps.employee_id)
           ps.employee_id, ps.location_id
      from per_store ps
      join stores s on s.id = ps.location_id
     order by ps.employee_id, ps.worked desc, ps.turned desc, s.store_number
  ),
  -- Managers are not ranked (migration 75): anyone whose position is
  -- 'manager' today. is_store_manager can only be set on a manager
  -- (migration 32's check), so the position covers it.
  techs as (
    select ps.employee_id,
           sum(ps.turned) as turned,
           sum(ps.worked) as worked,
           count(*)       as store_count
      from per_store ps
      join public.employees e on e.id = ps.employee_id
     where e.position is distinct from 'manager'
     group by ps.employee_id
    having sum(ps.turned) > 0 or sum(ps.worked) > 0
  ),
  with_data as (
    select distinct td.location_id
      from public.tech_daily td
      join stores s on s.id = td.location_id
     where td.work_date between p_from and p_to
       and (td.flag_hours <> 0 or td.hours_worked <> 0)
  )
  select jsonb_build_object(
    'from', p_from,
    'to',   p_to,
    'divisions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'district_id', d.id,
               'name',        d.name,
               'stores', (
                 select jsonb_agg(jsonb_build_object(
                          'store_number', s.store_number,
                          'name',         s.short_name,
                          'has_data',     exists (select 1 from with_data w where w.location_id = s.id))
                        order by s.short_name)
                   from stores s where s.district_id = d.id))
             order by d.name)
        from public.districts d
       where exists (select 1 from stores s where s.district_id = d.id)
    ), '[]'::jsonb),
    'techs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'employee_id',  t.employee_id,
               'name',         e.full_name,
               'district_id',  s.district_id,
               'store_number', s.store_number,
               'store_name',   s.short_name,
               'store_count',  t.store_count,
               'hours_turned', round(t.turned, 2),
               'hours_worked', round(t.worked, 2)))
        from techs t
        join home h            on h.employee_id = t.employee_id
        join stores s          on s.id = h.location_id
        join public.employees e on e.id = t.employee_id
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end
$fn$;

comment on function public.tech_ranks(date, date) is
  'Tech Ranks report (migrations 74, 75): per-technician hours turned and worked over a range, company-wide, Midas stores only, managers excluded. District and above; names and hours only, no pay.';

revoke all on function public.tech_ranks(date, date) from public, anon;
grant execute on function public.tech_ranks(date, date) to authenticated;

notify pgrst, 'reload schema';
