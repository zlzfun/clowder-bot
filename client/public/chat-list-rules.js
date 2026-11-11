// Rules for the sidebar as a messenger's contact list, and for each chat's
// own draft (classic script, window.ClowderListRules). No DOM and no network:
// chat-list.js draws from these and tests load the same file.
//
// The facts come from the status poll the sidebar already makes (GET
// /xbot-api/bots/status: each cat's and group's `activity`, whose `last` is
// the latest line said in that conversation, docs/chat-experience-api.md).
// These helpers only read, word and order those facts; a line that was not
// read is never made up, and a failed read is not "nothing said".
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");
  const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const at = (v) => {
    if (v == null || v === "") return 0;
    const t = typeof v === "number" ? v : Date.parse(String(v));
    return Number.isFinite(t) && t > 0 ? t : 0;
  };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

  // Markdown marks a preview should not show (the server already removed the
  // signature and made it one line): headings, quotes, list marks, code
  // fences and ticks, emphasis, links and pictures keep only their words.
  function plain(md) {
    return oneLine(String(md ?? "")
      .replace(/```[^\n]*\n?|~~~[^\n]*\n?/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/`+/g, "")
      .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1$2")
      .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, "$1$2"));
  }

  // ---- The latest line ----
  // One status entry's `activity.last`, checked: {id, time, from, catId,
  // catName, text, files} or null when there is none, or when it is not a
  // line at all. thread: the conversation it belongs to.
  function last(entry) {
    const a = entry && typeof entry === "object" ? entry.activity : null;
    const l = a && typeof a === "object" ? a.last : null;
    if (!l || typeof l !== "object") return null;
    const from = l.from === "owner" || l.from === "cat" ? l.from : "";
    const time = at(l.time);
    const text = plain(str(l.text));
    const files = count(l.files);
    if (!from || !time || (!text && !files)) return null;
    return {
      id: str(l.messageId), time, from, catId: str(l.catId), catName: oneLine(l.catName), text, files,
      thread: str(entry.thread_id) || str(a.threadId),
    };
  }
  // Whether the entry's activity was read whole: a missing `last` from a read
  // that failed or was partial says nothing about what was said.
  const readWhole = (entry) => !!(entry && entry.activity && entry.activity.readStatus === "ready");

  // The preview line: 「你：…」 for the owner; in a group a cat's line reads
  // 「名字：…」; a single chat's cat speaks for its own row. A line that only
  // carries files reads 「[文件]」 or 「[文件] 2 个」.
  function preview(l, group) {
    if (!l) return "";
    const said = l.text || (l.files > 1 ? "[文件] " + l.files + " 个" : l.files ? "[文件]" : "");
    if (!said) return "";
    const who = l.from === "owner" ? "你" : group ? l.catName || "猫猫" : "";
    return clip(who ? who + "：" + said : said, 80);
  }

  // ---- Time ----
  const pad = (n) => String(n).padStart(2, "0");
  const DAY = 86400000;
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  // When a line was said, short and in one style: 刚刚, 5 分钟前, 14:05 (today),
  // 昨天, 周三 (this past week), 11月3日 (this year), 2025/11/3.
  function ago(t, now = Date.now()) {
    t = at(t);
    if (!t) return "";
    const diff = now - t;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    const d = new Date(t), today = midnight(now), day = midnight(t);
    if (day === today) return pad(d.getHours()) + ":" + pad(d.getMinutes());
    // Calendar days apart (a daylight-saving day still counts as one).
    const days = Math.round((today - day) / DAY);
    if (days === 1) return "昨天";
    if (days > 1 && days < 7) return WEEK[d.getDay()];
    if (d.getFullYear() === new Date(now).getFullYear()) return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }
  // The full moment, for a tooltip or a screen reader.
  function stamp(t) {
    t = at(t);
    if (!t) return "";
    const d = new Date(t);
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // ---- Order ----
  // items: [{key, time}] in their order on screen. Conversations with a
  // newest line come first, newest first; the rest keep their order after
  // them. Equal times keep their order, so nothing swaps places by itself.
  function order(items) {
    return (items || []).map((it, i) => ({ key: it.key, time: at(it.time), i }))
      .sort((a, b) => (b.time > 0) - (a.time > 0) || b.time - a.time || a.i - b.i)
      .map((x) => x.key);
  }

  // ---- Unread ----
  // The server's count of new replies in one conversation (a lower bound when
  // there are more than one page holds).
  function unread(entry) {
    const a = entry && entry.activity;
    if (!a || typeof a !== "object") return { n: 0, more: false };
    const n = count(a.unread);
    return { n, more: n > 0 && a.unreadHasMore === true };
  }
  // The row's count: only when it says more than the dot does (two or more).
  function badge(u) {
    if (!u || u.n < 2) return "";
    return u.n > 99 ? "99+" : u.n + (u.more ? "+" : "");
  }
  // All conversations' new replies together. `inView`: the conversation the
  // owner is looking at (open, with the tab visible), left out: a reply that
  // arrives there is being read, not waiting, even before its read is confirmed.
  function total(entries, inView) {
    let n = 0, more = false;
    for (const e of entries || []) { if (inView && e === inView) continue; const u = unread(e); n += u.n; more = more || u.more; }
    return { n, more };
  }
  // The page title with the total in front: 「(3) 团子 · clowder-bot」.
  function title(base, t) {
    base = oneLine(base) || "clowder-bot";
    if (!t || !t.n) return base;
    return "(" + (t.n > 99 ? "99+" : t.n + (t.more ? "+" : "")) + ") " + base;
  }

  // ---- The sidebar greeting ----
  // The owner's name for 「晚上好，名字。」: none when the server only knows
  // the owner as a pronoun (its default owner_name is literally 你).
  function greetName(name) {
    const n = oneLine(name);
    return !n || n === "你" || n === "我" ? "" : n;
  }

  // ---- Drafts ----
  // What the owner was writing in each chat, kept for this browser session
  // and only for chats other than the one open (the composer holds that
  // one). A draft is its text and, in a single chat, the message it quotes.
  // A chat is known by what does not change: a cat by its native ID (its name
  // can), a group by its ID. A quote names its message by the conversation's
  // own number, so it carries that conversation (thread): a quote without
  // one could land on another message elsewhere and is not kept.
  const MAX = 16000;
  function quoteOf(q) {
    if (!q || typeof q !== "object") return null;
    const seq = Number(q.seq), thread = str(q.thread);
    return Number.isSafeInteger(seq) && seq > 0 && thread ? { seq, text: str(q.text).slice(0, 2000), thread } : null;
  }
  // The quote may go into this conversation (thread) only if it was taken there.
  const quoteFits = (q, thread) => !!q && !!thread && q.thread === thread;
  // A draft's key: "cat:<native ID>" for a cat whose ID is known, else the
  // name ("bot:<name>", the old key, read once and moved), "group:<id>".
  function draftKey(sel, catId) {
    if (!sel || !sel.id) return "";
    if (sel.type === "group") return "group:" + sel.id;
    return catId ? "cat:" + catId : "bot:" + sel.id;
  }
  function drafts(saved) {
    const map = new Map();
    const put = (key, text, quote) => {
      key = str(key);
      if (!key) return false;
      text = str(text).slice(0, MAX);
      quote = quoteOf(quote);
      const had = map.get(key);
      if (!text.trim() && !quote) { map.delete(key); return !!had; }
      map.set(key, { text, quote });
      return !had || had.text !== text || JSON.stringify(had.quote) !== JSON.stringify(quote);
    };
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [key, d] of Object.entries(saved)) if (d && typeof d === "object") put(key, d.text, d.quote);
    }
    return {
      get: (key) => map.get(str(key)) || null,
      put,
      // The draft goes back into the composer: the store lets go of it.
      take(key) { const d = map.get(str(key)) || null; map.delete(str(key)); return d; },
      drop: (key) => map.delete(str(key)),
      // An old name-keyed draft moves to the chat's lasting key (once; never over a newer one).
      move(from, to) {
        from = str(from); to = str(to);
        if (!from || !to || from === to || !map.has(from)) return false;
        if (!map.has(to)) map.set(to, map.get(from));
        map.delete(from);
        return true;
      },
      toJSON: () => Object.fromEntries(map),
    };
  }
  // A draft as its row's preview line.
  function draftLine(d) {
    if (!d) return "";
    const text = oneLine(d.text);
    return text ? clip(text, 80) : d.quote ? "引用了一条消息" : "";
  }

  // ---- A link that opens a chat ----
  // /#chat=<name>: the address names a chat to open. Only a fragment that is
  // exactly chat=… counts (#login-code and the rest are not links to a chat);
  // the name is URL-decoded (a malformed escape is read as written, and + is a
  // plus) and trimmed. null: not such a link; "": a link that names nothing.
  function linkName(hash) {
    const m = /^#chat=([\s\S]*)$/.exec(str(hash));
    if (!m) return null;
    let name = m[1];
    try { name = decodeURIComponent(name); } catch (e) { /* read as written */ }
    return name.trim();
  }
  // The chat a linked name opens: the cat with that name, else the first group
  // chat with it (a group without a name goes by the name it is shown under, its
  // ID). {type: "bot", id: name} | {type: "group", id} | null.
  function linked(name, bots, groups) {
    const n = str(name).trim();
    if (!n) return null;
    const cat = (bots || []).find((b) => b && str(b.name).trim() === n);
    if (cat) return { type: "bot", id: cat.name };
    const group = (groups || []).find((g) => g && str(g.name || g.id).trim() === n);
    return group ? { type: "group", id: group.id } : null;
  }
  // What the app says when no chat answers to a link's name.
  const linkMissing = (name) => "列表里没有叫「" + clip(oneLine(name), 40) + "」的猫猫或群聊。";

  window.ClowderListRules = Object.freeze({
    plain, last, readWhole, preview, ago, stamp, order, unread, badge, total, title, greetName, drafts, draftLine, draftKey, quoteFits, oneLine,
    linkName, linked, linkMissing,
  });
})();
