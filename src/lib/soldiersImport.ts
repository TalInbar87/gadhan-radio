import { supabase } from './supabase';
import type { Soldier, Team, Unit } from './database.types';

/**
 * Bulk soldier import — paste-friendly (CSV/TSV) with flexible Hebrew+English
 * headers. Resolves units/teams by name and can auto-create missing ones.
 */

export type RowStatus = 'insert' | 'create-unit' | 'create-team' | 'skip-duplicate' | 'error';

export interface ParsedRow {
  lineNumber: number;           // 1-based row in the user input (header not counted)
  raw: string;                  // original line (for diagnostics)
  full_name: string;
  personal_number: string;
  phone: string;
  unit_name: string;
  team_name: string;            // '' if none
  status: RowStatus;
  reason?: string;              // explanation when status = 'error' or notes
  // Resolved after we know what's in the DB:
  unit_id?: string | null;      // null → will be auto-created
  team_id?: string | null;      // null → no team (or will be auto-created)
  willCreateUnit?: boolean;
  willCreateTeam?: boolean;
}

export interface PreviewResult {
  rows: ParsedRow[];
  newUnitNames: string[];                     // units that don't exist yet
  newTeamKeys: string[];                      // "<unitName> / <teamName>" pairs
  stats: { insert: number; skip: number; error: number };
}

/** Synonyms → canonical field. Matching is case/whitespace-insensitive. */
const HEADER_SYNONYMS: Record<string, string> = {
  'שם': 'full_name',
  'שם מלא': 'full_name',
  'name': 'full_name',
  'full name': 'full_name',
  'מספר אישי': 'personal_number',
  'מס אישי': 'personal_number',
  "מס' אישי": 'personal_number',
  'מספר': 'personal_number',
  'personal number': 'personal_number',
  'personal_number': 'personal_number',
  'pn': 'personal_number',
  'טלפון': 'phone',
  'נייד': 'phone',
  'phone': 'phone',
  'mobile': 'phone',
  'מסגרת': 'unit_name',
  'פלוגה': 'unit_name',
  'יחידה': 'unit_name',
  'unit': 'unit_name',
  'צוות': 'team_name',
  'כיתה': 'team_name',
  'team': 'team_name',
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Split a pasted blob into rows of cells. Auto-detects tab vs comma.
 * Supports quoted cells with embedded commas.
 */
function splitRows(blob: string): string[][] {
  const text = blob.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const rows: string[][] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Prefer tab if present (typical from Excel copy).
    const delim = line.includes('\t') ? '\t' : ',';
    rows.push(parseCsvLine(line, delim));
  }
  return rows;
}

