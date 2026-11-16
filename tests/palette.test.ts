import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Search and jump (palette-rules.js, palette.js; search contract
// docs/xbot-api.md「搜索」). The rules run in a bare VM; the DOM module runs as
// the classic script it is, on a small DOM (tree, attributes, focus, bubbling
// key events, a selector subset) with fake timers. app.js is not loaded: its
// hooks are faked the way it passes them to init(), and static checks cover
// its wiring.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/palette-rules.js'), { window });
  return window.ClowderPaletteRules;
}
const chatsFixture = () => [
  { type: 'bot', id: '团子', name: '团子', nativeId: 'cat-1' },
  { type: 'bot', id: 'Ada Lovelace', name: 'Ada Lovelace', nativeId: 'cat-2' },
  { type: 'bot', id: '大团子', name: '大团子', nativeId: 'cat-3' },
  { type: 'group', id: 'g-1', name: '读书会', members: ['团子', 'Ada Lovelace'] },
  { type: 'group', id: 'g-2', name: '团子小队', members: ['大团子'] },
];

// ------------------------------------------------------------------ rules
test('names are matched best first (whole, start, a later word, anywhere), ties keep the sidebar order, a group also answers to a member after every name match', () => {
  const R = rules();
  const found = R.chats(chatsFixture(), '团子').map((f: Any) => [f.chat.id, f.range, f.via]);
  assert.deepEqual(plain(found), [
    ['团子', [0, 2], ''],      // the whole name
    ['g-2', [0, 2], ''],       // starts with it
    ['大团子', [1, 3], ''],     // inside it
    ['g-1', null, '团子'],      // a member's name, after every name match
  ]);
  assert.deepEqual(plain(R.chats(chatsFixture(), 'love').map((f: Any) => [f.chat.id, f.range])), [['Ada Lovelace', [4, 8]], ['g-1', null]], 'a later word, case ignored');
  assert.deepEqual(plain(R.match('Ada Lovelace', 'ADA')), { score: 3, range: [0, 3] });
  assert.equal(R.match('Ada', '').score, 0);
  assert.deepEqual(plain(R.chats(chatsFixture(), '   ')), [], 'nothing typed matches nothing');
  // An empty query: the sidebar's first chats without the open one.
  const order = ['group:g-1', 'bot:大团子', 'bot:团子'];
  const sorted = R.ordered(chatsFixture(), order);
  assert.deepEqual(sorted.map((c: Any) => c.id), ['g-1', '大团子', '团子', 'Ada Lovelace', 'g-2'], 'chats the sidebar does not show keep their order after');
  assert.deepEqual(R.recent(sorted, 'bot:大团子', 3).map((c: Any) => c.id), ['g-1', '团子', 'Ada Lovelace']);
});

test('actions apply only where their when() says so and answer by label or by one of their words; an empty query lists them all', () => {
  const R = rules();
  const list = [
    { id: 'new-cat', label: '新建猫猫', keywords: ['添加'], run() {} },
    { id: 'theme', label: '切换深浅色', keywords: ['主题', '夜间'], run() {} },
    { id: 'new-chat', label: '新对话', when: (c: Any) => c.selection && c.selection.type === 'bot', run() {} },
    { id: 'broken', label: '坏的', when: () => { throw new Error('x'); }, run() {} },
  ];
  assert.deepEqual(R.actions(list, '', {}).map((a: Any) => a.action.id), ['new-cat', 'theme'], 'no open cat: no 新对话; a throwing when() hides the action');
  assert.deepEqual(R.actions(list, '', { selection: { type: 'bot', id: 'x' } }).map((a: Any) => a.action.id), ['new-cat', 'theme', 'new-chat']);
  assert.deepEqual(plain(R.actions(list, '夜间', {}).map((a: Any) => [a.action.id, a.range])), [['theme', null]], 'a word finds it without marking the label');
  assert.deepEqual(plain(R.actions(list, '深浅', {}).map((a: Any) => [a.action.id, a.range])), [['theme', [2, 4]]]);
  assert.deepEqual(plain(R.actions(list, '天气', {})), []);
});

test('only 1–100 characters after trimming are sent; a scope keeps one chat\'s current conversation; a hit finds its chat by native ID', () => {
  const R = rules();
  assert.deepEqual(plain(R.query('  纸箱 ')), { state: 'ok', q: '纸箱' });
  assert.deepEqual(plain(R.query('   ')), { state: 'empty', q: '' });
  assert.equal(R.query('字'.repeat(100)).state, 'ok');
  assert.equal(R.query('字'.repeat(101)).state, 'long');
  const list = chatsFixture();
  const byName = R.scope({ type: 'bot', id: '团子' }, list), byNative = R.scope({ type: 'bot', nativeId: 'cat-1' }, list);
  assert.equal(byName.canon, 'cat-1', 'a scope carries the identity the server names the cat by');
  assert.equal(byNative.chat.id, '团子');
  assert.equal(R.scope({ type: 'bot', id: '团子', nativeId: 'cat-1' }, list).chat.id, '团子', 'both, agreeing');
  assert.equal(R.scope({ type: 'bot', id: '团子', nativeId: 'cat-3' }, list), null, 'both, disagreeing');
  assert.equal(R.scope({ type: 'bot', id: 'cat-1' }, list), null, 'id is the app\'s name for a cat, never a native ID');
  assert.equal(R.scope({ type: 'bot', id: 'nobody' }, list), null);
  assert.equal(R.scope({ type: 'group', id: 'cat-1' }, list), null, 'a group scope never matches a cat');
  const hit = (type: string, id: string, current: boolean, messageId: string) => ({ chat: { type, id, name: '' }, threadId: 't-' + messageId, current, messageId });
  const results = [hit('bot', 'cat-1', true, 'a'), hit('bot', 'cat-1', false, 'b'), hit('bot', 'cat-3', true, 'c'), hit('group', 'g-1', true, 'd'), hit('bot', '团子', true, 'by-name')];
  assert.deepEqual(R.scoped(results, byName).map((h: Any) => h.messageId), ['a'], 'not the cat\'s earlier conversation, not another chat, never by name');
  assert.deepEqual(R.scoped(results, R.scope({ type: 'group', id: 'g-1' }, list)).map((h: Any) => h.messageId), ['d']);
  assert.equal(R.scoped(results, null).length, 5);
  assert.equal(R.chatOf(results[0], list).id, '团子');
  assert.equal(R.chatOf(results[3], list).name, '读书会');
  assert.equal(R.chatOf(hit('bot', 'gone', true, 'x'), list), null);
  assert.equal(R.chatOf(results[4], list), null, 'a hit names a cat by native ID only');
  // The same chat in a newer list: renamed, it is found by its native ID; gone, it is not.
  const renamed = list.map((c: Any) => (c.nativeId === 'cat-1' ? { ...c, id: '团团', name: '团团' } : c));
  assert.equal(R.fresh(list[0], renamed).id, '团团');
  assert.equal(R.fresh(list[0], list.slice(1)), null);
  assert.equal(R.fresh(list[3], list).id, 'g-1');
  assert.equal(R.fresh({ type: 'bot', id: '团子', name: '团子' }, list), null, 'without a native ID nothing is guessed');
});

