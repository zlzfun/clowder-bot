import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { NativeFixture } from './native-fixture.js';
import { ApiError } from '../server/errors.js';
import { Computer, computerEntry, computerTool, cuaDriver, driverRequirement, noComputer, type ComputerDriver, type ComputerGrants, type ComputerServer } from '../server/native/computer.js';
import { liveEvent } from '../server/native/live.js';
import type { NativeCat } from '../server/native/types.js';

const cat = (id: string, name: string) => ({ id, name, displayName: name, roleDescription: '测试', configurationSource: 'native_tool', clientId: 'openai', defaultModel: '', mentionPatterns: [], color: { primary: '#888888', secondary: '#eeeeee' } }) as NativeCat;
const [a, b, c] = [cat('cat-a', '猫甲'), cat('cat-b', '猫乙'), cat('cat-c', '猫丙')];
const real: ComputerServer = { command: '/Tools/CuaDriver.app/Contents/MacOS/cua-driver', args: ['mcp'], env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' } };

class Driver implements ComputerDriver {
  supported = true; server: ComputerServer | undefined = real; grants: ComputerGrants = { state: 'granted' };
  /** What the grants read once the driver was started. */
  onceStarted?: ComputerGrants; did: string[] = []; freshLooks = 0;
  async locate(fresh?: boolean) { if (fresh) this.freshLooks++; return this.server; }
  async permissions() { return this.grants; }
  async start() { this.did.push('start'); if (this.onceStarted) this.grants = this.onceStarted; }
  async stop() { this.did.push('stop'); }
  async quiet() { this.did.push('quiet'); }
}
function setup(cats = [a, b, c]) {
  const native = new NativeFixture(); native.cats = structuredClone(cats);
  const driver = new Driver(), ended: string[] = [], stopping = { failed: 0 };
  const computer = new Computer(native, driver, async known => { ended.push(known.id); return { stopped: stopping.failed ? 0 : 1, failed: stopping.failed }; }, 0);
  const writes = () => native.calls.filter(call => call.method !== 'GET' && call.path.startsWith('/api/capabilities')).map(call => `${call.method} ${call.path.split('?')[0]}${call.body?.scope ? ':' + call.body.scope : ''}${call.body?.command ? ' ' + call.body.command : ''}${call.body?.scope === 'cat' ? `=${call.body.catId}:${call.body.enabled}` : ''}`);
  const on = () => native.capabilities.length && native.capabilities[0]!.mcpServer.command !== '/usr/bin/true' ? native.cats.filter(known => !native.capabilities[0]!.blockedCats?.includes(known.id)).map(known => known.id) : [];
  return { native, driver, computer, writes, on, ended, stopping };
}
const refused = async (work: Promise<unknown>, status: number, code?: string) => {
  await assert.rejects(work, (error: unknown) => error instanceof ApiError && error.status === status && (code === undefined || error.code === code));
};
const settle = () => new Promise(done => setTimeout(done, 5));
function app(cats = [a, b]) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-computer-'));
  const native = new NativeFixture(); native.cats = structuredClone(cats);
  const driver = new Driver();
  const runtime = createApp({ native, dataFile: join(dir, 'presentation.json'), workspace: join(dir, 'workspace'), computer: driver });
  const patches = () => native.calls.filter(call => call.method === 'PATCH' && call.path === '/api/capabilities').map(call => `${call.body.scope}=${call.body.catId ?? ''}:${call.body.enabled}`);
  return { dir, native, driver, runtime, bridge: runtime.bridge, patches, end: async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}

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
  // After every registry write, which cats could use the tools right then: none until the last step.
  const usable: string[][] = [], request = native.request.bind(native);
  native.request = (async (path: string, options: any = {}) => { const result = await request(path, options); if ((options.method ?? 'GET') !== 'GET') usable.push(on()); return result; }) as typeof native.request;
  assert.deepEqual(await computer.set(a, true), { supported: true, installed: true, on: true, permissions: 'granted' });
  assert.deepEqual(writes(), ['POST /api/capabilities/mcp/install /usr/bin/true', 'PATCH /api/capabilities:project',
    `POST /api/capabilities/mcp/install ${real.command}`, 'PATCH /api/capabilities:cat=cat-a:true']);
  assert.deepEqual(usable, [[], [], [], ['cat-a']]);
  assert.deepEqual(native.capabilities[0], { id: 'computer', type: 'mcp', source: 'external', enabled: true,
    mcpServer: { transport: 'stdio', ...real }, blockedCats: ['cat-b', 'cat-c'] });
  assert.equal(driver.freshLooks, 1, 'the driver\'s identity was checked anew before the registry was pointed at it');
  assert.deepEqual(driver.did, ['quiet'], 'the driver was running and granted: not started, analytics switched off once');
  assert.equal((await computer.view(b)).on, false);
  // A second cat: one toggle, nothing registered again.
  native.calls.length = 0;
  assert.equal((await computer.set(b, true)).on, true);
  assert.deepEqual(writes(), ['PATCH /api/capabilities:cat=cat-b:true']);
  assert.deepEqual(on(), ['cat-a', 'cat-b']);
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
  assert.match(native.calls.at(-1)!.path, /\?hard=true$/, 'removed, not just disabled');
  native.capabilityFailures.add('DELETE /api/capabilities/mcp/computer');
  await refused(computer.set(a, true), 502, 'computer_half_registered');
  // What is left is the placeholder, which offers no tools: no cat counts as on, and the next try starts over.
  assert.equal(native.capabilities[0]?.mcpServer.command, '/usr/bin/true');
  for (const known of [a, b, c]) assert.equal((await computer.view(known)).on, false);
  native.capabilityFailures.clear();
  assert.equal((await computer.set(a, true)).on, true);
  assert.deepEqual(native.capabilities[0]?.blockedCats, ['cat-b', 'cat-c']);
  // The block-all whose answer was lost: it did happen; what is read back decides, and the registration goes on.
  const again = setup();
  again.native.lostAnswers.add('PATCH:project');
  await refused(again.computer.set(a, true), 502, 'computer_not_registered');
  assert.equal(again.native.capabilities.length, 0);
});

