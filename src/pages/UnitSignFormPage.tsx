import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { logAudit } from '../lib/audit';
import { loadUnitHeldForReturn } from '../lib/unitStock';
import { loadBattalionSerials } from '../lib/itemSerials';
import type { Item, Unit, UnitSigningType } from '../lib/database.types';

// For bulk items (no registered serials), `quantity` is user-entered and
// `selectedSerials` stays empty. For serialized items, `selectedSerials` drives
// the allocation and `quantity` is derived = selectedSerials.length.
type LineItem = { itemId: string; quantity: number; selectedSerials: string[] };
type ReturnSelection = { key: string; itemId: string; serialNumber: string | null; quantity: number };

const EMPTY_LINE: LineItem = { itemId: '', quantity: 1, selectedSerials: [] };

export default function UnitSignFormPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [units, setUnits] = useState<Unit[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const [type, setType] = useState<UnitSigningType>('signing');
  const [unitId, setUnitId] = useState<string>('');
  const [lines, setLines] = useState<LineItem[]>([{ ...EMPTY_LINE }]);
  // itemId → serials available at the battalion (registered, not currently at any unit).
  const [battalionSerials, setBattalionSerials] = useState<Record<string, Array<{ serialId: string; serialNumber: string }>>>({});
  const [held, setHeld] = useState<Array<{ itemId: string; itemName: string; serialNumber: string | null; quantity: number }>>([]);
  const [returnChecks, setReturnChecks] = useState<Record<string, ReturnSelection>>({});
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  // Per-line serial search filter (keyed by line index).
  const [serialFilter, setSerialFilter] = useState<Record<number, string>>({});

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

  async function ensureBattalionSerialsLoaded(itemId: string) {
    if (!itemId || battalionSerials[itemId]) return;
    try {
      const rows = await loadBattalionSerials(itemId);
      setBattalionSerials((prev) => ({ ...prev, [itemId]: rows }));
    } catch (e) {
      setFeedback({ type: 'error', msg: (e as Error).message });
    }
  }

  async function refreshAllBattalionSerials() {
    // After a successful save, any cached serials are stale for items we touched.
    const touched = Array.from(new Set(lines.map((l) => l.itemId).filter(Boolean)));
    const entries = await Promise.all(touched.map(async (id) => [id, await loadBattalionSerials(id)] as const));
    setBattalionSerials((prev) => {
      const next = { ...prev };
      for (const [id, rows] of entries) next[id] = rows;
      return next;
    });
  }

  function updateLine(idx: number, patch: Partial<LineItem>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() { setLines((prev) => [...prev, { ...EMPTY_LINE }]); }
  function removeLine(idx: number) { setLines((prev) => prev.filter((_, i) => i !== idx)); }

  function toggleLineSerial(idx: number, serial: string) {
    setLines((prev) => prev.map((l, i) => {
      if (i !== idx) return l;
      const has = l.selectedSerials.includes(serial);
      const next = has
        ? l.selectedSerials.filter((s) => s !== serial)
        : [...l.selectedSerials, serial];
      return { ...l, selectedSerials: next, quantity: Math.max(1, next.length) };
    }));
  }

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
      const valid = lines.filter((l) => {
        if (!l.itemId) return false;
        // Serialized lines must have at least one serial picked.
        if (l.selectedSerials.length > 0) return true;
        // Bulk lines need quantity > 0. But if this item HAS registered serials,
        // we force the user to pick them (no "bulk" fallback).
        const hasRegistered = (battalionSerials[l.itemId] ?? []).length > 0;
        if (hasRegistered) return false; // user picked 0 — skip silently; caught below
        return l.quantity > 0;
      });
      if (valid.length === 0) return setFeedback({ type: 'error', msg: 'הוסף לפחות פריט אחד' });

      // For lines where the item has serials registered but user didn't pick any → block
      for (const l of lines) {
        if (!l.itemId) continue;
        const hasRegistered = (battalionSerials[l.itemId] ?? []).length > 0;
        if (hasRegistered && l.selectedSerials.length === 0) {
          const name = items.find((i) => i.id === l.itemId)?.name ?? 'פריט';
          return setFeedback({ type: 'error', msg: `בחר צ׳ אחד או יותר עבור "${name}"` });
        }
      }

      // Prevent the same serial being selected in two different lines for the same item.
      const seen = new Map<string, number>();
      for (const l of valid) {
        for (const s of l.selectedSerials) {
          const key = `${l.itemId}::${s}`;
          if (seen.has(key)) return setFeedback({ type: 'error', msg: 'בחרת את אותו צ׳ יותר מפעם אחת' });
          seen.set(key, 1);
        }
      }

      // Expand: each selected serial becomes its own row (qty=1). Bulk lines stay as one row.
      inserts = valid.flatMap((l): Array<{ item_id: string; quantity: number; serial_number: string | null }> => {
        if (l.selectedSerials.length > 0) {
          return l.selectedSerials.map((s) => ({
            item_id: l.itemId,
            quantity: 1,
            serial_number: s,
          }));
        }
        return [{ item_id: l.itemId, quantity: l.quantity, serial_number: null }];
      });
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

      setFeedback({ type: 'success', msg: `נשמר בהצלחה (${inserts.length} פריטים)` });
      // serials just got allocated/returned — refresh the cache before resetting the form
      await refreshAllBattalionSerials().catch(() => {});
      setLines([{ ...EMPTY_LINE }]);
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
            <div className="space-y-3">
              {lines.map((line, idx) => {
                const serials = line.itemId ? (battalionSerials[line.itemId] ?? []) : [];
                const hasRegistered = serials.length > 0;
                // Serials picked in OTHER lines for the same item — hide from this checklist.
                const takenElsewhere = new Set(
                  lines
                    .filter((_, i) => i !== idx)
                    .filter((l) => l.itemId === line.itemId)
                    .flatMap((l) => l.selectedSerials),
                );
                const visibleSerials = serials.filter((s) => !takenElsewhere.has(s.serialNumber));
                const selectedCount = line.selectedSerials.length;
                const filterText = (serialFilter[idx] ?? '').trim().toLowerCase();
                const matchedSerials = filterText
                  ? visibleSerials.filter((s) => s.serialNumber.toLowerCase().includes(filterText))
                  : visibleSerials;

                return (
                  <div key={idx} className="border border-slate-200 rounded-lg p-3 space-y-3">
                    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                      <select
                        className="input flex-1"
                        value={line.itemId}
                        onChange={(e) => {
                          const v = e.target.value;
                          updateLine(idx, { itemId: v, selectedSerials: [], quantity: 1 });
                          ensureBattalionSerialsLoaded(v);
                        }}
                      >
                        <option value="">— בחר פריט —</option>
                        {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                      </select>

                      {/* Bulk-only quantity input (items without registered serials). */}
                      {line.itemId && !hasRegistered && (
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-slate-500 whitespace-nowrap">כמות</label>
                          <input
                            type="number"
                            min={1}
                            className="input w-24"
                            value={line.quantity}
                            onChange={(e) => updateLine(idx, { quantity: parseInt(e.target.value) || 1 })}
                          />
                        </div>
                      )}

                      {lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          className="btn-ghost text-red-600 !px-3"
                          aria-label="הסר שורה"
                        >
                          ×
                        </button>
                      )}
                    </div>

                    {/* Serials checklist — only for serialized items. */}
                    {line.itemId && hasRegistered && (
                      <div>
                        <div className="flex items-center justify-between mb-2 text-xs">
                          <span className="text-slate-600">
                            סמן צ׳ים (נבחרו <span className="font-semibold">{selectedCount}</span> מתוך {visibleSerials.length})
                            {filterText && visibleSerials.length !== matchedSerials.length && (
                              <span className="text-slate-400"> · מוצגים {matchedSerials.length}</span>
                            )}
                          </span>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="text-sky-700 hover:text-sky-900"
                              onClick={() => {
                                const toSelect = matchedSerials.map((s) => s.serialNumber);
                                const next = Array.from(new Set([...line.selectedSerials, ...toSelect]));
                                updateLine(idx, {
                                  selectedSerials: next,
                                  quantity: Math.max(1, next.length),
                                });
                              }}
                              disabled={matchedSerials.length === 0}
                            >
                              {filterText ? 'בחר מסוננים' : 'בחר הכל'}
                            </button>
                            {selectedCount > 0 && (
                              <button
                                type="button"
                                className="text-slate-500 hover:text-slate-700"
                                onClick={() => updateLine(idx, { selectedSerials: [], quantity: 1 })}
                              >
                                נקה
                              </button>
                            )}
                          </div>
                        </div>
                        {visibleSerials.length > 8 && (
                          <input
                            type="text"
                            className="input !py-1.5 text-sm mb-2 font-mono"
                            dir="ltr"
                            placeholder="חפש צ׳..."
                            value={serialFilter[idx] ?? ''}
                            onChange={(e) => setSerialFilter((prev) => ({ ...prev, [idx]: e.target.value }))}
                          />
                        )}
                        {visibleSerials.length === 0 ? (
                          <div className="text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
                            אין צ׳ים זמינים בגדוד לפריט זה
                          </div>
                        ) : matchedSerials.length === 0 ? (
                          <div className="text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
                            אין צ׳ים שתואמים את החיפוש
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 max-h-56 overflow-auto border border-slate-200 rounded-lg p-2 bg-slate-50">
                            {matchedSerials.map((s) => {
                              const checked = line.selectedSerials.includes(s.serialNumber);
                              return (
                                <label
                                  key={s.serialId}
                                  className={`flex items-center gap-2 text-sm rounded-md px-2 py-1 cursor-pointer ${
                                    checked ? 'bg-emerald-100 text-emerald-900' : 'bg-white hover:bg-slate-100'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleLineSerial(idx, s.serialNumber)}
                                  />
                                  <span className="font-mono text-xs" dir="ltr">{s.serialNumber}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
