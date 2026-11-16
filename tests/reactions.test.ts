// Replies and reactions on one message (docs/chat-experience-api.md「回复与表情回应」): what a row quotes, which
// messages are drawn on another row as a reaction, and who a reply in a group is sent to. The engine has no
// reactions of its own on a conversation's messages; here one is an ordinary native message of one emoji that
// answers what someone else said, and the tests hold the reading to that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { PageReading, soleEmoji } from '../server/native/reactions.js';
import { chatManner } from '../server/native/chat-pack.js';
import type { NativeMessage } from '../server/native/types.js';

async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-reactions-')), native = new NativeFixture();
  const runtime = createApp({ dataFile: join(dir, 'presentation.json'), native });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ...runtime, native, call, dir };
}
let at = 1000;
const owner = (id: string, content: string, replyTo?: string): NativeMessage => ({ id, type: 'user', content, catId: null, timestamp: at += 1000, ...(replyTo ? { replyTo } : {}) });
const reply = (id: string, catId: string, content: string, replyTo?: string, more: Partial<NativeMessage> = {}): NativeMessage =>
  ({ id, type: 'assistant', content, catId, timestamp: at += 1000, origin: 'stream', ...(replyTo ? { replyTo } : {}), lifecycle: { kind: 'response', status: 'completed' }, ...more });
const said = (rows: any[]) => rows.filter(row => row.role !== 'tool').map(row => row.id);
const heart = '❤' + String.fromCodePoint(0xfe0f), plainHeart = '❤';
/** A page that draws reactions says so when it reads. */
const drawing = { reactions: true };

test('one emoji and nothing else', () => {
  for (const emoji of ['👍', heart, '🎉', '👀', '🐾', '👍🏽', '🇨🇳', '👨‍👩‍👧', '✅']) assert.equal(soleEmoji(emoji), emoji, emoji);
  assert.equal(soleEmoji('  👍\n'), '👍', 'the space around it is not part of it');
  assert.equal(soleEmoji(plainHeart), heart, 'a symbol typed without its emoji-style mark is the same emoji');
  for (const text of ['', ' ', '好', '👍👍', '👍 好', '好的👍', 'ok', '1', '#', '©', ':)', '+1', 'SILENT', '🐾\n\n[Ada/x🐾]']) assert.equal(soleEmoji(text), undefined, JSON.stringify(text));
});

test("the owner's reaction is drawn on the cat's message, and what the cat says next stands under it", async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const list = [owner('u1', '帮我排一下版'), reply('r1', cat.id, '这样可以吗？', 'u1'), owner('x1', '👍', 'r1'), reply('r2', cat.id, '好，那我接着做。', 'x1')];
  r.native.messages.set(thread.id, list);
  const page = await r.bridge.transcript(cat, undefined, drawing), row = (id: string): any => page.messages.find(m => m.id === id);
  assert.deepEqual(said(page.messages), ['u1', 'r1', 'r2'], 'the reaction is not a line of its own');
  assert.deepEqual(row('r1').reactions, [{ id: 'x1', seq: r.store.sequence(thread.id, 'x1'), reply_to_id: 'r1', emoji: '👍', time: new Date(list[2]!.timestamp).toISOString(), mine: true }]);
  assert.ok(!page.messages.some((m: any) => m.seq === row('r1').reactions[0].seq), "the reaction's number is its own, no row has it");
  assert.equal(row('r2').reply_to, 0, 'right under the message the reaction is on: nothing to quote');
  assert.equal(row('r2').native.replyTo, 'x1', 'the native record still says what it answers');
  assert.equal(row('u1').reactions, undefined);
  // Something else came in between: the answer to the reaction quotes the message the reaction is on.
  r.native.messages.set(thread.id, [list[0]!, list[1]!, owner('u2', '另外问一句'), reply('r3', cat.id, '可以。', 'u2'), { ...list[2]!, timestamp: at += 1000 }, { ...list[3]!, timestamp: at += 1000 }]);
  const later = await r.bridge.transcript(cat, undefined, drawing), find = (id: string): any => later.messages.find(m => m.id === id);
  assert.deepEqual(said(later.messages), ['u1', 'r1', 'u2', 'r3', 'r2']);
  assert.equal(find('r2').reply_to, find('r1').seq);
  assert.equal(find('r1').reactions.length, 1);
});

