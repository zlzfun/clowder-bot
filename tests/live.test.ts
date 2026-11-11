import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { liveEvent } from '../server/native/live.js';
import { messageDisplayText, replyInProgress, rosterRefusals } from '../server/native/message-presentation.js';
import type { NativeEvent, NativeMessage } from '../server/native/types.js';

// Shapes below are trimmed copies of events the pinned engine (42017e0) sent
// for real turns on an isolated runtime; see docs/chat-live-api.md.
const T = 'thread-1', CAT = 'bot-cat', MID = '0001794396211114-000007-f59b046d';
const stamp = { threadId: T, catId: CAT, messageId: MID, invocationId: 'outer', turnInvocationId: 'turn', seq: 7, seqEpoch: 'e' };
const layout = (length: number, owner: Record<string, unknown> = { threadId: T, catId: CAT, turnInvocationId: 'turn' }) =>
  ({ outputLayout: { v: 1, owner, contentRevision: { length, sha256: 'x' }, status: 'unavailable', reason: 'unknown_output' } });
const info = (content: Record<string, unknown>, extra: Record<string, unknown> = {}): NativeEvent =>
  ({ ...stamp, type: 'system_info', content: JSON.stringify(content), ...extra });

test('a streamed piece of a reply carries the cat, the reply and the native length after it', () => {
  const piece: NativeEvent = { ...stamp, type: 'text', origin: 'stream', content: '纸箱四', textMode: 'append', extra: layout(3), metadata: { usage: { costUsd: 1 } } };
  assert.deepEqual(liveEvent(piece, T), { kind: 'text', messageId: MID, catId: CAT, text: '纸箱四', end: 3 });
  assert.deepEqual(liveEvent({ ...piece, content: '面', extra: layout(4) }, T), { kind: 'text', messageId: MID, catId: CAT, text: '面', end: 4 });
  // A replacement says so; nothing else of the native payload (usage, session, tracing) is passed on.
  assert.deepEqual(liveEvent({ ...piece, textMode: 'replace' }, T), { kind: 'text', messageId: MID, catId: CAT, text: '纸箱四', end: 3, replace: true });
  // A length that cannot be this reply's (another owner, shorter than the piece, missing) is left out, not guessed.
  for (const extra of [layout(3, { threadId: 'other', catId: CAT }), layout(3, { threadId: T, catId: 'other' }), layout(2), layout(1.5), {}, undefined])
    assert.deepEqual(liveEvent({ ...piece, extra }, T), { kind: 'text', messageId: MID, catId: CAT, text: '纸箱四' });
});

test('only the reply stream of this thread is drawn live', () => {
  const piece: NativeEvent = { ...stamp, type: 'text', origin: 'stream', content: 'hi', extra: layout(2) };
  assert.equal(liveEvent({ ...piece, origin: 'callback' }, T), null, 'explicit posts arrive whole');
  assert.equal(liveEvent({ ...piece, origin: undefined }, T), null);
  assert.equal(liveEvent({ ...piece, content: '' }, T), null);
  assert.equal(liveEvent({ ...piece, messageId: undefined }, T), null);
  assert.equal(liveEvent({ ...piece, catId: null }, T), null);
  assert.equal(liveEvent(piece, 'thread-2'), null, 'an event of another thread');
  for (const type of ['queue_updated', 'thread_updated', 'session_init', 'resync', 'tool_result', undefined])
    assert.equal(liveEvent({ ...stamp, type }, T), null, String(type));
  // Codex's transient status: only "thinking" is drawn; "streaming" and its per-item "done" are not the end of a turn.
  assert.deepEqual(liveEvent({ ...stamp, type: 'status', content: 'thinking' }, T), { kind: 'thinking', messageId: MID, catId: CAT });
  for (const content of ['streaming', 'done', '', undefined]) assert.equal(liveEvent({ ...stamp, type: 'status', content }, T), null, String(content));
});

