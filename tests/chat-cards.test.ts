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
  // A change of a timer's parameters (改吧 / 先不改) is neither a new timer nor a removed one.
  assert.equal(done('approved', { ...schedule, title: '想改一个定时' }).text, '已改好这个定时');
  assert.equal(done('rejected', { ...schedule, title: '想改一个定时' }).text, '没有改这个定时');
  assert.equal(R.card({ fact: fact('approved'), item: null, list: 'ready', seen: { ...schedule, title: '团子想改一个定时' } }).text, '已改好这个定时', 'the open list\'s title, as this page last saw it');
  // The verb decides, never the cat's name in front of it.
  assert.equal(R.card({ fact: row('approved'), list: 'idle', catName: '取消' }).text, '已设好这个定时');
  assert.equal(R.card({ fact: row('rejected'), list: 'idle', catName: '改改' }).text, '没有设这个定时');
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
// ------------------------------------------------------------ F306 requests (item 59)
const askOne = { kind: 'question', revision: 3, canReject: true, questions: [{ id: 'q1', header: '方案', question: '用哪个方案？', options: [{ label: '方案 A', description: '快一点' }, { label: '方案 B' }], isOther: true }] };
const askMany = { kind: 'question', revision: 1, canReject: true, questions: [
  { id: 'lang', header: '技术栈', question: '用什么写这个工具？', options: [{ label: 'TypeScript' }, { label: 'Go' }, { label: 'Rust' }], multiSelect: true, isOther: true },
  { id: 'token', header: '令牌', question: '部署用的令牌是什么？', isSecret: true },
  { id: 'note', header: '备注', question: '还有什么要交代的？', allowUnanswered: true },
] };
const askApproval = { kind: 'approval', revision: 2, decisions: [
  { id: 'once', label: '允许一次', outcome: 'accept' }, { id: 'always', label: '始终允许', description: '以后同类操作不再询问', outcome: 'accept' }, { id: 'no', label: '拒绝', outcome: 'decline' },
] };
const askLink = (url: string) => ({ kind: 'elicitation', revision: 1, mode: 'url', message: '请先登录', url, decisions: [{ id: 'done', label: '我已完成', outcome: 'accept' }, { id: 'stop', label: '取消', outcome: 'cancel' }] });
const askForm = { kind: 'elicitation', revision: 5, mode: 'form', message: '寄送信息', fields: [
  { id: 'name', type: 'string', title: '收件人', required: true, minLength: 2, maxLength: 4 },
  { id: 'count', type: 'integer', title: '份数', minimum: 1, maximum: 5, default: 2, required: true },
  { id: 'ratio', type: 'number', title: '比例', required: false },
  { id: 'size', type: 'string', title: '尺寸', enum: ['S', 'M', 'L'], default: 'M', description: '按平时穿的选', required: false },
  { id: 'gift', type: 'boolean', title: '要包装', default: false, required: false },
], decisions: [{ id: 'ok', label: '提交', outcome: 'accept' }, { id: 'no', label: '不填了', outcome: 'decline' }] };
const askPick = { kind: 'conversation', revision: 1, mode: 'single', options: [{ id: 'sat', label: '周六', emoji: '📅' }, { id: 'sun', label: '周日' }, { id: 'other', label: '别的时间', custom: true }], allowText: true };
const askSeveral = { kind: 'conversation', revision: 1, mode: 'multiple', options: [{ id: 'a', label: '咖啡' }, { id: 'b', label: '茶' }, { id: 'c', label: '果汁' }], max: 2, allowText: false };
const askConfirm = { kind: 'conversation', revision: 1, mode: 'confirm', options: [{ id: '__confirm__', label: '开始' }, { id: '__cancel__', label: '先不用' }], allowText: false };
const askGoOn = { kind: 'conversation', revision: 1, mode: 'confirm', options: [{ id: '__confirm__', label: '继续' }], allowText: false };
// An F306 request as GET <scope>/approvals lists it, and the card block of its message.
const rtItem = (id: string, mid: string, runtime: Any, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'question', title: '团子有件事要问你', body: '', messageId: mid, state: 'open', approve: { label: '提交回答' }, reject: { label: '拒绝' }, runtime, ...over });
const rtMessage = (id: string, mid: string, kind = 'question', title = '有件事要问你') =>
  ({ id: mid, role: 'assistant', content: '运行交互', speaker: { name: '团子' }, blocks: [{ id: 'blk-' + id, kind: 'card', title: '运行交互', approval: { id, kind, title } }] });

test('F306 requests are read only as the contract describes them: each kind and part checked, labels kept exactly; a link that is not http(s) or any malformed part goes to the runtime panel; settled states and receipts are read from any row', () => {
  const R = rules();
  assert.deepEqual(plain(R.runtimePrompt({ ...askOne, questions: [{ ...askOne.questions[0], options: [{ label: ' 方案 A ' }, { label: '方案 B', description: '慢一点' }] }] })), { kind: 'question', revision: 3, questions: [{
    id: 'q1', header: '方案', question: '用哪个方案？', options: [{ label: ' 方案 A ', description: '' }, { label: '方案 B', description: '慢一点' }],
    multiSelect: false, isOther: true, isSecret: false, allowUnanswered: false }] }, 'an answer is the label itself, so the label is kept as the server gave it');
  assert.deepEqual(plain(R.runtimePrompt(askApproval).decisions.map((d: Any) => [d.id, d.outcome, d.description])), [['once', 'accept', ''], ['always', 'accept', '以后同类操作不再询问'], ['no', 'decline', '']]);
  assert.equal(R.runtimePrompt(askLink('https://login.example.com/device?code=AB12')).url, 'https://login.example.com/device?code=AB12');
  assert.deepEqual(plain(R.runtimePrompt(askForm).fields.map((f: Any) => [f.id, f.type, f.default, f.enum, f.required])), [
    ['name', 'string', null, null, true], ['count', 'integer', 2, null, true], ['ratio', 'number', null, null, false], ['size', 'string', 'M', ['S', 'M', 'L'], false], ['gift', 'boolean', false, null, false]]);
  assert.deepEqual(plain(R.runtimePrompt(askSeveral)), { kind: 'conversation', revision: 1, mode: 'multiple', options: [
    { id: 'a', label: '咖啡', emoji: '', description: '', custom: false }, { id: 'b', label: '茶', emoji: '', description: '', custom: false }, { id: 'c', label: '果汁', emoji: '', description: '', custom: false }], max: 2, allowText: false });
  const decision = [{ id: 'x', label: '好', outcome: 'accept' }];
  for (const bad of [
    null, { ...askOne, revision: 0 }, { ...askOne, questions: [] }, { ...askOne, questions: [{ id: 'a', question: 'x' }, { id: 'a', question: 'y' }] },
    { ...askOne, questions: [{ id: 'a', question: 'x', options: [] }] }, { ...askOne, questions: [{ id: 'a', question: 'x', options: [{ label: ' ' }] }] },
    { kind: 'approval', revision: 1, decisions: [{ id: 'x', label: '好', outcome: 'maybe' }] }, { kind: 'approval', revision: 1, decisions: [] },
    askLink('javascript:alert(1)'), askLink('data:text/html,hi'), askLink('file:///etc/passwd'), askLink('https://ok.example.com/a b'),
    { kind: 'elicitation', revision: 1, mode: 'form', message: 'm', fields: [{ id: 'f', type: 'object' }], decisions: decision },
    { kind: 'elicitation', revision: 1, mode: 'form', message: 'm', fields: [{ id: 'f', type: 'string', enum: [{}] }], decisions: decision },
    { ...askConfirm, options: [...askConfirm.options, { id: 'later', label: '以后再说' }] }, { ...askPick, mode: 'grid' }, { kind: 'mystery', revision: 1 },
  ]) assert.equal(R.runtimePrompt(bad), null, JSON.stringify(bad));
  // A confirmation is its "yes", and its "no" when it has one (upstream allows a confirm block of one option).
  assert.deepEqual(plain(R.runtimePrompt(askGoOn).options), [{ id: '__confirm__', label: '继续', emoji: '', description: '', custom: false }]);
  const got = R.approvals({ threadId: 't1', approvals: [
    rtItem('i1', 'm1', askOne),
    rtItem('i2', 'm2', askLink('javascript:alert(1)'), { kind: 'other', approve: { label: '我已完成' }, reject: null }),
  ], settled: [{ id: 'i3', state: 'approved', selected: ['方案 A', '', ' 方案  A '] }, { id: 'i4', state: 'open' }, { id: '', state: 'closed' }, { id: 'i5', state: 'closed' }] });
  assert.equal(got.list[0].runtime.kind, 'question');
  assert.deepEqual([got.list[1].runtime, got.list[1].approve, got.list[1].reject, got.list[1].note], [undefined, null, null, '这一项要在运行面板里回答'], 'never half drawn: the runtime panel');
  assert.deepEqual(plain(got.settled), [{ id: 'i3', state: 'approved', selected: ['方案 A'] }, { id: 'i5', state: 'closed', selected: [] }]);
  assert.deepEqual(plain(R.approvals({ threadId: 't', approvals: [] }).settled), []);
  const hub = (over: Record<string, unknown> = {}, connector = 'approval-hub') => ({ native: { source: { connector, meta: { approvalDecisionReceipt: { kind: 'approval_decision_receipt', canonicalProposalId: 'p2', resolution: 'rejected', approvalCardRef: { messageId: 'm2' }, ...over } } } } });
  assert.deepEqual(plain(R.receiptOf({ receipt: { proposalId: 'p1', state: 'approved' } })), { id: 'p1', state: 'approved' });
  assert.deepEqual(plain(R.receiptOf({ receipt: { proposalId: 'p1', producerId: 'F306', state: 'rejected', cardMessageId: 'm1' } })), { id: 'p1', state: 'rejected', card: 'm1' }, 'the server\'s receipt names its card as the native one does');
  assert.deepEqual(plain(R.receiptOf({ receipt: { proposalId: 'p1', state: 'approved', cardMessageId: '' } })), { id: 'p1', state: 'approved' });
  assert.deepEqual(plain(R.receiptOf(hub())), { id: 'p2', state: 'rejected', card: 'm2' });
  assert.deepEqual(plain(R.receiptOf(hub({ resolution: 'accepted', approvalCardRef: undefined }))), { id: 'p2', state: 'approved' });
  assert.equal(R.receiptOf(hub({}, 'someone-else')), null);
  assert.equal(R.receiptOf(hub({ kind: 'something_else' })), null);
  assert.equal(R.receiptOf({ receipt: { proposalId: 'p1', state: 'open' } }), null);
  assert.equal(R.receiptOf({ content: '已同意。' }), null);
});

