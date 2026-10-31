(function (root) {
  "use strict";
  // One original 4 × 2 sheet is shared by every portrait; no large per-cat copies.
  const presets = Object.freeze([
    { id: "ragdoll", label: "布偶猫", nickname: "宪宪" },
    { id: "maine-coon", label: "缅因猫", nickname: "砚砚" },
    { id: "siamese", label: "暹罗猫", nickname: "烁烁" },
    { id: "turkish-van", label: "梵花猫", nickname: "墨墨" },
    { id: "dsh", label: "蓝灰短毛猫", nickname: "鲸鲸" },
    { id: "dragon-li", label: "狸花猫", nickname: "小狸花" },
    { id: "bengal", label: "孟加拉猫", nickname: "斑斑" },
    { id: "golden-chinchilla", label: "金渐层", nickname: "金哥" },
  ].map(Object.freeze));
  const ids = presets.map((cat) => cat.id);
  const sheet = Object.freeze({ url: "/avatars/clay-cats.png", width: 1774, height: 887, cell: 443.5 });
  const ns = "http://www.w3.org/2000/svg";
  let clipCount = 0;

  function resolveBreed(seed, templateId, name) {
    const explicit = String(seed || "").replace(/^cat:/, "");
    if (String(seed || "").startsWith("cat:") && ids.includes(explicit)) return explicit;
    // Existing person-avatar seeds never override a bot's stable cat template.
    if (ids.includes(templateId)) return templateId;
    const known = presets.find((cat) => [cat.id, cat.label, cat.nickname].includes(String(seed || name || "")));
    if (known) return known.id;
    const value = String(seed || name || "");
    if (!value || value === "glyph") return ids[0];
    let hash = 2166136261;
    for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
    return ids[hash % ids.length];
  }

  function defaultSeed(templateId) { return "cat:" + (ids.includes(templateId) ? templateId : ids[0]); }
  function nextSeed(seed, templateId, name) {
    const index = ids.indexOf(resolveBreed(seed, templateId, name));
    return "cat:" + ids[(index + 1) % ids.length];
  }

  function createPortrait(seed, templateId, name, doc = document) {
    const breed = resolveBreed(seed, templateId, name), index = ids.indexOf(breed);
    const make = (tag, attrs) => {
      const node = doc.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
      return node;
    };
    const svg = make("svg", { viewBox: `0 0 ${sheet.cell} ${sheet.cell}`, "aria-hidden": "true", "data-cat-id": breed });
    svg.style.overflow = "hidden";
    const clipId = "clowder-cat-crop-" + ++clipCount;
    const defs = make("defs"), clip = make("clipPath", { id: clipId });
    clip.append(make("rect", { width: sheet.cell, height: sheet.cell }));
    defs.append(clip);
    // Inset the already-clipped tile to keep long ears inside circular avatars.
    const inset = sheet.cell * 0.08;
    const portrait = make("g", { transform: `translate(${inset} ${inset}) scale(.84)`, "clip-path": `url(#${clipId})` });
    portrait.append(make("image", {
      href: sheet.url, x: -(index % 4) * sheet.cell, y: -Math.floor(index / 4) * sheet.cell,
      width: sheet.width, height: sheet.height, preserveAspectRatio: "none",
    }));
    svg.append(make("rect", { width: sheet.cell, height: sheet.cell, fill: "#f8f5ef" }), defs, portrait);
    return svg;
  }

  root.ClowderAvatars = Object.freeze({ presets, sheet, resolveBreed, defaultSeed, nextSeed, createPortrait });
})(window);
