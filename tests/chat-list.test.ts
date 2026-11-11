import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El, text } from './fake-dom.js';

// The sidebar as a contact list and each chat's draft (chat-list-rules.js,
// chat-list.js; data: activity.last in GET /xbot-api/bots/status,
// docs/chat-experience-api.md). The rules run in a bare VM; the DOM module
// runs as the classic script it is on tests/fake-dom.ts, with the hooks app.js
// passes faked and the sidebar's rows built the way listButton builds them.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-list-rules.js'), { window });
  return window.ClowderListRules;
}
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const status = (last: Any, more: Record<string, unknown> = {}) => ({ thread_id: 'T1', activity: { threadId: 'T1', readStatus: 'ready', unread: 0, unreadHasMore: false, last, ...more } });
const line = (from: string, text: string, time: number, more: Record<string, unknown> = {}) => ({ messageId: 'm-' + time, time: new Date(time).toISOString(), from, text, files: 0, ...more });

// ---------------------------------------------------------------- rules
test('the preview line says who spoke: 你 for the owner, the cat in a group, nobody for a single chat\'s own cat; a file-only line reads [文件]', () => {
  const L = rules();
  const now = at(2026, 11, 11, 20);
  const owner = L.last(status(line('owner', '帮我看看这个', now)));
  assert.equal(L.preview(owner, false), '你：帮我看看这个');
  const cat = L.last(status(line('cat', '好的，**马上**看。', now, { catId: 'c1', catName: '团子' })));
  assert.equal(L.preview(cat, false), '好的，马上看。', 'a single chat\'s cat speaks for its own row');
  assert.equal(L.preview(cat, true), '团子：好的，马上看。');
  assert.equal(L.preview(L.last(status(line('cat', '你好', now, { catName: '' }))), true), '猫猫：你好');
  assert.equal(L.preview(L.last(status(line('owner', '', now, { files: 1 }))), false), '你：[文件]');
  assert.equal(L.preview(L.last(status(line('cat', '', now, { files: 2, catName: '栗子' }))), true), '栗子：[文件] 2 个');
  // Markdown marks do not show; a long line is clipped.
  assert.equal(L.plain('## 结论 `npm test` 见[文档](https://x) ~~~'), '结论 npm test 见文档');
  assert.equal(L.preview(L.last(status(line('owner', '长'.repeat(200), now))), false).length, 80);
  // Not a line: nothing is made up.
  for (const bad of [null, {}, line('someone', '嗯', now), line('cat', '', now), { ...line('cat', '嗯', now), time: 'soon' }]) assert.equal(L.last(status(bad)), null);
  assert.equal(L.last({ thread_id: 'T1' }), null, 'a cat with no conversation yet');
  assert.equal(L.last(status(line('cat', '嗯', now))).thread, 'T1');
});

