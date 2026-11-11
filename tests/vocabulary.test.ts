import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// One everyday vocabulary across what the owner reads in the main app
// (docs/xbot-frontend.md item 34): 猫猫, 群聊, 分组 for sidebar folders, 对话.
// The engine's words (Bot, Agent, 会话, Thread, 原生, 调用, XBot, 群组…) stay
// out of everything shown or read aloud; technical nouns (模型, 推理强度,
// Clowder AI) appear only in the technical places listed below. The runtime
// panel (runtime.html) keeps its own language and is not scanned.
//
// What counts as displayed, and how identifiers are left alone:
// - index.html: text between tags and the attributes that are shown or read
//   aloud (aria-label, title, placeholder, alt, data-tip, data-placeholder),
//   double-, single- or un-quoted, with character references decoded.
//   Comments, <script>, <style> and SVG drawing are skipped.
// - Each script index.html loads (every <script … src> tag, whatever its other
//   attributes): its string literals and the text parts of its template
//   literals, found by a small tokenizer that skips comments and regular
//   expressions (a pattern matches text, it never shows it). Escapes are
//   decoded (会, \u{4f1a}, \x41) and literals joined only by `+` are folded
//   into one ("会" + "话" is 会话). Only literals that read as words are
//   checked: any literal with a Han character (everything this app says is
//   Chinese), and an ASCII literal holding a capitalised retired word standing
//   alone (「Bot」, 「Agent ID」) or Clowder AI. Identifiers, API paths, storage
//   keys, CSS classes and event names are ASCII in lower or camel case ("bot",
//   "/xbot-api/bots/", "xbot-theme", "data-bot"), so they never match; the
//   product's own name, clowder-bot, is removed first.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

// Words never shown anywhere in the main app.
const NEVER: Array<[string, RegExp]> = [
  ['Bot', /(?<![\w-])bots?\b/i], ['XBot', /xbot/i], ['Agent', /(?<![\w-])agents?\b/i],
  ['Thread', /(?<![\w-])threads?\b/i], ['session', /(?<![\w-])sessions?\b/i],
  ['会话', /会话/], ['线程', /线程/], ['原生', /原生/], ['调用', /调用/], ['群组', /群组/],
];
// Technical nouns: only in a technical place.
const TECHNICAL: Array<[string, RegExp]> = [['模型', /模型/], ['推理强度', /推理强度/], ['Clowder AI', /clowder ai/i]];

// The technical places, kept short and tied to what they are, not to markers
// that could be moved:
// - whole modules whose every surface is technical: 设置 → 本机工具 and the
//   更换工具 dialog reached from 资料 › 高级 (agents.js); 设置 → 模板 and the
//   template creator behind 新建猫猫 › 更多设置 (cat-templates.js and its rules);
// - named functions of app.js: 资料 › 高级's 它用什么思考 and 模型与画像;
// - one DOM container of index.html: 设置 → 关于 (div.setpane[data-spane="about"]).
// A technical noun one line outside these is reported (see the tests below).
const WHOLE = new Set(['agents.js', 'cat-templates.js', 'cat-template-rules.js']);
const FUNCTIONS: Record<string, string[]> = { 'app.js': ['agentTrigger', 'agentPart', 'configPart', 'catConfigSection'] };
const CONTAINERS: Record<string, string[]> = { 'index.html': ['<div class="setpane" data-spane="about">'] };
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

// A literal's own text, with its escapes decoded.
function unescape(raw: string): string {
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r?\n|(.))/g, (_m, _all, cp, u4, x2, ch) => {
    if (cp) return String.fromCodePoint(parseInt(cp, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (ch === undefined) return '';
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[ch] ?? ch;
  });
}

