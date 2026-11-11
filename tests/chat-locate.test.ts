import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El } from './fake-dom.js';

// Finding a message further back than the loaded history (chat-locate-rules.js,
// chat-locate.js; docs/xbot-frontend.md item 33). The rules run in a bare VM;
// the module runs on the small DOM against a stand-in for chat-history.js's
// loader that, like the real one, puts the page before above the rows already
// drawn and answers older() with where the earlier pages stand. app.js and
// palette.js wiring is checked statically.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-locate-rules.js'), { window });
  return window.ClowderLocateRules;
}

test('the rules: find, read one more page, or stop and say why — a bounded number of pages', () => {
  const R = rules();
  const base = { found: false, pages: 0, more: true, state: 'idle', sameChat: true };
  assert.deepEqual({ ...R.next({ ...base, found: true }) }, { act: 'found' });
  assert.deepEqual({ ...R.next(base) }, { act: 'load' });
  assert.deepEqual({ ...R.next({ ...base, state: 'loading' }) }, { act: 'load' }, 'a page already on its way is waited for');
  assert.deepEqual({ ...R.next({ ...base, more: false }) }, { act: 'stop', why: 'none' }, 'nothing earlier at all');
  assert.deepEqual({ ...R.next({ ...base, more: false, pages: 2 }) }, { act: 'stop', why: 'end' });
  assert.deepEqual({ ...R.next({ ...base, pages: R.MAX_PAGES }) }, { act: 'stop', why: 'limit' });
  assert.deepEqual({ ...R.next({ ...base, state: 'failed', pages: 1 }) }, { act: 'stop', why: 'failed' });
  assert.deepEqual({ ...R.next({ ...base, state: 'failed', pages: 0 }) }, { act: 'load' }, 'an earlier failure (a scroll) is tried again once');
  assert.deepEqual({ ...R.next({ ...base, sameChat: false, found: true }) }, { act: 'stop', why: 'left' });
  assert.equal(R.MAX_PAGES, 10);
  // Matching by native message ID or by seq (a quote's reply_to).
  const row = { dataset: { mid: 'm-7', seq: '42' } };
  assert.equal(R.matches(row, { messageId: 'm-7' }), true);
  assert.equal(R.matches(row, { seq: 42 }), true);
  assert.equal(R.matches(row, { messageId: 'm-8', seq: null }), false);
  // Words: one quiet line while it looks; a truthful stop that says how far it looked.
  assert.equal(R.progress(0), '正在往前找这条消息…');
  assert.equal(R.progress(3), '正在往前找这条消息…已经翻了 3 页');
  assert.equal(R.stopped('end', 4), '翻到了这段对话最早的消息，也没有找到这一条。');
  assert.equal(R.stopped('none', 0), '这条消息不在这段对话里，也没有更早的记录可以翻了。');
  assert.equal(R.stopped('limit', 10), '往前翻了 10 页还没找到这条消息，先停在这里；可以接着往上翻看。');
  assert.equal(R.stopped('failed', 1, '没能完成：服务出了点问题。'), '没能加载更早的消息：服务出了点问题。这条消息还没找到。');
  assert.equal(R.stopped('left', 2), '', 'another chat: nothing to say');
});

