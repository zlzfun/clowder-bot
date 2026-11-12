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
  /** How many member edits native refuses next (a revision that moved, a write that did not go through). */
  refuseEdits = 0;
  override async request<T>(path: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<T> {
    if (options.method === 'PATCH' && path.startsWith('/api/cats/') && this.refuseEdits > 0) {
      this.refuseEdits--; this.calls.push({ path, method: 'PATCH', body: options.body });
      throw new ApiError(409, 'Member configuration changed', { code: 'revision_conflict' });
    }
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
const startingArgs = ['--settings', '{"skillOverrides":{"schedule":"off","loop":"off"}}', '--disallowedTools', 'RemoteTrigger,CronCreate,CronDelete,CronList'];
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
  // `faces` (what each face is like) has its own test below.
  const start = async (query = '') => { const { checkedAt, faces, ...rest } = await (await r.call('/xbot-api/start' + query)).json(); assert.equal(typeof checkedAt, 'number'); assert.ok(Array.isArray(faces)); return rest; };
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

test('the first screen says what each face is like, from the engine’s own templates', async t => {
  const r = await setup(t);
  r.native.runtimes = [runtime('codex', 'openai', 'configured')];
  const { faces } = await (await r.call('/xbot-api/start')).json();
  assert.deepEqual(faces.map((face: any) => face.id), ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla']);
  const { rev, ...coon } = faces[1];
  assert.deepEqual(coon, { id: 'maine-coon', name: '缅因猫', nickname: '砚砚', role: '代码审查专家，擅长安全分析、测试覆盖和代码质量把控', personality: '严谨认真，注重细节，会直言不讳地指出问题', strengths: 'Review、找 bug、coding 落地',
    tool: { label: 'Codex', state: 'ready', usable: true, id: 'codex' } });
  assert.match(rev, /^[0-9a-f]{16}$/); assert.equal(new Set(faces.map((face: any) => face.rev)).size, 8, 'each portrait has its own');
  // A template the engine does not have is not offered; nor is one without its colour pair, which a creation would refuse. Long or multi-line text is one clipped line.
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options?: any) => path !== '/api/cat-templates' ? request(path, options)
    : { templates: [{ id: 'ragdoll', name: '布偶猫', roleDescription: '第一行\n第二行' + '长'.repeat(200), color: { primary: '#888888', secondary: '#eeeeee' } }, { id: 'unknown-breed', name: '别的', roleDescription: 'x', color: {} }, { id: 'maine-coon', name: '缅因猫', roleDescription: '没有颜色', color: { primary: '#111111' } }], clientDefaults: {} }) as typeof r.native.request;
  const some = (await (await r.call('/xbot-api/start')).json()).faces;
  assert.deepEqual(some.map((face: any) => face.id), ['ragdoll']);
  assert.equal(some[0].role.length, 120); assert.ok(some[0].role.startsWith('第一行 第二行')); assert.equal('personality' in some[0], false);
  // Upstream serves its template file unchecked: an entry that is not an object, has no id or a field of the wrong type is left out or read without that field.
  r.native.request = (async (path: string, options?: any) => path !== '/api/cat-templates' ? request(path, options)
    : { templates: [null, 'junk', { name: 'no id' }, { id: 'maine-coon', name: '缅因猫', nickname: 9, roleDescription: '审查', personality: 7, teamStrengths: ['x'], color: { primary: '#111111', secondary: '#222222' } }] }) as typeof r.native.request;
  const odd = (await (await r.call('/xbot-api/start')).json()).faces;
  assert.deepEqual(odd.map(({ rev, tool, ...face }: any) => face), [{ id: 'maine-coon', name: '缅因猫', role: '审查' }]);
  // …and a cat can still be made from it: the missing words are the plain helper's.
  const made = await r.call('/xbot-api/bots', 'POST', { name: '小审', simple: { face: 'maine-coon', rev: odd[0].rev }, idempotencyKey: randomUUID() });
  assert.equal(made.status, 201);
  const body = r.native.calls.findLast(c => c.path === '/api/cats' && c.method === 'POST')!.body;
  assert.equal(body.roleDescription, '审查'); assert.match(body.personality, /亲切耐心/);
  for (const shape of [null, {}, { templates: 'nope' }]) {
    r.native.request = (async (path: string, options?: any) => path !== '/api/cat-templates' ? request(path, options) : shape) as typeof r.native.request;
    assert.deepEqual((await (await r.call('/xbot-api/start')).json()).faces, [], JSON.stringify(shape));
  }
  // The first screen still answers when the templates cannot be read: it only loses the descriptions.
  r.native.request = (async (path: string, options?: any) => { if (path === '/api/cat-templates') throw new ApiError(503, 'down'); return request(path, options); }) as typeof r.native.request;
  const without = await r.call('/xbot-api/start');
  assert.equal(without.status, 200); assert.deepEqual((await without.json()).faces, []);
});

test('a cat needs only a name: one unpatched native creation with the Agent’s own defaults and the portrait of the face’s template', async t => {
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
  // Picking a face picks that cat: the engine's template of the same id (here the Claude default, 布偶猫) gives the portrait, as written upstream.
  assert.deepEqual([sent.roleDescription, sent.personality, sent.teamStrengths], ['主架构师和核心开发者，擅长深度思考和系统设计', '温柔但有主见，喜欢深入分析问题，写代码快但注重质量', '架构设计、写代码一把好手']);
  for (const field of ['breedId', 'cli', 'accountRef', 'carrier', 'provider']) assert.equal(field in sent, false, field);
  // A Claude Code cat starts with the CLI's own schedulers off (memberCliArgs). The creation request never carries
  // them — it must stay what native recorded for its key — they are written as a second native step.
  assert.equal('cliConfigArgs' in sent, false);
  const edits = () => r.native.calls.filter(c => c.method === 'PATCH' && c.path === '/api/cats/' + sent.catId);
  assert.deepEqual(edits().map(c => c.body), [{ expectedRevision: 'r1', cliConfigArgs: startingArgs }]);
  assert.deepEqual(r.native.cats[0]!.cliConfigArgs, startingArgs);
  assert.equal('notice' in await made.json(), false);
  assert.equal(r.native.calls.some(c => c.path.startsWith('/api/bot-cat-templates')), false, 'not the locally patched template route');
  const item = (await (await r.call('/xbot-api/bots')).json()).bots[0];
  assert.deepEqual([item.name, item.avatar_seed, item.templateId, item.native_id], ['团子', 'cat:ragdoll', 'ragdoll', sent.catId]);
  // The face's native colour pair travels with the cat for a quiet accent; anything that is not a colour does not.
  assert.deepEqual(item.accent, { primary: '#888888', secondary: '#eeeeee' });
  r.native.cats[0]!.color = { primary: 'red; background:url(x)', secondary: '#eeeeee' };
  assert.equal('accent' in (await (await r.call('/xbot-api/bots')).json()).bots[0], false);
  r.native.cats[0]!.color = { primary: '#888888', secondary: '#eeeeee' };
  assert.match((await (await r.call('/xbot-api/session')).json()).version, /^\d+\.\d+\.\d+$/);

  // The same request again is the same cat, even if the tools look different by then.
  r.native.runtimes = [runtime('codex', 'openai', 'configured'), runtime('claude', 'anthropic', 'login_required')];
  const again = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: key });
  assert.equal(again.status, 201);
  assert.equal((await again.json()).native_id, sent.catId);
  assert.deepEqual({ ...creations()[1]!.body }, { ...sent }, 'byte-for-byte the first request, so native replays it');
  assert.equal(r.native.cats.length, 1);
  assert.equal(edits().length, 1, 'the cat already has its arguments: nothing is written again');
  // Another request under the key that made this cat is not a repeat of it — a changed tool included — and is refused without asking native again;
  // a second cat of the same name is refused before asking.
  for (const simple of [{ about: '别的用途' }, { agent: 'codex' }, { agent: 'nope' }, { face: 'maine-coon' }]) {
    const other = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple, idempotencyKey: key });
    assert.equal(other.status, 409, JSON.stringify(simple)); assert.match((await other.json()).error, /和上一次的内容不一样/);
  }
  assert.equal(creations().length, 2);
  const twin = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: randomUUID() });
  assert.equal(twin.status, 409); assert.match((await twin.json()).error, /已经有一只叫这个名字/);
  assert.equal(r.native.cats.length, 1);

  // A chosen face is that cat: its portrait and its own tool (缅因猫 thinks with Codex), whatever the usual tool here is.
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '花花', simple: { face: 'maine-coon' }, idempotencyKey: randomUUID() })).status, 201);
  assert.deepEqual([creations().at(-1)!.body.clientId, creations().at(-1)!.body.roleDescription, creations().at(-1)!.body.personality],
    ['openai', '代码审查专家，擅长安全分析、测试覆盖和代码质量把控', '严谨认真，注重细节，会直言不讳地指出问题']);
  // Custom: the face only gives the looks. Without words of the owner's own it is a plain helper; with them, theirs.
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '白板', simple: { face: 'maine-coon', custom: true, agent: 'codex' }, idempotencyKey: randomUUID() })).status, 201);
  const plain = creations().at(-1)!.body;
  assert.match(plain.roleDescription, /随叫随到/); assert.ok(plain.personality && plain.teamStrengths, 'a stock portrait is not left for native to fill in');
  assert.doesNotMatch(plain.roleDescription + plain.personality, /代码审查|严谨认真/);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '小诗', simple: { face: 'bengal', custom: true, about: '陪我写诗', personality: '话少，爱用比喻', agent: 'codex' }, idempotencyKey: randomUUID() })).status, 201);
  assert.deepEqual([creations().at(-1)!.body.roleDescription, creations().at(-1)!.body.personality, creations().at(-1)!.body.teamStrengths], ['陪我写诗', '话少，爱用比喻', '陪我写诗']);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '错', simple: { custom: false }, idempotencyKey: randomUUID() })).status, 400);
  // Words of the owner's own make it custom even without the flag (a line about the cat becomes its role and short description).
  const about = '帮我管理每周的读书笔记，\n周五提醒我整理';
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '栗子', simple: { face: 'golden-chinchilla', about, agent: 'codex' }, idempotencyKey: randomUUID() })).status, 201);
  const second = creations().at(-1)!.body;
  assert.equal(second.clientId, 'openai'); assert.equal('cliConfigArgs' in second, false);
  assert.equal(r.native.calls.some(c => c.method === 'PATCH' && c.path === '/api/cats/' + second.catId), false, 'a Codex cat has no arguments to add');
  assert.equal(second.roleDescription, about);
  assert.equal(second.teamStrengths, '帮我管理每周的读书笔记， 周五提醒我整理');
  assert.match(second.personality, /亲切耐心/, 'not the template’s personality');
  const chestnut = (await (await r.call('/xbot-api/bots')).json()).bots.find((b: any) => b.name === '栗子');
  assert.deepEqual([chestnut.avatar_seed, chestnut.templateId], ['cat:golden-chinchilla', 'golden-chinchilla']);
  // Without a chosen face, asking for Codex gets the cat that thinks with Codex.
  await r.call('/xbot-api/bots', 'POST', { name: '年糕', simple: { agent: 'codex' }, idempotencyKey: randomUUID() });
  assert.equal((await (await r.call('/xbot-api/bots')).json()).bots.find((b: any) => b.name === '年糕').avatar_seed, 'cat:maine-coon');
  assert.equal(creations().at(-1)!.body.roleDescription, '代码审查专家，擅长安全分析、测试覆盖和代码质量把控');
});

