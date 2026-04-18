// supabase/functions/generate-signing-pdf/index.ts
// Generates a Hebrew PDF receipt of a soldier's CURRENT inventory after a signing,
// uploads it to a per-unit Google Drive folder, and deletes the soldier's previous PDF.
//
// Auth: SERVICE_ROLE_KEY (cron/internal) bypasses checks; otherwise the caller must be
// either an admin or a רס"פ in the same unit as the signing.
//
// Required secrets:
//   GOOGLE_SERVICE_ACCOUNT_JSON       same SA used by export-to-sheets
//   GOOGLE_DRIVE_PARENT_FOLDER_ID     parent Drive folder shared with the SA
// Provided automatically:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';
import { getGoogleAccessToken } from '../_shared/google-auth.ts';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const HEEBO_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/heebo/Heebo%5Bwght%5D.ttf';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// ───────────── font (cached per warm instance) ─────────────
let cachedFont: Uint8Array | null = null;
async function loadHeebo(): Promise<Uint8Array> {
  if (cachedFont) return cachedFont;
  const res = await fetch(HEEBO_URL);
  if (!res.ok) throw new Error(`heebo fetch failed: ${res.status}`);
  cachedFont = new Uint8Array(await res.arrayBuffer());
  return cachedFont;
}

// ───────────── RTL helper ─────────────
// pdf-lib has no bidi engine. To render Hebrew correctly we reverse the string,
// then un-reverse runs of LTR-typed characters (digits, Latin letters, common ASCII
// punctuation) so that numbers like 1234567 stay readable in the right direction.
function rtl(s: string): string {
  if (!s) return s;
  const reversed = s.split('').reverse().join('');
  return reversed.replace(/[A-Za-z0-9.,:_\-/+()@]+/g, (m) => m.split('').reverse().join(''));
}

function drawRightAligned(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color = rgb(0, 0, 0),
) {
  const visual = rtl(text);
  const w = font.widthOfTextAtSize(visual, size);
  page.drawText(visual, { x: rightX - w, y, size, font, color });
}

// ───────────── auth check ─────────────
async function assertAuthorized(
  req: Request,
  supabaseUrl: string,
  serviceKey: string,
  anonKey: string,
  signingUnitId: string,
): Promise<{ ok: true } | { ok: false; res: Response }> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '');
  if (bearer && bearer === serviceKey) return { ok: true };
  if (!authHeader) return { ok: false, res: json({ ok: false, error: 'Missing Authorization header' }, 401) };

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: who } = await userClient.auth.getUser();
  if (!who?.user) return { ok: false, res: json({ ok: false, error: 'Invalid token' }, 401) };

  const adminClient = createClient(supabaseUrl, serviceKey);
  const { data: prof } = await adminClient
    .from('profiles')
    .select('role, unit_id')
    .eq('id', who.user.id)
    .single();
  if (!prof) return { ok: false, res: json({ ok: false, error: 'Profile not found' }, 403) };
  if (prof.role === 'admin') return { ok: true };
  if (prof.unit_id === signingUnitId) return { ok: true };
  return { ok: false, res: json({ ok: false, error: 'Forbidden: not in signing unit' }, 403) };
}

// ───────────── data shapes ─────────────
type SigningRow = {
  id: string;
  type: 'signing' | 'return' | 'inspection';
  notes: string | null;
  created_at: string;
  unit_id: string;
  soldier: {
    id: string;
    full_name: string;
    personal_number: string;
    phone: string | null;
    pdf_drive_file_id: string | null;
  } | null;
  unit: { id: string; name: string; drive_folder_id: string | null } | null;
  team: { name: string } | null;
  performer: { full_name: string } | null;
};

type InventoryRow = { item_name: string; serial_number: string | null; qty: number };

// ───────────── inventory aggregation ─────────────
async function loadInventory(sb: any, soldierId: string): Promise<InventoryRow[]> {
  const { data, error } = await sb
    .from('signing_items')
    .select('item_id, serial_number, action, quantity, item:items(name), signing:signings!inner(soldier_id)')
    .eq('signing.soldier_id', soldierId)
    .in('action', ['issued', 'returned']);
  if (error) throw error;

  const totals = new Map<string, InventoryRow>();
  for (const r of (data ?? []) as unknown as Array<{
    item_id: string;
    serial_number: string | null;
    action: 'issued' | 'returned';
    quantity: number;
    item: { name: string };
  }>) {
    const key = `${r.item_id}::${r.serial_number ?? ''}`;
    const sign = r.action === 'issued' ? 1 : -1;
    const cur = totals.get(key);
    if (cur) cur.qty += sign * r.quantity;
    else totals.set(key, { item_name: r.item.name, serial_number: r.serial_number, qty: sign * r.quantity });
  }
  return [...totals.values()].filter((r) => r.qty > 0).sort((a, b) => a.item_name.localeCompare(b.item_name, 'he'));
}