test('an F306 answer is built from what the card shows and checked first in the server\'s own words: questions, forms, a cat\'s own choice, each native decision', () => {
  const R = rules();
  const one = R.runtimePrompt(askOne), many = R.runtimePrompt(askMany);
  assert.deepEqual(plain(R.questionResponse(one, {})), { invalid: '请先选一项或写下回答', at: 'q1' });
  assert.deepEqual(plain(R.questionResponse(one, { answers: { q1: { picks: ['方案 B'] } } })), { response: { kind: 'answers', answers: { q1: ['方案 B'] } } });
  assert.deepEqual(plain(R.questionResponse(one, { answers: { q1: { picks: ['方案 B'], text: ' 先做原型 ' } } })).response.answers.q1, ['先做原型'], 'own words take the place of a single pick');
  assert.equal(R.questionResponse(R.runtimePrompt({ ...askOne, questions: [{ id: 'q', header: 'h', question: '写点什么？' }] }), {}).invalid, '请先写下回答');
  assert.equal(R.questionResponse(R.runtimePrompt({ ...askOne, questions: [{ id: 'q', header: 'h', question: '选？', options: [{ label: 'A' }], multiSelect: true }] }), {}).invalid, '请先至少选一项');
  assert.equal(R.questionResponse(many, {}).invalid, '请回答：技术栈');
  const draft: Any = { answers: { lang: { picks: ['Rust', 'TypeScript', 'Nope'], text: 'Zig' }, token: { text: 's3' }, note: { text: '' } } };
  assert.equal(R.questionResponse(many, draft).invalid, '请回答：备注', 'left empty is not skipped: a question is left unanswered only on purpose');
  draft.answers.note = { skip: true, text: 'left over' };
  assert.deepEqual(plain(R.questionResponse(many, draft)), { response: { kind: 'answers', answers: { lang: ['TypeScript', 'Rust', 'Zig'], token: ['s3'], note: [] } } }, 'picks in their order, 其他 after them, a skipped question none');
  assert.equal(R.runtimeResponse(many, 'submit', draft).response.kind, 'answers');

  const form = R.runtimePrompt(askForm);
  assert.deepEqual(plain(form.fields.map((f: Any) => R.fieldDefault(f))), ['', '2', '', '1', false]);
  const check = (fields: Any) => R.runtimeResponse(form, 'pick:ok', { fields });
  assert.equal(check({}).invalid, '请填写：收件人');
  assert.equal(check({ name: '阿' }).invalid, '收件人至少需要 2 个字');
  assert.equal(check({ name: '阿福阿福阿' }).invalid, '收件人最多 4 个字');
  assert.equal(check({ name: '阿福', count: '2.5' }).invalid, '份数需要填写整数');
  assert.equal(check({ name: '阿福', count: '0' }).invalid, '份数不能小于 1');
  assert.equal(check({ name: '阿福', count: '9' }).invalid, '份数不能大于 5');
  assert.equal(check({ name: '阿福', count: '' }).invalid, '请填写：份数');
  assert.equal(check({ name: '阿福', ratio: 'abc' }).invalid, '比例需要填写数字');
  assert.deepEqual(plain(check({ name: ' 阿福 ' })), { response: { kind: 'decision', decisionId: 'ok', content: { name: '阿福', count: 2, size: 'M', gift: false } } }, 'untouched fields send their defaults; an empty optional one is left out');
  assert.deepEqual(plain(check({ name: '阿福', count: '3', ratio: '0.5', size: '', gift: true }).response.content), { name: '阿福', count: 3, ratio: 0.5, gift: true });
  assert.deepEqual(plain(R.runtimeResponse(form, 'pick:no', { fields: {} })), { response: { kind: 'decision', decisionId: 'no' } }, 'declining sends no content and needs none');
  assert.equal(R.runtimeResponse(form, 'pick:gone', {}).invalid, '请选择一项处理方式');
  assert.deepEqual(plain(R.runtimeResponse(R.runtimePrompt(askApproval), 'pick:no', { fields: { x: 1 } })), { response: { kind: 'decision', decisionId: 'no' } });
  assert.deepEqual(plain(R.runtimeResponse(R.runtimePrompt(askLink('https://a.example.com')), 'pick:done', {})), { response: { kind: 'decision', decisionId: 'done' } });

  const pick = R.runtimePrompt(askPick);
  assert.equal(R.conversationResponse(pick, {}).invalid, '请选一项，或写下你的回答');
  assert.deepEqual(plain(R.conversationResponse(pick, { text: ' 都行 ' })), { response: { kind: 'text', text: '都行' } });
  assert.deepEqual(plain(R.conversationResponse(pick, { picks: ['other'] })), { invalid: '请填写：别的时间', at: 'other' });
  assert.deepEqual(plain(R.conversationResponse(pick, { picks: ['other'], custom: '下周一' })), { response: { kind: 'selection', selectedIds: ['other'], customInput: '下周一' } });
  assert.deepEqual(plain(R.conversationResponse(pick, { picks: ['sat'], custom: '不带' })), { response: { kind: 'selection', selectedIds: ['sat'] } }, 'the 自定义 words go only with it');
  assert.equal(R.conversationResponse(pick, { picks: ['sat', 'sun'] }).invalid, '这里只能选一项');
  const several = R.runtimePrompt(askSeveral);
  assert.equal(R.conversationResponse(several, {}).invalid, '请至少选一项');
  assert.equal(R.conversationResponse(several, { picks: ['a', 'b', 'c'] }).invalid, '最多选 2 项');
  assert.deepEqual(plain(R.conversationResponse(several, { picks: ['c', 'a', 'c', 'x'] }).response.selectedIds), ['c', 'a']);
  const confirm = R.runtimePrompt(askConfirm);
  assert.deepEqual(plain(R.runtimeResponse(confirm, 'opt:__cancel__', {})), { response: { kind: 'selection', selectedIds: ['__cancel__'] } });
  assert.equal(R.runtimeResponse(confirm, 'opt:other', {}).invalid, '请选一项');

  // The card's actions: the engine's decisions (the first that accepts is the primary, last), 提交回答 with 拒绝, a confirmation's answers.
  assert.deepEqual(plain(R.runtimeActions(R.runtimePrompt(askApproval), { approve: { label: '允许一次' } })), [
    { decision: 'pick:always', label: '始终允许', description: '以后同类操作不再询问' }, { decision: 'pick:no', label: '拒绝' }, { decision: 'pick:once', label: '允许一次', primary: true }]);
  assert.deepEqual(plain(R.runtimeActions(one, { approve: { label: '提交回答' }, reject: { label: '拒绝' } })), [{ decision: 'reject', label: '拒绝' }, { decision: 'submit', label: '提交回答', primary: true }]);
  assert.deepEqual(plain(R.runtimeActions(pick, { approve: { label: '确认' }, reject: null })), [{ decision: 'submit', label: '确认', primary: true }]);
  assert.deepEqual(plain(R.runtimeActions(confirm, { approve: { label: '确认' } })), [{ decision: 'opt:__cancel__', label: '先不用' }, { decision: 'opt:__confirm__', label: '开始', primary: true }]);
  const goOn = R.runtimePrompt(askGoOn);
  assert.deepEqual(plain(R.runtimeActions(goOn, { approve: { label: '确认' } })), [{ decision: 'opt:__confirm__', label: '继续', primary: true }], 'one answer: no made-up 取消');
  assert.deepEqual(plain(R.runtimeResponse(goOn, 'opt:__confirm__', {})), { response: { kind: 'selection', selectedIds: ['__confirm__'] } });
  assert.equal(R.runtimeResponse(goOn, 'opt:__cancel__', {}).invalid, '请选一项');
});

