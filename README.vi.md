# Cầu nối Zalo ↔ Telegram

[![CI](https://github.com/williamcachamwri/zalo-tg/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/williamcachamwri/zalo-tg/actions/workflows/ci.yml)
[![Phiên bản](https://img.shields.io/github/package-json/v/williamcachamwri/zalo-tg?label=version)](https://github.com/williamcachamwri/zalo-tg)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Commit mới nhất](https://img.shields.io/github/last-commit/williamcachamwri/zalo-tg)](https://github.com/williamcachamwri/zalo-tg/commits/main)

> Bridge TypeScript đồng bộ tin nhắn Zalo DM/nhóm sang Telegram forum topic, và gửi tin nhắn từ Telegram ngược về đúng hội thoại Zalo.

English: [README.md](README.md)

## Dự án này làm gì

`zalo-tg` biến một Telegram supergroup có bật forum topic thành trung tâm đọc/trả lời Zalo:

- mỗi DM hoặc nhóm Zalo được ánh xạ vào một Telegram topic;
- tin nhắn từ Zalo được chuyển vào đúng topic;
- tin nhắn gửi trong topic Telegram được gửi ngược về đúng DM/nhóm Zalo;
- reply, reaction, thu hồi, album, file, sticker, GIF, voice, poll, sự kiện nhóm và thao tác admin đều được theo dõi bằng store local;
- đăng nhập hỗ trợ Zalo Web QR và QR qua PC App API;
- có thể bật Telegram Local Bot API để xử lý file lớn/local file path ổn định hơn.

Codebase hiện tại được thiết kế cho một account Zalo đang hoạt động. Trạng thái Zalo API, credentials, topic mapping và cache đều là global singleton.

## Yêu cầu

- Node.js `>=20.11`
- npm
- Git (cần cho installer qua curl và luồng update)
- Tuỳ chọn: Go `>=1.24` để build Charmbracelet TUI sidecar
- Telegram bot token
- Telegram supergroup đã bật forum topics
- Bot phải là admin trong group Telegram đó
- Một account Zalo có thể quét QR
- Tuỳ chọn: Docker / Docker Compose nếu muốn chạy Telegram Local Bot API

## Chạy nhanh

Installer một dòng khuyến nghị:

macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/williamcachamwri/zalo-tg/main/install.sh | sh
```

Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/williamcachamwri/zalo-tg/main/install.sh | sh
```

Windows, chạy bằng PowerShell kèm Git Bash/WSL `sh`:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/williamcachamwri/zalo-tg/main/install.sh -o install.sh
sh install.sh
```

Installer qua curl mặc định clone hoặc update project vào `~/zalo-tg`, sau đó check Node/npm/Go, cài npm dependencies, build Charmbracelet TUI sidecar nếu có Go, tạo `.env` từ `.env.example` chỉ khi chưa có `.env`, và không đè config hiện tại.

Muốn chọn thư mục cài khác:

```bash
ZALO_TG_INSTALL_DIR=/opt/zalo-tg curl -fsSL https://raw.githubusercontent.com/williamcachamwri/zalo-tg/main/install.sh | sh
```

Nếu đã clone repo sẵn:

```bash
sh install.sh
```

Nếu muốn chạy không hỏi:

```bash
curl -fsSL https://raw.githubusercontent.com/williamcachamwri/zalo-tg/main/install.sh | sh -s -- --yes
```

Cài thủ công:

```bash
npm ci
cp .env.example .env # nếu checkout có file này; nếu không thì tự tạo .env
npm run dev
```

Các biến `.env` bắt buộc:

```env
TG_TOKEN=123456:telegram-bot-token
TG_GROUP_ID=-1001234567890
```

Tất cả biến còn lại có thể cấu hình trực tiếp qua bot: chỉ cần điền 2 biến trên,
gửi `/setup` trong group bridge (chỉ admin) — wizard sẽ hỏi lần lượt từng biến tuỳ chọn,
dùng nút inline cho biến boolean và nhập tin nhắn cho biến dạng văn bản, sau đó tự ghi
kết quả vào `.env` (áp dụng bằng `/restart`, dùng Docker thì cập nhật thêm trong compose).

Copy [.env.example](.env.example) để có template đầy đủ. Bảng config đầy đủ:

| Biến | Mặc định / ví dụ | Nơi dùng | Công dụng |
| --- | --- | --- | --- |
| `TG_TOKEN` | bắt buộc | app | Telegram bot token lấy từ @BotFather. |
| `TG_GROUP_ID` | bắt buộc, ví dụ `-1001234567890` | app | ID Telegram supergroup/forum. Phải là số âm; bot phải là admin và group phải bật Topics. |
| `DATA_DIR` | `./data` | app | Thư mục lưu topic map, message map, user cache, poll và auto-reply state. |
| `ZALO_CREDENTIALS_PATH` | `./credentials.json` | app | File credentials Zalo được ghi sau QR login. Không commit file này. |
| `ZALO_SKIP_MUTED_GROUPS` | `0` | app | `1` bỏ qua hoàn toàn tin từ nhóm Zalo đã mute. |
| `ZALO_MUTE_SILENT` | `1` | app | `1` mirror thread Zalo đã mute thành tin Telegram silent; `0` luôn notify. |
| `ZALO_DM_NATIVE_REACTION` | `1` | app | `1` hiển thị cảm xúc Zalo ở DM dạng native reaction trên tin nhắn; `0` luôn dùng reply tổng hợp `❤️ Tên` như nhóm. |
| `ZALO_EXCLUDE_THREADS` | trống | app | Danh sách thread không mirror, phân tách bằng dấu phẩy: `type:id` (type `0`=DM, `1`=nhóm); id trần được coi là nhóm. Tin nhắn, cảm xúc, thu hồi từ thread bị loại sẽ bị bỏ qua hoàn toàn. |
| `HTTP_API_ENABLED` | `0` | app | Bật API tự động hóa tích hợp `POST /send`, dùng chung phiên Zalo đang hoạt động. |
| `HTTP_API_HOST` | `127.0.0.1` | app | Địa chỉ bind của HTTP API. Nên giữ loopback nếu không thật sự cần truy cập từ xa. |
| `HTTP_API_PORT` | `3000` | app | Cổng TCP của HTTP API. |
| `HTTP_API_TOKEN` | chưa đặt | app | Bearer token tùy chọn. Nên đặt khi bind ra ngoài loopback. |
| `LOCAL_BOT_API` | `0` | app | `1` gửi request Telegram Bot API qua `TG_LOCAL_SERVER`; `0` dùng official `api.telegram.org`. |
| `TG_LOCAL_SERVER` | `http://127.0.0.1:8081` | app / Compose override | Endpoint Local Bot API. Chỉ bắt buộc khi `LOCAL_BOT_API=1`; Compose override thành `http://telegram-bot-api:8081`. |
| `TG_API_ID` | rỗng | Docker Compose | Telegram API ID cho container `telegram-bot-api`; lấy tại my.telegram.org. |
| `TG_API_HASH` | rỗng | Docker Compose | Telegram API hash cho container `telegram-bot-api`. |
| `TG_LOCAL_PORT` | `8081` | Docker Compose | Port host expose cho Local Bot API service. |
| `ZALO_TG_SHARED_TMP_ROOT` | tự động | app | Root temp dùng chung cho file path mà bridge và Local Bot API đều phải thấy. Mặc định là `/tmp` khi bật local mode trên POSIX, còn lại dùng temp của OS. |
| `ZALO_TG_RUNNER` | unset | app / Compose | Chỉ set `1` khi có supervisor ngoài restart process theo exit code update/restart. Không set `0`; để unset. |
| `NODE_ENV` | Docker set `production` | Docker / Node | Runtime mode; thường để Docker quản lý. |
| `ZALO_TG_TUI` | bật | app | `0` tắt live TUI/dashboard và in log thường. |
| `ZALO_TG_TUI_ENGINE` | tự động | app | `ansi` ép dùng dashboard ANSI TypeScript cũ thay vì sidecar Go. |
| `ZALO_TG_TUI_MOUSE` | bật | app | Dùng `0`, `false`, `off`, `no` hoặc `native` để giữ native mouse selection của terminal. |
| `ZALO_TG_TUI_BIN` | auto-detect `bin/zalo-tg-tui` | app | Path tuỳ chỉnh tới binary Go TUI sidecar. |
| `ZALO_TG_TUI_DUMP_ON_EXIT` | bật | app | `0` tắt dump các dòng activity cuối khi sidecar thoát sớm. |
| `ZALO_TG_NO_ANIMATION` | unset | app | `1` tắt animation startup/shutdown trong terminal. |
| `NO_COLOR` | unset | app / convention terminal | Có giá trị bất kỳ thì tắt màu dashboard. |
| `TERM` | terminal tự set | app / convention terminal | `TERM=dumb` tắt dashboard interactive. Thường không cần set tay. |
| `ZALO_TG_INSTALL_DIR` | `~/zalo-tg` | chỉ installer | Thư mục checkout khi chạy `curl | sh`; export trước khi chạy `install.sh`. |
| `ZALO_TG_REPO` | repo GitHub này | chỉ installer | URL repo mà `install.sh` clone; export trước khi chạy installer. |

Sau khi bot chạy, gửi `/login` trong group Telegram hoặc nhắn riêng với bot. Quét QR bằng Zalo. Khi đăng nhập thành công, bridge bắt đầu listen và tự tạo topic khi có hội thoại xuất hiện.

## Scripts

| Script | Công dụng |
| --- | --- |
| `sh install.sh` | Installer shell interactive có terminal UI đẹp; chuẩn bị dependencies, `.env`, TypeScript build và Go TUI sidecar tuỳ chọn. |
| `npm run dev` | Chạy app TypeScript bằng `tsx`. |
| `npm run dev:watch` | Chạy với Node watch mode. |
| `npm run build` | Compile TypeScript vào `dist/`. |
| `npm run tui:build` | Build TUI sidecar vào `bin/zalo-tg-tui` và Glow renderer kèm theo vào `bin/glow`. |
| `npm start` | Chạy app đã compile. |
| `npm test` | Chạy toàn bộ test TypeScript. |
| `npm run check` | Build và chạy full test suite. |
| `npm run test:coverage` | Chạy test kèm Node coverage. |
| `npm run security:audit` | Chạy `npm audit --omit=dev`. |

## Lệnh Telegram chính

| Lệnh | Công dụng |
| --- | --- |
| `/login` | Đăng nhập Zalo bằng QR. |
| `/loginweb` | Alias của luồng đăng nhập Web QR. |
| `/loginapp` | Đăng nhập qua PC App API QR. |
| `/search` | Tìm bạn bè/nhóm Zalo và tạo/mở topic. |
| `/addgroup` | Tạo topic cho các nhóm Zalo chưa có topic. |
| `/group_info` | Xem thông tin nhóm Zalo đang map với topic hiện tại. |
| `/group_infoall` | Xem danh sách thành viên đầy đủ khi API hỗ trợ. |
| `/history` | Nạp lịch sử nhóm Zalo gần đây vào topic hiện tại. |
| `/addfriend` | Tìm và gửi lời mời kết bạn bằng số điện thoại. |
| `/friendrequests` | Duyệt lời mời kết bạn và lời mời nhóm. |
| `/joingroup` | Vào nhóm Zalo bằng link hoặc invitation box. |
| `/leavegroup` | Rời nhóm Zalo đang map và đóng topic. |
| `/topic` | Liệt kê, xem, xoá hoặc quản lý mapping topic. |
| `/autoreply` | Cấu hình tự trả lời DM. |
| `/recall` | Thu hồi tin Zalo bằng cách reply tin đã bridge trên Telegram. |
| `/admin` | Công cụ diagnostic/cache/admin. |
| `/status` | Xem tình trạng bridge và số lượng mapping. |
| `/restart` | Yêu cầu restart nếu đang chạy dưới supervisor. |
| `/update` | Kiểm tra bản cập nhật. |

## Bản đồ codebase

| Đường dẫn | Vai trò |
| --- | --- |
| `cmd/zalo-tg-tui/` | Go TUI sidecar tuỳ chọn, dùng Bubble Tea, Lip Gloss và Glow/Glamour để render Markdown. |
| `src/index.ts` | Boot process, start Telegram polling, đăng nhập Zalo, nối reconnect và shutdown. |
| `src/config.ts` | Đọc biến môi trường và resolve path. |
| `src/telegram/bot.ts` | Tạo Telegraf bot và đồng bộ lệnh Telegram. |
| `src/telegram/handler.ts` | Xử lý command, callback, Telegram → Zalo, reaction và poll answer. |
| `src/zalo/client.ts` | Quản lý singleton login/session zca-js và Web QR login. |
| `src/zalo/loginApp.ts` | Luồng PC App API QR login và lưu app-session. |
| `src/zalo/handler.ts` | Xử lý event từ Zalo listener và forward sang Telegram. |
| `src/zalo/appApi.ts` | Gọi endpoint PC App API để bổ sung thông tin nhóm/thành viên. |
| `src/zalo/autoReply.ts` | Tự trả lời DM Zalo đủ điều kiện. |
| `src/zalo/reaction.ts` | Map reaction Telegram và icon reaction Zalo. |
| `src/store.ts` | Chứa topic mapping, message mapping, cache, media buffer, reaction và poll store. |
| `src/utils/media.ts` | Download, convert, detect và dọn media files. |
| `src/utils/format.ts` | Escape, truncate và render text/mention/markup. |
| `src/utils/privateFile.ts` | Ghi file nhạy cảm với quyền hạn chế. |
| `src/utils/terminal.ts` | Hiển thị live terminal/TUI status. |
| `src/utils/tgQueue.ts` | Queue giới hạn tốc độ gọi Telegram. |
| `src/lifecycle.ts` | Điều phối shutdown/restart tập trung. |
| `src/updater.ts` | Logic kiểm tra update và thông báo update. |
| `tests/*.test.ts` | Unit/regression test cho store, media, format, config và edge case bridge. |

## Flow toàn codebase

Diagram dưới đây thay thế các Mermaid cũ và gom toàn bộ logic runtime vào một nơi.

```mermaid
flowchart TD
  Start(["Process starts"]) --> Config["config.ts<br/>Load env, resolve DATA_DIR, Telegram, Zalo and Local Bot API settings"]
  Config --> Terminal["terminal.ts<br/>Install live console theme and startup status"]
  Terminal --> Stores["store.ts<br/>Load topics, msg-map, user cache, polls and in-memory buffers"]
  Stores --> TelegramSetup["telegram/bot.ts + telegram/handler.ts<br/>Create Telegraf bot, register commands, callbacks, message, reactions and polls"]
  TelegramSetup --> Updater["updater.ts<br/>Register update checker before callback catch-all"]
  Updater --> LaunchTG["tgBot.launch<br/>Allowed updates: message, callback_query, message_reaction, poll_answer, poll"]
  LaunchTG --> AutoLogin["zalo/client.ts:getZaloApi<br/>Read saved credentials and login with zca-js"]
  AutoLogin -->|credentials valid| StartZalo["index.ts:startZalo<br/>Attach Zalo listener, prune stale group topics, request catch-up on reconnect"]
  AutoLogin -->|missing or invalid| WaitLogin["Notify Telegram<br/>Ask operator to run /login, /loginweb or /loginapp"]
  WaitLogin --> LoginChoice{"Login command"}
  LoginChoice -->|/login or /loginweb| WebQR["zalo/client.ts:triggerQRLogin<br/>Generate QR, save image, send/print QR, save credentials"]
  LoginChoice -->|/loginapp| AppQR["zalo/loginApp.ts<br/>PC App QR, app-session.json, credentials.json, zpw_sek-capable session"]
  WebQR --> StartZalo
  AppQR --> StartZalo
  StartZalo --> Ready["Bridge ready<br/>Telegram polling + Zalo listener are both active"]

  Ready --> ZaloEvent{"Zalo listener event"}
  ZaloEvent -->|message| ZaloNormalize["zalo/handler.ts<br/>Normalize threadId, type, sender, quote, mute state and content"]
  ZaloNormalize --> AutoReplyCheck["zalo/autoReply.ts<br/>For eligible DMs, check auto-reply config and send guarded reply"]
  AutoReplyCheck --> SendZalo
  ZaloNormalize --> TopicLookup["store.getTopicByZalo<br/>Find or create Telegram forum topic for Zalo DM/group"]
  TopicLookup --> ZaloContent{"Zalo content type"}
  ZaloContent -->|text / link / card / location| ZaloText["format.ts<br/>Escape HTML, render mentions/markup, build Telegram text"]
  ZaloContent -->|photo album| ZaloAlbum["zaloAlbumStore<br/>Debounce by conversation + sender, dedupe URLs, keep fallback URLs"]
  ZaloContent -->|file / photo / video / gif| ZaloMedia["media.ts<br/>Download URL candidates, detect media type, prepare Telegram upload"]
  ZaloContent -->|sticker| ZaloSticker["Sticker handling<br/>Fetch detail, send static sticker/photo or convert sprite sheet to GIF"]
  ZaloContent -->|voice| ZaloVoice["Voice handling<br/>Download and send audio/voice-compatible payload"]
  ZaloContent -->|poll| ZaloPoll["pollStore<br/>Mirror Zalo poll to Telegram poll + score message"]
  ZaloContent -->|recall / undo| ZaloRecall["recentlyRecalledMsgIds + msgStore<br/>Suppress self recalls, notify Telegram for external recalls"]
  ZaloContent -->|reaction| ZaloReaction["reactionEventDedupeStore + reactionEchoStore + reactionSummaryStore<br/>Map target msg IDs, suppress echoes, aggregate Telegram summary"]
  ZaloContent -->|group/member event| ZaloGroupEvent["Group/member event handling<br/>Join requests, member updates, topic notices and group metadata refresh"]
  ZaloText --> SendTG["tgQueue / Telegram API<br/>Send message into mapped topic"]
  ZaloAlbum --> SendTG
  ZaloMedia --> SendTG
  ZaloSticker --> SendTG
  ZaloVoice --> SendTG
  ZaloPoll --> SendTG
  ZaloRecall --> SendTG
  ZaloReaction --> SendTG
  ZaloGroupEvent --> SendTG
  SendTG --> SaveInboundMap["msgStore.save / sentMsgStore reverse lookup<br/>Save Zalo msgId ↔ Telegram msgId and quote metadata"]
  SaveInboundMap --> Ready

  Ready --> TgUpdate{"Telegram update"}
  TgUpdate -->|command| CommandRouter["telegram/handler.ts command router<br/>Auth operator/admin, choose current topic, call Zalo API or stores"]
  CommandRouter --> CmdLogin["Login, search, topic, group info, history, friend requests, admin, status, update, restart"]
  CmdLogin --> CacheAndApi["friendsCache / groupsCache / aliasCache / userCache + zalo/appApi.ts<br/>Refresh search data, resolve mentions, enrich group info and fallback when PC App API is unavailable"]
  CacheAndApi --> Ready
  TgUpdate -->|callback_query| CallbackRouter["Callback router<br/>QR cancel, leave group confirm, friend request action, group request action, update action"]
  CallbackRouter --> Ready
  TgUpdate -->|message_reaction| TgReaction["TG reaction handler<br/>Dedupe update, map Telegram emoji to Zalo icon, lookup msgStore/sentMsgStore target"]
  TgReaction --> ZaloAddReaction["currentApi.addReaction / undo<br/>Mark reactionEchoStore before sending"]
  ZaloAddReaction --> Ready
  TgUpdate -->|poll_answer or poll| TgPollAnswer["Poll answer handler<br/>Find pollStore entry, lock/score mirrored poll when needed"]
  TgPollAnswer --> Ready
  TgUpdate -->|topic message| TopicMessage["TG→Zalo message handler<br/>Ignore bots/non-bridge chats, require message_thread_id"]
  TopicMessage --> TopicToZalo["store.getEntryByTopic<br/>Resolve Zalo conversation and thread type"]
  TopicToZalo --> TgContent{"Telegram content type"}
  TgContent -->|text / caption| TgText["Resolve reply quote, mentions, aliases and group scoped names<br/>sendMessage text"]
  TgContent -->|photo album| TgAlbum["mediaGroupStore<br/>Debounce Telegram media group, send Zalo image layout when possible"]
  TgContent -->|document / photo / animation / video| TgFile["downloadToTemp<br/>Use Local Bot API file path or HTTP download, upload/send attachment"]
  TgContent -->|voice / audio| TgVoice["convertToM4a + uploadAttachment + sendVoice/sendMessage fallback"]
  TgContent -->|sticker static| TgStaticSticker["convertStickerToPng<br/>Render Telegram WebP sticker to transparent PNG and send as image"]
  TgContent -->|sticker animated TGS| TgTgsSticker["convertTgsToGif<br/>Render Lottie frames to GIF and send as image/GIF"]
  TgContent -->|sticker video WebM| TgWebmSticker["convertWebmToGif<br/>Convert WebM sticker to GIF and send as image/GIF"]
  TgContent -->|location / contact| TgSimplePayload["Format as text and send to Zalo"]
  TgContent -->|Telegram poll| TgPollCreate["Create Zalo poll where supported, mirror Telegram poll state into pollStore"]
  TgText --> SendZalo["currentApi.sendMessage / sendVoice / uploadAttachment / addReaction"]
  TgAlbum --> SendZalo
  TgFile --> SendZalo
  TgVoice --> SendZalo
  TgStaticSticker --> SendZalo
  TgTgsSticker --> SendZalo
  TgWebmSticker --> SendZalo
  TgSimplePayload --> SendZalo
  TgPollCreate --> SendZalo
  SendZalo --> EchoGuard["sentMsgStore.markSending/unmarkSending<br/>Suppress self echo race from Zalo listener"]
  EchoGuard --> SaveOutboundMap["sentMsgStore.save + msgStore.save/updateQuoteFromEcho<br/>Keep future replies, recalls and reactions mapped"]
  SaveOutboundMap --> Ready

  Ready --> Reconnect{"Zalo disconnected"}
  Reconnect -->|manual| ManualStop["Do not reconnect"]
  Reconnect -->|duplicate or kicked| LoginRequired["Notify Telegram that login is required"]
  Reconnect -->|recoverable| ReconnectTimer["Wait 5 seconds, reset API, login from saved credentials, restart listener"]
  ReconnectTimer --> StartZalo

  Ready --> Shutdown{"Shutdown or restart requested"}
  Shutdown --> StopListeners["lifecycle.ts<br/>Stop Zalo listener and Telegram bot"]
  StopListeners --> FlushStores["Wait for debounced store persistence<br/>msg-map, user-cache, polls"]
  FlushStores --> Exit(["Process exits with requested code"])
```

## Dữ liệu và persistence

| Dữ liệu | Vị trí mặc định | Công dụng |
| --- | --- | --- |
| Zalo credentials | `credentials.json` | Cookie đăng nhập zca-js, IMEI và user agent. |
| PC App session | cạnh credentials, tên `app-session.json` | Session dùng bởi helper PC App API. |
| Topic mappings | `data/topics.json` | Mapping Telegram topic ↔ hội thoại Zalo. |
| Message mappings | `data/msg-map.json` hoặc gzip payload | Zalo message ID ↔ Telegram message ID và metadata quote. |
| User cache | `data/user-cache.json.gz` | Lookup UID/tên/alias/tên thành viên theo nhóm. |
| Poll cache | `data/polls.json.gz` | Mapping poll giữa Zalo và Telegram. |
| Media tạm | thư mục temp của OS | File đã download/convert trước khi upload. |
| Ảnh QR | `/tmp/zalo-tg/zalo-qr.png` khi bật Local Bot API, nếu không dùng temp OS | Ảnh QR gửi lên Telegram và in ra terminal. |

Credentials và session là dữ liệu nhạy cảm. Không commit các file này.

## Xử lý media

Pipeline media được viết phòng thủ vì Zalo và Telegram expose file theo hai kiểu rất khác nhau:

- Path từ Telegram Local Bot API được copy vào temp file thuộc bridge.
- Download media HTTP có retry và fallback qua nhiều URL candidate.
- Album ảnh Zalo được debounce, dedupe và gửi sang Telegram dưới dạng media group khi có thể.
- Album ảnh Telegram được debounce và gửi sang Zalo bằng layout ảnh native khi có thể.
- Sticker Telegram tĩnh được render thành PNG trong suốt để gửi sang Zalo.
- Sticker Telegram TGS được render từng frame thành GIF.
- Sticker Telegram WebM được convert thành GIF.
- Sticker động Zalo dạng sprite sheet được convert thành GIF.
- Voice/audio được convert sang format upload được khi cần.
- File tạm được dọn sau mỗi lần upload.

## Terminal UI

Dashboard live hiện hỗ trợ Charmbracelet:

- nếu có `bin/zalo-tg-tui` và stdout là terminal interactive, Node bridge tự start sidecar Go;
- sidecar dùng Bubble Tea cho event loop, keymap và mouse; Bubbles cho viewport, help, spinner và scroll progress; Lip Gloss làm layout/style; Charmbracelet `x/ansi` để copy clipboard qua OSC52; và Glow bundled để render Markdown help, fallback sang Glamour;
- nếu thiếu binary, terminal không interactive, hoặc set `ZALO_TG_TUI=0`, bridge fallback về dashboard/log ANSI cũ;
- set `ZALO_TG_TUI_ENGINE=ansi` để ép dùng dashboard TypeScript cũ dù binary Go tồn tại;
- mặc định mouse mode hỗ trợ cả wheel scroll lẫn app-level row selection/copy trong activity pane theo kiểu OpenCode;
- set `ZALO_TG_TUI_MOUSE=0` để giữ native mouse selection/scrolling của terminal, giống cách OpenCode có `mouse: false`. Keyboard scroll trong TUI vẫn hoạt động;
- set `ZALO_TG_TUI_BIN=/absolute/path/to/zalo-tg-tui` nếu muốn dùng sidecar ở path riêng.

Build sidecar local:

```bash
npm run tui:build
```

Phím hữu ích:

| Phím | Hành động |
| --- | --- |
| `↑` / `↓` hoặc mouse wheel | Scroll pane đang focus. Mouse wheel cần mouse capture, mặc định đang bật. |
| `PgUp` / `PgDn` | Scroll theo trang. |
| `g` / `G` | Nhảy tới tin cũ nhất/live activity. |
| Kéo trong activity | Select các dòng activity đang thấy mà vẫn giữ wheel scroll; thả chuột sẽ auto-copy vào clipboard. |
| `y` / `Ctrl+Y` | Copy selection activity hiện tại bằng clipboard tool local nếu có, fallback OSC52 nếu terminal hỗ trợ. |
| `Esc` | Xoá selection activity hiện tại. |
| `s` | Fallback native-select khi mouse capture đang bật: freeze frame và dùng selection native của terminal. Nhấn `s` lần nữa để quay lại live. |
| `?` hoặc `h` | Bật/tắt help pane render bằng Glow. |
| `Tab` | Chuyển focus giữa activity và help pane. |
| `F1` | Mở/thu gọn keymap ở footer. |
| `Ctrl+C` | Copy activity selection; nếu không có selection thì dừng bridge. |

Docker image sẽ tự build và đóng gói cả sidecar lẫn Glow renderer.

## Reaction, reply và thu hồi

Bridge lưu đủ metadata để hai bên hoạt động gần giống native:

- `msgStore` map Zalo message ID sang Telegram message ID và lưu Zalo quote payload.
- `sentMsgStore` theo dõi tin nhắn xuất phát từ Telegram đã gửi sang Zalo.
- `reactionEchoStore` chặn reaction echo do chính bridge tạo ra.
- `reactionEventDedupeStore` tránh duplicate reaction sau reconnect.
- `reactionSummaryStore` gom reaction Zalo thành summary dễ đọc trên Telegram.
- `recentlyRecalledMsgIds` chặn thông báo thu hồi trùng khi lệnh thu hồi xuất phát từ Telegram.

## Ghi chú vận hành

- Bot Telegram phải là admin trong bridge group.
- Telegram group phải bật forum topics.
- Chạy `npm run check` trước khi push.
- Nếu upload media lỗi khi bật Local Bot API, hãy đảm bảo Bot API server và bridge nhìn thấy cùng absolute temp path.
- Nếu Zalo báo duplicate/kicked session, đóng Zalo Web/PC session khác rồi đăng nhập lại.
- Nếu API thành viên nhóm lỗi `zpw_sek`, bridge fallback sang Web API khi có thể, nhưng nhóm ẩn thành viên vẫn có giới hạn.

## Checklist phát triển

```bash
npm run build
npm test
npm run check
```

Test suite đang cover format, config validation, store, media conversion/download helper, reaction mapping, queue behavior và các regression quanh edge case Zalo/Telegram.
