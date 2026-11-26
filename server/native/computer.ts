import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../errors.js';
import type { NativeCat, NativeTransport } from './types.js';

/**
 * 这台电脑: a cat that may see and operate the apps on this machine.
 *
 * Nothing here runs, schedules or supervises anything. The tools belong to a
 * desktop driver the owner installed (today cua-driver's own signed app, which
 * holds the macOS grants and starts its background process by itself when a
 * tool is called). A cat gets them through one entry in the engine's
 * capability registry, and the engine's per-cat toggle on that entry is the
 * switch: who may use the computer is read from the registry every time, never
 * remembered here. docs/xbot-api.md「这台电脑」 has the contract.
 */

/** The registry entry's id: what the cat's tools are named after, whichever driver is behind it. */
export const computerEntry = 'computer';
/** A step that used this entry's tools, by the names the engine's two carriers give them (Claude Code, Codex). */
export const computerTool = (tool: string) => tool.startsWith(`mcp__${computerEntry}__`) || tool.startsWith(`mcp:${computerEntry}/`);

export type ComputerGrant = 'accessibility' | 'screen_recording';
/** `unknown`: the driver's background process is not running, so nothing could be read. */
export type ComputerGrants = { state: 'granted' } | { state: 'needed'; missing: ComputerGrant[] } | { state: 'unknown' };
export interface ComputerServer { command: string; args: string[]; env?: Record<string, string> }
export interface ComputerDriver {
  /** False where this app has no driver to offer (anything but macOS today). */
  readonly supported: boolean;
  /** How a cat's Agent starts the driver's tools, or undefined when the driver is not installed. */
  locate(): Promise<ComputerServer | undefined>;
  /** The driver's own macOS grants. */
  permissions(): Promise<ComputerGrants>;
  /** Starts the driver's background process. While a grant is missing the driver opens System Settings itself. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** No vendor analytics: the owner picked a switch in this app, not the driver's defaults. */
  quiet(): Promise<void>;
}
export const noComputer: ComputerDriver = { supported: false, locate: async () => undefined, permissions: async () => ({ state: 'unknown' }),
  start: async () => {}, stop: async () => {}, quiet: async () => {} };

const run = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 8000) =>
  new Promise<{ ok: boolean; out: string; err: string }>(done => execFile(file, args, { env, timeout, maxBuffer: 1 << 20 },
    (error, stdout, stderr) => done({ ok: !error, out: String(stdout), err: String(stderr) })));

/**
 * cua-driver in its standalone mode: `CuaDriver.app` is its own macOS identity
 * (Developer ID "Cua AI, Inc."), so the grants are given to it and hold however
 * this app was started. `toolsDir` is where scripts/install-computer-driver.mjs
 * puts it; a copy the owner installed themselves is found too. Only a build
 * with that signature is used: a path alone must not decide which program
 * drives the desktop.
 */
