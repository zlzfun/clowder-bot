import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { NativeFixture } from './native-fixture.js';
import { defaultRuntime } from '../server/native/agents.js';
import type { NativeRuntime } from '../server/native/bridge.js';
import type { NativeCat } from '../server/native/types.js';

// The unpatched native member creation as the adapter sees it: POST /api/cats
// with native's own creation identity (journey + key). The same key with the
// same body returns the member made before; with another body it is refused.
class StartNative extends NativeFixture {
  receipts = new Map<string, { payload: string; id: string }>();
  override async request<T>(path: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<T> {
    // Without a creation identity native creates plainly, as the base fixture does.
    if (path !== '/api/cats' || options.method !== 'POST' || !options.headers) return super.request(path, options);
    this.calls.push({ path, method: 'POST', body: { ...options.body, headers: options.headers } });
    if (this.fail) throw this.fail;
    const key = options.headers?.['idempotency-key'], journey = options.headers?.['x-cat-cafe-onboarding-journey'], payload = JSON.stringify(options.body);
    if (!key || !journey || !key.startsWith(`onboarding:${journey}:cat:`)) throw new ApiError(409, 'Invalid member creation request identity', { code: 'member_creation_conflict' });
    const receipt = this.receipts.get(key);
    if (receipt) {
      if (receipt.payload !== payload) throw new ApiError(409, 'This creation request already belongs to a different configuration', { code: 'member_creation_conflict' });
      return { cat: structuredClone(this.cats.find(cat => cat.id === receipt.id)) } as T;
    }
    if (this.cats.some(cat => cat.id === options.body.catId)) throw new ApiError(409, 'Member ID is occupied', { code: 'member_creation_conflict' });
    const cat = { ...options.body, id: options.body.catId, breedId: options.body.catId, configurationRevision: 'r1' } as NativeCat;
    this.cats.push(cat); this.receipts.set(key, { payload, id: cat.id });
    return { cat: structuredClone(cat) } as T;
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

test('a cat needs only a name: one unpatched native creation with the Agent’s own defaults and a plain helper portrait', async t => {
  const r = await setup(t);
  r.native.runtimes = [runtime('codex', 'openai', 'unknown'), runtime('claude', 'anthropic', 'configured')];
  const key = randomUUID(), creations = () => r.native.calls.filter(c => c.path === '/api/cats' && c.method === 'POST');
  const made = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: key });
  assert.equal(made.status, 201);
  const sent = creations()[0]!.body;
  assert.deepEqual(sent.headers, { 'x-cat-cafe-onboarding-journey': 'clowder-bot-simple', 'idempotency-key': 'onboarding:clowder-bot-simple:cat:' + key });
  assert.match(sent.catId, /^bot-[0-9a-f]{24}$/);
  assert.deepEqual([sent.name, sent.displayName, sent.clientId, sent.configurationSource, sent.defaultModel], ['团子', '团子', 'anthropic', 'native_tool', ''],
    'the logged-in Agent, its own model: nothing is chosen for it');
  assert.deepEqual(sent.mentionPatterns, ['@团子', '@' + sent.catId]);
  assert.match(sent.roleDescription, /随叫随到/);
  assert.ok(sent.personality && sent.teamStrengths, 'a stock engineering portrait is not left to fill in');
  for (const field of ['breedId', 'cli', 'accountRef', 'carrier', 'provider']) assert.equal(field in sent, false, field);
  assert.equal(r.native.calls.some(c => c.path.startsWith('/api/bot-cat-templates')), false, 'not the locally patched template route');
  const item = (await (await r.call('/xbot-api/bots')).json()).bots[0];
  assert.deepEqual([item.name, item.avatar_seed, item.templateId, item.native_id], ['团子', 'cat:ragdoll', 'ragdoll', sent.catId]);

  // The same request again is the same cat, even if the tools look different by then.
  r.native.runtimes = [runtime('codex', 'openai', 'configured'), runtime('claude', 'anthropic', 'login_required')];
  const again = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: key });
  assert.equal(again.status, 201);
  assert.equal((await again.json()).native_id, sent.catId);
  assert.deepEqual({ ...creations()[1]!.body }, { ...sent }, 'byte-for-byte the first request, so native replays it');
  assert.equal(r.native.cats.length, 1);
  // Another request under the same key is native's to refuse; a second cat of the same name is refused before asking.
  const other = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: { about: '别的用途' }, idempotencyKey: key });
  assert.equal(other.status, 409); assert.match((await other.json()).native.code, /member_creation_conflict/);
  const twin = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: randomUUID() });
  assert.equal(twin.status, 409); assert.match((await twin.json()).error, /已经有一只叫这个名字/);
  assert.equal(r.native.cats.length, 1);

  // A chosen face is the portrait and its colour; a line about the cat becomes its role and short description.
  const about = '帮我管理每周的读书笔记，\n周五提醒我整理';
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '栗子', simple: { face: 'golden-chinchilla', about, agent: 'codex' }, idempotencyKey: randomUUID() })).status, 201);
  const second = creations().at(-1)!.body;
  assert.equal(second.clientId, 'openai');
  assert.equal(second.roleDescription, about);
  assert.equal(second.teamStrengths, '帮我管理每周的读书笔记， 周五提醒我整理');
  const chestnut = (await (await r.call('/xbot-api/bots')).json()).bots.find((b: any) => b.name === '栗子');
  assert.deepEqual([chestnut.avatar_seed, chestnut.templateId], ['cat:golden-chinchilla', 'golden-chinchilla']);
  // Without a chosen face a Codex cat gets the face that goes with it.
  await r.call('/xbot-api/bots', 'POST', { name: '年糕', simple: { agent: 'codex' }, idempotencyKey: randomUUID() });
  assert.equal((await (await r.call('/xbot-api/bots')).json()).bots.find((b: any) => b.name === '年糕').avatar_seed, 'cat:maine-coon');
});

