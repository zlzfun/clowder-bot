import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// One everyday vocabulary across what the owner reads in the main app
// (docs/xbot-frontend.md item 33): 猫猫, 群聊, 分组 for sidebar folders, 对话.
// The engine's words (Bot, Agent, 会话, Thread, 原生, 调用, XBot, 群组…) stay
// out of everything shown or read aloud; technical nouns (模型, 推理强度,
// Clowder AI) appear only in the technical regions listed below. The runtime
// panel (runtime.html) keeps its own language and is not scanned.
//
// What counts as displayed, and how identifiers are left alone:
// - index.html: text between tags and the attributes that are shown or read
//   aloud (aria-label, title, placeholder, alt, data-tip, data-placeholder).
//   Comments, <script>, <style> and SVG drawing are skipped.
// - Each script index.html loads: its string literals and the text parts of
//   its template literals, found by a small tokenizer that skips comments and
//   regular expressions (a pattern matches text, it never shows it). Only
//   literals that read as words are checked: any literal with a Han character
//   (everything this app says is Chinese), and an ASCII literal only for a
//   capitalised retired word standing alone (「Bot」, 「Agent ID」). Identifiers,
//   API paths, storage keys, CSS classes and event names are ASCII in lower or
//   camel case ("bot", "/xbot-api/bots/", "xbot-theme", "data-bot"), so they
//   never match; the product's own name, clowder-bot, is removed first.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// Words never shown anywhere in the main app.
const NEVER: Array<[string, RegExp]> = [
  ['Bot', /(?<![\w-])bots?\b/i], ['XBot', /xbot/i], ['Agent', /(?<![\w-])agents?\b/i],
  ['Thread', /(?<![\w-])threads?\b/i], ['session', /(?<![\w-])sessions?\b/i],
  ['会话', /会话/], ['线程', /线程/], ['原生', /原生/], ['调用', /调用/], ['群组', /群组/],
];
// Technical nouns: only inside a technical region.
const TECHNICAL: Array<[string, RegExp]> = [['模型', /模型/], ['推理强度', /推理强度/], ['Clowder AI', /clowder ai/i]];

// The allowlist of technical regions, kept short on purpose:
// - whole modules whose every surface is technical: 设置 → 本机工具 and the
//   更换工具 dialog reached from 资料 › 高级 (agents.js); 设置 → 模板 and the
//   template creator behind 新建猫猫 › 更多设置 (cat-templates.js and its rules);
// - marked regions (`vocabulary: technical` … `vocabulary: end`, in a comment):
//   in app.js, 资料 › 高级's 它用什么思考 and 模型与画像; in index.html, 设置 → 关于.
const WHOLE = new Set(['agents.js', 'cat-templates.js', 'cat-template-rules.js']);
const MARKED: Record<string, number> = { 'app.js': 1, 'index.html': 1 };
// Strings matched, never shown: someone typing an old word still finds the action.
const MATCHED = new Set(['palette.js:群组']);
// Scripts index.html loads whose words the owner cannot reach in this product:
// the runtime panel's Task module (the main app calls only its judgments, whose
// labels are 恢复任务 / 允许继续), and the upstream cross-device modules whose
// screens need paired devices, which this local server never reports
// (GET /xbot-api/account/devices is always empty) and whose settings pages are
// no longer mounted (docs/xbot-frontend.md item 15).
const UNREACHABLE = new Set(['runtime-tasks.js', 'devices.js', 'remotechat.js']);

type Literal = { text: string; line: number };

