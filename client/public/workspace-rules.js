// File, saved-conversation and chat-task rules without DOM or network (classic
// script, window.ClowderWorkspaceRules). workspace.js draws from these; tests
// load the same file. Files, conversations and Tasks are server and Clowder AI
// facts: these helpers only name, size, sort and gate them, and never invent
// state. Task execution semantics (background run, stop/cancel/resume) come
// from runtime-tasks.js (window.ClowderTasks), shared with the runtime panel.
(() => {
  const MiB = 1024 * 1024;
  const LIMITS = Object.freeze({ files: 8, bytes: 20 * MiB });
  const enc = encodeURIComponent;
  const own = (map, key) => typeof key === "string" && Object.hasOwn(map, key);
  const oneLine = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const chinese = (text) => /\p{Script=Han}/u.test(String(text || ""));

  // ---- Conversations ----
  const key = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const scope = (sel) => (sel.type === "group" ? "/xbot-api/groups/" : "/xbot-api/bots/") + enc(sel.id);

  // ---- Sizes and names ----
  function size(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return Math.round(n) + " B";
    const [v, unit] = n < MiB ? [n / 1024, "KB"] : [n / MiB, "MB"];
    return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + " " + unit;
  }
  // The extension in capitals (at most four letters), for the file tile.
  function badge(name) {
    const m = /\.([A-Za-z0-9]{1,4})$/.exec(String(name || ""));
    return m ? m[1].toUpperCase() : "";
  }
  const IMAGE = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  // What a card may show inline. The server serves an image preview only for
  // checked PNG/JPEG/GIF/WebP and a text preview only for text/plain; every
  // other file is download only.
  function preview(file) {
    if (!file) return "none";
    if (file.previewUrl && IMAGE.includes(file.mime)) return "image";
    if (file.mime === "text/plain") return "text";
    return "none";
  }
  // The last few segments of a server path, for a one-line label; the full
  // path stays available to copy.
  function tail(path, keep = 3) {
    const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return String(path || "");
    return (parts.length > keep ? "…/" : (String(path).startsWith("/") ? "/" : "")) + parts.slice(-keep).join("/");
  }
  // Breadcrumbs of a relative directory: [{name, path}], the root first.
  function crumbs(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    return [{ name: "", path: "" }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }))];
  }

  // ---- Pending attachments ----
  // Which of the picked files can join a message that already has `count`
  // attachments: at most eight per message and 20 MB each. Empty files are
  // refused too: they carry nothing for the Agent to read.
  function admit(count, files) {
    const accepted = [], refused = [];
    let room = Math.max(0, LIMITS.files - count);
    for (const file of files || []) {
      const name = String((file && file.name) || "未命名文件");
      if (!room) { refused.push({ name, reason: "full" }); continue; }
      if (!file || !(file.size > 0)) { refused.push({ name, reason: "empty" }); continue; }
      if (file.size > LIMITS.bytes) { refused.push({ name, reason: "large" }); continue; }
      accepted.push(file); room--;
    }
    return { accepted, refused };
  }
  function refusal(refused) {
    if (!refused.length) return "";
    const full = refused.filter((r) => r.reason === "full").length;
    const large = refused.filter((r) => r.reason === "large").map((r) => r.name);
    const empty = refused.filter((r) => r.reason === "empty").map((r) => r.name);
    const out = [];
    if (large.length) out.push(quote(large) + "超过 20 MB，没有添加");
    if (empty.length) out.push(quote(empty) + "是空文件或文件夹，没有添加");
    if (full) out.push("一条消息最多 " + LIMITS.files + " 个附件，另有 " + full + " 个没有添加");
    return out.join("；") + "。";
  }
  const quote = (names) => names.slice(0, 2).map((n) => "「" + clip(n, 24) + "」").join("、") + (names.length > 2 ? "等 " + names.length + " 个文件" : "");
  function clip(text, n) {
    const chars = Array.from(oneLine(text));
    return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : chars.join("");
  }
  // Attachments handed back after a send that did not go out rejoin the list
  // in their old order, ahead of anything added since, without duplicates and
  // within the per-message limit. `dropped` is what no longer fits.
  function restore(current, returned) {
    const ids = new Set(current.filter((r) => r.id).map((r) => r.id));
    const back = returned.filter((r) => r && r.id && !ids.has(r.id));
    const merged = [...back, ...current];
    return { rows: merged.slice(0, LIMITS.files), dropped: merged.slice(LIMITS.files) };
  }

  // ---- Upload and file errors ----
  function fileError(error, fallback) {
    const said = oneLine(error && error.message);
    const status = error && error.status;
    if (status === 413) return "文件超过 20 MB";
    if (status === 404) return chinese(said) ? said : "文件已不存在";
    if (status === 409) return chinese(said) ? said : "会话或文件已经变化";
    if (status === 415) return chinese(said) ? said : "这个文件只能下载";
    if (chinese(said)) return said.replace(/[。.]+$/, "");
    return fallback || "没能完成";
  }

  // ---- Tasks ----
  const ordinary = (task) => !!task && task.kind === "work" && task.subjectKey === null && task.entrustedWork == null;
  const revision = (task) => (Number.isSafeInteger(task && task.ownerRevision) ? task.ownerRevision : 0);
  const STATUS_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 };
  const at = (value) => {
    if (value == null || value === "") return 0;
    const t = typeof value === "number" ? value : Date.parse(String(value));
    return Number.isFinite(t) ? t : 0;
  };
  // Open work first (in progress, blocked, to do), each newest first; done last.
  function order(tasks) {
    return [...(tasks || [])].filter((t) => t && typeof t === "object" && t.id != null)
      .sort((a, b) => (own(STATUS_ORDER, a.status) ? STATUS_ORDER[a.status] : 2.5) - (own(STATUS_ORDER, b.status) ? STATUS_ORDER[b.status] : 2.5)
        || at(b.updatedAt || b.createdAt) - at(a.updatedAt || a.createdAt));
  }
  // The dock line: counts of open Tasks and whose they are, from the read only.
  function summary(tasks) {
    const open = (tasks || []).filter((t) => t && t.status !== "done");
    const count = (s) => open.filter((t) => t.status === s).length;
    const owners = [...new Set(open.map((t) => t.ownerCatId).filter((id) => typeof id === "string" && id))];
    return { open: open.length, doing: count("doing"), blocked: count("blocked"), todo: count("todo"), owners };
  }
  function catName(id, cats, names) {
    if (!id) return "";
    const cat = Array.isArray(cats) ? cats.find((c) => c && c.id === id) : null;
    const name = oneLine(cat && cat.name) || oneLine(names && names(id));
    return name || String(id);
  }
  const member = (id, cats) => Array.isArray(cats) && cats.some((c) => c && c.id === id);
  // Members of this conversation who could take the Task; never its owner.
  function targets(task, cats) {
    return (Array.isArray(cats) ? cats : []).filter((c) => c && typeof c.id === "string" && c.id && c.id !== task.ownerCatId);
  }
  // A pass (请求传球) asks the owner to hand the Task on through the native
  // Task-backed handoff, so it needs an owner and an ordinary open Task.
  // Owners are never set from here: a Task gets its first one natively.
  function handoffBlocked(task) {
    if (!ordinary(task)) return "这类任务在运行面板处理。";
    if (!task.ownerCatId) return "还没有负责人。";
    if (task.status === "done") return "任务已完成。";
    return "";
  }
  // How each recorded change came about, in words that keep them apart: a
  // pass between cats, a person setting the owner, a cat taking it up.
  const KINDS = { handoff: "传球", human_update: "手动指派", claim: "认领" };
  // Recorded ownership changes (流转记录), newest first. Only native rows: a
  // Task older than the history marker simply has none, and none are made up.
  function history(task) {
    const rows = Array.isArray(task && task.assignmentHistory) ? task.assignmentHistory : [];
    return rows.filter((r) => r && typeof r === "object")
      .map((r) => ({ revision: Number.isSafeInteger(r.revision) ? r.revision : null, from: r.fromCatId || null, to: r.toCatId || null,
        at: at(r.at), kind: own(KINDS, r.kind) ? KINDS[r.kind] : "负责人变更", source: typeof r.sourceMessageRef === "string" && r.sourceMessageRef ? r.sourceMessageRef : null }))
      .sort((a, b) => (b.revision ?? -1) - (a.revision ?? -1) || b.at - a.at);
  }
  // Native refusals in words. A Chinese reason from the server is shown as it is.
  const CODES = {
    task_assignment_changed: "任务的负责人或执行已经变化",
    "task assignment changed": "任务的负责人或执行已经变化",
    task_execution_must_stop: "这项任务还绑定着执行，先停止执行，或请负责人传球",
    task_execution_stop_unproven: "原生还没有确认执行已经停止，暂时不能恢复",
    background_control_unavailable: "当前状态不支持这个操作",
  };
  function taskError(error) {
    const text = oneLine(error && error.message).replace(/[。.]+$/, "");
    const status = error && error.status;
    const code = text.toLowerCase();
    if (chinese(text)) return text;
    if (own(CODES, code)) return CODES[code];
    if (status === 404) return "任务不存在，或当前后端没有开放这个操作";
    if (status === 409) return "任务已有变化，或当前状态不支持这个操作";
    if (status === 400) return "请求没有通过检查";
    return "没能确认结果";
  }
  // The server's own Chinese reason, else the caller's words.
  function said(error, fallback) {
    const text = oneLine(error && error.message).replace(/[。.]+$/, "");
    return chinese(text) ? text : fallback;
  }

  // ---- A cat's saved conversations ----
  // The native threads the server knows for one cat, newest first, so the
  // list does not reorder when another one becomes current. Titles are the
  // server's (an older one may carry the name of the project it began in).
  function conversations(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .filter((c) => c && typeof c === "object" && typeof c.id === "string" && c.id && !seen.has(c.id) && seen.add(c.id))
      .map((c) => ({ id: c.id, title: oneLine(c.title), current: c.current === true, createdAt: at(c.createdAt) }))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  window.ClowderWorkspaceRules = Object.freeze({
    LIMITS, key, scope, size, badge, preview, tail, crumbs, admit, refusal, restore, fileError, clip, oneLine,
    ordinary, revision, order, summary, catName, member, targets, handoffBlocked, history, taskError, said, KINDS, conversations,
  });
})();
