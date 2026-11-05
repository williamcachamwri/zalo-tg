#!/usr/bin/env sh
set -eu

APP_NAME="zalo-tg"
APP_VERSION="1.0.0"
MIN_NODE="20.11.0"
MIN_GO="1.24.0"
REPO_URL="${ZALO_TG_REPO:-https://github.com/leolionart/zalo-tg.git}"
RAW_INSTALL_URL="https://raw.githubusercontent.com/leolionart/zalo-tg/main/install.sh"
CALL_DIR=$(pwd)
DEFAULT_INSTALL_DIR="$CALL_DIR/$APP_NAME"
INSTALL_DIR="${ZALO_TG_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"

ASSUME_YES=0
DRY_RUN=0
SKIP_NPM=0
SKIP_TUI=0
SKIP_ENV=0
RUN_CHECK=0

if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  RESET="$(printf '\033[0m')"
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  BLUE="$(printf '\033[34m')"
  MAGENTA="$(printf '\033[35m')"
  CYAN="$(printf '\033[36m')"
  WHITE="$(printf '\033[37m')"
else
  RESET="" BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" MAGENTA="" CYAN="" WHITE=""
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-npm) SKIP_NPM=1 ;;
    --skip-tui) SKIP_TUI=1 ;;
    --skip-env) SKIP_ENV=1 ;;
    --check) RUN_CHECK=1 ;;
    --dir)
      shift
      if [ "$#" -eq 0 ]; then
        printf '%s\n' "${RED}Missing value for --dir${RESET}" >&2
        exit 2
      fi
      INSTALL_DIR=$1
      ;;
    --repo)
      shift
      if [ "$#" -eq 0 ]; then
        printf '%s\n' "${RED}Missing value for --repo${RESET}" >&2
        exit 2
      fi
      REPO_URL=$1
      ;;
    -h|--help)
      cat <<EOF
${APP_NAME} installer

Usage:
  sh install.sh [options]
  curl -fsSL ${RAW_INSTALL_URL} | sh
  curl -fsSL ${RAW_INSTALL_URL} | sh -s -- --yes

Options:
  -y, --yes       Accept default choices
  --dry-run       Show what would run without changing files
  --dir <path>    Install/checkout directory for curl installs
                  Default: ${INSTALL_DIR}
  --repo <url>    Git repository to clone
                  Default: ${REPO_URL}
  --skip-npm      Skip npm dependency install
  --skip-tui      Skip Go/Charmbracelet TUI build
  --skip-env      Skip .env configuration wizard
  --check         Run npm run check after install
  -h, --help      Show this help

Behavior:
  The installer auto-runs default actions without waiting for y/n confirmation.
  It still asks for .env values when a terminal is available. Use --yes to also
  accept default .env values without prompting.

Environment:
  ZALO_TG_INSTALL_DIR  Same as --dir; default is ./zalo-tg under the current path
  ZALO_TG_REPO         Same as --repo
EOF
      exit 0
      ;;
    *)
      printf '%s\n' "${RED}Unknown option:${RESET} $1" >&2
      exit 2
      ;;
  esac
  shift
done

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)
ROOT_DIR=$SCRIPT_DIR
BOOTSTRAP_MODE=0
OS_FAMILY="unknown"
OS_NAME="Unknown OS"

LOG_FILE="${TMPDIR:-/tmp}/zalo-tg-install.$$.log"
trap 'rm -f "$LOG_FILE"' EXIT INT TERM

line() {
  cols=${COLUMNS:-80}
  char=${1:-─}
  awk -v n="$cols" -v c="$char" 'BEGIN { for (i = 0; i < n; i++) printf c; printf "\n" }'
}

paint_status() {
  label=$1
  color=$2
  printf '%s%s%s' "$color" "$label" "$RESET"
}

