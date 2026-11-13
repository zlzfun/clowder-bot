// The candidate palettes the colour lab compares (client/public/theme-lab/,
// /theme-lab/; docs/xbot-frontend.md item 47). Each candidate is a short OKLCH
// spec; from it the full token set a theme defines is derived for light and
// dark (the names cafe-theme.css sets, plus --accent, --accent-ink and --ring),
// text colours are fitted to WCAG AA, and the syntax colours of a code block
// (--syn-*) are fitted to the surface they sit on: --x-code, and --x-user-code
// inside the owner's bubble. The first palette, 拿铁, is today's cafe-theme.css
// read as it is, so the lab compares against what the app really shows.
//
// Since 2026-11-13 all eleven are the product's 配色 (设置 → 通用; item 48): the
// same data also becomes client/public/cafe-colors.css (the ten besides 拿铁,
// and every palette's swatch) and the window-colour table in the boot script
// of client/index.html.
//
//   node scripts/theme-lab/palettes.mjs           writes palettes.json, cafe-colors.css and the boot table; reports failing pairs
//   node scripts/theme-lab/palettes.mjs --check   only says whether the committed files are what this gives
//
// The committed files are exactly what this writes (tests/theme-lab.test.ts, tests/colors.test.ts).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hex, rgba, fit, contrast, lum, hexToOklch } from "./color.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
// The share of the ring colour a message row's focus ring is drawn with, over the chat card (polish.css).
export const RING_SHARE = 0.7;
/** fg at `share` over an opaque bg, as color-mix(in srgb, fg share%, transparent) shows it there. */
export const mixed = (fg, bg, share) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * share + parseInt(bg.slice(i, i + 2), 16) * (1 - share)).toString(16).padStart(2, "0")).join("");
export const OUT = path.join(REPO, "client/public/theme-lab/palettes.json");
const L = (v) => (typeof v === "string" ? hexToOklch(v) : v);

const LIGHT_L = { win: 0.945, card: 0.992, panel: 0.966, panelCard: 0.996, fill1: 0.962, fill2: 0.93, fill3: 0.895, input: 0.955, code: 0.948, botBubble: 0.956, avatar: 0.885, disabled: 0.92, popover: 0.997, scroll: 0.79 };
const LIGHT_K = { win: 1, card: 0.4, panel: 0.8, panelCard: 0.3, fill1: 0.85, fill2: 1.1, fill3: 1.35, input: 0.95, code: 1, botBubble: 0.95, avatar: 1.7, disabled: 1.15, popover: 0.3, scroll: 1.8 };
const DARK_L = { win: 0.205, card: 0.245, panel: 0.225, panelCard: 0.285, fill1: 0.285, fill2: 0.32, fill3: 0.375, input: 0.3, code: 0.305, botBubble: 0.285, avatar: 0.45, disabled: 0.32, popover: 0.3, popoverHover: 0.365, scroll: 0.5 };
const DARK_K = { win: 1, card: 1.05, panel: 1, panelCard: 1.1, fill1: 1.1, fill2: 1.2, fill3: 1.4, input: 1.15, code: 1.15, botBubble: 1.1, avatar: 1.8, disabled: 1.2, popover: 1.15, popoverHover: 1.3, scroll: 1.8 };

function surfaces(s, dark) {
  const BL = { ...(dark ? DARK_L : LIGHT_L), ...(s.L || {}) };
  const BK = { ...(dark ? DARK_K : LIGHT_K), ...(s.K || {}) };
  const out = {};
  for (const k of Object.keys(BL)) out[k] = hex([BL[k], s.sc * BK[k], s.sh]);
  if (!dark) out.popoverHover = out.fill2;
  Object.assign(out, s.surf || {}); // pinned hexes
  return out;
}

function syntax(bg, th) {
  const darkBg = lum(bg) < 0.3;
  const base = darkBg
    ? { kw: [0.82, 0.1, 325], str: [0.84, 0.09, 135], cm: [0.76, 0.02, th], num: [0.84, 0.09, 70], fn: [0.82, 0.08, 240], lit: [0.84, 0.07, 195] }
    : { kw: [0.4, 0.12, 325], str: [0.4, 0.08, 145], cm: [0.43, 0.02, th], num: [0.42, 0.1, 55], fn: [0.4, 0.1, 250], lit: [0.41, 0.08, 205] };
  const out = {};
  for (const [k, v] of Object.entries(base)) out["--syn-" + k] = hex(fit(v, [bg], 4.5, darkBg ? 1 : -1));
  return out;
}

