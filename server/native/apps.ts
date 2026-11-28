import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { ProductStore } from '../product-store.js';
import type { NativeCat, NativeTransport } from './types.js';
import { computerEntry } from './computer.js';
import { noIcons, type AppIcons } from './app-icons.js';

// 应用 (docs/apps-api.md): a listing over two native mechanisms, with nothing of its own behind it.
//   · 微信  = the engine's official plugin `official.wechat-visible-reader`, through the plugin manager:
//            read, enable/disable, and its declared operation (a short-lived reading authorization).
//   · 自定义 = an external MCP server in the engine's capability registry: install, probe, update secrets, remove.
// What is installed, running or authorized is always read back from the engine. The only thing kept here
// is the name the owner gave a custom app (display metadata, next to the native id it belongs to).

export const WECHAT_PLUGIN = 'official.wechat-visible-reader';
const WECHAT_OPERATION = 'visibleReadingAuthorization';
/** What the engine sends in place of a stored secret; never written back. */
const MASK = '••••••';
const encode = encodeURIComponent;

interface NativeMcpServer {
  transport?: string; command?: string; args?: string[]; url?: string;
  env?: Record<string, string>; headers?: Record<string, string>; envKeys?: string[];
}
interface NativeCapability {
  id: string; type: string; source?: string; enabled?: boolean; globalEnabled?: boolean;
  mcpServer?: NativeMcpServer; cats?: Record<string, boolean>; blockedCats?: string[];
}
interface NativeProbe { connectionStatus?: string; tools?: Array<{ name: string; description?: string }>; error?: string }
interface NativePlugin {
  pluginId: string; artifact?: string; intent?: string; live?: string; lifecycleRevision?: number; installedVersion?: string;
  actions?: { setEnabled?: boolean; blockingReasons?: string[] };
  diagnostic?: { code?: string; message?: string } | null; activationFailed?: boolean | null;
  configFields?: Array<{ key: string; kind?: string; description?: string }>;
}
interface NativeAuthorization { data?: { armed?: boolean; remainingMs?: number; expiresAt?: string } }

/** `unchecked`: a custom app that is in the registry; whether it answers is only known after a check (the detail read). */
export type AppState = 'off' | 'starting' | 'on' | 'failed' | 'unavailable' | 'unchecked';
export interface AppTool { name: string; description?: string }
export interface AppCat {
  name: string; enabled: boolean;
  avatar?: 'custom' | 'generated'; avatar_seed?: string; avatar_url?: string; templateId?: string;
  accent?: { primary: string; secondary: string };
}
export interface AppRow {
  id: string; kind: 'wechat' | 'custom'; title: string; state: AppState;
  /** 微信: where its picture is served — the icon of the 微信 installed on this computer. Absent when there is none to show. */
  icon?: string;
  /** Why it is not usable, in plain words. Present for `failed`, `unavailable`, and an `off` that followed a failed start. */
  reason?: string;
  /** The engine's own words for a failure, for whoever wants to diagnose. Never needed to act. */
  detail?: string;
  /** custom: what was added. Secret values never leave the engine; only their names are listed. */
  source?: { type: 'program'; program: string; args: string[]; secrets: string[] } | { type: 'url'; url: string; secrets: string[] };
  /** custom, after a check: what it offers the cats. */
  tools?: AppTool[];
  /** custom detail: current cats and whether each may use this app, read back from the engine. Absent if cats could not be read. */
  cats?: AppCat[];
  /** 微信, while on: the plugin's ten-minute authorization (for reading the chat that is open in 微信), as the
   *  plugin answered it. Absent while `on`: it could not be read — unknown, never "not authorized". */
  authorization?: { active: boolean; until?: string; remaining_ms: number };
  /** 微信: the plugin's own privacy statement, word for word, and the version it came from. */
  disclosure?: string;
  version?: string;
}