test('times are short and in one style: 刚刚, N 分钟前, today\'s clock, 昨天, a weekday this past week, a date this year, a full date before', () => {
  const L = rules();
  const now = at(2026, 11, 11, 20, 30);
  assert.equal(L.ago(now - 20_000, now), '刚刚');
  assert.equal(L.ago(now + 30_000, now), '刚刚', 'a clock slightly ahead is not the future');
  assert.equal(L.ago(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(L.ago(now - 59 * 60_000, now), '59 分钟前');
  assert.equal(L.ago(at(2026, 11, 11, 9, 5), now), '09:05');
  assert.equal(L.ago(at(2026, 11, 10, 23, 59), now), '昨天');
  assert.equal(L.ago(at(2026, 11, 6, 10), now), '周五');
  assert.equal(L.ago(at(2026, 11, 3, 10), now), '11月3日');
  assert.equal(L.ago(at(2025, 12, 31, 10), now), '2025/12/31');
  assert.equal(L.ago(0, now), '');
  assert.equal(L.stamp(at(2026, 11, 3, 9, 5)), '2026年11月3日 09:05');
});

test('the order is recency: conversations with a newest line first, newest first; the rest keep their order after them, and ties never swap', () => {
  const L = rules();
  assert.deepEqual(plain(L.order([
    { key: 'a', time: 0 }, { key: 'b', time: 300 }, { key: 'c', time: 0 }, { key: 'd', time: 900 }, { key: 'e', time: 300 },
  ])), ['d', 'b', 'e', 'a', 'c']);
  assert.deepEqual(plain(L.order([{ key: 'x', time: 0 }, { key: 'y', time: 0 }])), ['x', 'y']);
});

test('unread: the count shows from two up (99+ at most, + when there are more than a page holds); the title carries the total, and nothing when all is read', () => {
  const L = rules();
  const u = (unread: number, more = false) => status(null, { unread, unreadHasMore: more });
  assert.equal(L.badge(L.unread(u(1))), '', 'one new reply: the dot alone says it');
  assert.equal(L.badge(L.unread(u(2))), '2');
  assert.equal(L.badge(L.unread(u(3, true))), '3+');
  assert.equal(L.badge(L.unread(u(140))), '99+');
  assert.equal(L.badge(L.unread({})), '');
  const total = L.total([u(1), u(2), u(0), {}, { activity: { unread: null } }]);
  assert.deepEqual(plain(total), { n: 3, more: false });
  // The conversation in view is left out (its reply is being read), even with more unread than a page.
  const open = u(4, true);
  assert.deepEqual(plain(L.total([u(1), open, u(2)], open)), { n: 3, more: false });
  assert.deepEqual(plain(L.total([u(1), open, u(2)], null)), { n: 7, more: true });
  assert.equal(L.title('团子 · clowder-bot', total), '(3) 团子 · clowder-bot');
  assert.equal(L.title('团子 · clowder-bot', { n: 0, more: false }), '团子 · clowder-bot');
  assert.equal(L.title('', { n: 120, more: false }), '(99+) clowder-bot');
});

test('the greeting names the owner only when the server knows a name, never the default 你', () => {
  const L = rules();
  assert.equal(L.greetName('你'), '');
  assert.equal(L.greetName(' 我 '), '');
  assert.equal(L.greetName(''), '');
  assert.equal(L.greetName('小林'), '小林');
});

test('drafts: words and a quote are kept per chat; a quote keeps its conversation and one without it is not kept; a cat is keyed by its native ID; an old name key moves once', () => {
  const L = rules();
  const d = L.drafts();
  const q = { seq: 4, text: '原话', thread: 'T1' };
  assert.equal(d.put('cat:c1', '还没写完', q), true);
  assert.equal(d.put('cat:c1', '还没写完', q), false, 'unchanged');
  assert.equal(d.put('group:g', '   ', null), false, 'blank words and no quote: nothing to keep');
  assert.equal(d.get('group:g'), null);
  assert.equal(d.put('cat:c2', '', { seq: 'x', thread: 'T1' }), false, 'a quote without a message number is not a quote');
  assert.equal(d.put('cat:c2', '', { seq: 3, text: 'x' }), false, 'nor one that does not say which conversation its number belongs to');
  assert.equal(L.draftLine(d.get('cat:c1')), '还没写完');
  assert.equal(L.draftLine({ text: ' ', quote: q }), '引用了一条消息');
  const copy = L.drafts(JSON.parse(JSON.stringify(d.toJSON())));
  assert.deepEqual(plain(copy.take('cat:c1')), { text: '还没写完', quote: q });
  assert.equal(copy.get('cat:c1'), null);
  assert.equal(d.put('cat:c1', '', null), true, 'emptied: the draft goes');
  assert.equal(d.get('cat:c1'), null);
  // The quote fits only the conversation it was taken in.
  assert.equal(L.quoteFits(q, 'T1'), true);
  assert.equal(L.quoteFits(q, 'T2'), false);
  assert.equal(L.quoteFits(q, ''), false);
  // Keys: a cat by its native ID when known, else its name; a group by its ID.
  assert.equal(L.draftKey({ type: 'bot', id: '团子' }, 'c1'), 'cat:c1');
  assert.equal(L.draftKey({ type: 'bot', id: '团子' }, ''), 'bot:团子');
  assert.equal(L.draftKey({ type: 'group', id: 'g1' }, 'ignored'), 'group:g1');
  // An old name-keyed draft moves to the lasting key, never over a newer one.
  const old = L.drafts({ 'bot:团子': { text: '旧的' }, 'bot:栗子': { text: '旧' }, 'cat:c2': { text: '新的' } });
  assert.equal(old.move('bot:团子', 'cat:c1'), true);
  assert.deepEqual(plain(old.get('cat:c1')), { text: '旧的', quote: null });
  assert.equal(old.get('bot:团子'), null);
  assert.equal(old.move('bot:栗子', 'cat:c2'), true);
  assert.deepEqual(plain(old.get('cat:c2')), { text: '新的', quote: null }, 'the newer draft stays');
  assert.equal(old.move('bot:none', 'cat:c3'), false);
});

// ---------------------------------------------------------------- the module
type Opts = { reduce?: boolean; saved?: Record<string, unknown> };
function page(opts: Opts = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '', id = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; };
  const scroll = h('div', 'side-scroll'), roster = h('nav', 'list', 'roster');
  scroll.append(roster);
  doc.body.append(scroll);
  const storage = new Map<string, string>(Object.entries(opts.saved ?? {}).map(([k, v]) => [k, JSON.stringify(v)]));
  let now = at(2026, 11, 11, 20, 30);
  const timers: Array<{ fn: () => void; every: number; at: number }> = [];
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: Any[]) { super(...((args.length ? args : [now]) as [number])); }
    static override now() { return now; }
  }
  const winListeners = new Map<string, Array<() => void>>();
  const window: Any = {
    matchMedia: () => ({ matches: !!opts.reduce }),
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    addEventListener: (type: string, fn: () => void) => { const l = winListeners.get(type) ?? []; l.push(fn); winListeners.set(type, l); },
  };
  const context = vm.createContext({
    window, document: doc, console, Date: FakeDate,
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, String(v)); } },
    // Timers that only clean up after a glide never need to run here.
    setTimeout: () => 1,
    setInterval: (fn: () => void, every: number) => { timers.push({ fn, every, at: now + every }); return timers.length; },
  });
  for (const file of ['client/public/chat-list-rules.js', 'client/public/chat-list.js']) vm.runInContext(read(file), context);
  const list = window.ClowderList;
  const entries: Any = { bots: {}, groups: {} };
  const composer = { text: '', quote: null as Any };
  const app: Any = { sel: null };
  const ids: Record<string, string> = { 团子: 'c1', 栗子: 'c2', 年糕: 'c3' };
  list.init({
    entries: () => entries,
    selected: () => app.sel,
    catId: (name: string) => ids[name] || '',
    composer: {
      text: () => composer.text,
      set: (t: string) => { composer.text = t; },
      quote: () => composer.quote,
      setQuote: (q: Any) => { composer.quote = q; },
    },
  });
  // A sidebar row as listButton draws it (avatar, name line, preview line).
  const row = (kind: 'bot' | 'group', id: string) => {
    const btn = h('button', 'item');
    btn.dataset[kind] = id;
    const av = h('span', 'avatar');
    const body = h('span', 'item-body');
    const head = h('span', 'name-line');
    head.append(h('span', 'name'));
    head.children[0].textContent = id;
    const pv = h('span', 'preview');
    body.append(head, pv);
    btn.append(av, body);
    return btn;
  };
  // The roster renderLists builds: a flat cat list, then groups after their label.
  const build = (cats: string[], groups: string[] = []) => {
    roster.replaceChildren();
    const body = h('div', 'folder-bots');
    for (const c of cats) body.append(row('bot', c));
    roster.append(body);
    if (groups.length) roster.append(h('div', 'group-label'));
    for (const g of groups) roster.append(row('group', g));
  };
  const order = () => roster.querySelectorAll('.item').map((r: El) => r.dataset.bot || r.dataset.group);
  const advance = (ms: number) => { now += ms; for (const t of timers) while (t.at <= now) { t.at += t.every; t.fn(); } };
  const pagehide = () => (winListeners.get('pagehide') ?? []).forEach(fn => fn());
  return { doc, list, roster, entries, composer, app, build, order, row, storage, advance, pagehide, ids, clock: () => now, h };
}