header() {
  if [ -t 1 ]; then
    printf '\033[2J\033[H'
  fi
  printf '%s\n' "${DIM}$(line "━")${RESET}"
  printf '  %s┌─%s %s%s%s  %s● %s%s%s\n' \
    "$DIM" "$RESET" "$BOLD" "$APP_NAME" "$RESET" "$GREEN" "$RESET" "$DIM" "v$APP_VERSION" "$RESET"
  printf '  %s│%s %sZalo ⇄ Telegram bridge%s\n' "$DIM" "$RESET" "$CYAN" "$RESET"
  printf '  %s└─%s %ssetup wizard%s\n' "$DIM" "$RESET" "$DIM" "$RESET"
  printf '%s\n\n' "${DIM}$(line "━")${RESET}"
}

section() {
  printf '\n  %s▸%s %s%s%s\n' "$CYAN" "$RESET" "$BOLD" "$1" "$RESET"
  printf '  %s\n' "${DIM}$(line "─")${RESET}"
}

note() {
  printf '  %sℹ%s %s\n' "$CYAN" "$RESET" "$1"
}

ok() {
  printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$1"
}

warn() {
  printf '  %s⚠%s %s\n' "$YELLOW" "$RESET" "$1"
}

fail() {
  printf '  %s✘%s %s\n' "$RED" "$RESET" "$1" >&2
}

need_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

detect_os() {
  kernel=$(uname -s 2>/dev/null || printf 'unknown')
  case "$kernel" in
    Darwin*) OS_FAMILY="macos"; OS_NAME="macOS" ;;
    Linux*) OS_FAMILY="linux"; OS_NAME="Linux" ;;
    CYGWIN*|MINGW*|MSYS*) OS_FAMILY="windows"; OS_NAME="Windows" ;;
    *) OS_FAMILY="unknown"; OS_NAME="$kernel" ;;
  esac
}

tool_hint() {
  tool=$1
  case "$OS_FAMILY:$tool" in
    macos:git) warn "Install Git on macOS: xcode-select --install  # or: brew install git" ;;
    macos:node|macos:npm) warn "Install Node.js/npm on macOS: brew install node" ;;
    macos:go) warn "Install Go on macOS: brew install go" ;;
    linux:git) warn "Install Git on Linux, e.g. Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y git" ;;
    linux:node|linux:npm) warn "Install Node.js/npm on Linux, e.g. Debian/Ubuntu: sudo apt-get install -y nodejs npm" ;;
    linux:go) warn "Install Go on Linux, e.g. Debian/Ubuntu: sudo apt-get install -y golang-go" ;;
    windows:git) warn "Install Git on Windows: winget install Git.Git  # then run this in Git Bash/WSL" ;;
    windows:node|windows:npm) warn "Install Node.js/npm on Windows: winget install OpenJS.NodeJS" ;;
    windows:go) warn "Install Go on Windows: winget install GoLang.Go" ;;
    *) warn "Install $tool and re-run this installer." ;;
  esac
}

version_ge() {
  current=$1
  minimum=$2
  awk -v cur="$current" -v min="$minimum" '
    BEGIN {
      split(cur, c, "."); split(min, m, ".");
      for (i = 1; i <= 3; i++) {
        cv = c[i] + 0; mv = m[i] + 0;
        if (cv > mv) exit 0;
        if (cv < mv) exit 1;
      }
      exit 0;
    }'
}

can_prompt() {
  [ "$ASSUME_YES" -eq 0 ] || return 1
  if [ -t 0 ]; then
    return 0
  fi
  if [ -r /dev/tty ]; then
    return 0
  fi
  return 1
}

read_prompt() {
  ans=""
  if [ -t 0 ]; then
    IFS= read -r ans || ans=""
  elif [ -r /dev/tty ]; then
    IFS= read -r ans < /dev/tty || ans=""
  fi
}

