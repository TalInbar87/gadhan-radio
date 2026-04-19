import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { logAudit } from '../lib/audit';
import type { Profile, Role, Unit } from '../lib/database.types';

interface NewUserForm {
  username: string;
  password: string;
  full_name: string;
  role: Role;
  unit_id: string;
  personal_number: string;
  phone: string;
}

const EMPTY_FORM: NewUserForm = {
  username: '',
  password: '',
  full_name: '',
  role: 'raspar',
  unit_id: '',
  personal_number: '',
  phone: '',
};

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export default function UsersPage() {
  const { profile: me } = useAuth();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<NewUserForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  async function load() {
    const [p, u] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('units').select('*').order('name'),
    ]);
    if (p.data) setProfiles(p.data);
    if (u.data) setUnits(u.data);
  }
  useEffect(() => { load(); }, []);

  async function update(id: string, patch: Partial<Profile>) {
    const { error } = await supabase.from('profiles').update(patch).eq('id', id);
    if (error) return alert(error.message);
    await logAudit({ action: 'user.update', targetType: 'profile', targetId: id, details: patch as Record<string, unknown> });
    load();
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    const username = form.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      return setFeedback({ type: 'error', msg: 'שם משתמש: אנגלית/ספרות בלבד, 3–32 תווים (מותרים גם . _ -)' });
    }
    if (form.password.length < 6) {
      return setFeedback({ type: 'error', msg: 'סיסמה חייבת להיות לפחות 6 תווים' });
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('manage-users', {
        body: {
          action: 'create',
          username,
          password: form.password,
          full_name: form.full_name.trim(),
          role: form.role,
          unit_id: form.unit_id || null,
          personal_number: form.personal_number.trim() || null,
          phone: form.phone.trim() || null,
        },
      });
      if (error) throw error;
      const res = data as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(res.error ?? 'שגיאה לא ידועה');
      setFeedback({ type: 'success', msg: 'המשתמש נוצר בהצלחה' });
      setForm(EMPTY_FORM);
      setShowAdd(false);
      load();
    } catch (err) {
      setFeedback({ type: 'error', msg: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(p: Profile) {
    if (p.id === me?.id) {
      return alert('אי אפשר למחוק את עצמך');
    }
    if (!confirm(`למחוק את "${p.full_name}" לצמיתות? פעולה זו לא ניתנת לביטול.`)) return;
    try {
      const { data, error } = await supabase.functions.invoke('manage-users', {
        body: { action: 'delete', user_id: p.id },
      });
      if (error) throw error;
      const res = data as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(res.error ?? 'שגיאה לא ידועה');
      setFeedback({ type: 'success', msg: 'המשתמש נמחק' });
      load();
    } catch (err) {
      setFeedback({ type: 'error', msg: `מחיקה נכשלה: ${(err as Error).message}` });
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h2 className="text-xl md:text-2xl font-bold">ניהול משתמשים</h2>
        <button
          onClick={() => { setShowAdd((v) => !v); setFeedback(null); }}
          className="btn-primary"
        >
          {showAdd ? 'בטל' : '+ משתמש חדש'}
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-6">
        יצירת משתמש כאן יוצרת חשבון Auth + פרופיל. מחיקה מוחקת לצמיתות (כולל הרשאות גישה).
      </p>

      {feedback && (
        <div className={`rounded-lg px-3 py-2 text-sm mb-4 ${feedback.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {feedback.msg}
        </div>
      )}

      {showAdd && (
        <form onSubmit={handleCreate} className="card mb-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label className="label">שם מלא *</label>
            <input className="input" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          </div>
          <div>
            <label className="label">שם משתמש *</label>
            <input
              className="input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') })}
              pattern="[a-z0-9._\-]{3,32}"
              title="אנגלית/ספרות בלבד, 3–32 תווים"
              placeholder="לדוגמה: yossi.k"
              required
              dir="ltr"
            />
          </div>
          <div>
            <label className="label">סיסמה *</label>
            <input type="password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={6} />
          </div>
          <div>
            <label className="label">תפקיד *</label>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="raspar">רס"פ</option>
              <option value="admin">מנהל מערכת</option>
            </select>
          </div>
          <div>
            <label className="label">מסגרת</label>
            <select className="input" value={form.unit_id} onChange={(e) => setForm({ ...form, unit_id: e.target.value })}>
              <option value="">— ללא —</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">מספר אישי</label>
            <input className="input" value={form.personal_number} onChange={(e) => setForm({ ...form, personal_number: e.target.value })} />
          </div>
          <div>
            <label className="label">טלפון</label>
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="sm:col-span-2 md:col-span-3 flex justify-end">
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? 'יוצר...' : 'צור משתמש'}
            </button>
          </div>
        </form>
      )}

      <div className="card">
        <div className="table-wrap">
        <table className="table-base">
          <thead>
            <tr>
              <th>שם</th>
              <th>שם משתמש</th>
              <th>תפקיד</th>
              <th>מסגרת</th>
              <th>פעיל</th>
              <th>נוצר</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="font-medium">{p.full_name}</div>
                  <div className="text-xs text-slate-500">{p.id.slice(0, 8)}...</div>
                </td>
                <td className="font-mono text-sm" dir="ltr">{p.username ?? '—'}</td>
                <td>
                  <select
                    className="input !py-1"
                    value={p.role}
                    onChange={(e) => update(p.id, { role: e.target.value as Role })}
                  >
                    <option value="admin">מנהל מערכת</option>
                    <option value="raspar">רס"פ</option>
                  </select>
                </td>
                <td>
                  <select
                    className="input !py-1"
                    value={p.unit_id ?? ''}
                    onChange={(e) => update(p.id, { unit_id: e.target.value || null })}
                  >
                    <option value="">— ללא —</option>
                    {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </td>
                <td>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={p.active}
                      onChange={(e) => update(p.id, { active: e.target.checked })}
                    />
                  </label>
                </td>
                <td className="text-xs text-slate-500">{new Date(p.created_at).toLocaleDateString('he-IL')}</td>
                <td>
                  <button
                    onClick={() => handleDelete(p)}
                    disabled={p.id === me?.id}
                    title={p.id === me?.id ? 'לא ניתן למחוק את עצמך' : 'מחק משתמש'}
                    className="text-sm text-red-600 hover:text-red-800 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    מחק
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
