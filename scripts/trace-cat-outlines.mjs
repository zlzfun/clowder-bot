// Traces each clay cat's outline from the original RGB sheet so cat-avatars.js
// can clip the portrait to the cat itself (a transparent background) without
// changing the bitmap. Dependency-free: Node's zlib decodes the PNG.
//
//   node scripts/trace-cat-outlines.mjs           print the outline table
//   node scripts/trace-cat-outlines.mjs --check   fail if cat-avatars.js differs
//
// Per 443.5px cell: background = median of the cell border (the sheet's flat
// off-white); flood the background in from the border through pixels within
// TOLERANCE of it, so light fur inside the outline is never reached; open the
// mask (removes whiskers and stray strands), keep the one cat, fill holes,
// erode a hair to drop the anti-aliased off-white fringe; the flat bust base is
// rounded to the arc of the solo avatar circle (cell centre x, radius 211.19,
// see cafe-theme.css's 1.25x close-up); trace at sub-pixel precision
// (marching squares on a lightly blurred mask) and simplify.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

const SHEET = new URL('../client/public/avatars/clay-cats.png', import.meta.url);
const RENDERER = new URL('../client/public/cat-avatars.js', import.meta.url);
const IDS = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'];
const CELL = 443.5;
const TOLERANCE = 12;   // max channel distance from the background that still floods
const OPEN = 2;         // disk radius (px) that whiskers and loose strands do not survive
const ERODE = 1;        // px trimmed from the outline to drop the off-white fringe
const ISO = 0.5;        // contour level on the 3x3-blurred mask
const EPSILON = 1.1;    // Douglas-Peucker tolerance (px)
// Solo close-up (cafe-theme.css): tile at 105%, centred, top edge at the top.
// Its circle in cell units: centre (CELL/2, CELL/2/1.05), radius CELL/2/1.05.
const BASE = { cx: CELL / 2, cy: CELL / 2 / 1.05, r: CELL / 2 / 1.05 };

function decodePng(buffer) {
  assert.equal(buffer.toString('latin1', 1, 4), 'PNG');
  let offset = 8, width = 0, height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9], data[12]], [8, 2, 0], 'expects 8-bit RGB, non-interlaced');
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), bpp = 3, stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? pixels[y * stride + i - bpp] : 0;
      const up = y ? pixels[(y - 1) * stride + i] : 0;
      const corner = y && i >= bpp ? pixels[(y - 1) * stride + i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      pixels[y * stride + i] = value & 255;
    }
  }
  return { width, height, pixels };
}

function disk(radius) {
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= radius * radius + radius) offsets.push([dx, dy]);
  return offsets;
}
// Erode (all neighbours set) or dilate (any neighbour set); outside counts as empty.
function morph(mask, w, h, radius, erode) {
  if (!radius) return mask;
  const out = new Uint8Array(w * h), offsets = disk(radius);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = erode;
    for (const [dx, dy] of offsets) {
      const nx = x + dx, ny = y + dy, on = nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx];
      if (erode ? !on : on) { hit = !erode; break; }
    }
    out[y * w + x] = hit ? 1 : 0;
  }
  return out;
}
// Pixels that pass the test and are 4-way connected to a passing seed.
function flood(w, h, passable, seeds) {
  const seen = new Uint8Array(w * h), stack = [];
  for (const k of seeds) if (passable(k) && !seen[k]) { seen[k] = 1; stack.push(k); }
  while (stack.length) {
    const k = stack.pop(), x = k % w, y = (k - x) / w;
    for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
      if (n >= 0 && !seen[n] && passable(n)) { seen[n] = 1; stack.push(n); }
    }
  }
  return seen;
}
const borderOf = (w, h) => {
  const out = [];
  for (let x = 0; x < w; x++) out.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) out.push(y * w, y * w + w - 1);
  return out;
};

