// 猫猫模板交互样页：模板库、新建猫猫与样页猫猫。
// Review prototype only. It reads /template-lab/fixture.json and nothing else,
// keeps its state in this tab's sessionStorage under one namespaced key, never
// calls a clowder-bot or Clowder AI API, and writes all text via textContent.
(() => {
  "use strict";
  const M = window.ClowderTemplateModel, Avatars = window.ClowderAvatars;
  const KEY = "clowder-template-lab:v1", THEME_KEY = KEY + ":theme";
  const $ = (id) => document.getElementById(id);
  let seq = 0;
  const uid = (prefix) => prefix + "-" + Date.now().toString(36) + (++seq).toString(36);

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(cls, text, onClick) {
    const b = h("button", cls, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  const tag = (text) => h("span", "ws-tag", text);
  const chev = () => { const c = h("span", "skchev"); c.setAttribute("aria-hidden", "true"); return c; };
  const clip = (text, n) => { const s = String(text || "").trim(); return [...s].length > n ? [...s].slice(0, n).join("") + "…" : s; };
  const when = (ms) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  function portrait(breedId, size) {
    const breed = M.breedOf(breedId), span = h("span", "avatar" + (size ? " " + size : ""));
    span.setAttribute("aria-hidden", "true");
    if (!breed || !Avatars) { span.classList.add("tl-av-unknown"); span.textContent = "?"; return span; }
    span.append(Avatars.createPortrait("cat:" + breed.avatar, undefined, breed.label));
    return span;
  }

  // ---------- state ----------
  const app = { fixture: null, runtimes: [], seeds: [], nick: {}, templates: [], removed: [], cats: [], selected: null, flash: null };
  const runtimeOf = (id) => M.runtimeOf(app.runtimes, id);
  const templateOf = (id) => app.templates.find((t) => t.id === id) || null;
  const catsFrom = (id) => app.cats.filter((c) => c.source.kind === "template" && c.source.templateId === id);
  const carrierOf = (t) => (t && t.source ? t.source.carrier : null);
  const breedLabel = (id) => (M.breedOf(id) || { label: "猫种待定" }).label;
  const resolveOf = (config) => M.resolveBreed(config, runtimeOf(config.runtimeId));
  const commit = () => app.fixture.provenance.upstream.commit;

  function blankConfig() {
    const first = app.runtimes.find((r) => r.adapted && r.readiness === "configured") || app.runtimes.find((r) => r.adapted);
    return { runtimeId: first ? first.id : null, model: M.inherit(), effort: M.inherit(), breed: { mode: "auto" },
      portrait: { roleDescription: "", personality: "", teamStrengths: "", caution: "" }, strengths: [] };
  }
  // Same key and shape as the first sample; `seeded` and the cats' `demo`/`pinned` flags are additive.
  function persist() {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ v: 1, commit: commit(), templates: app.templates, removed: app.removed, cats: app.cats, selected: app.selected, seeded: true }));
    } catch (e) { /* memory only */ }
  }
  function restore() {
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (!s || s.v !== 1 || s.commit !== commit() || !Array.isArray(s.templates) || !Array.isArray(s.cats)) return false;
      app.templates = s.templates;
      app.removed = Array.isArray(s.removed) ? s.removed : [];
      app.cats = s.cats;
      app.selected = s.cats.some((c) => c.id === s.selected) ? s.selected : null;
      if (!s.seeded) seedDemoCats();
      return true;
    } catch (e) { return false; }
  }
  function freshState() { app.templates = M.clone(app.seeds); app.removed = []; app.cats = []; app.selected = null; seedDemoCats(); }
  // Three labelled demo identities made the same way as any new cat: a copy of a seed template's settings.
  function seedDemoCats() {
    const now = Date.now();
    for (const [id, name, pinned] of [["tpl-s01", "宪宪", true], ["tpl-s05", "砚砚", false], ["tpl-s19", "墨墨", false]]) {
      const template = templateOf(id) || app.seeds.find((s) => s.id === id);
      if (!template) continue;
      const cat = M.instantiate({ id: uid("cat"), name: M.freeName(name, app.cats.map((c) => c.name)), now, template, config: M.templateConfig(template), runtimes: app.runtimes });
      cat.demo = true; cat.pinned = pinned;
      app.cats.push(cat);
    }
    if (!app.selected && app.cats.length) app.selected = (app.cats.find((c) => c.pinned) || app.cats[0]).id;
  }

  // ---------- layers, focus and Escape ----------
  const stack = [];
  const focusables = (root) => [...root.querySelectorAll("button, input, select, textarea, summary, a[href], [tabindex]")]
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
  function pushSurface(s) { closeMenus(); stack.push(s); $("shell").inert = true; }
  function popSurface(s) { const i = stack.indexOf(s); if (i >= 0) stack.splice(i, 1); $("shell").inert = stack.length > 0; }
  document.addEventListener("keydown", (ev) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (ev.key === "Escape") { ev.preventDefault(); top.escape(); return; }
    if (ev.key !== "Tab") return;
    const list = focusables(top.root);
    if (!list.length) { ev.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1], here = document.activeElement;
    if (ev.shiftKey ? here === first || !top.root.contains(here) : here === last || !top.root.contains(here)) {
      ev.preventDefault();
      (ev.shiftKey ? last : first).focus();
    }
  });
  const refocus = (el) => { if (el && el.isConnected && el.getClientRects().length) el.focus(); };

  // A small confirm card over everything (the persona-card nest layer).
  function layer({ title, lead, actions, opener }) {
    const root = h("div", "nestlayer tl-layer"), card = h("div", "nestcard"), head = h("h3", "", title);
    head.id = uid("tl-layer");
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", head.id);
    card.append(head);
    for (const p of [].concat(lead || [])) card.append(h("p", "lead", p));
    const bar = h("div", "nest-actions"), L = {};
    const surface = { root: card, escape: () => L.close() };
    L.close = (keepFocus) => { if (!root.isConnected) return; root.remove(); popSurface(surface); if (!keepFocus) refocus(opener); };
    const buttons = actions.map(([cls, text, act]) => btn("btn" + (cls ? " " + cls : ""), text, () => act(L)));
    bar.append(...buttons);
    card.append(bar);
    root.append(card);
    root.addEventListener("mousedown", (ev) => { if (ev.target === root) L.close(); });
    $("tl-layers").append(root);
    pushSurface(surface);
    buttons[0].focus();
    return L;
  }

  // Radio rows: the checked one (or the first live one) takes Tab; arrows move and pick.
  function roving(group, rows, pick) {
    const sync = () => {
      const live = rows.filter((b) => !b.disabled), on = live.find((b) => b.getAttribute("aria-checked") === "true") || live[0];
      for (const b of rows) b.tabIndex = b === on ? 0 : -1;
    };
    group.addEventListener("keydown", (ev) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
      const live = rows.filter((b) => !b.disabled), i = live.indexOf(ev.target);
      if (!step || i < 0) return;
      ev.preventDefault();
      const next = live[(i + step + live.length) % live.length];
      next.focus();
      pick(next);
    });
    sync();
    return sync;
  }

  // The original segmented choice (.choice / .choice-opt) with native radios.
  function choice(options, onPick, labelledBy) {
    const el = h("div", "choice"), name = uid("tl-choice"), inputs = {};
    el.setAttribute("role", "radiogroup");
    if (labelledBy) el.setAttribute("aria-labelledby", labelledBy);
    for (const [value, text] of options) {
      const opt = h("label", "choice-opt"), input = h("input");
      input.type = "radio"; input.name = name; input.value = value;
      input.addEventListener("change", () => { if (input.checked) onPick(value); });
      opt.append(input, document.createTextNode(text));
      el.append(opt);
      inputs[value] = input;
    }
    return { el, set: (value) => { for (const [k, input] of Object.entries(inputs)) input.checked = k === value; }, focus: (value) => inputs[value] && inputs[value].focus() };
  }

  // ---------- theme ----------
  const media = matchMedia("(prefers-color-scheme: dark)");
  // The page's own choice (sessionStorage) wins; otherwise the app's saved theme is read, never written.
  function themeMode() {
    try {
      const own = sessionStorage.getItem(THEME_KEY);
      if (own === "light" || own === "dark" || own === "system") return own;
      const app = localStorage.getItem("xbot-theme");
      return app === "light" || app === "dark" ? app : "system";
    } catch (e) { return "system"; }
  }
  function applyTheme() {
    const mode = themeMode(), theme = mode === "system" ? (media.matches ? "dark" : "light") : mode;
    document.documentElement.setAttribute("data-theme", theme);
    $("theme-color").setAttribute("content", theme === "dark" ? "#201A17" : "#F0E5D6");
    $("settings-theme").value = mode;
  }

  // ---------- shared configuration editor ----------
  // Edits `draft` in place. purpose "template": every sample Agent, drafts allowed.
  // purpose "create": adapted Agents only; `baseline` marks per-field tuning.
  function configEditor({ draft, purpose, baseline, carrier, upstreamBreed, onChange }) {
    const isCreate = purpose === "create", fields = {}, root = h("div", "tl-config");
    const runtime = () => runtimeOf(draft.runtimeId);
    let lastModel = draft.model.mode === "explicit" ? draft.model.value : "", lastEffort = draft.effort.mode === "explicit" ? draft.effort.value : "";

    function fieldBox(key, label) {
      const box = h("div", "tl-field"), head = h("div", "tl-field-head"), lab = h("span", "tl-flabel", label);
      lab.id = uid("tl-label");
      box.dataset.field = key;
      head.append(lab);
      const f = { key, box, lab, body: h("div", "tl-fbody"), change: h("p", "tl-change"), err: h("p", "tl-ferr"), control: null };
      f.change.setAttribute("role", "status");
      if (baseline) {
        f.mark = tag("已微调"); f.mark.hidden = true;
        f.reset = btn("text-btn", "恢复模板值", () => resetField(key)); f.reset.hidden = true;
        head.append(f.mark, f.reset);
      }
      box.append(head, f.body, f.change, f.err);
      fields[key] = f;
      return f;
    }
    const sec = (title, ...nodes) => { const s = h("section", "tl-sec"); s.append(h("h4", "", title), ...nodes); return s; };

    // Agent
    const agentF = fieldBox("agent", "Agent");
    const group = h("div", "ws-list tl-agents"), rows = [];
    group.setAttribute("role", "radiogroup"); group.setAttribute("aria-labelledby", agentF.lab.id);
    let heading = null;
    for (const r of isCreate ? app.runtimes.filter((x) => x.adapted) : app.runtimes) {
      if (!isCreate) {
        const g = r.adapted ? "可以用来创建" : "尚未适配 · 只能保存在模板里";
        if (g !== heading) { group.append(h("div", "tl-agent-group", g)); heading = g; }
      }
      const row = btn("ws-provider", "", () => pickAgent(r.id)), name = h("span", "ws-name");
      row.setAttribute("role", "radio"); row._id = r.id;
      name.append(document.createTextNode(r.label), h("code", "", r.id));
      const meta = !r.adapted ? "尚未适配" : r.readiness === "configured" ? "示例 · 已有配置记录" : "示例 · 未确认登录";
      row.append(h("span", "ws-radio"), name, h("span", "ws-meta" + (r.adapted && r.readiness === "configured" ? " ok" : ""), meta));
      rows.push(row); group.append(row);
    }
    const syncAgents = roving(group, rows, (row) => pickAgent(row._id));
    const agentNote = h("p", "tl-hint");
    agentF.body.append(group, agentNote);
    agentF.control = group;

    // Model
    const modelF = fieldBox("model", "模型");
    const mChoice = choice([["inherit", "跟随 Agent 默认"], ["explicit", "指定模型"]], (mode) => setModelMode(mode), modelF.lab.id);
    const mInput = h("input", "tl-input tl-mono"), mChips = h("div", "tl-chips"), mControl = h("div", "tl-control"), mHint = h("p", "tl-hint");
    mInput.maxLength = 120; mInput.autocomplete = "off"; mInput.spellcheck = false;
    mInput.placeholder = "模型 ID，可以手填";
    mInput.setAttribute("aria-labelledby", modelF.lab.id);
    mControl.append(mInput, mChips);
    modelF.body.append(mChoice.el, mControl, mHint);
    modelF.control = mInput;
    let typingBefore = null;
    mInput.addEventListener("focus", () => { typingBefore = resolveOf(draft).breed; });
    mInput.addEventListener("input", () => { draft.model = M.explicit(mInput.value); lastModel = mInput.value; clearErr("model"); refresh(); onChange("model"); });
    mInput.addEventListener("change", () => { settle("model", typingBefore); typingBefore = resolveOf(draft).breed; });

    // Effort: its controls depend on what the Agent and model are said to support.
    const effortF = fieldBox("effort", "推理强度（effort）");
    let effortKey = "", eChoice = null, eSelect = null, eInput = null;
    const eHint = h("p", "tl-hint");

    // Breed
    const breedF = fieldBox("breed", "猫种");
    const bChoice = choice([["auto", "自动（按模型系列）"], ["explicit", "手动指定"]], (mode) => setBreedMode(mode), breedF.lab.id);
    const bResult = h("div", "tl-breed-result"), bGrid = h("div", "tl-breeds"), bHint = h("p", "tl-hint"), bRows = [];
    bGrid.setAttribute("role", "radiogroup"); bGrid.setAttribute("aria-label", "手动指定猫种");
    for (const breed of M.BREEDS) {
      const b = btn("tl-breed", "", () => pickBreed(breed.id));
      b.setAttribute("role", "radio"); b._id = breed.id;
      b.append(portrait(breed.id), h("span", "", breed.label));
      if (breed.family) b.append(h("small", "", M.FAMILIES.find((f) => f.id === breed.family).label + " 系列"));
      else if (breed.carrier) b.append(h("small", "", "多模型载体"));
      else b.append(h("small", "", "上游「小鲸鱼」"));
      bRows.push(b); bGrid.append(b);
    }
    const syncBreeds = roving(bGrid, bRows, (b) => pickBreed(b._id));
    breedF.body.append(bChoice.el, bResult, bGrid, bHint);
    breedF.control = bGrid;

    // Portrait
    const portraitDefs = [
      ["role", "职责", "roleDescription", true, 800, "这只猫负责什么、边界在哪。"],
      ["personality", "性格", "personality", true, 400, "口吻和表达习惯。"],
      ["teamStrengths", "擅长", "teamStrengths", false, 200, ""],
      ["caution", "提醒", "caution", false, 200, "给协作者的注意事项，比如不擅长什么。"],
    ];
    const portraitBoxes = portraitDefs.map(([key, label, prop, multi, max, hint]) => {
      const f = fieldBox(key, label), ctl = h(multi ? "textarea" : "input", multi ? "tl-textarea" : "tl-input");
      ctl.maxLength = max; ctl.value = draft.portrait[prop] || "";
      if (multi) ctl.rows = key === "role" ? 3 : 2;
      ctl.setAttribute("aria-labelledby", f.lab.id);
      ctl.addEventListener("input", () => { draft.portrait[prop] = ctl.value; clearErr(key); marks(); onChange(key); });
      f.body.append(ctl);
      if (hint) f.body.append(h("p", "tl-hint", hint));
      f.control = ctl; f.prop = prop;
      return f.box;
    });
    if ((draft.strengths || []).length) {
      const tags = h("div", "tl-tags");
      for (const s of draft.strengths) tags.append(tag(s));
      portraitBoxes.push(h("p", "tl-hint", "上游擅长标签（照原样保留，样页不编辑）："), tags);
    }

    root.append(sec("运行配置", agentF.box, modelF.box, effortF.box), sec("猫种", breedF.box), sec("画像", ...portraitBoxes));

    function pickAgent(id) {
      if (draft.runtimeId === id) return;
      const before = resolveOf(draft).breed;
      draft.runtimeId = id;
      const res = M.reconcile(draft, app.runtimes, "runtime");
      Object.assign(draft, res.config);
      agentF.change.textContent = res.notes.join(" ");
      if (draft.model.mode === "inherit") lastModel = "";
      noteBreed(before);
      clearErr("agent"); clearErr("model"); clearErr("effort");
      refresh(); onChange("agent");
    }
    function setModelMode(mode) {
      const before = resolveOf(draft).breed;
      if (mode === "inherit") draft.model = M.inherit();
      else draft.model = M.explicit(lastModel || (runtime() && runtime().defaultModel) || "");
      clearErr("model");
      settle("model", before);
      if (mode === "explicit") mInput.focus();
    }
    // After the model settles, effort is checked again; nothing is downgraded silently.
    function settle(field, before) {
      before = before === undefined ? null : before;
      const res = M.reconcile(draft, app.runtimes, field);
      Object.assign(draft, res.config);
      effortF.change.textContent = res.notes.join(" ");
      if (before) noteBreed(before);
      refresh(); onChange(field);
    }
    function setEffortMode(mode) {
      if (mode === "inherit") draft.effort = M.inherit();
      else {
        const cap = M.effortCapability(draft, runtime());
        draft.effort = M.explicit(cap.state === "supported" && !cap.values.includes(lastEffort) ? "" : lastEffort);
      }
      clearErr("effort"); refresh(); onChange("effort");
      if (mode === "explicit") (eSelect || eInput) && (eSelect || eInput).focus();
    }
    function setBreedMode(mode) {
      if (mode === "auto") draft.breed = { mode: "auto" };
      else { const now = resolveOf(draft).breed; draft.breed = { mode: "explicit", breedId: now ? now.id : "" }; }
      breedF.change.textContent = "";
      clearErr("breed"); refresh(); onChange("breed");
    }
    function pickBreed(id) { draft.breed = { mode: "explicit", breedId: id }; clearErr("breed"); refresh(); onChange("breed"); }
    function noteBreed(before) {
      const after = resolveOf(draft).breed;
      if (draft.breed.mode !== "auto" || !before || (after && after.id === before.id)) return;
      breedF.change.textContent = after
        ? `猫种随模型系列变为${after.label}。想保留${before.label}，改为「手动指定」。`
        : `现在没法自动判断猫种（原来是${before.label}），请指定模型或手动指定猫种。`;
    }
    function resetField(key) {
      const before = resolveOf(draft).breed;
      if (key === "agent") {
        Object.assign(draft, { runtimeId: baseline.runtimeId, model: M.clone(baseline.model), effort: M.clone(baseline.effort) });
        const res = M.reconcile(draft, app.runtimes, "runtime");
        Object.assign(draft, res.config);
        agentF.change.textContent = "已恢复模板的 Agent、模型和推理强度。" + res.notes.join(" ");
      } else if (key === "model" || key === "effort") {
        draft[key] = M.clone(baseline[key]);
        const res = M.reconcile(draft, app.runtimes, "model");
        Object.assign(draft, res.config);
        effortF.change.textContent = res.notes.join(" ");
      } else if (key === "breed") draft.breed = M.clone(baseline.breed);
      else {
        const f = fields[key];
        draft.portrait[f.prop] = baseline.portrait[f.prop] || "";
        f.control.value = draft.portrait[f.prop];
      }
      if (draft.model.mode === "explicit") lastModel = draft.model.value;
      if (draft.effort.mode === "explicit") lastEffort = draft.effort.value;
      noteBreed(before);
      clearErr(key); refresh(); onChange(key);
      focusField(key);
    }
    function focusField(key) {
      const f = fields[key];
      if (!f) return;
      const target = key === "agent" ? rows.find((b) => b.tabIndex === 0)
        : key === "breed" ? (draft.breed.mode === "explicit" ? bRows.find((b) => b.tabIndex === 0) : f.box.querySelector("input"))
        : key === "effort" ? eSelect || eInput || f.box.querySelector("input") : f.control;
      if (target && target.getClientRects().length) target.focus();
      else { const first = focusables(f.box)[0]; if (first) first.focus(); }
      f.box.scrollIntoView({ block: "nearest" });
    }

    function renderEffort() {
      const r = runtime(), cap = M.effortCapability(draft, r);
      const key = cap.state + ":" + (cap.values || []).join(",") + ":" + (cap.reason || "");
      if (key !== effortKey) {
        effortKey = key; eChoice = eSelect = eInput = null;
        const parts = [];
        if (cap.state === "supported" || cap.state === "unconfirmed") {
          eChoice = choice([["inherit", "跟随 Agent 默认"], ["explicit", cap.state === "supported" ? "指定" : "指定（待验证）"]], setEffortMode, effortF.lab.id);
          const ctl = h("div", "tl-control");
          if (cap.state === "supported") {
            eSelect = h("select", "setselect");
            eSelect.append(new Option("选一个档位", ""), ...cap.values.map((v) => new Option(v, v)));
            eSelect.setAttribute("aria-labelledby", effortF.lab.id);
            eSelect.addEventListener("change", () => { draft.effort = M.explicit(eSelect.value); lastEffort = eSelect.value; clearErr("effort"); refresh(); onChange("effort"); });
            ctl.append(eSelect);
          } else {
            eInput = h("input", "tl-input tl-mono");
            eInput.maxLength = 24; eInput.autocomplete = "off"; eInput.spellcheck = false; eInput.placeholder = "比如 high";
            eInput.setAttribute("aria-labelledby", effortF.lab.id);
            eInput.addEventListener("input", () => { draft.effort = M.explicit(eInput.value); lastEffort = eInput.value; clearErr("effort"); marks(); onChange("effort"); });
            ctl.append(eInput);
          }
          parts.push(eChoice.el, ctl);
        }
        parts.push(eHint);
        effortF.body.replaceChildren(...parts);
        effortF.control = eChoice ? effortF.body.querySelector("input") : null;
      }
      const name = r ? r.label : "Agent", explicit = draft.effort.mode === "explicit";
      if (eChoice) {
        eChoice.set(explicit ? "explicit" : "inherit");
        const ctl = eSelect || eInput;
        ctl.parentElement.hidden = !explicit;
        if (ctl !== document.activeElement) ctl.value = explicit ? draft.effort.value : "";
      }
      let hint = "";
      if (cap.state === "no_agent") hint = "先选 Agent。";
      else if (cap.state === "unsupported") hint = `${name} 不支持单独设置推理强度（示例）：创建时不传这个参数，按 Agent 自己的方式运行。`;
      else if (cap.state === "supported") hint = explicit ? `示例能力：${cap.values.join(" / ")}。` : "跟随 Agent 默认：不单独传推理强度。";
      else hint = cap.reason === "model"
        ? `模型 ${M.effectiveModel(draft, r).value} 不在示例目录里，推理强度是否支持还没确认。可以填写，创建时由原生校验；样页不会替你降档。`
        : `${name} 的推理强度选项还没确认（示例）。可以填写，创建时由原生校验；样页不会替你降档。`;
      eHint.textContent = hint;
    }

    function refresh() {
      const r = runtime();
      for (const row of rows) { const on = row._id === draft.runtimeId; row.classList.toggle("on", on); row.setAttribute("aria-checked", String(on)); }
      syncAgents();
      const notes = [];
      if (isCreate) {
        const closed = app.runtimes.filter((x) => !x.adapted).map((x) => x.label);
        if (closed.length) notes.push(`${closed.join("、")} 还没适配，不能用来创建。`);
        const orig = baseline && runtimeOf(baseline.runtimeId);
        if (baseline && orig && !orig.adapted) notes.push(`模板原本用 ${orig.label}。`);
        if (baseline && !baseline.runtimeId && carrier) notes.push(carrier.note + "。");
        if (r && r.adapted && r.readiness !== "configured") notes.push(`还没确认 ${r.label} 已登录；如果没登录，第一次执行会失败（示例）。`);
      } else if (carrier && !draft.runtimeId) notes.push(carrier.note + "。");
      notes.push("选择 Agent 只保存配置，不会启动它。");
      agentNote.textContent = notes.join(" ");

      const explicitModel = draft.model.mode === "explicit";
      mChoice.set(explicitModel ? "explicit" : "inherit");
      mControl.hidden = !explicitModel;
      if (mInput !== document.activeElement) mInput.value = explicitModel ? draft.model.value : "";
      mChips.replaceChildren();
      if (r) {
        const chip = (value, note) => {
          const c = btn("tl-chip", value, () => {
            const before = resolveOf(draft).breed;
            draft.model = M.explicit(value); lastModel = value; mInput.value = value; clearErr("model");
            settle("model", before);
          });
          c.setAttribute("aria-pressed", String(explicitModel && draft.model.value.trim() === value));
          if (note) { c.append(h("small", "", note)); c.title = note; }
          return c;
        };
        for (const m of r.models || []) mChips.append(chip(m));
        for (const m of r.exampleModels || []) mChips.append(chip(m.value, "示例覆盖"));
      }
      const mv = draft.model.mode === "explicit" ? draft.model.value.trim() : "";
      if (!r) mHint.textContent = "先选 Agent。";
      else if (!explicitModel) mHint.textContent = r.defaultModel
        ? `不单独指定：由 ${r.label} 用自己的默认模型（示例：${r.defaultModel}，取自上游 ${r.defaultModelFrom}，不是这台电脑的实时配置）。`
        : `不单独指定：由 ${r.label} 自己决定。示例数据里没有它的默认模型。`;
      else mHint.textContent = "选项取自上游种子的默认值，「示例覆盖」不是上游默认；也可以手填。样页不检测可用性。"
        + (mv && !(r.models || []).includes(mv) ? ` ${mv} 不在 ${r.label} 的选项里，按待验证处理。` : "");

      renderEffort();

      const res = resolveOf(draft), explicitBreed = draft.breed.mode === "explicit";
      bChoice.set(explicitBreed ? "explicit" : "auto");
      bResult.hidden = explicitBreed; bGrid.hidden = !explicitBreed;
      for (const b of bRows) b.setAttribute("aria-checked", String(explicitBreed && b._id === draft.breed.breedId));
      syncBreeds();
      if (!explicitBreed) {
        const line = res.breed
          ? `${res.breed.label} · ${res.model.source === "explicit" ? "模型 " + res.model.value : (r ? r.label : "Agent") + " 的默认模型 " + res.model.value}属于 ${res.family.label} 系列`
          : M.breedProblem(res, r);
        bResult.replaceChildren(portrait(res.breed && res.breed.id), h("span", "", line));
        bHint.textContent = "规则：" + M.FAMILY_RULE + "。孟加拉猫、金渐层是上游多模型载体的身份，不会自动推断。";
      } else {
        const auto = M.resolveBreed({ ...draft, breed: { mode: "auto" } }, r).breed;
        const up = upstreamBreed && M.breedOf(upstreamBreed);
        bHint.textContent = (up ? `上游预设：${up.label}（导入时保留的身份）。` : "")
          + (auto ? `改回自动会是：${auto.label}。` : "改回自动：现在无法判断。");
      }
      marks();
    }
    function marks() {
      if (!baseline) return;
      const changed = new Set(M.changedFields(draft, baseline).map((f) => f.id));
      for (const f of Object.values(fields)) { f.mark.hidden = !changed.has(f.key); f.reset.hidden = !changed.has(f.key); }
    }
    function clearErr(key) {
      const f = fields[key];
      if (!f) return;
      f.err.textContent = "";
      for (const el of f.box.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
    }
    refresh();
    return {
      element: root, refresh,
      showErrors(list) {
        for (const i of list) {
          const f = fields[i.field];
          if (!f) continue;
          f.err.textContent = i.text;
          const ctl = f.key === "effort" ? eSelect || eInput : f.control;
          if (ctl && ctl.matches("input, textarea, select")) ctl.setAttribute("aria-invalid", "true");
        }
      },
      focus: focusField,
    };
  }

  const FIELD_NAMES = { agent: "Agent", model: "模型", effort: "推理强度", breed: "猫种", role: "职责", personality: "性格", teamStrengths: "擅长", caution: "提醒" };
  function issueAction(issue) {
    return { agent: issue.code === "no_agent" || issue.code === "cloud" ? "选择 Agent" : "改用其他 Agent", breed: "指定猫种", role: "填写职责", model: "去修改", effort: "去修改" }[issue.field] || "去修改";
  }

  // ---------- template rows (library and picker) ----------
  function groupsOf(list) {
    const map = new Map(M.BREEDS.map((b) => [b.id, []]));
    map.set("", []);
    for (const t of list) { const res = resolveOf(M.templateConfig(t)); map.get(res.breed ? res.breed.id : "").push(t); }
    return [...map].filter(([, items]) => items.length);
  }
  function groupHead(id, count) {
    const head = h("h3", "tl-group-head");
    head.append(portrait(id || null), document.createTextNode(id ? breedLabel(id) : "猫种待定"), h("small", "", "· " + count));
    return head;
  }
  function searchText(t) {
    const c = M.templateConfig(t), res = resolveOf(c);
    return [t.name, t.nameHint, res.breed && res.breed.label, M.agentText(c, app.runtimes, carrierOf(t)), c.model.mode === "explicit" ? c.model.value : "",
      c.portrait.roleDescription, c.portrait.personality, c.portrait.teamStrengths].join(" ").toLowerCase();
  }
  function templateRow(t, onPick) {
    const c = M.templateConfig(t), res = resolveOf(c), row = btn("skrow", "", onPick), tx = h("span", "tx"), title = h("b");
    title.append(h("span", "", t.name));
    if (t.source.kind === "native-seed" && t.source.familyDefault && t.source.variantId) title.append(tag("上游默认"));
    if (t.modified) title.append(tag("已修改"));
    if (t.source.kind === "user") title.append(tag("我的"));
    tx.append(title, h("span", "hint", M.summary(c, app.runtimes, carrierOf(t))));
    row.append(portrait(res.breed && res.breed.id), tx);
    const block = M.issues(c, app.runtimes, carrierOf(t)).find((i) => i.blocking);
    if (block) row.append(h("span", "tl-row-state", block.short));
    row.append(chev());
    return row;
  }

  // ---------- settings dialog (the original shell) ----------
  const setpage = $("setpage"), setscrim = $("setscrim");
  const settings = { open: false, pane: "general", opener: null };
  const settingsSurface = { root: setpage, escape: () => requestCloseSettings() };
  const paneTitle = (pane) => { const b = setpage.querySelector(`[data-set="${pane}"] span`); return b ? b.textContent : "设置"; };
  // From 我 → 设置 it opens like the app: 通用 on a wide screen, the item list on a phone.
  function openSettings(pane, opts) {
    opts = opts || {};
    if (!settings.open) {
      settings.opener = opts.opener || document.activeElement;
      setscrim.hidden = false; setpage.hidden = false; settings.open = true;
      pushSurface(settingsSurface);
      $("tl-reset-status").textContent = "";
    }
    if (opts.home && window.innerWidth <= 640) {
      settings.pane = pane; setpage.dataset.nav = "home"; syncBar();
      setpage.querySelector("[data-set]").focus();
      return;
    }
    showPane(pane, opts);
  }
  function showPane(pane, opts) {
    settings.pane = pane;
    setpage.dataset.nav = "pane";
    for (const b of setpage.querySelectorAll("[data-set]")) {
      const on = b.dataset.set === pane;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    }
    for (const p of setpage.querySelectorAll("[data-spane]")) p.hidden = p.dataset.spane !== pane;
    setpage.querySelector(".setcnt").scrollTop = 0;
    if (pane === "templates") { if (opts && opts.templateId && templateOf(opts.templateId)) openEditor(opts.templateId); else showList(true); return; }
    if (pane === "agents") renderAgents();
    if (pane !== "templates") { T.level = "list"; T.ed = null; }
    syncBar();
    const f = focusables(setpage.querySelector(`[data-spane="${pane}"]`))[0];
    (f || setpage.querySelector(`[data-set="${pane}"]`) || setpage).focus();
  }
  function closeSettings(focusTarget) {
    setscrim.hidden = true; setpage.hidden = true; settings.open = false;
    T.level = "list"; T.ed = null;
    popSurface(settingsSurface);
    refocus(focusTarget || settings.opener);
  }
  function guardDirty(go, opener) {
    if (!T.dirty()) { go(); return; }
    layer({ title: "放弃未保存的修改？", lead: "这个模板还有没保存的修改。", opener: opener || document.activeElement,
      actions: [["", "继续编辑", (L) => L.close()], ["pri", "放弃修改", (L) => { L.close(true); go(); }]] });
  }
  const requestCloseSettings = () => guardDirty(() => closeSettings());
  function syncBar() {
    const back = $("settings-back"), label = $("settings-back-label"), title = $("settings-bar-title");
    if (setpage.dataset.nav === "home") { back.hidden = true; title.textContent = "设置"; return; }
    back.hidden = false;
    if (settings.pane === "templates" && T.level === "edit") { label.textContent = "模板"; title.textContent = T.title(); }
    else { label.textContent = "设置"; title.textContent = paneTitle(settings.pane); }
  }
  for (const b of setpage.querySelectorAll("[data-set]")) b.addEventListener("click", () => guardDirty(() => showPane(b.dataset.set)));
  $("settings-back").addEventListener("click", () => {
    if (settings.pane === "templates" && T.level === "edit") guardDirty(() => showList(true));
    else { setpage.dataset.nav = "home"; syncBar(); setpage.querySelector("[data-set]").focus(); }
  });
  $("settings-close").addEventListener("click", requestCloseSettings);
  $("settings-close-m").addEventListener("click", requestCloseSettings);
  setscrim.addEventListener("click", requestCloseSettings);

  // ---------- template library ----------
  const T = { level: "list", query: "", breed: "", status: "", ed: null,
    dirty: () => T.level === "edit" && !!T.ed && JSON.stringify(T.ed.draft) !== T.ed.saved,
    title: () => (T.ed && (T.ed.draft.name.trim() || (T.ed.id ? templateOf(T.ed.id)?.name : "新模板"))) || "模板" };
  const tHost = $("tl-templates");

  function showList(focusFirst) {
    T.level = "list"; T.ed = null; syncBar();
    const head = h("div", "sethd"); head.append(h("h2", "", "模板"));
    const lead = h("p", "setlead", "模板 = Agent + 模型 + 可选推理强度 + 画像。新建猫猫时一次性复制这些设置；之后编辑或删除模板，只影响以后新建的猫猫。原生种子也能直接改、删，或新建你自己的模板。");
    const status = h("p", "sk-status", T.status);
    status.setAttribute("role", "status"); status.hidden = !T.status; T.status = "";
    const toolbar = h("div", "sktoolbar"); toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "模板列表工具");
    const filter = h("select", "setselect"); filter.setAttribute("aria-label", "按猫种筛选");
    const counts = new Map(groupsOf(app.templates).map(([id, items]) => [id, items.length]));
    filter.append(new Option("全部猫种 · " + app.templates.length, ""));
    for (const [id, n] of counts) filter.append(new Option((id ? breedLabel(id) : "猫种待定") + " · " + n, id || "-"));
    filter.value = [...filter.options].some((o) => o.value === T.breed) ? T.breed : "";
    const wrap = h("div", "sksearchwrap"), glyph = h("span", "sksic"), search = h("input", "sksearch");
    glyph.setAttribute("aria-hidden", "true");
    search.type = "search"; search.placeholder = "搜索模板"; search.setAttribute("aria-label", "搜索模板"); search.autocomplete = "off"; search.value = T.query;
    wrap.append(glyph, search);
    const add = btn("btn pc-add", "", () => openEditor(null)), plus = h("span", "pc-plus");
    add.setAttribute("aria-label", "新建模板"); add.title = "新建模板"; plus.setAttribute("aria-hidden", "true"); add.append(plus);
    toolbar.append(filter, wrap, add);
    const groups = h("div", "tl-groups"), none = h("div", "sknone");
    none.setAttribute("aria-live", "polite");
    none.append(h("p", "", "没有匹配的模板"), btn("clearsrch", "清除筛选", () => { T.query = ""; T.breed = ""; search.value = ""; filter.value = ""; paint(); search.focus(); }));
    function paint() {
      const q = T.query.trim().toLowerCase();
      const list = app.templates.filter((t) => !q || searchText(t).includes(q));
      groups.replaceChildren();
      for (const [id, items] of groupsOf(list)) {
        if (T.breed && T.breed !== (id || "-")) continue;
        const sec = h("section", "tl-group"), rowsBox = h("div", "sklist"), gh = groupHead(id, items.length);
        gh.id = uid("tl-g"); sec.setAttribute("aria-labelledby", gh.id);
        for (const t of items) rowsBox.append(templateRow(t, () => openEditor(t.id)));
        sec.append(gh, rowsBox); groups.append(sec);
      }
      none.hidden = groups.childElementCount > 0;
    }
    search.addEventListener("input", () => { T.query = search.value; paint(); });
    filter.addEventListener("change", () => { T.breed = filter.value; paint(); });
    paint();
    const tail = [];
    const seedsGone = app.removed.filter((r) => r.seed);
    if (seedsGone.length) {
      const det = h("details", "tl-deleted"), rowsBox = h("div", "setrows");
      det.append(h("summary", "", `已删除的原生种子（${seedsGone.length}）`), rowsBox);
      for (const rec of seedsGone) {
        const row = h("div", "setrow"), tx = h("div", "tx");
        tx.append(h("b", "", rec.name), h("div", "hint", `删除前是修订 ${rec.revision} · ${when(rec.removedAt)}`));
        const again = btn("btn sm", "恢复", () => restoreSeed(rec));
        again.setAttribute("aria-label", `恢复「${rec.name}」`);
        row.append(tx, again); rowsBox.append(row);
      }
      tail.push(det);
    }
    const seeds = app.seeds.length, roleOnly = app.seeds.filter((s) => s.source.roleTemplateId).length;
    tail.push(h("p", "setfoot", `原生种子来自 clowder-ai ${commit().slice(0, 7)} 的 cat-template.json：${seeds - roleOnly} 个 breed variant，加 ${roleOnly} 个只有画像的角色模板。Agent 名称、适配状态和推理强度能力是示例数据，见「本地 Agent（示例）」。`));
    tHost.replaceChildren(head, lead, status, toolbar, groups, none, ...tail);
    if (focusFirst) search.focus();
  }

  function sourceLine(t) {
    if (!t) return "我的模板 · 新建，保存后是修订 1";
    if (t.source.kind === "user") return `我的模板 · 修订 ${t.revision}` + (t.source.copiedFrom ? ` · 复制自「${t.source.copiedFrom.name}」修订 ${t.source.copiedFrom.revision}` : "");
    return `原生种子 · 修订 ${t.revision}` + (t.modified ? " · 已修改" : "") + (t.source.variantId ? ` · ${t.source.breedId} / ${t.source.variantId}` : ` · 角色模板 ${t.source.roleTemplateId}`);
  }
  const seedOf = (id) => app.seeds.find((s) => s.id === id) || null;
  function sameAsSeed(t) {
    const seed = seedOf(t.id);
    return !!seed && seed.name === t.name && (seed.nameHint || "") === (t.nameHint || "") && JSON.stringify(M.templateConfig(seed)) === JSON.stringify(M.templateConfig(t));
  }

  function openEditor(id, note) {
    const t = id ? templateOf(id) : null;
    if (id && !t) { showList(true); return; }
    const draft = t ? { name: t.name, nameHint: t.nameHint || "", config: M.templateConfig(t) } : { name: "", nameHint: "", config: blankConfig() };
    T.level = "edit";
    T.ed = { id: t ? t.id : null, draft, saved: JSON.stringify(draft) };
    renderEditor(note);
  }
  function renderEditor(note) {
    const ed = T.ed, d = ed.draft, t = ed.id ? templateOf(ed.id) : null;
    const back = btn("setback", "", () => guardDirty(() => showList(true)));
    back.append(h("span", "skback-chev"), document.createTextNode("模板"));
    const faceSlot = h("span", "avatar pick");
    const titleBox = h("div", "tl-ed-title"), nameLabel = h("label", "tl-label", "模板名称"), name = h("input", "pc-name"), nameErr = h("p", "tl-ferr");
    name.id = uid("tl-tname"); nameLabel.htmlFor = name.id;
    name.maxLength = 40; name.autocomplete = "off"; name.value = d.name; name.placeholder = "比如：日常写作助手";
    titleBox.append(nameLabel, name, nameErr, h("p", "tl-src-line", sourceLine(t)), h("p", "tl-hint", "这是模板在库里的名字，不是猫猫的名字。"));
    const use = btn("btn tl-ed-use", "用它新建猫猫", () => { const id = t.id, plus = document.querySelector(".pin.add"); closeSettings(plus); openCreate({ templateId: id, opener: plus }); });
    const head = h("div", "tl-ed-head");
    head.append(faceSlot, titleBox, use);

    const editor = configEditor({ draft: d.config, purpose: "template", carrier: carrierOf(t), upstreamBreed: t ? t.source.upstreamBreed : null, onChange: changed });

    const hintSec = h("section", "tl-sec"), hintField = h("div", "tl-field"), hintLabel = h("label", "tl-flabel", "新猫名字建议"), hintInput = h("input", "tl-input");
    hintInput.id = uid("tl-hint"); hintLabel.htmlFor = hintInput.id; hintInput.maxLength = 32; hintInput.autocomplete = "off"; hintInput.value = d.nameHint; hintInput.placeholder = "可以留空";
    const hintHead = h("div", "tl-field-head"); hintHead.append(hintLabel);
    hintField.append(hintHead, hintInput, h("p", "tl-hint", "新建猫猫时先填进名字，重名会自动加编号。原生种子取自上游 nickname。"));
    hintSec.append(h("h4", "", "新建时"), hintField);

    const det = h("details", "tl-src"), facts = h("dl", "agent-facts");
    const fact = (k, v) => facts.append(h("dt", "", k), h("dd", "", v));
    if (t) {
      fact("模板 ID", `${t.id}（独立于猫种，不当作猫种使用）`);
      fact("当前修订", `修订 ${t.revision}` + (t.modified ? " · 你的修改作为覆盖保存，不改上游文件" : ""));
      if (t.source.kind === "native-seed") {
        fact("原生来源", `clowder-ai ${t.source.upstreamCommit.slice(0, 7)} · cat-template.json · ` + (t.source.variantId
          ? `breeds/${t.source.breedId} · variants/${t.source.variantId}` + (t.source.catId ? `（catId ${t.source.catId}）` : "")
          : `roleTemplates/${t.source.roleTemplateId}`));
        fact("上游载体", t.source.clientId ? `clientId ${t.source.clientId}` + (t.source.carrier ? ` · ${t.source.carrier.note}` : runtimeOf(seedOf(t.id)?.runtimeId) ? ` → 示例 Agent ${runtimeOf(seedOf(t.id).runtimeId).label}` : "") : t.source.carrier ? t.source.carrier.note : "—");
      } else if (t.source.copiedFrom) fact("复制自", `「${t.source.copiedFrom.name}」修订 ${t.source.copiedFrom.revision}`);
      const used = catsFrom(t.id);
      fact("用它建的样页猫猫", used.length ? used.map((c) => `${c.name}（修订 ${c.source.templateRevision}）`).join("、") : "还没有");
    } else fact("模板 ID", "保存时分配，独立于猫种");
    det.append(h("summary", "", "来源与修订"), facts);

    const status = h("p", "tl-ed-status", note || ""); status.setAttribute("role", "status");
    const err = h("p", "sk-error"); err.setAttribute("role", "alert"); err.hidden = true;
    const foot = h("div", "pc-foot"), save = btn("btn pri", "保存", () => submit());
    const del = t ? btn("btn pc-del", "删除", (ev) => askDelete(t, ev.currentTarget)) : null;
    const copy = t ? btn("btn", "复制为新模板", () => duplicate(t)) : null;
    const revert = t && t.source.kind === "native-seed" && seedOf(t.id) ? btn("btn", "填回上游预设", () => {
      const seed = seedOf(t.id);
      ed.draft = { name: seed.name, nameHint: seed.nameHint || "", config: M.templateConfig(seed) };
      renderEditor("已填回上游预设值，保存后生效。");
    }) : null;
    foot.append(...[del, copy, revert].filter(Boolean), h("span", "pc-gap"), save);
    tHost.replaceChildren(back, head, editor.element, hintSec, det, status, err, foot);

    function changed() {
      const res = resolveOf(d.config);
      faceSlot.replaceChildren(...portrait(res.breed && res.breed.id).childNodes);
      faceSlot.classList.toggle("tl-av-unknown", !res.breed);
      const dirty = T.dirty();
      use.hidden = !t || dirty;
      if (copy) copy.hidden = dirty;
      if (revert) revert.hidden = !(t.modified || dirty) || JSON.stringify(ed.draft) === JSON.stringify({ name: seedOf(t.id).name, nameHint: seedOf(t.id).nameHint || "", config: M.templateConfig(seedOf(t.id)) });
      syncBar();
    }
    name.addEventListener("input", () => { d.name = name.value; nameErr.textContent = ""; name.removeAttribute("aria-invalid"); changed(); });
    hintInput.addEventListener("input", () => { d.nameHint = hintInput.value; changed(); });
    changed();
    setpage.querySelector(".setcnt").scrollTop = 0;
    name.focus();

    function submit() {
      err.hidden = true; nameErr.textContent = ""; name.removeAttribute("aria-invalid");
      const nameText = M.nameProblem(d.name, app.templates.filter((x) => x.id !== ed.id).map((x) => x.name), 40, "template");
      const problems = M.issues(d.config, app.runtimes, carrierOf(t)).filter((i) => i.blocking && !i.draftOk);
      if (nameText || problems.length) {
        if (nameText) { nameErr.textContent = nameText; name.setAttribute("aria-invalid", "true"); }
        editor.showErrors(problems);
        err.textContent = "还不能保存：" + [nameText ? "模板名称" : "", ...problems.map((i) => FIELD_NAMES[i.field])].filter(Boolean).join("、") + "需要处理。";
        err.hidden = false;
        if (nameText) name.focus(); else editor.focus(problems[0].field);
        return;
      }
      if (t && !T.dirty()) { T.status = `「${t.name}」没有改动，仍是修订 ${t.revision}。`; showList(true); return; }
      const values = { name: d.name.trim(), nameHint: d.nameHint.trim(), ...M.clone(d.config), updatedAt: Date.now() };
      let saved = t;
      if (t) {
        Object.assign(t, values, { revision: t.revision + 1 });
        t.modified = t.source.kind === "native-seed" ? !sameAsSeed(t) : false;
      } else {
        saved = { id: uid("tpl-u"), revision: 1, ...values, source: { kind: "user", copiedFrom: null, carrier: null, upstreamBreed: null }, modified: false };
        app.templates.push(saved);
      }
      persist();
      const used = catsFrom(saved.id).length, block = M.issues(M.templateConfig(saved), app.runtimes, carrierOf(saved)).find((i) => i.blocking);
      T.status = `已保存「${saved.name}」· 修订 ${saved.revision}。只影响以后新建的猫猫` + (used ? `；用它建的 ${used} 只样页猫猫保持原样。` : "。")
        + (block ? `还不能用来创建：${block.short}。` : "");
      showList(true); renderMain();
    }
  }
  function askDelete(t, opener) {
    const used = catsFrom(t.id);
    layer({
      title: `删除模板「${t.name}」？`, opener,
      lead: [
        used.length ? `只影响以后新建：用它建的 ${used.length} 只样页猫猫（${used.map((c) => c.name).join("、")}）保留自己的配置，详情里会标明来源模板已删除。` : "删除后不能再用它新建猫猫；已经建好的猫猫不受影响。",
        t.source.kind === "native-seed" ? "这是原生种子：删除会被记住，刷新后也不会自己回来；需要时可以在列表底部「已删除的原生种子」恢复。" : "这是你自己的模板，删除后找不回来。",
      ],
      actions: [["", "取消", (L) => L.close()], ["pri", "删除模板", (L) => {
        L.close(true);
        app.templates = app.templates.filter((x) => x !== t);
        app.removed.push({ id: t.id, name: t.name, revision: t.revision, seed: t.source.kind === "native-seed", removedAt: Date.now() });
        persist();
        T.status = `已删除「${t.name}」。` + (used.length ? `${used.length} 只样页猫猫保持原样。` : "");
        showList(true); renderMain();
      }]],
    });
  }
  function restoreSeed(rec) {
    const seed = seedOf(rec.id);
    if (!seed || templateOf(rec.id)) return;
    const t = { ...M.clone(seed), revision: rec.revision + 1, updatedAt: Date.now() };
    const order = (x) => { const i = app.seeds.findIndex((s) => s.id === x.id); return i < 0 ? Infinity : i; };
    const at = app.templates.findIndex((x) => order(x) > order(t));
    app.templates.splice(at < 0 ? app.templates.length : at, 0, t);
    app.removed = app.removed.filter((r) => r !== rec);
    persist();
    T.status = `已恢复「${t.name}」为上游预设 · 修订 ${t.revision}。`;
    showList(true); renderMain();
  }
  function duplicate(t) {
    const copy = { ...M.clone(t), id: uid("tpl-u"), revision: 1, name: M.freeName(t.name + " 副本", app.templates.map((x) => x.name)), updatedAt: Date.now(),
      source: { kind: "user", copiedFrom: { id: t.id, revision: t.revision, name: t.name }, carrier: carrierOf(t), upstreamBreed: t.source.upstreamBreed || null }, modified: false };
    app.templates.push(copy);
    persist();
    openEditor(copy.id, `已复制为「${copy.name}」（修订 1），可以接着改。`);
  }

  // ---------- sample Agents (read-only fixture) ----------
  function renderAgents() {
    const host = $("tl-agents");
    const sections = [["可以用来创建（clowder-bot 已适配）", app.runtimes.filter((r) => r.adapted)], ["尚未适配（只能保存在模板里）", app.runtimes.filter((r) => !r.adapted)]];
    const body = [];
    for (const [title, list] of sections) {
      if (!list.length) continue;
      const sec = h("div", "setsec"), box = h("div", "agent-list");
      for (const r of list) {
        const row = h("div", "agent-row" + (r.adapted ? "" : " off")), head = h("div", "agent-head"), nm = h("div", "agent-name"), state = h("span", "agent-state");
        nm.append(h("b", "", r.label), h("code", "agent-cmd", r.id));
        const dot = h("span", "sdot " + (!r.adapted ? "off" : r.readiness === "configured" ? "ok" : "idle"));
        dot.setAttribute("aria-hidden", "true");
        state.append(dot, h("span", "", !r.adapted ? "尚未适配" : r.readiness === "configured" ? "示例：已有配置记录" : "示例：未确认登录"));
        head.append(nm, state); row.append(head);
        if (!r.adapted) row.append(h("p", "agent-hint", r.unadaptedReason + "。引用它的模板可以保存和编辑，不能直接创建。"));
        const facts = h("dl", "agent-facts"), fact = (k, v) => facts.append(h("dt", "", k), h("dd", "", v));
        fact("示例默认模型", r.defaultModel ? `${r.defaultModel}（取自上游 ${r.defaultModelFrom}）` : "没有（示例数据未读到）");
        fact("模型选项", (r.models || []).join("、") + ((r.exampleModels || []).length ? "；示例覆盖 " + r.exampleModels.map((m) => m.value).join("、") + "（不是上游默认）" : ""));
        fact("推理强度", r.effort.state === "supported" ? r.effort.values.join(" / ") + "（示例）" : r.effort.state === "unsupported" ? "不支持单独设置（示例）" : "未确认（示例）");
        fact("引用它的模板", String(app.templates.filter((t) => t.runtimeId === r.id).length) + " 个");
        row.append(facts); box.append(row);
      }
      sec.append(h("h4", "", title), box); body.push(sec);
    }
    const foot = h("div", "agent-foot");
    foot.append(h("p", "setfoot", "选择 Agent 只保存配置，不会启动它。样页不显示运行状态：Agent 是否在执行，只以原生调用记录为准。"),
      h("p", "setfoot", "正式接入时，Agent 列表、模型选项和推理强度能力由 Clowder AI 原生 runtime 清单与 runtime-models 提供；clowder-bot 不维护自己的模型目录，也没有密钥或供应商设置。"));
    host.replaceChildren(h("h2", "", "本地 Agent（示例）"),
      h("p", "setlead", "下面的 Agent、登录状态、默认模型和推理强度能力都是样页示例数据，只用来演示模板怎样引用 Agent。模型选项取自上游种子的默认值。"), ...body, foot);
  }

  // ---------- create a cat ----------
  const cModal = $("tl-create"), cForm = $("tl-create-form"), cBody = $("tl-create-body"), cOk = $("tl-create-ok"), cErr = $("tl-create-error");
  const C = { step: 1, template: null, revision: 0, draft: null, baseline: null, name: "", nameTouched: false, expanded: false, opener: null, query: "", editor: null };
  const createSurface = { root: cForm, escape: () => closeCreate() };
  function openCreate(opts) {
    opts = opts || {};
    C.opener = opts.opener || document.activeElement;
    C.query = "";
    cModal.hidden = false;
    pushSurface(createSurface);
    const t = opts.templateId && templateOf(opts.templateId);
    if (t) startTemplate(t); else step1();
  }
  function closeCreate(focusTarget) {
    if (cModal.hidden) return;
    cModal.hidden = true; cBody.replaceChildren(); C.editor = null;
    popSurface(createSurface);
    refocus(focusTarget || C.opener);
  }
  function setStep(text) { $("tl-create-step").textContent = text; cErr.hidden = true; cErr.textContent = ""; }
  cModal.addEventListener("mousedown", (ev) => { if (ev.target === cModal) closeCreate(); });
  $("tl-create-x").addEventListener("click", () => closeCreate());
  $("tl-create-cancel").addEventListener("click", () => closeCreate());
  cForm.addEventListener("submit", (ev) => { ev.preventDefault(); if (C.step === 2) submitCreate(); });

  function step1() {
    C.step = 1; C.template = null; C.editor = null;
    setStep("第 1 步，共 2 步 · 选模板");
    cOk.hidden = true;
    const lead = h("p", "tl-lead", "先选一个模板：猫种、Agent、模型、推理强度和画像会一起带进来，下一步还能微调。也可以不用模板，从零开始。");
    const tools = h("div", "tl-pick-tools"), wrap = h("div", "sksearchwrap"), glyph = h("span", "sksic"), search = h("input", "sksearch");
    glyph.setAttribute("aria-hidden", "true");
    search.type = "search"; search.placeholder = "搜索模板、猫种、Agent 或模型"; search.setAttribute("aria-label", "搜索模板"); search.autocomplete = "off"; search.value = C.query;
    wrap.append(glyph, search); tools.append(wrap);
    const scratch = btn("skrow tl-scratch", "", startScratch), stx = h("span", "tx"), plus = h("span", "tl-plus", "+");
    plus.setAttribute("aria-hidden", "true");
    stx.append(h("b", "", "从零开始"), h("span", "hint", "不用模板：自己选 Agent，模型和推理强度可以跟随默认，猫种按模型系列自动判断"));
    scratch.append(plus, stx, chev());
    const scratchBox = h("div", "sklist"); scratchBox.append(scratch);
    const groups = h("div", "tl-groups"), none = h("p", "tl-lead", "没有匹配的模板。");
    function paint() {
      const q = C.query.trim().toLowerCase();
      groups.replaceChildren();
      for (const [id, items] of groupsOf(app.templates.filter((t) => !q || searchText(t).includes(q)))) {
        const sec = h("section", "tl-group"), box = h("div", "sklist"), gh = groupHead(id, items.length);
        gh.id = uid("tl-pg"); sec.setAttribute("aria-labelledby", gh.id);
        for (const t of items) box.append(templateRow(t, () => startTemplate(t)));
        sec.append(gh, box); groups.append(sec);
      }
      none.hidden = groups.childElementCount > 0;
    }
    search.addEventListener("input", () => { C.query = search.value; paint(); });
    paint();
    cBody.replaceChildren(lead, tools, scratchBox, groups, none);
    cBody.scrollTop = 0;
    search.focus();
  }
  function startTemplate(t) {
    C.template = t; C.revision = t.revision;
    C.draft = M.templateConfig(t); C.baseline = M.templateConfig(t);
    C.expanded = false; C.nameTouched = false; C.name = "";
    step2();
  }
  function startScratch() {
    C.template = null; C.revision = 0; C.draft = blankConfig(); C.baseline = null;
    C.expanded = true; C.nameTouched = false; C.name = "";
    step2();
  }
  function suggestions() {
    const res = resolveOf(C.draft), nick = res.breed ? app.nick[res.breed.id] : "", t = C.template;
    const hints = t ? [t.nameHint, t.nameHint && t.source.variantLabel ? t.nameHint + " " + t.source.variantLabel : "", nick] : [nick, res.breed ? res.breed.label : ""];
    return M.nameSuggestions(hints.filter(Boolean), app.cats.map((c) => c.name));
  }
  function step2() {
    C.step = 2;
    const t = C.template;
    setStep(t ? "第 2 步，共 2 步 · 确认名字和配置" : "第 2 步，共 2 步 · 从零配置");
    cOk.hidden = false;
    const back = btn("setback", "", step1);
    back.append(h("span", "skback-chev"), document.createTextNode(t ? "换模板" : "选模板"));

    const identity = h("div", "tl-identity"), face = h("span", "avatar xl"), nameField = h("div", "tl-field"), nameHead = h("div", "tl-field-head");
    face.setAttribute("aria-hidden", "true");
    const nameLabel = h("label", "tl-flabel", "名字（这只猫）"), name = h("input", "tl-input"), nameErr = h("p", "tl-ferr"), chips = h("div", "tl-chips");
    name.id = uid("tl-cname"); nameLabel.htmlFor = name.id; name.maxLength = 32; name.autocomplete = "off"; name.placeholder = "给它起个名字";
    nameHead.append(nameLabel);
    nameField.append(nameHead, name, chips, nameErr);
    identity.append(face, nameField);
    if (!C.name) C.name = suggestions()[0] || "";
    name.value = C.name;
    name.addEventListener("input", () => { C.name = name.value; C.nameTouched = true; nameErr.textContent = ""; name.removeAttribute("aria-invalid"); paintChips(); });
    C.nameInput = name; C.nameErr = nameErr;

    const parts = [back, identity];
    const summary = h("dl", "agent-facts tl-summary"), ready = h("div", "tl-ready");
    ready.setAttribute("role", "status");
    const custom = h("div", "tl-custom"); custom.id = uid("tl-custom");
    let disc = null;
    if (t) {
      const from = h("p", "tl-from");
      from.append(document.createTextNode("来自模板 "), h("b", "", `「${t.name}」`), document.createTextNode(` · 修订 ${t.revision} · ${t.source.kind === "user" ? "我的模板" : "原生种子"}`));
      disc = btn("tl-disclosure", "", () => setExpanded(!C.expanded));
      disc.setAttribute("aria-controls", custom.id);
      parts.push(from, summary, ready, disc, custom);
    } else {
      parts.push(h("p", "tl-lead", "从零开始：先选 Agent。模型和推理强度可以跟随 Agent 默认，猫种按模型系列自动判断，也可以手动指定。"), ready, custom);
    }
    C.editor = configEditor({ draft: C.draft, purpose: "create", baseline: C.baseline, carrier: carrierOf(t), upstreamBreed: t ? t.source.upstreamBreed : null, onChange: update });
    custom.append(C.editor.element);
    cBody.replaceChildren(...parts);
    cBody.scrollTop = 0;

    function paintChips() {
      chips.replaceChildren();
      for (const s of suggestions()) {
        const c = btn("tl-chip plain", s, () => { C.name = s; name.value = s; C.nameTouched = true; nameErr.textContent = ""; name.removeAttribute("aria-invalid"); paintChips(); name.focus(); });
        c.setAttribute("aria-pressed", String(C.name.trim() === s));
        c.setAttribute("aria-label", "用名字 " + s);
        chips.append(c);
      }
    }
    function setExpanded(open) {
      C.expanded = open;
      if (disc) disc.setAttribute("aria-expanded", String(open));
      custom.hidden = !open;
    }
    function update() {
      const res = resolveOf(C.draft);
      face.replaceChildren(...portrait(res.breed && res.breed.id).childNodes);
      face.classList.toggle("tl-av-unknown", !res.breed);
      if (!res.breed) face.textContent = "?";
      if (!t && !C.nameTouched) { const next = suggestions()[0] || ""; if (next !== C.name) { C.name = next; name.value = next; } }
      paintChips();
      const changed = t ? M.changedFields(C.draft, C.baseline) : [];
      const changedIds = new Set(changed.map((f) => f.id));
      if (t) {
        summary.replaceChildren();
        const row = (label, value, ids) => {
          const dd = h("dd", "", value);
          if (ids.some((id) => changedIds.has(id))) dd.append(tag("已微调"));
          summary.append(h("dt", "", label), dd);
        };
        row("猫种", M.breedText(C.draft, app.runtimes), ["breed"]);
        row("Agent", M.agentText(C.draft, app.runtimes, carrierOf(t)), ["agent"]);
        row("模型", M.modelText(C.draft, app.runtimes), ["model"]);
        row("推理强度", M.effortText(C.draft, app.runtimes), ["effort"]);
        row("画像", clip(C.draft.portrait.roleDescription || "（还没写职责）", 60), ["role", "personality", "teamStrengths", "caution"]);
        const meta = h("span", "tl-disc-meta", changed.length ? `已微调 ${changed.length} 项：${changed.map((f) => f.label).join("、")}` : "未改动");
        disc.replaceChildren(h("span", "", "自定义配置"), meta, chev());
        disc.setAttribute("aria-expanded", String(C.expanded));
      }
      const list = M.issues(C.draft, app.runtimes, carrierOf(t)), blocking = list.filter((i) => i.blocking);
      ready.className = "tl-ready" + (blocking.length ? " warn" : "");
      ready.replaceChildren();
      if (blocking.length) {
        ready.append(h("p", "", "还不能创建："));
        const ul = h("ul");
        for (const i of blocking) {
          const li = h("li", "", i.text);
          li.append(btn("text-btn", issueAction(i), () => { setExpanded(true); C.editor.focus(i.field); }));
          ul.append(li);
        }
        ready.append(ul);
      } else {
        ready.append(h("p", "", t ? "可以创建。这些设置会一次性复制给这只猫，之后和模板脱钩：改模板不会改它。" : "可以创建。"));
      }
      const soft = list.filter((i) => !i.blocking);
      if (soft.length) { const ul = h("ul"); for (const i of soft) ul.append(h("li", "", i.text)); ready.append(ul); }
    }
    setExpanded(C.expanded);
    update();
    name.focus();
  }
  function submitCreate() {
    const t = C.template, name = C.nameInput, nameErr = C.nameErr;
    cErr.hidden = true;
    if (t) {
      const cur = templateOf(t.id);
      if (!cur || cur.revision !== C.revision) {
        cErr.textContent = !cur ? `模板「${t.name}」刚被删除了。回到上一步重新选模板。` : `模板「${t.name}」刚更新到修订 ${cur.revision}。回到上一步重新选，确认后再创建。`;
        cErr.hidden = false;
        return;
      }
    }
    const nameText = M.nameProblem(C.name, app.cats.map((c) => c.name), 32, "cat");
    const blocking = M.issues(C.draft, app.runtimes, carrierOf(t)).filter((i) => i.blocking);
    if (nameText || blocking.length) {
      if (nameText) { nameErr.textContent = nameText; name.setAttribute("aria-invalid", "true"); }
      C.editor.showErrors(blocking);
      cErr.textContent = "还不能创建：" + [nameText ? "名字" : "", ...blocking.map((i) => FIELD_NAMES[i.field])].filter(Boolean).join("、") + "需要处理。";
      cErr.hidden = false;
      if (nameText) { name.focus(); return; }
      if (t && !C.expanded) { C.expanded = true; const custom = cBody.querySelector(".tl-custom"); custom.hidden = false; const d = cBody.querySelector(".tl-disclosure"); if (d) d.setAttribute("aria-expanded", "true"); }
      C.editor.focus(blocking[0].field);
      return;
    }
    const cat = M.instantiate({ id: uid("cat"), name: C.name, now: Date.now(), template: t ? templateOf(t.id) : null, config: C.draft, runtimes: app.runtimes });
    app.cats.push(cat);
    app.selected = cat.id;
    persist();
    renderRoster(); renderChat();
    closeCreate($("head-chip"));
    closeDrawer();
    showToast(cat.source.kind === "template"
      ? `已创建样页猫猫「${cat.name}」：复制了模板「${cat.source.templateName}」修订 ${cat.source.templateRevision} 的设置，以后改模板不会改它。`
      : `已创建样页猫猫「${cat.name}」（从零配置）。`);
    if (window.innerWidth >= 768) panelOpen(true);
  }

  // ---------- the app shell: sidebar, header, thread, info drawer ----------
  // Markup and classes come from client/index.html and app.js (renderPinRow,
  // listButton, emptyState, paintGreeting, panel). Sample cats only: no
  // sessions, no running state, no greeting, and the composer never sends.
  const SVG = "http://www.w3.org/2000/svg";
  const ICONS = {
    plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
    "users-plus": [["circle", { cx: 9, cy: 7, r: 3 }], ["path", { d: "M3 21v-2a6 6 0 0 1 12 0v2M16 4a3 3 0 0 1 0 6M19 13v6M16 16h6" }]],
    person: [["circle", { cx: 12, cy: 8, r: 4 }], ["path", { d: "M4 22v-2a8 8 0 0 1 16 0v2" }]],
  };
  function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "icon"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ICONS[name] || []) {
      const node = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.append(node);
    }
    return svg;
  }

  const sidebar = $("sidebar"), backdrop = $("backdrop"), panel = $("panel"), scrim = $("panel-scrim"), chip = $("head-chip"), input = $("input");
  const selectedCat = () => app.cats.find((c) => c.id === app.selected) || null;
  function syncBackdrop() {
    const drawer = window.innerWidth < 768 && sidebar.classList.contains("open");
    backdrop.hidden = !drawer;
    scrim.hidden = !(panel.classList.contains("open") && !drawer);
  }
  function closeDrawer() { sidebar.classList.remove("open"); syncBackdrop(); }
  function panelOpen(open) {
    if (open && !selectedCat()) open = false;
    panel.classList.toggle("open", open);
    chip.classList.toggle("on", open);
    chip.setAttribute("aria-expanded", String(open));
    chip.setAttribute("aria-label", open ? "收起信息" : "打开信息");
    chip.title = open ? "收起信息" : "打开信息";
    if (open) renderPanel();
    syncBackdrop();
  }
  let toastTimer = 0;
  function showToast(text) {
    const toast = $("toast");
    toast.textContent = text; toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 5200);
  }

  // Popovers: the 新建 menu under the top plus and the 我 menu.
  function closeMenus(refocusAnchor) {
    const menu = document.querySelector(".new-menu"), add = document.querySelector(".pin.add");
    if (menu) {
      const had = menu.contains(document.activeElement);
      menu.remove();
      if (add) { add.setAttribute("aria-expanded", "false"); if (had || refocusAnchor) add.focus(); }
    }
    const account = $("account-menu");
    if (!account.hidden) {
      const had = account.contains(document.activeElement);
      account.hidden = true; $("account").setAttribute("aria-expanded", "false");
      if (had || refocusAnchor) $("account").focus();
    }
  }
  function placeMenu(anchor, menu) {
    document.body.append(menu);
    Object.assign(menu.style, { position: "fixed", right: "auto", bottom: "auto", left: "0", top: "0", zIndex: "45" });
    const width = menu.offsetWidth, height = menu.offsetHeight, r = anchor.getBoundingClientRect();
    let left = r.right - width, top = r.bottom + 4;
    if (left < 8) left = Math.min(window.innerWidth - width - 8, r.right + 6);
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
    menu.style.left = left + "px"; menu.style.top = top + "px";
  }
  function toggleNewMenu(anchor) {
    const open = !document.querySelector(".new-menu");
    closeMenus();
    if (!open) return;
    const menu = h("div", "pop folder-menu new-menu");
    menu.setAttribute("role", "menu");
    const item = (glyph, label, run) => {
      const b = h("button", "menu-row");
      b.type = "button"; b.setAttribute("role", "menuitem");
      b.append(icon(glyph), h("span", "", label));
      b.addEventListener("click", (ev) => { ev.stopPropagation(); closeMenus(); run(); });
      menu.append(b);
    };
    item("plus", "新建猫猫", () => openCreate({ opener: anchor }));
    item("users-plus", "新建群组", () => { showToast("交互样页只演示新建猫猫，没有包含群组。"); anchor.focus(); });
    anchor.setAttribute("aria-expanded", "true");
    placeMenu(anchor, menu);
    menu.querySelector("button").focus();
  }

  function paintGreeting() {
    const hour = new Date().getHours();
    $("greeting").textContent = (hour < 6 ? "夜深了" : hour < 12 ? "上午好" : hour < 18 ? "下午好" : "晚上好") + "。";
  }
  const catPreview = (cat) => (cat.demo ? "示例猫猫" : "样页新建") + " · 没有消息";
  function renderRoster() {
    const pins = $("pin-row"), roster = $("roster");
    pins.replaceChildren();
    for (const cat of app.cats.filter((c) => c.pinned)) {
      const active = cat.id === app.selected, b = btn("pin" + (active ? " active" : ""), "", () => pickCat(cat.id));
      b.setAttribute("aria-label", cat.name); b.title = cat.name;
      if (active) b.setAttribute("aria-current", "true");
      const label = h("span", "pin-name");
      label.append(h("span", "pin-label", cat.name));
      b.append(portrait(cat.breedId, "pin"), label);
      pins.append(b);
    }
    // The app's one 新建 at the end of the pin row, with its menu.
    const add = btn("pin add", "", (ev) => { ev.stopPropagation(); toggleNewMenu(add); });
    add.setAttribute("aria-label", "新建猫猫或群组"); add.setAttribute("aria-haspopup", "menu"); add.setAttribute("aria-expanded", "false"); add.title = "新建猫猫或群组";
    const face = h("span", "plus-face");
    face.append(icon("plus"));
    add.append(face, h("span", "pin-name pin-label", "新建"));
    pins.append(add);
    const body = h("div", "folder-bots");
    for (const cat of app.cats.filter((c) => !c.pinned)) {
      const active = cat.id === app.selected, item = btn("item" + (active ? " active" : ""), "", () => pickCat(cat.id));
      item.title = cat.name;
      if (active) item.setAttribute("aria-current", "true");
      const text = h("span", "item-body"), line = h("span", "name-line");
      line.append(h("span", "name", cat.name));
      text.append(line, h("span", "preview", catPreview(cat)));
      item.append(portrait(cat.breedId), text);
      body.append(item);
    }
    roster.replaceChildren(body);
  }
  function pickCat(id) {
    app.selected = id;
    persist();
    closeDrawer();
    renderRoster(); renderChat();
  }

  function renderChat() {
    const cat = selectedCat(), title = $("title"), sub = $("subtitle"), inner = h("div", "thread-inner");
    if (!cat) {
      title.replaceChildren(document.createTextNode("clowder-bot"));
      sub.hidden = true; chip.disabled = true;
      panelOpen(false);
      const box = h("div", "empty");
      box.append(h("h2", "", "选一个对话"), h("p", "", "左边是你的 Bot。"));
      inner.append(box);
      input.dataset.placeholder = "写一条消息";
    } else {
      const head = portrait(cat.breedId, "head");
      title.replaceChildren(head, h("span", "title-name", cat.name));
      sub.textContent = cat.config.portrait.roleDescription; sub.hidden = !sub.textContent;
      chip.disabled = false;
      // In the app a new cat says hello itself, in its own words. A sample cat
      // talks to nobody, so its chat says it is a preview instead of making a
      // greeting up: one neutral sysline, no message bubble.
      const note = h("div", "sysline");
      note.append(portrait(cat.breedId, "xs"), h("span", "label", "样页预览：不连接猫猫，不会生成问候或回复"));
      inner.append(note);
      input.dataset.placeholder = `写给 ${cat.name} · 样页未接入聊天`;
      if (panel.classList.contains("open")) renderPanel();
    }
    $("thread").replaceChildren(inner);
  }
  const renderMain = () => renderChat();

  // The info drawer holds the copied configuration, in the 详情 style (psec, agent trigger, facts).
  function renderPanel() {
    const cat = selectedCat(), ident = $("panel-ident"), bodyHost = $("panel-body");
    if (!cat) { ident.hidden = true; bodyHost.replaceChildren(); return; }
    const who = h("div", "tx"), subLine = h("div", "sub");
    subLine.append(h("span", "model", `${breedLabel(cat.breedId)} · ${cat.demo ? "示例猫猫" : "样页新建"}`));
    who.append(h("b", "", cat.name), subLine);
    ident.replaceChildren(portrait(cat.breedId, "lg"), who);
    ident.hidden = false;
    const c = cat.config, tpl = cat.source.kind === "template" ? templateOf(cat.source.templateId) : null;
    const wrap = h("div", "tab-body tl-detail");
    const sec = (title, ...nodes) => { const s = h("div", "psec"); s.append(h("h4", "", title), ...nodes); wrap.append(s); return s; };
    if (c.portrait.roleDescription) sec("职责", h("p", "", c.portrait.roleDescription));
    const agent = h("div", "binding-trigger"), tx = h("span", "bt-tx");
    tx.append(h("strong", "bt-model agent-label", cat.agentLabel), h("span", "bt-sub", "示例 Agent · 只保存配置，不会启动它"));
    agent.append(tx);
    sec("执行 Agent", agent);
    const from = (id) => (cat.changed.includes(id) ? "创建时微调" : cat.source.kind === "template" ? "来自模板" : "从零设置");
    const facts = h("dl", "agent-facts"), fact = (k, v) => facts.append(h("dt", "", k), h("dd", "", v));
    fact("模型", c.model.mode === "explicit" ? `${c.model.value} · ${from("model")}` : `跟随 Agent 默认 · 创建时示例默认 ${cat.agentDefaultModel || "未读到"}`);
    fact("推理强度", cat.effortState === "unsupported" ? "不单独设置（Agent 不支持，示例）"
      : c.effort.mode === "explicit" ? `${c.effort.value} · ${from("effort")}` + (cat.effortState === "unconfirmed" ? " · 待验证" : "") : "跟随 Agent 默认");
    fact("猫种", cat.breedHow === "auto" ? `${breedLabel(cat.breedId)} · 创建时按模型 ${cat.breedModel} 判断为 ${cat.breedFamily} 系列，之后不随模型变化` : `${breedLabel(cat.breedId)} · 手动指定`);
    sec("配置（创建时复制的一份）", facts);
    for (const [label, value] of [["性格", c.portrait.personality], ["擅长", c.portrait.teamStrengths], ["提醒", c.portrait.caution]]) {
      if (String(value || "").trim()) sec(label, h("p", "", value));
    }
    if ((c.strengths || []).length) { const tags = h("div", "tl-tags"); for (const s of c.strengths) tags.append(tag(s)); sec("上游擅长标签", tags); }

    const box = h("div", "tl-box");
    if (cat.source.kind !== "template") box.append(h("p", "", "从零创建，没有来源模板。"));
    else {
      box.append(h("p", "", `创建时复制自模板「${cat.source.templateName}」修订 ${cat.source.templateRevision}` + (cat.changed.length ? `，并微调了：${cat.changed.map(M.fieldLabel).join("、")}。` : "，没有微调。")));
      if (!tpl) box.append(h("p", "", "来源模板已删除。这只猫的配置不受影响，来源只作为历史记录保留。"));
      else if (tpl.revision === cat.source.templateRevision) box.append(h("p", "", `模板现在仍是修订 ${tpl.revision}。`));
      else {
        const tc = M.templateConfig(tpl), diffs = M.changedFields(c, tc).filter((f) => f.id !== "breed").map((f) => [f.label, cfgValue(c, f.id, cat), cfgValue(tc, f.id)]);
        const tres = resolveOf(tc);
        if ((tres.breed ? tres.breed.id : null) !== cat.breedId || tres.how !== cat.breedHow) {
          diffs.push(["猫种", breedLabel(cat.breedId) + (cat.breedHow === "auto" ? "（自动）" : "（手动）"), tres.breed ? tres.breed.label + (tres.how === "auto" ? "（自动）" : "（手动）") : "待定"]);
        }
        box.append(h("p", "", `模板已更新到修订 ${tpl.revision}` + (tpl.name !== cat.source.templateName ? `（现名「${tpl.name}」）` : "") + "。改动只影响以后新建，这只猫保持不变" + (diffs.length ? "。和模板现在的差别：" : "，配置项和模板现在一致。")));
        if (diffs.length) {
          const grid = h("div", "tl-diff");
          grid.append(h("span", "th", "这只猫"), h("span", "th", "模板现在"));
          for (const [label, mine, theirs] of diffs) grid.append(h("span", "lbl", label), h("span", "", mine), h("span", "", theirs));
          box.append(grid);
        }
      }
      if (tpl) box.append(btn("text-btn", `在设置 · 模板中查看「${tpl.name}」`, (ev) => openSettings("templates", { templateId: tpl.id, opener: ev.currentTarget })));
    }
    sec("来源模板", box);
    const note = sec("样页", h("p", "psec-weak", "示例身份：没有写入 Clowder AI，也没有会话或运行状态。"));
    note.append(btn("text-btn danger tl-del", "删除这只样页猫猫", (ev) => askDeleteCat(cat, ev.currentTarget)));
    bodyHost.replaceChildren(wrap);
  }
  function cfgValue(config, id, cat) {
    switch (id) {
      case "agent": return cat ? cat.agentLabel : M.agentText(config, app.runtimes, null);
      case "model": return config.model.mode === "explicit" ? config.model.value : "跟随 Agent 默认";
      case "effort": return config.effort.mode === "explicit" ? config.effort.value : "跟随 Agent 默认";
      case "role": return clip(config.portrait.roleDescription, 48) || "（空）";
      case "personality": return clip(config.portrait.personality, 48) || "（空）";
      case "teamStrengths": return clip(config.portrait.teamStrengths, 48) || "（空）";
      case "caution": return clip(config.portrait.caution, 48) || "（空）";
      default: return "";
    }
  }
  function askDeleteCat(cat, opener) {
    layer({ title: `删除样页猫猫「${cat.name}」？`, opener,
      lead: "只从这个样页里移除，不影响模板，也不会碰 clowder-bot 的真实数据。",
      actions: [["", "取消", (L) => L.close()], ["pri", "删除", (L) => {
        L.close(true);
        app.cats = app.cats.filter((x) => x !== cat);
        app.selected = app.cats.length ? (app.cats.find((c) => c.pinned) || app.cats[0]).id : null;
        persist(); panelOpen(false); renderRoster(); renderChat();
        refocus(document.querySelector(".pin.add"));
      }]] });
  }

  // ---------- boot ----------
  function bind() {
    const me = h("span", "avatar me blob");
    me.append(icon("person"));
    $("me-avatar").replaceChildren(me);
    $("account").addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = $("account-menu").hidden;
      closeMenus();
      $("account-menu").hidden = !open;
      $("account").setAttribute("aria-expanded", String(open));
      if (open) $("account-settings").focus();
    });
    $("account-settings").addEventListener("click", () => { closeMenus(); closeDrawer(); openSettings("general", { opener: $("account"), home: true }); });
    document.addEventListener("click", (ev) => {
      if (ev.target.closest(".new-menu, #account-menu, .pin.add, #account")) return;
      closeMenus();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !stack.length && (document.querySelector(".new-menu") || !$("account-menu").hidden)) { ev.preventDefault(); closeMenus(true); }
    });
    $("menu").addEventListener("click", () => {
      sidebar.classList.add("open");
      if (window.innerWidth < 768 && panel.classList.contains("open")) panelOpen(false);
      syncBackdrop();
    });
    backdrop.addEventListener("click", () => { sidebar.classList.remove("open"); panelOpen(false); });
    scrim.addEventListener("click", () => panelOpen(false));
    chip.addEventListener("click", () => {
      const open = !panel.classList.contains("open");
      panelOpen(open);
      if (open && window.innerWidth < 768) closeDrawer();
    });
    window.addEventListener("resize", syncBackdrop);
    input.addEventListener("input", () => input.classList.toggle("is-empty", !input.textContent));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); showToast("交互样页没有接入聊天，消息不会发送。"); }
    });
    $("composer").addEventListener("submit", (ev) => { ev.preventDefault(); showToast("交互样页没有接入聊天，消息不会发送。"); });
    $("settings-theme").addEventListener("change", (ev) => {
      try { sessionStorage.setItem(THEME_KEY, ev.target.value); } catch (e) { /* memory only */ }
      applyTheme();
    });
    media.addEventListener("change", applyTheme);
    $("tl-reset").addEventListener("click", (ev) => layer({
      title: "重置样页？", opener: ev.currentTarget,
      lead: ["恢复三只示例猫猫和全部原生种子，清掉你新建的猫猫和模板修改。", "只影响这个样页在本标签页里的数据，保留本页的主题选择；不会改动应用主题或真实数据。"],
      actions: [["", "取消", (L) => L.close()], ["pri", "重置", (L) => {
        L.close();
        try { sessionStorage.removeItem(KEY); } catch (e) { /* memory only */ }
        freshState(); persist();
        panelOpen(false); renderRoster(); renderChat();
        $("tl-reset-status").textContent = "已重置样页数据。";
      }]],
    }));
  }
  async function boot() {
    applyTheme();
    paintGreeting();
    if (!M || !Avatars) { $("thread").replaceChildren(h("p", "tl-loading", "样页脚本没有加载完整，请刷新。")); return; }
    try {
      const res = await fetch("/template-lab/fixture.json", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      app.fixture = await res.json();
    } catch (e) {
      const inner = h("div", "thread-inner"), box = h("div", "empty");
      box.append(h("h2", "", "没能读取样页数据"), h("p", "", "请通过 clowder-bot 的开发服务打开 /template-lab/index.html，再刷新。"));
      inner.append(box); $("thread").replaceChildren(inner);
      return;
    }
    app.runtimes = app.fixture.sample.runtimes;
    app.seeds = M.seedTemplates(app.fixture);
    for (const b of app.fixture.upstream.breeds) if (!b.relationshipKey && b.nickname) app.nick[b.id] = b.nickname;
    for (const t of app.fixture.upstream.roleTemplates || []) if (t.nickname) app.nick[t.id] = t.nickname;
    if (!restore()) freshState();
    persist();
    bind();
    renderRoster(); renderChat();
  }
  boot();
})();
