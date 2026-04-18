import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.warn('[supabase] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env');
}

// Untyped client — we use hand-written row types from `database.types.ts`
// at the call sites. To enable full inference, run:
//   supabase gen types typescript --linked > src/lib/database.types.ts
// and parametrize createClient<Database>().
export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: { persistSession: true, autoRefreshToken: true },
});
