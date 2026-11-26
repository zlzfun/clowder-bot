import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Doc, El } from './fake-dom.js';

// The details panel beside the chat, or the drawer over it (docs/xbot-frontend.md
// item 50): chat-panel.js decides from the card's own width and puts one class on
// it; chat-panel.css lays out from that class; app.js asks the module what follows
// (the scrim, Escape, whether the history is covered, what a chat link puts away)
// and shares the chip's path with a cat's face beside its reply. The module runs in
// a VM over the small DOM of tests/fake-dom.ts; app.js's own functions are taken out
// of it and run with the shell faked, the way the other app.js tests do.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const app = read('client/public/app.js');
const take = (name: string) => {
  const m = new RegExp(`\\n {2}(?:async )?function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`).exec(app);
  assert.ok(m, name + ' is where the shell keeps it');
  return m![0];
};
const css = read('client/public/chat-panel.css');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------- the module
type Opts = { card?: number; panel?: number; viewport?: number; peer?: boolean; open?: boolean; observer?: boolean };
function place(opts: Opts = {}) {
  const doc = new Doc();
  const h = (tag: string, cls = '', id = '') => { const e = doc.createElement(tag); if (cls) e.className = cls; if (id) e.id = id; return e; };
  const main = h('main', 'main'), chat = h('div', 'chat'), thread = h('div', 'thread', 'thread'), chip = h('button', 'top-title', 'head-chip');
  const panel = h('aside', 'panel' + (opts.open ? ' open' : ''), 'panel');
  chat.append(chip, thread);
  main.append(chat, panel);
  doc.body.append(main);
  Object.assign(main, { clientWidth: opts.card ?? 1152 });
  Object.assign(panel, { offsetWidth: opts.panel ?? 384 });
  const sized: Array<{ target: Any; cb: () => void }> = [];
  class FakeSize { constructor(private cb: () => void) {} observe(target: Any) { sized.push({ target, cb: this.cb }); } }
  const listeners: Record<string, () => void> = {};
  let selection: Any = { isCollapsed: true, toString: () => '' };
  const window: Any = {
    innerWidth: opts.viewport ?? 1440,
    addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; },
    getSelection: () => selection,
    ...(opts.observer === false ? {} : { ResizeObserver: FakeSize }),
  };
  vm.runInNewContext(read('client/public/chat-panel.js'), { window });
  const P = window.ClowderPanel;
  const log: string[] = [];
  const beside = () => main.classList.contains('pb-beside');
  P.init({
    main, panel, thread, chip,
    open: () => panel.classList.contains('open'),
    keep: () => { log.push('keep:' + (beside() ? 'beside' : 'drawer')); return () => log.push('restore:' + (beside() ? 'beside' : 'drawer')); },
    changed: (now: boolean) => log.push('changed:' + now),
    toggle: () => log.push('toggle'),
    peer: () => !!opts.peer,
  });
  // The card changes width (the window, the sidebar's grip, the rail, the desktop shell's margins).
  const card = (width: number, viewport = window.innerWidth) => {
    main.clientWidth = width; window.innerWidth = viewport;
    for (const o of sized) if (o.target === main) o.cb();
  };
  return { doc, h, main, chat, thread, chip, panel, P, log, beside, card, window, listeners, sized, select: (text: string) => { selection = { isCollapsed: !text, toString: () => text }; } };
}

test('item 50: one decision from the card itself — beside where the card holds the panel and a chat of 420px on a desktop window, else the drawer', () => {
  const { P } = place();
  assert.equal(P.CHAT, 420, 'the chat\'s reading column (100% - 64px) is then never narrower than a phone\'s (390 - 32)');
  assert.equal(P.fits(384 + 420, 384, 768), true);
  assert.equal(P.fits(384 + 419, 384, 1440), false, 'one pixel short: the drawer');
  assert.equal(P.fits(4000, 384, 767), false, 'a phone window never, however wide its card');
  // The card is what the window leaves after the sidebar (and the shell's 8px right margin).
  const card = (viewport: number, sidebar: number) => viewport - sidebar - 8;
  const cases: Array<[string, number, number, number, boolean]> = [
    ['1440, sidebar 280', 1440, 280, 384, true],
    ['1280, sidebar at its widest (360)', 1280, 360, 384, true],
    ['1100, sidebar 280', 1100, 280, 384, true],
    ['1100, sidebar 360', 1100, 360, 384, false],
    ['1024, sidebar 280', 1024, 280, 384, false],
    ['1024, rail (72)', 1024, 72, 384, true],
    ['900, rail, the 340px panel below 960', 900, 72, 340, true],
    ['800, rail', 800, 72, 340, false],
  ];
  for (const [what, viewport, sidebar, panel, want] of cases) assert.equal(P.fits(card(viewport, sidebar), panel, viewport), want, what);
});

