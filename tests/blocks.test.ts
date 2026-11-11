import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { blockLine, messageBlocks } from '../server/native/blocks.js';
import type { NativeMessage } from '../server/native/types.js';

// Block shapes follow upstream packages/shared/src/types/rich.ts at the pinned
// commit; the card is a trimmed copy of a real taste proposal message.
const card = { id: 'taste-proposal-p1', kind: 'card', v: 1, title: '提议捕捉品味信号', bodyMarkdown: '**猫的判断：** 偏好简短', tone: 'info',
  fields: [{ label: '维度', value: '真实表达' }, { label: 'bad' }], meta: { approval: { producerId: 'F221', canonicalProposalId: 'p1' } } };
const checklist = { id: 'todo', kind: 'checklist', v: 1, title: '今天', items: [{ id: 'a', text: '买猫粮', checked: true }, { id: 'b', text: '洗碗' }, { text: 'no id' }] };
const choices = { id: 'pick', kind: 'interactive', v: 1, interactiveType: 'multi-select', title: '选口味', maxSelect: 2, messageTemplate: '我要 {selection}',
  options: [{ id: 'fish', label: '鱼', emoji: '🐟' }, { id: 'meat', label: '肉', description: '牛肉' }, { id: 'other', label: '别的', customInput: true }] };
const reply = (extra: Record<string, unknown>, content = ''): NativeMessage => ({ id: 'm1', type: 'assistant', catId: 'cat', timestamp: 1000, content, extra });