confirm() {
  prompt=$1
  default=${2:-Y}
  printf '  %s?%s %s %s[%s]%s\n' "$MAGENTA" "$RESET" "$prompt" "$DIM" "$default" "$RESET"
  case "$default" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

ask_env_value() {
  label=$1
  default=${2:-}
  required=${3:-0}

  if ! can_prompt; then
    if [ -n "$default" ]; then
      printf '  %s✎%s %s %s[%s]%s\n' "$MAGENTA" "$RESET" "$label" "$DIM" "$default" "$RESET" >&2
    else
      printf '  %s✎%s %s %s[blank]%s\n' "$MAGENTA" "$RESET" "$label" "$DIM" "$RESET" >&2
    fi
    printf '%s\n' "$default"
    return 0
  fi

  while :; do
    if [ -n "$default" ]; then
      printf '  %s✎%s %s %s[%s]%s ' "$MAGENTA" "$RESET" "$label" "$DIM" "$default" "$RESET" >&2
    else
      printf '  %s✎%s %s %s[blank]%s ' "$MAGENTA" "$RESET" "$label" "$DIM" "$RESET" >&2
    fi
    read_prompt
    [ -n "$ans" ] || ans=$default
    if [ "$required" -eq 1 ] && [ -z "$ans" ]; then
      warn "required value; please enter it" >&2
      continue
    fi
    printf '%s\n' "$ans"
    return 0
  done
}

quote_env_value() {
  q_value=$1
  case "$q_value" in
    *[!A-Za-z0-9_./:@%+=,-]*)
      q_escaped=$(printf '%s' "$q_value" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g')
      printf '"%s"' "$q_escaped"
      ;;
    *)
      printf '%s' "$q_value"
      ;;
  esac
}

write_env_var() {
  w_file=$1
  w_key=$2
  w_value=${3:-}
  printf '%s=' "$w_key" >> "$w_file"
  quote_env_value "$w_value" >> "$w_file"
  printf '\n' >> "$w_file"
}

write_env_optional() {
  w_file=$1
  w_key=$2
  w_value=${3:-}
  if [ -n "$w_value" ]; then
    write_env_var "$w_file" "$w_key" "$w_value"
  else
    printf '# %s=\n' "$w_key" >> "$w_file"
  fi
}