test('a row\'s second line is the draft left in that chat (never in the open one), else the latest line said there; a failed read keeps the line it last read', () => {
  const p = page();
  const t = p.clock();
  p.entries.bots['团子'] = status(line('cat', '要不要先吃饭？', t - 60_000, { catName: '团子' }));
  p.entries.groups['g1'] = status(line('cat', '我来订座', t - 30_000, { catName: '栗子' }));
  assert.equal(text(p.list.preview('bot', '团子').node), '要不要先吃饭？');
  assert.equal(text(p.list.preview('group', 'g1').node), '栗子：我来订座');
  assert.equal(p.list.preview('bot', '年糕'), null, 'no status yet: the row keeps what it showed');
  // Leaving 团子 with words in the composer: its row says 草稿.
  p.app.sel = { type: 'bot', id: '团子' };
  p.composer.text = '吃火锅还是';
  p.list.leave(p.app.sel);
  p.app.sel = { type: 'group', id: 'g1' };
  p.list.enter(p.app.sel);
  const drafted = p.list.preview('bot', '团子');
  assert.equal(text(drafted.node), '草稿：吃火锅还是');
  assert.ok(drafted.node.classList.contains('cl-draft'));
  assert.notEqual(drafted.sig, p.list.preview('group', 'g1').sig);
  // The open chat never shows its own draft as one (the composer holds it).
  p.app.sel = { type: 'bot', id: '团子' };
  assert.equal(text(p.list.preview('bot', '团子').node), '要不要先吃饭？');
  p.list.enter(p.app.sel);
  assert.equal(p.composer.text, '吃火锅还是');
  assert.equal(text(p.list.preview('bot', '团子').node), '要不要先吃饭？');
  // A read that failed: the line read before for the same conversation stays …
  p.entries.bots['团子'] = { thread_id: 'T1', activity: { threadId: 'T1', readStatus: 'unavailable', last: null } };
  assert.equal(text(p.list.preview('bot', '团子').node), '要不要先吃饭？');
  // … but not for another conversation, and a whole read with nothing said means nothing was said.
  p.entries.bots['团子'] = { thread_id: 'T2', activity: { threadId: 'T2', readStatus: 'partial', last: null } };
  assert.equal(p.list.preview('bot', '团子'), null);
  p.entries.bots['团子'] = status(line('cat', '要不要先吃饭？', t - 60_000));
  p.list.preview('bot', '团子');
  p.entries.bots['团子'] = status(null);
  assert.equal(p.list.preview('bot', '团子'), null);
});

