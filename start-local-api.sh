#!/usr/bin/env bash
# Khởi động Telegram Local Bot API Server
# Yêu cầu: telegram-bot-api binary đã build tại /usr/local/bin/telegram-bot-api

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load env
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

: "${TG_API_ID:?Missing TG_API_ID in .env}"
: "${TG_API_HASH:?Missing TG_API_HASH in .env}"

DATA_DIR="${TGBOTAPI_DATA_DIR:-$SCRIPT_DIR/data/bot-api}"
mkdir -p "$DATA_DIR"

echo "Starting Telegram Local Bot API on port 8081 ..."
exec telegram-bot-api \
  --api-id="$TG_API_ID" \
  --api-hash="$TG_API_HASH" \
  --local \
  --dir="$DATA_DIR" \
  --temp-dir="/tmp" \
  --http-port=8081 \
  --log="$DATA_DIR/bot-api.log" \
  --verbosity=1