test('a cat’s cards, lists, choices and diffs come through as chat blocks; what cannot be drawn is counted', () => {
  const { blocks, hidden } = messageBlocks(reply({ rich: { v: 1, blocks: [card, checklist, choices,
    { id: 'patch', kind: 'diff', v: 1, filePath: '/Users/me/ws/src/app.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
    { id: 'f', kind: 'file', v: 1, url: '/uploads/x.pdf', fileName: 'x.pdf' },          // files have their own projection
    { id: 'song', kind: 'audio', v: 1, url: '/a.wav' }, { id: 'w', kind: 'html_widget', v: 1, html: '<b>x</b>' },
    { id: 'pics', kind: 'media_gallery', v: 1, items: [] }, { kind: 'card', title: 'no id' }, { id: 'empty', kind: 'checklist', items: [] }, 'junk'] } }));
  assert.deepEqual(blocks, [
    { id: 'taste-proposal-p1', kind: 'card', title: '提议捕捉品味信号', body: '**猫的判断：** 偏好简短', tone: 'info', fields: [{ label: '维度', value: '真实表达' }], approval: { id: 'p1' } },
    { id: 'todo', kind: 'checklist', title: '今天', items: [{ id: 'a', text: '买猫粮', checked: true }, { id: 'b', text: '洗碗', checked: false }] },
    { id: 'pick', kind: 'choices', mode: 'multiple', title: '选口味', max: 2, template: '我要 {selection}', answered: false, selected: [],
      options: [{ id: 'fish', label: '鱼', emoji: '🐟' }, { id: 'meat', label: '肉', description: '牛肉' }, { id: 'other', label: '别的', custom: true }] },
    { id: 'patch', kind: 'diff', file: 'app.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
  ]);
  assert.equal(hidden, 6, 'audio, widget, gallery and three malformed entries');
  // What native recorded about a choice already made.
  const answered = messageBlocks(reply({ rich: { blocks: [{ ...choices, interactiveType: 'confirm', disabled: true, selectedIds: ['fish'] }] } })).blocks[0] as any;
  assert.deepEqual([answered.mode, answered.answered, answered.selected], ['confirm', true, ['fish']]);
  assert.deepEqual(messageBlocks(reply({})), { blocks: [], hidden: 0 });
  assert.deepEqual(messageBlocks(reply({ rich: 'nope' })), { blocks: [], hidden: 0 });
  assert.equal(blockLine(blocks), '提议捕捉品味信号');
  assert.equal(blockLine(blocks.slice(2)), '选口味'); assert.equal(blockLine(blocks.slice(3)), 'app.ts'); assert.equal(blockLine([]), '');
  assert.equal(blockLine([{ id: 'x', kind: 'checklist', items: [{ id: 'a', text: '买猫粮', checked: false }] }]), '买猫粮');
});

async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-blocks-')), native = new NativeFixture();
  const app = createApp({ native, dataFile: join(dir, 'presentation.json') });
  const server = app.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/xbot-api${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { await app.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const cat = await app.bridge.createBot({ name: 'Ada' }), thread = await app.bridge.direct(cat);
  return { ...app, native, call, cat, thread };
}

test('a reply that is only a card is a message, in single chats and groups, and names the conversation’s latest line', async t => {
  const r = await setup(t);
  const only = (id: string, blocks: unknown[], content = ''): NativeMessage => ({ id, type: 'assistant', catId: r.cat.id, timestamp: 2000, content, extra: { rich: { v: 1, blocks } } });
  r.native.messages.set(r.thread.id, [{ id: 'ask', type: 'user', catId: null, timestamp: 1000, content: '列个清单' }, only('list', [checklist]),
    { ...only('sound', [{ id: 'song', kind: 'audio', v: 1, url: '/a.wav' }]), timestamp: 3000 }, { ...only('user-rich', [card]), type: 'user', catId: null, timestamp: 4000, content: 'x' }]);
  const rows = (await (await r.call('/bots/Ada/transcript')).json()).messages.filter((m: any) => m.id);
  const list = rows.find((m: any) => m.id === 'list');
  assert.equal(list.content, ''); assert.equal(list.blocks[0].kind, 'checklist'); assert.equal('blocks_hidden' in list, false);
  // Something the chat cannot draw yet is still a row that says so, not a vanished message.
  const sound = rows.find((m: any) => m.id === 'sound');
  assert.deepEqual([sound.content, sound.blocks, sound.blocks_hidden], ['', undefined, 1]);
  assert.equal('blocks' in rows.find((m: any) => m.id === 'user-rich'), false, 'only what a cat attached');
  const view = await r.bridge.activity.read(r.thread.id);
  assert.equal(view.unread, 2, 'what is a row in the chat is a reply to be read');
  r.native.messages.set(r.thread.id, r.native.messages.get(r.thread.id)!.slice(0, 3));
  assert.equal((await r.bridge.activity.read(r.thread.id)).last!.text, '发来了暂时无法显示的内容');
  r.native.messages.set(r.thread.id, r.native.messages.get(r.thread.id)!.slice(0, 2));
  assert.deepEqual((await r.bridge.activity.read(r.thread.id)).last, { messageId: 'list', time: new Date(2000).toISOString(), from: 'cat', catId: r.cat.id, catName: 'Ada', text: '今天', files: 0 });

  await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/groups', 'POST', { members: ['Ada', 'Bob'] })).json();
  r.native.messages.set(group.id, [only('g-card', [card], '提议捕捉品味信号：…'), only('g-empty', [])]);
  const page = await (await r.call(`/groups/${group.id}`)).json();
  assert.deepEqual(page.messages.map((m: any) => [m.id, m.blocks?.[0]?.approval?.id ?? null]), [['g-card', 'p1']]);
  // A group page names the cursor of the page before it, like the single-chat transcript.
  assert.deepEqual([page.before, page.hasMore], ['2000:g-card', false]);
  r.native.messages.set(group.id, []);
  assert.equal((await (await r.call(`/groups/${group.id}`)).json()).before, null);
});

test('an answered choice is recorded on the native block, only for a choice in this conversation', async t => {
  const r = await setup(t);
  r.native.messages.set(r.thread.id, [{ id: 'q', type: 'assistant', catId: r.cat.id, timestamp: 1000, content: '选一个', extra: { rich: { v: 1, blocks: [choices, card] } } }]);
  const patches: any[] = [], request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options?: any) => {
    if (path.endsWith('/block-state')) { patches.push({ path, ...options }); return { status: 'ok' }; }
    return request(path, options);
  }) as typeof r.native.request;
  const answer = async (message: string, block: string, selectedIds: string[], expectedThreadId = r.thread.id) =>
    (await r.call(`/bots/Ada/messages/${message}/blocks/${block}/answer`, 'POST', { selectedIds, expectedThreadId }));
  const ok = await answer('q', 'pick', ['fish', 'meat']);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { messageId: 'q', blockId: 'pick', selected: ['fish', 'meat'], answered: true });
  assert.deepEqual(patches, [{ path: '/api/messages/q/block-state', method: 'PATCH', body: { userId: 'clowder-bot-owner', blockId: 'pick', disabled: true, selectedIds: ['fish', 'meat'] } }]);
  assert.equal((await answer('q', 'pick', ['tofu'])).status, 400, 'an option that is not in the block');
  assert.equal((await answer('q', 'taste-proposal-p1', [])).status, 404, 'a card is not a choice');
  assert.equal((await answer('nope', 'pick', ['fish'])).status, 404);
  assert.equal((await answer('q', 'pick', ['fish'], 'thread-old')).status, 409);
  assert.equal(patches.length, 1);
});

