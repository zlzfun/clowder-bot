import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const manifest = JSON.parse(readFileSync(new URL('../docs/xbot-frontend-manifest.json', import.meta.url), 'utf8'));
let identical = 0;
for (const file of manifest.files) {
  const actual = createHash('sha256').update(readFileSync(new URL('../' + file.target, import.meta.url))).digest('hex');
  assert.equal(actual, file.sha256, `${file.target} differs from the reviewed migration manifest`);
  if (file.unchanged) { assert.equal(actual, file.sourceSha256); identical++; }
  if (/\.css$|\.woff2$|vendor\/xbot-avatar\.min\.js$/.test(file.file)) {
    assert.equal(actual, file.sourceSha256, `${file.target} must match the upstream visual asset byte-for-byte`);
  }
}
for (const file of manifest.extensions ?? []) {
  const actual = createHash('sha256').update(readFileSync(new URL('../' + file.target, import.meta.url))).digest('hex');
  assert.equal(actual, file.sha256, `${file.target} differs from the reviewed Clowder extension manifest`);
}
console.log(`${manifest.files.length} upstream files verified; ${identical} byte-identical to XBot ${manifest.commit}. Original CSS, fonts and avatar library preserved; ${manifest.extensions?.length ?? 0} Clowder extensions verified.`);
