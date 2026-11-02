import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fingerprint } from './upstream-source.mjs';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
if (Number(process.versions.node.split('.')[0]) !== lock.nodeMajor) throw new Error(`Use Node ${lock.nodeMajor}. Current: ${process.version}`);
function command(exe, args, cwd = root, options = {}) {
  const result = spawnSync(exe, args, { cwd, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${exe} ${args.join(' ')} failed (${result.status})`);
  return result.stdout;
}
const source = resolve(root, lock.source);
const build = resolve(root, lock.build);
if (!build.startsWith(resolve(root, '.runtime') + '/')) throw new Error('Build must be inside .runtime/');
const git = (...args) => command('git', ['-C', source, ...args], root, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
if (git('rev-parse', 'HEAD') !== lock.commit) throw new Error('Submodule revision differs from upstream.lock.json; run git submodule update --init.');
if (git('status', '--porcelain')) throw new Error('Upstream checkout must remain pristine. Put reviewed changes in patches/.');
const digest = fingerprint();
const marker = resolve(build, '.bot-build-source');
const runtimeLock = resolve(process.env.BOT_RUNTIME_DATA_DIR || resolve(root, 'data/native'), 'runtime.lock');
for (const file of [runtimeLock, resolve(root, '.runtime/native-runtime.lock')]) {
  if (!existsSync(file)) continue;
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else if (e.code !== 'EPERM') throw e; }
  if (alive) throw new Error('Stop the native runtime before rebuilding. Its persistent data is preserved.');
}
if (!existsSync(marker) || !existsSync(resolve(build, '.git')) || readFileSync(marker, 'utf8').trim() !== digest) {
  const staging = `${build}.staging`;
  mkdirSync(resolve(root, '.runtime'), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  // An independent index/HEAD prevents native revision discovery from picking up
  // the parent Bot repository. Git objects are shared read-only with the submodule.
  // A partial/shallow submodule may not contain blobs from other branch tips.
  // Use its already-verified object database without asking upload-pack for those tips.
  command('git', ['init', '--quiet', staging]);
  const sourceGit = git('rev-parse', '--absolute-git-dir');
  writeFileSync(resolve(staging, '.git/objects/info/alternates'), resolve(sourceGit, 'objects') + '\n');
  if (existsSync(resolve(sourceGit, 'shallow'))) copyFileSync(resolve(sourceGit, 'shallow'), resolve(staging, '.git/shallow'));
  command('git', ['checkout', '--detach', lock.commit], staging);
  for (const patch of lock.patches) {
    command('git', ['apply', '--check', resolve(root, patch)], staging);
    command('git', ['apply', resolve(root, patch)], staging);
  }
  writeFileSync(resolve(staging, '.bot-build-source'), digest + '\n');
  // Only generated code/dependencies are replaced. Runtime data lives in data/.
  rmSync(build, { recursive: true, force: true });
  renameSync(staging, build);
}
if (!process.argv.includes('--source-only')) {
  rmSync(resolve(build, '.bot-build-complete'), { force: true });
  const pnpm = resolve(root, 'node_modules/.bin/pnpm');
  const version = command(pnpm, ['--version'], root, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  if (version !== lock.pnpm) throw new Error(`pnpm ${lock.pnpm} required, found ${version}`);
  command(pnpm, ['--filter', '@cat-cafe/api...', 'install', '--frozen-lockfile'], build);
  command(pnpm, ['--filter', '@cat-cafe/api...', 'build'], build);
  writeFileSync(resolve(build, '.bot-build-complete'), digest + '\n');
}
console.log(`Clowder AI ${lock.commit} prepared; ${lock.patches.length} external patches; source ${digest}.`);
