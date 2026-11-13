// Freezes the screens the colour lab shows every palette on
// (client/public/theme-lab/, served at /theme-lab/; docs/xbot-frontend.md item 47).
// Each scene is the real interface: the running showcase, opened in a headless
// browser at 1200×760 and put into the state the scene is for, then its <body>
// copied as markup. The copy keeps what the page shows and nothing that runs:
// scripts and inline handlers are dropped; what a script left only as a
// property (a typed value, a ticked box, a picked option, how far a list is
// scrolled) is written into attributes (scroll as data-lab-scroll) so the copy
// looks the same. It starts nothing itself:
//
//   TZ=Asia/Shanghai npm run showcase                  (in one terminal; restart it first, so
//                                                       the chats are as staged, not as you left them)
//   BASE=http://127.0.0.1:3230/ node scripts/theme-lab/scenes.mjs
//
// It clicks through the chats it freezes, so before anything else it asks BASE
// what it is: only the scripted preview answers GET /__preview, and only
// {preview: true, scene: "showcase", staged: true} goes ahead; the instance on
// 3210 is refused without asking. The light and the dark page are taken side by
// side; the app draws the same markup for both, and where a scene's two copies
// differ both are kept. The one style the app writes into <head> at run time,
// each cat's own colour where it stays legible (chat-presence.js), depends on
// the theme's surfaces, so it is not frozen: the cats' colour pairs are kept and
// the lab asks the app's own chat-presence-rules.js again for each palette. This
// script checks that doing so with today's colours gives exactly what the app
// wrote, and refuses to write anything the lab could not show the same way (a
// head it does not know, a picture that is not a file the app serves).
//
// Playwright is not a dependency of this repository: it is loaded from
// PLAYWRIGHT_MODULES (a node_modules directory that has it); CHROMIUM may name
// the browser to launch.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const target = join(root, 'client/public/theme-lab/scenes.json');
const base = new URL(process.env.BASE || 'http://127.0.0.1:3230/');
if (base.port === '3210') { console.error('BASE must be a showcase (npm run showcase), never the instance on 3210.'); process.exit(1); }

// What BASE is, asked before anything is loaded or clicked (GET changes nothing there).
let identity = null;
try {
  const answer = await fetch(new URL('/__preview', base), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  identity = answer.ok ? await answer.json() : null;
} catch { identity = null; }
if (!(identity && typeof identity === 'object' && identity.preview === true && identity.scene === 'showcase' && identity.staged === true)) {
  console.error(`${base.href} is not the showcase with its chats staged (its GET /__preview did not say so), so nothing was opened or frozen; start it with npm run showcase and point BASE at it.`);
  process.exit(1);
}
const zone = typeof identity.zone === 'string' && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(identity.zone) ? identity.zone : undefined;

const modules = process.env.PLAYWRIGHT_MODULES || join(homedir(), '.npm/_npx/31e32ef8478fbf80/node_modules');
let chromium;
try { ({ chromium } = createRequire(join(modules, 'noop.js'))('playwright')); }
catch { console.error(`Playwright was not found in ${modules}; set PLAYWRIGHT_MODULES to a node_modules directory that has it.`); process.exit(1); }
const shell = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const executablePath = process.env.CHROMIUM || (existsSync(shell) ? shell : undefined);

// The lab's frame is this big; the large view shows it at this size.
const viewport = { width: 1200, height: 760 };
// The stylesheets the app's page links (client/index.html), the only things <head> may hold besides the one style below.
const indexHtml = readFileSync(join(root, 'client/index.html'), 'utf8');
const linked = [...indexHtml.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]);

console.log(`showcase at ${base.href}, time zone ${zone ?? '(the browser\'s own)'}`);
const browser = await chromium.launch({ executablePath });
const pages = [];
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce', timezoneId: zone, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error(`[${theme}] page error: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.error(`[${theme}] console: ${m.text().slice(0, 200)}`); });
  pages.push({ theme, page });
}
const both = (fn) => Promise.all(pages.map(({ page, theme }) => fn(page, theme)));
// Nothing hovered (a hover shows a tooltip) and nothing focused, fonts in, layout settled.
const settle = async (page) => {
  await page.mouse.move(viewport.width - 1, viewport.height - 1);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
};
async function open(page, name) {
  await page.locator('#sidebar').getByText(name, { exact: true }).first().click();
  await page.waitForFunction(n => document.querySelector('#title .title-name')?.textContent === n && document.querySelector('#thread .thread-inner .msg'), name);
  await page.waitForTimeout(700);
}
const bottom = (page) => page.locator('#thread').evaluate((t) => { t.scrollTop = t.scrollHeight; });

