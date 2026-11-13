import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
// @ts-expect-error plain module without types
import { buildPalettes, serialize, problems, PAIRS, SYNTAX } from '../scripts/theme-lab/palettes.mjs';
import { declarations, specificity, applies } from './css-rank.js';

// The colour lab (client/public/theme-lab/, /theme-lab/; docs/xbot-frontend.md
// item 47): candidate palettes shown on the real interface. Review only. A
// palette is the token block cafe-theme.css sets plus a code block's --syn-*
// colours; every palette defines all of it in both modes and keeps the pairs a
// reader meets readable; palettes.json is exactly what the generator writes,
// with 拿铁 read from today's cafe-theme.css. The lab draws frozen screens on
// the app's own stylesheets in client/index.html's order, its palette rules
// out-rank every rule of the app that sets those colours, the frozen screens
// run nothing, the script that freezes them refuses anything but the staged
// showcase, and nothing in the product links the lab or is written by it.
const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const palettes: Any[] = JSON.parse(read('client/public/theme-lab/palettes.json'));
const frozen: Any = JSON.parse(read('client/public/theme-lab/scenes.json'));
const cafe = read('client/public/cafe-theme.css');
const indexStyles = [...read('client/index.html').matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]!);
const MODES = ['light', 'dark'] as const;
const SYN = ['--syn-kw', '--syn-str', '--syn-cm', '--syn-num', '--syn-fn', '--syn-lit'];

