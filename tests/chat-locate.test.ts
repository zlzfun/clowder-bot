import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El } from './fake-dom.js';

// Finding a message further back than the loaded history (chat-locate-rules.js,
// chat-locate.js; docs/xbot-frontend.md item 34). The rules run in a bare VM.
// The module runs on the small DOM with the real chat-history.js loader and the
// real chat-live.js keyed commit, against a fake server that pages a
// conversation the way the transcript route does (cursor `before`, records that
// project to no rows included) and a shell whose reload is app.js's loadThread
// reduced: it draws the newest page through merge, except while a send is in
// flight or when the read fails, when it returns without drawing. app.js and
// palette.js wiring is checked statically.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-locate-rules.js'), { window });
  return window.ClowderLocateRules;
}

test('the rules: find, read one more page, or stop and say why — a bounded number of page requests', () => {
  const R = rules();
  const base = { found: false, pages: 0, failed: false, more: true, state: 'idle', alive: true, stalled: false };
  assert.deepEqual({ ...R.next({ ...base, found: true }) }, { act: 'found' });
  assert.deepEqual({ ...R.next(base) }, { act: 'load' });
  assert.deepEqual({ ...R.next({ ...base, state: 'loading', pages: R.MAX_PAGES }) }, { act: 'load' }, 'a page already on its way is waited for (the cap sends no more)');
  assert.deepEqual({ ...R.next({ ...base, more: false }) }, { act: 'stop', why: 'none' }, 'nothing earlier at all');
  assert.deepEqual({ ...R.next({ ...base, more: false, pages: 2 }) }, { act: 'stop', why: 'end' });
  assert.deepEqual({ ...R.next({ ...base, pages: R.MAX_PAGES }) }, { act: 'stop', why: 'limit' });
  assert.deepEqual({ ...R.next({ ...base, failed: true }) }, { act: 'stop', why: 'failed' }, 'any failure while it looks, whoever asked');
  assert.deepEqual({ ...R.next({ ...base, failed: true, found: true }) }, { act: 'found' });
  assert.deepEqual({ ...R.next({ ...base, state: 'failed' }) }, { act: 'load' }, 'a failure before it began (a scroll) is tried again');
  assert.deepEqual({ ...R.next({ ...base, stalled: true }) }, { act: 'stop', why: 'stuck' });
  assert.deepEqual({ ...R.next({ ...base, alive: false, found: true }) }, { act: 'stop', why: 'left' });
  assert.equal(R.MAX_PAGES, 10);
  const row = { dataset: { mid: 'm-7', seq: '42' } };
  assert.equal(R.matches(row, { messageId: 'm-7' }), true);
  assert.equal(R.matches(row, { seq: 42 }), true);
  assert.equal(R.matches(row, { messageId: 'm-8', seq: null }), false);
  assert.equal(R.progress(0), '正在往前找这条消息…');
  assert.equal(R.progress(3), '正在往前找这条消息…已经翻了 3 页');
  assert.equal(R.stopped('end', 4), '翻到了这段对话最早的消息，也没有找到这一条。');
  assert.equal(R.stopped('none', 0), '这条消息不在这段对话里，也没有更早的记录可以翻了。');
  assert.equal(R.stopped('limit', 10), '往前翻了 10 页还没找到这条消息，先停在这里；可以接着往上翻看。');
  assert.equal(R.stopped('failed', 1, '没能完成：服务出了点问题。'), '没能加载更早的消息：服务出了点问题。这条消息还没找到。');
  assert.equal(R.stopped('undrawn', 1), '更早的消息读到了，但还没能显示出来，这条消息还没找到；稍后再找一次。');
  assert.equal(R.stopped('left', 2), '', 'another chat: nothing to say');
});

