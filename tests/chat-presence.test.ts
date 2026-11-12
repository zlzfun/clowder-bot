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
  // 在查资料… only for tools known to read or search (and Codex's web search).
  for (const tool of ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'web_search', 'LS', 'NotebookRead']) assert.equal(say(one('step', tool)), '在查资料…', tool);
  // A browser or a memory tool proves no lookup (review 2026-11-12, finding 4).
  for (const tool of ['mcp__playwright__browser_click', 'mcp__chrome__navigate']) assert.equal(say(one('step', tool)), '在用浏览器…', tool);
  for (const tool of ['mcp__memory__store', 'mcp__memory__recall', 'mcp__custom__do_thing']) assert.equal(say(one('step', tool)), '在处理…', tool);
  assert.equal(say(one('step', 'mcp__search__query')), '在查找…');
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
  // A reply nobody named (no cat) says nothing; nor does one whose stream was lost since (unsure).
  assert.equal(say({ replies: [{ catId: '', phase: 'text' }] }), '');
  assert.equal(say({ replies: [{ catId: 'a', phase: 'step', tool: 'Read', unsure: true }] }), '', 'no claim after the stream was lost');
  assert.equal(say({ replies: [{ catId: 'a', phase: 'step', tool: 'Read', unsure: true }, { catId: 'b', phase: 'thinking' }] }, true), '栗子在想…', 'only the confirmed one');
  // What the polite region says: with the cat's name in a single chat, 排队中 for a send waiting in line.
  const spoken = (now: Any, group = false) => R.spokenLine({ replies: [], waiting: [], ...now }, (id: string) => ({ a: '团子', b: '栗子' } as Any)[id] || '', group, L.verb);
  assert.equal(spoken(one('thinking')), '团子在想…');
  assert.equal(spoken(one('thinking'), true), '团子在想…');
  assert.equal(spoken({ ...one('text'), stopping: true }), '正在停止…');
  assert.equal(spoken({ waiting: [{ queued: true }] }), '排队中');
  assert.equal(spoken({ waiting: [{ queued: false }] }), '');
  assert.equal(spoken({ replies: [{ catId: 'a', phase: 'text', unsure: true }] }), '');
});

test('a sidebar row: live words for the open chat; typing dots elsewhere only while that chat\'s own activity was read running and the poll did not fail; never over what needs the owner', () => {
  const R = rules();
  assert.equal(R.rowShows('idle', '正在输入…', false), 'live');
  assert.equal(R.rowShows('running', '在想…', false), 'live');
  assert.equal(R.rowShows('running', '', true), 'status');
  // The cat is busy (its overall state), but not in this chat: no dots (review finding 3).
  assert.equal(R.rowShows('running', '', false), '');
  assert.equal(R.rowShows('idle', '', false), '');
  for (const kind of ['awaiting', 'failure', 'unknown']) assert.equal(R.rowShows(kind, '正在输入…', true), '', kind);
  const busy = { readStatus: 'ready', active: [{ catId: 'a', invocationId: 'i' }] };
  assert.equal(R.ownActive({ state: 'running', activity: busy }, false), true);
  assert.equal(R.ownActive({ state: 'running', activity: busy }, true), false, 'the last poll failed: not vouched for');
  assert.equal(R.ownActive({ state: 'running', activity: { ...busy, active: [] } }, false), false, 'busy in another chat only');
  assert.equal(R.ownActive({ state: 'running', activity: { ...busy, readStatus: 'partial' } }, false), false, 'this chat could not be read whole');
  assert.equal(R.ownActive({ state: 'running', activity: { readStatus: 'unavailable', active: [], items: [] } }, false), false);
  assert.equal(R.ownActive({ state: 'running' }, false), false);
  assert.equal(R.ownActive(null, false), false);
});

