// Find a message of the open chat even when it is further back than the
// loaded history (classic script, window.ClowderLocate). Loads after
// chat-locate-rules.js and chat-history.js and before app.js, which calls
// init() once; then:
//   find({sel, messageId?, seq?})  scroll to the message, flash it and give it
//       focus. When it is not on screen, earlier pages are read through the
//       history's own loader (ClowderHistory.load), a bounded number of them,
//       with one quiet progress note, until the message is drawn; a search
//       that cannot find it stops and says why. Resolves to true (found),
//       null (not found, and the owner was told why, or the chat changed and
//       there is nothing to say) or false (no such chat open).
// The search palette's ClowderPalette.locate and a quote's jump use it.
//
// Every row still comes from the server and is drawn by the history's keyed
// redraw: this module only asks for the page before, waits for the redraw
// and looks again. Nothing is stored; a newer find, or another chat, ends an
// older one quietly.
(() => {
  "use strict";
  const R = window.ClowderLocateRules;
  let H = null;
  let gen = 0;
  const keyOf = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const kids = (n) => (n && n.children ? [...n.children] : []);

  // The open chat's history on screen (not a loading skeleton or another view).
  function historyOf(sel) {
    const key = keyOf(sel);
    return kids(H && H.thread).find((c) => c.classList.contains("thread-inner") && c.dataset.chat === key) || null;
  }
  // The last row of a message (a message may draw more than one bubble).
  function rowOf(sel, target) {
    const inner = historyOf(sel);
    let hit = null;
    if (inner) for (const row of inner.querySelectorAll("[data-mid], [data-seq]")) if (R.matches(row, target)) hit = row;
    return hit;
  }

  // Found: in the middle of the view, a short flash on its bubble and focus
  // (the ring follows the bubble, polish.css). Motion is the stylesheet's,
  // off when reduced.
  function mark(row) {
    if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
    if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");
    row.classList.remove("cx-hit");
    void row.offsetWidth;
    row.classList.add("cx-hit");
    setTimeout(() => row.classList.remove("cx-hit"), 1500);
    row.focus({ preventScroll: true });
  }

  const sameChat = (sel) => !!sel && keyOf(H.selected()) === keyOf(sel);
  const older = () => (H.history && H.history.older ? H.history.older() : { key: "", state: "end", more: false, error: "" });

  async function find({ sel, messageId, seq } = {}) {
    if (!H || !sel || (!messageId && (seq == null || seq === ""))) return false;
    if (!sameChat(sel)) return false;
    const mine = ++gen, target = { messageId: messageId ? String(messageId) : "", seq: seq == null ? null : String(seq) };
    let pages = 0, noted = false;
    for (;;) {
      if (mine !== gen) return null;
      const st = older(), row = rowOf(sel, target);
      const step = R.next({ found: !!row, pages, more: st.more, state: st.state, sameChat: sameChat(sel) && st.key === keyOf(sel) });
      if (step.act === "found") {
        if (noted) H.note("");
        mark(row);
        return true;
      }
      if (step.act === "stop") {
        const said = R.stopped(step.why, pages, st.error);
        if (said) H.note(said);
        else if (noted) H.note("");
        // Not found here: focus that was left nowhere (the palette closed) goes back to the composer.
        if (said && H.rest && (!document.activeElement || document.activeElement === document.body)) H.rest();
        return null;
      }
      // One quiet note while it looks, updated per page.
      H.note(R.progress(pages), true);
      noted = true;
      const before = st.state;
      try { await H.history.load(); } catch (e) { /* the history says its own failure (state "failed") */ }
      // A page counts once one was really asked for (not one already on its way).
      if (before !== "loading") pages++;
    }
  }

  // Hooks from app.js: thread (#thread), selected() (the open chat {type, id}),
  // history (window.ClowderHistory), note(text, busy) (the quiet toast),
  // rest() (focus the composer where that does not raise a phone's keyboard).
  function init(hooks) { H = hooks; }

  window.ClowderLocate = Object.freeze({ init, find, mark });
})();
