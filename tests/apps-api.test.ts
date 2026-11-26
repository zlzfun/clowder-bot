import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createApp } from '../server/app.js';
import { createXbotAppsRouter } from '../server/xbot/apps.js';
import { BotApps, nativeIdFor, parseCustomApp, probeDetail, probeReason, WECHAT_PLUGIN } from '../server/native/apps.js';
import { ApiError } from '../server/errors.js';
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
  return { ...runtime, native, apps: native.apps, call, sent, dataFile: join(dir, 'presentation.json'), platform };
}
const wechatOf = (list: any) => list.body.apps.find((a: any) => a.id === 'wechat');
const nativeOf = (app: any): string => app.id.slice('custom:'.length);

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
  assert.match(install.id, /^app-[0-9a-f]{8}$/, 'a name with no Latin letters is just "app" and the request\'s code');
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
  const id = nativeOf(added.body);
  assert.match(id, /^linear-[0-9a-f]{8}$/);
  assert.deepEqual(r.sent(/mcp\/install$/, 'POST')[0]!.body, { id, transport: 'streamableHttp', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer abc' } });
  assert.equal(r.sent(new RegExp(`/api/mcp/${id}/tools$`), 'POST').length, 1);
  assert.equal(added.body.state, 'on');
  assert.deepEqual(added.body.tools, [{ name: 'search', description: 'Search the service.' }, { name: 'fetch_page' }]);
  assert.deepEqual(added.body.source, { type: 'url', url: 'https://mcp.linear.app/mcp', secrets: ['Authorization'] });
});

test('an app that is added but does not answer is still added, and says why in plain words with the engine\'s own detail', async t => {
  const r = await setup(t);
  const program = await r.call('/custom', 'POST', { name: 'tool', program: 'not-a-program-xyz' });
  assert.equal(program.status, 201);
  assert.deepEqual([program.body.state, program.body.reason, program.body.detail], ['failed', '这台电脑上找不到「not-a-program-xyz」', 'ENOENT']);
  const remote = await r.call('/custom', 'POST', { name: 'far', url: 'http://127.0.0.1:9/mcp' });
  assert.deepEqual([remote.body.state, remote.body.reason, remote.body.detail], ['failed', '连不上这个网址', 'fetch failed']);
  assert.deepEqual((await r.call()).body.apps.map((a: any) => a.id), ['wechat', program.body.id, remote.body.id], 'both are in the engine and in the list');
  // A later check reads the engine again.
  const tool = nativeOf(program.body), path = `/${encodeURIComponent(program.body.id)}`;
  r.apps.probes[tool] = { connectionStatus: 'connected', tools: [{ name: 'ok' }] };
  assert.equal((await r.call(path)).body.state, 'on');
  r.apps.probes[tool] = { connectionStatus: 'unknown' };
  assert.deepEqual([(await r.call(path)).body.state, (await r.call(path)).body.reason], ['unchecked', '没能检查']);
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
    // One header in two spellings would be stored twice and sent as one joined value.
    [{ name: 'x', url: 'https://a.example', secrets: { Authorization: 'a', authorization: 'b' } }, /重复/],
  ];
  for (const [body, message] of bad) {
    const answer = await r.call('/custom', 'POST', body);
    assert.equal(answer.status, 400, JSON.stringify(body)); assert.match(answer.body.error, message, JSON.stringify(body));
  }
  assert.equal(r.sent(/mcp\/install$/).length, 0);
  assert.equal((await r.call('/custom', 'POST', { name: 'x', url: 'http://localhost:8123/mcp' })).status, 201, 'plain http is for this computer only');
});

test('ids: the name\'s own letters when it has some, then a code that is this request\'s alone — never the engine\'s namespace', () => {
  assert.equal(nativeIdFor('My Notes!', '1a2b3c4d'), 'my-notes-1a2b3c4d');
  assert.equal(nativeIdFor('笔记', '1a2b3c4d'), 'app-1a2b3c4d');
  assert.equal(nativeIdFor('cat-cafe-collab', '1a2b3c4d'), 'app-1a2b3c4d', 'the engine\'s own namespace is not for apps');
  assert.equal(nativeIdFor('plugin', '1a2b3c4d'), 'app-1a2b3c4d');
  assert.equal(nativeIdFor('9 lives', '1a2b3c4d'), 'app-1a2b3c4d', 'an id starts with a letter');
  // Short enough to leave room for a tool's own name behind it.
  assert.equal(nativeIdFor('a'.repeat(80), '1a2b3c4d'), `${'a'.repeat(20)}-1a2b3c4d`);
  assert.equal(nativeIdFor('trailing ----- dashes and more words', '1a2b3c4d'), 'trailing-dashes-and-1a2b3c4d', 'cut at twenty, and never a doubled dash before the code');
});

