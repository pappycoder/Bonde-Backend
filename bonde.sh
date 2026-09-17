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
    printf '  %b  Quit\n\n' "$BOLD[q]$RESET"
    printf '%b> %b' "$GREEN" "$RESET"
    read -r choice
    case "$choice" in
      1) run_cmd "pnpm start:dev" ;;
      2) run_cmd "pnpm start:debug" ;;
      3) run_prod ;;
      4) build_prod ;;
      5) run_infra ;;
      q|Q) ok "Bye!"; exit 0 ;;
      *) warn "Invalid choice: $choice" ;;
    esac
    enter
  done
}

main