test('a settled request says its outcome from any evidence the page has — its row, a receipt elsewhere, the settled read, the answer\'s own verified reply — with the public choices; and never stays 已提交 once everything was read again', () => {
  const R = rules();
  const q = { id: 'c', kind: 'card', title: '运行交互', approval: { id: 'i1', kind: 'question', title: '有件事要问你', body: '用哪个方案？' } };
  assert.deepEqual([R.outcome('question', 'approved'), R.outcome('question', 'rejected'), R.outcome('question', 'closed')], ['已回答', '已拒绝', '已结束']);
  assert.equal(R.card({ fact: { ...q, approval: { ...q.approval, state: 'approved', selected: ['方案 A'] } } }).text, '已回答：方案 A', 'the row\'s own state and choices');
  const by = (resolved: Any, more: Record<string, unknown> = {}) => R.card({ fact: q, item: null, list: 'ready', resolved, ...more });
  assert.deepEqual([by({ state: 'approved', selected: ['方案 A', '方案 B'] }).text, by({ state: 'approved' }).what, by({ state: 'approved' }).tone, by({ state: 'approved' }).mode], ['已回答：方案 A、方案 B', '用哪个方案？', 'ok', 'line']);
  assert.equal(by({ state: 'rejected', selected: ['拒绝'] }).text, '已拒绝', 'a choice the outcome already says is not said twice');
  assert.deepEqual([by({ state: 'closed' }).text, by({ state: 'closed' }).tone], ['已结束', 'exp']);
  assert.equal(by({ state: 'open' }).text, '已处理', 'not an outcome');
  assert.equal(R.card({ fact: { ...q, approval: { id: 'i2', kind: 'other', title: '有件事等你确认' } }, resolved: { state: 'approved', selected: ['始终允许'] } }).text, '已同意：始终允许');
  assert.equal(R.card({ fact: { ...q, approval: { ...q.approval, state: 'rejected' } }, resolved: { state: 'approved' } }).text, '已拒绝', 'the row\'s own state comes first');
  assert.equal(R.card({ fact: fact(), item: null, list: 'ready', resolved: { state: 'approved' } }).text, '已记住这个偏好', 'any request kind, in its own words');
  // 已提交 until it can be known; read again everywhere and nothing says how: 已处理.
  const sent = { phase: 'sent', decision: 'approve', settled: true, at: 1 };
  assert.equal(R.card({ fact: q, item: null, list: 'ready', fresh: true, local: sent }).text, '已提交', 'unchanged: the receipt may still come');
  assert.equal(R.card({ fact: q, item: null, list: 'ready', fresh: true, local: sent, reloaded: true }).text, '已处理');
  assert.equal(R.card({ fact: q, item: null, list: 'ready', fresh: false, local: sent, reloaded: true }).text, '已提交', 'the list must have been read after the answer too');
  assert.equal(R.card({ fact: q, item: { ...pref, id: 'i1' }, list: 'ready', fresh: true, local: sent, reloaded: true }).text, '已提交，还在处理', 'still listed: still being applied');
  assert.equal(R.card({ fact: q, item: null, list: 'ready', fresh: true, local: sent, reloaded: true, resolved: { state: 'approved', selected: ['方案 A'] } }).text, '已回答：方案 A');
  // The card itself: the prompt and its actions, busy with the one in flight.
  const item = R.approvals({ threadId: 't1', approvals: [rtItem('i1', 'm1', askOne, { body: '用哪个方案？' })] }).list[0];
  const open = R.card({ fact: q, item, list: 'ready' });
  assert.deepEqual([open.mode, open.prompt.kind, plain(open.actions.map((a: Any) => a.decision)), open.note, open.runtime], ['ask', 'question', ['reject', 'submit'], '', false]);
  assert.equal(R.card({ fact: q, item, list: 'ready', local: { phase: 'sending', decision: 'submit', at: 1 } }).busy, 'submit');
  assert.equal(R.card({ fact: fact(), item: pref, list: 'ready' }).prompt, null, 'other requests keep their two answers');
});

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
function page(opts: { approvals?: (path: string) => Any; latest?: () => Set<string>; locate?: (item: Any, onCancel?: () => void) => unknown; cancelLocate?: () => unknown; reload?: () => unknown } = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const chat = h('div', 'chat'), thread = h('div', 'thread'), dock = h('div', 'dock');
  thread.id = 'thread';
  Object.assign(thread, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
  chat.append(thread, dock);
  doc.body.append(chat);
  const window: Any = { matchMedia: () => ({ matches: false }), requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0) };
  const context = vm.createContext({ window, document: doc, console, Date, JSON, setTimeout, clearTimeout, setInterval: () => 0, encodeURIComponent });
  for (const f of ['chat-live-rules.js', 'chat-live.js', 'chat-cards-rules.js', 'chat-cards.js', 'chat-locate-rules.js', 'chat-locate.js']) vm.runInContext(read('client/public/' + f), context);
  const live = window.ClowderLive, cards = window.ClowderCards;
  const calls: Array<{ path: string; method: string; body?: Any }> = [];
  const posts: Array<{ path: string; body: Any; answer: (r: Reply) => void }> = [];
  const sends: Array<{ text: string; sent: () => void; done: () => void }> = [];
  let reloads = 0;
  const icon = (name: string, extra?: string) => { const s = doc.createElementNS('svg', 'svg'); s.classList.add('icon'); if (extra) s.classList.add(extra); s.dataset.icon = name; return s; };
  live.init({ thread, render: () => {}, row: () => h('div', 'msg bot'), queued: () => false, busy: () => false, unread: () => '', changed: () => {}, gap: () => {}, focusComposer: () => {} });
  cards.init({
    thread, icon,
    api: async (path: string) => { calls.push({ path, method: 'GET' }); return opts.approvals ? opts.approvals(path) : { threadId: 't1', approvals: [] }; },
    apiFetch: (path: string, opt: Any) => new Promise((resolve, reject) => {
      const body = JSON.parse(opt.body);
      calls.push({ path, method: opt.method, body });
      posts.push({ path, body, answer: (r: Reply) => (r instanceof Error ? reject(r) : resolve({ ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) })) });
    }),
    render: (el: El, text: string) => el.append(text),
    send: (text: string, sent: () => void) => new Promise<void>((done) => sends.push({ text, sent, done })),
    reload: () => { reloads++; return opts.reload ? opts.reload() : undefined; },
    ...(opts.latest ? { latest: opts.latest } : {}),
    ...(opts.locate ? { locate: opts.locate } : {}),
    ...(opts.cancelLocate ? { cancelLocate: opts.cancelLocate } : {}),
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
  return { doc, thread, cards, live, calls, posts, sends, draw, rows, row, reloads: () => reloads, window, sel };
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

// ------------------------------------------------- F306 answered in the card (item 59)
const typeIn = (input: El, value: string) => { input.value = value; input.dispatchEvent(new Ev('input')); };
const opt = (root: El, label: string) => { const b = all(root).find(e => e.tagName === 'BUTTON' && e.querySelector('.ck-opt-label')?.textContent === label); assert.ok(b, 'no option ' + label); return b!; };
const pressed = (root: El) => all(root).filter(e => e.tagName === 'BUTTON' && e.getAttribute('aria-pressed') === 'true').map(e => e.querySelector('.ck-opt-label')?.textContent ?? e.textContent);
const invalidOf = (root: El) => { const n = root.querySelector('.ck-invalid')!; return n.hidden ? '' : n.textContent; };
const inputs = (root: El) => all(root).filter(e => e.tagName === 'INPUT');

test('an F306 question is answered in its card: a pick, or the owner\'s own words in its place, sent with its revision and one operation ID; nothing goes before the check passes, typing never redraws, and a redraw keeps the draft and the focus', async () => {
  let list = [rtItem('i1', 'm-q', askOne, { body: '用哪个方案？' })];
  const p = page({ approvals: () => ({ threadId: 't1', approvals: list }) });
  const history = [rtMessage('i1', 'm-q')];
  p.draw(history);
  await settle();
  const card = () => p.row('m-q').querySelector('.approval')!;
  assert.match(card().textContent, /^团子有件事要问你用哪个方案？/);
  assert.equal(card().querySelectorAll('.ck-q-text').length, 0, 'one question: its words are the card\'s, said once');
  assert.deepEqual(all(card()).filter(e => e.tagName === 'BUTTON').map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['A方案 A快一点', 'false'], ['B方案 B', 'false'], ['拒绝', null], ['提交回答', null]]);
  assert.deepEqual([button(card(), '拒绝').className, button(card(), '提交回答').className], ['secondary', 'primary']);
  const own = inputs(card())[0];
  assert.deepEqual([own.type, own.placeholder, own.getAttribute('aria-label'), own.className], ['text', '其他…', '其他：用哪个方案？', 'ck-other']);
  // Not answered yet: said in the card, nothing sent.
  button(card(), '提交回答').click();
  assert.equal(p.posts.length, 0);
  assert.deepEqual([invalidOf(card()), card().querySelector('.ck-invalid')!.getAttribute('role')], ['请先选一项或写下回答', 'alert']);
  // A pick: marked in place, nothing redrawn; the check's words go.
  const a = opt(card(), '方案 A');
  a.click();
  assert.deepEqual([a.getAttribute('aria-pressed'), a.classList.contains('on'), invalidOf(card())], ['true', true, '']);
  assert.equal(inputs(card())[0], own, 'a pick redraws nothing');
  // The owner's own words take the place of the pick, in the very same field.
  own.focus();
  typeIn(own, '先做个原型');
  assert.deepEqual([a.getAttribute('aria-pressed'), p.doc.activeElement === own], ['false', true]);
  // A read that changes nothing keeps every element.
  p.draw(history);
  await settle();
  assert.equal(inputs(card())[0], own);
  // A read that changes the card (it is close to running out now) draws it again from the draft, focus back in the field.
  list = [rtItem('i1', 'm-q', askOne, { body: '用哪个方案？', expiresAt: Date.now() + 3600e3 })];
  p.draw([...history, cardMessage()]);
  await settle(); await settle();
  const again = inputs(card())[0];
  assert.notEqual(again, own);
  assert.match(card().textContent, /前有效/);
  assert.deepEqual([again.value, p.doc.activeElement === again, pressed(card())], ['先做个原型', true, []]);
  // Sent: the revision, an operation ID and the answer; in flight everything waits.
  button(card(), '提交回答').click();
  const first = p.posts[0].body;
  assert.match(p.posts[0].path, /\/approvals\/i1$/);
  assert.deepEqual({ ...first, operationId: typeof first.operationId }, { expectedThreadId: 't1', expectedRevision: 3, operationId: 'string', response: { kind: 'answers', answers: { q1: ['先做个原型'] } } });
  assert.ok(first.operationId.length >= 10);
  assert.match(card().textContent, /正在提交…/);
  assert.equal(inputs(card())[0].readOnly, true);
  assert.ok(all(card()).filter(e => e.tagName === 'BUTTON').every(b => b.getAttribute('aria-disabled') === 'true'));
  assert.doesNotMatch(card().textContent, /已回答|已提交/, 'never optimistic');
  // Refused: the server's words, the engine's reason behind 详情, the draft as it was; trying again is a new operation.
  p.posts[0].answer({ status: 400, body: { error: '请检查你的回答是否完整有效', native: { error: 'answer for q1 is not allowed' } } });
  await settle(); await settle();
  assert.match(card().textContent, /请检查你的回答是否完整有效。详情/);
  assert.equal(inputs(card())[0].value, '先做个原型');
  button(card(), '详情').click();
  assert.equal(card().querySelector('.ck-reason')!.textContent, 'answer for q1 is not allowed');
  button(card(), '提交回答').click();
  const second = p.posts[1].body.operationId;
  assert.notEqual(second, first.operationId, 'refused: a new attempt');
  // The connection lost: not known whether it arrived, so the same answer again is the same operation.
  p.posts[1].answer(new Error('offline'));
  await settle(); await settle();
  assert.match(card().textContent, /不确定刚才的回答有没有送到/);
  button(card(), '提交回答').click();
  assert.equal(p.posts[2].body.operationId, second);
  p.posts[2].answer(new Error('offline'));
  await settle(); await settle();
  // A changed answer is another operation.
  typeIn(inputs(card())[0], '先做个原型，再定');
  button(card(), '提交回答').click();
  assert.notEqual(p.posts[3].body.operationId, second);
  assert.deepEqual(p.posts[3].body.response.answers, { q1: ['先做个原型，再定'] });
  // Verified by the engine: its outcome at once, without waiting for any receipt.
  list = [];
  p.posts[3].answer({ status: 200, body: { id: 'i1', decision: 'approve', settled: true, state: 'approved' } });
  await settle(); await settle();
  assert.match(p.row('m-q').textContent, /^已回答 · 用哪个方案？$/);
  assert.equal(p.doc.activeElement.dataset.ckFocus, 'card', 'focus moves to the settled card, not lost');
});

test('an answer whose outcome is not known (503, 502, 504, 409) keeps its operation ID and the revision it first went with, even once a newer revision was read; only a changed answer, or one refused as it stands (400, 403, 404), is a new operation', async () => {
  let list = [rtItem('i1', 'm-q', askOne, { body: '用哪个方案？' })];
  const p = page({ approvals: () => ({ threadId: 't1', approvals: list }) });
  p.draw([rtMessage('i1', 'm-q')]);
  await settle();
  const card = () => p.row('m-q').querySelector('.approval')!;
  const send = () => { button(card(), '提交回答').click(); return p.posts.at(-1)!.body; };
  const answer = async (r: Reply) => { p.posts.at(-1)!.answer(r); for (let i = 0; i < 4; i++) await settle(); };
  opt(card(), '方案 A').click();
  const first = send();
  assert.equal(first.expectedRevision, 3);
  // The engine could not finish: whether it took the answer is not known.
  await answer({ status: 503, body: { error: '暂时连不上' } });
  const second = send();
  assert.deepEqual([second.operationId, second.expectedRevision], [first.operationId, 3]);
  // It took it (its revision moved on) and still said no: the list read again has the newer revision.
  list = [rtItem('i1', 'm-q', { ...askOne, revision: 4 }, { body: '用哪个方案？' })];
  const reads = p.calls.filter(c => c.method === 'GET').length;
  await answer({ status: 409, body: { error: '这件事状态已经变化，请刷新后再试' } });
  assert.ok(p.calls.filter(c => c.method === 'GET').length > reads, 'the list was read again');
  const third = send();
  assert.deepEqual([third.operationId, third.expectedRevision, third.response], [first.operationId, 3, first.response], 'the same answer is the same operation, as it first went');
  for (const status of [502, 504, 500]) {
    await answer({ status, body: { error: '这一步没有成功，还没有生效' } });
    const again = send();
    assert.deepEqual([again.operationId, again.expectedRevision], [first.operationId, 3], String(status));
  }
  // A changed answer is another operation, with the revision read now.
  await answer({ status: 503, body: {} });
  opt(card(), '方案 B').click();
  const changed = send();
  assert.notEqual(changed.operationId, first.operationId);
  assert.deepEqual([changed.expectedRevision, changed.response.answers], [4, { q1: ['方案 B'] }]);
  await answer({ status: 409, body: { error: '这件事状态已经变化，请刷新后再试' } });
  assert.equal(send().operationId, changed.operationId);
  // Refused as it stands (not open here, not allowed): the same answer sent again is a new operation each time.
  await answer({ status: 404, body: { error: '这件事已经处理过，或者不在这个对话里' } });
  const after404 = send();
  assert.notEqual(after404.operationId, changed.operationId);
  assert.deepEqual([after404.expectedRevision, after404.response], [4, changed.response]);
  await answer({ status: 403, body: { error: '没有权限' } });
  const after403 = send();
  assert.notEqual(after403.operationId, after404.operationId);
  await answer({ status: 400, body: { error: '请检查你的回答是否完整有效' } });
  assert.notEqual(send().operationId, after403.operationId);
});

test('several questions: each says its own words, many picks plus 其他, a secret typed hidden and never said back, one left unanswered only on purpose; 拒绝 refuses the whole request', async () => {
  const p = page({ approvals: listWith(rtItem('i2', 'm-many', askMany, { body: '开工前确认几件事' })) });
  p.draw([rtMessage('i2', 'm-many')]);
  await settle();
  const card = () => p.row('m-many').querySelector('.approval')!;
  const groups = card().querySelectorAll('.ck-q');
  assert.deepEqual(groups.map(g => [g.getAttribute('role'), g.getAttribute('aria-label'), g.querySelector('.ck-q-head')?.textContent ?? '', g.querySelector('.ck-q-text')!.textContent]), [
    ['group', '用什么写这个工具？', '技术栈', '用什么写这个工具？'], ['group', '部署用的令牌是什么？', '', '部署用的令牌是什么？'], ['group', '还有什么要交代的？', '备注', '还有什么要交代的？']],
    'a header its question already says (令牌) is not said twice');
  const [other, token, note] = groups.map(g => g.querySelector('input')!);
  assert.deepEqual([token.type, token.getAttribute('autocomplete'), token.className, note.type, other.type], ['password', 'new-password', 'ck-input', 'text', 'text']);
  assert.deepEqual(buttons(card(), '跳过这题').length, 1, 'only the question that may be left unanswered');
  button(card(), '提交回答').click();
  assert.equal(invalidOf(card()), '请回答：技术栈');
  opt(card(), 'Rust').click();
  opt(card(), 'TypeScript').click();
  typeIn(other, 'Zig');
  assert.deepEqual(pressed(groups[0]), ['TypeScript', 'Rust'], 'several picks; 其他 goes with them');
  button(card(), '提交回答').click();
  assert.equal(invalidOf(card()), '请回答：令牌');
  typeIn(token, 'tok-s3cret');
  button(card(), '提交回答').click();
  assert.equal(invalidOf(card()), '请回答：备注', 'left empty is not skipped');
  typeIn(note, '随便写的');
  const skip = button(card(), '跳过这题');
  skip.click();
  assert.deepEqual([skip.getAttribute('aria-pressed'), skip.classList.contains('on'), note.disabled, note.value, groups[2].classList.contains('ck-skipped')], ['true', true, true, '', true]);
  button(card(), '提交回答').click();
  assert.deepEqual(p.posts[0].body.response, { kind: 'answers', answers: { lang: ['TypeScript', 'Rust', 'Zig'], token: ['tok-s3cret'], note: [] } });
  p.posts[0].answer({ status: 200, body: { id: 'i2', decision: 'approve', settled: true, state: 'approved', selected: ['TypeScript', 'Rust'] } });
  await settle(); await settle();
  assert.match(p.row('m-many').textContent, /^已回答：TypeScript、Rust · 开工前确认几件事$/);
  assert.doesNotMatch(p.doc.body.textContent + JSON.stringify(p.cards.peek()), /tok-s3cret/, 'the secret is never shown, said or kept');
  // 拒绝: the whole request, without answers.
  const r = page({ approvals: listWith(rtItem('i2', 'm-many', askMany)) });
  r.draw([rtMessage('i2', 'm-many')]);
  await settle();
  button(r.row('m-many'), '拒绝').click();
  assert.deepEqual(r.posts[0].body, { decision: 'reject', expectedThreadId: 't1' });
  r.posts[0].answer({ status: 200, body: { id: 'i2', decision: 'reject', settled: true, state: 'rejected' } });
  await settle(); await settle();
  assert.match(r.row('m-many').textContent, /^已拒绝/);
});

test('an F306 approval offers the engine\'s own decisions, the first that accepts as the primary; a link opens only http(s), in a new tab, saying where it goes; a form is filled in the card, checked, and sends its content only with an accepting decision', async () => {
  const p = page({ approvals: listWith(rtItem('i3', 'm-ap', askApproval, { kind: 'other', title: '团子有件事等你确认', body: '运行 npm publish', approve: { label: '允许一次' }, reject: null })) });
  p.draw([rtMessage('i3', 'm-ap', 'other', '有件事等你确认')]);
  await settle();
  const ap = p.row('m-ap').querySelector('.approval')!;
  assert.deepEqual(all(ap).filter(e => e.tagName === 'BUTTON').map(b => [b.textContent, b.className, b.title]), [['始终允许', 'secondary', '以后同类操作不再询问'], ['拒绝', 'secondary', ''], ['允许一次', 'primary', '']]);
  assert.equal(ap.querySelector('.ck-rt'), null, 'nothing to fill in: the decisions only');
  button(ap, '始终允许').click();
  assert.deepEqual({ ...p.posts[0].body, operationId: !!p.posts[0].body.operationId }, { expectedThreadId: 't1', expectedRevision: 2, operationId: true, response: { kind: 'decision', decisionId: 'always' } });
  p.posts[0].answer({ status: 200, body: { id: 'i3', decision: 'approve', settled: true, state: 'approved', selected: ['始终允许'] } });
  await settle(); await settle();
  assert.match(p.row('m-ap').textContent, /^已同意：始终允许 · 运行 npm publish$/);

  const linkItem = (id: string, mid: string, url: string) => rtItem(id, mid, askLink(url), { kind: 'other', title: '团子需要你补充信息', body: '请先登录', approve: { label: '我已完成' }, reject: null });
  const u = page({ approvals: listWith(linkItem('i4', 'm-url', 'https://login.example.com/device?code=AB12'), linkItem('i5', 'm-bad', 'javascript:alert(1)')) });
  u.draw([rtMessage('i4', 'm-url', 'other', '需要你补充信息'), rtMessage('i5', 'm-bad', 'other', '需要你补充信息')]);
  await settle();
  const link = all(u.row('m-url')).find(e => e.tagName === 'A')!;
  assert.deepEqual([link.textContent, link.href, link.target, link.rel, link.getAttribute('aria-label')], ['打开链接', 'https://login.example.com/device?code=AB12', '_blank', 'noopener noreferrer', '打开链接：login.example.com']);
  assert.equal(u.row('m-url').querySelector('.ck-host')!.textContent, 'login.example.com');
  assert.deepEqual(all(u.row('m-url')).filter(e => e.tagName === 'BUTTON').map(b => [b.textContent, b.className]), [['取消', 'secondary'], ['我已完成', 'primary']]);
  const bad = u.row('m-bad');
  assert.deepEqual(all(bad).filter(e => e.tagName === 'BUTTON').length, 0, 'a link that is not a web address is not offered');
  assert.deepEqual(all(bad).filter(e => e.tagName === 'A').map(e => [e.textContent, e.href]), [['打开运行面板', '/runtime.html']]);
  assert.match(bad.textContent, /这一项要在运行面板里回答。/);
  assert.doesNotMatch(bad.html, /javascript:/);
  button(u.row('m-url'), '取消').click();
  assert.deepEqual(u.posts[0].body.response, { kind: 'decision', decisionId: 'stop' });
  u.posts[0].answer({ status: 200, body: { id: 'i4', decision: 'approve', settled: true, state: 'closed' } });
  await settle(); await settle();
  assert.match(u.row('m-url').textContent, /^已结束/);

  const formItem = () => rtItem('i6', 'm-form', askForm, { kind: 'other', title: '团子需要你补充信息', body: '寄送信息', approve: { label: '提交' }, reject: null });
  const f = page({ approvals: listWith(formItem()) });
  f.draw([rtMessage('i6', 'm-form', 'other', '需要你补充信息')]);
  await settle();
  const fc = () => f.row('m-form').querySelector('.approval')!;
  const controls = all(fc()).filter(e => e.tagName === 'INPUT' || e.tagName === 'SELECT');
  assert.deepEqual(controls.map(c => [c.tagName, c.type, c.tagName === 'INPUT' && c.type === 'checkbox' ? c.checked : c.value]), [
    ['INPUT', 'text', ''], ['INPUT', 'number', '2'], ['INPUT', 'number', ''], ['SELECT', '', '1'], ['INPUT', 'checkbox', false]]);
  assert.deepEqual(fc().querySelectorAll('.ck-field-name').map(n => n.textContent), ['收件人', '份数', '比例', '尺寸', '要包装']);
  assert.deepEqual([controls[0].maxLength, controls[1].getAttribute('step'), controls[1].getAttribute('min'), controls[1].getAttribute('max'), controls[2].getAttribute('step')], [4, '1', '1', '5', 'any']);
  assert.deepEqual(all(fc()).filter(e => e.tagName === 'OPTION').map(o => [o.value, o.textContent]), [['', '不填'], ['0', 'S'], ['1', 'M'], ['2', 'L']]);
  assert.match(fc().textContent, /按平时穿的选/);
  button(fc(), '提交').click();
  assert.equal(invalidOf(fc()), '请填写：收件人');
  typeIn(controls[0], '阿');
  assert.equal(invalidOf(fc()), '', 'typing takes the check\'s words away');
  button(fc(), '提交').click();
  assert.equal(invalidOf(fc()), '收件人至少需要 2 个字');
  typeIn(controls[0], '阿福');
  typeIn(controls[1], '2.5');
  button(fc(), '提交').click();
  assert.equal(invalidOf(fc()), '份数需要填写整数');
  typeIn(controls[1], '3');
  controls[3].value = '2';
  controls[3].dispatchEvent(new Ev('change'));
  controls[4].checked = true;
  controls[4].dispatchEvent(new Ev('change'));
  assert.equal(f.posts.length, 0, 'nothing went before the check passed');
  button(fc(), '提交').click();
  assert.deepEqual([f.posts[0].body.expectedRevision, f.posts[0].body.response], [5, { kind: 'decision', decisionId: 'ok', content: { name: '阿福', count: 3, size: 'L', gift: true } }]);
  // Declined: nothing filled in goes with it, and nothing needs filling in.
  const g = page({ approvals: listWith(formItem()) });
  g.draw([rtMessage('i6', 'm-form', 'other', '需要你补充信息')]);
  await settle();
  button(g.row('m-form'), '不填了').click();
  assert.deepEqual(g.posts[0].body.response, { kind: 'decision', decisionId: 'no' });
});

test('a cat\'s own choice answered in its card: one pick, the 自定义 option\'s words, or the owner\'s own reply in place of a pick; several up to max; a confirmation is its two answers, or its one', async () => {
  const p = page({ approvals: listWith(rtItem('i7', 'm-co', askPick, { body: '什么时候去？', approve: { label: '确认' }, reject: null })) });
  p.draw([rtMessage('i7', 'm-co')]);
  await settle();
  const card = () => p.row('m-co').querySelector('.approval')!;
  const [custom, own] = inputs(card());
  assert.deepEqual([custom.hidden, own.placeholder, own.getAttribute('aria-label')], [true, '写下你的回答…', '你的回答']);
  assert.deepEqual(all(card()).filter(e => e.tagName === 'BUTTON').map(b => b.textContent), ['A📅 周六', 'B周日', 'C别的时间', '确认']);
  button(card(), '确认').click();
  assert.equal(invalidOf(card()), '请选一项，或写下你的回答');
  opt(card(), '别的时间').click();
  assert.deepEqual([custom.hidden, custom.placeholder, custom.getAttribute('aria-label'), p.doc.activeElement === custom], [false, '别的时间…', '别的时间', true]);
  button(card(), '确认').click();
  assert.equal(invalidOf(card()), '请填写：别的时间');
  typeIn(custom, '下周一');
  button(card(), '确认').click();
  assert.deepEqual(p.posts[0].body.response, { kind: 'selection', selectedIds: ['other'], customInput: '下周一' });
  p.posts[0].answer({ status: 400, body: { error: '填写补充说明前需要先选中自定义项' } });
  await settle(); await settle();
  assert.match(card().textContent, /填写补充说明前需要先选中自定义项。/);
  assert.deepEqual([inputs(card())[0].value, pressed(card())], ['下周一', ['别的时间']], 'a refusal keeps what was picked and typed');
  // The owner's own reply instead: the pick goes, and its words with it.
  typeIn(inputs(card())[1], '都行');
  assert.deepEqual([pressed(card()), inputs(card())[0].hidden], [[], true]);
  button(card(), '确认').click();
  assert.deepEqual(p.posts[1].body.response, { kind: 'text', text: '都行' });

  const m = page({ approvals: listWith(rtItem('i8', 'm-many', askSeveral, { body: '要喝什么？', approve: { label: '确认' }, reject: null })) });
  m.draw([rtMessage('i8', 'm-many')]);
  await settle();
  const mc = m.row('m-many').querySelector('.approval')!;
  const limit = mc.querySelector('.ck-limit')!;
  assert.deepEqual([limit.textContent, limit.classList.contains('visually-hidden')], ['最多选 2 项', true]);
  opt(mc, '果汁').click();
  opt(mc, '咖啡').click();
  assert.deepEqual([opt(mc, '茶').getAttribute('aria-disabled'), limit.classList.contains('visually-hidden')], ['true', false], 'at the limit the others wait, and say why');
  opt(mc, '茶').click();
  button(mc, '确认').click();
  assert.deepEqual(m.posts[0].body.response, { kind: 'selection', selectedIds: ['c', 'a'] });

  const c = page({ approvals: listWith(rtItem('i9', 'm-yes', askConfirm, { body: '开始整理资料？', approve: { label: '确认' }, reject: null })) });
  c.draw([rtMessage('i9', 'm-yes')]);
  await settle();
  const cc = c.row('m-yes').querySelector('.approval')!;
  assert.deepEqual(all(cc).filter(e => e.tagName === 'BUTTON').map(b => [b.textContent, b.className]), [['先不用', 'secondary'], ['开始', 'primary']]);
  assert.equal(cc.querySelector('.ck-rt'), null);
  button(cc, '开始').click();
  assert.deepEqual(c.posts[0].body.response, { kind: 'selection', selectedIds: ['__confirm__'] });
  c.posts[0].answer({ status: 200, body: { id: 'i9', decision: 'approve', settled: true, state: 'approved', selected: ['开始'] } });
  await settle(); await settle();
  assert.match(c.row('m-yes').textContent, /^已回答：开始 · 开始整理资料？$/);

  // A confirmation of one option is that one button: nothing to cancel with is made up.
  const one = page({ approvals: listWith(rtItem('i10', 'm-go', askGoOn, { body: '接着整理？', approve: { label: '确认' }, reject: null })) });
  one.draw([rtMessage('i10', 'm-go')]);
  await settle();
  const oc = one.row('m-go').querySelector('.approval')!;
  assert.deepEqual(all(oc).filter(e => e.tagName === 'BUTTON').map(b => [b.textContent, b.className]), [['继续', 'primary']]);
  assert.equal(oc.querySelector('.ck-rt'), null);
  assert.doesNotMatch(oc.textContent, /运行面板/, 'answered here, not sent to the runtime panel');
  button(oc, '继续').click();
  assert.deepEqual(one.posts[0].body.response, { kind: 'selection', selectedIds: ['__confirm__'] });
});

test('a card on an earlier page settles from the engine\'s receipt on the newest one, from the settled read asked for by ID, or from the answer\'s own reply; with nothing anywhere it says 已处理 once everything was read again, never 已提交 for good', async () => {
  const older = { ...cardMessage(), id: 'm-old' };
  const later = { id: 'u2', role: 'user', content: '后来说的话' };
  // The receipt is on the newest page, the card on one held from before.
  const a = page({ approvals: listWith() });
  a.draw([older, later, { id: 'n-r', role: 'assistant', notice: true, content: '已记住这个偏好。', receipt: { proposalId: 'p1', state: 'approved' } }]);
  await settle();
  assert.match(a.row('m-old').textContent, /^已记住这个偏好 · 回答简短一点，先说结论$/);
  assert.deepEqual(a.calls, [], 'known from the receipt: nothing to ask');
  // The engine's own receipt message as the row carries it.
  const hubReceipt = (cardMessageId: string) => ({ id: 'n-x', role: 'assistant', notice: true, content: '没有记这个偏好。',
    native: { source: { connector: 'approval-hub', meta: { approvalDecisionReceipt: { kind: 'approval_decision_receipt', canonicalProposalId: 'p1', resolution: 'rejected', approvalCardRef: { messageId: cardMessageId } } } } } });
  const b = page({ approvals: listWith() });
  b.draw([older, later, hubReceipt('m-old')]);
  await settle();
  assert.match(b.row('m-old').textContent, /^没有记这个偏好/);
  // A receipt that names another message is not this card's.
  const c = page({ approvals: listWith() });
  c.draw([older, later, hubReceipt('m-elsewhere')]);
  await settle();
  assert.match(c.row('m-old').textContent, /^已处理/);
  // The same for the receipt as the server projects it on the row (receipt.cardMessageId).
  const served = (cardMessageId: string) => ({ id: 'n-s', role: 'assistant', notice: true, content: '已记住这个偏好。',
    receipt: { proposalId: 'p1', producerId: 'taste', state: 'approved', cardMessageId } });
  const c2 = page({ approvals: listWith() });
  c2.draw([older, later, served('m-elsewhere')]);
  await settle();
  assert.match(c2.row('m-old').textContent, /^已处理/, 'a projected receipt for another message never settles this card');
  const c3 = page({ approvals: listWith() });
  c3.draw([older, later, served('m-old')]);
  await settle();
  assert.match(c3.row('m-old').textContent, /^已记住这个偏好 · 回答简短一点，先说结论$/);
  assert.deepEqual(c3.calls, [], 'known from the receipt: nothing to ask');

  // No receipt on any page held: a card on an earlier page is asked about by ID; one on the newest page is listed anyway.
  const asks: string[] = [];
  const d = page({ latest: () => new Set(['u-new']), approvals: (path) => { asks.push(path); return { threadId: 't1', approvals: [], settled: path.endsWith('?ids=p1') ? [{ id: 'p1', state: 'rejected' }] : [] }; } });
  d.draw([older, { id: 'u-new', role: 'user', content: '新的一页' }]);
  await settle(); await settle();
  assert.deepEqual(asks, ['/xbot-api/bots/%E5%9B%A2%E5%AD%90/approvals?ids=p1']);
  assert.match(d.row('m-old').textContent, /^没有记这个偏好/);
  const onNewest: string[] = [];
  const e = page({ latest: () => new Set(['m-card']), approvals: (path) => { onNewest.push(path); return { threadId: 't1', approvals: [pref] }; } });
  e.draw([cardMessage()]);
  await settle();
  assert.deepEqual(onNewest, ['/xbot-api/bots/%E5%9B%A2%E5%AD%90/approvals']);

  // Answered from here: the next read asks about it by ID, and the engine's settled state names the outcome.
  let open = [pref];
  const paths: string[] = [];
  const f = page({ approvals: (path) => { paths.push(path); return !open.length && path.endsWith('?ids=p1') ? { threadId: 't1', approvals: [], settled: [{ id: 'p1', state: 'approved' }] } : { threadId: 't1', approvals: open }; } });
  f.draw([cardMessage()]);
  await settle();
  button(f.row('m-card'), '记住').click();
  open = [];
  f.posts[0].answer({ status: 200, body: { id: 'p1', decision: 'approve', settled: true } });
  await settle(); await settle();
  assert.equal(paths.at(-1), '/xbot-api/bots/%E5%9B%A2%E5%AD%90/approvals?ids=p1');
  assert.match(f.row('m-card').textContent, /^已记住这个偏好 · /);

  // Nothing anywhere says how: 已提交 while the receipt may still come; once the list and the conversation were both read after the answer, 已处理.
  let still = [pref];
  let finish: () => void = () => {};
  const g = page({ approvals: () => ({ threadId: 't1', approvals: still }), reload: () => new Promise<void>((done) => { finish = done; }) });
  const history = [cardMessage()];
  g.draw(history);
  await settle();
  button(g.row('m-card'), '记住').click();
  still = [];
  g.posts[0].answer({ status: 200, body: { id: 'p1', decision: 'approve', settled: true } });
  await settle(); await settle();
  assert.match(g.row('m-card').textContent, /^已提交 · /);
  // A read of the conversation that is not the one asked for after the answer is not enough.
  g.draw(history);
  await settle(); await settle();
  assert.match(g.row('m-card').textContent, /^已提交 · /);
  finish();
  await settle(); await settle();
  assert.match(g.row('m-card').textContent, /^已处理 · 回答简短一点，先说结论$/);
});

test('more than 50 cards on earlier pages are asked about 50 a read, one read after another, and taken together once all came back: the 51st is answerable, never 已处理', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => 'p' + i);
  const messages = ids.map((id, i) => ({ ...cardMessage(), id: 'm-' + i, blocks: [{ ...fact(), id: 'card-' + i, approval: { ...fact().approval, id } }] }));
  const asks: string[][] = [];
  let release: () => void = () => {};
  const p = page({ latest: () => new Set(['u-new']), approvals: (path) => {
    const part = (/\?ids=(.*)$/.exec(path)?.[1] ?? '').split(',').filter(Boolean).map(decodeURIComponent);
    asks.push(part);
    // p0 ended (the engine's settled read); the others are still open.
    const reply = { threadId: 't1', approvals: part.filter(id => id !== 'p0').map(id => ({ ...pref, id, messageId: 'm-' + id.slice(1) })), settled: part.includes('p0') ? [{ id: 'p0', state: 'rejected' }] : [] };
    return asks.length === 2 ? new Promise((done) => { release = () => done(reply); }) : reply;
  } });
  p.draw([...messages, { id: 'u-new', role: 'user', content: '新的一页' }]);
  await settle(); await settle();
  assert.deepEqual(asks.map(a => a.length), [50, 1], 'at most 50 a read (the server\'s limit)');
  assert.deepEqual(asks.flat(), ids, 'every card asked about, once');
  // Nothing is taken while a read is still on its way.
  assert.equal(p.cards.peek().listState, 'loading');
  assert.match(p.row('m-0').textContent, /正在读取…/);
  assert.match(p.row('m-50').textContent, /正在读取…/);
  release();
  await settle(); await settle();
  assert.equal(p.cards.peek().listState, 'ready');
  assert.equal(p.cards.peek().list.length, 50);
  const last = p.row('m-50');
  assert.doesNotMatch(last.textContent, /已处理/);
  assert.equal(button(last, '记住').getAttribute('aria-disabled'), null, 'the 51st is answerable');
  assert.equal(button(p.row('m-49'), '记住').getAttribute('aria-disabled'), null);
  assert.match(p.row('m-0').textContent, /^没有记这个偏好/, 'settled from the first read');
});