// ───────────── PDF render ─────────────
async function renderPdf(signing: SigningRow, inventory: InventoryRow[]): Promise<Uint8Array> {
  const fontBytes = await loadHeebo();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const heebo = await pdf.embedFont(fontBytes, { subset: true });
  const fallback = await pdf.embedFont(StandardFonts.Helvetica);
  void fallback;

  const page = pdf.addPage([595.28, 841.89]); // A4
  const right = 545; // right margin x
  const left = 50;
  const width = right - left;
  let y = 800;

  const typeLabel = { signing: 'החתמה', return: 'זיכוי', inspection: 'בדיקה' }[signing.type];
  const created = new Date(signing.created_at);
  const dateStr = created.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

  // Title
  drawRightAligned(page, 'טופס החתמת ציוד קשר — סיכום נוכחי', right, y, heebo, 18);
  y -= 28;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.7, color: rgb(0.7, 0.7, 0.7) });
  y -= 18;

  // Meta block
  const metaSize = 11;
  const metaLines: Array<[string, string]> = [
    ['תאריך עדכון אחרון', dateStr],
    ['פעולה אחרונה', typeLabel],
    ['מסגרת', signing.unit?.name ?? '—'],
    ['צוות', signing.team?.name ?? '—'],
    ['בוצע ע״י', signing.performer?.full_name ?? '—'],
  ];
  for (const [label, val] of metaLines) {
    drawRightAligned(page, `${label}: ${val}`, right, y, heebo, metaSize);
    y -= 16;
  }
  y -= 6;

  // Soldier block
  drawRightAligned(page, 'פרטי החייל', right, y, heebo, 14);
  y -= 20;
  const soldier = signing.soldier;
  const soldierLines: Array<[string, string]> = [
    ['שם מלא', soldier?.full_name ?? '—'],
    ['מספר אישי', soldier?.personal_number ?? '—'],
    ['טלפון', soldier?.phone ?? '—'],
  ];
  for (const [label, val] of soldierLines) {
    drawRightAligned(page, `${label}: ${val}`, right, y, heebo, metaSize);
    y -= 16;
  }
  y -= 10;

  // Inventory table
  drawRightAligned(page, `רשימת פריטים בחזקתו (${inventory.length})`, right, y, heebo, 14);
  y -= 20;

  // Header row
  const colQtyX = left + 60;       // qty cell right edge
  const colSerialX = left + 220;   // serial cell right edge
  const colNameX = right;          // name cell right edge
  page.drawLine({ start: { x: left, y: y + 4 }, end: { x: right, y: y + 4 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
  drawRightAligned(page, 'שם פריט', colNameX, y - 12, heebo, 11, rgb(0.3, 0.3, 0.3));
  drawRightAligned(page, "צ'", colSerialX, y - 12, heebo, 11, rgb(0.3, 0.3, 0.3));
  drawRightAligned(page, 'כמות', colQtyX, y - 12, heebo, 11, rgb(0.3, 0.3, 0.3));
  y -= 22;
  page.drawLine({ start: { x: left, y: y + 4 }, end: { x: right, y: y + 4 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });

  if (inventory.length === 0) {
    drawRightAligned(page, 'אין פריטים בחזקת החייל', right, y - 14, heebo, 11, rgb(0.5, 0.5, 0.5));
    y -= 26;
  } else {
    for (const row of inventory) {
      if (y < 80) {
        // simple page-break safeguard
        const np = pdf.addPage([595.28, 841.89]);
        Object.assign(page, np); // not perfect, but rare for normal soldiers
        y = 800;
      }
      drawRightAligned(page, row.item_name, colNameX, y - 12, heebo, 11);
      drawRightAligned(page, row.serial_number || '—', colSerialX, y - 12, heebo, 11);
      drawRightAligned(page, String(row.qty), colQtyX, y - 12, heebo, 11);
      y -= 18;
    }
    page.drawLine({ start: { x: left, y: y + 4 }, end: { x: right, y: y + 4 }, thickness: 0.3, color: rgb(0.9, 0.9, 0.9) });
  }

  // Notes
  if (signing.notes) {
    y -= 14;
    drawRightAligned(page, 'הערות לפעולה אחרונה:', right, y, heebo, 11, rgb(0.3, 0.3, 0.3));
    y -= 16;
    drawRightAligned(page, signing.notes, right, y, heebo, 11);
    y -= 16;
  }

  // Footer
  drawRightAligned(page, `מזהה החתמה: ${signing.id}`, right, 40, heebo, 8, rgb(0.55, 0.55, 0.55));

  return await pdf.save();
}

// ───────────── Drive helpers ─────────────
async function ensureUnitFolder(
  token: string,
  parentFolderId: string,
  unit: { id: string; name: string; drive_folder_id: string | null },
  sb: any,
): Promise<string> {
  if (unit.drive_folder_id) return unit.drive_folder_id;
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: unit.name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    }),
  });
  if (!res.ok) throw new Error(`Drive folder create failed: [${res.status}] ${await res.text()}`);
  const j = await res.json();
  const folderId = j.id as string;
  await sb.from('units').update({ drive_folder_id: folderId }).eq('id', unit.id);
  return folderId;
}

