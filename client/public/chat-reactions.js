// Replying to one message and reacting to it with an emoji (classic script,
// window.ClowderReactions). Loads after chat-reactions-rules.js and before
// app.js, which calls init() once; then:
//   select(sel)              another chat or conversation: the picker closes and
//                            what this page has seen starts over;
//   before(messages)         a read is about to be drawn: where each cat's reply
//                            that became a reaction was written (for its landing);
//   rendered(messages, group) after each keyed commit of the history: the hover
//                            buttons (表情, 回复), the chips on each row, and the
//                            reaction IDs a row carries (data-rx, data-rxs);
//   strip(message, said, close) the emoji row for the top of the message menu;
//   close()                  close the picker.
//
// A reaction is an ordinary message (one emoji, quoting the cat's words) sent
// with the existing POST <scope>/messages, not through the composer: no bubble
// of the owner's, the composer's words, draft and quote stay as they are. The
// chip shows at once, quietly while on its way, and is settled once a read has
// it among the row's reactions (the receipt's userMessageId); one that did not
// go out leaves and the owner is told. Nothing is stored: the record says what
// is drawn on a row, this page only remembers what it sent and has not seen
// back yet, and which chips it has already shown (so each comes in once).
(() => {
  "use strict";
  const R = window.ClowderReactionRules;
  let H = null;
  const kids = (n) => (n && n.children ? [...n.children] : []);
  const has = (n, c) => !!n && !!n.classList && n.classList.contains(c);
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function glyph(body) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.classList.add("icon");
    s.innerHTML = body;
    return s;
  }
  // A face with a small plus (表情), and the app's own reply arrow (回复).
  const FACE = '<path d="M21 11.5V12a9 9 0 1 1-9-9h.5"/><path d="M8.5 14.5s1.3 1.7 3.5 1.7 3.5-1.7 3.5-1.7"/><path d="M9 9.5h.01M15 9.5h.01"/><path d="M16.5 5.5h5M19 3v5"/>';
  const REPLY = '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>';
  const reduced = () => { try { return !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  const chatKey = (sel) => (sel && sel.id ? (sel.type === "group" ? "group:" : "bot:") + sel.id : "");
  const frame = (fn) => (typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(fn) : fn());

  const P = {
    key: "",
    // The open chat's rows as last drawn, by native message ID.
    byMid: new Map(),
    // A group's members (names, or IDs the list does not know), the newest page's message IDs.
    members: null, latest: null,
    // Reaction IDs whose chip this page has shown (a chip comes in once).
    known: new Set(),
    // Histories already drawn once (the first drawing of a chat brings nothing in).
    drawn: new WeakSet(),
    // This page's own reactions on their way, and the keys of sends whose outcome is not known.
    pending: [], retry: new Map(),
    // What each bubble says (its message menu's words): an ended reply's stand-in is nothing to react to.
    said: new Map(),
    // Where a cat's reply that became a reaction was drawn, by its ID (in the history's own coordinates).
    flights: new Map(),
    picker: null,
  };
  const threadId = () => str(H && H.threadId ? H.threadId() : "");
  function currentInner() {
    const key = chatKey(H && H.selected ? H.selected() : null);
    return kids(H && H.thread).find((c) => has(c, "thread-inner") && !has(c, "thread-skeleton") && !has(c, "no-chat") && !!key && c.dataset.chat === key) || null;
  }
  const mine = (p) => p.key === P.key && p.thread === threadId();
  const pendingFor = (mid) => P.pending.filter((p) => mine(p) && p.mid === mid);
  const ctxOf = (m, said) => ({ peer: !!(H.peer && H.peer()), latest: P.latest, members: P.members, name: H.catName, said });
  const colOf = (row) => kids(row).find((c) => has(c, "bubble-col") || has(c, "body")) || null;

  function select(sel) {
    closePicker(false);
    P.key = chatKey(sel);
    P.known.clear();
    P.flights.clear();
    P.said.clear();
    P.byMid = new Map();
  }

  // ------------------------------------------------------------- the landing
  // A cat's whole answer that was one emoji is written as a reply (a row, or
  // its typing bubble) and then, finished, is drawn on the owner's row
  // instead. Before the read that says so is drawn, note where it was
  // written, so its chip can come down from there; the reply's row itself
  // goes in the same drawing, leaving nothing behind.
  function before(messages) {
    if (!H || reduced()) return;
    const inner = currentInner(), thread = H.thread;
    if (!inner || !P.drawn.has(inner) || !thread || typeof thread.getBoundingClientRect !== "function") return;
    const t = thread.getBoundingClientRect();
    for (const m of messages || []) for (const r of R.marks(m)) {
      if (r.mine || P.known.has(r.id) || P.flights.has(r.id)) continue;
      const row = kids(inner).find((c) => has(c, "msg") && c.dataset.mid === r.id);
      const bubble = row && (row.querySelector(".lv-text") || row.querySelector(".bot-bubble"));
      if (!bubble || typeof bubble.getBoundingClientRect !== "function") continue;
      const b = bubble.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      P.flights.set(r.id, { left: b.left - t.left, top: b.top - t.top + (thread.scrollTop || 0), width: b.width, height: b.height });
    }
  }

  // ------------------------------------------------------------- the drawing
  function rendered(messages, group) {
    if (!H) return;
    P.key = chatKey(H.selected ? H.selected() : null);
    P.byMid = new Map();
    for (const m of messages || []) { const id = R.midOf(m); if (id) P.byMid.set(id, m); }
    P.members = group && Array.isArray(group.members) ? group.members.map(String) : null;
    P.latest = H.latest ? H.latest() : null;
    // This page's own reactions the record now has: their chips are already
    // on screen, so they do not come in again.
    P.pending = P.pending.filter((p) => {
      if (!mine(p) || !R.settled(p, messages)) return true;
      if (p.id) P.known.add(p.id);
      const m = P.byMid.get(p.mid);
      for (const r of R.marks(m)) if (r.mine && r.emoji === p.emoji) P.known.add(r.id);
      return false;
    });
    const inner = currentInner();
    // The row the picker belongs to was drawn anew: the picker goes with the old one.
    if (P.picker && !P.picker.anchor.isConnected) closePicker(false);
    if (!inner) return;
    const first = !P.drawn.has(inner);
    P.drawn.add(inner);
    paint(inner, first);
  }
  function paint(inner, first) {
    const last = new Map();
    for (const row of kids(inner)) {
      if (!has(row, "msg") || has(row, "live") || has(row, "optimistic")) continue;
      const mid = row.dataset.mid, m = mid ? P.byMid.get(mid) : null;
      rail(row, m, H.messageOf ? H.messageOf(row) : null);
      if (m) last.set(mid, row);
    }
    const hosts = new Set(last.values());
    const moves = [];
    for (const row of kids(inner)) {
      if (!has(row, "msg") || hosts.has(row)) continue;
      const box = kids(colOf(row)).find((c) => has(c, "rx-chips"));
      if (box) box.remove();
    }
    for (const [mid, row] of last) chipsOn(row, P.byMid.get(mid), first, moves);
    for (const m of P.byMid.values()) for (const r of R.marks(m)) P.known.add(r.id);
    inset(inner);
    refit(inner);
    if (moves.length) frame(() => { for (const fn of moves) fn(); });
  }
  // Once painted, the next drawing of the same row changes nothing.
  function repaint() {
    const inner = currentInner();
    if (inner && P.drawn.has(inner)) paint(inner, false);
  }

  // ---- The hover buttons: 表情 and 回复 beside the bubble ----
  function rail(row, m, data) {
    const col = colOf(row);
    if (!col) return;
    const old = kids(col).find((c) => has(c, "rx-acts"));
    const reply = !!data && !!m && R.canReply(m, !!(H.peer && H.peer()));
    if (data && m) P.said.set(R.midOf(m), str(data.text));
    const react = reply && R.canReact(m, ctxOf(m, data.text));
    const want = !reply ? "" : react ? "react reply" : "reply";
    if (old && old.dataset.rx === want) return;
    if (old) old.remove();
    if (!want) return;
    const box = node("span", "rx-acts");
    box.dataset.rx = want;
    box.dataset.n = react ? "2" : "1";
    if (react) box.append(action("react"));
    box.append(action("reply"));
    col.append(box);
  }
  function action(kind) {
    const b = node("button", "rx-act rx-act-" + kind);
    b.type = "button";
    b.append(glyph(kind === "react" ? FACE : REPLY));
    if (kind === "react") {
      b.setAttribute("aria-label", "回个表情");
      b.setAttribute("aria-haspopup", "menu");
      b.setAttribute("aria-expanded", "false");
      if (H.setTip) H.setTip(b, "表情");
    } else {
      b.setAttribute("aria-label", "回复");
      if (H.setTip) H.setTip(b, "回复");
    }
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const row = b.closest(".msg"), mid = row && row.dataset.mid, m = mid ? P.byMid.get(mid) : null;
      if (!m) return;
      if (kind === "react") openPicker(b, mid);
      else { closePicker(false); if (H.reply) H.reply(m); }
    });
    return b;
  }
  // How much room there is beside the bubble, inside the conversation's
  // visible width, decides where the buttons go, measured when the pointer
  // or focus arrives: a line beside the bubble's foot with the time beyond
  // them; with less room, the buttons above the time (rx-tight); with no room
  // beside it at all (a full-width bubble on a narrow window), a small
  // toolbar holding the time and the buttons over the bubble's inner foot
  // corner (rx-over). Never past the edge, never a sideways scroll.
  const TIME = 40;
  const hovered = (row) => { try { return typeof row.matches === "function" && row.matches(":hover"); } catch (e) { return false; } };
  // The rows under the pointer or holding the focus get their fit again: one
  // drawn anew (no new pointerover comes for it), or the window resized.
  function refit(inner) {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    for (const row of kids(inner)) if (has(row, "msg") && (hovered(row) || (!!active && row.contains(active)))) fit(row);
  }
  function fit(row) {
    const col = colOf(row), acts = col && kids(col).find((c) => has(c, "rx-acts"));
    const thread = H.thread;
    if (!acts || typeof col.getBoundingClientRect !== "function" || !thread || typeof thread.getBoundingClientRect !== "function") return;
    row.classList.remove("rx-tight", "rx-over");
    const c = col.getBoundingClientRect(), t = thread.getBoundingClientRect();
    // The buttons' own width (28px each, 2px apart): known without showing them.
    const n = Number(acts.dataset.n) || 1, w = n * 28 + (n - 1) * 2;
    if (!c.width) return;
    const inset = parseFloat(col.style && typeof col.style.getPropertyValue === "function" ? col.style.getPropertyValue("--rx-inset") : "") || 0;
    const right = t.left + (thread.clientWidth || t.width);
    const room = has(row, "user") ? c.left + inset - t.left : right - (c.right - inset);
    if (room >= 4 + w + 6 + TIME) return;
    row.classList.add(room >= 4 + Math.max(w, TIME) + 4 ? "rx-tight" : "rx-over");
  }

  // A quote wider than the bubble under it widens the message's column, and
  // what sits beside the bubble's foot (the buttons, the time, the seen paw)
  // would float beside the quote instead. --rx-inset brings them back to the
  // bubble (chat-reactions.css); measured after each drawing and on resize.
  const ASIDE = ["quote-block", "ht", "rx-acts", "pz-seen", "rx-chips", "who"];
  function inset(inner) {
    for (const row of kids(inner)) {
      const col = has(row, "msg") ? colOf(row) : null;
      if (!col || !col.style || typeof col.style.setProperty !== "function") continue;
      const list = kids(col);
      if (!list.some((c) => has(c, "quote-block"))) { if (col.style.getPropertyValue("--rx-inset")) col.style.removeProperty("--rx-inset"); continue; }
      const own = list.filter((c) => !ASIDE.some((k) => has(c, k))).map((c) => c.offsetWidth || 0);
      const d = Math.round((col.offsetWidth || 0) - Math.max(0, ...own));
      if (own.length && d > 1) col.style.setProperty("--rx-inset", d + "px");
      else col.style.removeProperty("--rx-inset");
    }
  }

  // ---- The chips on a row ----
  function chipsOn(row, m, first, moves) {
    const col = colOf(row);
    if (!col) return;
    const pend = pendingFor(R.midOf(m));
    const list = R.marks(m), groups = R.chips(list, pend, H.catName);
    // The owner's own tap shows its chip once, at once; a redrawn row does not bring it in again.
    const tapped = new Set(pend.filter((p) => !p.shown).map((p) => p.emoji));
    for (const p of pend) p.shown = true;
    const rx = R.carried(list);
    if (rx.ids) row.dataset.rx = rx.ids; else delete row.dataset.rx;
    if (rx.seqs) row.dataset.rxs = rx.seqs; else delete row.dataset.rxs;
    let box = kids(col).find((c) => has(c, "rx-chips"));
    if (!groups.length) { if (box) box.remove(); return; }
    // Whose words the chips are on reads from the bubble they sit on; each
    // chip says what and who (its label and tip).
    if (!box) box = node("div", "rx-chips");
    place(col, box);
    const old = new Map(kids(box).map((c) => [c.dataset.emoji, c]));
    groups.forEach((g, i) => {
      let c = old.get(g.emoji);
      old.delete(g.emoji);
      const fresh = !first && g.ids.some((id) => !P.known.has(id));
      const born = !c;
      if (!c) c = chip(g); else update(c, g);
      if (kids(box)[i] !== c) box.insertBefore(c, kids(box)[i] || null);
      if (reduced() || first) return;
      if (born && (fresh || tapped.has(g.emoji))) {
        const flight = g.ids.map((id) => P.flights.get(id)).find(Boolean);
        moves.push(() => (flight ? fly(c, flight) : pop(c)));
      } else if (!born && (fresh || tapped.has(g.emoji))) moves.push(() => bump(c));
    });
    for (const id of list.map((r) => r.id)) P.flights.delete(id);
    for (const c of old.values()) c.remove();
  }
  // Right under the bubble's corner (the last bubble of the message), pressed
  // onto it; a message with no bubble (files only) has them under its content.
  function place(col, box) {
    const list = kids(col).filter((c) => c !== box);
    const bubbles = list.filter((c) => has(c, "bubble") || (has(c, "bot-bubble") && !has(c, "lv-text")));
    const after = bubbles[bubbles.length - 1];
    const ref = after ? list[list.indexOf(after) + 1] || null : list.find((c) => has(c, "ht") || has(c, "rx-acts") || has(c, "pz-seen")) || null;
    const now = kids(col), at = now.indexOf(box);
    if (at >= 0 && (now[at + 1] || null) === ref) return;
    col.insertBefore(box, ref);
  }
  function chip(g) {
    const c = node("span", "rx-chip");
    c.dataset.emoji = g.emoji;
    c.setAttribute("role", "img");
    c.append(node("span", "rx-glyph", g.emoji));
    update(c, g);
    return c;
  }
  function update(c, g) {
    const sig = R.chipSig(g);
    if (c.dataset.sig === sig) return;
    c.dataset.sig = sig;
    c.classList.toggle("rx-mine", g.mine);
    c.classList.toggle("rx-sending", g.sending);
    let n = kids(c).find((k) => has(k, "rx-n"));
    if (g.count > 1) {
      if (!n) { n = node("span", "rx-n"); c.append(n); }
      n.textContent = String(g.count);
    } else if (n) n.remove();
    c.setAttribute("aria-label", g.emoji + " " + g.who);
    if (H.setTip) H.setTip(c, g.who);
  }

  // ---- Motion: each chip comes in once; reduced motion, never ----
  function token(name, fallback) {
    try {
      const v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
      return v && String(v).trim() ? String(v).trim() : fallback;
    } catch (e) { return fallback; }
  }
  function run(n, frames, opts) {
    if (!n || !n.isConnected || typeof n.animate !== "function") return null;
    try { return n.animate(frames, opts); } catch (e) { return null; }
  }
  // Pressed onto the bubble: in with the pop token's spring. 🐾 is stamped,
  // the way the seen paw is (chat-presence.css).
  function pop(c) {
    const duration = parseFloat(token("--dur-pop", "240")) || 240, easing = token("--ease-spring", "cubic-bezier(.34, 1.56, .64, 1)");
    run(c, [{ transform: "scale(.5)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration, easing });
    if (c.dataset.emoji === "🐾") {
      run(kids(c).find((k) => has(k, "rx-glyph")), [{ transform: "translateY(-3px) rotate(-26deg) scale(1.4)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration, easing });
    }
  }
  function bump(c) {
    run(c, [{ transform: "scale(1.16)" }, { transform: "none" }], { duration: 200, easing: "ease-out" });
  }
  // A cat's one-emoji answer comes down from where it was written to the
  // corner of the owner's bubble: the reply's row is gone, the emoji lands.
  function fly(c, o) {
    const thread = H.thread;
    if (!c.isConnected || typeof c.getBoundingClientRect !== "function" || !thread) return pop(c);
    const t = thread.getBoundingClientRect(), b = c.getBoundingClientRect();
    const dx = o.left + t.left + o.width / 2 - (b.left + b.width / 2);
    const dy = o.top + t.top - (thread.scrollTop || 0) + o.height / 2 - (b.top + b.height / 2);
    if (!b.width || Math.abs(dy) > (thread.clientHeight || 800)) return pop(c);
    run(c, [{ transform: "translate(" + Math.round(dx) + "px, " + Math.round(dy) + "px) scale(1.3)" }, { transform: "none" }],
      { duration: 360, easing: "cubic-bezier(.2, .8, .2, 1)" });
  }

  // ------------------------------------------------------------- the picker
  // The five, in one row; the ones the owner already sent on this row are
  // shown chosen and do nothing (a delivered message is not taken back).
  function emojiRow(mid, cls, done) {
    const m = P.byMid.get(mid);
    const box = node("div", cls);
    const given = R.given(R.marks(m), pendingFor(mid));
    for (const e of R.EMOJIS) {
      const b = node("button", "rx-emo");
      b.type = "button";
      b.dataset.emoji = e;
      b.append(node("span", "", e));
      // Sent: 已回应. On its way: 发送中, until the record has it.
      if (given.has(e)) {
        const sending = given.get(e) === "sending";
        b.classList.add("rx-given");
        b.classList.toggle("rx-pending", sending);
        b.setAttribute("aria-disabled", "true");
        b.setAttribute("aria-label", e + (sending ? " 发送中" : " 已回应"));
      }
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (b.getAttribute("aria-disabled") === "true") return;
        done();
        react(mid, e);
      });
      box.append(b);
    }
    // ← → Home End move along the row.
    box.addEventListener("keydown", (ev) => {
      const list = kids(box), i = list.indexOf(document.activeElement);
      let to = -1;
      if (ev.key === "ArrowRight") to = (i + 1) % list.length;
      else if (ev.key === "ArrowLeft") to = (i - 1 + list.length) % list.length;
      else if (ev.key === "Home") to = 0;
      else if (ev.key === "End") to = list.length - 1;
      if (to < 0) return;
      ev.preventDefault();
      list[to].focus();
    });
    return box;
  }
  function openPicker(anchor, mid) {
    const again = P.picker && P.picker.anchor === anchor;
    closePicker(again);
    if (again) return;
    const m = P.byMid.get(mid);
    if (!m) return;
    const row = anchor.closest(".msg");
    const menu = emojiRow(mid, "rx-pick", () => closePicker(false));
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-orientation", "horizontal");
    menu.setAttribute("aria-label", "表情");
    for (const b of kids(menu)) b.setAttribute("role", "menuitem");
    menu.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" || ev.key === "Tab") { ev.preventDefault(); ev.stopPropagation(); closePicker(true); }
    });
    document.body.append(menu);
    place2(menu, anchor);
    P.picker = { menu, anchor, row, mid };
    if (row) row.classList.add("rx-open");
    anchor.setAttribute("aria-expanded", "true");
    if (!reduced()) {
      const duration = parseFloat(token("--dur-pop", "240")) || 240, easing = token("--ease-spring", "cubic-bezier(.34, 1.56, .64, 1)");
      run(menu, [{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration, easing });
    }
    const target = kids(menu).find((b) => b.getAttribute("aria-disabled") !== "true") || kids(menu)[0];
    if (target) target.focus({ preventScroll: true });
  }
  // Above the button, centred on it, inside the window; below it when the
  // header leaves no room above.
  function place2(menu, anchor) {
    if (typeof anchor.getBoundingClientRect !== "function") return;
    const a = anchor.getBoundingClientRect(), w = menu.offsetWidth || 0, h = menu.offsetHeight || 0;
    const head = document.querySelector(".chat > .top");
    const ceiling = head && typeof head.getBoundingClientRect === "function" ? head.getBoundingClientRect().bottom : 0;
    let top = a.top - h - 6;
    const below = top < ceiling + 8;
    if (below) top = a.bottom + 6;
    const vw = window.innerWidth || 0;
    const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, vw - w - 8));
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
    menu.style.transformOrigin = Math.round(a.left + a.width / 2 - left) + "px " + (below ? "0" : "100%");
  }
  function closePicker(refocus) {
    const p = P.picker;
    if (!p) return;
    P.picker = null;
    p.menu.remove();
    if (p.row) p.row.classList.remove("rx-open");
    p.anchor.setAttribute("aria-expanded", "false");
    if (refocus && p.anchor.isConnected) p.anchor.focus({ preventScroll: true });
  }
  // The message menu's own row of the five (right click, long press).
  function strip(message, said, close) {
    if (!H || !message) return null;
    const mid = R.midOf(message), m = P.byMid.get(mid) || message;
    P.said.set(mid, str(said));
    if (!R.canReact(m, ctxOf(m, said))) return null;
    if (!P.byMid.has(mid)) P.byMid.set(mid, m);
    const box = emojiRow(mid, "rx-strip", () => { if (close) close(); });
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "表情");
    return box;
  }

  // ------------------------------------------------------------- sending
  async function react(mid, emoji) {
    const sel = H && H.selected ? H.selected() : null;
    const m = P.byMid.get(mid);
    if (!sel || !m || (H.peer && H.peer())) return;
    if (!R.canReact(m, ctxOf(m, P.said.get(mid))) || R.given(R.marks(m), pendingFor(mid)).has(emoji)) return;
    const key = chatKey(sel), thread = threadId(), seq = R.seqOf(m);
    // An unknown outcome before: the same emoji on the same row goes with the same key.
    const rk = [key, thread, seq, emoji].join("|");
    const idem = P.retry.get(rk) || H.requestKey();
    P.retry.set(rk, idem);
    const entry = { key, thread, seq, mid, emoji, id: "", state: "sending" };
    P.pending.push(entry);
    repaint();
    // The cat is woken by it like by any message: its typing bubble, as for a send.
    const reply = H.expect ? H.expect(R.catOf(m)) : null;
    let answer;
    try { answer = await post(sel, R.request(emoji, seq, thread, idem)); }
    catch (e) { answer = { ok: false, status: Number(e && e.status) || 0, error: str(e && e.message) }; }
    const here = chatKey(H.selected ? H.selected() : null) === key && threadId() === thread;
    if (answer.ok) {
      entry.state = "sent";
      entry.id = str(answer.id);
      P.retry.delete(rk);
      if (reply) reply.accept(entry.id);
      if (here && H.reload) H.reload();
      return;
    }
    P.pending = P.pending.filter((p) => p !== entry);
    if (reply && here) reply.drop();
    const f = R.failure(answer.status, answer.error, answer.code);
    if (!f.unknown) P.retry.delete(rk);
    if (here) repaint();
    if (H.note) H.note(R.failWords(emoji, f, here ? "" : (H.chatName ? H.chatName(sel) : "")));
    // The conversation moved, or it may have landed after all: read where it is now.
    if (here && H.reload && (f.unknown || answer.status === 409)) H.reload();
  }
  async function post(sel, payload) {
    const res = await H.fetch("/xbot-api/" + (sel.type === "group" ? "groups/" : "bots/") + encodeURIComponent(sel.id) + "/messages", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const json = str(res.headers && res.headers.get ? res.headers.get("content-type") : "").includes("application/json");
    if (!res.ok) {
      const data = json ? await res.json().catch(() => ({})) : {};
      return { ok: false, status: res.status, error: str(data && data.error), code: str(data && data.code) };
    }
    // The native admission: a cat's event stream, a group's JSON; both name
    // the owner's message. A body that breaks off, or one that names no
    // message, is no admission: the outcome is not known (status 0), so the
    // key is kept, the owner is told, and the chat is read again.
    let body;
    try { body = json ? await res.json() : await res.text(); }
    catch (e) { return { ok: false, status: 0, error: "" }; }
    const answer = H.receipt(body, json);
    if (!answer.userMessageId) return { ok: false, status: 0, error: answer.error || "" };
    return { ok: true, status: res.status, id: answer.userMessageId };
  }

  // ------------------------------------------------------------- init
  // Hooks from app.js:
  //   thread          the history's scroll box (#thread);
  //   selected()      the open chat ({type, id});  peer()  the two-cat exchange is open;
  //   threadId()      the conversation on screen;
  //   messageOf(row)  the message a bubble row was drawn for ({message, text}), if it has a message menu;
  //   reply(m)        quote this message in the composer (armQuote);
  //   catName(id)     a cat's name by its native ID;  chatName(sel)  a chat's name;
  //   latest()        the newest page's message IDs (a Set), null when not known;
  //   fetch, receipt  the shell's apiFetch and the send receipt reader (chat-live-rules.js);
  //   requestKey()    a fresh idempotency key;  expect(catId)  a send's typing bubble (chat-live.js);
  //   reload()        read the open chat again;  note(text)  the quiet toast;
  //   setTip(n, text) the shell's tooltip.
  function init(hooks) {
    H = hooks || {};
    const thread = H.thread;
    if (thread && typeof thread.addEventListener === "function") {
      let over = null;
      thread.addEventListener("pointerover", (ev) => {
        const row = ev.target && ev.target.closest ? ev.target.closest(".msg") : null;
        if (row && row !== over) { over = row; fit(row); }
      });
      thread.addEventListener("focusin", (ev) => {
        const row = ev.target && ev.target.closest ? ev.target.closest(".msg") : null;
        if (row) fit(row);
      });
    }
    if (typeof document.addEventListener === "function") {
      document.addEventListener("pointerdown", (ev) => {
        const p = P.picker;
        if (p && !p.menu.contains(ev.target) && !p.anchor.contains(ev.target)) closePicker(false);
      }, true);
      document.addEventListener("scroll", (ev) => { if (P.picker && !P.picker.menu.contains(ev.target)) closePicker(false); }, true);
    }
    let wait = 0;
    const relayout = () => {
      closePicker(false);
      if (!wait) wait = frame(() => { wait = 0; const inner = currentInner(); if (inner) { inset(inner); refit(inner); } }) || 0;
    };
    if (typeof window.addEventListener === "function") window.addEventListener("resize", relayout);
    // The conversation also changes width without the window: the details
    // panel opening beside it (chat-panel.js), the sidebar's grip. Only a
    // change of width counts (the dock growing changes the height).
    if (thread && typeof window.ResizeObserver === "function") {
      let width = null;
      new window.ResizeObserver(() => {
        const now = thread.clientWidth;
        if (width !== null && now !== width) relayout();
        width = now;
      }).observe(thread);
    }
  }

  window.ClowderReactions = Object.freeze({ init, select, before, rendered, strip, close: () => closePicker(false), fit });
})();