function rules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/theme-lab/lab-rules.js'), { window });
  return window.ClowderThemeLabRules;
}
function presence() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/chat-presence-rules.js'), { window });
  return window.ClowderPresenceRules;
}
const block = (css: string, re: RegExp) => Object.fromEntries([...(re.exec(css)?.[1] ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2]!.trim()]));
// WCAG 2 contrast, written again here so the check does not lean on the generator's own.
const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// ---------------------------------------------------------------- the palettes
test('every palette defines every colour a theme sets, in both modes: cafe-theme.css\'s token names plus --accent, --accent-ink and --ring, and the six syntax colours for a code block and for the owner\'s bubble', () => {
  const names = [...new Set([...Object.keys(block(cafe, /:root\s*\{([^}]+)\}/)), ...Object.keys(block(cafe, /html\[data-theme="dark"\]\s*\{([^}]+)\}/)), '--accent', '--accent-ink', '--ring'])].sort();
  assert.ok(names.length >= 50, 'cafe-theme.css read as this test expects');
  assert.equal(palettes.length, 11);
  assert.equal(new Set(palettes.map(p => p.id)).size, palettes.length, 'ids are unique');
  assert.equal(palettes[0].id, 'latte');
  assert.deepEqual(palettes.filter(p => p.current).map(p => p.id), ['latte'], '拿铁, the colours the app has now, is first and the only current one');
  for (const p of palettes) {
    assert.match(p.id, /^[a-z]+$/);
    assert.ok(p.name && p.note && p.en, p.id + ' has a name and a note');
    assert.deepEqual(Object.keys(p).filter(k => !['id', 'name', 'en', 'note', 'current', 'light', 'dark'].includes(k)), [], p.id);
    for (const mode of MODES) {
      assert.deepEqual(Object.keys(p[mode].tokens).sort(), names, `${p.id} ${mode}: every token, nothing else`);
      for (const [name, value] of Object.entries<string>(p[mode].tokens)) {
        assert.match(value, /^(?:#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, [\d.]+\)|(?:\d+(?:px)? ){3}rgba\([^)]*\)(?:, (?:\d+(?:px)? ){3}rgba\([^)]*\))*)$/i, `${p.id} ${mode} ${name} is a colour (or a shadow of colours): ${value}`);
        assert.doesNotMatch(value, /var\(|[;{}<]/, `${p.id} ${mode} ${name} is a plain value`);
      }
      for (const where of ['code', 'user']) {
        assert.deepEqual(Object.keys(p[mode].syn[where]).sort(), [...SYN].sort(), `${p.id} ${mode} ${where}`);
        for (const value of Object.values<string>(p[mode].syn[where])) assert.match(value, /^#[0-9a-f]{6}$/);
      }
    }
  }
});

test('the pairs a reader meets stay readable in every palette and mode: the generator finds no failing pair, and each pair is checked again here', () => {
  assert.deepEqual(problems(palettes), [], 'the generator\'s own check');
  let checked = 0;
  for (const p of palettes) for (const mode of MODES) {
    const t = p[mode].tokens;
    for (const [fg, bgs, min] of PAIRS as Array<[string, string[], number]>) for (const bg of bgs) {
      // Alias values (拿铁's var(--x-fill-2)) and translucent colours are not judged, as in the generator.
      if (!/^#/.test(t[fg]) || !/^#/.test(t[bg])) continue;
      assert.ok(contrast(t[fg], t[bg]) >= min - 0.005, `${p.id} ${mode}: ${fg} on ${bg} is ${contrast(t[fg], t[bg]).toFixed(2)}, needs ${min}`);
      checked++;
    }
    for (const [where, bg] of SYNTAX as Array<[string, string]>) for (const [name, value] of Object.entries<string>(p[mode].syn[where])) {
      assert.ok(contrast(value, t[bg]) >= 4.495, `${p.id} ${mode}: ${name} on ${bg}`);
      checked++;
    }
  }
  assert.ok(checked > 1100, `${checked} pairs`);
  // Body text at AAA, everything else that is read at AA, the accent as a mark at 3:1.
  const minimum = Object.fromEntries((PAIRS as Array<[string, string[], number]>).map(([fg, , min]) => [fg, min]));
  assert.equal(minimum['--x-text'], 7);
  for (const fg of ['--x-text-2', '--x-muted', '--x-faint', '--x-on-primary', '--x-user-bubble-text', '--x-text-link', '--x-danger']) assert.equal(minimum[fg], 4.5, fg);
});

test('palettes.json is exactly what scripts/theme-lab/palettes.mjs writes, and 拿铁 is today\'s cafe-theme.css read as it is', () => {
  assert.equal(read('client/public/theme-lab/palettes.json'), serialize(buildPalettes()), 'run node scripts/theme-lab/palettes.mjs');
  const check = spawnSync(process.execPath, ['scripts/theme-lab/palettes.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  // 拿铁: every colour cafe-theme.css sets, as it sets it (its one alias written out), and its code colours.
  const latte = palettes[0];
  for (const [mode, re] of [['light', /:root\s*\{([^}]+)\}/], ['dark', /html\[data-theme="dark"\]\s*\{([^}]+)\}/]] as const) {
    const set = block(cafe, re);
    for (const [name, value] of Object.entries(set)) {
      if (value === 'var(--x-fill-2)') assert.equal(latte[mode].tokens[name], set['--x-fill-2'], name);
      else assert.equal(latte[mode].tokens[name], value, `拿铁 ${mode} ${name}`);
    }
    for (const name of ['--accent', '--accent-ink', '--ring']) assert.equal(latte[mode].tokens[name], set['--x-primary'], 'cafe-theme.css points ' + name + ' at --x-primary');
  }
  const syn = (re: RegExp) => block(cafe, re);
  const dk = syn(/\n\.code-block \{([^}]+)\}/), lt = syn(/html:not\(\[data-theme="dark"\]\) \.bubble \.code-block \{([^}]+)\}/), dkUser = syn(/\nhtml\[data-theme="dark"\] \.bubble \.code-block \{([^}]+)\}/);
  assert.deepEqual(latte.light.syn.code, dk); assert.deepEqual(latte.light.syn.user, lt);
  assert.deepEqual(latte.dark.syn.code, lt); assert.deepEqual(latte.dark.syn.user, dkUser);
});

