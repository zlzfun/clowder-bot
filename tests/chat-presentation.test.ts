import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Message presentation runs here as the classic browser script it is, in a VM
// with a tiny DOM, the way frontend-agents.test.ts loads agents.js.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

class El {
  children: El[] = []; parent: El | null = null; className = ''; text = ''; open = false;
  dataset: Record<string, string> = {}; listeners: Record<string, Array<() => void>> = {};
  constructor(readonly tag: string) {}
  append(...nodes: Array<El | string>) {
    for (const item of nodes) {
      const child = typeof item === 'string' ? Object.assign(new El('#text'), { text: item }) : item;
      child.parent = this; this.children.push(child);
    }
  }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ||= []).push(fn); }
  // Tool details are literal text: any HTML parsing would be a defect.
  set innerHTML(_value: string) { throw new Error('innerHTML is not used'); }
  // What the browser does after the owner clicks a <summary>: its <details> toggles.
  click() {
    const details = this.parent!;
    assert.equal(this.tag, 'summary'); assert.equal(details.tag, 'details');
    details.open = !details.open;
    for (const fn of details.listeners.toggle ?? []) fn();
  }
}
const all = (root: El): El[] => root.children.flatMap(c => [c, ...all(c)]);
const byClass = (root: El, cls: string) => all(root).find(n => n.className.split(' ').includes(cls));

const window: any = {};
vm.runInNewContext(read('client/public/chat-presentation.js'), { window, document: { createElement: (tag: string) => new El(tag) } });
const P = window.ClowderPresentation;

const xianxian = { id: 'cat-a', name: '宪宪', templateId: 'ragdoll', avatar: 'generated', avatar_seed: 'cat:ragdoll', avatar_url: '' };
const yanyan = { id: 'cat-b', name: '砚砚', templateId: 'maine-coon', avatar: 'custom', avatar_seed: 'cat:maine-coon', avatar_url: '/xbot-api/bots/%E7%A0%9A%E7%A0%9A/avatar?v=2' };

function line(m: Record<string, unknown>, open = new Set<string>()) {
  const faces: unknown[] = [], drawn: string[] = [];
  const row: El = P.activityLine(m, {
    open,
    face: (who: unknown) => { faces.push(plain(who)); return new El('span'); },
    render: (parent: El, text: string) => { drawn.push(text); parent.append(text); },
  });
  return { row, faces, drawn, open, summary: row.children[0], drawer: row.children[1] };
}

test('only the server presentation_kind makes an execution record; text is never read', () => {
  assert.equal(P.isActivity({ role: 'assistant', presentation_kind: 'activity', content: '' }), true);
  for (const m of [
    { role: 'assistant', presentation_kind: 'message', content: '执行过程' },
    { role: 'assistant', content: '完成报告' },
    { kind: 'bot', sender: '宪宪', text: 'activity' },
    null,
  ]) assert.equal(P.isActivity(m), false);
});

test('each line speaks for its own cat: native IDs keep same-named cats apart, unknown speakers get no cat face', () => {
  const a = P.speaker({ role: 'assistant', name: '宪宪', speaker: xianxian, native_cat_id: 'cat-a' });
  assert.deepEqual(plain(a), { key: 'bot:cat:cat-a', id: 'cat-a', name: '宪宪',
    paint: { url: '', seed: 'cat:ragdoll', templateId: 'ragdoll', avatar: 'generated', botName: '宪宪' } });
  const b = P.speaker({ role: 'assistant', name: '砚砚', speaker: yanyan, native_cat_id: 'cat-b' });
  assert.equal(b.key, 'bot:cat:cat-b');
  assert.equal(b.paint.url, yanyan.avatar_url);
  // A renamed or same-named second cat is still a different sender.
  const twin = P.speaker({ role: 'assistant', name: '宪宪', speaker: { ...xianxian, id: 'cat-c' }, native_cat_id: 'cat-c' });
  assert.notEqual(twin.key, a.key);
  assert.equal(P.speaker({ name: '宪宪', speaker: xianxian, native_cat_id: 'cat-a' }).key, a.key);
  // Group rows carry the same identity next to their sender string.
  assert.equal(P.speaker({ kind: 'bot', sender: '砚砚', speaker: yanyan, native_cat_id: 'cat-b' }).key, b.key);

  const removed = P.speaker({ role: 'assistant', name: 'cat-gone', speaker: null, native_cat_id: 'cat-gone' });
  assert.deepEqual(plain(removed), { key: 'bot:cat:cat-gone', id: 'cat-gone', name: 'cat-gone', paint: null });
  const system = P.speaker({ role: 'assistant', name: '系统', speaker: null, native_cat_id: null });
  assert.equal(system.paint, null);
  assert.equal(system.name, '系统');
  assert.notEqual(system.key, a.key);
  assert.equal(P.speaker({ role: 'assistant' }).name, '系统');
});

