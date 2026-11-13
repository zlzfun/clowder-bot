// The colour lab (theme-lab/index.html; docs/xbot-frontend.md item 47).
// Review only: no product page links or loads it, and it writes nothing the
// app keeps. Every palette is shown on the real interface:
//   - the overview: one tile per palette, its frozen screen in light and dark
//     side by side (scenes.json in srcdoc frames on the app's stylesheets);
//   - the large view: one palette at real size, scene and light/dark switches,
//     ← → between palettes, Esc to close;
//   - 在应用里试: the app itself (/) in its own window, with the palette added
//     as one style element (again after the app reloads), 拿铁 included: the
//     app may have a 配色 of its own (docs/xbot-frontend.md item 48).
// The rules (stylesheets, the palette as CSS, a frame's document) are in
// lab-rules.js; each cat's own colour comes from the app's chat-presence-rules.js.
(() => {
  "use strict";
  const R = window.ClowderThemeLabRules, P = window.ClowderPresenceRules;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const MODE_NAMES = { light: "浅色", dark: "深色" };

  const state = { palettes: [], scenes: [], html: {}, cats: [], size: { width: 1200, height: 760 }, scene: "", mode: "light", open: null };
  const byId = (id) => state.palettes.find((p) => p.id === id) || null;
  const sceneOf = (id) => state.scenes.find((s) => s.id === id) || state.scenes[0];

  // The lab's page follows the system's light or dark (it has no setting of its own).
  const scheme = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  if (scheme) scheme.addEventListener("change", () => document.documentElement.setAttribute("data-theme", scheme.matches ? "dark" : "light"));

  // ------------------------------------------------------------- one frame
  const accentsMemo = new Map();
  function accents(palette, mode) {
    const key = palette.id + "/" + mode;
    if (!accentsMemo.has(key)) accentsMemo.set(key, P && typeof P.accentCss === "function" ? P.accentCss(state.cats, R.surfaces(palette, mode)) : "");
    return accentsMemo.get(key);
  }
  function docFor(palette, sceneId, mode) {
    return R.frameDoc({ scene: sceneOf(sceneId), mode, palette, html: state.html, accents: accents(palette, mode) });
  }
  // A frozen screen ready to look at: styles in, fonts in, lists scrolled where they were, and in
  // 设置 → 通用 the palette shown is the 配色 chosen (the screen was taken with 拿铁 chosen).
  async function settle(frame, colors) {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    if (colors) for (const b of doc.querySelectorAll(".cc-opt[data-id]")) b.setAttribute("aria-checked", String(b.getAttribute("data-id") === colors));
    void doc.body.offsetHeight;
    try { await doc.fonts.ready; } catch (e) { /* shown with whatever face is there */ }
    for (const node of doc.querySelectorAll("[data-lab-scroll]")) {
      const at = node.getAttribute("data-lab-scroll");
      node.scrollTop = at === "end" ? node.scrollHeight : Number(at) || 0;
    }
  }
  // The large view's frame can be pointed at (hover is real CSS) but does nothing:
  // no link, box, button or form acts, and ← → Esc still move or close the view.
  function still(frame) {
    const doc = frame.contentDocument;
    if (!doc) return;
    const stop = (e) => e.preventDefault();
    for (const type of ["click", "auxclick", "submit", "dragstart", "dblclick"]) doc.addEventListener(type, stop, true);
    doc.addEventListener("keydown", (e) => { if (keys(e.key)) e.preventDefault(); });
  }
  /**
   * Shows `doc` in `box`. The new frame is built out of sight and swapped in
   * when it is ready, so moving between palettes never flashes an empty frame;
   * a frame overtaken by a newer one is dropped.
   */
  function show(box, key, doc, opts = {}) {
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    for (const old of box.querySelectorAll("iframe:not(.on)")) old.remove();
    const frame = document.createElement("iframe");
    frame.className = "tl-doc";
    frame.setAttribute("tabindex", "-1");
    if (opts.title) frame.title = opts.title;
    frame.srcdoc = doc;
    frame.addEventListener("load", () => {
      settle(frame, opts.colors).then(() => {
        if (!frame.isConnected || box.dataset.key !== key) return;
        if (opts.live) still(frame);
        // Focus inside the frame being replaced moves to its replacement, so ← → keep working there.
        const focused = [...box.querySelectorAll("iframe")].some((old) => old !== frame && document.activeElement === old);
        for (const old of box.querySelectorAll("iframe")) if (old !== frame) old.remove();
        frame.classList.add("on");
        if (focused) frame.focus({ preventScroll: true });
      });
    }, { once: true });
    box.append(frame);
  }

  // ------------------------------------------------------------- switches
  function sceneButtons(host) {
    host.replaceChildren(...state.scenes.map((s) => {
      const b = el("button", "", s.name);
      b.type = "button"; b.dataset.scene = s.id;
      b.addEventListener("click", () => pickScene(s.id));
      return b;
    }));
  }
  function pressed(host, attr, value) {
    for (const b of host.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
  }
  function pickScene(id) {
    if (!sceneOf(id) || state.scene === id) return;
    state.scene = id;
    pressed($("scenes"), "scene", id); pressed($("view-scenes"), "scene", id);
    paintTiles();
    if (state.open) paintView();
  }
  function pickMode(mode) {
    if (!R.MODES.includes(mode) || state.mode === mode) return;
    state.mode = mode;
    pressed($("view-modes"), "mode", mode);
    paintView();
  }

  // ------------------------------------------------------------- overview
  const tiles = new Map();
  let seen = null;
  function buildTiles() {
    const grid = $("grid");
    grid.replaceChildren();
    for (const p of state.palettes) {
      const li = el("li", "tl-tile");
      li.dataset.id = p.id;
      const open = el("button", "tl-open");
      open.type = "button";
      open.setAttribute("aria-haspopup", "dialog");
      open.append(el("span", "tl-name", p.name), el("span", "tl-note", p.note));
      open.addEventListener("click", () => openView(p.id));
      const frames = el("div", "tl-frames");
      frames.inert = true;
      frames.setAttribute("aria-hidden", "true");
      const boxes = {};
      for (const mode of R.MODES) { boxes[mode] = el("div", "tl-frame tl-" + mode); frames.append(boxes[mode]); }
      li.append(open, frames);
      grid.append(li);
      tiles.set(p.id, { li, open, boxes, near: false });
    }
    // Frames are drawn for tiles on or near the screen; the others when they come near.
    seen = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const tile = tiles.get(entry.target.dataset.id);
        if (!tile) continue;
        tile.near = entry.isIntersecting;
        if (tile.near) paintTile(entry.target.dataset.id);
      }
    }, { rootMargin: "50% 0px" }) : null;
    for (const tile of tiles.values()) { if (seen) seen.observe(tile.li); else tile.near = true; }
    scaleTiles();
    paintTiles();
  }
  function paintTile(id) {
    const tile = tiles.get(id), p = byId(id);
    if (!tile || !p || !tile.near) return;
    for (const mode of R.MODES) show(tile.boxes[mode], state.scene + "/" + mode, docFor(p, state.scene, mode), { colors: p.id });
  }
  function paintTiles() { for (const id of tiles.keys()) paintTile(id); }
  // Every tile frame has the same width: one scale for all of them.
  function scaleTiles() {
    const first = document.querySelector(".tl-frame");
    if (first) $("grid").style.setProperty("--tl-s", String(first.clientWidth / state.size.width));
  }

  // ------------------------------------------------------------- large view
  const view = $("view");
  function openView(id) {
    if (!byId(id)) return;
    state.open = id;
    paintView();
    if (!view.open) view.showModal();
    scaleView();
    follow();
  }
  function paintView() {
    const p = byId(state.open);
    if (!p) return;
    $("view-name").textContent = p.name;
    $("view-note").textContent = p.note;
    const scene = sceneOf(state.scene);
    show($("view-fit"), p.id + "/" + state.scene + "/" + state.mode, docFor(p, state.scene, state.mode),
      { live: true, colors: p.id, title: p.name + " · " + (scene ? scene.name : "") + " · " + MODE_NAMES[state.mode] });
  }
  function move(by) {
    const id = R.step(state.palettes, state.open, by);
    if (!id || id === state.open) return;
    state.open = id;
    paintView();
    follow();
  }
  function scaleView() {
    const stage = $("view-stage");
    const style = getComputedStyle(stage);
    const box = { width: stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), height: stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) };
    $("view-fit").style.setProperty("--tl-s", String(R.fitScale(box, state.size.width, state.size.height)));
  }
  // ← → move between palettes and Esc closes, wherever the focus is in the view (also inside the frame).
  function keys(key) {
    if (!view.open) return false;
    if (key === "ArrowLeft") { move(-1); return true; }
    if (key === "ArrowRight") { move(1); return true; }
    if (key === "Escape") { view.close(); return true; }
    return false;
  }
  // (Esc on the page itself is the dialog's own cancel.)
  document.addEventListener("keydown", (e) => { if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key !== "Escape" && keys(e.key)) e.preventDefault(); });
  view.addEventListener("close", () => {
    const tile = tiles.get(state.open);
    state.open = null;
    $("view-said").textContent = "";
    if (tile) { tile.open.focus({ preventScroll: true }); tile.li.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
  });
  $("view-prev").addEventListener("click", () => move(-1));
  $("view-next").addEventListener("click", () => move(1));
  $("view-close").addEventListener("click", () => view.close());
  for (const b of $("view-modes").querySelectorAll("button")) b.addEventListener("click", () => pickMode(b.dataset.mode));

  // ------------------------------------------------------------- 在应用里试
  // The app in a window of its own. The lab adds one style element to it
  // (lab-rules.js overrideCss, 拿铁 written out as well: the app may be set to
  // another 配色) and keeps it there while that window is open: after the app
  // reloads or is opened again, the element is added again. Light or dark and
  // the app's own 配色 setting stay as the app has them; nothing the app keeps
  // (its settings, its storage) is written. The cats' name colours there are
  // the app's decision for its own 配色 (it judges them again when its 配色
  // changes, not when a style is added).
  let app = null, appTimer = 0, appId = null;
  function tryInApp() {
    const p = byId(state.open);
    if (!p) return;
    if (!app || app.closed) {
      app = window.open("/", "clowder-theme-lab");
      if (!app) { $("view-said").textContent = "浏览器拦下了新窗口：允许这个页面弹出窗口后再点一次。"; return; }
    } else app.focus();
    $("view-said").textContent = "";
    appId = p.id;
    paintApp();
    clearInterval(appTimer);
    appTimer = setInterval(paintApp, 400);
  }
  function follow() {
    if (!app || app.closed || !state.open) return;
    appId = state.open;
    paintApp();
  }
  function paintApp() {
    if (!app || app.closed) { clearInterval(appTimer); app = null; return; }
    let doc;
    try { doc = app.document; if (app.location.origin !== location.origin) return; } catch (e) { return; }
    // Not yet the app (the window's first, empty page) or not parsed far enough.
    if (!doc || !doc.head || doc.URL === "about:blank") return;
    const p = byId(appId);
    let style = doc.getElementById(R.TRY_ID);
    const css = R.overrideCss(p, true);
    if (!css) { if (style) style.remove(); return; }
    if (!style) { style = doc.createElement("style"); style.id = R.TRY_ID; }
    // Last in <head>, after anything the app added at run time.
    if (style.parentNode !== doc.head || style.nextElementSibling) doc.head.append(style);
    if (style.textContent !== css) style.textContent = css;
  }
  $("view-try").addEventListener("click", tryInApp);

  // ------------------------------------------------------------- start
  // The tiles' width and the large view's stage decide the scale of their frames.
  let resizeQueued = false;
  const sizes = new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; scaleTiles(); if (view.open) scaleView(); });
  });
  sizes.observe($("grid"));
  sizes.observe($("view-stage"));

  async function get(path) {
    const answer = await fetch(path, { headers: { Accept: "application/json" } });
    if (!answer.ok) throw new Error(path + " " + answer.status);
    return answer.json();
  }
  Promise.all([get("palettes.json"), get("scenes.json")]).then(([palettes, frozen]) => {
    if (!Array.isArray(palettes) || !palettes.length || !frozen || !Array.isArray(frozen.scenes) || !frozen.scenes.length) throw new Error("empty");
    state.palettes = palettes;
    state.scenes = frozen.scenes;
    state.html = frozen.html || {};
    state.cats = Array.isArray(frozen.cats) ? frozen.cats : [];
    if (frozen.viewport && frozen.viewport.width > 0 && frozen.viewport.height > 0) state.size = { width: frozen.viewport.width, height: frozen.viewport.height };
    document.documentElement.style.setProperty("--tl-w", state.size.width + "px");
    document.documentElement.style.setProperty("--tl-h", state.size.height + "px");
    document.documentElement.style.setProperty("--tl-ar", state.size.width + " / " + state.size.height);
    state.scene = state.scenes[0].id;
    sceneButtons($("scenes")); sceneButtons($("view-scenes"));
    pressed($("scenes"), "scene", state.scene); pressed($("view-scenes"), "scene", state.scene);
    buildTiles();
  }).catch(() => { $("said").textContent = "没能读取配色或画面（palettes.json、scenes.json）。"; });
})();
