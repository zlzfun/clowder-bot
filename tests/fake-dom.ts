// A small DOM for running the classic-script frontend modules in a VM: a tree
// of elements with classes, data attributes, markup (for the history's redraw
// identity), focus, events and simple selectors (tag, #id, .class, [attr],
// [attr="v"], descendant and > combinators, comma lists; pseudo-classes always match). Layout is not
// modelled: tests that need positions give elements their own
// getBoundingClientRect.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export class Base {
  parent: El | null = null;
  constructor(readonly doc: Doc) {}
  get parentElement() { return this.parent; }
  get parentNode() { return this.parent; }
  get isConnected(): boolean { for (let n: Base | null = this; n; n = n.parent) if (n === this.doc.root) return true; return false; }
  get textContent(): string { return ''; }
  set textContent(_v: string) { /* text nodes override */ }
  get html(): string { return ''; }
  get nextSibling(): Base | null { const p = this.parent; if (!p) return null; return p.kids[p.kids.indexOf(this) + 1] ?? null; }
  remove() {
    const p = this.parent;
    if (!p) return;
    if (this.doc.active && this instanceof El && this.contains(this.doc.active)) this.doc.active = null;
    p.kids.splice(p.kids.indexOf(this), 1);
    this.parent = null;
  }
}
export class TextNode extends Base {
  nodeType = 3;
  constructor(doc: Doc, public data: string) { super(doc); }
  override get textContent() { return this.data; }
  override set textContent(v: string) { this.data = String(v); }
  override get html() { return this.data.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
}
export class El extends Base {
  nodeType = 1;
  readonly tagName: string; kids: Base[] = []; attrs = new Map<string, string>(); listeners = new Map<string, Array<(ev: Any) => void>>();
  hidden = false; disabled = false; tabIndex = -1; scrollTop = 0; scrollHeight = 0; clientHeight = 0; inner = ''; offsetHeight = 0;
  style: Record<string, string> = {};
  moves = 0;
  [key: string]: Any;
  constructor(doc: Doc, tag: string) { super(doc); this.tagName = tag.toUpperCase(); }
  get id() { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', String(v)); }
  get type() { return this.attrs.get('type') ?? ''; }
  set type(v: string) { this.attrs.set('type', String(v)); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v: string) { this.attrs.set('class', String(v)); }
  get classList() {
    const names = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s: Set<string>) => { this.className = [...s].join(' '); };
    return {
      add: (...n: string[]) => { const s = names(); n.forEach(x => s.add(x)); write(s); },
      remove: (...n: string[]) => { const s = names(); n.forEach(x => s.delete(x)); write(s); },
      toggle: (n: string, on?: boolean) => { const s = names(); const want = on ?? !s.has(n); if (want) s.add(n); else s.delete(n); write(s); return want; },
      contains: (n: string) => names().has(n),
    };
  }
  get dataset(): Record<string, string> {
    const key = (k: string) => 'data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    return new Proxy({}, {
      get: (_t, k: string) => this.attrs.get(key(k)),
      set: (_t, k: string, v) => { this.attrs.set(key(k), String(v)); return true; },
      deleteProperty: (_t, k: string) => { this.attrs.delete(key(k)); return true; },
    });
  }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  get children(): El[] { return this.kids.filter((k): k is El => k instanceof El); }
  get firstChild() { return this.kids[0] ?? null; }
  get childNodes() { return this.kids; }
  override get textContent(): string { return this.kids.map(k => k.textContent).join(''); }
  override set textContent(v: string) { this.replaceChildren(); if (v !== '' && v != null) this.append(String(v)); }
  get innerText() { return this.textContent; }
  set innerHTML(v: string) { this.replaceChildren(); this.inner = v; }
  override get html(): string {
    const attrs = [...this.attrs].sort().map(([k, v]) => ` ${k}="${v}"`).join('') + (this.hidden ? ' hidden' : '') + (this.disabled ? ' disabled' : '');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.inner}${this.kids.map(k => k.html).join('')}</${this.tagName.toLowerCase()}>`;
  }
  get outerHTML() { return this.html; }
  private adopt(item: Base | string): Base {
    const n = typeof item === 'string' ? new TextNode(this.doc, item) : item;
    if (n.parent) { n.remove(); if (n instanceof El) n.moves++; }
    n.parent = this;
    return n;
  }
  append(...items: Array<Base | string>) { for (const i of items) this.kids.push(this.adopt(i)); }
  prepend(...items: Array<Base | string>) { this.kids.unshift(...items.map(i => this.adopt(i))); }
  insertBefore(n: Base, ref: Base | null) {
    if (!ref) { this.append(n); return n; }
    this.adopt(n);
    this.kids.splice(this.kids.indexOf(ref), 0, n);
    return n;
  }
  before(...items: Array<Base | string>) { const p = this.parent!; for (const i of items) p.insertBefore(typeof i === 'string' ? new TextNode(this.doc, i) : i, this); }
  replaceWith(n: Base) { const p = this.parent!; p.insertBefore(n, this); this.remove(); }
  replaceChildren(...items: Array<Base | string>) { for (const k of [...this.kids]) k.remove(); this.append(...items); }
  contains(n: Base | null): boolean { for (let x: Base | null = n; x; x = x.parent) if (x === this) return true; return false; }
  addEventListener(type: string, fn: (ev: Any) => void) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
  removeEventListener(type: string, fn: (ev: Any) => void) { const l = this.listeners.get(type) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  // Dispatch with bubbling (and the document's own listeners last).
  dispatch(type: string, init: Record<string, unknown> = {}) {
    let stopped = false, prevented = false;
    const ev: Any = { type, target: this, ...init, stopPropagation() { stopped = true; }, preventDefault() { prevented = true; }, get defaultPrevented() { return prevented; } };
    for (let n: El | null = this; n && !stopped; n = n.parent) { ev.currentTarget = n; for (const fn of [...(n.listeners.get(type) ?? [])]) fn(ev); }
    if (!stopped) for (const fn of [...(this.doc.listeners.get(type) ?? [])]) fn(ev);
    return ev;
  }
  click() {
    if (this.disabled) return;
    const ev = this.dispatch('click');
    // A submit button submits its form.
    if (!ev.defaultPrevented && this.tagName === 'BUTTON' && this.type === 'submit') {
      let f: El | null = this.parent;
      while (f && f.tagName !== 'FORM') f = f.parent;
      if (f) f.dispatch('submit');
    }
  }
  key(key: string, more: Record<string, unknown> = {}) { return this.dispatch('keydown', { key, ...more }); }
  focus() { this.doc.active = this; }
  blur() { if (this.doc.active === this) this.doc.active = null; }
  matches(sel: string): boolean { return sel.split(',').some(s => matchChain(this, parse(s.trim()))); }
  closest(sel: string): El | null { for (let n: El | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (n: El) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  find(cls: string): El[] { return this.querySelectorAll('.' + cls); }
}

type Part = { tag?: string; id?: string; classes: string[]; attrs: Array<[string, string | null]> };
type Chain = Array<{ part: Part; comb: ' ' | '>' }>;
function parse(sel: string): Chain {
  const chain: Chain = [];
  const tokens = sel.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
  let comb: ' ' | '>' = ' ';
  for (const t of tokens) {
    if (t === '>') { comb = '>'; continue; }
    const part: Part = { classes: [], attrs: [] };
    // Pseudo-classes (:scope, :focus-visible …) are not modelled: they always match.
    const re = /(:[\w-]+)|([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      if (m[1]) continue;
      if (m[2]) part.tag = m[2].toUpperCase();
      else if (m[3]) part.id = m[3];
      else if (m[4]) part.classes.push(m[4]);
      else if (m[5]) part.attrs.push([m[5], m[6] ?? null]);
    }
    chain.push({ part, comb });
    comb = ' ';
  }
  return chain;
}
function matchPart(el: El, p: Part) {
  if (p.tag && el.tagName !== p.tag) return false;
  if (p.id && el.id !== p.id) return false;
  if (p.classes.some(c => !el.classList.contains(c))) return false;
  return p.attrs.every(([k, v]) => (v == null ? el.attrs.has(k) : el.attrs.get(k) === v));
}
function matchChain(el: El, chain: Chain): boolean {
  const go = (n: El | null, i: number): boolean => {
    if (!n || !matchPart(n, chain[i]!.part)) return false;
    if (i === 0) return true;
    const comb = chain[i]!.comb;
    if (comb === '>') return go(n.parent, i - 1);
    for (let a = n.parent; a; a = a.parent) if (go(a, i - 1)) return true;
    return false;
  };
  return chain.length > 0 && go(el, chain.length - 1);
}

export class Doc {
  root: El; body: El; active: El | null = null; title = 'clowder-bot';
  listeners = new Map<string, Array<(ev: Any) => void>>();
  constructor() { this.root = new El(this, 'html'); this.body = new El(this, 'body'); this.root.append(this.body); }
  get activeElement() { return this.active ?? this.body; }
  createElement(tag: string) { return new El(this, tag); }
  createElementNS(_ns: string, tag: string) { return new El(this, tag); }
  createTextNode(t: string) { return new TextNode(this, t); }
  getElementById(id: string) { return this.root.querySelector('#' + id); }
  querySelector(sel: string) { return this.root.querySelector(sel); }
  querySelectorAll(sel: string) { return this.root.querySelectorAll(sel); }
  addEventListener(type: string, fn: (ev: Any) => void) { const l = this.listeners.get(type) ?? []; l.push(fn); this.listeners.set(type, l); }
}

export const text = (n: El | null | undefined) => (n ? n.textContent : '');