// String literals and template text of a classic script, with line numbers;
// comments and regular expressions are skipped.
export function literals(src: string): Literal[] {
  const out: Literal[] = [];
  const n = src.length;
  let i = 0, line = 1, prev = '', depth = 0;
  const stack: number[] = [];
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev === 'value') return false;
    if (prev.startsWith('id:')) return /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(prev.slice(3));
    return !/^[)\]}]$/.test(prev);
  };
  const template = () => {
    let text = '';
    const start = line;
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') { text += src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { i++; out.push({ text, line: start }); prev = 'value'; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; out.push({ text, line: start }); stack.push(depth); depth++; prev = '{'; return; }
      if (c === '\n') line++;
      text += c; i++;
    }
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); line += (src.slice(i, end).match(/\n/g) || []).length; i = end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, text = '';
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue; } text += src[j]; j++; }
      out.push({ text, line }); i = j + 1; prev = 'value'; continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false;
      while (j < n && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue; } if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break; j++; }
      j++;
      while (j < n && /[a-z]/i.test(src[j]!)) j++;
      i = j; prev = 'value'; continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) { let j = i; while (j < n && /[\w$\u0080-￿]/.test(src[j]!)) j++; prev = 'id:' + src.slice(i, j); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < n && /[\w.]/.test(src[j]!)) j++; prev = 'value'; i = j; continue; }
    if (c === '{') { depth++; prev = '{'; i++; continue; }
    if (c === '}') {
      if (stack.length && stack[stack.length - 1] === depth - 1) { depth--; stack.pop(); i++; template(); continue; }
      depth--; prev = '}'; i++; continue;
    }
    prev = c; i++;
  }
  return out;
}

// Line ranges between `vocabulary: technical` and `vocabulary: end` markers.
function regions(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open = 0;
  src.split('\n').forEach((text, k) => {
    if (/(\/\/|\/\*|<!--)\s*vocabulary: technical\b/.test(text)) { assert.equal(open, 0, 'regions do not nest'); open = k + 1; }
    else if (/(\/\/|\/\*|<!--)\s*vocabulary: end\b/.test(text)) { assert.ok(open, 'an end marker closes a region'); out.push([open, k + 1]); open = 0; }
  });
  assert.equal(open, 0, 'every region is closed');
  return out;
}

const SHOWN_ATTRS = /\s(aria-label|title|placeholder|alt|data-tip|data-placeholder)="([^"]*)"/g;
// What index.html shows: text and the shown attributes, with line numbers.
function htmlWords(src: string): Literal[] {
  const out: Literal[] = [];
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  // Keep line numbers: skipped parts become blanks of the same shape.
  const text = src.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, blank);
  const lineAt = (at: number) => text.slice(0, at).split('\n').length;
  for (const tag of text.matchAll(/<[^>]+>/g)) for (const a of tag[0].matchAll(SHOWN_ATTRS)) out.push({ text: a[2]!, line: lineAt(tag.index!) });
  for (const t of text.matchAll(/>([^<]+)</g)) if (t[1]!.trim()) out.push({ text: t[1]!.trim(), line: lineAt(t.index!) });
  return out;
}

const reads = (s: string) => /\p{Script=Han}/u.test(s) || /(^|[\s(])(Bots?|Agents?|Threads?|Sessions?|XBot)(?=$|[\s:·,.)])/.test(s);

function offenders(file: string, words: Literal[], technical: (line: number) => boolean) {
  const found: string[] = [];
  for (const { text, line } of words) {
    if (!reads(text)) continue;
    const said = text.replace(/clowder-bot/gi, '');
    for (const [word, re] of NEVER) if (re.test(said) && !MATCHED.has(file + ':' + text)) found.push(`${file}:${line} ${word} in 「${text}」`);
    if (!technical(line)) for (const [word, re] of TECHNICAL) if (re.test(said)) found.push(`${file}:${line} ${word} outside a technical region in 「${text}」`);
  }
  return found;
}

