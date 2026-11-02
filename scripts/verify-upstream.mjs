import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { root, lock, fingerprint } from './upstream-source.mjs';

const source = resolve(root, lock.source), build = resolve(root, lock.build);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
assert.equal(git(source, 'rev-parse', 'HEAD'), lock.commit, 'Submodule SHA drift');
assert.equal(git(source, 'status', '--porcelain'), '', 'Do not edit upstream source');
assert.equal(git(build, 'rev-parse', 'HEAD'), lock.commit, 'Generated runtime SHA drift');
assert.equal(readFileSync(resolve(build, '.bot-build-source'), 'utf8').trim(), fingerprint(), 'Run runtime:prepare after changing the pin or patches');
assert.equal(readFileSync(resolve(build, '.bot-build-complete'), 'utf8').trim(), fingerprint(), 'Native build incomplete or stale');

const expected = mkdtempSync(resolve(tmpdir(), 'clowder-patch-check-'));
try {
  const paths = new Set(lock.patches.flatMap(patch => [...readFileSync(resolve(root, patch), 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1])));
  for (const path of paths) {
    assert.ok(!path.includes('..') && !path.startsWith('/'));
    mkdirSync(dirname(resolve(expected, path)), { recursive: true });
    if (existsSync(resolve(source, path))) writeFileSync(resolve(expected, path), readFileSync(resolve(source, path)));
  }
  for (const patch of lock.patches) git(expected, 'apply', resolve(root, patch));
  for (const path of paths) assert.deepEqual(readFileSync(resolve(build, path)), readFileSync(resolve(expected, path)), `Patch output drift: ${path}`);
  for (const path of git(build, 'diff', '--name-only').split('\n').filter(Boolean)) assert.ok(paths.has(path), `Unrecorded upstream edit: ${path}`);
  for (const path of git(build, 'ls-files', '--others', '--exclude-standard', 'packages/*/src').split('\n').filter(Boolean)) assert.ok(paths.has(path), `Unrecorded source addition: ${path}`);
  for (const path of ['server/orchestrator.ts', 'server/core/context.ts', 'server/core/routing.ts', 'server/providers/demo.ts', 'server/store.ts']) {
    assert.ok(!existsSync(resolve(root, path)), `Legacy engine returned: ${path}`);
  }
  console.log(`Clowder AI ${lock.commit}: pristine submodule; ${lock.patches.length} patch(es), ${paths.size} affected files; generated source and build match the lock.`);
} finally { rmSync(expected, { recursive: true, force: true }); }
