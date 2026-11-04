import { z } from 'zod';
import { ApiError } from '../errors.js';
import { BotBridge, encode } from './bridge.js';
import { runtimeForCat, runtimeUnavailable } from './agents.js';
import type { NativeCat } from './types.js';

export type ScheduleTrigger = { type: 'once'; fireAt: number } | { type: 'cron'; expression: string; timezone?: string } | { type: 'interval'; ms: number };
export interface ScheduleRun {
  outcome: string; started_at: string; error_summary: string | null; [key: string]: unknown;
}
export interface NativeSchedule {
  id: string; source: string; templateId?: string; targetCatId?: string; prompt?: string;
  deliveryThreadId?: string | null; dynamicTaskId?: string;
  trigger: ScheduleTrigger; enabled: boolean; effectiveEnabled: boolean; registered: boolean;
  display?: { label?: string }; lastRun: ScheduleRun | null;
  runStats: { total: number; delivered: number; failed: number; skipped: number };
}
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间需要为 HH:mm');
const timezone = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, '时区无效');
export const scheduleCreateSchema = z.object({
  name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(16000), idempotencyKey: z.string().uuid(),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }).strict(),
    z.object({ kind: z.literal('daily'), time, timezone }).strict(),
    z.object({ kind: z.literal('weekly'), time, timezone, days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(a => new Set(a).size === a.length, '星期不能重复') }).strict(),
    z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(10080) }).strict(),
  ]),
}).strict();
export function nativeTrigger(schedule: z.infer<typeof scheduleCreateSchema>['schedule']): ScheduleTrigger {
  if (schedule.kind === 'once') {
    const fireAt = Date.parse(schedule.at);
    if (!Number.isSafeInteger(fireAt) || fireAt <= Date.now()) throw new ApiError(400, '请选择未来的执行时间');
    return { type: 'once', fireAt };
  }
  if (schedule.kind === 'interval') return { type: 'interval', ms: schedule.minutes * 60000 };
  const [hour, minute] = schedule.time.split(':').map(Number);
  return { type: 'cron', expression: `${minute} ${hour} * * ${schedule.kind === 'daily' ? '*' : [...schedule.days].sort((a, b) => a - b).join(',')}`, timezone: schedule.timezone };
}

export function scheduleStatus(task: NativeSchedule, now = Date.now()) {
  if (task.trigger.type === 'once' && task.trigger.fireAt <= now && !task.registered) {
    if (task.lastRun?.outcome === 'RUN_DELIVERED') return 'delivered';
    if (task.lastRun?.outcome === 'RUN_FAILED') return 'failed';
    if (task.lastRun?.outcome === 'SKIP_MISSED_WINDOW') return 'missed';
  }
  if (!task.enabled) return 'paused';
  if (!task.registered) return 'unregistered';
  if (!task.effectiveEnabled) return 'blocked';
  return 'scheduled';
}

