import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 确认与提醒 (chat-cards-rules.js, chat-cards.js, chat-notify-rules.js,
// chat-notify.js; contracts docs/chat-experience-api.md 「等你确认的事」
// 「卡片、清单与选项」 and docs/chat-live-api.md). The rules run in a bare VM;
// the DOM modules run as the classic scripts they are, on a small DOM, with
// the real chat-live.js doing the history's keyed commit. app.js is not
// loaded: its hooks are faked the way it passes them, and static checks cover
// its wiring.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((done) => setImmediate(done));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-cards-rules.js'), { window });
  return window.ClowderCardsRules;
}
function notifyRules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-notify-rules.js'), { window });
  return window.ClowderNotifyRules;
}

// ------------------------------------------------------------ choice wording
test('a pick is worded exactly as the engine\'s own web client words it (upstream buildSelectionMessage cases and the contract\'s)', () => {
  const R = rules();
  const b = R.buildSelectionMessage;
  // The upstream test cases (packages/web/src/components/__tests__/interactive-block.test.ts), one for one.
  assert.equal(b('select', [{ id: 'a', label: '方案 A' }, { id: 'b', label: '方案 B' }], ['a']), '我选了：方案 A');
  assert.equal(b('select', [{ id: 'a', label: '方案 A' }], ['a'], undefined, '选一个方案'), '我选了：方案 A（选一个方案）');
  assert.equal(b('multi-select', [{ id: 'a', label: 'Node.js' }, { id: 'b', label: 'pnpm' }], ['a', 'b']), '我选了：Node.js, pnpm');
  assert.equal(b('card-grid', [{ id: 'a', label: '猫猫盲盒', emoji: '🎲' }], ['a']), '我选了：🎲 猫猫盲盒');
  assert.equal(b('confirm', [], ['__confirm__']), '确认');
  assert.equal(b('confirm', [], ['__cancel__']), '取消');
  assert.equal(b('confirm', [], ['__confirm__'], undefined, '确认部署到生产环境？'), '确认 — 确认部署到生产环境？');
  assert.equal(b('confirm', [], ['__cancel__'], undefined, '删除分支？'), '取消 — 删除分支？');
  assert.equal(b('select', [{ id: 'a', label: '宪宪' }], ['a'], '我选了 {selection} 作为引导猫'), '我选了 宪宪 作为引导猫');
  assert.equal(b('multi-select', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], ['c', 'a']), '我选了：C, A');
  assert.equal(b('select', [{ id: 'other', label: '我有其他想法' }], ['other'], undefined, undefined, '我觉得应该用 5 组'), '我有其他想法：我觉得应该用 5 组');
  assert.equal(b('select', [{ id: 'other', label: '其他' }], ['other'], undefined, 'Hub 分几组', '六组最好'), '其他：六组最好（Hub 分几组）');
  assert.equal(b('select', [{ id: 'a', label: '方案 A' }], ['a'], undefined, undefined, ''), '我选了：方案 A');
  // The contract's own: the typed text alone when nothing else is picked; a confirm block's first option confirms.
  assert.equal(b('select', [], [], undefined, '标题', '只有字'), '只有字（标题）');
  assert.equal(b('confirm', [{ id: 'go', label: '开始' }, { id: 'no', label: '先不用' }], ['go'], undefined, '开始整理资料'), '确认 — 开始整理资料');
  assert.equal(b('confirm', [{ id: 'go', label: '开始' }, { id: 'no', label: '先不用' }], ['no']), '取消');
  // A chat block by its mode; the preview's own choice with its template.
  const weekend = { mode: 'single', title: '周末安排', template: '我选 {selection}', options: [{ id: 'home', label: '在家看书', emoji: '📚' }, { id: 'park', label: '去公园', emoji: '🌳' }, { id: 'other', label: '别的', custom: true }] };
  assert.equal(R.choiceMessage(weekend, ['park']), '我选 🌳 去公园');
  assert.equal(R.choiceMessage(weekend, ['other'], '去爬山'), '别的：去爬山（周末安排）', 'typed words take precedence over the template, as upstream');
  assert.equal(R.choiceMessage({ mode: 'confirm', title: '开始整理资料', options: [{ id: '__confirm__', label: '开始' }, { id: '__cancel__', label: '先不用' }] }, ['__cancel__']), '取消 — 开始整理资料');
  assert.equal(R.choiceMessage({ mode: 'multiple', options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] }, ['b', 'a']), '我选了：乙, 甲');
});

test('a pick the server accepts: one for a single choice or a confirmation, one to max for a multiple choice, each once and each listed', () => {
  const R = rules();
  const single = { mode: 'single', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  const many = { mode: 'multiple', max: 2, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] };
  assert.equal(R.canPick(single, ['a']), true);
  assert.equal(R.canPick(single, ['a', 'b']), false);
  assert.equal(R.canPick(single, []), false);
  assert.equal(R.canPick(single, ['x']), false, 'an option that is not in the block');
  assert.equal(R.canPick(many, ['c', 'a']), true);
  assert.equal(R.canPick(many, ['a', 'b', 'c']), false, 'more than max');
  assert.equal(R.canPick(many, ['a', 'a']), false, 'the same option twice');
});

// ------------------------------------------------------------ request cards
const fact = (state?: string) => ({ id: 'card-1', kind: 'card', title: '提议捕捉品味信号', body: 'Taste [authentic-expression]: 回答简短、先说结论', approval: { id: 'p1', ...(state ? { state } : {}) } });
const pref = { id: 'p1', kind: 'preference', title: '团子想记住你的一个偏好', body: '回答简短一点，先说结论', quote: '记住我喜欢简短', catName: '团子', messageId: 'm-card', approve: { label: '记住' }, reject: { label: '不用记' }, note: '', expiresAt: 0 };

test('the open list is checked: open requests with their labels; anything else is dropped, never guessed', () => {
  const R = rules();
  const got = R.approvals({ threadId: 't', approvals: [
    { id: 'p1', kind: 'preference', title: ' 团子想记住\n你的一个偏好 ', body: '回答简短', messageId: 'm1', state: 'open', approve: { label: '记住' }, reject: { label: '不用记' }, createdAt: 1700000000 },
    { id: 'p2', kind: 'mystery', title: 'x', body: '', messageId: 'm2', approve: null, reject: null, note: '这一项要在运行面板里回答' },
    { id: 'p3', kind: 'schedule', messageId: 'm3', state: 'approved' },
    { kind: 'other', messageId: 'm4' }, null,
  ] });
  assert.equal(got.threadId, 't');
  assert.deepEqual(plain(got.list.map((i: Any) => [i.id, i.kind, i.title, i.approve, i.reject, i.createdAt])), [
    ['p1', 'preference', '团子想记住 你的一个偏好', { label: '记住' }, { label: '不用记' }, 1700000000000],
    ['p2', 'other', 'x', null, null, 0],
  ]);
  assert.equal(R.approvals({ approvals: 'no' }), null);
  assert.equal(R.approvals(null), null);
});

