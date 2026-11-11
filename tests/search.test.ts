import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { NativeFixture } from './native-fixture.js';
import { snippet } from '../server/native/search.js';
import type { NativeMessage } from '../server/native/types.js';

async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-search-')), native = new NativeFixture();
  const app = createApp({ native, dataFile: join(dir, 'presentation.json') });
  const server = app.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/xbot-api${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { await app.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const ada = await app.bridge.createBot({ name: 'Ada' }), bob = await app.bridge.createBot({ name: 'Bob' });
  const said = (id: string, timestamp: number, content: string, catId: string | null = null, more: Partial<NativeMessage> = {}): NativeMessage =>
    ({ id, type: catId ? 'assistant' : 'user', catId, timestamp, content, ...more });
  const search = async (q: string) => (await call('/search?q=' + encodeURIComponent(q))).json();
  return { ...app, native, call, ada, bob, said, search };
}

test('the words around a match come back on one line with where the match sits', () => {
  assert.deepEqual(snippet('猫为什么喜欢纸箱', '纸箱'), { snippet: '猫为什么喜欢纸箱', match: [6, 8] });
  const long = snippet('前'.repeat(40) + '关键 词\n在这里' + '后'.repeat(100), '关键 词 在');
  assert.ok(long);
  assert.equal(long.snippet.slice(...long.match), '关键 词 在');
  assert.ok(long.snippet.startsWith('…前') && long.snippet.endsWith('后…'));
  assert.equal(long.snippet.length, 1 + 24 + 6 + 72 + 1);
  assert.deepEqual(snippet('Read HELLO.txt', 'hello'), { snippet: 'Read HELLO.txt', match: [5, 10] });
  assert.equal(snippet('没有这个词', '纸箱'), null);
});

test('search finds what was said across chats, newest first, the way the chat shows it', async t => {
  const r = await setup(t), direct = await r.bridge.direct(r.ada);
  const earlier = await r.bridge.newThread('Ada', [r.ada.id]);
  r.store.bot(r.ada.id).conversationIds = [direct.id, earlier.id];
  r.store.bot(r.ada.id).greetingSources = { [direct.id]: 'invite' }; r.store.save();
  const group = await (await r.call('/groups', 'POST', { name: '读书会', members: ['Ada', 'Bob'] })).json();
  const extra = { stream: { turnInvocationId: 'turn' } };
  r.native.messages.set(direct.id, [
    r.said('invite', 100, '聊天页的开场邀请：纸箱'),
    r.said('ask', 1000, '猫为什么喜欢纸箱？'),
    r.said('answer', 2000, '因为纸箱让它觉得安全。\n\n[Ada/纸箱模型🐾]', r.ada.id),
    r.said('draft', 2100, '纸箱还没写完', r.ada.id, { isDraft: true }),
    r.said('silent', 2200, 'SILENT', r.ada.id),
    r.said('stream', 2300, '纸箱 过程记录', r.ada.id, { origin: 'stream', extra }),
    r.said('explicit', 2400, '查完了', r.ada.id, { origin: 'callback', extra: { ...extra, isExplicitPost: true } }),
  ]);
  r.native.messages.set(earlier.id, [r.said('old', 500, '上次聊过纸箱的尺寸')]);
  r.native.messages.set(group.id, [r.said('g1', 3000, '大家觉得纸箱怎么样'), r.said('g2', 3100, '纸箱很好', r.bob.id)]);
  const found = await r.search('纸箱');
  assert.deepEqual(found.results.map((hit: any) => [hit.messageId, hit.chat.type, hit.chat.name, hit.current, hit.from, hit.catName ?? null]), [
    ['g2', 'group', '读书会', true, 'cat', 'Bob'], ['g1', 'group', '读书会', true, 'owner', null],
    ['answer', 'bot', 'Ada', true, 'cat', 'Ada'], ['ask', 'bot', 'Ada', true, 'owner', null],
    ['old', 'bot', 'Ada', false, 'owner', null],
  ], 'not the invitation, a draft, a silent turn, an execution record or the signature');
  assert.equal(found.results[2].snippet, '因为纸箱让它觉得安全。');
  assert.deepEqual([found.more, found.searched, found.failed], [false, 3, 0], 'Ada now and earlier, and the group; Bob has no conversation yet');
  assert.equal(found.results[0].chat.id, group.id); assert.equal(found.results[2].chat.id, r.ada.id);
  assert.deepEqual((await r.search('纸箱模型')).results, [], 'a signature is not something that was said');
  assert.deepEqual((await r.search('开场邀请')).results, []);
  // Reads only: nothing is written or indexed.
  assert.equal(r.native.calls.some(c => c.method !== 'GET' && !['/api/cats', '/api/threads', '/api/projects/mkdir'].includes(c.path)), false);
});

test('search says when it did not see everything', async t => {
  const r = await setup(t), direct = await r.bridge.direct(r.ada), other = await r.bridge.direct(r.bob);
  r.native.messages.set(direct.id, Array.from({ length: 40 }, (_, i) => r.said('m' + i, 1000 + i, '第 ' + i + ' 次提到纸箱')));
  const capped = await r.search('纸箱');
  assert.equal(capped.results.length, 30); assert.equal(capped.more, true);
  assert.equal(capped.results[0].messageId, 'm39');
  // A conversation that cannot be read is counted; the rest still answers.
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options?: any) => {
    if (path.startsWith('/api/messages') && path.includes(other.id)) throw new ApiError(503, 'native unavailable');
    return request(path, options);
  }) as typeof r.native.request;
  const partial = await r.search('第 3 次');
  assert.deepEqual([partial.results.length, partial.searched, partial.failed, partial.more], [1, 1, 1, false]);
  for (const q of ['', '   ', 'x'.repeat(101)]) assert.equal((await r.call('/search?q=' + encodeURIComponent(q))).status, 400, JSON.stringify(q));
  assert.equal((await r.call('/search')).status, 400);
});

