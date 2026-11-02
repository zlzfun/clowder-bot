import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const lock = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
export function fingerprint() {
  const hash = createHash('sha256').update(JSON.stringify(lock));
  for (const patch of lock.patches) hash.update(readFileSync(resolve(root, patch)));
  return hash.digest('hex');
}