test('a request card is open with the server\'s labels, says where to go when it cannot be agreed here, and is never optimistic about an answer', () => {
  const R = rules();
  const open = R.card({ fact: fact(), item: pref, list: 'ready', now: 1 });
  assert.equal(open.mode, 'ask');
  assert.deepEqual(plain(open.actions), [{ decision: 'reject', label: '不用记' }, { decision: 'approve', label: '记住' }]);
  assert.deepEqual([open.title, open.body, open.quote, open.note, open.runtime], ['团子想记住你的一个偏好', '回答简短一点，先说结论', '记住我喜欢简短', '', false]);
  // Agreeing is not possible here (a profile update): its note and the runtime panel, never a dead button; 不用 stays.
  const profile = R.card({ fact: fact(), item: { ...pref, kind: 'profile', approve: null, reject: { label: '不用' }, note: '这一项要在运行面板里核对后才能同意' }, list: 'ready' });
  assert.deepEqual(plain(profile.actions), [{ decision: 'reject', label: '不用' }]);
  assert.deepEqual([profile.note, profile.runtime], ['这一项要在运行面板里核对后才能同意', true]);
  const question = R.card({ fact: fact(), item: { ...pref, kind: 'question', approve: null, reject: null, note: '这一项要在运行面板里回答' }, list: 'ready' });
  assert.deepEqual([question.actions.length, question.note, question.runtime], [0, '这一项要在运行面板里回答', true]);
  // In flight: busy, still the card, no outcome.
  const sending = R.card({ fact: fact(), item: pref, list: 'ready', local: { phase: 'sending', decision: 'approve', at: 5 } });
  assert.deepEqual([sending.mode, sending.busy], ['ask', 'approve']);
  // The answer's own reply, until a read made after it says more.
  const sent = (settled: boolean | null, more: Record<string, unknown> = {}) => R.card({ fact: fact(), item: pref, list: 'ready', seen: pref, local: { phase: 'sent', decision: 'approve', settled, at: 5 }, ...more });
  assert.deepEqual([sent(true).mode, sent(true).text, sent(true).what], ['line', '已提交', '回答简短一点，先说结论']);
  assert.equal(sent(false).text, '已提交，还在处理');
  assert.equal(sent(null).text, '没能确认结果，稍后会更新');
  assert.equal(sent(null, { fresh: true, item: null }).text, '已处理', 'no longer open, and no receipt on the page: neutral');
  assert.equal(sent(null, { fresh: true }).text, '已提交，还在处理', 'still open after the answer went through');
  assert.equal(sent(true, { fresh: true, item: null }).text, '已提交', 'settled waits for the receipt\'s outcome, neutrally');
  for (const v of [sent(true), sent(false), sent(null)]) assert.equal(v.tone, 'neutral', 'no outcome is claimed before the receipt');
  // The receipt on the same page names the outcome, in the request's own words.
  const done = (state: string) => R.card({ fact: fact(state), item: null, list: 'ready', seen: pref });
  assert.deepEqual([done('approved').text, done('approved').tone], ['已记住', 'ok']);
  assert.deepEqual([done('rejected').text, done('rejected').tone], ['没有记', 'no']);
  assert.equal(done('closed').text, '已结束');
  assert.equal(R.card({ fact: fact('approved') }).text, '已同意', 'without the list\'s words: plain');
  assert.equal(R.card({ fact: fact('approved') }).what, '回答简短、先说结论', 'the engine\'s summary without its English tag');
  assert.equal(R.outcome('schedule', 'rejected'), '没有改动');
  // No longer listed and nothing on the page says how: 已处理. A failed answer leaves the card open with the server's words.
  assert.equal(R.card({ fact: fact(), item: null, list: 'ready' }).text, '已处理');
  const failed = R.card({ fact: fact(), item: pref, list: 'ready', local: { phase: 'error', decision: 'approve', at: 5, error: { text: '这一步没有成功，还没有生效', detail: 'Vignette write failed' } } });
  assert.deepEqual([failed.mode, failed.busy, plain(failed.error)], ['ask', '', { text: '这一步没有成功，还没有生效', detail: 'Vignette write failed' }]);
  assert.equal(failed.actions.length, 2, 'it can be answered again');
  // Not read yet: the card without actions (none may be stale); a failed read sends to the runtime panel.
  const waiting = R.card({ fact: fact(), list: 'loading', catName: '团子' });
  assert.deepEqual([waiting.mode, waiting.actions.length, waiting.waiting, waiting.title], ['ask', 0, '正在读取…', '团子有件事等你确认']);
  const unread = R.card({ fact: fact(), list: 'error' });
  assert.deepEqual([unread.mode, unread.runtime], ['line', true]);
});

test('expiry is said quietly and only when close; failures keep the server\'s words and the engine\'s reason apart', () => {
  const R = rules();
  const now = new Date(2026, 10, 11, 10, 0).getTime();
  assert.equal(R.expiry(now + 7 * 86400000, now), '');
  assert.equal(R.expiry(new Date(2026, 10, 11, 18, 30).getTime(), now), '今天 18:30 前有效');
  assert.equal(R.expiry(new Date(2026, 10, 12, 9, 5).getTime(), now), '明天 09:05 前有效');
  assert.equal(R.expiry(now - 1, now), '已过了有效时间');
  assert.equal(R.expiry(0, now), '');
  assert.deepEqual(plain(R.failure({ error: '这一步没有成功，还没有生效', native: { error: 'Vignette write failed', detail: 'store' } }, 'x')), { text: '这一步没有成功，还没有生效', detail: 'Vignette write failed · store' });
  assert.deepEqual(plain(R.failure({ error: 'Invalid input' }, '没能提交')), { text: '没能提交', detail: 'Invalid input' });
  assert.equal(R.summary('Create schedule: 喝水提醒'), '喝水提醒');
  assert.equal(R.summary('回答：先说结论'), '回答：先说结论', 'Chinese words are not a tag');
});

// ------------------------------------------------------------ choices, blocks, endings
test('a choice shows answered only from the record; a pick in flight, unsent or unrecorded says so and stays answerable', () => {
  const R = rules();
  const block = { mode: 'single', options: [{ id: 'a', label: '甲', emoji: '🍵' }, { id: 'b', label: '乙' }], answered: false, selected: [] };
  assert.equal(R.choice(block).mode, 'ask');
  assert.deepEqual(plain(R.choice({ ...block, answered: true, selected: ['a'] }).picked), [{ id: 'a', text: '🍵 甲' }]);
  assert.equal(R.choice(block, { phase: 'recording', ids: ['b'], text: '我选了：乙' }).mode, 'ask', 'sent but not recorded yet: not answered');
  assert.equal(R.choice(block, { phase: 'recording', ids: ['b'] }).busy, true);
  assert.deepEqual(plain(R.choice(block, { phase: 'recorded', selected: ['b'] }).picked), [{ id: 'b', text: '乙' }], 'the answer route\'s own reply');
  assert.match(R.choice(block, { phase: 'unsent' }).note, /没发出去/);
  const unrecorded = R.choice(block, { phase: 'unrecorded', text: '我选了：乙', error: { text: '暂时没能记下' } });
  assert.deepEqual([unrecorded.mode, unrecorded.busy, unrecorded.retry], ['ask', false, true]);
  assert.equal(unrecorded.note, '已经发出「我选了：乙」，但没能记下这次选择：暂时没能记下。可以再选一次。');
  assert.equal(R.choice(block, { phase: 'refused', error: { text: '这个选项已经回答过了' } }).note, '这个选项已经回答过了');
  const many = { mode: 'multiple', max: 2, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], answered: false, selected: [] };
  assert.deepEqual([R.choice(many, { phase: 'idle', picks: ['a', 'c'] }).full, R.choice(many, { phase: 'idle', picks: ['a', 'c'] }).ready], [true, true]);
  assert.equal(R.choice(many, { phase: 'idle', picks: [] }).ready, false);
});

