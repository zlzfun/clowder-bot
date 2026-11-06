// How a native transcript row is shown. The server says what each row is
// (presentation_kind) and who wrote it (speaker, native_cat_id); nothing here
// reads message text to decide either. An "activity" row is one run's
// accumulating record, not a reply: it is a collapsed 执行过程 line in its
// writer's name that opens onto the full content and the run's native tool
// events, and it never becomes a chat bubble or a list preview. A record with
// neither is a plain status line with nothing to open. A null speaker is a
// system or unknown sender: it gets a neutral face, never the open chat's bot.
// An empty single chat asks its own cat to say hello (greetings): the cat
// writes the words; this page only keeps the request's bookkeeping and shows
// one status line about it (greetingLine), never a made-up message.
(() => {
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ""; if (text != null) n.textContent = text; return n; };
  const str = v => typeof v === "string" ? v : "";

  const isActivity = m => !!m && m.presentation_kind === "activity";

  // Native response lifecycle statuses. An unrecognised one claims nothing.
  const STATUS = {
    queued: { tone: "busy", text: "排队中" },
    processing: { tone: "busy", text: "进行中" },
    completed: { tone: "done", text: "已完成" },
    complete: { tone: "done", text: "已完成" },
    failed: { tone: "failed", text: "失败" },
    canceled: { tone: "stopped", text: "已停止" },
    cancelled: { tone: "stopped", text: "已停止" },
    interrupted: { tone: "stopped", text: "已中断" },
  };
  function activityStatus(status) {
    return Object.hasOwn(STATUS, status) ? { status, ...STATUS[status] } : { status: "unknown", tone: "unknown", text: "状态未知" };
  }

  // The cat that wrote a row. key groups consecutive rows: the native cat ID,
  // so two cats are never one sender, even under the same name. paint is the
  // speaker's own face, or null when no cat is known.
  function speaker(m) {
    const s = m && m.speaker && typeof m.speaker === "object" ? m.speaker : null;
    const id = String((m && m.native_cat_id) || (s && s.id) || "");
    const name = String((s && s.name) || (m && (m.name || m.sender)) || "").trim();
    return {
      key: id ? "bot:cat:" + id : "bot:name:" + name,
      id,
      name: name || "系统",
      paint: s ? { url: s.avatar_url || "", seed: s.avatar_seed || s.name || "", templateId: s.templateId, avatar: s.avatar, botName: s.name } : null,
    };
  }

  // Opened records stay open across redraws by their native message ID.
  const activityKey = m => "activity:" + String(m.id || m.native_message_id || m.seq || "");

  // The record's prose: content, or text in group chats.
  const activityProse = m => String((m.content != null ? m.content : m.text) || "");

  // The native tool events as recorded (native.toolEvents), in their order.
  // An event with no label, tool name or detail has nothing to show.
  function activityTools(m) {
    const events = m && m.native && Array.isArray(m.native.toolEvents) ? m.native.toolEvents : [];
    return events.filter(e => !!e && typeof e === "object" && [e.toolName, e.label, e.detail].some(v => str(v).trim()));
  }

  // A tool result's own native status: ok and error say so, a missing one says
  // nothing, anything else claims nothing. The run's lifecycle is not used.
  const TOOL_STATUS = { ok: { tone: "done", text: "成功" }, error: { tone: "failed", text: "失败" } };
  function toolStatus(status) {
    if (status == null || status === "") return null;
    return Object.hasOwn(TOOL_STATUS, status) ? TOOL_STATUS[status] : { tone: "unknown", text: "状态未知" };
  }

  // One event, one entry, on the 轨迹 tab's trace-call classes. Every field is
  // literal text (textContent in a pre), never Markdown or HTML.
  function toolEntry(e) {
    const result = e.type === "tool_result";
    const item = node("div", "trace-call");
    const name = node("div", "trace-call-name", [str(e.toolName).trim() || (result ? "" : str(e.label).trim()), result ? "结果" : ""].filter(Boolean).join(" · "));
    const state = toolStatus(e.status);
    if (state) {
      if (name.textContent) name.append(" · ");
      name.append(node("span", "tool-state " + state.tone, state.text));
    }
    if (name.textContent) item.append(name);
    if (str(e.detail).trim()) item.append(node("pre", result ? "trace-out" : "trace-args", str(e.detail)));
    return item;
  }

  // opt.face(who) draws the writer's face; opt.render(parent, text) draws the
  // prose, on the first open; opt.open holds the opened keys.
  function activityLine(m, opt) {
    const who = speaker(m), state = activityStatus(m.status), key = activityKey(m);
    const prose = activityProse(m), tools = activityTools(m);
    const details = !!prose.trim() || tools.length > 0;
    const row = node(details ? "details" : "div", "routine-line activity-line " + state.tone);
    if (m.id) row.dataset.id = String(m.id);
    if (m.seq) row.dataset.seq = String(m.seq);
    if (m.time) row.dataset.time = String(m.time);
    const head = node(details ? "summary" : "div", "sysline");
    const label = node("span", "label", who.name + " · 执行过程 · ");
    label.append(node("span", "activity-state", state.text));
    head.dataset.tip = who.name + " · 执行过程 · " + state.text;
    head.append(opt.face(who), label);
    // Nothing recorded yet: the status alone, with no empty drawer to open.
    if (!details) { row.append(head); return row; }
    const drawer = node("div", "routine-drawer");
    let drawn = false;
    const draw = () => {
      if (drawn) return;
      drawn = true;
      if (prose.trim()) opt.render(drawer, prose);
      if (tools.length) {
        const list = node("div", "activity-tools");
        list.append(...tools.map(toolEntry));
        drawer.append(list);
      }
    };
    if (opt.open.has(key)) { row.open = true; draw(); }
    row.addEventListener("toggle", () => {
      if (row.open) { opt.open.add(key); draw(); }
      else opt.open.delete(key);
    });
    row.append(head, drawer);
    return row;
  }

  // The empty single chat's greeting: POST /xbot-api/bots/:name/greeting
  // {expectedThreadId} asks the chat's cat to say hello in its own words, from
  // its own name and persona. This is request bookkeeping for one page, keyed
  // by cat and native thread, never a store of what the cat said:
  // - observe(name, read, page) runs on each successful transcript read of the
  //   open single chat. Only a truly empty chat (no rows, no cursor or further
  //   page, no greeting registered) read while the page is visible invites, and
  //   only once per thread for the page's life. A read with any record, a
  //   registration or the owner's own send on screen decides the thread for
  //   good; a hidden page decides nothing, so its first visible read does.
  // - A failure is never retried by itself: only retry(name, threadId), the
  //   owner's 重试 on that same thread, sends again.
  // - 200 accepted only means the invitation was taken; exists means the chat
  //   already has records, not that the cat said hello. A 200 with neither
  //   is unconfirmed. The transcript's own greeting field (accepted or
  //   unconfirmed; absent when nothing is registered) is the server's word
  //   and wins over this page's receipt.
  // post(name, threadId) sends the request; changed(name, threadId) hears
  // that its outcome arrived, whichever chat is open by then.
  function greetings(post, changed) {
    const chats = new Map();
    const keyOf = (name, threadId) => JSON.stringify([String(name), String(threadId)]);
    function invite(name, threadId) {
      const key = keyOf(name, threadId), rec = { phase: "sending", error: null };
      chats.set(key, rec);
      new Promise(resolve => resolve(post(name, threadId))).then(
        res => { rec.phase = res && (res.status === "accepted" || res.status === "exists") ? res.status : "unconfirmed"; },
        e => { rec.phase = "failed"; rec.error = e; },
      ).then(() => { if (chats.get(key) === rec) changed(name, threadId); });
    }
    // read: {threadId, messages, history, greeting}; page: {visible, begun}.
    function observe(name, read, page) {
      if (!read || !read.threadId) return false;
      const key = keyOf(name, read.threadId);
      if (chats.has(key)) return false;
      if (read.messages.length || read.history || read.greeting != null || page.begun) {
        chats.set(key, { phase: "settled", error: null });
        return false;
      }
      if (!page.visible) return false;
      invite(name, read.threadId);
      return true;
    }
    // What the chat's status line says now, or null for no line. A chat with
    // rows has none, its real messages and run feedback speak for it, except
    // while the server cannot confirm its invitation: only 重试 can recover
    // that receipt, so the line stays until this page's 重试 is accepted.
    // Which row is the invitation is never guessed from the rows.
    function view(name, read) {
      if (!read || !read.threadId) return null;
      const g = read.greeting;
      const rec = chats.get(keyOf(name, read.threadId));
      const phase = rec ? rec.phase : "";
      if (read.messages.length) {
        if (g == null || g.status !== "unconfirmed" || phase === "accepted") return null;
      } else if (g == null && read.history) return null;
      if (phase === "sending") return { state: "sending", error: null };
      if (g != null) {
        if (g.status === "accepted") return { state: "invited", error: null };
        if (g.status === "unconfirmed") return { state: "unconfirmed", error: null };
        return null; // an unrecognised registration claims nothing
      }
      if (phase === "failed") return { state: "failed", error: rec.error };
      if (phase === "accepted") return { state: "invited", error: null };
      if (phase === "unconfirmed") return { state: "unconfirmed", error: null };
      return null;
    }
    function retry(name, threadId) {
      if (!threadId) return false;
      const rec = chats.get(keyOf(name, threadId));
      if (rec && rec.phase === "sending") return false;
      invite(name, threadId);
      return true;
    }
    return Object.freeze({ observe, view, retry });
  }

  // The status line's words: this page's request, never the cat's reply or
  // work. Being sent, taken (邀请 only), failed, or not confirmed as arrived.
  const GREETING_TEXT = {
    sending: who => "正在邀请" + who + "打个招呼",
    invited: who => "已邀请" + who + "打个招呼",
    failed: who => "没能邀请" + who + "打个招呼",
    unconfirmed: who => "没能确认" + who + "收到了邀请",
  };
  // One light café line (the sysline of event rows) with the cat's xs face.
  // Not a message: no ID, time, sender or message actions, no spinner. A
  // failed or unconfirmed invitation offers 重试 (opt.retry), nothing else.
  function greetingLine(view, opt) {
    if (!view || !Object.hasOwn(GREETING_TEXT, view.state)) return null;
    const who = String(opt.name || "").trim() || "猫猫";
    const text = GREETING_TEXT[view.state](who) + (view.state === "failed" && opt.reason ? "：" + opt.reason : "");
    const row = node("div", "sysline chat-greeting " + view.state);
    row.setAttribute("role", "status");
    row.dataset.tip = text;
    if (opt.face) row.append(opt.face);
    row.append(node("span", "label", text));
    if ((view.state === "failed" || view.state === "unconfirmed") && opt.retry) {
      const again = node("button", "text-btn", "重试");
      again.type = "button";
      again.addEventListener("click", () => { again.disabled = true; opt.retry(); });
      row.append(again);
    }
    return row;
  }

  window.ClowderPresentation = Object.freeze({ isActivity, activityStatus, speaker, activityKey, activityTools, activityLine, greetings, greetingLine });
})();
