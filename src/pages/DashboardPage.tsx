import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

interface Stats {
  totalSignings: number;
  totalSoldiers: number;
  totalItems: number;
  todaySignings: number;
}

export default function DashboardPage() {
  const { profile } = useAuth();
  const [stats, setStats] = useState<Stats>({ totalSignings: 0, totalSoldiers: 0, totalItems: 0, todaySignings: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const [sig, sold, it, today] = await Promise.all([
        supabase.from('signings').select('*', { count: 'exact', head: true }),
        supabase.from('soldiers').select('*', { count: 'exact', head: true }),
        supabase.from('items').select('*', { count: 'exact', head: true }).eq('active', true),
        supabase.from('signings').select('*', { count: 'exact', head: true }).gte('created_at', startOfDay.toISOString()),
      ]);
      setStats({
        totalSignings: sig.count ?? 0,
        totalSoldiers: sold.count ?? 0,
        totalItems: it.count ?? 0,
        todaySignings: today.count ?? 0,
      });
      setLoading(false);
    })();
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">שלום, {profile?.full_name}</h2>
        <p className="text-slate-500 text-sm mt-1">
          {profile?.role === 'admin' ? 'תצוגת מנהל מערכת' : 'תצוגת רס"פ — מסגרת בלבד'}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard title="החתמות היום" value={stats.todaySignings} loading={loading} />
        <StatCard title='סה"כ החתמות' value={stats.totalSignings} loading={loading} />
        <StatCard title="חיילים רשומים" value={stats.totalSoldiers} loading={loading} />
        <StatCard title="פריטים פעילים" value={stats.totalItems} loading={loading} />
      </div>

      <div className="card">
        <h3 className="text-lg font-semibold mb-3">פעולות מהירות</h3>
        <div className="flex gap-3 flex-wrap">
          <Link to="/sign" className="btn-primary">+ החתמה חדשה</Link>
          <Link to="/soldiers" className="btn-secondary">חיילים</Link>
          <Link to="/logs" className="btn-secondary">יומן ביקורת</Link>
          <Link to="/reports" className="btn-secondary">דוחות וייצוא</Link>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, loading }: { title: string; value: number; loading: boolean }) {
  return (
    <div className="card">
      <div className="text-sm text-slate-500">{title}</div>
      <div className="text-3xl font-bold mt-2">{loading ? '—' : value}</div>
    </div>
  );
}
