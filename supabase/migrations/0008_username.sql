-- 0008_username.sql
-- Add a dedicated `username` field for login (English letters/digits/._-, unique).
-- Supabase Auth still requires an email; we generate it as `<username>@gadhan.local`
-- on user creation. The LoginPage accepts the username and appends the suffix.

alter table profiles add column if not exists username text;

-- Backfill existing profiles from their auth email prefix so nothing breaks.
update profiles p
  set username = split_part(u.email, '@', 1)
  from auth.users u
  where p.id = u.id and p.username is null;

-- Shape constraint — English letters, digits, dot/underscore/dash only, 3-32 chars.
-- Stored lowercase so comparisons are case-insensitive.
alter table profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9._-]{3,32}$');

-- Uniqueness (case-sensitive is fine because we normalize to lowercase in code).
create unique index if not exists profiles_username_unique on profiles (username);