// The open chat's history (ids from newest page down to `first`), and a loader
// that draws `per` earlier rows above per page until `oldest`.
function page(opts: { newest?: number; first?: number; oldest?: number; per?: number; fail?: number; key?: string } = {}) {
  const doc = new Doc();
  const thread = doc.createElement('div');
  doc.body.append(thread);
  const key = opts.key ?? 'bot:团子';
  const inner = doc.createElement('div');
  inner.className = 'thread-inner';
  inner.dataset.chat = key;
  thread.append(inner);
  const per = opts.per ?? 5, oldest = opts.oldest ?? 1;
  let first = opts.first ?? 40;
  const rowFor = (n: number) => { const r = doc.createElement('div'); r.className = 'msg'; r.dataset.mid = 'm-' + n; r.dataset.seq = String(n); r.scrollIntoView = () => { scrolled.push(n); }; return r; };
  for (let n = first; n <= (opts.newest ?? 50); n++) inner.append(rowFor(n));
  const scrolled: number[] = [];
  const notes: Array<[string, boolean]> = [];
  let sel: Any = { type: 'bot', id: '团子' };
  const H: Any = { state: 'idle', error: '', loads: 0, fails: opts.fail ?? -1, wait: null as null | (() => Promise<void>) };
  const history = {
    older: () => ({ key: sel ? (sel.type === 'group' ? 'group:' : 'bot:') + sel.id : '', state: H.state, more: first > oldest, loaded: H.loads, error: H.error }),
    load: async () => {
      if (first <= oldest) return;
      H.state = 'loading';
      if (H.wait) await H.wait();
      H.loads++;
      if (H.loads === H.fails) { H.state = 'failed'; H.error = '服务出了点问题'; return; }
      const top = inner.firstChild;
      const from = Math.max(oldest, first - per);
      for (let n = from; n < first; n++) inner.insertBefore(rowFor(n), top);
      first = from;
      H.state = 'idle';
    },
  };
  const window: Any = {};
  const timers: Array<() => void> = [];
  vm.runInNewContext(read('client/public/chat-locate-rules.js') + read('client/public/chat-locate.js'), { window, document: doc, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; } });
  const L = window.ClowderLocate;
  const rested = { n: 0 };
  L.init({ thread, selected: () => sel, history, note: (text: string, busy = false) => notes.push([text, !!busy]), rest: () => { rested.n++; } });
  return { doc, thread, inner, L, notes, scrolled, H, history, timers, rested, setSel: (s: Any) => { sel = s; }, row: (n: number) => inner.querySelectorAll('.msg').find((r: El) => r.dataset.mid === 'm-' + n) };
}