const oneLine = (value: string) => !/[\0\r\n]/.test(value);
const few = (value: Record<string, string>) => Object.keys(value).length <= 32;
const secretValue = z.string().min(1).max(8192).refine(value => oneLine(value) && !value.includes(MASK), '密钥的值无效');
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/);
const appName = z.string().trim().min(1, '请起个名字').max(40);
const remote = z.string().trim().max(2048).refine(value => {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}, '网址需要以 https:// 开头（本机地址可以用 http://），且不带用户名密码');
const programField = z.string().trim().min(1, '请填要运行的程序').max(512).refine(oneLine, '不能含换行');
const argsField = z.array(z.string().max(2048).refine(oneLine, '不能含换行')).max(32);
// The engine accepts whatever it is sent here (an empty command, any id), so the checking is done on this side.
const programApp = z.object({
  name: appName, idempotencyKey: z.uuid().optional(),
  program: programField,
  args: argsField.default([]),
  secrets: z.record(z.string(), secretValue).refine(few, '最多 32 项').default({}),
}).strict();
const urlApp = z.object({
  name: appName, idempotencyKey: z.uuid().optional(),
  url: remote, secrets: z.record(z.string(), secretValue).refine(few, '最多 32 项').default({}),
}).strict();
export type CustomAppInput = z.infer<typeof programApp> | z.infer<typeof urlApp>;
/** A program on this computer, or an address: exactly one of the two. */
export function parseCustomApp(body: unknown): CustomAppInput {
  const given = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const program = given.program !== undefined, url = given.url !== undefined;
  if (program === url) throw new ApiError(400, '请填要运行的程序，或者一个网址（二选一）');
  const input = url ? urlApp.parse(body) : programApp.parse(body);
  secretNames(input.secrets, url);
  return input;
}
/** A program's secrets are environment variables, an address's are request headers; each has its own rule for names. */
function secretNames(given: Record<string, string>, url: boolean): void {
  const name = url ? headerName : envName, seen = new Set<string>();
  for (const key of Object.keys(given)) {
    if (!name.safeParse(key).success) throw new ApiError(400, `「${key}」不能用作${url ? '请求头' : '变量'}的名称`);
    // A header's name is the same name in any case; two spellings would both be sent and joined into one value.
    const same = url ? key.toLowerCase() : key;
    if (seen.has(same)) throw new ApiError(400, `「${key}」重复了（请求头的名称不分大小写）`);
    seen.add(same);
  }
}
export const customPatchSchema = z.object({
  name: appName.optional(),
  program: programField.optional(),
  args: argsField.optional(),
  url: remote.optional(),
  secrets: z.record(z.string().min(1).max(128), secretValue).refine(few, '最多 32 项').optional(),
}).strict().refine(
  value => value.name !== undefined || value.program !== undefined || value.args !== undefined || value.url !== undefined || value.secrets !== undefined,
  '没有要改的内容',
);
export const customEnabledSchema = z.object({ enabled: z.boolean() }).strict();

const customId = (nativeId: string) => `custom:${nativeId}`;
const sourceOf = (server: NativeMcpServer | undefined): AppRow['source'] => server?.url
  ? { type: 'url', url: server.url, secrets: Object.keys(server.headers ?? {}) }
  : { type: 'program', program: server?.command ?? '', args: server?.args ?? [], secrets: server?.envKeys ?? Object.keys(server?.env ?? {}) };

/** The engine's probe error, said plainly. The original goes out as `detail`. */
export function probeReason(error: string | undefined, source: AppRow['source']): string {
  const said = error ?? '';
  if (/ENOENT/.test(said)) return source?.type === 'program' ? `这台电脑上找不到「${source.program}」` : '找不到要运行的程序';
  if (/EACCES/.test(said)) return '没有权限运行这个程序';
  if (/timeout/i.test(said)) return '几秒内没有回应';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(said)) return '对方拒绝了，密钥可能不对';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|certificate/i.test(said)) return '连不上这个网址';
  return '没连上';
}

/** What of a probe error may leave as `detail`: only fragments that cannot carry a secret. The engine's error can
 *  quote the answering server's own response body, and a server may echo the credential it was sent — so the raw
 *  text never goes out; the reason above is derived from it, and this is what is left for diagnosing. */
/** Every code named here is a fixed word: nothing in the pattern is open-ended (no wildcard, no unbounded number),
 *  so a matched fragment is one of a finite set and cannot be something the answering server made up. */
