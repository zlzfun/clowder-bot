import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
// @ts-expect-error plain module without types
import { buildPalettes, colorsCss, windowTable, bootHtml, pressedBubble, MARK_SURFACES, RING_SHARE, mixed } from '../scripts/theme-lab/palettes.mjs';
// @ts-expect-error plain module without types
import { contrast, hexToOklch } from '../scripts/theme-lab/color.mjs';
import { declarations, specificity, applies } from './css-rank.js';
import { Doc, El, text } from './fake-dom.js';

// 配色 (docs/xbot-frontend.md item 48): the colour lab's eleven palettes as a
// setting in 设置 → 通用, kept per device like 主题. 拿铁 is cafe-theme.css and
// the default (no attribute); the other ten are html[data-colors="<id>"] in the
// generated cafe-colors.css, set before the first paint by the boot script. The
// names, order and colours come from one generator; its rules out-rank the
// café's without !important; the boot script falls back to 拿铁 on anything it
// cannot read; the settings control is a radio group that applies at once; and
// every shape drawn in the primary colour stays visible in every palette.
const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const palettes: Any[] = JSON.parse(read('client/public/theme-lab/palettes.json'));
const index = read('client/index.html');
const styles = [...index.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]!);
const MODES = ['light', 'dark'] as const;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function colorsRules() {
  const window: Any = {};
  vm.runInNewContext(read('client/public/colors-rules.js'), { window });
  return window.ClowderColorsRules;
}

// ---------------------------------------------------------------- the eleven
test('the eleven 配色 are the colour lab\'s palettes, in its order and with its names; 拿铁 is the default and anything else is 拿铁', () => {
  const R = colorsRules();
  assert.deepEqual(plain(R.COLORS.map((c: Any) => [c.id, c.name])), palettes.map(p => [p.id, p.name]));
  assert.deepEqual(plain(R.COLORS.map((c: Any) => c.name)), ['拿铁', '燕麦', '肉桂', '黑咖', '抹茶', '海盐', '莓果', '伯爵', '蜂蜜', '冷萃', '薄荷可可']);
  assert.equal(R.KEY, 'xbot-colors');
  assert.equal(R.DEFAULT, 'latte');
  assert.equal(palettes.find(p => p.current).id, R.DEFAULT, '拿铁 is today\'s cafe-theme.css');
  for (const unknown of [null, undefined, '', 'mocha', 'LATTE', '__proto__', 'toString', 42, {}]) assert.equal(R.pick(unknown), 'latte', String(unknown));
  assert.equal(R.pick('honey'), 'honey');
  assert.equal(R.attr('latte'), null, '拿铁 is no attribute');
  assert.equal(R.attr('nonsense'), null);
  assert.equal(R.attr('coldbrew'), 'coldbrew');
  assert.equal(R.nameOf('mintchoco'), '薄荷可可');
  assert.equal(R.step('latte', -1), 'mintchoco');
  assert.equal(R.step('mintchoco', 1), 'latte');
  assert.equal(R.step('honey', 1), 'coldbrew');
});