write_config_env() {
  out_file=$1
  : > "$out_file"
  cat >> "$out_file" <<'EOF'
# ─── zalo-tg generated environment ──────────────────────────────────────────
# Generated by install.sh. Edit any value and restart the app when needed.

# ─── Required: Telegram bridge target ───────────────────────────────────────
EOF
  write_env_var "$out_file" TG_TOKEN "$ENV_TG_TOKEN"
  write_env_var "$out_file" TG_GROUP_ID "$ENV_TG_GROUP_ID"
  cat >> "$out_file" <<'EOF'

# ─── Storage and Zalo session ───────────────────────────────────────────────
EOF
  write_env_var "$out_file" DATA_DIR "$ENV_DATA_DIR"
  write_env_var "$out_file" ZALO_CREDENTIALS_PATH "$ENV_ZALO_CREDENTIALS_PATH"
  write_env_optional "$out_file" ZALO_TG_SHARED_TMP_ROOT "$ENV_ZALO_TG_SHARED_TMP_ROOT"
  cat >> "$out_file" <<'EOF'

# ─── Zalo behavior ──────────────────────────────────────────────────────────
EOF
  write_env_var "$out_file" ZALO_SKIP_MUTED_GROUPS "$ENV_ZALO_SKIP_MUTED_GROUPS"
  write_env_var "$out_file" ZALO_MUTE_SILENT "$ENV_ZALO_MUTE_SILENT"
  cat >> "$out_file" <<'EOF'

# ─── Telegram Local Bot API ─────────────────────────────────────────────────
EOF
  write_env_var "$out_file" LOCAL_BOT_API "$ENV_LOCAL_BOT_API"
  write_env_var "$out_file" TG_LOCAL_SERVER "$ENV_TG_LOCAL_SERVER"
  write_env_var "$out_file" TG_API_ID "$ENV_TG_API_ID"
  write_env_var "$out_file" TG_API_HASH "$ENV_TG_API_HASH"
  write_env_var "$out_file" TG_LOCAL_PORT "$ENV_TG_LOCAL_PORT"
  write_env_optional "$out_file" TGBOTAPI_DATA_DIR "$ENV_TGBOTAPI_DATA_DIR"
  cat >> "$out_file" <<'EOF'

# ─── Runtime / updater supervision ─────────────────────────────────────────
EOF
  write_env_optional "$out_file" ZALO_TG_RUNNER "$ENV_ZALO_TG_RUNNER"
  write_env_optional "$out_file" NODE_ENV "$ENV_NODE_ENV"
  cat >> "$out_file" <<'EOF'

# ─── Terminal UI / dashboard ───────────────────────────────────────────────
EOF
  write_env_optional "$out_file" ZALO_TG_TUI "$ENV_ZALO_TG_TUI"
  write_env_optional "$out_file" ZALO_TG_TUI_ENGINE "$ENV_ZALO_TG_TUI_ENGINE"
  write_env_optional "$out_file" ZALO_TG_TUI_MOUSE "$ENV_ZALO_TG_TUI_MOUSE"
  write_env_optional "$out_file" ZALO_TG_TUI_BIN "$ENV_ZALO_TG_TUI_BIN"
  write_env_optional "$out_file" ZALO_TG_GLOW_BIN "$ENV_ZALO_TG_GLOW_BIN"
  write_env_optional "$out_file" ZALO_TG_TUI_DUMP_ON_EXIT "$ENV_ZALO_TG_TUI_DUMP_ON_EXIT"
  write_env_optional "$out_file" ZALO_TG_NO_ANIMATION "$ENV_ZALO_TG_NO_ANIMATION"
  write_env_optional "$out_file" NO_COLOR "$ENV_NO_COLOR"
  write_env_optional "$out_file" TERM "$ENV_TERM"
  cat >> "$out_file" <<'EOF'

# Internal marker set automatically when Node spawns the Go TUI sidecar.
# Do not set manually.
# ZALO_TG_TUI_SIDECAR=1

# ─── Installer-only variables ──────────────────────────────────────────────
# Export these before running install.sh if you need them.
# ZALO_TG_INSTALL_DIR=$PWD/zalo-tg
# ZALO_TG_REPO=https://github.com/leolionart/zalo-tg.git
EOF
}

