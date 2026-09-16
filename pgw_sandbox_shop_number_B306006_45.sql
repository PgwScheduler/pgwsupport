-- =====================================================================
-- PGW Support Portal — Value Service's Horizon shop number is B306006
--                                          (corrects migration 44)
-- Run AFTER pgw_sandbox_shop_number_fix_44.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- The sandbox's importer id, CONFIRMED WITH HORIZON on 2026-09-16, is
-- 'B306006' -- capital B.
--
-- The trail, so nobody repeats it:
--   38  seeded 'b306006' (Brief 38)       send #20 -> "Error: Password
--                                          not accepted."  The store was
--                                          found; the password was wrong.
--   44  changed it to '6306006'           send #23 -> "Error: Store not
--                                          found in system."
--   45  'B306006', per Horizon, with the new password in Vault under
--       horizon_password:B306006.
-- Nothing was imported by either failed send.
--
-- The upload path finds the password by the location's shop number
-- ('horizon_password:' || horizon_shop_number) and sends that shop
-- number, so the location row is the one thing to change. The name
-- match is EXACT and case-sensitive, like the value Horizon checks.
--
-- GUARDS -- the file stops with nothing changed unless:
--   * there is exactly one sandbox location;
--   * its shop number is one of the values it has held
--     ('6306006', 'b306006') or already 'B306006' (a re-run);
--   * no other location already claims 'B306006';
--   * a Vault secret named exactly 'horizon_password:B306006' exists
--     (checked by NAME in vault.secrets; nothing is decrypted).
--
-- The sandbox-only switch's reason text names the shop, so it is
-- corrected too.
--
-- NOT DONE HERE: deleting the Vault secrets nothing reads any more --
-- any of horizon_password:b306006, :b6306006, :6306006 that still
-- exist. The statement is at the bottom; deleting is yours to do.
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
  if v_shop is null or v_shop not in ('6306006', 'b306006', 'B306006') then
    raise exception 'Value Service''s shop number is %, expected 6306006 or b306006 (or B306006 on a re-run). Nothing changed.',
      coalesce(v_shop, 'NULL');
  end if;

  if exists (select 1 from public.locations
              where horizon_shop_number = 'B306006' and id <> v_loc) then
    raise exception 'Another location already has shop number B306006. Nothing changed.';
  end if;

  if not exists (select 1 from vault.secrets where name = 'horizon_password:B306006') then
    raise exception 'No Vault secret is named exactly horizon_password:B306006 (capital B, no spaces). Check the name in Integrations -> Vault. Nothing changed.';
  end if;

  update public.locations
     set horizon_shop_number = 'B306006'
   where id = v_loc;

  update public.horizon_config
     set upload_lock_reason = regexp_replace(upload_lock_reason,
                                             '\(Value Service, [^)]*\)',
                                             '(Value Service, B306006)'),
         updated_at = now()
   where id and upload_lock_reason ~ '\(Value Service, [^)]*\)'
     and upload_lock_reason not like '%(Value Service, B306006)%';

  raise notice 'Value Service now uses Horizon shop number B306006 (was %).', v_shop;
end
$$;


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The sandbox's shop number:
--        select name, is_sandbox, horizon_shop_number
--          from public.locations where is_sandbox;
--      One row: Value Service / true / B306006.
--
--  [2] The switch's reason names the right shop (true):
--        select upload_lock_reason like '%(Value Service, B306006)%'
--          from public.horizon_config;
--
--  [3] Vault entries, by name only (nothing is decrypted):
--        select name, updated_at from vault.secrets
--         where name like 'horizon_password:%' order by name;
--      horizon_password:B306006 is the one in use.
--
--  To delete the entries nothing reads any more (only these names;
--  B306006 is untouched because the match is case-sensitive):
--        delete from vault.secrets
--         where name in ('horizon_password:b306006',
--                        'horizon_password:b6306006',
--                        'horizon_password:6306006');
--      Then [3] shows only horizon_password:B306006.
-- =====================================================================
