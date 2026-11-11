import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { z } from 'zod';

// 资料页与群 (profile-rules.js, profile.js) and the group composer's @ list
// (mention-rules.js, mention.js). The page scripts run here as the classic
// browser scripts they are, in a VM with a small DOM (tree, siblings, events
// with a capture, target and bubble phase and stopPropagation as browsers do,
// focus that is lost when its element leaves the page, controllable timers),
// against a fake /xbot-api whose answers are new objects (as from the
// network), never the ones the page holds. app.js is not loaded: its hooks
// are faked the way it passes them to init(), and static checks cover its
// wiring; the 新对话 path runs with the real chat-history.js.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async (turns = 10) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ---------------------------------------------------------------- small DOM
class Ev {
  defaultPrevented = false; stopped = false; target: El | null = null; currentTarget: El | null = null;
  [key: string]: Any;
  constructor(readonly type: string, init: Record<string, unknown> = {}) { Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
class Txt {
  parent: El | null = null;
  constructor(public data: string) {}
  get textContent() { return this.data; }
  get nextSibling(): El | Txt | null { return sibling(this, 1); }
}
const sibling = (n: El | Txt, step: number): El | Txt | null => { const p = n.parent; if (!p) return null; return p.kids[p.kids.indexOf(n) + step] ?? null; };
type Listener = { fn: (ev: Ev) => unknown; capture: boolean };
class El {
  kids: Array<El | Txt> = []; parent: El | null = null; attrs = new Map<string, string>(); listeners = new Map<string, Listener[]>();
  style: Record<string, Any> = { setProperty(k: string, v: string) { this[k] = v; }, removeProperty(k: string) { delete this[k]; } };
  hidden = false; disabled = false; readOnly = false; checked = false; value = ''; type = ''; open = false;
  placeholder = ''; maxLength = 0; autocomplete = ''; htmlFor = ''; selected = 0; private tab: number | null = null;
  [key: string]: Any;
  constructor(readonly doc: Doc, readonly tagName: string) {}
  get id() { return this.attrs.get('id') ?? ''; }
  set id(value: string) { this.attrs.set('id', String(value)); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(value: string) { this.attrs.set('class', String(value)); }
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (set: Set<string>) => { this.className = [...set].join(' '); };
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
      deleteProperty: (_t, k: string) => { this.attrs.delete(key(k)); return true; },
    });
  }
  get tabIndex() { return this.tab ?? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1); }
  set tabIndex(value: number) { this.tab = Number(value); }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  get childNodes() { return this.kids; }
  get firstChild(): Any { return this.kids[0] ?? null; }
  get lastChild(): Any { return this.kids[this.kids.length - 1] ?? null; }
  get nextSibling(): El | Txt | null { return sibling(this, 1); }
  get textContent(): string { return this.kids.map(k => k.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); if (value !== '' && value != null) this.append(String(value)); }
  private adopt(item: El | Txt | string) {
    const n = typeof item === 'string' ? new Txt(item) : item;
    if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1);
    n.parent = this;
    return n;
  }
  append(...items: Array<El | Txt | string>) { for (const item of items) this.kids.push(this.adopt(item)); }
  insertBefore(item: El | Txt, before: El | Txt | null) {
    const n = this.adopt(item);
    const at = before ? this.kids.indexOf(before) : -1;
    if (at < 0) this.kids.push(n); else this.kids.splice(at, 0, n);
    return n;
  }
  replaceChildren(...items: Array<El | Txt | string>) { for (const k of this.kids) k.parent = null; this.kids = []; this.append(...items); }
  remove() { if (this.parent) { this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; } }
  contains(n: unknown): boolean { for (let x = n as El | null; x; x = x.parent) if (x === this) return true; return false; }
  get isConnected(): boolean { for (let n: El | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  addEventListener(type: string, fn: (ev: Ev) => unknown, opts?: boolean | { capture?: boolean }) {
    const capture = opts === true || (typeof opts === 'object' && !!opts && !!opts.capture);
    const list = this.listeners.get(type) ?? []; list.push({ fn, capture }); this.listeners.set(type, list);
  }
  // Capture from the outermost ancestor down, then the target, then bubble
  // up; stopPropagation ends the walk after the current element.
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const ev = new Ev(type, init);
    ev.target = this;
    const path: El[] = [];
    for (let n: El | null = this; n; n = n.parent) path.push(n);
    const run = (n: El, pick: (l: Listener) => boolean) => { ev.currentTarget = n; for (const l of [...(n.listeners.get(type) ?? [])]) if (pick(l)) l.fn(ev); };
    for (const n of [...path].reverse().slice(0, -1)) { if (ev.stopped) return ev; run(n, l => l.capture); }
    if (ev.stopped) return ev;
    run(this, () => true);
    for (const n of path.slice(1)) { if (ev.stopped) return ev; run(n, l => !l.capture); }
    return ev;
  }
  click() {
    if (this.disabled) return;
    const ev = this.dispatch('click');
    if (!ev.defaultPrevented && this.tagName === 'BUTTON' && this.type === 'submit') this.closest('FORM')?.dispatch('submit');
  }
  key(key: string, more: Record<string, unknown> = {}) { return this.dispatch('keydown', { key, ...more }); }
  closest(tag: string): El | null { for (let n: El | null = this; n; n = n.parent) if (n.tagName === tag) return n; return null; }
  focus() { if (this.isConnected && !this.disabled) this.doc.focused = this; }
  blur() { if (this.doc.focused === this) { this.doc.focused = null; this.dispatch('blur'); } }
  select() { this.selected++; }
  querySelectorAll(sel: string) { const tags = sel.split(',').map(s => s.trim().toUpperCase()); return all(this).filter(e => tags.includes(e.tagName)); }
  getClientRects() { for (let n: El | null = this; n; n = n.parent) if (n.hidden) return []; return [{}]; }
}
class Doc {
  body: El; focused: El | null = null;
  constructor() { this.body = new El(this, 'BODY'); }
  createElement(tag: string) { return new El(this, tag.toUpperCase()); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag.toUpperCase()); }
  get activeElement(): El { return this.focused && this.focused.isConnected ? this.focused : this.body; }
  // Listeners on the document itself are kept but never reached (no event here bubbles past the body).
  docListeners: Array<[string, unknown]> = [];
  addEventListener(type: string, fn: unknown) { this.docListeners.push([type, fn]); }
  getElementById(id: string): El | null { return all(this.body).find(e => e.id === id) ?? null; }
  // '#id' or '.class' only (what the modules ask the document for).
  querySelector(sel: string): El | null {
    const m = /^([.#])([\w-]+)$/.exec(sel.trim());
    return m ? all(this.body).find(e => (m[1] === '#' ? e.id === m[2] : has(e, m[2]))) ?? null : null;
  }
}
const all = (root: El): El[] => root.children.flatMap(c => [c, ...all(c)]);
const has = (n: El, cls: string) => n.classList.contains(cls);
const named = (root: El, cls: string) => all(root).filter(n => has(n, cls));
const one = (root: El, cls: string) => { const n = named(root, cls)[0]; assert.ok(n, 'no .' + cls); return n!; };
const shown = (n: El) => n.getClientRects().length > 0;
const visibleText = (root: El): string => root.hidden ? '' : root.kids.map(k => (k instanceof El ? visibleText(k) : k.textContent)).join('');
const button = (root: El, text: string) => {
  const b = all(root).find(n => n.tagName === 'BUTTON' && visibleText(n).trim() === text && shown(n));
  assert.ok(b, 'no button ' + text);
  return b!;
};
const fail = (status: number | undefined, message = 'request failed') => Object.assign(new Error(message), status ? { status } : {});

// The scripts in a VM with this DOM; timers run only when told to.
function load(files: string[]) {
  const doc = new Doc();
  const window: Any = {};
  let clock = 0, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const context = vm.createContext({
    window, document: doc, console,
    setTimeout: (fn: () => void, ms = 0) => { const id = ++next; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  for (const file of files) vm.runInContext(read(file), context);
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= clock) { timers.delete(id); t.fn(); }
  };
  return { doc, window, advance };
}
const RULES = ['client/public/quick-create-rules.js', 'client/public/profile-rules.js'];

// ---------------------------------------------------------------- rules: tabs and words
test('the drawer\'s tabs: a cat has 资料 / 文件 / 记忆 / 定时, a group 成员 / 文件; the retired tabs land where their content now is', () => {
  const R = load(RULES).window.ClowderProfileRules;
  assert.deepEqual(plain(R.tabs('bot')), [['profile', '资料'], ['files', '文件'], ['memory', '记忆'], ['schedule', '定时']]);
  assert.deepEqual(plain(R.tabs('group')), [['members', '成员'], ['files', '文件']]);
  // 详情 → 资料, the old 记忆 id → 记忆, 任务 → 资料 (its 高级), 轨迹 and 上下文 are gone → 资料.
  assert.deepEqual(['details', 'library', 'computer', 'trace', 'context', 'files', 'schedule', 'nonsense', undefined].map(t => R.tabFor('bot', t)),
    ['profile', 'memory', 'profile', 'profile', 'profile', 'files', 'schedule', 'profile', 'profile']);
  // A group has no 记忆, 定时 or 资料: each lands on 成员; 文件 stays.
  assert.deepEqual(['profile', 'memory', 'schedule', 'computer', 'files', 'members'].map(t => R.tabFor('group', t)),
    ['members', 'members', 'members', 'members', 'files', 'members']);
  assert.equal(R.tabFor('bot', 'members'), 'profile');
  assert.equal(R.opensAdvanced('computer'), true, 'asking for the old 任务 opens 高级');
  assert.equal(R.opensAdvanced('files'), false);
  assert.equal(R.home('group'), 'members');
  // The tab names carry none of the engine's words.
  for (const [, label] of [...R.tabs('bot'), ...R.tabs('group')]) assert.doesNotMatch(label, /轨迹|上下文|任务|详情|Agent/);
});

test('a cat\'s own colour is used only as the server gives it, and a cat made from a name alone shows no breed row', () => {
  const R = load(RULES).window.ClowderProfileRules;
  assert.deepEqual(plain(R.accent({ accent: { primary: '#D4A373', secondary: '#FAEDCD' } })), { primary: '#D4A373', secondary: '#FAEDCD' });
  for (const accent of [undefined, null, { primary: '#888', secondary: '#eeeeee' }, { primary: 'red', secondary: '#ffffff' }, { primary: '#123456' }, { primary: 'url(x)', secondary: '#000000' }])
    assert.equal(R.accent({ accent }), null, JSON.stringify(accent));
  const bot = { id: 'bot-1', native_id: 'bot-1' };
  assert.equal(R.ownBreed({ breed: { mode: 'explicit', breedId: 'bot-1' } }, bot), true, 'its own ID is no breed');
  assert.equal(R.ownBreed({ breed: { mode: 'explicit', breedId: 'ragdoll' } }, bot), false);
  assert.equal(R.ownBreed({ breed: { mode: 'auto' } }, bot), false);
  assert.equal(R.ownBreed(null, bot), false);
});

test('the note under 新对话 says, in everyday words, where this conversation goes and that what the cat knows of you stays', () => {
  const R = load(RULES).window.ClowderProfileRules;
  assert.match(R.NEW_CHAT_NOTE, /历史对话/);
  assert.match(R.NEW_CHAT_NOTE, /记得/);
  assert.equal(R.newChatError, undefined, 'refusals are said by the shared dialog (chat-history.js)');
});

// ---------------------------------------------------------------- rules: groups
const CATS = [
  { name: '快手', native_id: 'cat-k', pinned: false },
  { name: '墨点', native_id: 'cat-m', pinned: false },
  { name: '年糕', native_id: 'cat-n', pinned: true },
  { name: '宪宪 2', native_id: 'cat-x', pinned: false },
];

test('a group\'s members: known cats by name, a cat the server could not name is marked, one may leave while two stay, and an edit says only who to add or take out', () => {
  const R = load(RULES).window.ClowderProfileRules;
  const g = { id: 'g1', name: '读书会', members: ['快手', '墨点', 'cat-gone', '快手', 'cat-n'] };
  assert.deepEqual(plain(R.members(g, CATS)), [{ name: '快手', known: true }, { name: '墨点', known: true }, { name: 'cat-gone', known: false }, { name: '年糕', known: true }],
    'a native ID becomes its name when the cat is loaded; duplicates once');
  assert.deepEqual(plain(R.addable(g, CATS)), ['宪宪 2']);
  assert.equal(R.room(g, CATS), 7);
  assert.equal(R.canRemove(g, CATS, '墨点'), true);
  assert.equal(R.canRemove(g, CATS, 'cat-gone'), false, 'an unknown member is not offered');
  // Intent, never a list: the server applies it to the roster as it is now (review 2026-11-11, item 1).
  assert.deepEqual(plain(R.removeBody(' 墨点 ')), { remove: ['墨点'] });
  assert.deepEqual(plain(R.addBody(['宪宪 2', '年糕', '宪宪 2', ''])), { add: ['宪宪 2', '年糕'] });
  assert.equal(R.membersBody, undefined, 'no whole-list body is built any more');
  // The answer is what the page shows: a group record, or nothing usable.
  assert.deepEqual(plain(R.groupFrom({ id: 'g1', name: '读书会', members: ['快手', '宪宪 2'] }, 'g1')), { id: 'g1', name: '读书会', members: ['快手', '宪宪 2'] });
  assert.equal(R.groupFrom({ id: 'g9', members: [] }, 'g1'), null, 'another group\'s answer');
  assert.equal(R.groupFrom({ status: 'ok' }, 'g1'), null);
  const two = { id: 'g2', name: '', members: ['快手', '墨点'] };
  assert.equal(R.canRemove(two, CATS, '快手'), false, 'two is the least a group has');
  const many = { id: 'g3', name: '', members: Array.from({ length: 10 }, (_, i) => 'c' + i) };
  const big = Array.from({ length: 10 }, (_, i) => ({ name: 'c' + i, native_id: 'n' + i }));
  assert.equal(R.room(many, big), 0);
  assert.equal(R.countText(3), '3 只猫猫');
});

test('a group\'s name follows the server\'s own title rule; cleared, it becomes the members\' names as an unnamed group\'s would', () => {
  const R = load(RULES).window.ClowderProfileRules;
  const core = read('server/xbot/core.ts');
  const m = /const groupTitle = (z\.string\(\)[^;]+);/.exec(core);
  assert.ok(m, 'groupTitle is where the adapter keeps it');
  const groupTitle = new Function('z', 'return ' + m![1])(z);
  for (const name of ['周末读书会', '  晨会 ', 'a'.repeat(64), 'a'.repeat(65), '团子<1>', 'new\nline', 'emoji😺'])
    assert.equal(R.nameProblem(name) === '', groupTitle.safeParse(name).success, JSON.stringify(name));
  const g = { id: 'g1', name: '旧名', members: ['快手', '墨点'] };
  assert.deepEqual(plain(R.renameBody('  新名 ', g, CATS)), { name: '新名' });
  assert.deepEqual(plain(R.renameBody('   ', g, CATS)), { name: '快手、墨点' });
  assert.equal(groupTitle.safeParse(R.renameBody('', g, CATS).name).success, true, 'what is sent for an empty name is a valid title');
});

test('a refused group change: a 409 is the server\'s own sentence (nothing is stopped), a missing cat or group says so, an unsure answer says to look', () => {
  const R = load(RULES).window.ClowderProfileRules;
  const busy = '有猫猫还在这个群里处理事情，等它做完或先停止，再把它移出';
  assert.deepEqual(plain(R.groupError(fail(409, busy), 'members')), { kind: 'busy', text: busy });
  assert.equal(R.groupError(fail(409, 'Conflict'), 'members').text, '有猫猫还在这个群里处理事情，等它做完或先停止，再把它移出。');
  assert.equal(R.groupError(fail(404, '找不到这只猫猫'), 'members').text, '有只猫猫找不到了，刷新列表后再试。');
  assert.equal(R.groupError(fail(404, '找不到这个群聊'), 'rename').text, '找不到这个群聊了，刷新列表看看。');
  assert.equal(R.groupError(fail(undefined, '连不上 clowder-bot'), 'rename').kind, 'unsure');
  assert.equal(R.groupError(fail(503), 'delete').text, '没能确认群聊删掉没有。刷新列表看看。');
  assert.equal(R.groupError(fail(400, '名字包含不支持的字符'), 'rename').text, '名字包含不支持的字符');
  assert.equal(R.groupError(fail(400, 'Bad thread id'), 'delete').text, '没能删掉群聊，请稍后再试。');
});

test('how to talk in a group is the engine\'s routing in one line: 全体 means @ each member, never the engine\'s own @全体', () => {
  const R = load(RULES).window.ClowderProfileRules;
  assert.equal(R.HOW_TO_TALK, '直接说，由一只猫猫接待；@名字 指定某一只；要大家都回答，就把每只都 @ 上（输入 @ 选「全体」）');
  assert.doesNotMatch(R.HOW_TO_TALK, /@全体|@all/);
});

// ---------------------------------------------------------------- rules: @
const M = () => load(['client/public/mention-rules.js']).window.ClowderMentionRules;

test('@ rules: the mention at the caret starts at an @ after a space, a line start or punctuation, never inside an address, and not across lines', () => {
  const R = M();
  assert.deepEqual(plain(R.active('@', 1)), { start: 0, end: 1, query: '' });
  assert.deepEqual(plain(R.active('请 @快', 4)), { start: 2, end: 4, query: '快' });
  assert.deepEqual(plain(R.active('好的，@墨', 5)), { start: 3, end: 5, query: '墨' });
  assert.deepEqual(plain(R.active('请 ＠快', 4)), { start: 2, end: 4, query: '快' }, 'a full-width @ from a Chinese keyboard');
  assert.deepEqual(plain(R.active('@宪宪 2', 5)), { start: 0, end: 5, query: '宪宪 2' }, 'a name may hold a space');
  assert.equal(R.active('mail me@x.com', 13), null, 'an address');
  assert.equal(R.active('文字@快', 4), null, 'glued to a word');
  assert.equal(R.active('@快\n手', 4), null, 'not across a line');
  assert.equal(R.active('没有艾特', 4), null);
  assert.equal(R.active('@' + 'a'.repeat(33), 34), null, 'too long to be a name');
  assert.deepEqual(plain(R.active('@快 后面', 2)), { start: 0, end: 2, query: '快' }, 'only up to the caret');
  assert.equal(R.active('@快', null), null, 'no caret, no list');
});

test('@ rules: members that start with what is typed come first, then those containing it, then 全体 (only with two or more); nothing fitting gives nothing', () => {
  const R = M();
  const names = ['快手', '墨点', '小快', 'Mochi'];
  const show = (q: string, n = names) => plain(R.suggest(q, n).map((it: Any) => it.kind === 'all' ? '全体' : it.name));
  assert.deepEqual(show(''), ['快手', '墨点', '小快', 'Mochi', '全体']);
  assert.deepEqual(show('快'), ['快手', '小快']);
  assert.deepEqual(show('mo'), ['Mochi'], 'case does not matter');
  assert.deepEqual(show('全'), ['全体']);
  assert.deepEqual(show('al'), ['全体']);
  assert.deepEqual(show('大家'), ['全体']);
  assert.deepEqual(show('', ['快手']), ['快手'], 'one member: no 全体');
  assert.deepEqual(show('明天下午三点'), [], 'a sentence after @ closes the list');
  assert.equal(R.ALL.label, '全体');
  assert.equal(R.ALL.hint, '@ 群里每一只');
});

test('@ rules: picking writes @名字 and one space at the caret; 全体 writes one mention per member, never @全体 or @all, skipping those already mentioned', () => {
  const R = M();
  const at = (text: string, caret: number) => R.active(text, caret);
  const cat = { kind: 'cat', name: '墨点' }, every = R.ALL, names = ['快手', '墨点'];
  assert.deepEqual(plain(R.insert('请 @墨', at('请 @墨', 4), cat, names)), { text: '请 @墨点 ', caret: 6 });
  assert.deepEqual(plain(R.insert('@墨 看看', at('@墨 看看', 2), cat, names)), { text: '@墨点 看看', caret: 4 }, 'no second space');
  assert.deepEqual(plain(R.insert('@\n下一行', at('@\n下一行', 1), cat, names)), { text: '@墨点 \n下一行', caret: 4 });
  const all = R.insert('请 @', at('请 @', 3), every, names);
  assert.deepEqual(plain(all), { text: '请 @快手 @墨点 ', caret: 10 });
  assert.doesNotMatch(all.text, /@全体|@all/);
  assert.deepEqual(plain(R.insert('@快手 和 @全', at('@快手 和 @全', 8), every, names)), { text: '@快手 和 @墨点 ', caret: 10 }, 'already mentioned once is enough');
  assert.equal(R.mentioned('@快手好', '快手'), false, 'a longer word is not the mention');
  assert.equal(R.mentioned('找 @快手。', '快手'), true);
  // Overlapping names with a space: at each @ the longest name counts, as the engine reads it (review item 5).
  const near = ['团', '团 子'];
  assert.deepEqual(plain(R.insert('@团 子 和 @全', at('@团 子 和 @全', 9), every, near)), { text: '@团 子 和 @团 ', caret: 10 }, '「团」 is still added');
  assert.deepEqual([...R.mentions('@团 子 和 @团 好', near)].sort(), ['团', '团 子']);
  assert.deepEqual([...R.mentions('@团 子', near)], ['团 子']);
  assert.equal(R.mentioned('@团 子', '团', near), false);
  assert.deepEqual(plain(R.insert('@团 和 @全', at('@团 和 @全', 7), every, near)), { text: '@团 和 @团 子 ', caret: 10 });
});

// ---------------------------------------------------------------- the drawer (profile.js)
type Call = { path: string; method: string; body?: Any };
function drawer(opts: { cats?: Any[]; groups?: Any[]; route?: (path: string, method: string, body: Any) => unknown } = {}) {
  const env = load([...RULES, 'client/public/profile.js']);
  const { doc, window } = env;
  const start = plain(opts.groups ?? [{ id: 'g1', name: '读书会', members: ['快手', '墨点', '年糕'] }]);
  // server: what the adapter holds; groups: the shell's list (state.groups), replaced by every poll.
  const s: Any = { cats: plain(opts.cats ?? CATS), server: plain(start), groups: plain(start), sel: null, rows: {} };
  const calls: Call[] = [], log: string[] = [];
  const api = async (path: string, opt: { method?: string; body?: unknown } = {}) => {
    const call: Call = { path, method: opt.method || 'GET', ...(opt.body === undefined ? {} : { body: plain(opt.body) }) };
    calls.push(call);
    const custom = opts.route ? await opts.route(path, call.method, call.body) : undefined;
    if (custom !== undefined) return plain(custom);
    const g = /^\/xbot-api\/groups\/([^/]+)$/.exec(path);
    if (g && call.method === 'PATCH') {
      // As the adapter does: intent applied to the roster as it is now; the answer is a new object.
      const group = s.server.find((x: Any) => x.id === decodeURIComponent(g[1]));
      if (call.body.members) group.members = [...call.body.members];
      if (call.body.add || call.body.remove) {
        const next = group.members.filter((m: string) => !(call.body.remove || []).includes(m));
        for (const m of call.body.add || []) if (!next.includes(m)) next.push(m);
        if (next.length < 2) throw fail(400, '群聊里至少要有两只猫猫');
        group.members = next;
      }
      if (call.body.name) group.name = call.body.name;
      return plain(group);
    }
    if (g && call.method === 'DELETE') { s.server = s.server.filter((x: Any) => x.id !== decodeURIComponent(g[1])); return { status: 'ok' }; }
    throw fail(404);
  };
  const made = (tag: string, cls: string, data: Record<string, string> = {}) => { const n = doc.createElement(tag); n.className = cls; for (const k of Object.keys(data)) n.dataset[k] = data[k]; return n; };
  const parts = { agent: 0, config: 0, exec: 0 };
  const tasksNode = made('section', 'ws-pane wst');
  const convNode = made('div', 'psec ws-convs');
  const P = window.ClowderProfile;
  // The hooks app.js passes (see profile.init in client/public/app.js).
  P.init({
    api,
    icon: (name: string) => made('svg', 'icon', { icon: name }),
    visibleError: (e: Error) => e.message || '操作失败',
    toast: (text: string) => log.push('toast:' + text),
    cats: () => s.cats,
    catFace: (name: string) => made('span', 'avatar', { cat: name }),
    catFaceSig: (name: string) => 'face:' + name,
    groupFace: (g: Any) => made('span', 'avatar group', { group: g.id }),
    groupFaceSig: (g: Any) => JSON.stringify(g.members),
    unknownFace: () => made('span', 'avatar glyph'),
    agent: (data: Any) => ({ sig: JSON.stringify(data.agent || null), node: () => { parts.agent++; return made('button', 'agent-trigger', { agent: data.agent ? data.agent.label : '' }); } }),
    config: (data: Any) => ({ sig: JSON.stringify(data.cat_config || null), node: () => { parts.config++; return data.cat_config ? made('div', 'psec cat-config') : null; } }),
    tasks: () => tasksNode,
    exec: (data: Any) => { parts.exec++; return made('div', 'task-view', { bot: data.name }); },
    syncExec: (root: El) => log.push('sync:' + root.dataset.bot),
    conversations: () => convNode,
    runtimeHref: (data: Any) => data.thread_id ? '/runtime.html?thread=' + data.thread_id : '/runtime.html',
    newConversation: (sel: Any, opener: El) => { log.push('new:' + sel.type + ':' + sel.id); s.opener = opener; },
    editProfile: (data: Any) => log.push('edit:' + data.name),
    pin: async (name: string, on: boolean) => {
      log.push('pin:' + name + ':' + on);
      if (s.pinGate) await s.pinGate;
      if (s.pinFails) throw fail(500, '服务出了点问题，请稍后再试。');
      s.cats.find((c: Any) => c.name === name).pinned = on;
    },
    exportChat: (name: string) => log.push('export:' + name),
    copyId: (name: string) => log.push('copy:' + name),
    deleteCat: (name: string) => log.push('delete:' + name),
    // As app.js: the answered record replaces the list's entry at once (a new object).
    groupChanged: async (id: string, record: Any) => {
      log.push('changed:' + id);
      if (record) s.groups = s.groups.map((x: Any) => (x.id === id ? plain(record) : x));
    },
    groupDeleted: async (id: string) => { log.push('deleted:' + id); },
    closePops: () => { log.push('closePops'); for (const m of named(doc.body, 'pf-group-menu')) m.remove(); },
    selected: () => s.sel,
    groups: () => s.groups,
    groupRow: (id: string) => s.rows[id] || null,
    fallbackFocus: () => null,
  });
  const panel = doc.createElement('div');
  doc.body.append(panel);
  const show = (node: El) => { panel.replaceChildren(node); return node; };
  return {
    ...env, P, R: window.ClowderProfileRules, s, calls, log, parts, panel, show, tasksNode, convNode,
    group: (id = 'g1') => s.groups.find((x: Any) => x.id === id),
    // A poll: the shell's list replaced by what the server holds now (new objects).
    poll: () => { s.groups = plain(s.server); },
    // Someone else edits the group (another tab, the runtime panel).
    elsewhere: (fn: (g: Any) => void, id = 'g1') => fn(s.server.find((x: Any) => x.id === id)),
    layer: () => named(doc.body, 'pf-modal')[0] ?? null,
    writes: () => calls.filter(c => c.method !== 'GET'),
  };
}
const TUANZI = { type: 'bot', id: '快手' };
const PROFILE = { name: '快手', persona: '帮你查资料、写东西。', agent: { id: 'claude', label: 'Claude Code' }, cat_config: { model: { mode: 'inherit' } }, thread_id: 'thread-1' };

test('资料: 职责 (or the way to write one), 置顶 as a switch, 新对话 with what happens to this conversation, 历史对话, and 删除猫猫 last; nothing technical outside 高级', async () => {
  const d = drawer();
  // Before the profile is read, 职责 waits instead of saying there is none.
  const page = d.show(d.P.catPage(TUANZI, { name: '快手' }));
  assert.equal(shown(one(page, 'pf-duty')), false);
  d.P.catPage(TUANZI, PROFILE);
  assert.equal(visibleText(one(page, 'pf-duty')), '职责帮你查资料、写东西。');
  d.P.catPage(TUANZI, { ...PROFILE, persona: '' });
  assert.match(visibleText(one(page, 'pf-duty')), /还没写它负责什么。编辑资料/);
  button(page, '编辑资料').click();
  assert.deepEqual(d.log, ['edit:快手']);
  d.P.catPage(TUANZI, PROFILE);
  // The order a messenger's profile reads in.
  const order = page.children.map(n => n.className);
  assert.deepEqual(order, ['psec pf-duty', 'pf-row pf-pin', 'pf-line', 'psec pf-convs', 'pf-rule', 'task-details pf-adv', 'pf-foot']);
  assert.match(visibleText(one(page, 'pf-convs')), /^对话新对话现在的对话会收进「历史对话」/);
  assert.ok(one(page, 'pf-convs-slot').firstChild === d.convNode, '历史对话 is the conversations module\'s node');
  assert.equal(one(page, 'pf-remove').textContent, '删除猫猫');
  assert.equal(one(page, 'pf-remove').getAttribute('aria-label'), '删除猫猫「快手」');
  one(page, 'pf-remove').click();
  assert.equal(d.log.at(-1), 'delete:快手');
  // 高级 is closed and not even drawn: no Agent row, no task or run cards yet.
  const fold = one(page, 'pf-adv');
  assert.equal(fold.open, false);
  assert.deepEqual(d.parts, { agent: 0, config: 0, exec: 0 });
  assert.doesNotMatch(visibleText(page), /Agent|模型|推理|轨迹|上下文|原生|Bot/);
});

test('高级 holds what is technical: drawn the first time it opens, kept open across repaints and tab changes, and its parts redrawn only when they change', async () => {
  const d = drawer();
  const page = d.show(d.P.catPage(TUANZI, PROFILE));
  const fold = one(page, 'pf-adv');
  fold.open = true;
  fold.dispatch('toggle');
  assert.deepEqual(d.parts, { agent: 1, config: 1, exec: 1 });
  const body = one(page, 'pf-adv-body');
  assert.match(visibleText(body), /^它用什么思考/);
  assert.ok(all(body).includes(d.tasksNode), 'the task cards (workspace.js)');
  assert.ok(named(body, 'task-view').length === 1, 'the run cards');
  assert.deepEqual(named(body, 'pf-act').map(n => visibleText(n)), ['导出对话', '复制 ID', '在运行面板查看']);
  assert.equal(one(body, 'pf-act').tagName, 'BUTTON');
  const runtime = named(body, 'pf-act')[2];
  assert.equal(runtime.getAttribute('href'), '/runtime.html?thread=thread-1');
  assert.equal(runtime.target, '_blank');
  named(body, 'pf-act')[0].click();
  named(body, 'pf-act')[1].click();
  assert.deepEqual(d.log.slice(-2), ['export:快手', 'copy:快手']);
  assert.doesNotMatch(visibleText(body), /引导/, 'the steer control had no route and is gone');
  // A repaint of the same cat: the same page, the same Agent row, run cards synced in place.
  const agentRow = one(body, 'agent-trigger');
  assert.equal(d.P.catPage(TUANZI, PROFILE), page);
  assert.equal(one(page, 'agent-trigger'), agentRow, 'unchanged: not rebuilt, focus stays');
  assert.deepEqual(d.parts, { agent: 1, config: 1, exec: 1 });
  assert.equal(d.log.at(-1), 'sync:快手');
  // A changed Agent is drawn again.
  d.P.catPage(TUANZI, { ...PROFILE, agent: { id: 'codex', label: 'Codex' } });
  assert.notEqual(one(page, 'agent-trigger'), agentRow);
  assert.equal(one(page, 'agent-trigger').dataset.agent, 'Codex');
  // Another tab and back: still open (the page is the same element for the same cat).
  d.panel.replaceChildren();
  assert.equal(d.show(d.P.catPage(TUANZI, PROFILE)), page);
  assert.equal(one(page, 'pf-adv').open, true);
  // Another cat gets its own page, closed; coming back draws this cat's again with 高级 still open.
  const other = d.P.catPage({ type: 'bot', id: '墨点' }, { name: '墨点', persona: 'x' });
  assert.notEqual(other, page);
  assert.equal(one(other, 'pf-adv').open, false);
  const again = d.P.catPage(TUANZI, PROFILE);
  assert.equal(one(again, 'pf-adv').open, true);
  // A configuration that gives nothing hides its section.
  d.P.catPage(TUANZI, { ...PROFILE, cat_config: null });
  assert.equal(shown(one(again, 'pf-config')), false);
});

test('reveal() opens 高级 where 任务 now is, before or after the page is drawn', () => {
  const d = drawer();
  d.P.reveal(TUANZI);
  const page = d.show(d.P.catPage(TUANZI, PROFILE));
  assert.equal(one(page, 'pf-adv').open, true, 'asked before drawing');
  assert.ok(all(page).includes(d.tasksNode));
  const g = d.show(d.P.groupPage({ type: 'group', id: 'g1' }, d.group()));
  assert.equal(one(g, 'pf-adv').open, false);
  d.P.reveal({ type: 'group', id: 'g1' });
  assert.equal(one(g, 'pf-adv').open, true, 'asked while shown');
  assert.ok(all(g).includes(d.tasksNode), 'a group\'s 高级 has its task cards');
});

test('置顶: the switch says only what the list confirms — while saving it keeps that state, is busy and inert (focus kept) with the line saying what is saved — and says why when it did not stick', async () => {
  const d = drawer();
  const page = d.show(d.P.catPage(TUANZI, PROFILE));
  const sw = one(page, 'pf-switch');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  let open!: () => void;
  d.s.pinGate = new Promise<void>((r) => { open = r; });
  sw.focus();
  sw.click();
  // Not pinned until the server says so (review item 9): the asked-for state is the line's, not the switch's.
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(sw.getAttribute('aria-busy'), 'true');
  assert.equal(sw.getAttribute('aria-disabled'), 'true');
  assert.equal(one(page, 'pf-row-hint').textContent, '正在置顶…');
  sw.click();
  assert.deepEqual(d.log, ['pin:快手:true'], 'one request at a time');
  open();
  await settle();
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(sw.getAttribute('aria-busy'), null);
  assert.equal(sw.getAttribute('aria-disabled'), null);
  assert.equal(one(page, 'pf-row-hint').textContent, '放在列表最上面');
  assert.equal(d.doc.activeElement, sw);
  d.s.pinGate = null;
  // The whole row is the label.
  one(page, 'pf-row-title').click();
  await settle();
  assert.equal(d.log.at(-1), 'pin:快手:false');
  // A failure keeps what the list says, with the reason under it.
  d.s.pinFails = true;
  sw.click();
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  await settle();
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(visibleText(one(page, 'pf-line')), '没能置顶：服务出了点问题，请稍后再试。');
});

test('新对话 on 资料 opens the shared dialog (the header ⋯ menu\'s own) for this cat, with focus to come back to the button; the page itself sends nothing', async () => {
  const d = drawer();
  const page = d.show(d.P.catPage(TUANZI, PROFILE));
  const fresh = one(page, 'pf-new');
  assert.equal(visibleText(fresh), '新对话');
  assert.equal(fresh.getAttribute('aria-haspopup'), 'dialog');
  fresh.click();
  await settle();
  assert.deepEqual(d.log, ['new:bot:快手']);
  assert.equal(d.s.opener, fresh, 'the dialog returns focus here');
  assert.equal(d.calls.length, 0, 'the request, its idle check and its refusals belong to chat-history.js');
});

// The drawer with the real chat-history.js behind its 新对话, wired the way
// app.js wires both; reopen() does what selectBot does: a new selection
// object for the same cat, the chat on a new conversation, the drawer drawn again.
function drawerWithHistory() {
  const env = load([...RULES, 'client/public/profile.js', 'client/public/chat-history-rules.js', 'client/public/chat-history.js']);
  const { doc, window } = env;
  const top = doc.createElement('div'); top.className = 'top-inner';
  const thread = doc.createElement('div'); thread.id = 'thread';
  const form = doc.createElement('form'); form.id = 'composer';
  const input = doc.createElement('div'); input.id = 'input';
  form.append(input);
  const panel = doc.createElement('aside');
  doc.body.append(top, thread, form, panel);
  const shell: Any = { sel: { type: 'bot', id: '快手' }, thread: 'T1', posts: [] as Any[], passed: [] as boolean[], n: 1 };
  const api = async (path: string, opt: Any = {}) => {
    if (/\/new$/.test(path)) { shell.posts.push(plain(opt.body ?? null)); return { status: 'ok', conversation_id: 'T' + (shell.n + 1) }; }
    throw fail(404);
  };
  const made = (tag: string, cls: string) => { const n = doc.createElement(tag); n.className = cls; return n; };
  const P = window.ClowderProfile, Hy = window.ClowderHistory;
  const draw = () => { panel.replaceChildren(P.catPage(shell.sel, PROFILE)); };
  P.init({
    api, icon: (name: string) => made('svg', 'icon ' + name), visibleError: (e: Error) => e.message, toast: () => {},
    cats: () => CATS, catFace: () => made('span', 'avatar'), catFaceSig: () => 'f', groupFace: () => made('span', 'avatar'), groupFaceSig: () => 'g', unknownFace: () => made('span', 'avatar'),
    agent: () => ({ sig: 'a', node: () => made('div', 'agent') }), config: () => ({ sig: 'c', node: () => null }),
    tasks: () => made('section', 'wst'), exec: () => made('div', 'task-view'), syncExec: () => {}, conversations: () => null, runtimeHref: () => '',
    newConversation: (sel: Any, opener: El) => { shell.passed.push(sel === shell.sel); return Hy.newConversation(sel, opener); },
    editProfile: () => {}, pin: async () => {}, exportChat: () => {}, copyId: () => {}, deleteCat: () => {},
    groupChanged: async () => {}, groupDeleted: async () => {}, closePops: () => {},
    selected: () => shell.sel, groups: () => [], groupRow: () => null, fallbackFocus: () => input,
  });
  Hy.init({
    api, visibleError: (e: Error) => e.message, thread,
    selected: () => shell.sel, name: (sel: Any) => sel.id,
    reload: async () => {},
    reopen: async (sel: Any) => { shell.n++; shell.thread = 'T' + shell.n; shell.sel = { type: 'bot', id: sel.id }; draw(); },
    send: () => {}, sendBusy: () => false, working: () => false, pendingFiles: () => 0,
    threadId: () => shell.thread, conversations: async () => 1, openDetails: async () => {},
    place: (_a: El, menu: El) => doc.body.append(menu), toast: () => {}, status: () => {},
  });
  Hy.select(shell.sel);
  draw();
  return { ...env, shell, panel, start: () => { one(panel, 'pf-new').click(); one(named(doc.body, 'ch-modal')[0]!, 'modal-card').dispatch('submit'); } };
}

test('新对话 twice in a row from the drawer, with the real dialog behind it: the page acts for the selection the shell has now, so the second one is sent too (review item 2)', async () => {
  const w = drawerWithHistory();
  w.start();
  await settle();
  assert.deepEqual(w.shell.posts, [{ expectedThreadId: 'T1' }]);
  assert.equal(w.shell.thread, 'T2', 'reopened on the new conversation, as a new selection object');
  w.start();
  await settle();
  assert.deepEqual(w.shell.posts, [{ expectedThreadId: 'T1' }, { expectedThreadId: 'T2' }], 'the second 新对话 was sent, naming the conversation on screen');
  assert.deepEqual(w.shell.passed, [true, true], 'each time for the selection the shell has now, not the one the page was built with');
  assert.equal(named(w.doc.body, 'ch-modal').length, 0);
});

const GROUP = { type: 'group', id: 'g1' };

test('成员: faces and names, 移出 only while two would stay, a second click within three seconds confirms, and the PATCH says only who leaves', async () => {
  const d = drawer();
  const page = d.show(d.P.groupPage(GROUP, d.group()));
  assert.equal(one(page, 'pf-sec-head').firstChild!.textContent, '成员 · 3');
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '墨点', '年糕']);
  assert.deepEqual(named(page, 'pf-member-face').map(n => n.firstChild!.dataset.cat), ['快手', '墨点', '年糕']);
  assert.equal(visibleText(one(page, 'pf-hint')), d.R.HOW_TO_TALK);
  const out = named(page, 'pf-out')[1];
  assert.equal(out.getAttribute('aria-label'), '把「墨点」移出群聊');
  out.focus();
  out.click();
  assert.equal(d.writes().length, 0, 'the first click only asks');
  assert.equal(visibleText(out), '移出');
  assert.equal(out.getAttribute('aria-label'), '再点一次，把「墨点」移出群聊');
  // Left alone, it calms down after three seconds.
  d.advance(3000);
  assert.equal(visibleText(out), '');
  out.click();
  out.click();
  await settle();
  assert.deepEqual(d.writes(), [{ path: '/xbot-api/groups/g1', method: 'PATCH', body: { remove: ['墨点'] } }]);
  assert.ok(d.log.includes('changed:g1'));
  // The page shows the group the server answered with, before any repaint from the shell.
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '年糕']);
  d.P.groupPage(GROUP, d.group());
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '年糕']);
  assert.equal(visibleText(one(one(page, 'pf-members-sec'), 'pf-line')), '已把「墨点」移出群聊。');
  // Two left: neither can go.
  assert.deepEqual(named(page, 'pf-out').map(shown), [false, false]);
});

