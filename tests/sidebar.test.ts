import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The sidebar's controls (docs/xbot-frontend.md item 43; the owner's reference:
// Grok Bot's sidebar): 搜索 and 新建 at the top of the full sidebar, the
// owner's own face and 应用 at the bottom; in the 72px rail 新建, 应用 and the
// face at the bottom and no 搜索; an animated snap between the two. sidebar.js
// runs here as the classic script it is, in a VM with a small DOM whose
// elements report where they are laid out in the full sidebar and in the rail,
// and an animation timeline that only moves when the test says so. app.js,
// index.html and the stylesheets are checked for their wiring.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Box = { left: number; top: number; width: number; height: number };

// ---------------------------------------------------------------- small DOM
class Anim {
  done = false; cancelled = false; resolve!: () => void; reject!: (e: unknown) => void;
  finished: Promise<void>;
  readonly start: number;
  constructor(readonly el: El, readonly frames: Any[], readonly options: Any, readonly end: number) {
    this.start = el.doc.now;
    this.finished = new Promise((res, rej) => { this.resolve = res; this.reject = rej; });
    this.finished.catch(() => {});
  }
  get currentTime() { return this.cancelled ? null : Math.min(this.end, this.el.doc.now) - this.start; }
  get playState() { return this.cancelled ? 'idle' : this.done ? 'finished' : 'running'; }
  cancel() { if (this.done) return; this.done = true; this.cancelled = true; this.reject(new Error('AbortError')); }
}
class El {
  kids: El[] = []; parent: El | null = null; attrs = new Map<string, string>(); classes = new Set<string>();
  props = new Map<string, string>(); inert = false;
  // Where it is laid out: in the full sidebar and in the rail (absent: not shown there).
  place: { full?: Box; rail?: Box } = {};
  constructor(readonly doc: Doc, readonly tagName: string) {}
  get id() { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', v); }
  get className() { return [...this.classes].join(' '); }
  set className(v: string) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    return {
      add: (...n: string[]) => n.forEach(x => this.classes.add(x)),
      remove: (...n: string[]) => n.forEach(x => this.classes.delete(x)),
      toggle: (n: string, on?: boolean) => { const want = on ?? !this.classes.has(n); if (want) this.classes.add(n); else this.classes.delete(n); return want; },
      contains: (n: string) => this.classes.has(n),
    };
  }
  get style() {
    const self = this;
    return new Proxy({ setProperty: (k: string, v: string) => self.props.set(k, v), getPropertyValue: (k: string) => self.props.get(k) ?? '' } as Any, {
      set: (t, k: string, v) => { self.props.set(k, String(v)); return true; },
      get: (t, k: string) => (k in t ? t[k] : self.props.get(k)),
    });
  }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  append(...items: El[]) { for (const n of items) { if (n.parent) n.remove(); n.parent = this; this.kids.push(n); } }
  remove() { if (this.parent) { this.parent.kids.splice(this.parent.kids.indexOf(this), 1); this.parent = null; } }
  get isConnected(): boolean { for (let n: El | null = this; n; n = n.parent) if (n === this.doc.body) return true; return false; }
  all(): El[] { return this.kids.flatMap(k => [k, ...k.all()]); }
  // ".a", ".a > .b" and comma lists: what sidebar.js asks for.
  matches(sel: string): boolean {
    return sel.split(',').map(s => s.trim()).some((one) => {
      const [outer, inner] = one.split('>').map(s => s.trim());
      const has = (n: El | null, part: string) => !!n && part.split('.').filter(Boolean).every(c => n.classes.has(c));
      return inner ? has(this, inner) && has(this.parent, outer!) : has(this, outer!);
    });
  }
  querySelectorAll(sel: string) { return this.all().filter(n => n.matches(sel)); }
  closest(sel: string): El | null { for (let n: El | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  cloneNode() { const c = new El(this.doc, this.tagName); this.attrs.forEach((v, k) => c.attrs.set(k, v)); this.classes.forEach(x => c.classes.add(x)); return c; }
  getBoundingClientRect(): Box & { right: number; bottom: number } {
    const side = this.doc.sidebar;
    if (this === side) { const w = parseFloat(side.props.get('--side-w') || '0'); return { left: 0, top: 0, width: w, height: 900, right: w, bottom: 900 }; }
    const b = this.place[side.classes.has('rail') ? 'rail' : 'full'] ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...b, right: b.left + b.width, bottom: b.top + b.height };
  }
  animate(frames: Any[], options: Any) { const a = new Anim(this, frames, options, this.doc.now + (options.duration || 0)); this.doc.anims.push(a); return a; }
  addEventListener() {}
  removeEventListener() {}
}
class Doc {
  body: El; documentElement: El; sidebar!: El; anims: Anim[] = [];
  defaultView: Any;
  // Two clocks: the animation timeline (now) and the wall clock of plain timers (wall). The timeline runs at
  // `rate` (slowed down in the browser's animation tools), or not at all when stalled (a timeline that does not
  // advance); a hidden tab says so in `hidden`.
  now = 0; wall = 0; rate = 1; stalled = false; hidden = false;
  timers = new Map<number, { fn: () => void; at: number }>(); private seq = 0; listeners = new Map<string, Array<() => void>>();
  constructor() { this.body = new El(this, 'BODY'); this.documentElement = new El(this, 'HTML'); }
  createElement(tag: string) { return new El(this, tag.toUpperCase()); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag); }
  setTimeout = (fn: () => void, ms = 0) => { const id = ++this.seq; this.timers.set(id, { fn, at: this.wall + ms }); return id; };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  addEventListener(type: string, fn: () => void) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  dispatch(type: string) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  // Wall time goes on by ms: animations whose end has come finish and timers whose time has come run, in order.
  async advance(ms: number) {
    const end = this.wall + ms;
    for (;;) {
      const speed = this.stalled ? 0 : this.rate;
      const anim = speed > 0 ? this.anims.filter(a => !a.done).map(a => ({ a, at: this.wall + Math.max(0, a.end - this.now) / speed }))
        .filter(x => x.at <= end + 1e-9).sort((x, y) => x.at - y.at)[0] : undefined;
      const timer = [...this.timers].map(([id, t]) => ({ id, ...t })).filter(t => t.at <= end).sort((x, y) => x.at - y.at)[0];
      if (!anim && !timer) break;
      const first = anim && (!timer || anim.at <= timer.at) ? 'anim' : 'timer';
      const at = first === 'anim' ? anim!.at : timer!.at;
      this.now += (at - this.wall) * speed; this.wall = at;
      if (first === 'anim') { this.now = Math.max(this.now, anim!.a.end); anim!.a.done = true; anim!.a.resolve(); }
      else { this.timers.delete(timer!.id); timer!.fn(); }
      await settle();
    }
    this.now += (end - this.wall) * (this.stalled ? 0 : this.rate); this.wall = end;
  }
}

