// The sidebar as a messenger's contact list, and each chat's own draft
// (classic script, window.ClowderList). Loads after chat-list-rules.js and
// before app.js, which calls init() once and then:
//   preview(kind, id)  for a row's second line while nothing more urgent
//                      (working, queued, 等你确认, a failure) takes it;
//   paint(roster)      after each status repaint: the time of the latest
//                      line, the unread count, the order by recency and the
//                      page title;
//   title(base)        whenever the page title changes;
//   leave(sel) / enter(sel)  around opening another chat, for the drafts.
//
// Everything shown comes from the status poll the sidebar already makes (no
// request of its own). The order is recency only: a row moves when a line
// is actually said in its conversation (the owner's send, a finished reply),
// never because work starts or stops, so the list holds still while a reply
// is being written. Drafts are this page's own bookkeeping for the browser
// session; nothing here is a record.
(() => {
  "use strict";
  const R = window.ClowderListRules;
  let H = null;
  const STORE = "clowder-drafts:v1";
  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const raf = (fn) => (typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));
  const kids = (n) => (n && n.children ? [...n.children] : []);

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ------------------------------------------------------------- the rows
  const keyOf = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const rowKey = (row) => (row.dataset.bot ? "bot:" + row.dataset.bot : row.dataset.group ? "group:" + row.dataset.group : "");
  const isOpen = (key) => !!H && keyOf(H.selected()) === key;
  function entryOf(key) {
    const all = H ? H.entries() || {} : {};
    const at = key.indexOf(":"), kind = key.slice(0, at), id = key.slice(at + 1);
    return ((kind === "group" ? all.groups : all.bots) || {})[id] || null;
  }

  // The latest line of a conversation. A read that failed or was partial
  // keeps the line last read for the same conversation: not knowing is not
  // "nothing said". A whole read without one means nothing was said there.
  const known = new Map();
  function lastOf(key) {
    const entry = entryOf(key);
    const l = R.last(entry);
    if (l) { known.set(key, l); return l; }
    if (!entry) return known.get(key) || null;
    if (R.readWhole(entry) || !entry.activity) { known.delete(key); return null; }
    const kept = known.get(key);
    const thread = String(entry.thread_id || entry.activity.threadId || "");
    return kept && (!kept.thread || !thread || kept.thread === thread) ? kept : null;
  }

  // A row's second line from this module: the draft left in that chat, else
  // the latest line said there. null: the row shows what it showed before.
  function preview(kind, id) {
    const key = (kind === "group" ? "group:" : "bot:") + id;
    if (!isOpen(key)) {
      const d = R.draftLine(drafts.get(draftKeyOf({ type: kind === "group" ? "group" : "bot", id })));
      if (d) {
        const line = node("span", "preview cl-draft");
        line.append(node("span", "cl-draft-tag", "草稿："), document.createTextNode(d));
        return { sig: "draft:" + d, node: line };
      }
    }
    const text = R.preview(lastOf(key), kind === "group");
    if (!text) return null;
    return { sig: "said:" + text, node: node("span", "preview", text) };
  }

  // ------------------------------------------------- time, count and title
  let painted = [];
  function paintTime(row, l, now) {
    const head = kids(kids(row).find((c) => c.classList.contains("item-body"))).find((c) => c.classList.contains("name-line"));
    if (!head) return;
    let t = kids(head).find((c) => c.classList.contains("cl-time"));
    if (!t) { t = node("time", "cl-time"); head.append(t); }
    const text = l ? R.ago(l.time, now) : "";
    if (t.textContent !== text) t.textContent = text;
    t.hidden = !text;
    const iso = l ? new Date(l.time).toISOString() : "";
    if (t.getAttribute("datetime") !== iso) {
      if (iso) { t.setAttribute("datetime", iso); t.setAttribute("title", R.stamp(l.time)); }
      else { t.setAttribute("datetime", ""); t.setAttribute("title", ""); }
    }
  }
  function paintCount(row, key) {
    const body = kids(row).find((c) => c.classList.contains("item-body"));
    if (!body) return;
    body.classList.add("cl-body");
    let c = kids(body).find((x) => x.classList.contains("cl-count"));
    // The dot stays on the face; the count says more only from two up, and
    // the open chat shows neither.
    const text = isOpen(key) ? "" : R.badge(R.unread(entryOf(key)));
    if (!text && !c) return;
    if (!c) { c = node("span", "cl-count"); body.append(c); }
    if (c.textContent !== text) c.textContent = text;
    c.hidden = !text;
    c.setAttribute("aria-label", text ? text + " 条新回复" : "");
  }
  function rowsIn(root) {
    const out = [];
    const walk = (n) => { for (const c of kids(n)) { if (c.dataset && (c.dataset.bot || c.dataset.group) && c.classList.contains("item")) out.push(c); else walk(c); } };
    walk(root);
    return out;
  }
  function paint(roster) {
    if (!H || !roster) return;
    const now = Date.now();
    painted = [];
    for (const row of rowsIn(roster)) {
      const key = rowKey(row);
      if (!key) continue;
      const l = lastOf(key);
      paintTime(row, l, now);
      paintCount(row, key);
      painted.push(row);
    }
    arrange(roster);
    refocus(roster);
    applyTitle();
  }
  // The list is drawn anew whenever a dot or a name changes (renderLists): a
  // row that had keyboard focus gets it back on its new element, so a reply
  // landing elsewhere never takes the owner's place in the list.
  let focusRow = null;
  function refocus(roster) {
    if (!focusRow || focusRow.isConnected) return;
    const here = document.activeElement;
    if (here && here !== document.body) { focusRow = null; return; }
    const key = rowKey(focusRow);
    const row = rowsIn(roster).find((r) => rowKey(r) === key) || null;
    focusRow = null;
    if (row && typeof row.focus === "function") { row.focus({ preventScroll: true }); focusRow = row; }
  }
  function watchFocus() {
    if (typeof document.addEventListener !== "function") return;
    document.addEventListener("focusin", (ev) => {
      const t = ev.target;
      const row = t && t.classList && t.classList.contains("item") && t.dataset && (t.dataset.bot || t.dataset.group) && t.closest && t.closest("#roster") ? t : null;
      // Only keyboard focus is kept (a tap or click on a row opens its chat and needs none).
      let keyboard = true;
      try { keyboard = !row || row.matches(":focus-visible"); } catch (e) { /* older engines: keep it */ }
      focusRow = row && keyboard ? row : null;
    });
  }
  // Keep the times fresh between polls (刚刚 → 1 分钟前 → 14:05).
  function tick() {
    const now = Date.now();
    for (const row of painted) if (row.isConnected) paintTime(row, lastOf(rowKey(row)), now);
  }

  let base = "";
  function title(text) {
    base = String(text || "");
    applyTitle();
  }
  function applyTitle() {
    if (!base) base = document.title || "clowder-bot";
    const all = H ? H.entries() || {} : {};
    const entries = [...Object.values(all.bots || {}), ...Object.values(all.groups || {})];
    const next = R.title(base, R.total(entries));
    if (document.title !== next) document.title = next;
  }

  // -------------------------------------------------------------- the order
  // Where each row was laid out at the last paint, so a list drawn anew still
  // glides from where the owner last saw it.
  const seenAt = new Map();
  function scroller(roster) {
    let n = roster;
    while (n && !(n.classList && n.classList.contains("side-scroll"))) n = n.parentElement;
    return n || roster.parentElement || roster;
  }
  // A row's place in the page's layout: offsets ignore scrolling and any glide
  // still running, so a repaint mid-glide neither restarts nor re-aims it.
  function yOf(row, box) {
    if (typeof row.offsetTop === "number" && "offsetParent" in row) {
      if (!row.offsetParent) return null; // not laid out (signed out, hidden): no place to glide from
      let y = 0;
      for (let n = row; n; n = n.offsetParent) y += n.offsetTop;
      return y;
    }
    if (typeof row.getBoundingClientRect !== "function") return null;
    const r = row.getBoundingClientRect();
    if (r.height === 0) return null;
    const top = typeof box.getBoundingClientRect === "function" ? box.getBoundingClientRect().top : 0;
    return r.top - top + (box.scrollTop || 0);
  }
  // The longest run of rows already in their wanted order, always keeping the
  // focused row (moving a focused element would take its focus away).
  function steady(pos, fixed) {
    const lis = (idx) => {
      const tails = [], prev = new Array(idx.length).fill(-1), at = [];
      idx.forEach((i, k) => {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pos[tails[mid]] < pos[i]) lo = mid + 1; else hi = mid; }
        prev[k] = lo ? at[lo - 1] : -1;
        tails[lo] = i; at[lo] = k;
      });
      const out = [];
      for (let k = at[tails.length - 1]; k !== undefined && k >= 0; k = prev[k]) out.push(idx[k]);
      return out;
    };
    const all = pos.map((_, i) => i);
    if (fixed < 0) return new Set(lis(all));
    const left = all.filter((i) => i < fixed && pos[i] < pos[fixed]);
    const right = all.filter((i) => i > fixed && pos[i] > pos[fixed]);
    return new Set([...lis(left), fixed, ...lis(right)]);
  }
  function reorder(rows, wanted) {
    const parent = rows[0].parentElement;
    const where = new Map(wanted.map((r, i) => [r, i]));
    const pos = rows.map((r) => where.get(r));
    const active = document.activeElement;
    const fixed = rows.findIndex((r) => r === active || (r.contains && active && r.contains(active)));
    const keep = steady(pos, fixed);
    let next = rows[rows.length - 1].nextSibling || null;
    for (let i = wanted.length - 1; i >= 0; i--) {
      const r = wanted[i];
      if (!keep.has(rows.indexOf(r))) parent.insertBefore(r, next);
      next = r;
    }
    // Belt and braces: focus that was in the list stays where it was.
    if (active && active !== document.activeElement && active.isConnected && typeof active.focus === "function") active.focus({ preventScroll: true });
  }
  function glide(rows, from, box) {
    const moved = [];
    for (const r of rows) {
      const was = from.get(rowKey(r)), now = yOf(r, box);
      if (was == null || now == null) continue;
      const dy = was - now;
      if (Math.abs(dy) < 1 || Math.abs(dy) > 2000) continue;
      r.classList.remove("cl-moving");
      r.style.transform = "translateY(" + dy + "px)";
      moved.push(r);
    }
    if (!moved.length) return;
    void moved[0].offsetHeight; // start from the old place
    raf(() => {
      for (const r of moved) {
        r.classList.add("cl-moving");
        r.style.transform = "";
        const done = () => { r.classList.remove("cl-moving"); r.removeEventListener("transitionend", done); };
        r.addEventListener("transitionend", done);
        setTimeout(done, 400);
      }
    });
  }
  function arrangeList(rows, box, motion) {
    if (rows.length < 2) return;
    const wanted = R.order(rows.map((r) => ({ key: rowKey(r), time: (lastOf(rowKey(r)) || {}).time || 0 })));
    const byKey = new Map(rows.map((r) => [rowKey(r), r]));
    const list = wanted.map((k) => byKey.get(k));
    // The order the owner last saw (a list drawn anew starts in the server's order).
    const before = rows.filter((r) => seenAt.has(rowKey(r))).sort((a, b) => seenAt.get(rowKey(a)) - seenAt.get(rowKey(b))).map(rowKey);
    const seenOrder = wanted.filter((k) => before.includes(k));
    const changed = before.length > 1 && before.some((k, i) => k !== seenOrder[i]);
    const from = new Map(rows.map((r) => [rowKey(r), seenAt.get(rowKey(r))]));
    if (list.some((r, i) => r !== rows[i])) reorder(rows, list);
    if (motion && changed) glide(list, from, box);
  }
  function arrange(roster) {
    const box = scroller(roster);
    const motion = !reduced();
    // Cats inside each folder (or the one flat list), and the groups.
    const lists = [];
    const walk = (n) => { for (const c of kids(n)) { if (c.classList.contains("folder-bots")) lists.push(kids(c).filter((r) => r.dataset.bot && r.classList.contains("item"))); else if (!c.dataset.bot && !c.dataset.group) walk(c); } };
    walk(roster);
    lists.push(kids(roster).filter((r) => r.dataset.group && r.classList.contains("item")));
    for (const rows of lists) arrangeList(rows, box, motion);
    for (const rows of lists) for (const r of rows) { const y = yOf(r, box); if (y != null) seenAt.set(rowKey(r), y); }
  }

  // ------------------------------------------------------------------ drafts
  function loadSaved() {
    try { return JSON.parse(sessionStorage.getItem(STORE) || "{}"); } catch (e) { return {}; }
  }
  const drafts = R.drafts(loadSaved());
  function save(extra) {
    try {
      const all = drafts.toJSON();
      if (extra) all[extra.key] = { text: extra.text, quote: extra.quote };
      sessionStorage.setItem(STORE, JSON.stringify(all));
    } catch (e) { /* storage unavailable or full: the drafts live for this page only */ }
  }
  // A chat's draft key (chat-list-rules.js draftKey): a cat by its native ID,
  // so a rename keeps its draft and a new cat that reuses a deleted one's
  // name starts empty. A draft saved under the old name key moves over once.
  function draftKeyOf(sel) {
    if (!sel || !sel.id) return "";
    const id = sel.type === "bot" && H && H.catId ? String(H.catId(sel.id) || "") : "";
    const key = R.draftKey(sel, id);
    if (id && drafts.move("bot:" + sel.id, key)) save();
    return key;
  }
  // The open chat: its key as it was opened (a rename must not lose it), and
  // a restored quote still waiting for a read to show its conversation.
  let open = null;
  const isOpenChat = (sel) => !!open && !!sel && open.type === sel.type && open.id === sel.id;
  // Leaving a chat: what is in the composer (and, in a single chat, the
  // message it quotes, with its conversation) stays with that chat.
  function leave(sel) {
    if (!H || !sel || !sel.id) { open = null; return; }
    const key = isOpenChat(sel) ? open.key : draftKeyOf(sel);
    const quote = sel.type === "bot" ? H.composer.quote() || (open && open.quote) : null;
    open = null;
    if (key && drafts.put(key, H.composer.text(), quote)) save();
  }
  // Opening a chat: its own draft comes back, or the composer is empty. Its
  // quote waits for the first read of the chat (read) and comes back only if
  // the chat is still in the conversation the quote was taken in.
  function enter(sel) {
    open = null;
    if (!H || !sel || !sel.id) return;
    const key = draftKeyOf(sel);
    const d = drafts.take(key);
    save();
    open = { type: sel.type, id: sel.id, key, quote: d && sel.type === "bot" ? d.quote : null };
    H.composer.set(d ? d.text : "");
    H.composer.setQuote(null);
  }
  // Each transcript read of the open single chat (threadId: its conversation
  // now): a waiting quote comes back if it belongs here and is dropped if not;
  // a quote in the composer from another conversation (the chat moved
  // meanwhile, say in another tab) is taken away, so a reply never points at
  // a message of the wrong conversation.
  function read(sel, threadId) {
    if (!H || !isOpenChat(sel) || !threadId) return;
    const now = H.composer.quote();
    if (now && now.thread && now.thread !== threadId) H.composer.setQuote(null);
    const waiting = open.quote;
    open.quote = null;
    if (waiting && R.quoteFits(waiting, threadId) && !H.composer.quote()) H.composer.setQuote(waiting);
  }
  // A send that did not go out, after the owner left its chat: its words and
  // quote go back to that chat's draft, unless the owner wrote a new one there.
  function giveBack(sel, text, quote) {
    if (!sel || !sel.id) return false;
    // Already open again (the owner came back before the answer): the words go
    // into an empty composer, the quote waits for the next read to fit.
    if (isOpenChat(sel) && H) {
      if (H.composer.text().trim()) return false;
      H.composer.set(text);
      if (sel.type === "bot" && quote && !H.composer.quote()) open.quote = quote;
      return true;
    }
    const key = draftKeyOf(sel);
    if (!key || drafts.get(key)) return false;
    if (drafts.put(key, text, sel.type === "bot" ? quote : null)) { save(); return true; }
    return false;
  }
  // A cat deleted for good: its draft goes too (by its ID and its old name key).
  function forget(sel) {
    if (!sel || !sel.id) return;
    const key = draftKeyOf(sel);
    let changed = drafts.drop(key);
    changed = drafts.drop("bot:" + sel.id) || changed;
    if (open && open.key === key) open = null;
    if (changed) save();
  }
  // A reload keeps the open chat's draft too (sessionStorage, this tab only).
  function persistOpen() {
    if (!H) return;
    const sel = H.selected();
    const key = isOpenChat(sel) ? open.key : draftKeyOf(sel);
    const text = key ? H.composer.text() : "";
    const quote = key && sel.type === "bot" ? H.composer.quote() || (open && open.quote) : null;
    save(key && (text.trim() || quote) ? { key, text, quote } : null);
  }

  // ------------------------------------------------------------- stale
  // The status could not be read (the whole request failed): the rows keep
  // what was last read, and one quiet line over the list says so until a
  // read succeeds. The title keeps the last known count.
  let staleLine = null;
  function stale(on) {
    const roster = document.getElementById("roster");
    if (!staleLine && on && roster && roster.parentElement) {
      staleLine = node("p", "cl-stale", "状态没能刷新，下面是上次读到的，可能已经变化。");
      staleLine.setAttribute("role", "status");
      roster.parentElement.insertBefore(staleLine, roster);
    }
    if (staleLine) staleLine.hidden = !on;
  }

  // -------------------------------------------------------------------- init
  // Hooks from app.js:
  //   entries()   the status poll's {bots: {name: entry}, groups: {id: entry}};
  //   selected()  the open chat ({type, id}) or null;
  //   catId(name) a cat's native ID (drafts are kept by it);
  //   composer    {text(), set(text), quote(), setQuote(q)}; a quote is
  //               {seq, text, thread} (thread: the conversation it was taken in).
  let timer = 0;
  function init(hooks) {
    H = hooks;
    if (!timer) { timer = setInterval(tick, 30000); watchFocus(); }
    if (typeof window.addEventListener === "function") window.addEventListener("pagehide", persistOpen);
  }

  window.ClowderList = Object.freeze({
    init, preview, paint, tick, title, leave, enter, read, giveBack, forget, persist: persistOpen, stale,
    // For tests and diagnostics only.
    draft: (sel) => drafts.get(draftKeyOf(sel)),
  });
})();
