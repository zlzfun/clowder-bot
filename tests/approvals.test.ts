import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { NativeFixture } from './native-fixture.js';
import { triggerWords } from '../server/native/approvals.js';

// The hub as the pinned engine answers it: items plus the manifest that names
// each producer's decision route. The taste item is a trimmed copy of a real
// one read from an isolated runtime on 2026-11-11.
class HubNative extends NativeFixture {
  manifest: Array<Record<string, unknown>> = [
    { id: 'F221', decisionEndpointBase: '/api/taste-proposals' }, { id: 'F139', decisionEndpointBase: '/api/schedule-proposals' },
    { id: 'F231', decisionEndpointBase: '/api/profile-updates' }, { id: 'F306', decisionEndpointBase: null },
    { id: 'F999', decisionEndpointBase: '/api/cats' },
  ];
  decide?: (path: string) => void;
  override async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    if (path === '/api/approval-hub/pending') { this.calls.push({ path, method: 'GET' }); return structuredClone({ items: this.approvalItems, manifest: this.manifest }) as T; }
    if (options.method === 'POST' && /\/(approve|reject)$/.test(path)) {
      this.calls.push({ path, method: 'POST', body: options.body });
      this.decide?.(path);
      return { ok: true } as T;
    }
    return super.request(path, options);
  }
}
async function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-approvals-')), native = new HubNative();
  const app = createApp({ native, dataFile: join(dir, 'presentation.json') });
  const server = app.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/xbot-api${path}`, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => { await app.close(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const cat = await app.bridge.createBot({ name: '快手' }), thread = await app.bridge.direct(cat);
  const item = (proposalId: string, sourceFeatureId: string, more: Record<string, unknown> = {}) => ({
    proposalId, sourceFeatureId, requesterCatId: cat.id, resolution: 'open', inlineApprovable: true, decisionMode: 'approve-reject', createdAt: 1000,
    navigation: { state: 'anchored', approvalCardRef: { threadId: thread.id, messageId: 'card-' + proposalId } }, ...more });
  const decisions = () => native.calls.filter(c => c.method === 'POST' && /\/(approve|reject)$/.test(c.path)).map(c => c.path);
  return { ...app, native, call, cat, thread, item, decisions };
}

test('a native schedule trigger reads as a time of day, not an expression', () => {
  assert.equal(triggerWords({ type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' }), '每天 09:00（Asia/Shanghai）');
  assert.equal(triggerWords({ type: 'cron', expression: '30 18 * * 5,1,3' }), '每周一、周三、周五 18:30');
  assert.equal(triggerWords({ type: 'cron', expression: '*/5 * * * *' }), '按计划 */5 * * * *');
  assert.equal(triggerWords({ type: 'interval', ms: 30 * 60000 }), '每 30 分钟');
  assert.equal(triggerWords({ type: 'interval', ms: 120 * 60000 }), '每 2 小时');
  assert.equal(triggerWords({ type: 'interval', ms: 2880 * 60000 }), '每 2 天');
  assert.match(triggerWords({ type: 'once', fireAt: Date.UTC(2026, 10, 13, 1, 0) }), /11月13日/);
  assert.equal(triggerWords(undefined), '按设定的时间');
  // A one-off counted from the moment it is agreed to, as the engine writes it for "3 分钟后提醒我".
  assert.equal(triggerWords({ type: 'once', delayMs: 180000, relativeTo: 'approval' }), '同意后 3 分钟');
  assert.equal(triggerWords({ type: 'once', delayMs: 7200000 }), '2 小时后');
  assert.equal(triggerWords({ type: 'once', delayMs: 20000, relativeTo: 'approval' }), '同意后 1 分钟');
});

test('what waits for the owner in a chat is said in chat words; nothing is decided by reading', async t => {
  const r = await setup(t);
  r.native.approvalItems = [
    r.item('schedule', 'F139', { createdAt: 3000, summary: 'Create schedule: 喝水提醒', detail: { mutationKind: 'create', trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' } } }),
    r.item('taste', 'F221', { createdAt: 2000, expiresAt: 9000, summary: 'Taste [authentic-expression]: 用户偏好简短', detail: { takeaway: '用户偏好简短、结论优先的表达方式', quote: '我喜欢回答简短一点、先说结论' } }),
    r.item('profile', 'F231', { createdAt: 4000, inlineApprovable: false, summary: 'Profile update: 用户在上海工作', detail: { rationale: '用户在上海工作' } }),
    r.item('question', 'F306', { createdAt: 5000, summary: '要用哪个账号？' }),
    r.item('unroutable', 'F999', { createdAt: 6000, summary: '别的事' }),
    r.item('unknown', 'F777', { createdAt: 7000, summary: '没有登记去处的事' }),
    r.item('applying', 'F139', { createdAt: 8000, decisionMode: 'resume-only', summary: 'Delete schedule: 周报', detail: { mutationKind: 'delete', trigger: { type: 'interval', ms: 3600000 } } }),
    // Not shown here: settled, anchored elsewhere, or without a card in a chat.
    r.item('settled', 'F221', { resolution: 'approved' }),
    r.item('elsewhere', 'F221', { navigation: { state: 'anchored', approvalCardRef: { threadId: 'another-thread', messageId: 'm' } } }),
    r.item('floating', 'F221', { navigation: { state: 'unanchored' } }),
  ];
  const { threadId, approvals } = await (await r.call('/bots/' + encodeURIComponent('快手') + '/approvals')).json();
  assert.equal(threadId, r.thread.id);
  // The one-line status of the same conversation says them in everyday words too, not in the hub's own summaries.
  const waiting = (await (await r.call('/bots/' + encodeURIComponent('快手') + '/activity')).json()).items.filter((item: any) => item.kind === 'approval');
  assert.deepEqual(Object.fromEntries(waiting.map((item: any) => [item.proposalId, item.label])), {
    taste: '等你确认：记住你的一个偏好', schedule: '等你确认：设一个定时「喝水提醒」', profile: '等你确认：更新关于你的资料', question: '等你确认：要用哪个账号？',
    unroutable: '等你确认：别的事', unknown: '等你确认：没有登记去处的事', applying: '等你确认：取消一个定时「周报」' });
  assert.deepEqual(approvals.map((a: any) => [a.id, a.kind, a.title, a.body, a.approve?.label ?? null, a.reject?.label ?? null]), [
    ['taste', 'preference', '快手想记住你的一个偏好', '用户偏好简短、结论优先的表达方式', '记住', '不用记'],
    ['schedule', 'schedule', '快手想设一个定时', '喝水提醒 · 每天 09:00（Asia/Shanghai）', '设上', '不用'],
    ['profile', 'profile', '快手想更新关于你的资料', '用户在上海工作', null, '不用'],
    ['question', 'question', '快手有件事要问你', '要用哪个账号？', null, null],
    ['unroutable', 'other', '快手有件事等你确认', '别的事', null, null],
    ['unknown', 'other', '快手有件事等你确认', '没有登记去处的事', null, null],
    ['applying', 'schedule', '快手想取消一个定时', '周报 · 每 1 小时', null, '先留着'],
  ]);
  const taste = approvals[0];
  assert.deepEqual([taste.quote, taste.messageId, taste.state, taste.catName, taste.expiresAt], ['我喜欢回答简短一点、先说结论', 'card-taste', 'open', '快手', 9000]);
  assert.match(approvals[2].note, /运行面板/); assert.match(approvals[3].note, /运行面板/);
  assert.deepEqual(r.decisions(), [], 'reading decides nothing');
});

test('the owner’s answer goes to the route the hub names, once, and only for a request open in this chat', async t => {
  const r = await setup(t), scope = '/bots/' + encodeURIComponent('快手') + '/approvals/';
  const answer = async (id: string, decision: string, expectedThreadId = r.thread.id) => { const res = await r.call(scope + id, 'POST', { decision, expectedThreadId }); return [res.status, await res.json()] as const; };
  r.native.approvalItems = [r.item('taste', 'F221', { summary: 'x' }), r.item('profile', 'F231', { inlineApprovable: false, summary: 'y' }),
    r.item('unroutable', 'F999'), r.item('elsewhere', 'F221', { navigation: { state: 'anchored', approvalCardRef: { threadId: 'another-thread', messageId: 'm' } } })];
  // Native settles it: the hub no longer lists it.
  r.native.decide = path => { r.native.approvalItems = r.native.approvalItems.filter(i => !path.includes('/' + i.proposalId + '/')); };
  assert.deepEqual(await answer('taste', 'approve'), [200, { id: 'taste', decision: 'approve', settled: true }]);
  assert.deepEqual(r.decisions(), ['/api/taste-proposals/taste/approve']);
  assert.equal((await answer('taste', 'approve'))[0], 404, 'already handled');
  // A request that needs review elsewhere can still be declined here, not agreed to.
  const [refused, why] = await answer('profile', 'approve');
  assert.equal(refused, 409); assert.match(why.error, /运行面板/);
  r.native.decide = undefined; // accepted but still applying: it stays open and the answer says so
  assert.deepEqual(await answer('profile', 'reject'), [200, { id: 'profile', decision: 'reject', settled: false }]);
  // Never a route outside the proposal decisions, another conversation's request, or a stale chat.
  assert.equal((await answer('unroutable', 'approve'))[0], 409);
  assert.equal((await answer('unroutable', 'reject'))[0], 409);
  assert.equal((await answer('elsewhere', 'approve'))[0], 404);
  assert.equal((await answer('profile', 'reject', 'thread-old'))[0], 409);
  assert.equal((await r.call(scope + 'profile', 'POST', { decision: 'maybe', expectedThreadId: r.thread.id })).status, 400);
  assert.deepEqual(r.decisions(), ['/api/taste-proposals/taste/approve', '/api/profile-updates/profile/reject']);
});

test('a decision native could not apply is reported as not applied, with the native reason kept', async t => {
  const r = await setup(t), scope = '/bots/' + encodeURIComponent('快手') + '/approvals/';
  r.native.approvalItems = [r.item('taste', 'F221', { summary: 'x' })];
  r.native.decide = () => { throw new ApiError(500, 'Vignette write failed', { error: 'Vignette write failed', detail: 'Taste repository cannot find a checked-out refs/heads/main worktree' }); };
  const res = await r.call(scope + 'taste', 'POST', { decision: 'approve', expectedThreadId: r.thread.id }), body = await res.json();
  assert.equal(res.status, 500); assert.equal(body.error, '这一步没有成功，还没有生效');
  assert.match(body.native.detail, /refs\/heads\/main/);
  const still = await (await r.call('/bots/' + encodeURIComponent('快手') + '/approvals')).json();
  assert.equal(still.approvals[0].state, 'open', 'it is still waiting, not shown as done');
  // The runtime being unreachable keeps its own message.
  r.native.decide = () => { throw new ApiError(503, 'Clowder AI 请求中断'); };
  assert.equal((await (await r.call(scope + 'taste', 'POST', { decision: 'reject', expectedThreadId: r.thread.id })).json()).error, 'Clowder AI 请求中断');
});