test("a cat's whole answer of one emoji is drawn on the owner's message; an emoji back to a reaction joins it", async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  // The paw signature the engine's cats close with is not part of what was said.
  r.native.messages.set(thread.id, [owner('u1', '谢谢'), reply('r1', cat.id, '🐾\n\n[Ada/preview🐾]', 'u1')]);
  const page = await r.bridge.transcript(cat, undefined, drawing);
  assert.deepEqual(page.messages.map((m: any) => m.id ?? m.role), ['u1'], 'neither the reply nor its delivery receipt is a row');
  assert.deepEqual((page.messages[0] as any).reactions.map(({ time, seq, ...mark }: any) => mark), [{ id: 'r1', reply_to_id: 'u1', emoji: '🐾', mine: false, name: 'Ada', native_cat_id: cat.id }]);
  // The owner reacts to a cat's message and the cat answers that with one emoji: both are on the message.
  r.native.messages.set(thread.id, [owner('u1', '排好了吗'), reply('r1', cat.id, '排好了。', 'u1'), owner('x1', plainHeart, 'r1'), reply('r2', cat.id, '🐾', 'x1')]);
  const chained = await r.bridge.transcript(cat, undefined, drawing);
  assert.deepEqual(said(chained.messages), ['u1', 'r1']);
  assert.deepEqual((chained.messages.find(m => m.id === 'r1') as any).reactions.map((mark: any) => [mark.id, mark.emoji, mark.mine, mark.reply_to_id]), [['x1', heart, true, 'r1'], ['r2', '🐾', false, 'x1']], 'each says what it answers by the native record: the row, or the reaction before it');
  // Every reaction is kept, in the order it was sent: each is a message that was really sent.
  r.native.messages.set(thread.id, [owner('u1', '排好了吗'), reply('r1', cat.id, '排好了。', 'u1'), owner('x1', '👍', 'r1'), owner('x2', '🎉', 'r1')]);
  assert.deepEqual(((await r.bridge.transcript(cat, undefined, drawing)).messages.find(m => m.id === 'r1') as any).reactions.map((mark: any) => mark.emoji), ['👍', '🎉']);
});

test('what stays an ordinary message', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const shown = async (list: NativeMessage[]) => { r.native.messages.set(thread.id, list); const page = await r.bridge.transcript(cat, undefined, drawing); return { ids: said(page.messages), rows: page.messages as any[] }; };
  const base = [owner('u1', '问'), reply('r1', cat.id, '答', 'u1')];
  // Words with an emoji, two emoji, an emoji that answers nothing, and the owner quoting their own message.
  for (const [text, target] of [['好的👍', 'r1'], ['👍👍', 'r1'], ['👍', undefined], ['👍', 'u1']] as const)
    assert.deepEqual((await shown([...base, owner('x1', text, target)])).ids, ['u1', 'r1', 'x1'], `${text} → ${target}`);
  assert.equal((await shown([...base, owner('x1', '👍', 'u1')])).rows.find(row => row.id === 'x1').reply_to, (await r.bridge.transcript(cat, undefined, drawing)).messages[0]!.seq, 'it is the quoted message it was');
  // A reply still being written, one that failed, one with a card: not reactions, whatever their words.
  assert.deepEqual((await shown([owner('u1', '谢谢'), reply('r1', cat.id, '🐾', 'u1', { lifecycle: { kind: 'response', status: 'processing' } })])).ids, ['u1', 'r1']);
  assert.deepEqual((await shown([owner('u1', '谢谢'), reply('r1', cat.id, '🐾', 'u1', { isDraft: true })])).ids, ['u1', 'r1']);
  assert.deepEqual((await shown([owner('u1', '谢谢'), reply('r1', cat.id, '🐾', 'u1', { lifecycle: { kind: 'response', status: 'canceled' } })])).ids, ['u1', 'r1']);
  assert.deepEqual((await shown([owner('u1', '谢谢'), reply('r1', cat.id, '🐾', 'u1', { extra: { rich: { v: 1, blocks: [{ id: 'c', kind: 'checklist', v: 1, items: [{ id: 'a', text: '一' }] }] } } })])).ids, ['u1', 'r1']);
  // A cat's emoji that answers nothing on the page (the opening line it was invited to say, a message further back).
  assert.deepEqual((await shown([reply('r0', cat.id, '🐾')])).ids, ['r0']);
  assert.deepEqual((await shown([reply('r0', cat.id, '🐾', 'gone')])).ids, ['r0']);
  // The message reacted to is on an earlier page: the reaction is the quoted message it is, there is nothing to draw it on.
  r.native.pageLimit = 2;
  const paged = await shown([...base, owner('u2', '再问'), owner('x1', '👍', 'r1')]);
  assert.deepEqual(paged.ids, ['u2', 'x1']);
  assert.ok(paged.rows.find(row => row.id === 'x1').reply_to > 0);
});

