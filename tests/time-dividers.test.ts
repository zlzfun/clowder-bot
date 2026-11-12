import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El, text } from './fake-dom.js';

// Time dividers and the quiet lines (app.js addTimeDividers / addTimeDivider,
// the notice rows of chat-cards.js). A reminder that comes due, a receipt or a
// member check's refusal is a notice row, not a message: it used to be left
// out of the dividers, so a reminder that opened a new stretch of time was
// drawn before the divider that belongs to it, and the divider landed between
// it and the cat's reply (seen in the showcase's 小鲸鱼). These run app.js's own
// functions on tests/fake-dom.ts, with the real chat-cards.js drawing the
// notices and the real chat-live.js doing the history's keyed commit.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const app = read('client/public/app.js');
const take = (name: string) => {
  const m = new RegExp(`\\n {2}function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
  assert.ok(m, name + ' is where the shell keeps it');
  return m![0];
};
const rows = /\n {2}const TIMED_ROWS = [^\n]*\n/.exec(app);

function page() {
  const doc = new Doc();
  const h = (tag: string, cls = '', id = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; };
  const chat = h('div', 'chat'), thread = h('div', 'thread', 'thread');
  chat.append(thread);
  doc.body.append(chat);
  Object.assign(thread, { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400 });
  const window: Any = { matchMedia: () => ({ matches: false }), requestAnimationFrame: (fn: () => void) => { fn(); return 1; } };
  const el = (tag: string, cls: string, words?: string) => { const n = h(tag, cls); if (words) n.textContent = words; return n; };
  const context = vm.createContext({ window, document: doc, console, Date, Number, Array, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, el, out: {} as Any });
  for (const f of ['chat-live-rules.js', 'chat-live.js', 'chat-cards-rules.js', 'chat-cards.js']) vm.runInContext(read('client/public/' + f), context);
  assert.ok(rows, 'app.js names the rows that take part in the dividers');
  vm.runInContext(['clockTime', 'timeDivider'].map(take).join('') + rows![0] + ['laterTime', 'addTimeDivider', 'addTimeDividers'].map(take).join('')
    + 'out.timeDivider = timeDivider; out.addTimeDivider = addTimeDivider; out.addTimeDividers = addTimeDividers;', context);
  const live = window.ClowderLive, cards = window.ClowderCards, out = context.out;
  live.init({ thread, render: () => {}, row: () => h('div', 'msg bot live'), queued: () => false, busy: () => false, unread: () => '', changed: () => {}, gap: () => {} });
  cards.init({ thread, icon: (name: string) => { const s = h('svg', 'icon'); s.dataset.icon = name; return s; }, api: async () => ({ approvals: [] }), render: (n: El, t: string) => n.append(t) });
  live.select('bot:小鲸鱼');
  // The history as renderMessages / renderGroup draw it: a notice through chat-cards.js, every other line a message row; then the dividers, then the keyed commit.
  const draw = (messages: Any[], chatKey = 'bot:小鲸鱼') => {
    const inner = h('div', 'thread-inner');
    inner.dataset.chat = chatKey;
    for (const m of messages) {
      if (m.notice) { inner.append(cards.notice(m, m.content)); continue; }
      const row = h('div', 'msg ' + (m.role === 'user' ? 'user' : 'bot'));
      row.dataset.mid = m.id; row.dataset.time = m.time;
      row.append(h('div', 'body'));
      row.querySelector('.body')!.append(m.content);
      inner.append(row);
    }
    out.addTimeDividers(inner);
    const shown = live.commit(inner, []);
    return { shown, inner: thread.children[0] as El };
  };
  const seq = () => (thread.children[0] as El).children.map((n: El) => n.classList.contains('tdiv') ? '[' + text(n) + ']' : n.classList.contains('ck-notice') ? '(' + text(n) + ')' : n.dataset.mid);
  return { doc, h, draw, seq, out, thread };
}

const MIN = 60_000, DAY = 86_400_000;
const at = (daysAgo: number, hour: number, minute = 0, second = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, minute, second, 0); return d.toISOString(); };
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const say = (id: string, time: string, content: string, role = 'user') => ({ id, role, time, content });
const notice = (id: string, time: string, content: string, reminder = false) => ({ id, native_message_id: id, notice: true, reminder, time, content });

// 小鲸鱼 as staged: a request agreed (its receipt), then a reminder come due on two mornings, each followed by the cat.
function whale() {
  const first = at(3, 20, 30), d2 = at(2, 9), d1 = at(1, 9);
  return [
    say('u1', first, '以后每天早上 9 点，提醒我看一眼当天的日程。'),
    say('c1', plus(first, 30_000), '好。我设一个每天早上 9 点的定时，等你点头。', 'assistant'),
    notice('r0', plus(first, 2 * MIN), '定时已按你的确认处理。'),
    notice('r1', d2, '提醒：看一眼当天的日程', true),
    say('c2', plus(d2, 25_000), '早。今天有两件事。', 'assistant'),
    notice('r2', d1, '提醒：看一眼当天的日程', true),
    say('c3', plus(d1, 25_000), '早。今天只有一件。', 'assistant'),
  ];
}

test('a reminder that opens a new stretch of time comes after its divider, and the cat\'s reply shares it; a receipt right after its request gets none', () => {
  const p = page();
  const messages = whale();
  p.draw(messages);
  const label = (iso: string) => '[' + p.out.timeDivider(undefined, iso) + ']';
  assert.deepEqual(p.seq(), [
    label(messages[0]!.time), 'u1', 'c1', '(定时已按你的确认处理。)',
    label(messages[3]!.time), '(提醒：看一眼当天的日程)', 'c2',
    label(messages[5]!.time), '(提醒：看一眼当天的日程)', 'c3',
  ]);
  assert.match(label(messages[5]!.time), /^\[昨天 09:00\]$/);
  // The reminder pill itself is what chat-cards.js draws (keyed by its message ID, with its time).
  const pill = p.thread.querySelector('.ck-reminder')!;
  assert.equal(pill.dataset.mid, 'r1');
  assert.equal(pill.dataset.time, messages[3]!.time);
});

test('in a group, the member check\'s refusal follows the message it answers without a divider, and a notice after a long quiet gets its own', () => {
  const p = page();
  const t = at(1, 15, 20), later = at(0, 0, 5);
  const messages = [
    say('u1', t, '@金渐层 你怎么看？'),
    notice('n1', plus(t, 5_000), '金渐层不在这个群里，没有回答。'),
    notice('n2', plus(t, 2 * 60 * MIN), '定时已按你的确认处理。'),
    say('u2', later, '@布偶猫 @缅因猫 @暹罗猫 各用一句话：上线前最担心什么？'),
    say('c1', plus(later, 40_000), '深色模式没调好就上线。', 'assistant'),
  ];
  p.draw(messages, 'group:g1');
  const label = (iso: string) => '[' + p.out.timeDivider(undefined, iso) + ']';
  assert.deepEqual(p.seq(), [label(t), 'u1', '(金渐层不在这个群里，没有回答。)', label(messages[2]!.time), '(定时已按你的确认处理。)', label(later), 'u2', 'c1']);
});

test('the rows stay keyed: drawing the same history again keeps every element, nothing rises again; a reminder coming due while the chat is open adds only its own rows', () => {
  const p = page();
  const messages = whale();
  p.draw(messages);
  const before = (p.thread.children[0] as El).children.slice();
  const again = p.draw(messages);
  const after = (p.thread.children[0] as El).children;
  assert.equal(after.length, before.length);
  after.forEach((n: El, i: number) => assert.equal(n, before[i], 'row ' + i + ' is the same element'));
  assert.equal(again.shown.added, 0);
  assert.ok(after.every((n: El) => !n.classList.contains('lv-still')), 'no row was replaced');
  // Today 09:00 the reminder comes due, the cat follows: one divider before the reminder, none before the reply.
  const today = new Date(); today.setHours(9, 0, 0, 0);
  const due = new Date(Math.min(today.getTime(), Date.now() - 10 * MIN)).toISOString();
  const more = [...messages, notice('r3', due, '提醒：看一眼当天的日程', true), say('c4', plus(due, 25_000), '早。今天是空的。', 'assistant')];
  const third = p.draw(more);
  const now = (p.thread.children[0] as El).children;
  before.forEach((n: El, i: number) => assert.equal(now[i], n, 'old row ' + i + ' kept in place'));
  assert.deepEqual(p.seq().slice(before.length), ['[' + p.out.timeDivider(undefined, due) + ']', '(提醒：看一眼当天的日程)', 'c4']);
  assert.equal(third.shown.added, 1, 'one new message row (the notice and its divider are not messages)');
});

test('a send right after a quiet line is measured from it (addTimeDivider): no divider of its own a minute after a reminder', () => {
  const p = page();
  const inner = p.h('div', 'thread-inner');
  const old = p.h('div', 'msg bot'); old.dataset.time = new Date(Date.now() - 3 * 60 * MIN).toISOString();
  const pill = p.h('div', 'sysline ck-notice ck-reminder'); pill.dataset.time = new Date(Date.now() - MIN).toISOString();
  inner.append(old, pill);
  const send = p.h('div', 'msg user optimistic'); send.dataset.time = new Date().toISOString();
  p.out.addTimeDivider(inner, send);
  assert.equal(inner.querySelectorAll('.tdiv').length, 0);
  // Without the quiet line it would have been three hours since the last line.
  pill.remove();
  p.out.addTimeDivider(inner, send);
  assert.equal(inner.querySelectorAll('.tdiv').length, 1);
  assert.ok(DAY > 0);
});

test('app.js keeps one list of the rows that take part, used by both divider functions; chat-cards.js marks notices with ck-notice and their time', () => {
  assert.match(rows![0], /const TIMED_ROWS = \[".msg\[data-time\]", ".routine-line\[data-time\]", ".ck-notice\[data-time\]"\];/);
  assert.match(take('addTimeDividers'), /TIMED_ROWS\.map\(\(s\) => ":scope > " \+ s\)/);
  assert.match(take('addTimeDivider'), /querySelectorAll\(TIMED_ROWS\.join\(", "\)\)/);
  const cards = read('client/public/chat-cards.js');
  assert.match(cards, /const row = node\("div", "sysline ck-notice" \+ \(m\.reminder \? " ck-reminder" : ""\)\);/);
  assert.match(cards, /if \(m\.time\) row\.dataset\.time = String\(m\.time\);/);
});
