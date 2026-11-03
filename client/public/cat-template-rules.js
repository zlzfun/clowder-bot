// 猫猫模板 · 规则层：没有 DOM，也没有网络。cat-templates.js 和测试共用。
// Data shapes follow /xbot-api/cat-templates (CatConfig, CatTemplate, Breed) and
// the native runtime-models answer of /xbot-api/agents/:id/models. Model and
// effort are tagged choices (inherit | explicit); the breed is auto (model
// family, never the Agent or the version) or an explicit native breed ID.
(function (root) {
  "use strict";

  const trim = (value) => String(value == null ? "" : value).trim();
  const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
  const inherit = () => ({ mode: "inherit" });
  const explicit = (value) => ({ mode: "explicit", value: String(value) });
  const hasControl = (text) => [...String(text)].some((ch) => ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127);

  // Native breed ID → portrait in cat-avatars.js. Display only, never sent.
  const AVATAR_ALIAS = Object.freeze({ moonshot: "turkish-van" });
  const avatarOf = (breedId) => (breedId ? AVATAR_ALIAS[breedId] || breedId : null);

  // Model family → default native breed. Sub-series and versions never matter.
  // Same expressions as the native inferBotCatBreed (patches/0005), applied to
  // the trimmed lowercase model; exactly one family must match.
  const FAMILIES = Object.freeze([
    ["ragdoll", /(?:claude|\bopus\b|\bsonnet\b|\bhaiku\b|\bfable\b)/],
    ["maine-coon", /(?:\bgpt(?:-|\b)|\bcodex\b|^o[134](?:-|$))/],
    ["siamese", /gemini/],
    ["dragon-li", /(?:\bglm(?:-|\b)|zhipu\/)/],
    ["moonshot", /(?:kimi|moonshot)/],
    ["dsh", /(?:deepseek|\bdsh\b)/],
  ]);
  function familyBreed(model) {
    const value = trim(model).toLowerCase();
    if (!value) return { breedId: null, code: "empty" };
    const hits = [...new Set(FAMILIES.filter(([, re]) => re.test(value)).map(([id]) => id))];
    if (hits.length === 1) return { breedId: hits[0], code: "ok" };
    return { breedId: null, code: hits.length ? "ambiguous" : "unknown" };
  }

  // ---- DTO normalisation: unknown portrait fields (strengths…) ride along ----
  const choice = (raw) => (raw && raw.mode === "explicit" && typeof raw.value === "string" ? explicit(raw.value) : inherit());
  const breedChoice = (raw) => (raw && raw.mode === "explicit" && typeof raw.breedId === "string" && raw.breedId
    ? { mode: "explicit", breedId: raw.breedId } : { mode: "auto" });
  function portrait(raw) {
    const p = raw && typeof raw === "object" && !Array.isArray(raw) ? clone(raw) : {};
    if (typeof p.roleDescription !== "string") p.roleDescription = "";
    return p;
  }
  function config(raw) {
    raw = raw || {};
    return {
      runtimeId: typeof raw.runtimeId === "string" && raw.runtimeId ? raw.runtimeId : null,
      breed: breedChoice(raw.breed), model: choice(raw.model), effort: choice(raw.effort), portrait: portrait(raw.portrait),
    };
  }
  function template(raw) {
    raw = raw || {};
    return {
      id: String(raw.id || ""), revision: typeof raw.revision === "number" || typeof raw.revision === "string" ? raw.revision : 0,
      name: typeof raw.name === "string" ? raw.name : "", nameHint: typeof raw.nameHint === "string" ? raw.nameHint : "",
      source: raw.source && typeof raw.source === "object" ? clone(raw.source) : { kind: "user" },
      ...config(raw),
    };
  }
  const configOf = (t) => config(t);
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
    return JSON.stringify(value === undefined ? null : value);
  }
  const sameConfig = (a, b) => stable(config(a)) === stable(config(b));

  // ---- Agents (the /xbot-api/agents DTO) ----
  const READY = ["configured", "login_required", "unknown", "not_installed"];
  function readiness(agent) {
    const status = agent && agent.readiness && agent.readiness.status;
    return READY.includes(status) ? status : "unknown";
  }
  function selectable(agent) {
    const status = agent && agent.readiness && agent.readiness.status;
    return !!agent && agent.selectable === true && agent.installed === true && agent.supported === true
      && status !== "login_required" && status !== "not_installed";
  }
  // A template may name an installed Agent that still needs a login; a new cat may not.
  const usable = (agent, purpose) => (purpose === "template" ? !!agent && agent.installed === true && agent.supported === true : selectable(agent));
  // Short state next to an Agent name; empty when nothing needs saying.
  function agentTag(agent) {
    if (!agent) return "不可用";
    const status = readiness(agent);
    if (agent.installed !== true || status === "not_installed") return "未检测到";
    if (agent.supported !== true) return "暂未适配";
    if (status === "login_required") return "需要登录";
    if (agent.selectable !== true) return "暂不可选";
    return status === "unknown" ? "未确认登录" : "";
  }
  function preferredAgent(agents) {
    const open = (agents || []).filter(selectable);
    return open.find((a) => readiness(a) === "configured") || open[0] || null;
  }
  const agentOf = (agents, id) => (id && (agents || []).find((a) => a && a.id === id)) || null;
  const agentLabel = (agents, id) => { const a = agentOf(agents, id); return a ? a.label || a.id : id || ""; };

  // ---- runtime-models answers: [{query, data}], the plain query ("") first ----
  const answered = (a) => !!a && !!a.data && typeof a.data === "object" && a.data.status !== "unavailable";
  function modelOptions(answers) {
    const out = [], seen = new Set();
    for (const a of (answers || []).filter(answered)) {
      for (const m of Array.isArray(a.data.models) ? a.data.models : []) {
        if (!m || typeof m.value !== "string" || !m.value || seen.has(m.value)) continue;
        seen.add(m.value);
        out.push({ value: m.value, label: typeof m.label === "string" && m.label ? m.label : m.value });
      }
    }
    return out;
  }
  // The model an inheriting configuration will ask for, when native says so.
  function defaultModel(answers, agent) {
    const base = (answers || []).find((a) => a && a.query === "" && answered(a));
    return trim(base && (base.data.defaultModel || base.data.selectedModel)) || trim(agent && agent.configuredModel) || "";
  }
  function defaultEffort(answers, agent) {
    const base = (answers || []).find((a) => a && a.query === "" && answered(a));
    return trim(base && base.data.defaultEffort) || trim(agent && agent.configuredEffort) || "";
  }
  function levels(list) {
    if (!list.length) return { state: "unsupported" };
    const values = list.filter((e) => e && typeof e.value === "string" && e.value)
      .map((e) => ({ value: e.value, label: typeof e.label === "string" && e.label ? e.label : e.value }));
    return values.length ? { state: "supported", values } : { state: "unknown" };
  }
  // A model's own efforts first, then effortOptions of the answer that was asked
  // about this model. Missing means unknown; an explicit empty list, unsupported.
  function effortCapability(cfg, answers, agent) {
    if (!cfg.runtimeId) return { state: "no_agent" };
    const list = (answers || []).filter(answered);
    const fallback = defaultModel(answers, agent);
    const isExplicit = cfg.model.mode === "explicit" && !!trim(cfg.model.value);
    const target = isExplicit ? trim(cfg.model.value) : fallback;
    if (target) {
      for (const a of list) {
        const entry = (Array.isArray(a.data.models) ? a.data.models : []).find((m) => m && m.value === target);
        if (entry && Array.isArray(entry.efforts)) return levels(entry.efforts);
      }
    }
    const subject = list.find((a) => a.query === (isExplicit ? target : ""))
      || (isExplicit && target === fallback ? list.find((a) => a.query === "") : null);
    if (subject && Array.isArray(subject.data.effortOptions)) return levels(subject.data.effortOptions);
    return { state: "unknown" };
  }
  // An explicit effort the model is known not to take goes back to the default,
  // never to a neighbouring value. Unknown capability keeps it.
  function reconcileEffort(cfg, cap) {
    const value = cfg.effort.mode === "explicit" ? trim(cfg.effort.value) : "";
    if (!value) return { config: cfg, cleared: "" };
    const drop = cap.state === "unsupported" || (cap.state === "supported" && !cap.values.some((v) => v.value === value));
    return drop ? { config: { ...cfg, effort: inherit() }, cleared: value } : { config: cfg, cleared: "" };
  }
  // Another Agent: its own default model and effort; the portrait and an explicit breed stay.
  function changeAgent(cfg, runtimeId) {
    const next = config(cfg);
    next.runtimeId = runtimeId || null;
    next.model = inherit();
    next.effort = inherit();
    return next;
  }

  // ---- breed ----
  function resolveBreed(cfg, ctx) {
    ctx = ctx || {};
    if (cfg.breed.mode === "explicit") return { breedId: cfg.breed.breedId, how: "explicit", code: "ok" };
    const own = cfg.model.mode === "explicit" ? trim(cfg.model.value) : "";
    const model = own || (cfg.runtimeId ? trim(ctx.defaultModel) : "");
    const found = familyBreed(model);
    if (!found.breedId) return { breedId: null, how: "auto", code: found.code, model };
    const known = Array.isArray(ctx.breeds) && ctx.breeds.length ? ctx.breeds.some((b) => b && b.id === found.breedId) : true;
    return known ? { breedId: found.breedId, how: "auto", code: "ok", model } : { breedId: null, how: "auto", code: "unknown", model };
  }
  const breedName = (breeds, id) => { const b = id && (breeds || []).find((x) => x && x.id === id); return b ? b.name || b.id : id || ""; };

  // ---- validation (short field errors) ----
  const CAT_NAME = /^[\p{L}\p{N}_ .-]+$/u;
  const EFFORT = /^[A-Za-z0-9._-]{1,32}$/;
  function catNameProblem(name, taken) {
    const value = trim(name);
    if (!value) return "填写名字";
    if ([...value].length > 64) return "名字最多 64 个字";
    if (!CAT_NAME.test(value)) return "名字只能用文字、数字、空格和 _ . -";
    if ((taken || []).some((n) => trim(n) === value)) return "已有同名猫猫";
    return "";
  }
  function templateNameProblem(name) {
    const value = trim(name);
    if (!value) return "填写模板名称";
    if ([...value].length > 60) return "名称最多 60 个字";
    if (hasControl(value)) return "名称里有不支持的字符";
    return "";
  }
  // ctx: {purpose:'create'|'template', agents|null (null = not read), breeds, defaultModel, cap}
  function configIssues(cfg, ctx) {
    ctx = ctx || {};
    const out = [], create = ctx.purpose === "create";
    if (create) {
      if (!cfg.runtimeId) out.push({ field: "agent", text: "选择 Agent" });
      else if (Array.isArray(ctx.agents) && !selectable(agentOf(ctx.agents, cfg.runtimeId))) out.push({ field: "agent", text: "这个 Agent 暂不可用" });
    }
    if (cfg.model.mode === "explicit") {
      const value = trim(cfg.model.value);
      if (value.length > 512 || hasControl(value)) out.push({ field: "model", text: "模型名称无效" });
    }
    if (cfg.effort.mode === "explicit") {
      const value = trim(cfg.effort.value), cap = ctx.cap || { state: "unknown" };
      if (value && !EFFORT.test(value)) out.push({ field: "effort", text: "只能用字母、数字和 . _ -" });
      else if (value && cap.state === "supported" && !cap.values.some((v) => v.value === value)) out.push({ field: "effort", text: "当前模型不支持 " + value });
    }
    // Asked only when there is a list to choose from; never guessed from the Agent.
    if (create && Array.isArray(ctx.breeds) && ctx.breeds.length && !resolveBreed(cfg, ctx).breedId) out.push({ field: "breed", text: "选择猫种" });
    return out;
  }

  // ---- request bodies ----
  const TEXT = ["roleDescription", "personality", "teamStrengths", "caution"];
  function catConfig(cfg, cap) {
    const c = config(cfg);
    if (c.model.mode === "explicit") { const v = trim(c.model.value); c.model = v ? explicit(v) : inherit(); }
    if (c.effort.mode === "explicit") {
      const v = trim(c.effort.value);
      const refused = cap && (cap.state === "unsupported" || (cap.state === "supported" && !cap.values.some((x) => x.value === v)));
      c.effort = v && !refused ? explicit(v) : inherit();
    }
    // Untouched non-text values (a null caution, strengths…) are sent back as they came.
    for (const key of TEXT) if (typeof c.portrait[key] === "string") c.portrait[key] = c.portrait[key].trim();
    return c;
  }
  function templateBody(draft, cap) {
    const c = catConfig(draft, cap);
    return { name: trim(draft.name), nameHint: trim(draft.nameHint), runtimeId: c.runtimeId, breed: c.breed, model: c.model, effort: c.effort, portrait: c.portrait };
  }
  // `faces` lists the portrait IDs that exist; a breed without one sends no seed.
  function createBody({ name, cfg, cap, source, breedId, faces }) {
    const body = { name: trim(name), catConfig: catConfig(cfg, cap) };
    if (source && source.id) body.sourceTemplate = { id: source.id, revision: source.revision };
    const face = avatarOf(breedId);
    if (face && (faces || []).includes(face)) body.avatar_seed = "cat:" + face;
    return body;
  }

  // ---- text ----
  function summary(cfg, ctx) {
    ctx = ctx || {};
    const parts = [cfg.runtimeId ? agentLabel(ctx.agents, cfg.runtimeId) : "未选 Agent"];
    parts.push(cfg.model.mode === "explicit" && trim(cfg.model.value) ? trim(cfg.model.value) : "默认模型");
    if (cfg.effort.mode === "explicit" && trim(cfg.effort.value)) parts.push(trim(cfg.effort.value));
    return parts.join(" · ");
  }
  // A breed's name only when the catalog names that ID. Older native cats can
  // carry a synthetic breed ID (bot-…); an ID is never shown as a name.
  function knownBreedName(breeds, id) {
    const b = id && (breeds || []).find((x) => x && x.id === id);
    return b && typeof b.name === "string" ? trim(b.name) : "";
  }
  // Rows for a cat's detail: what was copied into it, no provenance. Without a
  // known breed name the 猫种 row is left out; the stored ID is not touched.
  function describe(cfg, ctx) {
    ctx = ctx || {};
    const c = config(cfg), breed = resolveBreed(c, ctx);
    const rows = [
      ["Agent", c.runtimeId ? agentLabel(ctx.agents, c.runtimeId) : "未选"],
      ["模型", c.model.mode === "explicit" && trim(c.model.value) ? trim(c.model.value) : "默认"],
      ["推理强度", c.effort.mode === "explicit" && trim(c.effort.value) ? trim(c.effort.value) : "默认"],
    ];
    const name = breed.breedId ? knownBreedName(ctx.breeds, breed.breedId) : "";
    if (name) rows.push(["猫种", name]);
    return rows;
  }
  function matches(t, query, ctx) {
    const q = trim(query).toLowerCase();
    if (!q) return true;
    const breed = resolveBreed(t, ctx);
    return [t.name, t.nameHint, summary(t, ctx), breed.breedId ? breedName(ctx && ctx.breeds, breed.breedId) : "", t.portrait && t.portrait.roleDescription]
      .join(" ").toLowerCase().includes(q);
  }
  function freeName(base, taken) {
    const name = trim(base), used = new Set((taken || []).map(trim));
    if (!name || !used.has(name)) return name;
    for (let i = 2; i < 100; i++) if (!used.has(name + " " + i)) return name + " " + i;
    return name;
  }
  // The server's own Chinese words first; otherwise the caller's short fallback.
  function errorText(err, fallback) {
    const message = String((err && err.message) || "");
    return /\p{Script=Han}/u.test(message) ? message : fallback;
  }

  root.ClowderCatTemplateRules = Object.freeze({
    trim, clone, inherit, explicit, avatarOf, familyBreed, config, template, configOf, sameConfig,
    fingerprint: stable, readiness, selectable, usable, agentTag, preferredAgent, agentOf, agentLabel,
    modelOptions, defaultModel, defaultEffort, effortCapability, reconcileEffort, changeAgent,
    resolveBreed, breedName, catNameProblem, templateNameProblem, configIssues,
    catConfig, templateBody, createBody, summary, describe, matches, freeName, errorText,
  });
})(typeof window !== "undefined" ? window : globalThis);
