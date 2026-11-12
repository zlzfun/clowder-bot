// The sidebar's own presentation (classic script, window.ClowderSidebar;
// styles in sidebar.css, docs/xbot-frontend.md item 43). Two things, both
// presentation only — no request, no stored state beyond app.js's existing
// localStorage["xbot.side"] {w, rail}:
//
//   ownerFace()  the owner's face: a small person of ours in café tones, drawn
//                inline, never one of the cats (the cats are clay portraits
//                from cat-avatars.js; the owner is not a cat).
//   motion()     the move between the full sidebar and the 72px rail. The
//                width follows the pointer at once while the grip is dragged
//                in the full range; only the snap into or out of the rail is
//                animated, and only when app.js asks (a page load, a window
//                resize and reduced motion paint the state directly).
//
// Into the rail: the words fade first (the greeting, 搜索 · 新建, names and
// last lines, 应用's label and pill, the open chat's highlight), then the rail
// layout takes over while the width narrows and the faces glide from where
// they were to where they belong (FLIP: measured before and after, eased back
// from the difference). Out of it: the full layout is laid out at once at its
// final width, revealed as the sidebar widens while the faces glide back, and
// the words fade in last. The content is pinned to the target width during
// the move, so nothing wraps or re-flows on the way, and the sidebar clips it,
// so there is never a horizontal scrollbar. The classes the CSS hangs on:
//   side-moving     the whole move (width transition, pinned content, clip)
//   side-fading     into the rail, before the layout changes: words fade out
//   side-landing    into the rail, after it: rail-only controls fade in
//   side-arriving   out of the rail: words held invisible while it widens
//   side-revealing  out of the rail, at the end: words fade in
// Timings come from the sidebar's own CSS (--side-fade, --side-move,
// --side-ease), which reuse tokens.css's durations and the panel's curve.
(() => {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";

  // ---- the owner's face ----
  // A person, head and shoulders, with a small open collar: the café's coffee
  // on its latte tile (sidebar.css colours it from the tokens, both themes).
  // No ears, no clay, no dots or spinner, so it reads neither as a cat nor as
  // a cat at work, from 28 to 44 px.
  function ownerFace(doc = document) {
    const face = doc.createElement("span");
    face.className = "avatar me owner";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 36 36");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("data-owner", "");
    const part = (tag, attrs) => {
      const n = doc.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
    };
    part("circle", { class: "owner-head", cx: "18", cy: "13.6", r: "6.6" });
    part("path", { class: "owner-body", d: "M4.8 37c0-8.6 5.9-14.2 13.2-14.2S31.2 28.4 31.2 37z" });
    part("path", { class: "owner-collar", d: "M14.9 23.6 18 27.4l3.1-3.8" });
    face.append(svg);
    return face;
  }

  // ---- the move between the full sidebar and the rail ----
  // What glides: each chat's face (rows and pinned cats), the owner's face and
  // 应用's glyph; the same elements before and after, so nothing is matched
  // by name. Elements shown only in the rail (.rail-only: the rail's 新建)
  // fade out in place when the sidebar widens.
  const GLIDE = ".item > .avatar, .pin > .avatar, .account-trigger, .side-apps > .icon";
  const STATES = ["side-moving", "side-fading", "side-landing", "side-arriving", "side-revealing"];

  // hooks: start() when a move begins (close menus, tooltips); layout(rail)
  // whenever the rail class changes, moved or not (app.js orders the footer).
  function motion(sidebar, hooks = {}) {
    const doc = sidebar.ownerDocument || document;
    const win = doc.defaultView || window;
    const root = doc.documentElement;
    const reduced = () => !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const style = (name) => String(win.getComputedStyle ? win.getComputedStyle(sidebar).getPropertyValue(name) : "").trim();
    const ms = (name, fallback) => { const v = parseFloat(style(name)); return Number.isFinite(v) && v >= 0 ? v : fallback; };
    let run = null;

    const setWidth = (px) => sidebar.style.setProperty("--side-w", px + "px");
    function layout(rail, width) {
      sidebar.classList.toggle("rail", rail);
      root.classList.toggle("has-rail", rail);
      setWidth(width);
      if (hooks.layout) hooks.layout(rail);
    }
    function rects() {
      const map = new Map();
      for (const el of sidebar.querySelectorAll(GLIDE)) {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) map.set(el, r);
      }
      return map;
    }
    // From where each face was to where it is now, eased back to its place.
    // A face that would start above the top of its list as laid out now (the
    // pinned faces, under the greeting that comes back with the full sidebar)
    // would be cut off by the list's edge on the way: it fades in at its place.
    function glide(r, before) {
      const view = sidebar.getBoundingClientRect();
      const seen = (b) => b.bottom > view.top && b.top < view.bottom;
      for (const [el, b] of before) {
        const a = el.getBoundingClientRect();
        if (!a.width && !a.height) continue;
        const dx = b.left - a.left, dy = b.top - a.top;
        if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || (!seen(a) && !seen(b))) continue;
        const list = el.closest ? el.closest(".side-scroll") : null;
        const edge = list ? list.getBoundingClientRect().top : -Infinity;
        if (b.top < edge - 1 && a.top >= edge - 1) {
          ghost(r, el, b);
          r.anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: r.move, easing: "ease-out" }));
          continue;
        }
        r.anims.push(el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: r.move, easing: r.ease }));
      }
    }
    // A still copy of something fading where it stood (b) while the new layout
    // takes over: the rail-only controls, and a face that fades in elsewhere.
    function ghost(r, el, b) {
      const g = el.cloneNode(true);
      g.removeAttribute("id");
      g.setAttribute("aria-hidden", "true");
      g.inert = true;
      g.classList.add("side-ghost");
      Object.assign(g.style, { left: b.left + "px", top: b.top + "px", width: b.width + "px", height: b.height + "px" });
      sidebar.append(g);
      r.ghosts.push(g);
      r.anims.push(g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: r.fade, easing: "ease-out", fill: "forwards" }));
    }
    function ghosts(r) {
      for (const el of sidebar.querySelectorAll(".rail-only")) {
        const b = el.getBoundingClientRect();
        if (b.width) ghost(r, el, b);
      }
    }
    // The move's own clock: an empty animation on the sidebar, so each step
    // follows the same timeline as the transitions it waits for (slowed in the
    // browser's animation tools, they stay in step). clear() takes a clock off
    // the list before cancelling it; a clock ended any other way (cancelled from
    // outside, a step that throws) jumps the move to its end.
    function later(r, fn, delay) {
      const clock = sidebar.animate([], { duration: Math.max(0, delay) });
      r.timers.push(clock);
      const mine = () => run === r && r.timers.includes(clock);
      clock.finished.then(() => {
        if (!mine()) return;
        try { fn(); } catch { if (run === r) finish(); }
      }, () => { if (mine()) finish(); });
    }
    // A move always ends. A plain timer looks at the move's clock every second
    // or so: while it runs on (slowed down in the animation tools too) the move
    // goes on; once it has stopped (cancelled, paused, a timeline that does not
    // advance) the move jumps to its end. A tab hidden mid-move ends it too
    // (nobody sees it, and it comes back settled).
    function watch(r) {
      r.guard = setTimeout(() => {
        if (run !== r) return;
        const clock = r.timers[r.timers.length - 1];
        const at = clock ? Number(clock.currentTime) || 0 : 0;
        const going = !!clock && clock.playState === "running" && (clock !== r.seen || at > r.seenAt);
        if (!going || doc.hidden) { finish(); return; }
        r.seen = clock;
        r.seenAt = at;
        watch(r);
      }, Math.max(1000, 3 * (r.fade + r.move)));
    }
    if (doc.addEventListener) doc.addEventListener("visibilitychange", () => { if (run) finish(); });
    function clear(r) {
      const clocks = r.timers;
      r.timers = [];
      for (const c of clocks) { try { c.cancel(); } catch { /* gone */ } }
      for (const a of r.anims) { try { a.cancel(); } catch { /* gone */ } }
      r.anims = [];
      for (const g of r.ghosts) g.remove();
      r.ghosts = [];
      if (r.waiting) { sidebar.removeEventListener("transitionend", r.waiting); r.waiting = null; }
    }
    function cleanup(r) {
      clear(r);
      clearTimeout(r.guard);
      sidebar.classList.remove(...STATES);
      if (run === r) run = null;
    }
    // The end of a move: once the width has arrived (a drag may have moved the
    // target meanwhile; the transition then runs on and is waited for).
    function settle(r) {
      const target = parseFloat(sidebar.style.getPropertyValue("--side-w")) || 0;
      const now = sidebar.getBoundingClientRect().width;
      if (!target || Math.abs(now - target) < 0.5) { cleanup(r); return; }
      r.waiting = (ev) => { if (ev.target === sidebar && ev.propertyName === "width") cleanup(r); };
      sidebar.addEventListener("transitionend", r.waiting);
      later(r, () => cleanup(r), r.move + 60);
    }
    // Jump to the end of a move (another one replaces it, or the window changed).
    function finish() {
      const r = run;
      if (!r) return;
      try { if (!r.applied) { r.applied = true; layout(r.rail, r.width); } }
      finally { cleanup(r); }
    }
    const fresh = (rail, width) => {
      const r = { rail, width, applied: false, timers: [], anims: [], ghosts: [], waiting: null, guard: 0, seen: null, seenAt: 0,
        fade: ms("--side-fade", 120), move: ms("--side-move", 220), ease: style("--side-ease") || "ease-out" };
      watch(r);
      return r;
    };

    function collapse(width) {
      const r = fresh(true, width);
      sidebar.classList.add("side-moving", "side-fading");
      later(r, () => {
        const before = rects();
        layout(true, r.width);
        r.applied = true;
        sidebar.classList.add("side-landing");
        glide(r, before);
        later(r, () => settle(r), r.move);
      }, r.fade);
      return r;
    }
    function expand(width) {
      const r = fresh(false, width);
      const before = rects();
      ghosts(r);
      sidebar.classList.add("side-moving", "side-arriving");
      layout(false, width);
      r.applied = true;
      glide(r, before);
      // The words come back as the width arrives (the last third of the move).
      const reveal = Math.max(0, r.move - Math.round(r.move / 3));
      later(r, () => { sidebar.classList.remove("side-arriving"); sidebar.classList.add("side-revealing"); }, reveal);
      later(r, () => settle(r), reveal + r.fade);
      return r;
    }
    // Into the rail and back before the layout changed: the words fade back in.
    function unfade(r, width) {
      clear(r);
      r.rail = false;
      r.width = width;
      r.applied = true;
      sidebar.classList.remove("side-fading");
      sidebar.classList.add("side-revealing");
      setWidth(width);
      later(r, () => settle(r), r.fade);
    }

    // rail: the state to show; width: its width in px; animate: whether this
    // is a snap the owner made (the grip), as opposed to a load or a resize.
    function to(rail, width, animate) {
      rail = !!rail;
      // A load, a resize (the drawer's width has none of the desktop rules a
      // move's copies rely on) or reduced motion never leaves a move running.
      if (run && (!animate || reduced())) finish();
      if (run && run.rail === rail) {
        run.width = width;
        if (run.applied) setWidth(width);
        return;
      }
      if (run && run.rail && !run.applied && animate && !reduced()) { unfade(run, width); return; }
      finish();
      if (sidebar.classList.contains("rail") === rail) { root.classList.toggle("has-rail", rail); setWidth(width); return; }
      if (!animate || reduced() || typeof sidebar.animate !== "function") { layout(rail, width); return; }
      if (hooks.start) hooks.start(rail);
      run = rail ? collapse(width) : expand(width);
    }

    return { to, finish, moving: () => !!run };
  }

  window.ClowderSidebar = Object.freeze({ ownerFace, motion, GLIDE });
})();