test('execution status words follow the native lifecycle and claim nothing for unknown values', () => {
  const words = Object.fromEntries(['queued', 'processing', 'completed', 'complete', 'failed', 'canceled', 'cancelled', 'interrupted', 'mystery', undefined]
    .map(s => [String(s), [P.activityStatus(s).text, P.activityStatus(s).tone]]));
  assert.deepEqual(words, {
    queued: ['排队中', 'busy'], processing: ['进行中', 'busy'], completed: ['已完成', 'done'], complete: ['已完成', 'done'],
    failed: ['失败', 'failed'], canceled: ['已停止', 'stopped'], cancelled: ['已停止', 'stopped'], interrupted: ['已中断', 'stopped'],
    mystery: ['状态未知', 'unknown'], undefined: ['状态未知', 'unknown'],
  });
});

test('an execution record is a folded line in its writer\'s name that opens onto the whole content', () => {
  const content = '先处理 A。\n\n用户又发来 B 任务：…\n\n## 完成报告\n- A 完成\n- B 完成';
  const m = { seq: 3, id: 'msg-activity', role: 'assistant', presentation_kind: 'activity', status: 'processing', time: '2026-11-02T01:00:00.000Z',
    content, name: '宪宪', speaker: xianxian, native_cat_id: 'cat-a' };
  const first = line(m);
  assert.equal(first.row.tag, 'details');
  assert.ok(first.row.className.split(' ').includes('routine-line'));
  assert.equal(first.row.open, false, 'folded by default');
  assert.deepEqual(plain(first.row.dataset), { id: 'msg-activity', seq: '3', time: '2026-11-02T01:00:00.000Z' });
  assert.equal(first.summary.tag, 'summary');
  assert.equal(byClass(first.summary, 'label')!.textContent, '宪宪 · 执行过程 · 进行中');
  assert.equal((first.faces[0] as { key: string }).key, 'bot:cat:cat-a', 'the real cat, not the open chat');
  assert.deepEqual(first.drawn, [], 'nothing is drawn while folded');
  assert.equal(first.drawer.textContent, '');

  first.summary.click();
  assert.equal(first.row.open, true);
  assert.deepEqual(first.drawn, [content], 'the whole content, unchanged');
  assert.equal(first.drawer.textContent, content);
  assert.ok(first.open.has(P.activityKey(m)));

  // A refresh redraws the grown record: it stays open by its message ID.
  const grown = { ...m, status: 'completed', content: content + '\n- 已提交' };
  const again = line(grown, first.open);
  assert.equal(again.row.open, true);
  assert.deepEqual(again.drawn, [grown.content]);
  assert.equal(byClass(again.summary, 'label')!.textContent, '宪宪 · 执行过程 · 已完成');
  again.summary.click();
  assert.equal(first.open.has(P.activityKey(m)), false);
  assert.equal(line(grown, first.open).row.open, false);
  // Another record is not opened by this one.
  assert.equal(line({ ...m, id: 'msg-other', seq: 9 }, first.open).row.open, false);
});

