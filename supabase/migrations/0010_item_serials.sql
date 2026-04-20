-- 0010_item_serials.sql
-- Master inventory catalog: every physical serial number the battalion owns.
-- Serves as the source of truth for:
--   - Admin "החתמת מסגרת": dropdown of serials available at battalion (not currently allocated to any unit)
--   - "Battalion inventory" visibility (future reports)
--
-- The existing `unit_signing_items.serial_number` still drives allocation math.
-- This table only constrains WHICH serials exist and can be picked.

create table if not exists item_serials (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id) on delete cascade,
  serial_number text not null,
  created_at timestamptz not null default now(),
  unique (item_id, serial_number)
);
create index if not exists item_serials_item_idx on item_serials(item_id);

alter table item_serials enable row level security;

drop policy if exists item_serials_select on item_serials;
create policy item_serials_select on item_serials for select using (auth.role() = 'authenticated');

drop policy if exists item_serials_admin_write on item_serials;
create policy item_serials_admin_write on item_serials for all using (is_admin()) with check (is_admin());

-- -----------------------------------------------------------------------------
-- Backfill: any serial previously typed ad-hoc into unit_signings / signings
-- should now appear in the master catalog so the UI's new strict dropdowns
-- won't hide legacy allocations.
-- -----------------------------------------------------------------------------
insert into item_serials (item_id, serial_number)
select distinct usi.item_id, usi.serial_number
from unit_signing_items usi
where usi.serial_number is not null
on conflict (item_id, serial_number) do nothing;

insert into item_serials (item_id, serial_number)
select distinct si.item_id, si.serial_number
from signing_items si
where si.serial_number is not null
on conflict (item_id, serial_number) do nothing;

-- -----------------------------------------------------------------------------
-- View: current location of every registered serial.
--
-- current_unit_id:
--   - null          → at battalion (not currently allocated to any unit)
--   - <unit uuid>   → allocated to that unit (net issued > 0 via unit_signings)
--
-- Note: a serial can only be at one unit at a time — a net-positive "issued"
-- in two units for the same serial is an operator error we don't try to
-- reconcile here. Admin will see both units claim it until a return is logged.
-- -----------------------------------------------------------------------------
create or replace view item_serial_status as
with ser_flows as (
  select
    usi.item_id,
    usi.serial_number,
    us.unit_id,
    sum(case when usi.action = 'issued'   then usi.quantity else 0 end) -
    sum(case when usi.action = 'returned' then usi.quantity else 0 end) as net
  from unit_signing_items usi
  join unit_signings us on us.id = usi.unit_signing_id
  where usi.serial_number is not null
  group by usi.item_id, usi.serial_number, us.unit_id
)
select
  s.id as serial_id,
  s.item_id,
  s.serial_number,
  (
    select f.unit_id
    from ser_flows f
    where f.item_id = s.item_id
      and f.serial_number = s.serial_number
      and f.net > 0
    limit 1
  ) as current_unit_id
from item_serials s;
