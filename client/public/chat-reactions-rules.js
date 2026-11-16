// Replies and emoji reactions on one message (classic script,
// window.ClowderReactionRules). No DOM and no network: chat-reactions.js and
// app.js ask these rules what a row offers, what is drawn on it and what to
// say, and tests load the same file.
//
// The engine's conversations have no reactions (docs/chat-experience-api.md
// 「回复与表情回应」). A reaction here is an ordinary message: one emoji and
// nothing else, quoting what a cat said. The engine stores it, delivers it and
// wakes the cat with it like any message; the server draws it on the row it
// quotes (a row's reactions[]) instead of as a line of its own, and a cat's
// whole answer that is one emoji is drawn the same way on the owner's row.
// Sent, it is a delivered message: it cannot be taken back or changed, and
// another emoji is another message.
(() => {
  "use strict";
  // The five the chat offers (the same as the engine's multi-person channel,
  // COLLECTIVE_REACTION_EMOJIS). A cat may answer with any emoji at all.
  const EMOJIS = Object.freeze(["👍", "❤️", "🎉", "👀", "🐾"]);
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const midOf = (m) => str(m && (m.native_message_id || m.id));
  const seqOf = (m) => { const n = Number(m && m.seq); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
  // A cat's own words: the engine's assistant record with its cat, drawn as a
  // message (not an execution record, a receipt, a refusal or a reminder).
  function catRow(m) {
    const n = m && m.native;
    return !!n && n.type === "assistant" && !!str(n.catId) && (m.role === "assistant" || m.kind === "bot")
      && m.presentation_kind !== "activity" && !m.notice && !m.reminder;
  }
  const catOf = (m) => (catRow(m) ? str(m.native.catId) : "");

  // What a row carries as reactions, in the order they were sent; anything malformed is left out.
  function marks(m) {
    const list = m && Array.isArray(m.reactions) ? m.reactions : [];
    return list.filter((r) => r && typeof r === "object" && str(r.id) && str(r.emoji)).map((r) => ({
      id: str(r.id), emoji: str(r.emoji), time: str(r.time), mine: r.mine === true, seq: seqOf(r),
      name: r.mine === true ? "" : str(r.name), cat: r.mine === true ? "" : str(r.native_cat_id),
    }));
  }

  // ---- What a row offers ----
  // 回复: any message bubble with its number in this conversation, finished,
  // not a notice line, not in the two-cat exchange (as the message menu
  // always offered it in a single chat).
  function canReply(m, peer) {
    return !peer && !!m && !!seqOf(m) && !m.in_progress && !m.notice && m.presentation_kind !== "activity";
  }
  // A cat still in the group (members: the group record's names, or the
  // native ID of a member the list does not know). Not a group: always.
  function inGroup(m, members, name) {
    if (!Array.isArray(members)) return true;
    const cat = catOf(m), named = str(typeof name === "function" ? name(cat) : "") || str(m.sender || m.name);
    return members.some((x) => str(x) === cat || (!!named && str(x) === named));
  }
  // 表情: only on a cat's own words, finished, that the server can draw a
  // reaction on (ctx.latest: the IDs of the newest page; a reaction to an
  // older page's row would come back as a line of its own), from a cat still
  // in the group (ctx.members; sending to one that left is refused), and
  // with something to react to (an ended reply's stand-in words are not).
  function canReact(m, ctx) {
    const c = ctx || {};
    if (c.peer || !catRow(m) || !seqOf(m) || m.in_progress) return false;
    if (m.ended && !str(c.said).trim() && !(m.attachments || []).length && !(m.blocks || []).length) return false;
    if (c.latest && !c.latest.has(midOf(m))) return false;
    return inGroup(m, c.members, c.name);
  }

  // ---- What is drawn on a row ----
  // pending: this page's own reactions to this row on their way ({emoji}).
  // The emoji the owner has given this row: "sent" (the record has it) or
  // "sending" (on its way). Shown chosen in the picker, never sent twice.
  function given(list, pending) {
    const out = new Map();
    for (const p of pending || []) out.set(str(p.emoji), "sending");
    for (const r of list || []) if (r.mine) out.set(r.emoji, "sent");
    return out;
  }
  // One chip per emoji, in the order each first came: how many, whether the
  // owner is among them, whether the owner's part is still on its way (then
  // the whole chip is: its count and its 你 are not settled yet), and who,
  // for the tip and the screen reader: 你 first, then the cats by name.
  function chips(list, pending, name) {
    const out = [], at = new Map();
    const chip = (emoji) => {
      let g = at.get(emoji);
      if (!g) { g = { emoji, count: 0, ids: [], mine: false, sending: false, cats: [], names: [] }; at.set(emoji, g); out.push(g); }
      return g;
    };
    for (const r of list || []) {
      const g = chip(r.emoji);
      g.count++;
      g.ids.push(r.id);
      if (r.mine) { g.mine = true; continue; }
      const who = str(typeof name === "function" && r.cat ? name(r.cat) : "") || r.name || "猫猫";
      if (!g.cats.includes(r.cat || who)) { g.cats.push(r.cat || who); g.names.push(who); }
    }
    for (const p of pending || []) {
      const g = chip(str(p.emoji));
      if (g.mine) continue;
      g.count++;
      g.mine = true;
      g.sending = true;
    }
    for (const g of out) g.who = (g.mine ? [g.sending ? "你（发送中）" : "你"] : []).concat(g.names).join("、");
    return out;
  }
  // A chip's identity on screen: a redraw that says the same changes nothing.
  const chipSig = (g) => [g.emoji, g.count, g.mine ? 1 : 0, g.sending ? 1 : 0, g.who].join("|");
  // The reactions a row carries, for finding the row by one of them: their
  // message IDs (data-rx) and their numbers in the conversation (data-rxs).
  function carried(list) {
    return { ids: (list || []).map((r) => r.id).join(" "), seqs: (list || []).filter((r) => r.seq).map((r) => r.seq).join(" ") };
  }

  // ---- This page's own reactions on their way ----
  // An entry is {key, thread, seq, mid, emoji, id, state: "sending"|"sent"};
  // id is the receipt's userMessageId (a send is taken only with one). It has
  // landed once the record has that message: among a row's reactions, or as
  // a row of its own (the row it quoted was no longer on the newest page).
  function settled(entry, messages) {
    if (!entry || !entry.id) return false;
    for (const m of messages || []) {
      if (midOf(m) === entry.id) return true;
      for (const r of marks(m)) if (r.id === entry.id) return true;
    }
    return false;
  }

  // ---- The read position ----
  // The page confirms only the newest reply (activity's latestMessageId);
  // reading is cumulative, so everything before it counts as read with it,
  // as it always has. When that newest reply is a cat's reaction, drawn on an
  // older row, its row in sight is not enough on its own: the newest reply
  // that is a row of its own — the last row, in the history's order, of a cat
  // reply the server counts as one (visible()) — must also be in sight, or
  // have been seen here, or be confirmed, just as it would be with no
  // reaction at all. Returns that row's message ID: [] when the ID is not a
  // cat's reaction, or there is no such row (then the reaction's row alone
  // decides). No times, no counting: the history's own order.
  function readFirst(messages, id) {
    id = str(id);
    let reaction = false, last = "";
    for (const m of messages || []) {
      if (visible(m)) last = midOf(m);
      for (const r of marks(m)) if (!r.mine && r.id === id) reaction = true;
    }
    return reaction && last ? [last] : [];
  }
  // A cat reply the server counts as one (unread, latestMessageId, last; docs/
  // chat-experience-api.md): finished, not stopped, with something to show —
  // words (a failed or interrupted reply's own 「这次没完成」 too), files or
  // cards; not a draft, not one being written, not one stopped, not a bare
  // SILENT or nothing at all.
  function visible(m) {
    if (!catRow(m) || m.in_progress || !midOf(m) || (m.ended && m.ended.how === "stopped")) return false;
    const said = str(m.content != null ? m.content : m.text).trim();
    if (said && said !== "SILENT") return true;
    return (m.attachments || []).length > 0 || (m.blocks || []).length > 0 || Number(m.blocks_hidden) > 0;
  }

  // ---- Sending ----
  // POST <scope>/messages: the emoji as the words, quoting the row by its number.
  function request(emoji, seq, threadId, key) {
    const body = { text: str(emoji), reply_to: seq, idempotencyKey: str(key) };
    if (str(threadId)) body.expectedThreadId = str(threadId);
    return body;
  }
  // A send that did not land: refused (a 4xx, with the server's reason when
  // it gives one in Chinese), or not known (no answer, or a server fault:
  // it may have landed, so tapping again reuses its key). A reply to a cat
  // that has left the group (409 reply_cat_left) is refused with a sentence
  // that already says so in full.
  function failure(status, error, code) {
    const known = Number(status) >= 400 && Number(status) < 500;
    const reason = known && /\p{Script=Han}/u.test(str(error)) ? str(error).replace(/^没能完成：/, "").replace(/[。.]+$/, "") : "";
    return { unknown: !known, reason, whole: known && code === "reply_cat_left" && !!reason };
  }
  // What the owner is told. chat: the chat's name when the owner is no longer in it.
  function failWords(emoji, f, chat) {
    const to = str(chat) ? "给" + str(chat) + "的 " : "";
    if (f.whole) return f.reason;
    if (f.unknown) return "没能确认" + (to || " ") + str(emoji) + " 发出去没有";
    return to + str(emoji) + " 没发出去" + (f.reason ? "：" + f.reason : "");
  }

  window.ClowderReactionRules = Object.freeze({
    EMOJIS, midOf, seqOf, catRow, catOf, marks, canReply, inGroup, canReact, given, chips, chipSig, carried,
    settled, readFirst, visible, request, failure, failWords,
  });
})();
