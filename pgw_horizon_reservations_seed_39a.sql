-- =====================================================================
-- PGW Support Portal — Horizon shop numbers, reservations and slot
-- state for all 38 stores                            (Brief 38, rev. 2)
-- Run AFTER pgw_horizon_reservations_39.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Migration 39 built the reservation machinery. This file is the data:
-- 38 Horizon shop numbers, 38 Front Staff reservations, 4 SpeeDee GS
-- Techs reservations, and the 464-row slot-state import transcribed
-- from PGW_Horizon_Slot_Reconciliation.xlsx, tab `Slots`.
--
-- WHY THIS FILE WRITES TABLES DIRECTLY INSTEAD OF CALLING
-- seed_horizon_slot() AND reserve_horizon_slot().
-- Both functions gate on current_user_role() in ('admin','master'), and
-- current_user_role() reads public.profiles by auth.uid(). In the
-- Supabase SQL Editor auth.uid() is null, so every call would raise
-- 'Only an admin can seed Horizon slots' and nothing would import. The
-- statements below reproduce exactly what those functions do, field for
-- field, and are annotated where they do. Migration 38's own seed
-- section writes locations the same way for the same reason.
--
-- The invariants are NOT weakened by that choice: lhs_reserved_unoccupied,
-- lhs_reserved_has_kind and location_horizon_slots_one_per_kind are check
-- constraints and an index. They do not consult a role and they fire here
-- exactly as they would through the functions.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   * It creates no employees rows. Where a Horizon occupant cannot be
--     resolved to an existing employee at that store, the slot is
--     imported as FREED WITH NO DATE and the name is reported. Section 4.
--   * It seeds no vacate dates for the 94 stale slots. Every "Date
--     Vacated" cell in the workbook is empty; that is a data-collection
--     task, and those slots load later through seed_horizon_slot().
--   * It seeds no Horizon credentials. Every workbook tab carries a
--     plaintext password beside the shop number and none of it belongs
--     in a column RLS exposes to a store or district role.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. PREFLIGHT — migration 39 must have run first.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.location_horizon_slots') is null then
    raise exception 'location_horizon_slots does not exist. Run pgw_horizon_slots_38.sql first.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'location_horizon_slots'
       and column_name  = 'reservation_kind'
  ) then
    raise exception 'location_horizon_slots has no reservation_kind column. Run pgw_horizon_reservations_39.sql first.';
  end if;
  raise notice 'PREFLIGHT: migrations 38 and 39 present. OK.';
end
$$;


-- ---------------------------------------------------------------------
-- 1. HORIZON SHOP NUMBERS — all 38 stores
--
--    SHOP NUMBER IS DATA, NEVER DERIVED. Millwood is store 3303 and shop
--    101285; Beach Blvd is store 2321 and shop 122288. There is no
--    formula, and the two number spaces are not even the same shape --
--    Value Service's is 'b306006'.
--
--    Store 2321 is the one shop number that appears in NO workbook tab;
--    the reconciliation's own Issues tab flags it as outstanding. The
--    consolidated brief supplies it (122288) and that is the source used
--    here. If 122288 is ever contradicted by a Horizon login, this is
--    the line to change -- and the partial unique index means a
--    collision with another store surfaces as an error rather than as a
--    silent overwrite of that store's technician history.
--
--    STORE 2320 CONTRADICTS MIGRATION 38a. That file records 2320 as
--    "NEW TO HORIZON ENTIRELY... no prior slot history" and leaves its
--    horizon_shop_number null. Both halves are wrong: 2320 is shop
--    142282 and its Horizon draft already carries Gregory Pressley,
--    Jacob Wright and Charles Page in slots 1, 3 and 4 plus a departed
--    Shailis Black in slot 2. Store 2322 is in the same position (shop
--    143284, four named slots). Had they been left as 38a describes,
--    their first upload would have written new slot-1 data over
--    Pressley's existing history -- the exact failure this area of the
--    schema exists to prevent. Both are seeded from the workbook below
--    like every other store.
-- ---------------------------------------------------------------------
drop table if exists _shop_numbers;
create temporary table _shop_numbers (store_number text primary key, shop text not null);

insert into _shop_numbers (store_number, shop) values
  ('2320','142282'), ('2321','122288'), ('2322','143284'), ('3009','117287'),
  ('3025','136281'), ('3029','113289'), ('3111','125281'), ('3136','123283'),
  ('3182','110287'), ('3211','126286'), ('3229','104284'), ('3276','103289'),
  ('3278','105281'), ('3287','111281'), ('3292','127285'), ('3296','135285'),
  ('3302','109280'), ('3303','101285'), ('3305','129288'), ('3308','121281'),
  ('3377','130289'), ('3385','108281'), ('3473','137287'), ('3485','132282'),
  ('3548','124282'), ('3593','134281'), ('3598','138288'), ('3726','139280'),
  ('3831','140284'), ('3923','133285'), ('3935','135282'), ('3936','106280'),
  ('3937','115282'), ('3938','141281'), ('3979','131281'), ('3984','102283'),
  ('5253','116286'), ('5254','128288');

-- A store in the list that the portal does not have is reported, not
-- passed over quietly -- a missing store means a missing slot import too.
do $$
declare
  v_missing text;
begin
  select string_agg(s.store_number, ', ' order by s.store_number) into v_missing
    from _shop_numbers s
   where not exists (select 1 from public.locations l where l.store_number = s.store_number);
  if v_missing is not null then
    raise warning 'These stores are in the shop-number list but not in public.locations: %. Their slots will not import.', v_missing;
  end if;
end
$$;

update public.locations l
   set horizon_shop_number = s.shop
  from _shop_numbers s
 where l.store_number = s.store_number
   and l.horizon_shop_number is distinct from s.shop;


-- ---------------------------------------------------------------------
-- 2. THE WORKBOOK, TRANSCRIBED
--
--    A permanent table, not a temp one. The import leaves behind a
--    worklist -- 44 spellings to confirm, 94 vacate dates to collect,
--    3831's duplicate to resolve -- and that worklist has to outlive the
--    session that ran the migration. It is also what makes a re-run
--    verifiable rather than merely repeatable.
--
--    Columns are the workbook's own, verbatim. resolved_employee_id and
--    resolution are filled in by section 4.
-- ---------------------------------------------------------------------
create table if not exists public.horizon_slot_import (
  store_number         text     not null,
  slot_number          smallint not null check (slot_number between 1 and 20),
  horizon_value        text     null,      -- what the manager typed into the Horizon draft
  class                text     not null,  -- OCCUPIED / STALE / PLACEHOLDER / BLANK / MICHELIN / RESERVED / RESERVED (extra) / GS TECHS
  roster_match         text     null,      -- the payroll-name candidate, "Last, First"
  verdict              text     null,
  workbook_action      text     null,
  resolved_employee_id uuid     null references public.employees (id) on delete set null,
  resolution           text     null,
  imported_at          timestamptz not null default now(),
  primary key (store_number, slot_number)
);

comment on table public.horizon_slot_import is
  'Transcription of PGW_Horizon_Slot_Reconciliation.xlsx tab Slots, plus how each row resolved on import. Audit trail and worklist, NOT a source of truth -- location_horizon_slots is that. Query where class = ''OCCUPIED'' and resolution <> ''occupied'' for the names still needing confirmation.';

alter table public.horizon_slot_import enable row level security;
drop policy if exists "horizon_slot_import_select" on public.horizon_slot_import;
create policy "horizon_slot_import_select" on public.horizon_slot_import
  for select to authenticated
  using (public.current_user_role() in ('admin','master'));

-- Re-runnable: the workbook is the authority, so the transcription is
-- replaced wholesale rather than merged.
truncate table public.horizon_slot_import;

insert into public.horizon_slot_import
  (store_number, slot_number, horizon_value, class, roster_match, verdict, workbook_action)
