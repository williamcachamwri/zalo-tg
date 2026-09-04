import 'dotenv/config';
import path from 'path';
import { PROJECT_ROOT } from './utils/paths.js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function requireTelegramGroupId(): number {
  const raw = requireEnv('TG_GROUP_ID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value >= 0) {
    throw new Error('TG_GROUP_ID must be a negative safe integer (Telegram supergroup ID)');
  }
  return value;
}

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  // Already absolute → use as-is, otherwise resolve from project root
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function envFlag(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function envPort(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${key} must be a TCP port between 1 and 65535`);
  }
  return value;
}

/**
 * Parse ZALO_EXCLUDE_THREADS: comma-separated "type:id" pairs or bare ids.
 * type: 0 = DM, 1 = group. Bare ids are treated as groups ("1:id").
 * Returns a record keyed by "type:id" so it survives JSON serialization.
 */
function excludeThreads(): Record<string, true> {
  const raw = process.env.ZALO_EXCLUDE_THREADS?.trim() ?? '';
  const out: Record<string, true> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const m = item.match(/^(\d):(.+)$/);
    if (m && (m[1] === '0' || m[1] === '1')) {
      out[`${m[1]}:${m[2]}`] = true;
    } else {
      out[`1:${item}`] = true;
    }
  }
  return out;
}


function localBotApiServer(): string | null {
  if (!envFlag('LOCAL_BOT_API')) return null;
  const raw = requireEnv('TG_LOCAL_SERVER').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('TG_LOCAL_SERVER must be a valid http(s) URL when LOCAL_BOT_API is enabled');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('TG_LOCAL_SERVER must use http or https');
  }
  return raw;
}

export const config = {
  telegram: {
    token:       requireEnv('TG_TOKEN'),
    groupId:     requireTelegramGroupId(),
    /** URL của local Bot API server, ví dụ: http://localhost:8081.
     *  Chỉ dùng khi LOCAL_BOT_API=1 và TG_LOCAL_SERVER được set.
     *  Nếu không → dùng official api.telegram.org. */
    localServer: localBotApiServer(),
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
    skipMutedGroups: envFlag('ZALO_SKIP_MUTED_GROUPS'),
    // Mirror Zalo's "mute notifications" → deliver those threads silently on
    // Telegram (messages still arrive, just no ping). On by default; set
    // ZALO_MUTE_SILENT=0 to always notify.
    muteSilentMirror: envFlag('ZALO_MUTE_SILENT', true),
    // In 1-1 DMs, show Zalo reactions as a native Telegram reaction on the
    // message (default). Set ZALO_DM_NATIVE_REACTION=0 to fall back to the
    // aggregated "❤️ Name" summary reply used in groups (issue #65).
    dmNativeReaction: envFlag('ZALO_DM_NATIVE_REACTION', true),
    // Threads to never mirror, as "type:id" pairs (type 0=DM, 1=group).
    // Bare ids are treated as groups. Messages from these threads are ignored.
    excludeThreads: excludeThreads(),
  },
  httpApi: {
    enabled: envFlag('HTTP_API_ENABLED'),
    host: process.env.HTTP_API_HOST?.trim() || '127.0.0.1',
    port: envPort('HTTP_API_PORT', 3000),
    token: process.env.HTTP_API_TOKEN?.trim() || undefined,
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
} as const;