function mode(s, dark) {
  const dir = dark ? 1 : -1;
  const S = surfaces(s, dark);
  const semC = s.semC ?? 1;
  const readable = [S.win, S.card, S.panel, S.fill1, S.fill2, S.botBubble, S.input, S.panelCard, S.popover];
  const text = hex([dark ? 0.94 : 0.26, s.tc, s.th]);
  const text2 = hex([dark ? 0.86 : 0.36, s.tc, s.th]);
  const muted = hex(fit([dark ? 0.78 : 0.45, s.tc * 0.9, s.th], [...readable, S.fill3], 4.5, dir));
  const faint = hex(fit([dark ? 0.7 : 0.53, s.tc * 0.8, s.th], readable, 4.5, dir));

  // primary + on-primary
  let pri = L(s.primary);
  const lightInk = [0.99, 0.006, s.sh];
  const darkInk = s.onDark ? L(s.onDark) : [0.2, Math.min(0.04, pri[1] * 0.5 + 0.01), pri[2]];
  const useLightInk = contrast(hex(pri), hex(lightInk)) >= contrast(hex(pri), hex(darkInk));
  let on = useLightInk ? lightInk : darkInk;
  pri = fit(pri, [hex(on)], 4.5, useLightInk ? -1 : 1);
  const primary = hex(pri), onPrimary = hex(on);
  const primaryHover = hex([pri[0] + (dark ? 0.05 : -0.05), pri[1], pri[2]]);

  // user bubble
  const b = s.bubble || { kind: "primary" };
  let bub, bubText;
  if (b.kind === "primary") { bub = pri; bubText = onPrimary; }
  else if (b.kind === "soft") { bub = L(b.color); bubText = text; }
  else { bub = L(b.color); bubText = hex(contrast(hex(bub), hex(lightInk)) >= 4.5 ? lightInk : darkInk); }
  const bubHex = hex(bub);
  const bubDark = lum(bubHex) < 0.3;
  const userCode = hex([bub[0] - (bubDark ? 0.06 : 0.055), bub[1], bub[2]]);
  const bubTextRgb = L(bubText);
  const userSel = rgba(bubTextRgb, lum(bubText) > 0.5 ? 0.22 : 0.16);
  const link = L(s.link);
  const userLink = lum(bubText) > 0.5
    ? hex(fit([0.9, 0.05, link[2]], [bubHex, userCode], 4.5, 1))
    : hex(fit([0.4, Math.max(link[1], 0.07), link[2]], [bubHex, userCode], 4.5, -1));

  const linkBgs = [S.card, S.botBubble, S.fill1, S.panel, S.win, S.code, S.panelCard];
  const textLink = hex(fit(link, linkBgs, 4.5, dir));
  const linkHover = hex(dark ? [0.36, 0.05, link[2]] : [0.925, 0.032, link[2]]);

  const dangerBg = hex(dark ? [0.32, 0.05, 25] : [0.945, 0.028, 28]);
  const sem = (lch, bgs) => hex(fit(lch, bgs, 4.5, dir));
  const base = [S.card, S.win, S.fill1, S.botBubble, S.panel];
  const danger = sem(dark ? [0.76, 0.12 * semC, 25] : [0.5, 0.15 * semC, 28], [...base, dangerBg]);
  const online = sem(dark ? [0.78, 0.1 * semC, 150] : [0.52, 0.11 * semC, 150], [S.card, S.win]);
  const pending = sem(dark ? [0.82, 0.1 * semC, 85] : [0.56, 0.11 * semC, 80], [S.card, S.win]);
  const tag = (h, c = 0.07) => {
    const bg = hex(dark ? [0.33, 0.035 * (c / 0.07), h] : [0.93, 0.025 * (c / 0.07), h]);
    return [sem(dark ? [0.8, c * 0.9 * semC, h] : [0.45, c * semC, h], [bg, S.card, S.panel]), bg];
  };
  const [typeDev, typeDevBg] = tag(152);
  const [typeRes, typeResBg] = tag(240);
  const [typeOwn, typeOwnBg] = tag(305);
  const typeGenBg = S.fill2;
  const typeGen = sem([dark ? 0.8 : 0.45, Math.max(s.tc, 0.02), s.th], [typeGenBg, S.card, S.panel]);
  const warnBg = hex(dark ? [0.33, 0.04, 82] : [0.93, 0.045, 88]);
  const warn = sem(dark ? [0.82, 0.08 * semC, 85] : [0.47, 0.09 * semC, 75], [warnBg, S.card]);

  const shadowC = dark ? [0.1, 0.012, s.sh] : [0.3, Math.min(0.05, s.sc * 3), s.sh];
  // The accent is the primary drawn alone on a surface: a dot, the owner's face, a tick, a focus ring.
  // A palette may name its own (蜂蜜: its yellow primary is a fill, too light to stand alone on a light
  // surface), which reads 4.5:1 on the card and the window; either way it stands out 3:1 from every
  // surface it sits on (WCAG 1.4.11), the avatar circle and the selected row included.
  let acc = s.accent ? fit(L(s.accent), [S.card, S.win], 4.5, dir) : pri;
  acc = fit(acc, [S.card, S.win, S.panel, S.fill1, S.fill2, S.fill3, S.botBubble, S.avatar, S.popover], 3, dir);
  const accent = hex(acc);
  // The focus ring is the accent, except that a message row draws it at RING_SHARE over the chat card
  // (polish.css): there it still reads 3:1, so where the accent is too light for that the ring is deeper.
  let ring = acc;
  for (let i = 0; i < 160 && contrast(mixed(hex(ring), S.card, RING_SHARE), S.card) < 3; i++) ring = [ring[0] + dir * 0.005, ring[1], ring[2]];

  const t = {
    "--x-win": S.win, "--x-card": S.card, "--x-panel": S.panel, "--x-panel-card": S.panelCard,
    "--x-fill-1": S.fill1, "--x-fill-2": S.fill2, "--x-fill-3": S.fill3, "--x-zebra": S.fill1,
    "--x-input": S.input, "--x-code": S.code, "--x-bot-bubble": S.botBubble,
    "--x-bot-code": rgba(L(text), dark ? 0.07 : 0.06),
    "--x-user-bubble": bubHex, "--x-user-bubble-text": bubText, "--x-user-code": userCode, "--x-user-sel": userSel,
    "--x-text": text, "--x-text-2": text2, "--x-muted": muted, "--x-faint": faint, "--x-ph": faint,
    "--x-primary": primary, "--x-primary-hover": primaryHover, "--x-on-primary": onPrimary,
    "--x-disabled": S.disabled, "--x-on-disabled": faint,
    "--x-danger": danger, "--x-danger-bg": dangerBg, "--x-online": online, "--x-pending": pending,
    "--x-text-link": textLink, "--x-text-link-hover": linkHover,
    "--x-user-link": userLink, "--x-user-link-hover": rgba(L(userLink), 0.14),
    "--x-type-dev": typeDev, "--x-type-dev-bg": typeDevBg, "--x-type-res": typeRes, "--x-type-res-bg": typeResBg,
    "--x-type-gen": typeGen, "--x-type-gen-bg": typeGenBg, "--x-type-own": typeOwn, "--x-type-own-bg": typeOwnBg,
    "--x-avatar-bg": S.avatar, "--x-popover": S.popover, "--x-popover-hover": S.popoverHover,
    "--x-shadow-pop": dark
      ? `0 10px 34px ${rgba(shadowC, 0.5)}, 0 1px 3px ${rgba(shadowC, 0.28)}`
      : `0 8px 30px ${rgba(shadowC, 0.14)}, 0 1px 3px ${rgba(shadowC, 0.08)}`,
    "--x-scrim": dark ? rgba([0.1, 0.01, s.sh], 0.52) : rgba([0.22, Math.min(0.03, s.sc * 2), s.sh], 0.3),
    "--scroll": S.scroll, "--warn-bg": warnBg, "--warn": warn,
    "--accent": accent, "--accent-ink": accent, "--ring": hex(ring),
  };
  Object.assign(t, s.pin || {});
  return { tokens: t, syn: { code: syntax(t["--x-code"], s.th), user: syntax(t["--x-user-code"], s.th) } };
}