values
  ('2321', 1, 'Reynold Cadet', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('2321', 2, 'Tech 1', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2321', 3, 'Michael Ferrell', 'OCCUPIED', 'Ferrell, Michael', 'Active here', 'Keep'),
  ('2321', 4, 'Alex Brown', 'OCCUPIED', 'Brown, Alex', 'Active here', 'Keep'),
  ('2321', 5, 'Ezra Brannigan', 'OCCUPIED', 'Boria Brannigan, Ezra', 'Active here', 'Keep'),
  ('2321', 6, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('2321', 7, 'James Nuzzo', 'OCCUPIED', 'Nuzzo, James', 'Active here', 'Keep'),
  ('2321', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2321', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2321', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2321', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2321', 12, 'Michelin', 'MICHELIN', null, 'Programme ended ~2023', 'Release, last_released_at = 2023-06'),
  ('3548', 1, 'Robert Rainer', 'OCCUPIED', 'Rainier, Robert', 'Active here - name differs', 'Confirm spelling'),
  ('3548', 2, 'Management', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3548', 3, 'Nasser Chaudhry', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3548', 4, 'RUSTIN PIERCE', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3548', 5, 'Michael Ferrell', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3548', 6, 'Alexander Monroe', 'OCCUPIED', 'Monroe, Alexander', 'Active here', 'Keep'),
  ('3548', 7, 'ANGEL CHAVEZ', 'OCCUPIED', 'Chavez, Angel', 'Active here', 'Keep'),
  ('3548', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3548', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3548', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3548', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3548', 12, 'Evan Wynot', 'OCCUPIED', 'Wynot, Evan', 'Active here', 'Keep'),
  ('3211', 1, 'Aleksander Robertson', 'OCCUPIED', 'Robertson, Aleksander', 'Active here', 'Keep'),
  ('3211', 2, 'Wyatt Kutch', 'OCCUPIED', 'Kutch, Wyatt', 'Active here', 'Keep'),
  ('3211', 3, 'John Kirkland', 'OCCUPIED', 'Kirkland, John', 'Active here', 'Keep'),
  ('3211', 4, 'Erik Gonzalez', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3211', 5, 'Josh Rivera', 'OCCUPIED', 'Rivera, Joshua Antonio', 'Active here - name differs', 'Confirm spelling'),
  ('3211', 6, 'Tech 3', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3211', 7, 'GARRISON PERKINS', 'OCCUPIED', 'Perkins, Garrison', 'Active here', 'Keep'),
  ('3211', 8, 'Jarrett Davis', 'OCCUPIED', 'Davis, Jarrett', 'Active here', 'Keep'),
  ('3211', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3211', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3211', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3211', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3136', 1, 'William Sigmon', 'OCCUPIED', 'Sigmon, William', 'Active here', 'Keep'),
  ('3136', 2, '0', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3136', 3, 'Shawn Fischer', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3136', 4, 'Joseph Johns', 'OCCUPIED', 'Johns, Joseph', 'Active here', 'Keep'),
  ('3136', 5, 'James Keen', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3136', 6, 'William Sigmon', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3136', 7, 'DYLAN JASIER', 'OCCUPIED', 'Gonzalez Ramos, Dylan', 'Active here - name differs', 'Confirm spelling'),
  ('3136', 8, 'Terrance Simcic', 'OCCUPIED', 'Simcic, Terrance', 'Active here', 'Keep'),
  ('3136', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3136', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3136', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3136', 12, 'Tech 5', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2322', 1, 'Abimael Delgado', 'OCCUPIED', 'Delgado, Abimael', 'Active here', 'Keep'),
  ('2322', 2, 'Nasser Chaudhry', 'OCCUPIED', 'Chaudhry, Nasser', 'Active here', 'Keep'),
  ('2322', 3, 'Neftaly Navarro', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('2322', 4, 'Josue Garcia', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('2322', 5, 'Tech 4', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2322', 6, 'Tech 5', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2322', 7, 'Tech 6', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2322', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2322', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2322', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2322', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2322', 12, 'Tech 7', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2320', 1, 'Gregory Pressley', 'OCCUPIED', 'Pressley, Gregory', 'Active here', 'Keep'),
  ('2320', 2, 'Shailis Black', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('2320', 3, 'Jacob Wright', 'OCCUPIED', 'Wright, Jacob', 'Active here', 'Keep'),
  ('2320', 4, 'Charles Page', 'OCCUPIED', 'Page, Charles', 'Active here', 'Keep'),
  ('2320', 5, '0', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2320', 6, 'Tech 5', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2320', 7, 'Tech 6', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('2320', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2320', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2320', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2320', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('2320', 12, 'Tech 7', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3111', 1, 'Henry Morris', 'OCCUPIED', 'Morris, Henry', 'Active here', 'Keep'),
  ('3111', 2, 'MANAGER', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3111', 3, 'Tech 4', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3111', 4, 'Tech 3', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3111', 5, 'Jonathan Borrero', 'OCCUPIED', 'Borrero, Jonathan Miguel', 'Active here', 'Keep'),
  ('3111', 6, 'Joseph Morales', 'OCCUPIED', 'Morales, Joseph', 'Active here', 'Keep'),
  ('3111', 7, 'Joel Lapitsky', 'OCCUPIED', 'Lapitsky, Joel', 'Active here', 'Keep'),
  ('3111', 8, 'Name', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3111', 9, 'Name', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3111', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3111', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3111', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3292', 1, 'Curtis Smithson', 'OCCUPIED', 'Smithson, Curtis', 'Active here', 'Keep'),
  ('3292', 2, 'Ryan Carlson', 'OCCUPIED', 'Carlson, Ryan', 'Active here', 'Keep'),
  ('3292', 3, 'Slade Sullivan', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3292', 4, 'Dustin Kelley', 'OCCUPIED', 'Kelley, Dustin', 'Active here', 'Keep'),
  ('3292', 5, 'Craig Hall', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3292', 6, 'Angel Chavez', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3292', 7, 'Tech 3', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3292', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3292', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3292', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3292', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3292', 12, 'Henry Felts', 'OCCUPIED', 'Henry, Felts', 'Active here', 'Keep'),
  ('3485', 1, 'Paul Carter', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3485', 2, 'Jared Watson', 'OCCUPIED', 'Watson, Jared', 'Active here', 'Keep'),
  ('3485', 3, 'Kamron Hall', 'OCCUPIED', 'Hall, Kamron', 'Active here', 'Keep'),
  ('3485', 4, 'Davin Burnette', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3485', 5, 'Ernest Fletcher', 'OCCUPIED', 'Fletcher, Ernest', 'Active here', 'Keep'),
  ('3485', 6, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3485', 7, 'Tyreke Miller', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3485', 8, 'JAMES ANGELO', 'OCCUPIED', 'Angelo, James', 'Active here', 'Keep'),
  ('3485', 9, 'Joseph Love', 'OCCUPIED', 'Love, Joseph', 'Active here', 'Keep'),
  ('3485', 10, 'Cristian Rostran', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3485', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3485', 12, 'Justin Ward', 'OCCUPIED', 'Ward, Justin', 'Active here', 'Keep'),
  ('3923', 1, 'Eric Dyer', 'OCCUPIED', 'Dyer, Eric', 'Active here', 'Keep'),
  ('3923', 2, 'Wyatt Gilroy', 'OCCUPIED', 'Gilroy, Wyatt', 'Active here', 'Keep'),
  ('3923', 3, 'Michael Brooke', 'OCCUPIED', 'Brooke, Michael', 'Active here', 'Keep'),
  ('3923', 4, 'Brian Legeer', 'OCCUPIED', 'Legeer, Brian', 'Active here', 'Keep'),
  ('3923', 5, 'James Okoro', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3923', 6, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3923', 7, 'TONY', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3923', 8, 'Anthony Butler', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3923', 9, 'Tech', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3923', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3923', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3923', 12, 'Michelin', 'MICHELIN', null, 'Programme ended ~2023', 'Release, last_released_at = 2023-06'),
  ('3473', 1, 'Charlton Woods', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3473', 2, 'Kevin Lepage', 'OCCUPIED', 'Jackson, Kevin', 'Active here - name differs', 'Confirm spelling'),
  ('3473', 3, 'Mohamed Konteh', 'OCCUPIED', 'Konteh, Mohamed', 'Active here', 'Keep'),
  ('3473', 4, 'Davin Burnette', 'OCCUPIED', 'Burnette, Davin', 'Active here', 'Keep'),
  ('3473', 5, 'Michael Jones', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3473', 6, 'Allen Nickes', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3473', 7, 'Kevin Jackson', 'OCCUPIED', 'Lepage, Kevin', 'Active here - name differs', 'Confirm spelling'),
  ('3473', 8, 'Kelly Huggins', 'OCCUPIED', 'Huggins, Kelley', 'Active here - name differs', 'Confirm spelling'),
  ('3473', 9, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3473', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3473', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3473', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3726', 1, 'ALIE SAMURA', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3726', 2, 'Rafael Rodriquez', 'OCCUPIED', 'Rodriguez, Rafael', 'Active here - name differs', 'Confirm spelling'),
  ('3726', 3, 'Dennis McGregor', 'OCCUPIED', 'McGregor, Dennis', 'Active here', 'Keep'),
  ('3726', 4, 'Jeffrey Ploger', 'OCCUPIED', 'Ploger, Jeffrey', 'Active here', 'Keep'),
  ('3726', 5, 'Demitri Andrade', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3726', 6, 'MN SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3726', 7, 'Tech 2', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3726', 8, 'Tech 7', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3726', 9, 'Tech 8', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3726', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3726', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3726', 12, 'Tech 7', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3593', 1, 'Jonathan Dillard', 'OCCUPIED', 'Dillard, Jonathan', 'Active here', 'Keep'),
  ('3593', 2, 'Oswaldo Alfaro', 'OCCUPIED', 'Alfaro, Oswaldo', 'Active here', 'Keep'),
  ('3593', 3, 'Tiera Stewart', 'OCCUPIED', 'Stewart, Tiera', 'Active here', 'Keep'),
  ('3593', 4, 'Ivan Johnson', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3593', 5, 'Alldred Holman', 'OCCUPIED', 'Holman, Alldred', 'Active here', 'Keep'),
  ('3593', 6, 'Dennis Najera', 'OCCUPIED', 'Najera-Casana, Dennis', 'Active here', 'Keep'),
  ('3593', 7, 'STEVE WARD', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3593', 8, 'Devon Curtis', 'OCCUPIED', 'Curtis, Devon', 'Active here', 'Keep'),
  ('3593', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3593', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3593', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3593', 12, '0', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3831', 1, 'XAVIER KING', 'OCCUPIED', 'King, Xavier', 'Active here', 'Keep'),
  ('3831', 2, 'Jose Morales Ayala', 'OCCUPIED', 'Ayala Navarro, Jesus', 'Active here - name differs', 'Confirm spelling'),
  ('3831', 3, 'Cody Lefler', 'OCCUPIED', 'Lefler, Cody', 'Active here', 'Keep'),
  ('3831', 4, 'JESUS AYALA', 'OCCUPIED', 'Morales-Ayala, Jose', 'Active here - name differs', 'Confirm spelling'),
  ('3831', 5, 'BARUCH MORENO', 'OCCUPIED', 'Barrales Moreno, Baruch', 'Active here', 'Keep'),
  ('3831', 6, 'BARUC BARRALES', 'OCCUPIED', 'Barrales Mendoza, Baruc', 'Active here', 'Keep'),
  ('3831', 7, 'AUSTIN WILSON', 'OCCUPIED', 'Wilson, Austin', 'Active here', 'Keep'),
  ('3831', 8, 'Carlos Moran', 'OCCUPIED', 'Moran, Carlos', 'Active here', 'Keep'),
  ('3831', 9, 'Tech 8', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3831', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3831', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3831', 12, 'Carlos Moran', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3598', 1, 'Carlos Rodriguez', 'OCCUPIED', 'Rodriguez, Carlos', 'Active here', 'Keep'),
  ('3598', 2, 'Khalil Goode', 'OCCUPIED', 'Goode, Khalil', 'Active here', 'Keep'),
  ('3598', 3, 'William Quick', 'OCCUPIED', 'Quick, William', 'Active here', 'Keep'),
  ('3598', 4, 'Jay Burleigh', 'OCCUPIED', 'Burleigh, Jheu', 'Active here - name differs', 'Confirm spelling'),
  ('3598', 5, 'KEYON YOUNG', 'OCCUPIED', 'Young, Keyon', 'Active here', 'Keep'),
  ('3598', 6, 'MN SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3598', 7, 'Tech 6', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3598', 8, 'Tech 7', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3598', 9, 'Tech 8', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3598', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3598', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3598', 12, 'Tech 7', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3296', 1, 'Juan Funez', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3296', 2, 'Maliq James', 'OCCUPIED', 'James, Gary', 'Active here - name differs', 'Confirm spelling'),
  ('3296', 3, 'Tech 5', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3296', 4, 'Michael Quarles', 'OCCUPIED', 'Quarles, Michael', 'Active here', 'Keep'),
  ('3296', 5, 'James Okoro', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3296', 6, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3296', 7, 'Rodney Jones', 'OCCUPIED', 'Jones, Rodney', 'Active here', 'Keep'),
  ('3296', 8, 'Kevin Jackson', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3296', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3296', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3296', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3296', 12, 'SEAN KILGORE', 'OCCUPIED', 'Kilgore, Sean', 'Active here', 'Keep'),
  ('3377', 1, 'Chris Grey', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3377', 2, 'Keith Walters', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3377', 3, 'Thomas McElwain', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3377', 4, 'Garrett Hyman', 'OCCUPIED', 'Hyman, Garrett', 'Active here', 'Keep'),
  ('3377', 5, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3377', 6, 'Malcolm Pollard', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3377', 7, 'TJ Howell', 'OCCUPIED', 'Timothy, Howell', 'Active here - name differs', 'Confirm spelling'),
  ('3377', 8, 'Grayson Smith', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3377', 9, 'Richard Doyle', 'OCCUPIED', 'Doyle, Richard', 'Active here', 'Keep'),
  ('3377', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3377', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3377', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3287', 1, 'Nat Liantonio', 'OCCUPIED', 'Liantonio, Ignazio', 'Active here - name differs', 'Confirm spelling'),
  ('3287', 2, 'Tyrell', 'OCCUPIED', 'Coutrair, Tyrell', 'Active here', 'Keep'),
  ('3287', 3, 'NOAH VAN HORN', 'OCCUPIED', 'Van Horn, Noah', 'Active here', 'Keep'),
  ('3287', 4, 'Tech 5', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3287', 5, 'Carlton Moseley', 'OCCUPIED', 'Moseley, Carlton', 'Active here', 'Keep'),
  ('3287', 6, 'Mando Gaspar', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3287', 7, 'Arron w', 'OCCUPIED', 'Watson, Arron Akeem', 'Active here', 'Keep'),
  ('3287', 8, 'Kyle G', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3287', 9, 'Tech 4', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3287', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3287', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3287', 12, 'Wesley C', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3182', 1, 'Larry Allen', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3182', 2, 'JOSH RICHARDSON', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3182', 3, 'James Wilson', 'OCCUPIED', 'Wilson, James', 'Active here', 'Keep'),
  ('3182', 4, 'John Demers', 'OCCUPIED', 'Demers, John', 'Active here', 'Keep'),
  ('3182', 5, 'Arthur Heath', 'OCCUPIED', 'Heath, Arthur Howard', 'Active here', 'Keep'),
  ('3182', 6, 'JOHN DELEON', 'OCCUPIED', 'Deleon, Johnny', 'Active here - name differs', 'Confirm spelling'),
  ('3182', 7, 'Front Staff', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3182', 8, 'Chelsea Carroll', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3182', 9, 'Myles Garrett', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3182', 10, 'Brooks Parrott', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3182', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3182', 12, 'Justus Jeffcoat', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3385', 1, 'Lucas Pruner', 'OCCUPIED', 'Pruner, Lucas', 'Active here', 'Keep'),
  ('3385', 2, 'Collin Enos', 'OCCUPIED', 'Enos, Collin', 'Active here', 'Keep'),
  ('3385', 3, 'Lamont Wilson', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3385', 4, 'Rodrigo Solis', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3385', 5, 'Jordan Barfield', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3385', 6, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3385', 7, 'Jacob Jensen', 'OCCUPIED', 'Jensen, Jacob', 'Active here', 'Keep'),
  ('3385', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3385', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3385', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3385', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3385', 12, 'Adley Piccolo', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3302', 1, 'Cody Williams', 'OCCUPIED', 'Austin-Williams, Cody', 'Active here', 'Keep'),
  ('3302', 2, 'David Bouch', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3302', 3, 'Name', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3302', 4, 'Trevor Downs', 'OCCUPIED', 'Downs, Trevor', 'Active here', 'Keep'),
  ('3302', 5, 'MACIO HILL', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3302', 6, 'Eli Wideman', 'OCCUPIED', 'Wideman, Elias', 'Active here - name differs', 'Confirm spelling'),
  ('3302', 7, 'Name', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3302', 8, 'Dylon Lafong', 'OCCUPIED', 'Lafong, Dylon', 'Active here', 'Keep'),
  ('3302', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3302', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3302', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3302', 12, 'Santo Alabanese', 'OCCUPIED', 'Albanese, Santo', 'Active here - name differs', 'Confirm spelling'),
  ('5253', 1, 'ARTHUR HEATH', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('5253', 2, 'Brooks Parrott', 'OCCUPIED', 'Parrott, Dyer', 'Active here - name differs', 'Confirm spelling'),
  ('5253', 3, 'KAIRON WADE', 'OCCUPIED', 'Wade, Kairon', 'Active here', 'Keep'),
  ('5253', 4, 'VICK DELESLINE', 'OCCUPIED', 'Delesline, Demetrius', 'Active here - name differs', 'Confirm spelling'),
  ('5253', 5, 'Cristian Bulanadi', 'OCCUPIED', 'Bulanadi, Cristian', 'Active here', 'Keep'),
  ('5253', 6, 'Josh Hughes', 'OCCUPIED', 'Hughes, Joshua', 'Active here - name differs', 'Confirm spelling'),
  ('5253', 7, 'LANCE CHABOTTE', 'OCCUPIED', 'Chabotte, Lance', 'Active here', 'Keep'),
  ('5253', 8, 'Tech 2', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('5253', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('5253', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('5253', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('5253', 12, 'MACIO HILL', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3938', 1, 'Bernard Flowers', 'OCCUPIED', 'Flowers, Bernard', 'Active here', 'Keep'),
  ('3938', 2, 'Brandon Littleton', 'OCCUPIED', 'Littleton, Brandon', 'Active here', 'Keep'),
  ('3938', 3, 'Raymond Francis', 'OCCUPIED', 'Francis, Raymond', 'Active here', 'Keep'),
  ('3938', 4, 'Ben Williams', 'OCCUPIED', 'Williams, Benjamin', 'Active here - name differs', 'Confirm spelling'),
  ('3938', 5, 'Josh Rardin', 'OCCUPIED', 'Rardin, Joshua', 'Active here - name differs', 'Confirm spelling'),
  ('3938', 6, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3938', 7, 'Ty Davis', 'OCCUPIED', 'Davis, Tyrell', 'Active here - name differs', 'Confirm spelling'),
  ('3938', 8, 'Roy Rufus', 'OCCUPIED', 'Rufus, Leroy', 'Active here - name differs', 'Confirm spelling'),
  ('3938', 9, 'Tech 8', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3938', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3938', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3938', 12, 'Tech 8', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3936', 1, 'Spenze Kitchens', 'OCCUPIED', 'Kitchens, Timothy', 'Active here - name differs', 'Confirm spelling'),
  ('3936', 2, 'Corey Slacum', 'OCCUPIED', 'Slacum, Corey', 'Active here', 'Keep'),
  ('3936', 3, 'Ray Currin', 'OCCUPIED', 'Currin, Calvin', 'Active here - name differs', 'Confirm spelling'),
  ('3936', 4, 'Thomas Martino', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3936', 5, 'Isaiah Crosby', 'OCCUPIED', 'Crosby, Isaiah', 'Active here', 'Keep'),
  ('3936', 6, 'MN & SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3936', 7, 'Austin Scott', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3936', 8, 'Blake Evans', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3936', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3936', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3936', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3936', 12, 'Phabion Rosales', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3984', 1, 'Ian Matthews', 'OCCUPIED', 'Matthews, Ian', 'Active here', 'Keep'),
  ('3984', 2, 'Josh Hodges', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3984', 3, 'Corey Slacum', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3984', 4, 'Isaias Cabrera', 'OCCUPIED', 'Cabrera, Isaias Rivers', 'Active here', 'Keep'),
  ('3984', 5, 'Billy Knight', 'OCCUPIED', 'Knight, William', 'Active here - name differs', 'Confirm spelling'),
  ('3984', 6, 'MCKINNEY ANDERSON', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3984', 7, 'Freddie Drain', 'OCCUPIED', 'Drain, Freddie', 'Active here', 'Keep'),
  ('3984', 8, 'De''Andre Palmer', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3984', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3984', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3984', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3984', 12, 'Tech 4', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('5254', 1, 'Joseph Ludack', 'OCCUPIED', 'Ludack, Joseph', 'Active here', 'Keep'),
  ('5254', 2, 'William Stillson', 'OCCUPIED', 'Stillson, William', 'Active here', 'Keep'),
  ('5254', 3, 'Chris Jones', 'OCCUPIED', 'Jones, Christopher', 'Active here - name differs', 'Confirm spelling'),
  ('5254', 4, 'Tech', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('5254', 5, 'Hayden Olvier', 'OCCUPIED', 'Oliver, Hayden Edward', 'Active here - name differs', 'Confirm spelling'),
  ('5254', 6, 'Rudy Stephens', 'OCCUPIED', 'Stephens, Rudolph', 'Active here - name differs', 'Confirm spelling'),
  ('5254', 7, 'Reed Harrelson', 'OCCUPIED', 'Harrelson, Reed', 'Active here', 'Keep'),
  ('5254', 8, 'Tech 2', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('5254', 9, 'Clifford Jones', 'OCCUPIED', 'Jones, Clifford', 'Active here', 'Keep'),
  ('5254', 10, 'Tech 1', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('5254', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('5254', 12, 'James', 'OCCUPIED', 'Felder, James', 'Active here', 'Keep'),
  ('3229', 1, 'McKinney Anderson', 'OCCUPIED', 'Anderson, Malcolm', 'Active here - name differs', 'Confirm spelling'),
  ('3229', 2, 'Front Staff', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3229', 3, 'Iyon Thompson', 'OCCUPIED', 'Thompson, Iyon', 'Active here', 'Keep'),
  ('3229', 4, 'Mike Tucker', 'OCCUPIED', 'Tucker, Michael', 'Active here - name differs', 'Confirm spelling'),
  ('3229', 5, 'Tech', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3229', 6, 'Tech 1', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3229', 7, 'Alexander Orthner', 'OCCUPIED', 'Orthner, Alexander', 'Active here', 'Keep'),
  ('3229', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3229', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3229', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3229', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3229', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3937', 1, 'Patrick Canzater', 'OCCUPIED', 'Canzater, Patrick', 'Active here', 'Keep'),
  ('3937', 2, 'TECH 5', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3937', 3, 'Cedric Savage', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3937', 4, 'Robbie Herrington', 'OCCUPIED', 'Herrington, Charles', 'Active here - name differs', 'Confirm spelling'),
  ('3937', 5, 'Isaias Cabrera', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3937', 6, 'Tonio Black', 'OCCUPIED', 'Marshall-Black, Tonio', 'Active here', 'Keep'),
  ('3937', 7, 'JARRELL STEWARD', 'OCCUPIED', 'Brown-Steward, Jarrell', 'Active here', 'Keep'),
  ('3937', 8, 'JOSHUA LEE', 'OCCUPIED', 'Lee, Joshua', 'Active here', 'Keep'),
  ('3937', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3937', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3937', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3937', 12, 'Ray Alfonzo', 'OCCUPIED', 'Ray, Alfonzo', 'Active here', 'Keep'),
  ('3278', 1, 'Darren Hayden', 'OCCUPIED', 'Hayden, Darren', 'Active here', 'Keep'),
  ('3278', 2, 'Tech 1', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3278', 3, 'Bobby Snelgrove', 'OCCUPIED', 'Snelgrove, Bobby', 'Active here', 'Keep'),
  ('3278', 4, 'Cecil Phillips', 'OCCUPIED', 'Phillips, Cecil', 'Active here', 'Keep'),
  ('3278', 5, 'Frank Van Sant', 'OCCUPIED', 'Van Sant, Franklin', 'Active here - name differs', 'Confirm spelling'),
  ('3278', 6, 'Shane Stinnard', 'OCCUPIED', 'Stinnard, Shane', 'Active here', 'Keep'),
  ('3278', 7, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3278', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3278', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3278', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3278', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3278', 12, 'Javis Thompson', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3979', 1, 'Joseph Williams', 'OCCUPIED', 'Platt, Joseph', 'Active here - name differs', 'Confirm spelling'),
  ('3979', 2, 'Devin Cassady', 'OCCUPIED', 'Cassady, Devin', 'Active here', 'Keep'),
  ('3979', 3, 'Jeremy Miles', 'OCCUPIED', 'Miles, Jeremy', 'Active here', 'Keep'),
  ('3979', 4, 'Michael Hughes', 'OCCUPIED', 'Hughes, Michael', 'Active here', 'Keep'),
  ('3979', 5, 'Joseph Platt', 'OCCUPIED', 'Williams, Joseph', 'Active here - name differs', 'Confirm spelling'),
  ('3979', 6, 'Bobby', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3979', 7, 'Bryson Sayre', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3979', 8, 'Carter Edrington', 'OCCUPIED', 'Edrington, Carter', 'Active here', 'Keep'),
  ('3979', 9, 'Heith Thomas', 'OCCUPIED', 'Thomas, Heith', 'Active here', 'Keep'),
  ('3979', 10, 'Clay Padgett', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3979', 11, 'John Farley', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3979', 12, 'Frontshop', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3303', 1, 'Phillip Brayboy', 'OCCUPIED', 'Brayboy, Phillip', 'Active here', 'Keep'),
  ('3303', 2, 'Alan Barron', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3303', 3, 'DeAndre Palmer', 'OCCUPIED', 'Palmer, De''Andre', 'Active here - name differs', 'Confirm spelling'),
  ('3303', 4, 'Cash Cantrell', 'OCCUPIED', 'Cantrell, Carter', 'Active here - name differs', 'Confirm spelling'),
  ('3303', 5, '0', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3303', 6, 'Manager or SA', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3303', 7, 'Joseph Fabre', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3303', 8, 'Bradley Jones', 'OCCUPIED', 'Jones, Bradley', 'Active here', 'Keep'),
  ('3303', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3303', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3303', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3303', 12, 'Rick Schroeder', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3276', 1, 'Tyler Budge', 'OCCUPIED', 'Budge, Tyler', 'Active here', 'Keep'),
  ('3276', 2, 'Ron Hendricks', 'OCCUPIED', 'Hendriks, Ron', 'Active here - name differs', 'Confirm spelling'),
  ('3276', 3, 'Tech 4', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3276', 4, 'Dave Merritt', 'OCCUPIED', 'Merritt, David', 'Active here - name differs', 'Confirm spelling'),
  ('3276', 5, 'Tim Potts', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3276', 6, 'tech 11', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3276', 7, 'NO TECH', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3276', 8, 'Tyler Dellinger', 'OCCUPIED', 'Dellinger, Tyler', 'Active here', 'Keep'),
  ('3276', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3276', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3276', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3276', 12, 'Austin Mattson', 'OCCUPIED', 'Mattson, Austin', 'Active here', 'Keep'),
  ('3305', 1, 'Jose Mateo', 'OCCUPIED', 'Mateo, Jose Luis', 'Active here', 'Keep'),
  ('3305', 2, 'Craig Cheeks', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3305', 3, 'Nigel Francis', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3305', 4, 'Miguel Silos-Ramos', 'OCCUPIED', 'Ramos, Miguel Silos', 'Active here', 'Keep'),
  ('3305', 5, 'Randy Brown', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3305', 6, 'midas store', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3305', 7, 'Rod Campos', 'OCCUPIED', 'Campos, Rodrick', 'Active here - name differs', 'Confirm spelling'),
  ('3305', 8, 'Tech 4', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3305', 9, 'Joseph Pulintano', 'OCCUPIED', 'Pulitano, Joseph', 'Active here - name differs', 'Confirm spelling'),
  ('3305', 10, 'Alan Rye', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3305', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3305', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3935', 1, 'Dian Dimele', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 2, 'Bobby Snelgrove', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 3, 'Laval Gadsden', 'OCCUPIED', 'Gadsden, La''Val', 'Active here - name differs', 'Confirm spelling'),
  ('3935', 4, 'Chris Ellett', 'OCCUPIED', 'Ellett, Christopher', 'Active here - name differs', 'Confirm spelling'),
  ('3935', 5, 'Isaias Cabrera', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 6, 'MN & SA', 'RESERVED (extra)', null, 'MN & SA', 'Release - 3935 keeps slot 12 only'),
  ('3935', 7, 'Chad Cooper', 'OCCUPIED', 'Cooper, Chad Tyler', 'Active here', 'Keep'),
  ('3935', 8, 'Tech 6', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3935', 9, 'Alphonse Capozziello', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 10, 'PATRICK CANNON', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 11, 'Benard Morgan', 'OCCUPIED', 'Morgan, Bernard', 'Active here - name differs', 'Confirm spelling'),
  ('3935', 12, 'front staff', 'RESERVED', null, 'Front Staff', 'Label as "Front Staff"'),
  ('3935', 13, null, 'BLANK', null, 'Never used', 'ever_used = false'),
  ('3935', 14, 'Billy Knight', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 15, 'Dylan Rinkus', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 16, 'Seth Grayson', 'OCCUPIED', 'Grayson, Seth', 'Active here', 'Keep'),
  ('3935', 17, 'James David', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 18, 'Solomon Boney', 'OCCUPIED', 'Boney, Solomon', 'Active here', 'Keep'),
  ('3935', 19, 'Freddie Drain', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3935', 20, 'Tech 7', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3029', 1, 'Tech', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3029', 2, 'Tech 1', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3029', 3, 'DOMINIQUE', 'OCCUPIED', 'Deas, Dominique', 'Active here', 'Keep'),
  ('3029', 4, 'Tech 2', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3029', 5, 'GS Techs', 'GS TECHS', null, 'SpeeDee pooled slot', 'DECISION NEEDED - see Issues'),
  ('3029', 6, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3029', 7, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3029', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3029', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3029', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3029', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3029', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3009', 1, 'Michael Mazyck', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3009', 2, 'Mike Raynor', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3009', 3, 'Lance Chabotte', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3009', 4, 'Jason Milano', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3009', 5, 'GS Techs', 'GS TECHS', null, 'SpeeDee pooled slot', 'DECISION NEEDED - see Issues'),
  ('3009', 6, 'Adley Piccolo', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3009', 7, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3009', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3009', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3009', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3009', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3009', 12, 'Michelin', 'MICHELIN', null, 'Programme ended ~2023', 'Release, last_released_at = 2023-06'),
  ('3025', 1, 'Robert Pettite', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3025', 2, 'Kelly Early', 'OCCUPIED', 'Early, Kelly', 'Active here', 'Keep'),
  ('3025', 3, 'Brian Daniels', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3025', 4, 'Nick Jay', 'STALE', null, 'Not on active roster', 'Release - date needed'),
  ('3025', 5, 'GS Techs', 'GS TECHS', null, 'SpeeDee pooled slot', 'DECISION NEEDED - see Issues'),
  ('3025', 6, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3025', 7, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3025', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3025', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3025', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3025', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3025', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3308', 1, '0', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3308', 2, '.', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3308', 3, 'Tech 3', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3308', 4, 'Tech 4', 'PLACEHOLDER', null, 'Genuinely empty (labelled)', 'Clear; treat as freed, no date'),
  ('3308', 5, 'GS Techs', 'GS TECHS', null, 'SpeeDee pooled slot', 'DECISION NEEDED - see Issues'),
  ('3308', 6, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3308', 7, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3308', 8, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3308', 9, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3308', 10, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3308', 11, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date'),
  ('3308', 12, null, 'BLANK', null, 'Empty', 'ever_used unknown - treat as freed, no date')
;


-- ---------------------------------------------------------------------
-- 3. RESOLVE OCCUPANTS TO employees.id
--
--    164 slots carry an occupant. 120 of them the reconciliation matched
--    cleanly ("Active here"); 44 it could only match by guessing at a
--    spelling ("Active here - name differs"). THOSE 44 ARE NOT SEEDED.
--    The brief is explicit that automated name matching is not safe to
--    seed from, and the 44 are precisely the population that proves it:
--    nicknames sharing no letters with the payroll name (Cash/Carter,
--    Ty/Tyrell, Vick/Demetrius, Spenze/Timothy), three roster entries
--    with the name order reversed, and outright misspellings
--    (Olvier/Oliver, Rainer/Rainier, Pulintano/Pulitano).
--
--    Getting one of those wrong does not produce a visible error. It
--    points the upload at the wrong technician's slot and writes one
--    man's hours over another man's history.
--
--    MATCHING IS ON THE ROSTER NAME, NOT THE HORIZON NAME. Column
--    "Roster Match" already holds the payroll spelling, which is the
--    form public.employees carries; the Horizon spelling is whatever the
--    manager typed. Matching Horizon text against employees would
--    reproduce the very ambiguity this section is avoiding.
--
--    The key is a normalised TOKEN SET -- lowercased, letters only,
--    tokens sorted -- so "Gadsden, La'Val" and "La Val Gadsden" agree
--    while genuinely different names do not. A name matching more than
--    one employee at the store resolves to nobody and is reported.
-- ---------------------------------------------------------------------
create or replace function public._horizon_name_key(p_name text)
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  select string_agg(t, ' ' order by t)
    from unnest(string_to_array(
           btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z]+', ' ', 'g')),
           ' ')) as t
   where t <> ''
$fn$;

comment on function public._horizon_name_key(text) is
  'Order- and punctuation-insensitive name key for the one-off Horizon slot import. Not a general-purpose matcher and not used at runtime.';

-- Import-time helper, not portal surface area. Same treatment migration
-- 34 gave the other internal helpers.
revoke all on function public._horizon_name_key(text) from public, anon, authenticated;

-- 3.1 Everything starts unresolved, so a re-run cannot inherit a stale
--     verdict from a previous one.
update public.horizon_slot_import
   set resolved_employee_id = null,
       resolution           = null;

-- 3.2 The 120 clean matches.
with cand as (
  select i.store_number,
         i.slot_number,
         (array_agg(e.id order by e.active desc, e.id))[1] as emp_id,
         count(*)                                          as n_match
    from public.horizon_slot_import i
    join public.locations l on l.store_number = i.store_number
    join public.employees e on e.location_id = l.id
     and public._horizon_name_key(e.full_name) = public._horizon_name_key(i.roster_match)
   where i.class   = 'OCCUPIED'
     and i.verdict = 'Active here'
     and i.roster_match is not null
   group by i.store_number, i.slot_number
)
update public.horizon_slot_import i
   set resolved_employee_id = case when c.n_match = 1 then c.emp_id end,
       resolution           = case when c.n_match = 1 then 'occupied' else 'ambiguous name' end
  from cand c
 where i.store_number = c.store_number
   and i.slot_number  = c.slot_number;

-- 3.3 Label everything else, so no row is left with a null verdict and
--     every slot's disposition is recorded rather than inferred.
update public.horizon_slot_import
   set resolution = case
         when class = 'OCCUPIED' and verdict = 'Active here - name differs'
              then 'held pending spelling confirmation'
         when class = 'OCCUPIED'
              then 'no employee row at this store'
         when class = 'MICHELIN'          then 'freed 2023-06-01'
         when class = 'RESERVED'          then 'front_staff reservation'
         when class = 'GS TECHS'          then 'gs_techs reservation'
         when class = 'RESERVED (extra)'  then 'freed - 3935 keeps slot 12 only'
         when workbook_action = 'ever_used = false' then 'never used'
         else 'freed, no date'
       end
 where resolution is null;


-- ---------------------------------------------------------------------
-- 4. APPLY SLOT STATE
--
--    This reproduces seed_horizon_slot() field for field, including
--    ever_used = true for a vacated slot with no occupant -- that is the
--    entire reason the seeding path is separate from the assignment
--    path. Reserved rows are excluded here and handled in section 5,
--    because a reservation must NOT set ever_used: reserving a
--    never-used slot and later clearing it has to return the slot to the
--    never-used group.
--
--    AN UNRESOLVED OCCUPANT IMPORTS AS FREED WITH NO DATE, NOT AS EMPTY.
--    Those 44-plus slots really are occupied in Horizon. ever_used = true
--    and a null last_released_at put them at the very back of the reuse
--    queue under migration 39's `nulls last` ordering, which is exactly
--    where an occupied-but-unconfirmed slot belongs: reachable only once
--    every other slot in the store is exhausted, and reported in the
--    meantime. The alternative -- leaving them ever_used = false -- would
--    hand slot 3 at store 3935 to the next new hire while La'Val Gadsden
--    is still working out of it.
--
--    SLOTS 13-20 AT THE 12-SLOT STORES ARE ABSENT FROM THE WORKBOOK AND
--    STAY THAT WAY. The Excel process physically could not address them,
--    so they are provably never used; migration 38 already provisioned
--    them ever_used = false and nothing here touches them. Only store
--    3935 runs a 20-slot template, and its rows 13-20 are present above.
-- ---------------------------------------------------------------------
update public.location_horizon_slots s
   set current_technician_id = x.occupant,
       ever_used             = x.ever_used,
       last_released_at      = x.released_at,
       is_reserved           = false,
       reservation_kind      = null,
       reservation_label     = null
  from (
    select l.id as location_id,
           i.slot_number,
           case when i.resolution = 'occupied' then i.resolved_employee_id end as occupant,
           (i.resolution <> 'never used')                                     as ever_used,
           case when i.class = 'MICHELIN' then timestamptz '2023-06-01' end   as released_at
      from public.horizon_slot_import i
      join public.locations l on l.store_number = i.store_number
     where i.class not in ('RESERVED', 'GS TECHS')
  ) x
 where s.location_id = x.location_id
   and s.slot_number = x.slot_number;


-- 4.1 STORE 3831 — Carlos Moran in slots 8 AND 12.
--
--     The brief and the workbook disagree here, so this is a decision
--     rather than a transcription. The workbook classes slot 12 STALE
--     with an empty Roster Match, but that is a matcher artefact: it had
--     already spent Carlos on slot 8 and could not match him twice, so
--     the row fell through. The brief resolves it directly -- "seed both
--     as-is and flag" -- and confirms the reading by saying the result
--     violates one-employee-per-slot, which only a genuine double
--     occupancy can do.
--
--     The contrast with 3136 settles it. There the brief has the same
--     shape of duplicate (William Sigmon in slots 1 and 6) and says
--     plainly to release slot 6. It does not say that for 3831. When the
--     brief wants a release it asks for one.
--
--     Recording reality is the safer error. If slot 12 really is stale,
--     it currently holds Carlos's own older history and releasing it
--     later costs nothing. If it is live and we recorded it empty, the
--     next hire is handed a slot that Horizon is still writing to.
--
--     Migration 39 dropped location_horizon_slots_occupant_key so this
--     can be recorded. Re-add that index once 3831 is resolved.
do $$
declare
  v_loc  uuid;
  v_emp  uuid;
begin
  select l.id into v_loc from public.locations l where l.store_number = '3831';
  if v_loc is null then
    raise warning '3831 EXCEPTION: store 3831 not found; slot 12 not seeded.';
    return;
  end if;

  select i.resolved_employee_id into v_emp
    from public.horizon_slot_import i
   where i.store_number = '3831' and i.slot_number = 8 and i.resolution = 'occupied';

  if v_emp is null then
    raise warning
      '3831 EXCEPTION: Carlos Moran did not resolve at slot 8, so slot 12 stays freed. Resolve the slot-8 occupant and re-run.';
    return;
  end if;

  update public.location_horizon_slots
     set current_technician_id = v_emp,
         ever_used             = true,
         last_released_at      = null
   where location_id = v_loc and slot_number = 12;

  update public.horizon_slot_import
     set resolved_employee_id = v_emp,
         resolution           = 'occupied - DUPLICATE of slot 8, under investigation'
   where store_number = '3831' and slot_number = 12;

  raise warning
    '3831 EXCEPTION APPLIED: Carlos Moran now holds slots 8 and 12. This is deliberate and under investigation. Do not add the one-employee-per-slot index until it is resolved.';
end
$$;


-- ---------------------------------------------------------------------
-- 5. RESERVATIONS
--
--    Nineteen stores keep a reservation that already exists in Horizon;
--    nineteen gain one at slot 20. THE EXISTING ONES DO NOT MOVE. Moving
--    a reservation would strand its accumulated labor sales in the old
--    slot while new data went to the new one -- the same fragmentation
--    the rest of this migration prevents. Only the label changes: every
--    source wording (MN & SA, MN SA, Manager or SA, MANAGER, Management,
--    midas store, Frontshop, front staff) normalises to "Front Staff".
--
--    Front Staff sits at slot 20 at nineteen stores, slot 6 at seven,
--    slot 2 at three, and slots 5, 7, 9 and 12 at one each. That spread
--    is why nothing may look the reservation up by number.
--
--    Store 3935 is the exception: it carries "MN & SA" at slot 6 and
--    "front staff" at slot 12. It keeps slot 12; slot 6 was released as
--    an ordinary freed slot in section 4.
-- ---------------------------------------------------------------------
drop table if exists _front_staff;
create temporary table _front_staff (store_number text primary key, slot smallint not null);

insert into _front_staff (store_number, slot) values
  ('2320',20), ('2321', 6), ('2322',20), ('3111', 2), ('3136',20), ('3182', 7),
  ('3211',20), ('3229', 2), ('3276',20), ('3278',20), ('3287',20), ('3292',20),
  ('3296', 6), ('3302',20), ('3303', 6), ('3305', 6), ('3377', 5), ('3385', 6),
  ('3473', 9), ('3485', 6), ('3548', 2), ('3593',20), ('3598', 6), ('3726', 6),
  ('3831',20), ('3923', 6), ('3935',12), ('3936', 6), ('3937',20), ('3938', 6),
  ('3979',12), ('3984',20), ('5253',20), ('5254',20), ('3009',20), ('3025',20),
  ('3029',20), ('3308',20);

-- GS Techs: SpeeDee only, slot 5, and it CARRIES LABOR COST. That cost
-- asymmetry against Front Staff is why it is a separate kind and not a
-- second label on the same flag. The reconciliation left this as
-- "DECISION NEEDED"; the consolidated brief decides it -- SpeeDee keeps
-- GS Techs at slot 5 and also gains a Front Staff slot at 20.
drop table if exists _gs_techs;
create temporary table _gs_techs (store_number text primary key, slot smallint not null);

insert into _gs_techs (store_number, slot) values
  ('3009',5), ('3025',5), ('3029',5), ('3308',5);

-- 5.1 A reservation cannot land on an occupied slot -- lhs_reserved_unoccupied
--     would reject it. Report which store and slot rather than letting a
--     constraint name be the whole explanation.
do $$
declare
  v_conflict text;
begin
  select string_agg(format('%s slot %s', t.store_number, t.slot), ', ' order by t.store_number)
    into v_conflict
    from (select store_number, slot from _front_staff
          union all
          select store_number, slot from _gs_techs) t
    join public.locations l on l.store_number = t.store_number
    join public.location_horizon_slots s
      on s.location_id = l.id and s.slot_number = t.slot
   where s.current_technician_id is not null;

  if v_conflict is not null then
    raise exception
      'Cannot reserve: a technician already holds these slots: %. Release each deliberately, then re-run.',
      v_conflict;
  end if;
end
$$;

-- 5.2 Clear reservations at the 38 stores that are not in the target
--     set, so a corrected re-run converges instead of accumulating.
--     NOTE WHAT IS NOT TOUCHED: last_released_at and ever_used. Clearing
--     a reservation is not a release -- no technician ever held the slot,
--     so no history is at risk and no queue position has been earned.
update public.location_horizon_slots s
   set is_reserved       = false,
       reservation_kind  = null,
       reservation_label = null
  from public.locations l
 where s.location_id = l.id
   and l.store_number in (select store_number from _shop_numbers)
   and s.is_reserved = true
   and not exists (
     select 1 from _front_staff f
      where f.store_number = l.store_number and f.slot = s.slot_number)
   and not exists (
     select 1 from _gs_techs g
      where g.store_number = l.store_number and g.slot = s.slot_number);

-- 5.3 Front Staff, all 38.
update public.location_horizon_slots s
   set is_reserved           = true,
       reservation_kind      = 'front_staff',
       reservation_label     = 'Front Staff',
       current_technician_id = null
  from public.locations l
  join _front_staff f on f.store_number = l.store_number
 where s.location_id = l.id
   and s.slot_number = f.slot;

-- 5.4 GS Techs, the four SpeeDee stores.
update public.location_horizon_slots s
   set is_reserved           = true,
       reservation_kind      = 'gs_techs',
       reservation_label     = 'GS Techs',
       current_technician_id = null
  from public.locations l
  join _gs_techs g on g.store_number = l.store_number
 where s.location_id = l.id
   and s.slot_number = g.slot;

drop table _front_staff;
drop table _gs_techs;
drop table _shop_numbers;


-- ---------------------------------------------------------------------
-- 6. REPORT — what did not import cleanly
--
--    NO employees ROWS WERE CREATED. Every name below is a slot that is
--    occupied in Horizon and has no confirmed technician in the portal.
--    Each is parked at the back of the reuse queue until someone
--    confirms it; none is silently empty.
-- ---------------------------------------------------------------------
do $$
declare
  r           record;
  v_spelling  int;
  v_noemp     int;
  v_ambig     int;
  v_stale     int;
begin
  select count(*) filter (where resolution = 'held pending spelling confirmation'),
         count(*) filter (where resolution = 'no employee row at this store'),
         count(*) filter (where resolution = 'ambiguous name'),
         count(*) filter (where class = 'STALE')
    into v_spelling, v_noemp, v_ambig, v_stale
    from public.horizon_slot_import;

  raise notice '--- Horizon slot import ---';
  raise notice '% occupied slots held pending spelling confirmation (the 44 in the workbook Name spelling check tab).', v_spelling;
  raise notice '% occupied slots whose roster name has no employees row at that store.', v_noemp;
  raise notice '% occupied slots whose roster name matched more than one employee at that store.', v_ambig;
  raise notice '% stale slots freed with no vacate date. Dates load later through seed_horizon_slot().', v_stale;

  -- The ADP roster files SpeeDee Summerville as store 3309; Horizon
  -- addresses it as 3009. If a 3309 location exists in the portal, that
  -- store's technicians are sitting under the wrong location and no
  -- occupant at 3009 can ever resolve. Nothing here remaps it -- moving
  -- employees between locations is roster work, not slot work -- but it
  -- is worth knowing before someone reads 3009's empty slots as the
  -- pooled model rather than as a filing error.
  if exists (select 1 from public.locations where store_number = '3309') then
    raise warning
      'A location with store_number 3309 exists. The roster files SpeeDee Summerville as 3309 and Horizon as 3009; confirm which technicians belong where before assigning slots at 3009.';
  end if;

  if v_noemp + v_ambig > 0 then
    raise notice '--- names with no single employees row (nothing was created for these) ---';
    for r in
      select store_number, slot_number, horizon_value, roster_match, resolution
        from public.horizon_slot_import
       where resolution in ('no employee row at this store', 'ambiguous name')
       order by store_number, slot_number
    loop
      raise notice '  % slot %: Horizon "%" / roster "%" -> %',
        r.store_number, r.slot_number, r.horizon_value, r.roster_match, r.resolution;
    end loop;
  end if;
end
$$;


-- =====================================================================
-- VERIFY — run in order, in the SQL Editor.
-- Numbering follows the consolidated brief section 10.
--
--  [30] All 38 stores carry a shop number, and all are unique:
--         select count(*) filter (where horizon_shop_number is not null),
--                count(distinct horizon_shop_number)
--           from public.locations;
--       Expect 39 and 39 -- the 38 stores plus Value Service (b306006).
--       Then eyeball the map:
--         select store_number, name, brand, horizon_shop_number, is_sandbox
--           from public.locations order by store_number nulls first;
--       2320 must read 142282 and 2321 must read 122288.
--
--  [19] Every store has exactly one Front Staff reservation, at the
--       brief's slot:
--         select l.store_number, s.slot_number, s.reservation_label
--           from public.horizon_reserved_slots s
--           join public.locations l on l.id = s.location_id
--          where s.reservation_kind = 'front_staff'
--          order by l.store_number;
--       Expect 38 rows, every label exactly 'Front Staff', and the slot
--       numbers 20/6/2/5/7/9/12 as in brief section 9.2. Cross-check
--       against the workbook's own reserved rows:
--         select i.store_number, i.slot_number, i.horizon_value
--           from public.horizon_slot_import i
--          where i.class = 'RESERVED' order by i.store_number;
--       Those 19 slot numbers must each appear in the previous result.
--
--  [20] 3935 is reserved at slot 12 only, and slot 6 is an ordinary
--       freed slot:
--         select s.slot_number, s.is_reserved, s.reservation_kind,
--                s.ever_used, s.last_released_at, s.current_technician_id
--           from public.location_horizon_slots s
--           join public.locations l on l.id = s.location_id
--          where l.store_number = '3935' and s.slot_number in (6, 12);
--       Slot 6: is_reserved false, ever_used true, both nulls.
--       Slot 12: is_reserved true, front_staff, ever_used FALSE.
--
--  [16] The four SpeeDee stores hold both kinds without tripping
--       location_horizon_slots_one_per_kind:
--         select l.store_number, s.slot_number, s.reservation_kind
--           from public.horizon_reserved_slots s
--           join public.locations l on l.id = s.location_id
--          where l.brand = 'speedee' order by l.store_number, s.slot_number;
--       Expect eight rows: gs_techs at 5 and front_staff at 20, per store.
--
--  [33] Slots 13-20 are never-used at the 12-slot stores, and seeded at
--       3935:
--         select l.store_number,
--                count(*) filter (where s.ever_used) as ever_used_13_20
--           from public.location_horizon_slots s
--           join public.locations l on l.id = s.location_id
--          where s.slot_number between 13 and 20
--            and l.store_number is not null
--          group by l.store_number order by l.store_number;
--       Every store 0 except 3935, which has 7 (slots 14-20; slot 13 is
--       its one genuine never-used row).
--
--  [34] Michelin freed with a date, at 2321, 3923 and 3009 slot 12:
--         select l.store_number, s.slot_number, s.ever_used,
--                s.last_released_at, s.current_technician_id
--           from public.location_horizon_slots s
--           join public.locations l on l.id = s.location_id
--          where l.store_number in ('2321','3923','3009') and s.slot_number = 12;
--       ever_used true, last_released_at 2023-06-01, occupant null.
--       They sit ahead of the undated freed slots and behind every
--       never-used slot, which is the intent.
--
--  [35] 3136: slot 1 holds William Sigmon, slot 6 is freed, slot 20 is
--       the Front Staff reservation:
--         select s.slot_number, e.full_name, s.ever_used, s.is_reserved
--           from public.location_horizon_slots s
--           join public.locations l on l.id = s.location_id
--           left join public.employees e on e.id = s.current_technician_id
--          where l.store_number = '3136' and s.slot_number in (1, 6, 20);
--
--  [36] 3831: slots 8 and 12 both hold Carlos Moran, and the index that
--       would forbid it is absent:
--         select s.slot_number, e.full_name
--           from public.location_horizon_slots s
--           join public.locations l on l.id = s.location_id
--           join public.employees e on e.id = s.current_technician_id
--          where l.store_number = '3831' and s.slot_number in (8, 12);
--         select indexname from pg_indexes
--          where tablename = 'location_horizon_slots';
--       location_horizon_slots_occupant_key must NOT be listed.
--       If slot 12 is empty, the migration raised a warning saying so --
--       Carlos did not resolve at slot 8. Fix the name and re-run.
--
--  [37] SpeeDee: 8 stale slots freed, 2 named technicians retained, and
--       nothing assigned to the 21 unplaced roster technicians:
--         select l.store_number,
--                count(*) filter (where s.current_technician_id is not null) as occupied
--           from public.location_horizon_slots s
--           join public.locations l on l.id = s.location_id
--          where l.brand = 'speedee' group by l.store_number;
--       Expect 3009: 0, 3025: 1 (Kelly Early), 3029: 1 (Dominique Deas),
--       3308: 0. Pooled model, working as intended -- not a gap.
--
--  [39] Unmatched names reported, not created:
--         select store_number, slot_number, horizon_value, roster_match, resolution
--           from public.horizon_slot_import
--          where class = 'OCCUPIED' and resolution <> 'occupied'
--          order by store_number, slot_number;
--       Every row here is a slot occupied in Horizon and parked at the
--       back of the reuse queue. Confirm the count of employees is
--       unchanged from before the run.
--
--  [29] Upload precondition 3 now passes for a seeded store:
--         select * from public.horizon_upload_target(
--           (select id from public.locations where store_number = '3303'));
--       authorized true, shop_number 101285, front_staff_slot 6.
--       Note 6, not 20 -- the value is read from reservation_kind.
--
--  [21] Value Service untouched by any of this:
--         select name, is_sandbox, horizon_shop_number, district_id
--           from public.locations where is_sandbox;
--       One row: Value Service / true / b306006 / null. It has no Front
--       Staff reservation and therefore cannot upload -- reserve one
--       deliberately when the sandbox is next used.
--
--   Queue spot-check on a real store, no writes:
--         select s.slot_number, s.ever_used, s.last_released_at,
--                s.is_reserved, s.reservation_kind
--           from public.location_horizon_slots s
--           join public.locations l on l.id = s.location_id
--          where l.store_number = '3303'
--          order by s.ever_used, s.last_released_at nulls last, s.slot_number;
--       The head of that list is what next_horizon_slot() will return.
--       Slot 6 must not appear as available anywhere in it.
-- =====================================================================
