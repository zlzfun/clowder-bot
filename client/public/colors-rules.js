// Rules for 配色, the app's colours (classic script, window.ClowderColorsRules;
// docs/xbot-frontend.md item 48). No DOM and no network: colors.js draws from
// these and tests load the same file.
//
// Eleven palettes, chosen in 设置 → 通用 next to 主题 (light, dark or the
// system's), kept per device in this browser like 主题 is (xbot-colors beside
// xbot-theme). 拿铁 is cafe-theme.css itself and the default: no attribute on
// <html>. Every other one is html[data-colors="<id>"], drawn by the generated
// cafe-colors.css and set before the first paint by client/index.html's boot
// script. The ids, names and order are the colour lab's palettes.json
// (scripts/theme-lab/palettes.mjs; tests/colors.test.ts keeps them equal).
(() => {
  "use strict";
  const KEY = "xbot-colors";
  const DEFAULT = "latte";
  const COLORS = Object.freeze([
    ["latte", "拿铁"], ["oat", "燕麦"], ["cinnamon", "肉桂"], ["americano", "黑咖"], ["matcha", "抹茶"], ["seasalt", "海盐"],
    ["berry", "莓果"], ["earlgrey", "伯爵"], ["honey", "蜂蜜"], ["coldbrew", "冷萃"], ["mintchoco", "薄荷可可"],
  ].map(([id, name]) => Object.freeze({ id, name })));

  // A stored or asked-for id as one of the eleven; anything else (missing, unknown, not a string) is 拿铁.
  const pick = (id) => (typeof id === "string" && COLORS.some((c) => c.id === id) ? id : DEFAULT);
  // The value of <html data-colors>, or null for none (拿铁).
  const attr = (id) => (pick(id) === DEFAULT ? null : pick(id));
  const nameOf = (id) => COLORS.find((c) => c.id === pick(id)).name;
  // The next one that way, round the ends (the radio group's own arrows).
  function step(id, by) {
    const at = COLORS.findIndex((c) => c.id === pick(id));
    return COLORS[(((at + by) % COLORS.length) + COLORS.length) % COLORS.length].id;
  }

  window.ClowderColorsRules = Object.freeze({ KEY, DEFAULT, COLORS, pick, attr, nameOf, step });
})();
