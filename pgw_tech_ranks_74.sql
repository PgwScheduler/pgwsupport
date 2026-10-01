-- =====================================================================
-- Migration 74 — Tech Ranks report
--
-- The "Tech ranks" workbook, in the portal: each division's top 10
-- technicians and the company top 20, ranked by hours turned (flag
-- hours), with hours worked and proficiency (turned / worked), for any
-- date range the person pulling it picks.
--
-- WHO SEES IT (user decision 2026-10-01): district managers and above
-- see the WHOLE company, like the workbook. tech_daily and employees are
-- store-scoped by RLS, so this is a SECURITY DEFINER function that
-- returns names and hours only -- never pay, never rates. Store logins
-- are refused.
--
-- WHAT COUNTS
--   * Midas stores only (the workbook's divisions list no SpeeDee
--     store; SpeeDee labour is one store-level placeholder slot).
--   * Not the sandbox, not the Home Office, and only stores in a
--     district (the division IS the district).
--   * A day counts for the person who WORKED it (tech_daily.employee_id,
--     migration 29), never whoever holds the slot today. Placeholder
--     slots with nobody attached are left out.
--   * A technician who worked at more than one store in the range is
--     ranked ONCE, with all their hours, under the store where they
--     worked the most hours.
--
-- Ranking, top-N and colours are the frontend's (lib/techRanks.js);
-- this returns the raw totals so the on-screen report and the Excel
-- export rank the same numbers.
--
-- Safe to re-run.
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
  techs as (
    select ps.employee_id,
           sum(ps.turned) as turned,
           sum(ps.worked) as worked,
           count(*)       as store_count
      from per_store ps
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
  'Tech Ranks report (migration 74): per-technician hours turned and worked over a range, company-wide, Midas stores only. District and above; names and hours only, no pay.';

revoke all on function public.tech_ranks(date, date) from public, anon;
grant execute on function public.tech_ranks(date, date) to authenticated;

notify pgrst, 'reload schema';