/** Read/write projection only: definitions, audit, trigger timers and run records remain native. */
export class BotSchedules {
  constructor(private bridge: BotBridge) {}
  private async nativeList(requireReady = false): Promise<NativeSchedule[]> {
    const data = await this.bridge.native.request<{ tasks: NativeSchedule[]; botScheduleVersion?: number; botSchedulerReady?: boolean }>('/api/schedule/tasks');
    if (data.botScheduleVersion !== 1) throw new ApiError(503, '定时任务需要更新 Clowder AI 运行时，请运行 npm run runtime:prepare 后重新启动运行时');
    if (requireReady && data.botSchedulerReady !== true) throw new ApiError(503, '原生调度器仍在启动，请稍后重试');
    if (!Array.isArray(data.tasks)) throw new ApiError(502, '原生定时任务列表格式无效');
    return data.tasks;
  }
  private belongs(task: NativeSchedule, cat: NativeCat): boolean {
    return task.source === 'dynamic' && task.id.startsWith('dyn-') && task.templateId === 'reminder'
      && task.targetCatId === cat.id && typeof task.prompt === 'string' && !!task.deliveryThreadId;
  }
  private project(task: NativeSchedule, currentThreadId: string) {
    return { id: task.id, name: task.display?.label || '定时任务', prompt: task.prompt!, threadId: task.deliveryThreadId!,
      currentThread: task.deliveryThreadId === currentThreadId, trigger: task.trigger,
      enabled: task.enabled, effectiveEnabled: task.effectiveEnabled, registered: task.registered,
      status: scheduleStatus(task), lastRun: task.lastRun, runStats: task.runStats };
  }
  private async find(cat: NativeCat, id: string, requireReady = false) {
    const task = (await this.nativeList(requireReady)).find(t => t.id === id && this.belongs(t, cat));
    if (!task) throw new ApiError(404, '找不到这只猫的定时任务');
    return task;
  }
  private async canDeliver(cat: NativeCat, threadId: string) {
    const thread = await this.bridge.thread(threadId);
    if (thread.deletedAt || !thread.preferredCats?.includes(cat.id)) throw new ApiError(409, '投递聊天已不可用或不再包含这只猫，请新建定时任务');
    const runtime = runtimeForCat(cat, await this.bridge.runtimes());
    if (!runtime) throw new ApiError(422, '请先为这只猫接入可用的本地 Agent');
    const reason = runtimeUnavailable(runtime);
    if (reason) throw new ApiError(422, reason);
  }
  async list(cat: NativeCat) {
    const [tasks, thread] = await Promise.all([this.nativeList(), this.bridge.direct(cat)]);
    return { routines: tasks.filter(t => this.belongs(t, cat)).map(t => this.project(t, thread.id)), currentThreadId: thread.id,
      timezone: this.bridge.store.bot(cat.id).timezone || 'Asia/Shanghai' };
  }
  async create(cat: NativeCat, body: unknown) {
    const input = scheduleCreateSchema.parse(body), trigger = nativeTrigger(input.schedule);
    // Capability check precedes mutations: old runtimes must not silently ignore retry identity.
    await this.nativeList(true);
    const thread = await this.bridge.direct(cat);
    await this.canDeliver(cat, thread.id);
    const result = await this.bridge.native.request<{ success: boolean; proposed?: boolean; task?: { id: string } }>('/api/schedule/tasks', {
      method: 'POST', body: { templateId: 'reminder', trigger, params: { message: input.prompt, targetCatId: cat.id },
        display: { label: input.name, category: 'system', description: input.prompt }, deliveryThreadId: thread.id,
        botIdempotencyKey: input.idempotencyKey },
    });
    if (!result.success || result.proposed || !result.task?.id) throw new ApiError(502, '原生运行时未确认定时任务已创建，请刷新列表核对');
    // Do not turn a successful create into a failure by performing another fallible read.
    return { id: result.task.id, name: input.name, prompt: input.prompt, trigger, threadId: thread.id };
  }
  async setEnabled(cat: NativeCat, id: string, enabled: boolean) {
    const task = await this.find(cat, id, enabled);
    if (enabled) {
      if (task.trigger.type === 'once' && task.trigger.fireAt <= Date.now()) throw new ApiError(409, '这个一次性任务的时间已过，请新建任务');
      await this.canDeliver(cat, task.deliveryThreadId!);
    }
    return this.bridge.native.request(`/api/schedule/tasks/${encode(id)}`, { method: 'PATCH', body: { enabled } });
  }
  async remove(cat: NativeCat, id: string) {
    await this.find(cat, id);
    return this.bridge.native.request(`/api/schedule/tasks/${encode(id)}`, { method: 'DELETE' });
  }
  async runs(cat: NativeCat, id: string) {
    const task = await this.find(cat, id);
    return this.bridge.native.request(`/api/schedule/tasks/${encode(id)}/runs?${new URLSearchParams({ threadId: task.deliveryThreadId!, limit: '50' })}`);
  }
}
