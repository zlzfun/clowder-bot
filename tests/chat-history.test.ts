import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El, text } from './fake-dom.js';

// A conversation over time (chat-history-rules.js, chat-history.js): earlier
// pages joined above the newest one (GET …/transcript?before=, GET
// /xbot-api/groups/:id?before=), the header's ⋯ menu (新对话 = POST
// /xbot-api/bots/:name/new, 历史对话, 在对话里查找), and the suggestions under a
// cat's greeting. The rules run in a bare VM; the DOM module runs on
// tests/fake-dom.ts with the hooks app.js passes faked, and the history is
// drawn the way renderMessages draws it: rows, the module's top row and
// suggestions, then ClowderLive.commit (the real chat-live.js).
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-history-rules.js'), { window });
  return window.ClowderHistoryRules;
}
const msg = (n: number, role = n % 2 ? 'user' : 'assistant') => ({ id: 'm' + n, native_message_id: 'm' + n, role, content: '第 ' + n + ' 条', time: '2026-11-11T12:00:00Z' });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i));

// ---------------------------------------------------------------- rules
test('rows are known by their native message (a delivery row by its call); earlier rows stay joined above a newest page that moves on, and go when it no longer meets them', () => {
  const R = rules();
  assert.equal(R.rowKey({ id: 'a', native_message_id: 'n1', role: 'assistant' }), 'm:n1');
  assert.equal(R.rowKey({ role: 'tool', tool_call_id: 'delivery_n1' }), 'tool:delivery_n1');
  assert.equal(R.rowKey({ id: 'g7', kind: 'person' }), 'm:g7', 'a group row by its id');
  assert.equal(R.rowKey(null), '');
  const held = range(1, 20), was = range(21, 40);
  // Two new messages: the newest page now starts at 23; 21 and 22 join the earlier rows.
  assert.deepEqual(plain(R.stitch(held, was, range(23, 42)).map((m: Any) => m.id)), range(1, 22).map(m => m.id));
  // A row changed in place (a reply finished): the same join.
  assert.equal(R.stitch(held, was, [{ ...msg(21), content: 'changed' }, ...range(22, 40)]).length, 20);
  // More than a page came in: no join, so the earlier rows go (no hole is shown).
  assert.equal(R.stitch(held, was, range(100, 119)), null);
  assert.equal(R.stitch(held, was, []), null);
  assert.deepEqual(plain(R.stitch([], was, range(23, 42))), []);
  // An earlier page that overlaps at its edge adds only what is new.
  assert.deepEqual(plain(R.prepend(range(15, 22), range(21, 25), range(26, 30)).map((m: Any) => m.id)), [...range(15, 20), ...range(21, 25)].map(m => m.id));
});

test('the page before is asked for with the server\'s own cursor, on the transcript for a cat and on the group route for a group; a page answer is checked', () => {
  const R = rules();
  assert.equal(R.pagePath({ type: 'bot', id: '团子' }, '1794:m 1'), '/xbot-api/bots/%E5%9B%A2%E5%AD%90/transcript?before=1794%3Am%201');
  assert.equal(R.pagePath({ type: 'group', id: 'g/1' }, '5:x'), '/xbot-api/groups/g%2F1?before=5%3Ax');
  assert.equal(R.pagePath({ type: 'bot', id: 'a' }, ''), '');
  assert.deepEqual(plain(R.page({ messages: [msg(1)], hasMore: true, before: '1:m1', thread_id: 'T' })), { rows: [msg(1)], before: '1:m1', more: true, thread: 'T' });
  assert.equal(R.page({ messages: [], hasMore: true, before: null }).more, false, 'no cursor, no page before');
  assert.equal(R.page({ hasMore: true }), null);
});

test('suggestions show under the cat\'s greeting in a single chat until the owner says anything; not in a group, not while the cat writes, not with earlier records, not over a send on its way', () => {
  const R = rules();
  const bot = { type: 'bot', id: '团子' };
  const greet = { role: 'assistant', id: 'g', content: '你好呀' };
  assert.deepEqual(plain(R.STARTERS), ['你能帮我做些什么？', '帮我整理今天要做的事', '陪我聊聊天']);
  assert.equal(R.showStarters({ selection: bot, messages: [greet] }), true);
  assert.equal(R.showStarters({ selection: bot, messages: [greet, { role: 'tool', tool_call_id: 'x' }, { role: 'user', internal: true }] }), true, 'delivery rows and kernel notes are not the owner');
  assert.equal(R.showStarters({ selection: bot, messages: [] }), false, 'no greeting yet: nothing to sit under');
  assert.equal(R.showStarters({ selection: bot, messages: [greet, { role: 'user', id: 'u' }] }), false, 'the owner has said something');
  assert.equal(R.showStarters({ selection: bot, messages: [{ ...greet, in_progress: true }] }), false, 'the cat is still writing');
  assert.equal(R.showStarters({ selection: bot, messages: [{ ...greet, presentation_kind: 'activity' }] }), false, 'an execution record is not a greeting');
  assert.equal(R.showStarters({ selection: { type: 'group', id: 'g' }, messages: [greet] }), false);
  assert.equal(R.showStarters({ selection: bot, messages: [greet] }, { more: true }), false, 'earlier records exist');
  assert.equal(R.showStarters({ selection: bot, messages: [greet] }, { busy: true }), false, 'a send is on its way or failed');
});