test('a face is a cat with its own tool: without that tool here the cat cannot be made as it is', async t => {
  const r = await setup(t);
  const creations = () => r.native.calls.filter(c => c.path === '/api/cats' && c.method === 'POST');
  const tools = async () => Object.fromEntries((await (await r.call('/xbot-api/start')).json()).faces.map((face: any) => [face.id, face.tool]));
  const post = async (name: string, simple: unknown) => { const res = await r.call('/xbot-api/bots', 'POST', { name, simple, idempotencyKey: randomUUID() }); const said = await res.json(); return [res.status, said.code, said.error] as const; };
  // What the engine's detection lists on a machine with Claude Code and Codex (ids and labels as the pinned engine gives them).
  r.native.runtimes = [runtime('codex', 'openai', 'configured'), runtime('claude', 'anthropic', 'unknown'), runtime('kimi', 'kimi', 'not_installed', { label: 'Kimi' }),
    runtime('dsh', 'acp', 'not_installed', { label: 'DSH', acp: {} }), runtime('agy-native', 'google', 'configured', { label: 'AGY Native', agyCarrier: 'native' }), runtime('agy-acp', 'google', 'not_installed', { label: 'AGY 官方 ACP' })];
  assert.deepEqual(await tools(), {
    ragdoll: { label: 'Claude Code', state: 'unknown', usable: true, id: 'claude' },            // installed, login not confirmed: worth trying
    'maine-coon': { label: 'Codex', state: 'ready', usable: true, id: 'codex' },
    siamese: { label: 'AGY Native', state: 'unsupported', usable: false, reason: '这个应用还接不上 AGY Native' },   // installed and logged in, but not a kind the app can connect
    'turkish-van': { label: 'Kimi', state: 'missing', usable: false, reason: '这台电脑上还没有装 Kimi' },
    dsh: { label: 'DSH', state: 'unsupported', usable: false, reason: '这个应用还接不上 DSH' },                    // said before "not installed": installing would not help
    'dragon-li': { label: 'OpenCode', state: 'unsupported', usable: false, reason: '这个应用还接不上 OpenCode' },    // the engine's detection does not list it at all
    bengal: { label: 'Antigravity', state: 'unsupported', usable: false, reason: '这个应用还接不上 Antigravity' },
    'golden-chinchilla': { label: 'OpenCode', state: 'unsupported', usable: false, reason: '这个应用还接不上 OpenCode' },
  });
  // The cat is made with its own tool, not the usual one (Codex here), and no other tool can be picked for it.
  assert.deepEqual((await post('宪宪', { face: 'ragdoll' })).slice(0, 2), [201, undefined]);
  assert.equal(creations().at(-1)!.body.clientId, 'anthropic');
  assert.deepEqual(await post('宪宪二', { face: 'ragdoll', agent: 'codex' }), [422, 'face_tool', '这只猫猫用 Claude Code 来思考，不能另选；想自己选，请用「自定义」。']);
  assert.deepEqual((await post('宪宪三', { face: 'ragdoll', agent: 'claude' })).slice(0, 2), [201, undefined], 'naming its own tool is not a different request');
  // Its tool is not here, or cannot be connected: refused before the engine is asked, with what would help.
  const before = creations().length;
  assert.deepEqual(await post('墨墨', { face: 'turkish-van' }), [422, 'face_unavailable', '这台电脑上还没有装 Kimi，所以这只猫猫现在领不了。装好并登录后再试，或者改用「自定义」，只借它的长相。']);
  assert.deepEqual(await post('烁烁', { face: 'siamese' }), [422, 'face_unavailable', '这个应用还接不上 AGY Native，所以这只猫猫现在领不了。可以改用「自定义」，只借它的长相。']);
  assert.deepEqual(await post('金哥', { face: 'golden-chinchilla' }), [422, 'face_unavailable', '这个应用还接不上 OpenCode，所以这只猫猫现在领不了。可以改用「自定义」，只借它的长相。']);
  assert.equal(creations().length, before);
  // Custom borrows only the looks, so any face goes with a tool that is here: the one picked, or the usual one.
  assert.deepEqual((await post('小暹', { face: 'siamese', custom: true })).slice(0, 2), [201, undefined]);
  assert.match(creations().at(-1)!.body.roleDescription, /随叫随到/); assert.equal(creations().at(-1)!.body.clientId, 'openai');
  assert.deepEqual((await post('小金', { face: 'golden-chinchilla', custom: true, agent: 'claude' })).slice(0, 2), [201, undefined]);
  assert.equal(creations().at(-1)!.body.clientId, 'anthropic');
  // Needs a login: says so, and nothing about custom (the same tool would be needed).
  r.native.runtimes = [runtime('codex', 'openai', 'login_required'), runtime('claude', 'anthropic', 'configured')];
  assert.deepEqual((await tools())['maine-coon'], { label: 'Codex', state: 'login', usable: false, reason: 'Codex 还没有登录', loginCommand: 'codex login' });
  assert.deepEqual(await post('砚砚', { face: 'maine-coon' }), [422, 'face_unavailable', 'Codex 还没有登录，登录后再试。']);
  // Kimi installed: 梵花猫's cat can be made, on Kimi.
  r.native.runtimes = [runtime('claude', 'anthropic', 'configured'), runtime('kimi', 'kimi', 'configured', { label: 'Kimi' })];
  assert.deepEqual((await tools())['turkish-van'], { label: 'Kimi', state: 'ready', usable: true, id: 'kimi' });
  assert.deepEqual((await post('墨墨', { face: 'turkish-van' })).slice(0, 2), [201, undefined]);
  assert.equal(creations().at(-1)!.body.clientId, 'kimi');
});

