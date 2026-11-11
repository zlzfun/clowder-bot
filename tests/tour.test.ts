import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { catTemplates } from './native-fixture.js';

// The guide to what the app can do (showcase/, served at /tour/ by `npm run
// showcase`). It points at the staged chats by name, so it must never point at
// a chat the scene does not stage or play a demo the scene does not have; it
// makes no request to another origin; every picture it shows is there in both
// themes; and it is not part of the product.
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('showcase/index.html'), js = read('showcase/tour.js'), css = read('showcase/tour.css');
const scene = read('scripts/showcase-scene.ts');

// What scripts/showcase-scene.ts stages: one cat per template, the groups it makes, and the chats with a demo line.
const cats = catTemplates.map(([, name]) => name);
const groups = [...scene.matchAll(/\n {4}const name = '([^']+)'/g)].map(m => m[1]!);
const playLines = /for \(const \[face, line\] of Object\.entries\(\{([\s\S]*?)\}\)\) plays\.set\(cats\[face\]!\.name/.exec(scene);
const playFaces = [...(playLines?.[1] ?? '').matchAll(/(?:'([\w-]+)'|(\w+)):\s*'/g)].map(m => m[1] ?? m[2]);
const plays = [...catTemplates.filter(([id]) => playFaces.includes(id)).map(([, name]) => name), ...groups.filter(() => (scene.match(/plays\.set\(name, \{ group: group\.id/g) || []).length === groups.length)];

const attrs = (name: string) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map(m => m[1]!);

test('every chat the guide opens, plays, lists or hosts a section in is staged by the showcase, and every staged chat is on its list', () => {
  assert.deepEqual(groups, ['产品评审', '读书会'], 'the scene\'s groups, as this test reads them');
  assert.equal(playFaces.length, 8, 'the scene has a demo line for each cat');
  const opened = attrs('data-chat'), played = attrs('data-play'), listed = attrs('data-row'), hosts = attrs('data-host');
  const members = attrs('data-group').flatMap(list => list.split(/\s+/));
  assert.ok(opened.length >= 10 && played.length >= 8);
  for (const name of [...opened, ...listed, ...hosts]) assert.ok(cats.includes(name) || groups.includes(name), name + ' is staged');
  for (const name of members) assert.ok(cats.includes(name), name + ' is a staged cat');
  for (const name of played) assert.ok(plays.includes(name), name + ' has a demo line in the scene');
  assert.deepEqual([...listed].sort(), [...cats, ...groups].sort(), 'the opening list is the staged contact list');
  // The faces the guide draws are the templates the scene names its cats after.
  const faces = /const FACES = (\{[^}]*\});/.exec(js);
  assert.ok(faces, 'tour.js keeps the cats\' faces in one place');
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext('(' + faces![1] + ')'))), Object.fromEntries(catTemplates.map(([id, name]) => [name, id])));
  assert.match(js, /const GROUPS = \["产品评审", "读书会"\];/);
  for (const [, name, face] of html.matchAll(/data-row="([^"]+)" data-face="([^"]+)"/g)) assert.equal(face, catTemplates.find(([, n]) => n === name)?.[0], name);
  // Opening is the product's own link (/#chat=<URL-encoded name>); a demo is POST /__preview {"play": name}, then that link.
  assert.match(js, /a\.href = "\/#chat=" \+ encodeURIComponent\(a\.dataset\.chat\);/);
  assert.match(js, /fetch\("\/__preview", \{ method: "POST", credentials: "same-origin", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ play: name \}\) \}\)/);
  assert.doesNotMatch(html, /href="\/#chat=/, 'links are built from data-chat, not written by hand');
});