test('group records use their text; failed and unknown-speaker records say so', () => {
  const failed = line({ id: 'g-1', kind: 'bot', sender: '砚砚', text: '跑测试…', presentation_kind: 'activity', status: 'failed', speaker: yanyan, native_cat_id: 'cat-b' });
  assert.ok(failed.row.className.split(' ').includes('failed'));
  assert.equal(byClass(failed.summary, 'label')!.textContent, '砚砚 · 执行过程 · 失败');
  failed.summary.click();
  assert.deepEqual(failed.drawn, ['跑测试…']);

  const unknown = line({ id: 'g-2', role: 'assistant', name: '系统', presentation_kind: 'activity', status: 'processing', speaker: null, native_cat_id: null, content: 'x' });
  assert.equal((unknown.faces[0] as { paint: unknown }).paint, null);
  assert.equal(byClass(unknown.summary, 'label')!.textContent, '系统 · 执行过程 · 进行中');
});

// The saved record behind the empty drawer (.runtime/activity-empty-20261105):
// a completed run whose content and native content are empty, and whose native
// tool events are its only record. Fields as stored, tracing omitted.
const researcher = { id: 'bot-9f39e198-93f', name: '研究员-b7191893', templateId: 'ragdoll', avatar: 'generated', avatar_seed: 'cat:ragdoll', avatar_url: '' };
const postUse = (id: string, use: string, content: string) => ({ id, executionRef: 'd8f6a3b7-79d4-4a85-9197-56f98c7cf2ad', type: 'tool_use',
  label: 'bot-9f39e198-93f → mcp:cat-cafe-collab/cat_cafe_post_message', toolName: 'mcp:cat-cafe-collab/cat_cafe_post_message',
  detail: JSON.stringify({ content }), timestamp: 1793761945696, toolUseId: use, startTimeMs: 1793761945696 });
const result = (id: string, use: string, detail: string, status?: string) => ({ id, executionRef: 'd8f6a3b7-79d4-4a85-9197-56f98c7cf2ad', type: 'tool_result',
  label: 'bot-9f39e198-93f ← result', detail, timestamp: 1793761945710, toolUseId: use, ...(status === undefined ? {} : { status }), endTimeMs: 1793761945710 });
const posted = (messageId: string) => 'mcp:cat-cafe-collab/cat_cafe_post_message (completed)\n' + JSON.stringify({ status: 'ok',
  threadId: 'thread_owned_3acc108bc398b785f68350628affa6c2d80e8bb4', messageId, routed: [], replyTo: '0001793761924380-000018-2f26ec09', message: '消息已存储。' });
const savedEvents = [
  postUse('tool-a1879c18-ecbc-4524-a249-a73a9761de7d', 'exec-49c9e134-22e1-4341-83fb-f00991fb56fb', '我会读取附件中的标识。'),
  result('toolr-dc9978b8-81c7-46f4-b3cf-f2d9639996a2', 'exec-49c9e134-22e1-4341-83fb-f00991fb56fb', posted('0001793761945702-000020-6a560f01'), 'ok'),
  { id: 'tool-9df3372d-1ab7-48e8-ab7d-804bc5433f1c', executionRef: 'd8f6a3b7-79d4-4a85-9197-56f98c7cf2ad', type: 'tool_use', label: 'bot-9f39e198-93f → command_execution',
    toolName: 'command_execution', detail: JSON.stringify({ command: "/bin/zsh -c 'cat .clowder-bot-files/e8467d5e-4694-45a9-9fc1-41e04a894f81/workspace-ui-attachment.txt'" }),
    timestamp: 1793761945822, toolUseId: 'exec-334d5cf0-ea72-45aa-9af4-febc3d22bb1c', startTimeMs: 1793761945822 },
  result('toolr-ed75bcde-0b42-4e68-ac15-751e39822b9a', 'exec-334d5cf0-ea72-45aa-9af4-febc3d22bb1c',
    "command: /bin/zsh -c 'cat .clowder-bot-files/e8467d5e-4694-45a9-9fc1-41e04a894f81/workspace-ui-attachment.txt'\nstatus: completed\nexit_code: 0\nUI_WORKSPACE_ACCEPTANCE_20261104\n这是聊天附件界面验收用的普通文本。", 'ok'),
  postUse('tool-97ade2a8-73f3-4cab-aa18-c6d0feaccdae', 'exec-0be340eb-97fa-439f-bb9d-fcf98aa7b13c', 'UI_WORKSPACE_ACCEPTANCE_20261104\n\n[研究员-b7191893/GPT-6🐾]'),
  result('toolr-f940fd60-2da2-4ff9-a6f5-f40629cd7562', 'exec-0be340eb-97fa-439f-bb9d-fcf98aa7b13c', posted('0001793761949190-000021-f61d7dcb'), 'ok'),
];
const saved = (events: unknown[] = savedEvents, extra: Record<string, unknown> = {}) => ({
  seq: 11, id: '0001793761924419-000019-63a9a0b1', native_message_id: '0001793761924419-000019-63a9a0b1', role: 'assistant', content: '',
  presentation_kind: 'activity', speaker: researcher, native_cat_id: researcher.id, name: researcher.name, time: '2026-11-04T03:12:04.419Z',
  reply_to: 9, status: 'completed', attachments: [],
  native: { id: '0001793761924419-000019-63a9a0b1', type: 'assistant', catId: researcher.id, content: '', lifecycle: { kind: 'response', status: 'completed' }, toolEvents: events },
  ...extra,
});
const entries = (row: El) => byClass(row, 'activity-tools')?.children ?? [];
const entryView = (item: El) => ({ name: byClass(item, 'trace-call-name')?.textContent ?? null,
  pre: item.children.filter(c => c.tag === 'pre').map(c => [c.className, c.textContent]) });

