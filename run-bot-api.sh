#!/bin/sh
mkdir -p /Users/wica/lq/zalo-tg/data/bot-api
exec telegram-bot-api \
  --api-id=20424880 \
  --api-hash=a2d3c16c240caa293d3581a1e78cdd08 \
  --local \
  --dir=/Users/wica/lq/zalo-tg/data/bot-api \
  --temp-dir=/tmp \
  --http-port=8081 \
  --verbosity=1
