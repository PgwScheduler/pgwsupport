-- =====================================================================
-- Migration 87 — RPC lockdown: no function runs for a caller with no role
-- Run AFTER pgw_announcements_86.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Why: the Supabase security advisor, 2026-10-12. Every function in
-- public was callable through /rest/v1/rpc by the anon key (which ships
-- in the front-end bundle), and admin-only functions guard themselves
-- with
--     if public.current_user_role() not in ('admin','master') then raise
-- For a caller with no role, current_user_role() is NULL, NULL not in
-- (...) is NULL, and IF NULL does not fire -- the guard waves them in.
--   * anon (no login at all): prior_year_actuals_import and
--     tech_reassign_slot ran with no other check.
--   * a signed-in login with no role yet (handle_new_user creates the
--     profile with role NULL): the same, plus the Horizon slot /
--     reservation / upload-target / credential-status functions.
--
-- THE FIX, in two independent layers
--   1. current_user_role() returns '' (not NULL) for a SIGNED-IN user
--      with no role, so every `not in (...)` / `<> 'master'` guard now
--      refuses them. It still returns NULL when there is no signed-in
--      user at all (SQL Editor, cron, service_role Edge Functions):
--      the trigger guards (guard_labor_sales, guard_sales_required,
--      guard_legacy_weekly_hours) rely on that to let backend loads
--      through, and that behaviour is unchanged.
--   2. anon loses EXECUTE on every function in public. Nothing in the
--      portal calls an RPC before sign-in (login, reset and invite all
--      go through the Auth API). PUBLIC loses it too -- anon inherits
--      PUBLIC, so revoking anon alone is a no-op -- and authenticated /
--      service_role are re-granted exactly where they had it before, so
--      no signed-in screen or Edge Function changes.
--      Trigger functions also lose EXECUTE for authenticated: a trigger
--      fires regardless of the caller's EXECUTE privilege (Postgres
--      checks it only at CREATE TRIGGER), and they can't be called as
--      RPCs anyway -- this just clears them from the advisor.
--   3. Default privileges: functions created by later migrations start
--      without anon/PUBLIC execute, and with authenticated/service_role.
--
-- NOT CHANGED
--   * pg_net stays in public (moving it risks the cron -> Edge Function
--     calls; the advisor rates it low).
--   * Leaked-password protection is a dashboard toggle, not SQL:
--     Authentication -> Sign In / Providers -> Email -> "Prevent use of
--     leaked passwords".
--   * The "signed-in users can execute SECURITY DEFINER" warnings on the
--     portal's own RPCs are by design: each checks role/location inside.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. current_user_role(): '' for a signed-in user with no role
-- ---------------------------------------------------------------------
create or replace function public.current_user_role()
returns text language sql stable security definer set search_path = '' as $$
  select case
           when auth.uid() is null then null          -- backend: no JWT user
           else coalesce((select p.role from public.profiles p where p.id = auth.uid()), '')
         end;
$$;


-- ---------------------------------------------------------------------
-- 2. Strip anon / PUBLIC execute from every function in public,
--    preserving authenticated and service_role access exactly.
--    Skips extension-owned functions and any function this role can't
--    manage (section 4 lists anything left over).
-- ---------------------------------------------------------------------
do $$
declare
  f        record;
  had_auth boolean;
  had_svc  boolean;
begin
  for f in
    select p.oid,
           p.oid::regprocedure                                        as sig,
           p.prorettype in ('trigger'::regtype, 'event_trigger'::regtype) as is_trigger
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind in ('f', 'p')
       and pg_has_role(p.proowner, 'USAGE')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass
                          and d.objid = p.oid
                          and d.deptype = 'e')
  loop
    had_auth := has_function_privilege('authenticated', f.oid, 'EXECUTE');
    had_svc  := has_function_privilege('service_role',  f.oid, 'EXECUTE');

    execute format('revoke execute on function %s from public, anon', f.sig);

    if f.is_trigger then
      execute format('revoke execute on function %s from authenticated', f.sig);
    elsif had_auth then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;

    if had_svc then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- 3. Future functions (created by this role in public)
--    PUBLIC's execute is a GLOBAL default, and a per-schema default can
--    only add to the global one, never take away -- so that revoke has
--    no `in schema`. anon's grant is Supabase's per-schema default.
-- ---------------------------------------------------------------------
alter default privileges                  revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public grant  execute on functions to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 4. CHECK -- expect zero rows. Any row is a public function anon can
--    still execute (e.g. one owned by a Supabase-internal role).
-- ---------------------------------------------------------------------
select p.oid::regprocedure as still_anon_executable,
       pg_get_userbyid(p.proowner) as owner
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.prokind in ('f', 'p')
   and has_function_privilege('anon', p.oid, 'EXECUTE')
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass
                      and d.objid = p.oid
                      and d.deptype = 'e')
 order by 1;
