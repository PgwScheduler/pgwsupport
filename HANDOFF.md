# PGW Support Portal — Session Handoff

Recap of everything done so far, for picking up in a fresh Claude Code chat.
See `CLAUDE.md.txt` in this same folder for the original project brief —
that's still the source of truth for business rules (deposit-sheet math,
org hierarchy, roles, ground rules). This file just tracks what's been
*built* against that brief.

## Where things live

- **Frontend app**: `pgw-portal/` — Vite + React + Tailwind, deployed to Vercel
- **Database migrations**: SQL files in the repo root, numbered `01`–`18`, run in order in the Supabase SQL Editor. All 18 have been applied.
- **GitHub repo**: `https://github.com/PgwScheduler/pgwsupport` (branch `main`)
- **Production URL**: `https://pgwsupport.vercel.app` (temporary Vercel URL — custom domain `pgwsupport.com` deliberately not configured yet, per instruction)
- **Local dev**: `cd pgw-portal && npm install && npm run dev` (needs `pgw-portal/.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — see `.env.example`)

## Database migrations (all applied, in order)

1. `pgw_portal_schema_01.sql` — base tables, RLS, storage bucket, new-user trigger (pre-existing before this session)
2. `pgw_portal_regions_upgrade_02.sql` — regions/districts hierarchy, `can_access_location()` (pre-existing)
3. `pgw_portal_seed_3.sql` — 3 regions, 5 districts, 36 stores (pre-existing)
4. `pgw_add_store_number_04.sql` / `pgw_populate_store_numbers_05.sql` — store numbers (pre-existing)
5. `pgw_add_drawer_float_06.sql` — `locations.drawer_float`, defaults $200, $400 for store #3935 (Two Notch)
6. `pgw_employee_hours_weekly_07.sql` — rewrote `employee_hours` from daily to weekly (mon–sat columns + `hours_turned`); RLS lets store managers update/delete their own store's rows (not just master)
7. `pgw_cash_drawer_rewrite_08.sql` — rewrote `cash_drawer_closeouts` to store the full deposit sheet (denomination counts as jsonb, all sales-summary fields, 4 variable-length line-item arrays as jsonb). Computed totals are **never stored**, only derived on read.
8. `pgw_training_library_09.sql` — new `training` table + storage bucket, company-wide (no `location_id`), everyone reads, admin/master write
9. `pgw_documents_folders_10.sql` — added `parent_id` + `item_type` to `documents` for nested folders
10. `pgw_drop_daily_closeouts_11.sql` — dropped the unused `daily_closeouts` table
11. `pgw_employee_hours_notes_12.sql` — added a free-text `notes` column to `employee_hours` (e.g. "covering from store #3936")
12. `pgw_profiles_email_13.sql` — mirrors `auth.users.email` onto `profiles.email` (via the signup trigger + a backfill), so the User Management screen can list users without needing Supabase's admin API
13. `pgw_employee_hours_payroll_rebuild_14.sql` — replaced the weekly `employee_hours` grid with the full payroll model: `employees`, `timesheet_entries` (store-visible) and the pay tables `employee_pay_rates` + `timesheet_pay` (**master/admin-only RLS — a store SELECT returns zero rows**). Pay is derived on read; stores see only percentages via the `payroll_pct_summary()` SECURITY DEFINER function. `employee_hours` dropped.
14. `pgw_flat_flags_for_store_15.sql` — flat-rate-vs-hourly flag helper used by the payroll percentage view.
15. `pgw_speedee_brand_16.sql` — made payroll brand-aware. Added **`locations.brand`** (`'midas'`/`'speedee'`, default midas) and set stores **3009/3025/3029/3308 → speedee**; split `timesheet_entries` into shared core + `timesheet_midas`/`timesheet_speedee`; added `brand_settings`, `role_sales_rates`, `store_week_sales`, and the `payroll_speedee_summary()` RPC.
16. `pgw_employee_schedules_17.sql` — `employee_schedules` (per-store shift calendar, timezone-naive `date`+`time`, no overnight shifts). Access via `can_access_location()`; references only the `employees` roster, never pay data.
17. `pgw_daily_tic_sheet_18.sql` — **Daily Tic Sheet.** Reference tables `service_categories` + `brand_service_categories` (seeded with the 29 Midas categories, `display_order` 10..290; `horizon_key` values are the external system's exact field names). Data tables `daily_kpi` (one row per store per `business_date`) + `daily_service_units`. Uses `location_id uuid → locations(id)` (there is no bigint `stores` table); does **not** re-add `brand` (already present from migration 16). RLS mirrors the cash-drawer tables — read/insert/update via `can_access_location(location_id)`, delete master-only, child units resolved through the parent row; the two reference tables are readable by all authenticated users and **master-only** to write.

## Frontend build order

1. **App shell** — Vite/React/Tailwind scaffold, real Supabase email/password auth (`AuthProvider.jsx`), role-scoped store picker, sidebar/header/breadcrumb (`Shell.jsx`). "Preview as" role switcher removed — role comes from the logged-in profile.
2. **Payroll** (`HoursView.jsx` / `SpeedeeHoursView.jsx`, `usePayroll.js`, `lib/payrollMath.js`) — brand-aware weekly payroll (nav tab renamed "Employee Hours" → "Payroll"). Follows `store.brand`; pay rates/dollars never reach a store user (enforced by RLS, not the UI), stores see percentages only. CSV/print/xlsx export.
3. **Cash Drawer** (`components/drawer/*`) — full deposit-sheet form (denomination counts, daily sales summary, over/short, 4 line-item tables), saved-closeouts list, read-only detail modal, CSV/summary-CSV/print export. All math in `lib/drawerMath.js`, matches the original Excel formulas exactly (including the two "known quirks" — `poa_checks_total` feeds nothing, `sales_tax` doesn't flow into `total_sales`).
4. **Documents** (`DocumentsView.jsx`) — per-store folder tree, upload/open/delete, built on a reusable `FileBrowser.jsx` + `useFileLibrary.js` hook.
5. **Training** (`TrainingView.jsx`) — same `FileBrowser`/`useFileLibrary` reused with no `locationId` (shared across all stores), write access restricted to admin/master.
6. **Dashboard** (`DashboardView.jsx`) — latest cash drawer closeout, this week's hours, document count, recent-activity feed.
7. **User Management** (`components/users/UsersView.jsx`, master-only) — list all users, create logins, assign role + store/district/region, revoke access. Notable design choice: **no `service_role` key anywhere in this app.** Creating a user goes through a throwaway Supabase client (`persistSession: false`) so it never disturbs the master's own session; a random temp password is shown once. Revoking access just clears role/scope (RLS then denies everywhere) rather than deleting the Supabase Auth login.
8. **Employee Schedule** (`components/schedule/*`, `useSchedule.js`) — per-store monthly shift calendar, add/edit/delete shifts against the `employees` roster. No pay data.
9. **Daily Tic Sheet** (`TicSheetView.jsx`, `useDailyKpi.js`) — Midas store manager's end-of-day entry. One store, one date (defaults today, date picker capped at today). A keyboard-fast service-units grid in `display_order` (29 Midas categories; tab moves field to field, blank = 0) plus the 11-field day summary (repair orders, labor/parts/tire/discount/other sales, parts/tire cost, declined sales, credit apps, credit dollars). **Save** persists any time; **Submit** stamps `submitted_at` but the day stays editable (records `updated_by`/`updated_at`). Loads by `(location_id, business_date)`, upserts unit rows. Category list comes from the store's brand — a SpeeDee store shows an empty list with a message, which is acceptable for now. Scope is data entry only: no goals, bonuses, technician entry, pay math, or uploads. Verified live as a store user: 29 categories in order, save→reload round-trip, per-date loading, cross-store read/insert denied by RLS (403 `42501`), and `service_categories` insert/update denied for non-master.
10. **Deployment** — GitHub repo created, pushed, Vercel project imported with Root Directory set to `pgw-portal`, env vars configured, auto-deploys on push to `main`.

## Bugs found and fixed along the way

- **`Card` didn't forward `onClick`** (`ui.jsx`) — broke the Add User modal's click-outside-to-close, since every click inside the modal (including the email field) bubbled to the backdrop and closed it. Fixed by spreading `...rest` props onto `Card`'s div.
- **Vercel env vars never applied to Production** — they were added but no redeploy was triggered (Vite bakes `VITE_*` vars in at build time). Fixed by redeploying after confirming the vars were set.
- **Supabase Site URL still `localhost`** — new-user confirmation emails redirected to a dead `localhost` URL instead of the production app. Needs fixing in Supabase dashboard → Authentication → URL Configuration (Site URL + Redirect URLs should be `https://pgwsupport.vercel.app`). Confirmed the email *confirmation itself* still succeeds server-side even with the bad redirect — affected users can just go straight to the login page and sign in.
- **`@pgwsupport.com` is not a real domain** — it was only ever placeholder text in the login screen's example (`you@pgwsupport.com`). Real company domain is `pgwus.com`. Supabase's signup validation rejects the fake domain; several `*_TEST@pgwsupport.com` accounts in the users list were inserted directly via SQL (bypassing that validation), not through real signups.
- **User Management row state didn't resync after save/revoke** — a row's local role/scope dropdowns kept showing stale values until a full page reload. Fixed with a `useEffect` that resyncs from the server value.

## Known gaps / things not yet built

- No delete-user (only revoke-access, which keeps the Supabase Auth login intact but strips all access) — a true delete would need a `service_role` key in a serverless function, deliberately avoided so far.
- No password-change / forgot-password UI for end users yet.
- Custom domain (`pgwsupport.com`) not configured on Vercel — deliberate, per instruction to test on the temporary URL first.
- The brief's "Upgrade once live" export items — cross-store/date-range exports for admins/payroll, real `.xlsx` output — not started.
- Local dev sessions in the Browser pane tool have repeatedly lost `localStorage` (and thus the login session) between turns — not an app bug, just a quirk of the sandboxed browser tool; re-login is needed each time this happens.

## How to verify things still work

Master login: `hallen@pgwus.com` (password known to the user). After signing in, all tabs should be visible (Dashboard, Training, Cash Drawer, Daily Tic Sheet, Payroll, Employee Schedule, Documents, and Users for master) with the store picker showing all 36 stores.

For the Daily Tic Sheet specifically: on a Midas store the Service Units grid shows exactly 29 categories in `display_order`; enter numbers → Save → reload shows the same values; a previous date loads that day's data. Cross-store isolation and the master-only reference tables are enforced by Postgres RLS (verified: a store user gets a 403 `42501` inserting another store's `daily_kpi`, and cannot write `service_categories`).