test('a group reads the same way: rows are numbered, quote what they answer, and carry reactions by name', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada' }), bob = await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json() as { id: string };
  r.native.messages.set(group.id, [owner('u1', '谁来看一下'), reply('a1', ada.id, '我来。', 'u1'), reply('b1', bob.id, '我也看看。', 'u1'),
    owner('u2', '那就 Ada 吧', 'a1'), reply('a2', ada.id, '好。', 'u2'), owner('x1', '👍', 'a2'), reply('b2', bob.id, '👀', 'u2'), owner('u3', '还有一件事'), reply('a3', ada.id, '稍等。', 'u1')]);
  const page = await (await r.call(`/xbot-api/groups/${group.id}?reactions=1`)).json() as { messages: any[] }, row = (id: string) => page.messages.find(m => m.id === id);
  assert.deepEqual(page.messages.map(m => m.id), ['u1', 'a1', 'b1', 'u2', 'a2', 'u3', 'a3']);
  assert.ok(page.messages.every(m => Number.isInteger(m.seq) && m.seq > 0), 'every row has a number');
  assert.equal(new Set(page.messages.map(m => m.seq)).size, page.messages.length);
  assert.equal(row('u2').reply_to, row('a1').seq, 'what the owner quotes is always shown');
  assert.deepEqual([row('a1').reply_to, row('b1').reply_to, row('a2').reply_to], [0, 0, 0], 'a reply under the message it answers quotes nothing');
  assert.equal(row('a3').reply_to, row('u1').seq, 'a reply to something further up says which');
  assert.deepEqual(row('a2').reactions.map(({ time, seq, ...mark }: any) => mark), [{ id: 'x1', reply_to_id: 'a2', emoji: '👍', mine: true }]);
  assert.deepEqual(row('u2').reactions.map(({ time, seq, ...mark }: any) => mark), [{ id: 'b2', reply_to_id: 'u2', emoji: '👀', mine: false, name: 'Bob', native_cat_id: bob.id }]);
  assert.ok(row('a2').reactions[0].seq > 0 && !page.messages.some(m => m.seq === row('a2').reactions[0].seq));
  // The numbers are the conversation's own and stay: a second read gives the same ones.
  const again = await (await r.call(`/xbot-api/groups/${group.id}?reactions=1`)).json() as { messages: any[] };
  assert.deepEqual(again.messages.map(m => m.seq), page.messages.map(m => m.seq));
});