// ---------------------------------------------------------------- the module
type Reply = { resolve: (v: Any) => void; reject: (e: Any) => void };
function page() {
  const doc = new Doc();
  const h = (tag: string, cls = '', id = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; };
  const main = h('main', 'main'), top = h('div', 'top-inner'), chip = h('button', 'top-title', 'head-chip');
  top.append(chip);
  const chat = h('div', 'chat'), thread = h('div', 'thread', 'thread'), dock = h('div', 'dock'), form = h('form', 'composer', 'composer'), input = h('div', 'composer-input', 'input');
  form.append(input);
  dock.append(form);
  chat.append(thread, dock);
  const panel = h('aside', 'panel', 'panel');
  main.append(top, chat, panel);
  doc.body.append(main);
  Object.assign(thread, { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400 });
  const window: Any = {
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
  };
  const context = vm.createContext({ window, document: doc, console, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1 });
  for (const file of ['client/public/chat-live-rules.js', 'client/public/chat-live.js', 'client/public/chat-history-rules.js', 'client/public/chat-history.js']) vm.runInContext(read(file), context);
  const live = window.ClowderLive, history = window.ClowderHistory;
  live.init({ thread, render: () => {}, row: () => h('div', 'msg bot live'), queued: () => false, busy: () => false, unread: () => '', changed: () => {}, gap: () => {} });
  // The server: answers queued per call, in order.
  const calls: Array<{ path: string; opt: Any }> = [];
  const pending: Reply[] = [];
  const api = (path: string, opt: Any) => { calls.push({ path, opt }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  const app: Any = { sel: null, newest: null, thread: 'T1', sent: [], toasts: [], statuses: [], reopened: [], reloads: 0, details: 0, working: false, files: 0, convs: null, sendBusy: false, placed: 0 };
  const key = (sel: Any) => (sel.type === 'group' ? 'group:' : 'bot:') + sel.id;
  // renderMessages / renderGroup, reduced to what matters here.
  const draw = (messages: Any[], read: Any = null) => {
    const inner = h('div', 'thread-inner');
    inner.dataset.chat = key(app.sel);
    for (const m of messages) { const r = h('div', 'msg ' + (m.role === 'user' ? 'user' : 'bot')); r.dataset.mid = m.id; r.textContent = m.content; inner.append(r); }
    history.top(inner);
    if (read) history.starters(inner, read);
    return live.commit(inner, []);
  };
  // loadThread: the newest page through merge, then a drawing.
  const poll = (data = app.newest, thread = app.thread) => {
    app.newest = data;
    const messages = history.merge(app.sel, thread, data);
    draw(messages, app.sel.type === 'bot' ? { selection: app.sel, messages } : null);
    return messages;
  };
  history.init({
    api, thread, visibleError: (e: Any) => (e && e.message) || '出错了',
    selected: () => app.sel,
    name: (sel: Any) => sel.id,
    reload: async () => { app.reloads++; poll(); },
    reopen: async (sel: Any) => { app.reopened.push(sel.id); },
    send: (t: string) => { app.sent.push(t); },
    sendBusy: () => app.sendBusy,
    working: () => app.working,
    pendingFiles: () => app.files,
    threadId: () => app.shown || '',
    conversations: async () => app.convs,
    openDetails: async () => { app.details++; },
    place: (anchor: El, menu: El) => { app.placed++; doc.body.append(menu); },
    toast: (t: string) => app.toasts.push(t),
    status: (t: string, bad: boolean) => app.statuses.push([t, bad]),
  });
  const open = (sel: Any) => { app.sel = sel; live.select(key(sel)); history.select(sel); };
  const answer = (v: Any) => pending.shift()!.resolve(v);
  const fail = (e: Any) => pending.shift()!.reject(e);
  const settle = () => new Promise((r) => setImmediate(r));
  const onScreen = () => thread.children[0] as El;
  const topRow = () => onScreen().querySelector('.ch-older');
  return { doc, window, history, live, thread, top, app, open, poll, draw, calls, answer, fail, settle, onScreen, topRow, form, panel, h };
}
const newest = (a: number, b: number, more = true) => ({ messages: range(a, b), hasMore: more, before: '1794:m' + a, thread_id: 'T1' });
const ids = (p: Any) => p.onScreen().querySelectorAll('.msg').map((r: El) => r.dataset.mid) as string[];

test('scrolling to the top loads the page before with the newest page\'s cursor; the top row says 正在加载 meanwhile, then the rows sit above without the ones there being redrawn', async () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' };
  p.open(cat);
  p.poll(newest(21, 40));
  assert.equal(p.topRow()!.dataset.older, 'idle');
  assert.equal(text(p.topRow()), '查看更早的消息');
  const kept = p.onScreen().querySelector('.msg[data-mid="m21"]')!;
  // The owner scrolls up near the top.
  p.thread.scrollTop = 100;
  p.thread.dispatch('scroll');
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0]!.path, '/xbot-api/bots/%E5%9B%A2%E5%AD%90/transcript?before=1794%3Am21');
  assert.equal(text(p.topRow()), '正在加载更早的消息…');
  assert.equal(p.topRow()!.getAttribute('role'), 'status');
  // Still scrolling while it loads: no second request.
  p.thread.dispatch('scroll');
  assert.equal(p.calls.length, 1);
  p.answer({ messages: range(1, 20), hasMore: true, before: '1794:m1', thread_id: 'T1' });
  await p.settle();
  assert.equal(p.app.reloads, 1, 'the shell reads the newest page again and draws');
  assert.deepEqual(ids(p), range(1, 40).map(m => m.id));
  assert.ok(p.onScreen().querySelector('.msg[data-mid="m21"]') === kept, 'a row already there keeps its element');
  assert.ok(p.onScreen().querySelector('.msg[data-mid="m5"]')!.classList.contains('lv-still'), 'earlier rows do not rise in as if new');
  assert.equal(text(p.topRow()), '查看更早的消息', 'there is more before');
  // The button asks for the next page with the cursor of the oldest one held.
  p.topRow()!.querySelector('button')!.click();
  assert.equal(p.calls[1]!.path, '/xbot-api/bots/%E5%9B%A2%E5%AD%90/transcript?before=1794%3Am1');
  p.answer({ messages: [], hasMore: false, before: null, thread_id: 'T1' });
  await p.settle();
  assert.equal(text(p.topRow()), '没有更早的消息了');
  assert.equal(p.history.peek().cursor, '');
});

