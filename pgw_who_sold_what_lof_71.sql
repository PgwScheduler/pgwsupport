-- =====================================================================
-- PGW Support Portal — migration 71: Who Sold What, LOF counts all oil changes
-- Run AFTER pgw_who_sold_what_70.sql, in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================
-- Verified live 2026-09-25: "LOF / day" read 0–1 a day at every store
-- against Matt's "min 7/day", because stores log most oil changes as
-- LOF Premium. DECIDED (user, 2026-09-25): the LOF column counts LOF plus
-- LOF Premium. Millwood August: 381 cars, ~7 oil changes a day.
--
-- Kept as DATA, like the rest of the layout: service_penetration_goals
-- gains `also_counts` -- other services whose units are added to this
-- column's units. Only LOF uses it. Prem Oil keeps its own column (LOF
-- Premium ÷ cars, 40% goal) unchanged.
--
-- Not app-editable: the column grant from migration 70 covers `goal` only.
-- =====================================================================

alter table public.service_penetration_goals
  add column if not exists also_counts text[] not null default '{}';

comment on column public.service_penetration_goals.also_counts is
  'Other service_categories.horizon_key values whose units are ADDED to this column''s units (migration 71). LOF = LOF + LOF Premium.';

-- Every key named must be a real service (an array cannot carry a FK).
create or replace function public.spg_also_counts_valid()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from unnest(new.also_counts) k
              where not exists (select 1 from public.service_categories c where c.horizon_key = k)) then
    raise exception 'also_counts names an unknown service: %', new.also_counts using errcode = '23503';
  end if;
  if new.service_key = any (new.also_counts) then
    raise exception 'a column cannot also count itself' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists spg_also_counts_valid on public.service_penetration_goals;
create trigger spg_also_counts_valid before insert or update on public.service_penetration_goals
  for each row execute function public.spg_also_counts_valid();

update public.service_penetration_goals
   set also_counts = array['kpi_su_lof_premium'],
       label       = 'LOF + Prem / day'
 where service_key = 'kpi_su_lof';


-- ---------------------------------------------------------------------
-- CONFIRMATION (run after applying)
-- ---------------------------------------------------------------------
--  select service_key, label, measure, goal, also_counts
--    from public.service_penetration_goals where array_length(also_counts, 1) > 0;
--  Expect one row: kpi_su_lof | LOF + Prem / day | per_day | 7 | {kpi_su_lof_premium}
