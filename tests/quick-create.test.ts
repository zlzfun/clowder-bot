import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { z } from 'zod';
import { clip } from '../server/native/text.js';

// 开箱即用 (quick-create-rules.js, quick-create.js): the first-run stage, the
// no-chat line and the quick 新建猫猫 / 新建群聊 dialogs. The page scripts run
// here as the classic browser scripts they are, in a VM with a small DOM (tree,
// bubbling events, focus that is lost when its element leaves the page, submit
// from a submit button) and the real cat-avatars.js presets, against a fake
// /xbot-api. app.js is not loaded: its hooks are faked the way it passes them
// to init(), and static checks cover its wiring.
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
}
class El {
  kids: Array<El | Txt> = []; parent: El | null = null; attrs = new Map<string, string>(); listeners = new Map<string, Array<(ev: Ev) => unknown>>();
  style: Record<string, string> = {}; hidden = false; disabled = false; readOnly = false; checked = false; value = ''; type = '';
  placeholder = ''; maxLength = 0; autocomplete = ''; spellcheck = true; htmlFor = ''; selected = 0; private tab: number | null = null;
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
    return new Proxy({}, { get: (_t, k: string) => this.attrs.get(key(k)), set: (_t, k: string, v) => { this.attrs.set(key(k), String(v)); return true; } });
  }
  get tabIndex() { return this.tab ?? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName) ? 0 : -1); }
  set tabIndex(value: number) { this.tab = Number(value); }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  get textContent(): string { return this.kids.map(k => k.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); if (value !== '' && value != null) this.append(String(value)); }
  append(...items: Array<El | Txt | string>) {
    for (const item of items) {
      const n = typeof item === 'string' ? new Txt(item) : item;
      if (n.parent) n.parent.kids.splice(n.parent.kids.indexOf(n), 1);
      n.parent = this;
      this.kids.push(n);
    }
  }
  replaceChildren(...items: Array<El | Txt | string>) { for (const k of this.kids) k.parent = null; this.kids = []; this.append(...items); }
  remove() { if (this.parent) { this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; } }
  contains(n: unknown): boolean { for (let x = n as El | null; x; x = x.parent) if (x === this) return true; return false; }
  get isConnected(): boolean { for (let n: El | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  addEventListener(type: string, fn: (ev: Ev) => unknown) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const ev = new Ev(type, init);
    ev.target = this;
    for (let n: El | null = this; n && !ev.stopped; n = n.parent) { ev.currentTarget = n; for (const fn of [...(n.listeners.get(type) ?? [])]) fn(ev); }
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
  select() { this.selected++; }
  querySelectorAll(sel: string) { const tags = sel.split(',').map(s => s.trim().toUpperCase()); return all(this).filter(e => tags.includes(e.tagName)); }
  getClientRects() { for (let n: El | null = this; n; n = n.parent) if (n.hidden) return []; return [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
}
class Doc {
  body: El; focused: El | null = null;
  constructor() { this.body = new El(this, 'BODY'); }
  createElement(tag: string) { return new El(this, tag.toUpperCase()); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag.toUpperCase()); }
  get activeElement(): El { return this.focused && this.focused.isConnected ? this.focused : this.body; }
}
const all = (root: El): El[] => root.children.flatMap(c => [c, ...all(c)]);
const has = (n: El, cls: string) => n.classList.contains(cls);
const named = (root: El, cls: string) => all(root).filter(n => has(n, cls));
const one = (root: El, cls: string) => { const n = named(root, cls)[0]; assert.ok(n, 'no .' + cls); return n!; };
const shown = (n: El) => n.getClientRects().length > 0;
const button = (root: El, text: string) => {
  const b = all(root).find(n => n.tagName === 'BUTTON' && n.textContent === text && shown(n));
  assert.ok(b, 'no button ' + text);
  return b!;
};
// The control of a label: the element the <label> points at.
function control(root: El, label: string): El {
  const lab = all(root).find(n => n.tagName === 'LABEL' && n.textContent.startsWith(label) && shown(n));
  assert.ok(lab, 'no field ' + label);
  const target = all(root).find(n => n.id && n.id === lab!.htmlFor);
  assert.ok(target, 'no control for ' + label);
  return target!;
}
const type = (input: El, value: string) => { input.value = value; input.dispatch('input'); };
const choose = (select: El, value: string) => { select.value = value; select.dispatch('change'); };
const faces = (root: El) => named(root, 'qc-face');
const chosen = (root: El) => faces(root).find(f => f.getAttribute('aria-checked') === 'true')?.getAttribute('aria-label') ?? null;
const face = (root: El, label: string) => { const f = faces(root).find(x => x.getAttribute('aria-label') === label); assert.ok(f, 'no face ' + label); return f!; };
const visibleText = (root: El): string => root.hidden ? '' : root.kids.map(k => (k instanceof El ? visibleText(k) : k.textContent)).join('');

// ---------------------------------------------------------------- the page
const fail = (status: number | undefined, message = 'request failed') => Object.assign(new Error(message), status ? { status } : {});
const tool = (id: string, label: string, state: string, loginCommand: string) => ({ id, label, state, loginCommand });
const START = {
  ready: { cats: 0, ready: true, agent: { id: 'codex', label: 'Codex', confirmed: true }, blocked: null, checkedAt: 1,
    agents: [tool('codex', 'Codex', 'ready', 'codex login'), tool('claude', 'Claude Code', 'ready', 'claude auth login'), tool('kimi', 'Kimi', 'missing', 'kimi login')] },
  unknown: { cats: 0, ready: true, agent: { id: 'codex', label: 'Codex', confirmed: false }, blocked: null, checkedAt: 1,
    agents: [tool('codex', 'Codex', 'unknown', 'codex login'), tool('claude', 'Claude Code', 'missing', 'claude auth login'), tool('kimi', 'Kimi', 'missing', 'kimi login')] },
  login: { cats: 0, ready: false, agent: null, blocked: 'login_required', checkedAt: 1,
    agents: [tool('codex', 'Codex', 'login', 'codex login'), tool('claude', 'Claude Code', 'missing', 'claude auth login'), tool('kimi', 'Kimi', 'missing', 'kimi login')] },
  none: { cats: 0, ready: false, agent: null, blocked: 'no_agent', checkedAt: 1,
    agents: [tool('codex', 'Codex', 'missing', 'codex login'), tool('claude', 'Claude Code', 'missing', 'claude auth login'), tool('kimi', 'Kimi', 'missing', 'kimi login')] },
};
type Call = { path: string; method: string; body?: Any };
function page(opts: { start?: Any; cats?: string[]; route?: (path: string, method: string, body: Any) => unknown; openCat?: (name: string) => unknown } = {}) {
  const doc = new Doc();
  const window: Any = { crypto: globalThis.crypto };
  const context = vm.createContext({ window, document: doc, setTimeout: () => 0, clearTimeout: () => {}, console });
  for (const file of ['client/public/cat-avatars.js', 'client/public/quick-create-rules.js', 'client/public/quick-create.js']) vm.runInContext(read(file), context);
  const s = { start: opts.start ?? START.ready, cats: [...(opts.cats ?? [])] };
  const calls: Call[] = [], opened: string[] = [], groups: string[] = [], more: Any[] = [], copied: string[] = [], errors: string[] = [];
  let refreshed = 0, lists = 0;
  const api = async (path: string, opt: { method?: string; body?: unknown } = {}) => {
    const call: Call = { path, method: opt.method || 'GET', ...(opt.body === undefined ? {} : { body: plain(opt.body) }) };
    calls.push(call);
    const custom = opts.route ? await opts.route(path, call.method, call.body) : undefined;
    if (custom !== undefined) return plain(custom);
    if (path.startsWith('/xbot-api/start')) return plain(s.start);
    if (path === '/xbot-api/bots' && call.method === 'POST') return { name: call.body.name, native_id: 'bot-new' };
    if (path === '/xbot-api/groups' && call.method === 'POST') return { id: 'thread-G', name: call.body.name ?? call.body.members.join('、') };
    throw fail(404);
  };
  const Q = window.ClowderQuickCreate;
  // The hooks app.js passes (see quick.init in client/public/app.js).
  Q.init({
    api,
    icon: (name: string) => { const i = doc.createElement('svg'); i.dataset.icon = name; return i; },
    face: (name: string) => { const a = doc.createElement('span'); a.className = 'avatar'; a.dataset.cat = name; return a; },
    cats: () => s.cats,
    copy: async (text: string) => { copied.push(text); return true; },
    refresh: async () => { refreshed++; },
    openCat: async (name: string) => { opened.push(name); if (opts.openCat) await opts.openCat(name); },
    openGroup: async (id: string) => { groups.push(id); },
    landing: () => null,
    more: (opener: unknown) => { more.push(opener); },
    showList: () => { lists++; },
    error: (e: Error) => { errors.push(e.message); },
  });
  // The shell paints a no-chat view into the history (app.js showNoChat).
  const thread = doc.createElement('div');
  doc.body.append(thread);
  const paint = (view: El) => { const inner = doc.createElement('div'); inner.className = 'thread-inner no-chat'; inner.append(view); thread.replaceChildren(inner); return view; };
  const opener = doc.createElement('button');
  doc.body.append(opener);
  return {
    doc, Q, R: window.ClowderQuickCreateRules, s, calls, opened, groups, more, copied, errors, thread, paint, opener,
    get refreshed() { return refreshed; }, get lists() { return lists; },
    posts: () => calls.filter(c => c.method === 'POST' && c.path === '/xbot-api/bots'),
    stage: async () => { const v = paint(Q.stage()); await settle(); return v; },
    layer: () => named(doc.body, 'qc-modal')[0] ?? null,
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------- rules
test('the cat name and group name rules accept exactly what the server\'s own schemas accept', () => {
  const { R } = page();
  // The schemas are taken from server/xbot/core.ts itself, so a change there shows up here.
  const core = read('server/xbot/core.ts');
  const schema = (name: string) => {
    const m = new RegExp(`const ${name} = (z\\.string\\(\\)[^;]+);`).exec(core);
    assert.ok(m, name + ' is where the adapter keeps it');
    return new Function('z', 'return ' + m[1])(z);
  };
  const label = schema('label'), groupTitle = schema('groupTitle');
  const names = ['宪宪', '  宪宪 ', 'Mr. Cat_2-b', 'a'.repeat(64), 'a'.repeat(65), ' ' + 'b'.repeat(64) + ' ', '名'.repeat(64), '名'.repeat(65),
    '𠀀'.repeat(32), '𠀀'.repeat(33), 'café', '١٢٣', '团子<1>', 'emoji😺', '#tag', 'tab\tname', 'new\nline', 'a/b', '周末 读书会', ''];
  for (const name of names) assert.equal(R.nameProblem(name, []) === '', label.safeParse(name).success, JSON.stringify(name));
  for (const name of names.filter(n => n.trim())) assert.equal(R.groupNameProblem(name) === '', groupTitle.safeParse(name).success, 'group ' + JSON.stringify(name));
  // An empty group name is not sent: the server then names the group after its members.
  assert.equal(R.groupNameProblem('  '), '');
  assert.deepEqual(plain(R.groupBody(['团子', '栗子'], '  ')), { members: ['团子', '栗子'] });
  // A taken name is refused before sending, ignoring case as the adapter does.
  assert.equal(R.nameProblem('Mochi', ['mochi']), '已经有一只叫「Mochi」的猫猫了，换个名字吧');
  assert.equal(R.nameProblem('', []), '给它起个名字吧');
});

test('an unnamed group is previewed with the name the server will give it', () => {
  const { R } = page();
  const lists = [['团子', '栗子'], ['团子'], Array.from({ length: 10 }, (_, i) => '一只名字有点长的猫猫' + i), ['😺'.repeat(31) + 'x', '尾巴'], [' 年糕 ', '团子']];
  for (const members of lists) assert.equal(R.groupName(members), clip(members.map(m => m.trim()).join('、'), 64), members.join('|'));
});

test('a face goes with the tool, a name comes from the face and stays free of taken names, and a typed name is the owner\'s', () => {
  const { R, doc } = page();
  const ids = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'];
  assert.equal(R.defaultFace('claude', ids), 'ragdoll');
  assert.equal(R.defaultFace('codex', ids), 'maine-coon');
  assert.equal(R.defaultFace('kimi', ids), 'turkish-van');
  assert.equal(R.defaultFace('opencode', ids), 'ragdoll', 'otherwise the first');
  const presets = (vm.runInNewContext(read('client/public/cat-avatars.js') + ';window.ClowderAvatars.presets', { window: {}, document: doc }) as Any[]);
  assert.equal(R.suggestName('maine-coon', presets, []), '砚砚');
  assert.equal(R.suggestName('maine-coon', presets, ['砚砚', '砚砚 2']), '砚砚 3');
  assert.equal(R.suggestName('nobody', presets, []), '');
  assert.equal(R.followsFace('', '砚砚'), true, 'an empty box takes the next suggestion');
  assert.equal(R.followsFace('砚砚', '砚砚'), true);
  assert.equal(R.followsFace('小白', '砚砚'), false);
});

test('/start is read as it is: only usable tools are offered, an unchecked login is never called ready, and what blocks is named with its command', () => {
  const { R } = page();
  const ready = R.start(START.ready);
  assert.deepEqual(plain(R.choices(ready)), [{ id: 'codex', label: 'Codex', confirmed: true }, { id: 'claude', label: 'Claude Code', confirmed: true }]);
  assert.deepEqual(plain(R.choices(R.start(START.unknown))), [{ id: 'codex', label: 'Codex', confirmed: false }]);
  assert.match(R.unconfirmed('Codex', 'codex login'), /没能确认 Codex 已经登录/);
  // A malformed answer is not a ready one.
  assert.equal(R.start({ ready: true, agent: null }).ready, false);
  assert.deepEqual(plain(R.choices(R.start(START.login))), []);
  const login = R.need(R.start(START.login));
  assert.equal(login.title, '还差一步：登录 Codex');
  assert.deepEqual(plain(login.commands), [{ label: 'Codex', command: 'codex login' }]);
  const both = R.need(R.start({ ...START.login, agents: [tool('codex', 'Codex', 'login', 'codex login'), tool('claude', 'Claude Code', 'login', 'claude auth login')] }));
  assert.equal(both.title, '还差一步：登录 Codex 或 Claude Code');
  assert.equal(both.commands.length, 2);
  const none = R.need(R.start(START.none));
  assert.match(none.body, /Claude Code 或 Codex/);
  assert.deepEqual(plain(none.commands), []);
  for (const copy of [login, both, none]) assert.doesNotMatch(JSON.stringify(plain(copy)), /Agent|Bot|模型/);
  assert.equal(R.sameStart(R.start(START.login), R.start(plain(START.login))), true);
  assert.equal(R.sameStart(R.start(START.login), R.start(START.none)), false);
});

test('the request sends the tool that was shown and only what was filled; a 409 is the name, a 422 blocks, no answer is unsure', () => {
  const { R } = page();
  const body = plain(R.catBody({ name: ' 小白 ', face: 'bengal', agent: 'claude', about: '  ' }));
  assert.deepEqual(body, { name: '小白', simple: { face: 'bengal', agent: 'claude' } });
  assert.deepEqual(plain(R.catBody({ name: 'a', face: 'dsh', agent: 'codex', about: ' 帮我改简历 ' })).simple.about, '帮我改简历');
  assert.equal(R.fingerprint(body), R.fingerprint({ simple: { agent: 'claude', face: 'bengal' }, name: '小白' }), 'key order does not make a new request');
  assert.deepEqual(plain(R.catError(fail(409, '已经有一只叫这个名字的猫猫了'), '小白')), { kind: 'name', text: '已经有一只叫「小白」的猫猫了，换个名字吧' });
  assert.equal(R.catError(fail(422, '请先在本机 Agent 中完成登录'), '小白', 'Codex').text, '刚才没能建好：Codex 现在用不了。', 'the adapter\'s word "Agent" is not shown');
  for (const err of [fail(undefined, '连不上 clowder-bot'), fail(502, '服务出了点问题，请稍后再试。')]) assert.equal(R.catError(err, 'x').kind, 'unsure');
  assert.equal(R.catError(fail(400, 'name: 找不到这个 Bot')).text, '没能建好，请检查名字后再试。');
  assert.equal(R.groupError(fail(undefined)).kind, 'unsure');
  assert.equal(R.groupError(fail(404, '找不到这个 Bot')).text, '有只猫猫找不到了，刷新列表后再试。');
  assert.equal(R.groupError(fail(400, '成员不能重复')).text, '成员不能重复', 'an everyday server sentence is kept');
  assert.equal(R.startError(fail(undefined, '连不上 clowder-bot')), '连不上 clowder-bot', 'the product name is not jargon');
});

// ---------------------------------------------------------------- the stage
test('the first screen: eight faces with the tool\'s own chosen, its nickname as the name, no focus taken, and the composer hidden', async () => {
  const p = page();
  const stage = await p.stage();
  assert.equal(faces(stage).length, 8);
  assert.equal(chosen(stage), '缅因猫', 'Codex is the default tool, so its face');
  const name = control(stage, '名字');
  assert.equal(name.value, '砚砚');
  assert.equal(p.doc.activeElement, p.doc.body, 'the cats come first; a phone keeps its keyboard down');
  // Two tools: the line names the chosen one in a quiet select of the usable ones.
  const line = one(stage, 'qc-tool-line'), select = line.querySelectorAll('select')[0];
  assert.deepEqual(line.kids.map(k => (k instanceof El ? k.tagName : k.textContent)), ['它会用这台电脑上的 ', 'SPAN', ' 来思考']);
  assert.equal(select.value, 'codex');
  assert.deepEqual(select.children.map(o => [o.value, o.textContent]), [['codex', 'Codex'], ['claude', 'Claude Code']]);
  assert.equal(shown(one(stage, 'qc-tool-note')), false, 'a confirmed login needs no note');
  // One radio group, one tab stop.
  assert.equal(one(stage, 'qc-faces').getAttribute('role'), 'radiogroup');
  assert.deepEqual(faces(stage).map(f => f.tabIndex), [-1, 0, -1, -1, -1, -1, -1, -1]);
  assert.match(read('client/public/quick-create.css'), /\.main:has\(\.thread-inner\.no-chat\) \.dock \{ display: none; \}/);
});

test('choosing a face is one click or an arrow key; the name follows it until the owner types their own', async () => {
  const p = page();
  const stage = await p.stage();
  const name = control(stage, '名字');
  face(stage, '布偶猫').click();
  assert.equal(chosen(stage), '布偶猫');
  assert.equal(name.value, '宪宪');
  face(stage, '布偶猫').key('ArrowRight');
  assert.equal(chosen(stage), '缅因猫');
  assert.equal(p.doc.activeElement.getAttribute('aria-label'), '缅因猫', 'focus moves with the choice');
  face(stage, '缅因猫').key('ArrowLeft');
  face(stage, '布偶猫').key('ArrowLeft');
  assert.equal(chosen(stage), '金渐层', 'wraps round');
  assert.equal(name.value, '金哥');
  face(stage, '金渐层').key('Home');
  assert.equal(chosen(stage), '布偶猫');
  type(name, '小白');
  face(stage, '布偶猫').key('End');
  assert.equal(name.value, '小白', 'a typed name stays');
  type(name, '');
  face(stage, '金渐层').key('ArrowLeft');
  assert.equal(name.value, '斑斑', 'emptied, it follows again');
});

test('switching the tool moves an untouched face with it; the body carries the tool shown, and the chat opens with the server\'s name', async () => {
  const p = page();
  const stage = await p.stage();
  choose(one(stage, 'qc-tool').querySelectorAll('select')[0], 'claude');
  assert.equal(chosen(stage), '布偶猫');
  assert.equal(control(stage, '名字').value, '宪宪');
  button(stage, '带它回家').click();
  await settle();
  const [post] = p.posts();
  assert.deepEqual(Object.keys(post.body).sort(), ['idempotencyKey', 'name', 'simple']);
  assert.match(post.body.idempotencyKey, UUID);
  assert.deepEqual(post.body.simple, { face: 'ragdoll', agent: 'claude' });
  assert.deepEqual(p.opened, ['宪宪']);
  // A face the owner picked stays when the tool changes.
  const q = page();
  const again = await q.stage();
  face(again, '孟加拉猫').click();
  choose(one(again, 'qc-tool').querySelectorAll('select')[0], 'claude');
  assert.equal(chosen(again), '孟加拉猫');
});

test('a request that may have landed is sent again unchanged under the same key; a changed one gets a new key; a taken name marks the name', async () => {
  let answer: (() => unknown) | null = () => { throw fail(undefined, '连不上 clowder-bot'); };
  const p = page({ route: (path, method) => (path === '/xbot-api/bots' && method === 'POST' && answer ? answer() : undefined) });
  const stage = await p.stage();
  const go = button(stage, '带它回家');
  go.click();
  await settle();
  assert.equal(visibleText(one(stage, 'qc-error')), '没能确认猫猫建好没有。不改内容再点一次就好，不会多出一只。');
  assert.equal(p.refreshed, 1, 'the list is read again, where the cat may already be');
  assert.equal(p.doc.activeElement, go);
  answer = () => { throw fail(502, '服务出了点问题，请稍后再试。'); };
  go.click();
  await settle();
  const [first, second] = p.posts();
  assert.deepEqual(second.body, first.body, 'same key, same body');
  type(control(stage, '名字'), '团子');
  answer = () => { throw fail(409, '已经有一只叫这个名字的猫猫了'); };
  go.click();
  await settle();
  const third = p.posts()[2];
  assert.notEqual(third.body.idempotencyKey, first.body.idempotencyKey, 'a different body is a new request');
  const name = control(stage, '名字');
  assert.equal(name.getAttribute('aria-invalid'), 'true');
  assert.equal(one(stage, 'qc-err').textContent, '已经有一只叫「团子」的猫猫了，换个名字吧');
  assert.equal(p.doc.activeElement, name);
  assert.deepEqual(p.opened, []);
  // The owner's own fix goes through.
  type(name, '团子二号');
  assert.equal(one(stage, 'qc-err').textContent, '', 'typing clears the message');
  answer = null;
  go.click();
  await settle();
  assert.deepEqual(p.opened, ['团子二号']);
});

test('a name the server would refuse is caught before sending', async () => {
  const p = page();
  const stage = await p.stage();
  type(control(stage, '名字'), '团子<1>');
  button(stage, '带它回家').click();
  await settle();
  assert.equal(one(stage, 'qc-err').textContent, '名字只能用文字、数字、空格和 _ . -');
  assert.equal(p.posts().length, 0);
});

test('a 422 reads /start again and shows what is in the way; 重新检测 says plainly when nothing changed and brings the form back once it has', async () => {
  const p = page({ route: (path, method) => { if (path === '/xbot-api/bots' && method === 'POST') { p.s.start = START.login; throw fail(422, '请先在本机 Agent 中完成登录'); } return undefined; } });
  const stage = await p.stage();
  button(stage, '带它回家').click();
  await settle();
  assert.deepEqual(p.calls.map(c => c.method + ' ' + c.path), ['GET /xbot-api/start', 'POST /xbot-api/bots', 'GET /xbot-api/start']);
  const need = one(stage, 'qc-need');
  assert.equal(shown(need), true);
  assert.equal(shown(one(stage, 'qc-fields')), false, 'no form that cannot work');
  assert.equal(one(stage, 'qc-faces').getAttribute('aria-hidden'), 'true', 'the row is only a picture');
  assert.equal(chosen(stage), null);
  assert.match(visibleText(need), /还差一步：登录 Codex/);
  assert.equal(visibleText(one(need, 'qc-note')), '刚才没能建好：Codex 现在用不了。');
  assert.equal(visibleText(one(need, 'qc-cmd')), 'codex login复制');
  button(need, '复制').click();
  await settle();
  assert.deepEqual(p.copied, ['codex login']);
  assert.equal(one(need, 'qc-copy').textContent, '已复制');
  // Nothing changed.
  const again = button(need, '重新检测');
  again.focus();
  again.click();
  assert.equal(again.getAttribute('aria-disabled'), 'true', 'inert while checking, but still holding focus');
  assert.equal(again.textContent, '正在检测…');
  again.click();
  await settle();
  assert.equal(p.calls.filter(c => c.path === '/xbot-api/start?refresh=1').length, 1, 'one check at a time');
  assert.equal(p.calls.at(-1)!.path, '/xbot-api/start?refresh=1');
  assert.equal(visibleText(one(stage, 'qc-note')), '重新检测过了，还是没检测到登录。');
  assert.equal(p.doc.activeElement.textContent, '重新检测', 'focus stays on the button across the repaint');
  // Logged in now.
  p.s.start = START.ready;
  button(stage, '重新检测').click();
  await settle();
  assert.equal(shown(one(stage, 'qc-fields')), true);
  assert.equal(chosen(stage), '缅因猫');
  assert.equal(p.doc.activeElement, control(stage, '名字'), 'focus moves from the vanished button to the name');
});

test('with no tool the stage says what to install and offers nothing that cannot work; a failed read says so and can be retried', async () => {
  const p = page({ start: START.none });
  const stage = await p.stage();
  assert.match(visibleText(stage), /还差一步：装好 Claude Code 或 Codex/);
  assert.equal(shown(one(stage, 'qc-go')), false);
  assert.equal(named(stage, 'qc-cmd').length, 0);
  stage.dispatch('submit');
  await settle();
  assert.equal(p.posts().length, 0);
  button(stage, '重新检测').click();
  await settle();
  assert.equal(visibleText(one(stage, 'qc-note')), '重新检测过了，还是没找到能用的。');

  let down = true;
  const q = page({ route: (path) => { if (path === '/xbot-api/start' && down) throw fail(undefined, '连不上 clowder-bot'); return undefined; } });
  const view = await q.stage();
  assert.match(visibleText(one(view, 'qc-wait')), /^连不上 clowder-bot。重试$/);
  assert.equal(shown(one(view, 'qc-fields')), false);
  down = false;
  button(view, '重试').click();
  await settle();
  assert.equal(shown(one(view, 'qc-fields')), true);
});

test('a login that could not be checked is said, with the command, and the cat can still be made', async () => {
  const p = page({ start: START.unknown });
  const stage = await p.stage();
  const tool = one(stage, 'qc-tool');
  assert.equal(visibleText(one(tool, 'qc-tool-line')), '它会用这台电脑上的 Codex 来思考');
  assert.match(visibleText(one(tool, 'qc-tool-note')), /^没能确认 Codex 已经登录。还没登录的话，先在终端里运行：codex login复制$/);
  button(stage, '带它回家').click();
  await settle();
  assert.equal(p.posts()[0].body.simple.agent, 'codex');
});

test('made but not opened: the stage says the cat is there and opens its chat on request', async () => {
  let refuse = true;
  const p = page({ openCat: () => { if (refuse) throw fail(undefined, '连不上 clowder-bot'); } });
  const stage = await p.stage();
  button(stage, '带它回家').click();
  await settle();
  assert.equal(stage.classList.contains('leaving'), false);
  assert.match(visibleText(stage), /「砚砚」已经到家了，只是没能打开聊天。/);
  assert.equal(shown(one(stage, 'qc-fields')), false, 'no second creation');
  refuse = false;
  button(stage, '打开聊天').click();
  await settle();
  assert.deepEqual(p.opened, ['砚砚', '砚砚']);
  assert.equal(p.posts().length, 1);
});

test('the no-chat line speaks of 猫猫 and the list, and opens the list', () => {
  const p = page({ cats: ['团子'] });
  const view = p.paint(p.Q.noChat());
  assert.equal(visibleText(view), '选一个聊天从列表里选一只猫猫或一个群聊。打开列表');
  assert.doesNotMatch(visibleText(view), /左边|Bot/);
  button(view, '打开列表').click();
  assert.equal(p.lists, 1);
});

// ---------------------------------------------------------------- 新建猫猫
test('新建猫猫: a small dialog starting in a free name; Escape closes back to the opener; Tab stays inside; a taken name never leaves', async () => {
  const p = page({ cats: ['团子', '砚砚'] });
  p.opener.focus();
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  const name = control(card, '名字');
  assert.equal(name.value, '砚砚 2', '砚砚 is taken');
  assert.equal(p.doc.activeElement, name);
  assert.equal(name.selected, 1, 'typing replaces the suggestion');
  assert.equal(button(card, '取消').tabIndex, 0);
  // Tab from the last control wraps to the first.
  const go = button(card, '创建');
  go.focus();
  go.key('Tab');
  assert.equal(p.doc.activeElement, faces(card).find(f => f.tabIndex === 0));
  type(name, 'TUANZI');
  p.s.cats.push('tuanzi');
  card.dispatch('submit');
  await settle();
  assert.match(one(card, 'qc-err').textContent, /已经有一只叫「TUANZI」的猫猫了/);
  assert.equal(p.posts().length, 0);
  name.key('Escape');
  assert.equal(p.layer(), null);
  assert.equal(p.doc.activeElement, p.opener);
});

test('新建猫猫 sends the face, the name, the optional line and the tool; it cannot be closed mid-request; 更多设置 hands over to the template creator', async () => {
  let release: () => void = () => {};
  const p = page({ cats: ['团子'], route: (path, method) => (path === '/xbot-api/bots' && method === 'POST' ? new Promise(done => { release = () => done({ name: '小白', native_id: 'bot-1' }); }) : undefined) });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  face(card, '金渐层').click();
  type(control(card, '名字'), '小白');
  type(control(card, '它主要帮你做什么'), '  帮我改简历 ');
  control(card, '名字').key('Enter');
  card.dispatch('submit'); // Enter in a field submits the form
  card.dispatch('submit'); // a second press while saving does nothing
  await settle();
  assert.equal(p.posts().length, 1);
  assert.deepEqual({ ...p.posts()[0].body, idempotencyKey: 'k' }, { name: '小白', simple: { face: 'golden-chinchilla', about: '帮我改简历', agent: 'codex' }, idempotencyKey: 'k' });
  assert.equal(button(card, '正在创建…').disabled, true);
  assert.equal(p.doc.activeElement, card, 'focus waits on the dialog, not on a disabled control');
  card.key('Escape');
  assert.ok(p.layer(), 'Escape does not drop a request on its way');
  release();
  await settle();
  assert.equal(p.layer(), null);
  assert.deepEqual(p.opened, ['小白']);

  const q = page({ cats: ['团子'] });
  q.Q.openCat({ opener: q.opener });
  await settle();
  button(one(q.layer()!, 'qc-card'), '更多设置').click();
  assert.equal(q.layer(), null);
  assert.deepEqual(q.more, [q.opener], 'the template creator returns focus to the same opener');
  assert.equal(q.posts().length, 0);
});

test('新建猫猫 while the tool needs a login shows what is in the way in the dialog, with 更多设置 still there', async () => {
  const p = page({ cats: ['团子'], start: START.login });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  assert.match(visibleText(card), /还差一步：登录 Codex/);
  assert.equal(shown(one(card, 'qc-fields')), false);
  assert.ok(button(card, '更多设置'));
  assert.equal(all(card).some(n => n.tagName === 'BUTTON' && n.textContent === '创建' && shown(n)), false);
});

// ---------------------------------------------------------------- 新建群聊
test('新建群聊 with fewer than two cats says a group needs two and offers to add a cat', async () => {
  const p = page({ cats: ['团子'] });
  p.Q.openGroup({ opener: p.opener });
  const card = one(p.layer()!, 'qc-card');
  assert.equal(visibleText(one(card, 'qc-lead')), '群聊至少要两只猫猫，现在只有 1 只。');
  button(card, '新建猫猫').click();
  await settle();
  assert.equal(one(p.layer()!, 'qc-card').children[0].textContent, '新建猫猫', 'the cat dialog takes its place');
  assert.equal(p.doc.body.children.filter(n => has(n, 'qc-modal')).length, 1);
});

test('新建群聊: two to ten cats as face chips, in the order picked; the name is optional and its placeholder is the name the group gets', async () => {
  const cats = Array.from({ length: 11 }, (_, i) => '猫' + (i + 1));
  const p = page({ cats });
  p.Q.openGroup({ opener: p.opener });
  const card = one(p.layer()!, 'qc-card');
  const boxes = all(card).filter(n => n.tagName === 'INPUT' && n.type === 'checkbox');
  assert.equal(boxes.length, 11);
  assert.equal(p.doc.activeElement, boxes[0]);
  const go = button(card, '创建'), hint = one(card, 'qc-hint'), name = control(card, '群名');
  const pick = (i: number, on = true) => { boxes[i].checked = on; boxes[i].dispatch('change'); };
  assert.equal(go.disabled, true);
  assert.equal(hint.textContent, '至少选 2 只');
  pick(2);
  assert.equal(hint.textContent, '已选 1 只，再选 1 只');
  assert.equal(go.disabled, true);
  pick(0);
  assert.equal(go.disabled, false);
  assert.equal(name.placeholder, '猫3、猫1', 'the order picked');
  for (let i = 3; i < 11; i++) pick(i);
  assert.equal(hint.textContent, '已选 10 只，一个群最多 10 只');
  assert.equal(boxes[1].disabled, true, 'the eleventh cannot join');
  pick(10, false);
  assert.equal(boxes[1].disabled, false);
  pick(10, false);
  pick(1);
  type(name, '读书<会>');
  card.dispatch('submit');
  await settle();
  assert.equal(one(card, 'qc-err').textContent, '群名里不能有 < > 这类符号');
  assert.equal(p.calls.length, 0);
  type(name, '  ');
  card.dispatch('submit');
  await settle();
  assert.deepEqual(p.calls.map(c => c.body), [{ members: ['猫3', '猫1', '猫4', '猫5', '猫6', '猫7', '猫8', '猫9', '猫10', '猫2'] }]);
  assert.equal(p.layer(), null);
  assert.deepEqual(p.groups, ['thread-G']);
});

test('新建群聊: an unsure answer keeps the dialog, says to look before retrying, and reads the list again', async () => {
  const p = page({ cats: ['团子', '栗子'], route: (path, method) => { if (path === '/xbot-api/groups' && method === 'POST') throw fail(undefined, '连不上 clowder-bot'); return undefined; } });
  p.Q.openGroup({ opener: p.opener });
  const card = one(p.layer()!, 'qc-card');
  for (const box of all(card).filter(n => n.type === 'checkbox')) { box.checked = true; box.dispatch('change'); }
  type(control(card, '群名'), ' 晨会 ');
  card.dispatch('submit');
  await settle();
  assert.deepEqual(p.calls[0].body, { members: ['团子', '栗子'], name: '晨会' });
  assert.ok(p.layer());
  assert.equal(visibleText(one(card, 'qc-error')), '没能确认群聊建好没有。先看看列表里有没有它，再决定要不要重试。');
  assert.equal(p.refreshed, 1);
  assert.deepEqual(p.groups, []);
});

// ---------------------------------------------------------------- wiring
test('the shell loads the module before app.js and its styles last, opens the stage or the no-chat line when nothing is open, and routes 新建 through it', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/quick-create.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('cat-avatars.js') < at('quick-create-rules.js') && at('chat-experience.js') < at('quick-create-rules.js'));
  assert.ok(at('quick-create-rules.js') < at('quick-create.js') && at('quick-create.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.equal(styles.at(-1), 'quick-create.css');
  assert.match(html, /aria-label="新建猫猫或群聊"/);
  // Nothing open: the stage with no cats, else the no-chat line; both hide the composer, as does the pre-login hold.
  assert.match(app, /else if \(!state\.sel\) showNoChat\(\);/);
  assert.match(app, /function showNoChat\(\) \{\n\s+const inner = el\("div", "thread-inner no-chat"\);\n\s+inner\.append\(state\.bots\.length \? quick\.noChat\(\) : quick\.stage\(\)\);/);
  assert.match(app, /const hold = el\("div", "thread-inner no-chat"\);/);
  assert.match(app, /else \{ paintPanel\(\); showNoChat\(\); \}/, 'deleting the last cat comes back to the stage');
  assert.doesNotMatch(app, /左边是你的 Bot|选一个对话/);
  // 新建: 新建猫猫 is the quick dialog (更多设置 → the template creator); 新建群聊 replaces 新建群组.
  assert.match(app, /item\("users-plus", "新建群聊", \(\) => openNewGroup\(anchor\)\)/);
  assert.doesNotMatch(app, /新建群组/);
  assert.match(app, /function openNewBot\(opener\) \{[\s\S]*?quick\.openCat\(\{ opener:/);
  assert.match(app, /more: \(opener\) => openTemplateCreate\(opener\)/);
  assert.match(app, /function openTemplateCreate\(opener\) \{[\s\S]*?window\.ClowderCatTemplates\.openCreate\(\{/);
  assert.match(app, /if \(ev\.key === "Escape"\) \{ ev\.preventDefault\(\); ev\.stopPropagation\(\); closeNewMenu\(\); \}/);
  // Where the new cat's portrait lands: its own face in the header.
  assert.match(app, /landing: \(name\) => \[\.\.\.document\.querySelectorAll\("#title \.avatar\[data-avatar-bot\]"\)\]/);
  // Only existing tokens; no new colour literal.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  // The words shown never name a Bot, an Agent or a model.
  for (const file of ['client/public/quick-create.js', 'client/public/quick-create-rules.js']) {
    const shownWords = [...read(file).matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)].map(m => m[1]);
    assert.ok(shownWords.length > 20, file);
    for (const words of shownWords) assert.doesNotMatch(words, /Bot|Agent|模型/i, words);
  }
});
