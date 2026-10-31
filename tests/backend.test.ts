import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AgentEvent, AgentProvider, AgentRequest, Memory, Message } from '../shared/types.js';
import { Store, id, makeBot, now } from '../server/store.js';
import { createApp } from '../server/app.js';
import { Orchestrator } from '../server/orchestrator.js';
import { buildContext, compactConversation, recallMemories, scopedMemories } from '../server/core/context.js';
import { displayText, parseMemoryTags, parseMentions } from '../server/core/routing.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  return { dir, store, state: store.state, group: store.state.conversations[0]!, bots: store.state.bots };
}
function provider(fn: (request: AgentRequest) => string): AgentProvider {
  return { async *stream(request) { yield { type: 'delta', text: fn(request) }; } };
}

test('handoff routing ignores fences, quotes, self, inline text and prefix collisions', t => {
  const { bots, state } = fixture(t);
  const [first, second, third] = bots;
  assert.deepEqual(parseMentions(`\`\`\`text\n@${second!.name} fake\n\`\`\`\n> @${third!.name} quote\ninline @${second!.name}\n@${first!.name} self`, bots, state.templates, first!.id), []);
  assert.deepEqual(parseMentions(`@${second!.name}-extra not a match\n@${second!.name} 检查\n- @${third!.name} 设计`, bots, state.templates, first!.id).map(b => b.id), [second!.id, third!.id]);
  assert.deepEqual(parseMentions(`~~~\n@${second!.name}`, bots, state.templates, first!.id), []);
  assert.deepEqual(parseMentions(`请 @${second!.name} 看看`, bots, state.templates, undefined, false).map(b => b.id), [second!.id]);
});

test('template clones route by unique name and do not steal shared aliases', t => {
  const { bots, state } = fixture(t);
  const clone = makeBot('ragdoll'); clone.name = '宪宪 2'; bots.push(clone);
  assert.equal(parseMentions('@宪宪 2 请检查', bots, state.templates)[0]?.id, clone.id);
  assert.equal(parseMentions('@宪宪 请检查', bots, state.templates)[0]?.id, bots[0]!.id);
  assert.deepEqual(parseMentions('@布偶猫 请检查', bots, state.templates), []);
});

test('memory controls are bounded, hidden during streaming, ignored in code', () => {
  const text = '正文< memory>\n<memory scope="bot">偏好简洁</memory>\n```\n<memory scope="shared">not real</memory>\n```';
  assert.deepEqual(parseMemoryTags(text), [{ scope: 'bot', content: '偏好简洁' }]);
  assert.equal(displayText('正文\n<memory scope="bot">secret'), '正文\n');
  assert.equal(displayText('正文\n<mem'), '正文\n');
  const example = '示例：`<memory scope="shared">偏好使用 Ruby</memory>`';
  assert.deepEqual(parseMemoryTags(example), []);
  assert.equal(displayText(example), example);
  const code = '```xml\n<memory scope="shared">not real</memory>\n```';
  assert.equal(displayText(code), code);
});

test('recall and context isolate bot/conversation memory with bounded input', t => {
  const { store, state, group, bots } = fixture(t);
  const add = (input: Partial<Memory> & Pick<Memory, 'scope' | 'content'>) => store.remember({ tags: [], source: 'user', ...input });
  add({ scope: 'shared', content: '团队使用 TypeScript' });
  add({ scope: 'bot', botId: bots[0]!.id, content: 'own-private' });
  add({ scope: 'bot', botId: bots[1]!.id, content: 'other-private' });
  add({ scope: 'conversation', conversationId: 'elsewhere', content: 'other-room' });
  assert.equal(scopedMemories(state, bots[0]!.id, group.id).length, 2);
  assert.equal(recallMemories(state, bots[0]!.id, group.id, 'TypeScript')[0]?.content, '团队使用 TypeScript');
  state.settings.contextBudget = 2000;
  state.messages.push({ id: id('msg'), conversationId: group.id, role: 'user', status: 'complete', content: '很长的消息'.repeat(5000), createdAt: now() });
  const context = buildContext(state, group, bots[0]!);
  const text = context.map(m => m.content).join('\n');
  assert.ok(text.includes('own-private'));
  assert.ok(!text.includes('other-private'));
  assert.ok(!text.includes('other-room'));
  assert.ok(group.contextTokens <= 2000);
  assert.ok(context.at(-1)!.content.includes('摘录省略'));
});

test('compaction preserves raw messages, retains recent tail and advances boundary', t => {
  const { state, group } = fixture(t);
  for (let n = 0; n < 12; n++) state.messages.push({ id: `source-${n}`, conversationId: group.id, role: n % 2 ? 'assistant' : 'user', status: 'complete', content: `决定 ${n}：内容${'详细解释'.repeat(50)}`, createdAt: now() });
  const original = JSON.stringify(state.messages);
  assert.equal(compactConversation(state, group, true), true);
  assert.equal(group.compactedMessageCount, 10);
  assert.ok(group.summary.includes('source-9'));
  assert.equal(JSON.stringify(state.messages), original);
  assert.equal(compactConversation(state, group, true), true);
  assert.equal(group.compactedMessageCount, 11);
});