function load(opts: { reduce?: boolean } = {}) {
  const doc = new Doc();
  const css: Record<string, string> = { '--side-fade': ' 120ms', '--side-move': ' 220ms', '--side-ease': ' cubic-bezier(0.2, 0.75, 0.3, 1)' };
  const window: Any = { matchMedia: (q: string) => ({ matches: !!opts.reduce && q === '(prefers-reduced-motion: reduce)' }), getComputedStyle: () => ({ getPropertyValue: (k: string) => css[k] ?? '' }) };
  doc.defaultView = window;
  vm.runInContext(read('client/public/sidebar.js'), vm.createContext({ window, document: doc, console, setTimeout: doc.setTimeout, clearTimeout: doc.clearTimeout }));
  return { doc, window, S: window.ClowderSidebar };
}
// A sidebar as index.html has it, with where things sit in each layout (the
// full one at 280px, the rail at 72px): a row's face keeps its column but moves
// up (no greeting above it in the rail), a pinned face moves up and left, 应用's
// glyph goes from the pill to above the owner's face, which keeps its place.
function sidebar(opts: { reduce?: boolean; rail?: boolean } = {}) {
  const { doc, window, S } = load(opts);
  const h = (tag: string, cls = '', place: El['place'] = {}) => { const e = doc.createElement(tag); cls.split(' ').filter(Boolean).forEach(c => e.classes.add(c)); e.place = place; return e; };
  const side = h('aside', 'sidebar');
  doc.sidebar = side;
  side.style.setProperty('--side-w', opts.rail ? '72px' : '280px');
  if (opts.rail) side.classes.add('rail');
  const row = h('button', 'item'), rowFace = h('span', 'avatar', { full: { left: 18, top: 157, width: 36, height: 36 }, rail: { left: 18, top: 78, width: 36, height: 36 } });
  const far = h('button', 'item'), farFace = h('span', 'avatar', { full: { left: 18, top: 1900, width: 36, height: 36 }, rail: { left: 18, top: 1800, width: 36, height: 36 } });
  const pin = h('button', 'pin'), pinFace = h('span', 'avatar', { full: { left: 22, top: 73, width: 44, height: 44 }, rail: { left: 14, top: 14, width: 44, height: 44 } });
  const account = h('button', 'account-trigger', { full: { left: 18, top: 850, width: 36, height: 36 }, rail: { left: 18, top: 850, width: 36, height: 36 } });
  const apps = h('button', 'side-apps'), glyph = h('svg', 'icon', { full: { left: 132, top: 860, width: 16, height: 16 }, rail: { left: 27, top: 815, width: 18, height: 18 } });
  const railNew = h('button', 'side-glyph rail-only', { rail: { left: 16, top: 764, width: 40, height: 40 } });
  railNew.id = 'rail-new';
  // The list: under the greeting in the full sidebar, from the top in the rail.
  const list = h('div', 'side-scroll', { full: { left: 0, top: 59, width: 280, height: 780 }, rail: { left: 0, top: 8, width: 72, height: 740 } });
  row.append(rowFace); far.append(farFace); pin.append(pinFace); apps.append(glyph);
  list.append(pin, row, far);
  side.append(list, railNew, account, apps);
  doc.body.append(side);
  const calls: string[] = [];
  const motion = S.motion(side, { start: (rail: boolean) => calls.push('start ' + rail), layout: (rail: boolean) => calls.push('layout ' + rail) });
  const states = () => [...side.classes].filter(c => c.startsWith('side-')).sort();
  const glides = () => doc.anims.filter(a => a.frames.length === 2 && 'transform' in a.frames[0]);
  return { doc, window, side, motion, calls, states, glides, rowFace, farFace, pinFace, account, glyph, railNew };
}