const DIAGNOSTIC = new RegExp(String.raw`\bHTTP \d{3}\b|\bstatus code \(?\d{3}\b\)?|\bMCP error -?\d{1,5}\b|\bConnection closed\b|\bfetch failed\b|\b[Tt]imed? ?out\b|\b(?:${[
  'ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID',
].join('|')})\b`, 'g');
export function probeDetail(error: string | undefined): string | undefined {
  const found = new Set<string>();
  for (const [part] of (error ?? '').matchAll(DIAGNOSTIC)) found.add(part);
  return found.size ? [...found].join(' · ') : undefined;
}

/** The code at the end of every id this adapter gives: the request's own (from its idempotency key) or a random one. */
const idCode = (seed?: string) => seed ? createHash('sha256').update(seed).digest('hex').slice(0, 8) : randomBytes(4).toString('hex');
/** A registry id a model can read in a tool name: the name's own letters when it has some, then a code that makes
 *  it this request's alone. The engine merges an install into an id that exists, so an id is never one a second
 *  request (in this process or another) could also arrive at; the same request asked again arrives at the same id. */
export function nativeIdFor(name: string, code: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
  const reserved = /^(cat-cafe|plugin)(-|$)/.test(slug);
  return `${/^[a-z][a-z0-9-]*$/.test(slug) && !reserved ? slug : 'app'}-${code}`;
}
/** Is this registry row what that request asked for? (Secret values cannot be compared: the engine never returns them.) */
function sameRequest(entry: NativeCapability, input: CustomAppInput): boolean {
  const server = entry.mcpServer ?? {}, names = (list: string[], fold: boolean) => list.map(name => fold ? name.toLowerCase() : name).sort().join('\n');
  if ('url' in input) return server.url === input.url && names(Object.keys(server.headers ?? {}), true) === names(Object.keys(input.secrets), true);
  return !server.url && server.command === input.program && JSON.stringify(server.args ?? []) === JSON.stringify(input.args)
    && names(server.envKeys ?? Object.keys(server.env ?? {}), false) === names(Object.keys(input.secrets), false);
}

