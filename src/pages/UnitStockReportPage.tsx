import { Fragment, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { supabase } from '../lib/supabase';
import { loadUnitStockMatrix, type UnitStockRow } from '../lib/unitStock';
import {
  INSPECTION_STALE_DAYS,
  inspectionStatus,
  loadUnitInspectionReport,
  markSerialInspected,
  type InspectionRow,
} from '../lib/serialInspections';
import type { Unit, Item } from '../lib/database.types';

/**
 * Unit stock report. Two views:
 *   - Matrix (quantitative): rows = items, columns = units, cells = available/stock
 *   - Inspections (detailed): per-serial, with holder soldier + status + inspection button
 *
 * Admin sees every unit; raspar is auto-restricted to their own unit.
 */
export default function UnitStockReportPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const isRaspar = profile?.role === 'raspar';
  const raspUnitId = profile?.unit_id ?? null;

  const [rows, setRows] = useState<UnitStockRow[]>([]);
  const [inspections, setInspections] = useState<InspectionRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'matrix' | 'inspections'>(profile?.role === 'admin' ? 'matrix' : 'inspections');
  // For admin: optional unit filter. Raspar: forced to their unit (never read this).
  const [unitFilter, setUnitFilter] = useState<string>('');
  const [busySerialId, setBusySerialId] = useState<string | null>(null);
  // ticks every minute so status flips from נמצא → דרוש בדיקה without a reload
  const [, setTick] = useState(0);

  const effectiveUnitFilter = isAdmin ? unitFilter : (raspUnitId ?? '');

  async function refresh() {
    setLoading(true);
    try {
      const [m, u, i, insp] = await Promise.all([
        isAdmin
          ? loadUnitStockMatrix()
          : Promise.resolve([] as UnitStockRow[]),
        supabase.from('units').select('*').order('name'),
        supabase.from('items').select('*').eq('active', true).order('name'),
        loadUnitInspectionReport(effectiveUnitFilter || null),
      ]);
      setRows(m);
      if (u.data) setUnits(u.data);
      if (i.data) setItems(i.data);
      setInspections(insp);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [effectiveUnitFilter]);

  // Tick once a minute so "last inspected" ages correctly in the UI without reload.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Matrix aggregation by (unitId, itemId) — sum across serials.
  const matrix = useMemo(() => {
    const map = new Map<string, { allocated: number; stock: number; distributed: number; available: number }>();
    for (const r of rows) {
      const key = `${r.unit_id}::${r.item_id}`;
      const cur = map.get(key) ?? { allocated: 0, stock: 0, distributed: 0, available: 0 };
      cur.allocated += r.allocated;
      cur.stock += r.stock;
      cur.distributed += r.distributed;
      cur.available += r.available;
      map.set(key, cur);
    }
    return map;
  }, [rows]);

  const itemsInReport = useMemo(() => {
    const ids = new Set(rows.map((r) => r.item_id));
    return items
      .filter((it) => ids.has(it.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }, [rows, items]);

  const unitsInReport = useMemo(() => {
    const base = unitFilter
      ? units.filter((u) => u.id === unitFilter)
      : units.filter((u) => new Set(rows.map((r) => r.unit_id)).has(u.id));
    return [...base].sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }, [rows, units, unitFilter]);

  // Inspection rows, sorted: unit → item → serial (numeric-aware).
  const sortedInspections = useMemo(() => {
    return [...inspections].sort((a, b) => {
      const u = a.unitName.localeCompare(b.unitName, 'he');
      if (u !== 0) return u;
      const it = a.itemName.localeCompare(b.itemName, 'he');
      if (it !== 0) return it;
      return a.serialNumber.localeCompare(b.serialNumber, 'he', { numeric: true });
    });
  }, [inspections]);

  // Group under unit header rows for visual separation.
  const inspectionGroups = useMemo(() => {
    const groups: Array<{ unitId: string; unitName: string; rows: InspectionRow[] }> = [];
    for (const r of sortedInspections) {
      const last = groups[groups.length - 1];
      if (last && last.unitId === r.unitId) last.rows.push(r);
      else groups.push({ unitId: r.unitId, unitName: r.unitName, rows: [r] });
    }
    return groups;
  }, [sortedInspections]);

  async function handleMarkInspected(row: InspectionRow) {
    setBusySerialId(row.serialId);
    try {
      const ts = await markSerialInspected(row.serialId);
      await logAudit({
        action: 'serial.inspected',
        targetType: 'item_serial',
        targetId: row.serialId,
        details: { item_id: row.itemId, serial: row.serialNumber, unit_id: row.unitId },
      });
      // Optimistic local update.
      setInspections((prev) => prev.map((r) => (r.serialId === row.serialId ? { ...r, lastInspectedAt: ts } : r)));
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusySerialId(null);
    }
  }

  function exportInspectionsCsv() {
    const header = ['מסגרת', 'פריט', 'צ׳', 'חייל', 'מספר אישי', 'סטטוס', 'נבדק לאחרונה'];
    const lines = [header.join(',')];
    for (const r of sortedInspections) {
      const st = inspectionStatus(r.lastInspectedAt);
      lines.push([
        r.unitName,
        r.itemName,
        r.serialNumber,
        r.soldierName ?? '',
        r.soldierPersonalNumber ?? '',
        st === 'found' ? 'נמצא' : 'דרוש בדיקה',
        r.lastInspectedAt ? new Date(r.lastInspectedAt).toLocaleString('he-IL') : '',
      ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inspections_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Raspar with no unit assigned → no report to show.
  if (!isAdmin && !isRaspar) return <Navigate to="/" replace />;
  if (isRaspar && !raspUnitId) {
    return <div className="card text-center text-slate-500">לא משוייכת לך מסגרת — פנה למנהל מערכת</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 md:mb-6 gap-3 flex-wrap">
        <h2 className="text-xl md:text-2xl font-bold">
          {isAdmin ? 'דוח מלאי מסגרות' : 'דוח מלאי המסגרת שלי'}
        </h2>
        <div className="flex gap-2">
          <button className="btn-secondary !py-1.5 !px-3 text-sm" onClick={refresh} disabled={loading}>
            רענן
          </button>
          {mode === 'inspections' && (
            <button className="btn-secondary !py-1.5 !px-3 text-sm" onClick={exportInspectionsCsv}>
              ייצא CSV
            </button>
          )}
        </div>
      </div>

      <div className="card mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">תצוגה</label>
            <select
              className="input"
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              {isAdmin && <option value="matrix">כמותי (מטריצה לפי פריט)</option>}
              <option value="inspections">בדיקות צ׳ים (לפי מסגרת / פריט / צ׳)</option>
            </select>
          </div>
          {isAdmin && (
            <div>
              <label className="label">מסגרת</label>
              <select className="input" value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)}>
                <option value="">הכל</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          )}
          <div className="flex items-end text-xs text-slate-500">
            {mode === 'inspections'
              ? `סטטוס "נמצא" תקף עד ${INSPECTION_STALE_DAYS} ימים מהבדיקה האחרונה.`
              : 'מלאי = הוקצה ע״י הגדוד. זמין = מלאי − מה שחולק לחיילים.'}
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center text-slate-500 py-6">טוען...</div>
        ) : mode === 'matrix' ? (
          rows.length === 0 ? (
            <div className="text-center text-slate-500 py-6">עדיין לא בוצעו החתמות מסגרת</div>
          ) : (
            <div className="table-wrap">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>פריט</th>
                    {unitsInReport.map((u) => (
                      <th key={u.id} className="text-center">{u.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {itemsInReport.map((it) => (
                    <tr key={it.id}>
                      <td className="font-medium whitespace-nowrap">{it.name}</td>
                      {unitsInReport.map((u) => {
                        const cell = matrix.get(`${u.id}::${it.id}`);
                        if (!cell || cell.allocated === 0) {
                          return <td key={u.id} className="text-center text-slate-300">—</td>;
                        }
                        return (
                          <td key={u.id} className="text-center">
                            <div className="text-sm font-semibold">{cell.available}</div>
                            <div className="text-[11px] text-slate-500">
                              מלאי {cell.stock} / חולק {cell.distributed}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          // Inspections view
          sortedInspections.length === 0 ? (
            <div className="text-center text-slate-500 py-6">אין צ׳ים מוקצים כרגע</div>
          ) : (
            <div className="table-wrap">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>מסגרת</th>
                    <th>פריט</th>
                    <th>צ׳</th>
                    <th>חייל</th>
                    <th className="text-center">סטטוס</th>
                    <th>נבדק לאחרונה</th>
                    <th className="w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {inspectionGroups.map((g) => (
                    <Fragment key={g.unitId}>
                      <tr className="bg-slate-100">
                        <td colSpan={7} className="font-semibold text-slate-700 px-2 py-1.5">
                          {g.unitName}
                          <span className="text-xs font-normal text-slate-500 mr-2">({g.rows.length} צ׳ים)</span>
                        </td>
                      </tr>
                      {g.rows.map((r) => {
                        const st = inspectionStatus(r.lastInspectedAt);
                        const canMark = isAdmin || (isRaspar && r.unitId === raspUnitId);
                        return (
                          <tr key={r.serialId}>
                            <td>{r.unitName}</td>
                            <td>{r.itemName}</td>
                            <td className="font-mono text-xs" dir="ltr">{r.serialNumber}</td>
                            <td className="text-sm">
                              {r.soldierName ? (
                                <span>
                                  {r.soldierName}
                                  {r.soldierPersonalNumber && (
                                    <span className="text-slate-500 text-xs"> ({r.soldierPersonalNumber})</span>
                                  )}
                                </span>
                              ) : (
                                <span className="text-slate-400 text-xs">במחסן המסגרת</span>
                              )}
                            </td>
                            <td className="text-center">
                              {st === 'found' ? (
                                <span className="badge bg-emerald-100 text-emerald-700">נמצא</span>
                              ) : (
                                <span className="badge bg-amber-100 text-amber-800">דרוש בדיקה</span>
                              )}
                            </td>
                            <td className="text-xs text-slate-600">
                              {r.lastInspectedAt
                                ? new Date(r.lastInspectedAt).toLocaleString('he-IL')
                                : '—'}
                            </td>
                            <td>
                              {canMark && (
                                <button
                                  onClick={() => handleMarkInspected(r)}
                                  disabled={busySerialId === r.serialId}
                                  title="סמן כ״נמצא״ — מעדכן תאריך בדיקה"
                                  aria-label="סמן כנמצא"
                                  className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-900 disabled:opacity-50 text-sm"
                                >
                                  <span aria-hidden>👁</span>
                                  <span>נמצא</span>
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}
