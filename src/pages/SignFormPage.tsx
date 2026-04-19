import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { loadSoldierHeldItems, type HeldItem } from '../lib/heldItems';
import type { Item, SigningType, Soldier, Team, Unit } from '../lib/database.types';

type LineItem = { itemId: string; quantity: number; serialNumber: string };
type ReturnSelection = { key: string; itemId: string; serialNumber: string | null; quantity: number };

export default function SignFormPage() {
  const { profile } = useAuth();
  const [units, setUnits] = useState<Unit[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [soldiers, setSoldiers] = useState<Soldier[]>([]);

  const [signingType, setSigningType] = useState<SigningType>('signing');
  const [unitId, setUnitId] = useState<string>('');
  const [teamId, setTeamId] = useState<string>('');
  const [soldierId, setSoldierId] = useState<string>('');
  const [newSoldier, setNewSoldier] = useState({ full_name: '', personal_number: '', phone: '' });
  const [useExisting, setUseExisting] = useState(true);
  const [lines, setLines] = useState<LineItem[]>([{ itemId: '', quantity: 1, serialNumber: '' }]);
  const [heldItems, setHeldItems] = useState<HeldItem[]>([]);
  const [returnChecks, setReturnChecks] = useState<Record<string, ReturnSelection>>({});
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'warning'; msg: string } | null>(null);

  const isAdmin = profile?.role === 'admin';
  const isReturn = signingType === 'return';

  useEffect(() => {
    (async () => {
      const [u, t, i, s] = await Promise.all([
        supabase.from('units').select('*').order('name'),
        supabase.from('teams').select('*').order('name'),
        supabase.from('items').select('*').eq('active', true).order('name'),
        supabase.from('soldiers').select('*').order('full_name'),
      ]);
      if (u.data) setUnits(u.data);
      if (t.data) setTeams(t.data);
      if (i.data) setItems(i.data);
      if (s.data) setSoldiers(s.data);
      if (!isAdmin && profile?.unit_id) setUnitId(profile.unit_id);
    })();
  }, [isAdmin, profile?.unit_id]);

  // Returns must use existing soldier — flip automatically.
  useEffect(() => {
    if (isReturn) setUseExisting(true);
  }, [isReturn]);

  // When an existing soldier is picked, mirror their unit/team into the form.
  useEffect(() => {
    if (!useExisting || !soldierId) return;
    const s = soldiers.find((x) => x.id === soldierId);
    if (!s) return;
    if (s.unit_id && s.unit_id !== unitId) setUnitId(s.unit_id);
    setTeamId(s.team_id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soldierId, soldiers, useExisting]);

  // Load currently-held items whenever an existing soldier is picked.
  useEffect(() => {
    if (!useExisting || !soldierId) {
      setHeldItems([]);
      setReturnChecks({});
      return;
    }
    loadSoldierHeldItems(soldierId)
      .then((held) => {
        setHeldItems(held);
        // pre-build the return form state with all unchecked, full quantity available
        const checks: Record<string, ReturnSelection> = {};
        for (const h of held) {
          const key = `${h.itemId}::${h.serialNumber ?? ''}`;
          checks[key] = { key, itemId: h.itemId, serialNumber: h.serialNumber, quantity: 0 };
        }
        setReturnChecks(checks);
      })
      .catch((e) => setFeedback({ type: 'error', msg: e.message }));
  }, [soldierId, useExisting]);

  const teamsForUnit = useMemo(
    () => teams.filter((t) => t.unit_id === unitId),
    [teams, unitId]
  );

  const filteredSoldiers = useMemo(
    () => {
      let list = unitId ? soldiers.filter((s) => s.unit_id === unitId) : soldiers;
      if (teamId) list = list.filter((s) => s.team_id === teamId);
      return list;
    },
    [soldiers, unitId, teamId]
  );

  function updateLine(idx: number, patch: Partial<LineItem>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() { setLines((prev) => [...prev, { itemId: '', quantity: 1, serialNumber: '' }]); }
  function removeLine(idx: number) { setLines((prev) => prev.filter((_, i) => i !== idx)); }

  function toggleReturnCheck(key: string, max: number) {
    setReturnChecks((prev) => {
      const cur = prev[key];
      const newQty = cur.quantity > 0 ? 0 : max;
      return { ...prev, [key]: { ...cur, quantity: newQty } };
    });
  }
  function updateReturnQty(key: string, qty: number, max: number) {
    setReturnChecks((prev) => ({
      ...prev,
      [key]: { ...prev[key], quantity: Math.max(0, Math.min(max, qty)) },
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (!profile) return;
    if (!unitId) return setFeedback({ type: 'error', msg: 'בחר מסגרת' });
    if (teamsForUnit.length > 0 && !teamId) return setFeedback({ type: 'error', msg: 'בחר צוות' });
    if (!useExisting) {
      if (!newSoldier.full_name) return setFeedback({ type: 'error', msg: 'הזן שם חייל' });
      if (!/^\d{7}$/.test(newSoldier.personal_number)) {
        return setFeedback({ type: 'error', msg: 'מספר אישי חייב להיות 7 ספרות בדיוק' });
      }
      if (!/^05\d{8}$/.test(newSoldier.phone)) {
        return setFeedback({ type: 'error', msg: 'טלפון חייב להיות מספר סלולרי ישראלי תקין (05XXXXXXXX)' });
      }
    }
    if (useExisting && !soldierId) return setFeedback({ type: 'error', msg: 'בחר חייל קיים' });

    let inserts: Array<{ item_id: string; quantity: number; serial_number: string | null }> = [];
    if (isReturn) {
      inserts = Object.values(returnChecks)
        .filter((r) => r.quantity > 0)
        .map((r) => ({ item_id: r.itemId, quantity: r.quantity, serial_number: r.serialNumber }));
      if (inserts.length === 0) return setFeedback({ type: 'error', msg: 'סמן לפחות פריט אחד לזיכוי' });
    } else {
      const valid = lines.filter((l) => l.itemId && l.quantity > 0);
      if (valid.length === 0) return setFeedback({ type: 'error', msg: 'הוסף לפחות פריט אחד' });
      inserts = valid.map((l) => ({
        item_id: l.itemId,
        quantity: l.quantity,
        serial_number: l.serialNumber.trim() || null,
      }));
    }

    setSubmitting(true);
    try {
      let finalSoldierId = soldierId;
      if (!useExisting) {
        const { data: created, error: solErr } = await supabase
          .from('soldiers')
          .insert({
            full_name: newSoldier.full_name,
            personal_number: newSoldier.personal_number,
            phone: newSoldier.phone,
            unit_id: unitId,
            team_id: teamId || null,
          })
          .select()
          .single();
        if (solErr) throw solErr;
        finalSoldierId = created.id;
      }

      const { data: signing, error: sigErr } = await supabase
        .from('signings')
        .insert({
          soldier_id: finalSoldierId,
          performed_by: profile.id,
          unit_id: unitId,
          team_id: teamId || null,
          type: signingType,
          notes: notes || null,
        })
        .select()
        .single();
      if (sigErr) throw sigErr;

      const action = signingType === 'signing' ? 'issued' : signingType === 'return' ? 'returned' : 'inspected';
      const { error: itemsErr } = await supabase.from('signing_items').insert(
        inserts.map((i) => ({ ...i, signing_id: signing.id, action }))
      );
      if (itemsErr) throw itemsErr;

      await logAudit({
        action: `signing.${signingType}`,
        targetType: 'signing',
        targetId: signing.id,
        details: { soldier_id: finalSoldierId, items: inserts.length },
      });

      // Generate PDF + upload to Drive (best-effort; signing is already saved).
      let pdfWarning: string | null = null;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-signing-pdf`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session?.access_token ?? ''}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ signing_id: signing.id }),
        });
        if (!res.ok) {
          const t = await res.text();
          pdfWarning = `[${res.status}] ${t}`;
        }
      } catch (e) {
        pdfWarning = (e as Error).message;
      }

      setFeedback(
        pdfWarning
          ? { type: 'warning', msg: `נשמר בהצלחה. ⚠ העלאת PDF נכשלה: ${pdfWarning}` }
          : { type: 'success', msg: 'נשמר בהצלחה — PDF נוצר' },
      );
      setLines([{ itemId: '', quantity: 1, serialNumber: '' }]);
      setNotes('');
      setNewSoldier({ full_name: '', personal_number: '', phone: '' });
      // refresh held items so the panel reflects the new state
      if (useExisting && soldierId) {
        const held = await loadSoldierHeldItems(soldierId);
        setHeldItems(held);
        const checks: Record<string, ReturnSelection> = {};
        for (const h of held) {
          const key = `${h.itemId}::${h.serialNumber ?? ''}`;
          checks[key] = { key, itemId: h.itemId, serialNumber: h.serialNumber, quantity: 0 };
        }
        setReturnChecks(checks);
      }
    } catch (err) {
      setFeedback({ type: 'error', msg: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold mb-6">החתמה חדשה</h2>
      <form onSubmit={handleSubmit} className="card space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">סוג פעולה</label>
            <select className="input" value={signingType} onChange={(e) => setSigningType(e.target.value as SigningType)}>
              <option value="signing">החתמה (נפק)</option>
              <option value="return">זיכוי (החזר)</option>
              <option value="inspection">בדיקה</option>
            </select>
          </div>
          <div>
            <label className="label">מסגרת *</label>
            <select
              className="input"
              value={unitId}
              onChange={(e) => { setUnitId(e.target.value); setTeamId(''); setSoldierId(''); }}
              disabled={!isAdmin}
              required
            >
              <option value="">— בחר מסגרת —</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>

        {teamsForUnit.length > 0 && (
          <div>
            <label className="label">צוות *</label>
            <select
              className="input"
              value={teamId}
              onChange={(e) => { setTeamId(e.target.value); setSoldierId(''); }}
              required
            >
              <option value="">— בחר צוות —</option>
              {teamsForUnit.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <div className="flex gap-4 mb-3">
            <label className={`flex items-center gap-2 text-sm ${isReturn ? 'opacity-50' : 'cursor-pointer'}`}>
              <input type="radio" checked={useExisting} onChange={() => setUseExisting(true)} />
              חייל קיים
            </label>
            <label className={`flex items-center gap-2 text-sm ${isReturn ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
              <input type="radio" checked={!useExisting} disabled={isReturn} onChange={() => setUseExisting(false)} />
              חייל חדש {isReturn && <span className="text-xs text-slate-500">(לא זמין בזיכוי)</span>}
            </label>
          </div>
          {useExisting ? (
            <select className="input" value={soldierId} onChange={(e) => setSoldierId(e.target.value)}>
              <option value="">— בחר חייל —</option>
              {filteredSoldiers.map((s) => (
                <option key={s.id} value={s.id}>{s.full_name} ({s.personal_number})</option>
              ))}
            </select>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">שם מלא *</label>
                <input className="input" value={newSoldier.full_name} onChange={(e) => setNewSoldier({ ...newSoldier, full_name: e.target.value })} required />
              </div>
              <div>
                <label className="label">מספר אישי *</label>
                <input
                  className="input"
                  inputMode="numeric"
                  pattern="\d{7}"
                  title="7 ספרות בדיוק"
                  maxLength={7}
                  value={newSoldier.personal_number}
                  onChange={(e) => setNewSoldier({ ...newSoldier, personal_number: e.target.value.replace(/\D/g, '') })}
                  required
                />
              </div>
              <div>
                <label className="label">טלפון *</label>
                <input
                  className="input"
                  inputMode="tel"
                  pattern="05\d{8}"
                  title="מספר סלולרי ישראלי: 05XXXXXXXX"
                  maxLength={10}
                  placeholder="05XXXXXXXX"
                  value={newSoldier.phone}
                  onChange={(e) => setNewSoldier({ ...newSoldier, phone: e.target.value.replace(/\D/g, '') })}
                  required
                />
              </div>
            </div>
          )}
        </div>

        {/* Currently-held items panel — shown for any existing-soldier flow */}
        {useExisting && soldierId && !isReturn && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-sm font-semibold text-slate-700 mb-2">פריטים שכבר חתומים על החייל</div>
            {heldItems.length === 0 ? (
              <div className="text-sm text-slate-500">אין פריטים חתומים</div>
            ) : (
              <ul className="text-sm space-y-1">
                {heldItems.map((h) => (
                  <li key={`${h.itemId}::${h.serialNumber ?? ''}`} className="flex justify-between">
                    <span>{h.itemName}{h.serialNumber ? ` — צ' ${h.serialNumber}` : ''}</span>
                    <span className="text-slate-600">x{h.quantity}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* RETURN flow: checkbox list of held items */}
        {isReturn ? (
          <div>
            <label className="label">פריטים לזיכוי</label>
            {!soldierId ? (
              <div className="text-sm text-slate-500">בחר חייל כדי לראות את הפריטים שלו</div>
            ) : heldItems.length === 0 ? (
              <div className="text-sm text-slate-500">לחייל הזה אין פריטים חתומים</div>
            ) : (
              <div className="space-y-2">
                {heldItems.map((h) => {
                  const key = `${h.itemId}::${h.serialNumber ?? ''}`;
                  const sel = returnChecks[key];
                  const checked = (sel?.quantity ?? 0) > 0;
                  return (
                    <div key={key} className="flex items-center gap-3 rounded-lg border border-slate-200 p-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleReturnCheck(key, h.quantity)}
                      />
                      <div className="flex-1">
                        <div className="text-sm">{h.itemName}</div>
                        {h.serialNumber && <div className="text-xs text-slate-500">צ' {h.serialNumber}</div>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>כמות:</span>
                        <input
                          type="number"
                          min={0}
                          max={h.quantity}
                          disabled={!checked}
                          className="input w-20 !py-1"
                          value={sel?.quantity ?? 0}
                          onChange={(e) => updateReturnQty(key, parseInt(e.target.value) || 0, h.quantity)}
                        />
                        <span>/ {h.quantity}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label !mb-0">פריטים</label>
              <button type="button" onClick={addLine} className="btn-secondary !py-1 !px-3 text-xs">+ הוסף פריט</button>
            </div>
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-start border sm:border-0 border-slate-200 rounded-lg p-2 sm:p-0">
                  <select
                    className="input flex-1"
                    value={line.itemId}
                    onChange={(e) => updateLine(idx, { itemId: e.target.value })}
                  >
                    <option value="">— בחר פריט —</option>
                    {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="צ' (מס׳ פריט)"
                      className="input flex-1 sm:w-36 sm:flex-none"
                      value={line.serialNumber}
                      onChange={(e) => updateLine(idx, { serialNumber: e.target.value })}
                    />
                    <input
                      type="number"
                      min={1}
                      className="input w-20"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, { quantity: parseInt(e.target.value) || 1 })}
                    />
                    {lines.length > 1 && (
                      <button type="button" onClick={() => removeLine(idx)} className="btn-ghost text-red-600 !px-3">×</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="label">הערות</label>
          <textarea className="input min-h-[80px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {feedback && (
          <div className={`rounded-lg px-3 py-2 text-sm ${
            feedback.type === 'success'
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : feedback.type === 'warning'
                ? 'bg-amber-50 text-amber-800 border border-amber-200'
                : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {feedback.msg}
          </div>
        )}

        <div className="flex justify-end">
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'שומר...' : isReturn ? 'שמור זיכוי' : 'שמור החתמה'}
          </button>
        </div>
      </form>
    </div>
  );
}
