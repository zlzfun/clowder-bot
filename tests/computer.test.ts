import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { ApiError } from '../server/errors.js';
import { Computer, computerEntry, computerTool, noComputer, type ComputerDriver, type ComputerGrants, type ComputerServer } from '../server/native/computer.js';
import { liveEvent } from '../server/native/live.js';
import type { NativeCat } from '../server/native/types.js';

const cat = (id: string, name: string) => ({ id, name, displayName: name, roleDescription: '测试', configurationSource: 'native_tool', clientId: 'openai', defaultModel: '', mentionPatterns: [], color: { primary: '#888888', secondary: '#eeeeee' } }) as NativeCat;
const [a, b, c] = [cat('cat-a', '猫甲'), cat('cat-b', '猫乙'), cat('cat-c', '猫丙')];
const real: ComputerServer = { command: '/Tools/CuaDriver.app/Contents/MacOS/cua-driver', args: ['mcp'], env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' } };

class Driver implements ComputerDriver {
  supported = true; server: ComputerServer | undefined = real; grants: ComputerGrants = { state: 'granted' };
  /** What the grants read once the driver was started. */
  onceStarted?: ComputerGrants; did: string[] = [];
  async locate() { return this.server; }
  async permissions() { return this.grants; }
  async start() { this.did.push('start'); if (this.onceStarted) this.grants = this.onceStarted; }
  async stop() { this.did.push('stop'); }
  async quiet() { this.did.push('quiet'); }
}
function setup(cats = [a, b, c]) {
  const native = new NativeFixture(); native.cats = structuredClone(cats);
  const driver = new Driver(), computer = new Computer(native, driver, 0);
  const writes = () => native.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/api/capabilities')).map(call => `${call.method} ${call.path.split('?')[0]}${call.body?.scope ? ':' + call.body.scope : ''}${call.body?.command ? ' ' + call.body.command : ''}`);
  const on = () => native.cats.filter(known => !native.capabilities[0]?.blockedCats?.includes(known.id) && native.capabilities.length).map(known => known.id);
  return { native, driver, computer, writes, on };
}
const refused = async (work: Promise<unknown>, status: number, code?: string) => {
  await assert.rejects(work, (error: unknown) => error instanceof ApiError && error.status === status && (code === undefined || error.code === code));
};

test('a step names the computer by the registry entry, whichever Agent named the tool', () => {
  assert.equal(computerEntry, 'computer');
  assert.equal(computerTool('mcp__computer__click'), true);
  assert.equal(computerTool('mcp:computer/get_window_state'), true);
  for (const other of ['mcp__cat-cafe-collab__post_message', 'mcp:codex/list_mcp_resources', 'computer', 'mcp__computers__click', 'Read']) assert.equal(computerTool(other), false, other);
  const step = (toolName: string) => liveEvent({ threadId: 't', type: 'tool_use', catId: 'cat-a', messageId: 'm', toolName, toolInput: { pid: 12, window_id: 3, element_token: 's1:4' } }, 't');
  assert.deepEqual(step('mcp__computer__click'), { kind: 'step', messageId: 'm', catId: 'cat-a', tool: 'mcp__computer__click', area: 'computer' });
  assert.deepEqual(step('mcp:computer/type_text'), { kind: 'step', messageId: 'm', catId: 'cat-a', tool: 'mcp:computer/type_text', area: 'computer' });
  assert.deepEqual(step('Read'), { kind: 'step', messageId: 'm', catId: 'cat-a', tool: 'Read' });
});

test('what a cat\'s page is told: no driver for this system, driver not installed, installed and off', async () => {
  const { native, driver, computer } = setup();
  assert.deepEqual(await new Computer(native, noComputer).view(a), { supported: false, installed: false, on: false, permissions: 'unknown' });
  driver.server = undefined;
  assert.deepEqual(await computer.view(a), { supported: true, installed: false, on: false, permissions: 'unknown' });
  driver.server = real; driver.grants = { state: 'needed', missing: ['screen_recording'] };
  assert.deepEqual(await computer.view(a), { supported: true, installed: true, on: false, permissions: 'needed', missing: ['screen_recording'] });
  assert.equal(native.calls.some(call => call.method !== 'GET'), false, 'reading changes nothing');
});

test('turning it on registers the entry with no cat on for a moment, then switches this cat only', async () => {
  const { native, driver, computer, writes, on } = setup();
  assert.deepEqual(await computer.set(a, true), { supported: true, installed: true, on: true, permissions: 'granted' });
  assert.deepEqual(writes(), ['POST /api/capabilities/mcp/install /usr/bin/true', 'PATCH /api/capabilities:project',
    `POST /api/capabilities/mcp/install ${real.command}`, 'PATCH /api/capabilities:cat']);
  assert.deepEqual(native.capabilities[0], { id: 'computer', type: 'mcp', source: 'external', enabled: true,
    mcpServer: { transport: 'stdio', ...real }, blockedCats: ['cat-b', 'cat-c'] });
  assert.deepEqual(on(), ['cat-a']);
  assert.deepEqual(driver.did, ['quiet'], 'the driver was running and granted: not started, analytics switched off once');
  assert.equal((await computer.view(b)).on, false);
  // A second cat: one toggle, nothing registered again.
  native.calls.length = 0;
  assert.equal((await computer.set(b, true)).on, true);
  assert.deepEqual(writes(), ['PATCH /api/capabilities:cat']);
  assert.deepEqual(on(), ['cat-a', 'cat-b']);
  // Asking again for what already holds writes nothing.
  native.calls.length = 0;
  await computer.set(b, true);
  assert.deepEqual(writes(), []);
});

test('while a macOS grant is missing nothing is switched and the registry is not touched', async () => {
  const { native, driver, computer, writes } = setup();
  driver.grants = { state: 'unknown' }; driver.onceStarted = { state: 'needed', missing: ['accessibility', 'screen_recording'] };
  assert.deepEqual(await computer.set(a, true), { supported: true, installed: true, on: false, permissions: 'needed', missing: ['accessibility', 'screen_recording'] });
  assert.deepEqual(driver.did, ['start'], 'the driver was started so that it asks the owner itself');
  assert.deepEqual(writes(), []); assert.equal(native.capabilities.length, 0);
  // The owner granted both: the same request now goes through.
  driver.grants = { state: 'granted' };
  assert.equal((await computer.set(a, true)).on, true);
  assert.deepEqual(driver.did, ['start', 'quiet']);
});

test('what cannot be turned on says why, by code', async () => {
  const { native, driver, computer, writes } = setup();
  await refused(new Computer(native, noComputer).set(a, true), 422, 'computer_unsupported');
  driver.server = undefined;
  await refused(computer.set(a, true), 422, 'computer_absent');
  driver.server = real; driver.grants = { state: 'unknown' };
  await refused(computer.set(a, true), 503, 'computer_not_started');
  assert.deepEqual(writes(), []);
});

test('a registration that cannot be confirmed is taken out again; one that cannot be taken out says so', async () => {
  const { native, computer, writes } = setup();
  native.capabilityFailures.add('PATCH:project');
  await refused(computer.set(a, true), 502, 'computer_not_registered');
  assert.equal(native.capabilities.length, 0, 'withdrawn');
  assert.deepEqual(writes(), ['POST /api/capabilities/mcp/install /usr/bin/true', 'PATCH /api/capabilities:project', 'DELETE /api/capabilities/mcp/computer']);
  native.capabilityFailures.add('DELETE /api/capabilities/mcp/computer');
  await refused(computer.set(a, true), 502, 'computer_half_registered');
  // What is left is the placeholder, which offers no tools: no cat counts as on, and the next try starts over.
  assert.equal(native.capabilities[0]?.mcpServer.command, '/usr/bin/true');
  for (const known of [a, b, c]) assert.equal((await computer.view(known)).on, false);
  native.capabilityFailures.clear();
  assert.equal((await computer.set(a, true)).on, true);
  assert.deepEqual(native.capabilities[0]?.blockedCats, ['cat-b', 'cat-c']);
});

test('turning it off takes only this cat off; the last one off ends the driver\'s background process', async () => {
  const { native, driver, computer, on } = setup();
  await computer.set(a, true); await computer.set(b, true); driver.did.length = 0;
  assert.equal((await computer.set(a, false)).on, false);
  assert.deepEqual(on(), ['cat-b']); assert.deepEqual(driver.did, []);
  assert.equal((await computer.set(b, false)).on, false);
  assert.deepEqual(on(), []); assert.deepEqual(driver.did, ['stop']);
  assert.equal(native.capabilities.length, 1, 'the entry stays, blocked for every cat: a new cat then starts blocked by the engine itself');
  // Off also works where the driver is gone: a stale "on" must be removable.
  await computer.set(a, true); driver.server = undefined;
  assert.deepEqual(await computer.view(a), { supported: true, installed: false, on: true, permissions: 'unknown' });
  assert.equal((await computer.set(a, false)).on, false);
});

test('a driver that moved is pointed at again without changing who is on', async () => {
  const { native, driver, computer, on } = setup();
  await computer.set(a, true);
  driver.server = { ...real, command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' };
  native.calls.length = 0;
  assert.equal((await computer.set(b, true)).on, true);
  assert.equal(native.capabilities[0]?.mcpServer.command, '/Applications/CuaDriver.app/Contents/MacOS/cua-driver');
  assert.deepEqual(on(), ['cat-a', 'cat-b']);
});

test('two switches at once register once', async () => {
  const { native, computer, on } = setup();
  const [first, second] = await Promise.all([computer.set(a, true), computer.set(b, true)]);
  assert.equal(first.on && second.on, true);
  assert.equal(native.calls.filter(call => call.body?.command === '/usr/bin/true').length, 1);
  assert.deepEqual(on(), ['cat-a', 'cat-b']);
});

test('a new cat starts without the computer: by the engine while every cat is off, by this app once one is on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-computer-'));
  const native = new NativeFixture(); native.cats = structuredClone([a, b]);
  const driver = new Driver();
  const runtime = createApp({ native, dataFile: join(dir, 'presentation.json'), workspace: join(dir, 'workspace'), computer: driver });
  try {
    const { bridge } = runtime, patches = () => native.calls.filter(call => call.method === 'PATCH' && call.path === '/api/capabilities').length;
    // No entry at all: nothing to do, nothing said.
    const first = await bridge.createBot({ name: '新猫一' });
    assert.equal(bridge.creationNotice(first), undefined); assert.equal(patches(), 0);
    // One cat on: the engine would hand a new cat the computer, so it is taken off here.
    await bridge.computer.set(native.cats[0]!, true);
    const before = patches();
    const second = await bridge.createBot({ name: '新猫二' });
    assert.equal((await bridge.computer.view(second)).on, false);
    assert.equal(patches(), before + 1); assert.equal(bridge.creationNotice(second), undefined);
    // Every cat off: the engine blocks the new cat itself, this app writes nothing.
    await bridge.computer.set(native.cats[0]!, false);
    const idle = patches();
    const third = await bridge.createBot({ name: '新猫三' });
    assert.equal((await bridge.computer.view(third)).on, false); assert.equal(patches(), idle);
    // The toggle refuses: the cat exists, is on, and the owner is told once.
    await bridge.computer.set(native.cats[0]!, true);
    native.capabilityFailures.add('PATCH:cat');
    const fourth = await bridge.createBot({ name: '新猫四' });
    assert.equal((await bridge.computer.view(fourth)).on, true);
    assert.match(bridge.creationNotice(fourth) ?? '', /它现在可以用这台电脑/);
    assert.equal(bridge.creationNotice(fourth), undefined, 'said once');
    // The registry cannot be read at all: said as not confirmed, not as a fact.
    native.capabilityFailures.add('GET /api/capabilities');
    const fifth = await bridge.createBot({ name: '新猫五' });
    assert.match(bridge.creationNotice(fifth) ?? '', /没能确认/);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the routes: GET reads, PUT switches and answers with the view; a creation carries the notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-computer-'));
  const native = new NativeFixture(); native.cats = structuredClone([a, b]);
  const driver = new Driver();
  const runtime = createApp({ native, dataFile: join(dir, 'presentation.json'), workspace: join(dir, 'workspace'), computer: driver });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${address.port}/xbot-api${path}`, {
    method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  try {
    const page = `/bots/${encodeURIComponent('猫甲')}/computer`;
    assert.deepEqual(await (await call(page)).json(), { supported: true, installed: true, on: false, permissions: 'granted' });
    assert.deepEqual(await (await call(page, 'PUT', { enabled: true })).json(), { supported: true, installed: true, on: true, permissions: 'granted' });
    assert.equal((await call(page, 'PUT', { enabled: 'yes' })).status, 400);
    assert.equal((await call(page, 'PUT', { enabled: true, app: 'x' })).status, 400);
    assert.equal((await call(`/bots/${encodeURIComponent('没有这只')}/computer`)).status, 404);
    driver.server = undefined;
    const absent = await call(`/bots/${encodeURIComponent('猫乙')}/computer`, 'PUT', { enabled: true });
    assert.equal(absent.status, 422); assert.equal((await absent.json()).code, 'computer_absent');
    native.capabilityFailures.add('PATCH:cat');
    const made = await call('/bots', 'POST', { name: '新猫' });
    assert.equal(made.status, 201);
    assert.match((await made.json()).notice, /它现在可以用这台电脑/);
  } finally { server.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
