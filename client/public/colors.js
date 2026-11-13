// 配色 in 设置 → 通用 (classic script, window.ClowderColors; docs/xbot-frontend.md
// item 48). Loads after colors-rules.js and before app.js, and mounts itself:
// one row right under 主题, eleven choices, each a small picture of that
// palette (its window, the chat card, a cat's bubble, the owner's bubble and the
// send button) with its name. Choosing shows it at once (the app behind the
// settings sheet is the preview) and remembers it in this browser
// (localStorage xbot-colors, as 主题 keeps xbot-theme); nothing goes to the
// server. A browser that cannot keep it is told so under the choices.
//
// A swatch draws with its own palette's --x-* tokens: cafe-colors.css gives
// .colors-swatch[data-colors="<id>"] the palette's light or dark tokens,
// whichever mode is in effect, so no colour is repeated here.
(() => {
  "use strict";
  const R = window.ClowderColorsRules;
  const root = document.documentElement;
  const store = {
    // true when the browser kept it.
    set(v) { try { if (!window.localStorage) return false; window.localStorage.setItem(R.KEY, v); return true; } catch (e) { return false; } },
  };
  const UI = { group: null, said: null };
  // What the page shows: the boot script put the stored choice on <html> before the first paint.
  const shown = () => R.pick(root.getAttribute("data-colors"));

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Shows a palette at once and remembers it; false when the browser could not keep it. */
  function choose(id) {
    const next = R.pick(id), value = R.attr(next);
    if (value) root.setAttribute("data-colors", value); else root.removeAttribute("data-colors");
    // The browser's own bar follows the window colour, as applyTheme does for light and dark.
    const meta = document.getElementById("theme-color");
    const win = typeof window.getComputedStyle === "function" ? String(window.getComputedStyle(root).getPropertyValue("--x-win") || "").trim() : "";
    if (meta && win) meta.setAttribute("content", win);
    const kept = store.set(next);
    paint(kept ? "" : "这个浏览器记不住这个选择，重新打开后不会保留。");
    return kept;
  }

  // ---------------------------------------------------------------- 通用
  function swatch(id) {
    const ring = node("span", "cc-ring");
    ring.setAttribute("aria-hidden", "true");
    const sw = node("span", "cc-swatch colors-swatch");
    sw.setAttribute("data-colors", id);
    const card = node("span", "cc-card");
    card.append(node("span", "cc-bot"), node("span", "cc-me"), node("span", "cc-send"));
    sw.append(node("span", "cc-row-on"), card);
    ring.append(sw);
    return ring;
  }
  function mount() {
    const pane = document.querySelector('[data-spane="general"]');
    const select = document.getElementById("settings-theme");
    const themeRow = select && select.closest(".setrow");
    if (!pane || !themeRow || !themeRow.parentNode || UI.group) return;
    const row = node("div", "setrow cc-row");
    const tx = node("div", "tx");
    const title = node("b", "", "配色");
    title.id = "cc-title";
    tx.append(title);
    const group = node("div", "cc-grid");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", "cc-title");
    for (const c of R.COLORS) {
      const b = node("button", "cc-opt");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.dataset.id = c.id;
      b.append(swatch(c.id), node("span", "cc-name", c.name));
      b.addEventListener("click", () => choose(c.id));
      group.append(b);
    }
    group.addEventListener("keydown", keys);
    const said = node("p", "setfoot cc-said");
    said.setAttribute("role", "status");
    said.hidden = true;
    row.append(tx, group, said);
    themeRow.parentNode.insertBefore(row, themeRow.nextSibling);
    Object.assign(UI, { group, said });
    paint();
  }
  // The chosen one is checked and is the group's one tab stop.
  function paint(message) {
    if (!UI.group) return;
    const id = shown();
    for (const b of UI.group.children) {
      const on = b.dataset.id === id;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (message !== undefined) { UI.said.textContent = message; UI.said.hidden = !message; }
  }
  // A radio group's keys: arrows choose the next or previous one (round the ends), Home and End the first and last.
  function keys(e) {
    const by = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const next = by ? R.step(shown(), by) : e.key === "Home" ? R.COLORS[0].id : e.key === "End" ? R.COLORS[R.COLORS.length - 1].id : null;
    if (!next || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    choose(next);
    const b = UI.group.querySelector('[data-id="' + next + '"]');
    if (b) b.focus();
  }

  mount();
  window.ClowderColors = Object.freeze({ mount, choose, shown });
})();
