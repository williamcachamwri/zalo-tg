import { ThreadType } from 'zca-js';
import path from 'path';
import { createReadStream } from 'fs';

import type { ZaloAPI } from '../zalo/types.js';
import { store, msgStore, userCache, friendsCache, groupsCache, sentMsgStore, pollStore, mediaGroupStore, reactionEchoStore, aliasCache } from '../store.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, convertToM4a, extractVideoThumbnail } from '../utils/media.js';
import { triggerQRLogin } from '../zalo/client.js';
import { escapeHtml } from '../utils/format.js';

// Bridge start time (module load = process start)
const _bridgeStartTime = Date.now();


// ── Mention resolution helper ──────────────────────────────────────────────

type TgEntity = { type: string; offset: number; length: number; user?: { first_name: string; last_name?: string } };

/**
 * Resolve TG mention entities (or plain-text @Name patterns) in a string
 * to Zalo mention objects. Works for both msg.text+entities and
 * msg.caption+caption_entities.
 */
function resolveTgMentions(
  text: string,
  entities: ReadonlyArray<TgEntity> | undefined,
  forZaloGroup: boolean,
  zaloId?: string,
): Array<{ pos: number; uid: string; len: number }> {
  const result: Array<{ pos: number; uid: string; len: number }> = [];
  if (!forZaloGroup) return result;

  // 1. Named TG entities (@username or text_mention with user object)
  if (entities) {
    for (const e of entities) {
      if (e.type === 'mention') {
        const rawName = text.slice(e.offset + 1, e.offset + e.length); // strip leading @
        const uid = zaloId
          ? userCache.resolveByNameInGroup(rawName, zaloId)
          : userCache.resolveByName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      } else if (e.type === 'text_mention' && e.user) {
        const rawName = e.user.first_name + (e.user.last_name ? ` ${e.user.last_name}` : '');
        const uid = zaloId
          ? userCache.resolveByNameInGroup(rawName, zaloId)
          : userCache.resolveByName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      }
    }
  }

  // 2. Plain-text @Name patterns (only if no entity matched above)
  if (result.length === 0) {
    const atPattern = /@([\p{L}\p{N}_]+(?:\s[\p{L}\p{N}_]+){0,3})/gu;
    let m: RegExpExecArray | null;
    while ((m = atPattern.exec(text)) !== null) {
      const captured = m[1];
      if (/^(all|everyone|tất\s*cả)$/i.test(captured)) {
        result.push({ pos: m.index, uid: '-1', len: m[0].length });
        continue;
      }
      const words = captured.split(' ');
      for (let end = words.length; end >= 1; end--) {
        const candidate = words.slice(0, end).join(' ');
        const uid = zaloId
          ? userCache.resolveByNameInGroup(candidate, zaloId)
          : userCache.resolveByName(candidate);
        if (uid) {
          result.push({ pos: m.index, uid, len: ('@' + candidate).length });
          break;
        }
      }
    }
  }

  return result;
}

/**
 * When a TG user replies to a forwarded Zalo message from ANOTHER person,
 * prepend "@Name " to the message so the recipient on Zalo sees who is being
 * addressed. Returns null when:
 *  - not a group (mentions don't apply in DMs)
 *  - replying to our own sent message (TG→Zalo direction)
 *  - no quote data / display name found
 */
function buildReplyAutoMention(
  replyToMsgId: number | undefined,
  threadType: ThreadType,
): { prefix: string; mention: { pos: number; uid: string; len: number } } | null {
  if (replyToMsgId === undefined) return null;
  if (threadType !== ThreadType.Group) return null;
  // Skip if replying to a message WE sent (TG→Zalo direction)
  if (sentMsgStore.get(replyToMsgId) !== undefined) return null;
  const quote = msgStore.getQuote(replyToMsgId);
  if (!quote) return null;
  const name = userCache.getName(quote.uidFrom)?.trim();
  if (!name) return null;
  const mentionText = `@${name}`;
  return {
    prefix: `${mentionText} `,
    mention: { pos: 0, uid: quote.uidFrom, len: mentionText.length },
  };
}

function normalizePhoneSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (!/^[+()\d.\s-]+$/.test(trimmed)) return null;

  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length < 9 || digitsOnly.length > 15) return null;

  return digitsOnly;
}

function buildTopicUrl(topicId: number): string {
  const chatId = String(config.telegram.groupId);
  const internalChatId = chatId.startsWith('-100') ? chatId.slice(4) : chatId.replace(/^-/, '');
  return `https://t.me/c/${internalChatId}/${topicId}`;
}

/** Track in-progress QR login so we don't stack multiple flows. */
let qrLoginInProgress = false;

/**
 * Start a Zalo QR login flow and forward the QR image + status messages
 * back to the Telegram chat/topic where /login was sent.
 */
async function handleLoginCommand(
  chatId: number,
  threadId: number | undefined,
  onNewApi: (api: ZaloAPI) => void,
): Promise<void> {
  if (qrLoginInProgress) {
    await tgBot.telegram.sendMessage(
      chatId,
      '⏳ Đang có phiên đăng nhập khác đang chạy. Vui lòng chờ...',
      threadId ? { message_thread_id: threadId } : {},
    );
    return;
  }

  qrLoginInProgress = true;
  const msgOpts = threadId ? { message_thread_id: threadId } : {};

  try {
    await tgBot.telegram.sendMessage(chatId, '🔄 Đang tạo mã QR Zalo...', msgOpts);

    const newApi = await triggerQRLogin({
      onQRReady: async (imagePath) => {
        await tgBot.telegram.sendPhoto(
          chatId,
          { source: createReadStream(imagePath) },
          {
            ...msgOpts,
            caption: '📱 Mở ứng dụng <b>Zalo</b> → Cài đặt → Quét mã QR để đăng nhập.',
            parse_mode: 'HTML',
          },
        );
      },
      onExpired: async () => {
        await tgBot.telegram.sendMessage(chatId, '⏰ QR hết hạn, đang tạo mã mới...', msgOpts);
      },
      onScanned: async (displayName) => {
        await tgBot.telegram.sendMessage(
          chatId,
          `✅ Đã quét! Chờ xác nhận từ <b>${displayName}</b>...`,
          { ...msgOpts, parse_mode: 'HTML' },
        );
      },
      onDeclined: async () => {
        await tgBot.telegram.sendMessage(chatId, '❌ Đăng nhập bị từ chối trên điện thoại.', msgOpts);
      },
      onSuccess: async () => {
        await tgBot.telegram.sendMessage(
          chatId,
          '🎉 Đăng nhập Zalo thành công! Bridge đang hoạt động.',
          msgOpts,
        );
      },
    });

    onNewApi(newApi);
  } catch (err) {
    await tgBot.telegram.sendMessage(
      chatId,
      `❌ Đăng nhập thất bại: ${String(err)}`,
      msgOpts,
    ).catch(() => undefined);
  } finally {
    qrLoginInProgress = false;
  }
}

/**
 * Wire up Telegram → Zalo forwarding.
 *
 * @param initialApi  Starting Zalo API (null if not yet logged in).
 * @param onZaloLogin Called with the new API after a successful /login so the
 *                    caller can re-attach the Zalo listener on the fresh API.
 */
