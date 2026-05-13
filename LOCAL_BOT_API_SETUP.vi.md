# Hướng dẫn Thiết lập Local Telegram Bot API Server

## Tổng quan

Telegram Bot API chính thức (api.telegram.org) có giới hạn kích thước tệp **20 MB** khi tải xuống. Để chuyển các tệp lớn hơn 20 MB, bạn cần chạy một **máy chủ Telegram Bot API cục bộ** trên máy của mình với cờ `--local`, cho phép chuyển đến **2 GB**.

Hướng dẫn này hướng dẫn bạn cách xây dựng và chạy máy chủ cục bộ trên **macOS, Linux, và Windows**.

---

## Yêu cầu tiên quyết

### macOS & Linux

- **Git**: `git --version`
- **CMake** (≥ 3.0.2): `cmake --version`
- **Trình biên dịch C++** hỗ trợ C++17
- **OpenSSL** header phát triển
- **zlib** header phát triển

### Windows

- **Git**: https://git-scm.com/download/win
- **CMake**: https://cmake.org/download/ (hoặc qua Chocolatey)
- **Visual Studio 2019+** với C++ build tools, HOẶC **LLVM/Clang**

---

## Cài đặt

### macOS

#### 1. Cài đặt các phụ thuộc

```bash
# Sử dụng Homebrew
brew install cmake openssl zlib
```

#### 2. Clone & Build telegram-bot-api

```bash
cd /tmp
git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api
mkdir build
cd build

# Cấu hình
cmake -DCMAKE_BUILD_TYPE=Release -DOPENSSL_DIR="$(brew --prefix openssl)" ..

# Xây dựng (điều chỉnh -j dựa trên số lõi CPU)
cmake --build . --target install -j$(sysctl -n hw.logicalcpu)
```

**Kết quả**: Tệp nhị phân được cài đặt tại `/usr/local/bin/telegram-bot-api`

#### 3. Xác minh cài đặt

```bash
telegram-bot-api --version
```

---

### Linux (Ubuntu/Debian)

#### 1. Cài đặt các phụ thuộc

```bash
sudo apt-get update
sudo apt-get install -y \
  git \
  cmake \
  g++ \
  make \
  libssl-dev \
  zlib1g-dev \
  pkg-config
```

#### 2. Clone & Build

```bash
cd /tmp
git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api
mkdir build
cd build

# Cấu hình
cmake -DCMAKE_BUILD_TYPE=Release ..

# Xây dựng
cmake --build . --target install -j$(nproc)
```

**Kết quả**: Tệp nhị phân được cài đặt tại `/usr/local/bin/telegram-bot-api`

#### 3. Xác minh cài đặt

```bash
telegram-bot-api --version
```

---

### Linux (Fedora/RHEL)

```bash
sudo yum install -y \
  git \
  cmake \
  gcc-c++ \
  openssl-devel \
  zlib-devel

# Sau đó làm theo các bước xây dựng giống như Ubuntu
```

---

### Windows

#### Tùy chọn A: Tệp nhị phân được xây dựng sẵn (Được khuyến nghị)