// ---------------------------------------------------------------- the owner's face
test('the owner\'s face is a person of ours, drawn inline: never one of the clay cats or their portrait sheet', () => {
  const { doc, S } = load();
  const face = S.ownerFace(doc);
  assert.deepEqual([...face.classes], ['avatar', 'me', 'owner']);
  const svg: El = face.kids[0];
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.equal(svg.getAttribute('data-owner'), '');
  assert.equal(svg.getAttribute('data-cat-id'), null, 'not a cat (the cats\' portraits carry data-cat-id)');
  assert.deepEqual(svg.kids.map(k => [k.tagName, k.getAttribute('class')]), [['circle', 'owner-head'], ['path', 'owner-body'], ['path', 'owner-collar']]);
  assert.equal(svg.all().some(n => n.tagName === 'image'), false, 'nothing from the clay sheet');
  // The shell draws it for the owner wherever the owner was a cat before (the footer was the only place).
  const app = read('client/public/app.js');
  const renderMe = /\n {2}function renderMe\(\) \{\n[\s\S]*?\n {2}\}\n/.exec(app)![0];
  assert.match(renderMe, /window\.ClowderSidebar\.ownerFace\(\)/);
  assert.doesNotMatch(app, /avatar\([^)]*"me"\)/, 'no cat face is made for the owner anywhere');
  // From the tokens, in both themes: the accent on the avatar tile (拿铁's accent is its primary, the café's coffee; since
  // item 48 every 配色's accent stands 3:1 against that tile, which a primary like 蜂蜜's light yellow does not).
  const css = read('client/public/sidebar.css');
  assert.match(css, /\.avatar\.owner \{ color: var\(--accent-ink\); \}/);
  assert.match(css, /\.avatar\.owner \.owner-collar \{ fill: none; stroke: var\(--x-avatar-bg\);/);
});

// ---------------------------------------------------------------- the move
test('a load, a resize or a drag within the full range paints at once: no move, no classes, no animation', () => {
  const s = sidebar();
  s.motion.to(false, 300, true);
  assert.equal(s.side.style.getPropertyValue('--side-w'), '300px', 'the width follows the pointer at once');
  assert.deepEqual(s.states(), []);
  s.motion.to(true, 72, false);
  assert.equal(s.side.classes.has('rail'), true);
  assert.equal(s.doc.documentElement.classes.has('has-rail'), true);
  assert.equal(s.side.style.getPropertyValue('--side-w'), '72px');
  assert.deepEqual(s.states(), []);
  assert.deepEqual(s.calls, ['layout true'], 'the footer is ordered for the rail, no move started');
  assert.equal(s.doc.anims.length, 0);
  s.motion.to(false, 280, false);
  assert.equal(s.side.classes.has('rail'), false);
  assert.equal(s.doc.anims.length, 0);
});