test('a cat\'s name and another cat\'s native ID never stand in for each other (review 3)', () => {
  const R = rules();
  // One cat is named like another cat's native ID, and listed first.
  const list = [
    { type: 'bot', id: 'bot-x2', name: 'bot-x2', nativeId: 'n-1' },
    { type: 'bot', id: '栗子', name: '栗子', nativeId: 'bot-x2' },
  ];
  const hitOf = (catId: string) => ({ chat: { type: 'bot', id: catId, name: '' }, threadId: 't', current: true, messageId: 'm-' + catId });
  assert.equal(R.chatOf(hitOf('bot-x2'), list).id, '栗子', 'a server hit names 栗子 by its native ID');
  assert.equal(R.chatOf(hitOf('n-1'), list).id, 'bot-x2');
  const named = R.scope({ type: 'bot', id: 'bot-x2' }, list);
  assert.equal(named.chat.nativeId, 'n-1', 'the app\'s id is the name');
  assert.deepEqual(R.scoped([hitOf('bot-x2'), hitOf('n-1')], named).map((h: Any) => h.messageId), ['m-n-1'], '栗子\'s messages never come in');
  assert.equal(R.scope({ type: 'bot', nativeId: 'bot-x2' }, list).chat.id, '栗子');
  assert.equal(R.scope({ type: 'bot', id: 'bot-x2', nativeId: 'bot-x2' }, list), null, 'two different cats: refused, not guessed');
});

test('a mark in a name lands on the letters that matched, even where lowering a letter changes its length (review 7)', () => {
  const R = rules();
  // İ lowers to i plus a combining dot: two code units for one.
  assert.deepEqual(plain(R.match('İpek', 'pek')), { score: 1, range: [1, 4] });
  assert.equal('İpek'.slice(1, 4), 'pek');
  assert.deepEqual(plain(R.match('Ada İpek', 'pek')), { score: 1, range: [5, 8] });
  // A query that ends inside a lowered letter's expansion marks nothing (still a match).
  assert.deepEqual(plain(R.match('İpek', 'i')), { score: 3, range: null });
  assert.deepEqual(plain(R.match('  团子', '团子')), { score: 4, range: [2, 4] });
  assert.equal(R.who({ from: 'owner', catName: '团子' }), '你');
  assert.equal(R.who({ from: 'cat', catName: '团子' }), '团子');
});

test('the snippet is cut where the server says the match is; offsets that do not fit mark nothing', () => {
  const R = rules();
  assert.deepEqual(plain(R.segments('猫为什么喜欢纸箱？', [6, 8])), [{ text: '猫为什么喜欢', hit: false }, { text: '纸箱', hit: true }, { text: '？', hit: false }]);
  assert.deepEqual(plain(R.segments('纸箱', [0, 2])), [{ text: '纸箱', hit: true }]);
  for (const bad of [[6, 99], [-1, 2], [3, 3], [4, 2], [1.5, 3], null, [1]]) {
    assert.deepEqual(plain(R.segments('猫为什么喜欢纸箱？', bad)), [{ text: '猫为什么喜欢纸箱？', hit: false }], JSON.stringify(bad));
  }
});

test('what a search says beyond its rows: nothing found only about what was read, unread conversations and anything not looked at or not listed said as such', () => {
  const R = rules();
  const data = (n: number, more = false, failed = 0) => ({ results: Array.from({ length: n }, () => ({})), more, failed });
  assert.deepEqual(plain(R.notes(data(0), { q: '纸箱', shown: 0 })), { empty: '聊过的话里没有找到「纸箱」。', failed: '', more: '' });
  assert.deepEqual(plain(R.notes(data(0, false, 2), { q: '纸箱', shown: 0 })), { empty: '能读到的对话里没有找到「纸箱」。', failed: '有 2 个对话暂时读不到，没能在里面找。', more: '' });
  assert.equal(R.notes(data(3, false, 1), { q: '纸箱', shown: 3 }).failed, '有 1 个对话暂时读不到，没能在里面找，结果可能不全。');
  assert.equal(R.notes(data(3, true), { q: '纸箱', shown: 3 }).more, '只搜了最近的消息，更早的里可能还有。', 'fewer than 30: older messages were not looked at');
  assert.equal(R.notes(data(30, true), { q: '纸箱', shown: 30 }).more, '只列出了最新的 30 条，可能还有更多。');
  // One chat (its own route): about that conversation only.
  assert.deepEqual(plain(R.notes(data(0), { q: '纸箱', shown: 0, scoped: true })), { empty: '这段对话里没有找到「纸箱」。', failed: '', more: '' });
  assert.deepEqual(plain(R.notes(data(0, false, 1), { q: '纸箱', shown: 0, scoped: true })), { empty: '', failed: '这段对话暂时读不到，没能在里面找。', more: '' }, 'unread is not "nothing found"');
  assert.equal(R.notes(data(30, true), { q: '纸箱', shown: 30, scoped: true }).more, '只列出了最新的 30 条，可能还有更多。');
  assert.equal(R.notes(data(4, true), { q: '纸箱', shown: 4, scoped: true }).more, '只搜了最近的消息，更早的里可能还有。');
});

