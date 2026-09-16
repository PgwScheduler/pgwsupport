-- =====================================================================
-- PGW Support Portal — Value Service's Horizon shop number is 6306006
-- Run AFTER pgw_horizon_upload_results_43.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Migration 38 seeded Value Service (the sandbox) with shop number
-- 'b306006', taken from the Brief 38 table. That is wrong: the shop
-- number Horizon knows is '6306006' (confirmed by the user against the
-- real Horizon login, 2026-09-16).
--
-- How it surfaced: the first sandbox send (attempt #20) went out as
-- data[SHOP_STORENUMBER]=b306006 and Horizon answered "Error: Password
-- not accepted." Nothing was imported. The user has since added the
-- correct Vault secret, named horizon_password:6306006.
--
-- The upload path finds the password by the location's shop number
-- ('horizon_password:' || horizon_shop_number), and sends that shop
-- number, so the location row is the one thing to change.
--
-- GUARDS -- the file stops with nothing changed unless:
--   * there is exactly one sandbox location;
--   * its shop number is 'b306006' (or already '6306006', a re-run);
--   * no other location already claims '6306006';
--   * a Vault secret named exactly 'horizon_password:6306006' exists
--     (read by NAME from vault.secrets; nothing is decrypted). This ties
--     the location to what was actually entered in Vault, so a typo in
--     either place stops here rather than at Horizon.
--
-- ALSO: the sandbox-only switch's reason text (migration 40) names the
-- sandbox's shop number, so it is corrected too.
--
-- NOT DONE HERE: deleting the old Vault secret
-- 'horizon_password:b306006'. Once this runs nothing reads it, but it
-- still holds a password. Remove it in the Dashboard (Integrations ->
-- Vault -> Secrets -> the row's menu -> Delete), or with the statement
-- printed at the bottom. Deleting is yours to do, deliberately.
--
-- ⚠ Re-running migration 38's seed section would set the shop number
-- back to 'b306006'. Do not re-run 38; if it ever is, run this again.
-- =====================================================================

do $$
declare
  v_n    int;
  v_loc  uuid;
  v_shop text;
begin
  select count(*), min(id::text)::uuid into v_n, v_loc
    from public.locations where is_sandbox;
  if v_n <> 1 then
    raise exception 'Expected exactly one sandbox location, found %. Nothing changed.', v_n;
  end if;

  select horizon_shop_number into v_shop from public.locations where id = v_loc;
  if v_shop is distinct from 'b306006' and v_shop is distinct from '6306006' then
    raise exception 'Value Service''s shop number is %, expected b306006 (or 6306006 on a re-run). Nothing changed.',
      coalesce(v_shop, 'NULL');
  end if;

  if exists (select 1 from public.locations
              where horizon_shop_number = '6306006' and id <> v_loc) then
    raise exception 'Another location already has shop number 6306006. Nothing changed.';
  end if;

  if not exists (select 1 from vault.secrets where name = 'horizon_password:6306006') then
    raise exception 'No Vault secret is named exactly horizon_password:6306006. Check the name in Integrations -> Vault (lower case, colon, no spaces). Nothing changed.';
  end if;

  update public.locations
     set horizon_shop_number = '6306006'
   where id = v_loc;

  update public.horizon_config
     set upload_lock_reason = replace(upload_lock_reason, '(Value Service, b306006)', '(Value Service, 6306006)'),
         updated_at = now()
   where id and upload_lock_reason like '%(Value Service, b306006)%';

  raise notice 'Value Service now uses Horizon shop number 6306006 (was %).', v_shop;
end
$$;


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The sandbox's shop number:
--        select name, is_sandbox, horizon_shop_number
--          from public.locations where is_sandbox;
--      One row: Value Service / true / 6306006.
--
--  [2] The switch's reason names the right shop:
--        select upload_lock_reason from public.horizon_config;
--      ... (Value Service, 6306006) ...
--
--  [3] Both Vault entries, by name only (nothing is decrypted):
--        select name, updated_at from vault.secrets
--         where name like 'horizon_password:%' order by name;
--      horizon_password:b306006  (old, unused -- delete it)
--      horizon_password:6306006 (new, in use)
--
--  To delete the old entry from the SQL Editor instead of the Dashboard:
--        delete from vault.secrets where name = 'horizon_password:b306006';
--      Then [3] shows only the 6306006 row.
-- =====================================================================