test('in a group, an answer to what one cat said goes to that cat unless the engine reads a name in the words', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada' }), bob = await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json() as { id: string };
  r.native.messages.set(group.id, [owner('u1', '谁来'), reply('a1', ada.id, '我来。', 'u1'), reply('b1', bob.id, '我也可以。', 'u1')]);
  const page = await (await r.call(`/xbot-api/groups/${group.id}?reactions=1`)).json() as { messages: any[] }, seq = (id: string) => page.messages.find(m => m.id === id).seq as number;
  const sent = async (body: Record<string, unknown>) => {
    const response = await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', body); assert.equal(response.status, 202, JSON.stringify(body));
    return r.native.calls.findLast(call => call.path === '/api/messages' && call.method === 'POST')!.body;
  };
  let body = await sent({ text: '那你来', reply_to: seq('b1') });
  assert.deepEqual([body.replyTo, body.mentions], ['b1', [bob.id]], 'the cat whose message is answered');
  body = await sent({ text: '👍', reply_to: seq('a1') });
  assert.deepEqual([body.content, body.replyTo, body.mentions], ['👍', 'a1', [ada.id]], 'a reaction is that same send');
  // The engine's explicit mention replaces what it would read from the words, so a name in the words is the engine's to find —
  // in every way it reads one, not only the @ this code could look for.
  for (const text of ['@Ada 你觉得呢', '艾特 Ada 你觉得呢', 'at Ada 你觉得呢', '大家一起想 #ideate']) {
    body = await sent({ text, reply_to: seq('b1') });
    assert.deepEqual([body.replyTo, body.mentions], ['b1', undefined], text);
  }
  // …and an @ that names no cat (an address, a handle) does not turn the reply away from the cat it answers.
  body = await sent({ text: '发到 me@example.com 就行', reply_to: seq('b1') });
  assert.deepEqual(body.mentions, [bob.id]);
  // Every reason the engine has for falling back on history or membership; a policy of the conversation's is read through.
  for (const reason of [{ kind: 'previous_user_mentions' }, { kind: 'preferred_cat' }, { kind: 'default_cat' }, { kind: 'available_participant' }, { kind: 'thread_policy', baseKind: 'recent_replier' }]) {
    r.native.routingReason = reason;
    assert.deepEqual((await sent({ text: '好', reply_to: seq('b1') })).mentions, [bob.id], JSON.stringify(reason));
  }
  // A reason this code does not know, or a duty cat, keeps the engine's own routing.
  for (const reason of [{ kind: 'concierge_preferred' }, { kind: 'something_new' }, { kind: 'thread_policy' }, { kind: 'thread_policy', baseKind: 'current_message_mentions' }]) {
    r.native.routingReason = reason;
    assert.equal((await sent({ text: '好', reply_to: seq('b1') })).mentions, undefined, JSON.stringify(reason));
  }
  r.native.routingReason = { kind: 'recent_replier' };
  // A cat named in the words that cannot run: the engine falls back and says whom it passed over. It was named all the same.
  r.native.routingUnavailable = [ada.id];
  assert.equal((await sent({ text: '@Ada 你觉得呢', reply_to: seq('b1') })).mentions, undefined, 'a name the engine read is not replaced because that cat cannot run');
  assert.deepEqual(r.native.calls.findLast(call => call.path === '/api/routing/preview')!.body.content, '@Ada 你觉得呢');
  // …while the same fallback with no one passed over is a reply to Bob.
  assert.deepEqual((await sent({ text: '你觉得呢', reply_to: seq('b1') })).mentions, [bob.id]);
  r.native.routingUnavailable = [];
  body = await sent({ text: '收到', reply_to: seq('u1') });
  assert.deepEqual([body.replyTo, body.mentions], ['u1', undefined], "the owner's own message names no cat");
  body = await sent({ text: '大家好' });
  assert.deepEqual([body.replyTo, body.mentions], [undefined, undefined]);
  const previews = r.native.calls.filter(call => call.path === '/api/routing/preview');
  assert.ok(previews.length > 0 && previews.every(call => call.body.scope === 'thread' && call.body.threadId === group.id && typeof call.body.content === 'string'));
  // A cat's own chat is as it was: every message goes to that cat, and nothing is asked first.
  const direct = await r.bridge.direct(ada), before = r.native.calls.length;
  await r.bridge.send(direct, { text: '在吗', reply_to: undefined }, ada);
  assert.deepEqual(r.native.calls.at(-1)!.body.mentions, [ada.id]);
  assert.deepEqual(r.native.calls.slice(before).filter(call => call.path === '/api/routing/preview' || call.method === 'GET' && call.path.startsWith('/api/messages')), []);
});

