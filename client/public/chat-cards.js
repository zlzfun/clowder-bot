// What a cat attaches to a reply, asks the owner to confirm, or leaves
// unfinished, drawn in the chat itself (classic script, window.ClowderCards).
// Loads after chat-cards-rules.js and before app.js, which calls init() once
// and then:
//   select()   when the conversation changes;
//   observe()  after each transcript or group read: the conversation's open
//              requests (GET <scope>/approvals) are read alongside;
//   words()    for the words a reply shows (a request's message and an ended
//              reply's stand-in words are not shown as words);
//   blocks()   to add a reply's cards, checklists, choices and diffs under its words;
//   ending()   to add how an unfinished reply ended (详情, 再发一次);
//   notice()   for a receipt or refusal line (a row with notice: true);
//   rendered() right after the history was committed (ClowderLive.commit).
//
// Request cards and choices are drawn into a stable empty frame (.ck-live)
// that is part of the row's markup; what they show (the open list, the
// owner's answer in flight) is filled in after the commit. So a row whose
// message did not change keeps its element and never rises in again, and a
// card changes in place, keeping focus.
//
// Nothing here is a record or a runtime: requests, their lifecycle and their
// effect stay native; a pick is an ordinary chat message sent through the
// normal send path, then recorded on the native block. Every outcome shown is
// the server's own: an answer in flight is never shown as done.
(() => {
  "use strict";
  const R = window.ClowderCardsRules;
  const enc = encodeURIComponent;
  const RUNTIME = "/runtime.html";
  let H = null;

  // ------------------------------------------------------------------ helpers
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, onClick, focus) {
    const b = node("button", cls, text);
    b.type = "button";
    if (focus) b.dataset.ckFocus = focus;
    if (onClick) b.addEventListener("click", (ev) => { if (b.getAttribute("aria-disabled") === "true") { ev.preventDefault(); return; } onClick(ev); });
    return b;
  }
  function runtimeLink(text) {
    const a = node("a", "ws-link ck-runtime", text);
    a.href = RUNTIME;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }
  const icon = (name, extra) => H.icon(name, extra);
  const keyOf = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const scopeOf = (sel) => (sel.type === "group" ? "/xbot-api/groups/" : "/xbot-api/bots/") + enc(sel.id);
  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  // One quiet announcement line for screen readers (what an answer led to).
  let speaker = null;
  function announce(text) {
    if (!speaker) {
      speaker = node("div", "visually-hidden");
      speaker.setAttribute("role", "status");
      speaker.setAttribute("aria-live", "polite");
      document.body.append(speaker);
    }
    speaker.textContent = text;
  }

  // -------------------------------------------------------------------- state
  const S = {
    sel: null, key: "", gen: 0, threadId: "",
    // This conversation's open requests (the last list read), how that read
    // stands, when it was asked for, what asked for it last; reads are
    // numbered (listReq), listDone is the number of the last one that came
    // back, and listAgain asks for one more after the read in flight.
    list: new Map(), listState: "idle", listAt: 0, listSig: "", listReq: 0, listDone: 0, listLoading: false, listAgain: false,
    // What each frame in the history stands for, from the latest drawing.
    facts: new Map(),
    // The focused frame, to give focus back when a redraw replaced its row.
    focus: null,
    // A request to find once it is drawn (a notification was clicked).
    locate: null,
  };
  // Requests as this page last listed them (their words once settled), and
  // the owner's answers from this page: kept for the page's life, by request.
  const seen = new Map();
  const decisions = new Map();
  // Picks in progress, by conversation, message and block.
  const picks = new Map();

  function select(sel) {
    S.gen++;
    Object.assign(S, {
      sel: sel && sel.id ? { type: sel.type === "group" ? "group" : "bot", id: String(sel.id) } : null,
      threadId: "", list: new Map(), listState: "idle", listAt: 0, listSig: "", listDone: 0, listLoading: false, listAgain: false, focus: null,
    });
    S.key = keyOf(S.sel);
    S.facts.clear();
    if (S.locate && S.locate.key !== S.key) S.locate = null;
  }

  // After each read of the open conversation: its thread, and the request
  // cards on the page. The open list is read when the set of unanswered cards
  // or the count of waiting requests changed, and again now and then while
  // any is waiting.
  function observe(sel, threadId, messages) {
    if (!S.sel || keyOf(sel) !== S.key) return;
    const id = threadId ? String(threadId) : "";
    if (id && id !== S.threadId) Object.assign(S, { threadId: id, list: new Map(), listState: "idle", listAt: 0, listSig: "", listDone: 0 });
    const open = [];
    for (const m of messages || []) {
      for (const b of m && Array.isArray(m.blocks) ? m.blocks : []) {
        if (b && b.kind === "card" && b.approval && typeof b.approval.id === "string" && !b.approval.state) open.push(b.approval.id);
      }
    }
    if (!open.length || !S.threadId) return;
    const X = window.ClowderExperience;
    const a = X && typeof X.activity === "function" ? X.activity() : null;
    const waiting = a && a.threadId === S.threadId ? a.counts.approval : -1;
    const sig = JSON.stringify([S.threadId, open, waiting]);
    if (sig !== S.listSig || Date.now() - S.listAt > 15000) { S.listSig = sig; loadList(); }
    // A frame whose view changed with the time (a request close to running out).
    repaint();
  }

  async function loadList() {
    if (!S.sel || !S.threadId) return;
    if (S.listLoading) { S.listAgain = true; return; }
    const gen = S.gen, req = ++S.listReq, threadId = S.threadId, askedAt = Date.now();
    S.listLoading = true;
    if (S.listState === "idle") S.listState = "loading";
    try {
      const got = R.approvals(await H.api(scopeOf(S.sel) + "/approvals"));
      if (gen !== S.gen || req !== S.listReq || threadId !== S.threadId) return;
      if (!got) throw Object.assign(new Error("bad answer"), { status: 0 });
      // Another thread's requests never show here; the next read asks again.
      if (got.threadId && got.threadId !== S.threadId) { S.listSig = ""; return; }
      S.list = new Map(got.list.map((i) => [i.id, i]));
      for (const i of got.list) seen.set(i.id, i);
      S.listState = "ready";
      S.listAt = askedAt;
      S.listDone = req;
    } catch (e) {
      if (gen !== S.gen || req !== S.listReq) return;
      // A list read before stays (the server checks again on every answer);
      // a server without this route sends the owner to the runtime panel.
      if (S.listState !== "ready") S.listState = e && e.status === 404 ? "missing" : "error";
      S.listAt = askedAt;
    } finally {
      if (gen === S.gen && req === S.listReq) S.listLoading = false;
    }
    if (gen !== S.gen) return;
    repaint();
    if (S.listAgain && !S.listLoading) { S.listAgain = false; loadList(); }
  }

  // ------------------------------------------------------------ the history
  // The words a reply shows (see ClowderCardsRules.words).
  const words = (m, text) => R.words(m, text);

  // A reply's blocks, under its words: request cards and choices as frames
  // filled after the commit, the rest drawn from the record as it is.
  function blocks(body, m, messages, group) {
    const list = Array.isArray(m && m.blocks) ? m.blocks : [];
    let hidden = R.count(m && m.blocks_hidden);
    if (!list.length && !hidden) return;
    const box = node("div", "ck-blocks");
    const mid = String((m && (m.native_message_id || m.id)) || "");
    for (const b of list) {
      const drawn = b && typeof b === "object" && typeof b.id === "string" ? draw(b, mid, m) : null;
      if (drawn) box.append(drawn);
      else hidden++;
    }
    // Kinds the chat cannot draw yet are said, never dropped.
    if (hidden) box.append(node("p", "ck-hidden", R.hiddenText(hidden)));
    if (box.childNodes.length) body.append(box);
  }
  function draw(b, mid, m) {
    if (b.kind === "card" && b.approval && typeof b.approval.id === "string" && b.approval.id) {
      return frame("approval", b.approval.id, { block: b, mid, catName: catOf(m) });
    }
    if (b.kind === "choices" && Array.isArray(b.options) && b.options.length && mid) return frame("choice", mid + "|" + b.id, { block: b, mid });
    if (b.kind === "card" && typeof b.title === "string") return cardBlock(b);
    if (b.kind === "checklist" && Array.isArray(b.items)) return checklist(b);
    if (b.kind === "diff" && typeof b.diff === "string") return diffBlock(b);
    return null;
  }
  const catOf = (m) => String((m && ((m.speaker && m.speaker.name) || m.sender || m.name)) || "");
  // A frame's markup is only its kind and key: what it shows is not part of
  // the row's redraw identity, so the row stays as long as its message does.
  function frame(kind, key, fact) {
    S.facts.set(kind + ":" + key, fact);
    const f = node("div", "ck-live ck-" + kind);
    f.dataset.ck = kind;
    f.dataset.ckKey = key;
    return f;
  }

  // A card the cat attached: title, its words, fields; the tone as a small mark.
  const TONE_ICON = { info: "info", success: "circle-check", warning: "awaiting", danger: "circle-x" };
  function cardBlock(b) {
    const card = node("div", "ck-card" + (b.tone ? " ck-tone-" + b.tone : ""));
    const head = node("div", "ck-card-head");
    if (b.tone && TONE_ICON[b.tone]) head.append(icon(TONE_ICON[b.tone], "ck-tone"));
    head.append(node("div", "ck-card-title", b.title));
    card.append(head);
    if (b.body) {
      const prose = node("div", "prose ck-card-body");
      H.render(prose, b.body);
      card.append(prose);
    }
    if (Array.isArray(b.fields) && b.fields.length) {
      const dl = node("dl", "ck-fields");
      for (const f of b.fields) dl.append(node("dt", "", f.label), node("dd", "", f.value));
      card.append(dl);
    }
    return card;
  }
  // A checklist as the cat wrote it (read only).
  function checklist(b) {
    const card = node("div", "ck-card ck-checklist");
    if (b.title) card.append(node("div", "ck-card-title", b.title));
    const list = node("ul", "ck-checks");
    for (const item of b.items) {
      const li = node("li", item.checked ? "on" : "");
      const box = node("span", "ck-box");
      box.setAttribute("aria-hidden", "true");
      if (item.checked) box.append(icon("check"));
      li.append(box, node("span", "ck-check-text", item.text));
      li.setAttribute("aria-label", (item.checked ? "已完成：" : "未完成：") + item.text);
      list.append(li);
    }
    card.append(list);
    return card;
  }
  // A change to a file: its name, how much changed, and the lines.
  function diffBlock(b) {
    const d = R.diffLines(b.diff);
    const card = node("div", "ck-card ck-diff");
    const head = node("div", "ck-card-head");
    head.append(icon("file-text", "ck-file"), node("span", "ck-diff-file", b.file || "文件"));
    const n = node("span", "ck-diff-count");
    if (d.add) n.append(node("span", "ck-add", "+" + d.add));
    if (d.del) n.append(node("span", "ck-del", "−" + d.del));
    head.append(n);
    const pre = node("pre", "ck-diff-body");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", "改动：" + (b.file || "文件"));
    for (const line of d.lines) pre.append(node("span", "ck-dl ck-dl-" + line.kind, line.text || " "));
    if (d.more) pre.append(node("span", "ck-dl ck-dl-meta", "…还有 " + d.more + " 行"));
    card.append(head, pre);
    return card;
  }

  // A receipt of the engine reworded, or a refusal said once by name: a quiet
  // centred line, not a bubble from a "系统" speaker. A reminder that came due
  // (reminder: true, 「提醒：…」) is a little more present: the alarm clock of
  // a schedule card before its words, on a soft pill; the cat's reply follows.
  function notice(m, text) {
    const row = node("div", "sysline ck-notice" + (m.reminder ? " ck-reminder" : ""));
    if (m.seq) row.dataset.seq = String(m.seq);
    const id = m.native_message_id || m.id;
    if (id) row.dataset.mid = String(id);
    if (m.time) row.dataset.time = String(m.time);
    if (m.reminder) row.append(icon("alarm-clock"));
    const label = node("span", "label", String(text || ""));
    label.title = String(text || "");
    row.append(label);
    return row;
  }

  // How a reply that did not finish ended: a quiet line under it, the
  // engine's reason behind 详情 (verbatim), and for a failed or interrupted
  // one 再发一次, which sends the owner's message it answered again.
  function ending(body, m, messages, group) {
    const e = R.ending(m);
    if (!e) return;
    const line = node("div", "lv-ended ck-ended");
    line.append(node("span", "ck-ended-label", e.label));
    // The box's ID follows its message, so a redraw of the same row draws the same markup.
    const reason = e.reason ? reveal(line, e.reason) : null;
    if (reason) reason.id = "ck-reason-" + String(m.native_message_id || m.id || "").replace(/[^\w-]/g, "");
    if (reason) line.lastChild.setAttribute("aria-controls", reason.id);
    const again = e.again ? R.resend(messages, m, group) : null;
    if (again) {
      const btn = button("text-btn ck-link", "再发一次", () => resend(again, btn));
      const count = (again.all || []).length;
      btn.setAttribute("aria-label", "再发一次：" + R.oneLine(again.text).slice(0, 40) + (count > 1 ? "，共 " + count + " 句" : ""));
      line.append(btn);
    }
    body.append(line);
    if (reason) body.append(reason);
  }
  // Sends what the reply was answering again, each as the ordinary message
  // it was, in order, through the normal send path, one after the server
  // took the one before; says so once the server took them (the new messages
  // show below). If one is not taken, the ones after it are not sent: the
  // send path says why under it, and the line says how many went.
  async function resend(again, btn) {
    const list = again.all && again.all.length ? again.all : [again];
    btn.setAttribute("aria-disabled", "true");
    btn.textContent = "正在发送…";
    let went = 0;
    const tell = () => {
      const files = list.slice(0, went).some((one) => one.files);
      const words = went === list.length ? "已再发一次" + (list.length > 1 ? "（" + list.length + " 句）" : "") : "再发了 " + went + " 句，第 " + (went + 1) + " 句没有发出去";
      const said = node("span", "ck-said", words + (files ? "（附件没有一起发）" : ""));
      said.setAttribute("role", "status");
      if (btn.isConnected) btn.replaceWith(said);
    };
    for (let k = 0; k < list.length; k++) {
      let took = false;
      // The last one is told as soon as the server took it; each one before it is sent after the one before was handled.
      const sending = H.send(list[k].text, () => { took = true; went++; if (went === list.length) tell(); });
      try { await sending; } catch (e) { /* the send path said why */ }
      if (!took) break;
    }
    if (went === list.length) return;
    if (went) { tell(); return; }
    // Nothing was sent: the send path says why under the message; the action is offered again.
    btn.removeAttribute("aria-disabled");
    btn.textContent = "再发一次";
  }

  // ------------------------------------------------------- filling the frames
  // Right after the history was committed (and whenever what a frame shows
  // changed): each frame is filled from its record, the open list and this
  // page's answer in flight. A frame whose view did not change is untouched.
  function rendered() {
    repaint();
    // A redraw that replaced the focused frame's row: focus goes to the new one.
    const f = S.focus;
    if (f && !hasFocus()) {
      const host = frameOf(f.kind, f.key);
      if (host) refocus(host, f.part);
    }
    if (S.locate && S.locate.key === S.key) {
      if (Date.now() > S.locate.until) S.locate = null;
      else if (find(S.locate.item)) S.locate = null;
    }
  }
  const hasFocus = () => { const a = document.activeElement; return !!a && a !== document.body && !!a.isConnected; };
  function frames() { return H && H.thread ? [...H.thread.querySelectorAll(".ck-live")] : []; }
  function frameOf(kind, key) { return frames().find((f) => f.dataset.ck === kind && f.dataset.ckKey === key) || null; }
  function repaint() { for (const f of frames()) paint(f); }
  function paint(host) {
    const kind = host.dataset.ck, key = host.dataset.ckKey;
    const fact = S.facts.get(kind + ":" + key);
    if (!fact) return;
    const view = kind === "approval" ? approvalView(key, fact) : choiceView(key, fact);
    const sig = JSON.stringify(view);
    if (host._ckSig === sig) return;
    const a = document.activeElement;
    const part = a && host.contains(a) ? (a.dataset && a.dataset.ckFocus) || "card" : "";
    host._ckSig = sig;
    host.replaceChildren(kind === "approval" ? approvalCard(key, fact, view) : choiceCard(key, fact, view));
    if (part) refocus(host, part);
  }
  function refocus(host, part) {
    const all = [host, ...host.querySelectorAll("[data-ck-focus]")];
    const hit = all.find((n) => n.dataset && n.dataset.ckFocus === part) || host.querySelector("[data-ck-focus='card']");
    if (hit) hit.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------- 等你确认
  function approvalView(id, fact) {
    const local = decisions.get(id) || null;
    return R.card({
      fact: fact.block, item: S.list.get(id) || null, list: S.listState, seen: seen.get(id) || null,
      // fresh: a list read asked for after the answer came back.
      local, fresh: !!local && S.listDone > (local.after || 0), catName: fact.catName, now: Date.now(),
    });
  }
  const KIND_ICON = { preference: "book-open", profile: "person", person: "users-plus", schedule: "alarm-clock", question: "message-circle-question", other: "info" };
  function approvalCard(id, fact, v) {
    if (v.mode === "line") {
      const row = node("div", "approval-line ck-line " + (v.tone === "neutral" ? "ck-neutral" : v.tone));
      row.tabIndex = -1;
      row.dataset.ckFocus = "card";
      const st = node("span", "st");
      st.append(icon(v.icon));
      const what = node("span", "what", v.text + (v.what ? " · " + v.what : ""));
      what.title = what.textContent;
      row.append(st, what);
      if (v.runtime) row.append(runtimeLink("打开运行面板"));
      return row;
    }
    const card = node("div", "approval ck-ask");
    card.tabIndex = -1;
    card.dataset.ckFocus = "card";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", v.title);
    const head = node("div", "approval-head");
    const ico = node("span", "approval-ico");
    ico.append(icon(KIND_ICON[v.kind] || "info"));
    const main = node("div", "approval-main");
    main.append(node("div", "approval-title", v.title));
    if (v.body) main.append(node("div", "ck-ask-body", v.body));
    if (v.quote) {
      const q = node("blockquote", "quote ck-quote", v.quote);
      q.setAttribute("aria-label", "你说过：" + v.quote);
      main.append(q);
    }
    head.append(ico, main);
    card.append(head);
    const actions = node("div", "approval-actions");
    if (v.waiting || v.expiry) {
      const t = node("span", "approval-timer ck-when");
      if (v.expiry) t.append(icon("clock"));
      t.append(node("span", "", v.waiting || v.expiry));
      actions.append(t);
    }
    for (const a of v.actions) {
      const busy = v.busy === a.decision;
      const b = button(a.decision === "approve" ? "primary" : "secondary", null, () => decide(id, a.decision), "act:" + a.decision);
      if (busy) {
        const spin = icon("spinner", "approval-spinner");
        b.append(spin, document.createTextNode("正在提交…"));
        b.setAttribute("aria-busy", "true");
      } else b.textContent = a.label;
      if (v.busy) b.setAttribute("aria-disabled", "true");
      actions.append(b);
    }
    if (actions.childNodes.length) card.append(actions);
    if (v.note) {
      const p = node("p", "ck-note", v.note + "。");
      if (v.runtime) p.append(document.createTextNode(" "), runtimeLink("打开运行面板"));
      card.append(p);
    }
    if (v.error) {
      const err = node("div", "approval-err ck-err");
      err.setAttribute("role", "alert");
      err.append(document.createTextNode(v.error.text + "。"));
      card.append(err);
      if (v.error.detail) card.append(reveal(err, v.error.detail, "detail"));
    }
    return card;
  }
  // 详情 at the end of a line: the engine's own words (verbatim), shown only
  // when asked for. Returns the box, which goes after the line.
  let reveals = 0;
  function reveal(line, text, focus) {
    const box = node("pre", "ck-reason", text);
    box.hidden = true;
    box.id = "ck-reason-" + ++reveals;
    const more = button("text-btn ck-link", "详情", () => {
      box.hidden = !box.hidden;
      more.setAttribute("aria-expanded", String(!box.hidden));
    }, focus);
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-controls", box.id);
    line.append(more);
    return box;
  }

  // The owner's answer: sent to the server, and shown as what it said back.
  async function decide(id, decision) {
    const sel = S.sel, threadId = S.threadId;
    const cur = decisions.get(id);
    if (!sel || !threadId || (cur && cur.phase === "sending")) return;
    const at = Date.now();
    decisions.set(id, { phase: "sending", decision, at });
    repaint();
    let res = null, data = {};
    try {
      res = await H.apiFetch(scopeOf(sel) + "/approvals/" + enc(id), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, expectedThreadId: threadId }),
      }, true);
      const text = await res.text();
      try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
    } catch (e) {
      decisions.set(id, { phase: "error", decision, at, error: { text: "连不上 clowder-bot，不确定刚才的回答有没有送到；可以再点一次", detail: "" } });
      announce("没能提交");
      repaint();
      return;
    }
    if (res.ok) {
      const settled = data.settled === true ? true : data.settled === false ? false : null;
      // after: reads numbered above this one were asked for after the answer.
      decisions.set(id, { phase: "sent", decision, at, settled, after: S.listReq });
      announce(settled === true ? "已提交" : settled === false ? "已提交，还在处理" : "已提交，没能确认结果");
      // The receipt and the request's new state come with the next reads.
      S.listSig = "";
      loadList();
      if (H.reload) H.reload();
    } else {
      const err = R.failure(data, decision === "approve" ? "没能提交，还没有生效" : "没能提交，这件事仍在等你确认");
      decisions.set(id, { phase: "error", decision, at, error: err });
      announce(err.text);
      // Already answered or not here: the list says so; another conversation: read again.
      if (res.status === 404) { S.listSig = ""; loadList(); }
      if (res.status === 409 && H.reload) H.reload();
    }
    repaint();
  }

  // The status line's 去确认 and a clicked notification: the card in the
  // history, scrolled to, flashed and focused. false: not in what is drawn.
  function find(item) {
    if (!item) return false;
    let host = item.proposalId ? frameOf("approval", String(item.proposalId)) : null;
    if (!host && item.messageId) {
      const row = H && H.thread ? [...H.thread.querySelectorAll("[data-mid]")].find((r) => r.dataset.mid === item.messageId) : null;
      host = row ? row.querySelector(".ck-live.ck-approval") : null;
    }
    const card = host && (host.querySelector(".approval, .approval-line") || host);
    if (!card) return false;
    card.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    card.classList.remove("ck-hit");
    void card.offsetWidth;
    card.classList.add("ck-hit");
    setTimeout(() => card.classList.remove("ck-hit"), 1500);
    card.focus({ preventScroll: true });
    return true;
  }
  // The same once the chat that holds it has drawn (a notification opened it).
  function locateSoon(sel, item) {
    S.locate = { key: keyOf(sel), item, until: Date.now() + 10000 };
    if (S.locate.key === S.key && find(item)) S.locate = null;
  }

  // ------------------------------------------------------------- 选项
  function pickOf(key) {
    const k = S.key + "|" + key;
    let p = picks.get(k);
    if (!p) { p = { phase: "idle", picks: [], custom: "", ids: [], text: "", selected: [], error: null }; picks.set(k, p); }
    return p;
  }
  function choiceView(key, fact) {
    const p = picks.get(S.key + "|" + key) || null;
    return R.choice(fact.block, p);
  }
  function choiceCard(key, fact, v) {
    const b = fact.block;
    const card = node("div", "ask ck-ask-choice" + (v.mode === "answered" ? " done" : ""));
    card.tabIndex = -1;
    card.dataset.ckFocus = "card";
    card.setAttribute("role", "group");
    if (b.title) card.setAttribute("aria-label", b.title);
    if (b.title) card.append(node("p", "ask-q", b.title));
    if (b.description && v.mode !== "answered") card.append(node("p", "ck-ask-desc", b.description));
    if (v.mode === "answered") {
      if (!v.picked.length) card.append(chosen("已回答"));
      for (const o of v.picked) card.append(chosen(o.text));
      return card;
    }
    const p = pickOf(key);
    if (b.mode === "confirm") {
      const row = node("div", "approval-actions ck-confirm");
      const [yes, no] = b.options;
      for (const o of [no, yes]) {
        if (!o) continue;
        const btn = button(o === yes ? "primary" : "secondary", null, () => choose(key, fact, [o.id]), "opt:" + o.id);
        if (v.sending.includes(o.id)) { btn.append(icon("spinner", "approval-spinner"), document.createTextNode("正在发送…")); btn.setAttribute("aria-busy", "true"); }
        else btn.textContent = R.optionText(o);
        if (v.busy) btn.setAttribute("aria-disabled", "true");
        row.append(btn);
      }
      card.append(row);
    } else {
      const multiple = b.mode === "multiple";
      const list = node("div", "ask-opts");
      list.setAttribute("role", "group");
      b.options.forEach((o, i) => {
        if (o.custom && !multiple) { list.append(customRow(key, fact, o, v, p)); return; }
        const on = multiple && v.picks.includes(o.id);
        const btn = button("ask-opt" + (on ? " on" : ""), null, () => {
          if (multiple) toggle(key, o.id);
          else choose(key, fact, [o.id]);
        }, "opt:" + o.id);
        if (multiple) btn.setAttribute("aria-pressed", String(on));
        const badge = node("span", "opt-badge" + (on ? " on" : ""));
        if (multiple && on) badge.append(icon("check"));
        else badge.textContent = String.fromCharCode(65 + i);
        const t = node("span", "opt-t");
        t.append(node("span", "ck-opt-label", R.optionText(o)));
        if (o.description) t.append(node("span", "ck-opt-desc", o.description));
        btn.append(badge, t);
        if (v.sending.includes(o.id) && !multiple) btn.append(icon("spinner", "approval-spinner"));
        if (v.busy || (multiple && v.full && !on)) btn.setAttribute("aria-disabled", "true");
        list.append(btn);
      });
      list.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
        const items = [...list.querySelectorAll("button.ask-opt")];
        const at = items.indexOf(document.activeElement);
        if (at < 0) return;
        ev.preventDefault();
        items[(at + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
      });
      card.append(list);
      if (multiple) {
        const row = node("div", "approval-actions ck-confirm");
        // The limit is said on screen once it is reached, when the other
        // options turn unavailable and need a reason; before that it is for a
        // screen reader only, and 确认选择（n） counts the picks (item 46).
        if (b.max) row.append(node("span", "approval-timer" + (v.full ? "" : " visually-hidden"), "最多选 " + b.max + " 项"));
        const n = v.picks.length;
        const go = button("primary", null, () => choose(key, fact, p.picks.slice()), "submit");
        if (v.busy) { go.append(icon("spinner", "approval-spinner"), document.createTextNode("正在发送…")); go.setAttribute("aria-busy", "true"); }
        else go.textContent = n ? "确认选择（" + n + "）" : "确认选择";
        if (v.busy || !v.ready) go.setAttribute("aria-disabled", "true");
        row.append(go);
        card.append(row);
      }
    }
    if (v.note) {
      const p2 = node("p", "ck-note" + (v.tone === "bad" ? " ck-bad" : ""), v.note);
      p2.setAttribute("role", v.tone === "bad" ? "alert" : "status");
      if (v.retry) p2.append(document.createTextNode(" "), button("text-btn ck-link", "再记一次", () => record(key, fact, p.ids, p.text), "retry"));
      card.append(p2);
    }
    return card;
  }
  function chosen(text) {
    const row = node("div", "ask-chosen");
    const check = node("span", "ask-check");
    check.append(icon("check"));
    row.append(node("span", "opt-t", text), check);
    return row;
  }
  // The option that takes the owner's own words: a field and a send button.
  function customRow(key, fact, o, v, p) {
    const row = node("div", "ask-opt other" + (p.custom.trim() ? " typing" : ""));
    const badge = node("span", "opt-badge ghost");
    badge.append(icon("pencil"));
    const field = document.createElement("input");
    field.className = "ck-custom";
    field.dataset.ckFocus = "custom:" + o.id;
    field.placeholder = o.label + "…";
    field.setAttribute("aria-label", o.label);
    field.maxLength = 2000;
    field.value = p.custom;
    if (v.busy) field.readOnly = true;
    const send = button("ask-send", null, () => submit(), "send:" + o.id);
    send.setAttribute("aria-label", "发送：" + o.label);
    send.append(icon(v.sending.includes(o.id) ? "spinner" : "send"));
    if (v.busy) send.setAttribute("aria-disabled", "true");
    const submit = () => {
      const text = field.value.trim();
      if (!text || v.busy) return;
      choose(key, fact, [o.id], text);
    };
    field.addEventListener("input", () => { p.custom = field.value; row.classList.toggle("typing", !!field.value.trim()); });
    field.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      submit();
    });
    row.append(badge, field, send);
    return row;
  }
  // A pick in flight, or one the server says was already answered: nothing more is taken.
  const closed = (p) => p.phase === "sending" || p.phase === "recording" || p.phase === "conflict";
  function toggle(key, id) {
    const p = pickOf(key);
    if (closed(p)) return;
    const at = p.picks.indexOf(id);
    if (at >= 0) p.picks.splice(at, 1);
    else {
      const fact = S.facts.get("choice:" + key);
      if (fact && fact.block.max && p.picks.length >= fact.block.max) return;
      p.picks.push(id);
    }
    if (p.phase !== "idle" && p.phase !== "recorded") { p.phase = "idle"; p.error = null; }
    repaint();
  }
  // A pick: the chat message first (the normal send path), then its record
  // on the native block. Each step says how it went.
  async function choose(key, fact, ids, custom) {
    const b = fact.block, p = pickOf(key);
    if (!R.canPick(b, ids) || closed(p)) return;
    const text = R.choiceMessage(b, ids, custom);
    Object.assign(p, { phase: "sending", ids: ids.slice(), text, error: null });
    repaint();
    // The conversation the block belongs to, as it was when the pick was made.
    const where = { sel: S.sel, threadId: S.threadId, pick: p };
    let went = false;
    // Recorded as soon as the server took the message, not after its reply.
    try { await H.send(text, () => { went = true; record(key, fact, ids, text, where); }); } catch (e) { /* the send path said why */ }
    if (!went) { p.phase = "unsent"; repaint(); }
  }
  async function record(key, fact, ids, text, where = { sel: S.sel, threadId: S.threadId }) {
    const p = where.pick || pickOf(key), sel = where.sel, threadId = where.threadId, gen = S.gen;
    if (!sel || !threadId) { Object.assign(p, { phase: "unrecorded", error: { text: "对话还没读到" } }); repaint(); return; }
    Object.assign(p, { phase: "recording", ids: ids.slice(), text });
    repaint();
    let res = null, data = {};
    try {
      res = await H.apiFetch(scopeOf(sel) + "/messages/" + enc(fact.mid) + "/blocks/" + enc(fact.block.id) + "/answer", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedIds: ids, expectedThreadId: threadId }),
      }, true);
      const body = await res.text();
      try { data = body ? JSON.parse(body) : {}; } catch (e) { data = {}; }
    } catch (e) {
      Object.assign(p, { phase: "unrecorded", error: { text: "连不上 clowder-bot" } });
      if (gen === S.gen) repaint();
      return;
    }
    if (res.ok && data && data.answered === true) {
      Object.assign(p, { phase: "recorded", selected: Array.isArray(data.selected) ? data.selected.map(String) : ids.slice(), error: null });
      announce("已记下这次选择");
    } else if (res.status === 409 && !/会话|对话/.test(String(data && data.error || ""))) {
      // Already answered: nothing is offered again on this page (another
      // pick would only send another message). The conversation is read
      // again; the block shows its record once a read of its message has it
      // (a block on an earlier page keeps saying it was answered).
      Object.assign(p, { phase: "conflict", error: R.failure(data, "这个选项已经回答过了") });
      if (H.reload) H.reload();
    } else if (res.status === 409 || res.status === 400) {
      // Not a valid pick, or the conversation moved: the server's own sentence; the pick stays open.
      Object.assign(p, { phase: "refused", error: R.failure(data, "这次选择没有被接受") });
      if (res.status === 409 && H.reload) H.reload();
    } else {
      Object.assign(p, { phase: "unrecorded", error: R.failure(data, "暂时没能记下") });
    }
    if (gen === S.gen) repaint();
  }

  // -------------------------------------------------------------------- init
  // Hooks from app.js:
  //   api(path), apiFetch(path, opt, keepServerWords) the shell's requests;
  //   icon(name, extra)   the shell's icons;
  //   render(el, text)    Markdown as a reply's words are drawn;
  //   send(text, sent)    the normal send path (sent() once the server took it);
  //   reload()            read the open conversation again;
  //   thread              the history's scroll box (#thread).
  function init(hooks) {
    H = hooks;
    // Which frame has focus, so a redraw that replaced its row can give it back.
    document.addEventListener("focusin", (ev) => {
      const t = ev.target;
      const host = t && t.closest ? t.closest(".ck-live") : null;
      S.focus = host ? { kind: host.dataset.ck, key: host.dataset.ckKey, part: (t.dataset && t.dataset.ckFocus) || "card" } : null;
    });
    // A press anywhere else means the owner moved on: nothing is given back then.
    document.addEventListener("pointerdown", (ev) => {
      const t = ev.target;
      if (!(t && t.closest && t.closest(".ck-live"))) S.focus = null;
    }, true);
  }

  window.ClowderCards = Object.freeze({
    init, select, observe, words, blocks, ending, notice, rendered, find, locateSoon,
    // For tests and diagnostics only: what this page holds, never a record.
    peek: () => ({ list: [...S.list.keys()], listState: S.listState, decisions: [...decisions].map(([id, d]) => ({ id, ...d })) }),
  });
})();