1. Tải xuống bản phát hành được xây dựng sẵn: https://github.com/tdlib/telegram-bot-api/releases
2. Giải nén vào một thư mục (ví dụ: `C:\telegram-bot-api\`)
3. Mở **Command Prompt** hoặc **PowerShell** và xác minh:

```powershell
C:\telegram-bot-api\telegram-bot-api.exe --version
```

#### Tùy chọn B: Xây dựng từ nguồn

1. **Cài đặt Yêu cầu tiên quyết**:
   - CMake: https://cmake.org/download/
   - Visual Studio 2019+ với workload C++, HOẶC LLVM
   - OpenSSL binary distribution (ví dụ: từ https://slproweb.com/products/Win32OpenSSL.html)

2. **Clone & Build**:

```powershell
cd C:\temp
git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api
mkdir build
cd build

# Cấu hình (điều chỉnh đường dẫn OpenSSL nếu cần)
cmake -DCMAKE_BUILD_TYPE=Release -DOPENSSL_DIR="C:\OpenSSL-Win64" ..

# Xây dựng
cmake --build . --config Release --target install
```

**Kết quả**: Tệp nhị phân tại `C:\Program Files (x86)\TelegramBotApi\telegram-bot-api.exe`

---

## Thiết lập một lần: Đăng xuất khỏi API chính thức

Trước khi chuyển sang máy chủ cục bộ, bạn **phải** đăng xuất khỏi Telegram API chính thức một lần:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/logOut"
```

Phản hồi dự kiến:
```json
{"ok":true,"result":true}
```

⚠️ **Chỉ làm điều này một lần.** Sau đó, bot sẽ đăng xuất khỏi API chính thức và chỉ có thể sử dụng máy chủ cục bộ.

---

## Chạy Máy chủ cục bộ

### macOS & Linux

#### Phương pháp 1: Lệnh trực tiếp

```bash
mkdir -p ~/zalo-tg-bot-api/data
telegram-bot-api \
  --api-id=<YOUR_API_ID> \
  --api-hash=<YOUR_API_HASH> \
  --local \
  --dir=~/zalo-tg-bot-api/data \
  --temp-dir=/tmp \
  --http-port=8081 \
  --verbosity=1
```

#### Phương pháp 2: Sử dụng Script (dự án zalo-tg)

```bash
cd /Users/wica/lq/zalo-tg
./run-bot-api.sh
```

Hoặc chạy ở chế độ nền:

```bash
nohup ./run-bot-api.sh > ~/zalo-tg-bot-api/data/server.log 2>&1 &
```

#### Kiểm tra máy chủ đang chạy

```bash
curl http://localhost:8081
```

Phản hồi dự kiến: `{"ok":false,"error_code":404,"description":"Not Found"}`

---

### Windows (Command Prompt)

#### Phương pháp 1: Lệnh trực tiếp

```powershell
mkdir C:\zalo-tg-bot-api\data

C:\telegram-bot-api\telegram-bot-api.exe ^
  --api-id=<YOUR_API_ID> ^
  --api-hash=<YOUR_API_HASH> ^
  --local ^
  --dir=C:\zalo-tg-bot-api\data ^
  --temp-dir=C:\temp ^
  --http-port=8081 ^
  --verbosity=1
```

#### Phương pháp 2: Chạy ở chế độ nền

```powershell
# Bắt đầu một cửa sổ mới chạy máy chủ
Start-Process -FilePath "C:\telegram-bot-api\telegram-bot-api.exe" -ArgumentList @(
  "--api-id=<YOUR_API_ID>",
  "--api-hash=<YOUR_API_HASH>",
  "--local",
  "--dir=C:\zalo-tg-bot-api\data",
  "--temp-dir=C:\temp",
  "--http-port=8081"
)
```

#### Kiểm tra máy chủ đang chạy

```powershell
curl.exe http://localhost:8081
```

---

## Cấu hình trong zalo-tg

### 1. Cập nhật tệp `.env`

Thêm hoặc sửa đổi:

```env
LOCAL_BOT_API=1
TG_API_ID=<YOUR_API_ID>
TG_API_HASH=<YOUR_API_HASH>
TG_LOCAL_SERVER=http://localhost:8081
TG_TOKEN=<YOUR_BOT_TOKEN>
```

### 2. Xây dựng lại và Khởi động lại

```bash
cd /path/to/zalo-tg
npm run build
node dist/index.js
```

Bot sẽ tự động:
- Phát hiện `TG_LOCAL_SERVER` được đặt
- Sử dụng máy chủ cục bộ để chuyển tệp (lên đến 2 GB)
- Sử dụng đường dẫn `file://` trực tiếp thay vì tải xuống HTTP

---

## Khắc phục sự cố

### "Port 8081 đã được sử dụng"

**macOS/Linux**: Tìm và kết thúc quy trình
```bash
lsof -i :8081
kill -9 <PID>
```

**Windows (PowerShell)**:
```powershell
netstat -ano | findstr :8081
taskkill /PID <PID> /F
```

### "telegram-bot-api: lệnh không tìm thấy"

Tệp nhị phân không có trong `PATH` của bạn. Hãy:
- Thêm thư mục vào biến môi trường `PATH`
- Hoặc sử dụng đường dẫn đầy đủ: `/usr/local/bin/telegram-bot-api` (macOS/Linux)

### Chuyển tệp vẫn bị giới hạn ở 20 MB

**Danh sách kiểm tra**:
1. ✅ Bạn đã chạy `/logOut` trên API chính thức? (lệnh curl ở trên)
2. ✅ `LOCAL_BOT_API=1` có được đặt trong `.env`?
3. ✅ `TG_LOCAL_SERVER=http://localhost:8081` (hoặc host/IP:port của bạn) có được đặt trong `.env`?
4. ✅ Máy chủ cục bộ có đang chạy? (`curl http://localhost:8081`)
5. ✅ Bạn đã xây dựng lại? (`npm run build`)
6. ✅ Bạn đã khởi động lại bot? (kết thúc và chạy lại)

### Điều tra lỗi `"Not Found"` với Docker (ví dụ: `http://192.168.50.118:8082`)

Phản hồi `{"ok":false,"error_code":404,"description":"Not Found"}` ở đường dẫn gốc của server là bình thường.
Hãy dùng checklist sau để xác minh Docker và network:

1. **Xác nhận container đang chạy và map port đúng**
   ```bash
   docker compose ps
   docker ps --filter name=telegram-bot-api --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
   ```
   Kỳ vọng: port host (ví dụ `8082`) map vào `8081` trong container (`0.0.0.0:8082->8081/tcp`).

2. **Kiểm tra biến môi trường bridge đang dùng**
   ```bash
   grep -E '^(LOCAL_BOT_API|TG_LOCAL_SERVER)=' .env
   ```
   Bắt buộc:
   - `LOCAL_BOT_API=1`
   - `TG_LOCAL_SERVER=http://192.168.50.118:8082` (khớp chính xác host/IP/port đã map)

3. **Kiểm tra endpoint API thay vì đường dẫn gốc**
   ```bash
   # Đường dẫn gốc: 404 Not Found là bình thường
   curl http://192.168.50.118:8082

   # Method của Bot API phải chạy được
   curl "http://192.168.50.118:8082/bot<YOUR_BOT_TOKEN>/getMe"
   ```
   Nếu `/getMe` cũng trả về `Not Found`, request chưa đi đúng vào telegram-bot-api.

4. **Đọc log container để tìm lỗi network/API**
   ```bash
   docker logs --tail=200 telegram-bot-api
   docker logs -f telegram-bot-api
   ```
   Tìm các lỗi bind port, connection, request không hợp lệ, hoặc sai token/path method.

### "protocol mismatch: file: expected http:"

Lỗi này đã được sửa trong mã mới nhất. Đảm bảo bạn đã lấy các thay đổi mới nhất:
```bash
git pull
npm run build
```

### Kết nối bị từ chối (ECONNREFUSED)

Máy chủ cục bộ không chạy. Bắt đầu nó:
```bash
./run-bot-api.sh  # macOS/Linux
# Hoặc lệnh đầy đủ được hiển thị ở trên
```

---

## Dịch vụ Systemd (Linux, Tùy chọn)

Để chạy máy chủ tự động khi khởi động:

**Tạo `/etc/systemd/system/tg-bot-api.service`**:

```ini
[Unit]
Description=Telegram Bot API Local Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/lib/tg-bot-api
ExecStart=/usr/local/bin/telegram-bot-api \
  --api-id=<YOUR_API_ID> \
  --api-hash=<YOUR_API_HASH> \
  --local \
  --dir=/var/lib/tg-bot-api \
  --temp-dir=/tmp \
  --http-port=8081
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Bật và bắt đầu:
```bash
sudo mkdir -p /var/lib/tg-bot-api
sudo systemctl daemon-reload
sudo systemctl enable tg-bot-api
sudo systemctl start tg-bot-api
sudo systemctl status tg-bot-api
```

---

## Windows Task Scheduler (Tùy chọn)

Để chạy khi khởi động, tạo một tác vụ được lên lịch:

1. Mở **Task Scheduler**
2. Nhấp vào **Create Task**
3. Tab **General**:
   - Tên: `Telegram Bot API Server`
   - ☑️ Chạy với đặc quyền cao nhất

4. Tab **Triggers**: 
   - New trigger → At log on → Everyone

5. Tab **Actions**:
   - Action: Start a program
   - Program: `C:\telegram-bot-api\telegram-bot-api.exe`
   - Arguments: `--api-id=<YOUR_API_ID> --api-hash=<YOUR_API_HASH> --local --dir=C:\zalo-tg-bot-api\data --http-port=8081`

6. Nhấp OK

---

## Kiểm tra chuyển tệp lớn

Sau khi máy chủ cục bộ chạy và bot được cấu hình:

1. Gửi một tệp **> 20 MB** từ Telegram đến nhóm được cầu nối với Zalo
2. Bot sẽ tải xuống (hiện nay lên đến giới hạn 2 GB) và chuyển tiếp đến Zalo
3. Kiểm tra nhật ký để tìm thông báo thành công:
   ```
   [TG→Zalo] Sending <filename> → zaloId=... type=...
   ```

---

## Tham chiếu Cờ máy chủ

```
telegram-bot-api [--help] [OPTIONS]

Tùy chọn chính:
  -p, --http-port=<port>     Port nghe HTTP (mặc định: 8081)
  -d, --dir=<dir>            Thư mục làm việc cho tệp bot
  -t, --temp-dir=<dir>       Thư mục tạm để tải xuống
  --local                    Bật chế độ cục bộ (giới hạn tệp 2 GB, không có yêu cầu mạng)
  -l, --log=<path>           Đường dẫn tệp nhật ký
  -v, --verbosity=<N>        Mức chi tiết (1-5)
  --api-id=<id>              ID API Telegram
  --api-hash=<hash>          Hash API Telegram
```

---

## Giới hạn kích thước tệp

| Chế độ | Giới hạn |
|------|---------|
| API chính thức (api.telegram.org) | **20 MB** |
| Máy chủ cục bộ (cờ --local) | **2 GB** |

---

## Ghi chú bảo mật

⚠️ **Không bao giờ commit `.env` vào Git** — nó chứa thông tin xác thực API của bạn.

Thêm vào `.gitignore`:
```
.env
.env.local
```

Đối với sản xuất, hãy xem xét:
- Chạy máy chủ trên một máy riêng biệt
- Sử dụng biến môi trường thay vì `.env`
- Hạn chế quyền truy cập mạng chỉ đến localhost
- Sử dụng tùy chọn `--filter` để giới hạn những bot nào có thể sử dụng máy chủ

---

## Tài liệu tham khảo

- [Tài liệu Telegram Bot API](https://core.telegram.org/bots/api)
- [telegram-bot-api GitHub](https://github.com/tdlib/telegram-bot-api)
- [Tài liệu tdlib](https://tdlib.github.io/)

---

## Hỗ trợ

Nếu vấn đề vẫn tiếp diễn:
1. Kiểm tra nhật ký máy chủ: `cat ~/zalo-tg-bot-api/data/server.log`
2. Xác minh nhật ký bot: Kiểm tra đầu ra bảng điều khiển zalo-tg
3. Đảm bảo tường lửa cho phép port 8081
4. Thử khởi động lại cả máy chủ và bot
