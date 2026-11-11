// The live parts of the guide to what clowder-bot can do (showcase/index.html).
// Everything here only reads: the cats' faces come from the product's own
// cat-avatars.js. Whether the staged chats are behind the page is what the
// scripted preview itself says (GET /__preview: the showcase, staged); then
// the contact list shows what they say right now, worded by the product's own
// chat-list-rules.js, from the same reads the app's sidebar makes
// (GET /xbot-api/bots, /xbot-api/groups, /xbot-api/bots/status). Without them
// (the page opened on its own, the plain preview, anything else) the page reads
// as it is and says how to start the staged chats. The rules are in
// tour-rules.js.
//
// Two actions open a chat: 打开这个对话 is a link to /#chat=<name> (the app opens
// that cat or group chat); 看它现场演示 is a button: it asks the showcase to
// send that chat's demo line (POST /__preview {"play": name}) and then opens
// the chat, so the visitor arrives while the cat is still writing. It is only
// offered for the chats the showcase can play. Browser Back comes here again.
// A chat opened from here gets a paw stamped on its face in the list (kept for
// this tab only).
(function () {
  "use strict";
  const T = window.ClowderTourRules;
  // Opened from the checkout (file://), the product's files are next door in client/public.
  const ROOT = location.protocol === "file:" ? "../client/public/" : "/";
  const served = location.protocol === "http:" || location.protocol === "https:";
  // The staged chats (scripts/showcase-scene.ts): each cat's face is its engine template.
  const FACES = { 布偶猫: "ragdoll", 缅因猫: "maine-coon", 暹罗猫: "siamese", 梵花猫: "turkish-van", 小鲸鱼: "dsh", 狸花猫: "dragon-li", 孟加拉猫: "bengal", 金渐层: "golden-chinchilla" };
  const POLL_MS = 8000, READ_MS = 6000;
  const reduce = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const chatLink = (name) => "/#chat=" + encodeURIComponent(name);

  function load(src) {
    return new Promise((done, fail) => {
      const s = document.createElement("script");
      s.src = src; s.onload = () => done(); s.onerror = () => fail(new Error(src));
      document.head.append(s);
    });
  }

  // ------------------------------------------------------------------ faces
  let faces = { ...FACES };
  function portrait(face) {
    const A = window.ClowderAvatars;
    if (!A) return null;
    const svg = A.createPortrait("cat:" + face, face, "");
    if (ROOT !== "/") for (const img of svg.querySelectorAll("image")) img.setAttribute("href", ROOT + String(img.getAttribute("href")).replace(/^\//, ""));
    return svg;
  }
  function paintFaces() {
    for (const row of $$(".t-row")) {
      const box = $(".t-row-face", row);
      if (!box || box.querySelector("svg")) continue;
      if (row.dataset.group) huddle(box, row.dataset.group);
      else if (faces[row.dataset.row]) { const p = portrait(faces[row.dataset.row]); if (p) box.prepend(p); }
    }
    for (const box of $$(".t-host-face")) {
      if (box.querySelector("svg")) continue;
      if (box.dataset.group) huddle(box, box.dataset.group);
      else { const p = portrait(box.dataset.face); if (p) box.append(p); }
    }
  }
  function huddle(box, members) {
    const list = members.split(/\s+/).filter((m) => faces[m]).slice(0, 4);
    box.classList.add("t-huddle", "n" + list.length);
    for (const m of list) { const p = portrait(faces[m]); if (p) box.append(p); }
  }

  // ------------------------------------------------------------ the stamps
  const store = {
    read(key) { try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (e) { return []; } },
    write(key, list) { try { sessionStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* private window: no stamps */ } },
  };
  const SEEN = "clowder-tour:seen", STAMPED = "clowder-tour:stamped";
  function saw(name) {
    const seen = store.read(SEEN);
    if (!seen.includes(name)) store.write(SEEN, [...seen, name]);
  }
  // A new stamp lands once, when its row is in view (coming back, the page is
  // where the visitor left it, often further down).
  const landing = "IntersectionObserver" in window ? new IntersectionObserver((list) => {
    for (const e of list) {
      if (!e.isIntersecting) continue;
      const stamp = $(".t-stamp.t-wait", e.target);
      if (stamp) { stamp.classList.remove("t-wait"); stamp.classList.add("t-new"); }
      landing.unobserve(e.target);
    }
  }, { threshold: 0.6 }) : null;
  function paintStamps() {
    const seen = store.read(SEEN), stamped = store.read(STAMPED);
    for (const row of $$(".t-row")) {
      const name = row.dataset.row, box = $(".t-row-face", row);
      if (!box || !seen.includes(name) || box.querySelector(".t-stamp")) continue;
      const fresh = !stamped.includes(name) && !reduce() && landing;
      box.append(node("span", "t-stamp" + (fresh ? " t-wait" : "")));
      $(".t-row-name", row).append(node("span", "t-vh", "（打开过）"));
      if (fresh) landing.observe(row);
    }
    store.write(STAMPED, Array.from(new Set([...stamped, ...seen])));
  }

  // ------------------------------------------------------- the live reads
  const S = { live: false, bots: [], groups: [], plays: new Set() };
  async function get(path, signal) {
    const r = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, signal });
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  }
  const identity = (signal) => get("/__preview", signal).catch(() => null);
  // One read: while the staged chats are known to run, what they say now; else
  // whether they run (and then everything). A failed read changes nothing on
  // screen, unless the preview itself no longer says the chats are staged.
  async function read({ signal, current }) {
    if (!S.live) {
      const id = await identity(signal);
      if (!current()) return;
      if (!T.staged(id)) { setLive(false); return; }
      const [bots, groups, status] = await Promise.all([get("/xbot-api/bots", signal), get("/xbot-api/groups", signal), get("/xbot-api/bots/status", signal)]);
      if (!current()) return;
      S.bots = Array.isArray(bots && bots.bots) ? bots.bots : [];
      S.groups = Array.isArray(groups && groups.groups) ? groups.groups : [];
      S.plays = T.plays(id);
      for (const b of S.bots) {
        const seed = /^cat:([\w-]+)$/.exec(String(b.avatar_seed || ""));
        if (seed) faces[b.name] = seed[1]; else if (b.templateId) faces[b.name] = b.templateId;
      }
      setLive(true);
      paintRows(status);
      return;
    }
    let status;
    try { status = await get("/xbot-api/bots/status", signal); }
    catch (e) {
      if (!current()) return; // given up (too slow) or superseded: nothing is concluded
      const id = await identity(signal);
      if (current() && !T.staged(id)) setLive(false);
      return;
    }
    if (current()) paintRows(status);
  }
  const reads = T.serial(read, { ms: READ_MS, visible: () => document.visibilityState !== "hidden" });

  const accentOf = (b) => { const c = b && b.accent && b.accent.primary; return /^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : ""; };
  function paintRows(status) {
    const R = window.ClowderListRules;
    if (!R || !status || typeof status !== "object") return;
    const now = Date.now();
    for (const row of $$(".t-row")) {
      const name = row.dataset.row, group = !!row.dataset.group;
      const g = group ? S.groups.find((x) => x.name === name) : null;
      const entry = group ? (status.groups || []).find((x) => g && x.id === g.id) : (status.bots || []).find((x) => x.bot === name);
      const view = entry ? T.rowView(entry, group, R, now) : null;
      // Not read whole: the row keeps what it showed (on first load, its own line).
      if (!view) continue;
      const time = $(".t-row-time", row);
      time.textContent = view.time;
      if (view.iso) { time.setAttribute("datetime", view.iso); time.title = view.stamp; }
      const line = $(".t-row-line", row), sub = $(".t-row-sub", row);
      if (view.line === "busy") {
        const paws = node("span", "t-paws");
        paws.setAttribute("aria-hidden", "true");
        paws.append(node("i"), node("i"), node("i"));
        line.replaceChildren(paws, document.createTextNode("正在输入…"));
      } else if (view.line === "waiting") line.replaceChildren(node("span", "t-row-wait", "等你确认"));
      else line.textContent = view.said || about(line);
      let count = $(".t-row-count", row);
      if (view.badge) {
        if (!count) { count = node("span", "t-row-count"); sub.append(count); }
        count.textContent = view.badge;
        count.setAttribute("aria-label", view.badge + " 条新回复");
      } else if (count) count.remove();
      const box = $(".t-row-face", row);
      let dot = $(".t-row-dot", box);
      if (view.dot && !dot) { dot = node("span", "t-row-dot"); box.append(dot); }
      else if (!view.dot && dot) dot.remove();
      // The cat's own colour (for its paws here, and behind its picture below).
      const accent = group ? "" : accentOf(S.bots.find((b) => b.name === name));
      if (accent) row.style.setProperty("--t-accent", accent);
    }
    for (const section of $$("[data-host]")) {
      const accent = accentOf(S.bots.find((b) => b.name === section.dataset.host));
      if (!accent) continue;
      section.style.setProperty("--t-accent", accent);
      section.classList.add("t-tinted");
    }
  }
  // A row's own line (what that chat shows), kept from the page as written.
  function about(line) {
    if (line.dataset.about == null) line.dataset.about = line.textContent;
    return line.dataset.about;
  }
  // Not running any more: each row says what it shows again, claiming nothing about the chats.
  function plainRows() {
    for (const row of $$(".t-row")) {
      const line = $(".t-row-line", row);
      line.textContent = about(line);
      const time = $(".t-row-time", row);
      time.textContent = ""; time.removeAttribute("datetime"); time.title = "";
      for (const n of $$(".t-row-count, .t-row-dot", row)) n.remove();
    }
  }

  function setLive(live) {
    const was = S.live;
    S.live = live;
    const chip = $("#live"), text = $(".t-live-text", chip);
    chip.classList.add("on");
    chip.classList.toggle("up", live);
    text.textContent = live ? "示例对话在运行" : "示例对话没在运行";
    $("#off").classList.toggle("on", !live);
    for (const box of $$(".t-actions")) box.hidden = !live;
    for (const b of $$("button[data-play]")) b.hidden = !(live && S.plays.has(b.dataset.play));
    if (was && !live) { reads.reset(); plainRows(); }
  }

  // ---------------------------------------------------------- the actions
  function wireActions() {
    for (const a of $$("a[data-chat]")) a.href = chatLink(a.dataset.chat);
    for (const a of $$("[data-app]")) a.href = "/";
    for (const b of $$("button[data-play]")) b.hidden = true;
    document.addEventListener("click", (ev) => {
      const t = ev.target && ev.target.closest ? ev.target : null;
      const button = t && t.closest("button[data-play]");
      if (button) { if (S.live) start(button); return; }
      const a = t && t.closest("a[data-chat]");
      if (a && S.live) saw(a.dataset.chat);
    });
  }
  async function play(name) {
    let r;
    try {
      r = await fetch("/__preview", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ play: name }) });
    } catch (e) { throw new Error("连不上示例对话"); }
    if (r.ok) return;
    throw new Error(r.status === 404 ? "示例里没有这个对话" : "示例没有收下这句话（" + r.status + "）");
  }
  // One demo per press: the button is busy until the chat opens (or the showcase said no).
  async function start(button) {
    if (button.getAttribute("aria-busy") === "true") return;
    const name = button.dataset.play, note = $(".t-note", button.closest(".t-copy"));
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.setAttribute("aria-busy", "true");
    button.textContent = "正在开始…";
    if (note) note.textContent = "";
    try {
      await play(name);
      saw(name);
      location.assign(chatLink(name));
    } catch (e) {
      button.removeAttribute("aria-busy");
      button.textContent = button.dataset.label;
      if (note) note.textContent = "没能开始演示：" + e.message + "。可以先打开这个对话看看。";
    }
  }
  function settleButtons() {
    for (const b of $$("button[aria-busy]")) { b.removeAttribute("aria-busy"); if (b.dataset.label) b.textContent = b.dataset.label; }
  }

  // ------------------------------------------------------------ the motion
  function reveal() {
    const items = $$(".t-reveal");
    if (!("IntersectionObserver" in window)) { for (const n of items) n.classList.add("t-in"); return; }
    const io = new IntersectionObserver((list) => {
      for (const e of list) if (e.isIntersecting) { e.target.classList.add("t-in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    for (const n of items) io.observe(n);
  }
  function backToList() {
    const back = $("#back"), roster = $("#roster");
    if (!back || !roster) return;
    back.addEventListener("click", (ev) => {
      ev.preventDefault();
      roster.scrollIntoView({ behavior: reduce() ? "auto" : "smooth", block: "start" });
      roster.focus({ preventScroll: true });
    });
    if (!("IntersectionObserver" in window)) return;
    new IntersectionObserver(([e]) => { back.hidden = e.isIntersecting || e.boundingClientRect.top > 0; }).observe(roster);
  }
  // Printed (or saved as PDF): every section shown (the pictures are loaded with the page).
  function printable() {
    window.addEventListener("beforeprint", () => { for (const n of $$(".t-reveal")) n.classList.add("t-in"); });
  }

  // ------------------------------------------------------------- start up
  async function boot() {
    wireActions();
    reveal();
    backToList();
    printable();
    for (const line of $$(".t-row-line")) about(line);
    await Promise.allSettled([load(ROOT + "cat-avatars.js"), load(ROOT + "chat-list-rules.js")]);
    paintFaces();
    paintStamps();
    // Until the first read the page claims nothing either way (a hidden tab reads when it is seen).
    if (!served) setLive(false);
    else await reads.refresh();
    paintFaces();
    // While the staged chats run, what they say now (only while the page is seen);
    // when they did not, only coming back to the page looks again.
    setInterval(() => { if (S.live) reads.refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && served) reads.refresh().then(paintFaces); });
    // Back from a chat (the page comes out of the browser's cache): the new stamp, and what the chat says now.
    window.addEventListener("pageshow", (ev) => {
      if (!ev.persisted) return;
      settleButtons();
      paintStamps();
      if (served) reads.refresh();
    });
  }
  boot();
})();
