// Where an install keeps its runtime data. Shared by the launcher scripts
// (plain Node) and the Bot server.
//
// A cat works in a directory under this data root. Claude Code loads every
// CLAUDE.md above its working directory and Codex the AGENTS.md of the Git
// repository it is in, so data kept inside a code repository makes every cat
// read that repository's developer instructions on every turn. New installs
// therefore keep their data outside the checkout; an install that already has
// data in ./data keeps using it until it is moved deliberately.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** BOT_DATA_DIR, else ./data when this checkout already holds data, else ~/.clowder-bot. */
export function dataRoot(root, env = process.env, home = homedir()) {
  if (env.BOT_DATA_DIR) return resolve(env.BOT_DATA_DIR);
  const legacy = join(root, 'data');
  return existsSync(join(legacy, 'native')) || existsSync(join(legacy, 'bot')) ? legacy : join(home, '.clowder-bot');
}
/** The native runtime's data directory (BOT_RUNTIME_DATA_DIR still wins). */
export function nativeDataDir(root, env = process.env, home = homedir()) {
  return resolve(env.BOT_RUNTIME_DATA_DIR || join(dataRoot(root, env, home), 'native'));
}
/** The Bot's presentation file (BOT_PRODUCT_DATA_FILE still wins). */
export function productDataFile(root, env = process.env, home = homedir()) {
  return resolve(env.BOT_PRODUCT_DATA_FILE || join(dataRoot(root, env, home), 'bot', 'presentation.json'));
}
/** The nearest directory at or above `dir` that is a Git checkout, or null. */
export function enclosingRepository(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return null;
  }
}
