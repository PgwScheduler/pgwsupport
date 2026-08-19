-- =====================================================================
-- PGW Support Portal — Bonus Tracker (Models A / B / C / D)   (Task 6)
-- Run AFTER pgw_tic_sheet_totals_25.sql, in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Everything about a bonus plan is DATA. No threshold, percentage or
-- scale is written in application code — the scales already vary by
-- store and are re-cut every year.
--
-- FOUR structures, not three:
--   A  23 Midas   team pool, split GM 65 / Assistant 25 / Advisor 10
--   B   9 Midas   store manager + assistant, measured against last year
--   C   3 SpeeDee business operator, single payout
--   D   1 SpeeDee (Lexington 3308) store manager, flat 3%, car-increase
--                 bonus, Midas referral GP credit. Its own model — see
--                 the open question in the flags table below.
--
-- Every figure is a percentage of GROSS PROFIT, and gross profit is only
-- correct once technician labor cost is in (migration 24). Bonus math
-- reads the same gross profit the tic sheet's goals strip does.
--
-- THREE DEPARTURES FROM THE TASK'S DDL SKETCH, all additive:
--   * bonus_monthly_targets.last_year_gp — Model B pays "6% of all GP
--     improvement over last year", so last year's monthly GP has to be
--     stored. It is column I ("2025 GP #s") of each Model B handout and
--     is NOT in bonus_seed_2026.csv. Null for models A/C/D.
--   * bonus_incentive_tiers.tier_index — an ordinal so a re-run upserts
--     instead of duplicating. Nothing reads it but the seed.
--   * bonus_monthly_inputs — the three figures no system tracks yet
--     (five-star reviews, phone conversion) plus Model D's referral GP
--     credit. Nullable on purpose: null means "never entered", which
--     the screen must show as unfilled, NOT as a zero result.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. WHICH PLAN A STORE IS ON
-- ---------------------------------------------------------------------
create table if not exists public.bonus_plans (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid    not null references public.locations (id) on delete cascade,
  model       char(1) not null check (model in ('A','B','C','D')),
  plan_year   int     not null,
  updated_at  timestamptz not null default now(),
  unique (location_id, plan_year)
);


-- ---------------------------------------------------------------------
-- 2. MONTHLY TARGETS
--    Model A/C/D: gold/silver/bronze are 95% / 90% / 80% of gp_budget.
--    Model B:     gold  = the "+10.01% LY" threshold
--                 silver= "Minimum to Bonus" (95% of LY, floored 35,000)
--                 bronze= null (Model B has no third tier)
--    Seeded values are used as given — never recomputed. The handout
--    floors BOTH Model B thresholds at 35,000, so in a weak month gold
--    and silver can be equal; gold wins the comparison.
-- ---------------------------------------------------------------------
create table if not exists public.bonus_monthly_targets (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references public.locations (id) on delete cascade,
  plan_year        int  not null,
  month            int  not null check (month between 1 and 12),
  days_open        int  not null,
  daily_car_goal   numeric(6,1),        -- null for Model B; Model D's is already LY + 2
  sales_goal       numeric(14,2),
  gp_budget        numeric(14,2),
  gold_threshold   numeric(14,2),
  silver_threshold numeric(14,2),
  bronze_threshold numeric(14,2),
  last_year_gp     numeric(14,2),       -- Model B only
  unique (location_id, plan_year, month)
);


-- ---------------------------------------------------------------------
-- 3. INCENTIVE SCALES
--    kind: 'tire' (per day), 'credit_app' (count), 'car_increase'
--          (cars/day over last year — Model D only).
--    increment_above sits on the row that ANCHORS the overage rule, and
--    is null on every other row. For nearly every store that anchor is
--    the top tier, exactly as the task describes. Wesmark is the
--    exception: its tiers run 8/9/10/11 but its overage line still reads
--    "above 8", so the increment lands on its BOTTOM row. Seeded as
--    written and flagged — see bonus_flags.
-- ---------------------------------------------------------------------
create table if not exists public.bonus_incentive_tiers (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations (id) on delete cascade,
  plan_year       int  not null,
  kind            text not null check (kind in ('tire','credit_app','car_increase')),
  tier_index      int  not null,
  threshold       numeric(8,2)  not null,  -- tires/day, app count, or cars/day over LY
  payout          numeric(10,2) not null,
  increment_above numeric(10,2),           -- added per whole unit above THIS row's threshold
  unique (location_id, plan_year, kind, tier_index)
);