// ---------------------------------------------------------------- how the lab draws them
test('the lab draws on the app\'s stylesheets in client/index.html\'s order, then the cats\' colours, then the palette, and on nothing else', () => {
  const R = rules();
  assert.deepEqual([...R.STYLES], indexStyles, 'lab-rules.js lists client/index.html\'s stylesheets, in its order');
  for (const href of R.STYLES) assert.ok(existsSync(join(root, 'client/public', href)), href);
  const scene = frozen.scenes[0], cinnamon = palettes.find(p => p.id === 'cinnamon');
  for (const mode of MODES) {
    const doc: string = R.frameDoc({ scene, mode, palette: cinnamon, html: frozen.html, accents: '.x { color: #123456; }' });
    assert.ok(doc.startsWith('<!doctype html><html lang="zh-CN" data-theme="' + mode + '"><head><meta charset="utf-8">'), mode);
    assert.deepEqual([...doc.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), indexStyles);
    const head = doc.slice(0, doc.indexOf('</head>'));
    assert.ok(head.lastIndexOf('<link') < head.indexOf('<style id="pz-accents">'), 'the cats\' colours after the stylesheets, where the app adds them');
    assert.ok(head.indexOf('<style id="pz-accents">') < head.indexOf('<style id="theme-lab-try">'), 'the palette after everything the app has');
    assert.ok(head.includes(R.overrideCss(cinnamon)));
    assert.ok(doc.endsWith(scene.body + '</html>'), 'the frozen body as it was taken');
    assert.doesNotMatch(doc, /<script/i);
  }
  // 拿铁 is the app as it is: no palette style at all.
  const latteDoc: string = R.frameDoc({ scene, mode: 'light', palette: palettes[0], html: frozen.html, accents: '' });
  assert.doesNotMatch(latteDoc, /theme-lab-try|pz-accents/);
  assert.equal(R.overrideCss(palettes[0]), '');
  // The only thing added besides: entrance animations end where they would end (transitions, so hover, stay).
  assert.match(latteDoc, /<style id="theme-lab-still">\*,\*::before,\*::after\{animation-delay:0s!important;animation-duration:0s!important\}<\/style><\/head>/);
  assert.doesNotMatch(R.STILL, /transition/);
  // The lab's own page sits on the neutral base (no café layer) and asks the app's own rules for each cat's colour.
  const page = read('client/public/theme-lab/index.html');
  assert.deepEqual([...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['/tokens.css', '/app.css', 'lab.css']);
  assert.deepEqual([...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]), ['/chat-presence-rules.js', 'lab-rules.js', 'lab.js']);
  assert.match(read('client/public/theme-lab/lab.js'), /P\.accentCss\(state\.cats, R\.surfaces\(palette, mode\)\)/);
});

