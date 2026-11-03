import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { root, lock } from './upstream-source.mjs';

const api = resolve(root, process.env.BOT_TASK_TEST_RUNTIME || lock.build, 'packages/api');
const requireNative = createRequire(resolve(api, 'package.json'));
const mcpUrl = path => pathToFileURL(requireNative.resolve(`@modelcontextprotocol/sdk/${path}`)).href;
const { Client } = await import(mcpUrl('client/index.js'));
const { InMemoryTransport } = await import(mcpUrl('inMemory.js'));
const { hostNativeMcp, nativeMcpTimeout, carriesNativeMcpAuthority } = await import(pathToFileURL(resolve(api, 'dist/domains/cats/services/agents/providers/claude-sdk-native-mcp.js')).href);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('credential-bearing aliases stay in the native host, with explicit long tool budgets', async () => {
  assert.equal(carriesNativeMcpAuthority('ordinary-plugin', { env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture' } }), true);
  assert.equal(carriesNativeMcpAuthority('alias', { headers: { 'x-callback-token': 'fixture' } }), true);
  assert.equal(carriesNativeMcpAuthority('public-search', { env: { PUBLIC_KEY: 'fixture' } }), false);
  assert.equal(nativeMcpTimeout({}, {}), 100_000_000);
  assert.equal(nativeMcpTimeout({}, { MCP_TOOL_TIMEOUT: '120000' }), 120_000);
  assert.equal(nativeMcpTimeout({ timeout: 300_000 }, { MCP_TOOL_TIMEOUT: '120000' }), 300_000);
  assert.equal(nativeMcpTimeout({ timeout: -1 }, {}), 100_000_000);
  const hosted = hostNativeMcp({ 'cat-cafe': { command: process.execPath, timeout: 120_000 }, external: { command: 'unused' } });
  assert.equal(hosted.sdk['cat-cafe'].timeout, 120_000);
  assert.deepEqual(Object.keys(hosted.external), ['external']);
  await hosted.close();
});

test('real stdio bridge forwards progress and cancellation, then remains usable', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'clowder-mcp-bridge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = resolve(directory, 'fixture.mjs'), cancelled = resolve(directory, 'cancelled');
  await writeFile(fixture, `
import { Server } from ${JSON.stringify(mcpUrl('server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(mcpUrl('server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(mcpUrl('types.js'))};
import { writeFile } from 'node:fs/promises';
const server = new Server({name:'fixture',version:'1.0.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools:[{name:'probe',inputSchema:{type:'object'}}] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.arguments?.wait) {
    await new Promise(resolve => {
      extra.signal.addEventListener('abort', async () => { await writeFile(${JSON.stringify(cancelled)}, 'aborted'); resolve(); }, {once:true});
      void extra.sendNotification({method:'notifications/progress',params:{progressToken:request.params._meta.progressToken,progress:1,total:2,message:'native progress'}});
    });
  }
  return {content:[{type:'text',text:'native result'}]};
});
await server.connect(new StdioServerTransport());
`);
  const hosted = hostNativeMcp({ 'cat-cafe': { command: process.execPath, args: [fixture], timeout: 120_000 } });
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const [up, down] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await hosted.close(); await hosted.sdk['cat-cafe'].instance.close(); });
  await hosted.sdk['cat-cafe'].instance.connect(down);
  await client.connect(up);
  assert.equal((await client.listTools()).tools[0].name, 'probe');
  const controller = new AbortController();
  let progress;
  const waiting = client.callTool({ name: 'probe', arguments: { wait: true } }, undefined, {
    signal: controller.signal, timeout: 5000,
    onprogress: value => { progress = value; controller.abort(new Error('test interruption')); },
  });
  await assert.rejects(waiting, /test interruption/);
  assert.equal(progress.message, 'native progress');
  for (let i = 0; i < 100; i++) {
    if (await readFile(cancelled, 'utf8').catch(() => '') === 'aborted') break;
    await delay(20);
  }
  assert.equal(await readFile(cancelled, 'utf8'), 'aborted');
  const result = await client.callTool({ name: 'probe', arguments: {} });
  assert.equal(result.content[0].text, 'native result');
});

test('a failed native MCP connection can reconnect on the next explicit request', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'clowder-mcp-reconnect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = resolve(directory, 'fixture.mjs');
  const hosted = hostNativeMcp({ 'cat-cafe': { command: process.execPath, args: [fixture] } });
  const client = new Client({ name: 'reconnect-test', version: '1.0.0' });
  const [up, down] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await hosted.close(); await hosted.sdk['cat-cafe'].instance.close(); });
  await hosted.sdk['cat-cafe'].instance.connect(down); await client.connect(up);
  await assert.rejects(client.listTools());
  await writeFile(fixture, `
import { Server } from ${JSON.stringify(mcpUrl('server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(mcpUrl('server/stdio.js'))};
import { ListToolsRequestSchema } from ${JSON.stringify(mcpUrl('types.js'))};
const server = new Server({name:'fixture',version:'1.0.0'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'recovered',inputSchema:{type:'object'}}]}));
await server.connect(new StdioServerTransport());
`);
  assert.equal((await client.listTools()).tools[0].name, 'recovered');
});
