import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function LoginPage() {
  const { session, signIn } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    // Supabase Auth stores the user with a synthetic email of
    // `<username>@gadhan.local`. The UI only shows/accepts the username.
    const email = `${username.trim().toLowerCase()}@gadhan.local`;
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) setError(error);
    else navigate('/', { replace: true });
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="card w-full max-w-md">
        <img src="/logo.png" alt="גדחה״ן רדיו" className="w-20 h-20 object-contain mx-auto mb-3" />
        <p className="text-sm text-slate-500 text-center mb-6">ניהול ציוד קשר</p>

        <label className="label" htmlFor="username">שם משתמש</label>
        <input
          id="username"
          type="text"
          autoComplete="username"
          className="input mb-4"
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
          required
          dir="ltr"
        />

        <label className="label" htmlFor="password">סיסמה</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="input mb-4"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? 'מתחבר...' : 'כניסה'}
        </button>
      </form>
    </div>
  );
}
