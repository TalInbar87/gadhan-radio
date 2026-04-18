# גדח״ן רדיו — מערכת ניהול ציוד קשר

מערכת ווב לניהול החתמה ושליטה במכשירי קשר ופריטים נילווים.

**Stack:** Vite + React + TypeScript + Tailwind, Supabase (Postgres + Auth + Edge Functions), ייצוא ל-Google Sheets.

---

## פיצ'רים

- ✅ טופס החתמה ייעודי (פרטי חייל + פריטים בכמויות)
- ✅ הוספת פריטים חדשים למערכת
- ✅ זיכויים ובדיקות (אותו טופס, סוג פעולה שונה)
- ✅ יומן ביקורת מלא (מי, מה, מתי, מול מי)
- ✅ הרשאות:
  - **מנהל מערכת** — גישה מלאה לכל הנתונים והפעולות
  - **רס"פ** — משוייך למסגרת אחת בלבד; רואה ומבצע רק בה
- ✅ ייצוא יומי אוטומטי ל-Google Sheets (cron) + כפתור "ייצא עכשיו"
- ✅ ייצוא CSV מקומי

---

## מבנה

```
src/
├── components/
│   ├── Layout.tsx         # סייד-בר + ראוטר
│   └── ProtectedRoute.tsx # שמירת נתיבים לפי auth + role
├── lib/
│   ├── auth.tsx           # AuthContext (Supabase session + profile)
│   ├── supabase.ts        # Supabase client
│   ├── audit.ts           # logAudit() helper
│   └── database.types.ts  # טיפוסים לסכמה
├── pages/
│   ├── LoginPage.tsx
│   ├── DashboardPage.tsx
│   ├── SignFormPage.tsx   # הטופס הראשי
│   ├── SoldiersPage.tsx
│   ├── ItemsPage.tsx      # admin only
│   ├── LogsPage.tsx
│   ├── UsersPage.tsx      # admin only
│   └── ReportsPage.tsx
└── App.tsx

supabase/
├── config.toml
├── migrations/
│   ├── 0001_init.sql      # סכמה + RLS
│   ├── 0002_seed.sql      # פריטים + מסגרות לדוגמה
│   └── 0003_cron.sql      # cron יומי לייצוא
└── functions/
    └── export-to-sheets/
        └── index.ts       # Edge Function
```

---

## Setup — מהיר (מומלץ)

```bash
bash init.sh
```

הסקריפט ידריך אותך אינטראקטיבית בכל השלבים: בדיקת תלויות, התקנה, `.env`, מיגרציות, יצירת admin, ייצוא Sheets, והפעלת dev server. בטוח להריץ שוב — כל שלב בודק מה כבר נעשה.

---

## Setup — ידני, שלב אחר שלב

### 1. צור פרויקט Supabase

1. https://supabase.com → New project
2. שמור: Project URL + `anon key` + `service_role key`

### 2. הרץ את ה-Migrations

ב-Supabase Dashboard ▸ SQL Editor — הדבק והרץ בסדר:

1. `supabase/migrations/0001_init.sql`
2. `supabase/migrations/0002_seed.sql`
3. `supabase/migrations/0003_cron.sql` (אחרי שהפעלת `pg_cron` + `pg_net` ב-Database ▸ Extensions, ואחרי שעדכנת את ה-`alter database` לפי ההוראות בקובץ)

או דרך ה-CLI:

```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 3. צור משתמש Admin ראשון

1. Dashboard ▸ Authentication ▸ Users ▸ Add user → email + password
2. ב-SQL editor:

```sql
update profiles
  set role = 'admin', active = true, full_name = 'מנהל מערכת'
  where id = (select id from auth.users where email = 'admin@example.com');
```

### 4. הרץ את הפרונט

```bash
cp .env.example .env
# מלא:  VITE_SUPABASE_URL  ו-VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

נכנסים ל-http://localhost:5173 ומתחברים.

---

## ייצוא ל-Google Sheets

### חד-פעמי: יצירת service account

1. https://console.cloud.google.com → New project (אם אין)
2. APIs & Services ▸ Library ▸ הפעל **Google Sheets API**
3. APIs & Services ▸ Credentials ▸ Create Credentials ▸ **Service Account**
4. בתוך ה-service account: Keys ▸ Add Key ▸ **JSON** → הורד את הקובץ
5. צור Google Sheet חדש → שתף עם ה-`client_email` של ה-service account עם **Editor** permissions
6. שמור את ה-Sheet ID (החלק מה-URL: `docs.google.com/spreadsheets/d/<SHEET_ID>/edit`)

### פריסת ה-Edge Function

```bash
supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat path/to/sa.json)"
supabase secrets set GOOGLE_SHEET_ID="YOUR_SHEET_ID"
supabase secrets set SHEET_TAB_NAME="signings"   # אופציונלי

supabase functions deploy export-to-sheets
```

### בדיקה ידנית

מתוך הממשק: דוחות ▸ "ייצא עכשיו ל-Sheets".
או דרך CLI:

```bash
curl -X POST "https://YOUR.supabase.co/functions/v1/export-to-sheets" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

### Cron יומי

הוגדר ב-`0003_cron.sql` ב-00:00 UTC (= 03:00 ישראל).
לבדיקת ה-cron:

```sql
select * from cron.job;
select * from cron.job_run_details order by start_time desc limit 10;
```

---

## הרשאות (RLS)

| טבלה | admin | raspar |
|------|-------|--------|
| `units` | קריאה+כתיבה | קריאה |
| `profiles` | קריאה+כתיבה לכולם | קריאה של עצמו בלבד |
| `soldiers` | הכל | קריאה + כתיבה במסגרת שלו |
| `items` | הכל | קריאה |
| `signings` | הכל | קריאה במסגרת + יצירה במסגרת |
| `signing_items` | הכל | קריאה+יצירה דרך parent signing |
| `audit_logs` | קריאה לכולם | קריאה של פעולות עצמו |

המדיניות נאכפת ברמת ה-DB דרך RLS — בלתי אפשרי לעקוף מהפרונט גם אם משנים את הקוד.

---

## פיתוח

```bash
npm run dev          # שרת dev
npm run build        # build production (tsc + vite)
npm run lint
```

### הוספת action חדש

1. הוסף עמודות/טבלה ב-migration חדש (`0004_*.sql`)
2. עדכן את `src/lib/database.types.ts`
3. הוסף RLS policy לפי הצורך
4. בנה דף/קומפוננטה
5. תמיד תעטוף פעולות משמעותיות ב-`logAudit({...})`

---

## פריסה (Deploy)

מומלץ Vercel:

```bash
npm i -g vercel
vercel
# הגדר את משתני הסביבה: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

---

## הבדלים מהמערכת הישנה (gadhan)

| היבט | gadhan ישן | gadhan-radio |
|------|-----------|--------------|
| Backend | Google Apps Script | Supabase (Postgres) |
| Auth | Sheets-based custom | Supabase Auth + JWT |
| הרשאות | בקוד | RLS policies בDB |
| Frontend | HTML + vanilla JS | Vite + React + TS |
| Storage | Google Sheets | Postgres + ייצוא לSheets |
| Schema changes | ידני | migrations |