// ---- The baseline: today's cafe-theme.css, read verbatim.
function current() {
  const css = fs.readFileSync(path.join(REPO, "client/public/cafe-theme.css"), "utf8");
  const block = (re) => {
    const m = css.match(re); const o = {};
    for (const d of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) o[d[1]] = d[2].trim();
    return o;
  };
  const light = block(/:root\s*\{([^}]+)\}/);
  const dark = block(/html\[data-theme="dark"\]\s*\{([^}]+)\}/);
  for (const o of [light, dark]) {
    o["--x-popover-hover"] = o["--x-fill-2"].startsWith("#") && o === light ? o["--x-fill-2"] : o["--x-popover-hover"];
    o["--accent"] = o["--accent-ink"] = o["--ring"] = o["--x-primary"];
  }
  const dk = { "--syn-kw": "#57345a", "--syn-str": "#31412e", "--syn-cm": "#4a392b", "--syn-num": "#5e3514", "--syn-fn": "#214660", "--syn-lit": "#224951" };
  const lt = { "--syn-kw": "#ddafdd", "--syn-str": "#c4d2a6", "--syn-cm": "#c9baaa", "--syn-num": "#edc599", "--syn-fn": "#adcfe4", "--syn-lit": "#b0d8d3" };
  return { light: { tokens: light, syn: { code: dk, user: lt } }, dark: { tokens: dark, syn: { code: lt, user: dk } } };
}

