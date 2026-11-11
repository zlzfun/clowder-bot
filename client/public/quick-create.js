// 开箱即用。The rules live in quick-create-rules.js; app.js passes its helpers
// through init(). Four views:
//   stage()     no cats yet: 「领一只猫猫回家」 — the eight clay cats in a row,
//               pick one, keep or change its name, 带它回家;
//   noChat()    cats, but no chat open: one line (and 打开列表 on a phone);
//   openCat()   新建 → 新建猫猫: the same face, name, one optional line and the
//               tool, in a small dialog; 更多设置 hands over to the template
//               creator (cat-templates.js), unchanged;
//   openGroup() 新建 → 新建群聊: cats as face chips, an optional name whose
//               placeholder is the name the group gets without one.
// Requests: GET /xbot-api/start (重新检测 adds ?refresh=1), POST /xbot-api/bots
// {name, simple:{face, about?, agent}, idempotencyKey} and POST
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
  const faceIds = () => presets().map((p) => p.id);
  const portrait = (faceId) => (window.ClowderAvatars ? window.ClowderAvatars.createPortrait("cat:" + faceId) : node("span"));
  const media = (query) => !!(window.matchMedia && window.matchMedia(query).matches);
  const frame = () => new Promise((done) => (window.requestAnimationFrame ? window.requestAnimationFrame(() => done()) : setTimeout(done, 16)));
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

  // ---- the eight faces ----
  // One radio group: a click or tap picks a cat, arrow keys, Home and End move
  // the choice. The chosen cat steps forward onto its cushion; the others sit
  // back. With nothing chosen (still reading, or blocked) all eight sit back
  // and the row is only a picture.
  function lineup({ compact, onPick }) {
    const box = node("div", "qc-faces" + (compact ? " compact" : ""));
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", "选一只猫猫");
    let current = null, on = false;
    const items = presets().map((p) => {
      const b = node("button", "qc-face");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", p.label);
      b.dataset.face = p.id;
      const pic = node("span", "qc-portrait");
      pic.setAttribute("aria-hidden", "true");
      pic.append(portrait(p.id));
      b.append(pic);
      if (!compact) {
        const tag = node("span", "qc-face-name", p.label);
        tag.setAttribute("aria-hidden", "true");
        b.append(tag);
      }
      b.addEventListener("click", () => { if (on) choose(p.id); });
      b.addEventListener("keydown", (ev) => {
        const at = items.findIndex((it) => it.id === p.id), last = items.length - 1;
        const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: last }[ev.key];
        if (to === undefined || !on) return;
        ev.preventDefault();
        choose(items[(to + items.length) % items.length].id);
      });
      return { id: p.id, b, pic };
    });
    box.append(...items.map((it) => it.b));
    function paint() {
      const lead = items.find((it) => it.id === current) || items[0];
      for (const it of items) {
        it.b.setAttribute("aria-checked", String(it.id === current));
        it.b.disabled = !on;
        it.b.tabIndex = on && it === lead ? 0 : -1;
      }
      box.classList.toggle("rest", !current);
      if (current || on) box.removeAttribute("aria-hidden");
      else box.setAttribute("aria-hidden", "true");
    }
    function choose(id) {
      const it = items.find((x) => x.id === id);
      if (!it) return;
      current = id;
      paint();
      it.b.focus();
      onPick(id);
    }
    paint();
    return {
      element: box,
      get: () => current,
      set: (id) => { current = items.some((it) => it.id === id) ? id : null; paint(); },
      enable: (value) => { on = !!value; paint(); },
      picture: (id) => (items.find((it) => it.id === id) || {}).pic || null,
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

  // 「它会用这台电脑上的 X 来思考」: plain text with one tool, a quiet select
  // with more. A login that could not be checked is said, with its command.
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
        select.setAttribute("aria-label", "用哪个工具思考");
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

  // ---- 领一只猫猫：the face, the name, the tool and one action ----
  // Shared by the stage and the 新建猫猫 dialog. It reads /start itself and
  // shows what is in the way instead of a form that cannot work.
  // hold: where focus waits while a request is on its way (the dialog's card).
  function catFlow({ dialog, alive, hold, onBusy = () => {}, onState = () => {}, done }) {
    const h = hooks();
    // picked: the face the owner chose, kept apart from the row, which shows no
    // choice while something blocks creation and gets it back afterwards.
    let s = null, agent = null, faceTouched = false, picked = null, suggested = "", busy = false, attempt = null, loads = 0, refused = "", kind = "";
    const root = node(dialog ? "div" : "form", "qc-flow");
    root.tabIndex = -1;
    if (!dialog) {
      root.setAttribute("novalidate", "");
      root.addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
    }
    const faces = lineup({ compact: dialog, onPick: (id) => { faceTouched = true; picked = id; follow(id); } });

    const fields = node("div", "qc-fields");
    const nameBox = node("div", dialog ? "field qc-field" : "qc-namebox");
    const nameLab = node("label", dialog ? "" : "qc-label", "名字"), nameIn = node("input", dialog ? "" : "qc-input"), nameErr = node("p", "qc-err");
    // The real limit (64 characters) is the rules'; the box only stops a runaway paste.
    nameIn.type = "text"; nameIn.maxLength = R.NAME_INPUT_MAX; nameIn.autocomplete = "off"; nameIn.spellcheck = false;
    nameIn.id = uid("name"); nameLab.htmlFor = nameIn.id;
    nameErr.id = uid("name-err"); nameErr.setAttribute("role", "alert");
    nameIn.setAttribute("aria-describedby", nameErr.id);
    nameIn.addEventListener("input", () => { nameError(""); showError(""); });
    nameBox.append(nameLab, nameIn, nameErr);
    fields.append(nameBox);
    let aboutIn = null, aboutErr = null;
    if (dialog) {
      const box = node("div", "field qc-field"), lab = node("label", "");
      lab.append("它主要帮你做什么", node("span", "qc-opt", "可不填"));
      aboutIn = node("input", "");
      aboutIn.type = "text"; aboutIn.maxLength = R.ABOUT_INPUT_MAX; aboutIn.autocomplete = "off";
      aboutIn.placeholder = "比如：帮我改简历、陪我练口语";
      aboutIn.id = uid("about"); lab.htmlFor = aboutIn.id;
      aboutErr = node("p", "qc-err");
      aboutErr.id = uid("about-err"); aboutErr.setAttribute("role", "alert");
      aboutIn.setAttribute("aria-describedby", aboutErr.id);
      aboutIn.addEventListener("input", () => { aboutErr.textContent = ""; aboutIn.removeAttribute("aria-invalid"); showError(""); });
      box.append(lab, aboutIn, aboutErr);
      fields.append(box);
    }
    const tool = toolLine((id) => {
      agent = id;
      // An untouched face goes with the tool, as the first one did.
      if (!faceTouched) { const face = R.defaultFace(id, faceIds()); faces.set(face); follow(face); }
      tool.render(s, agent);
      showError("");
    });
    const error = node("p", "qc-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const go = node("button", dialog ? "primary" : "primary qc-go", dialog ? "创建" : "带它回家");
    go.type = "submit";
    if (dialog) fields.append(tool.element, error);
    else fields.append(go, error, tool.element);

    const wait = node("p", "qc-wait");
    wait.setAttribute("role", "status");
    const needBox = node("div", "qc-need");
    const laterBox = node("div", "qc-later");
    root.append(faces.element, wait, fields, needBox, laterBox);

    function show(next) {
      kind = next;
      wait.hidden = kind !== "loading" && kind !== "failed";
      fields.hidden = kind !== "ready";
      needBox.hidden = kind !== "blocked";
      laterBox.hidden = kind !== "later";
      go.hidden = kind !== "ready";
      faces.enable(kind === "ready");
      if (kind !== "ready") faces.set(null);
      onState(kind);
    }
    function showError(text) { error.textContent = text || ""; error.hidden = !text; }
    function nameError(text) {
      nameErr.textContent = text || "";
      if (text) nameIn.setAttribute("aria-invalid", "true"); else nameIn.removeAttribute("aria-invalid");
    }
    // The name box keeps the chosen face's nickname until the owner writes their own.
    function follow(face) {
      const next = R.suggestName(face, presets(), h.cats());
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
      if (how === "refused" && !fields.hidden) { showError(refused + "也没能重新读取这台电脑的情况，稍后再试。"); return; }
      show("failed");
      wait.replaceChildren(node("span", "", why + "。"), button("text-btn qc-retry", "重试", () => load("first")));
    }
    function apply(next, how) {
      const before = s, wasReady = !fields.hidden && !!(before && before.ready);
      s = next;
      if (!next.ready) {
        let note = "";
        if (how === "refresh") note = R.sameStart(before, next) ? R.need(next).unchanged : "检测结果有变化。";
        else if (how === "refused") note = refused;
        paintNeed(next, note);
        show("blocked");
        return;
      }
      if (!agent || !R.choiceOf(next, agent)) {
        const lost = wasReady && agent ? (R.choiceOf(before, agent) || {}).label : "";
        agent = next.agent.id;
        if (!faceTouched) { const face = R.defaultFace(agent, faceIds()); faces.set(face); follow(face); }
        if (lost) showError(lost + " 现在用不了，已经换成 " + next.agent.label + "。再点一次就好。");
      } else if (how === "refused") showError(refused);
      tool.render(next, agent);
      if (wasReady) return;
      // Back from blocked (or first time ready): the owner's own face if they picked one.
      const face = faceTouched && picked ? picked : R.defaultFace(agent, faceIds());
      show("ready");
      faces.set(face);
      follow(face);
      if (dialog || how === "refresh") focusName();
    }
    function paintNeed(next, note) {
      const copy = R.need(next), refocus = needBox.contains(document.activeElement);
      const cmds = node("div", "qc-cmds");
      for (const c of copy.commands) cmds.append(commandChip(c.command, copy.commands.length > 1 ? c.label : ""));
      cmds.hidden = !copy.commands.length;
      const label = node("span", "", "重新检测"), again = button("secondary qc-again");
      again.append(h.icon("refresh-cw"), label);
      const status = node("p", "qc-note", note);
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
      needBox.replaceChildren(node("h3", "", copy.title), node("p", "", copy.body), cmds, again, status);
      if (refocus) again.focus();
    }

    function setBusy(on) {
      busy = on;
      // A focused button that turns disabled would drop focus to the page:
      // hold it on the form until the answer says where it goes next.
      const here = document.activeElement, holder = hold || root;
      if (on && holder.contains(here) && here !== nameIn && here !== aboutIn) holder.focus();
      faces.enable(!on);
      // Read-only rather than disabled, so the caret and focus stay put.
      nameIn.readOnly = on;
      if (aboutIn) aboutIn.readOnly = on;
      tool.disable(on);
      go.disabled = on;
      go.textContent = on ? (dialog ? "正在创建…" : "正在带它回家…") : dialog ? "创建" : "带它回家";
      onBusy(on);
    }
    async function submit() {
      if (busy || !s || !s.ready || fields.hidden) return;
      const body = R.catBody({ name: nameIn.value, face: faces.get(), agent, about: aboutIn ? aboutIn.value : "" });
      const print = R.fingerprint(body);
      // The same request as one whose answer was lost goes back under its key
      // even when the refreshed list now knows the name: that cat may be this
      // request's own, and the server answers with it instead of a second one.
      const again = !!attempt && attempt.print === print;
      const problem = R.nameProblem(nameIn.value, again ? [] : h.cats());
      if (problem) { nameError(problem); nameIn.focus(); return; }
      const long = aboutIn ? R.aboutProblem(aboutIn.value) : "";
      if (long) { aboutErr.textContent = long; aboutIn.setAttribute("aria-invalid", "true"); aboutIn.focus(); return; }
      if (!again) attempt = { print, key: requestKey() };
      showError("");
      setBusy(true);
      let result;
      try { result = await h.api("/xbot-api/bots", { method: "POST", body: { ...body, idempotencyKey: attempt.key } }); }
      catch (err) {
        if (!alive()) return;
        setBusy(false);
        const what = R.catError(err, body.name, (R.choiceOf(s, agent) || {}).label);
        // A refused request made no cat: the next one is new, checked against the list again.
        if (what.kind !== "unsure") attempt = null;
        if (what.kind === "name") { nameError(what.text); nameIn.focus(); quietly(h.refresh); }
        else if (what.kind === "blocked") { refused = what.text; await load("refused"); }
        else { showError(what.text); go.focus(); if (what.kind === "unsure") quietly(h.refresh); }
        return;
      }
      if (!alive()) return;
      attempt = null;
      const name = (result && typeof result.name === "string" && result.name) || body.name;
      done({ name, face: body.simple.face, picture: faces.picture(body.simple.face) });
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
      // For cats arriving from elsewhere (release): a request in flight or a cat
      // already made here; and whether the owner has a draft (their own face or
      // name) or a request whose answer was lost.
      waiting: () => busy || kind === "later",
      kept: () => faceTouched || !R.followsFace(nameIn.value, suggested) || !!attempt,
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
    const sub = node("p", "qc-sub", "挑一只合眼缘的，给它起个名字。");
    const flow = catFlow({
      dialog: false,
      alive: () => root.isConnected,
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
  // when a list redraw replaced it meanwhile, to the 新建 button there now.
  let layer = null;
  function liveOpener(opener) {
    if (opener && opener.isConnected) return opener;
    const now = H && H.opener ? H.opener() : null;
    return now && now.isConnected ? now : null;
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
  function dialog(title, opener) {
    if (layer) layer.close(true);
    const root = node("div", "modal qc-modal"), card = node("form", "modal-card qc-card");
    card.setAttribute("novalidate", "");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.tabIndex = -1;
    const head = node("h2", "", title);
    head.id = uid("title");
    card.setAttribute("aria-labelledby", head.id);
    const body = node("div", "qc-body"), actions = node("div", "modal-actions");
    card.append(head, body, actions);
    root.append(card);
    document.body.append(root);
    let downOnRoot = false;
    const L = {
      card, body, actions, alive: true, busy: false,
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

  // 新建 → 新建猫猫.
  function openCat({ opener } = {}) {
    const h = hooks(), from = opener || document.activeElement;
    const L = dialog("新建猫猫", from);
    const more = button("text-btn qc-more", "更多设置", () => { if (L.busy) return; L.close(true); h.more(liveOpener(from) || from); });
    const cancel = button("secondary", "取消", () => L.close());
    const flow = catFlow({
      dialog: true,
      alive: () => L.alive,
      hold: L.card,
      onBusy: (on) => { L.busy = on; more.disabled = on; cancel.disabled = on; },
      done: ({ name, face, picture }) => {
        const going = arrive(name, face, picture); // takes the portrait's place before the dialog goes
        L.close(true);
        going.catch((err) => h.error(err));
      },
    });
    L.actions.append(more, cancel, flow.go);
    L.body.append(flow.element);
    L.card.addEventListener("submit", (ev) => { ev.preventDefault(); flow.submit(); });
    flow.start();
    return { close: () => L.close(true) };
  }

  // 新建 → 新建群聊: two to ten cats; the name is optional.
  function openGroup({ opener } = {}) {
    const h = hooks(), from = opener || document.activeElement;
    const L = dialog("新建群聊", from);
    const cats = h.cats();
    const cancel = button("secondary", "取消", () => L.close());
    if (cats.length < 2) {
      L.body.append(node("p", "qc-lead", cats.length ? "群聊至少要两只猫猫，现在只有 1 只。" : "群聊至少要两只猫猫，现在还一只都没有。"));
      const add = button("primary", "新建猫猫", () => { L.close(true); openCat({ opener: from }); });
      L.actions.append(cancel, add);
      add.focus();
      return { close: () => L.close(true) };
    }
    // Members in the order they were picked: the first sits in front of the group's face.
    const picked = [];
    // One key per request body (members in order, name): an unsure answer is
    // sent again unchanged under it and arrives at the same group.
    let busy = false, attempt = null;
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
    L.body.append(set, nameBox, error);
    L.actions.append(cancel, go);
    function showError(text) { error.textContent = text || ""; error.hidden = !text; }
    function sync() {
      const n = picked.length, full = n >= R.MAX_MEMBERS;
      for (const cb of boxes) cb.disabled = busy || (full && !cb.checked);
      hint.textContent = n < 2 ? (n ? "已选 1 只，再选 1 只" : "至少选 2 只") : full ? "已选 " + n + " 只，一个群最多 " + R.MAX_MEMBERS + " 只" : "已选 " + n + " 只";
      nameIn.placeholder = n >= 2 ? R.groupName(picked) : "不填就用成员的名字";
      go.disabled = busy || n < 2;
    }
    function setBusy(on) {
      busy = on;
      L.busy = on;
      // Focus on a control that turns disabled would drop to the page: hold it on the card.
      if (on && L.card.contains(document.activeElement) && document.activeElement !== nameIn) L.card.focus();
      cancel.disabled = on;
      nameIn.readOnly = on;
      go.textContent = on ? "正在创建…" : "创建";
      sync();
    }
    async function submit() {
      if (busy || picked.length < 2) return;
      const problem = R.groupNameProblem(nameIn.value);
      if (problem) { nameErr.textContent = problem; nameIn.setAttribute("aria-invalid", "true"); nameIn.focus(); return; }
      const body = R.groupBody(picked, nameIn.value), print = R.fingerprint(body);
      if (!attempt || attempt.print !== print) attempt = { print, key: requestKey() };
      showError("");
      setBusy(true);
      let group;
      try { group = await h.api("/xbot-api/groups", { method: "POST", body: { ...body, idempotencyKey: attempt.key } }); }
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
    L.card.addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
    sync();
    boxes[0].focus();
    return { close: () => L.close(true) };
  }

  window.ClowderQuickCreate = Object.freeze({
    init: (value) => { H = value; },
    stage, noChat, openCat, openGroup, release,
    close: () => { if (layer) layer.close(true); },
  });
})();
