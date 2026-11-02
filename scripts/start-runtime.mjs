import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprint } from './upstream-source.mjs';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'upstream.lock.json'), 'utf8'));
if (Number(process.versions.node.split('.')[0]) !== lock.nodeMajor) throw new Error('Clowder AI requires Node 24.');
const binary = resolve(root, lock.build);
if (!existsSync(join(binary, 'packages/api/dist/index.js'))) throw new Error('Run npm run runtime:prepare first.');
if (!existsSync(join(binary, '.bot-build-complete')) || readFileSync(join(binary, '.bot-build-complete'), 'utf8').trim() !== fingerprint()) throw new Error('Native build is incomplete or stale. Run npm run runtime:prepare.');
const data = resolve(process.env.BOT_RUNTIME_DATA_DIR || join(root, 'data/native'));
const workspace = join(data, 'workspace');
const apiPort = Number(process.env.BOT_NATIVE_PORT || 4331);
const redisPort = Number(process.env.BOT_REDIS_PORT || 6392);
const metricsPort = Number(process.env.BOT_METRICS_PORT || 9492);
const botPort = Number(process.env.PORT || 3210);
for (const port of [apiPort, redisPort, botPort, metricsPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
if (new Set([apiPort, redisPort, botPort, metricsPort]).size !== 4) throw new Error('Service ports must be distinct');
mkdirSync(data, { recursive: true, mode: 0o700 });
const mutex = join(data, 'runtime.lock');
const buildMutex = join(root, '.runtime/native-runtime.lock');
const acquiredLocks = [];
for (const file of [mutex, buildMutex]) {
  if (!existsSync(file)) continue;
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else if (e.code !== 'EPERM') throw e; }
  if (alive) throw new Error(`Runtime already owned by PID ${owner.pid}; stop that instance first.`);
  unlinkSync(file);
}
try {
  for (const file of [mutex, buildMutex]) {
    writeFileSync(file, JSON.stringify({ pid: process.pid, apiPort, redisPort, data }), { flag: 'wx', mode: 0o600 });
    acquiredLocks.push(file);
  }
} catch (error) { for (const file of acquiredLocks) unlinkSync(file); throw error; }
const children = [];
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    // API releases its leases before Redis persists and exits. Never kill other processes.
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode) continue;
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      await exited;
    }
    for (const file of acquiredLocks) unlinkSync(file);
  })();
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop().then(() => process.exit(0)));
async function portFree(port) {
  const probe = createServer();
  await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', ok); });
  await new Promise(ok => probe.close(ok));
}
function child(exe, args, cwd, env) {
  const proc = spawn(exe, args, { cwd, env, stdio: 'inherit' });
  children.push(proc);
  proc.once('error', e => { console.error(e.message); void stop().then(() => process.exit(1)); });
  proc.once('exit', code => { if (!stopping) void stop().then(() => process.exit(code || 1)); });
  return proc;
}
try {
  await portFree(apiPort); await portFree(redisPort); await portFree(metricsPort);
  for (const dir of ['workspace/.cat-cafe', 'workspace/docs', 'redis', 'transcripts', 'media', 'uploads', 'stories', 'internal']) mkdirSync(join(data, dir), { recursive: true, mode: 0o700 });
  const saltFile = join(data, 'telemetry-salt');
  if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  const template = join(workspace, 'cat-template.json');
  // Keep the complete shipped template, including native review policy. It is a menu,
  // not the member roster; native bootstrap still creates an empty runtime catalog.
  if (!existsSync(template)) symlinkSync(join(binary, 'cat-template.json'), template);
  // Preserve native fallback data locations across rebuilds as well as explicit paths.
  for (const [name, target] of [['data', join(data, 'internal')], ['.cat-cafe', join(workspace, '.cat-cafe')]]) {
    const link = join(binary, name);
    if (existsSync(link)) {
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(target)) throw new Error(`Unexpected runtime storage path: ${link}`);
    } else symlinkSync(target, link, 'dir');
  }
  const env = { ...process.env };
  // Ambient coordinates from another Clowder process must never select its storage or callbacks.
  for (const key of Object.keys(env)) if (/^(CAT_CAFE_|CAT_TEMPLATE_|REDIS_|MEMORY_STORE$|EVIDENCE_DB$|WORLD_DB$|TASK_OUTCOME_DB$|API_SERVER_|FRONTEND_URL$|TRANSCRIPT_|UPLOAD_DIR$|CONNECTOR_MEDIA_DIR$|ANNOTATION_DATA_DIR$|ALLOWED_WORKSPACE_DIRS$|PREVIEW_GATEWAY_)/.test(key)) delete env[key];
  Object.assign(env, {
    API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: String(apiPort),
    PROMETHEUS_PORT: String(metricsPort), OTEL_EXPORTER_PROMETHEUS_HOST: '127.0.0.1',
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, CAT_CAFE_USER_ID: 'clowder-bot-owner',
    CAT_CAFE_SESSION_COOKIE_NAME: 'clowder_bot_native_session',
    CAT_CAFE_DEPLOYMENT_ID: 'clowder-bot', CAT_CAFE_RUNTIME_ROOT: binary,
    CAT_CAFE_CONFIG_ROOT: workspace, CAT_CAFE_GLOBAL_CONFIG_ROOT: workspace, CAT_CAFE_WORKSPACE_ROOT: workspace,
    CAT_CAFE_DATA_DIR: data, CAT_TEMPLATE_PATH: template, CAT_TEMPLATE_BASE_PATH: join(binary, 'cat-template.json'),
    CAT_CAFE_API_URL: `http://127.0.0.1:${apiPort}`, FRONTEND_URL: `http://127.0.0.1:${botPort}`,
    CAT_CAFE_ENFORCE_THREAD_PARTICIPANTS: '1',
    CAT_CAFE_BOT_BACKGROUND_DELEGATION: '1',
    CAT_CAFE_CLAUDE_CARRIER: 'agent_sdk',
    EVIDENCE_DB: join(data, 'evidence.sqlite'), WORLD_DB: join(data, 'world.sqlite'),
    TASK_OUTCOME_DB: join(data, 'task-outcome-episodes.sqlite'),
    TRANSCRIPT_DATA_DIR: join(data, 'transcripts'), TRANSCRIPT_DIR: join(data, 'meeting-transcripts'),
    UPLOAD_DIR: join(data, 'uploads'), CONNECTOR_MEDIA_DIR: join(data, 'media'), ANNOTATION_DATA_DIR: join(data, 'stories'),
    ALLOWED_WORKSPACE_DIRS: workspace, PREVIEW_GATEWAY_ENABLED: '0', DOCS_ROOT: join(workspace, 'docs'),
    TELEMETRY_HMAC_SALT: readFileSync(saltFile, 'utf8'),
  });
  // The native bootstrap creates its own MCP definitions. No discovery/import of HOME configs.
  if (!existsSync(join(workspace, '.cat-cafe/capabilities.json'))) {
    const bootstrap = `import { bootstrapCapabilities } from ${JSON.stringify(pathToFileURL(join(binary, 'packages/api/dist/config/capabilities/capability-orchestrator.js')).href)};
      await bootstrapCapabilities(${JSON.stringify(workspace)}, {
        claudeConfig: ${JSON.stringify(join(workspace, '.mcp.json'))},
        codexConfig: ${JSON.stringify(join(workspace, '.codex/config.toml'))},
        geminiConfig: ${JSON.stringify(join(workspace, '.gemini/settings.json'))},
        kimiConfig: ${JSON.stringify(join(workspace, '.kimi-code/mcp.json'))}
      }, {catCafeRepoRoot: ${JSON.stringify(binary)}});`;
    const init = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: binary, env, stdio: 'inherit' });
    const [code] = await once(init, 'exit');
    if (code) throw new Error('Native capability bootstrap failed');
  }
  child('redis-server', ['--bind', '127.0.0.1', '--port', String(redisPort), '--dir', join(data, 'redis'),
    '--appendonly', 'yes', '--appendfsync', 'everysec', '--protected-mode', 'yes'], data, env);
  // Wait for the Redis child we just launched, never adopt an existing instance.
  for (let attempt = 0; ; attempt++) {
    const ready = await new Promise(ok => {
      const socket = createConnection({ host: '127.0.0.1', port: redisPort });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); ok(true); });
      socket.once('error', () => { socket.destroy(); ok(false); });
      socket.once('timeout', () => { socket.destroy(); ok(false); });
    });
    if (ready) break;
    if (stopping || attempt >= 40) throw new Error('Dedicated Redis did not become ready');
    await new Promise(ok => setTimeout(ok, 100));
  }
  child(process.execPath, [join(binary, 'packages/api/dist/index.js')], binary, env);
  console.log(`Native Clowder AI: http://127.0.0.1:${apiPort}; dedicated Redis ${redisPort}; data ${data}`);
} catch (error) { console.error(error); await stop(); process.exitCode = 1; }
