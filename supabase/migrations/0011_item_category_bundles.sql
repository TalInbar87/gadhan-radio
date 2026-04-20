-- 0011_item_category_bundles.sql
-- 1) Add "category" (שיוך ארגוני) free-text tag to items.
-- 2) Introduce item bundles (ערכות): one item composed of N other items.
--    Used e.g. for "ערכת PRC-148" that contains transceiver + modem + CF.
--    The bundle itself is a regular row in `items`; the composition lives here.

alter table items add column if not exists category text;
create index if not exists items_category_idx on items(category);

create table if not exists item_bundle_components (
  id uuid primary key default gen_random_uuid(),
  bundle_item_id    uuid not null references items(id) on delete cascade,
  component_item_id uuid not null references items(id) on delete restrict,
  quantity int not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (bundle_item_id, component_item_id),
  -- An item cannot be a component of itself.
  check (bundle_item_id <> component_item_id)
);
create index if not exists item_bundle_components_bundle_idx on item_bundle_components(bundle_item_id);
create index if not exists item_bundle_components_component_idx on item_bundle_components(component_item_id);

alter table item_bundle_components enable row level security;

drop policy if exists item_bundle_components_select on item_bundle_components;
create policy item_bundle_components_select on item_bundle_components
  for select using (auth.role() = 'authenticated');

drop policy if exists item_bundle_components_admin_write on item_bundle_components;
create policy item_bundle_components_admin_write on item_bundle_components
  for all using (is_admin()) with check (is_admin());
