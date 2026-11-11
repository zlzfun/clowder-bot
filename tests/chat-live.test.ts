import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A reply drawn while it is being written (chat-live-rules.js, chat-live.js;
// contract docs/chat-live-api.md). The rules run in a bare VM; the DOM module
// runs as the classic script it is, on a small DOM (tree, classes, data
// attributes, markup for redraw identity, a scroll box) with fake timers and
// animation frames. app.js is not loaded: its hooks are faked the way it
// passes them to init(), a few of its own helpers run extracted, and static
// checks cover its wiring. The two event streams are real captures from the
// isolated runtime (Claude Code appending, Codex appending and replacing).
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-live-rules.js'), { window });
  return window.ClowderLiveRules;
}
const claude: Any[] = JSON.parse(read('tests/fixtures/chat-live-claude.json'));
const codex: Any[] = JSON.parse(read('tests/fixtures/chat-live-codex.json'));
const piece = (text: string, end?: number, more: Record<string, unknown> = {}) => ({ kind: 'text', messageId: 'm', catId: 'c', text, ...(end === undefined ? {} : { end }), ...more });

// ---------------------------------------------------------------- alignment
test('words are placed by native position: a following piece appends, a piece already held is dropped, a gap is never glued and waits for the draft', () => {
  const L = rules();
  const r = L.reply('m', 'c', true);
  assert.equal(L.apply(r, piece('你好', 2)), true);
  assert.equal(L.apply(r, piece('，', 3)), true);
  assert.equal(r.text, '你好，');
  // The same piece again (a duplicate) and one a newer draft already covered.
  assert.equal(L.apply(r, piece('，', 3)), false);
  assert.equal(L.apply(r, piece('好', 2)), false);
  assert.equal(r.text, '你好，');
  // A piece after a gap (「今天」 at 3..5 never arrived): not glued, so no 「你好，天气」.
  assert.equal(L.apply(r, piece('天气', 7)), false);
  assert.equal(r.text, '你好，');
  // A piece overlapping words it cannot be checked against: not glued either.
  assert.equal(L.apply(r, piece('，今', 4)), false);
  assert.equal(r.text, '你好，');
  // The transcript's draft fills the gap: the piece waiting at its place follows on.
  assert.equal(L.draft(r, '你好，今天'), true);
  assert.equal(r.text, '你好，今天天气');
  // and later pieces continue by position.
  L.apply(r, piece('不错', 9));
  assert.equal(r.text, '你好，今天天气不错');
});

test('a piece without a position follows on only while the reply was seen whole from its start', () => {
  const L = rules();
  const seen = L.reply('m', 'c', false);
  L.apply(seen, { kind: 'start', messageId: 'm' });
  assert.equal(L.apply(seen, piece('一')), true, 'seen from the start: appended');
  assert.equal(L.apply(seen, piece('二', 2)), true);
  assert.equal(seen.text, '一二');
  // A gap breaks it for good: a later piece without a position is dropped.
  L.apply(seen, piece('四', 4));
  assert.equal(L.apply(seen, piece('五')), false);
  assert.equal(seen.text, '一二');
  // A reply first met mid-way (a reload) never appends a piece without a position.
  const late = L.reply('m', 'c', false);
  L.apply(late, piece('中间'));
  assert.equal(late.text, '');
  // A start marker after words already arrived does not make it whole.
  const draftFirst = L.reply('m', 'c', false);
  L.draft(draftFirst, '草稿');
  L.apply(draftFirst, { kind: 'start', messageId: 'm' });
  L.apply(draftFirst, piece('续'));
  assert.equal(draftFirst.text, '草稿');
  // A reconnect (lost) breaks it as well.
  const lost = L.reply('m', 'c', true);
  L.apply(lost, piece('甲'));
  L.lost(lost);
  assert.equal(L.apply(lost, piece('乙')), false);
  assert.equal(lost.text, '甲');
});

test('replace makes the whole reply this piece (the same words again change nothing); held pieces of the old words are dropped', () => {
  const L = rules();
  const r = L.reply('m', 'c', true);
  L.apply(r, piece('草稿一', 3));
  L.apply(r, piece('后', 9));
  assert.equal(L.apply(r, piece('重写的全文', 5, { replace: true }), 10), true);
  assert.equal(r.text, '重写的全文');
  assert.deepEqual(plain(r.held), [], 'positions before the replacement no longer hold');
  assert.equal(L.apply(r, piece('重写的全文', 5, { replace: true }), 11), false, 'Codex repeats the whole reply after each paragraph');
  assert.equal(L.apply(r, piece('。', 6)), true);
  assert.equal(r.text, '重写的全文。');
});

test('a transcript draft extends the words but never takes back longer words the stream already showed', () => {
  const L = rules();
  const r = L.reply('m', 'c', true);
  L.apply(r, piece('今天天气不错，', 7));
  // An older, shorter draft (the engine saves about every two seconds).
  assert.equal(L.draft(r, '今天天'), false);
  assert.equal(r.text, '今天天气不错，');
  // A newer, longer one that continues the words.
  assert.equal(L.draft(r, '今天天气不错，适合'), true);
  assert.equal(r.text, '今天天气不错，适合');
  // Differing words with no replacement seen here: the draft is the record (one this page missed).
  const missed = L.reply('m', 'c', false);
  L.draft(missed, '旧的开头');
  assert.equal(L.draft(missed, '另一版全文'), true);
  assert.equal(missed.text, '另一版全文');
  // After a replacement this page saw, a draft can be older than it however late it was read: not taken.
  L.apply(r, piece('改过的', 3, { replace: true }), 5000);
  assert.equal(L.draft(r, '今天天气不错，适合出门'), false);
  assert.equal(L.draft(r, '另一版全文'), false);
  assert.equal(r.text, '改过的');
  // Done: nothing changes it any more.
  L.apply(r, { kind: 'done', messageId: 'm' }, 7000);
  assert.equal(L.apply(r, piece('迟到', 7)), false);
  assert.equal(r.done, true);
  assert.equal('ok' in r, false, 'done says only that the reply stopped being produced');
});

// Review 2026-11-11 (frontend-r1), findings 1 and 2.
test('a saved draft never undoes a replacement this page saw: an older, longer draft is not taken, so the next piece still lands (ABCD → AB → X at 3 is ABX)', () => {
  const L = rules();
  const r = L.reply('m', 'c', true);
  L.apply(r, piece('ABCD', 4), 1);
  L.apply(r, piece('AB', 2, { replace: true }), 2);
  // A read that returns the draft saved before the replacement (whenever it was asked for).
  assert.equal(L.draft(r, 'ABCD'), false);
  assert.equal(r.text, 'AB');
  assert.equal(L.apply(r, piece('X', 3), 3), true);
  assert.equal(r.text, 'ABX');
  // A shorter draft that differs (saved before the replacement, read after it) does not overwrite newer words either.
  assert.equal(L.draft(r, 'AQ'), false);
  assert.equal(L.draft(r, 'A'), false);
  assert.equal(r.text, 'ABX');
});

