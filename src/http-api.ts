import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ThreadType } from 'zca-js';
import { config } from './config.js';
import { store, sentMsgStore } from './store.js';
import type { TopicEntry } from './store.js';
import type { ZaloAPI } from './zalo/types.js';

export interface HttpApiOptions {
  /** Return the currently connected Zalo API, or null while logged out. */
  getApi: () => ZaloAPI | null;
}

let server: Server | null = null;

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

const SELECTORS = ['topicId', 'name', 'zaloId'] as const;

function hasSelectorValue(value: unknown): boolean {
  return value !== undefined && value !== null
    && (typeof value !== 'string' || value.trim() !== '');
}

function parseTopicId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parseZaloId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function parseThreadType(value: unknown): 0 | 1 | undefined {
  if (value === 'group' || value === 1 || value === '1') return 1;
  if (value === 'user' || value === 0 || value === '0') return 0;
  return undefined;
}

export function selectorKeys(body: Record<string, unknown>): string[] {
  return SELECTORS.filter((key) => hasSelectorValue(body[key]));
}

export function resolveTarget(body: Record<string, unknown>): TopicEntry | { zaloId: string; type: 0 | 1 } | null {
  const selectors = selectorKeys(body);
  if (selectors.length !== 1) return null;
  const selector = selectors[0];
  if (selector === 'topicId') {
    const topicId = parseTopicId(body.topicId);
    if (topicId === null) return null;
    return store.getEntryByTopic(topicId) ?? null;
  }
  if (selector === 'name') {
    if (typeof body.name !== 'string') return null;
    const query = normalized(body.name);
    const matches = store.all().filter((entry) => normalized(entry.name).includes(query));
    return matches.length === 1 ? matches[0] : null;
  }
  const id = parseZaloId(body.zaloId);
  if (id === null) return null;
  const matches = store.all().filter((entry) => entry.zaloId === id);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  const type = parseThreadType(body.type);
  return type === undefined ? null : { zaloId: id, type };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk as string | Buffer);
    if (size > 1024 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(Buffer.from(chunk as string | Buffer));
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('Body must be a JSON object'), { status: 400 });
  }
}

export function startHttpApi(options: HttpApiOptions): Server {
  if (server) return server;
  server = http.createServer(async (req, res) => {
    if (req.url !== '/send') {
      json(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      json(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    if (config.httpApi.token && req.headers.authorization !== `Bearer ${config.httpApi.token}`) {
      json(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }
    try {
      const body = await readBody(req);
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 10000) {
        json(res, 422, { ok: false, error: 'message must be a non-empty string (max 10000 characters)' });
        return;
      }
      const selectors = selectorKeys(body);
      if (selectors.length !== 1) {
        json(res, 422, { ok: false, error: 'Provide exactly one target selector: topicId, name, or zaloId' });
        return;
      }
      const target = resolveTarget(body);
      if (!target) {
        if (selectors[0] === 'zaloId' && parseThreadType(body.type) === undefined) {
          json(res, 422, { ok: false, error: 'type is required for an unmapped zaloId (use user or group)' });
          return;
        }
        json(res, 404, { ok: false, error: 'Target not found or ambiguous' });
        return;
      }
      const api = options.getApi();
      if (!api) { json(res, 503, { ok: false, error: 'Zalo is not connected' }); return; }
      const threadType = target.type === 1 ? ThreadType.Group : ThreadType.User;
      sentMsgStore.markSending(target.zaloId);
      try {
        const result = await api.sendMessage({ msg: body.message }, target.zaloId, threadType);
        const messageId = result?.message?.msgId ?? result?.attachment?.[0]?.msgId;
        json(res, 200, { ok: true, zaloId: target.zaloId, type: target.type, messageId });
      } finally {
        sentMsgStore.unmarkSending(target.zaloId);
      }
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      json(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(config.httpApi.port, config.httpApi.host);
  return server;
}

export function getHttpApiServer(): Server | null { return server; }

export async function closeHttpApi(): Promise<void> {
  if (!server) return;
  const active = server;
  server = null;
  await new Promise<void>((resolve) => active.close(() => resolve()));
}