test('the newest page keeps polling: earlier rows stay joined above it with nothing doubled; when more than a page arrived meanwhile they go; another conversation starts over', async () => {
  const p = page();
  p.open({ type: 'bot', id: '团子' });
  p.poll(newest(21, 40));
  p.history.load();
  p.answer({ messages: range(1, 20), hasMore: false, before: '1794:m1', thread_id: 'T1' });
  await p.settle();
  assert.equal(ids(p).length, 40);
  // Two new messages.
  p.poll(newest(23, 42));
  assert.deepEqual(ids(p), range(1, 42).map(m => m.id));
  // A burst larger than a page: the earlier pages no longer meet the newest one.
  p.poll(newest(100, 119));
  assert.deepEqual(ids(p), range(100, 119).map(m => m.id));
  assert.equal(p.history.peek().held, 0);
  assert.equal(text(p.topRow()), '查看更早的消息');
  // A new conversation (another thread) never shows the old one's pages.
  p.history.load();
  p.answer({ messages: range(80, 99), hasMore: true, before: '1794:m80', thread_id: 'T1' });
  await p.settle();
  assert.equal(p.history.peek().held, 20);
  p.app.thread = 'T2';
  p.poll({ messages: [msg(1)], hasMore: false, before: '1:m1', thread_id: 'T2' }, 'T2');
  assert.equal(p.history.peek().held, 0);
  assert.ok(p.topRow() === null, 'a short chat says nothing at its top');
});

test('a failed page says so with the reason and 重试 asks for the same page again; an answer for a chat left behind changes nothing', async () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' };
  p.open(cat);
  p.poll(newest(21, 40));
  p.history.load();
  p.fail(Object.assign(new Error('服务出了点问题，请稍后再试。'), { status: 503 }));
  await p.settle();
  assert.equal(p.topRow()!.dataset.older, 'failed');
  assert.equal(p.topRow()!.getAttribute('role'), 'alert');
  assert.match(text(p.topRow()), /^没能加载更早的消息：服务出了点问题，请稍后再试重试$/);
  // The row changed in place: the next drawing reads it again and keeps it.
  const row = p.topRow();
  p.poll();
  assert.ok(p.topRow() === row, 'the redraw keeps the row it was told changed');
  p.topRow()!.querySelector('button')!.click();
  assert.equal(p.calls.at(-1)!.path, p.calls[0]!.path);
  // The owner opens another chat before the answer: it lands nowhere.
  p.open({ type: 'bot', id: '栗子' });
  p.answer({ messages: range(1, 20), hasMore: false, before: '1794:m1', thread_id: 'T1' });
  await p.settle();
  assert.equal(p.history.peek().held, 0);
  assert.equal(p.app.reloads, 0);
});