test('a drawer that has not caught up cannot undo an edit made elsewhere: 移出 sends only who leaves, and the page shows the roster the server answered with (review item 1)', async () => {
  const d = drawer();
  const page = d.show(d.P.groupPage(GROUP, d.group()));
  // Another tab adds 宪宪 2; this drawer has not polled since.
  d.elsewhere((g) => g.members.push('宪宪 2'));
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '墨点', '年糕']);
  const out = named(page, 'pf-out')[1];
  out.click();
  out.click();
  await settle();
  assert.deepEqual(d.writes().map(c => c.body), [{ remove: ['墨点'] }]);
  assert.deepEqual(plain(d.s.server[0].members), ['快手', '年糕', '宪宪 2'], 'the other edit stands');
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '年糕', '宪宪 2'], 'the answer, not the stale record');
  assert.deepEqual(plain(d.group().members), ['快手', '年糕', '宪宪 2'], 'the shell\'s list took the answer too');
  // The 添加猫猫 dialog reads the freshest record the shell has (a poll replaced the list meanwhile).
  d.elsewhere((g) => g.members.splice(g.members.indexOf('宪宪 2'), 1));
  d.poll();
  one(page, 'pf-add').click();
  assert.deepEqual(named(d.layer()!, 'qc-chip-name').map(n => n.textContent), ['墨点', '宪宪 2']);
});