test('quick creation refuses what it cannot do truthfully', async t => {
  const r = await setup(t), key = randomUUID();
  const post = async (body: unknown) => { const res = await r.call('/xbot-api/bots', 'POST', body); return [res.status, (await res.json()).error] as const; };
  r.native.runtimes = [runtime('codex', 'openai', 'login_required'), runtime('claude', 'anthropic', 'not_installed')];
  const [status, error] = await post({ name: '团子', simple: {}, idempotencyKey: key });
  assert.equal(status, 422); assert.match(error, /Claude Code 或 Codex/);
  assert.deepEqual(await post({ name: '团子', simple: { agent: 'codex' }, idempotencyKey: key }), [422, 'Codex 还没有登录，登录后再试。']);
  assert.equal((await post({ name: '团子', simple: { agent: 'nope' }, idempotencyKey: key }))[0], 422);
  r.native.runtimes = [runtime('codex', 'openai', 'configured')];
  assert.equal((await post({ name: '团子', simple: {} }))[0], 400, 'a retry must be recognisable');
  assert.equal((await post({ name: '团子', simple: { face: 'tiger' }, idempotencyKey: key }))[0], 400);
  for (const mixed of [{ runtimeId: 'codex' }, { templateId: 'ragdoll' }, { persona: 'x' }, { description: 'x' },
    { catConfig: { runtimeId: 'codex', breed: { mode: 'auto' }, model: { mode: 'inherit' }, effort: { mode: 'inherit' }, portrait: { roleDescription: 'x' } } }])
    assert.equal((await post({ name: '团子', simple: {}, idempotencyKey: key, ...mixed }))[0], 400, JSON.stringify(mixed));
  assert.equal(r.native.cats.length, 0);
  assert.equal(r.native.calls.some(c => c.path === '/api/cats' && c.method === 'POST'), false);
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