// ---- Specs. [L, C, H] is OKLCH.
const SPECS = [
  {
    id: "oat", name: "燕麦", en: "Oat latte",
    note: "现在这套的轻量版：底色褪掉一层黄，输入框变浅，文字拉开层次。",
    light: { sh: 78, sc: 0.013, th: 55, tc: 0.028, primary: [0.38, 0.055, 50], link: [0.42, 0.06, 180], semC: 0.85 },
    dark: { sh: 55, sc: 0.012, th: 78, tc: 0.02, primary: [0.8, 0.07, 72], link: [0.82, 0.06, 165], semC: 0.85 },
  },
  {
    id: "cinnamon", name: "肉桂", en: "Cinnamon",
    note: "跟随 Clowder AI 现在的配色：暖纸、墨色文字，赭红只留给按钮。",
    light: {
      sh: 80, sc: 0.012, th: 100, tc: 0.004, primary: "#b05f45", link: "#8f4730", semC: 0.9,
      surf: { win: "#f5efe6", card: "#fffbf6", panel: "#f8f3ea", panelCard: "#fffbf6", fill1: "#f9f4ec", fill2: "#efe9e3", fill3: "#e5dfd5", input: "#f4eee5", code: "#f4eee6", botBubble: "#f6f1e8", popover: "#fffbf6", popoverHover: "#efe9e3" },
      bubble: { kind: "soft", color: "#ebe3d7" },
    },
    dark: {
      sh: 85, sc: 0.006, th: 95, tc: 0.006, primary: "#cc785c", onDark: "#181715", link: [0.8, 0.09, 45], semC: 0.9,
      surf: { win: "#181715", card: "#1f1e1b", panel: "#1c1b18", panelCard: "#282623", fill1: "#252320", fill2: "#2d2b27", fill3: "#3a3732", input: "#2a2825", code: "#2a2825", botBubble: "#272522", popover: "#2d2b27", popoverHover: "#3a3732" },
      bubble: { kind: "soft", color: "#3a3731" },
    },
  },
  {
    id: "americano", name: "黑咖", en: "Americano",
    note: "不加奶：白纸黑字，颜色只留给猫和内容。",
    light: { sh: 85, sc: 0.003, th: 85, tc: 0.004, primary: [0.23, 0.004, 85], link: [0.5, 0.13, 255], L: { win: 0.955, card: 0.999 } },
    dark: { sh: 85, sc: 0.003, th: 85, tc: 0.003, primary: [0.94, 0.003, 85], link: [0.78, 0.09, 250], L: { win: 0.185, card: 0.225, panel: 0.205 } },
  },
  {
    id: "matcha", name: "抹茶", en: "Matcha",
    note: "宣纸底上一抹茶绿，深色是关灯后的茶室。",
    light: { sh: 125, sc: 0.014, th: 150, tc: 0.02, primary: [0.43, 0.075, 145], link: [0.42, 0.075, 150], semC: 0.9 },
    dark: { sh: 150, sc: 0.012, th: 125, tc: 0.015, primary: [0.83, 0.08, 135], link: [0.82, 0.08, 145], bubble: { kind: "deep", color: [0.42, 0.065, 148] }, semC: 0.9 },
  },
  {
    id: "seasalt", name: "海盐", en: "Sea salt",
    note: "冷一点的白，海蓝气泡；深色是夜里的海。",
    light: { sh: 240, sc: 0.01, th: 255, tc: 0.025, primary: [0.46, 0.11, 252], link: [0.46, 0.12, 252] },
    dark: { sh: 255, sc: 0.02, th: 240, tc: 0.012, primary: [0.8, 0.08, 240], link: [0.8, 0.09, 240], bubble: { kind: "deep", color: [0.47, 0.11, 252] } },
  },
  {
    id: "berry", name: "莓果", en: "Berry",
    note: "带一点粉的白，莓紫气泡，最甜的一套。",
    light: { sh: 12, sc: 0.011, th: 350, tc: 0.025, primary: [0.45, 0.12, 352], link: [0.45, 0.12, 352] },
    dark: { sh: 350, sc: 0.014, th: 10, tc: 0.012, primary: [0.83, 0.075, 355], link: [0.83, 0.075, 355], bubble: { kind: "deep", color: [0.45, 0.11, 352] } },
  },
  {
    id: "earlgrey", name: "伯爵", en: "Earl Grey",
    note: "灰里透一点紫，自己的话是淡紫色的便签。",
    light: { sh: 295, sc: 0.008, th: 290, tc: 0.025, primary: [0.43, 0.1, 292], link: [0.43, 0.11, 292], bubble: { kind: "soft", color: [0.9, 0.04, 295] } },
    dark: { sh: 290, sc: 0.016, th: 295, tc: 0.012, primary: [0.82, 0.075, 295], link: [0.82, 0.08, 295], bubble: { kind: "soft", color: [0.4, 0.06, 292] } },
  },
  {
    id: "honey", name: "蜂蜜", en: "Honey",
    note: "明黄气泡配深色字，最亮最活泼的一套。",
    light: { sh: 90, sc: 0.011, th: 75, tc: 0.015, primary: [0.85, 0.145, 88], onDark: [0.25, 0.04, 70], link: [0.45, 0.09, 65], accent: [0.42, 0.07, 70] },
    dark: { sh: 80, sc: 0.01, th: 88, tc: 0.015, primary: [0.84, 0.14, 88], onDark: [0.22, 0.03, 70], link: [0.85, 0.11, 88] },
  },
  {
    id: "coldbrew", name: "冷萃", en: "Cold brew",
    note: "为夜里准备：深蓝的房间，一盏琥珀色的灯。",
    light: { sh: 255, sc: 0.006, th: 262, tc: 0.03, primary: [0.31, 0.065, 262], link: [0.45, 0.11, 258] },
    dark: { sh: 262, sc: 0.028, th: 250, tc: 0.012, primary: [0.8, 0.12, 75], onDark: [0.2, 0.03, 262], link: [0.83, 0.1, 80], L: { win: 0.19, card: 0.23, panel: 0.21 } },
  },
  {
    id: "mintchoco", name: "薄荷可可", en: "Mint choco",
    note: "薄荷底配可可色，深色反过来：可可底配薄荷。",
    light: { sh: 168, sc: 0.013, th: 50, tc: 0.03, primary: [0.36, 0.05, 45], link: [0.43, 0.07, 172] },
    dark: { sh: 45, sc: 0.014, th: 165, tc: 0.012, primary: [0.85, 0.075, 168], link: [0.84, 0.07, 168] },
  },
];

