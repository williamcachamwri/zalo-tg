# Local Telegram Bot API Server Setup Guide

## Overview

The official Telegram Bot API (api.telegram.org) has a **20 MB file size limit** for downloads. To transfer files larger than 20 MB, you need to run a **local Telegram Bot API server** on your machine with the `--local` flag, which allows transfers up to **2 GB**.

This guide walks you through building and running the local server on **macOS, Linux, and Windows**.

---

## Prerequisites

### macOS & Linux

- **Git**: `git --version`
- **CMake** (≥ 3.0.2): `cmake --version`
- **C++ compiler** with C++17 support
- **OpenSSL** development headers
- **zlib** development headers

### Windows

- **Git**: https://git-scm.com/download/win
- **CMake**: https://cmake.org/download/ (or via Chocolatey)
- **Visual Studio 2019+** with C++ build tools, OR **LLVM/Clang**

---

## Installation

### macOS

#### 1. Install Dependencies

```bash
# Using Homebrew
brew install cmake openssl zlib
```

#### 2. Clone & Build telegram-bot-api

```bash
cd /tmp
git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api
mkdir build
cd build

# Configure
cmake -DCMAKE_BUILD_TYPE=Release -DOPENSSL_DIR="$(brew --prefix openssl)" ..

# Build (adjust -j based on CPU cores)
cmake --build . --target install -j$(sysctl -n hw.logicalcpu)
```

**Result**: Binary installed at `/usr/local/bin/telegram-bot-api`

#### 3. Verify Installation

```bash
telegram-bot-api --version
```

---

### Linux (Ubuntu/Debian)

#### 1. Install Dependencies

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

# Configure
cmake -DCMAKE_BUILD_TYPE=Release ..

# Build
cmake --build . --target install -j$(nproc)
```

**Result**: Binary installed at `/usr/local/bin/telegram-bot-api`

#### 3. Verify Installation

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

# Then follow the same build steps as Ubuntu
```

---

### Windows

#### Option A: Pre-built Binary (Recommended)