function cellMask(sheet, index) {
  const col = index % 4, row = Math.floor(index / 4);
  const x0 = Math.floor(col * CELL), y0 = Math.floor(row * CELL);
  const w = Math.min(sheet.width, Math.ceil((col + 1) * CELL)) - x0, h = Math.min(sheet.height, Math.ceil((row + 1) * CELL)) - y0;
  const at = (x, y) => (y0 + y) * sheet.width * 3 + (x0 + x) * 3;
  const border = borderOf(w, h);
  const median = (channel) => border.map((k) => sheet.pixels[at(k % w, Math.floor(k / w)) + channel]).sort((a, b) => a - b)[border.length >> 1];
  const bg = [median(0), median(1), median(2)];
  const distance = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = at(x, y);
    distance[y * w + x] = Math.max(Math.abs(sheet.pixels[p] - bg[0]), Math.abs(sheet.pixels[p + 1] - bg[1]), Math.abs(sheet.pixels[p + 2] - bg[2]));
  }
  const background = flood(w, h, (k) => distance[k] <= TOLERANCE, border);
  let mask = background.map((v) => (v ? 0 : 1));
  mask = morph(morph(mask, w, h, OPEN, true), w, h, OPEN, false);
  // The cat is the largest piece; holes inside it are fur, not background.
  const seen = new Uint8Array(w * h);
  let best = null;
  for (let k = 0; k < w * h; k++) {
    if (!mask[k] || seen[k]) continue;
    const piece = flood(w, h, (n) => mask[n] === 1, [k]);
    let size = 0;
    for (let n = 0; n < w * h; n++) if (piece[n]) { seen[n] = 1; size++; }
    if (!best || size > best.size) best = { piece, size };
  }
  const outside = flood(w, h, (k) => !best.piece[k], border);
  mask = outside.map((v) => (v ? 0 : 1));
  mask = morph(mask, w, h, ERODE, true);
  // Round the flat base onto the solo circle's lower arc.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x0 + x + 0.5 - col * CELL, v = y0 + y + 0.5 - row * CELL;
    if (v > BASE.cy && (u - BASE.cx) ** 2 + (v - BASE.cy) ** 2 > BASE.r ** 2) mask[y * w + x] = 0;
  }
  return { mask, w, h, ox: x0 - col * CELL + 0.5, oy: y0 - row * CELL + 0.5, bg };
}

// 3x3 box blur, padded by one empty pixel so every contour closes.
function field(mask, w, h) {
  const W = w + 2, H = h + 2, out = new Float32Array(W * H);
  const get = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += get(x - 1 + dx, y - 1 + dy);
    out[y * W + x] = sum / 9;
  }
  return { f: out, W, H };
}

// Marching squares; returns the loop enclosing the largest area (grid units).
function largestContour({ f, W, H }, level) {
  const point = new Map(), links = new Map();
  const edge = (x, y, vertical) => {
    const id = (y * W + x) * 2 + (vertical ? 1 : 0);
    if (!point.has(id)) {
      const a = f[y * W + x], b = vertical ? f[(y + 1) * W + x] : f[y * W + x + 1], t = (level - a) / (b - a);
      point.set(id, vertical ? [x, y + t] : [x + t, y]);
    }
    return id;
  };
  const link = (a, b) => {
    (links.get(a) || links.set(a, []).get(a)).push(b);
    (links.get(b) || links.set(b, []).get(b)).push(a);
  };
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = f[y * W + x] > level, b = f[y * W + x + 1] > level, c = f[(y + 1) * W + x + 1] > level, d = f[(y + 1) * W + x] > level;
    const index = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
    if (index === 0 || index === 15) continue;
    const top = () => edge(x, y, false), right = () => edge(x + 1, y, true), bottom = () => edge(x, y + 1, false), left = () => edge(x, y, true);
    const centre = (f[y * W + x] + f[y * W + x + 1] + f[(y + 1) * W + x + 1] + f[(y + 1) * W + x]) / 4 > level;
    switch (index) {
      case 1: case 14: link(left(), top()); break;
      case 2: case 13: link(top(), right()); break;
      case 3: case 12: link(left(), right()); break;
      case 4: case 11: link(right(), bottom()); break;
      case 6: case 9: link(top(), bottom()); break;
      case 7: case 8: link(left(), bottom()); break;
      case 5: if (centre) { link(left(), bottom()); link(top(), right()); } else { link(left(), top()); link(right(), bottom()); } break;
      case 10: if (centre) { link(left(), top()); link(right(), bottom()); } else { link(top(), right()); link(left(), bottom()); } break;
    }
  }
  const used = new Set();
  let best = null;
  for (const start of links.keys()) {
    if (used.has(start)) continue;
    const loop = [];
    let previous = -1, current = start;
    while (current !== undefined && !used.has(current)) {
      used.add(current); loop.push(point.get(current));
      const next = links.get(current).find((n) => n !== previous && !used.has(n));
      previous = current; current = next;
    }
    let area = 0;
    for (let i = 0; i < loop.length; i++) { const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length]; area += x1 * y2 - x2 * y1; }
    if (!best || Math.abs(area) > Math.abs(best.area)) best = { loop, area };
  }
  return best.loop;
}

