import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const navItems = [
  { to: '/', label: 'בית', end: true },
  { to: '/sign', label: 'החתמה חדשה' },
  { to: '/soldiers', label: 'חיילים' },
  { to: '/logs', label: 'יומן ביקורת' },
];
const reportsChildren = [
  { to: '/reports', label: 'ייצוא דוחות' },
  { to: '/signings', label: 'כל ההחתמות' },
];
const adminItems = [
  { to: '/unit-sign', label: 'החתמת מסגרת' },
  { to: '/unit-signings', label: 'החתמות מסגרות' },
  { to: '/unit-stock', label: 'דוח מלאי מסגרות' },
  { to: '/items', label: 'ניהול פריטים' },
  { to: '/soldiers-import', label: 'ייבוא חיילים' },
  { to: '/users', label: 'ניהול משתמשים' },
];

export default function Layout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = profile?.role === 'admin';
  const reportsActive = reportsChildren.some((c) => location.pathname.startsWith(c.to));
  const [reportsOpen, setReportsOpen] = useState(reportsActive);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close drawer on route change.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  return (
    <div className="min-h-screen md:flex">
      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between bg-slate-900 text-slate-100 px-4 py-3">
        <button
          type="button"
          aria-label="פתח תפריט"
          onClick={() => setDrawerOpen(true)}
          className="p-2 -m-2 rounded-lg hover:bg-slate-800"
        >
          <span className="block w-6 h-0.5 bg-current mb-1.5"></span>
          <span className="block w-6 h-0.5 bg-current mb-1.5"></span>
          <span className="block w-6 h-0.5 bg-current"></span>
        </button>
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="גדחה״ן רדיו" className="w-8 h-8 object-contain rounded" />
          <span className="text-sm">גדחה״ן רדיו</span>
        </div>
      </header>

      {/* Drawer backdrop (mobile only, when open) */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`
          bg-slate-900 text-slate-100 flex flex-col
          fixed inset-y-0 right-0 w-64 z-50 transform transition-transform
          ${drawerOpen ? 'translate-x-0' : 'translate-x-full'}
          md:static md:translate-x-0 md:w-60 md:z-auto
        `}
      >
        <div className="px-5 py-5 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="גדחה״ן רדיו" className="w-10 h-10 object-contain rounded" />
            <p className="text-xs text-slate-400">ניהול ציוד קשר</p>
          </div>
          <button
            type="button"
            aria-label="סגור תפריט"
            onClick={() => setDrawerOpen(false)}
            className="md:hidden text-slate-400 hover:text-white text-2xl leading-none px-2"
          >
            ×
          </button>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-lg px-3 py-2 text-sm transition ${
                  isActive ? 'bg-emerald-600 text-white' : 'hover:bg-slate-800'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}

          <div>
            <button
              type="button"
              onClick={() => setReportsOpen((v) => !v)}
              className={`w-full flex items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                reportsActive ? 'bg-emerald-600 text-white' : 'hover:bg-slate-800'
              }`}
            >
              <span>דוחות</span>
              <span className="text-xs">{reportsOpen ? '▾' : '◂'}</span>
            </button>
            {reportsOpen && (
              <div className="mt-1 mr-3 space-y-1">
                {reportsChildren.map((c) => (
                  <NavLink
                    key={c.to}
                    to={c.to}
                    className={({ isActive }) =>
                      `block rounded-lg px-3 py-1.5 text-xs transition ${
                        isActive ? 'bg-emerald-700 text-white' : 'text-slate-300 hover:bg-slate-800'
                      }`
                    }
                  >
                    {c.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>

          {isAdmin && (
            <>
              <div className="pt-3 mt-3 border-t border-slate-800 text-xs text-slate-500 px-3 mb-1">
                מנהל מערכת
              </div>
              {adminItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `block rounded-lg px-3 py-2 text-sm transition ${
                      isActive ? 'bg-emerald-600 text-white' : 'hover:bg-slate-800'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>
        <div className="px-4 py-4 border-t border-slate-800 text-sm">
          <div className="font-medium">{profile?.full_name}</div>
          <div className="text-xs text-slate-400 mb-3">
            {profile?.role === 'admin' ? 'מנהל מערכת' : 'רס"פ'}
          </div>
          <button
            onClick={async () => {
              await signOut();
              navigate('/login', { replace: true });
            }}
            className="text-xs text-slate-300 hover:text-white"
          >
            התנתק
          </button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
