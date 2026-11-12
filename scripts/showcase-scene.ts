// The staged contact list of `npm run showcase`: one cat for each of the engine's
// eight templates (called what the template calls its cat — 宪宪, 砚砚, 烁烁… — with
// its face, its colour and its own tool) and two groups, each chat arranged to
// show one thing the app can do. The conversations are written here, in the
// shapes the pinned engine stores them, and read by the real adapter and the
// real interface; nothing in the product knows about this file.
//
// A cat thinks with its template's tool. The three whose tool the app can connect
// (Claude Code, Codex, Kimi — the showcase's computer has all three) are made
// through the adapter's own creation, as an owner would make them; the other
// five are the engine's own members for their breed, as an engine that has them
// lists them: the app shows and talks to any cat the engine has, it only cannot
// make new ones on those tools. Groups, read positions, the pin and the uploaded
// file go through the adapter's routes. What is typed into a staged chat gets
// that chat's own canned reply (see `live` below), so the ability it shows can be
// tried, not only looked at. The illustrated guide in showcase/ points at these
// chats by name.
import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { NativeCat, NativeMessage } from '../server/native/types.js';
import { catTemplates } from '../tests/native-fixture.js';
import type { PreviewNative } from './preview-fixture.js';

export interface Proposal { feature: 'F139' | 'F221'; title: string; summary: string; detail: Record<string, unknown> }
/** One canned turn: the steps a cat takes, the words it writes and what it attaches. */
export interface Script {
  steps?: Array<[string, Record<string, unknown>]>; reply: string; fail?: boolean | string; think?: number;
  blocks?: Array<Record<string, unknown>>; proposal?: Proposal; files?: Array<{ name: string; mime: string; bytes: Buffer }>;
}

const MIN = 60_000, HOUR = 60 * MIN;
const enc = encodeURIComponent;
const text = (value: string) => Buffer.from(value, 'utf8');

