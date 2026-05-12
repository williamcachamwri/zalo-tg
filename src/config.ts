import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Root của project (src/../) */
const PROJECT_ROOT = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
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

export const config = {
  telegram: {
    token:       requireEnv('TG_TOKEN'),
    groupId:     Number(requireEnv('TG_GROUP_ID')),
    /** URL của local Bot API server, ví dụ: http://localhost:8081.
     *  Nếu không set → dùng official api.telegram.org. */
    localServer: process.env.TG_LOCAL_SERVER?.replace(/\/$/, '') || null,
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
    skipMutedGroups: envFlag('ZALO_SKIP_MUTED_GROUPS'),
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
} as const;