/** Every palette, 拿铁 (today's cafe-theme.css) first. */
export function buildPalettes() {
  const cur = current();
  return [
    { id: "latte", name: "拿铁", en: "Latte", note: "现在的配色，放在这里做对照。", current: true, ...cur },
    ...SPECS.map((s) => ({ id: s.id, name: s.name, en: s.en, note: s.note, light: mode(s.light, false), dark: mode(s.dark, true) })),
  ];
}

/** The file's exact text. */
export const serialize = (palettes) => JSON.stringify(palettes, null, 1);

// ---- The pairs a reader actually meets: [foreground, backgrounds, minimum WCAG ratio].
export const MARK_SURFACES = ["--x-card", "--x-win", "--x-panel", "--x-fill-1", "--x-fill-2", "--x-fill-3", "--x-bot-bubble", "--x-avatar-bg", "--x-popover"];
export const PAIRS = [
  ["--x-text", ["--x-card", "--x-win", "--x-fill-3", "--x-bot-bubble"], 7],
  ["--x-text-2", ["--x-card", "--x-win", "--x-fill-3"], 4.5],
  ["--x-muted", ["--x-card", "--x-win", "--x-fill-2", "--x-fill-3", "--x-bot-bubble", "--x-input", "--x-panel"], 4.5],
  ["--x-faint", ["--x-card", "--x-win", "--x-fill-2", "--x-bot-bubble", "--x-input", "--x-panel"], 4.5],
  ["--x-on-primary", ["--x-primary", "--x-primary-hover"], 4.5],
  ["--x-user-bubble-text", ["--x-user-bubble", "--x-user-code"], 4.5],
  ["--x-user-link", ["--x-user-bubble"], 4.5],
  ["--x-text-link", ["--x-card", "--x-bot-bubble", "--x-win"], 4.5],
  ["--x-danger", ["--x-card", "--x-danger-bg", "--x-win"], 4.5],
  ["--x-type-dev", ["--x-type-dev-bg"], 4.5], ["--x-type-res", ["--x-type-res-bg"], 4.5],
  ["--x-type-gen", ["--x-type-gen-bg"], 4.5], ["--x-type-own", ["--x-type-own-bg"], 4.5],
  ["--warn", ["--warn-bg"], 4.5],
  // Shapes drawn alone in the accent (a dot, the owner's face, a tick, a focus ring) on the surfaces around them.
  ["--accent", MARK_SURFACES, 3],
  ["--accent-ink", MARK_SURFACES, 3],
  ["--x-user-bubble", ["--x-card"], 1.12],
  ["--x-bot-bubble", ["--x-card"], 1.04],
  ["--x-fill-3", ["--x-win"], 1.08],
];
// Syntax colours need 4.5:1 on the code block they are drawn on.
export const SYNTAX = [["code", "--x-code"], ["user", "--x-user-code"]];

