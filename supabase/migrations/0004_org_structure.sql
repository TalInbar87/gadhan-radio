-- Replace seed units with the actual organizational structure.
-- Adds a `teams` sub-level for units that have one.
--
-- מבנה:
--   פלוגה א/ב/ג   → צוות 1/2/3 + מפל"ג
--   מפג"ד          → חפ"ק
--   פלס"ם          → רכב, לוגיסטיקה, טנ"א, תקשוב, מפל"ג
--   ניוד / מחס"ר / הדרכה / צמ"ה / תאג"ד   (ללא צוותים)

-- 1. Drop only unreferenced placeholder units (safe — won't break FKs).
delete from units
  where name = 'מסייעת'
    and not exists (select 1 from soldiers s where s.unit_id = units.id)
    and not exists (select 1 from signings g where g.unit_id = units.id)
    and not exists (select 1 from profiles p where p.unit_id = units.id);

-- 2. Insert the real top-level units (idempotent — keeps existing פלוגה א/ב/ג).
insert into units (name) values
  ('פלוגה א'),
  ('פלוגה ב'),
  ('פלוגה ג'),
  ('מפג"ד'),
  ('פלס"ם'),
  ('ניוד'),
  ('מחס"ר'),
  ('הדרכה'),
  ('צמ"ה'),
  ('תאג"ד')
on conflict (name) do nothing;

-- 3. Teams table — sub-unit under units.
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (unit_id, name)
);
create index if not exists teams_unit_idx on teams(unit_id);

-- 4. Seed teams.
do $$
declare u_id uuid;
begin
  for u_id in select id from units where name in ('פלוגה א', 'פלוגה ב', 'פלוגה ג') loop
    insert into teams (unit_id, name) values
      (u_id, 'צוות 1'),
      (u_id, 'צוות 2'),
      (u_id, 'צוות 3'),
      (u_id, 'מפל"ג')
    on conflict (unit_id, name) do nothing;
  end loop;

  select id into u_id from units where name = 'מפג"ד';
  if u_id is not null then
    insert into teams (unit_id, name) values (u_id, 'חפ"ק')
    on conflict (unit_id, name) do nothing;
  end if;

  select id into u_id from units where name = 'פלס"ם';
  if u_id is not null then
    insert into teams (unit_id, name) values
      (u_id, 'רכב'),
      (u_id, 'לוגיסטיקה'),
      (u_id, 'טנ"א'),
      (u_id, 'תקשוב'),
      (u_id, 'מפל"ג')
    on conflict (unit_id, name) do nothing;
  end if;
end $$;

-- 5. Optional team association for soldiers + signings.
alter table soldiers add column if not exists team_id uuid references teams(id) on delete set null;
alter table signings add column if not exists team_id uuid references teams(id) on delete set null;

-- 6. RLS for teams (read for all auth users, write for admin only).
alter table teams enable row level security;

drop policy if exists teams_select on teams;
create policy teams_select on teams for select using (auth.role() = 'authenticated');

drop policy if exists teams_admin_write on teams;
create policy teams_admin_write on teams for all using (is_admin()) with check (is_admin());
