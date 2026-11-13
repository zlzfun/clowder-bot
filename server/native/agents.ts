import { createHash } from 'node:crypto';
import { ApiError } from '../errors.js';
import { clip } from './text.js';
import type { BotBridge, NativeRuntime } from './bridge.js';
import type { NativeCat } from './types.js';

// These are the native carriers the Bot adapter can bind without synthesizing
// launcher arguments or plugin profiles. Other discovered runtimes stay visible.
export function supportsRuntime(runtime: NativeRuntime): boolean {
  return ({ codex: 'openai', claude: 'anthropic', kimi: 'kimi' } as Record<string, string>)[runtime.id] === runtime.clientId
    && !runtime.acp && !runtime.agyCarrier;
}
export function runtimeUnavailable(runtime: NativeRuntime): string | null {
  if (!runtime.installed) return '这台电脑上还没有装这个 Agent';
  if (!supportsRuntime(runtime)) return '这个 Agent 的接入方式还不支持';
  if (runtime.readiness?.status === 'login_required') return '这个 Agent 还没有登录，请先登录';
  if (runtime.readiness?.status === 'not_installed') return '这台电脑上还没有装这个 Agent';
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
/** The portraits of client/public/cat-avatars.js: the faces a cat can be created with. Each is one of the engine's cat templates. */
export const catFaces = ['ragdoll', 'maine-coon', 'siamese', 'turkish-van', 'dsh', 'dragon-li', 'bengal', 'golden-chinchilla'] as const;

export type Face = typeof catFaces[number];
/**
 * Which tool each face's cat thinks with. A face is one of the engine's cats, and in the engine a cat's
 * breed says which tool it runs on (the pinned upstream cat-template.json, `breeds[].variants`: 布偶猫 on
 * Claude, 缅因猫 on Codex, 暹罗猫 on Gemini through AGY, 梵花猫 on Kimi, 狸花猫 and 金渐层 on OpenCode,
 * 孟加拉猫 on Antigravity; 小鲸鱼 is the cat of the DSH runtime). Upstream's GET /api/cat-templates is, in
 * its own words, the soul layer without the client binding, so the pairing is kept here beside the faces
 * (tests/face-tools.test.ts holds it against the pinned upstream file). `client` is the breed's client in
 * that file; `runtimes` are the ids the engine's tool detection gives the tools of that client
 * (GET /api/cats/native-runtimes), most preferred first; `label` names the tool where that detection
 * does not list it at all.
 */
export const faceTools: Record<Face, { client?: string; runtimes: string[]; label: string }> = {
  ragdoll: { client: 'anthropic', runtimes: ['claude'], label: 'Claude Code' }, 'maine-coon': { client: 'openai', runtimes: ['codex'], label: 'Codex' },
  siamese: { client: 'google', runtimes: ['agy-native', 'agy-acp'], label: 'Gemini' }, 'turkish-van': { client: 'kimi', runtimes: ['kimi'], label: 'Kimi' },
  dsh: { runtimes: ['dsh'], label: 'DSH' }, 'dragon-li': { client: 'opencode', runtimes: ['opencode'], label: 'OpenCode' },
  bengal: { client: 'antigravity', runtimes: ['antigravity'], label: 'Antigravity' }, 'golden-chinchilla': { client: 'opencode', runtimes: ['opencode'], label: 'OpenCode' },
};
/** The face whose cat thinks with this tool, for a cat made without picking one. */
export function faceOfTool(runtime: NativeRuntime): Face | undefined {
  return catFaces.find(face => faceTools[face].runtimes.includes(runtime.id))
    ?? (runtime.id.startsWith('acp:') ? catFaces.find(face => faceTools[face].client === runtime.clientId) : undefined);
}
export interface FaceTool {
  /** The tool's name: the engine's own label when its detection lists the tool. */
  label: string;
  /** `ready`: can be used. `unknown`: installed, login not confirmed (worth trying). `login`: needs a login. `missing`: not on this computer. `unsupported`: the app cannot connect cats to this kind of tool yet. */
  state: 'ready' | 'unknown' | 'login' | 'missing' | 'unsupported';
  /** Why a cat cannot be made from this face as it is, in everyday words; absent when it can. */
  reason?: string;
  /** The local tool the cat would be bound to, when there is a usable one. */
  runtime?: NativeRuntime;
  loginCommand?: string;
}
/**
 * The tool a face's cat would think with on this computer, and whether a cat can be made from the face as
 * it is. A tool the app cannot connect yet is said first: installing it would not change that.
 */
export function faceTool(face: Face, runtimes: NativeRuntime[]): FaceTool {
  // Its tools as the engine's detection lists them: by their ids and, for a member the engine runs over ACP, by that
  // member's own entry (`acp:<member>`) with the breed's client — which the detection lists instead of the standalone one.
  const wanted = faceTools[face], listed = [...wanted.runtimes.flatMap(id => runtimes.filter(runtime => runtime.id === id)),
    ...runtimes.filter(runtime => !!wanted.client && runtime.clientId === wanted.client && runtime.id.startsWith('acp:'))];
  const usable = listed.find(runtime => !runtimeUnavailable(runtime));
  if (usable) return { label: usable.label, state: usable.readiness?.status === 'configured' ? 'ready' : 'unknown', runtime: usable };
  const adapted = listed.filter(supportsRuntime), label = (adapted[0] ?? listed.find(runtime => runtime.installed) ?? listed[0])?.label ?? wanted.label;
  if (!adapted.length) return { label, state: 'unsupported', reason: `暂不支持 ${label}` };
  const waiting = adapted.find(runtime => runtime.installed && runtime.readiness?.status === 'login_required');
  if (waiting) return { label, state: 'login', reason: `${label} 还没有登录`, ...(waiting.readiness?.loginCommand ? { loginCommand: waiting.readiness.loginCommand } : {}) };
  return { label, state: 'missing', reason: `这台电脑上还没有装 ${label}` };
}

/** One of the engine's cat templates as a face is made from it: only well-formed fields are kept. */
export interface FaceTemplate { id: string; name?: string; nickname?: string; roleDescription?: string; personality?: string; teamStrengths?: string; color?: { primary: string; secondary: string };
  /** Changes when the portrait does: what a creation screen showed and what a creation uses can be compared. */
  rev: string }
/**
 * The engine's templates (unpatched GET /api/cat-templates) read defensively: upstream serves its
 * template file without checking the entries, so an entry that is not an object, has no id or carries
 * a field of the wrong type must not break the first screen or a creation.
 */
export function faceTemplates(raw: unknown): FaceTemplate[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { templates?: unknown }).templates) ? (raw as { templates: unknown[] }).templates : [];
  const words = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  return list.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>, id = words(item.id);
    if (!id) return [];
    const colour = item.color && typeof item.color === 'object' ? item.color as Record<string, unknown> : {};
    const [name, nickname, roleDescription, personality, teamStrengths] = [words(item.name), words(item.nickname), words(item.roleDescription), words(item.personality), words(item.teamStrengths)];
    return [{ id, ...(name ? { name } : {}), ...(nickname ? { nickname } : {}), ...(roleDescription ? { roleDescription } : {}), ...(personality ? { personality } : {}), ...(teamStrengths ? { teamStrengths } : {}),
      ...(typeof colour.primary === 'string' && typeof colour.secondary === 'string' ? { color: { primary: colour.primary, secondary: colour.secondary } } : {}),
      rev: createHash('sha256').update(JSON.stringify([roleDescription ?? null, personality ?? null, teamStrengths ?? null])).digest('hex').slice(0, 16) }];
  });
}

