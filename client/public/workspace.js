// Files, saved conversations and chat Tasks for the chat shell (classic
// script, window.ClowderWorkspace). Loads after runtime-tasks.js and
// workspace-rules.js and before app.js, which calls init() once and a few
// hooks: select() when the conversation changes, observe() after each
// transcript read, cards() for message files, filesView()/tasksView() for the
// drawer, conversationsView() for a cat's 详情 page and the composer's
// attachment calls.
//
// - Composer: any file from the picker, a paste or a drop is uploaded at once
//   to the open conversation's exact native thread (expectedThreadId). A send
//   that does not go out hands its files back; a conversation or thread change
//   aborts uploads and empties the list, because file ids belong to one thread.
// - File cards (history and drawer): name, size, download, a text or image
//   preview only where the server offers one, and an honest missing state.
// - Drawer 文件: deliverables (snapshots) and attachments. The working
//   directory — its path, read-only browsing and saving one of its files as a
//   deliverable — stays folded away under 更多文件.
// - Drawer 详情 (a cat): when the cat has more than one saved conversation, a
//   folded 历史对话 opens one of them again. It moves between threads the
//   server already knows for the cat; nothing here creates a thread or project.
// - 任务 at the top of the drawer's 任务 page and one summary line above the
//   composer: per-Task 负责人, progress and background run, 请求传球 (asking
//   the owner to pass the Task on), stop/cancel/resume and the recorded
//   流转记录. Work starts from ordinary chat: nothing here creates a Task or
//   sets its owner.
//
// Facts come from the server and Clowder AI. A pass is a request: the owner
// shown is always the read Task's. Nothing here schedules or dispatches work;
// reads follow the chat's own poll and native events. Every async answer is
// checked against the conversation, native thread and request it was asked for.
(() => {
  "use strict";
  const R = window.ClowderWorkspaceRules;
  const T = window.ClowderTasks || null;
  const enc = encodeURIComponent;
  const $ = (id) => document.getElementById(id);
  let H = null;

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
  // Glyphs app.js does not have; the rest come from its icon set.
  const GLYPHS = {
    paperclip: '<path d="M15.5 7.5 8.7 14.3a1.7 1.7 0 0 0 2.4 2.4l7.1-7.1a3.6 3.6 0 0 0-5.1-5.1L5.9 11.7a5.4 5.4 0 0 0 7.6 7.6l6-6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
    tray: '<path d="M12 3v9"/><path d="m8.5 8.5 3.5 3.5 3.5-3.5"/><path d="M4 14h4.5l1 2h5l1-2H20v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  };
  function icon(name, extra) {
    if (!Object.hasOwn(GLYPHS, name)) return H.icon(name, extra);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("icon");
    if (extra) svg.classList.add(extra);
    svg.innerHTML = GLYPHS[name];
    return svg;
  }
  function iconButton(name, label, onClick, focusKey) {
    const b = button("ghost ws-ib", null, onClick, label);
    b.dataset.tip = label;
    if (focusKey) b.dataset.wsFocus = focusKey;
    b.append(icon(name));
    return b;
  }
  // One key per request body; a retry of the same body reuses it.
  function uuid() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === "function") { try { return c.randomUUID(); } catch { /* insecure context */ } }
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  function stamp(value) {
    const t = typeof value === "number" ? value : Date.parse(String(value || ""));
    if (!Number.isFinite(t) || t <= 0) return "";
    const d = new Date(t), now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return "今天 " + hm;
    if (diff === 1) return "昨天 " + hm;
    return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "年" : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
  }
  const fullTime = (value) => {
    const t = typeof value === "number" ? value : Date.parse(String(value || ""));
    return Number.isFinite(t) && t > 0 ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "";
  };
  function note(text, cls) { return node("p", "ws-note" + (cls ? " " + cls : ""), text); }
  function waiting(text) { const p = note(text, "ws-wait"); p.setAttribute("role", "status"); return p; }
  function failure(text, retry) {
    const p = node("p", "ws-note ws-bad");
    p.setAttribute("role", "alert");
    p.append(document.createTextNode(text + " "));
    if (retry) p.append(button("text-btn ws-link", "重试", retry));
    return p;
  }
  function apiError(res, data) {
    const err = new Error((data && data.error) || "request failed");
    err.status = res.status;
    return err;
  }
  // Keep a control focused across a repaint that rebuilt it.
  function refocus(scope, key) {
    if (!key || !scope) return;
    const next = [...scope.querySelectorAll("[data-ws-focus]")].find((n) => n.dataset.wsFocus === key);
    if (next && !next.disabled) next.focus({ preventScroll: true });
  }
  const focusKeyIn = (scope) => {
    const active = document.activeElement;
    return active && scope && scope.contains(active) && active.dataset ? active.dataset.wsFocus || "" : "";
  };
  // A fold (the original task-details) whose summary is a section label.
  function fold(cls, label, focusKey) {
    const box = node("details", "task-details " + cls);
    const sum = node("summary");
    sum.dataset.wsFocus = focusKey;
    sum.append(node("span", "", label), icon("chevron"));
    return { box, sum, label: sum.firstChild };
  }

  // -------------------------------------------------------------------- state
  const freshTree = () => ({ area: "workspace", path: "", data: null, state: "idle", error: "", req: 0, focus: false });
  const S = {
    sel: null, key: "", gen: 0, epoch: 0, threadId: "", waiters: [],
    view: null, viewState: "idle", viewError: "", viewReq: 0,
    files: null, filesFor: "", filesState: "idle", filesError: "", filesReq: 0, filesStale: false,
    tree: freshTree(),
    convs: null, convState: "idle", convReq: 0, convBusy: false, convLine: null, switching: null,
    tasks: null, tasksFor: "", cats: [], historyAvailable: false, tasksState: "idle", tasksError: "", tasksReq: 0, tasksAt: 0,
    pending: [], note: "", parked: new Map(),
    marks: {}, marking: {}, markErrors: {}, handoffs: {}, lines: {}, roots: {},
    strip: null, pick: null,
  };
  // The conversation whose 更多文件 / 历史对话 fold was left open: redraws, a
  // thread move and reopening the same conversation keep it open.
  const folds = { more: "", convs: "" };
  const scopePath = () => R.scope(S.sel);
  const isGroup = () => !!S.sel && S.sel.type === "group";
  const panelOpen = () => !!$("panel") && $("panel").classList.contains("open");
  const visible = (kind) => !!S.roots[kind] && S.roots[kind].isConnected && panelOpen();

  // A new conversation: everything that belonged to the old one is dropped.
  function select(sel) {
    S.gen++;
    S.epoch++;
    for (const w of S.waiters) w.reject(new Error("stale"));
    S.waiters = [];
    clearPending();
    if (layer) layer.close(true);
    Object.assign(S, {
      sel: sel && sel.id ? { type: sel.type === "group" ? "group" : "bot", id: sel.id } : null,
      threadId: "", view: null, viewState: "idle", viewError: "",
      files: null, filesFor: "", filesState: "idle", filesError: "", filesStale: false, tree: freshTree(),
      convs: null, convState: "idle", convBusy: false, convLine: null, switching: null,
      tasks: null, tasksFor: "", cats: [], historyAvailable: false, tasksState: "idle", tasksError: "", tasksAt: 0,
      note: "", marks: {}, marking: {}, markErrors: {}, handoffs: {}, lines: {}, roots: {},
    });
    S.key = R.key(S.sel);
    paintComposer();
    paintStrip();
    if (S.sel) { loadView(); loadTasks(true); }
  }

  // After each transcript or group read: the thread it came from and whether
  // the history changed. Tasks follow the same poll, slower while unseen.
  function observe(sel, threadId, changed) {
    if (!S.sel || R.key(sel) !== S.key) return;
    // A move reads the new thread's view, files and Tasks by itself.
    if (threadId && confirmThread(String(threadId), false)) return;
    const age = Date.now() - S.tasksAt;
    if (S.tasksState !== "unavailable" && (changed || age > (visible("tasks") ? 4000 : 15000))) loadTasks(true);
    if ((changed || S.filesStale) && visible("files")) { S.filesStale = false; loadFiles(); }
  }
  // A native event arrived for this conversation (a Task update need not
  // change the transcript): the read it triggers refreshes Tasks and files too.
  function touch() {
    S.tasksAt = 0;
    S.filesStale = true;
  }

  // ------------------------------------------------------------ native thread
  // Only the canonical reads name the thread the conversation runs in: the
  // transcript or group read (observe) and the workspace view. A file or Task
  // list says which thread it was read from; that is checked against the
  // thread it was asked for and never moves the conversation, so a late answer
  // from before a change cannot take the conversation back.
  //
  // S.epoch numbers the threads confirmed for the open conversation (select()
  // starts a new one too). Every per-thread read and change keeps the epoch it
  // was asked in and lands only while that epoch is still current.
  const ticket = () => ({ gen: S.gen, epoch: S.epoch, threadId: S.threadId, viewReq: S.viewReq });
  const live = (t) => t.epoch === S.epoch;

  // A canonical read named this thread. True when the conversation moved and
  // everything per-thread was dropped and asked again, so the caller reads nothing.
  function confirmThread(id, fromView) {
    if (!id || id === S.threadId) return false;
    const first = !S.threadId;
    // Lists answered before any thread was known stay when they are this one's.
    const moved = !first || (!!S.tasksFor && S.tasksFor !== id) || (!!S.filesFor && S.filesFor !== id);
    if (moved) S.epoch++;
    if (!first) {
      // A new conversation, or a switch made elsewhere: the pending files
      // were uploaded to (or were on their way to) the old thread.
      const had = S.pending.length > 0;
      clearPending();
      if (had) S.note = "会话已更换，待发送的附件需要重新添加。";
    }
    S.threadId = id;
    if (first) { flushWaiters(); unpark(); } else paintComposer();
    // 历史对话 marks the thread now confirmed; a move may also have started one it has not listed.
    if (!first && S.convState !== "idle") loadConversations();
    paintConvs();
    if (!moved) return false;
    // Its files, tree and Tasks are another thread's: read them again, once.
    Object.assign(S, {
      files: null, filesFor: "", filesState: "idle", filesStale: false, tree: freshTree(),
      tasks: null, tasksFor: "", tasksState: "idle", marks: {}, marking: {}, markErrors: {}, handoffs: {}, lines: {},
    });
    for (const kind of ["files", "tasks"]) if (S.roots[kind]) S.roots[kind] = null;
    if (!fromView) loadView();
    loadTasks(true);
    paintStrip();
    H.repaintPanel?.();
    return true;
  }
  // The thread a list answer is for, or null when it is another thread's than
  // the one it was asked for (asked before any was known: the one confirmed
  // since). Such an answer is dropped; the workspace view, unless one was asked
  // after the list, is read once to learn whether the conversation moved.
  function listThread(t, data) {
    const said = data && data.threadId ? String(data.threadId) : "";
    const want = t.threadId || S.threadId;
    if (!said || !want || said === want) return said || want;
    if (S.viewReq === t.viewReq) loadView();
    return null;
  }
  function flushWaiters() {
    const ready = S.waiters.filter((w) => w.gen === S.gen);
    S.waiters = S.waiters.filter((w) => w.gen !== S.gen);
    for (const w of ready) w.resolve(S.threadId);
  }
  // The thread this conversation runs in, once a read has told us.
  function whenThread(gen, ms = 10000) {
    if (gen !== S.gen) return Promise.reject(new Error("stale"));
    if (S.threadId) return Promise.resolve(S.threadId);
    return new Promise((resolve, reject) => {
      const w = { gen, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => { S.waiters = S.waiters.filter((x) => x !== w); reject(Object.assign(new Error("还没读到当前会话"), { late: true })); }, ms);
      S.waiters.push(w);
    });
  }

  // ----------------------------------------------------------------- composer
  let rowSeq = 0;
  const LOCAL_IMAGE = /^image\/(png|jpeg|gif|webp)$/i;

  function mountComposer() {
    const composer = $("composer");
    if (!composer || composer.querySelector(".ws-plus")) return;
    const wrap = node("div", "plus-wrap ws-plus");
    const picker = node("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    picker.tabIndex = -1;
    picker.setAttribute("aria-hidden", "true");
    const pick = button("ghost ws-attach", null, () => {
      if (!S.sel || H.peer()) return;
      picker.value = "";
      picker.click();
    }, "添加附件");
    pick.dataset.tip = "添加附件";
    pick.append(icon("paperclip"));
    picker.addEventListener("change", () => {
      const files = [...(picker.files || [])];
      picker.value = "";
      addFiles(files);
      pick.focus({ preventScroll: true });
    });
    wrap.append(pick, picker);
    composer.prepend(wrap);
    S.pick = pick;
  }

  function setNote(text) {
    S.note = text || "";
    paintComposer();
  }

  function chipStatus(row) {
    if (row.status === "waiting") return "等待上传";
    if (row.status === "uploading") return "上传中…";
    if (row.status === "failed") return "没传上去：" + row.error;
    return R.size(row.size);
  }

  function tile(name, url) {
    const t = node("span", "wsf-tile");
    t.setAttribute("aria-hidden", "true");
    const mark = () => { const b = R.badge(name); return b ? node("span", "wsf-ext", b) : icon("file"); };
    if (url) {
      const img = node("img");
      img.alt = "";
      img.decoding = "async";
      img.src = url;
      img.addEventListener("error", () => { img.remove(); t.classList.remove("image"); t.append(mark()); }, { once: true });
      t.classList.add("image");
      t.append(img);
    } else t.append(mark());
    return t;
  }

  function chip(row) {
    const box = node("div", "wsf-chip");
    box.dataset.status = row.status;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", row.name + "，" + chipStatus(row));
    const server = row.meta && R.preview(row.meta) === "image" ? fileUrl(row.meta, "image") : "";
    box.append(tile(row.name, server || row.url));
    const copy = node("span", "wsf-copy");
    const name = node("span", "wsf-name", row.name);
    name.title = row.name;
    const meta = node("span", "wsf-meta", chipStatus(row));
    meta.title = meta.textContent;
    if (row.status === "failed") meta.classList.add("bad");
    copy.append(name, meta);
    box.append(copy);
    if (row.status === "failed") box.append(iconButton("refresh-cw", "重新上传 " + row.name, () => retry(row), row.key + ":retry"));
    box.append(iconButton("x", "移除附件 " + row.name, () => removeRow(row), row.key + ":remove"));
    return box;
  }

  function paintComposer() {
    const list = $("attach-list"), bar = $("attach-bar"), line = $("attach-note"), composer = $("composer");
    if (!list || !bar || !line || !composer) return;
    const keep = focusKeyIn(list);
    list.setAttribute("aria-label", "待发送的附件");
    list.replaceChildren(...S.pending.map(chip));
    line.textContent = S.note;
    line.hidden = !S.note;
    const has = S.pending.length > 0 || !!S.note;
    bar.hidden = !has;
    composer.classList.toggle("has-attach", has);
    if (keep) {
      refocus(list, keep);
      // A retried row lost its retry button: stay on the same row.
      if (!list.contains(document.activeElement)) refocus(list, keep.replace(/:retry$/, ":remove"));
    }
    if (S.pick) S.pick.disabled = !S.sel || !!S.switching;
    H.syncComposer();
  }

  async function addFiles(files) {
    files = [...(files || [])].filter(Boolean);
    if (!files.length || !S.sel || H.peer()) return;
    // A switch to another saved conversation is out: these would go to the thread being left.
    if (S.switching) { setNote("正在切换对话，切换好后再添加附件。"); return; }
    const gen = S.gen;
    const { accepted, refused } = R.admit(S.pending.length, files);
    S.note = R.refusal(refused);
    const rows = accepted.map((file) => ({
      key: "a" + ++rowSeq, file, name: file.name || "未命名文件", size: file.size, mime: file.type || "",
      status: "waiting", id: "", error: "", url: LOCAL_IMAGE.test(file.type || "") ? URL.createObjectURL(file) : "",
      meta: null, threadId: "", ctrl: null,
    }));
    S.pending.push(...rows);
    paintComposer();
    if (!rows.length) return;
    let threadId;
    try { threadId = await whenThread(gen); }
    catch (e) {
      if (gen !== S.gen || !e.late) return;
      for (const row of rows) if (S.pending.includes(row) && row.status === "waiting") Object.assign(row, { status: "failed", error: "还没读到当前会话" });
      paintComposer();
      return;
    }
    // One at a time: twenty-megabyte bodies do not race each other.
    for (const row of rows) {
      if (gen !== S.gen) return;
      await upload(row, threadId, gen);
    }
  }

  async function upload(row, threadId, gen) {
    if (gen !== S.gen || threadId !== S.threadId || !S.pending.includes(row)) return;
    // The thread it goes to: a move empties the list and ends this epoch.
    const t = ticket();
    const ctrl = new AbortController();
    Object.assign(row, { status: "uploading", error: "", ctrl });
    paintComposer();
    try {
      const res = await H.apiFetch(scopePath() + "/files?" + new URLSearchParams({ name: row.name, expectedThreadId: threadId }), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: row.file, signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, data);
      if (!data.file || !data.file.id) throw new Error("服务端没有返回文件记录");
      if (!live(t) || !S.pending.includes(row)) return;
      if (row.url) { URL.revokeObjectURL(row.url); row.url = ""; }
      Object.assign(row, { status: "ready", id: String(data.file.id), meta: data.file, threadId, ctrl: null, file: null });
    } catch (e) {
      if (ctrl.signal.aborted || !live(t) || !S.pending.includes(row)) return;
      Object.assign(row, { status: "failed", error: R.fileError(e, "稍后再试"), ctrl: null });
      // The thread moved under the upload: the next read will say where to.
      if (e.status === 409) H.reload?.();
    }
    paintComposer();
  }

  function retry(row) {
    if (!S.pending.includes(row) || row.status !== "failed" || !row.file) {
      if (row.status === "failed" && !row.file) removeRow(row);
      return;
    }
    const gen = S.gen;
    row.status = "waiting";
    paintComposer();
    whenThread(gen).then((id) => upload(row, id, gen), (e) => {
      if (gen !== S.gen || !S.pending.includes(row)) return;
      Object.assign(row, { status: "failed", error: e.late ? "还没读到当前会话" : "稍后再试" });
      paintComposer();
    });
  }

  function removeRow(row) {
    const at = S.pending.indexOf(row);
    if (at < 0) return;
    S.pending.splice(at, 1);
    if (row.ctrl) row.ctrl.abort();
    if (row.url) URL.revokeObjectURL(row.url);
    if (!S.pending.length) S.note = "";
    paintComposer();
    const list = $("attach-list"), next = list && (list.children[at] || list.children[at - 1]);
    const target = next ? next.querySelector("button:last-of-type") : $("input");
    if (target) target.focus({ preventScroll: true });
  }

  function clearPending() {
    for (const row of S.pending) {
      if (row.ctrl) row.ctrl.abort();
      if (row.url) URL.revokeObjectURL(row.url);
    }
    S.pending = [];
  }

  const attachReady = () => S.pending.filter((r) => r.status === "ready").length;
  const attachBusy = () => S.pending.some((r) => r.status === "waiting" || r.status === "uploading");

  // The ready files leave the composer with a send. Failed rows stay for a retry.
  function take() {
    const rows = S.pending.filter((r) => r.status === "ready");
    if (!rows.length) return null;
    S.pending = S.pending.filter((r) => r.status !== "ready");
    if (!S.pending.length) S.note = "";
    paintComposer();
    return { key: S.key, threadId: rows[0].threadId, ids: rows.map((r) => r.id), rows, files: rows.map((r) => r.meta) };
  }

  // A send that did not go out hands its files back: into the composer when
  // the same conversation is still open, else kept until it opens again.
  function giveBack(batch) {
    if (!batch || !batch.rows || !batch.rows.length) return false;
    // Another conversation is open, or this one has not said its thread yet:
    // keep them until a read confirms the thread they were uploaded to.
    if (batch.key !== S.key || !S.threadId) {
      S.parked.set(batch.key, { threadId: batch.threadId, rows: batch.rows, at: Date.now() });
      if (batch.key === S.key) S.note = "";
      return false;
    }
    if (S.threadId && batch.threadId !== S.threadId) {
      setNote("会话已更换，没发出去的附件属于原来的会话，需要重新添加。");
      return false;
    }
    const { rows, dropped } = R.restore(S.pending, batch.rows);
    S.pending = rows;
    S.note = dropped.length ? "一条消息最多 " + R.LIMITS.files + " 个附件，有 " + dropped.length + " 个没有放回。" : "";
    paintComposer();
    return true;
  }
  function unpark() {
    const parked = S.parked.get(S.key);
    if (!parked) return;
    S.parked.delete(S.key);
    if (parked.threadId !== S.threadId || Date.now() - parked.at > 30 * 60 * 1000) return;
    const { rows, dropped } = R.restore(S.pending, parked.rows);
    S.pending = rows;
    S.note = "上次没发出去的附件已放回。" + (dropped.length ? "有 " + dropped.length + " 个超出上限，没有放回。" : "");
    paintComposer();
  }

  // Any file in a paste or a drop, not only pictures.
  function filesFrom(data) {
    if (!data) return [];
    const out = [];
    for (const item of data.items || []) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
    if (!out.length) for (const file of data.files || []) out.push(file);
    return out;
  }
  function carriesFiles(data) {
    if (!data) return false;
    if ([...(data.types || [])].includes("Files")) return true;
    return [...(data.items || [])].some((it) => it.kind === "file");
  }

  // --------------------------------------------------------------- file cards
  const fileUrl = (file, mode) => "/xbot-api/files/" + enc(file.id) + "/" + mode;

  async function fetchFile(file) {
    const res = await H.apiFetch(fileUrl(file, "download"), { credentials: "same-origin" });
    if (!res.ok) throw apiError(res, await res.json().catch(() => ({})));
    return res.blob();
  }
  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = node("a");
    a.href = url;
    a.download = name || "download";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  // Why a stored picture does not show: the server says whether the file is
  // gone or changed. An empty answer means the file is there.
  async function probe(file) {
    try {
      const res = await H.apiFetch(fileUrl(file, "download"), { method: "HEAD", credentials: "same-origin" });
      if (res.status === 404) return "文件已不存在";
      if (res.status === 409) return "文件内容已变化";
      return res.ok ? "" : "暂时读不到这个文件";
    } catch (e) { return "暂时读不到这个文件"; }
  }

  function cards(files, opts = {}) {
    const list = node("div", "wsf-cards" + (opts.cls ? " " + opts.cls : ""));
    for (const file of files || []) if (file && file.id) list.append(card(file, opts));
    return list;
  }

  // Files the server said are gone or changed (404/409), by id, so a redrawn
  // history shows the same honest state without asking again.
  const gone = new Map();

  function card(file, opts = {}) {
    const box = node("div", "wsf-card");
    box.dataset.fileId = String(file.id);
    if (file.kind === "deliverable") box.classList.add("deliverable");
    const label = file.name || "未命名文件";
    const known = gone.get(String(file.id)) || "";
    const kind = known ? "none" : R.preview(file);
    const base = () => [R.size(file.size), file.kind === "deliverable" ? "交付物" : "", opts.time ? stamp(file.createdAt) : ""].filter(Boolean).join(" · ");
    const name = node("span", "wsf-name", label);
    name.title = label;
    const meta = node("span", "wsf-meta");
    const say = (text, bad) => { meta.textContent = text; meta.title = text; meta.classList.toggle("bad", !!bad); };
    const copy = node("span", "wsf-copy");
    copy.append(name, meta);
    const acts = node("span", "wsf-acts");
    const missing = (reason, lasting) => {
      if (lasting) gone.set(String(file.id), reason);
      box.dataset.state = "missing";
      say(reason, true);
      for (const b of acts.querySelectorAll("button")) b.disabled = true;
      if (face.tagName === "BUTTON") face.disabled = true;
    };
    let face;
    if (kind === "image" && !opts.sending) {
      face = button("wsf-tile image", null, () => H.openImage(fileUrl(file, "image"), face), "查看图片 " + label);
      const img = node("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = fileUrl(file, "image");
      img.addEventListener("error", () => {
        img.remove();
        face.classList.remove("image");
        face.append(R.badge(label) ? node("span", "wsf-ext", R.badge(label)) : icon("file"));
        probe(file).then((reason) => { if (reason) missing(reason, reason !== "暂时读不到这个文件"); else say("预览没能显示，可以下载"); });
      }, { once: true });
      face.append(img);
    } else face = tile(label, kind === "image" ? fileUrl(file, "image") : "");
    if (!opts.sending) {
      if (kind === "text") {
        const look = iconButton("eye", "预览 " + label, () => previewText(file, look));
        acts.append(look);
      }
      const down = iconButton("download", "下载 " + label, async () => {
        if (box.dataset.busy) return;
        box.dataset.busy = "1";
        down.disabled = true;
        say("正在下载…");
        try {
          save(await fetchFile(file), label);
          say(base());
        } catch (e) {
          if (e.status === 404) missing("文件已不存在", true);
          else if (e.status === 409) missing("文件内容已变化，不能按原样下载", true);
          else say("没能下载：" + R.fileError(e, "稍后再试"), true);
        } finally {
          delete box.dataset.busy;
          if (box.dataset.state !== "missing") down.disabled = false;
        }
      });
      acts.append(down);
    }
    box.append(face, copy, acts);
    say(opts.sending ? "随消息发送中" : base());
    if (known) missing(known, false);
    return box;
  }

  async function previewText(file, opener) {
    const body = node("div", "ws-preview-body");
    body.append(waiting("正在读取…"));
    const d = openDialog({
      title: file.name || "预览", body: [body], wide: true, opener, cancel: "关闭",
      extra: [["secondary", "下载", async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try { save(await fetchFile(file), file.name); d.error(""); }
        catch (e) { d.error("没能下载：" + R.fileError(e, "稍后再试")); }
        finally { b.disabled = false; }
      }]],
    });
    try {
      const data = await H.api(fileUrl(file, "preview"));
      if (!d.alive()) return;
      const pre = node("pre", "ws-preview", String((data && data.text) ?? ""));
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "文件内容");
      body.replaceChildren(...(data && data.truncated ? [note("文件较大，这里只显示前 128 KB。")] : []), pre);
    } catch (e) {
      if (d.alive()) body.replaceChildren(failure("没能预览：" + R.fileError(e, "稍后再试") + "。"));
    }
  }

  // ------------------------------------------------------------------- dialog
  let layer = null, dialogSeq = 0;
  function trap(ev, card) {
    const live = [...card.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")]
      .filter((n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && n.getClientRects().length);
    if (!live.length) return;
    const first = live[0], last = live[live.length - 1], here = document.activeElement;
    if (ev.shiftKey ? here === first || !live.includes(here) : here === last || !live.includes(here)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  }
  // The original modal card, one at a time. Escape, Tab and every other key
  // stay inside it; closing returns focus to whatever opened it.
  function openDialog({ title, body, opener = document.activeElement, submit, onSubmit, onClose, cancel = "取消", wide = false, extra = [] }) {
    if (layer) layer.close(true);
    const root = node("div", "modal ws-modal" + (wide ? " wide" : ""));
    const card = node("form", "modal-card ws-card");
    card.noValidate = true;
    card.tabIndex = -1;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    const h = node("h2", "", title);
    h.id = "ws-dialog-" + ++dialogSeq;
    card.setAttribute("aria-labelledby", h.id);
    const box = node("div", "ws-dialog-body");
    box.append(...body);
    const err = node("p", "error");
    err.setAttribute("role", "alert");
    err.hidden = true;
    const acts = node("div", "modal-actions");
    for (const [cls, text, fn] of extra) acts.append(button(cls, text, fn));
    const no = button("secondary", cancel, () => d.close());
    acts.append(no);
    let ok = null;
    if (submit) { ok = node("button", "primary", submit); ok.type = "submit"; acts.append(ok); }
    card.append(h, box, err, acts);
    root.append(card);
    document.body.append(root);
    let alive = true, busy = false, downOnRoot = false;
    const d = {
      card,
      alive: () => alive,
      error(text) { err.textContent = text || ""; err.hidden = !text; },
      busy(on) { busy = on; if (ok) ok.disabled = on; no.disabled = on; card.setAttribute("aria-busy", String(on)); },
      close(force) {
        if (!alive || (busy && !force)) return;
        alive = false;
        root.remove();
        if (layer === d) layer = null;
        // A history redraw may have replaced the opener: the composer is the next best place.
        if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
        else $("input")?.focus({ preventScroll: true });
        if (onClose) onClose();
      },
    };
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); d.close(); }
      else if (ev.key === "Tab") trap(ev, card);
      ev.stopPropagation();
    });
    root.addEventListener("mousedown", (ev) => { downOnRoot = ev.target === root; });
    root.addEventListener("click", (ev) => { if (ev.target === root && downOnRoot) d.close(); downOnRoot = false; });
    card.addEventListener("submit", (ev) => { ev.preventDefault(); if (!busy && onSubmit) onSubmit(); });
    layer = d;
    (box.querySelector("input:not([type=checkbox]), textarea, select") || ok || no).focus();
    return d;
  }

  // ------------------------------------------------- the conversation's view
  // GET <chat>/workspace: the native thread and its working directory. Only
  // the thread and the paths are used; any other field (a file policy, say)
  // is not turned into a claim here.
  async function loadView() {
    if (!S.sel) return;
    const t = ticket(), req = ++S.viewReq;
    if (!S.view) S.viewState = "loading";
    paintFiles();
    try {
      const view = await H.api(scopePath() + "/workspace");
      if (!live(t) || req !== S.viewReq) return;
      const got = view && typeof view === "object" ? view : null;
      const said = got && got.threadId ? String(got.threadId) : "";
      // Asked before a transcript read confirmed the thread, it cannot say
      // which of the two is newer: ask again instead of moving on its word.
      if (said && t.threadId !== S.threadId && said !== S.threadId) { loadView(); return; }
      S.view = got;
      S.viewState = S.view ? "ready" : "error";
      S.viewError = S.view ? "" : "工作目录的返回格式无法识别";
      if (said) confirmThread(said, true);
    } catch (e) {
      if (!live(t) || req !== S.viewReq) return;
      if (e.status === 404) S.viewState = "unavailable";
      else { S.viewState = S.view ? "ready" : "error"; S.viewError = H.visibleError(e, "没能读取工作目录"); }
    }
    if (t.gen !== S.gen) return;
    paintFiles();
  }

  // --------------------------------------------- 历史对话 (a cat's 详情 page)
  // The cat's saved conversations (GET conversations). The fold shows only
  // when there is more than one; opening one asks the server to move the cat
  // to that existing thread (PUT conversation with the thread this page saw),
  // and the chat then opens afresh in it. The server refuses while either
  // conversation is busy; the refusal is shown and nothing moves.
  //
  // The 详情 page is drawn again whenever the transcript changes, and this
  // fold is the same node each time. A control focused in it before a redraw
  // gets focus back after it, unless the owner has gone elsewhere since.
  let convFocus = "";

  function conversationsView(sel) {
    if (!S.sel || isGroup() || R.key(sel) !== S.key) return null;
    let root = S.roots.convs;
    if (!root) {
      root = node("div", "psec ws-convs");
      root.hidden = true;
      const f = fold("ws-conv-fold", "历史对话", "convs");
      const list = node("ul", "ws-conv-list");
      list.setAttribute("aria-label", "历史对话");
      const line = node("p", "ws-note ws-conv-line");
      line.hidden = true;
      f.box.append(f.sum, list, line);
      f.box.open = folds.convs === S.key;
      const key = S.key;
      f.box.addEventListener("toggle", () => {
        if (!f.box.open) { if (folds.convs === key) folds.convs = ""; return; }
        folds.convs = key;
        // Opening it reads the list again (unless a read is already out); the
        // thread, the composer and the other pages stay as they are.
        if (S.key === key && !S.convBusy) loadConversations();
      });
      root.append(f.box);
      root.addEventListener("focusin", (ev) => { convFocus = (ev.target && ev.target.dataset && ev.target.dataset.wsFocus) || ""; });
      root.addEventListener("focusout", (ev) => { if (ev.relatedTarget && !root.contains(ev.relatedTarget)) convFocus = ""; });
      root._wc = { fold: f.box, label: f.label, list, line, sig: "" };
      S.roots.convs = root;
    }
    paintConvs();
    if (S.convState === "idle" || S.convState === "error") loadConversations();
    if (convFocus) Promise.resolve().then(() => regain(root));
    return root;
  }
  function regain(root) {
    const here = document.activeElement;
    if (convFocus && root.isConnected && (!here || here === document.body)) refocus(root, convFocus);
  }

  // Only the newest read lands: the list is per cat, and an older answer may
  // still mark a thread the cat has since left.
  async function loadConversations() {
    if (!S.sel || isGroup()) return;
    const gen = S.gen, req = ++S.convReq;
    S.convBusy = true;
    if (!S.convs) S.convState = "loading";
    try {
      const data = await H.api(scopePath() + "/conversations");
      if (gen !== S.gen || req !== S.convReq) return;
      S.convs = R.conversations(data && data.conversations);
      S.convState = "ready";
    } catch (e) {
      if (gen !== S.gen || req !== S.convReq) return;
      // A backend without saved conversations has nothing to offer: no fold.
      if (e.status === 404 || e.status === 410) { S.convs = null; S.convState = "unavailable"; }
      else S.convState = "error"; // the last list stays; the next drawing asks again
    }
    S.convBusy = false;
    paintConvs();
  }

  // The conversation open here: the thread a read confirmed, else the
  // server's mark until one has.
  function currentConv(list) {
    if (S.threadId) return S.threadId;
    const marked = list.find((c) => c.current);
    return marked ? marked.id : "";
  }
  const convTitle = (c) => c.title || "未命名对话";

  function paintConvs() {
    const root = S.roots.convs;
    if (!root || !root._wc) return;
    const w = root._wc, list = S.convs || [];
    const show = list.length > 1 && S.convState !== "unavailable";
    root.hidden = !show;
    const current = currentConv(list);
    const sig = JSON.stringify([show, list, current, S.switching && S.switching.id, S.convLine]);
    if (w.sig === sig) return;
    w.sig = sig;
    if (!show) { w.list.replaceChildren(); return; }
    const keep = focusKeyIn(root);
    w.label.textContent = "历史对话 · " + list.length;
    w.list.replaceChildren(...list.map((c) => convRow(c, c.id === current)));
    const line = S.convLine;
    w.line.textContent = line ? line.text : "";
    w.line.hidden = !line;
    w.line.classList.toggle("ws-bad", !!(line && line.bad));
    w.line.setAttribute("role", line && line.bad ? "alert" : "status");
    if (keep) refocus(root, keep);
    else regain(root);
  }

  function convRow(c, current) {
    const li = node("li");
    const title = convTitle(c), when = stamp(c.createdAt);
    const going = !!S.switching && S.switching.id === c.id;
    let row;
    if (current) {
      // Where the chat is now: marked, not a control.
      row = node("div", "ws-row ws-conv here");
      row.setAttribute("aria-current", "true");
      row.tabIndex = -1;
    } else {
      row = button("ws-row ws-conv", null, (ev) => switchConversation(c, ev.currentTarget), "切换到「" + title + "」" + (when ? "，开始于 " + when : ""));
      row.disabled = !!S.switching;
      if (going) row.setAttribute("aria-busy", "true");
    }
    row.dataset.wsFocus = "conv:" + c.id;
    const copy = node("span", "ws-conv-copy");
    const name = node("span", "ws-conv-title", title);
    name.title = title;
    const meta = current ? "当前对话" : going ? "正在切换…" : when ? "开始于 " + when : "";
    copy.append(name);
    if (meta) copy.append(node("span", "ws-conv-meta", meta));
    row.append(copy);
    li.append(row);
    return li;
  }

  function convSay(text, bad) {
    S.convLine = text ? { text, bad: !!bad } : null;
    paintConvs();
  }

  // Pending files belong to the thread they were uploaded to: switching
  // drops them, so the owner says so first.
  function confirmDrop(count, name, opener) {
    return new Promise((resolve) => {
      let ok = false;
      const d = openDialog({
        title: "切换对话", opener, submit: "仍然切换",
        body: [node("p", "note", "切换到「" + name + "」后，待发送的 " + count + " 个附件会被移除：附件只属于上传时的对话。")],
        onSubmit: () => { ok = true; d.close(true); },
        onClose: () => resolve(ok),
      });
    });
  }

  async function switchConversation(c, opener) {
    if (!S.sel || isGroup() || S.switching) return;
    const sel = S.sel, gen = S.gen, title = convTitle(c);
    // Already there: nothing to move; the list is read again.
    if (c.id === S.threadId) { loadConversations(); return; }
    if (H.busy()) { convSay("这条消息还在发送，发出后再切换。", true); return; }
    if (!(S.threadId || (S.view && S.view.threadId))) { convSay("还没读到当前对话，稍后再切换。", true); return; }
    const holding = S.pending.length;
    if (holding && !(await confirmDrop(holding, title, opener))) return;
    // The dialog may have stayed open across a move: ask from where the chat is now.
    const expected = S.threadId || (S.view && S.view.threadId) || "";
    if (gen !== S.gen || S.switching || !expected) return;
    if (c.id === expected) { loadConversations(); return; }
    S.switching = { id: c.id };
    S.convLine = null;
    paintConvs();
    paintComposer();
    try {
      const view = await H.api(scopePath() + "/conversation", { method: "PUT", body: { threadId: c.id, expectedThreadId: expected } });
      if (gen !== S.gen) return;
      S.switching = null;
      paintComposer();
      const landed = view && typeof view === "object" && view.threadId ? String(view.threadId) : "";
      H.toast("已切换到「" + title + "」");
      // A read already confirmed that thread while asking: the chat is there, nothing to reopen.
      if (landed && landed === S.threadId) { paintConvs(); loadConversations(); return; }
      // The cat now talks in that thread: its conversation opens afresh.
      await H.reselect(sel);
    } catch (e) {
      if (gen !== S.gen) return;
      S.switching = null;
      paintComposer();
      const known = e.status === 409 || e.status === 404 || e.status === 403;
      convSay(e.status === 409 ? R.said(e, "当前对话或要打开的对话还有任务在执行，暂时不能切换")
        : known ? R.said(e, "这段对话已不可用") : "没能切换：" + H.visibleError(e, "稍后再试"), true);
      // The list or the thread may have changed under it: read both again.
      if (known) { loadConversations(); loadView(); }
    }
  }

  // --------------------------------------------------------------- 文件 page
  function section(title, actions) {
    const box = node("section", "ws-sec");
    const head = node("div", "ws-sec-head");
    const h = node("h4", "", title);
    const count = node("span", "ws-count");
    h.append(count);
    head.append(h, ...(actions || []));
    const body = node("div", "ws-sec-body");
    box.append(head, body);
    return { box, h, count, body };
  }

  function filesView(sel) {
    if (!S.sel || R.key(sel) !== S.key) return waiting("正在加载");
    if (!S.roots.files) {
      const root = node("div", "ws-pane ws-files");
      root.dataset.tab = "files";
      root.dataset.key = S.key;
      const deliver = section("交付物", [iconButton("refresh-cw", "刷新文件", () => { loadFiles(); loadView(); }, "refresh")]);
      const attach = section("附件");
      // The working directory, folded away: nothing is read from it, nor its
      // path shown, until it opens.
      const f = fold("ws-more", "更多文件", "more");
      const body = node("div", "ws-more-body");
      f.box.append(f.sum, body);
      f.box.open = folds.more === S.key;
      const key = S.key;
      f.box.addEventListener("toggle", () => {
        if (!f.box.open) { if (folds.more === key) folds.more = ""; paintFiles(); return; }
        folds.more = key;
        if (S.key !== key) return;
        if (S.tree.state === "idle" || S.tree.state === "error") loadTree();
        else paintFiles();
      });
      root.append(deliver.box, attach.box, f.box);
      root._ws = { deliver, attach, more: { box: f.box, body }, sigs: {} };
      S.roots.files = root;
    }
    paintFiles();
    if (S.viewState === "idle" || (S.viewState === "error" && !S.view)) loadView();
    if (S.filesState === "idle" || S.filesState === "error") loadFiles();
    if (folds.more === S.key && S.tree.state === "idle") loadTree();
    return S.roots.files;
  }

  // Each part repaints only when what it shows changed, so focus and scroll hold.
  function paintPart(w, part, sig, draw) {
    if (w.sigs[part] === sig) return;
    w.sigs[part] = sig;
    const host = w[part].body;
    const keep = focusKeyIn(host);
    draw();
    if (keep) refocus(host, keep);
  }

  function paintFiles() {
    const root = S.roots.files;
    if (!root || !root._ws || !S.sel) return;
    const w = root._ws;
    const list = S.files || [];
    const delivered = list.filter((f) => f.kind === "deliverable");
    const attached = list.filter((f) => f.kind !== "deliverable");
    // Without a working directory there is nothing to fold away.
    const folded = S.viewState !== "unavailable";
    w.more.box.hidden = !folded;
    const fsig = JSON.stringify([S.filesState, S.filesError, folded, list.map((f) => [f.id, f.kind, f.name, f.size])]);
    w.deliver.count.textContent = S.files ? " · " + delivered.length : "";
    w.attach.count.textContent = S.files ? " · " + attached.length : "";
    paintPart(w, "deliver", fsig, () => {
      w.deliver.body.replaceChildren(...fileList(delivered, "还没有交付物。" + (folded ? "可以在下面的「更多文件」里，把完成的文件存为交付物：" : "交付物") + "会保存一份带校验的快照，之后改动不影响它。"));
    });
    paintPart(w, "attach", fsig + (w.attach.all ? "+" : ""), () => {
      const shown = w.attach.all ? attached : attached.slice(0, 6);
      const parts = fileList(shown, "这个会话还没有附件。可以点输入框左侧的回形针，或直接粘贴、拖入文件。");
      if (attached.length > shown.length) parts.push(button("text-btn ws-link ws-more-all", "显示全部 " + attached.length + " 个", () => { w.attach.all = true; paintFiles(); }));
      w.attach.body.replaceChildren(...parts);
    });
    const opened = folded && !!w.more.box.open;
    paintPart(w, "more", JSON.stringify([opened, S.viewState, S.viewError, S.view && [S.view.workspacePath, S.view.sharedPath], S.tree.area, S.tree.path, S.tree.state, S.tree.error, S.tree.data, S.marks, S.marking, S.markErrors]), () => paintMore(w, opened));
  }

  function fileList(files, empty) {
    if (S.filesState === "unavailable") return [note("当前后端还没有开放文件列表。")];
    if (!S.files && S.filesState === "error") return [failure(S.filesError + "。", () => loadFiles())];
    if (!S.files) return [waiting("正在读取…")];
    const parts = [];
    if (S.filesState === "error") parts.push(failure("刷新没有成功，显示的是上次读取的结果。", () => loadFiles()));
    parts.push(files.length ? cards(files, { time: true, cls: "wide" }) : note(empty));
    return parts;
  }

  function pathRow(list, label, path) {
    const dt = node("dt", "", label);
    const dd = node("dd");
    const text = node("span", "ws-path", R.tail(path));
    text.title = path || "";
    dd.append(text);
    if (path) dd.append(iconButton("copy", "复制" + label + "路径", async (ev) => {
      const b = ev.currentTarget;
      if (await H.copy(path)) H.toast("已复制路径");
      else H.status("复制失败，请手动选择路径。", true);
      b.focus({ preventScroll: true });
    }, "copy:" + label));
    list.append(dt, dd);
  }

  // The areas the server lets this conversation browse: its working directory
  // and, for an older project conversation, the project's shared directory.
  function areas() {
    const v = S.view, first = { area: "workspace", label: "工作目录" };
    if (!v || typeof v.sharedPath !== "string" || !v.sharedPath || v.sharedPath === v.workspacePath) return [first];
    return [first, { area: "shared", label: "共享目录" }];
  }

  // Inside 更多文件, drawn only while it is open: where the directory is
  // (paths appear only here), then read-only browsing with 存为交付物 on each file.
  function paintMore(w, opened) {
    const t = S.tree, body = w.more.body, parts = [];
    if (!opened) { body.replaceChildren(); return; }
    const choices = areas();
    if (S.view) {
      const paths = node("dl", "ws-paths");
      for (const c of choices) {
        const path = c.area === "shared" ? S.view.sharedPath : S.view.workspacePath;
        if (typeof path === "string" && path) pathRow(paths, c.label, path);
      }
      if (paths.childNodes.length) parts.push(paths);
    } else if (S.viewState === "error") parts.push(failure("没能读取工作目录：" + S.viewError + "。", () => loadView()));
    if (choices.length > 1) {
      const seg = node("div", "ws-seg");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", "浏览范围");
      for (const c of choices) {
        const b = button(c.area === t.area ? "on" : "", c.label, () => { if (c.area !== S.tree.area) { S.tree.focus = true; loadTree(c.area, ""); } });
        b.setAttribute("aria-pressed", String(c.area === t.area));
        b.dataset.wsFocus = "area:" + c.area;
        seg.append(b);
      }
      parts.push(seg);
    }
    const rootLabel = (choices.find((c) => c.area === t.area) || choices[0]).label;
    const nav = node("nav", "ws-crumbs");
    nav.setAttribute("aria-label", "当前位置");
    const trail = R.crumbs(t.path);
    trail.forEach((c, i) => {
      if (i) nav.append(icon("chevron", "ws-crumb-sep"));
      const last = i === trail.length - 1;
      const label = c.name || rootLabel;
      if (last) { const here = node("span", "ws-crumb here", label); here.tabIndex = -1; here.setAttribute("aria-current", "location"); nav.append(here); }
      else { const b = button("text-btn ws-crumb", label, () => { S.tree.focus = true; loadTree(S.tree.area, c.path); }); b.dataset.wsFocus = "crumb:" + c.path; nav.append(b); }
    });
    parts.push(nav);
    if (t.state === "unavailable") parts.push(note("当前后端还没有开放目录浏览。"));
    else if (t.state === "error") {
      const p = failure("没能读取：" + t.error + "。", () => loadTree(t.area, t.path));
      if (t.path) p.append(button("text-btn ws-link", "回到上一级", () => { S.tree.focus = true; loadTree(t.area, trail[trail.length - 2].path); }));
      parts.push(p);
    } else if (!t.data) parts.push(waiting("正在读取目录…"));
    else {
      const entries = Array.isArray(t.data.entries) ? t.data.entries : [];
      const list = node("ul", "ws-tree");
      list.setAttribute("aria-label", t.path ? "「" + t.path + "」里的文件" : rootLabel + "里的文件");
      if (t.state === "loading") list.setAttribute("aria-busy", "true");
      for (const e of entries) list.append(treeRow(e));
      if (!entries.length) parts.push(note(t.path ? "这个文件夹是空的。" : "这里还没有文件。猫猫在" + rootLabel + "里写出的文件会出现在这里。"));
      else parts.push(list);
      if (t.data.truncated) parts.push(note("只列出前 200 项。"));
    }
    body.replaceChildren(...parts);
    // After moving to another folder or area, focus lands on where it is now.
    if (t.focus && t.data && t.state === "ready") {
      t.focus = false;
      body.querySelector(".ws-crumb.here")?.focus({ preventScroll: true });
    }
  }

  function treeRow(e) {
    const li = node("li");
    if (e.type === "directory") {
      const row = button("ws-row dir", null, () => { S.tree.focus = true; loadTree(S.tree.area, e.path); }, "打开文件夹 " + e.name);
      row.dataset.wsFocus = "dir:" + e.path;
      row.append(icon("folder"), node("span", "ws-row-name", e.name), icon("chevron", "ws-row-chev"));
      li.append(row);
      return li;
    }
    const row = node("div", "ws-row file");
    const name = node("span", "ws-row-name", e.name);
    name.title = e.name;
    row.append(icon("file"), name, node("span", "ws-size", R.size(e.size)));
    const k = S.tree.area + ":" + e.path, marked = S.marks[k], saving = !!S.marking[k];
    // A snapshot each time: a second one after edits is a new deliverable.
    const mark = button("secondary ws-mark", saving ? "正在保存…" : marked ? "再存一份" : "存为交付物", () => markDeliverable(e), "把 " + e.name + " 存为交付物");
    mark.dataset.wsFocus = "mark:" + e.path;
    if (saving) mark.setAttribute("aria-disabled", "true");
    if (marked) mark.title = "上次保存于 " + stamp(marked);
    row.append(mark);
    if (S.markErrors[k]) {
      const err = node("span", "ws-row-err", S.markErrors[k]);
      err.setAttribute("role", "alert");
      row.append(err);
    }
    li.append(row);
    return li;
  }

  // The listing on screen stays until the next folder has been read, so the
  // control that asked keeps focus; then focus moves to where it is now.
  async function loadTree(area = S.tree.area, path = S.tree.path) {
    if (!S.sel) return;
    // A move starts a fresh tree (its request count too): the epoch tells them apart.
    const t = ticket(), req = ++S.tree.req;
    Object.assign(S.tree, { state: "loading", error: "" });
    paintFiles();
    try {
      const data = await H.api(scopePath() + "/workspace-tree?" + new URLSearchParams({ path, area }));
      if (!live(t) || req !== S.tree.req) return;
      if (area !== S.tree.area || path !== S.tree.path) { S.markErrors = {}; }
      Object.assign(S.tree, { area, path, data: data && typeof data === "object" ? data : { entries: [] }, state: "ready" });
    } catch (e) {
      if (!live(t) || req !== S.tree.req) return;
      const missingRoute = e.status === 404 && !path && /尚无原生适配/.test(String(e.message || ""));
      Object.assign(S.tree, { area, path, data: null, state: missingRoute ? "unavailable" : "error", error: R.fileError(e, H.visibleError(e, "稍后再试")) });
    }
    paintFiles();
  }

  async function markDeliverable(entry) {
    const t = ticket(), area = S.tree.area, k = area + ":" + entry.path;
    if (S.marking[k]) return;
    S.marking = { ...S.marking, [k]: true };
    const errors = { ...S.markErrors };
    delete errors[k];
    S.markErrors = errors;
    paintFiles();
    try {
      const threadId = await whenThread(t.gen);
      if (!live(t)) return;
      const data = await H.api(scopePath() + "/deliverables", { method: "POST", body: { path: entry.path, area, expectedThreadId: threadId } });
      // Saved to the thread it was asked for; after a move this page shows another.
      if (!live(t)) return;
      const file = data && data.file;
      if (file && file.id) S.files = [file, ...(S.files || []).filter((f) => f.id !== file.id)];
      S.marks = { ...S.marks, [k]: Date.now() };
      H.toast("已存为交付物「" + entry.name + "」");
      loadFiles();
    } catch (e) {
      if (!live(t)) return;
      S.markErrors = { ...S.markErrors, [k]: "没能保存：" + R.fileError(e, e.late ? "还没读到当前会话" : "稍后再试") };
    } finally {
      if (live(t)) {
        const marking = { ...S.marking };
        delete marking[k];
        S.marking = marking;
        paintFiles();
      }
    }
  }

  async function loadFiles() {
    if (!S.sel) return;
    const t = ticket(), req = ++S.filesReq;
    if (!S.files) S.filesState = "loading";
    paintFiles();
    try {
      const data = await H.api(scopePath() + "/files");
      if (!live(t) || req !== S.filesReq) return;
      const from = listThread(t, data);
      // Another thread's files: what is shown stays, and the next poll reads again.
      if (from === null) { S.filesStale = true; return; }
      S.files = (Array.isArray(data && data.files) ? data.files : []).filter((f) => f && f.id);
      Object.assign(S, { filesFor: from, filesState: "ready", filesError: "" });
    } catch (e) {
      if (!live(t) || req !== S.filesReq) return;
      if (e.status === 404 && !S.files) S.filesState = "unavailable";
      else Object.assign(S, { filesState: "error", filesError: H.visibleError(e, "没能读取文件") });
    }
    paintFiles();
  }

  // ---------------------------------------------------------------- 任务
  const PROGRESS = { todo: "待办", doing: "进行中", blocked: "受阻", done: "已完成" };
  const progressOf = (task) => (Object.hasOwn(PROGRESS, task.status) ? PROGRESS[task.status] : "状态未知");
  const nameOf = (id) => R.catName(id, S.cats, H.catName);
  const OUTCOME = {
    stop: "停止请求已提交，实际状态以执行记录为准。",
    cancel: "撤销已记录：恢复前不会开始新的执行。这不代表已在进行的工作已经停止。",
    resume: "已解除禁止。这不会自动重新开始执行；需要继续时，在聊天里请负责人继续。",
  };
  const UNCONFIRMED = "停止请求已记录，部分执行尚未确认停止，请稍后刷新查看。";
  // An outcome stays on its card for a few minutes, across refreshes.
  const SAID_FOR = 3 * 60 * 1000;

  function tasksView(sel) {
    if (!S.sel || R.key(sel) !== S.key) return waiting("正在加载");
    if (!S.roots.tasks) {
      const root = node("section", "ws-pane wst");
      root.dataset.tab = "computer";
      root.dataset.key = S.key;
      const head = node("div", "ws-sec-head");
      const h = node("h4", "", "任务");
      h.id = "wst-title-" + S.epoch;
      h.tabIndex = -1;
      root.setAttribute("aria-labelledby", h.id);
      const count = node("span", "ws-count");
      h.append(count);
      const refresh = iconButton("refresh-cw", "刷新任务", () => loadTasks(false), "refresh");
      head.append(h, refresh);
      const body = node("div", "wst-body");
      root.append(head, body);
      root._wst = { h, count, body, cards: new Map(), sig: "" };
      S.roots.tasks = root;
    }
    paintTasks();
    if (T && S.tasksState !== "unavailable" && (S.tasksState === "idle" || Date.now() - S.tasksAt > 4000)) loadTasks(true);
    return S.roots.tasks;
  }

  async function loadTasks(quiet) {
    if (!S.sel || !T) return;
    const t = ticket(), req = ++S.tasksReq;
    if (!S.tasks && !quiet) S.tasksState = "loading";
    else if (!S.tasks && S.tasksState === "idle") S.tasksState = "loading";
    paintTasks();
    try {
      const data = await H.api(scopePath() + "/tasks");
      if (!live(t) || req !== S.tasksReq) return;
      // Another thread's Tasks never paint here; the poll reads again (tasksAt stays).
      const from = listThread(t, data);
      if (from === null) return;
      S.tasks = (Array.isArray(data && data.tasks) ? data.tasks : []).filter((x) => x && typeof x === "object" && x.id != null);
      S.cats = (Array.isArray(data && data.cats) ? data.cats : []).filter((c) => c && typeof c.id === "string");
      S.historyAvailable = !!(data && data.historyAvailable === true);
      Object.assign(S, { tasksFor: from, tasksState: "ready", tasksError: "", tasksAt: Date.now() });
      reconcile();
    } catch (e) {
      if (!live(t) || req !== S.tasksReq) return;
      S.tasksAt = Date.now();
      if (e.status === 404 && !S.tasks) S.tasksState = "unavailable";
      else Object.assign(S, { tasksState: S.tasks ? "stale" : "error", tasksError: H.visibleError(e, "没能读取任务") });
    }
    paintTasks();
    paintStrip();
  }

  // A change's answer can arrive after a read that is already newer (a later
  // owner revision, or the same one updated later): the newer record stays and
  // the regular read reconciles. True when the answer was taken.
  function replaceTask(next) {
    if (!S.tasks) return false;
    const seen = taskById(next.id);
    if (seen && older(next, seen)) return false;
    S.tasks = S.tasks.map((t) => (String(t.id) === String(next.id) ? next : t));
    reconcile();
    paintTasks();
    paintStrip();
    return true;
  }
  const taskById = (id) => (S.tasks && S.tasks.find((x) => String(x.id) === String(id))) || null;
  const updated = (task) => {
    const v = task && task.updatedAt, n = typeof v === "number" ? v : Date.parse(String(v));
    return Number.isFinite(n) ? n : 0;
  };
  const older = (next, seen) => R.revision(next) < R.revision(seen) || (R.revision(next) === R.revision(seen) && updated(next) < updated(seen));

  // What a card says about its owner holds only at the owner revision it was
  // said at. A record at another revision ends it, and the pass receipt with
  // it: the card then says what the record shows, never which change did it
  // (流转记录 says that).
  function reconcile() {
    if (!S.tasks) return;
    for (const [id, receipt] of Object.entries(S.handoffs)) {
      const task = taskById(id);
      if (!task || R.revision(task) !== receipt.revision || Date.now() - receipt.at > 30 * 60 * 1000) delete S.handoffs[id];
    }
    for (const [id, line] of Object.entries(S.lines)) {
      if (line.rev == null) continue;
      const task = taskById(id);
      if (task && R.revision(task) === line.rev) continue;
      if (task && Date.now() - line.at < SAID_FOR) S.lines[id] = { text: ownerNow(task), at: Date.now(), rev: R.revision(task) };
      else delete S.lines[id];
    }
  }
  const ownerNow = (task) => (task.ownerCatId ? "负责人已更新，现在是「" + nameOf(task.ownerCatId) + "」。" : "负责人已更新，现在没有负责人。");

  function paintTasks() {
    const root = S.roots.tasks;
    if (!root || !root._wst) return;
    const w = root._wst;
    const active = document.activeElement;
    const list = S.tasks ? R.order(S.tasks) : null;
    w.count.textContent = list ? " · " + list.length : "";
    const sig = JSON.stringify([S.tasksState, S.tasksError, list, S.cats, S.historyAvailable, S.handoffs, S.lines]);
    if (w.sig === sig) return;
    w.sig = sig;
    if (!T) { w.body.replaceChildren(note("任务暂不可用：页面缺少任务规则脚本。")); return; }
    if (S.tasksState === "unavailable") { w.body.replaceChildren(note("当前后端还没有开放任务。")); return; }
    if (!list) {
      w.body.replaceChildren(S.tasksState === "error" ? failure(S.tasksError + "。", () => loadTasks(false)) : waiting("正在读取任务…"));
      return;
    }
    const parts = [];
    if (S.tasksState === "stale") parts.push(failure("刷新没有成功（" + S.tasksError + "），显示的是上次读取的结果。", () => loadTasks(false)));
    const open = list.filter((t) => t.status !== "done"), done = list.filter((t) => t.status === "done");
    const seen = new Set();
    const cardFor = (task) => {
      const id = String(task.id);
      seen.add(id);
      let card = w.cards.get(id);
      if (!card) { card = taskCard(); w.cards.set(id, card); }
      fillCard(card, task);
      return card;
    };
    // Work starts in the chat itself; Tasks the cats keep for it show here.
    if (!list.length) parts.push(note("还没有任务。直接在聊天里说要做的事就好，不用先建任务。"));
    if (open.length) {
      const box = w.open || (w.open = node("div", "wst-list"));
      arrange(box, open.map(cardFor));
      parts.push(box);
    }
    if (done.length) {
      const doneFold = w.done || (w.done = node("details", "task-details wst-done"));
      if (!doneFold.firstChild) { const sum = node("summary"); sum.append(node("span"), icon("chevron")); doneFold.append(sum, node("div", "wst-list")); }
      doneFold.firstChild.firstChild.textContent = "已完成 · " + done.length;
      arrange(doneFold.lastChild, done.map(cardFor));
      parts.push(doneFold);
    }
    for (const [id, card] of w.cards) if (!seen.has(id)) { w.cards.delete(id); card.remove(); }
    arrange(w.body, parts);
    if (active && active.isConnected && root.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
  }

  // Put children in order, moving only what is out of place (forms and open
  // folds inside the cards survive a refresh).
  function arrange(host, children) {
    let next = host.firstChild;
    for (const child of children) {
      if (child !== next) host.insertBefore(child, next);
      next = child.nextSibling;
    }
    while (next) { const after = next.nextSibling; next.remove(); next = after; }
  }

  function taskCard() {
    const card = node("article", "wst-card");
    card.tabIndex = -1;
    const head = node("div", "wst-head");
    const title = node("h5", "wst-title");
    const state = node("span", "wst-state ty");
    head.append(title, state);
    const owner = node("div", "wst-owner");
    const run = node("p", "wst-run");
    const why = node("p", "wst-why");
    const flags = node("div", "wst-flags");
    const actions = node("div", "wst-actions");
    const slot = node("div", "wst-slot");
    const line = node("p", "wst-line");
    line.setAttribute("role", "status");
    const hist = node("details", "task-details wst-hist");
    const sum = node("summary");
    sum.append(node("span"), icon("chevron"));
    hist.append(sum, node("div", "wst-hist-body"));
    card.append(head, owner, run, why, flags, actions, slot, line, hist);
    card._t = { title, state, owner, run, why, flags, actions, slot, line, hist, task: null, sig: "", acts: "", busy: false, open: "", key: "", keySig: "" };
    return card;
  }

  function fillCard(card, task) {
    const c = card._t;
    c.task = task;
    const id = String(task.id);
    card.dataset.taskId = id;
    const receipt = S.handoffs[id] || null;
    // A line about the owner shows only on the owner revision it was said at.
    const line = S.lines[id];
    const said = line && Date.now() - line.at < SAID_FOR && (line.rev == null || line.rev === R.revision(task)) ? line.text : "";
    const sig = JSON.stringify([task, S.cats, S.historyAvailable, receipt, said]);
    if (c.sig === sig) return;
    c.sig = sig;
    const run = T.background(task), plain = R.ordinary(task);
    c.title.textContent = R.oneLine(task.title) || "（无标题）";
    c.title.title = c.title.textContent;
    c.state.textContent = progressOf(task);
    c.state.className = "wst-state ty " + ("is-" + (Object.hasOwn(PROGRESS, task.status) ? task.status : "unknown"));
    card.setAttribute("aria-label", c.title.textContent + "，" + progressOf(task));
    // 负责人: always the read Task's, never a request in flight.
    const faces = [];
    if (task.ownerCatId) {
      faces.push(node("span", "wst-owner-k", "负责人"), H.face(task.ownerCatId, nameOf(task.ownerCatId), "xs"), node("b", "", nameOf(task.ownerCatId)));
      if (S.cats.length && !R.member(task.ownerCatId, S.cats)) faces.push(node("span", "wst-away", "（已不在这个会话）"));
    } else faces.push(icon("person"), node("span", "", "还没有负责人"));
    c.owner.replaceChildren(...faces);
    // The background run, if there is a record; no record claims nothing.
    if (run.record) {
      const bg = task.backgroundExecution, at = stamp(bg && bg.updatedAt);
      c.run.textContent = run.past ? "上次后台执行：" + run.text + "（不是当前执行）" : "后台执行：" + run.text + (at ? " · " + at : "");
      c.run.hidden = false;
    } else c.run.hidden = true;
    c.why.textContent = String(task.why || "").trim();
    c.why.hidden = !c.why.textContent;
    const flags = [];
    const unproven = run.record && !run.past && run.terminal ? "" : "这不代表已在进行的工作已经停止。";
    if (task.backgroundCancelledAt != null) flags.push("已撤销" + (stamp(task.backgroundCancelledAt) ? "（" + stamp(task.backgroundCancelledAt) + "）" : "") + "：恢复前不会开始新的执行。" + unproven);
    else if (T.stopMarked(task)) {
      const at = stamp(task.backgroundStopRequestedAt != null ? task.backgroundStopRequestedAt : task.backgroundExecution && task.backgroundExecution.stopRequestedAt);
      flags.push("已请求停止" + (at ? "（" + at + "）" : "") + "：「允许继续」前不会开始新的执行。" + unproven);
    }
    if (plain && T.canResume(task) && T.resumeWait(task)) flags.push("后台执行确认结束后才能恢复。");
    if (receipt) flags.push("已请「" + nameOf(receipt.from) + "」传球给「" + nameOf(receipt.to) + "」（" + stamp(receipt.at) + "）。负责人以任务记录为准。");
    if (!plain) flags.push("这类任务在运行面板处理。");
    c.flags.replaceChildren(...flags.map((text) => node("p", "", text)));
    if (!plain) {
      const link = node("a", "ws-link", "打开运行面板");
      link.href = "/runtime.html";
      link.target = "_blank";
      link.rel = "noopener";
      c.flags.append(link);
    }
    c.flags.hidden = !c.flags.childNodes.length;
    c.line.textContent = said;
    c.line.hidden = !said;
    paintActions(card, task, plain);
    paintHistory(card, task);
  }

  // Controls for this Task only. Rebuilt when the set changes; an open form
  // whose action no longer applies is closed and says so.
  function paintActions(card, task, plain) {
    const c = card._t;
    const targets = R.targets(task, S.cats);
    const can = {
      stop: plain && T.canStop(task),
      resume: plain && T.canResume(task),
      handoff: plain && !R.handoffBlocked(task) && targets.length > 0,
      cancel: plain && T.canCancel(task),
    };
    const waitResume = can.resume && T.resumeWait(task);
    const sig = JSON.stringify([can, waitResume, !!task.ownerCatId, T.resumeLabel(task), targets.map((t) => t.id)]);
    if (c.open && !can[c.open]) {
      closeForm(card, false);
      say(card, "任务有变化，这个操作已不可用。");
    }
    if (c.acts === sig) return;
    c.acts = sig;
    const keep = focusKeyIn(c.actions);
    const out = [];
    if (can.stop) out.push(twice(card, "stop", "停止执行", "再点一次停止", () => control(card, "stop")));
    if (can.resume) {
      const b = actionButton(card, "resume", T.resumeLabel(task), () => control(card, "resume"));
      b.disabled = waitResume;
      b.dataset.tip = T.resumeLabel(task) + "只解除禁止，不会自动重新开始执行";
      out.push(b);
    }
    if (can.handoff) out.push(actionButton(card, "handoff", "请求传球…", () => toggleForm(card, "handoff")));
    if (can.cancel) out.push(twice(card, "cancel", "撤销任务", "再点一次撤销", () => control(card, "cancel"), true));
    for (const b of out) if (c.busy) b.disabled = true;
    c.actions.replaceChildren(...out);
    c.actions.hidden = !out.length;
    for (const b of out) if (b.dataset.act === c.open) b.setAttribute("aria-expanded", "true");
    if (keep) refocus(c.actions, keep);
  }

  function actionButton(card, act, text, onClick, quiet) {
    const b = button(quiet ? "text-btn wst-quiet" : "secondary", text, onClick);
    b.dataset.act = act;
    b.dataset.wsFocus = "act:" + act;
    if (act === "handoff") b.setAttribute("aria-expanded", "false");
    return b;
  }
  // Stopping and cancelling ask for a second click, like the task cards' 停止.
  function twice(card, act, text, again, run, quiet) {
    let until = 0, timer = 0;
    const b = actionButton(card, act, text, () => {
      if (Date.now() < until) {
        clearTimeout(timer);
        until = 0;
        b.textContent = text;
        run();
        return;
      }
      until = Date.now() + 3000;
      b.textContent = again;
      timer = setTimeout(() => { until = 0; b.textContent = text; }, 3000);
    }, quiet);
    return b;
  }

  function paintHistory(card, task) {
    const c = card._t, rows = R.history(task);
    const label = c.hist.firstChild.firstChild;
    label.textContent = rows.length ? "流转记录 · " + rows.length : "流转记录";
    const body = c.hist.lastChild;
    if (!S.historyAvailable && !rows.length) { body.replaceChildren(note("当前运行时没有开启流转记录。")); return; }
    if (!rows.length) { body.replaceChildren(note("还没有流转记录。之前的变更不会补记。")); return; }
    const list = node("ol", "wst-hist-list");
    for (const r of rows) {
      const li = node("li");
      const when = node("time", "", stamp(r.at) || "时间未知");
      if (r.at) { when.dateTime = new Date(r.at).toISOString(); when.title = fullTime(r.at); }
      const move = node("span", "wst-move", (r.from ? nameOf(r.from) : "无负责人") + " → " + (r.to ? nameOf(r.to) : "无负责人"));
      const kind = node("span", "wst-kind", [r.kind, r.revision != null ? "第 " + r.revision + " 版" : "", r.source ? "来自聊天消息" : ""].filter(Boolean).join(" · "));
      li.append(when, move, kind);
      list.append(li);
    }
    body.replaceChildren(list);
  }

  // rev: the owner revision a line about the owner speaks of (see reconcile).
  function say(card, text, rev) {
    const c = card._t, id = c.task ? String(c.task.id) : "";
    if (id) { if (text) S.lines[id] = { text, at: Date.now(), rev: rev == null ? null : rev }; else delete S.lines[id]; }
    c.line.textContent = text || "";
    c.line.hidden = !text;
  }
  function hold(card, on) {
    const c = card._t;
    c.busy = on;
    card.setAttribute("aria-busy", String(on));
    for (const b of c.actions.querySelectorAll("button")) b.disabled = on || (b.dataset.act === "resume" && c.task && T.resumeWait(c.task));
    for (const n of c.slot.querySelectorAll("button, select, textarea, input")) n.disabled = on;
  }

  // 请求传球: whom to, and an optional note for the owner.
  function toggleForm(card, kind) {
    const c = card._t;
    if (c.open === kind) { closeForm(card, true); return; }
    closeForm(card, false);
    const task = c.task, targets = R.targets(task, S.cats);
    const form = node("form", "wst-form");
    form.noValidate = true;
    const field = (text, control) => { const l = node("label", "field wst-field"); l.append(node("span", "", text), control); return l; };
    const pick = node("select");
    const none = node("option", "", "选择接手的猫猫");
    none.value = "";
    pick.append(none, ...targets.map((t) => { const o = node("option", "", R.oneLine(t.name) || t.id); o.value = t.id; return o; }));
    const noteBox = node("textarea");
    noteBox.rows = 2;
    noteBox.maxLength = 2000;
    noteBox.placeholder = "例如：资料已整理好，接下来请写报告";
    const acts = node("div", "wst-form-acts");
    const no = button("text-btn", "取消", () => closeForm(card, true));
    const ok = node("button", "primary", "请求传球");
    ok.type = "submit";
    ok.disabled = true;
    pick.addEventListener("change", () => { ok.disabled = c.busy || !pick.value; });
    acts.append(no, ok);
    form.append(field("传给", pick), field("说明（可选）", noteBox),
      note("会请「" + nameOf(task.ownerCatId) + "」按原生流程传球；传球完成前，负责人不变。"), acts);
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (c.busy || !pick.value) return;
      handoff(card, pick.value, noteBox.value);
    });
    form.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeForm(card, true); } });
    c.slot.replaceChildren(form);
    c.open = kind;
    c.actions.querySelector('[data-act="' + kind + '"]')?.setAttribute("aria-expanded", "true");
    pick.focus();
  }
  function closeForm(card, refocusTrigger) {
    const c = card._t;
    const was = c.open;
    c.slot.replaceChildren();
    c.open = "";
    const trigger = was && c.actions.querySelector('[data-act="' + was + '"]');
    if (trigger) { trigger.setAttribute("aria-expanded", "false"); if (refocusTrigger) trigger.focus({ preventScroll: true }); }
    else if (refocusTrigger && was) card.focus({ preventScroll: true });
  }

  // A Task change answers for the thread its card was read in: after a move
  // the card is gone with its page and the answer paints nowhere.
  async function control(card, action) {
    const c = card._t, task = c.task, t = ticket();
    if (c.busy || !task) return;
    hold(card, true);
    say(card, "正在提交…");
    try {
      const reply = await H.api(scopePath() + "/tasks/" + enc(task.id) + "/control", { method: "POST", body: T.controlBody(task, action) });
      if (!live(t)) return;
      const next = reply && reply.task && String(reply.task.id) === String(task.id) ? reply.task : reply && String(reply.id) === String(task.id) ? reply : null;
      const unconfirmed = reply && Array.isArray(reply.unconfirmedTaskIds) ? reply.unconfirmedTaskIds : [];
      say(card, unconfirmed.length && action !== "resume" ? (action === "cancel" ? "撤销已记录；" : "") + UNCONFIRMED : OUTCOME[action]);
      if (next) replaceTask(next);
    } catch (e) {
      if (!live(t)) return;
      const known = e.status === 409 || e.status === 404 || e.status === 400;
      say(card, known ? R.taskError(e) + "。已重新读取，请核对后再操作。" : "没能确认结果：" + H.visibleError(e, "稍后再试") + "。以刷新后的状态为准。");
    } finally {
      if (live(t)) { hold(card, false); loadTasks(true); }
    }
  }

  // 请求传球 asks the owner, in the chat, to pass the Task on through the
  // native handoff. The owner shown changes only when a read shows it.
  async function handoff(card, target, text) {
    const c = card._t, task = c.task, t = ticket();
    if (c.busy || !task || !target) return;
    const body = { targetCatId: target, expectedOwnerRevision: R.revision(task), note: String(text || "").trim() };
    const sig = JSON.stringify([task.id, body]);
    // A retry of the same request keeps its key, so a request that did land is not repeated.
    if (c.keySig !== sig || !c.key) { c.key = uuid(); c.keySig = sig; }
    hold(card, true);
    say(card, "正在请求传球…");
    try {
      await H.api(scopePath() + "/tasks/" + enc(task.id) + "/handoff", { method: "POST", body: { ...body, idempotencyKey: c.key } });
      if (!live(t)) return;
      c.key = "";
      c.keySig = "";
      closeForm(card, false);
      // The card paints the newest read, never the Task captured when asking.
      const now = taskById(task.id) || task;
      if (R.revision(now) === R.revision(task)) {
        S.handoffs[String(task.id)] = { from: task.ownerCatId, to: target, at: Date.now(), revision: R.revision(task) };
        say(card, "已请求传球。负责人仍是「" + nameOf(task.ownerCatId) + "」，传球完成后这里会更新。", R.revision(task));
      } else {
        // A read already shows another owner revision: the request went in, but
        // which change that was is 流转记录's to say.
        say(card, "传球请求已提交。负责人已有变化，以任务记录为准。", R.revision(now));
      }
      c.sig = "";
      fillCard(card, now);
      card.focus({ preventScroll: true });
    } catch (e) {
      if (!live(t)) return;
      say(card, "没能请求传球：" + R.taskError(e) + "。");
    } finally {
      if (live(t)) { hold(card, false); loadTasks(true); }
    }
  }

  // ---------------------------------------------------------- dock summary
  function mountStrip() {
    const work = $("work-status");
    if (!work || S.strip) return;
    const wrap = node("div", "ws-strip");
    wrap.hidden = true;
    const row = button("wrow ws-strip-row", null, () => openTasks());
    wrap.append(row);
    work.after(wrap);
    S.strip = wrap;
  }
  function paintStrip() {
    const wrap = S.strip;
    if (!wrap) return;
    const sum = S.sel && S.tasks ? R.summary(S.tasks) : null;
    const show = !!sum && sum.open > 0;
    wrap.hidden = !show;
    if (!show) { wrap.dataset.sig = ""; return; }
    const owners = sum.owners.slice(0, 3);
    const sig = JSON.stringify([sum, owners.map(nameOf)]);
    if (wrap.dataset.sig === sig) return;
    wrap.dataset.sig = sig;
    const row = wrap.firstChild;
    const parts = [["进行中", sum.doing], ["受阻", sum.blocked], ["待办", sum.todo]].filter(([, n]) => n).map(([k, n]) => k + " " + n);
    const stack = node("span", "work-stack");
    for (const id of owners) stack.append(H.face(id, nameOf(id), "xs"));
    row.replaceChildren(icon("list-checks"), node("b", "", "任务 " + sum.open), node("span", "ws-strip-counts", parts.join(" · ")));
    if (owners.length) row.append(stack);
    row.append(icon("chevron"));
    row.setAttribute("aria-label", "任务 " + sum.open + " 个未完成" + (parts.length ? "：" + parts.join("，") : "") + "。打开任务");
    row.classList.toggle("blocked", sum.blocked > 0);
  }
  async function openTasks() {
    await H.openTab("computer");
    const root = S.roots.tasks;
    if (root && root.isConnected) {
      root.scrollIntoView({ block: "start" });
      root._wst.h.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------------ public
  function init(hooks) {
    H = hooks;
    mountComposer();
    mountStrip();
    // A press anywhere else ends 历史对话's claim on focus (see conversationsView).
    document.addEventListener("pointerdown", (ev) => {
      const root = S.roots.convs;
      if (convFocus && !(root && root.contains(ev.target))) convFocus = "";
    }, true);
    paintComposer();
  }

  window.ClowderWorkspace = Object.freeze({
    init, select, observe, touch, key: R.key,
    addFiles, filesFrom, carriesFiles, attachReady, attachBusy, takeAttachments: take, giveBack, note: setNote,
    cards, filesView, tasksView, conversationsView,
    // Whether a drawer node is this module's live page (the shell keeps it instead of redrawing).
    current: (n) => !!n && (n === S.roots.files || n === S.roots.tasks),
    threadId: () => S.threadId,
  });
})();