test('a group asks for its earlier page on the group route; a page of records with no rows asks for the next by itself, a few times at most', async () => {
  const p = page();
  p.open({ type: 'group', id: 'g1' });
  p.app.thread = 'g1';
  p.poll({ messages: range(21, 40), hasMore: true, before: '5:m21' });
  p.history.load();
  assert.equal(p.calls[0]!.path, '/xbot-api/groups/g1?before=5%3Am21');
  p.answer({ messages: [], hasMore: true, before: '4:m0', group: { id: 'g1' } });
  await p.settle();
  assert.equal(p.calls[1]!.path, '/xbot-api/groups/g1?before=4%3Am0', 'nothing to show on that page: the one before');
  for (let i = 0; i < 3; i++) { p.answer({ messages: [], hasMore: true, before: '3:x' + i }); await p.settle(); }
  assert.equal(p.calls.length, 4, 'it stops after a few empty pages; the button is still there');
  assert.equal(text(p.topRow()), '查看更早的消息');
});

test('suggestions sit under the greeting, send on a tap and go; a send from the composer takes them away too', () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' };
  p.open(cat);
  const data = { messages: [{ id: 'g', role: 'assistant', content: '你好呀' }], hasMore: false, before: '1:g', thread_id: 'T1' };
  p.poll(data);
  const box = p.onScreen().querySelector('.ch-starters')!;
  assert.equal(box.getAttribute('role'), 'group');
  assert.ok(p.onScreen().children.at(-1) === box, 'under the greeting');
  assert.deepEqual(box.querySelectorAll('.starter').map((b: El) => text(b)), ['你能帮我做些什么？', '帮我整理今天要做的事', '陪我聊聊天']);
  // Redrawn from the next poll: the same element (no rise again).
  p.poll(data);
  assert.ok(p.onScreen().querySelector('.ch-starters') === box, 'the same element');
  box.querySelectorAll('.starter')[1]!.click();
  assert.deepEqual(p.app.sent, ['帮我整理今天要做的事']);
  assert.ok(p.onScreen().querySelector('.ch-starters') === null, 'no suggestions');
  // Back again with nothing said yet (say the send failed and was retried later): a composer send removes them.
  p.poll(data);
  assert.ok(p.onScreen().querySelector('.ch-starters'));
  const input = p.doc.getElementById('input')!;
  p.form.dispatch('submit');
  assert.ok(p.onScreen().querySelector('.ch-starters'), 'an Enter in an empty composer sends nothing and leaves them');
  input.textContent = '我自己说';
  p.form.dispatch('submit');
  assert.ok(p.onScreen().querySelector('.ch-starters') === null, 'no suggestions');
  input.textContent = '';
  // A send on its way or failed, or a newest page with more before it: none.
  p.app.sendBusy = true;
  p.poll(data);
  assert.ok(p.onScreen().querySelector('.ch-starters') === null, 'no suggestions');
  p.app.sendBusy = false;
  p.poll({ ...data, hasMore: true });
  assert.ok(p.onScreen().querySelector('.ch-starters') === null, 'no suggestions');
});

test('the header\'s ⋯: 新对话 and 历史对话 for a cat, 在对话里查找 only when the search palette is there (scoped to this chat); a group without it has no ⋯; arrows move, Escape closes back to ⋯', () => {
  const p = page();
  const more = p.top.querySelector('.ch-more')!;
  assert.equal(more.getAttribute('aria-haspopup'), 'menu');
  assert.equal(more.hidden, true, 'no chat open');
  p.open({ type: 'bot', id: '团子' });
  assert.equal(more.hidden, false);
  assert.ok(p.top.classList.contains('ch-has-more'));
  more.click();
  const menu = () => p.doc.querySelector('.ch-menu');
  assert.deepEqual(menu()!.querySelectorAll('.menu-row').map((b: El) => text(b)), ['新对话', '历史对话']);
  assert.equal(menu()!.getAttribute('role'), 'menu');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.ok(p.doc.activeElement === menu()!.querySelector('.menu-row'), 'focus on the first item');
  // Keys stay in the menu; Escape is consumed (nothing behind it closes).
  let behind = 0;
  p.doc.addEventListener('keydown', () => { behind++; });
  (p.doc.activeElement as El).key('ArrowDown');
  assert.equal(text(p.doc.activeElement as El), '历史对话');
  (p.doc.activeElement as El).key('ArrowDown');
  assert.equal(text(p.doc.activeElement as El), '新对话', 'wraps');
  behind = 0;
  (p.doc.activeElement as El).key('Escape');
  assert.ok(menu() === null, 'menu closed');
  assert.ok(p.doc.activeElement === more, 'focus back on ⋯');
  assert.equal(behind, 0);
  // With the palette: 在对话里查找 opens it on this chat.
  const opened: Any[] = [];
  p.window.ClowderPalette = { open: (o: Any) => opened.push(o) };
  more.click();
  menu()!.querySelector('[data-item="find"]')!.click();
  assert.deepEqual(plain(opened), [{ scope: { type: 'bot', id: '团子' } }]);
  assert.ok(menu() === null, 'menu closed');
  // A group: only 在对话里查找, and no ⋯ at all without the palette.
  p.open({ type: 'group', id: 'g1' });
  more.click();
  assert.deepEqual(menu()!.querySelectorAll('.menu-row').map((b: El) => text(b)), ['在对话里查找']);
  more.click();
  delete p.window.ClowderPalette;
  p.open({ type: 'group', id: 'g1' });
  assert.equal(more.hidden, true);
  assert.ok(!p.top.classList.contains('ch-has-more'));
});

