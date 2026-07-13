-- =====================================================================
-- PGW Support Portal — Seed data: regions, districts, and 36 stores
-- Run AFTER both schema files (base schema + regions upgrade).
-- Paste into SQL Editor > New query > Run.
-- =====================================================================
-- Hierarchy (as confirmed): REGION (big) > DISTRICT (small) > STORE
--   Region Charleston       -> District Charleston                 (10)
--   Region Columbia         -> Districts Columbia West (6),
--                                         Columbia East (6)
--   Region Florida & North  -> Districts Florida (6), North (8)
--
-- Minor typo cleanups applied (Florida spelling, a couple of city
-- names, doubled "Midas Decker" name). Every store is in exactly the
-- group your sheet assigned it. Skim the addresses once — those are
-- display-only and easy to edit later in the Table Editor.
--
-- Safe: the block skips itself if any stores already exist.
-- =====================================================================

do $$
declare
  r_charleston uuid;
  r_columbia   uuid;
  r_flnorth    uuid;
  d_charleston uuid;
  d_col_west   uuid;
  d_col_east   uuid;
  d_florida    uuid;
  d_north      uuid;
begin
  if exists (select 1 from public.locations) then
    raise notice 'Locations already exist — seed skipped to avoid duplicates.';
    return;
  end if;

  -- REGIONS (big tier) ------------------------------------------------
  insert into public.regions (name) values ('Charleston')      returning id into r_charleston;
  insert into public.regions (name) values ('Columbia')        returning id into r_columbia;
  insert into public.regions (name) values ('Florida & North') returning id into r_flnorth;

  -- DISTRICTS (small tier) --------------------------------------------
  insert into public.districts (name, region_id) values ('Charleston',    r_charleston) returning id into d_charleston;
  insert into public.districts (name, region_id) values ('Columbia West', r_columbia)   returning id into d_col_west;
  insert into public.districts (name, region_id) values ('Columbia East', r_columbia)   returning id into d_col_east;
  insert into public.districts (name, region_id) values ('Florida',       r_flnorth)    returning id into d_florida;
  insert into public.districts (name, region_id) values ('North',         r_flnorth)    returning id into d_north;

  -- STORES ------------------------------------------------------------
  insert into public.locations (name, address, district_id) values
    -- Charleston
    ('Midas Sam Rittenburg',     '1875 Sam Rittenberg Blvd, Charleston, SC 29407',   d_charleston),
    ('Midas Mt Pleasant',        '1621 N Hwy 17-Bypass, Mt. Pleasant, SC 29464',     d_charleston),
    ('Midas North Main St',      '807 N Main St, Summerville, SC 29483',             d_charleston),
    ('Midas Rivers Ave',         '8330 Rivers Ave, N. Charleston, SC 29406',         d_charleston),
    ('Midas Trolley Rd',         '1674 Old Trolley Rd, Summerville, SC 29485',       d_charleston),
    ('Midas Sumter',             '29 E Wesmark Blvd, Sumter, SC 29150',              d_charleston),
    ('Midas Florence',           '2213 W. Palmetto St, Florence, SC 29501',          d_charleston),
    ('Speedee Summerville',      '825 N Main St, Summerville, SC 29483',             d_charleston),
    ('Speedee James Island',     '683 Folly Road, Charleston, SC 29412',             d_charleston),
    ('Speedee North Charleston', '7395 Northwoods Blvd, Charleston, SC 29406',       d_charleston),
    -- Columbia West
    ('Midas Bush River',         '700 Bush River Rd, Columbia, SC 29210',            d_col_west),
    ('Midas Knox Abbott',        '992 Knox Abbott Dr, Cayce, SC 29033',              d_col_west),
    ('Midas North Lake',         '937 N. Lake Drive, Lexington, SC 29072',           d_col_west),
    ('Midas Lake Murray',        '224 Bo Tire Way, Lexington, SC 29072',             d_col_west),
    ('Midas Harbison',           '121 Harbison Blvd, Columbia, SC 29212',            d_col_west),
    ('Speedee Lexington',        '5537 Sunset Blvd, Lexington, SC 29072',            d_col_west),
    -- Columbia East
    ('Midas Gervais St',         '1517 Gervais Street, Columbia, SC 29201',          d_col_east),
    ('Midas Millwood Ave',       '2701 Millwood Ave, Columbia, SC 29206',            d_col_east),
    ('Midas Decker',             '2752 Decker Blvd, Columbia, SC 29206',             d_col_east),
    ('Midas Two Notch',          '3215 Two Notch Rd, Columbia, SC 29204',            d_col_east),
    ('Midas Hardscrabble',       '4429 Hardscrabble Rd, Columbia, SC 29229',         d_col_east),
    ('Midas Pleasantburg',       '336 N Pleasantburg Dr, Greenville, SC 29607',      d_col_east),
    -- Florida
    ('Midas Sunbeam Rd',         '3820 Sunbeam Rd, Jacksonville, FL 32257',          d_florida),
    ('Midas Lem Turner',         '7462 Lem Turner Rd, Jacksonville, FL 32208',       d_florida),
    ('Midas Gainesville',        '3845 SW Archer Rd, Gainesville, FL 32608',         d_florida),
    ('Midas Atlantic Blvd',      '10311 Atlantic Blvd, Jacksonville, FL 32225',      d_florida),
    ('Midas Orange Park',        '214 Blanding Blvd, Orange Park, FL 32073',         d_florida),
    ('Midas Beach Blvd',         '14081 Beach Blvd, Jacksonville, FL 32250',         d_florida),
    -- North
    ('Midas Forestville',        '5717 Silver Hill Road, Forestville, MD 20747',     d_north),
    ('Midas Clinton',            '8001 Malcolm Rd, Clinton, MD 20735',               d_north),
    ('Midas Capitol Heights',    '8407 Central Ave, Capitol Heights, MD 20743',      d_north),
    ('Midas Temple Hills',       '7047 Allenton Rd, Temple Hills, MD 20748',         d_north),
    ('Midas Manassas',           '7892 Sudley Road, Manassas, VA 20109',             d_north),
    ('Midas Rhode Island Ave',   '1620 Rhode Island Ave N.E., Washington, DC 20018', d_north),
    ('Midas Fairfax',            '10834 Lee Hwy, Fairfax, VA 20109',                 d_north),
    ('Midas Duke St',            '3100 Duke Street, Alexandria, VA 22314',           d_north);

  raise notice 'Seed complete: 3 regions, 5 districts, 36 stores.';
end $$;

-- Quick check after running:
--   select r.name as region, d.name as district, count(l.*) as stores
--   from public.regions r
--   join public.districts d on d.region_id = r.id
--   left join public.locations l on l.district_id = d.id
--   group by r.name, d.name order by r.name, d.name;