test('a message further back is still answered by its cat; one that is gone, or a cat that has left, is said and nothing is sent', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada' }), bob = await r.bridge.createBot({ name: 'Bob' }), cleo = await r.bridge.createBot({ name: 'Cleo' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json() as { id: string };
  const list = [owner('u1', '谁来'), reply('b1', bob.id, '我可以。', 'u1'), reply('c1', cleo.id, '我已经不在群里了。', 'u1'),
    ...Array.from({ length: 6 }, (_, index) => [owner('f' + index, '闲聊'), reply('g' + index, ada.id, '嗯。', 'f' + index)]).flat()];
  r.native.messages.set(group.id, list);
  await r.call(`/xbot-api/groups/${group.id}?reactions=1`);
  const seq = (id: string) => r.store.sequence(group.id, id), posts = () => r.native.calls.filter(call => call.path === '/api/messages' && call.method === 'POST');
  // The newest page no longer holds Bob's message; the last cat to speak is Ada. The reply still goes to Bob.
  r.native.pageLimits.set(group.id, 4);
  let response = await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', { text: '还是你来吧', reply_to: seq('b1') });
  assert.equal(response.status, 202);
  assert.deepEqual([posts().at(-1)!.body.replyTo, posts().at(-1)!.body.mentions], ['b1', [bob.id]]);
  // Cleo left the group: answering what she said cannot reach her, and it does not quietly go to someone else.
  const count = posts().length;
  response = await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', { text: '你还在吗', reply_to: seq('c1') });
  assert.equal(response.status, 409);
  const refused = await response.json() as { error: string; code: string };
  assert.equal(refused.code, 'reply_cat_left'); assert.match(refused.error, /「Cleo」已经不在这个群里/);
  response = await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', { text: '👍', reply_to: seq('c1') });
  assert.equal(response.status, 409, 'a reaction to her message neither');
  assert.equal(posts().length, count, 'nothing was sent');
  // With a member named in the words it is the engine's routing, and goes out.
  response = await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', { text: '@Ada 她以前这么说过', reply_to: seq('c1') });
  assert.equal(response.status, 202);
  assert.deepEqual([posts().at(-1)!.body.replyTo, posts().at(-1)!.body.mentions], ['c1', undefined]);
  // A quoted message that is no longer in the conversation: native would drop the quote without a word.
  r.native.messages.set(group.id, list.filter(message => message.id !== 'b1'));
  response = await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', { text: '还是你来吧', reply_to: seq('b1') });
  assert.equal(response.status, 400); assert.match((await response.json() as { error: string }).error, /引用的消息不存在/);
  assert.equal(posts().length, count + 1);
});

