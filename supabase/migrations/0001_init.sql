-- gadhan-radio — initial schema
-- Run via Supabase SQL editor or `supabase db push`.
-- Idempotent where reasonable; safe to re-run during early development.

-- =========================================
-- Extensions
-- =========================================
create extension if not exists "pgcrypto";

-- =========================================
-- Enums
-- =========================================
do $$ begin
  create type role_t as enum ('admin', 'raspar');
exception when duplicate_object then null; end $$;

do $$ begin
  create type signing_type_t as enum ('signing', 'return', 'inspection');
exception when duplicate_object then null; end $$;

do $$ begin
  create type item_action_t as enum ('issued', 'returned', 'inspected');
exception when duplicate_object then null; end $$;

-- =========================================
-- Tables
-- =========================================
create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Profile is keyed to auth.users.id and lives alongside Supabase Auth.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role role_t not null default 'raspar',
  unit_id uuid references units(id) on delete set null,
  phone text,
  personal_number text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists soldiers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  personal_number text not null unique,
  phone text,
  unit_id uuid not null references units(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists signings (
  id uuid primary key default gen_random_uuid(),
  soldier_id uuid not null references soldiers(id) on delete restrict,
  performed_by uuid not null references profiles(id) on delete restrict,
  unit_id uuid not null references units(id) on delete restrict,
  type signing_type_t not null,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists signings_soldier_idx on signings(soldier_id);
create index if not exists signings_unit_idx on signings(unit_id);
create index if not exists signings_created_idx on signings(created_at desc);

create table if not exists signing_items (
  id uuid primary key default gen_random_uuid(),
  signing_id uuid not null references signings(id) on delete cascade,
  item_id uuid not null references items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  action item_action_t not null
);
create index if not exists signing_items_signing_idx on signing_items(signing_id);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  performed_by uuid references profiles(id) on delete set null,
  target_type text,
  target_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on audit_logs(created_at desc);
create index if not exists audit_logs_action_idx on audit_logs(action);

-- =========================================
-- Helper functions for RLS
-- =========================================
create or replace function current_role_t() returns role_t
language sql stable security definer as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function current_unit_id() returns uuid
language sql stable security definer as $$
  select unit_id from profiles where id = auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable security definer as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and active);
$$;

-- =========================================
-- RLS
-- =========================================
alter table units enable row level security;
alter table profiles enable row level security;
alter table soldiers enable row level security;
alter table items enable row level security;
alter table signings enable row level security;
alter table signing_items enable row level security;
alter table audit_logs enable row level security;

-- units: admin = all, raspar = read all
drop policy if exists units_select on units;
create policy units_select on units for select using (auth.role() = 'authenticated');
drop policy if exists units_admin_write on units;
create policy units_admin_write on units for all using (is_admin()) with check (is_admin());

-- profiles: each user reads own; admin reads/writes all
drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles for select using (id = auth.uid() or is_admin());
drop policy if exists profiles_admin_write on profiles;
create policy profiles_admin_write on profiles for all using (is_admin()) with check (is_admin());

-- soldiers: admin = all, raspar = scoped to own unit (read + write)
drop policy if exists soldiers_select on soldiers;
create policy soldiers_select on soldiers for select using (
  is_admin() or unit_id = current_unit_id()
);
drop policy if exists soldiers_admin_write on soldiers;
create policy soldiers_admin_write on soldiers for all using (is_admin()) with check (is_admin());
drop policy if exists soldiers_raspar_insert on soldiers;
create policy soldiers_raspar_insert on soldiers for insert
  with check (current_role_t() = 'raspar' and unit_id = current_unit_id());
drop policy if exists soldiers_raspar_update on soldiers;
create policy soldiers_raspar_update on soldiers for update
  using (current_role_t() = 'raspar' and unit_id = current_unit_id())
  with check (current_role_t() = 'raspar' and unit_id = current_unit_id());

-- items: everyone reads, admin writes
drop policy if exists items_select on items;
create policy items_select on items for select using (auth.role() = 'authenticated');
drop policy if exists items_admin_write on items;
create policy items_admin_write on items for all using (is_admin()) with check (is_admin());

-- signings: admin all, raspar read all in unit + insert in unit
drop policy if exists signings_select on signings;
create policy signings_select on signings for select using (
  is_admin() or unit_id = current_unit_id()
);
drop policy if exists signings_admin_write on signings;
create policy signings_admin_write on signings for all using (is_admin()) with check (is_admin());
drop policy if exists signings_raspar_insert on signings;
create policy signings_raspar_insert on signings for insert
  with check (
    current_role_t() = 'raspar'
    and unit_id = current_unit_id()
    and performed_by = auth.uid()
  );

-- signing_items: visibility follows parent signing
drop policy if exists signing_items_select on signing_items;
create policy signing_items_select on signing_items for select using (
  exists (
    select 1 from signings s
    where s.id = signing_items.signing_id
      and (is_admin() or s.unit_id = current_unit_id())
  )
);
drop policy if exists signing_items_admin_write on signing_items;
create policy signing_items_admin_write on signing_items for all
  using (is_admin()) with check (is_admin());
drop policy if exists signing_items_raspar_insert on signing_items;
create policy signing_items_raspar_insert on signing_items for insert
  with check (
    exists (
      select 1 from signings s
      where s.id = signing_items.signing_id
        and s.unit_id = current_unit_id()
        and s.performed_by = auth.uid()
    )
  );

-- audit_logs: admin reads all; raspar reads own actions
drop policy if exists audit_select on audit_logs;
create policy audit_select on audit_logs for select using (
  is_admin() or performed_by = auth.uid()
);
drop policy if exists audit_insert on audit_logs;
create policy audit_insert on audit_logs for insert
  with check (auth.role() = 'authenticated');

-- =========================================
-- Trigger: create profile row on auth.users insert (default role = raspar, inactive)
-- Admin must activate + assign unit before login is useful.
-- =========================================
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'raspar',
    false
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