configure_env() {
  if [ "$SKIP_ENV" -eq 1 ]; then
    warn ".env configuration skipped by flag"
    return 0
  fi

  if [ -f .env ]; then
    if ! confirm ".env exists. Reconfigure and overwrite it? A backup will be kept." "Y"; then
      ok ".env exists; leaving it untouched"
      return 0
    fi
  elif ! confirm "Create .env with the full setup wizard?" "Y"; then
    warn ".env not created"
    return 0
  fi

  section "Configuration"
  note "Press Enter to accept a default. Blank optional values stay commented."
  note "Telegram values can also be passed as TG_TOKEN/TG_GROUP_ID env vars."

  ENV_TG_TOKEN_DEFAULT=${TG_TOKEN:-}
  ENV_TG_GROUP_ID_DEFAULT=${TG_GROUP_ID:-}
  if ! can_prompt; then
    [ -n "$ENV_TG_TOKEN_DEFAULT" ] || ENV_TG_TOKEN_DEFAULT="1234567890:ABCDEFabcdef1234567890abcdefABCDEF123"
    [ -n "$ENV_TG_GROUP_ID_DEFAULT" ] || ENV_TG_GROUP_ID_DEFAULT="-1001234567890"
  fi

  printf '\n  %s▸ Telegram%s\n' "$CYAN" "$RESET"
  ENV_TG_TOKEN=$(ask_env_value "TG_TOKEN - bot token from @BotFather" "$ENV_TG_TOKEN_DEFAULT" 1)
  ENV_TG_GROUP_ID=$(ask_env_value "TG_GROUP_ID - forum supergroup ID" "$ENV_TG_GROUP_ID_DEFAULT" 1)

  printf '\n  %s▸ Storage%s\n' "$CYAN" "$RESET"
  ENV_DATA_DIR=$(ask_env_value "DATA_DIR - persistent data directory" "${DATA_DIR:-./data}" 0)
  ENV_ZALO_CREDENTIALS_PATH=$(ask_env_value "ZALO_CREDENTIALS_PATH - Zalo credentials file" "${ZALO_CREDENTIALS_PATH:-./credentials.json}" 0)
  ENV_ZALO_TG_SHARED_TMP_ROOT=$(ask_env_value "ZALO_TG_SHARED_TMP_ROOT - shared temp root, blank = auto" "${ZALO_TG_SHARED_TMP_ROOT:-}" 0)

  printf '\n  %s▸ Zalo behavior%s\n' "$CYAN" "$RESET"
  ENV_ZALO_SKIP_MUTED_GROUPS=$(ask_env_value "ZALO_SKIP_MUTED_GROUPS - 1 skip muted groups, 0 mirror them" "${ZALO_SKIP_MUTED_GROUPS:-0}" 0)
  ENV_ZALO_MUTE_SILENT=$(ask_env_value "ZALO_MUTE_SILENT - 1 mirror muted threads silently" "${ZALO_MUTE_SILENT:-1}" 0)

  printf '\n  %s▸ Telegram Local Bot API%s\n' "$CYAN" "$RESET"
  ENV_LOCAL_BOT_API=$(ask_env_value "LOCAL_BOT_API - 1 use local server, 0 official API" "${LOCAL_BOT_API:-0}" 0)
  ENV_TG_LOCAL_SERVER=$(ask_env_value "TG_LOCAL_SERVER - local Bot API URL" "${TG_LOCAL_SERVER:-http://127.0.0.1:8081}" 0)
  ENV_TG_API_ID=$(ask_env_value "TG_API_ID - my.telegram.org API ID, blank if unused" "${TG_API_ID:-}" 0)
  ENV_TG_API_HASH=$(ask_env_value "TG_API_HASH - my.telegram.org API hash, blank if unused" "${TG_API_HASH:-}" 0)
  ENV_TG_LOCAL_PORT=$(ask_env_value "TG_LOCAL_PORT - Docker Compose host port" "${TG_LOCAL_PORT:-8081}" 0)
  ENV_TGBOTAPI_DATA_DIR=$(ask_env_value "TGBOTAPI_DATA_DIR - start-local-api.sh data dir, blank = default" "${TGBOTAPI_DATA_DIR:-}" 0)

  printf '\n  %s▸ Runtime%s\n' "$CYAN" "$RESET"
  ENV_ZALO_TG_RUNNER=$(ask_env_value "ZALO_TG_RUNNER - 1 only under external supervisor, blank normally" "${ZALO_TG_RUNNER:-}" 0)
  ENV_NODE_ENV=$(ask_env_value "NODE_ENV - blank normally, production in Docker" "${NODE_ENV:-}" 0)

  printf '\n  %s▸ Terminal UI%s\n' "$CYAN" "$RESET"
  ENV_ZALO_TG_TUI=$(ask_env_value "ZALO_TG_TUI - 0 disable dashboard, blank = enabled" "${ZALO_TG_TUI:-}" 0)
  ENV_ZALO_TG_TUI_ENGINE=$(ask_env_value "ZALO_TG_TUI_ENGINE - ansi for legacy dashboard, blank = auto" "${ZALO_TG_TUI_ENGINE:-}" 0)
  ENV_ZALO_TG_TUI_MOUSE=$(ask_env_value "ZALO_TG_TUI_MOUSE - native/0 keeps terminal mouse, blank = app mouse" "${ZALO_TG_TUI_MOUSE:-}" 0)
  ENV_ZALO_TG_TUI_BIN=$(ask_env_value "ZALO_TG_TUI_BIN - custom sidecar path, blank = auto" "${ZALO_TG_TUI_BIN:-}" 0)
  ENV_ZALO_TG_GLOW_BIN=$(ask_env_value "ZALO_TG_GLOW_BIN - custom Glow path, blank = auto" "${ZALO_TG_GLOW_BIN:-}" 0)
  ENV_ZALO_TG_TUI_DUMP_ON_EXIT=$(ask_env_value "ZALO_TG_TUI_DUMP_ON_EXIT - 0 disables exit dump, blank = enabled" "${ZALO_TG_TUI_DUMP_ON_EXIT:-}" 0)
  ENV_ZALO_TG_NO_ANIMATION=$(ask_env_value "ZALO_TG_NO_ANIMATION - 1 disables animations, blank = animated" "${ZALO_TG_NO_ANIMATION:-}" 0)
  ENV_NO_COLOR=$(ask_env_value "NO_COLOR - any value disables color, blank = color" "" 0)
  ENV_TERM=$(ask_env_value "TERM - usually leave blank; dumb disables dashboard" "" 0)

  if [ "$DRY_RUN" -eq 1 ]; then
    ok "dry-run: would write .env"
    return 0
  fi

  ENV_TMP=".env.tmp.$$"
  write_config_env "$ENV_TMP"
  if [ -f .env ]; then
    ENV_BACKUP=".env.backup.$(date +%Y%m%d%H%M%S)"
    cp .env "$ENV_BACKUP"
    ok "backed up existing .env to $ENV_BACKUP"
  fi
  mv "$ENV_TMP" .env
  ok "created .env with full configuration"
}