test('新对话 says the old conversation stays under 历史对话 and what the cat remembers is kept; it starts only when the cat is idle, then opens the chat afresh', async () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' };
  p.open(cat);
  const more = p.top.querySelector('.ch-more')!;
  const start = () => { more.click(); p.doc.querySelector('.ch-menu [data-item="new"]')!.click(); return p.doc.querySelector('.ch-modal')!; };
  p.app.files = 2;
  let d = start();
  assert.equal(text(d.querySelector('h2')), '和团子开始新对话');
  assert.deepEqual(d.querySelectorAll('.ch-note').map((n: El) => text(n)), ['现在这段对话会留在「历史对话」里，随时能回去接着聊；团子记住的事都还在。', '待发送的 2 个附件会被移除。']);
  assert.equal(d.querySelector('.modal-card')!.getAttribute('aria-modal'), 'true');
  // Escape closes it, back to ⋯.
  d.key('Escape');
  assert.ok(p.doc.querySelector('.ch-modal') === null, 'dialog closed');
  assert.ok(p.doc.activeElement === more, 'focus back on ⋯');
  // Busy: said in the dialog, nothing is asked of the server.
  p.app.files = 0;
  p.app.working = true;
  d = start();
  d.querySelector('button[type="submit"]')!.click();
  assert.equal(text(d.querySelector('.error')), '团子还在忙这段对话。等它做完，或者先点停止，再开始新对话。');
  assert.equal(p.calls.length, 0);
  // Idle: the native move to a new conversation; the dialog holds while it is asked.
  p.app.working = false;
  d.querySelector('button[type="submit"]')!.click();
  assert.deepEqual(plain(p.calls[0]), { path: '/xbot-api/bots/%E5%9B%A2%E5%AD%90/new', opt: { method: 'POST' } });
  assert.equal(d.querySelector('button[type="submit"]')!.disabled, true);
  d.key('Escape');
  assert.ok(p.doc.querySelector('.ch-modal'), 'not closed mid-request');
  p.answer({ status: 'ok', conversation_id: 'T2' });
  await p.settle();
  assert.ok(p.doc.querySelector('.ch-modal') === null, 'dialog closed');
  assert.deepEqual(p.app.reopened, ['团子']);
  assert.deepEqual(p.app.toasts, ['已开始新对话']);
});

test('新对话 refused or unsure: busy in the server\'s eyes is said plainly, a switch in progress asks to wait, and no answer says it may have started and reads the chat again', async () => {
  const p = page();
  p.open({ type: 'bot', id: '团子' });
  const more = p.top.querySelector('.ch-more')!;
  more.click();
  p.doc.querySelector('.ch-menu [data-item="new"]')!.click();
  const d = p.doc.querySelector('.ch-modal')!;
  const submit = () => d.querySelector('button[type="submit"]')!.click();
  submit();
  p.fail(Object.assign(new Error('这段对话里还有事在做，等它做完或先停止再试'), { status: 409 }));
  await p.settle();
  assert.equal(text(d.querySelector('.error')), '团子还在忙这段对话。等它做完，或者先点停止，再开始新对话。');
  submit();
  p.fail(Object.assign(new Error('对话正在切换，请稍后重试'), { status: 409 }));
  await p.settle();
  assert.equal(text(d.querySelector('.error')), '正在切换对话，稍等一下再试。');
  submit();
  p.fail(new Error('连不上 clowder-bot'));
  await p.settle();
  assert.equal(text(d.querySelector('.error')), '没能确认新对话有没有开始。先看一眼对话，再决定要不要重试。');
  assert.equal(p.app.reloads, 1);
  assert.deepEqual(p.app.reopened, []);
  assert.ok(p.doc.querySelector('.ch-modal'), 'the owner decides');
});

const app_shown = (p: Any, thread: string) => { p.app.shown = thread; };