/** Every pair below its minimum, as a sentence; [] when all pass. Pairs with a non-hex side (an alias, rgba) are not judged. */
export function problems(palettes) {
  const out = [];
  for (const p of palettes) for (const m of ["light", "dark"]) {
    const t = p[m].tokens;
    for (const [fg, bgs, min] of PAIRS) for (const bg of bgs) {
      if (!t[fg]?.startsWith("#") || !t[bg]?.startsWith("#")) continue;
      const c = contrast(t[fg], t[bg]);
      if (c < min - 0.005) out.push(`${p.id} ${m}: ${fg} on ${bg} = ${c.toFixed(2)} (< ${min})`);
    }
    for (const [where, bgTok] of SYNTAX) for (const [k, v] of Object.entries(p[m].syn[where])) {
      const c = contrast(v, t[bgTok]);
      if (c < 4.5 - 0.005) out.push(`${p.id} ${m}: ${k} in ${where} = ${c.toFixed(2)}`);
    }
    // A message row's focus ring: the ring colour at RING_SHARE over the chat card (拿铁's is an alias of its primary).
    const ring = t["--ring"].startsWith("#") ? t["--ring"] : t["--x-primary"];
    const rc = contrast(mixed(ring, t["--x-card"], RING_SHARE), t["--x-card"]);
    if (rc < 3 - 0.005) out.push(`${p.id} ${m}: --ring at ${RING_SHARE * 100}% on --x-card = ${rc.toFixed(2)} (< 3)`);
  }
  return out;
}

// ---- The product's 配色 (设置 → 通用; docs/xbot-frontend.md item 48).
export const CSS_OUT = path.join(REPO, "client/public/cafe-colors.css");
export const INDEX = path.join(REPO, "client/index.html");

/**
 * The owner's bubble while its message menu is open (app.js marks it .message-target). cafe-theme.css
 * darkens it to --x-primary-hover, right where the bubble is the primary (null: nothing to add); a
 * palette whose bubble has its own colour gets that colour pressed instead, 0.05 darker in OKLCH,
 * its words still 4.5:1.
 */
export function pressedBubble(tokens) {
  const bubble = tokens["--x-user-bubble"], words = tokens["--x-user-bubble-text"];
  if (bubble === tokens["--x-primary"]) return null;
  const [l, c, h] = hexToOklch(bubble);
  return hex(fit([l - 0.05, c, h], [words], 4.5, lum(words) > lum(bubble) ? -1 : 1));
}