export function setupTelegramHandler(
  initialApi: ZaloAPI | null,
  onZaloLogin: (api: ZaloAPI) => Promise<void>,
): (api: ZaloAPI) => void {
  /** Mutable reference so /login can swap in a new API instance. */
  let currentApi: ZaloAPI | null = initialApi;

  /** Exposed setter so index.ts can inject the auto-logged-in API. */
  const setCurrentApi = (api: ZaloAPI) => { currentApi = api; };

  tgBot.command('login', async (ctx) => {
    const isPrivate   = ctx.chat.type === 'private';
    const isFromGroup = ctx.chat.id === config.telegram.groupId;
    if (!isPrivate && !isFromGroup) {
      console.log(`[/login] Bỏ qua từ chat ${ctx.chat.id} (không phải group ${config.telegram.groupId} hoặc DM)`);
      return;
    }
    const threadId = isFromGroup ? ctx.message.message_thread_id : undefined;
    await handleLoginCommand(ctx.chat.id, threadId, (newApi) => {
      currentApi = newApi;
      void onZaloLogin(newApi).catch((e: unknown) => console.error('[/login] onZaloLogin error:', e));
    });
  });

  // /topic – manage bridge topic mappings
  // Usage inside a topic:  /topic info | /topic delete
  // Usage from General:    /topic list
  tgBot.command('topic', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const arg = (ctx.message.text ?? '').split(/\s+/)[1]?.toLowerCase() ?? '';
    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    if (arg === 'list' || !arg) {
      const all = store.all();
      if (all.length === 0) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '📭 Chưa có topic nào.', replyOpts);
        return;
      }
      const lines = all.map(e =>
        `• <b>${e.name}</b> — topicId=${e.topicId}, zaloId=${e.zaloId}, type=${e.type === 1 ? 'group' : 'dm'}`,
      );
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `📋 <b>Bridge topics</b> (${all.length}):\n${lines.join('\n')}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Lệnh này phải được gửi trong một topic cụ thể.',
        replyOpts,
      );
      return;
    }

    if (arg === 'info') {
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ℹ️ <b>${entry.name}</b>\nzaloId: <code>${entry.zaloId}</code>\ntype: ${entry.type === 1 ? 'group' : 'dm'}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (arg === 'delete') {
      const removed = store.remove(topicId);
      if (!removed) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🗑️ Đã xoá mapping: <b>${removed.name}</b> (zaloId=${removed.zaloId})`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      '❓ Dùng: <code>/topic list</code> | <code>/topic info</code> | <code>/topic delete</code>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });

  tgBot.command('recall', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    if (!currentApi) { await ctx.reply('❌ Zalo chưa kết nối'); return; }

    const replyTo = 'reply_to_message' in ctx.message
      ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
      : undefined;

    if (!replyTo) {
      await ctx.reply('ℹ️ Reply vào tin nhắn mình đã gửi rồi gõ /recall');
      return;
    }

    // Look up from sentMsgStore (TG→Zalo messages we sent)
    const sent = sentMsgStore.get(replyTo.message_id);
    if (!sent) {
      await ctx.reply('❌ Không tìm thấy tin nhắn đã gửi (chỉ thu hồi được tin mình gửi từ Telegram, và chỉ trong 300 tin gần nhất)');
      return;
    }

    const { ThreadType } = await import('zca-js');
    const zaloThreadType = sent.threadType === 1 ? ThreadType.Group : ThreadType.User;

    try {
      await currentApi.undo(
        { msgId: sent.msgId, cliMsgId: 0 },
        sent.zaloId,
        zaloThreadType,
      );
      console.log(`[TG→Zalo] Recall msgId=${sent.msgId} zaloId=${sent.zaloId}`);
      await ctx.reply('✅ Đã thu hồi tin nhắn trên Zalo');
    } catch (err) {
      console.error('[TG→Zalo] Recall error:', err);
      await ctx.reply(`❌ Thu hồi thất bại: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  tgBot.command('search', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const query = (ctx.message.text ?? '').replace(/^\/search(?:@[A-Za-z0-9_]+)?\s*/i, '').trim();
    if (!query) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '🔍 Cú pháp: <code>/search Tên hoặc số điện thoại</code>\nHỗ trợ cả <code>/search ...</code> lẫn <code>/search@zalo_tele_bridge_bot ...</code>.\nVí dụ số: <code>094.495.3545</code> hoặc <code>094 593 5345</code>.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!currentApi) { await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts); return; }

    const phoneQuery = normalizePhoneSearchQuery(query);
    if (phoneQuery) {
      try {
        const user = await currentApi.findUser(phoneQuery) as {
          uid?: string;
          display_name?: string;
          zalo_name?: string;
        } | undefined;

        if (!user?.uid) {
          await ctx.telegram.sendMessage(
            config.telegram.groupId,
            `🔍 Không tìm thấy tài khoản Zalo cho số <b>${phoneQuery}</b>.`,
            { ...replyOpts, parse_mode: 'HTML' },
          );
          return;
        }

        const displayName = user.display_name || user.zalo_name || `Zalo ${user.uid}`;
        const existingTopicId = store.getTopicByZalo(user.uid, 0);
        const button: { text: string; callback_data: string } = existingTopicId !== undefined
          ? { text: `👤 ${displayName} ✅`, callback_data: `sc:${user.uid}` }
          : { text: `👤 ${displayName}`, callback_data: `sc:${user.uid}` };

        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `📱 Tìm thấy theo số <b>${phoneQuery}</b>:

✅ = đã có topic • Nhấn để mở nếu đã map, hoặc tạo nếu chưa có`,
          {
            ...replyOpts,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[button]],
            },
          },
        );
        return;
      } catch (err) {
        console.error('[/search] findUser failed:', err);
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `❌ Lỗi tìm số điện thoại <b>${phoneQuery}</b>: ${err instanceof Error ? err.message : String(err)}`,
          { ...replyOpts, parse_mode: 'HTML' },
        );
        return;
      }
    }

    // Refresh friends cache if stale
    if (!friendsCache.isFresh()) {
      try {
        const raw = await currentApi.getAllFriends() as Array<{ userId: string; displayName: string }> | undefined;
        if (raw) {
          friendsCache.set(raw.map(f => ({
            userId:      f.userId,
            displayName: f.displayName,
            alias:       aliasCache.get(f.userId),
          })));
        }
      } catch (err) { console.error('[/search] getAllFriends failed:', err); }
    }

    // Refresh groups cache if stale
    if (!groupsCache.isFresh()) {
      try {
        const rawGroups = await currentApi.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
        const groupIds = Object.keys(rawGroups?.gridVerMap ?? {});
        if (groupIds.length > 0) {
          // Fetch info in batches of 50
          const BATCH = 50;
          const allGroupInfo: Array<{ groupId: string; name: string; totalMember: number }> = [];
          for (let i = 0; i < groupIds.length; i += BATCH) {
            const batch = groupIds.slice(i, i + BATCH);
            try {
              const info = await currentApi.getGroupInfo(batch) as {
                gridInfoMap?: Record<string, { name: string; totalMember: number }>;
              } | undefined;
              for (const [gid, g] of Object.entries(info?.gridInfoMap ?? {})) {
                allGroupInfo.push({ groupId: gid, name: g.name, totalMember: g.totalMember });
              }
            } catch { /* skip batch on error */ }
          }
          groupsCache.set(allGroupInfo);
        }
      } catch (err) { console.error('[/search] getAllGroups failed:', err); }
    }

    const friendResults = friendsCache.search(query, 8);
    const groupResults  = groupsCache.search(query, 8);

    if (friendResults.length === 0 && groupResults.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🔍 Không tìm thấy bạn bè hay nhóm nào có tên chứa "<b>${query}</b>".`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const buttons: Array<Array<{ text: string; callback_data: string } | { text: string; url: string }>> = [];
    for (const f of friendResults) {
      const existingTopicId = store.getTopicByZalo(f.userId, 0);
      const label = aliasCache.label(f.userId, f.displayName);
      buttons.push([existingTopicId !== undefined
        ? { text: `👤 ${label} ✅`, callback_data: `sc:${f.userId}` }
        : { text: `👤 ${label}`, callback_data: `sc:${f.userId}` }]);
    }
    for (const g of groupResults) {
      const existingTopicId = store.getTopicByZalo(g.groupId, 1);
      buttons.push([existingTopicId !== undefined
        ? { text: `👥 ${g.name} (${g.totalMember} TV) ✅`, callback_data: `sg:${g.groupId}` }
        : { text: `👥 ${g.name} (${g.totalMember} TV)`, callback_data: `sg:${g.groupId}` }]);
    }

    const parts: string[] = [`🔍 Kết quả "<b>${query}</b>":`, ''];
    if (friendResults.length > 0) parts.push(`👤 <b>Bạn bè</b> (${friendResults.length}):`);
    if (groupResults.length > 0)  parts.push(`👥 <b>Nhóm</b> (${groupResults.length}):`);
    parts.push('', '✅ = đã có topic • Nhấn để mở nếu đã map, hoặc tạo nếu chưa có');

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      parts.join('\n'),
      { ...replyOpts, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } },
    );
  });

  // /addgroup — list all groups without a topic and let user pick
  tgBot.command('addgroup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!currentApi) { await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts); return; }

    // Refresh groups cache if stale
    if (!groupsCache.isFresh()) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '⏳ Đang tải danh sách nhóm...', replyOpts);
      try {
        const rawGroups = await currentApi.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
        const groupIds = Object.keys(rawGroups?.gridVerMap ?? {});
        const BATCH = 50;
        const allGroupInfo: Array<{ groupId: string; name: string; totalMember: number }> = [];
        for (let i = 0; i < groupIds.length; i += BATCH) {
          const batch = groupIds.slice(i, i + BATCH);
          try {
            const info = await currentApi.getGroupInfo(batch) as {
              gridInfoMap?: Record<string, { name: string; totalMember: number }>;
            } | undefined;
            for (const [gid, g] of Object.entries(info?.gridInfoMap ?? {})) {
              allGroupInfo.push({ groupId: gid, name: g.name, totalMember: g.totalMember });
            }
          } catch { /* skip */ }
        }
        groupsCache.set(allGroupInfo);
      } catch (err) {
        console.error('[/addgroup] failed:', err);
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Không lấy được danh sách nhóm.', replyOpts);
        return;
      }
    }

    // Show unmapped groups (no topic yet), sorted by name
    const unmapped = groupsCache.search('', 50)
      .filter(g => store.getTopicByZalo(g.groupId, 1) === undefined)
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    if (unmapped.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '✅ Tất cả nhóm Zalo đã có topic rồi!',
        replyOpts,
      );
      return;
    }

    const buttons = unmapped.slice(0, 30).map(g => ([{
      text: `👥 ${g.name} (${g.totalMember} TV)`,
      callback_data: `sg:${g.groupId}`,
    }]));

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `📋 <b>Nhóm chưa có topic</b> (${unmapped.length}):\nNhấn để tạo topic:`,
      { ...replyOpts, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } },
    );
  });

  // ── /addfriend <số điện thoại> ─────────────────────────────────────────────
  tgBot.command('addfriend', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const phone = text.split(/\s+/)[1]?.replace(/[^0-9+]/g, '');
    if (!phone) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Dùng: <code>/addfriend &lt;số điện thoại&gt;</code>\nVí dụ: <code>/addfriend 0912345678</code>',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const user = await currentApi.findUser(phone) as {
        uid?: string; display_name?: string; zalo_name?: string; avatar?: string;
        globalId?: string;
      } | undefined;

      if (!user?.uid) {
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `❌ Không tìm thấy người dùng với SĐT <code>${phone}</code>`,
          { ...replyOpts, parse_mode: 'HTML' },
        );
        return;
      }

      const name = user.display_name ?? user.zalo_name ?? `UID ${user.uid}`;
      const status = await currentApi.getFriendRequestStatus(user.uid) as {
        is_friend?: number; is_requested?: number; is_requesting?: number;
      } | undefined;

      let statusLine = '';
      if (status?.is_friend) statusLine = '✅ Đã là bạn bè';
      else if (status?.is_requesting) statusLine = '⏳ Đang chờ họ chấp nhận';
      else if (status?.is_requested) statusLine = '📩 Họ đang chờ bạn chấp nhận';

      const keyboard = statusLine ? [] : [[{
        text: `➕ Kết bạn với ${name}`,
        callback_data: `af:${user.uid}`,
      }]];

      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `👤 <b>${name}</b>\n📱 ${phone}${statusLine ? `\n${statusLine}` : ''}`,
        {
          ...replyOpts,
          parse_mode: 'HTML',
          ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        },
      );
    } catch (err) {
      console.error('[/addfriend]', err);
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Lỗi tìm kiếm người dùng.', replyOpts);
    }
  });

  // ── /friendrequests ────────────────────────────────────────────────────────
  tgBot.command('friendrequests', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    try {
      const [sentReqs, recvRecommends, groupInvites] = await Promise.all([
        currentApi.getSentFriendRequest() as Promise<Record<string, {
          zaloName: string; displayName: string; fReqInfo: { message: string; time: number };
        }>>,
        currentApi.getFriendRecommendations() as Promise<{
          recommItems?: Array<{
            recommItemType: number;
            dataInfo: {
              userId: string;
              zaloName: string;
              displayName: string;
              recommType: number;  // 2 = ReceivedFriendRequest
              recommInfo?: { message?: string | null };
            };
          }>;
        }>,
        currentApi.getGroupInviteBoxList({ invPerPage: 20 }) as Promise<{
          invitations: Array<{
            groupInfo: { groupId: string; name: string; totalMember: number };
            inviterInfo: { dName: string };
            expiredTs: string;
          }>;
          total: number;
        }>,
      ]);

      const parts: string[] = [];
      const inlineKeyboards: Array<[{ text: string; callback_data: string }]> = [];

      // Lời mời kết bạn nhận được (recommType === 2)
      const receivedReqs = (recvRecommends?.recommItems ?? [])
        .filter(item => item.dataInfo?.recommType === 2)
        .map(item => item.dataInfo);
      if (receivedReqs.length > 0) {
        parts.push(`📥 <b>Lời mời kết bạn nhận được (${receivedReqs.length})</b>`);
        for (const u of receivedReqs.slice(0, 20)) {
          const name = escapeHtml(u.displayName || u.zaloName || u.userId);
          const msg  = u.recommInfo?.message ? ` — "${escapeHtml(u.recommInfo.message)}"` : '';
          parts.push(`• ${name}${msg}`);
          inlineKeyboards.push([{
            text: `✅ Chấp nhận ${u.displayName || u.zaloName}`,
            callback_data: `afr:${u.userId}`,
          }]);
        }
        if (receivedReqs.length > 20) parts.push(`  <i>... và ${receivedReqs.length - 20} người khác</i>`);
      }

      // Lời mời kết bạn đã gửi
      const sentList = Object.values(sentReqs ?? {});
      if (sentList.length > 0) {
        parts.push(`\n📤 <b>Lời mời kết bạn đã gửi (${sentList.length})</b>`);
        for (const u of sentList.slice(0, 10)) {
          const name = escapeHtml(u.displayName || u.zaloName);
          const msg  = u.fReqInfo?.message ? ` — "${escapeHtml(u.fReqInfo.message)}"` : '';
          parts.push(`• ${name}${msg}`);
        }
        if (sentList.length > 10) parts.push(`  <i>... và ${sentList.length - 10} người khác</i>`);
      }

      // Lời mời tham gia nhóm
      const invites = groupInvites?.invitations ?? [];
      if (invites.length > 0) {
        parts.push(`\n📬 <b>Lời mời tham gia nhóm (${invites.length})</b>`);
        for (const inv of invites.slice(0, 10)) {
          const g   = inv.groupInfo;
          const exp = new Date(Number(inv.expiredTs) * 1000).toLocaleDateString('vi-VN');
          parts.push(`• 👥 <b>${escapeHtml(g.name)}</b> (${g.totalMember} TV)\n  Mời bởi: ${escapeHtml(inv.inviterInfo.dName)} · HH: ${exp}`);
          inlineKeyboards.push([{
            text: `✅ Tham gia ${g.name}`,
            callback_data: `jgi:${g.groupId}`,
          }]);
        }
      }

      if (parts.length === 0) parts.push('✅ Không có lời mời nào đang chờ.');

      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        parts.join('\n'),
        {
          ...replyOpts,
          parse_mode: 'HTML',
          ...(inlineKeyboards.length > 0 ? { reply_markup: { inline_keyboard: inlineKeyboards } } : {}),
        },
      );
    } catch (err) {
      console.error('[/friendrequests]', err);
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Lỗi lấy danh sách lời mời.', replyOpts);
    }
  });

  // ── /joingroup <link> ──────────────────────────────────────────────────────
  tgBot.command('joingroup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const link = text.split(/\s+/)[1]?.trim();
    if (!link) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Dùng: <code>/joingroup &lt;link nhóm Zalo&gt;</code>',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    try {
      // Thử lấy info link trước (API cần object { link })
      let groupName: string | undefined;
      let totalMember: number | undefined;
      try {
        const linkInfo = await currentApi.getGroupLinkInfo({ link }) as {
          name?: string; totalMember?: number;
        } | undefined;
        groupName   = linkInfo?.name;
        totalMember = linkInfo?.totalMember;
      } catch { /* info fetch failure is non-fatal */ }

      await currentApi.joinGroupLink(link);

      const memberText = totalMember ? ` (${totalMember} TV)` : '';
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        groupName
          ? `✅ Đã tham gia nhóm <b>${escapeHtml(groupName)}</b>${memberText}!`
          : '✅ Đã gửi yêu cầu tham gia nhóm thành công!',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      groupsCache.set([]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[/joingroup]', err);
      // code 178 = already a member, 240 = requires admin approval
      if (errMsg.includes('178')) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '⚠️ Bạn đã là thành viên nhóm này rồi.', replyOpts);
      } else if (errMsg.includes('240')) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '⏳ Nhóm yêu cầu duyệt thành viên. Yêu cầu tham gia đã được gửi đi.', replyOpts);
      } else {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Không thể tham gia nhóm. Link có thể đã hết hạn hoặc không hợp lệ.', replyOpts);
      }
    }
  });

  // ── /leavegroup ─────────────────────────────────────────────────────────────
  // Phải gửi trong topic của nhóm muốn rời. Hiển thị confirm button.
  tgBot.command('leavegroup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!threadId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Hãy gửi lệnh này <b>trong topic của nhóm</b> muốn rời.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const entry = store.getEntryByTopic(threadId);
    if (!entry || entry.type !== 1) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '❌ Topic này không phải nhóm Zalo.',
        replyOpts,
      );
      return;
    }

    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `⚠️ Bạn chắc muốn rời nhóm <b>${entry.name}</b>?\nBot sẽ rời nhóm Zalo và xoá topic này.`,
      {
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Rời nhóm', callback_data: `lg:${threadId}` },
            { text: '❌ Huỷ',      callback_data: 'lg:cancel'       },
          ]],
        },
      },
    );
  });

  // /status — bridge uptime, topic count, Zalo account
  tgBot.command('status', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const replyOpts = ctx.message.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};
    const uptimeSec = Math.floor((Date.now() - _bridgeStartTime) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = `${h}g ${m}p ${s}s`;
    const all = store.all();
    const groupCount = all.filter(e => e.type === 1).length;
    const dmCount    = all.length - groupCount;
    let accountLine = '\n👤 Zalo: <b>chưa kết nối</b>';
    if (currentApi) {
      try {
        const info = await currentApi.fetchAccountInfo() as {
          profile?: { displayName?: string; zaloName?: string };
        };
        const name = info?.profile?.displayName ?? info?.profile?.zaloName ?? '?';
        accountLine = `\n👤 Zalo: <b>${escapeHtml(name)}</b> 🟢`;
      } catch {
        accountLine = '\n👤 Zalo: đã kết nối 🟢';
      }
    }
    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `📊 <b>Trạng thái Bridge</b>${accountLine}\n` +
      `⏱ Uptime: <code>${uptimeStr}</code>\n` +
      `📌 Topics: <b>${all.length}</b> (${groupCount} nhóm, ${dmCount} DM)`,
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });

  tgBot.on('callback_query', async (ctx) => {
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;

    if (data?.startsWith('lock_poll:')) {
      const pollId = Number(data.slice('lock_poll:'.length));
      const entry = pollStore.getByPollId(pollId);
      if (!entry || !currentApi) {
        await ctx.answerCbQuery('❌ Không tìm thấy bình chọn.');
        return;
      }
      try {
        await doLockPoll(entry, currentApi);
        await ctx.answerCbQuery('✅ Đã khoá bình chọn');
      } catch (err) {
        console.error('[TG→Zalo] lock_poll callback error:', err);
        try { await ctx.answerCbQuery('❌ Lỗi khoá bình chọn'); } catch { /* ignore */ }
      }
      return;
    }

    // ── lg: leave group confirm ──────────────────────────────────────────────
    if (data?.startsWith('lg:')) {
      if (data === 'lg:cancel') {
        await ctx.answerCbQuery('❌ Đã huỷ');
        await ctx.editMessageReplyMarkup(undefined);
        return;
      }
      const topicId = Number(data.slice(3));
      const entry = store.getEntryByTopic(topicId);
      if (!entry || !currentApi) {
        await ctx.answerCbQuery('❌ Không tìm thấy topic');
        return;
      }
      try {
        await currentApi.leaveGroup(entry.zaloId);
        store.remove(topicId);
        groupsCache.set([]);
        await ctx.answerCbQuery('✅ Đã rời nhóm');
        await ctx.editMessageReplyMarkup(undefined);
        // Đóng topic (close = archive, không xoá hẳn để còn lịch sử)
        await ctx.telegram.closeForumTopic(config.telegram.groupId, topicId)
          .catch(() => undefined);
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `🚪 Đã rời nhóm <b>${entry.name}</b> và đóng topic.`,
          { message_thread_id: topicId, parse_mode: 'HTML' },
        ).catch(() => undefined);
      } catch (err) {
        console.error('[cb/lg]', err);
        await ctx.answerCbQuery('❌ Rời nhóm thất bại');
      }
      return;
    }

    // ── fr: accept/reject incoming friend request from Zalo ─────────────────
    if (data?.startsWith('fr:')) {
      const parts = data.split(':');
      const action = parts[1]; // 'accept' or 'reject'
      const fromUid = parts[2];
      if (!fromUid || !currentApi) { await ctx.answerCbQuery('❌ Zalo chưa kết nối'); return; }
      try {
        if (action === 'accept') {
          await currentApi.acceptFriendRequest(fromUid);
          await ctx.answerCbQuery('✅ Đã chấp nhận kết bạn!');
          await ctx.editMessageReplyMarkup(undefined);
          await ctx.editMessageText(
            (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
              ? ctx.callbackQuery.message.text ?? ''
              : '') + '\n\n✅ Đã chấp nhận',
            { parse_mode: 'HTML' },
          ).catch(() => undefined);
        } else {
          await currentApi.rejectFriendRequest(fromUid);
          await ctx.answerCbQuery('✅ Đã từ chối');
          await ctx.editMessageReplyMarkup(undefined);
          await ctx.editMessageText(
            (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
              ? ctx.callbackQuery.message.text ?? ''
              : '') + '\n\n❌ Đã từ chối',
            { parse_mode: 'HTML' },
          ).catch(() => undefined);
        }
      } catch (err) {
        console.error('[cb/fr]', err);
        await ctx.answerCbQuery('❌ Thao tác thất bại');
      }
      return;
    }

    // ── af: send friend request ──────────────────────────────────────────────
    if (data?.startsWith('af:')) {
      const userId = data.slice(3);
      if (!currentApi) { await ctx.answerCbQuery('❌ Zalo chưa kết nối'); return; }
      try {
        await currentApi.sendFriendRequest('Xin chào! Mình muốn kết bạn với bạn 😊', userId);
        await ctx.answerCbQuery('✅ Đã gửi lời mời kết bạn!');
        await ctx.editMessageReplyMarkup(undefined);
      } catch (err) {
        console.error('[cb/af]', err);
        await ctx.answerCbQuery('❌ Gửi lời mời thất bại');
      }
      return;
    }

    // ── afr: accept friend request ────────────────────────────────────────────
    if (data?.startsWith('afr:')) {
      const userId = data.slice(4);
      if (!currentApi) { await ctx.answerCbQuery('❌ Zalo chưa kết nối'); return; }
      try {
        await currentApi.acceptFriendRequest(userId);
        await ctx.answerCbQuery('✅ Đã chấp nhận lời mời kết bạn!');
        await ctx.editMessageReplyMarkup(undefined);
      } catch (err) {
        console.error('[cb/afr]', err);
        await ctx.answerCbQuery('❌ Không thể chấp nhận lời mời');
      }
      return;
    }

    // ── jgi: join group from invite box ─────────────────────────────────────
    if (data?.startsWith('jgi:')) {
      const groupId = data.slice(4);
      if (!currentApi) { await ctx.answerCbQuery('❌ Zalo chưa kết nối'); return; }
      try {
        await currentApi.joinGroupInviteBox(groupId);
        await ctx.answerCbQuery('✅ Đã tham gia nhóm!');
        await ctx.editMessageReplyMarkup(undefined);
        groupsCache.set([]);
      } catch (err) {
        console.error('[cb/jgi]', err);
        await ctx.answerCbQuery('❌ Không thể tham gia nhóm');
      }
      return;
    }

    if (!data?.startsWith('sc:') && !data?.startsWith('sg:')) return;

    const isGroup = data.startsWith('sg:');
    const entityId = data.slice(3);
    if (!entityId) { await ctx.answerCbQuery('❌ Dữ liệu không hợp lệ'); return; }
    const threadType: 0 | 1 = isGroup ? 1 : 0;

    // Check if topic already exists and is still alive on Telegram
    const existing = store.getTopicByZalo(entityId, threadType);
    if (existing !== undefined) {
      // Verify the topic still exists by sending a test (or use getForumTopicIconStickers as a proxy)
      // Verify the topic is still alive by actually sending a message to it.
      // sendChatAction doesn't validate thread existence — sendMessage does.
      let topicAlive = false;
      let probeMsg: { message_id: number } | undefined;
      try {
        probeMsg = await ctx.telegram.sendMessage(
          config.telegram.groupId,
          '💬 Topic đang hoạt động. Nhấn để xem.',
          {
            message_thread_id: existing,
            reply_markup: { inline_keyboard: [[{ text: 'Mở topic ↗', url: buildTopicUrl(existing) }]] },
          },
        );
        topicAlive = true;
      } catch (checkErr) {
        const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
        if (
          checkMsg.includes('thread not found') ||
          checkMsg.includes('message thread not found') ||
          checkMsg.includes('TOPIC_CLOSED') ||
          checkMsg.includes('the message thread is closed')
        ) {
          console.warn(`[sc/sg] Topic ${existing} is gone — removing stale mapping for ${entityId}`);
          store.remove(existing);
        } else {
          // Unknown error (e.g. rate limit) — assume alive, don't recreate
          topicAlive = true;
        }
      }
      if (topicAlive) {
        await ctx.answerCbQuery('ℹ️ Topic đã tồn tại');
        return;
      }
      // Topic gone — fall through to recreate
    }

    // Resolve display name
    let displayName: string | undefined;
    if (!isGroup) {
      displayName = friendsCache.search('', 0).find(f => f.userId === entityId)?.displayName;
      if (!displayName) {
        try {
          const resp = await currentApi?.getUserInfo(entityId) as {
            changed_profiles?: Record<string, { displayName?: string }>;
          } | undefined;
          displayName = resp?.changed_profiles?.[entityId]?.displayName;
        } catch { /* ignore */ }
      }
      if (!displayName) displayName = `Zalo ${entityId}`;
    } else {
      displayName = groupsCache.search('', 0).find(g => g.groupId === entityId)?.name;
      if (!displayName) {
        try {
          const info = await currentApi?.getGroupInfo(entityId) as {
            gridInfoMap?: Record<string, { name: string }>;
          } | undefined;
          displayName = info?.gridInfoMap?.[entityId]?.name;
        } catch { /* ignore */ }
      }
      if (!displayName) displayName = `Nhóm ${entityId}`;
    }

    // Create TG forum topic
    try {
      const icon = isGroup ? 0x6FB9F0 : 0xFF93B2;
      const prefix = isGroup ? '👥' : '👤';
      const topic = await ctx.telegram.createForumTopic(
        config.telegram.groupId,
        `${prefix} ${displayName}`.slice(0, 128),
        { icon_color: icon },
      );
      const topicId = topic.message_thread_id;
      store.set({ topicId, zaloId: entityId, type: threadType, name: displayName });
      console.log(`[search/cb] Created ${isGroup ? 'group' : 'DM'} topic "${displayName}" (topicId=${topicId})`);

      await ctx.answerCbQuery('✅ Đã tạo topic!');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        isGroup
          ? `✅ Đã tạo topic cho nhóm <b>${displayName}</b>.\nTin nhắn từ nhóm sẽ xuất hiện tại đây.`
          : `✅ Đã tạo topic cho <b>${displayName}</b>.\nNhắn tin tại đây để chat với họ qua Zalo.`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[search/cb] createForumTopic failed:', err);
      await ctx.answerCbQuery('❌ Tạo topic thất bại');
    }
  });

  // Bot phải là admin và allowed_updates phải có "message_reaction"
  tgBot.on('message_reaction', async (ctx) => {
    try {
      if (!currentApi) return;
      const update = ctx.messageReaction;
      if (!update) return;

      // Determine which reaction was added (new_reaction - old_reaction)
      type EmojiReaction = { type: 'emoji'; emoji: string };
      const isEmoji = (r: { type: string }): r is EmojiReaction => r.type === 'emoji';
      const oldEmojis = new Set(
        update.old_reaction
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter(r => isEmoji(r as any))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map(r => (r as any).emoji as string),
      );
      const added = update.new_reaction
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter(r => isEmoji(r as any) && !oldEmojis.has((r as any).emoji as string));

      // If nothing was added (only removed), skip
      if (added.length === 0) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tgEmoji = (added[0] as any).emoji as string;

      // Map TG emoji → Zalo Reactions icon
      // Zalo Reactions enum values are the icon strings used in addReaction
      const TG_TO_ZALO: Record<string, string> = {
        '❤':  '/-heart',
        '❤️': '/-heart',
        '👍':  '/-strong',
        '👎':  '/-weak',
        '😄':  ':>',
        '😁':  ':>',
        '😢':  ':-((',
        '😭':  ':((',
        '😮':  ':o',
        '😱':  ':o',
        '😡':  ':-h',
        '🤬':  ':-h',
        '😘':  ':-*',
        '🥰':  ';xx',
        '😍':  ';xx',
        '🤣':  ":'>",
        '😂':  ":'>",
        '💩':  '/-shit',
        '🌹':  '/-rose',
        '💔':  '/-break',
        '😕':  ';-/',
        '🤔':  ';-/',
        '😉':  ';-)',
        '👌':  '/-ok',
        '✌️':  '/-v',
        '✌':  '/-v',
        '🙏':  '_()_',
        '👊':  '/-punch',
        '🤯':  ':o',
        '🎉':  '/-bd',
        '🏆':  '/-ok',
        '💯':  '/-ok',
        '😎':  'x-)',
        '🤩':  'x-)',
        '🔥':  '/-heart',
      };

      const zaloIcon = TG_TO_ZALO[tgEmoji];
      if (!zaloIcon) {
        console.log(`[TG→Zalo] Reaction: no Zalo map for TG emoji "${tgEmoji}"`);
        return;
      }

      // Look up Zalo quote data for this TG message
      const tgMsgId = update.message_id;
      const quote   = msgStore.getQuote(tgMsgId);
      if (!quote) {
        console.log(`[TG→Zalo] Reaction: no Zalo quote for TG msg ${tgMsgId}`);
        return;
      }

      const { ThreadType } = await import('zca-js');
      const zaloThreadType = quote.threadType === 1 ? ThreadType.Group : ThreadType.User;

      reactionEchoStore.mark(quote.zaloId, quote.msgId, zaloIcon);
      try {
        await currentApi.addReaction(
          { rType: 0, source: 0, icon: zaloIcon },
          {
            data: { msgId: quote.msgId, cliMsgId: quote.cliMsgId },
            threadId: quote.zaloId,
            type: zaloThreadType,
          },
        );
      } catch (err) {
        reactionEchoStore.cancel(quote.zaloId, quote.msgId, zaloIcon);
        throw err;
      }
      console.log(`[TG→Zalo] Reaction "${tgEmoji}" → Zalo "${zaloIcon}" on msg ${quote.msgId}`);
    } catch (err) {
      console.error('[TG→Zalo] Reaction error:', err);
    }
  });

  tgBot.on('message', async (ctx) => {
    try {
      const msg = ctx.message;
      if (ctx.from?.is_bot) return;
      // Only handle messages from our bridge group
      if (ctx.chat.id !== config.telegram.groupId) return;

      // Must originate from a topic (all bridged conversations live in topics)
      const topicId =
        'message_thread_id' in msg ? (msg.message_thread_id as number | undefined) : undefined;
      if (!topicId) return;

      // Zalo not connected yet
      if (!currentApi) {
        console.warn('[TG→Zalo] currentApi is null – Zalo not connected. Ignoring message.');
        return;
      }

      // Capture api reference so closures below always use the same instance
      const api = currentApi;

      // Look up the corresponding Zalo conversation
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        console.warn(`[TG→Zalo] No Zalo mapping for topicId=${topicId}`);
        return;
      }

      const { zaloId } = entry;
      // Ensure numeric value is correctly mapped to ThreadType enum at runtime
      const threadType: ThreadType = entry.type === 1 ? ThreadType.Group : ThreadType.User;

      // Helper: send TG error notification back to the same topic
      const notifyError = async (action: string, err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: number }).code;
        console.error(`[TG→Zalo] ${action} failed (zaloId=${zaloId}, type=${threadType}):`, err);

        // Provide a friendlier explanation for common Zalo error codes
        let hint = '';
        if (code === 114) {
          hint = threadType === ThreadType.User
            ? '\n💡 <i>Zalo từ chối: chưa kết bạn hoặc người dùng đã bật giới hạn tin nhắn từ người lạ.</i>'
            : '\n💡 <i>Zalo từ chối tham số (code 114).</i>';
        } else if (code === -216) {
          hint = '\n💡 <i>Phiên đăng nhập Zalo hết hạn. Dùng /login để đăng nhập lại.</i>';
        }

        await tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            `⚠️ Gửi thất bại: <b>${action}</b>\n<code>${errMsg}${code != null ? ` (code ${code})` : ''}</code>${hint}`,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      };

      if ('text' in msg && msg.text) {
        // Skip bot commands that were already handled above
        if (msg.text.startsWith('/')) return;
        console.log(`[TG→Zalo] sendMessage → zaloId=${zaloId} type=${threadType} text="${msg.text.slice(0, 80)}"`);
        // Look up Zalo quote data if this TG message is a reply
        const replyToMsgId = msg.reply_to_message?.message_id;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;

        const _rawTextMentions = resolveTgMentions(
          msg.text,
          ('entities' in msg ? msg.entities : undefined) as ReadonlyArray<TgEntity> | undefined,
          threadType === ThreadType.Group,
          threadType === ThreadType.Group ? zaloId : undefined,
        );

        // Auto-prepend @Name when replying to someone else's message in a group
        const _textAutoMention = buildReplyAutoMention(replyToMsgId, threadType);
        const finalText = _textAutoMention ? _textAutoMention.prefix + msg.text : msg.text;
        const zaloMentions = _textAutoMention
          ? [
              _textAutoMention.mention,
              ..._rawTextMentions.map(m => ({ ...m, pos: m.pos + _textAutoMention.prefix.length })),
            ]
          : _rawTextMentions;

        sentMsgStore.markSending(zaloId);
        try {
          let sendResult = await api.sendMessage(
            {
              msg: finalText,
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(zaloMentions.length ? { mentions: zaloMentions } : {}),
            },
            zaloId,
            threadType,
          ).catch(async (err: unknown) => {
            // Code 114 often means the quote data is incompatible (e.g. quoting
            // a media message whose content structure differs from what zca-js
            // expects). Retry without the quote so the text still goes through.
            if ((err as { code?: number }).code === 114 && zaloQuote) {
              console.warn('[TG→Zalo] code 114 with quote, retrying without quote');
              return api.sendMessage(
                {
                  msg: finalText,
                  ...(zaloMentions.length ? { mentions: zaloMentions } : {}),
                },
                zaloId,
                threadType,
              );
            }
            throw err;
          });
          const zaloMsgId = sendResult?.message?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
        } catch (err) {
          await notifyError('sendMessage', err);
        } finally {
          sentMsgStore.unmarkSending(zaloId);
        }
        return;
      }

      // helper: download TG file → send via uploadAttachment → cleanup
      // Local server with --local flag supports up to 2 GB; official API caps at 20 MB
      const TG_FILE_LIMIT = config.telegram.localServer
        ? 2 * 1024 * 1024 * 1024  // 2 GB
        : 20 * 1024 * 1024;        // 20 MB
      const TG_FILE_LIMIT_LABEL = config.telegram.localServer ? '2 GB' : '20 MB';
      const notifyTooBig = async (filename: string, sizeBytes?: number) => {
        const sizeMb = sizeBytes ? ` (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
        await notifyError(
          `sendAttachment(${filename})`,
          new Error(`File${sizeMb} vượt giới hạn ${TG_FILE_LIMIT_LABEL} của Telegram Bot API — không thể tải xuống`),
        );
      };

      const sendAttachment = async (
        fileId: string,
        filename: string,
        fileSize?: number,
        caption?: string,
        captionMentions?: Array<{ pos: number; uid: string; len: number }>,
      ) => {
        if (fileSize !== undefined && fileSize > TG_FILE_LIMIT) {
          await notifyTooBig(filename, fileSize);
          return;
        }
        // Pass Zalo quote if the TG message is a reply to a forwarded Zalo message
        const replyToMsgId = 'reply_to_message' in msg
          ? (msg as { reply_to_message?: { message_id: number } }).reply_to_message?.message_id
          : undefined;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;
        let fileLink: URL;
        try {
          fileLink = await ctx.telegram.getFileLink(fileId);
        } catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(filename, fileSize); return; }
          throw err;
        }
        const localPath = await downloadToTemp(fileLink.toString(), filename);
        sentMsgStore.markSending(zaloId);
        try {
          console.log(`[TG→Zalo] Sending ${filename} → zaloId=${zaloId} type=${threadType}`);
          const withTimeout = <T>(p: Promise<T>) => Promise.race([
            p,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Send timeout (30s)')), 30_000),
            ),
          ]);

          // zca-js splits internally when msg is non-empty + quote is set:
          //   1) sends caption+quote as text (reply indicator in Zalo)
          //   2) sends attachment without quote
          // When no caption, skip the quote — adding a placeholder text just to
          // carry the quote would create visible noise in the conversation.
          const effectiveCaption = caption ?? '';

          const sendResult = await withTimeout(api.sendMessage(
            {
              msg: effectiveCaption,
              attachments: [localPath],
              ...(effectiveCaption.length && zaloQuote ? { quote: zaloQuote } : {}),
              ...(captionMentions?.length ? { mentions: captionMentions } : {}),
            },
            zaloId,
            threadType,
          )).catch(async (err: unknown) => {
            // Code 114 with quote: quote data incompatible with this message type.
            // Retry without quote so the attachment still goes through.
            if ((err as { code?: number }).code === 114) {
              console.warn('[TG→Zalo] code 114 on attachment+quote, retrying without quote');
              return withTimeout(api.sendMessage(
                {
                  msg: effectiveCaption,
                  attachments: [localPath],
                  ...(captionMentions?.length ? { mentions: captionMentions } : {}),
                },
                zaloId,
                threadType,
              ));
            }
            throw err;
          }) as { message?: { msgId?: number } | null; attachment?: Array<{ msgId?: number }> };

          const zaloMsgId = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
          console.log(`[TG→Zalo] Send OK: ${filename}`);
        } catch (err) {
          await notifyError(`sendAttachment(${filename})`, err);
        } finally {
          sentMsgStore.unmarkSending(zaloId);
          await cleanTemp(localPath);
        }
      };

      // Compute auto-mention once for this entire message (reply → prepend @Name)
      const _captionReplyMsgId = ('reply_to_message' in msg
        ? (msg as { reply_to_message?: { message_id: number } }).reply_to_message?.message_id
        : undefined);
      const _autoMentionForMedia = buildReplyAutoMention(_captionReplyMsgId, threadType);

      // Helper: extract caption + resolved mentions from any media message
      const getCaptionMentions = () => {
        const cap = ('caption' in msg ? (msg as { caption?: string }).caption : undefined);
        const capEntities = ('caption_entities' in msg
          ? (msg as { caption_entities?: ReadonlyArray<TgEntity> }).caption_entities
          : undefined);
        const rawMentions = cap
          ? resolveTgMentions(cap, capEntities, threadType === ThreadType.Group, threadType === ThreadType.Group ? zaloId : undefined)
          : [];
        if (_autoMentionForMedia) {
          const prefixLen = _autoMentionForMedia.prefix.length;
          const capMentions = [
            _autoMentionForMedia.mention,
            ...rawMentions.map(m => ({ ...m, pos: m.pos + prefixLen })),
          ];
          return {
            cap: cap ? _autoMentionForMedia.prefix + cap : _autoMentionForMedia.prefix.trimEnd(),
            capMentions,
          };
        }
        return { cap, capMentions: rawMentions.length ? rawMentions : undefined };
      };

      // Helper: flush a media group — download all files and send as single Zalo message
      const flushMediaGroup = async (
        items: import('../store.js').MediaGroupItem[],
        meta: { topicId: number; zaloId: string; threadType: 0 | 1; replyToMsgId?: number },
      ) => {
        const replyMsgId = meta.replyToMsgId;
        const zaloQuote = replyMsgId !== undefined ? msgStore.getQuote(replyMsgId) : undefined;
        const caption = items[0]?.caption ?? '';
        const capMentions = items[0]?.captionMentions;
        const localPaths: string[] = [];
        try {
          for (const item of items) {
            if ((item.fileSize ?? 0) > 20 * 1024 * 1024) continue; // skip oversized
            let fileLink: URL;
            try { fileLink = await tgBot.telegram.getFileLink(item.fileId); }
            catch { continue; }
            localPaths.push(await downloadToTemp(fileLink.toString(), item.fname));
          }
          if (localPaths.length === 0) return;
          const sendResult = await api.sendMessage(
            {
              msg: caption,
              attachments: localPaths,
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(capMentions?.length ? { mentions: capMentions } : {}),
            },
            meta.zaloId,
            meta.threadType === 1 ? ThreadType.Group : ThreadType.User,
          );
          const zaloMsgId = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId;
          if (zaloMsgId !== undefined) {
            // We don't have a single tgMsgId here (multiple), just skip sentMsgStore
            console.log(`[TG→Zalo] Media group sent: ${localPaths.length} files, zaloMsgId=${zaloMsgId}`);
          }
        } catch (err) {
          console.error('[TG→Zalo] Media group send failed:', err);
        } finally {
          for (const lp of localPaths) await cleanTemp(lp);
        }
      };

      // Capture api reference for closures (already defined above but re-alias for flush closure)
      const _api = api;

      if ('photo' in msg && msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1]!;
        const { cap, capMentions } = getCaptionMentions();
        const mediaGroupId = ('media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined);
        if (mediaGroupId) {
          const replyToMsgId = msg.reply_to_message?.message_id;
          mediaGroupStore.add(
            mediaGroupId,
            { fileId: photo.file_id, fname: 'photo.jpg', fileSize: photo.file_size, caption: cap, captionMentions: capMentions },
            { topicId, zaloId, threadType: entry.type, replyToMsgId },
            (items, meta) => { void flushMediaGroup(items, meta); },
          );
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          void _api; // keep reference
          return;
        }
        await sendAttachment(photo.file_id, 'photo.jpg', photo.file_size, cap, capMentions);
        return;
      }

      if ('animation' in msg && msg.animation) {
        const fname = msg.animation.file_name ?? 'animation.gif';
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(msg.animation.file_id, fname, msg.animation.file_size, cap, capMentions);
        return;
      }

      if ('document' in msg && msg.document) {
        const doc   = msg.document;
        const fname = doc.file_name ?? `file_${Date.now()}.bin`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(doc.file_id, fname, doc.file_size, cap, capMentions);
        return;
      }

      if ('video' in msg && msg.video) {
        const vid   = msg.video;
        const fname = vid.file_name?.endsWith('.mp4') ? vid.file_name : `video_${Date.now()}.mp4`;
        const { cap, capMentions } = getCaptionMentions();
        const mediaGroupId = ('media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined);
        if (mediaGroupId) {
          const replyToMsgId = msg.reply_to_message?.message_id;
          mediaGroupStore.add(
            mediaGroupId,
            { fileId: vid.file_id, fname, fileSize: vid.file_size, caption: cap, captionMentions: capMentions },
            { topicId, zaloId, threadType: entry.type, replyToMsgId },
            (items, meta) => { void flushMediaGroup(items, meta); },
          );
          return;
        }

        // Download video → upload to Zalo CDN → send as inline playable video
        if ((vid.file_size ?? 0) > TG_FILE_LIMIT) {
          await notifyTooBig(fname, vid.file_size);
          return;
        }
        let fileLink: URL;
        try { fileLink = await ctx.telegram.getFileLink(vid.file_id); }
        catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(fname, vid.file_size); return; }
          throw err;
        }
        const localVideoPath = await downloadToTemp(fileLink.toString(), fname);
        let localThumbPath: string | undefined;
        try {
          // Extract first frame as thumbnail
          try { localThumbPath = await extractVideoThumbnail(localVideoPath); } catch { /* no thumb */ }

          // Upload video to Zalo CDN
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const videoUploads: any[] = await api.uploadAttachment([localVideoPath], zaloId, threadType);
          const videoUpload = videoUploads?.find((r: { fileType?: string }) => r.fileType === 'video') as
            { fileUrl?: string } | undefined;

          if (!videoUpload?.fileUrl) {
            // Fallback: send as file attachment
            await sendAttachment(vid.file_id, fname, vid.file_size, cap, capMentions);
            return;
          }

          // Upload thumbnail image to Zalo CDN
          let thumbUrl = videoUpload.fileUrl; // worst-case: same URL (shows broken thumb but video works)
          if (localThumbPath) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const thumbUploads: any[] = await api.uploadAttachment([localThumbPath], zaloId, threadType);
              const tu = thumbUploads?.[0] as { normalUrl?: string } | undefined;
              if (tu?.normalUrl) thumbUrl = tu.normalUrl;
            } catch { /* keep fallback thumbUrl */ }
          }

          sentMsgStore.markSending(zaloId);
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await (api.sendVideo as (...a: any[]) => Promise<{ msgId?: number }>)(
              {
                videoUrl:     videoUpload.fileUrl,
                thumbnailUrl: thumbUrl,
                width:        vid.width,
                height:       vid.height,
                duration:     (vid.duration ?? 0) * 1000,
                msg:          cap ?? '',
              },
              zaloId,
              threadType,
            );
            if (result?.msgId !== undefined) {
              sentMsgStore.save(msg.message_id, { msgId: result.msgId, zaloId, threadType });
            }
          } finally {
            sentMsgStore.unmarkSending(zaloId);
          }
        } catch (err) {
          console.error('[TG→Zalo] sendVideo failed, fallback to attachment:', err);
          // Fallback: send as regular file
          try { await sendAttachment(vid.file_id, fname, vid.file_size, cap, capMentions); } catch { /* ignore */ }
        } finally {
          await cleanTemp(localVideoPath);
          if (localThumbPath) await cleanTemp(localThumbPath);
        }
        return;
      }

      if ('voice' in msg && msg.voice) {
        // Telegram voice notes are always small (<1 min OGG Opus), well under 20 MB
        if ((msg.voice.file_size ?? 0) > TG_FILE_LIMIT) {
          await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size);
          return;
        }
        // Download OGG from TG, convert to M4A, upload to Zalo, send as voice bubble
        let fileLink: URL;
        try { fileLink = await ctx.telegram.getFileLink(msg.voice.file_id); }
        catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size); return; }
          throw err;
        }
        const oggPath  = await downloadToTemp(fileLink.toString(), `voice_${Date.now()}.ogg`);
        let m4aPath: string | undefined;
        try {
          m4aPath = await convertToM4a(oggPath);
          // Upload to Zalo CDN to get a voiceUrl
          const uploaded = await api.uploadAttachment(m4aPath, zaloId, threadType) as Array<{ fileUrl?: string }>;
          const voiceUrl = uploaded[0]?.fileUrl;
          if (!voiceUrl) throw new Error('No fileUrl from uploadAttachment');
          console.log(`[TG→Zalo] Sending voice → ${voiceUrl}`);
          await api.sendVoice({ voiceUrl }, zaloId, threadType);
          console.log(`[TG→Zalo] Voice sent OK`);
        } catch (err) {
          console.error('[TG→Zalo] Voice convert/send failed, falling back to file:', err);
          await sendAttachment(msg.voice.file_id, `voice_${Date.now()}.ogg`);
        } finally {
          await cleanTemp(oggPath);
          if (m4aPath) await cleanTemp(m4aPath);
        }
        return;
      }

      if ('sticker' in msg && msg.sticker) {
        const sticker = msg.sticker;
        // For animated (tgs) or video (webm) stickers, use the jpg thumbnail
        // so Zalo receives a viewable image instead of a binary animation blob.
        const useThumb = (sticker.is_animated || sticker.is_video) && sticker.thumbnail;
        const fileId   = useThumb ? sticker.thumbnail!.file_id : sticker.file_id;
        const ext      = useThumb ? '.jpg' : '.webp';
        await sendAttachment(fileId, `sticker_${Date.now()}${ext}`);
        return;
      }

      if ('poll' in msg && msg.poll) {
        const tgPoll = msg.poll;
        console.log(`[TG→Zalo] Received TG poll: id=${tgPoll.id} question="${tgPoll.question}" is_anonymous=${tgPoll.is_anonymous}`);

        if (threadType !== 1) {
          await ctx.reply('❌ Chỉ tạo bình chọn được trong nhóm Zalo.', { message_thread_id: topicId });
          return;
        }

        try {
          // 1. Create poll on Zalo
          const created = await api.createPoll(
            {
              question:         tgPoll.question,
              options:          tgPoll.options.map((o: { text: string }) => o.text),
              isAnonymous:      false,   // force non-anonymous so poll_answer fires
              allowMultiChoices: tgPoll.allows_multiple_answers ?? false,
            },
            zaloId,
          );
          console.log(`[TG→Zalo] Zalo poll created: pollId=${created?.poll_id}`);

          // 2. Bot re-creates the same poll on TG (non-anonymous so bot gets poll_answer)
          const botPollMsg = await tgBot.telegram.sendPoll(
            config.telegram.groupId,
            tgPoll.question,
            tgPoll.options.map((o: { text: string }) => o.text),
            {
              message_thread_id:       topicId,
              is_anonymous:            false,
              allows_multiple_answers: tgPoll.allows_multiple_answers ?? false,
            } as Parameters<typeof tgBot.telegram.sendPoll>[3],
          );
          const tgPollUUID = (botPollMsg as { poll?: { id?: string } }).poll?.id ?? '';
          console.log(`[TG→Zalo] Bot TG poll sent: msgId=${botPollMsg.message_id} uuid=${tgPollUUID}`);

          // 3. Build option list from Zalo response
          const zaloPollOptions = created?.options ?? tgPoll.options.map((o: { text: string }, i: number) => ({
            option_id: i, content: o.text, votes: 0,
          }));

          // 4. Send score message below bot's poll
          const scoreLines = zaloPollOptions.map((o: { content: string }) =>
            `${o.content}\n  ${'░'.repeat(10)} 0 phiếu (0%)`,
          );
          const scoreText = `📊 <b>Kết quả bình chọn</b>\n<i>(tạo từ Telegram)</i>\n\nTổng: 0 phiếu\n\n${scoreLines.join('\n\n')}`;
          const lockPollId = created?.poll_id ?? 0;
          const tgScoreMsg = await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            scoreText,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              reply_parameters: { message_id: botPollMsg.message_id, allow_sending_without_reply: true },
              reply_markup: {
                inline_keyboard: [[
                  { text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${lockPollId}` },
                ]],
              },
            },
          );

          // 5. Save to pollStore — keyed by both pollId and tgPollUUID
          if (created?.poll_id) {
            pollStore.save({
              pollId:           created.poll_id,
              zaloGroupId:      zaloId,
              tgPollMsgId:      botPollMsg.message_id,
              tgOrigPollMsgId:  msg.message_id,   // user's original poll
              tgPollUUID:       tgPollUUID,
              tgScoreMsgId:     tgScoreMsg.message_id,
              tgThreadId:       topicId,
              options: zaloPollOptions.map((o: { option_id?: number; content: string }, i: number) => ({
                option_id: o.option_id ?? i,
                content:   o.content,
              })),
            });
          }
        } catch (err) {
          console.error('[TG→Zalo] createPoll failed:', err);
          await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            '❌ Không thể tạo bình chọn trên Zalo.',
            { message_thread_id: topicId },
          );
        }
        return;
      }

      if ('location' in msg && msg.location) {
        const { latitude, longitude } = msg.location;
        const venue = ('venue' in msg && msg.venue) ? (msg.venue as { title?: string; address?: string }) : undefined;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const locationLabel = venue?.title
          ? `📍 ${venue.title}${venue.address ? ` — ${venue.address}` : ''}\n${mapsUrl}`
          : `📍 ${mapsUrl}`;
        try {
          // zca-js has no sendLocation — send as plain text with coords
          await api.sendMessage({ msg: locationLabel }, zaloId, threadType);
          console.log(`[TG→Zalo] Location sent: ${latitude},${longitude}`);
        } catch (err) {
          console.error('[TG→Zalo] Location send error:', err);
        }
        return;
      }

      if ('contact' in msg && msg.contact) {
        const contact = msg.contact as { phone_number: string; first_name: string; last_name?: string; user_id?: number };
        const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
        // Try to send via sendCard if we can resolve the Zalo UID from the phone number
        // Fall back to sending contact info as a plain text message
        let cardSent = false;
        if (contact.user_id) {
          // TG user_id is not Zalo UID, skip sendCard attempt
        }
        if (!cardSent) {
          const body = `👤 <b>Danh thiếp</b>\nTên: <b>${fullName}</b>\nSĐT: <code>${contact.phone_number}</code>`;
          try {
            await api.sendMessage({ msg: `👤 ${fullName} — ${contact.phone_number}` }, zaloId, threadType);
          } catch (err) {
            await notifyError('sendContact', err);
          }
          // Also send formatted version on TG side as confirmation (just log)
          void body;
        }
        return;
      }
    } catch (err) {
      console.error('[TG→Zalo] Error:', err);
    }
  });

  async function doLockPoll(entry: import('../store.js').PollEntry, api: ZaloAPI): Promise<void> {
    await api.lockPoll(entry.pollId);
    console.log(`[TG→Zalo] Locked Zalo poll ${entry.pollId}`);
    // Stop bot's clone TG poll
    try {
      await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgPollMsgId);
    } catch { /* already stopped or no permission */ }
    // Stop original user poll too (if we have its message_id)
    if (entry.tgOrigPollMsgId) {
      try {
        await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgOrigPollMsgId);
      } catch { /* no admin rights or already stopped */ }
    }
    // Update score message: show [Đã đóng], remove lock button
    try {
      const detail = await api.getPollDetail(entry.pollId);
      if (detail?.options) {
        const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
        const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
          const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
          const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
          return `${o.content}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
        });
        const scoreText = `📊 <b>Kết quả bình chọn <i>[Đã đóng]</i></b>\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
        try {
          await tgBot.telegram.editMessageText(
            config.telegram.groupId,
            entry.tgScoreMsgId,
            undefined,
            scoreText,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
          );
        } catch { /* too old to edit */ }
      }
    } catch { /* non-fatal */ }
  }

  tgBot.on('poll', async (ctx) => {
    try {
      const poll = ctx.poll;
      if (!poll.is_closed) return;
      const entry = pollStore.getByTgPollUUID(poll.id);
      if (!entry || !currentApi) return;
      await doLockPoll(entry, currentApi);
    } catch (err) {
      console.error('[TG→Zalo] lockPoll error:', err);
    }
  });

  tgBot.on('poll_answer', async (ctx) => {
    try {
      const answer = ctx.pollAnswer;
      // answer.option_ids: array of 0-based indices chosen in TG poll
      // answer.poll_id: TG internal poll ID (NOT the Zalo pollId)
      // We track by message_id via pollStore, but Telegraf poll_answer only has poll_id.
      // pollStore also indexes by tgPollMsgId. TG doesn't give us the message_id in poll_answer,
      // so we keep a secondary index by TG poll UUID in our store via a separate lookup.
      // Telegraf ctx.pollAnswer.poll_id is the TG poll identifier — we stored tgPollMsgId.
      // Workaround: iterate pollStore (small set) by checking tgPollUUID stored during creation.

      // Since we can only look up by tgPollMsgId but TG gives us poll_id (a string UUID),
      // we store the mapping tgPollUUID → pollId when the poll is sent.
      const tgPollUUID = answer.poll_id;
      console.log(`[TG→Zalo] poll_answer: poll_id=${tgPollUUID} option_ids=[${answer.option_ids}]`);
      const entry = pollStore.getByTgPollUUID(tgPollUUID);
      if (!entry) {
        console.log('[TG→Zalo] poll_answer: unknown poll UUID', tgPollUUID);
        return;
      }

      if (!currentApi) return;
      const api = currentApi;

      // Map TG 0-based option indices → Zalo option_ids
      const optionIds = answer.option_ids
        .map(idx => entry.options[idx]?.option_id)
        .filter((id): id is number => id !== undefined);

      // empty option_ids = user retracted vote — refresh score only, no Zalo call
      const refreshScore = async () => {
        try {
          const detail = await api.getPollDetail(entry.pollId);
          if (!detail?.options) return;
          const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
          const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
            const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
            const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
            return `${o.content}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
          });
          const status = detail.closed ? ' <i>[Đã đóng]</i>' : '';
          const scoreText = `📊 <b>Kết quả bình chọn${status}</b>\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
          const replyMarkup = detail.closed
            ? { inline_keyboard: [] as { text: string; callback_data: string }[][] }
            : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${entry.pollId}` }]] };
          try {
            await tgBot.telegram.editMessageText(
              config.telegram.groupId,
              entry.tgScoreMsgId,
              undefined,
              scoreText,
              { parse_mode: 'HTML', reply_markup: replyMarkup },
            );
          } catch {
            const newMsg = await tgBot.telegram.sendMessage(
              config.telegram.groupId,
              scoreText,
              { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                reply_markup: replyMarkup },
            );
            pollStore.updateScoreMsg(entry.pollId, newMsg.message_id);
          }
        } catch (e) {
          console.warn('[TG→Zalo] poll score refresh failed:', e);
        }
      };

      if (optionIds.length === 0) {
        // Vote retracted — unvote on Zalo then refresh score
        try {
          await api.votePoll(entry.pollId, []);
          console.log(`[TG→Zalo] Unvoted poll ${entry.pollId}`);
        } catch (e) {
          console.warn('[TG→Zalo] unvote failed:', e);
        }
        await refreshScore();
        return;
      }

      // votePoll accepts single id or array
      await api.votePoll(entry.pollId, optionIds.length === 1 ? optionIds[0] : optionIds);
      console.log(`[TG→Zalo] Voted poll ${entry.pollId} options [${optionIds}]`);

      // Immediately refresh score message
      await refreshScore();
    } catch (err) {
      console.error('[TG→Zalo] poll_answer error:', err);
    }
  });

  return setCurrentApi;
}

// Called by setupTelegramHandler, but defined after so we can reference tgBot directly.

