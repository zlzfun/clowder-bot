import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { ApiError } from '../server/errors.js';
import { NativeFixture } from './native-fixture.js';
import { approvalLine, triggerWords } from '../server/native/approvals.js';

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
    if (options.method === 'POST' && !path.startsWith('/api/runtime-interactions/') && /\/(approve|reject)$/.test(path)) {
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

test('a request to change a timer is named as a change; a preference is approved as the content the hub listed, by its digest', async t => {
  const r = await setup(t), scope = '/bots/' + encodeURIComponent('快手') + '/approvals';
  // As the engine lists them since it proposes parameter updates (F139ApprovalAdapter) and digests what a preference approval covers (F221).
  r.native.approvalItems = [
    r.item('change', 'F139', { createdAt: 1000, summary: 'Update schedule: 喝水提醒', detail: { mutationKind: 'update', trigger: { type: 'interval', ms: 3600000 }, previousParams: { message: '喝水' }, params: { message: '喝温水' } } }),
    r.item('published', 'F221', { createdAt: 2000, summary: 'Taste: 先说结论', detail: { takeaway: '先说结论', decisionDigest: 'digest-1' } }),
    r.item('private', 'F221', { createdAt: 3000, summary: 'Taste: 简短', detail: { takeaway: '简短' } }),
  ];
  const { approvals } = await (await r.call(scope)).json() as any;
  assert.deepEqual(approvals.map((a: any) => [a.id, a.kind, a.title, a.body, a.approve?.label ?? null, a.reject?.label ?? null]), [
    ['change', 'schedule', '快手想改一个定时', '喝水提醒 · 每 1 小时 · 「喝水」改为「喝温水」', '改吧', '先不改'],
    ['published', 'preference', '快手想记住你的一个偏好', '先说结论', '记住', '不用记'],
    ['private', 'preference', '快手想记住你的一个偏好', '简短', '记住', '不用记'],
  ]);
  assert.equal(approvalLine(r.native.approvalItems[0]!), '改一个定时「喝水提醒」');
  const answer = (id: string, decision: string) => r.call(`${scope}/${id}`, 'POST', { decision, expectedThreadId: r.thread.id });
  for (const [id, decision] of [['published', 'approve'], ['private', 'approve'], ['published', 'reject'], ['change', 'approve']]) assert.equal((await answer(id!, decision!)).status, 200);
  assert.deepEqual(r.native.calls.filter(c => c.method === 'POST' && /\/(approve|reject)$/.test(c.path)).map(c => [c.path, c.body]), [
    ['/api/taste-proposals/published/approve', { decisionDigest: 'digest-1' }],
    ['/api/taste-proposals/private/approve', {}],
    ['/api/taste-proposals/published/reject', {}],
    ['/api/schedule-proposals/change/approve', {}],
  ]);
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

test('F306 question, approval, elicitation and conversation_decision are answered in chat with native validation and settlement verification', async t => {
  const r = await setup(t);
  const scope = '/bots/' + encodeURIComponent('快手');
  const qCardRef = { threadId: r.thread.id, messageId: 'm-q1', blockId: 'runtime-interaction:q1' };
  const aCardRef = { threadId: r.thread.id, messageId: 'm-a1', blockId: 'runtime-interaction:a1' };
  const eCardRef = { threadId: r.thread.id, messageId: 'm-e1', blockId: 'runtime-interaction:e1' };
  const uCardRef = { threadId: r.thread.id, messageId: 'm-u1', blockId: 'runtime-interaction:u1' };
  const cCardRef = { threadId: r.thread.id, messageId: 'm-c1', blockId: 'pick-c1', blockDigest: 'a'.repeat(64), publishedAt: 4000 };

  r.native.messages.set(r.thread.id, [
    {
      id: 'm-q1', type: 'assistant', catId: r.cat.id, content: '需要你回答：选环境', timestamp: 1000,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'q1', blockId: 'runtime-interaction:q1', requestKind: 'question' },
        rich: { v: 1, blocks: [{ id: 'runtime-interaction:q1', kind: 'card', v: 1, title: 'Codex 需要你的回答', tone: 'info', meta: { kind: 'runtime_interaction', interactionId: 'q1', interactionKind: 'question' } }] },
      },
    },
    {
      id: 'm-a1', type: 'assistant', catId: r.cat.id, content: '需要你确认：运行这条命令？', timestamp: 2000,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'a1', blockId: 'runtime-interaction:a1', requestKind: 'approval' },
        rich: { v: 1, blocks: [{ id: 'runtime-interaction:a1', kind: 'card', v: 1, title: '运行这条命令？', tone: 'warning', meta: { kind: 'runtime_interaction', interactionId: 'a1', interactionKind: 'approval' } }] },
      },
    },
    {
      id: 'm-e1', type: 'assistant', catId: r.cat.id, content: '需要你补充信息', timestamp: 3000,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'e1', blockId: 'runtime-interaction:e1', requestKind: 'elicitation' },
        rich: { v: 1, blocks: [{ id: 'runtime-interaction:e1', kind: 'card', v: 1, title: '补充账号信息', tone: 'info', meta: { kind: 'runtime_interaction', interactionId: 'e1', interactionKind: 'elicitation' } }] },
      },
    },
    {
      id: 'm-u1', type: 'assistant', catId: r.cat.id, content: '需要你打开链接', timestamp: 3500,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'u1', blockId: 'runtime-interaction:u1', requestKind: 'elicitation' },
        rich: { v: 1, blocks: [{ id: 'runtime-interaction:u1', kind: 'card', v: 1, title: '登录验证', tone: 'info', meta: { kind: 'runtime_interaction', interactionId: 'u1', interactionKind: 'elicitation' } }] },
      },
    },
    {
      id: 'm-c1', type: 'assistant', catId: r.cat.id, content: '需要你决定：周末安排', timestamp: 4000,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'c1', blockId: 'pick-c1', requestKind: 'conversation_decision' },
        rich: { v: 1, blocks: [{ id: 'pick-c1', kind: 'interactive', interactiveType: 'select', title: '周末去哪？', options: [{ id: 'park', label: '去公园' }, { id: 'other', label: '别的', customInput: true }] }] },
      },
    },
  ]);

  // Note: upstream F306ApprovalAdapter only puts `approval` (`a1`) in approval-hub/pending!
  r.native.approvalItems = [r.item('a1', 'F306', { createdAt: 2000, inlineApprovable: false, summary: '运行这条命令？', navigation: { state: 'anchored', approvalCardRef: { threadId: r.thread.id, messageId: 'm-a1' } } })];

  r.native.runtimeInteractions.set('q1', {
    status: 'pending', revision: 1, cardRef: qCardRef,
    request: {
      version: 1, interactionId: 'q1', kind: 'question', createdAt: 1000,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      provider: { providerId: 'openai', method: 'item/tool/requestUserInput', requestId: 1 },
      title: 'Codex 需要你的回答',
      questions: [
        { id: 'env', header: '环境', question: '跑在哪个环境？', options: [{ label: '测试' }, { label: '预发' }], isOther: true },
        { id: 'token', header: '密钥', question: '输入临时密钥', isSecret: true, allowUnanswered: true },
      ],
    },
  });
  r.native.runtimeInteractions.set('a1', {
    status: 'pending', revision: 1, cardRef: aCardRef,
    request: {
      version: 1, interactionId: 'a1', kind: 'approval', createdAt: 2000,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      provider: { providerId: 'openai', method: 'item/commandExecution/requestApproval', requestId: 2 },
      title: '运行这条命令？', description: 'npm test',
      decisions: [{ id: 'accept', label: '允许一次', outcome: 'accept' }, { id: 'decline', label: '拒绝', outcome: 'decline' }, { id: 'cancel', label: '拒绝并停止本轮', outcome: 'cancel' }],
    },
  });
  r.native.runtimeInteractions.set('e1', {
    status: 'pending', revision: 1, cardRef: eCardRef,
    request: {
      version: 1, interactionId: 'e1', kind: 'elicitation', mode: 'form', createdAt: 3000,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      provider: { providerId: 'openai', method: 'mcpServer/elicitation/request', requestId: 3 },
      title: '补充账号信息', message: '请填一下端口和开关',
      requestedSchema: {
        type: 'object', additionalProperties: false, required: ['port'],
        properties: { port: { type: 'integer', title: '端口', minimum: 1024, maximum: 65535 }, tls: { type: 'boolean', title: '启用加密', default: true } },
      },
      decisions: [{ id: 'accept', label: '提交', outcome: 'accept' }, { id: 'decline', label: '取消', outcome: 'decline' }],
    },
  });
  r.native.runtimeInteractions.set('u1', {
    status: 'pending', revision: 1, cardRef: uCardRef,
    request: {
      version: 1, interactionId: 'u1', kind: 'elicitation', mode: 'url', createdAt: 3500,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      provider: { providerId: 'openai', method: 'mcpServer/elicitation/request', requestId: 4 },
      title: '登录验证', message: '请在浏览器完成授权', elicitationId: 'el-1', url: 'https://example.com/auth',
      decisions: [{ id: 'accept', label: '我已完成', outcome: 'accept' }, { id: 'cancel', label: '先不授权', outcome: 'cancel' }],
    },
  });
  r.native.runtimeInteractions.set('c1', {
    status: 'pending', revision: 2, cardRef: cCardRef,
    request: {
      version: 1, interactionId: 'c1', kind: 'conversation_decision', createdAt: 4000, deadlineAt: 9999999999000,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      title: '周末去哪？',
      presentation: { id: 'pick-c1', kind: 'interactive', interactiveType: 'select', title: '周末去哪？', options: [{ id: 'park', label: '去公园' }, { id: 'other', label: '别的', customInput: true }] },
      allowTextResponse: true,
    },
  });

  // Activity discovers ALL pending F306 interactions (including question/elicitation/conversation_decision omitted by hub).
  const act = await (await r.call(`${scope}/activity`)).json();
  const actApprovals = act.items.filter((i: any) => i.kind === 'approval');
  assert.deepEqual(actApprovals.map((i: any) => i.proposalId).sort(), ['a1', 'c1', 'e1', 'q1', 'u1']);
  assert.equal(actApprovals.find((i: any) => i.proposalId === 'q1').label, '等你确认：Codex 需要你的回答');

  // Approvals list returns rich runtime prompts for every F306 kind.
  const list = await (await r.call(`${scope}/approvals`)).json();
  assert.deepEqual(list.approvals.map((a: any) => [a.id, a.runtime?.kind]), [['q1', 'question'], ['a1', 'approval'], ['e1', 'elicitation'], ['u1', 'elicitation'], ['c1', 'conversation']]);
  assert.equal(list.approvals.find((a: any) => a.id === 'c1').expiresAt, 9999999999000);

  // Transcript projects conversation_decision as card.approval (never plain choices) and runtime_interaction cards.
  const tr = await (await r.call(`${scope}/transcript`)).json();
  const c1Msg = tr.messages.find((m: any) => m.id === 'm-c1');
  assert.equal(c1Msg.blocks[0].kind, 'card');
  assert.equal(c1Msg.blocks[0].approval.id, 'c1');

  // Local validation rejects missing required answers and invalid form bounds before calling native.
  const badQ = await r.call(`${scope}/approvals/q1`, 'POST', { expectedThreadId: r.thread.id, response: { kind: 'answers', answers: { env: [], token: [] } } });
  assert.equal(badQ.status, 400);
  const badForm = await r.call(`${scope}/approvals/e1`, 'POST', { expectedThreadId: r.thread.id, response: { kind: 'decision', decisionId: 'accept', content: { port: 80 } } });
  assert.equal(badForm.status, 400);

  // Valid answers succeed and verify native settlement!
  const okQ = await r.call(`${scope}/approvals/q1`, 'POST', { expectedThreadId: r.thread.id, response: { kind: 'answers', answers: { env: ['预发'], token: [] } } });
  assert.equal(okQ.status, 200);
  assert.deepEqual(await okQ.json(), { id: 'q1', decision: 'approve', settled: true, state: 'approved', selected: ['预发'], summary: 'Codex 需要你的回答' });

  // Approval cannot use bare reject (409), must choose a decisionId.
  const bareRejectA = await r.call(`${scope}/approvals/a1`, 'POST', { expectedThreadId: r.thread.id, decision: 'reject' });
  assert.equal(bareRejectA.status, 409);
  const okA = await r.call(`${scope}/approvals/a1`, 'POST', { expectedThreadId: r.thread.id, response: { kind: 'decision', decisionId: 'cancel' } });
  assert.equal(okA.status, 200);
  assert.deepEqual(await okA.json(), { id: 'a1', decision: 'approve', settled: true, state: 'closed', selected: ['拒绝并停止本轮'], summary: '运行这条命令？' });

  // Form elicitation and URL elicitation.
  const okE = await r.call(`${scope}/approvals/e1`, 'POST', { expectedThreadId: r.thread.id, response: { kind: 'decision', decisionId: 'accept', content: { port: 8080, tls: true } } });
  assert.equal(okE.status, 200);
  assert.equal((await okE.json()).state, 'approved');
  const okU = await r.call(`${scope}/approvals/u1`, 'POST', { expectedThreadId: r.thread.id, response: { kind: 'decision', decisionId: 'accept' } });
  assert.equal(okU.status, 200);
  assert.equal((await okU.json()).state, 'approved');

  // Conversation decision checks expectedRevision (409 on stale) and succeeds when current.
  const staleC = await r.call(`${scope}/approvals/c1`, 'POST', { expectedThreadId: r.thread.id, expectedRevision: 1, response: { kind: 'selection', selectedIds: ['park'] } });
  assert.equal(staleC.status, 409);
  const okC = await r.call(`${scope}/approvals/c1`, 'POST', { expectedThreadId: r.thread.id, expectedRevision: 2, operationId: 'op-c1', response: { kind: 'selection', selectedIds: ['other'], customInput: '去爬山' } });
  assert.equal(okC.status, 200);
  assert.deepEqual(await okC.json(), { id: 'c1', decision: 'approve', settled: true, state: 'approved', selected: ['别的'], summary: '周末去哪？' });

  // Verify cardRef passed to native respond matches canonical cardRef (including blockDigest & publishedAt).
  const cCall = r.native.calls.find(c => c.path === '/api/runtime-interactions/c1/respond');
  assert.deepEqual(cCall?.body.cardRef, cCardRef);
  assert.equal(cCall?.body.expectedRevision, 2);
  assert.equal(cCall?.body.operationId, 'op-c1');

  // Settled readback via ?ids= and transcript shows exact terminal states and selected labels.
  const afterList = await (await r.call(`${scope}/approvals?ids=q1,a1,c1`)).json();
  assert.equal(afterList.approvals.length, 0);
  assert.deepEqual(afterList.settled, [
    { id: 'q1', state: 'approved', selected: ['预发'] },
    { id: 'a1', state: 'closed', selected: ['拒绝并停止本轮'] },
    { id: 'c1', state: 'approved', selected: ['别的'] },
  ]);
  const afterTr = await (await r.call(`${scope}/transcript`)).json();
  assert.equal(afterTr.messages.find((m: any) => m.id === 'm-q1').blocks[0].approval.state, 'approved');
  assert.deepEqual(afterTr.messages.find((m: any) => m.id === 'm-q1').blocks[0].approval.selected, ['预发']);
  assert.equal(afterTr.messages.find((m: any) => m.id === 'm-a1').blocks[0].approval.state, 'closed');
});