test('into the rail: the words fade first, then the rail takes over while the width narrows and each face glides from where it was', async () => {
  const s = sidebar();
  s.motion.to(true, 72, true);
  assert.deepEqual(s.states(), ['side-fading', 'side-moving']);
  assert.equal(s.side.classes.has('rail'), false, 'the layout waits for the words to fade');
  assert.deepEqual(s.calls, ['start true']);
  assert.equal(s.motion.moving(), true);
  // Another pointer move in the rail range changes nothing.
  s.motion.to(true, 72, true);
  await s.doc.advance(119);
  assert.equal(s.side.classes.has('rail'), false);
  await s.doc.advance(1);
  assert.equal(s.side.classes.has('rail'), true);
  assert.equal(s.doc.documentElement.classes.has('has-rail'), true);
  assert.equal(s.side.style.getPropertyValue('--side-w'), '72px', 'the width transition (side-moving) runs to 72px');
  assert.deepEqual(s.states(), ['side-fading', 'side-landing', 'side-moving']);
  assert.deepEqual(s.calls, ['start true', 'layout true']);
  const glides = s.glides();
  assert.deepEqual(glides.map(a => a.el === s.rowFace ? 'row' : a.el === s.pinFace ? 'pin' : a.el === s.glyph ? 'apps' : '?'), ['pin', 'row', 'apps'],
    'the owner\'s face keeps its place; a face out of sight on both sides does not move');
  assert.deepEqual(plain(glides[1].frames), [{ transform: 'translate(0px, 79px)' }, { transform: 'none' }], 'from where it was, eased back to its place');
  assert.deepEqual(plain(glides[0].frames), [{ transform: 'translate(8px, 59px)' }, { transform: 'none' }]);
  assert.deepEqual(plain(glides[0].options), { duration: 220, easing: 'cubic-bezier(0.2, 0.75, 0.3, 1)' });
  await s.doc.advance(220);
  assert.deepEqual(s.states(), [], 'nothing left over at the end');
  assert.equal(s.motion.moving(), false);
  assert.equal(s.doc.timers.size, 0, 'its watch is gone too');
});

test('out of the rail: laid out full at once while the words stay hidden, the faces glide back, the rail\'s 新建 fades where it stood, the words fade in last', async () => {
  const s = sidebar({ rail: true });
  s.motion.to(false, 280, true);
  assert.equal(s.side.classes.has('rail'), false);
  assert.equal(s.doc.documentElement.classes.has('has-rail'), false);
  assert.equal(s.side.style.getPropertyValue('--side-w'), '280px');
  assert.deepEqual(s.states(), ['side-arriving', 'side-moving']);
  assert.deepEqual(s.calls, ['start false', 'layout false']);
  const ghost = s.side.kids.find(k => k.classes.has('side-ghost'))!;
  assert.ok(ghost, 'the rail\'s 新建 fades out in place');
  assert.equal(ghost.id, '', 'without the id of the real button');
  assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(ghost.inert, true);
  assert.deepEqual([ghost.style.left, ghost.style.top, ghost.style.width], ['16px', '764px', '40px']);
  assert.deepEqual(plain(s.glides().map(a => a.frames[0])), [{ transform: 'translate(0px, -79px)' }, { transform: 'translate(-105px, -45px)' }]);
  // The pinned face would start above the top of the list (the greeting is back above it) and be cut off: it fades in at its place.
  const fades = s.doc.anims.filter(a => a.el === s.pinFace);
  assert.deepEqual(plain(fades.map(a => a.frames)), [[{ opacity: 0 }, { opacity: 1 }]]);
  assert.equal(fades[0]!.options.duration, 220);
  const copies = s.side.kids.filter(k => k.classes.has('side-ghost'));
  assert.equal(copies.length, 2, 'and a still copy of it fades out where it was in the rail');
  assert.deepEqual([copies[1]!.style.left, copies[1]!.style.top, copies[1]!.getAttribute('aria-hidden')], ['14px', '14px', 'true']);
  // A drag that goes on widens the target; the width transition follows it.
  s.motion.to(false, 300, true);
  assert.equal(s.side.style.getPropertyValue('--side-w'), '300px');
  await s.doc.advance(147);
  assert.deepEqual(s.states(), ['side-moving', 'side-revealing'], 'the words come back in the last third');
  await s.doc.advance(120);
  assert.deepEqual(s.states(), []);
  assert.equal(s.side.kids.some(k => k.classes.has('side-ghost')), false, 'the ghost is gone');
});

test('back out before the rail took over: the words fade back in and the rail never shows; a move reversed later jumps the first to its end', async () => {
  const s = sidebar();
  s.motion.to(true, 72, true);
  await s.doc.advance(60);
  s.motion.to(false, 260, true);
  assert.deepEqual(s.states(), ['side-moving', 'side-revealing']);
  assert.equal(s.side.style.getPropertyValue('--side-w'), '260px');
  await s.doc.advance(200);
  assert.deepEqual(s.states(), []);
  assert.equal(s.calls.includes('layout true'), false, 'the rail layout never painted');
  // Reversed once the rail has taken over: the first move ends at once, the second runs from there.
  const t = sidebar();
  t.motion.to(true, 72, true);
  await t.doc.advance(150);
  t.motion.to(false, 280, true);
  assert.equal(t.side.classes.has('rail'), false);
  assert.deepEqual(t.states(), ['side-arriving', 'side-moving']);
  assert.equal(t.doc.anims.filter(a => a.cancelled).length > 0, true, 'the first move\'s glides and clock were stopped');
  // A resize meanwhile paints the state at once.
  t.motion.to(true, 72, false);
  assert.deepEqual(t.states(), []);
  assert.equal(t.side.classes.has('rail'), true);
});