// String literals and template text of a classic script, with line numbers;
// comments and regular expressions are skipped; escapes decoded; literals
// joined only by `+` (and whitespace or comments) folded into one.
export function literals(src: string): Literal[] {
  const out: Array<Literal & { start: number; end: number; tpl: boolean }> = [];
  const n = src.length;
  let i = 0, line = 1, prev = '', depth = 0;
  const stack: number[] = [];
  const regexAllowed = () => {
    if (!prev) return true;
    if (prev === 'value') return false;
    if (prev.startsWith('id:')) return /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(prev.slice(3));
    return !/^[)\]}]$/.test(prev);
  };
  // The text of a template from i (after ` or }) to the next ` or ${.
  const template = (open: number, expr: boolean) => {
    let text = '';
    const start = line;
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') { text += src.slice(i, i + 2); if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { i++; out.push({ text: unescape(text), line: start, start: open, end: i, tpl: expr }); prev = 'value'; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; out.push({ text: unescape(text), line: start, start: open, end: i, tpl: true }); stack.push(depth); depth++; prev = '{'; return; }
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
      out.push({ text: unescape(text), line, start: i, end: j + 1, tpl: false }); i = j + 1; prev = 'value'; continue;
    }
    if (c === '`') { const open = i; i++; template(open, false); continue; }
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
      if (stack.length && stack[stack.length - 1] === depth - 1) { depth--; stack.pop(); const open = i; i++; template(open, true); continue; }
      depth--; prev = '}'; i++; continue;
    }
    prev = c; i++;
  }
  // Fold "a" + "b" (+ "c"…) into one literal; template parts with an expression between them stay apart.
  const folded: Literal[] = [];
  for (let k = 0; k < out.length; k++) {
    const lit = out[k]!;
    let text = lit.text, end = lit.end;
    while (!lit.tpl && k + 1 < out.length && !out[k + 1]!.tpl && /^\s*\+\s*$/.test(src.slice(end, out[k + 1]!.start).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) {
      k++; text += out[k]!.text; end = out[k]!.end;
      folded.push({ text: out[k]!.text, line: out[k]!.line });
    }
    folded.push({ text, line: lit.line });
  }
  return folded;
}

// The line range [first, last] of each named function of a script (its declaration to its closing brace at the same indent).
function functionLines(src: string, names: string[]): Array<[number, number]> {
  return names.map((name) => {
    const m = new RegExp(`\\n( *)(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n\\1\\}\\n`).exec(src);
    assert.ok(m, 'no function ' + name);
    const first = src.slice(0, m.index + 1).split('\n').length;
    return [first, first + m[0].trim().split('\n').length - 1] as [number, number];
  });
}
// The line range of each DOM container of a page: from its opening tag to the </div> that balances it.
function containerLines(src: string, opens: string[]): Array<[number, number]> {
  return opens.map((open) => {
    const at = src.indexOf(open);
    assert.ok(at >= 0, 'no container ' + open);
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = at;
    let depth = 0, end = -1;
    for (let m = tags.exec(src); m; m = tags.exec(src)) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) { end = m.index; break; }
    }
    assert.ok(end > at, 'unbalanced ' + open);
    return [src.slice(0, at).split('\n').length, src.slice(0, end).split('\n').length] as [number, number];
  });
}

// Character references in page text: &#20250; &#x4f1a; and the common named ones.
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const entities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NAMED[e.toLowerCase()] ?? m);