function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === delim) { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * Parse the blob into preview rows + resolve against the DB. Does NOT insert.
 */
export async function previewImport(
  blob: string,
  opts: { autoCreateMissing: boolean },
): Promise<PreviewResult> {
  const rows = splitRows(blob);
  if (rows.length === 0) {
    return { rows: [], newUnitNames: [], newTeamKeys: [], stats: { insert: 0, skip: 0, error: 0 } };
  }

  // Detect header row: if the first row's cells map to known headers, use it.
  const firstCells = rows[0];
  const headerMap = firstCells.map((h) => HEADER_SYNONYMS[normalizeHeader(h)] ?? null);
  const hasHeader = headerMap.some((m) => m !== null);
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // If no header row, assume positional order: name, pn, phone, unit, team.
  const colIndex: Record<string, number> = {};
  if (hasHeader) {
    headerMap.forEach((field, idx) => { if (field) colIndex[field] = idx; });
  } else {
    colIndex.full_name = 0;
    colIndex.personal_number = 1;
    colIndex.phone = 2;
    colIndex.unit_name = 3;
    colIndex.team_name = 4;
  }

  // Load existing data we need to resolve against.
  const [soldiersRes, unitsRes, teamsRes] = await Promise.all([
    supabase.from('soldiers').select('personal_number'),
    supabase.from('units').select('id, name'),
    supabase.from('teams').select('id, name, unit_id'),
  ]);
  const existingPNs = new Set((soldiersRes.data ?? []).map((s) => s.personal_number));
  const units = (unitsRes.data ?? []) as Pick<Unit, 'id' | 'name'>[];
  const teams = (teamsRes.data ?? []) as Pick<Team, 'id' | 'name' | 'unit_id'>[];
  const unitByName = new Map<string, Pick<Unit, 'id' | 'name'>>();
  for (const u of units) unitByName.set(u.name.trim(), u);
  const teamByKey = new Map<string, Pick<Team, 'id' | 'name' | 'unit_id'>>();
  for (const t of teams) teamByKey.set(`${t.unit_id}::${t.name.trim()}`, t);

  const out: ParsedRow[] = [];
  const seenPNsInBatch = new Set<string>();
  const newUnitNames = new Set<string>();
  const newTeamKeys = new Set<string>();

  dataRows.forEach((cells, idx) => {
    const get = (field: string) => (colIndex[field] != null ? (cells[colIndex[field]] ?? '').trim() : '');
    const row: ParsedRow = {
      lineNumber: idx + 1,
      raw: cells.join(' | '),
      full_name: get('full_name'),
      personal_number: get('personal_number'),
      phone: get('phone'),
      unit_name: get('unit_name'),
      team_name: get('team_name'),
      status: 'insert',
    };

    // Validation.
    if (!row.full_name) {
      row.status = 'error';
      row.reason = 'חסר שם';
      out.push(row); return;
    }
    if (!/^\d{7}$/.test(row.personal_number)) {
      row.status = 'error';
      row.reason = 'מספר אישי חייב 7 ספרות';
      out.push(row); return;
    }
    if (!/^05\d{8}$/.test(row.phone)) {
      row.status = 'error';
      row.reason = 'טלפון לא תקין (05XXXXXXXX)';
      out.push(row); return;
    }
    if (!row.unit_name) {
      row.status = 'error';
      row.reason = 'חסרה מסגרת';
      out.push(row); return;
    }
    if (existingPNs.has(row.personal_number) || seenPNsInBatch.has(row.personal_number)) {
      row.status = 'skip-duplicate';
      row.reason = existingPNs.has(row.personal_number) ? 'קיים במערכת' : 'כפול בקובץ';
      out.push(row); return;
    }
    seenPNsInBatch.add(row.personal_number);

    // Resolve unit.
    const u = unitByName.get(row.unit_name);
    if (u) {
      row.unit_id = u.id;
    } else if (opts.autoCreateMissing) {
      row.unit_id = null;
      row.willCreateUnit = true;
      row.status = 'create-unit';
      newUnitNames.add(row.unit_name);
    } else {
      row.status = 'error';
      row.reason = `מסגרת "${row.unit_name}" לא קיימת`;
      out.push(row); return;
    }

    // Resolve team (optional).
    if (row.team_name) {
      if (row.unit_id) {
        const t = teamByKey.get(`${row.unit_id}::${row.team_name}`);
        if (t) {
          row.team_id = t.id;
        } else if (opts.autoCreateMissing) {
          row.team_id = null;
          row.willCreateTeam = true;
          if (row.status === 'insert') row.status = 'create-team';
          newTeamKeys.add(`${row.unit_name} / ${row.team_name}`);
        } else {
          row.status = 'error';
          row.reason = `צוות "${row.team_name}" לא קיים במסגרת "${row.unit_name}"`;
          out.push(row); return;
        }
      } else {
        // unit itself will be created → team will also need to be created.
        row.team_id = null;
        row.willCreateTeam = true;
        newTeamKeys.add(`${row.unit_name} / ${row.team_name}`);
      }
    } else {
      row.team_id = null;
    }

    out.push(row);
  });

  const stats = {
    insert: out.filter((r) => r.status === 'insert' || r.status === 'create-unit' || r.status === 'create-team').length,
    skip: out.filter((r) => r.status === 'skip-duplicate').length,
    error: out.filter((r) => r.status === 'error').length,
  };

  return {
    rows: out,
    newUnitNames: [...newUnitNames].sort((a, b) => a.localeCompare(b, 'he')),
    newTeamKeys: [...newTeamKeys].sort((a, b) => a.localeCompare(b, 'he')),
    stats,
  };
}

export interface ImportResult {
  insertedSoldiers: number;
  createdUnits: number;
  createdTeams: number;
  skipped: number;
  errors: number;
}

/**
 * Perform the actual insert. Assumes the user has already previewed.
 * Creates missing units/teams in order, then bulk-inserts soldiers.
 */
export async function performImport(rows: ParsedRow[]): Promise<ImportResult> {
  const result: ImportResult = {
    insertedSoldiers: 0,
    createdUnits: 0,
    createdTeams: 0,
    skipped: rows.filter((r) => r.status === 'skip-duplicate').length,
    errors: rows.filter((r) => r.status === 'error').length,
  };

  // 1. Create missing units (unique by name).
  const unitNamesToCreate = Array.from(
    new Set(rows.filter((r) => r.willCreateUnit).map((r) => r.unit_name)),
  );
  const createdUnitIdByName = new Map<string, string>();
  for (const name of unitNamesToCreate) {
    const { data, error } = await supabase.from('units').insert({ name }).select('id, name').single();
    if (error) throw new Error(`יצירת מסגרת "${name}" נכשלה: ${error.message}`);
    createdUnitIdByName.set(data.name, data.id);
    result.createdUnits++;
  }
  for (const r of rows) {
    if (r.willCreateUnit && !r.unit_id) {
      const id = createdUnitIdByName.get(r.unit_name);
      if (id) r.unit_id = id;
    }
  }

  // 2. Create missing teams (unique by unit_id + name).
  const teamKeysToCreate = new Map<string, { unit_id: string; name: string }>();
  for (const r of rows) {
    if (r.willCreateTeam && r.unit_id && r.team_name) {
      teamKeysToCreate.set(`${r.unit_id}::${r.team_name}`, { unit_id: r.unit_id, name: r.team_name });
    }
  }
  const createdTeamIdByKey = new Map<string, string>();
  for (const [key, { unit_id, name }] of teamKeysToCreate) {
    const { data, error } = await supabase.from('teams').insert({ unit_id, name }).select('id').single();
    if (error) throw new Error(`יצירת צוות "${name}" נכשלה: ${error.message}`);
    createdTeamIdByKey.set(key, data.id);
    result.createdTeams++;
  }
  for (const r of rows) {
    if (r.willCreateTeam && r.unit_id && r.team_name && !r.team_id) {
      r.team_id = createdTeamIdByKey.get(`${r.unit_id}::${r.team_name}`) ?? null;
    }
  }

  // 3. Insert soldiers (batched).
  const toInsert = rows
    .filter((r) => r.status !== 'error' && r.status !== 'skip-duplicate' && r.unit_id)
    .map((r) => ({
      full_name: r.full_name,
      personal_number: r.personal_number,
      phone: r.phone,
      unit_id: r.unit_id as string,
      team_id: r.team_id ?? null,
    }));

  if (toInsert.length > 0) {
    // Chunk to avoid hitting request-size limits.
    const CHUNK = 200;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const { error, data } = await supabase.from('soldiers').insert(chunk).select('id');
      if (error) throw new Error(`הכנסת חיילים נכשלה: ${error.message}`);
      result.insertedSoldiers += (data?.length ?? 0);
    }
  }

  return result;
}

export type { Soldier };
