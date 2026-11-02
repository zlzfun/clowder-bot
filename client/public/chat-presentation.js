// How a native transcript row is shown. The server says what each row is
// (presentation_kind) and who wrote it (speaker, native_cat_id); nothing here
// reads message text to decide either. An "activity" row is one run's
// accumulating record, not a reply: it is a collapsed 执行过程 line in its
// writer's name that opens onto the full content, and it never becomes a chat
// bubble or a list preview. A null speaker is a system or unknown sender: it
// gets a neutral face, never the open chat's bot.
(() => {
  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ""; if (text != null) n.textContent = text; return n; };

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

  // opt.face(who) draws the writer's face; opt.render(parent, text) draws the
  // whole content, on the first open; opt.open holds the opened keys.
  function activityLine(m, opt) {
    const who = speaker(m), state = activityStatus(m.status), key = activityKey(m);
    const row = node("details", "routine-line activity-line " + state.tone);
    if (m.id) row.dataset.id = String(m.id);
    if (m.seq) row.dataset.seq = String(m.seq);
    if (m.time) row.dataset.time = String(m.time);
    const head = node("summary", "sysline");
    const label = node("span", "label", who.name + " · 执行过程 · ");
    label.append(node("span", "activity-state", state.text));
    head.dataset.tip = who.name + " · 执行过程 · " + state.text;
    head.append(opt.face(who), label);
    const drawer = node("div", "routine-drawer");
    let drawn = false;
    const draw = () => {
      if (drawn) return;
      drawn = true;
      opt.render(drawer, String((m.content != null ? m.content : m.text) || ""));
    };
    if (opt.open.has(key)) { row.open = true; draw(); }
    row.addEventListener("toggle", () => {
      if (row.open) { opt.open.add(key); draw(); }
      else opt.open.delete(key);
    });
    row.append(head, drawer);
    return row;
  }

  window.ClowderPresentation = Object.freeze({ isActivity, activityStatus, speaker, activityKey, activityLine });
})();
