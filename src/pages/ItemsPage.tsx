import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { logAudit } from '../lib/audit';
import { getItemHolders, getItemUsageCount, type ItemHolder } from '../lib/itemHolders';
import {
  addItemSerials,
  loadItemSerialStatus,
  parseSerialBlob,
  removeItemSerial,
  type SerialLocation,
} from '../lib/itemSerials';
import type { Item, Unit } from '../lib/database.types';

type BlockReason = 'holders' | 'history';
interface BlockModal {
  item: Item;
  intent: 'deactivate' | 'delete';
  reason: BlockReason;
  holders: ItemHolder[];
}

interface SerialsModal {
  item: Item;
  rows: SerialLocation[];
  addText: string;
  busy: boolean;
  error: string | null;
}

export default function ItemsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [counts, setCounts] = useState<Record<string, { total: number; atBattalion: number }>>({});
  const [form, setForm] = useState({ name: '', description: '', serials: '' });
  const [block, setBlock] = useState<BlockModal | null>(null);
  const [serialsModal, setSerialsModal] = useState<SerialsModal | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const [it, un, ser] = await Promise.all([
      supabase.from('items').select('*').order('name'),
      supabase.from('units').select('*').order('name'),
      supabase.from('item_serial_status').select('item_id, current_unit_id'),
    ]);
    if (it.data) setItems(it.data);
    if (un.data) setUnits(un.data);
    const cnt: Record<string, { total: number; atBattalion: number }> = {};
    for (const row of (ser.data ?? []) as Array<{ item_id: string; current_unit_id: string | null }>) {
      const c = cnt[row.item_id] ?? { total: 0, atBattalion: 0 };
      c.total += 1;
      if (row.current_unit_id === null) c.atBattalion += 1;
      cnt[row.item_id] = c;
    }
    setCounts(cnt);
  }
  useEffect(() => { load(); }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    const serials = parseSerialBlob(form.serials);

    // Pre-check: does a pre-existing item share this name?
    const { data: existing } = await supabase
      .from('items')
      .select('id, name, active')
      .ilike('name', name)
      .maybeSingle();

    if (existing) {
      if (serials.length === 0) {
        alert(`פריט בשם "${existing.name}" כבר קיים. לניהול הצ'ים לחץ "נהל צ'ים" בשורה שלו.`);
        return;
      }
      const ok = confirm(
        `פריט בשם "${existing.name}" כבר קיים.\nלהוסיף ${serials.length} צ'ים לפריט הקיים?`,
      );
      if (!ok) return;
      try {
        const added = await addItemSerials(existing.id, serials);
        await logAudit({
          action: 'item.serials_add',
          targetType: 'item',
          targetId: existing.id,
          details: { count: added, attempted: serials.length, via: 'add-form-duplicate' },
        });
        alert(`נוספו ${added} צ'ים חדשים (${serials.length - added} כבר היו קיימים).`);
      } catch (e) {
        alert(`הוספת הצ'ים נכשלה: ${(e as Error).message}`);
        return;
      }
      setForm({ name: '', description: '', serials: '' });
      load();
      return;
    }

    const { data, error } = await supabase.from('items').insert({
      name,
      description: form.description || null,
    }).select().single();
    if (error) {
      // Race: someone else created the same name between the check and the insert,
      // or our ilike missed it (unlikely). Surface a clean Hebrew message.
      if ((error as { code?: string }).code === '23505') {
        alert(`פריט בשם "${name}" כבר קיים.`);
      } else {
        alert(error.message);
      }
      return;
    }
    await logAudit({ action: 'item.create', targetType: 'item', targetId: data.id, details: { name } });

    if (serials.length > 0) {
      try {
        const added = await addItemSerials(data.id, serials);
        if (added > 0) {
          await logAudit({
            action: 'item.serials_add',
            targetType: 'item',
            targetId: data.id,
            details: { count: added },
          });
        }
      } catch (e) {
        alert(`פריט נוצר אך הוספת הצ'ים נכשלה: ${(e as Error).message}`);
      }
    }
    setForm({ name: '', description: '', serials: '' });
    load();
  }

  async function tryDeactivate(item: Item) {
    setBusyId(item.id);
    try {
      if (!item.active) {
        const { error } = await supabase.from('items').update({ active: true }).eq('id', item.id);
        if (error) return alert(error.message);
        await logAudit({ action: 'item.activate', targetType: 'item', targetId: item.id });
        return load();
      }
      const holders = await getItemHolders(item.id);
      if (holders.length > 0) {
        setBlock({ item, intent: 'deactivate', reason: 'holders', holders });
        return;
      }
      const { error } = await supabase.from('items').update({ active: false }).eq('id', item.id);
      if (error) return alert(error.message);
      await logAudit({ action: 'item.deactivate', targetType: 'item', targetId: item.id });
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function tryDelete(item: Item) {
    setBusyId(item.id);
    try {
      const holders = await getItemHolders(item.id);
      if (holders.length > 0) {
        setBlock({ item, intent: 'delete', reason: 'holders', holders });
        return;
      }
      const usage = await getItemUsageCount(item.id);
      if (usage > 0) {
        setBlock({ item, intent: 'delete', reason: 'history', holders: [] });
        return;
      }
      if (!confirm(`למחוק את "${item.name}" לצמיתות?`)) return;
      const { error } = await supabase.from('items').delete().eq('id', item.id);
      if (error) return alert(error.message);
      await logAudit({ action: 'item.delete', targetType: 'item', targetId: item.id, details: { name: item.name } });
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function openSerialsModal(item: Item) {
    try {
      const rows = await loadItemSerialStatus(item.id);
      setSerialsModal({ item, rows, addText: '', busy: false, error: null });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function handleAddSerials() {
    if (!serialsModal) return;
    const parsed = parseSerialBlob(serialsModal.addText);
    if (parsed.length === 0) {
      setSerialsModal({ ...serialsModal, error: 'הזן צ׳ אחד או יותר (שורות / פסיקים / רווחים)' });
      return;
    }
    setSerialsModal({ ...serialsModal, busy: true, error: null });
    try {
      const added = await addItemSerials(serialsModal.item.id, parsed);
      await logAudit({
        action: 'item.serials_add',
        targetType: 'item',
        targetId: serialsModal.item.id,
        details: { count: added, attempted: parsed.length },
      });
      const rows = await loadItemSerialStatus(serialsModal.item.id);
      setSerialsModal({ ...serialsModal, rows, addText: '', busy: false });
      load();
    } catch (e) {
      setSerialsModal({ ...serialsModal, busy: false, error: (e as Error).message });
    }
  }

  async function handleRemoveSerial(row: SerialLocation) {
    if (!serialsModal) return;
    if (row.currentUnitId) {
      alert('לא ניתן למחוק צ׳ שנמצא כרגע אצל מסגרת. יש להחזיר אותו לגדוד קודם.');
      return;
    }
    if (!confirm(`למחוק את הצ׳ ${row.serialNumber}?`)) return;
    try {
      await removeItemSerial(row.serialId);
      await logAudit({
        action: 'item.serial_delete',
        targetType: 'item',
        targetId: serialsModal.item.id,
        details: { serial: row.serialNumber },
      });
      const rows = await loadItemSerialStatus(serialsModal.item.id);
      setSerialsModal({ ...serialsModal, rows });
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const unitName = (id: string | null) => (id ? units.find((u) => u.id === id)?.name ?? '—' : 'גדוד');

  return (
    <div className="max-w-4xl">
      <h2 className="text-2xl font-bold mb-6">ניהול פריטים</h2>

      <form onSubmit={handleAdd} className="card mb-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="label">שם פריט</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div className="sm:col-span-2">
          <label className="label">תיאור (אופציונלי)</label>
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="sm:col-span-3">
          <label className="label">
            צ׳ים להוספה (אופציונלי) — לניהול מלאי
            <span className="text-xs text-slate-500 font-normal mr-2">שורה/פסיק/רווח בין צ׳ים</span>
          </label>
          <textarea
            className="input min-h-[80px] font-mono text-sm"
            dir="ltr"
            placeholder="123456&#10;123457&#10;123458"
            value={form.serials}
            onChange={(e) => setForm({ ...form, serials: e.target.value })}
          />
        </div>
        <div className="sm:col-span-3 flex justify-end">
          <button type="submit" className="btn-primary">+ הוסף פריט</button>
        </div>
      </form>

      <div className="card">
        <div className="table-wrap">
        <table className="table-base">
          <thead>
            <tr>
              <th>שם</th>
              <th>תיאור</th>
              <th>מלאי (בגדוד / סה״כ)</th>
              <th>סטטוס</th>
              <th className="w-64"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const c = counts[it.id] ?? { total: 0, atBattalion: 0 };
              return (
                <tr key={it.id}>
                  <td className="font-medium">{it.name}</td>
                  <td>{it.description ?? '—'}</td>
                  <td className="text-sm">
                    {c.total === 0 ? (
                      <span className="text-slate-400">ללא צ׳ים</span>
                    ) : (
                      <span>
                        <span className="font-semibold">{c.atBattalion}</span>
                        <span className="text-slate-500"> / {c.total}</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${it.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                      {it.active ? 'פעיל' : 'מושבת'}
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => openSerialsModal(it)}
                        className="text-sm text-sky-700 hover:text-sky-900"
                      >
                        נהל צ׳ים
                      </button>
                      <button
                        onClick={() => tryDeactivate(it)}
                        disabled={busyId === it.id}
                        className="text-sm text-slate-600 hover:text-slate-900 disabled:opacity-50"
                      >
                        {it.active ? 'השבת' : 'הפעל'}
                      </button>
                      <button
                        onClick={() => tryDelete(it)}
                        disabled={busyId === it.id}
                        className="text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        מחק
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {block && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setBlock(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-lg font-bold">
                {block.intent === 'delete' ? 'לא ניתן למחוק' : 'לא ניתן להשבית'}
              </h3>
              <button
                onClick={() => setBlock(null)}
                className="text-slate-400 hover:text-slate-700 text-xl leading-none"
              >
                ×
              </button>
            </div>

            {block.reason === 'holders' ? (
              <>
                <p className="text-sm text-slate-700 mb-3">
                  הפריט <span className="font-semibold">"{block.item.name}"</span> חתום כרגע על
                  החיילים הבאים. יש לזכות אותם לפני שניתן {block.intent === 'delete' ? 'למחוק' : 'להשבית'} אותו:
                </p>
                <ul className="text-sm space-y-1 max-h-60 overflow-auto border border-slate-200 rounded-lg p-2">
                  {block.holders.map((h) => (
                    <li key={h.soldierId} className="flex justify-between border-b border-slate-100 py-1.5 last:border-0">
                      <span>
                        {h.soldierName}
                        {h.personalNumber && (
                          <span className="text-slate-500 text-xs"> ({h.personalNumber})</span>
                        )}
                      </span>
                      <span className="text-slate-600">x{h.quantity}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-slate-700">
                לפריט <span className="font-semibold">"{block.item.name}"</span> יש היסטוריית החתמות.
                לא ניתן למחוק אותו לצמיתות כדי לשמור על תקינות הדוחות.
                <br />
                ניתן להשבית את הפריט במקום לכך — הוא לא יופיע בטופס ההחתמה אך יישאר בהיסטוריה.
              </p>
            )}

            <div className="flex justify-end mt-5">
              <button onClick={() => setBlock(null)} className="btn-secondary">
                הבנתי
              </button>
            </div>
          </div>
        </div>
      )}

      {serialsModal && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setSerialsModal(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-2xl w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold">ניהול צ׳ים — {serialsModal.item.name}</h3>
                <p className="text-xs text-slate-500">
                  {serialsModal.rows.length} סה״כ · {serialsModal.rows.filter((r) => !r.currentUnitId).length} בגדוד
                </p>
              </div>
              <button
                onClick={() => setSerialsModal(null)}
                className="text-slate-400 hover:text-slate-700 text-xl leading-none"
              >
                ×
              </button>
            </div>

            <div className="mb-4">
              <label className="label">הוסף צ׳ים חדשים</label>
              <textarea
                className="input min-h-[70px] font-mono text-sm"
                dir="ltr"
                placeholder="123456, 123457&#10;123458"
                value={serialsModal.addText}
                onChange={(e) => setSerialsModal({ ...serialsModal, addText: e.target.value })}
                disabled={serialsModal.busy}
              />
              {serialsModal.error && (
                <div className="text-sm text-red-700 mt-1">{serialsModal.error}</div>
              )}
              <div className="flex justify-end mt-2">
                <button
                  onClick={handleAddSerials}
                  disabled={serialsModal.busy}
                  className="btn-primary !py-1.5 !px-3 text-sm"
                >
                  {serialsModal.busy ? 'מוסיף...' : 'הוסף'}
                </button>
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg max-h-80 overflow-auto">
              {serialsModal.rows.length === 0 ? (
                <div className="text-sm text-slate-500 text-center py-6">אין צ׳ים רשומים עדיין</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-right p-2 font-medium">צ׳</th>
                      <th className="text-right p-2 font-medium">מיקום נוכחי</th>
                      <th className="w-16"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {serialsModal.rows.map((r) => (
                      <tr key={r.serialId} className="border-b border-slate-100 last:border-0">
                        <td className="p-2 font-mono" dir="ltr">{r.serialNumber}</td>
                        <td className="p-2">
                          {r.currentUnitId ? (
                            <span className="text-amber-700">{unitName(r.currentUnitId)}</span>
                          ) : (
                            <span className="text-emerald-700">גדוד</span>
                          )}
                        </td>
                        <td className="p-2 text-right">
                          <button
                            onClick={() => handleRemoveSerial(r)}
                            disabled={!!r.currentUnitId}
                            title={r.currentUnitId ? 'לא ניתן למחוק — הצ׳ אצל מסגרת' : 'מחק'}
                            className="text-xs text-red-600 hover:text-red-800 disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            מחק
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex justify-end mt-5">
              <button onClick={() => setSerialsModal(null)} className="btn-secondary">
                סגור
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
