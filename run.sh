#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN='\033[38;5;84m'; YELLOW='\033[38;5;220m'; RESET='\033[0m'
else
  GREEN=''; YELLOW=''; RESET=''
fi

ok()   { printf "%b● %-10s%b %s\n" "$GREEN" "runner" "$RESET" "$1"; }
warn() { printf "%b▲ %-10s%b %s\n" "$YELLOW" "runner" "$RESET" "$1"; }

export ZALO_TG_RUNNER=1
UPDATE_REMOTE="${ZALO_TG_UPDATE_REMOTE:-origin}"
UPDATE_BRANCH="${ZALO_TG_UPDATE_BRANCH:-main}"

while true; do
  if [ ! -f dist/index.js ]; then
    warn "dist missing · building"
    npm run build || exit 1
  fi
  node --disable-warning=DEP0205 dist/index.js
  EXIT_CODE=$?

  if [ "$EXIT_CODE" = "43" ]; then
    warn "restart requested (code 43)"
    continue
  fi

  if [ "$EXIT_CODE" = "42" ]; then
    warn "update requested (code 42)"
    
    warn "updating · git pull $UPDATE_REMOTE $UPDATE_BRANCH"
    git pull --autostash "$UPDATE_REMOTE" "$UPDATE_BRANCH"
    if [ $? -ne 0 ]; then
      warn "git pull failed · update aborted"
      exit 1
    fi

    warn "updating · installing dependencies"
    npm install --production=false
    if [ $? -ne 0 ]; then
      warn "npm install failed · update aborted"
      exit 1
    fi

    warn "updating · building application"
    npm run build
    if [ $? -ne 0 ]; then
      warn "build failed · update aborted"
      exit 1
    fi

    ok "update complete · restarting"
    continue
  fi

  warn "bridge exited with code $EXIT_CODE · stopping"
  break
done
