import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createApp } from '../server/app.js';
import { createXbotAppsRouter } from '../server/xbot/apps.js';
import { BotApps, nativeIdFor, probeReason, WECHAT_PLUGIN } from '../server/native/apps.js';
import { NativeFixture } from './native-fixture.js';
import { WECHAT_DISCLOSURE } from './apps-fixture.js';

// The adapter over a scripted engine that answers as the pinned upstream did on the isolated runtime
// (tests/apps-fixture.ts). The Mac-only app is tested with the platform given, so it runs anywhere.
async function setup(t: any, platform: NodeJS.Platform = 'darwin') {
  const dir = mkdtempSync(join(tmpdir(), 'bot-apps-test-')), native = new NativeFixture();
  const runtime = createApp({ native, dataFile: join(dir, 'presentation.json') });
  // The same router as production, with the platform under the test's control.
  const app = express(); app.use(express.json());
  app.use('/xbot-api', createXbotAppsRouter(runtime.bridge, new BotApps(native, runtime.store, platform)));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? (error.issues ? 400 : 500)).json({ error: error.issues ? error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('；') : error.message, ...(error.code ? { code: error.code } : {}) }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = async (path = '', method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/xbot-api/apps${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const sent = (pattern: RegExp, method?: string) => native.calls.filter(c => pattern.test(c.path) && (!method || c.method === method));
  return { ...runtime, native, apps: native.apps, call, sent, dataFile: join(dir, 'presentation.json') };
}
const wechatOf = (list: any) => list.body.apps.find((a: any) => a.id === 'wechat');

test('the production app serves 应用 instead of the old "not supported here" stub', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-apps-mount-')), runtime = createApp({ native: new NativeFixture(), dataFile: join(dir, 'presentation.json') });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/xbot-api/apps`);
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.ok(Array.isArray(data.apps) && data.apps.some((a: any) => a.id === 'wechat'));
  assert.equal('supported' in data, false);
  // Its neighbours that are still not adapted keep saying so.
  assert.equal((await (await fetch(`http://127.0.0.1:${address.port}/xbot-api/skills`)).json() as any).supported, false);
});

test('the list is 微信 plus the engine\'s external MCP rows; the engine\'s own servers are not apps; nothing is probed', async t => {
  const r = await setup(t);
  r.apps.rows.push({ id: 'my-notes', type: 'mcp', source: 'external', enabled: true, globalEnabled: true, mcpServer: { transport: 'stdio', command: 'npx', args: ['-y', 'notes-mcp@1.2.3'], env: { NOTES_TOKEN: 'real-secret' } } });
  r.apps.rows.push({ id: 'paused', type: 'mcp', source: 'external', enabled: true, globalEnabled: false, mcpServer: { transport: 'streamableHttp', command: '', args: [], url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer real' } } });
  const list = await r.call();
  assert.deepEqual(list.body.apps.map((a: any) => [a.id, a.kind, a.state]), [['wechat', 'wechat', 'off'], ['custom:my-notes', 'custom', 'unchecked'], ['custom:paused', 'custom', 'off']]);
  assert.deepEqual(list.body.apps[1].source, { type: 'program', program: 'npx', args: ['-y', 'notes-mcp@1.2.3'], secrets: ['NOTES_TOKEN'] });
  assert.deepEqual(list.body.apps[2].source, { type: 'url', url: 'https://mcp.example.com/mcp', secrets: ['Authorization'] });
  assert.equal(list.body.apps[1].title, 'my-notes', 'a row the owner did not name here is shown by its id');
  assert.equal(list.body.apps[2].reason, '已停用');
  assert.equal(JSON.stringify(list.body).includes('real'), false, 'no secret value leaves the engine');
  assert.equal(r.sent(/\/api\/mcp\//).length, 0);
});

test('adding a program: the adapter picks a safe id, sends the engine\'s install shape, keeps only the name, and reports the probe', async t => {
  const r = await setup(t);
  const added = await r.call('/custom', 'POST', { name: '  我的笔记  ', program: ' node ', args: ['/x/server.mjs', '--flag'], secrets: { NOTES_TOKEN: 'tok-123' }, idempotencyKey: '0b0e4d5c-3f0a-4d3e-9c57-2f6f0d0a1b11' });
  assert.equal(added.status, 201);
  const install = r.sent(/mcp\/install$/, 'POST')[0]!.body;
  assert.match(install.id, /^app-[0-9a-f]{8}$/, 'a name with no Latin letters gets a short code');
  assert.deepEqual({ ...install, id: 'x' }, { id: 'x', transport: 'stdio', command: 'node', args: ['/x/server.mjs', '--flag'], env: { NOTES_TOKEN: 'tok-123' } });
  assert.deepEqual(added.body, { id: `custom:${install.id}`, kind: 'custom', title: '我的笔记', state: 'on',
    source: { type: 'program', program: 'node', args: ['/x/server.mjs', '--flag'], secrets: ['NOTES_TOKEN'] }, tools: [{ name: 'app_probe', description: 'Returns a fixed marker.' }] });
  const stored = JSON.parse(readFileSync(r.dataFile, 'utf8'));
  assert.deepEqual(stored.apps, { [install.id]: { title: '我的笔记' } });
  assert.equal(readFileSync(r.dataFile, 'utf8').includes('tok-123'), false, 'the secret is the engine\'s to keep');
  // The same request again (a lost answer): the same app, no second install.
  const again = await r.call('/custom', 'POST', { name: '我的笔记', program: 'node', args: ['/x/server.mjs', '--flag'], secrets: { NOTES_TOKEN: 'tok-123' }, idempotencyKey: '0b0e4d5c-3f0a-4d3e-9c57-2f6f0d0a1b11' });
  assert.equal(again.body.id, added.body.id);
  assert.equal(r.sent(/mcp\/install$/, 'POST').length, 1);
  assert.equal((await r.call()).body.apps.length, 2);
});

test('adding an address: headers are the secrets, the engine does not probe on install so the adapter asks once', async t => {
  const r = await setup(t);
  const added = await r.call('/custom', 'POST', { name: 'Linear', url: 'https://mcp.linear.app/mcp', secrets: { Authorization: 'Bearer abc' } });
  assert.deepEqual(r.sent(/mcp\/install$/, 'POST')[0]!.body, { id: 'linear', transport: 'streamableHttp', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer abc' } });
  assert.equal(r.sent(/\/api\/mcp\/linear\/tools$/, 'POST').length, 1);
  assert.equal(added.body.state, 'on');
  assert.deepEqual(added.body.tools, [{ name: 'search', description: 'Search the service.' }, { name: 'fetch_page' }]);
  assert.deepEqual(added.body.source, { type: 'url', url: 'https://mcp.linear.app/mcp', secrets: ['Authorization'] });
});

test('an app that is added but does not answer is still added, and says why in plain words with the engine\'s own detail', async t => {
  const r = await setup(t);
  const program = await r.call('/custom', 'POST', { name: 'tool', program: 'not-a-program-xyz' });
  assert.equal(program.status, 201);
  assert.deepEqual([program.body.state, program.body.reason, program.body.detail], ['failed', '这台电脑上找不到「not-a-program-xyz」', 'spawn not-a-program-xyz ENOENT']);
  const remote = await r.call('/custom', 'POST', { name: 'far', url: 'http://127.0.0.1:9/mcp' });
  assert.deepEqual([remote.body.state, remote.body.reason, remote.body.detail], ['failed', '连不上这个网址', 'fetch failed']);
  assert.deepEqual((await r.call()).body.apps.map((a: any) => a.id), ['wechat', 'custom:tool', 'custom:far'], 'both are in the engine and in the list');
  // A later check reads the engine again.
  r.apps.probes['tool'] = { connectionStatus: 'connected', tools: [{ name: 'ok' }] };
  assert.equal((await r.call('/custom%3Atool')).body.state, 'on');
  r.apps.probes['tool'] = { connectionStatus: 'unknown' };
  assert.deepEqual([(await r.call('/custom%3Atool')).body.state, (await r.call('/custom%3Atool')).body.reason], ['unchecked', '没能检查']);
});

test('the engine checks nothing on install, so the adapter refuses what must not reach it', async t => {
  const r = await setup(t);
  const bad: Array<[unknown, RegExp]> = [
    [{ name: 'x' }, /二选一/], [{ name: 'x', program: 'node', url: 'https://a.example' }, /二选一/],
    [{ name: '', program: 'node' }, /请起个名字/], [{ name: 'x', program: '   ' }, /请填要运行的程序/],
    [{ name: 'x', program: 'node\nrm' }, /换行/], [{ name: 'x', program: 'node', args: ['a\nb'] }, /换行/],
    [{ name: 'x', program: 'node', secrets: { '1BAD': 'v' } }, /变量的名称/], [{ name: 'x', program: 'node', secrets: { OK: '••••••' } }, /密钥的值无效/],
    [{ name: 'x', url: 'ftp://example.com' }, /https/], [{ name: 'x', url: 'http://example.com/mcp' }, /https/],
    [{ name: 'x', url: 'https://user:pw@example.com/mcp' }, /https/], [{ name: 'x', url: 'https://a.example', secrets: { 'Bad Header': 'v' } }, /请求头/],
    [{ name: 'x', url: 'https://a.example', extra: 1 }, /./], [{ name: 'x', program: 'node', idempotencyKey: 'nope' }, /./],
  ];
  for (const [body, message] of bad) {
    const answer = await r.call('/custom', 'POST', body);
    assert.equal(answer.status, 400, JSON.stringify(body)); assert.match(answer.body.error, message, JSON.stringify(body));
  }
  assert.equal(r.sent(/mcp\/install$/).length, 0);
  assert.equal((await r.call('/custom', 'POST', { name: 'x', url: 'http://localhost:8123/mcp' })).status, 201, 'plain http is for this computer only');
});

test('ids: readable when the name allows, never one the engine or another app already has', () => {
  assert.equal(nativeIdFor('My Notes!', new Set()), 'my-notes');
  assert.equal(nativeIdFor('My Notes', new Set(['my-notes', 'my-notes-2'])), 'my-notes-3');
  assert.match(nativeIdFor('笔记', new Set()), /^app-[0-9a-f]{8}$/);
  assert.match(nativeIdFor('cat-cafe-collab', new Set()), /^app-/, 'the engine\'s own namespace is not for apps');
  assert.match(nativeIdFor('plugin', new Set()), /^app-/);
  assert.match(nativeIdFor('9 lives', new Set()), /^app-/, 'an id starts with a letter');
  assert.equal(nativeIdFor('笔记', new Set(), 'seed'), nativeIdFor('笔记', new Set(), 'seed'), 'the same request makes the same id');
  assert.equal(nativeIdFor('a'.repeat(80), new Set()).length, 32);
});

test('probe errors are said plainly', () => {
  const program = { type: 'program' as const, program: 'uvx', args: [], secrets: [] };
  assert.equal(probeReason('spawn uvx ENOENT', program), '这台电脑上找不到「uvx」');
  assert.equal(probeReason('Probe timeout after 7000ms', program), '几秒内没有回应');
  assert.equal(probeReason('HTTP 401 Unauthorized', undefined), '对方拒绝了，密钥可能不对');
  assert.equal(probeReason('fetch failed', undefined), '连不上这个网址');
  assert.equal(probeReason(undefined, program), '没连上');
});

test('renaming changes only the kept name; secrets go to the engine route that merges them (env for a program, headers for an address)', async t => {
  const r = await setup(t);
  const program = (await r.call('/custom', 'POST', { name: 'notes', program: 'node', secrets: { A: '1' } })).body;
  const renamed = await r.call(`/${encodeURIComponent(program.id)}`, 'PATCH', { name: '笔记' });
  assert.equal(renamed.body.title, '笔记'); assert.equal(r.sent(/\/env$/).length, 0);
  const patched = await r.call(`/${encodeURIComponent(program.id)}`, 'PATCH', { secrets: { A: '2', B: '3' } });
  assert.deepEqual(r.sent(/mcp\/notes\/env$/, 'PATCH')[0]!.body, { env: { A: '2', B: '3' } });
  assert.deepEqual(patched.body.source.secrets, ['A', 'B']);
  assert.deepEqual(r.apps.rows.find(row => row.id === 'notes')!.mcpServer.env, { A: '2', B: '3' });
  const remote = (await r.call('/custom', 'POST', { name: 'far', url: 'https://a.example/mcp', secrets: { Authorization: 'one', 'X-Keep': 'k' } })).body;
  await r.call(`/${encodeURIComponent(remote.id)}`, 'PATCH', { secrets: { Authorization: 'two' } });
  assert.deepEqual(r.sent(/mcp\/install$/, 'POST').at(-1)!.body, { id: 'far', headers: { Authorization: 'two' } });
  assert.deepEqual(r.apps.rows.find(row => row.id === 'far')!.mcpServer, { transport: 'streamableHttp', command: '', args: [], url: 'https://a.example/mcp', headers: { Authorization: 'two', 'X-Keep': 'k' } });
  assert.equal((await r.call(`/${encodeURIComponent(program.id)}`, 'PATCH', { secrets: { 'bad name': 'x' } })).status, 400);
  assert.equal((await r.call(`/${encodeURIComponent(program.id)}`, 'PATCH', {})).status, 400);
  assert.equal((await r.call('/custom%3Anope', 'PATCH', { name: 'x' })).status, 404);
});

test('removing deletes the engine row for good and forgets the name; 微信 cannot be removed, the engine\'s own servers cannot be touched', async t => {
  const r = await setup(t);
  const app = (await r.call('/custom', 'POST', { name: '笔记', program: 'node' })).body;
  const nativeId = app.id.slice(7);
  assert.deepEqual((await r.call(`/${encodeURIComponent(app.id)}`, 'DELETE')).body, { removed: true });
  assert.equal(r.sent(new RegExp(`mcp/${nativeId}\\?hard=true$`), 'DELETE').length, 1);
  assert.deepEqual(JSON.parse(readFileSync(r.dataFile, 'utf8')).apps, {});
  assert.deepEqual((await r.call()).body.apps.map((a: any) => a.id), ['wechat']);
  const builtin = await r.call('/wechat', 'DELETE');
  assert.deepEqual([builtin.status, builtin.body.code], [405, 'app_builtin']);
  for (const id of ['custom%3Acat-cafe-collab', 'cat-cafe-collab', 'custom%3A', 'nope']) {
    assert.equal((await r.call(`/${id}`, 'DELETE')).status, 404, id);
    assert.equal((await r.call(`/${id}`)).status, 404, id);
  }
  assert.equal(r.apps.rows.some(row => row.id === 'cat-cafe-collab'), true);
});

test('微信: each engine state is one honest app state', async t => {
  const r = await setup(t);
  const read = async () => wechatOf(await r.call());
  assert.deepEqual(await read(), { id: 'wechat', kind: 'wechat', title: '微信', disclosure: WECHAT_DISCLOSURE, version: '0.1.0-alpha.7', state: 'off' });
  Object.assign(r.apps.plugin!, { activationFailed: true, diagnostic: { code: 'UNEXPECTED_RUNTIME_FAILURE', message: 'Plugin runtime reported it.' } });
  assert.deepEqual([(await read()).state, (await read()).reason, (await read()).detail], ['off', '上次没能启动', 'UNEXPECTED_RUNTIME_FAILURE · Plugin runtime reported it.']);
  Object.assign(r.apps.plugin!, { intent: 'enabled', live: 'crashed' });
  assert.deepEqual([(await read()).state, (await read()).reason], ['failed', '没能启动']);
  Object.assign(r.apps.plugin!, { live: 'starting', activationFailed: null, diagnostic: null }); r.apps.pending = 99;
  assert.equal((await read()).state, 'starting'); assert.equal('authorization' in (await read()), false);
  Object.assign(r.apps.plugin!, { intent: 'disabled', live: 'stopped', setEnabled: false });
  assert.deepEqual([(await read()).state, (await read()).reason, (await read()).detail], ['unavailable', '现在还不能打开', 'config-incomplete']);
  r.apps.plugin!.artifact = 'quarantined';
  assert.deepEqual([(await read()).state, (await read()).reason], ['unavailable', '它的程序包没有通过校验']);
  r.apps.plugin!.artifact = 'absent';
  assert.deepEqual([(await read()).state, (await read()).reason], ['unavailable', '这台电脑上还没有它的程序包']);
  r.apps.plugin = null;
  assert.deepEqual([(await read()).state, (await read()).reason], ['unavailable', '这台电脑上还没有它的程序包']);
  for (const path of ['/wechat/connect', '/wechat/disconnect']) {
    const refused = await r.call(path, 'POST', {});
    assert.deepEqual([refused.status, refused.body.code], [409, 'app_unavailable']);
  }
});

test('微信 is a Mac app: elsewhere it is unavailable and the engine is not even asked', async t => {
  const r = await setup(t, 'linux');
  assert.deepEqual(wechatOf(await r.call()), { id: 'wechat', kind: 'wechat', title: '微信', state: 'unavailable', reason: '只在 Mac 上能用' });
  assert.equal(r.sent(/plugin-manager/).length, 0);
  assert.equal((await r.call('/wechat/connect', 'POST', {})).status, 409);
});

test('微信 on and off: the engine\'s revision is sent, a stale one is read again once, and the answer is what was read back', async t => {
  const r = await setup(t);
  const on = await r.call('/wechat/connect', 'POST', {});
  assert.deepEqual([on.status, on.body.state, on.body.authorization], [200, 'on', { active: false, remaining_ms: 0 }]);
  assert.deepEqual(r.sent(/set-enabled$/)[0]!.body, { enabled: true, expectedRevision: 4 });
  assert.equal((await r.call('/wechat/connect', 'POST', {})).body.state, 'on');
  assert.equal(r.sent(/set-enabled$/).length, 1, 'already on: nothing is sent');
  // Someone else moves the revision between the adapter's read and its write.
  const request = r.native.request.bind(r.native); let bumped = false;
  r.native.request = (async (path: string, options: any = {}) => {
    if (!bumped && /set-enabled$/.test(path)) { bumped = true; r.apps.plugin!.lifecycleRevision += 1; }
    return request(path, options);
  }) as any;
  const off = await r.call('/wechat/disconnect', 'POST', {});
  assert.equal(off.body.state, 'off');
  assert.equal(r.sent(/set-enabled$/).length, 3, 'one refused for a stale revision, one that went through');
  assert.equal(r.apps.plugin!.intent, 'disabled');
});

test('微信 start that outlasts the request is reported as starting, a start that fails as failed — never as on', async t => {
  const r = await setup(t);
  r.apps.start = 'timeout';
  const cut = await r.call('/wechat/connect', 'POST', {});
  assert.deepEqual([cut.status, cut.body.state], [200, 'on'], 'the engine went on and is running: read back, not assumed');
  await r.call('/wechat/disconnect', 'POST', {});
  r.apps.start = 2;
  const slow = await r.call('/wechat/connect', 'POST', {});
  assert.equal(slow.body.state, 'starting');
  assert.equal((await r.call('/wechat/authorize', 'POST', {})).body.code, 'app_not_on');
  let state = 'starting';
  for (let i = 0; i < 5 && state === 'starting'; i++) state = (await r.call('/wechat')).body.state;
  assert.equal(state, 'on');
  await r.call('/wechat/disconnect', 'POST', {});
  r.apps.start = 'fail';
  const failed = await r.call('/wechat/connect', 'POST', {});
  assert.deepEqual([failed.body.state, failed.body.reason], ['off', '上次没能启动']);
  // A record left at "enabled, not running" is turned off before it is turned on again.
  Object.assign(r.apps.plugin!, { intent: 'enabled', live: 'crashed' }); r.apps.start = 'ok';
  const before = r.sent(/set-enabled$/).length;
  assert.equal((await r.call('/wechat/connect', 'POST', {})).body.state, 'on');
  assert.deepEqual(r.sent(/set-enabled$/).slice(before).map(c => c.body.enabled), [false, true]);
  // An engine that cannot be reached is an error, not a state.
  r.apps.plugin!.intent = 'disabled'; r.apps.plugin!.live = 'stopped';
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options: any = {}) => { if (/set-enabled$/.test(path)) throw Object.assign(new Error('Clowder AI 请求中断'), { status: 503 }); return request(path, options); }) as any;
  assert.notEqual((await r.call('/wechat/connect', 'POST', {})).status, 200);
});

test('微信 authorization: ten minutes from the plugin\'s own action, readable every time, revocable — the operation state is cleared before each action', async t => {
  const r = await setup(t); let now = Date.parse('2026-11-26T02:00:00Z'); r.apps.now = () => now;
  assert.equal((await r.call('/wechat/authorize', 'POST', {})).body.code, 'app_not_on', 'off: nothing to authorize');
  await r.call('/wechat/connect', 'POST', {});
  const armed = await r.call('/wechat/authorize', 'POST', {});
  assert.deepEqual(armed.body.authorization, { active: true, remaining_ms: 600_000, until: '2026-11-26T02:10:00.000Z' });
  // Read it several times: without the reset the pinned engine + plugin refuse every action after the first.
  now += 60_000;
  for (let i = 0; i < 3; i++) assert.deepEqual(wechatOf(await r.call()).authorization, { active: true, remaining_ms: 540_000, until: '2026-11-26T02:10:00.000Z' });
  const order = r.native.calls.filter(c => /\/operations\/|\/actions\//.test(c.path)).map(c => c.path.replace(`/api/plugins/${WECHAT_PLUGIN}/`, ''));
  for (let i = 0; i < order.length; i += 2) { assert.match(order[i]!, /^operations\/visibleReadingAuthorization\/reset$/); assert.match(order[i + 1]!, /^actions\/visibleReadingAuthorization\/(arm|disarm|status)$/); }
  assert.equal(order.filter(path => path.endsWith('/arm')).length, 1);
  now += 541_000;
  assert.deepEqual(wechatOf(await r.call()).authorization, { active: false, remaining_ms: 0 }, 'it ends by itself');
  await r.call('/wechat/authorize', 'POST', {});
  assert.deepEqual((await r.call('/wechat/revoke', 'POST', {})).body.authorization, { active: false, remaining_ms: 0 });
  assert.deepEqual((await r.call('/wechat')).body.authorization, { active: false, remaining_ms: 0 });
  // Turning the app off ends any authorization (the engine clears it on stop).
  await r.call('/wechat/authorize', 'POST', {}); await r.call('/wechat/disconnect', 'POST', {}); await r.call('/wechat/connect', 'POST', {});
  assert.deepEqual((await r.call('/wechat')).body.authorization, { active: false, remaining_ms: 0 });
});

test('微信 on, but its status cannot be read: on, and no authorization is claimed', async t => {
  const r = await setup(t);
  await r.call('/wechat/connect', 'POST', {});
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options: any = {}) => { if (/\/actions\//.test(path)) throw new Error('boom'); return request(path, options); }) as any;
  assert.deepEqual([(await r.call('/wechat')).body.state, (await r.call('/wechat')).body.authorization], ['on', { active: false, remaining_ms: 0 }]);
});