1. Download pre-built release: https://github.com/tdlib/telegram-bot-api/releases
2. Extract to a folder (e.g., `C:\telegram-bot-api\`)
3. Open **Command Prompt** or **PowerShell** and verify:

```powershell
C:\telegram-bot-api\telegram-bot-api.exe --version
```

#### Option B: Build from Source

1. **Install Prerequisites**:
   - CMake: https://cmake.org/download/
   - Visual Studio 2019+ with C++ workload, OR LLVM
   - OpenSSL binary distribution (e.g., from https://slproweb.com/products/Win32OpenSSL.html)

2. **Clone & Build**:

```powershell
cd C:\temp
git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api
mkdir build
cd build

# Configure (adjust OpenSSL path as needed)
cmake -DCMAKE_BUILD_TYPE=Release -DOPENSSL_DIR="C:\OpenSSL-Win64" ..

# Build
cmake --build . --config Release --target install
```

**Result**: Binary at `C:\Program Files (x86)\TelegramBotApi\telegram-bot-api.exe`

---

## One-Time Setup: Logout from Official API

Before switching to the local server, you **must** log out from the official Telegram API once:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/logOut"
```

Expected response:
```json
{"ok":true,"result":true}
```

⚠️ **Do this only once.** After this, the bot is logged out from the official API and can only use the local server.

---

## Running the Local Server

### macOS & Linux

#### Method 1: Direct Command

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

#### Method 2: Using Script (zalo-tg project)

```bash
cd /Users/wica/lq/zalo-tg
./run-bot-api.sh
```

Or in the background:

```bash
nohup ./run-bot-api.sh > ~/zalo-tg-bot-api/data/server.log 2>&1 &
```

#### Check Server is Running

```bash
curl http://localhost:8081
```

Expected response: `{"ok":false,"error_code":404,"description":"Not Found"}`

---

### Windows (Command Prompt)

#### Method 1: Direct Command

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

#### Method 2: Running in Background

```powershell
# Start a new window running the server
Start-Process -FilePath "C:\telegram-bot-api\telegram-bot-api.exe" -ArgumentList @(
  "--api-id=<YOUR_API_ID>",
  "--api-hash=<YOUR_API_HASH>",
  "--local",
  "--dir=C:\zalo-tg-bot-api\data",
  "--temp-dir=C:\temp",
  "--http-port=8081"
)
```

#### Check Server is Running

```powershell
curl.exe http://localhost:8081
```

---

## Configuration in zalo-tg

### 1. Update `.env` File

Add or modify:

```env
LOCAL_BOT_API=1
TG_API_ID=<YOUR_API_ID>
TG_API_HASH=<YOUR_API_HASH>
TG_LOCAL_SERVER=http://localhost:8081
TG_TOKEN=<YOUR_BOT_TOKEN>
```

### 2. Rebuild and Restart

```bash
cd /path/to/zalo-tg
npm run build
node dist/index.js
```

The bot will automatically:
- Detect `TG_LOCAL_SERVER` is set
- Use local server for file transfers (up to 2 GB)
- Use direct `file://` paths instead of HTTP downloads

---

## Troubleshooting

### "Port 8081 already in use"

**macOS/Linux**: Find and kill the process
```bash
lsof -i :8081
kill -9 <PID>
```

**Windows (PowerShell)**:
```powershell
netstat -ano | findstr :8081
taskkill /PID <PID> /F
```

### "telegram-bot-api: command not found"

The binary is not in your `PATH`. Either:
- Add the directory to `PATH` environment variable
- Or use the full path: `/usr/local/bin/telegram-bot-api` (macOS/Linux)

### File Transfer Still Limited to 20 MB

**Checklist**:
1. ✅ Did you run `/logOut` on official API? (curl command above)
2. ✅ Is `LOCAL_BOT_API=1` set in `.env`?
3. ✅ Is `TG_LOCAL_SERVER=http://localhost:8081` (or your host/IP:port) set in `.env`?
4. ✅ Is the local server running? (`curl http://localhost:8081`)
5. ✅ Did you rebuild? (`npm run build`)
6. ✅ Did you restart the bot? (kill and re-run)

### Investigate `"Not Found"` with Docker (example: `http://192.168.50.118:8082`)

`{"ok":false,"error_code":404,"description":"Not Found"}` on the server root path is expected.
Use this checklist to verify Docker and networking:

1. **Confirm container is running and port mapping is correct**
   ```bash
   docker compose ps
   docker ps --filter name=telegram-bot-api --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
   ```
   Expected: host port (e.g. `8082`) maps to container `8081` (`0.0.0.0:8082->8081/tcp`).

2. **Check environment variables used by the bridge**
   ```bash
   grep -E '^(LOCAL_BOT_API|TG_LOCAL_SERVER)=' .env
   ```
   Required:
   - `LOCAL_BOT_API=1`
   - `TG_LOCAL_SERVER=http://192.168.50.118:8082` (match your mapped host/IP/port exactly)

3. **Verify API endpoint, not root path**
   ```bash
   # Root path: 404 Not Found is normal
   curl http://192.168.50.118:8082

   # Bot API method must work
   curl "http://192.168.50.118:8082/bot<YOUR_BOT_TOKEN>/getMe"
   ```
   If `/getMe` also returns `Not Found`, the request is not reaching telegram-bot-api correctly.

4. **Read container logs for network/API errors**
   ```bash
   docker logs --tail=200 telegram-bot-api
   docker logs -f telegram-bot-api
   ```
   Look for bind errors, connection errors, invalid requests, or token/method path issues.

### "protocol mismatch: file: expected http:"

This is fixed in the latest code. Ensure you've pulled the latest changes:
```bash
git pull
npm run build
```

### Connection Refused (ECONNREFUSED)

The local server isn't running. Start it:
```bash
./run-bot-api.sh  # macOS/Linux
# Or the full command shown above
```

---

## Systemd Service (Linux, Optional)

To run the server automatically on boot:

**Create `/etc/systemd/system/tg-bot-api.service`**:

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

Enable and start:
```bash
sudo mkdir -p /var/lib/tg-bot-api
sudo systemctl daemon-reload
sudo systemctl enable tg-bot-api
sudo systemctl start tg-bot-api
sudo systemctl status tg-bot-api
```

---

## Windows Task Scheduler (Optional)

To run on boot, create a scheduled task:

1. Open **Task Scheduler**
2. Click **Create Task**
3. **General tab**:
   - Name: `Telegram Bot API Server`
   - ☑️ Run with highest privileges

4. **Triggers tab**: 
   - New trigger → At log on → Everyone

5. **Actions tab**:
   - Action: Start a program
   - Program: `C:\telegram-bot-api\telegram-bot-api.exe`
   - Arguments: `--api-id=<YOUR_API_ID> --api-hash=<YOUR_API_HASH> --local --dir=C:\zalo-tg-bot-api\data --http-port=8081`

6. Click OK

---

## Testing Large File Transfer

Once the local server is running and bot is configured:

1. Send a file **> 20 MB** from Telegram to the group bridged with Zalo
2. The bot will download (now up to 2 GB limit) and forward to Zalo
3. Check logs for success message:
   ```
   [TG→Zalo] Sending <filename> → zaloId=... type=...
   ```

---

## Server Flags Reference

```
telegram-bot-api [--help] [OPTIONS]

Key options:
  -p, --http-port=<port>     HTTP listening port (default: 8081)
  -d, --dir=<dir>            Working directory for bot files
  -t, --temp-dir=<dir>       Temp directory for downloads
  --local                    Enable local mode (2 GB file limit, no net requests)
  -l, --log=<path>           Log file path
  -v, --verbosity=<N>        Verbosity level (1-5)
  --api-id=<id>              Telegram API ID
  --api-hash=<hash>          Telegram API hash
```

---

## File Size Limits

| Mode | Limit |
|------|-------|
| Official API (api.telegram.org) | **20 MB** |
| Local Server (--local flag) | **2 GB** |

---

## Security Notes

⚠️ **Never commit `.env` to Git** — it contains your API credentials.

Add to `.gitignore`:
```
.env
.env.local
```

For production, consider:
- Running the server on a separate machine
- Using environment variables instead of `.env`
- Restricting network access to localhost only
- Using `--filter` option to limit which bots can use the server

---

## References

- [Telegram Bot API Documentation](https://core.telegram.org/bots/api)
- [telegram-bot-api GitHub](https://github.com/tdlib/telegram-bot-api)
- [tdlib Documentation](https://tdlib.github.io/)

---

## Support

If issues persist:
1. Check server logs: `cat ~/zalo-tg-bot-api/data/server.log`
2. Verify bot logs: Check zalo-tg console output
3. Ensure firewall allows port 8081
4. Try restarting both server and bot
