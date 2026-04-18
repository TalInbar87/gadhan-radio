// supabase/functions/export-to-sheets/index.ts
// Export the signings table to a Google Sheet.
// Auth: caller must be a logged-in admin (or invoked by the cron with the SERVICE_ROLE_KEY).
//
// Required secrets (set via `supabase secrets set ...`):
//   GOOGLE_SERVICE_ACCOUNT_JSON  full JSON of a Google Cloud service account (string)
//   GOOGLE_SHEET_ID              target sheet ID
//   SHEET_TAB_NAME               (optional) defaults to "signings"
//
// Daily run is configured via pg_cron — see migrations/0003_cron.sql.

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface SigningRow {
  id: string;
  type: string;
  notes: string | null;
  created_at: string;
  soldier: { full_name: string; personal_number: string; phone: string | null } | null;
  unit: { name: string } | null;
  team: { name: string } | null;
  performer: { full_name: string } | null;
  items: Array<{ quantity: number; action: string; serial_number: string | null; item: { name: string } | null }>;
}

async function getGoogleAccessToken(saJson: string): Promise<string> {
  const sa = JSON.parse(saJson) as { client_email: string; private_key: string };
  const pem = sa.private_key.replace(/\\n/g, '\n');

  // Convert PEM PKCS#8 to CryptoKey
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
    ['sign']
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
    key
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

async function writeToSheet(token: string, sheetId: string, tabName: string, rows: any[][]) {
  // Clear existing range, then write fresh values starting at A1
  const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}:clear`;
  await fetch(clearUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A1?valueInputOption=USER_ENTERED`;
  const writeRes = await fetch(writeUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: rows }),
  });
  if (!writeRes.ok) throw new Error(`Sheets write failed: ${await writeRes.text()}`);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    const sheetId = Deno.env.get('GOOGLE_SHEET_ID');
    const tabName = Deno.env.get('SHEET_TAB_NAME') ?? 'signings';

    if (!saJson || !sheetId) {
      throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SHEET_ID secret');
    }

    // Use service-role client so we read everything (cron has no user context).
    const sb = createClient(supabaseUrl, serviceKey);

    const { data, error } = await sb
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

    const rows: any[][] = [
      ['תאריך', 'סוג', 'חייל', 'מספר אישי', 'טלפון', 'מסגרת', 'צוות', 'מבצע', 'פריטים', 'הערות'],
    ];
    for (const s of (data ?? []) as unknown as SigningRow[]) {
      rows.push([
        new Date(s.created_at).toLocaleString('he-IL'),
        s.type,
        s.soldier?.full_name ?? '',
        s.soldier?.personal_number ?? '',
        s.soldier?.phone ?? '',
        s.unit?.name ?? '',
        s.team?.name ?? '',
        s.performer?.full_name ?? '',
        s.items.map((i) => `${i.item?.name ?? '?'}${i.serial_number ? ` [צ' ${i.serial_number}]` : ''} x${i.quantity}`).join(' | '),
        s.notes ?? '',
      ]);
    }

    const token = await getGoogleAccessToken(saJson);
    await writeToSheet(token, sheetId, tabName, rows);

    // Log to audit (best-effort)
    await sb.from('audit_logs').insert({
      action: 'sheets.export',
      details: { rows: rows.length - 1, tab: tabName },
    });

    return new Response(
      JSON.stringify({ ok: true, rows: rows.length - 1 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('[export-to-sheets] error', e);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