test('the engine’s receipt for an answered request reads as a plain line and marks the request card', async t => {
  const r = await setup(t);
  // Trimmed from a real conversation: the request card message, then the hub's receipt after the owner agreed.
  const receipt = (id: string, proposal: string, producerId: string, resolution: string): NativeMessage => ({ id, type: 'connector', catId: null, timestamp: 3000,
    content: `审批结果：品味提案 ${proposal} 已批准。`, source: { connector: 'approval-hub', label: 'Host 审批结果回执',
      meta: { presentation: 'system_notice', approvalDecisionReceipt: { v: 1, kind: 'approval_decision_receipt', producerId, canonicalProposalId: proposal, resolution, approvalCardRef: { threadId: r.thread.id, messageId: 'card' } } } } });
  const request = (id: string, proposal: string): NativeMessage => ({ id, type: 'assistant', catId: r.cat.id, timestamp: 2000, content: '提议捕捉品味信号：…',
    extra: { rich: { v: 1, blocks: [{ ...card, id: 'b-' + proposal, meta: { approval: { producerId: 'F221', canonicalProposalId: proposal } } }] } } });
  r.native.messages.set(r.thread.id, [request('card', 'p1'), request('card2', 'p2'), request('card3', 'p3'), request('card4', 'p4'),
    receipt('r1', 'p1', 'F221', 'accepted'), receipt('r2', 'p2', 'F139', 'rejected'), receipt('r3', 'p3', 'F999', 'expired'),
    { id: 'other', type: 'connector', catId: null, timestamp: 4000, content: '别的连接器消息', source: { connector: 'feishu' } }]);
  const rows = (await (await r.call('/bots/Ada/transcript')).json()).messages.filter((m: any) => m.id);
  const of = (id: string) => rows.find((m: any) => m.id === id);
  assert.deepEqual(['card', 'card2', 'card3', 'card4'].map(id => of(id).blocks[0].approval), [{ id: 'p1', state: 'approved' }, { id: 'p2', state: 'rejected' }, { id: 'p3', state: 'closed' }, { id: 'p4' }]);
  assert.deepEqual(['r1', 'r2', 'r3', 'other'].map(id => [of(id).content, of(id).notice ?? false]),
    [['已记住这个偏好。', true], ['定时没有改动。', true], ['这件事已经结束。', true], ['别的连接器消息', false]]);
  assert.match(of('r1').native.content, /审批结果/, 'the native record keeps the engine’s wording');
  // The same in a group.
  await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/groups', 'POST', { members: ['Ada', 'Bob'] })).json();
  r.native.messages.set(group.id, [request('card', 'p1'), receipt('r1', 'p1', 'F221', 'accepted')]);
  const page = await (await r.call(`/groups/${group.id}`)).json();
  assert.deepEqual(page.messages.map((m: any) => [m.id, m.blocks?.[0]?.approval ?? null, m.notice ? m.text : null]), [['card', { id: 'p1', state: 'approved' }, null], ['r1', null, '已记住这个偏好。']]);
});
