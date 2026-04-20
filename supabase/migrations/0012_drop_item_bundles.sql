-- 0012_drop_item_bundles.sql
-- Roll back the bundle feature from 0011 — we'll model kits differently.
-- Note: keeps items.category (that's still in use).

drop table if exists item_bundle_components;