test('an unfinished reply says how it ended; the server\'s stand-in words and a request\'s raw words are not shown as words; 再发一次 targets the owner\'s message it answered, once', () => {
  const R = rules();
  assert.deepEqual(plain(R.ending({ ended: { how: 'failed', reason: ' rate limit ' } })), { how: 'failed', label: '这次没完成', reason: 'rate limit', again: true });
  assert.deepEqual(plain(R.ending({ ended: { how: 'stopped' } })), { how: 'stopped', label: '已停止', reason: '', again: false });
  assert.equal(R.ending({ ended: { how: 'interrupted' } }).label, '中途被打断');
  assert.equal(R.ending({ ended: { how: 'weird' } }), null);
  assert.equal(R.words({ ended: { how: 'failed' } }, '这次没完成，请查看详情'), '');
  assert.equal(R.words({ ended: { how: 'interrupted' } }, '中途被打断，没有写完'), '');
  assert.equal(R.words({ ended: { how: 'stopped' } }, '写到一半'), '写到一半', 'words written before it stopped stay');
  assert.equal(R.words({ blocks: [{ kind: 'card', approval: { id: 'p1' } }] }, '提议捕捉品味信号：…'), '', 'the request card is drawn instead');
  const messages = [
    { id: 'u1', native_message_id: 'u1', role: 'user', content: '失败了吗' },
    { id: 'r1', role: 'assistant', native: { replyTo: 'u1' }, ended: { how: 'failed' } },
  ];
  assert.deepEqual(plain(R.resend(messages, messages[1], false)), { id: 'u1', text: '失败了吗', files: 0 });
  const again = [...messages, { id: 'u2', native_message_id: 'u2', role: 'user', content: '失败了吗' }];
  assert.equal(R.resend(again, again[1], false), null, 'already sent again');
  assert.equal(R.resend([{ id: 'u', role: 'user', content: '<untrusted_event source="timer">\n喝水\n</untrusted_event>' }, { id: 'r', role: 'assistant', native: { replyTo: 'u' } }], { id: 'r', native: { replyTo: 'u' } }, false), null, 'an event is not the owner\'s words');
  const group = [{ id: 'g1', kind: 'person', text: '大家好' }, { id: 'g2', kind: 'bot', native: { replyTo: 'g1' } }];
  assert.equal(R.resend(group, group[1], true).text, '大家好');
  const d = R.diffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same');
  assert.deepEqual([d.add, d.del, d.lines.map((l: Any) => l.kind).join(',')], [1, 1, 'meta,meta,hunk,del,add,ctx']);
  assert.equal(R.hiddenText(2), '还有 2 项内容暂时无法显示');
  assert.equal(R.hiddenText(0), '');
});

// ------------------------------------------------------------ notification rules
const status = (bots: Any[], groups: Any[] = []) => ({ bots, groups });
const act = (over: Record<string, unknown> = {}) => ({ threadId: 't1', readStatus: 'ready', items: [], counts: {}, unread: 0, last: null, ...over });
const reply = (id: string, text = '好了', extra: Record<string, unknown> = {}) => ({ messageId: id, time: '2026-11-11T10:00:00Z', from: 'cat', catId: 'c1', catName: '团子', text, files: 0, ...extra });

test('notifications: nothing on first sight, a cat\'s unread latest reply or a new request elsewhere, never the chat in view, never twice', () => {
  const N = notifyRules();
  let mem = new Map();
  const step = (data: Any, inView = '') => { const out = N.decide(mem, N.chats(data), inView); mem = out.memory; return plain(out.notes); };
  assert.deepEqual(step(status([{ bot: '团子', activity: act({ last: reply('m1'), unread: 3 }) }])), [], 'what was there when the page opened');
  const got = step(status([{ bot: '团子', activity: act({ last: reply('m2', '纸箱让猫觉得安全'), unread: 4 }) }]));
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].kind, got[0].key, got[0].messageId, got[0].text, got[0].tag], ['reply', 'bot:团子', 'm2', '纸箱让猫觉得安全', 'reply:m2']);
  assert.deepEqual(step(status([{ bot: '团子', activity: act({ last: reply('m2'), unread: 4 }) }])), [], 'never twice');
  assert.deepEqual(step(status([{ bot: '团子', activity: act({ last: reply('m3'), unread: 1 }) }]), 'bot:团子'), [], 'the chat in view');
  assert.deepEqual(step(status([{ bot: '团子', activity: act({ last: reply('m4', '读过了'), unread: 0 }) }])), [], 'already read');
  assert.deepEqual(step(status([{ bot: '团子', activity: act({ last: { ...reply('m5'), from: 'owner' }, unread: 0 }) }])), [], 'the owner\'s own words');
  assert.deepEqual(step(status([{ bot: '团子', activity: null }])), [], 'a chat it could not read changes nothing');
  assert.deepEqual(step(status([{ bot: '团子', activity: act({ last: reply('m5'), unread: 1 }) }])), [], 'the same latest line after a failed read is not new');
  // A new request: once, by its own ID; in a group too.
  const ask = { id: 'approval:F221:p9', kind: 'approval', label: '等你确认：x', catName: '年糕', messageId: 'mc', proposalId: 'p9' };
  assert.deepEqual(step(status([], [{ id: 'g1', activity: act({ threadId: 'tg' }) }])), []);
  const asked = step(status([], [{ id: 'g1', activity: act({ threadId: 'tg', items: [ask] }) }]));
  assert.deepEqual([asked[0].kind, asked[0].key, asked[0].proposalId, asked[0].tag], ['approval', 'group:g1', 'p9', 'approval:p9']);
  assert.deepEqual(step(status([], [{ id: 'g1', activity: act({ threadId: 'tg', items: [ask] }) }])), []);
  // A request whose card message is the chat's latest line: one note for the request, none for the card's raw words.
  const ask2 = { ...ask, id: 'approval:F139:p10', proposalId: 'p10', messageId: 'mc2' };
  const both = step(status([], [{ id: 'g1', activity: act({ threadId: 'tg', items: [ask, ask2], last: reply('mc2', '提议新建定时任务：Create schedule: 喝水'), unread: 2 }) }]));
  assert.deepEqual(both.map((n: Any) => n.kind), ['approval']);
  // Another conversation of the same cat: only remembered.
  assert.deepEqual(step(status([{ bot: '团子', activity: act({ threadId: 't2', last: reply('old'), unread: 9 }) }])), []);
  // Words: the cat's name (and the group's), the reply's first line or files, or what waits.
  assert.deepEqual(plain(N.words(got[0], '')), { title: '团子', body: '纸箱让猫觉得安全' });
  assert.deepEqual(plain(N.words({ ...asked[0] }, '周末小组')), { title: '年糕 · 周末小组', body: '有件事等你确认' });
  assert.equal(N.words({ kind: 'reply', type: 'bot', id: '团子', text: '', files: 2 }, '').body, '发来 2 个文件');
  assert.equal(Array.from(N.words({ kind: 'reply', type: 'bot', id: '团子', text: '字'.repeat(120) }, '').body).length, 81);
  // The switch is on only with the browser's permission; what the owner is told.
  assert.deepEqual(plain(N.setting(true, true, 'granted')), { on: true, hint: '' });
  assert.equal(N.setting(true, true, 'denied').on, false);
  assert.equal(N.setting(false, false, 'default').hint, '这个浏览器不支持桌面通知。');
  assert.equal(N.asked('denied').on, false);
  assert.match(N.asked('denied').said, /浏览器拒绝了通知/);
  assert.match(N.asked('default').said, /没有得到浏览器的允许/);
});