test('the class on the card is the one source: set at once and whenever the card\'s width changes, from the room alone — never from the open state; the shell hears each change once', () => {
  const s = place({ card: 1152 });
  assert.equal(s.beside(), true);
  assert.equal(s.P.beside(), true, 'beside() reads the class');
  assert.deepEqual(s.log, ['changed:true']);
  assert.equal(s.sized.some((o) => o.target === s.main), true, 'it watches the card, not only the window');
  s.log.length = 0;
  s.card(736); // the sidebar widened: no window resize
  assert.equal(s.beside(), false);
  assert.deepEqual(s.log, ['changed:false'], 'closed: the chat keeps its width, nothing to keep');
  s.card(700);
  assert.deepEqual(s.log, ['changed:false'], 'the same mode again says nothing');
  // Opening or closing never moves the mode.
  s.panel.classList.add('open'); s.P.sync();
  assert.equal(s.beside(), false);
  s.card(944, 1024); // into the rail
  assert.equal(s.beside(), true);
  // The 340px panel below 960 is measured, not assumed.
  const narrow = place({ card: 760, panel: 340, viewport: 900 });
  assert.equal(narrow.beside(), true);
  // Without ResizeObserver the window's resize still decides.
  const old = place({ card: 1152, observer: false });
  assert.equal(old.beside(), true);
  old.main.clientWidth = 600; old.listeners.resize!();
  assert.equal(old.beside(), false);
});

test('a change of mode while the panel is open keeps the reading place across its one reflow (noted before, put back after); closed, there is nothing to keep', () => {
  const s = place({ card: 1152, open: true });
  s.log.length = 0;
  s.card(736);
  assert.deepEqual(s.log, ['keep:beside', 'restore:drawer', 'changed:false']);
  s.log.length = 0;
  s.card(1152);
  assert.deepEqual(s.log, ['keep:drawer', 'restore:beside', 'changed:true']);
});

test('opening or closing beside the chat moves its edge: moved() notes the reading place, makes the change, puts it back; as a drawer the change alone', () => {
  const s = place({ card: 1152 });
  s.log.length = 0;
  s.P.moved(() => { s.log.push('change'); s.panel.classList.add('open'); });
  assert.deepEqual(s.log, ['keep:beside', 'change', 'restore:beside']);
  const d = place({ card: 700 });
  d.log.length = 0;
  d.P.moved(() => d.log.push('change'));
  assert.deepEqual(d.log, ['change'], 'the drawer covers the chat without moving it');
});

test('a cat\'s face beside its reply toggles the panel as the chip does: one delegated listener on the history (faces drawn later too); not the neutral tile, not with the chip disabled, not in the two-cat exchange, not for a click that ends a selection or a right click', () => {
  const s = place();
  const row = (marked: boolean) => {
    const r = s.h('div', 'msg bot with-face'), face = s.h('span', 'avatar' + (marked ? ' pb-face' : '')), art = s.h('svg'), body = s.h('div', 'body'), bubble = s.h('div', 'bot-bubble');
    face.append(art); body.append(bubble); r.append(face, body); s.thread.append(r);
    return { r, face, art, bubble };
  };
  const cat = row(true);
  assert.equal(cat.face.listeners.size, 0, 'nothing bound on the face itself: redrawn and repainted rows need nothing');
  cat.art.click();
  assert.deepEqual(s.log.filter((l) => l === 'toggle'), ['toggle'], 'a click on the clay art inside the face');
  cat.face.click();
  assert.equal(s.log.filter((l) => l === 'toggle').length, 2, 'the same toggle: open, then closed');
  // Drawn after init (a redraw, a new reply): the same listener answers.
  const later = row(true);
  later.face.click();
  assert.equal(s.log.filter((l) => l === 'toggle').length, 3);
  // Not targets.
  const unknown = row(false);
  unknown.face.click();
  cat.bubble.click();
  later.r.click();
  assert.equal(s.log.filter((l) => l === 'toggle').length, 3, 'the neutral tile, the bubble and the row are not the face');
  later.face.dispatch('click', { button: 2 });
  assert.equal(s.log.filter((l) => l === 'toggle').length, 3, 'not a right click');
  s.select('早。今天只有一件');
  later.face.click();
  assert.equal(s.log.filter((l) => l === 'toggle').length, 3, 'not a click that ends a text selection');
  s.select('');
  s.chip.disabled = true;
  later.face.click();
  assert.equal(s.log.filter((l) => l === 'toggle').length, 3, 'not while the chip is disabled (no chat, the two-cat exchange)');
  const peer = place({ peer: true });
  const p = peer.h('span', 'avatar pb-face'); peer.thread.append(p); p.click();
  assert.equal(peer.log.filter((l) => l === 'toggle').length, 0, 'not in the read-only exchange between two cats');
});