test('an "on" that timed out here and is still waiting in the engine does not outlive a later "off"', async () => {
  const { native, computer, on } = setup();
  await computer.set(b, true);
  // The engine is slow: A's switch-on is taken in, but this app's request gives up first.
  let release!: () => void;
  native.capabilityHold = { key: 'PATCH:cat', release: new Promise<void>(done => { release = done; }) };
  await refused(computer.set(a, true), 503);
  assert.deepEqual(on(), ['cat-b'], 'not applied yet');
  // The owner turns A off. It reads as off already, and the block is written all the same, behind the waiting write.
  const off = computer.set(a, false);
  await settle();
  release();
  assert.equal((await off).on, false);
  await settle();
  assert.deepEqual(on(), ['cat-b'], 'the waiting "on" was applied first and the "off" after it stands');
  assert.deepEqual(native.capabilities[0]?.blockedCats?.includes('cat-a'), true);
});

test('turning it off takes only this cat off, ends the turns it is in the middle of, and with the last one ends the driver\'s process', async () => {
  const { native, driver, computer, on, ended, stopping } = setup();
  await computer.set(a, true); await computer.set(b, true); driver.did.length = 0;
  assert.equal((await computer.set(a, false)).on, false);
  assert.deepEqual(on(), ['cat-b']); assert.deepEqual(driver.did, []); assert.deepEqual(ended, ['cat-a'], 'a running turn keeps the tools it started with, so it is ended');
  assert.equal((await computer.set(b, false)).on, false);
  assert.deepEqual(on(), []); assert.deepEqual(driver.did, ['stop']); assert.deepEqual(ended, ['cat-a', 'cat-b']);
  assert.equal(native.capabilities.length, 1, 'the entry stays, blocked for every cat: a new cat then starts blocked by the engine itself');
  // A cat that reads as off is treated the same: an earlier "off" may have blocked it and failed before its turn was ended.
  await computer.set(c, false);
  assert.deepEqual(ended, ['cat-a', 'cat-b', 'cat-c']);
  // A turn not seen to have ended is said: the switch is off, the running turn still has the computer.
  await computer.set(a, true); stopping.failed = 1;
  await refused(computer.set(a, false), 502, 'computer_still_running');
  assert.equal((await computer.view(a)).on, false);
  // Asking again does not take the registry's word for it: the turn is ended this time.
  stopping.failed = 0; ended.length = 0;
  assert.equal((await computer.set(a, false)).on, false);
  assert.deepEqual(ended, ['cat-a']);
  // The block was written and its answer lost: the request fails, and the running turn was ended all the same.
  await computer.set(a, true); ended.length = 0; native.lostAnswers.add('PATCH:cat');
  await refused(computer.set(a, false), 503);
  assert.deepEqual(ended, ['cat-a']); native.lostAnswers.clear();
  assert.equal((await computer.view(a)).on, false);
  // No entry at all: nobody was ever handed the tools, nothing is ended.
  const bare = setup();
  await bare.computer.set(a, false);
  assert.deepEqual(bare.ended, []);
  // Off also works where the driver is gone: a stale "on" must be removable.
  stopping.failed = 0; await computer.set(a, true); driver.server = undefined;
  assert.deepEqual(await computer.view(a), { supported: true, installed: false, on: true, permissions: 'unknown' });
  assert.equal((await computer.set(a, false)).on, false);
});

