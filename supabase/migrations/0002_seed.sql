-- Seed reference data: common radio items + a few sample units.
-- Safe to re-run (uses on conflict).

insert into items (name, description) values
  ('מכשיר 624', 'מכשיר קשר 624'),
  ('מכשיר 91', 'מכשיר קשר 91'),
  ('עמוד אנטנה', null),
  ('מגבר', null),
  ('סוללה', null),
  ('מטען', null),
  ('דיבורית', null),
  ('כבל תכנות', null),
  ('כיסוי גומי', null),
  ('שלפ"ק', null)
on conflict (name) do nothing;

insert into units (name) values
  ('פלוגה א'),
  ('פלוגה ב'),
  ('פלוגה ג'),
  ('מסייעת')
on conflict (name) do nothing;

-- ============================================================
-- POST-DEPLOY: bootstrap your first admin
-- ============================================================
-- 1. Create the auth user from the Supabase dashboard:
--    Authentication > Users > Add user > "admin@example.com" + password
-- 2. Then run the following (replace the email):
--
-- update profiles
--   set role = 'admin', active = true, full_name = 'מנהל מערכת'
--   where id = (select id from auth.users where email = 'admin@example.com');
-- ============================================================
