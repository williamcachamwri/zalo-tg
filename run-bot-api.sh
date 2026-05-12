#!/bin/sh
mkdir -p /Users/wica/lq/zalo-tg/data/bot-api
exec telegram-bot-api \
  --api-id= \
  --api-hash= \
  --local \
  --dir=/Users/wica/lq/zalo-tg/data/bot-api \
  --temp-dir=/tmp \
  --http-port=8081 \
  --verbosity=1
