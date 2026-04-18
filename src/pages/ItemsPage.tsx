import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { logAudit } from '../lib/audit';
import { getItemHolders, getItemUsageCount, type ItemHolder } from '../lib/itemHolders';
import type { Item } from '../lib/database.types';

type BlockReason = 'holders' | 'history';
interface BlockModal {
  item: Item;
  intent: 'deactivate' | 'delete';
  reason: BlockReason;
  holders: ItemHolder[];
}

export default function ItemsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [form, setForm] = useState({ name: '', description: '' });
  const [block, setBlock] = useState<BlockModal | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from('items').select('*').order('name');
    if (data) setItems(data);
  }
  useEffect(() => { load(); }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const { data, error } = await supabase.from('items').insert({
      name: form.name,
      description: form.description || null,
    }).select().single();
    if (error) return alert(error.message);
    await logAudit({ action: 'item.create', targetType: 'item', targetId: data.id, details: { name: form.name } });
    setForm({ name: '', description: '' });
    load();
  }

  async function tryDeactivate(item: Item) {
    setBusyId(item.id);
    try {
      // If we are activating (currently inactive), just do it.
      if (!item.active) {
        const { error } = await supabase.from('items').update({ active: true }).eq('id', item.id);
        if (error) return alert(error.message);
        await logAudit({ action: 'item.activate', targetType: 'item', targetId: item.id });
        return load();
      }
      // Deactivating: block if linked to any soldier.
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
        // Has historic signing_items → cannot hard-delete (FK + audit). Suggest deactivate.
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

  return (
    <div className="max-w-4xl">
      <h2 className="text-2xl font-bold mb-6">ניהול פריטים</h2>

      <form onSubmit={handleAdd} className="card mb-6 grid grid-cols-3 gap-3">
        <div>
          <label className="label">שם פריט</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div className="col-span-2">
          <label className="label">תיאור (אופציונלי)</label>
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="col-span-3 flex justify-end">
          <button type="submit" className="btn-primary">+ הוסף פריט</button>
        </div>
      </form>

      <div className="card">
        <table className="table-base">
          <thead>
            <tr>
              <th>שם</th>
              <th>תיאור</th>
              <th>סטטוס</th>
              <th className="w-48"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td className="font-medium">{it.name}</td>
                <td>{it.description ?? '—'}</td>
                <td>
                  <span className={`badge ${it.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                    {it.active ? 'פעיל' : 'מושבת'}
                  </span>
                </td>
                <td>
                  <div className="flex items-center gap-3">
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
            ))}
          </tbody>
        </table>
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
    </div>
  );
}
