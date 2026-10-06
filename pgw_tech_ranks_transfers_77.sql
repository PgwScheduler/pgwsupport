-- =====================================================================
-- Migration 77 — Tech Ranks: a transferred technician is ranked once
--
-- Why: the user, 2026-10-06. Since migration 76 a transfer ends the
-- old employee row and starts a linked one at the new store, so a
-- technician who transferred inside the chosen range had two rows --
-- and tech_ranks(), which grouped by employee row, ranked them twice,
-- once per store, each with only part of their hours.
--
-- Recreates tech_ranks() from migration 75 with ONE change: rows are
-- grouped by PERSON -- the first row of their transfer chain, following
-- employees.transferred_from_id. So, exactly as migration 74 promised for
-- anyone working at two stores:
--   * ranked once, with all their hours from every row and store;
--   * under the store where they worked the most hours in the range;
--   * store_count counts the stores they worked at;
--   * named, and judged by the manager rule (migration 75), from their
--     CURRENT row (the one not transferred out of) -- "position today".
--   * employee_id in the output is that current row.
--
-- Nobody who never transferred changes: their chain is one row.
-- Access, Midas-only scope and the output shape are unchanged.
-- Run AFTER 75 and 76. Safe to re-run.
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

  with recursive stores as (
    select l.id, l.store_number, l.district_id,
           coalesce(srp.report_display_name, regexp_replace(l.name, '^Midas\s+', '')) as short_name
      from public.locations l
      left join public.store_report_profile srp on srp.location_id = l.id
     where l.brand = 'midas'
       and not l.is_sandbox
       and not l.is_home_office
       and l.district_id is not null
  ),
  -- A PERSON, not an employee row (migration 77). A transfer (migration
  -- 76) ends one row and starts a linked one at the new store, so one
  -- technician can be several rows. Each row maps to the first row of
  -- its transfer chain (`person`); a row whose link was cut (the old row
  -- deleted) starts a chain of its own.
  chain as (
    select e.id, e.id as person
      from public.employees e
     where e.transferred_from_id is null
    union all
    select e.id, c.person
      from public.employees e
      join chain c on e.transferred_from_id = c.id
  ),
  -- Their CURRENT row: the one nothing was transferred out of. It gives
  -- the name shown and the position the manager rule (migration 75)
  -- reads -- "position today", as before.
  latest as (
    select c.person, e.id, e.full_name, e.position
      from chain c
      join public.employees e on e.id = c.id
     where not exists (select 1 from public.employees x where x.transferred_from_id = e.id)
  ),
  -- one row per person per store over the range
  per_store as (
    select coalesce(c.person, td.employee_id) as person, td.location_id,
           sum(td.flag_hours)   as turned,
           sum(td.hours_worked) as worked
      from public.tech_daily td
      join stores s on s.id = td.location_id
      left join chain c on c.id = td.employee_id
     where td.work_date between p_from and p_to
       and td.employee_id is not null
     group by 1, td.location_id
  ),
  -- the store each person is ranked under: most hours worked, then most
  -- turned, then store number, so a tie can never split them
  home as (
    select distinct on (ps.person)
           ps.person, ps.location_id
      from per_store ps
      join stores s on s.id = ps.location_id
     order by ps.person, ps.worked desc, ps.turned desc, s.store_number
  ),
  -- Managers are not ranked (migration 75): anyone whose position is
  -- 'manager' today, on their current row.
  techs as (
    select ps.person,
           sum(ps.turned) as turned,
           sum(ps.worked) as worked,
           count(*)       as store_count
      from per_store ps
      left join latest lt on lt.person = ps.person
      left join public.employees e on e.id = ps.person
     where coalesce(lt.position, e.position) is distinct from 'manager'
     group by ps.person
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
               'employee_id',  coalesce(lt.id, t.person),
               'name',         coalesce(lt.full_name, e.full_name),
               'district_id',  s.district_id,
               'store_number', s.store_number,
               'store_name',   s.short_name,
               'store_count',  t.store_count,
               'hours_turned', round(t.turned, 2),
               'hours_worked', round(t.worked, 2)))
        from techs t
        join home h            on h.person = t.person
        join stores s          on s.id = h.location_id
        left join latest lt    on lt.person = t.person
        left join public.employees e on e.id = t.person
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end
$fn$;

comment on function public.tech_ranks(date, date) is
  'Tech Ranks report (migrations 74, 75, 77): per-technician hours turned and worked over a range, company-wide, Midas stores only, managers excluded, a transferred technician counted once. District and above; names and hours only, no pay.';

revoke all on function public.tech_ranks(date, date) from public, anon;
grant execute on function public.tech_ranks(date, date) to authenticated;

notify pgrst, 'reload schema';