test('移出 refused because the cat still has work there: the server\'s words, the members as they were, and nothing is stopped', async () => {
  const busy = '有猫猫还在这个群里处理事情，等它做完或先停止，再把它移出';
  const d = drawer({ route: (path, method) => { if (method === 'PATCH') throw fail(409, busy); return undefined; } });
  const page = d.show(d.P.groupPage(GROUP, d.group()));
  const out = named(page, 'pf-out')[2];
  out.click();
  out.click();
  await settle();
  assert.deepEqual(d.calls.map(c => c.method + ' ' + c.path), ['PATCH /xbot-api/groups/g1'], 'no stop, no other request');
  assert.equal(visibleText(one(one(page, 'pf-members-sec'), 'pf-line')), busy);
  assert.equal(one(one(page, 'pf-members-sec'), 'pf-line').getAttribute('role'), 'alert');
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '墨点', '年糕']);
  assert.equal(d.log.includes('changed:g1'), false);
});

test('添加猫猫: the cats not yet in the group as face chips; the PATCH says only who joins, in the order picked; with every cat in already it says so', async () => {
  const d = drawer({ groups: [{ id: 'g1', name: '读书会', members: ['快手', '墨点'] }] });
  const page = d.show(d.P.groupPage(GROUP, d.group()));
  const add = one(page, 'pf-add');
  add.click();
  const layer = d.layer()!;
  assert.deepEqual(named(layer, 'qc-chip-name').map(n => n.textContent), ['年糕', '宪宪 2']);
  const go = button(layer, '添加');
  assert.equal(go.disabled, true, 'nothing picked yet');
  const boxes = all(layer).filter(n => n.type === 'checkbox');
  for (const b of [boxes[1], boxes[0]]) { b.checked = true; b.dispatch('change'); }
  assert.equal(one(layer, 'qc-hint').textContent, '已选 2 只');
  one(layer, 'pf-card').dispatch('submit');
  await settle();
  assert.deepEqual(d.writes(), [{ path: '/xbot-api/groups/g1', method: 'PATCH', body: { add: ['宪宪 2', '年糕'] } }], 'in the order picked');
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '墨点', '宪宪 2', '年糕'], 'shown from the answer');
  assert.equal(d.layer(), null);
  assert.equal(d.doc.activeElement, add, 'focus back on 添加猫猫');
  assert.equal(visibleText(one(one(page, 'pf-members-sec'), 'pf-line')), '已添加「宪宪 2」「年糕」。');
  // Everyone in: the button rests and the dialog only says so.
  assert.equal(add.disabled, true);
  assert.equal(add.dataset.tip, '所有猫猫都已经在群里了');
});