create index if not exists bonus_incentive_tiers_lookup
  on public.bonus_incentive_tiers (location_id, plan_year, kind, threshold);


-- ---------------------------------------------------------------------
-- 4. MONTHLY MANUAL INPUTS
--    google_reviews and phone_conversion_pct are NULL until somebody
--    types them — no system produces either today, and both feed real
--    money, so the screen shows them as unfilled rather than as zero.
--    referral_gp_credit is Model D's Midas referral credit: it adds into
--    the gross profit used for BONUS MATH ONLY and must never reach the
--    tic sheet, the Horizon upload, or any operational report.
-- ---------------------------------------------------------------------
create table if not exists public.bonus_monthly_inputs (
  location_id          uuid not null references public.locations (id) on delete cascade,
  plan_year            int  not null,
  month                int  not null check (month between 1 and 12),
  google_reviews       int,                              -- null = not entered
  phone_conversion_pct numeric(5,4),                     -- null = not entered; 0.40 waives the credit penalty
  referral_gp_credit   numeric(14,2) not null default 0, -- Model D only
  updated_by           uuid references auth.users (id),
  updated_at           timestamptz not null default now(),
  primary key (location_id, plan_year, month)
);


-- ---------------------------------------------------------------------
-- 5. THE PLANS THEMSELVES, AS DATA
--    "No thresholds, percentages or scales in code" applies to the model
--    rates too, so they live here rather than in bonusMath.js. These are
--    company-wide (not per store), so they are readable by every
--    authenticated user and carry no location scoping.
--
--    bonus_model_rates.role:
--      'pool'      Model A — the rate that builds the team pool, which
--                  bonus_model_splits then divides
--      'operator'  Model C — single recipient
--      'manager' / 'assistant'  Model B and D — paid directly
--    tier 'flat' means the model has no tiers (Model D).
-- ---------------------------------------------------------------------
create table if not exists public.bonus_model_rates (
  model char(1) not null check (model in ('A','B','C','D')),
  tier  text    not null check (tier in ('gold','silver','bronze','flat')),
  role  text    not null,
  pct   numeric(6,5) not null,
  primary key (model, tier, role)
);

insert into public.bonus_model_rates (model, tier, role, pct) values
  ('A','gold','pool',0.07000), ('A','silver','pool',0.05000), ('A','bronze','pool',0.04000),
  ('B','gold','manager',0.03000),   ('B','gold','assistant',0.01000),
  ('B','silver','manager',0.01500), ('B','silver','assistant',0.01000),
  ('C','gold','operator',0.04550), ('C','silver','operator',0.03250), ('C','bronze','operator',0.02600),
  ('D','flat','manager',0.03000)
on conflict (model, tier, role) do update set pct = excluded.pct;

-- Model A only: how the finished pool is divided.
create table if not exists public.bonus_model_splits (
  model      char(1) not null check (model in ('A','B','C','D')),
  role       text    not null,
  share      numeric(6,5) not null,
  sort_order int     not null,
  primary key (model, role)
);

insert into public.bonus_model_splits (model, role, share, sort_order) values
  ('A','General Manager',0.65000,1),
  ('A','Assistant Manager',0.25000,2),
  ('A','Service Advisor',0.10000,3)
on conflict (model, role) do update set share = excluded.share, sort_order = excluded.sort_order;

-- Scalars every handout repeats. Stored so a rate change is a data edit.
create table if not exists public.bonus_policy (
  key   text primary key,
  value numeric(12,4) not null,
  note  text
);