has_npm_script() {
  script_name=$1
  node -e '
    const fs = require("fs");
    const name = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    process.exit(pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, name) ? 0 : 1);
  ' "$script_name" >/dev/null 2>&1
}

run_cmd() {
  title=$1
  shift
  printf '  %s→%s %s\n' "$BLUE" "$RESET" "$title"
  printf '    %s$ %s%s\n' "$DIM" "$*" "$RESET"
  if [ "$DRY_RUN" -eq 1 ]; then
    ok "dry-run: skipped"
    return 0
  fi
  if "$@" >"$LOG_FILE" 2>&1; then
    ok "$title"
    return 0
  fi
  fail "$title failed"
  printf '%s\n' "${DIM}$(line "━")${RESET}" >&2
  sed -n '1,160p' "$LOG_FILE" >&2
  printf '%s\n' "${DIM}$(line "━")${RESET}" >&2
  exit 1
}

build_tui_sidecar() {
  if has_npm_script "tui:build"; then
    run_cmd "Build Charmbracelet TUI sidecar" npm run tui:build
    return 0
  fi

  warn "package.json has no tui:build script; using direct Go fallback"
  if [ ! -d cmd/zalo-tg-tui ]; then
    warn "cmd/zalo-tg-tui not found; TUI sidecar build skipped"
    return 0
  fi
  run_cmd "Create TUI output directory" mkdir -p bin
  run_cmd "Build Go TUI sidecar" go build -o bin/zalo-tg-tui ./cmd/zalo-tg-tui
  run_cmd "Install Glow renderer" env GOBIN="$ROOT_DIR/bin" go install github.com/charmbracelet/glow@v1.5.1
}

