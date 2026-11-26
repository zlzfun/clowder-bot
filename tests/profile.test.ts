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
// What is on screen: the same, without what is there for a screen reader only (.visually-hidden; item 46).
const seenText = (root: El): string => root.hidden || has(root, 'visually-hidden') ? '' : root.kids.map(k => (k instanceof El ? seenText(k) : k.textContent)).join('');
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

test('item 46: no note under 新对话 in 资料 — what happens to this conversation is said once, in the 新对话 dialog, where the owner decides', () => {
  const R = load(RULES).window.ClowderProfileRules;
  assert.equal(R.NEW_CHAT_NOTE, undefined);
  assert.equal(R.newChatError, undefined, 'refusals are said by the shared dialog (chat-history.js)');
  assert.match(read('client/public/chat-history.js'), /node\("p", "ch-note", "[^"]*「历史对话」/, 'the dialog says where the conversation goes');
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
  // Agent alone hides nothing since 2026-11-12 (docs/xbot-frontend.md item 42); the engine's words still do.
  assert.equal(R.groupError(fail(400, '这只猫猫的 Agent 还没有登录'), 'members').text, '这只猫猫的 Agent 还没有登录');
  for (const said of ['这个 Bot 不在群里', '原生会话已变化', '这个 thread 已删除', '模型不可用']) assert.equal(R.groupError(fail(400, said), 'members').text, '没能改好，请稍后再试。', said);
});