export async function startSummary(bridge: BotBridge, refresh = false) {
  // The templates only add what each face is like; a first screen must not fail because they could not be read.
  const [runtimes, cats, templates] = await Promise.all([bridge.runtimes(refresh), bridge.cats(), bridge.faceTemplates().catch(() => [])]);
  // What each face is like, from the engine's template of the same id: a cat made by picking a face starts with this portrait
  // and thinks with that cat's own tool. `rev` goes back with the creation, so the cat that is made is the one that was described.
  const line = (value: string | undefined, max: number) => value ? clip(value.replace(/\s+/g, ' '), max) : undefined;
  const faces = catFaces.flatMap(id => {
    const template = templates.find(known => known.id === id);
    // Only what a cat can be made from: a template without its colour pair is refused at creation, so it is not offered.
    if (!template?.color) return [];
    const [name, nickname, role, personality, strengths] = [line(template.name, 40), line(template.nickname, 40), line(template.roleDescription, 120), line(template.personality, 120), line(template.teamStrengths, 80)];
    // Its tool here: which one, and whether a cat can be made from this face as it is (`usable`); `reason` says why not.
    const tool = faceTool(id, runtimes);
    return [{ id, rev: template.rev, ...(name ? { name } : {}), ...(nickname ? { nickname } : {}), ...(role ? { role } : {}), ...(personality ? { personality } : {}), ...(strengths ? { strengths } : {}),
      tool: { label: tool.label, state: tool.state, usable: !!tool.runtime, ...(tool.runtime ? { id: tool.runtime.id } : {}), ...(tool.reason ? { reason: tool.reason } : {}),
        ...(tool.loginCommand ? { loginCommand: tool.loginCommand } : {}) } }];
  });
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
    agents, faces, checkedAt: Date.now(),
  };
}

export async function bindAgent(bridge: BotBridge, cat: NativeCat, runtimeId: string) {
  const runtimes = await bridge.runtimes(true);
  const runtime = runtimes.find(r => r.id === runtimeId);
  if (!runtime) throw new ApiError(404, '找不到这个本机 Agent');
  const unavailable = runtimeUnavailable(runtime);
  if (unavailable) throw new ApiError(422, unavailable);
  const status = (await bridge.statuses()).bots.find(b => b.native_id === cat.id);
  if (status?.executionReadStatus !== 'ready') throw new ApiError(503, '暂时无法确认它是不是还在忙，请稍后再换 Agent');
  if (status?.active.length || status?.queued.length) throw new ApiError(409, '这只猫猫还在忙，等它做完或先停止，再换 Agent');
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
