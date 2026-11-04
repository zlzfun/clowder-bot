import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Native Tasks on the runtime panel. runtime-tasks.js runs here as the classic
// browser script it is, in a VM with a tiny DOM (as chat-presentation.test.ts
// loads its script); runtime.js then runs on top of it against a fake native
// API, to show that a missing or failing Task API leaves the rest of the panel.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async (turns = 4) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };

class Text {
  parent: El | null = null;
  constructor(readonly text: string) {}
  get textContent() { return this.text; }
}
type Kid = El | Text;
class El {
  children: Kid[] = []; parent: El | null = null; attrs: Record<string, string> = {};
  className = ''; type = ''; placeholder = ''; hidden = false; disabled = false;
  onclick: (() => unknown) | null = null; onchange: (() => unknown) | null = null; onsubmit: ((event: unknown) => unknown) | null = null;
  private chosen: string | undefined; private own: string | undefined;
  constructor(readonly tag: string) {}
  append(...nodes: Array<Kid | string>) {
    for (const item of nodes) {
      const child = typeof item === 'string' ? new Text(item) : item;
      if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
      child.parent = this; this.children.push(child);
    }
  }
  replaceChildren(...nodes: Array<Kid | string>) { for (const c of this.children) c.parent = null; this.children = []; this.chosen = undefined; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  get textContent(): string { return this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); if (value) this.append(String(value)); }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  addEventListener() {}
  get options(): El[] { return this.children.filter((c): c is El => c instanceof El && c.tag === 'option'); }
  // A select reads as its chosen option, else its first one, as in a browser.
  get value(): string {
    if (this.tag !== 'select') return this.own ?? '';
    return this.options.find(o => o.value === this.chosen)?.value ?? this.options[0]?.value ?? '';
  }
  set value(value: string) { if (this.tag === 'select') this.chosen = String(value); else this.own = String(value); }
}
const all = (root: El): El[] => root.children.flatMap(c => c instanceof El ? [c, ...all(c)] : []);
const byText = (root: El, text: string) => all(root).find(n => n.tag === 'button' && n.textContent === text);
const cards = (root: El) => all(root).filter(n => n.tag === 'article');
const badges = (root: El) => all(root).filter(n => n.className === 'badge').map(n => n.textContent);
const titles = (root: El) => all(root).filter(n => n.tag === 'h4').map(n => n.textContent);
const picker = (root: El) => all(root).find(n => n.tag === 'select');
function cardOf(root: El, id: string): El {
  const card = cards(root).find(n => n.getAttribute('data-task-id') === id);
  assert.ok(card, 'no card for ' + id);
  return card;
}
// What a browser does: a disabled control ignores the click.
async function click(button: El | undefined) {
  assert.ok(button, 'missing control');
  if (!button.disabled) await button.onclick!();
}
function choose(select: El | undefined, value: string) {
  assert.ok(select, 'missing member picker');
  select.value = value; select.onchange!();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Module = Record<string, any>;
function browser(): Module {
  const window: Module = {};
  let n = 0;
  vm.runInNewContext(read('client/public/runtime-tasks.js'), { window, document: { createElement: (tag: string) => new El(tag) }, crypto: { randomUUID: () => `uuid-${++n}` } });
  return window.ClowderTasks;
}

const T0 = Date.UTC(2026, 10, 2, 3, 0, 0);
const cats = [{ id: 'cat-a', name: '宪宪', displayName: '宪宪' }, { id: 'cat-b', name: '砚砚', displayName: '砚砚' }, { id: 'cat-c', name: '墨墨', displayName: '墨墨' }];
// cat-gone is still listed by the thread but no longer a native member; cat-b is listed twice.
const room = { id: 'thread-1', title: '宪宪和砚砚', preferredCats: ['cat-a', 'cat-b', 'cat-gone', 'cat-b'] };
const run = (over: Record<string, unknown> = {}) => ({ attemptId: 'attempt-1', invocationId: 'inv-child', parentInvocationId: 'inv-main', sessionId: 'session-1', toolUseId: 'tool-1', state: 'running', startedAt: T0, updatedAt: T0 + 60_000, ...over });
const task = (over: Record<string, unknown> = {}) => ({ id: 'task-1', kind: 'work', threadId: 'thread-1', subjectKey: null, title: '修复登录', why: '用户反馈无法登录', ownerCatId: 'cat-a', ownerRevision: 2, status: 'doing', createdBy: 'cat-a', createdAt: T0, updatedAt: T0, ...over });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = { path: string; method: string; body?: any };
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });
const sent = (calls: Call[]) => calls.map(c => `${c.method} ${c.path}`);
const READ = ['GET /api/tasks?threadId=thread-1', 'GET /api/cats'];
async function mount(list: unknown[] | (() => unknown[]), opt: { route?: (call: Call) => unknown; thread?: unknown } = {}) {
  const tasks = browser(), host = new El('div'), calls: Call[] = [];
  const api = async (path: string, method?: string, body?: unknown) => {
    const call: Call = { path, method: method || 'GET', ...(body === undefined ? {} : { body: plain(body) }) };
    calls.push(call);
    const answer = opt.route?.(call);
    if (answer !== undefined) return answer;
    if (path === '/api/tasks?threadId=thread-1') return { tasks: typeof list === 'function' ? list() : list };
    if (path === '/api/cats') return { cats };
    throw failure(500, `unexpected ${call.method} ${path}`);
  };
  const reload = () => tasks.load({ api, host, threadId: 'thread-1', thread: 'thread' in opt ? opt.thread : room, isCurrent: () => true });
  await reload();
  return { tasks, host, calls, reload };
}
const noFallback = (calls: Call[]) => assert.ok(calls.every(c => !/\/cancel|\/queue|\/threads\//.test(c.path) && !['PATCH', 'PUT', 'DELETE'].includes(c.method)),
  'a Task control never falls back to a thread or member cancel, and never patches the Task');

test('ordinary progress and the background execution are separate native facts', async () => {
  const tasks = browser();
  assert.deepEqual(['todo', 'doing', 'blocked', 'done', 'paused', undefined].map(s => tasks.progress(s)), ['待办', '进行中', '受阻', '已完成', '状态未知', '状态未知']);
  const words = Object.fromEntries(['starting', 'running', 'stopping', 'completed', 'failed', 'stopped', 'unknown', 'paused']
    .map(state => [state, tasks.background(task({ backgroundExecution: run({ state }) })).text]));
  assert.deepEqual(words, { starting: '启动请求已提交', running: '运行中', stopping: '停止请求已提交', completed: '本次执行已完成',
    failed: '本次执行失败', stopped: '已停止', unknown: '状态未知', paused: '状态未知' });
  // A stop the native side accepted but has not finished is a request, never 已停止.
  assert.equal(tasks.background(task({ backgroundExecution: run({ stopRequestedAt: T0 }) })).text, '停止请求已提交');
  assert.equal(tasks.background(task({ backgroundExecution: run({ state: 'stopped', stopRequestedAt: T0 }) })).text, '已停止');

  const { host } = await mount([
    task({ backgroundExecution: run({ state: 'completed', endedAt: T0 + 120_000, summary: '任务已完成，可以关闭' }) }),
    task({ id: 'task-2', title: '整理文档', status: 'done' }),
    task({ id: 'task-3', title: '旧任务', status: 'todo' }),
  ]);
  assert.match(host.textContent, /^3 个原生任务/);
  const finished = cardOf(host, 'task-1');
  assert.deepEqual(badges(finished), ['进行中', '本次执行已完成'], 'a finished child leaves the Task in progress, whatever its summary says');
  assert.match(finished.textContent, /后台执行完成不等于任务完成/);
  assert.match(finished.textContent, /后台摘要：任务已完成，可以关闭/);
  assert.deepEqual(badges(cardOf(host, 'task-2')), ['已完成', '没有记录']);
  const quiet = cardOf(host, 'task-3');
  assert.match(quiet.textContent, /没有后台执行记录，不代表空闲/);
  assert.doesNotMatch(quiet.textContent.replace('不代表空闲', ''), /空闲/);
});

test('a Task card names the owner, shows the delegation and keeps the native ID in its details', async () => {
  const { host } = await mount([
    task(),
    task({ id: 'task-2', title: '补测试', ownerCatId: 'cat-b', delegatedFromTaskId: 'task-1' }),
    task({ id: 'task-3', title: '远端子任务', ownerCatId: 'cat-gone', delegatedFromTaskId: 'task-elsewhere' }),
  ]);
  const owner = cardOf(host, 'task-1');
  assert.deepEqual(titles(owner), ['修复登录']);
  assert.match(owner.textContent, /负责成员：宪宪 · 普通进度 进行中/);
  assert.match(owner.textContent, /用户反馈无法登录/);
  const details = all(owner).find(n => n.tag === 'details');
  assert.ok(details);
  assert.equal(details.children[0] instanceof El && details.children[0].tag === 'summary' ? details.children[0].textContent : '', '原生 ID 与记录');
  assert.match(details.textContent, /Task ID：task-1/);
  assert.equal(plain(JSON.parse(all(details).find(n => n.tag === 'pre')!.textContent)).id, 'task-1');
  assert.match(cardOf(host, 'task-2').textContent, /负责成员：砚砚.*委派自 Task task-1（修复登录）/);
  // A member that is gone, and a parent outside this list, stay as native IDs.
  assert.match(cardOf(host, 'task-3').textContent, /负责成员：cat-gone.*委派自 Task task-elsewhere(?!（)/);
});

test('controls follow the native record, not a guess', () => {
  const tasks = browser();
  for (const state of ['starting', 'running']) assert.equal(tasks.canStop(task({ backgroundExecution: run({ state }) })), true, state);
  for (const state of ['stopping', 'completed', 'failed', 'stopped', 'unknown', 'paused']) assert.equal(tasks.canStop(task({ backgroundExecution: run({ state }) })), false, state);
  assert.equal(tasks.canStop(task()), false, 'no record is not a stoppable execution');
  assert.equal(tasks.canStop(task({ backgroundExecution: run({ stopRequestedAt: T0 }) })), false, 'a stop is already requested');

  assert.equal(tasks.canCancel(task()), true);
  assert.equal(tasks.canCancel(task({ status: 'blocked', backgroundExecution: run({ state: 'completed' }) })), true);
  for (const over of [{ status: 'done' }, { kind: 'pr_tracking' }, { subjectKey: 'pr:owner/repo#1' }, { subjectKey: undefined },
    { entrustedWork: { closure: { state: 'open' } } }, { backgroundCancelledAt: T0 }]) assert.equal(tasks.canCancel(task(over)), false, JSON.stringify(over));

  assert.equal(tasks.canResume(task()), false);
  assert.equal(tasks.canResume(task({ backgroundCancelledAt: T0, backgroundStopRequestedAt: T0 })), true);
  assert.equal(tasks.resumeLabel(task({ backgroundCancelledAt: T0, backgroundStopRequestedAt: T0 })), '恢复任务');
  // A stop leaves its own marker until resume, also once the execution has stopped.
  const stopped = task({ status: 'blocked', backgroundStopRequestedAt: T0, backgroundExecution: run({ state: 'stopped', stopRequestedAt: T0 }) });
  assert.equal(tasks.canResume(stopped), true);
  assert.equal(tasks.resumeLabel(stopped), '允许继续');
  assert.equal(tasks.canResume(task({ backgroundStopRequestedAt: T0 })), true, 'a stop without a background record');
  // Older rows kept the marker only on the current record; a previous owner's marker does not count.
  assert.equal(tasks.stopMarked(task({ backgroundExecution: run({ ownerRevision: 2, state: 'stopped', stopRequestedAt: T0 }) })), true);
  assert.equal(tasks.stopMarked(task({ ownerRevision: 3, backgroundExecution: run({ ownerRevision: 2, state: 'stopped', stopRequestedAt: T0 }) })), false);
  // Native lifts the ban only once the background record has ended, whichever run it belongs to.
  for (const state of ['starting', 'running', 'stopping', 'unknown']) {
    assert.equal(tasks.resumeWait(task({ backgroundCancelledAt: T0, backgroundExecution: run({ state }) })), true, state);
    assert.equal(tasks.resumeWait(task({ ownerRevision: 3, backgroundStopRequestedAt: T0, backgroundExecution: run({ ownerRevision: 2, state }) })), true, 'previous ' + state);
  }
  for (const execution of [undefined, run({ state: 'stopped' }), run({ state: 'failed' }), run({ state: 'completed' })]) assert.equal(tasks.resumeWait(task({ backgroundCancelledAt: T0, backgroundExecution: execution })), false);
  // Only the current execution can be stopped from here.
  assert.equal(tasks.canStop(task({ ownerRevision: 3, backgroundExecution: run({ ownerRevision: 2 }) })), false);
  assert.equal(tasks.canStop(task({ executionRef: { invocationId: 'inv-main', subexecutionId: 'attempt-2' }, backgroundExecution: run({ ownerRevision: 2 }) })), false);
  assert.equal(tasks.canStop(task({ executionRef: { invocationId: 'inv-main', subexecutionId: 'attempt-1' }, backgroundExecution: run({ ownerRevision: 2 }) })), true);
  assert.equal(tasks.canStop(task({ backgroundStopRequestedAt: T0, backgroundExecution: run({ ownerRevision: 2 }) })), false, 'a stop is already recorded');
});

test('a background record from an earlier owner or attempt is the previous execution, never the current one', async () => {
  const { host, calls } = await mount([
    // Handed over to 砚砚 (revision 3); the stopped record is 宪宪's, from revision 2.
    task({ ownerCatId: 'cat-b', ownerRevision: 3, backgroundExecution: run({ attemptId: 'attempt-old', ownerRevision: 2, state: 'stopped', stopRequestedAt: T0, endedAt: T0 + 5_000, summary: '旧负责人的进度' }) }),
    // Same assignment, but the Task now runs another execution than the record's attempt.
    task({ id: 'task-2', title: '迁移数据', executionRef: { invocationId: 'inv-main', parentInvocationId: 'inv-0', catId: 'cat-a', threadId: 'thread-1', sourceMessageId: null }, backgroundExecution: run({ attemptId: 'attempt-7', ownerRevision: 2 }) }),
    // The record belongs to the current assignment and attempt.
    task({ id: 'task-3', title: '当前执行', executionRef: { invocationId: 'inv-main', subexecutionId: 'attempt-9', parentInvocationId: 'inv-0', catId: 'cat-a', threadId: 'thread-1', sourceMessageId: null }, backgroundExecution: run({ attemptId: 'attempt-9', ownerRevision: 2 }) }),
  ], { route: call => call.method === 'POST' ? { requested: true, unconfirmedTaskIds: [] } : undefined });
  const handed = cardOf(host, 'task-1');
  assert.deepEqual(badges(handed), ['进行中', '没有当前记录', '已停止']);
  assert.match(handed.textContent, /负责成员：砚砚/, 'the fetched owner stays authoritative');
  assert.match(handed.textContent, /没有当前后台执行记录，不代表空闲。上次后台执行 已停止属于 owner revision 2（当前为 3），不是当前执行/);
  assert.match(handed.textContent, /上次后台摘要：旧负责人的进度/);
  assert.equal(byText(handed, '停止此次后台执行'), undefined);
  assert.equal(byText(handed, '允许继续'), undefined, 'the handoff cleared the stop marker; the old record\'s own marker is history');
  const other = cardOf(host, 'task-2');
  assert.deepEqual(badges(other), ['进行中', '没有当前记录', '运行中']);
  assert.match(other.textContent, /上次后台执行 运行中属于另一次执行，不是当前执行/);
  assert.equal(byText(other, '停止此次后台执行'), undefined, 'a previous run is never offered as the current execution');
  assert.deepEqual(badges(cardOf(host, 'task-3')), ['进行中', '运行中']);
  assert.ok(byText(cardOf(host, 'task-3'), '停止此次后台执行'));
  // Controls still send the latest snapshot's attempt as it is, not a value the page made up.
  await click(byText(handed, '撤销整个任务'));
  assert.deepEqual(calls.filter(c => c.method === 'POST').at(-1)!.body, { action: 'cancel', expectedOwnerRevision: 3, expectedAttemptId: 'attempt-old' });
});

test('a stop leaves its marker: 允许继续 opens only once native shows the execution ended', async () => {
  let list: Array<Record<string, unknown>> = [task({ backgroundExecution: run() })];
  const marked = { status: 'blocked', backgroundStopRequestedAt: T0 + 61_000, backgroundStopOwnerTaskId: 'task-1' };
  const { host, calls, reload } = await mount(() => list, { route: call => {
    if (call.method !== 'POST') return undefined;
    if (call.body.action === 'stop') list = [task({ ...marked, backgroundExecution: run({ state: 'stopping', stopRequestedAt: T0 + 61_000 }) })];
    else list = [task({ status: 'todo', backgroundExecution: run({ state: 'stopped', endedAt: T0 + 70_000 }) })];
    return { task: list[0], requested: true, unconfirmedTaskIds: [] };
  } });
  await click(byText(cardOf(host, 'task-1'), '停止此次后台执行'));
  let card = cardOf(host, 'task-1');
  assert.match(card.textContent, /已请求停止（.+）：「允许继续」前不会开始新的执行。这不代表已在进行的工作已经停止，以执行记录为准。/);
  assert.ok(byText(card, '允许继续')!.disabled, 'stopping is not yet an end');
  assert.match(card.textContent, /后台执行记录确认结束后才能恢复。/);
  for (const state of ['running', 'unknown']) {
    list = [task({ ...marked, backgroundExecution: run({ state, stopRequestedAt: T0 + 61_000 }) })];
    await reload();
    assert.ok(byText(cardOf(host, 'task-1'), '允许继续')!.disabled, state);
  }
  // A later GET (which reconciles natively) shows the end; the marker stays until resume.
  list = [task({ ...marked, backgroundExecution: run({ state: 'stopped', stopRequestedAt: T0 + 61_000, endedAt: T0 + 65_000 }) })];
  await reload();
  card = cardOf(host, 'task-1');
  assert.deepEqual(badges(card), ['受阻', '已停止']);
  assert.match(card.textContent, /已请求停止（.+）：「允许继续」前不会开始新的执行。(?!这不代表)/, 'an ended current record needs no disclaimer');
  assert.match(card.textContent, /「允许继续」只解除禁止：不会自动重新开始执行，也不会撤回已经产生的外部影响。/);
  await click(byText(card, '允许继续'));
  assert.deepEqual(calls.filter(c => c.method === 'POST').at(-1)!.body, { action: 'resume', expectedOwnerRevision: 2, expectedAttemptId: 'attempt-1' });
  card = cardOf(host, 'task-1');
  assert.match(card.textContent, /恢复请求已提交：这只解除禁止，不会自动重新开始执行，也不会撤回先前已经产生的外部影响。/);
  assert.equal(byText(card, '允许继续'), undefined);
  assert.deepEqual(badges(card), ['待办', '已停止'], 'resuming does not claim a new execution');
});

test('a stop whose delivery is unconfirmed says so, on the Task and on each unconfirmed descendant', async () => {
  const parent = task({ backgroundExecution: run() });
  const child = task({ id: 'task-2', title: '补测试', ownerCatId: 'cat-b', delegatedFromTaskId: 'task-1', backgroundExecution: run({ attemptId: 'attempt-9' }) });
  let list: Array<Record<string, unknown>> = [parent, child];
  const { host } = await mount(() => list, { route: call => {
    if (call.method !== 'POST') return undefined;
    const marker = { status: 'blocked', backgroundStopRequestedAt: T0, backgroundStopOwnerTaskId: 'task-1' };
    list = [{ ...parent, ...marker, ...(call.body.action === 'cancel' ? { backgroundCancelledAt: T0 } : {}), backgroundExecution: run({ state: 'stopping', stopRequestedAt: T0 }) },
      { ...child, ...marker, backgroundExecution: run({ attemptId: 'attempt-9', state: 'running', stopRequestedAt: T0 }) }];
    return { task: list[0], requested: true, unconfirmedTaskIds: call.body.action === 'cancel' ? ['task-1', 'task-2'] : ['task-2'] };
  } });
  await click(byText(cardOf(host, 'task-1'), '停止此次后台执行'));
  assert.match(cardOf(host, 'task-1').textContent, /停止请求已记录，部分执行尚未确认停止，请刷新查看。/);
  assert.doesNotMatch(cardOf(host, 'task-1').textContent, /停止请求已提交，实际状态/);
  const descendant = cardOf(host, 'task-2');
  assert.match(descendant.textContent, /停止请求已记录，这里的执行尚未确认停止，请刷新查看。/);
  assert.match(descendant.textContent, /停止由 Task task-1（修复登录）发起。/);
  assert.deepEqual(badges(descendant), ['受阻', '停止请求已提交'], 'a running child with a stop recorded is not shown as stopped');
  await click(byText(cardOf(host, 'task-1'), '撤销整个任务'));
  assert.match(cardOf(host, 'task-1').textContent, /撤销已记录；停止请求已记录，部分执行尚未确认停止，请刷新查看。/);
});

test('a cancel without a background execution records the intent only; resume waits for native proof', async () => {
  const main = { invocationId: 'inv-main', parentInvocationId: 'inv-0', catId: 'cat-a', threadId: 'thread-1', sourceMessageId: 'msg-1' };
  let list: Array<Record<string, unknown>> = [task({ executionRef: main })];
  const { host, calls } = await mount(() => list, { route: call => {
    if (call.method !== 'POST') return undefined;
    if (call.body.action === 'resume') throw failure(409, 'task_execution_stop_unproven');
    list = [task({ executionRef: main, status: 'blocked', backgroundCancelledAt: T0, backgroundStopRequestedAt: T0, backgroundStopOwnerTaskId: 'task-1' })];
    return { task: list[0], requested: true, unconfirmedTaskIds: [] };
  } });
  await click(byText(cardOf(host, 'task-1'), '撤销整个任务'));
  let card = cardOf(host, 'task-1');
  assert.match(card.textContent, /撤销已记录：此任务和它所属的子任务在恢复前不会开始新的执行；这不代表已在进行的工作已经停止，以执行记录为准。/);
  assert.match(card.textContent, /已撤销（.+）：恢复前不会开始新的执行。这不代表已在进行的工作已经停止/);
  assert.doesNotMatch(card.textContent, /已停止/);
  assert.match(card.textContent, /当前执行不是后台执行；原生确认这次执行结束后才能恢复。/);
  await click(byText(card, '恢复任务'));
  card = cardOf(host, 'task-1');
  assert.match(card.textContent, /原生还没有确认当前执行已经停止，暂时不能恢复。已重新读取原生 Task，请核对后再操作。/);
  assert.ok(!byText(card, '恢复任务')!.disabled, 'the user may try again after a refresh');
  assert.deepEqual(calls.filter(c => c.method === 'POST').map(c => c.body), [
    { action: 'cancel', expectedOwnerRevision: 2, expectedAttemptId: null },
    { action: 'resume', expectedOwnerRevision: 2, expectedAttemptId: null },
  ]);
  noFallback(calls);
});

test('each control sends the observed owner revision and attempt, and nothing else', async () => {
  const { host, calls } = await mount([
    task({ ownerRevision: 3, backgroundExecution: run() }),
    task({ id: 'task-2', title: '旧任务', ownerRevision: undefined, status: 'todo' }),
    task({ id: 'task-3', title: '已撤销', status: 'blocked', backgroundCancelledAt: T0, backgroundStopRequestedAt: T0, backgroundExecution: run({ attemptId: 'attempt-3', state: 'stopped', endedAt: T0 }) }),
    task({ id: 'task 4/x', title: '特殊 ID', backgroundExecution: run({ attemptId: 'attempt-4', state: 'starting' }) }),
  ], { route: call => call.method === 'POST' ? { requested: true } : undefined });
  await click(byText(cardOf(host, 'task-1'), '停止此次后台执行'));
  await click(byText(cardOf(host, 'task-2'), '撤销整个任务'));
  await click(byText(cardOf(host, 'task-3'), '恢复任务'));
  await click(byText(cardOf(host, 'task 4/x'), '停止此次后台执行'));
  assert.deepEqual(calls.filter(c => c.method !== 'GET'), [
    { path: '/api/tasks/task-1/background-control', method: 'POST', body: { action: 'stop', expectedOwnerRevision: 3, expectedAttemptId: 'attempt-1' } },
    { path: '/api/tasks/task-2/background-control', method: 'POST', body: { action: 'cancel', expectedOwnerRevision: 0, expectedAttemptId: null } },
    { path: '/api/tasks/task-3/background-control', method: 'POST', body: { action: 'resume', expectedOwnerRevision: 2, expectedAttemptId: 'attempt-3' } },
    { path: '/api/tasks/task%204%2Fx/background-control', method: 'POST', body: { action: 'stop', expectedOwnerRevision: 2, expectedAttemptId: 'attempt-4' } },
  ]);
  noFallback(calls);
});

test('a stop is drawn from the Task the server returns: 请求已提交, and never 已停止 before native says so', async () => {
  let list = [task({ backgroundExecution: run() })];
  const stopping = task({ status: 'blocked', backgroundExecution: run({ state: 'stopping', stopRequestedAt: T0 + 61_000 }) });
  const { host, calls, reload } = await mount(() => list, { route: call => {
    if (call.method !== 'POST') return undefined;
    list = [stopping];
    return { task: stopping, requested: true };
  } });
  await click(byText(cardOf(host, 'task-1'), '停止此次后台执行'));
  const card = cardOf(host, 'task-1');
  assert.deepEqual(badges(card), ['受阻', '停止请求已提交']);
  assert.match(card.textContent, /停止请求已提交，实际状态以原生后台执行记录为准/);
  assert.doesNotMatch(card.textContent, /已停止/);
  assert.equal(byText(card, '停止此次后台执行'), undefined, 'the stop is already requested');
  assert.deepEqual(sent(calls), [...READ, 'POST /api/tasks/task-1/background-control', ...READ], 'the list is re-read: the stop also reaches descendants');
  // Only a native stopped state reads as stopped.
  list = [task({ status: 'blocked', backgroundExecution: run({ state: 'stopped', stopRequestedAt: T0 + 61_000, endedAt: T0 + 62_000 }) })];
  await reload();
  assert.deepEqual(badges(cardOf(host, 'task-1')), ['受阻', '已停止']);
});

test('while a control is in flight its Task\'s controls are off, so a second click sends nothing', async () => {
  let release: (value: unknown) => void = () => {};
  const { host, calls } = await mount([task({ backgroundExecution: run() })], {
    route: call => call.method === 'POST' ? new Promise(resolve => { release = resolve; }) : undefined });
  const card = cardOf(host, 'task-1');
  const stop = byText(card, '停止此次后台执行')!, cancel = byText(card, '撤销整个任务')!, handoff = byText(card, '请求交接')!;
  const first = stop.onclick!();
  await settle();
  assert.ok(stop.disabled && cancel.disabled && handoff.disabled && picker(card)!.disabled);
  assert.equal(card.getAttribute('aria-busy'), 'true');
  assert.match(card.textContent, /正在提交…/);
  await click(stop); await click(cancel);
  void stop.onclick!(); void cancel.onclick!();
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'even a forced second click is refused while pending');
  release({ task: task({ status: 'blocked', backgroundExecution: run({ state: 'stopping', stopRequestedAt: T0 }) }), requested: true });
  await first;
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('a stale answer (409) re-reads the list and never falls back to a thread or member cancel', async () => {
  let list = [task({ backgroundExecution: run() })];
  const { host, calls } = await mount(() => list, { route: call => {
    if (call.method !== 'POST') return undefined;
    if (call.body.expectedAttemptId === 'attempt-2') return { task: list[0], requested: true };
    // Someone else moved the Task on: a new owner revision and a new attempt.
    list = [task({ ownerCatId: 'cat-b', ownerRevision: 3, backgroundExecution: run({ attemptId: 'attempt-2', ownerRevision: 3 }) })];
    throw failure(409, 'task_assignment_changed');
  } });
  await click(byText(cardOf(host, 'task-1'), '停止此次后台执行'));
  const card = cardOf(host, 'task-1');
  assert.match(card.textContent, /任务的负责成员或后台执行已经变化。已重新读取原生 Task，请核对后再操作。/);
  assert.doesNotMatch(card.textContent, /task_assignment_changed/, 'a native code is put in words, not shown raw');
  assert.match(card.textContent, /负责成员：砚砚/, 'the re-read Task is what the card shows');
  assert.deepEqual(sent(calls), [...READ, 'POST /api/tasks/task-1/background-control', ...READ]);
  await click(byText(card, '停止此次后台执行'));
  assert.deepEqual(calls.filter(c => c.method === 'POST').at(-1)!.body, { action: 'stop', expectedOwnerRevision: 3, expectedAttemptId: 'attempt-2' });
  noFallback(calls);
});

for (const [status, message, expected, reread] of [
  [404, 'task_not_found', /当前后端没有开放这个任务操作，或任务已不存在。已重新读取原生 Task。/, true],
  [404, '此原生接口未开放到 Bot 适配层', /当前后端没有开放这个任务操作，或任务已不存在（此原生接口未开放到 Bot 适配层）。/, true],
  [409, '后台执行已由其他页面停止。', /后台执行已由其他页面停止。已重新读取原生 Task/, true],
  [409, 'background_control_unavailable', /当前状态不支持这个操作。已重新读取原生 Task/, true],
  [409, 'some_future_code', /任务已有变化，或当前状态不支持这个操作。已重新读取原生 Task，请核对后再操作。/, true],
  [500, '服务出现异常，请查看日志。', /没能确认请求结果：服务出现异常，请查看日志。请以刷新后的原生状态为准。/, false],
  [503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。', /没能确认请求结果：Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。/, false],
] as const) {
  test(`a ${status} answer (${message}) is reported on its Task and cancels nothing else`, async () => {
    const { host, calls } = await mount([task({ backgroundExecution: run() })], { route: call => {
      if (call.method === 'POST') throw failure(status, message);
      return undefined;
    } });
    await click(byText(cardOf(host, 'task-1'), '撤销整个任务'));
    const card = cardOf(host, 'task-1');
    assert.match(card.textContent, expected);
    assert.deepEqual(sent(calls), [...READ, 'POST /api/tasks/task-1/background-control', ...(reread ? READ : [])]);
    assert.ok(!byText(card, '撤销整个任务')!.disabled, 'the user can act again');
    noFallback(calls);
  });
}

test('cancel and resume re-read the list, where the Task\'s descendants change too', async () => {
  const parent = task({ backgroundExecution: run() });
  const child = task({ id: 'task-2', title: '补测试', ownerCatId: 'cat-b', delegatedFromTaskId: 'task-1', backgroundExecution: run({ attemptId: 'attempt-9' }) });
  let list: Array<Record<string, unknown>> = [parent, child];
  const { host, calls, reload } = await mount(() => list, { route: call => {
    if (call.method !== 'POST') return undefined;
    if (call.body.action === 'cancel') {
      const marker = { status: 'blocked', backgroundStopRequestedAt: T0 + 70_000, backgroundStopOwnerTaskId: 'task-1' };
      list = [{ ...parent, ...marker, backgroundCancelledAt: T0 + 70_000, backgroundExecution: run({ state: 'stopping', stopRequestedAt: T0 + 70_000 }) },
        { ...child, ...marker, backgroundExecution: run({ attemptId: 'attempt-9', state: 'stopping', stopRequestedAt: T0 + 70_000 }) }];
      return { task: list[0], requested: true, unconfirmedTaskIds: [] };
    }
    list = [{ ...list[0], status: 'todo', backgroundCancelledAt: undefined, backgroundStopRequestedAt: undefined, backgroundStopOwnerTaskId: undefined,
      backgroundExecution: run({ state: 'stopped', endedAt: T0 + 80_000 }) }, list[1]];
    return { task: list[0], requested: true, unconfirmedTaskIds: [] };
  } });
  await click(byText(cardOf(host, 'task-1'), '撤销整个任务'));
  let owner = cardOf(host, 'task-1');
  assert.match(owner.textContent, /撤销已记录：此任务和它所属的子任务在恢复前不会开始新的执行；这不代表已在进行的工作已经停止，以执行记录为准。/);
  assert.match(owner.textContent, /已撤销（.+）：恢复前不会开始新的执行。这不代表已在进行的工作已经停止/);
  const descendant = cardOf(host, 'task-2');
  assert.match(descendant.textContent, /停止请求已提交/, 'the descendant is re-read, not guessed');
  assert.match(descendant.textContent, /已请求停止（.+）：「允许继续」前不会开始新的执行。/);
  assert.match(descendant.textContent, /停止由 Task task-1（修复登录）发起。/);
  assert.ok(byText(descendant, '允许继续')!.disabled);
  assert.equal(byText(owner, '撤销整个任务'), undefined);
  assert.ok(byText(owner, '恢复任务')!.disabled, 'native refuses to lift a cancel while the execution is still stopping');
  assert.match(owner.textContent, /后台执行记录确认结束后才能恢复/);
  await click(byText(owner, '恢复任务'));
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);

  // An explicit refresh later shows the stop has ended; now the Task can be resumed.
  list = [{ ...list[0], backgroundExecution: run({ state: 'stopped', stopRequestedAt: T0 + 70_000, endedAt: T0 + 75_000 }) }, list[1]];
  await reload();
  owner = cardOf(host, 'task-1');
  assert.match(owner.textContent, /「恢复任务」只解除禁止：不会自动重新开始执行，也不会撤回已经产生的外部影响。/);
  await click(byText(owner, '恢复任务'));
  owner = cardOf(host, 'task-1');
  assert.deepEqual(calls.filter(c => c.method === 'POST').at(-1)!.body, { action: 'resume', expectedOwnerRevision: 2, expectedAttemptId: 'attempt-1' });
  assert.match(owner.textContent, /恢复请求已提交：这只解除禁止，不会自动重新开始执行，也不会撤回先前已经产生的外部影响。需要继续时，请在聊天中给负责成员发送继续的消息。/);
  assert.doesNotMatch(owner.textContent, /已撤销（|已请求停止（/);
  assert.deepEqual(badges(owner), ['待办', '已停止'], 'resuming does not claim a new execution started');
  noFallback(calls);
});

test('a re-read that fails after a control keeps what the control already showed', async () => {
  let down = false;
  const stopping = task({ status: 'blocked', backgroundExecution: run({ state: 'stopping', stopRequestedAt: T0 }) });
  const { host } = await mount([task({ backgroundExecution: run() })], { route: call => {
    if (call.method === 'POST') { down = true; return { task: stopping, requested: true }; }
    if (down && call.path.startsWith('/api/tasks?')) throw failure(503, 'Clowder AI 运行时未连接');
    return undefined;
  } });
  await click(byText(cardOf(host, 'task-1'), '停止此次后台执行'));
  assert.match(host.textContent, /^没能读取原生 Task：Clowder AI 运行时未连接/);
  const card = cardOf(host, 'task-1');
  assert.deepEqual(badges(card), ['受阻', '停止请求已提交']);
  assert.match(card.textContent, /停止请求已提交，实际状态以原生后台执行记录为准/);
  assert.ok(!byText(card, '撤销整个任务')!.disabled, 'the kept card is live again');
});

test('a backend without native Tasks (404) leaves only this block unavailable; other failures say so', async () => {
  const old = await mount([], { route: call => { if (call.path.startsWith('/api/tasks')) throw failure(404, '此原生接口未开放到 Bot 适配层'); return undefined; } });
  assert.equal(old.host.textContent, '当前后端还没有开放原生 Task，任务列表暂不可用；会话、队列和其他面板照常显示。');
  const broken = await mount([], { route: call => { if (call.path.startsWith('/api/tasks')) throw failure(500, '服务出现异常，请查看日志。'); return undefined; } });
  assert.match(broken.host.textContent, /^没能读取原生 Task：服务出现异常，请查看日志。其他面板不受影响/);
  const odd = await mount([], { route: call => call.path.startsWith('/api/tasks') ? { tasks: 'not a list' } : undefined });
  assert.equal(odd.host.textContent, '原生 Task 的返回格式无法识别。');
  const empty = await mount([]);
  assert.equal(empty.host.textContent, '这个会话还没有原生任务。');
  // Even an API that throws before returning a promise cannot reject the load.
  const tasks = browser(), host = new El('div');
  await tasks.load({ api: () => { throw new Error('boom'); }, host, threadId: 'thread-1', thread: room, isCurrent: () => true });
  assert.match(host.textContent, /没能读取原生 Task：boom/);
});

test('without the member roster, owners and handoff targets stay native IDs', async () => {
  const { host } = await mount([task()], { route: call => { if (call.path === '/api/cats') throw failure(500, 'roster down'); return undefined; } });
  assert.match(host.textContent, /成员名单暂时没能读取，负责成员先显示原生 ID。/);
  const card = cardOf(host, 'task-1');
  assert.match(card.textContent, /负责成员：cat-a/);
  assert.deepEqual(picker(card)!.options.map(o => o.value), ['', 'cat-b', 'cat-gone']);
});

test('a handoff is one user request to the current owner; the owner shown stays the fetched one', async () => {
  const { host, calls } = await mount([task()], { route: call => call.path === '/api/messages' ? { id: 'message-1', status: 'queued' } : undefined });
  const card = cardOf(host, 'task-1'), pick = picker(card), send = byText(card, '请求交接');
  assert.ok(pick && send);
  assert.equal(pick.getAttribute('aria-label'), '选择接手成员');
  // Only this thread's members, never the owner, a former member or a duplicate.
  assert.deepEqual(pick.options.map(o => [o.value, o.textContent]), [['', '选择接手成员…'], ['cat-b', '砚砚']]);
  assert.ok(send.disabled, 'nothing to send until a member is chosen');
  choose(pick, 'cat-b');
  assert.ok(!send.disabled);
  await click(send);
  assert.deepEqual(calls.filter(c => c.method !== 'GET'), [{ path: '/api/messages', method: 'POST', body: {
    threadId: 'thread-1', mentions: ['cat-a'], messageDisposition: 'continue_current', idempotencyKey: 'uuid-1',
    content: '请将原生 Task task-1（修复登录，当前 owner revision 2）正式交接给 @cat-b。只收束此任务所属后台执行，保留其他任务；使用原生 Task-backed 交接，回报实际结果。',
  } }]);
  assert.match(card.textContent, /交接请求已提交给 宪宪。是否交接、由谁负责，以刷新后原生 Task 的负责成员为准。/);
  assert.match(card.textContent, /负责成员：宪宪/, 'the owner changes only when a fetched Task says so');
  assert.doesNotMatch(card.textContent, /已交接|交接完成|负责成员：砚砚/);
  assert.ok(send.disabled && pick.disabled, 'the sent request is not repeated from this card');
  await send.onclick!();
  assert.equal(calls.filter(c => c.method !== 'GET').length, 1);
  noFallback(calls);
});

test('a failed handoff can be retried under the same key; another member gets a new one', async () => {
  let down = true;
  const { host, calls } = await mount([task({ ownerRevision: undefined })], { thread: { ...room, preferredCats: ['cat-a', 'cat-b', 'cat-c'] }, route: call => {
    if (call.path !== '/api/messages') return undefined;
    if (down) throw failure(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。');
    return { id: 'message-1' };
  } });
  const card = cardOf(host, 'task-1'), send = byText(card, '请求交接');
  choose(picker(card), 'cat-b');
  await click(send);
  assert.match(card.textContent, /没能确认交接请求已提交：Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。/);
  assert.ok(!send!.disabled);
  await click(send);
  choose(picker(card), 'cat-c');
  down = false;
  await click(send);
  const requests = calls.filter(c => c.path === '/api/messages').map(c => [c.body.idempotencyKey, /@(cat-\w)/.exec(c.body.content)![1], /owner revision (\d+)/.exec(c.body.content)![1]]);
  assert.deepEqual(requests, [['uuid-1', 'cat-b', '0'], ['uuid-1', 'cat-b', '0'], ['uuid-2', 'cat-c', '0']]);
  assert.match(card.textContent, /交接请求已提交给 宪宪/);
});

test('a handoff waits for a native owner and applies only to open ordinary work', async () => {
  const { host } = await mount([
    task({ id: 'unowned', ownerCatId: null }),
    task({ id: 'done', status: 'done' }),
    task({ id: 'tracking', kind: 'pr_tracking', subjectKey: 'pr:owner/repo#1' }),
  ]);
  const unowned = cardOf(host, 'unowned');
  assert.match(unowned.textContent, /负责成员：尚无，等待原生认领/);
  assert.match(unowned.textContent, /还没有负责成员，正在等待原生认领；认领后才能请求交接。/);
  assert.equal(picker(unowned), undefined);
  assert.match(cardOf(host, 'done').textContent, /任务已完成，不再交接。/);
  assert.match(cardOf(host, 'tracking').textContent, /这类任务不走原生 Task 交接。/);
  assert.equal(byText(cardOf(host, 'tracking'), '撤销整个任务'), undefined, 'cancel is for ordinary work only');
  const alone = await mount([task()], { thread: { ...room, preferredCats: ['cat-a'] } });
  assert.match(cardOf(alone.host, 'task-1').textContent, /这个会话里没有其他可以接手的成员。/);
  const unknownThread = await mount([task()], { thread: null });
  assert.equal(picker(cardOf(unknownThread.host, 'task-1')), undefined);
});

test('native text is drawn as text, and a title cannot split the handoff request', async () => {
  const separator = String.fromCharCode(0x2028), breaks = ['\n', '\r', separator, String.fromCharCode(0x2029)];
  const hostile = '<img src=x onerror=alert(1)>\n第二行' + separator + '第三行';
  const { host, calls } = await mount([task({ title: hostile, why: '<script>alert(2)</script>' })], { route: call => call.path === '/api/messages' ? { id: 'm' } : undefined });
  const card = cardOf(host, 'task-1');
  assert.deepEqual(titles(card), ['<img src=x onerror=alert(1)> 第二行 第三行']);
  assert.ok(all(card).every(n => !['img', 'script'].includes(n.tag)), 'no markup is parsed');
  assert.match(card.textContent, /<script>alert\(2\)<\/script>/);
  choose(picker(card), 'cat-b');
  await click(byText(card, '请求交接'));
  const content: string = calls.find(c => c.path === '/api/messages')!.body.content;
  assert.match(content, /^请将原生 Task task-1（<img src=x onerror=alert\(1\)> 第二行 第三行，当前 owner revision 2）正式交接给 @cat-b。/);
  assert.ok(breaks.every(b => !content.includes(b)), 'the request stays one line');
  assert.doesNotMatch(read('client/public/runtime-tasks.js'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('the Task block keeps no poller or scheduler and has no route to a thread or member cancel', () => {
  const source = read('client/public/runtime-tasks.js');
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|EventSource|new Worker/);
  assert.doesNotMatch(source, /\/cancel|\/queue|\/threads\/|'PATCH'|'PUT'|'DELETE'/);
  assert.deepEqual([...source.matchAll(/'(\/api\/[^'?$`]+)/g)].map(m => m[1]).sort(), ['/api/cats', '/api/messages', '/api/tasks']);
  assert.match(source, /`\/api\/tasks\/\$\{enc\(task\.id\)\}\/background-control`/);
});

test('only the newest read for the selected conversation draws', async () => {
  const tasks = browser(), host = new El('div'), pending: Array<(value: unknown) => void> = [];
  let selected = true;
  const api = (path: string) => path === '/api/cats' ? Promise.resolve({ cats }) : new Promise(resolve => { pending.push(resolve); });
  const older = tasks.load({ api, host, threadId: 'thread-1', thread: room, isCurrent: () => selected });
  const newer = tasks.load({ api, host, threadId: 'thread-1', thread: room, isCurrent: () => selected });
  await settle();
  pending[1]({ tasks: [task({ title: '新的读取' })] });
  await newer;
  pending[0]({ tasks: [task({ title: '旧的读取' })] });
  await older;
  assert.deepEqual(titles(host), ['新的读取']);
  // The user picks another conversation while this one is still loading.
  const away = tasks.load({ api, host, threadId: 'thread-1', thread: room, isCurrent: () => selected });
  await settle();
  selected = false;
  pending[2]({ tasks: [task({ title: '已离开的会话' })] });
  await away;
  assert.doesNotMatch(host.textContent, /已离开的会话/);
});

// runtime.js on top of runtime-tasks.js, against a fake native API.
const HTTP = Symbol('http');
const http = (status: number, body: unknown) => ({ [HTTP]: status, body });
const nativePanel: Record<string, unknown> = {
  '/native-api/api/threads': { threads: [room] },
  '/native-api/api/cats/native-runtimes': { runtimes: [{ label: 'Codex', installed: true, readiness: { status: 'configured' } }] },
  '/native-api/api/accounts': { providers: [] },
  '/native-api/api/memory/catalog': { collections: [] },
  '/native-api/api/approval-hub/pending': { items: [], manifest: [] },
  '/native-api/api/threads/thread-1/queue': { activeInvocations: [], queue: [] },
  '/native-api/api/threads/thread-1/sessions': { sessions: [] },
  '/native-api/api/messages?threadId=thread-1&limit=200': { messages: [], hasMore: false },
  '/native-api/api/cats': { cats },
  '/native-api/api/tasks?threadId=thread-1': { tasks: [task({ backgroundExecution: run() })] },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Request = { method: string; url: string; body?: any; type?: string };
function panel(replies: Record<string, unknown>, search = '') {
  const tags: Record<string, string> = { refresh: 'button', connection: 'span', error: 'div', approvals: 'div', threads: 'select', tasks: 'div',
    thread: 'div', runtimes: 'div', accounts: 'div', memory: 'div', 'memory-form': 'form' };
  const page: Record<string, El> = Object.fromEntries(Object.entries(tags).map(([id, tag]) => [id, new El(tag)]));
  page.error.hidden = true;
  const requests: Request[] = [];
  const fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method || 'GET';
    requests.push({ method, url, ...(init.body ? { body: JSON.parse(init.body), type: init.headers?.['Content-Type'] } : {}) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let reply: any = replies[`${method} ${url}`] ?? (method === 'GET' ? replies[url] : undefined);
    if (typeof reply === 'function') reply = reply();
    const status: number = reply === undefined ? 500 : reply[HTTP] ?? 200;
    const body = reply === undefined ? { error: `unexpected ${method} ${url}` } : status === 200 ? reply : reply.body;
    return { ok: status < 400, status, json: async () => plain(body) };
  };
  const window: Module = search ? { location: { search } } : {};
  const context = vm.createContext({ window, fetch, URLSearchParams, crypto: { randomUUID: () => 'uuid-panel' },
    document: { createElement: (tag: string) => new El(tag), getElementById: (id: string) => page[id] ?? null },
    EventSource: class { addEventListener() {} close() {} } });
  vm.runInContext(read('client/public/runtime-tasks.js'), context);
  vm.runInContext(read('client/public/runtime.js'), context);
  return { page, requests };
}

test('on a backend without native Tasks, the rest of the runtime panel still loads', async () => {
  const { page, requests } = panel({ ...nativePanel, '/native-api/api/tasks?threadId=thread-1': http(404, { error: '此原生接口未开放到 Bot 适配层' }) });
  await settle();
  assert.match(page.tasks.textContent, /任务列表暂不可用/);
  assert.match(page.thread.textContent, /^0 个执行中 · 0 个队列项/);
  assert.match(page.runtimes.textContent, /Codex · 已安装 · 已有登录或配置记录/);
  assert.match(page.approvals.textContent, /当前没有待审批事项/);
  assert.equal(page.error.hidden, true);
  assert.equal(page.connection.textContent, '已连接 Clowder AI');
  assert.ok(requests.some(r => r.url === '/native-api/api/tasks?threadId=thread-1'));
});

test('one failed native read reports itself without blanking the other views', async () => {
  const { page } = panel({ ...nativePanel,
    '/native-api/api/accounts': http(500, { error: '原生账号读取失败' }),
    '/native-api/api/threads/thread-1/queue': http(503, { error: '队列暂不可用' }) });
  await settle();
  assert.equal(page.accounts.textContent, '没能读取：原生账号读取失败');
  assert.match(page.runtimes.textContent, /Codex/);
  assert.match(page.memory.textContent, /原生记忆集合/);
  assert.equal(cards(page.tasks).length, 1, 'Tasks load on their own, even when the queue read fails');
  assert.equal(page.error.hidden, false);
  assert.equal(page.error.textContent, '原生账号读取失败');
  assert.notEqual(page.connection.textContent, '已连接 Clowder AI');
});

test('a Task control goes through the panel\'s native API wrapper; a 409 re-reads Tasks and cancels nothing else', async () => {
  let attempt = 'attempt-1';
  const { page, requests } = panel({ ...nativePanel,
    '/native-api/api/tasks?threadId=thread-1': () => ({ tasks: [task({ backgroundExecution: run({ attemptId: attempt }) })] }),
    'POST /native-api/api/tasks/task-1/background-control': () => { attempt = 'attempt-2'; return http(409, { error: 'task_assignment_changed', native: { error: 'task_assignment_changed' } }); } });
  await settle();
  const card = cardOf(page.tasks, 'task-1');
  assert.deepEqual(picker(card)!.options.map(o => o.textContent), ['选择接手成员…', '砚砚'], 'handoff targets come from the selected thread');
  await click(byText(card, '停止此次后台执行'));
  assert.deepEqual(requests.filter(r => r.method !== 'GET'), [{ method: 'POST', url: '/native-api/api/tasks/task-1/background-control',
    body: { action: 'stop', expectedOwnerRevision: 2, expectedAttemptId: 'attempt-1' }, type: 'application/json' }]);
  assert.match(cardOf(page.tasks, 'task-1').textContent, /已重新读取原生 Task/);
  assert.equal(requests.filter(r => r.url === '/native-api/api/tasks?threadId=thread-1').length, 2);
  assert.ok(requests.every(r => !/\/cancel\/|\/queue\//.test(r.url)), 'no thread or member cancel');
  assert.equal(page.error.hidden, true, 'a stale Task answer is not a panel failure');
});

// A scheduled task's chat links here as ?thread=<id> (schedules.js); it picks the first view only.
test('a ?thread= link opens that conversation, and a missing one is named instead of silently replaced', async () => {
  const other = { id: 'thread-2', title: '旧聊天', preferredCats: ['cat-a'] };
  const replies = { ...nativePanel, '/native-api/api/threads': { threads: [room, other] },
    '/native-api/api/threads/thread-2/queue': { activeInvocations: [], queue: [] },
    '/native-api/api/threads/thread-2/sessions': { sessions: [] },
    '/native-api/api/messages?threadId=thread-2&limit=200': { messages: [], hasMore: false },
    '/native-api/api/tasks?threadId=thread-2': { tasks: [] } };
  const linked = panel(replies, '?thread=thread-2');
  await settle();
  assert.equal(linked.page.threads.value, 'thread-2');
  assert.ok(linked.requests.some(r => r.url === '/native-api/api/tasks?threadId=thread-2'));
  assert.ok(!linked.requests.some(r => r.url === '/native-api/api/tasks?threadId=thread-1'), 'the linked chat is the one read');
  assert.equal(linked.page.error.hidden, true);

  const missing = panel(replies, '?thread=thread-gone');
  await settle();
  assert.equal(missing.page.threads.value, 'thread-1');
  assert.equal(missing.page.error.hidden, false);
  assert.equal(missing.page.error.textContent, '没有找到链接里的会话 thread-gone，它可能已被删除；请在会话列表里选择。');

  const plainPage = panel(replies);
  await settle();
  assert.equal(plainPage.page.threads.value, 'thread-1', 'without a link the first conversation shows, as before');
  assert.equal(plainPage.page.error.hidden, true);
});

test('with no conversation yet, the Task block says what it waits for', async () => {
  const { page, requests } = panel({ ...nativePanel, '/native-api/api/threads': { threads: [] } });
  await settle();
  assert.equal(page.tasks.textContent, '选择会话后显示它的原生任务。');
  assert.match(page.thread.textContent, /还没有会话/);
  assert.ok(!requests.some(r => r.url.includes('/api/tasks')));
});

test('the runtime page loads the Task block before runtime.js, under the conversation selector', () => {
  const html = read('client/public/runtime.html');
  assert.deepEqual([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]), ['/runtime-tasks.js', '/runtime.js']);
  assert.match(html, /<script src="\/runtime-tasks\.js"><\/script><script type="module" src="\/runtime\.js"><\/script>/);
  const section = /<section><h2>会话与执行<\/h2>([\s\S]*?)<\/section>/.exec(html)![1];
  const at = (id: string) => section.indexOf(`id="${id}"`);
  assert.ok(at('threads') >= 0 && at('threads') < at('tasks') && at('tasks') < at('thread'));
  assert.match(section, /<h3>原生任务<\/h3>/);
  assert.match(section, /后台执行完成不等于任务完成，没有后台执行记录也不代表空闲/);
});
