import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

const BOT_COMMANDS = [
  { command: 'login',          description: 'Đăng nhập Zalo bằng QR' },
  { command: 'search',         description: 'Tìm tên, nhóm hoặc số điện thoại' },
  { command: 'recall',         description: 'Thu hồi tin nhắn đã gửi sang Zalo' },
  { command: 'topic',          description: 'Quản lý topic: list | info | delete' },
  { command: 'addgroup',       description: 'Tạo nhóm Zalo mới từ topic hiện tại' },
  { command: 'addfriend',      description: 'Gửi lời mời kết bạn Zalo' },
  { command: 'friendrequests', description: 'Xem & duyệt lời mời kết bạn đang chờ' },
  { command: 'joingroup',      description: 'Tham gia nhóm Zalo qua link mời' },
  { command: 'leavegroup',     description: 'Rời nhóm Zalo của topic hiện tại' },
  { command: 'status',         description: 'Xem trạng thái kết nối & thống kê bridge' },
];

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});

export async function syncTelegramCommands(): Promise<void> {
  await tgBot.telegram.setMyCommands(BOT_COMMANDS);
}