// Since item 48 the app has eleven 配色 of its own (cafe-colors.css, html[data-colors="<id>"]): a lab palette must
// out-rank those as well, so that 在应用里试 shows the lab's palette whatever the app is set to.
test('a palette out-ranks every rule of the app that sets its colours, its own 配色 included, in both modes, on a code block and inside the owner\'s bubble; every other rule that sets one only points it at another token', () => {
  const R = rules(), cinnamon = palettes.find(p => p.id === 'cinnamon');
  const names = new Set([...Object.keys(cinnamon.light.tokens), ...SYN]);
  const lab = [...R.overrideCss(cinnamon).matchAll(/([^{}\n]+)\{([^}]*)\}/g)].map(m => ({ selector: m[1]!.trim(), decls: m[2]! }));
  assert.equal(lab.length, 6, 'the tokens in light and dark, and cafe-theme.css\'s four syntax rules');
  const app: Array<{ file: string; selector: string; names: string[]; values: string[] }> = [];
  for (const href of indexStyles) {
    const byRule = new Map<string, { names: string[]; values: string[] }>();
    for (const d of declarations(read('client/public' + href))) {
      if (!names.has(d.prop)) continue;
      const r = byRule.get(d.selector) ?? { names: [], values: [] };
      r.names.push(d.prop); r.values.push(d.value); byRule.set(d.selector, r);
    }
    for (const [selector, r] of byRule) app.push({ file: href, selector, ...r });
  }
  assert.ok(app.some(r => r.file === '/cafe-theme.css' && r.selector === ':root') && app.some(r => r.file === '/tokens.css'), 'the rules were read');
  assert.ok(app.some(r => r.file === '/cafe-colors.css' && r.selector === 'html[data-colors="honey"][data-theme="dark"]'), 'the app\'s own 配色 were read');
  const atRoot = (s: string) => /^(?::root|html(?:\[data-colors="[a-z]+"\])?(?:\[data-theme="dark"\])?)$/.test(s);
  const isSyntax = (r: { names: string[] }) => r.names.every(n => SYN.includes(n));
  // A 配色 swatch in 设置 carries its own palette's colours (cafe-colors.css), on itself only.
  const isSwatch = (r: { file: string; selector: string }) => r.file === '/cafe-colors.css' && /^(?:html\[data-theme="dark"\] )?\.colors-swatch\[data-colors="[a-z]+"\]$/.test(r.selector);
  for (const r of app) {
    if (atRoot(r.selector) || isSyntax(r) || isSwatch(r)) continue;
    for (const v of r.values) assert.match(v, /^var\(--[\w-]+\)$/, `${r.file} ${r.selector} sets a colour of its own (${v}): a palette would not reach it`);
  }
  for (const dark of [false, true]) for (const bubble of [false, true]) {
    for (const [kind, pick] of [['tokens', (r: Any) => atRoot(r.selector) && !isSyntax(r)], ['syntax', (r: Any) => isSyntax(r)]] as const) {
      if (kind === 'tokens' && bubble) continue;
      const appTop = Math.max(...app.filter(r => pick(r) && applies(r.selector, dark, bubble)).map(r => specificity(r.selector)));
      const mine = lab.filter(r => (kind === 'syntax') === /code-block/.test(r.selector) && applies(r.selector, dark, bubble)).map(r => ({ ...r, rank: specificity(r.selector) }));
      const top = Math.max(...mine.map(r => r.rank));
      assert.ok(top > appTop, `${kind}, ${dark ? 'dark' : 'light'}${bubble ? ', in the owner\'s bubble' : ''}: the palette (${top}) out-ranks the app (${appTop})`);
      const winners = mine.filter(r => r.rank === top);
      assert.equal(winners.length, 1, 'one palette rule decides');
      // The rule that decides carries the values meant for that place.
      const meant = kind === 'tokens' ? cinnamon[dark ? 'dark' : 'light'].tokens : cinnamon[dark ? 'dark' : 'light'].syn[bubble ? 'user' : 'code'];
      for (const [name, value] of Object.entries(meant)) assert.ok(winners[0]!.decls.includes(name + ':' + value), `${kind} ${dark ? 'dark' : 'light'} ${bubble ? 'bubble' : 'block'} ${name}`);
    }
  }
  // Nothing is added to the app's <html>: the palette is one style element.
  assert.doesNotMatch(R.overrideCss(cinnamon), /data-lab|data-colors/);
  for (const r of lab) assert.ok(r.selector.startsWith('html:root:root'), r.selector);
});

