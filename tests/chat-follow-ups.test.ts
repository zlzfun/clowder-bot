import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El, text } from './fake-dom.js';
import { messageDisplayText } from '../server/native/message-presentation.js';
import type { NativeMessage } from '../server/native/types.js';

// Talking to a cat while it is writing (docs/xbot-frontend.md item 38). The
// engine lets the running reply take the new message in; the reply row then
// carries `follows` (docs/chat-live-api.md 「会话行」) and the chat draws it
// under that message (chat-live-rules.js order()), live and settled, without
// rebuilding or re-animating rows (chat-live.js's keyed commit). While the
// reply streams, the cat's own signature that the engine leaves between the
// two parts is held back as the server does for finished replies.
//
// The rules run in a bare VM. The drawing runs app.js's own grouping and
// time-divider functions with the real chat-live.js and chat-live-rules.js on
// tests/fake-dom.ts, the way renderMessages / renderGroup use them (static
// checks below tie that to app.js). Layout is modelled only where a test needs
// positions: a row's top is its place in the history times 40px.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const app = read('client/public/app.js');
const take = (name: string) => {
  const m = new RegExp(`\\n {2}function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
  assert.ok(m, name + ' is where the shell keeps it');
  return m![0];
};
const line = (re: RegExp) => { const m = re.exec(app); assert.ok(m, String(re)); return m![0]; };

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-live-rules.js'), { window });
  return window.ClowderLiveRules;
}

// ------------------------------------------------------------------ the rule
const user = (seq: number, id = 'u' + seq, more: Any = {}) => ({ seq, id, native_message_id: id, role: 'user', content: '问' + seq, ...more });
const reply = (seq: number, id = 'a' + seq, more: Any = {}) => ({ seq, id, native_message_id: id, role: 'assistant', content: '答' + seq, ...more });
const ids = (L: Any, rows: Any[], group = false) => plain(L.order(rows, group).map((i: number) => rows[i].id));

test('a reply is drawn under the follow-ups it took in, by follows only: the seq in a single chat, the id in a group, when that row is loaded, the owner\'s and after the reply', () => {
  const L = rules();
  // Two questions, one answer: the reply began first, so the engine lists it first.
  const one = [user(1), reply(2, 'a2', { follows: 3 }), user(3), user(5), reply(6)];
  assert.deepEqual(ids(L, one), ['u1', 'u3', 'a2', 'u5', 'a6']);
  // Several follow-ups: follows is the last, the reply goes under it.
  assert.deepEqual(ids(L, [user(1), reply(2, 'a2', { follows: 4, in_progress: true }), user(3), user(4), user(5, 'u5')]), ['u1', 'u3', 'u4', 'a2', 'u5']);
  // Its delivery receipt (not drawn) stays where it was; nothing else moves.
  const receipt = { seq: 3, role: 'tool', tool_call_id: 'delivery_a2' };
  assert.deepEqual(plain(L.order([user(1), reply(2, 'a2', { follows: 4 }), receipt, user(4)], false)), [0, 2, 3, 1]);
  // In a group, by message id; several cats each with their own.
  const group = [
    { id: 'p1', kind: 'person', text: '@宪宪 @砚砚 各看一眼' },
    { id: 'x1', kind: 'bot', text: '宪宪', follows: 'p3', in_progress: true },
    { id: 'y1', kind: 'bot', text: '砚砚', follows: 'p2' },
    { id: 'p2', kind: 'person', text: '@砚砚 还有导出' },
    { id: 'p3', kind: 'person', text: '@宪宪 还有颜色' },
    { id: 'z1', kind: 'bot', text: '烁烁' },
  ];
  assert.deepEqual(ids(L, group, true), ['p1', 'p2', 'y1', 'p3', 'x1', 'z1']);
  // Two replies under the same message keep their order.
  assert.deepEqual(ids(L, [{ id: 'p1', kind: 'person' }, { id: 'x', kind: 'bot', follows: 'p2' }, { id: 'y', kind: 'bot', follows: 'p2' }, { id: 'p2', kind: 'person' }], true), ['p1', 'p2', 'x', 'y']);
  // Nothing is guessed: no follows (the preview's append off, or a follow-up said before the reply's record existed), a message not
  // loaded (on another page), one before the reply, one that is not the owner's, a seq where an id is meant, malformed values.
  const stays = (rows: Any[], group = false) => assert.deepEqual(plain(L.order(rows, group)), rows.map((_: Any, i: number) => i), JSON.stringify(rows.map((r: Any) => r.follows ?? null)));
  stays([user(1), reply(2), user(3), reply(4)]);
  stays([user(1), reply(2, 'a2', { follows: 9 }), user(3)]);
  stays([user(1), user(2), reply(3, 'a3', { follows: 1 })]);
  stays([user(1), reply(2, 'a2', { follows: 3 }), reply(3)]);
  stays([{ id: 'p1', kind: 'person' }, { id: 'x', kind: 'bot', follows: 2 }, { id: 'p2', kind: 'person', seq: 2 }], true);
  for (const bad of [0, -3, 1.5, '', 'x', null, {}, [3], true]) stays([user(1), reply(2, 'a2', { follows: bad }), user(3)]);
  // A seq written as a string still names that row (the server sends a number).
  assert.deepEqual(ids(L, [user(1), reply(2, 'a2', { follows: '3' }), user(3)]), ['u1', 'u3', 'a2']);
  assert.deepEqual(plain(L.order(null)), []);
});

// ------------------------------------------------------------ the drawing
type Opts = { reduce?: boolean };
function page(opts: Opts = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '', id = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; };
  const chat = h('div', 'chat'), thread = h('div', 'thread', 'thread');
  chat.append(thread);
  doc.body.append(chat);
  Object.assign(thread, { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400 });
  let frames: Array<() => void> = [];
  const window: Any = { matchMedia: () => ({ matches: !!opts.reduce }), requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; } };
  const el = (tag: string, cls: string, words?: string) => { const n = h(tag, cls); if (words) n.textContent = words; return n; };
  // The page's clock (chat-live.js spaces out the drawings of a long reply by how long the last one took): it moves only when a frame is run.
  let now = Date.now();
  class FakeDate extends Date { static override now() { return now; } }
  const context = vm.createContext({ window, document: doc, console, Date: FakeDate, Number, Array, Math, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, el, out: {} as Any });
  for (const f of ['chat-live-rules.js', 'chat-live.js']) vm.runInContext(read('client/public/' + f), context);
  vm.runInContext(line(/\n {2}const GROUP_GAP_MS = [^\n]*\n/) + take('groupStart') + ['clockTime', 'timeDivider'].map(take).join('') + line(/\n {2}const TIMED_ROWS = [^\n]*\n/)
    + ['laterTime', 'addTimeDivider', 'addTimeDividers'].map(take).join('')
    + 'out.groupStart = groupStart; out.timeDivider = timeDivider; out.addTimeDivider = addTimeDivider; out.addTimeDividers = addTimeDividers;', context);
  const live = window.ClowderLive, L = window.ClowderLiveRules, out = context.out;
  const glides: Array<{ id: string; from: string }> = [], cancels: string[] = [];
  // Layout, for the glide: a row's top is its place among its siblings (40px each), as seen from the scroll box, moved by
  // the glide running on it. A glide is caught halfway (until cancelled): the row is seen half its distance from its place.
  (El.prototype as Any).getBoundingClientRect = function (this: El) { const p = this.parent; const i = p ? p.kids.indexOf(this) : 0; const top = i * 40 + (this._ty || 0); return { top, bottom: top + 40, height: 40 }; };
  (El.prototype as Any).animate = function (this: El, frames: Any[]) {
    const id = this.dataset.mid || this.className;
    glides.push({ id, from: frames[0].transform });
    this._ty = Number(/translateY\((-?\d+)px\)/.exec(frames[0].transform)![1]) / 2;
    return { cancel: () => { this._ty = 0; cancels.push(id); }, onfinish: null };
  };
  live.init({
    thread, render: (parent: El, words: string) => parent.append(words),
    row: (catId: string, time: string) => { const r = h('div', 'msg bot live with-face'); r.dataset.time = time; r.dataset.sender = 'bot:cat:' + catId; r.append(h('div', 'body')); return r; },
    queued: () => false, busy: () => false, unread: () => '', changed: () => {}, gap: () => {}, catName: (id: string) => ({ c: '宪宪', d: '砚砚' } as Any)[id] || '',
  });
  const who = (m: Any, group: boolean) => ((group ? m.kind === 'person' : m.role === 'user') ? 'user' : 'bot:cat:' + m.native_cat_id);
  // A row as the renderers draw it: its identity, its time, its speaker; a group's first row carries the name line.
  const row = (m: Any, key: string, cont: boolean, group: boolean) => {
    const live = !!m.in_progress && key !== 'user';
    const r = h('div', 'msg ' + (key === 'user' ? 'user' : 'bot') + (live ? ' live' : ''));
    r.dataset.mid = m.id; if (!group && m.seq) r.dataset.seq = String(m.seq); r.dataset.time = m.time; r.dataset.sender = key;
    if (cont) r.classList.add('cont');
    const body = h('div', 'body');
    if (!cont && key !== 'user') body.append(el('div', 'who', m.native_cat_id));
    if (!live) body.append(el('div', 'bubble', m.content ?? m.text));
    r.append(body);
    return r;
  };
  // renderMessages / renderGroup in miniature: in drawing order, grouped against the row drawn above, then the dividers and the keyed commit.
  const draw = (messages: Any[], { group = false, keep = [] as El[] } = {}) => {
    live.read(messages.filter((m) => (group ? m.kind === 'bot' : m.role === 'assistant')).map((m) => ({ id: m.id, catId: m.native_cat_id, inProgress: !!m.in_progress, draft: m.draft ?? '', replyTo: '' })));
    const inner = h('div', 'thread-inner');
    inner.dataset.chat = group ? 'group:g' : 'bot:宪宪';
    let lastKey = '', lastMsg: Any = null;
    for (const i of L.order(messages, group)) {
      const m = messages[i];
      if (m.role === 'tool') continue;
      const key = who(m, group);
      const cont = !out.groupStart(lastMsg, m, lastKey, key);
      const r = row(m, key, cont, group);
      inner.append(m.in_progress && key !== 'user' ? live.frame(r) : r);
      lastKey = key; lastMsg = m;
    }
    out.addTimeDividers(inner);
    const shown = live.commit(inner, keep);
    live.rendered(shown);
    return { shown, inner: thread.children[0] as El };
  };
  const seq = () => (thread.children[0] as El).children.map((n: El) => (n.classList.contains('tdiv') ? '[' + text(n) + ']' : n.dataset.mid || n.className));
  const rowOf = (id: string) => (thread.children[0] as El).children.find((n: El) => n.dataset.mid === id)!;
  return { doc, h, el, live, L, out, thread, draw, seq, rowOf, glides, cancels, select: (key: string) => live.select(key), flush: () => { now += 1000; const list = frames; frames = []; list.forEach((fn) => fn()); } };
}

const at = (daysAgo: number, hour: number, minute = 0, second = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, minute, second, 0); return d.toISOString(); };
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const t0 = at(0, 10, 0);

test('live: the follow-up slips in above the reply that keeps writing — its element, words and caret stay, nothing rises again or is rebuilt; settled, the finished reply takes the live one\'s place under it', () => {
  const p = page();
  p.select('bot:宪宪');
  const u1 = { ...user(1), time: t0 }, writing = { ...reply(2), native_cat_id: 'c', time: plus(t0, 2000), in_progress: true, draft: '一。' };
  p.draw([u1, writing]);
  p.live.event({ kind: 'text', messageId: 'a2', catId: 'c', text: '\n\n二', end: 5 });
  p.flush();
  const frame = p.rowOf('a2'), bubble = frame.find('lv-text')[0]!, first = p.rowOf('u1');
  assert.equal(text(bubble), '一。\n\n二');
  assert.ok(bubble.classList.contains('lv-writing'), 'the caret: still being written');
  // The owner sends while it writes: their bubble (held by the page, its receipt named the message) shows at the end.
  const sending = p.h('div', 'msg user optimistic');
  sending.dataset.mid = 'u3'; sending.dataset.time = plus(t0, 9000); sending.textContent = '还有一件';
  p.draw([u1, writing], { keep: [sending] });
  assert.deepEqual(p.seq(), ['[' + p.out.timeDivider(undefined, t0) + ']', 'u1', 'a2', 'u3']);
  // The next read: the engine let the same reply take it in. The message is above the reply now; the reply is the same element.
  const asked = { ...user(3), time: plus(t0, 9000) };
  const taken = { ...writing, follows: 3 };
  const moves = [first, frame].map((n) => n.moves);
  const result = p.draw([u1, taken, asked]);
  assert.deepEqual(p.seq().slice(1), ['u1', 'u3', 'a2']);
  assert.equal(p.rowOf('a2'), frame, 'the reply being written keeps its element');
  assert.equal(frame.find('lv-text')[0], bubble, '…its bubble and words');
  assert.deepEqual([first, frame].map((n) => n.moves), moves, 'neither the first message nor the reply moved');
  const slipped = p.rowOf('u3');
  assert.ok(slipped.classList.contains('lv-still'), 'the message took its sent bubble\'s place: it does not rise again');
  assert.equal(result.shown.added, 0, 'nothing new arrived (回到最新 stays quiet)');
  // It keeps writing there.
  p.live.event({ kind: 'text', messageId: 'a2', catId: 'c', text: '三', end: 6 });
  p.flush();
  assert.equal(text(frame.find('lv-text')[0]), '一。\n\n二三');
  // Another read with nothing new changes nothing on screen.
  const still = (p.thread.children[0] as El).children.slice();
  p.draw([u1, taken, asked]);
  assert.deepEqual((p.thread.children[0] as El).children, still);
  // Settled: the finished row takes the live one's place, under the follow-up, without rising; the others keep their elements.
  p.live.event({ kind: 'done', messageId: 'a2', catId: 'c' });
  p.draw([u1, { ...taken, in_progress: false, content: '一。二三' }, asked]);
  assert.deepEqual(p.seq().slice(1), ['u1', 'u3', 'a2']);
  assert.notEqual(p.rowOf('a2'), frame);
  assert.ok(p.rowOf('a2').classList.contains('lv-still'));
  assert.equal(p.rowOf('u3'), slipped);
  assert.equal(p.rowOf('u1'), first);
});

test('a follows that comes a moment after its message (accepted after pending) moves the reply under it: the message moves up without rising, the reply stays put', () => {
  const p = page();
  p.select('bot:宪宪');
  const u1 = { ...user(1), time: t0 }, writing = { ...reply(2), native_cat_id: 'c', time: plus(t0, 2000), in_progress: true, draft: '一。' };
  // (said six minutes on, so it starts a group of its own wherever it stands and keeps its element)
  const asked = { ...user(3), time: plus(t0, 6 * 60_000) };
  p.draw([u1, writing, asked]);
  const frame = p.rowOf('a2'), message = p.rowOf('u3'), moves = frame.moves;
  assert.deepEqual(p.seq().slice(1), ['u1', 'a2', 'u3'], 'not accepted yet: where the engine lists it');
  p.draw([u1, { ...writing, follows: 3 }, asked]);
  assert.deepEqual(p.seq().slice(1), ['u1', 'u3', 'a2']);
  assert.equal(p.rowOf('u3'), message, 'the same message element, moved');
  assert.ok(message.classList.contains('lv-still'), 'a moved row does not rise (or land) again');
  assert.equal(frame.moves, moves, 'the reply being written did not move');
  // They glide from where they were: the message up by the reply's height, the reply down by the message's.
  assert.deepEqual(p.glides, [{ id: 'u3', from: 'translateY(40px)' }, { id: 'a2', from: 'translateY(-40px)' }]);
});

test('only rows that changed places glide; with reduced motion none does; a growing reply, a settled one or earlier pages brought in on top never glide', () => {
  const p = page();
  p.select('bot:宪宪');
  const u1 = { ...user(1), time: t0 }, writing = { ...reply(2), native_cat_id: 'c', time: plus(t0, 2000), in_progress: true, draft: '一。' };
  p.draw([u1, writing]);
  p.draw([{ ...user(0, 'u0'), time: plus(t0, -60_000) }, u1, writing]);
  p.draw([{ ...user(0, 'u0'), time: plus(t0, -60_000) }, u1, { ...writing, in_progress: false, content: '一。' }]);
  assert.deepEqual(p.glides, []);
  const r = page({ reduce: true });
  r.select('bot:宪宪');
  const asked = { ...user(3), time: plus(t0, 9000) };
  r.draw([u1, writing, asked]);
  r.draw([u1, { ...writing, follows: 3 }, asked]);
  assert.deepEqual(r.seq().slice(1), ['u1', 'u3', 'a2']);
  assert.deepEqual(r.glides, [], 'reduced motion: they just take their places');
  assert.ok(r.rowOf('u3').classList.contains('lv-still'));
});

test('time dividers follow the drawing: a reply that began before the follow-up opens none and does not move the time back, even across midnight; grouping is decided in the order drawn', () => {
  const p = page();
  p.select('bot:宪宪');
  // It began at 23:58 yesterday and took in what was said at 00:01; the next message comes at 00:10.
  const began = at(1, 23, 58), after = at(0, 0, 1), next = at(0, 0, 10);
  const label = (iso: string) => '[' + p.out.timeDivider(undefined, iso) + ']';
  p.draw([{ ...user(1), time: plus(began, -30_000) }, { ...reply(2), native_cat_id: 'c', time: began, follows: 3 }, { ...user(3), time: after }, { ...user(4), time: next }]);
  assert.deepEqual(p.seq(), [label(plus(began, -30_000)), 'u1', label(after), 'u3', 'a2', 'u4'], 'no 昨天 23:58 under 今天 00:01, no second 今天 divider after it');
  // An owner's message appended live measures against the latest time on screen, not the earlier reply drawn last.
  const inner = p.thread.children[0] as El;
  const sending = p.h('div', 'msg user optimistic');
  sending.dataset.time = plus(next, 60_000);
  p.out.addTimeDivider(inner, sending);
  assert.equal(inner.children.filter((n: El) => n.classList.contains('tdiv')).length, 2, 'no divider for a send a minute after the last message');
  // Grouping: the reply under two of the owner's messages starts its own group; the owner's two messages are one group.
  const q = page();
  q.select('bot:宪宪');
  q.draw([{ ...user(1), time: t0 }, { ...reply(2), native_cat_id: 'c', time: plus(t0, 1000), follows: 3 }, { ...user(3), time: plus(t0, 5000) }, { ...reply(4), native_cat_id: 'c', time: plus(t0, 90_000) }]);
  const rows = (q.thread.children[0] as El).children.filter((n: El) => n.classList.contains('msg'));
  assert.deepEqual(rows.map((n: El) => [n.dataset.mid, n.classList.contains('cont')]), [['u1', false], ['u3', true], ['a2', false], ['a4', true]]);
  assert.equal(q.rowOf('a2').find('who').length, 1, 'the reply under the follow-up carries the cat\'s name line');
});

test('a group with several cats writing at once: each reply goes under its own follow-up and keeps writing in its own element', () => {
  const p = page();
  p.select('group:g');
  const said = (id: string, sec: number, words: string) => ({ id, kind: 'person', text: words, time: plus(t0, sec * 1000) });
  const cat = (id: string, catId: string, sec: number, more: Any = {}) => ({ id, kind: 'bot', native_cat_id: catId, text: '', time: plus(t0, sec * 1000), in_progress: true, draft: '在写', ...more });
  p.draw([said('p1', 0, '@宪宪 @砚砚 各看一眼'), cat('x', 'c', 1), cat('y', 'd', 2)], { group: true });
  const x = p.rowOf('x'), y = p.rowOf('y'), bubbles = [x, y].map((n) => n.find('lv-text')[0]);
  p.draw([said('p1', 0, '@宪宪 @砚砚 各看一眼'), cat('x', 'c', 1), cat('y', 'd', 2, { follows: 'p2' }), said('p2', 9, '@砚砚 还有导出')], { group: true });
  assert.deepEqual(p.seq().slice(1), ['p1', 'x', 'p2', 'y']);
  assert.equal(p.rowOf('x'), x); assert.equal(p.rowOf('y'), y);
  p.draw([said('p1', 0, '@宪宪 @砚砚 各看一眼'), cat('x', 'c', 1, { follows: 'p3' }), cat('y', 'd', 2, { follows: 'p2' }), said('p2', 9, '@砚砚 还有导出'), said('p3', 12, '@宪宪 还有颜色')], { group: true });
  assert.deepEqual(p.seq().slice(1), ['p1', 'p2', 'y', 'p3', 'x']);
  // The fewest rows move: 宪宪's reply stays put while 砚砚's and the message it answers go above it, without rising again.
  assert.equal(p.rowOf('x'), x); assert.equal(p.rowOf('y'), y);
  assert.deepEqual([x, y].map((n) => n.find('lv-text')[0]), bubbles, 'each keeps writing in its own bubble');
  assert.ok(y.classList.contains('lv-still') && p.rowOf('p2').classList.contains('lv-still'), 'moved rows do not rise again');
  // Each still carries its cat's name line (each follows one of the owner's messages).
  assert.deepEqual([x, y].map((n) => n.classList.contains('cont')), [false, false]);
});

test('a row that changes places keeps the keyboard: a message focused (as a search hit leaves it) and a control inside a moving reply are focused again, without scrolling (review item 3)', () => {
  const p = page();
  p.select('group:g');
  const said = (id: string, sec: number, words: string) => ({ id, kind: 'person', text: words, time: plus(t0, sec * 1000) });
  const cat = (id: string, catId: string, sec: number, more: Any = {}) => ({ id, kind: 'bot', native_cat_id: catId, text: '', time: plus(t0, sec * 1000), in_progress: true, draft: '在写', ...more });
  const rows = (yFollows: boolean) => [said('p1', 0, '@宪宪 @砚砚 各看一眼'), cat('x', 'c', 1), cat('y', 'd', 2, yFollows ? { follows: 'p2' } : {}), said('p2', 9, '@砚砚 还有导出')];
  p.draw(rows(false), { group: true });
  // The message the owner jumped to has focus; then 砚砚's reply takes it in and the message moves above it.
  const message = p.rowOf('p2');
  let how: Any = null;
  const focus = message.focus.bind(message);
  message.focus = (opts?: Any) => { how = opts; focus(); };
  message.focus();
  p.draw(rows(true), { group: true });
  assert.deepEqual(p.seq().slice(1), ['p1', 'x', 'p2', 'y']);
  assert.equal(message.moves > 0, true, 'it was moved');
  assert.equal(p.doc.activeElement, message, 'and still has focus');
  assert.deepEqual(plain(how), { preventScroll: true });
  // A control inside a reply that moves (here 砚砚's, moving back above the message when its follows goes) keeps focus too.
  const y = p.rowOf('y'), control = p.h('button', 'ck-link');
  y.find('body')[0]!.append(control);
  control.focus();
  p.draw(rows(false), { group: true });
  assert.deepEqual(p.seq().slice(1), ['p1', 'x', 'y', 'p2']);
  assert.equal(p.rowOf('y'), y);
  assert.equal(p.doc.activeElement, control);
  // Focus outside the history is never taken.
  const outside = p.h('input', 'composer');
  p.doc.body.append(outside);
  outside.focus();
  p.draw(rows(true), { group: true });
  assert.equal(p.doc.activeElement, outside);
  // The usual single chat: the follow-up, said a few seconds after the first message, moves above the reply and now continues
  // that message, so its row is drawn anew rather than moved: focus goes to the row that took its place.
  const q = page();
  q.select('bot:宪宪');
  const u1 = { ...user(1), time: t0 }, writing = { ...reply(2), native_cat_id: 'c', time: plus(t0, 2000), in_progress: true, draft: '一。' };
  const asked = { ...user(3), time: plus(t0, 9000) };
  q.draw([u1, writing, asked]);
  const before = q.rowOf('u3');
  before.focus();
  q.draw([u1, { ...writing, follows: 3 }, asked]);
  const after = q.rowOf('u3');
  assert.notEqual(after, before, 'drawn anew (it continues the first message now)');
  assert.ok(after.classList.contains('cont'));
  assert.equal(q.doc.activeElement, after, 'focus is on the row that took its place');
  assert.equal(after.tabIndex, -1);
});

test('a second reorder while a glide runs starts from where the row is seen: the running glide is cancelled first and the new one has no jump (review item 5)', () => {
  const p = page();
  p.select('group:g');
  const said = (id: string, sec: number) => ({ id, kind: 'person', text: '问' + id, time: plus(t0, sec * 1000) });
  const cat = (id: string, catId: string, sec: number, more: Any = {}) => ({ id, kind: 'bot', native_cat_id: catId, text: '', time: plus(t0, sec * 1000), in_progress: true, draft: '在写', ...more });
  p.draw([said('p1', 0), cat('x', 'c', 1), cat('y', 'd', 2), said('p2', 9)], { group: true });
  p.draw([said('p1', 0), cat('x', 'c', 1), cat('y', 'd', 2, { follows: 'p2' }), said('p2', 9)], { group: true });
  assert.deepEqual(p.seq().slice(1), ['p1', 'x', 'p2', 'y']);
  assert.deepEqual(p.glides, [{ id: 'p2', from: 'translateY(40px)' }, { id: 'y', from: 'translateY(-40px)' }]);
  // Halfway through, 宪宪's reply takes the same message in: p2 is seen 20px below its place and moves again.
  const message = p.rowOf('p2'), seenAt = message.getBoundingClientRect().top;
  p.draw([said('p1', 0), cat('x', 'c', 1, { follows: 'p2' }), cat('y', 'd', 2, { follows: 'p2' }), said('p2', 9)], { group: true });
  assert.deepEqual(p.seq().slice(1), ['p1', 'p2', 'x', 'y']);
  assert.deepEqual(p.cancels, ['p2'], 'the running glide was cancelled before measuring where it lands');
  // (right under the owner's first message it is drawn as a continuation: a row of its own replaces the one seen)
  const now = p.rowOf('p2');
  assert.notEqual(now, message);
  const placed = now.parent!.kids.indexOf(now) * 40;
  const second = p.glides.slice(2);
  assert.deepEqual(second.find((g) => g.id === 'p2'), { id: 'p2', from: 'translateY(' + (seenAt - placed) + 'px)' }, 'it starts exactly where it was seen');
  assert.equal(seenAt - placed, 60);
  assert.deepEqual(second.find((g) => g.id === 'x'), { id: 'x', from: 'translateY(-40px)' });
});

test('the read position: rows drawn below a message although they came before it in the engine\'s order are named, the owner\'s own aside', () => {
  const L = rules();
  const group = [
    { id: 'p1', kind: 'person' }, { id: 'A', kind: 'bot', follows: 'p2' }, { id: 'B', kind: 'bot' }, { id: 'p2', kind: 'person' },
  ];
  const drawn = { messages: group, order: L.order(group, true), group: true };
  assert.deepEqual(plain(drawn.order.map((i: number) => group[i]!.id)), ['p1', 'B', 'p2', 'A']);
  assert.deepEqual(plain(L.displaced(drawn, 'B')), ['A'], 'reading B (the newest) covers A, which is drawn below it');
  assert.deepEqual(plain(L.displaced(drawn, 'A')), []);
  assert.deepEqual(plain(L.displaced(drawn, 'p2')), ['A']);
  assert.deepEqual(plain(L.displaced(drawn, 'gone')), []);
  assert.deepEqual(plain(L.displaced(null, 'B')), []);
  // Single chats by native message ID; nothing moved, nothing named.
  const single = [user(1), reply(2, 'a2', { follows: 3 }), reply(3, 'a3'), user(4, 'u3', { seq: 3 })];
  single[3] = { ...user(3), id: 'u3', native_message_id: 'u3' };
  const one = { messages: single, order: L.order(single, false), group: false };
  assert.deepEqual(plain(L.displaced(one, 'a3')), ['a2']);
  const plainRows = [user(1), reply(2), user(3), reply(4)];
  assert.deepEqual(plain(L.displaced({ messages: plainRows, order: L.order(plainRows, false), group: false }, 'a4')), []);
});

test('a follow-up on a page loaded later: the reply moves under it once both are on screen, and the rows above are earlier history that does not rise', () => {
  const p = page();
  p.select('bot:宪宪');
  // The latest page alone: the reply's follows names a message that is not loaded yet in this drawing (a page boundary in between).
  const latest = [{ ...reply(10), native_cat_id: 'c', time: plus(t0, 10_000), follows: 11 }, { ...user(12), time: plus(t0, 30_000) }];
  p.draw(latest);
  assert.deepEqual(p.seq().slice(1), ['a10', 'u12'], 'not loaded: it stays where it is');
  // Loaded together (chat-history.js merges the pages): placed.
  p.draw([{ ...user(9), time: t0 }, latest[0], { ...user(11), time: plus(t0, 20_000) }, latest[1]]);
  assert.deepEqual(p.seq().slice(1), ['u9', 'u11', 'a10', 'u12']);
});

test('the paw goes by the latest of the owner\'s messages the cats picked up, a follow-up the running reply took in and read included', () => {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-presence-rules.js'), { window });
  const R = window.ClowderPresenceRules;
  const owner = (id: string, refs: Any[] = []) => ({ id, native_message_id: id, role: 'user', native: { id, type: 'user', lifecycle: { kind: 'input', dispatchRefs: refs } } });
  const answer = (id: string, inputs: string[], more: Any = {}) => ({ id, native_message_id: id, role: 'assistant', native: { id, type: 'assistant', catId: 'c', replyTo: inputs[0], content: '写', lifecycle: { kind: 'response', status: 'processing', inputMessageIds: inputs }, ...more } });
  const readRef = (by: string, more: Any = {}) => ({ targetId: 'c', phase: 'settled', statusMessageId: by, inputRead: { status: 'read' }, appendAcceptance: 'accepted', ...more });
  const shown = ['u1', 'u2', 'u3'];
  // Taken in and read: the follow-up has the paw (the reply is drawn under it).
  assert.deepEqual(plain(R.seenMark(shown, R.picked([owner('u1'), answer('a1', ['u1', 'u2']), owner('u2', [readRef('a1')])]))), { id: 'u2', cats: ['c'] });
  // Taken in but not read yet, read by another reply, read by another cat, or listed without a record: still the first.
  for (const refs of [[{ ...readRef('a1'), inputRead: { status: 'pending' } }], [readRef('a9')], [readRef('a1', { targetId: 'other' })], []]) {
    assert.deepEqual(plain(R.seenMark(shown, R.picked([owner('u1'), answer('a1', ['u1', 'u2']), owner('u2', refs)]))), { id: 'u1', cats: ['c'] }, JSON.stringify(refs));
  }
  // A reply that has not begun proves nothing, follow-ups included.
  assert.equal(R.seenMark(shown, R.picked([owner('u1'), answer('a1', ['u1', 'u2'], { content: '', lifecycle: { status: 'failed', inputMessageIds: ['u1', 'u2'] } }), owner('u2', [readRef('a1')])])), null);
  // A later message still waiting has none: the paw stays by the follow-up the reply took in.
  assert.equal(R.seenMark(shown, R.picked([owner('u1'), answer('a1', ['u1', 'u2']), owner('u2', [readRef('a1')]), owner('u3')])).id, 'u2');
});

test('再发一次 and quotes read the engine\'s order: an unfinished reply resends the message it answered unless the owner said it again after the reply began', () => {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-cards-rules.js'), { window });
  const C = window.ClowderCardsRules;
  const failed = { ...reply(2), native: { replyTo: 'u1' }, ended: { how: 'failed' }, follows: 3 };
  const rows = [{ ...user(1), content: '看看这个' }, failed, { ...user(3), content: '还有导出' }];
  assert.equal(C.resend(rows, failed, false).text, '看看这个');
  assert.equal(C.resend([{ ...user(1), content: '看看这个' }, failed, { ...user(3), content: '看看这个' }], failed, false), null);
  // The shell hands the native rows (never the drawing order) to everything that reads order or looks rows up.
  const single = take('renderMessages'), group = take('renderGroup');
  for (const call of [/botBubble\(m, say, messages, /, /userBubble\(m, messages\)/, /spokenLines\(messages\)/, /presence\.rendered\(messages\)/]) assert.match(single, call);
  for (const call of [/cards\.blocks\(body, m, messages, false\)/, /cards\.ending\(body, m, messages, false\)/]) assert.match(take('botBubble'), call);
  for (const call of [/cards\.blocks\(body, m, messages, true\)/, /cards\.ending\(body, m, messages, true\)/, /presence\.rendered\(messages\)/]) assert.match(group, call);
  assert.match(take('userBubble'), /quoteBlock\(messages, m\.reply_to\)/);
  assert.match(take('lineBySeq'), /Number\(m\.seq\) === n/, 'a quote finds its message by seq, wherever it is drawn');
});

test('the shell draws both histories in that order, keeps every index the row\'s own, and redraws when a reply in progress gains follows', () => {
  const single = take('renderMessages'), group = take('renderGroup');
  assert.match(single, /const order = liveRules\.order\(messages, false\);\n\s+state\.drawn = \{ messages, order, group: false \};\n\s+order\.forEach\(\(i\) => \{\n\s+const m = messages\[i\];\n\s+if \(skipMessage\(m\) \|\| wakeRuns\.hidden\.has\(i\)\) return;/);
  assert.equal((single.match(/messages\.forEach\(/g) || []).length, 1, 'only the pass that finds the latest cards walks the native order');
  assert.match(group, /const order = liveRules\.order\(messages, true\);\n\s+state\.drawn = \{ messages, order, group: true \};\n\s+for \(const m of order\.map\(\(i\) => messages\[i\]\)\) \{/);
  // What was drawn is what the read position asks about (chat-experience.js); an empty history draws nothing to ask about.
  assert.equal((single.match(/state\.drawn = null;/g) || []).length, 1);
  assert.equal((group.match(/state\.drawn = null;/g) || []).length, 1);
  assert.match(app, /displacedBefore: \(id\) => \(state\.drawn && !state\.peer \? liveRules\.displaced\(state\.drawn, id\) : \[\]\),/);
  assert.doesNotMatch(group, /for \(const m of messages\)/);
  // The redraw key of a reply in progress includes follows (its place), not its growing words.
  const out: Any = {};
  vm.runInNewContext(take('sigRows') + 'out.sigRows = sigRows;', { out, presentation: { isActivity: () => false } });
  const writing = { id: 'a', role: 'assistant', in_progress: true, content: '写', native: { content: '写' } };
  assert.notEqual(JSON.stringify(out.sigRows([writing])), JSON.stringify(out.sigRows([{ ...writing, follows: 3 }])));
  assert.equal(JSON.stringify(out.sigRows([{ ...writing, follows: 3 }])), JSON.stringify(out.sigRows([{ ...writing, follows: 3, content: '写到一半', native: { content: '写到一半' } }])));
  // The dividers measure against the latest time so far.
  assert.match(take('addTimeDividers'), /previous = laterTime\(previous, row\.dataset\.time\);/);
});

// ------------------------------------------------------- the stream's words
const sign = '[快手/haiku🐾]';
// The server's own cases (tests/bridge.test.ts, 'a reply that went on after the cat had signed…') and the legacy trailing ones.
const SERVER_CASES = [
  '第一段。\n\n第二段。\n\n' + sign + '\n\n狗喜欢的就不一样了。🐶',
  '一。\n\n' + sign + '\n\n二。\n\n' + sign + '\n\n三。\n\n' + sign,
  '一。\r\n\r\n' + sign + '  \r\n\r\n二。',
  sign + '\n\n' + sign + '\n\n一。',
  '一。\n\n[墨点/codex🐾]\n\n二。',
  '我的署名是 ' + sign + ' 这样。\n\n完。',
  '一。\n\n> ' + sign + '\n\n二。', '一。\n\n    ' + sign + '\n\n二。',
  '一。\n' + sign + '\n二。',
  '- 项目\n\n  ' + sign + '\n\n- 下一项',
  '- ' + sign + '\n- 二', '| ' + sign + ' |\n| --- |',
  '一。\n\n' + sign + '\n===\n\n正文',
  '看：\n\n```text\n' + sign + '\n```\n\n完。', '看：\n\n~~~\n\n' + sign + '\n\n~~~\n\n完。',
  '看：\n\n```text\n    ```\n\n' + sign + '\n\n```\n\n完。',
  '看：\n\n````md\n```\n\n' + sign + '\n\n```\n````\n\n完。',
  '看：\n\n```\n\n' + sign + '\n\n没有关上的代码块',
  '答复\n\n' + sign, '答复\n[另一只猫🐾]', '答复\n' + sign + '\n[另一只猫🐾]', '正文里引用 ' + sign,
];

test('while a reply streams, the cat\'s own signature between its parts is held back exactly as the server does for the finished reply, and never flashes on the way', () => {
  const L = rules();
  const server = (content: string, name?: string) => messageDisplayText({ id: 'm', type: 'assistant', catId: 'cat', timestamp: 1, content } as NativeMessage, 'thread', name);
  for (const content of SERVER_CASES) assert.equal(L.display(content, '快手'), server(content, '快手'), JSON.stringify(content));
  // Names with pattern characters, a longer name, and no name at all.
  assert.equal(L.display('一。\n\n[a.b(c)/x🐾]\n\n二。', 'a.b(c)'), '一。\n\n二。');
  assert.equal(L.display('一。\n\n[a.b(c)/x🐾]\n\n二。', 'aXb(c)'), server('一。\n\n[a.b(c)/x🐾]\n\n二。', 'aXb(c)'));
  assert.equal(L.display('一。\n\n[团子二/x🐾]\n\n二。', '团子'), '一。\n\n[团子二/x🐾]\n\n二。');
  assert.equal(L.display('一。\n\n' + sign + '\n\n二。'), '一。\n\n' + sign + '\n\n二。', 'without the speaking cat\'s name nothing in the middle is cut');
  // Every stage of the stream, of every case (kept ones too): what is drawn is what the server would show for the words so far,
  // except a last line that opens a bracket it has not closed, outside a code block, which waits (it may be a signature being
  // written). Inside a code block nothing is held back and brought back later: code shows as it comes.
  const fenced = (text: string) => {
    let fence = '';
    for (const row of text.split(/\r?\n/)) {
      const m = /^[ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(row);
      if (!m) continue;
      if (!fence) { if (m[1]![0] !== '`' || !m[2]!.includes('`')) fence = m[1]!; }
      else if (m[1]![0] === fence[0] && m[1]!.length >= fence.length && !m[2]!.trim()) fence = '';
    }
    return !!fence;
  };
  const expected = (arrived: string) => {
    // Half a CRLF has not made a line break yet.
    const sofar = arrived.replace(/\r$/, '');
    const cut = sofar.lastIndexOf('\n') + 1, last = sofar.slice(cut);
    const waits = /^\s{0,3}\[/.test(last) && !last.includes(']') && !fenced(sofar.slice(0, cut));
    return server(waits ? sofar.slice(0, cut) : sofar, '快手').replace(/\s+$/, '');
  };
  for (const content of SERVER_CASES) {
    for (let i = 1; i <= content.length; i++) assert.equal(L.display(content.slice(0, i), '快手'), expected(content.slice(0, i)), JSON.stringify(content.slice(0, i)));
    // A signature the finished reply does not show is never drawn on the way.
    if (!L.display(content, '快手').includes(sign)) for (let i = 1; i <= content.length; i++) assert.doesNotMatch(L.display(content.slice(0, i), '快手'), /快手\/haiku🐾/);
  }
  // The two kinds of incomplete line, spelled out: outside a code block it waits; inside one it shows at once and stays.
  assert.equal(L.display('看：\n\n[快手/hai', '快手'), '看：');
  assert.equal(L.display('看：\n\n```text\n[快手/hai', '快手'), '看：\n\n```text\n[快手/hai');
  assert.equal(L.display('看：\n\n```text\n[快手/haiku🐾]', '快手'), '看：\n\n```text\n[快手/haiku🐾]');
  assert.equal(L.display('看：\n\n```text\n[快手/haiku🐾]\n```', '快手'), '看：\n\n```text\n[快手/haiku🐾]\n```');
  // The first part's signature in the middle, as the engine streams a continued reply (and as the preview's stand-in does).
  const stream = '看了现有的方案。\n\n[宪宪/示例🐾]\n\n导出也看了：可以。';
  assert.equal(L.display(stream, '宪宪'), '看了现有的方案。\n\n导出也看了：可以。');
  assert.equal(L.middle('一。\n\n' + sign + '\n\n二。', '快手'), '一。\n\n二。');
});

test('drawn live, the reply\'s bubble never shows its own signature from the middle, while it writes or once it is done', () => {
  const p = page();
  p.select('bot:宪宪');
  const u1 = { ...user(1), time: t0 }, writing = { ...reply(2), native_cat_id: 'c', time: plus(t0, 2000), in_progress: true, draft: '' };
  p.draw([u1, writing]);
  const pieces = ['看了现有的方案。', '\n\n[宪宪/示', '例🐾]', '\n\n', '导出', '也看了。'];
  let end = 0;
  for (const piece of pieces) {
    end += piece.length;
    p.live.event({ kind: 'text', messageId: 'a2', catId: 'c', text: piece, end });
    p.flush();
    assert.doesNotMatch(text(p.rowOf('a2').find('lv-text')[0]), /🐾|\[宪宪/, piece);
  }
  assert.equal(text(p.rowOf('a2').find('lv-text')[0]), '看了现有的方案。\n\n导出也看了。');
});