test('times read short; ↑/↓ wrap round; Alt+↑/↓ stop at either end; the shortcuts are ⌘K on macOS, Ctrl+K elsewhere and Alt+arrows, never while composing', () => {
  const R = rules();
  const now = new Date(2026, 10, 11, 21, 30);
  assert.equal(R.stamp(new Date(2026, 10, 11, 9, 5).toISOString(), now), '09:05');
  assert.equal(R.stamp(new Date(2026, 10, 10, 23, 0).toISOString(), now), '昨天');
  assert.equal(R.stamp(new Date(2026, 2, 3).toISOString(), now), '3月3日');
  assert.equal(R.stamp(new Date(2025, 11, 31).toISOString(), now), '2025年12月31日');
  assert.equal(R.stamp('nope', now), '');
  assert.deepEqual([R.move(3, 0, 1), R.move(3, 2, 1), R.move(3, 0, -1), R.move(3, -1, 1), R.move(3, -1, -1), R.move(0, 0, 1)], [1, 0, 2, 0, 2, -1]);
  const order = ['bot:a', 'bot:b', 'group:g'];
  assert.deepEqual([R.neighbor(order, 'bot:b', 1), R.neighbor(order, 'bot:b', -1), R.neighbor(order, 'group:g', 1), R.neighbor(order, 'bot:a', -1)], ['group:g', 'bot:a', '', '']);
  assert.deepEqual([R.neighbor(order, '', 1), R.neighbor(order, '', -1), R.neighbor([], 'bot:a', 1)], ['bot:a', 'group:g', '']);
  const key = (k: string, mods: Record<string, unknown> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(R.shortcut(key('k', { metaKey: true }), true), 'palette');
  assert.equal(R.shortcut(key('K', { metaKey: true }), true), 'palette');
  assert.equal(R.shortcut(key('ㅏ', { metaKey: true, code: 'KeyK' }), true), 'palette', 'another keyboard layout');
  assert.equal(R.shortcut(key('k', { ctrlKey: true }), true), '', 'Ctrl+K stays the text field\'s on macOS');
  assert.equal(R.shortcut(key('k', { ctrlKey: true }), false), 'palette');
  assert.equal(R.shortcut(key('k', { metaKey: true }), false), '');
  assert.equal(R.shortcut(key('k', { metaKey: true, shiftKey: true }), true), '');
  assert.equal(R.shortcut(key('ArrowUp', { altKey: true }), true), 'prev');
  assert.equal(R.shortcut(key('ArrowDown', { altKey: true }), false), 'next');
  assert.equal(R.shortcut(key('ArrowDown', { altKey: true, shiftKey: true }), true), '');
  assert.equal(R.shortcut(key('ArrowDown'), true), '');
  for (const reserved of ['n', 't', 'w', '1', '9']) assert.equal(R.shortcut(key(reserved, { metaKey: true }), true), '', reserved);
  assert.equal(R.shortcut(key('k', { metaKey: true, isComposing: true }), true), '');
});

// --------------------------------------------------------------- small DOM
class Base {
  parent: El | null = null;
  constructor(readonly doc: Doc) {}
  get parentElement() { return this.parent; }
  get isConnected(): boolean { for (let n: Base | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  get textContent(): string { return ''; }
  set textContent(_v: string) { /* text nodes override */ }
  remove() { const p = this.parent; if (!p) return; p.kids.splice(p.kids.indexOf(this), 1); this.parent = null; }
}
class TextNode extends Base {
  constructor(doc: Doc, public data: string) { super(doc); }
  override get textContent() { return this.data; }
  override set textContent(v: string) { this.data = String(v); }
}
class El extends Base {
  readonly tagName: string; kids: Base[] = []; attrs = new Map<string, string>(); listeners = new Map<string, Array<(ev: Any) => void>>();
  hidden = false; disabled = false; type = ''; value = ''; placeholder = ''; inert = false; inner = ''; scrolled = 0;
  [key: string]: Any;
  constructor(doc: Doc, tag: string) { super(doc); this.tagName = tag.toUpperCase(); }
  get id() { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', String(v)); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', String(v)); }
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s: Set<string>) => { this.className = [...s].join(' '); };
    return {
      add: (...n: string[]) => { const s = names(); n.forEach(x => s.add(x)); write(s); },
      remove: (...n: string[]) => { const s = names(); n.forEach(x => s.delete(x)); write(s); },
      toggle: (n: string, on?: boolean) => { const s = names(); const want = on ?? !s.has(n); if (want) s.add(n); else s.delete(n); write(s); return want; },
      contains: (n: string) => names().has(n),
    };
  }
  get dataset(): Record<string, string> {
    const key = (k: string) => 'data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return new Proxy({}, {
      get: (_t, k: string) => this.attrs.get(key(k)),
      set: (_t, k: string, v) => { this.attrs.set(key(k), String(v)); return true; },
    });
  }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  get firstChild() { return this.kids[0] ?? null; }
  override get textContent(): string { return this.kids.map(k => k.textContent).join(''); }
  override set textContent(v: string) { this.replaceChildren(); if (v !== '' && v != null) this.append(String(v)); }
  set innerHTML(v: string) { this.replaceChildren(); this.inner = v; }
  private adopt(item: Base | string): Base {
    const n = typeof item === 'string' ? new TextNode(this.doc, item) : item;
    if (n.parent) n.remove();
    n.parent = this;
    return n;
  }
  append(...items: Array<Base | string>) { for (const i of items) this.kids.push(this.adopt(i)); }
  prepend(...items: Array<Base | string>) { this.kids.unshift(...items.map(i => this.adopt(i))); }
  after(...items: Array<Base | string>) { const p = this.parent!; const at = p.kids.indexOf(this) + 1; p.kids.splice(at, 0, ...items.map(i => p['adopt'](i))); }
  replaceChildren(...items: Array<Base | string>) { for (const k of [...this.kids]) k.remove(); this.append(...items); }
  contains(n: Base | null): boolean { for (let x: Base | null = n; x; x = x.parent) if (x === this) return true; return false; }
  closest(sel: string): El | null { for (let x: El | null = this; x; x = x.parent) if (matches(x, sel)) return x; return null; }
  // Laid out only when connected, not hidden and not hidden by the page's
  // CSS for this width (doc.cssHidden: classes a media query sets to display: none).
  getClientRects() {
    for (let x: El | null = this; x; x = x.parent) if (x.hidden || [...this.doc.cssHidden].some(c => x!.classList.contains(c))) return [];
    return this.isConnected ? [{}] : [];
  }
  addEventListener(type: string, fn: (ev: Any) => void) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  // As a browser: an element that is not laid out, or sits in an inert subtree, does not take focus.
  focus() {
    if (!this.getClientRects().length) return;
    for (let x: El | null = this; x; x = x.parent) if (x.inert) return;
    this.doc.activeElement = this; dispatch(this.doc, this, 'focusin', {});
  }
  select() { this.selected = true; }
  scrollIntoView() { this.scrolled++; }
  click() { dispatch(this.doc, this, 'click', {}); }
  all(): El[] { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(sel: string): El[] { return this.all().filter(n => sel.split(',').some(s => matches(n, s.trim()))); }
  find(cls: string): El[] { return this.all().filter(n => n.classList.contains(cls)); }
}
// A selector subset: tag, .class, [attr], [attr="v"], and their concatenation.
function matches(n: El, sel: string): boolean {
  const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
  if (!m) throw new Error('selector ' + sel);
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
  for (const c of m[2].split('.').filter(Boolean)) if (!n.classList.contains(c)) return false;
  for (const a of m[3].match(/\[[^\]]+\]/g) ?? []) {
    const [, k, v] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a)!;
    if (k === 'hidden') { if (!n.hidden) return false; continue; }
    if (k === 'open' && n.open) continue;
    if (!n.attrs.has(k) || (v !== undefined && n.attrs.get(k) !== v)) return false;
  }
  return true;
}
class Doc {
  body: El; activeElement: El | null = null; listeners = new Map<string, Array<(ev: Any) => void>>(); cssHidden = new Set<string>();
  constructor() { this.body = new El(this, 'body'); }
  createElement(tag: string) { return new El(this, tag); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag); }
  createTextNode(t: string) { return new TextNode(this, t); }
  getElementById(id: string) { return this.body.all().find(n => n.id === id) ?? null; }
  querySelectorAll(sel: string) { return this.body.querySelectorAll(sel); }
  addEventListener(type: string, fn: (ev: Any) => void) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
}
// A bubbling event: target, its ancestors, then the document.
function dispatch(doc: Doc, target: El, type: string, init: Record<string, unknown>) {
  const ev: Any = { type, target, defaultPrevented: false, stopped: false, ...init, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() { ev.stopped = true; } };
  for (let n: El | null = target; n && !ev.stopped; n = n.parent) for (const fn of n.listeners.get(type) ?? []) fn(ev);
  if (!ev.stopped) for (const fn of doc.listeners.get(type) ?? []) fn(ev);
  return ev;
}

