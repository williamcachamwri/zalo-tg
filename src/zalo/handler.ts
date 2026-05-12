import { ThreadType, FriendEventType } from 'zca-js';
import { createReadStream } from 'fs';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage, ZaloMediaContent, ZaloGroupInfoResponse } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store } from '../store.js';
import { tgBot } from '../telegram/bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';
import { applyMentionsHtml, applyZaloMarkupHtml, formatGroupMsgHtml, formatGroupMsg, groupCaption, topicName, truncate, escapeHtml } from '../utils/format.js';
import type { ZaloStyle } from '../utils/format.js';
import { msgStore, userCache, pollStore, sentMsgStore, zaloAlbumStore, reactionEchoStore, reactionSummaryStore, aliasCache, type ZaloQuoteData } from '../store.js';
import { tgQueue } from '../utils/tgQueue.js';

// Proxy that routes every tg.* call through the rate-limit queue
// so 429 errors are auto-retried instead of crashing the process.
const tg = new Proxy(tgBot.telegram, {
  get(target, prop: string) {
    const orig = (target as unknown as Record<string, unknown>)[prop];
    if (typeof orig !== 'function') return orig;
    return (...args: unknown[]) =>
      tgQueue(() => (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args));
  },
}) as typeof tgBot.telegram;

// ── Bank card HTML parser ────────────────────────────────────────────────────
interface BankCardInfo {
  bankName: string;
  accountNumber: string;
  holderName?: string;
  vietqr: string;
}

function parseBankCardHtml(html: string): BankCardInfo | null {
  const ptags = [...html.matchAll(/<p[^>]*>([^<]+)<\/p>/g)]
    .map(m => m[1].trim()).filter(t => t.length > 0);

  const normalised = html.replace(/&amp;/g, '&');
  const contentMatch = normalised.match(/content=([^&"< ]+)/);
  if (!contentMatch) return null;
  const vietqr = decodeURIComponent(contentMatch[1]);

  // p-tag order from Zalo HTML: [BIN, BankName, AccountNumber, HolderName?, ...]
  const numericTags = ptags.filter(t => /^\d+$/.test(t));
  const textTags    = ptags.filter(t => !/^\d+$/.test(t));

  const accountNumber = numericTags.find(t => t.length !== 6) ?? numericTags[1] ?? numericTags[0] ?? '';
  const bankName      = textTags[0] ?? '';
  const holderName    = textTags[1]?.trim() || undefined;

  if (!vietqr) return null;
  return { bankName, accountNumber, holderName, vietqr };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch group member list and populate `userCache` so mention resolution works
 * immediately even before any group message is received.
 */
async function populateGroupMemberCache(api: ZaloAPI, groupId: string): Promise<void> {
  try {
    const info = await api.getGroupInfo(groupId) as {
      gridInfoMap?: Record<string, {
        memVerList?: string[];
        totalMember?: number;
      }>;
    };
    const groupData = info?.gridInfoMap?.[groupId];
    if (!groupData) {
      console.warn(`[Zalo] getGroupInfo: no data for group ${groupId}`);
      return;
    }

    // memVerList entries are "uid_version" — extract UIDs
    const uids = (groupData.memVerList ?? [])
      .map(s => s.split('_')[0])
      .filter(Boolean);
    if (uids.length === 0) {
      console.warn(`[Zalo] group ${groupId}: empty memVerList (totalMember=${groupData.totalMember})`);
      return;
    }

    // Batch-fetch display names (getUserInfo accepts up to ~50 per call)
    const BATCH = 50;
    let saved = 0;
    for (let i = 0; i < uids.length; i += BATCH) {
      const batch = uids.slice(i, i + BATCH);
      const resp = await api.getUserInfo(batch) as {
        changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        unchanged_profiles?: Record<string, unknown>;
      };
      const profiles = resp?.changed_profiles ?? {};
      // unchanged_profiles also has profile data
      const unchanged = resp?.unchanged_profiles ?? {};
      for (const uid of batch) {
        const p = (profiles[uid] ?? unchanged[uid]) as { displayName?: string; zaloName?: string } | undefined;
        const name = p?.displayName?.trim() || p?.zaloName?.trim();
        if (uid && name) { userCache.saveForGroup(uid, name, groupId); saved++; }
      }
    }
    console.log(`[Zalo] Cached ${saved}/${uids.length} members for group ${groupId}`);
  } catch (err) {
    console.warn(`[Zalo] populateGroupMemberCache failed for ${groupId}:`, err);
  }
}

// ── Group info cache (avoid repeated getGroupInfo on every message) ───────────
interface GroupInfoEntry { name: string; avt?: string; ts: number }
const _groupInfoCache = new Map<string, GroupInfoEntry>();
const GROUP_INFO_TTL = 5 * 60 * 1000; // 5 min

async function getCachedGroupInfo(
  api: ZaloAPI,
  zaloId: string,
): Promise<{ name?: string; avt?: string }> {
  const hit = _groupInfoCache.get(zaloId);
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL) return hit;
  try {
    const info = await api.getGroupInfo(zaloId) as ZaloGroupInfoResponse;
    const entry: GroupInfoEntry = {
      name: info?.gridInfoMap?.[zaloId]?.name ?? '',
      avt:  info?.gridInfoMap?.[zaloId]?.avt,
      ts:   Date.now(),
    };
    _groupInfoCache.set(zaloId, entry);
    return entry;
  } catch { return {}; }
}

// ── Muted group cache (avoid repeated getMute on every message) ───────────────
interface ZaloMuteEntry {
  id: string;
  duration: number;
  startTime: number;
  systemTime?: number;
  currentTime?: number;
}

const MUTED_GROUPS_TTL = 60 * 1000; // 1 min
let _mutedGroupsCache: { ids: Set<string>; ts: number } | null = null;

function isActiveMute(entry: ZaloMuteEntry): boolean {
  if (entry.duration === -1) return true;
  if (entry.duration <= 0) return false;

  const now = entry.currentTime ?? entry.systemTime ?? Math.floor(Date.now() / 1000);
  const expiresAt = entry.startTime + entry.duration;
  return now < expiresAt;
}

async function isMutedZaloGroup(api: ZaloAPI, groupId: string): Promise<boolean> {
  if (!config.zalo.skipMutedGroups) return false;

  const cached = _mutedGroupsCache;
  if (cached && Date.now() - cached.ts < MUTED_GROUPS_TTL) {
    return cached.ids.has(groupId);
  }

  try {
    const muteInfo = await api.getMute() as { groupChatEntries?: ZaloMuteEntry[] };
    const mutedIds = new Set(
      (muteInfo.groupChatEntries ?? [])
        .filter(isActiveMute)
        .map(entry => String(entry.id)),
    );
    _mutedGroupsCache = { ids: mutedIds, ts: Date.now() };
    return mutedIds.has(groupId);
  } catch (err) {
    console.warn('[Zalo→TG] Failed to check muted Zalo groups; forwarding message:', err);
    return false;
  }
}

// In-flight topic creation promises — prevents duplicate topic creation when
// many messages arrive concurrently for the same conversation (e.g. 20-photo album).
const _pendingTopics = new Map<string, Promise<number>>();

async function resolveUserDisplayName(api: ZaloAPI, uid: string | undefined, fallback = 'ai đó'): Promise<string> {
  const cleanUid = uid?.trim();
  if (!cleanUid) return fallback;

  const cached = userCache.getName(cleanUid);
  if (cached?.trim()) return cached;

  try {
    const resp = await api.getUserInfo(cleanUid) as {
      changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
      unchanged_profiles?: Record<string, unknown>;
    };
    const profile = (resp?.changed_profiles?.[cleanUid] ?? resp?.unchanged_profiles?.[cleanUid]) as
      | { displayName?: string; zaloName?: string }
      | undefined;
    const name = profile?.displayName?.trim() || profile?.zaloName?.trim();
    if (name) {
      userCache.save(cleanUid, name);
      return name;
    }
  } catch (err) {
    console.warn(`[Zalo] resolveUserDisplayName failed for ${cleanUid}:`, err);
  }

  return cleanUid || fallback;
}

async function getOrCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl?: string,
  forceRecreate = false,
): Promise<number> {
  if (!forceRecreate) {
    const existing = store.getTopicByZalo(zaloId, type);
    if (existing !== undefined) return existing;
  }

  const pendingKey = `${type}:${zaloId}`;
  const inFlight = _pendingTopics.get(pendingKey);
  if (inFlight) return inFlight;

  const promise = _doCreateTopic(zaloId, type, displayName, avatarUrl)
    .finally(() => _pendingTopics.delete(pendingKey));
  _pendingTopics.set(pendingKey, promise);
  return promise;
}

/**
 * Check if a TG API error means the topic/thread was deleted.
 * If so, remove the stale mapping and re-throw so the caller can recreate.
 */
function isTopicDeletedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('message thread not found') || msg.includes('TOPIC_CLOSED') || msg.includes('thread not found');
}

/**
 * Wrapper around a TG send call: if it fails because the topic was deleted,
 * remove stale mapping, recreate the topic, and retry once.
 */
async function sendWithTopicRecovery<T>(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl: string | undefined,
  sendFn: (topicId: number) => Promise<T>,
  currentTopicId: number,
): Promise<T> {
  try {
    return await sendFn(currentTopicId);
  } catch (err) {
    if (!isTopicDeletedError(err)) throw err;
    console.warn(`[Zalo→TG] Topic ${currentTopicId} deleted — removing mapping and recreating for ${zaloId}`);
    store.remove(currentTopicId);
    const newTopicId = await getOrCreateTopic(zaloId, type, displayName, avatarUrl, true);
    return sendFn(newTopicId);
  }
}

async function _doCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl?: string,
): Promise<number> {
  // Re-check after acquiring "lock" — another concurrent call may have finished
  const existing = store.getTopicByZalo(zaloId, type);
  if (existing !== undefined) return existing;

  const name  = topicName(displayName, type);
  const color = type === ThreadType.Group ? 0xFF93B2 : 0x6FB9F0;

  let topic: { message_thread_id: number };
  try {
    topic = await tg.createForumTopic(
      config.telegram.groupId,
      name,
      { icon_color: color },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not enough rights') || msg.includes('TOPIC_') || msg.includes('rights to manage')) {
      console.error(`[Zalo→TG] Cannot create topic — bot lacks "Manage Topics" admin right. Falling back to General topic.`);
      // Use topic ID 1 (General) as fallback so messages still get delivered
      const fallbackId = 1;
      store.set({ topicId: fallbackId, zaloId, type, name: displayName });
      return fallbackId;
    }
    throw err;
  }

  const topicId = topic.message_thread_id;
  store.set({ topicId, zaloId, type, name: displayName });
  console.log(`[Zalo→TG] New topic: "${name}" (topicId=${topicId})`);

  // Pin group avatar as the first message in the topic
  if (type === 1 /* Group */ && avatarUrl) {
    try {
      const localPath = await downloadToTemp(avatarUrl, `avatar_${Date.now()}.jpg`);
      const stream = createReadStream(localPath);
      const avatarMsg = await tg.sendPhoto(
        config.telegram.groupId,
        { source: stream },
        {
          message_thread_id: topicId,
          caption: `🖼 Ảnh đại diện nhóm <b>${escapeHtml(displayName)}</b>`,
          parse_mode: 'HTML',
        },
      );
      await cleanTemp(localPath);
      try {
        await tg.pinChatMessage(config.telegram.groupId, avatarMsg.message_id, { disable_notification: true });
      } catch { /* pinning requires admin rights */ }
    } catch (avatarErr) {
      console.warn(`[Zalo→TG] Failed to pin group avatar for ${displayName}:`, avatarErr);
    }
  }

  return topicId;
}