test('去确认 for a card further back than the history drawn finds its message on an earlier page through chat-locate.js and focuses the card itself; past the page limit or the start it says why and resolves without finding', async () => {
  const far = { ...cardMessage(), id: 'm-far', blocks: [{ ...fact(), approval: { ...fact().approval, id: 'p-far' } }] };
  const filler = (n: number) => [{ id: 'u-' + n + '-a', role: 'user', content: '第 ' + n + ' 页' }, { id: 'u-' + n + '-b', role: 'assistant', content: '好的' }];
  const setup = (pages: Any[][]) => {
    const notes: string[] = [];
    let shown: Any[] = [{ id: 'u-new', role: 'user', content: '最新的话' }];
    let asked = 0, loaded = 0;
    const hold: Any = {};
    const p = page({ approvals: listWith({ ...pref, id: 'p-far', messageId: 'm-far' }), locate: (item: Any) => hold.find({ sel: p.sel, messageId: item.messageId }) });
    const L = p.window.ClowderLocate;
    hold.find = L.find;
    // The history's own loader as chat-history.js offers it: one earlier page per load, drawn before it resolves.
    const history = {
      older: () => ({ key: 'bot:团子', gen: 1, state: 'idle', more: pages.length > 0, loaded, drawn: loaded, error: '', asked, failures: 0 }),
      load: async () => { asked++; const one = pages.pop(); if (one) { shown = [...one, ...shown]; loaded++; p.draw(shown); } },
      whenDrawn: async () => true,
    };
    L.init({ thread: p.thread, selected: () => p.sel, history, note: (text: string) => notes.push(text), rest: () => {} });
    p.draw(shown);
    return { p, notes, asked: () => asked };
  };
  const item = { proposalId: 'p-far', messageId: 'm-far' };
  const { p, notes } = setup([[far, ...filler(2)], filler(1)]);
  await settle();
  assert.equal(p.cards.find(item), false, 'not drawn yet');
  assert.equal(await p.cards.locate(item), true);
  await settle(); await settle();
  const card = p.row('m-far').querySelector('.approval')!;
  assert.equal(p.doc.activeElement, card, 'the card itself has focus, not only its message');
  assert.ok(card.classList.contains('ck-hit'), 'and flashes, even drawn again when its list read came back');
  assert.equal(button(card, '记住').getAttribute('aria-disabled'), null, 'answerable where it was found');
  assert.equal(notes.at(-1), '', 'the search\'s note is taken back once found');
  // Past the limit: the search stops and says so; nothing is found.
  const deep = setup([[far], ...Array.from({ length: 12 }, (_, i) => filler(i))]);
  await settle();
  assert.equal(await deep.p.cards.locate(item), null);
  assert.equal(deep.notes.at(-1), '往前翻了 10 页还没找到这条消息，先停在这里；可以接着往上翻看。');
  assert.equal(deep.asked(), 10);
  assert.equal(deep.p.row('m-far'), undefined);
  // The start of the conversation, and no such message.
  const short = setup([filler(1)]);
  await settle();
  assert.equal(await short.p.cards.locate(item), null);
  assert.equal(short.notes.at(-1), '翻到了这段对话最早的消息，也没有找到这一条。');
  // Nothing to look for, or no way to look further back.
  assert.equal(await p.cards.locate({ proposalId: 'gone' }), false);
  assert.equal(await page().cards.locate(item), false);
});

