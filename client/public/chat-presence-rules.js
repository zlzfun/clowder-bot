// Rules for a chat that feels alive (classic script, window.ClowderPresenceRules):
// each cat's own colour where it stays legible, what the header says while
// cats reply, which of the owner's messages carries the "seen" paw, and what
// a sidebar row shows while its cat replies. No DOM and no network:
// chat-presence.js draws from these and tests load the same file.
//
// Everything here is a projection of facts the page already has: the
// server's colour pair for a cat (bots[].accent, docs/xbot-api.md), the
// replies chat-live.js is drawing (ClowderLive.presence()), the transcript's
// rows (native.replyTo names the owner message a reply answers) and the
// status poll. Nothing is guessed and nothing is kept as a record.
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");

  // ---- A cat's own colour ----
  // The native colour pair, only as the server gives it (#rrggbb both).
  const HEX = /^#[0-9a-f]{6}$/i;
  function accent(bot) {
    const a = bot && bot.accent;
    return a && HEX.test(str(a.primary)) && HEX.test(str(a.secondary)) ? { primary: a.primary.toLowerCase(), secondary: a.secondary.toLowerCase() } : null;
  }
  // A surface colour as the theme's tokens give it: #rgb, #rrggbb(aa) or
  // rgb()/rgba(). A see-through surface cannot be judged: null.
  function rgb(value) {
    const s = str(value).trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return m[1].split("").map((c) => parseInt(c + c, 16));
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
    if (m) return m[2] && m[2] !== "ff" ? null : [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
    if (!m) return null;
    if (m[4] !== undefined && (m[5] ? Number(m[4]) / 100 : Number(m[4])) < 1) return null;
    const c = [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Math.round(Number(x)))));
    return c.some((x) => !Number.isFinite(x)) ? null : c;
  }
  // WCAG 2 relative luminance and contrast ratio (1 to 21; 0 when either colour is unreadable).
  function luminance(c) {
    const lin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  }
  function contrast(a, b) {
    const x = rgb(a), y = rgb(b);
    if (!x || !y) return 0;
    const l1 = luminance(x), l2 = luminance(y);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  // Words need 4.5:1, a mark or a glyph 3:1 (WCAG 1.4.3 and 1.4.11).
  const INK = 4.5, MARK = 3;
  // The legibility decision: the pair's primary if it stands out enough on
  // this surface, else its secondary, else "" (the theme's own colour stays).
  function legible(pair, surface, min) {
    if (!pair || !rgb(surface)) return "";
    for (const c of [pair.primary, pair.secondary]) if (HEX.test(str(c)) && contrast(c, surface) >= min) return c.toLowerCase();
    return "";
  }
  // Where a cat's colour is used, each on the surface it sits on (the
  // current theme's tokens, chat-presence.js reads them):
  //   ink   the speaker's name in a group chat (words on the chat surface);
  //   paw   its typing paws (a glyph on the reply bubble);
  //   seen  the paw by the owner's message it picked up (a glyph on the chat).
  // null: no colour pair (the cat looks exactly as before).
  function tints(bot, surfaces) {
    const pair = accent(bot), s = surfaces || {};
    if (!pair) return null;
    return { ink: legible(pair, s.chat, INK), paw: legible(pair, s.bubble, MARK), seen: legible(pair, s.chat, MARK) };
  }
  const quote = (v) => '"' + str(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]+/g, " ") + '"';
  const catIdOf = (bot) => str(bot && (bot.native_id || bot.id) != null ? String(bot.native_id || bot.id) : "");
  // The rules for one style element: rows are found by the speaker key the
  // history already writes (data-sender="bot:cat:<native ID>"), so no row is
  // touched or drawn again for a colour. Colours that are not legible are
  // left out, and so the theme's own colour applies.
  function accentCss(bots, surfaces) {
    const out = [];
    for (const bot of bots || []) {
      const id = catIdOf(bot), t = id ? tints(bot, surfaces) : null;
      if (!t) continue;
      const row = ".thread-inner > .msg[data-sender=" + quote("bot:cat:" + id) + "]";
      if (t.ink) out.push(".thread-inner.grpchat > .msg[data-sender=" + quote("bot:cat:" + id) + "] .who > span:first-child { color: " + t.ink + "; }");
      // At full strength: the ratio checked here is the one drawn.
      if (t.paw) out.push(row + " { --pz-paw: " + t.paw + "; --pz-paw-strength: 1; }");
      if (t.seen) out.push(".pz-seen[data-cat=" + quote(id) + "] { color: " + t.seen + "; }");
    }
    return out.join("\n");
  }

  // ---- What the header says while cats reply ----
  // From the same live state the reply rows show (ClowderLive.presence()),
  // in a messenger's few words: what the reply's quiet line says in detail
  // (在看 说明.md, 在运行命令 …), the header says in short. 在查资料… only for
  // tools known to read or search (reading files, searching them, a web
  // search, reading a page, and Codex's equivalents); a browser or a memory
  // tool proves no lookup, so it gets broader words.
  const LOOKING = new Set(["look", "dig", "web", "site"]);
  function doing(reply, verb) {
    if (!reply) return "";
    if (reply.phase === "thinking") return "在想…";
    if (reply.phase === "step") {
      const kind = typeof verb === "function" ? str(verb(reply.tool)) : "";
      if (LOOKING.has(kind)) return "在查资料…";
      if (kind === "lookup") return "在查找…";
      if (kind === "browser") return "在用浏览器…";
      if (kind === "write" || kind === "edit") return "在写文件…";
      if (kind === "run") return "在运行命令…";
      if (kind === "split") return "在分头处理…";
      if (kind === "plan") return "在列计划…";
      return "在处理…";
    }
    // Started, or writing words (also before the first word: the typing bubble).
    return "正在输入…";
  }
  // now: {stopping, replies: [{catId, phase, tool, unsure}]}; name(catId): a
  // cat's name; group: a group chat (says who). "" when no cat is replying.
  // A reply whose stream was lost and that nothing has confirmed since
  // (unsure) makes no claim at all: the header says nothing about it until
  // an event or a read shows it again.
  const sure = (now) => (now && Array.isArray(now.replies) ? now.replies : []).filter((r) => r && str(r.catId) && !r.unsure);
  function headerLine(now, name, group, verb) {
    const replies = sure(now);
    if (!replies.length) return "";
    if (now.stopping) return "正在停止…";
    if (!group) return doing(replies[replies.length - 1], verb);
    const cats = [...new Set(replies.map((r) => r.catId))];
    const nameOf = (id) => str(typeof name === "function" ? name(id) : "");
    if (cats.length === 1) return nameOf(cats[0]) + doing(replies.filter((r) => r.catId === cats[0]).at(-1), verb);
    const names = cats.map(nameOf);
    if (cats.length === 2 && names.every(Boolean)) return names.join("、") + "正在输入…";
    return cats.length + " 只猫猫正在输入…";
  }
  // What one polite announcement says when that changes: the header's words
  // (in a single chat with the cat's name, since nothing else is read with
  // them), or 排队中 while a send waits behind other work. "" says nothing.
  function spokenLine(now, name, group, verb) {
    const words = headerLine(now, name, group, verb);
    if (words) {
      if (group || now.stopping) return words;
      const last = sure(now).at(-1);
      return str(typeof name === "function" ? name(last.catId) : "") + words;
    }
    return now && Array.isArray(now.waiting) && now.waiting.some((w) => w && w.queued) ? "排队中" : "";
  }

  // ---- A sidebar row while its cat replies ----
  // A status entry's own conversation is running: its activity (the row's
  // own single chat, or the group's thread) was read whole and lists an
  // active invocation, and the last status poll succeeded (stale: it failed,
  // so what it said earlier may be out of date). A cat's overall state
  // ("running") is not enough: it also counts its work in other chats.
  function ownActive(entry, stale) {
    const a = entry && entry.activity;
    return !stale && !!a && a.readStatus === "ready" && Array.isArray(a.active) && a.active.length > 0;
  }
  // kind: the status poll's state for that chat (experience rules' side());
  // live: the open chat's header words ("" for any other chat, or when
  // nothing is being written); own: ownActive() for that row. "live": the
  // row says the live words with the typing dots; "status": the status's own
  // busy line, its spinner drawn as typing dots; "": as it is. What needs the
  // owner (等你确认, a failure, a state that cannot be told) is never covered.
  function rowShows(kind, live, own) {
    if (kind === "awaiting" || kind === "failure" || kind === "unknown") return "";
    if (str(live)) return "live";
    return own ? "status" : "";
  }

  // ---- Seen: the engine picked up the owner's message ----
  // The owner's own messages (single chat role "user", group kind "person").
  const ownerRow = (m) => !!m && (m.role === "user" || m.kind === "person") && !m.internal;
  const midOf = (m) => (m && (m.native_message_id || m.id) != null ? String(m.native_message_id || m.id) : "");
  // A cat's reply that began: the engine's own assistant record with its cat
  // (system, connector and delivery records are not; nor is a refusal or a
  // reminder line, notice), with evidence the cat started on it: it is being
  // produced (a processing response or a draft), it has words, files, cards
  // or tool steps of its own, or it finished normally. A reply that failed,
  // was stopped or interrupted before producing anything proves nothing.
  function began(m) {
    const n = m && m.native;
    if (!n || n.type !== "assistant" || !str(n.catId) || m.notice) return false;
    const status = n.lifecycle && typeof n.lifecycle.status === "string" ? n.lifecycle.status : "";
    if (status === "processing" || n.isDraft === true) return true;
    if (str(n.content).trim()) return true;
    if ((m.attachments || []).length || (m.blocks || []).length || Number(m.blocks_hidden) > 0) return true;
    if (Array.isArray(n.toolEvents) && n.toolEvents.length > 0) return true;
    return status === "completed";
  }
  // A message the owner sent while this reply was being written, which the
  // reply took in (the engine lists it among the messages the reply answers,
  // lifecycle.inputMessageIds) and which says the cat read it: its own
  // record has a dispatch to this reply (statusMessageId, and this cat when
  // it names one) marked inputRead "read" (chat-live-api.md 「会话行」).
  function readBy(owner, reply) {
    const refs = owner && owner.native && owner.native.lifecycle && Array.isArray(owner.native.lifecycle.dispatchRefs) ? owner.native.lifecycle.dispatchRefs : [];
    const id = str(reply.native.id), cat = str(reply.native.catId);
    return !!id && refs.some((r) => !!r && typeof r === "object" && !!r.inputRead && r.inputRead.status === "read"
      && str(r.statusMessageId) === id && (r.targetId === undefined || str(r.targetId) === cat));
  }
  // owner message ID → the cats (native IDs) whose reply answers it, in
  // order. The reply's native replyTo names the owner message it answers,
  // and a reply that went on with what the owner said meanwhile answers
  // those too, once they were read (readBy). Only a reply that began says
  // so: a message waiting in the queue, one that did not go out, or one
  // whose reply failed before starting has none.
  function picked(messages) {
    const owners = new Map(), out = new Map();
    for (const m of messages || []) if (ownerRow(m) && midOf(m)) owners.set(midOf(m), m);
    const add = (to, cat) => {
      const list = out.get(to) || [];
      if (!list.includes(cat)) list.push(cat);
      out.set(to, list);
    };
    for (const m of messages || []) {
      // A cat's whole answer that was one emoji is drawn on the owner's row
      // (reactions[], chat-reactions.js): a finished reply to it, so seen too.
      if (ownerRow(m) && midOf(m) && Array.isArray(m.reactions)) {
        for (const r of m.reactions) if (r && r.mine === false && str(r.native_cat_id)) add(midOf(m), r.native_cat_id);
      }
      if (!began(m)) continue;
      const to = typeof m.native.replyTo === "string" ? m.native.replyTo : "";
      if (to && owners.has(to)) add(to, m.native.catId);
      const inputs = m.native.lifecycle && Array.isArray(m.native.lifecycle.inputMessageIds) ? m.native.lifecycle.inputMessageIds : [];
      for (const id of inputs) if (typeof id === "string" && id !== to && owners.has(id) && readBy(owners.get(id), m)) add(id, m.native.catId);
    }
    return out;
  }
  // ids: the owner's messages drawn on screen, in order. The paw sits by the
  // latest one the engine picked up (a later one still waiting has none).
  function seenMark(ids, seen) {
    for (let i = (ids || []).length - 1; i >= 0; i--) if (seen && seen.has(ids[i])) return { id: ids[i], cats: seen.get(ids[i]) };
    return null;
  }
  function seenWords(cats, name) {
    const names = (cats || []).map((id) => str(typeof name === "function" ? name(id) : "")).filter(Boolean);
    if (!names.length) return "猫猫看到了";
    if (names.length <= 2) return names.join("、") + "看到了";
    return names.slice(0, 2).join("、") + "等 " + names.length + " 只猫猫看到了";
  }

  // ---- The calendar day, for 今天 / 昨天 separators ----
  // The local day a time falls on: when it changes, labels drawn as 今天 or
  // 昨天 are out of date.
  function dayOf(t) {
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() : "";
  }

  window.ClowderPresenceRules = Object.freeze({
    accent, rgb, contrast, legible, tints, accentCss, INK, MARK,
    headerLine, spokenLine, ownActive, rowShows, began, picked, seenMark, seenWords, dayOf,
  });
})();
