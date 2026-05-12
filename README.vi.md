# zalo-tg

*English version: [README.md](README.md)*

---

Cầu nối tin nhắn hai chiều giữa **Zalo** và **Telegram**, triển khai bằng TypeScript trên Node.js. Mỗi cuộc trò chuyện Zalo (nhắn riêng hoặc nhóm) được ánh xạ tới một Forum Topic riêng biệt trong supergroup Telegram, cung cấp đồng bộ tin nhắn đầy đủ trên cả hai nền tảng.

---

## Mục lục

- [Kiến trúc](#kiến-trúc)
- [Tính năng](#tính-năng)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt](#cài-đặt)
- [Cấu hình](#cấu-hình)
- [Chạy ứng dụng](#chạy-ứng-dụng)
- [Lệnh Bot](#lệnh-bot)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [Bảo mật](#bảo-mật)

---

## Kiến trúc

Bridge hoạt động như một tiến trình Node.js chạy liên tục, đồng thời duy trì:

1. **Telegram bot** (qua [Telegraf](https://github.com/telegraf/telegraf)) kết nối Bot API bằng long polling.
2. **Zalo client** (qua [zca-js](https://github.com/VolunteerSVD/zca-js)) kết nối WebSocket API nội bộ của Zalo.

Hai phía giao tiếp qua một tập hợp các store trong bộ nhớ và trên đĩa, lưu ánh xạ hai chiều giữa Telegram message ID và Zalo message ID. Điều này cho phép các tính năng như reply chain, thu hồi tin nhắn và đồng bộ reaction.

```
 Zalo WebSocket API
        |
   zalo/client.ts         (xác thực, quản lý phiên)
        |
   zalo/handler.ts        (decode sự kiện Zalo → Telegram)
        |
   store.ts               (msgStore, sentMsgStore, pollStore,
        |                  mediaGroupStore, zaloAlbumStore,
        |                  userCache, friendsCache, topicStore)
        |
   telegram/handler.ts    (decode cập nhật Telegram → Zalo)
        |
   Telegram Bot API (long polling)
```

**Topic mapping** (`data/topics.json`) được lưu xuống đĩa. Tất cả ánh xạ message ID được giữ trong bộ nhớ với cơ chế eviction kiểu LRU và sẽ mất khi restart tiến trình (graceful degradation: reply chain tới tin nhắn cũ đơn giản là bỏ qua `reply_parameters`).

---

## Tính năng

### Loại tin nhắn — Zalo sang Telegram

| Loại Zalo (`msgType`) | Đầu ra Telegram |
|---|---|
| `webchat` (văn bản thuần) | `sendMessage` HTML; mention được bọc trong `<b>` |
| `chat.photo` | `sendPhoto` (đơn) hoặc `sendMediaGroup` (album, buffer 600ms) |
| `chat.video.msg` | `sendVideo` |
| `chat.gif` | `sendAnimation` |
| `share.file` | `sendDocument` với tên file gốc |
| `chat.voice` | `sendVoice` |
| `chat.sticker` | `sendSticker` (WebP); fallback `sendPhoto` nếu quá lớn |
| `chat.doodle` | `sendPhoto` |
| `chat.recommended` (link) | `sendMessage` kèm link preview |
| `chat.location.new` | `sendLocation` (bản đồ native) |
| `chat.webcontent` — thẻ ngân hàng | `sendPhoto` với ảnh VietQR + thông tin tài khoản |
| `chat.webcontent` — generic | `sendMessage` với icon và nhãn |
| Danh thiếp (contactUid) | `sendPhoto` với QR + tên/ID, hoặc `sendMessage` nếu không có QR |
| `group.poll` — tạo | `sendPoll` + score message có nút khoá |
| `group.poll` — cập nhật vote | Chỉnh sửa score message với số phiếu và biểu đồ thanh |

### Loại tin nhắn — Telegram sang Zalo

| Nội dung Telegram | Lệnh Zalo API |
|---|---|
| Văn bản | `sendMessage` |
| Ảnh đơn | `sendMessage` với attachment |
| Album ảnh (media group) | `sendMessage` với nhiều attachment (buffer 500ms) |
| Video đơn | `sendMessage` với attachment |
| Album video (media group) | `sendMessage` với nhiều attachment (buffer 500ms) |
| Animation / GIF | `sendMessage` với attachment |
| Document | `sendMessage` với attachment |
| Voice note (OGG Opus) | Convert sang M4A qua ffmpeg → `uploadAttachment` → `sendVoice` |
| Sticker tĩnh (WebP) | `sendMessage` với attachment |
| Sticker động / video | Tải thumbnail JPEG → `sendMessage` với attachment |
| Vị trí | `sendLink` với Google Maps URL; fallback `sendMessage` |
| Danh thiếp | `sendMessage` với tên và số điện thoại |
| Poll | `createPoll` trên Zalo + poll clone non-anonymous trên Telegram |

### Đồng bộ tương tác

**Reply chain** — Khi Telegram message có `reply_to_message`, bridge resolve target thành Zalo `quote` object và truyền vào `sendMessage`. Reply vào tin nhắn gốc từ Telegram sang Zalo được resolve qua reverse index trong `sentMsgStore`.

**Reactions** — Cập nhật `message_reaction` của Telegram được ánh xạ qua bảng emoji tĩnh và forward qua `addReaction`. React Zalo được forward dưới dạng reply ngắn trên Telegram.

**Thu hồi tin nhắn** — Sự kiện `undo` của Zalo kích hoạt `deleteMessage` trên Telegram. Lệnh `/recall` kích hoạt `api.undo` cho tin nhắn do bot gửi.

**Mention** — Span `@mention` Zalo được bọc trong `<b>` trên Telegram. Entity `@username` và pattern `@Tên` văn bản thuần trên Telegram được resolve thành Zalo UID qua `userCache`. Caption ảnh/video cũng được xử lý mention.

### Đồng bộ Poll

- Tạo poll Zalo → Poll native Telegram + score message có nút khoá inline.
- Tạo poll Telegram → `createPoll` Zalo + poll clone non-anonymous (cần thiết cho `poll_answer`) + score message.
- Sự kiện `poll_answer` (Telegram) → `votePoll` Zalo + refresh score ngay qua `getPollDetail`.
- Vote Zalo kích hoạt `group_event` với `boardType=3` → `getPollDetail` → chỉnh sửa score message.
- Nút khoá / `stopPoll` → `lockPoll` Zalo, `stopPoll` cả 2 poll TG, score message hiển thị trạng thái đã đóng.

### Quản lý nhóm

- Nhóm Zalo mới → Forum Topic được tạo tự động khi nhận tin đầu tiên, avatar nhóm được fetch và pin làm tin nhắn đầu tiên.
- Sự kiện nhóm (vào, rời, xoá, chặn) được forward dưới dạng tin hệ thống in nghiêng trong topic.

---

## Yêu cầu

| Phụ thuộc | Phiên bản | Ghi chú |
|---|---|---|
| Node.js | >= 18 | Cần hỗ trợ ESM |
| npm | >= 9 | |
| ffmpeg | bất kỳ | Phải có trong `PATH`; dùng convert OGG→M4A |
| Telegram Bot | — | Tạo qua [@BotFather](https://t.me/BotFather) |
| Telegram Supergroup | — | Bật chế độ Topics; bot phải là admin |
| Tài khoản Zalo | — | Đang hoạt động; session lưu trong `credentials.json` |

**Quyền admin bot cần có trong supergroup Telegram:**
- Quản lý topic (tạo, sửa)
- Xoá tin nhắn
- Pin tin nhắn
- Quản lý nhóm (để nhận cập nhật `message_reaction`)

---

## Cài đặt

```bash
git clone https://github.com/williamcachamwri/zalo-tg
cd zalo-tg
npm install
cp .env.example .env
```

---

## Cấu hình

Chỉnh sửa `.env`:

```env
# Token Telegram Bot từ @BotFather
TG_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ID supergroup Telegram (số nguyên âm, ví dụ: -1001234567890)
TG_GROUP_ID=-1001234567890

# Thư mục lưu dữ liệu (topics.json, credentials.json)
# Mặc định ./data nếu bỏ trống
DATA_DIR=./data

# Bỏ qua forward tin nhắn từ các nhóm Zalo đã tắt thông báo
# Mặc định false; đặt true/1/yes/on để bật
ZALO_SKIP_MUTED_GROUPS=false
```

---

## Chạy ứng dụng

```bash
# Development — hot reload qua tsx watch
npm run dev

# Production
npm run build
npm start
```

Lần đầu chưa có `credentials.json`, gửi `/login` trong bất kỳ topic nào của group Telegram đã bridge. Bot sẽ gửi ảnh QR Zalo; quét bằng app Zalo tại **Cài đặt → Đăng nhập bằng QR**.

---

## Lệnh Bot

| Lệnh | Mô tả |
|---|---|
| `/login` | Bắt đầu xác thực Zalo bằng QR code |
| `/search <truy vấn>` | Tìm kiếm danh sách bạn bè Zalo; chọn kết quả để tạo topic DM |
| `/recall` | Thu hồi tin nhắn đã gửi từ Telegram sang Zalo (reply vào tin cần thu hồi) |
| `/topic list` | Liệt kê tất cả ánh xạ topic–cuộc trò chuyện đang hoạt động |
| `/topic info` | Hiển thị thông tin cuộc trò chuyện Zalo của topic hiện tại |
| `/topic delete` | Xoá ánh xạ của topic hiện tại |

---

## Cấu trúc dự án

```
src/
├── index.ts                  Entry point. Khởi tạo Telegraf, Zalo client,
│                             gắn cả 2 handler, bắt đầu polling.
├── config.ts                 Đọc và kiểm tra biến môi trường.
├── store.ts                  Toàn bộ state trong bộ nhớ và trên đĩa:
│                               - topicStore      (lưu đĩa, topics.json)
│                               - msgStore        (Zalo msgId ↔ TG message_id)
│                               - sentMsgStore    (reverse index TG→Zalo msgId)
│                               - pollStore       (ánh xạ poll ↔ TG poll message)
│                               - mediaGroupStore (buffer media group TG)
│                               - zaloAlbumStore  (buffer album Zalo)
│                               - userCache       (uid ↔ displayName)
│                               - friendsCache    (danh sách bạn, TTL 5 phút)
├── telegram/
│   ├── bot.ts                Instance Telegraf; thiết lập allowedUpdates.
│   └── handler.ts            Xử lý tất cả cập nhật Telegram và forward sang Zalo.
│                             Xử lý: text, media, voice, sticker, poll, location,
│                             contact, reaction, callback_query, poll_answer.
├── zalo/
│   ├── client.ts             Khởi tạo Zalo API và QR login flow.
│   ├── types.ts              Interface TypeScript và hằng số ZALO_MSG_TYPES.
│   └── handler.ts            Xử lý tất cả sự kiện Zalo listener và forward sang TG.
│                             Xử lý: message (tất cả msgType), undo, reaction,
│                             group_event (join/leave/poll/update_board).
└── utils/
    ├── format.ts             Escape HTML, áp dụng mention, helper caption.
    └── media.ts              Download file tạm, dọn dẹp, convert OGG→M4A.
```

---

## File dữ liệu

### `data/topics.json`

Plain JSON. Ánh xạ mỗi ID cuộc trò chuyện Zalo (nhóm hoặc nhắn riêng) tới Telegram Forum Topic ID kèm metadata (tên hiển thị, loại). Được ghi mỗi khi tạo topic mới; đọc một lần lúc khởi động.

### `data/msg-map.json` (nén gzip)

Lưu trữ ánh xạ hai chiều giữa Zalo message ID và Telegram message ID để reply chain không bị mất khi restart. File được **nén gzip** (tự động nhận diện qua magic bytes `0x1F 0x8B` lúc đọc) và dùng **định dạng v2** gọn nhẹ để tối thiểu hoá I/O.

#### Định dạng v2 (áp dụng từ tháng 5/2026)

```jsonc
{
  "v": 2,
  // Bảng intern chuỗi — mỗi chuỗi lặp lại (zaloId, msgType, UID…) chỉ lưu
  // một lần ở đây và được tham chiếu bằng chỉ số trong các mảng dữ liệu bên dưới.
  "s": ["850431…", "webchat", "uid123", …],
  // Cặp ánh xạ: [zaloMsgId, tgMessageId]
  // zaloMsgId là chỉ số trong "s"; tgMessageId là số nguyên thông thường.
  "p": [[0, 123456], [1, 123457], …],
  // Dữ liệu quote theo TG message (dùng cho reply chain và auto-mention):
  // [tgId, msgIdIdx, cliMsgIdIdx, uidFromIdx, ts, msgTypeIdx, content, ttl, zaloIdIdx, threadType]
  "q": [[123456, 0, 1, 2, 1746000000, 5, "hello", 0, 0, 1], …]
}
```

#### Tại sao lọc bỏ các entry `"0"`

Zalo đặt `realMsgId = 0` cho những tin nhắn không có ID phụ. Vì `String(0) === "0"`, trước đây chúng được lưu thành cặp `["0", tgId]` — chiếm tới **45 % tổng số cặp**. Nay chúng bị loại bỏ cả khi ghi (`msgStore.save`) lẫn khi đọc (`_loadMsgMap`):

- Không có lookup nào có nghĩa khi query `"0"`: Zalo message ID thực là số timestamp 13 chữ số, không bao giờ là `0`.
- Giữ chúng gây **lỗi collision ẩn**: nhiều tin nhắn khác nhau đều có `realMsgId = 0` sẽ ghi đè lên cùng một key, khiến `getTgMsgId("0")` trả về TG ID của một tin nhắn tuỳ tiện — tạo ra reply target sai.

#### Lịch sử kích thước

| Định dạng | Kích thước |
|---|---|
| v1 plain JSON | ~80 KB |
| v2 intern + positional arrays | ~46 KB (−44 %) |
| v2 + gzip level 9 + lọc zero | ~13 KB (−85 %) |

`gunzipSync` trên 13 KB nhanh hơn đáng kể so với `JSON.parse` trên 80 KB; module `node:zlib` có sẵn được dùng — không cần thêm dependency.

---

## Bảo mật

- `.env` và `credentials.json` được liệt kê trong `.gitignore` và tuyệt đối không được commit lên version control.
- `credentials.json` chứa session token Zalo tương đương với mật khẩu tài khoản. Cần bảo vệ với mức độ bảo mật tương đương.
- Bridge vận hành theo mô hình single-user: group Telegram phải là riêng tư và chỉ giới hạn cho thành viên tin cậy, vì bất kỳ thành viên nào cũng có thể gửi tin nhắn qua bridge.
- Tất cả request HTTP tới Telegram và Zalo đều dùng TLS. Không có credential nào được ghi vào log.
- Lệnh `/recall` không bị hạn chế trong group — bất kỳ thành viên nào cũng có thể thu hồi tin nhắn do bot gửi. Hãy hạn chế quyền admin bot hoặc tư cách thành viên group nếu đây là mối lo ngại.

---

## License

MIT