const SHOWN = new Set(['aria-label', 'title', 'placeholder', 'alt', 'data-tip', 'data-placeholder']);
// A tag's attributes: name="v", name='v', name=v and bare names.
const attributes = (tag: string) => [...tag.replace(/^<\/?[\w-]+/, '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)]
  .map((m) => ({ name: m[1]!.toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' }));
// What index.html shows: text and the shown attributes, decoded, with line numbers.
function htmlWords(src: string): Literal[] {
  const out: Literal[] = [];
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  // Keep line numbers: skipped parts become blanks of the same shape.
  const text = src.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, blank);
  const lineAt = (at: number) => text.slice(0, at).split('\n').length;
  for (const tag of text.matchAll(/<[^>]+>/g)) for (const a of attributes(tag[0])) if (SHOWN.has(a.name)) out.push({ text: entities(a.value), line: lineAt(tag.index!) });
  for (const t of text.matchAll(/>([^<]+)</g)) if (t[1]!.trim()) out.push({ text: entities(t[1]!.trim()), line: lineAt(t.index!) });
  return out;
}
// Every <script> with a src, whatever else the tag carries.
const scriptsOf = (page: string) => [...page.matchAll(/<script\b[^>]*>/gi)]
  .map((m) => attributes(m[0]).find((a) => a.name === 'src')?.value ?? null)
  .filter((src): src is string => !!src).map((src) => src.replace(/^\//, ''));

const reads = (s: string) => /\p{Script=Han}/u.test(s) || /clowder ai/i.test(s) || /(^|[\s(])(Bots?|Agents?|Threads?|Sessions?|XBot)(?=$|[\s:·,.)])/.test(s);

function offenders(file: string, words: Literal[], technical: (line: number) => boolean) {
  const found: string[] = [];
  for (const { text, line } of words) {
    if (!reads(text)) continue;
    const said = text.replace(/clowder-bot/gi, '');
    for (const [word, re] of NEVER) if (re.test(said) && !MATCHED.has(file + ':' + text)) found.push(`${file}:${line} ${word} in 「${text}」`);
    if (!technical(line)) for (const [word, re] of TECHNICAL) if (re.test(said)) found.push(`${file}:${line} ${word} outside a technical place in 「${text}」`);
  }
  return found;
}
const within = (ranges: Array<[number, number]>) => (line: number) => ranges.some(([a, b]) => line >= a && line <= b);
// One page and its scripts, scanned as the main app is.
function scan(page: string, script: (file: string) => string, containers = CONTAINERS['index.html']!) {
  const found = offenders('index.html', htmlWords(page), within(containerLines(page, containers)));
  for (const file of scriptsOf(page).filter((f) => !f.startsWith('vendor/'))) {
    if (UNREACHABLE.has(file)) continue;
    const src = script(file);
    const technical = WHOLE.has(file) ? () => true : within(FUNCTIONS[file] ? functionLines(src, FUNCTIONS[file]!) : []);
    found.push(...offenders(file, literals(src), technical));
  }
  return found;
}

const html = read('client/index.html');
const scripts = scriptsOf(html).filter((f) => !f.startsWith('vendor/'));
const script = (file: string) => read('client/public/' + file);

test('the scan covers every script the page loads, with a short, stated list of what it leaves out', () => {
  assert.ok(scripts.length >= 30, 'the page scripts are found');
  assert.equal(scriptsOf(html).length, (html.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length, 'every <script src> tag is discovered');
  for (const f of [...UNREACHABLE, ...WHOLE, ...Object.keys(FUNCTIONS)]) assert.ok(scripts.includes(f), f + ' is still loaded (otherwise drop it from the list)');
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

test('what the main app shows speaks one everyday vocabulary; technical nouns stay in the named technical places', () => {
  assert.deepEqual(scan(html, script), []);
});

test('the scanner decodes, folds and parses what a display string can hide behind', () => {
  const words = (src: string) => literals(src).filter(l => reads(l.text.replace(/clowder-bot/gi, ''))).map(l => [l.line, l.text]);
  assert.deepEqual(words([
    '// a Bot in a comment',
    'const a = "团子的 Bot";',
    "const b = '会话';",
    'const c = `你好 ${name} 原生`;',
    'const d = /会话/.test(x) ? 1 : 2;',
    'const e = x / 2 / y;',
    '/* 原生 */ const f = "data-bot";',
    'const g = `${`内层 Agent`}`;',
    'const h = "Agent ID";',
  ].join('\n')), [[2, '团子的 Bot'], [3, '会话'], [4, '你好 '], [4, ' 原生'], [8, '内层 Agent'], [9, 'Agent ID']]);
  // Each way of hiding a word is still caught.
  const caught = (src: string) => offenders('x.js', literals(src), () => false);
  assert.ok(caught('const a = "会" + "话";').some(f => /会话/.test(f)), 'a constant concatenation');
  assert.ok(caught('const a = "会" /* split */ +\n  "话";').some(f => /会话/.test(f)), 'across lines and comments');
  assert.ok(caught('const a = "\\u4f1a\\u8bdd";').some(f => /会话/.test(f)), 'Unicode escapes');
  assert.ok(caught('const a = "\\u{4f1a}\\u{8bdd}";').some(f => /会话/.test(f)), 'code point escapes');
  assert.ok(caught('const a = "Clowder AI";').some(f => /Clowder AI outside/.test(f)), 'a standalone Clowder AI');
  assert.deepEqual(caught('const a = "会" + name + "话";'), [], 'a dynamic part between is not folded (each part is checked on its own)');
  // In the page: single-quoted, unquoted and entity-encoded attributes, entity-encoded text.
  const page = (body: string) => offenders('p.html', htmlWords(body), () => false);
  assert.equal(page("<b title='会话'>x</b>").length, 1);
  assert.equal(page('<b aria-label=会话>x</b>').length, 1);
  assert.equal(page('<b title="&#20250;&#x8bdd;">x</b>').length, 1);
  assert.equal(page('<p>&#x4f1a;&#35805;</p>').length, 1);
  assert.deepEqual(page('<!-- 会话 --><svg><text>原生</text></svg><b>猫猫</b>'), []);
  // A script tag with other attributes is discovered, and then scanned.
  const withDefer = '<script src="/a.js"></script>\n<script defer src="/new-feature.js"></script>\n<script>var t = 1;</script>';
  assert.deepEqual(scriptsOf(withDefer), ['a.js', 'new-feature.js']);
  assert.deepEqual(scan(withDefer, (f) => (f === 'new-feature.js' ? 'el.textContent = "原生会话";' : ''), []).length, 2);
});

test('a technical place cannot grow: a technical noun just outside the named functions or container is reported', () => {
  const app = script('app.js');
  // Right after catConfigSection, still near 高级's code, is ordinary chat code.
  const widened = app.replace(/(\n {2}function catConfigSection\([^\n]*\) \{\n[\s\S]*?\n {2}\}\n)/, '$1  function sneaky() { return "模型"; }\n');
  assert.notEqual(widened, app);
  const scanApp = (src: string) => scan(html, (f) => (f === 'app.js' ? src : script(f))).filter(f => f.startsWith('app.js'));
  assert.deepEqual(scanApp(app), []);
  assert.equal(scanApp(widened).length, 1, 'outside the named functions');
  // Old-style comment markers mean nothing now.
  const marked = app.replace('function sneaky', '// vocabulary: technical\n  function sneaky');
  assert.ok(scanApp(marked.replace(/(\n {2}function catConfigSection\([^\n]*\) \{\n[\s\S]*?\n {2}\}\n)/, '$1  // vocabulary: technical\n  function sneaky() { return "模型"; }\n  // vocabulary: end\n')).length >= 1);
  // In the page, right after 设置 → 关于's container closes.
  const at = html.indexOf('<div class="setpane" data-spane="about">');
  const close = containerLines(html, CONTAINERS['index.html']!)[0]![1];
  const lines = html.split('\n');
  lines.splice(close, 0, '   <p>模型</p>');
  assert.ok(at > 0);
  assert.equal(scan(lines.join('\n'), script).filter(f => f.startsWith('index.html')).length, 1);
  // Inside it, the same words are fine (it is 关于).
  const inside = html.split('\n');
  inside.splice(close - 1, 0, '    <p>模型</p>');
  assert.deepEqual(scan(inside.join('\n'), script).filter(f => f.startsWith('index.html')), []);
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
