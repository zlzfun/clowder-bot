import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The chat's status line, read position and read-only memory
// (chat-experience-rules.js, chat-experience.js). The scripts run here as the
// classic browser scripts they are, in a VM with a small DOM (the same model
// as tests/workspace-ui.test.ts: tree, bubbling events, focus, the selectors
// the modules use; plus a per-element layout box and page visibility) and
// fake timers, against a fake /xbot-api. app.js is not loaded: its hooks are
// faked the way it passes them to init(), and static checks cover its wiring.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ---------------------------------------------------------------- small DOM
type Listener = { fn: (ev: Ev) => unknown; once: boolean };
class Ev {
  defaultPrevented = false; bubbles = true; stopped = false; halted = false;
  target: El | null = null; currentTarget: El | Doc | null = null;
  [key: string]: Any;
  constructor(readonly type: string, init: Record<string, unknown> = {}) { Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.halted = true; }
}
class Base {
  parent: El | null = null;
  constructor(readonly doc: Doc) {}
  get parentElement() { return this.parent; }
  get isConnected(): boolean { for (let n: Base | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  get nextSibling(): Base | null { const p = this.parent; return p ? p.kids[p.kids.indexOf(this) + 1] ?? null : null; }
  get textContent(): string { return ''; }
  set textContent(_value: string) { /* text nodes override */ }
  remove() {
    const p = this.parent;
    if (!p) return;
    p.kids.splice(p.kids.indexOf(this), 1);
    this.parent = null;
    this.doc.lost(this);
  }
}
class TextNode extends Base {
  constructor(doc: Doc, public data: string) { super(doc); }
  override get textContent() { return this.data; }
  override set textContent(value: string) { this.data = String(value); }
}
type Simple = { tag: string; ids: string[]; classes: string[]; attrs: Array<[string, string | null]>; nots: Simple[][]; disabled: boolean };
function splitTop(text: string): string[] {
  const out: string[] = []; let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function compound(text: string): Simple {
  const s: Simple = { tag: '', ids: [], classes: [], attrs: [], nots: [], disabled: false };
  let i = 0;
  const word = () => { const m = /^[\w-]+/.exec(text.slice(i)); assert.ok(m, 'selector ' + text); i += m[0].length; return m[0]; };
  if (/^[a-z]/i.test(text)) s.tag = word().toUpperCase();
  while (i < text.length) {
    const ch = text[i];
    if (ch === '.') { i++; s.classes.push(word()); }
    else if (ch === '#') { i++; s.ids.push(word()); }
    else if (ch === '[') {
      const end = text.indexOf(']', i), body = text.slice(i + 1, end), eq = body.indexOf('=');
      s.attrs.push(eq < 0 ? [body, null] : [body.slice(0, eq), body.slice(eq + 1).replace(/^["']|["']$/g, '')]);
      i = end + 1;
    } else if (text.startsWith(':not(', i)) {
      let depth = 0, j = i + 4;
      for (; j < text.length; j++) { if (text[j] === '(') depth++; if (text[j] === ')' && --depth === 0) break; }
      s.nots.push(splitTop(text.slice(i + 5, j)).map(compound));
      i = j + 1;
    } else if (text.startsWith(':disabled', i)) { s.disabled = true; i += 9; }
    else throw new Error('unsupported selector ' + text);
  }
  return s;
}
function hits(el: El, s: Simple): boolean {
  if (s.tag && el.tagName !== s.tag) return false;
  if (s.ids.some(id => el.id !== id)) return false;
  if (s.classes.some(c => !el.classList.contains(c))) return false;
  if (s.attrs.some(([k, v]) => { const got = el.getAttribute(k); return v === null ? got == null : got !== v; })) return false;
  if (s.disabled && !el.disabled) return false;
  return s.nots.every(list => !list.some(n => hits(el, n)));
}
class El extends Base {
  readonly tagName: string; kids: Base[] = []; attrs = new Map<string, string>(); listeners = new Map<string, Listener[]>();
  style: Record<string, string> = {}; hidden = false; disabled = false; value = ''; open = false; html = '';
  // Layout, as the history's viewport sees it (a test moves rows in and out of sight).
  rect: { top: number; bottom: number } | null = null; scrolled = 0; private tab: number | null = null;
  [key: string]: Any;
  constructor(doc: Doc, tag: string) { super(doc); this.tagName = tag.toUpperCase(); }
  get id() { return this.attrs.get('id') ?? ''; }
  set id(value: string) { this.attrs.set('id', String(value)); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', String(value)); }
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (set: Set<string>) => { this.className = [...set].join(' '); };
    return {
      add: (...n: string[]) => { const set = names(); n.forEach(x => set.add(x)); write(set); },
      remove: (...n: string[]) => { const set = names(); n.forEach(x => set.delete(x)); write(set); },
      toggle: (n: string, on?: boolean) => { const set = names(); const want = on ?? !set.has(n); if (want) set.add(n); else set.delete(n); write(set); return want; },
      contains: (n: string) => names().has(n),
    };
  }
  get dataset(): Record<string, string> {
    const key = (k: string) => 'data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return new Proxy({}, {
      get: (_t, k: string) => this.attrs.get(key(k)),
      set: (_t, k: string, v) => { this.attrs.set(key(k), String(v)); return true; },
      deleteProperty: (_t, k: string) => { this.attrs.delete(key(k)); return true; },
    });
  }
  get tabIndex() { return this.tab ?? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1); }
  set tabIndex(value: number) { this.tab = Number(value); }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  get childNodes() { return this.kids; }
  get firstChild() { return this.kids[0] ?? null; }
  get lastChild() { return this.kids.at(-1) ?? null; }
  override get textContent(): string { return this.kids.map(k => k.textContent).join(''); }
  override set textContent(value: string) { this.replaceChildren(); if (value !== '' && value != null) this.append(String(value)); }
  set innerHTML(value: string) { this.replaceChildren(); this.html = value; }
  private adopt(item: Base | string): Base {
    const n = typeof item === 'string' ? new TextNode(this.doc, item) : item;
    n.remove();
    n.parent = this;
    return n;
  }
  append(...items: Array<Base | string>) { for (const item of items) this.kids.push(this.adopt(item)); }
  prepend(...items: Array<Base | string>) { this.kids.unshift(...items.map(i => this.adopt(i))); }
  insertBefore(n: Base, ref: Base | null) {
    if (!ref) { this.append(n); return n; }
    this.adopt(n);
    this.kids.splice(this.kids.indexOf(ref), 0, n);
    return n;
  }
  after(...items: Array<Base | string>) {
    const p = this.parent!;
    let at = p.kids.indexOf(this) + 1;
    for (const item of items) { const n = p.adopt(item); p.kids.splice(at++, 0, n); }
  }
  replaceChildren(...items: Array<Base | string>) { for (const k of [...this.kids]) k.remove(); this.append(...items); }
  contains(n: unknown): boolean { for (let x = n as Base | null; x; x = x.parent) if (x === this) return true; return false; }
  addEventListener(type: string, fn: (ev: Ev) => unknown) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: false });
    this.listeners.set(type, list);
  }
  removeEventListener() { /* unused */ }
  dispatchEvent(ev: Ev) { return this.doc.dispatch(this, ev); }
  click() {
    if (this.disabled) return;
    const ev = new Ev('click');
    this.dispatchEvent(ev);
    if (!ev.defaultPrevented && this.tagName === 'BUTTON' && this.type === 'submit') this.closest('form')?.dispatchEvent(new Ev('submit'));
  }
  focus() { if (this.isConnected && !this.disabled) this.doc.activeElement = this; }
  blur() { if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body; }
  getBoundingClientRect() { const r = this.rect ?? { top: 0, bottom: 20 }; return { left: 0, right: 100, width: 100, height: r.bottom - r.top, ...r }; }
  get offsetWidth() { return 100; }
  scrollIntoView() { this.scrolled++; }
  matches(sel: string) { return splitTop(sel).map(compound).some(s => hits(this, s)); }
  closest(sel: string): El | null { for (let n: El | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel: string): El[] { const list = splitTop(sel).map(compound); return all(this).filter(e => list.some(s => hits(e, s))); }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
}
const all = (root: El): El[] => root.children.flatMap(c => [c, ...all(c)]);
class Doc {
  body: El; activeElement: El; listeners = new Map<string, Listener[]>(); visibilityState = 'visible';
  constructor() { this.body = new El(this, 'body'); this.activeElement = this.body; }
  createElement(tag: string) { return new El(this, tag); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag); }
  createTextNode(text: string) { return new TextNode(this, text); }
  getElementById(id: string) { return all(this.body).find(e => e.id === id) ?? null; }
  querySelector(sel: string) { return this.body.querySelector(sel); }
  addEventListener(type: string, fn: (ev: Ev) => unknown) { const list = this.listeners.get(type) ?? []; list.push({ fn, once: false }); this.listeners.set(type, list); }
  lost(n: Base) { if (n instanceof El && n.contains(this.activeElement)) this.activeElement = this.body; }
  dispatch(target: El, ev: Ev) {
    ev.target = target;
    const run = (host: El | Doc, list: Listener[] | undefined) => {
      for (const l of [...(list ?? [])]) { if (ev.halted) return; ev.currentTarget = host; l.fn(ev); }
    };
    for (let n: El | null = target; n && !ev.stopped; n = n.parent) run(n, n.listeners.get(ev.type));
    if (!ev.stopped) run(this, this.listeners.get(ev.type));
    return !ev.defaultPrevented;
  }
  // As a browser does when the tab is hidden or shown again.
  show(state: 'visible' | 'hidden') { this.visibilityState = state; this.dispatch(this.body, new Ev('visibilitychange')); }
}

// ---------------------------------------------------------------- the page
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
type Call = { path: string; method: string; body?: Any };
type Route = (path: string, method: string, body: Any) => unknown;
function page(route: Route, hooks: Record<string, unknown> = {}) {
  const doc = new Doc();
  const h = (tag: string, props: Record<string, unknown> = {}, ...kids: Array<El | string>) => {
    const e = doc.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  };
  // The history's viewport spans 0–600; rows default to being in sight.
  const thread = h('div', { id: 'thread', className: 'thread', rect: { top: 0, bottom: 600 } });
  const inner = h('div', { className: 'thread-inner' });
  thread.append(inner);
  const dock = h('div', { className: 'dock' }, h('div', { id: 'work-status' }), h('form', { id: 'composer' }));
  doc.body.append(h('main', { className: 'main' }, thread, dock));
  // Fake timers: the read position waits a moment before it confirms.
  let now = 0, seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
    await settle();
  };
  const windowListeners: Record<string, Array<() => void>> = {};
  const window: Any = { addEventListener: (type: string, fn: () => void) => { (windowListeners[type] ??= []).push(fn); } };
  const context = vm.createContext({
    window, document: doc, URLSearchParams, console, Date,
    setTimeout: (fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  for (const file of ['client/public/chat-experience-rules.js', 'client/public/chat-experience.js']) vm.runInContext(read(file), context);
  const cx = window.ClowderExperience;
  const calls: Call[] = [], reads: Any[] = [], tasks: string[] = [];
  let covered = false;
  const api = async (path: string, opt: { method?: string; body?: unknown } = {}) => {
    const call: Call = { path, method: opt.method || 'GET', ...(opt.body === undefined ? {} : { body: plain(opt.body) }) };
    calls.push(call);
    return route(path, call.method, call.body);
  };
  // The hooks app.js passes (see experience.init in client/public/app.js).
  cx.init({
    api, thread,
    icon: (name: string, extra?: string) => { const s = doc.createElementNS('svg', 'svg'); s.className = 'icon' + (extra ? ' ' + extra : ''); s.dataset.icon = name; return s; },
    visibleError: (e: Any, fallback?: string) => (e && /\p{Script=Han}/u.test(e.message) ? e.message : fallback || '操作失败'),
    face: (id: string, name: string) => h('span', { className: 'avatar xs', title: name || id }),
    peer: () => false,
    obscured: () => covered,
    focusTask: async (id: string) => { tasks.push(id); return id === 'task-known'; },
    onRead: (sel: Any, threadId: string, messageId: string) => reads.push({ sel: plain(sel), threadId, messageId }),
    ...hooks,
  });
  // A history row for a native message, as app.js draws it (data-mid).
  const row = (mid: string, top = 500) => { const r = h('div', { className: 'msg bot', rect: { top, bottom: top + 40 } }); r.dataset.mid = mid; inner.append(r); return r; };
  const strip = () => all(doc.body).find(e => e.classList.contains('cx-status'))!;
  const posts = () => calls.filter(c => c.method !== 'GET');
  return { doc, cx, calls, posts, reads, tasks, thread, inner, dock, row, strip, advance, h, cover: (on: boolean) => { covered = on; }, windowListeners };
}
const textOf = (root: El) => root.textContent;
const buttons = (root: El, text: string) => all(root).filter(e => e.tagName === 'BUTTON' && e.textContent === text);
const button = (root: El, text: string) => { const b = buttons(root, text)[0]; assert.ok(b, 'no button ' + text); return b; };
const same = (actual: unknown, expected: unknown, message: string) => assert.ok(actual === expected, message);
const setFold = async (f: El, open: boolean) => { f.open = open; f.dispatchEvent(new Ev('toggle')); await settle(); };
const ada = { type: 'bot', id: 'Ada' }, bob = { type: 'bot', id: 'Bob' }, team = { type: 'group', id: 'g-1' };
// GET <scope>/activity as the contract describes it.
const activity = (over: Record<string, unknown> = {}) => ({
  threadId: 'thread-A', readStatus: 'ready', items: [], counts: { approval: 0, failure: 0, running: 0, queued: 0, task: 0 },
  unread: 0, unreadHasMore: false, latestMessageId: null, errors: [], ...over,
});
const busy = () => activity({
  items: [
    { id: 'a1', kind: 'approval', label: '等你确认：宪宪想运行 npm publish', threadId: 'thread-A', catId: 'cat-a', catName: '宪宪', messageId: 'm-appr-1', proposalId: 'p1' },
    { id: 'a2', kind: 'approval', label: '砚砚想写入 ~/Desktop', threadId: 'thread-A', catId: 'cat-b', catName: '砚砚', messageId: 'm-appr-2', proposalId: 'p2' },
    { id: 'r1', kind: 'running', label: '正在整理资料', threadId: 'thread-A', catId: 'cat-c', catName: '墨墨' },
    { id: 'q1', kind: 'queued', label: '等待执行', threadId: 'thread-A', catId: 'cat-a', catName: '宪宪' },
    { id: 't1', kind: 'task', label: '写周报', threadId: 'thread-A', taskId: 'task-known', messageId: 'm-task-src' },
    { id: 't2', kind: 'task', label: '整理附录', threadId: 'thread-A', taskId: 'task-gone' },
  ],
  counts: { approval: 2, failure: 0, running: 1, queued: 1, task: 3 },
});

// ---------------------------------------------------------------- rules
function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-experience-rules.js'), { window });
  return window.ClowderExperienceRules;
}

test('activity is checked, not guessed: native order, counts never below the list, unknown kinds dropped, a missing read status is not "ready"', () => {
  const X = rules();
  const a = X.activity({ threadId: 't', items: [
    { id: 'x', kind: 'task', label: ' 写\n周报 ' }, { id: 'y', kind: 'mystery' }, { id: 'z', kind: 'approval', label: '确认' }, { id: 'w', kind: 'failure' }, null,
  ], counts: { approval: 0, task: 5, failure: -1 }, unread: '3' });
  assert.deepEqual(plain(a.items.map((i: Any) => [i.kind, i.label])), [['approval', '确认'], ['failure', ''], ['task', '写 周报']]);
  assert.deepEqual(plain(a.counts), { approval: 1, failure: 1, running: 0, queued: 0, task: 5 });
  assert.equal(a.readStatus, 'unavailable', 'no read status says nothing is known');
  assert.equal(a.unread, null, 'an unread count that is not a number is unknown, not zero');
  assert.equal(X.activity(null), null);
  assert.equal(X.activity([]), null);
});

test('the status line leads with what waits for the owner and keeps every concurrent count; partial and failed reads never read as idle', () => {
  const X = rules();
  const line = X.line(X.activity(busy()));
  assert.equal(line.kind, 'approval');
  assert.equal(line.lead, '2 项等你确认');
  assert.equal(line.label, '宪宪想运行 npm publish');
  assert.deepEqual(plain(line.rest), ['处理中 1', '排队 1', '任务 3']);
  assert.equal(line.partial, false);
  // A failure outranks a run; the run keeps its count.
  const failed = X.line(X.activity(activity({ items: [{ id: 'f', kind: 'failure', label: '执行失败' }, { id: 'r', kind: 'running', label: '在写' }], counts: { failure: 1, running: 1 } })));
  assert.deepEqual([failed.lead, plain(failed.rest)], ['失败', ['处理中 1']]);
  // One run says who and what in its own words; several are counted.
  const one = X.line(X.activity(activity({ items: [{ id: 'r', kind: 'running', label: '宪宪正在处理', catId: 'cat-a' }] })));
  assert.deepEqual([one.lead, one.label, one.catId], ['宪宪正在处理', '', 'cat-a']);
  const two = X.line(X.activity(activity({ items: [{ id: 'r', kind: 'running', label: '宪宪正在处理' }, { id: 's', kind: 'running', label: '砚砚正在处理' }] })));
  assert.deepEqual([two.lead, two.label], ['2 项在处理', '']);
  assert.equal(X.itemText({ kind: 'approval', label: '等你确认：发布' }), '发布', 'the kind is not said twice');
  // Nothing proven and nothing missing: nothing to say (never "空闲").
  assert.equal(X.line(X.activity(activity())), null);
  // A partial read with nothing listed cannot tell; a partial read with items says so.
  assert.equal(X.line(X.activity(activity({ readStatus: 'partial' }))).lead, '暂时无法确认状态');
  assert.equal(X.line(X.activity({ ...busy(), readStatus: 'partial' })).partial, true);
  // A read that failed outright, with nothing read before, cannot tell either.
  assert.equal(X.line(null, { failed: true }).lead, '暂时无法确认状态');
  assert.equal(X.line(null), null);
  // New replies show only while the newest is out of sight, and only from a counted unread.
  const fresh = X.activity(activity({ unread: 2, unreadHasMore: true, latestMessageId: 'm9' }));
  assert.equal(X.line(fresh), null);
  assert.equal(X.line(fresh, { showUnread: true }).lead, '2+ 条新回复');
  assert.deepEqual(plain(X.line(X.activity({ ...busy(), unread: 1 }), { showUnread: true }).rest), ['处理中 1', '排队 1', '任务 3', '新回复 1']);
  for (const k of ['approval', 'failure', 'running', 'queued', 'task']) assert.doesNotMatch(X.lead(k, 2) + X.TAG[k], /子代理|invocation|已完成|全部完成|回复/);
});

test('sidebar: awaiting from approvals with their count, groups read from their activity, unknown is never idle, unread is the server count', () => {
  const X = rules();
  assert.deepEqual(plain(X.side({ state: 'awaiting', thread_id: 't', activity: busy() })), { kind: 'awaiting', text: '2 项等你确认', unread: 0, threadId: 't' });
  assert.equal(X.side({ state: 'unknown', activity: activity({ readStatus: 'partial' }) }).text, '暂时无法确认状态');
  assert.equal(X.side({ state: 'idle', activity: activity({ counts: { failure: 2 } }) }).text, '2 项失败');
  assert.equal(X.side({ state: 'running', activity: activity({ counts: { failure: 1, running: 1 } }) }).kind, 'running', 'a run shows as running; its failure stays in the line');
  // Groups carry no state: the activity says it.
  assert.equal(X.side({ id: 'g', activity: busy() }).kind, 'awaiting');
  assert.equal(X.side({ id: 'g', activity: activity({ counts: { running: 1 } }) }).kind, 'running');
  assert.equal(X.side({ id: 'g', activity: activity({ readStatus: 'unavailable' }) }).kind, 'unknown');
  assert.equal(X.side({ id: 'g', activity: activity() }).kind, 'idle');
  assert.equal(X.side({ id: 'g', activity: activity({ unread: 4 }) }).unread, 4);
  assert.equal(X.side({ id: 'g', activity: activity({ unread: null }) }).unread, 0, 'an unknown count is not a dot');
});

test('read target: only the newest visible reply, while something is unread, in the open thread, on a visible uncovered page, in sight, and once', () => {
  const X = rules();
  const a = X.activity(activity({ unread: 1, latestMessageId: 'm2' }));
  const ok = { pageVisible: true, obscured: false, threadId: 'thread-A', done: () => false, seen: (id: string) => id === 'm2' };
  assert.equal(X.readTarget(a, ok), 'm2');
  assert.equal(X.readTarget(a, { ...ok, pageVisible: false }), '', 'a hidden page reads nothing');
  assert.equal(X.readTarget(a, { ...ok, obscured: true }), '', 'a covered chat reads nothing');
  assert.equal(X.readTarget(a, { ...ok, seen: () => false }), '', 'scrolled back to older messages: the newest stays unread');
  assert.equal(X.readTarget(a, { ...ok, threadId: 'thread-B' }), '', 'another thread\'s reply is never confirmed');
  assert.equal(X.readTarget(a, { ...ok, done: () => true }), '', 'never twice');
  assert.equal(X.readTarget(X.activity(activity({ unread: 0, latestMessageId: 'm2' })), ok), '', 'nothing unread, nothing to send');
  assert.equal(X.readTarget(X.activity(activity({ unread: null, latestMessageId: 'm2' })), ok), '', 'a failed message read is not a reason to confirm');
  assert.equal(X.readTarget(X.activity(activity({ unread: 1 })), ok), '');
});

test('memory reads keep proposed changes apart from saved content, retired entries last, and failures distinct from "nothing saved"', () => {
  const X = rules();
  const m = X.memory({ kind: 'taste', readStatus: 'partial', entries: [
    { id: 'old', title: '旧偏好', content: 'x', revision: 'r1', status: 'retired', pendingCount: 0 },
    { id: 'p1', title: '先给结论', content: '回答先给结论\r\n再给理由', revision: 'r7', status: 'active', pendingCount: 2, updatedAt: '2026-11-05T01:00:00Z' },
    { id: 'q', title: '奇怪', content: '', revision: 3, status: 'proposed' },
  ] }, 'taste');
  assert.equal(m.readStatus, 'partial');
  assert.deepEqual(plain(m.entries.map((e: Any) => [e.id, e.status, e.pendingCount, e.revision])), [['p1', 'active', 2, 'r7'], ['q', 'unknown', 0, '3'], ['old', 'retired', 0, 'r1']]);
  assert.equal(m.entries[0].content, '回答先给结论\n再给理由');
  assert.equal(X.memory({ entries: [] }, 'profile').readStatus, 'unavailable');
  assert.deepEqual(['denied', 'denied', 'missing', 'changed', 'error'], [401, 403, 404, 409, 500].map(status => X.memoryError({ status, message: 'x' }).kind));
  assert.equal(X.sources({ status: 'weird' }).status, 'unavailable');
});

// ---------------------------------------------------------------- status line
test('concurrent approvals: the line leads with both, keeps the other counts, steps the old lines aside, and opens in place onto items that find their message or Task', async () => {
  const p = page(path => (path.endsWith('/activity') ? busy() : {}));
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  const strip = p.strip();
  assert.equal(strip.hidden, false);
  assert.ok(p.dock.classList.contains('cx-on'), 'the separate execution and Task lines step aside: one line, not two');
  const row = strip.querySelector('.cx-row')!;
  assert.equal(textOf(row), '2 项等你确认宪宪想运行 npm publish· 处理中 1 · 排队 1 · 任务 3');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  assert.doesNotMatch(textOf(strip), /子代理|invocation/);
  row.click();
  const list = strip.querySelector('.cx-list')!;
  assert.equal(strip.querySelector('.cx-row')!.getAttribute('aria-expanded'), 'true');
  const items = list.querySelectorAll('.cx-item');
  assert.deepEqual(items.map(i => i.dataset.kind), ['approval', 'approval', 'running', 'queued', 'task', 'task']);
  assert.match(textOf(list), /另有 1 项没有列出，任务的全部内容在「任务」页。/, 'a count beyond the list is never dropped');
  assert.equal(all(list).filter(e => /^查看其余/.test(e.textContent)).length, 0, 'six rows fit: nothing to open');
  // An approval points at its message and at the existing approval controls; nothing approves here.
  const first = items[0];
  const link = all(first).find(e => e.tagName === 'A')!;
  assert.deepEqual([textOf(link), link.href, link.target], ['去确认', '/runtime.html', '_blank']);
  const message = p.row('m-appr-1', 900);
  button(first, '查看').click();
  await settle();
  assert.equal(message.scrolled, 1);
  assert.ok(message.classList.contains('cx-hit'));
  same(p.doc.activeElement, message, 'focus lands on the message found');
  // Not in the history shown: said, with the way to the controls, nothing invented.
  button(p.strip().querySelectorAll('.cx-item')[1], '查看').click();
  await settle();
  assert.match(textOf(p.strip()), /当前显示的对话里没有这条确认的消息。可以在运行面板确认。/);
  // A Task item opens 任务 at that Task; one the page has not read is said plainly.
  button(p.strip().querySelectorAll('.cx-item')[4], '打开任务').click();
  await settle();
  button(p.strip().querySelectorAll('.cx-item')[5], '打开任务').click();
  await settle();
  assert.deepEqual(p.tasks, ['task-known', 'task-gone'], 'a Task with a source message still opens at its card');
  assert.match(textOf(p.strip()), /「任务」页里还没有读到这项任务。/);
  // A running item without a coordinate is not a control.
  assert.equal(all(p.strip().querySelectorAll('.cx-item')[2]).filter(e => e.tagName === 'BUTTON').length, 0);
  assert.deepEqual(p.posts(), [], 'nothing was sent: no approval, no read');
  // Escape folds the list and returns to the line.
  p.strip().querySelector('.cx-row')!.focus();
  p.strip().dispatchEvent(new Ev('keydown', { key: 'Escape' }));
  assert.equal(p.strip().querySelector('.cx-list'), null);
});

test('more than six items: the list starts short, 查看其余 N 项 opens every approval and concurrent item in place, a refresh keeps it open, 收起 folds it', async () => {
  const approval = (k: number) => ({ id: 'a' + k, kind: 'approval', label: '确认第 ' + (k + 1) + ' 项', threadId: 'thread-A', catId: 'cat-a', catName: '宪宪', messageId: 'm-appr-' + k, proposalId: 'p' + k });
  const others = [
    { id: 'r1', kind: 'running', label: '墨墨正在处理', threadId: 'thread-A', catId: 'cat-c', catName: '墨墨' },
    { id: 'q1', kind: 'queued', label: '宪宪的消息排队中', threadId: 'thread-A', catId: 'cat-a', catName: '宪宪', messageId: 'm-queued' },
    { id: 't1', kind: 'task', label: '写周报 · 进行中', threadId: 'thread-A', taskId: 'task-known' },
  ];
  let approvals = 8;
  const now = () => activity({
    items: [...Array.from({ length: approvals }, (_, k) => approval(k)), ...others],
    counts: { approval: approvals, failure: 0, running: 1, queued: 1, task: 1 },
  });
  const p = page(path => (path.endsWith('/activity') ? now() : {}));
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(textOf(p.strip().querySelector('.cx-row')!), '8 项等你确认确认第 1 项· 处理中 1 · 排队 1 · 任务 1');
  p.strip().querySelector('.cx-row')!.click();
  const kinds = () => p.strip().querySelectorAll('.cx-item').filter(i => i.dataset.kind).map(i => i.dataset.kind);
  assert.deepEqual(kinds(), Array(6).fill('approval'), 'short by default');
  const open = button(p.strip(), '查看其余 5 项');
  assert.equal(open.getAttribute('aria-expanded'), 'false');
  assert.doesNotMatch(textOf(p.strip()), /另有/, 'every item has a row: none is said to be left out');
  open.focus();
  open.click();
  assert.deepEqual(kinds(), [...Array(8).fill('approval'), 'running', 'queued', 'task'], 'every approval and every concurrent item, in native order');
  const fold = button(p.strip(), '收起');
  same(p.doc.activeElement, fold, 'focus stays on the toggle it pressed');
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  // The seventh and eighth approvals can be found: each points at its own message and at the existing controls.
  const rows = () => p.strip().querySelectorAll('.cx-item');
  assert.deepEqual([6, 7].map(k => textOf(rows()[k])), ['等你确认确认第 7 项查看去确认', '等你确认确认第 8 项查看去确认']);
  const eighth = p.row('m-appr-7', 900);
  button(rows()[7], '查看').click();
  await settle();
  assert.equal(eighth.scrolled, 1);
  same(p.doc.activeElement, eighth, 'the eighth approval\'s message is found and focused');
  // Refreshes keep what the owner opened, focus included, and show what arrived.
  for (let i = 0; i < 3; i++) { p.cx.touch(); p.cx.observe(ada, 'thread-A', true); await settle(); }
  assert.equal(kinds().length, 11, 'a refresh does not fold the list again');
  button(p.strip(), '收起').focus();
  approvals = 9;
  p.cx.touch();
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.deepEqual(kinds(), [...Array(9).fill('approval'), 'running', 'queued', 'task']);
  same(p.doc.activeElement, button(p.strip(), '收起'), 'the redraw keeps focus on the toggle');
  assert.match(textOf(p.strip().querySelector('.cx-row')!), /^9 项等你确认/);
  // 收起 returns to the short list; the way back stays.
  button(p.strip(), '收起').click();
  assert.deepEqual(kinds(), Array(6).fill('approval'));
  assert.equal(button(p.strip(), '查看其余 6 项').getAttribute('aria-expanded'), 'false');
  // Opened again and then another conversation: that one starts short.
  button(p.strip(), '查看其余 6 项').click();
  p.cx.select(bob);
  p.cx.observe(bob, 'thread-A', true);
  await settle();
  p.strip().querySelector('.cx-row')!.click();
  assert.equal(kinds().length, 6);
  assert.deepEqual(p.posts(), [], 'nothing was sent: no approval, no read');
});

test('a lost connection keeps what was last read and says it may have changed; a first read that fails cannot tell; a partial read lists its errors; a server without the projection keeps the old lines', async () => {
  let mode = 'ok';
  const p = page(path => {
    if (!path.endsWith('/activity')) return {};
    if (mode === 'down') throw failure(0, '连不上 clowder-bot');
    if (mode === 'partial') return activity({ readStatus: 'partial', errors: [{ source: 'queue', message: '队列读取超时' }] });
    return busy();
  });
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  mode = 'down';
  p.cx.touch();
  p.cx.observe(ada, 'thread-A', false);
  await settle();
  const row = p.strip().querySelector('.cx-row')!;
  assert.match(textOf(row), /^2 项等你确认.*· 部分状态读不到$/, 'the last read stays, marked as possibly stale');
  row.click();
  assert.match(textOf(p.strip()), /状态没能刷新：连不上 clowder-bot。下面是上次读到的结果，可能已经变化。\s?重试/);
  // Retry reads again.
  mode = 'partial';
  button(p.strip(), '重试').click();
  await settle();
  assert.equal(textOf(p.strip().querySelector('.cx-row')!).startsWith('暂时无法确认状态'), true, 'a partial read with nothing listed is not idle');
  assert.equal(p.strip().querySelector('.cx-row')!.getAttribute('aria-expanded'), 'true', 'the list the owner opened stays open across the read');
  assert.match(textOf(p.strip()), /部分状态暂时读不到，这里不代表已经空闲或全部完成。\s?重试/);
  assert.match(textOf(p.strip()), /queue：队列读取超时/);

  // The first read fails: still not idle.
  const q = page(() => { throw failure(500, '服务出了点问题，请稍后再试。'); });
  q.cx.select(bob);
  await settle();
  assert.equal(q.strip().hidden, false);
  assert.match(textOf(q.strip()), /^暂时无法确认状态/);
  assert.ok(q.dock.classList.contains('cx-on'));

  // No such route on this server: the earlier lines stay in charge.
  const r = page(() => { throw failure(404, 'not found'); });
  r.cx.select(bob);
  await settle();
  assert.equal(r.strip().hidden, true);
  assert.ok(!r.dock.classList.contains('cx-on'));
  assert.equal(r.cx.active(), false);
});

test('a late activity answer for the previous conversation or another thread never paints here', async () => {
  const slow = deferred<Any>();
  let asked = 0;
  const p = page(path => {
    if (!path.endsWith('/activity')) return {};
    asked++;
    if (path.startsWith('/xbot-api/bots/Ada')) return slow.promise;
    return activity({ threadId: 'thread-B2' });
  });
  p.cx.select(ada);
  p.cx.select(team);
  p.cx.observe(team, 'thread-G', true);
  slow.resolve(busy());
  await settle();
  assert.equal(p.strip().hidden, true, 'Ada\'s approvals never show in the group');
  assert.equal(p.cx.activity(), null, 'and the group\'s answer named another thread, so it was dropped');
  assert.ok(asked >= 2);
  assert.equal(p.calls.filter(c => c.path === '/xbot-api/groups/g-1/activity').length >= 1, true);
});

// ---------------------------------------------------------------- read position
function reading(over: Record<string, unknown> = {}, readReply: (body: Any) => unknown = body => ({ threadId: body.expectedThreadId, readMessageId: body.messageId })) {
  const p = page((path, method, body) => {
    if (path.endsWith('/activity')) return activity({ unread: 1, latestMessageId: 'm-new', ...over });
    if (path.endsWith('/read') && method === 'POST') return readReply(body);
    return {};
  });
  return p;
}

test('a reply is confirmed read only after it stays in sight on a visible page; GET alone reads nothing and the same reply is never sent twice', async () => {
  const p = reading();
  p.cx.select(ada);
  const latest = p.row('m-new', 500);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.deepEqual(p.posts(), [], 'reading the activity marks nothing');
  await p.advance(400);
  assert.deepEqual(p.posts(), [], 'not before the reply has been in sight for a moment');
  await p.advance(500);
  assert.deepEqual(p.posts(), [{ path: '/xbot-api/bots/Ada/read', method: 'POST', body: { expectedThreadId: 'thread-A', messageId: 'm-new' } }]);
  assert.deepEqual(p.reads, [{ sel: ada, threadId: 'thread-A', messageId: 'm-new' }]);
  // Polls, redraws and scrolls after that send nothing more.
  for (let i = 0; i < 3; i++) { p.cx.observe(ada, 'thread-A', false); p.cx.rendered(); p.thread.dispatchEvent(new Ev('scroll')); await p.advance(1000); }
  assert.equal(p.posts().length, 1);
  void latest;
});

test('a hidden page, a covered chat, or reading older messages never clears the newest unread; the line offers the new reply instead', async () => {
  const p = reading();
  p.cx.select(ada);
  const latest = p.row('m-new', 500);
  p.doc.show('hidden');
  p.cx.observe(ada, 'thread-A', true);
  await p.advance(2000);
  assert.deepEqual(p.posts(), [], 'background polls with the page hidden read nothing');
  // Shown again but scrolled back: the newest is out of sight.
  latest.rect = { top: 900, bottom: 940 };
  p.doc.show('visible');
  p.cx.rendered();
  await p.advance(2000);
  assert.deepEqual(p.posts(), []);
  assert.match(textOf(p.strip()), /^1 条新回复/, 'the line says a reply arrived, from the server\'s count');
  p.strip().querySelector('.cx-row')!.click();
  button(p.strip(), '看最新回复').click();
  await settle();
  assert.equal(latest.scrolled, 1);
  // The drawer covers the history on a narrow window: still nothing.
  latest.rect = { top: 500, bottom: 540 };
  p.cover(true);
  p.cx.rendered();
  await p.advance(2000);
  assert.deepEqual(p.posts(), []);
  // Hidden in the middle of the wait: the wait is dropped.
  p.cover(false);
  p.cx.rendered();
  await p.advance(300);
  p.doc.show('hidden');
  await p.advance(2000);
  assert.deepEqual(p.posts(), []);
  p.doc.show('visible');
  await p.advance(900);
  assert.equal(p.posts().length, 1, 'in sight on a visible page: confirmed');
});

test('a read answered after switching conversations changes nothing there; a refused read (409) is not repeated; another thread\'s reply is never confirmed', async () => {
  const answer = deferred<Any>();
  const p = reading({}, () => answer.promise);
  p.cx.select(ada);
  p.row('m-new', 500);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(900);
  assert.equal(p.posts().length, 1);
  p.cx.select(bob);
  answer.resolve({ threadId: 'thread-A', readMessageId: 'm-new' });
  await settle();
  assert.deepEqual(p.reads, [], 'the late answer is dropped');

  let tries = 0;
  const q = reading({}, () => { tries++; throw failure(409, '会话已变化'); });
  q.cx.select(ada);
  q.row('m-new', 500);
  q.cx.observe(ada, 'thread-A', true);
  await settle();
  await q.advance(900);
  for (let i = 0; i < 3; i++) { q.cx.observe(ada, 'thread-A', false); await q.advance(1000); }
  assert.equal(tries, 1, 'a refused confirmation is not sent again');
  assert.ok(q.calls.filter(c => c.path.endsWith('/activity')).length >= 2, 'a 409 reads the state again');

  // The activity names another thread than the chat shows: nothing is confirmed.
  const r = reading({ threadId: 'thread-OTHER' });
  r.cx.select(ada);
  r.row('m-new', 500);
  r.cx.observe(ada, 'thread-A', true);
  await settle();
  await r.advance(2000);
  assert.deepEqual(r.posts(), []);
});

test('a 404 refuses that one reply, not reading in the conversation: after A is refused, the newer B is still confirmed; 409s are per reply too', async () => {
  let latest = 'm-A';
  const asked: string[] = [];
  let refuse = (id: string): unknown => { if (id === 'm-A') throw failure(404, '这条可见回复不属于当前对话'); return null; };
  const p = page((path, method, body) => {
    if (path.endsWith('/activity')) return activity({ unread: 1, latestMessageId: latest });
    if (path.endsWith('/read') && method === 'POST') { asked.push(body.messageId); refuse(body.messageId); return { threadId: 'thread-A', readMessageId: body.messageId }; }
    return {};
  });
  p.cx.select(ada);
  p.row('m-A', 500);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(900);
  for (let i = 0; i < 3; i++) { p.cx.observe(ada, 'thread-A', false); p.cx.rendered(); await p.advance(1000); }
  assert.deepEqual(asked, ['m-A'], 'the refused reply is not asked about again');
  assert.deepEqual(p.reads, []);
  // B arrives in the same conversation and thread: still confirmed, at once.
  latest = 'm-B';
  p.row('m-B', 520);
  p.cx.touch();
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(900);
  assert.deepEqual(asked, ['m-A', 'm-B'], 'a refusal never turns reading off for the conversation');
  assert.deepEqual(p.reads, [{ sel: ada, threadId: 'thread-A', messageId: 'm-B' }]);
  // A 409 for C, then D: also one reply at a time.
  refuse = (id: string) => { if (id === 'm-C') throw failure(409, '会话已变化，请刷新后重试'); return null; };
  latest = 'm-C';
  p.row('m-C', 540);
  p.cx.touch();
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(900);
  latest = 'm-D';
  p.row('m-D', 560);
  p.cx.touch();
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(900);
  assert.deepEqual(asked, ['m-A', 'm-B', 'm-C', 'm-D']);
});

test('a late read answer for the thread or conversation the chat has left changes nothing here: no wait, no refusal, no reload', async () => {
  // The same cat moves to another thread while A's read is out; A then fails.
  let thread = 'thread-A';
  const slow = deferred<Any>();
  const p = page((path, method, body) => {
    if (path.endsWith('/activity')) return activity({ threadId: thread, unread: 1, latestMessageId: thread === 'thread-A' ? 'm-A' : 'm-T2' });
    if (path.endsWith('/read') && method === 'POST') return body.expectedThreadId === 'thread-A' ? slow.promise : { threadId: body.expectedThreadId, readMessageId: body.messageId };
    return {};
  });
  p.cx.select(ada);
  p.row('m-A', 500);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(900);
  assert.equal(p.posts().length, 1);
  thread = 'thread-T2';
  p.row('m-T2', 540);
  p.cx.observe(ada, 'thread-T2', true);
  await settle();
  const reads = p.calls.filter(c => c.path.endsWith('/activity')).length;
  slow.reject(failure(503, '服务暂时不可用'));
  await settle();
  await p.advance(900);
  assert.deepEqual(p.posts().map(c => c.body), [
    { expectedThreadId: 'thread-A', messageId: 'm-A' },
    { expectedThreadId: 'thread-T2', messageId: 'm-T2' },
  ], 'the old thread\'s failure puts no wait on the new one');
  assert.deepEqual(p.reads, [{ sel: ada, threadId: 'thread-T2', messageId: 'm-T2' }]);
  assert.equal(p.calls.filter(c => c.path.endsWith('/activity')).length, reads, 'and reads nothing again for it');

  // Another conversation opens while Ada's read is out; Ada's then answers 409.
  const late = deferred<Any>();
  let turn = 0;
  const q = page((path, method, body) => {
    if (path.endsWith('/activity')) return activity({ threadId: path.includes('/Bob/') ? 'thread-B' : 'thread-A', unread: 1, latestMessageId: path.includes('/Bob/') ? 'm-bob' : 'm-A' });
    if (path.endsWith('/read') && method === 'POST') {
      if (body.expectedThreadId === 'thread-A' && ++turn === 1) return late.promise;
      return { threadId: body.expectedThreadId, readMessageId: body.messageId };
    }
    return {};
  });
  q.cx.select(ada);
  q.row('m-A', 500);
  q.cx.observe(ada, 'thread-A', true);
  await settle();
  await q.advance(900);
  q.cx.select(bob);
  q.row('m-bob', 520);
  q.cx.observe(bob, 'thread-B', true);
  await settle();
  const before = q.calls.filter(c => c.path.endsWith('/activity')).length;
  late.reject(failure(409, '会话已变化，请刷新后重试'));
  await settle();
  assert.equal(q.calls.filter(c => c.path.endsWith('/activity')).length, before, 'Ada\'s 409 does not reload Bob\'s state');
  await q.advance(900);
  assert.deepEqual(q.posts().map(c => c.body.messageId), ['m-A', 'm-bob'], 'Bob\'s reply is confirmed as usual');
  assert.deepEqual(q.reads, [{ sel: bob, threadId: 'thread-B', messageId: 'm-bob' }]);
  // Back to Ada: the late refusal left nothing behind, so her reply is asked about again.
  q.cx.select(ada);
  q.cx.observe(ada, 'thread-A', true);
  await settle();
  await q.advance(900);
  assert.deepEqual(q.posts().map(c => c.body.messageId), ['m-A', 'm-bob', 'm-A']);
  assert.deepEqual(q.reads.at(-1), { sel: ada, threadId: 'thread-A', messageId: 'm-A' });
});

// ---------------------------------------------------------------- 记忆
function memoryPage(answers: Record<string, () => unknown>) {
  const p = page((path, method, body) => {
    const bare = path.split('?')[0];
    const key = method + ' ' + bare;
    if (Object.hasOwn(answers, key)) return answers[key]!();
    if (bare.endsWith('/activity')) return activity();
    throw failure(404, 'unexpected ' + key + JSON.stringify(body ?? ''));
  });
  p.cx.select(ada);
  const root = p.cx.memoryView(ada, { memory: [{ id: 'note-1', scope: 'conversation', text: '周五前交' }] }) as El;
  p.doc.body.append(root);
  const fold = (kind: string) => root.querySelectorAll('details').find(d => d.dataset.kind === kind)!;
  return { ...p, root, fold };
}

test('记忆: 关于你 and 你的偏好 start folded and unread; opening one reads it and shows saved content apart from pending changes, with no editing controls', async () => {
  const p = memoryPage({
    'GET /xbot-api/memory/profile': () => ({ kind: 'profile', readStatus: 'ready', entries: [{ id: 'doc', title: '关于你', content: '在上海工作\n喜欢简短回答', revision: 'r3', status: 'active', pendingCount: 1, updatedAt: Date.now() }] }),
    'GET /xbot-api/memory/taste': () => ({ kind: 'taste', readStatus: 'ready', entries: [] }),
  });
  await settle();
  assert.deepEqual(p.root.querySelectorAll('details').filter(d => d.classList.contains('cx-fold')).map(d => [textOf(d.firstChild as El), d.open]), [['关于你', false], ['你的偏好', false]]);
  assert.equal(p.calls.filter(c => c.path.startsWith('/xbot-api/memory')).length, 0, 'nothing is read until a fold opens');
  await setFold(p.fold('profile'), true);
  assert.deepEqual(p.calls.filter(c => c.path.startsWith('/xbot-api/memory')).map(c => c.path), ['/xbot-api/memory/profile']);
  const body = textOf(p.fold('profile'));
  assert.match(body, /在上海工作\n喜欢简短回答/);
  assert.match(body, /另有 1 条待确认的修改，确认前不算已保存，也不在上面的内容里。/);
  await setFold(p.fold('taste'), true);
  assert.match(textOf(p.fold('taste')), /还没有保存的偏好。/);
  // Read only, the whole of 记忆: no edit, confirm, retire, forget, add or delete, and no promise that saying it saves it.
  const controls = all(p.root).filter(e => ['BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'FORM'].includes(e.tagName)).map(textOf);
  assert.deepEqual(controls, []);
  assert.doesNotMatch(textOf(p.root), /编辑|确认修改|停用|遗忘|忘记|添加|删除|说「记住|就会出现/);
  // The conversation's notes stay, read only and named for their reach.
  assert.equal(textOf(p.root.querySelector('.cx-notes')!), '这个对话的便笺 · 1周五前交便笺只属于这个对话，换到别的对话不会带过去。');
  assert.deepEqual(p.posts(), [], 'nothing but reads');
});

test('记忆: a failed read is not "nothing saved" and retries; no permission, partial and an absent route each say so', async () => {
  let profile: () => unknown = () => { throw failure(500, '服务出了点问题，请稍后再试。'); };
  const p = memoryPage({
    'GET /xbot-api/memory/profile': () => profile(),
    'GET /xbot-api/memory/taste': () => { throw failure(403, 'forbidden'); },
  });
  await setFold(p.fold('profile'), true);
  assert.match(textOf(p.fold('profile')), /没能读取：服务出了点问题，请稍后再试。这不代表没有内容。\s?重试/);
  assert.doesNotMatch(textOf(p.fold('profile')), /还没有/);
  profile = () => ({ kind: 'profile', readStatus: 'partial', entries: [{ id: 'doc', title: '工作', content: '设计师', revision: 'r1', status: 'active', pendingCount: 0 }] });
  button(p.fold('profile'), '重试').click();
  await settle();
  assert.match(textOf(p.fold('profile')), /部分内容暂时读不到，下面只显示读到的部分。\s?重试/);
  assert.match(textOf(p.fold('profile')), /设计师/);
  profile = () => ({ kind: 'profile', readStatus: 'unavailable', entries: [] });
  await setFold(p.fold('profile'), false);
  await setFold(p.fold('profile'), true);
  assert.match(textOf(p.fold('profile')), /暂时读不到，这不代表没有内容。\s?重试/);
  await setFold(p.fold('taste'), true);
  assert.match(textOf(p.fold('taste')), /没有权限读取：没有权限读取。\s?重试/);

  const q = memoryPage({ 'GET /xbot-api/memory/profile': () => { throw failure(404, 'not found'); } });
  await setFold(q.fold('profile'), true);
  assert.match(textOf(q.fold('profile')), /当前后端还没有开放这部分。/);
});

test('记忆: a source is read on demand for the entry\'s revision; a changed entry (409) asks to read the list again; not recorded and denied say so', async () => {
  let rev = 'r3', source: () => unknown = () => { throw failure(409, 'revision mismatch'); };
  const p = memoryPage({
    'GET /xbot-api/memory/taste': () => ({ kind: 'taste', readStatus: 'ready', entries: [{ id: 'pref 1', title: '先给结论', content: '回答先给结论', revision: rev, status: 'active', pendingCount: 0 }] }),
    'GET /xbot-api/memory/taste/pref%201/source': () => source(),
  });
  await setFold(p.fold('taste'), true);
  const src = () => p.fold('taste').querySelectorAll('details').find(d => d.classList.contains('cx-src'))!;
  assert.equal(p.calls.filter(c => c.path.includes('/source')).length, 0, 'no source read until asked');
  await setFold(src(), true);
  assert.deepEqual(p.calls.filter(c => c.path.includes('/source')).map(c => c.path), ['/xbot-api/memory/taste/pref%201/source?revision=r3']);
  assert.match(textOf(src()), /这条已经更新，重新读取后再看来源。\s?重新读取/);
  rev = 'r4';
  source = () => ({ status: 'not_recorded', sources: [] });
  button(src(), '重新读取').click();
  await settle();
  assert.equal(p.calls.filter(c => c.path === '/xbot-api/memory/taste').length, 2, 'the list is read again for the new revision');
  await setFold(src(), true);
  assert.equal(p.calls.filter(c => c.path.includes('/source')).at(-1)!.path, '/xbot-api/memory/taste/pref%201/source?revision=r4');
  assert.match(textOf(src()), /没有记录这条的来源。/);
  source = () => { throw failure(403, 'forbidden'); };
  await setFold(src(), false);
  await setFold(src(), true);
  assert.match(textOf(src()), /没有权限查看来源：没有权限读取。/);
  source = () => ({ status: 'ready', sources: [{ label: '对话中的一句话', occurredAt: Date.now(), canOpen: true, threadId: 'thread-elsewhere', messageId: 'm1' }] });
  await setFold(src(), false);
  await setFold(src(), true);
  assert.match(textOf(src()), /对话中的一句话/);
  assert.deepEqual(buttons(src(), '在对话里查看'), [], 'a message in another conversation is not offered as if it were here');
});

test('这个对话的便笺 is read only like the rest of 记忆: no add or delete; a failed read says so and retries, never "no notes"; a group shows no owner records', async () => {
  let notes: () => unknown = () => { throw failure(500, '服务出了点问题，请稍后再试。'); };
  const p = page((path, method) => {
    if (path.endsWith('/activity')) return activity();
    if (method === 'GET' && path === '/xbot-api/bots/Ada/memory') return notes();
    throw failure(404, 'unexpected ' + method + ' ' + path);
  });
  p.cx.select(ada);
  // The drawer came without its notes: they are read once.
  const root = p.cx.memoryView(ada, { name: 'Ada' }) as El;
  p.doc.body.append(root);
  const sec = root.querySelector('.cx-notes')!;
  assert.match(textOf(sec), /正在读取…/);
  await settle();
  const asked = () => p.calls.filter(c => c.path === '/xbot-api/bots/Ada/memory').length;
  assert.match(textOf(sec), /^这个对话的便笺便笺没能读取：服务出了点问题，请稍后再试。这不代表没有便笺。\s?重试/);
  assert.doesNotMatch(textOf(sec), /还没有便笺/, 'a failure is not "no notes"');
  assert.equal(sec.querySelector('[role=alert]') !== null, true);
  // Drawn again by the drawer: the failure stays; reading again is the owner's 重试.
  p.cx.memoryView(ada, { name: 'Ada' });
  await settle();
  assert.equal(asked(), 1);
  // 重试 that fails again says so again and keeps focus.
  const retry = button(sec, '重试');
  retry.focus();
  retry.click();
  await settle();
  assert.equal(asked(), 2);
  same(p.doc.activeElement, button(sec, '重试'), '重试 keeps focus after another failure');
  notes = () => ({ memory: [] });
  button(sec, '重试').click();
  await settle();
  assert.match(textOf(sec), /^这个对话的便笺 · 0这个对话还没有便笺。/, 'empty only after a read that worked');
  // The drawer's own notes are shown as they are, read only.
  p.cx.memoryView(ada, { name: 'Ada', memory: [{ id: 'note-1', scope: 'conversation', text: '周五前交' }, { id: 'note-2', scope: 'conversation', text: '用中文\n简短' }] });
  assert.equal(textOf(sec), '这个对话的便笺 · 2周五前交用中文\n简短便笺只属于这个对话，换到别的对话不会带过去。');
  assert.deepEqual(all(root).filter(e => ['BUTTON', 'TEXTAREA', 'INPUT', 'FORM'].includes(e.tagName)).map(textOf), [], 'no field, no add, no delete');
  assert.deepEqual(p.posts(), [], 'nothing but reads went out');
  // The module itself has no way to write memory or notes: its only write is the read position.
  const src = read('client/public/chat-experience.js');
  assert.equal((src.match(/method:/g) || []).length, 1);
  assert.match(src, /"\/read", \{ method: "POST"/);
  assert.doesNotMatch(src, /"DELETE"|"PUT"|"PATCH"|textarea|添加便笺|删除这条便笺/);

  const g = page(() => ({}));
  g.cx.select(team);
  const view = g.cx.memoryView(team) as El;
  assert.equal(textOf(view), '群聊没有可查看的记忆。关于你的资料和偏好，在和猫猫的单聊里查看。');
  assert.equal(g.calls.filter(c => c.path.includes('/memory')).length, 0);
});

// ---------------------------------------------------------------- wiring
test('the page loads the status-line scripts after workspace.js and before app.js; the shell wires select, observe, touch, rendered, the sidebar and 记忆, and keeps no false memory promise', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/chat-experience.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('workspace.js') < at('chat-experience-rules.js') && at('chat-experience-rules.js') < at('chat-experience.js') && at('chat-experience.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.equal(styles.at(-1), 'chat-experience.css');
  // Conversation changes, reads, native events and redraws reach the module.
  assert.match(app, /workspace\.select\(state\.sel\);\n[^\n]*\n\s+experience\.select\(state\.sel\);/);
  assert.equal((app.match(/experience\.observe\(selection, /g) || []).length, 2, 'single chats and groups');
  assert.match(app, /experience\.touch\(\);/);
  assert.equal((app.match(/experience\.rendered\(\);/g) || []).length, 4, 'both histories, drawn or empty');
  // History rows carry the native message ID.
  assert.equal((app.match(/row\.dataset\.mid = /g) || []).length, 3);
  // The sidebar: groups get a line and a dot; 等你确认 goes through the status line, never by guessing a card.
  assert.match(app, /function groupDesc\(g\)/);
  assert.match(app, /unreadOf\(stStatus\.groups\[g\.id\]\)/);
  assert.match(app, /await experience\.attend\(\);/);
  assert.doesNotMatch(app, /jumpToApproval|querySelectorAll\("#thread \.approval"\)/);
  // 记忆 is the module's; the group's false promise and the old notes view are gone; no 子代理 headline.
  assert.match(app, /experience\.memoryView\(state\.sel, data\)/);
  assert.match(app, /experience\.memoryView\(state\.sel\)/);
  assert.doesNotMatch(app, /对它说「记住|function libraryView|个子代理/);
  // Reads are confirmed only by the module.
  assert.doesNotMatch(app, /"\/read"/);
  // Only existing tokens.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
