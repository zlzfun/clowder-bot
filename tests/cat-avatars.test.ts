import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';

const browser = { window: {} as any };
vm.runInNewContext(readFileSync(new URL('../client/public/cat-avatars.js', import.meta.url), 'utf8'), browser);
const cats = browser.window.ClowderAvatars;
const ids = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'];

test('cat identities survive old seeds and renames; explicit choices override template defaults', () => {
  for (const id of ids) {
    assert.equal(cats.resolveBreed('old-person-seed#2', id, 'renamed'), id);
    assert.equal(cats.resolveBreed(undefined, id, 'another name'), id);
    assert.equal(cats.resolveBreed('cat:' + id, 'ragdoll', 'renamed'), id);
  }
  assert.equal(cats.resolveBreed('砚砚'), 'maine-coon');
  assert.equal(cats.resolveBreed('烁烁'), 'siamese');
  assert.equal(cats.resolveBreed('glyph'), 'ragdoll');
  assert.equal(cats.resolveBreed('old-peer'), cats.resolveBreed('old-peer'));
  assert.ok(ids.includes(cats.resolveBreed('<arbitrary legacy input>')));
  let seed = cats.defaultSeed();
  const choices = new Set();
  for (let n = 0; n < 8; n++) { choices.add(seed); seed = cats.nextSeed(seed); }
  assert.equal(choices.size, 8);
  assert.equal(seed, 'cat:ragdoll');
});

test('all eight portraits use bounded, distinct cells of the production sheet', () => {
  const file = readFileSync(new URL('../client/public/avatars/clay-cats.png', import.meta.url));
  assert.equal(file.readUInt32BE(16), 1774);
  assert.equal(file.readUInt32BE(20), 887);
  type Node = { tag: string; attributes: Record<string, string>; style: Record<string, string>; children: Node[]; setAttribute: (key: string, value: string) => void; append: (...nodes: Node[]) => void };
  const doc = { createElementNS(_ns: string, tag: string): Node {
    return { tag, attributes: {}, style: {}, children: [], setAttribute(key, value) { this.attributes[key] = value; }, append(...nodes) { this.children.push(...nodes); } };
  } };
  const offsets = new Set();
  const clips = new Set();
  for (const id of ids) {
    const svg: Node = cats.createPortrait('cat:' + id, undefined, '', doc);
    assert.equal(svg.attributes['data-cat-id'], id);
    assert.equal(svg.style.overflow, 'hidden');
    // Transparent around the cat: no backdrop shape, only the clipped artwork.
    assert.deepEqual(svg.children.map(node => node.tag), ['defs', 'g']);
    const crop = svg.children.find(node => node.tag === 'defs')!.children[0];
    assert.equal(crop.tag, 'clipPath');
    assert.deepEqual(crop.children.map(node => [node.tag, node.attributes.d]), [['path', cats.outlines[id]]]);
    clips.add(crop.attributes.id);
    const group = svg.children.find(node => node.tag === 'g')!;
    assert.equal(group.attributes['clip-path'], `url(#${crop.attributes.id})`);
    const image = group.children[0];
    assert.equal(image.attributes.href, '/avatars/clay-cats.png');
    const x = -Number(image.attributes.x), y = -Number(image.attributes.y);
    assert.ok(x >= 0 && x + 443.5 <= 1774);
    assert.ok(y >= 0 && y + 443.5 <= 887);
    offsets.add(`${x},${y}`);
  }
  assert.equal(offsets.size, 8);
  assert.equal(clips.size, 8);
});

