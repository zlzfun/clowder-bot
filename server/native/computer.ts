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

/**
 * What a cat's 资料 shows about the computer. `on` is the registry's word; the rest says whether that can work right now.
 * `others`: the names of the other cats that currently have it on in the registry — switched off when this cat is switched on.
 * `lingering`: the names of the other cats already off in the registry whose running turn is still going — stopped when this cat is switched on.
 */
export interface ComputerView { supported: boolean; installed: boolean; on: boolean; permissions: ComputerGrants['state']; missing?: ComputerGrant[]; others?: string[]; lingering?: string[] }
interface Entry { id?: string; type?: string; source?: string; enabled?: boolean; cats?: Record<string, boolean>; blockedCats?: string[]; mcpServer?: { command?: string; args?: string[] } }
/**
 * Ends the turns a cat is in the middle of, wherever it is working; `failed` counts those not seen to have ended.
 * `look`: nothing is ended — `failed` is how many it is in the middle of.
 */
export type StopRunning = (cat: Pick<NativeCat, 'id'>, look?: boolean) => Promise<{ stopped: number; failed: number }>;
/** The names the owner knows the cats with these ids by, in the same order; '' for one that cannot be named. Only for words. */
export type NameCats = (ids: string[]) => Promise<string[]>;

// What the entry points at while it is being registered: a program that offers no tools.
const placeholder = '/usr/bin/true';
const anyOn = (entry: Entry | undefined) => Object.values(entry?.cats ?? {}).some(Boolean);
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const trimName = (value: string) => value.trim();
/** Which currently affected cats (`current`) were not covered by the confirmed names (`confirmed`); unnamed cats (`''`) match one-for-one. */
function unconfirmedCats(confirmed: string[], current: string[]): string[] {
  const said = confirmed.map(trimName);
  const missing: string[] = [];
  for (const raw of current) {
    const name = trimName(raw);
    const at = said.indexOf(name);
    if (at < 0) missing.push(name);
    else if (!name) said.splice(at, 1);
  }
  return missing;
}

