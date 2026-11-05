import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Files, saved conversations and chat Tasks in the chat shell. runtime-tasks.js,
// workspace-rules.js and workspace.js run here as the classic browser scripts
// they are, in a VM with a small DOM (tree, events with bubbling, focus that is
// lost when its element leaves the page, focusin/focusout, and the few
// selectors the module uses), against a fake /xbot-api. app.js is not loaded:
// its hooks are faked the way it passes them to init(), and a few static checks
// cover its wiring.
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
type Simple = { tag: string; ids: string[]; classes: string[]; attrs: Array<[string, string | null]>; nots: Simple[][]; disabled: boolean; lastOfType: boolean };
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
  const s: Simple = { tag: '', ids: [], classes: [], attrs: [], nots: [], disabled: false, lastOfType: false };
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
    else if (text.startsWith(':last-of-type', i)) { s.lastOfType = true; i += 13; }
    else throw new Error('unsupported selector ' + text);
  }
  return s;
}
function attrOf(el: El, name: string): string | null {
  const own = el.getAttribute(name);
  if (own != null) return own;
  const prop = (el as Any)[name];
  return typeof prop === 'string' && prop ? prop : null;
}
function hits(el: El, s: Simple): boolean {
  if (s.tag && el.tagName !== s.tag) return false;
  if (s.ids.some(id => el.id !== id)) return false;
  if (s.classes.some(c => !el.classList.contains(c))) return false;
  if (s.attrs.some(([k, v]) => { const got = attrOf(el, k); return v === null ? got == null : got !== v; })) return false;
  if (s.disabled && !el.disabled) return false;
  if (s.lastOfType && el.parent && el.parent.children.filter(c => c.tagName === el.tagName).at(-1) !== el) return false;
  return s.nots.every(list => !list.some(n => hits(el, n)));
}
const FOCUSABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);
class El extends Base {
  readonly tagName: string; kids: Base[] = []; attrs = new Map<string, string>(); listeners = new Map<string, Listener[]>();
  style: Record<string, string> = {}; hidden = false; disabled = false; value = ''; checked = false; open = false;
  html = ''; private tab: number | null = null;
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
  get tabIndex() { return this.tab ?? (FOCUSABLE.has(this.tagName) ? 0 : -1); }
  set tabIndex(value: number) { this.tab = Number(value); }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  get childNodes() { return this.kids; }
  get firstChild() { return this.kids[0] ?? null; }
  get lastChild() { return this.kids.at(-1) ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get childElementCount() { return this.children.length; }
  get nextElementSibling(): El | null { const p = this.parent; if (!p) return null; const list = p.children; return list[list.indexOf(this) + 1] ?? null; }
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
  replaceWith(...items: Array<Base | string>) {
    const p = this.parent;
    if (!p) return;
    let at = p.kids.indexOf(this);
    this.remove();
    for (const item of items) { const n = p.adopt(item); p.kids.splice(at++, 0, n); }
  }
  contains(n: unknown): boolean { for (let x = n as Base | null; x; x = x.parent) if (x === this) return true; return false; }
  addEventListener(type: string, fn: (ev: Ev) => unknown, opts?: boolean | { once?: boolean }) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: typeof opts === 'object' && !!opts.once });
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
  // As in a browser: the element losing focus hears focusout (naming where
  // focus went), the one gaining it hears focusin; both bubble.
  focus() {
    if (!this.isConnected || this.disabled) return;
    const was = this.doc.activeElement;
    if (was === this) return;
    if (was !== this.doc.body && was.isConnected) was.dispatchEvent(new Ev('focusout', { relatedTarget: this }));
    this.doc.activeElement = this;
    this.dispatchEvent(new Ev('focusin', { relatedTarget: was === this.doc.body ? null : was }));
  }
  blur() {
    if (this.doc.activeElement !== this) return;
    this.doc.activeElement = this.doc.body;
    this.dispatchEvent(new Ev('focusout', { relatedTarget: null }));
  }
  getClientRects() { for (let n: El | null = this; n; n = n.parent) if (n.hidden) return []; return this.isConnected ? [{}] : []; }
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 }; }
  get offsetWidth() { return 100; }
  get offsetHeight() { return 20; }
  scrollIntoView() { /* layout-free */ }
  matches(sel: string) { return splitTop(sel).map(compound).some(s => hits(this, s)); }
  closest(sel: string): El | null { for (let n: El | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel: string): El[] { const list = splitTop(sel).map(compound); return all(this).filter(e => list.some(s => hits(e, s))); }
  querySelector(sel: string): El | null { return this.querySelectorAll(sel)[0] ?? null; }
}
const all = (root: El): El[] => root.children.flatMap(c => [c, ...all(c)]);
class Doc {
  body: El; activeElement: El; listeners = new Map<string, Listener[]>();
  constructor() { this.body = new El(this, 'body'); this.activeElement = this.body; }
  createElement(tag: string) { return new El(this, tag); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag); }
  createTextNode(text: string) { return new TextNode(this, text); }
  getElementById(id: string) { return all(this.body).find(e => e.id === id) ?? null; }
  querySelector(sel: string) { return this.body.querySelector(sel); }
  addEventListener(type: string, fn: (ev: Ev) => unknown) { const list = this.listeners.get(type) ?? []; list.push({ fn, once: false }); this.listeners.set(type, list); }
  // As in a browser: a focused element that leaves the page drops focus to the body, without events.
  lost(n: Base) { if (n instanceof El && n.contains(this.activeElement)) this.activeElement = this.body; }
  dispatch(target: El, ev: Ev) {
    ev.target = target;
    const run = (host: El | Doc, list: Listener[] | undefined) => {
      const handler = host instanceof El ? host['on' + ev.type] : null;
      const queue = [...(list ?? []), ...(typeof handler === 'function' ? [{ fn: handler as (e: Ev) => unknown, once: false }] : [])];
      for (const l of queue) {
        if (ev.halted) return;
        ev.currentTarget = host;
        if (l.once && host instanceof El) host.listeners.set(ev.type, (host.listeners.get(ev.type) ?? []).filter(x => x !== l));
        l.fn(ev);
      }
    };
    for (let n: El | null = target; n && !ev.stopped; n = n.parent) run(n, n.listeners.get(ev.type));
    if (!ev.stopped) run(this, this.listeners.get(ev.type));
    return !ev.defaultPrevented;
  }
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
function page(route: Route, fetchRoute: (path: string, opt: Any) => unknown = () => { throw new Error('no fetch'); }, hooks: Record<string, unknown> = {}) {
  const doc = new Doc();
  const h = (tag: string, props: Record<string, unknown> = {}, ...kids: Array<El | string>) => {
    const e = doc.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  };
  const headChip = h('button', { id: 'head-chip', className: 'top-title' });
  const composer = h('form', { id: 'composer', className: 'composer' },
    h('div', { id: 'attach-bar', className: 'attach-row', hidden: true }, h('div', { id: 'attach-list', className: 'attach-list' }), h('p', { id: 'attach-note', className: 'attach-note', hidden: true })),
    h('div', { id: 'input', className: 'composer-input' }));
  const panel = h('aside', { id: 'panel', className: 'panel open' });
  const main = h('main', { className: 'main' },
    h('div', { className: 'chat' }, h('header', { className: 'top' }, h('div', { className: 'top-inner' }, headChip)),
      h('div', { className: 'dock' }, h('div', { id: 'work-status' }), composer)), panel);
  doc.body.append(main);
  const calls: Call[] = [], fetches: Call[] = [], toasts: string[] = [], statuses: string[] = [], reselected: unknown[] = [], tabs: string[] = [];
  let synced = 0, n = 0, blob = 0;
  const window: Any = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, crypto: { randomUUID: () => `uuid-${++n}` } };
  const context = vm.createContext({
    window, document: doc, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, AbortController, console,
    URL: { createObjectURL: () => `blob:${++blob}`, revokeObjectURL() {} },
  });
  for (const file of ['client/public/runtime-tasks.js', 'client/public/workspace-rules.js', 'client/public/workspace.js']) vm.runInContext(read(file), context);
  const ws = window.ClowderWorkspace;
  const api = async (path: string, opt: { method?: string; body?: unknown } = {}) => {
    const call: Call = { path, method: opt.method || 'GET', ...(opt.body === undefined ? {} : { body: plain(opt.body) }) };
    calls.push(call);
    return route(path, call.method, call.body);
  };
  const apiFetch = async (path: string, opt: Any = {}) => { fetches.push({ path, method: opt.method || 'GET', body: opt.body }); return fetchRoute(path, opt); };
  const names: Record<string, string> = { 'cat-a': '宪宪', 'cat-b': '砚砚', 'cat-c': '墨墨' };
  // The hooks app.js passes (see workspace.init in client/public/app.js).
  ws.init({
    api, apiFetch,
    icon: (name: string, extra?: string) => { const s = doc.createElementNS('svg', 'svg'); s.className = 'icon' + (extra ? ' ' + extra : ''); s.dataset.icon = name; return s; },
    visibleError: (e: Any, fallback?: string) => (e && /\p{Script=Han}/u.test(e.message) ? e.message : fallback || '操作失败'),
    syncComposer: () => { synced++; },
    face: (id: string, name: string) => h('span', { className: 'avatar xs', title: name || id }),
    catName: (id: string) => names[id] || '',
    openImage() {}, toast: (t: string) => toasts.push(t), status: (t: string) => statuses.push(t), copy: async () => true,
    peer: () => false, busy: () => false,
    reselect: async (sel: unknown) => { reselected.push(plain(sel)); ws.select(sel); },
    reload() {}, repaintPanel() {},
    openTab: async (tab: string) => { tabs.push(tab); },
    ...hooks,
  });
  const chips = () => all(doc.getElementById('attach-list')!).filter(e => e.classList.contains('wsf-chip'));
  return { doc, ws, calls, fetches, toasts, statuses, reselected, tabs, chips, panel, headChip, synced: () => synced };
}
// DOM nodes are compared by identity: a failing assert.equal would try to print the whole cyclic fake document.
const same = (actual: unknown, expected: unknown, message: string) => assert.ok(actual === expected, message);
const textOf = (root: El) => root.textContent;
const buttons = (root: El, text: string) => all(root).filter(e => e.tagName === 'BUTTON' && e.textContent === text);
const button = (root: El, text: string) => { const b = buttons(root, text)[0]; assert.ok(b, 'no button ' + text); return b; };
const labelled = (root: El, label: string) => { const b = all(root).find(e => e.getAttribute('aria-label') === label); assert.ok(b, 'no control ' + label); return b; };
const foldOf = (root: El, cls: string) => { const f = all(root).find(e => e.tagName === 'DETAILS' && e.classList.contains(cls)); assert.ok(f, 'no fold ' + cls); return f; };
// As a browser does when the summary is clicked: open changes, then toggle fires.
const setFold = async (f: El, open: boolean) => { f.open = open; f.dispatchEvent(new Ev('toggle')); await settle(); };
const file = (name: string, size: number, type = 'text/markdown') => ({ name, size, type });
const served = (over: Record<string, unknown> = {}) => ({ id: 'f-1', threadId: 'thread-A', name: 'report.md', size: 2048, mime: 'text/plain', sha256: 'a'.repeat(64), kind: 'attachment', createdAt: Date.now(), path: '/w/.clowder-bot-files/f-1/report.md', url: '/xbot-api/files/f-1/download', ...over });
const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => plain(data) });
const ada = { type: 'bot', id: 'Ada' }, bob = { type: 'bot', id: 'Bob' }, team = { type: 'group', id: 'g-1' };
// GET <chat>/workspace as the server now answers: the thread, its working
// directory (sharedPath differs only for an older project conversation) and the default root.
const view = (over: Record<string, unknown> = {}) => ({ threadId: 'thread-A', workspacePath: '/w/cats/cat-a', sharedPath: '/w/cats/cat-a', defaultRoot: '/w', canSwitch: false, ...over });