test('probe errors are said plainly', () => {
  const program = { type: 'program' as const, program: 'uvx', args: [], secrets: [] };
  assert.equal(probeReason('spawn uvx ENOENT', program), '这台电脑上找不到「uvx」');
  assert.equal(probeReason('Probe timeout after 7000ms', program), '几秒内没有回应');
  assert.equal(probeReason('HTTP 401 Unauthorized', undefined), '对方拒绝了，密钥可能不对');
  assert.equal(probeReason('fetch failed', undefined), '连不上这个网址');
  assert.equal(probeReason(undefined, program), '没连上');
});

test('the engine\'s probe error can quote the answering server\'s body — and a server may echo the credential: only fragments that cannot carry one go out', async t => {
  assert.equal(probeDetail('Error POSTing to endpoint (HTTP 401): {"error":"Invalid credential Bearer sk-live-123"}'), 'HTTP 401');
  assert.equal(probeDetail('SSE error: Non-200 status code (403)'), 'status code (403)');
  assert.equal(probeDetail('spawn /Users/me/bin/thing ENOENT'), 'ENOENT');
  assert.equal(probeDetail('Probe timeout after 7000ms'), 'timeout');
  assert.equal(probeDetail('MCP error -32000: Connection closed'), 'MCP error -32000 · Connection closed');
  assert.equal(probeDetail('fetch failed: connect ECONNREFUSED 127.0.0.1:9'), 'fetch failed · ECONNREFUSED');
  assert.equal(probeDetail('something nobody listed, with sk-live-123 in it'), undefined);
  assert.equal(probeDetail('unable to verify: UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  // Nothing in the list is open-ended: a made-up code or an endless number is not a fragment, however much it looks like one.
  for (const forged of ['CERT_PRIVATE_TOKEN_ABC', 'UNABLE_TO_KEEP_SECRET_ABC', 'XSELF_SIGNED_CERT_TOKEN', 'CERT_HAS_EXPIRED_TOKEN_ABC', 'MCP error 123456789012345678901234567890',
    'HTTP 4011234567', 'status code (4011234567)', 'ENOENT_TOKEN_ABC', 'EVERYTHING', 'Error'])
    assert.equal(probeDetail(`Error POSTing to endpoint: {"error":"${forged}"}`), undefined, forged);
  assert.equal(probeDetail(undefined), undefined);
  // Through the adapter: added, re-read and patched — the value never comes back, in any field.
  const r = await setup(t);
  const added = await r.call('/custom', 'POST', { name: 'far', url: 'https://a.example/mcp', secrets: { Authorization: 'Bearer sk-live-123' } });
  r.apps.probes[nativeOf(added.body)] = { connectionStatus: 'disconnected', tools: [], error: 'Error POSTing to endpoint (HTTP 401): {"error":"Invalid credential Bearer sk-live-123"}' };
  const path = `/${encodeURIComponent(added.body.id)}`;
  const answers = [await r.call(path), await r.call(path, 'PATCH', { name: '远处' }), await r.call(path, 'PATCH', { secrets: { Authorization: 'Bearer sk-live-456' } }), await r.call()];
  assert.deepEqual([answers[0]!.body.state, answers[0]!.body.reason, answers[0]!.body.detail], ['failed', '对方拒绝了，密钥可能不对', 'HTTP 401']);
  for (const answer of answers) assert.equal(/sk-live/.test(JSON.stringify(answer.body)), false, JSON.stringify(answer.body));
});

test('renaming changes only the kept name; secrets go to the engine route that merges them (env for a program, headers for an address)', async t => {
  const r = await setup(t);
  const program = (await r.call('/custom', 'POST', { name: 'notes', program: 'node', secrets: { A: '1' } })).body, notes = nativeOf(program);
  const renamed = await r.call(`/${encodeURIComponent(program.id)}`, 'PATCH', { name: '笔记' });
  assert.equal(renamed.body.title, '笔记'); assert.equal(r.sent(/\/env$/).length, 0);
  const patched = await r.call(`/${encodeURIComponent(program.id)}`, 'PATCH', { secrets: { A: '2', B: '3' } });
  assert.deepEqual(r.sent(new RegExp(`mcp/${notes}/env$`), 'PATCH')[0]!.body, { env: { A: '2', B: '3' } });
  assert.deepEqual(patched.body.source.secrets, ['A', 'B']);
  assert.deepEqual(r.apps.rows.find(row => row.id === notes)!.mcpServer.env, { A: '2', B: '3' });
  // Environment names differ by case; these are two variables.
  await r.call(`/${encodeURIComponent(program.id)}`, 'PATCH', { secrets: { a: '4' } });
  assert.deepEqual(r.apps.rows.find(row => row.id === notes)!.mcpServer.env, { A: '2', B: '3', a: '4' });
  const remote = (await r.call('/custom', 'POST', { name: 'far', url: 'https://a.example/mcp', secrets: { Authorization: 'one', 'X-Keep': 'k' } })).body, far = nativeOf(remote);
  await r.call(`/${encodeURIComponent(remote.id)}`, 'PATCH', { secrets: { Authorization: 'two' } });
  assert.deepEqual(r.sent(/mcp\/install$/, 'POST').at(-1)!.body, { id: far, headers: { Authorization: 'two' } });
  assert.deepEqual(r.apps.rows.find(row => row.id === far)!.mcpServer, { transport: 'streamableHttp', command: '', args: [], url: 'https://a.example/mcp', headers: { Authorization: 'two', 'X-Keep': 'k' } });
  // A header named in another case replaces the one that is stored (the engine would keep both, and both would be sent as one joined value).
  const cased = await r.call(`/${encodeURIComponent(remote.id)}`, 'PATCH', { secrets: { authorization: 'three', 'x-new': 'n' } });
  assert.deepEqual(r.sent(/mcp\/install$/, 'POST').at(-1)!.body, { id: far, headers: { Authorization: 'three', 'x-new': 'n' } });
  assert.deepEqual(r.apps.rows.find(row => row.id === far)!.mcpServer.headers, { Authorization: 'three', 'X-Keep': 'k', 'x-new': 'n' });
  assert.deepEqual(cased.body.source.secrets, ['Authorization', 'X-Keep', 'x-new']);
  assert.equal((await r.call(`/${encodeURIComponent(remote.id)}`, 'PATCH', { secrets: { 'X-Keep': 'a', 'x-keep': 'b' } })).status, 400);
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
  // The pinned engine answers a failed start with 503 RUNTIME_START_FAILED after recording it; the adapter's answer is that record.
  const failed = await r.call('/wechat/connect', 'POST', {});
  assert.deepEqual([failed.status, failed.body.state, failed.body.reason, failed.body.detail], [200, 'off', '上次没能启动', 'UNEXPECTED_RUNTIME_FAILURE · Plugin runtime reported UNEXPECTED_RUNTIME_FAILURE.']);
  // …also when it was 再试一次 from a record left at "enabled, not running": off first, then the start that fails.
  Object.assign(r.apps.plugin!, { intent: 'enabled', live: 'crashed' });
  const again = await r.call('/wechat/connect', 'POST', {});
  assert.deepEqual([again.status, again.body.state, again.body.reason], [200, 'off', '上次没能启动']);
  // Any other refusal by the engine is an error, not a state.
  r.apps.start = 'ok';
  const real = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options: any = {}) => { if (/set-enabled$/.test(path)) throw new ApiError(503, 'Plugin lifecycle operation failed', { error: 'Plugin lifecycle operation failed', code: 'LIFECYCLE_UNAVAILABLE' }); return real(path, options); }) as any;
  assert.equal((await r.call('/wechat/connect', 'POST', {})).status, 503);
  r.native.request = real as any;
  // A record left at "enabled, not running" is turned off before it is turned on again.
  Object.assign(r.apps.plugin!, { intent: 'enabled', live: 'crashed' }); r.apps.start = 'ok';
  const before = r.sent(/set-enabled$/).length;
  assert.equal((await r.call('/wechat/connect', 'POST', {})).body.state, 'on');
  assert.deepEqual(r.sent(/set-enabled$/).slice(before).map(c => c.body.enabled), [false, true]);
  // A request that never reached the engine (the adapter's own 503, as NativeClient throws it) is read back, found
  // unchanged, and is an error — not a state, and not the stale 「上次没能启动」 of an earlier attempt either.
  Object.assign(r.apps.plugin!, { intent: 'disabled', live: 'stopped', activationFailed: true });
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options: any = {}) => { if (/set-enabled$/.test(path)) throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。'); return request(path, options); }) as any;
  const cutOff = await r.call('/wechat/connect', 'POST', {});
  assert.deepEqual([cutOff.status, 'state' in cutOff.body], [503, false]);
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

test('微信 on, but its authorization cannot be read: on, and nothing is claimed about it — not "not authorized" either', async t => {
  const r = await setup(t); let now = Date.parse('2026-11-26T02:00:00Z'); r.apps.now = () => now;
  await r.call('/wechat/connect', 'POST', {});
  await r.call('/wechat/authorize', 'POST', {});
  r.apps.statusFails = true;
  // The grant is still running in the plugin; the adapter cannot see it and says nothing rather than "inactive".
  for (const row of [(await r.call('/wechat')).body, wechatOf(await r.call())]) {
    assert.equal(row.state, 'on'); assert.equal('authorization' in row, false, JSON.stringify(row));
  }
  // Revoking does not depend on reading it, and its answer is the plugin's own.
  assert.deepEqual((await r.call('/wechat/revoke', 'POST', {})).body.authorization, { active: false, remaining_ms: 0 });
  now += 300_000; await r.call('/wechat/authorize', 'POST', {});
  r.apps.statusFails = false; now += 60_000;
  assert.deepEqual((await r.call('/wechat')).body.authorization, { active: true, remaining_ms: 540_000, until: '2026-11-26T02:15:00.000Z' }, 'readable again: what the plugin has, which was there all along');
});

test('requests that arrive together do not trip over each other: two adds get two ids, a status read cannot land between a reset and its action', async t => {
  const r = await setup(t);
  // The engine answers each call a tick later, so steps that are not kept apart do interleave.
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options: any = {}) => { await new Promise(done => setTimeout(done, 2)); return request(path, options); }) as any;
  const [first, second] = await Promise.all([r.call('/custom', 'POST', { name: 'notes', program: 'node' }), r.call('/custom', 'POST', { name: 'notes', program: 'node', args: ['b'] })]);
  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.notEqual(first.body.id, second.body.id);
  assert.equal(r.apps.rows.filter(row => row.source === 'external').length, 2);
  // Two adapters on one engine (two processes: nothing in memory is shared) that both read the registry before
  // either installs: the engine merges an install into an id that exists, so the ids must already differ.
  const one = new BotApps(r.native, r.store, r.platform), two = new BotApps(r.native, r.store, r.platform);
  const reads: Array<() => void> = []; let held = 2;
  r.native.request = (async (path: string, options: any = {}) => {
    if (path === '/api/capabilities' && held > 0) { held--; const answer = await request(path, options); await new Promise<void>(done => { reads.push(done); if (reads.length === 2) for (const go of reads) go(); }); return answer; }
    return request(path, options);
  }) as any;
  const [a, b] = await Promise.all([
    one.addCustom(parseCustomApp({ name: 'shared', program: 'node', args: ['one'], secrets: { ONE: '1' } })),
    two.addCustom(parseCustomApp({ name: 'shared', program: 'node', args: ['two'], secrets: { TWO: '2' } })),
  ]);
  assert.notEqual(a.id, b.id);
  const rowOf = (app: any) => r.apps.rows.find(row => row.id === nativeOf(app))!.mcpServer;
  assert.deepEqual([rowOf(a).args, rowOf(a).env, rowOf(b).args, rowOf(b).env], [['one'], { ONE: '1' }, ['two'], { TWO: '2' }], 'neither took the other\'s program or secrets');
  r.native.request = (async (path: string, options: any = {}) => { await new Promise(done => setTimeout(done, 2)); return request(path, options); }) as any;
  await r.call('/wechat/connect', 'POST', {});
  const answers = await Promise.all([r.call('/wechat'), r.call('/wechat/authorize', 'POST', {}), r.call('/wechat'), r.call(), r.call('/wechat/revoke', 'POST', {}), r.call('/wechat')]);
  assert.deepEqual(answers.map(a => a.status), [200, 200, 200, 200, 200, 200], JSON.stringify(answers.map(a => a.body.error)));
  assert.deepEqual((await r.call('/wechat')).body.authorization, { active: false, remaining_ms: 0 });
});