test('the cat that is made is the one that was described, and a repeat reaches native exactly as the first time', async t => {
  const r = await setup(t);
  r.native.runtimes = [runtime('codex', 'openai', 'configured')];
  const creations = () => r.native.calls.filter(c => c.path === '/api/cats' && c.method === 'POST');
  const faces = (await (await r.call('/xbot-api/start')).json()).faces, coon = faces.find((face: any) => face.id === 'maine-coon');
  const request = r.native.request.bind(r.native);
  const rewrite = (personality: string) => {
    r.native.request = (async (path: string, options?: any) => {
      const result: any = await request(path, options);
      return path === '/api/cat-templates' ? { ...result, templates: result.templates.map((t: any) => t.id === 'maine-coon' ? { ...t, personality } : t) } : result;
    }) as typeof r.native.request;
  };
  // The answer of the first attempt is lost; meanwhile the engine's template is edited. The repeat is the same request,
  // so it is replayed as it was first resolved — native sees the identical body and returns the cat it made.
  const key = randomUUID(), ask = { name: '砚砚', simple: { face: 'maine-coon', rev: coon.rev }, idempotencyKey: key };
  assert.equal((await r.call('/xbot-api/bots', 'POST', ask)).status, 201);
  rewrite('换了一种脾气');
  const again = await r.call('/xbot-api/bots', 'POST', ask);
  assert.equal(again.status, 201);
  assert.deepEqual({ ...creations()[1]!.body }, { ...creations()[0]!.body }, 'identical, though the template changed in between');
  assert.equal(creations()[1]!.body.personality, '严谨认真，注重细节，会直言不讳地指出问题');
  assert.equal(r.native.cats.length, 1);
  // A new request that still carries the portrait the screen showed earlier is not created as something else: it is refused by code, before native is asked.
  const stale = await r.call('/xbot-api/bots', 'POST', { name: '小审', simple: { face: 'maine-coon', rev: coon.rev }, idempotencyKey: randomUUID() });
  assert.equal(stale.status, 409);
  assert.deepEqual([(await stale.json()).code, creations().length, r.native.cats.length], ['face_changed', 2, 1]);
  // With the portrait as it is now (a fresh /start) it goes through, and gets the new words.
  const fresh = (await (await r.call('/xbot-api/start')).json()).faces.find((face: any) => face.id === 'maine-coon');
  assert.notEqual(fresh.rev, coon.rev); assert.equal(fresh.personality, '换了一种脾气');
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '小审', simple: { face: 'maine-coon', rev: fresh.rev }, idempotencyKey: randomUUID() })).status, 201);
  assert.equal(creations().at(-1)!.body.personality, '换了一种脾气');
  // A custom cat does not depend on the portrait; without `rev` the current template is used.
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '自己的', simple: { face: 'maine-coon', rev: coon.rev, custom: true }, idempotencyKey: randomUUID() })).status, 201);
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '不带', simple: { face: 'maine-coon' }, idempotencyKey: randomUUID() })).status, 201);
  // The templates cannot be read: nothing is asked of native, and the refusal says by code that nothing was created — custom or not.
  r.native.request = (async (path: string, options?: any) => { if (path === '/api/cat-templates') throw new ApiError(503, 'down'); return request(path, options); }) as typeof r.native.request;
  const before = creations().length;
  for (const simple of [{ face: 'maine-coon' }, { face: 'ragdoll', custom: true, about: '陪我聊天' }]) {
    const down = await r.call('/xbot-api/bots', 'POST', { name: '等等', simple, idempotencyKey: randomUUID() });
    assert.equal(down.status, 503);
    const said = await down.json();
    assert.equal(said.code, 'faces_unavailable'); assert.match(said.error, /没有创建/);
  }
  assert.equal(creations().length, before);
});

