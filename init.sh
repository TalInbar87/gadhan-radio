#!/usr/bin/env bash
# init.sh — Interactive setup wizard for gadhan-radio.
# Run:   bash init.sh
# Safe to re-run — every step checks current state and skips accordingly.
#
# This script writes the following files:
#   .env                              — VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
#   .env.local                        — service_role_key + project_ref (gitignored)
#   supabase/config.toml              — project_id (local CLI identifier)
#   supabase/setup/cron-bootstrap.sql — generated with real values, ready to paste
#   vercel.json                       — already in repo (created on first run)

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# ─── colors ────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; BOLD=''; NC=''
fi

ok()    { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${NC}  %s\n" "$*"; }
err()   { printf "${RED}✗${NC} %s\n" "$*"; }
info()  { printf "${CYAN}ℹ${NC}  %s\n" "$*"; }
write() { printf "${YELLOW}✎${NC}  updated: %s\n" "$*"; }
step()  { printf "\n${BLUE}${BOLD}▸ %s${NC}\n" "$*"; printf "${BLUE}%s${NC}\n" "────────────────────────────────────────────────"; }

ask() {
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    printf "${BOLD}?${NC} %s [%s]: " "$prompt" "$default" >&2
  else
    printf "${BOLD}?${NC} %s: " "$prompt" >&2
  fi
  read -r reply
  echo "${reply:-$default}"
}

ask_required() {
  # Asks until a non-empty value is given.
  local prompt="$1" default="${2:-}" reply
  while true; do
    reply=$(ask "$prompt" "$default")
    if [ -n "$reply" ]; then
      echo "$reply"
      return
    fi
    err "Value cannot be empty. Try again." >&2
  done
}

ask_secret() {
  local prompt="$1" reply
  printf "${BOLD}?${NC} %s (hidden input): " "$prompt" >&2
  read -rs reply
  echo >&2
  echo "$reply"
}

ask_secret_required() {
  local prompt="$1" reply
  while true; do
    reply=$(ask_secret "$prompt")
    if [ -n "$reply" ]; then
      echo "$reply"
      return
    fi
    err "Value cannot be empty. Try again." >&2
  done
}

confirm() {
  local prompt="$1" default="${2:-y}" reply
  local hint="[Y/n]"; [ "$default" = "n" ] && hint="[y/N]"
  printf "${BOLD}?${NC} %s %s " "$prompt" "$hint" >&2
  read -r reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

pause() {
  printf "${BOLD}↵${NC}  Press Enter to continue..." >&2
  read -r
}

load_env_local() {
  if [ -f .env.local ]; then
    # shellcheck disable=SC1091
    set -a; source .env.local; set +a
  fi
}

# Default local identifier for supabase/config.toml. Must be a non-empty slug
# (lowercase letters, digits, hyphens). The CLI rejects empty values.
PROJECT_LOCAL_ID="gadhan-radio"

# ─── banner ────────────────────────────────────────────────
clear || true
cat <<'BANNER'
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║          gadhan-radio — interactive setup wizard           ║
║                                                            ║
║   We will walk through these steps:                        ║
║   1. Check dependencies                                    ║
║   2. npm install                                           ║
║   3. Configure Supabase + update .env / config.toml        ║
║   4. Run database migrations (schema + RLS + seed)         ║
║   5. Promote your first user to admin (via REST)           ║
║   6. (optional) Google Sheets export                       ║
║   7. (optional) Deploy to Vercel                           ║
║   8. Start the dev server                                  ║
║                                                            ║
║   This script edits real project files.                    ║
║   Safe to re-run — each step detects what's already done.  ║
╚════════════════════════════════════════════════════════════╝
BANNER

if ! confirm "Begin?"; then
  echo "Cancelled."
  exit 0
fi

load_env_local

# ───────────────────────────────────────────────────────────
# STEP 1 — dependencies
# ───────────────────────────────────────────────────────────
step "Step 1/8 — Check dependencies"

check_cmd() {
  local cmd="$1" install_hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd found ($(command -v "$cmd"))"
    return 0
  else
    err "$cmd not found. Install: $install_hint"
    return 1
  fi
}

MISSING=0
check_cmd node "https://nodejs.org or 'brew install node'" || MISSING=1
check_cmd npm  "bundled with node"                          || MISSING=1
check_cmd curl "built-in on macOS"                          || MISSING=1
check_cmd python3 "built-in on macOS (used to parse JSON)" || MISSING=1

if ! command -v supabase >/dev/null 2>&1; then
  warn "supabase CLI not found"
  if confirm "Install now? ('brew install supabase/tap/supabase')"; then
    if command -v brew >/dev/null 2>&1; then
      brew install supabase/tap/supabase || warn "Install failed — continuing without it"
    else
      warn "brew not found. We'll fall back to manual SQL editor for migrations."
    fi
  fi
fi
command -v supabase >/dev/null 2>&1 && ok "supabase CLI installed" || warn "Continuing without supabase CLI"

[ "$MISSING" = "1" ] && { err "Missing dependencies. Install them and re-run."; exit 1; }

# ───────────────────────────────────────────────────────────
# STEP 2 — npm install
# ───────────────────────────────────────────────────────────
step "Step 2/8 — Install npm packages"

if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok "node_modules already exists — skipping"
else
  info "Running npm install..."
  npm install || { err "npm install failed"; exit 1; }
  ok "Packages installed"
fi

# ───────────────────────────────────────────────────────────
# STEP 3 — Supabase + update files
# ───────────────────────────────────────────────────────────
step "Step 3/8 — Configure Supabase and update local files"

cat <<EOF

You need an existing Supabase project. If you don't have one:
  1. Go to ${BOLD}https://supabase.com/dashboard${NC} → New Project
  2. Pick a region (eu-central-1 is closest to IL), set a DB password, wait ~1 minute
  3. Settings ▸ API — grab the Project URL, anon key, and service_role key
  4. Settings ▸ General — copy the Reference ID

EOF

NEED_SUPA_INPUT=1
if [ -f .env ] && grep -q "VITE_SUPABASE_URL=https" .env 2>/dev/null \
   && [ -f .env.local ] && grep -q "^SUPABASE_SERVICE_ROLE_KEY=." .env.local 2>/dev/null \
   && grep -q "^SUPABASE_PROJECT_REF=." .env.local 2>/dev/null; then
  CURRENT_URL=$(grep "^VITE_SUPABASE_URL=" .env | cut -d= -f2-)
  ok "Found existing .env + .env.local"
  info "URL: $CURRENT_URL"
  if confirm "Re-enter all values?" n; then
    NEED_SUPA_INPUT=1
  else
    NEED_SUPA_INPUT=0
    load_env_local
    SUPA_URL="$VITE_SUPABASE_URL"
  fi
fi

if [ "$NEED_SUPA_INPUT" = "1" ]; then
  pause
  SUPA_URL=$(ask_required "Project URL (https://xxx.supabase.co)")
  SUPA_ANON=$(ask_required "anon public key")
  SUPA_SERVICE=$(ask_secret_required "service_role key (secret!)")

  # Auto-derive REF from URL when possible (xxx.supabase.co → xxx)
  DEFAULT_REF=$(echo "$SUPA_URL" | sed -E 's|https?://||; s|\.supabase\.co.*||')
  SUPA_REF=$(ask_required "Reference ID" "$DEFAULT_REF")

  # 1. .env (frontend, anon-safe)
  cat > .env <<EOF
# Auto-generated by init.sh
VITE_SUPABASE_URL=$SUPA_URL
VITE_SUPABASE_ANON_KEY=$SUPA_ANON
EOF
  write ".env"

  # 2. .env.local (setup-only, gitignored, chmod 600)
  cat > .env.local <<EOF
# Auto-generated by init.sh — DO NOT COMMIT
# Used by init.sh and other maintenance scripts. Vite does not load this file.
VITE_SUPABASE_URL=$SUPA_URL
VITE_SUPABASE_ANON_KEY=$SUPA_ANON
SUPABASE_SERVICE_ROLE_KEY=$SUPA_SERVICE
SUPABASE_PROJECT_REF=$SUPA_REF
EOF
  chmod 600 .env.local
  write ".env.local (chmod 600)"

  # 3. supabase/config.toml — keep a valid local slug. The CLI rejects empty values.
  if [ -f supabase/config.toml ]; then
    if grep -q '^project_id' supabase/config.toml; then
      sed -i.bak "s|^project_id = .*|project_id = \"$PROJECT_LOCAL_ID\"|" supabase/config.toml
      rm -f supabase/config.toml.bak
      write "supabase/config.toml (project_id = \"$PROJECT_LOCAL_ID\")"
    fi
  fi

  load_env_local
  ok "All files updated"
fi

# Defensive guard: even when re-using existing values, make sure config.toml has a
# valid project_id. We hit this once when an early run wrote it as empty.
if [ -f supabase/config.toml ]; then
  CURRENT_PID=$(grep '^project_id' supabase/config.toml | sed -E 's/.*= *"([^"]*)".*/\1/')
  if [ -z "$CURRENT_PID" ]; then
    warn "supabase/config.toml has empty project_id — fixing"
    sed -i.bak "s|^project_id = .*|project_id = \"$PROJECT_LOCAL_ID\"|" supabase/config.toml
    rm -f supabase/config.toml.bak
    write "supabase/config.toml (project_id = \"$PROJECT_LOCAL_ID\")"
  fi
fi

# ───────────────────────────────────────────────────────────
# STEP 4 — migrations
# ───────────────────────────────────────────────────────────
step "Step 4/8 — Run database migrations"

cat <<EOF

3 SQL files to apply:
  ${BOLD}0001_init.sql${NC}   — schema, enums, RLS policies, trigger
  ${BOLD}0002_seed.sql${NC}   — sample items and units
  ${BOLD}0003_cron.sql${NC}   — daily cron for Sheets export

Two ways: A) supabase CLI (automatic), B) Dashboard SQL Editor (manual).