insert into public.bonus_policy (key, value, note) values
  ('google_per_review',        10,     'Dollars per five-star Google review'),
  ('google_min_reviews',       15,     'Minimum reviews before any Google payout'),
  ('google_cap_model_c',       1000,   'Model C only: maximum Google payout per month'),
  ('credit_penalty_per_app',   75,     'Dollars deducted per credit app below the floor'),
  ('credit_penalty_floor',     35,     'Credit app count below which the penalty accrues'),
  ('phone_conversion_waiver',  0.40,   'Model A: phone conversion that waives the credit penalty'),
  ('model_b_improvement_pct',  0.06,   'Model B: share of GP improvement over last year')
on conflict (key) do update set value = excluded.value, note = excluded.note;

alter table public.bonus_model_rates  enable row level security;
alter table public.bonus_model_splits enable row level security;
alter table public.bonus_policy       enable row level security;

do $do$
declare t text;
begin
  foreach t in array array['bonus_model_rates','bonus_model_splits','bonus_policy']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($f$create policy %I on public.%I for all to authenticated
                        using (public.current_user_role() = 'master')
                        with check (public.current_user_role() = 'master')$f$, t || '_write', t);
  end loop;
end
$do$;


-- ---------------------------------------------------------------------
-- 6. OPEN CONFLICTS — surfaced on screen, never silently resolved.
--    Seeded to the HANDOUT (the policy of record); each row names what
--    BDC has to confirm. `scope_location_id` is null for a conflict that
--    applies everywhere.
-- ---------------------------------------------------------------------
create table if not exists public.bonus_flags (
  code              text primary key,
  scope_location_id uuid references public.locations (id) on delete cascade,
  severity          text not null default 'info' check (severity in ('info','warn')),
  summary           text not null,
  detail            text not null
);


-- ---------------------------------------------------------------------
-- 7. RLS — read via can_access_location, write admin/master.
--    Bonus scales are set by the company, not by the store measured
--    against them. A store reads only its own rows (Task 6, item 10).
-- ---------------------------------------------------------------------
alter table public.bonus_plans            enable row level security;
alter table public.bonus_monthly_targets  enable row level security;
alter table public.bonus_incentive_tiers  enable row level security;
alter table public.bonus_monthly_inputs   enable row level security;
alter table public.bonus_flags            enable row level security;

