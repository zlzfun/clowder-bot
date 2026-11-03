// 猫猫模板交互样页 · 规则层：没有 DOM，也没有网络。
// Follows docs/cat-templates-design.md: a template is a versioned configuration
// snapshot; model and effort are tagged choices (inherit | explicit); the breed
// is auto (model family) or explicit; native breed IDs stay separate from
// template IDs and from cat-avatars.js portrait aliases.
(function (root) {
  "use strict";

  // Native breed IDs. `avatar` is the portrait alias in cat-avatars.js, display only.
  const BREEDS = Object.freeze([
    { id: "ragdoll", label: "布偶猫", avatar: "ragdoll", family: "claude" },
    { id: "maine-coon", label: "缅因猫", avatar: "maine-coon", family: "gpt" },
    { id: "siamese", label: "暹罗猫", avatar: "siamese", family: "gemini" },
    { id: "dragon-li", label: "狸花猫", avatar: "dragon-li", family: "glm" },
    { id: "moonshot", label: "梵花猫", avatar: "turkish-van", family: "kimi" },
    { id: "bengal", label: "孟加拉猫", avatar: "bengal", family: null, carrier: true },
    { id: "golden-chinchilla", label: "金渐层", avatar: "golden-chinchilla", family: null, carrier: true },
    { id: "dsh", label: "蓝灰短毛猫", avatar: "dsh", family: null },
  ].map(Object.freeze));

  // Families decide the default breed; versions and sub-series never do.
  const FAMILIES = Object.freeze([
    { id: "claude", label: "Claude", breedId: "ragdoll", pattern: /claude|opus|sonnet|haiku|fable/i },
    { id: "gpt", label: "GPT/Codex", breedId: "maine-coon", pattern: /gpt|codex/i },
    { id: "gemini", label: "Gemini", breedId: "siamese", pattern: /gemini/i },
    { id: "glm", label: "GLM", breedId: "dragon-li", pattern: /glm/i },
    { id: "kimi", label: "Kimi", breedId: "moonshot", pattern: /kimi|moonshot/i },
  ].map(Object.freeze));
  const FAMILY_RULE = "Claude → 布偶猫，GPT/Codex → 缅因猫，Gemini → 暹罗猫，GLM → 狸花猫，Kimi → 梵花猫；只看系列，不看版本";
  // Upstream role templates with no breed entry map to a breed by this table only.
  const ROLE_TEMPLATE_BREEDS = Object.freeze({ dsh: "dsh" });

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const inherit = () => ({ mode: "inherit" });
  const explicit = (value) => ({ mode: "explicit", value });
  const trim = (value) => String(value == null ? "" : value).trim();
  const breedOf = (id) => BREEDS.find((b) => b.id === id) || null;
  const runtimeOf = (runtimes, id) => (runtimes || []).find((r) => r.id === id) || null;

  function familyOf(model) {
    const value = trim(model);
    if (!value) return { family: null, code: "empty" };
    const hits = FAMILIES.filter((f) => f.pattern.test(value));
    if (hits.length === 1) return { family: hits[0], code: "ok" };
    return { family: null, code: hits.length ? "ambiguous" : "unknown" };
  }

  // The model a configuration will ask for: its own explicit value, or the Agent's sample default.
  function effectiveModel(config, runtime) {
    if (config.model && config.model.mode === "explicit") return { value: trim(config.model.value), source: "explicit" };
    if (!runtime) return { value: "", source: "no_agent" };
    return runtime.defaultModel ? { value: runtime.defaultModel, source: "agent_default" } : { value: "", source: "agent_unknown" };
  }

  function resolveBreed(config, runtime) {
    const choice = config.breed || { mode: "auto" };
    if (choice.mode === "explicit") {
      const breed = breedOf(choice.breedId);
      return breed ? { breed, how: "explicit" } : { breed: null, how: "explicit", code: "unset" };
    }
    const model = effectiveModel(config, runtime);
    if (!model.value) return { breed: null, how: "auto", code: model.source, model };
    const found = familyOf(model.value);
    if (!found.family) return { breed: null, how: "auto", code: found.code, model };
    return { breed: breedOf(found.family.breedId), how: "auto", family: found.family, model };
  }

  function breedProblem(res, runtime) {
    if (res.how === "explicit") return "选一个猫种。";
    const name = runtime ? runtime.label : "Agent";
    switch (res.code) {
      case "no_agent": return "还没选 Agent，也没指定模型，没法按模型系列判断猫种。请先选 Agent，或手动指定猫种。";
      case "agent_unknown": return `模型跟随 ${name} 默认，但示例数据里没有它的默认模型，没法自动判断。请指定模型，或手动指定猫种。`;
      case "empty": return "先填写模型，或手动指定猫种。";
      case "ambiguous": return `模型 ${res.model.value} 同时像多个系列，没法自动判断。请手动指定猫种。`;
      default: return `模型 ${res.model ? res.model.value : ""} 不属于已知系列，没法自动判断。请手动指定猫种。`;
    }
  }

  // Effort capability is separate from the saved choice: supported values,
  // explicitly unsupported, or unconfirmed (a model outside the sample list is never assumed to support it).
  function effortCapability(config, runtime) {
    if (!runtime) return { state: "no_agent" };
    const cap = runtime.effort || {};
    if (cap.state === "unsupported") return { state: "unsupported" };
    const model = effectiveModel(config, runtime);
    if (model.source === "explicit" && model.value && !(runtime.models || []).includes(model.value)) return { state: "unconfirmed", reason: "model" };
    if (cap.state === "supported" && Array.isArray(cap.values) && cap.values.length) return { state: "supported", values: cap.values.slice() };
    return { state: "unconfirmed", reason: "agent" };
  }

  // After the Agent or the model changed: overrides the new pair cannot take are
  // cleared to inherit, never swapped for a nearby value. Unconfirmed values stay.
  function reconcile(config, runtimes, changed) {
    const next = clone(config), notes = [];
    const runtime = runtimeOf(runtimes, next.runtimeId), name = runtime ? runtime.label : "所选 Agent";
    if (changed === "runtime" && next.model.mode === "explicit") {
      const value = trim(next.model.value);
      if (!runtime || !(runtime.models || []).includes(value)) {
        if (value) notes.push(`已清除模型 ${value}：它不在 ${name} 的选项里（示例），改为跟随 ${name} 默认。`);
        next.model = inherit();
      }
    }
    if (next.effort.mode === "explicit") {
      const value = trim(next.effort.value), cap = effortCapability(next, runtime);
      if (cap.state === "unsupported") {
        if (value) notes.push(`已清除推理强度 ${value}：${name} 不支持单独设置（示例），创建时不传这个参数。`);
        next.effort = inherit();
      } else if (cap.state === "supported" && value && !cap.values.includes(value)) {
        notes.push(`已清除推理强度 ${value}：${name} 不提供这个值（示例），没有自动换成别的档位。`);
        next.effort = inherit();
      }
    }
    return { config: next, notes };
  }

  // `blocking` issues stop creation. A template can still be saved as a draft
  // unless the issue is a malformed field.
  function issues(config, runtimes, carrier) {
    const list = [], runtime = runtimeOf(runtimes, config.runtimeId);
    const add = (field, code, blocking, short, text, draftOk) => list.push({ field, code, blocking, short, text, draftOk: !!draftOk });
    if (!config.runtimeId) {
      if (carrier && carrier.kind === "cloud") add("agent", "cloud", true, "云端席位", carrier.note + "。选一个本机 Agent 才能创建。", true);
      else if (carrier && carrier.kind === "role_only") add("agent", "no_agent", true, "需选 Agent", "上游只提供画像，没有附带 Agent。选一个 Agent 才能创建。", true);
      else add("agent", "no_agent", true, "需选 Agent", "还没选 Agent。", true);
    } else if (!runtime) add("agent", "unknown_agent", true, "Agent 不存在", "示例数据里没有这个 Agent。", true);
    else if (!runtime.adapted) add("agent", "not_adapted", true, "Agent 未适配", `${runtime.label}：${runtime.unadaptedReason}，不能用来创建。`, true);

    if (config.model.mode === "explicit") {
      const value = trim(config.model.value);
      if (!value) add("model", "empty", true, "缺模型", "填写模型 ID，或改回「跟随 Agent 默认」。");
      else if (value.length > 120) add("model", "long", true, "模型过长", "模型 ID 最多 120 个字符。");
      else if (runtime && !(runtime.models || []).includes(value)) add("model", "unverified", false, "模型待验证", `模型 ${value} 不在 ${runtime.label} 的示例选项里，按待验证处理；正式创建时由原生确认。`);
    }
    if (config.effort.mode === "explicit") {
      const value = trim(config.effort.value), cap = effortCapability(config, runtime);
      if (!value) add("effort", "empty", true, "缺推理强度", "填写推理强度，或改回「跟随 Agent 默认」。");
      else if (!/^[A-Za-z0-9._-]{1,24}$/.test(value)) add("effort", "format", true, "推理强度格式", "推理强度只用字母、数字和 . _ -，比如 high、max。");
      else if (cap.state === "unsupported") add("effort", "unsupported", false, "推理强度不生效", `${runtime.label} 不支持单独设置推理强度（示例），${value} 不会传给它。`);
      else if (cap.state === "supported" && !cap.values.includes(value)) add("effort", "not_offered", true, "推理强度不可用", `${runtime.label} 不提供 ${value}（示例）。`);
      else if (cap.state === "unconfirmed") add("effort", "unverified", false, "推理强度待验证", `推理强度 ${value} 是否支持还没确认，保留原值待验证，不会被自动降档。`);
    }
    const breed = resolveBreed(config, runtime);
    if (!breed.breed) add("breed", "breed_unresolved", true, "需定猫种", breedProblem(breed, runtime), breed.how !== "explicit");
    if (!trim(config.portrait.roleDescription)) add("role", "empty", true, "缺职责", "写一句职责：它负责什么。");
    return list;
  }

  function status(list) {
    const blocking = list.filter((i) => i.blocking);
    if (blocking.some((i) => ["not_adapted", "cloud", "unknown_agent"].includes(i.code))) return "unsupported";
    if (blocking.length) return "needs_configuration";
    return list.length ? "unknown" : "ready";
  }

  const templateConfig = (t) => clone({ runtimeId: t.runtimeId, model: t.model, effort: t.effort, breed: t.breed, portrait: t.portrait, strengths: t.strengths || [] });

  // One template per upstream variant, plus role templates that have no breed.
  function seedTemplates(fixture) {
    const up = fixture.upstream, commit = fixture.provenance.upstream.commit, out = [];
    const carrierOf = (v) => (fixture.sample.carriers || []).find((c) => c.clientId === v.clientId && (c.cli === undefined || c.cli === !!v.hasCli)) || null;
    for (const breed of up.breeds) {
      const familyBreed = breed.relationshipKey || breed.id;
      const variants = breed.variants.slice().sort((a, b) => Number(b.id === breed.defaultVariantId) - Number(a.id === breed.defaultVariantId));
      for (const v of variants) {
        const isDefault = v.id === breed.defaultVariantId, carrier = carrierOf(v), fam = familyOf(v.defaultModel).family;
        out.push({
          id: "tpl-s" + String(out.length + 1).padStart(2, "0"),
          revision: 1,
          name: isDefault ? breed.name : (v.name || (breed.displayName || breed.name) + " " + (v.variantLabel || v.id)),
          nameHint: v.nickname || breed.nickname || "",
          runtimeId: carrier ? carrier.runtimeId : null,
          model: v.defaultModel ? explicit(v.defaultModel) : inherit(),
          effort: v.effort ? explicit(v.effort) : inherit(),
          // A seed whose model family already gives its upstream breed stays auto; carriers keep an explicit identity.
          breed: fam && fam.breedId === familyBreed ? { mode: "auto" } : { mode: "explicit", breedId: familyBreed },
          portrait: {
            roleDescription: v.roleDescription || breed.roleDescription || "",
            personality: v.personality || "",
            teamStrengths: v.teamStrengths || breed.teamStrengths || "",
            caution: (v.caution !== undefined ? v.caution : breed.caution) || "",
          },
          strengths: Array.isArray(v.strengths) ? v.strengths.slice() : [],
          source: {
            kind: "native-seed", upstreamCommit: commit, breedId: breed.id, variantId: v.id,
            catId: v.catId || breed.catId || "", variantLabel: v.variantLabel || "", clientId: v.clientId,
            familyDefault: isDefault && !breed.relationshipKey, upstreamBreed: familyBreed,
            carrier: carrier && carrier.kind ? { kind: carrier.kind, note: carrier.note } : null,
          },
          modified: false, updatedAt: 0,
        });
      }
    }
    for (const t of up.roleTemplates || []) {
      out.push({
        id: "tpl-s" + String(out.length + 1).padStart(2, "0"), revision: 1, name: t.name, nameHint: t.nickname || "",
        runtimeId: null, model: inherit(), effort: inherit(),
        breed: ROLE_TEMPLATE_BREEDS[t.id] ? { mode: "explicit", breedId: ROLE_TEMPLATE_BREEDS[t.id] } : { mode: "auto" },
        portrait: { roleDescription: t.roleDescription || "", personality: t.personality || "", teamStrengths: t.teamStrengths || "", caution: "" },
        strengths: [],
        source: { kind: "native-seed", upstreamCommit: commit, roleTemplateId: t.id, breedId: null, variantId: null, catId: "", variantLabel: "",
          familyDefault: true, upstreamBreed: ROLE_TEMPLATE_BREEDS[t.id] || null,
          carrier: { kind: "role_only", note: "上游只提供画像（roleTemplates），没有 Agent、模型或推理强度预设" } },
        modified: false, updatedAt: 0,
      });
    }
    return out;
  }

  // Display text shared by the list, the creation summary and the cat card.
  function agentText(config, runtimes, carrier) {
    const runtime = runtimeOf(runtimes, config.runtimeId);
    if (runtime) return runtime.label;
    if (carrier && carrier.kind === "cloud") return "云端席位（不是本机 Agent）";
    return "未选 Agent";
  }
  function modelText(config, runtimes) {
    if (config.model.mode === "explicit") return trim(config.model.value) || "（未填写）";
    const runtime = runtimeOf(runtimes, config.runtimeId);
    if (!runtime) return "跟随 Agent 默认";
    return `跟随 ${runtime.label} 默认` + (runtime.defaultModel ? `（示例：${runtime.defaultModel}）` : "（示例数据未读到默认值）");
  }
  function effortText(config, runtimes) {
    const runtime = runtimeOf(runtimes, config.runtimeId), cap = effortCapability(config, runtime);
    if (cap.state === "unsupported") return "不单独设置（Agent 不支持）";
    if (config.effort.mode === "explicit") return trim(config.effort.value) + (cap.state === "unconfirmed" ? "（待验证）" : "");
    return runtime ? `跟随 ${runtime.label} 默认` : "跟随 Agent 默认";
  }
  function breedText(config, runtimes) {
    const runtime = runtimeOf(runtimes, config.runtimeId), res = resolveBreed(config, runtime);
    if (!res.breed) return res.how === "auto" ? "待定（无法自动判断）" : "待定";
    return res.breed.label + (res.how === "auto" ? `（自动 · ${res.family.label} 系列）` : "（手动指定）");
  }
  function summary(config, runtimes, carrier) {
    const parts = [agentText(config, runtimes, carrier), config.model.mode === "explicit" ? trim(config.model.value) : "默认模型"];
    if (config.effort.mode === "explicit") parts.push("推理强度 " + trim(config.effort.value));
    return parts.join(" · ");
  }

  const FIELDS = Object.freeze([
    ["agent", "Agent", (c) => c.runtimeId || ""],
    ["model", "模型", (c) => (c.model.mode === "explicit" ? "=" + trim(c.model.value) : "inherit")],
    ["effort", "推理强度", (c) => (c.effort.mode === "explicit" ? "=" + trim(c.effort.value) : "inherit")],
    ["breed", "猫种", (c) => (c.breed.mode === "explicit" ? "=" + (c.breed.breedId || "") : "auto")],
    ["role", "职责", (c) => trim(c.portrait.roleDescription)],
    ["personality", "性格", (c) => trim(c.portrait.personality)],
    ["teamStrengths", "擅长", (c) => trim(c.portrait.teamStrengths)],
    ["caution", "提醒", (c) => trim(c.portrait.caution)],
  ]);
  const changedFields = (a, b) => FIELDS.filter(([, , get]) => get(a) !== get(b)).map(([id, label]) => ({ id, label }));
  const fieldLabel = (id) => (FIELDS.find((f) => f[0] === id) || [id, id])[1];

  function nameProblem(name, taken, max, what) {
    const value = trim(name);
    if (!value) return what === "template" ? "给模板起个名字。" : "给这只猫起个名字。";
    if ([...value].length > max) return `名字最多 ${max} 个字。`;
    if ([...value].some((ch) => ch.codePointAt(0) < 32)) return "名字里不能有控制字符。";
    if ((taken || []).some((n) => trim(n).toLowerCase() === value.toLowerCase())) {
      return what === "template" ? `模板库里已有「${value}」，换个名字吧。` : `样页里已经有「${value}」了，换个名字吧。`;
    }
    return "";
  }
  function freeName(base, taken) {
    const used = new Set((taken || []).map((n) => trim(n).toLowerCase())), clean = trim(base);
    if (!clean) return "";
    if (!used.has(clean.toLowerCase())) return clean;
    for (let i = 2; i < 1000; i++) if (!used.has((clean + " " + i).toLowerCase())) return clean + " " + i;
    return clean + " " + Date.now();
  }
  function nameSuggestions(hints, taken) {
    const out = [];
    for (const hint of hints) {
      const name = freeName(hint, taken);
      if (name && !out.includes(name)) out.push(name);
    }
    return out.slice(0, 3);
  }

  // A cat keeps a deep copy of its effective choices; the template is provenance only.
  function instantiate({ id, name, now, template, config, runtimes }) {
    const runtime = runtimeOf(runtimes, config.runtimeId), breed = resolveBreed(config, runtime);
    return {
      id, name: trim(name), createdAt: now, config: clone(config),
      breedId: breed.breed.id, breedHow: breed.how,
      breedFamily: breed.family ? breed.family.label : null, breedModel: breed.model ? breed.model.value : null,
      agentLabel: runtime ? runtime.label : "", agentDefaultModel: runtime ? runtime.defaultModel || null : null,
      effortState: effortCapability(config, runtime).state,
      source: template
        ? { kind: "template", templateId: template.id, templateRevision: template.revision, templateName: template.name }
        : { kind: "custom" },
      changed: template ? changedFields(config, templateConfig(template)).map((f) => f.id) : [],
    };
  }

  root.ClowderTemplateModel = Object.freeze({
    BREEDS, FAMILIES, FAMILY_RULE, clone, inherit, explicit, breedOf, runtimeOf, familyOf, effectiveModel,
    resolveBreed, breedProblem, effortCapability, reconcile, issues, status, templateConfig, seedTemplates,
    agentText, modelText, effortText, breedText, summary, changedFields, fieldLabel, nameProblem, freeName,
    nameSuggestions, instantiate,
  });
})(typeof window !== "undefined" ? window : globalThis);