test('painting puts the time on the name line and the count beside the preview (two up, never on the open chat), and the page title carries the total', () => {
  const p = page();
  const t = p.clock();
  p.build(['团子', '栗子'], ['g1']);
  p.entries.bots['团子'] = status(line('cat', '好', t - 5 * 60_000), { unread: 3 });
  p.entries.bots['栗子'] = status(line('owner', '在吗', t - 10_000), { unread: 1 });
  p.entries.groups['g1'] = status(line('cat', '早', at(2026, 11, 10, 9)), { unread: 2, unreadHasMore: true });
  p.list.title('栗子 · clowder-bot');
  p.app.sel = { type: 'bot', id: '栗子' };
  p.list.paint(p.roster);
  const rowOf = (key: string) => p.roster.querySelector(key.startsWith('g') ? `.item[data-group="${key}"]` : `.item[data-bot="${key}"]`)!;
  const time = (k: string) => rowOf(k).querySelector('.name-line > .cl-time');
  const count = (k: string) => rowOf(k).querySelector('.item-body > .cl-count');
  assert.equal(text(time('团子')), '5 分钟前');
  assert.equal(text(time('栗子')), '刚刚');
  assert.equal(text(time('g1')), '昨天');
  assert.equal(time('g1')!.getAttribute('title'), '2026年11月10日 09:00');
  assert.equal(text(count('团子')), '3');
  assert.equal(count('团子')!.getAttribute('aria-label'), '3 条新回复');
  assert.equal(count('栗子'), null, 'one new reply in the open chat: no count');
  assert.equal(text(count('g1')), '2+');
  assert.ok(rowOf('团子').querySelector('.item-body')!.classList.contains('cl-body'));
  assert.equal(p.doc.title, '(5+) 栗子 · clowder-bot', 'every other conversation\'s new replies: the open chat, in view, is being read');
  // A hidden tab counts the open chat too (that reply is waiting); back in view it stops, at once.
  const doc = p.doc as Any;
  doc.visibilityState = 'hidden';
  p.list.paint(p.roster);
  assert.equal(p.doc.title, '(6+) 栗子 · clowder-bot', 'the tab is hidden: the open chat\'s reply is waiting too');
  doc.visibilityState = 'visible';
  for (const fn of doc.listeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' });
  assert.equal(p.doc.title, '(5+) 栗子 · clowder-bot', 'back in view: the open chat is not counted, without waiting for a poll');
  // Read: the count and the title clear; minutes pass and the time follows without a poll.
  p.entries.bots['团子'] = status(line('cat', '好', t - 5 * 60_000), { unread: 0 });
  p.entries.bots['栗子'] = status(line('owner', '在吗', t - 10_000), { unread: 0 });
  p.entries.groups['g1'] = status(line('cat', '早', at(2026, 11, 10, 9)), { unread: 0 });
  p.list.paint(p.roster);
  assert.equal(count('团子')!.hidden, true);
  assert.equal(p.doc.title, '栗子 · clowder-bot');
  p.advance(90_000);
  assert.equal(text(time('栗子')), '1 分钟前');
  // A row with nothing said has no time.
  p.entries.bots['团子'] = status(null);
  p.list.paint(p.roster);
  assert.equal(time('团子')!.hidden, true);
});

test('rows go newest first inside the list and among groups; rows with nothing said keep their order; work starting or stopping moves nothing; the focused row keeps its focus', () => {
  const p = page();
  const t = p.clock();
  p.build(['甲', '乙', '丙', '丁'], ['g1', 'g2']);
  p.entries.bots['丙'] = status(line('cat', '三', t - 1000));
  p.entries.bots['乙'] = status(line('owner', '二', t - 5000));
  p.entries.groups['g2'] = status(line('owner', '群二', t - 2000));
  p.entries.groups['g1'] = status(null);
  p.list.paint(p.roster);
  assert.deepEqual(p.order(), ['丙', '乙', '甲', '丁', 'g2', 'g1']);
  const label = p.roster.querySelector('.group-label')!;
  assert.equal(p.roster.children.indexOf(label), 1, 'groups stay under their label');
  // The cat starts working: its status changes, its latest line does not; nothing moves.
  const moves = p.roster.querySelectorAll('.item').map((r: El) => r.moves);
  p.entries.bots['甲'] = { ...status(null), state: 'running' };
  p.list.paint(p.roster);
  assert.deepEqual(p.order(), ['丙', '乙', '甲', '丁', 'g2', 'g1']);
  assert.deepEqual(p.roster.querySelectorAll('.item').map((r: El) => r.moves), moves, 'no row was touched');
  // A reply lands for 丁 while the owner's focus is on 乙: 丁 moves up, 乙 is not moved and keeps focus.
  const b = p.roster.querySelector('.item[data-bot="乙"]')!;
  b.focus();
  const before = b.moves;
  p.entries.bots['丁'] = status(line('cat', '四', t));
  p.list.paint(p.roster);
  assert.deepEqual(p.order(), ['丁', '丙', '乙', '甲', 'g2', 'g1']);
  assert.equal(b.moves, before, 'the focused row stayed where it was in the DOM');
  assert.equal(p.doc.activeElement, b);
  // A list drawn anew in the server's order (a dot changed) is put back in
  // order, and the row that had keyboard focus has it again on its new element.
  for (const fn of p.doc.listeners.get('focusin') ?? []) fn({ target: b });
  p.build(['甲', '乙', '丙', '丁'], ['g1', 'g2']);
  assert.ok(p.doc.activeElement === p.doc.body, 'drawing anew dropped the focused element');
  p.list.paint(p.roster);
  assert.deepEqual(p.order(), ['丁', '丙', '乙', '甲', 'g2', 'g1']);
  const again = p.roster.querySelector('.item[data-bot="乙"]')!;
  assert.ok(again !== b && p.doc.activeElement === again, 'focus is back on 乙');
  // Focus the owner moved elsewhere is left alone.
  const elsewhere = p.h('button');
  p.doc.body.append(elsewhere);
  for (const fn of p.doc.listeners.get('focusin') ?? []) fn({ target: again });
  p.build(['甲', '乙', '丙', '丁'], ['g1', 'g2']);
  elsewhere.focus();
  p.list.paint(p.roster);
  assert.ok(p.doc.activeElement === elsewhere);
});

test('a row that moves glides from where it was (180 ms), not under reduced motion', () => {
  for (const reduce of [false, true]) {
    const p = page({ reduce });
    const t = p.clock();
    p.build(['甲', '乙']);
    // Layout: each row 56px tall in list order.
    const place = () => p.roster.querySelectorAll('.item').forEach((r: El, i: number) => { r.getBoundingClientRect = () => ({ top: i * 56 }); });
    (p.roster.parentElement as El).getBoundingClientRect = () => ({ top: 0 });
    place();
    p.entries.bots['甲'] = status(line('cat', '一', t - 5000));
    p.entries.bots['乙'] = status(line('cat', '二', t - 9000));
    p.list.paint(p.roster);
    p.entries.bots['乙'] = status(line('cat', '二', t));
    const origInsert = (p.roster.children[0] as El).insertBefore.bind(p.roster.children[0]);
    (p.roster.children[0] as El).insertBefore = (n: Any, ref: Any) => { const r = origInsert(n, ref); place(); return r; };
    p.list.paint(p.roster);
    assert.deepEqual(p.order(), ['乙', '甲']);
    const moved = p.roster.querySelectorAll('.item.cl-moving');
    assert.equal(moved.length, reduce ? 0 : 2, reduce ? 'reduced motion: rows just take their place' : 'both rows glide');
  }
});

test('each chat keeps its own draft and quote: leaving takes them along, another chat starts empty, coming back brings the words at once and the quote once a read shows the same conversation; a reload keeps them for the tab', () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' }, other = { type: 'bot', id: '栗子' }, group = { type: 'group', id: 'g1' };
  const quote = { seq: 7, text: '上一句', thread: 'T1' };
  p.app.sel = cat;
  p.list.enter(cat);
  p.composer.text = '帮我把这段';
  p.composer.quote = quote;
  p.list.leave(cat);
  p.app.sel = other;
  p.list.enter(other);
  assert.equal(p.composer.text, '', 'the words do not follow into another chat');
  assert.equal(p.composer.quote, null, 'nor the quote');
  p.composer.text = '群里也说一声';
  p.list.leave(other);
  p.app.sel = group;
  p.list.enter(group);
  assert.equal(p.composer.text, '');
  p.composer.text = '大家好';
  p.composer.quote = { seq: 2, text: 'x', thread: 'G' };
  p.list.leave(group);
  assert.deepEqual(plain(p.list.draft(group)), { text: '大家好', quote: null }, 'a group has no quote');
  p.app.sel = cat;
  p.list.enter(cat);
  assert.equal(p.composer.text, '帮我把这段');
  assert.equal(p.composer.quote, null, 'the quote waits for a read of this chat');
  assert.equal(p.list.draft(cat), null, 'the open chat\'s words live in the composer, not as a draft');
  p.list.read(cat, 'T1');
  assert.deepEqual(plain(p.composer.quote), quote, 'the same conversation: the quote is back');
  // A reload: the tab's copy brings back every draft, the open chat's too.
  p.pagehide();
  const saved = JSON.parse(p.storage.get('clowder-drafts:v1')!);
  const q = page({ saved: { 'clowder-drafts:v1': saved } });
  q.app.sel = cat;
  q.list.enter(cat);
  assert.equal(q.composer.text, '帮我把这段');
  q.list.read(cat, 'T1');
  assert.deepEqual(plain(q.composer.quote), quote);
  assert.equal(text(q.list.preview('bot', '栗子').node), '草稿：群里也说一声');
});

