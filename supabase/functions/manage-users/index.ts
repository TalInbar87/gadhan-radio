// supabase/functions/manage-users/index.ts
// Admin-only user lifecycle (create / delete) using the service role key.
// The caller must be authenticated AND have profiles.role = 'admin'.

// deno-lint-ignore-file no-explicit-any
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // 1. Verify caller is an admin.
    const auth = req.headers.get('Authorization');
    if (!auth) return jsonResponse({ ok: false, error: 'Missing Authorization header' }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: auth } },
    });
    const { data: who } = await userClient.auth.getUser();
    if (!who?.user) return jsonResponse({ ok: false, error: 'Invalid token' }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: callerProfile, error: profErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', who.user.id)
      .single();
    if (profErr || callerProfile?.role !== 'admin') {
      return jsonResponse({ ok: false, error: 'Admin only' }, 403);
    }

    const body = await req.json();
    const action = body?.action as string;

    // 2. Dispatch.
    if (action === 'create') {
      const { username: rawUsername, password, full_name, role, unit_id, personal_number, phone } = body as {
        username: string;
        password: string;
        full_name: string;
        role: 'admin' | 'raspar';
        unit_id?: string | null;
        personal_number?: string | null;
        phone?: string | null;
      };
      const username = (rawUsername ?? '').trim().toLowerCase();
      if (!username || !password || !full_name || !role) {
        return jsonResponse({ ok: false, error: 'Missing required fields' }, 400);
      }
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return jsonResponse({ ok: false, error: 'שם המשתמש חייב להיות אנגלית/ספרות בלבד (3–32 תווים, מותרים גם . _ -)' }, 400);
      }

      // Uniqueness check up front (the unique index will also block, but this gives a clear error).
      const { data: existing } = await admin
        .from('profiles').select('id').eq('username', username).maybeSingle();
      if (existing) {
        return jsonResponse({ ok: false, error: 'שם המשתמש כבר קיים' }, 409);
      }

      const email = `${username}@gadhan.local`;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, username },
      });
      if (createErr) return jsonResponse({ ok: false, error: createErr.message }, 400);

      // Upsert profile (the trigger may have already inserted one with defaults).
      const { error: upsertErr } = await admin
        .from('profiles')
        .upsert({
          id: created.user.id,
          username,
          full_name,
          role,
          unit_id: unit_id || null,
          personal_number: personal_number || null,
          phone: phone || null,
          active: true,
        });
      if (upsertErr) {
        // Rollback the auth user so we don't leak orphans.
        await admin.auth.admin.deleteUser(created.user.id);
        return jsonResponse({ ok: false, error: upsertErr.message }, 400);
      }

      await admin.from('audit_logs').insert({
        action: 'user.create',
        performed_by: who.user.id,
        target_type: 'profile',
        target_id: created.user.id,
        details: { username, role, full_name },
      });

      return jsonResponse({ ok: true, id: created.user.id });
    }

    if (action === 'delete') {
      const { user_id } = body as { user_id: string };
      if (!user_id) return jsonResponse({ ok: false, error: 'Missing user_id' }, 400);
      if (user_id === who.user.id) {
        return jsonResponse({ ok: false, error: 'אי אפשר למחוק את עצמך' }, 400);
      }

      // Profile is removed by FK cascade when auth user is deleted (the schema
      // sets profiles.id → auth.users.id with on delete cascade).
      const { error: delErr } = await admin.auth.admin.deleteUser(user_id);
      if (delErr) return jsonResponse({ ok: false, error: delErr.message }, 400);

      await admin.from('audit_logs').insert({
        action: 'user.delete',
        performed_by: who.user.id,
        target_type: 'profile',
        target_id: user_id,
      });

      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error('[manage-users] error', e);
    return jsonResponse({ ok: false, error: (e as Error).message }, 500);
  }
});