test('a card found where it is drawn ends a lookup still reading earlier pages: no further page, its note goes, the focus stays on the card found, and the 去确认 that began it has nothing to say', async () => {
  const far = { ...cardMessage(), id: 'm-far', blocks: [{ ...fact(), approval: { ...fact().approval, id: 'p-far' } }] };
  const filler = (n: number) => [{ id: 'u-' + n + '-a', role: 'user', content: '第 ' + n + ' 页' }, { id: 'u-' + n + '-b', role: 'assistant', content: '好的' }];
  const farItem = { proposalId: 'p-far', messageId: 'm-far' };
  // The card m-card (p1) is drawn; p-far is two pages back. Each earlier page waits until the test lets it come.
  const setup = () => {
    const notes: string[] = [];
    const pages: Any[][] = [[far], filler(2), filler(1)];
    let shown: Any[] = [cardMessage()];
    let asked = 0, loaded = 0;
    const waits: Array<() => void> = [];
    const hold: Any = {};
    const p = page({ approvals: listWith(pref, { ...pref, id: 'p-far', messageId: 'm-far' }),
      locate: (item: Any) => hold.L.find({ sel: p.sel, messageId: item.messageId }), cancelLocate: () => hold.L.cancel() });
    hold.L = p.window.ClowderLocate;
    hold.L.init({ thread: p.thread, selected: () => p.sel, note: (text: string) => notes.push(text), rest: () => {}, history: {
      older: () => ({ key: 'bot:团子', gen: 1, state: 'idle', more: pages.length > 0, loaded, drawn: loaded, error: '', asked, failures: 0 }),
      load: () => new Promise<void>((done) => { asked++; waits.push(() => { const one = pages.pop(); if (one) { shown = [...one, ...shown]; loaded++; p.draw(shown); } done(); }); }),
      whenDrawn: async () => true,
    } });
    p.draw(shown);
    const next = async () => { waits.shift()!(); await settle(); await settle(); };
    return { p, notes, asked: () => asked, next, near: () => p.row('m-card').querySelector('.approval')! };
  };

  // 去确认 for p1, drawn, while an earlier 去确认 for p-far is still reading back.
  const a = setup();
  await settle();
  const going = a.p.cards.locate(farItem);
  await settle();
  assert.deepEqual([a.asked(), a.notes.at(-1)], [1, '正在往前找这条消息…']);
  assert.equal(a.p.cards.find({ proposalId: 'p1' }), true);
  assert.equal(a.notes.at(-1), '', 'the lookup\'s note goes with it');
  assert.equal(a.p.doc.activeElement, a.near());
  await a.next();
  assert.equal(await going, undefined, 'gave way: nothing to say about it');
  assert.equal(a.asked(), 1, 'no further page is read');
  assert.equal(a.p.doc.activeElement, a.near(), 'the page that came late takes neither the scroll nor the focus');
  assert.equal(a.notes.filter(t => t).length, 1, 'and puts up no note of its own');

  // A notification's card, found once its chat has drawn, does the same.
  const b = setup();
  await settle();
  const before = b.p.cards.locate(farItem);
  await settle();
  b.p.cards.locateSoon(b.p.sel, { proposalId: 'p1', messageId: 'm-card' });
  assert.equal(b.p.doc.activeElement, b.near());
  await b.next();
  assert.equal(await before, undefined);
  assert.equal(b.asked(), 1);

  // A newer lookup: the older one gives way, the newer one finds the card.
  const c = setup();
  await settle();
  const first = c.p.cards.locate(farItem);
  await settle();
  const second = c.p.cards.locate(farItem);
  await settle();
  await c.next();
  assert.equal(await first, undefined);
  await c.next();
  await c.next();
  assert.equal(await second, true);
  assert.equal(c.p.doc.activeElement, c.p.row('m-far').querySelector('.approval'));
});