test('after a replacement, a draft is taken only to fill a gap and only when the pieces received since vouch for it', () => {
  const L = rules();
  const r = L.reply('m', 'c', true);
  L.apply(r, piece('旧的全文', 4), 1);
  L.apply(r, piece('新的', 2, { replace: true }), 2);
  // Pieces after a gap (「开头」 at 2..4 never arrived): held at their place.
  L.apply(r, piece('之后', 6), 3);
  assert.equal(r.text, '新的');
  // A draft that disagrees with the held piece (saved before the replacement): not taken.
  assert.equal(L.draft(r, '新的开头不对'), false);
  // A draft too short to be checked against the held piece: not taken either.
  assert.equal(L.draft(r, '新的开头'), false);
  assert.equal(r.text, '新的');
  // One that holds the very piece received since: it fills the gap.
  assert.equal(L.draft(r, '新的开头之后'), true);
  assert.equal(r.text, '新的开头之后');
});

test('a draft ahead of the stream stops pieces without a position from following on, so nothing is written twice (A, draft AB, then B is still AB)', () => {
  const L = rules();
  const r = L.reply('m', 'c', false);
  L.apply(r, { kind: 'start', messageId: 'm' });
  L.apply(r, piece('A'));
  assert.equal(r.text, 'A');
  assert.equal(L.draft(r, 'AB'), true);
  L.apply(r, piece('B'));
  assert.equal(r.text, 'AB', 'the late B is the one the draft already had');
  // Positioned pieces still follow on.
  L.apply(r, piece('C', 3));
  assert.equal(r.text, 'ABC');
  // A draft that only repeats what the stream showed changes nothing.
  const same = L.reply('m', 'c', false);
  L.apply(same, { kind: 'start', messageId: 'm' });
  L.apply(same, piece('A'));
  assert.equal(L.draft(same, 'A'), false);
  L.apply(same, piece('B'));
  assert.equal(same.text, 'AB');
});

// ---------------------------------------------------------------- real captures
function replay(L: Any, events: Any[], each?: (r: Any, ev: Any, i: number) => void) {
  const r = L.reply(events[0].messageId, events[0].catId, false);
  events.forEach((ev, i) => { L.apply(r, ev, i + 1); each?.(r, ev, i); });
  return r;
}

test('the captured Claude Code turn draws exactly its settled words; its paw signature is never shown, not even half written', () => {
  const L = rules();
  const shown: string[] = [];
  const r = replay(L, claude, (state) => shown.push(L.display(state.text)));
  const settled = '真是个热情又温暖的问候，用波浪号和感叹词把欢迎的感觉表达得恰到好处，一下子就拉近了距离。🌟';
  assert.equal(L.display(r.text), settled);
  assert.equal(r.text.length, claude.filter(e => e.kind === 'text').at(-1).end, 'the buffer is the native content, position for position');
  assert.ok(shown.every(s => !s.includes('[') && !s.includes('🐾')), 'no frame showed the signature or its opening bracket');
  for (let i = 1; i < shown.length; i++) assert.ok(shown[i].startsWith(shown[i - 1]) || shown[i - 1].startsWith(shown[i]), 'what shows only grows (or hides a tail being written)');
  // A reload mid-reply: the draft read at some point, then the stream again from
  // a few pieces earlier (duplicates) — the same words, nothing doubled or lost.
  const texts = claude.filter(e => e.kind === 'text');
  const midway = L.reply('m', 'c', false);
  L.draft(midway, texts.slice(0, 9).map(e => e.text).join(''));
  for (const ev of texts.slice(6)) L.apply(midway, ev);
  assert.equal(midway.text, r.text);
  // Pieces lost on the way (a reconnect): held, then filled by a draft.
  const gapped = L.reply('m', 'c', true);
  texts.forEach((ev, i) => { if (i < 5 || i > 12) L.apply(gapped, ev); });
  assert.ok(gapped.text.length < r.text.length, 'nothing glued across the gap');
  L.draft(gapped, texts.slice(0, 15).map(e => e.text).join(''));
  assert.equal(gapped.text, r.text, 'the draft closes the gap and the held pieces follow');
});

test('the captured Codex turn (appends, whole-reply replacements, a shorter replacement before the signed one) draws its settled words without the signature', () => {
  const L = rules();
  const shown: string[] = [];
  const r = replay(L, codex, (state) => shown.push(L.display(state.text)));
  const settled = '我现在写入并回读确认。\n\n已写入并确认：你好，很高兴见到你！';
  assert.equal(L.display(r.text), settled);
  assert.ok(shown.every(s => !s.includes('🐾') && !s.includes('[')));
  // A replacement equal to what shows draws nothing new.
  const at = codex.findIndex(e => e.replace);
  assert.equal(shown[at], shown[at - 1]);
  // Its steps, in everyday words.
  const steps = codex.filter(e => e.kind === 'step').map(e => L.stepWords(e.tool, e.target));
  assert.deepEqual(steps, ['在改文件', '在运行命令']);
});

// ---------------------------------------------------------------- what shows
test('while being written, a trailing paw signature, an unclosed last [ line and a SILENT (or its start) are not shown; code fences protect a paw line', () => {
  const L = rules();
  assert.equal(L.display('写好了。\n\n[宪宪/Opus🐾]'), '写好了。');
  assert.equal(L.display('写好了。\n\n[宪宪/Op'), '写好了。');
  assert.equal(L.display('写好了。\n\n['), '写好了。');
  assert.equal(L.display('写好了。\n\n[砚砚/GPT-6🐾]\n\n[砚砚/🐾]'), '写好了。', 'a cat signing itself before the host signature');
  assert.equal(L.display('先看代码：\n```\n[注释/🐾]'), '先看代码：\n```\n[注释/🐾]', 'inside an open code fence it is code');
  assert.equal(L.display('[1] 第一条'), '[1] 第一条', 'a closed bracket line is words');
  for (const s of ['S', 'SI', 'SILEN', 'SILENT', ' SILENT \n', 'SILENT\n\n[团子/haiku🐾]']) assert.equal(L.display(s), '', JSON.stringify(s));
  assert.equal(L.display('Sure, here'), 'Sure, here');
  assert.equal(L.display('SILENT 不是这个意思'), 'SILENT 不是这个意思');
  // An open fence is drawn closed, so code reads as code while it is written.
  assert.equal(L.drawable('看：\n```js\nlet a'), '看：\n```js\nlet a\n```');
  assert.equal(L.drawable('```js\nx\n```'), '```js\nx\n```');
});

