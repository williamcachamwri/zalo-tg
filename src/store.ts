import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { gzipSync, gunzipSync } from 'zlib';
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

  /** Update the stored display name for an existing topic mapping. */
  updateName(topicId: number, name: string): void {
    const entry = _data.topics[String(topicId)];
    if (!entry || entry.name === name) return;
    entry.name = name;
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
//
// On-disk format v2 (compact):
//   {
//     "v": 2,
//     "s": [str0, str1, ...],          ← string intern table
//     "p": [[zaloMsgId, tgMsgId], ...] ← pairs (same as v1)
//     "q": [[tgMsgId, msgId, cliMsgId, uidFromIdx, ts, msgTypeIdx,
//             content, ttl, zaloIdIdx, threadType], ...]
//   }
//   *Idx values are integer indices into s[].
//   Saves ~40-60% vs v1 by eliminating repeated field names and interning
//   zaloId / uidFrom / msgType strings (high repetition across entries).
//   Backward-compatible: v1 files without "v" field load fine.

interface MsgMapV1 {
  pairs:  [string, number][];
  quotes: [number, ZaloQuoteData][];
}
interface MsgMapV2 {
  v: 2;
  s: string[];
  p: [string, number][];
  q: [number, string, string, number, string, number, string | Record<string, unknown>, number, number, 0 | 1][];
}
type MsgMapFile = MsgMapV1 | MsgMapV2;

interface MsgMapData {
  pairs:  [string, number][];
  quotes: [number, ZaloQuoteData][];
}

const _msgMapFile = path.resolve(config.dataDir, 'msg-map.json');

function _loadMsgMap(): MsgMapData {
  if (!existsSync(_msgMapFile)) return { pairs: [], quotes: [] };
  try {
    let buf = readFileSync(_msgMapFile);
    // Detect gzip by magic bytes 0x1F 0x8B
    if (buf[0] === 0x1F && buf[1] === 0x8B) buf = gunzipSync(buf);
    const raw = JSON.parse(buf.toString('utf8')) as MsgMapFile;
    // v2 compact format
    if ('v' in raw && raw.v === 2) {
      const { s, p, q } = raw;
      // Filter out sentinel "0" / empty pairs (came from undefined realMsgId)
      const pairs = p.filter(([k]) => k && k !== '0');
      const quotes: [number, ZaloQuoteData][] = q.map(
        ([tgId, msgId, cliMsgId, uidIdx, ts, typeIdx, content, ttl, zaloIdx, threadType]) => [
          tgId,
          {
            msgId,
            cliMsgId,
            uidFrom:    s[uidIdx]!,
            ts,
            msgType:    s[typeIdx]!,
            content,
            ttl,
            zaloId:     s[zaloIdx]!,
            threadType,
          } satisfies ZaloQuoteData,
        ],
      );
      return { pairs, quotes };
    }
    // v1 legacy format — also filter zeros
    const v1 = raw as MsgMapData;
    return { pairs: v1.pairs.filter(([k]) => k && k !== '0'), quotes: v1.quotes };
  } catch { return { pairs: [], quotes: [] }; }
}

let _msgPersistTimer: ReturnType<typeof setTimeout> | null = null;
function _scheduleMsgPersist(): void {
  if (_msgPersistTimer) return;
  _msgPersistTimer = setTimeout(() => {
    _msgPersistTimer = null;
    try {
      mkdirSync(path.dirname(_msgMapFile), { recursive: true });

      // Build string intern table: collect all zaloId, uidFrom, msgType values
      const _internMap = new Map<string, number>();
      const _intern: string[] = [];
      const _idx = (s: string): number => {
        let i = _internMap.get(s);
        if (i === undefined) { i = _intern.length; _internMap.set(s, i); _intern.push(s); }
        return i;
      };

      const q: MsgMapV2['q'] = [];
      for (const [tgId, qt] of _tgToQuote) {
        q.push([
          tgId,
          qt.msgId,
          qt.cliMsgId,
          _idx(qt.uidFrom),
          qt.ts,
          _idx(qt.msgType),
          qt.content,
          qt.ttl,
          _idx(qt.zaloId),
          qt.threadType,
        ]);
      }

      const data: MsgMapV2 = {
        v: 2,
        s: _intern,
        // Skip sentinel "0" / empty keys — they carry no useful information
        p: _msgKeyOrder.filter(k => k && k !== '0').map(k => [k, _zaloToTg.get(k)!] as [string, number]),
        q,
      };
      // gzip the JSON — reduces file size ~70% with zero new deps
      writeFileSync(_msgMapFile, gzipSync(JSON.stringify(data), { level: 9 }));
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
    // Drop sentinel "0" and empty IDs — they are realMsgId=0 placeholders,
    // nobody ever queries getTgMsgId("0") so storing them is pure waste.
    const validIds = zaloMsgIds.filter(id => id && id !== '0');
    while (_msgKeyOrder.length + validIds.length > MSG_CACHE_MAX) {
      const old = _msgKeyOrder.shift();
      if (!old) break;
      const oldTg = _zaloToTg.get(old);
      _zaloToTg.delete(old);
      if (oldTg !== undefined) _tgToQuote.delete(oldTg);
    }
    for (const id of validIds) {
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

// ── User cache (persisted to disk, gzip compact) ──────────────────────────────
//
// On-disk format (user-cache.json.gz):
//   { "u": {"uid":"name",...}, "g": {"groupId":{"normName":"uid",...},...} }
//
// Techniques for minimum file size + maximum read speed:
//   • Flat objects (no per-entry field names) → uid/name stored once
//   • normName pre-computed at write → O(1) Map lookup at read, no re-normalize
//   • gzip level 9 → ~70% smaller (Vietnamese names compress extremely well)
//   • Debounced write (2 s) → batches rapid saves into one write
//   • In-memory Maps → all gets are O(1), disk only read on startup

/**
 * Lightweight cache of Zalo uid ↔ display name.
 * Populated automatically as messages arrive; used to resolve TG @mention text
 * back to a Zalo UID when forwarding TG → Zalo.
 */
const USER_CACHE_MAX  = 5000;
const _uidToName      = new Map<string, string>();
const _normToUid      = new Map<string, string>();
/** zaloId → (normalizedName → uid) — collision-safe per-group lookup */
const _groupNameToUid = new Map<string, Map<string, string>>();

function _normName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Persistence helpers ───────────────────────────────────────────────────────

const _userCacheFile = path.resolve(config.dataDir, 'user-cache.json.gz');

interface UserCacheDisk {
  /** uid → displayName */
  u: Record<string, string>;
  /** groupId → { normName → uid } */
  g: Record<string, Record<string, string>>;
}

function _loadUserCache(): void {
  if (!existsSync(_userCacheFile)) return;
  try {
    const raw = JSON.parse(gunzipSync(readFileSync(_userCacheFile)).toString('utf8')) as UserCacheDisk;
    for (const [uid, name] of Object.entries(raw.u ?? {})) {
      _uidToName.set(uid, name);
      _normToUid.set(_normName(name), uid);
    }
    for (const [gid, members] of Object.entries(raw.g ?? {})) {
      const m = new Map<string, string>();
      for (const [norm, uid] of Object.entries(members)) m.set(norm, uid);
      _groupNameToUid.set(gid, m);
    }
    console.log(`[userCache] Loaded ${_uidToName.size} users from disk`);
  } catch (e) {
    console.warn('[userCache] Failed to load cache:', e);
  }
}

let _userCacheDirty  = false;
let _userCacheTimer: ReturnType<typeof setTimeout> | null = null;

function _scheduleUserCachePersist(): void {
  _userCacheDirty = true;
  if (_userCacheTimer) return;
  _userCacheTimer = setTimeout(() => {
    _userCacheTimer = null;
    if (!_userCacheDirty) return;
    _userCacheDirty = false;
    try {
      mkdirSync(path.dirname(_userCacheFile), { recursive: true });
      const disk: UserCacheDisk = { u: {}, g: {} };
      for (const [uid, name] of _uidToName) disk.u[uid] = name;
      for (const [gid, m] of _groupNameToUid) {
        const obj: Record<string, string> = {};
        for (const [norm, uid] of m) obj[norm] = uid;
        disk.g[gid] = obj;
      }
      writeFileSync(_userCacheFile, gzipSync(JSON.stringify(disk), { level: 9 }));
    } catch (e) {
      console.warn('[userCache] Failed to persist:', e);
    }
  }, 2000);
}

// Load from disk on startup
_loadUserCache();

// ── Public API ────────────────────────────────────────────────────────────────

export const userCache = {
  /** Record a Zalo user seen in a received message. */
  save(uid: string, displayName: string): void {
    // Evict oldest only if new uid (avoid eviction on name update)
    if (!_uidToName.has(uid) && _uidToName.size >= USER_CACHE_MAX) {
      const firstUid = _uidToName.keys().next().value;
      if (firstUid) {
        const oldName = _uidToName.get(firstUid);
        _uidToName.delete(firstUid);
        if (oldName) _normToUid.delete(_normName(oldName));
      }
    }
    _uidToName.set(uid, displayName);
    _normToUid.set(_normName(displayName), uid);
    _scheduleUserCachePersist();
  },

  /** Find a Zalo UID by (normalised) display name. Used for TG→Zalo mention. */
  resolveByName(rawName: string): string | undefined {
    return _normToUid.get(_normName(rawName));
  },

  /** Save display name scoped to a Zalo group for collision-safe resolution. */
  saveForGroup(uid: string, displayName: string, zaloId: string): void {
    this.save(uid, displayName);
    let m = _groupNameToUid.get(zaloId);
    if (!m) { m = new Map(); _groupNameToUid.set(zaloId, m); }
    m.set(_normName(displayName), uid);
    // persist already scheduled by save()
  },

  /** Resolve UID by name, preferring group-specific lookup over global. */
  resolveByNameInGroup(rawName: string, zaloId: string): string | undefined {
    const norm = _normName(rawName);
    return _groupNameToUid.get(zaloId)?.get(norm) ?? _normToUid.get(norm);
  },

  /** Get display name for a UID. */
  getName(uid: string): string | undefined {
    return _uidToName.get(uid);
  },
};

// ── Alias cache (danh bạ nickname) ───────────────────────────────────────────

/** userId → alias (tên danh bạ người dùng tự đặt) */
const _aliasMap = new Map<string, string>();
/** normalised alias → userId (reverse lookup for mention resolution) */
const _aliasNormToUid = new Map<string, string>();

export const aliasCache = {
  /** Bulk-load from getAliasList response */
  setAll(items: Array<{ userId: string; alias: string }>): void {
    _aliasMap.clear();
    _aliasNormToUid.clear();
    this.merge(items);
  },

  /** Merge aliases/contact display names into the existing cache. */
  merge(items: Array<{ userId: string; alias?: string; displayName?: string }>): void {
    for (const { userId, alias, displayName } of items) {
      const name = (alias ?? displayName)?.trim();
      if (name) {
        _aliasMap.set(userId, name);
        _aliasNormToUid.set(_normName(name), userId);
      }
    }
  },

  /** Number of cached contact display names / aliases. */
  size(): number {
    return _aliasMap.size;
  },

  /** Find a Zalo UID by alias name (for TG→Zalo mention via alias). */
  resolveByAlias(rawName: string): string | undefined {
    return _aliasNormToUid.get(_normName(rawName));
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

function upsertAliasFromFriend(friend: ZaloFriend): void {
  const preferredName = friend.alias?.trim() || friend.displayName?.trim();
  if (!preferredName) return;
  _aliasMap.set(friend.userId, preferredName);
  _aliasNormToUid.set(_normName(preferredName), friend.userId);
}

const FRIENDS_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _friends:    ZaloFriend[] = [];
let _friendsTs:  number       = 0;

export const friendsCache = {
  /** Store a fresh friends list. */
  set(list: ZaloFriend[]): void {
    _friends   = list;
    _friendsTs = Date.now();
    for (const friend of list) upsertAliasFromFriend(friend);
  },

  /**
   * Search by substring (case/diacritic-insensitive).
   * Searches alias first, falls back to displayName.
   * Returns up to `limit` results.
   */
  search(query: string, limit = 10): ZaloFriend[] {
    const q = query.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    return _friends
      .filter(f => {
        const searchName = (f.alias || f.displayName).toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        const realName   = f.displayName.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
        return searchName.includes(q) || realName.includes(q);
      })
      .slice(0, limit);
  },

  /** True if the cache is still fresh. */
  isFresh(): boolean {
    return _friends.length > 0 && Date.now() - _friendsTs < FRIENDS_TTL_MS;
  },

  get(userId: string): ZaloFriend | undefined {
    return _friends.find(f => f.userId === userId);
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
  /** Zalo cliMsgId/clientId for this TG→Zalo send, when available. */
  cliMsgId?:  string | number;
  /** Zalo conversation ID */
  zaloId:     string;
  /** 0 = DM, 1 = Group */
  threadType: 0 | 1;
}

const _sentMap      = new Map<number, SentMsgInfo>(); // tgMsgId → info
const _sentByZaloId = new Map<string, number>();       // String(zaloMsgId) → tgMsgId

/** zaloId values currently being sent by the bot (to handle echo race condition) */
const _pendingSendConvos = new Map<string, number>(); // zaloId → timestamp

export const sentMsgStore = {
  /** Record a message we sent from TG→Zalo. tgMsgId is the user's TG message. */
  save(tgMsgId: number, info: SentMsgInfo): void {
    _sentMap.set(tgMsgId, info);
    _sentByZaloId.set(String(info.msgId), tgMsgId);
    if (info.cliMsgId !== undefined && String(info.cliMsgId) !== '0') {
      _sentByZaloId.set(String(info.cliMsgId), tgMsgId);
    }
  },

  get(tgMsgId: number): SentMsgInfo | undefined {
    return _sentMap.get(tgMsgId);
  },

  /**
   * Build fallback quote data for Telegram replies to TG-originated messages.
   * This gets replaced by richer self-echo quote data when available.
   */
  getQuote(tgMsgId: number): ZaloQuoteData | undefined {
    const info = _sentMap.get(tgMsgId);
    if (!info) return undefined;
    return {
      msgId:      String(info.msgId),
      cliMsgId:   info.cliMsgId !== undefined ? String(info.cliMsgId) : String(info.msgId),
      uidFrom:    '0',
      ts:         String(Date.now()),
      msgType:    'webchat',
      content:    '',
      ttl:        0,
      zaloId:     info.zaloId,
      threadType: info.threadType,
    };
  },

  /**
   * Reverse lookup: given a Zalo msgId we sent (TG→Zalo direction),
   * return the original TG message_id. Used so Zalo replies to our
   * sent messages chain correctly on the TG side.
   */
  getByZaloMsgId(zaloMsgId: string): number | undefined {
    return _sentByZaloId.get(zaloMsgId);
  },

  /** Store richer quote data once the Zalo self-echo for a TG→Zalo send arrives. */
  attachQuote(zaloMsgIds: string[], quote: ZaloQuoteData): void {
    for (const id of zaloMsgIds) {
      const tgMsgId = _sentByZaloId.get(String(id));
      if (tgMsgId !== undefined) _tgToQuote.set(tgMsgId, quote);
    }
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
    msgIds: string[],
    meta: Omit<ZaloAlbumBuffer, 'timer' | 'urls' | 'zaloMsgIds'>,
    onFlush: (buf: Omit<ZaloAlbumBuffer, 'timer'>) => void,
  ): void {
    const existing = _zaloAlbumBuffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.urls.push(url);
      existing.zaloMsgIds.push(...msgIds);
      existing.timer = setTimeout(() => {
        _zaloAlbumBuffers.delete(key);
        onFlush({ urls: existing.urls, zaloMsgIds: existing.zaloMsgIds, ...meta });
      }, 200);
    } else {
      const buf: ZaloAlbumBuffer = {
        ...meta,
        urls: [url],
        zaloMsgIds: [...msgIds],
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
