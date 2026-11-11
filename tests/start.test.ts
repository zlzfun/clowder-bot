import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { defaultRuntime } from '../server/native/agents.js';
import type { NativeRuntime } from '../server/native/bridge.js';
import type { NativeCat } from '../server/native/types.js';

// Native template instantiation as the adapter sees it (patches/0005): the
// breed is worked out from the Agent, the portrait is taken as given.
class StartNative extends NativeFixture {
  override async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    if (path !== '/api/bot-cat-templates/instantiate') return super.request(path, options);
    this.calls.push({ path, method: options.method || 'GET', body: options.body });
    if (this.fail) throw this.fail;
    const { name, catConfig: c, idempotencyKey } = options.body, id = 'bot-' + idempotencyKey.slice(0, 8);
    let cat = this.cats.find(known => known.id === id);
    if (!cat) {
      cat = { id, name, displayName: name, breedId: c.runtimeId === 'claude' ? 'ragdoll' : 'maine-coon',
        roleDescription: c.portrait.roleDescription, personality: c.portrait.personality, teamStrengths: c.portrait.teamStrengths,
        clientId: c.runtimeId === 'claude' ? 'anthropic' : 'openai', configurationSource: 'native_tool', defaultModel: '',
        mentionPatterns: ['@' + name], color: { primary: '#888', secondary: '#eee' } } as NativeCat;
      this.cats.push(cat);
    }
    return { cat, sourceTemplate: null } as T;
  }
}
const runtime = (id: string, clientId: string, status: string | undefined, more: Partial<NativeRuntime> = {}): NativeRuntime =>
  ({ id, label: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : id, clientId, installed: status !== 'not_installed', models: [],
    ...(status ? { readiness: { status: status as any, checkedAt: 1, ...(id === 'codex' ? { loginCommand: 'codex login' } : {}) } } : {}), ...more });
async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-start-')), native = new StartNative();
  const app = createApp({ native, dataFile: join(dir, 'presentation.json') });
  const server = app.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { await app.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  return { ...app, native, call };
}

test('the first screen learns whether a chat can start, and what is in the way when it cannot', async t => {
  const r = await setup(t);
  const start = async (query = '') => { const { checkedAt, ...rest } = await (await r.call('/xbot-api/start' + query)).json(); assert.equal(typeof checkedAt, 'number'); return rest; };
  // Both tools logged in: the first one native lists is used; tools the adapter cannot bind are not offered.
  r.native.runtimes = [runtime('codex', 'openai', 'configured'), runtime('claude', 'anthropic', 'configured'), runtime('kimi', 'kimi', 'not_installed'),
    runtime('agy-native', 'google', 'configured', { agyCarrier: 'native' }), runtime('acp:x', 'openai', 'configured', { acp: {} })];
  assert.deepEqual(await start(), { cats: 0, ready: true, agent: { id: 'codex', label: 'Codex', confirmed: true }, blocked: null, agents: [
    { id: 'codex', label: 'Codex', state: 'ready', loginCommand: 'codex login' }, { id: 'claude', label: 'Claude Code', state: 'ready' }, { id: 'kimi', label: 'kimi', state: 'missing' }] });
  // A logged-in tool comes before one whose login could not be checked.
  r.native.runtimes = [runtime('codex', 'openai', 'unknown'), runtime('claude', 'anthropic', 'configured')];
  assert.deepEqual((await start()).agent, { id: 'claude', label: 'Claude Code', confirmed: true });
  // Installed but unchecked still starts, and says it is unconfirmed.
  r.native.runtimes = [runtime('codex', 'openai', undefined)];
  assert.deepEqual(await start(), { cats: 0, ready: true, agent: { id: 'codex', label: 'Codex', confirmed: false }, blocked: null, agents: [{ id: 'codex', label: 'Codex', state: 'unknown' }] });
  // Needs a login: says which command, starts nothing.
  r.native.runtimes = [runtime('codex', 'openai', 'login_required'), runtime('claude', 'anthropic', 'not_installed')];
  assert.deepEqual(await start(), { cats: 0, ready: false, agent: null, blocked: 'login_required', agents: [
    { id: 'codex', label: 'Codex', state: 'login', loginCommand: 'codex login' }, { id: 'claude', label: 'Claude Code', state: 'missing' }] });
  r.native.runtimes = [runtime('claude', 'anthropic', 'not_installed'), runtime('agy-native', 'google', 'configured', { agyCarrier: 'native' })];
  assert.deepEqual(await start(), { cats: 0, ready: false, agent: null, blocked: 'no_agent', agents: [{ id: 'claude', label: 'Claude Code', state: 'missing' }] });
  // Detection is read again only when asked.
  const reads = () => r.native.calls.filter(c => c.path.startsWith('/api/cats/native-runtimes')).map(c => c.path);
  r.native.calls.length = 0; await start(); await start('?refresh=1');
  assert.deepEqual(reads(), ['/api/cats/native-runtimes', '/api/cats/native-runtimes?refresh=1']);
  assert.equal(r.native.calls.some(c => c.method !== 'GET'), false, 'nothing is installed, logged in or called');
  assert.equal(defaultRuntime([]), undefined);
});

