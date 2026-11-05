// Rules for the chat's status line, read position and read-only memory
// (classic script, window.ClowderExperienceRules). No DOM and no network:
// chat-experience.js draws from these and tests load the same file.
//
// Everything here is a native fact as the server projected it (GET
// <scope>/activity, GET /xbot-api/bots/status, GET /xbot-api/memory/…). These
// helpers only check, order and name those facts. They never infer a state
// the record does not show: a read that was partial or failed is "cannot
// tell", never idle; a finished run is not a reply; a Task marked done is
// that Task only.
(() => {
  "use strict";
  const str = (v) => (typeof v === "string" ? v : "");
  const oneLine = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const at = (v) => {
    if (v == null || v === "") return 0;
    const t = typeof v === "number" ? (v > 0 && v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
    return Number.isFinite(t) && t > 0 ? t : 0;
  };

  // ---- Activity ----
  // Native order of attention: what waits for the owner, what failed, what
  // runs, what waits in line, and unfinished Tasks.
  const KINDS = Object.freeze(["approval", "failure", "running", "queued", "task"]);
  const RANK = { approval: 0, failure: 1, running: 2, queued: 3, task: 4 };
  const READ = ["ready", "partial", "unavailable"];

  // GET <scope>/activity, checked. Unknown kinds are dropped (nothing is
  // guessed about them); counts are the server's, never fewer than the items
  // listed. null when the answer is not an activity record at all.
  function activity(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const items = (Array.isArray(data.items) ? data.items : [])
      .filter((i) => i && typeof i === "object" && Object.hasOwn(RANK, i.kind) && (typeof i.id === "string" || typeof i.id === "number"))
      .map((i, n) => ({
        id: String(i.id), kind: i.kind, label: oneLine(i.label), threadId: str(i.threadId),
        catId: str(i.catId), catName: oneLine(i.catName), messageId: str(i.messageId), taskId: str(i.taskId), proposalId: str(i.proposalId), n,
      }))
      .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.n - b.n)
      .map(({ n, ...i }) => i);
    const counts = {};
    for (const k of KINDS) {
      const listed = items.filter((i) => i.kind === k).length;
      const said = count(data.counts && data.counts[k]);
      counts[k] = Math.max(said == null ? 0 : said, listed);
    }
    return {
      threadId: str(data.threadId),
      readStatus: READ.includes(data.readStatus) ? data.readStatus : "unavailable",
      items, counts,
      unread: count(data.unread),
      unreadHasMore: data.unreadHasMore === true,
      latestMessageId: str(data.latestMessageId) || null,
      errors: (Array.isArray(data.errors) ? data.errors : []).filter((e) => e && typeof e === "object")
        .map((e) => ({ source: oneLine(e.source), message: oneLine(e.message) })).filter((e) => e.source || e.message),
    };
  }

  // Words for each kind: the tag in the list, and the short count.
  const TAG = { approval: "等你确认", failure: "失败", running: "处理中", queued: "排队中", task: "未完成任务", reply: "新回复" };
  const SHORT = { approval: "等你确认", failure: "失败", running: "处理中", queued: "排队", task: "任务", reply: "新回复" };
  function lead(kind, n) {
    if (kind === "approval") return n > 1 ? n + " 项等你确认" : "等你确认";
    if (kind === "failure") return n > 1 ? n + " 项失败" : "失败";
    if (kind === "running") return n > 1 ? n + " 项在处理" : "在处理";
    if (kind === "queued") return n > 1 ? n + " 项在排队" : "在排队";
    if (kind === "task") return n + " 项任务未完成";
    return "";
  }
  const unreadText = (a) => (a && a.unread > 0 ? String(a.unread) + (a.unreadHasMore ? "+" : "") : "");
  // An item's own words beside its kind: the server's label, without
  // repeating the kind it already shows (an approval label may begin with
  // 等你确认).
  function itemText(item) {
    if (!item) return "";
    let text = item.label;
    if (item.kind === "approval") text = text.replace(/^等你确认[：:]?\s*/, "");
    return text;
  }

  // The one status line above the composer. The most urgent kind leads and
  // every other kind keeps its count, so nothing concurrent is hidden. New
  // replies show only while the newest one is out of sight (showUnread). A
  // partial read, or a read that failed (failed), says so instead of falling
  // back to "nothing going on". null: nothing to say.
  function line(a, opts = {}) {
    if (!a) return opts.failed ? { kind: "unknown", lead: "暂时无法确认状态", label: "", rest: [], partial: false, catId: "", catName: "" } : null;
    const top = KINDS.find((k) => a.counts[k] > 0) || "";
    const fresh = opts.showUnread ? unreadText(a) : "";
    const partial = a.readStatus !== "ready" || !!opts.failed;
    const rest = KINDS.filter((k) => k !== top && a.counts[k] > 0).map((k) => SHORT[k] + " " + a.counts[k]);
    if (!top) {
      if (fresh) return { kind: "reply", lead: fresh + " 条新回复", label: "", rest: [], partial, catId: "", catName: "" };
      if (partial) return { kind: "unknown", lead: "暂时无法确认状态", label: "", rest: [], partial: false, catId: "", catName: "" };
      return null;
    }
    if (fresh) rest.push(SHORT.reply + " " + fresh);
    const first = a.items.find((i) => i.kind === top) || null;
    const n = a.counts[top], text = itemText(first);
    let head = lead(top, n), label = text;
    // One run or one queued message: its own label says who and what.
    if ((top === "running" || top === "queued") && n === 1 && text) { head = text; label = ""; }
    else if ((top === "running" || top === "queued") && n > 1) label = "";
    return {
      kind: top, lead: head, label, rest, partial,
      catId: first ? first.catId : "", catName: first ? first.catName : "",
    };
  }

  // ---- Sidebar ----
  // One status entry of GET /xbot-api/bots/status (a bot, with its server
  // state) or of its groups list (no state: read from the activity counts).
  // awaiting comes from an open native approval; unknown is a partial read
  // with nothing proven to run, and is never shown as idle.
  function side(entry) {
    const a = activity(entry && entry.activity);
    const said = entry && typeof entry.state === "string" ? entry.state : "";
    let kind = said;
    if (!["running", "queued", "awaiting", "unknown", "idle", "offline"].includes(kind)) {
      if (!a) kind = "idle";
      else if (a.counts.approval > 0) kind = "awaiting";
      else if (a.counts.running > 0) kind = "running";
      else if (a.counts.queued > 0) kind = "queued";
      else if (a.readStatus !== "ready") kind = "unknown";
      else kind = "idle";
    }
    const approvals = a ? a.counts.approval : 0, failures = a ? a.counts.failure : 0;
    let text = "";
    if (kind === "awaiting") text = approvals > 1 ? approvals + " 项等你确认" : "等你确认";
    else if (kind === "unknown") text = "暂时无法确认状态";
    else if (kind === "idle" && failures > 0) { kind = "failure"; text = failures > 1 ? failures + " 项失败" : "有一项失败"; }
    return { kind, text, unread: a && a.unread > 0 ? a.unread : 0, threadId: str(entry && entry.thread_id) || (a ? a.threadId : "") };
  }

  // ---- Read position ----
  // The reply to confirm as read, or "". Only the newest visible cat reply
  // the server named (latestMessageId), only while there is something unread,
  // only for the thread the open chat shows, only with the page visible and
  // the chat not covered, only once it is on screen (seen), and never one
  // already confirmed or refused (done).
  function readTarget(a, ctx) {
    if (!a || !ctx || !ctx.pageVisible || ctx.obscured) return "";
    const id = a.latestMessageId;
    if (!id || !ctx.threadId || a.threadId !== ctx.threadId) return "";
    if (!(a.unread > 0 || a.unreadHasMore)) return "";
    if (ctx.done && ctx.done(id)) return "";
    if (!ctx.seen || !ctx.seen(id)) return "";
    return id;
  }

  // ---- Read-only long-term memory ----
  const MEMORY = { profile: "关于你", taste: "你的偏好" };
  // GET /xbot-api/memory/profile|taste, checked. Entries keep the native
  // order, retired ones after the rest. pendingCount is the number of
  // proposed changes not yet confirmed: they are never part of the content.
  function memory(data, kind) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const entries = (Array.isArray(data.entries) ? data.entries : [])
      .filter((e) => e && typeof e === "object" && (typeof e.id === "string" || typeof e.id === "number"))
      .map((e, n) => ({
        id: String(e.id), title: oneLine(e.title), content: str(e.content).replace(/\r\n?/g, "\n").trim(),
        revision: e.revision == null ? "" : String(e.revision),
        status: e.status === "active" || e.status === "retired" ? e.status : "unknown",
        pendingCount: count(e.pendingCount) || 0, updatedAt: at(e.updatedAt), n,
      }))
      .sort((a, b) => (a.status === "retired") - (b.status === "retired") || a.n - b.n)
      .map(({ n, ...e }) => e);
    return { kind: data.kind === "profile" || data.kind === "taste" ? data.kind : kind, readStatus: READ.includes(data.readStatus) ? data.readStatus : "unavailable", entries };
  }
  // GET /xbot-api/memory/:kind/:id/source?revision=…, checked.
  function sources(data) {
    if (!data || typeof data !== "object") return null;
    const status = ["ready", "not_recorded", "unavailable"].includes(data.status) ? data.status : "unavailable";
    const list = (Array.isArray(data.sources) ? data.sources : []).filter((s) => s && typeof s === "object")
      .map((s) => ({ label: oneLine(s.label), occurredAt: at(s.occurredAt), canOpen: s.canOpen === true, threadId: str(s.threadId), messageId: str(s.messageId) }))
      .filter((s) => s.label || s.occurredAt);
    return { status, sources: list };
  }
  // A failed memory read in words, by kind of failure. A failure is never an
  // empty memory.
  function memoryError(error) {
    const status = error && error.status;
    const said = oneLine(error && error.message).replace(/[。.]+$/, "");
    const zh = /\p{Script=Han}/u.test(said);
    if (status === 401 || status === 403) return { kind: "denied", text: zh ? said : "没有权限读取" };
    if (status === 404) return { kind: "missing", text: zh ? said : "没有找到" };
    if (status === 409) return { kind: "changed", text: zh ? said : "内容已经更新" };
    return { kind: "error", text: zh ? said : "暂时读不到" };
  }

  window.ClowderExperienceRules = Object.freeze({
    KINDS, TAG, SHORT, MEMORY, activity, line, lead, itemText, side, readTarget, memory, sources, memoryError, oneLine, unreadText,
  });
})();
