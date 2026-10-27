-- =====================================================================
-- Migration 93 — Parts Recon: "No PO – stock order?" AP to-do
-- Run AFTER pgw_parts_recon_other_bills_92.sql, in the SQL Editor.
-- Safe to re-run (idempotent).
-- =====================================================================
-- Why: the user, 2026-10-27 (PO cleanup). A vendor charge whose PO is
-- blank is never matched to an RO. It goes to My AP To-Do with the
-- status "No PO – stock order?" instead of the store's list. (Oviedo
-- US AutoForce INV0019625227, a 6-tire stock order, is the example.)
--
-- The scripts now give those charges their own RO Cost Check status,
-- "NO PO - STOCK ORDER?", and the portal import turns each one into an
-- AP to-do of the new kind 'no_po'. This only widens the list of task
-- kinds; no function or policy changes, no new table (so no grants).
--
-- A PO that isn't blank and isn't an RO # ("RUSH", "RGN 245893", a
-- name) still goes to review as 'no_ro_on_statement', as before.
-- =====================================================================

alter table public.parts_recon_ap_tasks drop constraint if exists parts_recon_ap_tasks_kind_check;
alter table public.parts_recon_ap_tasks
  add constraint parts_recon_ap_tasks_kind_check check (kind in ('bill_not_in_ap','credit_not_in_ap','amount_diff','wrong_supplier',
                                                                 'sales_tax','ap_not_on_statement','unassigned','warranty_addback',
                                                                 'ro_not_on_parts_detail','no_ro_on_statement','no_po'));