export class Computer {
  private tail: Promise<unknown> = Promise.resolve();
  /**
   * Ids of cats whose creation was sent while no entry existed and whose answer never came: the engine may still make
   * them. They are blocked when the entry is first registered (see register). Request bookkeeping, in memory.
   */
  private readonly unconfirmed = new Set<string>();
  /**
   * Cats the computer was, or is being, taken from, each until it is seen to be both off in the registry and without a
   * running turn. A turn keeps the tools it started with, so a cat that reads as off may still be using the computer;
   * and a block whose answer never came may land after the request that sent it is over. So a cat is put here before
   * its block is sent and taken out only on that evidence (or when it is switched on again: the turn is its own once
   * more). While one of them is still going no other cat is switched on (handOver), and it is not deleted (retire).
   * Request bookkeeping, in memory: who is on stays the registry's to say.
   */
  private readonly lingering = new Set<string>();
  /**
   * `stopRunning`: how a cat's running turns are ended (the bridge's native cancel).
   * `patience`: how long a driver that was just started is given to answer, in ms.
   * `nameCats`: what the cats are called, for the words about another cat.
   */
  constructor(private readonly native: NativeTransport, readonly driver: ComputerDriver,
    private readonly stopRunning: StopRunning = async () => ({ stopped: 0, failed: 0 }), private readonly patience = 6000,
    private readonly nameCats: NameCats = async ids => ids.map(() => '')) {}

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
  private isOn(entry: Entry | undefined, cat: Pick<NativeCat, 'id'>) { return this.real(entry) && entry.enabled !== false && entry.cats?.[cat.id] === true; }
  /** The other cats that have it on, by id. */
  private rivals(entry: Entry | undefined, cat: NativeCat): string[] {
    return this.real(entry) && entry.enabled !== false ? Object.entries(entry.cats ?? {}).filter(([id, on]) => on === true && id !== cat.id).map(([id]) => id) : [];
  }
  private async called(ids: string[]): Promise<string[]> { return this.nameCats(ids).then(names => ids.map((_, index) => names[index] ?? ''), () => ids.map(() => '')); }
  /** Format already-resolved cat names the way the dialog does: each name in 「」, those without one as 另一只猫, 另外几只猫 for more. */
  private formatWho(called: string[]): string {
    const names = [...new Set(called.filter(Boolean))].map(name => `「${name}」`), unnamed = called.filter(name => !name).length;
    const rest = unnamed > 1 ? '另外几只猫' : unnamed ? '另一只猫' : '';
    return names.join('') + (names.length && rest ? '和' : '') + rest;
  }
  /** The cats as the owner would say them, the way the page's dialog does (profile-rules.js computerHandover). */
  private async who(ids: string[]): Promise<string> { return this.formatWho(await this.called(ids)); }
  /**
   * Ends the turns a cat is in the middle of and says whether they are seen to have ended. `off`: the registry was just
   * read with this cat off. Only with both is the cat done with (see lingering): one that may still be on can start
   * another turn with the tools before a block that is still on its way lands.
   */
  private async ended(id: string, off: boolean): Promise<boolean> {
    const seen = !(await this.stopRunning({ id }).catch(() => ({ stopped: 0, failed: 1 }))).failed;
    if (seen && off) this.lingering.delete(id); else this.lingering.add(id);
    return seen;
  }
  /** Whether a cat is in the middle of a turn, as far as can be seen; one that cannot be looked at counts as in one. */
  private async busy(id: string): Promise<boolean> { return (await this.stopRunning({ id }, true).catch(() => ({ stopped: 0, failed: 1 }))).failed > 0; }
  /** One change at a time: a switch, and a cat being made, are several native steps that must not interleave. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }

  private async affected(cat: NativeCat, entry: Entry | undefined): Promise<{ rivalIds: string[]; lingeringIds: string[]; others: string[]; lingering: string[] }> {
    const rivalIds = this.rivals(entry, cat);
    const lingeringIds: string[] = [];
    for (const id of [...this.lingering]) if (id !== cat.id && !rivalIds.includes(id) && await this.busy(id)) lingeringIds.push(id);
    if (!rivalIds.length && !lingeringIds.length) return { rivalIds, lingeringIds, others: [], lingering: [] };
    const names = await this.called([...rivalIds, ...lingeringIds]);
    return { rivalIds, lingeringIds, others: names.slice(0, rivalIds.length), lingering: names.slice(rivalIds.length) };
  }

  async view(cat: NativeCat): Promise<ComputerView> { return this.shown(cat, await this.entry()); }
  /**
   * The view from the registry as it was just read. A change answers with what it read back to confirm itself, not with
   * another read: one that failed would turn a change known to have gone through into an error.
   */
  private async shown(cat: NativeCat, entry: Entry | undefined, known?: { located?: ComputerServer; grants: ComputerGrants; others: string[]; lingering: string[] }): Promise<ComputerView> {
    // Whether the cat is on is the registry's to say, also where the driver is gone or this is not a Mac: a stale "on" must still be seen and switched off.
    const located = known ? known.located : (this.driver.supported ? await this.driver.locate() : undefined);
    const grants: ComputerGrants = known ? known.grants : (located ? await this.driver.permissions() : { state: 'unknown' });
    // Who gives it up when this cat is switched on: the cats that have it on (`others`), and a cat already off with a
    // turn still going (`lingering`, looked at now so one that stopped by itself is not named).
    const { others, lingering } = known ?? await this.affected(cat, entry);
    return { supported: this.driver.supported, installed: !!located, on: this.isOn(entry, cat), permissions: grants.state,
      ...(grants.state === 'needed' ? { missing: grants.missing } : {}),
      ...(others.length ? { others } : {}),
      ...(lingering.length ? { lingering } : {}) };
  }

