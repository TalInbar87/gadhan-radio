import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { loadSoldierHeldItems, type HeldItem } from '../lib/heldItems';
import type { Soldier, Team, Unit } from '../lib/database.types';

export default function SoldiersPage() {
  const { profile } = useAuth();
  const [soldiers, setSoldiers] = useState<Soldier[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ full_name: '', personal_number: '', phone: '', unit_id: '', team_id: '' });
  const [selected, setSelected] = useState<Soldier | null>(null);
  const [heldItems, setHeldItems] = useState<HeldItem[] | null>(null);
  const [heldLoading, setHeldLoading] = useState(false);
  const isAdmin = profile?.role === 'admin';

  async function load() {
    const [s, u, t] = await Promise.all([
      supabase.from('soldiers').select('*').order('full_name'),
      supabase.from('units').select('*').order('name'),
      supabase.from('teams').select('*').order('name'),
    ]);
    if (s.data) setSoldiers(s.data);
    if (u.data) setUnits(u.data);
    if (t.data) setTeams(t.data);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!isAdmin && profile?.unit_id) setForm((f) => ({ ...f, unit_id: profile.unit_id! })); }, [isAdmin, profile?.unit_id]);

  const filtered = soldiers.filter(
    (s) => s.full_name.includes(search) || s.personal_number.includes(search)
  );

  async function openSoldier(s: Soldier) {
    setSelected(s);
    setHeldItems(null);
    setHeldLoading(true);
    try {
      const held = await loadSoldierHeldItems(s.id);
      setHeldItems(held);
    } finally {
      setHeldLoading(false);
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const { data, error } = await supabase.from('soldiers').insert({
      full_name: form.full_name,
      personal_number: form.personal_number,
      phone: form.phone || null,
      unit_id: form.unit_id,
      team_id: form.team_id || null,
    }).select().single();
    if (error) return alert(error.message);
    await logAudit({ action: 'soldier.create', targetType: 'soldier', targetId: data.id, details: { name: form.full_name } });
    setForm({ full_name: '', personal_number: '', phone: '', unit_id: isAdmin ? '' : profile?.unit_id ?? '', team_id: '' });
    setShowAdd(false);
    load();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">חיילים</h2>
        <button onClick={() => setShowAdd(!showAdd)} className="btn-primary">
          {showAdd ? 'בטל' : '+ חייל חדש'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="card mb-6 grid grid-cols-5 gap-3">
          <div>
            <label className="label">שם מלא</label>
            <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          </div>
          <div>
            <label className="label">מספר אישי</label>
            <input className="input" value={form.personal_number} onChange={(e) => setForm({ ...form, personal_number: e.target.value })} required />
          </div>
          <div>
            <label className="label">טלפון</label>
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label className="label">מסגרת</label>
            <select className="input" value={form.unit_id} onChange={(e) => setForm({ ...form, unit_id: e.target.value, team_id: '' })} disabled={!isAdmin} required>
              <option value="">— בחר —</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">צוות</label>
            <select
              className="input"
              value={form.team_id}
              onChange={(e) => setForm({ ...form, team_id: e.target.value })}
              disabled={!form.unit_id || teams.filter((t) => t.unit_id === form.unit_id).length === 0}
            >
              <option value="">— ללא —</option>
              {teams.filter((t) => t.unit_id === form.unit_id).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="col-span-5 flex justify-end">
            <button type="submit" className="btn-primary">שמור</button>
          </div>
        </form>
      )}

      <div className="card">
        <input
          className="input mb-4"
          placeholder="חיפוש לפי שם או מס' אישי..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <table className="table-base">
          <thead>
            <tr>
              <th>שם מלא</th>
              <th>מספר אישי</th>
              <th>טלפון</th>
              <th>מסגרת</th>
              <th>צוות</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id}>
                <td>
                  <button
                    type="button"
                    onClick={() => openSoldier(s)}
                    className="text-emerald-700 hover:text-emerald-900 hover:underline font-medium text-right"
                  >
                    {s.full_name}
                  </button>
                </td>
                <td>{s.personal_number}</td>
                <td>{s.phone ?? '—'}</td>
                <td>{units.find((u) => u.id === s.unit_id)?.name ?? '—'}</td>
                <td>{teams.find((t) => t.id === s.team_id)?.name ?? '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-6">אין נתונים</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold">{selected.full_name}</h3>
                <div className="text-xs text-slate-500 mt-1">
                  מס׳ אישי {selected.personal_number}
                  {' · '}
                  {units.find((u) => u.id === selected.unit_id)?.name ?? '—'}
                  {selected.team_id && (
                    <> {' · '} {teams.find((t) => t.id === selected.team_id)?.name ?? '—'}</>
                  )}
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-slate-400 hover:text-slate-700 text-xl leading-none"
              >
                ×
              </button>
            </div>

            {selected.pdf_drive_file_id && (
              <div className="mb-3">
                <a
                  href={`https://drive.google.com/file/d/${selected.pdf_drive_file_id}/view`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-emerald-700 hover:underline"
                >
                  הצג PDF עדכני ↗
                </a>
              </div>
            )}
            <div className="text-sm font-semibold text-slate-700 mb-2">פריטים חתומים</div>
            {heldLoading ? (
              <div className="text-sm text-slate-500">טוען...</div>
            ) : !heldItems || heldItems.length === 0 ? (
              <div className="text-sm text-slate-500">אין פריטים חתומים</div>
            ) : (
              <ul className="text-sm space-y-1 max-h-72 overflow-auto">
                {heldItems.map((h) => (
                  <li
                    key={`${h.itemId}::${h.serialNumber ?? ''}`}
                    className="flex justify-between border-b border-slate-100 py-1.5"
                  >
                    <span>
                      {h.itemName}
                      {h.serialNumber && (
                        <span className="text-slate-500 text-xs"> [צ' {h.serialNumber}]</span>
                      )}
                    </span>
                    <span className="text-slate-600">x{h.quantity}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