test('the guide makes no request to another origin: no absolute URL anywhere, every read and asset on the same origin', () => {
  for (const [file, source] of [['index.html', html], ['tour.js', js], ['tour.css', css]] as const) {
    assert.doesNotMatch(source, /\b(?:https?|wss?):\/\//i, file + ' names no other site');
    assert.doesNotMatch(source, /(?:src|href|srcset)\s*=\s*["']\/\//i, file + ' has no protocol-relative URL');
    assert.doesNotMatch(source, /url\(\s*["']?(?:\/\/|https?:)/i, file + ' loads nothing from elsewhere in CSS');
    assert.doesNotMatch(source, /@import/i, file);
  }
  for (const url of [...attrs('src'), ...attrs('href'), ...attrs('srcset')]) assert.match(url, /^(?:\/(?!\/)|#|[\w.-]+(?:\/[\w.-]+)*$)/, url + ' is same-origin');
  for (const [, url] of js.matchAll(/(?:fetch|get)\("([^"]+)"/g)) assert.match(url!, /^\/(?!\/)/, url + ' is a path on this origin');
  // The product's stylesheets and modules are loaded from where the app serves them, not copied.
  for (const asset of ['tokens.css', 'app.css', 'cafe-theme.css', 'chat-presence.css']) assert.ok(html.includes(`href="/${asset}"`), asset);
  assert.match(js, /load\(ROOT \+ "cat-avatars\.js"\), load\(ROOT \+ "chat-list-rules\.js"\)/);
  assert.deepEqual(readdirSync(new URL('../showcase/', import.meta.url)).filter(f => !['index.html', 'tour.css', 'tour.js', 'shots'].includes(f)), [], 'nothing else in showcase/');
});

test('every picture is a real screenshot in both themes, with words that say what it shows, and the set stays small', () => {
  const lights = [...html.matchAll(/<img src="shots\/([\w-]+)-light\.png"[^>]*\salt="([^"]*)"/g)];
  const darks = [...html.matchAll(/<source srcset="shots\/([\w-]+)-dark\.png" media="\(prefers-color-scheme: dark\)">/g)].map(m => m[1]);
  assert.ok(lights.length >= 12);
  assert.deepEqual(lights.map(m => m[1]), darks, 'each picture has its dark twin, switched by the system theme');
  for (const [, name, alt] of lights) {
    assert.ok(alt!.length >= 12, name + ' has words for what it shows');
    for (const theme of ['light', 'dark']) assert.ok(existsSync(new URL(`../showcase/shots/${name}-${theme}.png`, import.meta.url)), `${name}-${theme}.png`);
  }
  assert.equal((html.match(/<img /g) || []).length, lights.length + 1, 'the brand mark is the only other image');
  const dir = new URL('../showcase/shots/', import.meta.url);
  const files = readdirSync(dir);
  assert.deepEqual(files.filter(f => !lights.some(([, name]) => f === `${name}-light.png` || f === `${name}-dark.png`)), [], 'no picture the page does not show');
  const total = files.reduce((n, f) => n + statSync(new URL(f, dir)).size, 0);
  assert.ok(total < 4.2 * 1024 * 1024, `${(total / 1048576).toFixed(2)} MB of pictures`);
  // Retaken by the committed script, from a running showcase, with Playwright from outside the repository.
  const shots = read('scripts/showcase-shots.mjs');
  assert.match(shots, /process\.env\.PLAYWRIGHT_MODULES/);
  assert.match(shots, /Playwright was not found in \$\{modules\}; set PLAYWRIGHT_MODULES/);
  assert.match(shots, /deviceScaleFactor: 2/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies }).includes('playwright'), 'Playwright is not a dependency');
});

test('the guide speaks the app\'s own words, says once that the chats are staged, and is not part of the product', () => {
  const words = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*\salt="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, ' ');
  const literals = [...js.replace(/^\s*\/\/.*$/gm, '').matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map(m => m[1]).filter(s => /\p{Script=Han}/u.test(s!)).join(' ');
  for (const [where, text] of [['page', words], ['tour.js', literals]] as const) {
    const plain = text!.replace(/clowder-bot/g, '');
    assert.doesNotMatch(plain, /\bBot\b|\bAgent\b|session|thread|会话|原生|群组/i, where + ' says 猫猫、对话、群聊');
  }
  assert.equal((words.match(/事先写好/g) || []).length, 1, 'staged, said once');
  assert.match(words, /npm run showcase/);
  // Not linked from the product, not in its build.
  for (const file of readdirSync(new URL('../client/public/', import.meta.url)).filter(f => /\.(js|css|html)$/.test(f))) {
    assert.doesNotMatch(read('client/public/' + file), /\/tour\/|showcase\//, file + ' does not link the guide');
  }
  assert.doesNotMatch(read('client/index.html'), /\/tour\/|showcase\//);
  // Landmarks, one h1, headings for each part, a way past the header.
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  for (const tag of ['<header', '<main id="main"', '<footer', '<nav class="t-roster"']) assert.ok(html.includes(tag), tag);
  assert.match(html, /<a class="t-skip" href="#main">/);
  for (const id of attrs('aria-labelledby')) assert.ok(html.includes(`id="${id}"`), id);
  // Motion only on the product's own tokens and keyframes, and none when reduced motion is asked for.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ html \{ scroll-behavior: auto; \} \}/);
  assert.match(js, /reduce\(\) \? "auto" : "smooth"/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'no colour of its own: tokens only (a cat\'s accent comes from the server)');
});
