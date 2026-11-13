// 群聊输入框里的 @ (classic script, window.ClowderMention). The rules live in
// mention-rules.js; app.js passes the composer and its own text helpers
// through init() and calls close() when the conversation changes.
//
// Typing @ in a group chat lists this group's members and 「全体」 above the
// composer. ↑/↓ move, Enter or Tab inserts, Esc dismisses (until another @);
// a click or a tap inserts too. Picking writes `@名字 ` at the caret as one
// undoable edit. The text is sent as it is; the engine routes it. Single chats
// never show the list.
//
// The list never acts on what it saw earlier: before a key or a click picks,
// it reads the draft, the caret and the group's members again (the composer's
// own undo changes the draft without an input event; a member can be renamed
// or leave meanwhile), and a change the composer makes by itself refreshes or
// closes it. A send, by Enter or by the Ctrl/⌘+Enter shortcut, closes it.
(() => {
  "use strict";
  const R = window.ClowderMentionRules;
  if (!R) throw new Error("mention-rules.js must load before mention.js");

  let H = null;
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  // 「全体」's mark: two people (app.js's set has only a person with a plus).
  const USERS = '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>';
  function glyph(body) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("icon");
    svg.innerHTML = body;
    return svg;
  }
  let seq = 0;
  // pop: the list element while open; at: the mention being typed; dismissed:
  // where an Esc'd mention starts, so the same @ stays quiet.
  const S = { pop: null, items: [], active: 0, at: null, names: [], dismissed: -1, composing: false, pressing: false };

  function init(hooks) {
    H = hooks;
    const input = H.input, composer = H.composer;
    // Capture on the form: these keys are the list's before the composer
    // turns Enter into a send, or the page turns Esc into closing the drawer.
    composer.addEventListener("keydown", onKey, true);
    composer.addEventListener("submit", () => { S.dismissed = -1; close(); }, true);
    // Changes that come with no input event (undo/redo, a draft set by the
    // shell): read the draft again once the caret is placed.
    if (typeof MutationObserver === "function") {
      new MutationObserver(() => { if (open()) Promise.resolve().then(update); })
        .observe(input, { childList: true, characterData: true, subtree: true });
    }
    input.addEventListener("input", (ev) => { if (!ev.isComposing) update(); });
    input.addEventListener("compositionstart", () => { S.composing = true; });
    input.addEventListener("compositionend", () => { S.composing = false; update(); });
    input.addEventListener("click", () => update());
    input.addEventListener("keyup", (ev) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(ev.key)) update(); });
    // Leaving the composer closes the list, except for a press on the list
    // itself (a touch press may still move focus before its click lands).
    input.addEventListener("blur", () => { if (!S.pressing) close(); });
  }

  const open = () => !!S.pop;

  // Read the draft again: open, refresh or close the list.
  function update() {
    if (!H || S.composing) return;
    const names = H.members();
    if (!names) { close(); return; }
    const found = R.active(H.text(), H.caret());
    if (!found) { S.dismissed = -1; close(); return; }
    if (found.start === S.dismissed) { close(); return; }
    const items = R.suggest(found.query, names);
    if (!items.length) { close(); return; }
    const keep = S.pop && S.at && S.at.start === found.start ? S.items[S.active] : null;
    S.at = found;
    S.names = names;
    S.items = items;
    const again = keep ? items.findIndex((it) => it.kind === keep.kind && it.name === keep.name) : -1;
    S.active = again >= 0 ? again : 0;
    paint();
  }

  function paint() {
    const input = H.input;
    if (!S.pop) {
      S.pop = node("div", "pop mx-pop");
      S.pop.id = "mx-list-" + ++seq;
      S.pop.setAttribute("role", "listbox");
      S.pop.setAttribute("aria-label", "要 @ 的猫猫");
      // Keep the caret in the composer: a press on the list never takes focus.
      S.pop.addEventListener("pointerdown", (ev) => { S.pressing = true; ev.preventDefault(); });
      S.pop.addEventListener("mousedown", (ev) => ev.preventDefault());
      S.pop.addEventListener("pointercancel", () => { S.pressing = false; });
      H.composer.append(S.pop);
      input.setAttribute("aria-controls", S.pop.id);
      input.setAttribute("aria-autocomplete", "list");
    }
    const id = S.pop.id;
    S.pop.replaceChildren(...S.items.map((it, i) => {
      const row = node("div", "mx-opt" + (it.kind === "all" ? " all" : ""));
      row.id = id + "-" + i;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === S.active));
      if (it.kind === "all") {
        const mark = node("span", "mx-all");
        mark.setAttribute("aria-hidden", "true");
        mark.append(glyph(USERS));
        // 全体 after the members, under its people mark; what it does shows the
        // moment it is picked (each member's @ in the composer). The hint is
        // for a screen reader only (item 46).
        row.append(mark, node("span", "mx-name", R.ALL.label), node("span", "mx-hint visually-hidden", R.ALL.hint));
      } else {
        // The full name on hover only while the printed one is cut short (review r15).
        const name = node("span", "mx-name", it.name);
        name.dataset.tip = it.name;
        name.dataset.tipOnly = "clipped";
        row.append(H.face(it.name), name);
      }
      row.addEventListener("mousemove", () => { if (S.active !== i) { S.active = i; mark(); } });
      row.addEventListener("click", () => pick(i));
      return row;
    }));
    mark();
  }

  // The highlighted row: kept in view, and named to assistive tech.
  function mark() {
    if (!S.pop) return;
    [...S.pop.children].forEach((row, i) => row.setAttribute("aria-selected", String(i === S.active)));
    const row = S.pop.children[S.active];
    if (row) {
      H.input.setAttribute("aria-activedescendant", row.id);
      if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    }
  }

  // Pick what the list shows at row i — after reading everything again: the
  // same item must still be offered for the mention now at the caret.
  function pick(i) {
    const want = S.items[i];
    if (!want) return;
    update();
    const now = open() ? S.items.findIndex((it) => it.kind === want.kind && it.name === want.name) : -1;
    if (now < 0) return;
    const item = S.items[now], at = S.at;
    const next = R.insert(H.text(), at, item, S.names);
    S.dismissed = -1;
    close();
    if (document.activeElement !== H.input) H.input.focus({ preventScroll: true });
    H.apply(next.text, next.caret);
  }

  const KEYS = ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"];
  function onKey(ev) {
    if (!open() || ev.target !== H.input || ev.isComposing || ev.keyCode === 229) return;
    // Ctrl/⌘+Enter sends: the list goes with it.
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { close(); return; }
    if (ev.altKey || ev.ctrlKey || ev.metaKey || !KEYS.includes(ev.key)) return;
    // The draft may have changed under the list: with no mention left at the
    // caret the list closes and the key is the composer's again.
    const want = S.items[S.active];
    update();
    if (!open()) return;
    const n = S.items.length;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      S.active = (S.active + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
      mark();
    } else if ((ev.key === "Enter" || ev.key === "Tab") && !ev.shiftKey) {
      // The row the owner saw highlighted, if it is still offered; if it is
      // not (renamed, left the group), the key only shows the list as it is now.
      const i = want ? S.items.findIndex((it) => it.kind === want.kind && it.name === want.name) : -1;
      if (i >= 0) pick(i);
    } else if (ev.key === "Escape") {
      S.dismissed = S.at ? S.at.start : -1;
      close();
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  }

  function close() {
    S.pressing = false;
    if (!S.pop) return;
    S.pop.remove();
    S.pop = null;
    S.items = [];
    S.at = null;
    if (H) for (const name of ["aria-controls", "aria-activedescendant", "aria-autocomplete"]) H.input.removeAttribute(name);
  }

  window.ClowderMention = Object.freeze({
    init,
    update,
    // Another conversation, or none: the list (and an Esc'd @) is forgotten.
    close: () => { S.dismissed = -1; close(); },
    open,
  });
})();
