// A chat that feels alive (classic script, window.ClowderPresence). Loads
// after chat-presence-rules.js and chat-live.js, before app.js, which calls
// init() once and then:
//   rows(roster)        after each status repaint of the sidebar;
//   rendered(messages)  right after each keyed redraw of the open chat's
//                       history (the rows it was drawn from).
// What it shows, all from facts the page already has:
//   - under the cat's name in the header, 正在输入… / 在查资料… / 在想… while
//     the engine writes a reply: chat-live.js's own replies (watched), so the
//     header, the reply row and its quiet line always agree;
//   - typing dots on a sidebar row while its cat replies: the open chat from
//     those same replies, any other chat from the status poll;
//   - each cat's own colour where it stays legible (one style element keyed
//     by the speaker the history already writes on each row);
//   - a paw by the owner's latest message the engine picked up (a reply that
//     names it in native.replyTo exists), stamped once when it first appears;
//   - the palette's and the drawer scrim's exit: the real element hides at
//     once (focus, inert and every check unchanged) and a copy fades out.
// The typing paws themselves are CSS only (chat-presence.css). Nothing here
// is a record, a timer of its own or a request.
(() => {
  "use strict";
  const R = window.ClowderPresenceRules;
  let H = null;
  const SVG = "http://www.w3.org/2000/svg";
  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const kids = (n) => (n && n.children ? [...n.children] : []);
  const has = (n, cls) => !!(n && n.classList && n.classList.contains(cls));

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // The open chat as chat-live.js and the history name it (app.js chatKey).
  const keyOf = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const selected = () => (H && H.selected ? H.selected() : null);
  const nameOf = (catId) => (H && H.catName ? String(H.catName(catId) || "") : "");
  const verb = (tool) => { const L = window.ClowderLiveRules; return L && typeof L.verb === "function" ? L.verb(tool) : ""; };

  // ------------------------------------------------------- the cats' colours
  // The surfaces a colour is judged on, from the current theme's tokens
  // (read again only when the theme changes).
  let sheet = null, sheetText = null, surfacesAt = null, surfacesFor = null;
  function surfaces() {
    if (H.surfaces) return H.surfaces();
    const root = document.documentElement;
    if (!root || typeof window.getComputedStyle !== "function") return {};
    const theme = root.getAttribute("data-theme") || "";
    if (surfacesAt && surfacesFor === theme) return surfacesAt;
    const cs = window.getComputedStyle(root);
    surfacesAt = { chat: cs.getPropertyValue("--x-card").trim(), bubble: cs.getPropertyValue("--x-bot-bubble").trim() };
    surfacesFor = theme;
    return surfacesAt;
  }
  function colours() {
    if (!H) return;
    const css = R.accentCss(H.bots ? H.bots() || [] : [], surfaces());
    if (css === sheetText) return;
    sheetText = css;
    if (!sheet) {
      sheet = node("style");
      sheet.id = "pz-accents";
      (document.head || document.body).append(sheet);
    }
    sheet.textContent = css;
  }

  // -------------------------------------------------------------- the header
  function liveWords() {
    const sel = selected();
    if (!sel || !H.live || typeof H.live.presence !== "function") return "";
    const now = H.live.presence();
    if (!now || now.key !== keyOf(sel)) return "";
    return R.headerLine(now, nameOf, sel.type === "group", verb);
  }
  let sub = null;
  function header(words) {
    const chip = H.chip;
    if (!chip) return;
    if (!sub || sub.parentElement !== chip) {
      sub = node("span", "pz-sub");
      sub.setAttribute("aria-hidden", "true"); // the reply's own quiet line is the announced one
      chip.append(sub);
    }
    // The last words stay while the line fades out.
    if (words && sub.textContent !== words) sub.textContent = words;
    chip.classList.toggle("pz-on", !!words);
  }

  // ------------------------------------------------------------- the sidebar
  function dots() {
    const d = node("span", "pz-dots");
    d.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) d.append(node("i"));
    return d;
  }
  // A row's state in the status poll (experience rules' side()).
  function kindOf(row) {
    const all = H.status ? H.status() || {} : {};
    const X = window.ClowderExperienceRules;
    const entry = row.dataset.bot ? (all.bots || {})[row.dataset.bot] : (all.groups || {})[row.dataset.group];
    return entry && X && typeof X.side === "function" ? X.side(entry).kind : "idle";
  }
  // row → {line: our line, was: the line it covers}: the open chat's row
  // while its cat writes. The shell's repaint replaces our line like its own
  // (it is the row's .preview); otherwise the covered line comes back here.
  const own = new WeakMap();
  function paintRow(row, shows, words) {
    const mine = own.get(row);
    if (shows === "live") {
      if (mine && mine.line.isConnected) {
        const label = kids(mine.line).at(-1);
        if (label && label.textContent !== words) { label.textContent = words; mine.line.title = words; }
        return;
      }
      const current = row.querySelector(".preview");
      if (!current) return;
      const line = node("span", "preview st run pz-typing");
      line.append(dots(), node("span", "", words));
      line.title = words;
      current.replaceWith(line);
      own.set(row, { line, was: current });
      return;
    }
    if (mine) {
      own.delete(row);
      if (mine.line.isConnected) mine.line.replaceWith(mine.was);
    }
    // The status's own busy line: its spinner becomes the typing dots.
    if (shows === "status") {
      const line = kids(row.querySelector(".item-body") || row).find((c) => has(c, "preview") && has(c, "st") && has(c, "run"));
      const spin = kids(line).find((c) => has(c, "st-spin"));
      if (spin) spin.replaceWith(dots());
    }
  }
  function rows(roster) {
    if (!H) return;
    colours();
    const root = roster || document.getElementById("roster");
    if (!root) return;
    const open = keyOf(selected()), live = liveWords();
    for (const row of root.querySelectorAll(".item[data-bot], .item[data-group]")) {
      const key = row.dataset.bot ? "bot:" + row.dataset.bot : "group:" + row.dataset.group;
      paintRow(row, R.rowShows(kindOf(row), key === open ? live : ""), live);
    }
  }
  // chat-live.js said its replies may have changed: the header and the open
  // chat's row follow at once, only when the words actually change.
  let lastWords = null;
  function onLive() {
    if (!H) return;
    const words = liveWords();
    if (words === lastWords) return;
    lastWords = words;
    header(words);
    rows();
  }

  // ---------------------------------------------------------- the seen paw
  // A small paw print (four toe beans over a pad), drawn in currentColor.
  const PAW = '<path d="M12 12.6c-2.5 0-5.2 2.5-5.2 4.9 0 1.6 1.1 2.6 2.6 2.6 1.1 0 1.7-.5 2.6-.5s1.5.5 2.6.5c1.5 0 2.6-1 2.6-2.6 0-2.4-2.7-4.9-5.2-4.9z"/>'
    + '<ellipse cx="5.6" cy="11.2" rx="1.9" ry="2.4" transform="rotate(-18 5.6 11.2)"/>'
    + '<ellipse cx="9.3" cy="7.3" rx="2" ry="2.5" transform="rotate(-6 9.3 7.3)"/>'
    + '<ellipse cx="14.7" cy="7.3" rx="2" ry="2.5" transform="rotate(6 14.7 7.3)"/>'
    + '<ellipse cx="18.4" cy="11.2" rx="1.9" ry="2.4" transform="rotate(18 18.4 11.2)"/>';
  function paw(words, cat) {
    const mark = node("span", "pz-seen");
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", words);
    mark.dataset.tip = words;
    if (cat) mark.dataset.cat = cat;
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = PAW;
    mark.append(s);
    return mark;
  }
  // Owner messages whose paw this page has shown (it is stamped only once),
  // and the histories drawn so far (the first drawing of a chat stamps nothing).
  const stamped = new Set();
  const drawn = new WeakSet();
  function currentInner() {
    return kids(H && H.thread).find((c) => has(c, "thread-inner") && !has(c, "thread-skeleton") && !has(c, "no-chat")) || null;
  }
  function rendered(messages) {
    if (!H) return;
    colours();
    const inner = currentInner();
    if (!inner) return;
    const first = !drawn.has(inner);
    drawn.add(inner);
    // The owner's messages as the history drew them (a send still waiting
    // for its row is not one of them).
    const owners = new Map();
    for (const r of kids(inner)) if (has(r, "msg") && has(r, "user") && !has(r, "optimistic") && r.dataset.mid) owners.set(r.dataset.mid, r);
    const mark = R.seenMark([...owners.keys()], R.picked(messages));
    const words = mark ? R.seenWords(mark.cats, nameOf) : "", cat = mark && mark.cats.length === 1 ? mark.cats[0] : "";
    for (const [id, r] of owners) {
      const col = kids(r).find((c) => has(c, "bubble-col"));
      const old = kids(col).find((c) => has(c, "pz-seen"));
      const keep = !!mark && id === mark.id;
      // Another cat picking the same message up (a group) redraws the paw without stamping.
      if (old && (!keep || old.getAttribute("aria-label") !== words || (old.dataset.cat || "") !== cat)) old.remove();
      else if (old) continue;
      if (!keep || !col) continue;
      const p = paw(words, cat);
      const fresh = !first && !stamped.has(id) && !reduced();
      stamped.add(id);
      if (fresh) {
        p.classList.add("pz-stamp");
        setTimeout(() => p.classList.remove("pz-stamp"), 600);
      }
      col.append(p);
    }
  }

  // ------------------------------------------------------------------ exits
  // A duration token (tokens.css), in milliseconds.
  function token(name, fallback) {
    try {
      const v = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue(name));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    } catch (e) { return fallback; }
  }
  const ghosts = new WeakMap();
  function ghost(el, card) {
    if (reduced() || !el.parentElement || typeof el.cloneNode !== "function") return;
    const g = el.cloneNode(true);
    if (typeof g.animate !== "function") return;
    for (const n of [g, ...g.querySelectorAll("[id]")]) n.removeAttribute("id");
    // Typed words are a property, not markup: the copy shows them too.
    const from = el.querySelectorAll("input, textarea"), to = g.querySelectorAll("input, textarea");
    from.forEach((f, i) => { if (to[i]) to[i].value = f.value; });
    g.hidden = false;
    g.classList.add("pz-ghost");
    g.setAttribute("aria-hidden", "true");
    g.inert = true;
    el.after(g);
    ghosts.set(el, g);
    const ms = card ? token("--dur-pop-close", 120) : 180;
    const runs = [g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "ease-out", fill: "forwards" })];
    const c = card ? g.querySelector(card) : null;
    if (c) runs.push(c.animate([{ transform: "none" }, { transform: "translateY(4px) scale(.985)" }], { duration: ms, easing: "ease-out", fill: "forwards" }));
    const done = () => { g.remove(); if (ghosts.get(el) === g) ghosts.delete(el); };
    Promise.all(runs.map((a) => a.finished)).then(done, done);
    setTimeout(done, ms + 300);
  }
  function watchExit(el, card) {
    if (!el || typeof window.MutationObserver !== "function") return;
    new window.MutationObserver((records) => {
      const was = records[0].oldValue, now = el.hidden;
      if (was === null && now) ghost(el, card);
      // Shown again before the copy finished fading: the copy goes at once.
      else if (was !== null && !now && ghosts.get(el)) { ghosts.get(el).remove(); ghosts.delete(el); }
    }).observe(el, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true });
  }

  // -------------------------------------------------------------------- init
  // Hooks from app.js:
  //   thread          the history's scroll box (#thread);
  //   chip            the header's identity button (#head-chip);
  //   live            window.ClowderLive (presence() and watch());
  //   bots()          the cats as listed (name, native_id, accent);
  //   selected()      the open chat ({type, id}), null in the two-cat exchange;
  //   status()        the status poll's {bots: {name: entry}, groups: {id: entry}};
  //   catName(catId)  a cat's name by its native ID ("" when unknown).
  function init(hooks) {
    H = hooks || {};
    if (H.live && typeof H.live.watch === "function") H.live.watch(onLive);
    const root = document.documentElement;
    if (root && typeof window.MutationObserver === "function") {
      new window.MutationObserver(() => { surfacesAt = null; colours(); }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    }
    watchExit(document.querySelector(".pal"), ".pal-card");
    watchExit(document.getElementById("panel-scrim"), "");
    watchExit(document.getElementById("backdrop"), "");
    colours();
    onLive();
  }

  window.ClowderPresence = Object.freeze({ init, rows, rendered, refresh: onLive });
})();