// ---------------------------------------------------------------- rules
test('pending files: eight per message, 20 MB and non-empty each, and a refused send loses nothing', () => {
  const window: Any = {};
  vm.runInNewContext(read('client/public/workspace-rules.js'), { window });
  const R = window.ClowderWorkspaceRules;
  const files = [file('a.md', 10), file('big.zip', 21 * 1024 * 1024), file('empty.txt', 0), ...Array.from({ length: 8 }, (_, i) => file(`n${i}.md`, 5))];
  const { accepted, refused } = R.admit(1, files);
  assert.deepEqual(plain(accepted.map((f: Any) => f.name)), ['a.md', 'n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md']);
  assert.deepEqual(plain(refused.map((r: Any) => r.reason)), ['large', 'empty', 'full', 'full']);
  assert.match(R.refusal(refused), /「big\.zip」超过 20 MB.*「empty\.txt」是空文件.*最多 8 个附件，另有 2 个没有添加/);
  // Handed-back files rejoin ahead of newer ones, without duplicates, within the limit.
  const row = (id: string) => ({ id });
  const back = R.restore([row('new'), row('x')], [row('x'), row('old1'), row('old2')]);
  assert.deepEqual(plain(back.rows.map((r: Any) => r.id)), ['old1', 'old2', 'new', 'x']);
  const full = R.restore(Array.from({ length: 7 }, (_, i) => row('c' + i)), [row('o1'), row('o2')]);
  assert.equal(full.rows.length, 8);
  assert.deepEqual(plain(full.dropped.map((r: Any) => r.id)), ['c6']);
  assert.deepEqual(plain([0, 1023, 1536, 10 * 1024, 3.25 * 1024 * 1024, 20 * 1024 * 1024].map(R.size)), ['0 B', '1023 B', '1.5 KB', '10 KB', '3.3 MB', '20 MB']);
});

test('流转记录 is the native record only, newest first, each way an owner changed named apart; saved conversations are listed newest first', () => {
  const window: Any = {};
  vm.runInNewContext(read('client/public/workspace-rules.js'), { window });
  const R = window.ClowderWorkspaceRules;
  const task = { id: 't', kind: 'work', subjectKey: null, status: 'doing', ownerCatId: 'cat-b', ownerRevision: 4, assignmentHistory: [
    { revision: 1, fromCatId: null, toCatId: 'cat-a', at: 1000, sourceMessageRef: null, kind: 'claim' },
    { revision: 2, fromCatId: 'cat-a', toCatId: 'cat-c', at: 2000, sourceMessageRef: null, kind: 'human_update' },
    { revision: 3, fromCatId: 'cat-c', toCatId: 'cat-b', at: 3000, sourceMessageRef: 'message:m1', kind: 'handoff' },
    { revision: 4, fromCatId: 'cat-b', toCatId: 'cat-b', at: 4000, sourceMessageRef: null, kind: 'mystery' },
  ] };
  assert.deepEqual(plain(R.history(task)).map((r: Any) => [r.revision, r.from, r.to, r.kind, r.source]), [
    [4, 'cat-b', 'cat-b', '负责人变更', null], [3, 'cat-c', 'cat-b', '传球', 'message:m1'], [2, 'cat-a', 'cat-c', '手动指派', null], [1, null, 'cat-a', '认领', null]]);
  const labels = Object.values(R.KINDS) as string[];
  assert.equal(new Set([...labels, '负责人变更']).size, 4, 'a pass, a person setting the owner, a claim and an unknown change read differently');
  assert.deepEqual(plain(R.history({ ...task, assignmentHistory: undefined })), []);
  // A pass needs an owner and an ordinary open Task; nothing here sets an owner.
  assert.equal(R.handoffBlocked(task), '');
  assert.equal(R.handoffBlocked({ ...task, ownerCatId: null }), '还没有负责人。');
  assert.match(R.handoffBlocked({ ...task, kind: 'review' }), /运行面板/);
  assert.match(R.handoffBlocked({ ...task, status: 'done' }), /已完成/);
  assert.equal(R.assignBlocked, undefined, 'no assignment gate: the chat page does not assign');
  assert.deepEqual(plain(R.summary([task, { ...task, status: 'blocked', ownerCatId: 'cat-a' }, { ...task, status: 'done' }])),
    { open: 2, doing: 1, blocked: 1, todo: 0, owners: ['cat-b', 'cat-a'] });
  // Saved conversations: valid, unique, one-line titles, newest first, the server's current mark kept.
  assert.deepEqual(plain(R.conversations([
    { id: 'p', title: ' 官网\n改版 ', current: false, createdAt: 1000 },
    { id: 'a', title: 'Ada', current: true, createdAt: 2000 },
    { id: 'a', title: 'again', current: false, createdAt: 9000 },
    { id: 7 }, null, 'x',
    { id: 'n', createdAt: '2026-11-04T06:00:00Z' },
  ])), [
    { id: 'n', title: '', current: false, createdAt: Date.parse('2026-11-04T06:00:00Z') },
    { id: 'a', title: 'Ada', current: true, createdAt: 2000 },
    { id: 'p', title: '官网 改版', current: false, createdAt: 1000 },
  ]);
  assert.deepEqual(plain(R.conversations(undefined)), []);
});

// ---------------------------------------------------------------- composer
test('a file uploads to the exact thread it was added in; switching away aborts it and its late answer lands nowhere', async () => {
  const upload = deferred<Any>(), slowView = deferred<Any>();
  let signal: AbortSignal | null = null;
  // The workspace view would name the thread too; here only the transcript read does.
  const p = page(path => (path.endsWith('/workspace') ? slowView.promise : path.endsWith('/tasks') ? new Promise(() => {}) : {}),
    (path, opt) => { signal = opt.signal; return path.includes('/files?') ? upload.promise : json(404, {}); });
  p.ws.select(ada);
  p.ws.addFiles([file('report.md', 2048)]);
  await settle();
  assert.equal(p.fetches.length, 0, 'nothing uploads before the conversation\'s thread is known');
  assert.match(textOf(p.chips()[0]), /report\.md等待上传/);
  p.ws.observe(ada, 'thread-A', true);
  await settle();
  assert.equal(p.fetches[0].path, '/xbot-api/bots/Ada/files?name=report.md&expectedThreadId=thread-A');
  assert.equal(p.fetches[0].method, 'POST');
  assert.equal(p.ws.attachBusy(), true);
  p.ws.select(bob);
  assert.equal(signal!.aborted, true, 'the switch aborts the upload');
  upload.resolve(json(201, { file: served() }));
  await settle();
  assert.equal(p.ws.attachReady(), 0);
  assert.equal(p.chips().length, 0, 'the late answer does not land in another conversation');
});

test('a send that does not go out hands its files back; after a switch they wait for that conversation and thread', async () => {
  let id = 0;
  const p = page(path => (path.endsWith('/workspace') ? view() : path.endsWith('/tasks') ? { tasks: [], cats: [] } : {}),
    () => json(201, { file: served({ id: `f-${++id}` }) }));
  p.ws.select(ada);
  p.ws.observe(ada, 'thread-A', true);
  p.ws.addFiles([file('a.md', 10), file('b.md', 20)]);
  await settle();
  assert.equal(p.ws.attachReady(), 2);
  const batch = p.ws.takeAttachments();
  assert.deepEqual(plain(batch.ids), ['f-1', 'f-2']);
  assert.equal(batch.threadId, 'thread-A');
  assert.equal(p.chips().length, 0, 'sent files leave the composer');
  assert.equal(p.ws.giveBack(batch), true);
  assert.equal(p.ws.attachReady(), 2, 'a refused send loses no file');

  const again = p.ws.takeAttachments();
  p.ws.select(bob);
  assert.equal(p.ws.giveBack(again), false, 'another conversation is open');
  assert.equal(p.ws.attachReady(), 0, 'and it never receives them');
  p.ws.select(ada);
  p.ws.observe(ada, 'thread-A', true);
  assert.equal(p.ws.attachReady(), 2);
  assert.match(p.doc.getElementById('attach-note')!.textContent, /上次没发出去的附件已放回/);

  // The conversation now runs in another thread: its files no longer belong.
  p.ws.observe(ada, 'thread-B', false);
  assert.equal(p.ws.attachReady(), 0);
  assert.match(p.doc.getElementById('attach-note')!.textContent, /会话已更换/);
});

test('an upload refused by the server keeps its row with the reason and a retry; removing it returns focus to the input', async () => {
  let attempt = 0;
  const p = page(path => (path.endsWith('/workspace') ? view() : { tasks: [], cats: [] }),
    () => (++attempt === 1 ? json(409, { error: '会话已变化，请刷新后重试' }) : json(201, { file: served() })));
  p.ws.select(ada);
  p.ws.observe(ada, 'thread-A', true);
  p.ws.addFiles([file('report.md', 2048)]);
  await settle();
  const row = p.chips()[0];
  assert.equal(row.dataset.status, 'failed');
  assert.match(textOf(row), /没传上去：会话已变化，请刷新后重试/);
  all(row).find(e => e.getAttribute('aria-label') === '重新上传 report.md')!.click();
  await settle();
  assert.equal(p.chips()[0].dataset.status, 'ready');
  assert.match(textOf(p.chips()[0]), /2 KB/);
  all(p.chips()[0]).find(e => e.getAttribute('aria-label') === '移除附件 report.md')!.click();
  assert.equal(p.chips().length, 0);
  same(p.doc.activeElement, p.doc.getElementById('input'), 'focus moves to the input');
});

// ---------------------------------------------------------------- file cards
test('a stored picture that no longer loads says why and offers no download', async () => {
  const p = page(() => ({}), (_path, opt) => (opt.method === 'HEAD' ? { ok: false, status: 404 } : json(200, {})));
  const list = p.ws.cards([served({ id: 'img-1', name: 'shot.png', mime: 'image/png', previewUrl: '/xbot-api/files/img-1/image' })]);
  p.doc.body.append(list);
  const img = all(list).find(e => e.tagName === 'IMG')!;
  assert.equal(img.src, '/xbot-api/files/img-1/image');
  img.dispatchEvent(new Ev('error'));
  await settle();
  const card = all(list).find(e => e.classList.contains('wsf-card'))!;
  assert.equal(card.dataset.state, 'missing');
  assert.match(textOf(card), /文件已不存在/);
  assert.ok(all(card).filter(e => e.tagName === 'BUTTON').every(b => b.disabled));
  assert.equal(p.fetches[0].path, '/xbot-api/files/img-1/download');
});

// A native file view (GET <chat>/files, message attachments): the cat's own
// result as the native record has it, with whether its bytes can be fetched.
const nativeFile = (over: Record<string, unknown> = {}) => ({ id: 'msg:m1/file 1', threadId: 'thread-A', name: 'report.pdf', kind: 'deliverable', mime: 'application/pdf', size: null,
  createdAt: Date.now(), sourceMessageId: 'm1', nativeSource: true, availability: 'available', ...over });

test('a native file card says 成果, leaves out a size it was not given, builds its own URL from the ID, and when unavailable says why without asking for its bytes', async () => {
  const p = page(() => ({}), () => ({ ok: true, status: 200, blob: async () => 'bytes', json: async () => ({}) }));
  const list = p.ws.cards([
    nativeFile(),
    nativeFile({ id: 'n-img', name: 'chart.png', mime: 'image/png', size: 4096, kind: 'attachment', url: 'https://elsewhere.example/chart.png', previewUrl: 'https://elsewhere.example/p.png' }),
    nativeFile({ id: 'n-off', name: 'deck.png', mime: 'image/png', availability: 'unavailable', unavailableReason: '这份文件来自外部链接，暂时不能下载' }),
    nativeFile({ id: 'n-odd', name: 'notes.txt', mime: 'text/plain', availability: 'later' }),
    served({ id: 'snap-1', name: 'v1.md', kind: 'deliverable' }),
  ]);
  p.doc.body.append(list);
  const cardsIn = all(list).filter(e => e.classList.contains('wsf-card'));
  const [result, picture, held, odd, snapshot] = cardsIn;
  // The native result is 成果 and never a snapshot; the Bot snapshot keeps its own name.
  assert.equal(textOf(result.querySelector('.wsf-meta')!), '成果');
  assert.doesNotMatch(textOf(result), /0 B|交付物|快照/);
  assert.match(textOf(snapshot.querySelector('.wsf-meta')!), /2 KB · 交付物/);
  // Its picture and download go to /xbot-api/files/<encoded id>/…, never to a URL the record carried.
  assert.equal(all(picture).find(e => e.tagName === 'IMG')!.src, '/xbot-api/files/n-img/image');
  assert.equal(textOf(picture.querySelector('.wsf-meta')!), '4 KB');
  labelled(result, '下载 report.pdf').click();
  await settle();
  assert.deepEqual(p.fetches.map(f => f.path), ['/xbot-api/files/' + encodeURIComponent('msg:m1/file 1') + '/download']);
  // Unavailable: the reason in place, nothing to press, and its picture never requested.
  assert.equal(held.dataset.state, 'unavailable');
  assert.ok(!all(held).some(e => e.tagName === 'IMG'), 'an unavailable picture is not requested');
  assert.match(textOf(held), /这份文件来自外部链接，暂时不能下载/);
  assert.ok(all(held).filter(e => e.tagName === 'BUTTON').every(b => b.disabled));
  labelled(held, '下载 deck.png').click();
  // Anything but an explicit "available" is not fetchable either, and offers no preview.
  assert.equal(odd.dataset.state, 'unavailable');
  assert.match(textOf(odd), /这份成果暂时不能下载/);
  assert.ok(all(odd).filter(e => e.tagName === 'BUTTON').every(b => b.disabled));
  await settle();
  assert.equal(p.fetches.length, 1, 'nothing is fetched for a file that cannot be fetched');
  // A size the record did not give is left out; 0 is still 0.
  const window: Any = {};
  vm.runInNewContext(read('client/public/workspace-rules.js'), { window });
  assert.deepEqual(plain([null, undefined, '', 0].map(window.ClowderWorkspaceRules.size)), ['', '', '', '0 B']);
});

