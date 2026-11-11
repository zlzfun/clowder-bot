// Desktop notifications for a reply or a request that waits for the owner,
// behind one switch in 设置 → 通用 (classic script, window.ClowderNotify).
// Loads after chat-notify-rules.js and before app.js, which calls init() once,
// takes a ticket() before each status read (GET /xbot-api/bots/status, which
// it already polls), hands the answer to observe(data, ticket), and calls
// reset() on signing out. No server change, no other request.
//
// - The switch asks for the browser's permission when the owner turns it on,
//   and says plainly when the browser refused or has no notifications. The
//   choice takes effect at once on this page; remembering it in the browser
//   (localStorage) is separate, and a browser that cannot remember it is told
//   so. It is on only while the browser also allows it.
// - A notification only repeats what the status says: a cat's latest reply,
//   still unread, or a request for confirmation that newly appeared; with the
//   cat's name and the reply's first line, and no sound. Never for a chat the
//   owner is looking at in this tab or another tab of this page (tabs tell
//   each other which chat they show), never twice for the same message (tabs
//   take turns to claim it), nothing for what was there when the page first
//   read it, nothing from a read that began before signing out. Clicking it
//   focuses the tab and opens that chat.
// - It never touches the document title (the unread count there is the
//   contact list's).
(() => {
  "use strict";
  const N = window.ClowderNotifyRules;
  const KEY = "clowder-bot:notify";
  const SEEN = "clowder-bot:notified";
  const VIEW = "clowder-bot:notify-view";
  // How long another tab's word that it shows a chat holds (it repeats it with every status read).
  const FRESH = 15000;
  let H = null;
  let memory = new Map();
  const shown = new Set();
  const UI = { row: null, toggle: null, hint: null, said: null };
  // This page's own setting (null until read from the browser), and the
  // session generation: a status read from an earlier one is dropped.
  const S = { on: null, gen: 0, tab: Math.random().toString(36).slice(2) + Date.now().toString(36), bus: null };
  // What the other tabs said they show: tab → {key, at}.
  const others = new Map();

  const store = {
    get(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; } },
    // true when the browser kept it.
    set(k, v) { try { if (!window.localStorage) return false; window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  };
  const support = () => typeof window.Notification === "function";
  const permission = () => (support() ? String(window.Notification.permission || "default") : "denied");
  const chosen = () => { if (S.on === null) S.on = store.get(KEY) === "on"; return S.on; };
  const state = () => N.setting(chosen(), support(), permission());
  // On, and the browser allows it: the shell keeps reading the status while hidden.
  const wanted = () => state().on;

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------------------------------------------------------------- 通用
  // One row in 设置 → 通用: the switch, a short line, and what happened.
  function mount() {
    const pane = document.querySelector('[data-spane="general"]');
    if (!pane || UI.row) return;
    const sec = node("div", "setsec ck-notify");
    sec.append(node("h4", "", "通知"));
    const rows = node("div", "setrows");
    const row = node("div", "setrow");
    const tx = node("div", "tx");
    const title = node("b", "", "桌面通知");
    title.id = "ck-notify-title";
    const hint = node("div", "hint", "猫猫回复了，或有事等你确认时提醒你。正在看的聊天不提醒，没有声音。");
    hint.id = "ck-notify-hint";
    tx.append(title, hint);
    const toggle = node("button", "g7-switch");
    toggle.type = "button";
    toggle.id = "ck-notify-switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-labelledby", "ck-notify-title");
    toggle.setAttribute("aria-describedby", "ck-notify-hint ck-notify-said");
    toggle.addEventListener("click", flip);
    row.append(tx, toggle);
    rows.append(row);
    const said = node("p", "setfoot ck-notify-said");
    said.id = "ck-notify-said";
    said.setAttribute("role", "status");
    sec.append(rows, said);
    pane.append(sec);
    Object.assign(UI, { row, toggle, hint, said });
    paint();
  }
  function paint(message) {
    if (!UI.toggle) return;
    const s = state();
    UI.toggle.setAttribute("aria-checked", String(s.on));
    UI.said.textContent = message !== undefined ? message : s.hint;
    UI.said.hidden = !UI.said.textContent;
  }
  // The owner's choice holds on this page at once; whether the browser kept it is said.
  function choose(on) {
    S.on = on;
    return store.set(KEY, on ? "on" : "off");
  }
  async function flip() {
    const t = UI.toggle;
    if (t.getAttribute("aria-busy") === "true") return;
    if (state().on) { paint(N.turnedOff(choose(false))); return; }
    if (!support()) { paint("这个浏览器不支持桌面通知。"); return; }
    let answer = permission();
    if (answer === "default") {
      t.setAttribute("aria-busy", "true");
      try {
        // Older browsers answer through a callback instead of a promise.
        answer = await new Promise((done) => {
          const p = window.Notification.requestPermission(done);
          if (p && typeof p.then === "function") p.then(done, () => done("default"));
        });
      } catch (e) { answer = "default"; }
      t.removeAttribute("aria-busy");
    }
    const r = N.asked(String(answer));
    const kept = choose(r.on);
    paint(N.asked(String(answer), kept).said);
  }

  // ------------------------------------------------------- the other tabs
  // The chat this tab shows, if the owner can see it.
  function viewing() {
    const sel = document.visibilityState === "visible" && H ? H.selection() : null;
    return sel && sel.id ? N.keyOf(sel.type === "group" ? "group" : "bot", sel.id, sel.nativeId) : "";
  }
  // Another tab said which chat it shows, or that it announced a note.
  function heard(m) {
    if (!m || typeof m !== "object" || m.tab === S.tab || typeof m.tab !== "string") return;
    if (typeof m.claim === "string") { shown.add(m.claim); return; }
    others.set(m.tab, { key: typeof m.key === "string" ? m.key : "", at: Date.now() });
  }
  // Tells the other tabs which chat this one shows ("" when hidden or none).
  function tell() {
    const m = { tab: S.tab, key: viewing() };
    if (S.bus) { try { S.bus.postMessage(m); return; } catch (e) { /* fall back to storage */ } }
    store.set(VIEW, JSON.stringify({ ...m, at: Date.now() }));
  }
  const seenElsewhere = (key) => [...others.values()].some((o) => o.key === key && Date.now() - o.at < FRESH);

  // ------------------------------------------------------------ the status
  const ticket = () => S.gen;
  // Signing out: nothing read before counts afterwards.
  function reset() { S.gen++; memory = new Map(); }
  // Every status answer: what is new since the last one, and for whom.
  function observe(data, at) {
    if (at !== undefined && at !== S.gen) return;
    if (H.signedIn && !H.signedIn()) return;
    tell();
    const here = viewing();
    const out = N.decide(memory, N.chats(data), (key) => key === here || seenElsewhere(key));
    memory = out.memory;
    if (!wanted()) return;
    const gen = S.gen;
    for (const note of out.notes) claim(note, gen);
  }
  // Tabs take turns (the browser's own lock where it has one), so the check
  // and the record of what was announced cannot interleave between them: the
  // tab that claims a note tells the others at once and keeps its turn a
  // moment, so the next tab to check has heard of the claim.
  const HOLD = 250;
  function claim(note, gen) {
    const run = async () => {
      if (gen !== S.gen || !wanted() || seenElsewhere(note.key) || announced(note.tag)) return;
      if (S.bus) { try { S.bus.postMessage({ tab: S.tab, claim: note.tag }); } catch (e) { /* storage still says it */ } }
      show(note);
      await new Promise((done) => setTimeout(done, HOLD));
    };
    const locks = typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function" ? navigator.locks : null;
    if (locks) return Promise.resolve(locks.request("clowder-bot:notify", run)).catch(() => {});
    return run();
  }
  // What was announced, by this tab and (kept briefly in this browser) the others.
  function announced(tag) {
    if (shown.has(tag)) return true;
    let list = [];
    try { list = JSON.parse(store.get(SEEN) || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    shown.add(tag);
    if (list.includes(tag)) return true;
    store.set(SEEN, JSON.stringify([...list, tag].slice(-200)));
    return false;
  }
  function show(note) {
    const w = N.words(note, H.chatName ? H.chatName(note) : "");
    let n = null;
    try {
      n = new window.Notification(w.title, { body: w.body, tag: "clowder-bot:" + note.tag, silent: true, icon: "/icon-192.png" });
    } catch (e) { return; /* a browser that only notifies through a service worker */ }
    n.onclick = () => {
      try { window.focus(); } catch (e) { /* the browser decides */ }
      H.open(note);
      if (typeof n.close === "function") n.close();
    };
  }

  // -------------------------------------------------------------------- init
  // Hooks from app.js:
  //   selection()     the open chat ({type, id, nativeId}), null while none is in view;
  //   signedIn()      the owner is signed in;
  //   open(note)      open that note's chat (a cat found by its native ID) and what it points at;
  //   chatName(note)  a group's name, for the title.
  function init(hooks) {
    H = hooks;
    mount();
    if (typeof window.BroadcastChannel === "function") {
      try { S.bus = new window.BroadcastChannel("clowder-bot:notify"); S.bus.onmessage = (ev) => heard(ev.data); } catch (e) { S.bus = null; }
    }
    if (typeof window.addEventListener === "function") {
      window.addEventListener("storage", (ev) => {
        if (ev.key === VIEW && ev.newValue) { try { heard(JSON.parse(ev.newValue)); } catch (e) { /* not ours */ } }
        // Turned on or off in another tab of this page.
        if (ev.key === KEY) { S.on = ev.newValue === "on"; paint(); }
      });
      // Closing: the other tabs stop counting this one at once.
      window.addEventListener("pagehide", () => { if (S.bus) { try { S.bus.postMessage({ tab: S.tab, key: "" }); } catch (e) { /* closing */ } } });
    }
    // The browser's permission can change behind the page (site settings);
    // the other tabs learn at once that this one is hidden or shown.
    document.addEventListener("visibilitychange", () => { tell(); if (document.visibilityState === "visible") paint(); });
    tell();
  }

  window.ClowderNotify = Object.freeze({ init, observe, ticket, reset, wanted, paint, tell });
})();