test('a record with empty prose opens onto its native tool events, each one as recorded and in order', () => {
  const m = saved();
  const first = line(m);
  assert.equal(first.row.tag, 'details');
  assert.equal(first.summary.tag, 'summary');
  assert.equal(byClass(first.summary, 'label')!.textContent, '研究员-b7191893 · 执行过程 · 已完成');
  assert.equal(first.row.open, false);
  assert.equal(byClass(first.row, 'activity-tools'), undefined, 'nothing is drawn while folded');

  first.summary.click();
  assert.deepEqual(first.drawn, [], 'no empty prose is rendered');
  assert.deepEqual(entries(first.row).map(entryView), savedEvents.map(e => ({
    name: e.type === 'tool_use' ? (e as { toolName: string }).toolName : '结果 · 成功',
    pre: [[e.type === 'tool_use' ? 'trace-args' : 'trace-out', e.detail]],
  })), 'every event, in its stored order, with its whole detail');
  assert.equal(entries(first.row)[3].children[1].textContent.includes('UI_WORKSPACE_ACCEPTANCE_20261104'), true);
  for (const item of entries(first.row).filter((_, i) => i % 2)) assert.equal(byClass(item, 'tool-state')!.className, 'tool-state done');
  assert.ok(first.open.has(P.activityKey(m)));

  // Group rows carry the same native record next to their text.
  const group = line({ id: m.id, kind: 'bot', sender: researcher.name, text: '', presentation_kind: 'activity', status: 'completed', speaker: researcher, native_cat_id: researcher.id, native: m.native });
  group.summary.click();
  assert.equal(entries(group.row).length, 6);
});

test('each tool result keeps its own status: a completed run does not make every tool succeed', () => {
  const events = [
    { id: 'u1', type: 'tool_use', label: 'bot-x → command_execution', toolName: 'command_execution', detail: '{"command":"npm test"}', toolUseId: 'e1' },
    { id: 'r1', type: 'tool_result', label: 'bot-x ← result', detail: 'command: npm test\nstatus: failed\nexit_code: 1', toolUseId: 'e1', status: 'error' },
    { id: 'r2', type: 'tool_result', label: 'bot-x ← result', detail: 'no status recorded', toolUseId: 'e2' },
    { id: 'r3', type: 'tool_result', label: 'bot-x ← result', detail: 'odd', toolUseId: 'e3', status: 'mystery' },
    { id: 'u4', type: 'tool_use', label: 'bot-x → read_file', detail: '{"path":"a"}' },
  ];
  const view = line(saved(events));
  view.summary.click();
  assert.deepEqual(entries(view.row).map(e => byClass(e, 'trace-call-name')!.textContent),
    ['command_execution', '结果 · 失败', '结果', '结果 · 状态未知', 'bot-x → read_file']);
  assert.equal(byClass(entries(view.row)[1], 'tool-state')!.className, 'tool-state failed');
  assert.equal(byClass(entries(view.row)[2], 'tool-state'), undefined, 'a missing status stays neutral');
  assert.equal(byClass(view.summary, 'label')!.textContent, '研究员-b7191893 · 执行过程 · 已完成');
});