test('文件: when the native record cannot be read the saved files stay, 成果 says so instead of "none", and 重试 reads again', async () => {
  let nativeOk = false, partial = false;
  const snapshot = served({ id: 'del-1', name: 'report-v1.md', kind: 'deliverable' });
  const p = page((path) => {
    const bare = path.split('?')[0];
    if (bare === '/xbot-api/bots/Ada/workspace') return view();
    if (bare === '/xbot-api/bots/Ada/files') return nativeOk
      ? { threadId: 'thread-A', files: [nativeFile({ id: 'n-1', name: 'result.md', mime: 'text/plain', size: 300 }), snapshot], nativeReadStatus: 'ready' }
      : { threadId: 'thread-A', files: partial ? [nativeFile({ id: 'n-1', name: 'result.md', mime: 'text/plain', size: 300 }), snapshot] : [snapshot], nativeReadStatus: 'unavailable', nativeError: '原生成果暂时读不到' };
    if (bare === '/xbot-api/bots/Ada/tasks') return { threadId: 'thread-A', tasks: [], cats };
    throw failure(404, 'unexpected ' + path);
  });
  p.ws.select(ada);
  p.ws.observe(ada, 'thread-A', true);
  const root = p.ws.filesView(ada) as El;
  p.panel.append(root);
  await settle();
  assert.deepEqual(all(root).filter(e => e.tagName === 'H4').map(textOf), ['成果', '交付物 · 1', '附件 · 0'], 'no count claimed for what could not be read');
  const results = sectionOf(root, '成果');
  assert.match(textOf(results), /猫猫在对话里发出的文件暂时读不到。下面只显示已保存的文件。/);
  assert.equal(results.querySelector('.ws-bad')!.title, '原生成果暂时读不到', 'the server\'s reason stays at hand, not in the sentence');
  assert.doesNotMatch(textOf(results), /还没有成果/);
  assert.deepEqual(namesIn(sectionOf(root, '交付物')), ['report-v1.md'], 'the saved snapshot stays');
  assert.match(textOf(sectionOf(root, '附件')), /已保存的附件里还没有文件。对话里的其他文件暂时读不到。/);
  same(labelled(root, '刷新文件').closest('section'), results, 'the page refresh sits on the first section');
  nativeOk = true;
  button(results, '重试').click();
  await settle();
  assert.equal(textOf(sectionOf(root, '成果').querySelector('h4')!), '成果 · 1');
  assert.deepEqual(namesIn(sectionOf(root, '成果')), ['result.md']);
  assert.deepEqual(namesIn(sectionOf(root, '交付物')), ['report-v1.md'], 'results and snapshots are listed apart');
  // Partly read: what was read shows, and the line says the list may be incomplete.
  nativeOk = false;
  partial = true;
  labelled(root, '刷新文件').click();
  await settle();
  assert.match(textOf(sectionOf(root, '成果')), /还有些猫猫发出的文件暂时读不到，这里可能不全。/);
  assert.deepEqual(namesIn(sectionOf(root, '成果')), ['result.md']);
});

// ---------------------------------------------------------------- 文件 page
// One cat's 文件 page against a server that keeps what it saved.
function filesPage(over: Record<string, unknown> = {}, files: Any[] = []) {
  const saved = [...files];
  const p = page((path, method, body) => {
    const bare = path.split('?')[0];
    if (bare === '/xbot-api/bots/Ada/workspace') return view(over);
    if (bare === '/xbot-api/bots/Ada/files') return { threadId: 'thread-A', files: saved };
    if (bare === '/xbot-api/bots/Ada/workspace-tree') {
      const area = new URLSearchParams(path.split('?')[1]).get('area');
      return { path: '', area, entries: area === 'shared'
        ? [{ name: 'plan.md', path: 'plan.md', type: 'file', size: 64 }]
        : [{ name: 'drafts', path: 'drafts', type: 'directory' }, { name: 'report.md', path: 'report.md', type: 'file', size: 2048 }] };
    }
    if (bare === '/xbot-api/bots/Ada/deliverables' && method === 'POST') {
      const made = served({ id: 'del-' + (saved.length + 1), name: body.path, kind: 'deliverable', sourcePath: '/w/cats/cat-a/' + body.path });
      saved.unshift(made);
      return { file: made };
    }
    if (bare === '/xbot-api/bots/Ada/tasks') return { threadId: 'thread-A', tasks: [], cats };
    throw failure(404, 'unexpected ' + method + ' ' + path);
  });
  p.ws.select(ada);
  p.ws.observe(ada, 'thread-A', true);
  const root = p.ws.filesView(ada) as El;
  p.panel.append(root);
  return { ...p, root };
}
const sectionOf = (root: El, title: string) => {
  const box = all(root).find(e => e.tagName === 'SECTION' && e.classList.contains('ws-sec') && textOf(e.querySelector('h4')!).startsWith(title));
  assert.ok(box, 'no section ' + title);
  return box;
};
const namesIn = (box: El) => all(box).filter(e => e.classList.contains('wsf-name')).map(textOf);

test('文件 shows deliverables and attachments; the working directory, its path and 存为交付物 wait folded in 更多文件', async () => {
  const p = filesPage({ filePolicy: { externalReadOnly: true } }, [served({ id: 'att-1', name: 'brief.md' }), served({ id: 'del-1', name: 'report-v1.md', kind: 'deliverable' })]);
  await settle();
  assert.deepEqual(all(p.root).filter(e => e.tagName === 'H4').map(textOf), ['交付物 · 1', '附件 · 1']);
  assert.deepEqual(namesIn(sectionOf(p.root, '交付物')), ['report-v1.md']);
  assert.deepEqual(namesIn(sectionOf(p.root, '附件')), ['brief.md']);
  assert.match(textOf(sectionOf(p.root, '交付物')), /2 KB · 交付物/);
  // The first view: no path, no workspace card, no area switch, and nothing read from the directory.
  const more = foldOf(p.root, 'ws-more');
  assert.equal(more.open, false);
  assert.equal(textOf(more), '更多文件');
  assert.doesNotMatch(textOf(p.root), /\/w\b|工作目录|共享目录|工作区|项目/);
  assert.ok(!all(p.root).some(e => ['ws-paths', 'ws-seg', 'ws-ctx', 'ws-switch'].some(c => e.classList.contains(c))));
  assert.equal(p.calls.filter(c => c.path.includes('/workspace-tree')).length, 0, 'the directory is read only once 更多文件 opens');
  // A file policy the server mentions is not turned into a claim.
  assert.doesNotMatch(textOf(p.root), /只读|read-only|受保护/i);

  // Opened: the path and the browsing appear inside the fold, one directory, no switch.
  await setFold(more, true);
  assert.deepEqual(p.calls.filter(c => c.path.includes('/workspace-tree')).map(c => c.path), ['/xbot-api/bots/Ada/workspace-tree?path=&area=workspace']);
  const paths = all(more).find(e => e.classList.contains('ws-paths'))!;
  assert.equal(textOf(paths), '工作目录/w/cats/cat-a');
  assert.equal(labelled(more, '复制工作目录路径').tagName, 'BUTTON');
  assert.ok(!all(more).some(e => e.classList.contains('ws-seg')), 'one directory: nothing to switch');
  assert.doesNotMatch(textOf(p.root), /只读|read-only|受保护/i);

  // Saving a real file makes a snapshot, listed with the deliverables.
  button(more, '存为交付物').click();
  await settle();
  assert.deepEqual(p.calls.find(c => c.method === 'POST')!.body, { path: 'report.md', area: 'workspace', expectedThreadId: 'thread-A' });
  assert.deepEqual(p.toasts, ['已存为交付物「report.md」']);
  assert.equal(button(more, '再存一份').getAttribute('aria-label'), '把 report.md 存为交付物');
  assert.deepEqual(namesIn(sectionOf(p.root, '交付物')), ['report.md', 'report-v1.md']);
  assert.equal(textOf(sectionOf(p.root, '交付物').querySelector('h4')!), '交付物 · 2');
  // Closed again, the path leaves with it; the fold stays as it was left for this conversation.
  await setFold(more, false);
  assert.doesNotMatch(textOf(p.root), /\/w\b|工作目录/);
  await setFold(more, true);
  assert.match(textOf(more), /工作目录/);
});

test('with nothing saved yet the 文件 page explains snapshots; an older project conversation browses its shared directory only inside 更多文件', async () => {
  const empty = filesPage();
  await settle();
  assert.equal(textOf(sectionOf(empty.root, '交付物').querySelector('p')!), '还没有交付物。可以在下面的「更多文件」里，把完成的文件存为交付物：会保存一份带校验的快照，之后改动不影响它。');
  assert.match(textOf(sectionOf(empty.root, '附件')), /这个会话还没有附件/);

  const p = filesPage({ workspacePath: '/w/projects/old/cats/cat-a', sharedPath: '/w/projects/old/shared' });
  await settle();
  assert.ok(!all(p.root).some(e => e.classList.contains('ws-seg')), 'no area switch in the first view');
  const more = foldOf(p.root, 'ws-more');
  await setFold(more, true);
  const paths = all(more).find(e => e.classList.contains('ws-paths'))!;
  assert.deepEqual(all(paths).filter(e => e.tagName === 'DT').map(textOf), ['工作目录', '共享目录']);
  assert.match(textOf(paths), /…\/old\/cats\/cat-a/);
  const seg = all(more).find(e => e.classList.contains('ws-seg'))!;
  assert.deepEqual(all(seg).filter(e => e.tagName === 'BUTTON').map(textOf), ['工作目录', '共享目录']);
  button(seg, '共享目录').click();
  await settle();
  assert.equal(p.calls.filter(c => c.path.includes('/workspace-tree')).at(-1)!.path, '/xbot-api/bots/Ada/workspace-tree?path=&area=shared');
  assert.equal(textOf(all(more).find(e => e.classList.contains('here'))!), '共享目录');
  assert.match(textOf(more), /plan\.md/);
});

// ---------------------------------------------------------------- 任务
const T0 = Date.UTC(2026, 10, 4, 6, 0, 0);
const cats = [{ id: 'cat-a', name: '宪宪' }, { id: 'cat-b', name: '砚砚' }];
const task = (over: Record<string, unknown> = {}) => ({ id: 't-1', kind: 'work', threadId: 'g-1', subjectKey: null, title: '写周报', why: '周五前交', ownerCatId: 'cat-a', ownerRevision: 2, status: 'doing', createdAt: T0, updatedAt: T0, assignmentHistory: [], ...over });
function tasksPage(list: () => unknown[], extra: Route = () => undefined, history = true) {
  const p = page((path, method, body) => {
    const answer = extra(path, method, body);
    if (answer !== undefined) return answer;
    if (path.endsWith('/workspace')) return view({ threadId: 'g-1', workspacePath: '/w/groups/g-1', sharedPath: '/w/groups/g-1' });
    if (path === '/xbot-api/groups/g-1/tasks' && method === 'GET') return { threadId: 'g-1', tasks: list(), cats, historyAvailable: history };
    throw failure(404, 'unexpected ' + method + ' ' + path);
  });
  p.ws.select(team);
  const root = p.ws.tasksView(team) as El;
  p.panel.append(root);
  return { ...p, root };
}
const cardOf = (root: El, id: string) => { const c = all(root).find(e => e.tagName === 'ARTICLE' && e.dataset.taskId === id); assert.ok(c, 'no card ' + id); return c; };
const actsOf = (card: El) => all(card).filter(e => e.tagName === 'BUTTON' && e.dataset.act).map(b => textOf(b));
const lineOf = (card: El) => all(card).find(e => e.classList.contains('wst-line'))!;
const ownerOf = (card: El) => textOf(all(card).find(e => e.classList.contains('wst-owner'))!);
const histOf = (card: El) => all(card).find(e => e.classList.contains('wst-hist'))!;
const stripOf = (p: { doc: Doc }) => all(p.doc.body).find(e => e.classList.contains('ws-strip'))!;