test('steps read as everyday words for Claude Code, Codex and other agents; a target shows only where it reads naturally and never as a path or command', () => {
  const L = rules();
  const said = (tool: string, target?: string) => L.stepWords(tool, target);
  assert.equal(said('Read', 'hello.txt'), '在看 hello.txt');
  assert.equal(said('Read'), '在看文件');
  assert.equal(said('Write', '结果.md'), '在写 结果.md');
  for (const t of ['Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(said(t, 'a.py'), '在改 a.py');
  assert.equal(said('Bash', 'List files in the repo'), '在运行命令', 'a shell never shows what it runs');
  assert.equal(said('Grep', 'function\\s+foo'), '在翻找文件');
  assert.equal(said('Glob', '**/*.ts'), '在翻找文件');
  assert.equal(said('WebSearch', '猫 为什么 喜欢 纸箱'), '在搜索「猫 为什么 喜欢 纸箱」');
  assert.equal(said('WebSearch'), '在搜索');
  assert.equal(said('WebFetch', 'example.com'), '在读 example.com');
  assert.equal(said('Task', '整理资料'), '在分头处理');
  assert.equal(said('Agent'), '在分头处理');
  assert.equal(said('TodoWrite'), '在列计划');
  // Codex and others.
  assert.equal(said('file_change', 'note.txt'), '在写 note.txt');
  assert.equal(said('file_change'), '在改文件');
  assert.equal(said('command_execution'), '在运行命令');
  assert.equal(said('web_search', '天气'), '在搜索「天气」');
  assert.equal(said('read_file', 'a.md'), '在看 a.md');
  assert.equal(said('run_shell_command'), '在运行命令');
  assert.equal(said('apply_patch'), '在改文件');
  assert.equal(said('mcp__cat-cafe-memory__recall'), '在回想');
  assert.equal(said('mcp__claude-in-chrome__navigate'), '在用浏览器');
  assert.equal(said('mcp__x__do_thing'), '在用工具');
  assert.equal(said('mcp_tool_call'), '在用工具');
  assert.equal(said('SomethingNew', 'x'), '在处理', 'an unknown tool gets a neutral phrase and no target');
  // Never a path; a long target is shortened to fit one line.
  assert.equal(said('Read', '/Users/me/secret/plan.md'), '在看文件');
  assert.equal(said('WebSearch', '一'.repeat(40)), '在搜索「' + '一'.repeat(23) + '…」');
  // The quiet line follows the reply's state.
  const r = L.reply('m', 'c', true);
  assert.equal(L.phrase(r), '');
  L.apply(r, { kind: 'thinking' });
  assert.equal(L.phrase(r), '在想…');
  L.apply(r, { kind: 'step', tool: 'Read', target: 'hello.txt' });
  assert.equal(L.phrase(r), '在看 hello.txt');
  L.apply(r, piece('好', 1));
  assert.equal(L.phrase(r), '', 'words again: the step is behind it');
  L.apply(r, { kind: 'done' });
  assert.equal(L.phrase(r), '');
});

test('only events that change the record read it again; the pieces the live stream draws do not', () => {
  const L = rules();
  for (const type of ['tool_use', 'tool_result', 'system_info', 'session_init', 'status', 'provider_signal', 'liveness_signal', 'agent_loop']) {
    assert.equal(L.structural({ type }), false, type);
  }
  assert.equal(L.structural({ type: 'text', origin: 'stream' }), false);
  assert.equal(L.structural({ type: 'text', origin: 'callback' }), true, 'an explicit post is a new message');
  for (const type of ['done', 'error', 'a2a_handoff', 'queue_updated', 'thread_updated', 'task_created', 'task_updated', 'approval_requested', 'approval_resolved', 'connector_message', 'message_updated', 'resync', 'disconnected', 'something_new']) {
    assert.equal(L.structural({ type }), true, type);
  }
  assert.equal(L.structural(null), true);
  assert.equal(L.gap({ type: 'resync' }), true);
  assert.equal(L.gap({ type: 'disconnected' }), true);
  assert.equal(L.gap({ type: 'text' }), false);
});

test('the send\'s answer is read as the native admission, naming the owner\'s message; an error event is an error', () => {
  const L = rules();
  const sse = 'event: queued\ndata: {"status":"queued","userMessageId":"u-1","queuePosition":1}\n\nevent: done\ndata: {"background":true}\n\n';
  assert.deepEqual(plain(L.receipt(sse, false)), { receipt: { status: 'queued', userMessageId: 'u-1', queuePosition: 1 }, userMessageId: 'u-1', error: '' });
  assert.equal(L.receipt('event: error\ndata: {"error":"出错了"}\n\n', false).error, '出错了');
  assert.equal(L.receipt({ status: 'queued', userMessageId: 'u-2' }, true).userMessageId, 'u-2');
  assert.equal(L.receipt('', false).userMessageId, '');
  assert.equal(L.signature('<svg><clipPath id="clowder-cat-crop-12"></clipPath><use href="#xbot-glyph-3"></use></svg>'),
    '<svg><clipPath id="clowder-cat-crop-#"></clipPath><use href="#xbot-glyph-#"></use></svg>');
});

// ---------------------------------------------------------------- small DOM
class Base {
  parent: El | null = null;
  constructor(readonly doc: Doc) {}
  get parentElement() { return this.parent; }
  get isConnected(): boolean { for (let n: Base | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  get textContent(): string { return ''; }
  set textContent(_v: string) { /* text nodes override */ }
  get html(): string { return ''; }
  remove() { const p = this.parent; if (!p) return; p.kids.splice(p.kids.indexOf(this), 1); this.parent = null; }
}
class TextNode extends Base {
  constructor(doc: Doc, public data: string) { super(doc); }
  override get textContent() { return this.data; }
  override set textContent(v: string) { this.data = String(v); }
  override get html() { return this.data.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
}
class El extends Base {
  readonly tagName: string; kids: Base[] = []; attrs = new Map<string, string>(); listeners = new Map<string, Array<(ev: Any) => void>>();
  hidden = false; disabled = false; type = ''; tabIndex = -1; scrollTop = 0; scrollHeight = 0; clientHeight = 0; inner = '';
  moves = 0;
  [key: string]: Any;
  constructor(doc: Doc, tag: string) { super(doc); this.tagName = tag.toUpperCase(); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', String(v)); }
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s: Set<string>) => { this.className = [...s].join(' '); };
    return {
      add: (...n: string[]) => { const s = names(); n.forEach(x => s.add(x)); write(s); },
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
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  override get textContent(): string { return this.kids.map(k => k.textContent).join(''); }
  override set textContent(v: string) { this.replaceChildren(); if (v !== '' && v != null) this.append(String(v)); }
  set innerHTML(v: string) { this.replaceChildren(); this.inner = v; }
  override get html(): string {
    const attrs = [...this.attrs].sort().map(([k, v]) => ` ${k}="${v}"`).join('') + (this.hidden ? ' hidden' : '');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.inner}${this.kids.map(k => k.html).join('')}</${this.tagName.toLowerCase()}>`;
  }
  get outerHTML() { return this.html; }
  private adopt(item: Base | string): Base {
    const n = typeof item === 'string' ? new TextNode(this.doc, item) : item;
    if (n.parent) { n.remove(); if (n instanceof El) n.moves++; }
    n.parent = this;
    return n;
  }
  append(...items: Array<Base | string>) { for (const i of items) this.kids.push(this.adopt(i)); }
  prepend(...items: Array<Base | string>) { this.kids.unshift(...items.map(i => this.adopt(i))); }
  insertBefore(n: Base, ref: Base | null) {
    if (!ref) { this.append(n); return n; }
    this.adopt(n);
    this.kids.splice(this.kids.indexOf(ref), 0, n);
    return n;
  }
  replaceChildren(...items: Array<Base | string>) { for (const k of [...this.kids]) k.remove(); this.append(...items); }
  addEventListener(type: string, fn: (ev: Any) => void) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  click() { for (const fn of this.listeners.get('click') ?? []) fn({ preventDefault() {} }); }
  find(cls: string): El[] { return this.children.flatMap(c => [...(c.classList.contains(cls) ? [c] : []), ...c.find(cls)]); }
}
class Doc {
  body: El;
  constructor() { this.body = new El(this, 'body'); }
  createElement(tag: string) { return new El(this, tag); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag); }
  createTextNode(t: string) { return new TextNode(this, t); }
}

// ---------------------------------------------------------------- the page
type Opts = { reduce?: boolean; queued?: boolean; busy?: boolean; unread?: string };
function page(opts: Opts = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const chat = h('div', 'chat'), thread = h('div', 'thread'), dock = h('div', 'dock');
  thread.id = 'thread';
  chat.append(thread, dock);
  doc.body.append(chat);
  // The history's scroll box: 600 high, content height set by a test.
  Object.assign(thread, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
  let now = 1_000_000, seq = 0;
  const timers = new Map<number, { fn: () => void; at: number; every?: number }>();
  let frames: Array<() => void> = [];
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
    }
    now = end;
  };
  const frame = () => { const list = frames; frames = []; list.forEach(fn => fn()); };
  const changed: number[] = [], gaps: number[] = [];
  const window: Any = {
    matchMedia: () => ({ matches: !!opts.reduce }),
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
  };
  // Wall-clock time is the fake clock.
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: Any[]) { super(...((args.length ? args : [now]) as [number])); }
    static override now() { return now; }
  }
  const context = vm.createContext({
    window, document: doc, console,
    Date: FakeDate,
    setTimeout: (fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
  });
  for (const file of ['client/public/chat-live-rules.js', 'client/public/chat-live.js']) vm.runInContext(read(file), context);
  const live = window.ClowderLive;
  const state: Any = { queued: !!opts.queued, busy: !!opts.busy, unread: opts.unread ?? '', activity: null };
  // The status line's last successful activity read (chat-experience.js's activityRead()).
  window.ClowderExperience = { activityRead: () => state.activity };
  // The hooks app.js passes (see live.init in client/public/app.js): a reply
  // frame like replyFrame (face + name when the cat is known), Markdown as
  // one paragraph per line.
  live.init({
    thread,
    // Each drawing makes the history 40px taller, as words do.
    render: (parent: El, text: string) => { for (const line of text.split('\n').filter(Boolean)) { const p = h('p'); p.textContent = line; parent.append(p); } thread.scrollHeight += 40; },
    row: (catId: string, time: string) => {
      const row = h('div', 'msg bot live' + (catId ? ' with-face' : ' cont'));
      row.dataset.time = time;
      if (catId) { row.dataset.sender = 'bot:cat:' + catId; const face = h('span', 'avatar'); face.setAttribute('title', catId); row.append(face); }
      const body = h('div', 'body');
      if (catId) body.append(h('div', 'who'));
      row.append(body);
      return row;
    },
    queued: () => state.queued,
    busy: () => state.busy,
    unread: () => state.unread,
    changed: () => changed.push(now),
    gap: () => gaps.push(now),
  });
  // A history as the renderers draw it.
  const inner = (chatKey = 'bot:Ada', ...rows: El[]) => { const i = h('div', 'thread-inner'); i.dataset.chat = chatKey; i.append(...rows); return i; };
  const msg = (mid: string, text: string, cls = 'msg bot with-face') => { const r = h('div', cls); r.dataset.mid = mid; const body = h('div', 'body'); body.append(text); r.append(body); return r; };
  const frameRow = (mid: string) => { const r = h('div', 'msg bot with-face'); r.dataset.mid = mid; r.dataset.time = 'T'; r.append(h('div', 'body')); return live.frame(r); };
  const onScreen = () => thread.children[0];
  const ev = (kind: string, more: Record<string, unknown> = {}) => live.event({ kind, messageId: 'm1', catId: 'cat-a', ...more });
  return { doc, live, thread, dock, inner, msg, frameRow, onScreen, ev, advance, frame, changed, gaps, state, h, clock: () => now };
}
const text = (n: El | null | undefined) => (n ? n.textContent : '');
const stepOf = (row: El) => row.find('lv-step')[0];
const bubbleOf = (row: El) => row.find('lv-text')[0];

// ---------------------------------------------------------------- redraws
test('a redraw keeps the element of every row that did not change: only new rows rise in, a changed row is replaced in place without rising, held rows stay last, nothing in place is moved', () => {
  const p = page();
  const a = p.msg('a', '早'), b = p.msg('b', '在写'), divider = p.h('div', 'tdiv');
  divider.textContent = '今天 09:00';
  const sending = p.msg('', '发送中', 'msg user optimistic');
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada', divider, a, b), [sending]);
  const before = p.onScreen();
  assert.deepEqual(before.children, [divider, a, b, sending]);
  // Drawn again from a newer read: a and the divider unchanged, b changed, c new; the send still held.
  const next = p.inner('bot:Ada', (() => { const d = p.h('div', 'tdiv'); d.textContent = '今天 09:00'; return d; })(), p.msg('a', '早'), p.msg('b', '写好了'), p.msg('c', '新的'));
  next.classList.add('greeted');
  const moves = [divider, a, sending].map(n => n.moves);
  const result = p.live.commit(next, [sending]);
  const now = p.onScreen().children;
  assert.equal(p.onScreen(), before, 'the same history element');
  assert.equal(now[0], divider);
  assert.equal(now[1], a, 'an unchanged row keeps its element (no rise, selection and open drawers stay)');
  assert.notEqual(now[2], b);
  assert.equal(text(now[2]), '写好了');
  assert.ok(now[2].classList.contains('lv-still'), 'a changed row does not rise again');
  assert.equal(text(now[3]), '新的');
  assert.ok(!now[3].classList.contains('lv-still'), 'only a new row rises in');
  assert.equal(now[4], sending, 'the held send stays last');
  assert.deepEqual([divider, a, sending].map(n => n.moves), moves, 'nothing already in place was moved');
  assert.deepEqual(plain(result), { added: 1, first: false });
  assert.ok(p.onScreen().classList.contains('greeted'), 'the history\'s own classes follow the drawing');
  // Another conversation is a first drawing: everything is replaced.
  p.live.select('bot:Bob');
  const other = p.live.commit(p.inner('bot:Bob', p.msg('x', '你好')), []);
  assert.equal(other.first, true);
  assert.notEqual(p.onScreen(), before);
});

// ---------------------------------------------------------------- live rows
test('a send shows the cat\'s typing bubble at once; the reply\'s start takes that same bubble, steps read as a quiet line, words appear with a caret, and the finished transcript row takes its place without rising', () => {
  const p = page();
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada', p.msg('u0', '你好', 'msg user')), []);
  const reply = p.live.expect('cat-a');
  const typing = p.onScreen().children.at(-1)!;
  assert.ok(typing.classList.contains('live'));
  assert.equal(typing.find('typing-dots').length, 1, 'typing dots, not placeholder words');
  assert.equal(text(typing), '');
  assert.equal(p.live.working(), true, 'the stop control is offered at once');
  reply.accept('u1');
  p.ev('start');
  assert.equal(p.onScreen().children.at(-1), typing, 'the reply takes the bubble already on screen');
  assert.equal(typing.dataset.mid, 'm1');
  p.ev('thinking');
  p.frame();
  assert.equal(text(stepOf(typing)), '在想…');
  p.ev('step', { tool: 'Read', target: 'hello.txt' });
  p.frame();
  assert.match(text(stepOf(typing)), /在看 hello\.txt$/, 'the new words cross-fade in');
  assert.equal(stepOf(typing).find('lv-out').length, 1, 'the old words fade out in the same place');
  p.advance(250);
  assert.equal(text(stepOf(typing)), '在看 hello.txt');
  p.ev('text', { text: '读完了', end: 3 });
  p.ev('text', { text: '，写得', end: 6 });
  p.frame();
  const bubble = bubbleOf(typing);
  assert.equal(text(bubble), '读完了，写得');
  assert.ok(bubble.classList.contains('lv-writing'), 'a caret while it is still writing');
  assert.ok(bubble.children.at(-1)!.classList.contains('lv-tail'), 'the caret sits after the last words');
  assert.equal(typing.find('typing-dots').length, 0);
  p.advance(250);
  assert.equal(stepOf(typing).hidden, true, 'words again: the step line goes');
  // A transcript read asked for earlier carries an older, shorter draft: the live words stay.
  p.live.read([{ id: 'u1', inProgress: false }, { id: 'm1', catId: 'cat-a', inProgress: true, draft: '读完' }], 0);
  const frame = p.frameRow('m1');
  p.live.commit(p.inner('bot:Ada', p.msg('u0', '你好', 'msg user'), p.msg('u1', '读一下', 'msg user'), frame), []);
  assert.equal(p.onScreen().children.at(-1), frame, 'the history\'s row for the reply takes over');
  assert.ok(frame.classList.contains('lv-still'), 'without rising in again');
  assert.equal(bubbleOf(frame), bubble, 'the same bubble moved in: no flash');
  assert.equal(text(bubbleOf(frame)), '读完了，写得', 'never replaced by the older, shorter draft');
  // Done, then the transcript's finished row.
  const tail = '真好。\n\n[团子/haiku🐾]';
  p.ev('text', { text: tail, end: 6 + tail.length });
  p.ev('done');
  p.frame();
  assert.equal(text(bubbleOf(frame)), '读完了，写得真好。', 'the signature never shows');
  assert.ok(!bubbleOf(frame).classList.contains('lv-writing'), 'no caret once it stopped being written');
  assert.equal(p.live.working(), false);
  p.live.read([{ id: 'm1', catId: 'cat-a', inProgress: false }], 1e9);
  const settled = p.msg('m1', '读完了，写得真好。');
  p.live.commit(p.inner('bot:Ada', p.msg('u0', '你好', 'msg user'), p.msg('u1', '读一下', 'msg user'), settled), []);
  assert.equal(p.onScreen().children.at(-1), settled);
  assert.ok(settled.classList.contains('lv-still'), 'the finished reply takes the same place without rising');
  assert.equal(p.live.peek('m1'), null, 'nothing is kept once the transcript has it');
  // Late events of a finished reply change nothing.
  p.ev('text', { text: '迟到', end: 30 });
  assert.equal(p.onScreen().children.length, 3);
});

test('a reply already under way (one this page met mid-way, like an opening greeting) does not take a send\'s typing bubble; a reply whose start was missed after the send was taken replaces it', () => {
  const p = page();
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  const reply = p.live.expect('cat-a');
  reply.accept('u1');
  // A greeting already being written when this page connected: its first event is a piece.
  p.live.event({ kind: 'text', messageId: 'g1', catId: 'cat-a', text: '你好呀', end: 3 });
  p.frame();
  const rows = p.onScreen().children;
  assert.equal(rows.length, 2, 'its own row; the typing bubble stays for the send');
  assert.equal(rows[0].dataset.wait !== undefined, true);
  assert.equal(rows[1].dataset.mid, 'g1');
  // The send's own reply starts: it takes the typing bubble.
  p.live.event({ kind: 'start', messageId: 'm2', catId: 'cat-a' });
  assert.equal(rows[0].dataset.mid, 'm2');
  // Another send, whose reply's start is missed (a reconnect): the read shows
  // that reply in progress, first met after the send was taken: the bubble goes.
  p.live.event({ kind: 'done', messageId: 'g1', catId: 'cat-a' });
  p.live.event({ kind: 'done', messageId: 'm2', catId: 'cat-a' });
  p.advance(1000);
  const second = p.live.expect('cat-a');
  second.accept('u3');
  p.advance(100);
  p.live.event({ kind: 'text', messageId: 'm3', catId: 'cat-a', text: '中途', end: 9 });
  assert.deepEqual(p.gaps.length, 1, 'a piece waiting for missed words asks for a read sooner');
  p.live.read([{ id: 'm3', catId: 'cat-a', inProgress: true, draft: '前面的七个字中途' }], p.clock());
  p.live.attach();
  assert.equal(p.onScreen().children.filter(r => r.dataset.wait !== undefined).length, 0, 'no typing bubble left beside the reply');
  assert.equal(text(bubbleOf(p.onScreen().children.find(r => r.dataset.mid === 'm3')!)), '前面的七个字中途');
});

test('a group\'s typing bubble has no face until a cat starts; each cat that starts gets its own row', () => {
  const p = page();
  p.live.select('group:g');
  p.live.commit(p.inner('group:g'), []);
  p.live.expect('').accept('u1');
  const typing = p.onScreen().children[0];
  assert.equal(typing.find('avatar').length, 0, 'nobody is named yet');
  assert.ok(typing.classList.contains('cont'));
  p.live.event({ kind: 'start', messageId: 'a1', catId: 'cat-a' });
  const first = p.onScreen().children[0];
  assert.notEqual(first, typing, 'redrawn with the cat\'s face and name');
  assert.equal(first.find('avatar')[0].getAttribute('title'), 'cat-a');
  assert.ok(first.classList.contains('lv-still'), 'in place, without rising');
  assert.equal(first.find('typing-dots').length, 1, 'the same typing bubble moved over');
  p.live.event({ kind: 'start', messageId: 'b1', catId: 'cat-b' });
  p.live.event({ kind: 'text', messageId: 'b1', catId: 'cat-b', text: '我也在', end: 3 });
  p.frame();
  const rows = p.onScreen().children;
  assert.deepEqual(rows.map(r => r.dataset.mid), ['a1', 'b1']);
  assert.equal(text(bubbleOf(rows[1])), '我也在');
  assert.equal(text(bubbleOf(rows[0])), '', 'each reply draws only its own words');
});

test('replies are drawn only into the open conversation\'s history, never into another view (an exchange between two cats) or a loading skeleton', () => {
  const p = page();
  p.live.select('bot:Ada');
  const other = p.h('div', 'thread-inner grpchat');
  p.thread.replaceChildren(other);
  p.ev('start');
  p.ev('text', { text: '在写', end: 2 });
  p.frame();
  p.live.expect('cat-a');
  assert.equal(other.children.length, 0, 'nothing is drawn into a view that is not this conversation');
  // Back in the conversation, the history's row for the reply gets its words at once.
  p.live.read([{ id: 'm1', catId: 'cat-a', inProgress: true, draft: '在写' }], 0);
  const frame = p.frameRow('m1');
  p.live.commit(p.inner('bot:Ada', frame), []);
  assert.equal(text(bubbleOf(frame)), '在写');
  assert.ok(bubbleOf(frame).classList.contains('lv-writing'));
});

test('a typing bubble says 排队中 only when the status says the send waits behind other work for longer than a moment, and goes when nothing runs or waits; a send that failed takes it away', () => {
  const p = page({ queued: true, busy: true });
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  const reply = p.live.expect('cat-a');
  reply.accept('u1');
  p.advance(1000);
  p.frame();
  const row = p.onScreen().children[0];
  assert.equal(text(stepOf(row)), '', 'no 排队中 flash right after sending');
  p.advance(2000);
  p.frame();
  assert.equal(text(stepOf(row)), '排队中');
  p.state.queued = false;
  p.advance(1000);
  p.frame();
  p.advance(250);
  assert.equal(text(stepOf(row)), '');
  p.state.busy = false;
  p.advance(6000);
  assert.equal(row.isConnected, false, 'nothing runs or waits here: no reply is coming, the bubble goes');
  assert.equal(p.live.working(), false);
  // A send that did not go out.
  const failed = p.live.expect('cat-a');
  assert.equal(p.onScreen().children.length, 1);
  failed.drop();
  assert.equal(p.onScreen().children.length, 0);
  // While a reply is being written, a follow-up send adds no second bubble (the cat takes it in or queues it).
  p.live.event({ kind: 'start', messageId: 'm1', catId: 'cat-a' });
  const count = p.onScreen().children.length;
  p.live.expect('cat-a');
  assert.equal(p.onScreen().children.length, count);
});

test('stopping shows 正在停止… on what is being written until it ends; unclaimed typing bubbles go after the stop answered', () => {
  const p = page();
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  p.ev('start');
  p.ev('text', { text: '写到一半', end: 4 });
  p.frame();
  p.live.stopping(true);
  assert.equal(p.live.isStopping(), true);
  p.frame();
  const row = p.onScreen().children[0];
  assert.match(text(stepOf(row)), /正在停止…$/);
  p.ev('done');
  p.frame();
  p.advance(250);
  assert.equal(text(stepOf(row)), '', 'it ended: the transcript says how');
  assert.equal(text(bubbleOf(row)), '写到一半', 'the words written so far stay; nothing is undone');
  p.live.stopping(false);
  // A send the server took whose reply never started: withdrawn by the stop, its bubble goes;
  // one whose send is still on its way stays.
  const taken = p.live.expect('cat-a');
  taken.accept('u1');
  p.live.stopping(true);
  p.live.stopped();
  p.advance(1600);
  assert.equal(p.onScreen().children.filter(r => r.dataset.wait !== undefined).length, 0);
  p.live.stopping(false);
  p.live.expect('cat-a');
  p.live.stopping(true);
  p.live.stopped();
  p.advance(1600);
  assert.equal(p.onScreen().children.filter(r => r.dataset.wait !== undefined).length, 1);
});

// Review 2026-11-11 (frontend-r1), findings 3–5.
// GET <scope>/activity as chat-experience.js keeps it (already checked by its rules).
const activityOf = (over: Record<string, unknown> = {}) => ({
  threadId: 'thread-A', readStatus: 'ready', items: [], counts: { approval: 0, failure: 0, running: 0, queued: 0, task: 0 },
  unread: 0, unreadHasMore: false, latestMessageId: null, errors: [], ...over,
});

test('a reply whose end the stream missed (it dropped, the reply ended silently) ends once an activity read asked for after its last sign of life shows nothing running or queued for that cat; older, failed or partial reads keep it open', () => {
  const p = page();
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  p.ev('start');
  const since = p.clock();
  p.live.lost();
  const typing = p.onScreen().children[0];
  const read = (askedAt: number, activity: Any, key = 'bot:Ada') => { p.state.activity = { key, threadId: 'thread-A', askedAt, activity }; p.advance(1000); };
  read(since - 1, activityOf());
  assert.equal(p.live.working(), true, 'a read asked for before the reply began says nothing about it');
  read(p.clock(), activityOf({ readStatus: 'unavailable', errors: [{ source: 'queue', message: '暂时无法确认进度' }] }));
  assert.equal(p.live.working(), true, 'a read that could not see the queue keeps it open');
  read(p.clock(), activityOf({ items: [{ id: 'r', kind: 'running', catId: 'cat-a' }], counts: { approval: 0, failure: 0, running: 1, queued: 0, task: 0 } }));
  assert.equal(p.live.working(), true, 'the cat still runs here');
  read(p.clock(), activityOf({ counts: { approval: 0, failure: 0, running: 1, queued: 0, task: 0 } }));
  assert.equal(p.live.working(), true, 'counted but not listed: whose it is cannot be told');
  read(p.clock(), activityOf(), 'bot:Bob');
  assert.equal(p.live.working(), true, 'another conversation\'s read says nothing about this one');
  read(p.clock(), activityOf({ items: [{ id: 'r', kind: 'running', catId: 'cat-b' }], counts: { approval: 0, failure: 0, running: 1, queued: 0, task: 0 } }));
  assert.equal(p.live.working(), false, 'nothing runs or waits for this cat any more: the reply is over');
  // The transcript, read after that, has nothing for it (it ended silently): its row goes.
  p.live.read([], p.clock() + 1);
  p.live.attach();
  assert.equal(typing.isConnected, false);
  // The next send gets its typing bubble again.
  p.live.expect('cat-a');
  assert.equal(p.onScreen().children.filter(r => r.dataset.wait !== undefined).length, 1);
});

test('a reply the stream missed entirely, already finished in the first read, resolves the send\'s typing bubble it answers (by the message it replies to), without rising in again', () => {
  const p = page();
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  p.live.expect('cat-a').accept('u1');
  const typing = p.onScreen().children[0];
  // A finished reply to another message (the opening greeting) leaves it.
  p.live.read([{ id: 'g1', catId: 'cat-a', inProgress: false, replyTo: 'g0', draft: '你好呀' }], p.clock());
  p.live.attach();
  assert.equal(typing.isConnected, true);
  assert.equal(p.live.working(), true);
  // The finished reply to this send: the bubble's place goes to it.
  p.live.read([{ id: 'm1', catId: 'cat-a', inProgress: false, replyTo: 'u1', draft: '好的' }], p.clock());
  assert.equal(p.live.working(), false, 'Stop is no longer offered');
  const settled = p.msg('m1', '好的');
  p.live.commit(p.inner('bot:Ada', p.msg('u1', '读一下', 'msg user'), settled), []);
  assert.deepEqual(p.onScreen().children.map(r => r.dataset.mid), ['u1', 'm1'], 'no second typing bubble beside the finished reply');
  assert.ok(settled.classList.contains('lv-still'), 'it takes the bubble\'s place without rising in');
  // Without a commit (nothing else changed), the bubble still goes.
  const q = page();
  q.live.select('bot:Ada');
  q.live.commit(q.inner('bot:Ada'), []);
  q.live.expect('cat-a').accept('u1');
  q.live.read([{ id: 'm1', catId: 'cat-a', inProgress: false, replyTo: 'u1', draft: '好的' }], q.clock());
  q.live.attach();
  assert.equal(q.onScreen().children.length, 0);
});

test('a reply in progress takes the send\'s typing bubble only if it answers that send: one answering another message (an opening greeting) gets its own row', () => {
  const p = page();
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  p.live.expect('cat-a').accept('u1');
  const typing = p.onScreen().children[0];
  p.live.read([{ id: 'g1', catId: 'cat-a', inProgress: true, replyTo: 'g0', draft: '你好' }], p.clock());
  assert.equal(typing.dataset.mid, undefined, 'not taken by the greeting');
  p.live.read([{ id: 'g1', catId: 'cat-a', inProgress: true, replyTo: 'g0', draft: '你好' }, { id: 'm1', catId: 'cat-a', inProgress: true, replyTo: 'u1', draft: '' }], p.clock());
  assert.equal(typing.dataset.mid, 'm1', 'taken by the reply to this send');
});

test('a stop clears only the typing bubbles that were waiting when it was asked, in that conversation: a send right after it, here or in another chat, keeps its bubble', () => {
  const p = page();
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  p.live.expect('cat-a').accept('u1');
  const before = p.onScreen().children[0];
  p.live.stopping(true);
  // A send after the stop was asked for (the stop cannot have withdrawn it).
  p.live.expect('cat-a').accept('u2');
  const after = p.onScreen().children[1];
  p.live.stopped();
  p.advance(1600);
  assert.equal(before.isConnected, false, 'the withdrawn send\'s bubble goes');
  assert.equal(after.isConnected, true, 'the later send keeps its bubble');
  // Another chat within the moment the cleanup waits.
  const q = page();
  q.live.select('bot:Ada');
  q.live.commit(q.inner('bot:Ada'), []);
  q.live.expect('cat-a').accept('u1');
  q.live.stopping(true);
  q.live.stopped();
  q.live.select('bot:Bob');
  q.live.commit(q.inner('bot:Bob'), []);
  q.live.expect('cat-b').accept('u9');
  const other = q.onScreen().children[0];
  q.advance(1600);
  assert.equal(other.isConnected, true, 'a stop in one chat never touches another chat\'s bubble');
  assert.equal(q.live.working(), true);
});

test('the send button morphs into stop in place and back; Enter never stops (in stop mode it is not a submit)', () => {
  const p = page();
  const btn = p.h('button', 'send');
  const arrow = p.h('svg', 'icon');
  btn.append(arrow);
  p.live.sendButton(btn, 'stop');
  assert.ok(btn.classList.contains('lv-morph') && btn.classList.contains('lv-stop'));
  assert.equal(btn.type, 'button');
  assert.equal(btn.getAttribute('aria-label'), '停止');
  assert.ok(arrow.classList.contains('lv-go'));
  assert.equal(btn.find('lv-halt').length, 1);
  p.live.sendButton(btn, 'stopping');
  assert.equal(btn.getAttribute('aria-label'), '正在停止');
  p.live.sendButton(btn, 'send');
  assert.equal(btn.type, 'submit');
  assert.equal(btn.getAttribute('aria-label'), '发送');
  assert.ok(!btn.classList.contains('lv-stop'));
  assert.equal(btn.children.length, 2, 'the icons are made once');
});

test('reading further up, 回到最新 appears while a reply is written or something new arrived, with the server\'s unread count; at the end the view follows the words and the pill goes', () => {
  const p = page({ unread: '' });
  p.live.select('bot:Ada');
  p.live.commit(p.inner('bot:Ada'), []);
  const pill = p.dock.find('lv-latest')[0];
  assert.ok(pill, 'mounted above the composer');
  // At the end: words keep the view pinned.
  Object.assign(p.thread, { scrollHeight: 1000, scrollTop: 400 });
  p.ev('start');
  p.ev('text', { text: '一', end: 1 });
  p.frame();
  assert.equal(p.thread.scrollHeight, 1040);
  assert.equal(p.thread.scrollTop, 1040, 'pinned to the end while at the end');
  assert.ok(!pill.classList.contains('on'));
  // Scrolled up: never yanked; the pill offers the way back.
  p.thread.scrollTop = 100;
  p.ev('text', { text: '二', end: 2 });
  p.frame();
  assert.equal(p.thread.scrollTop, 100, 'not moved while reading further up');
  assert.ok(pill.classList.contains('on'));
  assert.equal(pill.tabIndex, 0);
  assert.equal(text(pill), '');
  p.state.unread = '2';
  p.live.rendered({ added: 1, first: false });
  assert.equal(text(pill), '2 条新回复');
  assert.equal(pill.getAttribute('aria-label'), '回到最新，2 条新回复');
  pill.click();
  assert.equal(p.thread.scrollTop, p.thread.scrollHeight);
  assert.ok(!pill.classList.contains('on'));
  assert.equal(pill.getAttribute('aria-hidden'), 'true');
});

test('with reduced motion the quiet line changes at once (no cross-fade); with motion it cross-fades', () => {
  for (const reduce of [true, false]) {
    const p = page({ reduce });
    p.live.select('bot:Ada');
    p.live.commit(p.inner('bot:Ada'), []);
    p.ev('start');
    p.ev('thinking');
    p.frame();
    p.ev('step', { tool: 'Write', target: 'a.md' });
    p.frame();
    const step = stepOf(p.onScreen().children[0]);
    assert.equal(step.children.length, reduce ? 1 : 2, reduce ? 'replaced at once' : 'old out, new in');
    assert.match(text(step), /在写 a\.md$/);
  }
});

// ---------------------------------------------------------------- app.js
function appParts(names: string[], extra = '') {
  const app = read('client/public/app.js');
  const code = names.map(name => {
    const m = new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
    assert.ok(m, name + ' is where the shell keeps it');
    return m[0];
  }).join('') + extra;
  return code;
}

test('the shell hands chat-live.js the raw native draft of in-progress replies, redraws only when a row\'s place changes, and notes a stopped or failed reply under its words', () => {
  const out: Any = {};
  const els: Any[] = [];
  vm.runInNewContext(appParts(['liveRows', 'sigRows', 'endedNote']) + 'out.liveRows = liveRows; out.sigRows = sigRows; out.endedNote = endedNote;', {
    out, presentation: { isActivity: (m: Any) => m.presentation_kind === 'activity' },
    sayText: (m: Any) => m.content, el: (tag: string, cls: string, text: string) => { const e = { tag, cls, text }; els.push(e); return e; },
  });
  const rows = out.liveRows([
    { id: 'u', role: 'user', content: '读一下' },
    { id: 'm', native_message_id: 'm', role: 'assistant', native_cat_id: 'c', in_progress: true, content: '写到', native: { content: '写到一半\n\n[团' } },
    { id: 'r', role: 'assistant', in_progress: true, presentation_kind: 'activity', native: { content: 'x' } },
    { id: 'd', role: 'assistant', content: '好了', status: 'completed' },
  ], false);
  assert.deepEqual(plain(rows), [
    { id: 'm', catId: 'c', inProgress: true, draft: '写到一半\n\n[团', replyTo: '' },
    { id: 'r', catId: '', inProgress: false, draft: 'x', replyTo: '' },
    { id: 'd', catId: '', inProgress: false, draft: '好了', replyTo: '' },
  ], 'the raw draft (its length is the stream\'s position); an execution record is never a live reply');
  assert.deepEqual(plain(out.liveRows([{ id: 'g', kind: 'bot', in_progress: true, text: '群', native_cat_id: 'c', native: { content: '群', replyTo: 'u7' } }, { id: 'p', kind: 'person', text: '你' }], true)),
    [{ id: 'g', catId: 'c', inProgress: true, draft: '群', replyTo: 'u7' }], 'with the owner\'s message it answers (native replyTo)');
  // A growing draft does not change the redraw key; its place, a finish or a new row does.
  const a = out.sigRows([{ id: 'm', role: 'assistant', in_progress: true, content: '写', native: { content: '写' }, tool_calls: [1] }]);
  const b = out.sigRows([{ id: 'm', role: 'assistant', in_progress: true, content: '写到一半', native: { content: '写到一半' }, tool_calls: [2] }]);
  const g1 = out.sigRows([{ id: 'g', kind: 'bot', in_progress: true, text: '群', native: { content: '群' } }]);
  const g2 = out.sigRows([{ id: 'g', kind: 'bot', in_progress: true, text: '群聊里', native: { content: '群聊里' } }]);
  assert.equal(JSON.stringify(g1), JSON.stringify(g2), 'the same in a group');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(out.sigRows([{ id: 'm', content: '写到一半', status: 'completed' }])));
  // An execution record still running is not drawn live: every change of it redraws (review 2026-11-11, finding 6).
  const record = (status: string, events: Any[]) => out.sigRows([{ id: 'x', role: 'assistant', presentation_kind: 'activity', in_progress: true, status, content: '', native: { toolEvents: events } }]);
  const tool = { type: 'tool_use', toolName: 'Bash' };
  assert.notEqual(JSON.stringify(record('processing', [tool])), JSON.stringify(record('processing', [tool, { type: 'tool_result', status: 'error' }])), 'a new tool result shows');
  assert.notEqual(JSON.stringify(record('processing', [tool])), JSON.stringify(record('failed', [tool])), 'a changed status shows');
  const groupRecord = (text: string) => out.sigRows([{ id: 'y', kind: 'bot', presentation_kind: 'activity', in_progress: true, text }]);
  assert.notEqual(JSON.stringify(groupRecord('a')), JSON.stringify(groupRecord('ab')));
  // 已停止 / 这次没完成 under words a reply wrote before it ended that way; never twice.
  const body = { kids: [] as Any[], append(n: Any) { this.kids.push(n); } };
  out.endedNote(body, 'canceled', '写到一半');
  out.endedNote(body, 'failed', '写了一点');
  out.endedNote(body, 'canceled', '已停止');
  out.endedNote(body, 'completed', '写好了');
  out.endedNote(body, 'canceled', '');
  assert.deepEqual(body.kids.map((k: Any) => k.text), ['已停止', '这次没完成']);
});

test('the page loads the live-reply scripts after chat-experience.js and before app.js, its styles last; the shell reads the transcript only for events that change the record and keeps no dead streaming paths', () => {
  const html = read('client/index.html'), app = read('client/public/app.js'), css = read('client/public/chat-live.css');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  const at = (name: string) => scripts.indexOf(name);
  assert.ok(at('chat-experience.js') < at('chat-live-rules.js') && at('chat-live-rules.js') < at('chat-live.js') && at('chat-live.js') < at('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.equal(styles.at(-1), 'chat-live.css');
  // The thread stream: live events drawn, native ones read only when structural, a refused stream reopened.
  assert.match(app, /source\.addEventListener\("live", [\s\S]*?live\.event\(ev\);/);
  assert.match(app, /if \(ev && !liveRules\.structural\(ev\)\) return;/);
  assert.match(app, /if \(liveRules\.gap\(ev\)\) live\.lost\(\);/);
  // Reads hand over drafts before deciding to redraw (both histories); redraws go through the keyed commit.
  assert.equal((app.match(/live\.read\(liveRows\(messages, (true|false)\), requestedAt\);/g) || []).length, 2);
  assert.equal((app.match(/if \(sig === state\.sig\) \{ live\.attach\(\); return; \}/g) || []).length, 2);
  assert.equal((app.match(/live\.commit\(inner, /g) || []).length, 4, 'both histories, drawn or empty');
  const renderers = ['renderMessages', 'renderGroup'].map(name => new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app)![0]).join('');
  assert.doesNotMatch(renderers, /thread\.replaceChildren\(/, 'no history is swapped wholesale any more');
  assert.equal((app.match(/live\.frame\(replyFrame\(m, speaker, (true|false)/g) || []).length, 2, 'in-progress rows in single chats and groups');
  // The send: the typing bubble at once, no 已排队 flash, no stuck header status, no dead stream handlers.
  assert.match(app, /const reply = live\.expect\(/);
  assert.doesNotMatch(app, /announceSend\("已排队"\)|"已排队" : ""|setStatus\("正在回复"\)|function liveBubble|function readSSE|function setWorking|function approvalCard\(|markQueued|event === "part"/);
  // Stop: the existing endpoints, from the button only (never Escape), with a failure said plainly.
  assert.match(app, /await api\(scope \+ "\/stop", \{ method: "POST" \}\);/);
  assert.match(app, /setStatus\("没能停止："/);
  assert.match(app, /live\.sendButton\(send, stop \? \(stopState \? "stopping" : "stop"\) : "send"\);/);
  const escape = /document\.addEventListener\("keydown", \(ev\) => \{\n\s+if \(ev\.key !== "Escape"\) return;[\s\S]*?\n {2}\}\);/.exec(app)![0];
  assert.doesNotMatch(escape, /stop/i);
  // Previews never show a reply still being written: the sidebar's line is the
  // server's activity.last (drafts and replies in progress never count there,
  // docs/chat-experience-api.md), read by chat-list.js; no transcript is read for it.
  assert.match(app, /chatList\.preview\("bot", name\)/);
  assert.match(app, /chatList\.preview\("group", g\.id\)/);
  assert.doesNotMatch(app, /function previewFromMessages|function previewFromGroup|function warmOne|state\.preview/);
  // Only existing tokens.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