export function cuaDriver(toolsDir: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): ComputerDriver {
  const calm = { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', CUA_DRIVER_RS_UPDATE_CHECK: '0' };
  const places = [env.BOT_COMPUTER_DRIVER_APP, join(toolsDir, 'CuaDriver.app'), '/Applications/CuaDriver.app', join(homedir(), 'Applications', 'CuaDriver.app')]
    .filter((place): place is string => !!place);
  const cli = (app: string) => join(app, 'Contents', 'MacOS', 'cua-driver');
  let known: { app: string; at: number } | undefined;
  async function app(): Promise<string | undefined> {
    if (known && Date.now() - known.at < 60_000 && existsSync(cli(known.app))) return known.app;
    known = undefined;
    for (const place of places) {
      if (!existsSync(cli(place))) continue;
      const [signed, valid] = await Promise.all([run('/usr/bin/codesign', ['-dv', '--verbose=2', place], env, 20_000), run('/usr/bin/codesign', ['--verify', '--strict', place], env, 20_000)]);
      if (valid.ok && /^Identifier=com\.trycua\.driver$/m.test(signed.err) && /^TeamIdentifier=YCK386LBJ7$/m.test(signed.err)) { known = { app: place, at: Date.now() }; return place; }
    }
    return undefined;
  }
  const driver = async (...args: string[]) => { const found = await app(); return found ? run(cli(found), args, { ...env, ...calm }) : undefined; };
  return {
    supported: platform === 'darwin',
    async locate() { const found = platform === 'darwin' ? await app() : undefined; return found ? { command: cli(found), args: ['mcp'], env: calm } : undefined; },
    async permissions() {
      const result = await driver('permissions', 'status', '--json');
      let read: Record<string, unknown>;
      try { read = JSON.parse(result?.out ?? ''); } catch { return { state: 'unknown' }; }
      if (!read || typeof read !== 'object' || read.daemon_running === false || read.status === 'unknown') return { state: 'unknown' };
      const missing = (['accessibility', 'screen_recording'] as const).filter(grant => read[grant] !== true);
      return missing.length ? { state: 'needed', missing } : { state: 'granted' };
    },
    // LaunchServices, not a child of this process: that is what makes the driver its own responsible app.
    async start() { const found = await app(); if (found) await run('/usr/bin/open', ['-n', '-g', found, ...Object.entries(calm).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--args', 'serve'], env); },
    async stop() { await driver('stop'); },
    async quiet() { await driver('telemetry', 'disable'); },
  };
}

/** What a cat's 资料 shows about the computer. `on` is the registry's word; the rest says whether that can work right now. */
export interface ComputerView { supported: boolean; installed: boolean; on: boolean; permissions: ComputerGrants['state']; missing?: ComputerGrant[] }
interface Entry { id?: string; type?: string; source?: string; enabled?: boolean; cats?: Record<string, boolean>; mcpServer?: { command?: string; args?: string[] } }

// What the entry points at while it is being registered: a program that offers no tools.
const placeholder = '/usr/bin/true';
const anyOn = (entry: Entry | undefined) => Object.values(entry?.cats ?? {}).some(Boolean);
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

export class Computer {
  private tail: Promise<unknown> = Promise.resolve();
  /** `patience`: how long a driver that was just started is given to answer, in ms. */
  constructor(private readonly native: NativeTransport, readonly driver: ComputerDriver, private readonly patience = 6000) {}

  private async entry(): Promise<Entry | undefined> {
    const { items } = await this.native.request<{ items?: Entry[] }>('/api/capabilities');
    return (items ?? []).find(item => item.id === computerEntry && item.type === 'mcp' && item.source === 'external');
  }
  private toggle(scope: Record<string, unknown>) {
    return this.native.request('/api/capabilities', { method: 'PATCH', body: { capabilityId: computerEntry, capabilityType: 'mcp', source: 'external', ...scope } });
  }
  private install(server: ComputerServer) {
    return this.native.request('/api/capabilities/mcp/install', { method: 'POST', body: { id: computerEntry, transport: 'stdio', ...server } });
  }
  private isOn(entry: Entry | undefined, cat: NativeCat) { return !!entry && entry.enabled !== false && entry.mcpServer?.command !== placeholder && entry.cats?.[cat.id] === true; }

  async view(cat: NativeCat): Promise<ComputerView> {
    // Whether the cat is on is the registry's to say, also where the driver is gone or this is not a Mac: a stale "on" must still be seen and switched off.
    const [located, entry] = await Promise.all([this.driver.supported ? this.driver.locate() : undefined, this.entry()]);
    const grants: ComputerGrants = located ? await this.driver.permissions() : { state: 'unknown' };
    return { supported: this.driver.supported, installed: !!located, on: this.isOn(entry, cat), permissions: grants.state,
      ...(grants.state === 'needed' ? { missing: grants.missing } : {}) };
  }

  /** One change at a time: registering the entry is several native steps that must not interleave with another switch. */
  set(cat: NativeCat, enabled: boolean): Promise<ComputerView> {
    const next = this.tail.then(() => enabled ? this.enable(cat) : this.disable(cat));
    this.tail = next.catch(() => {});
    return next;
  }

  /**
   * Turning it on. Returns the view as it is afterwards: `on: false` with
   * `permissions: 'needed'` means the driver is waiting for the owner in System
   * Settings and nothing was switched; the same request is sent again once the
   * grants are there. The registry is only written after the grants are read.
   */
  private async enable(cat: NativeCat): Promise<ComputerView> {
    if (!this.driver.supported) throw new ApiError(422, '这台电脑上还用不了这项功能', undefined, 'computer_unsupported');
    const located = await this.driver.locate();
    if (!located) throw new ApiError(422, '还没有装上操作电脑要用的驱动', undefined, 'computer_absent');
    let grants = await this.driver.permissions();
    if (grants.state === 'unknown') {
      await this.driver.start();
      grants = await this.driver.permissions();
      for (let waited = 0; waited < this.patience && grants.state === 'unknown'; waited += 300) { await wait(300); grants = await this.driver.permissions(); }
      if (grants.state === 'unknown') throw new ApiError(503, '电脑驱动没有启动起来，请再试一次', undefined, 'computer_not_started');
    }
    if (grants.state !== 'granted') return this.view(cat);
    let entry = await this.entry();
    if (!entry || entry.mcpServer?.command === placeholder) { await this.register(located); entry = await this.entry(); }
    // The driver was moved or reinstalled: the engine keeps who is blocked when an entry is installed over.
    else if (entry.mcpServer?.command !== located.command || JSON.stringify(entry.mcpServer?.args ?? []) !== JSON.stringify(located.args)) { await this.install(located); entry = await this.entry(); }
    if (!this.isOn(entry, cat)) { await this.toggle({ scope: 'cat', catId: cat.id, enabled: true }); entry = await this.entry(); }
    if (!this.isOn(entry, cat)) throw new ApiError(502, '没能打开，请再试一次');
    return this.view(cat);
  }

  /**
   * The entry, registered so that no cat has it for a moment. Installing an
   * entry turns it on for every cat (the engine's per-cat control is a block
   * list), so a placeholder that offers no tools goes in first, is blocked for
   * every cat in the engine's one call, and only then is pointed at the driver.
   * If any step cannot be confirmed the entry is taken out again.
   */
  private async register(located: ComputerServer): Promise<void> {
    await this.install({ command: placeholder, args: [] });
    try {
      await this.toggle({ scope: 'project', enabled: false });
      if (anyOn(await this.entry())) throw new Error('still on for a cat');
      await this.install(located);
      const real = await this.entry();
      if (!real || anyOn(real)) throw new Error('on for a cat after the driver was set');
    } catch {
      const withdrawn = await this.native.request(`/api/capabilities/mcp/${computerEntry}?hard=true`, { method: 'DELETE' }).then(() => true, () => false);
      throw new ApiError(502, withdrawn ? '没能把电脑接上，这一步已经撤回，可以再试一次' : '没能把电脑接上，而且没能撤回干净：请到每只猫的资料里确认「电脑」是关着的',
        undefined, withdrawn ? 'computer_not_registered' : 'computer_half_registered');
    }
    void this.driver.quiet().catch(() => {});
  }

  /** Turning it off works whatever the driver's state: it only takes the cat off the entry. With no cat left on, the driver's background process is asked to end. */
  private async disable(cat: NativeCat): Promise<ComputerView> {
    let entry = await this.entry();
    if (this.isOn(entry, cat)) {
      await this.toggle({ scope: 'cat', catId: cat.id, enabled: false });
      entry = await this.entry();
      if (this.isOn(entry, cat)) throw new ApiError(502, '没能关掉，请再试一次');
    }
    if (entry && !anyOn(entry)) void this.driver.stop().catch(() => {});
    return this.view(cat);
  }

  /**
   * A cat that was just created starts without the computer. The engine does
   * this itself while the entry is off for every cat; once one cat has it on,
   * a new cat would start with it too, so it is taken off here. Returns what
   * the owner has to hear when that could not be done or confirmed.
   */
  async keepOff(cat: NativeCat): Promise<string | undefined> {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this.isOn(await this.entry(), cat)) return undefined;
        await this.toggle({ scope: 'cat', catId: cat.id, enabled: false }).catch(() => {});
      }
      if (!this.isOn(await this.entry(), cat)) return undefined;
      return '猫猫建好了，但它现在可以用这台电脑：这项设置没能关上。到它的资料里把「电脑」关掉就可以。';
    } catch {
      return '猫猫建好了，但没能确认它用不了这台电脑。到它的资料里看一眼「电脑」是不是关着。';
    }
  }
}
