// Where the details panel sits (classic script, window.ClowderPanel; styles in
// chat-panel.css, docs/xbot-frontend.md item 50). Presentation only: no
// request, no stored state (whether it opens next time stays app.js's
// localStorage["xbot-panel-open"]).
//
// The panel (#panel) was a drawer over the chat card at every width (app.css,
// #243). Where the card has room for both, it now sits beside the chat: the
// chat's column narrows, nothing is dimmed, and both stay usable. Where it has
// none (a phone, or a window and sidebar that would leave the chat too narrow
// to read), it is the drawer with its scrim, exactly as before.
//
// One decision, one class. sync() measures the card itself (.main: the
// sidebar's width, the rail and the desktop shell's margins all change it,
// not only the window) and sets .pb-beside on it; chat-panel.css lays the
// panel out from that class alone, and the shell asks beside() for what
// follows from it (the scrim, Escape, whether the history is covered, what a
// chat link puts away). The mode follows the room and never the open state,
// so an open panel stays open when the room comes or goes.
//
// Also here: a cat's face beside its reply does what the header's identity
// chip does (one delegated listener on the history, so redrawn and repainted
// rows need nothing of their own).
(() => {
  "use strict";
  // The chat's own width beside the panel, at the least, in px. Chosen by
  // looking (item 50): its reading column (app.css: 100% - 64px) is then never
  // narrower than a phone's (390 - 32 = 358px), and the bubbles, cards,
  // tables, the composer with its quote and @ list, the header's chip and ⋯,
  // and the hover buttons beside a bubble still read as they do on a desktop;
  // narrower, replies wrap every few words. It keeps the panel beside at 1280
  // wide with any sidebar, at 1100 with the 280px sidebar and at 1024 with the
  // rail; 1024 with the full sidebar gets the drawer.
  const CHAT = 420;
  // app.css's phone layout (its 767px query): the drawer is the only place there.
  const DESK = 768;

  let H = {}, main = null, panel = null;

  // Room for both: a desktop window, and a card wide enough for the panel and
  // a chat of CHAT px beside it.
  function fits(card, width, viewport) {
    return viewport >= DESK && card - width >= CHAT;
  }
  function beside() {
    return !!main && main.classList.contains("pb-beside");
  }
  // A change that moves the chat's edge (the panel opening or closing beside
  // it, or the mode changing while it is open): the place being read is kept
  // across it at once, in the same frame — at the end it stays at the end,
  // further up the row at the top stays where it was (H.keep).
  function reflow(change) {
    const restore = typeof H.keep === "function" ? H.keep() : null;
    change();
    if (typeof restore === "function") restore();
  }
  function sync() {
    if (!main || !panel) return;
    const now = fits(main.clientWidth || 0, panel.offsetWidth || 0, window.innerWidth || 0);
    if (now === beside()) return;
    const flip = () => main.classList.toggle("pb-beside", now);
    // Closed, the chat keeps its width either way.
    if (typeof H.open === "function" && H.open()) reflow(flip); else flip();
    if (typeof H.changed === "function") H.changed(now);
  }
  // A change of the panel's own (open or closed) that moves the chat's edge
  // only when the panel is beside it.
  function moved(change) {
    if (beside()) reflow(change); else change();
  }

  // A cat's face beside its reply (app.js marks it pb-face: a cat the history
  // knows, never the neutral tile of an unknown speaker; the read-only
  // exchange between two cats draws no such face). Not while the chip is
  // disabled, nor for a click that ends a text selection.
  function onFace(ev) {
    const face = ev.target && typeof ev.target.closest === "function" ? ev.target.closest(".pb-face") : null;
    if (!face || (ev.button && ev.button !== 0)) return;
    if (!H.chip || H.chip.disabled || (typeof H.peer === "function" && H.peer())) return;
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && String(sel)) return;
    if (typeof H.toggle === "function") H.toggle();
  }

  // Hooks from app.js:
  //   main, panel     the card (.main) and the panel (#panel);
  //   thread          the history's scroll box (#thread), for the faces;
  //   chip            the header's identity button (#head-chip);
  //   open()          the panel is open;
  //   keep()          note the place being read; returns what puts it back;
  //   changed(beside) the mode changed (the shell's scrim follows);
  //   toggle()        what a click on the chip does;
  //   peer()          the read-only exchange between two cats is shown.
  function init(hooks) {
    H = hooks || {};
    main = H.main || null;
    panel = H.panel || null;
    if (H.thread && typeof H.thread.addEventListener === "function") H.thread.addEventListener("click", onFace);
    if (main && typeof window.ResizeObserver === "function") new window.ResizeObserver(() => sync()).observe(main);
    if (typeof window.addEventListener === "function") window.addEventListener("resize", sync);
    sync();
  }

  window.ClowderPanel = Object.freeze({ init, beside, sync, moved, fits, CHAT });
})();
