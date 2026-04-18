-- Add per-line serial number ("צ'") for tracking individual physical items.
-- Optional: not all items have serials (some are quantity-only).

alter table signing_items add column if not exists serial_number text;

create index if not exists signing_items_serial_idx
  on signing_items(item_id, serial_number)
  where serial_number is not null;
