import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
const runtime = resolve(root, process.env.BOT_TASK_TEST_RUNTIME || lock.build);
const native = path => import(pathToFileURL(resolve(runtime, 'packages/api/dist', path)).href);
const { TaskStore } = await native('domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await native('domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = await native('domains/cats/services/stores/ports/ThreadStore.js');
const { InMemoryTurnExecutionStore } = await native('domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js');
const { ordinaryTaskExpectation } = await native('domains/cats/services/stores/ports/OrdinaryTaskMutation.js');
const { TaskBackgroundRuntime } = await native('domains/cats/services/background/TaskBackgroundRuntime.js');
const { OrdinaryTaskHandoffService } = await native('domains/ball-custody/OrdinaryTaskHandoffService.js');
const { sdkTaskHooks } = await native('domains/cats/services/agents/providers/claude-sdk-task-hooks.js');
const { serializeTask, hydrateTask } = await native('domains/cats/services/stores/redis/RedisTaskCodec.js');

async function fixture(taskStore) {
  const tasks = taskStore ?? new TaskStore(), messages = new MessageStore(), threads = new ThreadStore();
  const thread = await threads.create('task-user', 'background controls', '/fixture');
  const source = await messages.append({ from: { kind: 'user', userId: 'task-user' }, userId: 'task-user', threadId: thread.id, content: 'Run independent tasks', mentions: ['opus'], timestamp: Date.now() });
  const scope = { userId: 'task-user', catId: 'opus', threadId: thread.id, invocationId: 'invocation-main', parentInvocationId: 'queue-main' };
  const stops = [], changed = [];
  const manager = new TaskBackgroundRuntime({ tasks, changed: task => changed.push(task), released: () => {} });
  const lane = manager.attach(scope, async id => { stops.push(id); });
  async function make(title, parentTaskId) {
    const task = await tasks.create({ userId: scope.userId, threadId: thread.id, title, why: '', ownerCatId: scope.catId, createdBy: scope.catId, sourceMessageId: source.id, ...(parentTaskId ? { delegatedFromTaskId: parentTaskId } : {}) });
    const result = await tasks.mutateOrdinaryTask({ kind: 'update', taskId: task.id, expected: ordinaryTaskExpectation(task), actor: scope, input: { status: 'doing' }, execution: { ...scope, sourceMessageId: source.id } });
    assert.equal(result.kind, 'updated');
    return result.task;
  }
  async function start(task, id) {
    await lane.reserve(task.id, `tool-${id}`, 'session');
    await lane.observe({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `tool-${id}`, session_id: 'session' });
    return tasks.get(task.id);
  }
  const end = (id, status = 'completed') => lane.observe({ type: 'system', subtype: 'task_notification', task_id: id, status, session_id: 'session', summary: `${id} result`, output_file: `/tmp/${id}.txt` });
  const control = (task, action) => manager.control(task.id, scope.userId, { action, expectedOwnerRevision: task.ownerRevision ?? 0, expectedAttemptId: task.backgroundExecution?.attemptId ?? null });
  return { tasks, messages, threads, thread, source, scope, stops, changed, manager, lane, make, start, end, control };
}

test('one native parent, two Tasks: stop only A; receipt is distinct from request', async () => {
  const f = await fixture();
  const a = await f.start(await f.make('A'), 'a'), b = await f.start(await f.make('B'), 'b');
  const result = await f.control(a, 'stop');
  assert.equal(result.task.backgroundExecution.state, 'stopping');
  assert.deepEqual(f.stops, ['a']);
  assert.equal(f.tasks.get(b.id).backgroundExecution.state, 'running');
  assert.equal(await f.manager.isStopped(a.executionRef, f.scope.userId), false);
  await f.end('a', 'stopped');
  assert.equal(await f.manager.isStopped(a.executionRef, f.scope.userId), true);
  assert.equal(f.tasks.get(a.id).status, 'blocked');
  assert.equal(f.tasks.get(b.id).backgroundExecution.state, 'running');
  assert.equal(f.manager.ownsInvocation(f.scope.invocationId), true);
});

test('stop before task_started persists; exact child is stopped once its identity arrives', async () => {
  const f = await fixture(), task = await f.make('launch race');
  await f.lane.reserve(task.id, 'tool-race', 'session');
  await f.control(f.tasks.get(task.id), 'stop');
  assert.deepEqual(f.stops, []);
  await f.lane.observe({ type: 'system', subtype: 'task_started', task_id: 'race', tool_use_id: 'tool-race', session_id: 'wrong-session' });
  assert.deepEqual(f.stops, []);
  await f.lane.observe({ type: 'system', subtype: 'task_started', task_id: 'race', tool_use_id: 'tool-race', session_id: 'session' });
  assert.deepEqual(f.stops, ['race']);
  assert.equal(f.tasks.get(task.id).backgroundExecution.state, 'stopping');
});

test('native handoff waits for A, changes owner exactly once, never tears down parent or B', async () => {
  const f = await fixture();
  const a = await f.start(await f.make('handoff A'), 'a'), b = await f.start(await f.make('unrelated B'), 'b');
  const turns = new InMemoryTurnExecutionStore();
  turns.createRunning({ ...f.scope, executionKind: 'ordinary', startedAt: Date.now() });
  let parentCancels = 0;
  const handoffs = new OrdinaryTaskHandoffService({ tasks: f.tasks, messages: f.messages, threads: f.threads, turns,
    tracker: { cancelExact() { parentCancels++; } },
    subexecutionIsStopped: (ref, user) => f.manager.isStopped(ref, user),
    isSharedInvocation: ref => f.manager.ownsInvocation(ref.invocationId),
    stopExecution: (ref, user) => f.manager.stopRef(ref, user),
  });
  const request = await handoffs.prepare({ taskId: a.id, expectedOwnerRevision: a.ownerRevision, actor: f.scope, targetCatId: 'sonnet', targetThreadId: f.thread.id, stopPrevious: true });
  const source = await f.messages.append({ from: { kind: 'agent', catId: 'opus' }, userId: f.scope.userId, threadId: f.thread.id, content: 'Take over A', mentions: ['sonnet'], origin: 'callback', timestamp: Date.now(), extra: { taskHandoff: request } });
  assert.equal((await handoffs.apply(source.id)).kind, 'waiting');
  assert.equal(parentCancels, 0);
  await f.end('a', 'stopped');
  assert.equal((await handoffs.apply(source.id)).kind, 'applied');
  assert.equal((await handoffs.apply(source.id)).kind, 'replayed');
  assert.equal(f.tasks.get(a.id).ownerCatId, 'sonnet');
  assert.equal(f.tasks.get(a.id).ownerRevision, 1);
  assert.equal(f.tasks.get(b.id).backgroundExecution.state, 'running');
  assert.equal(turns.get(f.scope.invocationId).status, 'running');
  assert.equal(turns.get(f.scope.invocationId).providerTeardownAt, undefined);
  const next = { ...f.scope, catId: 'sonnet', invocationId: 'new-owner-invocation', parentInvocationId: 'new-owner-queue' };
  await handoffs.start(source.id, next, next.parentInvocationId);
  const current = f.tasks.get(a.id);
  const progress = await f.tasks.mutateOrdinaryTask({ kind: 'update', taskId: a.id, expected: ordinaryTaskExpectation(current), actor: next, input: { status: 'doing' }, execution: current.executionRef });
  assert.equal(progress.kind, 'updated');
  const nextLane = f.manager.attach(next, async () => {});
  await nextLane.reserve(a.id, 'new-owner-tool', 'new-owner-session');
  assert.notEqual(f.tasks.get(a.id).backgroundExecution.attemptId, a.backgroundExecution.attemptId);
  await f.end('a'); // late completion cannot reopen / complete transferred work
  assert.equal(f.tasks.get(a.id).ownerCatId, 'sonnet');
  assert.notEqual(f.tasks.get(a.id).status, 'done');
});

test('unbound Task handoff refuses before attempting broad parent cancellation', async () => {
  const f = await fixture(), task = await f.make('unbound');
  let canceled = 0;
  const service = new OrdinaryTaskHandoffService({ tasks: f.tasks, messages: f.messages, threads: f.threads, turns: new InMemoryTurnExecutionStore(), tracker: { cancelExact() { canceled++; } }, isSharedInvocation: () => true });
  const request = await service.prepare({ taskId: task.id, expectedOwnerRevision: 0, actor: f.scope, targetCatId: 'sonnet', targetThreadId: f.thread.id, stopPrevious: true });
  const msg = await f.messages.append({ userId: f.scope.userId, from: { kind: 'agent', catId: 'opus' }, threadId: f.thread.id, content: 'transfer', mentions: ['sonnet'], origin: 'callback', timestamp: Date.now(), extra: { taskHandoff: request } });
  assert.deepEqual(await service.apply(msg.id), { kind: 'refused', reason: 'background_task_binding_required' });
  assert.equal(canceled, 0);
});

async function userOwnedHandoff(taskStore) {
  const f = await fixture(taskStore);
  const original = await f.messages.append({ from: { kind: 'user', userId: f.scope.userId }, userId: f.scope.userId, threadId: f.thread.id, content: 'User-assigned work without an issuer mention', mentions: [], timestamp: Date.now() });
  const task = await f.tasks.create({ userId: f.scope.userId, threadId: f.thread.id, title: 'user-created transfer', why: '', createdBy: 'user', ownerCatId: 'opus', sourceMessageId: original.id });
  const service = new OrdinaryTaskHandoffService({ tasks: f.tasks, messages: f.messages, threads: f.threads, turns: new InMemoryTurnExecutionStore() });
  const request = await service.prepare({ taskId: task.id, expectedOwnerRevision: 0, actor: f.scope, targetCatId: 'sonnet', targetThreadId: f.thread.id });
  const source = await f.messages.append({ from: { kind: 'agent', catId: 'opus' }, userId: f.scope.userId, threadId: f.thread.id, content: 'take over', mentions: ['sonnet'], origin: 'callback', timestamp: Date.now(), extra: { taskHandoff: request } });
  assert.equal((await service.apply(source.id)).kind, 'applied');
  const next = { ...f.scope, catId: 'sonnet', invocationId: 'successor', parentInvocationId: 'successor-parent' };
  return { ...f, task, original, service, source, request, next };
}

test('user-created Task handoff replays and starts the successor using the original assignment authority', async () => {
  const f = await userOwnedHandoff();
  assert.equal((await f.service.apply(f.source.id)).kind, 'replayed');
  assert.equal(await f.service.start(f.source.id, f.next, f.next.parentInvocationId), f.task.id);
  const current = await f.tasks.get(f.task.id);
  assert.equal(current.ownerCatId, 'sonnet'); assert.equal(current.ownerRevision, 1);
  assert.equal(current.executionRef.invocationId, f.next.invocationId);
});

test('committed handoff cannot replay a withdrawn handoff or withdrawn original authorization', async () => {
  for (const which of ['source', 'original']) {
    const f = await userOwnedHandoff();
    await f.messages.softDelete(f[which].id, f.scope.userId);
    await assert.rejects(f.service.start(f.source.id, f.next, f.next.parentInvocationId), /task_handoff_source_mismatch|task_authorization_source_unavailable/);
    assert.equal((await f.tasks.get(f.task.id)).executionRef, undefined);
  }
});

test('committed handoff rejects owner ABA and a successor removed from the roster', async t => {
  const f = await userOwnedHandoff();
  await f.tasks.update(f.task.id, { ownerCatId: 'opus' });
  await f.tasks.update(f.task.id, { ownerCatId: 'sonnet' });
  await assert.rejects(f.service.start(f.source.id, f.next, f.next.parentInvocationId), /task_assignment_changed/);
  const g = await userOwnedHandoff();
  await g.threads.updatePreferredCats(g.thread.id, ['opus']);
  const before = process.env.CAT_CAFE_ENFORCE_THREAD_PARTICIPANTS;
  t.after(() => { if (before === undefined) delete process.env.CAT_CAFE_ENFORCE_THREAD_PARTICIPANTS; else process.env.CAT_CAFE_ENFORCE_THREAD_PARTICIPANTS = before; });
  process.env.CAT_CAFE_ENFORCE_THREAD_PARTICIPANTS = '1';
  await assert.rejects(g.service.start(g.source.id, g.next, g.next.parentInvocationId), /task_target_not_member/);
  assert.equal((await g.tasks.get(g.task.id)).executionRef, undefined);
});

test('real Redis user-created handoff survives reload and starts its successor', { skip: !process.env.BOT_TASK_TEST_REDIS_URL }, async t => {
  const url = new URL(process.env.BOT_TASK_TEST_REDIS_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.ok(url.port && !['6379', '6392'].includes(url.port));
  const Redis = createRequire(resolve(runtime, 'packages/api/package.json'))('ioredis');
  const redis = new Redis(url.href, { keyPrefix: `bot-handoff-replay:${randomUUID()}:` });
  t.after(() => redis.quit());
  const { RedisTaskStore } = await native('domains/cats/services/stores/redis/RedisTaskStore.js');
  const f = await userOwnedHandoff(new RedisTaskStore(redis));
  const service = new OrdinaryTaskHandoffService({ tasks: new RedisTaskStore(redis), messages: f.messages, threads: f.threads, turns: new InMemoryTurnExecutionStore() });
  assert.equal(await service.start(f.source.id, f.next, f.next.parentInvocationId), f.task.id);
  assert.equal((await f.tasks.get(f.task.id)).executionRef.invocationId, 'successor');
});

test('handoff host cannot use its new-task exception for old, foreign, unbound or transferred Tasks', async t => {
  const before = process.env.CAT_CAFE_BOT_TASK_CONTROL;
  process.env.CAT_CAFE_BOT_TASK_CONTROL = '1';
  t.after(() => { if (before === undefined) delete process.env.CAT_CAFE_BOT_TASK_CONTROL; else process.env.CAT_CAFE_BOT_TASK_CONTROL = before; });
  const { updateOrdinaryTaskFromCallback } = await native('routes/callback-ordinary-task-update.js');
  const f = await userOwnedHandoff();
  const record = { ...f.next, createdAt: Date.now()-1, originTriggerMessageId: f.source.id };
  const sibling = await f.tasks.create({ userId: f.scope.userId, threadId: f.thread.id, title: 'new sibling', why: '', createdBy: 'sonnet', ownerCatId: 'sonnet', sourceMessageId: f.source.id, initialExecutionRef: { ...f.next, sourceMessageId: f.source.id } });
  for (const patch of [{ createdAt: record.createdAt-1 }, { userId: 'other' }, { threadId: 'other' }, { createdBy: 'opus' }, { ownerCatId: 'opus' }, { ownerRevision: 2 }, { executionRef: undefined }, { executionRef: { ...sibling.executionRef, invocationId: 'older-invocation' } }, { sourceMessageId: 'other' }, { lastAppliedHandoffMessageRef: 'message:newer-handoff' }]) {
    const result = await updateOrdinaryTaskFromCallback({ task: { ...sibling, ...patch }, record, data: { status: 'doing' }, expectedOwnerRevision: 0, tasks: f.tasks, messages: f.messages, fence: { assertCurrent: async () => {} } });
    assert.equal(result.kind, 'refused', JSON.stringify(patch));
  }
  const result = await updateOrdinaryTaskFromCallback({ task: sibling, record, data: { status: 'doing' }, expectedOwnerRevision: 0, tasks: f.tasks, messages: f.messages, fence: { assertCurrent: async () => { await f.messages.softDelete(f.source.id, f.scope.userId); } } }).then(x=>x,e=>e);
  assert.match(result.message,/task_source_withdrawn/);
  assert.equal((await f.tasks.get(sibling.id)).status, 'todo');
});

test('three-level Task cancellation fences new descendants and leaves a sibling running', async () => {
  const f = await fixture();
  const rootTask = await f.start(await f.make('root'), 'root');
  const child = await f.start(await f.make('child', rootTask.id), 'child');
  const grandchild = await f.start(await f.make('grandchild', child.id), 'grandchild');
  const unrelated = await f.start(await f.make('independent'), 'independent');
  await f.control(rootTask, 'cancel');
  assert.deepEqual(new Set(f.stops), new Set(['root', 'child', 'grandchild']));
  assert.equal(f.tasks.get(unrelated.id).backgroundExecution.state, 'running');
  assert.ok(f.tasks.get(rootTask.id).backgroundCancelledAt);
  assert.equal(f.tasks.get(child.id).backgroundCancelledAt, undefined, 'ancestor cancellation does not overwrite independent child dispositions');
  const late = await f.make('late child', grandchild.id);
  await assert.rejects(f.lane.reserve(late.id, 'late', 'session'), /task_ancestor_not_open/);
  await assert.rejects(f.manager.authorizeParentCreation(rootTask.id, f.scope), /task_not_open/);
});

test('unknown on host loss survives serialization and cannot be reported stopped or resumed', async () => {
  const f = await fixture(), a = await f.start(await f.make('lost'), 'a');
  await f.lane.close();
  const lost = f.tasks.get(a.id);
  assert.equal(lost.backgroundExecution.state, 'unknown');
  assert.equal(await f.manager.isStopped(lost.executionRef, f.scope.userId), false);
  assert.deepEqual(hydrateTask(serializeTask(lost)).backgroundExecution, lost.backgroundExecution);
  await assert.rejects(f.control(lost, 'resume'), /background_control_unavailable/);
});

test('stale attempt, stale owner revision, foreign tenant and premature business completion are refused', async () => {
  const f = await fixture(), a = await f.start(await f.make('protected'), 'a');
  const input = { action: 'stop', expectedOwnerRevision: 0, expectedAttemptId: a.backgroundExecution.attemptId };
  await assert.rejects(f.manager.control(a.id, 'other-user', input), /task_not_found/);
  await assert.rejects(f.manager.control(a.id, f.scope.userId, { ...input, expectedAttemptId: 'old' }), /task_assignment_changed/);
  await assert.rejects(f.manager.control(a.id, f.scope.userId, { ...input, expectedOwnerRevision: 1 }), /task_assignment_changed/);
  const done = await f.tasks.mutateOrdinaryTask({ kind: 'update', taskId: a.id, expected: ordinaryTaskExpectation(a), actor: f.scope, input: { status: 'done' } });
  assert.equal(done.kind, 'refused');
  await f.end('a');
  assert.equal(f.tasks.get(a.id).status, 'doing');
  assert.equal(f.tasks.get(a.id).backgroundExecution.state, 'completed');
});

test('SDK hook admits a verified native Task, rejects missing binding and inherited child callbacks', async () => {
  const f = await fixture(), a = await f.make('hook');
  const hook = sdkTaskHooks(f.lane, () => true).PreToolUse[0].hooks[0];
  const base = { hook_event_name: 'PreToolUse', session_id: 'session', tool_name: 'Agent', tool_use_id: 'tool-a', tool_input: { description: `[task:${a.id}] work`, run_in_background: true } };
  assert.deepEqual(await hook(base), {});
  assert.equal(f.tasks.get(a.id).backgroundExecution.state, 'starting');
  assert.equal((await hook({ ...base, tool_input: { description: 'unbound', run_in_background: true } })).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await hook({ ...base, agent_id: 'child', tool_name: 'mcp__cat_cafe__cat_cafe_update_task' })).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await hook({ ...base, agent_id: 'child', tool_name: 'Bash', tool_input: { command: 'sleep 1', run_in_background: true } })).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hook({ ...base, agent_id: 'child', tool_name: 'Bash', tool_input: { command: 'echo work' } }), {});
});

