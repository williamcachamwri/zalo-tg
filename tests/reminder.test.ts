import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadType } from 'zca-js';
import { fetchEcardReminderTitle, parseEcardReminderRef } from '../src/zalo/reminder.js';
import type { ZaloAPI } from '../src/zalo/types.js';

function ecardParams(act: string, actType: string, inner: Record<string, unknown>): string {
  const actionData = JSON.stringify({ act, act_type: actType, data: JSON.stringify(inner) });
  return JSON.stringify({
    notifyTxt: '⏰ Có một nguyên tắc rất cơ b...',
    actions: [{ actionId: 'action.open.reminder', data: actionData }],
  });
}

const FULL_TITLE = 'Có một nguyên tắc rất cơ bản, nếu chúng ta muốn có những người bạn thật sự…';

test('parseEcardReminderRef reads a one-to-one reminder ID', () => {
  const params = ecardParams('remind_reminder11', 'oneone', {
    reminderId: '216172782396536215',
    params: { title: 'Có một nguyên tắc rất cơ b...' },
  });
  assert.deepEqual(parseEcardReminderRef(params), { kind: 'oneone', reminderId: '216172782396536215' });
});

test('parseEcardReminderRef reads a group reminder topic ID', () => {
  const params = ecardParams('remind_topic', 'group', { topicId: '360287970406990346', group_id: '0' });
  assert.deepEqual(parseEcardReminderRef(params), { kind: 'group', topicId: '360287970406990346' });
});

test('parseEcardReminderRef ignores birthday cards and malformed params', () => {
  assert.equal(parseEcardReminderRef(JSON.stringify({ notifyTxt: 'Sinh nhật', actions: [] })), null);
  assert.equal(parseEcardReminderRef('not json'), null);
  assert.equal(parseEcardReminderRef(undefined), null);
  assert.equal(parseEcardReminderRef(ecardParams('remind_reminder11', 'oneone', { reminderId: '0' })), null);
});

function fakeApi(lists: Record<string, unknown>, ownId = 'own-uid'): { api: ZaloAPI; calls: string[] } {
  const calls: string[] = [];
  const api = {
    getOwnId: () => ownId,
    getListReminder: async (_opts: unknown, uid: string, type: ThreadType) => {
      calls.push(`${uid}:${type}`);
      const list = lists[uid];
      if (list instanceof Error) throw list;
      return list ?? [];
    },
    getReminder: async (topicId: string) => ({ id: topicId, params: { title: `group ${topicId}` } }),
  } as unknown as ZaloAPI;
  return { api, calls };
}

test('fetchEcardReminderTitle falls back to the own UID for the self chat', async () => {
  const { api, calls } = fakeApi({
    'self-thread': new Error('code -1'),
    'own-uid': [{ reminderId: '216172782396536215', params: { title: FULL_TITLE } }],
  });
  const title = await fetchEcardReminderTitle(api, { kind: 'oneone', reminderId: '216172782396536215' }, 'self-thread');
  assert.equal(title, FULL_TITLE);
  assert.deepEqual(calls, [`self-thread:${ThreadType.User}`, `own-uid:${ThreadType.User}`]);
});

test('fetchEcardReminderTitle returns null when the reminder is gone', async () => {
  const { api } = fakeApi({ peer: [{ reminderId: 'other', params: { title: 'x' } }] });
  assert.equal(await fetchEcardReminderTitle(api, { kind: 'oneone', reminderId: 'missing' }, 'peer'), null);
});

test('fetchEcardReminderTitle reads group reminders by topic ID', async () => {
  const { api } = fakeApi({});
  assert.equal(await fetchEcardReminderTitle(api, { kind: 'group', topicId: '42' }, 'group-1'), 'group 42');
});
