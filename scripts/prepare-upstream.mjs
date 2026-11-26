import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fingerprint, lock } from './upstream-source.mjs';
import { nativeDataDir } from '../shared/data-location.mjs';

const root = resolve(import.meta.dirname, '..');
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
const dataDir = nativeDataDir(root);
const runtimeLock = resolve(dataDir, 'runtime.lock');
// Native keeps the owner's taste memory in the Git worktree that has `main`
// checked out, which it finds from the build's own repository (pinned
// upstream TasteRepository.ts; no setting moves it). A build that is its own
// throwaway repository has no such worktree, so nothing could be remembered,
// and anything written into the build would be lost on the next rebuild. The
// repository therefore lives in the data directory and every build is a linked
// worktree of it, the layout upstream uses for its own runtime.
const home = resolve(dataDir, 'taste-home');
const sameDir = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
const ofHome = dir => {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  return result.status === 0 && sameDir(result.stdout.trim(), resolve(home, '.git'));
};
for (const file of [runtimeLock, resolve(build, '.bot-runtime.lock'), resolve(root, '.runtime/native-runtime.lock')]) {
  if (!existsSync(file)) continue;
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  // Legacy launchers owned .runtime/clowder-ai. Never rebuild that live path,
  // while allowing an independent candidate to use another build and data directory.
  if (file === resolve(root, '.runtime/native-runtime.lock') && resolve(owner.build || resolve(root, '.runtime/clowder-ai')) !== build) continue;
  // The runtime that holds this data directory may be running from another build directory. Every pin
  // builds into a directory of its own, so the next engine can be built while the current one keeps
  // serving, and the instance is down only for the moment it changes over. What is shared is the home
  // repository in the data directory, where this adds one more linked worktree and touches neither the
  // main worktree (the owner's taste memory) nor the running build. A lock that does not name its
  // build (older launchers) still refuses.
  if (file === runtimeLock && typeof owner.build === 'string' && resolve(owner.build) !== build && !sameDir(owner.build, build)) continue;
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else if (e.code !== 'EPERM') throw e; }
  if (alive) throw new Error('Stop the native runtime before rebuilding. Its persistent data is preserved.');
}
if (!existsSync(marker) || !existsSync(resolve(build, '.git')) || readFileSync(marker, 'utf8').trim() !== digest || !ofHome(build)) {
  const staging = `${build}.staging`;
  mkdirSync(resolve(root, '.runtime'), { recursive: true });
  const sourceGit = git('rev-parse', '--absolute-git-dir');
  const inHome = (...args) => command('git', ['-C', home, ...args]);
  if (!existsSync(resolve(home, '.git'))) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    command('git', ['init', '--quiet', '--initial-branch=main', home]);
    inHome('config', 'user.name', 'clowder-bot'); inHome('config', 'user.email', 'clowder-bot@localhost');
    inHome('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'Home of this install: the main worktree native taste memory lives in');
  }
  // The home's own index/HEAD keep native revision discovery away from the parent
  // Bot repository. Git objects are shared read-only with the submodule; a
  // partial/shallow submodule may not contain blobs from other branch tips, so
  // its already-verified object database is used without asking upload-pack.
  writeFileSync(resolve(home, '.git/objects/info/alternates'), resolve(sourceGit, 'objects') + '\n');
  if (existsSync(resolve(sourceGit, 'shallow'))) copyFileSync(resolve(sourceGit, 'shallow'), resolve(home, '.git/shallow'));
  mkdirSync(resolve(home, 'docs/taste/vignettes'), { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  inHome('worktree', 'prune');
  inHome('worktree', 'add', '--quiet', '--detach', staging, lock.commit);
  for (const patch of lock.patches) {
    command('git', ['apply', '--check', resolve(root, patch)], staging);
    command('git', ['apply', resolve(root, patch)], staging);
  }
  writeFileSync(resolve(staging, '.bot-build-source'), digest + '\n');
  // A build made before this layout was its own repository. Where its main branch was checked out native
  // could write taste entries into the build itself; whatever it holds there that the pinned source does not
  // ship moves to the home before the build is replaced. Nothing in the home is overwritten.
  if (existsSync(build) && !ofHome(build)) {
    const carry = (from, to, shipped) => {
      if (!existsSync(from) || lstatSync(from).isSymbolicLink()) return;
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const [mine, kept, theirs] = [from, to, shipped].map(dir => resolve(dir, entry.name));
        if (entry.isDirectory()) carry(mine, kept, theirs);
        else if (entry.isFile() && !existsSync(theirs) && !existsSync(kept)) {
          mkdirSync(to, { recursive: true }); copyFileSync(mine, kept);
          console.log(`Kept ${relative(build, mine)} from the previous build in ${home}`);
        }
      }
    };
    for (const dir of ['private/taste', 'docs/taste']) carry(resolve(build, dir), resolve(home, dir), resolve(source, dir));
  }
  // Only generated code/dependencies are replaced. Runtime data, the home
  // repository and what native wrote into its main worktree stay where they are.
  rmSync(build, { recursive: true, force: true });
  inHome('worktree', 'prune');
  inHome('worktree', 'move', staging, build);
}
{
  // Upstream keeps private taste entries under private/, which its own .gitignore leaves out of Git. The home
  // has none of upstream's files, so the same rule is set in the repository itself: a backup of the home
  // made with `git add .` must not commit them.
  const exclude = resolve(home, '.git/info/exclude');
  if (existsSync(resolve(home, '.git'))) {
    const rules = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!/^\/?private\/$/m.test(rules)) { mkdirSync(dirname(exclude), { recursive: true }); writeFileSync(exclude, rules + (rules && !rules.endsWith('\n') ? '\n' : '') + 'private/\n'); }
  }
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