test('a group keeps its members in the native thread: adding, removing and renaming go there', async t => {
  const r = await setup(t); await r.bridge.createBot({ name: 'Cy' });
  const group = await (await r.call('/groups', 'POST', { members: ['Ada', 'Bob'] })).json();
  const patch = async (body: unknown, id = group.id) => { const res = await r.call('/groups/' + encodeURIComponent(id), 'PATCH', body); return [res.status, await res.json()] as const; };
  const [status, added] = await patch({ members: ['Ada', 'Bob', 'Cy'] });
  assert.equal(status, 200); assert.deepEqual(added.members, ['Ada', 'Bob', 'Cy']); assert.equal(added.name, 'Ada、Bob');
  assert.equal(r.native.threads.get(group.id)!.preferredCats!.length, 3);
  const [, renamed] = await patch({ name: '三只猫', members: ['Bob', 'Cy'] });
  assert.deepEqual([renamed.name, renamed.members], ['三只猫', ['Bob', 'Cy']]);
  assert.equal(r.native.threads.get(group.id)!.title, '三只猫');
  // A cat with work in the group is not quietly dropped: leaving would not stop that work.
  r.native.queues.set(group.id, { queue: [], activeInvocations: [{ catId: r.bob.id, invocationId: 'run' }] });
  const [busy, why] = await patch({ members: ['Ada', 'Cy'] });
  assert.equal(busy, 409); assert.match(why.error, /还在这个群里/);
  assert.deepEqual((await patch({ members: ['Ada', 'Bob', 'Cy'] }))[1].members, ['Ada', 'Bob', 'Cy'], 'keeping the busy cat is fine');
  r.native.queues.set(group.id, { queue: [{ id: 'q', status: 'queued', targetCats: [r.bob.id] }], activeInvocations: [] });
  assert.equal((await patch({ members: ['Ada', 'Cy'] }))[0], 409);
  r.native.queues.delete(group.id);
  assert.equal((await patch({ members: ['Ada', 'Cy'] }))[0], 200);
  for (const body of [{}, { members: ['Ada'] }, { members: ['Ada', 'Ada'] }, { name: '' }, { name: '好', extra: 1 }]) assert.equal((await patch(body))[0], 400, JSON.stringify(body));
  assert.equal((await patch({ members: ['Ada', 'Nobody'] }))[0], 404);
  assert.equal((await patch({ name: '不存在' }, 'thread-unknown'))[0], 404);
  // A sidebar folder has a name only.
  await r.call('/groups', 'POST', { name: '工作' });
  assert.equal((await patch({ members: ['Ada', 'Bob'] }, '工作'))[0], 400);
  assert.deepEqual(await patch({ name: '生活' }, '工作'), [200, { name: '生活' }]);
});
