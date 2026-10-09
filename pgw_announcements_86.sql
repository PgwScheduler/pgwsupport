-- =====================================================================
-- Migration 86 — Announcements: a home-office bulletin with read receipts
-- Run AFTER pgw_bonus_rollover_fix_85a.sql, in the SQL Editor.
-- Safe to re-run (idempotent throughout).
-- =====================================================================
-- Why: the user, 2026-10-09. A banner / bulletin for each store, with a
-- "read" receipt, that can point at an item in the Training library.
--
-- USER DECISIONS
--   * READ = OPENED. An announcement counts as read for a login the
--     first time that login opens it (from the banner or the
--     Announcements screen). There is no separate "I agree" button.
--   * RECEIPTS PER LOGIN, ROLLED UP BY STORE: one row per person; the
--     home office sees "#3303: 1 of 2 logins read -- Jane, 10/9".
--   * WHO POSTS: master, admin and office to any store; district and
--     regional managers only to stores they manage.
--   * EMAIL: optional per announcement, to each targeted store's
--     Directory email (locations.store_email), sent by the Edge Function
--     announcement-email through Resend.
--
-- SHAPE
--   announcements            the message; priority normal|important;
--                            optional training_id; optional expiry;
--                            archived_at hides it everywhere.
--   announcement_locations   the stores it was sent to, fixed when
--                            posted (a store that moves district later
--                            keeps what it was sent).
--   announcement_reads       (announcement, user) -> first opened.
--
-- WHO SEES ONE: anyone who can see at least one of its stores
-- (can_access_location -- so a DM sees what went to their stores --
-- or, for office, office_can_read), and its author. All reads and writes
-- go through the functions below; the tables have no direct write path.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------
create table if not exists public.announcements (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (length(trim(title)) between 1 and 200),
  body            text not null default '' check (length(body) <= 10000),
  priority        text not null default 'normal' check (priority in ('normal','important')),
  training_id     uuid references public.training (id) on delete set null,
  audience_label  text not null default '' check (length(audience_label) <= 200),
  starts_at       timestamptz not null default now(),
  expires_at      timestamptz,
  created_by      uuid references auth.users (id) on delete set null,
  created_by_name text,                    -- snapshot: the name at posting time
  created_by_role text,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  archived_at     timestamptz,
  email_requested boolean not null default false,
  emailed_at      timestamptz,
  email_result    jsonb,
  check (expires_at is null or expires_at > starts_at)
);

create table if not exists public.announcement_locations (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  location_id     uuid not null references public.locations (id) on delete cascade,
  primary key (announcement_id, location_id)
);
create index if not exists announcement_locations_loc on public.announcement_locations (location_id);