test('a group\'s name is edited in place: Enter saves, Esc goes back, empty takes the members\' names, a bad name or a refusal keeps the edit open', async () => {
  const d = drawer();
  const head = d.show(d.P.groupHead(GROUP, d.group()));
  assert.equal(visibleText(one(head, 'pf-head-sub')), '3 只猫猫');
  assert.equal(one(head, 'pf-name').getAttribute('aria-label'), '改群名：读书会');
  one(head, 'pf-name').click();
  const input = one(head, 'pf-name-input');
  assert.equal(input.value, '读书会');
  assert.equal(input.placeholder, '快手、墨点、年糕');
  assert.equal(d.doc.activeElement, input);
  // A repaint while editing keeps the edit.
  assert.equal(d.P.groupHead(GROUP, d.group()), head);
  assert.equal(one(head, 'pf-name-input'), input);
  // Esc: back to the name, nothing sent, the drawer's own Esc not reached.
  const esc = input.key('Escape');
  assert.equal(esc.stopped, true);
  assert.equal(named(head, 'pf-name-input').length, 0);
  assert.equal(d.doc.activeElement, one(head, 'pf-name'));
  // A bad name: said under it, nothing sent.
  one(head, 'pf-name').click();
  one(head, 'pf-name-input').value = '读书<会>';
  one(head, 'pf-name-input').dispatch('input');
  one(head, 'pf-name-input').key('Enter');
  await settle();
  assert.equal(visibleText(one(head, 'pf-head-sub')), '群名里不能有 < > 这类符号');
  assert.equal(d.writes().length, 0);
  // Cleared: the members' names, as an unnamed group gets.
  one(head, 'pf-name-input').value = '  ';
  one(head, 'pf-name-input').key('Enter');
  await settle();
  assert.deepEqual(d.writes(), [{ path: '/xbot-api/groups/g1', method: 'PATCH', body: { name: '快手、墨点、年糕' } }]);
  assert.equal(named(head, 'pf-name-input').length, 0);
  assert.ok(d.log.includes('changed:g1'));
  // Refused: the reason, still editing with what was typed.
  const refused = drawer({ route: (_p, method) => { if (method === 'PATCH') throw fail(404, '找不到这个群聊'); return undefined; } });
  const h2 = refused.show(refused.P.groupHead(GROUP, refused.group()));
  one(h2, 'pf-name').click();
  one(h2, 'pf-name-input').value = '晨会';
  one(h2, 'pf-name-input').key('Enter');
  await settle();
  assert.equal(visibleText(one(h2, 'pf-head-sub')), '找不到这个群聊了，刷新列表看看。');
  assert.equal(one(h2, 'pf-name-input').value, '晨会');
  // The same name again is no change: nothing sent.
  const same = drawer();
  const h3 = same.show(same.P.groupHead(GROUP, same.group()));
  same.P.renameHere();
  one(h3, 'pf-name-input').key('Enter');
  await settle();
  assert.equal(same.writes().length, 0);
});