test('two cats cannot atomically claim the same unassigned native Task', async () => {
  const f = await fixture();
  const t = await f.tasks.create({ userId: f.scope.userId, threadId: f.thread.id, title: 'claim race', why: '', createdBy: 'user' });
  const claims = await Promise.all(['opus', 'sonnet'].map(catId => f.tasks.mutateOrdinaryTask({ kind: 'update', taskId: t.id, expected: ordinaryTaskExpectation(t), actor: { ...f.scope, catId }, input: { status: 'doing' } })));
  assert.equal(claims.filter(r => r.kind === 'updated').length, 1);
  assert.equal(claims.filter(r => r.kind === 'refused').length, 1);
});

test('real Redis preserves stop proof, restart uncertainty, and cancellation fences', { skip: !process.env.BOT_TASK_TEST_REDIS_URL }, async t => {
  const url = new URL(process.env.BOT_TASK_TEST_REDIS_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.ok(url.port && !['6379', '6392'].includes(url.port), 'Use a separately owned acceptance Redis, never production/default');
  const requireNative = createRequire(resolve(runtime, 'packages/api/package.json'));
  const Redis = requireNative('ioredis');
  const redis = new Redis(url.href, { keyPrefix: `bot-task-acceptance:${randomUUID()}:` });
  t.after(() => redis.quit()); // Retain this isolated evidence; no FLUSH or deletion.
  const { RedisTaskStore } = await native('domains/cats/services/stores/redis/RedisTaskStore.js');
  const f = await fixture(new RedisTaskStore(redis));
  const a = await f.start(await f.make('persisted A'), 'a');
  await f.control(a, 'cancel');
  await f.end('a', 'stopped');
  const rebuilt = new TaskBackgroundRuntime({ tasks: new RedisTaskStore(redis) });
  assert.equal(await rebuilt.isStopped(a.executionRef, f.scope.userId), true);
  const saved = await rebuilt.deps.tasks.get(a.id);
  assert.ok(saved.backgroundCancelledAt);
  assert.equal(saved.backgroundStopReason, 'user');
  assert.equal(saved.backgroundExecution.sdkTaskId, 'a');
  const b = await f.start(await f.make('lost B'), 'b');
  await rebuilt.reconcileThread(f.thread.id);
  assert.equal((await rebuilt.deps.tasks.get(b.id)).backgroundExecution.state, 'unknown');
  assert.equal(await rebuilt.isStopped(b.executionRef, f.scope.userId), false);
  const reopened = await rebuilt.control(a.id, f.scope.userId, { action: 'resume', expectedOwnerRevision: saved.ownerRevision, expectedAttemptId: saved.backgroundExecution.attemptId });
  assert.equal(reopened.task.backgroundCancelledAt, undefined);
  assert.equal((await new RedisTaskStore(redis).get(a.id)).backgroundExecution.stopRequestedAt, undefined);
});

test('failed child observation and exact stop transport do not tear down sibling host', async () => {
  const f = await fixture();
  const a = await f.start(await f.make('A'), 'a');
  const b = await f.start(await f.make('B'), 'b');
  await f.lane.observe({ type: 'system', subtype: 'task_started', tool_use_id: 'tool-a', task_id: 'changed-id', session_id: 'session' });
  assert.equal(f.manager.ownsInvocation(f.scope.invocationId), true);
  assert.equal(f.tasks.get(b.id).backgroundExecution.state, 'running');
  const isolated = new TaskBackgroundRuntime({ tasks: f.tasks });
  const lane = isolated.attach(f.scope, async () => { throw new Error('stop transport failed'); });
  await isolated.control(a.id, f.scope.userId, { action: 'stop', expectedOwnerRevision: 0, expectedAttemptId: a.backgroundExecution.attemptId });
  assert.equal(f.tasks.get(a.id).backgroundExecution.state, 'unknown');
  assert.equal(isolated.ownsInvocation(f.scope.invocationId), true);
  await lane.observe({ type: 'system', subtype: 'task_notification', task_id: 'b', status: 'completed', session_id: 'session' });
  assert.equal(f.tasks.get(b.id).backgroundExecution.state, 'completed');
});

test('launch failure releases reserved attempt; stop fences remain until explicit resume', async () => {
  const f = await fixture(), task = await f.make('launch failure');
  await f.lane.reserve(task.id, 'tool-failed', 'session');
  await f.lane.launchFailed('tool-failed', 'wrong');
  assert.equal(f.tasks.get(task.id).backgroundExecution.state, 'starting');
  await f.lane.launchFailed('tool-failed', 'session');
  assert.equal(f.tasks.get(task.id).backgroundExecution.state, 'failed');
  await f.lane.reserve(task.id, 'tool-retry', 'session');
  await f.control(f.tasks.get(task.id), 'stop');
  await f.lane.launchFailed('tool-retry', 'session');
  await assert.rejects(() => f.lane.reserve(task.id, 'tool-blocked', 'session'));
  await f.control(f.tasks.get(task.id), 'resume');
  const current = f.tasks.get(task.id);
  await f.tasks.mutateOrdinaryTask({ kind: 'update', taskId: task.id, expected: ordinaryTaskExpectation(current), actor: f.scope, input: { status: 'doing' }, execution: current.executionRef });
  await f.lane.reserve(task.id, 'tool-after-resume', 'session');
});

test('unknown requires exact proof; worker_restart from same session recovers after invocation restart', async () => {
  const f = await fixture(), a = await f.start(await f.make('restart A'), 'a');
  await f.lane.close();
  const fresh = new TaskBackgroundRuntime({ tasks: f.tasks });
  const lane = fresh.attach({ ...f.scope, invocationId: 'new-invocation' }, async () => {});
  await lane.observe({ type: 'system', subtype: 'task_notification', task_id: 'a', session_id: 'wrong', status: 'stopped', reason: 'worker_restart' });
  assert.equal(f.tasks.get(a.id).backgroundExecution.state, 'unknown');
  await lane.observe({ type: 'system', subtype: 'task_notification', task_id: 'a', session_id: 'session', status: 'stopped', reason: 'worker_restart' });
  assert.equal(f.tasks.get(a.id).backgroundExecution.state, 'stopped');
  const g = await fixture(), b = await g.start(await g.make('restart B'), 'b');
  await g.lane.close();
  const proven = new TaskBackgroundRuntime({ tasks: g.tasks, executionIsStopped: async (ref, user) => ref.invocationId === g.scope.invocationId && user === g.scope.userId });
  assert.equal(await proven.isStopped(b.executionRef, g.scope.userId), true);
});

test('unrelated broken lineage cannot block subtree stop; normal cross-cat descendants reuse exact execution stop', async () => {
  const f = await fixture(), parent = await f.start(await f.make('parent'), 'parent');
  const child = await f.make('ordinary child', parent.id);
  await f.tasks.create({ userId: f.scope.userId, threadId: f.thread.id, title: 'unrelated', why: '', ownerCatId: 'sonnet', createdBy: 'sonnet', delegatedFromTaskId: 'missing-parent' });
  await f.end('parent'); // The coordinator child has finished; the delegated ordinary execution remains.
  // A historical broken lineage is permitted in the store, but never admitted to a new launch.
  const stops = [];
  const manager = new TaskBackgroundRuntime({ tasks: f.tasks, stopExecution: async (ref, user) => stops.push({ ref, user }), executionIsStopped: async ref => stops.some(stop => stop.ref.invocationId === ref.invocationId) });
  const result = await manager.control(parent.id, f.scope.userId, { action: 'cancel', expectedOwnerRevision: 0, expectedAttemptId: parent.backgroundExecution.attemptId });
  assert.deepEqual(result.unconfirmedTaskIds, []);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].ref.invocationId, child.executionRef.invocationId);
  assert.equal(f.tasks.get(child.id).backgroundStopOwnerTaskId, parent.id);
});

