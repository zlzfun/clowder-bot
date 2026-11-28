// What a cat attaches to a reply, asks the owner to confirm, or leaves
// unfinished, drawn in the chat itself (classic script, window.ClowderCards).
// Loads after chat-cards-rules.js and before app.js, which calls init() once
// and then:
//   select()   when the conversation changes;
//   observe()  after each transcript or group read: the conversation's open
//              requests (GET <scope>/approvals) are read alongside;
//   words()    for the words a reply shows (a request's message and an ended
//              reply's stand-in words are not shown as words);
//   blocks()   to add a reply's cards, checklists, choices, diffs, pictures and
//              voice messages under its words;
//   ending()   to add how an unfinished reply ended (详情, 再发一次);
//   notice()   for a receipt or refusal line (a row with notice: true);
//   rendered() right after the history was committed (ClowderLive.commit);
//   find()     (去确认) the request's card when it is drawn: true / false;
//   locate()   the same when it may be on an earlier page: a promise.
//
// An F306 request (a question, an approval with the engine's own choices, a
// link to open or a form to fill, a cat's own choice) is answered in its
// card; what the owner picked or typed is a draft that every read and redraw
// keeps until the server took the answer.
//
// Request cards and choices are drawn into a stable empty frame (.ck-live)
// that is part of the row's markup; what they show (the open list, the
// owner's answer in flight) is filled in after the commit. So a row whose
// message did not change keeps its element and never rises in again, and a
// card changes in place, keeping focus.
//
// Nothing here is a record or a runtime: requests, their lifecycle and their
// effect stay native; a pick is an ordinary chat message sent through the
// normal send path, then recorded on the native block, except an option that
// does what it says (F155 option.action), which the server carries out and
// records itself. Every outcome shown is the server's own: an answer in
// flight is never shown as done.
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
    // How requests ended by evidence other than their own row, for this
    // conversation's thread: the engine's receipts on any page held here
    // (by request), and the list's settled read (?ids=) or an answer's own
    // verified reply. The cards on the page still without an outcome of
    // their own ({id, mid}), from the latest read.
    receipts: new Map(), settled: new Map(), cards: [],
  };
  // Requests as this page last listed them (their words once settled), and
  // the owner's answers from this page: kept for the page's life, by request.
  const seen = new Map();
  const decisions = new Map();
  // Picks in progress, by conversation, message and block.
  const picks = new Map();
  // What the owner has picked, typed or skipped in an F306 request's card,
  // by conversation and request: kept across every read and redraw until the
  // answer is in (a redraw draws from it; typing never redraws).
  const drafts = new Map();
  // Reads of the conversation seen (observe), counted for the page's life.
  let observed = 0;
  // Each card found and each lookup begun (find, locate): a lookup reading
  // earlier pages gave way when this moved on before it ended.
  let seeking = 0;

  function select(sel) {
    S.gen++;
    Object.assign(S, {
      sel: sel && sel.id ? { type: sel.type === "group" ? "group" : "bot", id: String(sel.id) } : null,
      threadId: "", list: new Map(), listState: "idle", listAt: 0, listSig: "", listDone: 0, listLoading: false, listAgain: false, focus: null,
      receipts: new Map(), settled: new Map(), cards: [],
    });
    S.key = keyOf(S.sel);
    S.facts.clear();
    if (S.locate && S.locate.key !== S.key) S.locate = null;
  }

  // How a request ended when its own row does not say: a receipt on another
  // page held here (one that names another message is not this card's), the
  // list's settled read, or the answer's own verified reply. null: unknown.
  function resolvedOf(id, mid) {
    const r = S.receipts.get(id);
    if (r && (!r.card || !mid || r.card === mid)) return r;
    const d = decisions.get(id);
    return S.settled.get(id) || (d && d.resolved) || null;
  }
  // The requests to ask the server about by ID (?ids=): cards without an
  // outcome on an earlier page than the newest (their receipt may be on no
  // page held, or never sent: an F306 request that ended by itself), and the
  // ones answered from here. The newest page's open requests are listed anyway.
  // All of them: a read takes at most ASK_MAX (the server's limit), so
  // loadList asks for more in several reads.
  const ASK_MAX = 50;
  function asked() {
    const latest = H && typeof H.latest === "function" ? H.latest() : null;
    const out = [];
    for (const c of S.cards) {
      if (out.includes(c.id) || resolvedOf(c.id, c.mid)) continue;
      const d = decisions.get(c.id);
      if ((latest && c.mid && !latest.has(c.mid)) || (d && d.phase === "sent")) out.push(c.id);
    }
    return out;
  }

  // After each read of the open conversation: its thread, the engine's
  // receipts on every page held, and the request cards still without an
  // outcome. The open list is read when the set of those cards, the IDs to
  // ask about or the count of waiting requests changed, and again now and
  // then while any is waiting.
  function observe(sel, threadId, messages) {
    if (!S.sel || keyOf(sel) !== S.key) return;
    const id = threadId ? String(threadId) : "";
    if (id && id !== S.threadId) Object.assign(S, { threadId: id, list: new Map(), listState: "idle", listAt: 0, listSig: "", listDone: 0, receipts: new Map(), settled: new Map(), cards: [] });
    observed++;
    const cards = [];
    for (const m of messages || []) {
      const r = R.receiptOf(m);
      if (r) S.receipts.set(r.id, r);
      const mid = String((m && (m.native_message_id || m.id)) || "");
      for (const b of m && Array.isArray(m.blocks) ? m.blocks : []) {
        if (b && b.kind === "card" && b.approval && typeof b.approval.id === "string" && b.approval.id && !b.approval.state) cards.push({ id: b.approval.id, mid });
      }
    }
    S.cards = cards;
    const open = cards.filter((c) => !resolvedOf(c.id, c.mid)).map((c) => c.id);
    if (open.length && S.threadId) {
      const X = window.ClowderExperience;
      const a = X && typeof X.activity === "function" ? X.activity() : null;
      const waiting = a && a.threadId === S.threadId ? a.counts.approval : -1;
      const sig = JSON.stringify([S.threadId, open, waiting, asked()]);
      if (sig !== S.listSig || Date.now() - S.listAt > 15000) { S.listSig = sig; loadList(); }
    }
    // A frame whose view changed with the time (a request close to running out) or with a receipt.
    repaint();
  }

  async function loadList() {
    if (!S.sel || !S.threadId) return;
    if (S.listLoading) { S.listAgain = true; return; }
    const gen = S.gen, req = ++S.listReq, threadId = S.threadId, askedAt = Date.now();
    S.listLoading = true;
    if (S.listState === "idle") S.listState = "loading";
    try {
      // The IDs to ask about, ASK_MAX a read, one read after another (one
      // read when there are none); nothing is taken until every read came back.
      const ids = asked(), scope = scopeOf(S.sel), parts = [];
      for (let k = 0; k < ids.length; k += ASK_MAX) parts.push(ids.slice(k, k + ASK_MAX));
      if (!parts.length) parts.push([]);
      const list = new Map(), settled = [];
      for (let k = 0; k < parts.length; k++) {
        const part = parts[k];
        const got = R.approvals(await H.api(scope + "/approvals" + (part.length ? "?ids=" + part.map(enc).join(",") : "")));
        if (gen !== S.gen || req !== S.listReq || threadId !== S.threadId) return;
        if (!got) throw Object.assign(new Error("bad answer"), { status: 0 });
        // Another thread's requests never show here; the next read asks again.
        if (got.threadId && got.threadId !== S.threadId) { S.listSig = ""; return; }
        // The open list as the last read gives it; a request asked about by ID as the read that asked about it.
        const last = k === parts.length - 1;
        for (const i of got.list) if (last || part.includes(i.id)) list.set(i.id, i);
        settled.push(...got.settled);
      }
      S.list = list;
      for (const i of list.values()) seen.set(i.id, i);
      // How the requests asked about by ID ended, as the engine records them.
      for (const s of settled) S.settled.set(s.id, { state: s.state, selected: s.selected });
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
    if (b.kind === "gallery") return galleryBlock(b);
    if (b.kind === "audio") return audioBlock(b);
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
  // Pictures the cat attached: one in its own proportions, two or more two
  // to a row, each with its caption under it; a press opens the shell's own
  // viewer on that picture, with the rest of the gallery (H.openImages). A
  // picture that does not load says so in its place. null when the block is
  // not what the contract says (counted as one that cannot be shown).
  function galleryBlock(b) {
    const items = R.galleryItems(b);
    if (!items) return null;
    const card = node("div", "ck-card ck-gallery");
    if (b.title) card.append(node("div", "ck-card-title", b.title));
    const grid = node("div", "ck-gallery-grid" + (items.length === 1 ? " ck-gallery-one" : ""));
    const urls = items.map((it) => it.url);
    items.forEach((it, i) => {
      const btn = button("ck-gallery-btn", null, () => { if (H && typeof H.openImages === "function") H.openImages(urls, i, btn); });
      const said = it.alt || it.caption;
      btn.setAttribute("aria-label", "查看图片" + (said ? "：" + said : items.length > 1 ? "：第 " + (i + 1) + " 张" : ""));
      const img = document.createElement("img");
      img.className = "ck-gallery-img";
      img.setAttribute("alt", said || "图片");
      img.setAttribute("loading", "lazy");
      img.addEventListener("error", () => {
        img.replaceWith(node("span", "ck-gallery-broken", "图片暂时无法显示"));
        btn.classList.add("broken");
        btn.setAttribute("aria-disabled", "true");
        btn.setAttribute("aria-label", "图片暂时无法显示" + (said ? "：" + said : ""));
      });
      img.src = it.url;
      btn.append(img);
      if (it.caption) btn.append(node("span", "ck-gallery-cap", it.caption));
      grid.append(btn);
    });
    card.append(grid);
    return card;
  }
  // A voice message: its title and length, the browser's own player, and
  // what it says (the words, when the cat gave them). An address that is not
  // one the server projected is not played (the block cannot be shown).
  function audioBlock(b) {
    const url = R.mediaUrl(b.url), said = typeof b.text === "string" ? b.text.trim() : "";
    if (typeof b.url === "string" && b.url.trim() && !url) return null;
    if (!url && !said) return null;
    const card = node("div", "ck-card ck-audio");
    const title = R.oneLine(b.title), length = R.duration(b.durationSec);
    if (title || length) {
      const head = node("div", "ck-card-head");
      if (title) head.append(node("div", "ck-card-title", title));
      if (length) head.append(node("span", "ck-audio-dur", length));
      card.append(head);
    }
    if (url) {
      const player = document.createElement("audio");
      player.className = "ck-audio-player";
      player.setAttribute("controls", "");
      player.setAttribute("preload", "metadata");
      player.setAttribute("aria-label", title || "语音播放");
      player.src = url;
      card.append(player);
    }
    if (said) card.append(node("p", "ck-audio-text", said));
    return card;
  }

  // A receipt of the engine reworded, or a refusal said once by name: a quiet
  // centred line, not a bubble from a "系统" speaker. A reminder that came due
  // (reminder: true, 「提醒：…」) is a little more present: the alarm clock of
  // a schedule card before its words, on a soft pill; the cat's reply follows.
  // Work picked up again after a restart or after the computer slept
  // (continuation: "restart" | "sleep", 「刚才中断了，接着做。」) sits on the
  // same soft pill, with a turning arrow or a moon before its words.
  function notice(m, text) {
    const row = node("div", "sysline ck-notice" + (m.reminder ? " ck-reminder" : ""));
    const resumed = m.continuation === "restart" || m.continuation === "sleep" ? m.continuation : "";
    if (resumed && !m.reminder) { row.classList.add("ck-continuation"); row.dataset.continuation = resumed; }
    if (m.seq) row.dataset.seq = String(m.seq);
    const id = m.native_message_id || m.id;
    if (id) row.dataset.mid = String(id);
    if (m.time) row.dataset.time = String(m.time);
    if (m.reminder) row.append(icon("alarm-clock"));
    else if (resumed) row.append(icon(resumed === "sleep" ? "moon" : "refresh-cw"));
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
    // A field being typed in keeps its caret when its card is drawn again (what was typed is in the draft).
    let caret = null;
    try { if (part && a && typeof a.selectionStart === "number") caret = [a.selectionStart, a.selectionEnd]; } catch (e) { caret = null; }
    // A card just found (去确认) and drawn again keeps its flash (its list read can land right after).
    const hit = !!host.querySelector(".ck-hit");
    host._ckSig = sig;
    host.replaceChildren(kind === "approval" ? approvalCard(key, fact, view) : choiceCard(key, fact, view));
    if (part) refocus(host, part);
    const again = hit ? host.querySelector(".approval, .approval-line") : null;
    if (again) { again.classList.add("ck-hit"); setTimeout(() => again.classList.remove("ck-hit"), 1500); }
    const now = document.activeElement;
    if (caret && now && now !== a && host.contains(now) && typeof now.setSelectionRange === "function") {
      try { now.setSelectionRange(caret[0], caret[1]); } catch (e) { /* a field without a caret (a number) */ }
    }
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
      resolved: resolvedOf(id, fact.mid),
      // reloaded: the conversation's read asked for after the answer came back too (and was seen).
      reloaded: !!local && local.phase === "sent" && local.reread === true && observed > (local.obs || 0),
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
    // An F306 request is answered in the card: its questions, form or link,
    // drawn from the draft; a check that fails says why just above the actions.
    if (v.prompt) {
      const d = draftOf(id);
      const said = node("p", "ck-note ck-bad ck-invalid", d.invalid);
      said.setAttribute("role", "alert");
      said.hidden = !d.invalid;
      const clear = () => { if (!d.invalid) return; d.invalid = ""; said.textContent = ""; said.hidden = true; };
      const box = promptBox(id, v, d, clear);
      if (box) card.append(box);
      card.append(said);
    }
    const actions = node("div", "approval-actions");
    if (v.waiting || v.expiry) {
      const t = node("span", "approval-timer ck-when");
      if (v.expiry) t.append(icon("clock"));
      t.append(node("span", "", v.waiting || v.expiry));
      actions.append(t);
    }
    for (const a of v.actions) {
      const busy = v.busy === a.decision;
      const b = button(a.primary || a.decision === "approve" ? "primary" : "secondary", null, () => decide(id, a.decision), "act:" + a.decision);
      if (a.description) b.title = a.description;
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
  // ------------------------------------------------ answering in the card
  // An F306 request's own controls. Each is drawn once from the draft; a
  // pick, a keystroke or a skip changes the draft and the controls in place
  // (sync), never the card's view, so nothing is redrawn while the owner
  // types and focus stays where it is. A redraw (the list read again, an
  // answer in flight) draws them again from the same draft.
  const draftKey = (id) => S.key + "|" + id;
  function draftOf(id) {
    const k = draftKey(id);
    let d = drafts.get(k);
    if (!d) { d = { answers: {}, fields: {}, picks: [], custom: "", text: "", invalid: "", op: "", opFor: "", opRev: 0 }; drafts.set(k, d); }
    return d;
  }
  function promptBox(id, v, d, clear) {
    const p = v.prompt, busy = !!v.busy;
    const box = node("div", "ck-rt");
    if (p.kind === "question") for (const q of p.questions) box.append(questionPart(id, q, v, d, clear, p.questions.length > 1));
    else if (p.kind === "elicitation" && p.mode === "url") box.append(webLink(p.url));
    else if (p.kind === "elicitation" && p.mode === "form") for (const f of p.fields) box.append(formField(f, d, busy, clear));
    else if (p.kind === "conversation" && p.mode !== "confirm") conversationPart(box, id, p, v, d, clear);
    return box.childNodes.length ? box : null;
  }
  // An option the owner picks (XBot's .ask-opt): its letter, or a tick once picked.
  function optionButton(text, description, i, focus, onClick) {
    const b = button("ask-opt", null, onClick, focus);
    const badge = node("span", "opt-badge");
    const t = node("span", "opt-t");
    t.append(node("span", "ck-opt-label", text));
    if (description) t.append(node("span", "ck-opt-desc", description));
    b.append(badge, t);
    b._ckMark = (on, off) => {
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      badge.classList.toggle("on", on);
      badge.replaceChildren(on ? icon("check") : String.fromCharCode(65 + (i % 26)));
      if (off) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
    };
    return b;
  }
  // Up and down move between a list's options. In a grid of options, left
  // and right move to the one before or after (round the ends), up and down
  // to the one above or below in the same column (at the top or bottom row
  // focus stays); the columns are read from where the options are laid out.
  function arrows(list, grid) {
    list.addEventListener("keydown", (ev) => {
      const across = ev.key === "ArrowLeft" || ev.key === "ArrowRight";
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && !(grid && across)) return;
      const items = [...list.querySelectorAll("button.ask-opt")];
      const at = items.indexOf(document.activeElement);
      if (at < 0) return;
      ev.preventDefault();
      const n = items.length;
      let to;
      if (!grid) to = (at + (ev.key === "ArrowDown" ? 1 : n - 1)) % n;
      else if (across) to = (at + (ev.key === "ArrowRight" ? 1 : n - 1)) % n;
      else to = at + (ev.key === "ArrowDown" ? 1 : -1) * columns(items);
      if (to >= 0 && to < n) items[to].focus();
    });
  }
  // How many options a grid's first row holds (those level with the first).
  function columns(items) {
    const top = (b) => b.getBoundingClientRect().top;
    const first = top(items[0]);
    let n = 1;
    while (n < items.length && Math.abs(top(items[n]) - first) < 1) n++;
    return n;
  }
  function field(cls, focus, type) {
    const f = document.createElement("input");
    f.className = cls;
    f.type = type || "text";
    f.dataset.ckFocus = focus;
    return f;
  }
  // Enter in a field answers, as a pick's own field does.
  function enterAnswers(f, id) {
    f.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      decide(id, "submit");
    });
  }

  // One question: its words (one question's own words are the card's), its
  // options, the owner's own answer (其他, or the only way to answer), and
  // 跳过 where it may be left unanswered. A secret answer is typed hidden and
  // never said back.
  function questionPart(id, q, v, d, clear, many) {
    const busy = !!v.busy, k = "q:" + q.id;
    const s = d.answers[q.id] || (d.answers[q.id] = { picks: [], text: "", skip: false });
    const g = node("div", "ck-q");
    g.setAttribute("role", "group");
    const said = R.oneLine(q.question);
    g.setAttribute("aria-label", said || q.header);
    if (many) {
      if (q.header && !said.includes(q.header)) g.append(node("div", "ck-q-head", q.header));
      g.append(node("div", "ck-q-text", q.question));
    } else if (said !== R.oneLine(v.body)) g.append(node("div", "ck-q-text", q.question));
    const btns = [];
    let list = null, own = null, other = null, skip = null;
    const sync = () => {
      btns.forEach((b, i) => b._ckMark(s.picks.includes(q.options[i].label), busy || s.skip));
      if (own) {
        own.disabled = s.skip;
        own.readOnly = busy;
        if (own.value !== s.text) own.value = s.text;
      }
      if (other) other.classList.toggle("typing", !!s.text.trim());
      if (skip) { skip.setAttribute("aria-pressed", String(s.skip)); skip.classList.toggle("on", s.skip); }
      g.classList.toggle("ck-skipped", s.skip);
    };
    if (q.options) {
      list = node("div", "ask-opts");
      list.setAttribute("role", "group");
      q.options.forEach((o, i) => {
        const b = optionButton(o.label, o.description, i, k + ":" + i, () => {
          if (busy || s.skip) return;
          if (q.multiSelect) {
            const at = s.picks.indexOf(o.label);
            if (at >= 0) s.picks.splice(at, 1); else s.picks.push(o.label);
          } else {
            // One answer: the pick takes the place of the owner's own words.
            s.picks = [o.label];
            s.text = "";
          }
          clear();
          sync();
        });
        btns.push(b);
        list.append(b);
      });
    }
    if (!q.options || q.isOther) {
      own = field(q.options ? "ck-other" : "ck-input", k + ":text", q.isSecret ? "password" : "text");
      own.setAttribute("autocomplete", q.isSecret ? "new-password" : "off");
      own.maxLength = 10000;
      own.placeholder = q.options ? "其他…" : "写下你的回答…";
      own.setAttribute("aria-label", q.options ? "其他：" + (said || q.header) : said || q.header);
      own.value = s.text;
      own.addEventListener("input", () => {
        s.text = own.value;
        // In a single choice the owner's own words take the place of a pick.
        if (q.options && !q.multiSelect && s.text.trim() && s.picks.length) s.picks = [];
        clear();
        sync();
      });
      enterAnswers(own, id);
      if (list) {
        other = node("div", "ask-opt other");
        const badge = node("span", "opt-badge ghost");
        badge.append(icon("pencil"));
        other.append(badge, own);
        list.append(other);
      }
    }
    if (list) { arrows(list); g.append(list); } else if (own) g.append(own);
    if (q.allowUnanswered) {
      skip = button("text-btn ck-link ck-skip", many ? "跳过这题" : "暂不回答", () => {
        if (busy) return;
        s.skip = !s.skip;
        // What is shown is what is sent: a skipped question keeps nothing.
        if (s.skip) { s.picks = []; s.text = ""; }
        clear();
        sync();
      }, k + ":skip");
      g.append(skip);
    }
    sync();
    return g;
  }

  // The page the cat asks the owner to open: only http(s), in a new tab,
  // with where it goes in sight.
  function webLink(url) {
    const row = node("div", "ck-weblink");
    const a = node("a", "ws-link ck-runtime", "打开链接");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = url;
    a.dataset.ckFocus = "url";
    row.append(a);
    const host = (/^https?:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(url) || [])[1] || "";
    if (host) {
      row.append(node("span", "ck-host", host));
      a.setAttribute("aria-label", "打开链接：" + host);
    }
    return row;
  }

  // One field of a form: a checkbox, a list, a number or words, from the
  // draft or else the field's default.
  function formField(f, d, busy, clear) {
    const name = f.title || f.id, k = "f:" + f.id;
    const value = Object.prototype.hasOwnProperty.call(d.fields, f.id) ? d.fields[f.id] : R.fieldDefault(f);
    const desc = f.description ? node("span", "ck-field-desc", f.description) : null;
    if (f.type === "boolean" && !f.enum) {
      const row = node("label", "ck-bool");
      const box = field("ck-check", k, "checkbox");
      box.checked = value === true;
      box.disabled = busy;
      box.addEventListener("change", () => { d.fields[f.id] = box.checked === true; clear(); });
      const t = node("span", "ck-bool-t");
      t.append(node("span", "ck-field-name", name));
      if (desc) t.append(desc);
      row.append(box, t);
      return row;
    }
    const wrap = node("label", "field ck-field");
    wrap.append(node("span", "ck-field-name", name));
    let control;
    if (f.enum) {
      control = document.createElement("select");
      control.dataset.ckFocus = k;
      if (!f.required || value === "") {
        const none = node("option", "", f.required ? "请选择" : "不填");
        none.value = "";
        control.append(none);
      }
      f.enum.forEach((x, i) => { const o = node("option", "", String(x)); o.value = String(i); control.append(o); });
      control.disabled = busy;
    } else {
      control = field("", k, f.type === "string" ? "text" : "number");
      if (f.type !== "string") {
        control.setAttribute("step", f.type === "integer" ? "1" : "any");
        if (f.minimum != null) control.setAttribute("min", String(f.minimum));
        if (f.maximum != null) control.setAttribute("max", String(f.maximum));
      } else if (f.maxLength) control.maxLength = f.maxLength;
      control.readOnly = busy;
    }
    control.value = String(value == null ? "" : value);
    const save = () => { d.fields[f.id] = control.value; clear(); };
    control.addEventListener("input", save);
    control.addEventListener("change", save);
    wrap.append(control);
    if (desc) wrap.append(desc);
    return wrap;
  }

  // A cat's own choice, answered here: its options (one, or up to max), the
  // 自定义 option's words once it is picked, and the owner's own reply in
  // place of a pick where the cat allows it.
  function conversationPart(box, id, p, v, d, clear) {
    const busy = !!v.busy, multiple = p.mode === "multiple";
    const list = node("div", "ask-opts");
    list.setAttribute("role", "group");
    const btns = [];
    let custom = null, own = null, limit = null;
    const picked = (o) => d.picks.includes(o.id);
    const sync = () => {
      const full = multiple && p.max > 0 && d.picks.length >= p.max;
      btns.forEach((b, i) => b._ckMark(picked(p.options[i]), busy || (full && !picked(p.options[i]))));
      const c = p.options.find((o) => o.custom && picked(o));
      if (custom) {
        custom.hidden = !c;
        custom.readOnly = busy;
        if (c) { custom.placeholder = c.label + "…"; custom.setAttribute("aria-label", c.label); }
        if (custom.value !== d.custom) custom.value = d.custom;
      }
      if (own) { own.readOnly = busy; if (own.value !== d.text) own.value = d.text; }
      if (limit) limit.classList.toggle("visually-hidden", !full);
    };
    p.options.forEach((o, i) => {
      const b = optionButton(R.optionText(o), o.description, i, "co:" + o.id, () => {
        if (busy) return;
        const at = d.picks.indexOf(o.id);
        if (!multiple) d.picks = [o.id];
        else if (at >= 0) d.picks.splice(at, 1);
        else if (!p.max || d.picks.length < p.max) d.picks.push(o.id);
        else return;
        // A pick is the answer: the owner's own reply in its place goes.
        d.text = "";
        clear();
        sync();
        if (o.custom && picked(o) && custom) custom.focus();
      });
      btns.push(b);
      list.append(b);
    });
    arrows(list);
    box.append(list);
    if (p.options.some((o) => o.custom)) {
      custom = field("ck-input", "co:custom");
      custom.maxLength = 2000;
      custom.value = d.custom;
      custom.addEventListener("input", () => { d.custom = custom.value; clear(); });
      enterAnswers(custom, id);
      box.append(custom);
    }
    if (p.allowText) {
      own = field("ck-input", "co:text");
      own.maxLength = 10000;
      own.placeholder = "写下你的回答…";
      own.setAttribute("aria-label", "你的回答");
      own.value = d.text;
      own.addEventListener("input", () => {
        d.text = own.value;
        // The owner's own reply is the answer in place of the options.
        if (d.text.trim() && d.picks.length) d.picks = [];
        clear();
        sync();
      });
      enterAnswers(own, id);
      box.append(own);
    }
    // Said once the limit is reached and the other options turn unavailable (as a choice block says it).
    if (multiple && p.max) { limit = node("p", "ck-note ck-limit", "最多选 " + p.max + " 项"); box.append(limit); }
    sync();
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

  // One submission's own ID: the same answer sent again (its reply was lost,
  // or the server could not finish it) is the same operation for the engine,
  // sent with the revision it first went with, since the engine may have
  // taken it and moved the request's revision on; a changed answer, or one
  // the server refused as it stands, is a new one.
  function operation() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    return "op-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  // The owner's answer: sent to the server, and shown as what it said back.
  // An F306 request's answer is built from its card (the draft) and checked
  // first; one that does not pass says why in the card and is not sent.
  async function decide(id, decision) {
    const sel = S.sel, threadId = S.threadId;
    const cur = decisions.get(id);
    if (!sel || !threadId || (cur && cur.phase === "sending")) return;
    const item = S.list.get(id) || null;
    const prompt = item && item.runtime && item.approve ? item.runtime : null;
    const draft = prompt ? draftOf(id) : null, key = draftKey(id);
    let body = { decision, expectedThreadId: threadId };
    if (prompt && decision !== "reject") {
      const built = R.runtimeResponse(prompt, decision, draft);
      if (!built.response) { invalid(id, built.invalid || "请检查你的回答"); return; }
      // Keyed on the answer alone: a newer revision read meanwhile does not make the same answer another operation.
      const sig = JSON.stringify(built.response);
      if (!draft.op || draft.opFor !== sig) Object.assign(draft, { op: operation(), opFor: sig, opRev: prompt.revision });
      body = { expectedThreadId: threadId, expectedRevision: draft.opRev || prompt.revision, operationId: draft.op, response: built.response };
    }
    if (draft) draft.invalid = "";
    const at = Date.now();
    decisions.set(id, { phase: "sending", decision, at });
    repaint();
    let res = null, data = {};
    try {
      res = await H.apiFetch(scopeOf(sel) + "/approvals/" + enc(id), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, true);
      const text = await res.text();
      try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
    } catch (e) {
      // Unknown whether it arrived: the same answer sent again keeps its operation ID.
      decisions.set(id, { phase: "error", decision, at, error: { text: "连不上 clowder-bot，不确定刚才的回答有没有送到；可以再点一次", detail: "" } });
      announce("没能提交");
      repaint();
      return;
    }
    if (res.ok) {
      const settled = data.settled === true ? true : data.settled === false ? false : null;
      // The engine's own terminal state, read back after the answer (F306): the outcome, not a guess.
      const resolved = settled === true && R.STATES.includes(data.state) ? { state: data.state, selected: R.labels(data.selected) } : null;
      // after: reads numbered above this one were asked for after the answer;
      // obs / reread: the conversation's reads seen by then, and whether the read asked for now came back.
      const entry = { phase: "sent", decision, at, settled, after: S.listReq, obs: observed, reread: false, ...(resolved ? { resolved } : {}) };
      decisions.set(id, entry);
      if (resolved && sel === S.sel) S.settled.set(id, resolved);
      // The answer is in: what was typed (a secret too) is not kept.
      if (draft) drafts.delete(key);
      const fact = S.facts.get("approval:" + id);
      const kind = (item && item.kind) || (fact && fact.block && fact.block.approval && fact.block.approval.kind) || "other";
      announce(resolved ? R.outcome(kind, resolved.state, item ? item.title : "") : settled === true ? "已提交" : settled === false ? "已提交，还在处理" : "已提交，没能确认结果");
      // The receipt and the request's new state come with the next reads.
      S.listSig = "";
      loadList();
      const back = H.reload ? H.reload() : null;
      Promise.resolve(back).then(() => {
        entry.reread = true;
        if (decisions.get(id) === entry) repaint();
      }, () => {});
    } else {
      const err = R.failure(data, decision === "reject" ? "没能提交，这件事仍在等你确认" : "没能提交，还没有生效");
      decisions.set(id, { phase: "error", decision, at, error: err });
      // Refused as it stands (not valid, not allowed, not open here): another
      // attempt is a new operation. Any other failure (it changed meanwhile,
      // the engine could not finish) may follow the engine taking it: the
      // same answer again keeps its operation ID and revision.
      if (draft && (res.status === 400 || res.status === 403 || res.status === 404)) Object.assign(draft, { op: "", opFor: "", opRev: 0 });
      announce(err.text);
      // Already answered, not here, or changed since it was read: the list says so (a request's new revision too); another conversation: read again.
      if (res.status === 404 || res.status === 409) { S.listSig = ""; loadList(); }
      if (res.status === 409 && H.reload) H.reload();
    }
    repaint();
  }
  // A check of the answer that did not pass: said in the card, in place.
  function invalid(id, text) {
    const d = draftOf(id);
    d.invalid = text;
    const host = frameOf("approval", id);
    const said = host && host.querySelector(".ck-invalid");
    if (said) { said.textContent = text; said.hidden = !text; }
  }

  // The status line's 去确认 and a clicked notification: the card in the
  // history, scrolled to, flashed and focused. false: not in what is drawn.
  // Found, it ends any lookup still reading earlier pages (H.cancelLocate),
  // so that one never takes the scroll, the focus or the note afterwards.
  function find(item) {
    if (!item) return false;
    let host = item.proposalId ? frameOf("approval", String(item.proposalId)) : null;
    if (!host && item.messageId) {
      const row = H && H.thread ? [...H.thread.querySelectorAll("[data-mid]")].find((r) => r.dataset.mid === item.messageId) : null;
      host = row ? row.querySelector(".ck-live.ck-approval") : null;
    }
    const card = host && (host.querySelector(".approval, .approval-line") || host);
    if (!card) return false;
    seeking++;
    if (H && typeof H.cancelLocate === "function") H.cancelLocate();
    card.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    card.classList.remove("ck-hit");
    void card.offsetWidth;
    card.classList.add("ck-hit");
    setTimeout(() => card.classList.remove("ck-hit"), 1500);
    card.focus({ preventScroll: true });
    return true;
  }
  // The same when the card may be further back than the history drawn: its
  // message is looked for on earlier pages (H.locate: chat-locate.js, a
  // bounded number of pages, each waited for until drawn, with its own quiet
  // note), and once found the card itself is scrolled to, flashed and
  // focused. Resolves to true, or to false / null when it is not found
  // (null: the search said why) or cannot be looked for, or to undefined when
  // it gave way before it ended (a card found where it is drawn, a newer
  // 去确认, or anything that ended the search itself: a search of the
  // palette, a quote's jump, another chat): then there is nothing to say about it.
  async function locate(item) {
    if (find(item)) return true;
    if (!item || !item.messageId || !H || typeof H.locate !== "function") return false;
    const key = S.key, op = ++seeking;
    let got = null, cancelled = false;
    try { got = await H.locate(item, () => { cancelled = true; }); } catch (e) { got = null; }
    if (cancelled || op !== seeking) return undefined;
    if (got !== true) return got === false ? false : null;
    if (key === S.key) { repaint(); find(item); }
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
    if (!p) { p = { phase: "idle", via: "", picks: [], custom: "", ids: [], text: "", selected: [], error: null }; picks.set(k, p); }
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
    // An option that does what it says goes to the action route (act); any other is a chat message (choose).
    const pick = (o, custom) => (R.isCallbackOption(o) ? act(key, fact, o, custom) : choose(key, fact, [o.id], custom));
    const working = v.acting ? "正在提交…" : "正在发送…";
    if (b.mode === "confirm") {
      const [yes, no] = b.options;
      // An answer that does what it says and takes the owner's words (F155:
      // a note to go with it) has an optional field above the answers; its
      // words go with that answer only, and an empty field is fine.
      const noted = [yes, no].find((o) => o && o.custom && R.isCallbackOption(o)) || null;
      if (noted) card.append(confirmNote(noted, v, p, () => pick(noted, p.custom.trim())));
      const row = node("div", "approval-actions ck-confirm");
      for (const o of [no, yes]) {
        if (!o) continue;
        const btn = button(o === yes ? "primary" : "secondary", null, () => pick(o, o === noted ? p.custom.trim() : ""), "opt:" + o.id);
        if (v.sending.includes(o.id)) { btn.append(icon("spinner", "approval-spinner"), document.createTextNode(working)); btn.setAttribute("aria-busy", "true"); }
        else btn.textContent = R.optionText(o);
        if (v.busy) btn.setAttribute("aria-disabled", "true");
        row.append(btn);
      }
      card.append(row);
    } else {
      const multiple = b.mode === "multiple", grid = b.layout === "grid";
      // card-grid: the same options as cards side by side.
      const list = node("div", "ask-opts" + (grid ? " ck-opts-grid" : ""));
      list.setAttribute("role", "group");
      b.options.forEach((o, i) => {
        if (o.custom && !multiple) { list.append(customRow(key, fact, o, v, p)); return; }
        const on = multiple && v.picks.includes(o.id);
        const btn = button("ask-opt" + (on ? " on" : ""), null, () => {
          if (multiple) toggle(key, o.id);
          else pick(o);
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
      arrows(list, grid);
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
  // One that does what it says takes the words as a note that may be left
  // empty, so its button is always ready.
  function customRow(key, fact, o, v, p) {
    const acts = R.isCallbackOption(o);
    const row = node("div", "ask-opt other" + (acts ? " ck-acts" : "") + (p.custom.trim() ? " typing" : ""));
    const badge = node("span", "opt-badge ghost");
    badge.append(icon("pencil"));
    const field = document.createElement("input");
    field.className = "ck-custom";
    field.dataset.ckFocus = "custom:" + o.id;
    field.placeholder = o.customPlaceholder || o.label + "…";
    field.setAttribute("aria-label", o.label);
    field.maxLength = 2000;
    field.value = p.custom;
    if (v.busy) field.readOnly = true;
    const send = button("ask-send", null, () => submit(), "send:" + o.id);
    send.setAttribute("aria-label", (acts ? "提交：" : "发送：") + o.label);
    send.append(icon(v.sending.includes(o.id) ? "spinner" : "send"));
    if (v.busy) send.setAttribute("aria-disabled", "true");
    const submit = () => {
      const text = field.value.trim();
      if (v.busy) return;
      if (acts) { act(key, fact, o, text); return; }
      if (!text) return;
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
  // The optional note that goes with a confirmation's answer that does what
  // it says (its placeholder is the cat's own, else 补充说明（可选）). What is
  // typed is kept with the pick across redraws; Enter gives that answer.
  function confirmNote(o, v, p, submit) {
    const f = document.createElement("input");
    f.className = "ck-input ck-confirm-note";
    f.type = "text";
    f.dataset.ckFocus = "note:" + o.id;
    f.placeholder = o.customPlaceholder || "补充说明（可选）";
    f.setAttribute("aria-label", f.placeholder);
    f.maxLength = 2000;
    f.value = p.custom;
    if (v.busy) f.readOnly = true;
    f.addEventListener("input", () => { p.custom = f.value; });
    f.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      if (!v.busy) submit();
    });
    return f;
  }
  // A pick in flight, one the server says was already answered, or one whose
  // action took effect without being recorded: nothing more is taken.
  const closed = (p) => p.phase === "sending" || p.phase === "recording" || p.phase === "conflict" || p.phase === "applied";
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
    Object.assign(p, { phase: "sending", via: "", ids: ids.slice(), text, error: null });
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
    } else if (res.status === 409 && data && data.code === "already_answered") {
      // Already answered (the server's own code, not its sentence): nothing
      // is offered again on this page (another pick would only send another
      // message). The conversation is read again; the block shows its record
      // once a read of its message has it (a block on an earlier page keeps
      // saying it was answered).
      Object.assign(p, { phase: "conflict", error: R.failure(data, "这个选项已经回答过了") });
      if (H.reload) H.reload();
    } else if (res.status === 409 || res.status === 400) {
      // Not a valid pick, the conversation moved, or any other 409: the server's own sentence; the pick stays open.
      Object.assign(p, { phase: "refused", error: R.failure(data, "这次选择没有被接受") });
      if (res.status === 409 && H.reload) H.reload();
    } else {
      Object.assign(p, { phase: "unrecorded", error: R.failure(data, "暂时没能记下") });
    }
    if (gen === S.gen) repaint();
  }
  // An option that does what it says (upstream F155 option.action, which the
  // server allows only for a short list of the engine's own actions): no chat
  // message goes out. The server reads the action from the cat's own message,
  // carries it out and records the pick on the block (POST …/blocks/:id/action
  // {optionId, customInput?, expectedThreadId}). Only its answer says how it
  // went: done and recorded; already answered (409 code already_answered:
  // nothing offered again; any other 409 is the engine's own refusal);
  // done but not recorded (502 callbackApplied: not offered again either,
  // since another press would do it twice); or not done, in its own words,
  // and it can be tried again.
  async function act(key, fact, o, custom) {
    const b = fact.block, p = pickOf(key);
    if (!R.canPick(b, [o.id]) || closed(p)) return;
    const sel = S.sel, threadId = S.threadId, gen = S.gen;
    if (!sel || !threadId) { Object.assign(p, { phase: "refused", via: "action", ids: [o.id], text: "", error: { text: "对话还没读到", detail: "" } }); repaint(); return; }
    Object.assign(p, { phase: "sending", via: "action", ids: [o.id], text: "", error: null });
    repaint();
    let res = null, data = {};
    try {
      res = await H.apiFetch(scopeOf(sel) + "/messages/" + enc(fact.mid) + "/blocks/" + enc(b.id) + "/action", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId: o.id, ...(custom ? { customInput: custom } : {}), expectedThreadId: threadId }),
      }, true);
      const body = await res.text();
      try { data = body ? JSON.parse(body) : {}; } catch (e) { data = {}; }
    } catch (e) {
      // Not known whether it took effect: the conversation is read again, so its record shows if it did.
      Object.assign(p, { phase: "refused", error: { text: "连不上 clowder-bot，不确定刚才的操作有没有生效", detail: "" } });
      if (H.reload) H.reload();
      if (gen === S.gen) repaint();
      return;
    }
    if (res.ok && data && data.answered === true) {
      Object.assign(p, { phase: "recorded", selected: Array.isArray(data.selected) ? data.selected.map(String) : [o.id], error: null });
      announce("已处理");
    } else if (res.status === 502 && data && data.callbackApplied === true) {
      Object.assign(p, { phase: "applied", error: R.failure(data, "已经生效，但没能记下这次选择") });
      if (H.reload) H.reload();
    } else if (res.status === 409 && data && data.code === "already_answered") {
      Object.assign(p, { phase: "conflict", error: R.failure(data, "这个选项已经回答过了") });
      if (H.reload) H.reload();
    } else {
      // Not done as it stands (400), the conversation moved (409 thread_changed),
      // the engine refused it as things stand (any other 409, e.g. a preview
      // that expired), or the engine could not do it: the server's own sentence.
      Object.assign(p, { phase: "refused", error: R.failure(data, "操作没有成功，可以再试一次") });
      if (res.status === 409 && H.reload) H.reload();
    }
    if (gen === S.gen) repaint();
  }

  // -------------------------------------------------------------------- init
  // Hooks from app.js:
  //   api(path), apiFetch(path, opt, keepServerWords) the shell's requests;
  //   icon(name, extra)   the shell's icons;
  //   render(el, text)    Markdown as a reply's words are drawn;
  //   send(text, sent)    the normal send path (sent() once the server took it);
  //   reload()            read the open conversation again (a promise of that read);
  //   locate(item, onCancel)  find a message on earlier pages (chat-locate.js
  //                       find: true, null when not found and said why, false;
  //                       onCancel() when that search ended quietly);
  //   cancelLocate()      end such a lookup under way (chat-locate.js cancel);
  //   latest()            the native message IDs of the newest page (chat-history.js);
  //   openImages(urls, index, trigger)  the shell's picture viewer (a gallery's pictures);
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
    init, select, observe, words, blocks, ending, notice, rendered, find, locate, locateSoon,
    // For tests and diagnostics only: what this page holds, never a record (drafts are not shown).
    peek: () => ({
      list: [...S.list.keys()], listState: S.listState, decisions: [...decisions].map(([id, d]) => ({ id, ...d })),
      receipts: [...S.receipts.keys()], settled: [...S.settled].map(([id, s]) => ({ id, ...s })),
    }),
  });
})();