test('each cat\'s own colour is the app\'s own decision on each palette\'s surfaces: with 拿铁 it is what the app wrote when the scenes were taken', () => {
  const R = rules(), P = presence();
  assert.ok(frozen.cats.length >= 8);
  for (const cat of frozen.cats) { assert.match(cat.native_id, /^[\w-]+$/); assert.match(cat.accent.primary, /^#[0-9a-f]{6}$/i); assert.match(cat.accent.secondary, /^#[0-9a-f]{6}$/i); }
  for (const mode of MODES) {
    const s = R.surfaces(palettes[0], mode);
    assert.equal(s.chat, palettes[0][mode].tokens['--x-card']);
    assert.equal(s.bubble, palettes[0][mode].tokens['--x-bot-bubble']);
    assert.ok(P.accentCss(frozen.cats, s).length > 100, mode);
  }
  // A palette whose chat surface is lighter or darker can change which of a cat's two colours stays legible.
  const lines = palettes.map(p => P.accentCss(frozen.cats, R.surfaces(p, 'light')));
  assert.ok(new Set(lines).size > 1, 'decided per palette, not frozen');
  const scenes = read('scripts/theme-lab/scenes.mjs');
  assert.match(scenes, /presence\.accentCss\(cats, \{ chat: tokens\['--x-card'\], bubble: tokens\['--x-bot-bubble'\] \}\)/, 'the capture checks the lab\'s way against what the app wrote');
});

test('moving between palettes goes round the ends; a frame is never shown above its real size', () => {
  const R = rules();
  assert.equal(R.step(palettes, 'latte', -1), 'mintchoco');
  assert.equal(R.step(palettes, 'mintchoco', 1), 'latte');
  assert.equal(R.step(palettes, 'cinnamon', 1), 'americano');
  assert.equal(R.step([], 'x', 1), null);
  assert.equal(R.fitScale({ width: 1400, height: 820 }, 1200, 760), 1);
  assert.equal(R.fitScale({ width: 600, height: 820 }, 1200, 760), 0.5);
  assert.equal(R.fitScale({ width: 1400, height: 380 }, 1200, 760), 0.5);
});

// ---------------------------------------------------------------- the frozen screens
test('the frozen screens are markup only: no script, no inline handler, no javascript: URL; every picture is a file the app serves; each shows what its scene is for', () => {
  assert.deepEqual(frozen.viewport, { width: 1200, height: 760 });
  assert.deepEqual(frozen.html, { lang: 'zh-CN' });
  assert.deepEqual(frozen.scenes.map((s: Any) => [s.id, s.name]), [['group', '群聊'], ['cards', '卡片'], ['confirm', '确认'], ['settings', '设置'], ['new', '新建']]);
  const R = rules();
  for (const scene of frozen.scenes) for (const mode of MODES) {
    const body: string = R.bodyOf(scene, mode);
    assert.match(body, /^<body[\s>][\s\S]*<\/body>$/, scene.id);
    assert.doesNotMatch(body, /<script|<noscript|<iframe|<object|<embed/i, scene.id + ': runs nothing');
    assert.doesNotMatch(body, /\son[a-z]+\s*=/i, scene.id + ': no inline handler');
    assert.doesNotMatch(body, /javascript:/i, scene.id);
    assert.doesNotMatch(body, /\sautofocus\b/i, scene.id + ': takes no focus');
    for (const [, src] of body.matchAll(/<(?:img|image|source|video)\b[^>]*?\s(?:src|href|srcset|poster)="([^"]*)"/g)) {
      assert.ok(src!.startsWith('data:') || (src!.startsWith('/') && existsSync(join(root, 'client/public', src!.split(/[?#]/)[0]!))), `${scene.id}: ${src} is served by the app`);
    }
    assert.doesNotMatch(body, /(?:src|href)="(?:https?:)?\/\//i, scene.id + ': nothing from another site');
    assert.match(body, /<div [^>]*id="thread"[^>]*data-lab-scroll="end"|id="thread"[^>]*data-lab-scroll="end"/, scene.id + ': the conversation scrolled to its end, as it was');
  }
  const body = (id: string) => R.bodyOf(frozen.scenes.find((s: Any) => s.id === id), 'light') as string;
  // 群聊: the open group, a sidebar with an unread count and 等你确认, cats in their own colours, the composer.
  assert.match(body('group'), /class="title-name">产品评审</);
  assert.match(body('group'), /class="cl-count"[^>]*>2</);
  assert.match(body('group'), /<span>等你确认<\/span>/);
  assert.match(body('group'), /class="thread-inner grpchat/);
  assert.match(body('group'), /id="input"/);
  // 卡片: 砚砚's checklist with ticks, the diff, the owner's code in a bubble.
  assert.match(body('cards'), /class="title-name">砚砚</);
  assert.match(body('cards'), /ck-checklist/); assert.match(body('cards'), /ck-diff/);
  assert.match(body('cards'), /class="bubble"[\s\S]*?class="code-block/);
  // 确认: the request card with both answers and the 等你确认 line over the composer.
  assert.match(body('confirm'), /class="title-name">鲸鲸</);
  assert.match(body('confirm'), />不用</); assert.match(body('confirm'), />设上</);
  // 设置: 通用 with a select and a switch, over the app.
  assert.match(body('settings'), /<div [^>]*class="setpage"(?![^>]*hidden)/);
  assert.match(body('settings'), /<option value="system" selected="">跟随系统/);
  assert.match(body('settings'), /role="switch"/);
  // And, since item 48, the 配色 choices right under 主题 (each swatch in its own palette; the lab ticks the one shown).
  assert.match(body('settings'), /<div class="setrow cc-row">[\s\S]*?role="radiogroup"/);
  assert.equal((body('settings').match(/class="cc-swatch colors-swatch" data-colors="[a-z]+"/g) || []).length, 11);
  // 新建: the dialog over the scrim, 墨墨 picked and a name typed, 取消 and 创建.
  assert.match(body('new'), /class="modal qc-modal"/);
  assert.match(body('new'), /value="年糕"/);
  assert.match(body('new'), />取消</); assert.match(body('new'), />创建</);
  const size = Buffer.byteLength(read('client/public/theme-lab/scenes.json'));
  assert.ok(size < 600 * 1024, `${(size / 1024).toFixed(0)} KB of frozen screens`);
});

test('the script that freezes the screens refuses anything but the staged showcase, before it loads or opens anything, and the instance on 3210 without asking it', async () => {
  const before = read('client/public/theme-lab/scenes.json');
  const empty = mkdtempSync(join(tmpdir(), 'no-playwright-'));
  const run = (base: string) => new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, ['scripts/theme-lab/scenes.mjs'], { cwd: root, env: { ...process.env, BASE: base, PLAYWRIGHT_MODULES: empty }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => done({ code, out }));
  });
  try {
    const live = await run('http://127.0.0.1:3210/');
    assert.equal(live.code, 1);
    assert.match(live.out, /never the instance on 3210/);
    const cases: Array<[string, (path: string) => [number, string]]> = [
      ['a real instance with the same cat names', (path) => path === '/xbot-api/bots' ? [200, JSON.stringify({ bots: [{ name: '宪宪' }] })] : [404, '{"error":"not found"}']],
      ['the plain preview', (path) => path === '/__preview' ? [200, JSON.stringify({ preview: true, scene: 'plain', staged: false, plays: [] })] : [404, '{}']],
      ['the showcase before its chats are staged', (path) => path === '/__preview' ? [200, JSON.stringify({ preview: true, scene: 'showcase', staged: false, plays: [] })] : [404, '{}']],
      ['a page that is not JSON', () => [200, '<!doctype html><title>x</title>']],
    ];
    for (const [what, answer] of cases) {
      const seen: string[] = [];
      const server = createServer((req, res) => { seen.push(req.method + ' ' + req.url); const [code, body] = answer(req.url!.split('?')[0]!); res.writeHead(code, { 'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json' }); res.end(body); });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const { port } = server.address() as { port: number };
      const { code, out } = await run(`http://127.0.0.1:${port}/`);
      await new Promise<void>((done) => server.close(() => done()));
      assert.equal(code, 1, what);
      assert.match(out, /is not the showcase with its chats staged \(its GET \/__preview did not say so\), so nothing was opened or frozen/, what);
      assert.doesNotMatch(out, /Playwright/, what + ': refused before Playwright is even looked for');
      assert.deepEqual(seen, ['GET /__preview'], what + ': it only asked what BASE is');
    }
  } finally { rmSync(empty, { recursive: true, force: true }); }
  assert.equal(read('client/public/theme-lab/scenes.json'), before, 'nothing was written');
  const script = read('scripts/theme-lab/scenes.mjs');
  assert.match(script, /process\.env\.PLAYWRIGHT_MODULES/);
  assert.match(script, /timezoneId: zone/);
  assert.match(script, /TZ=Asia\/Shanghai npm run showcase/);
  assert.match(script, /has no unread count: the chats are not as staged \(restart the showcase\)/, 'it refuses chats someone already opened');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies }).includes('playwright'), 'Playwright is not a dependency');
});

// ---------------------------------------------------------------- review only
test('the lab is review only: nothing in the product links it, it keeps nothing of the app\'s, it asks no other site, and its own page uses only the app\'s tokens', () => {
  for (const file of readdirSync(new URL('../client/public/', import.meta.url)).filter(f => /\.(js|css|html)$/.test(f))) {
    // (Naming the generator, scripts/theme-lab/palettes.mjs, in a comment is not a link: the 配色 come from it since item 48.)
    assert.doesNotMatch(read('client/public/' + file), /(?<!scripts\/)theme-lab/, file + ' does not link the lab');
  }
  assert.doesNotMatch(read('client/index.html'), /(?<!scripts\/)theme-lab/);
  const own = ['index.html', 'lab.css', 'lab.js', 'lab-rules.js'].map(f => [f, read('client/public/theme-lab/' + f)] as const);
  assert.deepEqual(readdirSync(new URL('../client/public/theme-lab/', import.meta.url)).sort(), ['index.html', 'lab-rules.js', 'lab.css', 'lab.js', 'palettes.json', 'scenes.json']);
  for (const [file, source] of own) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|xbot-theme/, file + ' writes nothing the app keeps');
    assert.doesNotMatch(source, /\b(?:https?|wss?):\/\//i, file + ' names no other site');
    assert.doesNotMatch(source, /fetch\(\s*["'`]\/(?!\/)/, file + ' reads only its own files');
  }
  const js = read('client/public/theme-lab/lab.js');
  assert.deepEqual([...js.matchAll(/get\("([^"]+)"\)/g)].map(m => m[1]), ['palettes.json', 'scenes.json']);
  assert.match(js, /window\.open\("\/", "clowder-theme-lab"\)/, '在应用里试 opens the app itself');
  assert.match(js, /style\.id = R\.TRY_ID/);
  assert.doesNotMatch(js, /setAttribute\("data-theme"[^)]*app|app\.document\.documentElement\.setAttribute/, 'light or dark in the app window stays the app\'s');
  // Since item 48 the app may be set to a 配色 of its own: in its window 拿铁 is written out, not left to the app.
  assert.match(js, /const css = R\.overrideCss\(p, true\);/, '拿铁 is written out in the app window');
  assert.ok(rules().overrideCss(palettes[0], true).startsWith('html:root:root{--x-win:' + palettes[0].light.tokens['--x-win'] + ';'));
  assert.match(js, /appTimer = setInterval\(paintApp, 400\)/, 'and adds it again after the app reloads');
  // The frames in the overview cannot be focused or pointed at; the whole tile is one button.
  assert.match(js, /frames\.inert = true;/);
  assert.match(js, /frame\.setAttribute\("tabindex", "-1"\)/);
  assert.match(js, /for \(const type of \["click", "auxclick", "submit", "dragstart", "dblclick"\]\) doc\.addEventListener\(type, stop, true\);/, 'nothing in a frozen screen acts');
  // Only tokens: no colour of its own, motion on the app's durations and none when reduced motion is asked for.
  const css = read('client/public/theme-lab/lab.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'tokens only');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n\s+\.tl-view\[open\] \{ animation: none; \}/);
  assert.match(css, /\.tl-open:focus-visible::after \{ outline: 2px solid var\(--accent\)/, 'a visible focus ring round the whole tile');
  const page = read('client/public/theme-lab/index.html');
  assert.match(page, /<title>配色样页<\/title>/);
  assert.equal((page.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(page, /<dialog class="tl-view" id="view" aria-labelledby="view-name">/);
  for (const label of ['上一套', '下一套', '关闭']) assert.match(page, new RegExp(`aria-label="${label}"`));
});

test('every file of the lab is recorded in the frontend manifest with its current digest, as the template lab\'s are', () => {
  const manifest = JSON.parse(read('docs/xbot-frontend-manifest.json'));
  for (const file of readdirSync(new URL('../client/public/theme-lab/', import.meta.url))) {
    const target = 'client/public/theme-lab/' + file;
    const entry = manifest.extensions.find((e: Any) => e.target === target);
    assert.ok(entry, target + ' is in the manifest');
    assert.equal(entry.sha256, createHash('sha256').update(readFileSync(join(root, target))).digest('hex'), target + ' digest');
    assert.match(entry.attribution, /review prototype, not loaded by production pages/);
  }
});
