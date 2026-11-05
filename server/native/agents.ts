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
  if (!runtime.installed) return '本机尚未检测到这个 Agent';
  if (!supportsRuntime(runtime)) return '此 Agent 的接入方式尚未适配';
  if (runtime.readiness?.status === 'login_required') return '请先在本机 Agent 中完成登录';
  if (runtime.readiness?.status === 'not_installed') return '本机尚未检测到这个 Agent';
  return null;
}
export function runtimeForCat(cat: NativeCat, runtimes: NativeRuntime[]): NativeRuntime | undefined {
  if (cat.configurationSource !== 'native_tool' || cat.accountRef || cat.agentProvider || cat.carrier === 'acp') return;
  return runtimes.find(r => supportsRuntime(r) && r.clientId === cat.clientId);
}
export function agentBinding(cat: NativeCat, runtimes: NativeRuntime[]) {
  const runtime = runtimeForCat(cat, runtimes);
  return {
    id: runtime?.id ?? null,
    label: runtime?.label ?? (cat.configurationSource === 'managed_account' || cat.accountRef ? 'Clowder AI 托管接入' : '其他原生接入'),
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

export async function bindAgent(bridge: BotBridge, cat: NativeCat, runtimeId: string) {
  const runtimes = await bridge.runtimes(true);
  const runtime = runtimes.find(r => r.id === runtimeId);
  if (!runtime) throw new ApiError(404, '找不到这个本地 Agent');
  const unavailable = runtimeUnavailable(runtime);
  if (unavailable) throw new ApiError(422, unavailable);
  const status = (await bridge.statuses()).bots.find(b => b.native_id === cat.id);
  if (status?.executionReadStatus !== 'ready') throw new ApiError(503, '暂时无法确认执行状态，请稍后再更换 Agent');
  if (status?.active.length || status?.queued.length) throw new ApiError(409, '请先完成或停止这个 Bot 的任务，再更换 Agent');
  const { cat: updated } = await bridge.native.request<{ cat: NativeCat }>(`/api/cats/${encodeURIComponent(cat.id)}`, {
    method: 'PATCH', body: {
      expectedRevision: cat.configurationRevision,
      clientId: runtime.clientId, configurationSource: 'native_tool', accountRef: null,
      defaultModel: '', provider: null, agentProvider: null, carrier: 'cli', acp: null,
      cliConfigArgs: [], cli: { ...(runtime.command ? { command: runtime.command } : {}), effort: null, serviceTier: null, defaultArgs: [] },
    },
  });
  return { name: updated.name, agent: agentBinding(updated, runtimes) };
}
