import { ThreadType } from 'zca-js';
import type { ZaloAPI } from './types.js';

/**
 * Reminder referenced by a `chat.ecard` notification.
 *
 * Zalo truncates the e-card `title`, `notifyTxt` and even the nested
 * `params.title` to ~25 characters ("Có một nguyên tắc rất cơ b..."), so the
 * full text has to be read back from the reminder board API.
 */
export type EcardReminderRef =
  | { kind: 'group'; topicId: string }
  | { kind: 'oneone'; reminderId: string };

interface EcardAction {
  actionId?: string;
  data?: string;
}

interface ReminderActionData {
  act?: string;
  act_type?: string;
  data?: string;
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function nonZeroId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id && id !== '0' ? id : null;
}

/** Extract the reminder ID from an e-card `params` JSON string, if it has one. */
export function parseEcardReminderRef(params: string | undefined): EcardReminderRef | null {
  const outer = parseJson<{ actions?: EcardAction[] }>(params);
  for (const action of outer?.actions ?? []) {
    const actionData = parseJson<ReminderActionData>(action.data);
    if (!actionData?.act?.startsWith('remind_')) continue;
    const inner = parseJson<{ topicId?: unknown; reminderId?: unknown }>(actionData.data);
    if (!inner) continue;
    if (actionData.act_type === 'group') {
      const topicId = nonZeroId(inner.topicId);
      if (topicId) return { kind: 'group', topicId };
    } else {
      const reminderId = nonZeroId(inner.reminderId);
      if (reminderId) return { kind: 'oneone', reminderId };
    }
  }
  return null;
}

interface ReminderLike {
  reminderId?: unknown;
  id?: unknown;
  params?: { title?: unknown } | null;
}

function reminderTitle(reminder: ReminderLike | null | undefined): string | null {
  const title = reminder?.params?.title;
  return typeof title === 'string' && title.trim() ? title : null;
}

const ONEONE_PAGE_SIZE = 20;
const ONEONE_MAX_PAGES = 5;

async function findOneOneReminder(api: ZaloAPI, ownerUid: string, reminderId: string): Promise<string | null> {
  for (let page = 1; page <= ONEONE_MAX_PAGES; page++) {
    const list = (await api.getListReminder({ page, count: ONEONE_PAGE_SIZE }, ownerUid, ThreadType.User)) as ReminderLike[];
    if (!Array.isArray(list) || list.length === 0) return null;
    const hit = list.find((r) => String(r.reminderId ?? r.id) === reminderId);
    if (hit) return reminderTitle(hit);
    if (list.length < ONEONE_PAGE_SIZE) return null;
  }
  return null;
}

/**
 * Read the full reminder title behind an e-card. Returns null when Zalo cannot
 * resolve it, so callers keep the truncated e-card text as a fallback.
 *
 * One-to-one reminders are listed per UID: the peer's UID for a normal DM, but
 * the own UID for the self chat ("My Documents"), where listing by the thread
 * ID fails with code -1. Both are tried.
 */
export async function fetchEcardReminderTitle(
  api: ZaloAPI,
  ref: EcardReminderRef,
  threadId: string,
): Promise<string | null> {
  if (ref.kind === 'group') {
    return reminderTitle((await api.getReminder(ref.topicId)) as ReminderLike);
  }
  const ownUid = String(api.getOwnId?.() ?? '');
  const owners = [...new Set([threadId, ownUid].filter((uid) => uid && uid !== '0'))];
  for (const uid of owners) {
    try {
      const title = await findOneOneReminder(api, uid, ref.reminderId);
      if (title) return title;
    } catch {
      // Try the next owner UID.
    }
  }
  return null;
}
