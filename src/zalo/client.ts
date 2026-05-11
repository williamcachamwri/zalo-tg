import { Zalo, LoginQRCallbackEventType } from 'zca-js';
import type { LoginQRCallback } from 'zca-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { imageSizeFromFile } from 'image-size/fromFile';
import qrcode from 'qrcode-terminal';
import { dirname } from 'path';
import { config } from '../config.js';
import type { ZaloAPI } from './types.js';

const QR_IMAGE_PATH = '/tmp/zalo-qr.png';

const qrDir = dirname(QR_IMAGE_PATH);
if (!existsSync(qrDir)) mkdirSync(qrDir, { recursive: true });

let _api: ZaloAPI | null = null;

// ── imageMetadataGetter ───────────────────────────────────────────────────────
// Required by zca-js for uploadAttachment (images/GIFs).
const ZALO_OPTIONS = {
  logging:      false,
  checkUpdate:  false,
  selfListen:   true,
  imageMetadataGetter: async (filePath: string) => {
    try {
      const { width, height } = await imageSizeFromFile(filePath);
      const { size } = statSync(filePath);
      return { width: width ?? 0, height: height ?? 0, size };
    } catch {
      return null;
    }
  },
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QRLoginHooks {
  /** Called when a new QR image file is ready at `imagePath`. */
  onQRReady?: (imagePath: string, code: string) => Promise<void>;
  /** Called when the current QR expired and a new one is being generated. */
  onExpired?: () => Promise<void>;
  /** Called when the user scanned the QR on their phone. */
  onScanned?: (displayName: string) => Promise<void>;
  /** Called when the user declined the login on their phone. */
  onDeclined?: () => Promise<void>;
  /** Called after credentials have been saved and login is complete. */
  onSuccess?: () => Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function saveCredentials(data: { cookie: unknown; imei: string; userAgent: string }): void {
  try {
    writeFileSync(
      config.zalo.credentialsPath,
      JSON.stringify({ imei: data.imei, cookie: data.cookie, userAgent: data.userAgent }, null, 2),
      'utf8',
    );
    console.log(`[Zalo] Credentials saved → ${config.zalo.credentialsPath}`);
  } catch (err) {
    console.error('[Zalo] Failed to save credentials:', err);
  }
}

/**
 * Core QR login flow.
 * - Always prints QR to terminal.
 * - Calls optional `hooks` so callers (e.g. Telegram handler) can forward
 *   the QR image or status messages elsewhere.
 */
async function runQRLogin(
  zalo: InstanceType<typeof Zalo>,
  hooks: QRLoginHooks = {},
): Promise<ZaloAPI> {
  const callback: LoginQRCallback = (event) => {
    switch (event.type) {

      case LoginQRCallbackEventType.QRCodeGenerated: {
        const { code } = event.data;

        // Save QR image first, then notify hooks
        const savePromise = (event.actions.saveToFile(QR_IMAGE_PATH) as Promise<unknown>)
          .then(async () => {
            // Print to terminal
            await new Promise<void>((res) => {
              qrcode.generate(code, { small: true }, (qrStr) => {
                console.clear();
                console.log('┌─────────────────────────────────────────┐');
                console.log('│      Quét QR bằng ứng dụng Zalo         │');
                console.log('└─────────────────────────────────────────┘\n');
                console.log(qrStr);
                console.log(`(Ảnh QR: ${QR_IMAGE_PATH})\n`);
                res();
              });
            });
            // Notify external hook (e.g. send to Telegram)
            await hooks.onQRReady?.(QR_IMAGE_PATH, code);
          })
          .catch((err: unknown) => console.error('[Zalo] QR hook error:', err));

        void savePromise;
        break;
      }

      case LoginQRCallbackEventType.QRCodeExpired: {
        console.log('\n[Zalo] QR hết hạn, đang tạo mã mới...');
        void hooks.onExpired?.().catch((e: unknown) => console.error(e));
        event.actions.retry();
        break;
      }

      case LoginQRCallbackEventType.QRCodeScanned: {
        const name = event.data.display_name;
        console.log(`\n[Zalo] ✓ Đã quét! Chờ xác nhận từ "${name}"...`);
        void hooks.onScanned?.(name).catch((e: unknown) => console.error(e));
        break;
      }

      case LoginQRCallbackEventType.QRCodeDeclined: {
        console.error('\n[Zalo] Đăng nhập bị từ chối.');
        void hooks.onDeclined?.().catch((e: unknown) => console.error(e));
        event.actions.abort();
        break;
      }

      case LoginQRCallbackEventType.GotLoginInfo: {
        saveCredentials(event.data);
        void hooks.onSuccess?.().catch((e: unknown) => console.error(e));
        break;
      }
    }
  };

  const api = await zalo.loginQR({ qrPath: QR_IMAGE_PATH }, callback);
  if (!api) throw new Error('[Zalo] QR login failed – no API returned.');
  console.log('\n[Zalo] Đăng nhập thành công ✓');
  return api as ZaloAPI;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return (and lazily initialise) the Zalo API singleton.
 * Only uses saved credentials — does NOT fall back to QR login.
 * If credentials are missing or invalid, throws so the caller can notify
 * the user (e.g. via Telegram) to run /login.
 */
export async function getZaloApi(): Promise<ZaloAPI> {
  if (_api) return _api;

  if (!existsSync(config.zalo.credentialsPath)) {
    throw new Error('Chưa có file credentials.json — hãy gửi /login trong Telegram để đăng nhập lần đầu.');
  }

  const zalo = new Zalo(ZALO_OPTIONS);

  const credentials = JSON.parse(
    readFileSync(config.zalo.credentialsPath, 'utf8'),
  ) as { imei: string; cookie: unknown; userAgent: string };

  console.log('[Zalo] Đang đăng nhập bằng credentials đã lưu...');
  _api = (await zalo.login(credentials as Parameters<typeof zalo.login>[0])) as ZaloAPI;
  console.log('[Zalo] Đăng nhập thành công ✓');

  return _api as ZaloAPI;
}

/**
 * Trigger a fresh QR login (e.g. from /login Telegram command).
 * Resets the cached API so the next `getZaloApi()` call will re-initialise.
 * Accepts optional hooks so the caller can forward QR images / status updates.
 */
export async function triggerQRLogin(hooks: QRLoginHooks = {}): Promise<ZaloAPI> {
  _api = null;
  const zalo = new Zalo(ZALO_OPTIONS);
  _api = await runQRLogin(zalo, hooks);
  return _api;
}