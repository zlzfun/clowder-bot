import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { z } from 'zod';
import { clip } from '../server/native/text.js';
import { catFaces, faceTemplates, startSummary } from '../server/native/agents.js';
import { catTemplates } from './native-fixture.js';

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
  key(key: string, more: Record<string, unknown> = {}) {
    const ev = this.dispatch('keydown', { key, ...more });
    // As a browser does (implicit submission): Enter in a text field presses its form's default button, the
    // first submit button, unless that button is disabled (click() does nothing then).
    if (key === 'Enter' && !ev.defaultPrevented && this.tagName === 'INPUT') {
      const form = this.closest('FORM'), main = form && all(form).find(n => n.tagName === 'BUTTON' && n.type === 'submit');
      if (main) main.click();
    }
    return ev;
  }
  closest(tag: string): El | null { for (let n: El | null = this; n; n = n.parent) if (n.tagName === tag) return n; return null; }
  focus() { if (this.isConnected && !this.disabled) this.doc.focused = this; }
  select() { this.selected++; }
  // Tag names or single class names, comma separated: what the module and the shell's no-chat code ask for.
  querySelectorAll(sel: string) {
    const parts = sel.split(',').map(s => s.trim());
    return all(this).filter(e => parts.some(p => (p.startsWith('.') ? e.classList.contains(p.slice(1)) : e.tagName === p.toUpperCase())));
  }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
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
// A field's own message line (what its input is described by).
const errOf = (root: El, label: string) => { const input = control(root, label); const err = all(root).find(n => n.id && n.id === input.getAttribute('aria-describedby')); assert.ok(err, 'no message line for ' + label); return err!; };
const type = (input: El, value: string) => { input.value = value; input.dispatch('input'); };
const choose = (select: El, value: string) => { select.value = value; select.dispatch('change'); };
// The cats to choose from (item 44): named tiles in one radio group, each a cat (its radio named 「宪宪，布偶猫」) or
// 自定义 (data-own). faces() is the cats only, in the order shown; a face is found by its breed, as before.
const tiles = (root: El) => named(root, 'qc-face');
const faces = (root: El) => tiles(root).filter(f => f.dataset.face);
const breedOf = (f: El) => (f.getAttribute('aria-label') ?? '').split('，').pop()!;
const chosen = (root: El) => { const f = tiles(root).find(x => x.getAttribute('aria-checked') === 'true'); return f ? (f.dataset.face ? breedOf(f) : '自定义') : null; };
const face = (root: El, label: string) => { const f = faces(root).find(x => breedOf(x) === label); assert.ok(f, 'no face ' + label); return f!; };
const ownTile = (root: El) => { const f = tiles(root).find(x => x.dataset.own === 'true' && shown(x)); assert.ok(f, 'no 自定义 tile'); return f!; };
// 自定义's looks (a radio group of its own on the card): the one chosen, by breed, or null.
const looksChosen = (root: El) => named(root, 'qc-look').find(n => n.getAttribute('aria-checked') === 'true' && shown(n))?.getAttribute('aria-label') ?? null;
const visibleText = (root: El): string => root.hidden ? '' : root.kids.map(k => (k instanceof El ? visibleText(k) : k.textContent)).join('');
// What is on screen: the same, without what is there only for a screen reader (.qc-sr is visually hidden; item 45).
const seenText = (root: El): string => root.hidden || has(root, 'qc-sr') ? '' : root.kids.map(k => (k instanceof El ? seenText(k) : k.textContent)).join('');
// What the chosen cat's card says about the Agent it thinks with (items 44, 45): the mark as seen (the Agent's name and,
// when it is not usable here, one word for its state) and as said (a sentence); why it cannot come home as it is, and
// what can be done (said; on screen, a command and 重新检测).
const mark = (root: El) => { const m = one(root, 'qc-agent'); return shown(m) ? seenText(m) : ''; };
const markSaid = (root: El) => { const m = one(root, 'qc-agent'); return shown(m) ? visibleText(m) : ''; };
const toolSaid = (root: El) => ['qc-agent', 'qc-uses-line', 'qc-uses-more'].map(c => one(root, c)).filter(shown).map(visibleText).join('');
// The 新建 dialog's 猫猫 | 群聊 switch (item 43): a tab by its label, the panel shown.
const tabOf = (root: El, label: string) => { const t = all(root).find(n => n.getAttribute('role') === 'tab' && n.textContent === label); assert.ok(t, 'no tab ' + label); return t!; };
const shownPanel = (root: El) => all(root).filter(n => n.getAttribute('role') === 'tabpanel' && !n.hidden);
// Compare elements without letting a failure print a whole DOM (assert.equal would format both trees).
const same = (a: unknown, b: unknown, message: string) => assert.ok(a === b, message);

// ---------------------------------------------------------------- the page
// As app.js api() throws: the status, and the answer's `code` when it has one.
const fail = (status: number | undefined, message = 'request failed', code?: string) => Object.assign(new Error(message), status ? { status } : {}, code ? { code } : {});
const tool = (id: string, label: string, state: string, loginCommand: string) => ({ id, label, state, loginCommand });
// GET /xbot-api/start as the server itself builds it (startSummary) for a computer with these tools and the
// engine's real eight templates (tests/native-fixture.ts, read from the pinned upstream): the faces, what each
// one's cat is like and which tool it thinks with here. `edit` changes the engine's templates first (say, a
// portrait edited upstream), so the server computes its own `rev`.
type Status = 'configured' | 'login_required' | 'unknown' | 'not_installed';
const runtime = (id: string, label: string, clientId: string, status: Status, loginCommand: string) =>
  ({ id, label, clientId, installed: status !== 'not_installed', models: [], readiness: { status, checkedAt: 1, loginCommand } });
const computer = (codex: Status, claude: Status, kimi: Status = 'not_installed') =>
  [runtime('codex', 'Codex', 'openai', codex, 'codex login'), runtime('claude', 'Claude Code', 'anthropic', claude, 'claude auth login'), runtime('kimi', 'Kimi', 'kimi', kimi, 'kimi login')];