test('lowering the context budget re-bounds a previous summary and retains the current user request', t => {
  const { state, group, bots } = fixture(t);
  group.summary = '先前确定的事实'.repeat(300);
  state.settings.contextBudget = 2000;
  state.messages.push({ id: id('msg'), conversationId: group.id, role: 'user', status: 'complete', content: 'CURRENT_REQUEST_MARKER', createdAt: now() });
  const messages = buildContext(state, group, bots[0]!);
  assert.ok(group.contextTokens <= 2000);
  assert.ok(messages.some(m => m.content.includes('CURRENT_REQUEST_MARKER')));
  assert.ok(messages[0]!.content.includes('每次最多两位'));
});

test('a group without explicit mention invokes its first configured member', async t => {
  const { store, group, bots } = fixture(t);
  group.botIds = [bots[1]!.id, bots[0]!.id];
  const called: string[] = [];
  const orchestrator = new Orchestrator(store, () => {}, () => provider(request => { called.push(request.bot.id); return 'done'; }));
  orchestrator.start(group.id, 'hello'); await orchestrator.wait(group.id);
  assert.deepEqual(called, [bots[1]!.id]);
});

test('orchestrator executes handoff, saves explicit memories, and blocks repeat edges', async t => {
  const { store, group, bots } = fixture(t);
  const calls: string[] = [];
  const mock = provider(request => {
    calls.push(request.bot.id);
    return request.bot.id === bots[0]!.id ? `建议\n<memory scope="bot">专属记忆</memory>\n@${bots[1]!.name} 请审查` : `审查完成\n@${bots[0]!.name} 请确认`;
  });
  const orchestrator = new Orchestrator(store, () => {}, () => mock);
  orchestrator.start(group.id, '帮我设计一个方案');
  assert.throws(() => orchestrator.start(group.id, 'duplicate'), /正在回复/);
  await orchestrator.wait(group.id);
  assert.deepEqual(calls, [bots[0]!.id, bots[1]!.id, bots[0]!.id]);
  assert.equal(group.status, 'idle');
  assert.equal(store.state.memories.length, 1);
  assert.equal(store.state.memories[0]?.botId, bots[0]!.id);
  assert.ok(store.state.messages.some(m => m.kind === 'handoff'));
  assert.ok(store.state.messages.some(m => m.content.includes('停止重复传球')));
  assert.ok(store.state.messages.filter(m => m.role === 'assistant').every(m => !m.content.includes('<memory')));
});

test('maxHops stops collaboration budget and unsupported targets never run', async t => {
  const { store, group, bots } = fixture(t);
  store.state.settings.maxHops = 1;
  let count = 0;
  const orchestrator = new Orchestrator(store, () => {}, () => provider(() => { count++; return `@${bots[1]!.name} 检查\n@outsider bad`; }));
  orchestrator.start(group.id, 'hello'); await orchestrator.wait(group.id);
  assert.equal(count, 1);
  assert.ok(store.state.messages.some(m => m.content.includes('回复上限')));
});

test('cancellation stops streaming and allows next run', async t => {
  const { store, group } = fixture(t);
  const slow: AgentProvider = { async *stream(request): AsyncIterable<AgentEvent> {
    yield { type: 'delta', text: 'partial' };
    await new Promise<void>(resolve => request.signal.aborted ? resolve() : request.signal.addEventListener('abort', () => resolve(), { once: true }));
  } };
  const orchestrator = new Orchestrator(store, () => {}, () => slow);
  orchestrator.start(group.id, 'start');
  await new Promise(resolve => setTimeout(resolve, 5));
  await orchestrator.cancel(group.id);
  assert.equal(group.status, 'idle');
  assert.equal(store.state.messages.find(m => m.role === 'assistant')?.status, 'cancelled');
  assert.equal(orchestrator.busy(group.id), false);
});

test('provider failures persist error state without losing user input', async t => {
  const { store, group } = fixture(t);
  const broken: AgentProvider = { async *stream() { throw new Error('provider offline'); } };
  const orchestrator = new Orchestrator(store, () => {}, () => broken);
  orchestrator.start(group.id, 'keep this'); await orchestrator.wait(group.id);
  assert.equal(group.status, 'error');
  assert.ok(store.state.messages.some(m => m.role === 'user' && m.content === 'keep this'));
  assert.ok(store.state.messages.some(m => m.content === 'provider offline'));
  assert.equal(orchestrator.busy(group.id), false);
});