test('cafe-colors.css and the boot script\'s window colours are exactly what scripts/theme-lab/palettes.mjs writes', () => {
  const generated = buildPalettes();
  assert.equal(read('client/public/cafe-colors.css'), colorsCss(generated), 'run node scripts/theme-lab/palettes.mjs');
  assert.equal(index, bootHtml(index, generated), 'the boot table is the generator\'s');
  assert.ok(index.includes(windowTable(palettes)));
  const check = spawnSync(process.execPath, ['scripts/theme-lab/palettes.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

// ---------------------------------------------------------------- the stylesheet
test('each palette\'s rules out-rank cafe-theme.css and app.css without !important, in both modes, on a code block and in the owner\'s bubble; 拿铁 has no rule on the page, only its swatch', () => {
  const css = read('client/public/cafe-colors.css');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /!important/);
  assert.ok(styles.indexOf('/cafe-colors.css') === styles.indexOf('/cafe-theme.css') + 1, 'loaded right after cafe-theme.css');
  const mine = declarations(css);
  const SYN = Object.keys(palettes[0].light.syn.code);
  // The café's rules that set a palette's colours, from every stylesheet before it.
  const names = new Set([...Object.keys(palettes[1].light.tokens), ...SYN]);
  const cafe = styles.slice(0, styles.indexOf('/cafe-colors.css')).flatMap(href => declarations(read('client/public' + href)).filter(d => names.has(d.prop)));
  assert.ok(cafe.some(d => d.selector === ':root') && cafe.some(d => d.selector === 'html[data-theme="dark"] .bubble .code-block'));
  for (const p of palettes) {
    const own = mine.filter(d => d.selector.includes(`[data-colors="${p.id}"]`));
    // Every selector is scoped to this palette: on <html>, or on its swatch.
    for (const d of own) assert.match(d.selector, new RegExp(`^(?:html\\[data-colors="${p.id}"\\]|(?:html\\[data-theme="dark"\\] )?\\.colors-swatch\\[data-colors="${p.id}"\\])`), d.selector);
    const swatch = (dark: boolean) => Object.fromEntries(own.filter(d => d.selector === (dark ? 'html[data-theme="dark"] ' : '') + `.colors-swatch[data-colors="${p.id}"]`).map(d => [d.prop, d.value]));
    for (const mode of MODES) assert.deepEqual(swatch(mode === 'dark'), p[mode].tokens, `${p.id} ${mode}: its swatch carries all its tokens`);
    if (p.current) { assert.ok(own.every(d => d.selector.includes('.colors-swatch')), '拿铁: nothing on <html>'); continue; }
    for (const dark of [false, true]) for (const bubble of [false, true]) for (const kind of ['tokens', 'syntax'] as const) {
      if (kind === 'tokens' && bubble) continue;
      const pick = (d: Any) => (kind === 'syntax') === SYN.includes(d.prop);
      const onPage = own.filter(d => d.selector.startsWith('html[data-colors') && pick(d) && !d.selector.includes('message-target') && applies(d.selector, dark, bubble));
      const top = Math.max(...onPage.map(d => specificity(d.selector)));
      const cafeTop = Math.max(...cafe.filter(d => pick(d) && applies(d.selector, dark, bubble)).map(d => specificity(d.selector)));
      assert.ok(top > cafeTop, `${p.id} ${kind} ${dark ? 'dark' : 'light'}${bubble ? ' bubble' : ''}: ${top} > ${cafeTop}`);
      // The one rule that decides carries the values meant for that place, all of them.
      const deciding = onPage.filter(d => specificity(d.selector) === top);
      assert.equal(new Set(deciding.map(d => d.selector)).size, 1, 'one rule decides');
      const meant = kind === 'tokens' ? p[dark ? 'dark' : 'light'].tokens : p[dark ? 'dark' : 'light'].syn[bubble ? 'user' : 'code'];
      assert.deepEqual(Object.fromEntries(deciding.map(d => [d.prop, d.value])), meant, `${p.id} ${kind} ${dark ? 'dark' : 'light'}${bubble ? ' bubble' : ''}`);
    }
  }
});

// ---------------------------------------------------------------- before the first paint
function boot(storage: Record<string, string> | 'throws' | 'missing', dark = false) {
  const src = /<head>[\s\S]*?<script>\n([\s\S]*?)<\/script>/.exec(index)![1]!;
  const attrs = new Map<string, string>();
  const meta = { content: '#F0E5D6', setAttribute(_k: string, v: string) { this.content = v; } };
  const document = { documentElement: { setAttribute: (k: string, v: unknown) => attrs.set(k, String(v)) }, getElementById: (id: string) => (id === 'theme-color' ? meta : null) };
  const context: Any = { document, matchMedia: () => ({ matches: dark }), Object };
  if (storage === 'missing') Object.defineProperty(context, 'localStorage', { get() { throw new Error('SecurityError'); } });
  else context.localStorage = { getItem: (k: string) => { if (storage === 'throws') throw new Error('denied'); return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; } };
  vm.runInNewContext(src, context);
  return { theme: attrs.get('data-theme'), colors: attrs.get('data-colors') ?? null, meta: meta.content, leaked: Object.keys(context).filter(k => !['document', 'matchMedia', 'Object', 'localStorage'].includes(k)) };
}
test('the boot script puts the chosen 配色 on <html> before any stylesheet, with its window colour on the browser\'s bar; anything it cannot read is 拿铁', () => {
  const head = index.slice(0, index.indexOf('</head>'));
  assert.ok(head.indexOf('localStorage.getItem("xbot-colors")') < head.indexOf('<link rel="stylesheet"'), 'before the first stylesheet');
  const win = (id: string, mode: 'light' | 'dark') => palettes.find(p => p.id === id)[mode].tokens['--x-win'];
  assert.deepEqual(boot({ 'xbot-theme': 'dark', 'xbot-colors': 'honey' }), { theme: 'dark', colors: 'honey', meta: win('honey', 'dark'), leaked: [] }, 'nothing leaks into the page\'s globals');
  assert.deepEqual(boot({ 'xbot-theme': 'light', 'xbot-colors': 'coldbrew' }), { theme: 'light', colors: 'coldbrew', meta: win('coldbrew', 'light'), leaked: [] });
  assert.equal(boot({ 'xbot-colors': 'matcha' }, true).meta, win('matcha', 'dark'), 'the system\'s dark');
  for (const stored of ['latte', 'mocha', '__proto__', 'hasOwnProperty', '']) {
    assert.deepEqual(boot({ 'xbot-theme': 'light', 'xbot-colors': stored }), { theme: 'light', colors: null, meta: win('latte', 'light'), leaked: [] }, JSON.stringify(stored));
  }
  assert.deepEqual(boot({ 'xbot-theme': 'dark' }), { theme: 'dark', colors: null, meta: win('latte', 'dark'), leaked: [] }, 'never chosen: 拿铁');
  // A browser that will not read its storage: no error escapes, no attribute, the markup's 拿铁 bar.
  for (const broken of ['throws', 'missing'] as const) assert.deepEqual(boot(broken), { theme: undefined, colors: null, meta: '#F0E5D6', leaked: [] }, broken);
  assert.match(index, /<meta name="theme-color" content="#F0E5D6" id="theme-color">/);
});

// ---------------------------------------------------------------- 设置 → 通用
const WIN = Object.fromEntries(palettes.map(p => [p.id, p.light.tokens['--x-win']]));
function settings(opts: { attr?: string; storeThrows?: boolean } = {}) {
  const doc = new Doc();
  (doc as Any).documentElement = doc.root;
  const h = (tag: string, cls = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  if (opts.attr) doc.root.setAttribute('data-colors', opts.attr);
  const meta = h('meta'); meta.id = 'theme-color'; meta.setAttribute('content', '#F0E5D6');
  const pane = h('div', 'setpane'); pane.setAttribute('data-spane', 'general');
  const sec = h('div', 'setsec'), rows = h('div', 'setrows'), row = h('div', 'setrow'), tx = h('div', 'tx'), b = h('b'), select = h('select', 'setselect');
  b.textContent = '主题'; tx.append(b); select.id = 'settings-theme'; row.append(tx, select); rows.append(row); sec.append(rows);
  const notify = h('div', 'setsec ck-notify');
  pane.append(sec, notify);
  doc.body.append(meta, pane);
  const store = new Map<string, string>();
  const window: Any = {
    localStorage: { setItem(k: string, v: string) { if (opts.storeThrows) throw new Error('quota'); store.set(k, String(v)); }, getItem: (k: string) => store.get(k) ?? null },
    getComputedStyle: (n: El) => ({ getPropertyValue: (k: string) => (k === '--x-win' ? WIN[n.getAttribute('data-colors') || 'latte'] : '') }),
  };
  const context = vm.createContext({ window, document: doc });
  vm.runInContext(read('client/public/colors-rules.js'), context);
  vm.runInContext(read('client/public/colors.js'), context);
  const group = doc.querySelector('.cc-grid')!;
  const radios = () => group.children;
  const checked = () => radios().filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.dataset.id);
  return { doc, window, store, meta, rows, row, group, radios, checked, said: doc.querySelector('.cc-said')! };
}
test('设置 → 通用: one 配色 row right under 主题, in its card: eleven radios, each a picture of its palette with its name, and nothing else said', () => {
  const s = settings();
  const row = s.rows.children[1]!;
  assert.equal(s.rows.children.length, 2, 'in 主题\'s card');
  assert.ok(row.classList.contains('setrow') && row.classList.contains('cc-row'));
  assert.equal(s.rows.children[0], s.row, 'after 主题');
  const title = row.querySelector('.tx b')!;
  assert.equal(text(title), '配色');
  assert.equal(s.group.getAttribute('role'), 'radiogroup');
  assert.equal(s.group.getAttribute('aria-labelledby'), title.id);
  assert.deepEqual(s.radios().map(r => [r.tagName, r.getAttribute('role'), r.type, r.dataset.id, text(r)]), palettes.map(p => ['BUTTON', 'radio', 'button', p.id, p.name]));
  for (const r of s.radios()) {
    const swatch = r.querySelector('.colors-swatch')!;
    assert.equal(swatch.getAttribute('data-colors'), r.dataset.id, 'drawn in its own palette (cafe-colors.css)');
    assert.equal(r.querySelector('.cc-ring')!.getAttribute('aria-hidden'), 'true', 'the picture is not read out; the name is');
    assert.equal(swatch.querySelectorAll('.cc-card, .cc-bot, .cc-me, .cc-send, .cc-row-on').length, 5);
  }
  // No helper sentence, no description, no save button: the row says its name and the eleven names.
  assert.equal(text(row), '配色' + palettes.map(p => p.name).join(''));
  assert.ok(s.said.hidden);
  assert.equal(row.querySelectorAll('button').length, 11);
  // 拿铁 is chosen and is the group's one tab stop.
  assert.deepEqual(s.checked(), ['latte']);
  assert.deepEqual(s.radios().map(r => r.tabIndex), palettes.map(p => (p.id === 'latte' ? 0 : -1)));
  // What the boot script put on <html> is what is checked.
  assert.deepEqual(settings({ attr: 'berry' }).checked(), ['berry']);
  assert.deepEqual(settings({ attr: 'nonsense' }).checked(), ['latte']);
});

test('choosing applies at once, on <html>, the browser\'s bar and this browser\'s memory; arrows, Home and End choose like a radio group; 拿铁 takes the attribute away', () => {
  const s = settings();
  s.radios().find(r => r.dataset.id === 'honey')!.click();
  assert.equal(s.doc.root.getAttribute('data-colors'), 'honey');
  assert.equal(s.store.get('xbot-colors'), 'honey');
  assert.equal(s.meta.getAttribute('content'), WIN.honey, 'the bar follows the window colour');
  assert.deepEqual(s.checked(), ['honey']);
  assert.equal(s.radios().find(r => r.dataset.id === 'honey')!.tabIndex, 0);
  // Arrows move and choose, round the ends; focus follows.
  s.group.key('ArrowRight');
  assert.equal(s.doc.root.getAttribute('data-colors'), 'coldbrew');
  assert.equal(s.doc.activeElement.dataset.id, 'coldbrew');
  s.group.key('ArrowDown');
  assert.equal(s.store.get('xbot-colors'), 'mintchoco');
  s.group.key('ArrowRight');
  assert.equal(s.doc.root.getAttribute('data-colors'), null, 'round to 拿铁: no attribute');
  assert.equal(s.store.get('xbot-colors'), 'latte');
  assert.equal(s.meta.getAttribute('content'), WIN.latte);
  s.group.key('ArrowLeft');
  assert.deepEqual(s.checked(), ['mintchoco']);
  s.group.key('Home');
  assert.deepEqual(s.checked(), ['latte']);
  s.group.key('End');
  assert.deepEqual(s.checked(), ['mintchoco']);
  s.group.key('ArrowUp');
  assert.deepEqual(s.checked(), ['coldbrew']);
  // Other keys are left alone.
  const ev = s.group.key('a');
  assert.equal(ev.defaultPrevented, false);
  assert.equal(s.group.key('ArrowLeft', { metaKey: true }).defaultPrevented, false);
  assert.deepEqual(s.checked(), ['coldbrew']);
  assert.ok(s.said.hidden, 'nothing to say while the browser keeps it');
});

test('a browser that cannot keep the choice still shows it, and says once, under the choices, that it will not be kept', () => {
  const s = settings({ storeThrows: true });
  s.radios().find(r => r.dataset.id === 'seasalt')!.click();
  assert.equal(s.doc.root.getAttribute('data-colors'), 'seasalt');
  assert.ok(!s.said.hidden);
  assert.equal(text(s.said), '这个浏览器记不住这个选择，重新打开后不会保留。');
  assert.equal(s.said.getAttribute('role'), 'status');
});

test('the page loads the 配色 pieces where they belong: the generated stylesheet right after cafe-theme.css, the control\'s styles with it, the scripts before app.js', () => {
  assert.equal(styles[styles.indexOf('/cafe-theme.css') + 1], '/cafe-colors.css');
  assert.equal(styles[styles.indexOf('/cafe-colors.css') + 1], '/colors.css');
  const scripts = [...index.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]!);
  assert.ok(scripts.indexOf('/colors-rules.js') + 1 === scripts.indexOf('/colors.js'));
  assert.ok(scripts.indexOf('/colors.js') < scripts.indexOf('/app.js'));
  // Distinct from light/dark (data-theme, xbot-theme) and from ⌘K (palette*.js/css).
  for (const file of ['colors-rules.js', 'colors.js', 'colors.css']) assert.doesNotMatch(read('client/public/' + file), /\bpal-|ClowderPalette|xbot-theme"/);
  // The control's own styles use tokens only; the picture uses its palette's.
  assert.doesNotMatch(read('client/public/colors.css').replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i);
  assert.match(read('client/public/colors.css'), /@media \(prefers-reduced-motion: reduce\) \{ \.cc-ring \{ transition: none; \} \}/);
});

// ---------------------------------------------------------------- shapes in the primary colour
// What each declaration that paints with the primary or the accent draws. Focus rings (outline, box-shadow) are
// recognised by their property. fill: a primary fill under --x-on-primary ink; mark: the accent alone on a surface;
// tint: a passing wash; pressed: the owner's bubble while its menu is open; swatch: a 配色 picture's own primary.
const DRAWS: Record<string, 'fill' | 'mark' | 'tint' | 'pressed' | 'swatch'> = {
  'app.css|.dot|background': 'mark', 'app.css|.primary|background': 'fill', 'app.css|.primary:hover|background': 'fill',
  'app.css|.status-dot.ok|background': 'mark', 'app.css|.badge|background': 'mark',
  'app.css|0%|background-color': 'tint', 'app.css|40%|background-color': 'tint', 'app.css|.msg.quote-hit .bubble|background-color': 'tint',
  'app.css|.approval-ico|background': 'fill',
  'app.css|.ask-opt:hover .opt-badge|background': 'fill', 'app.css|.ask-opt:focus-visible .opt-badge|background': 'fill',
  'app.css|.ask-opt.recommend .opt-badge|background': 'fill', 'app.css|.ask-chosen .opt-badge|background': 'fill',
  'app.css|.ask-send|background': 'fill', 'app.css|.ask-chosen .ask-check|color': 'mark', 'app.css|.send.primary:not(:disabled)|background': 'fill',
  'app.css|.toast|background': 'fill', 'app.css|.pin-mark.on|color': 'mark', 'app.css|.pin-mark.on:hover|color': 'mark',
  'app.css|.choice-opt:has(input:checked)|background': 'fill', 'app.css|.choice-opt input|accent-color': 'mark', 'app.css|.check-row input|accent-color': 'mark',
  'app.css|.tip|background': 'fill', 'app.css|.item .preview.st .wd|background': 'mark', 'app.css|.tog.on|background': 'fill',
  'devices.css|.g7-done-ico|background': 'fill', 'devices.css|.g7-switch[aria-checked="true"]|background': 'fill',
  'remotechat.css|.rc-composer:focus-within .rc-send|background': 'fill', 'remotechat.css|.rc-composer:has(textarea:not(:placeholder-shown)) .rc-send|background': 'fill',
  'providers.css|.binding-option[aria-checked=true]::after|color': 'mark', 'providers.css|.provider-card[aria-current="true"]|border-color': 'mark',
  'providers.css|.provider-btn-pri|background': 'fill', 'providers.css|.provider-btn-pri:hover|background': 'fill',
  'skills.css|.skills-settings .btn.pri|background': 'fill', 'skills.css|.nestcard .btn.pri|background': 'fill',
  'skills.css|.skills-settings .btn.pri:hover|background': 'fill', 'skills.css|.nestcard .btn.pri:hover|background': 'fill',
  'skills.css|.nestcard .ck.on|background': 'fill', 'skills.css|.nestcard .ck.on|border-color': 'fill',
  'account.css|.acct .ac-btn.ac-pri|background': 'fill', 'account.css|.acct .ac-btn.ac-pri:hover|background': 'fill',
  'cafe-theme.css|.bubble.message-target|background': 'pressed', 'cafe-theme.css|html[data-theme="dark"] .bubble.message-target|background': 'pressed',
  'cafe-theme.css|.binding-option[aria-checked=true]::after|color': 'mark',
  'cafe-theme.css|.ask-opt:hover .opt-badge|background': 'fill', 'cafe-theme.css|.ask-opt:focus-visible .opt-badge|background': 'fill',
  'cafe-theme.css|.ask-opt.recommend .opt-badge|background': 'fill', 'cafe-theme.css|.ask-chosen .opt-badge|background': 'fill',
  'colors.css|.cc-send|background': 'swatch', 'schedules.css|.sched-day:has(input:checked)|background': 'fill',
  'quick-create.css|.qc-borrow|background': 'fill', 'quick-create.css|.qc-borrow:hover|background': 'fill', 'quick-create.css|.qc-chip:has(input:checked)|background': 'fill',
  'chat-list.css|.cl-count|background': 'fill', 'chat-cards.css|.ck-ask-choice .ask-opt.on .opt-badge|background': 'fill',
  'chat-cards.css|.ck-checks li.on .ck-box|background': 'fill', 'sidebar.css|.avatar.owner|color': 'mark',
};
const FAMILY = /var\(--(?:x-primary|x-primary-hover|primary|primary-hover|accent|accent-ink|accent-soft|send|ring|provider-accent)\)/;
const ACCENT = /var\(--(?:accent|accent-ink|ring|provider-accent)\)/;
const PRIMARY = /var\(--(?:x-primary|primary|send|x-primary-hover|primary-hover)\)/;
// The sites the owner sees most, each with the surface under it: [where, file|selector|property, token drawn, surfaces, minimum].
const SITES: Array<[string, string, string, string[], number]> = [
  ['the owner\'s face on its tile', 'sidebar.css|.avatar.owner|color', '--accent-ink', ['--x-avatar-bg'], 3],
  ['✓ on the chosen Agent', 'cafe-theme.css|.binding-option[aria-checked=true]::after|color', '--accent-ink', ['--x-card', '--x-popover', '--x-fill-1', '--x-fill-2'], 3],
  ['等你确认 in a sidebar row, also hovered or selected', 'app.css|.item .preview.st .wd|background', '--accent', ['--x-win', '--x-fill-2', '--x-fill-3'], 3],
  ['a pinned cat\'s mark', 'app.css|.pin-mark.on|color', '--accent', ['--x-win', '--x-fill-2', '--x-card'], 3],
  ['the tick beside a chosen answer', 'app.css|.ask-chosen .ask-check|color', '--accent-ink', ['--x-card', '--x-bot-bubble', '--x-fill-1', '--x-fill-2'], 3],
  ['a ticked native box', 'app.css|.check-row input|accent-color', '--accent', ['--x-card', '--x-popover', '--x-fill-1'], 3],
  ['the knob of a switch that is on (桌面通知, 置顶)', 'cafe-theme.css|.g7-switch[aria-checked="true"]::after|background', '--x-on-primary', ['--x-primary'], 3],
  ['the same knob in dark', 'cafe-theme.css|html[data-theme="dark"] .g7-switch[aria-checked="true"]::after|background', '--x-on-primary', ['--x-primary'], 3],
  ['the knob of a skills switch that is on', 'app.css|.tog.on::after|background', '--x-on-primary', ['--x-primary'], 3],
  ['the tick in a checklist', 'chat-cards.css|.ck-checks li.on .ck-box|color', '--x-on-primary', ['--x-primary'], 3],
  ['the tick in a skills box', 'skills.css|.nestcard .ck.on:after|border', '--x-on-primary', ['--x-primary'], 3],
  ['the letter of a chosen answer', 'chat-cards.css|.ck-ask-choice .ask-opt.on .opt-badge|color', '--x-on-primary', ['--x-primary'], 4.5],
  ['the unread count', 'chat-list.css|.cl-count|color', '--x-on-primary', ['--x-primary'], 4.5],
];
test('every shape drawn in the primary colour stays visible in every 配色 and mode: alone on a surface it is the accent at 3:1, on a primary fill its ink is --x-on-primary, and 拿铁 looks as before', () => {
  const all = styles.flatMap(href => declarations(read('client/public' + href)).map(d => ({ file: href.slice(1), ...d })));
  const family = all.filter(d => !d.prop.startsWith('--') && FAMILY.test(d.value));
  // Every such declaration is accounted for, and the table names no rule that is gone.
  const seen = new Set<string>();
  for (const d of family) {
    if (/^(?:outline|outline-color|box-shadow)$/.test(d.prop)) {
      assert.match(d.value, ACCENT, `${d.file} ${d.selector}: a focus ring is the accent or the ring colour`);
      continue;
    }
    const key = `${d.file}|${d.selector}|${d.prop}`;
    seen.add(key);
    assert.ok(DRAWS[key], `${key} paints with the primary or the accent: say what it draws in DRAWS`);
  }
  assert.deepEqual(Object.keys(DRAWS).filter(k => !seen.has(k)), [], 'no stale entries');
  // What the page ends up drawing for each: the last declaration of that selector and property.
  const last = (selector: string, prop: string) => all.filter(d => d.selector === selector && d.prop === prop).at(-1)!;
  for (const [key, kind] of Object.entries(DRAWS)) {
    const [, selector, prop] = key.split('|') as [string, string, string];
    const v = last(selector, prop).value;
    if (kind === 'mark') assert.match(v, ACCENT, `${key}: drawn alone, so in the accent (${v})`);
    if (kind === 'fill') assert.match(v, PRIMARY, `${key}: a fill under the primary\'s ink, so the primary (${v})`);
  }
  // The audited sites, as the page draws them.
  for (const [where, key, token] of SITES) {
    const [file, selector, prop] = key.split('|') as [string, string, string];
    const d = last(selector, prop);
    assert.ok(d && d.file === file, `${where}: ${key} is the rule that draws it (${d?.file})`);
    assert.ok(new RegExp(`var\\(${token}\\)|var\\(--primary-text\\)`).test(d.value), `${where}: ${d.value} draws ${token}`);
  }
  // The numbers, per palette and mode.
  const resolve = (t: Any, name: string) => (t[name].startsWith('var(') ? t[t[name].slice(4, -1)] : t[name]);
  for (const p of palettes) for (const mode of MODES) {
    const t = p[mode].tokens, at = `${p.id} ${mode}`;
    for (const [where, , token, under, min] of SITES) for (const bg of under) {
      const c = contrast(resolve(t, token), resolve(t, bg));
      assert.ok(c >= min - 0.005, `${at}: ${where}, ${token} on ${bg} is ${c.toFixed(2)}:1 (needs ${min})`);
    }
    // Every mark and focus ring: the accent family against every surface it can sit on.
    for (const token of ['--accent', '--accent-ink', '--ring']) for (const bg of MARK_SURFACES) {
      const c = contrast(resolve(t, token), resolve(t, bg));
      assert.ok(c >= 2.995, `${at}: ${token} on ${bg} is ${c.toFixed(2)}:1`);
    }
    // A message row's ring is the ring colour at 70% over the chat card.
    assert.ok(contrast(mixed(resolve(t, '--ring'), t['--x-card'], RING_SHARE), t['--x-card']) >= 2.995, `${at}: the message ring`);
    // Every fill: its words and glyphs on the primary and on the primary under the pointer.
    for (const bg of ['--x-primary', '--x-primary-hover']) assert.ok(contrast(t['--x-on-primary'], t[bg]) >= 4.495, `${at}: --x-on-primary on ${bg}`);
    // The owner's bubble while its menu is open keeps its words readable.
    const pressed = pressedBubble(t) ?? t['--x-primary-hover'];
    assert.ok(contrast(t['--x-user-bubble-text'], pressed) >= 4.495, `${at}: the pressed bubble`);
    if (!p.current && pressedBubble(t)) assert.ok(read('client/public/cafe-colors.css').includes(`html[data-colors="${p.id}"]${mode === 'dark' ? '[data-theme="dark"]' : ':not([data-theme="dark"])'} .bubble.message-target {\n  background: ${pressed};`), `${at}: its pressed bubble is in cafe-colors.css`);
  }
  // 拿铁 does not change: its accent, ring and provider accent are its primary, and the knob that was white
  // (or the card in dark) is now --x-on-primary, which is the card in light and a hair from it in dark.
  const cafe = read('client/public/cafe-theme.css');
  for (const name of ['--accent', '--accent-ink', '--ring']) assert.match(cafe, new RegExp(`${name}: var\\(--x-primary\\);`));
  assert.match(cafe, /--provider-accent: var\(--accent\);/);
  const latte = palettes[0];
  assert.equal(latte.light.tokens['--x-on-primary'], latte.light.tokens['--x-card']);
  const [l1, a1, b1] = toLab(latte.dark.tokens['--x-on-primary']), [l2, a2, b2] = toLab(latte.dark.tokens['--x-card']);
  assert.ok(Math.hypot(l1 - l2, a1 - a2, b1 - b2) < 0.02, '拿铁 dark: --x-on-primary is within 0.02 (OKLab) of --x-card');
  assert.ok(Math.hypot(...toLab('#ffffff').map((v, i) => v - toLab(latte.light.tokens['--x-on-primary'])[i]!)) < 0.02, '拿铁 light: the knob was white, now within 0.02 of it');
});
// OKLCH → OKLab (L, a, b) of a hex colour.
function toLab(hex: string): [number, number, number] {
  const [l, c, h] = hexToOklch(hex) as [number, number, number];
  return [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
}

// ---------------------------------------------------------------- the other pages
test('the other pages that follow light and dark: the product page follows the 配色; the guide, the runtime panel and the labs stay as they are, and say nothing of it', () => {
  // The guide's pictures are 拿铁 (showcase/shots); its page follows the system's light or dark only.
  const tour = read('showcase/index.html');
  assert.match(tour, /href="\/cafe-theme\.css"/);
  assert.doesNotMatch(tour, /cafe-colors|xbot-colors|data-colors/);
  // The runtime panel has its own colours (runtime.css) and follows the system's light or dark, as before.
  const runtime = read('client/public/runtime.html');
  assert.doesNotMatch(runtime, /cafe-theme|cafe-colors|xbot-colors/);
  // The template lab keeps its own theme state; the colour lab shows every palette, and frames carry no attribute.
  assert.doesNotMatch(read('client/public/template-lab/index.html'), /cafe-colors\.css|xbot-colors/);
  assert.doesNotMatch(read('client/public/theme-lab/lab.js') + read('client/public/theme-lab/lab-rules.js'), /data-colors"|xbot-colors/);
});