create table if not exists public.announcement_reads (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

alter table public.announcements          enable row level security;
alter table public.announcement_locations enable row level security;
alter table public.announcement_reads     enable row level security;
-- No policies: nothing is read or written directly. Every path is a
-- definer function that applies the visibility and posting rules.


-- ---------------------------------------------------------------------
-- 2. RULES
-- ---------------------------------------------------------------------
-- Can the caller see this store for announcement purposes?
create or replace function public.announcement_can_see_location(p_loc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_access_location(p_loc) or public.office_can_read(p_loc);
$$;
revoke all on function public.announcement_can_see_location(uuid) from public, anon, authenticated;

create or replace function public.announcement_visible(p_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.announcements a where a.id = p_id and a.created_by = auth.uid())
      or exists (select 1 from public.announcement_locations al
                  where al.announcement_id = p_id
                    and public.announcement_can_see_location(al.location_id));
$$;
revoke all on function public.announcement_visible(uuid) from public, anon, authenticated;

-- May the caller post to / manage announcements for this store?
--   master, admin, office: any store they can see
--   district, regional:    stores they manage
create or replace function public.announcement_can_post_to(p_loc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select case coalesce(public.current_user_role(), '')
           when 'master'   then true
           when 'admin'    then true
           when 'office'   then public.office_can_read(p_loc)
           when 'district' then public.can_access_location(p_loc)
           when 'regional' then public.can_access_location(p_loc)
           else false
         end;
$$;
revoke all on function public.announcement_can_post_to(uuid) from public, anon, authenticated;

-- Edit / archive / see receipts: the author, or master/admin, or a
-- poster who can post to EVERY one of its stores (so a DM can't manage
-- a company-wide announcement just because it touched their district).
create or replace function public.announcement_can_manage(p_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_user_role(), '') in ('master','admin')
      or exists (select 1 from public.announcements a where a.id = p_id and a.created_by = auth.uid())
      or (coalesce(public.current_user_role(), '') in ('office','district','regional')
          and exists (select 1 from public.announcement_locations al where al.announcement_id = p_id)
          and not exists (select 1 from public.announcement_locations al
                           where al.announcement_id = p_id
                             and not public.announcement_can_post_to(al.location_id)));
$$;
revoke all on function public.announcement_can_manage(uuid) from public, anon, authenticated;

create or replace function public.announcement_can_post()
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.current_user_role(), '') in ('master','admin','office','district','regional');
$$;
revoke all on function public.announcement_can_post() from public, anon;
grant execute on function public.announcement_can_post() to authenticated;


-- ---------------------------------------------------------------------
-- 3. POST and EDIT
-- ---------------------------------------------------------------------
create or replace function public.announcement_post(
  p_title          text,
  p_body           text,
  p_priority       text,
  p_location_ids   uuid[],
  p_audience_label text    default '',
  p_training_id    uuid    default null,
  p_expires_at     timestamptz default null,
  p_email          boolean default false)
returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare
  v_id   uuid;
  v_bad  int;
  v_name text;
begin
  if not public.announcement_can_post() then
    raise exception 'You can''t post announcements.' using errcode = '42501';
  end if;
  if p_location_ids is null or cardinality(p_location_ids) = 0 then
    raise exception 'Pick at least one store.' using errcode = '22023';
  end if;
  select count(*) into v_bad
    from unnest(p_location_ids) x(loc)
   where not exists (select 1 from public.locations l where l.id = x.loc)
      or not public.announcement_can_post_to(x.loc);
  if v_bad > 0 then
    raise exception '% of the stores picked are outside what you can post to.', v_bad using errcode = '42501';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'The expiry must be in the future.' using errcode = '22023';
  end if;
  if p_training_id is not null
     and not exists (select 1 from public.training t where t.id = p_training_id and t.item_type = 'file') then
    raise exception 'That training item doesn''t exist.' using errcode = '22023';
  end if;

  select coalesce(nullif(trim(p.full_name), ''), p.email) into v_name from public.profiles p where p.id = auth.uid();

  insert into public.announcements
    (title, body, priority, training_id, audience_label, expires_at,
     created_by, created_by_name, created_by_role, email_requested)
  values
    (trim(p_title), coalesce(p_body, ''), coalesce(p_priority, 'normal'), p_training_id,
     left(coalesce(p_audience_label, ''), 200), p_expires_at,
     auth.uid(), v_name, public.current_user_role(), coalesce(p_email, false))
  returning id into v_id;

  insert into public.announcement_locations (announcement_id, location_id)
  select v_id, x.loc from (select distinct unnest(p_location_ids) loc) x;

  -- The author has, by definition, read it.
  insert into public.announcement_reads (announcement_id, user_id) values (v_id, auth.uid())
  on conflict do nothing;
  return v_id;
end
$fn$;
revoke all on function public.announcement_post(text, text, text, uuid[], text, uuid, timestamptz, boolean) from public, anon;
grant execute on function public.announcement_post(text, text, text, uuid[], text, uuid, timestamptz, boolean) to authenticated;

-- Text, priority, training link and expiry can be corrected. The stores
-- it went to cannot (post a new one), and receipts are kept.
create or replace function public.announcement_update(
  p_id          uuid,
  p_title       text,
  p_body        text,
  p_priority    text,
  p_training_id uuid,
  p_expires_at  timestamptz)
returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.announcement_can_manage(p_id) then
    raise exception 'You can''t edit this announcement.' using errcode = '42501';
  end if;
  update public.announcements
     set title = trim(p_title), body = coalesce(p_body, ''), priority = coalesce(p_priority, 'normal'),
         training_id = p_training_id, expires_at = p_expires_at, edited_at = now()
   where id = p_id;
end
$fn$;
revoke all on function public.announcement_update(uuid, text, text, text, uuid, timestamptz) from public, anon;
grant execute on function public.announcement_update(uuid, text, text, text, uuid, timestamptz) to authenticated;

create or replace function public.announcement_archive(p_id uuid, p_archived boolean default true)
returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  if not public.announcement_can_manage(p_id) then
    raise exception 'You can''t archive this announcement.' using errcode = '42501';
  end if;
  update public.announcements
     set archived_at = case when p_archived then now() else null end
   where id = p_id;
end
$fn$;
revoke all on function public.announcement_archive(uuid, boolean) from public, anon;
grant execute on function public.announcement_archive(uuid, boolean) to authenticated;


-- ---------------------------------------------------------------------
-- 4. THE FEED, and MARK READ
--    p_include_past: also expired and archived ones (the history list);
--    the banner asks for current only.
-- ---------------------------------------------------------------------
-- Return type changed while 86 was being written; drop so a re-run
-- with a different shape can recreate it.
drop function if exists public.my_announcements(boolean);
create or replace function public.my_announcements(p_include_past boolean default false)
returns table (
  id              uuid,
  title           text,
  body            text,
  priority        text,
  training_id     uuid,
  training_title  text,
  audience_label  text,
  created_by_name text,
  created_at      timestamptz,
  edited_at       timestamptz,
  expires_at      timestamptz,
  archived_at     timestamptz,
  is_current      boolean,
  read_at         timestamptz,
  can_manage      boolean,
  store_count     int,
  emailed_at      timestamptz,
  email_result    jsonb          -- managers only; null for everyone else
)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  return query
  select a.id, a.title, a.body, a.priority, a.training_id, t.title, a.audience_label,
         a.created_by_name, a.created_at, a.edited_at, a.expires_at, a.archived_at,
         (a.archived_at is null and a.starts_at <= now() and (a.expires_at is null or a.expires_at > now())),
         r.read_at,
         public.announcement_can_manage(a.id),
         (select count(*)::int from public.announcement_locations al where al.announcement_id = a.id),
         a.emailed_at,
         case when public.announcement_can_manage(a.id) then a.email_result end
    from public.announcements a
    left join public.training t on t.id = a.training_id
    left join public.announcement_reads r on r.announcement_id = a.id and r.user_id = auth.uid()
   where public.announcement_visible(a.id)
     and (p_include_past
          or (a.archived_at is null and a.starts_at <= now() and (a.expires_at is null or a.expires_at > now())))
   order by (r.read_at is null) desc, (a.priority = 'important') desc, a.created_at desc
   limit 300;
end
$fn$;
revoke all on function public.my_announcements(boolean) from public, anon;
grant execute on function public.my_announcements(boolean) to authenticated;

create or replace function public.announcement_mark_read(p_id uuid)
returns timestamptz
language plpgsql security definer set search_path = '' as $fn$
declare v_at timestamptz;
begin
  if not public.announcement_visible(p_id) then
    raise exception 'Not found.' using errcode = '42501';
  end if;
  insert into public.announcement_reads (announcement_id, user_id) values (p_id, auth.uid())
  on conflict (announcement_id, user_id) do nothing;
  select r.read_at into v_at from public.announcement_reads r
   where r.announcement_id = p_id and r.user_id = auth.uid();
  return v_at;
end
$fn$;
revoke all on function public.announcement_mark_read(uuid) from public, anon;
grant execute on function public.announcement_mark_read(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 5. RECEIPTS, rolled up by store. For people who can manage it.
--    logins   = store logins (role 'store') pointed at that store
--    readers  = those of them who opened it, with when
--    Managers who read it (DM/RM/office/admin/master) come back on a
--    row with location_id null, so the home office can see them too.
-- ---------------------------------------------------------------------
create or replace function public.announcement_receipts(p_id uuid)
returns table (
  location_id  uuid,
  store_number text,
  store_name   text,
  logins       int,
  read_count   int,
  readers      jsonb
)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.announcement_can_manage(p_id) then
    raise exception 'Only the author or the home office can see who read this.' using errcode = '42501';
  end if;
  return query
  select l.id, l.store_number::text, l.name,
         (select count(*)::int from public.profiles p where p.role = 'store' and p.location_id = l.id),
         (select count(*)::int from public.announcement_reads r
            join public.profiles p on p.id = r.user_id
           where r.announcement_id = p_id and p.role = 'store' and p.location_id = l.id),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'name', coalesce(nullif(trim(p.full_name), ''), p.email), 'read_at', r.read_at)
                     order by r.read_at)
                     from public.announcement_reads r
                     join public.profiles p on p.id = r.user_id
                    where r.announcement_id = p_id and p.role = 'store' and p.location_id = l.id), '[]'::jsonb)
    from public.announcement_locations al
    join public.locations l on l.id = al.location_id
   where al.announcement_id = p_id
  union all
  select null::uuid, null::text, 'Managers and home office', null::int,
         count(*)::int,
         coalesce(jsonb_agg(jsonb_build_object(
           'name', coalesce(nullif(trim(p.full_name), ''), p.email), 'role', p.role, 'read_at', r.read_at)
           order by r.read_at), '[]'::jsonb)
    from public.announcement_reads r
    join public.profiles p on p.id = r.user_id
   where r.announcement_id = p_id and coalesce(p.role, '') <> 'store'
  order by 2 nulls last;
