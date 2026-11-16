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
// A request card as the server gives it: the engine's own card title and Markdown body, and the
// chat's own words in card.approval (kind, a title without its subject, body).
const fact = (state?: string, words: Record<string, unknown> = { kind: 'preference', title: '想记住你的一个偏好', body: '回答简短一点，先说结论' }) =>
  ({ id: 'card-1', kind: 'card', title: '提议捕捉品味信号', body: '**猫的判断**：Taste [authentic-expression]: 回答简短、先说结论', approval: { id: 'p1', ...words, ...(state ? { state } : {}) } });
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
  assert.deepEqual([done('approved').text, done('approved').tone], ['已记住这个偏好', 'ok']);
  assert.deepEqual([done('rejected').text, done('rejected').tone], ['没有记这个偏好', 'no']);
  assert.equal(done('closed').text, '已结束');
  assert.equal(R.card({ fact: fact('approved', {}) }).text, '已同意', 'a row without the chat\'s words: plain, and never the engine\'s');
  // No longer listed and nothing on the page says how: 已处理. A failed answer leaves the card open with the server's words.
  assert.equal(R.card({ fact: fact(), item: null, list: 'ready' }).text, '已处理');
  const failed = R.card({ fact: fact(), item: pref, list: 'ready', local: { phase: 'error', decision: 'approve', at: 5, error: { text: '这一步没有成功，还没有生效', detail: 'Vignette write failed' } } });
  assert.deepEqual([failed.mode, failed.busy, plain(failed.error)], ['ask', '', { text: '这一步没有成功，还没有生效', detail: 'Vignette write failed' }]);
  assert.equal(failed.actions.length, 2, 'it can be answered again');
  // Not read yet: the card without actions (none may be stale); a failed read sends to the runtime panel.
  const waiting = R.card({ fact: fact(), list: 'loading', catName: '团子' });
  assert.deepEqual([waiting.mode, waiting.actions.length, waiting.waiting, waiting.title], ['ask', 0, '正在读取…', '团子想记住你的一个偏好']);
  const unread = R.card({ fact: fact(), list: 'error', catName: '团子' });
  assert.deepEqual([unread.mode, unread.actions.length, unread.runtime, unread.title, unread.body], ['ask', 0, true, '团子想记住你的一个偏好', '回答简短一点，先说结论']);
  assert.match(unread.note, /暂时读不到这件事现在的状态/);
});

