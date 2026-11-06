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
  // Each cat's own outline in its cell (cell pixels), traced from the sheet by
  // scripts/trace-cat-outlines.mjs (`--check` verifies this block). Clipping
  // to it leaves the sheet's off-white backdrop and stray whiskers out, so the
  // portrait is transparent around the cat; the bitmap itself is unchanged.
  // The flat bust base follows the solo face's circle (cafe-theme.css).
  const outlines = Object.freeze({
    "ragdoll": "M134 51l-10 7-5 10-6 19-2 27-3 6-8 7-8 4 10 5-14 11 10 3-8 8 0 6-10 9 4 4-2 4-18 16 1 2 4-1 4 3-12 11-11 19 1 1 6-3 3 2-2 7-8 13-3 15 1 1 7-4 3 2-5 14 3 5-7 14 0 8 2 1 6-5 3 1 1 15 4 6-8 15 3 8 25 25 37 25 25 12 23 7 20 4 14 2 36 0 7-3 9 1 37-10 33-15 31-21 22-21 2-4-1-6-6-10 2-4-5-8 2-4-1-3 3-3 12 3 5-2-10-14 0-4 3-3 0-4-6-16 2-2 8 4 2-2-14-28 2-4 5 2 1-1-12-23 0-4 4-1 0-1-6-10 1-5-5-8 2-3 8 1-6-11 1-3 3-2-7-12 0-8 6-16 5-21 1-18-2-5-5-6-11-1-29 9-28 12-4-3-5 1-4-2-15 8-12-2-8-5-10 2-8-5-11 0-6 2-10-13-4 2-5-3-7 3-32-24-14-8z",
    "maine-coon": "M103 25l4 12 0 2-14-8-2 0-1 4 11 14-1 2-4-1-2 2 8 12-5 30 0 17 3 15 0 18-2 4-2 8-13 9 5 3 0 7-8 10 2 2 5-1 1 2-6 7 1 4-1 2-8 7-9 13 1 1 6-2 1 4-12 17-15 11 2 1 14-1 1 2-7 8-8 15 1 1 7-2 3 2-6 23-9 14 1 1 9-3 2 2-3 7-4 4 1 8 6 8 8-1-2 8 2 4 17 16 24 18 38 20 23 8 22 5 16 2 36 0 21-3 42-13 34-18 22-16 24-23-3-8 0-2 8 1 3-1-7-11 0-8-4-12 3-3 10 3 4-2-12-15 2-6-8-17 2-3 9 2 2-2-12-11-6-8-4-9 6-3 1-1-10-13-1-4-6-5-1-6-6-6 1-3 6 1 2-1-7-8-4-8 9-3-12-10-1-2 1-3-3-6 0-10 3-4-1-6 6-24 0-29-2-9 4-8 6-4-4-3-1-2 12-15-3-3-10 6-4 0-1-2 5-8-2-1-9 9-5 2-4 5-5 0-10 12-33 24-24 20-5-3-4 0-8 10-7-2-14 1-8-2-10 1-6-10-13 0-40-39-9-5-12-16-4 0-4-2-8-10z",
    "siamese": "M134 25l-6 3-7 9-5 10-6 18-8 43 1 18-4 17 0 13 10 33 0 5-5 11 2 5-2 12 3 13 10 22 6 9 16 14 1 16-4 15-7 8-15 24-5 24-5 6-4 11 22 13 24 11 28 9 30 5 36 0 16-2 29-7 23-9 14-7-2-11-7-13-6-7-1-10-5-12-8-17-10-10-4-17 22-14 13-14 5-7 8-16 1-15 13-10 12-12 6-13 7-19 6-11 13-35 7-33-2-11-4-7-7-3-4 0-14 4-38 19-51 31-8-1-18-8-5 1-13-4-13 0-7-5-9-19-17-27-20-28-6-8-8-5-8-4z",
    "turkish-van": "M111 35l-4 2-4 5-7 21-2 31 1 15-1 25-2 7-6 8 3 3-15 15 3 5-1 7-6 5-12 17 2 1 4-1 1 3-14 27 2 6-11 10 11 3-10 19 1 1 7-4 2 3-11 26 2 0 13-4 1 2-2 6 1 5-7 17 14-5 3 3-7 14-1 13 22 23 37 26 33 15 37 10 16 2 36 0 15-2 19-4 24-8 31-15 30-21 17-16-7-20-3-6 3-2 5 2 1-1-8-23 4-2 9 3 2-1-9-22 2-2 7 3 2-2-9-19-5-1-1-2 5-5-5-9 5-3 0-6-4-7 0-4-6-11 1-3 7 0-4-8-12-12 0-4-3-3 1-3 5-1-9-11 0-7-3-9 2-19 8-27 3-23 0-17-3-9-8-7-18 6-57 36-5-2-3 1-3-2-12 8-10-3-15 3-11-5-11 1-9-10-3 1-4-1-3 3-2 0-22-22-24-20-15-9z",
    "dsh": "M332 35l-15 5-45 34-4 1-6-2-10 5-14 0-6-2-14 4-10 0-9 1-10 4-15-1-13 3-37-17-21-7-10 1-10 9-3 9 0 14 4 22 7 18 2 35-7 9-4 14-4 15 0 14 6 28 8 14-5 5-1 5-12 14 0 5-8 12 0 5-6 15 2 4-4 13 6 9 17 17 30 22 21 9 14 0 9 2 23 2 4 2 16-1 4 2 15-1 6 2 10-2 5 1 27-2 8 0 3-1 13-1 9 0 23-5 25-15 23-19 19-23 1-11-2-12-6-18-10-22-13-20 0-4 8-13 8-19 3-22-1-17-7-23-5-9-16-18 0-18-3-10 3-23-1-27-4-13-6-6z",
    "dragon-li": "M124 18l-12 6-8 20-3 12-1 29 2 10-4 24 4 10 0 10-3 11-6 6-4 14-4 5-2 8 1 7-2 10 0 16 3 19 9 21 0 4 3 3 2 7-5 14-5 5-7 27-7 10 0 3-3 7 0 3-3 10 1 4 0 5 20 19 22 15 16 8 22 5 58 5 38 0 58-5 17-7 35-23 23-23-6-19-12-20-5-6-9-23-4-8 1-8 8-14 6-15 3-20-1-10 2-5 0-5-6-21 0-3-5-9-1-9 7-18 1-22 5-13 5-23 1-29-4-11-5-5-7-1-15 6-17 11-31 25-16 10-8 0-6 2-17-5-10 1-10-2-15 2-13-5-6-1-45-50-13-9z",
    "bengal": "M140 10l-9 7-5 7-10 28-5 26 1 9-7 24 3 17-3 14-5 6-1 7-5 10-6 26 2 18-1 6 2 11 5 15 10 16 3 9-3 8-4 3-1 8-9 14 0 4-7 11-2 10-5 10-4 17 0 10 14 14 35 23 10 5 21 3 4 2 5-1 5 2 6-1 46 3 31-1 27-3 5 1 32-7 31-18 19-17-4-10 1-3-6-13-9-15-10-12-11-10-11-18-1-8 11-14 11-23 6-20 2-14-1-9 3-8 3-6 8-8 8-24 14-25 10-31 1-17-1-4-8-7-13 1-35 15-25 15-23 9-6-2-8 1-19-8-7 0-8-4-18-1-13-6-4-3-20-38-17-24-13-11-7-2z",
    "golden-chinchilla": "M119 34l-6 5-4 6-7 16-3 14-1 25-3 3 1 4-9 5 2 3-2 3 3 3-15 10 1 2 4 1 1 4-8 8-1 6-8 7 3 4-3 5-8 6 4 4-10 10-11 15 1 2 5-1 1 1-13 21-4 9 0 4 4 10-6 17 1 3 1 1 8-5 3 2-3 12 1 4-6 19 1 3 4-2 4 3-3 10 18 27 19 21 23 19 34 19 11 0 13 4 14 1 59 3 24-3 15 1 6-2 12 0 13-4 11 1 11-5 23-14 19-15 17-17 12-15 3-7-5-17 3-1 6 4 2-1-6-19 0-4 4 1 2-2-5-21 2-2 7 6 2-2-6-17-8-14 1-2 6 2 1-2-18-27 0-2 4 0 1-2-10-16-7-7 4-5-9-12 0-4-3-4 1-2 6-1 1-2-10-9 0-6-5-6 9-44 0-17-3-9-5-6-9-1-18 7-33 16-4-3-6-1-19 7-17-7-10-1-6 2-6-3-13 0-10 2-7-1-14-8-7 2-4 0-35-28-10-5z",
  });
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
    clip.append(make("path", { d: outlines[breed] }));
    defs.append(clip);
    // Inset the already-clipped tile to keep long ears inside circular avatars.
    const inset = sheet.cell * 0.08;
    const portrait = make("g", { transform: `translate(${inset} ${inset}) scale(.84)`, "clip-path": `url(#${clipId})` });
    portrait.append(make("image", {
      href: sheet.url, x: -(index % 4) * sheet.cell, y: -Math.floor(index / 4) * sheet.cell,
      width: sheet.width, height: sheet.height, preserveAspectRatio: "none",
    }));
    svg.append(defs, portrait);
    return svg;
  }

  root.ClowderAvatars = Object.freeze({ presets, sheet, outlines, resolveBreed, defaultSeed, nextSeed, createPortrait });
})(window);
