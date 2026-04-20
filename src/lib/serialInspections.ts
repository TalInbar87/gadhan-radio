import { supabase } from './supabase';

export const INSPECTION_STALE_DAYS = 7;

export type InspectionStatus = 'found' | 'needs-inspection';

export interface InspectionRow {
  serialId: string;
  itemId: string;
  itemName: string;
  serialNumber: string;
  unitId: string;
  unitName: string;
  /** Null = currently at the unit (warehouse), not handed to a soldier. */
  soldierId: string | null;
  soldierName: string | null;
  soldierPersonalNumber: string | null;
  lastInspectedAt: string | null;
}

/** Derive status: "found" if inspected within the last week, else "needs-inspection". */
export function inspectionStatus(lastInspectedAt: string | null): InspectionStatus {
  if (!lastInspectedAt) return 'needs-inspection';
  const ageMs = Date.now() - new Date(lastInspectedAt).getTime();
  const weekMs = INSPECTION_STALE_DAYS * 24 * 60 * 60 * 1000;
  return ageMs <= weekMs ? 'found' : 'needs-inspection';
}

/**
 * Load the inspection report for the given unit — one row per serial currently
 * allocated to the unit. If `unitId` is null, loads for all units (admin).
 *
 * Uses manual joins because PostgREST can't auto-resolve FKs through a view.
 */
export async function loadUnitInspectionReport(unitId: string | null): Promise<InspectionRow[]> {
  let query = supabase
    .from('item_serial_status')
    .select('serial_id, item_id, serial_number, current_unit_id, current_soldier_id, last_inspected_at')
    .not('current_unit_id', 'is', null);
  if (unitId) query = query.eq('current_unit_id', unitId);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    serial_id: string;
    item_id: string;
    serial_number: string;
    current_unit_id: string;
    current_soldier_id: string | null;
    last_inspected_at: string | null;
  }>;

  const itemIds = Array.from(new Set(rows.map((r) => r.item_id)));
  const unitIds = Array.from(new Set(rows.map((r) => r.current_unit_id)));
  const soldierIds = Array.from(new Set(rows.map((r) => r.current_soldier_id).filter((id): id is string => !!id)));

  const [itemsRes, unitsRes, soldiersRes] = await Promise.all([
    itemIds.length
      ? supabase.from('items').select('id, name').in('id', itemIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    unitIds.length
      ? supabase.from('units').select('id, name').in('id', unitIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    soldierIds.length
      ? supabase.from('soldiers').select('id, full_name, personal_number').in('id', soldierIds)
      : Promise.resolve({ data: [] as Array<{ id: string; full_name: string; personal_number: string }>, error: null }),
  ]);
  const itemName = new Map((itemsRes.data ?? []).map((r) => [r.id, r.name]));
  const unitName = new Map((unitsRes.data ?? []).map((r) => [r.id, r.name]));
  const soldier = new Map(
    ((soldiersRes.data ?? []) as Array<{ id: string; full_name: string; personal_number: string }>)
      .map((s) => [s.id, { name: s.full_name, pn: s.personal_number }]),
  );

  return rows.map((r) => ({
    serialId: r.serial_id,
    itemId: r.item_id,
    itemName: itemName.get(r.item_id) ?? '?',
    serialNumber: r.serial_number,
    unitId: r.current_unit_id,
    unitName: unitName.get(r.current_unit_id) ?? '?',
    soldierId: r.current_soldier_id,
    soldierName: r.current_soldier_id ? (soldier.get(r.current_soldier_id)?.name ?? null) : null,
    soldierPersonalNumber: r.current_soldier_id ? (soldier.get(r.current_soldier_id)?.pn ?? null) : null,
    lastInspectedAt: r.last_inspected_at,
  }));
}

/** Mark this serial as inspected now. Returns the new timestamp. */
export async function markSerialInspected(serialId: string): Promise<string> {
  const now = new Date().toISOString();
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('item_serials')
    .update({ last_inspected_at: now, last_inspected_by: userData.user?.id ?? null })
    .eq('id', serialId);
  if (error) throw error;
  return now;
}