test('prose shows first, as before, and the tool events follow it', () => {
  const view = line(saved(savedEvents.slice(0, 2), { content: '先读附件。' }));
  view.summary.click();
  assert.deepEqual(view.drawn, ['先读附件。']);
  assert.deepEqual(view.drawer.children.map(c => [c.tag, c.textContent.slice(0, 5)]), [['#text', '先读附件。'], ['div', 'mcp:c']]);
  assert.equal(view.drawer.children[1].className, 'activity-tools');
  assert.equal(entries(view.row).length, 2);
});

test('with neither prose nor a usable tool event the status is a plain line with nothing to open', () => {
  const open = new Set<string>();
  const shapes = [
    saved([]),
    saved([], { content: '  \n\t' }),
    saved([null, 'x', { id: 'blank', type: 'tool_result', label: '  ', detail: '\n', status: 'ok' }]),
    { ...saved(), native: undefined },
    { id: 'g-3', kind: 'bot', sender: '砚砚', text: ' ', presentation_kind: 'activity', status: 'processing', speaker: yanyan, native_cat_id: 'cat-b', native: { content: '', toolEvents: [] } },
  ];
  for (const m of shapes) {
    open.add(P.activityKey(m));
    const view = line(m, open);
    assert.equal(view.row.tag, 'div', 'not a details element');
    assert.deepEqual(view.row.children.map(c => [c.tag, c.className]), [['div', 'sysline']], 'no summary and no drawer');
    assert.deepEqual(view.row.listeners, {});
    assert.equal(view.row.dataset.id, String(m.id), 'still found by its message ID on redraw');
    assert.deepEqual(view.drawn, []);
  }
  assert.equal(byClass(line(shapes[0]).row, 'label')!.textContent, '研究员-b7191893 · 执行过程 · 已完成');
  assert.equal(byClass(line(shapes[4]).row, 'label')!.textContent, '砚砚 · 执行过程 · 进行中');
});

test('a running record gains its drawer on refresh and stays open by message ID as events arrive', () => {
  const open = new Set<string>();
  const running = (events: unknown[]) => saved(events, { status: 'processing' });
  const empty = line(running([]), open);
  assert.equal(empty.row.tag, 'div');

  const some = line(running(savedEvents.slice(0, 2)), open);
  assert.equal(some.row.tag, 'details');
  assert.equal(some.row.open, false);
  assert.equal(some.row.dataset.id, empty.row.dataset.id);
  some.summary.click();
  assert.equal(entries(some.row).length, 2);

  const grown = line(saved(savedEvents), open);
  assert.equal(grown.row.open, true, 'opened records reopen on redraw');
  assert.equal(entries(grown.row).length, 6, 'drawn with every event now recorded');
  assert.equal(byClass(grown.summary, 'label')!.textContent, '研究员-b7191893 · 执行过程 · 已完成');
  grown.summary.click();
  assert.equal(line(saved(savedEvents), open).row.open, false);
});

test('tool labels and details are literal text, never markup', () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const view = line(saved([
    { id: 'u', type: 'tool_use', label: evil, detail: evil },
    { id: 'r', type: 'tool_result', toolName: evil, detail: '**bold** ' + evil, status: 'ok' },
  ]));
  view.summary.click();
  assert.deepEqual(entries(view.row).map(entryView), [
    { name: evil, pre: [['trace-args', evil]] },
    { name: evil + ' · 结果 · 成功', pre: [['trace-out', '**bold** ' + evil]] },
  ]);
  assert.equal(all(view.row).some(n => ['img', 'script', 'strong'].includes(n.tag)), false);
  assert.deepEqual(view.drawn, [], 'tool details never reach the Markdown renderer');
});

test('the page loads message presentation before app.js and its styles after the café theme', () => {
  const html = read('client/index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.includes('/chat-presentation.js') && scripts.indexOf('/chat-presentation.js') < scripts.indexOf('/app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(styles.indexOf('/chat-presentation.css') > styles.indexOf('/cafe-theme.css'));
});
