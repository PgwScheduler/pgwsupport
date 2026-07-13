-- =====================================================================
-- PGW Support Portal — Populate Store Numbers
-- Run AFTER pgw_add_store_number.sql (which creates the column).
-- Matches each store by name and sets its store_number. Safe to re-run.
-- =====================================================================

update public.locations as l
set store_number = v.num
from (values
    ('Midas Sam Rittenburg', '3302'),
    ('Midas Mt Pleasant', '3287'),
    ('Midas North Main St', '5253'),
    ('Midas Rivers Ave', '3385'),
    ('Midas Trolley Rd', '3182'),
    ('Midas Sumter', '3938'),
    ('Midas Florence', '3377'),
    ('Speedee Summerville', '3009'),
    ('Speedee James Island', '3025'),
    ('Speedee North Charleston', '3029'),
    ('Midas Bush River', '3936'),
    ('Midas Knox Abbott', '3278'),
    ('Midas North Lake', '3276'),
    ('Midas Lake Murray', '3979'),
    ('Midas Harbison', '3229'),
    ('Speedee Lexington', '3308'),
    ('Midas Gervais St', '5254'),
    ('Midas Millwood Ave', '3303'),
    ('Midas Decker', '3984'),
    ('Midas Two Notch', '3935'),
    ('Midas Hardscrabble', '3937'),
    ('Midas Pleasantburg', '3305'),
    ('Midas Sunbeam Rd', '3111'),
    ('Midas Lem Turner', '3136'),
    ('Midas Gainesville', '3211'),
    ('Midas Atlantic Blvd', '3548'),
    ('Midas Orange Park', '3292'),
    ('Midas Beach Blvd', '2321'),
    ('Midas Forestville', '3593'),
    ('Midas Clinton', '3923'),
    ('Midas Capitol Heights', '3485'),
    ('Midas Temple Hills', '3296'),
    ('Midas Manassas', '3831'),
    ('Midas Rhode Island Ave', '3598'),
    ('Midas Fairfax', '3726'),
    ('Midas Duke St', '3473')
) as v(name, num)
where l.name = v.name;

-- Verify:
--   select store_number, name from public.locations order by store_number;