test('each outline is a fresh trace of the sheet: one closed shape inside its cell that keeps the cat', () => {
  const script = fileURLToPath(new URL('../scripts/trace-cat-outlines.mjs', import.meta.url));
  // Exits non-zero unless cat-avatars.js carries exactly what the sheet traces to.
  execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
  assert.deepEqual(Object.keys(cats.outlines), ids);
  for (const id of ids) {
    const d: string = cats.outlines[id];
    assert.match(d, /^M\d+ \d+l[-\d ]+z$/);
    assert.equal((d.match(/[Mm]/g) || []).length, 1, `${id}: one outer outline, no holes`);
    const numbers = d.match(/-?\d+/g)!.map(Number);
    const points: [number, number][] = [];
    let x = numbers[0], y = numbers[1];
    points.push([x, y]);
    for (let i = 2; i < numbers.length; i += 2) { x += numbers[i]; y += numbers[i + 1]; points.push([x, y]); }
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
      area += x1 * y2 - x2 * y1;
      assert.ok(x1 >= 0 && x1 <= 443.5 && y1 >= 0 && y1 <= 443.5, `${id}: inside its cell`);
    }
    // A cat bust, not a sliver and not the whole tile (the sheet's margin stays out).
    const share = Math.abs(area) / 2 / (443.5 * 443.5);
    assert.ok(share > 0.35 && share < 0.65, `${id}: covers ${share.toFixed(2)} of the cell`);
    // The flat base is rounded onto the solo face's circle: nothing below its arc.
    const r = 443.5 / 2 / 1.05;
    for (const [px, py] of points) if (py > r) assert.ok(Math.hypot(px - 443.5 / 2, py - r) <= r + 1.5, `${id}: base inside the arc`);
  }
});

test('bot API preserves breed through creation, rename, upload, restore and export', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-cat-avatars-'));
  const runtime = createApp({ dataFile: join(dir, 'state.json'), native: new NativeFixture() });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/xbot-api`;
  t.after(async () => { await runtime.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, path: string, body?: unknown) => fetch(base + path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const json = async (path: string) => (await call('GET', path)).json() as Promise<any>;
  for (const id of ids) {
    assert.equal((await call('POST', '/bots', { name: id, templateId: id })).status, 201);
    const bot = await json('/bots/' + id);
    assert.equal(bot.templateId, id);
    assert.equal(bot.avatar_seed, 'cat:' + id);
  }
  assert.equal((await call('PATCH', '/bots/maine-coon', { name: 'renamed-reviewer' })).status, 200);
  let bot = await json('/bots/renamed-reviewer');
  assert.equal(bot.avatar_seed, 'cat:maine-coon');
  assert.equal(bot.templateId, 'maine-coon');
  assert.equal((await call('PATCH', '/bots/renamed-reviewer', { avatar_seed: 'cat:bengal' })).status, 200);
  bot = await json('/bots/renamed-reviewer');
  assert.equal(bot.avatar_seed, 'cat:bengal');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const form = new FormData(); form.append('file', new Blob([image], { type: 'image/png' }), 'portrait.png');
  assert.equal((await fetch(base + '/bots/renamed-reviewer/avatar', { method: 'POST', body: form })).status, 200);
  bot = await json('/bots/renamed-reviewer');
  assert.equal(bot.avatar, 'custom');
  assert.match(bot.avatar_url, /^\/xbot-api\/bots\/renamed-reviewer\/avatar\?v=/);
  assert.equal(bot.avatar_seed, 'cat:bengal');
  assert.equal((await call('DELETE', '/bots/renamed-reviewer/avatar')).status, 200);
  bot = await json('/bots/renamed-reviewer');
  assert.equal(bot.avatar, 'generated');
  assert.equal(bot.avatar_url, '');
  assert.equal(bot.avatar_seed, 'cat:maine-coon');
  const template = await json('/bots/renamed-reviewer/template');
  assert.equal(template.templateId, 'maine-coon');
  assert.equal(template.avatar_seed, 'cat:maine-coon');
  const listed = (await json('/bots')).bots.find((item: any) => item.name === 'renamed-reviewer');
  assert.equal(listed.templateId, 'maine-coon');
  assert.equal(listed.avatar_seed, 'cat:maine-coon');
});
