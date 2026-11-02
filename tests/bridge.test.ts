import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { ProductStore } from '../server/product-store.js';
import { NativeFixture } from './native-fixture.js';
import { NativeClient } from '../server/native/client.js';

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
test('stable message references survive edits, cancellation, pagination and bridge restart', async t => {
  const r = await setup(t), cat = await r.bridge.createBot({ name: 'Ada' }), thread = await r.bridge.direct(cat);
  const user = { id: 'native-u', type: 'user' as const, content: 'ask', catId: null, timestamp: 1000 };
  const reply = { id: 'native-r', type: 'assistant' as const, content: 'draft', catId: cat.id, timestamp: 2000, replyTo: user.id, lifecycle: { kind: 'response', status: 'processing' } };
  r.native.messages.set(thread.id, [user, reply]);
  const page = await r.bridge.transcript(cat), replyRow = page.messages.find(m => m.id === reply.id)!;
  const seq = replyRow.seq; assert.equal(replyRow.reply_to, page.messages[0]!.seq);
  r.native.messages.set(thread.id, [{ ...reply, content: 'final', lifecycle: { kind: 'response', status: 'canceled' } }]);
  assert.equal((await r.bridge.transcript(cat)).messages[0]!.seq, seq);
  const reopened = new ProductStore(join(r.dir, 'presentation.json'));
  assert.equal(reopened.messageId(thread.id, seq as number), reply.id);
  await r.bridge.send(thread, { text: 'followup', reply_to: seq as number }, cat);
  assert.equal(r.native.calls.at(-1)?.body.replyTo, reply.id);
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
  assert.deepEqual(patch.cliConfigArgs, []); assert.equal(patch.expectedRevision, cat.configurationRevision);
  assert.equal((await r.bridge.direct(cat)).id, thread.id);
});
