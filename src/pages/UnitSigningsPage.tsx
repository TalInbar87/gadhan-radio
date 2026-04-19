import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { Unit, UnitSigningType } from '../lib/database.types';

interface UnitSigningRow {
  id: string;
  type: UnitSigningType;
  notes: string | null;
  created_at: string;
  unit_id: string;
  performer: { full_name: string } | null;
  items: Array<{
    quantity: number;
    action: string;
    serial_number: string | null;
    item: { name: string } | null;
  }>;
}

const TYPE_LABEL: Record<UnitSigningType, string> = {
  signing: 'הקצאה',
  return: 'החזרה',
};
const TYPE_BADGE: Record<UnitSigningType, string> = {
  signing: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  return: 'bg-amber-50 text-amber-700 border-amber-200',
};

export default function UnitSigningsPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [rows, setRows] = useState<UnitSigningRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(false);

  const [unitId, setUnitId] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<UnitSigningType | ''>('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    (async () => {
      const u = await supabase.from('units').select('*').order('name');
      if (u.data) setUnits(u.data);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('unit_signings')
        .select(`
          id, type, notes, created_at, unit_id,
          performer:profiles!unit_signings_performed_by_fkey(full_name),
          items:unit_signing_items(quantity, action, serial_number, item:items(name))
        `)
        .order('created_at', { ascending: false })
        .limit(500);
      setLoading(false);
      if (!error && data) setRows(data as unknown as UnitSigningRow[]);
    })();
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (unitId && r.unit_id !== unitId) return false;
      if (typeFilter && r.type !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = [
          r.performer?.full_name,
          r.notes,
          ...r.items.map((i) => i.item?.name ?? ''),
          ...r.items.map((i) => i.serial_number ?? ''),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, unitId, typeFilter, search]);

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div>
      <div className="flex items-center justify-between mb-4 md:mb-6 gap-3 flex-wrap">
        <h2 className="text-xl md:text-2xl font-bold">החתמות מסגרות</h2>
        <div className="text-sm text-slate-500">{filtered.length} מתוך {rows.length}</div>
      </div>

      <div className="card mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label className="label">מסגרת</label>
            <select className="input" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">הכל</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">סוג</label>
            <select
              className="input"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as UnitSigningType | '')}
            >
              <option value="">הכל</option>
              <option value="signing">הקצאה</option>
              <option value="return">החזרה</option>
            </select>
          </div>
          <div>
            <label className="label">חיפוש</label>
            <input
              className="input"
              placeholder="מבצע / פריט / צ'..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="text-center text-slate-500 py-6">טוען...</div>
        ) : (
          <div className="table-wrap">
            <table className="table-base">
              <thead>
                <tr>
                  <th>תאריך</th>
                  <th>סוג</th>
                  <th>מסגרת</th>
                  <th>מבצע</th>
                  <th>פריטים</th>
                  <th>הערות</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-xs">
                      {new Date(r.created_at).toLocaleString('he-IL')}
                    </td>
                    <td>
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${TYPE_BADGE[r.type]}`}>
                        {TYPE_LABEL[r.type]}
                      </span>
                    </td>
                    <td>{units.find((u) => u.id === r.unit_id)?.name ?? '—'}</td>
                    <td>{r.performer?.full_name ?? '—'}</td>
                    <td>
                      <ul className="text-xs space-y-0.5">
                        {r.items.map((i, idx) => (
                          <li key={idx}>
                            {i.item?.name ?? '?'}
                            {i.serial_number && <span className="text-slate-500"> [צ' {i.serial_number}]</span>}
                            <span className="text-slate-500"> x{i.quantity}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="text-xs text-slate-600 max-w-[16rem]">{r.notes ?? '—'}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="text-center text-slate-500 py-6">אין רשומות</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