test('item 46: no sentence on 成员 about how to talk in a group (the @ list shows it where the owner writes); a group name that may be left empty is said to a screen reader in 新建\'s words', () => {
  const R = load(RULES).window.ClowderProfileRules;
  assert.equal(R.HOW_TO_TALK, undefined);
  assert.equal(R.nameSaid(), '可不填，不填就用成员的名字');
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
    catFaceSig: (name: string) => 'face:' + name + (s.faceRev || ''),
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
    editProfile: (data: Any, opener: El) => { log.push('edit:' + (data ? data.name : '(loaded)')); s.editOpener = opener; },
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
    // 这台电脑 (item 52): the install command's 复制, and whether the drawer is open.
    copy: async (text: string) => { log.push('copied:' + text); return !s.copyFails; },
    open: () => s.open !== false,
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
  // Item 46: on screen it is the cat's own words, first under the tabs; 职责 names the section for a screen reader.
  assert.equal(seenText(one(page, 'pf-duty')), '帮你查资料、写东西。');
  d.P.catPage(TUANZI, { ...PROFILE, persona: '' });
  assert.match(visibleText(one(page, 'pf-duty')), /还没写它负责什么。编辑资料/);
  button(page, '编辑资料').click();
  assert.deepEqual(d.log, ['edit:快手']);
  d.P.catPage(TUANZI, PROFILE);
  // The order a messenger's profile reads in (item 52: 可以用这台电脑, its note and its failure line under 置顶).
  const order = page.children.map(n => n.className);
  assert.deepEqual(order, ['psec pf-duty', 'pf-row pf-pin', 'pf-line', 'pf-row pf-computer', 'pf-cnote', 'pf-line', 'psec pf-convs', 'pf-rule', 'task-details pf-adv', 'pf-foot']);
  // This server cannot say what the computer is (the read failed): nothing about it is shown.
  assert.equal(shown(one(page, 'pf-computer')), false);
  // Item 46: 新对话 and 历史对话 name themselves (对话 is for a screen reader); what 新对话 does is said in its dialog.
  assert.equal(seenText(one(page, 'pf-convs')), '新对话');
  assert.equal(named(page, 'pf-note').length, 0);
  // The pin row says nothing while idle.
  assert.equal(seenText(one(page, 'pf-pin')), '置顶');
  assert.equal(one(page, 'pf-row-hint').hidden, true);
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
  assert.deepEqual(named(body, 'pf-act').map(n => visibleText(n)), ['导出对话', '复制名字', '在运行面板查看']);
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
  assert.equal(one(page, 'pf-row-hint').hidden, false, 'what is being saved is said');
  sw.click();
  assert.deepEqual(d.log, ['pin:快手:true'], 'one request at a time');
  open();
  await settle();
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(sw.getAttribute('aria-busy'), null);
  assert.equal(sw.getAttribute('aria-disabled'), null);
  // Item 46: idle again, the line is empty and hidden (no 「放在列表最上面」).
  assert.equal(one(page, 'pf-row-hint').textContent, '');
  assert.equal(one(page, 'pf-row-hint').hidden, true);
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

test('a save of 置顶 belongs to its cat, not to the page: open another cat and come back while it is on its way, and the page shown then is busy, sends nothing more, and says how it ended (review item 4)', async () => {
  const OTHER = { type: 'bot', id: '墨点' };
  const d = drawer();
  d.s.sel = TUANZI;
  let page = d.show(d.P.catPage(TUANZI, PROFILE));
  let pinOpen!: () => void;
  d.s.pinGate = new Promise<void>((r) => { pinOpen = r; });
  d.s.pinFails = true;
  named(page, 'pf-switch')[0]!.click();
  // Another cat, then back: a new page for 快手, still saving.
  const other = d.show(d.P.catPage(OTHER, { name: '墨点', persona: 'x' }));
  assert.equal(named(other, 'pf-switch')[0]!.getAttribute('aria-busy'), null, 'the other cat is not the one saving');
  page = d.show(d.P.catPage(TUANZI, PROFILE));
  const pin = named(page, 'pf-switch')[0]!;
  assert.equal(pin.getAttribute('aria-busy'), 'true');
  assert.equal(named(page, 'pf-row-hint')[0]!.textContent, '正在置顶…');
  pin.click();
  assert.deepEqual(d.log.filter((x: string) => x.startsWith('pin:')), ['pin:快手:true'], 'one request at a time');
  pinOpen();
  await settle();
  assert.equal(pin.getAttribute('aria-busy'), null);
  assert.equal(visibleText(named(page, 'pf-line')[0]!), '没能置顶：服务出了点问题，请稍后再试。');
  // An answer that lands while another cat is shown is the cat's: shown when 快手 is shown again.
  d.s.pinFails = false;
  d.s.pinGate = new Promise<void>((r) => { pinOpen = r; });
  pin.click();
  d.show(d.P.catPage(OTHER, { name: '墨点', persona: 'x' }));
  pinOpen();
  await settle();
  d.s.pinGate = null;
  page = d.show(d.P.catPage(TUANZI, PROFILE));
  const again = named(page, 'pf-switch')[0]!;
  assert.equal(again.getAttribute('aria-checked'), 'true', 'what the list says now');
  assert.equal(again.getAttribute('aria-busy'), null);
  assert.equal(named(page, 'pf-row-hint')[0]!.hidden, true, 'nothing being saved: nothing said');
  assert.equal(shown(named(page, 'pf-line')[0]!), false, 'the earlier failure was cleared by the new request');
  assert.deepEqual(d.log.filter((x: string) => x.startsWith('pin:')), ['pin:快手:true', 'pin:快手:true']);
});

// Item 39: talking briefly is how every cat talks here (an engine default the
// owner's own words override; docs/xbot-api.md 「说话简短（默认，没有开关）」),
// so 资料 has nothing for it: no switch, no line, no hint.
test('说话简短 is a default, not a setting: 资料 has no control, line or hint for it whatever the profile says (an older server may still send `concise`), and neither does a group', () => {
  const d = drawer();
  d.s.sel = TUANZI;
  assert.equal(d.R.BRIEF, undefined, 'no words kept for a switch');
  assert.equal(d.R.briefShown, undefined, 'no rule kept for a switch');
  const page = d.show(d.P.catPage(TUANZI, { name: '快手' }));
  for (const data of [PROFILE, { ...PROFILE, concise: true }, { ...PROFILE, concise: false }, { ...PROFILE, concise: 'yes' }, { ...PROFILE, concise: null }] as Any[]) {
    assert.equal(d.P.catPage(TUANZI, data), page, 'the same page, drawn again');
    // The page as it was before item 38: nothing added for it, and nothing left behind
    // (item 52's 可以用这台电脑 is the only row added since, with its own lines).
    assert.deepEqual(page.children.map(n => n.className), ['psec pf-duty', 'pf-row pf-pin', 'pf-line', 'pf-row pf-computer', 'pf-cnote', 'pf-line', 'psec pf-convs', 'pf-rule', 'task-details pf-adv', 'pf-foot'], JSON.stringify(data.concise));
    const switches = all(page).filter(n => n.getAttribute('role') === 'switch');
    assert.deepEqual(switches, named(page, 'pf-switch'), 'the rows\' switches only');
    assert.deepEqual(switches.map(n => d.doc.getElementById(n.getAttribute('aria-labelledby')!)?.textContent), ['置顶', '可以用这台电脑'], 'and they are 置顶 and 可以用这台电脑');
    assert.deepEqual(named(page, 'pf-row').map(n => n.className), ['pf-row pf-pin', 'pf-row pf-computer']);
    assert.equal(named(page, 'pf-line').length, 3, '置顶\'s status line, 这台电脑\'s note and its failure line');
    assert.equal(named(page, 'pf-line').some(shown), false);
    // Not shown and not even hidden in the tree; every aria reference points at something there.
    assert.doesNotMatch(page.textContent, /说话简短|简短|先说结论|几句话说完|在新对话里生效|没能保存/);
    for (const n of all(page)) {
      assert.doesNotMatch(n.className + ' ' + n.id, /brief/i);
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const ref = n.getAttribute(attr);
        if (ref) assert.ok(d.doc.getElementById(ref), attr + ' ' + ref);
      }
    }
  }
  const g = d.show(d.P.groupPage({ type: 'group', id: 'g1' }, d.group()));
  assert.equal(all(g).filter(n => n.getAttribute('role') === 'switch').length, 0);
  assert.doesNotMatch(g.textContent, /说话简短|简短/);
});

test('using 资料 never asks to change how a cat talks: whatever is pressed on it, nothing carries `concise` and nothing is sent to the cat\'s profile at all', async () => {
  const d = drawer();
  d.s.sel = TUANZI;
  // An older server that still says `concise`, with and without a 职责.
  const page = d.show(d.P.catPage(TUANZI, { ...PROFILE, concise: false }));
  const fold = one(page, 'pf-adv');
  fold.open = true;
  fold.dispatch('toggle');
  const press = () => {
    for (const n of all(page)) if (n.tagName === 'BUTTON' && shown(n)) n.click();
    for (const n of named(page, 'pf-row')) n.click();
    for (const n of named(page, 'pf-row-title')) n.click();
  };
  press();
  await settle();
  d.P.catPage(TUANZI, { ...PROFILE, persona: '', concise: true });
  press();
  await settle();
  // Everything did what it does, through the shell's own hooks…
  for (const done of ['pin:快手:true', 'new:bot:快手', 'edit:快手', 'export:快手', 'copy:快手', 'delete:快手']) assert.ok(d.log.includes(done), done);
  // …and the page itself sent nothing: no PATCH {concise}, no request to the cat's profile of any kind.
  // (Item 52: what it does ask is whether the cat may use this computer, a read, each time the profile was read.)
  assert.deepEqual(d.calls.filter((c: Call) => c.body && typeof c.body === 'object' && 'concise' in c.body), []);
  assert.deepEqual(d.calls.filter((c: Call) => !(c.method === 'GET' && c.path === '/xbot-api/bots/' + encodeURIComponent('快手') + '/computer')), []);
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
  assert.equal(d.calls.filter((c: Call) => !c.path.endsWith('/computer')).length, 0, 'the request, its idle check and its refusals belong to chat-history.js');
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
  // Item 46: the tab is 成员 and the list shows who: the heading and its count are for a screen reader; 添加猫猫 stays.
  assert.equal(one(page, 'pf-sec-head').firstChild!.textContent, '成员 · 3');
  assert.ok(one(page, 'pf-sec-head').firstChild!.classList.contains('visually-hidden'));
  assert.equal(seenText(one(page, 'pf-sec-head')), '添加猫猫');
  assert.deepEqual(named(page, 'pf-member-name').map(n => n.textContent), ['快手', '墨点', '年糕']);
  // Review r15: each printed name keeps its full name, shown on hover only while it is cut short.
  assert.deepEqual(named(page, 'pf-member-name').map(n => [n.dataset.tip, n.dataset.tipOnly]), [['快手', 'clipped'], ['墨点', 'clipped'], ['年糕', 'clipped']]);
  assert.deepEqual(named(page, 'pf-member-face').map(n => n.firstChild!.dataset.cat), ['快手', '墨点', '年糕']);
  assert.equal(named(page, 'pf-hint').length, 0, 'no sentence on how to talk in a group');
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
  // Item 46: the title and the chips say what to do (the legend is for a screen reader); the hint says nothing while choosing.
  assert.ok(one(layer, 'qc-members-set').firstChild!.classList.contains('visually-hidden'));
  assert.equal(one(layer, 'qc-hint').textContent, '');
  const boxes = all(layer).filter(n => n.type === 'checkbox');
  for (const b of [boxes[1], boxes[0]]) { b.checked = true; b.dispatch('change'); }
  assert.equal(one(layer, 'qc-hint').textContent, '', 'a chip shows it is picked');
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
  // Item 46: Enter saves, Esc goes back — the field's description, for a screen reader; nothing printed under the name.
  const sub = one(head, 'pf-head-sub');
  assert.equal(input.getAttribute('aria-describedby'), sub.id);
  assert.equal(visibleText(sub), '回车保存，Esc 取消');
  assert.equal(seenText(sub), '');
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
  one(h3, 'pf-name').click();
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

test('item 51: a cat\'s portrait is the head\'s 编辑资料 — a real button named for a screen reader, the face as it is with a pencil for the cue, opening the chat\'s loaded 资料 with itself as the opener; one node for the chat, so a new face keeps it and its focus', () => {
  const d = drawer();
  const head = d.show(d.P.catHead(TUANZI, PROFILE));
  const edit = one(head, 'pf-edit');
  assert.equal(edit.tagName, 'BUTTON');
  assert.equal(edit.type, 'button');
  assert.equal(edit.getAttribute('aria-label'), '编辑资料');
  assert.notEqual(edit.getAttribute('tabindex'), '-1', 'reachable by keyboard');
  assert.equal(visibleText(edit), '', 'no words: the face and, for the cue, a pencil');
  assert.equal(one(edit, 'pf-portrait').firstChild!.dataset.cat, '快手', 'the face, as before');
  const mark = one(edit, 'pf-edit-mark');
  assert.equal(mark.getAttribute('aria-hidden'), 'true');
  assert.equal(mark.firstChild!.dataset.icon, 'pencil');
  edit.click();
  assert.deepEqual(d.log, ['edit:(loaded)'], 'the chat\'s loaded 资料, as the corner\'s pencil opened (never a profile with only a name)');
  assert.equal(d.s.editOpener, edit, 'focus comes back to it');
  // The face changes while the head is shown (a new picture, catFaceSig): drawn inside the same button.
  edit.focus();
  const face = one(edit, 'pf-portrait').firstChild;
  d.s.faceRev = '-2';
  assert.equal(d.P.catHead(TUANZI, PROFILE), head);
  assert.equal(one(head, 'pf-edit'), edit, 'the same button');
  assert.notEqual(one(edit, 'pf-portrait').firstChild, face, 'the new face is drawn');
  assert.equal(one(edit, 'pf-edit-mark'), mark, 'the cue stays');
  assert.equal(d.doc.activeElement, edit, 'focus stays on it');
  // Another cat: its own button.
  const other = d.show(d.P.catHead({ type: 'bot', id: '墨点' }, { name: '墨点' }));
  assert.notEqual(one(other, 'pf-edit'), edit);
});

test('item 51: a group\'s portrait stays a picture (its members\' faces, nothing to edit); its name is the head\'s only button, 改群名 in place', () => {
  const d = drawer();
  const head = d.show(d.P.groupHead(GROUP, d.group()));
  assert.equal(named(head, 'pf-edit').length, 0);
  assert.equal(one(head, 'pf-portrait').tagName, 'SPAN');
  assert.deepEqual(all(head).filter((n) => n.tagName === 'BUTTON').map((n) => n.getAttribute('aria-label')), ['改群名：读书会']);
  assert.equal(one(head, 'pf-name').dataset.tip, '改群名');
  assert.equal(d.P.renameHere, undefined, 'the corner\'s 改群名 is gone, and its entry with it');
  one(head, 'pf-name').click();
  assert.equal(named(head, 'pf-name-input').length, 1);
});

test('item 51: the cue in profile.css — a pencil on the primary comes up at the portrait\'s corner under the pointer or keyboard focus, nothing over the face, stands quietly where there is no hover; the group name\'s pencil stands there too; existing tokens and motion only', () => {
  const css = read('client/public/profile.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.pf-edit:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 3px; \}/);
  assert.match(css, /\.pf-edit-mark \{[^}]*background: var\(--x-primary\); color: var\(--x-on-primary\); box-shadow: 0 0 0 2px var\(--panel\);[^}]*opacity: 0; transform: scale\(var\(--pop-scale-start\)\);[^}]*transition: opacity var\(--dur-pop-close\) ease-out, transform var\(--dur-pop\) var\(--ease-spring\);[^}]*pointer-events: none;/);
  assert.match(css, /\.pf-edit:focus-visible \.pf-edit-mark \{ opacity: 1; transform: none; \}/);
  assert.match(css, /@media \(hover: hover\) \{\n\s+\.pf-edit:hover \.pf-edit-mark \{ opacity: 1; transform: none; \}\n\}/, 'under the pointer only where there is one');
  assert.match(css, /@media \(hover: none\) \{\n\s+\.pf-edit \.pf-edit-mark \{ opacity: 1; transform: none; width: 18px; height: 18px;[^}]*background: var\(--x-fill-2\); color: var\(--x-text-2\); \}/, 'standing, smaller and quiet without hover');
  assert.match(css, /\.pf-edit:active \.pf-portrait \{ transform: scale\(var\(--press-scale\)\); \}/);
  assert.match(css, /@media \(hover: none\) \{ \.pf-name \.icon \{ opacity: 1; \} \}/, 'the group name\'s pencil stands where there is no hover');
  assert.doesNotMatch(css, /\.pf-edit[^{]*\{[^}]*(?:filter|backdrop-filter)\s*:/, 'no overlay or dimming of the face');
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
  // The consequences once each, before anything is sent (item 46 rewrote the sentence, not what it says).
  assert.match(visibleText(layer), /删除「晨读」？它会从列表里消失，不能再打开。聊天记录和猫猫都还在。/);
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

// ---------------------------------------------------------------- 这台电脑 (item 52)
// GET/PUT /xbot-api/bots/:name/computer answered the way server/native/computer.ts
// does: turning on while a macOS grant is missing switches nothing and answers
// with the grants still needed; turning on with no driver is refused; turning
// off always works. Every answer is a new object.
type View = { supported: boolean; installed: boolean; on: boolean; permissions: string; missing?: string[] };
const READY: View = { supported: true, installed: true, on: false, permissions: 'granted' };
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
function computerDrawer(start: Partial<View> = {}) {
  const srv: Any = { view: { ...READY, ...start }, getGate: null, putGate: null, getFails: null, putFails: null };
  const path = (name = '快手') => '/xbot-api/bots/' + encodeURIComponent(name) + '/computer';
  const d = drawer({
    route: async (p, method, body) => {
      if (!p.endsWith('/computer')) return undefined;
      if (method === 'GET') { if (srv.getGate) await srv.getGate; if (srv.getFails) throw srv.getFails; return srv.view; }
      if (srv.putGate) await srv.putGate;
      if (srv.putFails) { const e = srv.putFails; srv.putFails = null; throw e; }
      if (srv.putAnswer) return srv.putAnswer;
      if (body.enabled) {
        if (!srv.view.installed) throw Object.assign(fail(422, '还没有装上操作电脑要用的驱动'), { code: 'computer_absent' });
        if (srv.view.permissions !== 'needed') srv.view.on = true;
      } else srv.view.on = false;
      return srv.view;
    },
  });
  const asked = (method: string, name = '快手') => d.calls.filter((c: Call) => c.path === path(name) && c.method === method);
  return { ...d, srv, page: (data: Any = PROFILE) => d.show(d.P.catPage(TUANZI, data)), gets: (name?: string) => asked('GET', name).length, puts: (name?: string) => asked('PUT', name).map((c: Call) => c.body.enabled) };
}
// The row as it reads: on screen (seenText), the switch's state, and the lines under it.
function computerRow(page: El) {
  const row = one(page, 'pf-computer'), sw = one(row, 'pf-switch'), note = one(page, 'pf-cnote'), error = note.nextSibling as El;
  return {
    shown: shown(row), row, sw, note, error, stop: one(note, 'pf-cstop'), chip: one(note, 'qc-cmd'),
    on: sw.getAttribute('aria-checked'), busy: sw.getAttribute('aria-busy'), locked: sw.getAttribute('aria-disabled'),
    hint: seenText(one(row, 'pf-row-hint')), said: seenText(note), failed: seenText(error),
  };
}

test('这台电脑 rules: the view only in its own shape, each state\'s words, both names macOS gives the grant, the consent in one sentence, a refusal in the server\'s words', () => {
  const R = load(RULES).window.ClowderProfileRules;
  for (const bad of [null, 'yes', {}, { supported: true, installed: true }, { supported: 'true', installed: true, on: false }]) assert.equal(R.computerView(bad), null, JSON.stringify(bad));
  assert.deepEqual(plain(R.computerView({ supported: true, installed: true, on: false, permissions: 'needed', missing: ['screen_recording', 'microphone'] })),
    { supported: true, installed: true, on: false, permissions: 'needed', missing: ['screen_recording'] });
  assert.deepEqual(plain(R.computerView({ ...READY, permissions: 'needed' })).missing, ['accessibility', 'screen_recording'], 'missing without names: both');
  assert.equal(R.computerView({ ...READY, permissions: 'maybe' }).permissions, 'unknown');
  assert.deepEqual(plain(R.computerView({ ...READY, missing: ['accessibility'] })).missing, [], 'nothing is missing unless the grants are needed');
  const row = (view: Partial<View> | null, flow: Any = {}) => plain(R.computerRow(view && R.computerView({ ...READY, ...view }), flow));
  assert.deepEqual(row(null), { shown: false });
  assert.deepEqual(row({ supported: false }), { shown: false });
  assert.deepEqual(row({ supported: false, on: true }), { shown: false }, 'no driver for this system: nothing at all');
  const quiet = { shown: true, busy: false, can: true, hint: '', note: null, error: '' };
  assert.deepEqual(row({}), { ...quiet, on: false });
  assert.deepEqual(row({ on: true }), { ...quiet, on: true });
  assert.deepEqual(row({ on: true, permissions: 'unknown' }), { ...quiet, on: true }, 'the driver not running is normal');
  assert.deepEqual(row({ installed: false, permissions: 'unknown' }), { ...quiet, on: false, can: false, note: { text: '还没装上操作电脑用的驱动，在 clowder-bot 目录里运行：', command: 'npm run computer:install' } });
  assert.deepEqual(row({ installed: false, on: true, permissions: 'unknown' }), { ...quiet, on: true, note: { text: '现在还用不了：找不到操作电脑用的驱动，在 clowder-bot 目录里运行：', command: 'npm run computer:install' } }, 'a stale on can still be switched off');
  assert.deepEqual(row({ on: true, permissions: 'needed', missing: ['screen_recording'] }).note, { text: '现在还用不了：到系统设置 › 隐私与安全性，在「屏幕录制」里打开 CuaDriver。' });
  // Waiting for the grants: not on, busy, says where, with 不等了.
  assert.deepEqual(row({ permissions: 'needed', missing: ['accessibility', 'screen_recording'] }, { wait: { missing: ['accessibility', 'screen_recording'] } }),
    { shown: true, on: false, busy: true, can: false, hint: '等你在系统设置里打开…', error: '',
      note: { text: '到系统设置 › 隐私与安全性，在「辅助功能」（或「设备控制与数据访问」）和「屏幕录制」里打开 CuaDriver。', stop: true } });
  assert.deepEqual(row({}, { busy: 'on' }), { ...quiet, on: false, busy: true, can: false, hint: '正在打开…' });
  assert.deepEqual(row({ on: true }, { busy: 'off' }), { ...quiet, on: true, busy: true, can: false, hint: '正在关掉…' });
  assert.equal(row({}, { said: { text: '没能打开，请再试一次', code: '' } }).error, '没能打开，请再试一次');
  assert.equal(row({ installed: false }, { said: { text: '还没有装上操作电脑要用的驱动', code: 'computer_absent' } }).error, '', 'the note already says it');
  // Accessibility by both of its names, so either system's list can be found.
  assert.equal(R.grantPlace(['accessibility']), '到系统设置 › 隐私与安全性，在「辅助功能」（或「设备控制与数据访问」）里打开 CuaDriver');
  const consent = R.computerConsent('快手');
  assert.deepEqual(plain(consent), { title: '让「快手」用这台电脑？', text: '它能看到并操作这台电脑上的应用，看到的画面会发给它用的模型。' });
  assert.equal(consent.text.match(/[。？！]/g).length, 1, 'one sentence');
  assert.equal(R.COMPUTER.TITLE, '可以用这台电脑');
  // The server's own sentence; else what did not happen; a lost connection as the app says it.
  const half = '没能把电脑接上，而且没能撤回干净：请到每只猫的资料里确认「电脑」是关着的';
  assert.equal(R.computerError(Object.assign(fail(502, half), { code: 'computer_half_registered' }), true), half);
  assert.equal(R.computerError(fail(503, '电脑驱动没有启动起来，请再试一次'), true), '电脑驱动没有启动起来，请再试一次');
  assert.equal(R.computerError(fail(400, 'Invalid input: expected boolean'), true), '没能打开，请再试一次');
  assert.equal(R.computerError(fail(502), false), '没能关掉，请再试一次');
  assert.equal(R.computerError(new Error('连不上 clowder-bot'), false), '连不上 clowder-bot');
  // It is the owner's own machine.
  const rules = read('client/public/profile-rules.js') + read('client/public/profile.js');
  assert.doesNotMatch(rules, /猫的电脑|Bot 的电脑|云电脑/);
});

test('这台电脑 in 资料: nothing until the server answers, nothing where there is no driver for this system or the read failed; installed it says nothing more off or on; asked again only when the profile was read again', async () => {
  const c = computerDrawer();
  const first = gate();
  c.srv.getGate = first.p;
  // Before the profile is read nothing is asked; then once.
  const page = c.page({ name: '快手' });
  assert.equal(c.gets(), 0);
  c.page();
  assert.equal(c.gets(), 1);
  assert.equal(computerRow(page).shown, false, 'no state drawn while the answer is on its way');
  first.open();
  c.srv.getGate = null;
  await settle();
  let r = computerRow(page);
  assert.equal(r.shown, true);
  assert.deepEqual([r.on, r.busy, r.locked, r.hint, r.said, r.failed], ['false', null, null, '', '', '']);
  assert.equal(seenText(r.row), '可以用这台电脑', 'the row says its name and nothing else');
  assert.equal(r.sw.getAttribute('role'), 'switch');
  assert.equal(c.doc.getElementById(r.sw.getAttribute('aria-labelledby'))?.textContent, '可以用这台电脑');
  assert.equal(r.sw.getAttribute('aria-describedby'), null);
  // The drawer's routine repaints ask nothing; a profile read again asks again.
  c.page(); c.page();
  assert.equal(c.gets(), 1);
  c.srv.view.on = true;
  c.page({ ...PROFILE });
  await settle();
  assert.equal(c.gets(), 2);
  r = computerRow(page);
  assert.deepEqual([r.on, r.said, r.failed], ['true', '', '']);
  // A group has none.
  const g = c.show(c.P.groupPage(GROUP, c.group()));
  assert.equal(named(g, 'pf-computer').length, 0);
  assert.equal(c.gets(), 2);
  // No driver for this system, whatever the registry says; a read that fails; an answer that is not a view.
  for (const [what, setup] of [['unsupported', (x: Any) => { x.srv.view = { supported: false, installed: false, on: false, permissions: 'unknown' }; }],
    ['unsupported, on', (x: Any) => { x.srv.view = { supported: false, installed: false, on: true, permissions: 'unknown' }; }],
    ['read failed', (x: Any) => { x.srv.getFails = fail(500, '服务出了点问题，请稍后再试。'); }],
    ['not a view', (x: Any) => { x.srv.view = { status: 'ok' }; }]] as Array<[string, (x: Any) => void]>) {
    const x = computerDrawer();
    setup(x);
    const p = x.page();
    await settle();
    assert.equal(x.gets(), 1, what);
    assert.equal(shown(one(p, 'pf-computer')), false, what);
    assert.equal(shown(one(p, 'pf-cnote')), false, what);
    assert.doesNotMatch(seenText(p), /电脑|驱动|CuaDriver/, what);
  }
});

test('这台电脑 without its driver: off, it cannot be switched on and says how to install it (the command copyable); on, the switch stays on with what is wrong, and turning it off still works', async () => {
  const c = computerDrawer({ installed: false, permissions: 'unknown' });
  const page = c.page();
  await settle();
  let r = computerRow(page);
  assert.deepEqual([r.shown, r.on, r.locked, r.busy], [true, 'false', 'true', null]);
  assert.ok(has(r.row, 'pf-locked'), 'the row is no target');
  assert.equal(r.said, '还没装上操作电脑用的驱动，在 clowder-bot 目录里运行：npm run computer:install复制');
  assert.equal(shown(r.stop), false);
  assert.equal(all(r.chip).find(n => n.tagName === 'CODE')?.textContent, 'npm run computer:install');
  assert.equal(r.sw.getAttribute('aria-describedby'), r.note.id, 'the switch is described by why');
  // Nothing turns it on: no dialog, no request.
  r.sw.click(); r.row.click();
  assert.equal(c.layer(), null);
  assert.deepEqual(c.puts(), []);
  // 复制 copies the command, and says whether it did.
  const copy = button(r.chip, '复制');
  assert.equal(copy.getAttribute('aria-label'), '复制 npm run computer:install');
  copy.click();
  await settle();
  assert.ok(c.log.includes('copied:npm run computer:install'));
  assert.equal(copy.textContent, '已复制');
  c.advance(1600);
  assert.equal(copy.textContent, '复制');
  c.s.copyFails = true;
  copy.click();
  await settle();
  assert.equal(copy.textContent, '没复制上');
  // A stale on (the driver was removed): on, with what is wrong; off works, without asking.
  const o = computerDrawer({ installed: false, on: true, permissions: 'unknown' });
  const p2 = o.page();
  await settle();
  r = computerRow(p2);
  assert.deepEqual([r.on, r.locked], ['true', null]);
  assert.equal(has(r.row, 'pf-locked'), false);
  assert.match(r.said, /^现在还用不了：找不到操作电脑用的驱动，在 clowder-bot 目录里运行：npm run computer:install/);
  r.sw.click();
  assert.equal(o.layer(), null, 'turning off asks nothing');
  await settle();
  assert.deepEqual(o.puts(), [false]);
  r = computerRow(p2);
  assert.deepEqual([r.on, r.locked], ['false', 'true']);
  assert.match(r.said, /^还没装上操作电脑用的驱动/);
  // On with a grant taken away: on, naming the grant and where it is; nothing is read again on its own.
  const g = computerDrawer({ on: true, permissions: 'needed', missing: ['screen_recording'] });
  const p3 = g.page();
  await settle();
  r = computerRow(p3);
  assert.deepEqual([r.on, r.locked, r.busy], ['true', null, null]);
  assert.equal(r.said, '现在还用不了：到系统设置 › 隐私与安全性，在「屏幕录制」里打开 CuaDriver。');
  assert.equal(shown(r.chip), false);
  g.advance(10_000);
  await settle();
  assert.equal(g.gets(), 1, 'no polling outside the wait');
});

test('这台电脑: turning on asks first, every time, in one sentence; nothing is sent until the owner agrees; the switch is on only once the server says so; off asks nothing', async () => {
  const c = computerDrawer();
  c.s.sel = TUANZI;
  const page = c.page();
  await settle();
  let r = computerRow(page);
  r.sw.focus();
  r.sw.click();
  let layer = c.layer()!;
  assert.ok(layer, 'a dialog');
  assert.equal(visibleText(one(layer, 'pf-card')), '让「快手」用这台电脑？它能看到并操作这台电脑上的应用，看到的画面会发给它用的模型。取消打开');
  assert.equal(c.doc.activeElement, button(layer, '取消'));
  assert.deepEqual(c.puts(), [], 'nothing sent while it asks');
  // 取消 (and Esc): nothing sent, focus back on the switch.
  button(layer, '取消').click();
  assert.equal(c.layer(), null);
  assert.equal(c.doc.activeElement, r.sw);
  r.row.click();
  one(c.layer()!, 'pf-card').key('Escape');
  assert.equal(c.layer(), null);
  assert.deepEqual(c.puts(), []);
  // 打开: the PUT goes; while it is on its way the switch is still off, busy and inert.
  const put = gate();
  c.srv.putGate = put.p;
  r.sw.click();
  layer = c.layer()!;
  button(layer, '打开').click();
  assert.equal(c.layer(), null, 'the row says what happens next');
  assert.deepEqual(c.puts(), [true]);
  r = computerRow(page);
  assert.deepEqual([r.on, r.busy, r.locked, r.hint], ['false', 'true', 'true', '正在打开…']);
  assert.equal(c.doc.activeElement, r.sw, 'focus stays on the switch');
  r.sw.click();
  assert.equal(c.layer(), null, 'nothing more while it is on its way');
  assert.deepEqual(c.puts(), [true]);
  put.open();
  c.srv.putGate = null;
  await settle();
  r = computerRow(page);
  assert.deepEqual([r.on, r.busy, r.locked, r.hint, r.said, r.failed], ['true', null, null, '', '', '']);
  // Off: no dialog.
  r.sw.click();
  assert.equal(c.layer(), null);
  await settle();
  assert.deepEqual(c.puts(), [true, false]);
  assert.equal(computerRow(page).on, 'false');
  // On again: it asks again (nothing remembers that it was seen).
  r.sw.click();
  assert.ok(c.layer(), 'asked every time');
  button(c.layer()!, '打开').click();
  await settle();
  assert.deepEqual(c.puts(), [true, false, true]);
  assert.equal(computerRow(page).on, 'true');
  // What the server answers is what shows, also when it is not what was asked for:
  // off with nothing to wait for stays off, with no wait and nothing invented.
  const late = computerDrawer();
  const lp = late.page();
  await settle();
  late.srv.putAnswer = { ...READY, on: false };
  computerRow(lp).sw.click();
  button(late.layer()!, '打开').click();
  await settle();
  r = computerRow(lp);
  assert.deepEqual([r.on, r.busy, r.hint, r.said], ['false', null, '', '']);
  late.advance(10_000); await settle();
  assert.equal(late.gets(), 1, 'no wait began');
});

test('这台电脑 while a macOS grant is missing: nothing is switched, the row names the grants for CuaDriver and where, reads again every 2 s while 资料 shows, sends the same request once they are granted and goes on by itself; 不等了 stops it with nothing sent', async () => {
  const c = computerDrawer({ permissions: 'needed', missing: ['accessibility', 'screen_recording'] });
  c.s.sel = TUANZI;
  const page = c.page();
  await settle();
  let r = computerRow(page);
  assert.deepEqual([r.on, r.said], ['false', ''], 'off, and the grants are not its business until it is turned on');
  r.sw.click();
  button(c.layer()!, '打开').click();
  await settle();
  assert.deepEqual(c.puts(), [true]);
  r = computerRow(page);
  assert.deepEqual([r.on, r.busy, r.locked, r.hint], ['false', 'true', 'true', '等你在系统设置里打开…'], 'not on while it waits');
  assert.equal(r.said, '到系统设置 › 隐私与安全性，在「辅助功能」（或「设备控制与数据访问」）和「屏幕录制」里打开 CuaDriver。不等了');
  assert.equal(shown(r.stop), true);
  assert.equal(shown(r.chip), false);
  const reads = c.gets();
  // Every 2 s a read; still missing: nothing sent.
  c.advance(1999); await settle();
  assert.equal(c.gets(), reads);
  c.advance(1); await settle();
  assert.equal(c.gets(), reads + 1);
  assert.deepEqual(c.puts(), [true]);
  // One granted, one to go: the line follows.
  c.srv.view.missing = ['screen_recording'];
  c.advance(2000); await settle();
  assert.equal(computerRow(page).said, '到系统设置 › 隐私与安全性，在「屏幕录制」里打开 CuaDriver。不等了');
  // Not showing (the drawer closed): no reads; shown again, it picks the wait up.
  c.s.open = false;
  c.advance(10_000); await settle();
  const closed = c.gets();
  c.advance(10_000); await settle();
  assert.equal(c.gets(), closed, 'no reads while 资料 is not on screen');
  c.s.open = true;
  c.page();
  c.advance(2000); await settle();
  assert.equal(c.gets(), closed + 1);
  // Both granted: the same PUT once more, and it is on.
  c.srv.view.permissions = 'granted';
  delete c.srv.view.missing;
  assert.equal(computerRow(page).on, 'false', 'not before the server says so');
  c.advance(2000); await settle();
  assert.deepEqual(c.puts(), [true, true]);
  r = computerRow(page);
  assert.deepEqual([r.on, r.busy, r.locked, r.hint, r.said], ['true', null, null, '', '']);
  const done = c.gets();
  c.advance(10_000); await settle();
  assert.equal(c.gets(), done, 'the wait is over: no more reads');

  // 不等了: the wait ends, nothing is sent, the switch stays off and takes the focus.
  const s = computerDrawer({ permissions: 'needed', missing: ['screen_recording'] });
  const p2 = s.page();
  await settle();
  computerRow(p2).sw.click();
  button(s.layer()!, '打开').click();
  await settle();
  r = computerRow(p2);
  r.stop.focus();
  r.stop.click();
  r = computerRow(p2);
  assert.deepEqual([r.on, r.busy, r.locked, r.hint, r.said], ['false', null, null, '', '']);
  assert.equal(s.doc.activeElement, r.sw);
  const after = s.gets();
  s.srv.view.permissions = 'granted';
  s.advance(10_000); await settle();
  assert.equal(s.gets(), after, 'no more reads');
  assert.deepEqual(s.puts(), [true], 'and nothing sent');
  // 不等了 pressed while the request sent for a grant is on its way: an answer that still waits starts no new wait.
  const t = computerDrawer({ permissions: 'needed', missing: ['screen_recording'] });
  const p3 = t.page();
  await settle();
  computerRow(p3).sw.click();
  button(t.layer()!, '打开').click();
  await settle();
  const put = gate();
  t.srv.putGate = put.p;
  t.srv.view.permissions = 'granted';
  t.advance(2000); await settle();
  assert.deepEqual(t.puts(), [true, true]);
  assert.equal(computerRow(p3).hint, '正在打开…');
  t.srv.view.permissions = 'needed';
  computerRow(p3).stop.click();
  put.open();
  await settle();
  r = computerRow(p3);
  assert.deepEqual([r.on, r.busy, r.said], ['false', null, '']);
  t.advance(10_000); await settle();
  assert.deepEqual(t.puts(), [true, true]);
});

test('这台电脑: a change that fails shows the server\'s sentence in full, and the row shows what a fresh read says is true', async () => {
  const half = '没能把电脑接上，而且没能撤回干净：请到每只猫的资料里确认「电脑」是关着的';
  const c = computerDrawer();
  const page = c.page();
  await settle();
  c.srv.putFails = Object.assign(fail(502, half), { code: 'computer_half_registered' });
  computerRow(page).sw.click();
  button(c.layer()!, '打开').click();
  await settle();
  let r = computerRow(page);
  assert.equal(c.gets(), 2, 'read again after the failure');
  assert.deepEqual([r.on, r.busy, r.locked], ['false', null, null]);
  assert.equal(r.failed, half);
  assert.equal(r.error.getAttribute('role'), 'alert');
  assert.equal(r.sw.getAttribute('aria-describedby'), r.error.id);
  // The read says it is on after all: that is what shows, with the sentence.
  c.srv.putFails = fail(503, '电脑驱动没有启动起来，请再试一次');
  r.sw.click();
  button(c.layer()!, '打开').click();
  c.srv.view.on = true;
  await settle();
  r = computerRow(page);
  assert.deepEqual([r.on, r.failed], ['true', '电脑驱动没有启动起来，请再试一次']);
  // The next change clears it; turning off can fail too.
  c.srv.putFails = fail(502, '没能关掉，请再试一次');
  r.sw.click();
  assert.equal(computerRow(page).failed, '', 'cleared by the new request');
  await settle();
  r = computerRow(page);
  assert.deepEqual([r.on, r.failed], ['true', '没能关掉，请再试一次']);
  // The driver went away since the page read it: the note says so with the command, not the sentence a second time.
  const a = computerDrawer();
  const p2 = a.page();
  await settle();
  a.srv.view = { supported: true, installed: false, on: false, permissions: 'unknown' };
  computerRow(p2).sw.click();
  button(a.layer()!, '打开').click();
  await settle();
  r = computerRow(p2);
  assert.deepEqual([r.on, r.locked, r.failed], ['false', 'true', '']);
  assert.match(r.said, /^还没装上操作电脑用的驱动/);
  // The read after a failure fails too: the last answer stays, with the failure.
  const n = computerDrawer();
  const p3 = n.page();
  await settle();
  n.srv.putFails = new Error('连不上 clowder-bot');
  n.srv.getFails = new Error('连不上 clowder-bot');
  computerRow(p3).sw.click();
  button(n.layer()!, '打开').click();
  await settle();
  r = computerRow(p3);
  assert.deepEqual([r.shown, r.on, r.failed], [true, 'false', '连不上 clowder-bot']);
  // The request carries the server's own words for a 5xx (app.js keeps them only when asked).
  assert.match(read('client/public/profile.js'), /H\.api\(computerPath\(name\), \{ method: "PUT", body: \{ enabled \}, serverError: true \}\)/);
});

test('这台电脑 belongs to its cat, not to the page: a change on its way or a wait goes on while another cat is shown, the page shown for the cat then draws it, and an earlier read never overwrites a later answer', async () => {
  const OTHER = { type: 'bot', id: '墨点' };
  const c = computerDrawer();
  let page = c.page();
  await settle();
  const put = gate();
  c.srv.putGate = put.p;
  computerRow(page).sw.click();
  button(c.layer()!, '打开').click();
  // Another cat, then back: a new page for 快手, still opening, sends nothing more.
  const other = c.show(c.P.catPage(OTHER, { name: '墨点', persona: 'x' }));
  await settle();
  assert.equal(computerRow(other).hint, '', 'the other cat is not the one opening');
  assert.equal(c.gets('墨点'), 1);
  page = c.page({ ...PROFILE });
  let r = computerRow(page);
  assert.deepEqual([r.shown, r.on, r.busy, r.hint], [true, 'false', 'true', '正在打开…']);
  assert.equal(c.gets(), 1, 'no read while the change is on its way');
  put.open();
  c.srv.putGate = null;
  await settle();
  assert.equal(computerRow(page).on, 'true');
  // A read asked before a change answered is not drawn over the change's answer.
  const slow = gate();
  c.srv.getGate = slow.p;
  c.page({ ...PROFILE });
  const reading = c.gets();
  c.srv.getGate = null;
  computerRow(page).sw.click();
  await settle();
  assert.equal(computerRow(page).on, 'false');
  c.srv.view.on = true; // what the slow read will say (it was asked before the change)
  slow.open();
  await settle();
  assert.equal(c.gets(), reading);
  assert.equal(computerRow(page).on, 'false', 'the change\'s answer stays');
  // A new page for an idle cat starts without the old answer and asks again.
  c.show(c.P.catPage(OTHER, { name: '墨点', persona: 'x' }));
  const getGate = gate();
  c.srv.getGate = getGate.p;
  page = c.page({ ...PROFILE });
  assert.equal(computerRow(page).shown, false, 'nothing drawn from before');
  getGate.open();
  await settle();
  assert.equal(computerRow(page).shown, true);
});

test('item 52 wiring: the shell passes the install command\'s 复制 and whether 资料 is on screen; the row\'s styles use existing tokens and 新建\'s own command chip', () => {
  const app = read('client/public/app.js');
  assert.match(app, /copy: \(text\) => copyText\(text\),\n\s+open: \(\) => panel\.classList\.contains\("open"\),\n\s+\}\);/);
  const css = read('client/public/profile.css');
  assert.match(css, /\.pf-locked \.pf-switch\[aria-disabled="true"\] \{ cursor: default; opacity: \.45; \}/);
  assert.match(read('client/public/quick-create.css'), /\n\.qc-cmd \{/);
  const html = read('client/index.html');
  assert.ok(html.indexOf('/quick-create.css') < html.indexOf('/profile.css'), 'the chip\'s look loads before the row\'s');
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
  // Item 46: on screen 全体 is its name under its people mark; what it does is told to a screen reader (the option's own text).
  assert.deepEqual(c.list()!.children.map(o => seenText(o)), ['快手', '墨点', '全体']);
  assert.ok(named(c.list()!, 'mx-hint')[0]!.classList.contains('visually-hidden'));
  // Review r15: a member's printed name keeps its full name for when it is cut short.
  assert.deepEqual(named(c.list()!, 'mx-name').map(n => [n.dataset.tip, n.dataset.tipOnly]), [['快手', 'clipped'], ['墨点', 'clipped'], [undefined, undefined]]);
  assert.match(read('client/public/app.js'), /face: \(name\) => untipped\(avatar\(name, paintOf\(name\), "xs"\)\),\n\s+members: \(\) => \{/, 'the faces beside the names carry no tooltip of the name');
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
  assert.deepEqual(styles.slice(-9), ['profile.css', 'mention.css', 'polish.css', 'chat-cards.css', 'chat-presence.css', 'chat-reactions.css', 'sidebar.css', 'chat-panel.css', 'chat-live.css']);
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
  // Item 46: no heading over the groups on screen, a gap; 群聊 stays for a screen reader.
  assert.match(app, /roster\.append\(sectionLabel\("群聊", null, true\)\)/);
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
  // Requests: only the documented group and conversation routes (置顶 is the shell's own request),
  // and a cat's 这台电脑 (item 52) the only one under /xbot-api/bots/.
  const profile = read('client/public/profile.js');
  assert.deepEqual([...new Set([...profile.matchAll(/"(\/xbot-api\/[^"]*)"/g)].map(m => m[1]))].sort(), ['/xbot-api/bots/', '/xbot-api/groups/']);
  assert.deepEqual([...profile.matchAll(/"\/xbot-api\/bots\/"[^;\n]*/g)].map(m => m[0]), ['"/xbot-api/bots/" + enc(name) + "/computer"']);
  assert.match(app, /newConversation: \(sel, opener\) => chatHistory\.newConversation\(sel, opener\),/);
  assert.match(read('client/public/chat-history.js'), /init, select, merge, top, starters, load, sync: syncMenu, openMenu, closeMenu, newConversation,/);
  assert.doesNotMatch(profile + read('client/public/mention.js'), /innerHTML\s*=(?!\s*body;)|localStorage|sessionStorage|\/stop"|\/cancel"/);
  // The words shown never name a Bot, an Agent, a session or a thread.
  for (const file of ['client/public/profile.js', 'client/public/profile-rules.js', 'client/public/mention.js', 'client/public/mention-rules.js']) {
    const words = [...read(file).matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)].map(m => m[1]);
    assert.ok(words.length > 0, file);
    // The product's own name is no engine word (item 52: the folder the install command runs in), as in tests/vocabulary.test.ts.
    for (const w of words) assert.doesNotMatch(w!.replace(/clowder-bot/gi, ''), /Bot|Agent|session|thread|原生|会话|线程/i, w);
  }
  // Only existing tokens: no new colour literal (the cat's own colour comes from the server).
  for (const file of ['client/public/profile.css', 'client/public/mention.css'])
    assert.doesNotMatch(read(file).replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, file);
});

test('说话简短 left nothing behind in the app (item 39): no script or style it loads says `concise` or 说话简短, and the profile reads are no longer numbered for a switch', () => {
  const html = read('client/index.html'), app = read('client/public/app.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]!);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]!);
  assert.ok(scripts.includes('profile.js') && scripts.includes('app.js') && styles.includes('profile.css'));
  for (const file of [...scripts, ...styles]) assert.doesNotMatch(read('client/public/' + file), /concise|说话简短|pf-brief/i, file);
  for (const file of ['client/public/profile.js', 'client/public/profile-rules.js']) assert.doesNotMatch(read(file), /brief/i, file);
  // fetchBotProfile is one shared request per cat again, nothing more.
  assert.doesNotMatch(app, /profileAsks|profileAsked|profileReads/);
  assert.match(app, /const entry = \{ done: false \};\n\s+entry\.request = api\("\/xbot-api\/bots\/" \+ encodeURIComponent\(name\)\)\.finally\(\(\) => \{ entry\.done = true; \}\);/);
});

test('item 46: 设置 says each thing once — 通用 has no 外观 heading over 主题, 关于 shows the version once (the row that copies it), 运行面板 without the line describing it (its heading says technical, its icon says new tab), no footnote about where the version comes from', () => {
  const html = read('client/index.html');
  const general = /<div class="setpane" data-spane="general">([\s\S]*?)\n   <\/div>\n   <div class="setpane" data-spane="persona">/.exec(html)![1]!;
  assert.doesNotMatch(general, /<h4>/);
  assert.match(general, /<b>主题<\/b>/);
  const about = /<div class="setpane" data-spane="about">([\s\S]*?)\n   <\/div>\n   <\/div>/.exec(html)![1]!;
  assert.equal((about.match(/data-settings-version/g) || []).length, 1, 'once: the 版本 row, the button that copies it');
  assert.match(about, /<h3>clowder-bot<\/h3><\/div><\/div>/);
  assert.match(about, /<span class="tx"><b>运行面板<\/b><\/span>/);
  assert.match(about, /<h4>技术详情<\/h4>/);
  assert.doesNotMatch(about, /在新标签页打开|版本来自|setfoot/);
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

test('item 46: the drawer\'s dialogs and 高级 say once what the layout cannot — 改名 keeps 群名 with its placeholder (optional told to a screen reader), 编辑资料 has no 基本 heading and names its face grid for a screen reader, 复刻 has no example or 可不填, empty run sections are their count', () => {
  // 改名 from the sidebar row's menu.
  const d = drawer();
  d.P.renameGroup(d.group(), null);
  const layer = d.layer()!;
  const input = all(layer).find(n => n.tagName === 'INPUT')!;
  const said = all(layer).find(n => n.id && n.id === input.getAttribute('aria-describedby'))!;
  assert.equal(said.textContent, '可不填，不填就用成员的名字');
  assert.ok(said.classList.contains('visually-hidden'));
  assert.equal(input.placeholder, '快手、墨点、年糕', 'the name it gets when left empty');
  assert.equal(seenText(one(layer, 'pf-dialog-body')), '群名');
  assert.equal(named(layer, 'pf-dialog-hint').length, 0);
  // app.js: 编辑资料, 复刻猫猫 and the run sections under 高级.
  const app = read('client/public/app.js');
  assert.match(app, /section\("", head, labeled\("名字", name\), labeled\("简介", description\)\),/);
  assert.match(app, /if \(title\) group\.append\(el\("h3", "", title\)\);/);
  assert.doesNotMatch(app, /section\("基本"/);
  assert.match(app, /grid\.setAttribute\("role", "group"\);\n\s+grid\.setAttribute\("aria-label", "选择猫猫"\);/);
  assert.doesNotMatch(app, /el\("span", "muted", "选择猫猫"\)/);
  // Review r15: the row over the face grid takes room only when 恢复默认猫猫 is in it.
  const pcss = read('client/public/profile.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(pcss, /\.avatar-row:empty \{ display: none; \}\n\.avatar-row:empty \+ \.avatar-grid \{ margin-top: var\(--x-s6\); \}/);
  assert.match(app, /row\.replaceChildren\(\);\n[^\n]*\n\s+if \(custom \|\| [^\n]*\) row\.append\(clear\);/, 'the row holds nothing but that button');
  assert.match(app, /\{ name: "name", label: "名字" \},\n\s+\{ name: "role", label: "它负责什么", multiline: true \},\n\s+\{ name: "group", label: "分组" \},/);
  assert.doesNotMatch(app, /比如：审稿员|分组（可不填）|现在没有排队的任务。|还没有结束的任务。|现在没有在跑的任务。/);
  assert.match(app, /"现在没有在跑或排队的任务。"/, 'with both live sections hidden, the one statement of the state stays');
  assert.match(app, /catFace: \(name, size\) => untipped\(avatar\(name, paintOf\(name\), size\)\),/, 'faces beside printed names carry no tooltip of the name');
});