test('新对话 from another entry (the drawer\'s 资料) is the same dialog: it names the conversation on screen once, a retry after a lost answer cannot start a second one, and focus returns to that entry', async () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' };
  p.open(cat);
  const entry = p.h('button', 'pf-new');
  p.panel.append(entry);
  app_shown(p, 'T1');
  p.window.ClowderHistory.newConversation(cat, entry);
  let d = p.doc.querySelector('.ch-modal')!;
  assert.equal(text(d.querySelector('h2')), '和团子开始新对话');
  d.key('Escape');
  assert.ok(p.doc.activeElement === entry, 'focus back on the drawer\'s 新对话');
  // The dialog names T1, the conversation on screen when it opened.
  p.window.ClowderHistory.newConversation(cat, entry);
  d = p.doc.querySelector('.ch-modal')!;
  const submit = () => d.querySelector('button[type="submit"]')!.click();
  submit();
  assert.deepEqual(plain(p.calls[0]), { path: '/xbot-api/bots/%E5%9B%A2%E5%AD%90/new', opt: { method: 'POST', body: { expectedThreadId: 'T1' } } });
  // The answer is lost, though the request did start T2; the chat reads again and now shows T2 (review 2026-11-11, item 3).
  p.fail(new Error('连不上 clowder-bot'));
  await p.settle();
  assert.equal(text(d.querySelector('.error')), '没能确认新对话有没有开始。先看一眼对话，再决定要不要重试。');
  app_shown(p, 'T2');
  // A retry must not start T3: no request, the change is said, and the owner starts over.
  submit();
  await p.settle();
  assert.equal(p.calls.length, 1, 'nothing more is sent');
  assert.equal(text(d.querySelector('.error')), '这段对话刚换过了，没有再开新对话。先看一眼对话；还要开新对话的话，关掉这里再点一次「新对话」。');
  submit();
  assert.equal(p.calls.length, 1, 'still nothing: a new 新对话 is needed');
  d.key('Escape');
  // Opened again, the dialog names T2; the server saying it changed (one opened elsewhere) ends this dialog's attempt too.
  p.window.ClowderHistory.newConversation(cat, entry);
  d = p.doc.querySelector('.ch-modal')!;
  submit();
  assert.deepEqual(plain(p.calls[1].opt), { method: 'POST', body: { expectedThreadId: 'T2' } });
  p.fail(Object.assign(new Error('对话已变化，请刷新后重试'), { status: 409 }));
  await p.settle();
  assert.equal(text(d.querySelector('.error')), '这段对话刚换过了，没有再开新对话。先看一眼对话；还要开新对话的话，关掉这里再点一次「新对话」。');
  assert.equal(p.app.reloads, 2);
  submit();
  assert.equal(p.calls.length, 2);
  assert.deepEqual(p.app.reopened, []);
});

test('历史对话 opens the cat\'s 资料 on its saved conversations and puts focus there; a list that cannot be read is said', async () => {
  const p = page();
  p.open({ type: 'bot', id: '团子' });
  const fold = p.h('details', 'ws-conv-fold'), sum = p.h('summary');
  fold.append(sum);
  p.panel.append(fold);
  const more = p.top.querySelector('.ch-more')!;
  p.app.convs = 2;
  more.click();
  p.doc.querySelector('.ch-menu [data-item="past"]')!.click();
  await p.settle();
  assert.equal(p.app.details, 1);
  assert.ok(p.doc.activeElement === sum, 'focus on 历史对话');
  p.app.convs = null;
  more.click();
  p.doc.querySelector('.ch-menu [data-item="past"]')!.click();
  await p.settle();
  assert.deepEqual(p.app.statuses, [['没能读取历史对话，稍后再试。', true]]);
});

test('while 新对话 is asked, focus stays in the dialog and everything behind it is out of reach; when the answer settles focus returns to its button', async () => {
  const p = page();
  const cat = { type: 'bot', id: '团子' };
  p.open(cat);
  p.app.shown = 'T1';
  const more = p.top.querySelector('.ch-more')!;
  more.click();
  p.doc.querySelector('.ch-menu [data-item="new"]')!.click();
  const root = p.doc.querySelector('.ch-modal')!, card = root.querySelector('.modal-card')!, ok = card.querySelector('button[type="submit"]')!;
  const main = p.doc.querySelector('main')!;
  assert.equal(main.inert, true, 'the page behind is inert while the dialog is open');
  ok.focus();
  ok.click();
  assert.equal(ok.disabled, true);
  assert.ok(p.doc.activeElement === card, 'focus rests on the dialog, not on a disabled button');
  const tab = root.querySelector('.modal-card')!.key('Tab');
  assert.equal(tab.defaultPrevented, true, 'Tab has nowhere to go but the dialog');
  assert.ok(p.doc.activeElement === card);
  p.fail(Object.assign(new Error('这段对话里还有事在做，等它做完或先停止再试'), { status: 409 }));
  await p.settle();
  assert.ok(p.doc.activeElement === ok, 'back on its button once it can be pressed again');
  card.key('Escape');
  assert.equal(main.inert, false, 'the page is reachable again when the dialog closes');
  assert.ok(p.doc.activeElement === more);
});

