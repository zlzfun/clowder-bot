// A stand-in for the native runtime, for looking at the interface without an
// engine, a model or the owner's data: the real Bot adapter over a scripted
// protocol fixture. It replays the event shapes the pinned engine sends for a
// turn (see docs/chat-live-api.md) so a reply can be watched being written,
// stopped or failing, and it can put the first screen into states a machine
// with working tools cannot show (nothing installed, login needed).
//
//   npm run preview:fixture            → http://127.0.0.1:3230
//   PREVIEW_PORT=3231 PREVIEW_CATS=0 npm run preview:fixture
//   curl -X POST :3230/__preview -H 'Content-Type: application/json' -d '{"agents":"login"}'
//
// Never linked from production and never a fallback: the replies are canned
// and say so. State lives in a temporary directory that is removed on exit.
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import type { NativeRuntime } from '../server/native/bridge.js';
import type { NativeCat, NativeEvent, NativeMessage } from '../server/native/types.js';
import { NativeFixture } from '../tests/native-fixture.js';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PREVIEW_PORT || 3230);
if (!Number.isInteger(port) || port === 3210 || port < 1024) throw new Error('The preview needs its own port');
const dir = mkdtempSync(join(tmpdir(), 'clowder-bot-preview-'));
const workspace = join(dir, 'workspace'); mkdirSync(workspace);
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const breeds = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'];
const breedNames: Record<string, [string, string, string | null]> = {
  ragdoll: ['布偶猫', '宪宪', 'claude'], 'maine-coon': ['缅因猫', '砚砚', 'codex'], siamese: ['暹罗猫', '烁烁', 'agy-native'],
  'turkish-van': ['梵花猫', '墨墨', 'kimi'], dsh: ['小鲸鱼', '鲸鲸', null], 'dragon-li': ['狸花猫', '小狸花', 'opencode'],
  bengal: ['孟加拉猫', '斑斑', 'antigravity'], 'golden-chinchilla': ['金渐层', '金哥', 'opencode'],
};
const agentSets: Record<string, NativeRuntime[]> = (() => {
  const make = (id: string, label: string, clientId: string, status: 'configured' | 'login_required' | 'unknown' | 'not_installed', loginCommand: string): NativeRuntime =>
    ({ id, label, clientId, installed: status !== 'not_installed', configuredModel: status === 'not_installed' ? undefined : 'preview-model', configuredEffort: 'medium',
      models: [], command: id, readiness: { status, checkedAt: Date.now(), loginCommand } });
  const set = (codex: any, claude: any) => [make('codex', 'Codex', 'openai', codex, 'codex login'), make('claude', 'Claude Code', 'anthropic', claude, 'claude auth login'),
    make('kimi', 'Kimi', 'kimi', 'not_installed', 'kimi login')];
  return { ready: set('configured', 'configured'), unknown: set('unknown', 'not_installed'), login: set('login_required', 'not_installed'), none: set('not_installed', 'not_installed') };
})();