test('a cat needs only a name: the Agent, model and breed are native defaults, the portrait is a plain helper', async t => {
  const r = await setup(t);
  r.native.runtimes = [runtime('codex', 'openai', 'unknown'), runtime('claude', 'anthropic', 'configured')];
  const key = randomUUID();
  const made = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: key });
  assert.equal(made.status, 201);
  const sent = r.native.calls.find(c => c.path === '/api/bot-cat-templates/instantiate')!.body;
  assert.equal(sent.name, '团子'); assert.equal(sent.idempotencyKey, key);
  assert.deepEqual({ ...sent.catConfig, portrait: undefined }, { runtimeId: 'claude', breed: { mode: 'auto' }, model: { mode: 'inherit' }, effort: { mode: 'inherit' }, portrait: undefined });
  assert.match(sent.catConfig.portrait.roleDescription, /随叫随到/);
  assert.ok(sent.catConfig.portrait.personality && sent.catConfig.portrait.teamStrengths, 'the breed’s stock engineering portrait is not left to fill in');
  assert.equal(r.native.calls.some(c => c.path === '/api/cats' && c.method === 'POST'), false, 'one native creation, no second path');
  const item = (await (await r.call('/xbot-api/bots')).json()).bots[0];
  assert.equal(item.name, '团子'); assert.equal(item.avatar_seed, 'cat:ragdoll');
  // The same request again is the same cat.
  assert.equal((await (await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: key })).json()).native_id, item.native_id);
  assert.equal(r.native.cats.length, 1);

  // A chosen face is only the portrait; a line about the cat becomes its role and its short description.
  const about = '帮我管理每周的读书笔记，\n周五提醒我整理';
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '栗子', simple: { face: 'golden-chinchilla', about, agent: 'codex' }, idempotencyKey: randomUUID() })).status, 201);
  const second = r.native.calls.findLast(c => c.path === '/api/bot-cat-templates/instantiate')!.body.catConfig;
  assert.equal(second.runtimeId, 'codex'); assert.deepEqual(second.breed, { mode: 'auto' });
  assert.equal(second.portrait.roleDescription, about);
  assert.equal(second.portrait.teamStrengths, '帮我管理每周的读书笔记， 周五提醒我整理');
  const chestnut = (await (await r.call('/xbot-api/bots')).json()).bots.find((b: any) => b.name === '栗子');
  assert.equal(chestnut.avatar_seed, 'cat:golden-chinchilla'); assert.equal(chestnut.templateId, 'maine-coon');
});

test('quick creation refuses what it cannot do truthfully', async t => {
  const r = await setup(t), key = randomUUID();
  const post = async (body: unknown) => { const res = await r.call('/xbot-api/bots', 'POST', body); return [res.status, (await res.json()).error] as const; };
  r.native.runtimes = [runtime('codex', 'openai', 'login_required'), runtime('claude', 'anthropic', 'not_installed')];
  const [status, error] = await post({ name: '团子', simple: {}, idempotencyKey: key });
  assert.equal(status, 422); assert.match(error, /Claude Code 或 Codex/);
  assert.deepEqual(await post({ name: '团子', simple: { agent: 'codex' }, idempotencyKey: key }), [422, '请先在本机 Agent 中完成登录']);
  assert.equal((await post({ name: '团子', simple: { agent: 'nope' }, idempotencyKey: key }))[0], 422);
  r.native.runtimes = [runtime('codex', 'openai', 'configured')];
  assert.equal((await post({ name: '团子', simple: {} }))[0], 400, 'a retry must be recognisable');
  assert.equal((await post({ name: '团子', simple: { face: 'tiger' }, idempotencyKey: key }))[0], 400);
  for (const mixed of [{ runtimeId: 'codex' }, { templateId: 'ragdoll' }, { persona: 'x' }, { description: 'x' },
    { catConfig: { runtimeId: 'codex', breed: { mode: 'auto' }, model: { mode: 'inherit' }, effort: { mode: 'inherit' }, portrait: { roleDescription: 'x' } } }])
    assert.equal((await post({ name: '团子', simple: {}, idempotencyKey: key, ...mixed }))[0], 400, JSON.stringify(mixed));
  assert.equal(r.native.cats.length, 0);
  assert.equal(r.native.calls.some(c => c.path === '/api/bot-cat-templates/instantiate'), false);
});

test('a group can be made from its members alone and is then called after them', async t => {
  const r = await setup(t);
  for (const name of ['小团', '快手', '年糕']) await r.bridge.createBot({ name });
  const made = await r.call('/xbot-api/groups', 'POST', { members: ['小团', '快手'] });
  assert.equal(made.status, 201);
  const group = await made.json();
  assert.equal(group.name, '小团、快手'); assert.deepEqual(group.members, ['小团', '快手']);
  assert.equal(r.native.calls.findLast(c => c.path === '/api/threads' && c.method === 'POST')!.body.title, '小团、快手');
  // A given name is free text (a native thread title), and renaming takes the same.
  const named = await (await r.call('/xbot-api/groups', 'POST', { name: '周五读书会（试行）', members: ['小团', '年糕'] })).json();
  assert.equal(named.name, '周五读书会（试行）');
  assert.equal((await r.call(`/xbot-api/groups/${named.id}`, 'PATCH', { name: '读书会 · 第 2 期' })).status, 200);
  assert.equal(r.native.threads.get(named.id)!.title, '读书会 · 第 2 期');
  for (const name of ['', '   ', '<b>群</b>', 'x'.repeat(65)]) assert.equal((await r.call('/xbot-api/groups', 'POST', { name, members: ['小团', '快手'] })).status, 400, JSON.stringify(name));
  // Without members the same route still makes a sidebar folder, which keeps the stricter name.
  assert.equal((await r.call('/xbot-api/groups', 'POST', { name: '工作' })).status, 200);
  assert.equal((await r.call('/xbot-api/groups', 'POST', { name: '工作（旧）' })).status, 400);
  assert.equal((await r.call('/xbot-api/groups', 'POST', {})).status, 400);
  assert.equal((await r.call('/xbot-api/groups/' + encodeURIComponent('工作'), 'PATCH', { name: '工作（旧）' })).status, 400);
  assert.deepEqual(r.store.state.folders, ['工作']);
});