test('a cat\'s head carries its own colour as a quiet wash only when the server gives one', () => {
  const d = drawer({ cats: [{ name: '快手', native_id: 'cat-k', accent: { primary: '#D4A373', secondary: '#FAEDCD' } }, { name: '墨点', native_id: 'cat-m' }] });
  const head = d.show(d.P.catHead(TUANZI, PROFILE));
  assert.equal(has(head, 'tinted'), true);
  assert.equal(head.style['--pf-accent'], '#D4A373');
  assert.equal(one(head, 'pf-portrait').firstChild!.dataset.cat, '快手');
  const other = d.P.catHead({ type: 'bot', id: '墨点' }, { name: '墨点' });
  assert.equal(has(other, 'tinted'), false);
  assert.equal(other.style['--pf-accent'], undefined);
});

test('删除群聊 and the sidebar menu: 改名 and 删除群聊 only; deleting asks first, says the history is kept, and only then sends DELETE', async () => {
  const d = drawer();
  const menu = d.P.groupMenu(d.group());
  assert.deepEqual(named(menu, 'menu-row').map(n => visibleText(n)), ['改名', '删除群聊']);
  // 改名 from the menu: a dialog with the name, its placeholder the members' names.
  named(menu, 'menu-row')[0].click();
  assert.equal(d.log.at(-1), 'closePops');
  let layer = d.layer()!;
  const input = all(layer).find(n => n.tagName === 'INPUT')!;
  assert.equal(input.value, '读书会');
  assert.equal(input.placeholder, '快手、墨点、年糕');
  input.value = '晨读';
  one(layer, 'pf-card').dispatch('submit');
  await settle();
  assert.deepEqual(d.writes(), [{ path: '/xbot-api/groups/g1', method: 'PATCH', body: { name: '晨读' } }]);
  // 删除群聊: Esc cancels without a request.
  const page = d.show(d.P.groupPage(GROUP, d.group()));
  one(page, 'pf-remove').click();
  layer = d.layer()!;
  assert.match(visibleText(layer), /删除「晨读」？群里的聊天记录不会被抹掉，但这个群聊会从列表里消失/);
  const esc = one(layer, 'pf-card').key('Escape');
  assert.equal(esc.stopped, true, 'the drawer stays open');
  assert.equal(d.layer(), null);
  assert.equal(d.writes().length, 1);
  one(page, 'pf-remove').click();
  one(d.layer()!, 'pf-card').dispatch('submit');
  await settle();
  assert.deepEqual(d.writes().at(-1), { path: '/xbot-api/groups/g1', method: 'DELETE' });
  assert.equal(d.log.at(-1), 'deleted:g1');
  // A refused delete keeps the dialog with the reason.
  const refused = drawer({ route: (_p, method) => { if (method === 'DELETE') throw fail(500); return undefined; } });
  const p2 = refused.show(refused.P.groupPage(GROUP, refused.group()));
  one(p2, 'pf-remove').click();
  one(refused.layer()!, 'pf-card').dispatch('submit');
  await settle();
  assert.match(visibleText(refused.layer()!), /没能确认群聊删掉没有。刷新列表看看。/);
  assert.equal(refused.log.includes('deleted:g1'), false);
});

