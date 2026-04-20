-- 0013_serial_inspections.sql
-- Track "last inspected" timestamp per serial. Status is derived on the client:
--   - last_inspected_at null or older than 7 days → דרוש בדיקה
--   - within 7 days → נמצא
--
-- Raspar can mark serials that are currently at THEIR unit (allocated, not yet
-- returned to battalion). Admin can mark any serial.

alter table item_serials add column if not exists last_inspected_at timestamptz;
alter table item_serials add column if not exists last_inspected_by uuid references profiles(id);

-- Helper: does this (item, serial) currently sit at the given unit? Used both
-- by RLS and by the query that powers the inspection report.
create or replace function serial_currently_at_unit(p_item_id uuid, p_serial text, p_unit_id uuid)
returns boolean
language sql
stable
security definer
as $$
  select coalesce(
    sum(case when usi.action = 'issued' then usi.quantity else 0 end) -
    sum(case when usi.action = 'returned' then usi.quantity else 0 end),
  0) > 0
  from unit_signing_items usi
  join unit_signings us on us.id = usi.unit_signing_id
  where usi.item_id = p_item_id
    and usi.serial_number = p_serial
    and us.unit_id = p_unit_id;
$$;

-- Enhance the status view: now includes current_soldier_id + last_inspected_at.
drop view if exists item_serial_status;
create or replace view item_serial_status as
with unit_flows as (
  select usi.item_id, usi.serial_number, us.unit_id,
    sum(case when usi.action = 'issued' then usi.quantity else 0 end) -
    sum(case when usi.action = 'returned' then usi.quantity else 0 end) as net
  from unit_signing_items usi
  join unit_signings us on us.id = usi.unit_signing_id
  where usi.serial_number is not null
  group by usi.item_id, usi.serial_number, us.unit_id
),
soldier_flows as (
  select si.item_id, si.serial_number, s.soldier_id,
    sum(case when si.action = 'issued' then si.quantity else 0 end) -
    sum(case when si.action = 'returned' then si.quantity else 0 end) as net
  from signing_items si
  join signings s on s.id = si.signing_id
  where si.serial_number is not null
  group by si.item_id, si.serial_number, s.soldier_id
)
select
  s.id as serial_id,
  s.item_id,
  s.serial_number,
  s.last_inspected_at,
  (
    select f.unit_id from unit_flows f
    where f.item_id = s.item_id and f.serial_number = s.serial_number and f.net > 0
    limit 1
  ) as current_unit_id,
  (
    select f.soldier_id from soldier_flows f
    where f.item_id = s.item_id and f.serial_number = s.serial_number and f.net > 0
    limit 1
  ) as current_soldier_id
from item_serials s;

-- Allow raspar to UPDATE item_serials rows for serials currently at their unit.
-- The existing `item_serials_admin_write` FOR ALL policy still covers admins;
-- RLS OR's policies per command, so this only ADDS access — doesn't restrict.
drop policy if exists item_serials_raspar_inspect on item_serials;
create policy item_serials_raspar_inspect on item_serials
  for update
  using (
    is_admin()
    or serial_currently_at_unit(item_id, serial_number, current_unit_id())
  )
  with check (
    is_admin()
    or serial_currently_at_unit(item_id, serial_number, current_unit_id())
  );
