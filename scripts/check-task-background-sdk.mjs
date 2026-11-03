import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.BOT_TASK_SDK_ACCEPTANCE !== '1') throw new Error('Opt in with BOT_TASK_SDK_ACCEPTANCE=1; this invokes a real local Agent.');
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8'));
const runtime = resolve(root, process.env.BOT_TASK_TEST_RUNTIME || lock.build);
const native = file => import(pathToFileURL(join(runtime, 'packages/api/dist', file)).href);
const { TaskStore } = await native('domains/cats/services/stores/ports/TaskStore.js');
const { ordinaryTaskExpectation } = await native('domains/cats/services/stores/ports/OrdinaryTaskMutation.js');
const { TaskBackgroundRuntime, installTaskBackgroundRuntime } = await native('domains/cats/services/background/TaskBackgroundRuntime.js');
const { ClaudeSdkAgentService } = await native('domains/cats/services/agents/providers/ClaudeSdkAgentService.js');
const id = randomUUID().slice(0, 8), dir = join(root, '.runtime/task-sdk-acceptance', id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'pulse.py'), `import json,os,pathlib,sys,time
p=pathlib.Path(__file__).resolve().parent
name,seconds=sys.argv[1],int(sys.argv[2])
started=time.time()
with (p/(name+'.jsonl')).open('a',buffering=1) as log:
    while time.time()-started<seconds:
        log.write(json.dumps(dict(pid=os.getpid(),at=time.time()))+'\\n')
        time.sleep(1)
(p/(name+'.done')).write_text('completed')
`);
const ticks = name => existsSync(join(dir, `${name}.jsonl`)) ? readFileSync(join(dir, `${name}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const tasks = new TaskStore();
const scope = { userId: 'task-sdk-acceptance', catId: 'opus', threadId: `thread-${id}`, invocationId: `invocation-${id}`, parentInvocationId: `queue-${id}` };
const evidence = { id, dir, scope, startedAt: Date.now(), observations: [], outputs: [], checks: [] };
const save = () => writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
const manager = new TaskBackgroundRuntime({ tasks, changed: task => { evidence.observations.push({ at: Date.now(), task }); save(); } });
installTaskBackgroundRuntime(manager);
process.env.CAT_CAFE_BOT_TASK_CONTROL = '1';
process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION = '1';
async function make(title) {
  const task = await tasks.create({ userId: scope.userId, threadId: scope.threadId, title, why: 'Isolated native SDK acceptance', ownerCatId: scope.catId, createdBy: scope.catId });
  const result = await tasks.mutateOrdinaryTask({ kind: 'update', taskId: task.id, expected: ordinaryTaskExpectation(task), actor: scope, input: { status: 'doing' }, execution: { ...scope, sourceMessageId: null } });
  assert.equal(result.kind, 'updated');
  return result.task;
}
const a = await make('SDK Task A'), b = await make('SDK Task B');
evidence.taskIds = [a.id, b.id]; save();
let dispatcher;
const abort = new AbortController();
const service = new ClaudeSdkAgentService({ catId: scope.catId, model: 'claude-opus-5-5', mcpServerPath: '', l0CompilerFn: async () => 'You are a local execution acceptance agent. Use real native background Agent tasks as requested. Keep the main conversation responsive; never wait for background completion. Do not invoke skills or external services.', rawArchive: { append: async (_invocation, event) => { const fs = await import('node:fs/promises'); await fs.appendFile(join(dir, 'raw.jsonl'), JSON.stringify(event) + '\n'); } } });
const prompt = `Launch exactly two native Agent tool calls in BACKGROUND (run_in_background=true), both before waiting for anything. Native Tasks are already created and doing; no MCP task mutations are needed in this harness.
Agent A description MUST be "[task:${a.id}] pulse A". Its sole work is to run python3 ${join(dir, 'pulse.py')} A 180 using foreground Bash with timeout 240000 and run_in_background=false, then report A finished only if A.done exists. Do not modify the script or shorten the duration. Do not create other agents or background commands.
Agent B description MUST be "[task:${b.id}] pulse B". Its sole work is to run python3 ${join(dir, 'pulse.py')} B 95 using foreground Bash with timeout 180000 and run_in_background=false, then report B_DONE only if B.done exists. Do not modify the script or shorten the duration. Do not create other agents or background commands.
After launching both, reply LAUNCHED and keep both working. Do not use TaskOutput waiting, TaskStop or kill. The test host will stop only A. Answer later user messages without disturbing B. On B completion proactively reply B_DONE.`;
const run = (async () => {
  for await (const event of service.invoke(prompt, { invocationId: scope.invocationId, workingDirectory: dir, signal: abort.signal, reasoningEffortOverride: 'low',
    callbackEnv: { CAT_CAFE_USER_ID: scope.userId, CAT_CAFE_CAT_ID: scope.catId, CAT_CAFE_THREAD_ID: scope.threadId, CAT_CAFE_EXECUTION_ID: scope.parentInvocationId, CAT_CAFE_INVOCATION_ID: scope.invocationId },
    activeRunDispatch: { invocationId: scope.parentInvocationId, register(value) { dispatcher = value; return () => { dispatcher = undefined; }; } },
  })) { evidence.outputs.push(event); save(); }
})();
let runError;
run.catch(error => { runError = error; });
async function until(label, predicate, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (runError) throw runError;
    const value = await predicate();
    if (value) return value;
    const error = evidence.outputs.find(e => e.type === 'error');
    if (error) throw new Error(`${label}: ${error.error}`);
    await new Promise(ok => setTimeout(ok, 1000));
  }
  throw new Error(`Timed out: ${label}`);
}
console.log(JSON.stringify({ dir, tasks: [a.id, b.id], stage: 'launching' }));
try {
  await until('both native tasks running with real pulses', () => tasks.get(a.id).backgroundExecution?.state === 'running' && tasks.get(b.id).backgroundExecution?.state === 'running' && ticks('A').length >= 3 && ticks('B').length >= 3);
  const before = tasks.get(a.id), beforeB = ticks('B').length;
  await manager.control(a.id, scope.userId, { action: 'stop', expectedOwnerRevision: before.ownerRevision ?? 0, expectedAttemptId: before.backgroundExecution.attemptId });
  await until('SDK A stopped receipt', () => tasks.get(a.id).backgroundExecution?.state === 'stopped', 45000);
  const stoppedTicks = ticks('A').length;
  await new Promise(ok => setTimeout(ok, 5000));
  assert.equal(ticks('A').length, stoppedTicks, 'A command must actually stop, not only its presentation');
  assert.ok(ticks('B').length > beforeB, 'B command continues across A stop');
  assert.ok(dispatcher, 'shared parent remains attached');
  const questionAt = Date.now();
  const accepted = await dispatcher.dispatch({ text: '独立问题：6乘7等于多少？只回答 QUESTION_OK 42。不要改变或停止后台任务 B。' }, { expectedInvocationId: scope.parentInvocationId });
  assert.equal(accepted.accepted, true);
  const textSince = at => evidence.outputs.filter(e => e.type === 'text' && e.timestamp >= at).map(e => e.content ?? '').join('');
  await until('main answers while B runs', () => /QUESTION_OK\s+42/.test(textSince(questionAt)), 60000);
  assert.equal(tasks.get(b.id).backgroundExecution.state, 'running');
  evidence.checks.push({ check: 'A stopped, B continued, primary replied', at: Date.now(), stoppedTicks }); save();
  console.log(JSON.stringify(evidence.checks.at(-1)));
  await until('B actually completed', () => tasks.get(b.id).backgroundExecution?.state === 'completed' && existsSync(join(dir, 'B.done')), 180000);
  assert.equal(existsSync(join(dir, 'A.done')), false);
  assert.equal(new Set(ticks('B').map(t => t.pid)).size, 1);
  assert.ok(ticks('B').length >= 90);
  assert.notEqual(tasks.get(b.id).status, 'done', 'SDK completion must not forge business completion');
  const completedAt = tasks.get(b.id).backgroundExecution.endedAt;
  await until('parent proactive report', () => textSince(completedAt).includes('B_DONE'), 60000);
  await run;
  evidence.passed = true; evidence.endedAt = Date.now(); save();
  console.log(JSON.stringify({ passed: true, dir, taskA: tasks.get(a.id), taskB: tasks.get(b.id), ticksB: ticks('B').length }));
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error); save();
  abort.abort();
  await run.catch(() => {});
  throw error;
}
