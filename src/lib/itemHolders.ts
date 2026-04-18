import { supabase } from './supabase';

export interface ItemHolder {
  soldierId: string;
  soldierName: string;
  personalNumber: string;
  quantity: number;
}

/**
 * Return the soldiers who currently hold a given item (issued − returned > 0).
 * Empty array means the item is "free" and safe to deactivate / delete.
 */
export async function getItemHolders(itemId: string): Promise<ItemHolder[]> {
  const { data, error } = await supabase
    .from('signing_items')
    .select(`
      quantity, action,
      signing:signings(soldier_id, soldier:soldiers(full_name, personal_number))
    `)
    .eq('item_id', itemId)
    .in('action', ['issued', 'returned']);
  if (error) throw error;

  const map = new Map<string, ItemHolder>();
  const rows = (data ?? []) as unknown as Array<{
    quantity: number;
    action: string;
    signing: {
      soldier_id: string;
      soldier: { full_name: string; personal_number: string } | null;
    } | null;
  }>;
  for (const row of rows) {
    const sid = row.signing?.soldier_id;
    if (!sid) continue;
    const cur = map.get(sid) ?? {
      soldierId: sid,
      soldierName: row.signing?.soldier?.full_name ?? 'לא ידוע',
      personalNumber: row.signing?.soldier?.personal_number ?? '',
      quantity: 0,
    };
    if (row.action === 'issued') cur.quantity += row.quantity;
    else if (row.action === 'returned') cur.quantity -= row.quantity;
    map.set(sid, cur);
  }
  return Array.from(map.values()).filter((h) => h.quantity > 0);
}

/** Whether the item appears in any signing record (used to decide hard-delete vs deactivate). */
export async function getItemUsageCount(itemId: string): Promise<number> {
  const { count, error } = await supabase
    .from('signing_items')
    .select('id', { count: 'exact', head: true })
    .eq('item_id', itemId);
  if (error) throw error;
  return count ?? 0;
}
