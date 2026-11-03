import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
// An explicit alternative lock supports isolated upgrade acceptance without changing a live build.
export const lock = JSON.parse(readFileSync(resolve(root, process.env.BOT_UPSTREAM_LOCK_FILE || 'upstream.lock.json'), 'utf8'));
export function fingerprint() {
  const hash = createHash('sha256').update(JSON.stringify(lock));
  for (const patch of lock.patches) hash.update(readFileSync(resolve(root, patch)));
  return hash.digest('hex');
}
