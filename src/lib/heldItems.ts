import { supabase } from './supabase';

export interface HeldItem {
  itemId: string;
  itemName: string;
  serialNumber: string | null;
  quantity: number;
}

/**
 * Compute the items currently held by a soldier — i.e. issued minus returned,
 * grouped by (item, serial). Inspections do not affect the balance.
 */
export async function loadSoldierHeldItems(soldierId: string): Promise<HeldItem[]> {
  const { data, error } = await supabase
    .from('signings')
    .select(`
      id,
      type,
      signing_items(item_id, quantity, action, serial_number, item:items(name))
    `)
    .eq('soldier_id', soldierId);
  if (error) throw error;

  const map = new Map<string, HeldItem>();
  const rows = (data ?? []) as unknown as Array<{
    signing_items: Array<{
      item_id: string;
      quantity: number;
      action: string;
      serial_number: string | null;
      item: { name: string } | null;
    }>;
  }>;
  for (const s of rows) {
    for (const li of s.signing_items ?? []) {
      const key = `${li.item_id}::${li.serial_number ?? ''}`;
      const existing = map.get(key) ?? {
        itemId: li.item_id,
        itemName: li.item?.name ?? '?',
        serialNumber: li.serial_number,
        quantity: 0,
      };
      if (li.action === 'issued') existing.quantity += li.quantity;
      else if (li.action === 'returned') existing.quantity -= li.quantity;
      map.set(key, existing);
    }
  }
  return Array.from(map.values()).filter((i) => i.quantity > 0);
}