/** The page's <body> as markup that shows the same and runs nothing, plus what <head> holds beyond the linked stylesheets. */
function freeze() {
  const live = document.body, copy = live.cloneNode(true);
  // cloneNode keeps the structure, so the two trees are walked in step.
  const a = document.createTreeWalker(live, NodeFilter.SHOW_ELEMENT), b = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT);
  for (let x = live, y = copy; x && y; x = a.nextNode(), y = b.nextNode()) {
    if (x.scrollTop !== 0) y.setAttribute('data-lab-scroll', Math.abs(x.scrollHeight - x.clientHeight - Math.abs(x.scrollTop)) <= 2 ? 'end' : String(Math.round(x.scrollTop)));
    if (x instanceof HTMLInputElement) {
      if (x.type === 'checkbox' || x.type === 'radio') x.checked ? y.setAttribute('checked', '') : y.removeAttribute('checked');
      else if (x.type !== 'file' && x.type !== 'password') x.value ? y.setAttribute('value', x.value) : y.removeAttribute('value');
    } else if (x instanceof HTMLTextAreaElement) y.textContent = x.value;
    else if (x instanceof HTMLOptionElement) x.selected ? y.setAttribute('selected', '') : y.removeAttribute('selected');
  }
  for (const node of copy.querySelectorAll('script, noscript')) node.remove();
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || name === 'autofocus' || (/^(?:href|xlink:href|src|action|formaction)$/i.test(name) && /^\s*javascript:/i.test(value))) el.removeAttribute(name);
    }
  }
  const head = [...document.head.children].filter(n => !(n.tagName === 'LINK' && n.rel !== 'stylesheet') && !['META', 'TITLE', 'SCRIPT'].includes(n.tagName));
  return {
    body: copy.outerHTML,
    html: Object.fromEntries([...document.documentElement.attributes].filter(attr => attr.name !== 'data-theme').map(attr => [attr.name, attr.value])),
    links: head.filter(n => n.tagName === 'LINK').map(n => n.getAttribute('href')),
    styles: head.filter(n => n.tagName !== 'LINK').map(n => ({ tag: n.tagName, id: n.id, text: n.textContent })),
  };
}

const scenes = [];
let cats = null, html = null;
async function take(id, name) {
  const frozen = await both(async (page, theme) => { await settle(page); return { theme, ...(await page.evaluate(freeze)) }; });
  for (const { theme, links, styles, html: attrs } of frozen) {
    if (JSON.stringify(links) !== JSON.stringify(linked)) throw new Error(`${id} (${theme}): <head> links ${links.join(', ')}, not client/index.html's stylesheets`);
    const unknown = styles.filter(s => !(s.tag === 'STYLE' && s.id === 'pz-accents'));
    if (unknown.length) throw new Error(`${id} (${theme}): <head> holds ${unknown.map(s => s.tag + (s.id ? '#' + s.id : '')).join(', ')}, which the lab does not draw`);
    accents(theme, styles.find(s => s.id === 'pz-accents')?.text ?? '', id);
    html ??= attrs;
    if (JSON.stringify(attrs) !== JSON.stringify(html)) throw new Error(`${id} (${theme}): <html> attributes changed`);
  }
  const [light, dark] = frozen;
  scenes.push(light.body === dark.body ? { id, name, body: light.body } : { id, name, body: { light: light.body, dark: dark.body } });
  console.log(`  ${id} ${name}${light.body === dark.body ? '' : ' (light and dark differ: both kept)'}`);
}

// The lab draws each cat's colour with the app's own rules on each palette's surfaces; with today's colours that must
// give what the app wrote (order aside: the app lists the cats as it holds them).
const palettes = JSON.parse(readFileSync(join(root, 'client/public/theme-lab/palettes.json'), 'utf8'));
const current = palettes.find(p => p.current);
const box = { window: {} };
vm.runInNewContext(readFileSync(join(root, 'client/public/chat-presence-rules.js'), 'utf8'), box);
const presence = box.window.ClowderPresenceRules;
const lines = (css) => css.split('\n').filter(Boolean).sort();
function accents(theme, written, id) {
  const tokens = current[theme].tokens;
  const drawn = presence.accentCss(cats, { chat: tokens['--x-card'], bubble: tokens['--x-bot-bubble'] });
  if (JSON.stringify(lines(drawn)) !== JSON.stringify(lines(written))) throw new Error(`${id} (${theme}): the cats' colours the lab would draw differ from what the app wrote`);
}

