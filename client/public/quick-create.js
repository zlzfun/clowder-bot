// 开箱即用。The rules live in quick-create-rules.js; app.js passes its helpers
// through init(). Three views:
//   stage()     no cats yet: 「领一只猫猫回家」 — the cats to choose from as
//               named tiles (those that can come home as they are, 自定义 for
//               a cat of the owner's own, then, under a few plain words, those
//               that cannot), and the chosen one's card: its portrait on a
//               cushion, the name it comes with, its breed, its temperament in
//               its own words, what it is good at and the Agent it thinks with
//               (or why it cannot come home as it is, and the way on); keep or
//               change its name, 带它回家 (docs/xbot-frontend.md item 44);
//   noChat()    cats, but no chat open: one line (and 打开列表 on a phone);
//   the 新建 dialog (openCat() on its 猫猫 side, openGroup() on its 群聊
//               side; item 43): one window titled 新建 with a 猫猫 | 群聊
//               switch. 猫猫: the same tiles and card beside them, and the
//               name; 更多设置 hands over to the template creator
//               (cat-templates.js), unchanged. 群聊: cats as face chips, an
//               optional name whose placeholder is the name the group gets
//               without one.
// Requests: GET /xbot-api/start (重新检测 adds ?refresh=1; its faces[] says
// which faces there are, what each one's cat is like and which tool it thinks
// with here), POST /xbot-api/bots {name, simple:{face, rev} | {face, custom:
// true, about?, personality?, agent}, idempotencyKey} and POST
// /xbot-api/groups {members, name?, idempotencyKey}. A cat or a group exists
// only once the server answers; a request that may or may not have landed is
// sent again unchanged under the same key, which returns that cat or group
// rather than a second. release() lets app.js retire an untouched stage when
// the first cat arrives from elsewhere.
// What blocks creation is said in everyday words; nothing is a demo.
(() => {
  "use strict";
  const R = window.ClowderQuickCreateRules;
  if (!R) throw new Error("quick-create-rules.js must load before quick-create.js");

  let H = null;
  function hooks() {
    if (!H) throw new Error("ClowderQuickCreate.init() must run first");
    return H;
  }
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, click) => { const b = node("button", cls, text); b.type = "button"; if (click) b.addEventListener("click", click); return b; };
  let seq = 0;
  const uid = (prefix) => "qc-" + prefix + "-" + ++seq;
  const presets = () => (window.ClowderAvatars && window.ClowderAvatars.presets) || [];
  const portrait = (faceId) => (window.ClowderAvatars ? window.ClowderAvatars.createPortrait("cat:" + faceId) : node("span"));
  const media = (query) => !!(window.matchMedia && window.matchMedia(query).matches);
  const frame = () => new Promise((done) => (window.requestAnimationFrame ? window.requestAnimationFrame(() => done()) : setTimeout(done, 16)));
  // The stage and the dialog sit centred: a form that grows or shrinks (自定义
  // chosen or left, another cat's card) re-centres them. Glide from where they
  // were (180 ms) instead of jumping; at once when motion is reduced or nothing
  // is laid out.
  function glide(el, change) {
    const can = el && typeof el.animate === "function" && !media("(prefers-reduced-motion: reduce)");
    const before = can ? el.getBoundingClientRect().top : 0;
    change();
    if (!can) return;
    const dy = before - el.getBoundingClientRect().top;
    if (Math.abs(dy) >= 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 180, easing: "ease-out" });
  }
  const quietly = (run) => { try { Promise.resolve(run()).catch(() => {}); } catch { /* optional */ } };
  // One key per request body: the same body again is the same request.
  // randomUUID needs a secure context, which a LAN address may not be.
  function requestKey() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === "function") { try { return c.randomUUID(); } catch { /* insecure context */ } }
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  // ---- our own small drawings (inline SVG; no third-party art, no emoji) ----
  const SVG = "http://www.w3.org/2000/svg";
  function draw(viewBox, cls, parts) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", cls);
    for (const [tag, attrs] of parts) {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
    }
    return svg;
  }
  // 自定义's picture: a cat's outline still to be filled in (dashed, no face:
  // it is nobody yet), with a small plus. Not a clay cat pretending.
  const ownPicture = () => draw("0 0 48 48", "qc-own-pic", [
    ["path", { class: "qc-own-head", d: "M9 25C9 19 10 14 11.5 9.5L18.5 15C21.5 14 26.5 14 29.5 15L36.5 9.5C38 14 39 19 39 25C39 33.5 32.5 39.5 24 39.5S9 33.5 9 25Z" }],
    ["circle", { class: "qc-own-dot", cx: "36.5", cy: "36.5", r: "7" }],
    ["path", { class: "qc-own-plus", d: "M36.5 33v7M33 36.5h7" }],
  ]);
  // The mark beside the Agent a cat thinks with: a small four-pointed spark.
  const spark = () => draw("0 0 12 12", "qc-spark", [["path", { d: "M6 .6C6.4 3.6 8.4 5.6 11.4 6C8.4 6.4 6.4 8.4 6 11.4C5.6 8.4 3.6 6.4 .6 6C3.6 5.6 5.6 3.6 6 .6Z" }]]);

  // A radio group's own keys: arrows, Home and End move the choice through
  // the options in the order shown (wrapping round).
  function walk(ev, list, at) {
    const last = list.length - 1;
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: last }[ev.key];
    if (to === undefined || at < 0 || !list.length) return null;
    ev.preventDefault();
    return list[(to + list.length) % list.length];
  }

  // ---- the cats to choose from ----
  // One radio group (one Tab stop; a click or tap picks, arrow keys, Home and
  // End move the choice in the order shown): the faces /start offers, each a
  // named tile (its portrait, the name its cat comes with; breed and name are
  // the radio's name), and 自定义, a tile of the same kind for a cat of the
  // owner's own. While the form can be used (own(true)), the faces whose own
  // cat can come home as it is come first, then 自定义, then, under a few
  // plain words, those that cannot (mark()): each says in one short word why
  // (接不上, 没安装, 没登录, 没读到), and the server's reason is its
  // description, so it reads at a glance, before any hover or choice. While
  // nothing can be chosen (still reading, or blocked) every face sits in one
  // quiet row without 自定义, and the row is only a picture. Which faces, and
  // how many, is the server's (faces[] in /start): offer() redraws the tiles
  // when that changes; they wrap as the space allows.
  const OWN = Symbol("own");
  function lineup({ compact, onPick }) {
    const box = node("div", "qc-faces" + (compact ? " compact" : ""));
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", "选一只猫猫");
    // The two groups, each under its few words (shown only when there are two;
    // a radio's own description says it for a screen reader, so they are not read).
    const groups = R.GROUPS.map((words, i) => {
      const g = node("div", "qc-group" + (i ? " later" : "")), head = node("p", "qc-group-head", words);
      head.setAttribute("aria-hidden", "true");
      g.append(head);
      return { g, head };
    });
    box.append(groups[0].g, groups[1].g);
    let current = null, on = false, items = [], offered = "", away = null, ownOn = false, order = [], arranged = "";
    function keys(b, key) {
      b.addEventListener("click", () => { if (on) choose(key); });
      b.addEventListener("keydown", (ev) => {
        if (!on) return;
        const next = walk(ev, order, order.findIndex((it) => it.key === key));
        if (next) choose(next.key);
      });
    }
    function item(p) {
      const b = node("button", "qc-face");
      b.type = "button";
      b.setAttribute("role", "radio");
      const nick = p.nickname && p.nickname !== p.label ? p.nickname : "";
      b.setAttribute("aria-label", nick ? nick + "，" + p.label : p.label);
      b.dataset.face = p.id;
      const pic = node("span", "qc-portrait");
      pic.setAttribute("aria-hidden", "true");
      pic.append(portrait(p.id));
      const name = node("span", "qc-face-name", nick || p.label), tag = node("span", "qc-face-tag"), why = node("span", "qc-sr");
      name.setAttribute("aria-hidden", "true");
      tag.setAttribute("aria-hidden", "true");
      tag.hidden = true;
      why.id = uid("why");
      b.append(pic, name, tag, why);
      keys(b, p.id);
      return { key: p.id, id: p.id, b, pic, tag, why };
    }
    const own = (() => {
      const b = node("button", "qc-face own");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", "自定义");
      b.dataset.own = "true";
      const pic = node("span", "qc-portrait");
      pic.setAttribute("aria-hidden", "true");
      pic.append(ownPicture());
      const name = node("span", "qc-face-name", "自定义");
      name.setAttribute("aria-hidden", "true");
      b.append(pic, name);
      b.hidden = true;
      keys(b, OWN);
      return { key: OWN, id: null, b, pic };
    })();
    // The order shown is the order walked: those that can come home, 自定义, those that cannot.
    function arrange() {
      const later = ownOn && away ? items.filter((it) => away.has(it.id)) : [];
      const first = items.filter((it) => !later.includes(it));
      order = [...first, ...(ownOn ? [own] : []), ...later];
      own.b.hidden = !ownOn;
      box.classList.toggle("split", later.length > 0);
      const sig = order.map((it) => (it === own ? "*" : it.id)).join("\n") + "|" + later.length;
      if (sig === arranged) return;
      arranged = sig;
      // Moving a focused tile drops its focus: put it back.
      const here = box.contains(document.activeElement) ? document.activeElement : null;
      groups[0].g.replaceChildren(groups[0].head, ...first.map((it) => it.b), own.b);
      groups[1].g.replaceChildren(groups[1].head, ...later.map((it) => it.b));
      groups[1].g.hidden = !later.length;
      if (here && here.isConnected && document.activeElement !== here) here.focus();
    }
    // away: face id → {why, tag} for the faces whose cat cannot come home as it is; null for none.
    function mark(next) {
      away = next;
      for (const it of items) {
        const one = away ? away.get(it.id) : null;
        it.b.classList.toggle("away", !!one);
        it.tag.textContent = one ? one.tag : "";
        it.tag.hidden = !one;
        it.why.textContent = one ? R.GROUPS[1] + "：" + one.why : "";
        if (one) it.b.setAttribute("aria-describedby", it.why.id);
        else it.b.removeAttribute("aria-describedby");
      }
      arrange();
      paint();
    }
    // [{id, label, nickname}] in the order to show; the same list again changes nothing.
    function offer(list) {
      const next = list.map((p) => p.id + "\n" + p.label + "\n" + (p.nickname || "")).join("\n\n");
      if (next === offered) return;
      offered = next;
      const refocus = box.contains(document.activeElement);
      items = list.map(item);
      arranged = "";
      if (current !== OWN && !items.some((it) => it.key === current)) current = null;
      mark(away);
      if (refocus) { const lead = order.find((it) => it.b.tabIndex === 0); if (lead) lead.b.focus(); }
    }
    function paint() {
      const lead = order.find((it) => it.key === current) || order[0];
      for (const it of [...items, own]) {
        it.b.setAttribute("aria-checked", String(it.key === current));
        it.b.disabled = !on;
        it.b.tabIndex = on && it === lead ? 0 : -1;
      }
      box.classList.toggle("rest", !current);
      if (current || on) box.removeAttribute("aria-hidden");
      else box.setAttribute("aria-hidden", "true");
    }
    function choose(key) {
      const it = order.find((x) => x.key === key);
      if (!it) return;
      current = key;
      paint();
      it.b.focus();
      onPick(key);
    }
    // Every portrait until /start says which faces there are.
    offer(presets());
    return {
      element: box, offer, mark,
      get: () => current,
      set: (key) => { current = key === OWN || items.some((it) => it.key === key) ? key : null; paint(); },
      enable: (value) => { on = !!value; paint(); },
      // 自定义 is offered (and the faces sorted) only while the form can be used.
      own: (value) => { if (ownOn === !!value) return; ownOn = !!value; arrange(); paint(); },
      focus: (key) => { const it = order.find((x) => x.key === key); if (it) it.b.focus(); },
    };
  }

  // 自定义's looks: every face offered is eligible (none is "unavailable" as a
  // look), one always chosen; a compact radio group of small portraits, named
  // by breed. Picking one says nothing beyond the radio's own name.
  function looksPicker(onPick) {
    const box = node("div", "qc-looks");
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", "选它的长相");
    let items = [], current = null, on = true, offered = "";
    function offer(list) {
      const next = list.map((p) => p.id + "\n" + p.label).join("\n\n");
      if (next === offered) return;
      offered = next;
      const refocus = box.contains(document.activeElement);
      items = list.map((p) => {
        const b = node("button", "qc-look");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-label", p.label);
        b.dataset.face = p.id;
        const pic = node("span", "qc-look-pic");
        pic.setAttribute("aria-hidden", "true");
        pic.append(portrait(p.id));
        b.append(pic);
        b.addEventListener("click", () => { if (on) choose(p.id); });
        b.addEventListener("keydown", (ev) => {
          if (!on) return;
          const next = walk(ev, items, items.findIndex((x) => x.id === p.id));
          if (next) choose(next.id);
        });
        return { id: p.id, b };
      });
      box.replaceChildren(...items.map((it) => it.b));
      if (!items.some((it) => it.id === current)) current = null;
      paint();
      if (refocus) focus();
    }
    function paint() {
      const lead = items.find((it) => it.id === current) || items[0];
      for (const it of items) {
        it.b.setAttribute("aria-checked", String(it.id === current));
        it.b.disabled = !on;
        it.b.tabIndex = on && it === lead ? 0 : -1;
      }
    }
    function choose(id) {
      const it = items.find((x) => x.id === id);
      if (!it) return;
      current = id;
      paint();
      it.b.focus();
      onPick(id);
    }
    function focus() { const it = items.find((x) => x.b.tabIndex === 0); if (it) it.b.focus(); }
    return {
      element: box, offer,
      get: () => current,
      set: (id) => { current = items.some((it) => it.id === id) ? id : null; paint(); },
      enable: (value) => { on = !!value; paint(); },
      focus,
    };
  }

  // A native login command, copyable (the terminal is where it runs).
  function commandChip(command, label) {
    const chip = node("span", "qc-cmd");
    if (label) chip.append(node("span", "qc-cmd-for", label));
    chip.append(node("code", "", command));
    const copy = button("qc-copy", "复制");
    copy.setAttribute("aria-label", "复制 " + command);
    let timer = 0;
    copy.addEventListener("click", async () => {
      let ok = false;
      try { ok = !!(await hooks().copy(command)); } catch { ok = false; }
      copy.textContent = ok ? "已复制" : "没复制上";
      clearTimeout(timer);
      timer = setTimeout(() => { copy.textContent = "复制"; }, 1600);
    });
    chip.append(copy);
    return chip;
  }

  // 自定义's tool row: 「它会用这台电脑上的 X 来思考」, plain text with one
  // usable tool, a quiet select with more. A login that could not be checked
  // is said, with its command. A face's own cat has no such row: which tool it
  // thinks with is part of it, the mark on its card (catFlow's agent mark).
  function toolLine(onChange) {
    const box = node("div", "qc-tool"), line = node("p", "qc-tool-line"), note = node("p", "qc-tool-note");
    box.append(line, note);
    let select = null, offered = "";
    function render(s, id) {
      const list = R.choices(s), chosen = R.choiceOf(s, id) || list[0];
      note.replaceChildren();
      box.hidden = !chosen;
      if (!chosen) { line.replaceChildren(); select = null; offered = ""; return; }
      paintNote(s, chosen);
      // The same tools on offer: only the choice changes, in place, so a
      // keyboard user's focus stays on the select. Rebuilt otherwise, with
      // focus carried over.
      const next = list.length > 1 ? list.map((c) => c.id + "\n" + c.label + "\n" + c.confirmed).join("\n\n") : "";
      if (select && next === offered) { select.value = chosen.id; return; }
      const refocus = line.contains(document.activeElement);
      line.replaceChildren();
      select = null;
      offered = next;
      line.append(R.TOOL_LINE[0]);
      if (list.length > 1) {
        const pick = node("span", "qc-pick");
        select = node("select", "");
        select.setAttribute("aria-label", "用哪个 Agent 思考");
        for (const c of list) {
          const o = node("option", "", c.label + (c.confirmed ? "" : "（未确认登录）"));
          o.value = c.id;
          select.append(o);
        }
        select.value = chosen.id;
        select.addEventListener("change", () => onChange(select.value));
        pick.append(select);
        line.append(pick);
      } else line.append(node("b", "", chosen.label));
      line.append(R.TOOL_LINE[1]);
      if (refocus && select) select.focus();
    }
    function paintNote(s, chosen) {
      note.hidden = chosen.confirmed;
      if (!chosen.confirmed) {
        const command = R.loginCommand(s, chosen.id);
        note.append(R.unconfirmed(chosen.label, command));
        if (command) note.append(commandChip(command));
      }
    }
    return { element: box, render, disable: (value) => { if (select) select.disabled = value; } };
  }

  // ---- 领一只猫猫：the cats, the chosen one's card, the name and one action ----
  // Shared by the stage and the 新建 dialog's 猫猫 side. It reads /start itself
  // and shows what is in the way instead of a form that cannot work.
  // A face is a cat with its own character and its own tool (the engine's
  // template of that id, faces[] in /start). The chosen one has a card: its
  // portrait on a cushion, the name it comes with and its breed, the Agent it
  // thinks with as a small mark, its temperament in its own words and what it
  // is good at — or, when its tool is not usable here, why this cat cannot
  // come home as it is (the server's words), what can be done about it, and
  // the way on: 「只借它的长相」 turns to 自定义 with its looks already chosen
  // (创建 / 带它回家 is not offered for it). 自定义 is one of the options, a
  // tile like the cats': chosen, the card becomes the owner's own cat — its
  // looks (any face), what it is for, what it is like and the Agent it thinks
  // with.
  // hold: where focus waits while a request is on its way (the dialog's card).
  // centred: the box that re-centres when the form grows (the stage).
  // resize: instead, how a change of the form's height is eased (the dialog,
  // whose top edge stays put). mayFocus: whether the dialog may still move
  // focus to the name once /start answers (not after the owner went elsewhere).
  function catFlow({ dialog, alive, hold, centred, resize, mayFocus, onBusy = () => {}, onState = () => {}, done }) {
    const h = hooks();
    // cat: the face whose own cat is on the card while a cat is chosen (picked:
    // the one the owner chose, kept apart from the row, which shows no choice
    // while something blocks creation and gets it back afterwards).
    // offered: the faces on offer, what each one is like and its tool
    // (R.offer); every portrait, without words, until /start says otherwise.
    // custom: 自定义 is chosen. Moving between it and a cat keeps the name the
    // owner typed, both lines, the Agent and the looks; only what is sent
    // changes. modeTouched: the owner chose (the form chooses 自定义 by itself
    // only when no face's cat can come home as it is).
    // looks: the face 自定义 takes its looks from; looksTouched: the owner
    // picked it (or borrowed it from a cat); untouched, it is the cat on screen
    // when 自定义 is chosen, else the first face.
    // agent: 自定义's tool; toolPicked: the owner chose it. Untouched, it is the
    // usual one, or the tool of the cat on screen when 自定义 was chosen.
    let s = null, agent = null, toolPicked = false, faceTouched = false, picked = null, cat = null, suggested = "", busy = false, loads = 0, refused = "", refusedFaces = false, kind = "";
    let looks = null, looksTouched = false;
    // presented: the form has been shown; from then on only the owner changes between 自定义 and a cat.
    // refusal: the error line holds a refusal about the chosen cat's tool (cleared once it no longer holds).
    let offered = R.offer([], presets()), custom = false, modeTouched = false, presented = false, painted = "", whoShown = "", heroShown = null, usesShown = "", refusal = false;
    // The keys of requests whose answer was lost, by request body: the same
    // body again — after moving to 自定义 and back, too — is the same request
    // under its own key; a changed body (自定义, another tool or other looks) is new.
    const unsure = new Map();
    const root = node(dialog ? "div" : "form", "qc-flow");
    root.tabIndex = -1;
    if (!dialog) {
      root.setAttribute("novalidate", "");
      root.addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
    }
    const faces = lineup({ compact: dialog, onPick: (key) => (key === OWN ? toOwn() : toCat(key)) });
    const ids = () => offered.map((f) => f.id);
    const has = (id) => !!id && ids().includes(id);

    // ---- the card ----
    const about = node("div", "qc-about");
    // The portrait on its cushion (the hand-over to the chat header starts here).
    const hero = node("div", "qc-hero"), heroPic = node("span", "qc-hero-pic");
    hero.setAttribute("aria-hidden", "true");
    hero.append(heroPic);
    // The name it comes with, its breed, and the Agent it thinks with (part of
    // the cat, nothing to pick: a small mark, its sentence for a screen reader).
    const who = node("div", "qc-who"), nick = node("p", "qc-nick"), agentMark = node("p", "qc-agent");
    agentMark.hidden = true;
    who.append(nick, agentMark);
    // Its temperament in its own words, then what it is good at.
    const trait = node("p", "qc-trait");
    // Under them, for a cat that cannot come home as it is: why (the server's
    // reason), what can be done about it, and the way on.
    const usesLine = node("p", "qc-uses-line"), usesMore = node("div", "qc-uses-more");
    usesLine.id = uid("uses");
    usesLine.hidden = true;
    usesMore.hidden = true;
    // 重新检测's answer, beside a tool that needs a login or an install.
    const checkNote = node("p", "qc-uses-note");
    checkNote.setAttribute("role", "status");
    // A quiet line when the portrait changed since the screen read it
    // (face_changed): the card now shows the new words; have a look.
    const fresh = node("p", "qc-fresh");
    fresh.hidden = true;
    // The way on from a cat that cannot come home as it is: 自定义 with its looks.
    const forward = node("div", "qc-forward"), borrow = button("qc-borrow", null, () => borrowLooks()), ahead = node("span", "qc-ahead");
    borrow.append(h.icon("pencil"), node("span", "", R.BORROW));
    ahead.id = uid("ahead");
    borrow.setAttribute("aria-describedby", ahead.id);
    forward.append(borrow, ahead);
    forward.hidden = true;
    const tail = node("div", "qc-tail");
    tail.append(usesLine, usesMore, fresh, forward);
    // 自定义: its looks beside the portrait; what it is for, what it is like
    // and the Agent it thinks with under them. Hidden, never removed, while a
    // cat is chosen, so moving back and forth loses nothing.
    const looksBox = node("div", "qc-looksbox"), looksHead = node("p", "qc-looks-head", "长相");
    looksHead.setAttribute("aria-hidden", "true");
    const looksRow = looksPicker((id) => { looks = id; looksTouched = true; paintAbout(); });
    looksRow.offer(offered);
    looksBox.append(looksHead, looksRow.element);
    looksBox.hidden = true;
    const own = node("div", "qc-own");
    own.hidden = true;
    about.append(hero, who, trait, looksBox, tail, own);
    // Said once, politely, for each choice the owner makes (a cat, 自定义, its
    // looks borrowed); never for what the form fills in by itself, nor while typing.
    const voice = node("p", "qc-sr");
    voice.setAttribute("role", "status");

    const fields = node("div", "qc-fields");
    // A labelled text box (the original .field) with its own message line: the
    // name at the panel's foot, and the two optional lines of 自定义.
    function field(label, { max, optional = false, placeholder = "" }) {
      const box = node("div", "field qc-field");
      const lab = node("label", "", label), input = node("input", ""), err = node("p", "qc-err");
      if (optional) lab.append(node("span", "qc-opt", "可不填"));
      input.type = "text"; input.maxLength = max; input.autocomplete = "off";
      if (placeholder) input.placeholder = placeholder;
      input.id = uid("field"); lab.htmlFor = input.id;
      err.id = uid("err"); err.setAttribute("role", "alert");
      input.setAttribute("aria-describedby", err.id);
      const mark = (text) => {
        err.textContent = text || "";
        if (text) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      };
      input.addEventListener("input", () => { mark(""); showError(""); });
      box.append(lab, input, err);
      return { box, input, mark };
    }
    // The real limit (64 characters) is the rules'; the box only stops a runaway paste.
    // A cat of the owner's own does not borrow a template's name: its box starts empty, this placeholder asking for one.
    const nameF = field("名字", { max: R.NAME_INPUT_MAX, placeholder: R.NAME_PLACEHOLDER }), nameIn = nameF.input;
    nameIn.spellcheck = false;
    // 自定义: what it is for (simple.about), what it is like
    // (simple.personality), both optional, and which tool it thinks with.
    const aboutF = field("它主要帮你做什么", { max: R.ABOUT_INPUT_MAX, optional: true, placeholder: "比如：帮我改简历、陪我练口语" });
    const temperF = field("它的性格", { max: R.PERSONALITY_INPUT_MAX, optional: true, placeholder: "比如：话不多，做事靠谱" });
    const tool = toolLine((id) => {
      agent = id;
      toolPicked = true;
      tool.render(s, agent);
      showError("");
    });
    own.append(aboutF.box, temperF.box, tool.element);
    fields.append(nameF.box);
    const error = node("p", "qc-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const go = node("button", dialog ? "primary" : "primary qc-go", dialog ? "创建" : "带它回家");
    go.type = "submit";
    if (dialog) fields.append(error);
    else fields.append(go, error);

    const wait = node("p", "qc-wait");
    wait.setAttribute("role", "status");
    const needBox = node("div", "qc-need");
    const laterBox = node("div", "qc-later");
    // The cats to choose from, and beside them (the dialog) or under them (the stage, a phone) the card and the name.
    const meet = node("div", "qc-meet"), side = node("div", "qc-side");
    side.append(about, wait, fields, needBox, laterBox);
    meet.append(faces.element, side);
    root.append(meet, voice);

    function show(next) {
      kind = next;
      wait.hidden = kind !== "loading" && kind !== "failed";
      fields.hidden = kind !== "ready";
      needBox.hidden = kind !== "blocked";
      laterBox.hidden = kind !== "later";
      go.hidden = kind !== "ready";
      faces.enable(kind === "ready");
      if (kind !== "ready") { faces.set(null); say(""); note(""); }
      paintAbout();
      onState(kind);
    }
    function showError(text, isRefusal = false) { error.textContent = text || ""; error.hidden = !text; refusal = !!text && isRefusal; }
    function say(text) { if (voice.textContent !== (text || "")) voice.textContent = text || ""; }
    function note(text) { fresh.textContent = text || ""; fresh.hidden = !text; tailShown(); }
    // The card's tail is there only while something in it is.
    const tailShown = () => { tail.hidden = [usesLine, usesMore, fresh, forward].every((n) => n.hidden); };
    // The cat on the card (none while 自定义 is chosen), and the face 自定义 looks like.
    const chosenFace = () => (custom ? null : offered.find((f) => f.id === cat) || null);
    const looksFace = () => offered.find((f) => f.id === looks) || null;
    // A cat is chosen and cannot come home as it is (judged by `state`, /start as read).
    const stuck = (state = s) => !custom && !!chosenFace() && !R.faceUsable(chosenFace(), state);
    // What a choice means, said once: the cat's character, its tool, and, when
    // it cannot come home as it is, the way on.
    const spoken = () => {
      const f = chosenFace();
      if (!f) return "";
      const u = R.uses(R.toolOf(f, s));
      return R.joinSaid([f.hint && f.hint.said, u && u.text, u && !u.usable ? "点「" + R.BORROW + "」，可以" + R.forward(s) : ""]);
    };
    // Eased (the dialog) or glided (the stage): a change of the card's height never jumps.
    const smooth = (change) => { if (resize) resize(change); else glide(centred && centred(), change); };
    // The roster shows the choice: 自定义, or the cat.
    const sync = () => { if (kind === "ready") faces.set(custom ? OWN : cat); };
    function setFace(id) { cat = id; sync(); follow(id); paintAbout(); }
    // The faces /start offers (in its order, those with a portrait here). A
    // cat, or looks, that are no longer there give way.
    function offerFaces(list) {
      offered = list;
      faces.offer(list);
      looksRow.offer(list);
      if (picked && !has(picked)) { picked = null; faceTouched = false; }
      if (cat && !has(cat)) cat = null;
      if (looks && !has(looks)) { looks = null; looksTouched = false; }
      if (custom && !looks) looks = ids()[0] || null;
      looksRow.set(looks);
    }

    // ---- painting the card ----
    // The faces whose own cats cannot come home as they are, why, and the word
    // for it, marked in the row whenever the form can be used. A card for the
    // cat chosen, or for the owner's own; room kept so the name below holds
    // still from one cat to the next.
    function paintAbout() {
      const ready = kind === "ready";
      about.hidden = !ready;
      const hadFocus = tail.contains(document.activeElement);
      const face = chosenFace(), look = custom ? looksFace() : face;
      const away = ready
        ? new Map(offered.filter((f) => !R.faceUsable(f, s)).map((f) => { const t = R.toolOf(f, s) || R.UNREAD; return [f.id, { why: t.reason || "", tag: R.tag(t) }]; }).filter(([, v]) => v.why))
        : null;
      faces.own(ready);
      faces.mark(away && away.size ? away : null);
      const blocked = ready && stuck();
      about.classList.toggle("mixed", !!(away && away.size));
      about.classList.toggle("described", offered.some((f) => f.hint));
      about.classList.toggle("own", custom);
      about.classList.toggle("away", blocked);
      paintHero(look ? look.id : null);
      paintWho(face, look);
      paintTrait(face);
      paintUses(face);
      looksBox.hidden = !custom;
      own.hidden = !custom;
      forward.hidden = !blocked;
      if (blocked) ahead.textContent = R.forward(s);
      borrow.disabled = busy;
      tailShown();
      paintGo();
      // A login's 重新检测 that went away with what it was about: focus goes on to what can be done now.
      if (hadFocus && !tail.contains(document.activeElement)) {
        const again = usesMore.querySelector(".qc-check");
        (again || (go.disabled || go.hidden || go.getAttribute("aria-disabled") === "true" ? borrow : go)).focus();
      }
    }
    // A new portrait steps onto the cushion (rise, 180 ms; still under reduced motion).
    function paintHero(id) {
      if (id === heroShown) return;
      heroShown = id;
      heroPic.replaceChildren(...(id ? [portrait(id)] : []));
    }
    // The name it comes with and its breed; for 自定义, whose cat it is (and, over its looks, which they are).
    function paintWho(face, look) {
      looksHead.textContent = "长相" + (custom && look ? "：" + look.label : "");
      const sig = custom ? "own" : face ? [face.id, face.nickname, face.label].join("\n") : "";
      if (sig === whoShown) return;
      whoShown = sig;
      const parts = [];
      if (custom) parts.push(node("span", "qc-nick-name", R.OWN_TITLE));
      else if (face) {
        const name = face.nickname && face.nickname !== face.label ? face.nickname : "";
        parts.push(node("span", "qc-nick-name", name || face.label));
        if (name) parts.push(node("span", "qc-breed", face.label));
      }
      nick.replaceChildren(...parts);
    }
    // Its temperament and what it is good at (R.trait): the template's own words.
    function paintTrait(face) {
      const lines = face && face.hint ? face.hint.lines : [];
      const sig = (face ? face.id : "") + "\n" + lines.join("\n");
      if (sig !== painted) {
        painted = sig;
        trait.replaceChildren(...lines.map((line) => node("span", "qc-trait-line", line)));
      }
      trait.hidden = !lines.length;
    }
    // The Agent mark and, when it is not usable here, why and what to do; repainted only when what it says changes (a 复制 or 重新检测 keeps focus).
    function paintUses(face) {
      const t = face ? R.toolOf(face, s) : null, u = R.uses(t);
      const help = R.toolHelp(t);
      const command = !u ? "" : u.usable ? (t.state === "unknown" ? t.loginCommand || R.loginCommand(s, t.id) : "") : help ? help.command : "";
      const sig = u ? [u.text, t.state, command].join("\n") : "";
      if (sig === usesShown) return;
      usesShown = sig;
      // The mark: its sentence for a screen reader (「它用这台电脑上的 Claude Code 来思考」), the name and, when not usable, the short word why.
      agentMark.hidden = !u || !t.label;
      agentMark.classList.toggle("away", !!u && !u.usable);
      if (u && t.label) {
        const parts = [spark(), node("span", "qc-sr", u.usable ? R.USES[0] : "它要用 "), node("b", "", t.label), node("span", "qc-sr", u.usable ? R.USES[1] : " 来思考，")];
        if (!u.usable) parts.push(node("span", "qc-agent-tag", R.tag(t)));
        agentMark.replaceChildren(...parts);
      } else agentMark.replaceChildren();
      // Why it cannot come home as it is, in the server's words.
      usesLine.hidden = !u || u.usable;
      usesLine.replaceChildren(...(u && !u.usable ? [node("span", "qc-uses-text", R.why(t))] : []));
      const more = [];
      // Installed, but its login could not be checked: said, never "ready".
      if (u && u.usable && t.state === "unknown") {
        more.push(node("span", "qc-uses-say", R.unconfirmed(t.label, command)));
        if (command) more.push(commandChip(command));
      }
      // Needs a login, or is not installed: what to do (with the login command) and 重新检测, as the blocked
      // screen has them; the cat and everything typed stay. A tool the app cannot connect yet has nothing to re-detect.
      if (u && help) {
        checkNote.textContent = "";
        more.push(node("span", "qc-uses-say", help.text));
        if (command) more.push(commandChip(command));
        more.push(checkAgain(), checkNote);
      }
      usesMore.replaceChildren(...more);
      usesMore.hidden = !more.length;
    }
    // 重新检测 beside a tool that needs a login or an install: inert while
    // checking, not disabled, so focus stays on it when the answer changes nothing.
    function checkAgain() {
      const label = node("span", "", "重新检测"), again = button("text-btn qc-check");
      again.append(h.icon("refresh-cw"), label);
      again.addEventListener("click", async () => {
        if (busy || again.getAttribute("aria-disabled") === "true") return;
        again.setAttribute("aria-disabled", "true");
        label.textContent = "正在检测…";
        checkNote.textContent = "";
        await load("refresh");
        again.removeAttribute("aria-disabled");
        label.textContent = "重新检测";
      });
      return again;
    }
    // 创建 / 带它回家: not for a cat that cannot come home as it is.
    // aria-disabled, not disabled: it stays focusable and described by the line
    // that says why, and pressing it — or Enter in a field, which presses it —
    // sends nothing and takes the owner to the way on, 「只借它的长相」
    // (submit's guard). Disabled only while a request is on its way.
    function paintGo() {
      const blocked = kind === "ready" && stuck();
      go.disabled = busy;
      if (blocked) { go.setAttribute("aria-disabled", "true"); go.setAttribute("aria-describedby", usesLine.id); }
      else { go.removeAttribute("aria-disabled"); go.removeAttribute("aria-describedby"); }
    }

    // ---- choosing ----
    // A cat, by the owner: its card (from 自定义, too: the owner's lines, tool and looks stay for later).
    function toCat(id) {
      if (busy || kind !== "ready") return;
      faceTouched = true;
      picked = id;
      const leaving = custom;
      if (leaving) modeTouched = true;
      smooth(() => {
        cat = id;
        if (leaving) custom = false;
        follow(id);
        note("");
        if (refusal || leaving) showError("");
        paintAbout();
      });
      say(spoken());
    }
    // 自定义, by the owner (its tile, or 「只借它的长相」 with `from`'s looks): the card becomes the owner's own cat.
    function toOwn(borrowed = null) {
      if (busy || kind !== "ready") return;
      if (custom && !borrowed) return;
      const from = chosenFace();
      modeTouched = true;
      if (borrowed) { looks = borrowed.id; looksTouched = true; }
      smooth(() => { setCustom(true, from); note(""); });
      say(R.OWN_NOTE);
      showError("");
    }
    // 「只借它的长相」: 自定义 with the looks of the cat on the card; focus to the looks chosen, so what happened is in reach.
    function borrowLooks() {
      const from = chosenFace();
      if (!from || !stuck()) return;
      toOwn(from);
      looksRow.focus();
    }
    function setCustom(next, from = null) {
      custom = next;
      if (custom) {
        // Its looks: the owner's own pick, kept; else the cat that was on screen; else the first face.
        if (!looksTouched || !has(looks)) looks = from && has(from.id) ? from.id : has(looks) ? looks : ids()[0] || null;
        looksRow.set(looks);
        // 自定义's tool, untouched: the tool of the cat on screen when it is here, so choosing 自定义 changes nothing silently; else the usual one.
        if (!toolPicked && s && s.ready) {
          const t = R.toolOf(from, s);
          agent = t && t.usable && t.id && R.choiceOf(s, t.id) ? t.id : s.agent.id;
          tool.render(s, agent);
        }
      }
      sync();
      follow(cat);
      paintAbout();
    }
    // The name box keeps the chosen cat's nickname until the owner writes their
    // own; 自定义 borrows none (its box is empty, asking for a name). A name the
    // owner typed is never overwritten.
    function follow(face) {
      const next = custom ? "" : R.suggestName(face, offered, h.cats());
      if (R.followsFace(nameIn.value, suggested)) nameIn.value = next;
      suggested = next;
    }
    // The dialog starts in the name, its suggestion selected so typing replaces
    // it. The stage leaves focus alone on arrival (the cats are the first thing
    // to see, and a phone keeps its keyboard down); after 重新检测 brings the
    // form, focus moves from the vanished button to the name.
    function focusName() {
      nameIn.focus();
      if (nameIn.select) nameIn.select();
    }

    async function load(how) {
      const mine = ++loads;
      if (how === "first") {
        show("loading");
        wait.replaceChildren(node("span", "qc-wait-text", "正在看看这台电脑…"));
      }
      let raw;
      try { raw = await h.api("/xbot-api/start" + (how === "refresh" ? "?refresh=1" : "")); }
      catch (err) {
        if (alive() && mine === loads) failed(err, how);
        return;
      }
      if (alive() && mine === loads) apply(R.start(raw), how);
    }
    function failed(err, how) {
      const why = R.startError(err);
      if (how === "refresh" && !needBox.hidden) { paintNeed(s, "没能重新检测：" + why); return; }
      if (how === "refresh" && !fields.hidden) { checkNote.textContent = "没能重新检测：" + why + "。"; return; }
      if ((how === "refused" || how === "face") && !fields.hidden) { showError(refused + "也没能重新读取这台电脑的情况，稍后再试。"); return; }
      if (how === "changed" && !fields.hidden) { showError("这只猫猫的介绍刚刚更新了，可没能读到新的介绍，稍后再试。"); return; }
      show("failed");
      wait.replaceChildren(node("span", "", why + "。"), button("text-btn qc-retry", "重试", () => load("first")));
    }
    // how: "first", "refresh" (重新检测), "refused" (after a 422 or
    // faces_unavailable: `refused` says what happened), "face" (after
    // face_unavailable or face_tool: the server's sentence) or "changed"
    // (after face_changed: the portrait the owner saw is out of date).
    function apply(next, how) {
      const before = s, wasReady = !fields.hidden && !!(before && before.ready), wasStuck = wasReady && stuck(before);
      s = next;
      offerFaces(R.offer(next.faces, presets()));
      // Blocked: no usable tool, or (just as final) no cat's details to make one from.
      if (!next.ready || !R.usable(next.faces, presets())) {
        let said = "";
        if (how === "refresh") said = R.sameStart(before, next) ? needOf(next).unchanged : "检测结果有变化。";
        else if (how === "refused" || how === "face") said = refused;
        paintNeed(next, said);
        show("blocked");
        // The form the owner was in is gone: focus goes to what replaced it (its title, then 重新检测).
        if (wasReady) { const title = needBox.querySelector("h3"); if (title) title.focus(); }
        return;
      }
      // 自定义's tool: still usable, or the usual one again (said when that changed under a custom cat on screen).
      const lost = wasReady && custom && agent && !R.choiceOf(next, agent) ? (R.choiceOf(before, agent) || {}).label : "";
      if (!agent || !R.choiceOf(next, agent)) { agent = next.agent.id; toolPicked = false; }
      tool.render(next, agent);
      // The cat chosen for the owner: the first whose cat can come home as it is. With none, only
      // 自定义 makes a cat, so the form chooses it by itself — only before it is first presented: once
      // on screen, only the owner changes the choice (a re-read never turns a draft into a template).
      const first = R.firstUsable(offered, next);
      if (!presented && !modeTouched && custom === !!first) setCustom(!first);
      const face = faceTouched && picked ? picked : first || ids()[0] || null;
      if (!wasReady) {
        // Back from blocked (or first time ready): the owner's own cat if they picked one.
        show("ready");
        presented = true;
        setFace(face);
        if ((dialog && (!mayFocus || mayFocus())) || how === "refresh") focusName();
      } else {
        // A choice that is no longer there gives way. The cat on screen otherwise stays, even an untouched
        // one: the owner was looking at it (and may just have tried to bring it home); its card says how it is now.
        if (!cat) setFace(face);
        else sync();
        // The same face may come back with new words or a new tool: show them (quietly; nobody chose anything).
        paintAbout();
      }
      if (lost) showError(lost + " 现在用不了，已经换成 " + next.agent.label + "。再点一次就好。");
      else if (how === "refused") showError(refused + (refusedFaces ? "现在读到了，再点一次就好。" : ""));
      else if (how === "face") {
        // The server's sentence; read again, the card says how things are now (and 「只借它的长相」 is the way on).
        const now = !stuck();
        showError(refused + (now ? "重新检测过，现在能用了，再点一次就好。" : ""), !now);
        (now ? go : borrow).focus();
      } else if (how === "changed" && wasReady) {
        // The owner was looking at older words: say so beside the new ones, and once aloud. Nothing is sent again by itself.
        note(R.FACE_CHANGED);
        say(R.FACE_CHANGED + (custom ? "" : spoken()));
        go.focus();
      } else if (how === "refresh" && wasReady) {
        // 重新检测 beside a login: said plainly when nothing changed; a cat that can come home now is said once.
        const help = R.toolHelp(R.toolOf(chosenFace(), next));
        checkNote.textContent = R.sameStart(before, next) ? (help ? help.unchanged : "重新检测过了，没有变化。") : "检测结果有变化。";
        // The cat can come home now: a refusal about its tool no longer holds, and the new state is said once.
        if (wasStuck && !stuck()) { if (refusal) showError(""); say(spoken()); }
      }
    }
    // What blocks: the tools (item 28) first, else the cats' details.
    const needOf = (next) => (next && next.ready ? R.facesNeed() : R.need(next));
    function paintNeed(next, said) {
      const copy = needOf(next), refocus = needBox.contains(document.activeElement);
      const cmds = node("div", "qc-cmds");
      for (const c of copy.commands) cmds.append(commandChip(c.command, copy.commands.length > 1 ? c.label : ""));
      cmds.hidden = !copy.commands.length;
      const label = node("span", "", "重新检测"), again = button("secondary qc-again");
      again.append(h.icon("refresh-cw"), label);
      const status = node("p", "qc-note", said);
      status.setAttribute("role", "status");
      // Inert while checking, but not disabled: a disabled button would drop
      // focus, and the answer repaints this panel with focus kept on it.
      again.addEventListener("click", async () => {
        if (again.getAttribute("aria-disabled") === "true") return;
        again.setAttribute("aria-disabled", "true");
        label.textContent = "正在检测…";
        status.textContent = "";
        await load("refresh");
        again.removeAttribute("aria-disabled");
        label.textContent = "重新检测";
      });
      const title = node("h3", "", copy.title);
      title.tabIndex = -1;
      needBox.replaceChildren(title, node("p", "", copy.body), cmds, again, status);
      if (refocus) again.focus();
    }

    function setBusy(on) {
      busy = on;
      // A focused button that turns disabled would drop focus to the page:
      // hold it on the form until the answer says where it goes next.
      const here = document.activeElement, holder = hold || root, typing = [nameIn, aboutF.input, temperF.input];
      if (on && holder.contains(here) && !typing.includes(here)) holder.focus();
      faces.enable(!on);
      looksRow.enable(!on);
      // Read-only rather than disabled, so the caret and focus stay put.
      for (const input of typing) input.readOnly = on;
      borrow.disabled = on;
      tool.disable(on);
      paintGo();
      go.textContent = on ? (dialog ? "正在创建…" : "正在带它回家…") : dialog ? "创建" : "带它回家";
      onBusy(on);
    }
    // The tool the cat being made thinks with: 自定义's, or the face's own.
    const toolLabel = () => (custom ? (R.choiceOf(s, agent) || {}).label : (R.toolOf(chosenFace(), s) || {}).label) || "";
    async function submit() {
      if (busy || !s || !s.ready || fields.hidden) return;
      // A cat that cannot come home as it is: nothing is sent; the way on is 「只借它的长相」.
      if (stuck()) { borrow.focus(); return; }
      // A face's own cat sends the face and the rev of the portrait shown (its tool is its own); 自定义 sends
      // custom, its looks (a face, always: the server takes its colour from it), what was written and the tool shown.
      const face = custom ? looksFace() : chosenFace();
      if (!face) return;
      const body = R.catBody({ name: nameIn.value, face: face.id, rev: face.rev, agent, custom, about: aboutF.input.value, personality: temperF.input.value });
      const print = R.fingerprint(body);
      // The same request as one whose answer was lost goes back under its key
      // even when the refreshed list now knows the name: that cat may be this
      // request's own, and the server answers with it instead of a second one.
      const known = unsure.get(print) || "";
      const problem = R.nameProblem(nameIn.value, known ? [] : h.cats());
      if (problem) { nameF.mark(problem); nameIn.focus(); return; }
      if (custom) {
        for (const [f, check] of [[aboutF, R.aboutProblem], [temperF, R.personalityProblem]]) {
          const long = check(f.input.value);
          if (long) { f.mark(long); f.input.focus(); return; }
        }
      }
      const key = known || requestKey();
      showError("");
      note("");
      setBusy(true);
      let result;
      // serverError: the shell's api() would otherwise turn a 5xx into a generic error and drop its `code`
      // (faces_unavailable is a 503 that says nothing was made); a 5xx without a code is still unsure.
      try { result = await h.api("/xbot-api/bots", { method: "POST", body: { ...body, idempotencyKey: key }, serverError: true }); }
      catch (err) {
        if (!alive()) return;
        setBusy(false);
        const what = R.catError(err, body.name, toolLabel());
        // An unsure request may have made the cat: the same body keeps its key.
        // A refused one made none (face_changed, faces_unavailable and
        // face_unavailable are refusals too): the next is new, checked against
        // the list again.
        if (what.kind === "unsure") unsure.set(print, key); else unsure.delete(print);
        if (what.kind === "name") { nameF.mark(what.text); nameIn.focus(); quietly(h.refresh); }
        // What blocks (the tool, or the cats' details) is read again and shown as item 28 does; nothing was made.
        else if (what.kind === "blocked" || what.kind === "unavailable") { refused = what.text; refusedFaces = what.kind === "unavailable"; await load("refused"); }
        // This face's tool cannot be used here (the screen showed an older state): the server's sentence, and the faces read again.
        else if (what.kind === "face") { refused = what.text; refusedFaces = false; await load("face"); }
        // The portrait changed: read the faces again and let the owner look; not sent again by itself.
        else if (what.kind === "changed") await load("changed");
        // request_changed: this key stood for another request; the server's sentence, and the list read again (it
        // may know the name now). Its key is dropped like any refusal's, so the next attempt is a new request.
        else { showError(what.text); go.focus(); if (what.kind === "unsure" || what.kind === "changedRequest") quietly(h.refresh); }
        return;
      }
      if (!alive()) return;
      unsure.clear();
      const name = (result && typeof result.name === "string" && result.name) || body.name;
      // A notice about the new cat (one default not written) is handed to the
      // shell now, by the cat's identity; the shell says it once that cat's
      // chat is actually open, however and whenever it opens (h.notice).
      const notice = R.createdNotice(result);
      if (notice && h.notice) h.notice({ name, nativeId: result && typeof result.native_id === "string" ? result.native_id : "", text: notice });
      // The portrait on the card is the one that travels to the chat header.
      done({ name, face: body.simple.face, picture: heroShown === body.simple.face ? heroPic : null });
    }
    // Made, but its chat did not open: say it is there and offer to open it.
    function later(name, reopen) {
      const open = button("primary qc-go", "打开聊天", async () => {
        open.disabled = true;
        try { await reopen(); } catch { open.disabled = false; }
      });
      laterBox.replaceChildren(node("p", "", "「" + name + "」已经到家了，只是没能打开聊天。"), open);
      show("later");
      open.focus();
    }
    return {
      element: root, go, start: () => load("first"), submit, later,
      // Where focus goes when the form is turned to: the name once it is there, else where focus waits.
      focus: () => { if (kind === "ready") focusName(); else (hold || root).focus(); },
      // For cats arriving from elsewhere (release): a request in flight or a cat
      // already made here; and whether the owner has a draft (their own cat,
      // name, 自定义, its looks, its tool or its lines) or a request whose answer was lost.
      waiting: () => busy || kind === "later",
      kept: () => faceTouched || (custom && modeTouched) || looksTouched || toolPicked || !R.followsFace(nameIn.value, suggested)
        || !!R.trim(aboutF.input.value) || !!R.trim(temperF.input.value) || unsure.size > 0,
    };
  }

  // ---- the hand-over ----
  // The chosen portrait travels from where it was picked to the cat's face in
  // the chat header, so the new chat reads as the same cat arriving. One
  // straight 340 ms glide, no bounce; skipped when motion is reduced or when
  // nothing is laid out.
  const visible = (el) => (el && el.isConnected && el.getBoundingClientRect().width > 0 ? el : null);
  function handOff(picture, face) {
    if (!picture || media("(prefers-reduced-motion: reduce)") || typeof document.body.animate !== "function") return null;
    const from = picture.getBoundingClientRect();
    if (!from || !(from.width > 0)) return null;
    const ghost = node("div", "qc-ghost");
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, { left: from.left + "px", top: from.top + "px", width: from.width + "px", height: from.height + "px" });
    ghost.append(portrait(face));
    document.body.append(ghost);
    picture.style.visibility = "hidden";
    let over = false;
    const end = () => { if (!over) { over = true; ghost.remove(); } };
    return {
      // Wait a few frames (at most 0.7 s) for the chat to show the face, then glide onto it.
      async land(find) {
        const until = Date.now() + 700;
        let target = null;
        while (!over && !(target = visible(find())) && Date.now() < until) await frame();
        if (over) return;
        if (!target) {
          await ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-out", fill: "forwards" }).finished.catch(() => {});
          end();
          return;
        }
        // The header crops a cat closer (1.25× about 50% 40%, cafe-theme.css):
        // land on the same cat size, so the swap at the end is invisible.
        const to = target.getBoundingClientRect(), k = (to.width * 1.25) / from.width;
        const dx = to.left - to.width * 0.125 - from.left, dy = to.top - to.height * 0.1 - from.top;
        target.style.visibility = "hidden";
        await ghost.animate([{ transform: "translate(0px, 0px) scale(1)" }, { transform: `translate(${dx}px, ${dy}px) scale(${k})` }],
          { duration: 340, easing: "cubic-bezier(0.2, 0.75, 0.3, 1)", fill: "forwards" }).finished.catch(() => {});
        target.style.visibility = "";
        end();
      },
      cancel() { end(); picture.style.visibility = ""; },
    };
  }
  // Open the new cat's chat, gliding its portrait there on the way. Rejects
  // only when the chat could not be opened; the cat exists either way.
  function arrive(name, face, picture) {
    const h = hooks(), flight = handOff(picture, face);
    arriving++;
    const opened = Promise.resolve().then(() => h.openCat(name));
    if (flight) flight.land(() => h.landing(name));
    return opened.finally(() => { arriving--; }).catch((err) => { if (flight) flight.cancel(); throw err; });
  }
  // A cat made here is on its way into its chat: the list may already show it.
  let arriving = 0;

  // ---- the views ----
  // No cats yet: the main area is where the first one is brought home.
  function stage() {
    const h = hooks();
    const root = node("section", "qc-stage"), title = node("h2", "qc-title", "领一只猫猫回家");
    title.id = uid("title");
    root.setAttribute("aria-labelledby", title.id);
    // Each face is a cat with its own character now, not only a look: 合心意.
    const sub = node("p", "qc-sub", "挑一只合心意的，给它起个名字。");
    const flow = catFlow({
      dialog: false,
      alive: () => root.isConnected,
      centred: () => root,
      onState: (kind) => { sub.hidden = kind !== "ready" && kind !== "loading"; },
      done: ({ name, face, picture }) => {
        root.classList.add("leaving");
        arrive(name, face, picture).catch((err) => {
          if (!root.isConnected) { h.error(err); return; }
          root.classList.remove("leaving");
          flow.later(name, () => h.openCat(name));
        });
      },
    });
    // Cats that arrived from elsewhere while this stage holds a draft (release).
    const arrived = node("p", "qc-arrived");
    arrived.setAttribute("role", "status");
    arrived.hidden = true;
    root.append(title, sub, arrived, flow.element);
    stages.set(root, {
      flow,
      point(names) {
        const shownNames = names.slice(0, 3).join("、") + (names.length > 3 ? "等 " + names.length + " 只" : "");
        arrived.replaceChildren("已经有猫猫了：" + shownNames + "。", button("text-btn qc-go-chat", "去聊天", () => {
          Promise.resolve().then(() => h.openCat(names[0])).catch((err) => h.error(err));
        }));
        arrived.hidden = false;
      },
    });
    flow.start();
    return root;
  }

  // The first cat arrived from elsewhere (another tab) while the stage is up;
  // app.js asks on every list read. An untouched stage may go (true: the shell
  // shows the no-chat line, so the list's chat is in reach on a phone too). One
  // with a draft — the owner's own face or name, focus inside it, or a request
  // whose answer was lost — stays and points at the cats instead. A request in
  // flight, or a cat made here and on its way, changes nothing and says nothing.
  const stages = new WeakMap();
  function release(view, names) {
    const one = stages.get(view);
    if (!one) return true;
    if (arriving || one.flow.waiting()) return false;
    if (!one.flow.kept() && !view.contains(document.activeElement)) return true;
    one.point(names);
    return false;
  }

  // Cats, but no chat open. Right on a phone too, where the list is a drawer.
  function noChat() {
    const h = hooks();
    const box = node("div", "empty qc-none");
    box.append(node("h2", "", "选一个聊天"), node("p", "", "从列表里选一只猫猫或一个群聊。"), button("secondary qc-list", "打开列表", () => h.showList()));
    return box;
  }

  // One quick dialog at a time, on the original .modal / .modal-card. Escape,
  // Tab and every other key stay inside; focus goes back to the opener, or,
  // when it is gone or no longer shown (a list redraw, the rail turned into
  // the drawer), to the 新建 button shown now.
  let layer = null;
  const showing = (el) => !!el && el.isConnected && (!el.getClientRects || el.getClientRects().length > 0);
  function liveOpener(opener) {
    if (showing(opener)) return opener;
    const now = H && H.opener ? H.opener() : null;
    if (now && now.isConnected) return now;
    return opener && opener.isConnected ? opener : null;
  }
  function trapTab(ev, card) {
    const live = [...card.querySelectorAll("button, input, select, textarea")]
      .filter((n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && (!n.getClientRects || n.getClientRects().length));
    if (!live.length) return;
    const first = live[0], last = live[live.length - 1], here = document.activeElement;
    if (ev.shiftKey ? here === first || !live.includes(here) : here === last || !live.includes(here)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  }
  // A change of the card's height, eased (180 ms, as the stage's glide) from
  // the old height to the new one; its top edge stays where it is (the
  // dialog hangs from a fixed line, quick-create.css). At once when motion is
  // reduced or nothing is laid out.
  // Switched again mid-way: the newer easing starts from the height on screen, and the clip lasts until it ends.
  const easing = new WeakMap();
  function ease(card, change) {
    const can = card && typeof card.animate === "function" && !media("(prefers-reduced-motion: reduce)");
    const before = can ? card.getBoundingClientRect().height : 0;
    change();
    if (!can) return;
    const prev = easing.get(card);
    if (prev) { easing.delete(card); if (typeof prev.cancel === "function") prev.cancel(); }
    const after = card.getBoundingClientRect().height;
    if (!before || !after || Math.abs(after - before) < 1) { card.classList.remove("qc-easing"); return; }
    card.classList.add("qc-easing");
    const anim = card.animate([{ height: before + "px" }, { height: after + "px" }], { duration: 180, easing: "ease-out" });
    easing.set(card, anim);
    const done = () => { if (easing.get(card) === anim) card.classList.remove("qc-easing"); };
    anim.finished.then(done, done);
  }
  function dialog(title, opener) {
    if (layer) layer.close(true);
    const root = node("div", "modal qc-modal"), card = node("div", "modal-card qc-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.tabIndex = -1;
    const top = node("div", "qc-head"), head = node("h2", "", title);
    head.id = uid("title");
    card.setAttribute("aria-labelledby", head.id);
    top.append(head);
    card.append(top);
    root.append(card);
    document.body.append(root);
    let downOnRoot = false;
    const L = {
      card, top, alive: true, busy: false,
      close(force) {
        if (!L.alive || (L.busy && !force)) return;
        L.alive = false;
        root.remove();
        if (layer === L) layer = null;
        const back = liveOpener(opener);
        if (back && back.focus) back.focus({ preventScroll: true });
      },
    };
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); if (!L.busy) L.close(); }
      else if (ev.key === "Tab") trapTab(ev, card);
      ev.stopPropagation();
    });
    root.addEventListener("mousedown", (ev) => { downOnRoot = ev.target === root; });
    root.addEventListener("click", (ev) => { if (ev.target === root && downOnRoot && !L.busy) L.close(); downOnRoot = false; });
    layer = L;
    card.focus();
    return L;
  }

  // 新建: one dialog for a cat or a group (the owner, 2026-11-12: 「点击新建可以
  // 直接弹出弹窗…弹窗是一个可以合理切换猫猫与群聊初始配置的窗口」). Its title
  // is 新建; beside it a two-way switch, 猫猫 | 群聊, a tab list: the selected
  // tab is the one Tab stop, ← → (and Home, End) move to the other side and
  // focus it. Each side is built the first time it is shown (the cat side reads
  // /start then; the group side sends nothing until 创建) and kept while the
  // dialog is open, so switching back finds the cat, the name, 自定义, the
  // picked cats and the group name as they were left. The card keeps its top
  // edge; a change of height is eased. A side turned to from inside the
  // dialog (群聊's 新建猫猫) is announced and focus goes into it. While a
  // request is on its way the switch does not move.
  const SIDES = [["cat", "猫猫", "新建猫猫"], ["group", "群聊", "新建群聊"]];
  function open({ side = "cat", opener } = {}) {
    const h = hooks(), from = opener || document.activeElement;
    const L = dialog("新建", from);
    const tabs = node("div", "qc-switch");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "新建什么");
    const said = node("p", "qc-sr");
    said.setAttribute("role", "status");
    const sides = new Map();
    let current = null;
    for (const [id, label, title] of SIDES) {
      const tab = button("qc-tab", label, () => select(id, "tab"));
      tab.id = uid("tab");
      tab.dataset.side = id;
      tab.setAttribute("role", "tab");
      const panel = node("form", "qc-panel");
      panel.setAttribute("novalidate", "");
      panel.setAttribute("role", "tabpanel");
      panel.id = uid("panel");
      panel.dataset.side = id;
      panel.hidden = true;
      tab.setAttribute("aria-controls", panel.id);
      tab.setAttribute("aria-selected", "false");
      panel.setAttribute("aria-labelledby", tab.id);
      tab.addEventListener("keydown", (ev) => {
        const at = SIDES.findIndex(([k]) => k === id), last = SIDES.length - 1;
        const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: last }[ev.key];
        if (to === undefined) return;
        ev.preventDefault();
        select(SIDES[(to + SIDES.length) % SIDES.length][0], "tab");
      });
      tabs.append(tab);
      L.card.append(panel);
      sides.set(id, { tab, panel, title, view: null });
    }
    L.top.append(tabs);
    L.card.append(said);
    // A side's own 创建 (or Enter in one of its fields) submits its form; the card answers for the side shown.
    L.card.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const view = current && sides.get(current).view;
      if (view) view.submit();
    });
    const lock = (on) => { for (const s of sides.values()) { if (on) s.tab.setAttribute("aria-disabled", "true"); else s.tab.removeAttribute("aria-disabled"); } };
    const busy = (on) => { L.busy = on; lock(on); };

    // how: "open" (focus as the side starts: the cat side's name once /start
    // answers, the group's first cat), "tab" (focus stays on the tab) or
    // "inside" (a control in the dialog turned to it: said, focus goes in).
    function select(id, how) {
      const next = sides.get(id);
      if (!next || (L.busy && id !== current)) return;
      if (id !== current) {
        const change = () => {
          for (const [k, s] of sides) {
            const on = k === id;
            s.panel.hidden = !on;
            s.tab.setAttribute("aria-selected", String(on));
            s.tab.tabIndex = on ? 0 : -1;
          }
          current = id;
          if (!next.view) next.view = id === "cat" ? catSide(next.panel) : groupSide(next.panel);
        };
        if (how === "open") change(); else ease(L.card, change);
        if (how !== "open" && typeof next.panel.animate === "function" && !media("(prefers-reduced-motion: reduce)")) {
          next.panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
        }
      }
      if (how === "tab") { next.tab.focus(); said.textContent = ""; }
      else {
        next.view.focus();
        said.textContent = how === "inside" ? next.title : "";
      }
    }

    // 猫猫: the cats and 自定义, the chosen one's card and the name (catFlow); 更多设置 hands
    // over to the template creator.
    function catSide(panel) {
      const more = button("text-btn qc-more", "更多设置", () => { if (L.busy) return; L.close(true); h.more(liveOpener(from) || from); });
      const cancel = button("secondary", "取消", () => L.close());
      const flow = catFlow({
        dialog: true,
        alive: () => L.alive,
        hold: L.card,
        resize: (change) => ease(L.card, change),
        // The name takes focus when /start answers only if nobody went elsewhere meanwhile (the switch, say).
        mayFocus: () => current === "cat" && (document.activeElement === L.card || !L.card.contains(document.activeElement)),
        onBusy: (on) => { busy(on); more.disabled = on; cancel.disabled = on; },
        done: ({ name, face, picture }) => {
          const going = arrive(name, face, picture); // takes the portrait's place before the dialog goes
          L.close(true);
          going.catch((err) => h.error(err));
        },
      });
      const body = node("div", "qc-body"), actions = node("div", "modal-actions");
      body.append(flow.element);
      actions.append(more, cancel, flow.go);
      panel.append(body, actions);
      flow.start();
      return { submit: flow.submit, focus: flow.focus };
    }

    // 群聊: two to ten cats as face chips, in the order picked; the name is
    // optional. With fewer than two cats it says so, and 新建猫猫 turns to the
    // cat side.
    function groupSide(panel) {
      const cats = h.cats();
      const body = node("div", "qc-body"), actions = node("div", "modal-actions");
      panel.append(body, actions);
      const cancel = button("secondary", "取消", () => L.close());
      if (cats.length < 2) {
        body.append(node("p", "qc-lead", cats.length ? "群聊至少要两只猫猫，现在只有 1 只。" : "群聊至少要两只猫猫，现在还一只都没有。"));
        const add = button("primary", "新建猫猫", () => select("cat", "inside"));
        actions.append(cancel, add);
        return { submit: () => {}, focus: () => add.focus() };
      }
      // Members in the order they were picked: the first sits in front of the group's face.
      const picked = [];
      // One key per request body (members in order, name): an unsure answer is
      // sent again unchanged under it and arrives at the same group.
      let sending = false, attempt = null;
      const hint = node("p", "qc-hint");
      hint.id = uid("hint");
      hint.setAttribute("aria-live", "polite");
      const set = node("fieldset", "qc-members-set"), chips = node("div", "qc-members");
      set.append(node("legend", "qc-legend", "成员"), chips, hint);
      const boxes = cats.map((name) => {
        const chip = node("label", "qc-chip"), cb = node("input", "qc-sr");
        cb.type = "checkbox";
        cb.value = name;
        cb.setAttribute("aria-describedby", hint.id);
        chip.append(cb, h.face(name), node("span", "qc-chip-name", name));
        cb.addEventListener("change", () => {
          const at = picked.indexOf(name);
          if (cb.checked && at < 0) picked.push(name);
          else if (!cb.checked && at >= 0) picked.splice(at, 1);
          showError("");
          sync();
        });
        chips.append(chip);
        return cb;
      });
      const nameBox = node("div", "field qc-field"), lab = node("label", ""), nameIn = node("input", ""), nameErr = node("p", "qc-err");
      lab.append("群名", node("span", "qc-opt", "可不填"));
      nameIn.type = "text"; nameIn.maxLength = R.NAME_INPUT_MAX; nameIn.autocomplete = "off";
      nameIn.id = uid("group-name"); lab.htmlFor = nameIn.id;
      nameErr.setAttribute("role", "alert");
      nameIn.addEventListener("input", () => { nameErr.textContent = ""; nameIn.removeAttribute("aria-invalid"); showError(""); });
      nameBox.append(lab, nameIn, nameErr);
      const error = node("p", "qc-error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const go = node("button", "primary", "创建");
      go.type = "submit";
      body.append(set, nameBox, error);
      actions.append(cancel, go);
      function showError(text) { error.textContent = text || ""; error.hidden = !text; }
      function sync() {
        const n = picked.length, full = n >= R.MAX_MEMBERS;
        for (const cb of boxes) cb.disabled = sending || (full && !cb.checked);
        hint.textContent = n < 2 ? (n ? "已选 1 只，再选 1 只" : "至少选 2 只") : full ? "已选 " + n + " 只，一个群最多 " + R.MAX_MEMBERS + " 只" : "已选 " + n + " 只";
        nameIn.placeholder = n >= 2 ? R.groupName(picked) : "不填就用成员的名字";
        go.disabled = sending || n < 2;
      }
      function setBusy(on) {
        sending = on;
        busy(on);
        // Focus on a control that turns disabled would drop to the page: hold it on the card.
        if (on && L.card.contains(document.activeElement) && document.activeElement !== nameIn) L.card.focus();
        cancel.disabled = on;
        nameIn.readOnly = on;
        go.textContent = on ? "正在创建…" : "创建";
        sync();
      }
      async function submit() {
        if (sending || picked.length < 2) return;
        const problem = R.groupNameProblem(nameIn.value);
        if (problem) { nameErr.textContent = problem; nameIn.setAttribute("aria-invalid", "true"); nameIn.focus(); return; }
        const reqBody = R.groupBody(picked, nameIn.value), print = R.fingerprint(reqBody);
        if (!attempt || attempt.print !== print) attempt = { print, key: requestKey() };
        showError("");
        setBusy(true);
        let group;
        try { group = await h.api("/xbot-api/groups", { method: "POST", body: { ...reqBody, idempotencyKey: attempt.key } }); }
        catch (err) {
          if (!L.alive) return;
          setBusy(false);
          const what = R.groupError(err);
          if (what.kind !== "unsure") attempt = null;
          showError(what.text);
          go.focus();
          if (what.kind === "unsure") quietly(h.refresh);
          return;
        }
        if (!L.alive) return;
        L.busy = false;
        L.close(true);
        if (group && group.id) Promise.resolve().then(() => h.openGroup(group.id)).catch((err) => h.error(err));
        else quietly(h.refresh);
      }
      sync();
      return { submit, focus: () => (boxes.find((cb) => cb.checked) || boxes[0]).focus() };
    }

    select(sides.has(side) ? side : "cat", "open");
    return { close: () => L.close(true), select: (id) => select(id, "tab") };
  }
  // 新建 → the dialog on its 猫猫 side (the sidebar's 新建, ⌘K 新建猫猫, 更多设置's way back).
  function openCat({ opener } = {}) { return open({ side: "cat", opener }); }
  // ⌘K 新建群聊 → the same dialog on its 群聊 side.
  function openGroup({ opener } = {}) { return open({ side: "group", opener }); }

  window.ClowderQuickCreate = Object.freeze({
    init: (value) => { H = value; },
    stage, noChat, openCat, openGroup, release,
    close: () => { if (layer) layer.close(true); },
  });
})();
