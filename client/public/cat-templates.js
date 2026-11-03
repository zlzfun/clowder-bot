// 猫猫模板：设置 → 模板（平铺列表、搜索、新建、编辑、删除），以及左上 + → 新建猫猫。
// Data comes only from /xbot-api/cat-templates, /xbot-api/agents and
// /xbot-api/agents/:id/models; nothing is cached across pages and nothing
// falls back to sample data. Creating a cat sends its configuration and stops:
// the Agent runs under Clowder AI. Rules live in cat-template-rules.js.
(() => {
  "use strict";
  const R = window.ClowderCatTemplateRules;
  if (!R) throw new Error("cat-template-rules.js must load before cat-templates.js");

  const node = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ""; if (text != null) n.textContent = text; return n; };
  const button = (cls, text, click) => { const b = node("button", cls, text); b.type = "button"; if (click) b.addEventListener("click", click); return b; };
  const option = (value, text, disabled) => { const o = node("option", "", text); o.value = value; o.disabled = !!disabled; return o; };
  const chev = () => { const c = node("span", "skchev"); c.setAttribute("aria-hidden", "true"); return c; };
  const link = (text, click) => button("clearsrch ct-link", text, click);
  const enc = encodeURIComponent;
  const MANUAL = "__ct-manual__";
  const DENIED = [403, 405, 501];
  let seq = 0;
  const uid = (prefix) => "ct-" + prefix + "-" + ++seq;

  // The existing 3D cat portraits; a breed without one gets a plain circle.
  function face(breedId, size) {
    const box = node("span", "avatar" + (size ? " " + size : "") + " ct-face");
    box.setAttribute("aria-hidden", "true");
    const cats = window.ClowderAvatars, id = R.avatarOf(breedId);
    if (cats && id && cats.presets.some((p) => p.id === id)) box.append(cats.createPortrait("cat:" + id));
    else box.classList.add("ct-face-none");
    return box;
  }
  const faceIds = () => ((window.ClowderAvatars && window.ClowderAvatars.presets) || []).map((p) => p.id);
  // One key per request body: a retry of the same body cannot make a second
  // cat, a changed body is a new request. randomUUID needs a secure context.
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
  // Rows rebuild only when their content changed, so an open select keeps its place.
  function fill(select, options, value) {
    const key = options.map((o) => (o.disabled ? "!" : "") + o.value + "=" + o.textContent).join("\n");
    if (select._ctKey !== key) { select.replaceChildren(...options); select._ctKey = key; }
    select.value = value;
  }
  function trapTab(ev, card) {
    const all = card.querySelectorAll ? [...card.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")] : [];
    const live = all.filter((n) => !n.disabled && !n.hidden && n.tabIndex >= 0 && (!n.getClientRects || n.getClientRects().length));
    if (!live.length) return;
    const first = live[0], last = live[live.length - 1], here = document.activeElement;
    if (ev.shiftKey ? here === first || !live.includes(here) : here === last || !live.includes(here)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  }

  // ---- reads ----
  async function readCatalog(api) {
    const data = await api("/xbot-api/cat-templates");
    if (!data || !Array.isArray(data.templates)) throw new Error("unexpected answer");
    return {
      templates: data.templates.filter((t) => t && t.id).map(R.template),
      breeds: (Array.isArray(data.breeds) ? data.breeds : []).filter((b) => b && typeof b.id === "string" && b.id),
    };
  }
  async function readAgents(api) {
    const data = await api("/xbot-api/agents");
    return Array.isArray(data && data.agents) ? data.agents : [];
  }
  const catalogText = (err) => R.errorText(err, err && err.status === 404 ? "模板暂不可用" : "没能读取模板");
  const listCtx = (agents, breeds) => ({ agents, breeds });
  function rowBreed(t, ctx) {
    const agent = R.agentOf(ctx.agents, t.runtimeId);
    return R.resolveBreed(t, { breeds: ctx.breeds, defaultModel: agent ? agent.configuredModel : "" }).breedId;
  }
  // A flat row: portrait, name, one line of Agent and model.
  function templateRow(t, ctx, pick) {
    const row = button("skrow ct-row", "", pick), tx = node("span", "tx");
    tx.append(node("b", "", t.name || "未命名"), node("span", "hint", R.summary(t, ctx)));
    row.append(face(rowBreed(t, ctx)), tx, chev());
    return row;
  }

  // runtime-models answers for one editor. Each (Agent, model) pair is asked
  // once; answers are kept per Agent, so a late one for another Agent never
  // paints over the current choice.
  function modelBook(api) {
    const asked = new Map();
    const key = (rid, query) => rid + "\n" + query;
    function ask(rid, query, refresh) {
      const k = key(rid, query);
      if (asked.has(k) && !refresh) return asked.get(k);
      const hit = { rid, query, data: null, error: null, done: false, watched: false };
      const body = {};
      if (query) body.model = query;
      if (refresh) body.refresh = true;
      hit.promise = Promise.resolve()
        .then(() => api("/xbot-api/agents/" + enc(rid) + "/models", { method: "POST", body }))
        .then((data) => { if (data && typeof data === "object") hit.data = data; else hit.error = new Error("empty answer"); },
          (err) => { hit.error = err || new Error("failed"); })
        .then(() => { hit.done = true; });
      asked.set(k, hit);
      return hit;
    }
    const of = (rid) => [...asked.values()].filter((h) => h.rid === rid);
    return {
      ask,
      has: (rid, query) => asked.has(key(rid, query)),
      base: (rid) => asked.get(key(rid, "")) || null,
      answers: (rid) => of(rid).filter((h) => h.done && h.data).map((h) => ({ query: h.query, data: h.data })),
      pending: (rid) => of(rid).filter((h) => !h.done),
    };
  }

  // ---- the shared fields of a template and of a new cat ----
  // purpose "template": installed Agents may be named even before login.
  // purpose "create": only Agents that can run now. Works on a private copy.
  function configEditor({ api, purpose, initial, agents, breeds, alive, onChange = () => {}, manageAgents }) {
    let cfg = R.config(initial), list = Array.isArray(agents) ? agents : null, agentsFailed = !list, manual = false, effortNote = "";
    breeds = breeds || [];
    const book = modelBook(api), fields = {}, root = node("div", "ct-config");
    function field(key, label) {
      const box = node("div", "field ct-field"), lab = node("label", "", label), note = node("p", "ct-note"), err = node("p", "ct-err");
      note.setAttribute("aria-live", "polite");
      box.append(lab);
      return (fields[key] = { key, box, lab, note, err, control: null });
    }
    const bind = (f, control) => { if (!control.id) control.id = uid(f.key); f.lab.htmlFor = control.id; f.control = control; };
    const text = (tag, max) => { const n = node(tag, ""); if (tag === "input") n.type = "text"; n.maxLength = max; n.autocomplete = "off"; return n; };

    const agentF = field("agent", "Agent"), agentSel = node("select", "");
    bind(agentF, agentSel);
    agentF.box.append(agentSel, agentF.note, agentF.err);
    agentSel.addEventListener("change", () => {
      if (agentSel.value === (cfg.runtimeId || "")) return;
      cfg = R.changeAgent(cfg, agentSel.value);
      manual = false; effortNote = "";
      for (const k of ["agent", "model", "effort", "breed"]) clear(k);
      changed();
    });

    const modelF = field("model", "模型"), modelSel = node("select", ""), modelIn = text("input", 512);
    modelIn.spellcheck = false; modelIn.placeholder = "模型名称"; modelIn.setAttribute("aria-label", "模型名称");
    bind(modelF, modelSel);
    modelF.box.append(modelSel, modelIn, modelF.note, modelF.err);
    modelSel.addEventListener("change", () => {
      const value = modelSel.value;
      manual = value === MANUAL;
      if (manual) modelIn.value = "";
      cfg = { ...cfg, model: manual ? R.explicit("") : value ? R.explicit(value) : R.inherit() };
      effortNote = ""; clear("model"); clear("effort");
      changed();
      if (manual) modelIn.focus();
    });
    modelIn.addEventListener("input", () => { cfg = { ...cfg, model: R.explicit(modelIn.value) }; clear("model"); changed(false); });
    modelIn.addEventListener("change", () => changed());

    const effortF = field("effort", "推理强度"), effortSel = node("select", ""), effortIn = text("input", 32);
    effortIn.spellcheck = false;
    effortF.box.append(effortSel, effortIn, effortF.note, effortF.err);
    effortSel.addEventListener("change", () => {
      cfg = { ...cfg, effort: effortSel.value ? R.explicit(effortSel.value) : R.inherit() };
      effortNote = ""; clear("effort"); changed();
    });
    effortIn.addEventListener("input", () => {
      cfg = { ...cfg, effort: R.trim(effortIn.value) ? R.explicit(effortIn.value) : R.inherit() };
      effortNote = ""; clear("effort"); changed(false);
    });

    const breedF = field("breed", "猫种"), breedSel = node("select", "");
    bind(breedF, breedSel);
    breedF.box.append(breedSel, breedF.err);
    breedSel.addEventListener("change", () => {
      cfg = { ...cfg, breed: breedSel.value ? { mode: "explicit", breedId: breedSel.value } : { mode: "auto" } };
      clear("breed"); changed();
    });

    const grid = node("div", "ct-grid");
    grid.append(agentF.box, modelF.box, effortF.box, breedF.box);
    const PORTRAIT = [["roleDescription", "职责", "textarea", 32768], ["personality", "性格", "textarea", 32768], ["teamStrengths", "擅长", "input", 4096], ["caution", "提醒", "input", 4096]];
    const portraitControls = {};
    const portraitBoxes = PORTRAIT.map(([key, label, tag, max]) => {
      const f = field(key, label), ctl = text(tag, max);
      if (tag === "textarea") ctl.rows = key === "roleDescription" ? 3 : 2;
      ctl.value = typeof cfg.portrait[key] === "string" ? cfg.portrait[key] : "";
      bind(f, ctl);
      ctl.addEventListener("input", () => { cfg = { ...cfg, portrait: { ...cfg.portrait, [key]: ctl.value } }; clear(key); onChange(); });
      f.box.append(ctl, f.err);
      portraitControls[key] = ctl;
      return f.box;
    });
    root.append(grid, ...portraitBoxes);

    const agent = () => R.agentOf(list, cfg.runtimeId);
    const answers = () => (cfg.runtimeId ? book.answers(cfg.runtimeId) : []);
    const ctx = () => ({ agents: list, breeds, defaultModel: cfg.runtimeId ? R.defaultModel(answers(), agent()) : "" });
    function capability() {
      if (!cfg.runtimeId) return { state: "no_agent" };
      const cap = R.effortCapability(cfg, answers(), agent());
      return cap.state === "unknown" && book.pending(cfg.runtimeId).length ? { state: "loading" } : cap;
    }

    function changed(ask = true) { paint(ask); onChange(); }
    function paint(ask = true) {
      const cap = capability(), fixed = R.reconcileEffort(cfg, cap);
      if (fixed.cleared) { cfg = fixed.config; effortNote = fixed.cleared + " 不适用，已改为默认"; }
      paintAgent(); paintModel(); paintEffort(cap); paintBreed();
      if (ask) request();
    }
    function paintAgent() {
      const options = [];
      if (!cfg.runtimeId) options.push(option("", list ? "选择 Agent" : agentsFailed ? "—" : "正在读取…", true));
      for (const a of list || []) {
        const tag = R.agentTag(a);
        options.push(option(a.id, (a.label || a.id) + (tag ? " · " + tag : ""), !R.usable(a, purpose)));
      }
      if (cfg.runtimeId && !agent()) options.push(option(cfg.runtimeId, cfg.runtimeId + (list ? " · 不可用" : ""), true));
      fill(agentSel, options, cfg.runtimeId || "");
      agentSel.disabled = !list;
      agentF.note.replaceChildren();
      if (agentsFailed) agentF.note.append("没能读取本地 Agent ", link("重试", retryAgents));
      else if (list && purpose === "create" && !list.some(R.selectable)) {
        agentF.note.append("没有可用的 Agent");
        if (manageAgents) agentF.note.append(" · ", link("本地 Agent", manageAgents));
      }
    }
    function paintModel() {
      const rid = cfg.runtimeId, options = rid ? R.modelOptions(answers()) : [];
      const dm = ctx().defaultModel, own = cfg.model.mode === "explicit" ? R.trim(cfg.model.value) : "";
      const label = (value) => (options.find((m) => m.value === value) || { label: value }).label;
      const opts = [option("", dm ? "默认（" + label(dm) + "）" : "默认"), ...options.map((m) => option(m.value, m.label))];
      if (own && !manual && !options.some((m) => m.value === own)) opts.push(option(own, own));
      if (rid) opts.push(option(MANUAL, "其他…"));
      fill(modelSel, opts, manual ? MANUAL : own);
      modelSel.disabled = !rid;
      modelIn.hidden = !manual;
      if (manual && document.activeElement !== modelIn) modelIn.value = cfg.model.mode === "explicit" ? cfg.model.value : "";
      const base = rid ? book.base(rid) : null;
      modelF.note.replaceChildren();
      if (base && base.done && (base.error || base.data.status === "unavailable")) {
        modelF.note.append(base.error ? "没能读取模型 " : "无法读取模型列表 ", link("重试", () => { book.ask(rid, "", true); changed(); }));
      }
    }
    function paintEffort(cap) {
      const own = cfg.effort.mode === "explicit" ? R.trim(cfg.effort.value) : "";
      const de = cfg.runtimeId ? R.defaultEffort(answers(), agent()) : "";
      const deflt = de ? "默认（" + de + "）" : "默认";
      const typed = cap.state === "unknown";
      effortSel.hidden = typed; effortIn.hidden = !typed;
      bind(effortF, typed ? effortIn : effortSel);
      if (typed) {
        effortIn.placeholder = deflt;
        if (document.activeElement !== effortIn) effortIn.value = own;
      } else {
        let opts = [option("", "默认")];
        if (cap.state === "supported") opts = [option("", deflt), ...cap.values.map((v) => option(v.value, v.label))];
        else if (cap.state === "unsupported") opts = [option("", "不支持")];
        else if (cap.state === "loading") opts = [option("", own || deflt)];
        fill(effortSel, opts, cap.state === "supported" ? own : "");
        effortSel.disabled = cap.state !== "supported";
      }
      effortF.note.textContent = effortNote;
    }
    function paintBreed() {
      const auto = R.resolveBreed({ ...cfg, breed: { mode: "auto" } }, ctx());
      const own = cfg.breed.mode === "explicit" ? cfg.breed.breedId : "";
      const opts = [option("", auto.breedId ? "自动 · " + R.breedName(breeds, auto.breedId) : "自动"), ...breeds.map((b) => option(b.id, b.name || b.id))];
      if (own && !breeds.some((b) => b.id === own)) opts.push(option(own, own));
      fill(breedSel, opts, own);
    }
    // Ask native what is still unknown for the current Agent and model.
    function request() {
      const rid = cfg.runtimeId;
      if (!rid || !alive()) return;
      const hits = [book.ask(rid, "")];
      const own = cfg.model.mode === "explicit" ? R.trim(cfg.model.value) : "";
      const base = hits[0];
      if (own && base.done && base.data && base.data.status !== "unavailable" && !book.has(rid, own)
        && R.effortCapability(cfg, book.answers(rid), agent()).state === "unknown") hits.push(book.ask(rid, own));
      for (const hit of hits) {
        if (hit.done || hit.watched) continue;
        hit.watched = true;
        hit.promise.then(() => { if (alive()) changed(); });
      }
    }
    async function retryAgents() {
      agentsFailed = false; list = null; changed(false);
      try { const fresh = await readAgents(api); if (!alive()) return; list = fresh; }
      catch { if (!alive()) return; agentsFailed = true; }
      changed();
    }
    function clear(key) {
      const f = fields[key];
      if (!f) return;
      f.err.textContent = "";
      for (const c of [f.control, key === "model" ? modelIn : null, key === "effort" ? effortSel : null, key === "effort" ? effortIn : null]) if (c) c.removeAttribute("aria-invalid");
    }
    function showIssues(issues) {
      for (const issue of issues) {
        const f = fields[issue.field];
        if (!f) continue;
        f.err.textContent = issue.text;
        const target = issue.field === "model" && manual ? modelIn : f.control;
        if (target) target.setAttribute("aria-invalid", "true");
      }
    }
    function focus(key) {
      const f = fields[key];
      if (!f) return;
      const target = key === "model" && manual ? modelIn : f.control;
      if (!target) return;
      target.focus();
      if (target.scrollIntoView) target.scrollIntoView({ block: "nearest" });
    }
    // Before a save: commit typed values and wait for answers still on the way.
    async function settle() {
      changed();
      for (let round = 0; round < 3 && alive(); round++) {
        const waiting = cfg.runtimeId ? book.pending(cfg.runtimeId) : [];
        if (!waiting.length) return;
        await Promise.all(waiting.map((h) => h.promise));
        if (alive()) changed();
      }
    }
    function replace(next) {
      cfg = R.config(next); manual = false; effortNote = "";
      for (const [key, ctl] of Object.entries(portraitControls)) ctl.value = typeof cfg.portrait[key] === "string" ? cfg.portrait[key] : "";
      for (const k of Object.keys(fields)) clear(k);
      changed();
    }

    paint(true);
    return {
      element: root,
      get: () => R.config(cfg),
      cap: capability,
      breed: () => R.resolveBreed(cfg, ctx()),
      summary: () => R.summary(cfg, { agents: list }),
      issues: () => R.configIssues(cfg, { ...ctx(), purpose, cap: capability() }),
      showIssues, focus, settle, replace,
    };
  }

  // A small confirm card over the settings page (the persona-card layer).
  function nest(parent, title, actions, opener, onClose) {
    const layer = node("div", "nestlayer"), card = node("div", "nestcard");
    card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-label", title);
    const buttons = actions.map(([cls, label, act]) => button(cls, label, act));
    const bar = node("div", "nest-actions"), err = node("p", "sk-error");
    err.setAttribute("role", "alert"); err.hidden = true;
    bar.append(...buttons);
    card.append(node("h3", "", title), err, bar);
    layer.append(card);
    const L = {
      buttons, busy: false, closed: false,
      fail: (message) => { err.textContent = message || ""; err.hidden = !message; },
      close: (refocus = true) => {
        if (L.closed) return;
        L.closed = true; layer.remove();
        if (onClose) onClose();
        if (refocus && opener && opener.isConnected) opener.focus();
      },
    };
    layer.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (!L.busy) L.close(); }
      else if (ev.key === "Tab") { ev.stopPropagation(); trapTab(ev, card); }
    });
    parent.append(layer);
    buttons[buttons.length - 1].focus();
    return L;
  }

  // ---- 设置 → 模板 ----
  let unmountSettings = () => {};
  async function mount({ api, host, isCurrent = () => true, onLevel = () => {} }) {
    unmountSettings();
    let alive = true, nav = 0, layer = null, status = "", query = "", catalog = null, agents = null;
    const current = () => alive && isCurrent();
    const level = (value) => { if (current()) onLevel(value); };
    unmountSettings = () => { alive = false; nav++; if (layer) layer.close(false); layer = null; host.replaceChildren(); };
    host.className = "skills-settings persona-settings ct-settings";
    const body = node("div", "sk-body"), errorBox = node("p", "sk-error"), layers = node("div", "sk-layers");
    errorBox.setAttribute("role", "alert"); errorBox.hidden = true;
    host.replaceChildren(body, errorBox, layers);
    const fail = (message) => { errorBox.textContent = message || ""; errorBox.hidden = !message; };
    const heading = () => { const head = node("div", "sethd"); head.append(node("h2", "", "模板")); return head; };
    const upsert = (t) => { const i = catalog.templates.findIndex((x) => x.id === t.id); if (i < 0) catalog.templates.push(t); else catalog.templates[i] = t; };

    async function reload(quiet) {
      try { const fresh = await readCatalog(api); if (!current()) return false; catalog = fresh; return true; }
      catch (err) { if (current() && !quiet) fail(catalogText(err)); return false; }
    }
    async function start() {
      nav++; fail(""); level(null);
      const waiting = node("p", "sk-status", "正在读取…");
      waiting.setAttribute("role", "status");
      body.replaceChildren(heading(), waiting);
      const [cat, ag] = await Promise.allSettled([readCatalog(api), readAgents(api)]);
      if (!current()) return;
      agents = ag.status === "fulfilled" ? ag.value : null;
      if (cat.status === "fulfilled") { catalog = cat.value; showList(); return; }
      const again = button("btn", "重试", () => start());
      const line = node("p", "sk-error", catalogText(cat.reason));
      body.replaceChildren(heading(), line, again);
    }

    function showList() {
      nav++; fail(""); level(null);
      const line = node("p", "sk-status", status);
      line.setAttribute("role", "status"); line.hidden = !status;
      status = "";
      const ctx = listCtx(agents, catalog.breeds);
      if (!catalog.templates.length) {
        const empty = node("div", "skempty"), art = node("span", "skempty-art pc-art");
        art.setAttribute("aria-hidden", "true");
        empty.append(art, node("h3", "", "还没有模板"), button("btn pri", "新建模板", () => openEditor(null)));
        body.replaceChildren(heading(), line, empty);
        return;
      }
      const toolbar = node("div", "sktoolbar"), wrap = node("div", "sksearchwrap"), glyph = node("span", "sksic"), search = node("input", "sksearch");
      toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "模板列表工具");
      glyph.setAttribute("aria-hidden", "true");
      search.type = "search"; search.placeholder = "搜索模板"; search.autocomplete = "off"; search.value = query;
      search.setAttribute("aria-label", "搜索模板");
      wrap.append(glyph, search);
      const add = button("btn pc-add", "", () => openEditor(null)), plus = node("span", "pc-plus");
      add.setAttribute("aria-label", "新建模板"); add.title = "新建模板";
      plus.setAttribute("aria-hidden", "true"); add.append(plus);
      toolbar.append(wrap, add);
      const list = node("div", "sklist ct-list"), none = node("div", "sknone");
      none.setAttribute("aria-live", "polite");
      none.append(node("p", "", "没有匹配的模板"), button("clearsrch", "清除搜索", () => { query = ""; search.value = ""; paint(); search.focus(); }));
      function paint() {
        const rows = catalog.templates.filter((t) => R.matches(t, query, ctx));
        list.replaceChildren(...rows.map((t) => templateRow(t, ctx, () => openEditor(t))));
        list.hidden = !rows.length; none.hidden = !!rows.length;
      }
      search.addEventListener("input", () => { query = search.value; paint(); });
      paint();
      body.replaceChildren(heading(), line, toolbar, list, none);
    }

    // One template; a new one when `t` is null. `notice` reports a reload.
    function openEditor(t, notice) {
      fail("");
      const mine = ++nav, latest = () => current() && mine === nav;
      const data = t || R.template({ runtimeId: (R.preferredAgent(agents || []) || {}).id || null });
      let saving = false;
      const leave = () => { if (!saving) showList(); };
      const back = button("setback", "", leave);
      back.append(node("span", "skback-chev"), "模板");
      const head = node("div", "ct-head"), slot = node("span", "ct-face-slot"), name = node("input", "pc-name"), nameErr = node("p", "ct-err");
      name.type = "text"; name.maxLength = 60; name.autocomplete = "off"; name.value = data.name; name.placeholder = "模板名称";
      name.setAttribute("aria-label", "模板名称");
      head.append(slot, name);
      const hintF = node("div", "field ct-field"), hintLab = node("label", "", "默认名字"), hint = node("input", "");
      hint.type = "text"; hint.maxLength = 64; hint.autocomplete = "off"; hint.value = data.nameHint; hint.id = uid("hint");
      hintLab.htmlFor = hint.id;
      hintF.append(hintLab, hint);
      const editor = configEditor({ api, purpose: "template", initial: R.configOf(data), agents, breeds: catalog.breeds, alive: latest, onChange: () => paintFace() });
      const err = node("p", "sk-error");
      err.setAttribute("role", "alert");
      const showErr = (message) => { err.textContent = message || ""; err.hidden = !message; };
      showErr(notice);
      const foot = node("div", "pc-foot ct-foot"), save = button("btn pri", "保存", () => submit());
      if (data.id) { const del = button("btn pc-del", "删除", () => askDelete(del)); foot.append(del); }
      foot.append(node("span", "pc-gap"), save);
      const title = () => R.trim(name.value) || (data.id ? data.name : "新模板");
      name.addEventListener("input", () => { nameErr.textContent = ""; name.removeAttribute("aria-invalid"); if (latest()) level({ title: title(), backLabel: "模板", back: leave }); });
      level({ title: title(), backLabel: "模板", back: leave });
      body.replaceChildren(back, head, nameErr, hintF, editor.element, err, foot);
      paintFace();
      (data.id ? back : name).focus();
      function paintFace() { slot.replaceChildren(face(editor.breed().breedId, "pick")); }
      function busy(on) { saving = on; save.disabled = on; save.textContent = on ? "正在保存…" : "保存"; }

      async function submit() {
        if (saving || !latest()) return;
        showErr(""); busy(true);
        try { await editor.settle(); } catch { /* answers are optional */ }
        if (!latest()) return;
        const nameText = R.templateNameProblem(name.value), issues = editor.issues();
        if (nameText || issues.length) {
          busy(false);
          editor.showIssues(issues);
          if (nameText) { nameErr.textContent = nameText; name.setAttribute("aria-invalid", "true"); name.focus(); }
          else editor.focus(issues[0].field);
          return;
        }
        const payload = R.templateBody({ ...editor.get(), name: name.value, nameHint: hint.value }, editor.cap());
        let res;
        try {
          res = data.id
            ? await api("/xbot-api/cat-templates/" + enc(data.id), { method: "PUT", body: { ...payload, expectedRevision: data.revision } })
            : await api("/xbot-api/cat-templates", { method: "POST", body: payload });
        } catch (e) {
          if (!latest()) return;
          busy(false);
          if (e && e.status === 409 && data.id) { conflict(); return; }
          const status = e && e.status;
          showErr(R.errorText(e, DENIED.includes(status) ? "这个模板暂不支持修改" : status === 404 ? (data.id ? "没能保存：没有找到这个模板" : "没能保存：模板暂不可用") : "没能保存，请稍后再试"));
          return;
        }
        if (!latest()) return;
        const saved = res && res.template && res.template.id ? R.template(res.template) : null;
        if (saved) { upsert(saved); status = "已保存「" + saved.name + "」"; }
        await reload(true);
        if (latest()) { saving = false; showList(); }
      }
      // Changed elsewhere: show what is stored now instead of overwriting it.
      async function conflict() {
        try {
          const res = await api("/xbot-api/cat-templates/" + enc(data.id));
          if (!latest()) return;
          if (!res || !res.template) throw new Error("unexpected answer");
          const fresh = R.template(res.template);
          upsert(fresh);
          openEditor(fresh, "模板已在别处修改，已载入最新内容");
        } catch (e) {
          if (!latest()) return;
          if (e && e.status === 404) {
            catalog.templates = catalog.templates.filter((x) => x.id !== data.id);
            status = "没有找到这个模板";
            await reload(true);
            if (latest()) showList();
            return;
          }
          showErr("模板已在别处修改，没能读取最新内容");
        }
      }
      function askDelete(opener) {
        const L = nest(layers, "删除模板「" + (data.name || "未命名") + "」？", [["btn", "取消", () => L.close()], ["btn pri", "删除", () => remove(L)]], opener, () => { if (layer === L) layer = null; });
        layer = L;
      }
      async function remove(L) {
        if (L.busy || !latest()) return;
        L.busy = true; L.fail("");
        for (const b of L.buttons) b.disabled = true;
        try {
          await api("/xbot-api/cat-templates/" + enc(data.id), { method: "DELETE", body: { expectedRevision: data.revision } });
        } catch (e) {
          if (!latest() || L.closed) return;
          L.busy = false;
          for (const b of L.buttons) b.disabled = false;
          if (e && e.status === 409) { L.close(false); conflict(); return; }
          const status = e && e.status;
          L.fail(R.errorText(e, DENIED.includes(status) ? "这个模板暂不支持删除" : status === 404 ? "没能删除：没有找到这个模板" : "没能删除，请稍后再试"));
          return;
        }
        if (!latest()) return;
        L.busy = false; L.close(false);
        catalog.templates = catalog.templates.filter((x) => x.id !== data.id);
        status = "已删除「" + data.name + "」";
        await reload(true);
        if (latest()) showList();
      }
    }

    await start();
  }

  // ---- 新建猫猫：the original modal card, one at a time ----
  let createOpen = null;
  function openCreate(opts) {
    if (createOpen) { createOpen.focus(); return createOpen; }
    const { api, opener = document.activeElement, onCreated = () => {}, onError, manageAgents, names, templateId } = opts || {};
    const taken = () => { try { return (typeof names === "function" ? names() : names) || []; } catch { return []; } };
    let alive = true, saving = false, step = 0, data = null, chosen = null, editor = null, form = null, formSeq = 0, downOnRoot = false, attempt = null;

    const root = node("div", "modal ct-modal"), card = node("form", "modal-card ct-card");
    card.setAttribute("novalidate", ""); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true");
    card.tabIndex = -1;
    const title = node("h2", "", "新建猫猫");
    title.id = uid("title"); card.setAttribute("aria-labelledby", title.id);
    const box = node("fieldset", "ct-body"), error = node("p", "error"), actions = node("div", "modal-actions");
    error.setAttribute("role", "alert"); error.hidden = true;
    const cancel = button("secondary", "取消", () => { if (!saving) close(); });
    const ok = node("button", "primary", "创建");
    ok.type = "submit"; ok.hidden = true;
    actions.append(cancel, ok);
    card.append(title, box, error, actions);
    root.append(card);
    document.body.append(root);

    // Escape, Tab and every other key stay inside this layer.
    root.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); if (!saving) close(); }
      else if (ev.key === "Tab") trapTab(ev, card);
      ev.stopPropagation();
    });
    root.addEventListener("mousedown", (ev) => { downOnRoot = ev.target === root; });
    root.addEventListener("click", (ev) => { if (ev.target === root && downOnRoot && !saving) close(); downOnRoot = false; });
    card.addEventListener("submit", (ev) => { ev.preventDefault(); if (step === 2) submit(); });

    const showError = (message) => { error.textContent = message || ""; error.hidden = !message; };
    function close(force) {
      if (!alive || (saving && !force)) return;
      alive = false; formSeq++;
      root.remove();
      if (createOpen === handle) createOpen = null;
      if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
    }
    const handle = { element: root, close: (force) => close(force !== false), focus: () => { if (alive) (form ? form.nameIn : card).focus(); } };
    createOpen = handle;

    async function start() {
      step = 0; ok.hidden = true; showError("");
      const waiting = node("p", "ct-wait", "正在读取…");
      waiting.setAttribute("role", "status");
      box.replaceChildren(waiting);
      card.focus();
      const [cat, ag] = await Promise.allSettled([readCatalog(api), readAgents(api)]);
      if (!alive) return;
      data = {
        templates: cat.status === "fulfilled" ? cat.value.templates : [],
        breeds: cat.status === "fulfilled" ? cat.value.breeds : [],
        templatesError: cat.status === "rejected" ? cat.reason || new Error("failed") : null,
        agents: ag.status === "fulfilled" ? ag.value : null,
      };
      const preset = templateId && data.templates.find((t) => t.id === templateId);
      if (preset) pickTemplate(preset, false); else showPicker();
    }

    // Step 1: every template flat, 从零开始 last.
    function showPicker() {
      step = 1; chosen = null; editor = null; form = null; formSeq++;
      ok.hidden = true; showError("");
      const parts = [], ctx = listCtx(data.agents, data.breeds);
      if (data.templatesError) {
        const line = node("p", "ct-note ct-fail");
        line.append(catalogText(data.templatesError) + " ", link("重试", () => start()));
        parts.push(line);
      }
      const list = node("div", "sklist ct-pick");
      const scratch = button("skrow ct-scratch", "", () => pickScratch()), plus = node("span", "ct-plus"), tx = node("span", "tx");
      plus.setAttribute("aria-hidden", "true");
      tx.append(node("b", "", "从零开始"));
      scratch.append(plus, tx, chev());
      let rows = [];
      const paint = (query) => {
        rows = data.templates.filter((t) => R.matches(t, query, ctx)).map((t) => templateRow(t, ctx, () => pickTemplate(t, true)));
        list.replaceChildren(...rows, scratch);
      };
      if (data.templates.length > 8) {
        const wrap = node("div", "sksearchwrap ct-search"), glyph = node("span", "sksic"), search = node("input", "sksearch");
        glyph.setAttribute("aria-hidden", "true");
        search.type = "search"; search.placeholder = "搜索模板"; search.autocomplete = "off"; search.setAttribute("aria-label", "搜索模板");
        search.addEventListener("input", () => paint(search.value));
        wrap.append(glyph, search);
        parts.push(wrap);
      }
      paint("");
      parts.push(list);
      box.replaceChildren(...parts);
      (rows[0] || scratch).focus();
    }
    function pickTemplate(t, back) {
      chosen = { template: t, baseline: R.configOf(t) };
      showForm(back, false);
    }
    function pickScratch() {
      const preferred = R.preferredAgent(data.agents || []);
      chosen = { template: null, baseline: R.config({ runtimeId: preferred ? preferred.id : null }) };
      showForm(true, true);
    }

    // Step 2: the name, then the configuration — folded for a template, open from scratch.
    function showForm(back, open) {
      step = 2; showError("");
      const mine = ++formSeq, t = chosen.template, parts = [];
      if (back) {
        const b = button("setback ct-back", "", () => { if (!saving) showPicker(); });
        b.append(node("span", "skback-chev"), "模板");
        parts.push(b);
      }
      const who = node("div", "ct-who"), slot = node("span", "ct-face-slot");
      const nameF = node("div", "field ct-field"), nameLab = node("label", "", "名字"), nameIn = node("input", ""), nameErr = node("p", "ct-err");
      nameIn.type = "text"; nameIn.maxLength = 64; nameIn.autocomplete = "off"; nameIn.id = uid("name");
      nameLab.htmlFor = nameIn.id;
      nameIn.value = t ? R.freeName(t.nameHint, taken()) : "";
      nameIn.addEventListener("input", () => { nameErr.textContent = ""; nameIn.removeAttribute("aria-invalid"); sync(); });
      nameF.append(nameLab, nameIn, nameErr);
      who.append(slot, nameF);
      parts.push(who);
      const current = () => alive && mine === formSeq;
      const ed = configEditor({
        api, purpose: "create", initial: chosen.baseline, agents: data.agents, breeds: data.breeds, alive: current,
        onChange: () => update(),
        manageAgents: manageAgents ? () => { close(true); manageAgents(); } : null,
      });
      editor = ed;
      const custom = node("div", "ct-custom");
      custom.id = uid("custom");
      custom.append(ed.element);
      let more = null;
      if (t) {
        more = button("ct-more", "", () => setExpanded(custom.hidden));
        more.setAttribute("aria-controls", custom.id);
        parts.push(more);
      }
      parts.push(custom);
      box.replaceChildren(...parts);
      ok.hidden = false;
      function setExpanded(on) { custom.hidden = !on; if (more) more.setAttribute("aria-expanded", String(on)); }
      function update() {
        if (!current()) return;
        slot.replaceChildren(face(ed.breed().breedId, "xl"));
        if (more) more.replaceChildren(node("span", "ct-more-title", "自定义配置"), node("span", "ct-more-meta", ed.summary()), chev());
        sync();
      }
      form = { nameIn, nameErr, setExpanded };
      setExpanded(open);
      update();
      nameIn.focus();
    }
    function sync() {
      ok.textContent = saving ? "正在创建…" : "创建";
      ok.disabled = saving || !form || !R.trim(form.nameIn.value);
    }
    function busy(on) {
      saving = on;
      box.disabled = on; cancel.disabled = on;
      sync();
      if (on) card.focus();
    }

    async function submit() {
      if (saving || step !== 2 || !editor || !form) return;
      const ed = editor, f = form;
      showError(""); busy(true);
      try { await ed.settle(); } catch { /* answers are optional */ }
      if (!alive || editor !== ed) { saving = false; return; }
      const nameText = R.catNameProblem(f.nameIn.value, taken()), issues = ed.issues();
      if (nameText || issues.length) {
        busy(false);
        if (issues.length) { f.setExpanded(true); ed.showIssues(issues); }
        if (nameText) { f.nameErr.textContent = nameText; f.nameIn.setAttribute("aria-invalid", "true"); f.nameIn.focus(); }
        else ed.focus(issues[0].field);
        return;
      }
      const t = chosen.template;
      const body = R.createBody({ name: f.nameIn.value, cfg: ed.get(), cap: ed.cap(), source: t ? { id: t.id, revision: t.revision } : null, breedId: ed.breed().breedId, faces: faceIds() });
      const print = R.fingerprint(body);
      if (!attempt || attempt.print !== print) attempt = { print, key: requestKey() };
      body.idempotencyKey = attempt.key;
      let result;
      try { result = await api("/xbot-api/bots", { method: "POST", body }); }
      catch (err) {
        if (!alive) { saving = false; return; }
        busy(false);
        const conflict = err && err.status === 409;
        showError(R.errorText(err, conflict ? (t ? "模板刚有改动，已重新读取，请确认后再创建" : "没能创建：配置有冲突，请检查后再试") : "没能创建，请稍后再试"));
        if (conflict && t) refreshTemplate(t, ed);
        ok.focus();
        return;
      }
      saving = false;
      close(true);
      const created = { name: (result && result.name) || body.name, native_id: (result && result.native_id) || null };
      try { await onCreated(created); } catch (err) { if (onError) onError(err); }
    }
    // The template moved on: take its current revision; keep the user's own edits.
    async function refreshTemplate(t, ed) {
      try {
        const res = await api("/xbot-api/cat-templates/" + enc(t.id));
        if (!alive || editor !== ed || !res || !res.template) return;
        const fresh = R.template(res.template), untouched = R.sameConfig(ed.get(), chosen.baseline);
        chosen = { template: fresh, baseline: R.configOf(fresh) };
        const i = data.templates.findIndex((x) => x.id === fresh.id);
        if (i >= 0) data.templates[i] = fresh;
        if (untouched) ed.replace(chosen.baseline);
      } catch (err) {
        if (!alive || editor !== ed) return;
        if (err && err.status === 404) showError("模板已不存在，请返回重新选择");
      }
    }

    start();
    return handle;
  }

  // Detail rows for a cat's copied configuration; no provenance, no IDs.
  function renderSummary(config, ctx) {
    const list = node("dl", "agent-facts ct-facts");
    for (const [label, value] of R.describe(config, ctx)) list.append(node("dt", "", label), node("dd", "", value));
    return list;
  }

  window.ClowderCatTemplates = Object.freeze({
    mount,
    teardown: () => unmountSettings(),
    unmount: () => unmountSettings(),
    openCreate,
    closeCreate: () => { if (createOpen) createOpen.close(true); },
    renderSummary,
    describe: R.describe,
    rules: R,
  });
})();