test('F306 question supports explicit reject, unsafe elicitation URL falls back to runtime panel, and cross-page settled receipts resolve on older pages', async t => {
  const r = await setup(t);
  const scope = '/bots/' + encodeURIComponent('快手');
  r.native.pageLimits.set(r.thread.id, 2);
  r.native.messages.set(r.thread.id, [
    {
      id: 'm-old-taste', type: 'assistant', catId: r.cat.id, content: '提议捕捉品味信号', timestamp: 1000,
      extra: { rich: { v: 1, blocks: [{ id: 'b-taste', kind: 'card', title: '提议捕捉品味信号', meta: { approval: { producerId: 'F221', canonicalProposalId: 'p-old' } } }] } },
    },
    {
      id: 'm-q-rej', type: 'assistant', catId: r.cat.id, content: '需要你回答', timestamp: 2000,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'q-rej', blockId: 'runtime-interaction:q-rej', requestKind: 'question' },
        rich: { v: 1, blocks: [{ id: 'runtime-interaction:q-rej', kind: 'card', title: '要继续吗？', meta: { kind: 'runtime_interaction', interactionId: 'q-rej', interactionKind: 'question' } }] },
      },
    },
    {
      id: 'm-bad-url', type: 'assistant', catId: r.cat.id, content: '需要你操作', timestamp: 3000,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'u-bad', blockId: 'runtime-interaction:u-bad', requestKind: 'elicitation' },
        rich: { v: 1, blocks: [{ id: 'runtime-interaction:u-bad', kind: 'card', title: '外部链接', meta: { kind: 'runtime_interaction', interactionId: 'u-bad', interactionKind: 'elicitation' } }] },
      },
    },
    {
      id: 'm-rcpt', type: 'connector', catId: null, content: '审批结果', timestamp: 4000,
      source: { connector: 'approval-hub', meta: { approvalDecisionReceipt: { kind: 'approval_decision_receipt', producerId: 'F221', canonicalProposalId: 'p-old', resolution: 'accepted', approvalCardRef: { threadId: r.thread.id, messageId: 'm-old-taste' } } } },
    },
  ]);
  r.native.settledApprovalItems = [{
    proposalId: 'p-old', sourceFeatureId: 'F221', status: 'approved',
    navigation: { state: 'anchored', approvalCardRef: { threadId: r.thread.id, messageId: 'm-old-taste' } },
  }];
  r.native.runtimeInteractions.set('q-rej', {
    status: 'pending', revision: 1, cardRef: { threadId: r.thread.id, messageId: 'm-q-rej', blockId: 'runtime-interaction:q-rej' },
    request: {
      version: 1, interactionId: 'q-rej', kind: 'question', createdAt: 2000,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      provider: { providerId: 'chrys', method: '_chrys/request_input', requestId: 1 },
      title: '要继续吗？', questions: [{ id: 'q0', header: '确认', question: '要继续吗？' }],
    },
  });
  r.native.runtimeInteractions.set('u-bad', {
    status: 'pending', revision: 1, cardRef: { threadId: r.thread.id, messageId: 'm-bad-url', blockId: 'runtime-interaction:u-bad' },
    request: {
      version: 1, interactionId: 'u-bad', kind: 'elicitation', mode: 'url', createdAt: 3000,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      provider: { providerId: 'openai', method: 'mcpServer/elicitation/request', requestId: 2 },
      title: '外部链接', message: '打开', elicitationId: 'el-2', url: 'javascript:alert(1)',
      decisions: [{ id: 'accept', label: '好', outcome: 'accept' }],
    },
  });

  const list = await (await r.call(`${scope}/approvals?ids=p-old`)).json();
  const unsafe = list.approvals.find((a: any) => a.id === 'u-bad');
  assert.equal(unsafe.approve, null);
  assert.match(unsafe.note, /运行面板/);
  assert.deepEqual(list.settled, [{ id: 'p-old', state: 'approved' }]);

  const rej = await r.call(`${scope}/approvals/q-rej`, 'POST', { expectedThreadId: r.thread.id, decision: 'reject' });
  assert.equal(rej.status, 200);
  assert.deepEqual(await rej.json(), { id: 'q-rej', decision: 'reject', settled: true, state: 'rejected', summary: '要继续吗？' });

  // Newest page notice carries receipt identity so the client can settle cards held on earlier pages.
  const newest = await (await r.call(`${scope}/transcript`)).json();
  const rcptRow = newest.messages.find((m: any) => m.id === 'm-rcpt');
  assert.deepEqual(rcptRow.receipt, { proposalId: 'p-old', producerId: 'F221', state: 'approved', cardMessageId: 'm-old-taste' });
  assert.equal(newest.hasMore, true);

  // Older page fetched via ?before= also resolves p-old from approval-hub/settled!
  const older = await (await r.call(`${scope}/transcript?before=${encodeURIComponent(newest.before)}`)).json();
  const oldCard = older.messages.find((m: any) => m.id === 'm-old-taste');
  assert.equal(oldCard.blocks[0].approval.state, 'approved');
});