// ---------------------------------------------------------------- the page
type Hit = { chat: { type: string; id: string; name: string }; threadId: string; current: boolean; messageId: string; time: string; from: string; catName?: string; snippet: string; match: [number, number] };
function page(opts: { mac?: boolean; chats?: Any[]; order?: Any[]; selection?: Any; phone?: boolean } = {}) {
  const doc = new Doc();
  // palette.css: 取消 only on a phone; esc and the key hints only on a desktop.
  for (const c of opts.phone ? ['pal-esc', 'pal-foot'] : ['pal-cancel']) doc.cssHidden.add(c);
  const h = (tag: string, id = '', cls = '') => { const e = doc.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; return e; };
  // The sidebar's top as index.html has it (item 43): the round 搜索 beside 新建.
  const shell = h('div', 'shell'), side = h('div', '', 'side-head'), acts = h('div', '', 'side-acts');
  const entry = h('button', 'palette-open', 'side-btn'), composer = h('div', 'input'), thread = h('div', 'thread');
  acts.append(entry, h('button', 'side-new', 'side-btn')); side.append(acts); shell.append(side, thread, composer);
  doc.body.append(shell);
  let now = 0, seq = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn();
    }
    now = end;
  };
  const calls: Array<{ path: string; opt: Any; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const log: Any[] = [];
  // openGate / switchGate: when set, opening a chat or the switch waits for them (a slow app).
  const state = { selection: opts.selection ?? { type: 'bot', id: '团子' }, chats: opts.chats ?? chatsFixture(), order: opts.order ?? null, blocked: false,
    switchOut: { ok: true } as Any, openGate: null as Promise<unknown> | null, switchGate: null as Promise<Any> | null, fallback: null as El | null };
  const experience = { located: [] as string[], locate: async (item: Any) => { experience.located.push(item.messageId); return true; } };
  const window: Any = { ClowderExperience: experience };
  const context = vm.createContext({
    window, document: doc, console, navigator: { platform: opts.mac === false ? 'Win32' : 'MacIntel' }, AbortController,
    Date: class extends Date { constructor(...a: Any[]) { super(...((a.length ? a : [2026, 10, 11, 21, 30]) as [number])); } },
    setTimeout: (fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  for (const file of ['client/public/palette-rules.js', 'client/public/palette.js']) vm.runInContext(read(file), context);
  const P = window.ClowderPalette;
  // The hooks app.js passes (see ClowderPalette.init in client/public/app.js).
  P.init({
    api: (path: string, opt: Any) => new Promise((resolve, reject) => calls.push({ path, opt, resolve, reject })),
    icon: (name: string) => { const i = h('svg', '', 'icon'); i.dataset.icon = name || ''; return i; },
    visibleError: (e: Any, fallback: string) => (e && e.message) || fallback,
    composer,
    chats: () => state.chats,
    order: () => state.order ?? state.chats.map((c: Any) => ({ type: c.type, id: c.id })),
    face: (chat: Any) => { const f = h('span', '', 'avatar'); f.dataset.tip = chat.name; return f; },
    selection: () => state.selection,
    open: async (sel: Any) => { log.push(['open', sel.type, sel.id]); if (state.openGate) await state.openGate; state.selection = { ...sel }; },
    history: (sel: Any) => thread.children.find((n: El) => n.dataset.chat === sel.type + ':' + sel.id) ?? null,
    switchConversation: async (threadId: string) => { log.push(['switch', threadId]); return state.switchGate ? state.switchGate : state.switchOut; },
    newCat: (opener: Any) => log.push(['newCat', opener && opener.id]),
    newGroup: (opener: Any) => log.push(['newGroup', opener && opener.id]),
    settings: () => log.push(['settings']),
    theme: () => 'light',
    setTheme: (mode: string) => log.push(['theme', mode]),
    note: (text: string) => log.push(['note', text]),
    focusComposer: () => log.push(['focusComposer']),
    fallback: () => state.fallback, // app.js: the 新建 on screen now (shownNew)
    blocked: () => state.blocked || shell.hidden, // app.js passes shell.hidden
  });
  const root = () => doc.body.find('pal')[0];
  const input = () => doc.getElementById('pal-input')!;
  const rows = () => root().find('pal-opt');
  const rowText = () => rows().map(r => r.textContent);
  // What is on screen of a row: without what is there for a screen reader only (.visually-hidden; item 46).
  const seen = (n: El): string => n.classList.contains('visually-hidden') ? '' : n.kids.map(k => (k instanceof El ? seen(k) : k.textContent)).join('');
  const rowSeen = () => rows().map(seen);
  const heads = () => root().find('pal-head').map(n => n.textContent);
  const notes = () => root().find('pal-note').map(n => n.textContent);
  const key = (target: El | null, k: string, mods: Record<string, unknown> = {}) => dispatch(doc, target ?? doc.body, 'keydown', { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  const type = (text: string) => { input().value = text; dispatch(doc, input(), 'input', {}); };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const hit = (over: Partial<Hit> = {}): Hit => ({ chat: { type: 'bot', id: 'cat-1', name: '团子' }, threadId: 'th-1', current: true, messageId: 'm-1', time: new Date(2026, 10, 11, 20, 50).toISOString(), from: 'owner', snippet: '猫为什么喜欢纸箱？', match: [6, 8], ...over });
  const answer = async (i: number, data: Any) => { calls[i].resolve(data); await flush(); };
  // A drawn history for a chat with rows by native message ID.
  const history = (chatKey: string, ...mids: string[]) => {
    const inner = h('div', '', 'thread-inner'); inner.dataset.chat = chatKey;
    for (const mid of mids) { const r = h('div', '', 'msg'); r.dataset.mid = mid; inner.append(r); }
    thread.replaceChildren(inner);
    return inner;
  };
  return { doc, P, h, shell, entry, composer, thread, root, input, rows, rowText, rowSeen, heads, notes, key, type, flush, advance, calls, log, state, experience, hit, answer, history };
}

// ---------------------------------------------------------------- behaviour
test('⌘K opens the palette over an inert shell with the caret in the field; an empty query lists the sidebar\'s first chats (not the open one) and the actions; Esc closes and focus goes back', () => {
  const p = page();
  p.composer.focus();
  const ev = p.key(p.composer, 'k', { metaKey: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(p.P.isOpen(), true);
  assert.equal(p.root().hidden, false);
  assert.equal(p.shell.inert, true, 'nothing behind it takes focus or clicks');
  assert.equal(p.doc.activeElement, p.input());
  assert.deepEqual(p.heads(), ['最近', '操作']);
  // Item 46: the groups name themselves to a screen reader only; on screen the rows and a gap set them apart.
  assert.ok(p.root().find('pal-head').every(h => h.classList.contains('visually-hidden')));
  // A group's portrait says 群聊: its row shows its members, not 「群聊 · 」 before them.
  assert.deepEqual(p.rowText().slice(0, 4), ['Ada Lovelace', '大团子', '读书会团子、Ada Lovelace', '团子小队大团子'], 'the open chat 团子 is not offered');
  // The theme action without 「现在是浅色」: the page and its sun or moon show the theme.
  assert.deepEqual(p.rowText().slice(4), ['新建猫猫', '新建群聊', '设置', '切换深浅色']);
  // No line of key hints under the list.
  assert.equal(p.root().find('pal-foot').length, 0);
  assert.doesNotMatch(p.root().textContent, /上一个、下一个聊天|选择打开/);
  const css = read('client/public/palette.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.pal-group \+ \.pal-group \{ margin-top: var\(--x-s5\); \}/, 'a gap between the groups');
  assert.doesNotMatch(css, /\.pal-head \{|\.pal-foot|\.pal-hint/);
  assert.equal(p.rows()[0].getAttribute('aria-selected'), 'true');
  assert.equal(p.input().getAttribute('aria-activedescendant'), p.rows()[0].id);
  assert.equal(p.rows()[0].find('avatar')[0].dataset.tip, undefined, 'no tooltip on the faces');
  const esc = p.key(p.input(), 'Escape');
  assert.equal(esc.stopped, true, 'the page\'s own Escape handling never sees it');
  assert.equal(p.P.isOpen(), false);
  assert.equal(p.root().hidden, true);
  assert.equal(p.shell.inert, false);
  assert.equal(p.doc.activeElement, p.composer, 'focus is back where it was');
  // 搜索 at the top of the sidebar opens it too, and focus returns to it. It is a round lens now (item 43):
  // its name is 搜索, and the shortcut is in its tooltip and aria-keyshortcuts, not a key cap.
  assert.equal(p.entry.getAttribute('aria-keyshortcuts'), 'Meta+K');
  assert.equal(p.entry.dataset.tip, '搜索  ⌘K');
  assert.equal(p.entry.find('pal-key').length, 0);
  assert.equal(p.entry.find('pal-lens').length, 1);
  p.entry.click();
  assert.equal(p.P.isOpen(), true);
  p.key(p.input(), 'k', { metaKey: true });
  assert.equal(p.P.isOpen(), false, '⌘K again closes it');
  assert.equal(p.doc.activeElement, p.entry);
  // Ctrl+K is the shortcut away from macOS.
  const w = page({ mac: false });
  w.key(w.composer, 'k', { ctrlKey: true });
  assert.equal(w.P.isOpen(), true);
  assert.equal(w.entry.dataset.tip, '搜索  Ctrl K');
  assert.equal(w.entry.getAttribute('aria-keyshortcuts'), 'Control+K');
});

test('closed after its way in left sight (the window widened into the rail, which has no 搜索) with no composer to take focus: focus goes to the 新建 on screen, never to the page', () => {
  const p = page();
  const railNew = p.h('button', 'rail-new', 'side-glyph');
  p.shell.append(railNew);
  p.state.fallback = railNew;
  p.entry.click();
  assert.equal(p.P.isOpen(), true);
  // No chat open, so the composer takes nothing (this harness's focusComposer never focuses); the rail hides 搜索.
  p.entry.hidden = true;
  p.key(p.input(), 'Escape');
  assert.equal(p.P.isOpen(), false);
  assert.deepEqual(p.log.filter(l => l[0] === 'focusComposer'), [['focusComposer']], 'the composer is tried first');
  assert.ok(p.doc.activeElement === railNew, 'focus on the 新建 shown now');
  // Nothing on screen to take it either: nothing is forced (the hidden button is not focused).
  const q = page();
  const gone = q.h('button', 'rail-new', 'side-glyph');
  gone.hidden = true;
  q.shell.append(gone);
  q.state.fallback = gone;
  q.entry.click();
  q.entry.hidden = true;
  q.key(q.input(), 'Escape');
  assert.ok(q.doc.activeElement !== gone);
  // Its way in still there: focus goes back to it, as before, and the fallback is not asked.
  const r = page();
  r.state.fallback = railNew;
  r.entry.click();
  r.key(r.input(), 'Escape');
  assert.ok(r.doc.activeElement === r.entry);
  assert.match(read('client/public/app.js'), /fallback: \(\) => shownNew\(\),/);
});

test('it does not open over another dialog or a signed-out page, and keys inside it stay inside it', () => {
  const p = page();
  const dialog = p.h('div'); dialog.setAttribute('aria-modal', 'true');
  p.doc.body.append(dialog);
  assert.equal(p.key(p.composer, 'k', { metaKey: true }).defaultPrevented, false);
  assert.equal(p.P.isOpen(), false);
  assert.equal(p.P.open(), false);
  dialog.hidden = true;
  p.state.blocked = true;
  assert.equal(p.P.open(), false);
  p.state.blocked = false;
  assert.equal(p.P.open(), true);
  for (const k of ['ArrowDown', 'a', '\\', 'Enter']) assert.equal(p.key(p.input(), k, k === '\\' ? { metaKey: true } : {}).stopped, true, k);
});

test('names filter at once; what was said is searched once typing rests, a newer query cancels the request before it and a late answer is dropped', async () => {
  const p = page();
  p.P.open();
  p.type('团子');
  assert.deepEqual(p.heads(), ['猫猫和群聊']);
  // The open chat says so to a screen reader (item 46: no 「当前」 tag on screen; choosing it only closes the palette).
  assert.deepEqual(p.rowText(), ['团子，当前', '团子小队大团子', '大团子', '读书会有 团子'], 'best first; the open chat says so');
  assert.deepEqual(p.rowSeen(), ['团子', '团子小队大团子', '大团子', '读书会有 团子']);
  assert.equal(p.rows()[0].find('pal-mark')[0].textContent, '团子');
  assert.deepEqual(p.notes(), ['正在找聊过的话…']);
  assert.equal(p.calls.length, 0, 'not while typing');
  p.advance(100);
  p.type('纸');
  p.advance(219);
  assert.equal(p.calls.length, 0);
  p.advance(1);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].path, '/xbot-api/search?q=' + encodeURIComponent('纸'));
  p.type('纸箱 ');
  assert.equal(p.calls[0].opt.signal.aborted, true, 'the request for 纸 is cancelled');
  p.advance(220);
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].path, '/xbot-api/search?q=' + encodeURIComponent('纸箱'), 'trimmed');
  p.type('纸箱');
  p.advance(500);
  assert.equal(p.calls.length, 2, 'the same words again ask nothing new');
  // The answer for 纸 arrives late: dropped.
  await p.answer(0, { results: [p.hit({ messageId: 'late', snippet: '纸' , match: [0, 1] })], more: false, failed: 0 });
  assert.equal(p.rows().filter(r => r.classList.contains('pal-message')).length, 0);
  await p.answer(1, { results: [p.hit(), p.hit({ messageId: 'm-2', from: 'cat', catName: '团子', snippet: '纸箱让它安心', match: [0, 2] })], more: false, failed: 0 });
  assert.deepEqual(p.heads(), ['聊过的话']);
  const msg = p.rows()[0];
  assert.equal(msg.textContent, '团子20:50你：猫为什么喜欢纸箱？');
  assert.equal(msg.find('pal-mark')[0].textContent, '纸箱');
  assert.equal(msg.getAttribute('aria-label'), '团子，你说：猫为什么喜欢纸箱？，20:50');
  assert.equal(p.rows()[1].find('pal-who')[0].textContent, '团子：');
  assert.deepEqual(p.notes(), [], 'everything was searched and listed: nothing more to say');
  // A too-long query is said, not sent.
  p.type('字'.repeat(101));
  p.advance(1000);
  assert.equal(p.calls.length, 2);
  assert.deepEqual(p.notes(), ['最多可以搜 100 个字。']);
});

test('a partial answer is said plainly: unread conversations, older messages not looked at, and a failed search that can be retried', async () => {
  const p = page();
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  await p.answer(0, { results: [p.hit()], more: true, failed: 2 });
  assert.deepEqual(p.notes(), ['有 2 个对话暂时读不到，没能在里面找，结果可能不全。', '只搜了最近的消息，更早的里可能还有。']);
  p.type('没有');
  p.advance(220);
  await p.answer(1, { results: [], more: false, failed: 1 });
  assert.deepEqual(p.notes(), ['能读到的对话里没有找到「没有」。', '有 1 个对话暂时读不到，没能在里面找。'], 'never a bare "nothing found"');
  p.type('出错');
  p.advance(220);
  p.calls[2].reject(Object.assign(new Error('服务出了点问题，请稍后再试。'), { status: 500 }));
  await p.flush();
  assert.deepEqual(p.notes(), ['没能搜索聊过的话：服务出了点问题，请稍后再试。 重试']);
  p.root().find('pal-retry')[0].click();
  p.advance(0);
  assert.equal(p.calls.length, 4, 'retry asks again at once');
  await p.answer(3, { results: [p.hit({ snippet: '出错了', match: [0, 2] })], more: false, failed: 0 });
  assert.equal(p.rows().length, 1);
  // A backend without the route says so, without a retry.
  p.type('旧版');
  p.advance(220);
  p.calls[4].reject(Object.assign(new Error('not found'), { status: 404 }));
  await p.flush();
  assert.deepEqual(p.notes(), ['当前后端还没有开放消息搜索。']);
  // A malformed answer is a failed search, not an empty one.
  p.type('坏的');
  p.advance(220);
  await p.answer(5, { nope: true });
  assert.match(p.notes()[0], /^没能搜索聊过的话：搜索的返回格式无法识别/);
});

test('↑/↓ choose (wrapping), Enter on a chat opens it and hands focus to the composer; Tab stays inside', () => {
  const p = page();
  p.P.open();
  p.type('团');
  p.key(p.input(), 'ArrowDown');
  assert.equal(p.rows()[1].getAttribute('aria-selected'), 'true');
  p.key(p.input(), 'ArrowUp');
  p.key(p.input(), 'ArrowUp');
  assert.equal(p.rows().at(-1)!.getAttribute('aria-selected'), 'true', 'wraps round to the last');
  p.key(p.input(), 'ArrowDown');
  p.key(p.input(), 'ArrowDown');
  p.key(p.input(), 'Enter');
  assert.equal(p.P.isOpen(), false);
  assert.deepEqual(p.log.filter(l => l[0] === 'open'), [['open', 'group', 'g-2']]);
  // Tab cycles among the palette's own controls that are laid out: on a
  // desktop 取消 is hidden by the page's CSS, so the field is the only stop.
  p.P.open();
  const input = p.input();
  p.key(input, 'Tab');
  assert.equal(p.doc.activeElement, input);
  // The shell behind is inert: nothing in it takes focus.
  p.composer.focus();
  assert.equal(p.doc.activeElement, input);
  // Focus that wanders out elsewhere comes back.
  const stray = p.h('button'); p.doc.body.append(stray);
  stray.focus();
  assert.equal(p.doc.activeElement, input);
  // A phone: 取消 is a stop, both ways round.
  const m = page({ phone: true });
  m.P.open();
  const cancel = m.root().find('pal-cancel')[0];
  m.key(m.input(), 'Tab');
  assert.equal(m.doc.activeElement, cancel);
  m.key(cancel, 'Tab');
  assert.equal(m.doc.activeElement, m.input(), 'back round to the field');
  m.key(m.input(), 'Tab', { shiftKey: true });
  assert.equal(m.doc.activeElement, cancel);
});

test('Enter on a found message opens its chat and finds it on screen with the existing locate; one the chat does not show is said to be further back', async () => {
  const p = page({ selection: { type: 'bot', id: 'Ada Lovelace' } });
  p.history('bot:团子', 'm-0', 'm-1');
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  await p.answer(0, { results: [p.hit(), p.hit({ messageId: 'm-old' })], more: false, failed: 0 });
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.equal(p.P.isOpen(), false);
  assert.deepEqual(p.log.filter(l => l[0] === 'open'), [['open', 'bot', '团子']], 'the cat by the app\'s own name, found from its native ID');
  assert.deepEqual(p.experience.located, ['m-1'], 'chat-experience.js scrolls to, flashes and focuses it');
  assert.equal(p.log.some(l => l[0] === 'note'), false);
  // Not among the rows on screen: said, and nothing is guessed.
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  await p.answer(1, { results: [p.hit({ messageId: 'm-old' })], more: false, failed: 0 });
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(p.experience.located, ['m-1']);
  assert.deepEqual(p.log.at(-1), ['note', '这条消息不在已显示的消息里，可能在更早的记录里。']);
  // The locate hook can be replaced (a loader of older pages, say).
  const asked: Any[] = [];
  p.P.locate = async (where: Any) => { asked.push(where); return true; };
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  await p.answer(2, { results: [p.hit({ messageId: 'm-older', threadId: 'th-9' })], more: false, failed: 0 });
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(plain(asked), [{ type: 'bot', id: '团子', nativeId: 'cat-1', messageId: 'm-older', threadId: 'th-9' }], 'the app\'s name and the native ID, never one standing for the other');
});

test('a message of a cat\'s earlier conversation says so first; switching goes through the existing 历史对话 switch, its refusal is shown and nothing moves', async () => {
  const p = page();
  p.history('bot:团子', 'm-1');
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  await p.answer(0, { results: [p.hit({ current: false, threadId: 'th-old', messageId: 'm-1' })], more: false, failed: 0 });
  assert.match(p.rows()[0].textContent, /之前的对话/);
  p.key(p.input(), 'Enter');
  const confirm = p.root().find('pal-confirm')[0];
  assert.equal(confirm.hidden, false);
  assert.equal(p.root().find('pal-body')[0].hidden, true);
  assert.match(confirm.textContent, /这条是你和团子之前的一段对话里说的。切过去以后，和团子说的话会接着那段对话。/);
  assert.match(confirm.textContent, /你：猫为什么喜欢纸箱？/, 'the found words, for context');
  assert.equal(p.doc.activeElement!.textContent, '切换到那段对话');
  assert.deepEqual(p.log, [], 'nothing switched by asking');
  // Esc steps back to the list.
  p.key(p.doc.activeElement, 'Escape');
  assert.equal(p.P.isOpen(), true);
  assert.equal(confirm.hidden, true);
  assert.equal(p.doc.activeElement, p.input());
  // The switch refused (a conversation is busy): said; no locate.
  p.state.switchOut = { ok: false, text: '当前对话或要打开的对话还有任务在执行，暂时不能切换' };
  p.key(p.input(), 'Enter');
  p.doc.activeElement!.click();
  await p.flush();
  assert.equal(p.P.isOpen(), false);
  assert.deepEqual(p.log, [['open', 'bot', '团子'], ['switch', 'th-old'], ['note', '当前对话或要打开的对话还有任务在执行，暂时不能切换']]);
  assert.deepEqual(p.experience.located, []);
  // Switched: then the message is found.
  p.log.length = 0;
  p.state.switchOut = { ok: true };
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  await p.answer(1, { results: [p.hit({ current: false, threadId: 'th-old', messageId: 'm-1' })], more: false, failed: 0 });
  p.key(p.input(), 'Enter');
  p.doc.activeElement!.click();
  await p.flush();
  assert.deepEqual(p.log, [['open', 'bot', '团子'], ['switch', 'th-old']]);
  assert.deepEqual(p.experience.located, ['m-1']);
});

test('a scope searches one chat\'s current conversation through its own route: the chat list and the actions step aside, and the scope can be removed', async () => {
  const p = page();
  p.P.open({ scope: { type: 'bot', id: '团子' } });
  assert.equal(p.root().find('pal-scope')[0].hidden, false);
  assert.equal(p.root().find('pal-scope-name')[0].textContent, '团子');
  assert.equal(p.input().placeholder, '在和团子的聊天里查找');
  assert.deepEqual(p.rowText(), []);
  // Item 46: the placeholder and the chat's chip say where it looks; no note repeating them.
  assert.deepEqual(p.notes(), []);
  p.type('团子');
  assert.deepEqual(p.heads(), [], 'no chat list while scoped');
  assert.deepEqual(p.notes(), ['正在这个聊天里找…']);
  p.advance(220);
  assert.equal(p.calls[0].path, '/xbot-api/bots/' + encodeURIComponent('团子') + '/search?q=' + encodeURIComponent('团子'), 'GET <chat>/search, not the 30 newest of all chats');
  // Only this cat's current conversation is shown, by its native ID, whatever comes back.
  await p.answer(0, { results: [
    p.hit({ messageId: 'here' }), p.hit({ messageId: 'earlier', current: false }),
    p.hit({ messageId: 'other', chat: { type: 'bot', id: 'cat-3', name: '大团子' } }),
    p.hit({ messageId: 'group', chat: { type: 'group', id: 'g-1', name: '读书会' } }),
  ], more: true, failed: 0 });
  assert.deepEqual(p.heads(), ['找到的消息']);
  assert.equal(p.rows().length, 1);
  assert.equal(p.rows()[0].getAttribute('aria-label')!.startsWith('团子，'), true);
  assert.deepEqual(p.notes(), ['只搜了最近的消息，更早的里可能还有。']);
  // Unread is said as such, never as nothing found.
  p.type('读不到');
  p.advance(220);
  await p.answer(1, { results: [], more: false, failed: 1 });
  assert.deepEqual(p.notes(), ['这段对话暂时读不到，没能在里面找。']);
  // Backspace in the empty field removes the scope; the same words then search everything.
  p.type('团子');
  p.advance(220);
  await p.answer(2, { results: [p.hit({ messageId: 'here' })], more: false, failed: 0 });
  p.type('');
  p.key(p.input(), 'Backspace');
  assert.equal(p.root().find('pal-scope')[0].hidden, true);
  assert.deepEqual(p.heads(), ['最近', '操作']);
  p.type('团子');
  assert.equal(p.rows().some(r => r.classList.contains('pal-message')), false, 'one chat\'s answer is not shown as everyone\'s');
  p.advance(220);
  assert.equal(p.calls.at(-1)!.path, '/xbot-api/search?q=' + encodeURIComponent('团子'));
  // A group by its ID; a query passed in is searched.
  p.P.close();
  p.P.open({ scope: { type: 'group', id: 'g-1' }, query: '纸箱' });
  assert.equal(p.input().value, '纸箱');
  assert.equal(p.input().placeholder, '在这个群聊里查找');
  p.advance(220);
  assert.equal(p.calls.at(-1)!.path, '/xbot-api/groups/g-1/search?q=' + encodeURIComponent('纸箱'));
  // A cat by native ID only when asked that way.
  p.P.close();
  p.P.open({ scope: { type: 'bot', id: 'cat-1' } });
  assert.equal(p.root().find('pal-scope')[0].hidden, true, 'a native ID is not a cat\'s name');
  p.P.close();
  p.P.open({ scope: { type: 'bot', nativeId: 'cat-1' } });
  assert.equal(p.root().find('pal-scope-name')[0].textContent, '团子');
});

test('actions run the app\'s own functions after the palette closed; the registry adds, replaces and removes entries; with no cat 新建群聊 is not offered', async () => {
  const p = page();
  p.entry.click();
  p.type('新建');
  assert.deepEqual(p.rowText(), ['新建猫猫', '新建群聊']);
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(p.log, [['newCat', 'palette-open']], 'with the button it was opened from, for its own focus return');
  assert.equal(p.P.isOpen(), false);
  p.P.open();
  p.type('夜间');
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(p.log.at(-1), ['theme', 'dark']);
  // Another part of the app adds 新对话 for an open cat, then replaces it.
  const ran: Any[] = [];
  p.P.actions.add({ id: 'new-chat', label: '新对话', icon: 'plus', when: (c: Any) => c.selection && c.selection.type === 'bot', run: (c: Any) => ran.push(['v1', c.selection.id]) });
  p.P.actions.add({ id: 'new-chat', label: '新对话', icon: 'plus', when: (c: Any) => c.selection && c.selection.type === 'bot', run: (c: Any) => ran.push(['v2', c.selection.id]) });
  assert.equal(p.P.actions.list().filter((a: Any) => a.id === 'new-chat').length, 1);
  p.P.open();
  p.type('新对话');
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(ran, [['v2', '团子']]);
  p.state.selection = { type: 'group', id: 'g-1' };
  p.P.open();
  p.type('新对话');
  assert.deepEqual(p.rowText(), [], 'not for a group');
  p.P.close();
  assert.equal(p.P.actions.remove('new-chat'), true);
  assert.throws(() => p.P.actions.add({ id: 'x', label: '缺 run' }));
  // The first-run stage: no cat yet.
  const empty = page({ chats: [], selection: null });
  empty.P.open();
  assert.deepEqual(empty.rowText(), ['新建猫猫', '设置', '切换深浅色']);
});

test('设置 is also found by the name of its Agents pane, and by that pane\'s old name 本机工具', async () => {
  for (const words of ['Agents', 'agent', '本机工具', '工具']) {
    const p = page();
    p.P.open();
    p.type(words);
    assert.deepEqual(p.rowText(), ['设置'], words);
  }
  const p = page();
  p.P.open();
  p.type('本机工具');
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(p.log.at(-1), ['settings']);
});

test('Alt+↑ / Alt+↓ open the previous / next chat in the sidebar\'s order, stop at either end, and leave other fields and dialogs alone', () => {
  const p = page({ order: [{ type: 'bot', id: '团子' }, { type: 'group', id: 'g-1' }, { type: 'bot', id: '大团子' }] });
  p.composer.focus();
  assert.equal(p.key(p.composer, 'ArrowDown', { altKey: true }).defaultPrevented, true);
  p.key(p.composer, 'ArrowDown', { altKey: true });
  assert.deepEqual(p.log, [['open', 'group', 'g-1'], ['open', 'bot', '大团子']]);
  p.key(p.composer, 'ArrowDown', { altKey: true });
  assert.equal(p.log.length, 2, 'the last chat: nothing after it');
  p.key(p.composer, 'ArrowUp', { altKey: true });
  assert.deepEqual(p.log.at(-1), ['open', 'group', 'g-1']);
  // In another field the arrows keep their meaning.
  const field = p.h('input'); p.shell.append(field);
  assert.equal(p.key(field, 'ArrowUp', { altKey: true }).defaultPrevented, false);
  // Not over a dialog, nor while the palette is open.
  const dialog = p.h('div'); dialog.setAttribute('aria-modal', 'true'); p.doc.body.append(dialog);
  p.key(p.composer, 'ArrowUp', { altKey: true });
  dialog.remove();
  p.P.open();
  p.key(p.input(), 'ArrowUp', { altKey: true });
  assert.equal(p.log.length, 3);
});

test('the default locate finds a message only in the open chat\'s drawn history and opens that chat first when needed', async () => {
  const p = page({ selection: { type: 'group', id: 'g-1' } });
  p.history('bot:团子', 'a', 'b');
  assert.equal(await p.P.locate({ type: 'bot', id: '团子', messageId: 'b' }), true);
  assert.deepEqual(p.log, [['open', 'bot', '团子']]);
  assert.deepEqual(p.experience.located, ['b']);
  assert.equal(await p.P.locate({ type: 'bot', id: 'cat-1', messageId: 'zzz' }), false);
  assert.equal(await p.P.locate({ type: 'bot', id: 'nobody', messageId: 'a' }), false);
  p.history('group:g-2', 'a');
  assert.equal(await p.P.locate({ type: 'group', id: 'g-1', messageId: 'a' }), false, 'another chat\'s history is not this one\'s');
});

// ------------------------------------------------- review fixes (2026-11-11)
test('a sign-in or another dialog taking over closes the palette without moving focus, cancels its search and lifts inert (review 1)', async () => {
  const p = page();
  const login = p.h('input'); p.doc.body.append(login); // outside the shell, as #login is
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  assert.equal(p.calls.length, 1);
  // A poll answered 401: the app hid the shell and focused its sign-in field.
  p.shell.hidden = true;
  login.focus();
  assert.equal(p.P.isOpen(), false);
  assert.equal(p.doc.activeElement, login, 'the sign-in keeps its focus');
  assert.equal(p.shell.inert, false);
  assert.equal(p.calls[0].opt.signal.aborted, true, 'its search is cancelled');
  // The search's own 401 does the same.
  p.shell.hidden = false;
  p.composer.focus();
  p.P.open();
  p.type('猫');
  p.advance(220);
  p.calls[1].reject(Object.assign(new Error('unauthorized'), { status: 401 }));
  await p.flush();
  assert.equal(p.P.isOpen(), false);
  assert.equal(p.shell.inert, false);
  assert.notEqual(p.doc.activeElement, p.composer, 'focus is not handed back into the shell: the app shows its sign-in');
  // A dialog that comes up over it (a device prompt, say) is not fought over.
  p.P.open();
  const dialog = p.h('div'); dialog.setAttribute('aria-modal', 'true');
  const ok = p.h('button'); dialog.append(ok); p.doc.body.append(dialog);
  ok.focus();
  assert.equal(p.P.isOpen(), false);
  assert.equal(p.doc.activeElement, ok);
});

test('a row is resolved again when chosen: a renamed cat opens by its new name, a gone chat is refused in place, also after the earlier-conversation question (review 2)', async () => {
  const p = page({ selection: { type: 'group', id: 'g-1' } });
  p.P.open();
  p.type('团子');
  // Renamed on another device since the rows were drawn.
  p.state.chats = p.state.chats.map((c: Any) => (c.nativeId === 'cat-1' ? { ...c, id: '团团', name: '团团' } : c));
  p.key(p.input(), 'Enter'); // the first row: 团子 (the whole name)
  await p.flush();
  assert.deepEqual(p.log.filter(l => l[0] === 'open'), [['open', 'bot', '团团']], 'by native ID, under its name now');
  // Removed since: refused, nothing opened, the palette stays with the caret in the field.
  p.log.length = 0;
  p.P.open();
  p.type('大团子');
  p.state.chats = p.state.chats.filter((c: Any) => c.nativeId !== 'cat-3');
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(p.log, []);
  assert.equal(p.P.isOpen(), true);
  assert.equal(p.doc.activeElement, p.input());
  assert.equal(p.notes()[0], '「大团子」已经不在列表里了。');
  assert.equal(p.rowText().some(t => t.startsWith('大团子')), false, 'the gone row leaves');
  // A message whose chat is gone: said as gone, not as "maybe further back".
  p.type('纸箱');
  p.advance(220);
  await p.answer(0, { results: [p.hit({ chat: { type: 'group', id: 'g-2', name: '团子小队' } })], more: false, failed: 0 });
  p.state.chats = p.state.chats.filter((c: Any) => c.id !== 'g-2');
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(p.log, []);
  assert.equal(p.P.isOpen(), true);
  assert.equal(p.notes()[0], '这条消息所在的聊天已经不在列表里了。');
  // The cat goes while the earlier-conversation question is up.
  p.type('天气');
  p.advance(220);
  await p.answer(1, { results: [p.hit({ chat: { type: 'bot', id: 'cat-1', name: '团子' }, current: false, threadId: 'th-old' })], more: false, failed: 0 });
  p.key(p.input(), 'Enter');
  const yes = p.doc.activeElement!;
  assert.equal(yes.textContent, '切换到那段对话');
  p.state.chats = p.state.chats.filter((c: Any) => c.nativeId !== 'cat-1');
  yes.click();
  await p.flush();
  assert.deepEqual(p.log, [], 'no chat opened, no switch asked');
  assert.equal(p.P.isOpen(), true);
  assert.equal(p.root().find('pal-confirm')[0].hidden, true, 'back at the list');
  assert.equal(p.doc.activeElement, p.input());
  assert.equal(p.notes()[0], '这条消息所在的聊天已经不在列表里了。');
  // An action that stopped applying since it was drawn.
  let allowed = true;
  p.P.actions.add({ id: 'temp', label: '临时操作', when: () => allowed, run: () => p.log.push(['temp']) });
  p.type('临时');
  assert.deepEqual(p.rowText(), ['临时操作']);
  allowed = false;
  p.key(p.input(), 'Enter');
  await p.flush();
  assert.deepEqual(p.log, []);
  assert.equal(p.P.isOpen(), true);
  assert.equal(p.notes()[0], '「临时操作」现在用不了。');
});

test('starting to compose a word cancels what was waiting for the text before it, shows nothing for that text, and searches the committed word (review 4)', async () => {
  const p = page();
  const compose = (kind: string, value?: string) => { if (value !== undefined) p.input().value = value; dispatch(p.doc, p.input(), kind, {}); };
  p.P.open();
  p.type('old');
  compose('compositionstart');
  p.advance(500);
  assert.equal(p.calls.length, 0, 'the text before the word is not searched');
  // Keys of the word being composed change nothing.
  p.input().value = 'oldzhi';
  dispatch(p.doc, p.input(), 'input', { isComposing: true });
  p.advance(500);
  assert.equal(p.calls.length, 0);
  compose('compositionend', '纸箱');
  p.advance(220);
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].path, '/xbot-api/search?q=' + encodeURIComponent('纸箱'));
  // An answer for the text before a composition never paints under it.
  p.type('再');
  p.advance(220);
  assert.equal(p.calls.length, 2);
  compose('compositionstart');
  assert.equal(p.calls[1].opt.signal.aborted, true);
  await p.answer(1, { results: [p.hit({ snippet: '再', match: [0, 1] })], more: false, failed: 0 });
  assert.equal(p.rows().some(r => r.classList.contains('pal-message')), false);
  assert.equal(p.notes().some(n => /正在找|没有找到/.test(n)), false, 'nothing said about the old text either');
  // The answer for the first word, arriving late, is dropped too.
  await p.answer(0, { results: [p.hit()], more: false, failed: 0 });
  assert.equal(p.rows().some(r => r.classList.contains('pal-message')), false);
});

test('what a choice does after waiting stops once a new palette is opened: a slow switch neither closes it nor takes its focus (review 6)', async () => {
  const p = page();
  p.history('bot:团子', 'm-1');
  let release: (v: Any) => void = () => {};
  p.state.switchGate = new Promise((r) => { release = r; });
  p.P.open();
  p.type('纸箱');
  p.advance(220);
  await p.answer(0, { results: [p.hit({ current: false, threadId: 'th-old', messageId: 'm-1' })], more: false, failed: 0 });
  p.key(p.input(), 'Enter');
  p.doc.activeElement!.click(); // 切换到那段对话
  await p.flush();
  assert.deepEqual(p.log, [['open', 'bot', '团子'], ['switch', 'th-old']]);
  // While the switch is on its way, the owner searches again.
  p.composer.focus();
  p.P.open();
  p.type('栗子');
  release({ ok: true });
  await p.flush();
  assert.equal(p.P.isOpen(), true, 'the new palette stays');
  assert.equal(p.input().value, '栗子');
  assert.equal(p.doc.activeElement, p.input());
  assert.deepEqual(p.experience.located, [], 'the old message is not jumped to under it');
  assert.equal(p.log.some(l => l[0] === 'note'), false);
  // Likewise a slow chat opening: a newer palette is not closed or left without focus.
  let opened: (v?: unknown) => void = () => {};
  p.state.openGate = new Promise((r) => { opened = r; });
  p.type('大团子');
  p.key(p.input(), 'Enter');
  p.P.open();
  opened();
  await p.flush();
  assert.equal(p.P.isOpen(), true);
  assert.equal(p.log.some(l => l[0] === 'focusComposer'), false, 'focus is not handed to the composer under the new palette');
});

// ------------------------------------------------------------------ wiring
test('the page loads the palette after the quick-create scripts and before app.js, its styles before chat-live.css; the shell hands it the app\'s own functions; only existing tokens', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/palette.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('workspace.js') < at('palette.js') && at('chat-experience.js') < at('palette.js') && at('palette-rules.js') < at('palette.js') && at('palette.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  // Only the 找得到 styles (chat-list.css, chat-history.css), 资料页与群 (profile.css, mention.css) and chat-live.css (last) follow.
  assert.deepEqual(styles.slice(-12), ['quick-create.css', 'palette.css', 'chat-list.css', 'chat-history.css', 'profile.css', 'mention.css', 'polish.css', 'chat-cards.css', 'chat-presence.css', 'chat-reactions.css', 'sidebar.css', 'chat-live.css']);
  // 搜索 is the first of the two round buttons at the right end of the greeting's line (item 43), before 新建; the rail has none.
  assert.match(html, /<div class="side-head">\n\s+<div class="side-acts">\n\s+<button id="palette-open" class="side-btn" type="button" aria-haspopup="dialog" aria-label="搜索"><\/button>\n\s+<button id="side-new" class="side-btn"[^>]*aria-label="新建"[^>]*><\/button>\n\s+<\/div>\n\s+<div id="greeting"/);
  assert.doesNotMatch(html, /pal-entry/);
  assert.doesNotMatch(css, /pal-entry|pal-key/);
  const init = /window\.ClowderPalette\.init\(\{[\s\S]*?\n {2}\}\);/.exec(app)![0];
  for (const hook of ['newCat: (opener) => openNewBot(opener)', 'newGroup: (opener) => openNewGroup(opener)', 'switchConversation: (threadId) => workspace.switchTo(threadId)',
    'open: (sel) => (sel.type === "group" ? pickGroup(sel.id) : pickBot(sel.id))', 'setTheme: (mode) => applyTheme(mode)', 'note: (text) => showToast(text, "info")']) assert.ok(init.includes(hook), hook);
  assert.match(app, /function showToast\(text, iconName = "check"\)/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  // Motion only from the existing keyframes, and none when reduced.
  assert.deepEqual([...css.matchAll(/animation:\s*([\w-]+)/g)].map(m => m[1]).sort(), ['fade', 'none', 'rise']);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // What is said uses the everyday words: 猫猫, the cat's name, 群聊, 对话 (and Agents, since 2026-11-12).
  for (const file of ['client/public/palette.js', 'client/public/palette-rules.js']) {
    const literals = read(file).replace(/^\s*\/\/[^\n]*$/gm, '').match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    assert.ok(literals.length > 10, file);
    for (const s of literals) assert.doesNotMatch(s, /Bot|session|thread|原生|会话/, file + ': ' + s);
  }
});
