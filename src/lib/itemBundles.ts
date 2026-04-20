import { supabase } from './supabase';

export interface BundleComponent {
  id: string;                  // bundle_component row id
  componentItemId: string;
  componentName: string;
  quantity: number;
}

/** List component items that make up `bundleItemId`. */
export async function loadBundleComponents(bundleItemId: string): Promise<BundleComponent[]> {
  const { data, error } = await supabase
    .from('item_bundle_components')
    .select('id, component_item_id, quantity, component:items!item_bundle_components_component_item_id_fkey(name)')
    .eq('bundle_item_id', bundleItemId)
    .order('created_at');
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{
    id: string;
    component_item_id: string;
    quantity: number;
    component: { name: string } | null;
  }>).map((r) => ({
    id: r.id,
    componentItemId: r.component_item_id,
    componentName: r.component?.name ?? '—',
    quantity: r.quantity,
  }));
}

export async function addBundleComponent(
  bundleItemId: string,
  componentItemId: string,
  quantity: number,
): Promise<void> {
  const { error } = await supabase.from('item_bundle_components').insert({
    bundle_item_id: bundleItemId,
    component_item_id: componentItemId,
    quantity,
  });
  if (error) throw error;
}

export async function updateBundleComponentQuantity(rowId: string, quantity: number): Promise<void> {
  const { error } = await supabase
    .from('item_bundle_components')
    .update({ quantity })
    .eq('id', rowId);
  if (error) throw error;
}

export async function removeBundleComponent(rowId: string): Promise<void> {
  const { error } = await supabase.from('item_bundle_components').delete().eq('id', rowId);
  if (error) throw error;
}

/** Is this item currently used as a component of any bundle? */
export async function itemIsComponentOf(itemId: string): Promise<{ bundleId: string; bundleName: string }[]> {
  const { data, error } = await supabase
    .from('item_bundle_components')
    .select('bundle_item_id, bundle:items!item_bundle_components_bundle_item_id_fkey(name)')
    .eq('component_item_id', itemId);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ bundle_item_id: string; bundle: { name: string } | null }>)
    .map((r) => ({ bundleId: r.bundle_item_id, bundleName: r.bundle?.name ?? '—' }));
}
