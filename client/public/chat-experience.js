// The chat's status line, read position and read-only memory (classic
// script, window.ClowderExperience). Loads after chat-experience-rules.js and
// workspace.js and before app.js, which calls init() once and a few hooks:
// select() when the conversation changes, observe() after each transcript or
// group read, touch() on a native event, rendered() after the history is
// drawn, attend() from the sidebar, and memoryView() for the drawer's 记忆.
//
// - Status line (above the composer): one line from GET <scope>/activity in
//   place of the separate execution and Task lines. What waits for the owner
//   leads, then failures, runs, the queue and unfinished Tasks; every other
//   kind keeps its count. It opens in place onto a short list whose rows find
//   the real message (by native message ID) or Task (by Task ID); past the
//   first few, 查看其余 N 项 shows every listed item in place, and stays open
//   across refreshes until the owner folds it or the conversation changes.
//   A partial or failed read says it cannot tell; it never reads as idle.
// - Read position: GET never marks anything read. POST <scope>/read confirms
//   the newest visible cat reply only while the page is visible, the chat is
//   not covered, that reply is on screen (for a moment) and the open
//   conversation's thread is the one the reply belongs to. One request at a
//   time, never twice for the same reply. A refusal (404, 409) is about that
//   one reply: a newer reply is still confirmed. A late answer for another
//   conversation or thread changes nothing here.
// - Memory (a cat's 记忆), read only throughout: 关于你 and 你的偏好 folded and
//   read only when opened (GET /xbot-api/memory/profile|taste), each entry's
//   source on demand with its revision; then the conversation's own notes,
//   named for what they are: 这个对话的便笺. Nothing here edits, adds,
//   deletes, confirms or forgets.
//
// Nothing here schedules, approves or completes anything. Approvals are made
// with the existing controls (the runtime panel); the line only points there.
(() => {
  "use strict";
  const X = window.ClowderExperienceRules;
  const enc = encodeURIComponent;
  const $ = (id) => document.getElementById(id);
  let H = null;
  // How long the newest reply stays on screen before it counts as seen.
  const DWELL = 800;
  const LIST_MAX = 6;
  const RUNTIME = "/runtime.html";
  const ICON = { approval: "awaiting", failure: "circle-x", running: "hourglass", queued: "clock", task: "list-checks", reply: "bubble", unknown: "info" };

  // ------------------------------------------------------------------ helpers
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, onClick, label) {
    const b = node("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  const note = (text, cls) => node("p", "ws-note" + (cls ? " " + cls : ""), text);
  function waiting(text) { const p = note(text, "ws-wait"); p.setAttribute("role", "status"); return p; }
  function failure(text, retry, retryText) {
    const p = node("p", "ws-note ws-bad");
    p.setAttribute("role", "alert");
    p.append(document.createTextNode(text + " "));
    if (retry) p.append(button("text-btn ws-link", retryText || "重试", retry));
    return p;
  }
  function runtimeLink(text) {
    const a = node("a", "ws-link", text);
    a.href = RUNTIME;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }
  function stamp(t) {
    if (!t) return "";
    const d = new Date(t), now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return "今天 " + hm;
    if (diff === 1) return "昨天 " + hm;
    return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "年" : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
  }
  const keyOf = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const scopeOf = (sel) => (sel.type === "group" ? "/xbot-api/groups/" : "/xbot-api/bots/") + enc(sel.id);
  const pageVisible = () => document.visibilityState !== "hidden";

  // -------------------------------------------------------------------- state
  const S = {
    sel: null, key: "", gen: 0, threadId: "",
    act: null, state: "idle", error: "", req: 0, at: 0, loading: null,
    open: false, more: false, said: null, strip: null, sig: "",
  };
  // Replies confirmed, or refused for themselves, by conversation, thread and
  // message: never sent twice. A refusal never covers the conversation, so a
  // newer reply there is still confirmed.
  const done = new Set();
  const R = { pending: "", timer: 0, inflight: false, until: 0 };
  const doneKey = (key, threadId, id) => key + "|" + threadId + "|" + id;

  function select(sel) {
    S.gen++;
    clearTimeout(R.timer);
    Object.assign(R, { pending: "", timer: 0, inflight: false, until: 0 });
    Object.assign(S, {
      sel: sel && sel.id ? { type: sel.type === "group" ? "group" : "bot", id: String(sel.id) } : null,
      threadId: "", act: null, state: "idle", error: "", at: 0, loading: null, open: false, more: false, said: null, sig: "",
    });
    S.key = keyOf(S.sel);
    if (mem && mem.key !== S.key) mem = null;
    paint();
    if (S.sel) loadActivity();
  }

  // After each transcript or group read: the thread it came from and whether
  // the history changed. The activity follows that poll, slower while hidden.
  function observe(sel, threadId, changed) {
    if (!S.sel || keyOf(sel) !== S.key) return;
    const id = threadId ? String(threadId) : "";
    if (id && id !== S.threadId) {
      // Another thread: what was read belongs to the old one.
      if (S.threadId) {
        clearTimeout(R.timer);
        Object.assign(R, { pending: "", timer: 0, until: 0 });
        Object.assign(S, { act: null, open: false, more: false, said: null, sig: "" });
        if (S.state !== "unavailable") S.state = "idle";
      }
      S.threadId = id;
      S.at = 0;
    }
    if (S.state !== "unavailable") {
      const age = Date.now() - S.at;
      if (changed || !S.at || age > (pageVisible() ? 6000 : 30000)) loadActivity(!!changed || !S.at);
    }
    paint();
    check();
  }
  // A native event arrived for this conversation: the next read refreshes.
  function touch() { S.at = 0; }

  // ------------------------------------------------------------- activity
  async function loadActivity(force = true) {
    if (!S.sel) return;
    if (S.loading && !force) return S.loading;
    const gen = S.gen, req = ++S.req, scope = scopeOf(S.sel);
    if (!S.act && S.state !== "unavailable") S.state = "loading";
    const job = (async () => {
      try {
        const data = await H.api(scope + "/activity");
        if (gen !== S.gen || req !== S.req) return;
        const a = X.activity(data);
        if (!a) throw Object.assign(new Error("状态的返回格式无法识别"), { status: 0 });
        // Another thread's state never shows here; the transcript names the
        // thread and the next read asks again.
        if (S.threadId && a.threadId && a.threadId !== S.threadId) { S.at = 0; return; }
        Object.assign(S, { act: a, state: "ready", error: "", at: Date.now() });
      } catch (e) {
        if (gen !== S.gen || req !== S.req) return;
        S.at = Date.now();
        // A server without the projection keeps the earlier lines.
        if (e.status === 404 && !S.act) S.state = "unavailable";
        else Object.assign(S, { state: "error", error: H.visibleError(e, "连不上 clowder-bot") });
      } finally {
        if (gen === S.gen && req === S.req) S.loading = null;
      }
      if (gen !== S.gen) return;
      paint();
      check();
    })();
    S.loading = job;
    return job;
  }

  // ----------------------------------------------------------- the message rows
  // A history row by native message ID: the last of a message's bubbles.
  function findRow(id) {
    const host = H.thread;
    if (!id || !host) return null;
    let hit = null;
    for (const row of host.querySelectorAll("[data-mid]")) if (row.dataset.mid === id) hit = row;
    return hit;
  }
  // On screen in the history's own viewport.
  function inSight(row) {
    const host = H.thread;
    if (!row || !host || !row.isConnected) return false;
    const a = host.getBoundingClientRect(), b = row.getBoundingClientRect();
    return b.bottom > a.top + 4 && b.top < a.bottom - 4;
  }
  const latestInSight = () => {
    const id = S.act && S.act.latestMessageId;
    return !id || inSight(findRow(id));
  };
  function hit(row) {
    row.scrollIntoView({ block: "center" });
    if (row.tabIndex < 0 && !row.hasAttribute("tabindex")) row.tabIndex = -1;
    row.classList.remove("cx-hit");
    void row.offsetWidth;
    row.classList.add("cx-hit");
    setTimeout(() => row.classList.remove("cx-hit"), 1500);
    row.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------- read position
  function target() {
    if (!S.sel || H.peer()) return "";
    return X.readTarget(S.act, {
      pageVisible: document.visibilityState === "visible",
      obscured: !!(H.obscured && H.obscured()),
      threadId: S.threadId,
      done: (id) => done.has(doneKey(S.key, S.threadId, id)),
      seen: (id) => inSight(findRow(id)),
    });
  }
  // Called whenever what is on screen may have changed. Waits a moment with
  // the reply in sight before confirming it.
  function check() {
    const id = target();
    if (!id || R.inflight || Date.now() < R.until) {
      if (!id && R.pending) { clearTimeout(R.timer); R.pending = ""; }
      return;
    }
    if (R.pending === id) return;
    clearTimeout(R.timer);
    R.pending = id;
    const gen = S.gen;
    R.timer = setTimeout(() => { if (gen === S.gen && R.pending === id) { R.pending = ""; confirm(id); } }, DWELL);
  }
  async function confirm(id) {
    // Still true after the wait?
    if (target() !== id || R.inflight) return;
    const gen = S.gen, threadId = S.threadId, sel = S.sel, key = doneKey(S.key, threadId, id);
    // The answer counts here only while the same conversation shows the same thread.
    const current = () => gen === S.gen && threadId === S.threadId;
    R.inflight = true;
    try {
      const reply = await H.api(scopeOf(sel) + "/read", { method: "POST", body: { expectedThreadId: threadId, messageId: id } });
      // Recorded under the reply's own conversation and thread only.
      done.add(key);
      const read = reply && typeof reply.readMessageId === "string" ? reply.readMessageId : "";
      if (current() && reply && reply.threadId === threadId && read) {
        if (S.act && read === S.act.latestMessageId) S.act = { ...S.act, unread: 0, unreadHasMore: false };
        if (H.onRead) H.onRead(sel, threadId, read);
      }
    } catch (e) {
      // 404 says this reply is not (or no longer) a visible reply of that
      // thread, not that reading is unsupported; 409 says the thread moved.
      // Either way only this reply is not asked about again: a newer one is.
      // An answer for a thread or conversation the chat has left leaves
      // nothing behind: no refusal, no wait, no reload.
      if (current()) {
        if (e.status === 404 || e.status === 409) done.add(key);
        if (e.status === 409) { S.at = 0; loadActivity(); }
        else if (e.status !== 404) R.until = Date.now() + 20000;
      }
    } finally {
      if (gen === S.gen) R.inflight = false;
    }
    // Another conversation now: its own state was reset when it opened.
    if (gen !== S.gen) return;
    paint();
    check();
  }

  // --------------------------------------------------------------- status line
  function mountStrip() {
    const work = $("work-status");
    if (!work || S.strip) return;
    const box = node("div", "cx-status");
    box.hidden = true;
    work.after(box);
    S.strip = box;
    box.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || !S.open) return;
      ev.preventDefault();
      ev.stopPropagation();
      S.open = false;
      paint();
      box.querySelector(".cx-row")?.focus({ preventScroll: true });
    });
  }
  const total = (a) => (a ? X.KINDS.reduce((n, k) => n + a.counts[k], 0) : 0);

  function paint() {
    const box = S.strip;
    if (!box || !H) return;
    const dock = box.parentElement;
    // In charge once this conversation's activity is being read; a server
    // without it keeps the earlier execution and Task lines.
    const on = !!S.sel && !H.peer() && S.state !== "unavailable" && S.state !== "idle";
    if (dock && dock.classList) dock.classList.toggle("cx-on", on);
    const fresh = !!S.act && S.act.unread > 0 && !latestInSight();
    const view = on ? X.line(S.act, { failed: S.state === "error", showUnread: fresh }) : null;
    if (!view) S.open = false;
    box.hidden = !view;
    const sig = JSON.stringify([view, S.open, S.open && S.act, S.open && S.more, S.state, S.error, S.said, fresh]);
    if (sig === S.sig) return;
    S.sig = sig;
    if (!view) { box.replaceChildren(); return; }
    const keep = box.contains(document.activeElement) ? document.activeElement.dataset.cxFocus || "" : "";
    const row = button("wrow cx-row", null, () => { S.open = !S.open; S.said = null; paint(); });
    row.dataset.kind = view.kind;
    row.dataset.cxFocus = "row";
    row.setAttribute("aria-expanded", String(S.open));
    row.setAttribute("aria-controls", "cx-list");
    const lead = view.catId ? H.face(view.catId, view.catName, "xs") : H.icon(ICON[view.kind] || "info");
    row.append(lead, node("b", "cx-lead", view.lead));
    if (view.label) { const l = node("span", "cx-label", view.label); l.title = view.label; row.append(l); }
    if (view.rest.length) row.append(node("span", "cx-rest", "· " + view.rest.join(" · ")));
    if (view.partial) row.append(node("span", "cx-partial", "· 部分状态读不到"));
    row.append(H.icon("chevron", "cx-chev"));
    row.setAttribute("aria-label", [view.lead, view.label, ...view.rest, view.partial ? "部分状态读不到" : ""].filter(Boolean).join("，") + "。" + (S.open ? "收起" : "展开查看"));
    const parts = [row];
    if (S.open) parts.push(listView(fresh));
    box.replaceChildren(...parts);
    if (keep) [...box.querySelectorAll("[data-cx-focus]")].find((n) => n.dataset.cxFocus === keep)?.focus({ preventScroll: true });
  }

  function listView(fresh) {
    const list = node("div", "cx-list");
    list.id = "cx-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "需要留意的事项");
    const a = S.act;
    const all = a ? a.items : [];
    // Short by default; every listed item stays reachable in place. The
    // owner's choice holds across refreshes of the same conversation.
    const items = S.more ? all : all.slice(0, LIST_MAX);
    for (const item of items) list.append(itemRow(item));
    if (all.length > LIST_MAX) {
      const rest = all.length - LIST_MAX;
      const fold = button("text-btn ws-link", S.more ? "收起" : "查看其余 " + rest + " 项", () => { S.more = !S.more; S.said = null; paint(); },
        S.more ? "收起其余 " + rest + " 项" : "查看其余 " + rest + " 项");
      fold.dataset.cxFocus = "more";
      fold.setAttribute("aria-expanded", String(S.more));
      const li = node("div", "cx-item cx-more-row");
      li.append(fold);
      list.append(li);
    }
    if (fresh) {
      const li = node("div", "cx-item");
      li.dataset.kind = "reply";
      const go = button("text-btn ws-link", "看最新回复", () => locate({ kind: "reply", messageId: a.latestMessageId }));
      go.dataset.cxFocus = "reply";
      li.append(H.icon(ICON.reply), node("span", "cx-tag", X.TAG.reply), node("span", "cx-text", X.unreadText(a) + " 条还没看到"), node("span", "cx-acts"));
      li.lastChild.append(go);
      list.append(li);
    }
    // Counted by the server without a row of its own: said, never dropped.
    const more = total(a) - all.length;
    if (more > 0) list.append(note("另有 " + more + " 项没有列出" + (a.counts.task ? "，任务的全部内容在「任务」页。" : "。"), "cx-more"));
    if (S.state === "error") list.append(failure("状态没能刷新：" + S.error + (a ? "。下面是上次读到的结果，可能已经变化。" : "。"), () => loadActivity()));
    else if (a && a.readStatus !== "ready") {
      const p = failure("部分状态暂时读不到，这里不代表已经空闲或全部完成。", () => loadActivity());
      list.append(p);
      for (const e of a.errors.slice(0, 3)) list.append(note([e.source, e.message].filter(Boolean).join("：") || "读取失败", "cx-err"));
    }
    if (S.said) {
      const p = note(S.said.text, "cx-said");
      p.setAttribute("role", "status");
      if (S.said.runtime) p.append(document.createTextNode(" "), runtimeLink("打开运行面板"));
      list.append(p);
    }
    return list;
  }

  function itemRow(item) {
    const li = node("div", "cx-item");
    li.dataset.kind = item.kind;
    li.append(item.catId ? H.face(item.catId, item.catName, "xs") : H.icon(ICON[item.kind] || "info"));
    li.append(node("span", "cx-tag", X.TAG[item.kind]));
    const text = X.itemText(item) || item.catName || X.TAG[item.kind];
    const t = node("span", "cx-text", text);
    t.title = text;
    li.append(t);
    const acts = node("span", "cx-acts");
    // A Task opens at its card (its source message is only where it began).
    if (item.messageId && !(item.kind === "task" && item.taskId)) {
      const b = button("text-btn ws-link", "查看", () => locate(item), "在对话里查看：" + text);
      b.dataset.cxFocus = "msg:" + item.id;
      acts.append(b);
    } else if (item.taskId) {
      const b = button("text-btn ws-link", "打开任务", () => locate(item), "打开任务：" + text);
      b.dataset.cxFocus = "task:" + item.id;
      acts.append(b);
    }
    // Approvals are made with the existing controls, never from this line.
    if (item.kind === "approval") acts.append(runtimeLink("去确认"));
    if (acts.childNodes.length) li.append(acts);
    return li;
  }

  function say(text, runtime) {
    S.said = text ? { text, runtime: !!runtime } : null;
    S.open = true;
    paint();
  }

  // Find what an item points at: the message by its native ID, else the Task.
  // Nothing is located by guess.
  async function locate(item) {
    S.said = null;
    if (item.messageId && !(item.kind === "task" && item.taskId)) {
      const row = findRow(item.messageId);
      if (row) { paint(); hit(row); return true; }
      if (item.kind === "approval") say("当前显示的对话里没有这条确认的消息。可以在运行面板确认。", true);
      else say("这条消息不在当前显示的对话里。");
      return false;
    }
    if (item.taskId && H.focusTask) {
      const ok = await H.focusTask(item.taskId);
      if (!ok) say("「任务」页里还没有读到这项任务。");
      return ok;
    }
    say("这一项没有可以定位的消息或任务。");
    return false;
  }

  // From the sidebar: the conversation is open now; go to what needs the
  // owner (an approval, else a failure). Without a message coordinate the
  // line opens on its list instead of guessing.
  async function attend() {
    if (!S.sel) return false;
    const gen = S.gen;
    if (!S.act) await loadActivity();
    if (gen !== S.gen || !S.act) { if (gen === S.gen && S.strip && !S.strip.hidden) { S.open = true; paint(); } return false; }
    const item = S.act.items.find((i) => i.kind === "approval") || S.act.items.find((i) => i.kind === "failure") || null;
    if (item && item.messageId && findRow(item.messageId)) return locate(item);
    S.open = true;
    S.said = null;
    paint();
    const list = S.strip && S.strip.querySelector(".cx-list");
    const first = list && list.querySelector("button, a");
    (first || (S.strip && S.strip.querySelector(".cx-row")))?.focus({ preventScroll: true });
    return false;
  }

  // After the history was drawn (or scrolled): what is in sight may differ.
  let scrollTimer = 0;
  function rendered() { paint(); check(); }
  function onScroll() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => { scrollTimer = 0; rendered(); }, 200);
  }

  // ------------------------------------------------------------------ 记忆
  // Owner-level memory read on demand, kept across conversations; each
  // fold reads again when it opens. Sources by entry and revision.
  const MEM = { profile: { state: "idle", data: null, error: null, req: 0 }, taste: { state: "idle", data: null, error: null, req: 0 } };
  const SRC = new Map();
  let mem = null;

  function memoryView(sel, data) {
    if (!sel || !sel.id) return waiting("正在加载");
    // Group chats show none of the owner's own records.
    if (sel.type === "group") return node("p", "hint cx-group-mem", "群聊没有可查看的记忆。关于你的资料和偏好，在和猫猫的单聊里查看。");
    const key = keyOf(sel);
    if (!mem || mem.key !== key) mem = buildMemory(sel);
    const n = mem.notes;
    if (data && Array.isArray(data.memory) && data !== n.from) {
      // The drawer brought the notes with it; an older read cannot replace them.
      n.req++;
      Object.assign(n, { from: data, list: data.memory, state: "ready", error: "" });
    } else if (!n.list && n.state === "idle") {
      // The drawer had no notes with it: read them once (a failure offers 重试).
      loadNotes(mem);
    }
    paintNotes();
    for (const kind of ["profile", "taste"]) paintMem(kind);
    return mem.root;
  }

  function buildMemory(sel) {
    const root = node("div", "cx-mem");
    const page = { key: keyOf(sel), sel: { ...sel }, root, folds: {}, notes: { list: null, from: null, state: "idle", error: "", req: 0, sig: "" } };
    for (const kind of ["profile", "taste"]) {
      const box = node("details", "task-details cx-fold");
      box.dataset.kind = kind;
      const sum = node("summary");
      sum.append(node("span", "", X.MEMORY[kind]), H.icon("chevron"));
      const body = node("div", "cx-fold-body");
      box.append(sum, body);
      box.addEventListener("toggle", () => { if (box.open) loadMemory(kind); });
      page.folds[kind] = { box, body, sig: "" };
      root.append(box);
    }
    // The conversation's notes (native thread notes): kept read only, as
    // before, and named for their reach.
    const sec = node("section", "psec cx-notes");
    const h = node("h4", "", "这个对话的便笺");
    const count = node("span", "ws-count");
    h.append(count);
    const list = node("div", "cx-note-list");
    sec.append(h, list, node("p", "hint cx-note-hint", "便笺只属于这个对话，换到别的对话不会带过去。"));
    root.append(sec);
    Object.assign(page.notes, { count, listEl: list });
    return page;
  }

  async function loadMemory(kind) {
    const m = MEM[kind], req = ++m.req;
    if (!m.data) m.state = "loading";
    paintMem(kind);
    try {
      const data = await H.api("/xbot-api/memory/" + kind);
      if (req !== m.req) return;
      const got = X.memory(data, kind);
      if (!got) throw Object.assign(new Error("返回格式无法识别"), { status: 0 });
      Object.assign(m, { state: "ready", data: got, error: null });
    } catch (e) {
      if (req !== m.req) return;
      Object.assign(m, { state: "error", error: X.memoryError(e) });
    }
    paintMem(kind);
  }

  function paintMem(kind) {
    if (!mem) return;
    const f = mem.folds[kind], m = MEM[kind];
    if (!f.box.open && !f.body.childNodes.length && m.state === "idle") return;
    const sig = JSON.stringify([m.state, m.data, m.error, [...SRC].filter(([k]) => k.startsWith(kind + ":")), S.threadId]);
    if (f.sig === sig) return;
    f.sig = sig;
    const opened = new Set([...f.body.querySelectorAll("details.cx-src")].filter((d) => d.open).map((d) => d.dataset.key));
    // A source fold's summary that had focus gets it back after the redraw.
    const here = document.activeElement;
    const back = here && f.body.contains(here) && here.parentElement && here.parentElement.dataset ? here.parentElement.dataset.key || "" : "";
    const retry = () => loadMemory(kind);
    const parts = [];
    if (m.state === "error" && !m.data) {
      const e = m.error || { kind: "error", text: "暂时读不到" };
      if (e.kind === "missing") parts.push(note("当前后端还没有开放这部分。"));
      else if (e.kind === "denied") parts.push(failure("没有权限读取：" + e.text + "。", retry));
      else parts.push(failure("没能读取：" + e.text + "。这不代表没有内容。", retry));
    } else if (!m.data) parts.push(waiting("正在读取…"));
    else {
      const d = m.data;
      if (m.state === "error") parts.push(failure("刷新没有成功，显示的是上次读取的结果。", retry));
      if (d.readStatus === "unavailable") parts.push(failure("暂时读不到" + (d.entries.length ? "全部内容，下面只显示读到的部分" : "，这不代表没有内容") + "。", retry));
      else if (d.readStatus === "partial") parts.push(failure("部分内容暂时读不到，下面只显示读到的部分。", retry));
      if (d.entries.length) {
        const list = node("div", "cx-entries");
        for (const e of d.entries) list.append(entryCard(kind, e, opened));
        parts.push(list);
      } else if (d.readStatus === "ready") parts.push(note(kind === "profile" ? "还没有保存关于你的资料。" : "还没有保存的偏好。"));
    }
    f.body.replaceChildren(...parts);
    if (back) [...f.body.querySelectorAll("details.cx-src")].find((d) => d.dataset.key === back)?.firstChild?.focus?.({ preventScroll: true });
  }

  function entryCard(kind, e, opened) {
    const card = node("div", "lib-card cx-entry");
    const k = node("div", "k", e.title || X.MEMORY[kind]);
    if (e.status === "retired") k.append(node("span", "cx-flag", "已停用"));
    else if (e.status === "unknown") k.append(node("span", "cx-flag", "状态未知"));
    const v = node("div", "v cx-content", e.content || "（没有内容）");
    card.append(k, v);
    const meta = [];
    if (e.updatedAt) meta.push("更新于 " + stamp(e.updatedAt));
    if (meta.length) card.append(node("p", "cx-meta", meta.join(" · ")));
    // Proposed changes are not saved content: counted apart, never shown as it.
    if (e.pendingCount > 0) card.append(node("p", "cx-meta cx-pending", "另有 " + e.pendingCount + " 条待确认的修改，确认前不算已保存，也不在上面的内容里。"));
    const key = kind + ":" + e.id + "@" + e.revision;
    const src = node("details", "task-details cx-src");
    src.dataset.key = key;
    const sum = node("summary");
    sum.append(node("span", "", "来源"), H.icon("chevron"));
    const body = node("div", "cx-src-body");
    src.append(sum, body);
    // Reopened by a redraw, not by the owner: that does not read again.
    if (opened.has(key)) { src.quiet = true; src.open = true; }
    src.addEventListener("toggle", () => {
      if (src.quiet) { src.quiet = false; return; }
      if (src.open) loadSource(kind, e, key);
    });
    if (src.open) paintSource(body, kind, e, key);
    card.append(src);
    return card;
  }

  async function loadSource(kind, e, key) {
    const was = SRC.get(key);
    if (was && was.state === "loading") return;
    const req = (was ? was.req : 0) + 1;
    SRC.set(key, { state: "loading", data: was ? was.data : null, error: null, req });
    paintMem(kind);
    try {
      const data = await H.api("/xbot-api/memory/" + kind + "/" + enc(e.id) + "/source?" + new URLSearchParams({ revision: e.revision }));
      if (SRC.get(key)?.req !== req) return;
      const got = X.sources(data);
      if (!got) throw Object.assign(new Error("返回格式无法识别"), { status: 0 });
      SRC.set(key, { state: "ready", data: got, error: null, req });
    } catch (err) {
      if (SRC.get(key)?.req !== req) return;
      SRC.set(key, { state: "error", data: null, error: X.memoryError(err), req });
    }
    paintMem(kind);
  }

  function paintSource(body, kind, e, key) {
    const s = SRC.get(key);
    const retry = () => loadSource(kind, e, key);
    const reread = () => { loadMemory(kind); };
    if (!s || s.state === "loading") { body.replaceChildren(waiting("正在读取来源…")); return; }
    if (s.state === "error") {
      const err = s.error;
      if (err.kind === "changed") body.replaceChildren(failure("这条已经更新，重新读取后再看来源。", reread, "重新读取"));
      else if (err.kind === "missing") body.replaceChildren(failure("没有找到这一版的来源：它可能已经变化。", reread, "重新读取"));
      else if (err.kind === "denied") body.replaceChildren(failure("没有权限查看来源：" + err.text + "。"));
      else body.replaceChildren(failure("没能读取来源：" + err.text + "。", retry));
      return;
    }
    const d = s.data;
    if (d.status === "not_recorded") { body.replaceChildren(note("没有记录这条的来源。")); return; }
    if (d.status === "unavailable") { body.replaceChildren(failure("来源暂时读不到。", retry)); return; }
    if (!d.sources.length) { body.replaceChildren(note("没有记录这条的来源。")); return; }
    const list = node("ul", "cx-src-list");
    for (const src of d.sources) {
      const li = node("li");
      li.append(node("span", "cx-src-label", src.label || "来源"));
      if (src.occurredAt) li.append(node("time", "cx-src-time", stamp(src.occurredAt)));
      // Only a message in the conversation open now can be shown in place.
      if (src.canOpen && src.messageId && src.threadId && src.threadId === S.threadId && mem && mem.key === S.key) {
        li.append(button("text-btn ws-link", "在对话里查看", () => locate({ kind: "source", messageId: src.messageId })));
      }
      list.append(li);
    }
    body.replaceChildren(list);
  }

  // ------------------------------------------------- 这个对话的便笺
  // Read only (GET /xbot-api/bots/:id/memory). A failed read says so and
  // offers 重试; it is never shown as "no notes".
  const notesPath = (page) => "/xbot-api/bots/" + enc(page.sel.id) + "/memory";
  async function loadNotes(page) {
    const n = page.notes, req = ++n.req;
    n.state = "loading";
    if (mem === page) paintNotes();
    try {
      const data = await H.api(notesPath(page));
      if (mem !== page || req !== n.req) return;
      if (!data || !Array.isArray(data.memory)) throw Object.assign(new Error("返回格式无法识别"), { status: 0 });
      Object.assign(n, { list: data.memory, state: "ready", error: "" });
    } catch (e) {
      if (mem !== page || req !== n.req) return;
      Object.assign(n, { state: "error", error: String(H.visibleError(e, "稍后再试")).replace(/[。.]+$/, "") });
    }
    paintNotes();
  }
  function paintNotes() {
    if (!mem) return;
    const n = mem.notes, list = Array.isArray(n.list) ? n.list.filter((x) => x && x.id != null) : null;
    n.count.textContent = list ? " · " + list.length : "";
    const sig = JSON.stringify([list, n.state, n.error]);
    if (n.sig === sig) return;
    n.sig = sig;
    const box = n.listEl;
    const parts = [];
    let retry = null;
    if (n.state === "error") {
      // 重试 pressed and failed again: it gets focus back.
      const p = failure("便笺没能读取：" + n.error + "。这不代表没有便笺。", () => { n.again = true; loadNotes(mem); });
      retry = p.lastChild;
      parts.push(p);
    }
    if (list && list.length) parts.push(...list.map(noteCard));
    else if (list) parts.push(node("p", "hint cx-note-empty", "这个对话还没有便笺。"));
    else if (n.state !== "error") parts.push(waiting("正在读取…"));
    box.replaceChildren(...parts);
    if (n.state === "loading") return;
    if (n.again && retry) retry.focus({ preventScroll: true });
    n.again = false;
  }
  function noteCard(item) {
    const card = node("div", "lib-card cx-note");
    card.append(node("div", "v", String(item.text || "")));
    return card;
  }

  // ------------------------------------------------------------------ public
  function init(hooks) {
    H = hooks;
    mountStrip();
    if (H.thread) H.thread.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") { clearTimeout(R.timer); R.pending = ""; return; }
      check();
    });
    window.addEventListener("focus", () => check());
  }

  window.ClowderExperience = Object.freeze({
    init, select, observe, touch, rendered, check, attend, locate, memoryView, paint,
    // Whether the status line is in charge for the open conversation (the
    // earlier execution and Task lines step aside).
    active: () => !!S.sel && S.state !== "unavailable" && S.state !== "idle",
    activity: () => S.act,
    load: () => loadActivity(),
  });
})();