// A conversation of `total` native messages m1…mN (seq = N), read `per` at a
// time; `blank` messages are records that project to no row. Earlier pages are
// answered by the test (answer / fail) unless `auto` is on.
type Opts = { total?: number; per?: number; blank?: (n: number) => boolean; auto?: boolean };
function page(o: Opts = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const thread = h('div', 'thread');
  thread.id = 'thread';
  doc.body.append(thread);
  Object.assign(thread, { clientHeight: 600, scrollHeight: 2000, scrollTop: 0 });
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const window: Any = { matchMedia: () => ({ matches: false }), requestAnimationFrame: (fn: () => void) => { fn(); return 1; } };
  const context = vm.createContext({ window, document: doc, console, Promise, setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {}, setInterval: () => 1 });
  for (const f of ['chat-live-rules.js', 'chat-live.js', 'chat-history-rules.js', 'chat-history.js', 'chat-locate-rules.js', 'chat-locate.js']) vm.runInContext(read('client/public/' + f), context);
  const live = window.ClowderLive, history = window.ClowderHistory, L = window.ClowderLocate;
  live.init({ thread, render: () => {}, row: () => h('div', 'msg bot live'), queued: () => false, busy: () => false, unread: () => '', changed: () => {}, gap: () => {} });
  const total = o.total ?? 60, per = o.per ?? 10, blank = o.blank ?? (() => false);
  const convs: Record<string, number> = { T1: total };
  const app: Any = { sel: { type: 'bot', id: '团子' }, thread: 'T1', sending: false, readFails: false, draws: 0 };
  const msg = (n: number, t: string) => ({ id: t + '-m' + n, native_message_id: t + '-m' + n, seq: n, role: n % 2 ? 'user' : 'assistant', content: '第 ' + n + ' 条' });
  // Native messages [from, to) of a conversation, projected.
  const slice = (t: string, from: number, to: number) => {
    const rows = [];
    for (let n = Math.max(1, from); n < to; n++) if (!blank(n)) rows.push(msg(n, t));
    return { messages: rows, hasMore: from > 1, before: from > 1 ? from + ':' + t + '-m' + from : '', thread_id: t };
  };
  const newest = () => slice(app.thread, convs[app.thread]! - per + 1, convs[app.thread]! + 1);
  const key = (sel: Any) => (sel.type === 'group' ? 'group:' : 'bot:') + sel.id;
  const draw = (messages: Any[]) => {
    const inner = h('div', 'thread-inner');
    inner.dataset.chat = key(app.sel);
    for (const m of messages) { const r = h('div', 'msg'); r.dataset.mid = m.id; r.dataset.seq = String(m.seq); r.textContent = m.content; inner.append(r); }
    history.top(inner);
    live.commit(inner, []);
    app.draws++;
  };
  const poll = () => draw(history.merge(app.sel, app.thread, newest()));
  const calls: string[] = [];
  const pending: Array<{ resolve: (v: Any) => void; reject: (e: Any) => void; path: string }> = [];
  const api = (path: string) => {
    calls.push(path);
    const m = /before=(\d+)%3A([^&]+)/.exec(path)!;
    const to = Number(m[1]), t = decodeURIComponent(m[2]!).split('-m')[0]!;
    const answer = slice(t, to - per, to);
    if (o.auto !== false) return new Promise((r) => setImmediate(() => r(answer)));
    return new Promise((resolve, reject) => pending.push({ resolve: () => resolve(answer), reject, path }));
  };
  // The shell's notes (app.js quietNote): "" with an owner hides only that owner's note.
  const toast: Any = { text: '', busy: false, owner: null, log: [] as string[] };
  const note = (text: string, busy = false, owner: Any = null) => {
    if (!text) { if (owner && toast.owner !== owner) return; toast.text = ''; toast.owner = null; return; }
    Object.assign(toast, { text, busy, owner });
    toast.log.push(text);
  };
  const rested = { n: 0 };
  history.init({ api, thread, visibleError: (e: Any) => (e && e.message) || '出错了', selected: () => app.sel,
    // loadThread reduced: no drawing while a send is in flight; a failed read is swallowed.
    reload: async () => { if (app.sending || app.readFails) return; poll(); } });
  L.init({ thread, selected: () => app.sel, history, note, rest: () => { rested.n++; } });
  live.select(key(app.sel));
  history.select(app.sel);
  poll();
  const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  const row = (seq: number, t = app.thread) => thread.querySelectorAll('.msg').find((r: El) => r.dataset.mid === t + '-m' + seq) ?? null;
  return { doc, app, history, L, live, calls, pending, toast, rested, timers, poll, settle, row, convs, earlier: () => calls.length };
}

test('a message on screen is centred, flashed and focused at once, with no note and no request', async () => {
  const p = page();
  assert.equal(await p.L.find({ sel: p.app.sel, seq: 55 }), true);
  const row = p.row(55)!;
  assert.ok(row.classList.contains('cx-hit'));
  assert.equal(p.doc.activeElement, row);
  assert.equal(row.getAttribute('tabindex'), '-1');
  assert.deepEqual(p.toast.log, []);
  assert.equal(p.earlier(), 0);
});

test('further back: pages come through the real history loader and drawing; the note goes once the message is found', async () => {
  const p = page({ total: 60, per: 10 });
  assert.equal(await p.L.find({ sel: p.app.sel, seq: 33 }), true);
  assert.equal(p.earlier(), 2, '41–50 is drawn, 31–40 follows: two earlier pages');
  assert.equal(p.doc.activeElement, p.row(33));
  assert.equal(p.toast.text, '', 'the note is taken back');
  assert.deepEqual(p.toast.log, ['正在往前找这条消息…', '正在往前找这条消息…已经翻了 1 页']);
});

