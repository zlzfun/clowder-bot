// 资料页与群 (classic script, window.ClowderProfile). The rules live in
// profile-rules.js; app.js passes its own helpers and the technical parts it
// already draws through init(). What it draws:
//
//   catHead() / groupHead()  the drawer's identity: the portrait (a cat's own
//                            colour as a quiet wash behind it), the name; a
//                            group's name is edited in place, with 「N 只猫猫」.
//   catPage()                资料: 职责, 置顶, 新对话 and 历史对话, then one
//                            folded 高级 (它用什么思考, 模型与画像, 任务与执行,
//                            导出对话 / 复制名字 / 运行面板), 删除猫猫 last.
//   groupPage()              成员: faces and names, 添加猫猫, 移出, how to talk
//                            in a group, a folded 高级 with 任务, 删除群聊.
//   groupMenu()              a sidebar group row's menu: 改名, 删除群聊.
//
// Each page is the same element for the same chat across the drawer's
// frequent repaints (an open fold, a confirm in progress and focus survive);
// another chat builds its own. Requests: PATCH /xbot-api/groups/:id
// {name} or {add} / {remove} (what the owner means, applied by the server to
// the roster as it is now) and DELETE /xbot-api/groups/:id (docs/xbot-api.md); 新对话
// opens chat-history.js's own dialog, the same one as the header's ⋯ menu. A
// change is shown only once the server has answered; nothing here stops work,
// routes messages or keeps a copy of the groups.
(() => {
  "use strict";
  const R = window.ClowderProfileRules;
  if (!R) throw new Error("profile-rules.js must load before profile.js");
  const enc = encodeURIComponent;

  let H = null;
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, click) => { const b = node("button", cls, text); b.type = "button"; if (click) b.addEventListener("click", click); return b; };
  const labelled = (cls, iconName, text, click) => { const b = button(cls, null, click); b.label = node("span", "", text); b.append(H.icon(iconName), b.label); return b; };
  let seq = 0;
  const uid = (prefix) => "pf-" + prefix + "-" + ++seq;
  const setText = (n, text) => { if (n.textContent !== text) n.textContent = text; };
  // Why a change did not stick, after a line that already says what did not happen (no second 没能完成：).
  const reason = (err) => H.visibleError(err).replace(/^没能完成：/, "");

  // cat/group: the page drawn for one chat; head: the drawer's identity;
  // advanced: which chats left 高级 open (by key, for this page's life).
  const S = { cat: null, group: null, head: null, advanced: new Set(), layer: null };

  // ------------------------------------------------------------ small parts
  // A status line under a section: what a request came to, in place.
  function say(line, text, bad) {
    line.textContent = text || "";
    line.hidden = !text;
    line.classList.toggle("bad", !!bad);
    line.setAttribute("role", bad ? "alert" : "status");
  }

  // The one folded 高级: a fold of the original task-details kind. Its body
  // is drawn the first time it opens and kept; open or closed is per chat.
  function advanced(key, build) {
    const box = node("details", "task-details pf-adv");
    const sum = node("summary");
    sum.append(node("span", "", "高级"), H.icon("chevron"));
    const body = node("div", "pf-adv-body");
    box.append(sum, body);
    const fold = { box, body, built: false, open: () => { if (!fold.built) { fold.built = true; build(body); } } };
    box.open = S.advanced.has(key);
    if (box.open) fold.open();
    box.addEventListener("toggle", () => {
      if (box.open) { S.advanced.add(key); fold.open(); } else S.advanced.delete(key);
    });
    return fold;
  }
  const subhead = (text, cls) => node("h4", "pf-sub" + (cls ? " " + cls : ""), text);

  // ------------------------------------------------------------ dialogs
  // One at a time, on the original .modal / .modal-card. Escape and Tab stay
  // inside (while a request is on its way and every button waits, Tab stays
  // on the card); the page behind is inert until it closes; closing returns
  // focus to whatever opened it — `opener` may be a function that finds it
  // again, for a sidebar row the list has drawn anew meanwhile.
  function trapTab(ev, card) {
    const live = [...card.querySelectorAll("button, input, select, textarea, a[href]")]
      .filter((n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && (!n.getClientRects || n.getClientRects().length));
    if (!live.length) { ev.preventDefault(); card.focus(); return; }
    const first = live[0], last = live[live.length - 1], here = document.activeElement;
    if (ev.shiftKey ? here === first || !live.includes(here) : here === last || !live.includes(here)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  }
  function dialog(title, opener) {
    if (S.layer) S.layer.close(true);
    const root = node("div", "modal pf-modal"), card = node("form", "modal-card pf-card");
    card.setAttribute("novalidate", "");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.tabIndex = -1;
    const head = node("h2", "", title);
    head.id = uid("title");
    card.setAttribute("aria-labelledby", head.id);
    const body = node("div", "pf-dialog-body"), error = node("p", "error"), actions = node("div", "modal-actions");
    error.setAttribute("role", "alert");
    error.hidden = true;
    card.append(head, body, error, actions);
    root.append(card);
    document.body.append(root);
    // Nothing behind the dialog can be reached while it is open.
    const quiet = [...document.body.children].filter((n) => n !== root && !n.inert);
    for (const n of quiet) n.inert = true;
    let downOnRoot = false;
    const L = {
      card, body, actions, alive: true, busy: false,
      error(text) { error.textContent = text || ""; error.hidden = !text; },
      close(force) {
        if (!L.alive || (L.busy && !force)) return;
        L.alive = false;
        root.remove();
        for (const n of quiet) n.inert = false;
        if (S.layer === L) S.layer = null;
        const found = typeof opener === "function" ? opener() : opener;
        const back = found && found.isConnected ? found : H.fallbackFocus && H.fallbackFocus();
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
    S.layer = L;
    card.focus();
    return L;
  }
  // Busy: the buttons wait, focus holds on the card instead of dropping to the page.
  function busy(L, on, buttons) {
    L.busy = on;
    if (on && L.card.contains(document.activeElement) && document.activeElement.tagName === "BUTTON") L.card.focus();
    for (const b of buttons) b.disabled = on;
  }
  // ------------------------------------------------------------ the drawer head
  // A cat: its portrait on a soft wash of its own colour (bots[].accent), its
  // name. Drawn again only when the face or the name changes.
  function catHead(sel, data) {
    const key = R.key(sel), name = (data && data.name) || sel.id;
    let P = S.head;
    if (!P || P.key !== key) {
      const root = node("div", "pf-head");
      const portrait = node("span", "pf-portrait"), tx = node("div", "tx"), title = node("b");
      tx.append(title);
      root.append(portrait, tx);
      P = S.head = { key, root, portrait, title, faceSig: null };
    }
    const sig = H.catFaceSig(name);
    if (P.faceSig !== sig) { P.faceSig = sig; P.portrait.replaceChildren(H.catFace(name, "lg")); }
    setText(P.title, name);
    const bot = H.cats().find((b) => b && b.name === name);
    const tint = R.accent(bot);
    P.root.classList.toggle("tinted", !!tint);
    if (tint) { P.root.style.setProperty("--pf-accent", tint.primary); P.root.style.setProperty("--pf-accent-2", tint.secondary); }
    else { P.root.style.removeProperty("--pf-accent"); P.root.style.removeProperty("--pf-accent-2"); }
    return P.root;
  }

  // A group: its members' face, the name (a click edits it in place: Enter
  // saves, Esc goes back, leaving saves a change) and 「N 只猫猫」.
  function groupHead(sel, group) {
    const key = R.key(sel);
    let P = S.head;
    if (!P || P.key !== key) {
      const root = node("div", "pf-head group");
      const portrait = node("span", "pf-portrait"), tx = node("div", "tx"), title = node("b", "pf-title");
      const name = button("pf-name", null, () => editName(P));
      const label = node("span", "pf-name-text");
      name.append(label, H.icon("pencil"));
      const sub = node("div", "sub pf-head-sub");
      title.append(name);
      tx.append(title, sub);
      root.append(portrait, tx);
      P = S.head = { key, sel, root, portrait, title, name, label, sub, faceSig: null, edit: null, group };
    }
    P.sel = sel;
    P.group = group;
    const sig = H.groupFaceSig(group);
    if (P.faceSig !== sig) { P.faceSig = sig; P.portrait.replaceChildren(H.groupFace(group, "lg")); }
    const shown = R.trim(group.name) || group.id;
    setText(P.label, shown);
    P.name.setAttribute("aria-label", "改群名：" + shown);
    P.name.dataset.tip = "改群名";
    if (!P.edit) paintGroupSub(P);
    return P.root;
  }
  function paintGroupSub(P) {
    P.sub.classList.remove("bad");
    P.sub.removeAttribute("role");
    setText(P.sub, R.countText(R.known(P.group, H.cats()).length));
  }
  function editName(P) {
    if (!P || P.edit || S.head !== P) return;
    const group = P.group, input = node("input", "pf-name-input");
    input.type = "text";
    input.maxLength = 64;
    input.autocomplete = "off";
    input.value = R.trim(group.name);
    input.placeholder = R.defaultName(group, H.cats());
    input.setAttribute("aria-label", "群名");
    input.setAttribute("aria-describedby", P.sub.id || (P.sub.id = uid("name-sub")));
    const E = P.edit = { input, busy: false, done: false };
    P.title.replaceChildren(input);
    setText(P.sub, "回车保存，Esc 取消");
    const finish = (refocus) => {
      if (E.done) return;
      E.done = true;
      P.edit = null;
      P.title.replaceChildren(P.name);
      paintGroupSub(P);
      if (refocus) P.name.focus({ preventScroll: true });
    };
    // byKey: Enter (focus stays with the name); otherwise the field was left
    // (Tab, a click elsewhere) and focus goes where the owner sent it.
    const save = async (byKey) => {
      if (E.busy || E.done) return;
      const value = input.value;
      if (R.trim(value) === R.trim(group.name)) { finish(byKey); return; }
      const problem = R.nameProblem(value);
      if (problem) { sayHead(P, problem); if (byKey) input.focus(); return; }
      E.busy = true;
      input.readOnly = true;
      setText(P.sub, "正在保存…");
      let answer;
      try {
        answer = await H.api("/xbot-api/groups/" + enc(group.id), { method: "PATCH", body: R.renameBody(value, group, H.cats()) });
      } catch (err) {
        E.busy = false;
        input.readOnly = false;
        if (E.done) return;
        sayHead(P, R.groupError(err, "rename").text);
        if (byKey && document.activeElement !== input) input.focus();
        return;
      }
      E.busy = false;
      const back = document.activeElement === input;
      const record = R.groupFrom(answer, group.id);
      if (record && S.head === P) P.group = record;
      finish(back);
      if (record && S.head === P) groupHead(P.sel, record);
      await H.groupChanged(group.id, record);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === "Enter") { ev.preventDefault(); save(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (!E.busy) finish(true); }
    });
    input.addEventListener("input", () => {
      if (E.busy) return;
      setText(P.sub, "回车保存，Esc 取消");
      P.sub.classList.remove("bad");
      P.sub.removeAttribute("role");
    });
    input.addEventListener("blur", () => { if (!E.busy && !E.done) save(false); });
    input.focus();
    if (input.select) input.select();
  }
  function sayHead(P, text) {
    P.sub.textContent = text;
    P.sub.classList.add("bad");
    P.sub.setAttribute("role", "alert");
  }
  // 改群名 from the drawer's action row: the same edit in place.
  function renameHere() { if (S.head && S.head.group && !S.head.edit) editName(S.head); }

  // The selection to act for: the shell's current one when it is this chat.
  function current(P) {
    const now = H.selected ? H.selected() : null;
    return now && R.key(now) === P.key ? now : P.sel;
  }
  // A group's freshest record: the shell's list (replaced by every poll) or
  // what this page last drew.
  function latest(P) {
    const id = P.group && P.group.id;
    const found = id && H.groups ? (H.groups() || []).find((g) => g && g.id === id) : null;
    return found || P.group;
  }

  // ------------------------------------------------------------ 资料 (a cat)
  function catPage(sel, data) {
    const key = R.key(sel);
    let P = S.cat;
    if (!P || P.key !== key) P = S.cat = buildCat(sel, key);
    // The same chat may come back as a new selection (a 新对话, a history
    // switch reopen it): the page acts for the one the shell has now.
    P.sel = sel;
    paintCat(P, data || { name: sel.id });
    return P.root;
  }

  function buildCat(sel, key) {
    // What 置顶 is doing is the cat's (saving(key)), not this page's.
    const P = { sel, key, data: { name: sel.id }, agentSig: null, configSig: null, exec: null };
    const root = node("div", "pf-page pf-cat");
    root.dataset.key = key;

    // 职责: what the cat is for (edited in 编辑资料).
    const duty = node("section", "psec pf-duty");
    const dutyText = node("p", "pf-duty-text"), dutyNone = node("p", "pf-weak");
    dutyNone.append(node("span", "", "还没写它负责什么。"), button("text-btn pf-link", "编辑资料", (ev) => H.editProfile(P.data, ev.currentTarget)));
    duty.append(node("h4", "", "职责"), dutyText, dutyNone);

    // 置顶: a switch row; the whole row is its label.
    const pin = node("div", "pf-row pf-pin");
    const pinCopy = node("span", "pf-row-copy");
    const pinTitle = node("span", "pf-row-title", "置顶");
    pinTitle.id = uid("pin");
    const pinHint = node("span", "pf-row-hint", "放在列表最上面");
    pinCopy.append(pinTitle, pinHint);
    const pinSwitch = button("g7-switch pf-switch", null, () => togglePin(P));
    pinSwitch.setAttribute("role", "switch");
    pinSwitch.setAttribute("aria-labelledby", pinTitle.id);
    pin.append(pinCopy, pinSwitch);
    pin.addEventListener("click", (ev) => { if (!pinSwitch.contains(ev.target)) pinSwitch.click(); });
    const pinLine = node("p", "pf-line");
    pinLine.hidden = true;

    // 对话: start a new one (chat-history.js's 新对话 dialog, which asks the
    // server and says why it cannot while the cat is busy), or open a saved
    // one (workspace.js's 历史对话).
    const convs = node("section", "psec pf-convs");
    const fresh = labelled("secondary pf-new", "plus", "新对话", (ev) => H.newConversation(current(P), ev.currentTarget));
    fresh.setAttribute("aria-haspopup", "dialog");
    const note = node("p", "pf-note", R.NEW_CHAT_NOTE);
    const slot = node("div", "pf-convs-slot");
    convs.append(node("h4", "", "对话"), fresh, note, slot);

    // 高级: what is technical, as it was in 详情 and 任务.
    const fold = advanced(key, (body) => buildCatAdvanced(P, body));
    const foot = node("div", "pf-foot");
    const remove = button("text-btn danger pf-remove", "删除猫猫", () => H.deleteCat(P.data.name || sel.id));
    foot.append(remove);

    root.append(duty, pin, pinLine, convs, node("div", "pf-rule"), fold.box, foot);
    Object.assign(P, { root, duty, dutyText, dutyNone, pinSwitch, pinHint, pinLine, fresh, slot, fold, remove });
    return P;
  }

  function buildCatAdvanced(P, body) {
    const agent = node("section", "psec pf-agent"), agentSlot = node("div");
    agent.append(subhead("它用什么思考"), agentSlot);
    const config = node("section", "pf-config");
    const work = node("section", "psec pf-work"), tasksSlot = node("div"), execSlot = node("div");
    work.append(tasksSlot, node("h4", "ws-exec-head", "执行"), execSlot);
    const acts = node("div", "pf-actions");
    const exp = labelled("secondary pf-act", "download", "导出对话", () => H.exportChat(P.data.name || P.sel.id));
    const copy = labelled("secondary pf-act", "clipboard", "复制名字", () => H.copyId(P.data.name || P.sel.id));
    const runtime = node("a", "secondary pf-act");
    runtime.target = "_blank";
    runtime.rel = "noopener";
    runtime.append(H.icon("link"), node("span", "", "在运行面板查看"));
    acts.append(exp, copy, runtime);
    body.append(agent, config, work, acts);
    Object.assign(P, { agentSlot, config, tasksSlot, execSlot, runtime });
    paintCatAdvanced(P);
  }

  function paintCat(P, data) {
    P.data = data;
    const name = data.name || P.sel.id;
    // 职责 once the profile has been read; until then the section waits.
    const read = Object.prototype.hasOwnProperty.call(data, "persona");
    const persona = R.trim(data.persona);
    P.duty.hidden = !read;
    P.dutyText.hidden = !persona;
    P.dutyNone.hidden = !!persona;
    setText(P.dutyText, persona);
    paintPin(P);
    // 历史对话 is workspace.js's node (the same one while the conversation is the same).
    const convs = H.conversations(P.sel);
    if (convs ? P.slot.firstChild !== convs || P.slot.childNodes.length !== 1 : P.slot.firstChild) P.slot.replaceChildren(...(convs ? [convs] : []));
    if (P.fold.built) paintCatAdvanced(P);
    P.remove.setAttribute("aria-label", "删除猫猫「" + name + "」");
  }

  function paintCatAdvanced(P) {
    if (!P.agentSlot) return;
    const data = P.data;
    const agent = H.agent(data);
    if (agent.sig !== P.agentSig) { P.agentSig = agent.sig; P.agentSlot.replaceChildren(agent.node()); }
    const config = H.config(data);
    if (config.sig !== P.configSig) {
      P.configSig = config.sig;
      const made = config.node();
      P.config.replaceChildren(...(made ? [made] : []));
      P.config.hidden = !made;
    }
    const tasks = H.tasks(P.sel);
    if (P.tasksSlot.firstChild !== tasks) P.tasksSlot.replaceChildren(tasks);
    const name = data.name || P.sel.id;
    if (!P.exec || P.exec.dataset.bot !== name) { P.exec = H.exec(data); P.execSlot.replaceChildren(P.exec); }
    else H.syncExec(P.exec, data);
    const href = H.runtimeHref(data);
    P.runtime.hidden = !href;
    if (href && P.runtime.getAttribute("href") !== href) P.runtime.setAttribute("href", href);
  }

  // What 置顶 is doing, by cat and apart from the drawer's page: another
  // cat's 资料 can be opened and this one's opened again (a new page) while a
  // change is on its way. The answer lands here, and whichever page shows
  // that cat then says it; a second request waits for the first.
  //   { busy, want, said: {text, bad} | null }
  const saves = new Map();
  function saving(key) {
    let st = saves.get(key);
    if (!st) saves.set(key, (st = { busy: false, want: false, said: null }));
    return st;
  }
  // The page shown for this cat now, if any (the one drawn last for it).
  const pageOf = (key) => (S.cat && S.cat.key === key ? S.cat : null);
  // A section's status line as its cat's state says (rewritten only when it changes).
  function sayAs(line, said) {
    const text = said ? said.text : "", bad = !!(said && said.bad);
    if (line.textContent !== text || line.classList.contains("bad") !== bad || line.hidden !== !text) say(line, text, bad);
  }

  // The switch says what the list says, and only that: while a change is on
  // its way it keeps the confirmed state, is busy and inert (not disabled, so
  // focus stays on it) and the line under 置顶 says what is being saved.
  function paintPin(P) {
    const st = saving(P.key), name = P.data.name || P.sel.id;
    const bot = H.cats().find((b) => b && b.name === name);
    const on = bot ? !!bot.pinned : !!P.data.pinned;
    P.pinSwitch.setAttribute("aria-checked", String(on));
    if (st.busy) { P.pinSwitch.setAttribute("aria-disabled", "true"); P.pinSwitch.setAttribute("aria-busy", "true"); }
    else { P.pinSwitch.removeAttribute("aria-disabled"); P.pinSwitch.removeAttribute("aria-busy"); }
    setText(P.pinHint, st.busy ? (st.want ? "正在置顶…" : "正在取消置顶…") : "放在列表最上面");
    sayAs(P.pinLine, st.said);
  }
  async function togglePin(P) {
    const key = P.key, st = saving(key);
    if (st.busy) return;
    const name = P.data.name || P.sel.id;
    const next = P.pinSwitch.getAttribute("aria-checked") !== "true";
    Object.assign(st, { busy: true, want: next, said: null });
    paintPin(P);
    try {
      await H.pin(name, next);
    } catch (err) {
      st.said = { text: (next ? "没能置顶：" : "没能取消置顶：") + reason(err), bad: true };
    }
    st.busy = false;
    const shown = pageOf(key);
    if (shown) paintPin(shown);
  }

  // ------------------------------------------------------------ 成员 (a group)
  function groupPage(sel, group) {
    const key = R.key(sel);
    let P = S.group;
    if (!P || P.key !== key) P = S.group = buildGroup(sel, key);
    P.sel = sel;
    P.group = group;
    paintGroupPage(P);
    return P.root;
  }

  function buildGroup(sel, key) {
    const P = { sel, key, group: null, busy: false, rows: new Map(), arm: null };
    const root = node("div", "pf-page pf-group");
    root.dataset.key = key;
    root.tabIndex = -1;
    const sec = node("section", "psec pf-members-sec");
    const head = node("div", "pf-sec-head");
    const count = node("h4", "", "成员");
    const add = labelled("text-btn pf-add", "plus", "添加猫猫", (ev) => openAdd(P, ev.currentTarget));
    head.append(count, add);
    const list = node("ul", "pf-members");
    list.setAttribute("aria-label", "成员");
    const line = node("p", "pf-line");
    line.hidden = true;
    sec.append(head, list, line);
    const hint = node("p", "pf-hint", R.HOW_TO_TALK);
    const fold = advanced(key, (body) => {
      const work = node("section", "psec pf-work"), slot = node("div");
      work.append(slot);
      body.append(work);
      P.tasksSlot = slot;
      paintGroupAdvanced(P);
    });
    const foot = node("div", "pf-foot");
    const remove = button("text-btn danger pf-remove", "删除群聊", (ev) => removeGroup(P.group, ev.currentTarget));
    foot.append(remove);
    root.append(sec, hint, node("div", "pf-rule"), fold.box, foot);
    Object.assign(P, { root, count, add, list, line, fold, remove });
    return P;
  }

  function paintGroupPage(P) {
    const cats = H.cats(), group = P.group, members = R.members(group, cats);
    const known = members.filter((m) => m.known).length;
    setText(P.count, "成员 · " + known);
    const choices = R.addable(group, cats), room = R.room(group, cats);
    P.add.disabled = P.busy || !choices.length || !room;
    P.add.dataset.tip = !choices.length ? "所有猫猫都已经在群里了" : !room ? "一个群最多 " + R.MAX + " 只猫猫" : "";
    if (!P.add.dataset.tip) delete P.add.dataset.tip;
    // Rows are kept by name, so a repaint never drops focus or a pending 移出.
    const keep = new Set();
    let at = P.list.firstChild;
    for (const m of members) {
      keep.add(m.name);
      let row = P.rows.get(m.name);
      if (!row) { row = memberRow(P, m); P.rows.set(m.name, row); }
      paintMember(P, row, m);
      if (row.li !== at) P.list.insertBefore(row.li, at);
      at = row.li.nextSibling;
    }
    for (const [name, row] of P.rows) if (!keep.has(name)) { row.li.remove(); P.rows.delete(name); }
    if (P.fold.built) paintGroupAdvanced(P);
    P.remove.setAttribute("aria-label", "删除群聊「" + (R.trim(group.name) || group.id) + "」");
  }
  function paintGroupAdvanced(P) {
    if (!P.tasksSlot) return;
    const tasks = H.tasks(P.sel);
    if (P.tasksSlot.firstChild !== tasks) P.tasksSlot.replaceChildren(tasks);
  }

  function memberRow(P, m) {
    const li = node("li", "pf-member"), face = node("span", "pf-member-face"), name = node("span", "pf-member-name");
    const out = button("ghost pf-out", null, () => removeMember(P, m.name, out));
    const word = node("span", "pf-out-text", "移出");
    out.append(H.icon("x"), word);
    li.append(face, name, out);
    return { li, face, name, out, word, faceSig: null };
  }
  function paintMember(P, row, m) {
    const sig = m.known ? H.catFaceSig(m.name) : "unknown";
    if (row.faceSig !== sig) { row.faceSig = sig; row.face.replaceChildren(m.known ? H.catFace(m.name, "") : H.unknownFace()); }
    setText(row.name, m.known ? m.name : "已不在的猫猫");
    row.li.classList.toggle("gone", !m.known);
    const can = m.known && R.canRemove(P.group, H.cats(), m.name);
    row.out.hidden = !can;
    row.out.disabled = P.busy;
    const armed = P.arm && P.arm.name === m.name;
    row.out.classList.toggle("armed", !!armed);
    row.out.setAttribute("aria-label", armed ? "再点一次，把「" + m.name + "」移出群聊" : "把「" + m.name + "」移出群聊");
    row.out.dataset.tip = armed ? "再点一次移出" : "移出群聊";
    row.word.hidden = !armed;
  }

  // 移出: a second click within three seconds confirms, as stopping a task does.
  async function removeMember(P, name, btn) {
    if (P.busy) return;
    if (!P.arm || P.arm.name !== name) {
      if (P.arm) clearTimeout(P.arm.timer);
      P.arm = { name, timer: setTimeout(() => { P.arm = null; if (S.group === P) paintGroupPage(P); }, 3000) };
      paintGroupPage(P);
      return;
    }
    clearTimeout(P.arm.timer);
    P.arm = null;
    await changeMembers(P, R.removeBody(name), "已把「" + name + "」移出群聊。", btn);
  }

  // A members change says what the owner means ({remove: [name]}); the server
  // applies it to the roster as it is now and answers with the group, which
  // the page then shows (and hands to the shell for the list and header).
  async function changeMembers(P, body, done, focusBack) {
    const group = latest(P);
    P.busy = true;
    say(P.line, "");
    // The pressed control turns disabled: hold focus on the page meanwhile.
    if (focusBack && focusBack === document.activeElement) P.root.focus({ preventScroll: true });
    paintGroupPage(P);
    let ok = true, record = null;
    try {
      record = R.groupFrom(await H.api("/xbot-api/groups/" + enc(group.id), { method: "PATCH", body }), group.id);
    } catch (err) {
      ok = false;
      const what = R.groupError(err, "members");
      say(P.line, what.text, true);
      if (what.kind === "unsure" || what.kind === "gone") Promise.resolve(H.groupChanged(group.id)).catch(() => {});
    }
    P.busy = false;
    if (ok) {
      if (record && S.group === P) P.group = record;
      await H.groupChanged(group.id, record);
      if (S.group === P) say(P.line, done, false);
    }
    if (S.group === P) {
      paintGroupPage(P);
      if (document.activeElement === P.root || document.activeElement === document.body) P.add.focus({ preventScroll: true });
    }
    return ok;
  }

  // 添加猫猫: the cats not yet in the group, as face chips (the 新建群聊 look).
  function openAdd(P, opener) {
    const group = latest(P), cats = H.cats(), choices = R.addable(group, cats), room = R.room(group, cats);
    const L = dialog("添加猫猫", opener);
    const cancel = button("secondary", "取消", () => L.close());
    if (!choices.length || !room) {
      L.body.append(node("p", "pf-lead", !choices.length ? "所有猫猫都已经在这个群里了。" : "一个群最多 " + R.MAX + " 只猫猫，先移出一只再添加。"));
      cancel.textContent = "好";
      L.actions.append(cancel);
      cancel.focus();
      return;
    }
    const picked = [];
    const hint = node("p", "qc-hint");
    hint.id = uid("add-hint");
    hint.setAttribute("aria-live", "polite");
    const set = node("fieldset", "qc-members-set"), chips = node("div", "qc-members");
    set.append(node("legend", "qc-legend", "选要加进「" + (R.trim(group.name) || "群聊") + "」的猫猫"), chips, hint);
    const go = node("button", "primary", "添加");
    go.type = "submit";
    const boxes = choices.map((name) => {
      const chip = node("label", "qc-chip"), cb = node("input", "qc-sr");
      cb.type = "checkbox";
      cb.value = name;
      cb.setAttribute("aria-describedby", hint.id);
      chip.append(cb, H.catFace(name, ""), node("span", "qc-chip-name", name));
      cb.addEventListener("change", () => {
        const i = picked.indexOf(name);
        if (cb.checked && i < 0) picked.push(name);
        else if (!cb.checked && i >= 0) picked.splice(i, 1);
        L.error("");
        sync();
      });
      chips.append(chip);
      return cb;
    });
    function sync() {
      const full = picked.length >= room;
      for (const cb of boxes) cb.disabled = L.busy || (full && !cb.checked);
      hint.textContent = !picked.length ? "还能加 " + room + " 只" : full ? "已选 " + picked.length + " 只，群里满 " + R.MAX + " 只了" : "已选 " + picked.length + " 只";
      go.disabled = L.busy || !picked.length;
    }
    L.body.append(set);
    L.actions.append(cancel, go);
    L.card.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (L.busy || !picked.length) return;
      busy(L, true, [cancel, go]);
      sync();
      // Only who to add: the server adds them to the roster as it is now.
      let failed = null, record = null;
      try { record = R.groupFrom(await H.api("/xbot-api/groups/" + enc(group.id), { method: "PATCH", body: R.addBody(picked) }), group.id); }
      catch (err) { failed = R.groupError(err, "members"); }
      if (!L.alive) return;
      if (failed) {
        busy(L, false, [cancel, go]);
        sync();
        L.error(failed.text);
        if (failed.kind === "unsure" || failed.kind === "gone") Promise.resolve(H.groupChanged(group.id)).catch(() => {});
        go.focus();
        return;
      }
      L.busy = false;
      if (record && S.group === P) P.group = record;
      L.close(true);
      await H.groupChanged(group.id, record);
      if (S.group === P) { paintGroupPage(P); say(P.line, "已添加「" + picked.join("」「") + "」。", false); }
    });
    sync();
    boxes[0].focus();
  }

  // ------------------------------------------------------------ rename / delete
  // 改名 from the sidebar row's menu (the drawer edits in place).
  function renameGroup(group, opener) {
    const L = dialog("改群名", opener);
    const box = node("div", "field"), lab = node("label", "", "群名"), input = node("input", ""), err = node("p", "qc-err");
    input.type = "text";
    input.maxLength = 64;
    input.autocomplete = "off";
    input.value = R.trim(group.name);
    input.placeholder = R.defaultName(group, H.cats());
    input.id = uid("rename");
    lab.htmlFor = input.id;
    err.setAttribute("role", "alert");
    box.append(lab, input, err);
    L.body.append(box, node("p", "pf-dialog-hint", "不填就用成员的名字。"));
    const cancel = button("secondary", "取消", () => L.close());
    const go = node("button", "primary", "保存");
    go.type = "submit";
    L.actions.append(cancel, go);
    input.addEventListener("input", () => { err.textContent = ""; input.removeAttribute("aria-invalid"); L.error(""); });
    L.card.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (L.busy) return;
      if (R.trim(input.value) === R.trim(group.name)) { L.close(); return; }
      const problem = R.nameProblem(input.value);
      if (problem) { err.textContent = problem; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
      busy(L, true, [cancel, go]);
      input.readOnly = true;
      let record = null;
      try { record = R.groupFrom(await H.api("/xbot-api/groups/" + enc(group.id), { method: "PATCH", body: R.renameBody(input.value, group, H.cats()) }), group.id); }
      catch (e) {
        if (!L.alive) return;
        busy(L, false, [cancel, go]);
        input.readOnly = false;
        L.error(R.groupError(e, "rename").text);
        input.focus();
        return;
      }
      if (!L.alive) return;
      L.busy = false;
      L.close(true);
      await H.groupChanged(group.id, record);
    });
    input.focus();
    if (input.select) input.select();
  }

  // 删除群聊: the engine keeps what was said; the group leaves the list.
  function removeGroup(group, opener) {
    const name = R.trim(group.name) || "这个群聊";
    const L = dialog("删除群聊", opener);
    L.body.append(node("p", "pf-lead", "删除「" + name + "」？群里的聊天记录不会被抹掉，但这个群聊会从列表里消失，之后不能再在这里打开。猫猫们都还在。"));
    const cancel = button("secondary", "取消", () => L.close());
    const go = node("button", "secondary pf-danger", "删除群聊");
    go.type = "submit";
    L.actions.append(cancel, go);
    L.card.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (L.busy) return;
      busy(L, true, [cancel, go]);
      try { await H.api("/xbot-api/groups/" + enc(group.id), { method: "DELETE" }); }
      catch (e) {
        if (!L.alive) return;
        busy(L, false, [cancel, go]);
        const what = R.groupError(e, "delete");
        L.error(what.text);
        if (what.kind !== "form") Promise.resolve(H.groupChanged(group.id)).catch(() => {});
        go.focus();
        return;
      }
      if (!L.alive) return;
      L.busy = false;
      L.close(true);
      await H.groupDeleted(group.id);
    });
    cancel.focus();
  }

  // A sidebar group row's menu (the shell places it like a cat row's menu and
  // focuses its first item). ↑/↓/Home/End move, Enter or Space picks, Esc and
  // Tab close it; focus goes back to the group's row, found again by the
  // group's id if the list has drawn it anew meanwhile (so does a dialog the
  // menu opened, when it closes).
  function groupMenu(group) {
    const menu = node("div", "pop panel-more pf-group-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", R.trim(group.name) || "群聊");
    const row = () => (H.groupRow ? H.groupRow(group.id) : null);
    const back = () => { const r = row(); if (r && r.focus) r.focus({ preventScroll: true }); };
    const item = (iconName, text, run, danger) => {
      const b = button("menu-row" + (danger ? " danger" : ""));
      b.setAttribute("role", "menuitem");
      b.append(H.icon(iconName), node("span", "", text));
      b.addEventListener("click", (ev) => { ev.stopPropagation(); H.closePops(); run(row); });
      menu.append(b);
    };
    item("pencil", "改名", (opener) => renameGroup(group, opener));
    menu.append(node("div", "mgap"));
    item("trash", "删除群聊", (opener) => removeGroup(group, opener), true);
    menu.addEventListener("keydown", (ev) => {
      const items = [...menu.children].filter((n) => n.tagName === "BUTTON");
      const at = items.indexOf(document.activeElement);
      const to = { ArrowDown: at + 1, ArrowUp: at < 0 ? items.length - 1 : at - 1, Home: 0, End: items.length - 1 }[ev.key];
      if (to !== undefined) {
        ev.preventDefault();
        items[(to + items.length) % items.length].focus();
      } else if (ev.key === "Escape" || ev.key === "Tab") {
        ev.preventDefault();
        H.closePops();
        back();
      } else return;
      ev.stopPropagation();
    });
    return menu;
  }

  window.ClowderProfile = Object.freeze({
    init: (hooks) => { H = hooks; },
    catHead, groupHead, catPage, groupPage, groupMenu, renameHere, renameGroup, removeGroup,
    // Whether a drawer node is the page this module keeps for the chat shown.
    current: (n, sel) => !!n && !!sel && ((S.cat && S.cat.root === n && S.cat.key === R.key(sel)) || (S.group && S.group.root === n && S.group.key === R.key(sel))),
    // Open 高级 for this chat (the old 任务 tab, the work row above the composer).
    reveal: (sel) => {
      const key = R.key(sel);
      S.advanced.add(key);
      for (const P of [S.cat, S.group]) if (P && P.key === key && !P.fold.box.open) { P.fold.box.open = true; P.fold.open(); }
    },
    close: () => { if (S.layer) S.layer.close(true); },
  });
})();
