// Retakes the pictures of the guide to what the app can do (showcase/index.html,
// served at /tour/ by `npm run showcase`). Every picture is the real interface:
// the running showcase, opened in a headless browser, put into the state the
// guide talks about, and cropped to what matters, at 2× pixel density, once in
// the light theme and once in the dark one (showcase/shots/<name>-light.png,
// <name>-dark.png). It starts nothing itself:
//
//   TZ=Asia/Shanghai npm run showcase                  (in one terminal; restart it first, so
//                                                       the chats are as staged, not as you left them)
//   BASE=http://127.0.0.1:3230/ node scripts/showcase-shots.mjs
//
// It clicks through the chats it pictures (opens them, picks options, plays a
// demo), so before anything else it asks BASE what it is: only the scripted
// preview answers GET /__preview, and only {preview: true, scene: "showcase",
// staged: true} goes ahead. Anything else (a real instance, even one with the
// same cat names; the plain preview; no answer) is refused in one sentence.
//
// The pictures show times and a reminder's time zone, so the browser runs in
// the showcase's own zone (the /__preview answer's `zone`), and the committed
// set is taken from a showcase started with TZ=Asia/Shanghai (the adapter's
// default zone for a cat), which makes it the same whichever machine retakes
// it. The staged chats are dated relative to "now", so all pictures are taken
// in one run, the light and the dark page side by side at each step. Two of
// them change what is staged: 宪宪 plays its demo (the reply is caught while
// it is being written) and the contact list is taken first, before opening a
// chat clears its unread count. The cats are called by their names (宪宪, 砚砚,
// 烁烁…: what their templates call them). ONLY=live,group retakes some (the
// rest keep theirs).
//
// Playwright is not a dependency of this repository: it is loaded from
// PLAYWRIGHT_MODULES (a node_modules directory that has it); CHROMIUM may name
// the browser to launch.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'showcase', 'shots');
const base = new URL(process.env.BASE || 'http://127.0.0.1:3230/');
if (base.port === '3210') { console.error('BASE must be a showcase (npm run showcase), never the instance on 3210.'); process.exit(1); }

// What BASE is, asked before anything is loaded or clicked (GET changes nothing there).
let identity = null;
try {
  const answer = await fetch(new URL('/__preview', base), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  identity = answer.ok ? await answer.json() : null;
} catch { identity = null; }
if (!(identity && typeof identity === 'object' && identity.preview === true && identity.scene === 'showcase' && identity.staged === true)) {
  console.error(`${base.href} is not the showcase with its chats staged (its GET /__preview did not say so), so nothing was opened or taken; start it with npm run showcase and point BASE at it.`);
  process.exit(1);
}
const zone = typeof identity.zone === 'string' && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(identity.zone) ? identity.zone : undefined;

const modules = process.env.PLAYWRIGHT_MODULES || join(homedir(), '.npm/_npx/31e32ef8478fbf80/node_modules');
let chromium;
try { ({ chromium } = createRequire(join(modules, 'noop.js'))('playwright')); }
catch { console.error(`Playwright was not found in ${modules}; set PLAYWRIGHT_MODULES to a node_modules directory that has it.`); process.exit(1); }
const shell = join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const executablePath = process.env.CHROMIUM || (existsSync(shell) ? shell : undefined);
const only = new Set((process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean));
const wanted = (name) => !only.size || only.has(name);
const preview = async (body) => {
  const r = await fetch(new URL('/__preview', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`/__preview ${JSON.stringify(body)} → ${r.status} ${await r.text()}`);
  return r.json();
};
console.log(`showcase at ${base.href}, time zone ${zone ?? '(the browser\'s own)'}`);

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath });
const pages = [];
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce', timezoneId: zone });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error(`[${theme}] page error: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.error(`[${theme}] console: ${m.text().slice(0, 200)}`); });
  pages.push({ theme, page });
}
const both = (fn) => Promise.all(pages.map(({ page, theme }) => fn(page, theme)));
// Nothing hovered (a hover shows a message's time or a tooltip) and nothing focused.
const still = (page) => page.mouse.move(1439, 899).then(() => page.evaluate(() => document.activeElement?.blur?.()));
const settle = async (page, focus) => { if (focus) await page.mouse.move(1439, 899); else await still(page); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); };

