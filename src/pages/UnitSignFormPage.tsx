import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { loadUnitHeldForReturn } from '../lib/unitStock';
import type { Item, Unit, UnitSigningType } from '../lib/database.types';

type LineItem = { itemId: string; quantity: number; serialNumber: string };
type ReturnSelection = { key: string; itemId: string; serialNumber: string | null; quantity: number };

export default function UnitSignFormPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [units, setUnits] = useState<Unit[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [type, setType] = useState<UnitSigningType>('signing');
  const [unitId, setUnitId] = useState<string>('');
  const [lines, setLines] = useState<LineItem[]>([{ itemId: '', quantity: 1, serialNumber: '' }]);
  const [held, setHeld] = useState<Array<{ itemId: string; itemName: string; serialNumber: string | null; quantity: number }>>([]);
  const [returnChecks, setReturnChecks] = useState<Record<string, ReturnSelection>>({});
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    (async () => {
      const [u, i] = await Promise.all([
        supabase.from('units').select('*').order('name'),
        supabase.from('items').select('*').eq('active', true).order('name'),
      ]);
      if (u.data) setUnits(u.data);
      if (i.data) setItems(i.data);
    })();
  }, []);

  // Load held-by-unit when switching to return mode or changing unit.
  useEffect(() => {
    if (type !== 'return' || !unitId) {
      setHeld([]);
      setReturnChecks({});
      return;
    }
    loadUnitHeldForReturn(unitId)
      .then((rows) => {
        setHeld(rows);
        const checks: Record<string, ReturnSelection> = {};
        for (const h of rows) {
          const key = `${h.itemId}::${h.serialNumber ?? ''}`;
          checks[key] = { key, itemId: h.itemId, serialNumber: h.serialNumber, quantity: 0 };
        }
        setReturnChecks(checks);
      })
      .catch((e) => setFeedback({ type: 'error', msg: e.message }));
  }, [type, unitId]);

  const isReturn = type === 'return';

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

  const availableUnits = useMemo(() => units, [units]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (!profile) return;
    if (!unitId) return setFeedback({ type: 'error', msg: 'בחר מסגרת' });

    let inserts: Array<{ item_id: string; quantity: number; serial_number: string | null }> = [];
    if (isReturn) {
      inserts = Object.values(returnChecks)
        .filter((r) => r.quantity > 0)
        .map((r) => ({ item_id: r.itemId, quantity: r.quantity, serial_number: r.serialNumber }));
      if (inserts.length === 0) return setFeedback({ type: 'error', msg: 'סמן לפחות פריט אחד להחזרה' });
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
      const { data: us, error: usErr } = await supabase
        .from('unit_signings')
        .insert({
          unit_id: unitId,
          performed_by: profile.id,
          type,
          notes: notes || null,
        })
        .select()
        .single();
      if (usErr) throw usErr;

      const action: 'issued' | 'returned' = type === 'signing' ? 'issued' : 'returned';
      const { error: itemsErr } = await supabase.from('unit_signing_items').insert(
        inserts.map((i) => ({ ...i, unit_signing_id: us.id, action })),
      );
      if (itemsErr) throw itemsErr;

      await logAudit({
        action: `unit_signing.${type}`,
        targetType: 'unit_signing',
        targetId: us.id,
        details: { unit_id: unitId, items: inserts.length },
      });

      setFeedback({ type: 'success', msg: 'נשמר בהצלחה' });
      setLines([{ itemId: '', quantity: 1, serialNumber: '' }]);
      setNotes('');
      if (isReturn) {
        // Refresh held list after a return.
        const rows = await loadUnitHeldForReturn(unitId);
        setHeld(rows);
        const checks: Record<string, ReturnSelection> = {};
        for (const h of rows) {
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

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold mb-2">החתמת מסגרת</h2>
      <p className="text-sm text-slate-500 mb-6">
        הקצאת ערכות מהגדוד למסגרת (או החזרת ציוד מהמסגרת לגדוד). זמין למנהל מערכת בלבד.
      </p>

      <form onSubmit={handleSubmit} className="card space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">סוג פעולה</label>
            <select className="input" value={type} onChange={(e) => setType(e.target.value as UnitSigningType)}>
              <option value="signing">הקצאה למסגרת</option>
              <option value="return">החזרה לגדוד</option>
            </select>
          </div>
          <div>
            <label className="label">מסגרת *</label>
            <select
              className="input"
              value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
              required
            >
              <option value="">— בחר מסגרת —</option>
              {availableUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>

        {isReturn ? (
          <div>
            <label className="label">פריטים להחזרה לגדוד</label>
            {!unitId ? (
              <div className="text-sm text-slate-500">בחר מסגרת כדי לראות את המלאי שלה</div>
            ) : held.length === 0 ? (
              <div className="text-sm text-slate-500">אין מלאי שניתן להחזיר</div>
            ) : (
              <div className="space-y-2">
                {held.map((h) => {
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
              <label className="label !mb-0">פריטים להקצאה</label>
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
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {feedback.msg}
          </div>
        )}

        <div className="flex justify-end">
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'שומר...' : isReturn ? 'שמור החזרה' : 'שמור הקצאה'}
          </button>
        </div>
      </form>
    </div>
  );
}