/**
 * Parse `content` field which is either a JSON string, a plain string, or
 * already an object. Returns a normalised `ZaloMediaContent` object.
 */
function parseContent(raw: string | ZaloMediaContent | Record<string, unknown>): {
  text: string | null;
  media: ZaloMediaContent;
} {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ZaloMediaContent;
      return { text: null, media: parsed };
    } catch {
      // plain text string
      return { text: raw, media: {} };
    }
  }
  return { text: null, media: raw as ZaloMediaContent };
}

// ── Poll helpers ─────────────────────────────────────────────────────────────

import type { PollOptions } from 'zca-js';

function buildScoreText(header: string, options: Pick<PollOptions, 'content' | 'votes'>[], closed: boolean): string {
  const total = options.reduce((s, o) => s + (o.votes ?? 0), 0);
  const lines = options.map(o => {
    const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `${escapeHtml(o.content)}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
  });
  const status = closed ? ' <i>[Đã đóng]</i>' : '';
  return `📊 <b>${escapeHtml(header)}</b>${status}\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
}

// ── Main handler ─────────────────────────────────────────────────────────────

/** Track which groups already had their member cache populated this session. */
const _memberCacheLoaded = new Set<string>();

/**
 * In-flight dedup set — holds msgIds that are currently being processed.
 * Prevents race condition where multiple reaction re-emits arrive concurrently
 * before any of them is saved to msgStore, causing all to pass the msgStore check.
 */
const _inFlightMsgIds = new Set<string>();

export async function setupZaloHandler(api: ZaloAPI): Promise<void> {
  // Pre-populate userCache for all existing group topics on startup
  for (const entry of store.all()) {
    if (entry.type === 1 /* Group */) {
      void populateGroupMemberCache(api, entry.zaloId);
      _memberCacheLoaded.add(entry.zaloId);
    }
  }

  // Load alias list (tên danh bạ) BEFORE attaching listeners so that the first
  // message event already has aliases available for topic naming.
  try {
    const result = await api.getAliasList() as { items?: Array<{ userId: string; alias: string }> };
    if (result?.items?.length) {
      aliasCache.setAll(result.items);
      console.log(`[Zalo] Loaded ${result.items.length} aliases from address book`);
    }
  } catch (err) {
    console.warn('[Zalo] Failed to load alias list:', err);
  }

  api.listener.on('message', async (msg: ZaloMessage) => {
    try {
      // Skip messages sent by the bot (TG→Zalo echo) but NOT messages
      // the user sends directly from the Zalo app.
      // We check both sentMsgStore (post-save) and isSendingTo (race window).
      if (msg.isSelf) {
        const selfMsgIds = [msg.data.msgId, msg.data.realMsgId]
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const isEcho =
          selfMsgIds.some(id => sentMsgStore.getByZaloMsgId(id) !== undefined)
          || sentMsgStore.isSendingTo(msg.threadId);
        if (isEcho) {
          console.log(`[Zalo→TG] Skip bot echo (${selfMsgIds.join(', ')})`);
          return;
        }
        // isSelf but NOT a bot echo → user sent from Zalo app, forward to TG
      }

      // Skip duplicate deliveries — Zalo re-emits the same message event when
      // someone reacts (❤️, 👍, etc.), causing the same content to be forwarded
      // multiple times. Check both the persistent store AND the in-flight set
      // (handles concurrent re-emits that arrive before any is saved to msgStore).
      const _primaryMsgId = msg.data.msgId;
      if (_primaryMsgId) {
        if (msgStore.getTgMsgId(_primaryMsgId) !== undefined || _inFlightMsgIds.has(_primaryMsgId)) {
          console.log(`[Zalo→TG] Skip duplicate/reaction re-emit msgId=${_primaryMsgId}`);
          return;
        }
        _inFlightMsgIds.add(_primaryMsgId);
        // Auto-remove from in-flight after 10 s (msgStore.save will be the permanent record)
        setTimeout(() => _inFlightMsgIds.delete(_primaryMsgId), 10_000);
      }

      const zaloId     = msg.threadId;
      const type       = msg.type as 0 | 1;
      const senderName = msg.data.dName ?? msg.data.uidFrom;
      const msgType    = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;

      if (type === ThreadType.Group && await isMutedZaloGroup(api, zaloId)) {
        console.log(`[Zalo→TG] Skip muted group ${zaloId}`);
        return;
      }

      // Pre-populate member cache the first time we see a new group
      if (type === 1 && !_memberCacheLoaded.has(zaloId)) {
        _memberCacheLoaded.add(zaloId);
        void populateGroupMemberCache(api, zaloId);
      }

      // Keep userCache up-to-date so TG→Zalo mention resolution works
      if (type === ThreadType.Group) {
        userCache.saveForGroup(msg.data.uidFrom, senderName, zaloId);
      } else {
        userCache.save(msg.data.uidFrom, senderName);
      }

      // Parse content early so we can start media download in parallel with topic resolution
      const { text, media } = parseContent(msg.data.content);

      // Determine media URL eagerly (before topic lookup) so download starts immediately
      const _eagerMediaUrl = (() => {
        if (msgType === ZALO_MSG_TYPES.VIDEO || msgType === ZALO_MSG_TYPES.VOICE ||
            msgType === ZALO_MSG_TYPES.GIF   || msgType === ZALO_MSG_TYPES.FILE) return media.href;
        if (msgType === ZALO_MSG_TYPES.PHOTO) {
          let u = media.href;
          try { const p = JSON.parse(media.params ?? '{}') as { hd?: string }; if (p.hd) u = p.hd; } catch {}
          return u;
        }
        return undefined;
      })();
      const _extGuess = _eagerMediaUrl
        ? (path.extname(_eagerMediaUrl.split('?')[0] ?? '').toLowerCase() || '.bin')
        : '.bin';
      // Start download immediately; we'll await it inside the type-specific branch
      const earlyDlPromise = _eagerMediaUrl
        ? downloadToTemp(_eagerMediaUrl, `dl_${Date.now()}${_extGuess}`)
        : null;

      // Resolve display name:
      //   - Group: use group name from getGroupInfo
      //   - DM: use the PEER's name (zaloId = peer UID), not the sender's name
      let displayName = senderName;
      let groupAvatarUrl: string | undefined;
      if (type === ThreadType.Group) {
        const info = await getCachedGroupInfo(api, zaloId);
        displayName = info.name || senderName;
        groupAvatarUrl = info.avt;
      } else {
        // For DMs, zaloId is the peer's UID — resolve their real name then apply alias
        const realName = await resolveUserDisplayName(api, zaloId, senderName);
        displayName = aliasCache.label(zaloId, realName);
      }

      const topicId = await getOrCreateTopic(zaloId, type, displayName, groupAvatarUrl);

      // Resolve Telegram reply target from incoming Zalo quote (if any)
      let tgReplyMsgId: number | undefined;
      if (msg.data.quote) {
        const globalId = String(msg.data.quote.globalMsgId);
        // Primary: messages received from Zalo and forwarded to TG.
        // IMPORTANT: Zalo globalMsgId is NOT unique across groups — validate the found
        // mapping belongs to the same thread to avoid quoting a message from a different group.
        const _candidateTg = msgStore.getTgMsgId(globalId);
        if (_candidateTg !== undefined) {
          const _quoteData = msgStore.getQuote(_candidateTg);
          if (!_quoteData || _quoteData.zaloId === zaloId) {
            tgReplyMsgId = _candidateTg;
          } else {
            console.warn(`[Zalo→TG] Quote globalMsgId=${globalId} maps to thread ${_quoteData.zaloId} but current thread is ${zaloId} — ignoring stale cross-group mapping`);
          }
        }
        // Fallback: messages we sent from TG to Zalo (reverse lookup), also validate thread
        if (tgReplyMsgId === undefined) {
          const _sentTg = sentMsgStore.getByZaloMsgId(globalId);
          if (_sentTg !== undefined) {
            const _sentInfo = sentMsgStore.get(_sentTg);
            if (!_sentInfo || _sentInfo.zaloId === zaloId) {
              tgReplyMsgId = _sentTg;
            }
          }
        }
      }

      // Base TG send options (with optional reply_parameters)
      const tgBase: {
        message_thread_id: number;
        reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
      } = { message_thread_id: topicId };
      if (tgReplyMsgId !== undefined) {
        tgBase.reply_parameters = { message_id: tgReplyMsgId, allow_sending_without_reply: true };
      }

      const caption = groupCaption(senderName);
      const tgOpts  = { ...tgBase, parse_mode: 'HTML' as const, caption };

      // Build quote data + mapping helper — saved after every successful TG send
      const zaloMsgIds = [
        msg.data.msgId,
        ...(msg.data.realMsgId && msg.data.realMsgId !== msg.data.msgId ? [msg.data.realMsgId] : []),
        ...(msg.data.cliMsgId && msg.data.cliMsgId !== msg.data.msgId ? [msg.data.cliMsgId] : []),
      ];
      const zaloQuoteData: ZaloQuoteData = {
        msgId:    msg.data.msgId,
        cliMsgId: msg.data.cliMsgId ?? '',
        uidFrom:  msg.data.uidFrom,
        ts:       msg.data.ts,
        msgType:  msgType,
        // For text messages (content is a plain string), keep it as-is so zca-js
        // can send it as qmsg. For media messages (photo, video, etc.), store the
        // parsed object so prepareQMSGAttach builds a correct thumbnail reference
        // (thumb/href fields) instead of receiving a raw JSON string.
        content:  text !== null
          ? (msg.data.content as string)
          : (media as Record<string, unknown>),
        ttl:      msg.data.ttl ?? 0,
        zaloId,
        threadType: type,
      };
      const saveTgMapping = (sent: { message_id: number }) => {
        msgStore.save(sent.message_id, zaloMsgIds, zaloQuoteData);
      };

      // ── 1. Plain text ──────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.TEXT || (text !== null)) {
        const body = text ?? (typeof msg.data.content === 'string' ? msg.data.content : '');
        if (!body.trim()) return;
        const mentions = msg.data.mentions;

        // Parse Zalo text-style metadata (bold, italic, underline, strike)
        // The server stores it as a JSON string in the `textProperties` field
        // which is not typed in TMessage but IS present in the raw data.
        let styles: ZaloStyle[] | undefined;
        try {
          const rawProps = (msg.data as unknown as Record<string, unknown>).textProperties;
          if (typeof rawProps === 'string' && rawProps) {
            const parsed = JSON.parse(rawProps) as { styles?: ZaloStyle[] };
            if (Array.isArray(parsed.styles) && parsed.styles.length > 0) {
              styles = parsed.styles;
            }
          }
        } catch { /* ignore malformed textProperties */ }

        const bodyHtml = (mentions?.length || styles?.length)
          ? applyZaloMarkupHtml(truncate(body), mentions, styles)
          : escapeHtml(truncate(body));
        const tgText = formatGroupMsgHtml(senderName, bodyHtml);
        const sent = await tg.sendMessage(
          config.telegram.groupId,
          tgText,
          { ...tgBase, parse_mode: 'HTML' },
        );
        saveTgMapping(sent);
        return;
      }

      // ── 2. Photo / Image ───────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.PHOTO) {
        // prefer HD from params, fall back to href
        let url = media.href;
        if (media.params) {
          try {
            const p = JSON.parse(media.params) as { hd?: string };
            if (p.hd) url = p.hd;
          } catch { /* ignore */ }
        }
        if (!url) { console.warn('[ZaloHandler] Photo: no URL found in content:', media); return; }

        // Caption attached to the photo by the sender (Zalo stores it in the `title` field)
        const photoCaption = media.title?.trim() || undefined;

        const childnumber: number = (media as { childnumber?: number }).childnumber ?? 0;
        const albumKey = `${zaloId}:${msg.data.uidFrom}`;

        // If childnumber > 0 OR there's already a buffer for this key → album mode
        const hasBuffer = (typeof zaloAlbumStore as unknown as { _has?: (k: string) => boolean })._has?.(albumKey);
        void hasBuffer; // unused, we detect via the add callback

        zaloAlbumStore.add(
          albumKey,
          url,
          zaloMsgIds,
          { senderName, topicId, tgBase, zaloQuote: zaloQuoteData },
          async (buf) => {
            if (buf.urls.length === 1) {
              // Single photo — reuse eagerly started download (likely already done)
              const singleUrl = buf.urls[0]!;
              const localPath = await (earlyDlPromise ?? downloadToTemp(singleUrl, `photo_${Date.now()}.jpg`));
              const stream = createReadStream(localPath);
              try {
                const sent = await tg.sendPhoto(
                  config.telegram.groupId,
                  { source: stream },
                  {
                    ...buf.tgBase,
                    parse_mode: 'HTML' as const,
                    caption: photoCaption
                      ? `${groupCaption(buf.senderName)}
${escapeHtml(photoCaption)}`
                      : groupCaption(buf.senderName),
                  },
                );
                // Use buf.zaloQuote which already has the correct cliMsgId and
                // parsed media content object (not raw JSON string).
                msgStore.save(sent.message_id, buf.zaloMsgIds, buf.zaloQuote!);
              } finally { await cleanTemp(localPath); }
            } else {
              // Multi-photo album — download all concurrently and send as media group
              const localPaths: string[] = [];
              try {
                const dlResults = await Promise.allSettled(buf.urls.map(u => downloadToTemp(u, `photo_${Date.now()}.jpg`)));
                const dlPaths = dlResults.flatMap(r => {
                  if (r.status === 'fulfilled') return [r.value];
                  console.warn('[ZaloHandler] Album: skipping failed photo download:', r.reason);
                  return [];
                });
                if (dlPaths.length === 0) return;
                localPaths.push(...dlPaths);
                const captionText = photoCaption
                  ? `${groupCaption(buf.senderName)}
${escapeHtml(photoCaption)}`
                  : groupCaption(buf.senderName);
                // Telegram limits media groups to 10 items — split into batches
                const BATCH = 10;
                let firstSaved = false;
                for (let i = 0; i < localPaths.length; i += BATCH) {
                  const batch = localPaths.slice(i, i + BATCH);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const mediaItems: any[] = batch.map((lp, j) => ({
                    type: 'photo',
                    media: { source: createReadStream(lp) },
                    ...(i === 0 && j === 0 && captionText ? { caption: captionText, parse_mode: 'HTML' } : {}),
                  }));
                  const sentMsgs = await tg.sendMediaGroup(
                    config.telegram.groupId,
                    mediaItems,
                    { message_thread_id: buf.topicId } as Parameters<typeof tg.sendMediaGroup>[2],
                  );
                  // Save mapping for the very first photo (for reply chain)
                  if (!firstSaved && sentMsgs.length > 0) {
                    firstSaved = true;
                    // Use buf.zaloQuote (correct cliMsgId + parsed media object)
                    msgStore.save(sentMsgs[0]!.message_id, buf.zaloMsgIds, buf.zaloQuote!);
                  }
                }
              } finally {
                for (const lp of localPaths) await cleanTemp(lp);
              }
            }
          },
        );

        return;
      }

      // ── 2b. Doodle (sketch/drawing) ────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.DOODLE) {
        const url = media.href || media.thumb;
        if (!url) { console.warn('[ZaloHandler] Doodle: no URL'); return; }
        const localPath = await downloadToTemp(url, `doodle_${Date.now()}.jpg`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }


      if (msgType === ZALO_MSG_TYPES.GIF) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] GIF: no URL found in content:', media);
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `gif_${Date.now()}${ext}`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendAnimation(
            config.telegram.groupId,
            { source: stream },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 4. File ────────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.FILE) {
        const url = media.href;
        // title holds the original filename (e.g. "report.pdf")
        const fileName = media.title ?? `file_${Date.now()}`;
        if (!url) {
          console.warn('[ZaloHandler] File: no URL found in content:', media);
          return;
        }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, fileName));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendDocument(
            config.telegram.groupId,
            { source: stream, filename: fileName },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 5. Video ───────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.VIDEO) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Video: no URL found in content:', media); return; }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `video_${Date.now()}.mp4`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendVideo(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 6. Voice ───────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.VOICE) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Voice: no URL found in content:', media); return; }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.m4a';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `voice_${Date.now()}${ext}`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendVoice(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // ── 7. Sticker – fetch real URL via getStickersDetail ──────────────────
      if (msgType === ZALO_MSG_TYPES.STICKER) {
        const stickerId = media.id;
        if (!stickerId) {
          console.warn('[ZaloHandler] Sticker: no id in content:', media);
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details: any[] = await api.getStickersDetail([stickerId]);
          const detail = details?.[0];
          // Animated stickers only have stickerSpriteUrl (sprite sheet) — no static webp/url
          const isAnimated = !detail?.stickerWebpUrl && !detail?.stickerUrl && !!detail?.stickerSpriteUrl;
          const url: string | undefined =
            detail?.stickerWebpUrl ?? detail?.stickerUrl ?? detail?.stickerSpriteUrl;
          if (!url) {
            console.warn('[ZaloHandler] Sticker: no URL in detail:', detail);
            return;
          }
          const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.webp';
          const localPath = await downloadToTemp(url, `sticker_${Date.now()}${ext}`);
          try {
            let sent: { message_id: number };
            if (isAnimated) {
              // Animated stickers are sprite sheets — send as photo with label
              const animCaption = `${groupCaption(senderName)} <i>(sticker động 🎥)</i>`;
              const stream = createReadStream(localPath);
              sent = await tg.sendPhoto(config.telegram.groupId, { source: stream }, {
                ...tgBase,
                caption: animCaption,
                parse_mode: 'HTML',
              });
            } else {
              try {
                // Try native TG sticker (webp ≤512 KB displays as a proper sticker)
                const stream = createReadStream(localPath);
                sent = await tg.sendSticker(
                  config.telegram.groupId,
                  { source: stream },
                  tgBase as Parameters<typeof tg.sendSticker>[2],
                );
              } catch {
                // Fall back to photo if file is too large or format unsupported
                const stream = createReadStream(localPath);
                sent = await tg.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
              }
            }
            saveTgMapping(sent);
          } finally { await cleanTemp(localPath); }
        } catch (stickerErr) {
          console.error('[ZaloHandler] Sticker fetch error:', stickerErr);
        }
        return;
      }

      // ── 8. Link (chat.recommended) ─────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.LINK) {
        // `href` is the canonical URL; fall back to `src` or the `msg` text field
        // (both can carry the URL in some Zalo client versions).
        const rawMedia = media as Record<string, unknown>;
        const href = media.href
          || (typeof rawMedia['src']  === 'string' ? rawMedia['src']  : '')
          || (typeof rawMedia['msg']  === 'string' ? rawMedia['msg']  : '')
          || '';
        const title = media.title
          || (typeof rawMedia['desc'] === 'string' ? rawMedia['desc'] : '')
          || href;
        if (!href) {
          console.warn('[ZaloHandler] Link: no URL found in content:', JSON.stringify(rawMedia));
          return;
        }
        const safeTitle = escapeHtml(title);
        const linkText  = `${groupCaption(senderName)}\n<a href="${href}">${safeTitle}</a>`;
        const sent = await tg.sendMessage(config.telegram.groupId, linkText, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        return;
      }

      // ── 9. Web content (Zalo instant: bank card, mini app, etc.) ──────────
      if (msgType === ZALO_MSG_TYPES.WEBCONTENT) {
        // For bank cards: fetch HTML, parse data, send QR image + caption
        if (media.action === 'zinstant.bankcard' && media.params) {
          try {
            const parsedParams = JSON.parse(media.params) as {
              pcItem?: { data_url?: string };
              item?:   { data_url?: string };
            };
            const dataUrl = parsedParams.pcItem?.data_url ?? parsedParams.item?.data_url;
            if (dataUrl) {
              const htmlResp = await fetch(`${dataUrl}?data=html`);
              const html = await htmlResp.text();
              const info = parseBankCardHtml(html);
              if (info) {
                const qrBuf = await QRCode.toBuffer(info.vietqr, {
                  width: 300, margin: 2,
                  color: { dark: '#000000ff', light: '#ffffffff' },
                });
                let caption = `🏦 <b>Tài khoản ngân hàng</b>`;
                if (info.bankName)      caption += `\nNgân hàng: <b>${info.bankName}</b>`;
                if (info.accountNumber) caption += `\nSTK: <code>${info.accountNumber}</code>`;
                if (info.holderName)    caption += `\nChủ TK: <b>${info.holderName}</b>`;
                const fullCaption = `${groupCaption(senderName)}\n${caption}`;
                const sent = await tg.sendPhoto(
                  config.telegram.groupId,
                  { source: qrBuf },
                  { ...tgBase, caption: fullCaption, parse_mode: 'HTML' },
                );
                saveTgMapping(sent);
                return;
              }
            }
          } catch (err) {
            console.error('[ZaloHandler] bankcard parse error:', err);
          }
        }

        // Generic webcontent fallback
        let label = media.title || '';
        try {
          if (media.params) {
            const p = JSON.parse(media.params) as {
              customMsg?: { msg?: { vi?: string; en?: string } };
            };
            const vi = p.customMsg?.msg?.vi;
            const en = p.customMsg?.msg?.en;
            if (vi && vi.trim()) label = vi.trim();
            else if (en && en.trim()) label = en.trim();
          }
        } catch { /* use fallback */ }
        if (!label) label = '[Nội dung web]';

        const ACTION_ICONS: Record<string, string> = {
          'zinstant.bankcard': '🏦',
          'zinstant.transfer': '💸',
          'zinstant.invoice':  '🧾',
          'zinstant.qr':       '📷',
        };
        const icon = ACTION_ICONS[media.action ?? ''] ?? '📋';
        const body = `${icon} ${label}`;
        const text = `${groupCaption(senderName)}\n${body}`;
        const sent = await tg.sendMessage(config.telegram.groupId, text, {
          ...tgBase,
          parse_mode: 'HTML',
        });
        saveTgMapping(sent);
        return;
      }

      // ── 10. Location ───────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.LOCATION) {
        let lat: number | undefined;
        let lng: number | undefined;
        try {
          const p = JSON.parse(media.params ?? '{}') as { latitude?: number; longitude?: number };
          lat = p.latitude;
          lng = p.longitude;
        } catch { /* ignore */ }

        if (lat !== undefined && lng !== undefined) {
          // Send as native TG location — shows map preview with Maps button
          const sent = await tg.sendLocation(
            config.telegram.groupId,
            lat,
            lng,
            { ...tgBase } as Parameters<typeof tg.sendLocation>[3],
          );
          // Send sender name as a follow-up caption since sendLocation has no HTML caption
            await tg.sendMessage(
              config.telegram.groupId,
              `${groupCaption(senderName)}📍 Vị trí`,
              { ...tgBase, parse_mode: 'HTML' },
            );
          saveTgMapping(sent);
        } else {
          // Fallback: Google Maps link
          const mapsUrl = media.href || '#';
          const body    = `📍 <a href="${mapsUrl}">Vị trí</a>`;
          const text    = `${groupCaption(senderName)}\n${body}`;
          const sent    = await tg.sendMessage(config.telegram.groupId, text, { ...tgBase, parse_mode: 'HTML' });
          saveTgMapping(sent);
        }
        return;
      }

      // ── 11. Poll ────────────────────────────────────────────────────────────
      if (msgType === ZALO_MSG_TYPES.POLL) {
        let pollId: number | undefined;
        let question = '';
        let isAnonymous = false;
        let action = '';
        try {
          const p = JSON.parse(media.params ?? '{}') as {
            pollId?: number;
            question?: string;
            isAnonymous?: boolean;
            action?: string;
          };
          pollId      = p.pollId;
          question    = p.question ?? '';
          isAnonymous = p.isAnonymous ?? false;
          action      = media.action ?? '';
        } catch { /* ignore */ }

        console.log(`[ZaloHandler] Poll event: action="${action}" pollId=${pollId}`);

        if (!pollId) return;

        // Fetch full poll details (options + vote counts)
        let pollDetail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
        try {
          pollDetail = await api.getPollDetail(pollId);
          console.log(`[ZaloHandler] Poll detail: num_vote=${pollDetail?.num_vote} options=`, pollDetail?.options?.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(','));
        } catch (e) {
          console.warn('[ZaloHandler] getPollDetail failed:', e);
        }

        const existingEntry = pollStore.getByPollId(pollId);
        console.log(`[ZaloHandler] Poll existingEntry=${existingEntry ? 'found' : 'NOT found'}`);
        type ZaloPollOption = { option_id: number; content: string; votes: number; voted: boolean; voters: string[] };

        if (action === 'create' && !existingEntry) {
          const options: ZaloPollOption[] = pollDetail?.options ?? [];
          if (options.length < 2) {
            // Can't create TG poll with < 2 options, send as text
            const text = type === ThreadType.Group
              ? `${groupCaption(senderName)}📊 <b>${escapeHtml(question)}</b>\n<i>Cuộc bình chọn mới (${options.length} lựa chọn)</i>`
              : `📊 <b>${escapeHtml(question)}</b>`;
            const sent = await tg.sendMessage(config.telegram.groupId, text, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
            return;
          }

          const header = type === ThreadType.Group
            ? `${senderName} tạo bình chọn`
            : 'Bình chọn mới';

          const tgPollMsg = await tg.sendPoll(
            config.telegram.groupId,
            question,
            options.map(o => o.content),
            {
              ...tgBase,
              is_anonymous:        isAnonymous,
              allows_multiple_answers: pollDetail?.allow_multi_choices ?? false,
              question_parse_mode: undefined,
            } as Parameters<typeof tg.sendPoll>[3],
          );

          // Send editable score message below
          const scoreText = buildScoreText(header, pollDetail?.options ?? [], pollDetail?.closed ?? false);
          const tgScoreMsg = await tg.sendMessage(
            config.telegram.groupId,
            scoreText,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          );

          pollStore.save({
            pollId,
            zaloGroupId:  zaloId,
            tgPollMsgId:  tgPollMsg.message_id,
            tgPollUUID:   (tgPollMsg as { poll?: { id?: string } }).poll?.id ?? '',
            tgScoreMsgId: tgScoreMsg.message_id,
            tgThreadId:   topicId,
            options: options.map(o => ({ option_id: o.option_id, content: o.content })),
          });
          saveTgMapping(tgPollMsg);
        } else {
          // ── Vote update (or unknown existing poll after restart) ──────────
          // Small delay so Zalo server has time to record the vote before we fetch
          await new Promise(r => setTimeout(r, 800));
          let updatedDetail = pollDetail;
          try { updatedDetail = await api.getPollDetail(pollId); } catch { /* use existing */ }
          const header = type === ThreadType.Group
            ? `${senderName} vừa bình chọn`
            : 'Cập nhật bình chọn';
          const detailOptions = updatedDetail?.options ?? [];
          const scoreText = buildScoreText(
            header,
            detailOptions.length > 0 ? detailOptions : (existingEntry?.options.map(o => ({ ...o, votes: 0, voted: false, voters: [] })) ?? []),
            updatedDetail?.closed ?? false,
          );
          console.log(`[ZaloHandler] Poll ${pollId} score:`, detailOptions.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));

          if (existingEntry) {
            try {
              await tg.editMessageText(
                config.telegram.groupId,
                existingEntry.tgScoreMsgId,
                undefined,
                scoreText,
                {
                  parse_mode: 'HTML',
                  reply_markup: updatedDetail?.closed
                    ? { inline_keyboard: [] }
                    : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] },
                },
              );
              console.log(`[ZaloHandler] Poll ${pollId} score message edited OK`);
            } catch (editErr) {
              console.warn(`[ZaloHandler] Poll ${pollId} edit failed, sending new:`, editErr);
              const newScore = await tg.sendMessage(
                config.telegram.groupId,
                scoreText,
                { message_thread_id: existingEntry.tgThreadId, parse_mode: 'HTML',
                  reply_parameters: { message_id: existingEntry.tgPollMsgId, allow_sending_without_reply: true } },
              );
              pollStore.updateScoreMsg(pollId, newScore.message_id);
            }
          } else {
            // existingEntry lost (bot restarted) — just send score as standalone message
            const sent = await tg.sendMessage(
              config.telegram.groupId,
              scoreText,
              { ...tgBase, parse_mode: 'HTML' },
            );
            saveTgMapping(sent);
          }
        }
        return;
      }

      // ── Fallback ───────────────────────────────────────────────────────────
      // Before fallback: detect contact card by content shape (contactUid field)
      // Zalo sends contact cards as msgType 'chat.forward' with contactUid in content
      {
        const rawContent = msg.data.content;
        const contactUid: string | undefined =
          (typeof rawContent === 'object' && rawContent !== null && 'contactUid' in rawContent)
            ? String((rawContent as Record<string, unknown>).contactUid)
            : (media.contactUid ? String(media.contactUid) : undefined);

        if (contactUid || msgType === ZALO_MSG_TYPES.CONTACT) {
          const uid = contactUid ?? '';
          // Fetch display name from userCache or API
          let contactName = userCache.getName(uid) ?? uid;
          if (uid && contactName === uid) {
            try {
              const resp = await api.getUserInfo(uid) as {
                changed_profiles?: Record<string, { displayName?: string }>;
              };
              contactName = resp?.changed_profiles?.[uid]?.displayName ?? uid;
              if (contactName !== uid) userCache.save(uid, contactName);
            } catch { /* non-fatal */ }
          }
          const qrUrl: string | undefined =
            (typeof rawContent === 'object' && rawContent !== null && 'qrCodeUrl' in rawContent)
              ? String((rawContent as Record<string, unknown>).qrCodeUrl)
              : media.qrCodeUrl;

          const body = `👤 <b>Danh thiếp</b>\nTên: <b>${escapeHtml(contactName)}</b>\nZalo ID: <code>${uid}</code>`;
          const fullText = type === ThreadType.Group ? `${groupCaption(senderName)}\n${body}` : body;

          if (qrUrl) {
            // Send QR code image + caption
            try {
              const localPath = await downloadToTemp(qrUrl, `qr_${Date.now()}.jpg`);
              const stream = createReadStream(localPath);
              const sent = await tg.sendPhoto(
                config.telegram.groupId,
                { source: stream },
                { ...tgBase, caption: fullText, parse_mode: 'HTML' },
              );
              saveTgMapping(sent);
              await cleanTemp(localPath);
            } catch {
              const sent = await tg.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
              saveTgMapping(sent);
            }
          } else {
            const sent = await tg.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
          }
          return;
        }
      }

      console.log(`[ZaloHandler] Unhandled msgType="${msgType}" content:`, JSON.stringify(msg.data.content));
      const fallback = type === ThreadType.Group
        ? `${groupCaption(senderName)}\n<i>[${msgType}]</i>`
        : `<i>[${msgType}]</i>`;
      const sentFallback = await tg.sendMessage(config.telegram.groupId, fallback, {
        ...tgBase,
        parse_mode: 'HTML',
      });
      saveTgMapping(sentFallback);
    } catch (err) {
      // If the TG topic was deleted, clear the stale mapping so the next message
      // from this conversation will trigger topic recreation automatically.
      if (isTopicDeletedError(err)) {
        const staleTopicId = store.getTopicByZalo(msg.threadId, msg.type as 0 | 1);
        if (staleTopicId !== undefined) {
          console.warn(`[Zalo→TG] Topic ${staleTopicId} was deleted — removing stale mapping for ${msg.threadId}`);
          store.remove(staleTopicId);
        }
      } else {
        console.error('[ZaloHandler] Error:', err);
      }
    }
  });

  // ── Undo (thu hồi tin nhắn) ────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('undo', async (undo: any) => {
    try {
      const data = undo?.data;
      // The recalled Zalo message ID.
      // Group chat: content.globalMsgId is set.
      // Personal chat: globalMsgId=0, realMsgId="0", but content.cliMsgId is the cliMsgId
      // of the recalled message (which we also store in _zaloToTg via zaloMsgIds).
      const rawMsgId =
        (data?.content?.globalMsgId && data.content.globalMsgId !== 0)
          ? String(data.content.globalMsgId)
          : (data?.content?.cliMsgId && String(data.content.cliMsgId) !== '0')
            ? String(data.content.cliMsgId)
            : '';
      const zaloMsgId = rawMsgId;
      if (!zaloMsgId) {
        console.log(`[ZaloHandler] Undo: could not resolve msgId, raw undo data:`, JSON.stringify(data));
        return;
      }

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Undo: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      // Find which topic this message belongs to
      const zaloId = undo?.threadId ?? data?.idTo;
      const type   = (undo?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) return;

      // Reply to the original forwarded TG message to notify it was recalled on Zalo
      await tg.sendMessage(
        config.telegram.groupId,
        `<i>🗑 Tin nhắn này đã bị thu hồi trên Zalo</i>`,
        {
          message_thread_id: topicId,
          parse_mode: 'HTML',
          reply_parameters: { message_id: tgMsgId, allow_sending_without_reply: true },
        },
      );
      console.log(`[ZaloHandler] Undo: notified recall for TG msg ${tgMsgId} (zaloMsgId=${zaloMsgId})`);
    } catch (err) {
      console.error('[ZaloHandler] Undo error:', err);
    }
  });

  // ── Reaction (cảm xúc) ─────────────────────────────────────────────────────
  const REACTION_EMOJI: Record<string, string> = {
    '/-heart':   '❤️',
    '/-strong':  '👍',
    ':>':        '😄',
    ':o':        '😮',
    ':-((':      '😢',
    ':-h':       '😡',
    ':-*':       '😘',
    ":')":       '😂',
    '/-shit':    '💩',
    '/-rose':    '🌹',
    '/-break':   '💔',
    '/-weak':    '👎',
    ';xx':       '🥰',
    ';-/':       '😕',
    ';-)':       '😉',
    '/-fade':    '✨',
    '/-ok':      '👌',
    '/-v':       '✌️',
    '/-thanks':  '🙏',
    '/-punch':   '👊',
    '/-no':      '🙅',
    '/-loveu':   '🤟',
    '--b':       '😞',
    ':((': '😭',
    'x-)':       '😎',
    '_()_':      '🙏',
    '/-bd':      '🎂',
    '/-bome':    '💣',
    '/-beer':    '🍺',
    '/-li':      '☀️',
    '/-share':   '🔁',
    '/-bad':     '😤',
    '':          '❌',  // remove reaction
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('reaction', async (reaction: any) => {
    try {
      const data = reaction?.data;
      const rIcon: string = data?.content?.rIcon ?? '';
      const emoji = REACTION_EMOJI[rIcon] ?? rIcon;

      // If empty reaction icon → user removed reaction; skip notification
      if (!rIcon) return;

      const gMsgIds: Array<{ gMsgID?: string | number }> = data?.content?.rMsg ?? [];
      const zaloMsgId = String(gMsgIds[0]?.gMsgID ?? '');
      if (!zaloMsgId) return;

      const zaloId = String(reaction?.threadId ?? data?.idTo ?? "");
      if (!zaloId) return;

      if (reaction?.isSelf && reactionEchoStore.consume(zaloId, zaloMsgId, rIcon)) {
        console.log("[ZaloHandler] Reaction: skip bridge echo for " + zaloId + "/" + zaloMsgId + "/" + rIcon);
        return;
      }

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId) ?? sentMsgStore.getByZaloMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Reaction: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      const type   = (reaction?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(zaloId, type);
      if (topicId === undefined) return;

      const rawName = typeof data?.dName === 'string' ? data.dName.trim() : '';
      const actorUid = typeof data?.uidFrom === 'string' ? data.uidFrom : undefined;
      const actorName = rawName || await resolveUserDisplayName(api, actorUid, 'ai đó');

      // Aggregate reactions: update the summary entry then debounce send/edit
      const entry = reactionSummaryStore.upsert(tgMsgId, emoji, actorName);

      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(async () => {
        entry.debounceTimer = null;
        const text = reactionSummaryStore.buildText(entry);
        if (!text) return;
        // Skip if text hasn't changed (same person reacting fires multiple events)
        if (text === entry.lastSentText) return;
        try {
          if (entry.summaryTgMsgId === null) {
            // First reaction: send a new reply message
            const sent = await tg.sendMessage(
              config.telegram.groupId,
              text,
              {
                message_thread_id: topicId,
                parse_mode: 'HTML',
                reply_parameters: { message_id: tgMsgId, allow_sending_without_reply: true },
              },
            );
            reactionSummaryStore.setSummaryMsgId(tgMsgId, sent.message_id);
            entry.lastSentText = text;
          } else {
            // Subsequent reactions: edit the existing summary message
            await tg.editMessageText(
              config.telegram.groupId,
              entry.summaryTgMsgId,
              undefined,
              text,
              { parse_mode: 'HTML' },
            );
            entry.lastSentText = text;
          }
        } catch (editErr) {
          const msg = editErr instanceof Error ? editErr.message : String(editErr);
          if (!msg.includes('message is not modified')) {
            console.warn('[ZaloHandler] Reaction summary update failed:', editErr);
          }
        }
      }, 600);
    } catch (err) {
      console.error('[ZaloHandler] Reaction error:', err);
    }
  });

  // ── Group events (vào/rời nhóm) ────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('group_event', async (event: any) => {
    try {
      const type    = event?.type as string | undefined;
      const data    = event?.data;
      const groupId = String(event?.threadId ?? data?.groupId ?? '');
      if (!groupId) return;

      // ── Poll vote: UPDATE_BOARD with BoardType.Poll ────────────────────────
      if (type === 'update_board' || type === 'remove_board') {
        // groupTopic.params is a JSON string containing poll info
        const rawParams = data?.groupTopic?.params ?? data?.topic?.params ?? '';
        let params: { boardType?: number; pollId?: number } = {};
        try { params = JSON.parse(rawParams); } catch { /* ignore */ }
        // BoardType.Poll = 3
        if (params.boardType === 3 && params.pollId) {
          const pollId = params.pollId;
          console.log(`[ZaloHandler] group_event update_board pollId=${pollId}`);
          const entry = pollStore.getByPollId(pollId);
          if (entry) {
            await new Promise(r => setTimeout(r, 600));
            let detail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
            try { detail = await api.getPollDetail(pollId); } catch { /* ignore */ }
            if (detail?.options) {
              const actorName = data?.updateMembers?.[0]?.dName ?? data?.creatorId ?? '';
              const header = actorName ? `${actorName} vừa bình chọn` : 'Cập nhật bình chọn';
              const scoreText = buildScoreText(header, detail.options, detail.closed ?? false);
              console.log(`[ZaloHandler] Poll ${pollId} update:`, detail.options.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));
              try {
                await tg.editMessageText(
                  config.telegram.groupId,
                  entry.tgScoreMsgId,
                  undefined,
                  scoreText,
                  {
                    parse_mode: 'HTML',
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] },
                  },
                );
              } catch {
                const newScore = await tg.sendMessage(
                  config.telegram.groupId,
                  scoreText,
                  { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                    reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] } },
                );
                pollStore.updateScoreMsg(pollId, newScore.message_id);
              }
            }
          } else {
            console.log(`[ZaloHandler] update_board pollId=${pollId} not in pollStore (no TG mapping)`);
          }
        }
        return;
      }

      // ── Group name change: update TG topic name ────────────────────────────────────────
      // Zalo sends act="update" (type="update") when group is renamed, with groupName in data.
      // act="update_setting" is kept as fallback.
      if (type === 'update' || type === 'update_setting') {
        const newName: string = (
          (data?.groupName as string | undefined) ??
          (data?.name     as string | undefined) ??
          ''
        ).trim();
        if (newName) {
          const tId = store.getTopicByZalo(groupId, 1);
          if (tId !== undefined) {
            await tg.editForumTopic(
              config.telegram.groupId, tId, { name: topicName(newName, 1) },
            ).catch(() => undefined);
            const existing = store.getEntryByTopic(tId);
            if (existing) store.set({ ...existing, name: newName });
            _groupInfoCache.delete(groupId);
            console.log(`[ZaloHandler] GroupEvent ${type}: group ${groupId} renamed to "${newName}"`);
          }
        }
        return;
      }

      // Only notify for join/leave/remove — skip other setting changes, pins, etc.
      const NOTIFY_TYPES = new Set(['join', 'leave', 'remove_member', 'block_member']);
      if (!type || !NOTIFY_TYPES.has(type)) return;

      const topicId = store.getTopicByZalo(groupId, 1 /* Group */);
      if (topicId === undefined) return;

      const members: Array<{ dName?: string }> = data?.updateMembers ?? [];
      const names = members.map(m => m.dName ?? '?').join(', ');
      const actor  = data?.creatorId === data?.sourceId ? '' : '';  // unused for now
      void actor;

      let notifText = '';
      if (type === 'join') {
        notifText = `➕ <b>${escapeHtml(names)}</b> đã tham gia nhóm`;
      } else if (type === 'leave') {
        notifText = `➖ <b>${escapeHtml(names)}</b> đã rời nhóm`;
      } else if (type === 'remove_member') {
        notifText = `🚫 <b>${escapeHtml(names)}</b> đã bị xóa khỏi nhóm`;
      } else if (type === 'block_member') {
        notifText = `🔒 <b>${escapeHtml(names)}</b> đã bị chặn khỏi nhóm`;
      }

      if (!notifText) return;

      await tg.sendMessage(
        config.telegram.groupId,
        `<i>${notifText}</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
      console.log(`[ZaloHandler] GroupEvent type=${type} group=${groupId}`);
    } catch (err) {
      console.error('[ZaloHandler] GroupEvent error:', err);
    }
  });

  // ── Friend events (lời mời kết bạn, chấp nhận, ...) ──────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('friend_event', async (evt: any) => {
    try {
      // Only care about incoming friend request (someone requesting to be our friend)
      if (evt.type !== FriendEventType.REQUEST) return;
      // isSelf = we sent the request, skip
      if (evt.isSelf) return;

      const data = evt.data as { fromUid: string; toUid: string; message: string };
      const fromUid = data?.fromUid;
      if (!fromUid) return;

      // Resolve display name
      let displayName = fromUid;
      try {
        const info = await api.getUserInfo(fromUid) as {
          userId?: string; zaloName?: string; display_name?: string;
        } | undefined;
        displayName = info?.display_name ?? info?.zaloName ?? fromUid;
      } catch { /* use uid as fallback */ }

      const msgText = data?.message?.trim();

      await tg.sendMessage(
        config.telegram.groupId,
        `👤 <b>${escapeHtml(displayName)}</b> muốn kết bạn với bạn qua Zalo!${msgText ? `\n💬 <i>${escapeHtml(msgText)}</i>` : ''}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Chấp nhận', callback_data: `fr:accept:${fromUid}` },
              { text: '❌ Từ chối',   callback_data: `fr:reject:${fromUid}` },
            ]],
          },
        },
      );
      console.log(`[ZaloHandler] FriendEvent REQUEST from ${fromUid} (${displayName})`);
    } catch (err) {
      console.error('[ZaloHandler] FriendEvent error:', err);
    }
  });
}