/**
 * A box around elements, in page coordinates, with some room and clamped to the
 * window. A selector "@last:N" is the conversation's last N message rows.
 */
async function around(page, selectors, pad = 16, limit = {}) {
  const box = await page.evaluate(([list, pad, limit]) => {
    const pick = (sel) => {
      const last = /^@last:(\d+)$/.exec(sel);
      if (last) return [...document.querySelectorAll('#thread .thread-inner > .msg')].slice(-Number(last[1]));
      return [...document.querySelectorAll(sel)];
    };
    const nodes = list.flatMap(pick).filter(n => n.getBoundingClientRect().height);
    // A message row framed at the top brings its time divider along, whole.
    const top = nodes.slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (top && top.previousElementSibling?.classList.contains('tdiv')) nodes.push(top.previousElementSibling);
    const rects = nodes.map(n => n.getBoundingClientRect());
    if (!rects.length) return null;
    let x0 = Math.min(...rects.map(r => r.left)) - pad, y0 = Math.min(...rects.map(r => r.top)) - pad;
    let x1 = Math.max(...rects.map(r => r.right)) + pad, y1 = Math.max(...rects.map(r => r.bottom)) + pad;
    if (limit.x0 != null) x0 = Math.max(x0, limit.x0); if (limit.y0 != null) y0 = Math.max(y0, limit.y0);
    if (limit.x1 != null) x1 = Math.min(x1, limit.x1); if (limit.y1 != null) y1 = Math.min(y1, limit.y1);
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(innerWidth, Math.ceil(x1)); y1 = Math.min(innerHeight, Math.ceil(y1));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }, [selectors, pad, limit]);
  if (!box) throw new Error('nothing to frame: ' + selectors.join(', '));
  return box;
}
/** The drawer from its top to the end of what it shows (it is as tall as the window). */
const panel = (page) => page.evaluate(() => {
  const box = document.querySelector('#panel').getBoundingClientRect();
  let bottom = box.top;
  // What it shows: the innermost elements (the drawer and its scroll box are as tall as the window).
  for (const n of document.querySelectorAll('#panel *')) {
    if (n.children.length && ![...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())) continue;
    const r = n.getBoundingClientRect(), style = getComputedStyle(n);
    if (r.width && r.height && style.visibility !== 'hidden' && r.bottom <= box.bottom) bottom = Math.max(bottom, r.bottom);
  }
  return { x: Math.floor(box.left), y: Math.floor(box.top), width: Math.ceil(box.width), height: Math.ceil(Math.min(box.bottom, bottom + 24) - box.top) };
});
async function drawer(page, name, tab) {
  await open(page, name);
  await page.locator('#head-chip').click();
  await page.locator('#panel .tabs').getByText(tab, { exact: true }).click();
  await page.waitForTimeout(900);
}
// At 1440 wide the panel sits beside the chat (docs/xbot-frontend.md item 50), with no scrim to click away:
// the identity chip that opened it closes it again.
const closePanel = (page) => page.locator('#head-chip').click();
async function shoot(name, frame, { focus = false } = {}) {
  await both(async (page, theme) => {
    await settle(page, focus);
    const clip = typeof frame === 'function' ? await frame(page) : frame;
    await page.screenshot({ path: join(out, `${name}-${theme}.png`), clip });
  });
  console.log('  ' + name);
}
async function open(page, name) {
  await page.locator('#sidebar').getByText(name, { exact: true }).first().click();
  await page.waitForFunction(n => document.querySelector('#title .title-name')?.textContent === n && document.querySelector('#thread .thread-inner .msg'), name);
  await page.waitForTimeout(700);
}
const thread = (page, where) => page.locator('#thread').evaluate((t, where) => { t.scrollTop = where === 'top' ? 0 : t.scrollHeight; }, where);
// The thread's own column (the messages' width), as the app lays it out.
const column = (page) => page.evaluate(() => { const r = document.querySelector('#thread .thread-inner').getBoundingClientRect(); return { x0: r.left - 24, x1: r.right + 24 }; });

