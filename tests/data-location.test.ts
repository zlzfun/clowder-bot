import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataRoot, enclosingRepository, nativeDataDir, productDataFile } from '../shared/data-location.mjs';

test('a new install keeps its data outside the checkout; one that already has data there keeps it', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bot-data-location-'))), root = join(dir, 'checkout'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(home);
  // Fresh clone: nothing under ./data.
  assert.equal(dataRoot(root, {}, home), join(home, '.clowder-bot'));
  assert.equal(nativeDataDir(root, {}, home), join(home, '.clowder-bot', 'native'));
  assert.equal(productDataFile(root, {}, home), join(home, '.clowder-bot', 'bot', 'presentation.json'));
  // An empty ./data (or one holding something else) is not an existing install.
  mkdirSync(join(root, 'data', 'logs'), { recursive: true });
  assert.equal(dataRoot(root, {}, home), join(home, '.clowder-bot'));
  // Existing data is never left behind by a changed default.
  mkdirSync(join(root, 'data', 'native'));
  assert.equal(dataRoot(root, {}, home), join(root, 'data'));
  assert.equal(nativeDataDir(root, {}, home), join(root, 'data', 'native'));
  assert.equal(productDataFile(root, {}, home), join(root, 'data', 'bot', 'presentation.json'));
  // After a move ./data is a link kept for paths stored earlier: the data root is where it points.
  const moved = join(dir, 'outside'); mkdirSync(join(moved, 'bot'), { recursive: true });
  const linked = join(dir, 'linked-checkout'); mkdirSync(linked); symlinkSync(moved, join(linked, 'data'), 'dir');
  assert.equal(dataRoot(linked, {}, home), moved);
  assert.equal(nativeDataDir(linked, {}, home), join(moved, 'native'));
  // Explicit settings win, the specific ones over the general one.
  const elsewhere = join(dir, 'elsewhere');
  assert.equal(dataRoot(root, { BOT_DATA_DIR: elsewhere }, home), elsewhere);
  assert.equal(nativeDataDir(root, { BOT_DATA_DIR: elsewhere }, home), join(elsewhere, 'native'));
  assert.equal(nativeDataDir(root, { BOT_DATA_DIR: elsewhere, BOT_RUNTIME_DATA_DIR: join(dir, 'n') }, home), join(dir, 'n'));
  assert.equal(productDataFile(root, { BOT_DATA_DIR: elsewhere, BOT_PRODUCT_DATA_FILE: join(dir, 'p.json') }, home), join(dir, 'p.json'));
});

test('data inside a Git checkout is recognised, whatever the depth, including a worktree’s .git file', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bot-data-repo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'), deep = join(repo, 'data', 'native', 'workspace', 'cats', 'bot-1');
  mkdirSync(deep, { recursive: true });
  assert.equal(enclosingRepository(deep), enclosingRepository(dir), 'not a repository of its own');
  mkdirSync(join(repo, '.git'));
  assert.equal(enclosingRepository(deep), repo);
  assert.equal(enclosingRepository(repo), repo);
  const worktree = join(dir, 'worktree'); mkdirSync(join(worktree, 'data'), { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
  assert.equal(enclosingRepository(join(worktree, 'data')), worktree);
  // Judged by where the directory really is: a link outside that leads into a checkout is inside it,
  // also for a directory that does not exist yet; a link inside a checkout that leads out is outside.
  const outside = join(dir, 'outside'); mkdirSync(outside);
  symlinkSync(join(repo, 'data'), join(outside, 'link'), 'dir');
  assert.equal(enclosingRepository(join(outside, 'link')), repo);
  assert.equal(enclosingRepository(join(outside, 'link', 'new-data', 'native')), repo);
  mkdirSync(join(outside, 'real')); symlinkSync(join(outside, 'real'), join(repo, 'moved'), 'dir');
  assert.equal(enclosingRepository(join(repo, 'moved', 'native')), enclosingRepository(dir));
});
