import { ApiError } from '../errors.js';
import type { BotBridge, NativeRuntime } from './bridge.js';
import type { NativeCat } from './types.js';

// These are the native carriers the Bot adapter can bind without synthesizing
// launcher arguments or plugin profiles. Other discovered runtimes stay visible.
export function supportsRuntime(runtime: NativeRuntime): boolean {
  return ({ codex: 'openai', claude: 'anthropic', kimi: 'kimi' } as Record<string, string>)[runtime.id] === runtime.clientId
    && !runtime.acp && !runtime.agyCarrier;
}
export function runtimeUnavailable(runtime: NativeRuntime): string | null {
  if (!runtime.installed) return '这台电脑上还没有装这个工具';
  if (!supportsRuntime(runtime)) return '这个工具的接入方式还不支持';
  if (runtime.readiness?.status === 'login_required') return '这个工具还没有登录，请先登录';
  if (runtime.readiness?.status === 'not_installed') return '这台电脑上还没有装这个工具';
  return null;
}
/**
 * Extra CLI arguments a cat's member record starts with — upstream's supported
 * per-member setting (cliConfigArgs, "额外 CLI 参数" in its member editor), not
 * a change to how the engine launches a tool.
 *
 * Claude Code ships its own scheduling (the built-in `schedule` / `loop`
 * skills and the Cron* / RemoteTrigger tools, which set up cloud routines).
 * Asked in a chat to "remind me every day at 9", a cat picked that instead of
 * the engine's scheduler, whose tools it only sees as deferred names — so
 * nothing reached the owner's confirmation, the cat's schedule list or the
 * chat. With them switched off for the member, the same sentence goes through
 * the engine's reminder tools and its confirmation (measured on the isolated
 * runtime, 2026-11-11). Codex has no scheduler of its own and needs nothing.
 */
export function memberCliArgs(clientId: string): string[] {
  return clientId === 'anthropic'
    ? ['--settings', '{"skillOverrides":{"schedule":"off","loop":"off"}}', '--disallowedTools', 'RemoteTrigger,CronCreate,CronDelete,CronList']
    : [];
}
/** The local Agent a new cat uses when the owner did not pick one: one with a login record first, else any installed and adapted one. */
export function defaultRuntime(runtimes: NativeRuntime[]): NativeRuntime | undefined {
  const usable = runtimes.filter(runtime => !runtimeUnavailable(runtime));
  return usable.find(runtime => runtime.readiness?.status === 'configured') ?? usable[0];
}
export function runtimeForCat(cat: NativeCat, runtimes: NativeRuntime[]): NativeRuntime | undefined {
  if (cat.configurationSource !== 'native_tool' || cat.accountRef || cat.agentProvider || cat.carrier === 'acp') return;
  return runtimes.find(r => supportsRuntime(r) && r.clientId === cat.clientId);
}
export function agentBinding(cat: NativeCat, runtimes: NativeRuntime[]) {
  const runtime = runtimeForCat(cat, runtimes);
  return {
    id: runtime?.id ?? null,
    label: runtime?.label ?? (cat.configurationSource === 'managed_account' || cat.accountRef ? 'Clowder AI 托管' : '其他接入方式'),
    configurationSource: cat.configurationSource ?? 'unknown',
    modelOverride: cat.defaultModel || null,
    configuredModel: runtime?.configuredModel ?? null,
  };
}