test('请求传球 is a request: the card keeps the 负责人 it read, and a retry keeps its idempotency key', async () => {
  let attempt = 0;
  const p = tasksPage(() => [task()], (path, method) => {
    if (path.endsWith('/handoff') && method === 'POST') { if (++attempt === 1) throw new Error('连不上 clowder-bot'); return { status: 'requested', receipt: { messageId: 'm' } }; }
    return undefined;
  });
  await settle();
  const card = cardOf(p.root, 't-1');
  assert.equal(ownerOf(card), '负责人宪宪');
  assert.deepEqual(actsOf(card), ['请求传球…', '撤销任务']);
  button(card, '请求传球…').click();
  const form = all(card).find(e => e.tagName === 'FORM')!;
  const pick = all(form).find(e => e.tagName === 'SELECT')!;
  assert.deepEqual(all(pick).filter(o => o.tagName === 'OPTION').map(o => o.value), ['', 'cat-b'], 'targets are the other members, never the owner');
  same(p.doc.activeElement, pick, 'focus moves to the target list');
  assert.match(textOf(form), /传给.*说明（可选）.*会请「宪宪」按原生流程传球；传球完成前，负责人不变。/);
  pick.value = 'cat-b';
  pick.dispatchEvent(new Ev('change'));
  all(form).find(e => e.tagName === 'TEXTAREA')!.value = '资料已整理好';
  button(form, '请求传球').click();
  await settle();
  assert.match(textOf(card), /没能请求传球：连不上 clowder-bot/);
  button(form, '请求传球').click();
  await settle();
  const sent = p.calls.filter(c => c.path === '/xbot-api/groups/g-1/tasks/t-1/handoff');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, { targetCatId: 'cat-b', expectedOwnerRevision: 2, note: '资料已整理好', idempotencyKey: sent[0].body.idempotencyKey });
  assert.equal(textOf(lineOf(card)), '已请求传球。负责人仍是「宪宪」，传球完成后这里会更新。');
  assert.match(textOf(card), /已请「宪宪」传球给「砚砚」/);
  // No optimistic owner change: the card, the dock line and the history stay with the read Task.
  assert.equal(ownerOf(card), '负责人宪宪', 'the owner shown is still the read Task\'s');
  assert.deepEqual(all(stripOf(p)).filter(e => e.classList.contains('avatar')).map(e => e.title), ['宪宪']);
  assert.match(textOf(histOf(card)), /^流转记录还没有流转记录/);
  assert.doesNotMatch(textOf(card), /已传球|传球成功|已交接/);
  assert.ok(!all(card).some(e => e.tagName === 'FORM'), 'the form closed after the request');
  assert.ok(!p.calls.some(c => c.method === 'PATCH'), 'nothing sets the owner from here');
});

test('a running Task stops by request with the observed revision and attempt; resume waits for the native end, then only lifts the ban', async () => {
  const run = { attemptId: 'attempt-1', ownerRevision: 3, state: 'running', updatedAt: T0 };
  const running = task({ ownerRevision: 3, executionRef: { subexecutionId: 'attempt-1' }, backgroundExecution: run });
  let current: Any = running;
  const p = tasksPage(() => [current], (path, method, body) => {
    if (path.endsWith('/control') && method === 'POST') {
      if (body.action === 'stop') current = { ...running, backgroundStopRequestedAt: T0 + 1000, backgroundExecution: { ...run, state: 'stopping' } };
      if (body.action === 'resume') current = { ...current, backgroundStopRequestedAt: null, backgroundExecution: { ...current.backgroundExecution, stopRequestedAt: null } };
      return { task: current, unconfirmedTaskIds: [] };
    }
    return undefined;
  });
  await settle();
  const card = cardOf(p.root, 't-1');
  assert.match(textOf(card), /后台执行：运行中/);
  assert.equal(ownerOf(card), '负责人宪宪');
  assert.match(textOf(card), /进行中/);
  // Status, owner and execution stay separate; the controls are the native ones, nothing to (re)assign.
  assert.deepEqual(actsOf(card), ['停止执行', '请求传球…', '撤销任务']);
  const stop = button(card, '停止执行');
  stop.click();
  assert.equal(p.calls.filter(c => c.path.endsWith('/control')).length, 0, 'stopping asks for a second click');
  button(card, '再点一次停止').click();
  await settle();
  const control = p.calls.find(c => c.path === '/xbot-api/groups/g-1/tasks/t-1/control')!;
  assert.deepEqual(control.body, { action: 'stop', expectedOwnerRevision: 3, expectedAttemptId: 'attempt-1' });
  assert.match(textOf(card), /停止请求已提交，实际状态以执行记录为准/);
  assert.match(textOf(card), /后台执行：停止请求已提交/);
  assert.doesNotMatch(textOf(card), /已停止/);
  const resume = button(card, '允许继续');
  assert.equal(resume.disabled, true, 'resume waits until the native record ends');
  assert.match(textOf(card), /这不代表已在进行的工作已经停止/);

  // The native record ends: resume opens, and says it only lifts the ban.
  current = { ...current, updatedAt: T0 + 2000, backgroundExecution: { ...current.backgroundExecution, state: 'stopped', updatedAt: T0 + 2000 } };
  labelled(p.root, '刷新任务').click();
  await settle();
  assert.match(textOf(card), /后台执行：已停止/);
  assert.equal(button(card, '允许继续').disabled, false);
  button(card, '允许继续').click();
  await settle();
  assert.deepEqual(p.calls.filter(c => c.path.endsWith('/control')).at(-1)!.body, { action: 'resume', expectedOwnerRevision: 3, expectedAttemptId: 'attempt-1' });
  assert.equal(textOf(lineOf(card)), '已解除禁止。这不会自动重新开始执行；需要继续时，在聊天里请负责人继续。');
});

test('流转记录 lists the native rows only, each change named for how it happened; the page has no way to create a Task or set its owner', async () => {
  const moves = [
    { revision: 1, fromCatId: null, toCatId: 'cat-a', at: T0 + 1000, sourceMessageRef: null, kind: 'claim' },
    { revision: 2, fromCatId: 'cat-a', toCatId: 'cat-c', at: T0 + 2000, sourceMessageRef: null, kind: 'human_update' },
    { revision: 3, fromCatId: 'cat-c', toCatId: 'cat-b', at: T0 + 3000, sourceMessageRef: 'message:m1', kind: 'handoff' },
    { revision: 4, fromCatId: 'cat-b', toCatId: 'cat-b', at: T0 + 4000, sourceMessageRef: null, kind: 'mystery' },
  ];
  const current = task({ status: 'todo', ownerCatId: 'cat-b', ownerRevision: 4, assignmentHistory: moves });
  const p = tasksPage(() => [current], withCatC(() => current));
  await settle();
  const card = cardOf(p.root, 't-1');
  assert.equal(ownerOf(card), '负责人砚砚');
  const hist = histOf(card);
  assert.equal(hist.open, false, 'folded');
  assert.match(textOf(hist), /^流转记录 · 4/);
  const rows = all(hist).filter(e => e.tagName === 'LI').map(textOf);
  assert.equal(rows.length, 4);
  assert.match(rows[0], /砚砚 → 砚砚负责人变更 · 第 4 版$/);
  assert.match(rows[1], /墨墨 → 砚砚传球 · 第 3 版 · 来自聊天消息$/);
  assert.match(rows[2], /宪宪 → 墨墨手动指派 · 第 2 版$/);
  assert.match(rows[3], /无负责人 → 宪宪认领 · 第 1 版$/);
  // No create, assign or reassign entry, and no request that would make one.
  for (const text of ['新建', '指派…', '改派…', '保存任务', '确认指派']) assert.equal(buttons(p.root, text).length, 0, text);
  assert.ok(!all(p.root).some(e => e.classList.contains('wst-create') || e.classList.contains('ws-add')));
  assert.ok(!p.calls.some(c => c.method === 'PATCH' || (c.method === 'POST' && /\/tasks$/.test(c.path))));
  assert.equal(textOf(all(p.root).find(e => e.tagName === 'H4')!), '任务 · 1');
});

test('the 任务 page starts from the chat: an empty list says no Task is needed first, and nothing offers to make one', async () => {
  const p = tasksPage(() => []);
  p.ws.observe(team, 'g-1', true);
  await settle();
  assert.equal(textOf(all(p.root).find(e => e.tagName === 'H4')!), '任务 · 0');
  assert.equal(textOf(all(p.root).find(e => e.classList.contains('ws-note'))!), '还没有任务。直接在聊天里说要做的事就好，不用先建任务。');
  assert.deepEqual(all(p.root).filter(e => e.tagName === 'BUTTON').map(b => b.getAttribute('aria-label')), ['刷新任务']);
  assert.ok(!all(p.root).some(e => e.tagName === 'FORM'));
  assert.equal(stripOf(p).hidden, true, 'no open Task, no dock line');
});

// The owner moves in the native record after the card spoke about it: what the
// card said about the old owner goes on the next read, with no page reload.
const moved = (from: string | null, to: string | null, revision: number, kind: string, at = T0 + revision * 1000) => ({ revision, fromCatId: from, toCatId: to, at, sourceMessageRef: null, kind });
function withCatC(current: () => Any): Route {
  return (path, method) => (path === '/xbot-api/groups/g-1/tasks' && method === 'GET'
    ? { threadId: 'g-1', tasks: [current()], cats: [...cats, { id: 'cat-c', name: '墨墨' }], historyAvailable: true } : undefined);
}
// Once frozen, Task reads stay out: what the card shows is what the late answer left.
const freezer = () => {
  const f = { on: false, route: (path: string, method: string): unknown => (f.on && path === '/xbot-api/groups/g-1/tasks' && method === 'GET' ? new Promise(() => {}) : undefined) };
  return f;
};
const askPass = async (card: El, to: string) => {
  button(card, '请求传球…').click();
  const pick = all(card).find(e => e.tagName === 'SELECT')!;
  pick.value = to;
  pick.dispatchEvent(new Ev('change'));
  button(card, '请求传球').click();
  await settle();
};

test('after 请求传球, a later owner revision ends the "still owned by" line and the receipt, and claims nothing about the request', async () => {
  let current: Any = task({ assignmentHistory: [moved(null, 'cat-a', 2, 'claim')] });
  const p = tasksPage(() => [current], (path, method) => (path.endsWith('/handoff') && method === 'POST' ? { status: 'requested' } : undefined));
  await settle();
  const card = cardOf(p.root, 't-1');
  await askPass(card, 'cat-b');
  assert.equal(textOf(lineOf(card)), '已请求传球。负责人仍是「宪宪」，传球完成后这里会更新。');
  assert.match(textOf(card), /已请「宪宪」传球给「砚砚」/);

  // The native Task moves on: revision 3, a new owner, one more history row.
  current = { ...current, ownerCatId: 'cat-b', ownerRevision: 3, updatedAt: T0 + 3000, assignmentHistory: [...current.assignmentHistory, moved('cat-a', 'cat-b', 3, 'handoff')] };
  labelled(p.root, '刷新任务').click();
  await settle();
  same(cardOf(p.root, 't-1'), card, 'the same card, refreshed in place');
  assert.equal(ownerOf(card), '负责人砚砚');
  assert.match(textOf(histOf(card)), /流转记录 · 2/);
  assert.match(textOf(histOf(card)), /宪宪 → 砚砚传球 · 第 3 版/);
  assert.equal(textOf(lineOf(card)), '负责人已更新，现在是「砚砚」。', 'the line says what the record shows');
  assert.doesNotMatch(textOf(card), /负责人仍是|传球完成后|已请「宪宪」传球给/, 'nothing about the old owner remains');
  assert.doesNotMatch(textOf(card), /已传球|传球成功|已交接/);

  // A further change replaces it again; a read at the same revision changes nothing.
  current = { ...current, ownerCatId: 'cat-a', ownerRevision: 4, updatedAt: T0 + 4000, assignmentHistory: [...current.assignmentHistory, moved('cat-b', 'cat-a', 4, 'human_update')] };
  labelled(p.root, '刷新任务').click();
  await settle();
  assert.equal(textOf(lineOf(card)), '负责人已更新，现在是「宪宪」。');
  labelled(p.root, '刷新任务').click();
  await settle();
  assert.equal(textOf(lineOf(card)), '负责人已更新，现在是「宪宪」。');
});