test('a quote never lands in another conversation of the same cat: after a 新对话, a saved conversation opened again, or a move made elsewhere, it is dropped; one in the composer goes when a read shows the chat moved', () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' }, other = { type: 'bot', id: '栗子' };
  p.app.sel = cat;
  p.list.enter(cat);
  p.composer.text = '接着说';
  p.composer.quote = { seq: 3, text: '那一句', thread: 'T1' };
  // Opened again in place (a new or another saved conversation): the chat reads T2.
  p.list.leave(cat);
  p.list.enter(cat);
  p.list.read(cat, 'T2');
  assert.equal(p.composer.text, '接着说', 'the words stay');
  assert.equal(p.composer.quote, null, 'the quote belonged to T1');
  // Away and back after the cat was moved elsewhere (another tab), and after a reload.
  p.composer.quote = { seq: 3, text: '那一句', thread: 'T2' };
  p.list.leave(cat);
  p.app.sel = other;
  p.list.enter(other);
  p.app.sel = cat;
  p.list.enter(cat);
  p.list.read(cat, 'T3');
  assert.equal(p.composer.quote, null);
  p.composer.quote = { seq: 3, text: '那一句', thread: 'T3' };
  p.pagehide();
  const q = page({ saved: { 'clowder-drafts:v1': JSON.parse(p.storage.get('clowder-drafts:v1')!) } });
  q.app.sel = cat;
  q.list.enter(cat);
  q.list.read(cat, 'T4');
  assert.equal(q.composer.quote, null, 'after a reload too');
  // A quote taken here, then the chat moved under it: the next read takes it away.
  q.composer.quote = { seq: 9, text: '这句', thread: 'T4' };
  q.list.read(cat, 'T4');
  assert.deepEqual(plain(q.composer.quote), { seq: 9, text: '这句', thread: 'T4' });
  q.list.read(cat, 'T5');
  assert.equal(q.composer.quote, null);
});