end
$fn$;
revoke all on function public.announcement_receipts(uuid) from public, anon;
grant execute on function public.announcement_receipts(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 6. EMAIL -- the Edge Function asks, as the CALLER, for what to send
--    (so the manage rule applies), then records the result with the
--    service role.
-- ---------------------------------------------------------------------
create or replace function public.announcement_email_targets(p_id uuid)
returns table (location_id uuid, store_number text, store_name text, store_email text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not public.announcement_can_manage(p_id) then
    raise exception 'You can''t email this announcement.' using errcode = '42501';
  end if;
  return query
  select l.id, l.store_number::text, l.name, nullif(trim(l.store_email), '')
    from public.announcement_locations al
    join public.locations l on l.id = al.location_id
   where al.announcement_id = p_id
   order by l.store_number;
end
$fn$;
revoke all on function public.announcement_email_targets(uuid) from public, anon;
grant execute on function public.announcement_email_targets(uuid) to authenticated;


-- Not attached to the audit log (81): its area mapping would file these
-- under payroll. The row itself records who posted it (created_by,
-- created_by_name) and when it was edited or archived.

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
-- VERIFY (in the portal; these functions read the signed-in user)
-- ---------------------------------------------------------------------
-- select count(*) from public.announcements;           -- 0
-- select proname from pg_proc where proname like 'announcement%' or proname = 'my_announcements';