// Douglas-Peucker on an open run of points (both ends kept).
function simplifyRun(points, epsilon) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const run = (first, last) => {
    const [ax, ay] = points[first], [bx, by] = points[last], len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, far = 0;
    for (let i = first + 1; i < last; i++) {
      const d = Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / len;
      if (d > far) { far = d; worst = i; }
    }
    if (far > epsilon) { keep[worst] = 1; run(first, worst); run(worst, last); }
  };
  run(0, points.length - 1);
  return points.filter((_, i) => keep[i]);
}
// A closed loop is split at its two most distant points and each half simplified.
function simplify(loop, epsilon) {
  let opposite = 0, reach = 0;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > reach) { reach = d; opposite = i; }
  }
  const head = simplifyRun(loop.slice(0, opposite + 1), epsilon);
  const tail = simplifyRun([...loop.slice(opposite), loop[0]], epsilon);
  return [...head, ...tail.slice(1, -1)];
}

// Integer cell coordinates, relative moves after the first point.
function toPath(points) {
  const rounded = points.map(([x, y]) => [Math.round(x), Math.round(y)]).filter((p, i, all) => !i || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
  let d = `M${rounded[0][0]} ${rounded[0][1]}l`;
  for (let i = 1; i < rounded.length; i++) {
    const dx = rounded[i][0] - rounded[i - 1][0], dy = rounded[i][1] - rounded[i - 1][1];
    d += (i > 1 && dx >= 0 ? ' ' : '') + dx + (dy >= 0 ? ' ' : '') + dy;
  }
  return d + 'z';
}

export function traceOutlines() {
  const sheet = decodePng(readFileSync(SHEET));
  assert.deepEqual([sheet.width, sheet.height], [1774, 887]);
  const out = {};
  IDS.forEach((id, index) => {
    const { mask, w, h, ox, oy } = cellMask(sheet, index);
    // Grid node (x, y) of the padded field is pixel (x - 1, y - 1)'s centre.
    const loop = largestContour(field(mask, w, h), ISO).map(([x, y]) => [x - 1 + ox, y - 1 + oy]);
    out[id] = toPath(simplify(loop, EPSILON));
  });
  return out;
}

// The exact block cat-avatars.js carries.
export function outlineTable(outlines = traceOutlines()) {
  return '  const outlines = Object.freeze({\n' + IDS.map((id) => `    "${id}": "${outlines[id]}",`).join('\n') + '\n  });';
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const outlines = traceOutlines();
  if (process.argv.includes('--check')) {
    assert.ok(readFileSync(RENDERER, 'utf8').includes(outlineTable(outlines)), 'cat-avatars.js outlines differ from a fresh trace of clay-cats.png');
    console.log('cat-avatars.js outlines match clay-cats.png');
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify(outlines));
  } else {
    console.log(outlineTable(outlines));
    console.error(IDS.map((id) => `${id}: ${outlines[id].length} chars`).join(', '));
  }
}