test('a driver that moved is pointed at again without changing who is on', async () => {
  const { native, driver, computer, on } = setup();
  await computer.set(a, true);
  driver.server = { ...real, command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' };
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

test('a new cat is blocked before it exists whenever the entry is there, also while every cat is off', async () => {
  const { native, bridge, patches, end } = app();
  try {
    // No entry at all: nothing to do, nothing said.
    const first = await bridge.createBot({ name: '新猫一' });
    assert.equal(bridge.creationNotice(first), undefined); assert.deepEqual(patches(), []);
    // One cat on: the new cat's id goes on the block list first, and only then is the cat made.
    await bridge.computer.set(native.cats[0]!, true);
    native.calls.length = 0;
    const second = await bridge.createBot({ name: '新猫二' });
    const order = native.calls.filter(call => call.method !== 'GET' && (call.path === '/api/capabilities' || call.path === '/api/cats')).map(call => `${call.method} ${call.path}`);
    assert.deepEqual(order, ['PATCH /api/capabilities', 'POST /api/cats']);
    assert.deepEqual(patches(), [`cat=${second.id}:false`]);
    assert.equal((await bridge.computer.view(second)).on, false); assert.equal(bridge.creationNotice(second), undefined);
    // Every cat off: the engine would block the new cat itself, and it is blocked first all the same (see the late creation below).
    await bridge.computer.set(native.cats[0]!, false);
    native.calls.length = 0;
    const third = await bridge.createBot({ name: '新猫三' });
    assert.equal((await bridge.computer.view(third)).on, false); assert.deepEqual(patches(), [`cat=${third.id}:false`]);
  } finally { await end(); }
});

test('the block cannot be confirmed: no cat is made', async () => {
  const { native, bridge, end } = app();
  try {
    await bridge.computer.set(native.cats[0]!, true);
    for (const failure of ['PATCH:cat', 'GET /api/capabilities']) {
      native.capabilityFailures.clear(); native.capabilityFailures.add(failure); native.calls.length = 0;
      await refused(bridge.createBot({ name: '不该有的猫' }), 503, 'computer_unconfirmed');
      assert.equal(native.calls.some(call => call.path === '/api/cats' && call.method === 'POST'), false, failure);
      assert.equal(native.cats.some(known => known.name === '不该有的猫'), false);
    }
  } finally { await end(); }
});

test('a creation whose answer is lost, or whose later step fails, still leaves the cat without the computer', async () => {
  const { native, bridge, runtime, end } = app();
  try {
    await bridge.computer.set(native.cats[0]!, true);
    // The engine made the cat; this app never got the answer.
    native.lostAnswers.add('POST /api/cats');
    await refused(bridge.createBot({ name: '失联猫' }), 503);
    native.lostAnswers.clear();
    const lost = native.cats.find(known => known.name === '失联猫')!;
    assert.ok(lost, 'it exists in the engine');
    assert.equal((await bridge.computer.view(lost)).on, false, 'and it was blocked before it existed');
    // The engine made the cat; saving this app's own presentation data then failed.
    const save = runtime.store.save.bind(runtime.store);
    runtime.store.save = () => { throw new Error('ENOSPC'); };
    await assert.rejects(bridge.createBot({ name: '存盘失败猫' }));
    runtime.store.save = save;
    const unsaved = native.cats.find(known => known.name === '存盘失败猫')!;
    assert.equal((await bridge.computer.view(unsaved)).on, false);
  } finally { await end(); }
});

test('a creation that reaches the engine late does not start with the computer, whatever was switched meanwhile', async () => {
  // The entry exists and every cat is off: the creation's request times out here, the owner switches a cat on, then the engine makes the cat.
  const { native, bridge, end } = app();
  try {
    await bridge.computer.set(native.cats[0]!, true); await bridge.computer.set(native.cats[0]!, false);
    let release!: () => void;
    native.catHold = { release: new Promise<void>(done => { release = done; }) };
    await refused(bridge.createBot({ name: '迟到猫' }), 503);
    await bridge.computer.set(native.cats[0]!, true);
    release(); await settle();
    const late = native.cats.find(known => known.name === '迟到猫')!;
    assert.ok(late); assert.equal((await bridge.computer.view(late)).on, false);
  } finally { await end(); }
  // No entry yet: the same late creation, and the entry is registered for the first time meanwhile.
  const fresh = app();
  try {
    let release!: () => void;
    fresh.native.catHold = { release: new Promise<void>(done => { release = done; }) };
    await refused(fresh.bridge.createBot({ name: '迟到猫' }), 503);
    assert.equal((await fresh.bridge.computer.set(fresh.native.cats[0]!, true)).on, true);
    release(); await settle();
    const late = fresh.native.cats.find(known => known.name === '迟到猫')!;
    assert.ok(late); assert.equal((await fresh.bridge.computer.view(late)).on, false);
    assert.equal((await fresh.bridge.computer.view(fresh.native.cats[1]!)).on, false);
  } finally { await fresh.end(); }
  // A placeholder left by a registration that broke off: the new cat's id is blocked on it, the creation is late, and the
  // registration that follows writes the block list anew — the id that is no cat yet must still be on it.
  const leftover = app();
  try {
    leftover.native.capabilities.push({ id: 'computer', type: 'mcp', source: 'external', enabled: true, mcpServer: { transport: 'stdio', command: '/usr/bin/true', args: [] } });
    let release!: () => void;
    leftover.native.catHold = { release: new Promise<void>(done => { release = done; }) };
    await refused(leftover.bridge.createBot({ name: '迟到猫' }), 503);
    assert.equal(leftover.native.capabilities[0]!.blockedCats?.length, 1, 'blocked before it exists');
    assert.equal((await leftover.bridge.computer.set(leftover.native.cats[0]!, true)).on, true);
    release(); await settle();
    const late = leftover.native.cats.find(known => known.name === '迟到猫')!;
    assert.ok(late); assert.equal((await leftover.bridge.computer.view(late)).on, false);
  } finally { await leftover.end(); }
});

test('whether the cat already exists is asked inside the lock, after the switches before it', async () => {
  const { native, computer } = setup();
  await computer.set(a, true);
  // A switch is under way; the creation request queues behind it. By the time its turn comes the cat exists and the owner has it on.
  const made = cat('cat-new', '新来的');
  const switching = computer.set(b, true).then(() => { native.cats.push(structuredClone(made)); });
  native.calls.length = 0;
  const guarded = computer.guard('cat-new', async () => native.cats.some(known => known.id === 'cat-new'), async () => ({ cat: made }));
  await switching;
  assert.deepEqual(await guarded, { made: { cat: made } });
  assert.equal(native.calls.some(call => call.method === 'PATCH' && call.body?.catId === 'cat-new'), false, 'an existing cat is not touched');
  assert.equal((await computer.view(made)).on, true);
});

test('a repeated creation request leaves the cat as the owner has it now', async () => {
  const first = app();
  const key = randomUUID();
  try {
    await first.bridge.computer.set(first.native.cats[0]!, true);
    const made = await first.bridge.createBot({ name: '团子', simple: { face: 'maine-coon' }, idempotencyKey: key });
    assert.equal((await first.bridge.computer.view(made)).on, false);
    // The owner turns it on; later the same request arrives again at a Bot that was restarted (nothing remembered).
    await first.bridge.computer.set(made, true);
    const restarted = createApp({ native: first.native, dataFile: join(first.dir, 'presentation.json'), workspace: join(first.dir, 'workspace'), computer: first.driver });
    first.native.calls.length = 0;
    const again = await restarted.bridge.createBot({ name: '团子', simple: { face: 'maine-coon' }, idempotencyKey: key });
    assert.equal(again.id, made.id);
    assert.deepEqual(first.patches(), [], 'no switch was written');
    assert.equal((await restarted.bridge.computer.view(again)).on, true);
    await restarted.close();
  } finally { await first.end(); }
});

test('the cat a template makes is named after the request key, as the engine\'s route does, so it can be blocked first', async () => {
  const patch = readFileSync(new URL('../patches/0005-cat-templates.patch', import.meta.url), 'utf8');
  assert.match(patch, /const catId = `bot-\$\{createHash\('sha256'\)\.update\(input\.idempotencyKey\)\.digest\('hex'\)\.slice\(0, 24\)\}`;/);
  const source = readFileSync(new URL('../server/native/bridge.ts', import.meta.url), 'utf8');
  assert.match(source, /expected = `bot-\$\{createHash\('sha256'\)\.update\(key\)\.digest\('hex'\)\.slice\(0, 24\)\}`/);
  assert.equal(`bot-${createHash('sha256').update('k').digest('hex').slice(0, 24)}`.length, 28);
});

test('when the made cat still has the computer, each creation\'s own answer says so', async () => {
  const { native, bridge, end } = app();
  try {
    await bridge.computer.set(native.cats[0]!, true);
    // The block is confirmed, the cat is made — and the engine hands it the computer all the same.
    const request = native.request.bind(native);
    native.request = (async (path: string, options: any = {}) => {
      const result = await request(path, options);
      if (path === '/api/cats' && options.method === 'POST') { native.capabilities[0]!.blockedCats = native.capabilities[0]!.blockedCats!.filter(id => id !== options.body.catId); native.capabilityFailures.add('PATCH:cat'); }
      return result;
    }) as typeof native.request;
    const [one, two] = await Promise.all([bridge.createBot({ name: '并发一' }), bridge.createBot({ name: '并发二' }).catch(error => error)]);
    assert.match(bridge.creationNotice(one) ?? '', /它现在可以用这台电脑/);
    assert.equal(bridge.creationNotice(one), undefined, 'said once');
    assert.equal(two instanceof ApiError && two.code === 'computer_unconfirmed', true, 'the second was refused before any cat was made: the block could no longer be written');
  } finally { await end(); }
});

test('the routes: GET reads, PUT switches and answers with the view; a creation carries the notice', async () => {
  const { native, driver, runtime, end } = app();
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
    const made = await call('/bots', 'POST', { name: '新猫' });
    assert.equal(made.status, 201); assert.equal((await made.json()).notice, undefined);
    native.capabilityFailures.add('PATCH:cat');
    const refusedCreation = await call('/bots', 'POST', { name: '又一只' });
    assert.equal(refusedCreation.status, 503); assert.equal((await refusedCreation.json()).code, 'computer_unconfirmed');
  } finally { server.close(); await end(); }
});

test('turning the computer off ends the turn the cat is in the middle of, by native cancellation', async () => {
  const { native, bridge, end } = app();
  try {
    const cat = native.cats[0]!, thread = await bridge.direct(cat);
    await bridge.computer.set(cat, true);
    const running = () => native.queues.set(thread.id, { queue: [], activeInvocations: [{ catId: cat.id, invocationId: 'inv-1' }, { catId: 'cat-b', invocationId: 'inv-2' }] });
    const listed = () => native.queues.get(thread.id)!.activeInvocations.map((run: any) => run.catId);
    bridge.cancelPatience = 1500; native.cancelEndsAfterReads = 0;
    running(); native.calls.length = 0;
    assert.equal((await bridge.computer.set(cat, false)).on, false);
    assert.deepEqual(native.calls.filter(call => call.path.includes('/cancel/')).map(call => `${call.method} ${call.path}`), [`POST /api/threads/${thread.id}/cancel/${cat.id}`]);
    assert.deepEqual(listed(), ['cat-b'], 'the turn is gone from the queue; another cat\'s turn in the same conversation is not touched');
    // The engine takes the cancellation and needs a moment to clean up: the answer waits until the turn is gone.
    await bridge.computer.set(cat, true); running(); native.cancelEndsAfterReads = 2;
    assert.equal((await bridge.computer.set(cat, false)).on, false);
    assert.deepEqual(listed(), ['cat-b']);
    // The turn never goes away: off in the registry, and said to be still running.
    await bridge.computer.set(cat, true); running(); native.cancelEndsAfterReads = Infinity; bridge.cancelPatience = 400;
    await refused(bridge.computer.set(cat, false), 502, 'computer_still_running');
    assert.equal((await bridge.computer.view(cat)).on, false); assert.deepEqual(listed(), [cat.id, 'cat-b']);
    // The engine answers that it cancelled nothing.
    await bridge.computer.set(cat, true); running(); native.cancelEndsAfterReads = 0; native.cancelAnswer = { ok: true, cancelled: false };
    await refused(bridge.computer.set(cat, false), 502, 'computer_still_running');
    // Idle: nothing is cancelled.
    native.cancelAnswer = { ok: true, cancelled: true };
    native.queues.delete(thread.id); await bridge.computer.set(cat, true); native.calls.length = 0;
    await bridge.computer.set(cat, false);
    assert.equal(native.calls.some(call => call.path.includes('/cancel/')), false);
  } finally { await end(); }
});

test('only the driver\'s own signed build is accepted, by an absolute real path', async () => {
  assert.equal(driverRequirement, 'identifier "com.trycua.driver" and anchor apple generic and certificate leaf[subject.OU] = "YCK386LBJ7"');
  const dir = mkdtempSync(join(tmpdir(), 'bot-driver-'));
  try {
    // A relative place is not looked at; an empty tools directory has no driver; another system has none at all.
    assert.equal(await cuaDriver(dir, { BOT_COMPUTER_DRIVER_APP: 'tools/CuaDriver.app', HOME: dir }, 'darwin').locate(true).then(found => found === undefined || !found.command.startsWith('tools/')), true);
    assert.equal(cuaDriver(dir, {}, 'linux').supported, false);
    assert.equal(await cuaDriver(dir, {}, 'linux').locate(), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the pinned driver: the lock names one release by checksum, and the installer installs nothing it cannot verify', { skip: process.platform !== 'darwin' }, () => {
  const lock = JSON.parse(readFileSync(new URL('../computer-driver.lock.json', import.meta.url), 'utf8'));
  assert.match(lock.darwin.sha256, /^[0-9a-f]{64}$/); assert.match(lock.tag, /^cua-driver-rs-v\d+\.\d+\.\d+$/);
  assert.equal(lock.tag.endsWith(lock.version), true); assert.equal(lock.darwin.asset.includes(lock.version), true);
  // The adapter accepts the same identity the installer pins.
  assert.equal(driverRequirement.includes(`identifier "${lock.bundleId}"`) && driverRequirement.includes(`"${lock.teamIdentifier}"`), true);
  const dir = mkdtempSync(join(tmpdir(), 'bot-driver-'));
  const install = (...args: string[]) => spawnSync(process.execPath, [new URL('../scripts/install-computer-driver.mjs', import.meta.url).pathname, ...args],
    { encoding: 'utf8', env: { ...process.env, BOT_DATA_DIR: dir } });
  try {
    const check = install('--check');
    assert.equal(check.status, 1); assert.match(check.stdout, /还没有安装/);
    writeFileSync(join(dir, 'fake.tar.gz'), 'not the driver');
    const wrong = install('--from', join(dir, 'fake.tar.gz'));
    assert.equal(wrong.status, 1); assert.match(wrong.stderr, /没有安装/);
    assert.equal(existsSync(join(dir, 'tools', 'CuaDriver.app')), false);
    assert.deepEqual(readdirSync(join(dir, 'tools')), [], 'nothing is left behind');
    // `--from` with no file is a mistake, not a reason to download.
    for (const args of [['--from'], ['--from', '--check']]) { const bare = install(...args); assert.equal(bare.status, 1, args.join(' ')); assert.match(bare.stderr, /--from/); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
