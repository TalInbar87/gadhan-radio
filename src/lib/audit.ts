import { supabase } from './supabase';

export async function logAudit(params: {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}) {
  const { data: userData } = await supabase.auth.getUser();
  await supabase.from('audit_logs').insert({
    action: params.action,
    performed_by: userData.user?.id ?? null,
    target_type: params.targetType ?? null,
    target_id: params.targetId ?? null,
    details: params.details ?? null,
  });
}
