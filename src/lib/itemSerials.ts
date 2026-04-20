import { supabase } from './supabase';
import type { ItemSerial } from './database.types';

export interface SerialLocation {
  serialId: string;
  itemId: string;
  serialNumber: string;
  currentUnitId: string | null; // null → at battalion
}

/** All registered serials for a given item. */
export async function listItemSerials(itemId: string): Promise<ItemSerial[]> {
  const { data, error } = await supabase
    .from('item_serials')
    .select('*')
    .eq('item_id', itemId)
    .order('serial_number');
  if (error) throw error;
  return data ?? [];
}

/**
 * Bulk add serials for an item. Deduplicates vs whatever already exists
 * (UPSERT on unique (item_id, serial_number)).
 * Returns the number of rows newly inserted.
 */
export async function addItemSerials(itemId: string, serials: string[]): Promise<number> {
  const cleaned = Array.from(new Set(serials.map((s) => s.trim()).filter(Boolean)));
  if (cleaned.length === 0) return 0;
  // Filter to only those not already in the table.
  const { data: existing, error: existErr } = await supabase
    .from('item_serials')
    .select('serial_number')
    .eq('item_id', itemId)
    .in('serial_number', cleaned);
  if (existErr) throw existErr;
  const have = new Set((existing ?? []).map((r) => r.serial_number));
  const toInsert = cleaned.filter((s) => !have.has(s));
  if (toInsert.length === 0) return 0;
  const { error } = await supabase
    .from('item_serials')
    .insert(toInsert.map((s) => ({ item_id: itemId, serial_number: s })));
  if (error) throw error;
  return toInsert.length;
}

export async function removeItemSerial(serialId: string): Promise<void> {
  const { error } = await supabase.from('item_serials').delete().eq('id', serialId);
  if (error) throw error;
}

/**
 * Serials currently AT THE BATTALION for the given item — i.e. registered
 * but not currently allocated to any unit. Used by the admin unit-signing
 * form to pick what to hand out.
 */
export async function loadBattalionSerials(itemId: string): Promise<Array<{ serialId: string; serialNumber: string }>> {
  const { data, error } = await supabase
    .from('item_serial_status')
    .select('serial_id, serial_number, current_unit_id')
    .eq('item_id', itemId)
    .is('current_unit_id', null)
    .order('serial_number');
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{ serial_id: string; serial_number: string; current_unit_id: string | null }>)
    .map((r) => ({ serialId: r.serial_id, serialNumber: r.serial_number }));
}

/**
 * Full status of every registered serial for an item — useful for the
 * per-item serials modal in ItemsPage (shows where each serial currently is).
 */
export async function loadItemSerialStatus(itemId: string): Promise<SerialLocation[]> {
  const { data, error } = await supabase
    .from('item_serial_status')
    .select('serial_id, item_id, serial_number, current_unit_id')
    .eq('item_id', itemId)
    .order('serial_number');
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{
    serial_id: string;
    item_id: string;
    serial_number: string;
    current_unit_id: string | null;
  }>).map((r) => ({
    serialId: r.serial_id,
    itemId: r.item_id,
    serialNumber: r.serial_number,
    currentUnitId: r.current_unit_id,
  }));
}

/**
 * Parse a free-form text blob (newline / comma / space / tab separated) into
 * a clean list of serial numbers. Drops duplicates and empty entries.
 */
export function parseSerialBlob(blob: string): string[] {
  return Array.from(
    new Set(
      blob
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}
