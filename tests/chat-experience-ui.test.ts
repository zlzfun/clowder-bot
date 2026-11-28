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
// faked the way it passes them to init(), and static checks cover its wiring;
// only its sidebar row and selection functions run, on the same DOM.
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
  replaceWith(n: Base) { const p = this.parent!; p.insertBefore(n, this); this.remove(); }
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
  // Item 46: one failure leads with its own label, which already says it failed (not 「失败 执行失败」); it keeps its kind (the colour).
  assert.deepEqual([failed.lead, failed.label, failed.kind, plain(failed.rest)], ['执行失败', '', 'failure', ['处理中 1']]);
  const bare = X.line(X.activity(activity({ items: [{ id: 'f', kind: 'failure' }], counts: { failure: 1 } })));
  assert.deepEqual([bare.lead, bare.label], ['失败', ''], 'a failure without words of its own still says 失败');
  const twoFailed = X.line(X.activity(activity({ items: [{ id: 'f', kind: 'failure', label: '宪宪这次没完成' }, { id: 'g', kind: 'failure', label: '砚砚这次没完成' }], counts: { failure: 2 } })));
  assert.deepEqual([twoFailed.lead, twoFailed.label], ['2 项失败', '宪宪这次没完成'], 'two are counted, the first named');
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

test('a cat drawn writing in the history is not said again on the line; waiting in line, a request and a failure stay', () => {
  const X = rules();
  const writing = (...ids: string[]) => new Set(ids);
  // One cat writing its reply in view: the line has nothing to add (no 「宪宪正在处理」 above the typing row).
  const one = X.activity(activity({ items: [{ id: 'r', kind: 'running', label: '宪宪正在处理', catId: 'cat-a' }] }));
  assert.equal(X.line(one, { writing: writing('cat-a') }), null);
  assert.equal(X.line(one, { writing: writing('cat-b') }).lead, '宪宪正在处理', 'another cat working out of view is still said');
  assert.equal(X.line(one, { writing: writing() }).lead, '宪宪正在处理');
  // A group's typing bubble before a cat is named stands for any running cat of this conversation.
  assert.equal(X.line(one, { writing: writing('') }), null);
  // What waits for the owner, a failure and the queue are never dropped; the run loses only its own count.
  const lead = X.line(X.activity(busy()), { writing: writing('cat-a', '') });
  assert.equal(lead.kind, 'approval');
  assert.deepEqual(plain(lead.rest), ['排队 1', '任务 3'], 'the run in view is not counted again');
  const queued = X.line(X.activity(activity({ items: [{ id: 'q', kind: 'queued', label: '你的消息在排队', catId: 'cat-a' }, { id: 'r', kind: 'running', label: '宪宪正在处理', catId: 'cat-a' }] })), { writing: writing('cat-a') });
  assert.equal(queued.kind, 'queued', '排队中 stays');
  const failed = X.line(X.activity(activity({ items: [{ id: 'f', kind: 'failure', label: '这次没完成', catId: 'cat-a' }, { id: 'r', kind: 'running', label: '宪宪正在处理', catId: 'cat-a' }], counts: { failure: 1, running: 1 } })), { writing: writing('cat-a') });
  assert.deepEqual([failed.kind, plain(failed.rest)], ['failure', []]);
  // Work the server counts but does not list keeps its count.
  const unlisted = X.line(X.activity(activity({ items: [{ id: 'r', kind: 'running', label: '宪宪正在处理', catId: 'cat-a' }], counts: { running: 2 } })), { writing: writing('cat-a') });
  assert.equal(unlisted.lead, '在处理');
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
test('review r15: one failure keeps the words that say it failed whole — the cat\'s name may shrink, 「这次没完成」 is its own bold part, the reason follows in regular weight; two failures stay counted', async () => {
  const X = rules();
  const NAME = '一只名字有二十个字那么长的橘色大猫咪呀呀';
  assert.equal([...NAME].length, 20);
  const one = (label: string, catName = NAME) => X.line(X.activity(activity({ items: [{ id: 'f', kind: 'failure', label, catId: 'cat-f', catName }], counts: { failure: 1 } })));
  const plainFail = one(NAME + '这次没完成');
  assert.deepEqual([plainFail.who, plainFail.lead, plainFail.label], [NAME, '这次没完成', '']);
  const reason = '模型返回了 401：登录已经过期，请在终端里重新登录以后再试一次，'.repeat(4);
  const withReason = one(NAME + '这次没完成：' + reason);
  assert.deepEqual([withReason.who, withReason.lead, withReason.label], [NAME, '这次没完成', reason.trim()], 'split at the first 「：」 only');
  // Without the cat's name at the start, the words before 「：」 are what is said.
  assert.deepEqual(plain(X.failureParts('执行失败：超时', '团子')), { who: '', what: '执行失败', reason: '超时' });
  const two = X.line(X.activity(activity({ items: [{ id: 'f', kind: 'failure', label: NAME + '这次没完成', catName: NAME }, { id: 'g', kind: 'failure', label: '砚砚这次没完成', catName: '砚砚' }], counts: { failure: 2 } })));
  assert.deepEqual([two.lead, two.who], ['2 项失败', ''], 'two or more are counted as before');
  // Drawn: the name and 「这次没完成」 in a pair whose second column is never narrower than its words; the reason in regular weight.
  const p = page(path => (path.endsWith('/activity') ? activity({ items: [{ id: 'f', kind: 'failure', label: NAME + '这次没完成：' + reason, catId: 'cat-f', catName: NAME, messageId: 'm-f' }], counts: { failure: 1 } }) : {}));
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  const row = p.strip().querySelector('.cx-row')!;
  const pair = row.querySelector('.cx-said-fail')!;
  assert.deepEqual(pair.children.map(c => [c.tagName, c.className, c.textContent]), [['B', 'cx-lead cx-who', NAME], ['B', 'cx-lead cx-what', '这次没完成']]);
  const label = row.querySelector('.cx-label')!;
  assert.equal(label.tagName, 'SPAN', 'the reason is not bold');
  assert.equal(label.textContent, reason.trim());
  assert.match(row.getAttribute('aria-label')!, new RegExp('^' + NAME + '这次没完成，模型返回了 401'));
  const css = read('client/public/chat-experience.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.cx-row \.cx-said-fail \{ display: inline-grid; grid-template-columns: minmax\(0, auto\) max-content; align-items: center; \}/);
  assert.match(css, /\.cx-row \.cx-said-fail > \.cx-what \{ max-width: none; overflow: visible; \}/);
  assert.match(css, /\.cx-row\[data-kind="failure"\] \.cx-label \{ flex: 1 1 0; \}/);
});

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
  // Item 46: no pointer to a 「任务」 page, which is gone (tasks live under 资料 › 高级).
  assert.match(textOf(list), /另有 1 项没有列出。/, 'a count beyond the list is never dropped');
  assert.doesNotMatch(textOf(list), /「任务」页/);
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

// 确认与提醒 (chat-cards.js answers a request on its own card in the history).
test('with request cards in the chat, 去确认 goes to the card, and only falls back to the runtime panel when the card is not drawn; the label is the server\'s own words', async () => {
  const found: Any[] = [];
  const p = page(path => (path.endsWith('/activity') ? busy() : {}), {
    confirm: (item: Any) => { found.push(item.proposalId); return item.proposalId === 'p1'; },
  });
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(textOf(p.strip().querySelector('.cx-row')!), '2 项等你确认宪宪想运行 npm publish· 处理中 1 · 排队 1 · 任务 3');
  p.strip().querySelector('.cx-row')!.click();
  const items = p.strip().querySelectorAll('.cx-item');
  // One action per request: 去确认 (the card answers it), no separate 查看.
  assert.equal(buttons(items[0], '查看').length, 0);
  const go = (k: number) => all(items[k]).find(e => e.tagName === 'A')!;
  assert.deepEqual([textOf(go(0)), go(0).href, go(0).target, go(0).getAttribute('aria-label')], ['去确认', '/runtime.html', '_blank', '去确认：宪宪想运行 npm publish']);
  const inHistory = new Ev('click');
  go(0).dispatchEvent(inHistory);
  assert.equal(inHistory.defaultPrevented, true, 'the card is in the history: no new tab');
  const elsewhere = new Ev('click');
  go(1).dispatchEvent(elsewhere);
  assert.equal(elsewhere.defaultPrevented, false, 'not drawn (an earlier page, or not loaded): the runtime panel opens');
  assert.deepEqual(found, ['p1', 'p2']);
  assert.deepEqual(p.posts(), [], 'the line itself answers nothing');
});

// Item 59: a card further back than the history drawn is looked for on earlier pages (chat-cards.js locate, a promise).
test('去确认 for a card that is not drawn looks further back: found, nothing more is said; not found, the line says so and offers the runtime panel; a lookup superseded, given way or left behind says nothing', async () => {
  let pending: Array<ReturnType<typeof deferred<Any>>> = [];
  const p = page(path => (path.endsWith('/activity') ? busy() : {}), {
    confirm: (item: Any) => {
      if (item.proposalId === 'p1') return true;
      const d = deferred<Any>();
      pending.push(d);
      return d.promise;
    },
  });
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  p.strip().querySelector('.cx-row')!.click();
  const go = () => all(p.strip().querySelectorAll('.cx-item')[1]).find(e => e.tagName === 'A')!;
  const said = () => p.strip().querySelector('.cx-said');
  const looking = new Ev('click');
  go().dispatchEvent(looking);
  assert.equal(looking.defaultPrevented, true, 'looked for further back: no new tab');
  assert.equal(said(), null, 'nothing said while it looks (its own note says it is looking)');
  pending[0].resolve(null);
  await settle();
  assert.equal(said()!.textContent, '当前显示的对话里没有找到这条确认的消息。可以在运行面板确认。 打开运行面板');
  assert.equal(said()!.getAttribute('role'), 'status');
  assert.deepEqual(all(said()!).filter(e => e.tagName === 'A').map(a => [a.textContent, a.href, a.target]), [['打开运行面板', '/runtime.html', '_blank']]);
  // Found the next time: what was said goes.
  go().dispatchEvent(new Ev('click'));
  pending[1].resolve(true);
  await settle();
  assert.equal(said(), null);
  // A failed lookup is not found either.
  go().dispatchEvent(new Ev('click'));
  pending[2].reject(new Error('lost'));
  await settle();
  assert.match(said()!.textContent, /没有找到这条确认的消息/);
  // A newer 去确认 ends the one before quietly: only the newest speaks.
  pending = [];
  go().dispatchEvent(new Ev('click'));
  pending[0].resolve(true);
  await settle();
  assert.equal(said(), null);
  pending = [];
  go().dispatchEvent(new Ev('click'));
  go().dispatchEvent(new Ev('click'));
  pending[0].resolve(null);
  await settle();
  assert.equal(said(), null, 'the superseded lookup says nothing');
  pending[1].resolve(null);
  await settle();
  assert.match(said()!.textContent, /没有找到这条确认的消息/, 'the newest one does');
  pending = [];
  go().dispatchEvent(new Ev('click'));
  pending[0].resolve(true);
  await settle();
  assert.equal(said(), null);
  // The card found in the history at once supersedes a lookup still on its way.
  pending = [];
  go().dispatchEvent(new Ev('click'));
  const inHistory = new Ev('click');
  all(p.strip().querySelectorAll('.cx-item')[0]).find(e => e.tagName === 'A')!.dispatchEvent(inHistory);
  assert.equal(inHistory.defaultPrevented, true);
  pending[0].resolve(null);
  await settle();
  assert.equal(said(), null);
  // A lookup that gave way to a card found elsewhere (a notification's) resolves undefined: nothing is said.
  pending = [];
  go().dispatchEvent(new Ev('click'));
  pending[0].resolve(undefined);
  await settle();
  assert.equal(said(), null);
  // Another conversation by the time it ends: nothing is said there.
  pending = [];
  go().dispatchEvent(new Ev('click'));
  p.cx.select(bob);
  p.cx.observe(bob, 'thread-A', true);
  await settle();
  pending[0].resolve(null);
  await settle();
  assert.doesNotMatch(textOf(p.strip()), /没有找到/);
  assert.deepEqual(p.posts(), [], 'the line itself answers nothing');
});

test('去确认 whose card is drawn and found at once takes down what an earlier 去确认 said it could not find', async () => {
  const pending: Array<ReturnType<typeof deferred<Any>>> = [];
  const p = page(path => (path.endsWith('/activity') ? busy() : {}), {
    confirm: (item: Any) => {
      if (item.proposalId === 'p1') return true;
      const d = deferred<Any>();
      pending.push(d);
      return d.promise;
    },
  });
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  p.strip().querySelector('.cx-row')!.click();
  const go = (k: number) => all(p.strip().querySelectorAll('.cx-item')[k]).find(e => e.tagName === 'A')!;
  const said = () => p.strip().querySelector('.cx-said');
  // The card of the second request is not found on any page: said, with the runtime panel.
  go(1).dispatchEvent(new Ev('click'));
  pending[0].resolve(null);
  await settle();
  assert.match(said()!.textContent, /没有找到这条确认的消息/);
  // The first request's card is drawn: found at once, and that sentence goes with it.
  const open = p.strip().querySelectorAll('.cx-item').length;
  const inHistory = new Ev('click');
  go(0).dispatchEvent(inHistory);
  assert.equal(inHistory.defaultPrevented, true);
  assert.equal(said(), null);
  assert.equal(p.strip().querySelectorAll('.cx-item').length, open, 'the list stays open');
  // Nothing said before: found at once changes nothing else.
  go(0).dispatchEvent(new Ev('click'));
  assert.equal(said(), null);
  assert.deepEqual(p.posts(), [], 'the line itself answers nothing');
});

test('the last successful activity read is handed on with when it was asked for, for this conversation only; after a failed read there is none (chat-live.js ends a missed reply only on a fresh read)', async () => {
  let mode = 'ok';
  const p = page(path => {
    if (!path.endsWith('/activity')) return {};
    if (mode === 'down') throw failure(0, '连不上 clowder-bot');
    return activity();
  });
  assert.equal(p.cx.activityRead(), null);
  p.cx.select(ada);
  const before = Date.now();
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  const seen = p.cx.activityRead();
  assert.equal(seen.key, 'bot:Ada');
  assert.equal(seen.threadId, 'thread-A');
  assert.equal(seen.activity.threadId, 'thread-A');
  assert.ok(seen.askedAt >= before && seen.askedAt <= Date.now(), 'when the read was asked for');
  mode = 'down';
  p.cx.touch();
  p.cx.observe(ada, 'thread-A', false);
  await settle();
  assert.equal(p.cx.activityRead(), null, 'a failed read hands on nothing: what runs is not known');
  p.cx.select(bob);
  assert.equal(p.cx.activityRead(), null);
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

test('F338: a chat gone cold since its last reply shows one quiet hint, not a control (no row button, no chevron, no list), only when nothing else is to be said; warm or not said shows nothing; anything more urgent keeps the line', async () => {
  const X = rules();
  // The server's word, checked: only warm or expired; anything else is not said.
  assert.equal(X.activity(activity({ warmth: 'expired' })).warmth, 'expired');
  assert.equal(X.activity(activity({ warmth: 'warm' })).warmth, 'warm');
  for (const other of ['unknown', 'cold', 1, null]) assert.equal(X.activity(activity({ warmth: other })).warmth, '', String(other));
  assert.equal(X.activity(activity()).warmth, '');
  const cold = (over: Record<string, unknown> = {}) => X.activity(activity({ warmth: 'expired', ...over }));
  assert.deepEqual(plain(X.line(cold())), { kind: 'warmth', lead: '隔了一阵，下一句可能慢一点', label: '', rest: [], partial: false, catId: '', catName: '', expandable: false });
  assert.equal(X.line(X.activity(activity({ warmth: 'warm' }))), null, 'warm: nothing to say');
  assert.equal(X.line(X.activity(activity())), null, 'not said: nothing to say');
  // Never in place of anything more urgent or less certain.
  assert.equal(X.line(X.activity({ ...busy(), warmth: 'expired' })).kind, 'approval');
  assert.equal(X.line(cold({ items: [{ id: 'f', kind: 'failure', label: '执行失败' }], counts: { failure: 1 } })).kind, 'failure');
  assert.equal(X.line(cold({ items: [{ id: 'r', kind: 'running', label: '宪宪正在处理', catId: 'cat-a' }] })).kind, 'running');
  assert.equal(X.line(cold({ items: [{ id: 'q', kind: 'queued', label: '你的消息在排队' }] })).kind, 'queued');
  assert.equal(X.line(cold({ items: [{ id: 't', kind: 'task', label: '写周报' }] })).kind, 'task');
  assert.equal(X.line(cold({ unread: 2, latestMessageId: 'm9' }), { showUnread: true }).kind, 'reply');
  assert.equal(X.line(cold({ unread: 2, latestMessageId: 'm9' })), null, 'an unread reply in sight: nothing yet');
  assert.equal(X.line(cold({ unread: 0, unreadHasMore: true })), null);
  assert.equal(X.line(cold({ readStatus: 'partial' })).kind, 'unknown');
  assert.equal(X.line(cold(), { failed: true }).kind, 'unknown');
  assert.equal(X.line(cold(), { writing: new Set(['cat-a']) }), null, 'a cat drawn writing: not said');
  assert.equal(X.line(cold({ items: [{ id: 'r', kind: 'running', label: '宪宪正在处理', catId: 'cat-a' }] }), { writing: new Set(['cat-a']) }), null, 'the run in view hides its line, and the hint with it');

  // On the page: in the line's place, quiet, and nothing to press or open.
  let answer: Any = activity({ warmth: 'expired' });
  const p = page(path => { if (!path.endsWith('/activity')) return {}; if (answer instanceof Error) throw answer; return answer; });
  p.cx.select(ada);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  const strip = p.strip();
  assert.equal(strip.hidden, false);
  assert.ok(p.dock.classList.contains('cx-on'));
  const hint = strip.querySelector('.cx-warmth')!;
  assert.ok(hint, 'the hint is drawn');
  assert.deepEqual([hint.tagName, hint.getAttribute('role'), textOf(hint), hint.querySelector('svg')!.dataset.icon], ['DIV', 'status', '隔了一阵，下一句可能慢一点', 'clock']);
  assert.equal(all(strip).filter(e => e.tagName === 'BUTTON').length, 0, 'not a control');
  for (const sel of ['.cx-row', '.cx-chev', '.cx-list', '[aria-expanded]', '[aria-controls]']) assert.equal(strip.querySelector(sel), null, sel);
  // Escape has nothing to fold.
  strip.dispatchEvent(new Ev('keydown', { key: 'Escape' }));
  assert.equal(strip.querySelector('.cx-list'), null);
  assert.deepEqual(p.posts(), [], 'nothing is sent');
  // Something waits for the owner: the line takes its place, and opens as before.
  answer = { ...busy(), warmth: 'expired' };
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(p.strip().querySelector('.cx-warmth'), null);
  const row = p.strip().querySelector('.cx-row')!;
  assert.match(textOf(row), /^2 项等你确认/);
  row.click();
  assert.ok(p.strip().querySelector('.cx-list'));
  // Nothing again, gone cold: the hint, and the list the owner opened does not stay open behind it.
  answer = activity({ warmth: 'expired' });
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.ok(p.strip().querySelector('.cx-warmth'));
  assert.equal(p.strip().querySelector('.cx-list'), null);
  answer = busy();
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(p.strip().querySelector('.cx-row')!.getAttribute('aria-expanded'), 'false', 'the hint opened nothing that comes back');
  // Warm, or not said: nothing.
  answer = activity({ warmth: 'warm' });
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(p.strip().hidden, true);
  answer = activity();
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(p.strip().hidden, true);
  // A refresh that fails after a cold read cannot tell: not the hint, which was the last read's.
  answer = activity({ warmth: 'expired' });
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.ok(p.strip().querySelector('.cx-warmth'));
  answer = failure(0, '连不上 clowder-bot');
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(p.strip().querySelector('.cx-warmth'), null);
  assert.match(textOf(p.strip().querySelector('.cx-row')!), /^暂时无法确认状态/);
  // Another conversation: what this one said is not carried over.
  answer = activity({ threadId: 'thread-B' });
  p.cx.select(bob);
  p.cx.observe(bob, 'thread-B', true);
  await settle();
  assert.equal(p.strip().hidden, true);
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

test('a reply drawn below the newest although it came first (under a follow-up it took in) has to have been in sight before the newest is confirmed read, since the read position covers it (round 10 review item 1)', async () => {
  // The engine's order is question, A, B, follow-up; A took the follow-up in, so the chat draws question, B, follow-up, A
  // (chat-live-rules.js order()), and B is the newest reply the activity names. What app.js hands over: displaced() on what it drew.
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-live-rules.js'), { window });
  const L = window.ClowderLiveRules;
  const rows = [{ id: 'q', kind: 'person' }, { id: 'A', kind: 'bot', follows: 'f' }, { id: 'B', kind: 'bot' }, { id: 'f', kind: 'person' }];
  const drawn = { messages: rows, order: L.order(rows, true), group: true };
  let asked: string[] = [];
  const route = (path: string, method: string, body: Any) => {
    if (path.endsWith('/activity')) return activity({ unread: 2, latestMessageId: 'B' });
    if (path.endsWith('/read') && method === 'POST') return { threadId: body.expectedThreadId, readMessageId: body.messageId };
    return {};
  };
  const p = page(route, { displacedBefore: (id: string) => { asked.push(id); return L.displaced(drawn, id); } });
  p.cx.select(ada);
  const b = p.row('B', 100), a = p.row('A', 900);
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(2000);
  assert.deepEqual(p.posts(), [], 'B is in sight, but A (below the view) is not: confirming B would mark A read');
  assert.ok(asked.includes('B'));
  // The owner scrolls down to A (B leaves the view): still nothing, B is not in sight now.
  a.rect = { top: 300, bottom: 340 }; b.rect = { top: -200, bottom: -160 };
  p.thread.dispatchEvent(new Ev('scroll'));
  await p.advance(300); await p.advance(1000);
  assert.deepEqual(p.posts(), []);
  // Back up to B: A has been seen, so B is confirmed (and with it A, as the server's position is cumulative).
  a.rect = { top: 900, bottom: 940 }; b.rect = { top: 100, bottom: 140 };
  p.thread.dispatchEvent(new Ev('scroll'));
  await p.advance(300); await p.advance(1000);
  assert.deepEqual(p.posts(), [{ path: '/xbot-api/bots/Ada/read', method: 'POST', body: { expectedThreadId: 'thread-A', messageId: 'B' } }]);

  // Both in sight at once: confirmed straight away. A displaced reply that is not drawn at all has nothing to be seen and does not hold it up.
  asked = [];
  const q = page(route, { displacedBefore: () => ['A', 'not-drawn'] });
  q.cx.select(ada);
  q.row('B', 100); q.row('A', 200);
  q.cx.observe(ada, 'thread-A', true);
  await settle();
  await q.advance(2000);
  assert.deepEqual(q.posts().map((c: Any) => c.body.messageId), ['B']);
  // Nothing moved (no hook, or nothing displaced): the same as before.
  const r = page(route);
  r.cx.select(ada);
  r.row('B', 100); r.row('A', 900);
  r.cx.observe(ada, 'thread-A', true);
  await settle();
  await r.advance(2000);
  assert.deepEqual(r.posts().map((c: Any) => c.body.messageId), ['B']);
});

test('item 49 (review 1, items 2–4): the newest reply being a cat\'s reaction, its own row in sight is not enough — the newest row of a cat\'s must be in sight, seen here or confirmed; by the history\'s order, each piece of evidence its own', async () => {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-live-rules.js') + read('client/public/chat-reactions-rules.js'), { window });
  const R = window.ClowderReactionRules, L = window.ClowderLiveRules;
  // u (the owner's 谢谢) carries the cat's 🐾 rx, the newest reply; B is the newest row of a cat's, drawn below.
  // B's time claims to be later than the reaction's, A's earlier: times play no part.
  const rows = [
    { id: 'A', role: 'assistant', content: '好的', native: { type: 'assistant', catId: 'c' }, time: '2026-11-13T10:00:00Z' },
    { id: 'u', role: 'user', time: '2026-11-13T10:00:01Z', reactions: [{ id: 'rx', emoji: '🐾', mine: false, native_cat_id: 'c', time: '2026-11-13T10:00:02Z' }] },
    { id: 'B', role: 'assistant', content: '整理好了', native: { type: 'assistant', catId: 'c' }, time: '2026-11-13T11:00:00Z' },
  ];
  // The hook as app.js builds it: displaced rows, and for a reaction the newest row of a cat's with its own displaced rows.
  const hook = (list: Any[]) => (id: string) => {
    const drawn = { messages: list, order: list.map((_: Any, i: number) => i), group: false };
    const row = R.readFirst(list, id);
    return [...L.displaced(drawn, id), ...row, ...row.flatMap((r: string) => L.displaced(drawn, r))];
  };
  const route = (latest: string) => (path: string, method: string, body: Any) => {
    if (path.endsWith('/activity')) return activity({ unread: 2, latestMessageId: latest });
    if (path.endsWith('/read') && method === 'POST') return { threadId: body.expectedThreadId, readMessageId: body.messageId };
    return {};
  };
  // Parked above on 谢谢: its row is in sight, B below is not — nothing is confirmed.
  const p = page(route('rx'), { displacedBefore: hook(rows) });
  p.cx.select(ada);
  p.row('A', -300);
  const host = p.row('u', 100), b = p.row('B', 900);
  host.dataset.rx = 'rx';
  p.cx.observe(ada, 'thread-A', true);
  await settle();
  await p.advance(2000);
  assert.deepEqual(p.posts(), [], 'the reaction\'s row alone does not confirm the replies below it');
  // Down to B (谢谢 out of sight): B is seen, but the reaction's own row is not in sight now.
  b.rect = { top: 300, bottom: 340 }; host.rect = { top: -200, bottom: -160 };
  p.thread.dispatchEvent(new Ev('scroll'));
  await p.advance(300); await p.advance(1000);
  assert.deepEqual(p.posts(), []);
  // 谢谢 in sight again, B seen on this page: confirmed, by the reaction's own ID.
  host.rect = { top: 100, bottom: 140 };
  p.thread.dispatchEvent(new Ev('scroll'));
  await p.advance(300); await p.advance(1000);
  assert.deepEqual(p.posts(), [{ path: '/xbot-api/bots/Ada/read', method: 'POST', body: { expectedThreadId: 'thread-A', messageId: 'rx' } }]);
  // No row of a cat's at all: the reaction's row decides alone.
  const only = [{ id: 'u', role: 'user', time: 'x', reactions: [{ id: 'rx', emoji: '🐾', mine: false, native_cat_id: 'c', time: 'y' }] }];
  const q = page(route('rx'), { displacedBefore: hook(only) });
  q.cx.select(ada);
  q.row('u', 100).dataset.rx = 'rx';
  q.cx.observe(ada, 'thread-A', true);
  await settle();
  await q.advance(2000);
  assert.deepEqual(q.posts().map((c: Any) => c.body.messageId), ['rx']);
  // Review 2, item 12: the newest row of a cat's is a reply that failed (it counts, as the server counts it), below
  // the view: the reaction on 谢谢 above waits for it too.
  const failed = [...rows, { id: 'F', role: 'assistant', content: '这次没完成', ended: { how: 'failed' }, native: { type: 'assistant', catId: 'c' }, time: 't' }];
  const f = page(route('rx'), { displacedBefore: hook(failed) });
  f.cx.select(ada);
  f.row('A', -300); f.row('B', -100);
  const fh = f.row('u', 100), ff = f.row('F', 900);
  fh.dataset.rx = 'rx';
  f.cx.observe(ada, 'thread-A', true);
  await settle();
  await f.advance(2000);
  assert.deepEqual(f.posts(), [], 'the failed reply below the view is not confirmed with the reaction above');
  ff.rect = { top: 300, bottom: 340 };
  f.thread.dispatchEvent(new Ev('scroll'));
  await f.advance(300); await f.advance(1000);
  assert.deepEqual(f.posts().map((c: Any) => c.body.messageId), ['rx'], 'both in sight: confirmed');
  // The reaction on a cat's own row that was confirmed before: that row being confirmed does not stand in for the
  // reaction's row being in sight now (its own evidence), but it does count for the newest row of a cat's, which it is.
  const mine = [{ id: 'H', role: 'assistant', content: '要我开始吗？', native: { type: 'assistant', catId: 'c' }, time: 't', reactions: [{ id: 'x', emoji: '👍', mine: true }, { id: 'ry', emoji: '🐾', mine: false, native_cat_id: 'c' }] }];
  let latest = 'H';
  const r = page((path: string, method: string, body: Any) => (path.endsWith('/activity') ? activity({ unread: 1, latestMessageId: latest }) : route(latest)(path, method, body)), { displacedBefore: hook(mine) });
  r.cx.select(ada);
  const h = r.row('H', 100);
  r.cx.observe(ada, 'thread-A', true);
  await settle();
  await r.advance(2000);
  assert.deepEqual(r.posts().map((c: Any) => c.body.messageId), ['H']);
  // The cat answers your 👍 with 🐾 on H while H is out of sight.
  latest = 'ry'; h.dataset.rx = 'x ry'; h.rect = { top: -400, bottom: -360 };
  r.cx.observe(ada, 'thread-A', true);
  await settle();
  await r.advance(2000);
  assert.deepEqual(r.posts().map((c: Any) => c.body.messageId), ['H'], 'H confirmed earlier is not the reaction seen');
  h.rect = { top: 100, bottom: 140 };
  r.thread.dispatchEvent(new Ev('scroll'));
  await r.advance(300); await r.advance(1000);
  assert.deepEqual(r.posts().map((c: Any) => c.body.messageId), ['H', 'ry']);
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
  refuse = (id: string) => { if (id === 'm-C') throw failure(409, '对话已变化，请刷新后重试'); return null; };
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
  late.reject(failure(409, '对话已变化，请刷新后重试'));
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
  // The conversation's notes stay, read only and named for their reach (the heading; item 46: no sentence saying it again).
  assert.equal(textOf(p.root.querySelector('.cx-notes')!), '这个对话的便笺 · 1周五前交');
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
  // Item 46: none is the count, · 0, and nothing else — only after a read that worked (a failure says so instead).
  assert.equal(textOf(sec), '这个对话的便笺 · 0', 'empty only after a read that worked');
  // The drawer's own notes are shown as they are, read only.
  p.cx.memoryView(ada, { name: 'Ada', memory: [{ id: 'note-1', scope: 'conversation', text: '周五前交' }, { id: 'note-2', scope: 'conversation', text: '用中文\n简短' }] });
  assert.equal(textOf(sec), '这个对话的便笺 · 2周五前交用中文\n简短');
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

// ---------------------------------------------------------------- sidebar rows
// app.js's own row, status-line and selection functions with the real rules,
// on a 390px window; what opening a chat loads is faked (selectBot/selectGroup).
function sidebar() {
  const app = read('client/public/app.js');
  const take = (name: string) => {
    const m = new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
    assert.ok(m, name + ' is where the shell keeps it');
    return m[0];
  };
  const unreadOf = /\n {2}const unreadOf = [^\n]+\n/.exec(app)!;
  const doc = new Doc();
  const h = (tag: string, id = '') => { const e = doc.createElement(tag); if (id) e.id = id; return e; };
  const side = h('aside'), backdrop = h('div');
  side.append(h('div', 'pin-row'), h('div', 'roster'));
  doc.body.append(side, backdrop, h('div', 'panel-scrim'));
  const picked: string[] = [];
  const state: Any = { bots: [], groups: [], folders: [], others: null, sel: null, peer: null, preview: {}, listSig: '' };
  const stStatus: Any = { map: {}, groups: {} };
  const out: Any = {};
  const code = ['el', 'spinIcon', 'workText', 'stDesc', 'attentionLine', 'groupDesc', 'paintStatus', 'railTip', 'clipTip', 'listButton', 'sectionLabel', 'botRow', 'renderLists', 'pickBot', 'pickGroup', 'closeDrawer', 'syncBackdrop'].map(take).join('');
  vm.runInNewContext(code + unreadOf[0] + 'out.renderLists = renderLists; out.paintStatus = paintStatus;', {
    out, state, stStatus, Node: El, experienceRules: rules(),
    document: { createElement: (tag: string) => doc.createElement(tag), querySelectorAll: (sel: string) => doc.body.querySelectorAll(sel) },
    window: { innerWidth: 390 }, sidebar: side, backdrop, panel: h('div'), thread: { querySelector: () => null },
    $: (id: string) => doc.getElementById(id),
    rawSvg: () => h('svg'), icon: () => h('svg'), avatar: () => { const a = h('span'); a.className = 'avatar'; a.append(h('svg')); return a; },
    paintOfBot: () => null, primaryMark: () => h('i'), setTip: () => {}, niceName: String, realPreview: (t: unknown) => (t ? String(t) : ''),
    lineForBot: (b: Any) => b.description || '没有消息', lineForGroup: (g: Any) => g.members.join(' · '),
    folderStore: () => ({}), groupFace: (g: Any) => ({ sig: g.id }), sectionLabel: () => h('div'),
    paintRailStatus: () => {}, sortStatusRows: () => {}, setWorking: () => {},
    // chat-list.js's line (latest line or draft) is covered by tests/chat-list.test.ts.
    chatList: { preview: () => null },
    selectBot: (name: string) => { picked.push('bot:' + name); }, selectGroup: (id: string) => { picked.push('group:' + id); },
  });
  // What refreshStatus does with GET /xbot-api/bots/status.
  const status = (bots: Any[] = [], groups: Any[] = []) => {
    stStatus.map = Object.fromEntries(bots.map(b => [b.bot, b]));
    stStatus.groups = Object.fromEntries(groups.map(g => [g.id, g]));
    out.renderLists();
    out.paintStatus();
  };
  const find = (sel: string) => { const r = doc.body.querySelector(sel); assert.ok(r, 'no row ' + sel); return r; };
  return { state, picked, status, find, side, backdrop };
}

test('a sidebar row is one target: a click on its status line (busy, queued, waiting for the owner) reaches the row, a repaint swaps only the line, and the chat already open only closes the narrow list', () => {
  const s = sidebar();
  const CAT = '.item[data-bot="宪宪"]', GROUP = '.item[data-group="g-1"]', PIN = '.pin[data-bot="主猫"]';
  s.state.bots = [{ name: '宪宪', description: '会写代码' }, { name: '主猫', pinned: true }];
  s.state.groups = [{ id: 'g-1', name: '设计组', members: ['宪宪', '主猫'] }];
  s.state.sel = { type: 'bot', id: '主猫' };
  s.status();
  const rows = [s.find(CAT), s.find(GROUP)];
  const line = (sel: string) => s.find(sel).querySelector('.preview')!;
  const words = (sel: string) => line(sel).children.at(-1)!;
  const steps: Array<[string, Record<string, number>, RegExp]> = [['running', { running: 1 }, /在处理/], ['queued', { queued: 1 }, /等待执行/], ['awaiting', { approval: 2 }, /2 项等你确认/]];
  for (const [kind, counts, said] of steps) {
    const before = [line(CAT), line(GROUP)];
    s.status([{ bot: '宪宪', state: kind, tool: 'Bash', tool_summary: '', todo: '', activity: activity({ counts }) }], [{ id: 'g-1', thread_id: 'thread-G', activity: activity({ counts }) }]);
    [CAT, GROUP].forEach((sel, i) => {
      same(s.find(sel), rows[i], kind + ': the row is repainted in place');
      assert.notEqual(line(sel), before[i], kind + ': its status line is replaced');
      assert.match(textOf(line(sel)), said, kind);
      words(sel).click();
    });
  }
  assert.deepEqual(s.picked, Array(3).fill(['bot:宪宪', 'group:g-1']).flat(), 'each click opens that chat, never anything of its own');
  // Tapping the chat already open, a busy cat, a group or a pinned cat, with the list open over it.
  s.picked.length = 0;
  const open: Array<[Any, string, () => El]> = [[{ type: 'bot', id: '宪宪' }, CAT, () => words(CAT)], [{ type: 'group', id: 'g-1' }, GROUP, () => words(GROUP)], [{ type: 'bot', id: '主猫' }, PIN, () => s.find(PIN).querySelector('.avatar')!]];
  for (const [sel, row, target] of open) {
    s.state.sel = sel;
    s.status([{ bot: '宪宪', state: 'running', activity: activity({ counts: { running: 1 } }) }], [{ id: 'g-1', activity: activity({ counts: { running: 1 } }) }]);
    s.side.classList.add('open');
    s.backdrop.hidden = false;
    target().click();
    assert.equal(s.side.classList.contains('open'), false, row + ': the list closes onto the chat');
    assert.equal(s.backdrop.hidden, true, row);
  }
  assert.deepEqual(s.picked, [], 'nothing is selected again, so its draft, live reply and pending sends stay');
  // From another person's chat, the same row comes back to this one.
  s.state.peer = { slug: 'other' };
  s.find(PIN).click();
  assert.deepEqual(s.picked, ['bot:主猫']);
});

test('item 46: the list says no more than the layout cannot — the groups follow the cats after a gap with 群聊 for a screen reader only, and a row\'s name is a tooltip only in the rail', () => {
  const s = sidebar();
  s.state.bots = [{ name: '宪宪', description: '会写代码' }, { name: '主猫', pinned: true }];
  s.state.groups = [{ id: 'g-1', name: '设计组', members: ['宪宪', '主猫'] }];
  s.status();
  const gap = s.find('.group-label');
  assert.ok(gap.classList.contains('cl-gap'), 'a gap where the heading was');
  const word = gap.querySelector('.label')!;
  assert.equal(word.textContent, '群聊');
  assert.ok(word.classList.contains('visually-hidden'), 'the word is there for a screen reader, not on screen');
  for (const sel of ['.item[data-bot="宪宪"]', '.item[data-group="g-1"]']) {
    const row = s.find(sel);
    assert.equal(row.dataset.tipOnly, 'rail', sel + ': the name beside the face is not repeated as a tooltip in the full sidebar');
    assert.equal(row.querySelector('.avatar')!.dataset.tipOnly, 'rail', sel + ': nor on its face');
    // Review r15: the printed name keeps its full name, shown only while it is cut short (measured at hover).
    const printed = row.querySelector('.name')!;
    assert.deepEqual([printed.dataset.tip, printed.dataset.tipOnly], [printed.textContent, 'clipped'], sel);
  }
  // No groups, no gap.
  s.state.groups = [];
  s.status();
  assert.equal(s.side.querySelector('.group-label'), null);
});

test('review r15: a printed name shows its full name on hover only while it is cut short — a long name gets the tooltip, a short one does not; a name in the rail keeps its own', () => {
  const app = read('client/public/app.js');
  const take = (name: string) => new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app)![0];
  const tip: Any = { hidden: true, textContent: '', style: {}, offsetWidth: 80, offsetHeight: 20 };
  const out: Any = {};
  vm.runInNewContext(take('hideTip') + take('placeTip') + 'out.place = placeTip;', {
    out, tipEl: tip, tipTimer: 0, tipHost: null, $: () => null, window: { innerWidth: 1440, innerHeight: 900, clearTimeout() {} },
  });
  const host = (text: string, scrollWidth: number, clientWidth: number, only = 'clipped', rail = false): Any => ({
    dataset: { tip: text, tipOnly: only }, scrollWidth, clientWidth,
    getAttribute: (k: string) => (k === 'data-tip' ? text : null),
    closest: (sel: string) => (rail && sel === '.sidebar.rail' ? {} : null),
    getBoundingClientRect: () => ({ left: 20, right: 80, top: 100, bottom: 116, width: 60, height: 16 }),
  });
  out.place(host('喵喵喵喵喵喵喵喵喵喵大橘猫', 168, 60));
  assert.deepEqual([tip.hidden, tip.textContent], [false, '喵喵喵喵喵喵喵喵喵喵大橘猫'], 'cut short: the full name');
  out.place(host('宪宪', 28, 28));
  assert.equal(tip.hidden, true, 'printed in full: no tooltip repeating it');
  // A row's own tooltip stays rail-only, as in item 46.
  out.place(host('宪宪', 0, 0, 'rail', false));
  assert.equal(tip.hidden, true);
  out.place(host('宪宪', 0, 0, 'rail', true));
  assert.deepEqual([tip.hidden, tip.textContent], [false, '宪宪']);
  // Wired for the pinned cats too (their names have 60px).
  assert.match(app, /label\.append\(clipTip\(el\("span", "pin-label", niceName\(b\.name\)\), niceName\(b\.name\)\)\);/);
  assert.match(app, /if \(host\.dataset\.tipOnly === "clipped" && !\(host\.scrollWidth > host\.clientWidth\)\) \{ hideTip\(\); return; \}/);
});

// ---------------------------------------------------------------- wiring
test('the page loads the status-line scripts after workspace.js and before app.js; the shell wires select, observe, touch, rendered, the sidebar and 记忆, and keeps no false memory promise', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/chat-experience.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('workspace.js') < at('chat-experience-rules.js') && at('chat-experience-rules.js') < at('chat-experience.js') && at('chat-experience.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  // Only the 开箱即用 extension (quick-create.css), the search palette (palette.css), 找得到 (chat-list.css, chat-history.css), 资料页与群 (profile.css, mention.css) and the live-reply styles (chat-live.css, last) come after.
  assert.deepEqual(styles.slice(-15), ['chat-experience.css', 'quick-create.css', 'palette.css', 'chat-list.css', 'chat-history.css', 'profile.css', 'mention.css', 'polish.css', 'chat-cards.css', 'chat-presence.css', 'chat-reactions.css', 'sidebar.css', 'chat-panel.css', 'apps-dialog.css', 'chat-live.css']);
  // Conversation changes, reads, native events and redraws reach the module.
  assert.match(app, /workspace\.select\(state\.sel\);\n[^\n]*\n\s+experience\.select\(state\.sel\);/);
  assert.equal((app.match(/experience\.observe\(selection, /g) || []).length, 2, 'single chats and groups');
  assert.match(app, /experience\.touch\(\);/);
  assert.equal((app.match(/\n\s+experience\.rendered\(\);/g) || []).length, 4, 'both histories, drawn or empty');
  // And when a reply starts or ends (chat-live.js), so the line drops or brings back 「…正在处理」.
  assert.match(app, /changed: \(\) => \{ syncComposer\(\); paintWorkStatus\(\); experience\.rendered\(\); \},/);
  // History rows carry the native message ID (user, cat, group and reply-in-progress rows).
  assert.equal((app.match(/row\.dataset\.mid = /g) || []).length, 4);
  // The sidebar: groups get a line and a dot; 等你确认 is acted on in the chat's status line, never by guessing a card.
  // A sidebar line is status only (see the sidebar rows test): it reads no steps and jumps nowhere.
  assert.match(app, /function groupDesc\(g\)/);
  assert.match(app, /unreadOf\(stStatus\.groups\[g\.id\]\)/);
  assert.doesNotMatch(app, /\/steps|experience\.attend\(|jumpToAttention/);
  assert.doesNotMatch(app, /jumpToApproval|querySelectorAll\("#thread \.approval"\)/);
  // 记忆 is the module's; the group's false promise and the old notes view are gone; no 子代理 headline.
  // A group's drawer (资料页与群, profile-rules.js) is 成员 and 文件: it has no 记忆 tab at all.
  assert.match(app, /if \(tab === "memory"\) body\.append\(experience\.memoryView\(state\.sel, data\)\);/);
  assert.match(read('client/public/profile-rules.js'), /group: Object\.freeze\(\[\["members", "成员"\], \["files", "文件"\]\]\)/);
  assert.doesNotMatch(app, /对它说「记住|function libraryView|个子代理/);
  // Reads are confirmed only by the module.
  assert.doesNotMatch(app, /"\/read"/);
  // Only existing tokens.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
