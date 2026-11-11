// Rules for a conversation over time: earlier pages of its history, and the
// first words of a new one (classic script, window.ClowderHistoryRules). No
// DOM and no network: chat-history.js draws from these and tests load the
// same file.
//
// A chat reads its newest page (200 native messages) every few seconds. The
// pages before it are asked for with the cursor the server gives (`before`,
// `<timelineOrderAt|timestamp>:<id>` of a page's first message) on GET
// /xbot-api/bots/:name/transcript and GET /xbot-api/groups/:id. These helpers
// keep the pages the owner scrolled back to joined to the newest page as it
// moves on; they never invent, reorder or drop a row the server gave.
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");

  // A row's identity across reads: its native message. A single chat's
  // delivery row (role tool) is named after the call it answers.
  function rowKey(m) {
    if (!m || typeof m !== "object") return "";
    if (m.role === "tool") return m.tool_call_id ? "tool:" + m.tool_call_id : "";
    const id = m.native_message_id || m.id;
    return id == null || id === "" ? "" : "m:" + String(id);
  }

  // A cursor's native order (`<timelineOrderAt|timestamp>:<id>`), or null.
  function order(cursor) {
    const c = str(cursor), at = c.indexOf(":");
    if (at <= 0) return null;
    const n = Number(c.slice(0, at));
    return Number.isFinite(n) ? n : null;
  }

  // The newest page moved on (new messages came in, or a row changed): the
  // earlier rows the owner loaded stay above it. held: the earlier rows,
  // was: the newest page they were joined to, page: the newest page now,
  // seam: that page's native boundary before and now ({was, now}: cursors).
  // Returns the earlier rows that now sit before the page, or null when the
  // page no longer meets them (more than a page arrived in between): the
  // earlier pages are then let go rather than shown with a hole in them.
  function stitch(held, was, page, seam = {}) {
    held = Array.isArray(held) ? held : [];
    if (!held.length) return [];
    was = Array.isArray(was) ? was : [];
    page = Array.isArray(page) ? page : [];
    const joined = [...held, ...was];
    const first = page.map(rowKey).find(Boolean);
    if (first) {
      const at = joined.findIndex((m) => rowKey(m) === first);
      if (at >= 0) return joined.slice(0, at);
    }
    // None of the newest page's rows is among those held. If the page they
    // were joined to showed rows, they would be: the page has moved past
    // them. If it showed none (records that project to no rows), there is no
    // row to join on and the native boundary is the seam: still joined while
    // it has not moved back.
    if (was.some((m) => rowKey(m))) return null;
    const a = order(seam && seam.was), b = order(seam && seam.now);
    return a != null && b != null && b >= a ? joined : null;
  }

  // An earlier page arrived: its rows go above what is held, except rows
  // already shown (pages can overlap at their edges).
  function prepend(rows, held, page) {
    const seen = new Set([...(held || []), ...(page || [])].map(rowKey).filter(Boolean));
    const fresh = (Array.isArray(rows) ? rows : []).filter((m) => { const k = rowKey(m); return !k || !seen.has(k); });
    return [...fresh, ...(held || [])];
  }

  // The request for the page before `cursor`.
  function pagePath(sel, cursor) {
    if (!sel || !sel.id || !cursor) return "";
    const scope = sel.type === "group" ? "/xbot-api/groups/" : "/xbot-api/bots/";
    return scope + encodeURIComponent(sel.id) + (sel.type === "group" ? "" : "/transcript") + "?before=" + encodeURIComponent(cursor);
  }

  // A page's own answer, checked: its rows, the cursor of the page before it
  // and whether there is one. null when it is not a page at all.
  function page(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.messages)) return null;
    const before = str(data.before);
    return { rows: data.messages, before, more: data.hasMore === true && !!before, thread: str(data.thread_id) };
  }

  // ---- A new conversation's first words ----
  // Suggestions under the cat's greeting in a single chat the owner has not
  // said anything in yet. Generic and short; one tap sends it.
  const STARTERS = Object.freeze(["你能帮我做些什么？", "帮我整理今天要做的事", "陪我聊聊天"]);
  // Shown only while: it is a single chat; its whole record is on screen (no
  // earlier page: more); the cat has said something (its greeting) and is not
  // writing; the owner has said nothing yet, and nothing of theirs is on its
  // way or failed (busy: a send or reply error is on screen).
  function showStarters(read, ctx = {}) {
    if (!read || !read.selection || read.selection.type !== "bot" || ctx.more || ctx.busy) return false;
    const rows = Array.isArray(read.messages) ? read.messages : [];
    let cat = false;
    for (const m of rows) {
      if (!m || m.internal || m.role === "tool" || m.role === "system") continue;
      if (m.role === "user") return false;
      if (m.role === "assistant") {
        if (m.in_progress) return false;
        if (m.presentation_kind !== "activity") cat = true;
      }
    }
    return cat;
  }

  window.ClowderHistoryRules = Object.freeze({ rowKey, order, stitch, prepend, pagePath, page, STARTERS, showStarters });
})();
