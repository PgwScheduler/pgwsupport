-- =====================================================================
-- 62 -- ADJUSTMENTS REASON
-- Run AFTER pgw_adjustments_48.sql. Independent of 61. Re-runnable.
--
-- Every non-zero Adjustment on the tic sheet's Sales breakdown now needs
-- a written reason, kept on the day beside the amount.
--
--   * daily_kpi.adjustments_note -- the reason. Same editors as the amount
--     (district manager or above); readable by anyone who can see the day.
--   * A signed-in user cannot save a non-zero amount with a blank reason,
--     or blank the reason of a day that still carries an amount.
--   * Checked only when the amount or the reason CHANGES, so days entered
--     before this (amount, no reason) stay editable for everything else.
--   * No signed-in user (SQL Editor, imports) is exempt, exactly as the
--     role check in 48 is.
--   * The reason has its own who/when stamp. Editing ONLY the reason does
--     not touch adjustments_updated_at, so it never marks a month Horizon
--     already accepted as needing a re-send -- the numbers did not change.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. COLUMNS
-- ---------------------------------------------------------------------
alter table public.daily_kpi
  add column if not exists adjustments_note            text,
  add column if not exists adjustments_note_updated_by uuid references auth.users (id),
  add column if not exists adjustments_note_updated_at timestamptz;

comment on column public.daily_kpi.adjustments_note is
  'Why the day carries an Adjustment. Required (for signed-in users) whenever sales_adjustments is non-zero and either changes. District manager or above only (daily_kpi_adjustments_guard).';
comment on column public.daily_kpi.adjustments_note_updated_by is
  'Who last changed adjustments_note. Stamped by daily_kpi_adjustments_guard.';
comment on column public.daily_kpi.adjustments_note_updated_at is
  'When adjustments_note last changed. Stamped by daily_kpi_adjustments_guard. Separate from adjustments_updated_at so a reason-only edit does not flag a Horizon re-send.';


-- ---------------------------------------------------------------------
-- 2. THE GUARD  (replaces migration 48's version)
--    Migration 48's body, with the reason added alongside the amount:
--    who may change it, the required-reason rule, and its own stamp.
--    The amount's stamp and the Horizon re-send flag behave exactly as
--    in 48 and still fire on amount changes only.
-- ---------------------------------------------------------------------
create or replace function public.daily_kpi_adjustments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid          uuid := auth.uid();
  v_role         text;
  v_changed      boolean;
  v_note_changed boolean;
  v_month        date;
begin
  -- Blank and whitespace-only reasons are stored as null.
  new.adjustments_note := nullif(btrim(new.adjustments_note), '');

  if tg_op = 'INSERT' then
    v_changed      := new.sales_adjustments is distinct from 0;
    v_note_changed := new.adjustments_note is not null;
  else
    -- Moving a row that carries a value counts as setting it.
    v_changed := new.sales_adjustments is distinct from old.sales_adjustments
      or (new.sales_adjustments <> 0
          and (new.location_id   is distinct from old.location_id
            or new.business_date is distinct from old.business_date));
    v_note_changed := new.adjustments_note is distinct from old.adjustments_note;
  end if;

  -- The stamps belong to this trigger, never to the caller.
  if tg_op = 'INSERT' then
    new.adjustments_updated_by      := null;
    new.adjustments_updated_at      := null;
    new.adjustments_note_updated_by := null;
    new.adjustments_note_updated_at := null;
  else
    new.adjustments_updated_by      := old.adjustments_updated_by;
    new.adjustments_updated_at      := old.adjustments_updated_at;
    new.adjustments_note_updated_by := old.adjustments_note_updated_by;
    new.adjustments_note_updated_at := old.adjustments_note_updated_at;
  end if;

  if not v_changed and not v_note_changed then
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
    if new.sales_adjustments <> 0 and new.adjustments_note is null then
      raise exception 'Add a reason for the adjustment.'
        using errcode = '23514';
    end if;
  end if;

  if v_note_changed then
    new.adjustments_note_updated_by := v_uid;
    new.adjustments_note_updated_at := clock_timestamp();
  end if;

  if not v_changed then
    return new;
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


-- =====================================================================
-- VERIFY
--   1) columns exist:
--        select column_name from information_schema.columns
--         where table_name = 'daily_kpi' and column_name like 'adjustments_note%';
--   2) days that carry an adjustment but no reason (entered before 62):
--        select l.store_number, k.business_date, k.sales_adjustments
--          from public.daily_kpi k join public.locations l on l.id = k.location_id
--         where k.sales_adjustments <> 0 and k.adjustments_note is null
--         order by 1, 2;
-- =====================================================================
