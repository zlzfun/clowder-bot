import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { ChatPack, chatManner, chatPack, chatPackDefaults } from '../server/native/chat-pack.js';
import { NativeFixture } from './native-fixture.js';

// Talking the way a chat is talked in is the default for every cat and not a setting (owner, 2026-11-12):
// one engine pack (Clowder AI F129) kept installed through the engine's own unpatched routes.

async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-chat-pack-')), native = new NativeFixture();
  const runtime = createApp({ dataFile: join(dir, 'presentation.json'), native });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const say = async (name: string, text: string) => { const sent = await call(`/xbot-api/bots/${encodeURIComponent(name)}/messages`, 'POST', { text }); await sent.text(); return sent.status; };
  const packCalls = () => native.calls.filter(c => c.path.startsWith('/api/packs')).map(c => `${c.method} ${c.path}`);
  return { ...runtime, native, call, say, packCalls };
}
const installed = { name: chatPack.name, version: chatPack.version, description: chatPack.description, packType: 'style', behaviors: [chatManner] };
const quiet = (t: any) => { const lines: string[] = [], warn = console.warn; console.warn = (line: unknown) => { lines.push(String(line)); }; t.after(() => { console.warn = warn; }); return lines; };

test('before a cat is given something to answer the engine has the pack: once, from a directory that is gone again, and nothing is written into the cat', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), personality = cat.personality;
  assert.deepEqual(r.native.packs, []);
  assert.equal(await r.say('Ada', '在吗'), 200);
  assert.deepEqual(r.native.packs, [installed]);
  // Asked, installed, confirmed — and only then the message.
  const order = r.native.calls.map(c => `${c.method} ${c.path}`).filter(line => /\/api\/(packs|messages)/.test(line));
  assert.deepEqual(order, ['GET /api/packs', 'POST /api/packs/add', 'GET /api/packs', 'POST /api/messages']);
  const source = r.native.calls.find(c => c.path === '/api/packs/add')!.body.source;
  assert.equal(typeof source, 'string'); assert.equal(existsSync(source), false, 'the directory was written for this one request');
  // Later messages take it for granted; the cat's own record is as it was.
  for (const text of ['一', '二']) assert.equal(await r.say('Ada', text), 200);
  assert.equal(r.packCalls().length, 3);
  assert.equal(r.native.cats.find(known => known.id === cat.id)!.personality, personality);
  assert.equal(r.native.calls.some(c => c.method === 'PATCH' && c.path.startsWith('/api/cats/')), false);
  // The same holds for a group, and for several messages arriving together: one installation.
  const other = await setup(t); await other.bridge.createBot({ name: 'Ada' }); await other.bridge.createBot({ name: 'Bea' });
  assert.deepEqual(await Promise.all(['a', 'b', 'c'].map(text => other.say('Ada', text))), [200, 200, 200]);
  assert.equal(other.packCalls().filter(line => line === 'POST /api/packs/add').length, 1);
});

test('the first thing a cat says in a conversation is asked for with the pack in place too', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), route = '/xbot-api/bots/Ada';
  const page = await (await r.call(route + '/transcript')).json();
  assert.equal((await r.call(route + '/greeting', 'POST', { expectedThreadId: page.thread_id })).status < 300, true);
  const order = r.native.calls.map(c => `${c.method} ${c.path}`).filter(line => /\/api\/(packs\/add|messages)$/.test(line));
  assert.deepEqual(order, ['POST /api/packs/add', 'POST /api/messages']);
  assert.deepEqual(r.native.packs, [installed]); assert.ok(cat);
});

test('the pack is the engine’s record: asked again after a while, replaced when the sentence changed, put back when it is gone', async t => {
  const native = new NativeFixture(); let now = 1_000_000;
  const pack = new ChatPack(native, () => now), calls = () => native.calls.map(c => `${c.method} ${c.path}`);
  assert.equal(await pack.ensure(), true); assert.deepEqual(native.packs, [installed]);
  const first = calls().length;
  now += ChatPack.trust - 1; assert.equal(await pack.ensure(), true); assert.equal(calls().length, first, 'taken for granted for a while');
  now += 1; assert.equal(await pack.ensure(), true); assert.deepEqual(calls().slice(first), ['GET /api/packs'], 'then asked, and found');
  // An earlier wording of ours is replaced, not kept beside the new one.
  native.packs = [{ ...installed, version: '1.0.0-00000000', behaviors: ['以前的说法'] }]; now += ChatPack.trust;
  assert.equal(await pack.ensure(), true); assert.deepEqual(native.packs, [installed]);
  // The engine's store was emptied (another data directory, a reset): it is installed again.
  native.packs = []; now += ChatPack.trust;
  assert.equal(await pack.ensure(), true); assert.deepEqual(native.packs, [installed]);
  // Calls arriving together share one installation.
  const fresh = new NativeFixture(), shared = new ChatPack(fresh);
  assert.deepEqual(await Promise.all([shared.ensure(), shared.ensure(), shared.ensure()]), [true, true, true]);
  assert.equal(fresh.calls.filter(c => c.path === '/api/packs/add').length, 1);
});

