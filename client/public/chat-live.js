// A reply drawn while it is being written, a history that redraws only what
// changed, the stop control's look and 回到最新 (classic script,
// window.ClowderLive). Loads after chat-live-rules.js and before app.js, which
// calls init() once and then:
//   select()  when the conversation changes;
//   event()   for each `live` event of the open conversation's thread stream,
//             lost() when that stream may have missed events;
//   read()    with what each transcript or group read says about replies,
//             before deciding whether to redraw;
//   frame()   for each reply-in-progress row the renderers draw;
//   commit()  to put a freshly drawn history on screen, then rendered();
//   expect()  when the owner sends, for the cat's typing bubble;
//   working(), stopping(), stopped() and sendButton() for the composer.
// chat-presence.js reads presence() (and watch()es it) for the header line
// and the sidebar row: the same replies this module draws, nothing more.
//
// A reply in progress is a row in the cat's normal reply position. Without
// words yet it is a typing bubble; while the engine thinks or takes a step,
// one quiet line says so in everyday words; its words appear as the stream
// writes them (placed by native position, chat-live-rules.js), with a soft
// caret while it is still writing. When the transcript has the finished
// reply, that row takes this one's place without rising in again.
//
// Nothing here is a record: replies, their words and the typing bubbles are
// what this page last saw, kept only for drawing. The transcript stays the
// source of every finished message; stopping is the existing native stop.
(() => {
  "use strict";
  const R = window.ClowderLiveRules;
  let H = null;
  const SVG = "http://www.w3.org/2000/svg";
  // How close to the end of the history counts as reading the latest.
  const FOLLOW = 72;
  // A send whose reply has not started this long after the server took it is
  // shown as queued, if the status says it is waiting behind other work.
  const GRACE = 2000;
  const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const raf = (fn) => (typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(fn) : setTimeout(fn, 16));
  const reduced = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const kids = (n) => (n && n.children ? [...n.children] : []);
  const lastKid = (n) => kids(n).at(-1) || null;

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svg(cls, body) {
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("class", "icon " + cls);
    s.innerHTML = body;
    return s;
  }

  // -------------------------------------------------------------------- state
  const S = {
    key: "",
    // Native message ID → a reply this page is drawing:
    // { id, r (rules state), row, own, bubble, step, shown, phrase, next, dirty, gone }.
    // own: the row is this module's (the history had no row for it yet).
    replies: new Map(),
    // Typing bubbles of sends whose reply the server has not named yet.
    waiting: [],
    // Replies the transcript already shows finished (or as an execution
    // record): their late events change nothing.
    settled: new Set(),
    // Replies the history drawing in progress has a row for.
    built: new Set(),
    stopping: 0, frame: 0, seq: 0, fresh: false, pill: null, pillText: null, scroll: false,
    // Rows the last redraw moved, and where they were (reconcile → rendered()).
    glide: null,
    // Conversation generation, and the stop's withdrawn sends and cleanup timer.
    gen: 0, stopWaits: [], stopTimer: 0,
    // The owner was reading the latest at the last look (scroll or our own move to the end).
    follow: true,
  };
  const all = () => [...S.replies.values(), ...S.waiting];
  // The open conversation's history on screen (not a loading skeleton, not
  // another view such as an exchange between two cats).
  const innerEl = () => {
    const t = H && H.thread;
    return kids(t).find((c) => c.classList.contains("thread-inner") && !!S.key && c.dataset.chat === S.key) || null;
  };

  function select(key) {
    S.gen++;
    clearTimeout(S.stopTimer);
    S.stopWaits = [];
    S.key = key ? String(key) : "";
    S.replies.clear();
    S.waiting = [];
    S.settled.clear();
    S.built.clear();
    S.stopping = 0;
    S.fresh = false;
    S.follow = true;
    S.glide = null;
    pill();
    told();
  }

  // ---------------------------------------------------------------- presence
  // What the open conversation's cats are doing now, for the header's line
  // and the sidebar row (chat-presence.js): the replies the engine started (a
  // start event or an in-progress row named them) and that have not ended.
  // A send's typing bubble no reply has claimed yet is not one of them.
  const watchers = new Set();
  let telling = false;
  function told() {
    if (telling || !watchers.size) return;
    telling = true;
    Promise.resolve().then(() => {
      telling = false;
      for (const fn of [...watchers]) { try { fn(); } catch (err) { /* a watcher never breaks the live view */ } }
    });
  }
  // unsure: the stream was lost since this reply was last confirmed (an
  // event of its own, or a read showing it in progress), so what it was
  // doing is not known now. waiting: sends no reply has claimed yet (queued:
  // the status says they wait behind other work).
  function presence() {
    const replies = [];
    for (const e of S.replies.values()) {
      if (e.r.done || e.gone || !e.r.catId) continue;
      replies.push({ id: e.id, catId: e.r.catId, phase: e.r.phase, tool: e.r.step ? e.r.step.tool : "", unsure: !!e.unsure });
    }
    return { key: S.key, stopping: !!S.stopping, replies, waiting: S.waiting.map((w) => ({ queued: !!w.wait.queued })) };
  }

  function entry(id, catId, fromStart) {
    // lifeAt: the last sign it was being written (an event, a read showing it
    // in progress); missed: the stream may have dropped some of its events;
    // unsure: lost since its last confirmation (see presence()); streamed:
    // what it shows came from its own events (not only from a read).
    const e = { id, r: R.reply(id, catId, fromStart, Date.now()), row: null, own: false, bubble: null, step: null,
      shown: null, phrase: null, next: 0, dirty: false, gone: false, wait: null, lifeAt: Date.now(), missed: false, unsure: false, streamed: false, replyTo: "" };
    S.replies.set(id, e);
    return e;
  }
  const active = () => [...S.replies.values()].some((e) => !e.r.done && !e.gone);
  // Cats shown writing in the open history right now (a reply in progress, or
  // a send's typing bubble that is not waiting in line); "" stands for a group
  // bubble whose cat is not named yet. The status line leaves out what this
  // row already shows (chat-experience.js).
  function writing() {
    const cats = new Set();
    for (const e of all()) {
      if (e.gone || e.r.done || !e.row || !e.row.isConnected || (e.wait && e.wait.queued)) continue;
      cats.add(String(e.r.catId || ""));
    }
    return cats;
  }

  // ------------------------------------------------------------- the live rows
  function dots() {
    const d = node("span", "typing-dots");
    d.setAttribute("role", "img");
    d.setAttribute("aria-label", "正在输入");
    for (let i = 0; i < 3; i++) d.append(node("i"));
    return d;
  }
  function build(e) {
    if (e.bubble) return;
    e.bubble = node("div", "prose bot-bubble lv-text lv-typing");
    e.bubble.append(dots());
    // Not a live region: chat-presence.js announces what the cats are doing
    // once per change, in one polite region for the whole chat.
    e.step = node("div", "lv-step");
    e.step.hidden = true;
  }
  // The reply's bubble and quiet line go into this row's body (before its hover time).
  function bind(e, row) {
    build(e);
    const body = kids(row).find((c) => c.classList.contains("body")) || row;
    const ht = kids(body).find((c) => c.classList.contains("ht")) || null;
    body.insertBefore(e.bubble, ht);
    body.insertBefore(e.step, ht);
    row.classList.add("live");
    e.row = row;
    e.dirty = true;
  }
  // A row's drawn markup, for telling whether a redraw changed it.
  const sig = (n) => (n._lvSig == null ? (n._lvSig = R.signature(n.outerHTML || "")) : n._lvSig);
  function ownRow(catId, time, prev) {
    const row = H.row(catId || "", time, prev);
    sig(row);
    return row;
  }

  // A send's reply is not named yet: its typing bubble, under the send.
  function waitRow(catId) {
    const inner = innerEl();
    const w = { id: "", r: R.reply("", catId, true, Date.now()), row: null, own: true, bubble: null, step: null,
      shown: null, phrase: null, next: 0, dirty: false, gone: false, wait: { accepted: 0, user: "", queued: false } };
    const row = ownRow(catId, new Date().toISOString(), lastKid(inner));
    row.dataset.wait = String(++S.seq);
    inner.append(row);
    bind(w, row);
    S.waiting.push(w);
    paint(w, true);
    return w;
  }
  function dropWait(w) {
    const at = S.waiting.indexOf(w);
    if (at < 0) return;
    S.waiting.splice(at, 1);
    if (w.row) w.row.remove();
    H.changed();
  }
  // The reply a send was waiting for has its native ID: it takes the bubble.
  function take(e, w) {
    S.waiting.splice(S.waiting.indexOf(w), 1);
    Object.assign(e, { bubble: w.bubble, step: w.step, shown: w.shown, phrase: w.phrase, row: w.row, own: true, dirty: true });
    w.row.dataset.mid = e.id;
    delete w.row.dataset.wait;
  }
  // A group's typing bubble before anyone was named shows no face; once a cat
  // starts, its own face and name take that place.
  function reframe(e) {
    const old = e.row, inner = old && old.parentElement;
    if (!inner || !e.r.catId) return;
    const list = kids(inner), prev = list[list.indexOf(old) - 1] || null;
    const row = ownRow(e.r.catId, old.dataset.time, prev);
    row.dataset.mid = e.id;
    row.classList.add("lv-still");
    inner.insertBefore(row, old);
    old.remove();
    bind(e, row);
  }
  // Where a reply the stream started is drawn: the history's row for it, a
  // send's typing bubble of the same cat (only for a reply seen from its
  // start marker: one already under way, like an opening greeting, is not
  // the answer to this send), or a row of its own at the end.
  function place(e, starting) {
    const inner = innerEl();
    if (!inner) return;
    const found = kids(inner).find((r) => r.dataset.mid === e.id && r.classList.contains("live"));
    if (found) { bind(e, found); return; }
    const w = starting ? S.waiting.find((x) => !x.r.catId || x.r.catId === e.r.catId) : null;
    if (w) {
      const nameless = !w.r.catId;
      take(e, w);
      if (nameless) reframe(e);
      return;
    }
    if (e.r.done) return;
    const row = ownRow(e.r.catId, new Date().toISOString(), lastKid(inner));
    row.dataset.mid = e.id;
    inner.append(row);
    bind(e, row);
    e.own = true;
  }

  // ----------------------------------------------------------------- painting
  function dirty(e) { e.dirty = true; schedule(); }
  function schedule() { if (!S.frame) S.frame = raf(flush) || 1; }
  function flush() {
    S.frame = 0;
    const pin = following();
    let grew = false, again = false;
    for (const e of all()) {
      if (!e.dirty || !e.row || !e.row.isConnected) continue;
      if (paint(e, false)) grew = true;
      else again = true;
    }
    if (grew) {
      if (pin) toEnd();
      else S.fresh = true;
    }
    pill();
    if (again) schedule();
  }
  // The caret sits after the last words: in the last paragraph, list item or code line.
  function tail(root) {
    let el = lastKid(root);
    while (el && /^(UL|OL|BLOCKQUOTE)$/.test(el.tagName) && lastKid(el)) el = lastKid(el);
    if (el && el.classList.contains("code-block")) el = kids(el).find((c) => c.tagName === "PRE") || null;
    if (el && /^(P|LI|PRE|H[1-6])$/.test(el.tagName)) el.classList.add("lv-tail");
  }
  // false: a long reply waits a moment before its next drawing (it stays dirty).
  function paint(e, force) {
    if (!e.row || !e.bubble) { e.dirty = false; return true; }
    // With the speaking cat's name, a signature it opens with never shows either.
    const shown = R.display(e.r.text, e.r.catId && H.catName ? H.catName(e.r.catId) : "");
    if (shown !== e.shown) {
      const now = Date.now();
      if (!force && shown && e.shown && now < e.next) return false;
      if (!shown) {
        e.bubble.replaceChildren(dots());
        e.bubble.classList.add("lv-typing");
      } else {
        const t0 = clock();
        e.bubble.replaceChildren();
        H.render(e.bubble, R.drawable(shown));
        tail(e.bubble);
        e.bubble.classList.remove("lv-typing");
        // Drawing again costs what this drawing did: keep it to a fifth of the time.
        e.next = now + Math.min(400, Math.max(0, (clock() - t0) * 4));
      }
      e.shown = shown;
    }
    const writing = !e.r.done;
    e.bubble.classList.toggle("lv-writing", writing && !!shown);
    e.row.classList.toggle("lv-done", !writing);
    e.row.setAttribute("aria-busy", String(writing));
    // Lost and not confirmed since: no claim about what it is doing (the
    // quiet line empties, the typing paws rest).
    e.row.classList.toggle("lv-unsure", writing && !!e.unsure);
    step(e, S.stopping && writing ? "正在停止…" : e.wait ? (e.wait.queued ? "排队中" : "") : e.unsure ? "" : R.phrase(e.r));
    // The typing paws are named for what they show: a send waiting for its
    // cat to start, a reply being written, or one not confirmed since a loss.
    const paws = kids(e.bubble).find((c) => c.classList.contains("typing-dots"));
    if (paws) paws.setAttribute("aria-label", e.wait ? "等猫猫开始回复" : e.unsure ? "正在回复" : "正在输入");
    e.dirty = false;
    told();
    return true;
  }
  // The quiet line: a change crossfades (old words out, new words in, in the same place).
  function step(e, words) {
    if (e.phrase === words) return;
    e.phrase = words;
    const box = e.step;
    if (reduced() || !box.isConnected) {
      box.replaceChildren();
      if (words) box.append(node("span", "", words));
      box.hidden = !words;
      return;
    }
    for (const old of kids(box)) {
      if (old.classList.contains("lv-out")) continue;
      old.classList.add("lv-out");
      setTimeout(() => old.remove(), 200);
    }
    if (words) { box.append(node("span", "lv-in", words)); box.hidden = false; }
    else setTimeout(() => { if (!e.phrase) box.hidden = true; }, 200);
  }

  // ----------------------------------------------------------------- the stream
  // One `live` event of the open conversation's thread.
  function event(ev) {
    if (!H || !S.key || !ev || typeof ev.messageId !== "string" || !ev.messageId) return;
    const id = ev.messageId;
    // The transcript already shows it finished (or as an execution record).
    if (S.settled.has(id)) return;
    let e = S.replies.get(id);
    if (!e) {
      // The end of a reply this page never saw: the next read shows it.
      if (ev.kind === "done") return;
      e = entry(id, typeof ev.catId === "string" ? ev.catId : "", ev.kind === "start");
    }
    if (e.gone) return;
    e.lifeAt = Date.now();
    // An event of its own confirms it again after a loss (and what it says
    // now came from the stream, which a later loss puts in doubt).
    const confirmed = e.unsure;
    e.unsure = false;
    e.streamed = true;
    if (confirmed) e.dirty = true;
    const waiting = e.r.held.length;
    const changed = R.apply(e.r, ev, Date.now());
    // A piece is waiting for words this page missed: the transcript's draft
    // has them, so a read is asked for a little sooner than the next poll.
    if (e.r.held.length > waiting && H.gap) H.gap();
    if ((!e.row || !e.row.isConnected) && !e.r.done) {
      // A new row at the end keeps an owner reading the latest at the end.
      const pin = following();
      place(e, ev.kind === "start");
      if (pin) toEnd();
    }
    if (changed || e.dirty) dirty(e);
    if (ev.kind === "start" || ev.kind === "done") H.changed();
    if (changed || confirmed || ev.kind === "start" || ev.kind === "done") told();
  }
  // The stream may have missed events (a reconnect, a gap): words can follow
  // on only by native position now, and the next read fills what was missed.
  // Until an event or a read confirms a reply again, nothing is said about
  // what it is doing (unsure, presence()). Only what the stream said is put
  // in doubt: a reply a read confirmed since (no event of its own after it)
  // stays as that read showed it, so a stream that keeps failing does not
  // make the header come and go with each retry.
  function lost() {
    for (const e of S.replies.values()) {
      R.lost(e.r);
      e.missed = true;
      if (!e.r.done && !e.gone && !e.unsure && e.streamed) { e.unsure = true; dirty(e); }
    }
    told();
  }

  // ------------------------------------------------------------------- reads
  // What a transcript or group read says about replies: [{id, catId,
  // inProgress, draft, replyTo}] (draft: the native content so far; replyTo:
  // the owner's message it answers). requestedAt: when that read was asked for.
  // The send a reply answers, by the message it replies to; a send whose
  // receipt named no message can only be matched by its cat.
  function answered(row) {
    const open = S.waiting.filter((v) => v.wait.accepted && (!v.r.catId || v.r.catId === String(row.catId || "")));
    if (!row.replyTo) return open[0] || null;
    return open.find((v) => v.wait.user === row.replyTo) || open.find((v) => !v.wait.user) || null;
  }
  const answering = (row) => (row.replyTo ? S.waiting.find((v) => v.wait.accepted && v.wait.user === row.replyTo) || null : null);
  function read(rows, requestedAt = 0) {
    const seen = new Set(), now = Date.now();
    for (const row of rows || []) {
      if (!row || !row.id) continue;
      const id = String(row.id);
      seen.add(id);
      const e = S.replies.get(id);
      if (!row.inProgress) {
        S.settled.add(id);
        if (e) e.gone = true;
        else {
          // Finished before this page saw any of it: the typing bubble of the
          // send it answers gives its place to it (the redraw swaps them in place).
          const w = answering(row);
          if (w) { const x = entry(id, String(row.catId || ""), false); take(x, w); x.gone = true; }
        }
        continue;
      }
      if (S.settled.has(id)) continue;
      let x = e;
      if (!x) {
        x = entry(id, String(row.catId || ""), false);
        // The reply a send was waiting for, named by the transcript first.
        const w = answered(row);
        if (w) take(x, w);
      } else {
        // Already on screen as its own row: the send it answers needs no bubble.
        const w = answering(row);
        if (w && w.row !== x.row) dropWait(w);
      }
      // A read shows it still being produced: confirmed again, though what it
      // was doing when the stream was lost (a step, thinking) is not.
      if (x.unsure) { x.unsure = false; x.streamed = false; R.recover(x.r); x.dirty = true; }
      x.replyTo = String(row.replyTo || "");
      x.lifeAt = now;
      if (R.draft(x.r, row.draft)) x.dirty = true;
    }
    // Finished, and this read was asked for after it finished, without it:
    // the record has nothing to show for it (an empty or SILENT reply).
    for (const e of S.replies.values()) if (!seen.has(e.id) && e.r.done && requestedAt > e.r.doneAt) e.gone = true;
    // Without that link (a record that does not name the message it answers):
    // a typing bubble next to a reply of the same cat this page first saw only
    // after the send was taken, mid-way (its start was missed), goes.
    for (const w of [...S.waiting]) {
      if (!w.wait.accepted) continue;
      const shown = [...S.replies.values()].some((e) => !e.gone && !e.r.done && !e.r.fromStart && !e.replyTo && e.row && e.row !== w.row
        && (!w.r.catId || e.r.catId === w.r.catId) && e.r.seenAt >= w.wait.accepted);
      if (shown) dropWait(w);
    }
    H.changed();
    told();
  }

  // A reply whose end this page may have missed (the stream dropped or it
  // was first met mid-way) is over once an activity read asked for after its
  // last sign of life shows nothing running or queued for its cat in this
  // conversation's thread. A read that failed, could not see the queue, or
  // counts work it does not list changes nothing: absence from a transcript
  // page alone is never taken as an end.
  function busyFor(a, catId) {
    for (const kind of ["running", "queued"]) {
      const items = (a.items || []).filter((i) => i.kind === kind);
      if ((a.counts && a.counts[kind]) > items.length) return true;
      if (items.some((i) => !i.catId || i.catId === catId)) return true;
    }
    return false;
  }
  function settleMissed() {
    const X = window.ClowderExperience;
    const seen = X && typeof X.activityRead === "function" ? X.activityRead() : null;
    const a = seen && seen.key === S.key ? seen.activity : null;
    if (!a || !(a.readStatus === "ready" || a.readStatus === "partial" && !(a.errors || []).some((x) => /queue|thread/.test(String(x.source))))) return;
    let ended = false;
    for (const e of S.replies.values()) {
      if (e.r.done || e.gone || (e.r.fromStart && !e.missed) || !(seen.askedAt > e.lifeAt) || busyFor(a, e.r.catId)) continue;
      R.apply(e.r, { kind: "done" }, seen.askedAt);
      dirty(e);
      ended = true;
    }
    if (ended) { H.changed(); told(); }
  }

  // The renderers draw an in-progress reply's row through here.
  function frame(row) {
    if (row && row.dataset.mid) { S.built.add(row.dataset.mid); row.classList.add("live"); }
    return row;
  }

  // ------------------------------------------------------------ the history
  // A history row's identity across drawings: its native message (and which
  // of its bubbles), else its seq or ID, else what it shows.
  function keyOf(n) {
    const d = n.dataset || {};
    if (d.mid) return "m:" + d.mid;
    if (d.seq) return "s:" + d.seq;
    if (d.id) return "i:" + d.id;
    if (d.wait) return "w:" + d.wait;
    return "x:" + sig(n);
  }
  function keyed(list) {
    const count = new Map();
    return list.map((n) => {
      const k = keyOf(n), c = count.get(k) || 0;
      count.set(k, c + 1);
      return [k + "#" + c, n];
    });
  }
  // Brings the history on screen (live) to a freshly drawn one (next): rows
  // that did not change keep their element (so they do not rise in again,
  // and a selection, an open drawer or a playing picture stays), a changed
  // row is replaced in place without rising, only rows that were not there
  // rise in, and the rows this page holds itself (keep) follow at the end in
  // their order on screen. Elements already in place are not moved; rows
  // change places only when the drawing's order changed (a reply drawn under
  // a follow-up it took in, chat-live-rules.js order()), and then only the
  // rows out of their old order move, without rising again, and glide to
  // their new places (glide()). Returns how many message rows are new.
  function reconcile(live, next, keep = []) {
    const held = new Set(keep);
    const before = new Map(keyed(kids(live).filter((n) => !held.has(n))));
    const out = [];
    // A replaced row's element on screen, for where it was.
    const was = new Map();
    const pairs = keyed(kids(next));
    for (const [, n] of pairs) sig(n);
    // New message rows above the first one that was already there are
    // earlier history brought in on top (chat-history.js): not news, so they
    // neither rise nor count as added (回到最新 is for what arrived below).
    const top = pairs.findIndex(([k]) => { const old = before.get(k); return !!old && old.classList.contains("msg"); });
    let added = 0;
    pairs.forEach(([k, n], i) => {
      const old = before.get(k);
      if (old && sig(old) === n._lvSig) { out.push(old); before.delete(k); return; }
      if (old) { before.delete(k); n.classList.add("lv-still"); was.set(n, old); }
      else if (n.classList.contains("msg")) { if (top >= 0 && i < top) n.classList.add("lv-still"); else added++; }
      out.push(n);
    });
    out.push(...keep);
    S.glide = swapped(live, out, was);
    const wanted = new Set(out);
    for (const n of kids(live)) if (!wanted.has(n)) n.remove();
    const now = kids(live);
    let i = 0;
    for (const n of out) {
      if (now[i] === n) { i++; continue; }
      live.insertBefore(n, now[i] || null);
      const j = now.indexOf(n, i);
      if (j >= 0) {
        now.splice(j, 1);
        // Moved, not new: it does not rise (or land) again.
        if (n.classList.contains("msg")) n.classList.add("lv-still");
      }
    }
    live.className = next.className;
    for (const k of ["chat", "chatThread"]) {
      if (next.dataset[k] != null) live.dataset[k] = next.dataset[k];
      else delete live.dataset[k];
    }
    return added;
  }
  // The rows a drawing puts out of their old order on screen, from the first
  // that now comes after a row that was below it to the last that now comes
  // before one that was above it, each with where it was (a changed row:
  // where its old element was), measured before anything moves. null when
  // the order stayed, as it nearly always does, or motion is reduced.
  function swapped(live, out, was) {
    if (reduced()) return null;
    const on = new Map(kids(live).map((n, i) => [n, i]));
    const at = out.map((n) => { const o = was.get(n) || n; return on.has(o) ? on.get(o) : -1; });
    let max = -1, last = -1, least = Infinity;
    at.forEach((p, k) => {
      if (p < 0) return;
      if (p < max) { last = k; least = Math.min(least, p); }
      else max = p;
    });
    if (last < 0) return null;
    const first = at.findIndex((p) => p > least);
    const list = [];
    for (let k = first; k <= last; k++) {
      const o = was.get(out[k]) || out[k];
      if (at[k] >= 0 && typeof o.getBoundingClientRect === "function") list.push({ n: out[k], top: o.getBoundingClientRect().top });
    }
    return list.length ? list : null;
  }
  // Once the renderer has placed the view: those rows glide from where they
  // were to where they are (180 ms ease-out), so a follow-up reads as
  // slipping in above the reply that keeps writing. A row that would cross
  // more than the view just takes its place.
  function glide() {
    const list = S.glide;
    S.glide = null;
    if (!list || reduced() || !H || !H.thread) return;
    const view = H.thread.clientHeight || 0;
    for (const { n, top } of list) {
      if (!n.isConnected || typeof n.animate !== "function" || typeof n.getBoundingClientRect !== "function") continue;
      const dy = top - n.getBoundingClientRect().top;
      if (Math.abs(dy) < 1 || (view && Math.abs(dy) > view)) continue;
      n.animate([{ transform: "translateY(" + Math.round(dy) + "px)" }, { transform: "none" }], { duration: 180, easing: "ease-out" });
    }
  }
  // The rows this page holds and the history does not draw: sends, reply
  // errors (from app.js) and its own reply rows, in their order on screen.
  function held(extra) {
    const inner = innerEl(), on = kids(inner);
    const list = [...(extra || [])];
    for (const w of S.waiting) list.push(w.row);
    for (const e of S.replies.values()) if (e.own && !e.gone && e.row && !S.built.has(e.id)) list.push(e.row);
    const uniq = [...new Set(list.filter(Boolean))];
    const at = (n, i) => { const p = on.indexOf(n); return p < 0 ? 1e9 + i : p; };
    return uniq.map((n, i) => [at(n, i), n]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }
  // next: the history as just drawn (its dataset.chat names the conversation);
  // keep: the sends and reply errors app.js holds. The first drawing of a
  // conversation replaces whatever was there.
  function commit(next, keep) {
    const live = innerEl(), rows = held(keep), pin = following();
    let added = 0, first = false;
    if (!live || !next.dataset.chat || live.dataset.chat !== next.dataset.chat) {
      S.glide = null;
      for (const n of kids(next)) sig(n);
      next.append(...rows);
      H.thread.replaceChildren(next);
      first = true;
    } else added = reconcile(live, next, rows);
    attach(pin);
    return { added, first };
  }
  // After a read: every reply row on screen gets its words (at once, so a row
  // drawn anew never shows empty), and rows of replies that ended without a
  // place in the history go. pin: the owner was reading the latest before
  // (the view stays at the end).
  function attach(pin = following()) {
    const inner = innerEl();
    const rows = new Map();
    for (const r of kids(inner)) if (r.dataset.mid && r.classList.contains("live")) rows.set(r.dataset.mid, r);
    for (const e of [...S.replies.values()]) {
      if (e.gone) {
        // Its own row, if a redraw did not already replace or drop it.
        if (e.own && e.row && e.row.isConnected) e.row.remove();
        S.replies.delete(e.id);
        continue;
      }
      const row = rows.get(e.id);
      if (row && row !== e.row) bind(e, row);
      if (S.built.has(e.id)) e.own = false;
      if (e.row && !e.row.isConnected) e.row = null;
    }
    S.built.clear();
    let grew = false;
    for (const e of all()) if (e.dirty && e.row) grew = paint(e, true) || grew;
    if (grew && pin) toEnd();
    H.changed();
    told();
  }
  // After the renderer placed the scroll: rows that changed places glide
  // there, and new rows below the view are news.
  function rendered(result) {
    glide();
    if (result && result.added && !result.first && !following()) S.fresh = true;
    pill();
  }

  // ------------------------------------------------------------------ sending
  // The owner sent a message: the cat's typing bubble at once, before the
  // server has a row for the reply. catId: the open single chat's cat ("" in a
  // group, where the cat is not known until one starts). A reply already being
  // written here takes the message in or queues it, so no second bubble.
  function expect(catId) {
    const none = { accept() {}, drop() {} };
    if (!H || !S.key || !innerEl() || active()) return none;
    const w = waitRow(catId || "");
    toEnd();
    H.changed();
    return {
      // The server took it; user: the native ID of the owner's message.
      accept(user) { w.wait.accepted = Date.now(); w.wait.user = user || ""; },
      drop() { dropWait(w); },
    };
  }
  // Every second: a send whose reply has not started is shown as queued only
  // when the status says it waits behind other work; one with nothing
  // running or queued for a while goes.
  function tick() {
    if (!H) return;
    const now = Date.now();
    for (const w of [...S.waiting]) {
      if (!w.wait.accepted) continue;
      const age = now - w.wait.accepted;
      const queued = age > GRACE && !!H.queued(w.wait.user);
      if (queued !== w.wait.queued) { w.wait.queued = queued; dirty(w); }
      if (age > 60000 || (age > 8000 && !queued && !H.busy())) dropWait(w);
    }
    settleMissed();
    if (S.pill && S.pill.classList.contains("on")) pill();
  }

  // ------------------------------------------------------------------ stopping
  const working = () => active() || S.waiting.length > 0;
  // The sends the server had taken when the stop was asked for: the only
  // ones the stop can have withdrawn.
  function stopping(on) {
    S.stopping = on ? Date.now() : 0;
    if (on) S.stopWaits = S.waiting.filter((w) => w.wait.accepted);
    for (const e of all()) dirty(e);
    told();
  }
  // The native stop answered: those queued sends were withdrawn, so a typing
  // bubble of theirs no reply has claimed a moment later will not get one.
  // A send made after the stop was asked for, or another conversation, is
  // never touched.
  function stopped() {
    const targets = S.stopWaits.slice(), gen = S.gen;
    clearTimeout(S.stopTimer);
    S.stopTimer = setTimeout(() => {
      if (gen !== S.gen) return;
      for (const w of targets) if (S.waiting.includes(w)) dropWait(w);
    }, 1500);
  }
  // The send button: the arrow, or (while this chat's cat works and nothing is
  // typed) a stop square, morphing in place. mode: "send" | "stop" | "stopping".
  function sendButton(btn, mode) {
    if (!btn) return;
    if (!btn.classList.contains("lv-morph")) {
      btn.classList.add("lv-morph");
      for (const s of kids(btn)) s.classList.add("lv-go");
      btn.append(svg("lv-halt", '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>'));
    }
    const stop = mode === "stop" || mode === "stopping";
    btn.classList.toggle("lv-stop", stop);
    btn.type = stop ? "button" : "submit";
    const label = mode === "stopping" ? "正在停止" : stop ? "停止" : "发送";
    btn.setAttribute("aria-label", label);
    btn.dataset.tip = label;
  }

  // ----------------------------------------------------------- 回到最新
  function following() {
    const t = H && H.thread;
    return !t || t.scrollHeight - t.scrollTop - t.clientHeight < FOLLOW;
  }
  function toEnd() { if (H && H.thread) { H.thread.scrollTop = H.thread.scrollHeight; S.follow = true; } }
  const streaming = () => [...S.replies.values()].some((e) => !e.r.done && !e.gone && e.row && e.row.isConnected);
  function mountPill() {
    const thread = H.thread, chat = thread && thread.parentElement;
    const dock = kids(chat).find((c) => c.classList.contains("dock"));
    if (!dock || S.pill) return;
    const anchor = node("div", "lv-anchor");
    const b = node("button", "lv-latest");
    b.type = "button";
    b.setAttribute("aria-label", "回到最新");
    b.tabIndex = -1;
    b.setAttribute("aria-hidden", "true");
    b.append(svg("lv-down", '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'));
    const text = node("span", "lv-latest-text");
    b.append(text);
    b.addEventListener("click", () => {
      S.fresh = false;
      const t = H.thread;
      if (typeof t.scrollTo === "function") t.scrollTo({ top: t.scrollHeight, behavior: reduced() || streaming() ? "auto" : "smooth" });
      else toEnd();
      pill();
      if (H.focusComposer) H.focusComposer();
    });
    anchor.append(b);
    dock.prepend(anchor);
    S.pill = b;
    S.pillText = text;
    thread.addEventListener("scroll", () => {
      if (S.scroll) return;
      S.scroll = true;
      raf(() => { S.scroll = false; S.follow = following(); pill(); });
    }, { passive: true });
    // The history's box gets shorter when the dock grows (a status line, a
    // quote, a taller draft): an owner reading the latest stays at the end.
    S.follow = true;
    if (typeof window.ResizeObserver === "function") new window.ResizeObserver(() => { if (S.follow) toEnd(); }).observe(thread);
  }
  // Shown while the owner reads further up and something new arrived or a
  // reply is being written below; the count is the server's own unread
  // replies, when it has any.
  function pill() {
    if (!S.pill) return;
    const follow = following();
    if (follow) S.fresh = false;
    const on = !!S.key && !follow && (S.fresh || streaming());
    const count = on && H.unread ? String(H.unread() || "") : "";
    S.pillText.textContent = count ? count + " 条新回复" : "";
    S.pill.classList.toggle("on", on);
    S.pill.classList.toggle("lv-count", !!count);
    S.pill.setAttribute("aria-hidden", String(!on));
    S.pill.setAttribute("aria-label", count ? "回到最新，" + count + " 条新回复" : "回到最新");
    S.pill.tabIndex = on ? 0 : -1;
  }

  // -------------------------------------------------------------------- init
  // Hooks from app.js:
  //   thread              the history's scroll box (#thread);
  //   render(el, text)    draws reply words as the history does (Markdown);
  //   row(catId, time, prev) a reply row frame like the history's (face and
  //                       name line, grouped against prev; no face when catId is "");
  //   queued(userId)      the status says this send waits behind other work;
  //   busy()              the status says something runs or waits in this chat;
  //   unread()            the server's unread replies here ("3", "3+" or "");
  //   changed()           working/idle may have changed (the composer follows);
  //   gap()               words were missed: read the transcript (its draft) soon;
  //   focusComposer()     after 回到最新;
  //   catName(catId)      the speaking cat's name ("" when unknown), so a
  //                       signature it opens its reply with is not drawn.
  function init(hooks) {
    H = hooks;
    mountPill();
    if (!S.timer) S.timer = setInterval(tick, 1000);
  }

  window.ClowderLive = Object.freeze({
    init, select, event, lost, read, frame, commit, reconcile, rendered, attach,
    expect, working, stopping, stopped, isStopping: () => !!S.stopping, sendButton, following, tick,
    // The replies being written now (chat-presence.js), and a callback for
    // when that may have changed (called after the change, coalesced).
    presence, watch: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
    // Cats drawn writing in the open history, typing bubbles included (chat-experience.js's status line).
    writing,
    // A history row its owner changed in place (chat-history.js's top row):
    // the next redraw reads its markup again instead of the one remembered.
    touched: (n) => { if (n) delete n._lvSig; },
    // For tests and diagnostics only: what this page is drawing, never a record.
    peek: (id) => { const e = S.replies.get(id); return e ? { text: e.r.text, shown: e.shown, done: e.r.done, own: e.own, row: e.row } : null; },
  });
})();