test('main can yield an unstarted Task while parent stays active; messages cannot resurrect completed children', async () => {
  const f = await fixture(), task = await f.make('yield');
  const yielded = await f.tasks.mutateOrdinaryTask({ kind: 'update', taskId: task.id, expected: ordinaryTaskExpectation(task), actor: f.scope, input: { status: 'todo' } });
  assert.equal(yielded.kind, 'updated'); assert.equal(yielded.task.executionRef, null);
  const b = await f.start(await f.make('B'), 'b');
  assert.equal(await f.lane.canMessage('b'), true);
  await f.end('b');
  assert.equal(await f.lane.canMessage('b'), false);
  const hook = sdkTaskHooks(f.lane, () => true).PreToolUse[0].hooks[0];
  const decision = await hook({ hook_event_name: 'PreToolUse', session_id: 'session', tool_use_id: 'child-stop', agent_id: 'child', tool_name: 'TaskStop', tool_input: { task_id: 'b' } }, undefined, { signal: new AbortController().signal });
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
});

test('native owner control requires a session, rejects stale attempts, and returns exact Task receipt', async t => {
  const Fastify = createRequire(resolve(runtime, 'packages/api/package.json'))('fastify');
  const { registerTaskBackgroundRoutes } = await native('routes/task-background-routes.js');
  const f = await fixture(), a = await f.start(await f.make('HTTP A'), 'a');
  const app = Fastify(); t.after(() => app.close());
  app.decorateRequest('sessionUserId', null);
  app.addHook('preHandler', async req => { if (req.headers.cookie === 'test-session') req.sessionUserId = f.scope.userId; });
  registerTaskBackgroundRoutes(app, f.manager);
  const request = { method: 'POST', url: `/api/tasks/${a.id}/background-control`, payload: { action: 'stop', expectedOwnerRevision: 0, expectedAttemptId: a.backgroundExecution.attemptId } };
  assert.equal((await app.inject({ ...request, headers: { 'x-cat-cafe-user': f.scope.userId } })).statusCode, 401);
  assert.equal((await app.inject({ ...request, headers: { cookie: 'test-session' }, payload: { ...request.payload, expectedAttemptId: 'old' } })).statusCode, 409);
  const response = await app.inject({ ...request, headers: { cookie: 'test-session' } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().task.backgroundExecution.state, 'stopping');
  assert.deepEqual(f.stops, ['a']);
});

test('real callback creates linked Task and stops only its authenticated owner attempt', async t => {
  const { taskNativeCallbackFixture } = await import(pathToFileURL(resolve(runtime, 'packages/api/test/helpers/task-native-callback-fixture.js')).href);
  const { installTaskBackgroundRuntime } = await native('domains/cats/services/background/TaskBackgroundRuntime.js');
  const f = await taskNativeCallbackFixture(t);
  const auth = await f.registry.create('native-user', 'codex', f.home.id);
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const scope = { userId: 'native-user', catId: 'codex', threadId: f.home.id, invocationId: auth.invocationId, parentInvocationId: auth.invocationId };
  const stops = [];
  const manager = new TaskBackgroundRuntime({ tasks: f.tasks }); installTaskBackgroundRuntime(manager);
  const lane = manager.attach(scope, async id => stops.push(id));
  const created = await f.app.inject({ method: 'POST', url: '/api/callbacks/create-task', headers, payload: { title: 'linked child', why: 'test', parentTaskId: f.task.id } });
  assert.equal(created.statusCode, 201, created.body);
  const child = (await f.tasks.listByThread(f.home.id)).find(task => task.title === 'linked child');
  assert.equal(child.delegatedFromTaskId, f.task.id);
  const doing = await f.app.inject({ method: 'POST', url: '/api/callbacks/update-task', headers, payload: { taskId: child.id, status: 'doing', expectedOwnerRevision: child.ownerRevision } });
  assert.equal(doing.statusCode, 200, doing.body);
  await lane.reserve(child.id, 'tool-child', 'session');
  await lane.observe({ type: 'system', subtype: 'task_started', task_id: 'child-sdk', tool_use_id: 'tool-child', session_id: 'session' });
  const current = await f.tasks.get(child.id);
  const result = await f.app.inject({ method: 'POST', url: '/api/callbacks/update-task', headers, payload: { taskId: child.id, expectedOwnerRevision: current.ownerRevision, executionControl: { action: 'cancel', expectedAttemptId: current.backgroundExecution.attemptId } } });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(stops, ['child-sdk']);
  const unauth = await f.registry.create('native-user', 'sonnet', f.home.id);
  const denied = await f.app.inject({ method: 'POST', url: '/api/callbacks/update-task', headers: { 'x-invocation-id': unauth.invocationId, 'x-callback-token': unauth.callbackToken }, payload: { taskId: child.id, expectedOwnerRevision: current.ownerRevision, executionControl: { action: 'stop', expectedAttemptId: current.backgroundExecution.attemptId } } });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('resuming a root waits for descendants, and source withdrawal denies new launch', async () => {
  const f = await fixture(), root = await f.start(await f.make('root'), 'root');
  const child = await f.start(await f.make('child', root.id), 'child');
  await f.control(root, 'cancel'); await f.end('root', 'stopped');
  await assert.rejects(() => f.control(f.tasks.get(root.id), 'resume'), /task_descendant_stop_unproven/);
  await f.end('child', 'stopped'); await f.control(f.tasks.get(root.id), 'resume');
  assert.equal(f.tasks.get(child.id).backgroundStopRequestedAt, undefined);
  const g = await fixture(), task = await g.make('withdrawn');
  const manager = new TaskBackgroundRuntime({ tasks: g.tasks, messages: { getById: async () => ({ ...g.source, deletedAt: Date.now() }) } });
  const lane = manager.attach(g.scope, async () => {});
  await assert.rejects(() => lane.reserve(task.id, 'tool', 'session'), /task_source_withdrawn/);
});

test('coordinator handoff with no own execution still waits for its delegated child', async () => {
  const f = await fixture(), parent = await f.make('coordinator');
  const released = await f.tasks.mutateOrdinaryTask({ kind: 'update', taskId: parent.id, expected: ordinaryTaskExpectation(parent), actor: f.scope, input: { status: 'todo' } });
  const child = await f.start(await f.make('delegated', parent.id), 'child');
  const ref = await f.manager.handoffBarrier(released.task, true);
  assert.equal(ref.subexecutionId, child.executionRef.subexecutionId);
  assert.deepEqual(f.stops, ['child']);
  await f.end('child', 'stopped');
  assert.equal(await f.manager.handoffBarrier(f.tasks.get(parent.id), true), undefined);
  await assert.rejects(() => f.manager.authorizeParentCreation(parent.id, f.scope), /task_not_open/);
});

test('three levels use native create-task, post-message handoff and Queue; cancellation follows linked tasks', async t => {
  const before = process.env.CAT_CAFE_BOT_TASK_CONTROL;
  process.env.CAT_CAFE_BOT_TASK_CONTROL = '1';
  t.after(() => { if (before === undefined) delete process.env.CAT_CAFE_BOT_TASK_CONTROL; else process.env.CAT_CAFE_BOT_TASK_CONTROL = before; });
  const { taskNativeCallbackFixture } = await import(pathToFileURL(resolve(runtime, 'packages/api/test/helpers/task-native-callback-fixture.js')).href);
  const { installTaskBackgroundRuntime } = await native('domains/cats/services/background/TaskBackgroundRuntime.js');
  const f = await taskNativeCallbackFixture(t), stopped = [];
  await f.threads.addParticipants(f.home.id, ['sonnet', 'opus']);
  const manager = new TaskBackgroundRuntime({ tasks: f.tasks }); installTaskBackgroundRuntime(manager);
  async function actor(cat, source) {
    const auth = await f.registry.create('native-user', cat, f.home.id, undefined, source);
    const scope = { userId: 'native-user', catId: cat, threadId: f.home.id, invocationId: auth.invocationId, parentInvocationId: auth.invocationId };
    await f.turns.createRunning({ ...scope, executionKind: 'ordinary', startedAt: Date.now() });
    return { scope, headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken }, lane: manager.attach(scope, async id => stopped.push(id)) };
  }
  const a = await actor('codex');
  async function delegate(from, parent, target, title) {
    const created = await f.app.inject({ method: 'POST', url: '/api/callbacks/create-task', headers: from.headers, payload: { title, parentTaskId: parent.id, ownerCatId: target } });
    assert.equal(created.statusCode, 201, created.body);
    const task = created.json().task;
    const dispatched = await f.app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers: from.headers, payload: {
      content: `Implement ${title}`, targetCats: [target], clientMessageId: randomUUID(),
      action: { subjectRef: `subject:task:${task.id}`, actionFamily: 'implement', successorSlot: 'implementer', mode: 'single', terminalPredicate: { kind: 'task_done' }, expectedOwnerRevision: task.ownerRevision },
    } });
    assert.equal(dispatched.statusCode, 200, dispatched.body);
    const source = dispatched.json().messageId, next = await actor(target, source);
    const started = await f.handoffs.start(source, next.scope, next.scope.parentInvocationId);
    assert.equal(started, task.id);
    const doing = await f.app.inject({ method: 'POST', url: '/api/callbacks/update-task', headers: next.headers, payload: { taskId: task.id, status: 'doing', expectedOwnerRevision: task.ownerRevision } });
    assert.equal(doing.statusCode, 200, doing.body);
    return { task: await f.tasks.get(task.id), ...next };
  }
  const b = await delegate(a, f.task, 'sonnet', 'child B');
  const c = await delegate(b, b.task, 'opus', 'grandchild C');
  const createdSibling = await f.app.inject({ method: 'POST', url: '/api/callbacks/create-task', headers: c.headers, payload: { title: 'independent U', ownerCatId: 'opus' } });
  assert.equal(createdSibling.statusCode, 201, createdSibling.body);
  const sibling = createdSibling.json().task;
  const updateSibling = status => f.app.inject({ method: 'POST', url: '/api/callbacks/update-task', headers: c.headers, payload: { taskId: sibling.id, status, expectedOwnerRevision: 0 } });
  delete process.env.CAT_CAFE_BOT_TASK_CONTROL;
  assert.equal((await updateSibling('doing')).statusCode, 409, 'native behavior unchanged with Bot feature off');
  process.env.CAT_CAFE_BOT_TASK_CONTROL = '1';
  const siblingStarted = await updateSibling('doing');
  assert.equal(siblingStarted.statusCode, 200, siblingStarted.body);
  await c.lane.reserve(sibling.id, 'tool-u', 'session-c');
  await c.lane.observe({ type: 'system', subtype: 'task_started', tool_use_id: 'tool-u', task_id: 'u', session_id: 'session-c' });
  for (const [who, name] of [[b, 'b'], [c, 'c']]) {
    await who.lane.reserve(who.task.id, `tool-${name}`, `session-${name}`);
    await who.lane.observe({ type: 'system', subtype: 'task_started', tool_use_id: `tool-${name}`, task_id: name, session_id: `session-${name}` });
  }
  assert.equal(f.queue.list(f.home.id, 'native-user').length, 2);
  assert.equal((await f.tasks.get(c.task.id)).delegatedFromTaskId, b.task.id);
  await manager.control(f.task.id, 'native-user', { action: 'cancel', expectedOwnerRevision: 0, expectedAttemptId: null });
  assert.deepEqual(stopped.sort(), ['b', 'c']);
  assert.equal((await f.tasks.get(sibling.id)).backgroundExecution.state, 'running');
  await c.lane.observe({ type: 'system', subtype: 'task_notification', task_id: 'u', session_id: 'session-c', status: 'completed' });
  const siblingDone = await updateSibling('done');
  assert.equal(siblingDone.statusCode, 200, siblingDone.body);
  assert.equal((await f.tasks.get(sibling.id)).status, 'done');
  assert.equal((await f.tasks.get(f.task.id)).ownerCatId, 'codex');
  assert.equal((await f.tasks.get(b.task.id)).ownerCatId, 'sonnet');
  assert.equal((await f.tasks.get(c.task.id)).ownerCatId, 'opus');
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});