test('seen: only a cat\'s reply that began and names the owner\'s message (native.replyTo) marks it; system records, refusals and replies that failed before starting do not; the paw goes by the latest one picked up', () => {
  const R = rules();
  const user = (id: string) => ({ role: 'user', id, native_message_id: id, native: { id, type: 'user' } });
  const reply = (id: string, to: string, native: Any = {}, more: Any = {}) => ({ role: 'assistant', id, native_message_id: id, native_cat_id: native.catId ?? 'a',
    native: { id, type: 'assistant', catId: 'a', replyTo: to, content: '好的', lifecycle: { kind: 'response', status: 'completed' }, ...native }, ...more });
  // u1 answered (settled), u2 being answered (in progress, no words yet), u3 still waiting in the queue.
  const rows = [user('u1'), reply('r1', 'u1'), user('u2'), reply('r2', 'u2', { content: '', lifecycle: { status: 'processing' } }, { in_progress: true }), user('u3')];
  const seen = R.picked(rows);
  assert.deepEqual([...seen.keys()], ['u1', 'u2']);
  assert.deepEqual(JSON.parse(JSON.stringify(R.seenMark(['u1', 'u2', 'u3'], seen))), { id: 'u2', cats: ['a'] }, 'the latest picked up; the waiting one has none');
  assert.equal(R.seenMark(['u3'], seen), null);
  // Not a cat picking it up (review 2026-11-12, finding 1): a system or delivery record with
  // replyTo (projected as an assistant row), a refusal or reminder line (notice), a record
  // without a cat, and replies that failed, stopped or were interrupted before producing anything.
  const none = R.picked([user('u4'),
    reply('d1', 'u4', { type: 'system', catId: null, content: '云端投递失败' }, { native_cat_id: '' }),
    reply('d2', 'u4', { type: 'connector', catId: null, content: '提醒：该喝水了' }, { notice: true, reminder: true }),
    reply('n1', 'u4', { content: '团子不在这个群里，没有回答。' }, { notice: true }),
    reply('x1', 'u4', { catId: '' }, { native_cat_id: '' }),
    reply('f1', 'u4', { content: '', lifecycle: { status: 'failed', reason: 'spawn failed' } }, { ended: { how: 'failed' } }),
    reply('s1', 'u4', { content: '', lifecycle: { status: 'canceled' } }, { ended: { how: 'stopped' } }),
    reply('i1', 'u4', { content: '  ', lifecycle: { status: 'interrupted' } }),
    reply('q1', 'u4', { content: '', lifecycle: { status: 'queued' } }, { in_progress: true }),
    reply('r9', 'gone'), { role: 'user', id: 'u5', native: { type: 'user', replyTo: 'u4' } }]);
  assert.equal(none.size, 0, JSON.stringify([...none]));
  // Evidence it began: words (even if it later failed), a draft, files, cards, tool steps of its own, or a normal finish.
  for (const [native, more, why] of [
    [{ content: '我先看一下…', lifecycle: { status: 'failed' } }, {}, 'failed after writing'],
    [{ content: '', isDraft: true, lifecycle: undefined }, { in_progress: true }, 'a draft'],
    [{ content: '' }, { attachments: [{ id: 'f' }] }, 'files'],
    [{ content: '' }, { blocks: [{ kind: 'checklist' }] }, 'cards'],
    [{ content: '', toolEvents: [{ type: 'tool_use' }], lifecycle: { status: 'canceled' } }, { presentation_kind: 'activity' }, 'tool steps, then stopped'],
    [{ content: '' }, {}, 'finished normally (an empty reply)'],
  ] as Array<[Any, Any, string]>) assert.equal(R.picked([user('u6'), reply('e1', 'u6', native, more)]).size, 1, why);
  // Group rows (kind person / bot, id is the native ID); two cats answering one message.
  const said = (id: string, cat: string) => ({ kind: 'bot', id, native_cat_id: cat, native: { type: 'assistant', catId: cat, replyTo: 'g1', content: '好', lifecycle: { status: 'completed' } } });
  const group = R.picked([{ kind: 'person', id: 'g1' }, said('x', 'a'), said('y', 'b'), said('z', 'a')]);
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
// What a browser has and the small DOM does not, for the paths that need it:
// copying an element (the exit fades), animating it, placing it after
// another, and layout boxes (only where a test sets them).
const proto = El.prototype as Any;
proto.cloneNode = function cloneNode(this: Any, deep: boolean) {
  const c: Any = this.doc.createElement(this.tagName);
  for (const [k, v] of this.attrs) c.attrs.set(k, v);
  c.hidden = this.hidden;
  if (deep) for (const k of this.kids) c.append(k instanceof El ? (k as Any).cloneNode(true) : this.doc.createTextNode(k.textContent));
  return c;
};
proto.animate = function animate(this: Any) { this.animations = (this.animations || 0) + 1; return { finished: new Promise(() => {}) }; };
proto.after = function after(this: Any, n: Any) { const p = this.parent; const at = p.kids.indexOf(this); n.remove(); n.parent = p; p.kids.splice(at + 1, 0, n); };
proto.getBoundingClientRect = function rect(this: Any) { return this.box || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; };
const box = (left: number, width: number) => ({ left, right: left + width, width, top: 0, bottom: 20, height: 20 });

// The café tokens a computed style would give, by theme.
const TOKENS: Record<string, Record<string, string>> = {
  light: { '--x-card': LIGHT.chat, '--x-bot-bubble': LIGHT.bubble, '--dur-pop-close': '120ms' },
  dark: { '--x-card': DARK.chat, '--x-bot-bubble': DARK.bubble, '--dur-pop-close': '120ms' },
};
type Opts = { reduce?: boolean; dark?: boolean; group?: boolean; theme?: boolean };
function page(opts: Opts = {}) {
  const doc = new Doc();
  (doc as Any).documentElement = doc.root;
  doc.root.setAttribute('data-theme', opts.dark ? 'dark' : 'light');
  const h = (tag: string, cls = '', id = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; };
  const bar = h('div', 'top-inner');
  const chip = h('button', 'top-title', 'head-chip'), title = h('span', 'title', 'title'), subtitle = h('span', 'subtitle', 'subtitle');
  subtitle.hidden = true;
  chip.append(title, subtitle);
  const more = h('button', 'icon-btn ch-more');
  bar.append(chip, more);
  const chat = h('div', 'chat'), thread = h('div', 'thread', 'thread'), dock = h('div', 'dock'), roster = h('nav', 'list', 'roster');
  chat.append(thread, dock);
  // The search palette (a dialog card) and the drawer's scrim, for the exit fades.
  const pal = h('div', 'pal'), card = h('div', 'pal-card'), input = h('input', 'pal-input');
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.append(input); pal.append(card); pal.hidden = true;
  const scrim = h('div', 'panel-scrim', 'panel-scrim'); scrim.hidden = true;
  doc.body.append(bar, chat, roster, pal, scrim);
  Object.assign(thread, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
  let now = new Date(2026, 10, 11, 23, 58).getTime(), seq = 0;
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
  // MutationObserver: the test says when an attribute changed (fire).
  const observers: Array<{ target: Any; cb: (r: Any[]) => void }> = [];
  class FakeObserver { constructor(private cb: (r: Any[]) => void) {} observe(target: Any) { observers.push({ target, cb: this.cb }); } }
  const fire = (target: Any, oldValue: string | null) => { for (const o of observers) if (o.target === target) o.cb([{ oldValue }]); };
  const window: Any = {
    matchMedia: () => ({ matches: !!opts.reduce }),
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
    MutationObserver: FakeObserver,
    getComputedStyle: (n: Any) => ({ getPropertyValue: (k: string) => (TOKENS[n.getAttribute('data-theme') || 'light'] || {})[k] || '' }),
    addEventListener: (type: string, fn: () => void) => { if (type === 'resize') window.onResize = fn; },
  };
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
    status: { bots: {}, groups: {} }, stale: false, redraws: 0,
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
    stale: () => state.stale, redraw: () => { state.redraws++; },
    // The real tokens through getComputedStyle when the test is about the theme.
    ...(opts.theme ? {} : { surfaces: () => (opts.dark ? DARK : LIGHT) }),
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
  // The polite region chat-presence.js says things in.
  const region = () => doc.body.children.find((n: El) => n.getAttribute('role') === 'status' && n.getAttribute('aria-live') === 'polite') || null;
  return { doc, h, bar, chip, more, thread, roster, pal, scrim, live, presence, state, draw, onScreen, userRow, catRow, settle, ev, sideRow, advance, frame, key, fire, window, region, clock: () => now };
}
const sub = (p: Any) => p.chip.find('pz-sub')[0];
const own = (m: Any) => ({ role: 'user', id: m, native_message_id: m });
// A cat's reply row as the transcript gives it: the engine's assistant record under native.
const answer = (id: string, to: string, cat = 'a', more: Any = {}, native: Any = {}) => ({ role: 'assistant', id, native_message_id: id, native_cat_id: cat,
  native: { type: 'assistant', catId: cat, replyTo: to, content: more.in_progress ? '' : '好', lifecycle: { status: more.in_progress ? 'processing' : 'completed' }, ...native }, ...more });

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
  assert.equal(sub(p).getAttribute('aria-hidden'), 'true', 'the visual line; the polite region says it');
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

test('accessibility follows the real states: the resting paws are named as waiting, the started ones as writing, and one polite region says each change once, never per streamed piece', async () => {
  const p = page();
  p.draw([p.userRow('u0', '你好')], [own('u0')]);
  const reply = p.live.expect('a');
  reply.accept('u1');
  p.frame();
  await p.settle();
  const bubble = p.onScreen().children.at(-1)!;
  const paws = () => bubble.find('typing-dots')[0];
  assert.equal(paws().getAttribute('aria-label'), '等猫猫开始回复', 'before the engine starts: waiting, not typing');
  assert.equal(text(p.region()), '', 'nothing said before the engine starts');
  p.ev('start');
  p.frame();
  await p.settle();
  assert.equal(paws().getAttribute('aria-label'), '正在输入');
  assert.equal(text(p.region()), '团子正在输入…', 'the start is said, with the cat\'s name');
  p.ev('step', { tool: 'Read', target: '说明.md' });
  p.frame();
  await p.settle();
  assert.equal(text(p.region()), '团子在查资料…');
  p.ev('text', { text: '好', end: 1 });
  p.frame();
  await p.settle();
  const said = p.region()!.kids[0];
  for (const [i, piece] of ['的', '，我', '看看'].entries()) { p.ev('text', { text: piece, end: [2, 4, 6][i] }); p.frame(); await p.settle(); }
  assert.equal(text(p.region()), '团子正在输入…');
  assert.equal(p.region()!.kids[0], said, 'streamed words say nothing new: the same announcement node');
  // The reply's own quiet line is no second live region.
  assert.equal(bubble.find('lv-step')[0].getAttribute('aria-live'), null);
  assert.equal(p.doc.body.querySelectorAll('[aria-live="polite"]').length, 1);
});

test('after the stream is lost the header claims nothing until the reply is confirmed again; a read confirms only that it is in progress, and a recovered draft drops the old step', async () => {
  const p = page();
  p.draw([], []);
  p.ev('start');
  p.ev('step', { tool: 'Read', target: '说明.md' });
  p.frame();
  await p.settle();
  assert.equal(text(sub(p)), '在查资料…');
  const row = p.onScreen().children.at(-1)!;
  // The connection drops (a reconnect, a resync): no claim about what it is doing.
  p.live.lost();
  p.frame();
  await p.settle();
  assert.equal(p.chip.classList.contains('pz-on'), false, 'not 在查资料… indefinitely');
  assert.ok(row.classList.contains('lv-unsure'), 'the paws rest (chat-presence.css)');
  p.advance(300); // the quiet line's cross-fade
  assert.equal(text(row.find('lv-step')[0]), '', 'the quiet line drops 在看 说明.md too');
  assert.equal(row.find('typing-dots')[0].getAttribute('aria-label'), '正在回复');
  // Reads keep failing (none arrive): still nothing, however long.
  p.advance(60_000);
  await p.settle();
  assert.equal(p.chip.classList.contains('pz-on'), false);
  // A read shows it still in progress with the same draft: in progress is confirmed, the step is not.
  p.live.read([{ id: 'm1', catId: 'a', inProgress: true, draft: '' }], p.clock());
  p.live.attach(); // as loadThread does after each read
  p.frame();
  await p.settle();
  assert.equal(text(sub(p)), '正在输入…', 'neutral: started, not 在查资料…');
  assert.equal(row.classList.contains('lv-unsure'), false);
  // The stream keeps failing (a retry, another loss) with no event in between: what the read
  // showed stands, so the line does not come and go with each retry.
  p.live.lost();
  await p.settle();
  assert.equal(text(sub(p)), '正在输入…');
  assert.equal(p.chip.classList.contains('pz-on'), true);
  // Its own next event is fresh evidence again.
  p.ev('step', { tool: 'Grep' });
  await p.settle();
  assert.equal(text(sub(p)), '在查资料…');
  // Lost again, then a read whose draft has words the stream never showed: writing words, the old step gone.
  p.live.lost();
  p.live.read([{ id: 'm1', catId: 'a', inProgress: true, draft: '我查到了' }], p.clock());
  p.live.attach();
  p.frame();
  await p.settle();
  assert.equal(text(sub(p)), '正在输入…');
  assert.equal(p.live.presence().replies[0].phase, 'text');
  // The rule itself: a draft that adds words always drops an older step.
  const L = liveRules(), r = L.reply('m', 'c', true);
  L.apply(r, { kind: 'step', tool: 'Read' });
  assert.equal(L.draft(r, '新的字'), true);
  assert.deepEqual([r.phase, r.step], ['text', null]);
  assert.equal(L.recover(r), false, 'nothing to drop');
  L.apply(r, { kind: 'thinking' });
  assert.equal(L.recover(r), true);
  assert.equal(r.phase, 'start');
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

test('the header line runs only as far as the header\'s free width: up to the ⋯ button, not under it or off a narrow screen', async () => {
  const p = page({ group: true });
  // 390px: the bar from 16 to 374, a short group title centred, ⋯ at the right.
  p.bar.box = box(16, 358);
  p.chip.box = box(140, 110);
  p.more.box = box(342, 32);
  p.draw([], []);
  // The line is placed 40px into the chip (after the face).
  p.presence.refresh();
  sub(p).box = box(180, 0);
  p.live.event({ kind: 'start', messageId: 'm1', catId: 'a' });
  p.live.event({ kind: 'start', messageId: 'm2', catId: 'b' });
  await p.settle();
  assert.equal(text(sub(p)), '团子、栗子正在输入…');
  assert.equal(sub(p).style.maxWidth, (342 - 8 - 180) + 'px', 'stops 8px before ⋯');
  // No ⋯ (no search panel): up to the bar's own edge; a resize measures again.
  p.more.box = box(0, 0);
  p.window.onResize();
  assert.equal(sub(p).style.maxWidth, (374 - 8 - 180) + 'px');
});

test('the sidebar: typing dots only for a row whose own chat was read running in a poll that succeeded; the live words on the open chat\'s row (given back after); never over what needs the owner', async () => {
  const p = page();
  p.draw([], []);
  const spinLine = (words: string) => { const l = p.h('span', 'preview st run'); l.append(p.h('svg', 'st-spin'), (() => { const s = p.h('span'); s.textContent = words; return s; })()); return l; };
  const plainLine = (words: string) => { const l = p.h('span', 'preview'); l.textContent = words; return l; };
  const busyHere = { threadId: 't', readStatus: 'ready', items: [], counts: { approval: 0, failure: 0, running: 1, queued: 0, task: 0 }, active: [{ catId: 'b', invocationId: 'i' }], queued: [], errors: [] };
  const idleHere = { ...busyHere, counts: { ...busyHere.counts, running: 0 }, active: [] };
  const mine = p.sideRow('bot', '团子', plainLine('你：你好'));
  const other = p.sideRow('bot', '栗子', spinLine('在处理'));
  const elsewhere = p.sideRow('bot', '年糕', spinLine('在处理'));
  const waiting = p.sideRow('group', 'g2', (() => { const l = p.h('span', 'preview st wait'); l.textContent = '等你确认'; return l; })());
  // 栗子 works in its own chat; 年糕 is "running" only because it works in a group (its single chat is idle).
  p.state.status = { bots: { 栗子: { state: 'running', activity: busyHere }, 年糕: { state: 'running', activity: idleHere }, 团子: { state: 'idle' } }, groups: { g2: { state: 'awaiting' } } };
  p.presence.rows(p.roster);
  const line = other.find('preview')[0];
  const spin = (row: El) => row.find('st-spin')[0];
  assert.equal(line.find('st-spin').length, 0);
  assert.equal(line.find('pz-dots').length, 1);
  assert.equal(line.find('pz-dots')[0].children.length, 3);
  assert.match(text(line), /在处理$/);
  assert.ok(spin(elsewhere), 'busy only in another chat: no typing dots on this one (review finding 3)');
  assert.equal(elsewhere.find('pz-dots').length, 0);
  // Its own chat could not be read whole: no dots either.
  p.state.status.bots.栗子 = { state: 'running', activity: { ...busyHere, readStatus: 'partial' } };
  p.presence.rows(p.roster);
  assert.equal(other.find('pz-dots').length, 0);
  assert.ok(spin(other), 'the spinner it stood in for is back');
  // Busy again, then the whole status read fails: the dots go, the list's own line stays.
  p.state.status.bots.栗子 = { state: 'running', activity: busyHere };
  p.presence.rows(p.roster);
  assert.equal(other.find('pz-dots').length, 1);
  p.state.stale = true;
  p.presence.rows(p.roster);
  assert.equal(other.find('pz-dots').length, 0, 'a failed poll vouches for nothing');
  p.state.stale = false;
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
  assert.equal(pawOf('u1').tabIndex, 0, 'a stable focus target for who saw it (review finding 9)');
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
  // A refusal said by name, a delivery failure (a system record), or a reply that failed before
  // producing anything is no pickup: nothing says 看到了 (review finding 1).
  for (const rows of [[answer('n9', 'u9', 'a', { notice: true })], [answer('s9', 'u9', '', { native_cat_id: '' }, { type: 'system', catId: null, content: '云端投递失败' })],
    [answer('f9', 'u9', 'a', { ended: { how: 'failed' } }, { content: '', lifecycle: { status: 'failed' } })]]) {
    const q = page();
    q.draw([q.userRow('u9', '@年糕 在吗')], [own('u9'), ...rows]);
    assert.equal(q.onScreen().find('pz-seen').length, 0, JSON.stringify(rows[0].native));
  }
});

test('seen with reduced motion is never stamped; in a group the paw names every cat that picked the message up and takes no single colour', () => {
  const p = page({ reduce: true });
  p.draw([p.userRow('u1', '一')], [own('u1')]);
  p.draw([p.userRow('u1', '一'), p.catRow('r1', 'a', '')], [own('u1'), answer('r1', 'u1', 'a', { in_progress: true })]);
  assert.equal(p.onScreen().find('pz-seen')[0].classList.contains('pz-stamp'), false);
  const g = page({ group: true });
  const person = (id: string) => ({ kind: 'person', id });
  const said = (id: string, cat: string) => ({ kind: 'bot', id, native_cat_id: cat, native: { type: 'assistant', catId: cat, replyTo: 'g1', content: '好', lifecycle: { status: 'completed' } } });
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

test('the colours follow a theme switched at runtime: the theme\'s own tokens are read again and the rules re-decided', () => {
  const p = page({ theme: true });
  p.state.bots = [{ name: '团子', native_id: 'a', accent: PAIRS['golden-chinchilla'] }];
  p.presence.rows(p.roster);
  const sheet = p.doc.getElementById('pz-accents')!;
  assert.equal(text(sheet), '', 'gold on cream: nothing legible, the theme\'s colours');
  // The owner switches to dark (applyTheme sets data-theme): the observer re-reads the surfaces.
  p.doc.root.setAttribute('data-theme', 'dark');
  p.fire(p.doc.root, 'light');
  assert.match(text(sheet), /\.who > span:first-child \{ color: #c8a951; \}/);
  assert.match(text(sheet), /--pz-paw: #c8a951/);
  p.doc.root.setAttribute('data-theme', 'light');
  p.fire(p.doc.root, 'dark');
  assert.equal(text(sheet), '');
});

test('the day separators are drawn again when the calendar day changes, through the status poll, once', () => {
  const p = page();
  p.draw([p.userRow('u1', '晚安')], [own('u1')]);
  p.presence.rows(p.roster);
  assert.equal(p.state.redraws, 0);
  p.advance(60_000); // 23:58 → 23:59
  p.presence.rows(p.roster);
  assert.equal(p.state.redraws, 0, 'the same day');
  p.advance(3 * 60_000); // past midnight
  p.presence.rows(p.roster);
  assert.equal(p.state.redraws, 1, '今天 and 昨天 are out of date: the history is drawn again');
  p.presence.rows(p.roster);
  assert.equal(p.state.redraws, 1, 'once per day change');
});

test('a closing palette or scrim leaves a fading copy that is no dialog (the palette can open again at once, which removes the copy); none with reduced motion', () => {
  const p = page();
  p.pal.hidden = false;
  p.pal.find('pal-input')[0].value = '团';
  p.pal.hidden = true;
  p.fire(p.pal, null);
  const copy = p.doc.body.children.find((n: El) => n.classList.contains('pz-ghost'))!;
  assert.ok(copy, 'a copy fades where the palette was');
  assert.equal(p.pal.hidden, true, 'the palette itself is hidden at once');
  assert.equal(copy.getAttribute('aria-hidden'), 'true');
  assert.equal(copy.inert, true);
  assert.equal(copy.querySelectorAll('[aria-modal]').length + copy.querySelectorAll('[role="dialog"]').length, 0, 'no modal semantics: no guard takes it for an open dialog (review finding 8)');
  assert.equal(copy.find('pal-input')[0].value, '团', 'the typed words fade with it');
  assert.ok(copy.animations >= 1 && copy.find('pal-card')[0].animations >= 1);
  // Open again during the fade: the copy goes at once.
  p.pal.hidden = false;
  p.fire(p.pal, '');
  assert.equal(p.doc.body.children.some((n: El) => n.classList.contains('pz-ghost')), false);
  // The scrim too; with reduced motion nothing is copied.
  p.scrim.hidden = false; p.scrim.hidden = true; p.fire(p.scrim, null);
  assert.equal(p.doc.body.children.filter((n: El) => n.classList.contains('pz-ghost')).length, 1);
  const q = page({ reduce: true });
  q.pal.hidden = true;
  q.fire(q.pal, null);
  assert.equal(q.doc.body.children.some((n: El) => n.classList.contains('pz-ghost')), false);
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
  // The rows that take part in the dividers are one list both divider functions read (item 36: notices too).
  const rows = /\n {2}const TIMED_ROWS = [^\n]*\n/.exec(app);
  assert.ok(rows, 'app.js names the rows that take part in the dividers');
  vm.runInNewContext(['clockTime', 'timeDivider'].map(take).join('') + rows![0] + take('laterTime') + take('addTimeDividers') + 'out.addTimeDividers = addTimeDividers;', { out, el, Date, Number, Array });
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
