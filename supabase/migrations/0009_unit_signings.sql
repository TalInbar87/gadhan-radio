-- 0009_unit_signings.sql
-- Battalion → unit ("החתמת מסגרת") equipment allocation.
-- The battalion issues/returns equipment to an entire unit (מסגרת).
-- Raspar soldier-level signings then draw from that unit stock.
--
-- Stock math:
--   unit_stock(item, serial) = Σ issued  − Σ returned  (in unit_signing_items for that unit)
--   distributed(item, serial) = Σ issued − Σ returned  (in signing_items for signings in that unit)
--   available_for_raspar      = unit_stock − distributed
--
-- unit_signing_type reuses two of the existing signing_type_t variants
-- conceptually (signing / return) but has its own enum to keep the domains
-- clean in SQL (and leave room to diverge later, e.g. add 'audit').

do $$ begin
  create type unit_signing_type_t as enum ('signing', 'return');
exception when duplicate_object then null; end $$;

do $$ begin
  create type unit_item_action_t as enum ('issued', 'returned');
exception when duplicate_object then null; end $$;

create table if not exists unit_signings (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units(id) on delete restrict,
  performed_by uuid not null references profiles(id) on delete restrict,
  type unit_signing_type_t not null,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists unit_signings_unit_idx on unit_signings(unit_id);
create index if not exists unit_signings_created_idx on unit_signings(created_at desc);

create table if not exists unit_signing_items (
  id uuid primary key default gen_random_uuid(),
  unit_signing_id uuid not null references unit_signings(id) on delete cascade,
  item_id uuid not null references items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  action unit_item_action_t not null,
  serial_number text
);
create index if not exists unit_signing_items_parent_idx on unit_signing_items(unit_signing_id);
create index if not exists unit_signing_items_item_idx on unit_signing_items(item_id);

-- =========================================
-- RLS
-- =========================================
alter table unit_signings enable row level security;
alter table unit_signing_items enable row level security;

-- Everyone authenticated can read their own unit's unit_signings (raspar needs
-- them to compute availability); admin reads everything.
drop policy if exists unit_signings_select on unit_signings;
create policy unit_signings_select on unit_signings for select using (
  is_admin() or unit_id = current_unit_id()
);

-- Only admin writes unit_signings (this is the battalion-level action).
drop policy if exists unit_signings_admin_write on unit_signings;
create policy unit_signings_admin_write on unit_signings for all
  using (is_admin()) with check (is_admin());

-- unit_signing_items: visibility follows parent.
drop policy if exists unit_signing_items_select on unit_signing_items;
create policy unit_signing_items_select on unit_signing_items for select using (
  exists (
    select 1 from unit_signings us
    where us.id = unit_signing_items.unit_signing_id
      and (is_admin() or us.unit_id = current_unit_id())
  )
);

drop policy if exists unit_signing_items_admin_write on unit_signing_items;
create policy unit_signing_items_admin_write on unit_signing_items for all
  using (is_admin()) with check (is_admin());

-- =========================================
-- Stock view (convenience for reports + SignForm availability checks)
-- =========================================
--
-- Per (unit_id, item_id, serial_number) rollup. Serial is normalized to ''
-- so aggregation is consistent with the app-side key format.
--
-- Columns:
--   unit_id, item_id, serial_number
--   allocated   — issued from battalion to unit
--   returned_up — returned from unit back to battalion
--   stock       — allocated − returned_up
--   distributed — currently held by soldiers in this unit (issued−returned in signings)
--   available   — stock − distributed  (what raspar can still hand out)
create or replace view unit_item_stock as
with unit_flows as (
  select
    us.unit_id,
    usi.item_id,
    coalesce(usi.serial_number, '') as serial_number,
    sum(case when usi.action = 'issued'   then usi.quantity else 0 end) as allocated,
    sum(case when usi.action = 'returned' then usi.quantity else 0 end) as returned_up
  from unit_signing_items usi
  join unit_signings us on us.id = usi.unit_signing_id
  group by us.unit_id, usi.item_id, coalesce(usi.serial_number, '')
),
soldier_flows as (
  select
    s.unit_id,
    si.item_id,
    coalesce(si.serial_number, '') as serial_number,
    sum(case when si.action = 'issued'   then si.quantity else 0 end)
      - sum(case when si.action = 'returned' then si.quantity else 0 end) as distributed
  from signing_items si
  join signings s on s.id = si.signing_id
  where si.action in ('issued', 'returned')
  group by s.unit_id, si.item_id, coalesce(si.serial_number, '')
)
select
  uf.unit_id,
  uf.item_id,
  nullif(uf.serial_number, '') as serial_number,
  uf.allocated,
  uf.returned_up,
  (uf.allocated - uf.returned_up) as stock,
  coalesce(sf.distributed, 0) as distributed,
  (uf.allocated - uf.returned_up - coalesce(sf.distributed, 0)) as available
from unit_flows uf
left join soldier_flows sf
  on sf.unit_id = uf.unit_id
 and sf.item_id = uf.item_id
 and sf.serial_number = uf.serial_number;