test('a 202 that arrives after a read of a newer owner revision keeps that record and does not bring back the old owner', async () => {
  const accepted = deferred<Any>(), frozen = freezer();
  let current: Any = task({ assignmentHistory: [moved(null, 'cat-a', 2, 'claim')] });
  const p = tasksPage(() => [current], (path, method, body) => {
    if (path.endsWith('/handoff') && method === 'POST') return accepted.promise;
    return frozen.route(path, method) ?? withCatC(() => current)(path, method, body);
  });
  await settle();
  const card = cardOf(p.root, 't-1');
  await askPass(card, 'cat-b');
  assert.equal(textOf(lineOf(card)), '正在请求传球…');

  // Before the answer comes, the owner moved to someone else than the one asked for, and a read saw it.
  current = { ...current, ownerCatId: 'cat-c', ownerRevision: 3, updatedAt: T0 + 3000, assignmentHistory: [...current.assignmentHistory, moved('cat-a', 'cat-c', 3, 'human_update')] };
  labelled(p.root, '刷新任务').click();
  await settle();
  assert.equal(ownerOf(card), '负责人墨墨');
  frozen.on = true;
  accepted.resolve({ status: 'requested' });
  await settle();
  const sent = p.calls.filter(c => c.path.endsWith('/handoff'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.expectedOwnerRevision, 2, 'the request named the revision it saw');
  assert.equal(ownerOf(card), '负责人墨墨', 'the captured Task is not painted over the newer read');
  assert.match(textOf(histOf(card)), /流转记录 · 2/);
  assert.equal(textOf(lineOf(card)), '传球请求已提交。负责人已有变化，以任务记录为准。');
  assert.doesNotMatch(textOf(card), /负责人仍是|已请「宪宪」传球给「砚砚」|已传球/, 'no old-owner line and no receipt for a revision already gone');
  assert.ok(!all(card).some(e => e.tagName === 'FORM'), 'the form closed after the request');
  // The regular read agrees and keeps it so.
  frozen.on = false;
  labelled(p.root, '刷新任务').click();
  await settle();
  assert.equal(ownerOf(card), '负责人墨墨');
  assert.equal(textOf(lineOf(card)), '传球请求已提交。负责人已有变化，以任务记录为准。');
});

test('a late stop answer cannot replace a newer read of the execution', async () => {
  const run = { attemptId: 'attempt-1', ownerRevision: 3, state: 'running', updatedAt: T0 };
  const running = task({ ownerRevision: 3, executionRef: { subexecutionId: 'attempt-1' }, backgroundExecution: run });
  const stopped = deferred<Any>(), still = freezer();
  let now: Any = running;
  const q = tasksPage(() => [now], (path, method) => (path.endsWith('/control') && method === 'POST' ? stopped.promise : still.route(path, method)));
  await settle();
  const runCard = cardOf(q.root, 't-1');
  button(runCard, '停止执行').click();
  button(runCard, '再点一次停止').click();
  await settle();
  now = { ...running, updatedAt: T0 + 2000, backgroundStopRequestedAt: T0 + 1000, backgroundExecution: { ...run, state: 'stopped', stopRequestedAt: T0 + 1000, updatedAt: T0 + 2000 } };
  labelled(q.root, '刷新任务').click();
  await settle();
  still.on = true;
  stopped.resolve({ task: { ...running, updatedAt: T0 + 1000, backgroundStopRequestedAt: T0 + 1000, backgroundExecution: { ...run, state: 'stopping', updatedAt: T0 + 1000 } }, unconfirmedTaskIds: [] });
  await settle();
  const runLine = textOf(all(runCard).find(e => e.classList.contains('wst-run'))!);
  assert.match(runLine, /^后台执行：已停止/, 'the late "stopping" record does not replace the read that saw it stop');
  assert.equal(textOf(lineOf(runCard)), '停止请求已提交，实际状态以执行记录为准。');
  assert.equal(ownerOf(runCard), '负责人宪宪');
});

test('without the runtime history marker the card says 流转记录 is off; a Task from the other conversation never paints here', async () => {
  const late = deferred<Any>();
  const p = page(path => {
    if (path.endsWith('/workspace')) return view({ threadId: path.includes('/Bob/') ? 'thread-B' : 'thread-A' });
    if (path === '/xbot-api/bots/Ada/tasks') return late.promise;
    if (path === '/xbot-api/bots/Bob/tasks') return { threadId: 'thread-B', tasks: [task({ id: 'b-1', title: 'Bob 的任务' })], cats, historyAvailable: false };
    return {};
  });
  p.ws.select(ada);
  p.ws.select(bob);
  const root = p.ws.tasksView(bob) as El;
  p.panel.append(root);
  await settle();
  late.resolve({ threadId: 'thread-A', tasks: [task({ id: 'a-1', title: 'Ada 的任务' })], cats, historyAvailable: true });
  await settle();
  assert.match(textOf(root), /Bob 的任务/);
  assert.doesNotMatch(textOf(root), /Ada 的任务/);
  assert.match(textOf(cardOf(root, 'b-1')), /当前运行时没有开启流转记录/);
  const strip = stripOf(p);
  assert.equal(strip.hidden, false);
  assert.match(textOf(strip), /^任务 1进行中 1$/);
  assert.equal(all(strip).find(e => e.tagName === 'BUTTON')!.getAttribute('aria-label'), '任务 1 个未完成：进行中 1。打开任务');
});

// ---------------------------------------------------------------- removed entries
test('project and workspace management are gone: no header chip or menu, no project reads or switches, and a new group sends its name and members only', async () => {
  const p = page((path) => {
    if (path.endsWith('/workspace')) return view({ threadId: path.includes('/groups/') ? 'g-1' : 'thread-A' });
    if (path.endsWith('/conversations')) return { conversations: [{ id: 'thread-A', title: 'Ada', current: true, createdAt: T0 }] };
    if (path.endsWith('/files')) return { threadId: path.includes('/groups/') ? 'g-1' : 'thread-A', files: [] };
    return { threadId: path.includes('/groups/') ? 'g-1' : 'thread-A', tasks: [], cats };
  });
  p.ws.select(ada);
  p.ws.observe(ada, 'thread-A', true);
  for (const pane of [p.ws.filesView(ada), p.ws.tasksView(ada), p.ws.conversationsView(ada)]) p.panel.append(pane);
  await settle();
  assert.deepEqual(p.headChip.parent!.children.map(e => e.className), ['top-title'], 'nothing joins the identity chip');
  assert.ok(!all(p.doc.body).some(e => /\bws-(chip|menu|ctx|switch|project-field)\b/.test(e.className)));
  assert.doesNotMatch(textOf(p.doc.body), /项目|工作区|新建项目|换项目|个人工作区/);
  // A group: no history fold, no project, and the same pages.
  p.ws.select(team);
  same(p.ws.conversationsView(team), null, 'a group has no 历史对话');
  p.panel.replaceChildren(p.ws.filesView(team), p.ws.tasksView(team));
  await settle();
  assert.doesNotMatch(textOf(p.doc.body), /项目|工作区/);
  assert.ok(!p.calls.some(c => c.path.startsWith('/xbot-api/projects')), 'no project list or creation');
  assert.ok(!p.calls.some(c => c.method === 'PUT' && c.path.endsWith('/workspace')), 'no workspace switch');
  assert.ok(!p.calls.some(c => c.path.startsWith('/xbot-api/groups/') && c.path.endsWith('/conversations')), 'groups keep their one thread');
  assert.equal(p.ws.projectField, undefined);
  assert.equal(p.ws.closePops, undefined);

  // The shell: 新建群组 is the original name-and-members form again.
  const app = read('client/public/app.js'), src = read('client/public/workspace.js');
  const group = /function openNewGroup\(\) \{[\s\S]*?\n {2}\}\n/.exec(app)![0];
  assert.match(group, /body: \{ name: \(v\.name \|\| ""\)\.trim\(\), members: members \} \}/);
  assert.doesNotMatch(group, /project|workspace/i);
  assert.doesNotMatch(app, /projectField|workspace\.closePops|botLabel/);
  assert.doesNotMatch(src, /\/xbot-api\/projects|新建项目|换项目|projectId|"\/workspace", \{ method: "PUT"/);
  assert.doesNotMatch(src, /method: "PATCH"|\/tasks", \{ method: "POST"/, 'the module never creates or assigns a Task');
});

// ---------------------------------------------------------------- 历史对话
// One cat with saved conversations. The fake server keeps the cat's current
// thread and refuses a stale or busy switch as the real one does. It can hold
// a switch's reply back (gate: the switch itself is already made, as on a
// server whose answer is still on its way) or one list read (holdList).
function historyCat(opts: { list?: Any[]; hooks?: Record<string, unknown> } = {}) {
  const server = {
    thread: 'thread-A',
    list: opts.list ?? [{ id: 'thread-A', title: 'Ada', createdAt: T0 + 2000 }, { id: 'thread-P', title: '官网改版', createdAt: T0 + 1000 }],
    busy: new Set<string>(), gate: null as Promise<unknown> | null, holdList: false, releaseList: () => {},
  };
  const route: Route = (path, method, body) => {
    if (path === '/xbot-api/bots/Ada/workspace') return view({ threadId: server.thread });
    if (path === '/xbot-api/bots/Bob/workspace') return view({ threadId: 'thread-B' });
    if (path === '/xbot-api/bots/Ada/conversations') {
      const answer = { conversations: server.list.map(c => ({ ...c, current: c.id === server.thread })) };
      if (!server.holdList) return answer;
      server.holdList = false;
      const d = deferred<Any>();
      server.releaseList = () => d.resolve(answer);
      return d.promise;
    }
    if (path === '/xbot-api/bots/Ada/conversation' && method === 'PUT') {
      const made = (() => {
        if (body.expectedThreadId !== server.thread) return { error: failure(409, '当前会话已变化，请刷新后再切换') };
        if (server.busy.has(server.thread) || server.busy.has(body.threadId)) return { error: failure(409, '请先完成或停止会话中的任务') };
        server.thread = body.threadId;
        return { view: view({ threadId: body.threadId }) };
      })();
      const reply = () => { if (made.error) throw made.error; return made.view; };
      return server.gate ? server.gate.then(reply) : reply();
    }
    if (/\/bots\/(Ada|Bob)\/(tasks|files)$/.test(path)) return { threadId: path.includes('/Bob/') ? 'thread-B' : server.thread, tasks: [], files: [], cats };
    throw failure(404, 'unexpected ' + method + ' ' + path);
  };
  let id = 0;
  const p = page(route, () => json(201, { file: served({ id: 'up-' + ++id }) }), opts.hooks);
  const details = p.doc.createElement('div');
  details.className = 'tab-body';
  p.panel.append(details);
  // As the shell draws 详情: the page is rebuilt each time and the module's node appended again.
  const draw = () => { details.replaceChildren(); const n = p.ws.conversationsView(ada); if (n) details.append(n); return n as El | null; };
  const count = (method: string, path: string) => p.calls.filter(c => c.method === method && c.path === path).length;
  return { ...p, server, details, draw, count };
}
const rowsOf = (host: El) => all(host).filter(e => e.classList.contains('ws-conv'));
const rowFor = (host: El, title: string) => { const r = rowsOf(host).find(e => textOf(e.querySelector('.ws-conv-title')!) === title); assert.ok(r, 'no row ' + title); return r; };
const convLine = (host: El) => all(host).find(e => e.classList.contains('ws-conv-line'))!;
const openCat = async (p: ReturnType<typeof historyCat>) => {
  p.ws.select(ada);
  p.ws.observe(ada, p.server.thread, true);
  const n = p.draw()!;
  await settle();
  return n;
};

test('历史对话 shows only once the cat has more than one saved conversation: folded, titled, the current one marked, and nothing else to manage', async () => {
  const one = historyCat({ list: [{ id: 'thread-A', title: 'Ada', createdAt: T0 }] });
  const lone = await openCat(one);
  assert.equal(lone.hidden, true, 'one conversation: nothing to go back to');
  assert.equal(one.count('GET', '/xbot-api/bots/Ada/conversations'), 1);
  one.ws.observe(ada, 'thread-A', true);
  one.draw();
  await settle();
  assert.equal(one.count('GET', '/xbot-api/bots/Ada/conversations'), 1, 'the same thread again reads nothing more');
  // A conversation started elsewhere: the transcript names its thread, the list is read again, and the fold appears.
  one.server.list.push({ id: 'thread-N', title: 'Ada', createdAt: T0 + 5000 });
  one.server.thread = 'thread-N';
  one.ws.observe(ada, 'thread-N', true);
  await settle();
  assert.equal(lone.hidden, false);
  assert.deepEqual(rowsOf(lone).map(r => [r.tagName, r.getAttribute('aria-current')]), [['DIV', 'true'], ['BUTTON', null]]);

  const p = historyCat();
  const node = await openCat(p);
  assert.equal(node.hidden, false);
  const fold = foldOf(node, 'ws-conv-fold');
  assert.equal(fold.open, false, 'folded at first');
  assert.equal(textOf(fold.firstChild as El), '历史对话 · 2');
  assert.deepEqual(rowsOf(node).map(r => [r.tagName, textOf(r.querySelector('.ws-conv-title')!), r.getAttribute('aria-current')]),
    [['DIV', 'Ada', 'true'], ['BUTTON', '官网改版', null]]);
  assert.match(textOf(rowFor(node, 'Ada')), /当前对话$/);
  assert.match(rowFor(node, '官网改版').getAttribute('aria-label')!, /^切换到「官网改版」，开始于 /);
  // Only the saved conversations: no new conversation, no project, no rename or delete.
  const controls = all(node).filter(e => e.tagName === 'BUTTON');
  assert.ok(controls.length === 1 && controls[0] === rowFor(node, '官网改版'), 'the only control is the other conversation');
  assert.doesNotMatch(textOf(node), /新建|项目|工作区/);
  assert.equal(p.ws.threadId(), 'thread-A', 'the open conversation stays as it was');
  assert.equal(p.count('PUT', '/xbot-api/bots/Ada/conversation'), 0);

  // An older backend without saved conversations: no fold and no error.
  const old = page(path => { if (path.endsWith('/conversations')) throw failure(404, 'Not found'); return path.endsWith('/workspace') ? view() : { threadId: 'thread-A', tasks: [], cats }; });
  old.ws.select(ada);
  old.ws.observe(ada, 'thread-A', true);
  const none = old.ws.conversationsView(ada) as El;
  old.panel.append(none);
  await settle();
  assert.equal(none.hidden, true);
  assert.doesNotMatch(textOf(none), /没能|失败/);
});

test('opening a saved conversation names the thread it saw; a busy refusal stays put and says why; success reopens the chat there', async () => {
  const p = historyCat();
  const node = await openCat(p);
  await setFold(foldOf(node, 'ws-conv-fold'), true);
  p.server.busy.add('thread-P');
  const reads = () => [p.count('GET', '/xbot-api/bots/Ada/conversations'), p.count('GET', '/xbot-api/bots/Ada/workspace')];
  const before = reads();
  rowFor(node, '官网改版').focus();
  rowFor(node, '官网改版').click();
  await settle();
  const put = p.calls.find(c => c.method === 'PUT')!;
  assert.equal(put.path, '/xbot-api/bots/Ada/conversation');
  assert.deepEqual(put.body, { threadId: 'thread-P', expectedThreadId: 'thread-A' });
  assert.equal(textOf(convLine(node)), '请先完成或停止会话中的任务');
  assert.equal(convLine(node).getAttribute('role'), 'alert');
  assert.deepEqual(p.reselected, [], 'a refused switch leaves the chat where it was');
  assert.equal(p.ws.threadId(), 'thread-A');
  assert.deepEqual(reads().map((n, i) => n - before[i]), [1, 1], 'the list and the view are read again after a refusal');
  same(p.doc.activeElement, rowFor(node, '官网改版'), 'focus stays on the row');

  p.server.busy.clear();
  rowFor(node, '官网改版').click();
  await settle();
  assert.deepEqual(p.calls.filter(c => c.method === 'PUT').at(-1)!.body, { threadId: 'thread-P', expectedThreadId: 'thread-A' });
  assert.deepEqual(p.toasts, ['已切换到「官网改版」']);
  assert.deepEqual(p.reselected, [ada], 'the cat\'s chat opens afresh, in that thread');
  // The shell's transcript read names the thread and 详情 is drawn again: the other conversation is now the current one.
  const lists = p.count('GET', '/xbot-api/bots/Ada/conversations');
  p.ws.observe(ada, 'thread-P', true);
  const next = p.draw()!;
  const nextFold = foldOf(next, 'ws-conv-fold');
  assert.equal(nextFold.open, true, 'the fold left open stays open for this cat');
  nextFold.dispatchEvent(new Ev('toggle')); // as a browser does for a fold created open
  await settle();
  assert.equal(p.count('GET', '/xbot-api/bots/Ada/conversations'), lists + 1, 'the new page reads the list once');
  assert.ok(next !== node, 'a new conversation, a new page');
  assert.equal(p.ws.threadId(), 'thread-P');
  assert.deepEqual(rowsOf(next).map(r => [textOf(r.querySelector('.ws-conv-title')!), r.tagName]), [['Ada', 'BUTTON'], ['官网改版', 'DIV']]);
  same(p.doc.activeElement, rowFor(next, '官网改版'), 'focus lands on the conversation now open');
  assert.ok(!p.calls.some(c => c.path.includes('/projects') || (c.method === 'PUT' && c.path.endsWith('/workspace')) || c.path.endsWith('/new')), 'never a project, a workspace switch or a new thread');
});

test('files waiting to be sent are asked about first: keeping them sends nothing, switching drops them with the old thread', async () => {
  const p = historyCat();
  const node = await openCat(p);
  p.ws.addFiles([file('notes.md', 10)]);
  await settle();
  assert.equal(p.ws.attachReady(), 1);
  rowFor(node, '官网改版').click();
  await settle();
  let dialog = all(p.doc.body).find(e => e.classList.contains('ws-modal'))!;
  assert.match(textOf(dialog), /^切换对话/);
  assert.match(textOf(dialog), /切换到「官网改版」后，待发送的 1 个附件会被移除：附件只属于上传时的对话。/);
  button(dialog, '取消').click();
  await settle();
  assert.equal(p.count('PUT', '/xbot-api/bots/Ada/conversation'), 0, 'kept: nothing was asked');
  assert.equal(p.ws.attachReady(), 1);
  same(p.doc.activeElement, rowFor(node, '官网改版'), 'focus returns to the row');

  rowFor(node, '官网改版').click();
  await settle();
  dialog = all(p.doc.body).find(e => e.classList.contains('ws-modal'))!;
  button(dialog, '仍然切换').click();
  await settle();
  assert.deepEqual(p.calls.find(c => c.method === 'PUT')!.body, { threadId: 'thread-P', expectedThreadId: 'thread-A' });
  assert.deepEqual(p.reselected, [ada]);
  assert.equal(p.ws.attachReady(), 0, 'the files belonged to the thread left behind');
  assert.equal(p.chips().length, 0);
});

test('a confirmation left open across a move asks from the thread the chat is in now', async () => {
  const p = historyCat();
  const node = await openCat(p);
  p.ws.addFiles([file('notes.md', 10)]);
  await settle();
  rowFor(node, '官网改版').click();
  await settle();
  const dialog = all(p.doc.body).find(e => e.classList.contains('ws-modal'))!;
  // Meanwhile a conversation started elsewhere moves the cat; the transcript read sees it.
  p.server.list.push({ id: 'thread-N', title: '新的对话', createdAt: T0 + 9000 });
  p.server.thread = 'thread-N';
  p.ws.observe(ada, 'thread-N', true);
  await settle();
  assert.equal(p.ws.attachReady(), 0, 'the move already dropped the files of thread A');
  button(dialog, '仍然切换').click();
  await settle();
  assert.deepEqual(p.calls.filter(c => c.method === 'PUT').map(c => c.body), [{ threadId: 'thread-P', expectedThreadId: 'thread-N' }]);
  assert.deepEqual(p.reselected, [ada]);
});

test('a switch whose answer comes after the transcript already showed that thread reopens nothing', async () => {
  const p = historyCat();
  const node = await openCat(p);
  const gate = deferred();
  p.server.gate = gate.promise;
  rowFor(node, '官网改版').click();
  await settle();
  // The server has switched; a transcript poll gets there before the answer does.
  assert.equal(p.server.thread, 'thread-P');
  p.ws.observe(ada, 'thread-P', true);
  await settle();
  assert.equal(p.ws.threadId(), 'thread-P');
  gate.resolve(undefined);
  await settle();
  assert.deepEqual(p.reselected, [], 'already there: the chat is not opened again');
  assert.deepEqual(p.toasts, ['已切换到「官网改版」']);
  assert.deepEqual(rowsOf(node).map(r => [textOf(r.querySelector('.ws-conv-title')!), r.tagName]), [['Ada', 'BUTTON'], ['官网改版', 'DIV']]);
  assert.ok(rowsOf(node).every(r => !r.disabled), 'the rows are usable again');
});

test('a send in progress holds the switch; while one is out no file joins the old thread; an answer after another cat opened lands nowhere', async () => {
  let sending = true;
  const p = historyCat({ hooks: { busy: () => sending } });
  const node = await openCat(p);
  rowFor(node, '官网改版').click();
  await settle();
  assert.equal(p.count('PUT', '/xbot-api/bots/Ada/conversation'), 0);
  assert.equal(textOf(convLine(node)), '这条消息还在发送，发出后再切换。');

  sending = false;
  const gate = deferred();
  p.server.gate = gate.promise;
  rowFor(node, '官网改版').click();
  await settle();
  assert.equal(p.count('PUT', '/xbot-api/bots/Ada/conversation'), 1);
  assert.equal(convLine(node).hidden, true, 'the earlier note is gone');
  assert.match(textOf(rowFor(node, '官网改版')), /正在切换…/);
  assert.ok(rowsOf(node).filter(r => r.tagName === 'BUTTON').every(r => r.disabled), 'one switch at a time');
  assert.equal(labelled(p.doc.body, '添加附件').disabled, true);
  p.ws.addFiles([file('late.md', 10)]);
  await settle();
  assert.equal(p.chips().length, 0);
  assert.equal(p.doc.getElementById('attach-note')!.textContent, '正在切换对话，切换好后再添加附件。');
  assert.equal(p.fetches.length, 0, 'nothing uploads to the thread being left');

  // The owner opens another cat before the answer comes.
  p.ws.select(bob);
  gate.resolve(undefined);
  await settle();
  assert.deepEqual(p.toasts, []);
  assert.deepEqual(p.reselected, [], 'Bob\'s chat is not replaced by Ada\'s');
  assert.equal(labelled(p.doc.body, '添加附件').disabled, false);
});

test('the same thread refreshed keeps the composer and the fold; reopening 历史对话 reads only the list; an older list answer lands nowhere', async () => {
  const p = historyCat();
  const node = await openCat(p);
  p.ws.addFiles([file('notes.md', 10)]);
  await settle();
  const counts = () => ['conversations', 'workspace', 'files', 'tasks'].map(r => p.count('GET', '/xbot-api/bots/Ada/' + r));
  let before = counts();
  // Transcript polls of the same thread and redraws of 详情: same node, nothing asked again, nothing dropped.
  for (let i = 0; i < 3; i++) { p.ws.observe(ada, 'thread-A', false); same(p.draw(), node, 'the same node each time'); }
  await settle();
  assert.deepEqual(counts().map((n, i) => n - before[i]).slice(0, 2), [0, 0]);
  assert.equal(p.ws.attachReady(), 1);
  assert.equal(p.ws.threadId(), 'thread-A');

  // Opening the fold reads the list again, and only the list; the fold stays open across redraws.
  const fold = foldOf(node, 'ws-conv-fold');
  before = counts();
  await setFold(fold, true);
  assert.deepEqual(counts().map((n, i) => n - before[i]), [1, 0, 0, 0]);
  assert.equal(p.ws.attachReady(), 1);
  assert.equal(p.count('PUT', '/xbot-api/bots/Ada/conversation'), 0);
  same(p.draw(), node, 'the same node again');
  assert.equal(fold.open, true);

  // A list read is still out when a conversation started elsewhere moves the cat:
  // the move reads the list again, and the older answer does not land.
  p.server.holdList = true;
  await setFold(fold, false);
  await setFold(fold, true);
  p.server.list.push({ id: 'thread-N', title: '新的对话', createdAt: T0 + 9000 });
  p.server.thread = 'thread-N';
  p.ws.observe(ada, 'thread-N', true);
  await settle();
  assert.equal(p.ws.attachReady(), 0, 'the move drops files of the thread left behind');
  assert.match(p.doc.getElementById('attach-note')!.textContent, /会话已更换/);
  const now = () => rowsOf(node).map(r => [textOf(r.querySelector('.ws-conv-title')!), r.tagName]);
  assert.deepEqual(now(), [['新的对话', 'DIV'], ['Ada', 'BUTTON'], ['官网改版', 'BUTTON']]);
  p.server.releaseList();
  await settle();
  assert.deepEqual(now(), [['新的对话', 'DIV'], ['Ada', 'BUTTON'], ['官网改版', 'BUTTON']], 'the older list does not take the mark back');
  assert.equal(textOf(fold.firstChild as El), '历史对话 · 3');
});

test('a row keeps focus when 详情 is drawn again; after a press elsewhere a redraw leaves focus alone', async () => {
  const p = historyCat();
  const node = await openCat(p);
  await setFold(foldOf(node, 'ws-conv-fold'), true);
  const target = rowFor(node, '官网改版');
  target.focus();
  p.draw();
  same(p.doc.activeElement, p.doc.body, 'the redraw took the row off the page for a moment');
  await settle();
  same(p.doc.activeElement, target, 'focus is back on the same row');
  // A press elsewhere ends that: the next redraw does not pull focus back.
  p.doc.dispatch(p.doc.getElementById('input')!, new Ev('pointerdown'));
  p.draw();
  await settle();
  same(p.doc.activeElement, p.doc.body, 'focus is left alone');
  // Tabbing out of the fold ends it too.
  target.focus();
  p.doc.getElementById('input')!.tabIndex = 0;
  p.doc.getElementById('input')!.focus();
  p.draw();
  await settle();
  same(p.doc.activeElement, p.doc.getElementById('input'), 'focus stays where the owner moved it');
});

// ---------------------------------------------------------------- thread moves
// One cat whose native thread moves under the open page (a new conversation
// started elsewhere, or a switch made in another tab). The fake server answers
// each request for the thread it ran in when the request was made, with a
// serial so that a stale answer shows; hold(route) keeps the next answer to
// that route back until release(route), which may also answer as if the
// server had been in another thread by then.
function movingCat() {
  const server = { thread: 'thread-A' };
  const holding = new Set<string>();
  const held = new Map<string, Array<(at?: string) => void>>();
  let reads = 0;
  const reply = (path: string, method: string, body: Any, at: string, n: number): unknown => {
    if (path === '/xbot-api/bots/Ada/workspace') return view({ threadId: at });
    if (path === '/xbot-api/bots/Ada/files') return { threadId: at, files: [served({ id: `f-${at}-${n}`, threadId: at, name: `${at}-${n}.md` })] };
    if (path === '/xbot-api/bots/Ada/workspace-tree') return { entries: [{ name: `${at}-notes.md`, path: 'notes.md', type: 'file', size: 10 }] };
    if (path === '/xbot-api/bots/Ada/tasks' && method === 'GET') return { threadId: at, tasks: [task({ id: `t-${at}`, threadId: at, title: `${at} 的任务 ${n}` })], cats, historyAvailable: true };
    if (method === 'POST' && body.expectedThreadId !== at) throw failure(409, '会话已变化，请刷新后重试');
    if (path === '/xbot-api/bots/Ada/deliverables') return { file: served({ id: `d-${at}`, threadId: at, kind: 'deliverable', name: `${at}-delivered.md` }) };
    throw failure(404, 'unexpected ' + method + ' ' + path);
  };
  const later = (key: string, answer: (at?: string) => unknown) => {
    const d = deferred<Any>();
    held.set(key, [...(held.get(key) ?? []), (at) => { try { d.resolve(answer(at)); } catch (e) { d.reject(e); } }]);
    return d.promise;
  };
  const route: Route = (path, method, body) => {
    const key = method + ' ' + path.split('?')[0], at = server.thread, n = ++reads;
    const answer = (as = at) => reply(path.split('?')[0], method, body, as, n);
    return holding.delete(key) ? later(key, answer) : answer();
  };
  const upload = (path: string) => {
    const q = new URLSearchParams(path.split('?')[1]), at = server.thread;
    const answer = (as = at) => (q.get('expectedThreadId') === as ? json(201, { file: served({ id: 'up-' + q.get('name'), threadId: as, name: q.get('name') }) }) : json(409, { error: '会话已变化，请刷新后重试' }));
    return holding.delete('UPLOAD') ? later('UPLOAD', answer) : answer();
  };
  let repaint = () => {};
  const p = page(route, upload, { repaintPanel: () => repaint() });
  const filesHost = p.doc.createElement('div'), tasksHost = p.doc.createElement('div');
  p.panel.append(filesHost, tasksHost);
  // As the shell does with an open drawer: draw the module's pages that are on
  // screen, keeping a live one in place; a page off screen is not drawn.
  const shown = { files: true, tasks: true };
  repaint = () => {
    if (shown.files) { const pane = p.ws.filesView(ada); if (filesHost.firstChild !== pane) filesHost.replaceChildren(pane); }
    if (shown.tasks) { const pane = p.ws.tasksView(ada); if (tasksHost.firstChild !== pane) tasksHost.replaceChildren(pane); }
  };
  const leave = (kind: 'files' | 'tasks') => { shown[kind] = false; (kind === 'files' ? filesHost : tasksHost).replaceChildren(); };
  const back = (kind: 'files' | 'tasks') => { shown[kind] = true; repaint(); };
  const release = async (key: string, at?: string) => { const list = held.get(key) ?? []; held.delete(key); for (const go of list) go(at); await settle(); };
  const count = (method: string, path: string) => p.calls.filter(c => c.method === method && c.path.split('?')[0] === path).length;
  const out = (key: string) => (held.get(key) ?? []).length;
  return { ...p, server, hold: (key: string) => { holding.add(key); }, unhold: (key: string) => { holding.delete(key); }, release, out, repaint, leave, back, filesHost, tasksHost, count };
}
const opened = async (p: ReturnType<typeof movingCat>) => {
  p.ws.select(ada);
  p.repaint();
  p.ws.observe(ada, 'thread-A', true);
  await settle();
  // 更多文件 open: the working directory is read too, and stays open across moves.
  await setFold(foldOf(p.filesHost, 'ws-more'), true);
  assert.equal(p.ws.threadId(), 'thread-A');
  assert.match(textOf(p.tasksHost), /thread-A 的任务/);
  assert.match(textOf(p.filesHost), /thread-A-\d+\.md/);
  assert.match(textOf(p.filesHost), /thread-A-notes\.md/);
};

test('a move to another thread of the same cat ends the old one: late A reads cannot take it back and A changes paint nothing in B', async () => {
  const p = movingCat();
  await opened(p);
  // Out in thread A when the conversation moves: a files and a Task read, a deliverable and an upload.
  p.hold('GET /xbot-api/bots/Ada/files');
  labelled(p.filesHost, '刷新文件').click();
  p.hold('GET /xbot-api/bots/Ada/tasks');
  labelled(p.tasksHost, '刷新任务').click();
  p.hold('POST /xbot-api/bots/Ada/deliverables');
  button(p.filesHost, '存为交付物').click();
  p.hold('UPLOAD');
  p.ws.addFiles([file('a.md', 10)]);
  await settle();
  for (const key of ['GET /xbot-api/bots/Ada/files', 'GET /xbot-api/bots/Ada/tasks', 'POST /xbot-api/bots/Ada/deliverables', 'UPLOAD']) assert.equal(p.out(key), 1, key + ' is out');
  assert.deepEqual(p.calls.filter(c => c.method === 'POST').map(c => c.body.expectedThreadId), ['thread-A']);
  assert.match(p.fetches.at(-1)!.path, /expectedThreadId=thread-A$/);

  // The transcript read finds the cat in thread B.
  p.server.thread = 'thread-B';
  p.ws.observe(ada, 'thread-B', true);
  await settle();
  assert.equal(p.ws.threadId(), 'thread-B');
  assert.equal(p.chips().length, 0, 'the upload to A left with the move');
  assert.match(p.doc.getElementById('attach-note')!.textContent, /会话已更换/);
  assert.match(textOf(p.tasksHost), /thread-B 的任务/);
  assert.match(textOf(p.filesHost), /thread-B-\d+\.md/);
  assert.equal(foldOf(p.filesHost, 'ws-more').open, true, '更多文件 stays open for the same conversation');
  assert.match(textOf(p.filesHost), /thread-B-notes\.md/);
  p.ws.addFiles([file('b.md', 20)]);
  await settle();
  assert.equal(p.ws.attachReady(), 1);
  const reads = p.calls.length;

  // Every answer asked in A arrives now, the upload's too.
  for (const key of ['GET /xbot-api/bots/Ada/files', 'GET /xbot-api/bots/Ada/tasks', 'POST /xbot-api/bots/Ada/deliverables', 'UPLOAD']) await p.release(key);
  assert.equal(p.ws.threadId(), 'thread-B', 'a late A list does not take the conversation back');
  assert.match(textOf(p.tasksHost), /thread-B 的任务/);
  assert.doesNotMatch(textOf(p.tasksHost), /thread-A/, 'A\'s Tasks do not paint in B');
  assert.doesNotMatch(textOf(p.filesHost), /thread-A/, 'nor A\'s files or its deliverable');
  assert.equal(button(p.filesHost, '存为交付物').getAttribute('aria-label'), '把 thread-B-notes.md 存为交付物', 'B\'s file is not marked by A\'s snapshot');
  assert.ok(!p.toasts.some(t => /已存为交付物/.test(t)));
  assert.equal(p.ws.attachReady(), 1, 'the file added in B stays');
  assert.deepEqual(plain(p.chips().map(c => c.getAttribute('aria-label'))), ['b.md，20 B']);
  assert.equal(p.ws.takeAttachments().threadId, 'thread-B');
  assert.equal(p.calls.length, reads, 'and none of them reads anything again');
});

test('one cat moving thread after thread: each confirmed move reads its lists once, back to A included, and no earlier answer lands', async () => {
  const p = movingCat();
  await opened(p);
  const counts = () => ['/workspace', '/files', '/tasks'].map(r => p.count('GET', '/xbot-api/bots/Ada' + r));
  for (const next of ['thread-B', 'thread-C', 'thread-A']) {
    // A files and a Task read are still out in the thread being left.
    p.hold('GET /xbot-api/bots/Ada/files');
    labelled(p.filesHost, '刷新文件').click();
    p.hold('GET /xbot-api/bots/Ada/tasks');
    labelled(p.tasksHost, '刷新任务').click();
    await settle();
    const before = counts();
    p.server.thread = next;
    p.ws.observe(ada, next, true);
    await settle();
    assert.equal(p.ws.threadId(), next);
    assert.deepEqual(counts().map((n, i) => n - before[i]), [1, 1, 1], next + ': its view, files and Tasks are read once');
    assert.match(textOf(p.tasksHost), new RegExp(next + ' 的任务'));
    assert.match(textOf(p.filesHost), new RegExp(next + '-\\d+\\.md'));
    for (const other of ['thread-A', 'thread-B', 'thread-C'].filter(x => x !== next)) {
      assert.doesNotMatch(textOf(p.tasksHost) + textOf(p.filesHost), new RegExp(other), next + ' shows nothing of ' + other);
    }
  }
  // The six answers left behind arrive, oldest first; two are thread-A's own, from before the moves.
  const shown = [textOf(p.tasksHost), textOf(p.filesHost)], calls = p.calls.length;
  assert.equal(p.out('GET /xbot-api/bots/Ada/files') + p.out('GET /xbot-api/bots/Ada/tasks'), 6);
  await p.release('GET /xbot-api/bots/Ada/files');
  await p.release('GET /xbot-api/bots/Ada/tasks');
  assert.equal(p.ws.threadId(), 'thread-A');
  assert.deepEqual([textOf(p.tasksHost), textOf(p.filesHost)], shown, 'nothing asked before the last move paints, the same thread\'s older read neither');
  await settle(20);
  assert.equal(p.calls.length, calls, 'and nothing is read again because of them');
});

test('a list answered for another thread never moves the conversation: the workspace view is asked once and settles it', async () => {
  const p = movingCat();
  await opened(p);
  const views = () => p.count('GET', '/xbot-api/bots/Ada/workspace');
  // The server moved on before this page heard of it: a Task read asked in A answers for B.
  p.hold('GET /xbot-api/bots/Ada/tasks');
  labelled(p.tasksHost, '刷新任务').click();
  await settle();
  p.server.thread = 'thread-B';
  p.hold('GET /xbot-api/bots/Ada/workspace');
  const before = views();
  await p.release('GET /xbot-api/bots/Ada/tasks', 'thread-B');
  assert.equal(p.ws.threadId(), 'thread-A', 'a Task list does not move the conversation');
  assert.match(textOf(p.tasksHost), /thread-A 的任务/);
  assert.doesNotMatch(textOf(p.tasksHost), /thread-B/, 'nor paints B\'s Tasks in A');
  assert.equal(views(), before + 1, 'the workspace view is asked whether it moved');
  await p.release('GET /xbot-api/bots/Ada/workspace');
  assert.equal(p.ws.threadId(), 'thread-B', 'the canonical read moves it');
  assert.match(textOf(p.tasksHost), /thread-B 的任务/);
  assert.equal(views(), before + 1, 'a move the view found is not asked about again');

  // A list that disagrees with a view that does not move: dropped, asked about once, no chase.
  p.hold('GET /xbot-api/bots/Ada/tasks');
  labelled(p.tasksHost, '刷新任务').click();
  await settle();
  const shown = textOf(p.tasksHost), calls = p.calls.length;
  await p.release('GET /xbot-api/bots/Ada/tasks', 'thread-C');
  await settle(20);
  assert.equal(p.ws.threadId(), 'thread-B');
  assert.equal(textOf(p.tasksHost), shown);
  assert.deepEqual(p.calls.slice(calls).map(c => c.method + ' ' + c.path), ['GET /xbot-api/bots/Ada/workspace'], 'one view read and nothing more');
});

test('the first reads go out together: a Task list that answers before the thread is known stays only if it is that thread\'s', async () => {
  const p = movingCat();
  const tasksRead = () => p.count('GET', '/xbot-api/bots/Ada/tasks');
  // The usual start: the Task list answers before the view, for the same thread.
  p.hold('GET /xbot-api/bots/Ada/workspace');
  p.ws.select(ada);
  await settle();
  assert.equal(p.ws.threadId(), '', 'a Task list does not name the thread');
  await p.release('GET /xbot-api/bots/Ada/workspace');
  assert.equal(p.ws.threadId(), 'thread-A');
  p.repaint();
  await settle();
  assert.match(textOf(p.tasksHost), /thread-A 的任务 2/, 'the list read alongside the view is kept');
  assert.equal(tasksRead(), 1);
  assert.equal(p.count('GET', '/xbot-api/bots/Ada/workspace'), 1);

  // Asked before the view named B, a Task list answers for A: dropped, and the view is asked once.
  p.server.thread = 'thread-B';
  p.hold('GET /xbot-api/bots/Ada/workspace');
  p.hold('GET /xbot-api/bots/Ada/tasks');
  p.ws.select(ada);
  await settle();
  await p.release('GET /xbot-api/bots/Ada/workspace');
  assert.equal(p.ws.threadId(), 'thread-B');
  const calls = p.calls.length;
  await p.release('GET /xbot-api/bots/Ada/tasks', 'thread-A');
  assert.equal(p.ws.threadId(), 'thread-B');
  assert.deepEqual(p.calls.slice(calls).map(c => c.method + ' ' + c.path), ['GET /xbot-api/bots/Ada/workspace']);
  p.repaint();
  await settle();
  assert.match(textOf(p.tasksHost), /thread-B 的任务/);
  assert.doesNotMatch(textOf(p.tasksHost) + textOf(p.filesHost), /thread-A/);
});

test('a late first answer cannot take the thread back from the transcript read that named it', async () => {
  const p = movingCat();
  const views = () => p.count('GET', '/xbot-api/bots/Ada/workspace');
  // The pages ask for A's Tasks before any read names the thread; then the cat is found in B.
  p.hold('GET /xbot-api/bots/Ada/workspace');
  p.ws.select(ada);
  p.repaint();
  await settle();
  assert.match(textOf(p.tasksHost), /thread-A 的任务/);
  assert.equal(p.ws.threadId(), '');
  p.server.thread = 'thread-B';
  p.ws.observe(ada, 'thread-B', true);
  await settle();
  assert.equal(p.ws.threadId(), 'thread-B');
  assert.match(textOf(p.tasksHost), /thread-B 的任务/, 'A\'s Tasks, read before the thread was known, are read again for B');
  assert.doesNotMatch(textOf(p.tasksHost) + textOf(p.filesHost), /thread-A/);
  await p.release('GET /xbot-api/bots/Ada/workspace');
  assert.equal(p.ws.threadId(), 'thread-B', 'the first view, asked in A, is superseded');
  assert.equal(views(), 2);

  // No list out this time: the transcript names B while the first view is out, and that view answers for A.
  p.hold('GET /xbot-api/bots/Ada/workspace');
  p.ws.select(ada);
  await settle();
  p.ws.observe(ada, 'thread-B', true);
  await settle();
  await p.release('GET /xbot-api/bots/Ada/workspace', 'thread-A');
  assert.equal(p.ws.threadId(), 'thread-B', 'it cannot say which is newer, so it does not move the thread');
  assert.equal(views(), 4, 'it is asked again, once');
  p.repaint();
  await settle(20);
  assert.match(textOf(p.tasksHost), /thread-B 的任务/);
  assert.equal(views(), 4);
});

// ---------------------------------------------------------------- wiring
test('the page loads the workspace scripts before app.js and their styles last; the shell wires 文件, 历史对话 and the composer, and no longer posts to the retired paste route', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/workspace.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('runtime-tasks.js') >= 0 && at('runtime-tasks.js') < at('workspace.js'));
  assert.ok(at('workspace-rules.js') < at('workspace.js') && at('workspace.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  // After every upstream and earlier style; only the status-line/memory extension (which builds on it) follows.
  assert.ok(styles.indexOf('workspace.css') > styles.indexOf('chat-presentation.css'));
  assert.deepEqual(styles.slice(styles.indexOf('workspace.css') + 1), ['chat-experience.css']);
  assert.doesNotMatch(app, /\/paste"/);
  assert.match(app, /\["files", "文件"\]/);
  // 详情 appends the module's 历史对话 node only when it gives one (cats, never groups).
  const details = /function detailsView\(data\) \{[\s\S]*?\n {2}\}\n/.exec(app)![0];
  assert.match(details, /const history = workspace\.conversationsView\(state\.sel\);\n\s+if \(history\) wrap\.append\(history\);/);
  // Only existing tokens: no new colour literal in the module's styles.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.doesNotMatch(css, /\.ws-chip|\.ws-menu|\.ws-ctx|\.ws-project-field|\.wst-create|\.ws-add/);
});

test('a cat\'s SILENT is never shown as words: a bare one is not drawn, one that brought files or pictures keeps its cards, in single chats, groups and routines', () => {
  const app = read('client/public/app.js');
  // app.js's own helpers and bubble, run with the shell's drawing calls faked.
  const helpers = /\n {2}const isSilent = [^\n]+\n {2}const hasMedia = [^\n]+\n {2}const silentOnly = [^\n]+\n/.exec(app);
  const bubble = /\n {2}function botBubble\(m, say, messages, who, cont, last = true\) \{\n[\s\S]*?\n {2}\}\n/.exec(app);
  assert.ok(helpers && bubble, 'the helpers and botBubble are where the shell keeps them');
  type Node = { tag: string; cls: string; kids: Any[]; dataset: Record<string, string>; append: (...k: Any[]) => void };
  const el = (tag: string, cls = ''): Node => ({ tag, cls, kids: [], dataset: {}, append(...k: Any[]) { this.kids.push(...k); } });
  const out: Any = {};
  vm.runInNewContext(helpers[0] + bubble[0] + 'out.isSilent = isSilent; out.silentOnly = silentOnly; out.botBubble = botBubble;', {
    out, el, state: { sel: null }, EMPTY_REPLY: '（空回复）',
    speakerFace: () => ({ face: true }), speakerHead: () => ({ head: true }), quoteBlock: () => ({ quote: true }),
    pastedURLs: (_sel: unknown, images: string[] | undefined) => images || [],
    gallery: (list: string[]) => ({ gallery: list }),
    appendBotContent: (body: Node, text: string) => body.append({ said: text }),
    displayText: (text: string) => text,
    workspace: { cards: (files: Array<{ name: string }>) => ({ cards: files.map(f => f.name) }) },
    window: { XBotProviders: { citedText: (content: string) => content, decorate: () => {} } },
    bindMessageMenu: (row: Node, _m: unknown, text: string) => { row.dataset.copy = text; },
    markContinuation: () => {}, addBubbleTime: () => {},
  });
  // Only a bare SILENT is left out.
  assert.equal(out.silentOnly({ content: ' SILENT \n' }), true);
  assert.equal(out.silentOnly({ content: 'SILENT', attachments: [{ id: 'f1' }] }), false);
  assert.equal(out.silentOnly({ content: 'SILENT', images: ['p.png'] }), false);
  assert.equal(out.silentOnly({ content: 'SILENT 了' }), false);
  const who = { key: 'cat-a', name: '宪宪' };
  const body = (row: Node) => row.kids.find((k: Node) => k.cls === 'body') as Node;
  const said = (row: Node) => body(row).kids.filter((k: Any) => 'said' in k).map((k: Any) => k.said);
  const cards = (row: Node) => body(row).kids.filter((k: Any) => 'cards' in k).flatMap((k: Any) => k.cards);
  const report = { id: 'm1', native_message_id: 'm1', role: 'assistant', content: 'SILENT', attachments: [{ id: 'f1', name: 'report.txt' }] };
  // A native delivery: the receipt carries SILENT as its text; the card stays, the word does not.
  const native = out.botBubble(report, { text: 'SILENT', images: [] }, [], who, false, true);
  assert.deepEqual([said(native), cards(native), native.dataset.mid, native.dataset.copy], [[], ['report.txt'], 'm1', '']);
  // An older line drawn from its content: the same, and not an empty-reply placeholder either.
  const legacy = out.botBubble(report, null, [], who, false, true);
  assert.deepEqual([said(legacy), cards(legacy)], [[], ['report.txt']]);
  // Words still show with their files.
  const both = out.botBubble({ ...report, content: '写好了' }, { text: '写好了', images: [] }, [], who, false, true);
  assert.deepEqual([said(both), cards(both)], [['写好了'], ['report.txt']]);
  // The history leaves out only the bare SILENT; groups and routines follow the same rule.
  assert.match(app, /if \(m\.role === "assistant" && silentOnly\(m\)\) return;/);
  assert.doesNotMatch(app, /=== "SILENT" && !\(m\.images \|\| \[\]\)\.length\) return;/);
  assert.match(app, /if \(!mine && isSilent\(text\) && !\(m\.attachments \|\| \[\]\)\.length\) continue;/);
  assert.match(app, /const said = isSilent\(text\) \? "" : text;\n\s+if \(said \|\| !files\.length\) appendBotContent\(body, said\);/);
  assert.match(app, /if \(silentOnly\(m\)\) \{ hidden\.add\(wake\.i\); hidden\.add\(i\); \}/);
});
