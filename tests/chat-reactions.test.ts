import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El, text } from './fake-dom.js';

// 回复与表情回应 (item 49; docs/chat-experience-api.md 「回复与表情回应」).
// The rules (chat-reactions-rules.js) run in a bare VM; the module
// (chat-reactions.js) runs as the classic script it is on the small DOM of
// tests/fake-dom.ts, with the shell's hooks faked the way app.js passes them
// (the real send receipt reader from chat-live-rules.js). The pieces of the
// other modules that learned about reactions (a row found by a reaction's
// ID or number, the seen paw, follows, the newest page's IDs, earlier pages
// asked with reactions=1, the shell's own liveRows / lineBySeq / previewText)
// are checked against their own files.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function load(...files: string[]) {
  const window: Any = {};
  const context = vm.createContext({ window });
  for (const f of files) vm.runInContext(read('client/public/' + f), context);
  return window;
}
const rules = () => load('chat-reactions-rules.js').ClowderReactionRules;

// Rows as the server gives them (single chat), with the native record's speaker.
const owner = (id: string, seq: number, more: Any = {}) => ({ id, native_message_id: id, seq, role: 'user', content: 'x', time: `2026-11-13T10:00:${String(seq).padStart(2, '0')}Z`, native: { type: 'user', id }, ...more });
const cat = (id: string, seq: number, more: Any = {}, catId = 'c1') => ({ id, native_message_id: id, seq, role: 'assistant', content: '要我现在开始吗？', native_cat_id: catId,
  presentation_kind: 'message', time: `2026-11-13T10:00:${String(seq).padStart(2, '0')}Z`, native: { type: 'assistant', id, catId, lifecycle: { status: 'completed' } }, ...more });
const mark = (id: string, emoji: string, seq: number, who: Any = { mine: true }) => ({ id, emoji, seq, time: `2026-11-13T10:01:${String(seq).padStart(2, '0')}Z`, ...who });
const by = (name: string, cat = 'c1') => ({ mine: false, name, native_cat_id: cat });

// ---------------------------------------------------------------- the rules
test('what a row offers: 回复 on any finished numbered bubble; 表情 only on a cat\'s own words, on the newest page, from a cat still in the group', () => {
  const R = rules();
  assert.deepEqual([...R.EMOJIS], ['👍', '❤️', '🎉', '👀', '🐾']);
  const c = cat('m1', 3), o = owner('u1', 1);
  assert.equal(R.canReply(c, false), true);
  assert.equal(R.canReply(o, false), true);
  assert.equal(R.canReply(c, true), false, 'not in the two-cat exchange');
  for (const m of [{ ...c, seq: 0 }, { ...c, in_progress: true }, { ...c, notice: true }, { ...c, presentation_kind: 'activity' }]) assert.equal(R.canReply(m, false), false);
  assert.equal(R.canReact(c, {}), true);
  assert.equal(R.canReact(o, {}), false, 'never on the owner\'s own words');
  for (const m of [{ ...c, in_progress: true }, { ...c, notice: true }, { ...c, reminder: true }, { ...c, presentation_kind: 'activity' }, { ...c, seq: 0 },
    { ...c, native: { type: 'connector', id: 'm1' } }, { ...c, native: { type: 'assistant', id: 'm1' } }]) assert.equal(R.canReact(m, {}), false, JSON.stringify(m).slice(0, 80));
  // An ended reply: only when it has words (its stand-in 「这次没完成」 is nothing to react to) or carries something.
  assert.equal(R.canReact({ ...c, ended: { how: 'failed' } }, { said: '' }), false);
  assert.equal(R.canReact({ ...c, ended: { how: 'stopped' } }, { said: '写到一半' }), true);
  assert.equal(R.canReact({ ...c, ended: { how: 'failed' }, attachments: [{ id: 'f' }] }, { said: '' }), true);
  // The newest page only: a reaction to an older page's row would come back as a line of its own.
  assert.equal(R.canReact(c, { latest: new Set(['m1']) }), true);
  assert.equal(R.canReact(c, { latest: new Set(['other']) }), false);
  // A group: a cat that left gets no 表情 (sending to it is refused, reply_cat_left); 回复 stays.
  const g = { id: 'm1', seq: 3, kind: 'bot', sender: '团子', text: '好', native_cat_id: 'c1', presentation_kind: 'message', native: { type: 'assistant', id: 'm1', catId: 'c1' } };
  assert.equal(R.canReact(g, { members: ['团子', '栗子'] }), true);
  assert.equal(R.canReact(g, { members: ['c1'] }), true, 'a member the list does not know is named by its ID');
  assert.equal(R.canReact(g, { members: ['栗子'], name: () => '团子' }), false);
  assert.equal(R.canReply(g, false), true);
  assert.equal(R.canReact(g, { peer: true }), false);
});

test('chips: one per emoji in the order each first came, a count from two, the owner\'s marked (and quieter while on its way), and who — 你 first, then the cats by name', () => {
  const R = rules();
  const m = cat('m1', 3, { reactions: [mark('r1', '👍', 4), mark('r2', '🐾', 5, by('团子', 'c1')), mark('r3', '👍', 6, by('栗子', 'c2')), mark('x', '', 7), null] });
  const list = R.marks(m);
  assert.deepEqual(list.map((r: Any) => r.id), ['r1', 'r2', 'r3'], 'malformed marks are left out');
  const name = (id: string) => ({ c1: '团子', c2: '栗子' } as Any)[id] || '';
  const chips = plain(R.chips(list, [{ emoji: '🎉' }], name));
  assert.deepEqual(chips.map((g: Any) => [g.emoji, g.count, g.mine, g.sending, g.who]), [
    ['👍', 2, true, false, '你、栗子'], ['🐾', 1, false, false, '团子'], ['🎉', 1, true, true, '你（发送中）'],
  ]);
  // Two marks of the same cat with the same emoji count twice but name it once; a renamed cat goes by its current name.
  const twice = R.chips(R.marks({ reactions: [mark('a', '🐾', 1, by('旧名', 'c1')), mark('b', '🐾', 2, by('旧名', 'c1'))] }), [], name);
  assert.equal(twice[0].count, 2);
  assert.equal(twice[0].who, '团子');
  // On its way, an emoji already sent never counts twice.
  assert.equal(R.chips(list, [{ emoji: '👍' }], name)[0].count, 2);
  // Review 1, item 5: joining a cat's chip, the owner's part is still on its way — the chip is
  // pending as a whole (its count and its 你 are not settled), and says so to a screen reader.
  const joined = R.chips(list, [{ emoji: '🐾' }], name)[1];
  assert.deepEqual([joined.count, joined.mine, joined.sending, joined.who], [2, true, true, '你（发送中）、团子']);
  // What the owner gave this row: sent (the record has it) or still on its way.
  assert.deepEqual(plain([...R.given(list, [{ emoji: '🎉' }])]), [['🎉', 'sending'], ['👍', 'sent']]);
  assert.deepEqual(plain(R.carried(list)), { ids: 'r1 r2 r3', seqs: '4 5 6' });
  assert.notEqual(R.chipSig(chips[0]), R.chipSig({ ...chips[0], count: 3 }));
});

test('an own reaction on its way has landed once the record has its message (the receipt\'s userMessageId): among a row\'s reactions, or as a row of its own; nothing else stands in for it', () => {
  const R = rules();
  const rows = [cat('m1', 3, { reactions: [mark('r1', '👍', 4)] }), owner('r9', 9)];
  assert.equal(R.settled({ id: 'r1', emoji: '👍', mid: 'm1', state: 'sent' }, rows), true);
  assert.equal(R.settled({ id: 'r9', emoji: '👍', mid: 'm1', state: 'sent' }, rows), true, 'the row it quoted was not on the newest page: an ordinary line now');
  assert.equal(R.settled({ id: 'r2', emoji: '❤️', mid: 'm1', state: 'sent' }, rows), false);
  assert.equal(R.settled({ id: '', emoji: '👍', mid: 'm1', state: 'sent' }, rows), false, 'without an ID nothing is matched by look-alike (a send is taken only with one)');
});