test('native child launch cannot silently resume an old SDK agent or escape into remote/team execution', async () => {
  const f = await fixture(), task = await f.make('local launch');
  const hook = sdkTaskHooks(f.lane, () => true).PreToolUse[0].hooks[0];
  for (const extra of [{ resume: 'old-child' }, { isolation: 'remote' }, { team_name: 'team' }]) {
    const decision = await hook({ hook_event_name: 'PreToolUse', session_id: 'session', tool_use_id: randomUUID(), tool_name: 'Agent', tool_input: { description: `[task:${task.id}] bounded work`, run_in_background: true, ...extra } }, undefined, { signal: new AbortController().signal });
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(f.tasks.get(task.id).backgroundExecution, undefined);
});

test('same-owner handoff clears only handoff stop intent, and releases delegated handoff stops', async () => {
  const f = await fixture(), root = await f.start(await f.make('same-owner'), 'a');
  const child = await f.start(await f.make('child', root.id), 'b');
  await f.manager.stopRef(root.executionRef, f.scope.userId);
  assert.equal(f.tasks.get(root.id).backgroundStopReason, 'handoff');
  await f.end('a', 'stopped'); await f.end('b', 'stopped');
  let current = f.tasks.get(root.id);
  await f.tasks.mutateOrdinaryTask({ kind: 'release_execution', taskId: root.id, expected: ordinaryTaskExpectation(current), execution: current.executionRef });
  current = f.tasks.get(root.id);
  const handoff = await f.tasks.mutateOrdinaryTask({ kind: 'handoff', taskId: root.id, expected: ordinaryTaskExpectation(current), ownerCatId: current.ownerCatId, messageRef: 'message:self-transfer' });
  assert.equal(handoff.kind, 'updated');
  assert.equal(handoff.task.backgroundStopRequestedAt, undefined);
  assert.equal(handoff.task.backgroundExecution.stopRequestedAt, undefined);
  await f.manager.completeHandoff(handoff.task);
  assert.equal(f.tasks.get(child.id).backgroundStopRequestedAt, undefined);
  assert.equal(f.tasks.get(child.id).backgroundExecution.stopRequestedAt, undefined);
});

test('a non-SDK invocation shared by unrelated Tasks cannot be cancelled through one Task', async () => {
  const f = await fixture(), a = await f.make('A'), b = await f.make('B');
  let kills = 0;
  const manager = new TaskBackgroundRuntime({ tasks: f.tasks, stopExecution: async () => { kills++; } });
  assert.equal(await manager.sharesInvocation(a.executionRef), true);
  const result = await manager.control(a.id, f.scope.userId, { action: 'cancel', expectedOwnerRevision: 0, expectedAttemptId: null });
  assert.deepEqual(result.unconfirmedTaskIds, [a.id]); assert.equal(kills, 0);
  assert.equal(f.tasks.get(b.id).backgroundStopRequestedAt, undefined);
});

test('repeated unknown reads are silent; interrupted launch remains unproven until exact receipt', async () => {
  const f = await fixture(), a = await f.start(await f.make('A'), 'a');
  await f.lane.close();
  let notifications = 0;
  const manager = new TaskBackgroundRuntime({ tasks: f.tasks, changed: () => notifications++ });
  const before = f.tasks.get(a.id).updatedAt;
  await manager.reconcileThread(f.thread.id); await manager.reconcileThread(f.thread.id);
  assert.equal(notifications, 0); assert.equal(f.tasks.get(a.id).updatedAt, before);
  const g = await fixture(), pending = await g.make('interrupted');
  await g.lane.reserve(pending.id, 'tool-race', 'session'); await g.lane.launchFailed('tool-race', 'session', true);
  assert.equal(g.tasks.get(pending.id).backgroundExecution.state, 'unknown');
  await g.lane.observe({ type: 'system', subtype: 'task_started', task_id: 'late', tool_use_id: 'tool-race', session_id: 'session' });
  assert.equal(g.tasks.get(pending.id).backgroundExecution.state, 'running');
});


test('a human stop during handoff cannot be cleared by owner transfer or descendant cleanup', async () => {
  const f = await fixture(), root = await f.start(await f.make('root'), 'a');
  const child = await f.start(await f.make('child', root.id), 'b');
  await f.manager.stopRef(root.executionRef, f.scope.userId);
  await f.control(f.tasks.get(child.id), 'stop');
  await f.control(f.tasks.get(root.id), 'stop');
  await f.end('a', 'stopped'); await f.end('b', 'stopped');
  let current = f.tasks.get(root.id);
  await f.tasks.mutateOrdinaryTask({ kind: 'release_execution', taskId: root.id, expected: ordinaryTaskExpectation(current), execution: current.executionRef });
  current = f.tasks.get(root.id);
  const result = await f.tasks.mutateOrdinaryTask({ kind: 'handoff', taskId: root.id, expected: ordinaryTaskExpectation(current), ownerCatId: 'sonnet', messageRef: 'message:user-stop-race' });
  assert.equal(result.kind, 'refused');
  await f.manager.completeHandoff(current);
  assert.equal(f.tasks.get(child.id).backgroundStopReason, 'user');
  assert.equal(f.tasks.get(child.id).backgroundStopOwnerTaskId, child.id);
});


test('resuming a parent preserves a later independent cancellation of its child', async () => {
  const f = await fixture(), root = await f.start(await f.make('root'), 'a');
  const child = await f.start(await f.make('child', root.id), 'b');
  await f.control(root, 'stop');
  await f.control(f.tasks.get(child.id), 'cancel');
  assert.equal(f.tasks.get(child.id).backgroundStopOwnerTaskId, child.id);
  await f.end('a', 'stopped'); await f.end('b', 'stopped');
  await f.control(f.tasks.get(root.id), 'resume');
  assert.ok(f.tasks.get(child.id).backgroundCancelledAt);
  assert.ok(f.tasks.get(child.id).backgroundStopRequestedAt);
  const lateParentResume = await f.tasks.mutateOrdinaryTask({ kind: 'background_control', taskId: child.id, expected: ordinaryTaskExpectation(f.tasks.get(child.id)), userId: f.scope.userId, action: 'resume', originTaskId: root.id, expectedAttemptId: child.backgroundExecution.attemptId });
  assert.equal(lateParentResume.kind, 'refused');
});

test('stopping a lost host explicitly reports unconfirmed delivery', async () => {
  const f = await fixture(), task = await f.start(await f.make('lost'), 'a');
  await f.lane.close();
  const result = await f.control(f.tasks.get(task.id), 'stop');
  assert.deepEqual(result.unconfirmedTaskIds, [task.id]);
  assert.equal(result.task.backgroundExecution.state, 'unknown');
});

async function handoffFixture(f, task) {
  let withdrawn = false;
  const handoffs = new OrdinaryTaskHandoffService({ tasks: f.tasks,
    messages: { getById: async id => { const message = await f.messages.getById(id); return message && withdrawn && message.extra?.taskHandoff ? { ...message, deletedAt: Date.now() } : message; } },
    threads: f.threads, turns: new InMemoryTurnExecutionStore(),
    subexecutionIsStopped: (ref, user) => f.manager.isStopped(ref, user),
    isSharedInvocation: ref => f.manager.sharesInvocation(ref),
    stopExecution: (ref, user, source) => f.manager.stopRef(ref, user, source),
    taskTreeHandoffBarrier: (task, stop, source) => f.manager.handoffBarrier(task, stop, source),
    onHandoffApplied: task => f.manager.completeHandoff(task),
    onHandoffRefused: source => f.manager.abortHandoff(source),
  });
  const request = await handoffs.prepare({ taskId: task.id, expectedOwnerRevision: 0, actor: f.scope, targetCatId: 'sonnet', targetThreadId: f.thread.id, stopPrevious: true });
  const source = await f.messages.append({ from: { kind: 'agent', catId: 'opus' }, userId: f.scope.userId, threadId: f.thread.id, content: 'handoff fixture', mentions: ['sonnet'], origin: 'callback', timestamp: Date.now(), extra: { taskHandoff: request } });
  return { handoffs, source, request, withdraw: () => { withdrawn = true; } };
}

test('handoff success preserves a descendant blocked for business reasons', async () => {
  const f = await fixture(), root = await f.start(await f.make('root'), 'a');
  let child = await f.start(await f.make('await input', root.id), 'b');
  await f.tasks.mutateOrdinaryTask({ kind: 'update', taskId: child.id, expected: ordinaryTaskExpectation(child), actor: f.scope, input: { status: 'blocked' } });
  const h = await handoffFixture(f, root);
  assert.equal((await h.handoffs.apply(h.source.id)).kind, 'waiting');
  await f.end('a', 'stopped'); await f.end('b', 'stopped');
  assert.equal((await h.handoffs.apply(h.source.id)).kind, 'applied');
  child = await f.tasks.get(child.id);
  assert.equal(child.status, 'blocked');
  assert.equal(child.backgroundStopRequestedAt, undefined);
  assert.equal(child.backgroundHandoffMessageRef, undefined);
});

test('withdrawn handoff waits for every stop receipt then cleans only its own markers', async () => {
  const f = await fixture(), root = await f.start(await f.make('root'), 'a');
  const child = await f.start(await f.make('child', root.id), 'b');
  const sibling = await f.start(await f.make('unrelated'), 'c');
  const h = await handoffFixture(f, root);
  assert.equal((await h.handoffs.apply(h.source.id)).kind, 'waiting');
  h.withdraw(); assert.equal((await h.handoffs.apply(h.source.id)).kind, 'refused');
  assert.ok(f.tasks.get(root.id).backgroundHandoffAbortedAt);
  assert.ok(f.tasks.get(child.id).backgroundHandoffAbortedAt);
  await f.end('a', 'stopped'); assert.ok(f.tasks.get(root.id).backgroundStopRequestedAt);
  await f.end('b', 'stopped');
  for (const id of [root.id, child.id]) {
    const task = f.tasks.get(id);
    assert.equal(task.backgroundStopRequestedAt, undefined); assert.equal(task.backgroundHandoffAbortedAt, undefined);
    assert.equal(task.status, 'doing'); assert.equal(task.backgroundExecution.state, 'stopped');
  }
  assert.equal(f.tasks.get(root.id).ownerCatId, 'opus');
  assert.equal(f.tasks.get(sibling.id).backgroundExecution.state, 'running');
  assert.deepEqual(f.stops.sort(), ['a', 'b']);
});

test('failed handoff cleanup survives codec/recovery and preserves later user cancellation', async () => {
  const f = await fixture(), root = await f.start(await f.make('root'), 'a');
  const child = await f.start(await f.make('child', root.id), 'b');
  const h = await handoffFixture(f, root);
  await h.handoffs.apply(h.source.id); h.withdraw(); await h.handoffs.apply(h.source.id);
  const persisted = hydrateTask(serializeTask(f.tasks.get(root.id)));
  assert.equal(persisted.backgroundHandoffMessageRef, `message:${h.source.id}`);
  assert.ok(persisted.backgroundHandoffAbortedAt);
  await f.control(f.tasks.get(child.id), 'cancel');
  await f.lane.close();
  let proven = false;
  const recovered = new TaskBackgroundRuntime({ tasks: f.tasks, executionIsStopped: async () => proven });
  await recovered.reconcileThread(f.thread.id);
  assert.ok(f.tasks.get(root.id).backgroundStopRequestedAt);
  proven = true; await recovered.reconcileThread(f.thread.id);
  assert.equal(f.tasks.get(root.id).backgroundStopRequestedAt, undefined);
  assert.ok(f.tasks.get(child.id).backgroundCancelledAt);
  assert.equal(f.tasks.get(child.id).backgroundStopReason, 'user');
  assert.equal(f.tasks.get(child.id).backgroundStopOwnerTaskId, child.id);
});

test('handoff recovery is fenced by exact source and cannot clear a newer handoff', async () => {
  const f = await fixture(), root = await f.start(await f.make('root'), 'a');
  await f.manager.stopRef(root.executionRef, f.scope.userId, 'message:new-transfer');
  await f.manager.abortHandoff('old-transfer');
  assert.equal(f.tasks.get(root.id).backgroundHandoffAbortedAt, undefined);
  await f.end('a', 'stopped');
  const result = await f.tasks.mutateOrdinaryTask({ kind: 'background_control', taskId: root.id, expected: ordinaryTaskExpectation(f.tasks.get(root.id)), userId: f.scope.userId, action: 'resume', expectedAttemptId: root.backgroundExecution.attemptId, handoff: true, originTaskId: root.id, handoffMessageRef: 'message:old-transfer' });
  assert.equal(result.kind, 'refused');
  assert.equal(f.tasks.get(root.id).backgroundHandoffMessageRef, 'message:new-transfer');
});

test('persisted native handoff schema retains the exact background subexecution reference', async () => {
  const { ordinaryTaskHandoffRequestSchema } = await native('domains/ball-custody/OrdinaryTaskHandoffContract.js');
  const f = await fixture(), task = await f.start(await f.make('handoff'), 'a');
  const h = await handoffFixture(f, task);
  const persisted = ordinaryTaskHandoffRequestSchema.parse(JSON.parse(JSON.stringify(h.request)));
  assert.equal(persisted.expected.executionRef.subexecutionId, task.backgroundExecution.attemptId);
});

test('native discovery projects only thread roster profiles without claiming they are active', async t => {
  const requireNative = createRequire(resolve(runtime, 'packages/api/package.json'));
  const Fastify = requireNative('fastify');
  const { catRegistry } = await import(pathToFileURL(resolve(runtime, 'packages/shared/dist/index.js')).href);
  const { registerCallbackThreadCatsRoutes } = await native('routes/callback-thread-cats-routes.js');
  const { registerCallbackAuthHook } = await native('routes/callback-auth-prehandler.js');
  const app = Fastify(); t.after(() => app.close());
  const before = process.env.CAT_CAFE_BOT_TASK_CONTROL;
  process.env.CAT_CAFE_BOT_TASK_CONTROL = '1';
  t.after(() => { if (before === undefined) delete process.env.CAT_CAFE_BOT_TASK_CONTROL; else process.env.CAT_CAFE_BOT_TASK_CONTROL = before; });
  const record = { invocationId: 'profile-inv', callbackToken: 'test', threadId: 'home', catId: 'opus', userId: 'u' };
  registerCallbackAuthHook(app, { verify: async () => ({ ok: true, record }) });
  registerCallbackThreadCatsRoutes(app, { threadStore: { get: async () => ({ id: 'home', createdBy: 'u', preferredCats: ['opus','codex'] }), getParticipantsWithActivity: async () => [] }, agentRegistry: { getAllEntries: () => new Map() } });
  const res = await app.inject({ method: 'GET', url: '/api/callbacks/thread-cats', headers: { 'x-invocation-id': 'profile-inv', 'x-callback-token': 'test' } });
  assert.equal(res.statusCode,200,res.body); const body=res.json();
  assert.deepEqual(body.memberProfiles.map(p=>p.catId),['opus','codex']);
  for (const profile of body.memberProfiles) {
    assert.equal(profile.roleDescription,catRegistry.getAllConfigs()[profile.catId].roleDescription);
    assert.equal(profile.teamStrengths,catRegistry.getAllConfigs()[profile.catId].teamStrengths || undefined);
    assert.equal(profile.active,undefined); assert.equal(profile.running,undefined);
  }
  assert.deepEqual(body.routableNow,[]);
  delete process.env.CAT_CAFE_BOT_TASK_CONTROL;
  const disabled=await app.inject({ method:'GET',url:'/api/callbacks/thread-cats',headers:{'x-invocation-id':'profile-inv','x-callback-token':'test'} });
  assert.equal(disabled.json().memberProfiles,undefined);
});
