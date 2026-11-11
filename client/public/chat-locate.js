// Find a message of the open chat even when it is further back than the
// loaded history (classic script, window.ClowderLocate). Loads after
// chat-locate-rules.js and chat-history.js and before app.js, which calls
// init() once; then:
//   find({sel, messageId?, seq?, still?})  scroll to the message, flash it and
//       give it focus. When it is not on screen, earlier pages are read through
//       the history's own loader (ClowderHistory.load), within a budget of
//       page requests (the history's own reading through empty pages counts),
//       and each page is waited for until it is actually drawn, with one quiet
//       progress note; a search that cannot find it stops and says why.
//       Resolves to true (found), null (not found, and the owner was told why,
//       or the lookup ended quietly) or false (no such chat open).
// The search palette's ClowderPalette.locate and a quote's jump use it.
//
// A lookup belongs to one operation: the chat and the history generation it
// began in (another conversation of the same cat starts the history over),
// the caller's own `still()` (the palette's choice), and its turn (a newer
// find supersedes it). Before every further load, note or focus it checks it
// is still that operation; otherwise it stops quietly and takes back only
// the note it put up itself.
//
// Every row still comes from the server and is drawn by the history's keyed
// redraw: this module only asks for the page before, waits for the drawing
// and looks again. Nothing is stored.
(() => {
  "use strict";
  const R = window.ClowderLocateRules;
  let H = null;
  let turn = 0;
  // The lookup whose note is up, if any, and that note's owner token (the shell
  // hides a note only for its owner, so a late clear never takes another toast).
  let noteBy = 0, noteToken = null;
  const keyOf = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const kids = (n) => (n && n.children ? [...n.children] : []);
  // How long a read page may take to be drawn (a send in flight defers drawing).
  const DRAW_WAIT = 20000;

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

  // ---- notes, owned by the lookup that put them up
  function say(op, text, busy) {
    noteBy = op;
    noteToken = { op };
    H.note(text, !!busy, noteToken);
  }
  function unsay(op) {
    if (!noteBy || (op && noteBy !== op)) return;
    H.note("", false, noteToken);
    noteBy = 0;
    noteToken = null;
  }

  const sameChat = (sel) => !!sel && keyOf(H.selected()) === keyOf(sel);
  const older = () => (H.history && H.history.older ? H.history.older()
    : { key: "", gen: 0, state: "end", more: false, loaded: 0, drawn: 0, error: "", asked: 0, failures: 0 });

  async function find({ sel, messageId, seq, still } = {}) {
    if (!H || !sel || (!messageId && (seq == null || seq === ""))) return false;
    if (!sameChat(sel)) return false;
    const op = ++turn;
    // A superseded lookup's progress note goes now; its own exit leaves this one alone.
    unsay();
    const target = { messageId: messageId ? String(messageId) : "", seq: seq == null ? null : String(seq) };
    const start = older();
    const key = keyOf(sel), gen = start.gen, asked0 = start.asked, fail0 = start.failures;
    const alive = () => {
      const now = older();
      return op === turn && (!still || still() === true) && sameChat(sel) && now.key === key && now.gen === gen;
    };
    // Ended without a word (another chat or conversation, a newer lookup, the palette moved on).
    const quiet = () => { unsay(op); return null; };
    let stalled = false;
    for (;;) {
      if (!alive()) return quiet();
      const st = older(), row = rowOf(sel, target), pages = st.asked - asked0;
      const step = R.next({ found: !!row, pages, failed: st.failures > fail0, more: st.more, state: st.state, alive: true, stalled });
      if (step.act === "found") {
        unsay(op);
        mark(row);
        return true;
      }
      if (step.act === "stop") {
        const said = R.stopped(step.why, pages, st.error);
        if (said) say(op, said, false); else unsay(op);
        // Not found here: focus that was left nowhere (the palette closed) goes back to the composer.
        if (said && H.rest && (!document.activeElement || document.activeElement === document.body)) H.rest();
        return null;
      }
      // One quiet note while it looks, updated per page.
      say(op, R.progress(pages), true);
      try { await H.history.load({ cap: asked0 + R.MAX_PAGES }); } catch (e) { /* the history counts its own failure */ }
      if (!alive()) return quiet();
      const after = older();
      if (after.failures > fail0) continue;
      // Read is not drawn: wait until a drawing of the history includes every
      // page read (a send in flight, or a failed redraw, defers it).
      if (after.drawn < after.loaded) {
        const drawn = H.history.whenDrawn ? await H.history.whenDrawn(after.loaded, DRAW_WAIT) : true;
        if (!alive()) return quiet();
        if (!drawn) {
          const said = R.stopped("undrawn", after.asked - asked0, "");
          say(op, said, false);
          return null;
        }
      }
      const moved = older();
      stalled = moved.asked === st.asked && moved.loaded === st.loaded && moved.state === st.state && moved.more === st.more;
    }
  }

  // Hooks from app.js: thread (#thread), selected() (the open chat {type, id}),
  // history (window.ClowderHistory), note(text, busy, owner) (the quiet toast;
  // "" with an owner hides it only while that owner's note is up), rest()
  // (focus the composer where that does not raise a phone's keyboard).
  function init(hooks) { H = hooks; }

  window.ClowderLocate = Object.freeze({ init, find, mark });
})();