test('a draft belongs to the cat, not its name: a rename keeps it, a deleted cat\'s goes, and a new cat reusing the name starts empty; an old name-keyed draft is moved over', () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' };
  p.app.sel = cat;
  p.list.enter(cat);
  p.composer.text = '改名前写的';
  p.composer.quote = { seq: 1, text: 'q', thread: 'T1' };
  // Renamed 团子 → 汤圆: the list already knows only the new name when the chat reopens.
  delete p.ids['团子'];
  p.ids['汤圆'] = 'c1';
  p.list.leave(cat);
  const renamed = { type: 'bot', id: '汤圆' };
  p.app.sel = renamed;
  p.list.enter(renamed);
  p.list.read(renamed, 'T1');
  assert.equal(p.composer.text, '改名前写的', 'the words follow the cat');
  assert.deepEqual(plain(p.composer.quote), { seq: 1, text: 'q', thread: 'T1' }, 'its conversation is the same: the quote stays');
  // Away, then the cat is deleted: its draft goes; a new cat with that name starts empty.
  p.list.leave(renamed);
  p.app.sel = { type: 'bot', id: '栗子' };
  p.list.enter(p.app.sel);
  assert.ok(p.list.draft(renamed));
  p.list.forget(renamed);
  assert.equal(p.list.draft(renamed), null);
  p.ids['汤圆'] = 'c9';
  assert.equal(p.list.draft(renamed), null, 'the new cat with the old name has nothing');
  assert.equal(p.list.preview('bot', '汤圆'), null);
  // A draft saved under the old name key (before drafts were kept by ID) moves to the cat.
  const q = page({ saved: { 'clowder-drafts:v1': { 'bot:年糕': { text: '旧版存的' } } } });
  assert.equal(text(q.list.preview('bot', '年糕').node), '草稿：旧版存的');
  assert.deepEqual(plain(q.list.draft({ type: 'bot', id: '年糕' })), { text: '旧版存的', quote: null });
  assert.ok(!('bot:年糕' in JSON.parse(q.storage.get('clowder-drafts:v1')!)), 'stored under the cat\'s ID now');
});

test('a send that did not go out gives its words and quote back to its own chat: to the draft when the owner left, to an empty composer when they came back, never over newer words', () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' }, other = { type: 'bot', id: '栗子' };
  const quote = { seq: 5, text: '原话', thread: 'T1' };
  p.app.sel = other;
  p.list.enter(other);
  assert.equal(p.list.giveBack(cat, '没发出去的', quote), true);
  assert.deepEqual(plain(p.list.draft(cat)), { text: '没发出去的', quote });
  assert.equal(p.list.giveBack(cat, '另一条', quote), false, 'a draft already there stays');
  // Back in the chat before the answer: an empty composer takes the words; the quote waits for a read.
  p.list.leave(other);
  p.app.sel = cat;
  p.list.enter(cat);
  p.composer.text = '';
  assert.equal(p.list.giveBack(cat, '又没发出去', quote), true);
  assert.equal(p.composer.text, '又没发出去');
  p.list.read(cat, 'T1');
  assert.deepEqual(plain(p.composer.quote), quote);
  p.composer.text = '新写的';
  assert.equal(p.list.giveBack(cat, '旧的', quote), false);
  assert.equal(p.composer.text, '新写的');
});

