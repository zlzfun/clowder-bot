import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El } from './fake-dom.js';

// A line break a cat wrote inside a paragraph stays a line break
// (docs/xbot-frontend.md item 33). The reply renderer is app.js's own
// appendMarkdown → appendFenced → appendBlocks, taken from the file as it is
// and run on the small DOM with chat-presentation.js loaded; only its leaf
// helpers (link icons, path labels, code blocks) are stand-ins. The live reply
// (chat-live.js through the render hook) and the settled bubble both draw with
// appendMarkdown, so the same paragraphs come out of both.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const app = read('client/public/app.js');
const take = (name: string) => {
  const m = new RegExp(`\\n {2}function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
  assert.ok(m, name + ' is where the renderer keeps it');
  return m[0];
};

function renderer() {
  const doc = new Doc();
  const window: Any = {};
  const context = vm.createContext({ window, document: doc, console });
  vm.runInContext(read('client/public/chat-presentation.js'), context);
  const out: Any = {};
  const el = (tag: string, cls?: string, text?: string) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  Object.assign(context, {
    out, el, presentation: window.ClowderPresentation,
    linkIcon: (a: El) => a,
    pathLabel: (p: string, tag = 'span') => el(tag, 'path', p),
    codeBlock: (_lang: string, body: string) => { const wrap = el('div', 'code-block'); wrap.append(el('pre', '', body)); return wrap; },
  });
  vm.runInContext(['appendInline', 'appendBlocks', 'appendMarkdown', 'appendFenced', 'appendPathText', 'mathNode', 'tableCells', 'tableAligns', 'tableNode'].map(take).join('\n')
    + '\nout.render = (text) => { const box = el("div", "prose"); appendMarkdown(box, text); return box; };', context);
  return { doc, render: out.render as (text: string) => El };
}
// The drawn tree as compact markup: tags, <br> and text.
const shape = (n: Any): string => n.nodeType === 3 ? n.textContent : n.tagName === 'BR' ? '⏎' :
  `<${n.tagName.toLowerCase()}>${n.childNodes.map(shape).join('')}</${n.tagName.toLowerCase()}>`;
const paragraphs = (box: El) => box.children.filter(c => c.tagName === 'P').map(shape);

test('single line breaks inside a paragraph are drawn as breaks, marks and all', () => {
  const { render } = renderer();
  // The real reply that ran together on the isolated runtime.
  const box = render('**任务**: 每天早上 9 点喝水提醒\n**触发**: 每天 09:00\n**消息**: 该喝水了！');
  assert.deepEqual(paragraphs(box), ['<p><strong>任务</strong>: 每天早上 9 点喝水提醒⏎<strong>触发</strong>: 每天 09:00⏎<strong>消息</strong>: 该喝水了！</p>']);
  // A blank line still starts a new paragraph; a single break does not.
  assert.deepEqual(paragraphs(render('第一行\n第二行\n\n另一段')), ['<p>第一行⏎第二行</p>', '<p>另一段</p>']);
  // Bold that spans the break keeps both lines inside one mark.
  assert.deepEqual(paragraphs(render('**一句话\n跨两行**')), ['<p><strong>一句话⏎跨两行</strong></p>']);
  // Nothing to break: unchanged.
  assert.deepEqual(paragraphs(render('只有一行')), ['<p>只有一行</p>']);
});

test('code, tables and lists keep their own structure; quotes break like paragraphs', () => {
  const { render } = renderer();
  const box = render(['看这里：', '```js', 'const a = 1;', 'const b = 2;', '```', '| 项 | 值 |', '| --- | --- |', '| 一 | 二 |', '', '- 第一项', '- 第二项', '', '> 引用一行', '> 引用二行'].join('\n'));
  const pre = box.querySelector('pre')!;
  assert.equal(pre.textContent, 'const a = 1;\nconst b = 2;\n', 'a code block keeps its newlines as text');
  assert.equal(pre.querySelectorAll('br').length, 0);
  assert.equal(box.querySelectorAll('td').length, 2);
  assert.equal(box.querySelectorAll('table br').length, 0, 'table cells are one line each');
  assert.deepEqual(box.querySelectorAll('li').map(shape), ['<li>第一项</li>', '<li>第二项</li>']);
  assert.deepEqual(box.querySelector('blockquote')!.children.map(shape), ['<p>引用一行⏎引用二行</p>']);
  // Inline code that happens to hold a newline keeps it as written.
  const code = render('用 `a\nb` 试试\n下一行');
  assert.deepEqual(paragraphs(code), ['<p>用 <code>a\nb</code> 试试⏎下一行</p>']);
});

test('the live reply and the settled bubble draw through the same renderer', () => {
  // chat-live.js draws a reply in progress with the render hook; the settled bubble with botBubble's appendMarkdown.
  assert.match(app, /render: \(parent, text\) => appendMarkdown\(parent, stripBotImages\(displayText\(text\)\)\),/);
  assert.match(take('botBubble'), /appendBotContent\(body, displayText\(said\)\)/);
  assert.match(take('appendBotContent'), /const bubble = el\("div", "prose bot-bubble"\);\n\s+appendMarkdown\(bubble, stripBotImages\(text\)\);/);
  assert.match(take('appendBlocks'), /appendInline\(p, para\.join\("\\n"\)\);\n\s+\/\/ [^\n]*\n\s+presentation\.lineBreaks\(p\);/);
});

test('the history\'s day separators read like the sidebar\'s times: 今天, 昨天, 11月3日, and the year only for another year', () => {
  const out: Any = {};
  vm.runInNewContext(take('clockTime') + take('timeDivider') + 'out.divider = timeDivider;', { out, Date, Number });
  const now = new Date(2026, 10, 11, 23, 0);
  assert.equal(out.divider('', new Date(2026, 10, 11, 9, 5).toISOString(), now), '今天 09:05');
  assert.equal(out.divider('', new Date(2026, 10, 10, 14, 5).toISOString(), now), '昨天 14:05');
  assert.equal(out.divider('', new Date(2026, 10, 3, 14, 5).toISOString(), now), '11月3日 14:05');
  assert.equal(out.divider('', new Date(2025, 10, 3, 14, 5).toISOString(), now), '2025年11月3日 14:05');
  // Within half an hour of the line before, on the same day: no separator.
  assert.equal(out.divider(new Date(2026, 10, 3, 14, 0).toISOString(), new Date(2026, 10, 3, 14, 5).toISOString(), now), '');
});

test('lineBreaks leaves code and formulas alone and adds one break per newline', () => {
  const doc = new Doc();
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-presentation.js'), { window, document: doc });
  const p = doc.createElement('p');
  const math = doc.createElement('span'); math.className = 'math-inline math-raw'; math.textContent = '$a\nb$';
  const code = doc.createElement('code'); code.textContent = 'x\ny';
  p.append('一\n\n二', math, code, '三\n');
  window.ClowderPresentation.lineBreaks(p);
  assert.equal(shape(p), '<p>一⏎⏎二<span>$a\nb$</span><code>x\ny</code>三⏎</p>');
});