test('the same request sent again names whom it named the first time', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada' }), bob = await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json() as { id: string };
  r.native.messages.set(group.id, [owner('u1', '谁来'), reply('b1', bob.id, '我可以。', 'u1')]);
  await r.call(`/xbot-api/groups/${group.id}?reactions=1`);
  const key = '7a0f5a56-3f0c-4a51-9d39-0f2a1d3f6b11', body = { text: '那你来', reply_to: r.store.sequence(group.id, 'b1'), idempotencyKey: key };
  const posts = () => r.native.calls.filter(call => call.path === '/api/messages' && call.method === 'POST').map(call => call.body);
  assert.equal((await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', body)).status, 202);
  // The receipt was lost. Before the retry Bob leaves the group and the words would now be read differently.
  r.native.threads.get(group.id)!.preferredCats = [ada.id];
  r.native.routingReason = { kind: 'something_new' };
  const asked = r.native.calls.length;
  assert.equal((await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', body)).status, 202);
  assert.deepEqual(posts().map(sent => [sent.idempotencyKey, sent.replyTo, sent.mentions]), [[key, 'b1', [bob.id]], [key, 'b1', [bob.id]]], 'native replays an admission only when its recipients are the same');
  assert.equal(r.native.calls.slice(asked).filter(call => call.path === '/api/routing/preview').length, 0, 'the first answer is kept, not asked again');
  // Another request is read afresh.
  assert.equal((await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', { ...body, idempotencyKey: 'c2c7b3a6-5d43-4a0e-8f2c-6d1c2b9e4f10' })).status, 202);
  assert.equal(posts().at(-1)!.mentions, undefined);
});

test('a request is one conversation\'s: the same key in another group, twice at once, and after a refusal', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada' }), bob = await r.bridge.createBot({ name: 'Bob' }), cleo = await r.bridge.createBot({ name: 'Cleo' });
  const one = await (await r.call('/xbot-api/groups', 'POST', { name: 'One', members: ['Ada', 'Bob'] })).json() as { id: string };
  const two = await (await r.call('/xbot-api/groups', 'POST', { name: 'Two', members: ['Bob', 'Cleo'] })).json() as { id: string };
  r.native.messages.set(one.id, [owner('u1', '谁来'), reply('b1', bob.id, '我可以。', 'u1')]);
  r.native.messages.set(two.id, [owner('v1', '谁来'), reply('c1', cleo.id, '我可以。', 'v1')]);
  await r.call(`/xbot-api/groups/${one.id}?reactions=1`); await r.call(`/xbot-api/groups/${two.id}?reactions=1`);
  const key = '2f0d6c1e-8a4b-4f7d-9c3e-5b1a7d2e9f40';
  const posts = () => r.native.calls.filter(call => call.path === '/api/messages' && call.method === 'POST').map(call => call.body);
  const previews = () => r.native.calls.filter(call => call.path === '/api/routing/preview').length;
  assert.equal((await r.call(`/xbot-api/groups/${one.id}/messages`, 'POST', { text: '那你来', reply_to: r.store.sequence(one.id, 'b1'), idempotencyKey: key })).status, 202);
  assert.equal((await r.call(`/xbot-api/groups/${two.id}/messages`, 'POST', { text: '那你来', reply_to: r.store.sequence(two.id, 'c1'), idempotencyKey: key })).status, 202);
  assert.deepEqual(posts().map(sent => [sent.threadId, sent.mentions]), [[one.id, [bob.id]], [two.id, [cleo.id]]], 'the key of one group says nothing about the other, though Bob is in both');
  // The same request twice at once: one reading, one answer, whatever changes meanwhile.
  const again = 'b7e3a9d2-1c5f-4e8a-a6b0-3d9f2c7e1a55', asked = previews(), sentBefore = posts().length;
  const body = { text: '好', reply_to: r.store.sequence(one.id, 'b1'), idempotencyKey: again };
  const both = Promise.all([r.call(`/xbot-api/groups/${one.id}/messages`, 'POST', body), r.call(`/xbot-api/groups/${one.id}/messages`, 'POST', body)]);
  r.native.routingReason = { kind: 'something_new' };
  assert.deepEqual((await both).map(response => response.status), [202, 202]);
  r.native.routingReason = { kind: 'recent_replier' };
  const twice = posts().slice(sentBefore);
  assert.equal(twice.length, 2); assert.deepEqual(twice[0]!.mentions, twice[1]!.mentions);
  assert.equal(previews() - asked, 1, 'asked of the engine once');
  // A key reused for an answer to another message is not that request: it is read for itself.
  r.native.messages.get(one.id)!.push(reply('a9', ada.id, '我也行。', 'u1'));
  await r.call(`/xbot-api/groups/${one.id}?reactions=1`);
  assert.equal((await r.call(`/xbot-api/groups/${one.id}/messages`, 'POST', { ...body, reply_to: r.store.sequence(one.id, 'a9') })).status, 202);
  assert.deepEqual([posts().at(-1)!.replyTo, posts().at(-1)!.mentions], ['a9', [ada.id]]);
  // A request that was refused named no one: sent again once it can go, it is read again.
  const retry = 'e4a1c8f3-6b2d-4c9e-b5a7-8f0d1e2c3b66', gone = { text: '你来', reply_to: r.store.sequence(one.id, 'b1'), idempotencyKey: retry };
  r.native.threads.get(one.id)!.preferredCats = [ada.id];
  assert.equal((await r.call(`/xbot-api/groups/${one.id}/messages`, 'POST', gone)).status, 409);
  r.native.threads.get(one.id)!.preferredCats = [ada.id, bob.id];
  assert.equal((await r.call(`/xbot-api/groups/${one.id}/messages`, 'POST', gone)).status, 202);
  assert.deepEqual(posts().at(-1)!.mentions, [bob.id]);
});

test('a page that does not say it draws reactions gets every message as a line', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.messages.set(thread.id, [owner('u1', '谢谢'), reply('r1', cat.id, '🐾', 'u1'), owner('x1', '👍', 'r1'), reply('r2', cat.id, '好。', 'x1')]);
  const old = await (await r.call('/xbot-api/bots/Ada/transcript')).json() as { messages: any[] };
  assert.deepEqual(said(old.messages), ['u1', 'r1', 'x1', 'r2'], "a cat's answer of one emoji is not lost on a page opened before reactions were drawn");
  assert.ok(old.messages.every(m => m.reactions === undefined));
  assert.equal(old.messages.find(m => m.id === 'x1').reply_to, old.messages.find(m => m.id === 'r1').seq, 'and a reaction is the quoted message it is');
  const drawn = await (await r.call('/xbot-api/bots/Ada/transcript?reactions=1')).json() as { messages: any[] };
  assert.deepEqual(said(drawn.messages), ['u1', 'r2']);
  await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json() as { id: string };
  r.native.messages.set(group.id, [owner('u1', '谢谢'), reply('r1', cat.id, '🐾', 'u1')]);
  assert.deepEqual((await (await r.call(`/xbot-api/groups/${group.id}`)).json() as { messages: any[] }).messages.map(m => m.id), ['u1', 'r1']);
  assert.deepEqual((await (await r.call(`/xbot-api/groups/${group.id}?reactions=1`)).json() as { messages: any[] }).messages.map(m => m.id), ['u1']);
});

test('a reply being written is a line until it is done; one that fails stays one', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const read = async (answer: NativeMessage) => { r.native.messages.set(thread.id, [owner('u1', '谢谢'), answer]); return (await r.bridge.transcript(cat, undefined, drawing)).messages as any[]; };
  at = 50_000;
  const writing = reply('r1', cat.id, '', 'u1', { lifecycle: { kind: 'response', status: 'processing' } });
  let rows = await read(writing);
  assert.deepEqual([said(rows), rows.find(row => row.id === 'r1').in_progress], [['u1', 'r1'], true], 'typing');
  rows = await read({ ...writing, content: '🐾', isDraft: true });
  assert.deepEqual([said(rows), rows.find(row => row.id === 'r1').content], [['u1', 'r1'], '🐾'], 'the emoji so far is still a reply being written');
  rows = await read({ ...writing, content: '🐾', lifecycle: { kind: 'response', status: 'completed' } });
  assert.deepEqual([said(rows), rows[0].reactions.map((mark: any) => mark.id)], [['u1'], ['r1']], 'done: it is the reaction');
  assert.equal(rows[0].reactions[0].seq, r.store.sequence(thread.id, 'r1'), 'under the number the line had while it was written');
  for (const status of ['failed', 'interrupted', 'canceled']) {
    rows = await read({ ...writing, content: '🐾', lifecycle: { kind: 'response', status } });
    assert.deepEqual(said(rows), ['u1', 'r1'], status);
  }
});

test('what a reply took in while it was written: a reaction sent meanwhile is not the line it stands under', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  at = 80_000;
  const accepted = (id: string) => ({ kind: 'input', dispatchRefs: [{ targetId: cat.id, statusMessageId: id, appendAcceptance: 'accepted' }] });
  const m0 = reply('m0', cat.id, '早先说过的话。'), u1 = owner('u1', '讲个冷知识'), long = reply('r1', cat.id, '猫尝不出甜味……', 'u1');
  const more = { ...owner('u2', '再讲讲狗'), lifecycle: accepted('r1') }, liked = { ...owner('x1', '👍', 'm0'), lifecycle: accepted('r1') };
  const rows = async (list: NativeMessage[], inputs: string[]) => { r.native.messages.set(thread.id, list.map(message => message.id === 'r1' ? { ...message, lifecycle: { kind: 'response', status: 'completed', inputMessageIds: inputs } } : message)); return (await r.bridge.transcript(cat, undefined, drawing)).messages as any[]; };
  let page = await rows([m0, u1, long, liked], ['u1', 'x1']);
  assert.equal(page.find(row => row.id === 'r1').follows, undefined, 'only a reaction came in: the reply has nothing to move under');
  assert.deepEqual(page.find(row => row.id === 'm0').reactions.map((mark: any) => mark.id), ['x1']);
  page = await rows([m0, u1, long, more, liked], ['u1', 'u2', 'x1']);
  assert.equal(page.find(row => row.id === 'r1').follows, page.find(row => row.id === 'u2').seq, 'words and then a reaction: it stands under the words');
  // A page that draws no reactions has the reaction as a line, and the reply stands under that.
  r.native.messages.set(thread.id, r.native.messages.get(thread.id)!);
  const plain = (await r.bridge.transcript(cat)).messages as any[];
  assert.equal(plain.find(row => row.id === 'r1').follows, plain.find(row => row.id === 'x1').seq);
});

test("a cat's reaction is a reply the owner has to see: it counts as unread until its id is acknowledged, and a search finds it", async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.messages.set(thread.id, [owner('u1', '谢谢'), reply('r1', cat.id, '🐾', 'u1')]);
  const page = await (await r.call('/xbot-api/bots/Ada/transcript?reactions=1')).json() as { messages: any[] };
  const mark = page.messages[0].reactions[0];
  let activity = await (await r.call('/xbot-api/bots/Ada/activity')).json() as any;
  assert.deepEqual([activity.unread, activity.latestMessageId, activity.last.text], [1, 'r1', '🐾']);
  const read = await r.call('/xbot-api/bots/Ada/read', 'POST', { expectedThreadId: thread.id, messageId: mark.id });
  assert.equal(read.status, 200);
  activity = await (await r.call('/xbot-api/bots/Ada/activity')).json() as any;
  assert.equal(activity.unread, 0);
  const found = await (await r.call('/xbot-api/search?q=' + encodeURIComponent('🐾'))).json() as { results: any[] };
  assert.deepEqual(found.results.map(hit => hit.messageId), ['r1'], "the hit names the reaction's message; the page finds it in reactions[].id");
});

