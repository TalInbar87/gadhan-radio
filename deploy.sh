#!/usr/bin/env bash
# deploy.sh — one-shot deploy for gadhan-radio.
#
# The Vercel project is linked to GitHub: pushing to `main` triggers an
# automatic production deploy. This script handles everything else.
#
# What it does, in order:
#   1. Sanity check (tools + working dir).
#   2. Local typecheck + production build (fails fast if broken).
#   3. Push new Supabase migrations (DB schema).
#   4. Deploy Supabase Edge Functions (export-to-sheets, manage-users).
#   5. Commit & push to git → triggers Vercel auto-deploy.
#
# Usage:
#   bash deploy.sh                # interactive (asks before each step)
#   bash deploy.sh --yes          # non-interactive — runs everything
#   bash deploy.sh --skip-supabase
#
# Flags:
#   --yes              Don't ask, just do every step.
#   --skip-build       Skip local build check.
#   --skip-supabase    Skip db push + functions deploy.
#   --skip-git         Skip git commit/push (no Vercel deploy will happen).
#   --message "..."    Custom commit message (default: timestamped).

set -e
cd "$(dirname "$0")"

# ──────────────────────────── colors ────────────────────────────
if [[ -t 1 ]]; then
  C_RST=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_CYN=$'\033[36m'
else
  C_RST=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GRN=''; C_YEL=''; C_CYN=''
fi
say()  { printf "%s\n" "$*"; }
hdr()  { printf "\n${C_BOLD}${C_CYN}▸ %s${C_RST}\n" "$*"; }
ok()   { printf "  ${C_GRN}✓${C_RST} %s\n" "$*"; }
warn() { printf "  ${C_YEL}⚠${C_RST} %s\n" "$*"; }
err()  { printf "  ${C_RED}✗${C_RST} %s\n" "$*" >&2; }

# ──────────────────────────── flags ─────────────────────────────
YES=0
SKIP_BUILD=0
SKIP_SUPABASE=0
SKIP_GIT=0
COMMIT_MSG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)         YES=1 ;;
    --skip-build)     SKIP_BUILD=1 ;;
    --skip-supabase)  SKIP_SUPABASE=1 ;;
    --skip-git)       SKIP_GIT=1 ;;
    --message|-m)     shift; COMMIT_MSG="$1" ;;
    -h|--help)
      sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) err "Unknown flag: $1"; exit 1 ;;
  esac
  shift
done

confirm() {
  [[ $YES -eq 1 ]] && return 0
  local prompt="$1"
  read -r -p "  ${prompt} [Y/n] " ans
  [[ -z "$ans" || "$ans" =~ ^[Yy]$ ]]
}

# ──────────────────── 1. tool/working-dir check ─────────────────
hdr "Sanity check"

[[ -f package.json && -f vercel.json ]] || { err "Run from the gadhan-radio root."; exit 1; }
ok "Working directory looks right"

need() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing tool: $1"; MISSING=1; }
}
MISSING=0
need npm
need git
[[ $SKIP_SUPABASE -eq 0 ]] && need supabase
[[ $MISSING -eq 1 ]] && { err "Install missing tools and retry."; exit 1; }
ok "All required CLIs installed"

# ──────────────────────── 2. local build ────────────────────────
if [[ $SKIP_BUILD -eq 0 ]]; then
  hdr "Local build (tsc + vite build)"
  if confirm "Run production build to catch errors before pushing?"; then
    if npm run build >/tmp/gadhan-build.log 2>&1; then
      ok "Build succeeded"
    else
      err "Build failed. Tail of log:"
      tail -30 /tmp/gadhan-build.log
      exit 1
    fi
  else
    warn "Build skipped"
  fi
fi

# ──────────────────── 3. supabase: db + funcs ───────────────────
if [[ $SKIP_SUPABASE -eq 0 ]]; then
  hdr "Supabase migrations"
  if confirm "Push pending migrations to remote DB?"; then
    if echo "Y" | supabase db push 2>&1 | tee /tmp/gadhan-dbpush.log | tail -5; then
      ok "Migrations pushed"
    else
      err "supabase db push failed"; exit 1
    fi
  else
    warn "Migrations skipped"
  fi

  hdr "Edge Functions"
  for fn in export-to-sheets manage-users; do
    if [[ -d "supabase/functions/$fn" ]]; then
      if confirm "Deploy function '$fn'?"; then
        if supabase functions deploy "$fn" 2>&1 | tail -3; then
          ok "$fn deployed"
        else
          err "Deploy failed for $fn"; exit 1
        fi
      else
        warn "Skipped $fn"
      fi
    fi
  done
fi

# ────────────────────────── 4. git → Vercel ─────────────────────
if [[ $SKIP_GIT -eq 0 ]]; then
  hdr "Git commit & push (triggers Vercel auto-deploy)"
  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short | sed 's/^/    /'
    if confirm "Commit and push these changes?"; then
      [[ -z "$COMMIT_MSG" ]] && COMMIT_MSG="deploy: $(date '+%Y-%m-%d %H:%M')"
      git add -A
      git commit -m "$COMMIT_MSG"
      git push
      ok "Pushed: $COMMIT_MSG"
      ok "Vercel will auto-deploy from GitHub — check the dashboard for status"
    else
      warn "Git skipped — Vercel will not deploy"
    fi
  else
    ok "Working tree clean — nothing to push"
    say "  ${C_DIM}(no Vercel deploy triggered; nothing changed)${C_RST}"
  fi
fi

hdr "Done"
ok "All requested steps completed."