test('the ⋯ menu survives a sidebar redraw (which removes every sidebar menu): it stays open with focus and its state until closed', () => {
  const p = page();
  p.open({ type: 'bot', id: '团子' });
  const more = p.top.querySelector('.ch-more')!;
  more.click();
  const menu = p.doc.querySelector('.ch-menu')!;
  const focused = p.doc.activeElement;
  // renderLists, on a status change (an unread dot), clears the sidebar's menus with exactly this.
  const app = read('client/public/app.js');
  const clear = /document\.querySelectorAll\("\.folder-menu"\)\.forEach\(\(menu\) => menu\.remove\(\)\);/.exec(app);
  assert.ok(clear, 'renderLists still clears .folder-menu');
  p.doc.querySelectorAll('.folder-menu').forEach((m: El) => m.remove());
  assert.ok(menu.isConnected, 'the header menu is not one of them');
  assert.ok(p.doc.activeElement === focused);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  (p.doc.activeElement as El).key('Escape');
  assert.ok(!menu.isConnected && more.getAttribute('aria-expanded') === 'false' && p.doc.activeElement === more);
});

test('a poll that moves the newest page on while the first earlier page is asked for leaves no hole: the answer joins the page its cursor came from', async () => {
  const p = page();
  p.open({ type: 'bot', id: '团子' });
  p.poll(newest(21, 40));
  p.history.load();
  assert.equal(p.calls[0]!.path, '/xbot-api/bots/%E5%9B%A2%E5%AD%90/transcript?before=1794%3Am21');
  // Two messages arrive before the answer: the newest page is now 23–42.
  p.poll(newest(23, 42));
  p.answer({ messages: range(1, 20), hasMore: false, before: '1794:m1', thread_id: 'T1' });
  await p.settle();
  assert.deepEqual(ids(p), range(1, 42).map(m => m.id), '21 and 22 are there');
  assert.equal(text(p.topRow()), '没有更早的消息了');
  // If more than a page came in meanwhile, the pages no longer meet: it starts over instead of showing a hole.
  const q = page();
  q.open({ type: 'bot', id: '团子' });
  q.poll(newest(21, 40));
  q.history.load();
  q.poll(newest(300, 319));
  q.answer({ messages: range(1, 20), hasMore: false, before: '1794:m1', thread_id: 'T1' });
  await q.settle();
  assert.deepEqual(ids(q), range(300, 319).map(m => m.id));
  assert.equal(text(q.topRow()), '查看更早的消息');
});

