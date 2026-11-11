// The live parts of the guide to what clowder-bot can do (showcase/index.html).
// Everything here only reads: the cats' faces come from the product's own
// cat-avatars.js, and when the page is served by `npm run showcase` the
// contact list shows what the staged chats say right now, worded by the
// product's own chat-list-rules.js, from the same reads the app's sidebar makes
// (GET /xbot-api/bots, /xbot-api/groups, /xbot-api/bots/status). Without them
// (the page opened on its own, or another preview behind it) the page reads as
// it is and says how to start the staged chats.
//
// Two actions open a chat: 打开这个对话 is a link to /#chat=<name> (the app opens
// that cat or group chat); 看它现场演示 first asks the showcase to send that
// chat's demo line (POST /__preview {"play": name}) and then opens it, so the
// visitor arrives while the cat is still writing. Browser Back comes here again.
// A chat opened from here gets a paw stamped on its face in the list (kept for
// this tab only).
(function () {
  "use strict";
  // Opened from the checkout (file://), the product's files are next door in client/public.
  const ROOT = location.protocol === "file:" ? "../client/public/" : "/";
  const served = location.protocol === "http:" || location.protocol === "https:";
  // The staged chats (scripts/showcase-scene.ts): each cat's face is its engine template.
  const FACES = { 布偶猫: "ragdoll", 缅因猫: "maine-coon", 暹罗猫: "siamese", 梵花猫: "turkish-van", 小鲸鱼: "dsh", 狸花猫: "dragon-li", 孟加拉猫: "bengal", 金渐层: "golden-chinchilla" };
  const GROUPS = ["产品评审", "读书会"];
  const POLL_MS = 8000;
  const reduce = () => !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

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
      $(".t-row-name", row).after(node("span", "t-vh", "（打开过）"));
      if (fresh) landing.observe(row);
    }
    store.write(STAMPED, Array.from(new Set([...stamped, ...seen])));
  }

  // ------------------------------------------------------- the live reads
  const S = { live: false, bots: [], groups: [], timer: 0 };
  async function get(path) {
    const r = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(path + " " + r.status);
    return r.json();
  }
  async function readAll() {
    if (!served) return false;
    try {
      const [bots, groups] = await Promise.all([get("/xbot-api/bots"), get("/xbot-api/groups")]);
      S.bots = Array.isArray(bots && bots.bots) ? bots.bots : [];
      S.groups = Array.isArray(groups && groups.groups) ? groups.groups : [];
      // The staged chats are there only if every staged cat and group is.
      const names = new Set(S.bots.map((b) => b.name)), titles = new Set(S.groups.map((g) => g.name));
      if (!Object.keys(FACES).every((n) => names.has(n)) || !GROUPS.every((n) => titles.has(n))) return false;
      for (const b of S.bots) {
        const seed = /^cat:([\w-]+)$/.exec(String(b.avatar_seed || ""));
        if (seed) faces[b.name] = seed[1]; else if (b.templateId) faces[b.name] = b.templateId;
      }
      await readStatus();
      return true;
    } catch (e) {
      return false;
    }
  }
  async function readStatus() {
    const status = await get("/xbot-api/bots/status");
    paintRows(status);
  }

  const accentOf = (b) => { const c = b && b.accent && b.accent.primary; return /^#[0-9a-f]{6}$/i.test(String(c || "")) ? c : ""; };
  function paintRows(status) {
    const R = window.ClowderListRules;
    if (!R) return;
    const now = Date.now();
    for (const row of $$(".t-row")) {
      const name = row.dataset.row, group = !!row.dataset.group;
      const g = group ? S.groups.find((x) => x.name === name) : null;
      const entry = group ? (status.groups || []).find((x) => g && x.id === g.id) : (status.bots || []).find((x) => x.bot === name);
      if (!entry) continue;
      const a = entry.activity || {}, counts = a.counts || {};
      const l = R.last(entry), u = R.unread(entry), badge = R.badge(u);
      const time = $(".t-row-time", row);
      time.textContent = l ? R.ago(l.time, now) : "";
      if (l) { time.setAttribute("datetime", new Date(l.time).toISOString()); time.title = R.stamp(l.time); }
      const line = $(".t-row-line", row), sub = $(".t-row-sub", row);
      if (!line.dataset.about) line.dataset.about = line.textContent;
      const busy = (counts.running || 0) > 0 || (Array.isArray(a.active) && a.active.length > 0);
      const waiting = entry.state === "awaiting" || (counts.approval || 0) > 0;
      if (busy) {
        const paws = node("span", "t-paws");
        paws.setAttribute("aria-hidden", "true");
        paws.append(node("i"), node("i"), node("i"));
        line.replaceChildren(paws, document.createTextNode("正在输入…"));
      } else if (waiting) line.replaceChildren(node("span", "t-row-wait", "等你确认"));
      else line.textContent = R.preview(l, group) || line.dataset.about;
      let count = $(".t-row-count", row);
      if (badge) {
        if (!count) { count = node("span", "t-row-count"); sub.append(count); }
        count.textContent = badge;
        count.setAttribute("aria-label", badge + " 条新回复");
      } else if (count) count.remove();
      const box = $(".t-row-face", row);
      let dot = $(".t-row-dot", box);
      if (u.n > 0 && !dot) { dot = node("span", "t-row-dot"); box.append(dot); }
      else if (!u.n && dot) dot.remove();
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

  function setLive(live) {
    S.live = live;
    const chip = $("#live"), text = $(".t-live-text", chip);
    chip.classList.add("on");
    chip.classList.toggle("up", live);
    text.textContent = live ? "示例对话在运行" : "示例对话没在运行";
    $("#off").classList.toggle("on", !live);
    for (const box of $$(".t-actions")) box.hidden = !live;
  }

  // ---------------------------------------------------------- the actions
  function wireActions() {
    for (const a of $$("[data-chat]")) a.href = "/#chat=" + encodeURIComponent(a.dataset.chat);
    for (const a of $$("[data-app]")) a.href = "/";
    document.addEventListener("click", (ev) => {
      const a = ev.target.closest && ev.target.closest("a[data-chat]");
      if (!a || !S.live) return;
      saw(a.dataset.chat);
      if (!a.dataset.play) return;
      // A new tab or window: the demo starts and the tab opens the chat on its own.
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) { play(a.dataset.play).catch(() => {}); return; }
      ev.preventDefault();
      if (a.getAttribute("aria-busy") === "true") return;
      start(a);
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
  async function start(a) {
    const note = $(".t-note", a.closest(".t-copy"));
    if (!a.dataset.label) a.dataset.label = a.textContent;
    a.setAttribute("aria-busy", "true");
    a.textContent = "正在开始…";
    if (note) note.textContent = "";
    try {
      await play(a.dataset.play);
      location.assign(a.href);
    } catch (e) {
      a.removeAttribute("aria-busy");
      a.textContent = a.dataset.label;
      if (note) note.textContent = "没能开始演示：" + e.message + "。可以先打开这个对话看看。";
    }
  }
  function settleButtons() {
    for (const a of $$("a[aria-busy]")) { a.removeAttribute("aria-busy"); if (a.dataset.label) a.textContent = a.dataset.label; }
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

  // ------------------------------------------------------------- start up
  // While the staged chats run: what they say now. When they were not running,
  // only coming back to the page looks again (not every few seconds).
  async function refresh(again = false) {
    if (!S.live) { if (again && served) setLive(await readAll()); return; }
    try { await readStatus(); } catch (e) { setLive(await readAll()); }
  }
  async function boot() {
    wireActions();
    reveal();
    backToList();
    const product = Promise.allSettled([load(ROOT + "cat-avatars.js"), load(ROOT + "chat-list-rules.js")]);
    await product;
    paintFaces();
    paintStamps();
    setLive(await readAll());
    paintFaces();
    clearInterval(S.timer);
    S.timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(true).then(paintFaces); });
    // Back from a chat (the page comes out of the browser's cache): the new stamp, and what the chat says now.
    window.addEventListener("pageshow", (ev) => {
      if (!ev.persisted) return;
      settleButtons();
      paintStamps();
      refresh(true);
    });
  }
  boot();
})();