// Review 2026-11-11 (frontend-r5), finding 9.
test('after a fresh load an answered request says its real outcome in the chat\'s own words from the row; the engine\'s card title and Markdown body never become the words', () => {
  const R = rules();
  const schedule = { kind: 'schedule', title: '想设一个定时', body: '每周五写周报 · 每周五 17:00（Asia/Singapore）' };
  const raw = { title: '提议创建定时任务：每周五写周报', body: '**Create schedule**: 每周五写周报\n\n`0 17 * * 5`' };
  const row = (state?: string, words = schedule) => ({ ...fact(state, words), ...raw });
  const done = (state: string, words = schedule) => R.card({ fact: row(state, words), list: 'idle', catName: '团子' });
  assert.deepEqual([done('approved').text, done('approved').what, done('approved').tone], ['已设好这个定时', '每周五写周报 · 每周五 17:00（Asia/Singapore）', 'ok']);
  assert.equal(done('rejected').text, '没有设这个定时');
  assert.equal(done('approved', { ...schedule, title: '想取消一个定时' }).text, '已取消这个定时');
  assert.equal(done('rejected', { ...schedule, title: '想取消一个定时' }).text, '这个定时还留着');
  assert.equal(done('approved', { kind: 'profile', title: '想更新关于你的资料', body: '住在新加坡' }).text, '已更新关于你的资料');
  assert.equal(done('rejected', { kind: 'person', title: '想记下一位相关的人', body: '同事小林' }).text, '没有记这个人');
  // Still open, the list slow or unreadable: the card from the row, its subject the cat; never an action.
  for (const list of ['idle', 'loading', 'error', 'missing']) {
    const v = R.card({ fact: row(), list, catName: '团子' });
    assert.deepEqual([v.mode, v.title, v.body, v.actions.length], ['ask', '团子想设一个定时', '每周五写周报 · 每周五 17:00（Asia/Singapore）', 0], list);
  }
  // No longer open and no receipt: neutral, still in the row's words.
  const gone = R.card({ fact: row(), list: 'ready', catName: '团子' });
  assert.deepEqual([gone.text, gone.what], ['已处理', '每周五写周报 · 每周五 17:00（Asia/Singapore）']);
  // Wherever it is drawn, nothing of the engine's own wording shows.
  const views = [done('approved'), done('rejected'), gone, R.card({ fact: row(), list: 'error', catName: '团子' })];
  for (const v of views) assert.doesNotMatch(JSON.stringify(v), /提议|Create schedule|\*\*|`/);
  assert.deepEqual(plain(R.wording({ kind: 'mystery', title: '' }, null, null, '')), { kind: 'other', title: '猫猫有件事等你确认', body: '', quote: '' });
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
  assert.equal(R.choice(block, { phase: 'refused', error: { text: '同一个选项不能选两次' } }).note, '同一个选项不能选两次');
  // Already answered (409): nothing is offered again.
  const conflict = R.choice(block, { phase: 'conflict', ids: ['b'], error: { text: '这个选项已经回答过了' } });
  assert.deepEqual([conflict.mode, conflict.busy, conflict.note, conflict.sending.length], ['ask', true, '这个选项已经回答过了，这里不再提供选择。', 0]);
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
  // The server's stand-in for a reply that ended before any words is the line's own words (b1dbf60a): not drawn as a reply.
  assert.equal(R.words({ ended: { how: 'failed' } }, '这次没完成'), '');
  assert.equal(R.words({ ended: { how: 'interrupted' } }, '中途被打断'), '');
  assert.equal(R.words({ ended: { how: 'stopped' } }, '已停止'), '');
  assert.equal(R.words({ ended: { how: 'failed' } }, '这次没完成，请查看详情'), '这次没完成，请查看详情', 'the old stand-in is no longer one: words a cat really wrote are kept');
  assert.equal(R.words({ ended: { how: 'stopped' } }, '写到一半'), '写到一半', 'words written before it stopped stay');
  assert.equal(R.words({ blocks: [{ kind: 'card', approval: { id: 'p1' } }] }, '提议捕捉品味信号：…'), '', 'the request card is drawn instead');
  const messages = [
    { id: 'u1', native_message_id: 'u1', role: 'user', content: '失败了吗' },
    { id: 'r1', role: 'assistant', native: { replyTo: 'u1' }, ended: { how: 'failed' } },
  ];
  assert.deepEqual(plain(R.resend(messages, messages[1], false)), { id: 'u1', text: '失败了吗', files: 0, all: [{ id: 'u1', text: '失败了吗', files: 0 }] });
  // A reply that took in what the owner said meanwhile was answering all of it: every one, in the order said, the owner's own words,
  // those its record lists and that say this reply accepted them (one that stayed pending, or went to another reply, was answered elsewhere).
  const took = (by: string, how = 'accepted') => ({ kind: 'input', dispatchRefs: [{ targetId: 'c', statusMessageId: by, appendAcceptance: how }] });
  const went = [
    { id: 'u1', native_message_id: 'u1', role: 'user', content: '看看这个', attachments: [{ id: 'f' }] },
    { id: 'a1', native_message_id: 'a1', role: 'assistant', ended: { how: 'failed' }, native: { id: 'a1', replyTo: 'u1', lifecycle: { status: 'failed', inputMessageIds: ['u1', 'u2', 'u3', 'u4', 'u5', 'gone'] } } },
    { id: 'u2', native_message_id: 'u2', role: 'user', content: '还有导出', native: { lifecycle: took('a1') } },
    { id: 'u3', native_message_id: 'u3', role: 'user', content: '再加一句', native: { lifecycle: took('a1', 'pending') } },
    { id: 'u4', native_message_id: 'u4', role: 'user', content: '<untrusted_event source="timer">\n喝水\n</untrusted_event>', native: { lifecycle: took('a1') } },
    { id: 'u5', native_message_id: 'u5', role: 'user', content: '最后一点', native: { lifecycle: took('a1') } },
  ];
  assert.deepEqual(plain(R.resend(went, went[1], false).all), [{ id: 'u1', text: '看看这个', files: 1 }, { id: 'u2', text: '还有导出', files: 0 }, { id: 'u5', text: '最后一点', files: 0 }]);
  const elsewhere = went.map((m) => (m.id === 'u2' ? { ...m, native: { lifecycle: took('a9') } } : m));
  assert.deepEqual(plain(R.resend(elsewhere, elsewhere[1], false).all).map((x: Any) => x.id), ['u1', 'u5']);
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
  const step = (data: Any, inView = '') => { const out = N.decide(mem, N.chats(data), (key: string) => key === inView); mem = out.memory; return plain(out.notes); };
  const tz = (activity: Any, more: Record<string, unknown> = {}) => status([{ bot: '团子', native_id: 'cat-1', activity, ...more }]);
  assert.deepEqual(step(tz(act({ last: reply('m1'), unread: 3 }))), [], 'what was there when the page opened');
  const got = step(tz(act({ last: reply('m2', '纸箱让猫觉得安全'), unread: 4 })));
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].kind, got[0].key, got[0].id, got[0].nativeId, got[0].messageId, got[0].text, got[0].tag], ['reply', 'bot:cat-1', '团子', 'cat-1', 'm2', '纸箱让猫觉得安全', 'msg:m2']);
  assert.deepEqual(step(tz(act({ last: reply('m2'), unread: 4 }))), [], 'never twice');
  assert.deepEqual(step(tz(act({ last: reply('m3'), unread: 1 })), 'bot:cat-1'), [], 'the chat in view');
  assert.deepEqual(step(tz(act({ last: reply('m4', '读过了'), unread: 0 }))), [], 'already read');
  assert.deepEqual(step(tz(act({ last: { ...reply('m5'), from: 'owner' }, unread: 0 }))), [], 'the owner\'s own words');
  assert.deepEqual(step(tz(null)), [], 'a chat it could not read changes nothing');
  assert.deepEqual(step(tz(act({ last: reply('m5'), unread: 1 }))), [], 'the same latest line after a failed read is not new');
  // A new request: once; in a group too.
  const ask = { id: 'approval:F221:p9', kind: 'approval', label: '等你确认：x', catName: '年糕', messageId: 'mc', proposalId: 'p9' };
  assert.deepEqual(step(status([], [{ id: 'g1', activity: act({ threadId: 'tg' }) }])), []);
  const asked = step(status([], [{ id: 'g1', activity: act({ threadId: 'tg', items: [ask] }) }]));
  assert.deepEqual([asked[0].kind, asked[0].key, asked[0].proposalId, asked[0].tag], ['approval', 'group:g1', 'p9', 'msg:mc']);
  assert.deepEqual(step(status([], [{ id: 'g1', activity: act({ threadId: 'tg', items: [ask] }) }])), []);
  // A request whose card message is the chat's latest line: one note for the request, none for the card.
  const ask2 = { ...ask, id: 'approval:F139:p10', proposalId: 'p10', messageId: 'mc2' };
  const both = step(status([], [{ id: 'g1', activity: act({ threadId: 'tg', items: [ask, ask2], last: reply('mc2', '想设一个定时：喝水'), unread: 2 }) }]));
  assert.deepEqual(both.map((n: Any) => [n.kind, n.tag]), [['approval', 'msg:mc2']]);
  // Another conversation of the same cat: only remembered.
  assert.deepEqual(step(tz(act({ threadId: 't2', last: reply('old'), unread: 9 }))), []);
  // A reminder that came due is a line of its own, never the latest line: the cat's reply that follows is told once.
  assert.deepEqual(step(tz(act({ threadId: 't2', last: reply('after-reminder', '起来走走吧'), unread: 10 }))).map((n: Any) => n.text), ['起来走走吧']);
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
  assert.match(N.asked('granted', false).said, /^已打开。这个浏览器没能记住这个设置/);
  assert.match(N.turnedOff(false), /^已关闭。这个浏览器没能记住这个设置/);
});

// Review 2026-11-11 (frontend-r5), findings 5, 7 and 8.
test('notifications know a cat by its native ID, take the first successful read of each part as what was already there, and never tell one request twice when its approvals could not be read', () => {
  const N = notifyRules();
  let mem = new Map();
  const step = (data: Any) => { const out = N.decide(mem, N.chats(data), () => false); mem = out.memory; return plain(out.notes); };
  const cat = (name: string, activity: Any) => status([{ bot: name, native_id: 'cat-1', activity }]);
  // Finding 5: renamed between reads, the same cat; a click finds it by its native ID.
  step(cat('团子', act({ last: reply('m1'), unread: 1 })));
  const renamed = step(cat('大团子', act({ last: reply('m2', '还在'), unread: 2 })));
  assert.deepEqual(renamed.map((n: Any) => [n.key, n.id, n.nativeId]), [['bot:cat-1', '大团子', 'cat-1']], 'the rename is not a first sight, and the note carries the stable ID');
  // Finding 7: the first reads fail; the first successful one only remembers what was there.
  mem = new Map();
  const ask = { id: 'approval:F139:p1', kind: 'approval', label: '等你确认', catName: '团子', messageId: 'm-card', proposalId: 'p1' };
  assert.deepEqual(step(cat('团子', act({ readStatus: 'unavailable', unread: null, items: [], errors: [{ source: 'thread', message: 'x' }] }))), []);
  assert.deepEqual(step(cat('团子', null)), []);
  assert.deepEqual(step(cat('团子', act({ last: reply('already-there'), unread: 5, items: [ask] }))), [], 'already there before the first successful read');
  // Approvals failing at first while messages read: the approvals' own first success is only a baseline too.
  mem = new Map();
  step(cat('团子', act({ readStatus: 'partial', errors: [{ source: 'approvals', message: 'x' }], last: reply('m0'), unread: 0 })));
  assert.deepEqual(step(cat('团子', act({ last: reply('m0'), unread: 0, items: [ask] }))), [], 'a request that was already waiting is not news');
  // Finding 8: the approvals cannot be read when a request's card message arrives: it waits for them, then is told once, as the request.
  mem = new Map();
  step(cat('团子', act({ last: reply('m0'), unread: 0 })));
  const partial = act({ readStatus: 'partial', errors: [{ source: 'approvals', message: 'x' }], last: reply('m-card', '想设一个定时：每周五写周报'), unread: 1 });
  assert.deepEqual(step(cat('团子', partial)), [], 'not told as a reply while the approvals are unknown');
  const told = step(cat('团子', act({ last: reply('m-card', '想设一个定时：每周五写周报'), unread: 1, items: [ask] })));
  assert.deepEqual(told.map((n: Any) => [n.kind, n.tag]), [['approval', 'msg:m-card']]);
  assert.deepEqual(step(cat('团子', act({ last: reply('m-card'), unread: 1, items: [ask] }))), []);
  // An ordinary reply while the approvals stay unreadable is told after a short wait, not never.
  const later = (id: string) => act({ readStatus: 'partial', errors: [{ source: 'approvals', message: 'x' }], last: reply(id, '普通回复'), unread: 2 });
  assert.deepEqual(step(cat('团子', later('m9'))), []);
  assert.deepEqual(step(cat('团子', later('m9'))), []);
  assert.deepEqual(step(cat('团子', later('m9'))).map((n: Any) => [n.kind, n.tag]), [['reply', 'msg:m9']]);
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
  // The first drawing's rows are already still (not news); the redraw marks none of them again.
  const still = before.map(r => r.classList.contains('lv-still'));
  p.draw(history);
  assert.deepEqual(p.rows(), before, 'every row kept');
  assert.equal(p.row('m-card').querySelector('.approval'), card, 'the card itself kept');
  assert.deepEqual(p.rows().map(r => r.classList.contains('lv-still')), still, 'nothing redrawn');
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
  assert.match(p.row('m-card').textContent, /已记住这个偏好 · 回答简短一点，先说结论/);
  const notice = p.row('n1');
  assert.deepEqual([notice.className, notice.textContent], ['sysline ck-notice', '已记住这个偏好。']);
  // A reminder that came due: the same kind of line, a little more present (the alarm clock), still no speaker.
  p.draw([...history.slice(0, 2), cardMessage('approved'), { id: 'n2', role: 'assistant', notice: true, reminder: true, content: '提醒：该站起来活动一下了！' }]);
  const due = p.row('n2');
  assert.deepEqual([due.className, due.textContent, due.querySelector('svg')!.dataset.icon], ['sysline ck-notice ck-reminder', '提醒：该站起来活动一下了！', 'alarm-clock']);
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
  assert.match(box().textContent, /这个选项已经回答过了，这里不再提供选择。/);
  assert.equal(p.reloads(), 1, 'the conversation is read again so the block shows its recorded answer');
  // Review 2026-11-11 (frontend-r5), finding 2: after the conflict a click sends no second message.
  assert.ok(box().querySelectorAll('button.ask-opt').every(b => b.getAttribute('aria-disabled') === 'true'), 'nothing offered');
  box().querySelectorAll('button.ask-opt')[1].click();
  assert.equal(p.sends.length, 2, 'no further chat message after the server said it was answered');
  assert.equal(p.posts.length, 2);
  // A later drawing of the same (stale) record, e.g. a cached earlier page, still offers nothing.
  p.draw([choiceMessage(weekend)]);
  box().querySelectorAll('button.ask-opt')[0].click();
  assert.equal(p.sends.length, 2);
  // A read that brings the record shows the answer.
  p.draw([choiceMessage({ ...weekend, answered: true, selected: ['park'] })]);
  assert.ok(box().classList.contains('done'));
  assert.match(box().textContent, /🌳 去公园/);
  // A 409 because the conversation moved is not that: the pick stays open.
  const moved = page();
  moved.draw([choiceMessage(weekend)]);
  moved.row('m-pick').querySelectorAll('button.ask-opt')[0].click();
  moved.sends[0].sent();
  moved.posts[0].answer({ status: 409, body: { error: '对话已变化，请刷新后重试' } });
  await settle();
  assert.ok(moved.row('m-pick').querySelectorAll('button.ask-opt').every(b => b.getAttribute('aria-disabled') !== 'true'));
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
  // Item 46: the limit is told to a screen reader until it is reached, then shown, when the rest turn unavailable.
  const limit = () => box().querySelector('.approval-timer')!;
  assert.equal(limit().textContent, '最多选 2 项');
  assert.ok(limit().classList.contains('visually-hidden'), 'nothing picked: not on screen');
  opt('书').click();
  assert.ok(limit().classList.contains('visually-hidden'), 'one of two: still not on screen (确认选择（1） counts)');
  opt('水').click();
  assert.equal(opt('伞').getAttribute('aria-disabled'), 'true', 'max reached');
  assert.ok(!limit().classList.contains('visually-hidden'), 'the limit reached: shown, the reason the third is unavailable');
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
    { id: 'r1', role: 'assistant', content: '这次没完成', status: 'failed', ended: { how: 'failed', reason: 'Error: rate limit exceeded' }, native: { replyTo: 'u1' } },
    { id: 'u2', role: 'user', content: '停' },
    { id: 'r2', role: 'assistant', content: '写到一半', ended: { how: 'stopped' }, native: { replyTo: 'u2' } },
  ];
  p.draw(history);
  const failed = p.row('r1');
  assert.equal((failed.textContent.match(/这次没完成/g) || []).length, 1, 'the stand-in words are not the reply: 「这次没完成」 once, in the line under it');
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

test('再发一次 on a reply that took in what was said meanwhile sends all of it again, each as the message it was, one after the other; one not taken stops the rest and the line says how many went', async () => {
  const took = { kind: 'input', dispatchRefs: [{ targetId: 'c', statusMessageId: 'r1', appendAcceptance: 'accepted' }] };
  const history = [
    { id: 'u1', native_message_id: 'u1', role: 'user', content: '帮我查一下' },
    { id: 'r1', native_message_id: 'r1', role: 'assistant', content: '这次没完成', status: 'failed', ended: { how: 'failed' }, follows: 3,
      native: { id: 'r1', replyTo: 'u1', lifecycle: { status: 'failed', inputMessageIds: ['u1', 'u2', 'u3'] } } },
    { id: 'u2', native_message_id: 'u2', role: 'user', content: '顺便看下导出', native: { lifecycle: took } },
    { id: 'u3', native_message_id: 'u3', role: 'user', content: '还有同步', native: { lifecycle: took } },
  ];
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const p = page();
  p.draw(history);
  const line = p.row('r1').querySelector('.ck-ended')!;
  assert.equal(button(line, '再发一次').getAttribute('aria-label'), '再发一次：帮我查一下，共 3 句');
  button(line, '再发一次').click();
  assert.deepEqual(p.sends.map((s: Any) => s.text), ['帮我查一下'], 'one at a time');
  p.sends[0].sent(); p.sends[0].done(); await settle();
  assert.deepEqual(p.sends.map((s: Any) => s.text), ['帮我查一下', '顺便看下导出'], 'the next once the one before was handled, in the order said');
  assert.match(line.textContent, /正在发送…/, 'not said to be done before the last one went');
  p.sends[1].sent(); p.sends[1].done(); await settle();
  p.sends[2].sent();
  assert.match(line.textContent, /已再发一次（3 句）/);
  // Not taken: what went is said, the rest is not sent, and nothing offers to send it all twice.
  const q = page();
  q.draw(history);
  const other = q.row('r1').querySelector('.ck-ended')!;
  button(other, '再发一次').click();
  q.sends[0].sent(); q.sends[0].done(); await settle();
  q.sends[1].done(); await settle();
  assert.equal(q.sends.length, 2);
  assert.match(other.textContent, /再发了 1 句，第 2 句没有发出去/);
  assert.doesNotMatch(other.textContent, /再发一次$/);
});

// ---------------------------------------------------------------- notifications page
// One browser with any number of tabs of this page: each tab is its own VM
// with its own DOM, and they share what a browser shares between tabs. Its
// storage is kept per tab and reaches the other tabs a moment later (as
// localStorage does between tab processes), and can be made to fail;
// BroadcastChannel delivers a tick later; navigator.locks is a real mutex.
function browser(opts: { permission?: string; answer?: string; supported?: boolean; failing?: boolean; locks?: boolean } = {}) {
  const tabs: Any[] = [];
  const shown: Array<{ tab: number; title: string; opts: Any; n: Any }> = [];
  const lag = 30;
  let failing = !!opts.failing, asked = 0, perm = opts.permission ?? 'default';
  const channels: Any[] = [];
  const queue = new Map<string, Promise<unknown>>();
  const locks = { request: (name: string, fn: () => unknown) => { const run = (queue.get(name) ?? Promise.resolve()).then(() => fn()); queue.set(name, run.catch(() => {})); return run; } };
  function tab(over: { visible?: boolean; sel?: Any; stored?: Record<string, string> } = {}) {
    const index = tabs.length;
    const doc = new Doc();
    doc.visibilityState = over.visible === false ? 'hidden' : 'visible';
    const pane = doc.createElement('div');
    pane.setAttribute('data-spane', 'general');
    doc.body.append(pane);
    const local = new Map<string, string>(Object.entries(over.stored ?? {}));
    const winListeners: Record<string, Array<(ev: Any) => void>> = {};
    function Notification(this: Any, title: string, o: Any) { this.closed = false; this.close = () => { this.closed = true; }; shown.push({ tab: index, title, opts: o, n: this }); }
    Object.defineProperty(Notification, 'permission', { get: () => perm });
    (Notification as Any).requestPermission = () => { asked++; perm = opts.answer ?? 'granted'; return Promise.resolve(perm); };
    class Channel { onmessage: ((ev: Any) => void) | null = null; constructor() { channels.push({ tab: index, ch: this }); }
      postMessage(data: unknown) { for (const c of channels) if (c.tab !== index) setTimeout(() => c.ch.onmessage?.({ data: plain(data) }), 0); } }
    let focused = 0;
    const window: Any = {
      localStorage: {
        getItem: (k: string) => local.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (failing) throw new Error('QuotaExceededError');
          local.set(k, v);
          for (const t of tabs) if (t.index !== index) setTimeout(() => { t.local.set(k, v); for (const fn of t.winListeners.storage ?? []) fn({ key: k, newValue: v }); }, lag);
        },
      },
      focus: () => { focused++; },
      addEventListener: (type: string, fn: (ev: Any) => void) => { (winListeners[type] ??= []).push(fn); },
      BroadcastChannel: Channel,
    };
    if (opts.supported !== false) window.Notification = Notification;
    const navigator = opts.locks === false ? {} : { locks };
    const context = vm.createContext({ window, document: doc, navigator, console, JSON, Promise, setTimeout, Date, Math });
    for (const f of ['chat-notify-rules.js', 'chat-notify.js']) vm.runInContext(read('client/public/' + f), context);
    const opened: Any[] = [];
    let sel: Any = over.sel ?? null, signedIn = true;
    window.ClowderNotify.init({ selection: () => sel, signedIn: () => signedIn, open: (note: Any) => opened.push(note), chatName: () => '' });
    const t = {
      index, doc, local, winListeners, opened, notify: window.ClowderNotify,
      pane, toggle: pane.querySelector('[role=switch]')!, said: pane.querySelector('.ck-notify-said')!,
      focused: () => focused, select: (x: Any) => { sel = x; t.notify.tell(); }, signOut: () => { signedIn = false; t.notify.reset(); },
      show: (state: 'visible' | 'hidden') => { doc.visibilityState = state; doc.dispatch(doc.body, new Ev('visibilitychange')); },
    };
    tabs.push(t);
    return t;
  }
  return { tab, tabs, shown, asked: () => asked, fail: (on: boolean) => { failing = on; } };
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const tuanzi = (id: string, unread = 1, text = '纸箱让猫觉得安全又暖和') => ({ bots: [{ bot: '团子', native_id: 'cat-1', activity: act({ last: reply(id, text), unread }) }], groups: [] });

test('the switch asks the browser only when turned on, says plainly when it refused or cannot, and is remembered', async () => {
  const b = browser();
  const p = b.tab();
  assert.equal(p.toggle.getAttribute('aria-checked'), 'false');
  assert.match(p.pane.textContent, /桌面通知/);
  // Item 46: the row names itself (no 通知 heading); when it reminds is the switch's description, for a screen reader.
  assert.equal(p.pane.querySelectorAll('h4').length, 0);
  const hint = p.pane.querySelector('.hint')!;
  assert.equal(hint.id, 'ck-notify-hint');
  assert.ok(hint.classList.contains('visually-hidden'));
  assert.equal(hint.textContent, '猫猫回复了，或有事等你确认时提醒你。正在看的聊天不提醒，没有声音。');
  assert.match(p.toggle.getAttribute('aria-describedby')!, /ck-notify-hint/);
  p.toggle.click();
  await settle();
  assert.equal(b.asked(), 1);
  assert.deepEqual([p.toggle.getAttribute('aria-checked'), p.local.get('clowder-bot:notify'), p.said.textContent], ['true', 'on', '已打开。']);
  assert.equal(p.notify.wanted(), true);
  p.toggle.click();
  assert.deepEqual([p.toggle.getAttribute('aria-checked'), p.local.get('clowder-bot:notify'), p.said.textContent], ['false', 'off', '已关闭。']);
  const refused = browser({ answer: 'denied' }).tab();
  refused.toggle.click();
  await settle();
  assert.equal(refused.toggle.getAttribute('aria-checked'), 'false');
  assert.match(refused.said.textContent, /浏览器拒绝了通知/);
  const blockedBrowser = browser({ permission: 'denied' });
  const blocked = blockedBrowser.tab();
  blocked.toggle.click();
  await settle();
  assert.equal(blockedBrowser.asked(), 0, 'a refusal is not asked again behind the owner\'s back');
  assert.match(blocked.said.textContent, /浏览器拒绝了通知/);
  const none = browser({ supported: false }).tab();
  assert.match(none.said.textContent, /这个浏览器不支持桌面通知/);
  none.toggle.click();
  assert.equal(none.toggle.getAttribute('aria-checked'), 'false');
});

// Review 2026-11-11 (frontend-r5), finding 3.
test('when the browser cannot remember the switch, it still does what it says on this page and says it was not remembered', async () => {
  // On from before, then the browser stops keeping anything: 已关闭 really turns it off.
  const b = browser({ permission: 'granted' });
  const p = b.tab({ stored: { 'clowder-bot:notify': 'on' } });
  assert.equal(p.notify.wanted(), true);
  b.fail(true);
  p.toggle.click();
  assert.equal(p.notify.wanted(), false, 'off on this page (and the hidden tab stops reading every 6 s)');
  assert.equal(p.toggle.getAttribute('aria-checked'), 'false');
  assert.match(p.said.textContent, /^已关闭。这个浏览器没能记住这个设置/);
  p.notify.observe(tuanzi('m1'));
  p.notify.observe(tuanzi('m2'));
  await wait(10);
  assert.equal(b.shown.length, 0, 'and nothing is shown');
  // Turning on with a browser that keeps nothing: on for this page, said plainly.
  const c = browser({ permission: 'granted', failing: true });
  const q = c.tab();
  q.toggle.click();
  await settle();
  assert.equal(q.notify.wanted(), true);
  assert.match(q.said.textContent, /^已打开。这个浏览器没能记住这个设置/);
});

test('a notification repeats the polled status: the cat\'s name and the reply\'s first line, silent, once; a click focuses the tab and opens that chat; never while off or for the chat in view', async () => {
  const b = browser({ permission: 'granted' });
  const p = b.tab({ sel: { type: 'bot', id: '栗子', nativeId: 'cat-2' } });
  p.notify.observe(tuanzi('m1'));
  p.notify.observe(tuanzi('m2'));
  await wait(10);
  assert.equal(b.shown.length, 0, 'off: nothing');
  p.toggle.click();
  await settle();
  p.notify.observe(tuanzi('m3'));
  await wait(10);
  assert.equal(b.shown.length, 1);
  assert.deepEqual([b.shown[0].title, b.shown[0].opts.body, b.shown[0].opts.silent, b.shown[0].opts.tag], ['团子', '纸箱让猫觉得安全又暖和', true, 'clowder-bot:msg:m3']);
  p.notify.observe(tuanzi('m3'));
  await wait(300);
  assert.equal(b.shown.length, 1, 'never twice');
  b.shown[0].n.onclick();
  assert.deepEqual([p.focused(), p.opened[0].key, p.opened[0].nativeId, b.shown[0].n.closed], [1, 'bot:cat-1', 'cat-1', true]);
  // The chat in view: nothing; the same chat while the tab is hidden: yes.
  p.select({ type: 'bot', id: '团子', nativeId: 'cat-1' });
  p.notify.observe(tuanzi('m4'));
  await wait(300);
  assert.equal(b.shown.length, 1);
  p.show('hidden');
  p.notify.observe(tuanzi('m5'));
  await wait(300);
  assert.equal(b.shown.length, 2);
});

// Review 2026-11-11 (frontend-r5), finding 4.
test('a status read that began before signing out never notifies after it', async () => {
  const b = browser({ permission: 'granted' });
  const p = b.tab({ stored: { 'clowder-bot:notify': 'on' } });
  p.notify.observe(tuanzi('m1'), p.notify.ticket());
  const before = p.notify.ticket();
  p.signOut();
  p.notify.observe(tuanzi('m2', 3, '私人的话'), before);
  p.notify.observe(tuanzi('m3', 3, '私人的话'));
  await wait(300);
  assert.equal(b.shown.length, 0, 'neither the late answer nor any read while signed out');
});

// Review 2026-11-11 (frontend-r5), finding 6.
test('tabs of the page agree: no notification for a chat open in another visible tab, and one note is shown by one tab only', async () => {
  const b = browser({ permission: 'granted' });
  const on = { 'clowder-bot:notify': 'on' };
  const shown = b.tab({ visible: true, sel: { type: 'bot', id: '团子', nativeId: 'cat-1' }, stored: on });
  const hidden = b.tab({ visible: false, sel: { type: 'bot', id: '团子', nativeId: 'cat-1' }, stored: on });
  for (const t of [shown, hidden]) t.notify.observe(tuanzi('m1'));
  await wait(20);
  // The visible tab shows 团子: the hidden tab hears it and stays quiet.
  hidden.notify.observe(tuanzi('m2'));
  shown.notify.observe(tuanzi('m2'));
  await wait(300);
  assert.equal(b.shown.length, 0, 'the owner is looking at that chat in the other tab');
  // The visible tab moves to another chat: now a reply in 团子 is news, shown once.
  shown.select({ type: 'bot', id: '栗子', nativeId: 'cat-2' });
  await wait(20);
  hidden.notify.observe(tuanzi('m3'));
  shown.notify.observe(tuanzi('m3'));
  await wait(400);
  assert.equal(b.shown.length, 1, 'one note, though both tabs saw it');
  // Both tabs hidden and reading at the same moment: still one (they take turns; storage alone lags between tabs).
  shown.show('hidden');
  await wait(20);
  hidden.notify.observe(tuanzi('m4'));
  shown.notify.observe(tuanzi('m4'));
  await wait(700);
  assert.deepEqual(b.shown.map((n) => n.opts.tag), ['clowder-bot:msg:m3', 'clowder-bot:msg:m4']);
});

// ---------------------------------------------------------------- the real send path
// app.js's own sendText, run with the shell around it faked: a choice's pick
// and 再发一次 go through it with a card of their own (chat-cards.js hands
// `{ sent }`), and leave the composer's draft and quote alone.
// Review 2026-11-11 (frontend-r5), findings 1 and 10.
function sendPath(opts: { fail?: boolean } = {}) {
  const app = read('client/public/app.js');
  const code = /\n {2}async function sendText\([^)]*\) \{\n[\s\S]*?\n {2}\}\n/.exec(app);
  assert.ok(code, 'sendText is where the shell keeps it');
  const doc = new Doc();
  const calls: Any = { posts: [] as Any[], clearQuote: 0, composerSet: [] as string[], giveBack: 0, quoteBar: 0 };
  let draft = '我正在写的话';
  const state: Any = { sel: { type: 'bot', id: '团子' }, replyTo: { seq: 7, thread: 't1' }, pendingSends: [], replyErrors: [], streaming: 0, threadLoad: 0, sig: 'x' };
  const h = (tag: string, cls = '', text?: string) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const out: Any = {};
  vm.runInNewContext(code![0] + 'out.sendText = sendText;', {
    out, state, document: doc, setTimeout, JSON,
    clearQuote: () => { calls.clearQuote++; state.replyTo = null; },
    requestKey: () => 'key-1',
    optimisticMessage: (text: string) => {
      const row = h('div', 'msg user optimistic'), col = h('div', 'bubble-col');
      col.append(h('div', 'bubble', text), h('div', 'send-state', '发送中'));
      row.append(col);
      doc.body.append(row);
      return row;
    },
    ownerSends: () => 0, announceSend: () => {},
    live: { expect: () => ({ accept() {}, drop() {} }) }, botCatId: () => 'cat-1',
    workspace: { threadId: () => 't1', giveBack: () => false },
    apiFetch: async (_path: string, opt: Any) => {
      calls.posts.push(JSON.parse(opt.body));
      if (opts.fail) throw new Error('连不上 clowder-bot');
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ userMessageId: 'u-9' }), text: async () => '' };
    },
    liveRules: { receipt: (data: Any) => ({ userMessageId: data.userMessageId || '', error: '' }) },
    loadThread: async () => {}, authenticated: true, sessionStorage: { setItem() {} },
    chatList: { giveBack: () => { calls.giveBack++; } },
    setStatus: () => {}, el: h, zhError: (m: string) => m, errorDetails: () => {}, thread: doc.body,
    paintQuoteBar: () => { calls.quoteBar++; },
    composerText: () => draft, composerSet: (t: string) => { calls.composerSet.push(t); draft = t; },
    composerRefreshHeight: () => {}, syncComposer: () => {}, composerCaretTo: () => {}, input: {},
  });
  return { send: out.sendText, calls, state, draft: () => draft, doc };
}

test('a card\'s own words go out through the real send path without taking the composer\'s quote or draft, and stay with the card when they do not go out', async () => {
  const ok = sendPath();
  let sent = 0;
  await ok.send('我选 🌳 去公园', null, null, null, { sent: () => { sent++; } });
  assert.equal(sent, 1, 'told once the server took it');
  assert.equal(ok.calls.posts.length, 1);
  assert.equal('reply_to' in ok.calls.posts[0], false, 'the composer\'s quote is not the pick\'s');
  assert.deepEqual([ok.calls.clearQuote, ok.state.replyTo, ok.draft()], [0, { seq: 7, thread: 't1' }, '我正在写的话'], 'quote and draft stay with the composer');
  // Not sent: the words do not land in the composer or the chat's draft; the bubble says so.
  const bad = sendPath({ fail: true });
  let told = 0;
  await bad.send('再发一次的话', null, null, null, { sent: () => { told++; } });
  assert.equal(told, 0);
  assert.deepEqual([bad.calls.composerSet, bad.calls.giveBack, bad.calls.clearQuote, bad.state.replyTo, bad.draft()], [[], 0, 0, { seq: 7, thread: 't1' }, '我正在写的话']);
  assert.match(bad.doc.body.textContent, /没发出去$/);
  // The composer's own send still takes its quote (nothing changed for it).
  const own = sendPath();
  await own.send('我自己写的话', null, null, null);
  assert.deepEqual([own.calls.posts[0].reply_to, own.calls.clearQuote], [7, 1]);
  // And chat-cards.js is handed exactly that path.
  assert.match(read('client/public/app.js'), /send: \(text, sent\) => sendText\(text, null, null, null, \{ sent \}\),/);
});

// ---------------------------------------------------------------- wiring
test('the page loads the round\'s scripts before app.js and its styles just before chat-presence.css, sidebar.css and chat-live.css; the shell hands them its own paths and never writes a second title', () => {
  const html = read('client/index.html'), app = read('client/public/app.js');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('chat-live.js') < at('chat-cards-rules.js') && at('chat-cards-rules.js') < at('chat-cards.js') && at('chat-cards.js') < at('app.js'));
  assert.ok(at('chat-notify-rules.js') < at('chat-notify.js') && at('chat-notify.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  // Only 活起来's styles (chat-presence.css) and the sidebar's (sidebar.css, item 43) sit between them.
  assert.deepEqual(styles.slice(-5), ['chat-cards.css', 'chat-presence.css', 'chat-reactions.css', 'sidebar.css', 'chat-live.css']);
  // Both histories: words, blocks and the ending through chat-cards.js; frames filled right after each keyed commit.
  assert.equal((app.match(/cards\.words\(m, isSilent\(/g) || []).length, 2);
  assert.equal((app.match(/cards\.blocks\(body, m, messages, (true|false)\);/g) || []).length, 2);
  assert.equal((app.match(/cards\.ending\(body, m, messages, (true|false)\);/g) || []).length, 2);
  assert.equal((app.match(/const shown = live\.commit\(inner, [^\n]+\);\n\s+cards\.rendered\(\);/g) || []).length, 2);
  assert.equal((app.match(/cards\.notice\(m, /g) || []).length, 2);
  assert.equal((app.match(/cards\.observe\(selection, /g) || []).length, 2);
  assert.match(app, /cards\.select\(state\.sel\);\n\s+notify\.tell\(\);/);
  // Notifications: a status read belongs to the sign-in it began in; signing out resets them (findings 4, 5).
  assert.match(app, /const notifyTicket = notify\.ticket\(\);\n[^\n]*\n\s+try \{ data = await api\("\/xbot-api\/bots\/status"\)/);
  assert.match(app, /notify\.observe\(data, notifyTicket\);/);
  assert.match(app, /authenticated = false;\n\s+notify\.reset\(\);/);
  assert.match(app, /signedOut: \(\) => \{ forgetOwner\(\); authenticated = false; notify\.reset\(\);/);
  assert.match(app, /String\(b\.native_id \|\| b\.id \|\| ""\) === note\.nativeId/);
  // A pick and 再发一次 use the normal send path with a card of their own, told when the server took the message.
  assert.match(app, /async function sendText\(text, pending, images, files, card\)/);
  assert.match(app, /markSent\(\);\n\s+try \{ if \(card && card\.sent\) card\.sent\(\); \}/);
  assert.match(app, /confirm: \(item\) => cards\.find\(item\)/);
  assert.doesNotMatch(app + read('client/public/chat-experience.js'), /approvalLabel/, 'the server names waiting requests in everyday words now');
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
