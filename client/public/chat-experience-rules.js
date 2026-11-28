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
  // What the history already shows: a cat drawn writing there (its live reply
  // or typing bubble, opts.writing: a Set of native cat IDs; "" is a group's
  // bubble whose cat is not named yet and stands for any) is not said again
  // here as 「…正在处理」. Only running items go: waiting in line, a request
  // and a failure always stay, and work the server counts but does not list
  // keeps its count.
  function withoutShown(a, writing) {
    if (!a || !writing || !writing.size) return a;
    const drop = a.items.filter((i) => i.kind === "running" && (writing.has("") || writing.has(i.catId)));
    if (!drop.length) return a;
    return { ...a, items: a.items.filter((i) => !drop.includes(i)), counts: { ...a.counts, running: Math.max(0, a.counts.running - drop.length) } };
  }

  function line(a, opts = {}) {
    a = withoutShown(a, opts.writing);
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
    let head = lead(top, n), label = text, who = "";
    // One run or one queued message: its own label says who and what.
    if ((top === "running" || top === "queued") && n === 1 && text) { head = text; label = ""; }
    else if ((top === "running" || top === "queued") && n > 1) label = "";
    // One failure: its label (「团子这次没完成：原因」) already says it failed, so
    // the kind word 「失败」 is not put before it (item 46). It is cut into the
    // cat's name (who, which may shrink), the words that say it failed (lead,
    // always whole) and the reason after 「：」 (label, regular weight; review r15).
    else if (top === "failure" && n === 1 && text) ({ who, what: head, reason: label } = failureParts(text, first.catName));
    return {
      kind: top, lead: head, label, rest, partial, who,
      catId: first ? first.catId : "", catName: first ? first.catName : "",
    };
  }
  // 「<name>这次没完成：<reason>」 → {who: name, what: 这次没完成, reason}. Without
  // the cat's name at its start the words before 「：」 are what is said.
  function failureParts(text, name) {
    let who = "", body = String(text || "");
    if (name && body.startsWith(name) && body.length > name.length) { who = name; body = body.slice(name.length); }
    const at = body.search(/[：:]/);
    const what = (at >= 0 ? body.slice(0, at) : body).trim();
    return { who: what ? who : "", what: what || body.trim(), reason: at >= 0 ? body.slice(at + 1).trim() : "" };
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
  const MEMORY = { profile: "关于你", taste: "你的偏好", matters: "事项" };
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
  // ---- 事项 (native matters), read only ----
  // GET /xbot-api/memory/matters, checked: the native order as it is (pages
  // are appended, never re-sorted, so 加载更多 moves nothing already shown).
  // revision is the native positive integer, 0 when missing (the detail is
  // then read without one). entryCount 0 may also mean "not said".
  const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  const cursor = (v) => (typeof v === "string" && v ? v : "");
  function matters(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const seen = new Set();
    const entries = (Array.isArray(data.entries) ? data.entries : [])
      .filter((e) => e && typeof e === "object" && typeof e.id === "string" && e.id && !seen.has(e.id) && seen.add(e.id))
      .map((e) => ({
        id: e.id, title: oneLine(e.title), content: str(e.content).replace(/\r\n?/g, "\n").trim(),
        revision: posInt(e.revision),
        status: e.status === "active" || e.status === "retired" ? e.status : "unknown",
        entryCount: count(e.entryCount) || 0,
        sourcesChanged: e.summaryStatus === "sources_changed",
        updatedAt: at(e.updatedAt),
      }));
    return { kind: "matters", readStatus: READ.includes(data.readStatus) ? data.readStatus : "unavailable", entries, nextCursor: cursor(data.nextCursor) };
  }
  // Two reads in one list: what is listed once stays where it is; a page that
  // could not read everything makes the whole list partial (or unavailable
  // while nothing at all was read).
  const joined = (a, b, n) => (a === "ready" && b === "ready" ? "ready" : n ? "partial" : "unavailable");
  function moreMatters(list, page) {
    const have = new Set(list.entries.map((e) => e.id));
    const entries = [...list.entries, ...page.entries.filter((e) => !have.has(e.id))];
    return { ...list, readStatus: joined(list.readStatus, page.readStatus, entries.length), entries, nextCursor: page.nextCursor };
  }
  // GET /xbot-api/memory/matters/:id, checked: the matter's records in the
  // native order. The words quoted are kept only while their source is
  // current; a changed source keeps no quote. at: when it was said, else when
  // it was recorded. sourcesChanged: the matter says some of its records'
  // sources changed (an edited message keeps the revision; only this says it).
  // null when the answer is not a matter at all.
  const RECORD = ["active", "superseded", "retired"];
  const SOURCE = ["current", "changed", "thread_only"];
  function matter(data) {
    if (!data || typeof data !== "object" || !data.matter || typeof data.matter !== "object" || typeof data.matter.id !== "string" || !Array.isArray(data.entries)) return null;
    const seen = new Set();
    const entries = data.entries
      .filter((e) => e && typeof e === "object" && typeof e.id === "string" && e.id && !seen.has(e.id) && seen.add(e.id))
      .map((e) => {
        const src = e.source && typeof e.source === "object" ? e.source : {};
        const sourceStatus = SOURCE.includes(e.sourceStatus) ? e.sourceStatus : "unknown";
        return {
          id: e.id, status: RECORD.includes(e.status) ? e.status : "unknown", sourceStatus,
          summary: str(e.summary).replace(/\r\n?/g, "\n").trim(),
          quote: sourceStatus === "current" ? str(e.quote).replace(/\r\n?/g, "\n").trim() : "",
          at: at(src.occurredAt) || at(e.recordedAt),
          canOpen: src.canOpen === true, threadId: str(src.threadId), messageId: str(src.messageId),
        };
      });
    return { id: data.matter.id, revision: posInt(data.matter.revision), sourcesChanged: data.matter.summaryStatus === "sources_changed", entries, nextCursor: cursor(data.nextCursor) };
  }
  // Once a page says some sources changed, the records read so far say so.
  function moreRecords(detail, page) {
    const have = new Set(detail.entries.map((e) => e.id));
    return { ...detail, sourcesChanged: !!(detail.sourcesChanged || page.sourcesChanged), entries: [...detail.entries, ...page.entries.filter((e) => !have.has(e.id))], nextCursor: page.nextCursor };
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
    KINDS, TAG, SHORT, MEMORY, activity, line, withoutShown, lead, itemText, failureParts, side, readTarget, memory, sources, matters, moreMatters, matter, moreRecords, memoryError, oneLine, unreadText,
  });
})();
