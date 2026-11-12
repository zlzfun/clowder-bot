// `npm run app`: one command from a fresh checkout to the chat in the browser.
//
// It only runs what the README's steps already run, in order and when needed:
// the runtime build (scripts/prepare-upstream.mjs, first time only), the page
// build (vite), the engine (scripts/start-runtime.mjs) and the Bot
// (server/index.ts). It adds no behaviour of its own; decisions are in
// app-plan.mjs. An instance that is already running is only opened.
//
//   npm run app                 start everything, open the browser
//   npm run app -- --no-open    do not open the browser
//   npm run app -- --no-build   never build the page (use what is in dist/client)
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { frontendStale, launchPlan } from './app-plan.mjs';

const root = resolve(import.meta.dirname, '..');
const flags = new Set(process.argv.slice(2));
const say = text => console.log(text);
const fail = text => { console.error(`\n${text}`); process.exit(1); };

// --- what this machine needs before anything is started ---
const lockFile = resolve(root, process.env.BOT_UPSTREAM_LOCK_FILE || 'upstream.lock.json');
const nodeMajor = JSON.parse(readFileSync(lockFile, 'utf8')).nodeMajor;
if (Number(process.versions.node.split('.')[0]) !== nodeMajor) fail(`需要 Node.js ${nodeMajor}，现在是 ${process.version}。装好后再运行一次（macOS：brew install node@${nodeMajor}）。`);
if (!existsSync(join(root, 'node_modules/tsx'))) fail('还没有安装依赖。先运行：npm ci');
if (spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status !== 0) fail('没有找到 redis-server。macOS：brew install redis；Debian / Ubuntu：sudo apt install redis-server。装好后再运行一次。');
if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) fail('没有找到 git。装好后再运行一次。');

const ports = {
  bot: Number(process.env.PORT || 3210), native: Number(process.env.BOT_NATIVE_PORT || 4331),
  redis: Number(process.env.BOT_REDIS_PORT || 6392), metrics: Number(process.env.BOT_METRICS_PORT || 9492),
};
const url = `http://127.0.0.1:${ports.bot}`;
const logs = join(root, '.runtime/logs');
mkdirSync(logs, { recursive: true });

async function json(address) {
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
async function taken(port) {
  const probe = createServer();
  try { await new Promise((ok, no) => { probe.once('error', no); probe.listen(port, '127.0.0.1', ok); }); } catch { return true; }
  await new Promise(ok => probe.close(ok));
  return false;
}
/** Who answers on a port: this app, something else, or nobody. */
async function who(port, address, ours) {
  if (!await taken(port)) return 'free';
  const body = await json(address);
  return body && ours(body) ? 'ours' : 'other';
}
function newest(directory) {
  let latest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}
function open() {
  if (flags.has('--no-open')) return;
  const [exe, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(exe, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the address is printed anyway */ }
}
function tail(file, lines = 15) {
  try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

// --- decide ---
const { fingerprint, lock } = await import('./upstream-source.mjs');
const build = resolve(root, lock.build), marker = join(build, '.bot-build-complete');
const page = join(root, 'dist/client/index.html');
const builtAt = existsSync(page) ? statSync(page).mtimeMs : undefined;
const plan = launchPlan({
  bot: await who(ports.bot, `${url}/xbot-api/session`, body => body.engine === 'clowder-ai'),
  native: await who(ports.native, `http://127.0.0.1:${ports.native}/api/health`, body => String(body.deploymentSubjectRef ?? '').endsWith(':clowder-bot')),
  busy: (await Promise.all([ports.redis, ports.metrics].map(async port => await taken(port) ? port : 0))).filter(Boolean),
  ports,
  runtimeBuilt: existsSync(join(build, 'packages/api/dist/index.js')) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === fingerprint(),
  frontendBuilt: builtAt !== undefined,
  frontendStale: frontendStale([newest(join(root, 'client')), statSync(join(root, 'vite.config.ts')).mtimeMs], builtAt),
  build: !flags.has('--no-build'),
});
say('🐾 Clowder Bot');
if (plan.action === 'stop') fail(plan.reason);
if (plan.action === 'open') { say(`已经在运行：${url}`); open(); process.exit(0); }

// --- run ---
const children = [];
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  // The Bot first, then the engine, which closes its API before its Redis writes and exits.
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode) continue;
    const exited = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    await exited;
  }
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!stopping) say('\n正在停止（等数据写完）…'); void stop(0); });

/** Runs one step to its end, output in a log file, a dot every few seconds so a long step does not look stuck. */
async function step(label, log, exe, args) {
  process.stdout.write(label);
  const out = openSync(log, 'w'), child = spawn(exe, args, { cwd: root, stdio: ['ignore', out, out] });
  children.push(child);
  const dots = setInterval(() => process.stdout.write('.'), 5000);
  const [code] = await once(child, 'exit');
  clearInterval(dots); closeSync(out); children.splice(children.indexOf(child), 1);
  if (stopping) return;
  if (code !== 0) { say(' 没有成功'); console.error(tail(log)); fail(`完整记录在 ${log}`); }
  say(' 好了');
}
/** Starts a long-running service and waits until it answers; its output goes to a log file. */
async function service(label, log, exe, args, address, seconds) {
  process.stdout.write(label);
  const out = openSync(log, 'w'), child = spawn(exe, args, { cwd: root, stdio: ['ignore', out, out] });
  children.push(child);
  child.once('exit', code => {
    if (stopping) return;
    say(`\n${label.replace(/[…·\s]/g, '')}的进程退出了（${code ?? '被终止'}）。`); console.error(tail(log));
    console.error(`完整记录在 ${log}`); void stop(1);
  });
  for (let waited = 0; !stopping; waited++) {
    if (await json(address)) { say(' 好了'); return; }
    if (waited >= seconds) { say(' 没有等到'); console.error(tail(log)); console.error(`完整记录在 ${log}`); return stop(1); }
    if (waited % 5 === 4) process.stdout.write('.');
    await new Promise(ok => setTimeout(ok, 1000));
  }
}

if (plan.steps.includes('prepare')) {
  if (!existsSync(join(root, 'upstream/clowder-ai/package.json'))) await step('· 取回引擎源码…', join(logs, 'submodule.log'), 'git', ['submodule', 'update', '--init', '--recursive']);
  await step('· 第一次启动要准备运行环境，大约 5 分钟，只需一次…', join(logs, 'prepare.log'), process.execPath, [join(root, 'scripts/prepare-upstream.mjs')]);
}
if (plan.steps.includes('build')) await step('· 构建界面…', join(logs, 'build.log'), process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build']);
if (plan.steps.includes('native')) await service('· 启动运行环境…', join(logs, 'native.log'), process.execPath, [join(root, 'scripts/start-runtime.mjs')], `http://127.0.0.1:${ports.native}/api/health`, 240);
if (plan.steps.includes('bot')) await service('· 启动应用…', join(logs, 'bot.log'), process.execPath, ['--import', 'tsx', join(root, 'server/index.ts')], `${url}/xbot-api/session`, 60);
if (!stopping) {
  const start = await json(`${url}/xbot-api/start`);
  say(`\n✓ 好了：${url}    按 Ctrl+C 停止`);
  if (start && !start.ready) say(start.blocked === 'login_required' ? '  提示：本机的 Agent 还没有登录，页面里会告诉你怎么登录。' : '  提示：还没有检测到可用的本机 Agent（Claude Code 或 Codex），页面里会告诉你怎么装。');
  open();
}
