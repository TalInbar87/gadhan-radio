import { supabase } from './supabase';
import type { UnitItemStock } from './database.types';

export interface UnitStockRow extends UnitItemStock {
  itemName: string;
  unitName: string;
}

/**
 * Availability per item (ignoring serial_number) in a given unit.
 * Returns only items with available > 0, suitable for the raspar sign form.
 */
export async function loadUnitAvailability(unitId: string): Promise<Array<{ itemId: string; itemName: string; available: number; stock: number; distributed: number }>> {
  const { data, error } = await supabase
    .from('unit_item_stock')
    .select('item_id, stock, distributed, available, item:items(name)')
    .eq('unit_id', unitId);
  if (error) throw error;

  // Aggregate across serial numbers → one row per item.
  const agg = new Map<string, { itemId: string; itemName: string; available: number; stock: number; distributed: number }>();
  for (const r of (data ?? []) as unknown as Array<{
    item_id: string;
    stock: number;
    distributed: number;
    available: number;
    item: { name: string } | null;
  }>) {
    const cur = agg.get(r.item_id) ?? {
      itemId: r.item_id,
      itemName: r.item?.name ?? '?',
      available: 0,
      stock: 0,
      distributed: 0,
    };
    cur.available += r.available;
    cur.stock += r.stock;
    cur.distributed += r.distributed;
    agg.set(r.item_id, cur);
  }
  return Array.from(agg.values()).sort((a, b) => a.itemName.localeCompare(b.itemName, 'he'));
}

/**
 * Full matrix for the admin "unit stock report": every (unit × item × serial)
 * row from the view, enriched with names.
 */
export async function loadUnitStockMatrix(): Promise<UnitStockRow[]> {
  const { data, error } = await supabase
    .from('unit_item_stock')
    .select(`
      unit_id, item_id, serial_number, allocated, returned_up, stock, distributed, available,
      unit:units(name), item:items(name)
    `);
  if (error) throw error;

  return ((data ?? []) as unknown as Array<UnitItemStock & { unit: { name: string } | null; item: { name: string } | null }>).map((r) => ({
    unit_id: r.unit_id,
    item_id: r.item_id,
    serial_number: r.serial_number,
    allocated: r.allocated,
    returned_up: r.returned_up,
    stock: r.stock,
    distributed: r.distributed,
    available: r.available,
    itemName: r.item?.name ?? '?',
    unitName: r.unit?.name ?? '?',
  }));
}

/**
 * Items currently held at the unit level (allocated by battalion, not yet returned)
 * — used as the "returnable to battalion" list when admin does a unit return.
 * Grouped by (item_id, serial_number), only rows where stock > 0.
 */
export async function loadUnitHeldForReturn(unitId: string): Promise<Array<{ itemId: string; itemName: string; serialNumber: string | null; quantity: number }>> {
  const { data, error } = await supabase
    .from('unit_item_stock')
    .select('item_id, serial_number, stock, item:items(name)')
    .eq('unit_id', unitId)
    .gt('stock', 0);
  if (error) throw error;

  return ((data ?? []) as unknown as Array<{
    item_id: string;
    serial_number: string | null;
    stock: number;
    item: { name: string } | null;
  }>).map((r) => ({
    itemId: r.item_id,
    itemName: r.item?.name ?? '?',
    serialNumber: r.serial_number,
    quantity: r.stock,
  }));
}
