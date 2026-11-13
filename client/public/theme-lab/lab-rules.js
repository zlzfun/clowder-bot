// Rules for the colour lab (classic script, window.ClowderThemeLabRules;
// docs/xbot-frontend.md item 47). Review only: no product page loads this.
// No DOM and no network: lab.js draws from these and tests load the same file.
//
// A palette is the token block cafe-theme.css sets (palettes.json, written by
// scripts/theme-lab/palettes.mjs) plus the --syn-* colours of a code block.
// It is shown two ways, both on the app's own stylesheets: a frozen screen
// (scenes.json, taken by scripts/theme-lab/scenes.mjs) rendered in a srcdoc
// frame that links the stylesheets in client/index.html's order, and the live
// app in its own window with one style element added.
(() => {
  "use strict";

  // client/index.html's stylesheets, in its order (tests/theme-lab.test.ts keeps the two equal).
  const STYLES = Object.freeze([
    "/tokens.css", "/vendor/katex/katex.min.css", "/app.css", "/devices.css", "/remotechat.css", "/providers.css",
    "/skills.css", "/persona-cards.css", "/account.css", "/cafe-theme.css", "/cafe-colors.css", "/colors.css", "/agents.css", "/cat-templates.css",
    "/chat-presentation.css", "/schedules.css", "/workspace.css", "/chat-experience.css", "/quick-create.css",
    "/palette.css", "/chat-list.css", "/chat-history.css", "/profile.css", "/mention.css", "/polish.css",
    "/chat-cards.css", "/chat-presence.css", "/sidebar.css", "/chat-live.css",
  ]);
  const MODES = Object.freeze(["light", "dark"]);
  // The id of the style element the lab adds to the app's window.
  const TRY_ID = "theme-lab-try";

  const decl = (o) => Object.entries(o || {}).map(([k, v]) => k + ":" + v).join(";");
  // `html:root:root` is (0,2,1): one more than the app's own palettes
  // (cafe-colors.css's html[data-colors="<id>"], (0,1,1)) and two more than
  // cafe-theme.css's `:root`; with [data-theme="dark"], one more than
  // html[data-colors][data-theme="dark"]. So the palette wins whatever 配色
  // the app itself is set to, without adding anything to the app's <html>. The
  // syntax rules follow cafe-theme.css's four (a code block, the owner's bubble
  // in light, a code block in dark, the owner's bubble in dark), each one class
  // above the app's. A frame of 拿铁 is the app as it is (no style); in the
  // app's window (`always`) 拿铁 is written out too, since the app may be set to
  // another 配色.
  const A = "html:root:root";
  function overrideCss(p, always) {
    if (!p || (p.current && !always)) return "";
    return [
      A + "{" + decl(p.light.tokens) + "}",
      A + '[data-theme="dark"]{' + decl(p.dark.tokens) + "}",
      A + " .code-block{" + decl(p.light.syn.code) + "}",
      A + ':not([data-theme="dark"]) .bubble .code-block{' + decl(p.light.syn.user) + "}",
      A + '[data-theme="dark"] .code-block{' + decl(p.dark.syn.code) + "}",
      A + '[data-theme="dark"] .bubble .code-block{' + decl(p.dark.syn.user) + "}",
    ].join("\n");
  }

  // The surfaces the app judges a cat's colour on (chat-presence.js reads
  // --x-card and --x-bot-bubble of the current theme), for one palette.
  function surfaces(p, mode) {
    const t = (p && p[mode] && p[mode].tokens) || {};
    return { chat: t["--x-card"] || "", bubble: t["--x-bot-bubble"] || "" };
  }

  // A frozen screen does not move: its entrance animations end where they
  // would end. Transitions stay, so hover still looks as it does in the app.
  const STILL = "*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important}";

  const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const styleText = (css) => String(css || "").replace(/<\/(style)/gi, "<\\/$1");
  const bodyOf = (scene, mode) => (scene && typeof scene.body === "object" ? scene.body[mode] : scene && scene.body) || "<body></body>";

  /**
   * The srcdoc of one frame: the app's <html> attributes with this mode, its
   * stylesheets in its order, the cats' colours as the app would write them on
   * this palette, the palette (none for the current one), and the frozen body.
   */
  function frameDoc({ scene, mode, palette, html, accents }) {
    const attrs = Object.entries(html || {}).filter(([k]) => /^[a-z][a-z0-9-]*$/.test(k) && k !== "data-theme")
      .map(([k, v]) => " " + k + '="' + attr(v) + '"').join("");
    const theme = MODES.includes(mode) ? mode : "light";
    const css = overrideCss(palette);
    return "<!doctype html><html" + attrs + ' data-theme="' + theme + '"><head><meta charset="utf-8">'
      + STYLES.map((href) => '<link rel="stylesheet" href="' + href + '">').join("")
      + (accents ? '<style id="pz-accents">' + styleText(accents) + "</style>" : "")
      + (css ? '<style id="' + TRY_ID + '">' + styleText(css) + "</style>" : "")
      + '<style id="theme-lab-still">' + STILL + "</style></head>"
      + bodyOf(scene, theme) + "</html>";
  }

  // The next palette that way, round the ends.
  function step(list, id, by) {
    const n = (list || []).length;
    if (!n) return null;
    const at = Math.max(0, list.findIndex((p) => p.id === id));
    return list[(((at + by) % n) + n) % n].id;
  }

  // How far a frame of `width`×`height` is scaled to fit a box: never above
  // real size.
  const fitScale = (box, width, height) => Math.max(0.05, Math.min(1, box.width / width, box.height / height));

  window.ClowderThemeLabRules = Object.freeze({ STYLES, MODES, TRY_ID, STILL, overrideCss, surfaces, frameDoc, bodyOf, step, fitScale });
})();
