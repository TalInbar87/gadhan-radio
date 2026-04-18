import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { AuditLog, Profile } from '../lib/database.types';

interface Row extends AuditLog {
  performer_name?: string;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      const ids = Array.from(new Set((data ?? []).map((l) => l.performed_by).filter(Boolean) as string[]));
      const profiles = ids.length
        ? (await supabase.from('profiles').select('id,full_name').in('id', ids)).data ?? []
        : [];
      const map = new Map<string, Profile>(profiles.map((p) => [p.id, p as Profile]));
      setLogs(
        (data ?? []).map((l) => ({
          ...l,
          performer_name: l.performed_by ? map.get(l.performed_by)?.full_name : undefined,
        }))
      );
    })();
  }, []);

  const filtered = logs.filter(
    (l) => !filter || l.action.includes(filter) || (l.performer_name ?? '').includes(filter)
  );

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">יומן ביקורת</h2>
      <div className="card">
        <input
          className="input mb-4"
          placeholder="סינון לפי פעולה או מבצע..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <table className="table-base">
          <thead>
            <tr>
              <th>תאריך</th>
              <th>פעולה</th>
              <th>מבצע</th>
              <th>יעד</th>
              <th>פרטים</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr key={l.id}>
                <td className="text-xs text-slate-500 whitespace-nowrap">
                  {new Date(l.created_at).toLocaleString('he-IL')}
                </td>
                <td><span className="badge bg-blue-100 text-blue-700">{l.action}</span></td>
                <td>{l.performer_name ?? '—'}</td>
                <td className="text-xs text-slate-500">{l.target_type ?? '—'}</td>
                <td className="text-xs text-slate-500 max-w-xs truncate">
                  {l.details ? JSON.stringify(l.details) : '—'}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-6">אין רשומות</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
