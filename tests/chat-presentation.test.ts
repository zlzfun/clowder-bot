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

test('the page loads message presentation before app.js and its styles after the café theme', () => {
  const html = read('client/index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.includes('/chat-presentation.js') && scripts.indexOf('/chat-presentation.js') < scripts.indexOf('/app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(styles.indexOf('/chat-presentation.css') > styles.indexOf('/cafe-theme.css'));
});