try {
  await both(async (page) => {
    await page.goto(new URL('/', base).href, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#roster .item') && document.querySelector('#thread .thread-inner .msg'));
    await page.waitForTimeout(800);
  });
  console.log('pictures from ' + base.href);

  // 联系人列表: the list as it is staged (unread counts, 等你确认, the pinned cat), before any chat is opened.
  if (wanted('list')) await shoot('list', async page => around(page, ['#pin-row', '#roster'], 12, { x0: 0, x1: 280, y0: (await page.locator('#pin-row').boundingBox()).y - 6 }));

  // 打开就能聊: 新建 (the round ＋ at the top of the sidebar) opens the dialog on its 猫猫 side: the cats at the left
  // (those that can come home and 自定义, then, set apart, smaller and over dashed cushions, those that cannot), a cat
  // whose Agent is here picked (梵花猫, Kimi) with its card at the right, a name typed; then, cropped to that card, a cat
  // whose Agent the app cannot connect (暹罗猫): its Agent mark saying 暂不支持, and the one way on, 自定义.
  if (wanted('new-cat')) {
    await both(async (page) => {
      await page.locator('#side-new').click();
      await page.waitForSelector('.qc-card .qc-face');
      await page.locator('.qc-card .qc-face[data-face="turkish-van"]').click();
      await page.locator('.qc-card').getByLabel('名字', { exact: true }).fill('年糕');
      await page.waitForTimeout(400);
    });
    await shoot('new-cat', page => around(page, ['.qc-card'], 0));
    await both(async (page) => { await page.locator('.qc-card .qc-face[data-face="siamese"]').click(); await page.waitForTimeout(400); });
    // Cropped above the name box (the card's own edge, without a sliver of the field under it).
    await shoot('new-cat-away', async page => around(page, ['.qc-card .qc-about'], 16, { y1: (await page.locator('.qc-card').getByLabel('名字', { exact: true }).boundingBox()).y - 4 }));
    await both(page => page.locator('.qc-card').getByRole('button', { name: '取消', exact: true }).click());
  }

  // 卡片、清单、差异: 砚砚's review, a card, a checklist and a code diff in the chat.
  if (wanted('cards')) {
    await both(async (page) => { await open(page, '砚砚'); await page.locator('#thread .msg:has(.ck-diff)').first().scrollIntoViewIfNeeded(); });
    await shoot('cards', async page => around(page, ['#thread .msg:has(.ck-diff)'], 14, await column(page)));
  }

  // 选项直接点: 烁烁's multiple choice with two picked, not yet sent.
  if (wanted('choices')) {
    await both(async (page) => {
      await open(page, '烁烁'); await thread(page, 'bottom');
      const block = page.locator('#thread .ask').last();
      await block.getByText('最近在读').click(); await block.getByText('摘抄墙').click();
    });
    await shoot('choices', async page => around(page, ['@last:2'], 20, await column(page)));
  }

  // 发资料，收文件: 墨墨, a file sent with a message and the files it handed back.
  if (wanted('files')) {
    await both(async (page) => { await open(page, '墨墨'); await thread(page, 'bottom'); });
    await shoot('files', async page => around(page, ['#thread .thread-inner > .msg'], 20, await column(page)));
    await both(page => drawer(page, '墨墨', '文件'));
    await shoot('files-tab', panel);
    await both(closePanel);
  }

  // 说一句就设提醒: 鲸鲸, a reminder come due (after its time divider) and the one still waiting.
  if (wanted('reminder')) {
    await both(async (page) => { await open(page, '鲸鲸'); await thread(page, 'bottom'); });
    await shoot('reminder', async page => around(page, ['#thread .tdiv:has(+ .ck-reminder)', '@last:1'], 20, { ...(await column(page)), y0: 64 }));
    await both(page => drawer(page, '鲸鲸', '定时'));
    await shoot('reminder-tab', panel);
    await both(closePanel);
  }

  // 要记住的事先问你: 小狸花's card, and what is kept under 资料 → 记忆.
  if (wanted('memory')) {
    await both(async (page) => { await open(page, '小狸花'); await thread(page, 'bottom'); });
    await shoot('memory', async page => around(page, ['@last:3'], 20, { ...(await column(page)), y0: 64 }));
    await both(async (page) => {
      await drawer(page, '小狸花', '记忆');
      await page.locator('#panel').getByText('你的偏好', { exact: true }).click();
      await page.waitForTimeout(700);
    });
    await shoot('memory-tab', panel);
    await both(closePanel);
  }

  // 没做完也如实说: 斑斑, a reply that did not finish, one interrupted, content that cannot be drawn yet.
  if (wanted('honest')) {
    await both(async (page) => { await open(page, '斑斑'); await thread(page, 'top'); });
    await shoot('honest', async page => around(page, ['#thread .thread-inner > .msg'], 20, await column(page)));
  }

  // 找得到: ⌘K, 纸页感.
  if (wanted('search')) {
    await both(async (page) => {
      await open(page, '金哥');
      await page.keyboard.press('Meta+k');
      await page.waitForSelector('.pal-card');
      await page.keyboard.type('纸页感');
      await page.waitForFunction(() => document.querySelectorAll('.pal-card [role="option"]').length > 2 && !/正在找/.test(document.querySelector('.pal-card')?.textContent || ''));
      await page.waitForTimeout(500);
    });
    await shoot('search', page => around(page, ['.pal-card'], 0));
    await both(page => page.locator('.pal-card input').press('Escape'));
  }

  // 群聊: 产品评审, three cats answering in their own colours, the member check, the @ list with 全体.
  if (wanted('group')) {
    await both(async (page) => {
      await open(page, '产品评审'); await thread(page, 'bottom');
    });
    await shoot('group', async page => around(page, ['#thread .msg:has(+ .ck-notice)', '@last:1'], 20, { ...(await column(page)), y0: 64 }));
    await both(async (page) => { await page.locator('#input').click(); await page.keyboard.type('@'); await page.waitForSelector('.composer [role="listbox"]:not([hidden]), [role="listbox"]:not([hidden])'); });
    // The list itself (it floats over the conversation, above the composer).
    await shoot('group-at', page => around(page, ['[role="listbox"]:not([hidden])'], 0), { focus: true });
    await both(async (page) => { await page.locator('#input').press('Escape'); await page.locator('#input').press('Backspace'); });
  }

  // 资料页: a cat's 资料, technical settings folded under 高级.
  if (wanted('profile')) {
    await both(page => drawer(page, '宪宪', '资料'));
    await shoot('profile', panel);
    await both(closePanel);
  }

  // 通知: 设置 → 通用, the desktop notification switch (我's menu opens from the owner's face at the bottom of the sidebar).
  if (wanted('notify')) {
    await both(async (page) => {
      await page.locator('#account').click();
      await page.locator('#account-settings').click();
      await page.waitForSelector('#setpage:not([hidden])');
      await page.locator('#setpage .setnav [data-set="general"]').click();
      await page.waitForTimeout(500);
    });
    // The dialog down to the end of its rows (it is taller than what 通用 holds).
    await shoot('notify', async page => {
      const box = await around(page, ['#setpage'], 0);
      const end = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#setpage .setmain .setrow')].filter(n => n.getBoundingClientRect().height).map(n => n.getBoundingClientRect().bottom)));
      return { ...box, height: Math.min(box.height, Math.ceil(end + 48 - box.y)) };
    });
    await both(page => page.locator('#settings-close').click());
  }

  // 回复是活的: 宪宪 plays its demo, slowed down; caught while it is writing (the stop button in the composer).
  if (wanted('live')) {
    await both(async (page) => { await open(page, '宪宪'); await thread(page, 'bottom'); });
    await preview({ speed: 2 });
    try {
      await preview({ play: '宪宪' });
      await both(page => page.waitForFunction(() => {
        const row = document.querySelector('#thread .msg.live');
        return row && /为什么是第二个/.test(row.textContent || '');
      }, null, { timeout: 60_000 }));
      await shoot('live', async page => around(page, ['@last:2', '.composer'], 16, { ...(await column(page)), y0: 64 }));
    } finally { await preview({ speed: 1 }); }
  }
} catch (error) {
  console.error('Stopped: ' + String(error.message).split('\n')[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
const files = readdirSync(out).filter(f => f.endsWith('.png'));
const total = files.reduce((n, f) => n + statSync(join(out, f)).size, 0);
console.log(`${files.length} pictures in showcase/shots, ${(total / 1024 / 1024).toFixed(2)} MB`);