class PreviewNative extends NativeFixture {
  listeners = new Map<string, Set<(event: NativeEvent) => void>>();
  turns = new Map<string, { threadId: string; catId: string; invocationId: string; stop: boolean }>();
  speed = 1; counter = 0; epoch = randomUUID(); seq = new Map<string, number>();
  constructor() { super(); this.runtimes = agentSets.ready!; }
  override async subscribe(id: string, listener: (event: NativeEvent) => void) {
    const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set);
    listener({ type: 'resync', threadId: id });
    return () => { set.delete(listener); };
  }
  emit(threadId: string, event: NativeEvent, sequenced = false) {
    const next = sequenced ? (this.seq.get(threadId) ?? 0) + 1 : undefined;
    if (next) this.seq.set(threadId, next);
    for (const listener of this.listeners.get(threadId) ?? []) listener({ ...event, threadId, ...(next ? { seq: next, seqEpoch: this.epoch } : {}) });
  }
  id(at = Date.now()) { return `${String(at).padStart(16, '0')}-${String(++this.counter).padStart(6, '0')}-${randomBytes(4).toString('hex')}`; }
  override async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    const method = options.method ?? 'GET', body = options.body, url = new URL(path, 'http://fixture');
    const parts = url.pathname.split('/').map(decodeURIComponent);
    const done = (result: unknown) => { this.calls.push({ path, method, body }); if (this.calls.length > 500) this.calls.splice(0, 250); return structuredClone(result) as T; };
    if (url.pathname === '/api/bot-cat-templates' && method === 'GET') return done({ breeds: breeds.map(id => ({ id, name: breedNames[id]![0] })),
      templates: breeds.map((id, index) => ({ id: 'seed:' + id, revision: index + 1, name: breedNames[id]![0], nameHint: breedNames[id]![1], source: { kind: 'user' },
        runtimeId: breedNames[id]![2], breed: { mode: 'explicit', breedId: id }, model: { mode: 'inherit' }, effort: { mode: 'inherit' },
        portrait: { roleDescription: '预览用的角色说明。', personality: '预览', teamStrengths: '预览用的简介' } })) });
    if (url.pathname === '/api/bot-cat-templates/instantiate' && method === 'POST') {
      const config = body.catConfig, runtime = this.runtimes.find(r => r.id === config.runtimeId);
      if (!runtime || !runtime.installed || runtime.readiness?.status === 'login_required') throw new ApiError(422, '这个 Agent 现在不可用');
      if (this.cats.some(cat => cat.name === body.name && !cat.id.endsWith(body.idempotencyKey.slice(0, 8)))) throw new ApiError(409, '已有同名猫猫');
      const id = 'bot-preview-' + body.idempotencyKey.slice(0, 8);
      let cat = this.cats.find(known => known.id === id);
      if (!cat) {
        cat = { id, name: body.name, displayName: body.name, nickname: body.name, breedId: config.breed.breedId ?? (runtime.id === 'claude' ? 'ragdoll' : 'maine-coon'),
          roleDescription: config.portrait.roleDescription, personality: config.portrait.personality, teamStrengths: config.portrait.teamStrengths,
          clientId: runtime.clientId, configurationSource: 'native_tool', defaultModel: config.model.value ?? '', mentionPatterns: ['@' + body.name],
          color: { primary: '#888', secondary: '#eee' }, configurationRevision: 'r1', isDefaultResponder: this.cats.length === 0 } as NativeCat;
        this.cats.push(cat);
      }
      return done({ cat, sourceTemplate: null });
    }
    // Native replays a member creation that carries the same identity; here the same ID is enough.
    if (url.pathname === '/api/cats' && method === 'POST') {
      const existing = this.cats.find(cat => cat.id === body.catId);
      if (existing) return done({ cat: existing });
      const cat = { ...body, id: body.catId, breedId: body.catId, configurationRevision: 'r1', isDefaultResponder: this.cats.length === 0 } as NativeCat;
      this.cats.push(cat); return done({ cat });
    }
    if (url.pathname === '/api/cats/runtime-models') return done({ status: 'live', models: [{ value: 'default', label: '默认', efforts: ['low', 'medium', 'high'].map(value => ({ value, label: value })) }] });
    if (parts[2] === 'cats' && parts[3] && parts.length === 4 && method === 'DELETE') { this.cats = this.cats.filter(cat => cat.id !== parts[3]); return done({ status: 'ok' }); }
    if (parts[2] === 'threads' && parts[3] && parts.length === 4 && method === 'DELETE') { this.threads.delete(parts[3]); return done({ status: 'ok' }); }
    if (url.pathname === '/api/schedule/tasks' && method === 'GET') return done({ tasks: [], botScheduleVersion: 1, botSchedulerReady: true });
    if (parts[2] === 'threads' && parts[4] === 'task-progress') return done({});
    if (parts[2] === 'threads' && parts[4] === 'queue' && method === 'GET') return done({ queue: [], queueRevision: 1,
      activeInvocations: [...this.turns.values()].filter(turn => turn.threadId === parts[3]).map(turn => ({ catId: turn.catId, invocationId: turn.invocationId, startedAt: Date.now(), status: 'running' })) });
    if (parts[2] === 'threads' && parts[4] === 'queue' && method === 'DELETE') return done({ ok: true });
    if (parts[2] === 'threads' && parts[4] === 'cancel' && method === 'POST') {
      for (const turn of this.turns.values()) if (turn.threadId === parts[3] && turn.catId === parts[5]) turn.stop = true;
      return done({ ok: true, cancelled: true });
    }
    if (url.pathname === '/api/messages' && method === 'POST') {
      const thread = this.threads.get(body.threadId); if (!thread) throw new ApiError(404, 'Missing thread');
      const list = this.messages.get(thread.id) ?? []; this.messages.set(thread.id, list);
      const user: NativeMessage = { id: this.id(), type: 'user', catId: null, timestamp: Date.now(), content: body.content, ...(body.replyTo ? { replyTo: body.replyTo } : {}) };
      list.push(user);
      const members = (thread.preferredCats ?? []).map(id => this.cats.find(cat => cat.id === id)).filter((cat): cat is NativeCat => !!cat);
      const named = members.filter(cat => body.content.includes('@' + cat.name));
      const targets = body.mentions?.length ? members.filter(cat => body.mentions.includes(cat.id)) : /大家|@all|@全体/.test(body.content) ? members : named.length ? named : members.slice(0, 1);
      const entries = targets.map(cat => ({ entryId: 'queue:' + randomBytes(8).toString('hex'), targetCatId: cat.id }));
      this.emit(thread.id, { type: 'queue_updated', action: 'enqueued' });
      for (const cat of targets) void this.turn(thread.id, cat, user).catch(error => console.error('[preview]', error));
      return done({ status: 'queued', queuePosition: 1, entryId: entries[0]?.entryId, entries, merged: false, userMessageId: user.id, userMessage: { id: user.id, timestamp: user.timestamp } });
    }
    return super.request(path, options);
  }
  script(cat: NativeCat, text: string) {
    const steps: Array<[string, Record<string, unknown>]> = [];
    let reply: string, fail = false, think = 500;
    if (text.startsWith('聊天页的开场邀请')) reply = `你好呀，我是${cat.name}。今天想聊点什么？`;
    else if (/失败/.test(text)) { reply = '我先看一下…'; fail = true; }
    else if (/长/.test(text)) reply = ['## 先说结论', '这是一段**预览用**的长回复，用来看一条回复被写出来的样子。', '',
      '- 第一点：列表、`行内代码` 和[链接](https://example.com)都会出现。', '- 第二点：下面有一段代码。', '- 第三点：最后是一张表。', '',
      '```js', 'function greet(name) {', '  return `你好，${name}`;', '}', '```', '',
      '| 项目 | 状态 |', '| --- | --- |', '| 流式文字 | 正在写 |', '| 停止 | 随时可以 |', '',
      ...Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段。猫喜欢纸箱，是因为四面围合的空间让它觉得安全，瓦楞纸又保暖，钻进去像自带一个小暖窝；而且纸箱是家里的新东西，可以啃、可以挠、可以占领。`)].join('\n');
    else if (/文件|查|资料/.test(text)) {
      if (cat.clientId === 'openai') steps.push(['command_execution', { command: "/bin/zsh -lc 'cat 说明.md'" }], ['file_change', { status: 'completed', changes: [{ path: '/preview/workspace/结果.md', kind: { type: 'add' } }] }]);
      else steps.push(['Read', { file_path: '/preview/workspace/说明.md' }], ['WebSearch', { query: '猫 为什么 喜欢 纸箱' }], ['Write', { file_path: '/preview/workspace/结果.md', content: '…' }]);
      reply = '看过说明、查了资料，也把要点写进了 `结果.md`。\n\n简单说：纸箱让猫觉得**安全又暖和**。';
    } else { if (/慢/.test(text)) think = 6000; reply = `收到：「${text.slice(0, 40)}」。\n\n这是预览环境里的固定回复，不是真的猫在回答。`; }
    return { steps, reply: reply + `\n\n[${cat.name}/preview🐾]`, fail, think };
  }
  async turn(threadId: string, cat: NativeCat, user: NativeMessage) {
    const list = this.messages.get(threadId)!, invocationId = randomUUID(), key = `${threadId}:${cat.id}:${invocationId}`;
    const state = { threadId, catId: cat.id, invocationId, stop: false }; this.turns.set(key, state);
    const { steps, reply, fail, think } = this.script(cat, user.content);
    const message: NativeMessage = { id: this.id(), type: 'assistant', catId: cat.id, timestamp: Date.now(), content: '', origin: 'stream', replyTo: user.id,
      lifecycle: { kind: 'response', status: 'processing', invocationId }, toolEvents: [] };
    const stamp = { catId: cat.id, messageId: message.id, invocationId: 'outer-' + invocationId, turnInvocationId: invocationId };
    const info = (content: Record<string, unknown>, more: Record<string, unknown> = {}) =>
      this.emit(threadId, { type: 'system_info', ...stamp, content: JSON.stringify(content), timestamp: Date.now(), ...more }, true);
    const settle = (status: string) => {
      message.lifecycle = { kind: 'response', status, invocationId, completedAt: Date.now() }; delete message.isDraft;
      this.turns.delete(key); this.emit(threadId, { type: 'queue_updated', action: 'completed' });
    };
    await wait(120 * this.speed);
    list.push(message);
    this.emit(threadId, { type: 'queue_updated', action: 'processing' });
    info({ type: 'invocation_created', invocationId }, { messageId: undefined, lifecycleResponseMessageId: message.id });
    await wait(300 * this.speed);
    // The two carriers mark thinking differently: Claude Code with a system_info, Codex with a transient status.
    const codex = cat.clientId === 'openai';
    const status = (content: string) => this.emit(threadId, { type: 'status', ...stamp, content, timestamp: Date.now() }, true);
    const thinking = () => codex ? status('thinking') : info({ type: 'thinking', catId: cat.id, text: '' });
    thinking();
    for (let waited = 0; waited < think && !state.stop; waited += 100) await wait(100 * this.speed);
    for (const [toolName, toolInput] of steps) {
      if (state.stop) break;
      this.emit(threadId, { type: 'tool_use', ...stamp, toolName, toolInput, toolUseId: 'toolu_' + randomBytes(6).toString('hex'), timestamp: Date.now() }, true);
      (message.toolEvents as unknown[]).push({ type: 'tool_use', toolName, label: toolName, detail: JSON.stringify(toolInput) });
      await wait(900 * this.speed);
      thinking();
    }
    // The stream runs ahead of the persisted draft, as on the real runtime (a draft is flushed about every two seconds).
    let written = '', flushed = Date.now();
    const pieces = reply.match(/[\s\S]{1,3}/gu) ?? [];
    for (const piece of pieces) {
      if (state.stop) break;
      written += piece;
      this.emit(threadId, { type: 'text', ...stamp, origin: 'stream', content: piece, textMode: 'append', timestamp: Date.now(),
        extra: { outputLayout: { v: 1, owner: { threadId, catId: cat.id, turnInvocationId: invocationId }, contentRevision: { length: written.length, sha256: '' }, status: 'unavailable' } } }, true);
      if (codex) {
        status('streaming');
        // Codex also sends the whole reply so far at the end of each paragraph and once more at the end.
        if (piece.includes('\n') || written.length === reply.length) this.emit(threadId, { type: 'text', ...stamp, origin: 'stream', content: written, textMode: 'replace', timestamp: Date.now(),
          extra: { outputLayout: { v: 1, owner: { threadId, catId: cat.id, turnInvocationId: invocationId }, contentRevision: { length: written.length, sha256: '' }, status: 'unavailable' } } }, true);
      }
      if (Date.now() - flushed > 1800 * this.speed) { message.content = written; message.isDraft = true; flushed = Date.now(); }
      if (fail && written.length > 4) break;
      await wait(35 * this.speed);
    }
    if (codex) status('done');
    if (state.stop) { message.content = written; settle('canceled'); this.emit(threadId, { type: 'done', ...stamp, isFinal: true, timestamp: Date.now() }, true); return; }
    if (fail) { message.content = ''; settle('failed'); this.emit(threadId, { type: 'error', ...stamp, error: 'preview failure', timestamp: Date.now() }, true); return; }
    message.content = written; settle('completed');
    this.emit(threadId, { type: 'done', ...stamp, isFinal: true, timestamp: Date.now() }, true);
  }
}

const native = new PreviewNative();
const runtime = createApp({ native, workspace, dataFile: join(dir, 'presentation.json'), staticDir: join(dir, 'no-static'),
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`] });
// Seeded cats come from the same quick creation the first screen uses.
// 团子 answers the way Claude Code does, 栗子 the way Codex does (see turn()).
for (const [index, name] of ['团子', '栗子', '年糕'].slice(0, Math.max(0, Math.min(3, Number(process.env.PREVIEW_CATS ?? 2)))).entries())
  await runtime.bridge.createBot({ name, simple: { face: breeds[[7, 1, 2][index]!]!, agent: ['claude', 'codex', 'claude'][index]! }, idempotencyKey: randomUUID() });
runtime.app.post('/__preview', (req, res) => {
  const input = req.body ?? {};
  if (typeof input.agents === 'string') { if (!agentSets[input.agents]) return res.status(400).json({ error: 'agents: ' + Object.keys(agentSets).join(' | ') }); native.runtimes = agentSets[input.agents]!; }
  if (typeof input.speed === 'number' && input.speed > 0 && input.speed <= 20) native.speed = input.speed;
  res.json({ agents: Object.entries(agentSets).find(([, set]) => set === native.runtimes)?.[0], speed: native.speed, cats: native.cats.map(cat => cat.name) });
});
runtime.app.use(express.static(join(root, 'client/public'), { etag: false, lastModified: false, setHeaders: res => res.setHeader('Cache-Control', 'no-store') }));
runtime.app.get('/', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(join(root, 'client/index.html')); });
const server = runtime.app.listen(port, '127.0.0.1', () => console.log(`preview (scripted fixture, no engine): http://127.0.0.1:${port}`));
const close = () => { void runtime.close().finally(() => server.close(() => { rmSync(dir, { recursive: true, force: true }); process.exit(0); })); };
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, close);