test('a pack that cannot be installed never holds a message back, is tried again, and is said once', async t => {
  const lines = quiet(t), r = await setup(t); await r.bridge.createBot({ name: 'Ada' });
  const request = r.native.request.bind(r.native); let refuse: 'list' | 'add' | undefined = 'list';
  r.native.request = (async (path: string, options?: any) => {
    if (refuse === 'list' && path === '/api/packs') { r.native.calls.push({ path, method: 'GET' }); throw new ApiError(503, 'packs unavailable'); }
    if (refuse === 'add' && path === '/api/packs/add') { r.native.calls.push({ path, method: 'POST', body: options.body }); throw new ApiError(403, 'Pack security validation failed'); }
    return request(path, options);
  }) as typeof r.native.request;
  for (const text of ['一', '二']) assert.equal(await r.say('Ada', text), 200, 'the cat answers at more length; the chat goes on');
  assert.deepEqual(r.packCalls(), ['GET /api/packs', 'GET /api/packs'], 'asked again with the next message');
  refuse = 'add';
  assert.equal(await r.say('Ada', '三'), 200); assert.deepEqual(r.native.packs, []);
  const source = r.native.calls.findLast(c => c.path === '/api/packs/add')!.body.source;
  assert.equal(existsSync(source), false, 'a refused directory is removed as well');
  refuse = undefined;
  assert.equal(await r.say('Ada', '四'), 200); assert.deepEqual(r.native.packs, [installed]);
  assert.equal(lines.filter(line => /packs unavailable/.test(line)).length, 1, 'one line for two failed messages');
  assert.equal(lines.filter(line => /Pack security validation failed/.test(line)).length, 1);
});

test('the pinned engine applies the first pack it lists: another one is left alone, and that is said rather than assumed away', async t => {
  const lines = quiet(t), native = new NativeFixture(), pack = new ChatPack(native);
  const theirs = { name: 'another-pack', version: '2.0.0', description: '别人的', packType: 'domain', behaviors: ['别的默认行为'] };
  native.packs = [theirs];
  assert.equal(await pack.ensure(), false);
  assert.deepEqual(native.packs, [theirs, installed], 'ours is installed, theirs is neither removed nor reordered');
  assert.equal(await pack.ensure(), false);
  assert.equal(native.calls.filter(c => c.path === '/api/packs/add').length, 1, 'not installed over and over');
  assert.equal(native.calls.some(c => c.method === 'DELETE'), false);
  assert.deepEqual(lines, ['🐾 chat pack not installed: the engine applies another pack first (another-pack)']);
  // When ours is the first, it holds.
  native.packs = [installed, theirs];
  assert.equal(await pack.ensure(), true);
});

test('there is no switch: a cat’s profile does not say `concise`, and it cannot be set', async t => {
  const r = await setup(t); await r.bridge.createBot({ name: 'Ada' });
  const profile = await (await r.call('/xbot-api/bots/Ada')).json();
  assert.equal('concise' in profile, false);
  for (const concise of [true, false]) {
    const answer = await r.call('/xbot-api/bots/Ada', 'PATCH', { concise });
    assert.equal(answer.status, 400);
  }
  assert.equal(r.native.calls.some(c => c.method === 'PATCH'), false);
  assert.deepEqual(await (await r.call('/xbot-api/bots/Ada', 'PATCH', { description: '答疑' })).json(), { name: 'Ada' });
});

test('what is installed is a style pack with one overridable default for all cats, within what the pinned engine accepts and applies', t => {
  assert.match(chatPack.name, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  assert.ok(chatPack.version.length <= 20 && /^1\.0\.0-[0-9a-f]{8}$/.test(chatPack.version), 'the version carries the wording');
  assert.equal(chatPack.packType, 'style'); assert.ok(chatPack.description.length <= 500);
  assert.deepEqual(chatPackDefaults, { behaviors: [{ id: 'chat-manner', scope: 'all-cats', behavior: chatManner, overridable: true }] });
  assert.ok(chatManner.length <= 500);
  // The sentence: the answer first and short, and what was asked for is still given.
  for (const part of ['先说结论', '两三句话', '不用标题、列表、表格和表情符号', '对方明确要清单、表格、代码或长文时照给']) assert.ok(chatManner.includes(part), part);
  // Against the pinned engine's own sources, where the checkout has them: the schema these two files must pass,
  // the block a default behaviour becomes, and which pack is applied.
  const upstream = resolve(import.meta.dirname, '../upstream/clowder-ai/packages');
  if (!existsSync(join(upstream, 'shared/src/schemas/pack.ts'))) return t.skip('the upstream submodule is not checked out here');
  const read = (path: string) => readFileSync(join(upstream, path), 'utf8');
  const schema = read('shared/src/schemas/pack.ts');
  for (const part of [
    "PackTypeSchema = z.enum(['domain', 'scenario', 'style', 'bridge', 'capability'])", "PackScopeSchema = z.enum(['all-cats', 'specific-breeds'])",
    'const packNameRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;', 'version: boundedString(20)', 'description: boundedString(500)',
    'behavior: boundedString(500)', 'overridable: z.literal(true)', 'behaviors: z.array(PackBehaviorSchema).max(50)',
  ]) assert.ok(schema.includes(part), `pack schema: ${part}`);
  assert.ok(read('api/src/domains/packs/PackCompiler.ts').includes('默认行为（用户可覆盖）'));
  assert.ok(read('api/src/domains/packs/getActivePackBlocks.ts').includes('store.get(manifests[0].name)'), 'one pack applies: the first listed');
  const routes = read('api/src/routes/packs.ts');
  for (const route of ["app.post('/api/packs/add'", "app.get('/api/packs'"]) assert.ok(routes.includes(route), route);
  assert.ok(read('api/src/domains/packs/PackStore.ts').includes('await rm(dest, { recursive: true, force: true });'), 'installing the same name replaces it');
});
