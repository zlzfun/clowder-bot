// When a desktop notification is due (classic script, window.ClowderNotifyRules).
// No DOM, no network, no browser API: chat-notify.js asks these with the
// status the shell already polls (GET /xbot-api/bots/status: each chat's
// activity with its unread count, its latest line `last` and its open
// approvals) and tests load the same file.
//
// A notification only repeats what that status says: a cat's reply that is
// the chat's latest line and still unread, or a request for confirmation that
// newly appeared. Never for a chat the owner is looking at (in any tab), never
// twice for the same message or request, and nothing for what was already
// there when that part of the status was first read successfully.
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");
  const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const clip = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join("") + "…" : s; };

  // A conversation's key: a cat by its native ID (its name can change), a group by its ID.
  const keyOf = (type, id, nativeId) => (type === "group" ? "group:" + id : "bot:" + (nativeId || id));

  // Each chat of a status answer. A cat keeps its native ID (to find it again
  // when a notification is clicked) and its name at the time (to show).
  function chats(data) {
    const out = [];
    for (const b of data && Array.isArray(data.bots) ? data.bots : []) {
      if (!b || typeof b.bot !== "string" || !b.bot) continue;
      const nativeId = str(b.native_id);
      out.push({ key: keyOf("bot", b.bot, nativeId), type: "bot", id: b.bot, nativeId, activity: b.activity && typeof b.activity === "object" ? b.activity : null });
    }
    for (const g of data && Array.isArray(data.groups) ? data.groups : []) {
      if (g && typeof g.id === "string" && g.id) out.push({ key: keyOf("group", g.id), type: "group", id: g.id, nativeId: "", activity: g.activity && typeof g.activity === "object" ? g.activity : null });
    }
    return out;
  }

  // Which parts of an activity read can be trusted: its messages (unread and
  // latest line) and its approvals. A part whose source failed says nothing.
  function sources(a) {
    if (!a) return { messages: false, approvals: false };
    const failed = (src) => (Array.isArray(a.errors) ? a.errors : []).some((e) => e && e.source === src);
    const ok = (src) => a.readStatus === "ready" || (a.readStatus === "partial" && !failed(src));
    return { messages: typeof a.unread === "number" && ok("messages"), approvals: ok("approvals") };
  }
  // A notification's tag: one per message, so a request and its own card
  // message can never be announced twice under two names.
  const tagOf = (messageId, fallback) => (messageId ? "msg:" + messageId : fallback);
  // How many reads a new latest line may wait for the approvals to be known
  // (to tell a request's card message from a reply) before it is announced.
  const PATIENCE = 2;

  // memory: Map key → {threadId, last (latest line's message ID, null until the
  // messages were first read), asks (Set of request IDs, null until the
  // approvals were first read), wait}; a new Map comes back with the notes.
  // visible(key): the owner is looking at that chat (this tab or another).
  function decide(memory, list, visible) {
    const next = new Map(memory), notes = [];
    for (const c of list) {
      const a = c.activity, src = sources(a);
      const threadId = a ? str(a.threadId) : "";
      const was = memory.get(c.key);
      // First sight of the chat, or of another conversation: nothing is known yet.
      let e = !was || (threadId && was.threadId && threadId !== was.threadId)
        ? { threadId, last: null, asks: null, wait: 0 }
        : { ...was, asks: was.asks ? new Set(was.asks) : null };
      if (threadId) e.threadId = threadId;
      const away = !visible(c.key);
      const asks = src.approvals ? (Array.isArray(a.items) ? a.items : []).filter((i) => i && i.kind === "approval" && typeof i.id === "string" && i.id) : null;
      if (asks) {
        // The first successful read of the approvals only remembers them.
        if (!e.asks) e.asks = new Set(asks.map((i) => i.id));
        else for (const i of asks) {
          if (e.asks.has(i.id)) continue;
          e.asks.add(i.id);
          if (away) notes.push({ kind: "approval", key: c.key, type: c.type, id: c.id, nativeId: c.nativeId, tag: tagOf(str(i.messageId), "approval:" + (str(i.proposalId) || i.id)),
            proposalId: str(i.proposalId), messageId: str(i.messageId), catId: str(i.catId), catName: oneLine(i.catName) });
        }
      }
      if (src.messages) {
        const last = a.last && typeof a.last === "object" && typeof a.last.messageId === "string" && a.last.messageId ? a.last : null;
        const id = last ? last.messageId : "";
        if (e.last === null) { e.last = id; e.wait = 0; }   // the first successful read only remembers
        else if (id && id !== e.last) {
          // A new latest line while the approvals are unknown may be a
          // request's card: wait a read or two for them to tell.
          if (!asks && e.wait < PATIENCE) e.wait++;
          else {
            e.last = id;
            e.wait = 0;
            const card = !!asks && asks.some((i) => i.messageId === id);
            if (away && !card && last.from === "cat" && a.unread > 0) {
              notes.push({ kind: "reply", key: c.key, type: c.type, id: c.id, nativeId: c.nativeId, tag: tagOf(id, ""), messageId: id,
                catId: str(last.catId), catName: oneLine(last.catName), text: oneLine(last.text), files: Number.isSafeInteger(last.files) ? last.files : 0 });
            }
          }
        }
      }
      next.set(c.key, e);
    }
    return { notes, memory: next };
  }

  // A note's words: the cat's name (in a group, with the group's name) and the
  // first line of the reply, or what waits.
  function words(note, chatName) {
    const cat = note.catName || (note.type === "bot" ? note.id : "") || "猫猫";
    const group = note.type === "group" ? oneLine(chatName) : "";
    const title = group && group !== cat ? cat + " · " + group : cat;
    let body;
    if (note.kind === "approval") body = "有件事等你确认";
    else body = clip(note.text, 80) || (note.files > 0 ? "发来 " + note.files + " 个文件" : "发来一条消息");
    return { title, body };
  }

  // The switch, the browser's permission and what to say about them.
  //   on: the owner turned it on (this page's own setting); support: the
  //   browser has notifications; permission: "granted" | "denied" | "default".
  function setting(on, support, permission) {
    if (!support) return { on: false, hint: "这个浏览器不支持桌面通知。" };
    if (!on) return { on: false, hint: "" };
    if (permission === "granted") return { on: true, hint: "" };
    if (permission === "denied") return { on: false, hint: "浏览器现在不允许这里发通知，所以不会提醒。" };
    return { on: false, hint: "还没有得到浏览器的允许，所以不会提醒。" };
  }
  // After the owner flipped it: what they are told. kept: the browser
  // remembered the choice for next time.
  const FORGOT = "这个浏览器没能记住这个设置，重新打开页面后会回到原来的样子。";
  function asked(permission, kept = true) {
    if (permission === "granted") return { on: true, said: "已打开。" + (kept ? "" : FORGOT) };
    if (permission === "denied") return { on: false, said: "浏览器拒绝了通知。要打开，先在浏览器的网站设置里允许这里发通知。" };
    return { on: false, said: "没有得到浏览器的允许，通知没有打开。" };
  }
  const turnedOff = (kept = true) => "已关闭。" + (kept ? "" : FORGOT);

  window.ClowderNotifyRules = Object.freeze({ keyOf, chats, sources, decide, words, setting, asked, turnedOff });
})();
