#!/usr/bin/env bash
# =============================================================================
# Bonde Backend — interactive build / run helper (NestJS + pnpm).
#   Usage:  ./bonde.sh          (run from anywhere in this repo)
# =============================================================================
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RESET=$'\033[0m'
BOLD=$'\033[1m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
CYAN=$'\033[36m'
RED=$'\033[31m'
DIM=$'\033[2m'

title() { printf '\n%b%b%s%b\n\n' "$BOLD$CYAN" "== " "$1" "$RESET"; }
info()  { printf '%b   %b\n' "$CYAN"   "$1$RESET"; }
ok()    { printf '%b   %b\n' "$GREEN"  "$1$RESET"; }
warn()  { printf '%b   %b\n' "$YELLOW" "$1$RESET"; }
fail()  { printf '%b   %b\n' "$RED"    "$1$RESET"; }
dim()   { printf '%b   %b\n' "$DIM"    "$1$RESET"; }

die()   { fail "$1"; exit 1; }

on_int() { printf '%b\n' "${RESET}${YELLOW}   Interrupted.${RESET}"; exit 130; }
trap on_int INT

require() { command -v "$1" >/dev/null 2>&1 || die "Missing required tool: '$1'"; }

enter() { printf '\n%b' "$DIM   Press Enter to continue$RESET"; read -r _; }

run_cmd() {
  local cmd="$1"
  printf '\n%b   $ %b\n' "$GREEN" "$cmd$RESET"
  eval "$cmd"
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "Finished OK."
  else
    fail "Command exited $rc."
  fi
  return "$rc"
}

# --- actions -----------------------------------------------------------------
load_env() {
  local env_file="$PROJECT_DIR/.env"
  [ -f "$env_file" ] || return 0
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      \#*|'') continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      PORT|PUBLIC_URL|SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)
        [ -n "${!key+x}" ] || export "$key=$value"
        ;;
    esac
  done < "$env_file"
}

register_superuser() {
  require curl jq
  load_env

  local base="${PUBLIC_URL:-http://localhost:${PORT:-3001}}"
  local supa_url="${SUPABASE_URL:-}"
  supa_url="${supa_url%/}"
  if [ -z "$supa_url" ] || [ -z "${SUPABASE_ANON_KEY:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    die "Register superuser needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in .env."
  fi

  local email password full_name role
  printf '%b   Email: %b' "$CYAN" "$RESET"
  read -r email
  email=$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]' | xargs)
  case "$email" in
    *@*) ;;
    *) die "Invalid email address." ;;
  esac

  printf '%b   Password (min 6 chars): %b' "$CYAN" "$RESET"
  read -rs password; printf '\n'
  [ "${#password}" -ge 6 ] || die "Password must be at least 6 characters."

  printf '%b   Full name [%s]: %b' "$CYAN" "${email%%@*}" "$RESET"
  read -r full_name
  full_name="${full_name:-${email%%@*}}"

  printf '%b   Role [SUPER_ADMIN|ADMIN] (default SUPER_ADMIN): %b' "$CYAN" "$RESET"
  read -r role
  role="${role:-SUPER_ADMIN}"
  case "$role" in
    SUPER_ADMIN|ADMIN) ;;
    *) die "Role must be SUPER_ADMIN or ADMIN." ;;
  esac

  title "Registering superuser $email ($role)"

  local out code body
  out=$(curl -sS -m 15 -w $'\n%{http_code}' -X POST "$base/api/auth/register" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg email "$email" --arg password "$password" --arg fullName "$full_name" \
      '{ email: $email, password: $password, fullName: $fullName }')")
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [ "$code" = "000" ]; then
    die "Could not reach $base — is the backend running? (pnpm start:dev)"
  fi
  case "$code" in
    201) ok "Account created." ;;
    409) warn "Account already exists — promoting the existing user." ;;
    *)
      die "Register failed (HTTP $code): $(printf '%s' "$body" | jq -r '(.message | if type=="array" then .[0] else . end) // "unknown error"' 2>/dev/null)"
      ;;
  esac

  local supa admin_headers supa_id="" found page=1 current user_meta new_meta put
  supa="$supa_url/auth/v1"
  admin_headers=( -H "apikey: $SUPABASE_ANON_KEY" -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" )
  while [ -z "$supa_id" ] && [ "$page" -le 50 ]; do
    current=$(curl -sS -m 15 -X GET "$supa/admin/users?page=$page&per_page=200" "${admin_headers[@]}")
    supa_id=$(printf '%s' "$current" | jq -r --arg e "$email" '[.[] | select(.email == $e)] | .[0].id // empty')
    page=$((page + 1))
  done
  [ -n "$supa_id" ] || die "Could not find $email in Supabase Auth."

  found=$(curl -sS -m 15 -X GET "$supa/admin/users/$supa_id" "${admin_headers[@]}")
  user_meta=$(printf '%s' "$found" | jq -c '.app_metadata // {}')
  new_meta=$(printf '%s' "$user_meta" | jq -c --arg role "$role" '. + { role: $role }')
  put=$(jq -nc --argjson am "$new_meta" '{ email_confirm: true, app_metadata: $am }')

  out=$(curl -sS -m 15 -w $'\n%{http_code}' -X PUT "$supa/admin/users/$supa_id" \
    -H 'content-type: application/json' "${admin_headers[@]}" -d "$put")
  code="${out##*$'\n'}"
  [ "$code" = "200" ] || die "Failed to promote user (HTTP $code): $(printf '%s' "${out%$'\n'*}" | jq -r '.msg // "unknown error"' 2>/dev/null)"
  ok "Email confirmed and role '$role' set in Supabase Auth."

  info "Verifying login against $base ..."
  out=$(curl -sS -m 15 -w $'\n%{http_code}' -X POST "$base/api/auth/login" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg email "$email" --arg password "$password" '{ email: $email, password: $password }')")
  code="${out##*$'\n'}"
  if [ "$code" != "200" ]; then
    die "Login check failed (HTTP $code): $(printf '%s' "${out%$'\n'*}" | jq -r '.message // "unknown error"' 2>/dev/null)"
  fi

  local token me
  token=$(printf '%s' "${out%$'\n'*}" | jq -r '.accessToken // empty')
  if [ -n "$token" ]; then
    me=$(curl -sS -m 15 -X GET "$base/api/auth/me" -H "authorization: Bearer $token")
    code=$(printf '%s' "$me" | jq -r '.role // empty')
    if [ "$code" = "$role" ]; then
      ok "Logged in as $email — role confirmed: $role."
    else
      warn "Logged in but role is '$code' (expected '$role')."
    fi
  fi

  dim "Note: email was confirmed via the Supabase Auth Admin API (no emailed OTP)."
  dim "profiles.emailVerified stays false and no account/wallet is provisioned — irrelevant for admin endpoints."
}