test('a move always ends: a clock cancelled from outside jumps it to its end, a timeline that stops is noticed by a plain timer, a hidden tab ends it; a slowed one is never cut short', async () => {
  // Cancelled from outside (not by the move itself): the rail is laid out and nothing is left over.
  const s = sidebar();
  s.motion.to(true, 72, true);
  s.doc.anims.find(a => a.frames.length === 0)!.cancel();
  await settle();
  assert.equal(s.motion.moving(), false);
  assert.equal(s.side.classes.has('rail'), true);
  assert.equal(s.doc.documentElement.classes.has('has-rail'), true);
  assert.deepEqual(s.states(), []);
  assert.deepEqual(s.calls, ['start true', 'layout true']);
  assert.equal(s.doc.timers.size, 0, 'its watch is gone too');
  // The next snap runs as usual.
  s.motion.to(false, 280, true);
  assert.deepEqual(s.states(), ['side-arriving', 'side-moving']);
  await s.doc.advance(267);
  assert.deepEqual(s.states(), []);
  // A timeline that does not advance (its clock never settles): the watch ends the move within a few seconds.
  const t = sidebar({ rail: true });
  t.doc.stalled = true;
  t.motion.to(false, 280, true);
  assert.equal(t.side.kids.filter(k => k.classes.has('side-ghost')).length, 2);
  await t.doc.advance(1019);
  assert.equal(t.motion.moving(), true, 'not cut at the first look');
  await t.doc.advance(2100);
  assert.equal(t.motion.moving(), false);
  assert.deepEqual(t.states(), []);
  assert.equal(t.side.classes.has('rail'), false);
  assert.equal(t.side.kids.some(k => k.classes.has('side-ghost')), false, 'no copy left behind');
  assert.equal(t.doc.timers.size, 0);
  // Slowed to 5% in the browser's animation tools, 340 ms of motion take 6.8 s of wall time: the watch waits.
  const u = sidebar();
  u.doc.rate = 0.05;
  u.motion.to(true, 72, true);
  await u.doc.advance(6000);
  assert.equal(u.motion.moving(), true, 'still moving after six seconds');
  assert.deepEqual(u.states(), ['side-fading', 'side-landing', 'side-moving']);
  await u.doc.advance(1000);
  assert.equal(u.motion.moving(), false);
  assert.equal(u.side.classes.has('rail'), true);
  assert.deepEqual(u.states(), []);
  // A tab hidden mid-move: the move ends there, so the sidebar is settled when the tab comes back.
  const v = sidebar();
  v.motion.to(true, 72, true);
  v.doc.hidden = true;
  v.doc.dispatch('visibilitychange');
  assert.equal(v.motion.moving(), false);
  assert.equal(v.side.classes.has('rail'), true);
  assert.deepEqual(v.states(), []);
  assert.equal(v.doc.timers.size, 0);
});

test('a resize while a move runs ends it at once, toward the same state too (out of the rail, then into the drawer): no copies or classes stay', async () => {
  const s = sidebar({ rail: true });
  s.motion.to(false, 280, true);
  assert.equal(s.side.kids.filter(k => k.classes.has('side-ghost')).length, 2);
  // The window went below 768px: the drawer is never the rail, so the target is the same (rail: false), but not animated.
  s.motion.to(false, 280, false);
  assert.equal(s.motion.moving(), false);
  assert.deepEqual(s.states(), []);
  assert.equal(s.side.kids.some(k => k.classes.has('side-ghost')), false, 'the copies placed for the desktop layout are gone');
  assert.ok(s.doc.anims.every(a => a.cancelled || a.done), 'its glides and clocks stopped');
  assert.equal(s.doc.timers.size, 0);
  // Reduced motion turned on mid-move does the same.
  const t = sidebar();
  t.motion.to(true, 72, true);
  t.window.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
  t.motion.to(true, 72, true);
  assert.equal(t.motion.moving(), false);
  assert.equal(t.side.classes.has('rail'), true);
  assert.deepEqual(t.states(), []);
});

test('with reduced motion the snap paints at once: no classes, no animation', () => {
  const s = sidebar({ reduce: true });
  s.motion.to(true, 72, true);
  assert.equal(s.side.classes.has('rail'), true);
  assert.deepEqual(s.states(), []);
  assert.equal(s.doc.anims.length, 0);
  assert.deepEqual(s.calls, ['layout true']);
  // And the stylesheets agree: nothing of the move transitions or animates when motion is reduced.
  const css = read('client/public/sidebar.css');
  const still = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  assert.match(still, /\.sidebar\.side-moving/);
  assert.match(still, /\.sidebar\.side-landing \.rail-only \{ animation: none; \}/);
});

