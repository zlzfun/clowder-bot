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
const said = (id: string, at: number, content: string, taken?: { by: string; appended?: boolean }): NativeMessage => ({ id, type: 'user', catId: null, timestamp: at, content,
  lifecycle: { kind: 'input', dispatchRefs: taken ? [{ targetId: 'cat', phase: 'settled', statusMessageId: taken.by, dispatchedAt: at + 2, inputRead: { status: 'read', at: at + 9 }, ...(taken.appended ? { appendAcceptance: 'accepted' } : {}) }] : [] } });
const reply = (id: string, at: number, cat: string, content: string, inputs: string[], status = 'completed'): NativeMessage => ({ id, type: 'assistant', catId: cat, timestamp: at, content, origin: 'stream', replyTo: inputs[0],
  lifecycle: { kind: 'response', invocationId: 'run-' + id, inputMessageIds: inputs, startedAt: at, status, ...(status === 'completed' ? { completedAt: at + 13 } : {}) } });

test('a reply that took in what the owner said meanwhile says which message it now follows', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.messages.set(thread.id, [
    said('u1', 100, '讲讲猫为什么喜欢纸箱。', { by: 'a1' }),
    reply('a1', 101, cat.id, '因为安全。\n\n[Ada/haiku🐾]\n\n狗喜欢开阔的地方。', ['u1', 'u2', 'u3']),
    said('u2', 105, '另外，狗喜欢什么？', { by: 'a1', appended: true }),
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
});

test('in a group the reply names the message it follows by its id', async t => {
  const r = await setup(t), a = await r.bridge.createBot({ name: 'Ada' }), b = await r.bridge.createBot({ name: 'Bob' });
  const thread = await r.bridge.newThread('两只', [a.id, b.id]); r.store.state.groupThreadIds.push(thread.id);
  r.native.messages.set(thread.id, [
    said('u1', 100, '@Ada @Bob 各说一句。', { by: 'a1' }), reply('a1', 101, a.id, '一。二。', ['u1', 'u2']), reply('b1', 102, b.id, '我也一句。', ['u1']),
    said('u2', 105, '@Ada 再来一句。', { by: 'a1', appended: true }),
  ]);
  const rows = (await r.get('/xbot-api/groups/' + thread.id)).messages;
  assert.deepEqual(rows.map((row: any) => [row.id, row.follows ?? null]), [['u1', null], ['a1', 'u2'], ['b1', null], ['u2', null]]);
});
