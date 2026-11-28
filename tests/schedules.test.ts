// 定时任务前端（client/public/schedules.js）。The page script is a classic browser
// script; it runs here in a VM with a small DOM (as cat-templates.test.ts does),
// against a fake /xbot-api/bots/:name/routines. Times are read in Asia/Shanghai.
process.env.TZ = 'Asia/Shanghai';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const HOUR = 3600000;

// ---- a small DOM ----
type Listener = (ev: any) => unknown;
type Kid = El | Txt;
const sibling = (n: Kid, step: number): Kid | null => { const p = n.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(n) + step] ?? null; };
class Txt {
  parentNode: El | null = null;
  constructor(public data: string) {}
  get textContent() { return this.data; }
  get nextSibling() { return sibling(this, 1); }
}
class Doc {
  body: El; focused: El | null = null; listeners: Array<{ type: string; fn: Listener; capture: boolean }> = [];
  constructor() { this.body = new El('body', this); }
  createElement(tag: string) { return new El(tag, this); }
  // As in a browser: the document hears an event of its elements first (capture) and last (bubble), as app.js listens.
  addEventListener(type: string, fn: Listener, capture: unknown = false) { this.listeners.push({ type, fn, capture: capture === true }); }
  removeEventListener(type: string, fn: Listener, capture: unknown = false) { this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === (capture === true))); }
  // As in a browser: a removed or disabled element no longer holds focus.
  get activeElement(): El { return this.focused && this.focused.isConnected && !this.focused.disabled ? this.focused : this.body; }
}
class El {
  childNodes: Kid[] = []; parentNode: El | null = null; attrs: Record<string, string> = {}; listeners: Record<string, Listener[]> = {};
  className = ''; id = ''; type = ''; value = ''; name = ''; checked = false; hidden = false; open = false; off = false;
  href = ''; target = ''; rel = ''; htmlFor = ''; min: unknown = ''; max: unknown = ''; step: unknown = ''; maxLength = -1; rows = 0;
  placeholder = ''; autocomplete = ''; inputMode = ''; tabIndex?: number;
  constructor(readonly tag: string, readonly doc: Doc) {}
  get tagName() { return this.tag.toUpperCase(); }
  get disabled() { return this.off; }
  set disabled(on: boolean) { this.off = !!on; }
  get classList() {
    const names = () => new Set(this.className.split(' ').filter(Boolean));
    const write = (set: Set<string>) => { this.className = [...set].join(' '); };
    return {
      add: (name: string) => { const s = names(); s.add(name); write(s); },
      remove: (name: string) => { const s = names(); s.delete(name); write(s); },
      toggle: (name: string, on?: boolean) => { const s = names(); if (on ?? !s.has(name)) s.add(name); else s.delete(name); write(s); },
      contains: (name: string) => names().has(name),
    };
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastElementChild(): El | null { return [...this.childNodes].reverse().find((c): c is El => c instanceof El) ?? null; }
  get nextSibling() { return sibling(this, 1); }
  insertBefore(child: Kid, ref: Kid | null) {
    if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(c => c !== child);
    child.parentNode = this;
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(child); else this.childNodes.splice(at, 0, child);
    return child;
  }
  append(...nodes: Array<Kid | string>) { for (const item of nodes) this.insertBefore(typeof item === 'string' ? new Txt(item) : item, null); }
  replaceChildren(...nodes: Array<Kid | string>) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter(c => c !== this); this.parentNode = null; } }
  get textContent(): string { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); if (value !== '' && value != null) this.append(String(value)); }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const ev: any = { type, target: this, shiftKey: false, ...init, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    const inDoc = this.isConnected;
    const atDoc = (capture: boolean) => {
      if (!inDoc || ev.stopped) return;
      ev.currentTarget = this.doc;
      for (const l of this.doc.listeners.filter(l => l.type === type && l.capture === capture)) l.fn(ev);
    };
    atDoc(true);
    for (let n: El | null = this; n && !ev.stopped; n = n.parentNode) { ev.currentTarget = n; for (const fn of n.listeners[type] || []) fn(ev); }
    atDoc(false);
    return ev;
  }
  // A click on a submit button submits its form, as in a browser; a disabled control ignores it.
  click() {
    if (this.disabled) return;
    const ev = this.dispatch('click');
    if (ev.defaultPrevented || this.tag !== 'button' || this.type !== 'submit') return;
    for (let n: El | null = this.parentNode; n; n = n.parentNode) if (n.tag === 'form') { n.dispatch('submit'); return; }
  }
  focus() { if (!this.disabled) this.doc.focused = this; }
  get isConnected(): boolean { for (let n: El | null = this; n; n = n.parentNode) if (n === this.doc.body) return true; return false; }
  querySelectorAll() { return all(this).filter(n => ['button', 'input', 'select', 'textarea'].includes(n.tag) || (n.tag === 'a' && !!n.href)); }
}
const all = (root: El): El[] => root.childNodes.flatMap(c => c instanceof El ? [c, ...all(c)] : []);
const has = (n: El, cls: string) => n.className.split(' ').includes(cls);
const named = (root: El, cls: string) => all(root).filter(n => has(n, cls));
const one = (root: El, cls: string) => { const n = named(root, cls)[0]; assert.ok(n, 'no .' + cls); return n; };
const shown = (n: El) => { for (let x: El | null = n; x; x = x.parentNode) if (x.hidden) return false; return true; };
const buttons = (root: El, text: string) => all(root).filter(n => n.tag === 'button' && n.textContent === text && shown(n));
const btn = (root: El, text: string) => { const b = buttons(root, text)[0]; assert.ok(b, 'no button ' + text); return b; };
const visibleText = (root: El): string => root.childNodes.map(c => c instanceof El ? (c.hidden ? '' : visibleText(c)) : c.textContent).join('');
const rows = (host: El) => all(host).filter(n => n.getAttribute('data-schedule'));
const rowOf = (host: El, id: string) => { const r = rows(host).find(n => n.getAttribute('data-schedule') === id); assert.ok(r, 'no row ' + id); return r!; };
const expand = (row: El) => { const head = one(row, 'sched-row'); if (head.getAttribute('aria-expanded') !== 'true') head.click(); return row; };
const formOf = (host: El) => { const f = all(host).find(n => n.tag === 'form'); assert.ok(f, 'no form'); return f!; };
function control(root: El, label: string): El {
  const lab = all(root).find(n => n.tag === 'label' && n.htmlFor && n.textContent === label);
  assert.ok(lab, 'no field ' + label);
  const target = all(root).find(n => n.id === lab!.htmlFor);
  assert.ok(target, 'no control for ' + label);
  return target!;
}
function type(input: El, value: string) { input.value = value; input.dispatch('input'); input.dispatch('change'); }
function kind(root: El, text: string) {
  const opt = all(root).find(n => n.tag === 'label' && has(n, 'choice-opt') && n.textContent === text);
  assert.ok(opt, 'no rule ' + text);
  const radio = all(opt!).find(n => n.type === 'radio')!;
  for (const r of all(root).filter(n => n.type === 'radio' && n.name === radio.name)) r.checked = r === radio;
  radio.dispatch('change');
}
function day(root: El, label: string, on: boolean) { const box = all(root).find(n => n.getAttribute('aria-label') === label)!; box.checked = on; box.dispatch('change'); }
function errorsOf(root: El) { return named(root, 'sched-err').filter(shown).map(n => n.textContent); }

