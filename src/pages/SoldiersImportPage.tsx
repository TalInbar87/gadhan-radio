import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { logAudit } from '../lib/audit';
import {
  previewImport,
  performImport,
  type ParsedRow,
  type PreviewResult,
} from '../lib/soldiersImport';

/**
 * Admin "bulk import soldiers" page. Paste CSV/TSV (with or without headers),
 * preview each row with color-coded status, then execute.
 */
export default function SoldiersImportPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [blob, setBlob] = useState('');
  const [autoCreate, setAutoCreate] = useState(true);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onPreview() {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const p = await previewImport(blob, { autoCreateMissing: autoCreate });
      setPreview(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function onImport() {
    if (!preview) return;
    if (!window.confirm(`לייבא ${preview.stats.insert} חיילים?`)) return;
    setError(null);
    setImporting(true);
    try {
      const r = await performImport(preview.rows);
      await logAudit({
        action: 'soldiers.bulk_import',
        details: {
          inserted: r.insertedSoldiers,
          created_units: r.createdUnits,
          created_teams: r.createdTeams,
          skipped: r.skipped,
          errors: r.errors,
        },
      });
      setResult(
        `יובאו ${r.insertedSoldiers} חיילים. ` +
        `נוצרו ${r.createdUnits} מסגרות חדשות ו-${r.createdTeams} צוותים חדשים. ` +
        `דולגו ${r.skipped}, שגיאות ${r.errors}.`,
      );
      setBlob('');
      setPreview(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div>
      <div className="flex items-center justify-between mb-4 md:mb-6 gap-3 flex-wrap">
        <h2 className="text-xl md:text-2xl font-bold">ייבוא חיילים</h2>
      </div>

      <div className="card mb-4 space-y-3">
        <div className="text-sm text-slate-600">
          הדבק את תוכן האקסל (שורה לכל חייל). העמודות הנתמכות:
          <span className="font-medium"> שם, מספר אישי, טלפון, מסגרת, צוות</span>.
          ניתן עם או בלי שורת כותרות.
        </div>
        <textarea
          className="input font-mono text-xs"
          rows={10}
          placeholder={`שם\tמספר אישי\tטלפון\tמסגרת\tצוות\nישראל ישראלי\t1234567\t0501234567\tפלוגה א\tצוות 1`}
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          dir="ltr"
          style={{ whiteSpace: 'pre' }}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoCreate}
              onChange={(e) => setAutoCreate(e.target.checked)}
            />
            ליצור מסגרות/צוותים חסרים אוטומטית
          </label>
          <button
            className="btn-primary !py-1.5 !px-4 text-sm"
            onClick={onPreview}
            disabled={!blob.trim() || loading}
          >
            {loading ? 'טוען...' : 'תצוגה מקדימה'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card mb-4 bg-red-50 text-red-700 text-sm">
          {error}
        </div>
      )}
      {result && (
        <div className="card mb-4 bg-emerald-50 text-emerald-700 text-sm">
          {result}
        </div>
      )}

      {preview && (
        <>
          <div className="card mb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Stat label="יתווספו" value={preview.stats.insert} color="text-emerald-700" />
              <Stat label="ידלגו (כפול)" value={preview.stats.skip} color="text-slate-500" />
              <Stat label="שגיאות" value={preview.stats.error} color="text-red-600" />
              <Stat label="סה״כ שורות" value={preview.rows.length} color="text-slate-700" />
            </div>
            {(preview.newUnitNames.length > 0 || preview.newTeamKeys.length > 0) && (
              <div className="mt-3 pt-3 border-t text-xs text-slate-600 space-y-1">
                {preview.newUnitNames.length > 0 && (
                  <div>
                    <span className="font-medium">מסגרות שייווצרו:</span>{' '}
                    {preview.newUnitNames.join(', ')}
                  </div>
                )}
                {preview.newTeamKeys.length > 0 && (
                  <div>
                    <span className="font-medium">צוותים שייווצרו:</span>{' '}
                    {preview.newTeamKeys.join(', ')}
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                className="btn-primary !py-1.5 !px-4 text-sm"
                onClick={onImport}
                disabled={importing || preview.stats.insert === 0}
              >
                {importing ? 'מייבא...' : `ייבא ${preview.stats.insert} חיילים`}
              </button>
              <button
                className="btn-secondary !py-1.5 !px-4 text-sm"
                onClick={() => setPreview(null)}
                disabled={importing}
              >
                בטל
              </button>
            </div>
          </div>

          <div className="card">
            <div className="table-wrap">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>סטטוס</th>
                    <th>שם</th>
                    <th>מספר אישי</th>
                    <th>טלפון</th>
                    <th>מסגרת</th>
                    <th>צוות</th>
                    <th>הערה</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.lineNumber} className={rowBg(r)}>
                      <td className="text-xs">{r.lineNumber}</td>
                      <td className="text-xs whitespace-nowrap">{statusLabel(r)}</td>
                      <td>{r.full_name || '—'}</td>
                      <td className="font-mono text-xs">{r.personal_number || '—'}</td>
                      <td className="font-mono text-xs">{r.phone || '—'}</td>
                      <td>
                        {r.unit_name}
                        {r.willCreateUnit && <span className="text-xs text-amber-700 mr-1">(חדש)</span>}
                      </td>
                      <td>
                        {r.team_name || '—'}
                        {r.willCreateTeam && <span className="text-xs text-amber-700 mr-1">(חדש)</span>}
                      </td>
                      <td className="text-xs text-slate-600">{r.reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function rowBg(r: ParsedRow): string {
  switch (r.status) {
    case 'error': return 'bg-red-50';
    case 'skip-duplicate': return 'bg-slate-100 text-slate-500';
    case 'create-unit':
    case 'create-team': return 'bg-amber-50';
    case 'insert': return 'bg-emerald-50';
    default: return '';
  }
}

function statusLabel(r: ParsedRow): string {
  switch (r.status) {
    case 'error': return 'שגיאה';
    case 'skip-duplicate': return 'כפול — ידולג';
    case 'create-unit': return 'יתווסף + מסגרת חדשה';
    case 'create-team': return 'יתווסף + צוות חדש';
    case 'insert': return 'יתווסף';
  }
}