EOF

# Generate cron-bootstrap with real values — paste-ready for SQL Editor.
mkdir -p supabase/setup
cat > supabase/setup/cron-bootstrap.sql <<EOF
-- Auto-generated by init.sh — DO NOT COMMIT (gitignored).
-- Run this once in the Supabase SQL Editor before applying 0003_cron.sql.
-- It registers the secrets pg_cron needs to call the Edge Function.

alter database postgres set "app.supabase_url" = '$SUPA_URL';
alter database postgres set "app.service_role_key" = '$SUPABASE_SERVICE_ROLE_KEY';
EOF
chmod 600 supabase/setup/cron-bootstrap.sql
write "supabase/setup/cron-bootstrap.sql (real values injected)"

if command -v supabase >/dev/null 2>&1; then
  echo
  echo "  Choose:"
  echo "    [1] CLI auto (link + db push) — needs DB password"
  echo "    [2] Manual (I'll print SQL paths to copy into the SQL Editor)"
  echo "    [3] Skip (already done)"
  CHOICE=$(ask "Choice" "1")
else
  echo "  CLI not installed — falling back to manual."
  CHOICE=2
fi

case "$CHOICE" in
  1)
    # Ensure we're logged in to Supabase first (separate from DB password).
    # `supabase projects list` exits non-zero with "Access token not provided" if not logged in.
    if ! supabase projects list >/dev/null 2>&1; then
      info "Not logged in to Supabase CLI. Running 'supabase login' (opens browser)..."
      if supabase login; then
        ok "Logged in"
      else
        err "Login failed"
        exit 1
      fi
    else
      ok "Already logged in to Supabase CLI"
    fi

    if [ ! -f .supabase-linked ] || ! supabase status >/dev/null 2>&1; then
      info "Linking project (will prompt for the database password)..."
      if supabase link --project-ref "$SUPABASE_PROJECT_REF"; then
        touch .supabase-linked
        ok "Linked"
      else
        err "Link failed"
      fi
    else
      ok "Already linked"
    fi
    info "Running supabase db push..."
    if supabase db push; then
      ok "Migrations applied"
    else
      err "db push failed — try manual"
    fi
    ;;
  2)
    info "Open the Supabase Dashboard ▸ SQL Editor and run, in order:"
    for f in 0001_init.sql 0002_seed.sql; do
      echo "    📄 $PROJECT_DIR/supabase/migrations/$f"
    done
    echo
    warn "Before running 0003_cron.sql:"
    echo "    1. Database ▸ Extensions ▸ enable ${BOLD}pg_cron${NC} + ${BOLD}pg_net${NC}"
    echo "    2. Run:  📄 $PROJECT_DIR/supabase/setup/cron-bootstrap.sql"
    echo "       (already populated with your real values — just copy/paste)"
    echo "    3. Run:  📄 $PROJECT_DIR/supabase/migrations/0003_cron.sql"
    pause
    ;;
  3) ok "Skipped" ;;