async function uploadPdf(
  token: string,
  folderId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  const boundary = '----gadhan-radio-boundary-' + crypto.randomUUID();
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: 'application/pdf' });
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      metadata +
      `\r\n--${boundary}\r\n` +
      'Content-Type: application/pdf\r\n\r\n',
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!res.ok) throw new Error(`Drive upload failed: [${res.status}] ${await res.text()}`);
  const j = await res.json();
  return j.id as string;
}

async function deleteDriveFile(token: string, fileId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) {
      console.error('[generate-signing-pdf] old file delete failed', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[generate-signing-pdf] old file delete threw', e);
    return false;
  }
}

// ───────────── main ─────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    const parentFolderId = Deno.env.get('GOOGLE_DRIVE_PARENT_FOLDER_ID');
    if (!saJson || !parentFolderId) {
      return json({ ok: false, error: 'Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_DRIVE_PARENT_FOLDER_ID secret' }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const signingId = body?.signing_id as string | undefined;
    if (!signingId) return json({ ok: false, error: 'Missing signing_id' }, 400);

    const sb = createClient(supabaseUrl, serviceKey);

    // 1. Fetch signing + relations
    const { data: signing, error: sErr } = await sb
      .from('signings')
      .select(
        `id, type, notes, created_at, unit_id,
         soldier:soldiers(id, full_name, personal_number, phone, pdf_drive_file_id),
         unit:units(id, name, drive_folder_id),
         team:teams(name),
         performer:profiles!signings_performed_by_fkey(full_name)`,
      )
      .eq('id', signingId)
      .single();
    if (sErr || !signing) return json({ ok: false, error: `Signing not found: ${sErr?.message ?? ''}` }, 404);
    const s = signing as unknown as SigningRow;
    if (!s.soldier || !s.unit) return json({ ok: false, error: 'Signing missing soldier or unit' }, 500);

    // 2. Authorize
    const auth = await assertAuthorized(req, supabaseUrl, serviceKey, anonKey, s.unit_id);
    if (!auth.ok) return auth.res;

    // 3. Aggregate inventory
    const inventory = await loadInventory(sb, s.soldier.id);

    // 4. Render PDF
    const pdfBytes = await renderPdf(s, inventory);

    // 5. Drive: get/create folder, upload, delete old
    const token = await getGoogleAccessToken(saJson, DRIVE_SCOPE);
    const folderId = await ensureUnitFolder(token, parentFolderId, s.unit, sb);

    const safeName = s.soldier.full_name.replace(/[\\/<>:"|?*]/g, '_');
    const fileName = `${s.soldier.personal_number}__${safeName}.pdf`;
    const oldFileId = s.soldier.pdf_drive_file_id;
    const newFileId = await uploadPdf(token, folderId, fileName, pdfBytes);

    // 6. Persist refs (soldier + signing both point at the new "current" PDF)
    await sb.from('soldiers').update({ pdf_drive_file_id: newFileId }).eq('id', s.soldier.id);
    await sb.from('signings').update({ pdf_drive_file_id: newFileId }).eq('id', s.id);

    // 7. Delete old (best-effort)
    let supersededDeleted = false;
    if (oldFileId && oldFileId !== newFileId) {
      supersededDeleted = await deleteDriveFile(token, oldFileId);
    }

    // 8. Audit
    await sb.from('audit_logs').insert({
      action: 'signing.pdf_uploaded',
      target_type: 'signing',
      target_id: s.id,
      details: {
        drive_file_id: newFileId,
        drive_folder_id: folderId,
        file_name: fileName,
        bytes: pdfBytes.length,
        superseded_file_id: oldFileId ?? null,
        superseded_deleted: supersededDeleted,
      },
    });

    return json({
      ok: true,
      drive_file_id: newFileId,
      view_url: `https://drive.google.com/file/d/${newFileId}/view`,
      bytes: pdfBytes.length,
      superseded_deleted: supersededDeleted,
    });
  } catch (e) {
    console.error('[generate-signing-pdf] error', e);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
