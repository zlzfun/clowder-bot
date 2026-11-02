import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';

assert.ok(existsSync('dist/client/index.html'), 'Run npm run build first.');
const dir = mkdtempSync(join(tmpdir(), 'clowder-production-'));
const runtime = createApp({ dataFile: join(dir, 'state.json') });
const server = runtime.app.listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = await response.text();
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/[^\"]+)"/g)].map(match => match[1]))];
  assert.ok(assets.includes('/app.js') && assets.includes('/tokens.css'), 'Original XBot scripts and styles must be present.');
  assert.ok(assets.includes('/cat-avatars.js') && assets.includes('/cafe-theme.css'), 'Cat portraits and café theme must be loaded.');
  assert.ok(assets.includes('/agents.js') && assets.includes('/agents.css'), 'Local Agent access must be loaded.');
  assert.ok(assets.includes('/chat-presentation.js') && assets.includes('/chat-presentation.css'), 'Message presentation must be loaded.');
  for (const asset of assets) {
    const result = await fetch(base + asset);
    assert.equal(result.status, 200, asset);
    if (asset.endsWith('.html')) assert.match(result.headers.get('content-type'), /text\/html/, asset);
    else assert.doesNotMatch(result.headers.get('content-type'), /text\/html/, asset);
    await result.arrayBuffer();
  }
  const portraits = await fetch(base + '/avatars/clay-cats.png');
  assert.equal(portraits.status, 200, 'Production cat portrait sheet must be served.');
  assert.match(portraits.headers.get('content-type'), /image\/png/);
  assert.equal(Buffer.from(await portraits.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal((await (await fetch(base + '/api/health')).json()).ok, true);
  assert.equal((await fetch(base + '/api/missing')).status, 410);
  const session = await (await fetch(base + '/xbot-api/session')).json();
  assert.equal(session.authed, true);
  assert.equal((await fetch(base + '/runtime.html')).status, 200);
  console.log('Production smoke passed: Bot assets, runtime panel and the real Clowder AI API bridge.');
} finally {
  await runtime.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