test('a repeat is answered by what is known: the cat that exists, or the tools as they are now', async t => {
  const r = await setup(t);
  const creations = () => r.native.calls.filter(c => c.path === '/api/cats' && c.method === 'POST');
  const post = async (name: string, simple: unknown, key: string) => { const res = await r.call('/xbot-api/bots', 'POST', { name, simple, idempotencyKey: key }); const said = await res.json(); return [res.status, said.code ?? said.native_id, said.error] as const; };
  // The adapter restarts: what it kept about requests is gone, the cats and the presentation data are not.
  const restart = () => { (r.bridge as any).simpleRequests.clear(); };
  const request = r.native.request.bind(r.native);
  r.native.runtimes = [runtime('codex', 'openai', 'configured'), runtime('claude', 'anthropic', 'configured')];

  // After a restart the cat this key made is the answer, even though the engine's template and the tools have changed since:
  // creation is not asked again, and nothing says "not created" or "changed".
  const key = randomUUID(), faces = (await (await r.call('/xbot-api/start')).json()).faces, rag = faces[0];
  const [, id] = await post('宪宪', { face: 'ragdoll', rev: rag.rev }, key);
  restart();
  r.native.request = (async (path: string, options?: any) => { if (path === '/api/cat-templates') throw new ApiError(503, 'down'); return request(path, options); }) as typeof r.native.request;
  r.native.runtimes = [runtime('codex', 'openai', 'configured'), runtime('claude', 'anthropic', 'not_installed')];
  assert.deepEqual((await post('宪宪', { face: 'ragdoll', rev: rag.rev }, key)).slice(0, 2), [201, id]);
  assert.deepEqual((await post('宪宪', { face: 'ragdoll', rev: rag.rev, agent: 'claude' }, key)).slice(0, 2), [201, id], 'naming its own tool describes the same cat');
  assert.equal(creations().length, 1);
  // …but a request that describes another cat is not a repeat: another name, face, tool, or words of the owner's own.
  for (const [name, simple] of [['宪宪二', { face: 'ragdoll' }], ['宪宪', { face: 'maine-coon' }], ['宪宪', { face: 'ragdoll', agent: 'codex' }], ['宪宪', { face: 'ragdoll', agent: 'nope' }],
    ['宪宪', { face: 'ragdoll', custom: true }], ['宪宪', { face: 'ragdoll', about: '陪我聊天' }], ['宪宪', { face: 'ragdoll', personality: '话少' }]] as const)
    assert.deepEqual((await post(name, simple, key)).slice(0, 2), [409, undefined], JSON.stringify([name, simple]));
  assert.equal(creations().length, 1); assert.equal(r.native.cats.length, 1);
  r.native.request = request;
  // A custom cat is recognised by the owner's own words.
  r.native.runtimes = [runtime('codex', 'openai', 'configured')];
  const own = randomUUID(), [, poet] = await post('小诗', { face: 'bengal', custom: true, about: '陪我写诗', agent: 'codex' }, own);
  restart();
  assert.deepEqual((await post('小诗', { face: 'bengal', custom: true, about: '陪我写诗', agent: 'codex' }, own)).slice(0, 2), [201, poet]);
  assert.deepEqual((await post('小诗', { face: 'bengal', custom: true, about: '陪我画画', agent: 'codex' }, own)).slice(0, 2), [409, undefined]);
  assert.deepEqual((await post('小诗', { face: 'bengal' }, own)).slice(0, 2), [409, undefined], 'the template cat of that face is another cat (and its tool is not this one)');

  // Nothing was made the first time (the creation itself did not get through) and the tool is gone since: the repeat is not sent as it was resolved.
  const unreachable = (down: boolean) => { r.native.request = (async (path: string, options?: any) => {
    if (down && path === '/api/cats' && options?.method === 'POST') { r.native.calls.push({ path, method: 'POST', body: { ...options.body, headers: options.headers } }); throw new ApiError(502, 'unreachable'); }
    return request(path, options); }) as typeof r.native.request; };
  const lost = randomUUID();
  unreachable(true);
  assert.equal((await post('砚砚', { face: 'maine-coon' }, lost))[0], 502);
  unreachable(false);
  r.native.runtimes = [runtime('codex', 'openai', 'not_installed'), runtime('claude', 'anthropic', 'configured')];
  const made = creations().length;
  assert.deepEqual(await post('砚砚', { face: 'maine-coon' }, lost), [422, 'face_unavailable', '这台电脑上还没有装 Codex，所以这只猫猫现在领不了。装好并登录后再试，或者改用「自定义」，只借它的长相。']);
  assert.equal(creations().length, made, 'nothing is made on a tool that is not here');
  // …and when the tool is still here, the repeat reaches native exactly as it was first resolved.
  r.native.runtimes = [runtime('codex', 'openai', 'configured')];
  const again = randomUUID();
  unreachable(true);
  assert.equal((await post('栗子', { face: 'maine-coon' }, again))[0], 502);
  unreachable(false);
  // (the engine's template is edited in between: the repeat still carries the words of the first attempt)
  r.native.request = (async (path: string, options?: any) => { const result: any = await request(path, options);
    return path === '/api/cat-templates' ? { ...result, templates: result.templates.map((t: any) => ({ ...t, personality: '换了' })) } : result; }) as typeof r.native.request;
  assert.equal((await post('栗子', { face: 'maine-coon' }, again))[0], 201);
  r.native.request = request;
  assert.deepEqual({ ...creations().at(-1)!.body }, { ...creations().at(-2)!.body });

  // The same request twice at once is resolved once: both reach native with the same words, though the tools changed in between.
  r.native.runtimes = [runtime('codex', 'openai', 'configured'), runtime('claude', 'anthropic', 'configured')];
  let release!: () => void; const held = new Promise<void>(done => { release = done; });
  r.native.request = (async (path: string, options?: any) => { if (path === '/api/cat-templates') await held; return request(path, options); }) as typeof r.native.request;
  const twin = randomUUID(), first = post('年糕', { custom: true }, twin);
  await new Promise(done => setTimeout(done, 20));
  r.native.runtimes = [runtime('claude', 'anthropic', 'configured'), runtime('codex', 'openai', 'configured')];   // the usual tool is now the other one
  const second = post('年糕', { custom: true }, twin);
  await new Promise(done => setTimeout(done, 20)); release();
  const both = await Promise.all([first, second]);
  assert.deepEqual(both.map(answer => answer[0]), [201, 201]); assert.equal(both[0][1], both[1][1]);
  assert.deepEqual(creations().slice(-2).map(c => c.body.clientId), ['openai', 'openai']);
  assert.equal(r.native.cats.filter(cat => cat.name === '年糕').length, 1);
});

