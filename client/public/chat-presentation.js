// How a native transcript row is shown. The server says what each row is
// (presentation_kind) and who wrote it (speaker, native_cat_id); nothing here
// reads message text to decide either. An "activity" row is one run's
// accumulating record, not a reply: it is a collapsed 执行过程 line in its
// writer's name that opens onto the full content and the run's native tool
// events, and it never becomes a chat bubble or a list preview. A record with
// neither is a plain status line with nothing to open. A null speaker is a
// system or unknown sender: it gets a neutral face, never the open chat's bot.
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

  window.ClowderPresentation = Object.freeze({ isActivity, activityStatus, speaker, activityKey, activityTools, activityLine });
})();