async function summary(runtimes: Any[], edit: (templates: Any[]) => Any[] = t => t): Promise<Any> {
  const templates = edit(catTemplates.map(([id, name, roleDescription, personality, teamStrengths, nickname]) => ({ id, name, nickname, roleDescription, personality, teamStrengths, color: { primary: '#888888', secondary: '#eeeeee' } })));
  const bridge: Any = { runtimes: async () => runtimes, cats: async () => [], templates: async () => ({ templates }), faceTemplates: async () => faceTemplates({ templates }) };
  return plain(await startSummary(bridge));
}
const START = {
  // Claude Code and Codex logged in (Codex is the usual tool): 布偶猫 and 缅因猫 can come home as they are.
  ready: await summary(computer('configured', 'configured')),
  // Codex installed, its login not confirmed; nothing else: only 缅因猫, and its login is said.
  unknown: await summary(computer('unknown', 'not_installed')),
  // Codex needs a login and nothing else is here: blocked (item 28).
  login: await summary(computer('login_required', 'not_installed')),
  none: await summary(computer('not_installed', 'not_installed')),
  // All three tools the app can connect: 布偶猫, 缅因猫 and 梵花猫.
  three: await summary(computer('configured', 'configured', 'configured')),
  // Claude Code here, Codex waiting for its login: 缅因猫 needs it.
  codexLogin: await summary(computer('login_required', 'configured')),
};
// The same computer as a server older than faces[] would describe it (no faces at all).
const bare = (start: Any) => { const { faces: _faces, ...rest } = start; return rest; };
type Call = { path: string; method: string; body?: Any };
function page(opts: { start?: Any; cats?: string[]; route?: (path: string, method: string, body: Any) => unknown; openCat?: (name: string) => unknown; onRefresh?: () => void; presets?: Any[] } = {}) {
  const doc = new Doc();
  const window: Any = { crypto: globalThis.crypto };
  const context = vm.createContext({ window, document: doc, setTimeout: () => 0, clearTimeout: () => {}, console });
  vm.runInContext(read('client/public/cat-avatars.js'), context);
  // A portrait library with other faces (more than eight, say), drawn by the real one.
  if (opts.presets) window.ClowderAvatars = { ...window.ClowderAvatars, presets: opts.presets };
  for (const file of ['client/public/quick-create-rules.js', 'client/public/quick-create.js']) vm.runInContext(read(file), context);
  const s = { start: opts.start ?? START.ready, cats: [...(opts.cats ?? [])] };
  const calls: Call[] = [], opened: string[] = [], groups: string[] = [], more: Any[] = [], copied: string[] = [], errors: string[] = [], notices: Any[] = [];
  let refreshed = 0, lists = 0;
  const api = async (path: string, opt: { method?: string; body?: unknown; serverError?: boolean } = {}) => {
    const call: Call = { path, method: opt.method || 'GET', ...(opt.body === undefined ? {} : { body: plain(opt.body) }) };
    calls.push(call);
    let custom;
    try { custom = opts.route ? await opts.route(path, call.method, call.body) : undefined; }
    catch (err: Any) {
      // As the shell's apiFetch does (checked against app.js below): a 5xx loses its words and its code unless the caller asks for them.
      if (err && err.status >= 500 && !opt.serverError) throw fail(err.status, '服务出了点问题，请稍后再试。');
      throw err;
    }
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
    refresh: async () => { refreshed++; opts.onRefresh?.(); },
    openCat: async (name: string) => { opened.push(name); if (opts.openCat) await opts.openCat(name); },
    // A created cat's notice, said by the shell once its chat is open (app.js quietNote).
    // A created cat's notice, held by the shell until that cat's chat opens (app.js holdNotice).
    notice: (held: Any) => { notices.push({ ...held, openedBefore: opened.length }); },
    openGroup: async (id: string) => { groups.push(id); },
    landing: () => null,
    more: (opener: unknown) => { more.push(opener); },
    showList: () => { lists++; },
    error: (e: Error) => { errors.push(e.message); },
    // The 新建 button as the sidebar has it now (renderLists redraws it).
    opener: () => live.opener,
  });
  // The shell paints a no-chat view into the history (app.js showNoChat).
  const thread = doc.createElement('div');
  doc.body.append(thread);
  const paint = (view: El) => { const inner = doc.createElement('div'); inner.className = 'thread-inner no-chat'; inner.append(view); thread.replaceChildren(inner); return view; };
  const opener = doc.createElement('button');
  doc.body.append(opener);
  const live: { opener: El | null } = { opener };
  return {
    doc, window, Q, R: window.ClowderQuickCreateRules, s, calls, opened, groups, more, copied, errors, notices, thread, paint, opener, live,
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

test('the face chosen for the owner is the first whose cat can come home as it is; a name comes from the template and stays free of taken names; a typed name is the owner\'s', () => {
  const { R, doc } = page();
  const presets = (vm.runInNewContext(read('client/public/cat-avatars.js') + ';window.ClowderAvatars.presets', { window: {}, document: doc }) as Any[]);
  const first = (start: Any) => { const s = R.start(start); return R.firstUsable(R.offer(s.faces, presets), s); };
  assert.equal(first(START.ready), 'ragdoll', 'Claude Code is here: 布偶猫, although Codex is the usual tool');
  assert.equal(first(START.unknown), 'maine-coon', 'only Codex (its login unconfirmed): 缅因猫');
  assert.equal(first({ ...START.three, faces: START.three.faces.slice(2) }), 'turkish-van', 'not simply the first face');
  assert.equal(first({ ...START.ready, faces: START.ready.faces.slice(2) }), null, 'none can: only 自定义 makes a cat');
  assert.equal(first(START.login), null, 'nothing can be made at all');
  assert.equal(first(bare(START.ready)), 'ragdoll', 'a server that names no tools is not second-guessed: the first');
  // The name: the template's own nickname (faces[].nickname), else the portrait library's.
  const offered = R.offer(R.start({ ...START.ready, faces: START.ready.faces.map((f: Any) => (f.id === 'maine-coon' ? { ...f, nickname: '小砚' } : f)) }).faces, presets);
  assert.equal(R.suggestName('maine-coon', offered, []), '小砚');
  assert.equal(R.suggestName('maine-coon', presets, []), '砚砚');
  assert.equal(R.suggestName('maine-coon', presets, ['砚砚', '砚砚 2']), '砚砚 3');
  assert.equal(R.suggestName('nobody', presets, []), '');
  // Whether the owner typed is never guessed from what the box holds (a typed name may equal a cat's own): no such rule.
  assert.equal(R.followsFace, undefined);
});

test('which tool a face\'s cat thinks with is read from faces[].tool as the server says it, and said as part of the cat', () => {
  const { R } = page();
  const tools = (start: Any) => R.start(start).faces.map((f: Any) => [f.id, f.tool.label, f.tool.state, f.tool.usable, f.tool.id, f.tool.reason]);
  assert.deepEqual(plain(tools(START.ready)), [
    ['ragdoll', 'Claude Code', 'ready', true, 'claude', ''], ['maine-coon', 'Codex', 'ready', true, 'codex', ''],
    ['siamese', 'Gemini', 'unsupported', false, '', '暂不支持 Gemini'], ['turkish-van', 'Kimi', 'missing', false, '', '这台电脑上还没有装 Kimi'],
    ['dsh', 'DSH', 'unsupported', false, '', '暂不支持 DSH'], ['dragon-li', 'OpenCode', 'unsupported', false, '', '暂不支持 OpenCode'],
    ['bengal', 'Antigravity', 'unsupported', false, '', '暂不支持 Antigravity'], ['golden-chinchilla', 'OpenCode', 'unsupported', false, '', '暂不支持 OpenCode'],
  ]);
  const maine = R.start(START.codexLogin).faces.find((f: Any) => f.id === 'maine-coon').tool;
  assert.deepEqual(plain(maine), { label: 'Codex', state: 'login', usable: false, id: '', reason: 'Codex 还没有登录', loginCommand: 'codex login' });
  assert.equal(R.start(START.unknown).faces.find((f: Any) => f.id === 'maine-coon').tool.state, 'unknown');
  // Read defensively: a tool without a name is none; usable only when the server says so; the reason keeps no stop and never goes missing.
  const read = (t: unknown) => R.start({ ...START.ready, faces: [{ id: 'dsh', tool: t }] }).faces[0].tool ?? null;
  assert.deepEqual(plain(read({ usable: true })), plain(R.UNREAD), 'in an answer of this shape, an unreadable tool is not known, never the usual one');
  assert.deepEqual(plain(read('Codex')), plain(R.UNREAD));
  assert.deepEqual(plain(read({ label: ' Pi ', usable: 'yes', state: 'ready', reason: '接不上。' })), { label: 'Pi', state: 'unsupported', usable: false, id: '', reason: '接不上', loginCommand: '' });
  assert.equal(read({ label: 'Pi', usable: false, state: 'missing' }).reason, 'Pi 现在用不了');
  assert.equal(read({ label: 'Codex', usable: true, state: 'login', id: 'codex' }).state, 'unknown', 'usable, so never a login; never called ready either');
  // What a screen reader hears: the tool that is here, or what it needs, why that is not here, and that it cannot be had now.
  assert.equal(R.uses(R.start(START.ready).faces[0].tool).text, '它用这台电脑上的 Claude Code 来思考');
  assert.equal(R.uses(R.start(START.ready).faces[2].tool).text, '它要用 Gemini 来思考。暂不支持 Gemini，现在领不了。');
  assert.equal(R.uses(R.start(START.ready).faces[3].tool).text, '它要用 Kimi 来思考。这台电脑上还没有装 Kimi，现在领不了。');
  for (const f of R.start(START.ready).faces) { const u = R.uses(f.tool); assert.ok(u.text.includes(u.label), f.id); }
  // A server that names no tools: the usual one, as such a server made every cat.
  const old = R.start(bare(START.unknown));
  assert.deepEqual(plain(R.toolOf(R.offer(old.faces, [{ id: 'dsh', label: '蓝灰短毛猫' }])[0], old)), { label: 'Codex', state: 'unknown', usable: true, id: 'codex', reason: '', loginCommand: 'codex login' });
  // The way on is one button, 自定义 (item 45; said 「用它的长相自定义」), which makes a cat of the owner's own with
  // these looks; its description names the one tool 自定义 would use, or says this computer's Agents.
  assert.equal(R.BORROW, '自定义');
  assert.equal(R.BORROW_SAID, '用它的长相自定义');
  assert.equal(R.forward(R.start(START.unknown)), '用这台电脑上的 Codex 来思考');
  assert.equal(R.forward(R.start(START.ready)), '用这台电脑上的 Agent 来思考');
  // Why, in the server's words, is said (the tile's description, 创建's); on screen the Agent mark carries one word true
  // to the state the server named (item 45): an Agent the app cannot connect (nothing to do here), one not installed,
  // one not logged in, one that could not be read; and, for one that can be used, a login that could not be checked.
  const [, , siamese, turkishVan] = R.start(START.ready).faces.map((f: Any) => f.tool);
  assert.equal(R.why(siamese), '暂不支持 Gemini，现在领不了。');
  assert.equal(R.why(R.start(START.ready).faces[0].tool), '', 'a usable tool needs no why');
  const unknownCodex = R.start(START.unknown).faces.find((f: Any) => f.id === 'maine-coon').tool;
  assert.deepEqual([siamese, turkishVan, maine, R.UNREAD, unknownCodex, R.start(START.ready).faces[0].tool, null].map(t => R.tag(t)), ['暂不支持', '未安装', '未登录', '未知', '未确认登录', '', '']);
  // Never that installing would help an Agent the app cannot connect: it has no help at all; one not installed is installed, then 重新检测.
  assert.equal(R.toolHelp(siamese), null);
  assert.equal(R.toolHelp(turkishVan).text, '装好 Kimi 并登录后再重新检测');
  assert.equal(R.loginHelp('codex login'), '在终端里运行这行命令登录，再重新检测');
  assert.equal(R.loginHelp(''), '登录后再重新检测');
  // Agent is what these programs are called since 2026-11-12 (docs/xbot-frontend.md item 42); the engine's words are not.
  for (const words of [R.uses(maine).text, R.forward(R.start(START.ready)), R.loginHelp(''), R.why(maine), ...Object.values(R.TAGS) as string[], R.BORROW_SAID, R.OWN_NOTE, R.ABOUT_ASK, R.PERSONALITY_ASK, R.NAME_PLACEHOLDER]) assert.doesNotMatch(words, /Bot|模型|模板/);
  // The words the owner found too machine-made (2026-11-13) are gone from the rules (item 45). 可不填 is only ever said:
  // the two descriptions a screen reader hears on the optional boxes (review r14), never shown.
  for (const file of ['client/public/quick-create-rules.js', 'client/public/quick-create.js']) assert.doesNotMatch(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /现在就能领|按原样领不了|接不上|只借它的长相|你自己的猫猫|比如：/, file);
  assert.deepEqual([R.OPTIONAL_SAID, R.GROUP_NAME_SAID], ['可不填', '可不填，不填就用成员的名字']);
  assert.equal((readFileSync(new URL('../client/public/quick-create-rules.js', import.meta.url), 'utf8').match(/可不填/g) || []).length, 2, 'the two constants');
  assert.equal((readFileSync(new URL('../client/public/quick-create.js', import.meta.url), 'utf8').match(/可不填/g) || []).length, 0);
  // 重新检测 notices a face's tool changing, even when the tools the app can connect did not.
  const loggedOut = { ...START.ready, faces: START.ready.faces.map((f: Any) => (f.id === 'ragdoll' ? { ...f, tool: { label: 'Claude Code', state: 'login', usable: false, reason: 'Claude Code 还没有登录' } } : f)) };
  assert.equal(R.sameStart(R.start(START.ready), R.start(plain(START.ready))), true);
  assert.equal(R.sameStart(R.start(START.ready), R.start(loggedOut)), false);
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
  // Why and what to do, without pointing at 重新检测: the button is right under the words (item 45).
  assert.equal(login.body, '猫猫要借这台电脑上的 Codex 来思考，可它还没登录。');
  assert.equal(login.run, '在终端里运行下面这行：', 'said before the commands; on screen each chip\'s terminal mark says it');
  assert.equal(both.run, '在终端里运行其中一行：');
  assert.equal(none.run ?? '', '', 'nothing to run');
  assert.equal(none.body, '猫猫要借这台电脑上的 Claude Code 或 Codex 来思考，装好其中一个并登录。');
  for (const copy of [login, both, none]) assert.doesNotMatch(copy.body, /重新检测/);
  assert.equal(R.sameStart(R.start(START.login), R.start(plain(START.login))), true);
  assert.equal(R.sameStart(R.start(START.login), R.start(START.none)), false);
});

test('a face\'s own cat sends no tool (it has its own), 自定义 sends the tool shown, only what was filled is sent; a 409 is the name, a 422 blocks, no answer is unsure', () => {
  const { R } = page();
  const body = plain(R.catBody({ name: ' 小白 ', face: 'bengal', agent: 'claude', about: '  ' }));
  assert.deepEqual(body, { name: '小白', simple: { face: 'bengal' } }, 'which tool is part of the face; another one would be refused (face_tool)');
  // The owner's own words go only with 自定义 (they would silently make the cat custom on the server), and so does a tool.
  assert.equal(plain(R.catBody({ name: 'a', face: 'dsh', agent: 'codex', about: ' 帮我改简历 ' })).simple.about, undefined);
  assert.deepEqual(plain(R.catBody({ name: 'a', face: 'dsh', agent: 'codex', custom: true, about: ' 帮我改简历 ' })).simple, { face: 'dsh', custom: true, about: '帮我改简历', agent: 'codex' });
  const custom = plain(R.catBody({ name: ' 小白 ', face: 'bengal', agent: 'claude', custom: true }));
  assert.equal(R.fingerprint(custom), R.fingerprint({ simple: { agent: 'claude', custom: true, face: 'bengal' }, name: '小白' }), 'key order does not make a new request');
  assert.notEqual(R.fingerprint(custom), R.fingerprint(R.catBody({ name: '小白', face: 'bengal', agent: 'codex', custom: true })), 'another tool is another request');
  assert.deepEqual(plain(R.catError(fail(409, '已经有一只叫这个名字的猫猫了', 'name_taken'), '小白')), { kind: 'name', text: '已经有一只叫「小白」的猫猫了，换个名字吧' });
  assert.equal(R.catError(fail(422, '请先在本机 Agent 中完成登录'), '小白', 'Codex').text, '刚才没能建好：Codex 现在用不了。', 'a 422 without a code blocks every tool and says which one');
  assert.equal(R.catError(fail(422, '请先在本机 Agent 中完成登录')).text, '刚才没能建好：这个 Agent 现在用不了。', 'no tool named: the Agent');
  // A server sentence naming an Agent is said as it is (since 2026-11-12); one naming a Bot or a model is not.
  assert.equal(R.catError(fail(409, '这个 Agent 刚被换掉了，请重新选择。')).text, '这个 Agent 刚被换掉了，请重新选择。');
  assert.equal(R.catError(fail(409, '这个 Bot 的模型刚被换掉了')).text, '没能建好，请稍后再试。');
  assert.equal(R.startError(fail(503, '暂时读不到这台电脑上的 Agent')), '暂时读不到这台电脑上的 Agent');
  assert.equal(R.startError(fail(503, '原生 Bot 列表读不到')), '没能读取这台电脑的情况');
  for (const err of [fail(undefined, '连不上 clowder-bot'), fail(502, '服务出了点问题，请稍后再试。')]) assert.equal(R.catError(err, 'x').kind, 'unsure');
  assert.equal(R.catError(fail(400, 'name: 找不到这个 Bot')).text, '没能建好，请检查名字后再试。');
  assert.equal(R.groupError(fail(undefined)).kind, 'unsure');
  assert.equal(R.groupError(fail(404, '找不到这个 Bot')).text, '有只猫猫找不到了，刷新列表后再试。');
  assert.equal(R.groupError(fail(400, '成员不能重复')).text, '成员不能重复', 'an everyday server sentence is kept');
  assert.equal(R.startError(fail(undefined, '连不上 clowder-bot')), '连不上 clowder-bot', 'the product name is not jargon');
});

// ---------------------------------------------------------------- the stage
test('the first screen: eight faces with the first that can come home chosen, its nickname as the name, its tool said as part of it with nothing to pick, no focus taken, and the composer hidden', async () => {
  const p = page();
  const stage = await p.stage();
  assert.equal(faces(stage).length, 8);
  assert.equal(chosen(stage), '布偶猫', 'Claude Code is here, so 布偶猫 (not the usual tool\'s face)');
  const name = control(stage, '名字');
  assert.equal(name.value, '宪宪');
  assert.equal(p.doc.activeElement, p.doc.body, 'the cats come first; a phone keeps its keyboard down');
  // Which tool it thinks with is a mark on its card, not a control (its sentence for a screen reader): no select anywhere.
  assert.equal(markSaid(stage), '它用这台电脑上的 Claude Code 来思考');
  assert.equal(mark(stage), 'Claude Code', 'on screen, the Agent\'s name and nothing around it (item 45)');
  assert.equal(all(stage).filter(n => n.tagName === 'SELECT' && shown(n)).length, 0);
  assert.equal(shown(one(stage, 'qc-tool')), false, '自定义\'s tool row is not shown for a face\'s own cat');
  assert.equal(shown(one(stage, 'qc-uses-more')), false, 'a confirmed login needs no note');
  assert.equal(shown(one(stage, 'qc-uses-line')), false, 'nothing in the way: no reason line');
  assert.equal(button(stage, '带它回家').disabled, false);
  // One radio group, one tab stop: the cats and 自定义 alike.
  assert.equal(one(stage, 'qc-faces').getAttribute('role'), 'radiogroup');
  assert.deepEqual(tiles(stage).filter(shown).map(f => f.tabIndex), [0, -1, -1, -1, -1, -1, -1, -1, -1]);
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
  assert.equal(p.doc.activeElement.getAttribute('aria-label'), '砚砚，缅因猫', 'focus moves with the choice; the radio says the name it comes with and its breed');
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

test('a face\'s own cat goes with its own tool: the body carries the face and the portrait shown, never a tool, and the chat opens with the server\'s name', async () => {
  const p = page();
  const stage = await p.stage();
  face(stage, '缅因猫').click();
  assert.equal(markSaid(stage), '它用这台电脑上的 Codex 来思考');
  assert.equal(control(stage, '名字').value, '砚砚');
  button(stage, '带它回家').click();
  await settle();
  const [post] = p.posts();
  assert.deepEqual(Object.keys(post.body).sort(), ['idempotencyKey', 'name', 'simple']);
  assert.match(post.body.idempotencyKey, UUID);
  assert.deepEqual(post.body.simple, { face: 'maine-coon', rev: START.ready.faces[1].rev });
  assert.deepEqual(p.opened, ['砚砚']);
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
  answer = () => { throw fail(409, '已经有一只叫这个名字的猫猫了', 'name_taken'); };
  go.click();
  await settle();
  const third = p.posts()[2];
  assert.notEqual(third.body.idempotencyKey, first.body.idempotencyKey, 'a different body is a new request');
  const name = control(stage, '名字');
  assert.equal(name.getAttribute('aria-invalid'), 'true');
  assert.equal(errOf(stage, '名字').textContent, '已经有一只叫「团子」的猫猫了，换个名字吧');
  assert.equal(p.doc.activeElement, name);
  assert.deepEqual(p.opened, []);
  // The owner's own fix goes through.
  type(name, '团子二号');
  assert.equal(errOf(stage, '名字').textContent, '', 'typing clears the message');
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
  assert.equal(errOf(stage, '名字').textContent, '名字只能用文字、数字、空格和 _ . -');
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
  assert.equal(visibleText(one(need, 'qc-note')), '刚才没能建好：Claude Code 现在用不了。');
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
  assert.equal(chosen(stage), '布偶猫');
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

test('a login that could not be checked is said under the cat\'s tool, with the command, and the cat can still be made', async () => {
  const p = page({ start: START.unknown });
  const stage = await p.stage();
  assert.equal(chosen(stage), '缅因猫', 'the one cat whose tool is here');
  assert.equal(mark(stage), 'Codex未确认登录', 'the mark carries the state in one word');
  assert.equal(markSaid(stage), '它用这台电脑上的 Codex 来思考，未确认登录');
  assert.match(visibleText(one(stage, 'qc-uses-more')), /^没能确认 Codex 已经登录。还没登录的话，先在终端里运行：codex login复制$/);
  assert.equal(seenText(one(stage, 'qc-uses-more')), 'codex login复制', 'on screen, the command alone: the sentence is said');
  button(stage, '带它回家').click();
  await settle();
  assert.deepEqual(p.posts()[0].body.simple, { face: 'maine-coon', rev: START.unknown.faces[1].rev });
  // 自定义's row says the same about the tool it would use.
  const q = page({ start: START.unknown });
  const own = await q.stage();
  ownTile(own).click();
  assert.equal(visibleText(one(own, 'qc-tool-line')), '它会用这台电脑上的 Codex 来思考，未确认登录');
  assert.equal(seenText(one(own, 'qc-tool-line')), 'Codex未确认登录', 'on screen, the same mark as a cat\'s');
  assert.match(visibleText(one(own, 'qc-tool-note')), /^没能确认 Codex 已经登录/);
  assert.equal(seenText(one(own, 'qc-tool-note')), 'codex login复制');
});

test('made but not opened: the stage says the cat is there and opens its chat on request', async () => {
  let refuse = true;
  const p = page({ openCat: () => { if (refuse) throw fail(undefined, '连不上 clowder-bot'); } });
  const stage = await p.stage();
  button(stage, '带它回家').click();
  await settle();
  assert.equal(stage.classList.contains('leaving'), false);
  assert.match(visibleText(stage), /「宪宪」已经到家了，只是没能打开聊天。/);
  assert.equal(shown(one(stage, 'qc-fields')), false, 'no second creation');
  refuse = false;
  button(stage, '打开聊天').click();
  await settle();
  assert.deepEqual(p.opened, ['宪宪', '宪宪']);
  assert.equal(p.posts().length, 1);
});

test('a created cat\'s notice is handed to the shell by the cat\'s identity, whether or not its chat opens (first run, 新建猫猫, a failed open)', async () => {
  const NOTICE = '猫猫建好了，但有一项默认设置没写进去：在对话里让它设提醒可能不生效。';
  const withNotice = (path: string, method: string, body: Any) => (path === '/xbot-api/bots' && method === 'POST' ? { name: body.name, native_id: 'bot-new', notice: '  ' + NOTICE + '\n' } : undefined);
  const held = (n: Any) => ({ name: n.name, nativeId: n.nativeId, text: n.text });
  // First run: held (trimmed, with the native ID) as soon as the cat exists, before its chat opens.
  const p = page({ route: withNotice });
  button(await p.stage(), '带它回家').click();
  await settle();
  assert.deepEqual(p.opened, ['宪宪']);
  assert.deepEqual(p.notices.map(held), [{ name: '宪宪', nativeId: 'bot-new', text: NOTICE }]);
  assert.equal(p.notices[0].openedBefore, 0, 'handed over before the open: the shell says it when the chat is open');
  // 新建猫猫's dialog whose open fails: the dialog is gone, but the notice is held all the same.
  const q = page({ cats: ['团子'], route: withNotice, openCat: () => { throw fail(undefined, '连不上 clowder-bot'); } });
  q.Q.openCat({ opener: q.opener });
  await settle();
  button(q.layer()!, '创建').click();
  await settle();
  assert.equal(q.layer(), null, 'the dialog closed');
  assert.deepEqual(q.errors, ['连不上 clowder-bot']);
  assert.deepEqual(q.notices.map(held), [{ name: '宪宪', nativeId: 'bot-new', text: NOTICE }]);
  // The stage's 打开聊天 after a failed open hands it over once, not again.
  let refuse = true;
  const r = page({ route: withNotice, openCat: () => { if (refuse) throw fail(undefined, '连不上 clowder-bot'); } });
  const stage = await r.stage();
  button(stage, '带它回家').click();
  await settle();
  refuse = false;
  button(stage, '打开聊天').click();
  await settle();
  assert.equal(r.notices.length, 1);
  // No notice: nothing is held.
  const s = page();
  button(await s.stage(), '带它回家').click();
  await settle();
  assert.deepEqual(s.notices, []);
  assert.equal(s.R.createdNotice({ notice: 42 }), '');
  assert.equal(s.R.createdNotice(null), '');
});

test('the shell says a held notice once, when that cat\'s chat is actually open, however it opens', () => {
  const app = read('client/public/app.js');
  const take = (name: string) => {
    const m = new RegExp(`\\n {2}(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
    assert.ok(m, name);
    return m[0];
  };
  const said: string[] = [];
  const out: Any = {};
  const bots: Any[] = [];
  vm.runInNewContext('const heldNotices = new Map();' + take('holdNotice') + take('sayHeldNotice') + 'out.hold = holdNotice; out.say = sayHeldNotice;', {
    out, Map, String, botCatId: (name: string) => (bots.find(b => b.name === name) || {}).native_id || '', quietNote: (t: string) => said.push(t),
  });
  out.hold({ name: '砚砚', nativeId: 'bot-new', text: '有一项默认设置没写进去。' });
  out.say('团子');
  assert.deepEqual(said, [], 'another cat');
  out.say('砚砚');
  assert.deepEqual(said, [], 'not yet in the list: its identity is not known under that name');
  bots.push({ name: '砚砚', native_id: 'bot-new' });
  out.say('砚砚');
  assert.deepEqual(said, ['有一项默认设置没写进去。']);
  out.say('砚砚');
  assert.equal(said.length, 1, 'once');
  // Without a native ID it is held by name.
  out.hold({ name: '年糕', nativeId: '', text: '另一句。' });
  out.say('年糕');
  assert.deepEqual(said.at(-1), '另一句。');
  // Wiring: selectBot says it after the chat is drawn; both creation paths hold, neither says it directly.
  assert.match(take('selectBot'), /await loadThread\(\);\n\s+\/\/[^\n]*\n\s+if \(state\.sel === selection\) sayHeldNotice\(name\);/);
  assert.match(app, /notice: \(held\) => holdNotice\(held\),/);
  assert.match(app, /if \(created\.notice\) holdNotice\(\{ name: created\.name, nativeId: created\.native_id \|\| "", text: created\.notice \}\);\n\s+await refreshLists\(\);/);
  assert.doesNotMatch(app, /quietNote\(created\.notice\)/);
});

test('the no-chat line is the next step and the way to the list (item 46: no sentence repeating the heading), and opens the list', () => {
  const p = page({ cats: ['团子'] });
  const view = p.paint(p.Q.noChat());
  assert.equal(visibleText(view), '选一个聊天打开列表');
  assert.doesNotMatch(visibleText(view), /左边|Bot/);
  button(view, '打开列表').click();
  assert.equal(p.lists, 1);
});

// ---------------------------------------------------------------- 新建猫猫
test('新建猫猫: a small dialog starting in a free name; Escape closes back to the opener; Tab stays inside; a taken name never leaves', async () => {
  const p = page({ cats: ['团子', '宪宪'] });
  p.opener.focus();
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  const name = control(card, '名字');
  assert.equal(name.value, '宪宪 2', '宪宪 is taken');
  assert.equal(p.doc.activeElement, name);
  assert.equal(name.selected, 1, 'typing replaces the suggestion');
  assert.equal(button(card, '取消').tabIndex, 0);
  // Tab from the last control wraps to the first: the selected side of the 猫猫 | 群聊 switch (item 43).
  const go = button(card, '创建');
  go.focus();
  go.key('Tab');
  same(p.doc.activeElement, tabOf(card, '猫猫'), 'Tab wraps to the selected tab');
  type(name, 'TUANZI');
  p.s.cats.push('tuanzi');
  card.dispatch('submit');
  await settle();
  assert.match(errOf(card, '名字').textContent, /已经有一只叫「TUANZI」的猫猫了/);
  assert.equal(p.posts().length, 0);
  name.key('Escape');
  assert.equal(p.layer(), null);
  assert.equal(p.doc.activeElement, p.opener);
});

test('新建猫猫 sends the face, the name, and with 自定义 the optional line and the tool; it cannot be closed mid-request; 更多设置 hands over to the template creator', async () => {
  let release: () => void = () => {};
  const p = page({ cats: ['团子'], route: (path, method) => (path === '/xbot-api/bots' && method === 'POST' ? new Promise(done => { release = () => done({ name: '小白', native_id: 'bot-1' }); }) : undefined) });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  face(card, '金渐层').click();
  type(control(card, '名字'), '小白');
  // The optional line belongs to 自定义 now (2026-11-12): a face's own cat does not offer it.
  ownTile(card).click();
  type(control(card, '它主要帮你做什么'), '  帮我改简历 ');
  control(card, '名字').key('Enter'); // Enter in a field presses 创建
  card.dispatch('submit'); // a second press while saving does nothing
  await settle();
  assert.equal(p.posts().length, 1);
  assert.deepEqual({ ...p.posts()[0].body, idempotencyKey: 'k' }, { name: '小白', simple: { face: 'golden-chinchilla', custom: true, about: '帮我改简历', agent: 'codex' }, idempotencyKey: 'k' });
  assert.equal(button(card, '正在创建…').disabled, true);
  assert.equal(ownTile(card).disabled, true, 'the mode cannot change mid-request');
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
test('新建群聊 with fewer than two cats says a group needs two and offers to add a cat: 新建猫猫 turns the same dialog to its cat side', async () => {
  const p = page({ cats: ['团子'] });
  p.Q.openGroup({ opener: p.opener });
  const card = one(p.layer()!, 'qc-card');
  assert.equal(visibleText(one(card, 'qc-lead')), '群聊至少要两只猫猫，现在只有 1 只。');
  same(p.doc.activeElement, button(card, '新建猫猫'), 'focus on the way forward');
  assert.equal(p.calls.length, 0, 'the cat side is not read before it is shown');
  button(card, '新建猫猫').click();
  await settle();
  same(one(p.layer()!, 'qc-card'), card, 'the same dialog');
  assert.equal(p.doc.body.children.filter(n => has(n, 'qc-modal')).length, 1);
  assert.equal(tabOf(card, '猫猫').getAttribute('aria-selected'), 'true');
  assert.equal(tabOf(card, '群聊').getAttribute('aria-selected'), 'false');
  assert.equal(shownPanel(card).length, 1);
  assert.ok(named(shownPanel(card)[0], 'qc-faces').length, 'the cat side is shown');
  same(p.doc.activeElement, control(card, '名字'), 'focus goes into it, to the name once it is read');
  assert.equal(all(card).find(n => has(n, 'qc-sr') && n.getAttribute('role') === 'status' && n.textContent === '新建猫猫') ? 'said' : '', 'said', 'the change is announced');
  // Back on 群聊, the way forward is still there.
  tabOf(card, '群聊').click();
  assert.equal(visibleText(one(card, 'qc-lead')), '群聊至少要两只猫猫，现在只有 1 只。');
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
  // Under the chips, only what they cannot show (item 45): how many more 创建 needs, or that the group is full. 成员 and
  // the name's default are not captions: the legend is said, and the name the group would get stands in its field.
  assert.equal(hint.textContent, '至少选 2 只');
  assert.equal(shown(hint), true);
  assert.equal(has(all(card).find(n => n.tagName === 'LEGEND')!, 'qc-sr'), true, '成员 is said, not shown');
  assert.equal(name.placeholder, '', 'nothing about the name until two are picked');
  assert.equal(seenText(card).includes('可不填'), false);
  pick(2);
  assert.equal(hint.textContent, '再选 1 只');
  assert.equal(go.disabled, true);
  pick(0);
  assert.equal(go.disabled, false);
  assert.equal(shown(hint), false, 'enough, and room for more: nothing to say');
  assert.equal(name.placeholder, '猫3、猫1', 'the order picked');
  for (let i = 3; i < 11; i++) pick(i);
  assert.equal(hint.textContent, '最多 10 只');
  assert.equal(shown(hint), true);
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
  assert.equal(p.calls.length, 1);
  const { idempotencyKey, ...body } = p.calls[0].body;
  assert.deepEqual(body, { members: ['猫3', '猫1', '猫4', '猫5', '猫6', '猫7', '猫8', '猫9', '猫10', '猫2'] }, 'no name: the server names it after its members');
  assert.match(idempotencyKey, UUID);
  assert.equal(p.layer(), null);
  assert.deepEqual(p.groups, ['thread-G']);
});

test('新建群聊: an unsure answer keeps the dialog and is resent unchanged under the same key; other members, another order or a name make a new request', async () => {
  let answer: (() => unknown) | null = () => { throw fail(undefined, '连不上 clowder-bot'); };
  const p = page({ cats: ['团子', '栗子', '年糕'], route: (path, method) => (path === '/xbot-api/groups' && method === 'POST' && answer ? answer() : undefined) });
  p.Q.openGroup({ opener: p.opener });
  const card = one(p.layer()!, 'qc-card');
  const boxes = all(card).filter(n => n.type === 'checkbox');
  const pick = (i: number, on = true) => { boxes[i].checked = on; boxes[i].dispatch('change'); };
  pick(0); pick(1);
  type(control(card, '群名'), ' 晨会 ');
  card.dispatch('submit');
  await settle();
  assert.ok(p.layer());
  assert.equal(visibleText(one(card, 'qc-error')), '没能确认群聊建好没有。不改内容再点一次就好，不会多出一个群。');
  assert.equal(p.refreshed, 1);
  card.dispatch('submit');
  await settle();
  const keys = () => p.calls.map(c => c.body.idempotencyKey);
  assert.deepEqual(p.calls[1].body, p.calls[0].body, 'the same members, order and name: the same request');
  assert.deepEqual({ ...p.calls[0].body, idempotencyKey: 'k' }, { members: ['团子', '栗子'], name: '晨会', idempotencyKey: 'k' });
  // Another order is another group face and title: a new request.
  pick(0, false); pick(0);
  card.dispatch('submit');
  await settle();
  assert.deepEqual(p.calls[2].body.members, ['栗子', '团子']);
  assert.notEqual(keys()[2], keys()[0]);
  type(control(card, '群名'), '');
  card.dispatch('submit');
  await settle();
  assert.notEqual(keys()[3], keys()[2], 'without the name it is another request');
  pick(2);
  answer = null;
  card.dispatch('submit');
  await settle();
  assert.notEqual(keys()[4], keys()[3], 'another member: another request');
  assert.deepEqual(p.calls[4].body.members, ['栗子', '团子', '年糕']);
  assert.equal(p.layer(), null);
  assert.deepEqual(p.groups, ['thread-G']);
});

// ---------------------------------------------------------------- one 新建 dialog (item 43)
test('新建 is one dialog titled 新建 with a 猫猫 | 群聊 tab list: 猫猫 first and selected, each tab controls its panel, one Tab stop', async () => {
  const p = page({ cats: ['团子', '栗子'] });
  p.opener.focus();
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  const title = all(card).find(n => n.id === card.getAttribute('aria-labelledby'));
  assert.equal(title?.textContent, '新建', 'the title does not fight the switch');
  const list = all(card).find(n => n.getAttribute('role') === 'tablist');
  assert.ok(list && list.getAttribute('aria-label'), 'a named tab list');
  const tabs = all(list!).filter(n => n.getAttribute('role') === 'tab');
  assert.deepEqual(tabs.map(t => t.textContent), ['猫猫', '群聊']);
  assert.deepEqual(tabs.map(t => t.getAttribute('aria-selected')), ['true', 'false']);
  assert.deepEqual(tabs.map(t => t.tabIndex), [0, -1], 'the selected tab is the one Tab stop');
  for (const t of tabs) {
    const panel = all(card).find(n => n.id === t.getAttribute('aria-controls'));
    assert.equal(panel?.getAttribute('role'), 'tabpanel');
    assert.equal(panel?.getAttribute('aria-labelledby'), t.id);
  }
  assert.equal(shownPanel(card).length, 1);
  same(p.doc.activeElement, control(card, '名字'), 'the cat side starts in the name, as before');
  // The group side is not built (nor anything sent for it) until it is shown; ⌘K's 新建群聊 opens on it, with nothing read for the cat side.
  assert.equal(named(card, 'qc-chip').length, 0);
  const q = page({ cats: ['团子', '栗子'] });
  q.Q.openGroup({ opener: q.opener });
  await settle();
  const group = one(q.layer()!, 'qc-card');
  assert.equal(tabOf(group, '群聊').getAttribute('aria-selected'), 'true');
  assert.equal(q.calls.length, 0, 'no /start read for the side not shown');
  same(q.doc.activeElement, all(group).find(n => n.type === 'checkbox'), 'the group side starts on its first cat');
});

test('the switch: a click or ← → Home End turn the dialog to the other side and keep focus on the tab; each side keeps what was typed and picked', async () => {
  const p = page({ cats: ['团子', '栗子', '年糕'] });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  face(card, '暹罗猫').click();
  type(control(card, '名字'), '小白');
  ownTile(card).click();
  type(control(card, '它主要帮你做什么'), '改简历');
  const cat = tabOf(card, '猫猫'), group = tabOf(card, '群聊');
  cat.focus();
  cat.key('ArrowRight');
  assert.equal(group.getAttribute('aria-selected'), 'true');
  same(p.doc.activeElement, group, 'focus moves with the selection');
  assert.deepEqual([cat.tabIndex, group.tabIndex], [-1, 0]);
  assert.equal(field(card, '名字'), false, 'the cat side is hidden');
  const boxes = () => all(card).filter(n => n.type === 'checkbox');
  const pick = (i: number) => { boxes()[i].checked = true; boxes()[i].dispatch('change'); };
  pick(2); pick(0);
  type(control(card, '群名'), '晨会');
  group.key('ArrowLeft');
  same(p.doc.activeElement, cat, 'back to 猫猫, focus on its tab');
  assert.equal(chosen(card), '自定义', '自定义 stays chosen');
  assert.equal(looksChosen(card), '暹罗猫', 'with the looks it took from the cat picked before');
  assert.equal(control(card, '名字').value, '小白', 'the name typed stays');
  assert.equal(control(card, '它主要帮你做什么').value, '改简历', '自定义 and its line stay');
  assert.equal(p.calls.filter(c => c.path.startsWith('/xbot-api/start')).length, 1, 'the cat side is read once, not again on return');
  cat.key('End');
  assert.equal(group.getAttribute('aria-selected'), 'true');
  assert.deepEqual(boxes().filter(b => b.checked).map(b => b.value), ['团子', '年糕']);
  assert.equal(control(card, '群名').value, '晨会');
  assert.equal(control(card, '群名').placeholder, '年糕、团子', 'still in the order picked');
  group.key('Home');
  assert.equal(cat.getAttribute('aria-selected'), 'true');
  group.click();
  assert.equal(group.getAttribute('aria-selected'), 'true', 'a click turns it too');
  // Enter in the group's name sends the group (each side is its own form), never the cat.
  control(card, '群名').key('Enter');
  await settle();
  assert.deepEqual(p.calls.filter(c => c.method === 'POST').map(c => c.path), ['/xbot-api/groups']);
  assert.deepEqual({ ...p.calls.at(-1)!.body, idempotencyKey: 'k' }, { members: ['年糕', '团子'], name: '晨会', idempotencyKey: 'k' });
  assert.equal(p.layer(), null);
  same(p.doc.activeElement, p.opener, 'focus back on the 新建 it was opened from');
});

test('the switch does not move while a request is on its way, and a cat side read late does not take focus from the switch', async () => {
  let release: () => void = () => {};
  const p = page({ cats: ['团子', '栗子'], route: (path, method) => (path === '/xbot-api/groups' && method === 'POST' ? new Promise(done => { release = () => done({ id: 'g-1' }); }) : undefined) });
  p.Q.openGroup({ opener: p.opener });
  const card = one(p.layer()!, 'qc-card');
  const boxes = all(card).filter(n => n.type === 'checkbox');
  for (const b of boxes) { b.checked = true; b.dispatch('change'); }
  card.dispatch('submit');
  await settle();
  const cat = tabOf(card, '猫猫');
  assert.equal(cat.getAttribute('aria-disabled'), 'true');
  cat.click();
  assert.equal(cat.getAttribute('aria-selected'), 'false', 'not while the group is being made');
  release();
  await settle();
  assert.equal(p.layer(), null);
  assert.deepEqual(p.groups, ['g-1']);
  // The cat side's /start answers after the owner went back to the switch: focus stays on the tab.
  let answer: (v: unknown) => void = () => {};
  const q = page({ cats: ['团子', '栗子'], route: (path) => (path.startsWith('/xbot-api/start') ? new Promise(done => { answer = done; }) : undefined) });
  q.Q.openGroup({ opener: q.opener });
  const qc = one(q.layer()!, 'qc-card');
  tabOf(qc, '猫猫').click();
  same(q.doc.activeElement, tabOf(qc, '猫猫'), 'on the tab');
  answer(START.ready);
  await settle();
  assert.ok(field(qc, '名字'), 'the cat side is ready');
  same(q.doc.activeElement, tabOf(qc, '猫猫'), 'still on the tab: the late answer does not move focus');
});

test('switching sides eases a change of the card\'s height (its top edge stays) and fades the side in; at once under reduced motion', async () => {
  const p = page({ cats: ['团子', '栗子'] });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  const eased: Any[] = [], faded: Any[] = [];
  card.animate = (frames: Any, options: Any) => { eased.push({ frames, options }); return { finished: Promise.resolve() }; };
  const heights = (...values: number[]) => { card.getBoundingClientRect = () => ({ left: 0, top: 120, width: 480, height: values.shift() ?? 0 }); };
  for (const panel of all(card).filter(n => n.getAttribute('role') === 'tabpanel')) panel.animate = (frames: Any) => { faded.push(frames); return { finished: Promise.resolve() }; };
  heights(430, 360);
  tabOf(card, '群聊').click();
  assert.deepEqual(plain(eased), [{ frames: [{ height: '430px' }, { height: '360px' }], options: { duration: 180, easing: 'ease-out' } }]);
  assert.deepEqual(plain(faded), [[{ opacity: 0 }, { opacity: 1 }]]);
  await settle();
  assert.equal(has(card, 'qc-easing'), false, 'clipped only while it eases');
  // Switched again mid-way: the running easing stops, the next starts from the height on screen, and the clip stays until the last one ends.
  const running: Any[] = [];
  card.animate = (frames: Any) => {
    let end: () => void = () => {};
    const a: Any = { frames, cancelled: false, finished: new Promise<void>((done) => { end = done; }) };
    a.end = end; a.cancel = () => { a.cancelled = true; end(); };
    running.push(a);
    return a;
  };
  heights(365, 430);
  tabOf(card, '猫猫').click();
  heights(400, 365);
  tabOf(card, '群聊').click();
  assert.deepEqual(plain(running.map(a => a.frames)), [[{ height: '365px' }, { height: '430px' }], [{ height: '400px' }, { height: '365px' }]]);
  assert.equal(running[0].cancelled, true);
  await settle();
  assert.equal(has(card, 'qc-easing'), true, 'the first one\'s end does not lift the clip of the second');
  running[1].end();
  await settle();
  assert.equal(has(card, 'qc-easing'), false);
  p.window.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  const counts = [eased.length + running.length, faded.length];
  heights(360, 430);
  tabOf(card, '猫猫').click();
  assert.deepEqual([eased.length + running.length, faded.length], counts, 'no easing and no fade under reduced motion');
  assert.equal(tabOf(card, '猫猫').getAttribute('aria-selected'), 'true');
  // The dialog hangs from a fixed line, so neither side nor 自定义 moves its top edge.
  const css = read('client/public/quick-create.css');
  assert.match(css, /\.qc-modal \{ --qc-top: max\(16px, calc\(\(100vh - 600px\) \/ 2\)\); place-items: start center; padding-top: var\(--qc-top\); \}/);
  assert.match(css, /\.qc-card\.qc-easing \{ overflow: hidden; \}/);
  assert.match(css, /\.qc-tab\[aria-selected="true"\] \{ background: var\(--selected\); color: var\(--x-text\); \}/);
});

// ---------------------------------------------------------------- review fixes (2026-11-11)
test('a cat whose answer was lost can be sent again unchanged after the list has learned its name: the same key reaches the server', async () => {
  const made: string[] = [];
  let lose = true;
  const p = page({
    route: (path, method, body) => {
      if (path !== '/xbot-api/bots' || method !== 'POST') return undefined;
      if (!made.includes(body.name)) made.push(body.name); // the server made it…
      if (lose) { lose = false; throw fail(undefined, '连不上 clowder-bot'); } // …but the answer was lost
      return { name: body.name, native_id: 'bot-1' };
    },
    onRefresh: () => { p.s.cats.splice(0, Infinity, ...made); },
  });
  const stage = await p.stage();
  const go = button(stage, '带它回家');
  go.click();
  await settle();
  assert.deepEqual(p.s.cats, ['宪宪'], 'the refreshed list knows the cat');
  go.click();
  await settle();
  const [first, second] = p.posts();
  assert.ok(second, 'the retry reaches the server instead of stopping at the local name check');
  assert.deepEqual(second.body, first.body, 'same key, same body: the server answers with the cat it made');
  assert.equal(errOf(stage, '名字').textContent, '');
  assert.deepEqual(p.opened, ['宪宪']);
  // A changed request is new, and then the name the list knows is taken.
  const q = page({ route: (path, method, body) => { if (path === '/xbot-api/bots' && method === 'POST') { made.splice(0, Infinity, body.name); throw fail(undefined); } return undefined; }, onRefresh: () => { q.s.cats.splice(0, Infinity, ...made); } });
  const again = await q.stage();
  button(again, '带它回家').click();
  await settle();
  face(again, '缅因猫').click();
  type(control(again, '名字'), '宪宪');
  button(again, '带它回家').click();
  await settle();
  assert.equal(q.posts().length, 1);
  assert.equal(errOf(again, '名字').textContent, '已经有一只叫「宪宪」的猫猫了，换个名字吧');
});

test('switching 自定义\'s tool keeps keyboard focus on the select, so Tab and Escape still work inside the dialog', async () => {
  const p = page();
  const stage = await p.stage();
  ownTile(stage).click();
  const select = () => one(stage, 'qc-tool-line').querySelectorAll('select')[0];
  const before = select();
  before.focus();
  choose(before, 'codex');
  assert.equal(p.doc.activeElement, select(), 'focus stays on the tool select');
  assert.equal(select().value, 'codex');
  choose(select(), 'claude');
  assert.equal(p.doc.activeElement.tagName, 'SELECT');

  const q = page({ cats: ['团子'] });
  q.Q.openCat({ opener: q.opener });
  await settle();
  const card = one(q.layer()!, 'qc-card');
  ownTile(card).click();
  const pick = one(card, 'qc-tool-line').querySelectorAll('select')[0];
  pick.focus();
  choose(pick, 'claude');
  assert.equal(card.contains(q.doc.activeElement), true);
  q.doc.activeElement.key('Escape');
  assert.equal(q.layer(), null, 'Escape from the focused select still closes the dialog');
  assert.equal(q.doc.activeElement, q.opener);
});

test('a face the owner picked survives a 422, the blocked view and 重新检测', async () => {
  const p = page({ route: (path, method) => { if (path === '/xbot-api/bots' && method === 'POST' && p.s.start === START.login) throw fail(422, '请先在本机 Agent 中完成登录'); return undefined; } });
  const stage = await p.stage();
  face(stage, '缅因猫').click();
  p.s.start = START.login;
  button(stage, '带它回家').click();
  await settle();
  assert.equal(shown(one(stage, 'qc-need')), true);
  assert.equal(chosen(stage), null, 'blocked, the row is only a picture');
  p.s.start = START.ready;
  button(stage, '重新检测').click();
  await settle();
  assert.equal(chosen(stage), '缅因猫', 'the owner\'s choice comes back, not the default');
  assert.equal(control(stage, '名字').value, '砚砚');
  button(stage, '带它回家').click();
  await settle();
  assert.equal(p.posts().at(-1)!.body.simple.face, 'maine-coon');
});

test('the name boxes admit every name the server accepts (64 characters, some outside the basic plane) and the rules say when one is longer', async () => {
  const p = page({ cats: ['团子', '栗子'] });
  const stage = await p.stage();
  const longest = '𠀀'.repeat(64), group = '😺'.repeat(64);
  const catName = control(stage, '名字');
  assert.ok(longest.length <= catName.maxLength, 'a browser counts UTF-16 units: 64 such characters must fit');
  assert.equal(p.R.nameProblem(longest, []), '');
  assert.equal(p.R.nameProblem(longest + '𠀀', []), '名字最多 64 个字');
  p.Q.openGroup({ opener: p.opener });
  const card = one(p.layer()!, 'qc-card');
  const groupName = control(card, '群名');
  assert.ok(group.length <= groupName.maxLength);
  assert.equal(p.R.groupNameProblem(group), '');
  assert.equal(p.R.groupNameProblem(group + '😺'), '群名最多 64 个字');
  card.key('Escape');
  // The optional line (自定义): up to 2000 characters, refused before sending beyond that.
  p.Q.openCat({ opener: p.opener });
  await settle();
  const cat = one(p.layer()!, 'qc-card');
  ownTile(cat).click();
  type(control(cat, '名字'), '小白');
  const about = control(cat, '它主要帮你做什么');
  assert.ok('𠀀'.repeat(2000).length <= about.maxLength);
  type(about, '字'.repeat(2001));
  cat.dispatch('submit');
  await settle();
  assert.equal(p.posts().length, 0);
  assert.match(visibleText(cat), /这一行最多 2000 个字/);
  assert.equal(p.doc.activeElement, about);
});

test('closing a dialog returns focus to the 新建 button the sidebar has now, even after a redraw replaced the one that opened it', async () => {
  for (const open of ['openCat', 'openGroup'] as const) {
    const p = page({ cats: ['团子', '栗子'] });
    p.opener.focus();
    p.Q[open]({ opener: p.opener });
    await settle();
    // renderLists() redraws the pin row: the opener is gone, an equivalent button is there.
    p.opener.remove();
    const redrawn = p.doc.createElement('button');
    p.doc.body.append(redrawn);
    p.live.opener = redrawn;
    p.doc.activeElement.key('Escape');
    assert.equal(p.layer(), null, open);
    assert.equal(p.doc.activeElement, redrawn, open + ': focus is not left on the page');
  }
  // 更多设置 hands the live button to the template creator too.
  const q = page({ cats: ['团子'] });
  q.Q.openCat({ opener: q.opener });
  await settle();
  q.opener.remove();
  const redrawn = q.doc.createElement('button');
  q.doc.body.append(redrawn);
  q.live.opener = redrawn;
  button(one(q.layer()!, 'qc-card'), '更多设置').click();
  assert.deepEqual(q.more, [redrawn]);
});

test('a first cat arriving from elsewhere retires an untouched stage; one with a draft or a request on its way stays and points at the cat', async () => {
  // Untouched: the shell may replace it (with the no-chat line).
  const p = page();
  const stage = await p.stage();
  assert.equal(p.Q.release(stage, ['团子']), true);
  // A typed name stays, with a way to the cat that arrived.
  const q = page();
  const typed = await q.stage();
  type(control(typed, '名字'), '小白');
  assert.equal(q.Q.release(typed, ['团子']), false);
  assert.equal(control(typed, '名字').value, '小白');
  assert.equal(visibleText(one(typed, 'qc-arrived')), '已经有猫猫了：团子。去聊天');
  button(typed, '去聊天').click();
  await settle();
  assert.deepEqual(q.opened, ['团子']);
  // A picked face counts as a draft; so does focus inside the stage.
  const r = page();
  const picked = await r.stage();
  face(picked, '暹罗猫').click();
  assert.equal(r.Q.release(picked, ['团子', '栗子', '年糕', '豆包']), false);
  assert.equal(visibleText(one(picked, 'qc-arrived')), '已经有猫猫了：团子、栗子、年糕等 4 只。去聊天');
  // A request on its way (perhaps this very cat): nothing changes and nothing is said.
  let release: () => void = () => {};
  const s = page({ route: (path, method) => (path === '/xbot-api/bots' && method === 'POST' ? new Promise(done => { release = () => done({ name: '砚砚', native_id: 'b' }); }) : undefined) });
  const busy = await s.stage();
  button(busy, '带它回家').click();
  await settle();
  assert.equal(s.Q.release(busy, ['砚砚']), false);
  assert.equal(named(busy, 'qc-arrived').filter(shown).length, 0);
  release();
  await settle();
  assert.deepEqual(s.opened, ['砚砚']);
  // An unsure request is a pending one too.
  const u = page({ route: (path, method) => { if (path === '/xbot-api/bots' && method === 'POST') throw fail(undefined); return undefined; } });
  const unsure = await u.stage();
  button(unsure, '带它回家').click();
  await settle();
  assert.equal(u.Q.release(unsure, ['砚砚']), false);
});

test('the shell reconciles the no-chat view when the cats change: stage ↔ no-chat line, never over an open chat', () => {
  const app = read('client/public/app.js');
  const take = (name: string) => {
    const m = new RegExp(`\\n {2}(?:async )?function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
    assert.ok(m, name + ' is where the shell keeps it');
    return m[0];
  };
  assert.match(take('refreshLists'), /renderLists\(\);[\s\S]*syncNoChat\(\);/, 'every list read reconciles');
  const doc = new Doc();
  const thread = doc.createElement('div');
  doc.body.append(thread);
  const state: Any = { sel: null, bots: [] };
  const asked: string[][] = [];
  let free = true;
  const view = (cls: string) => () => { const v = doc.createElement('div'); v.className = cls; return v; };
  const quick = { stage: view('qc-stage'), noChat: view('qc-none'), release: (_el: El, names: string[]) => { asked.push(names); return free; } };
  const out: Any = {};
  vm.runInNewContext(take('showNoChat') + take('syncNoChat') + 'out.show = showNoChat; out.sync = syncNoChat;', {
    out, state, thread, quick, el: (tag: string, cls: string) => { const e = doc.createElement(tag); e.className = cls; return e; },
  });
  const showing = () => (thread.querySelector('.qc-stage') ? 'stage' : thread.querySelector('.qc-none') ? 'none' : 'other');
  out.show();
  assert.equal(showing(), 'stage');
  const first = thread.querySelector('.qc-stage');
  out.sync();
  assert.equal(thread.querySelector('.qc-stage'), first, 'no cats yet: the same stage stays (its draft and request too)');
  state.bots = [{ name: '团子' }];
  free = false;
  out.sync();
  assert.equal(thread.querySelector('.qc-stage'), first, 'a stage with a draft is kept');
  assert.deepEqual(asked.at(-1), ['团子']);
  free = true;
  out.sync();
  assert.equal(showing(), 'none', 'an untouched stage gives way to the no-chat line');
  state.bots = [];
  out.sync();
  assert.equal(showing(), 'stage', 'the last cat gone: the stage again');
  // An open chat is never replaced.
  state.sel = { type: 'bot', id: '团子' };
  state.bots = [{ name: '团子' }];
  out.sync();
  assert.equal(showing(), 'stage');
  // Nor any other view (the pre-login hold, a chat's own history).
  state.sel = null;
  thread.replaceChildren(doc.createElement('div'));
  out.sync();
  assert.equal(showing(), 'other');
});

// ---------------------------------------------------------------- wiring
test('the shell loads the module before app.js and its styles after every earlier one, opens the stage or the no-chat line when nothing is open, and routes 新建 through it', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/quick-create.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('cat-avatars.js') < at('quick-create-rules.js') && at('chat-experience.js') < at('quick-create-rules.js'));
  assert.ok(at('quick-create-rules.js') < at('quick-create.js') && at('quick-create.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  // After every earlier style; only the search palette, the 找得到 styles, 资料页与群 (profile.css, mention.css) and the live-reply styles (chat-live.css), which stay last, follow.
  assert.deepEqual(styles.slice(styles.indexOf('chat-experience.css') + 1), ['quick-create.css', 'palette.css', 'chat-list.css', 'chat-history.css', 'profile.css', 'mention.css', 'polish.css', 'chat-cards.css', 'chat-presence.css', 'chat-reactions.css', 'sidebar.css', 'chat-panel.css', 'chat-live.css']);
  // 新建 is the sidebar's own button, at the top of the full sidebar and at the bottom of the rail (item 43): one dialog, no menu.
  assert.match(html, /<button id="side-new" class="side-btn" type="button" aria-haspopup="dialog" aria-label="新建" data-tip="新建"><\/button>/);
  assert.match(html, /<button id="rail-new" class="side-glyph rail-only" type="button" aria-haspopup="dialog" aria-label="新建" data-tip="新建" data-tip-placement="right"><\/button>/);
  assert.doesNotMatch(html, /新建猫猫或群聊/);
  // Nothing open: the stage with no cats, else the no-chat line; both hide the composer, as does the pre-login hold.
  assert.match(app, /else if \(!state\.sel\) showNoChat\(\);/);
  assert.match(app, /function showNoChat\(\) \{\n\s+const inner = el\("div", "thread-inner no-chat"\);\n\s+inner\.append\(state\.bots\.length \? quick\.noChat\(\) : quick\.stage\(\)\);/);
  assert.match(app, /const hold = el\("div", "thread-inner no-chat"\);/);
  assert.match(app, /else \{ paintPanel\(\); showNoChat\(\); \}/, 'deleting the last cat comes back to the stage');
  assert.doesNotMatch(app, /左边是你的 Bot|选一个对话/);
  // 新建: the dialog on its 猫猫 side (更多设置 → the template creator); ⌘K 新建群聊 opens it on its 群聊 side. The two-row
  // menu is gone: no 新建群组, no toggleNewMenu / closeNewMenu / .new-menu, no 新建 tile in the pinned row.
  assert.match(app, /for \(const id of \["side-new", "rail-new"\]\) \{[\s\S]*?btn\.addEventListener\("click", \(\) => openNewBot\(btn\)\);/);
  assert.doesNotMatch(app, /新建群组|toggleNewMenu|closeNewMenu|new-menu|"pin add"|\.pin\.add/);
  assert.match(app, /function openNewGroup\(opener\) \{[\s\S]*?quick\.openGroup\(\{ opener:/);
  assert.match(app, /function openNewBot\(opener\) \{[\s\S]*?quick\.openCat\(\{ opener:/);
  assert.match(app, /more: \(opener\) => openTemplateCreate\(opener\)/);
  assert.match(app, /function openTemplateCreate\(opener\) \{[\s\S]*?window\.ClowderCatTemplates\.openCreate\(\{/);
  // Focus comes back to the 新建 on screen now (the top one, or the rail's).
  assert.match(app, /opener: \(\) => shownNew\(\),/);
  assert.match(app, /function shownNew\(\) \{\n\s+return \[\$\("side-new"\), \$\("rail-new"\)\]\.find\(\(b\) => \{\n\s+if \(!b \|\| !b\.getClientRects\(\)\.length\) return false;/);
  // Where the new cat's portrait lands: its own face in the header.
  assert.match(app, /landing: \(name\) => \[\.\.\.document\.querySelectorAll\("#title \.avatar\[data-avatar-bot\]"\)\]/);
  // Only existing tokens; no new colour literal.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  // The words shown never name a Bot or a model (an Agent may be named since 2026-11-12, item 42).
  for (const file of ['client/public/quick-create.js', 'client/public/quick-create-rules.js']) {
    const shownWords = [...read(file).matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)].map(m => m[1]);
    assert.ok(shownWords.length > 20, file);
    for (const words of shownWords) assert.doesNotMatch(words, /Bot|模型/i, words);
  }
});

// ---------------------------------------------------------------- faces with character, 自定义 (2026-11-12)
// /start's faces[] as the server itself builds it (startSummary, see START
// above) from the engine's real eight templates, on a computer with Claude
// Code and Codex, so these tests read what the first screen will really get.
// `edit` changes the engine's templates first (say, a portrait edited upstream), so the server computes its own `rev`.
const realFaces = async (edit: (templates: Any[]) => Any[] = t => t): Promise<Any[]> => (await summary(computer('configured', 'configured'), edit)).faces;
const withFaces = async (start: Any = START.ready) => ({ ...start, faces: await realFaces() });
// The hint as shown (each line's text), or [] when it is not shown.
const hint = (root: El) => { const box = one(root, 'qc-trait'); return shown(box) ? named(box, 'qc-trait-line').map(n => n.textContent) : []; };
// The polite status line that says what the owner's choice means.
const voice = (root: El) => { const v = all(root).find(n => has(n, 'qc-sr') && n.getAttribute('role') === 'status'); assert.ok(v, 'no voice'); return v!; };
const field = (root: El, label: string) => all(root).some(n => n.tagName === 'LABEL' && n.textContent.startsWith(label) && shown(n));
const presetsOf = (doc: Doc) => vm.runInNewContext(read('client/public/cat-avatars.js') + ';window.ClowderAvatars.presets', { window: {}, document: doc }) as Any[];
// The card's name line: the name the cat comes with and its breed (for 自定义, whose cat it is).
const nickOf = (root: El) => { const n = one(root, 'qc-nick'); return [...named(n, 'qc-nick-name'), ...named(n, 'qc-breed')].map(x => x.textContent); };

test('the faces offered are /start\'s faces[], in its order, limited to portraits here; with none, every portrait without words', async () => {
  const { R, doc } = page();
  const presets = presetsOf(doc);
  const offered = plain(R.offer(R.start(await withFaces()).faces, presets));
  assert.deepEqual(offered.map((f: Any) => f.id), ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla']);
  assert.equal(offered.find((f: Any) => f.id === 'dsh').label, '蓝灰短毛猫', 'the label next to a portrait is the client\'s, not upstream\'s 小鲸鱼');
  // The server's order wins; unknown and repeated faces are dropped; a face without words has no hint.
  const some = plain(R.offer([{ id: 'bengal', personality: '好动' }, { id: 'sphynx', personality: '光溜溜' }, { id: 'ragdoll' }, { id: 'bengal', personality: '又一只' }], presets));
  assert.deepEqual(some.map((f: Any) => [f.id, f.label, f.hint]), [['bengal', '孟加拉猫', { lines: ['好动'], said: '好动' }], ['ragdoll', '布偶猫', null]]);
  // No faces (the templates could not be read), or none this client can draw: every portrait, without words.
  for (const none of [[], [{ id: 'sphynx', personality: '光溜溜' }]]) {
    const every = plain(R.offer(none, presets));
    assert.deepEqual(every.map((f: Any) => f.id), plain(presets.map(p => p.id)));
    assert.ok(every.every((f: Any) => f.hint === null));
  }
  // faces[] is read defensively: anything malformed is no face; words are trimmed; no faces at all (an older server) is null, not [].
  assert.equal(R.start({ ...START.ready, faces: 'oops' }).faces, null);
  assert.equal(R.start(bare(START.ready)).faces, null);
  assert.deepEqual(plain(R.start({ ...START.ready, faces: [null, { id: 3 }, { id: 'dsh', rev: ' ab12 ', role: '  ', personality: ' 细心 ', strengths: 7 }] }).faces), [{ id: 'dsh', rev: 'ab12', personality: '细心' }]);
});

test('the hint is the template\'s own words: its personality, then 擅长 its strengths (else its role), clipped at a pause when too long', async () => {
  const { R, doc } = page();
  const offered = plain(R.offer(R.start(await withFaces()).faces, presetsOf(doc)));
  assert.deepEqual(offered.find((f: Any) => f.id === 'maine-coon').hint, {
    lines: ['严谨认真，注重细节，会直言不讳地指出问题', '擅长 Review、找 bug、coding 落地'],
    said: '严谨认真，注重细节，会直言不讳地指出问题。擅长 Review、找 bug、coding 落地',
  });
  // Technical words in a template are shown as they are, not rewritten or filtered.
  assert.deepEqual(offered.find((f: Any) => f.id === 'golden-chinchilla').hint.lines, ['沉稳可靠，什么 provider 都能接，什么任务都能扛', '擅长多专家内部编排、LSP 集成、开源生态、provider-agnostic']);
  // Every real template fits unclipped.
  for (const f of offered) {
    const [, , , personality, strengths] = catTemplates.find(t => t[0] === f.id)!;
    assert.deepEqual(f.hint.lines, [personality, '擅长' + (/^[A-Za-z]/.test(strengths) ? ' ' : '') + strengths], f.id);
  }
  assert.deepEqual(plain(R.trait({ id: 'x', personality: '先证后答', role: 'GLM 对话猫；中文实证' })).lines, ['先证后答', 'GLM 对话猫；中文实证'], 'no strengths: the role, as written');
  assert.deepEqual(plain(R.trait({ id: 'x', strengths: '擅长画画' })).lines, ['擅长画画'], 'never 擅长擅长');
  assert.equal(R.trait({ id: 'x', personality: '热情！', strengths: '画画' }).said, '热情！擅长画画', 'one sentence for a screen reader, no doubled stop');
  for (const empty of [null, {}, { id: 'x', role: '  ' }]) assert.equal(R.trait(empty), null);
  // Too long (the server clips at 120): at most TRAIT_MAX characters, cut at a pause near the end, with an ellipsis.
  const long = R.trait({ id: 'x', personality: '一二三四五六七八九十，'.repeat(7), strengths: Array.from({ length: 24 }, (_, i) => '本领' + i).join('、') });
  for (const line of long.lines) assert.ok([...line].length <= R.TRAIT_MAX, line);
  assert.match(long.lines[0], /九十…$/, 'cut where the comma was, the comma dropped');
  assert.match(long.lines[1], /^擅长本领0、[^、]*、.*本领\d+…$/);
  assert.equal(R.clipLine(' a  b\n c ', 40), 'a b c');
  assert.equal(R.clipLine('超长'.repeat(30), 10), '超长超长超长超长超…', 'no pause near the end: a plain cut');
  assert.equal(R.clipLine('多专家内部编排、LSP 集成、开源生态、provider-agnostic', 30), '多专家内部编排、LSP 集成、开源生态…', 'not in the middle of a word when a pause is close');
});

test('a face\'s own cat sends the face alone; 自定义 sends custom and only what was written, exactly what the server\'s schema takes', async () => {
  const { R } = page();
  const m = /const simpleCat = (z\.object\([\s\S]*?\)\.strict\(\));/.exec(read('server/xbot/core.ts'));
  assert.ok(m, 'the adapter\'s simpleCat schema');
  const simpleCat = new Function('z', 'catFaces', 'return ' + m[1])(z, catFaces);
  const base = { name: ' 小白 ', face: 'bengal', agent: 'codex', about: ' 陪我练口语 ', personality: ' 话不多 ' };
  const own = plain(R.catBody(base)), custom = plain(R.catBody({ ...base, custom: true })), helper = plain(R.catBody({ ...base, custom: true, about: ' ', personality: '' }));
  assert.deepEqual(own, { name: '小白', simple: { face: 'bengal' } }, 'what 自定义 holds (its lines, its tool) is never sent for a face\'s own cat');
  assert.deepEqual(custom, { name: '小白', simple: { face: 'bengal', custom: true, about: '陪我练口语', personality: '话不多', agent: 'codex' } });
  assert.deepEqual(helper, { name: '小白', simple: { face: 'bengal', custom: true, agent: 'codex' } }, 'both lines empty: custom all the same, so not the template');
  for (const body of [own, custom, helper]) assert.equal(simpleCat.safeParse(body.simple).success, true, JSON.stringify(body));
  assert.notEqual(R.fingerprint(own), R.fingerprint(helper), 'another mode is another request');
  // The personality: 500 characters, as the schema counts them.
  for (const text of ['字'.repeat(500), '𠀀'.repeat(500), '字'.repeat(501), '𠀀'.repeat(501)]) {
    const accepted = simpleCat.safeParse({ custom: true, personality: text }).success;
    assert.equal(R.personalityProblem(text) === '', accepted, text.length + ' units');
    if (accepted) assert.ok(text.length <= R.PERSONALITY_INPUT_MAX, 'the box admits every personality the server takes');
  }
  assert.equal(R.personalityProblem('字'.repeat(501)), '性格最多 500 个字');
});

test('the first screen offers the server\'s faces and says briefly what the chosen cat is like and what it thinks with; a screen reader hears it once per choice, never for the default', async () => {
  const p = page({ start: await withFaces() });
  const stage = await p.stage();
  // Each tile is named: the name its cat comes with (shown), and its breed (the client's label) for a screen reader too.
  assert.deepEqual(faces(stage).map(f => f.getAttribute('aria-label')), ['宪宪，布偶猫', '砚砚，缅因猫', '烁烁，暹罗猫', '墨墨，梵花猫', '鲸鲸，蓝灰短毛猫', '小狸花，狸花猫', '斑斑，孟加拉猫', '金哥，金渐层']);
  assert.deepEqual(faces(stage).map(f => named(f, 'qc-face-name')[0].textContent), ['宪宪', '砚砚', '烁烁', '墨墨', '鲸鲸', '小狸花', '斑斑', '金哥']);
  assert.equal(chosen(stage), '布偶猫');
  // The chosen one's card: the name it comes with and its breed, its Agent as a mark, its temperament and what it is good at.
  assert.deepEqual(nickOf(stage), ['宪宪', '布偶猫']);
  assert.deepEqual(hint(stage), ['温柔但有主见，喜欢深入分析问题，写代码快但注重质量', '擅长架构设计、写代码一把好手']);
  assert.equal(markSaid(stage), '它用这台电脑上的 Claude Code 来思考');
  assert.ok(all(one(stage, 'qc-hero')).some(n => n.getAttribute('data-cat-id') === 'ragdoll'), 'its portrait on the card');
  assert.equal(one(stage, 'qc-about').classList.contains('described'), true, 'room for two lines, so the form below holds still');
  assert.equal(voice(stage).textContent, '', 'the default is not announced');
  face(stage, '缅因猫').click();
  assert.deepEqual(hint(stage), ['严谨认真，注重细节，会直言不讳地指出问题', '擅长 Review、找 bug、coding 落地']);
  assert.equal(voice(stage).textContent, '严谨认真，注重细节，会直言不讳地指出问题。擅长 Review、找 bug、coding 落地。它用这台电脑上的 Codex 来思考');
  face(stage, '缅因猫').key('ArrowLeft');
  assert.equal(chosen(stage), '布偶猫');
  assert.equal(voice(stage).textContent, '温柔但有主见，喜欢深入分析问题，写代码快但注重质量。擅长架构设计、写代码一把好手。它用这台电脑上的 Claude Code 来思考');
  const said = voice(stage).textContent;
  type(control(stage, '名字'), '小宪');
  assert.equal(voice(stage).textContent, said, 'typing says nothing');
  button(stage, '带它回家').click();
  await settle();
  const ragdoll = (await realFaces()).find(f => f.id === 'ragdoll');
  assert.deepEqual(p.posts()[0].body.simple, { face: 'ragdoll', rev: ragdoll.rev }, 'the face\'s own cat: the face and the portrait shown, no words of the owner\'s, no tool');
});

test('fewer or more faces than eight: the row follows faces[]', async () => {
  const real = await realFaces();
  // Three faces, in another order: those whose cat can come home first, then 自定义, then those that cannot, each in
  // the server's order; the first that can come home is chosen, not simply the first.
  const p = page({ start: { ...START.ready, faces: [real[6], real[0], real[2]] } });
  const stage = await p.stage();
  assert.deepEqual(tiles(stage).filter(shown).map(f => f.dataset.face ?? '自定义'), ['ragdoll', '自定义', 'bengal', 'siamese']);
  assert.equal(chosen(stage), '布偶猫');
  assert.equal(control(stage, '名字').value, '宪宪');
  face(stage, '布偶猫').key('ArrowRight');
  assert.equal(chosen(stage), '自定义');
  ownTile(stage).key('ArrowRight');
  face(stage, '孟加拉猫').key('ArrowRight');
  assert.equal(chosen(stage), '暹罗猫');
  face(stage, '暹罗猫').key('ArrowRight');
  assert.equal(chosen(stage), '布偶猫', 'arrows walk the options in the order shown and wrap within those there are');
  // More than eight (a larger portrait library): every face with a portrait, in faces[] order, one tab stop.
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 'cat' + i, label: '猫' + i, nickname: '小' + i }));
  const q = page({ presets: many, start: { ...START.ready, faces: [...many].reverse().map(c => ({ id: c.id, personality: c.label + '的性格', strengths: '陪伴', tool: { label: 'Codex', state: 'ready', usable: true, id: 'codex' } })) } });
  const row = await q.stage();
  assert.equal(faces(row).length, 12);
  assert.equal(faces(row)[0].dataset.face, 'cat11');
  assert.equal(faces(row).filter(f => f.tabIndex === 0).length, 1);
  face(row, '猫0').click();
  face(row, '猫0').key('Home');
  assert.equal(chosen(row), '猫11');
  assert.deepEqual(hint(row), ['猫11的性格', '擅长陪伴']);
  // A server that sends no faces at all (older than faces[]) is not second-guessed: every portrait, no words, each made with the usual tool, as such a server did.
  const r = page({ start: bare(START.ready) });
  const old = await r.stage();
  assert.equal(faces(old).length, 8);
  assert.deepEqual(hint(old), []);
  assert.equal(one(old, 'qc-about').classList.contains('described'), false, 'no empty lines kept');
  assert.equal(named(old, 'qc-face').filter(f => has(f, 'away')).length, 0);
  assert.equal(markSaid(old), '它用这台电脑上的 Codex 来思考');
  button(old, '带它回家').click();
  await settle();
  assert.deepEqual(r.posts()[0].body.simple, { face: 'ragdoll' }, 'no rev to send, and no tool (the server takes its usual one)');
});

test('自定义 is one of the options, a tile like the cats\': chosen, the card becomes the owner\'s own cat (its looks, two optional lines, its Agent), and moving between it and a cat loses nothing', async () => {
  const p = page({ start: await withFaces() });
  const stage = await p.stage();
  const own = ownTile(stage), row = one(stage, 'qc-faces');
  assert.ok(row.contains(own) && own.getAttribute('role') === 'radio', 'a radio of the same group as the cats');
  assert.equal(own.getAttribute('aria-checked'), 'false');
  assert.equal(field(stage, '它主要帮你做什么') || field(stage, '它的性格'), false, 'not offered for a face\'s own cat');
  face(stage, '暹罗猫').click();
  type(control(stage, '名字'), '小烁');
  own.click();
  assert.equal(chosen(stage), '自定义');
  assert.equal(face(stage, '暹罗猫').getAttribute('aria-checked'), 'false', 'one choice in one group');
  assert.equal(p.doc.activeElement, own, 'focus stays on the choice');
  assert.equal(shown(one(stage, 'qc-nick')), false, 'no title: the owner\'s own cat is plain from its looks and its lines (item 45)');
  assert.deepEqual(nickOf(stage), []);
  assert.equal(looksChosen(stage), '暹罗猫', 'untouched, its looks are those of the cat on screen');
  assert.deepEqual(hint(stage), [], 'no template\'s words');
  assert.equal(mark(stage), '', 'nor a template\'s Agent: its own is chosen on the card');
  assert.equal(voice(stage).textContent, p.R.OWN_NOTE);
  assert.equal(row.getAttribute('aria-label'), '选一只猫猫', 'the row is still the cats and 自定义');
  const about = control(stage, '它主要帮你做什么'), temper = control(stage, '它的性格');
  // Each line's question is its placeholder, and its name for a screen reader; no example, no 可不填 beside it (item 45).
  assert.equal(about.placeholder, '它主要帮你做什么');
  assert.equal(temper.placeholder, '它的性格');
  const labelOf = (input: El) => all(stage).find(l => l.tagName === 'LABEL' && l.htmlFor === input.id)!;
  for (const input of [about, temper, control(stage, '名字')]) assert.equal(has(labelOf(input), 'qc-sr'), true, labelOf(input).textContent + ' is said, not shown');
  assert.doesNotMatch(seenText(one(stage, 'qc-side')), /可不填|比如|你自己的猫猫|长相：/);
  type(about, ' 帮我整理读书笔记 ');
  type(temper, '话不多');
  face(stage, '暹罗猫').click();
  assert.equal(chosen(stage), '暹罗猫');
  assert.deepEqual(hint(stage), ['热血奔放，善于用视觉语言表达想法，表达力是全队最强的', '擅长审美、前端设计风格、打破常规']);
  assert.equal(voice(stage).textContent, '热血奔放，善于用视觉语言表达想法，表达力是全队最强的。擅长审美、前端设计风格、打破常规。它要用 Gemini 来思考。暂不支持 Gemini，现在领不了。可以用它的长相自定义，用这台电脑上的 Agent 来思考', 'back: what this cat is like, what it needs and the way on, said again');
  assert.equal(shown(about), false);
  assert.equal(control(stage, '名字').value, '小烁');
  own.click();
  assert.equal(about.value, ' 帮我整理读书笔记 ');
  assert.equal(temper.value, '话不多');
  // Its looks: a radio group of their own, every face (none is unavailable as a look), one always chosen; picking one adds nothing to what the radio itself says.
  const looks = one(stage, 'qc-looks');
  assert.equal(looks.getAttribute('role'), 'radiogroup');
  assert.equal(named(looks, 'qc-look').length, 8);
  assert.equal(named(looks, 'qc-look').filter(n => n.tabIndex === 0).length, 1, 'one Tab stop');
  const said = voice(stage).textContent;
  named(looks, 'qc-look').find(n => n.getAttribute('aria-label') === '暹罗猫')!.key('ArrowLeft');
  assert.equal(looksChosen(stage), '缅因猫');
  assert.equal(voice(stage).textContent, said);
  assert.deepEqual(nickOf(stage), []);
  // A personality the server would refuse is caught before sending.
  type(temper, '字'.repeat(501));
  button(stage, '带它回家').click();
  await settle();
  assert.equal(p.posts().length, 0);
  assert.equal(p.doc.activeElement, temper);
  assert.equal(temper.getAttribute('aria-invalid'), 'true');
  assert.match(visibleText(stage), /性格最多 500 个字/);
  type(temper, ' 话不多 ');
  button(stage, '带它回家').click();
  await settle();
  assert.deepEqual(p.posts()[0].body.simple, { face: 'maine-coon', custom: true, about: '帮我整理读书笔记', personality: '话不多', agent: 'codex' });
  assert.deepEqual(p.opened, ['小烁']);
});

test('a lost answer is retried with the identical body under its own key, after switching to 自定义 and back too; another mode is another request', async () => {
  let lose = true, refuseCustom = true;
  const p = page({
    start: await withFaces(),
    route: (path, method, body) => {
      if (path !== '/xbot-api/bots' || method !== 'POST') return undefined;
      if (body.simple.custom && refuseCustom) { refuseCustom = false; throw fail(409, '已经有一只叫这个名字的猫猫了', 'name_taken'); }
      if (lose) throw fail(undefined, '连不上 clowder-bot');
      return undefined;
    },
  });
  const stage = await p.stage();
  const go = button(stage, '带它回家'), own = ownTile(stage), cat = face(stage, '布偶猫');
  go.click(); await settle(); // the face's own cat, unsure: key A
  own.click(); cat.click(); // there and back, nothing sent
  go.click(); await settle(); // the same body: key A again
  own.click();
  type(control(stage, '名字'), '宪宪'); // 自定义 borrows no name: the owner writes one (the cat's own here, so only 自定义 differs)
  go.click(); await settle(); // 自定义: another request, refused (no cat made, its key dropped)
  go.click(); await settle(); // the same 自定义 body after a refusal: a new request, unsure
  cat.click();
  lose = false;
  go.click(); await settle(); // the face's own cat again: still key A, and it lands
  const [a1, a2, c1, c2, a3] = p.posts().map(c => c.body);
  assert.deepEqual(a1.simple, { face: 'ragdoll', rev: (await realFaces()).find(f => f.id === 'ragdoll').rev });
  assert.deepEqual(a2, a1, 'same body, same key');
  assert.deepEqual(c1.simple, { face: 'ragdoll', custom: true, agent: 'claude' }, '自定义 keeps the tool of the cat on screen');
  assert.notEqual(c1.idempotencyKey, a1.idempotencyKey, 'another mode is another request');
  assert.notEqual(c2.idempotencyKey, c1.idempotencyKey, 'a refused request leaves no key behind');
  assert.deepEqual(a3, a1, 'the face\'s own request keeps its key across the custom tries');
  assert.deepEqual(p.opened, ['宪宪']);
});

test('新建猫猫 has the same cats, card and 自定义: the card names the cat and its breed, the optional lines only with 自定义, focus in order, Escape from 自定义', async () => {
  const p = page({ cats: ['团子'], start: await withFaces() });
  p.opener.focus();
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  assert.equal(p.doc.activeElement, control(card, '名字'), 'the dialog still starts in the name');
  // The card names the cat: the name it comes with, and its breed (the client's label).
  assert.deepEqual(nickOf(card), ['宪宪', '布偶猫']);
  assert.deepEqual(hint(card), ['温柔但有主见，喜欢深入分析问题，写代码快但注重质量', '擅长架构设计、写代码一把好手']);
  face(card, '蓝灰短毛猫').click();
  assert.deepEqual(nickOf(card), ['鲸鲸', '蓝灰短毛猫'], 'never upstream\'s 小鲸鱼');
  assert.equal(field(card, '它主要帮你做什么'), false, 'the optional line belongs to 自定义');
  const own = ownTile(card);
  own.click();
  assert.deepEqual(nickOf(card), []);
  assert.equal(field(card, '它主要帮你做什么') && field(card, '它的性格'), true);
  // Focus order (what Tab walks through): the selected side of the switch (item 43), the row (one stop: 自定义), its Agent
  // (where a cat's mark is), its looks (one stop), the two lines, the name, 更多设置, 取消, 创建. No 可不填 in any name.
  const stops = all(card).filter(n => ['BUTTON', 'INPUT', 'SELECT'].includes(n.tagName) && shown(n) && n.tabIndex >= 0 && !n.disabled);
  const name = (n: El) => n.getAttribute('aria-label') || all(card).find(l => l.tagName === 'LABEL' && l.htmlFor === n.id)?.textContent || n.textContent;
  assert.deepEqual(stops.map(name), ['猫猫', '自定义', '用哪个 Agent 思考', '蓝灰短毛猫', '它主要帮你做什么', '它的性格', '名字', '更多设置', '取消', '创建']);
  own.focus();
  own.key('Escape');
  assert.equal(p.layer(), null);
  assert.equal(p.doc.activeElement, p.opener);
});

test('blocked or still reading: no card and no 自定义; 自定义, its looks and its lines come back after a 422 and 重新检测', async () => {
  const real = await realFaces();
  let refuse = true;
  const p = page({
    start: { ...START.ready, faces: real },
    route: (path, method) => {
      if (path === '/xbot-api/bots' && method === 'POST' && refuse) { refuse = false; p.s.start = { ...START.login, faces: real }; throw fail(422, '请先在本机 Agent 中完成登录'); }
      return undefined;
    },
  });
  const stage = await p.stage();
  face(stage, '梵花猫').click();
  ownTile(stage).click();
  type(control(stage, '名字'), '小墨');
  type(control(stage, '它的性格'), '慢悠悠');
  button(stage, '带它回家').click();
  await settle();
  assert.equal(shown(one(stage, 'qc-need')), true);
  assert.equal(shown(one(stage, 'qc-about')), false, 'blocked: the row is only a picture, nothing to choose or describe');
  assert.equal(faces(stage).length, 8, 'the row stays the server\'s faces');
  assert.equal(tiles(stage).filter(shown).length, 8, 'no 自定义 while nothing can be made');
  assert.equal(chosen(stage), null);
  p.s.start = { ...START.ready, faces: real };
  button(stage, '重新检测').click();
  await settle();
  assert.equal(chosen(stage), '自定义');
  assert.equal(looksChosen(stage), '梵花猫');
  assert.equal(control(stage, '它的性格').value, '慢悠悠');
  assert.equal(control(stage, '名字').value, '小墨');
  assert.deepEqual(nickOf(stage), []);
  button(stage, '带它回家').click();
  await settle();
  assert.deepEqual(p.posts().at(-1)!.body.simple, { face: 'turkish-van', custom: true, personality: '慢悠悠', agent: 'codex' });
  // Still reading /start: the row is a picture, with no hint and no switch yet.
  const q = page({ route: (path) => (path.startsWith('/xbot-api/start') ? new Promise(() => {}) : undefined) });
  const reading = q.paint(q.Q.stage());
  await settle();
  assert.equal(shown(one(reading, 'qc-about')), false);
  assert.equal(one(reading, 'qc-faces').getAttribute('aria-hidden'), 'true');
});

test('自定义 or its lines count as a draft when the first cat arrives from elsewhere', async () => {
  const p = page({ start: await withFaces() });
  const stage = await p.stage();
  ownTile(stage).click();
  p.doc.focused = null;
  assert.equal(p.Q.release(stage, ['团子']), false, '自定义 chosen');
  // 自定义 the form chose by itself (no face's cat can come home) is not a draft; a line written there is, and so are looks picked.
  const nothing = { ...START.unknown, faces: START.unknown.faces.filter((f: Any) => f.id !== 'maine-coon') };
  const q = page({ start: nothing });
  const typed = await q.stage();
  assert.equal(chosen(typed), '自定义');
  q.doc.focused = null;
  assert.equal(q.Q.release(typed, ['团子']), true, 'chosen by the form, not the owner');
  type(control(typed, '它主要帮你做什么'), '陪我练口语');
  q.doc.focused = null;
  assert.equal(q.Q.release(typed, ['团子']), false, 'a line written is the owner\'s');
  const l = page({ start: nothing });
  const looks = await l.stage();
  named(looks, 'qc-look').find(n => n.getAttribute('aria-label') === '暹罗猫')!.click();
  l.doc.focused = null;
  assert.equal(l.Q.release(looks, ['团子']), false, 'looks picked');
  const r = page({ start: await withFaces() });
  assert.equal(r.Q.release(await r.stage(), ['团子']), true, 'untouched');
});

test('moving to 自定义 or back glides the re-centred stage from where it was; at once under reduced motion', async () => {
  const p = page({ start: await withFaces() });
  const stage = await p.stage();
  const root = stage.closest('SECTION')!;
  const glides: Any[] = [];
  root.animate = (frames: Any, options: Any) => { glides.push({ frames, options }); return { finished: Promise.resolve() }; };
  // Where the stage is before the change, then after it re-centred.
  const tops = (...values: number[]) => { root.getBoundingClientRect = () => ({ left: 0, top: values.shift() ?? 0, width: 800, height: 500 }); };
  tops(240, 160); // the form grew, so the centred stage moved up 80 px
  ownTile(stage).click();
  assert.deepEqual(plain(glides), [{ frames: [{ transform: 'translateY(80px)' }, { transform: 'none' }], options: { duration: 180, easing: 'ease-out' } }]);
  p.window.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  tops(160, 240);
  face(stage, '布偶猫').click();
  assert.equal(glides.length, 1, 'no glide under reduced motion');
  assert.equal(chosen(stage), '布偶猫');
});

test('the tiles wrap for any number of faces, the card keeps each line of words to two, the panel goes under the cats unless there is room (stacked is the default), and motion stops under reduced motion', () => {
  const css = read('client/public/quick-create.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const wide = /@container \(min-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)![1];
  const still = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)![1];
  const outside = css.replace(/@container[\s\S]*?\n\}/g, '');
  assert.match(css, /\.qc-group \{ display: flex; flex-wrap: wrap;/, 'no fixed number of columns');
  assert.doesNotMatch(css, /repeat\(8/);
  assert.match(css, /\.qc-flow \{[^}]*container-type: inline-size;/, 'the layout follows the room the flow has (the stage or the dialog)');
  // Stacked by default — where container queries are unsupported too — and side by side only where the query turns it on.
  assert.match(outside, /\.qc-meet \{ display: flex; flex-direction: column;/, 'the panel under the cats by default');
  assert.doesNotMatch(outside, /\.qc-meet \{[^}]*display: grid/, 'never the wide layout without the query');
  assert.match(outside, /\.qc-face \{\s*flex: 0 0 calc\(25% - 3px\);/);
  assert.doesNotMatch(css, /@container \(max-width/);
  assert.match(wide, /\.qc-meet \{ display: grid; grid-template-columns: 300px minmax\(0, 1fr\);[^}]*align-items: start;/, 'the cats beside the panel, each column as tall as it is');
  assert.match(wide, /\.qc-face \{ flex-basis: 72px;/, 'four to a row beside the stage\'s panel');
  assert.match(wide, /\.qc-card \.qc-meet \{ grid-template-columns: 326px minmax\(0, 1fr\); \}/);
  assert.match(wide, /\.qc-card \.qc-face \{ flex-basis: 62px;/, 'five to a row in the dialog');
  assert.match(css, /\.qc-trait-line \{[^}]*-webkit-line-clamp: 2; overflow: hidden;/, 'two lines each, cut off beyond');
  assert.match(still, /\.qc-trait-line/);
  assert.match(still, /\.qc-own:not\(\[hidden\]\)/);
  // A new portrait steps onto the cushion with the existing rise; still when reduced.
  assert.match(css, /\.qc-hero-pic > svg \{[^}]*animation: rise 180ms ease-out;/);
  assert.match(still, /\.qc-hero-pic > svg/);
  // The new motion: the existing keyframes, 180 ms.
  assert.match(css, /\.qc-trait-line \{[^}]*animation: fade 180ms ease-out;/);
  assert.match(css, /\.qc-own:not\(\[hidden\]\) \{ animation: rise 180ms ease-out; \}/);
  assert.match(css, /\.qc-fresh \{[^}]*animation: fade 180ms ease-out;/);
  assert.match(still, /\.qc-fresh/);
});

// ---------------------------------------------------------------- review fixes (2026-11-12)
// A /xbot-api that keeps the engine's templates the way the server does (b53ae808): /start lists them with their
// rev (or [] while they cannot be read); a creation from a face whose portrait changed since is refused before
// anything is made (409 face_changed), and while the templates cannot be read nothing can be made, custom or not
// (503 faces_unavailable).
function engine(initial: Any[]) {
  const e = { faces: initial, readable: true, made: [] as Any[] };
  const route = (path: string, method: string, body: Any) => {
    if (path.startsWith('/xbot-api/start')) return { ...START.ready, faces: e.readable ? e.faces : [] };
    if (path !== '/xbot-api/bots' || method !== 'POST') return undefined;
    const face = e.readable && e.faces.find(f => f.id === body.simple.face);
    if (!face) throw fail(503, '暂时读不到猫猫的资料，这次没有创建，请稍后再试', 'faces_unavailable');
    // A face's own cat thinks with the face's own tool (b. 48b552a3): none here, or another one asked for, is refused before anything is made.
    // The server's own sentence (server/native/bridge.ts, b799841a).
    if (!body.simple.custom && face.tool && !face.tool.usable) throw fail(422, face.tool.state === 'login' ? face.tool.reason + '，登录后再试。' : face.tool.reason + '，这只猫猫现在领不了。' + (face.tool.state === 'missing' ? '装好并登录后再试，或者' : '可以') + '改用「自定义」。', 'face_unavailable');
    if (!body.simple.custom && body.simple.agent && face.tool && body.simple.agent !== face.tool.id) throw fail(422, '这只猫猫用 ' + face.tool.label + ' 来思考，不能另选；想自己选，请用「自定义」。', 'face_tool');
    if (!body.simple.custom && body.simple.rev && body.simple.rev !== face.rev) throw fail(409, '这只猫猫的介绍刚刚更新了，请再看一眼后重试', 'face_changed');
    e.made.push(body);
    return { name: body.name, native_id: 'bot-' + e.made.length };
  };
  return { e, route };
}
const edited = (id: string, change: Any) => realFaces(t => t.map(x => (x.id === id ? { ...x, ...change } : x)));

test('review fixes (rules): a face\'s own cat carries the rev it showed and a custom one none; face_changed and faces_unavailable are refusals, not the name or an unsure creation; with no readable face nothing can be made', async () => {
  const { R, doc } = page();
  const real = await realFaces(), maine = real.find(f => f.id === 'maine-coon');
  assert.match(maine.rev, /^[0-9a-f]{16}$/);
  const presets = presetsOf(doc);
  assert.equal(plain(R.offer(R.start({ ...START.ready, faces: real }).faces, presets)).find((f: Any) => f.id === 'maine-coon').rev, maine.rev);
  const m = /const simpleCat = (z\.object\([\s\S]*?\)\.strict\(\));/.exec(read('server/xbot/core.ts'))!;
  const simpleCat = new Function('z', 'catFaces', 'return ' + m[1])(z, catFaces);
  const own = plain(R.catBody({ name: '砚砚', face: 'maine-coon', rev: maine.rev, agent: 'codex' }));
  assert.deepEqual(own.simple, { face: 'maine-coon', rev: maine.rev });
  assert.equal(simpleCat.safeParse(own.simple).success, true, 'the server\'s own schema takes it');
  assert.deepEqual(plain(R.catBody({ name: '砚砚', face: 'maine-coon', rev: maine.rev, agent: 'codex', custom: true })).simple, { face: 'maine-coon', custom: true, agent: 'codex' }, 'a custom cat has no portrait to compare');
  assert.notEqual(R.fingerprint(own), R.fingerprint(R.catBody({ name: '砚砚', face: 'maine-coon', rev: 'ffffffffffffffff', agent: 'codex' })), 'another portrait is another request');
  // The code decides, not the status.
  assert.deepEqual(plain(R.catError(fail(409, '这只猫猫的介绍刚刚更新了，请再看一眼后重试', 'face_changed'), '砚砚')), { kind: 'changed', text: R.FACE_CHANGED });
  assert.equal(R.catError(fail(409, '已经有一只叫这个名字的猫猫了', 'name_taken'), '砚砚').kind, 'name');
  const gone = R.catError(fail(503, '暂时读不到猫猫的资料，这次没有创建，请稍后再试', 'faces_unavailable'), '砚砚');
  assert.deepEqual(plain(gone), { kind: 'unavailable', text: '刚才没能读到猫猫的资料，这次没有建。' });
  assert.equal(R.catError(fail(503, '服务出了点问题'), '砚砚').kind, 'unsure', 'a 503 without the code stays unsure');
  // Whether anything can be made at all.
  assert.equal(R.usable(real, presets), true);
  assert.equal(R.usable([], presets), false, 'the templates could not be read');
  assert.equal(R.usable([{ id: 'sphynx' }], presets), false, 'none this client can draw');
  assert.equal(R.usable(null, presets), true, 'a server older than faces[] is not second-guessed');
  const need = plain(R.facesNeed());
  assert.equal(need.title, '暂时读不到猫猫的资料');
  assert.doesNotMatch(JSON.stringify(need), /Agent|Bot|模型|模板/);
  // 重新检测 notices the faces coming back.
  assert.equal(R.sameStart(R.start({ ...START.ready, faces: [] }), R.start({ ...START.ready, faces: [] })), true);
  assert.equal(R.sameStart(R.start({ ...START.ready, faces: [] }), R.start({ ...START.ready, faces: real })), false);
});

test('review fixes: the fake api drops a 5xx\'s code unless asked, exactly as the shell\'s apiFetch does, so the faces_unavailable tests below test the real path', () => {
  const app = read('client/public/app.js');
  const apiFetch = /async function apiFetch\(path, opt, serverError\) \{[\s\S]*?\n {2}\}\n/.exec(app)![0];
  assert.match(apiFetch, /if \(res\.status >= 500 && !serverError\) \{\s*const err = new Error\("服务出了点问题，请稍后再试。"\);/);
  assert.match(app, /const res = await apiFetch\(path, \{[\s\S]*?\}, opt\.serverError\);/);
  assert.match(app, /if \(typeof data\.code === "string"\) err\.code = data\.code;/);
});

test('review fixes: creating from a face sends the rev of the portrait whose hint is on screen; 自定义 sends none', async () => {
  const real = await realFaces();
  const p = page({ start: { ...START.ready, faces: real } });
  const stage = await p.stage();
  face(stage, '缅因猫').click();
  button(stage, '带它回家').click();
  await settle();
  assert.deepEqual(p.posts()[0].body.simple, { face: 'maine-coon', rev: real.find(f => f.id === 'maine-coon').rev });
  const q = page({ start: { ...START.ready, faces: real } });
  const custom = await q.stage();
  ownTile(custom).click();
  type(control(custom, '名字'), '小白');
  button(custom, '带它回家').click();
  await settle();
  assert.deepEqual(q.posts()[0].body.simple, { face: 'ragdoll', custom: true, agent: 'claude' });
});

test('review fixes: a portrait changed since the screen read it (face_changed) is read again and shown with a quiet note; nothing is sent by itself, and the next try is a new request', async () => {
  const { e, route } = engine(await realFaces());
  const p = page({ route });
  const stage = await p.stage();
  face(stage, '缅因猫').click();
  assert.deepEqual(hint(stage), ['严谨认真，注重细节，会直言不讳地指出问题', '擅长 Review、找 bug、coding 落地']);
  // Upstream edits 缅因猫's portrait while the screen is open.
  e.faces = await edited('maine-coon', { personality: '更严谨了，什么都要再看一遍', teamStrengths: '把关' });
  const go = button(stage, '带它回家');
  go.click();
  await settle();
  assert.equal(p.posts().length, 1, 'not sent again by itself');
  assert.deepEqual(e.made, []);
  assert.equal(p.calls.filter(c => c.path.startsWith('/xbot-api/start')).length, 2, 'the faces are read again');
  assert.equal(chosen(stage), '缅因猫', 'still the face the owner had');
  assert.deepEqual(hint(stage), ['更严谨了，什么都要再看一遍', '擅长把关']);
  assert.equal(visibleText(one(stage, 'qc-fresh')), p.R.FACE_CHANGED);
  assert.equal(voice(stage).textContent, p.R.FACE_CHANGED + '更严谨了，什么都要再看一遍。擅长把关。它用这台电脑上的 Codex 来思考');
  assert.equal(control(stage, '名字').getAttribute('aria-invalid'), null, 'not a taken name');
  assert.equal(shown(one(stage, 'qc-error')), false, 'nor an error');
  assert.equal(p.refreshed, 0, 'nor an unsure creation');
  assert.equal(p.doc.activeElement, go);
  // The owner has looked: the next try carries the new rev under a new key and makes the cat.
  go.click();
  await settle();
  const [first, second] = p.posts().map(c => c.body);
  assert.equal(second.simple.rev, e.faces.find(f => f.id === 'maine-coon').rev);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey, 'the refused body left no key behind');
  assert.equal(e.made.length, 1);
  assert.deepEqual(p.opened, ['砚砚']);
  // Picking a face puts the note away.
  const t = engine(await realFaces());
  const q = page({ route: t.route });
  const other = await q.stage();
  t.e.faces = await edited('ragdoll', { personality: '换了个性子' });
  button(other, '带它回家').click();
  await settle();
  assert.equal(shown(one(other, 'qc-fresh')), true);
  face(other, '缅因猫').click();
  assert.equal(shown(one(other, 'qc-fresh')), false);
});

test('review fixes: faces_unavailable is said plainly — nothing was made — with 重新检测, never as an unsure creation; its key is dropped', async () => {
  const { e, route } = engine(await realFaces());
  const p = page({ route });
  const stage = await p.stage();
  ownTile(stage).click(); // a custom cat needs the template's colour too
  type(control(stage, '名字'), '小白');
  e.readable = false;
  button(stage, '带它回家').click();
  await settle();
  const need = one(stage, 'qc-need');
  assert.equal(shown(need), true);
  assert.match(visibleText(need), /^暂时读不到猫猫的资料/);
  assert.equal(visibleText(one(need, 'qc-note')), '刚才没能读到猫猫的资料，这次没有建。');
  assert.doesNotMatch(visibleText(stage), /没能确认|不改内容/);
  assert.equal(shown(one(stage, 'qc-fields')), false, 'no form that could only be refused');
  assert.equal(p.refreshed, 0, 'not an unsure creation: the list is not searched for it');
  button(stage, '重新检测').click();
  await settle();
  assert.equal(visibleText(one(stage, 'qc-note')), '重新检测过了，还是读不到猫猫的资料。');
  e.readable = true;
  button(stage, '重新检测').click();
  await settle();
  assert.equal(shown(one(stage, 'qc-fields')), true);
  assert.equal(chosen(stage), '自定义', '自定义 is still chosen');
  assert.equal(p.doc.activeElement, control(stage, '名字'));
  button(stage, '带它回家').click();
  await settle();
  const [first, second] = p.posts().map(c => c.body);
  assert.deepEqual(second.simple, first.simple);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey, 'a refusal leaves no key behind');
  assert.equal(e.made.length, 1);
  // A passing outage: /start reads the faces at once, so the form stays and says it may be pressed again.
  const t = engine(await realFaces());
  let once = true;
  const q = page({ route: (path, method, body) => { if (path === '/xbot-api/bots' && method === 'POST' && once) { once = false; throw fail(503, '暂时读不到猫猫的资料，这次没有创建，请稍后再试', 'faces_unavailable'); } return t.route(path, method, body); } });
  const form = await q.stage();
  button(form, '带它回家').click();
  await settle();
  assert.equal(shown(one(form, 'qc-fields')), true);
  assert.equal(visibleText(one(form, 'qc-error')), '刚才没能读到猫猫的资料，这次没有建。现在读到了，再点一次就好。');
  button(form, '带它回家').click();
  await settle();
  assert.notEqual(q.posts()[1].body.idempotencyKey, q.posts()[0].body.idempotencyKey);
  assert.equal(t.e.made.length, 1);
});

test('review fixes: when /start could read no faces, the screens say the cats\' details cannot be read and offer 重新检测, not a creation the server would refuse', async () => {
  const { e, route } = engine(await realFaces());
  e.readable = false;
  const p = page({ route });
  const stage = await p.stage();
  assert.match(visibleText(one(stage, 'qc-need')), /^暂时读不到猫猫的资料猫猫们的样子和性格现在读不出来/);
  assert.equal(all(stage).some(n => n.tagName === 'BUTTON' && ['带它回家', '自定义'].includes(n.textContent) && shown(n)), false);
  assert.equal(one(stage, 'qc-faces').getAttribute('aria-hidden'), 'true', 'the row is only a picture');
  stage.dispatch('submit');
  await settle();
  assert.equal(p.posts().length, 0, 'nothing is sent that could only be refused');
  button(stage, '重新检测').click();
  await settle();
  assert.equal(p.calls.at(-1)!.path, '/xbot-api/start?refresh=1');
  assert.equal(visibleText(one(stage, 'qc-note')), '重新检测过了，还是读不到猫猫的资料。');
  e.readable = true;
  button(stage, '重新检测').click();
  await settle();
  assert.equal(shown(one(stage, 'qc-fields')), true);
  assert.deepEqual(hint(stage), ['温柔但有主见，喜欢深入分析问题，写代码快但注重质量', '擅长架构设计、写代码一把好手']);
  assert.equal(p.doc.activeElement, control(stage, '名字'));
  button(stage, '带它回家').click();
  await settle();
  assert.equal(e.made.length, 1);
  // The 新建猫猫 dialog says the same, with 更多设置 still there.
  e.readable = false;
  const q = page({ cats: ['团子'], route });
  q.Q.openCat({ opener: q.opener });
  await settle();
  const card = one(q.layer()!, 'qc-card');
  assert.match(visibleText(card), /暂时读不到猫猫的资料/);
  assert.ok(button(card, '更多设置'));
  assert.equal(all(card).some(n => n.tagName === 'BUTTON' && n.textContent === '创建' && shown(n)), false);
});

test('review fixes: a re-read that keeps the tool and the chosen face but brings new words shows them at once, without announcing them', async () => {
  const { e, route } = engine(await realFaces());
  let refuse = true;
  const p = page({ route: (path, method, body) => { if (path === '/xbot-api/bots' && method === 'POST' && refuse) { refuse = false; throw fail(422, '请先在本机 Agent 中完成登录'); } return route(path, method, body); } });
  const stage = await p.stage();
  face(stage, '缅因猫').click();
  const said = voice(stage).textContent;
  // A 422 makes the screen read /start again: the same tool, the same ids, new words for 缅因猫.
  e.faces = await edited('maine-coon', { personality: '安静了一些，但还是很有想法' });
  button(stage, '带它回家').click();
  await settle();
  assert.equal(shown(one(stage, 'qc-fields')), true, 'the tool is usable: the form stays');
  assert.equal(chosen(stage), '缅因猫');
  assert.deepEqual(hint(stage), ['安静了一些，但还是很有想法', '擅长 Review、找 bug、coding 落地'], 'without clicking the face again');
  assert.equal(voice(stage).textContent, said, 'not announced: nobody chose anything');
  button(stage, '带它回家').click();
  await settle();
  assert.equal(p.posts().at(-1)!.body.simple.rev, e.faces.find(f => f.id === 'maine-coon').rev, 'and the next try is for the words on screen');
  assert.equal(e.made.length, 1);
});

// ---------------------------------------------------------------- a cat's tool is part of the cat (2026-11-12, item 37)
// The owner, looking at 暹罗猫 with a tool dropdown beside it: which tool a cat thinks with is part of its
// template; a template whose tool is not on this computer cannot be used as it is. faces[].tool says it
// (docs/xbot-api.md「开箱即用」); POST /xbot-api/bots binds a face's own tool and refuses one that is not
// usable here (422 face_unavailable) or another one (422 face_tool).
const awayFaces = (root: El) => faces(root).filter(f => has(f, 'away')).map(breedOf);
const idOf = (root: El, cls: string) => one(root, cls).id;

test('a cat whose own Agent is not usable here is told apart by the layout, not by words: set apart after those that can come home, with its reason as its description; chosen, its Agent mark carries the state in one word, 带它回家 sends nothing, and one button, 自定义, is the way on', async () => {
  const p = page();
  const stage = await p.stage();
  // Before any hover or choice: those that can come home, 自定义, then, in a group set apart, those that cannot.
  assert.deepEqual(tiles(stage).filter(shown).map(f => f.dataset.face ?? '自定义'), ['ragdoll', 'maine-coon', '自定义', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla']);
  assert.deepEqual(awayFaces(stage), ['暹罗猫', '梵花猫', '蓝灰短毛猫', '狸花猫', '孟加拉猫', '金渐层']);
  assert.equal(has(one(stage, 'qc-faces'), 'split'), true, 'two groups');
  const groups = named(stage, 'qc-group');
  assert.deepEqual(groups.map(g => faces(g).map(breedOf)), [['布偶猫', '缅因猫'], ['暹罗猫', '梵花猫', '蓝灰短毛猫', '狸花猫', '孟加拉猫', '金渐层']]);
  assert.deepEqual(groups.map(g => has(g, 'later')), [false, true], 'the second is the later group: smaller tiles over empty dashed cushions (the CSS test below)');
  assert.equal(groups[0].contains(ownTile(stage)), true, '自定义 sits with the cats that can come home');
  // No heading over either group and no word on a tile (item 45): the row shows the cats' names and 自定义, nothing else.
  assert.equal(seenText(one(stage, 'qc-faces')), '宪宪砚砚自定义烁烁墨墨鲸鲸小狸花斑斑金哥');
  assert.equal(groups.every(g => g.children.every(c => has(c, 'qc-face'))), true, 'a group holds tiles only');
  // A screen reader still hears who each one is (its name) and, for one that cannot come home, why (its description, in the
  // server's words, said the way a person would).
  const kimi = face(stage, '梵花猫');
  assert.equal(kimi.getAttribute('aria-label'), '墨墨，梵花猫');
  assert.equal(all(stage).find(n => n.id === kimi.getAttribute('aria-describedby'))?.textContent, '这台电脑上还没有装 Kimi，现在领不了。', 'its reason, in the server\'s words, as its description');
  assert.equal(all(stage).find(n => n.id === face(stage, '暹罗猫').getAttribute('aria-describedby'))?.textContent, '暂不支持 Gemini，现在领不了。');
  assert.equal(has(all(stage).find(n => n.id === kimi.getAttribute('aria-describedby'))!, 'qc-sr'), true, 'said, not shown');
  assert.equal(face(stage, '布偶猫').getAttribute('aria-describedby'), null);
  assert.equal(kimi.getAttribute('title'), null, 'not a hover title');
  assert.equal(face(stage, '暹罗猫').disabled, false, 'still a cat to choose: its looks can be borrowed');
  face(stage, '梵花猫').click();
  // On its card the Agent mark carries the state, in one word (dashed, like its cushion); a screen reader hears a sentence.
  assert.equal(mark(stage), 'Kimi未安装');
  assert.equal(markSaid(stage), '它要用 Kimi 来思考，未安装');
  assert.equal(has(one(stage, 'qc-agent'), 'away'), true);
  const line = one(stage, 'qc-uses-line');
  assert.equal(visibleText(line), '这台电脑上还没有装 Kimi，现在领不了。');
  assert.equal(has(line, 'qc-sr'), true, 'why is said (创建\'s description), not a caption');
  assert.equal(has(one(stage, 'qc-about'), 'away'), true, 'its cushion empty and outlined');
  // What can be done is the button itself (the sentence is said): installed, then 重新检测.
  assert.equal(seenText(one(stage, 'qc-uses-more')), '重新检测');
  assert.match(visibleText(one(stage, 'qc-uses-more')), /^装好 Kimi 并登录后再重新检测/);
  const go = all(stage).find(n => has(n, 'qc-go'))!;
  assert.equal(go.getAttribute('aria-disabled'), 'true', 'not available, but still focusable');
  assert.equal(go.disabled, false);
  assert.equal(go.getAttribute('aria-describedby'), line.id, 'a screen reader finds why on the button itself');
  // The way on: one button, 自定义 — named for a screen reader 「用它的长相自定义」, described by the Agent it would use.
  const borrow = one(stage, 'qc-borrow');
  assert.equal(shown(borrow), true);
  assert.equal(seenText(borrow), '自定义');
  assert.equal(borrow.getAttribute('aria-label'), '用它的长相自定义');
  assert.equal(seenText(one(stage, 'qc-forward')), '自定义', 'nothing beside it on screen');
  assert.equal(visibleText(one(stage, 'qc-ahead')), '用这台电脑上的 Agent 来思考');
  assert.equal(borrow.getAttribute('aria-describedby'), idOf(stage, 'qc-ahead'));
  assert.equal(voice(stage).textContent, '细心务实，保留自己的判断，愿意把事情接住做完。擅长编码、文档、验收。它要用 Kimi 来思考。这台电脑上还没有装 Kimi，现在领不了。可以用它的长相自定义，用这台电脑上的 Agent 来思考');
  // On screen, the card says nothing that explains the interface.
  assert.equal(seenText(one(stage, 'qc-tail')), '重新检测自定义');
  // Enter in the name field presses 带它回家: nothing is sent, and focus goes to the way on.
  const name = control(stage, '名字');
  name.focus();
  name.key('Enter');
  await settle();
  assert.equal(p.posts().length, 0);
  assert.equal(p.doc.activeElement === borrow, true);
  // So does pressing it.
  go.focus();
  go.click();
  await settle();
  assert.equal(p.posts().length, 0);
  assert.equal(p.doc.activeElement === borrow, true);
  // The card's 自定义: 自定义 with its looks, in one step; focus on those looks; said once.
  borrow.click();
  assert.equal(chosen(stage), '自定义');
  assert.equal(looksChosen(stage), '梵花猫');
  assert.equal(p.doc.activeElement.getAttribute('aria-label'), '梵花猫', 'focus on the looks it took');
  assert.equal(voice(stage).textContent, p.R.OWN_NOTE);
  assert.deepEqual(awayFaces(stage), ['暹罗猫', '梵花猫', '蓝灰短毛猫', '狸花猫', '孟加拉猫', '金渐层'], 'the row still says which cats cannot come home as they are');
  assert.equal(named(stage, 'qc-look').filter(n => has(n, 'away')).length, 0, 'as a look, every face is eligible');
  assert.equal(shown(line), false);
  assert.equal(shown(one(stage, 'qc-forward')), false);
  assert.equal(go.getAttribute('aria-disabled'), null);
  assert.equal(go.getAttribute('aria-describedby'), null);
  assert.equal(control(stage, '名字').value, '', '自定义 borrows no template\'s name');
  assert.equal(control(stage, '名字').placeholder, '给它起个名字');
  const select = one(stage, 'qc-tool-line').querySelectorAll('select')[0];
  assert.deepEqual(select.children.map(o => o.value), ['codex', 'claude']);
  assert.equal(select.value, 'codex', 'its own tool is not here: the usual one');
  type(control(stage, '名字'), '小墨');
  go.click();
  await settle();
  assert.deepEqual(p.posts()[0].body.simple, { face: 'turkish-van', custom: true, agent: 'codex' });
  assert.deepEqual(p.opened, ['小墨']);
});

test('the dialog says the same: the tile set apart, the state on its card\'s Agent mark, 创建 not available, 自定义 the one way on, focus in order', async () => {
  const p = page({ cats: ['团子'] });
  p.opener.focus();
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  assert.equal(chosen(card), '布偶猫');
  assert.equal(mark(card), 'Claude Code');
  assert.equal(markSaid(card), '它用这台电脑上的 Claude Code 来思考');
  assert.equal(all(card).filter(n => n.tagName === 'SELECT' && shown(n)).length, 0, 'no tool to pick for a face\'s own cat');
  face(card, '暹罗猫').click();
  assert.deepEqual(nickOf(card), ['烁烁', '暹罗猫']);
  assert.deepEqual(hint(card), ['热血奔放，善于用视觉语言表达想法，表达力是全队最强的', '擅长审美、前端设计风格、打破常规']);
  assert.equal(mark(card), 'Gemini暂不支持', 'the Agent mark carries the state');
  assert.equal(markSaid(card), '它要用 Gemini 来思考，暂不支持');
  assert.equal(visibleText(one(card, 'qc-uses-line')), '暂不支持 Gemini，现在领不了。');
  assert.equal(shown(one(card, 'qc-uses-more')), false, 'nothing to install or log in on this computer: nothing to re-detect');
  // On screen: the cat, its words, the mark, one action (自定义) and the name; nothing that explains the interface.
  assert.equal(seenText(one(card, 'qc-tail')), '自定义');
  assert.doesNotMatch(seenText(card), /领不了|按原样|接不上|只借|装好|所以/);
  const go = all(card).find(n => n.tagName === 'BUTTON' && n.type === 'submit')!;
  assert.equal(go.getAttribute('aria-disabled'), 'true');
  assert.equal(go.getAttribute('aria-describedby'), idOf(card, 'qc-uses-line'));
  // What Tab walks through: the switch's selected side (item 43), the row, 自定义 (the way on, said 「用它的长相自定义」), the
  // name, 更多设置, 取消, and 创建 — reachable, saying it is not available and why.
  const stops = all(card).filter(n => ['BUTTON', 'INPUT', 'SELECT'].includes(n.tagName) && shown(n) && n.tabIndex >= 0 && !n.disabled);
  const name = (n: El) => n.getAttribute('aria-label') || all(card).find(l => l.tagName === 'LABEL' && l.htmlFor === n.id)?.textContent || n.textContent;
  assert.deepEqual(stops.map(name), ['猫猫', '烁烁，暹罗猫', '用它的长相自定义', '名字', '更多设置', '取消', '创建']);
  control(card, '名字').key('Enter');
  await settle();
  assert.equal(p.posts().length, 0);
  assert.equal(p.doc.activeElement === one(card, 'qc-borrow'), true, 'Enter in the name takes the owner to the way on');
  // Back to a cat that can come home (walking past 自定义): 创建 again, nothing left over.
  face(card, '暹罗猫').key('ArrowLeft');
  assert.equal(chosen(card), '自定义');
  ownTile(card).key('ArrowLeft');
  assert.equal(chosen(card), '缅因猫');
  assert.equal(go.getAttribute('aria-disabled'), null);
  assert.equal(shown(one(card, 'qc-forward')), false);
  assert.equal(shown(one(card, 'qc-uses-line')), false);
  card.dispatch('submit');
  await settle();
  assert.deepEqual(p.posts()[0].body.simple, { face: 'maine-coon', rev: START.ready.faces[1].rev });
});

test('with no face whose cat can come home but a tool that is here, 自定义 is what the form presents first (not counted as the owner\'s draft), every cat marked as it is; one tool is named, not offered as a select', async () => {
  const start = { ...START.unknown, faces: START.unknown.faces.filter((f: Any) => f.id !== 'maine-coon') };
  const p = page({ start });
  const stage = await p.stage();
  assert.equal(chosen(stage), '自定义');
  assert.deepEqual(tiles(stage).filter(shown).map(f => f.dataset.face ?? '自定义'), ['自定义', 'ragdoll', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla']);
  assert.deepEqual(awayFaces(stage), ['布偶猫', '暹罗猫', '梵花猫', '蓝灰短毛猫', '狸花猫', '孟加拉猫', '金渐层']);
  assert.equal(looksChosen(stage), '布偶猫', 'the first face, for its looks');
  assert.deepEqual(nickOf(stage), []);
  assert.equal(control(stage, '名字').value, '', 'no template\'s name');
  assert.equal(visibleText(one(stage, 'qc-tool-line')), '它会用这台电脑上的 Codex 来思考，未确认登录', 'one tool: said, not a select');
  assert.equal(seenText(one(stage, 'qc-tool-line')), 'Codex未确认登录', 'on screen, the mark alone');
  assert.equal(all(stage).filter(n => n.tagName === 'SELECT').length, 0);
  assert.equal(button(stage, '带它回家').disabled, false);
  p.doc.focused = null;
  assert.equal(p.Q.release(stage, ['团子']), true, 'the form chose 自定义, not the owner: an untouched stage');
  button(stage, '带它回家').click();
  await settle();
  assert.equal(p.posts().length, 0, 'a cat of the owner\'s own needs a name of the owner\'s');
  assert.equal(errOf(stage, '名字').textContent, '给它起个名字吧');
  type(control(stage, '名字'), '小白');
  button(stage, '带它回家').click();
  await settle();
  assert.deepEqual(p.posts()[0].body.simple, { face: 'ragdoll', custom: true, agent: 'codex' });
});

test('自定义\'s tool: the cat on screen\'s own when it is here, so turning 自定义 on changes nothing silently; the owner\'s pick is kept across switching; another tool is another request, the same body the same key', async () => {
  let lose = true;
  const p = page({ start: START.three, route: (path, method) => { if (path === '/xbot-api/bots' && method === 'POST' && lose) throw fail(undefined, '连不上 clowder-bot'); return undefined; } });
  const stage = await p.stage();
  const own = ownTile(stage), go = button(stage, '带它回家');
  const select = () => one(stage, 'qc-tool-line').querySelectorAll('select')[0];
  const look = (label: string) => named(stage, 'qc-look').find(n => n.getAttribute('aria-label') === label)!;
  face(stage, '梵花猫').click();
  assert.equal(markSaid(stage), '它用这台电脑上的 Kimi 来思考');
  own.click();
  assert.deepEqual(select().children.map(o => o.value), ['codex', 'claude', 'kimi']);
  assert.equal(select().value, 'kimi', 'the tool 梵花猫 was shown with');
  // Untouched, it follows the cat on screen the next time 自定义 is chosen.
  face(stage, '布偶猫').click();
  own.click();
  assert.equal(select().value, 'claude');
  type(control(stage, '名字'), '小白');
  go.click(); await settle(); // custom, claude: unsure, key A
  choose(select(), 'codex');
  face(stage, '布偶猫').click(); own.click(); // there and back: the pick stays
  look('缅因猫').click(); look('布偶猫').click(); // other looks and back
  assert.equal(select().value, 'codex', 'the owner\'s pick stays, whatever looks');
  go.click(); await settle(); // custom, codex: another request
  choose(select(), 'claude');
  lose = false;
  go.click(); await settle(); // custom, claude again: key A, and it lands
  const [a, b, c] = p.posts().map(x => x.body);
  assert.deepEqual(a.simple, { face: 'ragdoll', custom: true, agent: 'claude' });
  assert.deepEqual(b.simple, { face: 'ragdoll', custom: true, agent: 'codex' });
  assert.notEqual(b.idempotencyKey, a.idempotencyKey, 'another tool is another request');
  assert.deepEqual(c, a, 'the same body, the same key');
  // The template's own cat never carries 自定义's tool.
  const q = page({ start: START.three });
  const other = await q.stage();
  ownTile(other).click();
  choose(one(other, 'qc-tool-line').querySelectorAll('select')[0], 'kimi');
  face(other, '布偶猫').click();
  button(other, '带它回家').click();
  await settle();
  assert.deepEqual(q.posts()[0].body.simple, { face: 'ragdoll', rev: START.three.faces[0].rev });
});

test('face_unavailable: the server\'s sentence, /start read again and the screen repainted; the request leaves no key; the card\'s 自定义 is where focus goes, or 带它回家 again when the tool came back', async () => {
  // The screen read 布偶猫 as usable; Claude Code was signed out before the click.
  const signedOut = (await summary(computer('configured', 'login_required'))).faces;
  const { e, route } = engine(START.ready.faces);
  const p = page({ route });
  const stage = await p.stage();
  e.faces = signedOut;
  button(stage, '带它回家').click();
  await settle();
  assert.equal(e.made.length, 0);
  assert.deepEqual(p.calls.map(c => c.method + ' ' + c.path), ['GET /xbot-api/start', 'POST /xbot-api/bots', 'GET /xbot-api/start']);
  assert.equal(visibleText(one(stage, 'qc-error')), 'Claude Code 还没有登录，登录后再试。');
  assert.equal(chosen(stage), '布偶猫', 'the owner\'s cat stays on screen, as it is now');
  assert.equal(mark(stage), 'Claude Code未登录');
  assert.equal(seenText(one(stage, 'qc-uses-more')), 'claude auth login复制重新检测', 'on screen, the command and 重新检测');
  assert.match(toolSaid(stage), /^它要用 Claude Code 来思考，未登录Claude Code 还没有登录，现在领不了。在终端里运行这行命令登录，再重新检测claude auth login复制重新检测$/);
  // Its tile has moved to the later group, and says why to a screen reader.
  assert.equal(named(stage, 'qc-group')[1].contains(face(stage, '布偶猫')), true, 'set apart with the cats that cannot come home, now');
  assert.equal(all(stage).find(n => n.id === face(stage, '布偶猫').getAttribute('aria-describedby'))?.textContent, 'Claude Code 还没有登录，现在领不了。');
  const go = all(stage).find(n => has(n, 'qc-go'))!;
  assert.equal(go.getAttribute('aria-disabled'), 'true');
  assert.equal(p.doc.activeElement === one(stage, 'qc-borrow'), true);
  assert.equal(p.refreshed, 0, 'nothing was made: not an unsure creation');
  // Signed in again; the owner presses 重新检测 beside the login, and the cat can come home.
  e.faces = START.ready.faces;
  const again = button(stage, '重新检测');
  again.focus();
  again.click();
  await settle();
  assert.equal(p.calls.at(-1)!.path, '/xbot-api/start?refresh=1');
  assert.equal(markSaid(stage), '它用这台电脑上的 Claude Code 来思考');
  assert.equal(go.getAttribute('aria-disabled'), null);
  assert.equal(shown(one(stage, 'qc-uses-more')), false, 'no login left to do');
  assert.equal(shown(one(stage, 'qc-error')), false, 'the refusal no longer holds, so it is gone');
  assert.equal(shown(one(stage, 'qc-forward')), false);
  assert.equal(p.doc.activeElement === go, true, 'the button that went away hands focus on to what can be done now');
  assert.match(voice(stage).textContent, /它用这台电脑上的 Claude Code 来思考$/, 'said once: the owner asked');
  go.click();
  await settle();
  const [first, second] = p.posts().map(c => c.body);
  assert.deepEqual(second.simple, first.simple);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey, 'a refusal leaves no key behind');
  assert.equal(e.made.length, 1);
  // A tool that is back by the time /start is read again: the sentence, and that it may be pressed again.
  let once = true;
  const t = engine(START.ready.faces);
  const q = page({ route: (path, method, body) => { if (path === '/xbot-api/bots' && method === 'POST' && once) { once = false; throw fail(422, 'Claude Code 还没有登录，登录后再试。', 'face_unavailable'); } return t.route(path, method, body); } });
  const form = await q.stage();
  button(form, '带它回家').click();
  await settle();
  assert.equal(visibleText(one(form, 'qc-error')), 'Claude Code 还没有登录，登录后再试。重新检测过，现在能用了，再点一次就好。');
  assert.equal(q.doc.activeElement === button(form, '带它回家'), true);
});

test('a login beside a face: 重新检测 says plainly when nothing changed and keeps focus; face_tool and face_unavailable are refusals told in the server\'s words', async () => {
  const p = page({ start: START.codexLogin });
  const stage = await p.stage();
  assert.equal(chosen(stage), '布偶猫');
  face(stage, '缅因猫').click();
  const uses = one(stage, 'qc-uses-more');
  assert.match(toolSaid(stage), /^它要用 Codex 来思考，未登录Codex 还没有登录，现在领不了。在终端里运行这行命令登录，再重新检测codex login复制重新检测$/);
  assert.equal(visibleText(one(stage, 'qc-ahead')), '用这台电脑上的 Claude Code 来思考', 'one tool here: named');
  button(uses, '复制').click();
  await settle();
  assert.deepEqual(p.copied, ['codex login']);
  const again = button(uses, '重新检测');
  const said = voice(stage).textContent;
  again.focus();
  again.click();
  assert.equal(again.getAttribute('aria-disabled'), 'true', 'inert while checking, still holding focus');
  again.click();
  await settle();
  assert.equal(p.calls.filter(c => c.path === '/xbot-api/start?refresh=1').length, 1, 'one check at a time');
  assert.equal(visibleText(one(stage, 'qc-uses-note')), '重新检测过了，还是没检测到登录。');
  assert.equal(p.doc.activeElement === again, true, 'nothing changed: focus stays');
  assert.equal(voice(stage).textContent, said, 'nothing new is announced');
  // The rules: both refusals keep the server's sentence (it says what would help), or say plainly which tool.
  const { R } = p;
  assert.deepEqual(plain(R.catError(fail(422, '这只猫猫用 Claude Code 来思考，不能另选；想自己选，请用「自定义」。', 'face_tool'), '宪宪')), { kind: 'face', text: '这只猫猫用 Claude Code 来思考，不能另选；想自己选，请用「自定义」。' });
  assert.deepEqual(plain(R.catError(fail(422, '暂不支持 Gemini，这只猫猫现在领不了。可以改用「自定义」', 'face_unavailable'), '烁烁')), { kind: 'face', text: '暂不支持 Gemini，这只猫猫现在领不了。可以改用「自定义」。' });
  assert.equal(R.catError(fail(422, 'Agent unavailable', 'face_unavailable'), '烁烁', 'Gemini').text, '刚才没能建好：Gemini 现在用不了。', 'never the adapter\'s words');
  assert.equal(R.catError(fail(422, '请先在本机 Agent 中完成登录'), '宪宪', 'Claude Code').kind, 'blocked', 'a 422 without the code is still what blocks every tool');
});

test('a cat that cannot come home as it is is told by the layout (item 45): set apart in a later group of smaller, quieter tiles over empty dashed cushions, while those that can sit on solid ones — a shape and a size, not colour or paleness alone, and no word on a tile; dashed means "not as it is" on its card too; all from the tokens, motion stilled when reduced; the one select is 自定义\'s', () => {
  const css = read('client/public/quick-create.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const still = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)![1];
  const wide = /@container \(min-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)![1];
  // No words left to style: no heading over a group, no word on a tile, no sub-line, no 长相：, no 可不填 (item 45).
  assert.doesNotMatch(css, /qc-group-head|qc-face-tag|qc-sub\b|qc-looks-head|qc-opt\b|qc-uses-text/);
  // The two groups are set apart by space alone.
  assert.match(css, /\.qc-faces \{ display: flex; flex-direction: column; gap: var\(--x-s6\);/);
  assert.match(wide, /\.qc-faces \{ gap: var\(--x-s7\); \}/);
  // Those that can come home: full-size tiles, each cat on a solid cushion.
  assert.match(css, /\.qc-face \{\s*flex: 0 0 calc\(25% - 3px\);/);
  assert.match(css, /\.qc-portrait \{[^}]*width: 48px; height: 48px;/);
  assert.match(css, /\.qc-portrait::before \{[^}]*border-radius: 50%;\s*background: var\(--x-fill-2\);/);
  // Those that cannot: smaller tiles (six to a row against four), smaller portraits and names, quieter, and each over an
  // empty cushion drawn as a dashed outline — a shape the eye reads without colour.
  assert.match(css, /\.qc-group\.later \.qc-face \{ flex-basis: calc\(\(100% - 5 \* var\(--x-s1\)\) \/ 6\);[^}]*color: var\(--x-muted\); \}/);
  assert.match(css, /\.qc-group\.later \.qc-portrait \{ width: 38px; height: 38px; \}/);
  assert.match(css, /\.qc-group\.later \.qc-face-name \{ font-size: var\(--x-fs-cap\);/);
  assert.match(css, /\.qc-face\.away \.qc-portrait::before \{ background: transparent; border: 1\.2px dashed var\(--x-faint\); \}/);
  assert.match(css, /\.qc-face\.away\[aria-checked="true"\] \.qc-portrait::before \{ background: transparent; border-color: var\(--x-text-2\); \}/, 'chosen, still empty and outlined');
  // Side by side the sizes stay apart: 72 / 46 on the stage, 62 / 50 in the dialog.
  assert.match(wide, /\.qc-face \{ flex-basis: 72px;/);
  assert.match(wide, /\.qc-group\.later \.qc-face \{ flex-basis: 46px; \}/);
  assert.match(wide, /\.qc-card \.qc-face \{ flex-basis: 62px;/);
  assert.match(wide, /\.qc-card \.qc-group\.later \.qc-face \{ flex-basis: 50px;/);
  // Chosen, it sits on its card on the same empty, outlined cushion, and its Agent mark (which carries the state) is outlined.
  assert.match(css, /\.qc-about\.away \.qc-hero::before \{ background: transparent; border: 1\.5px dashed var\(--x-faint\); \}/);
  assert.match(css, /\.qc-agent\.away \{ background: transparent; border: 1px dashed var\(--x-faint\); \}/);
  assert.match(css, /\.qc-agent-tag \{ flex: none; color: var\(--x-muted\); \}/);
  // What is said and not shown is visually hidden, never display: none (a screen reader still reads it).
  assert.match(css, /\.qc-sr \{ position: absolute; width: 1px; height: 1px;[^}]*clip-path: inset\(50%\);/);
  assert.doesNotMatch(css, /\.qc-sr \{[^}]*display: none/);
  assert.doesNotMatch(css, /(^|\n)\s*\.qc-side(:has\([^)]*\))? \{[^}]*min-height/, 'no room kept inside the panel: the view seen first has no empty band');
  assert.match(css, /\.qc-about\.described \.qc-trait \{ min-height: calc\(4 \* 21px \+ 2px\); \}/, 'the name holds still among the cats that can come home: two lines and two lines of words');
  assert.match(css, /\.qc-flow \.primary\[aria-disabled="true"\],[^{]*\{\s*background: var\(--fill\); color: var\(--muted\);/, 'drawn as the original disabled .primary');
  assert.match(css, /\.qc-borrow \{[^}]*background: var\(--primary\); color: var\(--primary-text\);/, 'the way on is a button of its own');
  assert.match(still, /\.qc-face, \.qc-portrait, \.qc-portrait::before, \.qc-look, \.qc-pick, \.qc-hero::before/);
  assert.match(still, /\.qc-nick, \.qc-forward, \.qc-fresh/);
  const js = read('client/public/quick-create.js');
  assert.equal((js.match(/node\("select"/g) || []).length, 1);
  assert.match(js, /toolBox\.append\(tool\.element\);\n\s*who\.append\(toolBox\);/, 'the select lives in 自定义\'s card, where a cat\'s Agent mark is');
});

// ---------------------------------------------------------------- review fixes of item 37 (2026-11-12)
test('review: 自定义 turned on by the form is chosen only when the form is first presented; a later /start that makes a face usable never turns the owner\'s draft into a template', async () => {
  // Only 梵花猫 is offered and Kimi is not here: the form opens in 自定义.
  const only = (start: Any) => ({ ...start, faces: start.faces.filter((f: Any) => f.id === 'turkish-van') });
  let refuse = true;
  const p = page({ start: only(START.ready), route: (path, method) => {
    if (path === '/xbot-api/bots' && method === 'POST' && refuse) { refuse = false; p.s.start = only(START.three); throw fail(422, 'Codex 现在用不了'); }
    return undefined;
  } });
  const stage = await p.stage();
  assert.equal(chosen(stage), '自定义');
  type(control(stage, '名字'), '小墨');
  type(control(stage, '它主要帮你做什么'), '帮我整理读书笔记');
  type(control(stage, '它的性格'), '话不多');
  // A refusal reads /start again, and now Kimi is here: 梵花猫 could come home as it is.
  button(stage, '带它回家').click();
  await settle();
  assert.equal(p.calls.filter(c => c.path.startsWith('/xbot-api/start')).length, 2);
  assert.equal(chosen(stage), '自定义', 'still 自定义');
  assert.equal(control(stage, '名字').value, '小墨');
  assert.equal(control(stage, '它主要帮你做什么').value, '帮我整理读书笔记');
  button(stage, '带它回家').click();
  await settle();
  assert.deepEqual(p.posts().map(c => c.body.simple), [
    { face: 'turkish-van', custom: true, about: '帮我整理读书笔记', personality: '话不多', agent: 'codex' },
    { face: 'turkish-van', custom: true, about: '帮我整理读书笔记', personality: '话不多', agent: 'codex' },
  ], 'the owner\'s words go with the next try');
  // Before the form is first presented, the mode still follows: blocked first, then 重新检测 with a usable face — the face's own cat.
  const q = page({ start: START.none });
  const blocked = await q.stage();
  q.s.start = only(START.three);
  button(blocked, '重新检测').click();
  await settle();
  assert.equal(chosen(blocked), '梵花猫');
  assert.equal(markSaid(blocked), '它用这台电脑上的 Kimi 来思考');
});

test('review: in an answer that names faces\' tools, a face whose tool is missing or unreadable is not known — not creatable as it is, said plainly, 自定义 remains', async () => {
  const start = { ...START.three, faces: START.three.faces.map((f: Any) => (f.id === 'siamese' ? (({ tool: _t, ...rest }) => rest)(f) : f.id === 'dsh' ? { ...f, tool: { usable: true } } : f)) };
  const p = page({ start });
  const stage = await p.stage();
  assert.deepEqual(awayFaces(stage), ['暹罗猫', '蓝灰短毛猫', '狸花猫', '孟加拉猫', '金渐层']);
  assert.equal(all(stage).find(n => n.id === face(stage, '暹罗猫').getAttribute('aria-describedby'))?.textContent, '没能读到它用什么思考，现在领不了。', 'what could not be read, not a guess');
  face(stage, '暹罗猫').click();
  assert.equal(mark(stage), 'Agent未知', 'no Agent named: the mark says only that it is not known');
  assert.equal(markSaid(stage), 'Agent，未知');
  assert.equal(visibleText(one(stage, 'qc-uses-line')), '没能读到它用什么思考，现在领不了。');
  assert.equal(one(stage, 'qc-uses-line').children.length, 0, 'plain words');
  assert.equal(shown(one(stage, 'qc-uses-more')), false, 'nothing to install or log in: nothing to re-detect');
  const go = all(stage).find(n => has(n, 'qc-go'))!;
  assert.equal(go.getAttribute('aria-disabled'), 'true');
  control(stage, '名字').key('Enter');
  await settle();
  assert.equal(p.posts().length, 0, 'never sent as a template the server would refuse');
  face(stage, '蓝灰短毛猫').click();
  assert.equal(visibleText(one(stage, 'qc-uses-line')), '没能读到它用什么思考，现在领不了。', 'a malformed tool reads the same');
  one(stage, 'qc-borrow').click();
  type(control(stage, '名字'), '小鲸');
  go.click();
  await settle();
  assert.deepEqual(p.posts()[0].body.simple, { face: 'dsh', custom: true, agent: 'codex' });
});

test('review: a face whose tool is not installed offers 重新检测 too; the face and everything typed stay; missing → login → ready', async () => {
  const p = page();
  const stage = await p.stage();
  // A tool the app cannot connect yet has nothing to re-detect: installing it would not change that.
  face(stage, '暹罗猫').click();
  assert.equal(shown(one(stage, 'qc-uses-more')), false);
  face(stage, '梵花猫').click();
  type(control(stage, '名字'), '小墨');
  const uses = one(stage, 'qc-uses-more');
  assert.equal(toolSaid(stage), '它要用 Kimi 来思考，未安装这台电脑上还没有装 Kimi，现在领不了。装好 Kimi 并登录后再重新检测重新检测');
  assert.equal(mark(stage), 'Kimi未安装');
  assert.equal(seenText(uses), '重新检测', 'on screen, the button alone: never that installing helps an Agent the app cannot connect, and here it is 未安装');
  // Nothing changed yet: said plainly, focus kept.
  const again = button(uses, '重新检测');
  again.focus();
  again.click();
  await settle();
  assert.equal(p.calls.at(-1)!.path, '/xbot-api/start?refresh=1');
  assert.equal(visibleText(one(stage, 'qc-uses-note')), '重新检测过了，还是没找到 Kimi。');
  assert.equal(seenText(one(stage, 'qc-uses-note')), '重新检测过了，还是没找到 Kimi。', 'nothing else moved, so it is shown');
  assert.equal(p.doc.activeElement === again, true);
  // Installed, not logged in: the login help and its command; focus goes to the new 重新检测.
  p.s.start = await summary(computer('configured', 'configured', 'login_required'));
  again.click();
  await settle();
  assert.match(toolSaid(stage), /^它要用 Kimi 来思考，未登录Kimi 还没有登录，现在领不了。在终端里运行这行命令登录，再重新检测kimi login复制重新检测检测结果有变化。$/);
  assert.equal(mark(stage), 'Kimi未登录', 'the mark follows the state');
  assert.equal(seenText(one(stage, 'qc-uses-more')), 'kimi login复制重新检测', 'the change shows itself: 检测结果有变化 is said, not shown');
  assert.equal(all(stage).find(n => n.id === face(stage, '梵花猫').getAttribute('aria-describedby'))?.textContent, 'Kimi 还没有登录，现在领不了。', 'its tile\'s description follows the state');
  const next = button(one(stage, 'qc-uses-more'), '重新检测');
  assert.equal(p.doc.activeElement === next, true, 'the button that was replaced hands focus to its successor');
  // Logged in: the cat can come home, nothing typed was lost.
  p.s.start = START.three;
  next.click();
  await settle();
  assert.equal(markSaid(stage), '它用这台电脑上的 Kimi 来思考');
  assert.equal(shown(one(stage, 'qc-uses-more')), false);
  assert.equal(chosen(stage), '梵花猫');
  assert.equal(control(stage, '名字').value, '小墨');
  const go = all(stage).find(n => has(n, 'qc-go'))!;
  assert.equal(go.getAttribute('aria-disabled'), null);
  assert.equal(p.doc.activeElement === go, true);
  assert.match(voice(stage).textContent, /它用这台电脑上的 Kimi 来思考$/);
  go.click();
  await settle();
  assert.deepEqual(p.posts()[0].body, { name: '小墨', simple: { face: 'turkish-van', rev: START.three.faces[3].rev }, idempotencyKey: p.posts()[0].body.idempotencyKey });
});

test('review: when face_unavailable leaves no usable tool at all, the form gives way to the blocked view and focus goes to its title — first run and dialog; picking another cat puts a refusal away', async () => {
  for (const where of ['stage', 'dialog'] as const) {
    let refuse = true;
    const p = page({ cats: where === 'dialog' ? ['团子'] : [], route: (path, method) => {
      if (path === '/xbot-api/bots' && method === 'POST' && refuse) { refuse = false; p.s.start = START.none; throw fail(422, 'Claude Code 还没有登录，登录后再试。', 'face_unavailable'); }
      return undefined;
    } });
    let root: El;
    if (where === 'stage') root = await p.stage();
    else { p.Q.openCat({ opener: p.opener }); await settle(); root = one(p.layer()!, 'qc-card'); }
    const name = control(root, '名字');
    name.focus();
    name.key('Enter');
    await settle();
    const need = one(root, 'qc-need');
    assert.equal(shown(need), true, where);
    assert.equal(shown(one(root, 'qc-fields')), false, where);
    assert.equal(p.doc.activeElement.tagName, 'H3', where + ': focus is not left on the hidden name');
    assert.equal(p.doc.activeElement.textContent, '还差一步：装好 Claude Code 或 Codex', where);
    assert.equal(p.doc.activeElement.tabIndex, -1, 'a title to land on, not a stop for Tab');
    assert.equal(visibleText(one(need, 'qc-note')), 'Claude Code 还没有登录，登录后再试。', where + ': what happened, said there');
  }
  // Still able to choose: the refusal stays while it holds, and goes once another cat is picked.
  const signedOut = (await summary(computer('configured', 'login_required'))).faces;
  const { e, route } = engine(START.ready.faces);
  const q = page({ route });
  const stage = await q.stage();
  e.faces = signedOut;
  button(stage, '带它回家').click();
  await settle();
  assert.equal(shown(one(stage, 'qc-error')), true);
  face(stage, '布偶猫').key('ArrowRight');
  assert.equal(shown(one(stage, 'qc-error')), false, 'about 布偶猫, not about 缅因猫');
});

test('review: the two 409s by code — name_taken marks the name; request_changed says the server\'s sentence without blaming the name and the next try is new; a 409 with neither code is said as it came', async () => {
  const conflicts: Array<() => never> = [
    () => { throw fail(409, '已经有一只叫这个名字的猫猫了', 'name_taken'); },
    () => { throw fail(409, '这次创建和上一次的内容不一样，或者名字已被占用，请重新创建', 'request_changed'); },
    () => { throw fail(409, '这个请求和别的请求冲突了'); },
  ];
  const { R } = page();
  assert.deepEqual(plain(R.catError(fail(409, 'x', 'name_taken'), '宪宪')), { kind: 'name', text: '已经有一只叫「宪宪」的猫猫了，换个名字吧' });
  assert.deepEqual(plain(R.catError(fail(409, '这次创建和上一次的内容不一样，或者名字已被占用，请重新创建', 'request_changed'), '宪宪')), { kind: 'changedRequest', text: '这次创建和上一次的内容不一样，或者名字已被占用，请重新创建。' });
  assert.deepEqual(plain(R.catError(fail(409, '这个请求和别的请求冲突了'), '宪宪')), { kind: 'form', text: '这个请求和别的请求冲突了。' });
  assert.equal(R.catError(fail(409, 'Bot conflict'), '宪宪').text, '没能建好，请稍后再试。', 'never the adapter\'s words');
  for (const [i, conflict] of conflicts.entries()) {
    let next: (() => never) | null = conflict;
    const p = page({ route: (path, method) => { if (path === '/xbot-api/bots' && method === 'POST' && next) { const n = next; next = null; n(); } return undefined; } });
    const stage = await p.stage();
    const go = button(stage, '带它回家'), name = control(stage, '名字');
    go.click();
    await settle();
    if (i === 0) {
      assert.equal(name.getAttribute('aria-invalid'), 'true');
      assert.equal(errOf(stage, '名字').textContent, '已经有一只叫「宪宪」的猫猫了，换个名字吧');
      assert.equal(shown(one(stage, 'qc-error')), false);
      assert.equal(p.doc.activeElement === name, true);
    } else {
      assert.equal(name.getAttribute('aria-invalid'), null, 'not blamed on the name');
      assert.equal(errOf(stage, '名字').textContent, '');
      assert.equal(visibleText(one(stage, 'qc-error')), i === 1 ? '这次创建和上一次的内容不一样，或者名字已被占用，请重新创建。' : '这个请求和别的请求冲突了。');
      assert.equal(p.doc.activeElement === go, true);
      assert.equal(p.refreshed, i === 1 ? 1 : 0, 'request_changed reads the list again (it may know the name now)');
      go.click();
      await settle();
      const [first, second] = p.posts().map(c => c.body);
      assert.deepEqual(second.simple, first.simple);
      assert.notEqual(second.idempotencyKey, first.idempotencyKey, 'a refused request leaves no key behind');
      assert.deepEqual(p.opened, ['宪宪']);
    }
  }
});

test('review: the card\'s tail holds the reason, what to do, the quiet note and the way on, and is there only when one of them is; no room is kept for it, so a cat that can come home leaves no empty band', async () => {
  const p = page({ cats: ['团子'] });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  const tail = one(card, 'qc-tail');
  assert.deepEqual(tail.children.map(n => n.className.split(' ')[0]), ['qc-uses-line', 'qc-uses-more', 'qc-fresh', 'qc-forward'], 'why, what can be done, the quiet note and the way on, in that order');
  assert.equal(shown(tail), false, 'a cat that can come home: nothing in it, no empty row in the card');
  face(card, '暹罗猫').click();
  assert.equal(shown(tail), true);
  const css = read('client/public/quick-create.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /margin-top: auto/, 'the name follows the card: no space pushed between them');
  assert.doesNotMatch(css, /\.qc-uses-line \{[^}]*min-height/, 'no blank line kept inside the card');
  assert.doesNotMatch(css, /\.mixed/, 'nothing kept for the reason while it is not shown');
});

test('review r13: on a phone the dialog\'s actions are pinned to the card\'s foot on its own surface while the side scrolls under them, and a field brought into view is kept clear of them', () => {
  const css = read('client/public/quick-create.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const phone = /@media \(max-width: 560px\) \{([\s\S]*?)\n\}/.exec(css)![1];
  assert.match(phone, /\.qc-card \.modal-actions \{[^}]*position: sticky; bottom: calc\(-1 \* var\(--x-s7\)\);[^}]*background: var\(--bg\);/, 'pinned at the card\'s bottom edge, opaque');
  assert.match(phone, /\.qc-modal \.modal-card \{[^}]*scroll-padding-bottom: 92px;/, 'focus brings a field into view above the actions');
  assert.match(phone, /\.qc-card \.modal-actions::before \{[^}]*linear-gradient\(to bottom, transparent, var\(--bg\)\);[^}]*pointer-events: none;/, 'a fade over what passes beneath, not a line');
  // Both sides' actions are the card's .modal-actions (the 群聊 side's too).
  const js = read('client/public/quick-create.js');
  assert.equal((js.match(/node\("div", "modal-actions"\)/g) || []).length, 2);
});

// ---------------------------------------------------------------- meeting a cat (2026-11-12, item 44)
// The owner, looking at the 新建 dialog's 猫猫 side: 「新建猫猫的页面有待提升；当前显得平铺直叙、缺乏特点和设计。
// 自定义应该作为一个和其它猫猫并列的选项。我注意到当前，本机不具备的猫置灰；但是其实这不是很明显。」 The cats are
// named tiles in one radio group with 自定义 among them; a cat that cannot come home as it is sits in a group of
// its own, carrying a word; the chosen one has a card. Requests, keys and refusals are as before.
test('item 44: 自定义 is one radio of the same group as the cats — one Tab stop for all, reached and left by the same arrows, Home and End, in the order shown — first run and dialog', async () => {
  for (const where of ['stage', 'dialog'] as const) {
    const p = page({ cats: where === 'dialog' ? ['团子'] : [] });
    let root: El;
    if (where === 'stage') root = await p.stage();
    else { p.Q.openCat({ opener: p.opener }); await settle(); root = one(p.layer()!, 'qc-card'); }
    const row = one(root, 'qc-faces'), shownTiles = () => tiles(root).filter(shown);
    assert.equal(row.getAttribute('role'), 'radiogroup', where);
    assert.ok(shownTiles().every(t => t.getAttribute('role') === 'radio' && row.contains(t)), where + ': every tile a radio of the one group');
    assert.equal(shownTiles().filter(t => t.tabIndex === 0).length, 1, where + ': one Tab stop');
    face(root, '缅因猫').key('ArrowRight');
    assert.equal(chosen(root), '自定义', where + ': next after the cats that can come home');
    same(p.doc.activeElement, ownTile(root), where + ': focus moves with the choice');
    assert.deepEqual(shownTiles().map(t => t.tabIndex), [-1, -1, 0, -1, -1, -1, -1, -1, -1], where + ': the one Tab stop is the choice');
    ownTile(root).key('ArrowDown');
    assert.equal(chosen(root), '暹罗猫', where + ': then the first that cannot');
    face(root, '暹罗猫').key('ArrowUp');
    assert.equal(chosen(root), '自定义');
    ownTile(root).key('End');
    assert.equal(chosen(root), '金渐层');
    face(root, '金渐层').key('Home');
    assert.equal(chosen(root), '布偶猫');
    face(root, '布偶猫').key('ArrowLeft');
    assert.equal(chosen(root), '金渐层', where + ': wraps round');
    assert.equal(p.posts().length, 0, 'choosing sends nothing');
  }
});

test('item 44: 自定义 always sends a face — the looks chosen on its card, kept while the form is open, the cat on screen\'s while untouched; other looks are another request, the same looks the same key', async () => {
  let lose = true;
  const p = page({ route: (path, method) => { if (path === '/xbot-api/bots' && method === 'POST' && lose) throw fail(undefined, '连不上 clowder-bot'); return undefined; } });
  const stage = await p.stage();
  const own = ownTile(stage), go = button(stage, '带它回家');
  const look = (label: string) => named(stage, 'qc-look').find(n => n.getAttribute('aria-label') === label)!;
  const hero = () => all(one(stage, 'qc-hero')).map(n => n.getAttribute('data-cat-id')).filter(Boolean);
  // Untouched, the looks follow the cat on screen each time 自定义 is chosen; the card shows them.
  face(stage, '缅因猫').click(); own.click();
  assert.equal(looksChosen(stage), '缅因猫');
  face(stage, '暹罗猫').click(); own.click();
  assert.equal(looksChosen(stage), '暹罗猫', 'a cat that cannot come home lends its looks all the same');
  assert.deepEqual(hero(), ['siamese']);
  // Picked by the owner (a click, or the arrows of their own group), they stay whatever cat is looked at in between.
  look('暹罗猫').key('ArrowRight');
  assert.equal(looksChosen(stage), '梵花猫');
  assert.equal(p.doc.activeElement.getAttribute('aria-label'), '梵花猫');
  assert.deepEqual(hero(), ['turkish-van'], 'the portrait shows the looks chosen: no 长相：… caption (item 45)');
  assert.equal(named(stage, 'qc-looks-head').length, 0);
  face(stage, '布偶猫').click(); own.click();
  assert.equal(looksChosen(stage), '梵花猫', 'kept');
  type(control(stage, '名字'), '小墨');
  go.click(); await settle(); // looks 梵花猫: unsure, key A
  look('梵花猫').key('End');
  assert.equal(looksChosen(stage), '金渐层');
  go.click(); await settle(); // other looks: another request
  look('梵花猫').click();
  lose = false;
  go.click(); await settle(); // 梵花猫 again: key A, and it lands
  const [a, b, c] = p.posts().map(x => x.body);
  assert.deepEqual(a.simple, { face: 'turkish-van', custom: true, agent: 'claude' }, 'the looks picked; the tool of the cat on screen when 自定义 was chosen');
  assert.deepEqual(b.simple, { face: 'golden-chinchilla', custom: true, agent: 'claude' });
  assert.notEqual(b.idempotencyKey, a.idempotencyKey, 'other looks: another request');
  assert.deepEqual(c, a, 'the same looks again: the same request, under its key');
  assert.deepEqual(p.opened, ['小墨']);
  // Never a custom body without a face, however 自定义 was reached: its tile, the card's 自定义 (用它的长相自定义), or the form choosing it.
  const nothing = { ...START.unknown, faces: START.unknown.faces.filter((f: Any) => f.id !== 'maine-coon') };
  for (const how of ['tile', 'borrow', 'form'] as const) {
    const q = page({ start: how === 'form' ? nothing : START.ready });
    const s = await q.stage();
    if (how === 'tile') ownTile(s).click();
    if (how === 'borrow') { face(s, '孟加拉猫').click(); one(s, 'qc-borrow').click(); }
    type(control(s, '名字'), '小白');
    button(s, '带它回家').click();
    await settle();
    const [post] = q.posts();
    assert.ok(post && post.body.simple.custom === true && typeof post.body.simple.face === 'string' && post.body.simple.face, how + ': a face, always');
    assert.equal(post.body.simple.face, { tile: 'ragdoll', borrow: 'bengal', form: 'ragdoll' }[how], how);
  }
});

test('item 44: 自定义 borrows no template\'s name — its box empties and asks for one; a name the owner typed is never overwritten, either way; on a cat again, the cat\'s name comes back', async () => {
  const p = page({ cats: ['宪宪'] });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  const name = control(card, '名字');
  assert.equal(name.value, '宪宪 2', 'the cat\'s own name, made free');
  ownTile(card).click();
  assert.equal(name.value, '');
  assert.equal(name.placeholder, '给它起个名字');
  face(card, '缅因猫').click();
  assert.equal(name.value, '砚砚', 'a cat again: its name follows');
  ownTile(card).click();
  type(name, '小白');
  face(card, '布偶猫').click();
  assert.equal(name.value, '小白', 'typed in 自定义, kept on a cat');
  ownTile(card).click();
  assert.equal(name.value, '小白', 'and back');
  type(name, '');
  face(card, '布偶猫').click();
  assert.equal(name.value, '宪宪 2', 'emptied, it follows the cat again');
  type(name, '团团');
  ownTile(card).click();
  assert.equal(name.value, '团团', 'typed on a cat, kept in 自定义');
  // The voice: once per choice the owner makes, none for the name filling itself in.
  assert.equal(voice(card).textContent, p.R.OWN_NOTE);
});

test('item 44: one face to twelve — one face is its tile and 自定义, without groups; twelve, some of which cannot come home, sort into the two groups in the server\'s order and are walked in that order', async () => {
  const real = await realFaces();
  const p = page({ start: { ...START.ready, faces: [real[1]] } });
  const stage = await p.stage();
  assert.deepEqual(tiles(stage).filter(shown).map(f => f.dataset.face ?? '自定义'), ['maine-coon', '自定义']);
  assert.equal(has(one(stage, 'qc-faces'), 'split'), false, 'one group');
  assert.equal(named(stage, 'qc-group')[1].hidden, true, 'the later group is not there when nothing is in it');
  // Twelve (a larger portrait library), every other one's Agent not connectable here.
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 'cat' + i, label: '猫' + i, nickname: '小' + i }));
  const toolAt = (i: number) => (i % 2 ? { label: 'Pi', state: 'unsupported', usable: false, reason: '暂不支持 Pi' } : { label: 'Codex', state: 'ready', usable: true, id: 'codex' });
  const q = page({ presets: many, start: { ...START.ready, faces: many.map((c, i) => ({ id: c.id, personality: c.label + '的性格', tool: toolAt(i) })) } });
  const row = await q.stage();
  assert.deepEqual(named(row, 'qc-group').map(g => tiles(g).filter(shown).map(f => f.dataset.face ?? '自定义')),
    [['cat0', 'cat2', 'cat4', 'cat6', 'cat8', 'cat10', '自定义'], ['cat1', 'cat3', 'cat5', 'cat7', 'cat9', 'cat11']]);
  assert.equal(tiles(row).filter(f => shown(f) && f.tabIndex === 0).length, 1);
  face(row, '猫10').key('ArrowRight');
  assert.equal(chosen(row), '自定义');
  ownTile(row).key('ArrowRight');
  assert.equal(chosen(row), '猫1');
  assert.equal(all(row).find(n => n.id === face(row, '猫1').getAttribute('aria-describedby'))?.textContent, '暂不支持 Pi，现在领不了。');
  assert.equal(seenText(one(row, 'qc-faces')).includes('暂不支持'), false, 'said, not written on the tile');
});

// ---------------------------------------------------------------- review of item 44 (2026-11-12)
test('review r13: a name that went out in a request whose answer was lost is held — 自定义 and back, another cat and back — so the retry is the same body under the same key, first run and dialog', async () => {
  for (const where of ['stage', 'dialog'] as const) {
    const made: string[] = [];
    let lose = true;
    const p = page({
      cats: where === 'dialog' ? ['团子'] : [],
      route: (path, method, body) => {
        if (path !== '/xbot-api/bots' || method !== 'POST') return undefined;
        if (!made.includes(body.name)) made.push(body.name); // the server made it…
        if (lose) throw fail(undefined, '连不上 clowder-bot'); // …but the answer was lost
        return { name: body.name, native_id: 'bot-1' };
      },
      onRefresh: () => { p.s.cats.splice(0, Infinity, ...(where === 'dialog' ? ['团子'] : []), ...made); },
    });
    let root: El;
    if (where === 'stage') root = await p.stage();
    else { p.Q.openCat({ opener: p.opener }); await settle(); root = one(p.layer()!, 'qc-card'); }
    const name = control(root, '名字'), go = all(root).find(n => n.tagName === 'BUTTON' && n.type === 'submit')!;
    go.click();
    await settle();
    assert.ok(p.s.cats.includes('宪宪'), where + ': the refreshed list knows the cat the lost answer may have made');
    ownTile(root).click();
    assert.equal(name.value, '宪宪', where + ': 自定义 does not empty a name that went out unanswered');
    face(root, '布偶猫').click();
    assert.equal(name.value, '宪宪', where + ': back on the cat, not re-suggested as 宪宪 2');
    face(root, '缅因猫').click();
    assert.equal(name.value, '宪宪', where + ': nor on another cat');
    face(root, '布偶猫').click();
    lose = false;
    go.click();
    await settle();
    const [first, second] = p.posts().map(c => c.body);
    assert.deepEqual(second, first, where + ': the same body under the same key: the server answers with the cat it made, not a second');
    assert.deepEqual(made, ['宪宪'], where);
    assert.deepEqual(p.opened, ['宪宪'], where);
  }
});

test('review r13: a name the owner typed stays on every path, even when it equals a cat\'s own name — 自定义 and back, the card\'s 自定义, a re-read, the 猫猫｜群聊 switch; it is a draft; emptied, the box follows again', async () => {
  const p = page({ cats: ['团子'] });
  p.Q.openCat({ opener: p.opener });
  await settle();
  const card = one(p.layer()!, 'qc-card');
  const name = control(card, '名字');
  // The current cat's own name, typed by hand.
  assert.equal(name.value, '宪宪');
  type(name, '宪宪');
  ownTile(card).click();
  assert.equal(name.value, '宪宪', 'typed equal to the suggestion, kept in 自定义');
  face(card, '布偶猫').click();
  assert.equal(name.value, '宪宪');
  // Another cat's name, typed in 自定义.
  ownTile(card).click();
  type(name, '砚砚');
  face(card, '缅因猫').click();
  assert.equal(name.value, '砚砚');
  ownTile(card).click();
  assert.equal(name.value, '砚砚', 'typed equal to the cat just visited, kept on the way back to 自定义');
  face(card, '暹罗猫').click();
  one(card, 'qc-borrow').click();
  assert.equal(name.value, '砚砚', 'the card\'s 自定义 (用它的长相自定义) keeps it');
  // A re-read (重新检测 beside a missing Agent) keeps it.
  face(card, '梵花猫').click();
  button(one(card, 'qc-uses-more'), '重新检测').click();
  await settle();
  assert.equal(p.calls.at(-1)!.path, '/xbot-api/start?refresh=1');
  assert.equal(name.value, '砚砚', 'a re-read keeps it');
  // The 猫猫｜群聊 switch keeps it.
  tabOf(card, '群聊').click();
  tabOf(card, '猫猫').click();
  assert.equal(name.value, '砚砚', 'the switch keeps it');
  // It goes out as written.
  face(card, '缅因猫').click();
  card.dispatch('submit');
  await settle();
  assert.equal(p.posts()[0].body.name, '砚砚');
  // Emptied by the owner, the box follows the option again.
  const q = page({ cats: ['团子'] });
  q.Q.openCat({ opener: q.opener });
  await settle();
  const other = one(q.layer()!, 'qc-card'), box = control(other, '名字');
  type(box, '小白');
  type(box, '');
  face(other, '缅因猫').click();
  assert.equal(box.value, '砚砚');
  ownTile(other).click();
  assert.equal(box.value, '');
  // A name typed on the first screen is a draft, even the cat's own.
  const r = page();
  const stage = await r.stage();
  type(control(stage, '名字'), '宪宪');
  r.doc.focused = null;
  assert.equal(r.Q.release(stage, ['团子']), false, 'typed by hand: kept, though it equals the suggestion');
});

// ---------------------------------------------------------------- item 45 (2026-11-13): the layout explains, not labels
test('item 45: everything seen on the 新建 surface — the cats\' names, the chosen cat\'s own words, the Agent mark, the controls; no heading, tag, caption or helper sentence', async () => {
  // The owner (2026-11-13): 「现在就能领/暂时按原样领不了/接不上 这些字眼 AI味太重了。Avoid unnecessary secondary labels and
  // description. Let the layout do the explaining.」 What is on screen, state by state (what a screen reader hears is
  // tested above: the names, descriptions and announcements stay).
  const p = page({ start: START.codexLogin });
  const stage = await p.stage();
  // The stage: its title (no sub-line), the cats (those that can come home, 自定义, then the rest), the card, the action.
  assert.equal(seenText(stage), '领一只猫猫回家' + '宪宪自定义砚砚烁烁墨墨鲸鲸小狸花斑斑金哥' + '宪宪布偶猫Claude Code温柔但有主见，喜欢深入分析问题，写代码快但注重质量擅长架构设计、写代码一把好手' + '带它回家');
  assert.equal(named(stage, 'qc-sub').length, 0);
  // A cat whose Agent the app cannot connect: the mark's word, and one action.
  face(stage, '暹罗猫').click();
  assert.equal(seenText(one(stage, 'qc-side')), '烁烁暹罗猫' + 'Gemini暂不支持' + '热血奔放，善于用视觉语言表达想法，表达力是全队最强的擅长审美、前端设计风格、打破常规' + '自定义' + '带它回家');
  // Not installed: 重新检测 too.
  face(stage, '梵花猫').click();
  assert.equal(seenText(one(stage, 'qc-side')), '墨墨梵花猫' + 'Kimi未安装' + '细心务实，保留自己的判断，愿意把事情接住做完擅长编码、文档、验收' + '重新检测' + '自定义' + '带它回家');
  // Not logged in: its command (copyable) and 重新检测.
  face(stage, '缅因猫').click();
  assert.equal(seenText(one(stage, 'qc-side')), '砚砚缅因猫' + 'Codex未登录' + '严谨认真，注重细节，会直言不讳地指出问题擅长 Review、找 bug、coding 落地' + 'codex login复制重新检测' + '自定义' + '带它回家');
  // 自定义: its Agent, its looks (pictures), two empty lines whose placeholders ask, the name; no title, no captions.
  ownTile(stage).click();
  assert.equal(seenText(one(stage, 'qc-side')), 'Claude Code' + '带它回家');
  assert.deepEqual(all(one(stage, 'qc-side')).filter(n => n.tagName === 'INPUT' && shown(n)).map(n => n.placeholder), ['它主要帮你做什么', '它的性格', '给它起个名字']);
  // The dialog's 猫猫 side says the same, under 新建 and its switch, with 更多设置 · 取消 · 创建.
  const d = page({ cats: ['团子', '栗子'] });
  d.Q.openCat({ opener: d.opener });
  await settle();
  const card = one(d.layer()!, 'qc-card');
  face(card, '暹罗猫').click();
  assert.equal(seenText(card), '新建猫猫群聊' + '宪宪砚砚自定义烁烁墨墨鲸鲸小狸花斑斑金哥' + '烁烁暹罗猫Gemini暂不支持热血奔放，善于用视觉语言表达想法，表达力是全队最强的擅长审美、前端设计风格、打破常规' + '自定义' + '更多设置取消创建');
  // 群聊: the cats as chips, what 创建 still needs, the name's box.
  tabOf(card, '群聊').click();
  assert.equal(seenText(card), '新建猫猫群聊' + '团子栗子' + '至少选 2 只' + '群名' + '取消创建');
});

// ---------------------------------------------------------------- review of item 45 (2026-11-13)
// A command chip says where it runs by its look: a terminal's mark right before the command.
const terminalMarked = (chip: El) => {
  const at = chip.children.findIndex(n => n.tagName === 'CODE');
  return at > 0 && chip.children[at - 1].dataset.icon === 'terminal';
};

test('review r14: every command chip carries a terminal\'s mark — a login on a cat\'s card, an unconfirmed login on a card and in 自定义, the blocked screen with one command or two — and the sentence stays for a screen reader only', async () => {
  // A cat whose Agent needs a login.
  const p = page({ start: START.codexLogin });
  const stage = await p.stage();
  face(stage, '缅因猫').click();
  const chips = named(one(stage, 'qc-uses-more'), 'qc-cmd');
  assert.equal(chips.length, 1);
  assert.equal(terminalMarked(chips[0]), true, 'a login on the card');
  assert.match(visibleText(one(stage, 'qc-uses-more')), /^在终端里运行这行命令登录，再重新检测codex login/, 'said');
  assert.equal(seenText(one(stage, 'qc-uses-more')), 'codex login复制重新检测', 'not shown');
  // A login that could not be checked: on the cat's card, and in 自定义's Agent.
  const q = page({ start: START.unknown });
  const unsure = await q.stage();
  assert.equal(named(one(unsure, 'qc-uses-more'), 'qc-cmd').every(terminalMarked), true, 'an unconfirmed login on the card');
  ownTile(unsure).click();
  const ownChips = named(one(unsure, 'qc-tool-note'), 'qc-cmd');
  assert.equal(ownChips.length, 1);
  assert.equal(terminalMarked(ownChips[0]), true, 'an unconfirmed login in 自定义');
  // The blocked screen: its sentence no longer says 在终端里运行 on screen; the chips do, and a screen reader still hears it.
  for (const [start, commands, said] of [
    [START.login, 1, '在终端里运行下面这行：'],
    [{ ...START.login, agents: [tool('codex', 'Codex', 'login', 'codex login'), tool('claude', 'Claude Code', 'login', 'claude auth login')] }, 2, '在终端里运行其中一行：'],
  ] as const) {
    const r = page({ start });
    const blocked = await r.stage();
    const need = one(blocked, 'qc-need');
    const cmds = named(need, 'qc-cmd');
    assert.equal(cmds.length, commands);
    assert.equal(cmds.every(terminalMarked), true, commands + ' command(s) on the blocked screen');
    assert.ok(visibleText(need).includes(said), 'said before the commands');
    assert.equal(seenText(need).includes('在终端'), false, 'not shown: the mark says it');
  }
  // In the dialog's blocked view too (the same chip).
  const d = page({ cats: ['团子'], start: START.login });
  d.Q.openCat({ opener: d.opener });
  await settle();
  assert.equal(named(one(d.layer()!, 'qc-card'), 'qc-cmd').every(terminalMarked), true);
  assert.ok(named(one(d.layer()!, 'qc-card'), 'qc-cmd').length > 0);
  assert.match(read('client/public/quick-create.js'), /chip\.append\(hooks\(\)\.icon\("terminal"\), node\("code", "", command\)\);/, 'one chip, one mark, wherever a command is shown');
  assert.match(read('client/public/quick-create.css'), /\.qc-cmd > \.icon \{ flex: none; width: 15px; height: 15px;[^}]*color: var\(--x-muted\); \}/, 'drawn quietly, as a prompt before the command');
});

test('review r14: which boxes must be filled is told to a screen reader, never shown — the name is aria-required, 自定义\'s two lines are described as optional (also when the form presents 自定义 by itself), the group name as optional with what an unnamed group is called', async () => {
  const describedBy = (root: El, input: El) => (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map(id => all(root).find(n => n.id === id)!);
  const optional = (root: El, input: El) => describedBy(root, input).filter(n => has(n, 'qc-sr')).map(n => n.textContent).join('');
  // 自定义 chosen by the owner, on the first screen.
  const p = page();
  const stage = await p.stage();
  assert.equal(control(stage, '名字').getAttribute('aria-required'), 'true');
  ownTile(stage).click();
  const check = (root: El) => {
    const name = control(root, '名字'), about = control(root, '它主要帮你做什么'), temper = control(root, '它的性格');
    assert.equal(name.getAttribute('aria-required'), 'true', 'the name must be filled');
    assert.equal(optional(root, name), '', 'and is not described as optional');
    for (const input of [about, temper]) {
      assert.equal(input.getAttribute('aria-required'), null);
      assert.equal(optional(root, input), '可不填', 'described as optional');
      assert.equal(describedBy(root, input).some(n => has(n, 'qc-err')), true, 'its message line still describes it');
    }
    assert.equal(seenText(root).includes('可不填'), false, 'nothing of it on screen');
  };
  check(stage);
  // 自定义 presented by the form itself (no cat can come home as it is): the polite line about 自定义 never ran, the
  // descriptions are there all the same.
  const q = page({ start: { ...START.unknown, faces: START.unknown.faces.filter((f: Any) => f.id !== 'maine-coon') } });
  const auto = await q.stage();
  assert.equal(chosen(auto), '自定义');
  assert.equal(voice(auto).textContent, '', 'nothing was announced');
  check(auto);
  // The dialog: the same.
  const d = page({ cats: ['团子', '栗子'] });
  d.Q.openCat({ opener: d.opener });
  await settle();
  const card = one(d.layer()!, 'qc-card');
  ownTile(card).click();
  check(card);
  // 群聊: the group name may stay empty, and an unnamed group takes its members' names — said, not shown.
  tabOf(card, '群聊').click();
  const group = control(card, '群名');
  assert.equal(group.getAttribute('aria-required'), null);
  assert.equal(optional(card, group), '可不填，不填就用成员的名字');
  assert.equal(describedBy(card, group).some(n => has(n, 'qc-err')), true);
  assert.equal(seenText(card).includes('可不填'), false);
  // Its message line is still the one that speaks up.
  const boxes = all(card).filter(n => n.tagName === 'INPUT' && n.type === 'checkbox');
  for (const b of boxes) { b.checked = true; b.dispatch('change'); }
  type(group, '读书<会>');
  card.dispatch('submit');
  await settle();
  assert.equal(describedBy(card, group).find(n => has(n, 'qc-err'))!.textContent, '群名里不能有 < > 这类符号');
});

test('review r14: 重新检测 is answered by what the owner can see of the chosen cat — unchanged there, its unchanged line is shown although another Agent changed; changed there, the card itself is the answer', async () => {
  const p = page();
  const stage = await p.stage();
  face(stage, '梵花猫').click(); // Kimi 未安装
  // Meanwhile Codex went from confirmed to unconfirmed; Kimi is still not installed.
  const codexUnsure = await summary(computer('unknown', 'configured'));
  assert.equal(p.R.sameStart(p.R.start(START.ready), p.R.start(codexUnsure)), false, 'the computer changed, so the whole answer differs');
  p.s.start = codexUnsure;
  const again = button(one(stage, 'qc-uses-more'), '重新检测');
  again.focus();
  again.click();
  await settle();
  const note = one(stage, 'qc-uses-note');
  assert.equal(visibleText(note), '重新检测过了，还是没找到 Kimi。');
  assert.equal(seenText(note), '重新检测过了，还是没找到 Kimi。', 'shown: nothing about 墨墨 changed on screen, so the click needs an answer');
  assert.equal(mark(stage), 'Kimi未安装');
  assert.equal(p.doc.activeElement === again, true);
  // Now Kimi is installed but not logged in: the mark and the command change, and that is the answer.
  p.s.start = await summary(computer('unknown', 'configured', 'login_required'));
  again.click();
  await settle();
  assert.equal(mark(stage), 'Kimi未登录');
  assert.equal(visibleText(one(stage, 'qc-uses-note')), '检测结果有变化。');
  assert.equal(seenText(one(stage, 'qc-uses-note')), '', 'said only: the card shows the change');
  // The rule: the same name, state, usability and command.
  const { R } = p;
  const kimi = (start: Any) => R.toolOf(R.start(start).faces.find((f: Any) => f.id === 'turkish-van'), R.start(start));
  assert.equal(R.sameTool(kimi(START.ready), kimi(codexUnsure)), true);
  assert.equal(R.sameTool(kimi(START.ready), kimi(START.three)), false);
  assert.equal(R.sameTool(null, null), true);
});