try {
  await both(async (page) => {
    await page.goto(new URL('/', base).href, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#roster .item') && document.querySelector('#thread .thread-inner .msg'));
    await page.waitForTimeout(800);
  });
  // Staged, not as someone left it: 鲸鲸's unread count is there until its chat is opened.
  const staged = await both(page => page.locator('#roster .item[data-bot="鲸鲸"] .cl-count:not([hidden])').count());
  if (staged.some(n => !n)) throw new Error('鲸鲸 has no unread count: the chats are not as staged (restart the showcase)');
  // The cats' colour pairs, as the server gives them (bots[].accent).
  cats = (await pages[0].page.evaluate(() => fetch('/xbot-api/bots').then(r => r.json()))).bots
    .filter(bot => bot.accent).map(bot => ({ native_id: bot.native_id || bot.id, accent: { primary: bot.accent.primary, secondary: bot.accent.secondary } }));
  console.log('freezing from ' + base.href);

  // 群聊: the sidebar (the open chat, 鲸鲸's unread count and 等你确认, the pinned cat), cats answering in their own colours, the composer.
  await both(async (page) => { await open(page, '产品评审'); await bottom(page); });
  await take('group', '群聊');
  // 卡片: 砚砚's review: a diff, a checklist with ticks, the owner's code in a bubble above (scroll up in the large view).
  await both(async (page) => { await open(page, '砚砚'); await bottom(page); });
  await take('cards', '卡片');
  // 确认: 鲸鲸 asks to set a reminder: the card with 不用 / 设上, the 等你确认 line over the composer, a reminder that came due.
  await both(async (page) => { await open(page, '鲸鲸'); await bottom(page); });
  await take('confirm', '确认');
  // 设置: 我 → 设置 → 通用, a select and a switch over the dimmed app.
  await both(async (page) => {
    await page.locator('#account').click();
    await page.locator('#account-settings').click();
    await page.waitForSelector('#setpage:not([hidden])');
    await page.locator('#setpage .setnav [data-set="general"]').click();
    await page.waitForTimeout(500);
  });
  await take('settings', '设置');
  await both(page => page.locator('#settings-close').click());
  // 新建: the round ＋ opens 新建 on its 猫猫 side; 墨墨 picked, a name typed; 取消 and 创建 over the scrim.
  await both(async (page) => {
    await page.locator('#side-new').click();
    await page.waitForSelector('.qc-card .qc-face');
    await page.locator('.qc-card .qc-face[data-face="turkish-van"]').click();
    await page.locator('.qc-card').getByLabel('名字', { exact: true }).fill('年糕');
    await page.waitForTimeout(400);
  });
  await take('new', '新建');
  await both(page => page.locator('.qc-card').getByRole('button', { name: '取消', exact: true }).click());
} catch (error) {
  console.error('Stopped: ' + String(error.message).split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
if (!process.exitCode) {
  // Every picture a scene shows is a file the app serves (so the lab shows it wherever it is opened), or inline.
  const markup = scenes.flatMap(s => typeof s.body === 'string' ? [s.body] : [s.body.light, s.body.dark]).join('\n');
  const pictures = [...markup.matchAll(/<(?:img|image|source|video)\b[^>]*?\s(?:src|href|srcset|poster)="([^"]*)"/g), ...markup.matchAll(/url\((?:&quot;|["'])?([^)"'&]+)/g)]
    .map(m => m[1]).filter(ref => ref && !ref.startsWith('data:') && !ref.startsWith('#') && !(ref.startsWith('/') && existsSync(join(root, 'client/public', ref.split(/[?#]/)[0]))));
  if (pictures.length) { console.error(`Stopped: pictures that are not files the app serves: ${[...new Set(pictures)].join(', ')}`); process.exit(1); }
  writeFileSync(target, JSON.stringify({ viewport, html, cats, scenes }, null, 1) + '\n');
  console.log(`${scenes.length} scenes in client/public/theme-lab/scenes.json, ${(Buffer.byteLength(readFileSync(target)) / 1024).toFixed(0)} KB`);
}