test('a page read while a send is in flight is waited for until it is drawn, not taken as "not found" (and a failed redraw likewise)', async () => {
  for (const why of ['sending', 'readFails'] as const) {
    const p = page({ total: 30, per: 10 });
    p.app[why] = true;
    const going = p.L.find({ sel: p.app.sel, seq: 15 });
    await p.settle();
    assert.equal(p.earlier(), 1, 'the page holding it was read once');
    assert.equal(p.row(15), null, 'not drawn yet');
    assert.equal(p.toast.text, '正在往前找这条消息…', 'still looking, nothing claimed');
    // The send finishes; the next poll draws the held page.
    p.app[why] = false;
    p.poll();
    assert.equal(await going, true, why);
    assert.equal(p.doc.activeElement, p.row(15));
    assert.equal(p.earlier(), 1, 'no page read again');
    assert.ok(!p.toast.log.some((t: string) => /最早|不在这段/.test(t)));
  }
  // Never drawn within the wait: a truthful stop, not "not in this conversation".
  const q = page({ total: 30, per: 10 });
  q.app.sending = true;
  const going = q.L.find({ sel: q.app.sel, seq: 15 });
  await q.settle();
  q.timers.filter(t => t.ms === 20000).forEach(t => t.fn());
  assert.equal(await going, null);
  assert.equal(q.toast.text, '更早的消息读到了，但还没能显示出来，这条消息还没找到；稍后再找一次。');
});

test('the budget counts every earlier-page request, the history\'s own reading through empty pages included', async () => {
  // Every other page projects to no rows: the history reads on through them by itself.
  const p = page({ total: 400, per: 10, blank: (n) => Math.floor((n - 1) / 10) % 2 === 1 && n < 380 });
  assert.equal(await p.L.find({ sel: p.app.sel, seq: 1000 }), null);
  assert.equal(p.earlier(), 10, 'exactly the budget, never more');
  assert.equal(p.toast.text, '往前翻了 10 页还没找到这条消息，先停在这里；可以接着往上翻看。');
});

test('any failure while it looks stops it, even of a page the owner\'s scroll asked for; it is not retried behind the owner\'s back', async () => {
  const p = page({ total: 60, per: 10, auto: false });
  void p.history.load(); // the owner scrolled to the top: a page is on its way
  const going = p.L.find({ sel: p.app.sel, seq: 3 });
  await p.settle();
  assert.equal(p.calls.length, 1, 'the lookup joins the page already on its way');
  p.pending.shift()!.reject(new Error('服务出了点问题'));
  assert.equal(await going, null);
  assert.equal(p.calls.length, 1, 'no second request');
  assert.equal(p.toast.text, '没能加载更早的消息：服务出了点问题。这条消息还没找到。');
  assert.equal(p.rested.n, 1, 'focus left nowhere goes back to the composer');
});

test('another conversation of the same cat, or the palette moving on, ends a lookup: no focus on a row with the same seq, no note left', async () => {
  const p = page({ total: 60, per: 10, auto: false });
  const going = p.L.find({ sel: p.app.sel, seq: 33 });
  await p.settle();
  assert.equal(p.toast.text, '正在往前找这条消息…');
  // The cat moves to another conversation (selectBot → history.select), whose newest page holds a seq 33 of its own.
  p.convs.T2 = 40;
  p.app.thread = 'T2';
  p.history.select(p.app.sel);
  p.live.select('bot:团子');
  p.poll();
  assert.ok(p.row(33, 'T2'), 'the other conversation shows its own 33');
  p.pending.shift()!.resolve({});
  assert.equal(await going, null);
  assert.notEqual(p.doc.activeElement, p.row(33, 'T2'), 'never the unrelated message');
  assert.equal(p.toast.text, '', 'its note is taken back');

  // The palette moved on (reopened): its still() says so, and the lookup stops before its next step.
  const q = page({ total: 60, per: 10, auto: false });
  let still = true;
  const run = q.L.find({ sel: q.app.sel, seq: 23, still: () => still });
  await q.settle();
  still = false;
  q.pending.shift()!.resolve({});
  assert.equal(await run, null);
  assert.equal(q.calls.length, 1, 'no further page');
  assert.equal(q.doc.activeElement, q.doc.body);
  assert.equal(q.toast.text, '');
});