test('a new cat whose starting arguments could not be written exists, and the answer says what is missing', async t => {
  const r = await setup(t);
  r.native.runtimes = [runtime('claude', 'anthropic', 'configured')];
  // The member was edited in between (its revision moved): the write is tried once more against the member as it is now.
  r.native.refuseEdits = 1;
  const moved = await r.call('/xbot-api/bots', 'POST', { name: '团子', simple: {}, idempotencyKey: randomUUID() });
  assert.equal(moved.status, 201); assert.equal('notice' in await moved.json(), false);
  assert.deepEqual(r.native.cats[0]!.cliConfigArgs, startingArgs);
  // It keeps failing: the cat is there and works, without the arguments, and the answer says so instead of looking complete.
  r.native.refuseEdits = 2;
  const missing = await r.call('/xbot-api/bots', 'POST', { name: '栗子', simple: {}, idempotencyKey: randomUUID() });
  assert.equal(missing.status, 201);
  const answer = await missing.json();
  assert.equal(answer.name, '栗子'); assert.match(answer.notice, /建好了.*提醒/);
  assert.equal(r.native.cats.length, 2); assert.equal('cliConfigArgs' in r.native.cats[1]!, false);
  // Arguments the owner gave the member since are never replaced, not even by a repeat of the creation.
  const key = randomUUID();
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '年糕', simple: {}, idempotencyKey: key })).status, 201);
  r.native.cats[2]!.cliConfigArgs = ['--own'];
  const edits = r.native.calls.filter(c => c.method === 'PATCH').length;
  assert.equal((await r.call('/xbot-api/bots', 'POST', { name: '年糕', simple: {}, idempotencyKey: key })).status, 201);
  assert.deepEqual(r.native.cats[2]!.cliConfigArgs, ['--own']);
  assert.equal(r.native.calls.filter(c => c.method === 'PATCH').length, edits);
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
  // The same request sent again (its answer got lost) is the same group, listed once.
  const key = randomUUID();
  const once = await (await r.call('/xbot-api/groups', 'POST', { members: ['快手', '年糕'], idempotencyKey: key })).json();
  const twice = await (await r.call('/xbot-api/groups', 'POST', { members: ['快手', '年糕'], idempotencyKey: key })).json();
  assert.equal(twice.id, once.id);
  assert.equal(r.store.state.groupThreadIds.filter(id => id === once.id).length, 1);
  assert.equal(r.native.calls.filter(c => c.path === '/api/threads' && c.method === 'POST' && c.body.idempotencyKey === key).length, 1, 'the creation is not replayed to native');
  // A late copy of that request must not undo a member change made since: native would apply its members again.
  assert.equal((await r.call(`/xbot-api/groups/${once.id}`, 'PATCH', { members: ['快手', '年糕', '小团'] })).status, 200);
  const late = await r.call('/xbot-api/groups', 'POST', { members: ['快手', '年糕'], idempotencyKey: key });
  assert.equal(late.status, 200);
  assert.deepEqual((await late.json()).members, ['快手', '年糕', '小团'], 'answered as the group is now');
  assert.equal(r.native.threads.get(once.id)!.preferredCats!.length, 3);
  assert.equal((await r.call('/xbot-api/groups', 'POST', { members: ['快手', '年糕'], idempotencyKey: 'not-a-uuid' })).status, 400);
  for (const name of ['', '   ', '<b>群</b>', 'x'.repeat(65)]) assert.equal((await r.call('/xbot-api/groups', 'POST', { name, members: ['小团', '快手'] })).status, 400, JSON.stringify(name));
  // Without members the same route still makes a sidebar folder, which keeps the stricter name.
  assert.equal((await r.call('/xbot-api/groups', 'POST', { name: '工作' })).status, 200);
  assert.equal((await r.call('/xbot-api/groups', 'POST', { name: '工作（旧）' })).status, 400);
  assert.equal((await r.call('/xbot-api/groups', 'POST', {})).status, 400);
  assert.equal((await r.call('/xbot-api/groups/' + encodeURIComponent('工作'), 'PATCH', { name: '工作（旧）' })).status, 400);
  assert.deepEqual(r.store.state.folders, ['工作']);
  assert.equal((await r.call('/xbot-api/groups/' + encodeURIComponent('工作'), 'PATCH', { add: ['小团'] })).status, 400, 'a folder has no members');
});