test('a message on screen is centred, flashed and focused at once, with no note', async () => {
  const p = page();
  assert.equal(await p.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-45' }), true);
  const row = p.row(45)!;
  assert.deepEqual(p.scrolled, [45]);
  assert.ok(row.classList.contains('cx-hit'), 'the flash');
  assert.equal(p.doc.activeElement, row, 'focus on the row (polish.css draws the ring round its bubble)');
  assert.equal(row.getAttribute('tabindex'), '-1');
  assert.deepEqual(p.notes, [], 'nothing to say');
  assert.equal(p.H.loads, 0, 'no earlier page read');
  p.timers.forEach(fn => fn());
  assert.ok(!row.classList.contains('cx-hit'), 'the flash ends');
  // A quote's jump finds by seq the same way.
  assert.equal(await p.L.find({ sel: { type: 'bot', id: '团子' }, seq: 41 }), true);
  assert.equal(p.doc.activeElement, p.row(41));
});

test('further back: earlier pages through the history\'s loader until it is drawn, one quiet note that goes when found', async () => {
  const p = page({ first: 40, per: 5 });
  assert.equal(await p.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-31' }), true);
  assert.equal(p.H.loads, 2, 'two pages: 35–39, then 30–34');
  assert.deepEqual(p.notes, [['正在往前找这条消息…', true], ['正在往前找这条消息…已经翻了 1 页', true], ['', false]]);
  assert.equal(p.doc.activeElement, p.row(31));
  assert.deepEqual(p.scrolled, [31]);
});

test('a truthful stop: the start of the conversation, the page limit, a failed page', async () => {
  const end = page({ first: 40, oldest: 31, per: 5 });
  assert.equal(await end.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-2' }), null);
  assert.equal(end.H.loads, 2);
  assert.deepEqual(end.notes.at(-1), ['翻到了这段对话最早的消息，也没有找到这一条。', false]);
  assert.equal(end.rested.n, 1, 'focus left nowhere goes back to the composer (the shell does it only where no keyboard pops up)');

  const none = page({ first: 1, oldest: 1 });
  assert.equal(await none.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-999' }), null);
  assert.deepEqual(none.notes, [['这条消息不在这段对话里，也没有更早的记录可以翻了。', false]], 'a short chat: said at once, nothing read');

  const far = page({ first: 400, oldest: 1, per: 5 });
  assert.equal(await far.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-2' }), null);
  assert.equal(far.H.loads, 10, 'bounded');
  assert.deepEqual(far.notes.at(-1), ['往前翻了 10 页还没找到这条消息，先停在这里；可以接着往上翻看。', false]);

  const broken = page({ first: 40, per: 5, fail: 2 });
  assert.equal(await broken.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-2' }), null);
  assert.deepEqual(broken.notes.at(-1), ['没能加载更早的消息：服务出了点问题。这条消息还没找到。', false]);
});

test('another chat, or a newer search, ends a search quietly; a chat that is not open is not searched', async () => {
  const p = page({ first: 40, per: 5 });
  let release!: () => void;
  p.H.wait = () => new Promise<void>(r => { release = r; });
  const going = p.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-2' });
  await Promise.resolve();
  p.setSel({ type: 'bot', id: '栗子' });
  release();
  assert.equal(await going, null);
  assert.equal(p.notes.at(-1)![0], '', 'the progress note goes, nothing else is said');
  assert.equal(p.doc.activeElement, p.doc.body);

  const q = page({ first: 40, per: 5 });
  q.H.wait = () => new Promise<void>(r => { release = r; });
  const older = q.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-2' });
  await Promise.resolve();
  q.H.wait = null;
  const newer = q.L.find({ sel: { type: 'bot', id: '团子' }, messageId: 'm-45' });
  assert.equal(await newer, true);
  release();
  assert.equal(await older, null, 'the older search stops');
  assert.equal(q.doc.activeElement, q.row(45));

  assert.equal(await q.L.find({ sel: { type: 'group', id: 'g1' }, messageId: 'm-45' }), false, 'not the open chat');
});

test('wiring: the palette\'s locate and a quote\'s jump go through it; the palette says nothing more when it already said why', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), pal = read('client/public/palette.js'), hist = read('client/public/chat-history.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('chat-history.js') < scripts.indexOf('chat-locate-rules.js'));
  assert.equal(scripts.indexOf('chat-locate.js'), scripts.indexOf('chat-locate-rules.js') + 1);
  assert.ok(scripts.indexOf('chat-locate.js') < scripts.indexOf('app.js'));
  assert.match(app, /const locate = window\.ClowderLocate;/);
  assert.match(app, /locate\.init\(\{\n\s+thread,\n\s+selected: \(\) => \(state\.peer \? null : state\.sel\),\n\s+history: chatHistory,\n\s+note: \(text, busy\) => quietNote\(text, busy\),\n\s+rest: \(\) => \{ if \(window\.innerWidth >= 768\) input\.focus\(\{ preventScroll: true \}\); \},\n\s+\}\);/);
  assert.match(app, /window\.ClowderPalette\.locate = async \(\{ type, id, nativeId, messageId \}\) => \{[\s\S]*?return locate\.find\(\{ sel, messageId \}\);/);
  assert.match(app, /function jumpToSeq\(seq\) \{[\s\S]*?locate\.find\(\{ sel: state\.sel, seq: Number\(seq\) \}\)/);
  assert.match(pal, /ok = r === null \? null : !!r;/);
  assert.match(pal, /if \(ok === false\) note\(after \+ "这条消息不在已显示的消息里，可能在更早的记录里。"\);/);
  // The history hands the page already on its way to a second caller, and says where its pages stand.
  assert.match(hist, /function load\(\) \{\n\s+if \(P\.state === "loading" && job\) return job;\n\s+return \(job = loadPage\(\)\);\n\s+\}/);
  assert.match(hist, /older: \(\) => \(\{ key: P\.key, state: P\.state, more: !!nextCursor\(\), loaded: P\.loaded, error: P\.error \}\),/);
});
