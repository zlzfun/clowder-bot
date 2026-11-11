// Desktop notifications for a reply or a request that waits for the owner,
// behind one switch in 设置 → 通用 (classic script, window.ClowderNotify).
// Loads after chat-notify-rules.js and before app.js, which calls init() once
// and observe() with every status answer it already polls
// (GET /xbot-api/bots/status). No server change, no other request.
//
// - The switch asks for the browser's permission when the owner turns it on,
//   and says plainly when the browser refused or has no notifications. It is
//   remembered in this browser (localStorage); it is on only while the
//   browser also allows it.
// - A notification only repeats what the status says: a cat's latest reply,
//   still unread, or a request for confirmation that newly appeared; with the
//   cat's name and the reply's first line, and no sound. Never for the chat
//   the owner is looking at (visible tab, that chat open), never twice for the
//   same message (this page and other tabs of it), nothing for what was there
//   when the page opened. Clicking it focuses the tab and opens that chat.
// - It never touches the document title (the unread count there is the
//   contact list's).
(() => {
  "use strict";
  const N = window.ClowderNotifyRules;
  const KEY = "clowder-bot:notify";
  const SEEN = "clowder-bot:notified";
  let H = null;
  let memory = new Map();
  const shown = new Set();
  const UI = { row: null, toggle: null, hint: null, said: null };

  const store = {
    get(k) { try { return window.localStorage ? window.localStorage.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { if (window.localStorage) window.localStorage.setItem(k, v); } catch (e) { /* private mode: this page only */ } },
  };
  const support = () => typeof window.Notification === "function";
  const permission = () => (support() ? String(window.Notification.permission || "default") : "denied");
  const stored = () => store.get(KEY) === "on";
  const state = () => N.setting(stored(), support(), permission());
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
  async function flip() {
    const t = UI.toggle;
    if (t.getAttribute("aria-busy") === "true") return;
    if (state().on) { store.set(KEY, "off"); paint("已关闭。"); return; }
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
    store.set(KEY, r.on ? "on" : "off");
    paint(r.said);
  }

  // ------------------------------------------------------------ the status
  // Every status answer: what is new since the last one, and for whom.
  function observe(data) {
    const sel = H.selection();
    const inView = document.visibilityState === "visible" && sel ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "";
    const out = N.decide(memory, N.chats(data), inView);
    memory = out.memory;
    if (!wanted()) return;
    for (const note of out.notes) show(note);
  }
  // Across this page's tabs: what was announced, kept briefly in this browser.
  function announced(tag) {
    if (shown.has(tag)) return true;
    let list = [];
    try { list = JSON.parse(store.get(SEEN) || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    if (list.includes(tag)) { shown.add(tag); return true; }
    shown.add(tag);
    store.set(SEEN, JSON.stringify([...list, tag].slice(-200)));
    return false;
  }
  function show(note) {
    if (announced(note.tag)) return;
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
  //   selection()     the open chat ({type, id}), null while none is in view;
  //   open(note)      open that note's chat (and find what it points at);
  //   chatName(note)  a group's name, for the title.
  function init(hooks) {
    H = hooks;
    mount();
    // The browser's permission can change behind the page (site settings).
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") paint(); });
  }

  window.ClowderNotify = Object.freeze({ init, observe, wanted, paint });
})();