  set(cat: NativeCat, enabled: boolean, confirmOff: string[] = []): Promise<ComputerView> {
    return this.serial(() => enabled ? this.enable(cat, confirmOff) : this.disable(cat));
  }

  /**
   * Turning it on. Returns the view as it is afterwards: `on: false` with
   * `permissions: 'needed'` means the driver is waiting for the owner in System
   * Settings and nothing was switched; the same request is sent again once the
   * grants are there. The registry is only written after the grants are read.
   *
   * One cat at a time. The cats share one desktop and nothing between them
   * says which application another is in the middle of using (the engine has
   * no such coordination to reuse yet), so the rule is kept where the Bot can
   * keep it, at the switch: every other cat that has it is switched off first
   * — blocked, the block read back, the turns it is in the middle of ended, as
   * when its own switch is turned off — and only then is this cat switched on.
   * If another cat cannot be seen to be off and stopped, this one stays off.
   * Any other cat that would be switched off or stopped must be acknowledged in
   * `confirmOff`; otherwise the request is refused (409) before anything changes.
   */
  private async ensureConfirmed(
    cat: NativeCat,
    entry: Entry | undefined,
    confirmOff: string[],
    located: ComputerServer,
    grants: ComputerGrants,
  ) {
    const current = await this.affected(cat, entry);
    if (unconfirmedCats(confirmOff, [...current.others, ...current.lingering]).length) {
      const view = await this.shown(cat, entry, { located, grants, others: current.others, lingering: current.lingering });
      const onWords = current.others.length ? this.formatWho(current.others) : '';
      const stopWords = current.lingering.length ? this.formatWho(current.lingering) : '';
      const message = onWords && stopWords
        ? `现在${onWords}正用着这台电脑，${stopWords}的已经关掉且还没确认停下，请再确认一次。`
        : onWords
          ? `现在${onWords}正用着这台电脑，请再确认一次。`
          : `${stopWords}的已经关掉，但还没确认已经停下；打开后会先停下，请再确认一次。`;
      throw new ApiError(409, message, view, 'computer_confirm_changed');
    }
    return current;
  }

  private async enable(cat: NativeCat, confirmOff: string[]): Promise<ComputerView> {
    if (!this.driver.supported) throw new ApiError(422, '这台电脑上还用不了这项功能。', undefined, 'computer_unsupported');
    const located = await this.driver.locate(true);
    if (!located) throw new ApiError(422, '还没有装上操作电脑用的驱动。', undefined, 'computer_absent');
    let grants = await this.driver.permissions();
    if (grants.state === 'unknown') {
      await this.driver.start();
      grants = await this.driver.permissions();
      for (let waited = 0; waited < this.patience && grants.state === 'unknown'; waited += 300) { await wait(300); grants = await this.driver.permissions(); }
      if (grants.state === 'unknown') throw new ApiError(503, '操作电脑用的驱动没有启动起来，请再试一次。', undefined, 'computer_not_started');
    }
    if (grants.state !== 'granted') return this.view(cat);
    let entry = await this.entry();
    let current = await this.ensureConfirmed(cat, entry, confirmOff, located, grants);
    if (!this.real(entry)) { await this.register(located); entry = await this.entry(); }
    // The driver was moved or reinstalled: the engine keeps who is blocked when an entry is installed over.
    else if (entry.mcpServer?.command !== located.command || JSON.stringify(entry.mcpServer?.args ?? []) !== JSON.stringify(located.args)) {
      await this.install(located);
      entry = await this.entry();
      current = await this.ensureConfirmed(cat, entry, confirmOff, located, grants);
    }
    // Any lingering cat just observed to be off in `entry` AND idle is done with; restrict handover cancellation to `current.lingeringIds` so a turn started later is never cancelled unconfirmed.
    for (const id of [...this.lingering]) if (id !== cat.id && !current.rivalIds.includes(id) && !current.lingeringIds.includes(id)) this.lingering.delete(id);
    const gave = await this.handOver(cat, entry, current.lingeringIds);
    // Written whatever was just read: an earlier request that timed out here may still be waiting in the engine, and the last write is the one that stands.
    // Whether it is on now is the registry's to say, not the answer to the write: one whose answer was lost may have gone through.
    let failure: unknown, after: Entry | undefined, on: boolean | undefined;
    try { await this.toggle({ scope: 'cat', catId: cat.id, enabled: true }); } catch (error) { failure = error; }
    try { after = await this.entry(); on = this.isOn(after, cat); } catch { /* unread: not known */ }
    // The other cats are off by now: said with what became of this one, or the owner would find that cat's switch off without a word.
    if (on === undefined) throw new ApiError(502, `${gave ? `${gave}的已经关掉了，但` : ''}没能确认这只猫的有没有打开。请再试一次。`, undefined, 'computer_on_unknown');
    if (!on) {
      if (gave) throw new ApiError(502, `${gave}的已经关掉了，但这只猫的没能打开。请再试一次。`, undefined, 'computer_not_on');
      throw failure ?? new ApiError(502, '没能打开，请再试一次。');
    }
    this.lingering.delete(cat.id);
    return this.shown(cat, after);
  }

