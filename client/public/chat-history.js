// A conversation over time (classic script, window.ClowderHistory): its
// earlier messages, a new conversation with the same cat, the saved ones,
// and the first words of a new one. Loads after chat-history-rules.js and
// before app.js, which calls init() once and then:
//   select(sel)          when the open chat changes;
//   merge(sel, thread, data)  with each newest-page read, before drawing: the
//                        earlier pages the owner scrolled back to stay above it;
//   top(inner)           while drawing the history: the quiet row at its top
//                        (更早的消息 / loading / 没有更早的消息了 / a failure);
//   starters(inner, read) while drawing a single chat: suggestions under the
//                        cat's greeting until the owner has said anything.
// The chat header gets a compact 更多 (⋯) menu: 新对话 and 历史对话 for a cat,
// 在对话里查找 when the search palette is there. newConversation(sel, opener)
// is the same 新对话 dialog for another entry (the drawer's 资料, profile.js).
//
// Every row still comes from the server and is drawn through the history's
// keyed redraw (ClowderLive.commit in app.js), so a row that did not change
// keeps its element. A new conversation is the existing native operation
// (POST /xbot-api/bots/:name/new); saved conversations are the existing list
// (workspace.js). Nothing here is a record: earlier pages are what this page
// last read, kept only while the same conversation stays open.
(() => {
  "use strict";
  const R = window.ClowderHistoryRules;
  let H = null;
  const SVG = "http://www.w3.org/2000/svg";
  const raf = (fn) => (typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));
  const kids = (n) => (n && n.children ? [...n.children] : []);
  const keyOf = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(body, cls) {
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    s.innerHTML = body;
    return s;
  }
  const ICON = {
    more: '<circle class="solid" cx="5" cy="12" r="1.5"/><circle class="solid" cx="12" cy="12" r="1.5"/><circle class="solid" cx="19" cy="12" r="1.5"/>',
    fresh: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
    past: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    find: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    spin: '<circle cx="12" cy="12" r="8.5" opacity=".22"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/>',
  };

  // ------------------------------------------------------- earlier messages
  // P: the open chat's earlier pages. held: rows above the newest page; was:
  // the newest page they are joined to; cursor/more: the page before the
  // oldest one held; latest: the newest page's own cursor; loaded: pages
  // fetched; state: idle | loading | failed | end.
  // drawn: how many of the loaded pages the last drawing of this history
  // included (chat-locate.js waits for a page to be on screen, not just read).
  const P = { key: "", thread: "", held: [], was: [], cursor: "", more: false, latest: { before: "", more: false },
    loaded: 0, drawn: 0, empty: 0, state: "idle", error: "", gen: 0 };
  // Earlier-page requests sent and failed, for the page's life (never reset):
  // a lookup counts what happened while it ran, whoever asked.
  let asked = 0, failures = 0;
  function reset(key) {
    Object.assign(P, { key, thread: "", held: [], was: [], cursor: "", more: false, latest: { before: "", more: false },
      loaded: 0, drawn: 0, empty: 0, state: "idle", error: "" });
    P.gen++;
    settleDrawn();
  }
  // Waiting for a drawing that includes `need` loaded pages of generation
  // `gen`: true once drawn, false when the history starts over or time runs out.
  let drawWaiters = [];
  function settleDrawn() {
    drawWaiters = drawWaiters.filter((w) => {
      if (w.gen !== P.gen) { w.done(false); return false; }
      if (P.drawn >= w.need) { w.done(true); return false; }
      return true;
    });
  }
  function whenDrawn(need, ms = 20000) {
    if (P.drawn >= need) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { need, gen: P.gen, done: (ok) => { clearTimeout(w.timer); resolve(ok); } };
      w.timer = setTimeout(() => { drawWaiters = drawWaiters.filter((x) => x !== w); resolve(false); }, ms);
      drawWaiters.push(w);
    });
  }
  const holding = () => P.held.length > 0 || P.loaded > 0;
  const nextCursor = () => (holding() ? (P.more ? P.cursor : "") : (P.latest.more ? P.latest.before : ""));

  // Each newest-page read: the rows to draw, earlier pages first.
  function merge(sel, threadId, data) {
    const key = keyOf(sel);
    const rows = data && Array.isArray(data.messages) ? data.messages : [];
    if (key !== P.key) reset(key);
    threadId = threadId ? String(threadId) : "";
    // Another conversation (a new one, or a saved one opened again): its own pages.
    if (threadId && P.thread && threadId !== P.thread) reset(key);
    if (threadId) P.thread = threadId;
    const before = data && typeof data.before === "string" ? data.before : "";
    // The native page boundary before and now: where the newest page shows no
    // rows to join on, it says whether the page still meets the rows held.
    const seam = { was: P.latest.before, now: before };
    P.latest = { before, more: !!(data && data.hasMore === true) && !!before };
    if (holding()) {
      const kept = R.stitch(P.held, P.was, rows, seam);
      // More than a page came in meanwhile: the earlier pages no longer meet
      // the newest one, so they go rather than show with a hole in them.
      if (kept === null) { reset(key); P.thread = threadId; P.latest = { before, more: !!(data && data.hasMore === true) && !!before }; }
      else P.held = kept;
    }
    P.was = rows;
    return P.held.length ? [...P.held, ...rows] : rows;
  }

  // The quiet row at the top of the history, or null when there is nothing
  // to say: no earlier page and none was loaded (a short chat says nothing).
  function view() {
    if (P.state === "loading") return { state: "loading" };
    if (P.state === "failed") return { state: "failed", error: P.error };
    if (nextCursor()) return { state: "idle" };
    return P.loaded > 0 ? { state: "end" } : null;
  }
  function fill(row, v) {
    row.dataset.older = v.state;
    row.replaceChildren();
    row.removeAttribute("role");
    if (v.state === "idle") {
      const b = node("button", "ch-older-btn", "查看更早的消息");
      b.type = "button";
      b.addEventListener("click", () => load());
      row.append(b);
    } else if (v.state === "loading") {
      row.setAttribute("role", "status");
      row.append(svg(ICON.spin, "ch-spin"), node("span", "", "正在加载更早的消息…"));
    } else if (v.state === "failed") {
      row.setAttribute("role", "alert");
      const b = node("button", "ch-older-btn", "重试");
      b.type = "button";
      b.addEventListener("click", () => load());
      row.append(node("span", "", "没能加载更早的消息" + (v.error ? "：" + v.error : "")), b);
    } else row.append(node("span", "visually-hidden", "没有更早的消息了")); // the oldest day separator on top says it (item 46)
  }
  // true when a row was drawn: an empty view then has earlier records to offer.
  function top(inner) {
    // Called while the history is drawn: every page loaded so far is in this
    // drawing, which goes on screen right after (ClowderLive.commit).
    if (inner) { P.drawn = P.loaded; Promise.resolve().then(settleDrawn); }
    const v = view();
    if (!v || !inner) return false;
    const row = node("div", "ch-older");
    fill(row, v);
    inner.prepend(row);
    return true;
  }
  // The open history's top row on screen.
  function onScreen() {
    const inner = kids(H && H.thread).find((c) => c.classList.contains("thread-inner") && c.dataset.chat === P.key);
    return inner ? kids(inner).find((c) => c.classList.contains("ch-older")) || null : null;
  }
  // The row changes in place (no redraw needed to show 正在加载 or a failure);
  // the history's keyed redraw is told so it reads the row again next time.
  function paintTop() {
    const row = onScreen(), v = view();
    if (!row || !v || row.dataset.older === v.state && (v.state !== "failed" || row.textContent.includes(v.error || ""))) return;
    const had = row.contains(document.activeElement);
    fill(row, v);
    if (window.ClowderLive && typeof window.ClowderLive.touched === "function") window.ClowderLive.touched(row);
    if (had) {
      const b = row.querySelector("button");
      if (b) b.focus({ preventScroll: true });
      else { row.tabIndex = -1; row.focus({ preventScroll: true }); }
    }
  }

  // The page before the oldest one shown. The redraw that follows (the
  // shell's own read of the newest page) puts it above, keeping the row the
  // owner is looking at where it was. A call while a page is on its way gets
  // that same page's promise (finding a message, chat-locate.js, waits on it).
  // opts.cap: no request is sent once this many earlier-page requests have
  // been sent in all (asked), the automatic reading through empty pages
  // included; a lookup gives its budget this way. Without it there is no cap.
  let job = null, cap = Infinity;
  function load(opts) {
    const limit = opts && Number.isFinite(opts.cap) ? opts.cap : Infinity;
    if (P.state === "loading" && job) { cap = Math.min(cap, limit); return job; }
    cap = limit;
    return (job = loadPage());
  }
  async function loadPage() {
    const sel = H && H.selected();
    const cursor = nextCursor();
    if (!sel || keyOf(sel) !== P.key || P.state === "loading" || !cursor || asked >= cap) return;
    const gen = P.gen;
    // The first earlier page belongs to the newest page as it was when asked
    // for (its cursor is that page's first message). Polls may move the newest
    // page on meanwhile; the answer is joined to that snapshot, and the next
    // newest-page read stitches from it, or starts over if they no longer meet.
    const base = holding() ? null : { rows: P.was.slice(), before: cursor };
    P.state = "loading";
    paintTop();
    asked++;
    try {
      const data = await H.api(R.pagePath(sel, cursor));
      if (gen !== P.gen) return;
      const page = R.page(data);
      if (!page) throw new Error("没有读到消息");
      // The cat moved to another conversation meanwhile: start over there.
      if (page.thread && P.thread && page.thread !== P.thread) { reset(P.key); H.reload(); return; }
      if (base) {
        P.held = R.prepend(page.rows, [], base.rows);
        P.was = base.rows;
        P.latest = { before: base.before, more: true };
      } else P.held = R.prepend(page.rows, P.held, P.was);
      P.cursor = page.before;
      P.more = page.more;
      P.loaded++;
      P.state = "idle";
      P.error = "";
      // A page whose records show no rows: the next one, a few times at most.
      P.empty = page.rows.length ? 0 : P.empty + 1;
      // The redraw puts the rows above and its top row says what is left;
      // if it could not redraw now (a send in flight), the row says it here.
      await H.reload();
      if (gen !== P.gen) return;
      paintTop();
      // Under the same cap as the request that led here.
      if (!page.rows.length && P.more && P.empty < 4 && P.state === "idle") job = loadPage();
    } catch (e) {
      failures++;
      if (gen !== P.gen) return;
      P.state = "failed";
      P.error = H.visibleError(e, "稍后再试").replace(/^没能完成：/, "").replace(/[。.]+$/, "");
      paintTop();
    }
  }
  // Scrolling up to the top asks for the page before.
  let looking = false;
  function watch() {
    const t = H.thread;
    if (!t || typeof t.addEventListener !== "function") return;
    t.addEventListener("scroll", () => {
      if (looking) return;
      looking = true;
      raf(() => {
        looking = false;
        if (P.state === "idle" && t.scrollTop < 240 && onScreen()) load();
      });
    }, { passive: true });
  }

  // --------------------------------------------------------------- starters
  function starters(inner, read) {
    const more = !!read && keyOf(read.selection) === P.key && (P.latest.more || holding());
    if (!inner || !R.showStarters(read, { busy: !!(H && H.sendBusy()), more })) return;
    const box = node("div", "starters ch-starters");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "可以这样开始");
    for (const text of R.STARTERS) {
      const b = node("button", "starter");
      b.type = "button";
      b.append(node("span", "", text));
      b.addEventListener("click", () => {
        if (!H || !H.selected() || H.selected().type !== "bot") return;
        box.remove();
        H.send(text);
      });
      box.append(b);
    }
    inner.append(box);
  }
  // The owner sent something: the suggestions are done (an Enter in an empty
  // composer sends nothing and leaves them).
  function dropStarters() {
    const typed = document.getElementById("input");
    if (!typed || !String(typed.textContent || "").trim()) return;
    const inner = kids(H && H.thread).find((c) => c.classList.contains("thread-inner"));
    for (const box of kids(inner)) if (box.classList.contains("ch-starters")) box.remove();
  }

  // ------------------------------------------------------------- the ⋯ menu
  let more = null, menu = null;
  const palette = () => (window.ClowderPalette && typeof window.ClowderPalette.open === "function" ? window.ClowderPalette : null);
  function items(sel) {
    const list = [];
    if (sel && sel.type === "bot") {
      list.push({ id: "new", label: "新对话", icon: ICON.fresh, run: () => newConversation(sel) });
      list.push({ id: "past", label: "历史对话", icon: ICON.past, run: () => pastConversations(sel) });
    }
    if (sel && palette()) list.push({ id: "find", label: "在对话里查找", icon: ICON.find, run: () => palette().open({ scope: { type: sel.type === "group" ? "group" : "bot", id: sel.id } }) });
    return list;
  }
  function mountMenu() {
    const bar = document.querySelector(".top-inner");
    if (!bar || more) return;
    more = node("button", "icon-btn ch-more");
    more.type = "button";
    more.setAttribute("aria-label", "更多");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.dataset.tip = "更多";
    more.hidden = true;
    more.append(svg(ICON.more));
    more.addEventListener("click", (ev) => { ev.stopPropagation(); if (menu) closeMenu(true); else openMenu(); });
    more.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" && !menu) { ev.preventDefault(); openMenu(); }
    });
    bar.append(more);
    // A press anywhere else closes the menu.
    document.addEventListener("click", (ev) => { if (menu && !menu.contains(ev.target) && ev.target !== more && !more.contains(ev.target)) closeMenu(false); }, true);
  }
  function syncMenu() {
    if (!more) return;
    const sel = H && H.selected();
    const show = !!sel && items(sel).length > 0;
    more.hidden = !show;
    more.parentElement && more.parentElement.classList.toggle("ch-has-more", show);
    if (!show) closeMenu(false);
  }
  function openMenu() {
    const sel = H.selected();
    const list = items(sel);
    syncMenu();
    if (!list.length) return;
    closeMenu(false);
    // Its own class: the sidebar's redraw removes every .folder-menu, and this
    // menu belongs to the header.
    menu = node("div", "pop ch-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "更多");
    for (const it of list) {
      const b = node("button", "menu-row");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.dataset.item = it.id;
      b.append(svg(it.icon), node("span", "", it.label));
      b.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenu(false); it.run(); });
      menu.append(b);
    }
    menu.addEventListener("keydown", (ev) => {
      const rows = [...menu.querySelectorAll("button")];
      const at = rows.indexOf(document.activeElement);
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); return; }
      if (ev.key === "Tab") { closeMenu(false); return; }
      let to = -1;
      if (ev.key === "ArrowDown") to = (at + 1) % rows.length;
      else if (ev.key === "ArrowUp") to = (at - 1 + rows.length) % rows.length;
      else if (ev.key === "Home") to = 0;
      else if (ev.key === "End") to = rows.length - 1;
      if (to < 0) return;
      ev.preventDefault();
      rows[to].focus();
    });
    more.setAttribute("aria-expanded", "true");
    more.classList.add("on");
    H.place(more, menu);
    menu.querySelector("button").focus();
  }
  function closeMenu(back) {
    if (!menu) return;
    const had = menu.contains(document.activeElement);
    menu.remove();
    menu = null;
    if (more) {
      more.setAttribute("aria-expanded", "false");
      more.classList.remove("on");
      if (back || had) more.focus({ preventScroll: true });
    }
  }

  // ---------------------------------------------------- the menu's actions
  // A small dialog in the shell's own style (.modal / .modal-card): Escape
  // and Tab stay inside, focus returns to what opened it (the ⋯ button, or
  // the drawer's 新对话).
  let layer = null;
  function dialog({ title, body, submit, onSubmit, opener }) {
    if (layer) layer.close(true);
    const root = node("div", "modal ch-modal");
    const card = node("form", "modal-card");
    card.noValidate = true;
    // Focus can rest on the card itself while both buttons wait on a request.
    card.tabIndex = -1;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    const h = node("h2", "", title);
    h.id = "ch-dialog-title";
    card.setAttribute("aria-labelledby", h.id);
    const err = node("p", "error");
    err.setAttribute("role", "alert");
    err.hidden = true;
    const acts = node("div", "modal-actions");
    const no = node("button", "secondary", "取消");
    no.type = "button";
    const ok = node("button", "primary", submit);
    ok.type = "submit";
    acts.append(no, ok);
    card.append(h, ...body, err, acts);
    root.append(card);
    document.body.append(root);
    // Everything behind the dialog is out of reach (inert) while it is open,
    // so Tab never wanders there, even with both buttons disabled.
    const benched = [...document.body.children].filter((n) => n !== root && !n.inert);
    for (const n of benched) n.inert = true;
    let alive = true, busy = false, down = false;
    const d = {
      alive: () => alive,
      error(text) { err.textContent = text || ""; err.hidden = !text; },
      busy(on) {
        // Focus moves to the card before its buttons are disabled, and back to
        // the confirm button when the request has settled.
        if (on && card.contains(document.activeElement)) card.focus({ preventScroll: true });
        busy = on; ok.disabled = on; no.disabled = on; card.setAttribute("aria-busy", String(on));
        if (!on && alive && (document.activeElement === card || !card.contains(document.activeElement))) ok.focus({ preventScroll: true });
      },
      close(force) {
        if (!alive || (busy && !force)) return;
        alive = false;
        root.remove();
        for (const n of benched) n.inert = false;
        if (layer === d) layer = null;
        if (opener && opener.isConnected) opener.focus({ preventScroll: true });
        else if (more && more.isConnected && !more.hidden) more.focus({ preventScroll: true });
        else document.getElementById("input")?.focus({ preventScroll: true });
      },
    };
    no.addEventListener("click", () => d.close());
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); d.close(); }
      else if (ev.key === "Tab") {
        const list = [...card.querySelectorAll("button")].filter((b) => !b.disabled);
        if (!list.length) { ev.preventDefault(); card.focus({ preventScroll: true }); }
        else if (!card.contains(document.activeElement) || document.activeElement === card) { ev.preventDefault(); (ev.shiftKey ? list.at(-1) : list[0]).focus(); }
        else if (ev.shiftKey && document.activeElement === list[0]) { ev.preventDefault(); list.at(-1).focus(); }
        else if (!ev.shiftKey && document.activeElement === list.at(-1)) { ev.preventDefault(); list[0].focus(); }
      }
      ev.stopPropagation();
    });
    root.addEventListener("mousedown", (ev) => { down = ev.target === root; });
    root.addEventListener("click", (ev) => { if (ev.target === root && down) d.close(); down = false; });
    card.addEventListener("submit", (ev) => { ev.preventDefault(); if (!busy) onSubmit(d); });
    layer = d;
    ok.focus();
    return d;
  }

  // 新对话: the cat starts a fresh conversation (the existing native move to a
  // new thread). It needs the current one to be idle; the old one stays a
  // saved conversation, and what the cat remembers is not touched. The
  // request names the conversation this page shows (expectedThreadId) when it
  // knows it, so a view that is no longer current, or a retry after an answer
  // that never came, cannot start a second one: the server says it changed.
  function newConversation(sel, opener) {
    const name = H.name(sel);
    const busyText = name + "还在忙这段对话。等它做完，或者先点停止，再开始新对话。";
    const body = [node("p", "ch-note", "现在这段对话会留在「历史对话」里，随时能回去接着聊；" + name + "记住的事都还在。")];
    const files = H.pendingFiles();
    if (files) body.push(node("p", "ch-note", "待发送的 " + files + " 个附件会被移除。"));
    // The conversation this dialog is about, named once when it opens and kept
    // for every retry: after an answer that never came, the reload shows the
    // conversation the first request did start, and a retry must not start
    // yet another. Once another conversation is seen, the owner starts over.
    const shown = () => (typeof H.threadId === "function" ? H.threadId() : "");
    const expected = shown();
    const changed = "这段对话刚换过了，没有再开新对话。先看一眼对话；还要开新对话的话，关掉这里再点一次「新对话」。";
    let stale = false;
    const d = dialog({
      title: "和" + name + "开始新对话", body, submit: "开始新对话", opener,
      onSubmit: async () => {
        if (keyOf(H.selected()) !== keyOf(sel)) { d.close(true); return; }
        const now = shown();
        if (stale || (expected && now && now !== expected)) { stale = true; d.error(changed); return; }
        if (H.working()) { d.error(busyText); return; }
        d.error("");
        d.busy(true);
        try {
          await H.api("/xbot-api/bots/" + encodeURIComponent(sel.id) + "/new", expected ? { method: "POST", body: { expectedThreadId: expected } } : { method: "POST" });
        } catch (e) {
          if (!d.alive()) return;
          d.busy(false);
          const said = String((e && e.message) || "");
          if (e && e.status === 409 && /变化/.test(said)) {
            // The conversation changed under this page (a 新对话 that did go through, or one opened elsewhere).
            stale = true;
            d.error(changed);
            H.reload();
          } else if (e && e.status === 409) d.error(/切换/.test(said) ? "正在切换对话，稍等一下再试。" : busyText);
          else if (!e || !e.status || e.status >= 500) {
            // No answer, or the server failed: it may have started anyway. The chat reads again to say.
            d.error("没能确认新对话有没有开始。先看一眼对话，再决定要不要重试。");
            H.reload();
          } else d.error("没能开始新对话：" + H.visibleError(e).replace(/^没能完成：/, ""));
          return;
        }
        d.busy(false);
        d.close(true);
        // The cat now talks in the new conversation; if this chat is still
        // open it opens afresh there (an empty chat, where the cat greets).
        const open = H.selected();
        if (keyOf(open) === keyOf(sel)) await H.reopen(open);
        H.toast("已开始新对话");
      },
    });
  }

  // 历史对话: the existing list in the cat's 资料, opened on it.
  async function pastConversations(sel) {
    const asked = H.conversations();
    await H.openDetails();
    const n = await asked;
    if (H.selected() !== sel) return;
    if (n == null) { H.status("没能读取历史对话，稍后再试。", true); return; }
    const sum = document.querySelector("#panel .ws-conv-fold > summary");
    if (sum) {
      sum.focus({ preventScroll: true });
      if (typeof sum.scrollIntoView === "function") sum.scrollIntoView({ block: "nearest" });
    }
  }

  // -------------------------------------------------------------------- init
  // A new chat: its pages, menu and suggestions start over.
  function select(sel) {
    reset(keyOf(sel));
    closeMenu(false);
    if (layer) layer.close(true);
    syncMenu();
  }

  // Hooks from app.js:
  //   api, visibleError    the shell's request and error words;
  //   thread               the history's scroll box (#thread);
  //   selected()           the open chat ({type, id}) or null;
  //   name(sel)            its display name;
  //   reload()             read the newest page again and redraw;
  //   reopen(sel)          open this chat afresh (after a new conversation);
  //   send(text)           send as the owner, like the composer;
  //   sendBusy()           a send or a reply error of the owner's is on screen;
  //   working()            the chat's cat is working (a reply, a send, the status);
  //   pendingFiles()       files waiting in the composer;
  //   conversations()      read the cat's saved conversations and open their
  //                        fold (resolves to how many, or null if unreadable);
  //   threadId()           the conversation this page shows, if known;
  //   openDetails()        open the drawer on 资料;
  //   place(anchor, menu)  position a menu under its button;
  //   toast(text), status(text, isError).
  function init(hooks) {
    H = hooks;
    mountMenu();
    watch();
    const form = document.getElementById("composer");
    if (form && typeof form.addEventListener === "function") form.addEventListener("submit", dropStarters, true);
    syncMenu();
  }

  window.ClowderHistory = Object.freeze({
    init, select, merge, top, starters, load, sync: syncMenu, openMenu, closeMenu, newConversation,
    // Where the earlier pages stand for the open chat: whether one more can be
    // read, one is on its way, or the last read failed (and why).
    // gen changes whenever the history starts over (another chat or conversation);
    // asked / failures count earlier-page requests for the page's life.
    older: () => ({ key: P.key, thread: P.thread, gen: P.gen, state: P.state, more: !!nextCursor(), loaded: P.loaded, drawn: P.drawn,
      error: P.error, asked, failures }),
    whenDrawn,
    // For tests and diagnostics only: what this page holds, never a record.
    peek: () => ({ key: P.key, thread: P.thread, held: P.held.length, state: P.state, loaded: P.loaded, cursor: nextCursor() }),
  });
})();