run_prod() {
  if [ ! -d "$PROJECT_DIR/dist" ]; then
    warn "No production build found (missing dist/). 'pnpm start:prod' needs one."
    printf '%b   Build now? [Y/n]: %b' "$YELLOW" "$RESET"
    read -r ans
    case "${ans:-y}" in
      y|Y|'') run_cmd "pnpm build" ;;
      *)      warn "Skipping build — 'pnpm start:prod' will likely fail." ;;
    esac
  fi
  run_cmd "pnpm start:prod"
}

build_prod() {
  run_cmd "pnpm build"
}

run_infra() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found — start Redis/Postgres another way."
    return 1
  fi
  dim "Starts Redis (:6379) and local Postgres (:5433) from docker-compose.yml."
  run_cmd "docker compose up -d redis postgres"
}

# --- menu --------------------------------------------------------------------
main() {
  require pnpm
  cd "$PROJECT_DIR" || die "Cannot enter $PROJECT_DIR"

  while true; do
    title "Bonde Backend — build / run helper"
    printf '  %b  Run dev (watch)            %b\n' "$BOLD[1]$RESET" "$DIM pnpm start:dev$RESET"
    printf '  %b  Run dev with debugger      %b\n' "$BOLD[2]$RESET" "$DIM pnpm start:debug$RESET"
    printf '  %b  Run production             %b\n' "$BOLD[3]$RESET" "$DIM pnpm start:prod$RESET"
    printf '  %b  Build                      %b\n' "$BOLD[4]$RESET" "$DIM pnpm build$RESET"
    printf '  %b  Start infra (Redis + Postgres)%b\n' "$BOLD[5]$RESET" "$DIM docker compose up -d redis postgres$RESET"
    printf '  %b  Register superuser (Supabase)%b\n' "$BOLD[6]$RESET" "$DIM create Supabase-auth user with app_metadata.role$RESET"
    printf '  %b  Quit\n\n' "$BOLD[q]$RESET"
    printf '%b> %b' "$GREEN" "$RESET"
    read -r choice
    case "$choice" in
      1) run_cmd "pnpm start:dev" ;;
      2) run_cmd "pnpm start:debug" ;;
      3) run_prod ;;
      4) build_prod ;;
      5) run_infra ;;
      6) register_superuser ;;
      q|Q) ok "Bye!"; exit 0 ;;
      *) warn "Invalid choice: $choice" ;;
    esac
    enter
  done
}

main