test('a step names the tool and what it works on, never a command or a whole path', () => {
  const step = (toolName: string, toolInput: unknown) => liveEvent({ ...stamp, type: 'tool_use', toolName, toolInput, toolUseId: 'toolu_1' }, T);
  assert.deepEqual(step('Write', { file_path: '/Users/me/data/native/workspace/cats/bot-1/hello.txt', content: 'secret words' }),
    { kind: 'step', messageId: MID, catId: CAT, tool: 'Write', target: 'hello.txt' });
  assert.deepEqual(step('Read', { file_path: 'C:\\work\\报告.md' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'Read', target: '报告.md' });
  assert.deepEqual(step('Glob', { path: '/work/src/', pattern: '**/*.ts' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'Glob', target: '**/*.ts' });
  assert.deepEqual(step('Grep', { pattern: 'TODO', path: 'src/app' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'Grep', target: 'TODO' });
  assert.deepEqual(step('Task', { description: '核对  周报\n数字', prompt: 'long private prompt' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'Task', target: '核对 周报 数字' });
  assert.deepEqual(step('WebFetch', { url: 'https://example.com/a/b?token=1', prompt: 'read it' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'WebFetch', target: 'example.com' });
  assert.deepEqual(step('WebFetch', { url: 'not a url' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'WebFetch' });
  assert.deepEqual(step('WebSearch', { query: '  猫 为什么\n喜欢 纸箱  ' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'WebSearch', target: '猫 为什么 喜欢 纸箱' });
  const long = step('Grep', { pattern: 'x'.repeat(200) }) as { target: string };
  assert.equal(long.target.length, 40); assert.ok(long.target.endsWith('…'));
  // A command line never travels, not even through the description that goes with it.
  assert.deepEqual(step('Bash', { command: 'cat ~/.ssh/id_rsa', description: 'cat /Users/me/.ssh/id_rsa' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'Bash' });
  assert.deepEqual(step('Bash', { command: 'ls', description: 'List files' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'Bash' });
  // Model-written search words and titles are dropped when they carry an absolute path.
  for (const [tool, input] of [['WebSearch', { query: 'what is in /Users/me/.ssh/id_rsa' }], ['Grep', { pattern: '~/secrets/token' }], ['Task', { description: 'read C:\\Users\\me\\keys' }],
    ['Task', { description: '看 "/etc/passwd/x"' }], ['Read', { query: 'notes', description: 'x' }], ['SomeOtherTool', { file_path: '/a/b.txt', query: 'q', description: 'd' }]] as const)
    assert.deepEqual(step(tool, input), { kind: 'step', messageId: MID, catId: CAT, tool }, tool + JSON.stringify(input));
  assert.deepEqual(step('Task', { description: '整理 src/app 里的测试' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'Task', target: '整理 src/app 里的测试' });
  assert.deepEqual(step('mcp__cat-cafe-collab__cat_cafe_post_message', 'not an object'), { kind: 'step', messageId: MID, catId: CAT, tool: 'mcp__cat-cafe-collab__cat_cafe_post_message' });
  // Codex names: a file edit lists the files it touched; a shell command carries nothing.
  assert.deepEqual(step('file_change', { status: 'completed', changes: [{ path: '/Users/me/ws/cats/bot-1/note.txt', kind: { type: 'add' }, diff: '你好' }, { path: '/x/y.md' }] }),
    { kind: 'step', messageId: MID, catId: CAT, tool: 'file_change', target: 'note.txt' });
  assert.deepEqual(step('file_change', { changes: [] }), { kind: 'step', messageId: MID, catId: CAT, tool: 'file_change' });
  assert.deepEqual(step('command_execution', { command: '/bin/zsh -lc "sed -n 1p note.txt"' }), { kind: 'step', messageId: MID, catId: CAT, tool: 'command_execution' });
  assert.equal(step('', {}), null);
});

test('start, thinking and the end of a turn come from the native markers', () => {
  // invocation_created names the reply it will write before any word exists.
  assert.deepEqual(liveEvent(info({ type: 'invocation_created', invocationId: 'turn' }, { messageId: undefined, lifecycleResponseMessageId: MID }), T),
    { kind: 'start', messageId: MID, catId: CAT });
  assert.deepEqual(liveEvent(info({ type: 'thinking', catId: CAT, text: 'private reasoning' }), T), { kind: 'thinking', messageId: MID, catId: CAT });
  for (const type of ['invocation_usage', 'context_health', 'mcp_server_status', 'rate_limit', 'provider_turn_complete', 'rich_block'])
    assert.equal(liveEvent(info({ type, usage: { costUsd: 0.8 } }), T), null, type);
  assert.equal(liveEvent({ ...stamp, type: 'system_info', content: 'plain words' }, T), null);
  assert.equal(liveEvent({ ...stamp, type: 'system_info', content: '{broken' }, T), null);
  assert.equal(liveEvent({ ...stamp, type: 'system_info', content: '{"type":"thinking"}' + ' '.repeat(20_000) }, T), null);
  // The end of a turn says only that it ended. Native's `done` also follows a stop or a failure
  // (PerCatTerminalDispositionCollector: a bare done is no proof of success), so no outcome is claimed here.
  const ended = { kind: 'done', messageId: MID, catId: CAT };
  assert.deepEqual(liveEvent({ ...stamp, type: 'done', isFinal: true }, T), ended);
  assert.deepEqual(liveEvent({ ...stamp, type: 'done', errorCode: 'INVOCATION_CANCELLED' }, T), ended);
  assert.deepEqual(liveEvent({ ...stamp, type: 'error', error: 'boom', errorCode: 'x' }, T), ended);
  assert.deepEqual(liveEvent({ ...stamp, type: 'error', error: 'boom', errorDisposition: 'terminal' }, T), ended);
  assert.equal(liveEvent({ ...stamp, type: 'error', error: 'retrying', errorDisposition: 'transient' }, T), null, 'a transient provider error does not end the reply');
});

class LiveNative extends NativeFixture {
  listeners = new Map<string, (event: NativeEvent) => void>();
  override async subscribe(id: string, listener: (event: NativeEvent) => void) {
    this.listeners.set(id, listener);
    return () => { this.listeners.delete(id); };
  }
}
async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-live-')), native = new LiveNative();
  const runtime = createApp({ dataFile: join(dir, 'presentation.json'), native });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ...runtime, native, base, call };
}

test('the thread stream relays each native event unchanged and adds the live line for those a chat draws', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const response = await fetch(`${r.base}/xbot-api/runtime/threads/${thread.id}/events`);
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let seen = '';
  const until = async (marker: string) => { while (!seen.includes(marker)) { const { done, value } = await reader.read(); if (done) break; seen += decoder.decode(value, { stream: true }); } };
  await until('"resync"');
  const push = r.native.listeners.get(thread.id)!;
  const at = { ...stamp, threadId: thread.id, catId: cat.id };
  push({ threadId: thread.id, type: 'queue_updated', action: 'processing' });
  push({ ...at, type: 'system_info', content: JSON.stringify({ type: 'invocation_created' }), lifecycleResponseMessageId: MID });
  push({ ...at, type: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a/b/notes.md' } });
  push({ ...at, type: 'text', origin: 'stream', content: '你好', extra: layout(2, { threadId: thread.id, catId: cat.id }) });
  push({ ...at, type: 'done', isFinal: true });
  await until('"kind":"done"');
  await reader.cancel();
  const events = seen.split('\n\n').filter(block => block.startsWith('event: ')).map(block => {
    const [head, data] = block.split('\n'); return { event: head!.slice(7), data: JSON.parse(data!.slice(6)) };
  });
  assert.deepEqual(events.filter(e => e.event === 'live').map(e => e.data), [
    { kind: 'start', messageId: MID, catId: cat.id },
    { kind: 'step', messageId: MID, catId: cat.id, tool: 'Read', target: 'notes.md' },
    { kind: 'text', messageId: MID, catId: cat.id, text: '你好', end: 2 },
    { kind: 'done', messageId: MID, catId: cat.id },
  ]);
  // The raw relay is unchanged: one native event each, the live line right after its source.
  assert.deepEqual(events.map(e => e.event), ['native', 'native', 'native', 'live', 'native', 'live', 'native', 'live', 'native', 'live']);
  assert.equal(events[1]!.data.type, 'queue_updated');
  assert.equal(events[4]!.data.toolInput.file_path, '/a/b/notes.md');
});

test('a reply in progress is a row of its own: typing while it has no words, its words so far after that', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const reply = (fields: Partial<NativeMessage>): NativeMessage => ({ id: 'reply', type: 'assistant', catId: cat.id, timestamp: 2000, content: '', origin: 'stream', ...fields });
  const user: NativeMessage = { id: 'ask', type: 'user', catId: null, timestamp: 1000, content: 'hi' };
  const read = async () => (await (await r.call('/xbot-api/bots/Ada/transcript')).json()).messages as any[];
  r.native.messages.set(thread.id, [user, reply({ lifecycle: { kind: 'response', status: 'processing' } })]);
  let rows = await read();
  const waiting = rows.find(m => m.id === 'reply');
  assert.equal(waiting.content, ''); assert.equal(waiting.in_progress, true); assert.equal(waiting.status, 'processing');
  assert.equal(JSON.parse(waiting.tool_calls[0].function.arguments).text, '', 'no placeholder words stand in for the reply');
  assert.doesNotMatch(JSON.stringify(rows.map(({ native, ...row }) => row)), /正在等待或处理/);
  // The native draft: the words so far, still in progress.
  r.native.messages.set(thread.id, [user, reply({ content: '写到一半', isDraft: true })]);
  rows = await read();
  assert.equal(rows.find(m => m.id === 'reply').content, '写到一半');
  assert.equal(rows.find(m => m.id === 'reply').in_progress, true);
  // Settled: no marker; an empty settled reply is still not a bubble.
  r.native.messages.set(thread.id, [user, reply({ content: '写完了', lifecycle: { kind: 'response', status: 'completed' } })]);
  rows = await read();
  assert.equal('in_progress' in rows.find(m => m.id === 'reply'), false);
  r.native.messages.set(thread.id, [user, reply({ lifecycle: { kind: 'response', status: 'completed' } })]);
  assert.equal((await read()).some(m => m.id === 'reply'), false);
  // How a turn ended without words stays said.
  r.native.messages.set(thread.id, [user, reply({ lifecycle: { kind: 'response', status: 'canceled' } })]);
  assert.equal((await read()).find(m => m.id === 'reply').content, '已停止');
  r.native.messages.set(thread.id, [user, reply({ lifecycle: { kind: 'response', status: 'failed' } })]);
  assert.match((await read()).find(m => m.id === 'reply').content, /没完成/);
  // How it ended travels with the row, with native's own reason for an optional details view; a normal reply has none.
  const ended = async (fields: Partial<NativeMessage>) => { r.native.messages.set(thread.id, [user, reply(fields)]); return (await read()).find(m => m.id === 'reply')?.ended; };
  assert.deepEqual(await ended({ content: '写到一半', lifecycle: { kind: 'response', status: 'failed', reason: ' provider_error: overloaded ' } }), { how: 'failed', reason: 'provider_error: overloaded' });
  assert.deepEqual(await ended({ lifecycle: { kind: 'response', status: 'failed' } }), { how: 'failed' });
  assert.deepEqual(await ended({ content: '写到一半', lifecycle: { kind: 'response', status: 'canceled', reason: 'user' } }), { how: 'stopped' });
  assert.deepEqual(await ended({ content: '写到一半', lifecycle: { kind: 'response', status: 'interrupted' } }), { how: 'interrupted' });
  assert.equal(await ended({ content: '好了', lifecycle: { kind: 'response', status: 'completed' } }), undefined);
  assert.equal(await ended({ content: '在写', lifecycle: { kind: 'response', status: 'processing' } }), undefined);
  // An interrupted reply without words still says what happened instead of vanishing.
  r.native.messages.set(thread.id, [user, reply({ lifecycle: { kind: 'response', status: 'interrupted' } })]);
  assert.match((await read()).find(m => m.id === 'reply').content, /打断/);

  const peer = await r.bridge.createBot({ name: 'Bob' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json();
  r.native.messages.set(group.id, [user,
    reply({ id: 'ada-typing', lifecycle: { kind: 'response', status: 'processing' } }),
    reply({ id: 'bob-draft', catId: peer.id, content: '我来', isDraft: true }),
    reply({ id: 'done-empty', lifecycle: { kind: 'response', status: 'completed' } })]);
  const page = await (await r.call(`/xbot-api/groups/${group.id}`)).json();
  assert.deepEqual(page.messages.map((m: any) => [m.id, m.text, m.in_progress ?? false]), [['ask', 'hi', false], ['ada-typing', '', true], ['bob-draft', '我来', true]]);

  assert.equal(replyInProgress(user), false);
  assert.equal(replyInProgress({ ...user, isDraft: true }), false, 'only replies are in progress');
});

test('a reply quotes what it answers only when something else came in between', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const user = (id: string, timestamp: number, replyTo?: string): NativeMessage => ({ id, type: 'user', catId: null, timestamp, content: id, ...(replyTo ? { replyTo } : {}) });
  const reply = (id: string, timestamp: number, replyTo: string): NativeMessage => ({ id, type: 'assistant', catId: cat.id, timestamp, content: id, replyTo });
  r.native.messages.set(thread.id, [
    user('q1', 1), reply('a1', 2, 'q1'),            // straight under its question
    user('q2', 3), user('q3', 4), reply('a2', 5, 'q2'), // a later question came in between
    reply('a3', 6, 'q3'),                           // the nearest question, another reply between
    user('q4', 7, 'a1'),                            // the owner quoting an earlier reply
  ]);
  const rows = (await (await r.call('/xbot-api/bots/Ada/transcript')).json()).messages.filter((m: any) => m.id);
  const seq = Object.fromEntries(rows.map((m: any) => [m.id, m.seq]));
  assert.deepEqual(rows.map((m: any) => [m.id, m.reply_to]),
    [['q1', 0], ['a1', 0], ['q2', 0], ['q3', 0], ['a2', seq.q2], ['a3', 0], ['q4', seq.a1]]);
  for (const m of rows) if (m.native.replyTo) assert.ok(m.native.replyTo, 'the native record keeps what it answers');
  // At the top of a page that continues further back, the message just before is unknown: no quote is guessed.
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options?: any) => {
    const result: any = await request(path, options);
    return path.startsWith('/api/messages?') ? { ...result, messages: result.messages.slice(1), hasMore: true } : result;
  }) as typeof r.native.request;
  const cut = (await (await r.call('/xbot-api/bots/Ada/transcript')).json()).messages.filter((m: any) => m.id);
  assert.deepEqual(cut.slice(0, 2).map((m: any) => [m.id, m.reply_to]), [['a1', 0], ['q2', 0]]);
  assert.equal(cut.find((m: any) => m.id === 'a2').reply_to, seq.q2, 'further down the same page the rule is unchanged');
});

test('a cat that signed by itself before the host tail loses both lines, in the chat only', () => {
  const body = '你好，我是砚砚，很高兴认识你。', own = '\n\n[砚砚/GPT-6🐾]', host = '\n\n[砚砚/🐾]', content = body + own + host;
  const message: NativeMessage = {
    id: 'm', type: 'assistant', catId: 'cat', timestamp: 1, content, origin: 'stream',
    lifecycle: { kind: 'response', status: 'completed', invocationId: 'turn-1' },
    extra: { outputLayout: {
      v: 1, status: 'available', owner: { threadId: 'thread', catId: 'cat', turnInvocationId: 'turn-1' },
      contentRevision: { length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
      hostTail: { kind: 'cat_signature', producer: 'codex_stream_finalizer', basis: 'runtime_canonical', start: (body + own).length, end: content.length, gluePrefixLength: 2 },
    } },
  };
  assert.equal(messageDisplayText(message, 'thread'), body);
  assert.equal(message.content, content);
  // Without a verified host range nothing changes for words that only look alike.
  assert.equal(messageDisplayText({ ...message, extra: undefined, content: '正文里引用 [砚砚/🐾] 的写法' }, 'thread'), '正文里引用 [砚砚/🐾] 的写法');
  // A fenced example above the host tail stays.
  const fenced = '```text\n[砚砚/GPT-6🐾]\n```', fencedContent = fenced + host;
  assert.equal(messageDisplayText({ ...message, content: fencedContent, extra: { outputLayout: {
    ...(message.extra!.outputLayout as object), contentRevision: { length: fencedContent.length, sha256: createHash('sha256').update(fencedContent).digest('hex') },
    hostTail: { kind: 'cat_signature', producer: 'codex_stream_finalizer', basis: 'runtime_canonical', start: fenced.length, end: fencedContent.length, gluePrefixLength: 2 },
  } } }, 'thread'), fenced);
});

test('cats addressed from outside a conversation are named once, not listed as raw engine refusals', async t => {
  const r = await setup(t), ada = await r.bridge.createBot({ name: 'Ada' }), bob = await r.bridge.createBot({ name: 'Bob' });
  const cy = await r.bridge.createBot({ name: 'Cy' }), dee = await r.bridge.createBot({ name: 'Dee' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { name: 'Team', members: ['Ada', 'Bob'] })).json();
  // Shapes from a real run: the engine's @all reached every cat; the member check (patches/0001) refused the outsiders.
  const refused = (id: string, catId: string, timestamp: number): NativeMessage =>
    ({ id, type: 'system', catId: null, timestamp, content: `Error: Member ${catId} is not in the execution roster of thread ${group.id}` });
  r.native.messages.set(group.id, [
    { id: 'u1', type: 'user', catId: null, timestamp: 1000, content: '@all 各说一句' },
    refused('x1', cy.id, 1100), refused('x2', dee.id, 1200),
    { id: 'a1', type: 'assistant', catId: ada.id, timestamp: 1300, content: '我先说' },
    refused('x3', 'bot-deleted', 1400), refused('x4', cy.id, 1450),
    { id: 'u2', type: 'user', catId: null, timestamp: 2000, content: '@Cy 你呢' },
    refused('x5', cy.id, 2100),
    { id: 's1', type: 'system', catId: null, timestamp: 2200, content: 'Error: something else went wrong' },
  ]);
  const page = await (await r.call(`/xbot-api/groups/${group.id}`)).json();
  assert.deepEqual(page.messages.map((m: any) => [m.id, m.text, m.notice ?? false]), [
    ['u1', '@all 各说一句', false], ['x1', 'Cy、Dee、有只猫猫不在这个群里，没有回答。', true], ['a1', '我先说', false],
    ['u2', '@Cy 你呢', false], ['x5', 'Cy不在这个群里，没有回答。', true], ['s1', 'Error: something else went wrong', false]]);
  assert.match(page.messages[1].native.content, /execution roster/, 'the native record is untouched');
  // The same in a single chat's transcript, worded for a conversation.
  const thread = await r.bridge.direct(ada);
  r.native.messages.set(thread.id, [{ id: 'u', type: 'user', catId: null, timestamp: 1, content: 'hi' }, { ...refused('y1', bob.id, 2), content: `Error: Member ${bob.id} is not in the execution roster of thread ${thread.id}` }]);
  const rows = (await (await r.call('/xbot-api/bots/Ada/transcript')).json()).messages.filter((m: any) => m.id);
  assert.deepEqual(rows.map((m: any) => [m.id, m.content, m.notice ?? false]), [['u', 'hi', false], ['y1', 'Bob不在这个对话里，没有回答。', true]]);
  assert.equal(rosterRefusals([{ id: 'n', type: 'assistant', catId: 'c', timestamp: 1, content: 'Error: Member x is not in the execution roster of thread t' }], () => 'X', true).size, 0, 'only the engine’s own system line');
  // The engine's line carries no link to the message that caused it, so the fold goes by position only and the
  // sentence claims nothing about which message it answers: every cat that was turned away is still named.
  const line = (id: string, member: string): any => ({ id, type: 'system', catId: null, timestamp: 1, content: `Error: Member ${member} is not in the execution roster of thread t` });
  const said = (id: string): any => ({ id, type: 'user', catId: null, timestamp: 1, content: id });
  const names = (id: string) => ({ a: 'Cy', b: 'Dee' } as Record<string, string>)[id];
  assert.deepEqual([...rosterRefusals([said('u1'), said('u2'), line('x1', 'a'), line('x2', 'b')], names, true)],
    [['x1', 'Cy、Dee不在这个群里，没有回答。'], ['x2', null]], 'two requests answered back to back read as one line with both names');
  // A run cut by a page boundary is told on each page for the cats that page has.
  assert.deepEqual([...rosterRefusals([said('u1'), line('x1', 'a')], names, true)], [['x1', 'Cy不在这个群里，没有回答。']]);
  assert.deepEqual([...rosterRefusals([line('x2', 'b')], names, true)], [['x2', 'Dee不在这个群里，没有回答。']]);
});

test('a signature a cat wrote at the start of its own reply is hidden when words follow it', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: '快手' }), thread = await r.bridge.direct(cat);
  const shown = (content: string, name: string | undefined = '快手') => messageDisplayText({ id: 'm', type: 'assistant', catId: cat.id, timestamp: 1, content }, thread.id, name);
  assert.equal(shown('[快手/Haiku🐾]  今天精力满满，准备好接棒！🚀'), '今天精力满满，准备好接棒！🚀');
  assert.equal(shown('[快手🐾] 7'), '7');
  assert.equal(shown('[快手/Haiku 🐾] 好的\n\n[快手/Haiku 🐾]'), '好的', 'and the closing one as before');
  assert.equal(shown('[快手/Haiku🐾]\n\n7'), '7', 'the real shape: the signature on a line of its own, then the answer');
  assert.equal(shown('[快手/Haiku🐾]  \n \n    const a = 1;\n    const b = 2;'), '    const a = 1;\n    const b = 2;', 'an indented first line keeps its indentation: it may be a code block');
  // Not its own name, not at the start, or no paw: the text stays. A signature with nothing after it is the closing kind.
  for (const text of ['[墨点/gpt🐾] 是墨点的署名', '[墨点/gpt🐾]\n\n7', '看这个 [快手/Haiku🐾] 格式', '[快手] 没有猫爪'])
    assert.equal(shown(text), text, text);
  assert.equal(shown('[快手/Haiku🐾]'), '');
  assert.equal(shown('[快手/Haiku🐾]  今天'), '今天');
  assert.equal(messageDisplayText({ id: 'm', type: 'assistant', catId: cat.id, timestamp: 1, content: '[快手/Haiku🐾]  今天' }, thread.id), '[快手/Haiku🐾]  今天');
  // Through the routes: a group reply and the conversation's latest line.
  const peer = await r.bridge.createBot({ name: '墨点' });
  const group = await (await r.call('/xbot-api/groups', 'POST', { members: ['快手', '墨点'] })).json();
  r.native.messages.set(group.id, [{ id: 'g', type: 'assistant', catId: cat.id, timestamp: 5, content: '[快手/Haiku🐾]  7' }, { id: 'h', type: 'assistant', catId: peer.id, timestamp: 6, content: '[快手/Haiku🐾] 是它的署名' }]);
  const page = await (await r.call(`/xbot-api/groups/${group.id}`)).json();
  assert.deepEqual(page.messages.map((m: any) => m.text), ['7', '[快手/Haiku🐾] 是它的署名']);
  r.native.messages.set(thread.id, [{ id: 'd', type: 'assistant', catId: cat.id, timestamp: 5, content: '[快手/Haiku🐾]  到了' }]);
  assert.equal((await r.bridge.activity.read(thread.id)).last!.text, '到了');
  assert.equal((await (await r.call('/xbot-api/bots/' + encodeURIComponent('快手') + '/transcript')).json()).messages[0].content, '到了');
});
