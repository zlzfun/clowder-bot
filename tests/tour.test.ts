import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { Doc, El, text } from './fake-dom.js';
import { catTemplates } from './native-fixture.js';

// The guide to what the app can do (showcase/, served at /tour/ by `npm run
// showcase`). It points at the staged chats by name, so it must never point at
// a chat the scene does not stage or play a demo the scene does not have; it
// says the staged chats run only when the scripted preview says so; a read
// that failed or came late never changes what it shows; it makes no request to
// another origin; every picture is there in both themes; and it is not part of
// the product. The page itself runs here as it is: index.html's body built
// into tests/fake-dom.ts, with tour-rules.js, tour.js and the product's own
// cat-avatars.js and chat-list-rules.js, against a fake server and clock. The
// script that retakes the pictures refuses anything but the staged showcase.
const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('showcase/index.html'), js = read('showcase/tour.js'), rulesJs = read('showcase/tour-rules.js'), css = read('showcase/tour.css');
const scene = read('scripts/showcase-scene.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((done) => setImmediate(done)); };

// What scripts/showcase-scene.ts stages: one cat per template, the groups it makes, and the chats with a demo line.
const cats = catTemplates.map(([, name]) => name);
const groups = [...scene.matchAll(/\n {4}const name = '([^']+)'/g)].map(m => m[1]!);
const playLines = /for \(const \[face, line\] of Object\.entries\(\{([\s\S]*?)\}\)\) plays\.set\(cats\[face\]!\.name/.exec(scene);
const playFaces = [...(playLines?.[1] ?? '').matchAll(/(?:'([\w-]+)'|(\w+)):\s*'/g)].map(m => m[1] ?? m[2]);
const plays = [...catTemplates.filter(([id]) => playFaces.includes(id)).map(([, name]) => name), ...groups.filter(() => (scene.match(/plays\.set\(name, \{ group: group\.id/g) || []).length === groups.length)];

const attrs = (name: string) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map(m => m[1]!);

function tourRules() {
  const window: Any = {};
  vm.runInNewContext(rulesJs, { window, setTimeout, clearTimeout, AbortController });
  return window.ClowderTourRules;
}
function listRules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-list-rules.js'), { window });
  return window.ClowderListRules;
}

// ---------------------------------------------------------------- what it points at
test('every chat the guide opens, plays, lists or hosts a section in is staged by the showcase, and every staged chat is on its list', () => {
  assert.deepEqual(groups, ['产品评审', '读书会'], 'the scene\'s groups, as this test reads them');
  assert.equal(playFaces.length, 8, 'the scene has a demo line for each cat');
  const opened = attrs('data-chat'), played = attrs('data-play'), listed = attrs('data-row'), hosts = attrs('data-host');
  const members = attrs('data-group').flatMap(list => list.split(/\s+/));
  assert.ok(opened.length >= 10 && played.length >= 8);
  for (const name of [...opened, ...listed, ...hosts]) assert.ok(cats.includes(name) || groups.includes(name), name + ' is staged');
  for (const name of members) assert.ok(cats.includes(name), name + ' is a staged cat');
  for (const name of played) assert.ok(plays.includes(name), name + ' has a demo line in the scene');
  assert.deepEqual([...listed].sort(), [...cats, ...groups].sort(), 'the opening list is the staged contact list');
  // A demo is an action, so it is a button; opening a chat is a link.
  assert.equal((html.match(/<button type="button" class="t-btn[^"]*" data-play="[^"]+">看它现场演示<\/button>/g) || []).length, played.length);
  assert.equal((html.match(/<a class="t-btn[^"]*" data-chat="[^"]+">/g) || []).length, opened.length);
  // The faces the guide draws are the templates the scene names its cats after.
  const faces = /const FACES = (\{[^}]*\});/.exec(js);
  assert.ok(faces, 'tour.js keeps the cats\' faces in one place');
  assert.deepEqual(plain(vm.runInNewContext('(' + faces![1] + ')')), Object.fromEntries(catTemplates.map(([id, name]) => [name, id])));
  for (const [, name, face] of html.matchAll(/data-row="([^"]+)" data-face="([^"]+)"/g)) assert.equal(face, catTemplates.find(([, n]) => n === name)?.[0], name);
  assert.doesNotMatch(html, /href="\/#chat=/, 'links are built from data-chat, not written by hand');
});

// ---------------------------------------------------------------- rules
test('the staged chats run only when the scripted preview says so: {preview: true, scene: "showcase", staged: true}; only its plays are played', () => {
  const T = tourRules();
  assert.equal(T.staged({ preview: true, scene: 'showcase', staged: true, plays: [] }), true);
  for (const other of [null, undefined, 'x', {}, { preview: true, scene: 'plain', staged: false }, { preview: true, scene: 'showcase', staged: false }, { preview: 'true', scene: 'showcase', staged: true }, { scene: 'showcase', staged: true }, { bots: cats }]) {
    assert.equal(T.staged(other), false, JSON.stringify(other));
  }
  assert.deepEqual([...T.plays({ preview: true, scene: 'showcase', staged: true, plays: ['布偶猫', 7, '读书会'] })], ['布偶猫', '读书会']);
  assert.deepEqual([...T.plays({ preview: true, scene: 'plain', staged: false, plays: ['布偶猫'] })], [], 'nothing is played where play would not be served');
});

const day = (ago: number) => new Date(Date.now() - ago).toISOString();
const entry = (name: string, activity: Any = {}, more: Any = {}) => ({ bot: name, state: 'idle', ...more, activity: { readStatus: 'ready', counts: { approval: 0, failure: 0, running: 0, queued: 0 }, unread: 0, unreadHasMore: false, active: [], last: { messageId: 'm-' + name, time: day(3_600_000), from: 'cat', catName: name, text: name + '最后说的话', files: 0 }, ...activity } });
const unavailable = (name: string, more: Any = {}) => ({ bot: name, state: 'idle', ...more, activity: { readStatus: 'unavailable', counts: { approval: 0, failure: 0, running: 0, queued: 0 }, unread: null, unreadHasMore: false, active: [], last: null } });

test('a row says what was read whole; an activity not read whole (unavailable, partial) says nothing, so the row keeps what it showed', () => {
  const T = tourRules(), R = listRules(), now = Date.now();
  const waiting = T.rowView(entry('小鲸鱼', { counts: { approval: 1, running: 0 }, unread: 2 }, { state: 'awaiting' }), false, R, now);
  assert.deepEqual(plain(waiting), { time: R.ago(Date.parse(waiting.iso), now), iso: waiting.iso, stamp: R.stamp(Date.parse(waiting.iso)), line: 'waiting', said: '小鲸鱼最后说的话', badge: '2', dot: true });
  assert.ok(waiting.time && waiting.stamp);
  assert.equal(T.rowView(entry('布偶猫', { counts: { running: 1 } }), false, R, now).line, 'busy');
  assert.equal(T.rowView(entry('布偶猫', { active: [{ catId: 'x' }] }), false, R, now).line, 'busy');
  assert.equal(T.rowView(entry('产品评审', { last: { messageId: 'g', time: day(60_000), from: 'cat', catName: '暹罗猫', text: '怕大家嫌它太素', files: 0 } }), true, R, now).said, '暹罗猫：怕大家嫌它太素');
  assert.equal(T.rowView(unavailable('小鲸鱼'), false, R, now), null, 'unavailable: unread null and zero counts are placeholders, not "nothing waiting"');
  assert.equal(T.rowView(entry('小鲸鱼', { readStatus: 'partial', unread: null }), false, R, now), null);
  assert.equal(T.rowView({ bot: 'x' }, false, R, now), null);
  assert.equal(T.rowView(null, false, R, now), null);
});

// A clock the tests move by hand.
function clock() {
  let now = 0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  return {
    setTimeout: (fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    setInterval: (fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { at: now + ms, fn, every: ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    clearInterval: (id: number) => { timers.delete(id); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

test('one read at a time: calls while a read runs ask for one more after it, a read is given up after its time, and a late answer is dropped', async () => {
  const T = tourRules(), c = clock();
  const runs: Array<{ signal: AbortSignal; current: () => boolean; done: (v?: unknown) => void }> = [];
  let visible = true;
  const s = T.serial(({ signal, current }: Any) => new Promise((done) => runs.push({ signal, current, done })), { ms: 6000, visible: () => visible, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, AbortController });
  s.refresh(); s.refresh(); s.refresh();
  await settle();
  assert.equal(runs.length, 1, 'never two in flight');
  runs[0]!.done();
  await settle();
  assert.equal(runs.length, 2, 'the calls made meanwhile become exactly one more read');
  runs[1]!.done();
  await settle();
  assert.equal(runs.length, 2, 'and no more');
  // Given up: the signal aborts, current() turns false, the next call starts at once.
  s.refresh();
  await settle();
  assert.equal(runs[2]!.current(), true);
  await c.advance(6000);
  assert.equal(runs[2]!.signal.aborted, true);
  assert.equal(runs[2]!.current(), false, 'an answer arriving now is dropped');
  s.refresh();
  await settle();
  assert.equal(runs.length, 4, 'a stalled read does not hold the next one back');
  // reset() (the chats stopped): the running read's answer is dropped too.
  s.reset();
  assert.equal(runs[3]!.current(), false);
  runs[3]!.done();
  await settle();
  // Nothing at all while the page is hidden.
  visible = false;
  s.refresh();
  await settle();
  assert.equal(runs.length, 4);
});

// ---------------------------------------------------------------- the page, running
// index.html's body as a tree of tests/fake-dom.ts elements (the page is hand-written and well formed).
function build(doc: Doc, source: string) {
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(source)![1]!;
  const VOID = new Set(['img', 'source', 'br', 'meta', 'link', 'input', 'hr']);
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const stack: El[] = [doc.body];
  const re = /<!--[\s\S]*?-->|<script[\s\S]*?<\/script>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1]) { stack.pop(); continue; }
    if (m[2]) {
      const tag = m[2].toLowerCase(), el = doc.createElement(tag);
      for (const a of (m[3] ?? '').matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
        if (a[1] === 'hidden') el.hidden = true; else el.setAttribute(a[1]!, decode(a[2] ?? ''));
      }
      stack.at(-1)!.append(el);
      if (!VOID.has(tag)) stack.push(el);
      continue;
    }
    if (m[4]) stack.at(-1)!.append(decode(m[4]));
  }
}

const cast = Object.fromEntries(catTemplates.map(([id, name]) => [name, id]));
const identity = (more: Any = {}) => ({ preview: true, scene: 'showcase', staged: true, zone: 'Asia/Shanghai', plays: [...cats, ...groups], cats, ...more });
const botsAnswer = { bots: cats.map(name => ({ name, avatar_seed: 'cat:' + cast[name], templateId: cast[name], accent: { primary: '#5B8C5A', secondary: '#D4E6D3' } })) };
const groupsAnswer = { groups: [{ id: 'g-review', name: '产品评审', members: ['布偶猫', '缅因猫', '暹罗猫'] }, { id: 'g-books', name: '读书会', members: ['小鲸鱼', '狸花猫', '梵花猫', '金渐层'] }] };
const status = (over: Record<string, Any> = {}) => ({
  bots: cats.map(name => over[name] ?? entry(name)),
  groups: [{ id: 'g-review', thread_id: 'g-review', ...entry('产品评审') }, { id: 'g-books', thread_id: 'g-books', ...entry('读书会') }].map(g => over[g.id] ? { id: g.id, ...over[g.id] } : g),
});

function page(opts: { abortable?: boolean } = {}) {
  const doc = new Doc();
  const patch = (el: Any) => { el.style.setProperty = (k: string, v: string) => { el.style[k] = v; }; el.style.removeProperty = (k: string) => { delete el.style[k]; }; return el; };
  const make = doc.createElement.bind(doc), makeNS = doc.createElementNS.bind(doc);
  doc.createElement = ((tag: string) => patch(make(tag))) as Any;
  doc.createElementNS = ((ns: string, tag: string) => patch(makeNS(ns, tag))) as Any;
  (doc as Any).visibilityState = 'visible';
  (doc as Any).head = { append: (s: Any) => { Promise.resolve().then(() => s.onload && s.onload()); } };
  build(doc, html);
  const c = clock();
  const requests: Array<{ path: string; init: Any; done: boolean; answer: (body: unknown, status?: number) => void }> = [];
  const fetch = (path: string, init: Any = {}) => new Promise((resolveIt, reject) => {
    const req = {
      path, init, done: false,
      answer(body: unknown, code = 200) { if (req.done) return; req.done = true; resolveIt({ ok: code < 300, status: code, json: async () => body }); },
    };
    if (opts.abortable !== false) init.signal?.addEventListener('abort', () => { if (!req.done) { req.done = true; reject(new Error('aborted')); } });
    requests.push(req);
  });
  const listeners = new Map<string, Array<(ev: Any) => void>>();
  const store = new Map<string, string>();
  const assigned: string[] = [];
  const window: Any = {
    addEventListener: (type: string, fn: (ev: Any) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const context = vm.createContext({
    window, document: doc, console, fetch, AbortController,
    setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, setInterval: c.setInterval, clearInterval: c.clearInterval,
    matchMedia: window.matchMedia,
    location: { protocol: 'http:', assign: (url: string) => { assigned.push(url); } },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); } },
  });
  for (const file of ['client/public/cat-avatars.js', 'client/public/chat-list-rules.js', 'showcase/tour-rules.js', 'showcase/tour.js']) vm.runInContext(read(file), context);
  const pending = (path: string) => requests.filter(r => r.path === path && !r.done);
  // The newest request for that path (an older one may still hang, given up).
  const answer = async (path: string, body: unknown, code = 200) => {
    await settle();
    const req = pending(path).at(-1);
    assert.ok(req, 'a request for ' + path + ' is waiting (made: ' + requests.map(r => r.path).join(', ') + ')');
    req.answer(body, code);
    await settle();
  };
  const row = (name: string) => doc.body.querySelector(`[data-row="${name}"]`)!;
  const line = (name: string) => text(row(name).querySelector('.t-row-line'));
  const count = (name: string) => text(row(name).querySelector('.t-row-count'));
  const time = (name: string) => text(row(name).querySelector('.t-row-time'));
  const dot = (name: string) => !!row(name).querySelector('.t-row-dot');
  const playButton = (name: string) => doc.body.querySelector(`button[data-play="${name}"]`)!;
  const chip = () => text(doc.body.querySelector('#live .t-live-text'));
  const off = () => doc.body.querySelector('#off')!.classList.contains('on');
  const actions = () => doc.body.querySelectorAll('.t-actions').map((n: El) => !n.hidden);
  const fire = (type: string, ev: Any = {}) => { for (const fn of listeners.get(type) ?? []) fn(ev); };
  // Boot with the staged showcase behind the page and everything read.
  const stage = async (id: Any = identity(), first: Any = status()) => {
    await answer('/__preview', id);
    await answer('/xbot-api/bots', botsAnswer);
    await answer('/xbot-api/groups', groupsAnswer);
    await answer('/xbot-api/bots/status', first);
  };
  return { doc, c, requests, pending, answer, row, line, count, time, dot, playButton, chip, off, actions, fire, stage, store, assigned };
}

test('the page says the staged chats run only when GET /__preview says so; anything else is "not running", with no buttons and no further reads', async () => {
  for (const [what, reply] of [['no such route (another server)', [{ error: 'not found' }, 404]], ['the plain preview', [{ preview: true, scene: 'plain', staged: false, plays: [], cats: ['团子', '栗子'] }, 200]], ['the showcase not staged yet', [{ preview: true, scene: 'showcase', staged: false, plays: [] }, 200]]] as const) {
    const p = page();
    await p.answer('/__preview', reply[0], reply[1]);
    assert.equal(p.chip(), '示例对话没在运行', what);
    assert.equal(p.off(), true, what + ': says how to start them');
    assert.ok(p.actions().every((shown: boolean) => !shown), what + ': no buttons');
    assert.ok(p.doc.body.querySelectorAll('button[data-play]').every((b: El) => b.hidden), what + ': nothing to play');
    assert.deepEqual(p.requests.map(r => r.path), ['/__preview'], what + ': the chats themselves are never read');
    assert.equal(p.line('小鲸鱼'), '每天 9 点的提醒，到点在对话里叫你', 'each row keeps its own line');
    // Not every 8 seconds: only coming back to the page looks again.
    await p.c.advance(16_000);
    assert.equal(p.requests.length, 1, what);
    p.doc.listeners.get('visibilitychange')!.forEach(fn => fn({}));
    await settle();
    assert.equal(p.pending('/__preview').length, 1, what + ': coming back asks again');
  }
  // Staged, but one chat cannot be played: its button is not offered, the others are.
  const p = page();
  await p.stage(identity({ plays: cats.filter(n => n !== '孟加拉猫') }));
  assert.equal(p.chip(), '示例对话在运行');
  assert.equal(p.off(), false);
  assert.ok(p.actions().every((shown: boolean) => shown));
  assert.equal(p.playButton('孟加拉猫').hidden, true);
  assert.equal(p.playButton('布偶猫').hidden, false);
  assert.equal(p.line('布偶猫'), '布偶猫最后说的话', 'the rows say what the chats say now');
});

test('a row whose activity was not read whole keeps what it showed: 等你确认, the unread count and the time are never cleared by a failed read', async () => {
  const p = page();
  await p.stage(identity(), status({
    小鲸鱼: entry('小鲸鱼', { counts: { approval: 1, running: 0 }, unread: 2 }, { state: 'awaiting' }),
    狸花猫: unavailable('狸花猫'),
  }));
  assert.equal(p.line('小鲸鱼'), '等你确认');
  assert.equal(p.count('小鲸鱼'), '2');
  assert.equal(p.dot('小鲸鱼'), true);
  const shown = p.time('小鲸鱼');
  assert.ok(shown);
  // First read unavailable: the row's own line, and no claim about unread or waiting.
  assert.equal(p.line('狸花猫'), '想记住你的习惯，先问你一句');
  assert.equal(p.count('狸花猫'), '');
  assert.equal(p.dot('狸花猫'), false);
  assert.equal(p.time('狸花猫'), '');
  // The next read: 小鲸鱼's activity unavailable (unread null, zero counts, no last line), 布偶猫's partial.
  await p.c.advance(8000);
  await p.answer('/xbot-api/bots/status', status({ 小鲸鱼: unavailable('小鲸鱼', { state: 'idle' }), 布偶猫: entry('布偶猫', { readStatus: 'partial', unread: null, last: null }) }));
  assert.equal(p.line('小鲸鱼'), '等你确认', 'still waiting, as far as anyone knows');
  assert.equal(p.count('小鲸鱼'), '2');
  assert.equal(p.dot('小鲸鱼'), true);
  assert.equal(p.time('小鲸鱼'), shown);
  assert.equal(p.line('布偶猫'), '布偶猫最后说的话');
  // A whole read later says it was answered: now it changes.
  await p.c.advance(8000);
  await p.answer('/xbot-api/bots/status', status());
  assert.equal(p.line('小鲸鱼'), '小鲸鱼最后说的话');
  assert.equal(p.count('小鲸鱼'), '');
  assert.equal(p.dot('小鲸鱼'), false);
  // The whole status read failing changes nothing while the preview still says the chats are staged.
  await p.c.advance(8000);
  await p.answer('/xbot-api/bots/status', { error: 'busy' }, 503);
  await p.answer('/__preview', identity());
  assert.equal(p.chip(), '示例对话在运行');
  assert.equal(p.line('布偶猫'), '布偶猫最后说的话');
});

test('reads never overlap or come out of order: a tick or coming back while one runs adds one read after it, a slow one is given up, its late answer dropped, nothing while hidden', async () => {
  const p = page({ abortable: false }); // a server that keeps answering after the page gave up
  await p.stage();
  await p.c.advance(8000);
  assert.equal(p.pending('/xbot-api/bots/status').length, 1);
  // Coming back to the tab and another tick while it runs: still one in flight.
  p.doc.listeners.get('visibilitychange')!.forEach(fn => fn({}));
  await p.c.advance(5000);
  assert.equal(p.pending('/xbot-api/bots/status').length, 1, 'no pile of reads');
  await p.answer('/xbot-api/bots/status', status({ 布偶猫: entry('布偶猫', { counts: { running: 1 } }) }));
  assert.equal(p.line('布偶猫'), '正在输入…');
  // Exactly one read after it, and its (newer) answer is the one shown.
  assert.equal(p.pending('/xbot-api/bots/status').length, 1);
  await p.answer('/xbot-api/bots/status', status({ 布偶猫: entry('布偶猫', { last: { messageId: 'n', time: day(1000), from: 'cat', text: '写完了', files: 0 } }) }));
  assert.equal(p.line('布偶猫'), '写完了');
  assert.equal(p.pending('/xbot-api/bots/status').length, 0);
  // A read that hangs is given up after 6 s; the next tick reads again and shows its answer …
  await p.c.advance(3000);
  const slow = p.pending('/xbot-api/bots/status')[0]!;
  assert.ok(slow);
  await p.c.advance(6000);
  assert.equal(slow.init.signal.aborted, true, 'given up');
  await p.c.advance(3000); // the next tick (its own 6 s have not run out)
  await p.answer('/xbot-api/bots/status', status({ 布偶猫: entry('布偶猫', { last: { messageId: 'z', time: day(500), from: 'cat', text: '更新的一句', files: 0 } }) }));
  assert.equal(p.line('布偶猫'), '更新的一句');
  // … and the old answer, arriving now, does not paint over it.
  slow.answer(status({ 布偶猫: entry('布偶猫', { counts: { running: 1 } }) }));
  await settle();
  assert.equal(p.line('布偶猫'), '更新的一句', 'a late answer is dropped');
  // Hidden: no reads at all.
  (p.doc as Any).visibilityState = 'hidden';
  const before = p.requests.length;
  await p.c.advance(30_000);
  assert.equal(p.requests.length, before);
});

test('看它现场演示 is a button: one press starts exactly one demo and opens the chat here; a middle click or a second press does nothing more; a refusal is said in place', async () => {
  const p = page();
  await p.stage();
  const b = p.playButton('布偶猫');
  assert.equal(b.tagName, 'BUTTON');
  b.dispatch('click', { button: 0, metaKey: true });
  b.dispatch('click', { button: 0 });
  b.dispatch('auxclick', { button: 1 });
  await settle();
  const posts = p.requests.filter(r => r.path === '/__preview' && r.init.method === 'POST');
  assert.equal(posts.length, 1, 'exactly one demo');
  assert.deepEqual(JSON.parse(posts[0]!.init.body), { play: '布偶猫' });
  assert.equal(b.getAttribute('aria-busy'), 'true');
  assert.equal(text(b), '正在开始…');
  assert.deepEqual(p.assigned, [], 'the chat opens only once the showcase took the line');
  posts[0]!.answer({ ok: true });
  await settle();
  assert.deepEqual(p.assigned, ['/#chat=' + encodeURIComponent('布偶猫')], 'opened in this tab; Back returns here');
  assert.deepEqual(JSON.parse(p.store.get('clowder-tour:seen')!), ['布偶猫'], 'its row gets its stamp on the way back');
  // A middle click alone starts nothing.
  p.playButton('缅因猫').dispatch('auxclick', { button: 1 });
  await settle();
  assert.equal(p.requests.filter(r => r.path === '/__preview' && r.init.method === 'POST').length, 1);
  // Refused: said in place, the visitor stays, the button is ready again.
  const m = p.playButton('孟加拉猫');
  m.dispatch('click', { button: 0 });
  await settle();
  p.requests.filter(r => r.path === '/__preview' && r.init.method === 'POST' && !r.done)[0]!.answer({ error: 'play: not sent' }, 502);
  await settle();
  assert.equal(text(m.closest('.t-copy')!.querySelector('.t-note')), '没能开始演示：示例没有收下这句话（502）。可以先打开这个对话看看。');
  assert.equal(p.assigned.length, 1);
  assert.equal(m.getAttribute('aria-busy'), null);
  assert.equal(text(m), '看它现场演示');
  // The plain link beside it opens the chat (a new tab is the browser's own), and stamps it.
  const link = p.doc.body.querySelector('a[data-chat="缅因猫"]')!;
  assert.equal(link.href, '/#chat=' + encodeURIComponent('缅因猫'));
  link.dispatch('click', { button: 0 });
  assert.ok(JSON.parse(p.store.get('clowder-tour:seen')!).includes('缅因猫'));
});

// ---------------------------------------------------------------- the pictures' script
test('the script that retakes the pictures refuses anything but the staged showcase, before it loads or opens anything', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'no-playwright-'));
  try {
    const cases: Array<[string, (path: string) => [number, string]]> = [
      ['a real instance with the same cat names', (path) => path === '/xbot-api/bots' ? [200, JSON.stringify({ bots: cats.map(name => ({ name })) })] : [404, '{"error":"not found"}']],
      ['the plain preview', (path) => path === '/__preview' ? [200, JSON.stringify({ preview: true, scene: 'plain', staged: false, plays: [], cats: ['团子'] })] : [404, '{}']],
      ['the showcase before its chats are staged', (path) => path === '/__preview' ? [200, JSON.stringify({ preview: true, scene: 'showcase', staged: false, plays: [] })] : [404, '{}']],
      ['a page that is not JSON', () => [200, '<!doctype html><title>x</title>']],
    ];
    for (const [what, answer] of cases) {
      const seen: string[] = [];
      const server = createServer((req, res) => { seen.push(req.method + ' ' + req.url); const [code, body] = answer(req.url!.split('?')[0]!); res.writeHead(code, { 'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json' }); res.end(body); });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const { port } = server.address() as { port: number };
      const child = spawn(process.execPath, ['scripts/showcase-shots.mjs'], { cwd: root, env: { ...process.env, BASE: `http://127.0.0.1:${port}/`, PLAYWRIGHT_MODULES: empty }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
      const code = await new Promise<number | null>((done) => child.once('exit', done));
      await new Promise<void>((done) => server.close(() => done()));
      assert.equal(code, 1, what);
      assert.match(out, /is not the showcase with its chats staged \(its GET \/__preview did not say so\), so nothing was opened or taken/, what);
      assert.doesNotMatch(out, /Playwright/, what + ': refused before Playwright is even looked for');
      assert.deepEqual(seen, ['GET /__preview'], what + ': it only asked what BASE is');
    }
  } finally { rmSync(empty, { recursive: true, force: true }); }
  const shots = read('scripts/showcase-shots.mjs');
  assert.match(shots, /timezoneId: zone/, 'the browser runs in the showcase\'s own time zone');
  assert.match(shots, /TZ=Asia\/Shanghai npm run showcase/, 'the committed set comes from a showcase in Asia/Shanghai');
});

// ---------------------------------------------------------------- origin, pictures, words
test('the guide makes no request to another origin: no absolute URL anywhere, every read and asset on the same origin', () => {
  for (const [file, source] of [['index.html', html], ['tour.js', js], ['tour-rules.js', rulesJs], ['tour.css', css]] as const) {
    assert.doesNotMatch(source, /\b(?:https?|wss?):\/\//i, file + ' names no other site');
    assert.doesNotMatch(source, /(?:src|href|srcset)\s*=\s*["']\/\//i, file + ' has no protocol-relative URL');
    assert.doesNotMatch(source, /url\(\s*["']?(?:\/\/|https?:)/i, file + ' loads nothing from elsewhere in CSS');
    assert.doesNotMatch(source, /@import/i, file);
  }
  for (const url of [...attrs('src'), ...attrs('href'), ...attrs('srcset')]) assert.match(url, /^(?:\/(?!\/)|#|[\w.-]+(?:\/[\w.-]+)*$)/, url + ' is same-origin');
  for (const [, url] of js.matchAll(/(?:fetch|get)\("([^"]+)"/g)) assert.match(url!, /^\/(?!\/)/, url + ' is a path on this origin');
  // The product's stylesheets and modules are loaded from where the app serves them, not copied.
  for (const asset of ['tokens.css', 'app.css', 'cafe-theme.css', 'chat-presence.css']) assert.ok(html.includes(`href="/${asset}"`), asset);
  assert.match(js, /load\(ROOT \+ "cat-avatars\.js"\), load\(ROOT \+ "chat-list-rules\.js"\)/);
  assert.ok(html.indexOf('<script src="tour-rules.js"></script>') < html.indexOf('<script src="tour.js"></script>'));
  assert.deepEqual(readdirSync(new URL('../showcase/', import.meta.url)).filter(f => !['index.html', 'tour.css', 'tour.js', 'tour-rules.js', 'shots'].includes(f)), [], 'nothing else in showcase/');
});

test('every picture is a real screenshot in both themes, loaded with the page, with words that say what it shows, and the set stays small', () => {
  const lights = [...html.matchAll(/<img src="shots\/([\w-]+)-light\.png"[^>]*\salt="([^"]*)"/g)];
  const darks = [...html.matchAll(/<source srcset="shots\/([\w-]+)-dark\.png" media="\(prefers-color-scheme: dark\)">/g)].map(m => m[1]);
  assert.ok(lights.length >= 12);
  assert.deepEqual(lights.map(m => m[1]), darks, 'each picture has its dark twin, switched by the system theme');
  assert.doesNotMatch(html, /loading="lazy"/, 'loaded with the page, so a printed page has every picture');
  for (const [, name, alt] of lights) {
    assert.ok(alt!.length >= 12, name + ' has words for what it shows');
    for (const theme of ['light', 'dark']) assert.ok(existsSync(new URL(`../showcase/shots/${name}-${theme}.png`, import.meta.url)), `${name}-${theme}.png`);
  }
  assert.equal((html.match(/<img /g) || []).length, lights.length + 1, 'the brand mark is the only other image');
  const dir = new URL('../showcase/shots/', import.meta.url);
  const files = readdirSync(dir);
  assert.deepEqual(files.filter(f => !lights.some(([, name]) => f === `${name}-light.png` || f === `${name}-dark.png`)), [], 'no picture the page does not show');
  const total = files.reduce((n, f) => n + statSync(new URL(f, dir)).size, 0);
  assert.ok(total < 4.2 * 1024 * 1024, `${(total / 1048576).toFixed(2)} MB of pictures`);
  const shots = read('scripts/showcase-shots.mjs');
  assert.match(shots, /process\.env\.PLAYWRIGHT_MODULES/);
  assert.match(shots, /Playwright was not found in \$\{modules\}; set PLAYWRIGHT_MODULES/);
  assert.match(shots, /deviceScaleFactor: 2/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies }).includes('playwright'), 'Playwright is not a dependency');
});

test('printed or saved as PDF, every section shows, the words in the light theme, without what needs the running showcase, pictures kept whole', () => {
  const print = /@media print \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(print, /\.t-js \.t-reveal \{ opacity: 1 !important; transform: none !important;/);
  assert.match(print, /\.t-back, \.t-skip, \.t-live, \.t-actions, \.t-note/);
  assert.match(print, /\.t-fig, \.t-fig picture, \.t-tile,[^{]*\{ break-inside: avoid; \}/);
  assert.match(print, /\.t-float img, img\.t-float \{ box-shadow: none; \}/);
  assert.match(html, /!printing && !\(print && print\.matches\) \? "dark" : "light"/, 'the theme script prints in the light theme');
  assert.match(js, /addEventListener\("beforeprint"/, 'and every section and picture is ready before printing');
});

test('the guide speaks the app\'s own words, says once that the chats are staged, claims no more than is true, and is not part of the product', () => {
  const words = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*\salt="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, ' ');
  const literals = [js, rulesJs].map(src => [...src.replace(/^\s*\/\/.*$/gm, '').matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]).filter(s => /\p{Script=Han}/u.test(s!)).join(' ')).join(' ');
  for (const [where, said] of [['page', words], ['scripts', literals]] as const) {
    const plainWords = said!.replace(/clowder-bot/g, '');
    assert.doesNotMatch(plainWords, /\bBot\b|\bAgent\b|session|thread|会话|原生|群组/i, where + ' says 猫猫、对话、群聊');
  }
  assert.equal((words.match(/事先写好/g) || []).length, 1, 'staged, said once');
  assert.match(words, /npm run showcase/);
  // Memory: only a remembered preference with a recorded source leads back to its sentence.
  assert.doesNotMatch(words, /每一条都能回到/);
  assert.match(words, /记住的偏好记下了出处时，还能回到当初说的那句话/);
  // Not linked from the product, not in its build.
  for (const file of readdirSync(new URL('../client/public/', import.meta.url)).filter(f => /\.(js|css|html)$/.test(f))) {
    assert.doesNotMatch(read('client/public/' + file), /\/tour\/|showcase\//, file + ' does not link the guide');
  }
  assert.doesNotMatch(read('client/index.html'), /\/tour\/|showcase\//);
  // Landmarks, one h1, headings for each part, a way past the header.
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  for (const tag of ['<header', '<main id="main"', '<footer', '<nav class="t-roster"']) assert.ok(html.includes(tag), tag);
  assert.match(html, /<a class="t-skip" href="#main">/);
  for (const id of attrs('aria-labelledby')) assert.ok(html.includes(`id="${id}"`), id);
  // Motion only on the product's own tokens and keyframes, and none when reduced motion is asked for.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ html \{ scroll-behavior: auto; \} \}/);
  assert.match(js, /reduce\(\) \? "auto" : "smooth"/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'no colour of its own: tokens only (a cat\'s accent comes from the server)');
});
