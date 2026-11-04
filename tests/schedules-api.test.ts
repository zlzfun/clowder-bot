import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { ApiError } from '../server/errors.js';
import { nativeTrigger, scheduleStatus, type NativeSchedule } from '../server/native/schedules.js';
import type { NativeCat } from '../server/native/types.js';

const cat = { id: 'cat-a', name: '猫甲', displayName: '猫甲', roleDescription: '测试', configurationSource: 'native_tool', clientId: 'openai', defaultModel: '', mentionPatterns: [], color: { primary: '#888', secondary: '#eee' } } as NativeCat;
const sample = (override: Partial<NativeSchedule> = {}): NativeSchedule => ({
  id: 'dyn-task-a', source: 'dynamic', templateId: 'reminder', targetCatId: cat.id, prompt: '检查构建', deliveryThreadId: 'thread-current',
  trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Singapore' }, display: { label: '每日检查' },
  enabled: true, effectiveEnabled: true, registered: true, lastRun: null, runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 }, ...override,
});
class ScheduleFixture extends NativeFixture {
  schedules: NativeSchedule[] = [sample()];
  version: number | undefined = 1;
  ready = true;
  runs = [{ outcome: 'RUN_DELIVERED', started_at: '2026-11-04T00:00:00Z', error_summary: null, threadId: 'thread-current' }];
  constructor() {
    super(); this.cats = [cat, { ...cat, id: 'cat-b', name: '猫乙' }];
    this.threads.set('thread-current', { id: 'thread-current', preferredCats: [cat.id], createdAt: 1 });
  }
  override async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    if (!path.startsWith('/api/schedule/')) return super.request(path, options);
    this.calls.push({ path, method: options.method ?? 'GET', body: options.body });
    if (this.fail) throw this.fail;
    if (path === '/api/schedule/tasks' && !options.method) return structuredClone({ tasks: this.schedules, botScheduleVersion: this.version, botSchedulerReady: this.ready }) as T;
    if (options.method === 'POST') return { success: true, proposed: false, task: { id: 'dyn-created' } } as T;
    if (options.method === 'PATCH') return { success: true, enabled: options.body.enabled } as T;
    if (options.method === 'DELETE') return { success: true } as T;
    if (path.includes('/runs?')) return { runs: this.runs } as T;
    throw new Error('Unexpected schedule route');
  }
}
async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-schedules-test-')), native = new ScheduleFixture();
  const runtime = createApp({ native, dataFile: join(dir, 'presentation.json') });
  runtime.store.bot(cat.id).activeThreadId = 'thread-current';
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path = '', method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/xbot-api/bots/${encodeURIComponent(cat.name)}/routines${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  t.after(async () => { await runtime.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  return { ...runtime, native, call };
}
const input = () => ({ name: '检查', prompt: '检查构建并回报', schedule: { kind: 'daily', time: '09:30', timezone: 'Asia/Singapore' }, idempotencyKey: randomUUID() });

test('list reads native reminders for this cat, including old chats, without exposing internal/system tasks', async t => {
  const r = await setup(t);
  r.native.schedules.push(sample({ id: 'dyn-old', deliveryThreadId: 'old-thread' }), sample({ id: 'dyn-other', targetCatId: 'cat-b' }),
    sample({ id: 'hold-ball-internal' }), sample({ id: 'dyn-present', templateId: 'present-loop' }), sample({ id: 'builtin', source: 'builtin' }));
  const data = await (await r.call()).json();
  assert.deepEqual(data.routines.map((x: any) => x.id), ['dyn-task-a', 'dyn-old']);
  assert.equal(data.routines[0].currentThread, true); assert.equal(data.routines[1].currentThread, false);
  assert.equal(data.routines[1].threadId, 'old-thread');
  assert.equal('schedules' in r.store.state, false);
  r.native.version = undefined;
  assert.equal((await r.call()).status, 503, 'an old runtime cannot look like an empty working scheduler');
});

test('create binds native identity and current thread, passes stable retry key, never launches an Agent itself', async t => {
  const r = await setup(t), body = input();
  const response = await r.call('', 'POST', body); assert.equal(response.status, 201);
  assert.equal((await response.json()).id, 'dyn-created');
  const request = r.native.calls.find(c => c.path === '/api/schedule/tasks' && c.method === 'POST')!;
  assert.deepEqual(request.body, { templateId: 'reminder', trigger: { type: 'cron', expression: '30 9 * * *', timezone: 'Asia/Singapore' },
    params: { message: body.prompt, targetCatId: cat.id }, display: { label: body.name, category: 'system', description: body.prompt },
    deliveryThreadId: 'thread-current', botIdempotencyKey: body.idempotencyKey });
  assert.equal(r.native.calls.some(c => c.path === '/api/messages' && c.method === 'POST'), false);
  const postIndex = r.native.calls.indexOf(request);
  assert.equal(r.native.calls.length, postIndex + 1, 'no fallible re-read after committed creation');
  await r.call('', 'POST', body);
  assert.equal(r.native.calls.at(-1)?.body.botIdempotencyKey, body.idempotencyKey);
});

test('scheduler readiness gates creation and resume but still allows inspection, pause and deletion', async t => {
  const r = await setup(t); r.native.ready = false;
  assert.equal((await r.call('', 'POST', input())).status, 503);
  assert.equal((await r.call('/dyn-task-a', 'PATCH', { enabled: true })).status, 503);
  assert.equal((await r.call()).status, 200);
  assert.equal((await r.call('/dyn-task-a', 'PATCH', { enabled: false })).status, 200);
  assert.equal((await r.call('/dyn-task-a', 'DELETE')).status, 200);
  assert.equal(r.native.calls.some(c => c.method === 'POST'), false);
});

test('invalid time, zone, frequency and forged routing are rejected before native mutations', async t => {
  const r = await setup(t), body = input();
  for (const bad of [
    { ...body, targetCatId: 'cat-b' }, { ...body, deliveryThreadId: 'other' }, { ...body, trigger: { type: 'interval', ms: 1 } },
    { ...body, idempotencyKey: '' }, { ...body, name: '  ' }, { ...body, prompt: '' },
    { ...body, schedule: { kind: 'daily', time: '25:00', timezone: 'Asia/Singapore' } },
    { ...body, schedule: { kind: 'daily', time: '09:00', timezone: 'Mars/Olympus' } },
    { ...body, schedule: { kind: 'once', at: '2020-01-01T00:00:00Z' } },
    { ...body, schedule: { kind: 'once', at: '2027-01-01T09:00:00' } },
    { ...body, schedule: { kind: 'interval', minutes: 0 } }, { ...body, schedule: { kind: 'interval', minutes: 10081 } },
    { ...body, schedule: { kind: 'weekly', time: '09:00', timezone: 'UTC', days: [1,1] } },
  ]) assert.equal((await r.call('', 'POST', bad)).status, 400, JSON.stringify(bad));
  assert.equal(r.native.calls.some(c => c.method === 'POST'), false);
});

test('known timezone and repeat rules map to native triggers with no product-side clock', () => {
  assert.deepEqual(nativeTrigger({ kind: 'weekly', time: '00:05', days: [5, 0, 1], timezone: 'America/New_York' }), { type: 'cron', expression: '5 0 * * 0,1,5', timezone: 'America/New_York' });
  assert.deepEqual(nativeTrigger({ kind: 'interval', minutes: 60 }), { type: 'interval', ms: 3600000 });
  const at = new Date(Date.now() + 3600000).toISOString();
  assert.deepEqual(nativeTrigger({ kind: 'once', at }), { type: 'once', fireAt: Date.parse(at) });
});

test('pause, resume, delete and history enforce cat ownership and preserve native scope/errors', async t => {
  const r = await setup(t);
  r.native.schedules.push(sample({ id: 'dyn-other', targetCatId: 'cat-b' }));
  for (const method of ['PATCH','DELETE','GET']) assert.equal((await r.call('/dyn-other' + (method === 'GET' ? '/runs' : ''), method, method === 'PATCH' ? { enabled: false } : undefined)).status, 404);
  assert.equal((await r.call('/dyn-task-a', 'PATCH', { enabled: false })).status, 200);
  assert.deepEqual(r.native.calls.at(-1), { path: '/api/schedule/tasks/dyn-task-a', method: 'PATCH', body: { enabled: false } });
  assert.equal((await r.call('/dyn-task-a', 'PATCH', { enabled: true })).status, 200);
  assert.equal((await r.call('/dyn-task-a', 'PATCH', { enabled: true, cron: '* * * * *' })).status, 400);
  const history = await (await r.call('/dyn-task-a/runs')).json(); assert.equal(history.runs[0].outcome, 'RUN_DELIVERED');
  assert.equal(r.native.calls.at(-1)?.path, '/api/schedule/tasks/dyn-task-a/runs?threadId=thread-current&limit=50');
  assert.equal((await r.call('/dyn-task-a', 'DELETE')).status, 200);
  assert.equal(r.native.calls.at(-1)?.method, 'DELETE');
  r.native.fail = new ApiError(503, '原生运行时未连接');
  const failure = await r.call(); assert.equal(failure.status, 503); assert.equal((await failure.json()).error, '原生运行时未连接');
});

test('resume cannot fire an expired one-shot or deliver to an invalid member/thread; pause is still possible', async t => {
  const r = await setup(t);
  r.native.schedules[0] = sample({ trigger: { type: 'once', fireAt: Date.now()-1 }, enabled: false, registered: false });
  assert.equal((await r.call('/dyn-task-a','PATCH',{ enabled: true })).status, 409);
  r.native.schedules[0] = sample(); r.native.threads.get('thread-current')!.preferredCats = ['cat-b'];
  assert.equal((await r.call('/dyn-task-a','PATCH',{ enabled: true })).status, 409);
  assert.equal((await r.call('/dyn-task-a','PATCH',{ enabled: false })).status, 200);
  assert.equal((await r.call('', 'POST', input())).status, 409);
});

test('status distinguishes enabled, effective, registration and trigger delivery from job completion', () => {
  assert.equal(scheduleStatus(sample()), 'scheduled');
  assert.equal(scheduleStatus(sample({ enabled: false, registered: false })), 'paused');
  assert.equal(scheduleStatus(sample({ effectiveEnabled: false })), 'blocked');
  assert.equal(scheduleStatus(sample({ registered: false })), 'unregistered');
  for (const [outcome,status] of [['RUN_DELIVERED','delivered'],['RUN_FAILED','failed'],['SKIP_MISSED_WINDOW','missed']]) {
    assert.equal(scheduleStatus(sample({ trigger: { type: 'once', fireAt: 10 }, enabled: false, registered: false,
      lastRun: { outcome, started_at: '2026-01-01T00:00:00Z', error_summary: null } }), 20), status);
  }
});
