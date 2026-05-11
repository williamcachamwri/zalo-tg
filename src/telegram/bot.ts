import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

const BOT_COMMANDS = [
  { command: 'login',  description: 'Đăng nhập Zalo bằng QR' },
  { command: 'search', description: 'Tìm alias, tên, nhóm hoặc số điện thoại' },
  { command: 'recall', description: 'Thu hồi tin nhắn đã gửi sang Zalo' },
  { command: 'topic',  description: 'Quản lý topic: list | info | delete' },
];

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});

export async function syncTelegramCommands(): Promise<void> {
  await tgBot.telegram.setMyCommands(BOT_COMMANDS);
}
