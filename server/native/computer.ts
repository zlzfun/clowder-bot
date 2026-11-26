import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
  /**
   * How a cat's Agent starts the driver's tools, or undefined when the driver
   * is not installed. `fresh`: check the program's identity now, not from an
   * earlier look (asked before the registry is pointed at it).
   */
  locate(fresh?: boolean): Promise<ComputerServer | undefined>;
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

/** The one identity accepted as the driver: cua-driver's bundle id, signed by its Developer ID team (computer-driver.lock.json pins the same pair). */
export const driverRequirement = 'identifier "com.trycua.driver" and anchor apple generic and certificate leaf[subject.OU] = "YCK386LBJ7"';

/**
 * cua-driver in its standalone mode: `CuaDriver.app` is its own macOS identity
 * (Developer ID "Cua AI, Inc."), so the grants are given to it and hold however
 * this app was started. `toolsDir` is where scripts/install-computer-driver.mjs
 * puts it; a copy the owner installed themselves is found too. Only a build
 * that satisfies driverRequirement is used, by its real absolute path: a name
 * or a link alone must not decide which program drives the desktop, and what
 * is checked here is the very path the engine is given to run.
 */
export function cuaDriver(toolsDir: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): ComputerDriver {
  const calm = { CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', CUA_DRIVER_RS_UPDATE_CHECK: '0' };
  // A relative place would be read against this process's directory here and against the engine's there: not accepted.
  const places = [env.BOT_COMPUTER_DRIVER_APP, join(toolsDir, 'CuaDriver.app'), '/Applications/CuaDriver.app', join(homedir(), 'Applications', 'CuaDriver.app')]
    .filter((place): place is string => !!place && isAbsolute(place));
  const cli = (app: string) => join(app, 'Contents', 'MacOS', 'cua-driver');
  // What the program was when it was last checked: a change to the file is a different program.
  const mark = (app: string) => { try { const s = statSync(cli(app)); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return undefined; } };
  let known: { app: string; mark: string; at: number } | undefined;
  async function app(fresh = false): Promise<string | undefined> {
    if (!fresh && known && Date.now() - known.at < 60_000 && mark(known.app) === known.mark) return known.app;
    known = undefined;
    for (const place of places) {
      let real: string;
      try { real = realpathSync(place); } catch { continue; }
      const before = mark(real);
      if (!before) continue;
      const valid = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${driverRequirement}`, real], env, 30_000);
      if (valid.ok && mark(real) === before) { known = { app: real, mark: before, at: Date.now() }; return real; }
    }
    return undefined;
  }
  const driver = async (...args: string[]) => { const found = await app(); return found ? run(cli(found), args, { ...env, ...calm }) : undefined; };
  return {
    supported: platform === 'darwin',
    async locate(fresh) { const found = platform === 'darwin' ? await app(fresh) : undefined; return found ? { command: cli(found), args: ['mcp'], env: calm } : undefined; },
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
interface Entry { id?: string; type?: string; source?: string; enabled?: boolean; cats?: Record<string, boolean>; blockedCats?: string[]; mcpServer?: { command?: string; args?: string[] } }
/** Ends the turns a cat is in the middle of, wherever it is working; `failed` counts those not seen to have ended. */
export type StopRunning = (cat: NativeCat) => Promise<{ stopped: number; failed: number }>;

// What the entry points at while it is being registered: a program that offers no tools.
const placeholder = '/usr/bin/true';
const anyOn = (entry: Entry | undefined) => Object.values(entry?.cats ?? {}).some(Boolean);
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

export class Computer {
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Ids of cats whose creation was sent while no entry existed and whose answer never came: the engine may still make
   * them. They are blocked when the entry is first registered (see register). Request bookkeeping, in memory.
   */
  private readonly unconfirmed = new Set<string>();
  /**
   * `stopRunning`: how a cat's running turns are ended (the bridge's native cancel).
   * `patience`: how long a driver that was just started is given to answer, in ms.
   */
  constructor(private readonly native: NativeTransport, readonly driver: ComputerDriver,
    private readonly stopRunning: StopRunning = async () => ({ stopped: 0, failed: 0 }), private readonly patience = 6000) {}

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
  private real(entry: Entry | undefined): entry is Entry { return !!entry && entry.mcpServer?.command !== placeholder; }
  private isOn(entry: Entry | undefined, cat: NativeCat) { return this.real(entry) && entry.enabled !== false && entry.cats?.[cat.id] === true; }
  /** One change at a time: a switch, and a cat being made, are several native steps that must not interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }

  async view(cat: NativeCat): Promise<ComputerView> {
    // Whether the cat is on is the registry's to say, also where the driver is gone or this is not a Mac: a stale "on" must still be seen and switched off.
    const [located, entry] = await Promise.all([this.driver.supported ? this.driver.locate() : undefined, this.entry()]);
    const grants: ComputerGrants = located ? await this.driver.permissions() : { state: 'unknown' };
    return { supported: this.driver.supported, installed: !!located, on: this.isOn(entry, cat), permissions: grants.state,
      ...(grants.state === 'needed' ? { missing: grants.missing } : {}) };
  }

  set(cat: NativeCat, enabled: boolean): Promise<ComputerView> { return this.serial(() => enabled ? this.enable(cat) : this.disable(cat)); }

  /**
   * Turning it on. Returns the view as it is afterwards: `on: false` with
   * `permissions: 'needed'` means the driver is waiting for the owner in System
   * Settings and nothing was switched; the same request is sent again once the
   * grants are there. The registry is only written after the grants are read.
   */
  private async enable(cat: NativeCat): Promise<ComputerView> {
    if (!this.driver.supported) throw new ApiError(422, '这台电脑上还用不了这项功能', undefined, 'computer_unsupported');
    const located = await this.driver.locate(true);
    if (!located) throw new ApiError(422, '还没有装上操作电脑要用的驱动', undefined, 'computer_absent');
    let grants = await this.driver.permissions();
    if (grants.state === 'unknown') {
      await this.driver.start();
      grants = await this.driver.permissions();
      for (let waited = 0; waited < this.patience && grants.state === 'unknown'; waited += 300) { await wait(300); grants = await this.driver.permissions(); }
      if (grants.state === 'unknown') throw new ApiError(503, '电脑驱动没有启动起来，请再试一次', undefined, 'computer_not_started');
    }
    if (grants.state !== 'granted') return this.view(cat);
    const entry = await this.entry();
    if (!this.real(entry)) await this.register(located);
    // The driver was moved or reinstalled: the engine keeps who is blocked when an entry is installed over.
    else if (entry.mcpServer?.command !== located.command || JSON.stringify(entry.mcpServer?.args ?? []) !== JSON.stringify(located.args)) await this.install(located);
    // Written whatever was just read: an earlier request that timed out here may still be waiting in the engine, and the last write is the one that stands.
    await this.toggle({ scope: 'cat', catId: cat.id, enabled: true });
    if (!this.isOn(await this.entry(), cat)) throw new ApiError(502, '没能打开，请再试一次');
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
    // Ids already on a leftover entry's block list that are no cat yet: cats blocked before a creation that may still reach the engine (guard).
    const before = await this.entry();
    const unborn = new Set([...(before?.blockedCats ?? []).filter(id => !(id in (before?.cats ?? {}))), ...this.unconfirmed]);
    await this.install({ command: placeholder, args: [] });
    try {
      await this.toggle({ scope: 'project', enabled: false });
      // The one call writes the list anew from the cats that exist, so the cats still on their way are put back on it.
      for (const id of unborn) await this.toggle({ scope: 'cat', catId: id, enabled: false });
      const blocked = await this.entry();
      if (anyOn(blocked) || [...unborn].some(id => !blocked?.blockedCats?.includes(id))) throw new Error('still on for a cat');
      await this.install(located);
      const real = await this.entry();
      if (!real || anyOn(real)) throw new Error('on for a cat after the driver was set');
    } catch {
      const withdrawn = await this.native.request(`/api/capabilities/mcp/${computerEntry}?hard=true`, { method: 'DELETE' }).then(() => true, () => false);
      throw new ApiError(502, withdrawn ? '没能把电脑接上，这一步已经撤回，可以再试一次' : '没能把电脑接上，而且没能撤回干净：请到每只猫的资料里确认「电脑」是关着的',
        undefined, withdrawn ? 'computer_not_registered' : 'computer_half_registered');
    }
    this.unconfirmed.clear();
    void this.driver.quiet().catch(() => {});
  }

  /**
   * Turning it off, whatever the driver's state. The block is written even
   * when the cat already reads as off (an earlier "on" that timed out here may
   * still be waiting in the engine; written after it, this one stands). A turn
   * the cat is in the middle of was given the tools when it started and keeps
   * them until it ends, so its running turns are ended too, every time and
   * whatever became of the write — an earlier "off" may have blocked the cat
   * and failed before it could end them. Off means off now; a turn not seen
   * to have ended is said. With no cat left on, the driver's background
   * process is asked to end.
   */
  private async disable(cat: NativeCat): Promise<ComputerView> {
    let entry: Entry | undefined, read = true;
    try { entry = await this.entry(); } catch { read = false; }
    // No entry, or only the placeholder: no cat was ever handed the tools.
    if (read && !this.real(entry)) return this.view(cat);
    let failure: unknown;
    try {
      await this.toggle({ scope: 'cat', catId: cat.id, enabled: false });
      entry = await this.entry();
      if (this.isOn(entry, cat)) throw new ApiError(502, '没能关掉，请再试一次');
    } catch (error) { failure = error; }
    const ended = await this.stopRunning(cat).catch(() => ({ stopped: 0, failed: 1 }));
    if (failure) throw failure;
    if (entry && !anyOn(entry)) void this.driver.stop().catch(() => {});
    if (ended.failed) throw new ApiError(502, '已经关掉了，但它正在进行的这一轮还没有停下来，停下之前它还能用这台电脑。请在对话里点停止，或者稍后再关一次。', undefined, 'computer_still_running');
    return this.view(cat);
  }

  /**
   * A cat is made without the computer. `create` is the native creation of the
   * cat whose id will be `catId`; `exists` says, asked inside the lock,
   * whether that cat is already there (a repeated request: it is left exactly
   * as the owner has it now). Whenever the entry exists the new id is put on
   * its block list BEFORE the cat exists (the engine accepts an id it does
   * not know yet) and the creation only goes ahead once that is confirmed —
   * also while every cat is off, when the engine would block a new cat by
   * itself: a creation that reaches the engine late, after a cat was switched
   * on, would otherwise start with the computer. So the cat is blocked first
   * whatever becomes of the creation's answer or of the caller's later steps.
   * With no entry there is nothing to block against; a creation whose answer
   * never came is remembered and blocked when the entry is first registered.
   * Switches wait meanwhile. Afterwards the made cat is looked at once more
   * (its id may not be the expected one); what could not be put right comes
   * back as words for the owner (`notice`), with this creation's own answer.
   */
  guard<T extends { cat?: NativeCat }>(catId: string, exists: () => Promise<boolean>, create: () => Promise<T>): Promise<{ made: T; notice?: string }> {
    const unconfirmed = () => new ApiError(503, '没能确认新猫用不了这台电脑，猫没有创建。请再试一次。', undefined, 'computer_unconfirmed');
    return this.serial(async () => {
      if (await exists()) return { made: await create() };
      let entry: Entry | undefined;
      try { entry = await this.entry(); } catch { throw unconfirmed(); }
      if (entry) {
        try {
          await this.toggle({ scope: 'cat', catId, enabled: false });
          if (!(await this.entry())?.blockedCats?.includes(catId)) throw new Error('not listed');
        } catch { throw unconfirmed(); }
      }
      let made: T;
      try { made = await create(); }
      catch (error) {
        // Refused outright (4xx): no such cat. Anything else: the engine may still make it.
        if (!entry && !(error instanceof ApiError && error.status >= 400 && error.status < 500)) {
          this.unconfirmed.add(catId);
          for (const old of this.unconfirmed) { if (this.unconfirmed.size <= 200) break; this.unconfirmed.delete(old); }
        }
        throw error;
      }
      const notice = entry && made.cat?.id ? await this.keepOff(made.cat) : undefined;
      return { made, ...(notice ? { notice } : {}) };
    });
  }

  /** The made cat, looked at once more and taken off if it is on. Returns the words for the owner when that could not be done or confirmed. */
  private async keepOff(cat: NativeCat): Promise<string | undefined> {
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
