import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { ProductStore } from '../server/product-store.js';
import { NativeFixture } from './native-fixture.js';
import { NativeClient } from '../server/native/client.js';
import { messageDisplayText } from '../server/native/message-presentation.js';
import type { NativeMessage } from '../server/native/types.js';

async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-bridge-')), native = new NativeFixture();
  const runtime = createApp({ dataFile: join(dir, 'presentation.json'), native });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const call = (path: string, method = 'GET', body?: unknown, headers = {}) => fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ...runtime, native, base, call, dir };
}
test('deleting a cat names the revision it read; the engine refuses a delete that names none', async t => {
  const r = await setup(t);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: 'Ada', runtimeId: 'codex' })).status, 201);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: 'Bea', runtimeId: 'codex' })).status, 201);
  const [ada, bea] = r.native.cats;
  assert.equal((await r.call('/xbot-api/bots/Ada', 'DELETE')).status, 200);
  assert.deepEqual(r.native.calls.findLast(c => c.path === `/api/cats/${ada!.id}` && c.method === 'DELETE')?.body, { expectedRevision: 'r1' });
  assert.deepEqual(r.native.cats.map(cat => cat.id), [bea!.id]);
  // The engine refuses a delete that names no revision, so the request cannot have been sent without one.
  await assert.rejects(r.native.request(`/api/cats/${bea!.id}`, { method: 'DELETE' }), (error: any) => error.status === 428);
  assert.deepEqual(r.native.cats.map(cat => cat.id), [bea!.id]);
});
test('sends admit into native Queue; UI storage contains only references; no local fallback', async t => {
  const r = await setup(t);
  const created = await r.call('/xbot-api/bots', 'POST', { name: 'Ada', runtimeId: 'codex' }); assert.equal(created.status, 201);
  const cat = r.native.cats[0]!;
  const [a, b] = await Promise.all([r.bridge.direct(cat), r.bridge.direct(cat)]); assert.equal(a.id, b.id);
  const key = 'e2d15af2-30af-4a25-88aa-bc7cf6214872';
  const sent = await r.call('/xbot-api/bots/Ada/messages', 'POST', { text: 'work', idempotencyKey: key });
  const sse = await sent.text(); assert.match(sse, /event: queued/); assert.match(sse, /message-1/);
  const nativeSend = r.native.calls.findLast(c => c.path === '/api/messages');
  assert.deepEqual(nativeSend?.body, { threadId: a.id, content: 'work', idempotencyKey: key, messageDisposition: 'continue_current', mentions: [cat.id] });
  const saved = JSON.parse(readFileSync(join(r.dir, 'presentation.json'), 'utf8'));
  for (const field of ['messages', 'memories', 'sessions', 'settings', 'queue', 'runs']) assert.equal(saved[field], undefined);
  assert.equal(saved.bots[cat.id].activeThreadId, a.id);
  assert.equal(saved.bots[cat.id].roleDescription, undefined);
  r.native.fail = new ApiError(503, 'native unavailable');
  assert.equal((await r.call('/xbot-api/bots/Ada/messages', 'POST', { text: 'work' })).status, 503);
  assert.equal((await r.call('/api/health')).status, 503);
});
test('ordinary followups use one non-interrupting native admission even while background work is active', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.queues.set(thread.id, { queue: [], activeInvocations: [{ catId: cat.id, invocationId: 'parent-with-children' }] });
  const start = r.native.calls.length;
  for (const text of ['现在进度如何？', '同时调研另一项任务', '把第一项的方向改成权限机制']) {
    const response = await r.call('/xbot-api/bots/Ada/messages', 'POST', { text });
    assert.equal(response.status, 200);
    await response.text();
  }
  const calls = r.native.calls.slice(start);
  const sends = calls.filter(c => c.path === '/api/messages');
  assert.equal(sends.length, 3);
  for (const send of sends) {
    assert.equal(send.body.threadId, thread.id);
    assert.equal(send.body.messageDisposition, 'continue_current');
    assert.deepEqual(send.body.mentions, [cat.id]);
    assert.equal(send.body.force, undefined);
  }
  assert.equal(calls.some(c => /\/cancel\/|\/steer|\/queue/.test(c.path)), false,
    'the bridge must not race a busy snapshot, cancel work, or admit then steer a second time');
});
test('an opening is one targeted native turn; only its confirmed invitation is omitted from chat', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: '推特采集' });
  const route = '/xbot-api/bots/' + encodeURIComponent(cat.name);
  const page = await (await r.call(route + '/transcript')).json();
  assert.deepEqual(page.messages, []);
  const sends = () => r.native.calls.filter(c => c.path === '/api/messages' && c.method === 'POST');
  assert.equal(sends().length, 0);
  const invite = () => r.call(route + '/greeting', 'POST', { expectedThreadId: page.thread_id });
  const [one, two] = await Promise.all([invite(), invite()]);
  assert.deepEqual(await one.json(), {status:'accepted'});
  assert.deepEqual(await two.json(), {status:'accepted'});
  assert.equal(sends().length, 1);
  const input = sends()[0]!.body;
  assert.deepEqual(input.mentions, [cat.id]);
  assert.equal(input.messageDisposition, 'next_work');
  const source = {id:'message-1', type:'user' as const, catId:null, content:input.content, timestamp:1};
  const owner = {...source, id:'human-copy', timestamp:2};
  const reply = {id:'cat-reply', type:'assistant' as const, catId:cat.id, content:'想先看看哪个话题？', replyTo:source.id, timestamp:3};
  r.native.messages.set(page.thread_id, [source, owner, reply]);
  const after = await (await r.call(route + '/transcript')).json();
  assert.deepEqual(after.greeting, {status:'accepted',sourceMessageId:source.id});
  assert.ok(!after.messages.some((m:any) => m.id === source.id));
  assert.equal(after.messages.find((m:any) => m.id === owner.id).content, owner.content);
  assert.equal(after.messages.find((m:any) => m.id === reply.id).reply_to, 0);
  assert.equal(after.messages.find((m:any) => m.id === reply.id).native.replyTo, source.id);
  const restored = new ProductStore(join(r.dir, 'presentation.json'));
  assert.deepEqual(restored.bot(cat.id).greetingSources, {[page.thread_id]:source.id});
  assert.deepEqual(await (await invite()).json(), {status:'accepted'});
  assert.equal(sends().length, 1);
});
test('a message the engine refuses because a cat it names cannot run was not sent: the chat says so by code, and an opening is not left unconfirmed', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({name:'阿橘'}), thread = await r.bridge.direct(cat);
  const request = r.native.request.bind(r.native);
  let refusing = true;
  r.native.request = async (path, opts) => {
    // routes/messages.ts refuses before admission; nothing is stored.
    if (refusing && path === '/api/messages' && opts?.method === 'POST')
      throw new ApiError(409, '指定角色当前不可用，且没有有效接替成员，请选择可用角色后再发送。', { code: 'ROUTING_TARGET_UNAVAILABLE', error: '指定角色当前不可用，且没有有效接替成员，请选择可用角色后再发送。' });
    return request(path, opts);
  };
  const sent = await r.call('/xbot-api/bots/阿橘/messages', 'POST', { text: '在吗', idempotencyKey: 'c1b0f3a2-6f0e-4f43-9d0c-3a1f4d6f2b11' });
  assert.equal(sent.status, 409);
  const said = await sent.json() as any;
  assert.equal(said.code, 'target_unavailable'); assert.equal(said.error, '这只猫猫现在用不了，消息没有发出');
  await assert.rejects(r.bridge.greet(cat, thread.id), (error: any) => error.status === 409);
  assert.equal((await r.bridge.transcript(cat)).greeting, undefined, 'a refusal before admission leaves nothing to recover');
  refusing = false;
  assert.deepEqual(await r.bridge.greet(cat, thread.id), {status:'accepted'});
  // Another 409 is not this refusal and is passed on as the engine gave it.
  r.native.request = async (path, opts) => { if (path === '/api/messages' && opts?.method === 'POST') throw new ApiError(409, '别的冲突', { code: 'SOMETHING_ELSE' }); return request(path, opts); };
  const other = await r.call('/xbot-api/bots/阿橘/messages', 'POST', { text: '在吗', idempotencyKey: 'c1b0f3a2-6f0e-4f43-9d0c-3a1f4d6f2b12' });
  assert.equal(other.status, 409); assert.equal((await other.json() as any).code, undefined);
});
test('greeting recovery uses the same native key and refuses other threads and pre-existing history', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({name:'兰舟'}), thread = await r.bridge.direct(cat);
  const page = [{id:'existing',type:'user' as const,catId:null,content:'你好',timestamp:1}];
  r.native.messages.set(thread.id,page);
  await assert.rejects(r.bridge.greet(cat,'different-thread'), /切换/);
  assert.deepEqual(await r.bridge.greet(cat,thread.id), {status:'exists'});
  assert.ok(!r.native.calls.some(c => c.path === '/api/messages' && c.method === 'POST'));
  r.native.messages.set(thread.id,[]);
  r.native.queues.set(thread.id,{queue:[{id:'pending-first-turn',status:'queued'}],activeInvocations:[]});
  assert.deepEqual(await r.bridge.greet(cat,thread.id), {status:'exists'});
  assert.ok(!r.native.calls.some(c => c.path === '/api/messages' && c.method === 'POST'));
  r.native.queues.delete(thread.id);
  const request = r.native.request.bind(r.native);
  const keys:string[] = [];
  r.native.request = async (path, opts) => {
    if (path === '/api/messages' && opts?.method === 'POST') {
      keys.push((opts.body as any).idempotencyKey);
      if (keys.length === 1) throw new ApiError(429,'消息队列已满');
      if (keys.length === 2) throw new ApiError(503,'连接中断');
    }
    return request(path,opts);
  };
  await assert.rejects(r.bridge.greet(cat,thread.id), /队列已满/);
  assert.equal((await r.bridge.transcript(cat)).greeting, undefined);
  await assert.rejects(r.bridge.greet(cat,thread.id), /连接中断/);
  assert.deepEqual((await r.bridge.transcript(cat)).greeting, {status:'unconfirmed'});
  assert.deepEqual(new ProductStore(join(r.dir,'presentation.json')).bot(cat.id).greetingSources?.[thread.id], {invitationVersion:2});
  const restarted = createApp({native:r.native,dataFile:join(r.dir,'presentation.json')});
  assert.deepEqual(await restarted.bridge.greet(cat,thread.id), {status:'accepted'});
  assert.equal(keys.length,3); assert.equal(new Set(keys).size,1);
  await restarted.close();
});
test('an unconfirmed invitation from before the wording change replays its original bytes', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({name:'兰舟'}), thread = await r.bridge.direct(cat);
  r.store.bot(cat.id).greetingSources = {[thread.id]:null};
  r.store.save();
  const restarted = createApp({native:r.native,dataFile:join(r.dir,'presentation.json')});
  assert.deepEqual((await restarted.bridge.transcript(cat)).greeting, {status:'unconfirmed'});
  await restarted.bridge.greet(cat,thread.id);
  const sent = r.native.calls.find(c => c.path === '/api/messages' && c.method === 'POST');
  assert.equal(createHash('sha256').update(sent!.body.content).digest('hex'),
    '31c1143d89ac25ef65eb2ad804a3b2956157e6d835a7adc1e9b9f813d9de6100');
  assert.deepEqual((await restarted.bridge.transcript(cat)).greeting, {status:'accepted',sourceMessageId:'message-1'});
  await restarted.close();
});
test('stable message references survive edits, cancellation, pagination and bridge restart', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const user = { id: 'native-u', type: 'user' as const, content: 'ask', catId: null, timestamp: 1000 };
  const reply = { id: 'native-r', type: 'assistant' as const, content: 'draft', catId: cat.id, timestamp: 2000, replyTo: user.id, lifecycle: { kind: 'response', status: 'processing' } };
  // A later question came in between, so the reply shows which one it answers (tests/live.test.ts covers when it does not).
  r.native.messages.set(thread.id, [user, { ...user, id: 'native-u2', content: 'and this', timestamp: 1500 }, reply]);
  const page = await r.bridge.transcript(cat), replyRow = page.messages.find(m => m.id === reply.id)!;
  const seq = replyRow.seq; assert.equal(replyRow.reply_to, page.messages[0]!.seq);
  r.native.messages.set(thread.id, [{ ...reply, content: 'final', lifecycle: { kind: 'response', status: 'canceled' } }]);
  assert.equal((await r.bridge.transcript(cat)).messages[0]!.seq, seq);
  const reopened = new ProductStore(join(r.dir, 'presentation.json'));
  assert.equal(reopened.messageId(thread.id, seq as number), reply.id);
  await r.bridge.send(thread, { text: 'followup', reply_to: seq as number }, cat);
  assert.equal(r.native.calls.at(-1)?.body.replyTo, reply.id);
});
test('re-reading a conversation with nothing new does not rewrite the presentation file', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.messages.set(thread.id, [{ id: 'u1', type: 'user', content: 'ask', catId: null, timestamp: 1000 }]);
  const first = await r.bridge.transcript(cat);
  let saves = 0; const save = r.store.save.bind(r.store);
  r.store.save = () => { saves++; save(); };
  for (let i = 0; i < 3; i++) assert.deepEqual((await r.bridge.transcript(cat)).messages.map(m => m.seq), first.messages.map(m => m.seq));
  assert.equal(saves, 0, 'the chat polls every few seconds');
  r.native.messages.get(thread.id)!.push({ id: 'a1', type: 'assistant', content: 'answer', catId: cat.id, timestamp: 2000 });
  const next = await r.bridge.transcript(cat);
  assert.equal(saves, 1, 'a new message gets its reference saved once');
  assert.equal(new ProductStore(join(r.dir, 'presentation.json')).messageId(thread.id, next.messages.find(m => m.id === 'a1')!.seq as number), 'a1');
});
test('member settings use native catalog; group routing stays native; old memory scopes fail explicitly', async t => {
  const r = await setup(t);
  await r.bridge.createBot({ name: 'Ada' }); await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json();
  const response = await r.call(`/xbot-api/groups/${group.id}/messages`, 'POST', { text: '@Bob review' }); assert.equal(response.status, 202);
  const send = r.native.calls.findLast(c => c.path === '/api/messages'); assert.equal(send?.body.mentions, undefined);
  assert.deepEqual(r.native.threads.get(group.id)?.preferredCats, r.native.cats.map(c => c.id));
  assert.equal((await r.call('/xbot-api/bots/Ada/memory', 'POST', { text: 'fact', scope: 'bot' })).status, 400);
  assert.equal((await r.call('/xbot-api/bots/Ada/memory', 'POST', { text: 'fact', scope: 'conversation' })).status, 201);
  const edit = await r.call('/xbot-api/bots/Ada', 'PATCH', { persona: 'Review code' }); assert.equal(edit.status, 200);
  const patch = r.native.calls.findLast(c => c.path.startsWith('/api/cats/') && c.method === 'PATCH'); assert.equal(patch?.body.roleDescription, 'Review code');
});
test('chat projection separates aggregate activity, preserves chronology and attributes each cat', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada', templateId: 'ragdoll' });
  const bob = await r.bridge.createBot({ name: 'Bob', templateId: 'maine-coon' });
  const thread = await r.bridge.direct(ada);
  const rows = [
    { id: 'ask-a', type: 'user' as const, catId: null, content: 'Start A', timestamp: 1000 },
    { id: 'aggregate', type: 'assistant' as const, catId: ada.id, origin: 'stream', content: 'Start A. Later start B. B done.', timestamp: 1100,
      lifecycle: { kind: 'response', invocationId: 'run-a', status: 'completed' } },
    { id: 'ask-b', type: 'user' as const, catId: null, content: 'Start B', timestamp: 2000 },
    { id: 'b-done', type: 'assistant' as const, catId: ada.id, origin: 'callback', content: 'B done', timestamp: 3000,
      extra: { isExplicitPost: true, turnExecution: { invocationId: 'run-a' } } },
    { id: 'bob', type: 'assistant' as const, catId: bob.id, content: 'Bob reviewed', timestamp: 4000 },
    { id: 'removed', type: 'assistant' as const, catId: 'removed-cat', content: 'Older member', timestamp: 5000 },
  ];
  r.native.messages.set(thread.id, rows);
  const page = await r.bridge.transcript(ada);
  const visible = page.messages.filter(m => m.role !== 'tool');
  assert.deepEqual(visible.map(m => m.id), rows.map(m => m.id));
  const activity = visible.find(m => m.id === 'aggregate')!;
  assert.equal(activity.presentation_kind, 'activity'); assert.equal(activity.tool_calls, undefined);
  assert.equal(activity.content, rows[1]!.content); assert.equal(activity.time, new Date(1100).toISOString());
  assert.equal(visible.find(m => m.id === 'b-done')!.presentation_receipt, true);
  assert.equal(visible.find(m => m.id === 'bob')!.name, 'Bob');
  assert.equal((visible.find(m => m.id === 'bob')!.speaker as any).templateId, 'maine-coon');
  assert.equal(visible.find(m => m.id === 'removed')!.speaker, null);
  assert.equal(visible.find(m => m.id === 'removed')!.name, 'removed-cat');
  assert.deepEqual(r.native.messages.get(thread.id), rows, 'view changes must not rewrite stored transcript');
});
test('group messages expose the same activity and true speaker contract', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada' }), bob = await r.bridge.createBot({ name: 'Bob', templateId: 'maine-coon' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json();
  r.native.messages.set(group.id, [
    { id: 'stream', type: 'assistant', catId: bob.id, timestamp: 1000, origin: 'stream', content: 'Working', lifecycle: { kind: 'response', invocationId: 'bob-run', status: 'processing' } },
    { id: 'reply', type: 'assistant', catId: bob.id, timestamp: 2000, origin: 'callback', content: 'Ready', extra: { isExplicitPost: true, turnExecution: { invocationId: 'bob-run' } } },
    { id: 'ada', type: 'assistant', catId: ada.id, timestamp: 3000, content: 'Acknowledged' },
  ]);
  const page = await (await r.call(`/xbot-api/groups/${group.id}`)).json();
  assert.equal(page.messages[0].presentation_kind, 'activity');
  assert.equal(page.messages[1].presentation_kind, 'message');
  assert.equal(page.messages[1].speaker.id, bob.id); assert.equal(page.messages[1].sender, 'Bob');
  assert.equal(page.messages[2].speaker.id, ada.id);
});
test('chat replies omit native signature tails in direct and group views while keeping the source and user text', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: '界面验收' }), thread = await r.bridge.direct(cat);
  const body = '已完成🐈。', signature = '\n\n[界面验收/gpt-6-astra🐾]', content = body + signature;
  const reply: NativeMessage = {
    id: 'signed-reply', type: 'assistant', catId: cat.id, timestamp: 2000, content, origin: 'stream',
    lifecycle: { kind: 'response', status: 'completed', invocationId: 'turn-1' },
    extra: { outputLayout: {
      v: 1, status: 'available', owner: { threadId: thread.id, catId: cat.id, turnInvocationId: 'turn-1' },
      contentRevision: { length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
      hostTail: { kind: 'cat_signature', producer: 'codex_stream_finalizer', basis: 'runtime_canonical', start: body.length, end: content.length, gluePrefixLength: 2 },
    } },
  };
  const user: NativeMessage = { id: 'user-quote', type: 'user', catId: null, timestamp: 1000, content };
  r.native.messages.set(thread.id, [user, reply]);
  const page = await (await r.call('/xbot-api/bots/' + encodeURIComponent(cat.name) + '/transcript')).json();
  const shown = page.messages.find((m: any) => m.id === reply.id);
  assert.equal(shown.content, body);
  assert.equal(JSON.parse(shown.tool_calls[0].function.arguments).text, body);
  assert.equal(shown.native.content, content);
  assert.equal(page.messages.find((m: any) => m.id === user.id).content, content);
  // Available ranges are bound to the exact message, owner and UTF-16 revision.
  assert.equal(messageDisplayText(reply, 'another-thread'), content);
  assert.equal(messageDisplayText({ ...reply, content: 'changed' + content }, thread.id), 'changed' + content);
  assert.equal(messageDisplayText({ ...reply, catId: 'another-cat' }, thread.id), content);
  assert.equal(messageDisplayText({ ...reply, lifecycle: { kind: 'response', invocationId: 'another-turn' } }, thread.id), content);
  const peer = await r.bridge.createBot({ name: '同伴' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: '签名测试', members: [cat.name, peer.name] })).json();
  const groupReply = { ...reply, extra: undefined }; // old records and callbacks have no host range
  r.native.messages.set(group.id, [user, groupReply,
    { ...groupReply, id: 'signature-only', content: signature.trim() },
    { ...groupReply, id: 'signed-silence', content: 'SILENT' + signature },
  ]);
  const groupPage = await (await r.call(`/xbot-api/groups/${group.id}`)).json();
  assert.equal(groupPage.messages.length, 2, 'a signature alone must not leave an empty bubble');
  assert.equal(groupPage.messages[0].text, content);
  assert.equal(groupPage.messages[1].text, body);
  assert.equal(groupPage.messages[1].native.content, content);
  assert.equal(r.native.messages.get(thread.id)![1]!.content, content);
});
test('legacy signature presentation keeps quoted examples and fenced code, and handles newer draft reads', () => {
  const sign = '[界面验收/gpt-6-astra🐾]';
  const cases = [
    ['答复\n\n' + sign, '答复'],
    ['答复\r\n\r\n' + sign + '\r\n', '答复'],
    ['答复\n[另一只猫🐾]', '答复'],
    ['答复\n' + sign + '\n[另一只猫🐾]', '答复'],
    ['答复\n[界面验收/gpt-', '答复\n[界面验收/gpt-'],
    ['正文里引用 ' + sign, '正文里引用 ' + sign],
    [sign + '\n这是一段示例', sign + '\n这是一段示例'],
    ['> ' + sign, '> ' + sign],
    ['    ' + sign, '    ' + sign],
    ['`' + sign + '`', '`' + sign + '`'],
    ['```text\n' + sign, '```text\n' + sign],
    ['~~~text\n' + sign, '~~~text\n' + sign],
    ['````text\n```\n' + sign, '````text\n```\n' + sign],
    ['```text\n' + sign + '\n```\n\n' + sign, '```text\n' + sign + '\n```'],
    ['答复\n[文档/说明]', '答复\n[文档/说明]'],
  ];
  for (const [content, expected] of cases) {
    const message: NativeMessage = { id: 'old', type: 'assistant', catId: 'cat', timestamp: 1, content: content! };
    assert.equal(messageDisplayText(message, 'thread'), expected, content);
    assert.equal(messageDisplayText({ ...message, isDraft: true }, 'thread'), expected, content);
    assert.equal(messageDisplayText({ ...message, type: 'user' }, 'thread'), content);
  }
});
test('a reply that went on after the cat had signed shows no signature in the middle', () => {
  const sign = '[快手/haiku🐾]';
  const shown = (content: string) => messageDisplayText({ id: 'm', type: 'assistant', catId: 'cat', timestamp: 1, content }, 'thread', '快手');
  // As recorded on the real engine: the owner said more while the cat was writing, and the same reply continued after its signature.
  assert.equal(shown('第一段。\n\n第二段。\n\n' + sign + '\n\n狗喜欢的就不一样了。🐶'), '第一段。\n\n第二段。\n\n狗喜欢的就不一样了。🐶');
  assert.equal(shown('一。\n\n' + sign + '\n\n二。\n\n' + sign + '\n\n三。\n\n' + sign), '一。\n\n二。\n\n三。', 'each time it went on, and the closing one');
  assert.equal(shown('一。\r\n\r\n' + sign + '  \r\n\r\n二。'), '一。\n\n二。', 'line endings and trailing spaces of the record');
  assert.equal(shown(sign + '\n\n' + sign + '\n\n一。'), '一。');
  // Only a paragraph of its own at the left margin that is this cat's signature. Everything else is text and stays, character for character:
  for (const kept of [
    '一。\n\n[墨点/codex🐾]\n\n二。',                                   // another cat's
    '我的署名是 ' + sign + ' 这样。\n\n完。',                              // inside a sentence
    '一。\n\n> ' + sign + '\n\n二。', '一。\n\n    ' + sign + '\n\n二。',   // quoted; indented as code
    '一。\n' + sign + '\n二。',                                           // directly between other lines
    '- 项目\n\n  ' + sign + '\n\n- 下一项',                              // the content of a list item
    '- ' + sign + '\n- 二', '| ' + sign + ' |\n| --- |',                  // a list item, a table cell
    '一。\n\n' + sign + '\n===\n\n正文',                                 // a heading
    '看：\n\n```text\n' + sign + '\n```\n\n完。', '看：\n\n~~~\n\n' + sign + '\n\n~~~\n\n完。',   // inside a fence
    '看：\n\n```text\n    ```\n\n' + sign + '\n\n```\n\n完。',            // an indented marker does not close the fence
    '看：\n\n````md\n```\n\n' + sign + '\n\n```\n````\n\n完。',           // a shorter marker does not close a longer fence
    '看：\n\n```\n\n' + sign + '\n\n没有关上的代码块',                    // a fence that never closes
  ]) assert.equal(shown(kept), kept, kept);
  // A cat whose name has characters that mean something in a pattern is matched as written; a longer name is another cat.
  const odd = (content: string, name: string) => messageDisplayText({ id: 'm', type: 'assistant', catId: 'cat', timestamp: 1, content }, 'thread', name);
  assert.equal(odd('一。\n\n[a.b(c)/x🐾]\n\n二。', 'a.b(c)'), '一。\n\n二。');
  assert.equal(odd('一。\n\n[a.b(c)/x🐾]\n\n二。', 'aXb(c)'), '一。\n\n[a.b(c)/x🐾]\n\n二。');
  assert.equal(odd('一。\n\n[团子二/x🐾]\n\n二。', '团子'), '一。\n\n[团子二/x🐾]\n\n二。');
  // Without knowing who is speaking nothing in the middle is touched.
  assert.equal(messageDisplayText({ id: 'm', type: 'assistant', catId: 'cat', timestamp: 1, content: '一。\n\n' + sign + '\n\n二。' }, 'thread'), '一。\n\n' + sign + '\n\n二。');
});
test('cancel a member never cancels an active sibling; native queue status is exposed', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.queues.set(thread.id, { queue: [], activeInvocations: [{ catId: cat.id, invocationId: 'run-a' }, { catId: 'sibling', invocationId: 'run-b' }] });
  await r.bridge.stop(thread.id, cat.id);
  const canceled = r.native.calls.filter(c => c.path.includes('/cancel/'));
  assert.deepEqual(canceled.map(c => c.path), [`/api/threads/${thread.id}/cancel/${cat.id}`]);
  const statuses = await r.bridge.statuses(); assert.equal(statuses.bots[0]?.state, 'running');
});
test('full export walks native history; malformed cursors cannot silently truncate it', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const nativeRequest = r.native.request.bind(r.native);
  r.native.request = async (path, options) => {
    if (path.startsWith('/api/messages?')) {
      const older = new URL(path, 'http://fixture').searchParams.has('before');
      return { messages: [{ id: older ? 'old' : 'new', type: 'user', content: older ? 'earlier' : 'latest', catId: null, timestamp: older ? 1000 : 2000 }], hasMore: !older } as any;
    }
    return nativeRequest(path, options);
  };
  const response = await r.call('/xbot-api/bots/Ada/export?format=jsonl');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.text()).split('\n').map(line => JSON.parse(line).id), ['old', 'new']);
  r.native.request = async () => ({ messages: [{ id: 'stuck', timestamp: 1000 }], hasMore: true }) as any;
  await assert.rejects(r.bridge.allMessages(thread.id), /分页没有前进/);
});
test('stop sees a queued invocation that became active during withdrawal', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const nativeRequest = r.native.request.bind(r.native);
  r.native.request = async (path, options) => {
    if (path.endsWith('/queue') && options?.method === 'DELETE') r.native.queues.set(thread.id, { queue: [], activeInvocations: [{ catId: cat.id }] });
    return nativeRequest(path, options);
  };
  await r.bridge.stop(thread.id);
  assert.ok(r.native.calls.some(c => c.path.endsWith('/cancel/' + cat.id)));
});
test('presentation store rejects domain payloads and credentials', async t => {
  const r = await setup(t);
  const file = join(r.dir, 'invalid.json');
  writeFileSync(file, JSON.stringify({ version: 1, bots: {}, groupThreadIds: [], folders: [], messageRefs: {}, messages: [{ content: 'duplicated domain' }] }));
  assert.throws(() => new ProductStore(file), /Unsupported presentation store/);
  writeFileSync(file, JSON.stringify({ version: 1, bots: { cat: { apiKey: 'must-not-be-stored' } }, groupThreadIds: [], folders: [], messageRefs: {} }));
  assert.throws(() => new ProductStore(file), /Unsupported presentation store/);
});
test('loopback CSRF boundary rejects other origins, hostnames and callback proxying', async t => {
  const r = await setup(t);
  assert.equal((await r.call('/xbot-api/bots', 'GET', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await r.call('/xbot-api/bots', 'GET', undefined, { Origin: 'http://localhost:7777' })).status, 403);
  const hostStatus = await new Promise<number | undefined>((ok, fail) => {
    const req = request(r.base + '/api/health', { headers: { Host: 'evil.example' } }, res => { res.resume(); ok(res.statusCode); });
    req.once('error', fail); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await r.call('/native-api/api/callback/post-message', 'POST', {})).status, 404);
  assert.equal((await r.call('/api/conversations', 'POST', {})).status, 410);
});
test('real session cookie and CSRF are forwarded; rejected mutations are never replayed', async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, options) => {
    calls.push({ path: String(input), options });
    if (String(input).endsWith('/api/session')) return new Response(JSON.stringify({ userId: 'clowder-bot-owner', csrfToken: 'server-csrf' }), { headers: { 'Set-Cookie': 'clowder_bot_native_session=server-issued; HttpOnly; SameSite=Strict' } });
    return new Response(JSON.stringify({ error: 'not admitted' }), { status: 409 });
  };
  const n = new NativeClient('http://127.0.0.1:4331', 'http://127.0.0.1:3210', fetcher);
  await assert.rejects(n.request('/api/messages', { method: 'POST', body: { content: 'hello' } }), /not admitted/);
  assert.equal(calls.length, 2);
  const headers = calls[1]!.options!.headers as Record<string, string>;
  assert.equal(headers.Cookie, 'clowder_bot_native_session=server-issued'); assert.equal(headers['x-csrf-token'], 'server-csrf');
  assert.equal(headers['X-Cat-Cafe-User'], undefined);
  await n.close();
});
test('Agent inventory distinguishes native configuration from activity and unsupported carriers', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  r.native.runtimes.push(
    { id: 'claude', label: 'Claude Code', clientId: 'anthropic', installed: true, models: [], readiness: { status: 'login_required' } },
    { id: 'kimi', label: 'Kimi', clientId: 'kimi', installed: true, models: [], readiness: { status: 'unknown' } },
    { id: 'acp:custom', label: 'Custom ACP', clientId: 'acp', installed: true, models: [], acp: {} },
  );
  const catalog = await (await r.call('/xbot-api/agents?refresh=1')).json();
  const codex = catalog.agents.find((a: any) => a.id === 'codex');
  assert.equal(codex.readiness.status, 'configured'); assert.equal(codex.activity.state, 'idle');
  assert.equal(codex.configuredModel, 'native-default'); assert.equal(codex.models, undefined);
  assert.deepEqual(codex.bots.map((b: any) => b.name), ['Ada']);
  assert.equal(catalog.agents.find((a: any) => a.id === 'claude').selectable, false);
  assert.equal(catalog.agents.find((a: any) => a.id === 'kimi').selectable, true);
  assert.equal(catalog.agents.find((a: any) => a.id === 'acp:custom').supported, false);
  assert.ok(r.native.calls.some(c => c.path === '/api/cats/native-runtimes?refresh=1'));
  assert.ok(!r.native.calls.some(c => c.path === '/api/accounts'));
  r.native.queues.set(thread.id, { queue: [], activeInvocations: [{ catId: cat.id }] });
  const running = await (await r.call('/xbot-api/agents')).json();
  assert.equal(running.agents.find((a: any) => a.id === 'codex').activity.state, 'running');
  const original = r.native.request.bind(r.native);
  r.native.request = async (path, options) => { if (path.endsWith('/queue')) throw new ApiError(503, 'queue unavailable'); return original(path, options); };
  const degraded = await (await r.call('/xbot-api/agents')).json();
  assert.equal(degraded.agents[0].activity.state, 'unknown'); assert.equal(degraded.agents[0].activity.active, null);
});
test('Agent binding restores native defaults; retired model APIs cannot mutate configuration', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  assert.equal(r.native.calls.find(c => c.path === '/api/cats' && c.method === 'POST')?.body.defaultModel, '');
  Object.assign(r.native.cats[0]!, { configurationSource: 'managed_account', accountRef: 'existing-account', defaultModel: 'old-model' });
  const initial = await (await r.call('/xbot-api/bots/Ada')).json();
  assert.equal(initial.agent.id, null); assert.equal(initial.agent.configurationSource, 'managed_account');
  assert.equal(initial.provider, undefined); assert.equal(initial.model, undefined);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: 'Legacy', model: 'old-model' })).status, 400);
  assert.equal((await r.call('/xbot-api/bots/Ada', 'PATCH', { model: 'old-model' })).status, 400);
  assert.equal((await r.call('/xbot-api/bots/Ada', 'PATCH', { runtimeId: 'codex' })).status, 400);
  assert.equal((await r.call('/xbot-api/bots/Ada/agent', 'PUT', { runtimeId: 'codex', model: 'injected' })).status, 400);
  assert.equal((await r.call('/xbot-api/bots/Ada/agent', 'PUT', { runtimeId: 'unknown' })).status, 404);
  for (const [path, method, body] of [
    ['/xbot-api/providers', 'GET', undefined], ['/xbot-api/models', 'GET', undefined],
    ['/xbot-api/providers/openai/key', 'PUT', { key: 'must-not-be-saved' }],
    ['/xbot-api/setup/key', 'POST', { key: 'must-not-be-saved' }],
    ['/xbot-api/bots/Ada/binding', 'PUT', { provider: 'native:openai', model: 'old' }],
  ] as const) assert.equal((await r.call(path, method, body)).status, 410);
  r.native.queues.set(thread.id, { queue: [], activeInvocations: [{ catId: cat.id }] });
  assert.equal((await r.call('/xbot-api/bots/Ada/agent', 'PUT', { runtimeId: 'codex' })).status, 409);
  r.native.queues.set(thread.id, { queue: [], activeInvocations: [] });
  const bound = await r.call('/xbot-api/bots/Ada/agent', 'PUT', { runtimeId: 'codex' }); assert.equal(bound.status, 200);
  assert.equal((await bound.json()).agent.id, 'codex');
  const patch = r.native.calls.findLast(c => c.path === `/api/cats/${cat.id}` && c.method === 'PATCH')!.body;
  assert.equal(patch.configurationSource, 'native_tool'); assert.equal(patch.accountRef, null);
  assert.equal(patch.defaultModel, ''); assert.equal(patch.cli.effort, null); assert.equal(patch.cli.serviceTier, null);
  assert.deepEqual(patch.cliConfigArgs, [], 'Codex gets no extra arguments'); assert.equal(patch.expectedRevision, cat.configurationRevision);
  assert.equal((await r.bridge.direct(cat)).id, thread.id);
  // Bound to Claude Code, the member starts with the CLI's own schedulers switched off, so "remind me…" goes to the engine's.
  r.native.runtimes.push({ id: 'claude', label: 'Claude Code', clientId: 'anthropic', installed: true, models: [], readiness: { status: 'configured', checkedAt: 1 } });
  assert.equal((await r.call('/xbot-api/bots/Ada/agent', 'PUT', { runtimeId: 'claude' })).status, 200);
  const claude = r.native.calls.findLast(c => c.path === `/api/cats/${cat.id}` && c.method === 'PATCH')!.body;
  assert.deepEqual(claude.cliConfigArgs, ['--settings', '{"skillOverrides":{"schedule":"off","loop":"off"}}', '--disallowedTools', 'RemoteTrigger,CronCreate,CronDelete,CronList']);
  assert.doesNotMatch(claude.cliConfigArgs[1], /\s/, 'the settings JSON has no spaces: the CLI carrier splits arguments on whitespace');
});