test('the classes the move hangs on: width eased with the panel\'s curve and tokens.css\'s durations, content pinned to the target width and clipped, words faded, rail-only controls faded in', () => {
  const css = read('client/public/sidebar.css'), bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(bare, /:root \{ --side-fade: var\(--dur-pop-close\); --side-move: var\(--dur-pop\); --side-ease: cubic-bezier\(0\.2, 0\.75, 0\.3, 1\); \}/);
  const rail = /@media \(min-width: 768px\) \{([\s\S]*?)\n\}/.exec(bare)![1]!;
  assert.match(rail, /\.sidebar\.side-moving \{ overflow: hidden; align-items: flex-start; transition: width var\(--side-move\) var\(--side-ease\); \}/);
  assert.match(rail, /\.sidebar\.side-moving > :is\(\.side-head, \.side-scroll, \.side-foot\) \{ width: var\(--side-w\); \}/);
  assert.match(rail, /\.sidebar\.side-fading :is\(\.side-head, \.item-body, \.pin-name,[^)]*\) \{\s*opacity: 0; transition: opacity var\(--side-fade\) ease-out;/);
  assert.match(rail, /\.sidebar\.side-arriving :is\([^)]*\) \{ opacity: 0; transition: none; \}/);
  assert.match(rail, /\.sidebar\.side-revealing :is\([^)]*\) \{ transition: opacity var\(--side-fade\) ease-out; \}/);
  // Only the existing fade keyframes; no new colour or font.
  assert.deepEqual([...bare.matchAll(/animation:\s*([\w-]+)/g)].map(m => m[1]).sort(), ['fade', 'none']);
  assert.doesNotMatch(bare, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|font-family/i);
  // The drawer (below 768px) is always full: every rail rule, and every rule of the move, is inside the 768px query.
  const outside = bare.replace(/@media \(min-width: 768px\) \{[\s\S]*?\n\}/, '').replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/, '');
  assert.doesNotMatch(outside, /\.sidebar\.rail|side-moving|side-fading|side-arriving|side-revealing|side-landing/);
  // The move only runs when app.js says it is a snap the owner made.
  const app = read('client/public/app.js');
  assert.match(app, /const sideMotion = window\.ClowderSidebar\.motion\(sidebar, \{/);
  assert.match(app, /function syncSidebar\(animate = false\) \{\n\s+const rail = window\.innerWidth >= 768 && side\.rail;\n\s+sideMotion\.to\(rail, rail \? SIDE\.rail : side\.w, animate\);/);
  assert.match(app, /side = x < SIDE\.snap \? \{ w: side\.w, rail: true \} : \{[^}]*\};\n\s+syncSidebar\(true\);/, 'the grip');
  assert.match(app, /sideGrip\.addEventListener\("dblclick", \(\) => \{ side = \{ w: SIDE\.def, rail: false \}; syncSidebar\(true\); saveSide\(\); \}\);/);
  assert.match(app, /window\.addEventListener\("resize", \(\) => \{\n[^\n]*\n\s+syncSidebar\(\);/, 'a resize paints at once');
  assert.match(app, /\n {2}syncSidebar\(\);\n {2}initTheme\(\);/, 'a load paints the saved state at once');
});

// ---------------------------------------------------------------- the layout and its controls
test('the full sidebar: 搜索 and 新建 at the right end of the greeting\'s line; the owner\'s face and 应用 at the bottom; the name and this computer head 我\'s menu', () => {
  const html = read('client/index.html');
  const aside = /<aside id="sidebar" class="sidebar">([\s\S]*?)<\/aside>/.exec(html)![1]!;
  const order = [...aside.matchAll(/id="([\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['side-grip', 'palette-open', 'side-new', 'greeting', 'pin-row', 'roster', 'remote-roster', 'rail-new', 'account', 'me-avatar', 'account-menu', 'me-name', 'me-device', 'account-settings', 'side-apps']);
  // The face alone in the button; the name and the device line in the menu's head, which is not a control.
  const trigger = /<button id="account"[^>]*>([\s\S]*?)<\/button>/.exec(aside)![1]!;
  assert.match(trigger, /^\s*<span id="me-avatar"><\/span>\s*$/);
  assert.match(aside, /<div id="account-menu" class="pop account-menu" hidden>\n\s+<div class="me-head"><span id="me-name" class="me-name">我<\/span><span id="me-device" class="me-device" hidden><\/span><\/div>\n\s+<button id="account-settings"/);
  assert.match(read('client/public/devices.js'), /document\.getElementById\("me-device"\)/, 'devices.js still finds the device line');
  // 应用: a named, focusable button that opens a dialog (item 53); a tooltip only in the rail, where its label is gone.
  assert.match(aside, /<button id="side-apps" class="side-apps" type="button" aria-haspopup="dialog" aria-label="应用" data-tip="应用" data-tip-placement="right" data-tip-only="rail"><span class="side-apps-label">应用<\/span><\/button>/);
  const app = read('client/public/app.js');
  assert.match(app, /if \(host\.dataset\.tipOnly === "rail" && !host\.closest\("\.sidebar\.rail"\)\) \{ hideTip\(\); return; \}/);
  // The pinned row holds pinned cats only, and takes no room without one.
  assert.match(read('client/public/sidebar.css'), /\.pin-row:empty \{ display: none; \}/);
  // Styles after every earlier one, chat-live.css still last; the script before app.js.
  const styles = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(styles.slice(-4), ['sidebar.css', 'chat-panel.css', 'apps-dialog.css', 'chat-live.css']);
  const scripts = [...html.matchAll(/<script src="\/([^"]+)"/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('sidebar.js') >= 0 && scripts.indexOf('sidebar.js') < scripts.indexOf('app.js'));
});

test('the rail has no 搜索 (⌘K still opens it): 新建, 应用 and the face stacked at the bottom, in that order for Tab too', () => {
  const css = read('client/public/sidebar.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rail = /@media \(min-width: 768px\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  assert.match(rail, /\.sidebar\.rail \.side-head \{ display: none; \}/, '搜索 and the top 新建 live in the head');
  assert.match(rail, /\.sidebar\.rail \.side-foot \{ width: 100%; flex-direction: column; align-items: center;/);
  assert.match(rail, /\.sidebar\.rail \.rail-only \{ display: grid; \}/);
  assert.match(rail, /\.sidebar\.rail \.side-apps-label \{ display: none; \}/);
  assert.match(css, /\.sidebar \.rail-only \{ display: none; \}/, 'the rail\'s 新建 only there');
  assert.match(read('client/public/palette.js'), /document\.addEventListener\("keydown", onPageKey\)/, 'the shortcut stays');
  // app.js puts 应用 before the face in the rail and after it in the full footer, so Tab follows what is seen; focus is kept.
  const app = read('client/public/app.js');
  const hook = /layout: \(rail\) => \{[\s\S]*?\n {4}\},/.exec(app)![0];
  const doc = new Doc();
  const foot = doc.createElement('div'), railNew = doc.createElement('button'), wrap = doc.createElement('div'), account = doc.createElement('button'), apps = doc.createElement('button');
  wrap.classes.add('account-wrap'); wrap.append(account); foot.append(railNew, wrap, apps); doc.body.append(foot);
  let focused: El | null = apps;
  Object.defineProperties(apps, {
    nextElementSibling: { get: () => { const k = foot.kids; return k[k.indexOf(apps) + 1] ?? null; } },
    parentElement: { get: () => foot },
    focus: { value: () => { focused = apps; } },
  });
  Object.defineProperty(account, 'closest', { value: () => wrap });
  (foot as Any).insertBefore = (n: El, ref: El | null) => { n.remove(); if (n === focused) focused = null; if (!ref) foot.append(n); else { n.parent = foot; foot.kids.splice(foot.kids.indexOf(ref), 0, n); } };
  const run = vm.runInNewContext('({' + hook + '})', { $: (id: string) => ({ 'side-apps': apps, account }[id]), document: { get activeElement() { return focused; } } });
  run.layout(true);
  assert.deepEqual(foot.kids.map(k => k === railNew ? 'new' : k === wrap ? 'face' : 'apps'), ['new', 'apps', 'face']);
  assert.ok(focused === apps, 'a focused 应用 keeps focus');
  run.layout(false);
  assert.deepEqual(foot.kids.map(k => k === railNew ? 'new' : k === wrap ? 'face' : 'apps'), ['new', 'face', 'apps']);
});

test('我\'s menu opens right above the face (left edges aligned) in the full sidebar and beside it right of the rail (bottom edges aligned); Escape brings focus back to the face', () => {
  const css = read('client/public/sidebar.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.account-menu \{ width: 208px; min-width: 0; left: 0; right: auto; bottom: calc\(100% \+ 8px\); \}/);
  const rail = /@media \(min-width: 768px\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  assert.match(rail, /\.sidebar\.rail \.account-menu \{ left: calc\(100% \+ 26px\); right: auto; bottom: 0; \}/);
  assert.match(css, /\.me-head \{ display: flex; flex-direction: column;/);
  // closeAccount: hidden, aria-expanded false, and focus that was inside goes back to the face.
  const app = read('client/public/app.js');
  const fn = /\n {2}function closeAccount\(\) \{\n[\s\S]*?\n {2}\}\n/.exec(app)![0];
  const menu: Any = { hidden: false, contains: (n: unknown) => n === inside }, inside = {}, trigger: Any = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; }, focus() { focusedOn = 'account'; } };
  let focusedOn = '';
  const ctx: Any = { $: (id: string) => (id === 'account-menu' ? menu : trigger), document: { activeElement: inside } };
  vm.runInNewContext(fn + 'closeAccount();', ctx);
  assert.equal(menu.hidden, true);
  assert.equal(trigger.attrs['aria-expanded'], 'false');
  assert.equal(focusedOn, 'account');
  // Focus elsewhere (a click on a row closed it) stays where it is.
  menu.hidden = false; focusedOn = ''; ctx.document.activeElement = {};
  vm.runInNewContext(fn + 'closeAccount();', ctx);
  assert.equal(focusedOn, '');
  // The move closes the menu and the tooltip first.
  assert.match(app, /start: \(\) => \{ closeAccount\(\); hideTip\(\); \},/);
});

test('应用 was a placeholder the owner asked for (item 43); since item 53 it opens the 应用 dialog, from the full sidebar and the rail alike — the same button', () => {
  const app = read('client/public/app.js');
  // The owner, 2026-11-26: 「先做微信 和 自定义应用 两项吧。」 The toast that said it was not open is gone.
  assert.match(app, /\$\("side-apps"\)\.prepend\(icon\("grid-plus"\)\);\n\s+\$\("side-apps"\)\.addEventListener\("click", \(\) => openApps\(\$\("side-apps"\)\)\);/);
  assert.doesNotMatch(app, /应用还没有开放/);
  // The retained XBot apps store is still not wired: neither loaded nor called (the dialog is apps-dialog.js, tests/apps-dialog.test.ts).
  const html = read('client/index.html');
  assert.doesNotMatch(html, /\/apps\.(js|css)"/);
  assert.doesNotMatch(app, /XBotApps|\/xbot-api\/apps/);
  // The rail's tooltip names it; the full sidebar shows its label instead.
  assert.match(read('client/public/sidebar.css'), /\.sidebar\.rail \.side-apps \{ flex: none; width: 40px; height: 40px;/);
});

test('every button here can be reached and seen with the keyboard, and is 44px in the drawer', () => {
  const css = read('client/public/sidebar.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.side-btn:focus-visible, \.side-glyph:focus-visible, \.side-apps:focus-visible, \.account-trigger:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/);
  const drawer = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
  for (const rule of [/\.side-btn \{ width: 44px; height: 44px; \}/, /\.account-trigger \{ width: 44px; height: 44px; \}/, /\.side-apps \{ height: 44px; \}/]) assert.match(drawer, rule);
});

test('item 46: the sidebar keeps only what the layout cannot say — the busy count under the greeting stays (review r15), no heading over the groups (a gap; 群聊 for a screen reader), names as tooltips only in the rail, no name after 复制名字, no example placeholder, 应用 said once', () => {
  const app = read('client/public/app.js');
  // Review r15: the busy line under the greeting stays — the one place a pinned cat (no working mark of its own)
  // or a cat in a collapsed folder is said to be working; native status, not a label.
  const greet = /\n {2}function paintGreeting\(\) \{\n([\s\S]*?)\n {2}\}\n/.exec(app)![1]!;
  assert.match(greet, /host\.append\(stack, document\.createTextNode\(" " \+ busy\.length \+ " 只猫猫"\), el\("span", "g", " 在忙。"\)\);/);
  assert.match(app, /roster\.append\(sectionLabel\("群聊", null, true\)\);/);
  assert.match(app, /const row = el\("div", "group-label" \+ \(quiet \? " cl-gap" : ""\)\);\n\s+row\.append\(el\("span", "label" \+ \(quiet \? " visually-hidden" : ""\), text\)\);/);
  // The gap is a gap, not a hidden heading: a height, never display: none (the word is read out).
  const css = read('client/public/chat-list.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.group-label\.cl-gap \{ min-height: 0; height: var\(--x-s6\); padding: 0; line-height: 0; \}/);
  assert.doesNotMatch(css, /cl-gap[^{]*\{[^}]*display: none/);
  // Rows, their faces and the pinned cats: the name as a tooltip only where it is not printed (the rail).
  assert.match(app, /function railTip\(node\) \{\n\s+node\.dataset\.tipOnly = "rail";/);
  assert.match(app, /setTip\(railTip\(btn\), name, "right"\);\n\s+const av = railTip\(avatar\(name, paint\)\);/);
  assert.match(app, /setTip\(railTip\(btn\), niceName\(b\.name\), "right"\);/);
  assert.match(app, /const av = railTip\(avatar\(b\.name, paintOfBot\(b\), "pin"\)\);/);
  assert.match(app, /item\("clipboard", "复制名字", \(\) => copyBotID\(name\)\);\n/);
  assert.doesNotMatch(app, /el\("span", "v mono", name\)/);
  assert.doesNotMatch(app, /placeholder: "工作"/);
  assert.doesNotMatch(app, /现在还用不了/);
  assert.match(read('client/public/cafe-theme.css'), /\.greet-stack > \.avatar:has\(> svg\[data-cat-id\]\)/);
});