// ---------------------------------------------------------------- app.js
test('app.js marks only a known cat\'s face, with no tooltip and no tab stop or button of its own, and the chip and the face share one path: the same toggle, remembering, loading and phone handling', async () => {
  // headFace: the face beside a reply.
  const doc = new Doc();
  const ctx: Any = {
    speakerFace: (who: Any) => { const a = doc.createElement('span'); a.className = 'avatar' + (who.paint ? '' : ' glyph'); return a; },
    setTip: (n: El, t: string) => { n.dataset.tip = t; },
  };
  vm.runInNewContext(take('headFace') + 'this.headFace = headFace;', ctx);
  const cat = ctx.headFace({ key: 'bot:cat:c1', name: '宪宪', paint: { seed: '宪宪' } });
  const tile = ctx.headFace({ key: 'bot:name:', name: '系统', paint: null });
  assert.equal(cat.classList.contains('pb-face'), true);
  assert.equal(tile.classList.contains('pb-face'), false, 'a speaker nobody knows: not a cat, not a target');
  assert.equal(cat.dataset.tip, '', 'no tooltip (item 46)');
  assert.doesNotMatch(take('headFace'), /tabIndex|setAttribute\("(role|tabindex|aria-)/, 'the chip and ⌘/Ctrl+\\ are the keyboard\'s way; no tab stop or button on every message');

  // togglePanel: the chip's click, and the face's; closing goes through closePanel (item 51: the × and Escape too).
  const calls: string[] = [];
  const side = doc.createElement('aside'); side.className = 'sidebar open';
  const panel = doc.createElement('aside');
  const shell: Any = {
    panel, sidebar: side, window: { innerWidth: 390 },
    document: { get activeElement() { return doc.activeElement; } }, $: (id: string) => doc.getElementById(id),
    rememberPanel: (open: boolean) => calls.push('remember:' + open),
    closePops: () => calls.push('closePops'),
    panelOpen: (open: boolean) => { calls.push('panelOpen:' + open); panel.classList.toggle('open', open); },
    loadPanel: async () => { calls.push('load'); },
    setStatus: (t: string) => calls.push('status:' + t), visibleError: (e: Error) => e.message,
  };
  vm.runInNewContext(take('togglePanel') + take('closePanel') + 'this.togglePanel = togglePanel;', shell);
  await shell.togglePanel();
  assert.deepEqual(calls, ['remember:true', 'panelOpen:true', 'load']);
  assert.equal(side.classList.contains('open'), false, 'on a phone the list\'s drawer gives way');
  calls.length = 0;
  await shell.togglePanel();
  assert.deepEqual(calls, ['remember:false', 'closePops', 'panelOpen:false'], 'closing loads nothing');
  shell.loadPanel = async () => { throw new Error('读不到'); };
  calls.length = 0;
  await shell.togglePanel();
  assert.deepEqual(calls, ['remember:true', 'panelOpen:true', 'status:读不到']);
  assert.match(app, /\$\("head-chip"\)\.addEventListener\("click", togglePanel\);/);
  assert.match(app, /panelPlace\.init\(\{[\s\S]*?\n\s+toggle: togglePanel,\n/, 'the face goes through the chip\'s own function');
});

test('panelOpen goes through the module only when the open state changes, so the chat\'s edge moves once and the reading place is kept', () => {
  const doc = new Doc();
  const panel = doc.createElement('aside'), chip = doc.createElement('button');
  const calls: string[] = [];
  const ctx: Any = {
    panel, isMac: true, window: {},
    $: () => chip,
    setTip: () => {}, syncBackdrop: () => calls.push('syncBackdrop'),
    panelPlace: { moved: (change: () => void) => { calls.push('moved'); change(); } },
  };
  vm.runInNewContext(take('panelOpen') + 'this.panelOpen = panelOpen;', ctx);
  ctx.panelOpen(true);
  assert.equal(panel.classList.contains('open'), true);
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  ctx.panelOpen(true);
  assert.deepEqual(calls, ['moved', 'syncBackdrop', 'syncBackdrop'], 'already open: nothing moves');
  ctx.panelOpen(false);
  assert.equal(panel.classList.contains('open'), false);
  assert.equal(calls.filter((c) => c === 'moved').length, 2);
});

test('the scrim is only the drawer\'s: beside the chat nothing dims, whatever the window; the phone\'s list drawer keeps its backdrop', () => {
  const doc = new Doc();
  const scrim = doc.createElement('div'); scrim.id = 'panel-scrim'; scrim.hidden = true; doc.body.append(scrim);
  const sidebar = doc.createElement('aside'), backdrop = doc.createElement('div'), panel = doc.createElement('aside');
  const ctx: Any = { window: { innerWidth: 1440 }, sidebar, backdrop, panel, $: (id: string) => doc.getElementById(id), beside: false };
  ctx.panelPlace = { beside: () => ctx.beside };
  vm.runInNewContext(take('syncBackdrop') + 'this.syncBackdrop = syncBackdrop;', ctx);
  panel.classList.add('open');
  ctx.syncBackdrop();
  assert.equal(scrim.hidden, false, 'the drawer over the card: the exposed conversation closes it');
  ctx.beside = true; ctx.syncBackdrop();
  assert.equal(scrim.hidden, true, 'beside the chat: no scrim');
  panel.classList.remove('open'); ctx.beside = false; ctx.syncBackdrop();
  assert.equal(scrim.hidden, true);
  panel.classList.add('open'); ctx.window.innerWidth = 390; sidebar.classList.add('open'); ctx.syncBackdrop();
  assert.equal(backdrop.hidden, false);
  assert.equal(scrim.hidden, true, 'the list\'s drawer on top: its backdrop, not the scrim');
});

// The Escape listener, as app.js registers it.
function escape(opts: { beside: boolean; focus: 'composer' | 'panel'; quote?: boolean }) {
  const m = /\n {2}document\.addEventListener\("keydown", \(ev\) => \{\n {4}if \(ev\.key !== "Escape"\) return;\n[\s\S]*?\n {2}\}\);\n/.exec(app);
  assert.ok(m, 'the Escape listener is where the shell keeps it');
  const doc = new Doc();
  const h = (tag: string, id = '') => { const e = doc.createElement(tag); if (id) e.id = id; return e; };
  const setpage = h('div', 'setpage'); setpage.hidden = true;
  const account = h('div', 'account-menu'); account.hidden = true;
  const chip = h('button', 'head-chip'), input = h('div', 'input'), panel = h('aside', 'panel'), tab = h('button'), sidebar = h('aside');
  panel.append(tab); panel.classList.add('open');
  doc.body.append(setpage, account, chip, input, panel, sidebar);
  (opts.focus === 'panel' ? tab : input).focus();
  const calls: string[] = [];
  const state: Any = { replyTo: opts.quote ? { seq: 3 } : null };
  let listener: (ev: Any) => void = () => {};
  const ctx: Any = {
    document: { addEventListener: (_t: string, fn: (ev: Any) => void) => { listener = fn; }, get activeElement() { return doc.activeElement; } },
    $: (id: string) => doc.getElementById(id), deviceLayerOpen: () => false, hideTip: () => {},
    panelSub: null, panelMore: null, lightbox: { hidden: true }, modal: { hidden: true }, state,
    closePanelSub: () => {}, closePanelMore: () => {}, closeShots: () => {}, closeModal: () => {},
    clearQuote: () => { calls.push('clearQuote'); state.replyTo = null; },
    closePops: () => calls.push('closePops'), panel, sidebar,
    rememberPanel: (open: boolean) => calls.push('remember:' + open),
    panelOpen: (open: boolean) => { calls.push('panelOpen:' + open); panel.classList.toggle('open', open); },
    panelPlace: { beside: () => opts.beside }, syncBackdrop: () => {},
  };
  vm.runInNewContext(m![0] + take('closePanel'), ctx);
  return { press: () => listener({ key: 'Escape' }), calls, panel, chip, doc };
}

test('Escape: the drawer is the layer on top and goes from anywhere (as before); beside the chat the panel is a column — it closes only from inside it, and focus goes to the chip; Escape in the composer keeps its own meanings', () => {
  const drawer = escape({ beside: false, focus: 'composer' });
  drawer.press();
  assert.deepEqual(drawer.calls, ['remember:false', 'closePops', 'panelOpen:false']);
  assert.notEqual(drawer.doc.activeElement, drawer.chip, 'the drawer\'s path is unchanged: focus stays in the composer');
  // Item 51: Escape closes through the same closePanel as the ×, so focus inside the drawer goes to the chip too.
  const drawerInside = escape({ beside: false, focus: 'panel' });
  drawerInside.press();
  assert.deepEqual(drawerInside.calls, ['remember:false', 'closePops', 'panelOpen:false']);
  assert.equal(drawerInside.doc.activeElement, drawerInside.chip);
  const composer = escape({ beside: true, focus: 'composer' });
  composer.press();
  assert.deepEqual(composer.calls, [], 'from the composer the panel beside the chat stays');
  assert.equal(composer.panel.classList.contains('open'), true);
  const inside = escape({ beside: true, focus: 'panel' });
  inside.press();
  assert.deepEqual(inside.calls, ['remember:false', 'closePops', 'panelOpen:false']);
  assert.equal(inside.doc.activeElement, inside.chip, 'focus to the chip that opens it again, not lost to the page');
  const quote = escape({ beside: true, focus: 'composer', quote: true });
  quote.press();
  assert.deepEqual(quote.calls, ['clearQuote'], 'a quote in the composer goes first, as before');
});

test('the history is covered (read receipts wait) under the drawer at any width, never by the panel beside the chat; settings, the picture viewer and the phone\'s list drawer as before', () => {
  const m = /\n\s+obscured: (\(\) => [\s\S]*?),\n\s+focusTask:/.exec(app);
  assert.ok(m, 'experience.init gets obscured');
  const doc = new Doc();
  const setpage = doc.createElement('div'); setpage.id = 'setpage'; setpage.hidden = true; doc.body.append(setpage);
  const panel = doc.createElement('aside'), sidebar = doc.createElement('aside');
  const ctx: Any = { window: { innerWidth: 1440 }, panel, sidebar, lightbox: { hidden: true }, $: (id: string) => doc.getElementById(id), beside: false };
  ctx.panelPlace = { beside: () => ctx.beside };
  const obscured = vm.runInNewContext('(' + m![1] + ')', ctx);
  assert.equal(obscured(), false);
  panel.classList.add('open');
  assert.equal(obscured(), true, 'the drawer and its scrim over the history, at a desktop width too');
  ctx.window.innerWidth = 900;
  assert.equal(obscured(), true, '768–959: the drawer below the header, the scrim over all of it');
  ctx.beside = true;
  assert.equal(obscured(), false, 'beside the chat: the history is in plain view, reading goes on');
  setpage.hidden = false;
  assert.equal(obscured(), true);
  setpage.hidden = true; panel.classList.remove('open'); ctx.window.innerWidth = 390; sidebar.classList.add('open');
  assert.equal(obscured(), true, 'the list\'s drawer on a phone');
  ctx.window.innerWidth = 1440;
  assert.equal(obscured(), false);
});

test('the shell hands the module the card, the panel, the history and the chip; keeps the reading place with the redraws\' own anchor; the scrim follows a change of mode; the remote conversation still closes the panel in both modes', () => {
  const init = /\n {2}panelPlace\.init\(\{\n([\s\S]*?)\n {2}\}\);\n/.exec(app);
  assert.ok(init, 'panelPlace.init next to panelOpen');
  const body = init![1]!;
  assert.match(body, /main: document\.querySelector\("\.main"\), panel, thread, chip: \$\("head-chip"\),/);
  assert.match(body, /keep: \(\) => \{\n\s+const near = live\.following\(\), anchor = near \? null : readingAnchor\(\);\n\s+return \(\) => \{ if \(near\) thread\.scrollTop = thread\.scrollHeight; else keepReading\(anchor\); \};/);
  assert.match(body, /changed: \(\) => syncBackdrop\(\),/);
  assert.match(body, /peer: \(\) => !!state\.peer,/);
  assert.match(app, /const panelPlace = window\.ClowderPanel;/);
  const remote = /\n {2}window\.addEventListener\("xbot:remote-open", \(\) => \{\n([\s\S]*?)\n {2}\}\);\n/.exec(app)![1]!;
  assert.doesNotMatch(remote, /beside/, 'the remote conversation covers the whole card: the panel closes either way');
  assert.match(remote, /panelOpen\(false\);/);
});

// ---------------------------------------------------------------- chat-panel.css and the page
test('chat-panel.css: every rule of the beside layout sits in the 768px query the script keeps too; the panel keeps app.css\'s width; part of the card (no shadow, no corners of its own, from the card\'s top); open, in the row; nothing animates the chat\'s width frame by frame', () => {
  const desk = /@media \(min-width: 768px\) \{([\s\S]*?)\n\}/.exec(bare);
  assert.ok(desk);
  const outside = bare.replace(desk![0], '');
  assert.doesNotMatch(outside, /pb-beside/, 'nothing beside the chat outside the desktop query');
  assert.match(desk![1]!, /\.main\.pb-beside \{ flex-direction: row; \}/);
  assert.match(desk![1]!, /\.main\.pb-beside > \.panel \{ top: 0; border-radius: 0; box-shadow: none; \}/);
  assert.match(desk![1]!, /\.main\.pb-beside > \.panel\.open \{ position: relative; flex: none; \}/);
  assert.doesNotMatch(bare, /(^|[;{\s])(width|max-width|min-width)\s*:/m, 'the panel\'s width stays app.css\'s (340px, 384px from 960px)');
  assert.doesNotMatch(bare, /transition[^;]*\b(width|margin|flex|inset|left|right)\b/, 'the chat changes width once, never frame by frame');
  assert.doesNotMatch(bare, /!important/);
  assert.doesNotMatch(bare, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'colours only from the tokens');
  // Every token it uses exists.
  const defined = new Set([...read('client/public/tokens.css').matchAll(/(--[\w-]+)\s*:/g), ...read('client/public/app.css').matchAll(/(--[\w-]+)\s*:/g), ...read('client/public/cafe-theme.css').matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]));
  for (const [, name] of bare.matchAll(/var\((--[\w-]+)/g)) assert.ok(defined.has(name!), name + ' is an existing token');
});

test('the open chip beside the chat: no standing fill (the line of what the cat is doing runs past it), the hover fill of a toggle with nothing over it, group seams on that fill; item 26\'s drawer rule stays for the drawer', () => {
  assert.doesNotMatch(bare, /\.pb-beside \.top-title\.on \{/, 'open and not hovered it keeps no fill');
  assert.match(bare, /\.main\.pb-beside \.top-title\.on:hover:not\(:disabled\) \{ background: var\(--hover\); \}/);
  assert.match(bare, /\.main\.pb-beside \.top-title\.on:hover:not\(:disabled\) \.avatar\.group \{ --seat-seam: var\(--hover\); \}/);
  assert.match(read('client/public/cafe-theme.css'), /\.top-title\.on,\n\.top-title\.on:hover:not\(:disabled\) \{ background: transparent; z-index: 27; \}/, 'the drawer\'s chip under the scrim, unchanged');
});

test('the face is a pointer target with a restrained cue from existing tokens: a pointer, the rail\'s round fill under a hovering pointer only, a small give when pressed', () => {
  assert.match(bare, /#thread \.pb-face \{\n\s+cursor: pointer;\n\s+transition: background-color 160ms ease-out, box-shadow 160ms ease-out, transform var\(--dur-press\) ease-out;\n\}/);
  assert.match(bare, /@media \(hover: hover\) \{\n\s+#thread \.pb-face:hover \{ background-color: var\(--hover\); box-shadow: 0 0 0 3px var\(--hover\); \}\n\}/);
  assert.match(bare, /#thread \.pb-face:active \{ transform: scale\(var\(--press-scale\)\); \}/);
});

test('the page loads chat-panel.js before app.js (after sidebar.js) and chat-panel.css after sidebar.css, before chat-live.css; both are recorded in the manifest', () => {
  const html = read('client/index.html');
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map((x) => x[1]);
  assert.equal(scripts.indexOf('chat-panel.js'), scripts.indexOf('sidebar.js') + 1);
  assert.ok(scripts.indexOf('chat-panel.js') < scripts.indexOf('app.js'));
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(styles.slice(-4), ['sidebar.css', 'chat-panel.css', 'apps-dialog.css', 'chat-live.css']);
  const manifest = JSON.parse(read('docs/xbot-frontend-manifest.json'));
  for (const f of ['client/public/chat-panel.js', 'client/public/chat-panel.css']) assert.ok(manifest.extensions.some((e: Any) => e.target === f), f + ' is registered');
});

// ---------------------------------------------------------------- item 51: the head's corner and its portrait
// closePanel, as app.js keeps it, with a small DOM: the chip, 返回 and the panel.
function closer(opts: { focus: 'panel' | 'composer' | 'body'; chipDisabled?: boolean; back?: boolean }) {
  const doc = new Doc();
  const h = (tag: string, id = '') => { const e = doc.createElement(tag); if (id) e.id = id; return e; };
  const chip = h('button', 'head-chip'), back = h('button', 'back'), input = h('div', 'input'), panel = h('aside', 'panel'), x = h('button');
  chip.disabled = !!opts.chipDisabled;
  back.hidden = !opts.back;
  panel.append(x); panel.classList.add('open');
  doc.body.append(chip, back, input, panel);
  if (opts.focus === 'panel') x.focus(); else if (opts.focus === 'composer') input.focus();
  // A disabled button takes no focus, as in a browser.
  for (const b of [chip, back]) { const own = b.focus.bind(b); b.focus = () => { if (!b.disabled) own(); }; }
  const calls: string[] = [];
  const ctx: Any = {
    panel, document: { get activeElement() { return doc.activeElement; } }, $: (id: string) => doc.getElementById(id),
    rememberPanel: (open: boolean) => calls.push('remember:' + open), closePops: () => calls.push('closePops'),
    panelOpen: (open: boolean) => { calls.push('panelOpen:' + open); panel.classList.toggle('open', open); },
  };
  vm.runInNewContext(take('closePanel') + 'this.closePanel = closePanel;', ctx);
  return { ...ctx, calls, chip, back, input, x, doc };
}

test('item 51: the panel\'s own × closes it as the chip does (remembered, menus put away), in both forms; focus goes to the chip, to 返回 in the two-cat exchange where the chip is disabled, never to the page', () => {
  const c = closer({ focus: 'panel' });
  c.closePanel(true);
  assert.deepEqual(c.calls, ['remember:false', 'closePops', 'panelOpen:false']);
  assert.equal(c.panel.classList.contains('open'), false);
  assert.equal(c.doc.activeElement, c.chip);
  // A browser that does not focus a clicked button (Safari): the × still hands focus to the chip.
  const safari = closer({ focus: 'body' });
  safari.closePanel(true);
  assert.equal(safari.doc.activeElement, safari.chip);
  // The read-only exchange between two cats: the chip is disabled, so 返回 in the same header.
  const peer = closer({ focus: 'panel', chipDisabled: true, back: true });
  peer.closePanel(true);
  assert.equal(peer.panel.classList.contains('open'), false, 'it closes where the chip cannot');
  assert.equal(peer.doc.activeElement, peer.back);
  // Nothing to take it (no chat open): it closes, and nothing is forced.
  const none = closer({ focus: 'panel', chipDisabled: true });
  none.closePanel(true);
  assert.equal(none.panel.classList.contains('open'), false);
  // Closed from outside the panel (the chip, a face): focus stays where the owner is.
  const outside = closer({ focus: 'composer' });
  outside.closePanel();
  assert.equal(outside.doc.activeElement, outside.input);
});

test('item 51: the corner holds only the ×, built once for every chat (a chat change or a poll never rebuilds it); syncPanelChrome only puts away a sidebar menu acting for the old chat; the corner\'s pencil is gone', () => {
  assert.equal((app.match(/\$\("panel-actions"\)\.replaceChildren\(/g) || []).length, 1, 'the corner is filled once');
  assert.match(app, /const panelX = panelAct\("x", "收起信息"\);\n\s+setTip\(panelX, "收起信息" \+ \(isMac \? " {2}⌘\\\\" : " {2}Ctrl\+\\\\"\)\);\n\s+panelX\.addEventListener\("click", \(\) => closePanel\(true\)\);\n\s+\$\("panel-actions"\)\.replaceChildren\(panelX\);\n\s+\$\("panel-actions"\)\.hidden = false;/);
  assert.doesNotMatch(app, /panelAct\("pencil"/, 'no pencil in the corner');
  assert.doesNotMatch(app, /renameHere/);
  const sync = take('syncPanelChrome');
  assert.doesNotMatch(sync, /panel-actions/, 'the corner is not touched on a repaint');
  let closed = 0;
  const ctx: Any = { state: { sel: null }, profileRules: { key: (sel: Any) => (sel ? sel.type + ':' + sel.id : '') }, closePanelMenu: () => { closed++; } };
  vm.runInNewContext('var chromeBot = "";' + sync + 'this.sync = syncPanelChrome;', ctx);
  ctx.state.sel = { type: 'bot', id: '团子' }; ctx.sync();
  assert.equal(closed, 1);
  ctx.sync(); ctx.sync();
  assert.equal(closed, 1, 'a poll for the same chat keeps an open menu');
  ctx.state.sel = { type: 'group', id: 'g1' }; ctx.sync();
  assert.equal(closed, 2, 'another chat: the old one\'s menu goes');
});

test('item 51: 编辑资料 from the head\'s portrait opens the same dialog with the chat\'s loaded 资料, and closing it (saved, cancelled, Escape) gives focus back to that portrait; gone, to this chat\'s portrait, else the chip', () => {
  assert.match(app, /editProfile: \(data, opener\) => openProfile\(data && data\.name \? data : state\.panelData \|\| \{\}, opener\),/);
  assert.match(take('openProfile'), /profileReturnFocus = opener \|\| document\.activeElement;/);
  const doc = new Doc();
  const h = (tag: string, id = '', cls = '') => { const e = doc.createElement(tag); if (id) e.id = id; if (cls) e.className = cls; return e; };
  const ident = h('div', 'panel-ident'), chip = h('button', 'head-chip'), setpage = h('div', 'setpage'), ok = h('button', 'modal-ok'), cancel = h('button', 'modal-cancel');
  setpage.hidden = true;
  doc.body.append(ident, chip, setpage, ok, cancel);
  const portrait = (cls = 'pf-edit') => { const b = h('button', '', cls); ident.replaceChildren(b); return b; };
  const ctx: Any = {
    modal: h('div'), modalForm: h('form'), modalError: h('p'), settingsSection: 'general',
    $: (id: string) => doc.getElementById(id),
  };
  vm.runInNewContext('var profileReturnFocus = null;' + take('closeModal') + 'this.closeModal = closeModal;', ctx);
  // The portrait it was opened from, still there (the same node for the chat, a new face drawn inside).
  const mine = portrait();
  ctx.profileReturnFocus = mine;
  ctx.closeModal();
  assert.equal(doc.activeElement, mine);
  assert.equal(ctx.profileReturnFocus, null);
  // Gone (another chat's head now): this chat's portrait.
  const old = mine;
  const now = portrait();
  ctx.profileReturnFocus = old;
  ctx.closeModal();
  assert.equal(doc.activeElement, now);
  // A group's head has no portrait button: the chip.
  ident.replaceChildren(h('span', '', 'pf-portrait'));
  ctx.profileReturnFocus = old;
  ctx.closeModal();
  assert.equal(doc.activeElement, chip);
});

test('item 51, review: the drawer form starts below the chat\'s header at every desktop width, so the chip stays in view under the scrim and the head\'s portrait (编辑资料) never lands under the pointer that opened it; the beside form and phones are untouched', () => {
  const desk = /@media \(min-width: 768px\) \{([\s\S]*?)\n\}/.exec(bare)![1]!;
  assert.match(desk, /\n\s+\.main:not\(\.pb-beside\) > \.panel \{ top: var\(--top-h\); \}/, 'in the desktop query: not on phones (app.css\'s fixed sheet there)');
  assert.match(desk, /\n\s+\.in-app:is\(\.os-win, \.os-linux\) \.main:not\(\.pb-beside\) > \.panel \.phdr \{ padding-top: 14px; \}/, 'below the header the window\'s controls are not over the head');
  assert.match(desk, /\.main\.pb-beside > \.panel \{ top: 0;/, 'beside the chat it still reaches the card\'s top');
  // What it overrides: app.css starts the drawer at the card's top from 960px (below the header only at 768–959).
  const appCss = read('client/public/app.css');
  assert.match(appCss, /\.panel \{\n {2}position: absolute; top: 0; bottom: 0; right: 0;/);
  assert.match(appCss, /@media \(max-width: 959px\) and \(min-width: 768px\) \{[\s\S]*?\.panel \{ top: var\(--top-h\);/);
  // Nothing loaded after chat-panel.css moves the panel's top again.
  const html = read('client/index.html');
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map((x) => x[1]!);
  for (const later of styles.slice(styles.indexOf('chat-panel.css') + 1)) {
    assert.doesNotMatch(read('client/public/' + later).replace(/\/\*[\s\S]*?\*\//g, ''), /\.panel\b[^{]*\{[^}]*\btop\s*:/, later + ' leaves the panel\'s top alone');
  }
  // The chip under the scrim, as item 26 has it for the drawer: a click there lands on the scrim, which closes.
  assert.match(read('client/public/cafe-theme.css'), /\.top-title\.on,\n\.top-title\.on:hover:not\(:disabled\) \{ background: transparent; z-index: 27; \}/);
  assert.match(appCss, /\.panel-scrim \{\n {2}position: absolute; inset: 0; z-index: 28;/);
});
