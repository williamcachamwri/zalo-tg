/** Truncate a string to `max` characters, appending ellipsis if cut. */
export function truncate(text: string, max = 4096): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Escape characters special to Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Apply Zalo mention metadata to a plain-text message body, returning an
 * HTML-escaped string with each mention span wrapped in `<b>` tags.
 *
 * @param text     Raw (unescaped) message content.
 * @param mentions Array of {pos, len, type} from TGroupMessage.mentions.
 */
export function applyMentionsHtml(
  text: string,
  mentions: ReadonlyArray<{ pos: number; len: number; type: number }>,
): string {
  if (!mentions.length) return escapeHtml(text);

  const sorted = [...mentions].sort((a, b) => a.pos - b.pos);
  let result = '';
  let cursor = 0;

  for (const m of sorted) {
    // Guard against out-of-range or overlapping mentions
    if (m.pos < cursor || m.pos >= text.length) continue;
    if (m.pos > cursor) result += escapeHtml(text.slice(cursor, m.pos));
    const span = text.slice(m.pos, m.pos + m.len);
    result += `<b>${escapeHtml(span)}</b>`;
    cursor = m.pos + m.len;
  }

  if (cursor < text.length) result += escapeHtml(text.slice(cursor));
  return result;
}

// ── Zalo rich text markup ────────────────────────────────────────────────────

/** Zalo style code → HTML tag mapping (only tags valid in Telegram HTML mode). */
const ZALO_STYLE_TAGS: Readonly<Record<string, string>> = {
  b: 'b',
  i: 'i',
  u: 'u',
  s: 's',
};

export interface ZaloStyle {
  start: number;
  len: number;
  /** 'b' | 'i' | 'u' | 's' | 'c_xxxxxx' | 'f_xx' | 'lst_x' | 'ind_xx' */
  st: string;
}

/**
 * Apply both Zalo text styles (bold/italic/underline/strike) AND mention spans
 * to a raw plain-text string, returning a fully HTML-escaped string suitable
 * for Telegram's HTML parse mode.
 *
 * Both `mentions` and `styles` use character-index ranges in the original text.
 * Overlapping/nested ranges are handled by tracking open/close events per
 * position — Telegram's HTML parser tolerates non-strictly-nested tags.
 */
export function applyZaloMarkupHtml(
  text: string,
  mentions?: ReadonlyArray<{ pos: number; len: number; type: number }>,
  styles?: ReadonlyArray<ZaloStyle>,
): string {
  const opens  = new Map<number, string[]>();
  const closes = new Map<number, string[]>();

  const addOpen  = (pos: number, tag: string) => { if (!opens.has(pos))  opens.set(pos, []);  opens.get(pos)!.push(tag); };
  const addClose = (pos: number, tag: string) => { if (!closes.has(pos)) closes.set(pos, []); closes.get(pos)!.push(tag); };

  // Register style spans
  if (styles?.length) {
    const sorted = [...styles].sort((a, b) => a.start - b.start || a.len - b.len);
    for (const s of sorted) {
      const tag = ZALO_STYLE_TAGS[s.st];
      if (!tag || s.len <= 0 || s.start < 0 || s.start >= text.length) continue;
      const end = Math.min(s.start + s.len, text.length);
      addOpen(s.start, tag);
      addClose(end, tag);
    }
  }

  // Register mention spans (bold)
  if (mentions?.length) {
    for (const m of mentions) {
      if (m.pos < 0 || m.pos >= text.length || m.len <= 0) continue;
      const end = Math.min(m.pos + m.len, text.length);
      addOpen(m.pos, 'b');
      addClose(end, 'b');
    }
  }

  if (opens.size === 0) return escapeHtml(text);

  let result = '';
  for (let i = 0; i <= text.length; i++) {
    // Close tags before opening new ones at the same position
    const cls = closes.get(i);
    if (cls) for (const t of cls) result += `</${t}>`;
    const opn = opens.get(i);
    if (opn) for (const t of opn) result += `<${t}>`;
    if (i < text.length) result += escapeHtml(text[i]!);
  }
  return result;
}

/**
 * Format a group message as:
 *   <b>SenderName:</b>
 *   content…
 */
export function formatGroupMsg(senderName: string, content: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${escapeHtml(truncate(content))}`;
}

/**
 * Format a group message with pre-escaped HTML body (e.g. when mention spans
 * have already been wrapped in <b> tags).
 */
export function formatGroupMsgHtml(senderName: string, bodyHtml: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${bodyHtml}`;
}

/** Caption for group media (just bold sender name). */
export function groupCaption(senderName: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}</b>`;
}

/**
 * Format a Telegram Topic name:
 *   👤 Name  (DM)
 *   👥 Name  (Group)
 * Telegram's max topic name length is 128 chars.
 */
export function topicName(name: string, type: 0 | 1): string {
  return `${type === 1 ? '👥' : '👤'} ${name}`.slice(0, 128);
}
