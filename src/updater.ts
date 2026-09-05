import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Context, Telegraf, Telegram } from 'telegraf';

import { config } from './config.js';
import { requestShutdown } from './lifecycle.js';
import { escapeHtml } from './utils/format.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let _notifiedCommit: string | null = null;
let _isUpdating = false;

function gitExec(...args: string[]): string {
  return execFileSync('git', args, { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
}

function gitConfig(key: string): string {
  try {
    return gitExec('config', '--get', key);
  } catch {
    return '';
  }
}

function updateTarget(): { remote: string; branch: string } {
  const currentBranch = (() => {
    try { return gitExec('symbolic-ref', '--short', 'HEAD'); } catch { return ''; }
  })();
  const branch = process.env.ZALO_TG_UPDATE_BRANCH?.trim()
    || currentBranch
    || 'main';
  const configuredRemote = currentBranch
    ? gitConfig(`branch.${currentBranch}.remote`)
    : '';
  const remote = process.env.ZALO_TG_UPDATE_REMOTE?.trim()
    || configuredRemote
    || 'origin';
  if (!/^[A-Za-z0-9._/-]+$/.test(remote) || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    throw new Error('Invalid update remote or branch name');
  }
  return { remote, branch };
}

function updateRef(): string {
  const { remote, branch } = updateTarget();
  return `${remote}/${branch}`;
}

function getNewCommit(): string | null {
  try {
    const { remote, branch } = updateTarget();
    gitExec('fetch', remote, branch, '--quiet');
    const ref = `${remote}/${branch}`;
    const behind = gitExec('log', `HEAD..${ref}`, '--oneline');
    if (!behind) return null;
    return gitExec('rev-parse', '--short', ref);
  } catch {
    return null;
  }
}

function getChangelog(): string {
  try {
    return gitExec('log', `HEAD..${updateRef()}`, '--oneline', '--no-merges');
  } catch {
    return '';
  }
}

export function startUpdateChecker(bot: Telegraf): void {

  const isAdminCallback = async (ctx: Context): Promise<boolean> => {
    const callbackQuery = ctx.callbackQuery;
    const from = ctx.from;
    const message = callbackQuery?.message;
    if (!message || !from || message.chat.id !== config.telegram.groupId) return false;
    try {
      const member = await ctx.telegram.getChatMember(config.telegram.groupId, from.id);
      return member.status === 'creator' || member.status === 'administrator';
    } catch {
      return false;
    }
  };

  // ── Inline button handlers (must be registered before catch-all callback_query) ─
  bot.action('upd:skip', async (ctx) => {
    if (!await isAdminCallback(ctx)) {
      await ctx.answerCbQuery('⛔ Chỉ admin Telegram mới có thể thao tác.', { show_alert: true }).catch(() => undefined);
      return;
    }
    await ctx.answerCbQuery('⏰ Đã huỷ').catch(() => undefined);
    await ctx.deleteMessage().catch(() => undefined);
  });

  bot.action('upd:confirm', async (ctx) => {
    if (!await isAdminCallback(ctx)) {
      await ctx.answerCbQuery('⛔ Chỉ admin Telegram mới có thể cập nhật.', { show_alert: true }).catch(() => undefined);
      return;
    }
    if (_isUpdating) {
      await ctx.answerCbQuery('⏳ Đang cập nhật...').catch(() => undefined);
      return;
    }
    _isUpdating = true;

    try {
      await ctx.answerCbQuery('⏳ Đang cập nhật...').catch(() => undefined);

      await ctx.editMessageText(
        '⏳ <b>Đang cập nhật...</b>\n\ngit pull...',
        { parse_mode: 'HTML' },
      ).catch(() => undefined);

      // 1. git pull from the configured fork/update remote.
      const { remote, branch } = updateTarget();
      execFileSync('git', ['pull', '--autostash', remote, branch], { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120_000 });

      await ctx.editMessageText(
        '⏳ <b>Đang cập nhật...</b>\n\n✅ git pull\nnpm install...',
        { parse_mode: 'HTML' },
      ).catch(() => undefined);

      // 2. npm install
      execFileSync('npm', ['install'], { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 180_000 });

      await ctx.editMessageText(
        '⏳ <b>Đang cập nhật...</b>\n\n✅ git pull\n✅ npm install\nnpm run build...',
        { parse_mode: 'HTML' },
      ).catch(() => undefined);

      // 3. build
      execFileSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 120_000 });

      const isRunner = process.env.ZALO_TG_RUNNER === '1';
      if (isRunner) {
        await ctx.editMessageText(
          '✅ <b>Cập nhật thành công!</b>\nĐang khởi động lại...',
          { parse_mode: 'HTML' },
        ).catch(() => undefined);
        console.log('[Updater] Update complete — restarting via exit code 42');
        setTimeout(() => { void requestShutdown('Update installed', 42); }, 500);
      } else {
        await ctx.editMessageText(
          '✅ <b>Cập nhật thành công!</b>\nChạy <code>./run.sh</code> thay vì <code>npm start</code> để tự động restart.\nHoặc khởi động lại thủ công.',
          { parse_mode: 'HTML' },
        ).catch(() => undefined);
        console.log('[Updater] Update complete — restart manually (run.sh not detected)');
        _isUpdating = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Updater] Update failed:', msg);
      await ctx.editMessageText(
        `❌ <b>Cập nhật thất bại</b>\n<code>${escapeHtml(msg)}</code>`,
        { parse_mode: 'HTML' },
      ).catch(() => undefined);
      _isUpdating = false;
    }
  });

  // ── Periodic check ──────────────────────────────────────────────────────
  const autoCheck = async () => {
    const commit = getNewCommit();
    if (!commit) return;
    if (_notifiedCommit === commit) return;
    await sendUpdateNotification(bot.telegram, commit);
  };

  setTimeout(autoCheck, 60_000);
  setInterval(autoCheck, 10 * 60_000);
}

/** Send update notification with inline buttons to the configured group. */
async function sendUpdateNotification(tg: Telegram, commit: string): Promise<void> {
  _notifiedCommit = commit;
  const changelog = getChangelog();
  try {
    await tg.sendMessage(
      config.telegram.groupId,
      `🔔 <b>Có bản cập nhật mới!</b> (<code>${commit}</code>)\n\n${
        changelog
          ? changelog.split('\n').slice(0, 10).map(l => `• ${escapeHtml(l)}`).join('\n')
          : ''
      }`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Cập nhật ngay', callback_data: 'upd:confirm' },
              { text: '⏰ Để sau',         callback_data: 'upd:skip' },
            ],
          ],
        },
      },
    );
  } catch (err) {
    console.error('[Updater] Failed to send notification:', err);
    _notifiedCommit = null;
  }
}

/**
 * Manual trigger — call from /update command.
 * Returns true if a new update was found and notified.
 */
export async function triggerUpdateCheck(tg: Telegram): Promise<boolean> {
  const commit = getNewCommit();
  if (!commit) return false;
  await sendUpdateNotification(tg, commit);
  return true;
}
