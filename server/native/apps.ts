import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { ProductStore } from '../product-store.js';
import type { NativeTransport } from './types.js';

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
interface NativeCapability { id: string; type: string; source?: string; enabled?: boolean; globalEnabled?: boolean; mcpServer?: NativeMcpServer }
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
export interface AppRow {
  id: string; kind: 'wechat' | 'custom'; title: string; state: AppState;
  /** Why it is not usable, in plain words. Present for `failed`, `unavailable`, and an `off` that followed a failed start. */
  reason?: string;
  /** The engine's own words for a failure, for whoever wants to diagnose. Never needed to act. */
  detail?: string;
  /** custom: what was added. Secret values never leave the engine; only their names are listed. */
  source?: { type: 'program'; program: string; args: string[]; secrets: string[] } | { type: 'url'; url: string; secrets: string[] };
  /** custom, after a check: what it offers the cats. */
  tools?: AppTool[];
  /** 微信, while on: whether cats may read right now, and until when. */
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
// The engine accepts whatever it is sent here (an empty command, any id), so the checking is done on this side.
const programApp = z.object({
  name: appName, idempotencyKey: z.uuid().optional(),
  program: z.string().trim().min(1, '请填要运行的程序').max(512).refine(oneLine, '不能含换行'),
  args: z.array(z.string().max(2048).refine(oneLine, '不能含换行')).max(32).default([]),
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
  const name = url ? headerName : envName;
  for (const key of Object.keys(given)) if (!name.safeParse(key).success) throw new ApiError(400, `「${key}」不能用作${url ? '请求头' : '变量'}的名称`);
}
export const customPatchSchema = z.object({
  name: appName.optional(),
  secrets: z.record(z.string().min(1).max(128), secretValue).refine(few, '最多 32 项').optional(),
}).strict().refine(value => value.name !== undefined || value.secrets !== undefined, '没有要改的内容');

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

/** A registry id a model can read in a tool name: the name's own letters when it has some, else a short code. */
export function nativeIdFor(name: string, taken: ReadonlySet<string>, seed?: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  const reserved = (id: string) => /^(cat-cafe|plugin)(-|$)/.test(id);
  const code = seed ? createHash('sha256').update(seed).digest('hex').slice(0, 8) : randomBytes(4).toString('hex');
  const base = /^[a-z][a-z0-9-]+$/.test(slug) && !reserved(slug) ? slug : `app-${code}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export class BotApps {
  /** Request bookkeeping: an answer that was lost and asked again finds the app it made (memory only). */
  private created = new Map<string, { nativeId: string; at: number }>();
  constructor(private native: NativeTransport, private store: ProductStore, private platform: NodeJS.Platform = process.platform) {}

  async list(): Promise<{ apps: AppRow[] }> {
    const [wechat, custom] = await Promise.all([this.wechat(), this.registry()]);
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
    return (board.items ?? []).filter(item => item.type === 'mcp' && item.source === 'external');
  }
  private async custom(id: string): Promise<NativeCapability> {
    const nativeId = id.startsWith('custom:') ? id.slice(7) : '';
    const entry = nativeId ? (await this.registry()).find(item => item.id === nativeId) : undefined;
    if (!entry) throw new ApiError(404, '没有这个应用');
    return entry;
  }
  private title(nativeId: string): string { return this.store.state.apps?.[nativeId]?.title ?? nativeId; }
  private customRow(entry: NativeCapability): AppRow {
    const off = (entry.globalEnabled ?? entry.enabled ?? true) === false;
    return { id: customId(entry.id), kind: 'custom', title: this.title(entry.id), state: off ? 'off' : 'unchecked',
      ...(off ? { reason: '已停用' } : {}), source: sourceOf(entry.mcpServer) };
  }
  /** Asks the engine to start or reach the server once and list its tools; the answer is the state. */
  private async checked(entry: NativeCapability, known?: NativeProbe | null): Promise<AppRow> {
    const row = this.customRow(entry);
    if (row.state === 'off') return row;
    const probe = known ?? await this.native.request<NativeProbe>(`/api/mcp/${encode(entry.id)}/tools`, { method: 'POST', body: {} });
    if (probe.connectionStatus === 'connected') return { ...row, state: 'on', tools: (probe.tools ?? []).map(tool => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })) };
    if (probe.connectionStatus !== 'disconnected') return { ...row, state: 'unchecked', reason: '没能检查' };
    return { ...row, state: 'failed', reason: probeReason(probe.error, row.source), ...(probe.error ? { detail: probe.error.slice(0, 400) } : {}) };
  }
  async addCustom(input: CustomAppInput): Promise<AppRow> {
    const replay = input.idempotencyKey && this.created.get(input.idempotencyKey);
    const existing = await this.registry();
    if (replay) {
      const entry = existing.find(item => item.id === replay.nativeId);
      if (entry) return this.checked(entry);
    }
    // The engine neither checks an id nor refuses one that is taken (it merges into it), so both happen here.
    const taken = new Set(existing.map(item => item.id));
    const nativeId = nativeIdFor(input.name, taken, input.idempotencyKey);
    const body = 'url' in input
      ? { id: nativeId, transport: 'streamableHttp', url: input.url, ...(Object.keys(input.secrets).length ? { headers: input.secrets } : {}) }
      : { id: nativeId, transport: 'stdio', command: input.program, args: input.args, ...(Object.keys(input.secrets).length ? { env: input.secrets } : {}) };
    const installed = await this.native.request<{ ok?: boolean; capability?: NativeCapability; probe?: NativeProbe | null }>(
      '/api/capabilities/mcp/install', { method: 'POST', body });
    if (!installed.ok || !installed.capability) throw new ApiError(502, '没能添加，请再试一次');
    // From here the app exists in the engine. The name is display metadata; a failure to keep it must not hide that.
    (this.store.state.apps ??= {})[nativeId] = { title: input.name };
    this.store.save();
    if (input.idempotencyKey) {
      const now = Date.now();
      for (const [key, made] of this.created) if (now - made.at > 600_000) this.created.delete(key);
      this.created.set(input.idempotencyKey, { nativeId, at: now });
    }
    // The install answer carries no env key list and, for a URL, no probe: read the row back and check it.
    const entry = (await this.registry()).find(item => item.id === nativeId) ?? installed.capability;
    return this.checked(entry, installed.probe?.connectionStatus === 'connected' ? installed.probe : undefined);
  }
  async patchCustom(id: string, input: z.infer<typeof customPatchSchema>): Promise<AppRow> {
    const entry = await this.custom(id);
    if (input.secrets && Object.keys(input.secrets).length) {
      const url = !!entry.mcpServer?.url;
      secretNames(input.secrets, url);
      // Both calls merge into what is stored: named secrets are replaced or added, the rest stay.
      if (url) await this.native.request('/api/capabilities/mcp/install', { method: 'POST', body: { id: entry.id, headers: input.secrets } });
      else await this.native.request(`/api/capabilities/mcp/${encode(entry.id)}/env`, { method: 'PATCH', body: { env: input.secrets } });
    }
    if (input.name !== undefined) { (this.store.state.apps ??= {})[entry.id] = { title: input.name }; this.store.save(); }
    return this.checked((await this.registry()).find(item => item.id === entry.id) ?? entry);
  }
  async removeCustom(id: string): Promise<{ removed: true }> {
    const entry = await this.custom(id);
    await this.native.request(`/api/capabilities/mcp/${encode(entry.id)}?hard=true`, { method: 'DELETE' });
    if (this.store.state.apps?.[entry.id]) { delete this.store.state.apps[entry.id]; this.store.save(); }
    return { removed: true };
  }

  // ---- 微信: the official plugin, through the plugin manager ------------------------------------------
  private async plugin(): Promise<NativePlugin | undefined> {
    try { return (await this.native.request<{ plugin?: NativePlugin }>(`/api/plugin-manager/plugins/_local/${WECHAT_PLUGIN}`)).plugin; }
    catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
  }
  private async action(name: 'arm' | 'disarm' | 'status'): Promise<AppRow['authorization']> {
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
    const base = { id: 'wechat', kind: 'wechat' as const, title: '微信' };
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
    // Running. Whether cats may read right now is the plugin's own answer; without it nothing is claimed.
    try { return { ...base, ...about, state: 'on', authorization: await this.action('status') }; }
    catch { return { ...base, ...about, state: 'on', authorization: { active: false, remaining_ms: 0 } }; }
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
        const native = error instanceof ApiError ? error : undefined;
        // Someone else changed it between the read and the write: look again, once.
        if (native?.status === 409 && (native.details as { code?: string } | undefined)?.code === 'STALE_REVISION' && attempt === 0) continue;
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