/** A small picture without an image library: 8-bit RGB, one colour per pixel from `paint`. */
function png(width: number, height: number, paint: (x: number, y: number) => number): Buffer {
  const row = width * 3 + 1, raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.writeUIntBE(paint(x, y), y * row + 1 + x * 3, 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), frame = Buffer.alloc(8 + body.length);
    frame.writeUInt32BE(data.length, 0); body.copy(frame, 4); frame.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
    return frame;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** 烁烁's colour draft for the "paper" home page: a page with a title, lines and a red bookmark, and the palette beside it. */
function moodboard(): Buffer {
  const swatches = [0xfffbf2, 0xe9dfc9, 0xc9b79c, 0x8a6f52, 0x3e3229];
  return png(960, 540, (x, y) => {
    if (x >= 430 && x < 462 && y >= 48 && y < 168 && !(y >= 148 && Math.abs(x - 446) < y - 148)) return 0xb5533c;        // the bookmark, with a notch
    if (x >= 72 && x < 520 && y >= 60 && y < 480) {
      if (x < 74 || x >= 518 || y < 62 || y >= 478) return 0xe3d8c3;                                                     // the page's edge
      if (x >= 112 && x < 340 && y >= 112 && y < 138) return 0x3e3229;                                                   // a title
      for (let line = 0; line < 8; line++) if (y >= 176 + line * 34 && y < 186 + line * 34 && x >= 112 && x < 478 - (line % 3) * 64) return 0xc9b79c;
      return 0xfffbf2;
    }
    for (const [index, colour] of swatches.entries()) if ((x - 660) ** 2 + (y - 86 - index * 92) ** 2 < 40 ** 2) return colour;
    if ((x - 810) ** 2 + (y - 270) ** 2 < 62 ** 2) return 0xb5533c;                                                      // the accent
    return 0xf6f0e4;
  });
}

const minutes = `页边 · 周会记录（随手记的）

- 首页改版：大家同意走“纸页感”，烁烁周三前出配色稿
- 导出：先做 Markdown，PDF 放第二版（金哥的建议）
- 保存接口上线前要改两处，砚砚列了清单，周四前改完
- 每周回顾：宪宪给了最小方案，下周开始做
- 读书会这个月读《清单革命》，周六晚 8 点
- 好像还有：备份文件的格式没定；深色模式要单独调一套颜色
`;
const summary = `# 页边 · 周会纪要

## 决定

1. 首页改为“纸页感”，深色模式单独调一套颜色。
2. 导出第一版只做 Markdown，PDF 放到第二版。
3. “每周回顾”按最小方案做，下周开始。

## 待办

| 事项 | 负责 | 时间 |
| --- | --- | --- |
| 首页配色稿 | 烁烁 | 周三 |
| 保存接口的两处修改 | 你 | 周四 |
| 深色模式配色 | 烁烁 | 下周一 |
| 备份文件格式 | 金哥 | 下周三 |
| 读书会《清单革命》 | 大家 | 周六 20:00 |

## 没定的

- 备份文件用 JSON 还是 SQLite 文件。
`;
const todos = `# 待办

- [ ] 首页配色稿（烁烁，周三）
- [ ] 保存接口的两处修改（你，周四）
- [ ] 深色模式配色（烁烁，下周一）
- [ ] 备份文件格式（金哥，下周三）
- [ ] 读书会《清单革命》（大家，周六 20:00）
`;

const weekly = `## 先说结论

最小版本只要三样：**一张回顾页**、**一个每周的触发点**、**三个固定的问题**。别的都可以后加。

### 做法

1. 每周日晚上，把这一周新增的笔记按书归拢；
2. 回顾页只问三件事：*这周记了什么*、*哪一条最想再看一遍*、*下周想读什么*；
3. 回答存成一条普通笔记，带上 \`#每周回顾\` 标签。

### 数据怎么取

\`\`\`ts
const week = notes.filter(note => note.createdAt >= startOfWeek(now));
const byBook = Object.groupBy(week, note => note.bookId);
\`\`\`

| 这一版做 | 先不做 |
| --- | --- |
| 回顾页、三个问题 | 统计图、连续打卡 |
| 每周一次提醒 | 自定义周期 |

要不要我把回顾页的结构也写出来？`;
const reviewed = `async function saveNote(note) {
  const res = await fetch('/api/notes', { method: 'POST', body: JSON.stringify(note) });
  return res.json();
}`;
const patch = `@@ -1,4 +1,8 @@
 async function saveNote(note) {
-  const res = await fetch('/api/notes', { method: 'POST', body: JSON.stringify(note) });
+  const res = await fetch('/api/notes', {
+    method: 'POST',
+    headers: { 'Content-Type': 'application/json' },
+    body: JSON.stringify(note),
+  });
+  if (!res.ok) throw new Error(\`保存失败：\${res.status}\`);
   return res.json();
 }`;

/** Writes one conversation in native's shapes. Times only move forward, whatever hour the showcase is started at. */
class Chat {
  private last = 0; private owner?: NativeMessage;
  readonly list: NativeMessage[];
  constructor(private native: PreviewNative, readonly threadId: string) { this.list = native.messages.get(threadId) ?? []; native.messages.set(threadId, this.list); }
  /** `at`, or just after the previous line when the clock arithmetic would put it earlier. */
  time(at: number) { return this.last = Math.max(at, this.last + 20_000); }
  private push(message: NativeMessage) { this.list.push(message); return message; }
  say(at: number, content: string, more: Partial<NativeMessage> = {}) {
    const time = this.time(at);
    return this.owner = this.push({ id: this.native.id(time), type: 'user', catId: null, timestamp: time, content, ...more });
  }
  reply(cat: NativeCat, at: number, content: string, more: { blocks?: Array<Record<string, unknown>>; status?: string; reason?: string; to?: string; files?: Array<{ name: string; mime: string; bytes: Buffer }> } = {}) {
    const time = this.time(at), invocationId = randomUUID();
    const message = this.push({ id: this.native.id(time), type: 'assistant', catId: cat.id, timestamp: time, content, origin: 'stream', replyTo: more.to ?? this.owner?.id,
      lifecycle: { kind: 'response', status: more.status ?? 'completed', invocationId, completedAt: time, ...(more.reason ? { reason: more.reason } : {}) },
      ...(more.blocks ? { extra: { rich: { v: 1, blocks: more.blocks } } } : {}) });
    for (const file of more.files ?? []) this.native.publish(this.threadId, message, file);
    return message;
  }
  /** A line the engine itself puts into the conversation: a reminder that came due, a member check's refusal. */
  engine(at: number, type: 'connector' | 'system', content: string, source?: Record<string, unknown>) {
    const time = this.time(at);
    return this.push({ id: this.native.id(time), type, catId: null, timestamp: time, content, ...(source ? { source } : {}) });
  }
  /** A request for the owner's yes, about what the owner last said. */
  ask(cat: NativeCat, at: number, proposal: Proposal) { return this.native.propose(this.threadId, cat, proposal, this.time(at), this.owner?.id); }
  answer(item: Record<string, any>, approve: boolean, at: number) { return this.native.decide(item, approve, this.time(at)); }
}

const choice = (id: string, type: 'select' | 'multi-select' | 'confirm', title: string, options: Array<Record<string, unknown>>, more: Record<string, unknown> = {}) =>
  ({ id, kind: 'interactive', v: 1, interactiveType: type, title, options, ...more });
// The staged times are this machine's local times, so the reminders are set in its own time zone.
export const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const schedule = (name: string, expression: string, message = name): Proposal => ({ feature: 'F139', title: '提议新建定时任务', summary: `Create schedule: ${name}`,
  detail: { mutationKind: 'create', message, trigger: { type: 'cron', expression, timezone: zone } } });
const preference = (takeaway: string, quote: string): Proposal => ({ feature: 'F221', title: '提议捕捉品味信号', summary: `Taste [authentic-expression]: ${takeaway}`,
  detail: { takeaway, quote, privacy: 'sensitive' } });

/** A chat's demo line and where it is sent: a cat's own chat or a group, by native id. */
export type Play = { line: string; cat?: string; group?: string };

export async function seedShowcase({ native, base }: { native: PreviewNative; base: string }): Promise<{ plays: Map<string, Play> }> {
  const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const response = await fetch(base + '/xbot-api' + path, { method,
      ...(raw ? { headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(raw) } : body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const now = Date.now(), ago = (ms: number) => now - ms;
  /** `hour:minute` on the calendar day `days` after the day of `from` (negative: before); a day is a calendar day, whatever its length. */
  const on = (from: number, days: number, hour: number, minute = 0) => { const date = new Date(from); date.setDate(date.getDate() + days); date.setHours(hour, minute, 0, 0); return date.getTime(); };
  /** The latest `hour:minute` that is already a little while ago, `days` calendar days further back. */
  const clock = (days: number, hour: number, minute = 0) => {
    let time = on(now, 0, hour, minute);
    if (time > now - 30 * MIN) time = on(time, -1, hour, minute);
    return on(time, -days, hour, minute);
  };

  // One cat per template, called what the template calls its cat, thinking with the template's own tool.
  // The engine's member for a breed whose tool the app cannot connect cats to (id, client and model as the pinned
  // upstream's breed has them): such a cat is made in the engine, and the app lists it and talks to it like any other.
  const engineMade: Record<string, { id: string; clientId: string; defaultModel: string }> = {
    siamese: { id: 'gemini', clientId: 'google', defaultModel: 'Gemini 3.1 Pro (High)' }, dsh: { id: 'dsh', clientId: 'acp', defaultModel: '' },
    'dragon-li': { id: 'glm52', clientId: 'opencode', defaultModel: 'zhipu/glm-5.2' }, bengal: { id: 'antigravity', clientId: 'antigravity', defaultModel: 'gemini-3.1-pro' },
    'golden-chinchilla': { id: 'opencode', clientId: 'opencode', defaultModel: 'claude-opus-4-6' } };
  const cats: Record<string, NativeCat> = {}, threads: Record<string, string> = {};
  for (const [face, breed, roleDescription, personality, teamStrengths, name] of catTemplates) {
    const member = engineMade[face];
    if (member) native.cats.push({ ...member, name, displayName: name, nickname: name, breedId: face, breedDisplayName: breed, isDefaultVariant: true, roleDescription, personality, teamStrengths,
      mentionPatterns: ['@' + name, '@' + member.id], color: native.colour(face), configurationRevision: 'r1', isDefaultResponder: false });
    // Picking the face is all it takes: the cat comes with its own tool (see server/native/agents.ts faceTools).
    else await call('POST', '/bots', { name, simple: { face }, idempotencyKey: randomUUID() });
    cats[face] = native.cats.find(cat => cat.name === name)!;
    threads[face] = (await call('GET', `/bots/${enc(name)}/transcript`)).thread_id;
  }
  const ragdoll = cats.ragdoll!, maine = cats['maine-coon']!, siamese = cats.siamese!, van = cats['turkish-van']!, whale = cats.dsh!, li = cats['dragon-li']!, bengal = cats.bengal!, gold = cats['golden-chinchilla']!;
  const chat = (face: string) => new Chat(native, threads[face]!);
  const read = (scope: string, threadId: string, message: NativeMessage) => call('POST', `${scope}/read`, { expectedThreadId: threadId, messageId: message.id });
  const seen = (cat: NativeCat, room: Chat, message: NativeMessage) => read(`/bots/${enc(cat.name)}`, room.threadId, message);
  const live = new Map<string, (cat: NativeCat, said: string, turn: number) => Script>();
  const steps = (cat: NativeCat, claude: Script['steps'], codex: Script['steps']) => cat.clientId === 'openai' ? codex : claude;

  // ── 宪宪（布偶猫）· 回复是活的：逐字写出、步骤提示、随时停下 ──────────────────────────
  {
    const room = chat('ragdoll'), start = ago(27 * MIN);
    room.say(start, '给「页边」加一个“每周回顾”，最小能做成什么样？');
    room.reply(ragdoll, start + 50_000, weekly);
    room.say(start + 4 * MIN, '把回顾页的结构写出来。');
    room.reply(ragdoll, start + 4 * MIN + 30_000, '回顾页分三块：\n\n1. 顶部是这一周的时间范围和新增笔记数；\n2. 中间按书分组，每本书下面', { status: 'canceled' });
    room.say(start + 5 * MIN, '短一点，只要标题层级。');
    const last = room.reply(ragdoll, ago(21 * MIN), '```text\n每周回顾\n├─ 这一周（日期、笔记数）\n├─ 按书翻一遍\n└─ 三个问题\n```\n\n三块，够了。');
    await seen(ragdoll, room, last);
    await call('POST', `/bots/${enc(ragdoll.name)}/pin`, { pinned: true });
    live.set(room.threadId, cat => ({ think: 900,
      steps: steps(cat, [['Read', { file_path: '/页边/docs/每周回顾.md' }], ['WebSearch', { query: '笔记应用 每周回顾 提醒文案' }], ['Write', { file_path: '/页边/docs/回顾提醒.md', content: '…' }]], []),
      reply: ['## 提醒文案，三个版本', '', '看了现有的方案，也查了几款笔记应用的写法。我的建议是**第二个**。', '',
        '1. **平实**：这一周记了 12 条，翻一遍？', '2. **带一点好奇**：这周有一条笔记，你大概已经忘了。', '3. **只说时间**：周日晚上，回顾一下。', '',
        '### 为什么是第二个', '', '提醒要让人*想点开*，而不是觉得被催。它只说了一件具体的事，也没有用感叹号。', '',
        '```ts', 'const copy = pick(week).length > 0', "  ? '这周有一条笔记，你大概已经忘了。'", "  : '这一周还没记什么，读了点什么吗？';", '```', '',
        '| 版本 | 语气 | 适合 |', '| --- | --- | --- |', '| 平实 | 中性 | 记得多的人 |', '| 带一点好奇 | 轻 | 大多数人 |', '| 只说时间 | 冷 | 不想被打扰的人 |', '',
        '文案我已经写进 `回顾提醒.md`，你改完告诉我一声。'].join('\n') }));
  }

  // ── 砚砚（缅因猫）· 卡片、清单和代码差异，都画在对话里 ────────────────────────────────
  {
    const room = chat('maine-coon'), start = clock(1, 21, 14);
    room.say(start, '上线前帮我看一眼这段：\n\n```js\n' + reviewed + '\n```');
    room.reply(maine, start + 70_000, '直说：能跑，但有两处上线前必须改，一处建议改。', { blocks: [
      { id: 'verdict', kind: 'card', v: 1, title: '审查结论：先改再合', tone: 'warning', bodyMarkdown: '失败时会**静默丢笔记**：请求出错或返回非 2xx，调用的地方拿不到任何提示。',
        fields: [{ label: '必改', value: '2 处' }, { label: '建议', value: '1 处' }, { label: '影响', value: '保存失败时用户不知情' }] },
      { id: 'fixes', kind: 'checklist', v: 1, title: '上线前要改的', items: [{ id: 'a', text: '检查 res.ok，失败时抛出带状态码的错误' }, { id: 'b', text: '请求头加上 Content-Type: application/json' },
        { id: 'c', text: '（建议）保存失败时把笔记留在本地草稿里' }] },
      { id: 'patch', kind: 'diff', v: 1, filePath: 'src/notes/save.js', diff: patch }] });
    room.say(start + 5 * MIN, '前两条改了，第三条下个版本做。');
    const last = room.reply(maine, start + 6 * MIN, '看过了，前两条没问题。第三条我记成后续，别忘了。', { blocks: [
      { id: 'state', kind: 'checklist', v: 1, title: '现在的状态', items: [{ id: 'a', text: '检查 res.ok，失败时抛出带状态码的错误', checked: true },
        { id: 'b', text: '请求头加上 Content-Type: application/json', checked: true }, { id: 'c', text: '保存失败时把笔记留在本地草稿里（下个版本）' }] }] });
    await seen(maine, room, last);
    live.set(room.threadId, cat => ({ think: 700,
      steps: steps(cat, [], [['command_execution', { command: "/bin/zsh -lc 'rg -n \"export\" src/notes'" }], ['command_execution', { command: "/bin/zsh -lc 'sed -n 1,60p src/notes/export.js'" }]]),
      reply: '看了导出那段。只有一处要动，其余可以合。',
      blocks: [{ id: 'verdict-' + randomUUID().slice(0, 6), kind: 'card', v: 1, title: '审查结论：可以合并', tone: 'success', bodyMarkdown: '逻辑清楚，文件名用书名也做了转义。**只差一个空列表的处理。**',
        fields: [{ label: '必改', value: '1 处' }, { label: '建议', value: '0 处' }] },
        { id: 'fixes-' + randomUUID().slice(0, 6), kind: 'checklist', v: 1, title: '合并前', items: [{ id: 'a', text: '一本书没有笔记时，不要生成空文件' }, { id: 'b', text: '文件名里的斜杠已转义', checked: true }] }] }));
  }

  // ── 烁烁（暹罗猫）· 选项直接点；交来的图片就在对话里 ──────────────────────────────────
  {
    const room = chat('siamese'), start = ago(2 * HOUR + 12 * MIN);
    room.say(start, '「页边」的首页想换个感觉，给我几个方向。');
    room.reply(siamese, start + 40_000, '三个方向，点一个我就往下画——', { blocks: [choice('direction', 'select', '首页的感觉', [
      { id: 'paper', label: '纸页感', emoji: '📜', description: '米白的底、衬线的标题，像翻开一本书' }, { id: 'night', label: '夜读', emoji: '🌙', description: '深色、一点暖光，适合晚上看' },
      { id: 'bold', label: '大色块', emoji: '🎨', description: '一屏一个颜色，标题很大' }, { id: 'own', label: '我自己说', customInput: true }],
      { messageTemplate: '我选{selection}', disabled: true, selectedIds: ['paper'] })] });
    room.say(start + 3 * MIN, '我选📜 纸页感');
    room.reply(siamese, start + 4 * MIN, '纸页感！米白的底，衬线的标题，再夹一枚红书签。配色稿在这儿：', { files: [{ name: '首页配色稿.png', mime: 'image/png', bytes: moodboard() }] });
    const last = room.reply(siamese, start + 4 * MIN + 30_000, '首页放哪几块？最多选三个：', { blocks: [choice('sections', 'multi-select', '首页放什么', [
      { id: 'reading', label: '最近在读', emoji: '📖' }, { id: 'weekly', label: '每周回顾', emoji: '🗓️' }, { id: 'quotes', label: '摘抄墙', emoji: '🧱' }, { id: 'time', label: '阅读时长', emoji: '⏱️' }],
      { maxSelect: 3 })] });
    await seen(siamese, room, last);
    live.set(room.threadId, (_cat, said) => /^(?:确认|取消)/.test(said) ? { reply: said.startsWith('确认') ? '开工！第一版今晚给你。' : '好，那我先放着，想好了叫我。' }
      : /^我选/.test(said) ? { reply: '收到，就按这个排。', blocks: [choice('go-' + randomUUID().slice(0, 6), 'confirm', '现在开始画首页', [{ id: '__confirm__', label: '开始' }, { id: '__cancel__', label: '再想想' }])] }
      : { reply: '再来三个方向，这次大胆一点——', blocks: [choice('direction-' + randomUUID().slice(0, 6), 'select', '首页的感觉', [
          { id: 'letter', label: '信纸', emoji: '✉️', description: '横线、手写体的标题' }, { id: 'shelf', label: '书架', emoji: '📚', description: '一排书脊，点开是笔记' },
          { id: 'window', label: '窗边', emoji: '🪟', description: '大留白，一行字一束光' }, { id: 'own', label: '我自己说', customInput: true }], { messageTemplate: '我选{selection}' })] });
  }

  // ── 墨墨（梵花猫）· 发资料，收文件 ──────────────────────────────────────────────────
  {
    const room = chat('turkish-van'), start = ago(4 * HOUR + 5 * MIN);
    const sent = (await call('POST', `/bots/${enc(van.name)}/files?name=${enc('周会记录.txt')}&expectedThreadId=${enc(room.threadId)}`, undefined, text(minutes))).file;
    room.say(start, '这是今天周会的记录，整理成纪要。', { contentBlocks: [{ type: 'context_attachment', attachment: { v: 1, id: sent.id, kind: 'workspace_file', path: sent.path, revision: `sha256:${sent.sha256}` } }] });
    room.reply(van, start + 90_000, '整理好了：三项决定、五条待办，每条都写明了谁负责、什么时候。有一件事会上没定，我单独列在最后。',
      { files: [{ name: '周会纪要.md', mime: 'text/markdown', bytes: text(summary) }] });
    room.say(start + 7 * MIN, '再单独给我一份待办。');
    const last = room.reply(van, start + 8 * MIN, '', { files: [{ name: '待办清单.md', mime: 'text/markdown', bytes: text(todos) }] });
    await seen(van, room, last);
    live.set(room.threadId, (cat, said) => ({ think: 600,
      steps: steps(cat, [], [['command_execution', { command: "/bin/zsh -lc 'cat 周会纪要.md'" }], ['file_change', { status: 'completed', changes: [{ path: '/页边/一页纸.md', kind: { type: 'add' } }] }]]),
      reply: '整理成一页了，放在文件里。',
      files: [{ name: '一页纸.md', mime: 'text/markdown', bytes: text(`# 一页纸\n\n你说的是：${said.slice(0, 200)}\n\n## 三项决定\n\n1. 首页改为“纸页感”。\n2. 导出先做 Markdown。\n3. “每周回顾”下周开始做。\n\n（示例环境里的固定内容。）\n`) }] }));
  }

  // ── 鲸鲸（小鲸鱼）· 说一句就设提醒；到点它在这里叫你 ──────────────────────────────────
  {
    const room = chat('dsh'), nine = clock(0, 9, 0), start = on(nine, -3, 21, 0);
    room.say(start, '以后每天早上 9 点，提醒我看一眼当天的日程。');
    room.reply(whale, start + 30_000, '好。我设一个每天早上 9 点的定时，等你点头。');
    const daily = room.answer(room.ask(whale, start + 40_000, schedule('看当天的日程', '0 9 * * *', '看一眼当天的日程')), true, start + 2 * MIN)!;
    const fired = [on(nine, -1, 9, 0), nine].map((at, index) => {
      const due = room.engine(at, 'connector', '[定时任务] 看一眼当天的日程', { connector: 'scheduler', label: '定时任务' });
      return room.reply(whale, at + 25_000, index ? '早。今天只有一件：14:00 读书会选书。上午是空的。' : '早。今天有两件事：10:30 周会；15:00 和烁烁对首页的配色。', { to: due.id });
    });
    Object.assign(daily, { runStats: { total: 2, delivered: 2, failed: 0, skipped: 0 },
      runs: [nine, on(nine, -1, 9, 0)].map(at => ({ outcome: 'RUN_DELIVERED', scheduled_at: new Date(at).toISOString(), fired_at: new Date(at).toISOString(), started_at: new Date(at).toISOString(), error_summary: null })) });
    daily.lastRun = daily.runs[0];
    await seen(whale, room, fired[1]!);
    // The newest request is still waiting: unread, and listed as 等你确认.
    room.say(ago(9 * MIN), '每周五下午 5 点，再提醒我写周报。');
    room.reply(whale, ago(8 * MIN + 30_000), '可以，每周五 17:00。这个也等你确认。');
    room.ask(whale, ago(8 * MIN + 20_000), schedule('写周报', '0 17 * * 5', '该写周报了'));
    live.set(room.threadId, (_cat, said) => ({ reply: '可以。我先按「每天 22:00」设一个，等你点头。想换个时间，就在我资料的「定时」里把它删掉，再跟我说一遍。',
      proposal: schedule(said.replace(/\s+/g, ' ').slice(0, 16), '0 22 * * *', said.replace(/\s+/g, ' ').slice(0, 60)) }));
  }

  // ── 小狸花（狸花猫）· 要记住的事先问你；记住了什么，资料页里看得到 ────────────────────────
  {
    const room = chat('dragon-li'), start = clock(2, 20, 30), later = clock(1, 22, 5);
    const first = room.say(start, '以后回答我，先说结论，再给依据。');
    room.reply(li, start + 30_000, '明白：先结论，后依据。这一条我想记下来，等你点头。');
    room.answer(room.ask(li, start + 40_000, preference('回答时先说结论，再给依据', first.content)), true, start + 90_000);
    room.say(start + 4 * MIN, '猫为什么喜欢钻纸箱？');
    room.reply(li, start + 5 * MIN, '**结论：纸箱让猫觉得安全。**\n\n依据有三条：\n\n1. 四面围合，能藏身，也能看着外面；\n2. 瓦楞纸保温，趴着暖和；\n3. 对猫来说是新东西，可以挠，可以啃。');
    const second = room.say(later, '还有，引用资料的时候带上出处。');
    room.reply(li, later + 30_000, '好。这一条也想记下来。');
    const open = room.ask(li, later + 40_000, preference('引用资料时带上出处', second.content));
    await seen(li, room, room.list.find(message => message.id === open.navigation.approvalCardRef.messageId)!);
    native.notes.set(room.threadId, [{ key: 'note-showcase', value: '「页边」首页定了纸页感；导出先做 Markdown。', updatedAt: later }]);
    live.set(room.threadId, (_cat, said) => /以后|记住|不要|总是|每次/.test(said)
      ? { reply: '好。这一条我想记下来，等你点头。', proposal: preference(said.replace(/\s+/g, ' ').slice(0, 60), said.slice(0, 60)) }
      : { reply: '**结论：先小范围试，再决定要不要做大。**\n\n依据：\n\n1. 试一次的成本低，一周就能看到有没有人用；\n2. 做大之后再改方向，代价是现在的好几倍。\n\n出处：这是示例环境里的固定回答，没有引用外部资料。' });
  }

  // ── 斑斑（孟加拉猫）· 没做完的，如实说：没完成、被打断、暂时显示不了 ──────────────────────
  {
    const room = chat('bengal'), start = clock(2, 16, 40);
    room.say(start, '给「页边」画一张启动图，再录一段 10 秒的操作演示。');
    room.reply(bengal, start + 2 * MIN, '', { status: 'failed', reason: 'timeout' });
    room.say(start + 3 * MIN, '那先只画启动图。');
    room.reply(bengal, start + 4 * MIN, '来了来了！启动图我想这样画：一只猫趴在摊开的书上，书页的边上', { status: 'interrupted', reason: 'process_restart' });
    room.say(start + 9 * MIN, '继续。');
    const last = room.reply(bengal, start + 11 * MIN, '画好了，第一稿的说明在卡片里；我还录了一段语音讲解。', { blocks: [
      { id: 'draft', kind: 'card', v: 1, title: '启动图 · 第 1 稿', tone: 'success', bodyMarkdown: '一只猫趴在摊开的书上，页边写满了批注。主色取自首页的纸页感配色。',
        fields: [{ label: '尺寸', value: '1290 × 2796' }, { label: '格式', value: 'PNG' }] },
      { id: 'voice', kind: 'audio', v: 1, url: '/uploads/preview/voice-note.mp3', title: '语音讲解' }] });
    await seen(bengal, room, last);
    // Every other try fails, so 再发一次 can be seen doing its job.
    live.set(room.threadId, (_cat, _said, turn) => turn % 2 ? { think: 1500, reply: '我试试看…', fail: 'timeout' }
      : { think: 900, reply: '这次成了！第二稿把猫挪到了书页的右下角，左上留给应用的名字。', blocks: [{ id: 'draft-' + randomUUID().slice(0, 6), kind: 'card', v: 1, title: '启动图 · 第 2 稿', tone: 'success',
          bodyMarkdown: '猫在右下角，书页占满全屏，名字压在左上。', fields: [{ label: '尺寸', value: '1290 × 2796' }, { label: '格式', value: 'PNG' }] }] });
  }

  // ── 金哥（金渐层）· 找得到：往上翻更早的消息、引用、搜索；还有一段之前的对话 ─────────────────
  {
    // An earlier conversation, kept under 历史对话.
    const old = chat('golden-chinchilla'), before = clock(16, 20, 10);
    old.say(before, '帮我列一个 11 月的阅读计划，三本就好。');
    old.reply(gold, before + 60_000, '三本，一本一种读法：\n\n1. 《清单革命》——薄，先读，一周读完；\n2. 《人月神话》——每天一章，配合你正在做的东西；\n3. 《悉达多》——留到月底，慢慢读。');
    old.say(before + 3 * MIN, '第三本换成非虚构的。');
    await seen(gold, old, old.reply(gold, before + 4 * MIN, '那就《置身事内》。章节独立，随时能放下。'));
    threads['golden-chinchilla'] = (await call('POST', `/bots/${enc(gold.name)}/new`, { expectedThreadId: old.threadId })).conversation_id;
    const room = chat('golden-chinchilla'), day = (n: number, minute = 0) => clock(n, 21, 5) + minute * MIN;
    native.pageLimits.set(room.threadId, 10);
    room.say(day(9), '「页边」的第一版，先做哪三件事？');
    room.reply(gold, day(9, 1), '记一条、找得到、导得出。别的都排在后面。');
    room.say(day(9, 3), '记一条要多快？');
    room.reply(gold, day(9, 4), '从打开到写完第一句，不超过三秒。所以首页就是输入框。');
    room.say(day(8), '标签要不要做层级？');
    room.reply(gold, day(8, 1), '先不做。平铺的标签加上搜索，够用到一千条笔记。');
    const format = room.say(day(8, 4), '导出格式定 Markdown 还是 PDF？');
    room.reply(gold, day(8, 5), '我先看看两边各要做多久，晚点给你结论。');
    room.say(day(8, 9), '搜索用什么做？');
    const fts = room.reply(gold, day(8, 10), '本地全文索引就行：SQLite 的 FTS5，不用另起服务。');
    room.reply(gold, day(7), '导出先做 Markdown：一天能做完，用户还能拿去别的工具里用。PDF 排进第二版。', { to: format.id });
    room.say(day(7, 6), '好，就 Markdown。');
    room.reply(gold, day(7, 7), '记下了。导出按书分文件，文件名用书名。');
    room.say(day(6), '摘抄和自己的想法，要分开存吗？');
    room.reply(gold, day(6, 1), '分开。摘抄是别人的话，想法是你的；回顾的时候只翻想法，会很有用。');
    room.say(day(6, 5), '同步呢？');
    room.reply(gold, day(6, 6), '第一版不做同步，只做本地备份文件。同步是个大坑，等真有人要再说。');
    room.say(day(5), '中文分词怎么办？', { replyTo: fts.id });
    room.reply(gold, day(5, 1), '用 trigram 分词器：三个字一组，中文、英文都能搜。索引会大一点，但省心。');
    room.say(day(5, 4), '行，这周先把“记一条”做完。');
    await seen(gold, room, room.reply(gold, day(5, 5), '好。做完叫我，我来过一遍。'));
    live.set(room.threadId, () => ({ think: 2500, reply: '稳着呢。“记一条”做完了，“找得到”做了一半：搜索能用，还差按书筛选。\n\n往上翻，能看到我们最早定的那三件事。' }));
  }

  // ── 产品评审（群）· 直接说由一只接待；@ 谁谁答；各有各的颜色 ────────────────────────
  const plays = new Map<string, Play>();
  {
    const name = '产品评审', group = await call('POST', '/groups', { name, members: [ragdoll.name, maine.name, siamese.name], idempotencyKey: randomUUID() });
    const room = new Chat(native, group.id), start = clock(1, 15, 20);
    room.say(start, '首页要改成纸页感，结构上有什么要注意的？');
    room.reply(ragdoll, start + 50_000, '我来接。结构不用动：输入框还在最上面，只换底色和字体。要留意的是深色模式，纸页感在深色下容易发灰，得单独调一套颜色。');
    room.say(start + 3 * MIN, `@${maine.name} 质量上呢？`);
    const upTo = room.reply(maine, start + 4 * MIN, '两点。第一，换字体会拖慢首屏：衬线字体要做子集，不然多出 2 MB。第二，对比度要过 4.5:1，米白的底配浅棕的字过不了。');
    room.say(start + 6 * MIN, `@${gold.name} 你怎么看？`);
    room.engine(start + 6 * MIN + 5_000, 'system', `Error: Member ${gold.id} is not in the execution roster of thread ${group.id}`);
    room.say(ago(6 * MIN), `@${ragdoll.name} @${maine.name} @${siamese.name} 各用一句话：上线前最担心什么？`);
    room.reply(ragdoll, ago(5 * MIN + 20_000), '深色模式没调好就上线。');
    room.reply(maine, ago(5 * MIN), '字体文件太大，首屏变慢。');
    room.reply(siamese, ago(4 * MIN + 30_000), '怕大家嫌它太素——所以我夹了一枚红书签！🔖');
    await read(`/groups/${enc(group.id)}`, group.id, upTo);
    const lines: Record<string, string[]> = { [ragdoll.id]: ['我会先把深色那套颜色定下来，别的都好改。', '结构我再过一遍，明天给结论。'],
      [maine.id]: ['字体子集。不做这个，别的优化都白搭。', '先把对比度的问题改了再说。'], [siamese.id]: ['标题再大一号！翻开第一眼就得是它。', '红书签要不要会动？我想让它轻轻晃一下。'] };
    live.set(group.id, (cat, _said, turn) => ({ think: 400 + (turn % 3) * 500, reply: lines[cat.id]![Math.floor((turn - 1) / 3) % 2]! }));
    plays.set(name, { group: group.id, line: `@${ragdoll.name} @${maine.name} @${siamese.name} 各说一句：今天最想改哪里？` });
  }

  // ── 读书会（群）· 四只猫的群；群里也能投票 ────────────────────────────────────
  {
    const name = '读书会', members = [whale, li, van, gold];
    const group = await call('POST', '/groups', { name, members: members.map(cat => cat.name), idempotencyKey: randomUUID() });
    const room = new Chat(native, group.id), start = clock(3, 20, 0);
    room.say(start, `${members.map(cat => '@' + cat.name).join(' ')} 这个月读书会读什么？各提一本，说一句理由。`);
    room.reply(whale, start + 40_000, '《思考，快与慢》。读书会上最常吵的就是“直觉靠不靠谱”，这本正好当裁判。');
    room.reply(li, start + 55_000, '《枪炮、病菌与钢铁》。每个结论后面都跟着证据，适合一起挑刺。');
    room.reply(van, start + 70_000, '《清单革命》。薄，一周能读完，读完就能用上。');
    room.reply(gold, start + 85_000, '《人月神话》。老书，但你们正在做产品，会读出新东西。');
    room.say(start + 4 * MIN, '投票吧。');
    room.reply(whale, start + 5 * MIN, '那就在这儿投：', { blocks: [choice('vote', 'select', '这个月读哪一本', [{ id: 'fast', label: '《思考，快与慢》' }, { id: 'guns', label: '《枪炮、病菌与钢铁》' },
      { id: 'list', label: '《清单革命》' }, { id: 'month', label: '《人月神话》' }], { disabled: true, selectedIds: ['list'] })] });
    room.say(start + 6 * MIN, '我选了：《清单革命》（这个月读哪一本）');
    await read(`/groups/${enc(group.id)}`, group.id, room.reply(whale, start + 7 * MIN, '定了，《清单革命》。周六晚上 8 点，我提前一天提醒大家。'));
    const lines: Record<string, string> = { [whale.id]: '下次是周六晚上 8 点，读《清单革命》的前三章。', [li.id]: '我带了三条想挑刺的地方，到时候说。',
      [van.id]: '我已经读完了，做了一页笔记，会前发给大家。', [gold.id]: '我负责计时，每人五分钟。' };
    live.set(group.id, cat => ({ reply: lines[cat.id]! }));
    plays.set(name, { group: group.id, line: `@${whale.name} 下次读书会是什么时候？` });
  }

  // What the owner's profile already holds (read-only in the app, kept by the engine): native's opening capsule, under native's own title.
  native.memoryViews.profile = { readStatus: 'ready', entries: [{ id: 'capsule', type: 'profile', layer: 'capsule', title: '开场简介', status: 'active', proposals: [], updatedAt: clock(4, 19, 0),
    content: '在做一款叫「页边」的读书笔记应用。\n习惯晚上读书；每个月和朋友办一次读书会。\n喜欢先听结论。',
    revision: 'sha256:' + '0'.repeat(63) + '1' }] };

  // Each chat's own canned reply. The first one that goes through in a chat — a single chat or a group — says plainly that it is canned.
  const turns = new Map<string, number>(), told = new Set<string>();
  native.scene = (threadId, cat, said) => {
    const make = live.get(threadId);
    if (!make) return undefined;
    const turn = (turns.get(threadId) ?? 0) + 1; turns.set(threadId, turn);
    const script = make(cat, said, turn);
    if (script.fail || told.has(threadId)) return script;
    told.add(threadId);
    return { ...script, reply: script.reply + '\n\n（这里是示例环境，回复是预先写好的。）' };
  };
  for (const [face, line] of Object.entries({ ragdoll: '把“每周回顾”的提醒文案也想一版。', 'maine-coon': '再帮我看一眼导出的那段。', siamese: '再给我几个方向。',
    'turkish-van': '把上面的决定整理成一页。', dsh: '每天晚上 10 点提醒我记一条读书笔记。', 'dragon-li': '以后给我的建议不要超过三条。',
    bengal: '再画一版启动图。', 'golden-chinchilla': '这周进度怎么样？' })) plays.set(cats[face]!.name, { line, cat: cats[face]!.id });
  return { plays };
}