test('a group row\'s menu works from the keyboard: arrows, Home/End, Esc back to the row — found again by the group\'s id after the list redrew it — and a dialog it opened gives focus back there too (review item 6)', () => {
  const d = drawer();
  const menu = d.P.groupMenu(d.group());
  d.doc.body.append(menu);
  const items = all(menu).filter(n => n.tagName === 'BUTTON');
  assert.equal(menu.getAttribute('role'), 'menu');
  items[0].focus();
  items[0].key('ArrowDown'); assert.equal(d.doc.activeElement, items[1]);
  items[1].key('ArrowDown'); assert.equal(d.doc.activeElement, items[0], 'wraps');
  items[0].key('ArrowUp'); assert.equal(d.doc.activeElement, items[1]);
  items[1].key('Home'); assert.equal(d.doc.activeElement, items[0]);
  items[0].key('End'); assert.equal(d.doc.activeElement, items[1]);
  // The list drew the row anew meanwhile: Esc closes the menu and lands on the new row.
  const row = d.doc.createElement('button'); d.doc.body.append(row); d.s.rows.g1 = row;
  const esc = items[1].key('Escape');
  assert.equal(esc.stopped, true, 'the page\'s Esc does not also close the drawer');
  assert.ok(d.log.includes('closePops'));
  assert.equal(d.doc.activeElement, row);
  // 改名 from the menu; the row is drawn anew again while its dialog is open.
  const again = d.P.groupMenu(d.group()); d.doc.body.append(again);
  all(again).filter(n => n.tagName === 'BUTTON')[0].click();
  const row2 = d.doc.createElement('button'); d.doc.body.append(row2); d.s.rows.g1 = row2; row.remove();
  one(d.layer()!, 'pf-card').key('Escape');
  assert.equal(d.layer(), null);
  assert.equal(d.doc.activeElement, row2);
  // The shell focuses the first item when it places the menu (app.js openGroupMenu).
  assert.match(read('client/public/app.js'), /panelMore = menu;\n\s+menu\.querySelector\("\.menu-row"\)\?\.focus\(\);/);
});

