import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import type { NativeMessage } from '../server/native/types.js';

// The owner says something more while a cat is writing; the engine lets the same reply take it in
// (continue_current). The records below have the shapes read off the isolated runtime on 2026-11-12:
// the reply lists both messages as its inputs and comes before the second one in the conversation.
async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-follow-')), native = new NativeFixture();
  const app = createApp({ native, dataFile: join(dir, 'presentation.json') });
  const server = app.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const get = async (path: string) => (await fetch(`http://127.0.0.1:${address.port}${path}`)).json() as Promise<any>;
  t.after(async () => { await app.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  return { ...app, native, get };
}
const said = (id: string, at: number, content: string, taken?: { by: string; cat?: string; appended?: boolean | string }): NativeMessage => ({ id, type: 'user', catId: null, timestamp: at, content,
  lifecycle: { kind: 'input', dispatchRefs: taken ? [{ ...(taken.cat ? { targetId: taken.cat } : {}), phase: 'settled', statusMessageId: taken.by, dispatchedAt: at + 2, inputRead: { status: 'read', at: at + 9 },
    ...(taken.appended ? { appendAcceptance: taken.appended === true ? 'accepted' : taken.appended } : {}) }] : [] } });
const reply = (id: string, at: number, cat: string, content: string, inputs: string[], status = 'completed'): NativeMessage => ({ id, type: 'assistant', catId: cat, timestamp: at, content, origin: 'stream', replyTo: inputs[0],
  lifecycle: { kind: 'response', invocationId: 'run-' + id, inputMessageIds: inputs, startedAt: at, status, ...(status === 'completed' ? { completedAt: at + 13 } : {}) } });

test('a reply that took in what the owner said meanwhile says which message it now follows', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.messages.set(thread.id, [
    said('u1', 100, '讲讲猫为什么喜欢纸箱。', { by: 'a1' }),
    reply('a1', 101, cat.id, '因为安全。\n\n[Ada/haiku🐾]\n\n狗喜欢开阔的地方。', ['u1', 'u2', 'u3']),
    said('u2', 105, '另外，狗喜欢什么？', { by: 'a1', cat: cat.id, appended: true }),
    said('u3', 107, '再加一句鸟。', { by: 'a1', appended: true }),
    said('u4', 200, '谢谢。', { by: 'a2' }),
    reply('a2', 201, cat.id, '不客气。', ['u4']),
  ]);
  const rows = (await r.get('/xbot-api/bots/Ada/transcript')).messages.filter((row: any) => row.role !== 'tool');
  // The records keep the engine's order; the reply names the last message it took in after it had begun.
  assert.deepEqual(rows.map((row: any) => row.id), ['u1', 'a1', 'u2', 'u3', 'u4', 'a2']);
  const seq = (id: string) => rows.find((row: any) => row.id === id).seq;
  assert.deepEqual(rows.map((row: any) => row.follows ?? null), [null, seq('u3'), null, null, null, null]);
  // What it wrote reads as one reply: its own signature in the middle is not shown.
  assert.equal(rows[1].content, '因为安全。\n\n狗喜欢开阔的地方。');

  // While it is still being written the same holds, so the reply can stay under what it is answering.
  r.native.messages.get(thread.id)!.push(said('u5', 300, '长一点。', { by: 'a3' }), reply('a3', 301, cat.id, '好，', ['u5', 'u6'], 'processing'), said('u6', 303, '不，短一点。', { by: 'a3', appended: true }));
  const live = (await r.get('/xbot-api/bots/Ada/transcript')).messages.filter((row: any) => row.role !== 'tool');
  assert.deepEqual([live.at(-2).id, live.at(-2).in_progress, live.at(-2).follows], ['a3', true, live.at(-1).seq]);

  // Inputs that are not on this page, are not the owner's, or are malformed are ignored.
  r.native.messages.set(thread.id, [said('u1', 100, 'x', { by: 'a1' }), reply('a1', 101, cat.id, 'y', ['u1', 'gone', 7 as never, 'a9']), reply('a9', 102, cat.id, 'z', ['u1'])]);
  assert.ok((await r.get('/xbot-api/bots/Ada/transcript')).messages.every((row: any) => !('follows' in row)));

  // The engine lists a message among a reply's inputs before the tool has confirmed taking it in, and keeps it there when that
  // stayed uncertain. The reply is only placed after a message whose own record says that this reply, of this cat, accepted it.
  const unsure = async (later: NativeMessage) => {
    r.native.messages.set(thread.id, [said('u1', 100, 'x', { by: 'a1' }), reply('a1', 101, cat.id, 'y', ['u1', 'u2']), later]);
    return (await r.get('/xbot-api/bots/Ada/transcript')).messages.some((row: any) => 'follows' in row);
  };
  assert.equal(await unsure(said('u2', 105, '还在路上', { by: 'a1', cat: cat.id, appended: 'pending' })), false, 'not confirmed yet');
  assert.equal(await unsure(said('u2', 105, '没接住', { by: 'a1', cat: cat.id, appended: 'rejected' })), false);
  assert.equal(await unsure(said('u2', 105, '没有记录', undefined)), false, 'no receipt at all');
  assert.equal(await unsure(said('u2', 105, '是另一条回复接的', { by: 'a7', cat: cat.id, appended: true })), false);
  assert.equal(await unsure(said('u2', 105, '是另一只猫接的', { by: 'a1', cat: 'someone-else', appended: true })), false);
  assert.equal(await unsure(said('u2', 105, '接住了', { by: 'a1', cat: cat.id, appended: true })), true);

  // A reply that is nothing but its own signature, twice, shows nothing: it is not a row, not unread, not the conversation's last line.
  r.native.messages.set(thread.id, [said('u1', 100, '在吗', { by: 'a1' }), reply('a1', 101, cat.id, '在。', ['u1']), said('u2', 110, '嗯', { by: 'a2' }), reply('a2', 111, cat.id, '[Ada/haiku🐾]\n\n[Ada/haiku🐾]', ['u2'])]);
  assert.deepEqual((await r.get('/xbot-api/bots/Ada/transcript')).messages.filter((row: any) => row.role !== 'tool').map((row: any) => row.id), ['u1', 'a1', 'u2']);
  const activity = (await r.get('/xbot-api/bots/status')).bots[0].activity;
  assert.deepEqual([activity.unread, activity.latestMessageId, activity.last.messageId], [1, 'a1', 'u2']);
  assert.deepEqual((await r.get('/xbot-api/search?q=' + encodeURIComponent('haiku'))).results, []);
});

test('in a group the reply names the message it follows by its id', async t => {
  const r = await setup(t), a = await r.bridge.createBot({ name: 'Ada' }), b = await r.bridge.createBot({ name: 'Bob' });
  const thread = await r.bridge.newThread('两只', [a.id, b.id]); r.store.state.groupThreadIds.push(thread.id);
  r.native.messages.set(thread.id, [
    said('u1', 100, '@Ada @Bob 各说一句。', { by: 'a1' }), reply('a1', 101, a.id, '一。二。', ['u1', 'u2']), reply('b1', 102, b.id, '我也一句。', ['u1', 'u2']),
    // Ada's reply accepted it; Bob's lists it too, but nothing says Bob's reply took it in.
    said('u2', 105, '@Ada 再来一句。', { by: 'a1', cat: a.id, appended: true }),
  ]);
  const rows = (await r.get('/xbot-api/groups/' + thread.id)).messages;
  assert.deepEqual(rows.map((row: any) => [row.id, row.follows ?? null]), [['u1', null], ['a1', 'u2'], ['b1', null], ['u2', null]]);
});