export class BotApps {
  /** Two steps that must not interleave run one after another: picking a free id then installing it; clearing the operation state then acting. */
  private adding: Promise<unknown> = Promise.resolve();
  private acting: Promise<unknown> = Promise.resolve();
  private appLanes = new Map<string, Promise<unknown>>();
  private inTurn<T>(lane: 'adding' | 'acting', work: () => Promise<T>): Promise<T> {
    const run = this[lane].then(work, work);
    this[lane] = run.catch(() => undefined);
    return run;
  }
  private inAppTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
    const key = id.startsWith('custom:') ? id : `custom:${id}`;
    const run = (this.appLanes.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined).then(() => {
      if (this.appLanes.get(key) === tail) this.appLanes.delete(key);
    });
    this.appLanes.set(key, tail);
    return run;
  }
  constructor(private native: NativeTransport, private store: ProductStore, private platform: NodeJS.Platform = process.platform,
    private icons: AppIcons = noIcons) {}

  /** 微信 as it is named and pictured, whatever state it is in. A picture that cannot be found is simply not offered. */
  private async wechatBase(): Promise<{ id: 'wechat'; kind: 'wechat'; title: string; icon?: string }> {
    const mark = await this.icons.wechatMark().catch(() => undefined);
    return { id: 'wechat', kind: 'wechat', title: '微信', ...(mark ? { icon: `/xbot-api/apps/wechat/icon?v=${encode(mark)}` } : {}) };
  }
  /** The picture itself (PNG), or undefined. */
  wechatIcon(): Promise<Buffer | undefined> { return this.icons.wechat().catch(() => undefined); }

  async list(): Promise<{ apps: AppRow[] }> {
    // 微信 that cannot be read must not take the owner's other apps off the screen: it is listed as it is — not readable.
    const unread = async (): Promise<AppRow> => ({ ...await this.wechatBase(), state: 'unavailable', reason: '没能读到它的状态' });
    const [wechat, custom] = await Promise.all([this.wechat().catch(unread), this.registry()]);
    return { apps: [wechat, ...custom.map(entry => this.customRow(entry))] };
  }
  async detail(id: string): Promise<AppRow> {
    if (id === 'wechat') return this.wechat();
    const entry = await this.custom(id);
    return this.checked(entry);
  }

  // ---- 自定义应用: the engine's external MCP registry -----------------------------------------------
  private async registry(): Promise<NativeCapability[]> {
    const board = await this.native.request<{ items?: NativeCapability[] }>('/api/capabilities');
    // 这台电脑's entry lives in the same registry (server/native/computer.ts) and has its own switch in a cat's 资料:
    // it is not one of the owner's apps — not listed, not renamed, not removed from here.
    return (board.items ?? []).filter(item => item.type === 'mcp' && item.source === 'external' && item.id !== computerEntry);
  }
  private async custom(id: string): Promise<NativeCapability> {
    const nativeId = id.startsWith('custom:') ? id.slice(7) : '';
    const entry = nativeId ? (await this.registry()).find(item => item.id === nativeId) : undefined;
    if (!entry) throw new ApiError(404, '没有这个应用');
    return entry;
  }
  private title(nativeId: string): string { return this.store.state.apps?.[nativeId]?.title ?? nativeId; }
  /** Keeps the name the owner gave (display metadata). `false`: it could not be written, and is not kept in memory
   *  either — what is shown is what will still be there after a restart. */
  private keepTitle(nativeId: string, title: string | undefined): boolean {
    const apps = this.store.state.apps ??= {}, before = apps[nativeId];
    if (title === undefined) delete apps[nativeId]; else apps[nativeId] = { title };
    try { this.store.save(); return true; }
    catch (error) {
      if (before) apps[nativeId] = before; else delete apps[nativeId];
      console.warn(`应用：没能保存「${nativeId}」的名字：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  private async nativeCats(): Promise<NativeCat[] | undefined> {
    try {
      const res = await this.native.request<{ cats?: NativeCat[] }>('/api/cats');
      return Array.isArray(res.cats) ? res.cats : [];
    } catch {
      return undefined;
    }
  }
  private catsOf(entry: NativeCapability, nativeCats: NativeCat[] | undefined): AppCat[] | undefined {
    if (!nativeCats) return undefined;
    const globalOn = (entry.globalEnabled ?? entry.enabled ?? true) !== false;
    const hex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
    return nativeCats.map(cat => {
      const allowed = entry.cats && typeof entry.cats[cat.id] === 'boolean'
        ? entry.cats[cat.id] === true
        : !(entry.blockedCats?.includes(cat.id) ?? false);
      const meta = this.store.bot(cat.id);
      const accent = hex(cat.color?.primary) && hex(cat.color?.secondary)
        ? { primary: cat.color.primary, secondary: cat.color.secondary }
        : undefined;
      return {
        name: cat.name,
        enabled: globalOn && allowed,
        avatar: meta.avatarData ? 'custom' : 'generated',
        avatar_seed: meta.avatarSeed ?? `cat:${meta.templateId ?? cat.breedId ?? 'ragdoll'}`,
        avatar_url: meta.avatarData ? `/xbot-api/bots/${encode(cat.name)}/avatar?v=${meta.avatarUpdated}` : '',
        templateId: meta.templateId ?? cat.breedId ?? 'ragdoll',
        ...(accent ? { accent } : {}),
      };
    });
  }
  private customRow(entry: NativeCapability): AppRow {
    const off = (entry.globalEnabled ?? entry.enabled ?? true) === false;
    return { id: customId(entry.id), kind: 'custom', title: this.title(entry.id), state: off ? 'off' : 'unchecked',
      ...(off ? { reason: '已停用' } : {}), source: sourceOf(entry.mcpServer) };
  }
  /** Asks the engine to start or reach the server once and list its tools; the answer is the state.
   *  `after`: this follows a change the engine has already made — a check that cannot be made is then said as
   *  such (`unchecked`), never as a failure of the change. */
  private async checked(entry: NativeCapability, known?: NativeProbe | null, after = false): Promise<AppRow> {
    const row = this.customRow(entry);
    if (row.state === 'off') {
      const cats = this.catsOf(entry, await this.nativeCats());
      return { ...row, ...(cats !== undefined ? { cats } : {}) };
    }
    const catsPromise = this.nativeCats();
    let probe: NativeProbe;
    try {
      probe = known ?? await this.native.request<NativeProbe>(`/api/mcp/${encode(entry.id)}/tools`, { method: 'POST', body: {} });
    } catch (error) {
      if (!after) { await catsPromise.catch(() => undefined); throw error; }
      const cats = this.catsOf(entry, await catsPromise);
      return { ...row, state: 'unchecked', reason: '没能检查', ...(cats !== undefined ? { cats } : {}) };
    }
    const cats = this.catsOf(entry, await catsPromise);
    const catsField = cats !== undefined ? { cats } : {};
    if (probe.connectionStatus === 'connected') return { ...row, state: 'on', tools: (probe.tools ?? []).map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })), ...catsField };
    if (probe.connectionStatus !== 'disconnected') return { ...row, state: 'unchecked', reason: '没能检查', ...catsField };
    const detail = probeDetail(probe.error);
    return { ...row, state: 'failed', reason: probeReason(probe.error, row.source), ...(detail ? { detail } : {}), ...catsField };
  }
  /** The row as the engine has it now; when that cannot be read, the one in hand. */
  private async reread(entry: NativeCapability): Promise<NativeCapability> {
    try { return (await this.registry()).find(item => item.id === entry.id) ?? entry; } catch { return entry; }
  }
  /** Strict readback after a toggle write: never falls back to the stale pre-write entry. */
  private async readback(nativeId: string, failureMessage: string): Promise<NativeCapability> {
    let found: NativeCapability | undefined;
    try { found = (await this.registry()).find(item => item.id === nativeId); }
    catch { throw new ApiError(502, failureMessage); }
    if (!found) throw new ApiError(404, '没有这个应用');
    return found;
  }
  addCustom(input: CustomAppInput): Promise<AppRow> { return this.inTurn('adding', () => this.install(input)); }
  private async install(input: CustomAppInput): Promise<AppRow> {
    const existing = await this.registry(), code = idCode(input.idempotencyKey);
    if (input.idempotencyKey) {
      // The same request asked again (its answer was lost, or this adapter restarted): its id ends in the same
      // code, so the app it already made is found in the engine itself — nothing is remembered here.
      const earlier = existing.find(item => item.id.endsWith(`-${code}`));
      if (earlier) {
        if (!sameRequest(earlier, input)) throw new ApiError(409, '这次提交和之前的一次用了同一个标识，内容却不一样，请重新提交', undefined, 'idempotency_conflict');
        if (!this.store.state.apps?.[earlier.id]) this.keepTitle(earlier.id, input.name);
        return this.checked(earlier, undefined, true);
      }
    }
    // The engine neither checks an id nor refuses one that is taken (it merges into it), so both happen here.
    let nativeId = nativeIdFor(input.name, code);
    while (existing.some(item => item.id === nativeId)) nativeId = nativeIdFor(input.name, idCode());
    const body = 'url' in input
      ? { id: nativeId, transport: 'streamableHttp', url: input.url, ...(Object.keys(input.secrets).length ? { headers: input.secrets } : {}) }
      : { id: nativeId, transport: 'stdio', command: input.program, args: input.args, ...(Object.keys(input.secrets).length ? { env: input.secrets } : {}) };
    const installed = await this.native.request<{ ok?: boolean; capability?: NativeCapability; probe?: NativeProbe | null }>(
      '/api/capabilities/mcp/install', { method: 'POST', body });
    if (!installed.ok || !installed.capability) throw new ApiError(502, '没能添加，请再试一次');
    // From here the app exists in the engine, and nothing below may turn that into "could not add": a name that
    // cannot be kept leaves it shown by its id, a row that cannot be read back is the one the install answered,
    // a check that cannot be made is `unchecked`.
    this.keepTitle(nativeId, input.name);
    // The install answer carries no env key list and, for a URL, no probe: read the row back and check it.
    const entry = await this.reread(installed.capability);
    return this.checked(entry, installed.probe?.connectionStatus === 'connected' ? installed.probe : undefined, true);
  }
  patchCustom(id: string, input: z.infer<typeof customPatchSchema>): Promise<AppRow> {
    return this.inAppTurn(id, async () => {
      const entry = await this.custom(id);
      const isUrl = !!entry.mcpServer?.url;
      if (isUrl && (input.program !== undefined || input.args !== undefined)) throw new ApiError(400, '网址型应用不能修改程序或参数');
      if (!isUrl && input.url !== undefined) throw new ApiError(400, '本机程序型应用不能修改网址');
      if (!isUrl && (entry.globalEnabled ?? entry.enabled ?? true) === false && (input.program !== undefined || input.args !== undefined)) {
        throw new ApiError(409, '应用已停用，请先启用后再修改程序', undefined, 'app_disabled');
      }
      const hasSecrets = !!(input.secrets && Object.keys(input.secrets).length);
      if (hasSecrets) secretNames(input.secrets!, isUrl);

      let changed = false;
      let installed: { ok?: boolean; capability?: NativeCapability; probe?: NativeProbe | null } | undefined;
      if (isUrl) {
        // A header is replaced under the spelling it is stored with; another case would be kept beside it and both sent.
        const stored = new Map(Object.keys(entry.mcpServer?.headers ?? {}).map(name => [name.toLowerCase(), name]));
        const headers = hasSecrets
          ? Object.fromEntries(Object.entries(input.secrets!).map(([name, value]) => [stored.get(name.toLowerCase()) ?? name, value]))
          : undefined;
        if (input.url !== undefined || headers) {
          installed = await this.native.request<{ ok?: boolean; capability?: NativeCapability; probe?: NativeProbe | null }>(
            '/api/capabilities/mcp/install',
            { method: 'POST', body: { id: entry.id, ...(input.url !== undefined ? { transport: 'streamableHttp', url: input.url } : {}), ...(headers ? { headers } : {}) } },
          );
          changed = true;
        }
      } else if (input.program !== undefined || input.args !== undefined) {
        installed = await this.native.request<{ ok?: boolean; capability?: NativeCapability; probe?: NativeProbe | null }>(
          '/api/capabilities/mcp/install',
          {
            method: 'POST',
            body: {
              id: entry.id,
              transport: 'stdio',
              ...(input.program !== undefined ? { command: input.program } : {}),
              ...(input.args !== undefined ? { args: input.args } : {}),
              ...(hasSecrets ? { env: input.secrets } : {}),
            },
          },
        );
        changed = true;
      } else if (hasSecrets) {
        await this.native.request(`/api/capabilities/mcp/${encode(entry.id)}/env`, { method: 'PATCH', body: { env: input.secrets } });
        changed = true;
      }
      // The name alone could not be kept: nothing changed, and that is the answer. After the engine has taken the
      // config/secrets it is not — the row comes back with the name it still has.
      if (input.name !== undefined && !this.keepTitle(entry.id, input.name) && !changed) throw new ApiError(500, '名字没能保存，请再试一次');
      const current = await this.reread(installed?.capability ?? entry);
      return this.checked(current, installed?.probe?.connectionStatus === 'connected' ? installed.probe : undefined, changed);
    });
  }
  setCustomEnabled(id: string, enabled: boolean): Promise<AppRow> {
    return this.inAppTurn(id, async () => {
      const entry = await this.custom(id);
      await this.native.request('/api/capabilities', {
        method: 'PATCH',
        body: { capabilityId: entry.id, capabilityType: 'mcp', source: 'external', scope: 'global', enabled },
      });
      const after = await this.readback(entry.id, '没能确认应用开关状态，请再试一次');
      const actual = (after.globalEnabled ?? after.enabled ?? true) !== false;
      if (actual !== enabled) throw new ApiError(502, enabled ? '没能启用，请再试一次' : '没能停用，请再试一次');
      return this.checked(after, undefined, true);
    });
  }
  setCustomCatEnabled(id: string, catName: string, enabled: boolean): Promise<AppRow> {
    return this.inAppTurn(id, async () => {
      const [entry, catsRes] = await Promise.all([
        this.custom(id),
        this.native.request<{ cats?: NativeCat[] }>('/api/cats'),
      ]);
      const cat = (catsRes.cats ?? []).find(c => c.name === catName || c.id === catName);
      if (!cat) throw new ApiError(404, '找不到这只猫猫');
      if ((entry.globalEnabled ?? entry.enabled ?? true) === false) {
        throw new ApiError(409, '应用已停用，请先启用应用', undefined, 'app_disabled');
      }
      await this.native.request('/api/capabilities', {
        method: 'PATCH',
        body: { capabilityId: entry.id, capabilityType: 'mcp', source: 'external', scope: 'cat', catId: cat.id, enabled },
      });
      const after = await this.readback(entry.id, '没能确认这只猫的开关状态，请再试一次');
      const globalOn = (after.globalEnabled ?? after.enabled ?? true) !== false;
      const catAllowed = after.cats && typeof after.cats[cat.id] === 'boolean'
        ? after.cats[cat.id] === true
        : !(after.blockedCats?.includes(cat.id) ?? false);
      if ((globalOn && catAllowed) !== enabled) {
        throw new ApiError(502, enabled ? '没能为这只猫启用，请再试一次' : '没能为这只猫停用，请再试一次');
      }
      return this.checked(after, undefined, true);
    });
  }
  removeCustom(id: string): Promise<{ removed: true }> {
    return this.inAppTurn(id, async () => {
      const entry = await this.custom(id);
      await this.native.request(`/api/capabilities/mcp/${encode(entry.id)}?hard=true`, { method: 'DELETE' });
      // It is gone from the engine; a name left behind names nothing (and is dropped at the next chance).
      if (this.store.state.apps?.[entry.id]) this.keepTitle(entry.id, undefined);
      return { removed: true };
    });
  }

  // ---- 微信: the official plugin, through the plugin manager ------------------------------------------
  private async plugin(): Promise<NativePlugin | undefined> {
    try { return (await this.native.request<{ plugin?: NativePlugin }>(`/api/plugin-manager/plugins/_local/${WECHAT_PLUGIN}`)).plugin; }
    catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
  }
  private action(name: 'arm' | 'disarm' | 'status'): Promise<AppRow['authorization']> { return this.inTurn('acting', () => this.act(name)); }
  private async act(name: 'arm' | 'disarm' | 'status'): Promise<AppRow['authorization']> {
    // The pinned engine hands the plugin its own step pointer (`operationState`) once any action of this
    // operation has run, and this plugin version refuses an input field it does not know — so every action
    // after the first fails ("input contains an unsupported field") until that pointer is cleared. The
    // engine's reset route clears exactly that pointer and nothing of the plugin's (the authorization is kept:
    // reset → status after an arm still reads armed; checked on the isolated runtime, 2026-11-26). The Bot does
    // not use the pointer: what it shows comes from each action's answer.
    await this.native.request(`/api/plugins/${WECHAT_PLUGIN}/operations/${WECHAT_OPERATION}/reset`, { method: 'POST', body: {} });
    const answer = await this.native.request<NativeAuthorization>(`/api/plugins/${WECHAT_PLUGIN}/actions/${WECHAT_OPERATION}/${name}`, { method: 'POST', body: {} });
    const data = answer.data ?? {}, remaining = Number.isFinite(data.remainingMs) ? Math.max(0, Number(data.remainingMs)) : 0;
    return { active: data.armed === true && remaining > 0, remaining_ms: data.armed === true ? remaining : 0, ...(data.armed === true && data.expiresAt ? { until: data.expiresAt } : {}) };
  }
  /** `known`: a plugin record just read (`null` when the engine has none), to avoid reading it twice. */
  async wechat(known?: NativePlugin | null): Promise<AppRow> {
    const base = await this.wechatBase();
    if (this.platform !== 'darwin') return { ...base, state: 'unavailable', reason: '只在 Mac 上能用' };
    const plugin = known === undefined ? await this.plugin() : known;
    if (!plugin || plugin.artifact === 'absent' || plugin.artifact === 'staged') return { ...base, state: 'unavailable', reason: '这台电脑上还没有它的程序包' };
    if (plugin.artifact === 'quarantined') return { ...base, state: 'unavailable', reason: '它的程序包没有通过校验' };
    const disclosure = plugin.configFields?.find(field => field.key === WECHAT_OPERATION)?.description;
    const about = { ...(disclosure ? { disclosure } : {}), ...(plugin.installedVersion ? { version: plugin.installedVersion } : {}) };
    const failure = plugin.diagnostic?.code ? { detail: [plugin.diagnostic.code, plugin.diagnostic.message].filter(Boolean).join(' · ').slice(0, 400) } : {};
    if (plugin.intent !== 'enabled') {
      if (plugin.actions?.setEnabled === false) return { ...base, ...about, state: 'unavailable', reason: '现在还不能打开', ...(plugin.actions.blockingReasons?.length ? { detail: plugin.actions.blockingReasons.join(' · ') } : {}) };
      return { ...base, ...about, state: 'off', ...(plugin.activationFailed ? { reason: '上次没能启动', ...failure } : {}) };
    }
    if (plugin.live === 'starting' || plugin.live === 'handshaking') return { ...base, ...about, state: 'starting' };
    if (plugin.live !== 'running' && plugin.live !== 'degraded') return { ...base, ...about, state: 'failed', reason: '没能启动', ...failure };
    // Running. The ten-minute authorization is the plugin's own answer; without an answer nothing is claimed —
    // not "not authorized" either, since a grant made earlier may still be running.
    try { return { ...base, ...about, state: 'on', authorization: await this.action('status') }; }
    catch { return { ...base, ...about, state: 'on' }; }
  }
  /** One native `set-enabled`, with the revision the engine asks for. Resolves to the state read back afterwards. */
  private async setEnabled(enabled: boolean): Promise<AppRow> {
    const reached = (row: AppRow) => enabled ? row.state === 'on' || row.state === 'starting' : row.state === 'off';
    for (let attempt = 0; ; attempt++) {
      const plugin = await this.plugin() ?? null, now = await this.wechat(plugin);
      if (now.state === 'unavailable' || !plugin) throw new ApiError(409, now.reason ?? '现在用不了', undefined, 'app_unavailable');
      if (reached(now)) return now;
      try {
        await this.native.request(`/api/plugin-manager/plugins/${WECHAT_PLUGIN}/set-enabled`, { method: 'POST', body: { enabled, expectedRevision: plugin.lifecycleRevision } });
      } catch (error) {
        const native = error instanceof ApiError ? error : undefined, code = (native?.details as { code?: string } | undefined)?.code;
        // Someone else changed it between the read and the write: look again, once.
        if (native?.status === 409 && code === 'STALE_REVISION' && attempt === 0) continue;
        // The engine tried and the start failed. It has recorded that itself (and turned the plugin back off);
        // the answer is the state it left, which says so — not an error on top of it.
        if (enabled && code === 'RUNTIME_START_FAILED') return this.wechat();
        // A first start installs the plugin's dependencies and can outlast one request. The engine goes on;
        // what it is doing now is read back and reported as it is, never as done.
        if (native?.status !== 503) throw error;
        const after = await this.wechat();
        if (reached(after)) return after;
        throw error;
      }
      return this.wechat();
    }
  }
  /** A start that failed leaves the engine's record at "enabled, not running": turn it off first, then on again. */
  async connectWechat(): Promise<AppRow> {
    if ((await this.wechat()).state === 'failed') await this.setEnabled(false);
    return this.setEnabled(true);
  }
  disconnectWechat(): Promise<AppRow> { return this.setEnabled(false); }
  /** The plugin's own declared action: reading is allowed for ten minutes, then ends by itself. */
  async authorizeWechat(allow: boolean): Promise<AppRow> {
    const now = await this.wechat();
    if (now.state !== 'on') throw new ApiError(409, now.state === 'starting' ? '还在启动，稍等一下' : '先打开微信这个应用', undefined, 'app_not_on');
    const authorization = await this.action(allow ? 'arm' : 'disarm');
    return { ...now, authorization };
  }
}