test('a dialog keeps the keyboard while it works: with every button waiting Tab stays on the card, and the page behind is inert until it closes (review item 7)', async () => {
  let release!: () => void;
  const d = drawer({ route: (_p, method) => (method === 'DELETE' ? new Promise((r) => { release = () => r({ status: 'ok' }); }) : undefined) });
  const page = d.show(d.P.groupPage(GROUP, d.group()));
  one(page, 'pf-remove').click();
  const layer = d.layer()!, card = one(layer, 'pf-card');
  assert.equal(d.panel.inert, true, 'the page behind is out of reach');
  card.dispatch('submit');
  assert.ok(all(card).filter(n => n.tagName === 'BUTTON').every(b => b.disabled), 'both buttons wait');
  assert.equal(d.doc.activeElement, card);
  const tab = card.key('Tab');
  assert.equal(tab.defaultPrevented, true, 'Tab does not leave for the page');
  assert.equal(d.doc.activeElement, card);
  assert.equal(card.key('Tab', { shiftKey: true }).defaultPrevented, true);
  release();
  await settle();
  assert.equal(d.layer(), null);
  assert.equal(d.panel.inert, false, 'reachable again');
});

test('leaving the group name with Tab lets focus go on (an unchanged name, or a changed one that is saved); Enter and Esc bring it back to the name (review item 8)', async () => {
  const d = drawer();
  const head = d.show(d.P.groupHead(GROUP, d.group()));
  const next = d.doc.createElement('button'); d.doc.body.append(next);
  one(head, 'pf-name').click();
  next.focus();
  one(head, 'pf-name-input').dispatch('blur');
  await settle();
  assert.equal(named(head, 'pf-name-input').length, 0, 'the edit closed');
  assert.equal(d.doc.activeElement, next, 'focus stayed where Tab took it');
  assert.equal(d.writes().length, 0);
  one(head, 'pf-name').click();
  one(head, 'pf-name-input').value = '晨会';
  next.focus();
  one(head, 'pf-name-input').dispatch('blur');
  await settle();
  assert.deepEqual(d.writes().map(c => c.body), [{ name: '晨会' }]);
  assert.equal(d.doc.activeElement, next);
  assert.equal(one(head, 'pf-name-text').textContent, '晨会', 'shown from the answer');
  // Enter on an unchanged name: back on the name.
  one(head, 'pf-name').click();
  one(head, 'pf-name-input').key('Enter');
  await settle();
  assert.equal(d.doc.activeElement, one(head, 'pf-name'));
});

// ---------------------------------------------------------------- the @ list (mention.js)
function composer(opts: { members?: string[] | null } = {}) {
  const env = load(['client/public/mention-rules.js', 'client/public/mention.js']);
  const { doc, window } = env;
  const form = doc.createElement('form'), input = doc.createElement('div');
  form.append(input);
  doc.body.append(form);
  const s: Any = { text: '', caret: 0, members: opts.members === undefined ? ['快手', '墨点'] : opts.members };
  const applied: Array<[string, number]> = [];
  // As app.js: the composer's own Enter (send, Ctrl/⌘+Enter too) sits on the
  // input and is registered before the @ list; the form's submit is the send;
  // the page's Esc (closing the drawer) listens on the document, here the body.
  const page: string[] = [];
  input.addEventListener('keydown', (ev: Ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
    ev.preventDefault();
    form.dispatch('submit');
  });
  form.addEventListener('submit', () => page.push('send'));
  doc.body.addEventListener('keydown', (ev: Ev) => { if (ev.key === 'Escape' || ev.key.startsWith('Arrow')) page.push(ev.key); });
  window.ClowderMention.init({
    input, composer: form,
    icon: (name: string) => { const i = doc.createElement('svg'); i.dataset.icon = name; return i; },
    face: (name: string) => { const a = doc.createElement('span'); a.className = 'avatar'; a.dataset.cat = name; return a; },
    members: () => s.members,
    text: () => s.text,
    caret: () => s.caret,
    apply: (text: string, caret: number) => { applied.push([text, caret]); s.text = text; s.caret = caret; },
  });
  input.focus();
  const type = (text: string, caret = text.length) => { s.text = text; s.caret = caret; input.dispatch('input'); };
  const list = () => named(form, 'mx-pop')[0] ?? null;
  const options = () => (list() ? list()!.children.map(o => visibleText(o)) : []);
  const active = () => list()!.children.findIndex(o => o.getAttribute('aria-selected') === 'true');
  return { ...env, M: window.ClowderMention, input, form, s, applied, page, type, list, options, active };
}

