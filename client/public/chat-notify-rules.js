// When a desktop notification is due (classic script, window.ClowderNotifyRules).
// No DOM, no network, no browser API: chat-notify.js asks these with the
// status the shell already polls (GET /xbot-api/bots/status: each chat's
// activity with its unread count, its latest line `last` and its open
// approvals) and tests load the same file.
//
// A notification only repeats what that status says: a cat's reply that is
// the chat's latest line and still unread, or a request for confirmation that
// newly appeared. Never for the chat in view (visible tab, that chat open),
// never twice for the same message or request, and nothing for what was
// already there when the page first read the status.
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");
  const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const clip = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join("") + "…" : s; };

  // Each chat of a status answer, keyed as the shell keys conversations.
  function chats(data) {
    const out = [];
    for (const b of data && Array.isArray(data.bots) ? data.bots : []) {
      if (b && typeof b.bot === "string" && b.bot) out.push({ key: "bot:" + b.bot, type: "bot", id: b.bot, activity: b.activity && typeof b.activity === "object" ? b.activity : null });
    }
    for (const g of data && Array.isArray(data.groups) ? data.groups : []) {
      if (g && typeof g.id === "string" && g.id) out.push({ key: "group:" + g.id, type: "group", id: g.id, activity: g.activity && typeof g.activity === "object" ? g.activity : null });
    }
    return out;
  }

  // memory: Map key → {threadId, last, approvals: Set} of what was already
  // seen (and so never announced again); a new Map comes back with the notes.
  // inView: the key of the chat the owner is looking at ("" while the tab is
  // hidden). The first sight of a chat (or of its new conversation) is only
  // remembered.
  function decide(memory, list, inView) {
    const next = new Map(memory), notes = [];
    for (const c of list) {
      const a = c.activity;
      const before = memory.get(c.key);
      const threadId = a ? str(a.threadId) : "";
      const last = a && a.last && typeof a.last === "object" && typeof a.last.messageId === "string" && a.last.messageId ? a.last : null;
      const asks = a && Array.isArray(a.items) ? a.items.filter((i) => i && i.kind === "approval" && typeof i.id === "string" && i.id) : [];
      if (!a) { if (!before) next.set(c.key, { threadId: "", last: "", approvals: new Set() }); continue; }
      if (!before || (threadId && before.threadId && threadId !== before.threadId)) {
        next.set(c.key, { threadId, last: last ? last.messageId : "", approvals: new Set(asks.map((i) => i.id)) });
        continue;
      }
      const seen = new Set(before.approvals);
      const entry = { threadId: threadId || before.threadId, last: before.last, approvals: seen };
      const away = c.key !== inView;
      if (last && last.messageId !== before.last) {
        entry.last = last.messageId;
        // A cat's reply the server still counts as unread.
        if (away && last.from === "cat" && typeof a.unread === "number" && a.unread > 0) {
          notes.push({ kind: "reply", key: c.key, type: c.type, id: c.id, tag: "reply:" + last.messageId, messageId: last.messageId,
            catId: str(last.catId), catName: oneLine(last.catName), text: oneLine(last.text), files: Number.isSafeInteger(last.files) ? last.files : 0 });
        }
      }
      for (const i of asks) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        if (away) notes.push({ kind: "approval", key: c.key, type: c.type, id: c.id, tag: "approval:" + (str(i.proposalId) || i.id), proposalId: str(i.proposalId),
          messageId: str(i.messageId), catId: str(i.catId), catName: oneLine(i.catName) });
      }
      next.set(c.key, entry);
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
  //   stored: the owner turned it on here; support: the browser has
  //   notifications; permission: "granted" | "denied" | "default".
  function setting(stored, support, permission) {
    if (!support) return { on: false, hint: "这个浏览器不支持桌面通知。" };
    if (!stored) return { on: false, hint: "" };
    if (permission === "granted") return { on: true, hint: "" };
    if (permission === "denied") return { on: false, hint: "浏览器现在不允许这里发通知，所以不会提醒。" };
    return { on: false, hint: "还没有得到浏览器的允许，所以不会提醒。" };
  }
  // After asking the browser (turning it on): what the owner is told.
  function asked(permission) {
    if (permission === "granted") return { on: true, said: "已打开。" };
    if (permission === "denied") return { on: false, said: "浏览器拒绝了通知。要打开，先在浏览器的网站设置里允许这里发通知。" };
    return { on: false, said: "没有得到浏览器的允许，通知没有打开。" };
  }

  window.ClowderNotifyRules = Object.freeze({ chats, decide, words, setting, asked });
})();