const html = read('client/index.html');
const scripts = [...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map(m => m[1]!).filter(f => !f.startsWith('vendor/'));

test('the scan covers every script the page loads, with a short, stated list of what it leaves out', () => {
  assert.ok(scripts.length >= 30, 'the page scripts are found');
  for (const f of [...UNREACHABLE, ...WHOLE]) assert.ok(scripts.includes(f), f + ' is still loaded (otherwise drop it from the list)');
  // runtime-tasks.js is used by the main app only for judgments: no words of its own reach the owner.
  const ws = read('client/public/workspace.js');
  const used = [...new Set([...ws.matchAll(/\bT\.(\w+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(used, ['background', 'canCancel', 'canResume', 'canStop', 'controlBody', 'resumeLabel', 'resumeWait', 'stopMarked']);
  const tasks = read('client/public/runtime-tasks.js');
  assert.match(tasks, /const resumeLabel = task => cancelled\(task\) \? '恢复任务' : '允许继续';/);
  // The cross-device modules' screens need paired devices, which the local server never reports.
  const app = read('client/public/app.js');
  assert.doesNotMatch(app, /xbotDevices\.mount|xbotRemoteChat\.open|XBotAccount\.mountSettings/);
  assert.match(read('server/xbot/settings.ts'), /router\.get\('\/account\/devices', \(_req, res\) => res\.json\(\{ devices: \[\]/);
});

test('what the main app shows speaks one everyday vocabulary; technical nouns stay in the listed technical regions', () => {
  const found: string[] = [];
  const marked = regions(html);
  assert.equal(marked.length, MARKED['index.html'], 'index.html: the technical regions are the listed ones');
  found.push(...offenders('index.html', htmlWords(html), (line) => marked.some(([a, b]) => line >= a && line <= b)));
  for (const file of scripts) {
    if (UNREACHABLE.has(file)) continue;
    const src = read('client/public/' + file);
    const ranges = regions(src);
    assert.equal(ranges.length, MARKED[file] ?? 0, file + ': the technical regions are the listed ones');
    const whole = WHOLE.has(file);
    found.push(...offenders(file, literals(src), (line) => whole || ranges.some(([a, b]) => line >= a && line <= b)));
  }
  assert.deepEqual(found, []);
});

test('the scanner finds words in strings and templates, and leaves comments, patterns and identifiers alone', () => {
  const src = [
    '// a Bot in a comment',
    'const a = "团子的 Bot";',
    "const b = '会话';",
    'const c = `你好 ${name} 原生`;',
    'const d = /会话/.test(x) ? 1 : 2;',
    'const e = x / 2 / y;',
    '/* 原生 */ const f = "data-bot";',
    'const g = `${`内层 Agent`}`;',
    'const h = "Agent ID";',
  ].join('\n');
  const words = literals(src).filter(l => reads(l.text.replace(/clowder-bot/gi, '')));
  assert.deepEqual(words.map(w => [w.line, w.text]), [[2, '团子的 Bot'], [3, '会话'], [4, '你好 '], [4, ' 原生'], [8, '内层 Agent'], [9, 'Agent ID']]);
  assert.deepEqual(offenders('x.js', literals('const t = "模型";\n// vocabulary: technical\nconst u = "模型";\n// vocabulary: end'), (line) => line === 3), ['x.js:1 模型 outside a technical region in 「模型」']);
  assert.deepEqual(htmlWords('<p title="Bot 名">你好</p>\n<!-- 会话 --><svg><text>原生</text></svg><b>猫猫</b>').map(w => w.text), ['Bot 名', '你好', '猫猫']);
});

test('a route the server has not adapted is known by its code, never by its wording', () => {
  const app = read('client/public/app.js');
  for (const file of scripts) assert.doesNotMatch(read('client/public/' + file), /尚无原生适配/, file);
  // api() hands the server's code over with the error; visibleError says it in everyday words.
  assert.match(app, /if \(typeof data\.code === "string"\) err\.code = data\.code;/);
  assert.match(app, /if \(e && e\.code === "not_adapted"\) return "这项功能在这里还用不了";/);
  assert.match(read('client/public/workspace.js'), /const missingRoute = e\.status === 404 && !path && e\.code === "not_adapted";/);
  assert.match(read('server/app.ts'), /code: 'not_adapted'/);
});