test('the read position (review 1, items 2–4): when the newest reply is a cat\'s reaction, the newest reply that is a row of its own must be seen too — by the history\'s order, never by times or counts; an ordinary newest reply asks nothing more', () => {
  const R = rules();
  // A (cat), 谢谢 (u, carrying the cat's 🐾 rx), B (cat), C (cat): C is the newest row of a cat's.
  const rows = [cat('A', 1), owner('u', 2, { reactions: [mark('rx', '🐾', 6, by('团子'))] }), cat('B', 3), cat('C', 4)];
  assert.deepEqual(plain(R.readFirst(rows, 'rx')), ['C']);
  assert.deepEqual(plain(R.readFirst(rows, 'C')), [], 'an ordinary newest reply confirms as before');
  assert.deepEqual(plain(R.readFirst(rows, 'unknown')), []);
  // The history's order decides, whatever the times say (here C claims to be the oldest).
  const skewed = rows.map((m: Any) => ({ ...m, time: m.id === 'C' ? '2020-01-01T00:00:00Z' : m.time }));
  assert.deepEqual(plain(R.readFirst(skewed, 'rx')), ['C']);
  // Rows the server does not count as a reply do not count here either: one being written, one stopped, a bare
  // SILENT, a notice, the owner's own.
  const tail = [...rows, cat('w', 7, { in_progress: true }), cat('s', 8, { ended: { how: 'stopped' }, content: '写到一半' }), cat('q', 9, { content: 'SILENT' }),
    cat('n', 10, { notice: true }), owner('o', 11)];
  assert.deepEqual(plain(R.readFirst(tail, 'rx')), ['C']);
  // Review 2, item 12: a failed or interrupted reply is a row the server counts (its 「这次没完成」 is its text), so it
  // is the newest row of a cat's when it comes last — a reaction above must not confirm it unseen.
  assert.deepEqual(plain(R.readFirst([...rows, cat('F', 7, { ended: { how: 'failed' }, content: '这次没完成' })], 'rx')), ['F']);
  assert.deepEqual(plain(R.readFirst([...rows, cat('I', 7, { ended: { how: 'interrupted' }, content: '中途被打断' })], 'rx')), ['I']);
  assert.deepEqual(plain(R.readFirst([...rows, cat('P', 7, { ended: { how: 'failed' }, content: '写到一半' })], 'rx')), ['P']);
  // Files or cards with no words count; nothing at all does not.
  assert.deepEqual(plain(R.readFirst([...rows, cat('f', 7, { content: '', attachments: [{ id: 'x' }] })], 'rx')), ['f']);
  assert.deepEqual(plain(R.readFirst([...rows, cat('e', 7, { content: '' })], 'rx')), ['C']);
  // No row of a cat's at all: the reaction's own row decides alone.
  assert.deepEqual(plain(R.readFirst([owner('u', 1, { reactions: [mark('rx', '🐾', 2, by('团子'))] })], 'rx')), []);
  // The host is a cat's own row (the cat answered the owner's 👍 with 🐾 on it): that row is the newest one.
  assert.deepEqual(plain(R.readFirst([cat('m', 1, { reactions: [mark('x', '👍', 2), mark('rx', '🐾', 3, by('团子'))] })], 'rx')), ['m']);
  // The owner's own reaction is never a reply to confirm.
  assert.deepEqual(plain(R.readFirst(rows.concat([cat('D', 5, { reactions: [mark('mine', '👍', 7)] })]), 'mine')), []);
});

test('sending is one ordinary message: the emoji as its words, quoting the row\'s number, in this conversation, with its own key; a refusal says why, an unknown outcome says it is not known', () => {
  const R = rules();
  assert.deepEqual(plain(R.request('👍', 7, 'T1', 'k1')), { text: '👍', reply_to: 7, idempotencyKey: 'k1', expectedThreadId: 'T1' });
  assert.deepEqual(plain(R.request('👍', 7, '', 'k1')), { text: '👍', reply_to: 7, idempotencyKey: 'k1' });
  assert.deepEqual(plain(R.failure(409, '会话已变化。')), { unknown: false, reason: '会话已变化', whole: false });
  assert.deepEqual(plain(R.failure(400, 'bad request')), { unknown: false, reason: '', whole: false });
  assert.deepEqual(plain(R.failure(0, '连不上 clowder-bot')), { unknown: true, reason: '', whole: false });
  assert.deepEqual(plain(R.failure(503, 'x')), { unknown: true, reason: '', whole: false });
  assert.equal(R.failWords('👍', R.failure(409, '会话已变化。'), ''), '👍 没发出去：会话已变化');
  // A cat that left the group: the server's sentence says it all.
  assert.equal(R.failWords('👍', R.failure(409, '团子已经不在这个群里，这句话没有发出去。', 'reply_cat_left'), ''), '团子已经不在这个群里，这句话没有发出去');
  assert.equal(R.failWords('❤️', R.failure(400, 'x'), '团子'), '给团子的 ❤️ 没发出去');
  assert.equal(R.failWords('🐾', R.failure(0, ''), ''), '没能确认 🐾 发出去没有');
  assert.equal(R.failWords('🐾', R.failure(502, ''), '读书会'), '没能确认给读书会的 🐾 发出去没有');
});