test('@ in a group lists its members and 全体; ↑/↓ move, Enter inserts @名字 as one edit, and the keys never reach the page\'s send or Esc', () => {
  const c = composer();
  c.type('请 @');
  assert.deepEqual(c.options(), ['快手', '墨点', '全体@ 群里每一只']);
  assert.equal(c.list()!.getAttribute('role'), 'listbox');
  assert.equal(c.input.getAttribute('aria-controls'), c.list()!.id);
  assert.equal(c.active(), 0);
  c.input.key('ArrowDown');
  assert.equal(c.active(), 1);
  assert.equal(c.input.getAttribute('aria-activedescendant'), c.list()!.children[1].id);
  c.input.key('ArrowUp');
  c.input.key('ArrowUp');
  assert.equal(c.active(), 2, 'wraps around');
  c.input.key('ArrowDown');
  const enter = c.input.key('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(c.applied, [['请 @快手 ', 6]]);
  assert.deepEqual(c.page, [], 'neither the arrows nor Enter reached the page');
  assert.equal(c.list(), null);
  assert.equal(c.input.getAttribute('aria-controls'), null);
  // With the list closed, Enter is the composer's again: it sends.
  c.input.key('Enter');
  assert.deepEqual(c.page, ['send']);
});

test('the list never acts on what it saw: after the composer\'s own undo Enter sends instead of inserting, Ctrl/⌘+Enter sends and closes it, a member who left is not inserted, a send closes it (review item 4)', () => {
  const c = composer();
  c.type('@快');
  assert.deepEqual(c.options(), ['快手']);
  // The composer's undo (composerApply) changes the draft with no input event.
  c.s.text = ''; c.s.caret = 0;
  const enter = c.input.key('Enter');
  assert.deepEqual(c.applied, [], 'nothing inserted');
  assert.equal(c.list(), null);
  assert.equal(enter.defaultPrevented, true, 'prevented by the composer\'s own send');
  assert.deepEqual(c.page, ['send'], 'the Enter was the composer\'s');
  // Ctrl/⌘+Enter with the list open: it sends, and the list goes with it.
  c.type('请 @');
  c.input.key('Enter', { metaKey: true });
  assert.equal(c.list(), null);
  assert.deepEqual(c.applied, []);
  assert.deepEqual(c.page, ['send', 'send']);
  c.type('请 @');
  c.input.key('Enter', { ctrlKey: true });
  assert.equal(c.list(), null);
  assert.deepEqual(c.page, ['send', 'send', 'send']);
  // A member who left while the list was open: the key shows the list as it is now instead of inserting the old row.
  c.type('@');
  assert.deepEqual(c.options(), ['快手', '墨点', '全体@ 群里每一只']);
  c.s.members = ['墨点', '年糕'];
  c.input.key('Enter');
  assert.deepEqual(c.applied, []);
  assert.deepEqual(c.options(), ['墨点', '年糕', '全体@ 群里每一只']);
  c.input.key('Enter');
  assert.deepEqual(c.applied, [['@墨点 ', 4]]);
  // A click on a row no longer offered inserts nothing.
  c.type('@');
  const row = c.list()!.children[0];
  c.s.members = ['年糕', '快手'];
  row.dispatch('click');
  assert.equal(c.applied.length, 1);
  // A send from anywhere (the page's submit) closes an open list.
  c.type('@');
  assert.notEqual(c.list(), null);
  c.form.dispatch('submit');
  assert.equal(c.list(), null);
});

test('「全体」 writes one @ per member, never @全体; typing narrows the list; Tab inserts; a click inserts too', () => {
  const c = composer();
  c.type('@全');
  assert.deepEqual(c.options(), ['全体@ 群里每一只']);
  c.input.key('Tab');
  assert.deepEqual(c.applied.at(-1), ['@快手 @墨点 ', 8]);
  assert.doesNotMatch(c.s.text, /@全体|@all/);
  c.type('@快手 @墨点 问 @墨');
  assert.deepEqual(c.options(), ['墨点']);
  c.list()!.children[0].dispatch('click');
  assert.deepEqual(c.applied.at(-1), ['@快手 @墨点 问 @墨点 ', 14]);
  // Something that fits nobody closes the list.
  c.type('邮件 a@b');
  assert.equal(c.list(), null);
});

test('Esc dismisses the list (and only the list) until another @; single chats never show it; a composition in progress is left alone', () => {
  const c = composer();
  c.type('@');
  const esc = c.input.key('Escape');
  assert.equal(esc.stopped, true, 'the drawer is not closed by this Esc');
  assert.equal(c.list(), null);
  c.type('@快');
  assert.equal(c.list(), null, 'the same @ stays quiet');
  c.type('@快 和 @');
  assert.notEqual(c.list(), null, 'a new @ asks again');
  // Leaving the composer closes it.
  c.input.blur();
  assert.equal(c.list(), null);
  // A single chat: no list at all.
  const single = composer({ members: null });
  single.type('@');
  assert.equal(single.list(), null);
  // An input method still composing: nothing changes until it ends.
  const ime = composer();
  ime.input.dispatch('compositionstart');
  ime.s.text = '@k'; ime.s.caret = 2;
  ime.input.dispatch('input', { isComposing: true });
  assert.equal(ime.list(), null);
  ime.s.text = '@快'; ime.s.caret = 2;
  ime.input.dispatch('compositionend');
  assert.deepEqual(ime.options(), ['快手']);
  const keyDuring = ime.input.key('Enter', { isComposing: true });
  assert.equal(keyDuring.defaultPrevented, false, 'Enter that commits a composition is the input method\'s');
  ime.M.close();
  assert.equal(ime.list(), null);
});

// ---------------------------------------------------------------- wiring
test('the shell wires 资料页与群: scripts before app.js, styles before the live reply\'s, the drawer\'s tabs from the rules, 群聊, the group row menu, the @ list, and the retired tabs\' code is gone', () => {
  const html = read('client/index.html'), app = read('client/public/app.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('quick-create-rules.js') < at('profile-rules.js') && at('profile-rules.js') < at('profile.js') && at('profile.js') < at('app.js'));
  assert.ok(at('mention-rules.js') < at('mention.js') && at('mention.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(styles.slice(-3), ['profile.css', 'mention.css', 'chat-live.css']);
  assert.ok(scripts.indexOf('chat-history.js') < scripts.indexOf('profile-rules.js'), 'after the earlier rounds\' scripts');
  // The drawer: tabs from the rules; 资料 / 成员 kept across repaints; 定时 its own page.
  assert.match(app, /for \(const pair of profileRules\.tabs\(panelKind\(\)\)\)/);
  assert.match(app, /else body\.append\(profile\.catPage\(state\.sel, data\)\);/);
  assert.match(app, /body\.append\(tab === "files" \? workspace\.filesView\(state\.sel\) : profile\.groupPage\(state\.sel, panelGroup\(\)\)\);/);
  assert.match(app, /if \(page && profile\.current\(page, state\.sel\) && tab === profileRules\.home\(panelKind\(\)\)\)/);
  // 任务 (the work row, the status line's task links) opens 高级.
  assert.match(app, /row\.addEventListener\("click", \(\) => \{ openAdvanced\(\);/);
  assert.match(app, /if \(profileRules\.opensAdvanced\(tab\) && state\.sel\) \{ state\.tab = profileRules\.home\(panelKind\(\)\); profile\.reveal\(state\.sel\); \}/);
  // The retired 轨迹 / 上下文 tabs, the context bar and the steer control are gone.
  assert.doesNotMatch(app, /function traceView|function contextView|function paintContextBar|function ctxPicker|traceOpen|ctxMenu|"轨迹"|"上下文"|task-guide|steer-editor|追加指示|function detailsView|\bconst TABS\b/);
  assert.doesNotMatch(html, /id="ctxbar"/);
  // 删除猫猫 in everyday words; 群组 → 群聊 in the sidebar.
  assert.doesNotMatch(app, /原生成员配置/);
  assert.match(app, /openModal\("删除猫猫", \[/);
  assert.match(app, /roster\.append\(sectionLabel\("群聊"\)\)/);
  // A group row opens its own menu the way a cat row does.
  assert.match(app, /btn\.dataset\.groupMenu = "true";/);
  assert.match(app, /const sidebarBot = \(target\) => target\.closest\?\.\("\[data-bot-menu\], \[data-group-menu\]"\);/);
  assert.match(app, /const menu = profile\.groupMenu\(g\);/);
  // Review fixes: the drawer follows each poll's record, takes the answered one at once, and finds a row again by the group's id.
  assert.match(app, /if \(state\.sel && state\.sel\.type === "group" && panel\.classList\.contains\("open"\)\) paintPanel\(\);/);
  assert.match(app, /groupChanged: async \(id, record\) => \{\n\s+if \(record\) state\.groups = state\.groups\.map\(/);
  assert.match(app, /groupRow: \(id\) => \[\.\.\.document\.querySelectorAll\("#roster \.item\[data-group\]"\)\]\.find\(\(n\) => n\.dataset\.group === id\)/);
  assert.match(app, /selected: \(\) => state\.sel,\n\s+groups: \(\) => state\.groups,/);
  assert.doesNotMatch(read('client/public/profile.js'), /membersBody|body: \{ members/);
  // The @ list: members only in a group; the edit goes through the composer's own history.
  assert.match(app, /if \(!state\.sel \|\| state\.sel\.type !== "group" \|\| state\.peer\) return null;/);
  assert.match(app, /apply: composerEdit,/);
  assert.match(app, /function composerEdit\(text, caret\) \{[\s\S]*?composerRecord\(before, text, caret\);/);
  assert.match(app, /mention\.close\(\);/);
  // Requests: only the documented group and conversation routes.
  const profile = read('client/public/profile.js');
  assert.deepEqual([...new Set([...profile.matchAll(/"(\/xbot-api\/[^"]*)"/g)].map(m => m[1]))].sort(), ['/xbot-api/groups/']);
  assert.match(app, /newConversation: \(sel, opener\) => chatHistory\.newConversation\(sel, opener\),/);
  assert.match(read('client/public/chat-history.js'), /init, select, merge, top, starters, load, sync: syncMenu, openMenu, closeMenu, newConversation,/);
  assert.doesNotMatch(profile + read('client/public/mention.js'), /innerHTML\s*=(?!\s*body;)|localStorage|sessionStorage|\/stop"|\/cancel"/);
  // The words shown never name a Bot, an Agent, a session or a thread.
  for (const file of ['client/public/profile.js', 'client/public/profile-rules.js', 'client/public/mention.js', 'client/public/mention-rules.js']) {
    const words = [...read(file).matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)].map(m => m[1]);
    assert.ok(words.length > 0, file);
    for (const w of words) assert.doesNotMatch(w, /Bot|Agent|session|thread|原生|会话|线程/i, w);
  }
  // Only existing tokens: no new colour literal (the cat's own colour comes from the server).
  for (const file of ['client/public/profile.css', 'client/public/mention.css'])
    assert.doesNotMatch(read(file).replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, file);
});

test('the app\'s own mark: the cat-eared speech bubble replaces the upstream X in the icons, 关于 and the sign-in card', () => {
  const html = read('client/index.html'), svg = read('client/public/favicon.svg');
  assert.match(html, /<div class="aboutlogo"><img class="mark" src="\/brand-mark-256\.png" alt="" width="48" height="48">/);
  assert.doesNotMatch(html, /<div class="mark">X<\/div>|M16 20 L40 50 L16 80/);
  // A small vector of the same idea: coffee-brown rounded square, cream bubble with ears and a tail, closed eyes and a nose; lighter square in a dark scheme.
  assert.match(svg, /<rect class="t" width="64" height="64" rx="15"\/>/);
  assert.match(svg, /@media \(prefers-color-scheme:dark\)/);
  assert.match(svg, /<ellipse /);
  assert.doesNotMatch(svg, /M26\.96 29\.52 L41\.36 50/, 'not the upstream X');
  const manifest = JSON.parse(read('docs/xbot-frontend-manifest.json'));
  for (const file of ['favicon.svg', 'favicon-32.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    const entry = manifest.files.find((f: Any) => f.file === file);
    assert.ok(entry && entry.unchanged === false && entry.sha256 !== entry.sourceSha256, file + ' is recorded as replaced');
  }
  assert.ok(manifest.extensions.some((f: Any) => f.target === 'client/public/brand-mark-256.png'));
});