test('a search of the palette or a quote\'s jump that takes over from 去确认 still reading earlier pages: the lookup ends quietly and 去确认 resolves undefined, nothing to say; the lookup that took over finds its message', async () => {
  const far = { ...cardMessage(), id: 'm-far', blocks: [{ ...fact(), approval: { ...fact().approval, id: 'p-far' } }] };
  const filler = (n: number) => [{ id: 'u-' + n + '-a', role: 'user', content: '第 ' + n + ' 页' }, { id: 'u-' + n + '-b', role: 'assistant', content: '好的' }];
  const farItem = { proposalId: 'p-far', messageId: 'm-far' };
  const notes: string[] = [];
  const pages: Any[][] = [[far], filler(2), filler(1)];
  let shown: Any[] = [{ id: 'u-new', role: 'user', content: '最新的话' }, cardMessage()];
  let asked = 0, loaded = 0, open: Any = null, inflight: Promise<void> | null = null;
  const waits: Array<() => void> = [];
  const hold: Any = {};
  // Wired as app.js wires it: the lookup's quiet end is told back.
  const p = page({ approvals: listWith(pref, { ...pref, id: 'p-far', messageId: 'm-far' }),
    locate: (item: Any, onCancel?: () => void) => hold.L.find({ sel: p.sel, messageId: item.messageId, onCancel }), cancelLocate: () => hold.L.cancel() });
  hold.L = p.window.ClowderLocate;
  open = p.sel;
  // The history's loader as chat-history.js offers it: a lookup's load joins the page already on its way.
  hold.L.init({ thread: p.thread, selected: () => open, note: (text: string) => notes.push(text), rest: () => {}, history: {
    older: () => ({ key: 'bot:团子', gen: 1, state: 'idle', more: pages.length > 0, loaded, drawn: loaded, error: '', asked, failures: 0 }),
    load: () => inflight || (inflight = new Promise<void>((done) => { asked++; waits.push(() => { inflight = null; const one = pages.pop(); if (one) { shown = [...one, ...shown]; loaded++; p.draw(shown); } done(); }); })),
    whenDrawn: async () => true,
  } });
  p.draw(shown);
  await settle();
  const next = async () => { waits.shift()!(); await settle(); await settle(); };
  // A search hit drawn already (the palette's find), while 去确认 reads back.
  const going = p.cards.locate(farItem);
  await settle();
  assert.equal(asked, 1);
  assert.equal(await hold.L.find({ sel: p.sel, messageId: 'u-new' }), true);
  await next();
  assert.equal(await going, undefined, 'given way: nothing to say about it');
  assert.equal(asked, 1, 'no further page');
  assert.equal(p.doc.activeElement, p.row('u-new'), 'the search\'s message keeps the focus');
  // A quote's jump to a message further back, while 去确认 reads back: the jump reads on and finds its message.
  const again = p.cards.locate(farItem);
  await settle();
  const jump = hold.L.find({ sel: p.sel, messageId: 'u-2-a' });
  await next();
  assert.equal(await again, undefined);
  assert.equal(await jump, true);
  assert.equal(p.doc.activeElement, p.row('u-2-a'));
  assert.equal(p.row('m-far'), undefined, 'a page further back, never read');
  assert.equal(asked, 2);
  // Another chat opened meanwhile ends it just as quietly.
  const left = p.cards.locate(farItem);
  await settle();
  open = { type: 'bot', id: '栗子' };
  await next();
  assert.equal(await left, undefined);
  // Only a search that stopped and said why is null: nothing earlier to read, and the card not there.
  open = p.sel;
  assert.equal(pages.length, 0);
  assert.equal(await p.cards.locate({ proposalId: 'p-gone', messageId: 'm-gone' }), null);
  assert.equal(notes.at(-1), '这条消息不在这段对话里，也没有更早的记录可以翻了。');
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
  assert.deepEqual(styles.slice(-7), ['chat-cards.css', 'chat-presence.css', 'chat-reactions.css', 'sidebar.css', 'chat-panel.css', 'apps-dialog.css', 'chat-live.css']);
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
  // 去确认: the card in the history, else its message on earlier pages (chat-locate.js), then the card itself (item 59).
  assert.match(app, /confirm: \(item\) => cards\.find\(item\) \|\| \(item && item\.messageId \? cards\.locate\(item\) : false\),/);
  // A search of its own that ended quietly (a search, a quote's jump, another chat) is told back as onCancel.
  assert.match(app, /cards\.init\(\{[\s\S]*?locate: \(item, onCancel\) => locate\.find\(\{ sel: state\.sel, messageId: item\.messageId, onCancel \}\),[\s\S]*?cancelLocate: \(\) => locate\.cancel\(\),[\s\S]*?latest: \(\) => chatHistory\.latest\(\),\n  \}\);/);
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