export async function agentInventory(bridge: BotBridge, refresh = false) {
  const [runtimes, cats, statuses] = await Promise.all([
    bridge.runtimes(refresh), bridge.cats(), bridge.statuses().catch(() => null),
  ]);
  return {
    checkedAt: Date.now(),
    agents: runtimes.map(runtime => {
      const bound = cats.filter(cat => runtimeForCat(cat, runtimes)?.id === runtime.id);
      const ids = new Set(bound.map(cat => cat.id));
      const activity = statuses?.bots.filter(b => ids.has(b.native_id));
      const readable = activity && activity.every(b => b.executionReadStatus === 'ready');
      const active = readable ? activity.reduce((n, b) => n + b.active.length, 0) : null;
      const queued = readable ? activity.reduce((n, b) => n + b.queued.length, 0) : null;
      const unavailableReason = runtimeUnavailable(runtime);
      return {
        id: runtime.id, label: runtime.label, clientId: runtime.clientId,
        installed: runtime.installed, supported: supportsRuntime(runtime), selectable: !unavailableReason, unavailableReason,
        command: runtime.command ?? null, transport: runtime.transport ?? null,
        configuredModel: runtime.configuredModel ?? null, configuredEffort: runtime.configuredEffort ?? null,
        readiness: { status: runtime.readiness?.status ?? (runtime.installed ? 'unknown' : 'not_installed'),
          checkedAt: runtime.readiness?.checkedAt ?? null,
          ...(runtime.readiness?.loginCommand ? { loginCommand: runtime.readiness.loginCommand } : {}) },
        bots: bound.map(cat => ({ id: cat.id, name: cat.name, configurationSource: cat.configurationSource })),
        activity: { state: active === null ? 'unknown' : active > 0 ? 'running' : 'idle', active, queued, scope: 'bot_threads' },
      };
    }),
  };
}

/**
 * What the first screen needs to know before the owner has any cat: whether a
 * chat can start right away, and if not, what is in the way. It is the native
 * discovery read in everyday terms; nothing is installed, logged in or called.
 */
export async function startSummary(bridge: BotBridge, refresh = false) {
  const [runtimes, cats] = await Promise.all([bridge.runtimes(refresh), bridge.cats()]);
  const adapted = runtimes.filter(supportsRuntime), chosen = defaultRuntime(runtimes);
  const state = (runtime: NativeRuntime) => {
    const status = runtime.readiness?.status ?? (runtime.installed ? 'unknown' : 'not_installed');
    return !runtime.installed || status === 'not_installed' ? 'missing' as const
      : status === 'login_required' ? 'login' as const : status === 'configured' ? 'ready' as const : 'unknown' as const;
  };
  const agents = adapted.map(runtime => ({ id: runtime.id, label: runtime.label, state: state(runtime),
    ...(runtime.readiness?.loginCommand ? { loginCommand: runtime.readiness.loginCommand } : {}) }));
  return {
    cats: cats.length, ready: !!chosen,
    // `confirmed` is false when the tool is installed but its login could not be checked.
    agent: chosen ? { id: chosen.id, label: chosen.label, confirmed: chosen.readiness?.status === 'configured' } : null,
    blocked: chosen ? null : agents.some(agent => agent.state === 'login') ? 'login_required' as const : 'no_agent' as const,
    agents, checkedAt: Date.now(),
  };
}

export async function bindAgent(bridge: BotBridge, cat: NativeCat, runtimeId: string) {
  const runtimes = await bridge.runtimes(true);
  const runtime = runtimes.find(r => r.id === runtimeId);
  if (!runtime) throw new ApiError(404, '找不到这个本机工具');
  const unavailable = runtimeUnavailable(runtime);
  if (unavailable) throw new ApiError(422, unavailable);
  const status = (await bridge.statuses()).bots.find(b => b.native_id === cat.id);
  if (status?.executionReadStatus !== 'ready') throw new ApiError(503, '暂时无法确认它是不是还在忙，请稍后再换工具');
  if (status?.active.length || status?.queued.length) throw new ApiError(409, '这只猫猫还在忙，等它做完或先停止，再换工具');
  const { cat: updated } = await bridge.native.request<{ cat: NativeCat }>(`/api/cats/${encodeURIComponent(cat.id)}`, {
    method: 'PATCH', body: {
      expectedRevision: cat.configurationRevision,
      clientId: runtime.clientId, configurationSource: 'native_tool', accountRef: null,
      defaultModel: '', provider: null, agentProvider: null, carrier: 'cli', acp: null,
      cliConfigArgs: memberCliArgs(runtime.clientId), cli: { ...(runtime.command ? { command: runtime.command } : {}), effort: null, serviceTier: null, defaultArgs: [] },
    },
  });
  return { name: updated.name, agent: agentBinding(updated, runtimes) };
}