test('the reading itself: order, authors and chains', () => {
  const reading = new PageReading({ hasMore: false, reactions: true }), rows: Record<string, any> = {};
  const draw = (message: NativeMessage) => { reading.quote(message); reading.drawn(message, rows[message.id] = {}); };
  const mark = (message: NativeMessage) => ({ id: message.id, seq: 1, reply_to_id: message.replyTo ?? '', emoji: '👍', mine: message.type === 'user', time: '' });
  const m = reply('m', 'ada', '好了'), other = reply('o', 'bob', '同意', 'm');
  draw(m); draw(other);
  const mine = owner('x', '👍', 'm'), own = reply('y', 'ada', '👍', 'm'), cats = reply('z', 'bob', '👍', 'm'), back = reply('w', 'ada', '👍', 'x'), nowhere = owner('v', '👍', 'missing');
  assert.equal(reading.react(own, mark(own)), false, "a cat's emoji under its own message is a message");
  assert.equal(reading.react(nowhere, mark(nowhere)), false);
  assert.equal(reading.react(mine, mark(mine)), true);
  assert.equal(reading.react(cats, mark(cats)), true, 'one cat can react to what another said');
  assert.equal(reading.react(back, mark(back)), true, 'an emoji back to a reaction joins it, even on its own message');
  assert.deepEqual(rows.m.reactions.map((reaction: any) => reaction.id), ['x', 'z', 'w']);
  assert.equal(rows.o.reactions, undefined);
});

test('every cat is told when one emoji is the whole answer', () => {
  assert.ok(chatManner.includes('只回一个表情就够了'));
  assert.ok(chatManner.length <= 500, "the engine's bound for a default behaviour");
});
