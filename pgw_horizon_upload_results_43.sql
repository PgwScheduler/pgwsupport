-- =====================================================================
-- PGW Support Portal — the upload log records what happened
--                      (preview or send, and Horizon's reply)
-- Run AFTER pgw_sandbox_copy_millwood_july_42.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Until now horizon_upload_log said only whether an attempt was
-- AUTHORIZED. The horizon-upload Edge Function is gaining a send step,
-- so each authorized attempt now also records what it was used for:
--
--   purpose          'preview' (nothing left the portal) or 'send'
--   month            the month built
--   field_count      how many fields were built
--   fields_sha256    fingerprint of the fields (password excluded). A
--                    send must quote the fingerprint of the preview the
--                    admin approved, and is refused if the rebuilt fields
--                    differ -- so what goes out is exactly what was seen.
--   auth_tier        'none' or 'username' -- which HTTP login Horizon
--                    accepted (the macro's MSXML only sends its login
--                    when Horizon answers 401)
--   response_status  Horizon's HTTP status (200 = the macro's success)
--   response_body    Horizon's reply, first 4000 characters
--   completed_at     when the result was recorded
--
-- Written ONLY by horizon_record_result(), service_role only, and only
-- once per attempt. The password is never an input and never stored.
--
-- RULES horizon_record_result() ENFORCES
--   * the attempt exists and was authorized;
--   * a result is recorded once -- a second call raises;
--   * a result with an HTTP status (something was transmitted) requires
--     the attempt to have released its credentials: nothing reaches
--     Horizon without a password, so a status without a release means
--     the caller is lying or broken;
--   * a PREVIEW never has a status or a release.
--
-- AND horizon_release_credentials() now refuses an attempt that already
-- has a recorded purpose, so a preview can never become a send.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. COLUMNS
-- ---------------------------------------------------------------------
alter table public.horizon_upload_log
  add column if not exists purpose         text,
  add column if not exists month           date,
  add column if not exists field_count     int,
  add column if not exists fields_sha256   text,
  add column if not exists auth_tier       text,
  add column if not exists response_status int,
  add column if not exists response_body   text,
  add column if not exists completed_at    timestamptz;

alter table public.horizon_upload_log drop constraint if exists hul_purpose_valid;
alter table public.horizon_upload_log add constraint hul_purpose_valid
  check (purpose is null or purpose in ('preview', 'send'));

alter table public.horizon_upload_log drop constraint if exists hul_auth_tier_valid;
alter table public.horizon_upload_log add constraint hul_auth_tier_valid
  check (auth_tier is null or auth_tier in ('none', 'username'));

alter table public.horizon_upload_log drop constraint if exists hul_month_is_first;
alter table public.horizon_upload_log add constraint hul_month_is_first
  check (month is null or extract(day from month) = 1);

comment on column public.horizon_upload_log.purpose is
  'What the authorized attempt was used for: preview (nothing sent) or send. Null = authorized but never used, or refused.';
comment on column public.horizon_upload_log.fields_sha256 is
  'SHA-256 of the built fields with the password replaced by a marker. A send must match the fingerprint of the preview the admin approved.';
comment on column public.horizon_upload_log.response_status is
  'Horizon''s HTTP status for a send. Null for a preview, or for a send that failed before any reply.';