function browser() {
  const doc = new Doc();
  let n = 0;
  const window: any = { crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0') } };
  const context = vm.createContext({ window, document: doc });
  vm.runInContext(read('client/public/schedules.js'), context);
  return { doc, S: window.ClowderSchedules };
}
const icon = (doc: Doc) => (name: string) => { const svg = doc.createElement('svg'); svg.className = 'icon'; svg.setAttribute('data-icon', name); return svg; };

type Call = { path: string; method: string; body?: any };
type Route = (path: string, method: string, body: any) => unknown;
function server(route: Route) {
  const calls: Call[] = [];
  const api = async (path: string, opt: { method?: string; body?: unknown } = {}) => {
    const method = opt.method || 'GET', body = opt.body === undefined ? undefined : plain(opt.body);
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    const out = await route(path, method, body);
    return out === undefined ? undefined : plain(out);
  };
  return { api, calls };
}
const fail = (status: number | undefined, message = 'request failed') => Object.assign(new Error(message), status ? { status } : {});
function defer<T = unknown>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// ---- test input ----
const BASE = '/xbot-api/bots/ada/routines';
const routine = (over: Record<string, unknown> = {}) => ({
  id: 'dyn-a', name: '早报', prompt: '整理今天的新闻', threadId: 'thread-now', currentThread: true,
  trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  enabled: true, effectiveEnabled: true, registered: true, status: 'scheduled', lastRun: null,
  runStats: { total: 0, delivered: 0, failed: 0, skipped: 0 }, ...over,
});
const listing = (routines: unknown[], over: Record<string, unknown> = {}) => ({ routines, currentThreadId: 'thread-now', timezone: 'Asia/Singapore', ...over });

function setup(route: Route, bot = 'ada') {
  const { doc, S } = browser();
  const host = doc.createElement('div');
  doc.body.append(host);
  const srv = server(route);
  const mount = (target = host, name = bot) => S.mount(target, { api: srv.api, bot: name, icon: icon(doc) });
  const section = mount();
  return { doc, S, host, section, mount, ...srv };
}
const gets = (calls: Call[], path = BASE) => calls.filter(c => c.method === 'GET' && c.path === path).length;

// ---- rules ----
test('rules: rule lines name their zone, weekdays are native (0 is Sunday), states keep enabled and effective apart', () => {
  const { S } = browser();
  const R = S.rules, at = Date.UTC(2026, 10, 5, 1, 0), now = Date.UTC(2026, 10, 4, 1, 0);
  assert.equal(R.ruleText({ type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Singapore' }, 'Asia/Shanghai', now), '每天 09:00（Asia/Singapore）');
  assert.equal(R.ruleText({ type: 'cron', expression: '30 7 * * 1,3,5', timezone: 'Asia/Shanghai' }, 'Asia/Shanghai', now), '每周一、三、五 07:30（Asia/Shanghai）');
  assert.equal(R.ruleText({ type: 'cron', expression: '0 18 * * 0,6', timezone: 'UTC' }, 'Asia/Shanghai', now), '每周六、日 18:00（UTC）');
  assert.equal(R.ruleText({ type: 'cron', expression: '0 9 * * 1,2,3,4,5', timezone: 'UTC' }, 'UTC', now), '工作日 09:00（UTC）');
  assert.equal(R.ruleText({ type: 'cron', expression: '*/5 * * * *' }, 'UTC', now), '自定义规则 */5 * * * *（未注明时区）', 'another cron is shown, not reinterpreted');
  assert.equal(R.ruleText({ type: 'interval', ms: 90 * 60000 }, 'UTC', now), '每 90 分钟');
  assert.equal(R.ruleText({ type: 'interval', ms: 10080 * 60000 }, 'UTC', now), '每 168 小时');
  assert.equal(R.ruleText({ type: 'once', fireAt: at }, 'Asia/Shanghai', now), '一次 · 11月5日 周四 09:00（Asia/Shanghai）');
  assert.equal(R.ruleText({ type: 'once', fireAt: at }, 'America/New_York', now), '一次 · 11月4日 周三 20:00（America/New_York）');
  assert.equal(R.ruleText({ type: 'once', fireAt: Date.UTC(2027, 0, 2, 1, 0) }, 'Asia/Shanghai', now), '一次 · 2027年1月2日 周六 09:00（Asia/Shanghai）');

  const state = (over: Record<string, unknown>) => R.stateOf(routine(over), now);
  assert.equal(state({}), 'scheduled');
  assert.equal(state({ effectiveEnabled: false, status: 'scheduled' }), 'blocked', 'a blocked task is never shown as enabled, whatever the summary says');
  assert.equal(state({ enabled: false, effectiveEnabled: false, status: 'scheduled' }), 'paused');
  assert.equal(state({ registered: false, status: 'scheduled' }), 'unregistered');
  const fired = { trigger: { type: 'once', fireAt: now - HOUR }, registered: false };
  assert.equal(state({ ...fired, status: 'delivered' }), 'delivered');
  assert.equal(state({ ...fired, status: 'missed' }), 'missed');
  assert.equal(state({ trigger: { type: 'once', fireAt: now + HOUR }, status: 'delivered' }), 'scheduled', 'a future once-task has not fired');
  assert.equal(R.stateText('blocked'), '暂不可触发');
  assert.equal(R.stateText('delivered'), '已触发');
  assert.equal(R.stateText('nonsense'), '状态未知');

  assert.deepEqual(plain(R.outcomeText('RUN_DELIVERED')), { text: '已触发', bad: false });
  assert.deepEqual(plain(R.outcomeText('RUN_FAILED')), { text: '触发失败', bad: true });
  assert.equal(R.outcomeText('SKIP_MISSED_WINDOW').text, '错过时间');
  assert.equal(R.outcomeText('SKIP_GLOBAL_PAUSE').text, '已跳过 · SKIP_GLOBAL_PAUSE', 'other skips keep the native reason');
  assert.equal(R.outcomeText('RUN_SOMETHING').text, '结果未知 · RUN_SOMETHING');
  for (const code of ['RUN_DELIVERED', 'RUN_FAILED', 'SKIP_OVERLAP']) assert.doesNotMatch(R.outcomeText(code).text, /完成|成功/);
  assert.equal(R.statsText({ total: 3, delivered: 2, failed: 1, skipped: 0 }), '共 3 次：已触发 2 · 失败 1');
  assert.equal(R.statsText({ total: 0, delivered: 0, failed: 0, skipped: 0 }), '');
});

test('rules: the form becomes exactly the contract body; local once-times carry this computer\'s offset', () => {
  const { S } = browser();
  const R = S.rules, now = Date.UTC(2026, 10, 4, 1, 0);
  const ok = (input: Record<string, unknown>) => { const out = R.createBody({ name: ' 早报 ', prompt: ' 看新闻 ', ...input }, now); assert.ok(out.body, JSON.stringify(out.issues)); return plain(out.body); };
  assert.deepEqual(ok({ kind: 'once', at: '2026-11-05T09:00' }), { name: '早报', prompt: '看新闻', schedule: { kind: 'once', at: '2026-11-05T09:00:00+08:00' } });
  assert.deepEqual(ok({ kind: 'daily', time: '07:30', timezone: 'Asia/Singapore' }).schedule, { kind: 'daily', time: '07:30', timezone: 'Asia/Singapore' });
  assert.deepEqual(ok({ kind: 'weekly', time: '18:00:00', days: [0, 5, 5, 1], timezone: 'UTC' }).schedule, { kind: 'weekly', time: '18:00', days: [0, 1, 5], timezone: 'UTC' });
  assert.deepEqual(ok({ kind: 'interval', minutes: '1' }).schedule, { kind: 'interval', minutes: 1 });
  assert.deepEqual(ok({ kind: 'interval', minutes: '10080' }).schedule, { kind: 'interval', minutes: 10080 });
  const issues = (input: Record<string, unknown>) => plain((R.createBody({ name: 'n', prompt: 'p', ...input }, now).issues || []).map((i: any) => i.field));
  assert.deepEqual(issues({ name: '  ', prompt: '', kind: 'interval', minutes: '5' }), ['name', 'prompt']);
  assert.deepEqual(issues({ name: 'x'.repeat(81), kind: 'interval', minutes: '5' }), ['name']);
  for (const minutes of ['0', '10081', '1.5', '-3', '', 'abc']) assert.deepEqual(issues({ kind: 'interval', minutes }), ['minutes'], minutes);
  assert.deepEqual(issues({ kind: 'weekly', time: '09:00', days: [], timezone: 'UTC' }), ['days']);
  assert.deepEqual(issues({ kind: 'daily', time: '25:00', timezone: 'Mars/Base' }), ['time', 'timezone']);
  assert.deepEqual(issues({ kind: 'once', at: '2026-11-04T08:59' }), ['at'], 'a past time is refused before sending');
  assert.deepEqual(issues({ kind: 'once', at: '' }), ['at']);
  assert.deepEqual(issues({ kind: 'cron' }), ['kind'], 'no arbitrary rule kind');
  assert.equal(R.fingerprint({ name: 'a', prompt: 'b', schedule: { kind: 'interval', minutes: 5 } }), R.fingerprint({ name: 'a', prompt: 'b', schedule: { kind: 'interval', minutes: 5 } }));
  assert.match(R.requestKey(), /^[0-9a-f-]{36}$/);
  assert.equal(R.reason(fail(503, '定时任务需要更新 Clowder AI 运行时，请运行 npm run runtime:prepare 后重新启动运行时。')), '定时任务需要更新 Clowder AI 运行时，请运行 npm run runtime:prepare 后重新启动运行时');
  assert.equal(R.reason(fail(502, '<html><body>Bad gateway</body></html>')), '', 'a proxy page is not shown');
  assert.equal(R.unsure(fail(undefined, '连不上 clowder-bot')), true);
  assert.equal(R.unsure(fail(502)), true);
  assert.equal(R.unsure(fail(409)), false);
});

test('rules: a wall time skipped by daylight saving is refused instead of moved', () => {
  const before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const { S } = browser();
    assert.deepEqual(plain(S.rules.localInstant('2030-03-10T02:30')), { gap: true });
    assert.equal(S.rules.localInstant('2030-03-10T03:30').at, '2030-03-10T03:30:00-04:00');
    assert.equal(S.rules.localInstant('2030-01-10T09:00').at, '2030-01-10T09:00:00-05:00');
  } finally { process.env.TZ = before; }
});

// ---- the section ----
test('the section reads its own list on mount, labels chats and zones, and frequent syncs neither re-read nor reset it', async () => {
  const later = Date.now() + 26 * HOUR;
  const t = setup(() => listing([
    routine(),
    routine({ id: 'dyn-old', name: '周报', currentThread: false, threadId: 'thread/old 1', trigger: { type: 'cron', expression: '0 18 * * 5', timezone: 'Asia/Singapore' } }),
    routine({ id: 'dyn-once', name: '提醒喝水', trigger: { type: 'once', fireAt: later } }),
  ]));
  assert.equal(t.section.parentNode, t.host);
  assert.match(visibleText(t.section), /正在读取…/);
  await settle();
  assert.deepEqual(t.calls, [{ path: BASE, method: 'GET' }]);
  assert.equal(one(t.section, 'sched-head').textContent.startsWith('定时任务 · 3'), true);
  assert.deepEqual(rows(t.host).map(r => one(r, 'sched-name').textContent), ['早报', '周报', '提醒喝水']);
  assert.equal(one(rowOf(t.host, 'dyn-a'), 'sched-sub').textContent, '每天 09:00（Asia/Shanghai） · 当前聊天');
  assert.equal(one(rowOf(t.host, 'dyn-old'), 'sched-sub').textContent, '每周五 18:00（Asia/Singapore） · 创建时的聊天');
  assert.match(one(rowOf(t.host, 'dyn-once'), 'sched-sub').textContent, /^一次 · \d+月\d+日 周. \d\d:\d\d（Asia\/Shanghai） · 当前聊天$/);

  // An earlier chat: no claim it reaches the current chat; its native panel by thread.
  const old = expand(rowOf(t.host, 'dyn-old'));
  assert.match(visibleText(old), /结果发到创建时的聊天，不会发到当前聊天。/);
  const link = all(old).find(n => n.tag === 'a')!;
  assert.equal(link.href, '/runtime.html?thread=thread%2Fold%201');
  assert.equal(link.textContent, '在运行面板查看');
  assert.equal(link.target, '_blank');
  assert.match(one(old, 'sched-ids').textContent, /任务 ID.*dyn-old.*聊天 ID.*thread\/old 1/);
  assert.equal(all(expand(rowOf(t.host, 'dyn-a'))).some(n => n.tag === 'a'), false, 'the current chat needs no link');

  // Open a form and a history, then sync many times as the profile poll does.
  btn(t.section, '新建').click();
  type(control(t.section, '名称'), '半截草稿');
  btn(old, '触发记录').click();
  await settle();
  const before = t.calls.length;
  for (let i = 0; i < 5; i++) assert.equal(t.mount(), t.section);
  await settle();
  assert.equal(t.calls.length, before, 'a sync into the same task view sends nothing');
  assert.equal(control(t.section, '名称').value, '半截草稿');
  assert.equal(one(old, 'sched-runs-box').hidden, false);

  // The tab was rebuilt: the same section moves into the new view and reads its list again.
  const rebuilt = t.doc.createElement('div');
  t.doc.body.append(rebuilt);
  t.host.remove();
  assert.equal(t.mount(rebuilt), t.section);
  assert.equal(t.section.parentNode, rebuilt);
  await settle();
  assert.equal(gets(t.calls), 2);
  assert.equal(control(t.section, '名称').value, '半截草稿', 'typed text survives the rebuild');
  assert.equal(rowOf(rebuilt, 'dyn-old'), old, 'rows are kept by ID, open state with them');
  assert.equal(one(old, 'sched-runs-box').hidden, false);
});

test('loading, empty and failed reads stay distinct; a failed refresh keeps the last list and says so', async () => {
  let answer: () => unknown = () => { throw fail(503, '定时任务需要更新 Clowder AI 运行时，请运行 npm run runtime:prepare 后重新启动运行时'); };
  const t = setup(() => answer());
  await settle();
  const text = visibleText(t.section);
  assert.match(text, /没能读取定时任务：定时任务需要更新 Clowder AI 运行时，请运行 npm run runtime:prepare 后重新启动运行时。/);
  assert.doesNotMatch(text, /还没有定时任务/, 'a failure is not an empty list');
  assert.equal(rows(t.host).length, 0);
  answer = () => listing([]);
  btn(t.section, '重试').click();
  await settle();
  // Item 46: none is the heading's count (· 0) beside 新建, without a sentence repeating it.
  assert.match(visibleText(t.section), /^定时任务 · 0/);
  assert.doesNotMatch(visibleText(t.section), /还没有定时任务/);
  assert.equal(buttons(t.section, '重试').length, 0);
  answer = () => listing([routine()]);
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(rows(t.host).length, 1);
  answer = () => { throw fail(undefined, '连不上 clowder-bot'); };
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(rows(t.host).length, 1, 'the last list stays');
  assert.equal(one(t.section, 'sched-status').textContent, '没能刷新：连不上 clowder-bot。下面是上次读取的结果。');
  answer = () => listing([routine()]);
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(one(t.section, 'sched-status').hidden, true, 'a good read clears the stale warning');

  // While a read is out, 刷新 is disabled and a second click sends nothing.
  const slow = defer();
  answer = () => slow.promise;
  const refresh = btn(t.section, '刷新');
  refresh.focus();
  refresh.click();
  refresh.click();
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.textContent, '正在刷新…');
  const count = gets(t.calls);
  slow.resolve(listing([routine()]));
  await settle();
  assert.equal(gets(t.calls), count);
  assert.equal(t.doc.activeElement, refresh, 'focus comes back to 刷新');
});

test('enabled, effective and registered stay separate; 已触发 is never a finished job; failures keep the native reason', async () => {
  const now = Date.now();
  const t = setup(() => listing([
    routine({ id: 'blocked', name: '被挡住', effectiveEnabled: false, status: 'blocked' }),
    routine({ id: 'paused', name: '暂停的', enabled: false, effectiveEnabled: false, status: 'paused' }),
    // A finished once-task is kept as a disabled record (schedules-api.md).
    routine({ id: 'fired', name: '已发出', trigger: { type: 'once', fireAt: now - HOUR }, enabled: false, registered: false, effectiveEnabled: false, status: 'delivered',
      lastRun: { outcome: 'RUN_DELIVERED', started_at: new Date(now - HOUR).toISOString(), duration_ms: 12, error_summary: null, assigned_cat_id: 'cat-1' },
      runStats: { total: 1, delivered: 1, failed: 0, skipped: 0 } }),
    routine({ id: 'broken', name: '出错的', lastRun: { outcome: 'RUN_FAILED', started_at: new Date(now - 2 * HOUR).toISOString(), duration_ms: 3, error_summary: 'thread deleted', assigned_cat_id: null },
      runStats: { total: 4, delivered: 3, failed: 1, skipped: 0 } }),
    routine({ id: 'late', name: '错过的', trigger: { type: 'once', fireAt: now - 3 * HOUR }, enabled: false, registered: false, effectiveEnabled: false, status: 'missed' }),
    routine({ id: 'stale', name: '过期暂停', trigger: { type: 'once', fireAt: now - HOUR }, enabled: false, registered: false, effectiveEnabled: false, status: 'paused' }),
    routine({ id: 'ghost', name: '没登记', registered: false, status: 'unregistered' }),
  ]));
  await settle();
  const flag = (id: string) => one(rowOf(t.host, id), 'sched-flag').textContent;
  assert.deepEqual(['blocked', 'paused', 'fired', 'broken', 'late', 'stale', 'ghost'].map(flag), ['暂不可触发', '已暂停', '已触发', '已启用', '错过时间', '已暂停', '未生效']);

  const blocked = expand(rowOf(t.host, 'blocked'));
  assert.match(visibleText(blocked), /已启用，但被全局暂停或治理规则挡住，暂时不会触发。/);
  assert.ok(btn(blocked, '暂停'), 'the owner can still pause it');

  const fired = expand(rowOf(t.host, 'fired'));
  assert.match(visibleText(fired), /上次已触发 · .*（Asia\/Shanghai）/);
  assert.match(visibleText(fired), /「已触发」只表示消息已发给猫猫，不代表工作已完成。/);
  assert.doesNotMatch(visibleText(fired), /已完成(?!。)|执行完成|成功/);
  assert.equal(buttons(fired, '暂停').length + buttons(fired, '恢复').length, 0, 'a fired once-task has nothing to pause or resume');
  assert.doesNotMatch(visibleText(fired), /已暂停|不能恢复/, 'fired is not described as paused');
  assert.match(visibleText(fired), /次数共 1 次：已触发 1/);

  const broken = expand(rowOf(t.host, 'broken'));
  assert.match(visibleText(broken), /上次触发失败 · .*thread deleted/);
  assert.equal(named(broken, 'sched-why')[0].textContent, 'thread deleted');

  const late = expand(rowOf(t.host, 'late'));
  assert.equal(buttons(late, '恢复').length, 0);
  assert.match(visibleText(late), /错过的时间不会补跑，需要时请新建。/);
  const stale = expand(rowOf(t.host, 'stale'));
  assert.equal(buttons(stale, '恢复').length, 0, 'a once-time that has passed cannot be resumed');
  assert.match(visibleText(stale), /时间已过的一次任务不能恢复，需要时请新建。/);
  assert.ok(btn(expand(rowOf(t.host, 'paused')), '恢复'));
  assert.match(visibleText(expand(rowOf(t.host, 'ghost'))), /运行时目前没有登记这个任务，不会按时触发。/);
  assert.doesNotMatch(visibleText(t.section), /立即|马上运行|编辑|cron/i, 'no run-now or rule editor');
  // Only a repeating task's message can be changed: the once-tasks have no 改消息, the cron ones do.
  for (const id of ['fired', 'late', 'stale']) assert.equal(buttons(rowOf(t.host, id), '改消息').length, 0, id);
  for (const id of ['blocked', 'paused', 'broken', 'ghost']) assert.ok(btn(rowOf(t.host, id), '改消息'), id);
});

test('create sends the contract body for each rule; the server binds the cat and the chat', async () => {
  const created: any[] = [];
  const t = setup((path, method, body) => {
    if (method === 'POST') { created.push(body); return { id: 'dyn-new-' + created.length, name: body.name, prompt: body.prompt, trigger: {}, threadId: 'thread-now' }; }
    return listing([]);
  });
  await settle();
  const add = btn(t.section, '新建');
  const make = (fill: (form: El) => void) => {
    add.click();
    const form = formOf(t.section);
    assert.equal(t.doc.activeElement, control(form, '名称'), 'the form opens on its name');
    type(control(form, '名称'), '提醒');
    type(control(form, '消息'), '记得喝水');
    fill(form);
    btn(form, '创建').click();
  };
  make(form => {
    // Review r15: what is true for each rule, beside its own fields; what every rule needs, once under them.
    assert.match(visibleText(form), /clowder-bot 关着、电脑关机或休眠时，定时不会运行。/);
    assert.match(visibleText(form), /按本机时区（[^）]*）。错过了不会补。/, '一次: a missed time is not made up');
    assert.doesNotMatch(visibleText(form), /重新启动后会马上运行一次/);
    type(control(form, '日期和时间'), '2099-11-05T09:00');
  });
  await settle();
  make(form => {
    kind(form, '每天');
    // Daily and weekly: the engine may make up one missed run after the computer wakes, so nothing says it is not.
    assert.doesNotMatch(visibleText(form), /错过了不会补|错过的不补|重新启动后会马上运行一次/);
    assert.match(visibleText(form), /clowder-bot 关着、电脑关机或休眠时，定时不会运行。/);
    type(control(form, '时间'), '07:30');
  });
  await settle();
  make(form => {
    kind(form, '每周');
    for (const label of ['周一', '周二', '周三', '周四', '周五', '周六', '周日']) day(form, label, false);
    day(form, '周日', true); day(form, '周五', true);
    const zone = control(form, '时区');
    assert.deepEqual(all(zone).map(o => [o.value, o.textContent]), [['Asia/Shanghai', 'Asia/Shanghai（本机）'], ['Asia/Singapore', 'Asia/Singapore']], 'this computer\'s zone first, the server\'s as the other choice');
    assert.equal(zone.value, 'Asia/Shanghai');
    type(zone, 'Asia/Singapore');
  });
  await settle();
  make(form => {
    assert.equal(shown(control(form, '间隔（分钟）')), false, 'only the chosen rule\'s fields show');
    kind(form, '间隔');
    assert.equal(shown(control(form, '日期和时间')), false);
    // The range, when the first one comes, and (review r15) that it runs at once when clowder-bot starts again.
    assert.match(visibleText(form), /1–10080 分钟。创建或恢复后先等满一个间隔；clowder-bot 重新启动后会马上运行一次。/);
    assert.doesNotMatch(visibleText(form), /要固定钟点|错过了不会补/);
    type(control(form, '间隔（分钟）'), '90');
  });
  await settle();
  assert.deepEqual(created.map(b => Object.keys(b).sort()), Array(4).fill(['idempotencyKey', 'name', 'prompt', 'schedule']));
  assert.deepEqual(created.map(b => b.schedule), [
    { kind: 'once', at: '2099-11-05T09:00:00+08:00' },
    { kind: 'daily', time: '07:30', timezone: 'Asia/Shanghai' },
    { kind: 'weekly', time: '09:00', days: [0, 5], timezone: 'Asia/Singapore' },
    { kind: 'interval', minutes: 90 },
  ]);
  assert.equal(new Set(created.map(b => b.idempotencyKey)).size, 4, 'each new form has its own key');
  assert.ok(t.calls.every(c => c.path.startsWith(BASE)), 'only this cat\'s routines are touched');
  assert.doesNotMatch(JSON.stringify(created), /targetCatId|threadId|deliveryThreadId|cron/);
  assert.match(visibleText(t.section), /已创建「提醒」。/);
});

test('a form keeps the input on errors, blocks duplicate saves, reuses its key only for unchanged content', async () => {
  const replies: Array<() => unknown> = [];
  const pending = defer();
  let posts = 0;
  const t = setup((path, method) => {
    if (method !== 'POST') return listing([]);
    posts++;
    return (replies.shift() || (() => pending.promise))();
  });
  await settle();
  btn(t.section, '新建').click();
  const form = formOf(t.section), ok = btn(form, '创建');
  // Problems are found before anything is sent, next to their fields.
  type(control(form, '名称'), '  ');
  kind(form, '间隔');
  type(control(form, '间隔（分钟）'), '0');
  ok.click();
  assert.equal(posts, 0);
  assert.deepEqual(errorsOf(form), ['请填写名称', '请填写到时发给猫猫的消息', '请填 1–10080 之间的整数分钟']);
  assert.equal(control(form, '名称').getAttribute('aria-invalid'), 'true');
  assert.equal(t.doc.activeElement, control(form, '名称'));
  const minutes = control(form, '间隔（分钟）'), described = () => (minutes.getAttribute('aria-describedby') || '').split(' ').map(id => all(form).find(n => n.id === id)!.textContent);
  assert.deepEqual(described(), ['请填 1–10080 之间的整数分钟', '1–10080 分钟。创建或恢复后先等满一个间隔；clowder-bot 重新启动后会马上运行一次。'], 'the error joins the field note');
  type(control(form, '名称'), '晨会');
  assert.deepEqual(errorsOf(form), ['请填写到时发给猫猫的消息', '请填 1–10080 之间的整数分钟'], 'typing clears that field');
  type(control(form, '消息'), '准备晨会');
  type(control(form, '间隔（分钟）'), '30');
  assert.equal(described().length, 1, 'a fixed field keeps only its note');

  replies.push(() => { throw fail(422, '请先给这只猫猫选一个能用的本机 Agent'); });
  ok.click();
  await settle();
  assert.equal(one(form, 'error').textContent, '没能创建：请先给这只猫猫选一个能用的本机 Agent。');
  assert.equal(control(form, '名称').value, '晨会', 'input survives a refusal');
  assert.equal(formOf(t.section), form);
  const firstKey = t.calls.filter(c => c.method === 'POST')[0].body.idempotencyKey;

  // The outcome is unknown (the runtime may have made it): say so, keep the key for a retry.
  replies.push(() => { throw fail(502, '引擎没有确认定时已经建好，请刷新列表核对'); });
  ok.click();
  await settle();
  assert.equal(one(form, 'error').textContent, '没能确认是否已创建：引擎没有确认定时已经建好，请刷新列表核对。请先点「刷新」核对列表，没有再重试。');
  assert.equal(t.calls.filter(c => c.method === 'POST')[1].body.idempotencyKey, firstKey, 'the same content is the same request');

  // A changed form is a new request with a new key.
  type(control(form, '间隔（分钟）'), '45');
  ok.click();
  ok.click();
  form.dispatch('submit');
  await settle();
  assert.equal(posts, 3, 'one save at a time');
  const third = t.calls.filter(c => c.method === 'POST')[2].body;
  assert.notEqual(third.idempotencyKey, firstKey);
  assert.deepEqual(third.schedule, { kind: 'interval', minutes: 45 });
  assert.equal(ok.disabled, true);
  assert.equal(ok.textContent, '正在创建…');
  assert.equal(one(form, 'sched-fields').disabled, true);
  assert.equal(btn(form, '取消').disabled, true);
  const escape = control(form, '名称').dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.stopped, true, 'Escape never reaches the drawer');
  assert.equal(formOf(t.section), form, 'Escape waits while saving');

  pending.resolve({ id: 'dyn-1', name: '晨会', prompt: '准备晨会', trigger: { type: 'interval', ms: 2700000 }, threadId: 'thread-now' });
  await settle();
  assert.equal(all(t.section).some(n => n.tag === 'form'), false, 'saved: the form closes');
  assert.equal(t.doc.activeElement, btn(t.section, '新建'));
  assert.equal(btn(t.section, '新建').getAttribute('aria-expanded'), 'false');
  btn(t.section, '新建').click();
  assert.equal(control(formOf(t.section), '名称').value, '', 'a new form starts empty');
});

test('a created task whose list re-read fails is reported as created, never as a failed create', async () => {
  let reads = 0;
  const t = setup((path, method, body) => {
    if (method === 'POST') return { id: 'dyn-2', name: body.name, prompt: body.prompt, trigger: {}, threadId: 'thread-now' };
    reads++;
    if (reads > 1) throw fail(500, '服务出现异常，请查看日志。');
    return listing([]);
  });
  await settle();
  btn(t.section, '新建').click();
  const form = formOf(t.section);
  type(control(form, '名称'), '周报');
  type(control(form, '消息'), '写周报');
  kind(form, '每天');
  btn(form, '创建').click();
  await settle();
  assert.equal(t.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(all(t.section).some(n => n.tag === 'form'), false, 'the form is not offered again');
  const status = one(t.section, 'sched-status');
  assert.equal(status.textContent, '已创建「周报」，但没能刷新列表：服务出现异常，请查看日志。点「刷新」再试，不用重新创建。');
  assert.doesNotMatch(visibleText(t.section), /没能创建|没能确认是否已创建/);
});

test('Escape and 取消 close the form back to 新建 without touching the drawer', async () => {
  const t = setup(() => listing([]));
  await settle();
  const add = btn(t.section, '新建');
  add.click();
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  type(control(formOf(t.section), '名称'), '草稿');
  const ev = control(formOf(t.section), '消息').dispatch('keydown', { key: 'Escape' });
  assert.equal(ev.stopped, true);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(all(t.section).some(n => n.tag === 'form'), false);
  assert.equal(t.doc.activeElement, add);
  add.click();
  assert.equal(control(formOf(t.section), '名称').value, '', 'a dismissed form does not come back');
  btn(formOf(t.section), '取消').click();
  assert.equal(all(t.section).some(n => n.tag === 'form'), false);
  assert.equal(t.doc.activeElement, add);
});

test('answers for a cat left behind never reach the next cat or bring back what was closed', async () => {
  const posted = defer(), firstList = defer();
  let lists = 0;
  const t = setup((path, method) => {
    if (method === 'POST') return posted.promise;
    if (path === BASE) { lists++; return lists === 1 ? listing([routine()]) : listing([routine(), routine({ id: 'dyn-made', name: '新任务' })]); }
    if (path === '/xbot-api/bots/bo/routines') return firstList.promise;
    throw fail(404);
  });
  await settle();
  btn(t.section, '新建').click();
  const form = formOf(t.section);
  type(control(form, '名称'), '新任务');
  type(control(form, '消息'), 'hi');
  kind(form, '每天');
  btn(form, '创建').click();
  await settle();

  // Another cat is opened: ada's section and its form go; bo gets its own.
  t.S.teardown();
  assert.equal(t.section.isConnected, false);
  const bo = t.mount(t.host, 'bo');
  assert.notEqual(bo, t.section);
  posted.resolve({ id: 'dyn-made', name: '新任务', prompt: 'hi', trigger: {}, threadId: 'thread-now' });
  await settle();
  assert.equal(gets(t.calls), 1, 'no re-read for ada while bo is open');
  assert.doesNotMatch(visibleText(bo), /新任务|已创建/);
  assert.equal(all(bo).some(n => n.tag === 'form'), false);

  // Back to ada: a fresh section with its own read; the old form stays closed.
  t.S.teardown();
  const again = t.mount(t.host, 'ada');
  await settle();
  assert.equal(all(again).some(n => n.tag === 'form'), false);
  assert.deepEqual(rows(t.host).map(r => r.getAttribute('data-schedule')), ['dyn-a', 'dyn-made']);
  // bo's first list arrives after bo was left: nothing of it shows under ada.
  firstList.resolve(listing([routine({ id: 'bo-only', name: '别的猫' })]));
  await settle();
  assert.doesNotMatch(visibleText(again), /别的猫/);
  assert.equal(rows(t.host).some(r => r.getAttribute('data-schedule') === 'bo-only'), false);
});

test('a create that lands after its section closed makes the reopened section of the same cat read again, without its form', async () => {
  const posted = defer();
  let made = false;
  const t = setup((path, method) => {
    if (method === 'POST') return posted.promise;
    return listing(made ? [routine(), routine({ id: 'dyn-made', name: '晚到' })] : [routine()]);
  });
  await settle();
  btn(t.section, '新建').click();
  const form = formOf(t.section);
  type(control(form, '名称'), '晚到');
  type(control(form, '消息'), 'hi');
  btn(form, '创建').click();
  await settle();
  t.S.teardown();
  const again = t.mount();
  await settle();
  assert.deepEqual(rows(t.host).map(r => r.getAttribute('data-schedule')), ['dyn-a']);
  made = true;
  posted.resolve({ id: 'dyn-made', name: '晚到', prompt: 'hi', trigger: {}, threadId: 'thread-now' });
  await settle();
  assert.deepEqual(rows(t.host).map(r => r.getAttribute('data-schedule')), ['dyn-a', 'dyn-made']);
  assert.equal(all(again).some(n => n.tag === 'form'), false, 'the closed form does not come back');
  assert.equal(named(again, 'sched-status').filter(shown).length, 0);
});

test('only the newest read draws: an older list or record answer arriving last is dropped', async () => {
  const first = defer(), second = defer();
  const lists = [() => first.promise, () => second.promise, () => listing([routine()])];
  const runs = [defer(), defer()];
  let runReads = 0;
  const t = setup((path) => {
    if (path.endsWith('/runs')) return runs[runReads++].promise;
    return lists.shift()!();
  });
  t.S.reopened(); // the drawer opened again while the first read was out
  second.resolve(listing([routine(), routine({ id: 'dyn-b', name: '晚报' })]));
  await settle();
  first.resolve(listing([routine({ id: 'dyn-old', name: '旧列表' })]));
  await settle();
  assert.deepEqual(rows(t.host).map(r => r.getAttribute('data-schedule')), ['dyn-a', 'dyn-b']);

  const row = expand(rowOf(t.host, 'dyn-a')), open = btn(row, '触发记录'), box = one(row, 'sched-runs-box');
  open.click(); // read 1
  open.click(); // closed
  open.click(); // read 2
  const run = (outcome: string) => ({ runs: [{ outcome, started_at: new Date().toISOString(), duration_ms: 1, error_summary: null, assigned_cat_id: null }] });
  runs[1].resolve(run('RUN_FAILED'));
  await settle();
  runs[0].resolve(run('RUN_DELIVERED'));
  await settle();
  assert.deepEqual(named(box, 'sched-run-what').map(n => n.textContent), ['触发失败'], 'the earlier answer never paints over the later one');
  const before = box.textContent;
  open.click(); // closed again
  assert.equal(box.textContent, before);
});

test('pause and resume send only enabled, hold the row while sending, and report what native refused', async () => {
  const patch = defer();
  let state = routine();
  const replies: Array<() => unknown> = [() => patch.promise];
  const t = setup((path, method, body) => {
    if (method === 'PATCH') return replies.shift()!();
    if (method === 'GET' && path === BASE) return listing([state]);
    throw fail(404);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  const pause = btn(row, '暂停');
  pause.focus();
  pause.click();
  assert.deepEqual(t.calls.at(-1), { path: BASE + '/dyn-a', method: 'PATCH', body: { enabled: false } });
  assert.equal(pause.textContent, '正在暂停…');
  assert.equal(pause.disabled, true);
  assert.equal(btn(row, '删除').disabled, true, 'nothing else on the row runs meanwhile');
  pause.click();
  assert.equal(t.calls.filter(c => c.method === 'PATCH').length, 1);
  state = routine({ enabled: false, effectiveEnabled: false, status: 'paused' });
  patch.resolve({ success: true, enabled: false });
  await settle();
  assert.equal(gets(t.calls), 2, 'the list is read again after a change');
  assert.equal(one(row, 'sched-flag').textContent, '已暂停');
  assert.match(one(row, 'sched-msg').textContent, /已暂停，之后不会再触发；已经开始的执行不受影响。/);
  const resume = btn(row, '恢复');
  assert.equal(resume, pause, 'the same control, so focus stays');
  assert.equal(t.doc.activeElement, resume);

  replies.push(() => { throw fail(409, '投递聊天已不可用或不再包含这只猫，请新建定时任务'); });
  resume.click();
  await settle();
  assert.deepEqual(t.calls.filter(c => c.method === 'PATCH').at(-1)!.body, { enabled: true });
  assert.equal(one(row, 'sched-msg').textContent, '没能恢复：投递聊天已不可用或不再包含这只猫，请新建定时任务。已重新读取列表。');
  assert.equal(gets(t.calls), 3);
  assert.equal(one(row, 'sched-flag').textContent, '已暂停', 'nothing is shown as resumed');

  replies.push(() => { throw fail(undefined, '连不上 clowder-bot'); });
  btn(row, '恢复').click();
  await settle();
  assert.equal(one(row, 'sched-msg').textContent, '没能确认是否已恢复：连不上 clowder-bot。请刷新核对。');
});

test('delete asks in the original modal card, keeps Escape and focus inside, and only says what is true', async () => {
  const removal = defer();
  const replies: Array<() => unknown> = [() => { throw fail(500, '服务出现异常，请查看日志。'); }, () => removal.promise];
  let list = [routine(), routine({ id: 'dyn-b', name: '晚报' })];
  const t = setup((path, method) => {
    if (method === 'DELETE') return replies.shift()!();
    if (path === BASE) return listing(list);
    throw fail(404);
  });
  const drawerKeys: string[] = [];
  t.doc.body.addEventListener('keydown', (ev: any) => drawerKeys.push(ev.key));
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  const del = btn(row, '删除');
  del.click();
  const dialog = () => named(t.doc.body, 'sched-modal')[0];
  assert.ok(dialog());
  const card = one(dialog(), 'modal-card');
  assert.equal(card.getAttribute('role'), 'alertdialog');
  assert.equal(all(card).find(n => n.tag === 'h2')!.textContent, '删除「早报」？');
  assert.equal(one(card, 'note').textContent, '删除后不会再触发。已经开始或排队的执行不会因此取消。');
  assert.equal(t.doc.activeElement, btn(card, '取消'), 'the safe choice has focus');
  btn(card, '取消').dispatch('keydown', { key: 'Escape' });
  assert.equal(dialog(), undefined);
  assert.equal(t.doc.activeElement, del, 'focus returns to 删除');
  assert.deepEqual(drawerKeys, [], 'the drawer never saw Escape');
  assert.equal(t.calls.filter(c => c.method === 'DELETE').length, 0);

  // A failed delete keeps the dialog with an honest line.
  del.click();
  btn(dialog(), '删除').click();
  await settle();
  assert.equal(one(dialog(), 'error').textContent, '没能确认是否已删除：服务出现异常，请查看日志。请关闭后刷新列表核对。');
  assert.equal(rows(t.host).length, 2);

  // While deleting, nothing in the dialog answers, Escape included.
  btn(dialog(), '删除').click();
  const go = buttons(dialog(), '正在删除…')[0];
  assert.ok(go && go.disabled);
  assert.equal(btn(dialog(), '取消').disabled, true);
  go.dispatch('keydown', { key: 'Escape' });
  assert.ok(dialog(), 'Escape waits while deleting');
  assert.equal(btn(row, '正在删除…').disabled, true);
  list = [routine({ id: 'dyn-b', name: '晚报' })];
  removal.resolve({ success: true });
  await settle();
  assert.equal(dialog(), undefined);
  assert.deepEqual(t.calls.filter(c => c.method === 'DELETE').map(c => c.path), [BASE + '/dyn-a', BASE + '/dyn-a']);
  assert.deepEqual(rows(t.host).map(r => r.getAttribute('data-schedule')), ['dyn-b']);
  assert.equal(one(t.section, 'sched-status').textContent, '已删除「早报」，之后不会再触发；已经开始的执行不受影响。');
  assert.equal(t.doc.activeElement, one(rowOf(t.host, 'dyn-b'), 'sched-row'), 'focus moves to the next task');
  assert.equal(gets(t.calls), 2);
});

test('leaving the cat closes its delete dialog; a late answer only refreshes the same cat when it is open again', async () => {
  const removal = defer();
  let list = [routine()];
  const t = setup((path, method) => {
    if (method === 'DELETE') return removal.promise;
    return listing(list);
  });
  await settle();
  btn(expand(rowOf(t.host, 'dyn-a')), '删除').click();
  btn(named(t.doc.body, 'sched-modal')[0], '删除').click();
  t.S.teardown();
  assert.equal(named(t.doc.body, 'sched-modal').length, 0, 'the dialog belongs to the cat left behind');
  const again = t.mount();
  await settle();
  assert.equal(rows(t.host).length, 1);
  list = [];
  removal.resolve({ success: true });
  await settle();
  assert.equal(rows(t.host).length, 0, 'the open section of the same cat reads its list again');
  assert.equal(named(again, 'sched-status').filter(shown).length, 0, 'no message of the closed section comes back');
});

test('trigger records: native outcomes in plain words, zone named, failures with retry, closed stays closed', async () => {
  const now = Date.now();
  const late = defer();
  const replies: Array<() => unknown> = [
    () => { throw fail(404, '找不到这只猫的定时任务'); },
    () => ({ runs: [
      { outcome: 'RUN_DELIVERED', started_at: new Date(now - HOUR).toISOString(), fired_at: new Date(now - HOUR).toISOString(), duration_ms: 20, error_summary: null, assigned_cat_id: 'cat-1' },
      { outcome: 'RUN_FAILED', started_at: new Date(now - 2 * HOUR).toISOString(), duration_ms: 3, error_summary: 'delivery thread missing', assigned_cat_id: null },
      { outcome: 'SKIP_MISSED_WINDOW', started_at: new Date(now - 3 * HOUR).toISOString(), scheduled_at: new Date(now - 4 * HOUR).toISOString(), duration_ms: 0, error_summary: null, assigned_cat_id: null },
      { outcome: 'SKIP_OVERLAP', started_at: new Date(now - 5 * HOUR).toISOString(), duration_ms: 0, error_summary: 'previous run active', assigned_cat_id: null },
    ] }),
    () => late.promise,
  ];
  const t = setup((path, method) => {
    if (path === BASE + '/dyn-a/runs') return replies.shift()!();
    if (path === BASE) return listing([routine()]);
    throw fail(404);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  const open = btn(row, '触发记录'), box = one(row, 'sched-runs-box');
  open.click();
  assert.equal(open.getAttribute('aria-expanded'), 'true');
  assert.match(visibleText(box), /正在读取…/);
  await settle();
  assert.equal(visibleText(box), '没能读取触发记录：找不到这只猫的定时任务。重试');
  btn(box, '重试').click();
  await settle();
  assert.match(one(box, 'sched-runs-head').textContent, /^最近 4 条 · 时间为 Asia\/Shanghai$/);
  const lines = named(box, 'sched-run').map(n => one(n, 'sched-run-what').textContent);
  assert.deepEqual(lines, ['已触发', '触发失败', '错过时间', '已跳过 · SKIP_OVERLAP']);
  assert.ok(has(named(box, 'sched-run-what')[1], 'bad'));
  assert.deepEqual(named(box, 'sched-run-why').map(n => n.textContent), ['delivery thread missing', 'previous run active']);
  assert.doesNotMatch(visibleText(box), /完成|成功/);

  // Closed while a read is out: the late answer neither opens nor fills it.
  open.click();
  open.click();
  open.click();
  assert.equal(box.hidden, true);
  late.resolve({ runs: [{ outcome: 'RUN_DELIVERED', started_at: new Date(now).toISOString(), duration_ms: 1, error_summary: null, assigned_cat_id: null }] });
  await settle();
  assert.equal(box.hidden, true);
  assert.equal(open.getAttribute('aria-expanded'), 'false');
  assert.equal(t.calls.filter(c => c.path.endsWith('/runs')).length, 3);
});

test('刷新 also re-reads an open trigger record; nothing reads on a timer', async () => {
  let runs = 0;
  const t = setup((path) => {
    if (path.endsWith('/runs')) { runs++; return { runs: [] }; }
    return listing([routine()]);
  });
  await settle();
  btn(expand(rowOf(t.host, 'dyn-a')), '触发记录').click();
  await settle();
  assert.equal(runs, 1);
  assert.match(visibleText(rowOf(t.host, 'dyn-a')), /还没有触发记录。/);
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(runs, 2);
  const count = t.calls.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(t.calls.length, count);
  t.S.reopened();
  await settle();
  assert.equal(gets(t.calls), 3, 'opening the drawer again reads the list again');
});

// ---- 改消息 ----
const editorOf = (row: El) => one(row, 'sched-edit');
const boxOf = (row: El) => { const box = all(editorOf(row)).find(n => n.tag === 'textarea'); assert.ok(box, 'no textarea'); return box!; };
const patches = (calls: Call[]) => calls.filter(c => c.method === 'PATCH');
const INTERVAL = { type: 'interval', ms: 30 * 60000 };

test('rules: the message rule is the one 新建 uses, and only repeating tasks can change theirs', () => {
  const { S } = browser();
  const R = S.rules;
  assert.equal(R.promptIssue('   '), '请填写到时发给猫猫的消息');
  assert.equal(R.promptIssue(undefined), '请填写到时发给猫猫的消息');
  assert.equal(R.promptIssue('x'.repeat(16001)), '消息最多 16000 个字');
  assert.equal(R.promptIssue('  ' + 'x'.repeat(16000) + '  '), '', 'measured after trimming, as the server does');
  assert.equal(R.promptIssue(' 喝水 '), '');
  assert.equal(R.editable(routine()), true);
  assert.equal(R.editable(routine({ trigger: INTERVAL })), true);
  assert.equal(R.editable(routine({ trigger: { type: 'once', fireAt: Date.now() + HOUR } })), false);
  assert.equal(R.editable(routine({ trigger: null })), false);
  assert.equal(R.editable(null), false);
});

test('改消息 is on repeating tasks only; it opens in the message\'s place on the current text, and 取消 or Escape close it without sending', async () => {
  const t = setup(() => listing([
    routine(),
    routine({ id: 'dyn-i', name: '喝水', prompt: '提醒我喝水', trigger: INTERVAL }),
    routine({ id: 'dyn-o', name: '一次', trigger: { type: 'once', fireAt: Date.now() + 2 * HOUR } }),
  ]));
  const drawerKeys: string[] = [];
  t.doc.body.addEventListener('keydown', (ev: any) => drawerKeys.push(ev.key));
  await settle();
  assert.equal(buttons(expand(rowOf(t.host, 'dyn-o')), '改消息').length, 0, 'a once-task is made again instead');
  assert.equal(named(rowOf(t.host, 'dyn-o'), 'sched-edit').length, 0);
  assert.ok(btn(expand(rowOf(t.host, 'dyn-i')), '改消息'));

  const row = expand(rowOf(t.host, 'dyn-a')), edit = btn(row, '改消息'), prompt = one(row, 'sched-prompt');
  assert.equal(edit.getAttribute('aria-expanded'), 'false');
  edit.click();
  const editor = editorOf(row), box = boxOf(row);
  assert.equal(t.doc.activeElement, box, 'the box has focus');
  assert.equal(box.value, '整理今天的新闻');
  assert.equal(box.rows, 3);
  assert.equal(box.maxLength, 16000);
  assert.equal(box.getAttribute('aria-label'), '消息');
  assert.equal(prompt.hidden, true, 'the box stands where the message was');
  assert.equal(shown(editor), true);
  assert.equal(edit.getAttribute('aria-expanded'), 'true');
  assert.equal(edit.getAttribute('aria-controls'), editor.id);
  assert.equal(visibleText(editor), '取消保存', 'the layout explains: no caption, note or label beside the box');
  assert.ok(btn(editor, '保存').className.includes('primary'));

  // 取消: nothing sent, the message as it was, focus back on 改消息.
  type(box, '半截');
  btn(editor, '取消').click();
  assert.equal(shown(editor), false);
  assert.equal(prompt.hidden, false);
  assert.equal(prompt.textContent, '整理今天的新闻');
  assert.equal(t.doc.activeElement, edit);
  assert.equal(edit.getAttribute('aria-expanded'), 'false');
  edit.click();
  assert.equal(boxOf(row).value, '整理今天的新闻', 'a dismissed draft does not come back');

  // Escape closes the box, never the drawer.
  type(boxOf(row), '另一半');
  edit.click();
  assert.equal(boxOf(row).value, '另一半', '改消息 again only brings focus back to the open box');
  assert.equal(t.doc.activeElement, boxOf(row));
  const ev = boxOf(row).dispatch('keydown', { key: 'Escape' });
  assert.equal(ev.stopped, true);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(drawerKeys, [], 'the drawer never saw Escape');
  assert.equal(shown(editor), false);
  assert.equal(t.doc.activeElement, edit);
  assert.equal(boxOf(row).dispatch('keydown', { key: 'Enter' }).stopped, false, 'other keys pass as before');
  assert.equal(patches(t.calls).length, 0);
});

test('改消息 checks the message before sending: empty or too long is said beside the box, and typing clears it', async () => {
  const t = setup(() => listing([routine()]));
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  const editor = editorOf(row), box = boxOf(row), err = one(editor, 'sched-err');
  type(box, '   ');
  btn(editor, '保存').click();
  assert.equal(patches(t.calls).length, 0);
  assert.deepEqual(errorsOf(editor), ['请填写到时发给猫猫的消息']);
  assert.equal(box.getAttribute('aria-invalid'), 'true');
  assert.equal(box.getAttribute('aria-describedby'), err.id);
  assert.equal(t.doc.activeElement, box);
  type(box, '新');
  assert.deepEqual(errorsOf(editor), [], 'typing clears it');
  assert.equal(box.getAttribute('aria-invalid'), null);
  assert.equal(box.getAttribute('aria-describedby'), null);
  box.value = 'x'.repeat(16001);
  btn(editor, '保存').click();
  assert.deepEqual(errorsOf(editor), ['消息最多 16000 个字']);
  assert.equal(patches(t.calls).length, 0);
  // Closing and opening again starts clean.
  btn(editor, '取消').click();
  btn(row, '改消息').click();
  assert.deepEqual(errorsOf(editor), []);
  assert.equal(boxOf(row).getAttribute('aria-invalid'), null);
});

test('改消息 sends only the message, holds the row while it is out, then shows the saved text and reads the list again', async () => {
  const patch = defer();
  let state = routine();
  const t = setup((path, method) => {
    if (method === 'PATCH') return patch.promise;
    if (method === 'GET' && path === BASE) return listing([state]);
    throw fail(404);
  });
  const drawerKeys: string[] = [];
  t.doc.body.addEventListener('keydown', (ev: any) => drawerKeys.push(ev.key));
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a')), edit = btn(row, '改消息');
  edit.click();
  const editor = editorOf(row), box = boxOf(row), save = btn(editor, '保存');
  type(box, '  整理新闻并发给我  ');
  save.focus();
  save.click();
  assert.deepEqual(patches(t.calls), [{ path: BASE + '/dyn-a', method: 'PATCH', body: { prompt: '整理新闻并发给我' } }], 'trimmed, and nothing but the message');

  // While it is out the whole row waits.
  assert.equal(save.textContent, '正在保存…');
  assert.equal(save.disabled, true);
  assert.equal(btn(editor, '取消').disabled, true);
  assert.equal(box.disabled, true);
  assert.equal(btn(row, '暂停').disabled, true);
  assert.equal(btn(row, '删除').disabled, true);
  assert.equal(edit.disabled, true);
  save.dispatch('click'); // even a click that reaches it
  btn(row, '暂停').dispatch('click');
  assert.equal(patches(t.calls).length, 1, 'one change at a time');
  const ev = box.dispatch('keydown', { key: 'Escape' });
  assert.equal(ev.stopped, true, 'Escape never reaches the drawer');
  assert.equal(shown(editor), true, 'Escape waits while saving');
  assert.deepEqual(drawerKeys, []);

  state = routine({ prompt: '整理新闻并发给我' });
  patch.resolve({ success: true, id: 'dyn-a', prompt: '整理新闻并发给我', changed: true });
  await settle();
  assert.equal(shown(editor), false, 'saved: the box closes');
  assert.equal(one(row, 'sched-prompt').hidden, false);
  assert.equal(one(row, 'sched-prompt').textContent, '整理新闻并发给我');
  assert.equal(one(row, 'sched-msg').textContent, '已保存。');
  assert.equal(gets(t.calls), 2, 'the list is read again after a change');
  assert.equal(t.doc.activeElement, edit, 'focus comes back to 改消息');
  assert.equal(edit.disabled, false);
  assert.equal(btn(row, '暂停').disabled, false);
  assert.equal(one(row, 'sched-name').textContent, '早报', 'name and rule are as before');
  assert.equal(one(row, 'sched-rule').textContent, '每天 09:00（Asia/Shanghai）');
  edit.click();
  assert.equal(boxOf(row).value, '整理新闻并发给我', 'the next edit starts from the saved text');
  assert.equal(one(row, 'sched-msg').hidden, true, 'opening the box again clears the last line');
});

test('a saved message whose list re-read fails is reported as saved, shown as the server answered, and the next good read clears the line', async () => {
  let reads = 0;
  const t = setup((path, method) => {
    if (method === 'PATCH') return { success: true, id: 'dyn-a', prompt: '服务端的原文', changed: true };
    reads++;
    if (reads === 2) throw fail(500, '服务出现异常，请查看日志。');
    return listing([routine(reads === 1 ? {} : { prompt: '服务端的原文' })]);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  type(boxOf(row), '新的消息');
  btn(editorOf(row), '保存').click();
  await settle();
  assert.equal(patches(t.calls).length, 1);
  assert.equal(shown(editorOf(row)), false, 'saved is saved: the box is not offered again');
  assert.equal(one(row, 'sched-prompt').textContent, '服务端的原文', 'the text the server says it saved, not the list read before it');
  const msg = one(row, 'sched-msg');
  assert.equal(msg.textContent, '已保存，但没能刷新列表：服务出现异常，请查看日志。');
  assert.ok(has(msg, 'bad'));
  assert.doesNotMatch(visibleText(t.section), /没能保存|没能确认是否已保存/);
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(one(row, 'sched-msg').hidden, true, 'a good read clears it');
});

test('a refused or unconfirmed save keeps the draft open and says which it was; a task gone meanwhile is said by the section', async () => {
  const replies: Array<() => unknown> = [];
  let list = [routine()];
  const t = setup((path, method) => {
    if (method === 'PATCH') return replies.shift()!();
    if (method === 'GET' && path === BASE) return listing(list);
    throw fail(404);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  const editor = editorOf(row), box = boxOf(row), save = btn(editor, '保存'), failure = one(editor, 'error');
  assert.equal(failure.getAttribute('role'), 'alert');
  type(box, '我的草稿');
  const attempt = async (reply: () => unknown) => {
    replies.push(reply);
    save.focus();
    save.click();
    await settle();
    assert.equal(shown(editor), true, 'the box stays open');
    assert.equal(box.value, '我的草稿', 'with the draft as typed');
    assert.equal(box.disabled, false);
    assert.equal(save.textContent, '保存');
    assert.equal(t.doc.activeElement, save, 'focus is back on 保存, as on the 新建 form');
    assert.equal(one(row, 'sched-prompt').textContent, '整理今天的新闻', 'nothing is shown as changed');
    return failure.textContent;
  };

  // Refused (4xx): 没能保存, with the server's reason; 409 and 404 read the list again.
  assert.equal(await attempt(() => { throw fail(409, '投递聊天已不可用或不再包含这只猫，请新建定时任务'); }), '没能保存：投递聊天已不可用或不再包含这只猫，请新建定时任务。已重新读取列表。');
  assert.equal(gets(t.calls), 2);
  assert.equal(await attempt(() => { throw fail(422, '请先给这只猫猫选一个能用的本机 Agent'); }), '没能保存：请先给这只猫猫选一个能用的本机 Agent。');
  assert.equal(gets(t.calls), 2, 'another refusal does not re-read');
  // Unknown (5xx or no answer): it may have been saved.
  assert.equal(await attempt(() => { throw fail(502, '引擎没有确认定时消息已经改好，请刷新列表核对'); }), '没能确认是否已保存：引擎没有确认定时消息已经改好，请刷新列表核对。', 'the server already says to check; it is not said twice');
  assert.equal(await attempt(() => { throw fail(undefined, '连不上 clowder-bot'); }), '没能确认是否已保存：连不上 clowder-bot。请刷新核对。');
  assert.equal(gets(t.calls), 2);
  assert.deepEqual(patches(t.calls).map(c => c.body), Array(4).fill({ prompt: '我的草稿' }));
  // Typing does not hide the outcome; a new try does.
  type(box, '我的草稿');
  assert.equal(failure.hidden, false);

  // Gone: the card and its line go, the section says what happened, focus goes to 新建.
  list = [];
  replies.push(() => { throw fail(404, '找不到这只猫的定时任务'); });
  save.focus();
  save.click();
  await settle();
  assert.equal(rows(t.host).length, 0);
  assert.equal(one(t.section, 'sched-status').textContent, '没能保存：找不到这只猫的定时任务。已重新读取列表。');
  assert.ok(has(one(t.section, 'sched-status'), 'bad'));
  assert.equal(t.doc.activeElement, btn(t.section, '新建'));
});

test('刷新, syncs and a pause keep an open draft; a task that is gone takes its draft and says so', async () => {
  let list = [routine()];
  const pause = defer();
  const t = setup((path, method) => {
    if (method === 'PATCH') return pause.promise;
    if (method === 'GET' && path === BASE) return listing(list);
    throw fail(404);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  type(boxOf(row), '半截消息');

  // A fresh list (here, changed elsewhere) repaints the card around the box, never the box.
  list = [routine({ prompt: '别处改过的', lastRun: { outcome: 'RUN_DELIVERED', started_at: new Date().toISOString(), duration_ms: 1, error_summary: null, assigned_cat_id: null } })];
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(rowOf(t.host, 'dyn-a'), row);
  assert.equal(shown(editorOf(row)), true);
  assert.equal(boxOf(row).value, '半截消息');
  assert.match(visibleText(row), /上次已触发/);
  assert.equal(one(row, 'sched-prompt').hidden, true);
  assert.equal(one(row, 'sched-prompt').textContent, '别处改过的', 'the message behind the box is the latest read');
  for (let i = 0; i < 3; i++) t.mount();
  t.S.reopened();
  const rebuilt = t.doc.createElement('div');
  t.doc.body.append(rebuilt);
  t.host.remove();
  t.mount(rebuilt);
  await settle();
  assert.equal(boxOf(row).value, '半截消息', 'syncs, reopening and a rebuilt tab keep it');
  assert.equal(shown(editorOf(row)), true);

  // A pause on the same row: the box stays as typed and only 保存 waits.
  btn(row, '暂停').click();
  assert.equal(btn(editorOf(row), '保存').disabled, true);
  assert.equal(boxOf(row).disabled, false, 'typing goes on');
  assert.equal(btn(editorOf(row), '取消').disabled, false);
  btn(editorOf(row), '保存').dispatch('click');
  assert.equal(patches(t.calls).length, 1, 'no save while the pause is out');
  list = [routine({ prompt: '别处改过的', enabled: false, effectiveEnabled: false, status: 'paused' })];
  pause.resolve({ success: true, enabled: false });
  await settle();
  assert.equal(boxOf(row).value, '半截消息');
  assert.equal(btn(editorOf(row), '保存').disabled, false);
  assert.ok(btn(row, '改消息'), 'a paused repeating task can still change its message');

  // Gone from the list with the draft open: the row goes, focus to 新建, and the section says the draft was not saved.
  boxOf(row).focus();
  list = [];
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(rows(rebuilt).length, 0);
  assert.equal(one(t.section, 'sched-status').textContent, '「早报」已经不在列表里，改的消息没有保存。');
  assert.equal(t.doc.activeElement, btn(t.section, '新建'));
  assert.equal(patches(t.calls).length, 1);
});

test('a save that lands after its cat was left never reaches the next cat; the same cat open again reads its list', async () => {
  const saves = [defer(), defer()];
  let prompt = '整理今天的新闻';
  const t = setup((path, method) => {
    if (method === 'PATCH') return saves[patches(t.calls).length - 1].promise;
    if (path === BASE) return listing([routine({ prompt })]);
    if (path === '/xbot-api/bots/bo/routines') return listing([routine({ id: 'bo-a', name: '别的猫' })]);
    throw fail(404);
  });
  await settle();
  const start = (section: El) => {
    const row = expand(rowOf(section, 'dyn-a'));
    btn(row, '改消息').click();
    type(boxOf(row), '新消息');
    btn(editorOf(row), '保存').click();
  };
  start(t.section);
  t.S.teardown();
  const bo = t.mount(t.host, 'bo');
  await settle();
  prompt = '新消息';
  saves[0].resolve({ success: true, id: 'dyn-a', prompt: '新消息', changed: true });
  await settle();
  assert.equal(gets(t.calls), 1, 'no re-read for ada while bo is open');
  assert.doesNotMatch(visibleText(bo), /已保存|新消息/);
  assert.equal(named(bo, 'sched-edit').length, 0);

  // Back to ada: a fresh section; a save still out when it was left makes this one read again.
  t.S.teardown();
  const ada = t.mount(t.host, 'ada');
  await settle();
  assert.equal(gets(t.calls), 2);
  start(ada);
  t.S.teardown();
  const again = t.mount(t.host, 'ada');
  await settle();
  assert.equal(gets(t.calls), 3);
  saves[1].resolve({ success: true, id: 'dyn-a', prompt: '新消息', changed: false });
  await settle();
  assert.equal(gets(t.calls), 4, 'the open section of the same cat reads its list again');
  assert.equal(named(again, 'sched-edit').length, 0, 'the closed box does not come back');
  assert.ok(named(again, 'sched-msg').every(n => n.hidden) && one(again, 'sched-status').hidden, 'no line of the closed section comes back');
  assert.equal(one(expand(rowOf(again, 'dyn-a')), 'sched-prompt').textContent, '新消息');
});

test('saving hands focus from the disabled control to the editor itself, so Escape on what has focus stops there', async () => {
  const saves = [defer(), defer()];
  const t = setup((path, method) => {
    if (method === 'PATCH') return saves[patches(t.calls).length - 1].promise;
    if (method === 'GET' && path === BASE) return listing([routine()]);
    throw fail(404);
  });
  const drawerKeys: string[] = [];
  t.doc.body.addEventListener('keydown', (ev: any) => drawerKeys.push(ev.key));
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a')), edit = btn(row, '改消息');
  edit.click();
  const editor = editorOf(row), save = btn(editor, '保存');
  assert.equal(editor.tabIndex, -1, 'the box can hold focus, but Tab does not stop on it');
  type(boxOf(row), '新消息');
  save.focus();
  save.click();
  assert.equal(save.disabled, true);
  assert.equal(t.doc.activeElement, editor, 'not the page');
  const ev = t.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(ev.stopped, true);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(drawerKeys, [], 'the drawer never saw Escape');
  assert.equal(shown(editor), true, 'Escape waits while saving');
  saves[0].reject(fail(422, '请先给这只猫猫选一个能用的本机 Agent'));
  await settle();
  assert.equal(t.doc.activeElement, save, 'refused: focus goes from the box to 保存');

  // A click that never focused 保存 (as in Safari) leaves focus on the page; saving takes it into the box too.
  t.doc.focused = null;
  save.click();
  assert.equal(t.doc.activeElement, editor);
  saves[1].resolve({ success: true, id: 'dyn-a', prompt: '新消息', changed: true });
  await settle();
  assert.equal(t.doc.activeElement, edit, 'saved: focus leaves the closed box for 改消息');
  assert.deepEqual(drawerKeys, []);
});

test('while a message or a new task is saving, Escape from anywhere stays out of the drawer; the delete dialog still answers its own', async () => {
  const patch = defer(), post = defer();
  const t = setup((path, method) => {
    if (method === 'PATCH') return patch.promise;
    if (method === 'POST') return post.promise;
    if (method === 'GET' && path === BASE) return listing([routine(), routine({ id: 'dyn-b', name: '晚报' })]);
    throw fail(404);
  });
  // The drawer listens on the document, as app.js does.
  const drawerKeys: string[] = [];
  t.doc.addEventListener('keydown', (ev: any) => drawerKeys.push(ev.key));
  await settle();
  const press = (key = 'Escape') => t.doc.activeElement.dispatch('keydown', { key });
  t.doc.focused = null;
  press();
  assert.deepEqual(drawerKeys, ['Escape'], 'with nothing on its way, Escape on the page reaches the drawer');
  drawerKeys.length = 0;

  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  type(boxOf(row), '新消息');
  btn(editorOf(row), '保存').click();
  // Focus wandered out of the section (here, onto the page) while the save is out.
  t.doc.focused = null;
  const ev = press();
  assert.equal(ev.stopped, true);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(drawerKeys, [], 'the drawer never saw Escape');
  assert.equal(shown(editorOf(row)), true);
  press('Enter');
  assert.deepEqual(drawerKeys, ['Enter'], 'other keys pass');
  drawerKeys.length = 0;

  // Another row's delete dialog still closes on Escape meanwhile, and keeps it from the drawer.
  const other = expand(rowOf(t.host, 'dyn-b'));
  btn(other, '删除').click();
  const dialog = () => named(t.doc.body, 'sched-modal')[0];
  assert.equal(t.doc.activeElement, btn(dialog(), '取消'));
  press();
  assert.equal(dialog(), undefined, 'the dialog answers its own Escape');
  assert.equal(t.doc.activeElement, btn(other, '删除'));
  assert.deepEqual(drawerKeys, []);

  patch.resolve({ success: true, id: 'dyn-a', prompt: '新消息', changed: true });
  await settle();
  t.doc.focused = null;
  press();
  assert.deepEqual(drawerKeys, ['Escape'], 'saved: Escape on the page reaches the drawer again');
  drawerKeys.length = 0;

  // The same while 新建 is on its way: its disabled fieldset drops focus onto the page.
  btn(t.section, '新建').click();
  const form = formOf(t.section);
  type(control(form, '名称'), '晨会');
  type(control(form, '消息'), '准备晨会');
  kind(form, '间隔');
  btn(form, '创建').click();
  assert.equal(t.calls.filter(c => c.method === 'POST').length, 1);
  t.doc.focused = null;
  assert.equal(press().stopped, true);
  assert.deepEqual(drawerKeys, []);
  assert.equal(formOf(t.section), form, 'the form waits');
  post.resolve({ id: 'dyn-1', name: '晨会', prompt: '准备晨会', trigger: { type: 'interval', ms: 3600000 }, threadId: 'thread-now' });
  await settle();
  t.doc.focused = null;
  press();
  assert.deepEqual(drawerKeys, ['Escape']);

  // The section that goes takes its listener with it.
  assert.equal(t.doc.listeners.filter(l => l.capture).length, 1);
  t.S.teardown();
  assert.equal(t.doc.listeners.filter(l => l.capture).length, 0);
});

test('a refused save that reads the list again says so only once the read is back, and says when it failed', async () => {
  const reads: Array<() => unknown> = [() => listing([routine()])];
  const t = setup((path, method) => {
    if (method === 'PATCH') throw fail(409, '投递聊天已不可用或不再包含这只猫，请新建定时任务');
    if (method === 'GET' && path === BASE) return reads.shift()!();
    throw fail(404);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  const editor = editorOf(row), failure = one(editor, 'error');
  type(boxOf(row), '我的草稿');
  const reread = defer();
  reads.push(() => reread.promise);
  btn(editor, '保存').click();
  await settle();
  assert.equal(gets(t.calls), 2, 'a 409 reads the list again');
  assert.equal(failure.textContent, '没能保存：投递聊天已不可用或不再包含这只猫，请新建定时任务。', 'nothing about the list while it is still being read');

  reread.reject(fail(503, '定时任务暂时不可用'));
  await settle();
  assert.equal(failure.textContent, '没能保存：投递聊天已不可用或不再包含这只猫，请新建定时任务。没能重新读取列表：定时任务暂时不可用。');
  assert.doesNotMatch(visibleText(t.section), /已重新读取列表/);
  assert.equal(one(t.section, 'sched-status').textContent, '没能刷新：定时任务暂时不可用。下面是上次读取的结果。');
  assert.equal(shown(editor), true);
  assert.equal(boxOf(row).value, '我的草稿');

  // The next good read takes back what it said about the list, and only that.
  reads.push(() => listing([routine()]));
  btn(t.section, '刷新').click();
  await settle();
  assert.equal(failure.textContent, '没能保存：投递聊天已不可用或不再包含这只猫，请新建定时任务。');
  assert.equal(one(t.section, 'sched-status').hidden, true);
  assert.equal(boxOf(row).value, '我的草稿');
});

// A refused try whose re-read is still out, then something newer on the same box.
function refusedThenSlow() {
  const reads: Array<() => unknown> = [() => listing([routine()])];
  const saves: Array<() => unknown> = [];
  const t = setup((path, method) => {
    if (method === 'PATCH') return saves.shift()!();
    if (method === 'GET' && path === BASE) return reads.shift()!();
    throw fail(404);
  });
  const refuse = async (row: El) => {
    const slow = defer();
    saves.push(() => { throw fail(409, '投递聊天已不可用或不再包含这只猫，请新建定时任务'); });
    reads.push(() => slow.promise);
    btn(editorOf(row), '保存').click();
    await settle();
    assert.equal(one(editorOf(row), 'error').textContent, '没能保存：投递聊天已不可用或不再包含这只猫，请新建定时任务。', 'the re-read is still out');
    return slow;
  };
  return { t, reads, saves, refuse };
}

test('a refused save whose re-read comes back after a newer save went through says nothing: the line stays 已保存', async () => {
  const { t, reads, saves, refuse } = refusedThenSlow();
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  type(boxOf(row), '我的草稿');
  const slow = await refuse(row);
  assert.equal(gets(t.calls), 2);

  // Save B, meanwhile: saved, the box closes.
  saves.push(() => ({ success: true, id: 'dyn-a', prompt: '我的草稿', changed: true }));
  reads.push(() => listing([routine({ prompt: '我的草稿' })]));
  btn(editorOf(row), '保存').click();
  await settle();
  assert.equal(gets(t.calls), 3);
  assert.equal(shown(editorOf(row)), false);
  assert.equal(one(row, 'sched-msg').textContent, '已保存。');

  // Save A's read lands last.
  slow.resolve(listing([routine()]));
  await settle();
  assert.equal(one(t.section, 'sched-status').hidden, true, 'the section does not report the earlier refusal');
  assert.doesNotMatch(visibleText(t.section), /没能保存|已重新读取列表/);
  const msg = one(row, 'sched-msg');
  assert.equal(msg.textContent, '已保存。');
  assert.equal(has(msg, 'bad'), false);
  assert.equal(one(row, 'sched-prompt').textContent, '我的草稿', 'the older read paints nothing');
});

test('a refused save whose re-read comes back after 取消 says nothing more', async () => {
  const { t, refuse } = refusedThenSlow();
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  btn(row, '改消息').click();
  type(boxOf(row), '我的草稿');
  const slow = await refuse(row);
  btn(editorOf(row), '取消').click();
  assert.equal(shown(editorOf(row)), false);
  slow.resolve(listing([routine()]));
  await settle();
  assert.equal(one(t.section, 'sched-status').hidden, true);
  assert.doesNotMatch(visibleText(t.section), /没能保存|已重新读取列表/);

  // Reopened meanwhile: the new box starts clean and stays so.
  btn(row, '改消息').click();
  type(boxOf(row), '我的草稿');
  const again = await refuse(row);
  btn(editorOf(row), '取消').click();
  btn(row, '改消息').click();
  again.reject(fail(503, '定时任务暂时不可用'));
  await settle();
  assert.equal(one(editorOf(row), 'error').hidden, true, 'the reopened box does not take the old refusal');
  assert.equal(one(t.section, 'sched-status').textContent, '没能刷新：定时任务暂时不可用。下面是上次读取的结果。', 'only the read itself is reported');
});

test('a saved message whose re-read fails late leaves a reopened box and a newer pause their own lines', async () => {
  const reads: Array<() => unknown> = [() => listing([routine()])];
  const answers: Array<() => unknown> = [];
  const t = setup((path, method) => {
    if (method === 'PATCH') return answers.shift()!();
    if (method === 'GET' && path === BASE) return reads.shift()!();
    throw fail(404);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a'));
  const save = async (text: string) => {
    btn(row, '改消息').click();
    type(boxOf(row), text);
    const slow = defer();
    answers.push(() => ({ success: true, id: 'dyn-a', prompt: text, changed: true }));
    reads.push(() => slow.promise);
    btn(editorOf(row), '保存').click();
    await settle();
    assert.equal(one(row, 'sched-msg').textContent, '已保存。');
    return slow;
  };

  // Reopened while the read is out: the box is the owner's, not the old save's.
  const first = await save('第一版');
  btn(row, '改消息').click();
  first.reject(fail(503, '定时任务暂时不可用'));
  await settle();
  assert.equal(one(row, 'sched-msg').hidden, true, 'no 已保存，但… under the open box');
  assert.equal(one(t.section, 'sched-status').textContent, '没能刷新：定时任务暂时不可用。下面是上次读取的结果。');
  btn(editorOf(row), '取消').click();

  // A pause that finished meanwhile keeps its own line.
  reads.push(() => listing([routine({ prompt: '第一版' })]));
  btn(t.section, '刷新').click();
  await settle();
  const second = await save('第二版');
  const pause = defer();
  answers.push(() => pause.promise);
  btn(row, '暂停').click();
  reads.push(() => { throw fail(503, '定时任务暂时不可用'); });
  pause.resolve({ success: true, enabled: false });
  await settle();
  assert.equal(one(row, 'sched-msg').textContent, '已暂停，但没能刷新列表：定时任务暂时不可用。');
  second.resolve(listing([routine({ prompt: '第二版' })]));
  await settle();
  assert.equal(one(row, 'sched-msg').textContent, '已暂停，但没能刷新列表：定时任务暂时不可用。', 'the save does not write over the pause');
});

test('取消 or Escape while a pause or resume is out puts focus on the row, since 改消息 waits too', async () => {
  const toggles = [defer(), defer()];
  let list = [routine()];
  const t = setup((path, method) => {
    if (method === 'PATCH') return toggles[patches(t.calls).length - 1].promise;
    if (method === 'GET' && path === BASE) return listing(list);
    throw fail(404);
  });
  await settle();
  const row = expand(rowOf(t.host, 'dyn-a')), head = one(row, 'sched-row'), edit = btn(row, '改消息');
  edit.click();
  btn(row, '暂停').click();
  assert.equal(edit.disabled, true);
  const cancel = btn(editorOf(row), '取消');
  cancel.focus();
  cancel.click();
  assert.equal(shown(editorOf(row)), false);
  assert.equal(t.doc.activeElement, head, 'not the page, nor the closed box');
  list = [routine({ enabled: false, effectiveEnabled: false, status: 'paused' })];
  toggles[0].resolve({ success: true, enabled: false });
  await settle();

  edit.click();
  btn(row, '恢复').click();
  assert.equal(edit.disabled, true);
  boxOf(row).dispatch('keydown', { key: 'Escape' });
  assert.equal(shown(editorOf(row)), false);
  assert.equal(t.doc.activeElement, head);
  list = [routine()];
  toggles[1].resolve({ success: true, enabled: true });
  await settle();

  // Nothing out: 取消 goes back to 改消息 as before.
  edit.click();
  btn(editorOf(row), '取消').click();
  assert.equal(t.doc.activeElement, edit);
  assert.equal(patches(t.calls).length, 2);
});

// ---- wiring ----
test('the drawer\'s 定时 tab mounts the module on a page of its own; the retired routine row and its claims are gone', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), source = read('client/public/schedules.js');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('/schedules.js') >= 0 && scripts.indexOf('/schedules.js') < scripts.indexOf('/app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(styles.indexOf('/cafe-theme.css') < styles.indexOf('/schedules.css'), 'styles sit after the café overlay');
  assert.doesNotMatch(html, /定时任务/, 'no settings entry');
  // The section is mounted by the task view and torn down when the cat changes.
  assert.match(app, /window\.ClowderSchedules\.mount\(root, \{ api: scheduleApi, bot: name, icon \}\)/);
  // 定时 is its own tab now (profile-rules.js): a page the section is mounted into; the run cards no longer carry it.
  assert.match(read('client/public/profile-rules.js'), /\["schedule", "定时"\]/);
  assert.match(app, /function scheduleView\(name\) \{\s*const host = el\("div", "pf-sched"\);\s*host\.dataset\.bot = name;\s*scheduleSection\(host, name\);/);
  assert.match(app, /else if \(tab === "schedule"\) body\.append\(scheduleView\(data\.name \|\| state\.sel\.id\)\);/);
  assert.match(app, /if \(sched && state\.sel\?\.type === "bot" && tab === "schedule" && sched\.dataset\.bot === state\.sel\.id\) \{\s*panelHead\(\); scheduleSection\(sched, state\.sel\.id\);/, 'a repaint keeps the page shown');
  const sync = /function syncTaskView\(root, data\) \{[\s\S]*?\n {2}\}\n/.exec(app)![0];
  assert.doesNotMatch(sync, /scheduleSection|ClowderSchedules/);
  assert.match(app, /function resetConversation\(\) \{[\s\S]*?window\.ClowderSchedules\?\.teardown\(\);[\s\S]*?\n  \}/);
  assert.match(app, /if \(open && !panel\.classList\.contains\("open"\)\) window\.ClowderSchedules\?\.reopened\(\);/);
  assert.match(app, /const scheduleApi = \(path, opt\) => api\(path, Object\.assign\(\{\}, opt, \{ serverError: true \}\)\);/);
  assert.match(app, /if \(res\.status >= 500 && !serverError\)/, 'other callers keep the generic 5xx line');
  assert.match(app, /if \(root && root\.dataset\.bot === data\.name\) syncTaskView\(root, data\);/, 'the poll syncs only the run cards drawn for this cat');
  assert.doesNotMatch(app, /routineCard|updateRoutineCard|routineChanges|cronText|每天 8 点提醒我|还没有例程|\["例程"|profile\.routines|prior\.routines|现在跑一次/);
  // Chat rendering of routine messages is a different thing and stays.
  assert.match(app, /function routineOf\(m\)/);
  assert.match(app, /function routineLine\(routine, key\)/);
  // The module: no timers, no browser-chosen target or chat, only this cat's routes.
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame/);
  assert.doesNotMatch(source, /targetCatId|deliveryThreadId|\bthreadId:/);
  assert.deepEqual([...new Set([...source.matchAll(/["'](\/xbot-api\/[^"']*)["']/g)].map(m => m[1]))], ['/xbot-api/bots/']);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage/);
});

test('review r15: 时间规则 is one row of ordinary radio pills — a radio in a .choice pill inside a .field is not sized by app.css\'s .field input (in an extension stylesheet; upstream CSS untouched)', () => {
  const app = read('client/public/app.css');
  assert.match(app, /\.field input, \.field textarea, \.field select, \.agent input, \.task input \{\n\s+border: 0; border-radius: 8px; background: var\(--fill\);\n\s+padding: 8px 12px; min-height: 40px; outline: none; width: 100%;/, 'the generic rule that sized the radio is still there, unchanged');
  const css = read('client/public/polish.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.field \.choice-opt input\[type="radio"\] \{ flex: none; width: auto; height: auto; min-height: 0; margin: 0; padding: 0; border-radius: 50%; background: none; \}/);
  assert.match(css, /\.field \.choice-opt \{ white-space: nowrap; \}/);
  // The form builds its rules as that markup: radios inside .choice-opt labels in a .field.
  const source = read('client/public/schedules.js');
  assert.match(source, /const kindBox = node\("div", "field sched-field"\)[^\n]*kinds = node\("div", "choice sched-kinds"\)/);
  assert.match(source, /const opt = node\("label", "choice-opt"\), radio = input\("radio"/);
});