const block = (selectors, values) => `${selectors.join(",\n")} {\n${Object.entries(values).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`;
/** client/public/cafe-colors.css, exactly. */
export function colorsCss(palettes) {
  const out = [`/* 配色 (设置 → 通用): the palettes besides 拿铁. Written by scripts/theme-lab/palettes.mjs from its
   specs (the same data as the colour lab's palettes.json); do not edit by hand, run the script
   (docs/xbot-frontend.md item 48). Loaded right after cafe-theme.css.

   html[data-colors="<id>"] is set before the first paint by client/index.html's boot script and on a
   choice by colors.js; no attribute is 拿铁, which is cafe-theme.css itself. Each palette's rules are
   one step above cafe-theme.css's (and app.css's): its tokens on html[data-colors] (0,1,1) and
   html[data-colors][data-theme="dark"] (0,2,1) over :root and html[data-theme="dark"], and its four
   syntax rules one class over theirs; no !important. .colors-swatch[data-colors="<id>"] carries a
   palette's tokens on its swatch among the 配色 choices (拿铁's too), in the mode in effect. */`];
  for (const p of palettes) {
    const A = `html[data-colors="${p.id}"]`, S = `.colors-swatch[data-colors="${p.id}"]`, D = `html[data-theme="dark"] ${S}`;
    if (p.current) {
      out.push("", `/* ${p.name}: cafe-theme.css's own colours, here only for its swatch. */`, block([S], p.light.tokens), block([D], p.dark.tokens));
      continue;
    }
    out.push("", `/* ${p.name} */`,
      block([A, S], p.light.tokens),
      block([`${A}[data-theme="dark"]`, D], p.dark.tokens),
      block([`${A} .code-block`], p.light.syn.code),
      block([`${A}:not([data-theme="dark"]) .bubble .code-block`], p.light.syn.user),
      block([`${A}[data-theme="dark"] .code-block`], p.dark.syn.code),
      block([`${A}[data-theme="dark"] .bubble .code-block`], p.dark.syn.user));
    const light = pressedBubble(p.light.tokens), dark = pressedBubble(p.dark.tokens);
    if (light) out.push(block([`${A}:not([data-theme="dark"]) .bubble.message-target`], { background: light }));
    if (dark) out.push(block([`${A}[data-theme="dark"] .bubble.message-target`], { background: dark }));
  }
  return out.join("\n") + "\n";
}

// Each palette's window colour, light and dark, for the browser's own bar before the first paint: the
// table in client/index.html's boot script, between /* colors */ and /* /colors */.
export const BOOT_TABLE = /\/\* colors \*\/\{[^}]*\}\/\* \/colors \*\//;
export const windowTable = (palettes) => "/* colors */{" + palettes.map((p) => `"${p.id}":["${p.light.tokens["--x-win"]}","${p.dark.tokens["--x-win"]}"]`).join(",") + "}/* /colors */";
export function bootHtml(html, palettes) {
  if (!BOOT_TABLE.test(html)) throw new Error("client/index.html has no /* colors */ table in its boot script");
  return html.replace(BOOT_TABLE, windowTable(palettes));
}

/** Every file this writes, with its exact text. */
export function outputs(palettes = buildPalettes()) {
  return [[OUT, serialize(palettes)], [CSS_OUT, colorsCss(palettes)], [INDEX, bootHtml(fs.readFileSync(INDEX, "utf8"), palettes)]];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const palettes = buildPalettes(), files = outputs(palettes);
  if (process.argv.includes("--check")) {
    const stale = files.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text).map(([file]) => path.relative(REPO, file));
    console.log(stale.length ? `${stale.join(", ")} differ from what the generator gives: run node scripts/theme-lab/palettes.mjs` : "palettes.json, cafe-colors.css and the boot table are what the generator gives");
    process.exit(stale.length ? 1 : 0);
  }
  for (const [file, text] of files) fs.writeFileSync(file, text);
  console.log(palettes.length, "palettes →", files.map(([file]) => path.relative(REPO, file)).join(", "));
  for (const p of palettes) {
    const l = p.light.tokens, d = p.dark.tokens;
    console.log(p.id.padEnd(10), "L", l["--x-win"], l["--x-card"], l["--x-user-bubble"], l["--x-primary"], l["--x-text"], l["--x-muted"], l["--x-faint"], "| D", d["--x-win"], d["--x-card"], d["--x-user-bubble"], d["--x-primary"], d["--x-text"]);
  }
  const found = problems(palettes);
  console.log(found.length ? "PROBLEMS:\n" + found.join("\n") : "all pairs pass");
}
