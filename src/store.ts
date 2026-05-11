import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { config } from './config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TopicEntry {
  topicId: number;
  zaloId:  string;   // threadId (UID for DMs, groupId for groups)
  type:    0 | 1;    // 0 = ThreadType.User, 1 = ThreadType.Group
  name:    string;   // contact name or group name
}

interface StoreData {
  /** topicId (as string key) → entry */
  topics:    Record<string, TopicEntry>;
  /** `${type}:${zaloId}` → topicId */
  zaloIndex: Record<string, number>;
}

// ── Internal ──────────────────────────────────────────────────────────────────

const filePath = path.resolve(config.dataDir, 'topics.json');

function load(): StoreData {
  if (!existsSync(filePath)) return { topics: {}, zaloIndex: {} };
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as StoreData;
  } catch {
    return { topics: {}, zaloIndex: {} };
  }
}

function persist(data: StoreData): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function zaloKey(zaloId: string, type: 0 | 1): string {
  return `${type}:${zaloId}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

let _data: StoreData = load();

export const store = {
  /** Find an existing Telegram topic ID for a given Zalo conversation. */
  getTopicByZalo(zaloId: string, type: 0 | 1): number | undefined {
    return _data.zaloIndex[zaloKey(zaloId, type)];
  },

  /** Look up the Zalo conversation linked to a Telegram topic. */
  getEntryByTopic(topicId: number): TopicEntry | undefined {
    return _data.topics[String(topicId)];
  },

  /** Persist a new topic ↔ Zalo mapping. */
  set(entry: TopicEntry): void {
    _data.topics[String(entry.topicId)] = entry;
    _data.zaloIndex[zaloKey(entry.zaloId, entry.type)] = entry.topicId;
    persist(_data);
  },

  /** All entries (for diagnostics). */
  all(): TopicEntry[] {
    return Object.values(_data.topics);
  },

  /** Remove a mapping by Telegram topicId. Returns the removed entry or undefined. */
  remove(topicId: number): TopicEntry | undefined {
    const entry = _data.topics[String(topicId)];
    if (!entry) return undefined;
    delete _data.topics[String(topicId)];
    const key = zaloKey(entry.zaloId, entry.type);
    if (_data.zaloIndex[key] === topicId) {
      delete _data.zaloIndex[key];
    }
    persist(_data);
    return entry;
  },

  /** Re-read from disk (useful after external edits). */
  reload(): void {
    _data = load();
  },
};

// ── Message ID mapping (in-memory, not persisted) ─────────────────────────────

/**
 * Data needed to quote a Zalo message when replying.
 * Field names match what zca-js sendMessage reads from the `quote` param.
 */
export interface ZaloQuoteData {
  msgId:    string;
  cliMsgId: string;
  uidFrom:  string;
  ts:       string;
  msgType:  string;
  content:  string | Record<string, unknown>;
  ttl:      number;
  /** The Zalo conversation ID (group ID or peer UID) this message belongs to. */
  zaloId:   string;
  /** 0 = DM, 1 = Group */
  threadType: 0 | 1;
}

const MSG_CACHE_MAX = 2000;

// ── Persistence helpers for msgStore ─────────────────────────────────────────

interface MsgMapData {
  /** Insertion-ordered list of [zaloMsgId, tgMsgId] pairs */
  pairs:  [string, number][];
  /** tgMsgId → ZaloQuoteData */
  quotes: [number, ZaloQuoteData][];
}

const _msgMapFile = path.resolve(config.dataDir, 'msg-map.json');

function _loadMsgMap(): MsgMapData {
  if (!existsSync(_msgMapFile)) return { pairs: [], quotes: [] };
  try {
    return JSON.parse(readFileSync(_msgMapFile, 'utf8')) as MsgMapData;
  } catch { return { pairs: [], quotes: [] }; }
}

let _msgPersistTimer: ReturnType<typeof setTimeout> | null = null;
function _scheduleMsgPersist(): void {
  if (_msgPersistTimer) return;
  _msgPersistTimer = setTimeout(() => {
    _msgPersistTimer = null;
    try {
      mkdirSync(path.dirname(_msgMapFile), { recursive: true });
      const data: MsgMapData = {
        pairs:  _msgKeyOrder.map(k => [k, _zaloToTg.get(k)!] as [string, number]),
        quotes: [..._tgToQuote.entries()],
      };
      writeFileSync(_msgMapFile, JSON.stringify(data), 'utf8');
    } catch (e) {
      console.warn('[msgStore] Failed to persist msg-map:', e);
    }
  }, 1000);
}

// ── In-memory state (pre-loaded from disk) ────────────────────────────────────

/** zaloMsgId → Telegram message_id (used to find TG reply target) */
const _zaloToTg = new Map<string, number>();
/** Telegram message_id → Zalo quote data (used when TG user replies) */
const _tgToQuote = new Map<number, ZaloQuoteData>();
/** Insertion-order keys for eviction */
const _msgKeyOrder: string[] = [];

// Load persisted data immediately
{
  const saved = _loadMsgMap();
  for (const [zaloId, tgId] of saved.pairs) {
    _zaloToTg.set(zaloId, tgId);
    _msgKeyOrder.push(zaloId);
  }
  for (const [tgId, quote] of saved.quotes) {
    _tgToQuote.set(tgId, quote);
  }
  // Trim if over limit (file may have grown beyond MSG_CACHE_MAX)
  while (_msgKeyOrder.length > MSG_CACHE_MAX) {
    const old = _msgKeyOrder.shift();
    if (!old) break;
    const oldTg = _zaloToTg.get(old);
    _zaloToTg.delete(old);
    if (oldTg !== undefined) _tgToQuote.delete(oldTg);
  }
}

export const msgStore = {
  /**
   * Save a bidirectional mapping after a Zalo message is forwarded to Telegram.
   * @param tgMsgId      The Telegram message_id of the forwarded message.
   * @param zaloMsgIds   One or more Zalo IDs (msgId, realMsgId) that refer to the same message.
   * @param quote        Data needed to quote this message in future sends.
   */
  save(tgMsgId: number, zaloMsgIds: string[], quote: ZaloQuoteData): void {
    while (_msgKeyOrder.length + zaloMsgIds.length > MSG_CACHE_MAX) {
      const old = _msgKeyOrder.shift();
      if (!old) break;
      const oldTg = _zaloToTg.get(old);
      _zaloToTg.delete(old);
      if (oldTg !== undefined) _tgToQuote.delete(oldTg);
    }
    for (const id of zaloMsgIds) {
      _zaloToTg.set(id, tgMsgId);
      _msgKeyOrder.push(id);
    }
    _tgToQuote.set(tgMsgId, quote);
    _scheduleMsgPersist();
  },

  /** Get the Telegram message_id for a given Zalo message ID. */
  getTgMsgId(zaloMsgId: string): number | undefined {
    return _zaloToTg.get(zaloMsgId);
  },

  /** Get the Zalo quote data for a given Telegram message_id (for TG→Zalo replies). */
  getQuote(tgMsgId: number): ZaloQuoteData | undefined {
    return _tgToQuote.get(tgMsgId);
  },
};

// ── User cache (in-memory, not persisted) ─────────────────────────────────────

/**
 * Lightweight cache of Zalo uid ↔ display name.
 * Populated automatically as messages arrive; used to resolve TG @mention text
 * back to a Zalo UID when forwarding TG → Zalo.
 */
const USER_CACHE_MAX = 500;
const _uidToName     = new Map<string, string>();
const _normToUid     = new Map<string, string>();

function _normName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

export const userCache = {
  /** Record a Zalo user seen in a received message. */
  save(uid: string, displayName: string): void {
    if (_uidToName.size >= USER_CACHE_MAX) {
      const firstUid = _uidToName.keys().next().value;
      if (firstUid) {
        const oldName = _uidToName.get(firstUid);
        _uidToName.delete(firstUid);
        if (oldName) _normToUid.delete(_normName(oldName));
      }
    }
    _uidToName.set(uid, displayName);
    _normToUid.set(_normName(displayName), uid);
  },

  /** Find a Zalo UID by (normalised) display name. Used for TG→Zalo mention. */
  resolveByName(rawName: string): string | undefined {
    return _normToUid.get(_normName(rawName));
  },

  /** Get display name for a UID. */
  getName(uid: string): string | undefined {
    return _uidToName.get(uid);
  },
};

// ── Alias cache (danh bạ nickname) ───────────────────────────────────────────

/** userId → alias (tên danh bạ người dùng tự đặt) */
const _aliasMap = new Map<string, string>();

export const aliasCache = {
  /** Bulk-load from getAliasList response */
  setAll(items: Array<{ userId: string; alias: string }>): void {
    _aliasMap.clear();
    for (const { userId, alias } of items) {
      if (alias?.trim()) _aliasMap.set(userId, alias.trim());
    }
  },

  /** Get alias for a userId, or undefined if not set */
  get(userId: string): string | undefined {
    return _aliasMap.get(userId);
  },

  /**
   * Build display label: "Alias (Tên thật)" if alias differs from realName,
   * otherwise just realName.
   */
  label(userId: string, realName: string): string {
    const alias = _aliasMap.get(userId);
    if (!alias || alias === realName) return realName;
    return `${alias} (${realName})`;
  },
};

// ── Friends cache (in-memory, TTL-refreshed) ──────────────────────────────────

export interface ZaloFriend {
  userId:      string;
  displayName: string;
  /** tên danh bạ (alias), nếu có */
  alias?:      string;
}

const FRIENDS_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _friends:    ZaloFriend[] = [];
let _friendsTs:  number       = 0;

function normalizeFriendSearchValue(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').trim();
}

function rankFriendSearchMatch(friend: ZaloFriend, query: string): number {
  const alias = normalizeFriendSearchValue(friend.alias ?? '');
  const name  = normalizeFriendSearchValue(friend.displayName);

  if (alias && alias === query)         return 600;
  if (alias && alias.startsWith(query)) return 500;
  if (alias && alias.includes(query))   return 400;
  if (name === query)                   return 300;
  if (name.startsWith(query))           return 200;
  if (name.includes(query))             return 100;
  return -1;
}

export const friendsCache = {
  /** Store a fresh friends list. */
  set(list: ZaloFriend[]): void {
    _friends   = list;
    _friendsTs = Date.now();
  },

  getByUserId(userId: string): ZaloFriend | undefined {
    return _friends.find(friend => friend.userId === userId);
  },

  /** Search by alias first, then real name (case/diacritic-insensitive). */
  search(query: string, limit = 10): ZaloFriend[] {
    const q = normalizeFriendSearchValue(query);
    if (!q) return [];

    return _friends
      .map((friend, index) => ({ friend, index, score: rankFriendSearchMatch(friend, q) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map((entry) => entry.friend);
  },

  /** True if the cache is still fresh. */
  isFresh(): boolean {
    return _friends.length > 0 && Date.now() - _friendsTs < FRIENDS_TTL_MS;
  },
};

// ── Groups cache (in-memory, TTL-refreshed) ───────────────────────────────────

export interface ZaloGroup {
  groupId:     string;
  name:        string;
  totalMember: number;
}

const GROUPS_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _groups:   ZaloGroup[] = [];
let _groupsTs: number      = 0;

export const groupsCache = {
  set(list: ZaloGroup[]): void {
    _groups   = list;
    _groupsTs = Date.now();
  },

  search(query: string, limit = 10): ZaloGroup[] {
    const q = query.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    return _groups
      .filter(g => {
        const n = g.name.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        return n.includes(q);
      })
      .slice(0, limit);
  },

  isFresh(): boolean {
    return _groups.length > 0 && Date.now() - _groupsTs < GROUPS_TTL_MS;
  },
};

// ── Sent message store (TG→Zalo direction) ────────────────────────────────────

export interface SentMsgInfo {
  /** Zalo msgId returned by api.sendMessage / api.sendVoice */
  msgId:      string | number;
  /** Zalo conversation ID */
  zaloId:     string;
  /** 0 = DM, 1 = Group */
  threadType: 0 | 1;
}

const SENT_MAX = 300;
const _sentMap      = new Map<number, SentMsgInfo>(); // tgMsgId → info
const _sentByZaloId = new Map<string, number>();       // String(zaloMsgId) → tgMsgId
const _sentOrder: number[] = [];

/** zaloId values currently being sent by the bot (to handle echo race condition) */
const _pendingSendConvos = new Map<string, number>(); // zaloId → timestamp

export const sentMsgStore = {
  /** Record a message we sent from TG→Zalo. tgMsgId is the user's TG message. */
  save(tgMsgId: number, info: SentMsgInfo): void {
    if (_sentOrder.length >= SENT_MAX) {
      const old = _sentOrder.shift();
      if (old !== undefined) {
        const oldInfo = _sentMap.get(old);
        if (oldInfo) _sentByZaloId.delete(String(oldInfo.msgId));
        _sentMap.delete(old);
      }
    }
    _sentMap.set(tgMsgId, info);
    _sentByZaloId.set(String(info.msgId), tgMsgId);
    _sentOrder.push(tgMsgId);
  },

  get(tgMsgId: number): SentMsgInfo | undefined {
    return _sentMap.get(tgMsgId);
  },

  /**
   * Reverse lookup: given a Zalo msgId we sent (TG→Zalo direction),
   * return the original TG message_id. Used so Zalo replies to our
   * sent messages chain correctly on the TG side.
   */
  getByZaloMsgId(zaloMsgId: string): number | undefined {
    return _sentByZaloId.get(zaloMsgId);
  },

  /**
   * Mark a conversation (zaloId) as currently being sent to by the bot.
   * Call BEFORE api.sendMessage() to avoid race condition where Zalo echoes
   * back the message before the HTTP response (and sentMsgStore.save) arrives.
   */
  markSending(zaloId: string): void {
    _pendingSendConvos.set(zaloId, Date.now());
  },

  /** Call AFTER sentMsgStore.save() or on send error. */
  unmarkSending(zaloId: string): void {
    _pendingSendConvos.delete(zaloId);
  },

  /**
   * Returns true if the bot is currently sending (or just finished sending within
   * 3 s) to this zaloId — used to suppress isSelf echo in the Zalo listener.
   */
  isSendingTo(zaloId: string): boolean {
    const ts = _pendingSendConvos.get(zaloId);
    return ts !== undefined && Date.now() - ts < 3000;
  },
};

// ── Reaction summary store (Zalo→TG reaction aggregation) ────────────────────

export interface ReactionSummaryEntry {
  summaryTgMsgId: number | null;
  lastSentText: string;
  /** emoji → actor display names (ordered by arrival) */
  reactions: Record<string, string[]>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const _reactionSummaries = new Map<number, ReactionSummaryEntry>(); // tgMsgId → entry

export const reactionSummaryStore = {
  /** Add or update a reaction. Returns the entry for this tgMsgId. */
  upsert(tgMsgId: number, emoji: string, actorName: string): ReactionSummaryEntry {
    let entry = _reactionSummaries.get(tgMsgId);
    if (!entry) {
      entry = { summaryTgMsgId: null, lastSentText: '', reactions: {}, debounceTimer: null };
      _reactionSummaries.set(tgMsgId, entry);
    }
    if (!entry.reactions[emoji]) entry.reactions[emoji] = [];
    if (!entry.reactions[emoji]!.includes(actorName)) {
      entry.reactions[emoji]!.push(actorName);
    }
    return entry;
  },

  setSummaryMsgId(tgMsgId: number, summaryMsgId: number): void {
    const entry = _reactionSummaries.get(tgMsgId);
    if (entry) entry.summaryTgMsgId = summaryMsgId;
  },

  buildText(entry: ReactionSummaryEntry): string {
    return Object.entries(entry.reactions)
      .filter(([, names]) => names.length > 0)
      .map(([emoji, names]) => `${emoji} ${names.join(', ')}`)
      .join('  ');
  },
};

const REACTION_ECHO_TTL_MS = 8_000;
const _pendingReactionEchoes = new Map<string, { count: number; ts: number }>();

function reactionEchoKey(zaloId: string, targetMsgId: string, icon: string): string {
  return `${zaloId}::${targetMsgId}::${icon}`;
}

function prunePendingReactionEchoes(now = Date.now()): void {
  for (const [key, entry] of _pendingReactionEchoes.entries()) {
    if (now - entry.ts > REACTION_ECHO_TTL_MS) _pendingReactionEchoes.delete(key);
  }
}

function decrementPendingReactionEcho(key: string): void {
  const entry = _pendingReactionEchoes.get(key);
  if (!entry) return;
  if (entry.count <= 1) {
    _pendingReactionEchoes.delete(key);
    return;
  }
  _pendingReactionEchoes.set(key, { ...entry, count: entry.count - 1 });
}

export const reactionEchoStore = {
  mark(zaloId: string, targetMsgId: string, icon: string): void {
    const now = Date.now();
    prunePendingReactionEchoes(now);
    const key = reactionEchoKey(zaloId, targetMsgId, icon);
    const existing = _pendingReactionEchoes.get(key);
    _pendingReactionEchoes.set(key, { count: (existing?.count ?? 0) + 1, ts: now });
  },

  consume(zaloId: string, targetMsgId: string, icon: string): boolean {
    const now = Date.now();
    prunePendingReactionEchoes(now);
    const key = reactionEchoKey(zaloId, targetMsgId, icon);
    const entry = _pendingReactionEchoes.get(key);
    if (!entry) return false;
    decrementPendingReactionEcho(key);
    return true;
  },

  cancel(zaloId: string, targetMsgId: string, icon: string): void {
    prunePendingReactionEchoes();
    const key = reactionEchoKey(zaloId, targetMsgId, icon);
    decrementPendingReactionEcho(key);
  },
};

// ── TG media group buffer (TG→Zalo album sync) ────────────────────────────────

export interface MediaGroupItem {
  fileId:    string;
  fname:     string;
  fileSize?: number;
  caption?:  string;
  captionMentions?: Array<{ pos: number; uid: string; len: number }>;
}

interface MediaGroupBuffer {
  timer:      ReturnType<typeof setTimeout>;
  items:      MediaGroupItem[];
  topicId:    number;
  zaloId:     string;
  threadType: 0 | 1;
  replyToMsgId?: number;
}

const _mgBuffers = new Map<string, MediaGroupBuffer>();

export const mediaGroupStore = {
  /** Add a photo/video to an in-flight media group buffer. Returns the buffer. */
  add(
    groupId: string,
    item: MediaGroupItem,
    meta: Omit<MediaGroupBuffer, 'timer' | 'items'>,
    onFlush: (items: MediaGroupItem[], meta: Omit<MediaGroupBuffer, 'timer' | 'items'>) => void,
  ): void {
    const existing = _mgBuffers.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = setTimeout(() => {
        _mgBuffers.delete(groupId);
        onFlush(existing.items, existing);
      }, 500);
    } else {
      const buf: MediaGroupBuffer = {
        ...meta,
        items: [item],
        timer: setTimeout(() => {
          _mgBuffers.delete(groupId);
          onFlush(buf.items, buf);
        }, 500),
      };
      _mgBuffers.set(groupId, buf);
    }
  },
};

// ── Zalo album buffer (Zalo→TG multi-photo) ────────────────────────────────────

interface ZaloAlbumBuffer {
  timer:      ReturnType<typeof setTimeout>;
  urls:       string[];
  senderName: string;
  topicId:    number;
  tgBase:     { message_thread_id: number; reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } };
  zaloMsgIds: string[];
  zaloQuote:  ZaloQuoteData | undefined;
}

const _zaloAlbumBuffers = new Map<string, ZaloAlbumBuffer>(); // key = `${threadId}:${uidFrom}`

export const zaloAlbumStore = {
  add(
    key: string,
    url: string,
    msgId: string,
    meta: Omit<ZaloAlbumBuffer, 'timer' | 'urls' | 'zaloMsgIds'>,
    onFlush: (buf: Omit<ZaloAlbumBuffer, 'timer'>) => void,
  ): void {
    const existing = _zaloAlbumBuffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.urls.push(url);
      existing.zaloMsgIds.push(msgId);
      existing.timer = setTimeout(() => {
        _zaloAlbumBuffers.delete(key);
        onFlush({ urls: existing.urls, zaloMsgIds: existing.zaloMsgIds, ...meta });
      }, 200);
    } else {
      const buf: ZaloAlbumBuffer = {
        ...meta,
        urls: [url],
        zaloMsgIds: [msgId],
        timer: setTimeout(() => {
          _zaloAlbumBuffers.delete(key);
          onFlush({ urls: buf.urls, zaloMsgIds: buf.zaloMsgIds, ...meta });
        }, 200),
      };
      _zaloAlbumBuffers.set(key, buf);
    }
  },
};

// ── Poll store (Zalo ↔ TG native poll) ───────────────────────────────────────

export interface PollEntry {
  pollId:           number;
  zaloGroupId:      string;
  tgPollMsgId:      number;    // TG message_id of the bot-owned clone poll
  tgOrigPollMsgId?: number;    // TG message_id of the user's original poll (to stopPoll on lock)
  tgPollUUID:       string;    // TG poll identifier from ctx.pollAnswer.poll_id
  tgScoreMsgId:     number;    // TG message_id of the editable vote-count text below
  tgThreadId:       number;    // Forum thread (topic) id
  options: {
    option_id: number;
    content:   string;
  }[];
}

const _pollByZaloId = new Map<number, PollEntry>();       // pollId → entry
const _pollByTgId   = new Map<number, PollEntry>();       // tgPollMsgId → entry
const _pollByUUID   = new Map<string, PollEntry>();       // tgPollUUID → entry

export const pollStore = {
  save(entry: PollEntry): void {
    _pollByZaloId.set(entry.pollId, entry);
    _pollByTgId.set(entry.tgPollMsgId, entry);
    _pollByUUID.set(entry.tgPollUUID, entry);
  },

  getByPollId(pollId: number): PollEntry | undefined {
    return _pollByZaloId.get(pollId);
  },

  getByTgMsgId(tgMsgId: number): PollEntry | undefined {
    return _pollByTgId.get(tgMsgId);
  },

  getByTgPollUUID(uuid: string): PollEntry | undefined {
    return _pollByUUID.get(uuid);
  },

  /** Update tgScoreMsgId after editing */
  updateScoreMsg(pollId: number, newMsgId: number): void {
    const e = _pollByZaloId.get(pollId);
    if (e) e.tgScoreMsgId = newMsgId;
  },
};