origin_branch() {
  target=$1
  branch=$(git -C "$target" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
  current=$(git -C "$target" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [ "$current" = "HEAD" ] && current=""
  for candidate in "$branch" "$current" main master; do
    [ -n "$candidate" ] || continue
    if git -C "$target" rev-parse --verify --quiet "origin/$candidate" >/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' main
}

sync_existing_checkout() {
  target=$1
  stamp=$(date +%Y%m%d%H%M%S)
  backup_branch="installer-backup-$stamp-$$"
  stash_name="installer-autostash-$stamp"

  run_cmd "Fetch latest checkout" git -C "$target" fetch origin
  branch=$(origin_branch "$target")
  if ! git -C "$target" rev-parse --verify --quiet "origin/$branch" >/dev/null 2>&1; then
    fail "origin/$branch not found after fetch"
    exit 1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    run_cmd "Backup current checkout branch" git -C "$target" branch "$backup_branch"
    run_cmd "Reset checkout to origin/$branch" git -C "$target" checkout -B "$branch" "origin/$branch"
    return 0
  fi

  current_head=$(git -C "$target" rev-parse HEAD 2>/dev/null || true)
  remote_head=$(git -C "$target" rev-parse "origin/$branch")
  if [ "$current_head" = "$remote_head" ] && [ -z "$(git -C "$target" status --porcelain --untracked-files=no)" ]; then
    ok "checkout already matches origin/$branch"
    return 0
  fi

  if [ -n "$(git -C "$target" status --porcelain --untracked-files=no)" ]; then
    run_cmd "Stash tracked local changes" git -C "$target" stash push -m "$stash_name"
    note "tracked local changes saved in git stash: $stash_name"
  fi

  run_cmd "Backup current checkout branch" git -C "$target" branch "$backup_branch"
  run_cmd "Reset checkout to origin/$branch" git -C "$target" checkout -B "$branch" "origin/$branch"
  note "previous local HEAD saved as branch: $backup_branch"
}

header

detect_os

section "Target"

ok "detected $OS_NAME"

if [ -f "$SCRIPT_DIR/package.json" ]; then
  ROOT_DIR=$SCRIPT_DIR
  ok "using local checkout $ROOT_DIR"
elif [ -f "$CALL_DIR/package.json" ]; then
  ROOT_DIR=$CALL_DIR
  ok "using local checkout $ROOT_DIR"
else
  BOOTSTRAP_MODE=1
  ROOT_DIR=$INSTALL_DIR
  note "curl/bootstrap mode"
  note "repository: $REPO_URL"
  note "install dir: $ROOT_DIR"

  if ! need_cmd git; then
    fail "Git not found; curl install needs Git to clone the repo"
    tool_hint git
    exit 1
  fi

  if [ -d "$ROOT_DIR" ]; then
    if [ -f "$ROOT_DIR/package.json" ]; then
      ok "existing checkout found"
      if [ -d "$ROOT_DIR/.git" ]; then
        confirm "Sync existing checkout to latest origin branch?" "Y" >/dev/null
        sync_existing_checkout "$ROOT_DIR"
      else
        warn "target has package.json but is not a Git checkout; not updating"
      fi
    elif [ -z "$(find "$ROOT_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | sed -n '1p')" ]; then
      run_cmd "Clone repository into target directory" git clone "$REPO_URL" "$ROOT_DIR"
      if [ "$DRY_RUN" -eq 1 ]; then
        warn "dry-run stopped before workspace setup because checkout was not created"
        exit 0
      fi
    else
      fail "target directory exists but does not look like $APP_NAME: $ROOT_DIR"
      warn "Run from an empty install directory, or choose another path with: ZALO_TG_INSTALL_DIR=/path sh install.sh"
      exit 1
    fi
  else
    parent_dir=$(dirname "$ROOT_DIR")
    run_cmd "Create install parent" mkdir -p "$parent_dir"
    run_cmd "Clone repository" git clone "$REPO_URL" "$ROOT_DIR"
    if [ "$DRY_RUN" -eq 1 ]; then
      warn "dry-run stopped before workspace setup because checkout was not created"
      exit 0
    fi
  fi
fi

cd "$ROOT_DIR"

section "System"

if need_cmd node; then
  NODE_VERSION=$(node -p "process.versions.node" 2>/dev/null || printf '0.0.0')
  if version_ge "$NODE_VERSION" "$MIN_NODE"; then
    ok "Node.js $NODE_VERSION"
  else
    fail "Node.js $NODE_VERSION found; need >= $MIN_NODE"
    tool_hint node
    exit 1
  fi
else
  fail "Node.js not found; install Node.js >= $MIN_NODE"
  tool_hint node
  exit 1
fi

if need_cmd npm; then
  ok "npm $(npm -v)"
else
  fail "npm not found"
  tool_hint npm
  exit 1
fi

if [ "$SKIP_TUI" -eq 0 ]; then
  if need_cmd go; then
    GO_VERSION=$(go env GOVERSION 2>/dev/null | sed 's/^go//')
    if version_ge "$GO_VERSION" "$MIN_GO"; then
      ok "Go $GO_VERSION"
    else
      warn "Go $GO_VERSION found; TUI build expects >= $MIN_GO"
      tool_hint go
      if ! confirm "Continue and skip TUI build?" "Y"; then
        exit 1
      fi
      SKIP_TUI=1
    fi
  else
    warn "Go not found; Charmbracelet TUI sidecar will be skipped"
    tool_hint go
    SKIP_TUI=1
  fi
else
  warn "TUI build skipped by flag"
fi

section "Project"

if [ ! -f package.json ]; then
  fail "package.json not found in $ROOT_DIR"
  exit 1
fi
if [ "$BOOTSTRAP_MODE" -eq 1 ]; then
  ok "workspace $ROOT_DIR (bootstrapped)"
else
  ok "workspace $ROOT_DIR"
fi

configure_env

section "Install"

if [ "$SKIP_NPM" -eq 0 ]; then
  if [ -f package-lock.json ]; then
    run_cmd "Install npm dependencies" npm ci
  else
    run_cmd "Install npm dependencies" npm install
  fi
else
  warn "npm dependency install skipped"
fi

if [ "$SKIP_TUI" -eq 0 ]; then
  build_tui_sidecar
else
  warn "TUI sidecar build skipped; app will use ANSI fallback unless bin/zalo-tg-tui already exists"
fi

run_cmd "Build TypeScript" npm run build

if [ "$RUN_CHECK" -eq 1 ]; then
  run_cmd "Run full check" npm run check
fi

printf '\n%s\n' "${GREEN}$(line "━")${RESET}"
printf '  %s✦%s %s%s installed successfully%s %s✦%s\n' \
  "$YELLOW" "$RESET" "$BOLD" "$APP_NAME" "$RESET" "$YELLOW" "$RESET"
printf '%s\n\n' "${GREEN}$(line "━")${RESET}"

printf '  %s▸%s Edit %s.env%s with your %sTG_TOKEN%s and %sTG_GROUP_ID%s\n' \
  "$CYAN" "$RESET" "$BOLD" "$RESET" "$YELLOW" "$RESET" "$YELLOW" "$RESET"
printf '  %s▸%s Start: %s%s npm run dev%s\n' \
  "$CYAN" "$RESET" "$DIM" "$RESET" "$BOLD" "$RESET"
printf '  %s▸%s Rebuild TUI: %s%s npm run tui:build%s\n' \
  "$CYAN" "$RESET" "$DIM" "$RESET" "$BOLD" "$RESET"

if grep -q '^LOCAL_BOT_API=1' .env 2>/dev/null; then
  printf '\n'
  printf '  %s▸%s %sLocal Bot API:%s %sdocker compose up -d telegram-bot-api%s\n' \
    "$YELLOW" "$RESET" "$BOLD" "$RESET" "$DIM" "$RESET"
fi

printf '\n%s\n' "${DIM}$(line "─")${RESET}"
