// Search and jump: the ⌘K palette (classic script, window.ClowderPalette).
// Loads after palette-rules.js, workspace.js and chat-experience.js and
// before app.js, which calls init() once with its hooks (see the call next to
// the ⌘\ shortcut in app.js). Opened with ⌘K / Ctrl+K anywhere in the chat
// shell, or from 搜索 at the top of the sidebar; on a phone it is a sheet over
// the whole screen.
//
// - Typing filters 猫猫 and 群聊 by name at once (on the page) and, after a
//   short rest, searches what was said (GET /xbot-api/search?q=). A newer
//   query cancels the request before it; a late answer is dropped. Each hit
//   shows the chat, who said it, the snippet with the match marked and when.
//   Conversations that could not be read and anything not looked at or not
//   listed are said plainly, never shown as "nothing found".
// - An empty query lists the sidebar's first chats (not the open one) and the
//   actions. Actions live in a small registry (ClowderPalette.actions) that
//   other parts of the app may add to or replace; the defaults are 新建猫猫,
//   新建群聊, 设置 and 切换深浅色, each calling the app's own function.
// - Enter on a chat opens it. On a message of a chat's current conversation it
//   opens that chat and finds the message (ClowderPalette.locate, replaceable;
//   by default the existing locate-by-message-ID of chat-experience.js among
//   the messages on screen). A message the chat does not show is said to be
//   further back; the chat stays at its newest. A message of a cat's earlier
//   conversation says so first, then moves the cat there through the existing
//   历史对话 switch (workspace.js), which keeps its rules: it refuses while
//   either conversation is busy, and that refusal is shown.
// - open({scope}) searches one chat only, through its own route (GET
//   /xbot-api/bots/:name/search or /groups/:id/search: its current
//   conversation): the chat list and the actions step aside. A scope names
//   the chat as the app does ({type, id}: a cat by name, a group by ID) or a
//   cat by {type: 'bot', nativeId}; the two never mix.
// - A chosen row is resolved again against the chat list as it is now, by
//   lasting identity, and refused in place when its chat is gone. What a
//   choice does after waiting (a chat opening, a switch) stops once a newer
//   choice or a new palette exists. A sign-in or another dialog taking over
//   closes the palette without moving focus.
// - Keys: ↑/↓ choose, Enter opens, Esc closes (or steps back from a question),
//   Tab stays inside, and focus goes back where it was. Alt+↑ / Alt+↓ open the
//   previous / next chat in the sidebar's order.
//
// Nothing here is a record: the query, the hits and the chosen row are what
// this page last asked and saw. Opening a chat, switching a conversation and
// every action go through the app's existing functions.
(() => {
  "use strict";
  const R = window.ClowderPaletteRules;
  const SVG = "http://www.w3.org/2000/svg";
  const mac = /Mac|iPhone|iPad/.test((typeof navigator !== "undefined" && navigator.platform) || "");
  let H = null;
  let ui = null;
  let optSeq = 0;
  const registry = new Map();
  const S = {
    open: false, raw: "", scope: null, items: [], active: -1, opener: null, confirm: null, composing: false, inert: false,
    // op numbers every opening and every choice: what a choice does after it
    // waited (opening a chat, a switch) goes on only while it is still the
    // latest, so it never closes, focuses or speaks over a newer palette.
    op: 0,
    // A choice that could not go ahead (its chat is gone), said in the palette.
    refusal: "",
    // key: the scope and words the request (or answer) is for.
    search: { seq: 0, timer: 0, ctrl: null, state: "idle", key: "", q: "", data: null, error: "", final: false },
  };

  // ------------------------------------------------------------------ helpers
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, onClick, label) {
    const b = node("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  function lens() {
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "icon pal-lens");
    s.innerHTML = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
    return s;
  }
  const icon = (name) => (H && H.icon ? H.icon(name) : node("span", "icon"));
  const keyHint = () => (mac ? "⌘K" : "Ctrl K");
  // Text with the matched range marked; never markup from the data.
  function marked(cls, text, range) {
    const span = node("span", cls);
    const parts = range ? R.segments(text, range) : [{ text: String(text || ""), hit: false }];
    for (const part of parts) span.append(part.hit ? node("mark", "pal-mark", part.text) : document.createTextNode(part.text));
    return span;
  }
  const shown = (n) => !!n && !!n.isConnected && !(n.closest && n.closest("[hidden]")) && (!n.getClientRects || n.getClientRects().length > 0);
  const now = () => new Date();

  // ------------------------------------------------------------------- chats
  // Every chat the app lists, in the sidebar's order (hooks: chats, order).
  function chatList() {
    let list = [];
    try { list = (H && H.chats ? H.chats() : []) || []; } catch (e) { list = []; }
    return R.ordered(list, sidebarOrder());
  }
  function sidebarOrder() {
    try { return ((H && H.order ? H.order() : []) || []).map(R.keyOf); } catch (e) { return []; }
  }
  const selection = () => { try { return (H && H.selection && H.selection()) || null; } catch (e) { return null; } };
  function face(chat) {
    let f = null;
    try { f = chat && H.face ? H.face(chat, "") : null; } catch (e) { f = null; }
    if (!f) { f = node("span", "avatar pal-noface"); f.setAttribute("aria-hidden", "true"); }
    // The row says the name; no tooltip on the face.
    if (f.removeAttribute) f.removeAttribute("data-tip");
    return f;
  }

  // ---------------------------------------------------------------- actions
  // The registry: {id, label, icon?: name | () => name, keywords?, hint?: () => text,
  // when?: (ctx) => boolean, run: (ctx) => void}. ctx: {selection, opener}.
  const actions = Object.freeze({
    add(entry) {
      if (!entry || !entry.id || !entry.label || typeof entry.run !== "function") throw new Error("palette action needs id, label and run");
      registry.set(String(entry.id), Object.freeze({ ...entry, id: String(entry.id) }));
      if (S.open) paint(true);
      return registry.get(String(entry.id));
    },
    remove(id) { const had = registry.delete(String(id)); if (had && S.open) paint(true); return had; },
    get(id) { return registry.get(String(id)) || null; },
    list() { return [...registry.values()]; },
  });
  const ctx = () => ({ selection: selection(), opener: S.opener });

  // ------------------------------------------------------------------- build
  function build() {
    const root = node("div", "pal");
    root.hidden = true;
    const card = node("div", "pal-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "搜索");
    const bar = node("div", "pal-bar");
    const chip = node("span", "pal-scope");
    chip.hidden = true;
    const chipName = node("span", "pal-scope-name");
    const widenBtn = button("pal-scope-x", null, () => widen(), "改为搜索全部");
    widenBtn.append(icon("x"));
    chip.append(chipName, widenBtn);
    const input = node("input", "pal-input");
    input.type = "text";
    input.id = "pal-input";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "pal-list");
    input.setAttribute("aria-label", "搜索");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("enterkeyhint", "search");
    const esc = node("kbd", "pal-esc", "esc");
    esc.setAttribute("aria-hidden", "true");
    const cancel = button("pal-cancel", "取消", () => close());
    bar.append(lens(), chip, input, esc, cancel);
    const body = node("div", "pal-body");
    const list = node("div", "pal-list");
    list.id = "pal-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "搜索结果");
    body.append(list);
    // What the search says beyond its rows stays in sight under the list.
    const notes = node("div", "pal-notes");
    notes.setAttribute("role", "status");
    notes.hidden = true;
    const confirm = node("div", "pal-confirm");
    confirm.hidden = true;
    confirm.setAttribute("role", "group");
    // No line of key hints under the list (item 46): ↑↓ and ↵ are what any
    // list answers to, and esc is on the field.
    card.append(bar, body, notes, confirm);
    root.append(card);
    document.body.append(root);

    root.addEventListener("click", (ev) => { if (ev.target === root) close(); });
    // A press on the card's own surface keeps the caret in the field.
    card.addEventListener("mousedown", (ev) => {
      const t = ev.target;
      if (t === card || t === body || t === list || t === bar) ev.preventDefault();
    });
    root.addEventListener("keydown", onLayerKey);
    // While a word is being composed, nothing searched for the text before it
    // may still arrive or be shown; the committed word is searched afterwards.
    input.addEventListener("compositionstart", () => {
      S.composing = true;
      if (!S.open) return;
      resetSearch();
      paint(true);
    });
    input.addEventListener("compositionend", () => { S.composing = false; onInput(); });
    input.addEventListener("input", (ev) => { if (S.composing || (ev && ev.isComposing)) return; onInput(); });
    ui = { root, card, bar, chip, chipName, input, esc, cancel, body, list, notes, confirm };
  }

  // ------------------------------------------------------------- open / close
  function blocked() {
    if (!H || !ui) return true;
    // Signed out or on an account screen: the shell is hidden.
    const shell = document.getElementById("shell");
    if (shell && shell.hidden) return true;
    try { if (H.blocked && H.blocked()) return true; } catch (e) { return true; }
    // Another dialog is up (settings, a create form, the picture viewer …).
    for (const d of document.querySelectorAll('[aria-modal="true"], dialog[open]')) {
      if (ui.root.contains(d)) continue;
      if (shown(d)) return true;
    }
    return false;
  }

  function openFrom(opener, opts = {}) {
    if (!H || !ui) return false;
    if (!S.open && blocked()) return false;
    S.op++;
    S.refusal = "";
    if (!S.open) {
      const here = document.activeElement;
      S.opener = opener || (here && here !== document.body && !ui.root.contains(here) ? here : null);
      S.open = true;
      ui.root.hidden = false;
      const shell = document.getElementById("shell");
      if (shell) { S.inert = !!shell.inert; shell.inert = true; }
      resetSearch();
    }
    S.scope = opts.scope ? R.scope(opts.scope, chatList()) : null;
    S.confirm = null;
    S.raw = typeof opts.query === "string" ? opts.query : "";
    ui.input.value = S.raw;
    paintScope();
    schedule();
    paint(false);
    ui.input.focus();
    if (S.raw && ui.input.select) ui.input.select();
    return true;
  }
  function open(opts) { return openFrom(null, opts || {}); }

  // restore: focus goes back where it was (false when the palette hands
  // focus to what it opened).
  function close({ restore = true } = {}) {
    if (!S.open) return;
    S.open = false;
    S.confirm = null;
    resetSearch();
    ui.root.hidden = true;
    ui.confirm.hidden = true;
    ui.body.hidden = false;
    const shell = document.getElementById("shell");
    if (shell) shell.inert = S.inert;
    const back = S.opener;
    S.opener = null;
    if (!restore) return;
    if (back && shown(back) && !back.disabled) { back.focus({ preventScroll: true }); return; }
    if (H.focusComposer) H.focusComposer();
    // The way in is gone (搜索 has no place in the rail) and the composer took
    // nothing (no chat open, a phone): a control the app says is on screen now.
    const here = document.activeElement;
    if ((!here || here === document.body || !shown(here)) && H.fallback) {
      const next = H.fallback();
      if (next && shown(next) && !next.disabled) next.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------------ search
  function resetSearch() {
    const s = S.search;
    clearTimeout(s.timer);
    if (s.ctrl) s.ctrl.abort();
    Object.assign(s, { seq: s.seq + 1, timer: 0, ctrl: null, state: "idle", key: "", q: "", data: null, error: "", final: false });
  }
  // The scope and words a search is for: an answer for other words, or for
  // the whole list instead of one chat (or the other way round), is not shown.
  const searchKey = (q) => (S.scope ? R.keyOf(S.scope.chat) : "") + "\n" + q;
  // After the query changed: what was said is searched once typing rests. The
  // same words again keep the answer (or the request) already there; any
  // other words cancel the request before them. Nothing is asked while a
  // word is being composed.
  function schedule(force = false) {
    const s = S.search, v = R.query(S.raw), key = searchKey(v.q);
    if (!force && v.state === "ok" && key === s.key && (s.state === "ready" || s.state === "waiting")) return;
    resetSearch();
    if (v.state !== "ok" || S.composing) { s.state = v.state === "long" ? "long" : "idle"; return; }
    s.state = "waiting";
    s.key = key;
    s.q = v.q;
    const seq = s.seq;
    s.timer = setTimeout(() => run(seq, v.q), force ? 0 : R.DEBOUNCE);
  }
  // One chat's current conversation has its own route (GET <chat>/search),
  // so its matches are never crowded out by other chats'.
  function searchPath(q) {
    const sc = S.scope, words = "search?q=" + encodeURIComponent(q);
    if (!sc) return "/xbot-api/" + words;
    return "/xbot-api/" + (sc.type === "group" ? "groups/" : "bots/") + encodeURIComponent(sc.chat.id) + "/" + words;
  }
  async function run(seq, q) {
    const s = S.search;
    if (seq !== s.seq || !S.open || S.composing) return;
    s.timer = 0;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    s.ctrl = ctrl;
    const scoped = !!S.scope;
    let data = null, error = null;
    try { data = await H.api(searchPath(q), ctrl ? { signal: ctrl.signal } : {}); }
    catch (e) { error = e; }
    // A newer query, a close, a cancel or a word being composed since: this answer is not for what is on screen.
    if (seq !== s.seq || !S.open || S.composing) return;
    s.ctrl = null;
    // Signed out: the app shows its sign-in; the palette steps out of the way.
    if (error && error.status === 401) { close({ restore: false }); return; }
    if (!error && (!data || !Array.isArray(data.results))) error = new Error("搜索的返回格式无法识别");
    if (error) {
      s.state = "error";
      s.final = error.status === 404;
      const said = String((error && error.message) || "");
      s.error = error.status !== 404 ? (scoped ? "没能在这个聊天里找：" : "没能搜索聊过的话：") + (H.visibleError ? H.visibleError(error, "稍后再试") : "稍后再试")
        : !scoped ? "当前后端还没有开放消息搜索。"
        : /[㐀-鿿]/.test(said) ? "没能在这个聊天里找：" + said : "当前后端还没有开放在聊天里查找。";
    } else {
      s.state = "ready";
      s.data = { results: data.results.filter((hit) => hit && hit.chat && hit.messageId), more: !!data.more, failed: Number(data.failed) || 0 };
    }
    paint(true);
  }

  function onInput() {
    if (!S.open) return;
    S.raw = ui.input.value;
    S.refusal = "";
    if (S.confirm) back(false);
    schedule();
    paint(false);
  }

  // ------------------------------------------------------------------- paint
  function paintScope() {
    const sc = S.scope;
    ui.chip.hidden = !sc;
    ui.chipName.textContent = sc ? sc.chat.name : "";
    ui.input.placeholder = sc ? (sc.type === "group" ? "在这个群聊里查找" : "在和" + sc.chat.name + "的聊天里查找") : "搜索猫猫、群聊和聊过的话";
    ui.card.setAttribute("aria-label", sc ? "在「" + sc.chat.name + "」里查找" : "搜索");
  }

  // keep: hold the chosen row if it is still listed (an answer arrived);
  // otherwise the first row is chosen (the query changed).
  function paint(keep) {
    if (!ui) return;
    const was = keep && S.items[S.active] ? S.items[S.active].key : "";
    const chats = chatList(), sel = selection(), cur = R.keyOf(sel), v = R.query(S.raw);
    const sections = [];
    if (!S.scope) {
      if (!v.q) {
        const rec = R.recent(chats, cur);
        if (rec.length) sections.push({ title: "最近", rows: rec.map((chat) => ({ kind: "chat", key: "c:" + R.keyOf(chat), chat, range: null, via: "", here: false })) });
      } else {
        const found = R.chats(chats, v.q);
        if (found.length) sections.push({ title: "猫猫和群聊", rows: found.map((f) => ({ kind: "chat", key: "c:" + R.keyOf(f.chat), chat: f.chat, range: f.range, via: f.via, here: R.keyOf(f.chat) === cur })) });
      }
      const acts = R.actions(actions.list(), v.q, ctx());
      if (acts.length) sections.push({ title: "操作", rows: acts.map((a) => ({ kind: "action", key: "a:" + a.action.id, action: a.action, range: a.range })) });
    }
    const s = S.search;
    let hits = [];
    if (s.state === "ready" && v.q && s.key === searchKey(v.q)) {
      hits = R.scoped(s.data.results, S.scope);
      if (hits.length) sections.push({ title: S.scope ? "找到的消息" : "聊过的话", rows: hits.map((hit) => ({ kind: "message", key: "m:" + R.hitKey(hit), hit, chat: R.chatOf(hit, chats) })) });
    }
    const items = [], groups = [];
    for (const [g, sec] of sections.entries()) {
      const box = node("div", "pal-group");
      box.setAttribute("role", "group");
      // The groups are told apart by their rows (faces, square action tiles,
      // two-line message hits) and a gap; the heading names the group for a
      // screen reader only (item 46).
      const head = node("div", "pal-head visually-hidden", sec.title);
      head.id = "pal-head-" + g;
      head.setAttribute("role", "presentation");
      box.setAttribute("aria-labelledby", head.id);
      box.append(head);
      for (const row of sec.rows) {
        row.el = rowEl(row, items.length);
        items.push(row);
        box.append(row.el);
      }
      groups.push(box);
    }
    ui.list.replaceChildren(...groups);
    S.items = items;
    const at = was ? items.findIndex((it) => it.key === was) : -1;
    setActive(at >= 0 ? at : items.length ? 0 : -1, at < 0);
    paintNotes(v, hits.length, items.length);
  }

  function rowEl(row, index) {
    const el = node("div", "pal-opt pal-" + row.kind);
    el.id = "pal-opt-" + ++optSeq;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", "false");
    if (row.kind === "chat") {
      const c = row.chat;
      el.append(face(c), marked("pal-name", c.name, row.range));
      // A group's portrait says 群聊: its members, or the member it was found by (item 46).
      const sub = row.via ? "有 " + row.via : c.type === "group" ? (c.members || []).join("、") : "";
      if (sub) el.append(node("span", "pal-sub", sub));
      if (row.here) el.append(node("span", "visually-hidden", "，当前"));
    } else if (row.kind === "action") {
      const a = row.action;
      const tile = node("span", "pal-ico");
      let name = a.icon;
      try { if (typeof name === "function") name = name(ctx()); } catch (e) { name = ""; }
      tile.append(icon(name || "arrowRight"));
      el.append(tile, marked("pal-name", a.label, row.range));
      let hint = "";
      try { hint = a.hint ? String(a.hint(ctx()) || "") : ""; } catch (e) { hint = ""; }
      if (hint) el.append(node("span", "pal-sub pal-end", hint));
    } else {
      const hit = row.hit, c = row.chat, name = (c && c.name) || hit.chat.name || "聊天";
      const main = node("span", "pal-main");
      const top = node("span", "pal-line");
      top.append(node("span", "pal-chat", name));
      if (hit.current === false) top.append(node("span", "pal-tag", "之前的对话"));
      const when = R.stamp(hit.time, now());
      if (when) top.append(node("span", "pal-time", when));
      const said = marked("pal-snip", hit.snippet, hit.match);
      said.prepend(node("span", "pal-who", R.who(hit) + "："));
      main.append(top, said);
      el.append(face(c), main);
      el.setAttribute("aria-label", name + "，" + R.who(hit) + "说：" + String(hit.snippet || "") + (when ? "，" + when : "") + (hit.current === false ? "，在之前的对话里" : ""));
    }
    // Choosing with the pointer never takes the caret out of the field.
    el.addEventListener("mousedown", (ev) => ev.preventDefault());
    el.addEventListener("mousemove", () => { if (S.active !== index) setActive(index, false); });
    el.addEventListener("click", () => choose(S.items[index]));
    return el;
  }

  function setActive(index, scroll = true) {
    S.active = index;
    S.items.forEach((it, i) => {
      it.el.classList.toggle("on", i === index);
      it.el.setAttribute("aria-selected", String(i === index));
    });
    const it = S.items[index];
    if (it) {
      ui.input.setAttribute("aria-activedescendant", it.el.id);
      if (scroll && it.el.scrollIntoView) it.el.scrollIntoView({ block: "nearest" });
    } else ui.input.removeAttribute("aria-activedescendant");
  }

  function paintNotes(v, hitCount, rowCount) {
    const out = [];
    const say = (text, cls) => { const p = node("p", "pal-note" + (cls ? " " + cls : ""), text); out.push(p); return p; };
    const s = S.search, current = s.key === searchKey(v.q);
    if (S.refusal) say(S.refusal, "pal-bad");
    if (v.state === "long") say("最多可以搜 " + R.MAX_QUERY + " 个字。");
    // A scope with nothing typed yet: the placeholder and the chat's chip say where it looks (item 46).
    else if (v.q && current && s.state === "waiting") say(S.scope ? "正在这个聊天里找…" : "正在找聊过的话…", "pal-wait");
    else if (v.q && current && s.state === "error") {
      const p = say(s.error, "pal-bad");
      if (!s.final) p.append(document.createTextNode(" "), button("text-btn pal-retry", "重试", () => { schedule(true); paint(true); ui.input.focus(); }));
    } else if (v.q && current && s.state === "ready") {
      const n = R.notes(s.data, { q: v.q, shown: hitCount, scoped: !!S.scope });
      if (n.empty) say(n.empty);
      if (n.failed) say(n.failed, "pal-warn");
      if (n.more) say(n.more);
    }
    // Said once to a screen reader: how much is listed.
    if (v.q && current && s.state === "ready") {
      const chats = rowCount - hitCount - S.items.filter((it) => it.kind === "action").length;
      out.push(node("span", "visually-hidden", (S.scope ? "" : "找到 " + Math.max(0, chats) + " 个聊天，") + hitCount + " 条消息。"));
    }
    ui.notes.replaceChildren(...out);
    ui.notes.hidden = !out.length || !!S.confirm;
  }

  function widen() {
    if (!S.scope) return;
    S.scope = null;
    paintScope();
    schedule();
    paint(false);
    ui.input.focus();
  }

  // ------------------------------------------------------------------ choose
  // A row is what the lists said when it was drawn; by the time it is chosen
  // a cat may have been renamed or removed (the lists are read every few
  // seconds). Every choice is resolved again against the chat list as it is
  // now, by lasting identity (a cat's native ID, a group's ID); one that is
  // gone is refused in place and the palette stays, with the caret in the field.
  async function choose(item) {
    if (!item || !S.open) return;
    const op = ++S.op;
    if (item.kind === "chat") {
      const chat = R.fresh(item.chat, chatList());
      if (!chat) { refuse("「" + item.chat.name + "」已经不在列表里了。"); return; }
      close({ restore: false });
      await openChat({ type: chat.type, id: chat.id });
      if (op === S.op && !S.open && H.focusComposer) H.focusComposer();
      return;
    }
    if (item.kind === "action") {
      const action = actions.get(item.action.id);
      if (!action || !R.actions([action], "", ctx()).length) { refuse("「" + item.action.label + "」现在用不了。"); return; }
      const context = ctx();
      close();
      try { await action.run(context); } catch (e) { note(H.visibleError ? H.visibleError(e) : "没能完成，稍后再试。"); }
      return;
    }
    const chat = R.chatOf(item.hit, chatList());
    if (!chat) { refuse("这条消息所在的聊天已经不在列表里了。"); return; }
    if (item.hit.current === false) { ask({ ...item, chat }); return; }
    await goMessage({ ...item, chat }, op);
  }

  // Said in the palette: the lists are drawn again (the gone row leaves) and the caret stays in the field.
  function refuse(text) {
    S.refusal = text;
    if (S.confirm) back(false);
    paint(false);
    ui.input.focus();
  }

  function note(text) { if (text && H && H.note) H.note(text); }
  // The app opens the chat (its own pickBot / pickGroup, which says its own failures).
  async function openChat(sel) {
    try { await H.open(sel); return true; } catch (e) { return false; }
  }
  const chatArgs = (chat) => ({ type: chat.type, id: chat.id, ...(chat.type === "bot" && chat.nativeId ? { nativeId: chat.nativeId } : {}) });

  // Find a message of a chat's current conversation. op: the choice it
  // belongs to; once a newer one (or a new palette) exists, it stops quietly.
  async function goMessage(item, op, after = "") {
    const { hit, chat } = item;
    if (op !== S.op) return;
    close({ restore: false });
    if (!after && !(await openChat({ type: chat.type, id: chat.id }))) return;
    if (op !== S.op) return;
    // true: found; null: not found and the locate said why itself (the app's
    // replacement reads earlier pages, chat-locate.js); false: not found.
    let ok = false;
    // `still`: this choice is still the palette's latest (reopening it or choosing again ends the lookup).
    try { const r = await api.locate({ ...chatArgs(chat), messageId: hit.messageId, threadId: hit.threadId, still: () => op === S.op }); ok = r === null ? null : !!r; }
    catch (e) { ok = false; }
    if (op !== S.op) return;
    if (ok === false) note(after + "这条消息不在已显示的消息里，可能在更早的记录里。");
  }

  // A message of a cat's earlier conversation: say so, and switch only when asked.
  function ask(item) {
    const name = (item.chat && item.chat.name) || item.hit.chat.name || "这只猫";
    S.confirm = item;
    const title = node("h3", "", "在之前的一段对话里");
    title.id = "pal-confirm-title";
    const text = node("p", "", "这条是你和" + name + "之前的一段对话里说的。切过去以后，和" + name + "说的话会接着那段对话。");
    text.id = "pal-confirm-text";
    const quote = marked("pal-quote", item.hit.snippet, item.hit.match);
    quote.prepend(node("span", "pal-who", R.who(item.hit) + "："));
    const acts = node("div", "pal-acts");
    const no = button("secondary", "取消", () => back(true));
    const yes = button("primary", "切换到那段对话", () => switchAndGo(item));
    acts.append(no, yes);
    ui.confirm.replaceChildren(title, text, quote, acts);
    ui.confirm.setAttribute("aria-labelledby", title.id);
    ui.confirm.setAttribute("aria-describedby", text.id);
    ui.body.hidden = ui.notes.hidden = true;
    ui.confirm.hidden = false;
    yes.focus();
  }
  function back(refocus = true) {
    S.confirm = null;
    ui.confirm.hidden = true;
    ui.confirm.replaceChildren();
    ui.body.hidden = false;
    ui.notes.hidden = !ui.notes.firstChild;
    if (refocus) ui.input.focus();
  }
  // Confirmed: the cat is resolved again (it may have gone while the question
  // was up), its chat opened, and the existing 历史对话 switch asked. Each
  // step goes on only while this is still the latest choice.
  async function switchAndGo(item) {
    if (!S.open) return;
    const op = ++S.op, { hit } = item;
    const chat = R.chatOf(hit, chatList());
    if (!chat || chat.type !== "bot") { refuse("这条消息所在的聊天已经不在列表里了。"); return; }
    close({ restore: false });
    if (!(await openChat({ type: "bot", id: chat.id }))) return;
    if (op !== S.op) return;
    if (!H.switchConversation) { note("现在没法切换到那段对话。"); return; }
    let out = null;
    try { out = await H.switchConversation(hit.threadId); }
    catch (e) { out = { ok: false, text: "没能切换：" + (H.visibleError ? H.visibleError(e, "稍后再试") : "稍后再试") }; }
    if (op !== S.op) return;
    if (!out || !out.ok) { if (out && out.text) note(out.text); return; }
    const now = R.chatOf(hit, chatList());
    if (!now) { note("已切换到那段对话，但这只猫已经不在列表里了。"); return; }
    await goMessage({ ...item, chat: now }, op, "已切换到那段对话，但");
  }

  // ------------------------------------------------------------------ locate
  // The default ClowderPalette.locate: open the chat if it is not open, then
  // find the message among those on screen with chat-experience.js's
  // locate-by-message-ID (it scrolls, flashes and focuses the row). Older
  // pages are not loaded here; the app may replace this with one that does.
  function rowIn(host, id) {
    let hit = null;
    if (host && host.querySelectorAll) for (const r of host.querySelectorAll("[data-mid]")) if (r.dataset.mid === id) hit = r;
    return hit;
  }
  async function locateOnScreen({ type, id, nativeId, messageId } = {}) {
    if (!H || !messageId) return false;
    const sc = R.scope({ type, id, nativeId }, chatList());
    if (!sc) return false;
    const sel = { type: sc.type, id: sc.chat.id };
    if (R.keyOf(selection()) !== R.keyOf(sel) && !(await openChat(sel))) return false;
    const inner = H.history ? H.history(sel) : null;
    const row = rowIn(inner, String(messageId));
    if (!row) return false;
    const X = window.ClowderExperience;
    if (X && X.locate) return !!(await X.locate({ kind: "search", messageId: String(messageId) }));
    if (row.scrollIntoView) row.scrollIntoView({ block: "center" });
    return true;
  }

  // -------------------------------------------------------------------- keys
  // Inside the palette nothing leaks to the page's own key handlers.
  function onLayerKey(ev) {
    ev.stopPropagation();
    if (ev.isComposing || ev.keyCode === 229) return;
    if (R.shortcut(ev, mac) === "palette") { ev.preventDefault(); close(); return; }
    if (ev.key === "Escape") { ev.preventDefault(); if (S.confirm) back(true); else close(); return; }
    if (ev.key === "Tab") { trap(ev); return; }
    if (S.confirm || ev.target !== ui.input) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive(R.move(S.items.length, S.active, ev.key === "ArrowDown" ? 1 : -1));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      choose(S.items[S.active]);
    } else if (ev.key === "Backspace" && S.scope && !ui.input.value) {
      ev.preventDefault();
      widen();
    }
  }
  function focusables() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children || []) {
        if (c.hidden) continue;
        if ((c.tagName === "INPUT" || c.tagName === "BUTTON") && !c.disabled && (!c.getClientRects || c.getClientRects().length > 0)) out.push(c);
        walk(c);
      }
    };
    walk(ui.card);
    return out;
  }
  function trap(ev) {
    const items = focusables();
    ev.preventDefault();
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const next = at < 0 ? (ev.shiftKey ? items.length - 1 : 0) : (at + (ev.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next].focus();
  }

  // Anywhere in the shell: ⌘K / Ctrl+K, Alt+↑ / Alt+↓.
  function onPageKey(ev) {
    const what = R.shortcut(ev, mac);
    if (!what || S.open) return;
    if (blocked()) return;
    if (what === "palette") { ev.preventDefault(); open(); return; }
    // In another field (a form in the drawer, say) the arrows keep their meaning; the composer steps chats.
    const t = ev.target;
    if (t && t !== H.composer && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    ev.preventDefault();
    const target = R.neighbor(sidebarOrder(), R.keyOf(selection()), what === "next" ? 1 : -1);
    const chat = target && chatList().find((c) => R.keyOf(c) === target);
    if (chat) openChat({ type: chat.type, id: chat.id });
  }

  // ------------------------------------------------------------------ public
  function init(hooks) {
    H = hooks || {};
    if (!ui) build();
    registry.clear();
    const dark = () => (H.theme ? H.theme() === "dark" : false);
    if (H.newCat) actions.add({ id: "new-cat", label: "新建猫猫", icon: "plus", keywords: ["猫猫", "新建", "添加", "创建", "领养"], run: (c) => H.newCat(c.opener) });
    // With no cat yet (the first-run stage) a group has nobody to hold: only 新建猫猫 is offered.
    if (H.newGroup) actions.add({ id: "new-group", label: "新建群聊", icon: "users-plus", keywords: ["群聊", "群组", "新建", "创建"],
      when: () => chatList().some((c) => c.type === "bot"), run: (c) => H.newGroup(c.opener) });
    // Its panes are words too: Agents is also found by its old name, 本机工具.
    if (H.settings) actions.add({ id: "settings", label: "设置", icon: "settings", keywords: ["偏好", "选项", "模板", "Agents", "本机工具", "关于", "版本"], run: () => H.settings() });
    if (H.setTheme) {
      actions.add({
        // The page itself and the sun or moon show the theme now: no 「现在是浅色」 beside it (item 46).
        id: "theme", label: "切换深浅色", icon: () => (dark() ? "sun" : "moon"), keywords: ["主题", "外观", "深色", "浅色", "夜间", "暗色"],
        run: () => H.setTheme(dark() ? "light" : "dark"),
      });
    }
    // 搜索: the round lens at the top of the full sidebar; its tooltip and
    // aria-keyshortcuts carry the shortcut. The rail has no 搜索: ⌘K still opens it.
    const entry = document.getElementById("palette-open");
    if (entry && !entry.dataset.palReady) {
      entry.dataset.palReady = "1";
      entry.prepend(lens());
      entry.setAttribute("aria-keyshortcuts", mac ? "Meta+K" : "Control+K");
      entry.dataset.tip = "搜索  " + keyHint();
      entry.addEventListener("click", () => openFrom(entry, {}));
    }
    document.addEventListener("keydown", onPageKey);
    // Focus that wanders out while the palette is up comes back to the field,
    // unless the page changed under it: the shell went away for the sign-in
    // (a 401 anywhere), or another dialog came up. Then the palette closes
    // without taking focus anywhere, its search cancelled and the shell no
    // longer inert, so the sign-in or that dialog keeps its focus.
    document.addEventListener("focusin", (ev) => {
      if (!S.open || !ui || ui.root.contains(ev.target)) return;
      if (blocked()) close({ restore: false });
      else ui.input.focus();
    });
    const shell = document.getElementById("shell");
    if (shell && typeof MutationObserver === "function") {
      new MutationObserver(() => { if (S.open && blocked()) close({ restore: false }); }).observe(shell, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  const api = {
    init, open, close,
    isOpen: () => S.open,
    actions,
    // Replaceable: async ({type, id, nativeId?, messageId, threadId, still}) =>
    // boolean | null. Called after the palette opened that chat; true once the
    // message is on screen and highlighted; null when it was not found and the
    // locate already told the owner why (the palette then says nothing more).
    // type/id name the chat as the app does (a cat by name, a group by ID);
    // nativeId is the cat's native ID; still() is false once the palette moved
    // on (reopened, or another choice), and a lookup still running then stops.
    locate: locateOnScreen,
  };
  window.ClowderPalette = api;
})();