// ---------------------------------------------------------------- the page
const proto = El.prototype as Any;
proto.animate = function animate(this: Any, frames: Any[]) { (this.motions ||= []).push(frames); return { cancel() {}, finished: Promise.resolve() }; };
proto.getBoundingClientRect = function rect(this: Any) { return this.box || { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

function page(opts: Any = {}) {
  const doc = new Doc();
  (doc as Any).documentElement = doc.root;
  const h = (tag: string, cls = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const thread = h('div', 'thread');
  thread.id = 'thread';
  doc.body.append(thread);
  let frames: Array<() => void> = [];
  const window: Any = {
    matchMedia: () => ({ matches: !!opts.reduce }),
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
    innerWidth: 1440,
    listeners: {} as Record<string, () => void>,
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; },
  };
  const context = vm.createContext({ window, document: doc, console, Promise, setTimeout, clearTimeout });
  for (const f of ['chat-live-rules.js', 'chat-reactions-rules.js', 'chat-reactions.js']) vm.runInContext(read('client/public/' + f), context);
  const state: Any = { sel: opts.group ? { type: 'group', id: 'g1' } : { type: 'bot', id: '团子' }, thread: 'T1', latest: null };
  const menus = new Map<El, Any>();
  const log: Any = { calls: [], notes: [], reloads: 0, replies: [], expects: [], accepted: [], dropped: 0 };
  let n = 0;
  const answers: Array<(body: Any) => Any> = [];
  const X = window.ClowderReactions;
  X.init({
    thread,
    selected: () => state.sel, peer: () => false, threadId: () => state.thread,
    messageOf: (row: El) => menus.get(row) || null,
    reply: (m: Any) => log.replies.push(m.seq),
    catName: (id: string) => ({ c1: '团子', c2: '栗子' } as Any)[id] || '',
    chatName: (sel: Any) => sel.id,
    latest: () => state.latest,
    fetch: async (path: string, opt: Any) => {
      const body = JSON.parse(opt.body);
      log.calls.push({ path, body });
      const next = answers.shift();
      const a = next ? await next(body) : { status: 202, json: { userMessageId: 'new-' + log.calls.length } };
      if (a.throws) { const e: Any = new Error(a.throws); e.status = a.status; throw e; }
      return { ok: a.status < 300, status: a.status, headers: { get: () => (a.sse != null ? 'text/event-stream' : 'application/json') },
        json: async () => { if (a.broken) throw new Error('body aborted'); return a.json || {}; },
        text: async () => { if (a.broken) throw new Error('body aborted'); return a.sse || ''; } };
    },
    receipt: window.ClowderLiveRules.receipt,
    requestKey: () => 'key-' + (++n),
    expect: (catId: string) => { log.expects.push(catId); return { accept: (id: string) => log.accepted.push(id), drop: () => { log.dropped++; } }; },
    reload: () => { log.reloads++; },
    note: (t: string) => log.notes.push(t),
    setTip: (node: El, t: string) => { node.dataset.tip = t; },
  });
  // The history as app.js draws it: a row per message with its menu, keyed by native ID.
  let inner: El | null = null;
  const draw = (messages: Any[], fresh = false) => {
    if (!inner || fresh) { inner = h('div', 'thread-inner'); inner.dataset.chat = (state.sel.type === 'group' ? 'group:' : 'bot:') + state.sel.id; thread.replaceChildren(inner); }
    const keep = new Map(inner.children.filter((r) => r.dataset.mid).map((r) => [r.dataset.mid, r]));
    const rows: El[] = [];
    for (const m of messages) {
      const id = m.native_message_id || m.id;
      let row = keep.get(id);
      if (!row || opts.redrawAll) {
        const mine = m.role === 'user' || m.kind === 'person';
        row = h('div', 'msg ' + (mine ? 'user' : 'bot') + (m.in_progress ? ' live' : ''));
        row.dataset.mid = id;
        if (m.seq) row.dataset.seq = String(m.seq);
        const col = h('div', mine ? 'bubble-col' : 'body');
        const bubble = h('div', mine ? 'bubble' : 'prose bot-bubble');
        bubble.textContent = m.content || m.text || '';
        col.append(bubble, h('span', 'ht'));
        row.append(col);
        if (!m.in_progress && !m.notice) menus.set(row, { message: m, text: m.content || m.text || '' });
      }
      rows.push(row);
    }
    inner.replaceChildren(...rows);
    X.rendered(messages, opts.group ? { members: state.members || ['团子', '栗子'] } : null);
  };
  const flush = () => { const list = frames; frames = []; list.forEach((fn) => fn()); };
  const row = (mid: string) => inner!.children.find((r) => r.dataset.mid === mid)!;
  const chips = (mid: string) => row(mid).querySelectorAll('.rx-chip');
  return { doc, window, thread, X, state, log, answers, draw, flush, row, chips, get inner() { return inner!; } };
}
const reacted = (base: Any, ...marks: Any[]) => ({ ...base, reactions: marks });

test('the hover buttons: 表情 and 回复 beside a cat\'s words, 回复 alone beside the owner\'s, none for a reply being written or a notice; named for a screen reader, the same element after a redraw', () => {
  const p = page();
  const msgs = [owner('u1', 1), cat('m1', 3), cat('w', 5, { in_progress: true }), cat('n', 6, { notice: true })];
  p.draw(msgs);
  const acts = (mid: string) => p.row(mid).querySelector('.rx-acts');
  assert.deepEqual(acts('m1')!.children.map((b: El) => b.getAttribute('aria-label')), ['回个表情', '回复']);
  assert.equal(acts('m1')!.dataset.n, '2');
  assert.deepEqual(acts('u1')!.children.map((b: El) => b.getAttribute('aria-label')), ['回复']);
  assert.equal(acts('w'), null);
  assert.equal(acts('n'), null);
  assert.equal(acts('m1')!.children[0]!.getAttribute('aria-haspopup'), 'menu');
  assert.equal(acts('m1')!.children[0]!.dataset.tip, '表情');
  const before = acts('m1');
  p.draw(msgs);
  assert.equal(acts('m1'), before, 'a redraw keeps it');
  // 回复 quotes the message as it now is (armQuote in app.js).
  acts('m1')!.children[1]!.click();
  assert.deepEqual(p.log.replies, [3]);
  // A row that falls off the newest page keeps 回复 only.
  p.state.latest = new Set(['u1']);
  p.draw(msgs);
  assert.deepEqual(acts('m1')!.children.map((b: El) => b.getAttribute('aria-label')), ['回复']);
});

test('chips sit right under the bubble, one per emoji, the owner\'s marked; the row carries the reactions\' IDs and numbers; they come in once — never on the first drawing, never again on a redraw', () => {
  const p = page();
  const m1 = reacted(cat('m1', 3), mark('r1', '👍', 4), mark('r2', '🐾', 5, by('团子')));
  p.draw([owner('u1', 1), m1]);
  const box = p.row('m1').querySelector('.rx-chips')!;
  const col = p.row('m1').children[0]!;
  assert.equal(col.children.indexOf(box), col.children.findIndex((c: El) => c.classList.contains('bot-bubble')) + 1, 'right after the bubble');
  assert.deepEqual(p.chips('m1').map((c: El) => [text(c), c.getAttribute('aria-label'), c.dataset.tip, c.classList.contains('rx-mine')]), [
    ['👍', '👍 你', '你', true], ['🐾', '🐾 团子', '团子', false],
  ]);
  assert.equal(p.row('m1').dataset.rx, 'r1 r2');
  assert.equal(p.row('m1').dataset.rxs, '4 5');
  p.flush();
  assert.equal(p.chips('m1').filter((c: El) => c.motions).length, 0, 'the first drawing brings nothing in');
  // Another cat answers with the same emoji: a count, the same chip, a small bump once.
  const first = p.chips('m1')[1];
  p.draw([owner('u1', 1), reacted(m1, mark('r1', '👍', 4), mark('r2', '🐾', 5, by('团子')), mark('r3', '🐾', 7, by('栗子', 'c2')))]);
  p.flush();
  assert.equal(p.chips('m1')[1], first);
  assert.equal(text(first), '🐾2');
  assert.equal(first.getAttribute('aria-label'), '🐾 团子、栗子');
  assert.equal(first.motions.length, 1);
  p.draw([owner('u1', 1), reacted(m1, mark('r1', '👍', 4), mark('r2', '🐾', 5, by('团子')), mark('r3', '🐾', 7, by('栗子', 'c2')))]);
  p.flush();
  assert.equal(first.motions.length, 1, 'later polls do not move it again');
  // A row drawn anew (it changed for another reason) gets its chips back, without motion.
  const q = page({ redrawAll: true });
  q.draw([m1]); q.flush();
  q.draw([m1]); q.flush();
  assert.equal(q.chips('m1').filter((c: El) => c.motions).length, 0);
  assert.equal(q.chips('m1').length, 2);
  // No reactions any more (another conversation): the chips and the IDs go.
  p.draw([owner('u1', 1), cat('m1', 3)]);
  assert.equal(p.row('m1').querySelector('.rx-chips'), null);
  assert.equal(p.row('m1').dataset.rx, undefined);
});

// The transition with the real chat-live.js (review 1: no stand-in removes the reply's row): the shell's own
// liveRows, live.read, live.frame for rows being written and live.commit, as loadThread and renderMessages do.
function livePage(opts: Any = {}) {
  const doc = new Doc();
  (doc as Any).documentElement = doc.root;
  const h = (tag: string, cls = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const chat = h('div', 'chat'), thread = h('div', 'thread'), dock = h('div', 'dock');
  thread.id = 'thread';
  chat.append(thread, dock);
  doc.body.append(chat);
  Object.assign(thread, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
  thread.box = { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 };
  let frames: Array<() => void> = [];
  const window: Any = { matchMedia: () => ({ matches: !!opts.reduce }), requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; }, innerWidth: 1440 };
  const context = vm.createContext({ window, document: doc, console, Promise, Date, setTimeout, clearTimeout, setInterval: () => 0 });
  for (const f of ['chat-live-rules.js', 'chat-live.js', 'chat-reactions-rules.js', 'chat-reactions.js']) vm.runInContext(read('client/public/' + f), context);
  const app = read('client/public/app.js');
  const out: Any = {};
  vm.runInNewContext(/\n {2}function liveRows\([^)]*\) \{\n[\s\S]*?\n {2}\}\n/.exec(app)![0] + 'out.liveRows = liveRows;', {
    out, presentation: { isActivity: (m: Any) => m.presentation_kind === 'activity' }, sayText: (m: Any) => m.content,
  });
  const live = window.ClowderLive, X = window.ClowderReactions;
  const rowFrame = (catId: string, time: string) => {
    const row = h('div', 'msg bot live' + (catId ? ' with-face' : ' cont'));
    row.dataset.time = time;
    const body = h('div', 'body');
    body.append(h('span', 'ht'));
    row.append(body);
    return row;
  };
  live.init({
    thread, row: rowFrame,
    render: (parent: El, words: string) => { const q = h('p'); q.textContent = words; parent.append(q); },
    queued: () => false, busy: () => false, unread: () => '', changed() {}, gap() {}, catName: () => '团子',
  });
  live.select('bot:团子');
  const menus = new Map<El, Any>();
  X.init({
    thread, selected: () => ({ type: 'bot', id: '团子' }), peer: () => false, threadId: () => 'T1',
    messageOf: (row: El) => menus.get(row) || null, reply() {}, catName: () => '团子', chatName: () => '团子', latest: () => null,
    fetch: async () => { throw new Error('not here'); }, receipt: window.ClowderLiveRules.receipt, requestKey: () => 'k', expect: (c: string) => live.expect(c),
    reload() {}, note() {}, setTip() {},
  });
  // renderMessages in miniature: rows being written through live.frame, every other row drawn; the keyed commit.
  const draw = (messages: Any[]) => {
    const next = h('div', 'thread-inner');
    next.dataset.chat = 'bot:团子';
    for (const m of messages) {
      const id = m.native_message_id || m.id;
      if (m.in_progress) { const row = rowFrame('c1', m.time); row.dataset.mid = id; next.append(live.frame(row)); continue; }
      const mine = m.role === 'user';
      const row = h('div', 'msg ' + (mine ? 'user' : 'bot'));
      row.dataset.mid = id;
      if (m.seq) row.dataset.seq = String(m.seq);
      const col = h('div', mine ? 'bubble-col' : 'body'), bubble = h('div', mine ? 'bubble' : 'prose bot-bubble');
      bubble.textContent = m.content || '';
      col.append(bubble, h('span', 'ht'));
      row.append(col);
      menus.set(row, { message: m, text: m.content || '' });
      next.append(row);
    }
    const shown = live.commit(next, []);
    X.rendered(messages, null);
    live.rendered(shown);
  };
  // loadThread in miniature: where a reply that became a reaction was written, then the replies, then the drawing.
  let at = 1;
  const readChat = (messages: Any[]) => { X.before(messages); live.read(out.liveRows(messages, false), Date.now() + (at++)); draw(messages); };
  const flush = () => { const list = frames; frames = []; list.forEach((fn) => fn()); };
  const inner = () => thread.children[0]!;
  return { live, X, thread, draw, read: readChat, flush, inner, rows: () => inner().children.filter((r: El) => r.classList.contains('msg')) };
}

test('a cat\'s whole answer that was one emoji (real chat-live.js): the typing bubble it took and its words go in the drawing that puts the chip on the owner\'s row — nothing left behind — and the chip comes down from where it was written, once', async () => {
  for (const reduce of [false, true]) {
    const p = livePage({ reduce });
    p.read([owner('u1', 1, { content: '谢谢' })]);
    // The owner's send: its typing bubble, taken by the reply when it starts.
    const wait = p.live.expect('c1');
    wait.accept('u1');
    p.live.event({ kind: 'start', messageId: 'w', catId: 'c1' });
    p.live.event({ kind: 'text', messageId: 'w', catId: 'c1', text: '🐾', end: 2 });
    p.flush();
    const writing = p.rows().find((r: El) => r.dataset.mid === 'w')!;
    assert.ok(writing && writing.querySelector('.lv-text'), 'written in its typing bubble');
    writing.querySelector('.lv-text')!.box = { left: 60, top: 500, right: 120, bottom: 540, width: 60, height: 40 };
    p.live.event({ kind: 'done', messageId: 'w', catId: 'c1' });
    // The read after it: the reply is drawn on 谢谢 now.
    p.read([reacted(owner('u1', 1, { content: '谢谢' }), { ...mark('w', '🐾', 2, by('团子', 'c1')), reply_to_id: 'u1' })]);
    assert.deepEqual(p.rows().map((r: El) => r.dataset.mid || 'wait'), ['u1'], 'no leftover bubble or typing bubble');
    const chip = p.rows()[0]!.querySelector('.rx-chip')!;
    assert.ok(chip, 'the chip is on the owner\'s row');
    chip.box = { left: 900, top: 520, right: 926, bottom: 544, width: 26, height: 24 };
    p.flush();
    if (reduce) { assert.equal(chip.motions, undefined); continue; }
    assert.equal(chip.motions.length, 1);
    assert.match(String(chip.motions[0][0].transform), /^translate\(-823px, -12px\) scale\(1\.3\)$/);
    p.read([reacted(owner('u1', 1, { content: '谢谢' }), { ...mark('w', '🐾', 2, by('团子', 'c1')), reply_to_id: 'u1' })]);
    p.flush();
    assert.equal(chip.motions.length, 1, 'later polls do not move it again');
    // Its late events draw nothing again.
    p.live.event({ kind: 'text', messageId: 'w', catId: 'c1', text: '🐾', end: 2 });
    assert.deepEqual(p.rows().map((r: El) => r.dataset.mid || 'wait'), ['u1']);
  }
});

test('review 1, item 9 (real chat-live.js): a reply met mid-way (its start missed) that the first read already shows as a reaction takes the typing bubble of the send it answers with it', () => {
  const p = livePage();
  p.read([owner('u1', 1, { content: '晚安' })]);
  p.live.expect('c1').accept('u1');
  // No start: its words arrive and it gets a row of its own beside the waiting bubble.
  p.live.event({ kind: 'text', messageId: 'w', catId: 'c1', text: '🐾', end: 2 });
  assert.equal(p.rows().length, 3, 'the send, its typing bubble, the reply\'s own row');
  p.read([reacted(owner('u1', 1, { content: '晚安' }), { ...mark('w', '🐾', 2, by('团子', 'c1')), reply_to_id: 'u1' })]);
  assert.deepEqual(p.rows().map((r: El) => r.dataset.mid || (r.dataset.wait ? 'typing' : '?')), ['u1'], 'neither the reply nor the typing bubble stays');
  // The same for an ordinary reply met mid-way that is already finished at the first read.
  const q = livePage();
  q.read([owner('u1', 1, { content: '你好' })]);
  q.live.expect('c1').accept('u1');
  q.live.event({ kind: 'text', messageId: 'r', catId: 'c1', text: '收到', end: 2 });
  q.read([owner('u1', 1, { content: '你好' }), cat('r', 2, { content: '收到', native: { type: 'assistant', id: 'r', catId: 'c1', replyTo: 'u1', content: '收到', lifecycle: { status: 'completed' } } })]);
  assert.deepEqual(q.rows().map((r: El) => r.dataset.mid || (r.dataset.wait ? 'typing' : '?')), ['u1', 'r']);
});

test('reacting: the picker shows the five, the ones already sent chosen and inert; a pick is one POST of the emoji quoting the row, the chip shows at once, the composer is not touched, and it settles when the read has it', async () => {
  const p = page();
  const m1 = reacted(cat('m1', 3), mark('r0', '❤️', 4));
  p.draw([owner('u1', 1), m1]);
  const open = p.row('m1').querySelector('.rx-act-react')!;
  open.click();
  const picker = p.doc.body.querySelector('.rx-pick')!;
  assert.equal(picker.getAttribute('role'), 'menu');
  assert.equal(open.getAttribute('aria-expanded'), 'true');
  assert.ok(p.row('m1').classList.contains('rx-open'), 'the buttons stay while the picker is open');
  const items = picker.children;
  assert.deepEqual(items.map((b: El) => text(b)), ['👍', '❤️', '🎉', '👀', '🐾']);
  assert.deepEqual(items.map((b: El) => b.getAttribute('aria-disabled')), [null, 'true', null, null, null]);
  assert.equal(items[1]!.getAttribute('aria-label'), '❤️ 已回应');
  assert.equal(p.doc.activeElement, items[0], 'focus on the first one not sent');
  items[1]!.click();
  assert.equal(p.log.calls.length, 0, 'a sent one is not sent again (nor taken back)');
  items[0]!.click();
  assert.equal(p.doc.body.querySelector('.rx-pick'), null, 'the picker closes');
  assert.equal(open.getAttribute('aria-expanded'), 'false');
  const chip = p.chips('m1').find((c: El) => c.dataset.emoji === '👍')!;
  assert.ok(chip.classList.contains('rx-sending') && chip.classList.contains('rx-mine'), 'at once, quiet while on its way');
  assert.equal(chip.getAttribute('aria-label'), '👍 你（发送中）');
  p.flush();
  assert.equal(chip.motions.length, 1, 'pressed on once');
  await tick(); await tick();
  assert.deepEqual(p.log.calls, [{ path: '/xbot-api/bots/%E5%9B%A2%E5%AD%90/messages', body: { text: '👍', reply_to: 3, idempotencyKey: 'key-1', expectedThreadId: 'T1' } }]);
  assert.deepEqual(p.log.expects, ['c1'], 'the cat is woken by it: its typing bubble, as for a send');
  assert.deepEqual(p.log.accepted, ['new-1']);
  assert.equal(p.log.reloads, 1);
  // Still on its way until a read has it: the picker shows it chosen meanwhile, read as 发送中 (review 1, item 5).
  open.click();
  const onWay = p.doc.body.querySelector('.rx-pick')!.children[0]!;
  assert.equal(onWay.getAttribute('aria-disabled'), 'true');
  assert.equal(onWay.getAttribute('aria-label'), '👍 发送中');
  assert.ok(onWay.classList.contains('rx-pending'));
  p.X.close();
  // The read: the reaction is on the row by the receipt's ID. Same chip, settled, no second motion.
  p.draw([owner('u1', 1), reacted(m1, mark('r0', '❤️', 4), mark('new-1', '👍', 6))]);
  p.flush();
  const settled = p.chips('m1').find((c: El) => c.dataset.emoji === '👍')!;
  assert.equal(settled, chip);
  assert.equal(chip.classList.contains('rx-sending'), false);
  assert.equal(chip.getAttribute('aria-label'), '👍 你');
  assert.equal(chip.motions.length, 1);
  open.click();
  assert.equal(p.doc.body.querySelector('.rx-pick')!.children[0]!.getAttribute('aria-label'), '👍 已回应', 'once the record has it');
  p.X.close();
  // Joining a cat's chip: the shared chip is pending as a whole until the record has the owner's part.
  p.draw([owner('u1', 1), reacted(m1, mark('r0', '❤️', 4), mark('new-1', '👍', 6), mark('c9', '🐾', 7, by('团子')))]);
  p.answers.push(() => new Promise(() => {}));
  open.click();
  p.doc.body.querySelector('.rx-pick')!.children[4]!.click();
  const paws = p.chips('m1').find((c: El) => c.dataset.emoji === '🐾')!;
  assert.ok(paws.classList.contains('rx-sending'));
  assert.equal(paws.getAttribute('aria-label'), '🐾 你（发送中）、团子');
  assert.equal(text(paws), '🐾2');
});

test('a single chat\'s receipt is an event stream; a group\'s is JSON and goes to the group; 🐾 is stamped as it lands', async () => {
  const p = page();
  p.draw([cat('m1', 3)]);
  p.answers.push(() => ({ status: 200, sse: 'event: queued\ndata: {"userMessageId":"u-sse"}\n\nevent: done\ndata: {}\n\n' }));
  p.row('m1').querySelector('.rx-act-react')!.click();
  p.doc.body.querySelector('.rx-pick')!.children[4]!.click();
  p.flush();
  const paw = p.chips('m1')[0];
  assert.equal(paw.motions.length, 1);
  assert.equal(paw.children[0]!.motions.length, 1, 'the glyph itself is stamped');
  await tick(); await tick();
  assert.deepEqual(p.log.accepted, ['u-sse']);
  const g = page({ group: true });
  g.draw([{ id: 'gm', seq: 4, kind: 'bot', sender: '栗子', text: '好', native_cat_id: 'c2', presentation_kind: 'message', native: { type: 'assistant', id: 'gm', catId: 'c2' } }]);
  g.row('gm').querySelector('.rx-act-react')!.click();
  g.doc.body.querySelector('.rx-pick')!.children[0]!.click();
  await tick(); await tick();
  assert.equal(g.log.calls[0].path, '/xbot-api/groups/g1/messages');
  assert.deepEqual(g.log.expects, ['c2'], 'the typing bubble of the cat whose words they are');
});

test('not sent: the chip leaves and the owner is told; an unknown outcome reuses the key and reads again; a refusal takes a new key; an answer after leaving the chat is not drawn there', async () => {
  const p = page();
  const msgs = [cat('m1', 3)];
  p.draw(msgs);
  const pick = (i: number) => { p.row('m1').querySelector('.rx-act-react')!.click(); p.doc.body.querySelector('.rx-pick')!.children[i]!.click(); };
  p.answers.push(() => ({ status: 409, json: { error: '会话已变化。' } }));
  pick(0);
  assert.equal(p.chips('m1').length, 1);
  await tick(); await tick();
  assert.equal(p.chips('m1').length, 0, 'gone again');
  assert.deepEqual(p.log.notes, ['👍 没发出去：会话已变化']);
  assert.equal(p.log.dropped, 1, 'its typing bubble goes too');
  assert.equal(p.log.reloads, 1, 'the conversation moved: read where it is');
  // No answer: not known whether it landed; the same emoji again goes with the same key.
  p.answers.push(() => ({ status: 0, throws: '连不上 clowder-bot' }));
  pick(0);
  await tick(); await tick();
  assert.equal(p.log.notes[1], '没能确认 👍 发出去没有');
  pick(0);
  await tick(); await tick();
  assert.equal(p.log.calls[1].body.idempotencyKey, p.log.calls[2].body.idempotencyKey);
  assert.notEqual(p.log.calls[0].body.idempotencyKey, p.log.calls[1].body.idempotencyKey, 'a refusal does not keep its key');
  // Another chat before the answer: nothing is drawn there, and the owner is told which chat it was.
  let release: (v: Any) => void = () => {};
  p.answers.push(() => new Promise((r) => { release = r; }));
  pick(3);
  p.state.sel = { type: 'bot', id: '栗子' };
  p.X.select(p.state.sel);
  p.draw([cat('k1', 1, {}, 'c2')], true);
  release({ status: 400, json: { error: '引用的消息不存在，请刷新对话' } });
  await tick(); await tick();
  assert.equal(p.inner.querySelectorAll('.rx-chip').length, 0);
  assert.equal(p.log.notes.at(-1), '给团子的 👀 没发出去：引用的消息不存在，请刷新对话');
});

test('review 1, item 7: an answer whose body breaks off, or that names no message, is no admission — the outcome is not known: told, read again, the emoji free to tap again with the same key', async () => {
  for (const answer of [{ status: 200, sse: '', broken: true }, { status: 202, json: {}, broken: true }, { status: 202, json: { status: 'queued' } }, { status: 200, sse: 'event: done\ndata: {}\n\n' }]) {
    const p = page();
    p.draw([cat('m1', 3)]);
    p.answers.push(() => answer);
    p.row('m1').querySelector('.rx-act-react')!.click();
    p.doc.body.querySelector('.rx-pick')!.children[0]!.click();
    await tick(); await tick();
    assert.deepEqual(p.log.notes, ['没能确认 👍 发出去没有'], JSON.stringify(answer));
    assert.equal(p.chips('m1').length, 0, 'not shown as reacted');
    assert.equal(p.log.reloads, 1, 'read again: if it landed, the read brings it');
    assert.deepEqual(p.log.accepted, [], 'no empty ID handed on');
    // Not stuck: 👍 can be tapped again, and goes with the same key.
    p.row('m1').querySelector('.rx-act-react')!.click();
    const again = p.doc.body.querySelector('.rx-pick')!.children[0]!;
    assert.equal(again.getAttribute('aria-disabled'), null);
    again.click();
    await tick(); await tick();
    assert.equal(p.log.calls[1].body.idempotencyKey, p.log.calls[0].body.idempotencyKey);
  }
});

// review 1, item 1: app.js's own sendText, with what it calls faked. A send whose outcome is not known keeps
// its key for exactly the same request only: same chat, conversation, words, quote, pictures and files.
function sendHarness() {
  const app = read('client/public/app.js');
  const m = /\n {2}async function sendText\([^)]*\) \{\n[\s\S]*?\n {2}\}\n/.exec(app);
  assert.ok(m);
  const out: Any = {};
  const composer = { text: '' };
  const state: Any = { sel: { type: 'group', id: 'g1' }, replyTo: null, pendingSends: [], replyErrors: [], streaming: 0, threadLoad: 0, sig: '' };
  const calls: Any[] = [];
  let n = 0;
  const answers: Array<() => Promise<Any>> = [];
  const row = () => {
    const mk: Any = { className: 'send-state', isConnected: true, replaceChildren() {}, remove() {} };
    const r: Any = { dataset: {}, classList: { remove() {} }, querySelector: (sel: string) => (sel === '.send-state' ? mk : sel === '.send-failed' ? (mk.className.includes('send-failed') ? mk : null) : sel === '.bubble-col' ? { append() {} } : null), remove() {} };
    state.pendingSends.push(r);
    return r;
  };
  const sandbox: Any = {
    out, state, document: { createTextNode: (t: string) => t }, JSON, Date, Math, setTimeout: () => 0,
    sessionStorage: { setItem() {} }, authenticated: true, input: {}, thread: { querySelector: () => null },
    requestKey: () => 'key-' + (++n), ownerSends: () => 0, announceSend() {}, botCatId: () => 'c1', setStatus() {}, zhError: (x: string) => x,
    el: () => ({ append() {}, addEventListener() {} }), errorDetails() {}, composerCaretTo() {}, composerRefreshHeight() {}, syncComposer() {},
    composerText: () => composer.text, composerSet: (t: string) => { composer.text = t; },
    optimisticMessage: row,
    live: { expect: () => ({ accept() {}, drop() {} }) },
    liveRules: { receipt: () => ({ userMessageId: 'u1' }) },
    workspace: { threadId: () => 'T1', giveBack: () => false },
    clearQuote: () => { state.replyTo = null; }, paintQuoteBar() {},
    chatList: { giveBack() {} },
    loadThread: async () => {},
    apiFetch: (path: string, opt: Any) => { calls.push({ path, body: JSON.parse(opt.body) }); return (answers.shift() || (() => Promise.reject(Object.assign(new Error('服务出了点问题'), { status: 503 }))))(); },
  };
  vm.runInNewContext(m![0] + 'out.sendText = sendText;', sandbox);
  return { send: out.sendText, state, composer, calls };
}

test('review 1, item 1: after a send with an unknown outcome, the same words quoting another message (or with nothing quoted) are another request with a new key; exactly the same request again keeps its key', async () => {
  const h = sendHarness();
  const quoteA = { seq: 5, text: '猫 A 的话', thread: 'T1', cat: 'cA' }, quoteB = { seq: 9, text: '猫 B 的话', thread: 'T1', cat: 'cB' };
  h.state.replyTo = quoteA;
  await h.send('好的', null, [], null);
  assert.equal(h.calls[0].body.reply_to, 5);
  // The quote came back with the words; the owner quotes cat B instead and sends the same words.
  h.state.replyTo = quoteB;
  h.composer.text = '';
  await h.send('好的', null, [], null);
  assert.equal(h.calls[1].body.reply_to, 9);
  assert.notEqual(h.calls[1].body.idempotencyKey, h.calls[0].body.idempotencyKey, 'another quote: another request');
  // Exactly that request again: its key.
  h.state.replyTo = quoteB;
  await h.send('好的', null, [], null);
  assert.equal(h.calls[2].body.idempotencyKey, h.calls[1].body.idempotencyKey);
  // Nothing quoted this time: again another request.
  h.state.replyTo = null;
  await h.send('好的', null, [], null);
  assert.equal(h.calls[3].body.reply_to, undefined);
  assert.notEqual(h.calls[3].body.idempotencyKey, h.calls[2].body.idempotencyKey);
  assert.match(read('client/public/app.js'), /const sendSig = JSON\.stringify\(\[selection\.type, selection\.id, threadId \|\| "", text, replyTo, images, files \? files\.ids : \[\]\]\);/);
});

test('the message menu\'s row of five: on a cat\'s words only, the sent ones chosen; a pick closes the menu and sends; ← → move along it', async () => {
  const p = page();
  p.draw([owner('u1', 1), reacted(cat('m1', 3), mark('r1', '🎉', 4))]);
  assert.equal(p.X.strip(owner('u1', 1), 'x', () => {}), null);
  let closed = 0;
  const strip = p.X.strip(cat('m1', 3), '要我现在开始吗？', () => { closed++; });
  assert.equal(strip.getAttribute('role'), 'group');
  assert.deepEqual(strip.children.map((b: El) => b.getAttribute('aria-disabled')), [null, null, 'true', null, null], 'the row as now read, not as the menu was bound');
  strip.children[0]!.focus();
  strip.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(p.doc.activeElement, strip.children[4]);
  strip.dispatch('keydown', { key: 'Home' });
  assert.equal(p.doc.activeElement, strip.children[0]);
  strip.children[1]!.click();
  assert.equal(closed, 1);
  await tick(); await tick();
  assert.equal(p.log.calls[0].body.text, '❤️');
  // Escape in the picker closes it and gives focus back to 表情.
  const open = p.row('m1').querySelector('.rx-act-react')!;
  open.click();
  p.doc.body.querySelector('.rx-pick')!.dispatch('keydown', { key: 'Escape' });
  assert.equal(p.doc.body.querySelector('.rx-pick'), null);
  assert.equal(p.doc.activeElement, open);
});

test('a group: a cat that left gets no 表情 (回复 stays); a reply\'s number that is a reaction finds the row it is drawn on', () => {
  const p = page({ group: true });
  p.state.members = ['团子'];
  const g = (id: string, seq: number, catId: string, name: string, more: Any = {}) => ({ id, seq, kind: 'bot', sender: name, text: '好', native_cat_id: catId, presentation_kind: 'message', native: { type: 'assistant', id, catId }, ...more });
  p.draw([g('a', 1, 'c1', '团子'), g('b', 2, 'c2', '栗子')]);
  assert.equal(p.row('a').querySelector('.rx-acts')!.dataset.n, '2');
  assert.equal(p.row('b').querySelector('.rx-acts')!.dataset.n, '1');
  // chat-locate-rules.js: a row is found by a reaction it carries, by ID or by number.
  const L = load('chat-locate-rules.js').ClowderLocateRules;
  const row = { dataset: { mid: 'a', seq: '1', rx: 'r1 r2', rxs: '7 9' } };
  assert.equal(L.matches(row, { messageId: 'r2' }), true);
  assert.equal(L.matches(row, { seq: 9 }), true);
  assert.equal(L.matches(row, { seq: 8 }), false);
  assert.equal(L.matches(row, { messageId: 'r' }), false);
  assert.equal(L.matches({ dataset: { mid: 'a' } }, { messageId: 'a' }), true);
});

test('review 1, item 11: beside a wide bubble on a narrow window the buttons never pass the conversation\'s edge — a line with the time when there is room, the buttons above the time with less, a small toolbar over the bubble\'s inner foot corner with none; hidden ones take no room', () => {
  const p = page();
  p.draw([owner('u1', 1), cat('m1', 3)]);
  p.thread.box = { left: 0, top: 0, right: 760, bottom: 600, width: 760, height: 600 };
  p.thread.clientWidth = 760;
  const fitAt = (mid: string, left: number, right: number) => {
    const row = p.row(mid);
    row.children[0]!.box = { left, right, width: right - left, top: 100, bottom: 140, height: 40 };
    p.X.fit(row);
    return row.classList.contains('rx-over') ? 'over' : row.classList.contains('rx-tight') ? 'tight' : 'line';
  };
  // A cat's bubble (two buttons, 58px): a line needs 4 + 58 + 6 + 40 = 108px beside it, the buttons above the time 66px.
  assert.equal(fitAt('m1', 40, 760 - 120), 'line');
  assert.equal(fitAt('m1', 40, 760 - 108), 'line');
  assert.equal(fitAt('m1', 40, 760 - 80), 'tight');
  assert.equal(fitAt('m1', 40, 760 - 40), 'over', 'a full-width bubble on a 760px window');
  assert.equal(fitAt('m1', 40, 760 - 120), 'line', 'and back when the room is there again');
  // The owner's bubble (one button) measures the room on its left.
  assert.equal(fitAt('u1', 300, 720), 'line');
  assert.equal(fitAt('u1', 60, 720), 'tight');
  assert.equal(fitAt('u1', 20, 720), 'over');
  const css = read('client/public/chat-reactions.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.msg > :is\(\.body, \.bubble-col\) > \.rx-acts \{[^}]*display: none;/, 'hidden: no room taken, so no sideways scroll');
  assert.match(css, /\.msg\.rx-over > :is\(\.body, \.bubble-col\) > \.rx-acts \{[^}]*background: var\(--x-popover\);/);
  assert.match(css, /\.msg\.bot\.rx-over > \.body > \.rx-acts \{ left: auto; right: calc\(8px \+ var\(--rx-inset, 0px\)\);/);
});

test('review 2, item 14: narrowing the window with the focus left where it is fits the focused row again in the resize\'s frame — tight becomes the toolbar, and back when it widens', () => {
  const p = page();
  p.draw([owner('u1', 1), cat('m1', 3)]);
  const row = p.row('m1');
  row.children[0]!.box = { left: 40, right: 640, width: 600, top: 100, bottom: 140, height: 40 };
  const width = (w: number) => { p.thread.box = { left: 0, top: 0, right: w, bottom: 600, width: w, height: 600 }; p.thread.clientWidth = w; };
  width(720);
  row.querySelector('.rx-act-react')!.focus();
  p.X.fit(row);
  assert.ok(row.classList.contains('rx-tight'), '80px beside the bubble: the buttons above the time');
  // The window narrows; nothing moves the focus or the pointer, and nothing new is read.
  width(680);
  p.window.listeners.resize();
  p.flush();
  assert.ok(row.classList.contains('rx-over'), 'no room beside it now: the toolbar over the bubble');
  width(900);
  p.window.listeners.resize();
  p.flush();
  assert.ok(!row.classList.contains('rx-over') && !row.classList.contains('rx-tight'), 'room again: a line beside it');
});

test('review 1, item 10: on the dark theme 🐾 (a dark grey glyph, about #464646) stays visible on every chip and in the picker, in all eleven 配色; the owner\'s chips stay told apart from the cats\'', () => {
  const css = read('client/public/chat-reactions.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /html\[data-theme="dark"\] \.rx-chip \{ background: color-mix\(in srgb, var\(--x-text\) 82%, var\(--x-card\)\); color: var\(--x-card\);/);
  assert.match(css, /html\[data-theme="dark"\] \.rx-chip\.rx-mine \{ background: var\(--accent\); color: var\(--x-card\);/);
  assert.match(css, /html\[data-theme="dark"\] \.rx-emo \{ background: color-mix\(in srgb, var\(--x-text\) 82%, var\(--x-popover\)\); \}/);
  assert.match(css, /html\[data-theme="dark"\] \.rx-emo\.rx-given \{ background: var\(--accent\);/);
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
  const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v * t + b[i]! * (1 - t));
  const paw = [70, 70, 70];
  const palettes = JSON.parse(read('client/public/theme-lab/palettes.json'));
  assert.equal(palettes.length, 11);
  for (const p of palettes) {
    const t = p.dark.tokens, at = `${p.id} dark`;
    const text = hex(t['--x-text']), card = hex(t['--x-card']), pop = hex(t['--x-popover']), accent = hex(t['--accent']);
    const chip = mix(text, card, 0.82), disc = mix(text, pop, 0.82);
    for (const [what, bg] of [['a cat\'s chip', chip], ['the owner\'s chip', accent], ['a picker disc', disc], ['a chosen picker disc', accent]] as const) {
      assert.ok(ratio(paw, bg as number[]) >= 3, `${at}: 🐾 on ${what} is ${ratio(paw, bg as number[]).toFixed(2)}:1`);
    }
    for (const [what, bg] of [['a cat\'s chip', chip], ['the owner\'s chip', accent]] as const) {
      assert.ok(ratio(card, bg as number[]) >= 4.5, `${at}: the count on ${what} is ${ratio(card, bg as number[]).toFixed(2)}:1`);
    }
    // Told apart: the owner's in the accent, the cats' in a pale tone of the text colour.
    const apart = Math.hypot(...accent.map((v, i) => v - chip[i]!));
    assert.ok(apart > 20, `${at}: the owner's chip and a cat's differ (${apart.toFixed(0)})`);
  }
});

// ---------------------------------------------------------------- the other modules
test('the seen paw counts a cat\'s one-emoji answer on the owner\'s row; follows that names the owner\'s reaction goes under the row it is drawn on', () => {
  const P = load('chat-live-rules.js', 'chat-presence-rules.js').ClowderPresenceRules;
  const rows = [owner('u1', 1), reacted(owner('u2', 2), mark('rx', '🐾', 3, by('团子', 'c1')), mark('mine', '👍', 4))];
  assert.deepEqual(plain([...P.picked(rows)]), [['u2', ['c1']]]);
  assert.deepEqual(plain(P.seenMark(['u1', 'u2'], P.picked(rows))), { id: 'u2', cats: ['c1'] });
  const L = load('chat-live-rules.js').ClowderLiveRules;
  // The reply began before the owner reacted on m1 and took that reaction in: drawn under m1.
  const single = [cat('r', 1, { follows: 5 }), cat('m1', 2, { reactions: [mark('x', '👍', 5)] })];
  assert.deepEqual(plain(L.order(single, false)), [1, 0]);
  const group = [{ id: 'r', kind: 'bot', follows: 'x' }, { id: 'm1', kind: 'bot', reactions: [mark('x', '👍', 5)] }];
  assert.deepEqual(plain(L.order(group, true)), [1, 0]);
  // A cat's reaction is not the owner's follow-up; a number on the row itself moves nothing.
  assert.deepEqual(plain(L.order([cat('r', 1, { follows: 5 }), cat('m1', 2, { reactions: [mark('x', '🐾', 5, by('团子'))] })], false)), [0, 1]);
  assert.deepEqual(plain(L.order([cat('r', 1, { follows: 5, reactions: [mark('x', '👍', 5)] })], false)), [0]);
  // 再发一次 for a reply that failed answering the owner's reaction: that message is no row, so nothing is offered (as before for a missing one).
  const C = load('chat-cards-rules.js').ClowderCardsRules;
  const failed = cat('f', 9, { ended: { how: 'failed' }, native: { type: 'assistant', id: 'f', catId: 'c1', replyTo: 'x', lifecycle: { status: 'failed' } } });
  assert.equal(C.resend([cat('m1', 2, { reactions: [mark('x', '👍', 5)] }), failed], failed, false), null);
});

test('the shell: liveRows ends a cat\'s reply that became a reaction, with what it answered as the record says (reply_to_id; review 1, item 8: never guessed from the order); lineBySeq finds the row a reaction\'s number is drawn on; previewText reads a group\'s row', () => {
  const app = read('client/public/app.js');
  const take = (name: string) => {
    const m = new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
    assert.ok(m, name);
    return m![0];
  };
  const out: Any = {};
  vm.runInNewContext(take('liveRows') + take('lineBySeq') + take('previewText') + 'out.liveRows = liveRows; out.lineBySeq = lineBySeq; out.previewText = previewText;', {
    out, presentation: { isActivity: () => false }, sayText: (m: Any) => m.content, displayText: (t: string) => t, unwrap: (t: string) => ({ text: t }),
  });
  const rows = [
    reacted(owner('u1', 1), { ...mark('a', '🐾', 3, by('团子', 'c1')), reply_to_id: 'u1' }),
    // Your 👍 (A) and ❤️ (B) on m1; the cat's 🐾 answering A arrives after B in the list.
    reacted(cat('m1', 2), mark('A', '👍', 4), mark('B', '❤️', 5), { ...mark('b', '🐾', 6, by('团子', 'c1')), reply_to_id: 'A' }),
  ];
  assert.deepEqual(plain(out.liveRows(rows, false)).filter((r: Any) => ['a', 'b'].includes(r.id)), [
    { id: 'a', catId: 'c1', inProgress: false, draft: '🐾', replyTo: 'u1' },
    { id: 'b', catId: 'c1', inProgress: false, draft: '🐾', replyTo: 'A' },
  ], 'the answer to A, though B came between them');
  assert.equal(plain(out.liveRows([reacted(cat('m2', 7), mark('c', '🐾', 8, by('团子', 'c1')))], false))[1].replyTo, '', 'no reply_to_id: nothing is guessed');
  assert.equal(out.lineBySeq(rows, 2).id, 'm1');
  assert.equal(out.lineBySeq(rows, 4).id, 'm1', 'the owner\'s 👍 is drawn on m1');
  assert.equal(out.lineBySeq(rows, 3).id, 'u1');
  assert.equal(out.lineBySeq(rows, 99), null);
  assert.equal(out.previewText({ kind: 'bot', text: ' 好的\r\n' }), '好的');
  assert.equal(out.previewText({ kind: 'person', text: '你好' }), '你好');
});

test('review 1, item 6: across the newest page and the pages held above it, one reaction is in one place — as the newest page has it now; the pages still join when a reaction became a row of its own at the seam', () => {
  const H = load('chat-history-rules.js').ClowderHistoryRules;
  const ids = (rows: Any[]) => rows.map((m: Any) => m.native_message_id || m.id);
  const host = reacted(cat('H', 3), mark('r', '👍', 4));
  // Earlier pages loaded; H with your 👍 r was on the newest page. New messages push H off it: r is a line of its own now.
  const held = [owner('a', 1), cat('b', 2)], was = [host, owner('x', 5), cat('y', 6)];
  const now = [owner('r', 4, { content: '👍', reply_to: 3 }), owner('x', 5), cat('y', 6), owner('z', 7)];
  const kept = H.stitch(held, was, now, {});
  assert.ok(kept, 'still joined: r is a row only now, x is where it was');
  assert.deepEqual(plain(ids(kept)), ['a', 'b', 'H']);
  const shown = [...H.single(kept, now), ...now];
  assert.deepEqual(plain(ids(shown)), ['a', 'b', 'H', 'r', 'x', 'y', 'z']);
  assert.deepEqual(plain(shown[2].reactions), [], 'not on H any more: it is the line r');
  assert.deepEqual(plain(host.reactions.map((m: Any) => m.id)), ['r'], 'the held row itself is not changed');
  // The other way: r was a line of its own held above; the newest page draws it on H now.
  const back = [owner('r', 4, { content: '👍' }), cat('q', 4)];
  const later = [reacted(cat('H', 3), mark('r', '👍', 4)), owner('z', 7)];
  assert.deepEqual(plain(ids([...H.single(back, later), ...later])), ['q', 'H', 'z'], 'the held line r goes');
  // A cat's row folded on the newest page takes its delivery receipt with it.
  const receipt = { role: 'tool', tool_call_id: 'delivery_w', seq: 9 };
  assert.deepEqual(plain(H.single([cat('w', 8), receipt, owner('k', 10)], [reacted(owner('k', 10), mark('w', '🐾', 8, by('团子')))]).map((m: Any) => m.id || m.tool_call_id)), ['k']);
  // Nothing to reconcile: the same rows.
  assert.equal(H.single(held, [owner('n', 9)]).length, 2);
  // merge() keeps the reconciled pages as the ones held (review 2, item 13: tests/chat-history.test.ts drives two moves).
  assert.match(read('client/public/chat-history.js'), /if \(P\.held\.length\) P\.held = R\.single\(P\.held, rows\);\n\s+return P\.held\.length \? \[\.\.\.P\.held, \.\.\.rows\] : rows;/);
});

test('reads ask for reactions: the newest page in both chats and every earlier page; the newest page\'s IDs are known to the history', () => {
  const app = read('client/public/app.js');
  assert.match(app, /"\/transcript\?reactions=1"\)/);
  assert.match(app, /api\("\/xbot-api\/groups\/" \+ encodeURIComponent\(selection\.id\) \+ "\?reactions=1"\)/);
  const H = load('chat-history-rules.js').ClowderHistoryRules;
  assert.match(H.pagePath({ type: 'bot', id: '团子' }, 'c'), /\?before=c&reactions=1$/);
  assert.match(H.pagePath({ type: 'group', id: 'g' }, 'c'), /^\/xbot-api\/groups\/g\?before=c&reactions=1$/);
  assert.match(read('client/public/chat-history.js'), /latest: \(\) => new Set\(P\.was\.map/);
});

test('the shell wires it with thin hooks: scripts after chat-presence.js and before app.js, the style right after chat-presence.css, the menu\'s row and focus, groups quote, reset, read gate, the composer untouched by a reaction', () => {
  const html = read('client/index.html'), app = read('client/public/app.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map((m) => m[1]);
  const at = (n: string) => scripts.indexOf(n);
  assert.ok(at('chat-presence.js') < at('chat-reactions-rules.js') && at('chat-reactions-rules.js') < at('chat-reactions.js') && at('chat-reactions.js') < at('app.js'));
  assert.deepEqual(styles.slice(-4), ['chat-presence.css', 'chat-reactions.css', 'sidebar.css', 'chat-live.css']);
  assert.match(app, /const strip = reactions\.strip\(data\.message, data\.text, closeMessageMenu\);\n {4}if \(strip\) menu\.append\(strip\);/);
  assert.match(app, /menu\.querySelector\("button\.menu-row:not\(:disabled\)"\)/);
  assert.match(app, /reactions\.rendered\(messages, null\);/);
  assert.match(app, /reactions\.rendered\(messages, group\);/);
  assert.equal((app.match(/reactions\.before\(messages\);/g) || []).length, 2);
  assert.match(app, /reactions\.select\(state\.sel\);/);
  assert.match(app, /displacedBefore: \(id\) => \{\n\s+if \(!state\.drawn \|\| state\.peer\) return \[\];\n\s+const row = reactionRules\.readFirst\(state\.drawn\.messages, id\);\n\s+return \[\.\.\.liveRules\.displaced\(state\.drawn, id\), \.\.\.row, \.\.\.row\.flatMap\(\(r\) => liveRules\.displaced\(state\.drawn, r\)\)\];/);
  assert.doesNotMatch(app, /state\.sel\.type !== "bot" \|\| state\.peer\) return;/, 'armQuote is not for single chats only any more');
  assert.match(app, /if \(quoted\) wrap\.append\(quoted\);/);
  assert.match(app, /if \(quoted\) body\.append\(quoted\);/);
  assert.match(app, /chatList\.read\(selection, String\(data\.group\?\.native_thread_id/);
  // The module sends with the shell's fetch, never through sendText or the composer.
  const mod = read('client/public/chat-reactions.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(mod, /sendText|composer|replyTo\s*=|clearQuote/);
  // chat-experience.js finds a reaction's row and lets the hook hold a reaction back.
  const cx = read('client/public/chat-experience.js');
  assert.match(cx, /String\(row\.dataset\.rx \|\| ""\)\.split\(" "\)\.includes\(id\)/);
  assert.match(cx, /H\.displacedBefore\(id\) \|\| \[\]/);
  // Styles: only existing tokens, no colour literals, motion only from tokens or the 180 ms family.
  const css = read('client/public/chat-reactions.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(css, /prefers-reduced-motion/);
});