test('F306 handles defaulted closed states, strict listView reads, >50 interactions, operationId retries, unclipped question options, and 1-option confirm', async t => {
  const r = await setup(t);
  const scope = '/bots/' + encodeURIComponent('快手');
  const msgs: any[] = [];
  for (let i = 1; i <= 55; i++) {
    const id = `q-many-${i}`;
    msgs.push({
      id: `m-${id}`, type: 'assistant', catId: r.cat.id, content: '问题', timestamp: i,
      extra: { runtimeInteractionCard: { version: 1, interactionId: id, blockId: `b-${id}`, requestKind: 'question' } },
    });
    r.native.runtimeInteractions.set(id, {
      status: 'pending', revision: 1, cardRef: { threadId: r.thread.id, messageId: `m-${id}`, blockId: `b-${id}` },
      request: {
        version: 1, interactionId: id, kind: 'question', createdAt: i,
        owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
        provider: { providerId: 'openai', method: 'item/tool/requestUserInput', requestId: i },
        title: `问题 ${i}`, questions: [{ id: 'q0', header: '项', question: `问题 ${i}`, options: [{ label: i === 55 ? 'A'.repeat(240) : '好' }] }],
      },
    });
  }
  msgs.push(
    {
      id: 'm-def', type: 'assistant', catId: r.cat.id, content: '超时默认', timestamp: 60,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'c-def', blockId: 'b-def', requestKind: 'conversation_decision' },
        rich: { v: 1, blocks: [{ id: 'b-def', kind: 'interactive', interactiveType: 'select', options: [{ id: 'yes', label: '默认项' }] }] },
      },
    },
    {
      id: 'm-one', type: 'assistant', catId: r.cat.id, content: '单项确认', timestamp: 61,
      extra: {
        runtimeInteractionCard: { version: 1, interactionId: 'c-one', blockId: 'b-one', requestKind: 'conversation_decision' },
        rich: { v: 1, blocks: [{ id: 'b-one', kind: 'interactive', interactiveType: 'confirm', options: [{ id: '__confirm__', label: '继续' }] }] },
      },
    },
    {
      id: 'm-retry', type: 'assistant', catId: r.cat.id, content: '重试确认', timestamp: 62,
      extra: { runtimeInteractionCard: { version: 1, interactionId: 'c-retry', blockId: 'b-retry', requestKind: 'conversation_decision' } },
    },
  );
  r.native.messages.set(r.thread.id, msgs);
  r.native.runtimeInteractions.set('c-def', {
    status: 'answered', revision: 2, cardRef: { threadId: r.thread.id, messageId: 'm-def', blockId: 'b-def' },
    terminal: { status: 'answered', reasonCode: 'defaulted', settledAt: 100, response: { kind: 'selection', selectedIds: ['yes'] } },
    request: {
      version: 1, interactionId: 'c-def', kind: 'conversation_decision', createdAt: 60,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      title: '默认关闭测试', presentation: { id: 'b-def', kind: 'interactive', interactiveType: 'select', options: [{ id: 'yes', label: '默认项' }] }, allowTextResponse: false,
    },
  });
  r.native.runtimeInteractions.set('c-one', {
    status: 'pending', revision: 1, cardRef: { threadId: r.thread.id, messageId: 'm-one', blockId: 'b-one' },
    request: {
      version: 1, interactionId: 'c-one', kind: 'conversation_decision', createdAt: 61,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      title: '单项确认', presentation: { id: 'b-one', kind: 'interactive', interactiveType: 'confirm', options: [{ id: '__confirm__', label: '继续' }] }, allowTextResponse: false,
    },
  });
  r.native.runtimeInteractions.set('c-retry', {
    status: 'pending', revision: 2,
    submission: {
      operationId: 'op-same', responseDigest: 'd', author: 'owner', claimedAt: 90,
      terminal: { status: 'answered', reasonCode: 'answered', settledAt: 90, response: { kind: 'selection', selectedIds: ['go'] }, operationId: 'op-same' },
    },
    cardRef: { threadId: r.thread.id, messageId: 'm-retry', blockId: 'b-retry' },
    request: {
      version: 1, interactionId: 'c-retry', kind: 'conversation_decision', createdAt: 62,
      owner: { userId: 'clowder-bot-owner', threadId: r.thread.id, catId: r.cat.id, invocationId: 'inv-1' },
      title: '重试确认', presentation: { id: 'b-retry', kind: 'interactive', interactiveType: 'select', options: [{ id: 'go', label: '继续' }] }, allowTextResponse: false,
    },
  });

  // >50 interactions are all read, question label >200 chars is unclipped, 1-option confirm stays 1 option, and defaulted is closed with no selected.
  const list = await (await r.call(`${scope}/approvals?ids=c-def`)).json();
  assert.equal(list.approvals.length, 57);
  const q55 = list.approvals.find((a: any) => a.id === 'q-many-55');
  assert.equal(q55.runtime.questions[0].options[0].label, 'A'.repeat(240));
  const cOne = list.approvals.find((a: any) => a.id === 'c-one');
  assert.deepEqual(cOne.runtime.options, [{ id: '__confirm__', label: '继续' }]);
  assert.deepEqual(list.settled, [{ id: 'c-def', state: 'closed' }]);
  const tr = await (await r.call(`${scope}/transcript`)).json();
  assert.equal(tr.messages.find((m: any) => m.id === 'm-def').blocks[0].approval.state, 'closed');
  assert.equal(tr.messages.find((m: any) => m.id === 'm-def').blocks[0].approval.selected, undefined);

  // Submitting unclipped >200 char question answer matches option index upstream.
  const longAns = await r.call(`${scope}/approvals/q-many-55`, 'POST', { expectedThreadId: r.thread.id, response: { kind: 'answers', answers: { q0: ['A'.repeat(240)] } } });
  assert.deepEqual(await longAns.json(), { id: 'q-many-55', decision: 'approve', settled: true, state: 'approved', selected: ['A'.repeat(240)], summary: '问题 55' });

  // Retrying conversation_decision with matching operationId and prior expectedRevision finishes submission cleanly.
  const retry = await r.call(`${scope}/approvals/c-retry`, 'POST', { expectedThreadId: r.thread.id, expectedRevision: 1, operationId: 'op-same', response: { kind: 'selection', selectedIds: ['go'] } });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { id: 'c-retry', decision: 'approve', settled: true, state: 'approved', selected: ['继续'], summary: '重试确认' });

  // Strict listView and Activity both reflect /api/runtime-interactions/:id 503 failures honestly!
  const origReq = r.native.request.bind(r.native);
  r.native.request = async (path: string, opts?: any) => {
    if (path === '/api/runtime-interactions/q-many-54') throw new ApiError(503, 'Clowder AI 请求中断');
    return origReq(path, opts);
  };
  const errRes = await r.call(`${scope}/approvals`);
  assert.equal(errRes.status, 503);
  const partialAct = await (await r.call(`${scope}/activity`)).json();
  assert.equal(partialAct.readStatus, 'partial');
  assert.ok(partialAct.errors.some((e: any) => e.source === 'runtime-interactions'));
  assert.equal(partialAct.counts.approval, 54, 'readable pending F306 interactions are preserved when one fails');
});
