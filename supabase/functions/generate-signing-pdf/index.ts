// supabase/functions/generate-signing-pdf/index.ts
// Generates a Hebrew PDF receipt of a soldier's CURRENT inventory after a signing
// and uploads it to Supabase Storage (bucket: signing-pdfs).
//
// Auth: SERVICE_ROLE_KEY (cron/internal) bypasses checks; otherwise the caller must
// be either an admin or a רס"פ in the same unit as the signing.
//
// Provided automatically by the runtime:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'https://esm.sh/pdf-lib@1.17.1';
import fontkit from 'https://esm.sh/@pdf-lib/fontkit@1.1.1';

const BUCKET = 'signing-pdfs';
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
    pdf_url: string | null;
  } | null;
  unit: { id: string; name: string } | null;
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
        const np = pdf.addPage([595.28, 841.89]);
        Object.assign(page, np);
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

// ───────────── main ─────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const body = await req.json().catch(() => ({}));
    const signingId = body?.signing_id as string | undefined;
    if (!signingId) return json({ ok: false, error: 'Missing signing_id' }, 400);

    const sb = createClient(supabaseUrl, serviceKey);

    // 1. Fetch signing + relations
    const { data: signing, error: sErr } = await sb
      .from('signings')
      .select(
        `id, type, notes, created_at, unit_id,
         soldier:soldiers(id, full_name, personal_number, phone, pdf_url),
         unit:units(id, name),
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

    // 5. Upload to Supabase Storage (path = <soldier_id>.pdf, overwrite on each
    //    signing — the bucket only ever holds one PDF per soldier).
    const path = `${s.soldier.id}.pdf`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, pdfBytes, {
      contentType: 'application/pdf',
      upsert: true,
      cacheControl: '0',
    });
    if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

    // 6. Build the public URL with a cache-buster tied to this signing so the
    //    browser always fetches the freshest PDF after each new signing.
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    const url = `${pub.publicUrl}?v=${s.id}`;

    // 7. Persist on soldier (authoritative "current") and on this signing (history).
    await sb.from('soldiers').update({ pdf_url: url }).eq('id', s.soldier.id);
    await sb.from('signings').update({ pdf_url: url }).eq('id', s.id);

    // 8. Audit
    await sb.from('audit_logs').insert({
      action: 'signing.pdf_uploaded',
      target_type: 'signing',
      target_id: s.id,
      details: {
        bucket: BUCKET,
        path,
        url,
        bytes: pdfBytes.length,
      },
    });

    return json({ ok: true, url, bytes: pdfBytes.length });
  } catch (e) {
    console.error('[generate-signing-pdf] error', e);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