test('a group member edit says what was meant and is applied to the group as it is now', async t => {
  const r = await setup(t);
  r.native.runtimes = [runtime('codex', 'openai', 'configured')];
  for (const name of ['甲', '乙', '丙', '丁', '戊']) await r.call('/xbot-api/bots', 'POST', { name, simple: {}, idempotencyKey: randomUUID() });
  const group = await (await r.call('/xbot-api/groups', 'POST', { members: ['甲', '乙', '丙'] })).json();
  const edit = (body: unknown) => r.call(`/xbot-api/groups/${group.id}`, 'PATCH', body);
  const members = async () => (await (await r.call('/xbot-api/groups')).json()).groups.find((g: any) => g.id === group.id).members;
  // Another page added 丁 meanwhile. Taking 乙 out from a page that still shows 甲、乙、丙 must not take 丁 out with it.
  assert.equal((await edit({ add: ['丁'] })).status, 200);
  const removed = await edit({ remove: ['乙'] });
  assert.equal(removed.status, 200); assert.deepEqual((await removed.json()).members, ['甲', '丙', '丁']);
  // Two edits sent at the same moment both land: each works from what the one before left.
  const [one, two] = await Promise.all([edit({ add: ['乙'] }), edit({ add: ['戊'] })]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  assert.deepEqual((await members()).sort(), ['甲', '丙', '丁', '乙', '戊'].sort(), 'whichever arrived first');
  // Adding a cat that is already in, or removing one that is not, changes nothing and is not an error.
  assert.deepEqual((await (await edit({ add: ['甲'], remove: ['乙'] })).json()).members, ['甲', '丙', '丁', '戊']);
  assert.deepEqual((await (await edit({ remove: ['乙'] })).json()).members, ['甲', '丙', '丁', '戊']);
  // Limits and nonsense are refused before native is asked.
  assert.equal((await edit({ remove: ['甲', '丙', '丁'] })).status, 400, 'fewer than two would remain');
  assert.equal((await edit({ add: ['甲'], remove: ['甲'] })).status, 400);
  assert.equal((await edit({ members: ['甲', '丙'], add: ['乙'] })).status, 400, 'one way of editing at a time');
  assert.equal((await edit({ add: ['没有这只'] })).status, 404);
  assert.deepEqual(await members(), ['甲', '丙', '丁', '戊']);
  // A cat that still has work in the group is not taken out, whichever way the edit is written.
  const busy = r.native.cats.find(cat => cat.name === '丁')!;
  r.native.queues.set(group.id, { queue: [], activeInvocations: [{ catId: busy.id, invocationId: 'i1' }] } as never);
  const refused = await edit({ remove: ['丁'] });
  assert.equal(refused.status, 409); assert.match((await refused.json()).error, /还在这个群里处理事情/);
  assert.equal((await edit({ remove: ['戊'] })).status, 200, 'another cat can still leave');
  assert.deepEqual(await members(), ['甲', '丙', '丁']);
});
