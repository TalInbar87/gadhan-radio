import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { SigningType, Team, Unit } from '../lib/database.types';

interface SigningRow {
  id: string;
  type: SigningType;
  notes: string | null;
  created_at: string;
  unit_id: string;
  team_id: string | null;
  soldier: { full_name: string; personal_number: string; pdf_url: string | null } | null;
  performer: { full_name: string } | null;
  items: Array<{
    quantity: number;
    action: string;
    serial_number: string | null;
    item: { name: string } | null;
  }>;
}

const TYPE_LABEL: Record<SigningType, string> = {
  signing: 'החתמה',
  return: 'זיכוי',
  inspection: 'בדיקה',
};
const TYPE_BADGE: Record<SigningType, string> = {
  signing: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  return: 'bg-amber-50 text-amber-700 border-amber-200',
  inspection: 'bg-sky-50 text-sky-700 border-sky-200',
};

export default function SigningsPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [rows, setRows] = useState<SigningRow[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);

  // filters
  const [unitId, setUnitId] = useState<string>(isAdmin ? '' : profile?.unit_id ?? '');
  const [teamId, setTeamId] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<SigningType | ''>('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');

  useEffect(() => {
    (async () => {
      const [u, t] = await Promise.all([
        supabase.from('units').select('*').order('name'),
        supabase.from('teams').select('*').order('name'),
      ]);
      if (u.data) setUnits(u.data);
      if (t.data) setTeams(t.data);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('signings')
        .select(`
          id, type, notes, created_at, unit_id, team_id,
          soldier:soldiers(full_name, personal_number, pdf_url),
          performer:profiles!signings_performed_by_fkey(full_name),
          items:signing_items(quantity, action, serial_number, item:items(name))
        `)
        .order('created_at', { ascending: false })
        .limit(500);
      setLoading(false);
      if (!error && data) setRows(data as unknown as SigningRow[]);
    })();
  }, []);

  const teamsForUnit = useMemo(
    () => teams.filter((t) => t.unit_id === unitId),
    [teams, unitId]
  );

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (unitId && r.unit_id !== unitId) return false;
      if (teamId && r.team_id !== teamId) return false;
      if (typeFilter && r.type !== typeFilter) return false;
      if (from && r.created_at < from) return false;
      if (to && r.created_at > to + 'T23:59:59') return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = [
          r.soldier?.full_name,
          r.soldier?.personal_number,
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
  }, [rows, unitId, teamId, typeFilter, from, to, search]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 md:mb-6 gap-3 flex-wrap">
        <h2 className="text-xl md:text-2xl font-bold">כל ההחתמות</h2>
        <div className="text-sm text-slate-500">{filtered.length} מתוך {rows.length}</div>
      </div>

      <div className="card mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-3">
          <div>
            <label className="label">מסגרת</label>
            <select
              className="input"
              value={unitId}
              onChange={(e) => { setUnitId(e.target.value); setTeamId(''); }}
              disabled={!isAdmin}
            >
              <option value="">הכל</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">צוות</label>
            <select
              className="input"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              disabled={!unitId || teamsForUnit.length === 0}
            >
              <option value="">הכל</option>
              {teamsForUnit.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">סוג</label>
            <select
              className="input"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as SigningType | '')}
            >
              <option value="">הכל</option>
              <option value="signing">החתמה</option>
              <option value="return">זיכוי</option>
              <option value="inspection">בדיקה</option>
            </select>
          </div>
          <div>
            <label className="label">מתאריך</label>
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">עד תאריך</label>
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="label">חיפוש</label>
            <input
              className="input"
              placeholder="חייל / מס׳ אישי / צ' / פריט..."
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
                <th>חייל</th>
                <th>מסגרת</th>
                <th>צוות</th>
                <th>מבצע</th>
                <th>פריטים</th>
                <th>הערות</th>
                <th>PDF</th>
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
                  <td>
                    {r.soldier?.full_name ?? '—'}
                    {r.soldier?.personal_number && (
                      <div className="text-xs text-slate-500">{r.soldier.personal_number}</div>
                    )}
                  </td>
                  <td>{units.find((u) => u.id === r.unit_id)?.name ?? '—'}</td>
                  <td>{teams.find((t) => t.id === r.team_id)?.name ?? '—'}</td>
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
                  <td>
                    {r.soldier?.pdf_url ? (
                      <a
                        href={r.soldier.pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-emerald-700 hover:underline text-xs"
                      >
                        פתח
                      </a>
                    ) : (
                      <span className="text-slate-400 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="text-center text-slate-500 py-6">אין החתמות</td></tr>
              )}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