esac

# ───────────────────────────────────────────────────────────
# STEP 5 — Admin user (auto via REST)
# ───────────────────────────────────────────────────────────
step "Step 5/8 — Promote your first user to admin"

cat <<EOF

We'll use the service_role_key to:
  1. Find the user you created in Supabase Auth (by email)
  2. Update their profile to role=admin, active=true

First, create the user yourself:
  Dashboard ▸ Authentication ▸ Users ▸ ${BOLD}Add user${NC}
  → email + password + ${BOLD}check "Auto Confirm User"${NC}

EOF

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  err "SUPABASE_SERVICE_ROLE_KEY not loaded. Run step 3 first."
elif confirm "Did you create the user in Auth?"; then
  ADMIN_EMAIL=$(ask_required "User's email")
  ADMIN_NAME=$(ask "Display name" "Administrator")

  info "Looking up the user via Auth Admin API..."
  AUTH_JSON=$(curl -s -G "$SUPA_URL/auth/v1/admin/users" \
    --data-urlencode "filter=email.eq.$ADMIN_EMAIL" \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

  USER_ID=$(echo "$AUTH_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    users = d.get('users', d if isinstance(d, list) else [])
    for u in users:
        if u.get('email','').lower() == '$ADMIN_EMAIL'.lower():
            print(u['id']); break
except Exception:
    pass
" 2>/dev/null)

  if [ -z "$USER_ID" ]; then
    err "No user found with that email."
    warn "Make sure 'Auto Confirm' was checked and the email matches. SQL fallback:"
    cat <<EOF

${CYAN}update profiles
  set role='admin', active=true, full_name='${ADMIN_NAME}'
  where id = (select id from auth.users where email = '${ADMIN_EMAIL}');${NC}

EOF
  else
    ok "Found user_id: $USER_ID"
    info "Updating the profile..."
    UPDATE_RES=$(curl -s -w "\n%{http_code}" -X PATCH \
      "$SUPA_URL/rest/v1/profiles?id=eq.$USER_ID" \
      -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -H "Prefer: return=representation" \
      -d "{\"role\":\"admin\",\"active\":true,\"full_name\":\"$ADMIN_NAME\"}")
    HTTP_CODE=$(echo "$UPDATE_RES" | tail -1)
    BODY=$(echo "$UPDATE_RES" | sed '$d')

    if [ "$HTTP_CODE" = "200" ] && [ "$BODY" != "[]" ]; then
      ok "Admin configured — you can sign in now"
    elif [ "$HTTP_CODE" = "404" ] || [ "$BODY" = "[]" ]; then
      warn "Profile row doesn't exist yet (trigger didn't fire). Inserting..."
      INS_RES=$(curl -s -w "\n%{http_code}" -X POST \
        "$SUPA_URL/rest/v1/profiles" \
        -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Content-Type: application/json" \
        -H "Prefer: return=representation" \
        -d "{\"id\":\"$USER_ID\",\"role\":\"admin\",\"active\":true,\"full_name\":\"$ADMIN_NAME\"}")
      INS_CODE=$(echo "$INS_RES" | tail -1)
      if [ "$INS_CODE" = "201" ]; then
        ok "Admin profile created"
      else
        err "INSERT failed ($INS_CODE): $(echo "$INS_RES" | sed '$d')"
      fi
    else
      err "PATCH failed ($HTTP_CODE): $BODY"
    fi
  fi
else
  warn "Create the user later, then re-run ${BOLD}bash init.sh${NC} and skip to this step."
fi

# ───────────────────────────────────────────────────────────
# STEP 6 — Google Sheets export (optional)
# ───────────────────────────────────────────────────────────
step "Step 6/8 — Google Sheets export (optional)"

if confirm "Configure now?" n; then
  if ! command -v supabase >/dev/null 2>&1; then
    err "Need supabase CLI for this step. Skipping."
  else
    cat <<EOF

You need:
  - A Google Cloud service account with the Sheets API enabled
  - The downloaded JSON key (GCP ▸ IAM ▸ Service Accounts ▸ Keys)
  - A Google Sheet shared with the SA's client_email (Editor permission)

EOF
    SA_PATH=$(ask_required "Full path to the SA JSON file")
    if [ ! -f "$SA_PATH" ]; then
      err "File not found: $SA_PATH"
    else
      SHEET_ID=$(ask_required "Google Sheet ID (from URL between /d/ and /edit)")
      TAB_NAME=$(ask "Sheet tab name" "signings")

      info "Setting Supabase secrets..."
      supabase secrets set "GOOGLE_SERVICE_ACCOUNT_JSON=$(cat "$SA_PATH")" || warn "failed"
      supabase secrets set "GOOGLE_SHEET_ID=$SHEET_ID" || warn "failed"
      supabase secrets set "SHEET_TAB_NAME=$TAB_NAME" || warn "failed"
      ok "Secrets set"

      info "Deploying Edge Function..."
      if supabase functions deploy export-to-sheets; then
        ok "export-to-sheets deployed"
      else
        err "Deploy failed"
      fi
    fi
  fi
else
  info "Skipped. See ${BOLD}README → Google Sheets export${NC}"
fi

# ───────────────────────────────────────────────────────────
# STEP 7 — Vercel (optional)
# ───────────────────────────────────────────────────────────
step "Step 7/8 — Deploy to Vercel (optional)"

cat <<EOF

This step will:
  1. Install ${BOLD}vercel${NC} CLI if missing
  2. ${BOLD}vercel link${NC} — connect this folder to a project (new or existing)
  3. Set env vars (URL + ANON) for ${BOLD}Production / Preview / Development${NC}
  4. ${BOLD}vercel --prod${NC} — first build & deploy

You'll need a free Vercel account: https://vercel.com/signup

EOF

if confirm "Deploy to Vercel now?" n; then
  if [ ! -f vercel.json ]; then
    err "vercel.json missing — cannot continue"
  elif [ -z "${VITE_SUPABASE_URL:-}" ] || [ -z "${VITE_SUPABASE_ANON_KEY:-}" ]; then
    err "Supabase not configured. Run step 3 first."
  else
    if ! command -v vercel >/dev/null 2>&1; then
      info "Installing vercel CLI globally..."
      if npm install -g vercel; then
        ok "vercel installed"
      else
        err "Install failed. Try ${CYAN}sudo npm install -g vercel${NC} manually."
        warn "Skipping deploy step"
      fi
    fi

    if command -v vercel >/dev/null 2>&1; then
      if ! vercel whoami >/dev/null 2>&1; then
        info "Logging in to Vercel..."
        vercel login || { err "Login failed"; exit 1; }
      fi
      ok "Logged in as $(vercel whoami 2>/dev/null)"

      if [ ! -d .vercel ]; then
        info "Linking folder to a Vercel project (interactive)..."
        info "When prompted: 'Link to existing project?' → N (new project)"
        info "                'Project name?'              → default gadhan-radio"
        vercel link || { err "link failed"; exit 1; }
        ok "Linked"
      else
        ok "Already linked to Vercel"
      fi

      info "Setting env vars on Vercel..."
      for ENV_NAME in production preview development; do
        echo "$VITE_SUPABASE_URL" | vercel env add VITE_SUPABASE_URL "$ENV_NAME" --force 2>/dev/null \
          || echo "$VITE_SUPABASE_URL" | vercel env add VITE_SUPABASE_URL "$ENV_NAME" 2>/dev/null \
          || true
        echo "$VITE_SUPABASE_ANON_KEY" | vercel env add VITE_SUPABASE_ANON_KEY "$ENV_NAME" --force 2>/dev/null \
          || echo "$VITE_SUPABASE_ANON_KEY" | vercel env add VITE_SUPABASE_ANON_KEY "$ENV_NAME" 2>/dev/null \
          || true
      done
      ok "Env vars set for production/preview/development"

      if confirm "Deploy to production now? (takes 1-2 minutes)" y; then
        info "Running vercel --prod..."
        vercel --prod
        ok "Deploy finished — URL printed above"
      else
        info "Manual: ${CYAN}vercel --prod${NC} or ${CYAN}vercel${NC} for preview"
      fi

      VERCEL_URL=$(vercel ls --json 2>/dev/null | python3 -c "
import sys, json
try:
  data = json.load(sys.stdin)
  d = data[0] if isinstance(data, list) and data else None
  if d: print(d.get('url',''))
except: pass
" 2>/dev/null)

      cat <<EOF

${YELLOW}${BOLD}Important — required after first deploy:${NC}
  1. Supabase Dashboard ▸ Authentication ▸ URL Configuration
  2. Add the Vercel URL to ${BOLD}Site URL${NC} and ${BOLD}Redirect URLs${NC}:
EOF
      if [ -n "$VERCEL_URL" ]; then
        echo "       https://$VERCEL_URL"
      else
        echo "       (the URL printed by 'vercel --prod')"
      fi
      echo "  Otherwise login won't work in production."
      echo
    fi
  fi
else
  info "Skipped. Anytime: ${CYAN}vercel${NC} (preview) or ${CYAN}vercel --prod${NC}"
fi

# ───────────────────────────────────────────────────────────
# STEP 8 — done
# ───────────────────────────────────────────────────────────
step "Step 8/8 — Done"

cat <<EOF

${GREEN}${BOLD}All set! 🎉${NC}

Files updated:
  ✎ .env
  ✎ .env.local                       (secret, gitignored)
  ✎ supabase/config.toml             (project_id)
  ✎ supabase/setup/cron-bootstrap.sql (gitignored, ready to paste)
  ✎ vercel.json                      (SPA rewrites for React Router)
  ✎ .vercel/                         (project mapping, gitignored)

Next:
  • dev:        ${CYAN}npm run dev${NC}
  • build:      ${CYAN}npm run build${NC}
  • redeploy:   ${CYAN}vercel --prod${NC}
  • git push:   commit everything except ${BOLD}.env*${NC} and ${BOLD}.vercel/${NC}

EOF

if confirm "Start npm run dev now?" y; then
  info "http://localhost:5173 — Ctrl+C to stop"
  exec npm run dev
fi

ok "Manual start: npm run dev"
