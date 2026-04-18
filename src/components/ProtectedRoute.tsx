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
  const { session, profile, loading, profileError, refreshProfile, signOut } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        טוען...
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace />;
  if (!profile) {
    // Session exists but profile failed to load (RLS / network / row missing).
    // Don't show "user not active" — that's misleading. Show the real error + retry.
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="card max-w-md text-center">
          <h2 className="text-lg font-semibold mb-2">לא הצלחנו לטעון את הפרופיל</h2>
          {profileError && (
            <p className="text-xs text-red-600 mb-3 break-all">{profileError}</p>
          )}
          <p className="text-slate-600 text-sm mb-4">
            בדוק שיש לך רשומה ב-profiles ושההרשאות תקינות, או נסה להיכנס מחדש.
          </p>
          <div className="flex gap-2 justify-center">
            <button onClick={() => refreshProfile()} className="btn-secondary text-sm">נסה שוב</button>
            <button onClick={async () => { await signOut(); window.location.href = '/login'; }} className="btn-primary text-sm">התנתק</button>
          </div>
        </div>
      </div>
    );
  }
  if (!profile.active) {
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
