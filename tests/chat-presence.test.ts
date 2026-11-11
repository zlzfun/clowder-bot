import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El, text } from './fake-dom.js';
import { messageDisplayText } from '../server/native/message-presentation.js';

// 活起来 (chat-presence-rules.js, chat-presence.js; the leading signature in
// chat-live-rules.js). The rules run in a bare VM; the DOM module runs as
// the classic script it is on the small DOM of tests/fake-dom.ts, together
// with the real chat-live.js (whose replies it watches) and the real
// experience rules (the sidebar's status kinds). The café surfaces are read
// from cafe-theme.css itself and the colour pairs are the pinned engine's
// own template colours, so the legibility rule is checked on what ships.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function load(...files: string[]) {
  const window: Any = {};
  const context = vm.createContext({ window });
  for (const f of files) vm.runInContext(read('client/public/' + f), context);
  return window;
}
const rules = () => load('chat-live-rules.js', 'chat-presence-rules.js').ClowderPresenceRules;
const liveRules = () => load('chat-live-rules.js').ClowderLiveRules;

// The café theme's own surfaces (cafe-theme.css): the chat card and the reply bubble.
function theme(dark: boolean) {
  const css = read('client/public/cafe-theme.css');
  const block = dark ? css.slice(css.indexOf('html[data-theme="dark"] {')) : css.slice(css.indexOf(':root {'));
  const token = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)![1];
  return { chat: token('--x-card'), bubble: token('--x-bot-bubble') };
}
const LIGHT = theme(false), DARK = theme(true);
// From the pinned engine's cat-template.json (breed colours).
const PAIRS: Record<string, { primary: string; secondary: string }> = {
  ragdoll: { primary: '#9B7EBD', secondary: '#E8DFF5' }, 'maine-coon': { primary: '#5B8C5A', secondary: '#D4E6D3' },
  siamese: { primary: '#5B9BD5', secondary: '#D6E9F8' }, 'turkish-van': { primary: '#6B6F9E', secondary: '#E2E3F0' },
  dsh: { primary: '#3B7EA1', secondary: '#DCEBF2' }, 'dragon-li': { primary: '#D4A76A', secondary: '#F5EBD7' },
  bengal: { primary: '#D4853A', secondary: '#FAEBDB' }, 'golden-chinchilla': { primary: '#C8A951', secondary: '#F5EDDA' },
  moonshot: { primary: '#4B5563', secondary: '#E5E7EB' }, 'opus-47': { primary: '#7B1FA2', secondary: '#E1BEE7' },
};

// ---------------------------------------------------------------- colour
test('a cat\'s colour is used only where it stays legible on the café surfaces (words 4.5:1, glyphs 3:1), else the theme\'s own colour', () => {
  const R = rules();
  const bot = (breed: string) => ({ name: breed, native_id: 'cat-' + breed, accent: PAIRS[breed] });
  // Light: the maine-coon green is legible as a glyph on the bubble and the chat, not as words.
  assert.deepEqual({ ...R.tints(bot('maine-coon'), LIGHT) }, { ink: '', paw: '#5b8c5a', seen: '#5b8c5a' });
  // A golden chinchilla's gold is too pale for anything on cream: everything stays the theme's.
  assert.deepEqual({ ...R.tints(bot('golden-chinchilla'), LIGHT) }, { ink: '', paw: '', seen: '' });
  // Dark: gold names; where the primary is too dark, the pale secondary carries the name.
  assert.deepEqual({ ...R.tints(bot('golden-chinchilla'), DARK) }, { ink: '#c8a951', paw: '#c8a951', seen: '#c8a951' });
  assert.deepEqual({ ...R.tints(bot('maine-coon'), DARK) }, { ink: '#d4e6d3', paw: '#5b8c5a', seen: '#5b8c5a' });
  assert.equal(R.tints(bot('moonshot'), DARK).paw, '#e5e7eb', 'a primary too dark for the dark bubble gives way to its secondary');
  // Whatever is chosen meets its ratio on the surface it sits on, for every engine colour and for random pairs.
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return '#' + (seed % 0xffffff).toString(16).padStart(6, '0'); };
  const pairs = [...Object.values(PAIRS), ...Array.from({ length: 400 }, () => ({ primary: rnd(), secondary: rnd() }))];
  for (const surfaces of [LIGHT, DARK]) for (const accent of pairs) {
    const t = R.tints({ accent }, surfaces);
    for (const [use, surface, min] of [['ink', surfaces.chat, 4.5], ['paw', surfaces.bubble, 3], ['seen', surfaces.chat, 3]] as const) {
      const c = t[use];
      if (!c) continue;
      assert.ok([accent.primary.toLowerCase(), accent.secondary.toLowerCase()].includes(c), 'only the cat\'s own pair');
      assert.ok(R.contrast(c, surface) >= min, `${use} ${c} on ${surface}`);
    }
  }
  // No pair, or not exactly #rrggbb twice: no colour at all (the cat looks as before).
  for (const accent of [undefined, null, { primary: '#888', secondary: '#eee' }, { primary: '#5b8c5a' }, { primary: 'green', secondary: '#ffffff' }])
    assert.equal(R.tints({ accent }, LIGHT), null);
  // A surface that cannot be judged (missing, see-through, a variable) decides nothing.
  for (const surface of ['', 'rgba(0, 0, 0, .5)', 'var(--x-card)', '#00000080'])
    assert.equal(R.legible(PAIRS['opus-47'], surface, 3), '');
  assert.equal(R.legible(PAIRS['opus-47'], 'rgb(255, 251, 245)', 4.5), '#7b1fa2');
  assert.equal(Math.round(R.contrast('#000000', '#ffffff')), 21);
});