test('when the status cannot be read, one quiet line over the list says it shows the last read until a read succeeds', () => {
  const p = page();
  p.list.stale(false);
  assert.equal(p.doc.querySelector('.cl-stale'), null, 'nothing until a read fails');
  p.list.stale(true);
  const line = p.doc.querySelector('.cl-stale')!;
  assert.equal(text(line), '状态没能刷新，列表可能不是最新的。');
  assert.equal(line.getAttribute('role'), 'status');
  assert.ok(line.nextSibling === p.roster, 'right above the list (the list redraws without touching it)');
  p.build(['团子']);
  p.list.stale(true);
  assert.equal(p.doc.querySelectorAll('.cl-stale').length, 1);
  p.list.stale(false);
  assert.equal(line.hidden, true);
});

// ---------------------------------------------------------------- app.js
test('the shell reads the sidebar lines from the status poll only: no transcript warm-up, previews from chat-list.js, recency instead of busy-first, the title through it, drafts around opening a chat, and the greeting fixed', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/chat-list.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const pos = (name: string) => scripts.indexOf(name);
  assert.ok(pos('chat-list-rules.js') > pos('quick-create.js') && pos('chat-list-rules.js') < pos('chat-list.js') && pos('chat-list.js') < pos('app.js'));
  // No background transcript reads for previews.
  assert.doesNotMatch(app, /warmOne|previewFromMessages|previewFromGroup|state\.preview|previewAt/);
  assert.match(app, /const said = !\(st && st\.todo\) && chatList\.preview\("bot", name\);/);
  assert.match(app, /const said = chatList\.preview\("group", g\.id\);/);
  // The old busy-first sort is gone: the rows are ordered by chat-list.js.
  const sort = /\n {2}function sortStatusRows\(\) \{\n([\s\S]*?)\n {2}\}\n/.exec(app)![1];
  assert.match(sort, /chatList\.paint\(\$\("roster"\)\);/);
  assert.doesNotMatch(sort, /running|awaiting/);
  assert.doesNotMatch(app, /document\.title = /, 'every title goes through chatList.title (with the unread total)');
  assert.equal((app.match(/chatList\.title\(/g) || []).length, 2);
  for (const fn of ['selectBot', 'selectGroup']) {
    const body = new RegExp(`\\n {2}async function ${fn}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n {2}\\}\\n`).exec(app)![1];
    assert.ok(body.indexOf('chatList.leave(state.sel);') < body.indexOf('clearQuote();'), fn + ': the quote is taken along before it is cleared');
    assert.ok(body.indexOf('resetConversation();') < body.indexOf('chatList.enter(state.sel);'), fn);
  }
  // 晚上好，你。 and 有 N 个 Bot 在忙 are gone.
  assert.match(app, /const who = listRules\.greetName\(state\.ownerName\);/);
  assert.match(app, /" 只猫猫"/);
  assert.doesNotMatch(app, /个 Bot"\), el\("span", "g", " 在忙/);
  // Review fixes: a failed status read is said (and cleared by the next one); quotes carry
  // their conversation and are checked on each read; drafts by native ID; a deleted cat's draft goes.
  assert.match(app, /try \{ data = await api\("\/xbot-api\/bots\/status"\); \} catch \(e\) \{ chatList\.stale\(true\); throw e; \}\n\s+chatList\.stale\(false\);/);
  assert.match(app, /state\.replyTo = \{ seq: n, text: String\(text \|\| ""\)\.trim\(\), thread: workspace\.threadId\(\) \|\| "" \};/);
  assert.match(app, /state\.chatRead = read;\n[^\n]*\n\s+chatList\.read\(selection, read\.threadId\);/);
  assert.match(app, /catId: \(name\) => botCatId\(name\),/);
  assert.match(app, /method: "DELETE" \}\);\n\s+chatList\.forget\(\{ type: "bot", id: name \}\);/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});

// app.js's own sendText, with what it calls faked: the quote leaves the
// composer when the send is dispatched, and comes back only if it did not go out.
function sendHarness() {
  const app = read('client/public/app.js');
  const m = /\n {2}async function sendText\([^)]*\) \{\n[\s\S]*?\n {2}\}\n/.exec(app);
  assert.ok(m, 'sendText is where the shell keeps it');
  const out: Any = {};
  const composer = { text: '' };
  const state: Any = { sel: { type: 'bot', id: '团子' }, replyTo: null, pendingSends: [], replyErrors: [], streaming: 0, threadLoad: 0, sig: '' };
  const calls: Any[] = [], givenBack: Any[] = [];
  let answer: Any = null;
  const marker = () => ({ className: '', isConnected: true, replaceChildren() {}, remove() {} });
  const sandbox: Any = {
    out, state, document: { createTextNode: (t: string) => t }, JSON, Date, Math, setTimeout: () => 0,
    sessionStorage: { setItem() {} }, authenticated: true, input: {}, thread: { querySelector: () => null },
    requestKey: () => 'k1', ownerSends: () => 0, announceSend() {}, botCatId: () => 'c1', setStatus() {}, zhError: (x: string) => x,
    el: () => ({ append() {}, addEventListener() {} }), errorDetails() {}, composerCaretTo() {}, composerRefreshHeight() {}, syncComposer() {},
    composerText: () => composer.text, composerSet: (t: string) => { composer.text = t; },
    optimisticMessage: () => { const mk = marker(); return { dataset: {}, classList: { remove() {} }, querySelector: (sel: string) => (sel === '.send-state' ? mk : null) }; },
    live: { expect: () => ({ accept() {}, drop() {} }) },
    liveRules: { receipt: () => ({ userMessageId: 'u1' }) },
    workspace: { threadId: () => 'T1', giveBack: () => false },
    clearQuote: () => { state.replyTo = null; }, paintQuoteBar() {},
    chatList: { giveBack: (...a: Any[]) => givenBack.push(a) },
    loadThread: async () => {},
    apiFetch: (path: string, opt: Any) => { calls.push({ path, body: JSON.parse(opt.body) }); return new Promise((resolve) => { answer = resolve; }); },
  };
  vm.runInNewContext(m![0] + 'out.sendText = sendText;', sandbox);
  return { send: out.sendText, state, composer, calls, givenBack, respond: (r: Any) => answer(r) };
}
const accepted = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ userMessageId: 'u1' }), text: async () => '' });
const refused = () => ({ ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ error: '不行' }), text: async () => '' });

