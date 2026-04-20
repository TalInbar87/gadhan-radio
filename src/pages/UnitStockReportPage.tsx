import { Fragment, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { loadUnitStockMatrix, type UnitStockRow } from '../lib/unitStock';
import type { Unit, Item } from '../lib/database.types';

/**
 * Admin "unit stock report". Two views:
 *  - Matrix (default): rows = items, columns = units, cells = available/stock
 *  - Detailed: the raw row-per-(unit,item,serial) from the view
 */
export default function UnitStockReportPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [rows, setRows] = useState<UnitStockRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'matrix' | 'detailed'>('matrix');
  const [unitFilter, setUnitFilter] = useState<string>('');

  async function refresh() {
    setLoading(true);
    try {
      const [m, u, i] = await Promise.all([
        loadUnitStockMatrix(),
        supabase.from('units').select('*').order('name'),
        supabase.from('items').select('*').eq('active', true).order('name'),
      ]);
      setRows(m);
      if (u.data) setUnits(u.data);
      if (i.data) setItems(i.data);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, []);

  // Aggregate by (unitId, itemId) for the matrix view — sum across serials.
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

  // Only show items that appear in at least one unit (to keep the matrix compact).
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

  const filteredDetailed = useMemo(() => {
    const base = unitFilter ? rows.filter((r) => r.unit_id === unitFilter) : rows;
    // Sort: unit (Hebrew) → item (Hebrew) → serial (numeric-aware).
    return [...base].sort((a, b) => {
      const u = a.unitName.localeCompare(b.unitName, 'he');
      if (u !== 0) return u;
      const it = a.itemName.localeCompare(b.itemName, 'he');
      if (it !== 0) return it;
      return (a.serial_number ?? '').localeCompare(b.serial_number ?? '', 'he', { numeric: true });
    });
  }, [rows, unitFilter]);

  // Group sorted rows under their unit for visual separation in the detailed table.
  const detailedGroups = useMemo(() => {
    const groups: Array<{ unitId: string; unitName: string; rows: UnitStockRow[] }> = [];
    for (const r of filteredDetailed) {
      const last = groups[groups.length - 1];
      if (last && last.unitId === r.unit_id) {
        last.rows.push(r);
      } else {
        groups.push({ unitId: r.unit_id, unitName: r.unitName, rows: [r] });
      }
    }
    return groups;
  }, [filteredDetailed]);

  function exportCsv() {
    const header = ['מסגרת', 'פריט', 'צ׳', 'הוקצה', 'הוחזר לגדוד', 'מלאי', 'חולק לחיילים', 'זמין'];
    const lines = [header.join(',')];
    for (const r of filteredDetailed) {
      lines.push([
        r.unitName,
        r.itemName,
        r.serial_number ?? '',
        r.allocated,
        r.returned_up,
        r.stock,
        r.distributed,
        r.available,
      ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unit-stock_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div>
      <div className="flex items-center justify-between mb-4 md:mb-6 gap-3 flex-wrap">
        <h2 className="text-xl md:text-2xl font-bold">דוח מלאי מסגרות</h2>
        <div className="flex gap-2">
          <button className="btn-secondary !py-1.5 !px-3 text-sm" onClick={refresh} disabled={loading}>
            רענן
          </button>
          <button className="btn-secondary !py-1.5 !px-3 text-sm" onClick={exportCsv}>
            ייצא CSV
          </button>
        </div>
      </div>

      <div className="card mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">תצוגה</label>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="matrix">מטריצה (סיכום לפי פריט)</option>
              <option value="detailed">פירוט (כולל צ'ים)</option>
            </select>
          </div>
          <div>
            <label className="label">מסגרת</label>
            <select className="input" value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)}>
              <option value="">הכל</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="flex items-end text-xs text-slate-500">
            מלאי = הוקצה ע״י הגדוד. זמין = מלאי − מה שחולק לחיילים.
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center text-slate-500 py-6">טוען...</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-slate-500 py-6">עדיין לא בוצעו החתמות מסגרת</div>
        ) : mode === 'matrix' ? (
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
        ) : (
          <div className="table-wrap">
            <table className="table-base">
              <thead>
                <tr>
                  <th>מסגרת</th>
                  <th>פריט</th>
                  <th>צ׳</th>
                  <th className="text-center">הוקצה</th>
                  <th className="text-center">הוחזר לגדוד</th>
                  <th className="text-center">מלאי</th>
                  <th className="text-center">חולק לחיילים</th>
                  <th className="text-center">זמין</th>
                </tr>
              </thead>
              <tbody>
                {detailedGroups.map((g) => (
                  <Fragment key={g.unitId}>
                    <tr className="bg-slate-100">
                      <td colSpan={8} className="font-semibold text-slate-700 px-2 py-1.5">
                        {g.unitName}
                        <span className="text-xs font-normal text-slate-500 mr-2">({g.rows.length} שורות)</span>
                      </td>
                    </tr>
                    {g.rows.map((r, idx) => (
                      <tr key={`${r.unit_id}-${r.item_id}-${r.serial_number ?? ''}-${idx}`}>
                        <td>{r.unitName}</td>
                        <td>{r.itemName}</td>
                        <td className="text-xs">{r.serial_number ?? '—'}</td>
                        <td className="text-center">{r.allocated}</td>
                        <td className="text-center">{r.returned_up}</td>
                        <td className="text-center font-medium">{r.stock}</td>
                        <td className="text-center">{r.distributed}</td>
                        <td className={`text-center font-semibold ${r.available < 0 ? 'text-red-600' : r.available === 0 ? 'text-slate-400' : 'text-emerald-700'}`}>
                          {r.available}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
                {filteredDetailed.length === 0 && (
                  <tr><td colSpan={8} className="text-center text-slate-500 py-6">אין רשומות</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
