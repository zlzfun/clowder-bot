// OKLCH <-> sRGB helpers, WCAG contrast, contrast fitting.
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function oklchToLinear([L, C, H]) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (rgb) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);
// Reduce chroma until the colour fits sRGB.
export function gamut([L, C, H]) {
  L = clamp01(L);
  if (inGamut(oklchToLinear([L, C, H]))) return [L, C, H];
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear([L, mid, H]))) lo = mid; else hi = mid;
  }
  return [L, lo, H];
}
export function rgb(lch) {
  return oklchToLinear(gamut(lch)).map((c) => Math.round(clamp01(fromLin(clamp01(c))) * 255));
}
export function hex(lch) {
  return "#" + rgb(lch).map((v) => v.toString(16).padStart(2, "0")).join("");
}
export function rgba(lch, a) {
  const [r, g, b] = rgb(lch);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
export function hexToRgb(h) {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}
export function hexToOklch(h) {
  const [r, g, b] = hexToRgb(h).map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}
export function lum(h) {
  const [r, g, b] = hexToRgb(h).map((v) => toLin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Composite an rgba() colour over an opaque hex background.
export function over(rgbaStr, bgHex) {
  const m = rgbaStr.match(/rgba?\(([^)]+)\)/);
  const [r, g, b, a = 1] = m[1].split(",").map((x) => parseFloat(x));
  const bg = hexToRgb(bgHex);
  return "#" + [r, g, b].map((v, i) => Math.round(v * a + bg[i] * (1 - a)).toString(16).padStart(2, "0")).join("");
}
// Move L (darker when dir<0, lighter when dir>0) until the colour reaches
// `ratio` against every background. Returns the fitted [L,C,H].
export function fit(lch, bgs, ratio, dir) {
  let [L, C, H] = lch;
  for (let i = 0; i < 160; i++) {
    const h = hex([L, C, H]);
    if (bgs.every((bg) => contrast(h, bg) >= ratio)) return [L, C, H];
    L += dir * 0.005;
    if (L <= 0.02 || L >= 0.995) break;
  }
  return [clamp01(L), C, H];
}