// ---------------------------------------------------------------- small DOM
type Listener = (ev: Any) => void;
class Ev { type: string; target: Any = null; key = ''; defaultPrevented = false; stopped = false; isComposing = false; keyCode = 0; [k: string]: Any;
  constructor(type: string, init: Record<string, unknown> = {}) { this.type = type; Object.assign(this, init); }
  preventDefault() { this.defaultPrevented = true; } stopPropagation() { this.stopped = true; } }
class Text { parent: El | null = null; constructor(public data: string) {} get textContent() { return this.data; } get html() { return this.data.replace(/&/g, '&amp;').replace(/</g, '&lt;'); } }
type Simple = { tag: string; classes: string[]; attrs: Array<[string, string | null]> };
function parse(sel: string): Simple[][] {
  return sel.split(',').map(part => part.trim().split(/\s+/).map(token => {
    const tag = /^[a-z]+/i.exec(token)?.[0]?.toUpperCase() || '';
    const classes = [...token.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    const attrs = [...token.matchAll(/\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]/g)].map(m => [m[1], m[3] ?? null] as [string, string | null]);
    return { tag, classes, attrs };
  }));
}
class El {
  parent: El | null = null; kids: Array<El | Text> = []; attrs = new Map<string, string>(); listeners = new Map<string, Listener[]>();
  hidden = false; disabled = false; readOnly = false; type = ''; value = ''; placeholder = ''; maxLength = 0; tabIndex = -1; scrolled = 0; _ckSig?: string; _lvSig?: string;
  [key: string]: Any;
  constructor(readonly doc: Doc, readonly tagName: string) {}
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', String(v)); }
  get id() { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', String(v)); }
  get href() { return this.attrs.get('href') ?? ''; }
  set href(v: string) { this.attrs.set('href', v); }
  get target() { return this.attrs.get('target') ?? ''; }
  set target(v: string) { this.attrs.set('target', v); }
  get rel() { return this.attrs.get('rel') ?? ''; }
  set rel(v: string) { this.attrs.set('rel', v); }
  get title() { return this.attrs.get('title') ?? ''; }
  set title(v: string) { this.attrs.set('title', v); }
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s: Set<string>) => { this.className = [...s].join(' '); };
    return {
      add: (...n: string[]) => { for (const x of n) if (/\s/.test(x)) throw new Error('token with a space: ' + x); const s = names(); n.forEach(x => s.add(x)); write(s); },
      remove: (...n: string[]) => { const s = names(); n.forEach(x => s.delete(x)); write(s); },
      toggle: (n: string, on?: boolean) => { const s = names(); const want = on ?? !s.has(n); if (want) s.add(n); else s.delete(n); write(s); return want; },
      contains: (n: string) => names().has(n),
    };
  }
  get dataset(): Record<string, string> {
    const key = (k: string) => 'data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return new Proxy({}, {
      get: (_t, k: string) => this.attrs.get(key(k)),
      set: (_t, k: string, v) => { this.attrs.set(key(k), String(v)); return true; },
      deleteProperty: (_t, k: string) => { this.attrs.delete(key(k)); return true; },
    });
  }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  get childNodes(): Array<El | Text> { return this.kids; }
  get lastChild(): El | Text | null { return this.kids.at(-1) ?? null; }
  get firstChild(): El | Text | null { return this.kids[0] ?? null; }
  get parentElement(): El | null { return this.parent; }
  get isConnected(): boolean { for (let n: El | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  get offsetWidth() { return 0; }
  get textContent(): string { return this.kids.map(k => k.textContent).join(''); }
  set textContent(v: string) { this.replaceChildren(); if (v !== '' && v != null) this.append(String(v)); }
  set innerHTML(v: string) { this.replaceChildren(); this.attrs.set('data-inner', v); }
  get html(): string {
    const attrs = [...this.attrs].sort().map(([k, v]) => ` ${k}="${v}"`).join('') + (this.hidden ? ' hidden' : '');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.kids.map(k => k.html).join('')}</${this.tagName.toLowerCase()}>`;
  }
  get outerHTML() { return this.html; }
  private adopt(item: El | Text | string) {
    const n = typeof item === 'string' ? new Text(item) : item;
    if (n.parent) (n.parent as El).kids.splice((n.parent as El).kids.indexOf(n), 1);
    n.parent = this;
    return n;
  }
  append(...items: Array<El | Text | string>) { for (const i of items) this.kids.push(this.adopt(i)); }
  prepend(...items: Array<El | Text | string>) { this.kids.unshift(...items.map(i => this.adopt(i))); }
  insertBefore(n: El, ref: El | null) { if (!ref) { this.append(n); return n; } this.adopt(n); this.kids.splice(this.kids.indexOf(ref), 0, n); return n; }
  replaceChildren(...items: Array<El | Text | string>) { for (const k of [...this.kids]) { k.parent = null; this.doc.lost(k); } this.kids = []; this.append(...items); }
  remove() { const p = this.parent; if (!p) return; p.kids.splice(p.kids.indexOf(this), 1); this.parent = null; this.doc.lost(this); }
  replaceWith(n: El) { const p = this.parent!; const at = p.kids.indexOf(this); p.adopt(n); p.kids.splice(at, 1, n); this.parent = null; this.doc.lost(this); }
  after(n: El) { const p = this.parent!; p.adopt(n); p.kids.splice(p.kids.indexOf(this) + 1, 0, n); }
  contains(n: Any): boolean { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  matches(sel: string) { return parse(sel).some(chain => this.chain(chain)); }
  private one(s: Simple) {
    if (s.tag && s.tag !== this.tagName) return false;
    if (s.classes.some(c => !this.classList.contains(c))) return false;
    return s.attrs.every(([k, v]) => (v === null ? this.attrs.has(k) : this.attrs.get(k) === v));
  }
  private chain(chain: Simple[]): boolean {
    if (!this.one(chain.at(-1)!)) return false;
    let i = chain.length - 2;
    for (let n = this.parent; n && i >= 0; n = n.parent) if (n.one(chain[i])) i--;
    return i < 0;
  }
  closest(sel: string): El | null { for (let n: El | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel: string): El[] { const out: El[] = []; const walk = (n: El) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  addEventListener(type: string, fn: Listener) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  dispatchEvent(ev: Ev) { return this.doc.dispatch(this, ev); }
  click() { this.dispatchEvent(new Ev('click')); }
  focus() { this.doc.activeElement = this; this.doc.dispatch(this, new Ev('focusin')); }
  scrollIntoView() { this.scrolled++; }
  scrollTo() { /* the history's scroll box */ }
  getBoundingClientRect() { return { top: 0, bottom: 40, left: 0, right: 100, width: 100, height: 40 }; }
}
class Doc {
  body: El; activeElement: El; listeners = new Map<string, Listener[]>(); visibilityState = 'visible';
  constructor() { this.body = new El(this, 'BODY'); this.activeElement = this.body; }
  createElement(tag: string) { return new El(this, tag.toUpperCase()); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag.toUpperCase()); }
  createTextNode(text: string) { return new Text(text); }
  querySelector(sel: string) { return this.body.querySelector(sel); }
  querySelectorAll(sel: string) { return this.body.querySelectorAll(sel); }
  addEventListener(type: string, fn: Listener) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  lost(n: Any) { if (n instanceof El && n.contains(this.activeElement)) this.activeElement = this.body; }
  dispatch(target: El, ev: Ev) {
    ev.target = target;
    for (let n: El | null = target; n && !ev.stopped; n = n.parent) for (const fn of [...(n.listeners.get(ev.type) ?? [])]) fn(ev);
    if (!ev.stopped) for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  }
}
const all = (root: El): El[] => root.children.flatMap(c => [c, ...all(c)]);
const buttons = (root: El, text: string) => all(root).filter(e => e.tagName === 'BUTTON' && e.textContent === text);
const button = (root: El, text: string) => { const b = buttons(root, text)[0]; assert.ok(b, 'no button ' + text); return b; };

// ---------------------------------------------------------------- the page
type Reply = { status: number; body: Any } | Error;
function page(opts: { approvals?: () => Any } = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const chat = h('div', 'chat'), thread = h('div', 'thread'), dock = h('div', 'dock');
  thread.id = 'thread';
  Object.assign(thread, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
  chat.append(thread, dock);
  doc.body.append(chat);
  const window: Any = { matchMedia: () => ({ matches: false }), requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) };
  const context = vm.createContext({ window, document: doc, console, Date, JSON, setTimeout, clearTimeout, setInterval: () => 0, encodeURIComponent });
  for (const f of ['chat-live-rules.js', 'chat-live.js', 'chat-cards-rules.js', 'chat-cards.js']) vm.runInContext(read('client/public/' + f), context);
  const live = window.ClowderLive, cards = window.ClowderCards;
  const calls: Array<{ path: string; method: string; body?: Any }> = [];
  const posts: Array<{ path: string; body: Any; answer: (r: Reply) => void }> = [];
  const sends: Array<{ text: string; sent: () => void; done: () => void }> = [];
  let reloads = 0;
  const icon = (name: string, extra?: string) => { const s = doc.createElementNS('svg', 'svg'); s.classList.add('icon'); if (extra) s.classList.add(extra); s.dataset.icon = name; return s; };
  live.init({ thread, render: () => {}, row: () => h('div', 'msg bot'), queued: () => false, busy: () => false, unread: () => '', changed: () => {}, gap: () => {}, focusComposer: () => {} });
  cards.init({
    thread, icon,
    api: async (path: string) => { calls.push({ path, method: 'GET' }); return opts.approvals ? opts.approvals() : { threadId: 't1', approvals: [] }; },
    apiFetch: (path: string, opt: Any) => new Promise((resolve, reject) => {
      const body = JSON.parse(opt.body);
      calls.push({ path, method: opt.method, body });
      posts.push({ path, body, answer: (r: Reply) => (r instanceof Error ? reject(r) : resolve({ ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) })) });
    }),
    render: (el: El, text: string) => el.append(text),
    send: (text: string, sent: () => void) => new Promise<void>((done) => sends.push({ text, sent, done })),
    reload: () => { reloads++; },
  });
  const sel = { type: 'bot', id: '团子' };
  live.select('bot:团子');
  cards.select(sel);
  // The history drawn as app.js draws it: words, then blocks, then the ending; notices as lines.
  const draw = (messages: Any[]) => {
    const inner = h('div', 'thread-inner');
    inner.dataset.chat = 'bot:团子';
    for (const m of messages) {
      if (m.notice) { inner.append(cards.notice(m, m.content)); continue; }
      const row = h('div', 'msg ' + (m.role === 'user' ? 'user' : 'bot'));
      row.dataset.mid = m.id;
      const body = h('div', 'body');
      const said = m.role === 'user' ? m.content : cards.words(m, m.content);
      if (said) { const b = h('div', 'bot-bubble'); b.append(said); body.append(b); }
      if (m.role !== 'user') { cards.blocks(body, m, messages, false); cards.ending(body, m, messages, false); }
      row.append(body);
      inner.append(row);
    }
    cards.observe(sel, 't1', messages);
    live.commit(inner, []);
    cards.rendered();
    return inner;
  };
  const rows = () => (thread.children[0]?.children ?? []) as El[];
  const row = (mid: string) => rows().find(r => r.dataset.mid === mid)!;
  return { doc, thread, cards, live, calls, posts, sends, draw, rows, row, reloads: () => reloads, window };
}
const cardMessage = (state?: string) => ({ id: 'm-card', role: 'assistant', content: '提议捕捉品味信号：回答简短一点，先说结论', blocks: [fact(state)], speaker: { name: '团子' } });
const listWith = (...items: Any[]) => () => ({ threadId: 't1', approvals: items });

test('a request card is drawn at its message, answered in place, and settles only to what the server said; unchanged rows keep their element and never rise again', async () => {
  let list = [pref];
  const p = page({ approvals: () => ({ threadId: 't1', approvals: list }) });
  const history = [{ id: 'u1', role: 'user', content: '记住我喜欢简短' }, { id: 'r1', role: 'assistant', content: '好，这个我想记下来。' }, cardMessage()];
  p.draw(history);
  const cardRow = p.row('m-card');
  assert.doesNotMatch(cardRow.textContent, /提议捕捉品味信号/, 'the engine\'s raw words are not what the owner reads');
  assert.match(cardRow.textContent, /正在读取…/, 'not read yet: no actions that may be stale');
  await settle();
  assert.deepEqual(p.calls.map(c => c.path), ['/xbot-api/bots/%E5%9B%A2%E5%AD%90/approvals']);
  const card = cardRow.querySelector('.approval')!;
  assert.match(card.textContent, /团子想记住你的一个偏好回答简短一点，先说结论记住我喜欢简短/);
  // The same history again: the very same elements, nothing rises in again.
  const before = p.rows().slice();
  p.draw(history);
  assert.deepEqual(p.rows(), before, 'every row kept');
  assert.equal(p.row('m-card').querySelector('.approval'), card, 'the card itself kept');
  assert.ok(p.rows().every(r => !r.classList.contains('lv-still')), 'nothing redrawn');
  // 记住: sent, in flight, then what the server said.
  button(card, '记住').focus();
  button(card, '记住').click();
  assert.deepEqual(p.posts[0].body, { decision: 'approve', expectedThreadId: 't1' });
  assert.match(p.posts[0].path, /\/approvals\/p1$/);
  const busy = p.row('m-card').querySelector('.approval')!;
  assert.match(busy.textContent, /正在提交…/);
  assert.ok(all(busy).filter(e => e.tagName === 'BUTTON').every(b => b.getAttribute('aria-disabled') === 'true'));
  assert.equal(p.doc.activeElement.dataset.ckFocus, 'act:approve', 'focus stays on the answer pressed');
  assert.doesNotMatch(p.row('m-card').textContent, /已记住|已提交/, 'never optimistic');
  list = [];
  p.posts[0].answer({ status: 200, body: { id: 'p1', decision: 'approve', settled: true } });
  await settle(); await settle();
  assert.match(p.row('m-card').textContent, /已提交 · 回答简短一点，先说结论/, 'settled, outcome not yet known: neutral');
  assert.equal(p.doc.activeElement.dataset.ckFocus, 'card', 'focus moves to the card, not lost');
  assert.equal(p.reloads(), 1, 'the conversation is read again for the receipt');
  // The receipt arrives on the same page: the card names the outcome, the receipt is a quiet line.
  p.draw([...history.slice(0, 2), cardMessage('approved'), { id: 'n1', role: 'assistant', notice: true, content: '已记住这个偏好。' }]);
  assert.match(p.row('m-card').textContent, /已记住 · 回答简短一点，先说结论/);
  const notice = p.row('n1');
  assert.deepEqual([notice.className, notice.textContent], ['sysline ck-notice', '已记住这个偏好。']);
  assert.ok(p.row('u1') === before[0] && p.row('r1') === before[1], 'the rows above stayed');
});

test('agreeing that fails leaves the card open with the server\'s words and the engine\'s reason behind 详情; settled false and null say so; a refusal reads the list again', async () => {
  const other = { ...pref, id: 'p2', messageId: 'm-two' };
  const p = page({ approvals: listWith(pref, other) });
  p.draw([cardMessage(), { ...cardMessage(), id: 'm-two', blocks: [{ ...fact(), approval: { id: 'p2' } }] }]);
  await settle();
  button(p.row('m-card'), '记住').click();
  p.posts[0].answer({ status: 500, body: { error: '这一步没有成功，还没有生效', native: { error: 'Vignette write failed' } } });
  await settle(); await settle();
  const card = p.row('m-card').querySelector('.approval')!;
  assert.match(card.textContent, /这一步没有成功，还没有生效。详情/);
  assert.ok(buttons(card, '记住').length && buttons(card, '记住')[0].getAttribute('aria-disabled') !== 'true', 'it can be answered again');
  const reason = card.querySelector('.ck-reason')!;
  assert.equal(reason.hidden, true);
  button(card, '详情').click();
  assert.deepEqual([reason.hidden, reason.textContent], [false, 'Vignette write failed']);
  // settled false / null.
  button(p.row('m-two'), '不用记').click();
  p.posts[1].answer({ status: 200, body: { id: 'p2', decision: 'reject', settled: false } });
  await settle(); await settle();
  assert.match(p.row('m-two').textContent, /已提交，还在处理/);
  const p2 = page({ approvals: listWith(pref) });
  p2.draw([cardMessage()]);
  await settle();
  button(p2.row('m-card'), '记住').click();
  p2.posts[0].answer({ status: 200, body: { id: 'p1', decision: 'approve', settled: null } });
  await settle(); await settle();
  // The read that followed still lists it: the answer is in, still being applied.
  assert.match(p2.row('m-card').textContent, /已提交，还在处理/);
  // Already answered elsewhere: 404, the list is read again and the card says 已处理.
  let open = [pref];
  const p3 = page({ approvals: () => ({ threadId: 't1', approvals: open }) });
  p3.draw([cardMessage()]);
  await settle();
  button(p3.row('m-card'), '记住').click();
  open = [];
  p3.posts[0].answer({ status: 404, body: { error: '这件事已经处理过，或者不在这个对话里' } });
  await settle(); await settle();
  assert.match(p3.row('m-card').textContent, /已处理/);
});

test('a request that cannot be agreed here shows its note and the runtime panel, not a dead button; 去确认 finds the card, or says it cannot', async () => {
  const p = page({ approvals: listWith({ ...pref, kind: 'profile', approve: null, reject: { label: '不用' }, note: '这一项要在运行面板里核对后才能同意' }) });
  p.draw([cardMessage()]);
  await settle();
  const card = p.row('m-card').querySelector('.approval')!;
  assert.deepEqual(all(card).filter(e => e.tagName === 'BUTTON').map(b => b.textContent), ['不用']);
  const link = all(card).find(e => e.tagName === 'A')!;
  assert.deepEqual([link.textContent, link.href, link.target], ['打开运行面板', '/runtime.html', '_blank']);
  assert.match(card.textContent, /这一项要在运行面板里核对后才能同意。/);
  assert.equal(p.cards.find({ proposalId: 'p1' }), true);
  assert.equal(card.scrolled, 1);
  assert.ok(card.classList.contains('ck-hit'));
  assert.equal(p.doc.activeElement, card);
  assert.equal(p.cards.find({ proposalId: 'gone', messageId: 'nowhere' }), false);
  // The status line's label: the server's everyday words stay; an engine tag gives way to the card's title or the plain words.
  assert.equal(p.cards.label({ proposalId: 'p1', label: '等你确认：设一个定时「喝水提醒」' }), '');
  assert.equal(p.cards.label({ proposalId: 'p1', label: '等你确认：Taste [x]: 回答简短' }), '团子想记住你的一个偏好');
  assert.equal(p.cards.label({ proposalId: 'p8', label: '等你确认：Create schedule: 喝水提醒' }), '等你确认：喝水提醒');
});

const choiceMessage = (block: Any) => ({ id: 'm-pick', role: 'assistant', content: '你想要哪一种？', native: { replyTo: 'u1' }, blocks: [block] });
const weekend = { id: 'pick-1', kind: 'choices', mode: 'single', title: '周末安排', template: '我选 {selection}', answered: false, selected: [],
  options: [{ id: 'home', label: '在家看书', emoji: '📚' }, { id: 'park', label: '去公园', emoji: '🌳' }, { id: 'other', label: '别的', custom: true }] };

test('a pick goes out as an ordinary message first and is recorded only after the server took it; answered only from the record', async () => {
  const p = page();
  p.draw([choiceMessage(weekend)]);
  const box = () => p.row('m-pick').querySelector('.ask')!;
  assert.deepEqual(box().querySelectorAll('button.ask-opt').map(b => b.textContent), ['A📚 在家看书', 'B🌳 去公园']);
  assert.equal(box().querySelector('input')!.getAttribute('aria-label'), '别的', 'the typed option is a field with its send button');
  box().querySelectorAll('button.ask-opt')[1].click();
  assert.equal(p.sends.length, 1);
  assert.equal(p.sends[0].text, '我选 🌳 去公园');
  assert.equal(p.posts.length, 0, 'nothing recorded before the message went out');
  assert.match(box().textContent, /正在发送…/);
  p.sends[0].sent();
  assert.equal(p.posts.length, 1, 'recorded as soon as the server took the message');
  assert.deepEqual(p.posts[0].body, { selectedIds: ['park'], expectedThreadId: 't1' });
  assert.match(p.posts[0].path, /\/messages\/m-pick\/blocks\/pick-1\/answer$/);
  assert.equal(box().classList.contains('done'), false, 'not answered while being recorded');
  p.posts[0].answer({ status: 200, body: { messageId: 'm-pick', blockId: 'pick-1', selected: ['park'], answered: true } });
  await settle();
  assert.ok(box().classList.contains('done'));
  assert.match(box().textContent, /周末安排🌳 去公园/);
  assert.equal(all(box()).filter(e => e.tagName === 'BUTTON').length, 0, 'no longer clickable');
  p.sends[0].done();
});

test('a pick that did not go out, or went out but was not recorded, stays answerable and says so; 再记一次 records without sending again; 409 reads the conversation', async () => {
  const p = page();
  p.draw([choiceMessage(weekend)]);
  const box = () => p.row('m-pick').querySelector('.ask')!;
  all(box()).filter(e => e.tagName === 'BUTTON')[0].click();
  p.sends[0].done(); // the send path failed: sent() never came
  await settle();
  assert.match(box().textContent, /没发出去，可以再选一次。/);
  assert.equal(p.posts.length, 0);
  // Picked again: out, but the record fails.
  all(box()).filter(e => e.tagName === 'BUTTON')[0].click();
  p.sends[1].sent();
  p.posts[0].answer({ status: 502, body: { error: '暂时连不上原生' } });
  await settle();
  assert.match(box().textContent, /已经发出「我选 📚 在家看书」，但没能记下这次选择：暂时连不上原生。可以再选一次。/);
  assert.equal(box().classList.contains('done'), false);
  button(box(), '再记一次').click();
  assert.equal(p.sends.length, 2, '再记一次 sends nothing again');
  assert.deepEqual(p.posts[1].body, { selectedIds: ['home'], expectedThreadId: 't1' });
  p.posts[1].answer({ status: 409, body: { error: '这个选项已经回答过了' } });
  await settle();
  assert.match(box().textContent, /这个选项已经回答过了/);
  assert.equal(p.reloads(), 1, 'the conversation is read again so the block shows its recorded answer');
  // The typed option: its own words, Enter sends them.
  const q = page();
  q.draw([choiceMessage(weekend)]);
  const field = q.row('m-pick').querySelector('input')!;
  field.value = '去爬山';
  field.dispatchEvent(new Ev('input'));
  field.dispatchEvent(new Ev('keydown', { key: 'Enter', isComposing: true }));
  assert.equal(q.sends.length, 0, 'not while composing');
  field.dispatchEvent(new Ev('keydown', { key: 'Enter' }));
  assert.equal(q.sends[0].text, '别的：去爬山（周末安排）');
});

test('a multiple choice toggles in pick order up to max and sends once; a confirmation draws its two answers', async () => {
  const p = page();
  const many = { id: 'm1', kind: 'choices', mode: 'multiple', title: '要带的', max: 2, answered: false, selected: [], options: [{ id: 'a', label: '水' }, { id: 'b', label: '伞' }, { id: 'c', label: '书' }] };
  p.draw([choiceMessage(many)]);
  const box = () => p.row('m-pick').querySelector('.ask')!;
  const opt = (label: string) => all(box()).find(e => e.tagName === 'BUTTON' && e.textContent.endsWith(label))!;
  assert.equal(button(box(), '确认选择').getAttribute('aria-disabled'), 'true');
  opt('书').click();
  opt('水').click();
  assert.equal(opt('伞').getAttribute('aria-disabled'), 'true', 'max reached');
  assert.equal(opt('书').getAttribute('aria-pressed'), 'true');
  button(box(), '确认选择（2）').click();
  assert.equal(p.sends[0].text, '我选了：书, 水（要带的）');
  p.sends[0].sent();
  assert.deepEqual(p.posts[0].body.selectedIds, ['c', 'a']);
  const c = page();
  c.draw([choiceMessage({ id: 'ok', kind: 'choices', mode: 'confirm', title: '开始整理资料', answered: false, selected: [], options: [{ id: '__confirm__', label: '开始' }, { id: '__cancel__', label: '先不用' }] })]);
  const row = c.row('m-pick');
  assert.deepEqual(all(row).filter(e => e.tagName === 'BUTTON').map(b => b.textContent), ['先不用', '开始']);
  button(row, '开始').click();
  assert.equal(c.sends[0].text, '确认 — 开始整理资料');
});

test('a card, a checklist and a diff are drawn from the record as they are; what cannot be drawn is said', () => {
  const p = page();
  p.draw([{ id: 'm-b', role: 'assistant', content: '列好了：', blocks_hidden: 1, blocks: [
    { id: 'c', kind: 'card', title: '结论', body: '先说结论', tone: 'success', fields: [{ label: '耗时', value: '3 分钟' }] },
    { id: 'l', kind: 'checklist', title: '今天要做的事', items: [{ id: 'a', text: '给猫添水', checked: true }, { id: 'b', text: '回邮件', checked: false }] },
    { id: 'd', kind: 'diff', file: 'a.md', diff: '@@ -1 +1 @@\n-旧\n+新' },
    { id: 'z', kind: 'gallery' },
  ] }]);
  const row = p.row('m-b');
  assert.match(row.textContent, /^列好了：结论先说结论耗时3 分钟今天要做的事给猫添水回邮件a\.md\+1−1@@ -1 \+1 @@-旧\+新还有 2 项内容暂时无法显示$/);
  assert.equal(row.querySelectorAll('li.on').length, 1);
  assert.equal(row.querySelector('li.on')!.getAttribute('aria-label'), '已完成：给猫添水');
  assert.deepEqual(row.querySelectorAll('.ck-dl').map(l => l.className), ['ck-dl ck-dl-hunk', 'ck-dl ck-dl-del', 'ck-dl ck-dl-add']);
});

test('an unfinished reply ends quietly: 详情 shows the engine\'s reason verbatim, 再发一次 sends the owner\'s words again and says so', async () => {
  const p = page();
  const history = [
    { id: 'u1', role: 'user', content: '帮我查一下' },
    { id: 'r1', role: 'assistant', content: '这次没完成，请查看详情', status: 'failed', ended: { how: 'failed', reason: 'Error: rate limit exceeded' }, native: { replyTo: 'u1' } },
    { id: 'u2', role: 'user', content: '停' },
    { id: 'r2', role: 'assistant', content: '写到一半', ended: { how: 'stopped' }, native: { replyTo: 'u2' } },
  ];
  p.draw(history);
  const failed = p.row('r1');
  assert.doesNotMatch(failed.textContent, /请查看详情/, 'the stand-in words are not the reply');
  const line = failed.querySelector('.ck-ended')!;
  assert.equal(line.textContent, '这次没完成详情再发一次');
  const reason = failed.querySelector('.ck-reason')!;
  assert.equal(reason.hidden, true);
  button(line, '详情').click();
  assert.deepEqual([reason.hidden, reason.textContent, button(line, '详情').getAttribute('aria-expanded')], [false, 'Error: rate limit exceeded', 'true']);
  assert.equal(p.row('r2').querySelector('.ck-ended')!.textContent, '已停止', 'stopped: no reason, nothing to send again');
  assert.match(p.row('r2').textContent, /写到一半/);
  button(line, '再发一次').click();
  assert.equal(p.sends[0].text, '帮我查一下');
  assert.equal(button(line, '正在发送…').getAttribute('aria-disabled'), 'true');
  p.sends[0].sent();
  assert.match(line.textContent, /已再发一次/);
  // The redraw with the same record keeps the row (and what it said); the new message then retires the action.
  p.draw(history);
  assert.equal(p.row('r1'), failed);
  assert.match(p.row('r1').textContent, /已再发一次/);
  p.draw([...history, { id: 'u3', role: 'user', content: '帮我查一下' }]);
  assert.doesNotMatch(p.row('r1').textContent, /再发一次/);
});

// ---------------------------------------------------------------- notifications page
function notifyPage(opts: { permission?: string; supported?: boolean; answer?: string } = {}) {
  const doc = new Doc();
  const pane = doc.createElement('div');
  pane.setAttribute('data-spane', 'general');
  doc.body.append(pane);
  const shown: Array<{ title: string; opts: Any; n: Any }> = [];
  const store = new Map<string, string>();
  let asked = 0;
  function Notification(this: Any, title: string, o: Any) { this.closed = false; this.close = () => { this.closed = true; }; shown.push({ title, opts: o, n: this }); }
  (Notification as Any).permission = opts.permission ?? 'default';
  (Notification as Any).requestPermission = () => { asked++; (Notification as Any).permission = opts.answer ?? 'granted'; return Promise.resolve(opts.answer ?? 'granted'); };
  let focused = 0;
  const window: Any = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) }, focus: () => { focused++; } };
  if (opts.supported !== false) window.Notification = Notification;
  const context = vm.createContext({ window, document: doc, console, JSON, Promise });
  for (const f of ['chat-notify-rules.js', 'chat-notify.js']) vm.runInContext(read('client/public/' + f), context);
  const opened: Any[] = [];
  let sel: Any = { type: 'bot', id: '栗子' };
  window.ClowderNotify.init({ selection: () => sel, open: (note: Any) => opened.push(note), chatName: () => '' });
  const toggle = pane.querySelector('[role=switch]')!;
  const said = pane.querySelector('.ck-notify-said')!;
  return { doc, pane, toggle, said, shown, store, opened, notify: window.ClowderNotify, asked: () => asked, focused: () => focused, select: (s: Any) => { sel = s; } };
}

test('the switch asks the browser only when turned on, says plainly when it refused or cannot, and is remembered', async () => {
  const p = notifyPage();
  assert.equal(p.toggle.getAttribute('aria-checked'), 'false');
  assert.match(p.pane.textContent, /桌面通知/);
  p.toggle.click();
  await settle();
  assert.equal(p.asked(), 1);
  assert.deepEqual([p.toggle.getAttribute('aria-checked'), p.store.get('clowder-bot:notify'), p.said.textContent], ['true', 'on', '已打开。']);
  assert.equal(p.notify.wanted(), true);
  p.toggle.click();
  assert.deepEqual([p.toggle.getAttribute('aria-checked'), p.store.get('clowder-bot:notify')], ['false', 'off']);
  const refused = notifyPage({ answer: 'denied' });
  refused.toggle.click();
  await settle();
  assert.equal(refused.toggle.getAttribute('aria-checked'), 'false');
  assert.match(refused.said.textContent, /浏览器拒绝了通知/);
  const blocked = notifyPage({ permission: 'denied' });
  blocked.toggle.click();
  await settle();
  assert.equal(blocked.asked(), 0, 'a refusal is not asked again behind the owner\'s back');
  assert.match(blocked.said.textContent, /浏览器拒绝了通知/);
  const none = notifyPage({ supported: false });
  assert.match(none.said.textContent, /这个浏览器不支持桌面通知/);
  none.toggle.click();
  assert.equal(none.toggle.getAttribute('aria-checked'), 'false');
});

test('a notification repeats the polled status: the cat\'s name and the reply\'s first line, silent, once; a click focuses the tab and opens that chat; never while off or for the chat in view', async () => {
  const p = notifyPage({ permission: 'granted' });
  const data = (id: string, unread = 1) => ({ bots: [{ bot: '团子', activity: act({ last: reply(id, '纸箱让猫觉得安全又暖和'), unread }) }], groups: [] });
  p.notify.observe(data('m1'));
  p.notify.observe(data('m2'));
  assert.equal(p.shown.length, 0, 'off: nothing');
  p.store.set('clowder-bot:notify', 'on');
  p.notify.observe(data('m3'));
  assert.equal(p.shown.length, 1);
  assert.deepEqual([p.shown[0].title, p.shown[0].opts.body, p.shown[0].opts.silent, p.shown[0].opts.tag], ['团子', '纸箱让猫觉得安全又暖和', true, 'clowder-bot:reply:m3']);
  p.notify.observe(data('m3'));
  assert.equal(p.shown.length, 1, 'never twice');
  p.shown[0].n.onclick();
  assert.deepEqual([p.focused(), p.opened[0].key, p.shown[0].n.closed], [1, 'bot:团子', true]);
  // The chat in view: nothing; the same chat while the tab is hidden: yes.
  p.select({ type: 'bot', id: '团子' });
  p.notify.observe(data('m4'));
  assert.equal(p.shown.length, 1);
  p.doc.visibilityState = 'hidden';
  p.notify.observe(data('m5'));
  assert.equal(p.shown.length, 2);
  // Another tab already announced it (this browser's short list): not again.
  p.store.set('clowder-bot:notified', JSON.stringify(['reply:m6']));
  p.notify.observe(data('m6'));
  assert.equal(p.shown.length, 2);
});

// ---------------------------------------------------------------- wiring
test('the page loads the round\'s scripts before app.js and its styles just before chat-live.css; the shell hands them its own paths and never writes a second title', () => {
  const html = read('client/index.html'), app = read('client/public/app.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('chat-live.js') < at('chat-cards-rules.js') && at('chat-cards-rules.js') < at('chat-cards.js') && at('chat-cards.js') < at('app.js'));
  assert.ok(at('chat-notify-rules.js') < at('chat-notify.js') && at('chat-notify.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  // Only 活起来's styles (chat-presence.css) sit between them.
  assert.deepEqual(styles.slice(-3), ['chat-cards.css', 'chat-presence.css', 'chat-live.css']);
  // Both histories: words, blocks and the ending through chat-cards.js; frames filled right after each keyed commit.
  assert.equal((app.match(/cards\.words\(m, isSilent\(/g) || []).length, 2);
  assert.equal((app.match(/cards\.blocks\(body, m, messages, (true|false)\);/g) || []).length, 2);
  assert.equal((app.match(/cards\.ending\(body, m, messages, (true|false)\);/g) || []).length, 2);
  assert.equal((app.match(/const shown = live\.commit\(inner, [^\n]+\);\n\s+cards\.rendered\(\);/g) || []).length, 2);
  assert.equal((app.match(/cards\.notice\(m, /g) || []).length, 2);
  assert.equal((app.match(/cards\.observe\(selection, /g) || []).length, 2);
  assert.match(app, /cards\.select\(state\.sel\);/);
  assert.match(app, /notify\.observe\(data\);/);
  // A pick and 再发一次 use the normal send path, told when the server took the message.
  assert.match(app, /async function sendText\(text, pending, images, files, sent\)/);
  assert.match(app, /markSent\(\);\n\s+try \{ if \(sent\) sent\(\); \}/);
  assert.match(app, /send: \(text, sent\) => sendText\(text, null, null, null, sent\)/);
  assert.match(app, /confirm: \(item\) => cards\.find\(item\)/);
  // Notifications never touch the document title (the contact list owns its count).
  for (const f of ['chat-notify.js', 'chat-notify-rules.js', 'chat-cards.js']) assert.doesNotMatch(read('client/public/' + f), /document\.title/);
  // Only existing tokens; everyday words only.
  const css = read('client/public/chat-cards.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|@keyframes|font-family/i);
  for (const f of ['chat-cards.js', 'chat-cards-rules.js', 'chat-notify.js', 'chat-notify-rules.js']) {
    const strings = [...read('client/public/' + f).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').matchAll(/"([^"\n]*\p{Script=Han}[^"\n]*)"/gu)].map(m => m[1]);
    // The product's own name (clowder-bot) is the one place "bot" appears.
    for (const s of strings) assert.doesNotMatch(s.replace(/clowder-bot/g, ''), /Bot|Agent|session|thread|原生|会话|线程/i, f + ': ' + s);
  }
});
