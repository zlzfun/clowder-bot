// Where an install keeps its runtime data. Shared by the launcher scripts
// (plain Node) and the Bot server.
//
// A cat works in a directory under this data root. Claude Code loads every
// CLAUDE.md above its working directory and Codex the AGENTS.md of the Git
// repository it is in, so data kept inside a code repository makes every cat
// read that repository's developer instructions on every turn. New installs
// therefore keep their data outside the checkout; an install that already has
// data in ./data keeps using it until it is moved deliberately.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * BOT_DATA_DIR, else ./data when this checkout already holds data, else
 * ~/.clowder-bot. A ./data that is a link (left behind by `npm run data:move`
 * for paths stored earlier) counts as the place it points to, so cats get
 * their real working directory, outside the checkout.
 */
export function dataRoot(root, env = process.env, home = homedir()) {
  if (env.BOT_DATA_DIR) return resolve(env.BOT_DATA_DIR);
  const legacy = join(root, 'data');
  return existsSync(join(legacy, 'native')) || existsSync(join(legacy, 'bot')) ? realpathSync(legacy) : join(home, '.clowder-bot');
}
/** The native runtime's data directory (BOT_RUNTIME_DATA_DIR still wins). */
export function nativeDataDir(root, env = process.env, home = homedir()) {
  return resolve(env.BOT_RUNTIME_DATA_DIR || join(dataRoot(root, env, home), 'native'));
}
/** The Bot's presentation file (BOT_PRODUCT_DATA_FILE still wins). */
export function productDataFile(root, env = process.env, home = homedir()) {
  return resolve(env.BOT_PRODUCT_DATA_FILE || join(dataRoot(root, env, home), 'bot', 'presentation.json'));
}
/**
 * The nearest directory at or above `dir` that is a Git checkout, or null.
 * Judged by where the directory really is: a link on the way (or `dir` itself
 * being one) may lead into a checkout, and that is where a cat's CLI would
 * find itself. `dir` need not exist yet; its nearest existing parent is
 * resolved and the rest of the path is taken as written.
 */
export function enclosingRepository(dir) {
  let existing = resolve(dir);
  const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  try { existing = realpathSync(existing); } catch { /* unreadable: judge the path as written */ }
  for (let current = join(existing, ...rest); ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return null;
  }
}