test('restart recovers interrupted turns and malformed state is never overwritten', t => {
  const { store, group, dir } = fixture(t);
  group.status = 'running';
  store.state.messages.push({ id: 'interrupted', conversationId: group.id, role: 'assistant', content: 'partial', status: 'streaming', createdAt: now() });
  store.save();
  const restored = new Store(store.file);
  assert.equal(restored.state.conversations[0]?.status, 'idle');
  assert.equal(restored.state.messages.find(m => m.id === 'interrupted')?.status, 'cancelled');
  const bad = join(dir, 'bad.json'); writeFileSync(bad, '{broken');
  assert.throws(() => new Store(bad));
});

test('the shared memory limit also applies to agent writes without blocking deduplication', t => {
  const { store } = fixture(t);
  const first = store.remember({ scope: 'shared', content: 'already known', tags: [], source: 'agent' });
  store.state.memories = Array.from({ length: 5000 }, (_, index) => ({ ...first, id: `memory-${index}`, content: index ? `fact-${index}` : first.content }));
  assert.equal(store.remember({ scope: 'shared', content: 'already known', tags: [], source: 'agent' }).id, 'memory-0');
  assert.throws(() => store.remember({ scope: 'shared', content: 'one too many', tags: [], source: 'agent' }), /记忆条目已达上限/);
  assert.equal(store.state.memories.length, 5000);
});

test('live compaction uses summarizer but does not execute its memory / handoff controls', async t => {
  const { store, state, group } = fixture(t);
  state.settings.mode = 'live';
  for (let n = 0; n < 6; n++) state.messages.push({ id: `fact-${n}`, conversationId: group.id, role: 'user', status: 'complete', content: `事实${n}`, createdAt: now() });
  let calls = 0;
  const orchestrator = new Orchestrator(store, () => {}, () => provider(request => {
    calls++; assert.ok(request.messages[0]!.content.includes('会话记录员'));
    return '目标：完成核心聊天。证据：[fact-3]\n<memory scope="shared">do not save</memory>';
  }));
  await orchestrator.compact(group.id);
  assert.equal(calls, 1);
  assert.ok(group.summary.includes('fact-3'));
  assert.equal(state.memories.length, 0);
  assert.equal(state.messages.filter(m => m.id.startsWith('fact-')).length, 6);
});

test('cancelling a live compaction resolves normally and preserves the prior summary boundary', async t => {
  const { store, state, group } = fixture(t);
  state.settings.mode = 'live';
  group.summary = 'prior summary';
  for (let n = 0; n < 6; n++) state.messages.push({ id: `fact-${n}`, conversationId: group.id, role: 'user', status: 'complete', content: `事实${n}`, createdAt: now() });
  const mock: AgentProvider = { async *stream(request) {
    await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } };
  const orchestrator = new Orchestrator(store, () => {}, () => mock);
  const work = orchestrator.compact(group.id);
  await orchestrator.cancel(group.id);
  await work;
  assert.equal(group.summary, 'prior summary');
  assert.equal(group.compactedMessageCount, 0);
  assert.equal(group.status, 'idle');
});

test('HTTP integration validates origins and fields, emits SSE, persists chat and cascades deletion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-http-'));
  const runtime = createApp({ dataFile: join(dir, 'state.json'), provider: () => provider(() => 'response') });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/bots', { templateId: 'ragdoll' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/bots', { templateId: 'ragdoll', apiKey: 'secret' })).status, 400);
  assert.equal((await post('/api/conversations', { kind: 'direct', botIds: ['unknown'] })).status, 400);
  const created = await post('/api/bots', { templateId: 'ragdoll' }); assert.equal(created.status, 201);
  const clone = await created.json() as { id: string; name: string }; assert.equal(clone.name, '宪宪 2');
  const conversation = runtime.store.state.conversations.find(c => c.kind === 'direct' && c.botIds[0] === clone.id)!;
  const sseController = new AbortController();
  const events = await fetch(base + '/api/events', { signal: sseController.signal });
  const reader = events.body!.getReader();
  const first = await reader.read(); assert.ok(new TextDecoder().decode(first.value).includes('event: state'));
  sseController.abort(); await reader.cancel().catch(() => {});
  assert.equal((await post(`/api/conversations/${conversation.id}/messages`, { content: 'hello' })).status, 202);
  await runtime.orchestrator.wait(conversation.id);
  assert.ok(runtime.store.state.messages.some(m => m.conversationId === conversation.id && m.content === 'response'));
  assert.equal((await post('/api/memories', { scope: 'conversation', conversationId: conversation.id, content: 'room memory' })).status, 201);
  assert.equal((await fetch(base + `/api/conversations/${conversation.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!runtime.store.state.messages.some(m => m.conversationId === conversation.id));
  assert.ok(!runtime.store.state.memories.some(m => m.conversationId === conversation.id));
});