do $do$
declare t text;
begin
  foreach t in array array['bonus_plans','bonus_monthly_targets','bonus_incentive_tiers','bonus_monthly_inputs']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format($f$create policy %I on public.%I for select to authenticated
                        using (public.can_access_location(location_id))$f$, t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format($f$create policy %I on public.%I for all to authenticated
                        using (public.current_user_role() in ('admin','master'))
                        with check (public.current_user_role() in ('admin','master'))$f$, t || '_write', t);
  end loop;
end
$do$;

-- Flags are advisory text about company policy; everyone reads a flag
-- that is global or scoped to a location they can already see.
drop policy if exists "bonus_flags_select" on public.bonus_flags;
create policy "bonus_flags_select" on public.bonus_flags for select to authenticated
  using (scope_location_id is null or public.can_access_location(scope_location_id));
drop policy if exists "bonus_flags_write" on public.bonus_flags;
create policy "bonus_flags_write" on public.bonus_flags for all to authenticated
  using (public.current_user_role() in ('admin','master'))
  with check (public.current_user_role() in ('admin','master'));


-- ---------------------------------------------------------------------
-- 8. SEED THE CONFLICTS (Task 6, Part 6)
-- ---------------------------------------------------------------------
insert into public.bonus_flags (code, scope_location_id, severity, summary, detail) values
  ('credit_kicker_amounts', null, 'warn',
   'Credit app kicker: handout governs, the Millwood workbook has been paying different numbers',
   'The handout pays $500 at 50 apps and $1,500 at 100, minimum Silver GP to qualify. Millwood''s workbook pays $500 over 50 and $1,000 over 90. Built to the handout. BDC to confirm which has been paid.'),
  ('credit_kicker_at_gold', null, 'warn',
   'The workbook drops the credit kicker at Gold — treated as a defect, not replicated',
   'The workbook''s Gold formula zeroes the credit kicker whenever projected GP clears Gold, so the best-performing stores lose it. The kicker is paid at Gold here. BDC to confirm.'),
  ('tire_scale_unusual', null, 'warn',
   'Three stores have tire scales well off the standard 5/6/7/8',
   'Lake Murray runs 16/17/18/19 and Two Notch 25/26/27/28 — internally consistent, so plausibly deliberate for high-volume stores. Wesmark runs 8/9/10/11 but its overage line still reads "above 8", which is not consistent. All three seeded as written.'),
  ('speedee_lexington_model', null, 'warn',
   'SpeeDee Lexington (3308) is seeded as Model D; BDC previously confirmed Model C',
   'The handout describes a flat 3% of GP to the store manager, no tire incentive, plus a car-increase-versus-last-year bonus and the Midas referral GP credit. That is not the Model C structure. These are different plans with different payouts and the difference is real money. Seeded as D; needs a decision.'),
  ('duplicate_handouts', null, 'info',
   'Decker and Pleasantburg each have two handout sheets; the Model B sheet is correct',
   'Both stores appear once in Model A format and once in Model B format. Model B is correct for both, which is what makes the counts work: 23 A + 9 B = 32 Midas. The Model A sheets are stale. Seeded as B.'),
  ('untracked_inputs', null, 'warn',
   'Five-star review counts and phone conversion are not tracked in any system',
   'Both feed real money — $10 per review above a 15-review minimum, and 40% phone conversion waives the credit-app penalty. The fields exist and are blank until someone enters them; they are shown as unfilled, never as a zero result.'),
  ('model_b_improvement_recipient', null, 'warn',
   'Model B: who receives the 6% GP improvement bonus is not stated',
   'The handout reads "***PLUS 6% OF ALL GP IMPROVEMENT OVER LAST YEAR***" without naming a recipient. Assigned to the store manager and flagged until confirmed.'),
  ('model_b_double_condition', null, 'warn',
   'Model B: "grow GP by 10.01%" is read as clearing the seeded +10.01% threshold',
   'The handout floors the "+10.01% LY" column at $35,000, so in a weak month that column exceeds a literal 10.01% growth over last year. The doubled credit-app and tire bonuses trigger on the same threshold that pays the 3% rate, so a store cannot get doubled bonuses without the higher rate. BDC to confirm.'),
  ('penalty_never_applied', null, 'warn',
   'Credit-app penalties are shown but not deducted from the pool',
   'The $75-per-app-below-35 deduction is calculated and displayed as its own line, with the resulting pool shown alongside, but it is not subtracted from the payout figures. Model A''s waiver depends on phone conversion, which nothing tracks. A tracker must not quietly reduce somebody''s expected pay.')
on conflict (code) do update set
  scope_location_id = excluded.scope_location_id,
  severity = excluded.severity,
  summary  = excluded.summary,
  detail   = excluded.detail;


-- =====================================================================
-- VERIFY
--   1) Plans land 23 / 9 / 3 / 1 after the seed runs:
--        select model, count(*) from public.bonus_plans
--          where plan_year = 2026 group by model order by model;
--   2) 432 monthly targets (36 stores x 12):
--        select count(*) from public.bonus_monthly_targets where plan_year = 2026;
--   3) Millwood July — budget 93,506.55, Gold 88,831.22, Silver 84,155.90,
--      Bronze 74,805.24, 26 days, car goal 16.7:
--        select * from public.bonus_monthly_targets
--          where location_id = (select id from public.locations where store_number='3303')
--            and plan_year = 2026 and month = 7;
--   4) Model B stores carry last_year_gp and no daily_car_goal:
--        select count(*) filter (where last_year_gp is not null) as ly,
--               count(*) filter (where daily_car_goal is not null) as cars
--          from public.bonus_monthly_targets t
--          join public.bonus_plans p using (location_id, plan_year)
--          where p.model = 'B' and t.plan_year = 2026;      -- 108, 0
--   5) The three unusual tire scales:
--        select l.store_number, t.threshold, t.payout, t.increment_above
--          from public.bonus_incentive_tiers t
--          join public.locations l on l.id = t.location_id
--          where t.kind = 'tire' and l.store_number in ('3979','3935','3938')
--          order by l.store_number, t.tier_index;
--   6) Nine conflicts are on file:
--        select code, severity from public.bonus_flags order by code;
-- =====================================================================
