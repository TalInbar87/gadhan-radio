// supabase/functions/export-to-sheets/index.ts
// Export a per-unit inventory matrix to Google Sheets.
// Each unit (מסגרת) gets its own tab with columns:
//   שם מלא | מספר אישי | טלפון | <item 1> | <item 2> | ...
// Rows = soldiers in that unit; cells = quantity currently held.
// Auth: caller must be a logged-in admin (or invoked by the cron with the SERVICE_ROLE_KEY).
//
// Required secrets (set via `supabase secrets set ...`):
//   GOOGLE_SERVICE_ACCOUNT_JSON  full JSON of a Google Cloud service account
//   GOOGLE_SHEET_ID              target spreadsheet ID

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ───────────────────────── Google auth ─────────────────────────
async function getGoogleAccessToken(saJson: string): Promise<string> {
  const sa = JSON.parse(saJson) as { client_email: string; private_key: string };
  const pem = sa.private_key.replace(/\\n/g, '\n');

  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const now = getNumericDate(0);
  const jwt = await create(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: getNumericDate(60 * 30),
    },
    key,
  );

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!tokRes.ok) throw new Error(`Google token exchange failed: ${await tokRes.text()}`);
  const tok = await tokRes.json();
  return tok.access_token as string;
}

// ───────────────────────── Sheets helpers ──────────────────────
async function getExistingTabs(token: string, sheetId: string): Promise<Set<string>> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets(properties(title))`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets metadata fetch failed: ${await res.text()}`);
  const j = await res.json();
  const titles = (j.sheets ?? []).map((s: any) => s.properties?.title).filter(Boolean);
  return new Set(titles);
}

async function createTab(token: string, sheetId: string, title: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });
  if (!res.ok) throw new Error(`Add-sheet failed for "${title}": ${await res.text()}`);
}

async function writeToSheet(token: string, sheetId: string, tabName: string, rows: any[][]) {
  const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}:clear`;
  await fetch(clearUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=USER_ENTERED`;
  const writeRes = await fetch(writeUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  if (!writeRes.ok) throw new Error(`Sheets write failed for "${tabName}": ${await writeRes.text()}`);
}

// ───────────────────────── main ─────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    const sheetId = Deno.env.get('GOOGLE_SHEET_ID');

    if (!saJson || !sheetId) {
      throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEET_ID secret');
    }

    // Auth: cron uses SERVICE_ROLE_KEY directly; user calls must be from an admin.
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '');
    const isCron = bearer && bearer === serviceKey;
    if (!isCron) {
      if (!authHeader) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing Authorization header' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: who } = await userClient.auth.getUser();
      if (!who?.user) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const adminCheck = createClient(supabaseUrl, serviceKey);
      const { data: prof } = await adminCheck
        .from('profiles').select('role').eq('id', who.user.id).single();
      if (prof?.role !== 'admin') {
        return new Response(JSON.stringify({ ok: false, error: 'Admin only' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const sb = createClient(supabaseUrl, serviceKey);

    // 1. Load reference data in parallel.
    const [unitsRes, itemsRes, soldiersRes, siRes] = await Promise.all([
      sb.from('units').select('id, name').order('name'),
      sb.from('items').select('id, name').eq('active', true).order('name'),
      sb.from('soldiers').select('id, full_name, personal_number, phone, unit_id').order('full_name'),
      sb.from('signing_items').select('item_id, quantity, action, signing:signings(soldier_id)').in('action', ['issued', 'returned']),
    ]);
    if (unitsRes.error) throw unitsRes.error;
    if (itemsRes.error) throw itemsRes.error;
    if (soldiersRes.error) throw soldiersRes.error;
    if (siRes.error) throw siRes.error;

    const units = unitsRes.data ?? [];
    const items = itemsRes.data ?? [];
    const soldiers = soldiersRes.data ?? [];

    // 2. Build per-(soldier, item) net held map.
    //    key = `${soldier_id}::${item_id}` → quantity
    const held = new Map<string, number>();
    for (const row of (siRes.data ?? []) as unknown as Array<{
      item_id: string;
      quantity: number;
      action: string;
      signing: { soldier_id: string } | null;
    }>) {
      const sid = row.signing?.soldier_id;
      if (!sid) continue;
      const key = `${sid}::${row.item_id}`;
      const cur = held.get(key) ?? 0;
      held.set(key, cur + (row.action === 'issued' ? row.quantity : -row.quantity));
    }

    // 3. Make sure every unit has a tab.
    const token = await getGoogleAccessToken(saJson);
    const existingTabs = await getExistingTabs(token, sheetId);
    for (const u of units) {
      if (!existingTabs.has(u.name)) {
        await createTab(token, sheetId, u.name);
      }
    }

    // 4. Build and write one tab per unit.
    const header = ['שם מלא', 'מספר אישי', 'טלפון', ...items.map((i) => i.name)];
    let totalRows = 0;
    const summary: Record<string, number> = {};

    for (const u of units) {
      const unitSoldiers = soldiers.filter((s) => s.unit_id === u.id);
      const rows: any[][] = [header];
      for (const s of unitSoldiers) {
        const line: any[] = [s.full_name, s.personal_number, s.phone ?? ''];
        for (const it of items) {
          const qty = held.get(`${s.id}::${it.id}`) ?? 0;
          line.push(qty > 0 ? qty : '');
        }
        rows.push(line);
      }
      await writeToSheet(token, sheetId, u.name, rows);
      summary[u.name] = unitSoldiers.length;
      totalRows += unitSoldiers.length;
    }

    // 5. Audit log.
    await sb.from('audit_logs').insert({
      action: 'sheets.export',
      details: { units: units.length, total_soldiers: totalRows, per_unit: summary },
    });

    return new Response(
      JSON.stringify({ ok: true, units: units.length, rows: totalRows, per_unit: summary }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[export-to-sheets] error', e);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