test('a quoted send takes its quote along at once: switching chats before the answer leaves no quote behind; a send that does not go out brings the quote back to its own chat (composer or draft), never onto newer words', async () => {
  const quote = { seq: 5, text: '原话', thread: 'T1' };
  // Accepted after the owner moved to another chat.
  let h = sendHarness();
  h.state.replyTo = quote;
  let done = h.send('好的', null, [], null);
  assert.equal(h.state.replyTo, null, 'gone from the composer when sent, so leaving the chat cannot keep it as a draft');
  assert.equal(h.calls[0].body.reply_to, 5);
  assert.equal(h.calls[0].body.expectedThreadId, 'T1');
  h.state.sel = { type: 'bot', id: '栗子' };
  h.respond(accepted());
  await done;
  assert.deepEqual(h.givenBack, [], 'it went out: nothing comes back anywhere');
  // Refused while still here, the composer empty: words and quote come back.
  h = sendHarness();
  h.state.replyTo = quote;
  done = h.send('好的', null, [], null);
  h.respond(refused());
  await done;
  assert.equal(h.composer.text, '好的');
  assert.deepEqual(plain(h.state.replyTo), quote);
  // Refused while newer words are already in the composer: the quote does not land on them.
  h = sendHarness();
  h.state.replyTo = quote;
  done = h.send('好的', null, [], null);
  h.composer.text = '另一句';
  h.respond(refused());
  await done;
  assert.equal(h.state.replyTo, null);
  // Refused after the owner left: words and quote go back to that chat's draft.
  h = sendHarness();
  h.state.replyTo = quote;
  const from = h.state.sel;
  done = h.send('好的', null, [], null);
  h.state.sel = { type: 'bot', id: '栗子' };
  h.respond(refused());
  await done;
  assert.equal(h.givenBack.length, 1);
  assert.ok(h.givenBack[0][0] === from);
  assert.deepEqual(plain(h.givenBack[0].slice(1)), ['好的', quote]);
  // A quote from another conversation is never sent as one.
  h = sendHarness();
  h.state.replyTo = { seq: 5, text: '原话', thread: 'T0' };
  h.send('好的', null, [], null);
  assert.equal('reply_to' in h.calls[0].body, false);
});

test('the greeting counts a cat as busy only while it works or waits in line, never while it waits for the owner', () => {
  const app = read('client/public/app.js');
  const m = /\n {2}function paintGreeting\(\) \{\n[\s\S]*?\n {2}\}\n/.exec(app);
  assert.ok(m, 'paintGreeting is where the shell keeps it');
  const doc = new Doc();
  const host = doc.createElement('div');
  host.id = 'greeting';
  doc.body.append(host);
  const el = (tag: string, cls?: string, t?: string) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (t != null) e.textContent = t; return e; };
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-list-rules.js'), { window });
  const stStatus: Any = { map: {} };
  const out: Any = {};
  vm.runInNewContext(m[0] + 'out.paint = paintGreeting;', {
    out, stStatus, state: { ownerName: '你' }, document: doc, Date, JSON,
    $: (id: string) => doc.getElementById(id), el, listRules: window.ClowderListRules,
    avatar: () => el('span', 'avatar'), paintOf: () => null,
  });
  stStatus.map = { 团子: { bot: '团子', state: 'awaiting' }, 栗子: { bot: '栗子', state: 'idle' } };
  out.paint();
  assert.doesNotMatch(text(host), /在忙/, 'waiting for the owner\'s confirmation is not busy');
  stStatus.map = { 团子: { bot: '团子', state: 'awaiting' }, 栗子: { bot: '栗子', state: 'running' }, 年糕: { bot: '年糕', state: 'queued' } };
  out.paint();
  assert.match(text(host), /有\s+2 只猫猫 在忙。$/, 'working and queued count; the waiting one does not');
});
