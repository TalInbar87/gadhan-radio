import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';

export default function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const { session, profile, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        טוען...
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  if (!profile?.active) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="card max-w-md text-center">
          <h2 className="text-lg font-semibold mb-2">משתמש לא פעיל</h2>
          <p className="text-slate-600 text-sm">
            המשתמש שלך טרם הופעל על ידי מנהל המערכת. פנה למנהל לשיוך מסגרת והפעלה.
          </p>
        </div>
      </div>
    );
  }
  if (requireAdmin && profile.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
