import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { logAudit } from '../lib/audit';

export default function ReportsPage() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function exportCsv() {
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await supabase
        .from('signings')
        .select(`
          id, type, notes, created_at,
          soldier:soldiers(full_name, personal_number, phone),
          unit:units(name),
          team:teams(name),
          performer:profiles!signings_performed_by_fkey(full_name),
          items:signing_items(quantity, action, serial_number, item:items(name))
        `)
        .order('created_at', { ascending: false });
      if (error) throw error;

      const rows: string[] = [
        ['תאריך', 'סוג', 'חייל', 'מס\' אישי', 'מסגרת', 'צוות', 'מבצע', 'פריטים', 'הערות'].join(',')
      ];
      for (const s of data ?? []) {
        const sold = (s.soldier as unknown as { full_name: string; personal_number: string }) ?? null;
        const unit = (s.unit as unknown as { name: string }) ?? null;
        const team = (s.team as unknown as { name: string }) ?? null;
        const perf = (s.performer as unknown as { full_name: string }) ?? null;
        const items = (s.items as unknown as Array<{ quantity: number; serial_number: string | null; item: { name: string } }>) ?? [];
        rows.push([
          new Date(s.created_at).toLocaleString('he-IL'),
          s.type,
          sold?.full_name ?? '',
          sold?.personal_number ?? '',
          unit?.name ?? '',
          team?.name ?? '',
          perf?.full_name ?? '',
          items.map((i) => `${i.item?.name}${i.serial_number ? ` [צ' ${i.serial_number}]` : ''} x${i.quantity}`).join(' | '),
          (s.notes ?? '').replace(/"/g, '""'),
        ].map((c) => `"${c}"`).join(','));
      }
      const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gadhan-radio_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      await logAudit({ action: 'report.export_csv', details: { rows: rows.length - 1 } });
      setMsg({ type: 'success', text: `יוצא: ${rows.length - 1} רשומות` });
    } catch (e) {
      setMsg({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function exportToSheets() {
    setBusy(true); setMsg(null);
    try {
      const { data, error } = await supabase.functions.invoke('export-to-sheets', {
        body: { trigger: 'manual' },
      });
      if (error) throw error;
      await logAudit({ action: 'report.export_sheets', details: data as Record<string, unknown> });
      setMsg({ type: 'success', text: `יוצא ל-Google Sheets בהצלחה (${(data as { rows?: number })?.rows ?? '?'} שורות)` });
    } catch (e) {
      setMsg({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold mb-6">דוחות וייצוא</h2>

      <div className="card mb-4">
        <h3 className="font-semibold mb-2">ייצוא CSV</h3>
        <p className="text-sm text-slate-600 mb-4">
          הורדת כל ההחתמות כקובץ CSV (כולל פירוט פריטים). כפוף להרשאות שלך.
        </p>
        <button onClick={exportCsv} disabled={busy} className="btn-secondary">
          {busy ? 'מייצא...' : 'הורד CSV'}
        </button>
      </div>

      <div className="card mb-4">
        <h3 className="font-semibold mb-2">ייצוא ל-Google Sheets</h3>
        <p className="text-sm text-slate-600 mb-4">
          ייצוא ידני של כל הנתונים לגיליון המוגדר. ייצוא אוטומטי רץ פעם ביום.
        </p>
        <button onClick={exportToSheets} disabled={busy} className="btn-primary">
          {busy ? 'שולח...' : 'ייצא עכשיו ל-Sheets'}
        </button>
      </div>

      {msg && (
        <div className={`rounded-lg px-3 py-2 text-sm ${msg.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
