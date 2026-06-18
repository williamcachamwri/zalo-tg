import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ThreadType } from 'zca-js';
import { config } from '../config.js';
import { sentMsgStore } from '../store.js';
import type { ZaloAPI } from './types.js';

/**
 * Bridge-level auto-reply ("offline mode").
 *
 * NOTE: zca-js's createAutoReply targets zBusiness/OA accounts and fails on
 * normal personal accounts, so we implement auto-reply here instead: when
 * enabled, the bridge replies to incoming Zalo DMs via api.sendMessage.
 * Only 1-1 (User) threads are answered — groups are never auto-replied to.
 */

export interface AutoReplyState {
  enabled: boolean;
  message: string;
}

const FILE = path.join(config.dataDir, 'autoreply.json');

/**
 * Anti-ban guards. Automated replies are the strongest "bot" signal Zalo can
 * detect, so we keep them sparse and human-like:
 *  - per-peer cooldown: at most one auto-reply per person every 30 min
 *  - global cap: at most 12 auto-replies per rolling hour (avoids mass-send
 *    bursts when many people message at once)
 *  - human-like delay: wait 3–8 s before replying (instant replies are an
 *    obvious bot tell)
 */
const COOLDOWN_MS = 30 * 60 * 1000;       // 30 minutes per peer
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 8000;

/** Exported so user-facing copy stays in sync with the real values. */
export const AUTO_REPLY_COOLDOWN_MIN = COOLDOWN_MS / 60_000;
export const AUTO_REPLY_MAX_PER_HOUR = 12;

const lastRepliedAt = new Map<string, number>();

/** Each reservation has a unique id so a failed send removes ONLY its own slot
 *  (filtering by timestamp would drop other slots sharing the same millisecond). */
interface Reservation { id: number; ts: number; }
let recentReplies: Reservation[] = [];
let _resSeq = 0;

/** Negative, monotonically-decreasing synthetic TG ids — never collide with
 *  real Telegram message ids (which are positive). */
let _syntheticTgSeq = -1;

let state: AutoReplyState = { enabled: false, message: '' };

function load(): void {
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<AutoReplyState>;
      state = { enabled: Boolean(raw.enabled), message: String(raw.message ?? '') };
    }
  } catch (err) {
    console.warn('[AutoReply] Failed to load state:', err);
  }
}
load();

function save(): void {
  try {
    writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AutoReply] Failed to save state:', err);
  }
}

export function getAutoReplyState(): AutoReplyState {
  return { ...state };
}

export function setAutoReplyEnabled(enabled: boolean, message?: string): AutoReplyState {
  state = { enabled, message: message !== undefined ? message : state.message };
  save();
  return getAutoReplyState();
}

/**
 * Fire an auto-reply to an incoming Zalo DM if enabled and not on cooldown.
 * Returns true if a reply was actually sent.
 */
export async function maybeAutoReply(
  api: ZaloAPI,
  threadId: string,
  threadType: number,
): Promise<boolean> {
  if (!state.enabled || !state.message.trim()) return false;
  if (threadType !== ThreadType.User) return false; // DMs only, never groups

  const now = Date.now();

  // Per-peer cooldown.
  if (now - (lastRepliedAt.get(threadId) ?? 0) < COOLDOWN_MS) return false;

  // Global hourly cap — prune old timestamps, then check.
  recentReplies = recentReplies.filter(r => now - r.ts < GLOBAL_WINDOW_MS);
  if (recentReplies.length >= AUTO_REPLY_MAX_PER_HOUR) {
    console.warn('[AutoReply] Global hourly cap reached — skipping (anti-ban)');
    return false;
  }

  // Reserve slots BEFORE the async delay so concurrent messages don't double-send.
  lastRepliedAt.set(threadId, now);
  const reservation: Reservation = { id: ++_resSeq, ts: now };
  recentReplies.push(reservation);

  // Human-like delay: never reply in milliseconds.
  const jitter = MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  await new Promise(r => setTimeout(r, jitter));

  // Suppress the Zalo self-echo so the bridge's own reply is not re-forwarded
  // into the Telegram topic (consistent with every TG→Zalo send path).
  sentMsgStore.markSending(threadId);
  try {
    const res = await api.sendMessage({ msg: state.message }, threadId, ThreadType.User) as
      { message?: { msgId?: string | number } };
    const zMsgId = res?.message?.msgId;
    if (zMsgId !== undefined) {
      sentMsgStore.save(_syntheticTgSeq--, { msgIds: [zMsgId], zaloId: threadId, threadType: 0 });
    }
    console.log(`[AutoReply] Sent auto-reply to ${threadId} (after ${jitter}ms)`);
    return true;
  } catch (err) {
    console.warn('[AutoReply] Failed to send:', err);
    // Keep the per-peer cooldown (do NOT hammer a failing peer); only release the
    // global-cap slot — by id, so we never drop another reply's reservation.
    recentReplies = recentReplies.filter(r => r.id !== reservation.id);
    return false;
  } finally {
    sentMsgStore.unmarkSending(threadId);
  }
}
