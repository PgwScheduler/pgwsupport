-- =====================================================================
-- Migration 85a — fix: the rollover failed live with
--                 "DELETE requires a WHERE clause"
-- Run AFTER pgw_bonus_rollover_85.sql, in the SQL Editor. Safe to re-run.
-- =====================================================================
-- Supabase runs API calls with the safeupdate guard, which refuses an
-- UPDATE or DELETE that has no WHERE clause -- even on a temporary
-- table inside a function. bonus_fill_last_year_gp() cleared its scratch
-- table with a bare DELETE, so "Start 2027 from 2026" (which calls it)
-- rolled back. Nothing was created. The SQL Editor and the offline test
-- engine don't use the guard, which is why it passed there.
--
-- This recreates that ONE function with `where true`. Nothing else
-- changes; pgw_bonus_rollover_85.sql carries the same fix.
-- =====================================================================

-- 7. FILL Model B's last_year_gp in a draft year from the previous
--    year's actuals. Only complete months; p_overwrite = false keeps any
--    figure already there (typed by hand or filled earlier).
-- ---------------------------------------------------------------------
create or replace function public.bonus_fill_last_year_gp(p_year int, p_overwrite boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_filled int;
  v_missing jsonb;
begin
  if coalesce(public.current_user_role(), '') not in ('admin','master') then
    raise exception 'admin or master only' using errcode = '42501';
  end if;
  perform public._bonus_require_draft(p_year);

  create temp table if not exists pg_temp._bonus_ly (location_id uuid, month int, gross_profit numeric, entered_days int, working_days int, complete boolean) on commit drop;
  delete from pg_temp._bonus_ly where true;  -- 85a: the API refuses a DELETE with no WHERE (safeupdate)
  insert into pg_temp._bonus_ly select * from public.bonus_actual_gp(p_year - 1);

  update public.bonus_monthly_targets t
     set last_year_gp = a.gross_profit
    from public.bonus_plans p, pg_temp._bonus_ly a
   where p.location_id = t.location_id and p.plan_year = t.plan_year
     and p.threshold_basis = 'last_year'
     and t.plan_year = p_year
     and a.location_id = t.location_id and a.month = t.month and a.complete
     and (p_overwrite or t.last_year_gp is null);
  get diagnostics v_filled = row_count;

  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', t.location_id, 'store_number', l.store_number, 'month', t.month,
           'entered_days', a.entered_days, 'working_days', a.working_days)
         order by l.store_number, t.month), '[]'::jsonb)
    into v_missing
    from public.bonus_monthly_targets t
    join public.bonus_plans p on p.location_id = t.location_id and p.plan_year = t.plan_year
    join public.locations l on l.id = t.location_id
    left join pg_temp._bonus_ly a on a.location_id = t.location_id and a.month = t.month
   where t.plan_year = p_year and p.threshold_basis = 'last_year' and t.last_year_gp is null;

  perform public.bonus_recalc_thresholds(p_year);
  return jsonb_build_object('filled', v_filled, 'still_missing', v_missing);
end
$fn$;
revoke all on function public.bonus_fill_last_year_gp(int, boolean) from public, anon;
grant execute on function public.bonus_fill_last_year_gp(int, boolean) to authenticated;

notify pgrst, 'reload schema';