-- ---------------------------------------------------------------------
-- 2. horizon_record_result() — service_role only
-- ---------------------------------------------------------------------
create or replace function public.horizon_record_result(
  p_attempt_id    bigint,
  p_purpose       text,
  p_month         date,
  p_field_count   int,
  p_fields_sha256 text,
  p_auth_tier     text,
  p_status        int,
  p_body          text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_log public.horizon_upload_log%rowtype;
begin
  select * into v_log
    from public.horizon_upload_log
   where id = p_attempt_id
   for update;

  if not found then
    raise exception 'Upload attempt % does not exist.', p_attempt_id using errcode = '42704';
  end if;
  if v_log.outcome <> 'authorized' then
    raise exception 'Upload attempt % was refused; there is no result to record.', p_attempt_id
      using errcode = '42501';
  end if;
  if v_log.purpose is not null then
    raise exception 'Upload attempt % already has a recorded %.', p_attempt_id, v_log.purpose
      using errcode = '23505';
  end if;
  if p_purpose = 'preview'
     and (p_status is not null or p_auth_tier is not null or v_log.credential_released_at is not null) then
    raise exception 'A preview sends nothing: no status, no login tier, no released credentials.'
      using errcode = '22023';
  end if;
  if p_status is not null and v_log.credential_released_at is null then
    raise exception 'Attempt % never released credentials, so Horizon cannot have replied to it.', p_attempt_id
      using errcode = '22023';
  end if;

  update public.horizon_upload_log
     set purpose         = p_purpose,
         month           = p_month,
         field_count     = p_field_count,
         fields_sha256   = p_fields_sha256,
         auth_tier       = p_auth_tier,
         response_status = p_status,
         response_body   = left(p_body, 4000),
         completed_at    = now()
   where id = p_attempt_id;
end
$fn$;

revoke all on function public.horizon_record_result(bigint, text, date, int, text, text, int, text)
  from public, anon, authenticated;
grant execute on function public.horizon_record_result(bigint, text, date, int, text, text, int, text)
  to service_role;


-- ---------------------------------------------------------------------
-- 3. horizon_release_credentials() -- migration 41's body, plus one rule:
--    an attempt that already has a recorded purpose releases nothing.
--    Same signature, so this replaces it; grants restated.
-- ---------------------------------------------------------------------
create or replace function public.horizon_release_credentials(
  p_attempt_id bigint
)
returns table (shop_number text, password text, front_staff_slot smallint,
               location_id uuid, is_sandbox boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_log      public.horizon_upload_log%rowtype;
  v_shop     text;
  v_sandbox  boolean;
  v_only     boolean;
  v_fs_slot  smallint;
  v_fs_count int;
  v_pw       text;
begin
  -- Lock the row so two concurrent calls cannot both release it.
  select * into v_log
    from public.horizon_upload_log
   where id = p_attempt_id
   for update;

  if not found then
    raise exception 'Upload attempt % does not exist.', p_attempt_id using errcode = '42704';
  end if;
  if v_log.outcome <> 'authorized' then
    raise exception 'Upload attempt % was refused; no credentials are released for it.', p_attempt_id
      using errcode = '42501';
  end if;
  if v_log.credential_released_at is not null then
    raise exception 'Upload attempt % already released its credentials at %. Start a new upload.',
      p_attempt_id, v_log.credential_released_at using errcode = '42501';
  end if;
  -- NEW in 43: an attempt already recorded (a preview, or a send that
  -- was stopped before release) never releases a password afterwards.
  if v_log.purpose is not null then
    raise exception 'Upload attempt % was already recorded as a %; no credentials are released for it.',
      p_attempt_id, v_log.purpose using errcode = '42501';
  end if;
  if v_log.attempted_at < now() - interval '2 minutes' then
    raise exception 'Upload attempt % is older than 2 minutes. Start a new upload.', p_attempt_id
      using errcode = '42501';
  end if;

  -- Re-check live state: any of it may have changed since the attempt.
  select l.horizon_shop_number, l.is_sandbox into v_shop, v_sandbox
    from public.locations l where l.id = v_log.location_id;

  if v_shop is null or v_shop is distinct from v_log.shop_number
     or v_sandbox is distinct from v_log.is_sandbox then
    raise exception 'The location''s Horizon shop or sandbox flag changed since attempt %. Start a new upload.', p_attempt_id
      using errcode = '42501';
  end if;

  select c.upload_sandbox_only into v_only
    from public.horizon_config c where c.id;
  if coalesce(v_only, true) and not v_sandbox then
    raise exception 'Portal uploads are limited to the sandbox; no password is released for a real store.'
      using errcode = '42501';
  end if;

  select count(*), min(s.slot_number) into v_fs_count, v_fs_slot
    from public.location_horizon_slots s
   where s.location_id = v_log.location_id
     and s.is_reserved and s.reservation_kind = 'front_staff';
  if v_fs_count <> 1 then
    raise exception 'Location now has % Front Staff reservations, expected exactly 1.', v_fs_count
      using errcode = '42501';
  end if;

  select d.decrypted_secret into v_pw
    from vault.decrypted_secrets d
   where d.name = 'horizon_password:' || v_shop;

  if v_pw is null or v_pw = '' then
    raise exception 'No Horizon password is stored for shop %. Add a Vault secret named horizon_password:%.', v_shop, v_shop
      using errcode = 'P0002';
  end if;

  update public.horizon_upload_log
     set credential_released_at = now()
   where id = p_attempt_id;

  shop_number      := v_shop;
  password         := v_pw;
  front_staff_slot := v_fs_slot;
  location_id      := v_log.location_id;
  is_sandbox       := v_sandbox;
  return next;
end
$fn$;

revoke all on function public.horizon_release_credentials(bigint) from public, anon, authenticated;
grant execute on function public.horizon_release_credentials(bigint) to service_role;


-- =====================================================================
-- VERIFY — in the SQL Editor
--
--  [1] The new columns exist (8 rows):
--        select column_name from information_schema.columns
--         where table_name = 'horizon_upload_log'
--           and column_name in ('purpose','month','field_count','fields_sha256',
--                               'auth_tier','response_status','response_body','completed_at');
--
--  [2] Only service_role can record (false, false):
--        select has_function_privilege('authenticated',
--                 'public.horizon_record_result(bigint,text,date,int,text,text,int,text)', 'execute'),
--               has_function_privilege('anon',
--                 'public.horizon_record_result(bigint,text,date,int,text,text,int,text)', 'execute');
--
--  [3] Earlier attempts are untouched (purpose still null on all):
--        select count(*) filter (where purpose is null), count(*)
--          from public.horizon_upload_log;          -- both numbers equal
-- =====================================================================