  /**
   * The other cats give the computer up to `cat`: see enable. Returns the cats that were switched off, as words ('' for
   * none). Throws, with nothing written for `cat`, when one of them cannot be seen to be off and stopped — what `cat`
   * was before is what it still is, and the words say which. A cat that did come off has its running turns ended
   * whatever became of the others, and so has a cat the computer was taken from earlier that is not done with yet
   * (lingering): asking again must not let `cat` in beside a turn that still has the tools.
   */
  private async handOver(cat: NativeCat, current?: Entry, confirmedLingering?: string[]): Promise<string> {
    const entry = current ?? await this.entry(), had = this.isOn(entry, cat);
    const rivals = this.rivals(entry, cat);
    const earlier = (confirmedLingering ?? [...this.lingering]).filter(id => id !== cat.id && !rivals.includes(id));
    if (!rivals.length && !earlier.length) return '';
    // Remembered before its block is sent: a write whose answer never comes may land after this request is over.
    for (const id of rivals) { this.lingering.add(id); try { await this.toggle({ scope: 'cat', catId: id, enabled: false }); } catch { /* read back below */ } }
    // What the registry says now decides, not the answers to the writes: a write whose answer was lost may have gone through.
    let left: string[] = [], unread = false;
    if (rivals.length) { try { const after = await this.entry(); left = rivals.filter(id => this.isOn(after, { id })); } catch { unread = true; } }
    // A cat seen to be still on keeps its reply: nothing changed for it (it stays remembered: its block may yet land). Every
    // other one is off — or, the registry unread, may be: its turns are ended all the same, or the next try would find it
    // off and let `cat` in beside a turn nobody ended.
    const off = rivals.filter(id => !left.includes(id)), running: string[] = [];
    for (const id of off) if (!await this.ended(id, !unread)) running.push(id);
    for (const id of earlier) if (!await this.ended(id, true)) running.push(id);
    // Nothing was written for this cat: one that already had it (a state from before the rule, or a request sent twice) has it still.
    const mine = had ? '这只猫的本来就开着' : '所以这只猫的没有打开';
    if (unread) throw new ApiError(502, `没能确认${await this.who(rivals)}的已经关掉，${mine}。请再试一次。`, undefined, 'computer_other_on');
    if (left.length) throw new ApiError(502, `没能先把${await this.who(left)}的关掉，${mine}。${off.length ? `${await this.who(off)}的已经关掉了。` : ''}请再试一次。`, undefined, 'computer_other_on');
    if (running.length) {
      const names = await this.who(running);
      throw new ApiError(502, `${names}的已经关掉，但它正在进行的这一轮还没有停下来，停下之前它还能用这台电脑，${had
        ? `这只猫的本来就开着。请在${names}的对话里点停止。` : `所以这只猫的先没有打开。请在${names}的对话里点停止，然后再开一次。`}`, undefined, 'computer_other_running');
    }
    return off.length ? this.who(off) : '';
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
      throw new ApiError(502, withdrawn ? '没能把电脑接上，这一步已经撤回，可以再试一次。' : '没能把电脑接上，也没能撤回干净：请到每只猫的资料里确认「可以用这台电脑」是关着的。',
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
    // No entry, or only the placeholder: no cat can be handed the tools. A driver started for a switch-on that was given up
    // (the owner stopped waiting for the macOS grants) has nothing to do: it is asked to end. A cat the computer was taken
    // from earlier, with a turn not seen to end, is asked to stop all the same.
    if (read && !this.real(entry)) {
      const ended = !this.lingering.has(cat.id) || await this.ended(cat.id, true);
      await this.driver.stop().catch(() => {});
      if (!ended) throw this.stillRunning();
      return this.shown(cat, entry);
    }
    let failure: unknown;
    // Remembered before the block is sent: one whose answer never comes may land after this request is over.
    this.lingering.add(cat.id);
    try {
      await this.toggle({ scope: 'cat', catId: cat.id, enabled: false });
      entry = await this.entry();
      if (this.isOn(entry, cat)) throw new ApiError(502, '没能关掉，请再试一次。');
    } catch (error) { failure = error; }
    const ended = await this.ended(cat.id, !failure);
    if (failure) throw failure;
    if (entry && !anyOn(entry)) await this.driver.stop().catch(() => {});
    if (!ended) throw this.stillRunning();
    return this.shown(cat, entry);
  }
  private stillRunning() {
    return new ApiError(502, '已经关掉了，但它正在进行的这一轮还没有停下来，停下之前它还能用这台电脑。请在对话里点停止，或者稍后再关一次。', undefined, 'computer_still_running');
  }

  /**
   * A cat is deleted. `remove` is its native deletion. A turn keeps the tools it started with, the engine does not end
   * a deleted cat's turns, and its conversation is forgotten with it. So a cat that may have the computer — it is on,
   * or the computer was taken from it and it is not done with yet, or the registry cannot be read — is not deleted
   * while it is in the middle of a turn: that turn would be left behind with the tools and nothing to find it by, and
   * the next cat switched on would be using the computer beside it. Nothing is changed for it (were it switched off
   * here and the engine then refused the deletion, it would have lost the computer without a word): the owner lets it
   * finish or stops that reply, and deletes again. Any other cat is deleted as before. Switches wait meanwhile, so a
   * cat cannot be deleted from under a hand-over.
   */
  retire<T>(cat: NativeCat, remove: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      let has: boolean | undefined;
      try { has = this.isOn(await this.entry(), cat); } catch { /* unread: it may have it */ }
      const may = has !== false || this.lingering.has(cat.id);
      if (may && await this.busy(cat.id)) throw new ApiError(409, '它这一轮可能还在用这台电脑，所以没有删除。等它做完，或在它的对话里点停止，然后再删一次。', undefined, 'computer_still_running');
      const removed = await remove();
      // A turn that began between that look and the deletion: asked to end while its conversation is still known here.
      if (may) await this.stopRunning({ id: cat.id }).catch(() => {});
      this.lingering.delete(cat.id);
      return removed;
    });
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
      return '猫猫建好了，但它现在可以用这台电脑：这项设置没能关上。到它的资料里把「可以用这台电脑」关掉就可以。';
    } catch {
      return '猫猫建好了，但没能确认它用不了这台电脑。到它的资料里看一眼「可以用这台电脑」是不是关着。';
    }
  }
}