test('微信 that cannot be read does not take the custom apps off the list; asked for directly, the error is the error', async t => {
  const r = await setup(t);
  const notes = (await r.call('/custom', 'POST', { name: 'notes', program: 'node' })).body;
  const request = r.native.request.bind(r.native);
  r.native.request = (async (path: string, options: any = {}) => { if (/plugin-manager/.test(path)) throw Object.assign(new Error('engine said no'), { status: 500 }); return request(path, options); }) as any;
  const list = await r.call();
  assert.deepEqual(list.body.apps.map((a: any) => [a.id, a.state, a.reason]), [['wechat', 'unavailable', '没能读到它的状态'], [notes.id, 'unchecked', undefined]]);
  assert.equal((await r.call('/wechat')).status, 500);
});

test('the same request asked again finds the app it made in the engine itself — after a lost answer, after a restart; changed content under the same key is refused', async t => {
  const r = await setup(t), key = '5d0c0a3e-8f6b-4c1d-9a27-3b1f0e9d7c55';
  const body = { name: 'notes', program: 'node', args: ['/x/a.mjs'], secrets: { TOKEN: 't' }, idempotencyKey: key };
  // The engine installs it, but the answer is lost on the way back.
  const request = r.native.request.bind(r.native); let lose = true;
  r.native.request = (async (path: string, options: any = {}) => {
    const answer = await request(path, options);
    if (lose && /mcp\/install$/.test(path)) { lose = false; throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。'); }
    return answer;
  }) as any;
  assert.equal((await r.call('/custom', 'POST', body)).status, 503);
  assert.equal(r.apps.rows.filter(row => row.source === 'external').length, 1, 'it is in the engine all the same');
  // Asked again by an adapter that remembers nothing (a restart): the same app, named now, and no second install.
  const fresh = new BotApps(r.native, r.store, r.platform);
  const again = await fresh.addCustom(parseCustomApp(body));
  assert.deepEqual([again.title, again.state, again.source], ['notes', 'on', { type: 'program', program: 'node', args: ['/x/a.mjs'], secrets: ['TOKEN'] }]);
  assert.equal(r.sent(/mcp\/install$/, 'POST').length, 1);
  assert.equal((await r.call('/custom', 'POST', body)).body.id, again.id);
  assert.equal(r.apps.rows.filter(row => row.source === 'external').length, 1);
  // The key names one request: other content under it is refused, and nothing is installed or merged.
  for (const other of [{ ...body, args: ['/x/b.mjs'] }, { ...body, program: 'deno' }, { ...body, secrets: { TOKEN: 't', MORE: 'm' } }, { name: 'notes', url: 'https://a.example/mcp', idempotencyKey: key }]) {
    const refused = await r.call('/custom', 'POST', other);
    assert.deepEqual([refused.status, refused.body.code], [409, 'idempotency_conflict'], JSON.stringify(other));
  }
  assert.equal(r.sent(/mcp\/install$/, 'POST').length, 1);
  // Removed since: the same request adds it again, which is what was asked.
  await r.call(`/${encodeURIComponent(again.id)}`, 'DELETE');
  assert.equal((await r.call('/custom', 'POST', body)).status, 201);
  // Without a key every request is its own.
  const [x, y] = [await r.call('/custom', 'POST', { name: 'same', program: 'node' }), await r.call('/custom', 'POST', { name: 'same', program: 'node' })];
  assert.notEqual(x.body.id, y.body.id);
});

test('once the engine has taken a change, nothing after it turns the answer into a failure: an unkept name, a row that cannot be read back, a check that cannot be made', async t => {
  const r = await setup(t), key = '8a1f2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const save = r.store.save.bind(r.store), request = r.native.request.bind(r.native);
  const quiet = console.warn; console.warn = () => {}; t.after(() => { console.warn = quiet; });
  // 1. The name cannot be written: added, shown by its id (what a restart would show), and said so nowhere as "could not add".
  r.store.save = () => { throw new Error('ENOSPC'); };
  const unnamed = await r.call('/custom', 'POST', { name: '笔记', program: 'node', idempotencyKey: key });
  assert.equal(unnamed.status, 201);
  assert.deepEqual([unnamed.body.state, unnamed.body.title], ['on', nativeOf(unnamed.body)]);
  assert.equal(r.store.state.apps?.[nativeOf(unnamed.body)], undefined, 'nothing is kept in memory that is not on disk');
  r.store.save = save;
  // The same request again: the same app, and its name is kept this time.
  const named = await r.call('/custom', 'POST', { name: '笔记', program: 'node', idempotencyKey: key });
  assert.deepEqual([named.body.id, named.body.title], [unnamed.body.id, '笔记']);
  assert.equal(r.sent(/mcp\/install$/, 'POST').length, 1);
  // 2. The registry cannot be read back after the install: the row the install answered.
  let installed = false;
  r.native.request = (async (path: string, options: any = {}) => {
    if (installed && path === '/api/capabilities') throw new ApiError(500, 'registry unreadable');
    const answer = await request(path, options);
    if (/mcp\/install$/.test(path)) installed = true;
    return answer;
  }) as any;
  const blind = await r.call('/custom', 'POST', { name: 'blind', program: 'node', args: ['x'] });
  assert.deepEqual([blind.status, blind.body.state, blind.body.source.program, blind.body.source.args], [201, 'on', 'node', ['x']]);
  // 3. The check cannot be made (an address: the install does not probe): added, unchecked.
  r.native.request = (async (path: string, options: any = {}) => { if (/\/api\/mcp\/[^/]+\/tools$/.test(path)) throw new ApiError(504, 'probe did not return'); return request(path, options); }) as any;
  const unchecked = await r.call('/custom', 'POST', { name: 'far', url: 'https://a.example/mcp' });
  assert.deepEqual([unchecked.status, unchecked.body.state, unchecked.body.reason], [201, 'unchecked', '没能检查']);
  // 4. Secrets taken by the engine, then the check cannot be made: changed, unchecked — while a check asked for by itself still says it failed.
  const path = `/${encodeURIComponent(unchecked.body.id)}`;
  const patched = await r.call(path, 'PATCH', { secrets: { Authorization: 'Bearer a' } });
  assert.deepEqual([patched.status, patched.body.state, patched.body.source.secrets], [200, 'unchecked', ['Authorization']]);
  assert.equal((await r.call(path)).status, 504);
  r.native.request = request as any;
  // 5. A name alone that cannot be kept: nothing changed, and that is the answer; the old name stays.
  await r.call(path, 'PATCH', { name: '远处' });
  r.store.save = () => { throw new Error('ENOSPC'); };
  const refused = await r.call(path, 'PATCH', { name: '更远' });
  assert.deepEqual([refused.status, refused.body.error], [500, '名字没能保存，请再试一次']);
  // With secrets the engine did take: the answer is the row, under the name it still has.
  const half = await r.call(path, 'PATCH', { name: '更远', secrets: { Authorization: 'Bearer b' } });
  assert.deepEqual([half.status, half.body.title], [200, '远处']);
  r.store.save = save;
  assert.equal((await r.call(path)).body.title, '远处');
});

test('这台电脑\'s entry lives in the same registry and is not one of the owner\'s apps: not listed, not readable, not changed or removed from 应用', async t => {
  const r = await setup(t);
  // As server/native/computer.ts registers it: an external MCP entry named `computer`, with its own per-cat block list.
  r.native.capabilities.push({ id: 'computer', type: 'mcp', source: 'external', enabled: true, mcpServer: { transport: 'stdio', command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver', args: ['mcp'] }, blockedCats: ['someone'] });
  assert.deepEqual((await r.call()).body.apps.map((a: any) => a.id), ['wechat']);
  for (const [method, body] of [['GET', undefined], ['PATCH', { name: '别的' }], ['PATCH', { secrets: { A: '1' } }], ['DELETE', undefined]] as const)
    assert.equal((await r.call('/custom%3Acomputer', method, body)).status, 404, method);
  // An app the owner happens to call "computer" is its own row under its own id; the entry is untouched by it and by its removal.
  const mine = await r.call('/custom', 'POST', { name: 'Computer', program: 'node', secrets: { A: '1' } });
  assert.match(nativeOf(mine.body), /^computer-[0-9a-f]{8}$/);
  assert.deepEqual((await r.call()).body.apps.map((a: any) => a.id), ['wechat', mine.body.id]);
  await r.call(`/${encodeURIComponent(mine.body.id)}`, 'DELETE');
  assert.deepEqual(r.native.capabilities, [{ id: 'computer', type: 'mcp', source: 'external', enabled: true, mcpServer: { transport: 'stdio', command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver', args: ['mcp'] }, blockedCats: ['someone'] }]);
  assert.equal(r.sent(/mcp\/computer(\?|\/|$)/).length, 0, 'nothing 应用 sends names that entry');
});