test('the colours become one style sheet keyed by the speaker each row already carries; nothing for a cat without a pair or a use that is not legible', () => {
  const R = rules();
  const bots = [
    { name: '栗子', native_id: 'cat-b', accent: PAIRS['maine-coon'] },
    { name: '团子', native_id: 'cat-a', accent: PAIRS['golden-chinchilla'] },
    { name: '年糕', native_id: 'cat-c' },
  ];
  const light = R.accentCss(bots, LIGHT).split('\n');
  assert.deepEqual(light, [
    '.thread-inner > .msg[data-sender="bot:cat:cat-b"] { --pz-paw: #5b8c5a; --pz-paw-strength: 1; }',
    '.pz-seen[data-cat="cat-b"] { color: #5b8c5a; }',
  ]);
  const dark = R.accentCss(bots, DARK);
  assert.match(dark, /^\.thread-inner\.grpchat > \.msg\[data-sender="bot:cat:cat-a"\] \.who > span:first-child \{ color: #c8a951; \}$/m, 'a group speaker\'s name');
  assert.match(dark, /\[data-sender="bot:cat:cat-b"\] \.who > span:first-child \{ color: #d4e6d3; \}/);
  assert.doesNotMatch(dark, /cat-c/);
  assert.equal(R.accentCss([], LIGHT), '');
  // An identifier is always quoted safely.
  assert.match(R.accentCss([{ native_id: 'a"b\\c', accent: PAIRS['opus-47'] }], LIGHT), /\[data-cat="a\\"b\\\\c"\]/);
});

// ---------------------------------------------------------------- words
test('the header says what the cat is doing in a messenger\'s few words, from the live replies; a group says who', () => {
  const R = rules(), L = liveRules();
  const one = (phase: string, tool = '') => ({ key: 'bot:团子', stopping: false, replies: [{ id: 'm', catId: 'a', phase, tool }] });
  const say = (now: Any, group = false) => R.headerLine(now, (id: string) => ({ a: '团子', b: '栗子', c: '年糕' } as Any)[id] || '', group, L.verb);
  assert.equal(say({ replies: [] }), '');
  assert.equal(say(one('start')), '正在输入…', 'started, words not yet: the typing bubble');
  assert.equal(say(one('text')), '正在输入…');
  assert.equal(say(one('thinking')), '在想…');
  for (const tool of ['Read', 'Grep', 'WebSearch', 'WebFetch', 'mcp__memory__recall', 'mcp__search__query']) assert.equal(say(one('step', tool)), '在查资料…', tool);
  for (const tool of ['Write', 'Edit', 'file_change']) assert.equal(say(one('step', tool)), '在写文件…', tool);
  for (const tool of ['Bash', 'command_execution']) assert.equal(say(one('step', tool)), '在运行命令…', tool);
  assert.equal(say(one('step', 'Task')), '在分头处理…');
  assert.equal(say(one('step', 'TodoWrite')), '在列计划…');
  assert.equal(say(one('step', 'SomethingNew')), '在处理…');
  assert.equal(say({ ...one('text'), stopping: true }), '正在停止…');
  // Groups: who is writing.
  assert.equal(say(one('thinking'), true), '团子在想…');
  assert.equal(say({ replies: [{ catId: 'a', phase: 'text' }, { catId: 'b', phase: 'step', tool: 'Read' }] }, true), '团子、栗子正在输入…');
  assert.equal(say({ replies: [{ catId: 'a', phase: 'text' }, { catId: 'b', phase: 'text' }, { catId: 'c', phase: 'text' }] }, true), '3 只猫猫正在输入…');
  // A reply nobody named (no cat) says nothing.
  assert.equal(say({ replies: [{ catId: '', phase: 'text' }] }), '');
});

test('a sidebar row shows the live words for the open chat, the status\'s busy line elsewhere, and never covers what needs the owner', () => {
  const R = rules();
  assert.equal(R.rowShows('idle', '正在输入…'), 'live');
  assert.equal(R.rowShows('running', '在想…'), 'live');
  assert.equal(R.rowShows('queued', '正在输入…'), 'live');
  assert.equal(R.rowShows('running', ''), 'status');
  assert.equal(R.rowShows('queued', ''), '');
  assert.equal(R.rowShows('idle', ''), '');
  for (const kind of ['awaiting', 'failure', 'unknown']) assert.equal(R.rowShows(kind, '正在输入…'), '', kind);
});

test('seen: only a reply that exists and names the owner\'s message (native.replyTo) marks it; the paw goes by the latest one picked up', () => {
  const R = rules();
  const user = (id: string) => ({ role: 'user', id, native_message_id: id, native: { id, type: 'user' } });
  const reply = (id: string, to: string, cat = 'a', more: Any = {}) => ({ role: 'assistant', id, native_message_id: id, native_cat_id: cat, native: { id, type: 'assistant', catId: cat, replyTo: to }, ...more });
  // u1 answered (settled), u2 being answered (in progress), u3 still waiting in the queue.
  const rows = [user('u1'), reply('r1', 'u1'), user('u2'), reply('r2', 'u2', 'a', { in_progress: true }), user('u3')];
  const seen = R.picked(rows);
  assert.deepEqual([...seen.keys()], ['u1', 'u2']);
  assert.deepEqual(JSON.parse(JSON.stringify(R.seenMark(['u1', 'u2', 'u3'], seen))), { id: 'u2', cats: ['a'] }, 'the latest picked up; the waiting one has none');
  assert.equal(R.seenMark(['u3'], seen), null);
  // A refusal said by name, a reply to a message not on this page, and a quote by the owner are not answers.
  const others = R.picked([user('u4'), reply('n1', 'u4', 'a', { notice: true }), reply('r9', 'gone'), { role: 'user', id: 'u5', native: { replyTo: 'u4' } }]);
  assert.equal(others.size, 0);
  // Group rows (kind person / bot, id is the native ID); two cats answering one message.
  const group = R.picked([{ kind: 'person', id: 'g1' }, { kind: 'bot', id: 'x', native_cat_id: 'a', native: { replyTo: 'g1' } }, { kind: 'bot', id: 'y', native_cat_id: 'b', native: { replyTo: 'g1' } }, { kind: 'bot', id: 'z', native_cat_id: 'a', native: { replyTo: 'g1' } }]);
  assert.deepEqual([...group.get('g1')], ['a', 'b']);
  const name = (id: string) => ({ a: '团子', b: '栗子', c: '年糕' } as Any)[id] || '';
  assert.equal(R.seenWords(['a'], name), '团子看到了');
  assert.equal(R.seenWords(['a', 'b'], name), '团子、栗子看到了');
  assert.equal(R.seenWords(['a', 'b', 'c'], name), '团子、栗子等 3 只猫猫看到了');
  assert.equal(R.seenWords(['zz'], name), '猫猫看到了');
});

// ------------------------------------------------- the leading signature
test('a reply that opens with its own cat\'s signature never shows it while written: the live rule is the server\'s, applied to every prefix', () => {
  const L = liveRules();
  const shown = (content: string, name = '快手') => messageDisplayText({ id: 'm', type: 'assistant', catId: 'c', timestamp: 1, content } as Any, 't', name);
  // The finished words: exactly what the server shows for the settled row.
  const samples = ['[快手/Haiku🐾]  今天精力满满，准备好接棒！🚀', '[快手🐾] 7', '[快手/Haiku 🐾] 好的\n\n[快手/Haiku 🐾]', '[快手/Haiku🐾]\n\n7',
    '[快手/Haiku🐾]  \n \n    const a = 1;\n    const b = 2;', '[墨点/gpt🐾] 是墨点的署名', '[墨点/gpt🐾]\n\n7', '看这个 [快手/Haiku🐾] 格式', '[快手] 没有猫爪', '[快手/Haiku🐾]'];
  for (const s of samples) assert.equal(L.display(s, '快手'), shown(s), s);
  // Every prefix of a stream that opens with the signature: no piece of it ever shows.
  const reply = '[快手/Haiku🐾]  今天精力满满。\n\n[快手/Haiku🐾]';
  for (const at of Array.from(reply).keys()) {
    const prefix = Array.from(reply).slice(0, at + 1).join('');
    assert.doesNotMatch(L.display(prefix, '快手'), /\[|🐾|Haiku/, JSON.stringify(prefix));
  }
  // The same over a line break, as the real replies do it.
  for (const prefix of ['[', '[快', '[快手/Hai', '[快手/Haiku🐾', '[快手/Haiku🐾]', '[快手/Haiku🐾]\n', '[快手/Haiku🐾]\n\n']) assert.equal(L.display(prefix, '快手'), '', JSON.stringify(prefix));
  assert.equal(L.display('[快手/Haiku🐾]\n\n7', '快手'), '7');
  // Another cat's signature, or no name known: kept, as the server keeps it.
  assert.equal(L.display('[墨点/gpt🐾] 是它的署名', '快手'), '[墨点/gpt🐾] 是它的署名');
  assert.equal(L.display('[快手/Haiku🐾]  今天', ''), '[快手/Haiku🐾]  今天');
  assert.equal(L.leading('[快手/Haiku🐾]  今天', '快手'), '今天');
});

// ---------------------------------------------------------------- the page
type Opts = { reduce?: boolean; dark?: boolean; group?: boolean };
function page(opts: Opts = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '', id = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; };
  const chip = h('button', 'top-title', 'head-chip'), title = h('span', 'title', 'title'), subtitle = h('span', 'subtitle', 'subtitle');
  subtitle.hidden = true;
  chip.append(title, subtitle);
  const chat = h('div', 'chat'), thread = h('div', 'thread', 'thread'), dock = h('div', 'dock'), roster = h('nav', 'list', 'roster');
  chat.append(thread, dock);
  doc.body.append(chip, chat, roster);
  Object.assign(thread, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
  let now = 1_000_000, seq = 0;
  const timers = new Map<number, { fn: () => void; at: number; every?: number }>();
  let frames: Array<() => void> = [];
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
    }
    now = end;
  };
  const frame = () => { const list = frames; frames = []; list.forEach(fn => fn()); };
  const window: Any = { matchMedia: () => ({ matches: !!opts.reduce }), requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; } };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: Any[]) { super(...((args.length ? args : [now]) as [number])); }
    static override now() { return now; }
  }
  const context = vm.createContext({
    window, document: doc, console, Promise, Date: FakeDate,
    setTimeout: (fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
  });
  for (const f of ['chat-experience-rules.js', 'chat-live-rules.js', 'chat-live.js', 'chat-presence-rules.js', 'chat-presence.js']) vm.runInContext(read('client/public/' + f), context);
  const names: Record<string, string> = { a: '团子', b: '栗子' };
  const state: Any = {
    sel: opts.group ? { type: 'group', id: 'g' } : { type: 'bot', id: '团子' },
    bots: [{ name: '团子', native_id: 'a', accent: PAIRS['maine-coon'] }, { name: '栗子', native_id: 'b' }],
    status: { bots: {}, groups: {} },
  };
  const key = () => (state.sel ? (state.sel.type === 'group' ? 'group:' : 'bot:') + state.sel.id : '');
  const live = window.ClowderLive;
  live.init({
    thread,
    render: (parent: El, words: string) => { for (const line of words.split('\n').filter(Boolean)) { const p = h('p'); p.textContent = line; parent.append(p); } },
    row: (catId: string, time: string) => {
      const row = h('div', 'msg bot live' + (catId ? ' with-face' : ' cont'));
      row.dataset.time = time;
      if (catId) row.dataset.sender = 'bot:cat:' + catId;
      row.append(h('div', 'body'));
      return row;
    },
    queued: () => false, busy: () => false, unread: () => '', changed: () => {}, gap: () => {},
    catName: (id: string) => names[id] || '',
  });
  window.ClowderPresence.init({
    thread, live, chip, catName: (id: string) => names[id] || '',
    bots: () => state.bots, selected: () => state.sel, status: () => state.status,
    surfaces: () => (opts.dark ? DARK : LIGHT),
  });
  const presence = window.ClowderPresence;
  live.select(key());
  // A history as the renderers draw it: owner rows (bubble column) and cat rows.
  const userRow = (mid: string, words: string) => { const r = h('div', 'msg user'); r.dataset.mid = mid; r.dataset.sender = 'user'; const col = h('div', 'bubble-col'); const b = h('div', 'bubble'); b.textContent = words; col.append(b); r.append(col); return r; };
  const catRow = (mid: string, cat: string, words: string) => { const r = h('div', 'msg bot with-face'); r.dataset.mid = mid; r.dataset.sender = 'bot:cat:' + cat; const body = h('div', 'body'); body.append(words); r.append(body); return r; };
  const inner = (...rows: El[]) => { const i = h('div', 'thread-inner' + (opts.group ? ' grpchat' : '')); i.dataset.chat = key(); i.append(...rows); return i; };
  // What renderMessages does: commit, then the paw.
  const draw = (rows: El[], messages: Any[]) => { const shown = live.commit(inner(...rows), []); presence.rendered(messages); return shown; };
  const onScreen = () => thread.children[0];
  const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
  const ev = (kind: string, more: Record<string, unknown> = {}) => live.event({ kind, messageId: 'm1', catId: 'a', ...more });
  // A sidebar row as app.js's listButton draws it.
  const sideRow = (attr: 'bot' | 'group', id: string, line: El) => {
    const btn = h('button', 'item'); btn.dataset[attr] = id;
    const body = h('span', 'item-body'); const nl = h('span', 'name-line'); nl.append(h('span', 'name'));
    body.append(nl, line); btn.append(h('span', 'avatar'), body); roster.append(btn); return btn;
  };
  return { doc, h, chip, thread, roster, live, presence, state, draw, onScreen, userRow, catRow, settle, ev, sideRow, advance, frame, key };
}
const sub = (p: Any) => p.chip.find('pz-sub')[0];
const own = (m: Any) => ({ role: 'user', id: m, native_message_id: m });
const answer = (id: string, to: string, cat = 'a', more: Any = {}) => ({ role: 'assistant', id, native_message_id: id, native_cat_id: cat, native: { replyTo: to }, ...more });

test('the header says 正在输入… / 在想… / 在查资料… under the name from chat-live.js\'s own replies, and nothing for a send no reply has started or another chat', async () => {
  const p = page();
  p.draw([p.userRow('u0', '你好')], [own('u0')]);
  await p.settle();
  assert.equal(p.chip.classList.contains('pz-on'), false);
  // The send's typing bubble alone is not the engine writing.
  const reply = p.live.expect('a');
  reply.accept('u1');
  await p.settle();
  assert.equal(p.chip.classList.contains('pz-on'), false, 'not before the engine starts the reply');
  p.ev('start');
  await p.settle();
  assert.equal(p.chip.classList.contains('pz-on'), true);
  assert.equal(text(sub(p)), '正在输入…');
  assert.equal(sub(p).getAttribute('aria-hidden'), 'true', 'the reply\'s own quiet line is the announced one');
  p.ev('thinking');
  await p.settle();
  assert.equal(text(sub(p)), '在想…');
  p.ev('step', { tool: 'Read', target: '说明.md' });
  await p.settle();
  assert.equal(text(sub(p)), '在查资料…');
  p.ev('step', { tool: 'Bash' });
  await p.settle();
  assert.equal(text(sub(p)), '在运行命令…');
  p.ev('text', { text: '好的', end: 2 });
  await p.settle();
  assert.equal(text(sub(p)), '正在输入…');
  p.ev('done');
  await p.settle();
  assert.equal(p.chip.classList.contains('pz-on'), false, 'back to the normal header when done');
  assert.equal(text(sub(p)), '正在输入…', 'the last words stay while the line fades out');
  // Another chat on screen, or the two-cat exchange (no selection): nothing.
  const q = page();
  q.draw([], []);
  q.ev('start');
  await q.settle();
  assert.equal(q.chip.classList.contains('pz-on'), true);
  q.state.sel = null;
  q.presence.refresh();
  assert.equal(q.chip.classList.contains('pz-on'), false);
});

test('a group\'s header says who is writing', async () => {
  const p = page({ group: true });
  p.draw([], []);
  p.live.event({ kind: 'start', messageId: 'm1', catId: 'a' });
  p.live.event({ kind: 'thinking', messageId: 'm1', catId: 'a' });
  await p.settle();
  assert.equal(text(sub(p)), '团子在想…');
  p.live.event({ kind: 'start', messageId: 'm2', catId: 'b' });
  await p.settle();
  assert.equal(text(sub(p)), '团子、栗子正在输入…');
});

test('the sidebar: typing dots for a running row from the status poll, the live words on the open chat\'s row (given back after), never over what needs the owner', async () => {
  const p = page();
  p.draw([], []);
  const spinLine = (words: string) => { const l = p.h('span', 'preview st run'); l.append(p.h('svg', 'st-spin'), (() => { const s = p.h('span'); s.textContent = words; return s; })()); return l; };
  const plainLine = (words: string) => { const l = p.h('span', 'preview'); l.textContent = words; return l; };
  const mine = p.sideRow('bot', '团子', plainLine('你：你好'));
  const other = p.sideRow('bot', '栗子', spinLine('在处理'));
  const waiting = p.sideRow('group', 'g2', (() => { const l = p.h('span', 'preview st wait'); l.textContent = '等你确认'; return l; })());
  p.state.status = { bots: { 栗子: { state: 'running' }, 团子: { state: 'idle' } }, groups: { g2: { state: 'awaiting' } } };
  p.presence.rows(p.roster);
  // Another chat, running by the status: its spinner became the typing dots, its words stay.
  const line = other.find('preview')[0];
  assert.equal(line.find('st-spin').length, 0);
  assert.equal(line.find('pz-dots').length, 1);
  assert.equal(line.find('pz-dots')[0].children.length, 3);
  assert.match(text(line), /在处理$/);
  assert.equal(text(mine.find('preview')[0]), '你：你好');
  // The open chat's cat starts writing: its row says so at once, before the next poll.
  const was = mine.find('preview')[0];
  p.ev('start');
  p.ev('step', { tool: 'WebSearch' });
  await p.settle();
  const typing = mine.find('preview')[0];
  assert.ok(typing.classList.contains('pz-typing'));
  assert.equal(typing.find('pz-dots').length, 1);
  assert.match(text(typing), /在查资料…$/);
  // The shell repaints the row's line (a new status): it is covered again right after.
  typing.replaceWith(plainLine('新的状态'));
  p.presence.rows(p.roster);
  assert.ok(mine.find('preview')[0].classList.contains('pz-typing'));
  // Done: the line it covers comes back.
  const second = mine.find('preview')[0];
  p.ev('done');
  await p.settle();
  assert.notEqual(mine.find('preview')[0], second);
  assert.equal(text(mine.find('preview')[0]), '新的状态');
  assert.notEqual(mine.find('preview')[0], was, 'the repainted line, not the stale one');
  // 等你确认 is never covered, even in the open chat while it writes.
  p.state.sel = { type: 'group', id: 'g2' };
  p.live.select('group:g2');
  p.draw([], []);
  p.live.event({ kind: 'start', messageId: 'm5', catId: 'a' });
  await p.settle();
  assert.equal(text(waiting.find('preview')[0]), '等你确认');
});

test('seen: the paw goes by the owner\'s latest message a reply answers, stamped once when it first appears, never on the first drawing, never for a waiting message, and it never makes a row draw again', () => {
  const p = page();
  // First drawing: u1 answered, u2 waiting in the queue.
  const first = [own('u1'), answer('r1', 'u1'), own('u2')];
  p.draw([p.userRow('u1', '一'), p.catRow('r1', 'a', '好'), p.userRow('u2', '二')], first);
  const rowOf = (mid: string) => p.onScreen().children.find((r: El) => r.dataset.mid === mid)!;
  const pawOf = (mid: string) => rowOf(mid).find('pz-seen')[0];
  assert.ok(pawOf('u1'), 'the latest picked up');
  assert.equal(pawOf('u2'), undefined, 'none while it waits');
  assert.equal(pawOf('u1').classList.contains('pz-stamp'), false, 'what was already seen when the chat opened is not stamped');
  assert.equal(pawOf('u1').getAttribute('aria-label'), '团子看到了');
  assert.equal(pawOf('u1').dataset.cat, 'a', 'tinted by the cat that saw it (chat-presence-rules.js decides if it is legible)');
  const u1 = rowOf('u1');
  // The engine starts on u2: the paw moves there, stamped this once; u1 keeps its element.
  const next = [...first, answer('r2', 'u2', 'a', { in_progress: true })];
  const result = p.draw([p.userRow('u1', '一'), p.catRow('r1', 'a', '好'), p.userRow('u2', '二'), p.catRow('r2', 'a', '')], next);
  assert.equal(result.added, 1);
  assert.equal(rowOf('u1'), u1, 'the paw never changes a row\'s identity: no redraw, no rise');
  assert.equal(pawOf('u1'), undefined);
  const stamp = pawOf('u2');
  assert.ok(stamp.classList.contains('pz-stamp'));
  p.advance(700);
  assert.equal(stamp.classList.contains('pz-stamp'), false);
  // The same drawing again: the same paw element, not stamped again.
  p.draw([p.userRow('u1', '一'), p.catRow('r1', 'a', '好'), p.userRow('u2', '二'), p.catRow('r2', 'a', '')], next);
  assert.equal(pawOf('u2'), stamp);
  // u2 drawn anew (its words changed): a new row gets the paw quietly.
  p.draw([p.userRow('u1', '一'), p.catRow('r1', 'a', '好'), p.userRow('u2', '二（改）'), p.catRow('r2', 'a', '')], next);
  assert.ok(rowOf('u2').classList.contains('lv-still'));
  assert.equal(pawOf('u2').classList.contains('pz-stamp'), false);
  // A refusal said by name is not an answer.
  const q = page();
  q.draw([q.userRow('u9', '@年糕 在吗')], [own('u9'), answer('n9', 'u9', 'a', { notice: true })]);
  assert.equal(q.onScreen().find('pz-seen').length, 0);
});

test('seen with reduced motion is never stamped; in a group the paw names every cat that picked the message up and takes no single colour', () => {
  const p = page({ reduce: true });
  p.draw([p.userRow('u1', '一')], [own('u1')]);
  p.draw([p.userRow('u1', '一'), p.catRow('r1', 'a', '')], [own('u1'), answer('r1', 'u1', 'a', { in_progress: true })]);
  assert.equal(p.onScreen().find('pz-seen')[0].classList.contains('pz-stamp'), false);
  const g = page({ group: true });
  const person = (id: string) => ({ kind: 'person', id });
  const said = (id: string, cat: string) => ({ kind: 'bot', id, native_cat_id: cat, native: { replyTo: 'g1' } });
  g.draw([g.userRow('g1', '大家好')], [person('g1'), said('x', 'a')]);
  assert.equal(g.onScreen().find('pz-seen')[0].dataset.cat, 'a');
  g.draw([g.userRow('g1', '大家好')], [person('g1'), said('x', 'a'), said('y', 'b')]);
  const paw = g.onScreen().find('pz-seen')[0];
  assert.equal(paw.getAttribute('aria-label'), '团子、栗子看到了');
  assert.equal(paw.dataset.cat, undefined);
  assert.equal(g.onScreen().find('pz-seen').length, 1);
});

test('the colours live in one style element that follows the cat list and the theme\'s surfaces', () => {
  const p = page();
  p.presence.rows(p.roster);
  const sheet = p.doc.getElementById('pz-accents')!;
  assert.match(text(sheet), /data-sender="bot:cat:a"\] \{ --pz-paw: #5b8c5a; --pz-paw-strength: 1; \}/);
  assert.doesNotMatch(text(sheet), /cat:b/, 'a cat without a pair: no rule');
  p.state.bots = [{ name: '团子', native_id: 'a' }];
  p.presence.rows(p.roster);
  assert.equal(text(sheet), '', 'a pair taken away: the theme\'s colours again');
  assert.equal(p.doc.querySelectorAll('#pz-accents').length, 1);
});

// ---------------------------------------------------------------- app.js
test('group chats get the same day and time separators as single chats (app.js\'s own addTimeDividers)', () => {
  const app = read('client/public/app.js');
  const take = (name: string) => {
    const m = new RegExp(`\\n {2}function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
    assert.ok(m, name + ' is where the shell keeps it');
    return m![0];
  };
  const doc = new Doc();
  const el = (tag: string, cls: string, words?: string) => { const n = doc.createElement(tag); n.className = cls; if (words) n.textContent = words; return n; };
  const out: Any = {};
  vm.runInNewContext(['clockTime', 'timeDivider', 'addTimeDividers'].map(take).join('') + 'out.addTimeDividers = addTimeDividers;', { out, el, Date, Number });
  const inner = el('div', 'thread-inner grpchat');
  const at = (days: number, h: number, m: number) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const row = (time: string) => { const r = el('div', 'msg bot'); r.dataset.time = time; return r; };
  inner.append(row(at(1, 10, 0)), row(at(1, 10, 3)), row(at(0, 9, 0)));
  out.addTimeDividers(inner);
  assert.deepEqual(inner.children.map((n: El) => (n.classList.contains('tdiv') ? text(n) : 'msg')), ['昨天 10:00', 'msg', 'msg', '今天 09:00', 'msg']);
});

test('the shell wires 活起来 with thin hooks: scripts before app.js, styles just before chat-live.css, the sidebar, the paw after each keyed commit, group separators, the live speaker\'s name', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/chat-presence.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('chat-live.js') < at('chat-presence-rules.js') && at('chat-presence-rules.js') < at('chat-presence.js') && at('chat-presence.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(styles.slice(-2), ['chat-presence.css', 'chat-live.css']);
  const sort = /\n {2}function sortStatusRows\(\) \{\n([\s\S]*?)\n {2}\}\n/.exec(app)![1];
  assert.match(sort, /chatList\.paint\(\$\("roster"\)\);\n\s+presence\.rows\(\$\("roster"\)\);/);
  assert.equal((app.match(/cards\.rendered\(\);[^\n]*\n\s+presence\.rendered\(messages\);/g) || []).length, 2, 'both histories, right after the cards are filled');
  assert.doesNotMatch(app, /contains\("grpchat"\)\) return;/, 'time separators no longer skip group chats');
  assert.match(app, /addTimeDividers\(inner\); \/\/ [^\n]*\n\s+chatHistory\.top\(inner\); \/\/ 更早的消息 at the top \(chat-history\.js\)\n\s+\/\/ Rows that did not change keep their element: only new rows rise in\.\n\s+const shown = live\.commit\(inner, sendFeedback\(inner, messages\)\);/);
  assert.match(app, /live\.init\(\{\n[^\n]*\n\s+catName: catNameOf,/);
  assert.match(app, /presence\.init\(\{\n\s+thread, live, chip: \$\("head-chip"\), catName: catNameOf,/);
  // chat-list.js marks the row rising over the others; the style is here.
  assert.match(read('client/public/chat-list.js'), /r\.classList\.toggle\("cl-rise", dy > 0\);/);
  assert.match(css, /\.item\.cl-moving\.cl-rise \{ position: relative; z-index: 1; \}/);
  // No colour or font of its own; motion only on the existing tokens.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\("data:[^"]*"\)/g, '');
  assert.doesNotMatch(bare, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|font-family/i);
  for (const m of bare.matchAll(/(\d+)ms/g)) assert.ok(['120', '160', '180', '320', '1200'].includes(m[1]), 'duration ' + m[1]);
  assert.match(bare, /var\(--dur-pop\) var\(--ease-spring\)/);
  // The paws are drawn at full strength in a cat's colour, so the checked ratio is the one on screen.
  assert.match(bare, /opacity: var\(--pz-paw-strength, \.72\)/);
  assert.match(bare, /@keyframes pz-knead \{\n\s+0%, 60%, 100% \{ transform: none; \}\n\s+30% \{ transform: [^;]+; \}\n\}/, 'only transform moves');
  // Everyday words only, in both scripts.
  const strings = ['chat-presence.js', 'chat-presence-rules.js'].flatMap(f => [...read('client/public/' + f).replace(/^\s*\/\/.*$/gm, '').matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1])).filter(s => /\p{Script=Han}/u.test(s));
  assert.ok(strings.length > 10);
  for (const s of strings) assert.doesNotMatch(s, /Bot|Agent|会话|原生|线程|session/i, s);
});
