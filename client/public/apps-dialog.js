// 应用 (docs/xbot-frontend.md item 52). The rules live in apps-dialog-rules.js;
// app.js passes its helpers through init() and opens the dialog from the
// sidebar's 应用 (full sidebar and rail: the same #side-apps).
// One dialog over the chat, on the original .modal / .modal-card, with two
// levels: the list (微信, then the owner's custom apps, then 添加自定义应用 as
// its last row) and one app's page (微信's, a custom app's, or the add form),
// with ‹ back to the list. The card hangs from a fixed line; a change of height
// is eased (as quick-create.js's 新建). Escape goes up one level, then closes;
// focus stays inside and goes back to the button it came from.
// Requests (docs/apps-api.md): GET /xbot-api/apps on opening; GET
// /xbot-api/apps/:id once per custom app on opening (at most 3 at a time; each
// really starts the program or reaches the address), on 再检查, and for 微信
// every 2 s while it is starting (for about 2 minutes) and once when its
// authorization runs out; POST …/wechat/connect | disconnect | authorize |
// revoke; POST …/custom {…, idempotencyKey}; PATCH …/:id {name} | {secrets};
// DELETE …/:id. Closing abandons everything in flight; nothing is read on a
// timer while the dialog is closed, and nothing is shown that the engine did
// not answer.
(() => {
  "use strict";
  const R = window.ClowderAppsRules;
  if (!R) throw new Error("apps-dialog-rules.js must load before apps-dialog.js");

  let H = null;
  const hooks = () => { if (!H) throw new Error("ClowderApps.init() must run first"); return H; };
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, click) => { const b = node("button", cls, text); b.type = "button"; if (click) b.addEventListener("click", click); return b; };
  const setText = (n, text) => { if (n.textContent !== text) n.textContent = text; };
  let seq = 0;
  const uid = (p) => "ap-" + p + "-" + ++seq;
  const media = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
  const now = () => (H && typeof H.now === "function" ? H.now() : Date.now());
  const icon = (name, extra) => hooks().icon(name, extra);
  // Shown: not inside anything hidden (and laid out, where layout exists).
  const visible = (n) => {
    for (let x = n; x; x = x.parentElement) if (x.hidden) return false;
    return typeof n.getClientRects !== "function" || n.getClientRects().length > 0;
  };
  // One key per request body: the same body again is the same request.
  // randomUUID needs a secure context, which a LAN address may not be.
  function requestKey() {
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

  // ---- our own small drawings, in the icon() style (24px grid, stroke) ----
  // 微信's mark: one speech bubble with two lines of text in it — a chat that is read. Not WeChat's logo
  // (no pair of bubbles, no eyes, no green).
  const DRAWN = {
    wechat: '<path d="M5 4.5h14a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-7.5L7 20.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z"/><path d="M7.5 9h9"/><path d="M7.5 12.5h5.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off": '<path d="M9.9 5.8A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.7 3.6M6.5 7.1C3.9 8.8 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.2"/><path d="M14.1 14.1a3 3 0 0 1-4.2-4.2"/><path d="m3 3 18 18"/>',
  };
  function drawn(name, extra) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icon" + (extra ? " " + extra : ""));
    svg.innerHTML = DRAWN[name];
    return svg;
  }
  const tileIcon = (kind) => (kind === "wechat" ? drawn("wechat") : icon(kind === "url" ? "globe" : "terminal"));
  const kindOf = (app) => (app && app.kind === "wechat" ? "wechat" : app && app.source && app.source.type === "url" ? "url" : "program");

  // Tab and Shift+Tab stay inside a layer: they wrap at its two ends (and from the layer itself, or from
  // outside it); anywhere else inside (a page's title, a state line) the browser moves on in reading order.
  function trapTab(ev, box) {
    const live = [...box.querySelectorAll("button, input, select, textarea")]
      .filter((n) => !n.disabled && n.getAttribute("tabindex") !== "-1" && visible(n));
    if (!live.length) { ev.preventDefault(); return; }
    const first = live[0], last = live[live.length - 1], here = document.activeElement;
    const edge = here === box || !box.contains(here) || (ev.shiftKey ? here === first : here === last);
    if (!edge) return;
    ev.preventDefault();
    (ev.shiftKey ? last : first).focus();
  }
  // A change of the card's height, eased (180 ms) from the old height to the new; the top edge stays where it
  // is (the dialog hangs from a fixed line). At once when motion is reduced or nothing is laid out. Changed
  // again mid-way: the newer easing starts from the height on screen.
  const easing = new WeakMap();
  function ease(card, change) {
    const can = card && typeof card.animate === "function" && typeof card.getBoundingClientRect === "function" && !media("(prefers-reduced-motion: reduce)");
    const before = can ? card.getBoundingClientRect().height : 0;
    change();
    if (!can) return;
    const prev = easing.get(card);
    if (prev) { easing.delete(card); try { prev.cancel(); } catch { /* gone */ } }
    const after = card.getBoundingClientRect().height;
    if (!before || !after || Math.abs(after - before) < 1) { card.classList.remove("ap-easing"); return; }
    card.classList.add("ap-easing");
    const anim = card.animate([{ height: before + "px" }, { height: after + "px" }], { duration: 180, easing: "ease-out" });
    easing.set(card, anim);
    const done = () => { if (easing.get(card) === anim) { easing.delete(card); card.classList.remove("ap-easing"); } };
    anim.finished.then(done, done);
  }

  // A mark and its word: on, bad, busy (the status spinner), idle, off — the word is always there too.
  function paintMark(holder, kind) {
    if (holder.markKind === kind) return;
    holder.markKind = kind;
    holder.mark.className = "ap-mark " + kind;
    holder.mark.replaceChildren(...(kind === "busy" ? [icon("spinner", "st-spin")] : []));
  }
  // The engine's own words, on request: 详情 (under the state) opens them (under the page's head, full width).
  function details() {
    const wrap = node("div", "ap-detail"), toggle = button("text-btn ap-detail-btn", "详情"), box = node("pre", "ap-detail-text");
    box.id = uid("detail");
    box.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", box.id);
    toggle.addEventListener("click", () => { box.hidden = !box.hidden; toggle.setAttribute("aria-expanded", String(!box.hidden)); });
    wrap.append(toggle);
    wrap.hidden = true;
    return { wrap, box, set(text) { const t = R.trim(text); setText(box, t); wrap.hidden = !t; if (!t) { box.hidden = true; toggle.setAttribute("aria-expanded", "false"); } } };
  }
  // A labelled field with its own message line (what its control is described by).
  function field(label, control, cls) {
    const wrap = node("div", "field ap-field" + (cls ? " " + cls : "")), lab = node("label", "", label), err = node("p", "ap-err");
    control.id = uid("f");
    lab.htmlFor = control.id;
    err.id = uid("err");
    control.setAttribute("aria-describedby", err.id);
    wrap.append(lab, control, err);
    const F = {
      wrap, input: control, err,
      mark(text) {
        setText(err, text || "");
        if (text) control.setAttribute("aria-invalid", "true"); else control.removeAttribute("aria-invalid");
      },
    };
    control.addEventListener("input", () => F.mark(""));
    return F;
  }
  function textInput(cls, max) {
    const input = node("input", cls || "");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    if (max) input.maxLength = max;
    return input;
  }
  // A secret's value: masked while typed, with 显示 to peek.
  function secretInput(label) {
    const wrap = node("div", "ap-secret-value"), input = textInput("ap-secret-in", R.VALUE_MAX * 2);
    input.type = "password";
    input.autocomplete = "new-password";
    input.placeholder = "值";
    input.setAttribute("aria-label", label);
    const peek = button("ghost ap-peek", null, () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      peek.setAttribute("aria-pressed", String(show));
      peek.replaceChildren(drawn(show ? "eye-off" : "eye"));
    });
    peek.setAttribute("aria-label", "显示");
    peek.setAttribute("aria-pressed", "false");
    peek.dataset.tip = "显示";
    peek.append(drawn("eye"));
    wrap.append(input, peek);
    return { wrap, input, peek };
  }

  // ---------------------------------------------------------------- the dialog
  let D = null;
  function open({ opener } = {}) {
    hooks();
    if (D) D.close(false);
    D = dialog(opener && opener.isConnected ? opener : document.activeElement);
    return D;
  }

  function dialog(opener) {
    const h = hooks();
    const root = node("div", "modal ap-modal"), card = node("div", "modal-card ap-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("tabindex", "-1");
    const head = node("div", "ap-head");
    const back = button("ghost ap-back", null, () => goList());
    back.append(icon("chevronLeft"));
    back.setAttribute("aria-label", "返回");
    back.dataset.tip = "返回";
    back.hidden = true;
    const title = node("h2", "ap-title");
    title.id = uid("title");
    title.setAttribute("tabindex", "-1");
    card.setAttribute("aria-labelledby", title.id);
    const shut = button("ghost ap-x", null, () => close());
    shut.append(icon("x"));
    shut.setAttribute("aria-label", "关闭");
    shut.dataset.tip = "关闭";
    head.append(back, title, shut);
    const body = node("div", "ap-body");
    // One polite voice for what happened while the owner was not acting (a start finished, the checks, the end of an authorization).
    const voice = node("p", "visually-hidden");
    voice.setAttribute("role", "status");
    voice.setAttribute("aria-live", "polite");
    card.append(head, body, voice);
    root.append(card);
    document.body.append(root);
    // Nothing behind the dialog can be reached while it is open.
    const quiet = [...document.body.children].filter((n) => n !== root && !n.inert);
    for (const n of quiet) n.inert = true;

    const S = {
      alive: true,
      order: null,               // the custom apps' ids, in the server's order (null until the list is read)
      reading: false, listError: "", checkedOnce: false,
      apps: new Map(),           // id → the latest App the server answered
      readAt: new Map(),         // id → when it was answered (this page's clock)
      checks: new Map(),         // id → {status: "queued" | "running", ctrl, token}
      queue: [], round: null,
      ctrls: new Set(), timers: new Set(),
      poll: null,                // 微信 starting: {started, timer, reading, gaveUp, error}
      count: null,               // 微信 authorized: {end, timer, zeroRead}
      wbusy: "", wnote: "", anote: null,
      notes: new Map(),          // id → {text, bad} shown on its page
      draft: null, from: null, layer: null,
    };
    let view = null;

    // ---- plumbing ----
    function later(fn, ms) {
      const id = setTimeout(() => { S.timers.delete(id); if (S.alive) fn(); }, ms);
      S.timers.add(id);
      return id;
    }
    function cancel(id) { if (id) { clearTimeout(id); S.timers.delete(id); } }
    async function call(path, opt = {}, own) {
      const ctrl = own || (typeof AbortController === "function" ? new AbortController() : null);
      if (ctrl) S.ctrls.add(ctrl);
      try { return await h.api(path, Object.assign({}, opt, ctrl ? { signal: ctrl.signal } : {})); }
      finally { if (ctrl) S.ctrls.delete(ctrl); }
    }
    function announce(text) {
      if (!text) return;
      // The same words again are still said (a zero-width space makes them new).
      voice.textContent = voice.textContent === text ? text + String.fromCharCode(0x200b) : text;
    }
    // A focused button about to be disabled would drop focus to the page: hold it on the card.
    function hold() {
      const a = document.activeElement;
      if (a && card.contains(a) && a.tagName === "BUTTON") card.focus();
    }
    // Focus that waited on the card (or still sits where a page starts, in a browser that does not focus a clicked button) follows the answer.
    const focusWasHeld = () => document.activeElement === card || document.activeElement === title || !card.contains(document.activeElement);
    const checkOf = (id) => (S.checks.get(id) && S.checks.get(id).status === "running" ? "running" : "");

    // ---- keys, clicks ----
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); if (view && view.name !== "list") goList(); else close(); }
      else if (ev.key === "Tab") trapTab(ev, card);
      ev.stopPropagation();
    });
    let downOnRoot = false;
    root.addEventListener("mousedown", (ev) => { downOnRoot = ev.target === root; });
    root.addEventListener("click", (ev) => { if (ev.target === root && downOnRoot) close(); downOnRoot = false; });

    function close(refocus = true) {
      if (!S.alive) return;
      S.alive = false;
      for (const c of S.ctrls) { try { c.abort(); } catch { /* done */ } }
      for (const t of S.timers) clearTimeout(t);
      S.timers.clear();
      if (S.layer) S.layer.remove();
      root.remove();
      for (const n of quiet) n.inert = false;
      if (D === api) D = null;
      if (refocus && opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
    }

    // ---- views ----
    function show(next, focus) {
      const change = () => {
        view = next;
        body.replaceChildren(next.el);
        body.scrollTop = 0;
        paintHead();
        next.paint();
      };
      if (!view) change(); else ease(card, change);
      if (focus) focus();
    }
    function paintHead() {
      back.hidden = !view || view.name === "list";
      title.replaceChildren(...(view && view.head ? view.head() : [view && view.title ? view.title : "应用"]));
    }
    function goList() {
      if (!view || view.name === "list") return;
      const from = S.from;
      show(L, () => {
        const r = from && L.rows.get(from);
        if (from === "add") L.add.focus();
        else if (r && r.b.isConnected) r.b.focus();
        else card.focus();
      });
    }

    // ---------------------------------------------------------------- the list
    const L = (() => {
      const el = node("div", "ap-view ap-list");
      const wait = node("p", "ap-wait");
      wait.append(node("span", "ap-wait-text", "正在读取…"));
      const fail = node("div", "ap-fail"), failText = node("p", "ap-note bad");
      failText.setAttribute("role", "alert");
      const again = button("secondary", "再试一次", () => readList("again"));
      fail.append(failText, again);
      const top = node("div", "ap-rows"), mine = node("div", "ap-rows ap-mine");
      // The last row of the owner's own: where more of them come from.
      const add = button("ap-row ap-row-add", null, () => openAdd());
      const addTile = node("span", "ap-tile");
      addTile.append(icon("plus"));
      add.append(addTile, node("span", "ap-row-name", "添加自定义应用"));
      mine.append(add);
      el.append(wait, fail, top, mine);
      return { name: "list", el, wait, fail, failText, again, top, mine, add, rows: new Map(), title: "应用", paint: () => paintList() };
    })();
    function makeRow(id) {
      const b = button("ap-row", null, () => openPage(id));
      b.dataset.app = id;
      const tile = node("span", "ap-tile"), tx = node("span", "ap-row-tx"), name = node("span", "ap-row-name");
      const st = node("span", "ap-st"), mark = node("span", "ap-mark"), word = node("span", "ap-st-word"), time = node("span", "ap-st-time");
      mark.setAttribute("aria-hidden", "true");
      st.append(mark, word, time);
      tx.append(name, node("span", "visually-hidden", "，"), st);
      b.append(tile, tx, icon("chevron", "ap-chev"));
      return { id, b, tile, name, mark, word, time, markKind: "", tileKind: "" };
    }
    function paintRow(id) {
      const r = L.rows.get(id), app = S.apps.get(id);
      if (!r || !app) return;
      const lk = R.look(app, checkOf(id));
      setText(r.name, R.trim(app.title) || id);
      paintMark(r, lk.mark);
      setText(r.word, lk.word);
      r.word.classList.toggle("bad", lk.mark === "bad");
      const kind = kindOf(app);
      if (r.tileKind !== kind) { r.tileKind = kind; r.tile.replaceChildren(tileIcon(kind)); }
      if (id === R.WECHAT) paintClock();
    }
    function paintList() {
      const has = !!S.order;
      L.wait.hidden = has || !S.reading;
      L.fail.hidden = has || !S.listError;
      if (!has && S.listError) {
        setText(L.failText, S.listError);
        L.again.disabled = S.reading;
        setText(L.again, S.reading ? "正在读取…" : "再试一次");
      }
      L.top.hidden = L.mine.hidden = !has;
      if (!has) return;
      const ids = [R.WECHAT, ...S.order].filter((id) => S.apps.has(id));
      for (const [id, r] of L.rows) if (!ids.includes(id)) { r.b.remove(); L.rows.delete(id); }
      for (const id of ids) if (!L.rows.has(id)) L.rows.set(id, makeRow(id));
      const w = L.rows.get(R.WECHAT);
      if (w && w.b.parentElement !== L.top) L.top.append(w.b);
      // Moving a focused row would drop its focus: only when the order changed, and focus is put back.
      const want = [...S.order.filter((id) => L.rows.has(id)).map((id) => L.rows.get(id).b), L.add];
      const kids = L.mine.children;
      if (want.length !== kids.length || want.some((b, i) => kids[i] !== b)) {
        const here = L.mine.contains(document.activeElement) ? document.activeElement : null;
        L.mine.replaceChildren(...want);
        if (here && here.isConnected && document.activeElement !== here) here.focus();
      }
      for (const id of ids) paintRow(id);
    }

    // The list, read fresh. A custom app already checked here keeps what its check said (the list itself
    // checks nothing and calls every row unchecked); one the list no longer has is gone.
    async function readList(why) {
      S.reading = true;
      if (why === "again") S.listError = "";
      paintList();
      let data;
      try { data = await call("/xbot-api/apps"); }
      catch (err) {
        if (!S.alive) return false;
        S.reading = false;
        if (!S.order) S.listError = R.listError(err);
        paintList();
        return false;
      }
      if (!S.alive) return false;
      S.reading = false;
      S.listError = "";
      const apps = Array.isArray(data && data.apps) ? data.apps.filter((a) => a && a.id) : [];
      const custom = apps.filter((a) => a.kind === "custom");
      for (const a of custom) {
        const known = S.apps.get(a.id);
        if (known && a.state === "unchecked" && known.state !== "unchecked") S.apps.set(a.id, Object.assign({}, known, { title: a.title, source: a.source }));
        else S.apps.set(a.id, a);
      }
      const keep = new Set(custom.map((a) => a.id));
      for (const id of [...S.apps.keys()]) if (id !== R.WECHAT && !keep.has(id)) forget(id);
      S.order = custom.map((a) => a.id);
      const w = apps.find((a) => a.id === R.WECHAT);
      if (w) setApp(w, "list");
      paintList();
      if (view && view.name === "app" && !S.apps.has(view.id)) { S.from = null; goList(); }
      if (!S.checkedOnce) {
        S.checkedOnce = true;
        const ids = S.order.filter((id) => S.apps.get(id).state !== "off");
        S.round = ids.length ? { ids: new Set(ids), left: new Set(ids) } : null;
        for (const id of ids) queueCheck(id);
        pump();
      }
      return true;
    }
    // An app that is no longer there: its checks stop, its row goes.
    function forget(id) {
      const c = S.checks.get(id);
      if (c && c.ctrl) { try { c.ctrl.abort(); } catch { /* done */ } }
      S.checks.delete(id);
      S.apps.delete(id);
      S.notes.delete(id);
      if (S.order) S.order = S.order.filter((x) => x !== id);
      if (S.round) { S.round.ids.delete(id); settled(id); }
    }
    // What the server answered for one app: its row, its page and, for 微信, the poll and the clock follow.
    function setApp(app, why) {
      if (!app || !app.id) return;
      const prev = S.apps.get(app.id);
      S.apps.set(app.id, app);
      S.readAt.set(app.id, now());
      if (app.id === R.WECHAT) wechatChanged(prev, app, why);
      paintRow(app.id);
      if (view && view.id === app.id) view.paint();
    }

    // ---------------------------------------------------------------- checks
    // Each custom app is checked once on opening, at most three at a time; rows settle one by one.
    function queueCheck(id) {
      if (S.checks.has(id)) return;
      S.checks.set(id, { status: "queued" });
      S.queue.push(id);
    }
    function pump() {
      const running = () => [...S.checks.values()].filter((c) => c.status === "running").length;
      while (S.alive && running() < 3 && S.queue.length) {
        const id = S.queue.shift(), c = S.checks.get(id);
        if (c && c.status === "queued") runCheck(id);
      }
    }
    // A write in flight for an app supersedes its check: the write's own answer is the newer one.
    function claim(id) {
      const c = S.checks.get(id);
      if (c && c.ctrl) { try { c.ctrl.abort(); } catch { /* done */ } }
      S.queue = S.queue.filter((x) => x !== id);
      const ctrl = typeof AbortController === "function" ? new AbortController() : null, token = {};
      S.checks.set(id, { status: "running", ctrl, token });
      paintRow(id);
      if (view && view.id === id) view.paint();
      return { ctrl, token, mine: () => S.alive && S.checks.get(id) && S.checks.get(id).token === token };
    }
    function release(id, token) {
      const c = S.checks.get(id);
      if (c && c.token === token) S.checks.delete(id);
      pump();
    }
    async function runCheck(id) {
      const T = claim(id);
      let app = null, error = null;
      try { app = await call(R.path(id), {}, T.ctrl); } catch (err) { error = err; }
      if (!T.mine()) return;
      release(id, T.token);
      if (app) { setApp(app, "check"); settled(id); return; }
      const what = R.checkError(error);
      if (what.kind === "gone") { goneApp(id); return; }
      const known = S.apps.get(id);
      if (known) S.apps.set(id, Object.assign({}, known, { state: "unchecked", reason: "没能检查", tools: undefined, detail: undefined }));
      S.notes.set(id, { text: what.text, bad: true });
      paintRow(id);
      if (view && view.id === id) view.paint();
      settled(id);
    }
    // The opening checks, said once to a screen reader when the last one settles.
    function settled(id) {
      const r = S.round;
      if (!r || !r.left.delete(id) || r.left.size) return;
      S.round = null;
      announce(R.checked([...r.ids].map((x) => S.apps.get(x)).filter(Boolean)));
    }
    // Gone from the engine (removed elsewhere): the list is read again.
    function goneApp(id) {
      const was = S.apps.get(id);
      forget(id);
      paintList();
      if (view && view.id === id) { S.from = null; goList(); }
      if (was) announce("「" + R.trim(was.title) + "」已经不在了。");
      readList("gone");
    }

    // ---------------------------------------------------------------- 微信: poll and clock
    const polling = () => !!(S.poll && (S.poll.timer || S.poll.reading));
    function wechatChanged(prev, next, why) {
      const wasStarting = !!prev && prev.state === "starting";
      if (next.state === "starting") { if (!polling()) startPoll(); }
      else {
        if (S.poll) { cancel(S.poll.timer); S.poll = null; }
        // Only a start seen ending by the poll was not the owner's doing at that moment.
        if (wasStarting && why === "poll") announce(next.state === "on" ? R.SAID.started : (next.state === "failed" || R.trim(next.reason)) ? R.SAID.startFailed(next.reason) : "");
      }
      const was = !!(prev && prev.state === "on" && prev.authorization && prev.authorization.active);
      const is = next.state === "on" && !!(next.authorization && next.authorization.active);
      if (why === "zero" && was && !is) announce(R.SAID.ended);
      syncCountdown();
    }
    function startPoll() {
      if (S.poll) cancel(S.poll.timer);
      S.poll = { started: now(), timer: 0, reading: false, gaveUp: false, error: "" };
      nextPoll();
    }
    function nextPoll() {
      const P = S.poll;
      if (!P) return;
      const wait = R.pollNext(P.started, now());
      if (wait < 0) { P.gaveUp = true; announce(R.SAID.still); paintWechatPage(); return; }
      P.timer = later(async () => {
        if (S.poll !== P) return;
        P.timer = 0;
        P.reading = true;
        const app = await readWechat("poll");
        if (S.poll !== P) return;
        P.reading = false;
        if (app && app.state === "starting") nextPoll();
      }, wait);
    }
    // 微信 read fresh. why: "poll", "zero" (the authorization ran out), "manual" (再看一次), "after" (a failed write).
    async function readWechat(why) {
      if (why === "manual") { S.wbusy = "reread"; S.wnote = ""; hold(); paintWechatPage(); }
      let app = null, error = null;
      try { app = await call(R.path(R.WECHAT)); } catch (err) { error = err; }
      if (!S.alive) return null;
      if (why === "manual") S.wbusy = "";
      if (app) { setApp(app, why); return app; }
      const text = R.wechatError(error, "reread").text;
      if (why === "poll" && S.poll) { S.poll.reading = false; S.poll.error = text; }
      else if (why === "manual") S.wnote = text;
      else if (why === "zero") S.anote = { text, retry: true };
      paintWechatPage();
      return null;
    }
    function syncCountdown() {
      const app = S.apps.get(R.WECHAT);
      const end = R.deadline(app && app.state === "on" ? app.authorization : null, S.readAt.get(R.WECHAT) || now());
      if (end === null) { if (S.count) cancel(S.count.timer); S.count = null; paintClock(); return; }
      if (S.count && S.count.end === end) return;
      if (S.count) cancel(S.count.timer);
      S.count = { end, timer: 0, zeroRead: false };
      tick();
    }
    // The live countdown, from the server's answer; at zero one fresh read, and only one.
    function tick() {
      const c = S.count;
      if (!c) return;
      const left = c.end - now();
      paintClock();
      if (left > 0) { c.timer = later(tick, R.tickIn(left)); return; }
      c.timer = 0;
      if (!c.zeroRead) { c.zeroRead = true; readWechat("zero"); }
    }
    function paintClock() {
      const left = S.count ? Math.max(0, S.count.end - now()) : 0;
      const r = L.rows.get(R.WECHAT);
      if (r) setText(r.time, S.count ? " · " + R.clock(left) : "");
      if (view && view.name === "wechat") { setText(view.clock, R.clock(left)); setText(view.clockSaid, R.clockSaid(left)); }
    }

    // ---------------------------------------------------------------- 微信's page
    function openPage(id) {
      if (!S.apps.has(id)) return;
      S.from = id;
      const next = id === R.WECHAT ? wechatPage() : appPage(id);
      show(next, () => title.focus());
    }
    function wechatPage() {
      const el = node("div", "ap-view ap-wechat");
      const hero = node("div", "ap-hero"), tile = node("span", "ap-tile lg"), tx = node("div", "ap-hero-tx");
      tile.append(drawn("wechat"));
      const state = node("p", "ap-state"), mark = node("span", "ap-mark"), word = node("span", "ap-state-word");
      state.setAttribute("tabindex", "-1");
      mark.setAttribute("aria-hidden", "true");
      state.append(mark, word);
      const about = node("p", "ap-about", R.WECHAT_ABOUT), detail = details();
      tx.append(state, about, detail.wrap);
      const acts = node("div", "ap-hero-acts");
      hero.append(tile, tx, acts);
      const note = node("p", "ap-note");
      // The authorization: before — what it means, then 授权 10 分钟; after — the time left, 撤销, and how it is used.
      const auth = node("section", "ap-auth");
      const notYet = node("div", "ap-auth-part"), notYetState = node("p", "ap-auth-state", R.WECHAT_NOT_YET);
      notYetState.setAttribute("tabindex", "-1");
      const facts = node("ul", "ap-facts");
      facts.id = uid("facts");
      for (const f of R.WECHAT_FACTS) facts.append(node("li", "", f));
      const authorize = button("primary ap-authorize", "授权 10 分钟", () => wechatAct("authorize"));
      authorize.setAttribute("aria-describedby", facts.id);
      const sourceBox = node("div", "ap-source-text"), source = button("text-btn ap-source", "插件原文");
      sourceBox.id = uid("source");
      sourceBox.hidden = true;
      source.setAttribute("aria-expanded", "false");
      source.setAttribute("aria-controls", sourceBox.id);
      source.addEventListener("click", () => {
        sourceBox.hidden = !sourceBox.hidden;
        source.setAttribute("aria-expanded", String(!sourceBox.hidden));
      });
      const authActs = node("div", "ap-auth-acts");
      authActs.append(authorize, source);
      const authNote = node("div", "ap-note");
      notYet.append(notYetState, facts, authActs, sourceBox);
      const can = node("div", "ap-auth-part ap-can"), canState = node("p", "ap-auth-state", R.WECHAT_CAN);
      canState.setAttribute("tabindex", "-1");
      const clockRow = node("div", "ap-clock-row"), clockEl = node("p", "ap-clock"), clockSaid = node("span", "visually-hidden");
      clockEl.setAttribute("aria-hidden", "true");
      const revoke = button("secondary ap-revoke", "撤销", () => wechatAct("revoke"));
      clockRow.append(clockEl, revoke);
      canState.append(node("span", "visually-hidden", "，"), clockSaid);
      const how = node("p", "ap-how");
      how.append(R.WECHAT_HOW[0], node("b", "ap-say", R.WECHAT_HOW[1]), R.WECHAT_HOW[2]);
      can.append(canState, clockRow, how, node("p", "ap-how quiet", R.WECHAT_FIRST));
      auth.append(notYet, can, authNote);
      const foot = node("p", "ap-foot", R.WECHAT_HUB);
      el.append(hero, detail.box, note, auth, foot);
      const V = {
        name: "wechat", id: R.WECHAT, el, title: "微信", state, mark, word, about, detail, acts, note, auth, notYet, notYetState, facts,
        authorize, source, sourceBox, authNote, can, canState, clock: clockEl, clockSaid, revoke, foot, markKind: "",
        paint: () => paintWechat(V),
      };
      return V;
    }
    function paintWechatPage() { if (view && view.name === "wechat") view.paint(); paintRow(R.WECHAT); }
    function paintWechat(V) {
      const app = S.apps.get(R.WECHAT);
      if (!app) return;
      const lk = R.look(app, "", true);
      paintMark(V, lk.mark);
      setText(V.word, lk.word);
      V.word.classList.toggle("bad", lk.mark === "bad");
      V.about.hidden = app.state === "on";
      V.detail.set(app.state === "on" ? "" : app.detail);
      const gave = !!(S.poll && (S.poll.gaveUp || S.poll.error));
      const lost = paintActs(V.acts, R.wechatActions(app, gave));
      // Under the state: what failed, or how a start is going.
      const starting = app.state === "starting" ? (S.poll && S.poll.error) || (gave ? R.WECHAT_STILL : R.WECHAT_SLOW) : "";
      const said = S.wnote || starting;
      setText(V.note, said);
      V.note.hidden = !said;
      V.note.classList.toggle("bad", !!S.wnote || !!(S.poll && S.poll.error && app.state === "starting"));
      if (S.wnote) V.note.setAttribute("role", "alert"); else V.note.removeAttribute("role");
      // The authorization, when 微信 is on.
      const on = app.state === "on", active = on && !!(app.authorization && app.authorization.active);
      V.auth.hidden = !on;
      V.notYet.hidden = active;
      V.can.hidden = !active;
      const busy = S.wbusy;
      V.authorize.disabled = V.revoke.disabled = !!busy;
      setText(V.authorize, busy === "authorize" ? R.BUSY.authorize : "授权 10 分钟");
      setText(V.revoke, busy === "revoke" ? R.BUSY.revoke : "撤销");
      setText(V.sourceBox, "");
      if (app.disclosure) {
        V.sourceBox.append(node("p", "ap-source-ver", app.version ? "版本 " + app.version : ""), node("p", "ap-source-body", app.disclosure));
      }
      V.source.hidden = !app.disclosure;
      const A = S.anote;
      V.authNote.replaceChildren();
      if (A && on) {
        V.authNote.append(node("span", "", A.text));
        if (A.retry) V.authNote.append(button("text-btn ap-again", "再看一次", () => { S.anote = null; readWechat("manual"); }));
      }
      V.authNote.hidden = !(A && on);
      V.authNote.classList.toggle("bad", !!A);
      if (A && on && !A.retry) V.authNote.setAttribute("role", "alert"); else V.authNote.removeAttribute("role");
      V.foot.hidden = active || app.state === "unavailable";
      paintClock();
      if (lost) V.state.focus();
    }
    // The page's own actions for the state it is in; a button that stays keeps its focus.
    function paintActs(box, list) {
      const had = [...box.children], focused = had.includes(document.activeElement) ? document.activeElement : null;
      const next = list.map(({ act, label, said, main }) => {
        let b = had.find((x) => x.dataset.act === act);
        if (!b) { b = button("", null, (ev) => wechatAct(act, ev.currentTarget)); b.dataset.act = act; }
        b.className = main ? "primary" : "secondary";
        setText(b, S.wbusy === act ? R.BUSY[act] : label);
        if (S.wbusy === act) b.removeAttribute("aria-label"); else b.setAttribute("aria-label", said || label);
        b.disabled = !!S.wbusy;
        return b;
      });
      if (next.length !== had.length || next.some((b, i) => b !== had[i])) box.replaceChildren(...next);
      box.hidden = !next.length;
      return !!focused && !next.includes(focused);
    }
    const WECHAT_PATHS = { connect: "/connect", disconnect: "/disconnect", authorize: "/authorize", revoke: "/revoke" };
    async function wechatAct(act) {
      if (S.wbusy) return;
      if (act === "reread") { if (S.poll) cancel(S.poll.timer); S.poll = null; await readWechat("manual"); return; }
      S.wbusy = act;
      S.wnote = "";
      S.anote = null;
      hold();
      paintWechatPage();
      let app = null, error = null;
      try { app = await call(R.path(R.WECHAT) + WECHAT_PATHS[act], { method: "POST", body: {} }); }
      catch (err) { error = err; }
      if (!S.alive) return;
      S.wbusy = "";
      const held = focusWasHeld();
      if (app) {
        setApp(app, act);
        if (held) wechatFocus();
        return;
      }
      const what = R.wechatError(error, act);
      // Every failed write is followed by one fresh read: what the engine is doing now is what is shown.
      await readWechat("after");
      if (!S.alive) return;
      const shown = S.apps.get(R.WECHAT);
      // A start the engine went on with is not a failure: its state says what it is doing.
      const goingOn = act === "connect" && what.kind === "unsure" && shown && (shown.state === "starting" || shown.state === "on");
      if (!goingOn) {
        if ((act === "authorize" || act === "revoke") && shown && shown.state === "on") S.anote = { text: what.text, retry: false };
        else S.wnote = what.text;
      }
      paintWechatPage();
      if (held) wechatFocus();
    }
    // After an action: where the answer is (the state line, or the authorization's own line).
    function wechatFocus() {
      if (!view || view.name !== "wechat") return;
      const app = S.apps.get(R.WECHAT);
      const target = app && app.state === "on" && S.anote ? (view.can.hidden ? view.authorize : view.revoke)
        : app && app.state === "on" ? (view.can.hidden ? view.notYetState : view.canState) : view.state;
      if (target && visible(target)) target.focus(); else view.state.focus();
    }

    // ---------------------------------------------------------------- a custom app's page
    function appPage(id) {
      const el = node("div", "ap-view ap-app");
      const hero = node("div", "ap-hero"), tile = node("span", "ap-tile lg"), tx = node("div", "ap-hero-tx");
      const state = node("p", "ap-state"), mark = node("span", "ap-mark"), word = node("span", "ap-state-word");
      state.setAttribute("tabindex", "-1");
      mark.setAttribute("aria-hidden", "true");
      state.append(mark, word);
      const detail = details();
      tx.append(state, detail.wrap);
      const again = button("secondary ap-check", "再检查", () => recheck(id));
      const acts = node("div", "ap-hero-acts");
      acts.append(again);
      hero.append(tile, tx, acts);
      const note = node("p", "ap-note"), hint = node("p", "ap-hint", R.SLOW_HINT);
      // What it is: the program and its arguments, or the address (the tile above says which).
      const what = node("div", "ap-cmd"), whatText = node("code", "");
      what.append(whatText);
      // Its secrets, by name only.
      const secrets = node("section", "ap-sec"), secretsHead = node("h3", ""), names = node("ul", "ap-names");
      secretsHead.id = uid("secrets");
      names.setAttribute("aria-labelledby", secretsHead.id);
      const addSecret = button("text-btn ap-add-secret", null, () => editSecret(V, null));
      secrets.append(secretsHead, names, addSecret);
      // What it offers the cats.
      const tools = node("section", "ap-sec"), toolsHead = node("h3", ""), toolList = node("ul", "ap-tools");
      toolsHead.id = uid("tools");
      toolList.setAttribute("aria-labelledby", toolsHead.id);
      tools.append(toolsHead, toolList);
      const end = node("div", "ap-end"), remove = button("text-btn danger ap-remove", "移除", () => confirmRemove(id, remove));
      end.append(remove);
      el.append(hero, detail.box, note, hint, what, secrets, tools, end);
      // The name, in the dialog's title: a button that turns into its field.
      const nameBtn = button("ap-name", null, () => startRename(V)), nameText = node("span", "ap-name-text");
      nameBtn.append(nameText, node("span", "visually-hidden", "，改名"), icon("pencil", "ap-name-mark"));
      nameBtn.dataset.tip = "改名";
      const V = {
        name: "app", id, el, state, mark, word, detail, again, note, hint, tile, tileKind: "", whatText, secrets, secretsHead, names,
        addSecret, tools, toolsHead, toolList, remove, nameBtn, nameText, markKind: "", editing: null, secretEdit: null, open: new Set(),
        head: () => [V.editing ? V.editing.input : V.nameBtn],
        paint: () => paintApp(V),
      };
      return V;
    }
    function paintApp(V) {
      const app = S.apps.get(V.id);
      if (!app) return;
      const ck = checkOf(V.id), lk = R.look(app, ck), kind = kindOf(app), src = app.source || {};
      setText(V.nameText, R.trim(app.title) || V.id);
      paintMark(V, lk.mark);
      setText(V.word, lk.word);
      V.word.classList.toggle("bad", lk.mark === "bad");
      V.detail.set(app.state === "failed" ? app.detail : "");
      if (V.tileKind !== kind) { V.tileKind = kind; V.tile.replaceChildren(tileIcon(kind)); }
      const hadFocus = document.activeElement === V.again;
      V.again.hidden = app.state === "off";
      V.again.disabled = !!ck;
      setText(V.again, ck ? R.BUSY.check : app.state === "failed" ? "再试一次" : "再检查");
      if (hadFocus && V.again.disabled) card.focus();
      const n = S.notes.get(V.id);
      setText(V.note, n ? n.text : "");
      V.note.hidden = !n;
      V.note.classList.toggle("bad", !!(n && n.bad));
      V.hint.hidden = ck === "running" || !R.slowFirstRun(app);
      setText(V.whatText, kind === "url" ? R.trim(src.url) : R.commandLine(R.trim(src.program), Array.isArray(src.args) ? src.args : []));
      // Secrets: names, each with 换一个值; one editor at a time.
      const word = R.SECRETS_WORD[kind === "url" ? "url" : "program"];
      setText(V.secretsHead, word);
      const list = Array.isArray(src.secrets) ? src.secrets : [];
      paintNames(V, list);
      V.secretsHead.hidden = V.names.hidden = !list.length && !(V.secretEdit && !V.secretEdit.name);
      V.addSecret.replaceChildren(icon("plus"), node("span", "", list.length ? "添加" : "添加" + word));
      V.addSecret.hidden = !!(V.secretEdit && !V.secretEdit.name) || list.length >= R.SECRETS_MAX;
      V.addSecret.disabled = !!(V.secretEdit && V.secretEdit.saving);
      // Tools: only once a check has answered.
      const tools = app.state === "on" && Array.isArray(app.tools) ? app.tools : null;
      V.tools.hidden = !tools;
      if (tools) paintTools(V, tools);
      if (V.editing) V.editing.input.setAttribute("aria-label", "名字");
      V.nameBtn.setAttribute("aria-describedby", V.word.id || (V.word.id = uid("word")));
    }
    function paintNames(V, list) {
      const E = V.secretEdit;
      const items = list.map((name) => {
        const li = node("li", "ap-name-row");
        li.dataset.secret = name;
        if (E && E.name === name) { li.append(E.box); return li; }
        const swap = button("text-btn ap-swap", "换一个值", () => editSecret(V, name));
        swap.setAttribute("aria-label", "换一个值：" + name);
        swap.disabled = !!(E && E.saving);
        li.append(node("code", "", name), swap);
        return li;
      });
      if (E && !E.name) { const li = node("li", "ap-name-row ap-adding"); li.append(E.box); items.push(li); }
      const here = V.names.contains(document.activeElement) ? document.activeElement : null;
      V.names.replaceChildren(...items);
      if (here && !here.isConnected) {
        const again = here.getAttribute && here.getAttribute("aria-label");
        const twin = again ? [...V.names.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === again) : null;
        (twin || card).focus();
      } else if (here && document.activeElement !== here) here.focus();
    }
    function paintTools(V, tools) {
      setText(V.toolsHead, "工具 · " + tools.length);
      const sig = tools.map((t) => t.name + "\n" + (t.description || "")).join("\n\n");
      if (V.toolSig === sig) return;
      V.toolSig = sig;
      const items = tools.map((t) => {
        const li = node("li", "ap-tool"), desc = R.trim(t.description);
        if (!desc) { li.append(node("code", "ap-tool-name", t.name)); return li; }
        const b = button("ap-tool-btn"), text = node("p", "ap-tool-desc", desc);
        text.id = uid("tool");
        text.hidden = !V.open.has(t.name);
        b.append(node("code", "ap-tool-name", t.name), icon("chevronDown", "ap-tool-chev"));
        b.setAttribute("aria-expanded", String(!text.hidden));
        b.setAttribute("aria-controls", text.id);
        b.addEventListener("click", () => {
          text.hidden = !text.hidden;
          b.setAttribute("aria-expanded", String(!text.hidden));
          if (text.hidden) V.open.delete(t.name); else V.open.add(t.name);
        });
        li.append(b, text);
        return li;
      });
      if (!items.length) items.push(node("li", "ap-tool none", "它没有提供工具。"));
      V.toolList.replaceChildren(...items);
    }

    // 再检查 / 再试一次: one fresh read of its detail (the engine starts or reaches it once more).
    async function recheck(id) {
      if (checkOf(id)) return;
      S.notes.delete(id);
      const T = claim(id);
      let app = null, error = null;
      try { app = await call(R.path(id), {}, T.ctrl); } catch (err) { error = err; }
      if (!T.mine()) return;
      const held = focusWasHeld();
      release(id, T.token);
      if (app) setApp(app, "check");
      else {
        const what = R.checkError(error);
        if (what.kind === "gone") { goneApp(id); return; }
        S.notes.set(id, { text: what.text, bad: true });
        paintRow(id);
        if (view && view.id === id) view.paint();
      }
      settled(id);
      if (held && view && view.id === id) (visible(view.again) ? view.again : view.state).focus();
    }

    // The name, changed in place: Enter or leaving the field saves, Escape keeps the old one.
    function startRename(V) {
      if (V.editing) return;
      const app = S.apps.get(V.id);
      const input = textInput("ap-name-input", R.NAME_MAX * 2);
      input.value = R.trim(app && app.title);
      input.setAttribute("aria-label", "名字");
      const E = V.editing = { input, busy: false, done: false };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); saveName(V, true); }
        else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); endRename(V, true); }
      });
      input.addEventListener("blur", () => { if (!E.done && !E.busy) saveName(V, false); });
      paintHead();
      input.focus();
      if (typeof input.select === "function") input.select();
    }
    function endRename(V, refocus) {
      const E = V.editing;
      if (!E || E.done) return;
      E.done = true;
      V.editing = null;
      if (view === V) paintHead();
      if (refocus && view === V) V.nameBtn.focus();
    }
    async function saveName(V, byKey) {
      const E = V.editing;
      if (!E || E.busy || E.done) return;
      const app = S.apps.get(V.id), value = R.trim(E.input.value);
      if (!app || value === R.trim(app.title)) { endRename(V, byKey); return; }
      const problem = R.nameProblem(value);
      if (problem) {
        if (!byKey) { endRename(V, false); return; }
        S.notes.set(V.id, { text: problem, bad: true });
        paintApp(V);
        E.input.focus();
        return;
      }
      E.busy = true;
      E.input.readOnly = true;
      S.notes.delete(V.id);
      const T = claim(V.id);
      let answer = null, error = null;
      try { answer = await call(R.path(V.id), { method: "PATCH", body: { name: value } }, T.ctrl); } catch (err) { error = err; }
      if (!T.mine()) return;
      release(V.id, T.token);
      E.busy = false;
      E.input.readOnly = false;
      if (answer) {
        const back = document.activeElement === E.input || focusWasHeld();
        setApp(answer, "rename");
        settled(V.id);
        endRename(V, back);
        return;
      }
      const what = R.patchError(error, "rename");
      settled(V.id);
      if (what.kind === "gone") { goneApp(V.id); return; }
      S.notes.set(V.id, { text: what.text, bad: true });
      paintRow(V.id);
      if (view === V) paintApp(V);
      if (E.done) return;
      if (byKey || document.activeElement === card) E.input.focus();
    }

    // A secret: a new value for one by name, or one more. The value is masked; it is never shown again.
    function editSecret(V, name) {
      if (V.secretEdit && V.secretEdit.saving) return;
      const app = S.apps.get(V.id);
      if (!app) return;
      const kind = kindOf(app) === "url" ? "url" : "program", word = R.SECRETS_WORD[kind];
      const box = node("div", "ap-secret-edit"), err = node("p", "ap-err");
      err.id = uid("err");
      err.setAttribute("role", "alert");
      let nameIn = null;
      if (!name) {
        nameIn = textInput("ap-secret-name", 256);
        nameIn.placeholder = "名称";
        nameIn.setAttribute("aria-label", word + "的名称");
        nameIn.setAttribute("aria-describedby", err.id);
        nameIn.addEventListener("input", () => setText(err, ""));
      }
      const value = secretInput(name ? name + " 的新值" : word + "的值");
      value.input.setAttribute("aria-describedby", err.id);
      value.input.addEventListener("input", () => setText(err, ""));
      const save = button("primary ap-small", "保存", () => saveSecret(V)), drop = button("text-btn", "取消", () => closeSecret(V, true));
      const line = node("div", "ap-secret-line");
      if (nameIn) line.append(nameIn);
      line.append(value.wrap);
      const acts = node("div", "ap-secret-acts");
      acts.append(save, drop);
      box.append(...(name ? [node("code", "ap-secret-for", name)] : []), line, acts, err);
      const enter = (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); saveSecret(V); }
        else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeSecret(V, true); }
      };
      for (const input of [nameIn, value.input]) if (input) input.addEventListener("keydown", enter);
      V.secretEdit = { name, box, nameIn, value, save, drop, err, kind, saving: false };
      ease(card, () => paintApp(V));
      (nameIn || value.input).focus();
    }
    function closeSecret(V, refocus) {
      const E = V.secretEdit;
      if (!E || E.saving) return;
      V.secretEdit = null;
      ease(card, () => paintApp(V));
      if (!refocus) return;
      const swap = E.name ? [...V.names.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "换一个值：" + E.name) : null;
      (swap || (visible(V.addSecret) ? V.addSecret : V.state)).focus();
    }
    async function saveSecret(V) {
      const E = V.secretEdit;
      if (!E || E.saving) return;
      const app = S.apps.get(V.id);
      const name = E.name || R.trim(E.nameIn.value);
      if (!E.name) {
        const problem = R.secretNameProblem(name, E.kind)
          || ((app.source && app.source.secrets || []).some((n) => (E.kind === "url" ? n.toLowerCase() === name.toLowerCase() : n === name)) ? "已经有「" + name + "」了，用它旁边的「换一个值」" : "");
        if (problem) { setText(E.err, problem); E.nameIn.setAttribute("aria-invalid", "true"); E.nameIn.focus(); return; }
      }
      const vp = E.name ? R.secretValueProblem(E.value.input.value, true) : R.trim(E.value.input.value) ? R.secretValueProblem(E.value.input.value, false) : "填上值";
      if (vp) { setText(E.err, vp); E.value.input.setAttribute("aria-invalid", "true"); E.value.input.focus(); return; }
      E.saving = true;
      for (const input of [E.nameIn, E.value.input]) if (input) input.readOnly = true;
      E.save.disabled = E.drop.disabled = E.value.peek.disabled = true;
      setText(E.save, "正在保存…");
      S.notes.delete(V.id);
      const T = claim(V.id);
      let answer = null, error = null;
      try { answer = await call(R.path(V.id), { method: "PATCH", body: { secrets: { [name]: R.trim(E.value.input.value) } } }, T.ctrl); } catch (err) { error = err; }
      if (!T.mine()) return;
      release(V.id, T.token);
      E.saving = false;
      const held = card.contains(document.activeElement) || focusWasHeld();
      if (answer) {
        V.secretEdit = null;
        S.notes.set(V.id, { text: "「" + name + "」已保存。", bad: false });
        setApp(answer, "secret");
        settled(V.id);
        if (held && view === V) {
          const swap = [...V.names.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "换一个值：" + name);
          (swap || V.state).focus();
        }
        return;
      }
      const what = R.patchError(error, "secret");
      settled(V.id);
      if (what.kind === "gone") { goneApp(V.id); return; }
      for (const input of [E.nameIn, E.value.input]) if (input) input.readOnly = false;
      E.save.disabled = E.drop.disabled = E.value.peek.disabled = false;
      setText(E.save, "保存");
      setText(E.err, what.text);
      paintRow(V.id);
      if (view === V) paintApp(V);
      if (held && view === V) E.value.input.focus();
    }

    // 移除: permanent; the cats lose it from their next message. Confirmed in the app's own vocabulary.
    function confirmRemove(id, from) {
      const app = S.apps.get(id);
      if (!app || S.layer) return;
      const shade = node("div", "modal ap-confirm-shade"), box = node("form", "modal-card ap-confirm");
      box.setAttribute("novalidate", "");
      box.setAttribute("role", "alertdialog");
      box.setAttribute("aria-modal", "true");
      const h2 = node("h2", "", R.removeTitle(app.title)), text = node("p", "note", R.REMOVE_NOTE), err = node("p", "error");
      h2.id = uid("confirm");
      text.id = uid("confirm-text");
      box.setAttribute("aria-labelledby", h2.id);
      box.setAttribute("aria-describedby", text.id);
      err.setAttribute("role", "alert");
      err.hidden = true;
      const bar = node("div", "modal-actions"), no = button("secondary", "取消", () => done(true)), go = node("button", "secondary pf-danger", "移除");
      go.type = "submit";
      bar.append(no, go);
      box.append(h2, text, err, bar);
      shade.append(box);
      document.body.append(shade);
      root.inert = true;
      let busy = false, downOnShade = false;
      const C = S.layer = {
        remove() { shade.remove(); root.inert = false; if (S.layer === C) S.layer = null; },
      };
      function done(refocus) {
        if (busy) return;
        C.remove();
        if (refocus && from && from.isConnected) from.focus();
      }
      shade.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") { ev.preventDefault(); done(true); }
        else if (ev.key === "Tab") trapTab(ev, box);
        ev.stopPropagation();
      });
      shade.addEventListener("mousedown", (ev) => { downOnShade = ev.target === shade; });
      shade.addEventListener("click", (ev) => { if (ev.target === shade && downOnShade) done(true); downOnShade = false; });
      box.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (busy) return;
        busy = true;
        if (document.activeElement === go) box.focus();
        no.disabled = go.disabled = true;
        setText(go, "正在移除…");
        err.hidden = true;
        let error = null;
        try { await call(R.path(id), { method: "DELETE" }); } catch (e) { error = e; }
        if (!S.alive) return;
        busy = false;
        let what = error ? R.removeError(error) : null;
        // Unsure: the list read again says whether it is still there.
        if (what && what.kind === "unsure") { await readList("removed"); if (!S.alive) return; if (!S.apps.has(id)) what = null; }
        if (!what || what.kind === "gone") { C.remove(); removed(id); return; }
        no.disabled = go.disabled = false;
        setText(go, "移除");
        setText(err, what.text);
        err.hidden = false;
        go.focus();
      });
      no.focus();
    }
    // Gone from the engine: back to the list, focus on the row after it (or 添加自定义应用).
    function removed(id) {
      const at = S.order ? S.order.indexOf(id) : -1;
      forget(id);
      const nextId = S.order && S.order.length ? S.order[Math.min(Math.max(at, 0), S.order.length - 1)] : null;
      paintList();
      S.from = nextId || "add";
      if (view && view.name !== "list") goList();
      else (nextId && L.rows.get(nextId) ? L.rows.get(nextId).b : L.add).focus();
    }

    // ---------------------------------------------------------------- 添加自定义应用
    function openAdd() {
      S.from = "add";
      if (!S.draft) S.draft = addForm();
      const F = S.draft;
      show(F, () => F.nameF.input.focus());
    }
    function addForm() {
      const el = node("form", "ap-view ap-add");
      el.setAttribute("novalidate", "");
      const lead = node("p", "ap-lead", R.CUSTOM_LEAD);
      const nameF = field("名字", textInput("", R.NAME_MAX * 2));
      // The kind: two peers, one radio group (one Tab stop; arrows move).
      const kinds = node("div", "ap-kinds");
      kinds.setAttribute("role", "radiogroup");
      kinds.setAttribute("aria-label", "类型");
      const kindBtn = (kind, label, iconName) => {
        const b = button("ap-kind", null, () => setKind(kind, true));
        b.setAttribute("role", "radio");
        b.dataset.kind = kind;
        const tile = node("span", "ap-tile");
        tile.append(icon(iconName));
        b.append(tile, node("span", "", label));
        b.addEventListener("keydown", (ev) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(ev.key)) return;
          ev.preventDefault();
          const to = ev.key === "Home" ? "program" : ev.key === "End" ? "url" : kind === "program" ? "url" : "program";
          setKind(to, true);
          F.kindBtns[to].focus();
        });
        kinds.append(b);
        return b;
      };
      const kindBtns = { program: kindBtn("program", "本机程序", "terminal"), url: kindBtn("url", "网址", "globe") };
      // A program: what to run and its arguments, one per line.
      const programIn = textInput("", R.PROGRAM_MAX * 2);
      programIn.placeholder = "名称或路径";
      const programF = field("程序", programIn);
      const split = node("p", "ap-hint ap-split", "参数已经分到下面，每行一个。");
      split.hidden = true;
      programF.wrap.insertBefore(split, programF.err);
      const argsIn = node("textarea", "");
      argsIn.rows = 3;
      argsIn.spellcheck = false;
      argsIn.placeholder = "每行一个";
      const argsF = field("参数", argsIn);
      const program = node("div", "ap-kind-panel");
      program.dataset.kind = "program";
      // An address.
      const urlIn = textInput("", R.URL_MAX * 2);
      urlIn.type = "url";
      urlIn.placeholder = "https://";
      const urlF = field("网址", urlIn);
      const url = node("div", "ap-kind-panel");
      url.dataset.kind = "url";
      const secrets = { program: secretSet("program"), url: secretSet("url") };
      program.append(programF.wrap, argsF.wrap, secrets.program.el);
      url.append(urlF.wrap, secrets.url.el);
      // A whole command line pasted where the program goes is split for the owner, when that is unambiguous.
      programIn.addEventListener("paste", (ev) => {
        const text = ev.clipboardData && typeof ev.clipboardData.getData === "function" ? ev.clipboardData.getData("text") : "";
        const had = programIn.value || "";
        const all = had === "" || (programIn.selectionStart === 0 && programIn.selectionEnd === had.length);
        if (!all || R.trim(argsIn.value) || F.busy) return;
        const words = R.splitCommand(text);
        if (!words) return;
        ev.preventDefault();
        programIn.value = words[0];
        argsIn.value = words.slice(1).join("\n");
        programF.mark("");
        argsF.mark("");
        split.hidden = false;
      });
      programIn.addEventListener("input", () => { split.hidden = true; });
      const conseq = node("ul", "ap-conseq");
      conseq.id = uid("conseq");
      const error = node("p", "error ap-error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const twin = button("text-btn ap-twin", "");
      twin.hidden = true;
      const bar = node("div", "modal-actions");
      const cancelBtn = button("secondary", "取消", () => { if (F.busy) return; S.draft = null; S.from = "add"; goList(); });
      const go = node("button", "primary ap-go", "添加");
      go.type = "submit";
      go.setAttribute("aria-describedby", conseq.id);
      bar.append(cancelBtn, go);
      el.append(lead, nameF.wrap, kinds, program, url, conseq, error, twin, bar);
      el.addEventListener("submit", (ev) => { ev.preventDefault(); submitAdd(); });
      const F = {
        name: "add", id: null, el, title: "添加自定义应用", nameF, kinds, kindBtns, programF, argsF, urlF, program, url, secrets, split, conseq, error, twin, go, cancelBtn,
        kind: "program", busy: false, attempt: null,
        paint: () => {},
      };
      function setKind(kind, eased) {
        if (F.busy || (F.kind === kind && eased)) return;
        const change = () => {
          F.kind = kind;
          for (const [k, b] of Object.entries(kindBtns)) {
            b.setAttribute("aria-checked", String(k === kind));
            b.setAttribute("tabindex", k === kind ? "0" : "-1");
          }
          program.hidden = kind !== "program";
          url.hidden = kind !== "url";
          conseq.replaceChildren(...R.consequences(kind).map((t) => node("li", "", t)));
        };
        if (eased) ease(card, change); else change();
      }
      setKind("program", false);
      return F;
    }
    // Secrets as rows that appear on demand: a name and a masked value (显示 to peek), and × to drop the row.
    function secretSet(kind) {
      const word = R.SECRETS_WORD[kind];
      const el = node("fieldset", "ap-secrets"), legend = node("legend", "", word), rows = node("div", "ap-secret-rows");
      const add = button("text-btn ap-add-secret", null, () => { addRow(); });
      add.append(icon("plus"), node("span", "", "添加" + word));
      el.append(legend, rows, add);
      const T = { el, kind, list: [], legend, add };
      function paint() {
        legend.hidden = !T.list.length;
        add.hidden = T.list.length >= R.SECRETS_MAX;
      }
      function addRow() {
        const F = S.draft;
        if (F && F.busy) return;
        const row = node("div", "ap-secret"), nameIn = textInput("ap-secret-name", 256), err = node("p", "ap-err");
        nameIn.placeholder = "名称";
        nameIn.setAttribute("aria-label", word + "的名称");
        err.id = uid("err");
        nameIn.setAttribute("aria-describedby", err.id);
        const value = secretInput(word + "的值");
        value.input.setAttribute("aria-describedby", err.id);
        const drop = button("ghost ap-drop", null, () => {
          const at = T.list.indexOf(entry);
          ease(card, () => { T.list.splice(at, 1); row.remove(); paint(); });
          const next = T.list[at] || T.list[at - 1];
          (next ? next.nameIn : add).focus();
        });
        drop.setAttribute("aria-label", "删掉这一行");
        drop.dataset.tip = "删掉这一行";
        drop.append(icon("x"));
        const entry = { row, nameIn, value, drop, err, mark(text, which) {
          setText(err, text || "");
          for (const [k, input] of [["name", nameIn], ["value", value.input]]) {
            if (text && which === k) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
          }
        } };
        for (const input of [nameIn, value.input]) input.addEventListener("input", () => entry.mark(""));
        row.append(nameIn, value.wrap, drop, err);
        ease(card, () => { rows.append(row); T.list.push(entry); paint(); });
        nameIn.focus();
        return entry;
      }
      T.addRow = addRow;
      T.values = () => T.list.map((e) => ({ name: e.nameIn.value, value: e.value.input.value }));
      paint();
      return T;
    }
    function formValues(F) {
      return {
        name: F.nameF.input.value, kind: F.kind, program: F.programF.input.value, args: F.argsF.input.value, url: F.urlF.input.value,
        secrets: { program: F.secrets.program.values(), url: F.secrets.url.values() },
      };
    }
    function lockForm(F, on) {
      F.busy = on;
      if (on) hold();
      for (const f of [F.nameF, F.programF, F.argsF, F.urlF]) f.input.readOnly = on;
      for (const set of Object.values(F.secrets)) {
        set.add.disabled = on;
        for (const e of set.list) { e.nameIn.readOnly = e.value.input.readOnly = on; e.drop.disabled = on; }
      }
      for (const b of Object.values(F.kindBtns)) { if (on) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled"); }
      F.cancelBtn.disabled = F.go.disabled = F.twin.disabled = on;
    }
    function markForm(F, problems) {
      for (const f of [F.nameF, F.programF, F.argsF, F.urlF]) f.mark("");
      for (const set of Object.values(F.secrets)) for (const e of set.list) e.mark("");
      const set = F.secrets[F.kind];
      let first = null;
      for (const p of problems) {
        const f = { name: F.nameF, program: F.programF, args: F.argsF, url: F.urlF }[p.field];
        if (f) { if (!f.err.textContent) f.mark(p.text); first = first || f.input; continue; }
        const e = set.list[p.row];
        if (e && (p.field === "secret-name" || p.field === "secret-value")) {
          if (!e.err.textContent) e.mark(p.text, p.field === "secret-name" ? "name" : "value");
          first = first || (p.field === "secret-name" ? e.nameIn : e.value.input);
        } else if (p.field === "secrets") { sayForm(F, p.text); first = first || set.add; }
      }
      if (first) first.focus();
    }
    function sayForm(F, text, open) {
      setText(F.error, text || "");
      F.error.hidden = !text;
      F.twin.hidden = !open;
      if (open) {
        F.twin.replaceChildren("打开「" + R.trim(open.title) + "」");
        F.twin.onclick = () => openPage(open.id);
      }
    }
    async function submitAdd() {
      const F = S.draft;
      if (!F || F.busy) return;
      const { body, problems } = R.check(formValues(F));
      sayForm(F, "");
      if (problems.length) { markForm(F, problems); return; }
      markForm(F, []);
      // The same content again (an answer that was lost) goes under the same key; changed content is a new request.
      const print = R.fingerprint(body);
      if (!F.attempt || F.attempt.print !== print) F.attempt = { print, key: requestKey() };
      const known = new Set(S.order || []);
      lockForm(F, true);
      setText(F.go, "正在添加…");
      let app = null, error = null;
      try { app = await call("/xbot-api/apps/custom", { method: "POST", body: Object.assign({}, body, { idempotencyKey: F.attempt.key }) }); }
      catch (err) { error = err; }
      if (!S.alive) return;
      if (!app) {
        const what = R.addError(error);
        let twinApp = null;
        if (what.kind === "unsure") {
          // Read the list again before offering to send it again: it may be there already.
          setText(F.go, "正在核对…");
          await readList("added");
          if (!S.alive) return;
          const id = (S.order || []).find((x) => !known.has(x) && R.trim((S.apps.get(x) || {}).title) === body.name);
          twinApp = id ? S.apps.get(id) : null;
        } else F.attempt = null;
        lockForm(F, false);
        setText(F.go, "添加");
        sayForm(F, what.text, twinApp);
        if (S.draft === F && view === F) F.go.focus();
        return;
      }
      // 201: it is in the engine, whatever its state; its state is the check.
      if (S.draft === F) S.draft = null;
      if (S.order && !S.order.includes(app.id)) S.order.push(app.id);
      // Added is added: said plainly, not as a failure (the state line says it does not answer, and why).
      S.notes.set(app.id, { text: R.added(app), bad: false });
      setApp(app, "added");
      paintList();
      if (view === F) openPage(app.id);
      else announce("「" + R.trim(app.title) + "」" + R.added(app));
    }

    // ---- open ----
    const api = { close: () => close(), isOpen: () => S.alive, card };
    show(L);
    card.focus();
    readList("open");
    return api;
  }

  window.ClowderApps = Object.freeze({
    init: (value) => { H = value; },
    open,
    close: () => { if (D) D.close(); },
    isOpen: () => !!(D && D.isOpen()),
  });
})();