test('a newer lookup takes the older one\'s note down; the older one\'s late end never takes the newer note', async () => {
  const p = page({ total: 60, per: 10, auto: false });
  const older = p.L.find({ sel: p.app.sel, seq: 3 });
  await p.settle();
  assert.equal(p.toast.text, '正在往前找这条消息…');
  assert.equal(await p.L.find({ sel: p.app.sel, seq: 55 }), true, 'a message on screen');
  assert.equal(p.toast.text, '', 'the superseded spinner is gone');
  // A third lookup puts up its own note; the first one ending late leaves it.
  const third = p.L.find({ sel: p.app.sel, seq: 2 });
  await p.settle();
  p.pending.shift()!.resolve({});
  assert.equal(await older, null);
  assert.equal(p.toast.text, '正在往前找这条消息…', 'the newer note stays (the third lookup asks for its own page now)');
  assert.equal(p.calls.length, 2);
  // Another toast (the shell's own) is never hidden by a lookup's late clear.
  p.toast.owner = null; p.toast.text = '已复制';
  p.history.select({ type: 'bot', id: '栗子' });
  p.app.sel = { type: 'bot', id: '栗子' };
  for (const r of p.pending.splice(0)) r.resolve({});
  assert.equal(await third, null);
  assert.equal(p.toast.text, '已复制');
});

test('wiring: the palette passes its operation, the shell its notes with owners; a quote\'s jump goes through it', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), pal = read('client/public/palette.js'), hist = read('client/public/chat-history.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('chat-history.js') < scripts.indexOf('chat-locate-rules.js'));
  assert.equal(scripts.indexOf('chat-locate.js'), scripts.indexOf('chat-locate-rules.js') + 1);
  assert.ok(scripts.indexOf('chat-locate.js') < scripts.indexOf('app.js'));
  assert.match(app, /const locate = window\.ClowderLocate;/);
  assert.match(app, /note: \(text, busy, owner\) => quietNote\(text, busy, owner\),/);
  assert.match(app, /window\.ClowderPalette\.locate = async \(\{ type, id, nativeId, messageId, still \}\) => \{[\s\S]*?return locate\.find\(\{ sel, messageId, still \}\);/);
  assert.match(app, /function jumpToSeq\(seq\) \{[\s\S]*?locate\.find\(\{ sel: state\.sel, seq: Number\(seq\) \}\)/);
  // A lookup's "" hides the toast only while its own note is up; any other toast clears the owner.
  assert.match(app, /if \(!text\) \{\n\s+if \(owner && toastOwner !== owner\) return;/);
  assert.match(app, /function showToast\(text, iconName = "check"\) \{\n\s+const box = \$\("toast"\);\n\s+toastOwner = null;/);
  assert.match(pal, /still: \(\) => op === S\.op/);
  assert.match(pal, /if \(ok === false\) note\(after \+ "这条消息不在已显示的消息里，可能在更早的记录里。"\);/);
  assert.match(hist, /older: \(\) => \(\{ key: P\.key, thread: P\.thread, gen: P\.gen, state: P\.state, more: !!nextCursor\(\), loaded: P\.loaded, drawn: P\.drawn,/);
});

test('the found message\'s focus ring reaches 3:1 against the chat in every 配色 and both themes, and uses the system highlight in forced colours', () => {
  const css = read('client/public/polish.css'), cafe = read('client/public/cafe-theme.css');
  const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // Every ring rule mixes the ring colour at one share over transparency. It was the primary until item 48; the
  // ring colour is 拿铁's primary (cafe-theme.css points --ring at it), and every other 配色 fits its --ring for this.
  assert.match(cafe, /--ring: var\(--x-primary\);/);
  const shares = [...css.matchAll(/#thread \.msg:focus-visible[^{]*\{[^}]*color-mix\(in srgb, var\(--ring\) (\d+)%, transparent\)/g)].map(m => Number(m[1]));
  assert.equal(shares.length, 2, 'the bubble ring and the row ring');
  const palettes = JSON.parse(read('client/public/theme-lab/palettes.json'));
  assert.equal(palettes.length, 11);
  for (const share of shares) for (const p of palettes) for (const mode of ['light', 'dark']) {
    const fg = hex(p[mode].tokens['--ring']), bg = hex(p[mode].tokens['--x-card']);
    const seen = fg.map((c, i) => Math.round(c * share / 100 + bg[i]! * (1 - share / 100)));
    assert.ok(ratio(seen, bg) >= 3, `${share}% in ${p.id} ${mode}: ${ratio(seen, bg).toFixed(2)}:1`);
  }
  assert.match(css, /@media \(forced-colors: active\) \{\n\s+#thread \.msg:focus-visible :is\(\.bubble, \.bot-bubble\), #thread \.msg:focus-visible:not\(:has\(\.bubble, \.bot-bubble\)\) \{ outline-color: Highlight; \}/);
});