test('a newest page whose records show no rows keeps the earlier rows loaded above it (its native boundary is the seam), and an empty group view offers them instead of 没有消息', async () => {
  const R = rules();
  const held = range(1, 20);
  assert.deepEqual(plain(R.stitch(held, [], [], { was: '5:x', now: '5:x' })).length, 20, 'same boundary: still joined');
  assert.equal(plain(R.stitch(held, [], [msg(100)], { was: '5:x', now: '6:y' })).length, 20, 'a visible message after hidden ones: joined below');
  assert.equal(R.stitch(held, [], [], { was: '6:y', now: '5:x' }), null, 'a boundary that moved back is a break');
  assert.equal(R.stitch(held, range(21, 22), [], { was: '5:x', now: '6:y' }), null, 'rows that were shown and are gone: a break');
  assert.equal(R.order('1794:m1'), 1794);
  assert.equal(R.order('nope'), null);
  // In the module: an empty single chat with records behind it.
  const p = page();
  p.open({ type: 'bot', id: '团子' });
  const empty = { messages: [], hasMore: true, before: '5:x', thread_id: 'T1' };
  p.poll(empty);
  assert.equal(text(p.topRow()), '查看更早的消息');
  p.history.load();
  assert.equal(p.calls[0]!.path, '/xbot-api/bots/%E5%9B%A2%E5%AD%90/transcript?before=5%3Ax');
  p.answer({ messages: range(1, 20), hasMore: false, before: '1:m1', thread_id: 'T1' });
  await p.settle();
  assert.deepEqual(ids(p), range(1, 20).map(m => m.id), 'the earlier rows show and stay');
  p.poll(empty);
  assert.equal(ids(p).length, 20, 'the next poll keeps them');
  p.poll({ messages: [msg(100)], hasMore: true, before: '6:y', thread_id: 'T1' });
  assert.deepEqual(ids(p), [...range(1, 20).map(m => m.id), 'm100']);
  // The group view: renderGroup's empty branch draws the top row instead of 没有消息 when there is one.
  const app = read('client/public/app.js');
  assert.match(app, /if \(!chatHistory\.top\(inner\)\) inner\.append\(emptyState\(niceName\(who\) \|\| "群聊", "还没有消息"/);
  const g = page();
  g.open({ type: 'group', id: 'g1' });
  g.app.thread = 'g1';
  g.history.merge({ type: 'group', id: 'g1' }, 'g1', { messages: [], hasMore: true, before: '5:x' });
  const inner = g.h('div', 'thread-inner');
  assert.equal(g.history.top(inner), true);
  assert.equal(text(inner.children[0]), '查看更早的消息');
  g.history.merge({ type: 'group', id: 'g1' }, 'g1', { messages: [], hasMore: false, before: null });
  assert.equal(g.history.top(g.h('div')), false, 'nothing before: the empty view says 没有消息 as before');
});

// ---------------------------------------------------------------- chat-live.js
test('the keyed redraw counts only rows that arrived below as new: earlier history brought in on top neither rises nor counts (so 回到最新 does not light up)', () => {
  const p = page();
  p.open({ type: 'bot', id: '团子' });
  p.draw(range(21, 22));
  const result = p.draw([...range(18, 22), msg(23)]);
  assert.deepEqual(plain(result), { added: 1, first: false });
  for (const n of [18, 19, 20]) assert.ok(p.onScreen().querySelector(`.msg[data-mid="m${n}"]`)!.classList.contains('lv-still'), 'm' + n);
  assert.ok(!p.onScreen().querySelector('.msg[data-mid="m23"]')!.classList.contains('lv-still'), 'a new row below still rises');
  // A first message in an empty history is news, not earlier history.
  p.open({ type: 'bot', id: '栗子' });
  p.draw([]);
  const first = p.draw([msg(1)]);
  assert.equal(first.added, 1);
  assert.ok(!p.onScreen().querySelector('.msg[data-mid="m1"]')!.classList.contains('lv-still'));
});

// ---------------------------------------------------------------- app.js
test('the shell joins earlier pages in both reads, draws the top row and suggestions before the keyed commit, starts the module over with each chat, and wires 新对话 to the existing native route', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/chat-history.css'), ws = read('client/public/workspace.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const pos = (name: string) => scripts.indexOf(name);
  assert.ok(pos('chat-list.js') < pos('chat-history-rules.js') && pos('chat-history-rules.js') < pos('chat-history.js') && pos('chat-history.js') < pos('app.js'));
  assert.match(app, /const messages = chatHistory\.merge\(selection, data\.thread_id, data\);/);
  assert.match(app, /const messages = chatHistory\.merge\(selection, data\.group\?\.native_thread_id \|\| data\.group\?\.id, data\);/);
  assert.equal((app.match(/chatHistory\.top\(inner\);/g) || []).length, 3, 'single chats drawn or empty, and groups');
  assert.match(app, /chatHistory\.top\(inner\);\n\s+chatHistory\.starters\(inner, read\);\n\s+\/\/[^\n]*\n\s+const shown = live\.commit\(inner, keep\);/);
  assert.match(app, /live\.select\(chatKey\(state\.sel\)\);\n[^\n]*\n\s+chatHistory\.select\(state\.sel\);/);
  assert.match(app, /send: \(text\) => sendText\(text, null, \[\], null\)/);
  assert.match(app, /working: \(\) => !!state\.streaming \|\| chatWorking\(\)/);
  // 历史对话 is the existing list, there once read (on 资料 and when asked for), even with one conversation.
  assert.match(ws, /async function openConversations\(\)/);
  assert.match(ws, /const show = list\.length > 0 && S\.convState !== "unavailable";/);
  // The only request the module adds besides earlier pages is the existing new-conversation route.
  const mod = read('client/public/chat-history.js');
  assert.equal((mod.match(/H\.api\(/g) || []).length, 2);
  assert.match(mod, /H\.api\(R\.pagePath\(sel, cursor\)\)/);
  assert.match(mod, /H\.api\("\/xbot-api\/bots\/" \+ encodeURIComponent\(sel\.id\) \+ "\/new", expected \? \{ method: "POST", body: \{ expectedThreadId: expected \} \} : \{ method: "POST" \}\)/);
  assert.match(app, /threadId: \(\) => workspace\.threadId\(\),/);
  // What the owner reads (every string with Chinese in it) speaks of 猫猫 and 对话, never the engine.
  const said = [...(mod + read('client/public/chat-list.js') + read('client/public/chat-list-rules.js') + read('client/public/chat-history-rules.js')).matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)].map(m => m[1]);
  assert.ok(said.length > 20);
  for (const s of said) assert.doesNotMatch(s, /Bot|Agent|session|thread|原生|会话|线程/i, s);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
