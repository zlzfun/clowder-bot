import { ApiError } from '../errors.js';
import { clip } from './text.js';
import type { NativeMessage, NativeTransport } from './types.js';

export type RuntimeQuestionPrompt = {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  allowUnanswered?: boolean;
};

export type RuntimeDecisionOption = {
  id: string;
  label: string;
  description?: string;
  outcome: 'accept' | 'decline' | 'cancel';
};

export type RuntimeElicitationField = {
  id: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required: boolean;
};

export type RuntimePrompt =
  | { kind: 'question'; revision: number; canReject: true; questions: RuntimeQuestionPrompt[] }
  | { kind: 'approval'; revision: number; decisions: RuntimeDecisionOption[] }
  | { kind: 'elicitation'; revision: number; mode: 'url'; message: string; url: string; decisions: RuntimeDecisionOption[] }
  | { kind: 'elicitation'; revision: number; mode: 'form'; message: string; fields: RuntimeElicitationField[]; decisions: RuntimeDecisionOption[] }
  | {
      kind: 'conversation';
      revision: number;
      mode: 'single' | 'multiple' | 'confirm';
      options: Array<{ id: string; label: string; emoji?: string; description?: string; custom?: true }>;
      max?: number;
      allowText: boolean;
    };

export interface RuntimeCardBinding {
  interactionId: string;
  blockId: string;
  requestKind?: string;
}

export interface RuntimeTerminalSummary {
  state: 'approved' | 'rejected' | 'closed';
  selected?: string[];
}

export type RuntimeRecord = Record<string, any>;

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const encode = encodeURIComponent;

/** Reads `extra.runtimeInteractionCard` from a native message when present and well-formed. */
export function runtimeCardBinding(message: NativeMessage): RuntimeCardBinding | null {
  const card = record(message.extra?.runtimeInteractionCard);
  const interactionId = str(card.interactionId), blockId = str(card.blockId);
  if (!interactionId || !blockId) return null;
  return { interactionId, blockId, ...(str(card.requestKind) ? { requestKind: str(card.requestKind)! } : {}) };
}

/**
 * Fetches one F306 runtime interaction from native (`GET /api/runtime-interactions/:id`).
 * When `strict` is false (default for listing/transcript projection), 404/non-fatal errors
 * degrade to `null` so one unavailable interaction never breaks the thread view.
 */
export async function readRuntimeInteraction(
  native: NativeTransport,
  interactionId: string,
  options: { strict?: boolean } = {},
): Promise<RuntimeRecord | null> {
  if (!interactionId) return null;
  try {
    const body = await native.request<{ interaction?: unknown }>(`/api/runtime-interactions/${encode(interactionId)}`);
    const interaction = record(body?.interaction);
    const req = record(interaction.request);
    if (req.interactionId !== interactionId || typeof interaction.status !== 'string') return null;
    return interaction;
  } catch (error) {
    if (options.strict) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    return null;
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift()!);
  }));
}

/** Batch-fetches unique runtime interaction records with bounded concurrency. */
export async function readRuntimeInteractions(
  native: NativeTransport,
  ids: Iterable<string>,
  options: { strict?: boolean } = {},
): Promise<Map<string, RuntimeRecord>> {
  const unique = [...new Set([...ids].filter(Boolean))];
  const out = new Map<string, RuntimeRecord>();
  await runPool(unique, 10, async id => {
    const rec = await readRuntimeInteraction(native, id, options);
    if (rec) out.set(id, rec);
  });
  return out;
}

/** Strict batch read that keeps any readable interactions while reporting whether any non-404 lookup failed. */
export async function readRuntimeInteractionsPartial(
  native: NativeTransport,
  ids: Iterable<string>,
): Promise<{ records: Map<string, RuntimeRecord>; failed: boolean }> {
  const unique = [...new Set([...ids].filter(Boolean))];
  const records = new Map<string, RuntimeRecord>();
  let failed = false;
  await runPool(unique, 10, async id => {
    try {
      const rec = await readRuntimeInteraction(native, id, { strict: true });
      if (rec) records.set(id, rec);
    } catch {
      failed = true;
    }
  });
  return { records, failed };
}

/** Everyday one-line summary for a runtime interaction (`activity` bar / fallback). */
export function runtimeSummary(interaction: RuntimeRecord): string {
  const req = record(interaction.request);
  if (req.kind === 'question' && Array.isArray(req.questions)) {
    const questions = req.questions.map(record);
    if (questions.length === 1 && str(questions[0]?.question)) return clip(str(questions[0]!.question)!, 160);
  }
  return clip(str(req.title) ?? '', 160);
}

/** Validates an http/https URL so javascript:/data:/file: links can never surface. */
function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseDecisions(raw: unknown): RuntimeDecisionOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return null;
  const out: RuntimeDecisionOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = record(entry);
    const id = str(item.id), label = str(item.label), outcome = item.outcome;
    if (!id || !label || seen.has(id) || !['accept', 'decline', 'cancel'].includes(outcome)) return null;
    seen.add(id);
    out.push({ id, label: clip(label, 120), ...(str(item.description) ? { description: clip(str(item.description)!, 400) } : {}), outcome });
  }
  return out;
}

/**
 * Converts a canonical `RuntimeInteractionRecord` into the inline chat prompt contract,
 * or returns `null` if a rare/malformed sub-kind cannot be safely rendered in chat.
 */
export function runtimePrompt(interaction: RuntimeRecord): RuntimePrompt | null {
  const req = record(interaction.request);
  const revision = typeof interaction.revision === 'number' && Number.isInteger(interaction.revision) && interaction.revision > 0
    ? interaction.revision : 1;
  if (req.kind === 'question') {
    if (!Array.isArray(req.questions) || req.questions.length === 0 || req.questions.length > 20) return null;
    const questions: RuntimeQuestionPrompt[] = [];
    const seenIds = new Set<string>();
    for (const raw of req.questions) {
      const q = record(raw);
      const id = str(q.id), header = str(q.header), question = str(q.question);
      if (!id || !header || !question || seenIds.has(id)) return null;
      seenIds.add(id);
      let options: Array<{ label: string; description?: string }> | undefined;
      if (q.options !== undefined) {
        if (!Array.isArray(q.options) || q.options.length === 0 || q.options.length > 40) return null;
        options = [];
        for (const rawOpt of q.options) {
          const opt = record(rawOpt);
          const label = str(opt.label);
          if (!label) return null;
          // Question answers match option labels verbatim upstream, so keep canonical labels unclipped.
          options.push({ label, ...(str(opt.description) ? { description: clip(str(opt.description)!, 400) } : {}) });
        }
      }
      questions.push({
        id, header: clip(header, 160), question: clip(question, 10000),
        ...(options ? { options } : {}),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
        ...(q.isOther === true ? { isOther: true } : {}),
        ...(q.isSecret === true ? { isSecret: true } : {}),
        ...(q.allowUnanswered === true ? { allowUnanswered: true } : {}),
      });
    }
    return { kind: 'question', revision, canReject: true, questions };
  }
  if (req.kind === 'approval') {
    const decisions = parseDecisions(req.decisions);
    return decisions ? { kind: 'approval', revision, decisions } : null;
  }
  if (req.kind === 'elicitation') {
    const decisions = parseDecisions(req.decisions);
    const message = str(req.message);
    if (!decisions || !message) return null;
    if (req.mode === 'url') {
      const url = safeHttpUrl(req.url);
      return url ? { kind: 'elicitation', revision, mode: 'url', message: clip(message, 2000), url, decisions } : null;
    }
    if (req.mode === 'form') {
      const schema = record(req.requestedSchema);
      if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return null;
      const entries = Object.entries(schema.properties as Record<string, unknown>);
      if (entries.length > 30) return null;
      const requiredSet = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
      const fields: RuntimeElicitationField[] = [];
      for (const [key, specRaw] of entries) {
        if (!key.trim()) return null;
        const spec = record(specRaw);
        if (!['string', 'number', 'integer', 'boolean'].includes(spec.type)) return null;
        if (spec.enum !== undefined && (!Array.isArray(spec.enum) || spec.enum.length === 0 || spec.enum.length > 50)) return null;
        fields.push({
          id: key,
          type: spec.type,
          ...(str(spec.title) ? { title: clip(str(spec.title)!, 160) } : {}),
          ...(str(spec.description) ? { description: clip(str(spec.description)!, 400) } : {}),
          ...(spec.default !== undefined ? { default: spec.default } : {}),
          ...(spec.enum ? { enum: spec.enum } : {}),
          ...(typeof spec.minimum === 'number' ? { minimum: spec.minimum } : {}),
          ...(typeof spec.maximum === 'number' ? { maximum: spec.maximum } : {}),
          ...(typeof spec.minLength === 'number' ? { minLength: spec.minLength } : {}),
          ...(typeof spec.maxLength === 'number' ? { maxLength: spec.maxLength } : {}),
          required: requiredSet.has(key),
        });
      }
      return { kind: 'elicitation', revision, mode: 'form', message: clip(message, 2000), fields, decisions };
    }
    return null;
  }
  if (req.kind === 'conversation_decision') {
    const block = record(req.presentation);
    if (block.kind !== 'interactive' || !Array.isArray(block.options) || block.options.length === 0) return null;
    if (block.options.some((opt: unknown) => record(opt).action !== undefined)) return null;
    const mode = block.interactiveType === 'confirm' ? 'confirm' as const
      : block.interactiveType === 'multi-select' ? 'multiple' as const : 'single' as const;
    let options = block.options.map(record)
      .filter((opt: Record<string, any>) => typeof opt.id === 'string' && opt.id.trim() && typeof opt.label === 'string' && opt.label.trim())
      .slice(0, 40)
      .map((opt: Record<string, any>) => ({
        id: opt.id as string,
        label: clip(opt.label as string, 200),
        ...(str(opt.emoji) ? { emoji: clip(str(opt.emoji)!, 16) } : {}),
        ...(str(opt.description) ? { description: clip(str(opt.description)!, 400) } : {}),
        ...(opt.customInput === true ? { custom: true as const } : {}),
      }));
    if (mode === 'confirm') {
      const yes = options.find((opt: { id: string }) => opt.id === '__confirm__') ?? options[0];
      if (!yes) return null;
      const no = options.find((opt: { id: string }) => opt.id !== yes.id);
      options = no ? [yes, no] : [yes];
    }
    if (!options.length) return null;
    return {
      kind: 'conversation',
      revision,
      mode,
      options,
      ...(typeof block.maxSelect === 'number' && block.maxSelect > 0 ? { max: block.maxSelect } : {}),
      allowText: req.allowTextResponse === true,
    };
  }
  return null;
}

/** Validates a user's answer payload against the canonical upstream `RuntimeInteractionRequest`. */
function failValidation(message: string): never {
  throw new ApiError(400, message);
}

export function validateRuntimeResponse(interaction: RuntimeRecord, response: unknown): Record<string, unknown> {
  const req = record(interaction.request);
  const res = record(response);
  if (req.kind === 'question') {
    if (res.kind !== 'answers' || !res.answers || typeof res.answers !== 'object' || Array.isArray(res.answers)) {
      failValidation('请按问题填写回答');
    }
    const questions = Array.isArray(req.questions) ? req.questions.map(record) : [];
    const expectedIds = questions.map(q => String(q.id)).sort();
    const answers = res.answers as Record<string, unknown>;
    const actualIds = Object.keys(answers).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
      failValidation('提交的回答与问题不匹配');
    }
    const cleanAnswers: Record<string, string[]> = {};
    for (const q of questions) {
      const raw = answers[String(q.id)];
      if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string')) failValidation('回答格式不正确');
      const vals = (raw as string[]).map(v => v.trim()).filter(Boolean);
      if (vals.length === 0 && q.allowUnanswered !== true) failValidation(`请回答：${q.header || q.question}`);
      cleanAnswers[String(q.id)] = vals;
    }
    return { kind: 'answers', answers: cleanAnswers };
  }
  if (req.kind === 'approval' || req.kind === 'elicitation') {
    if (res.kind !== 'decision' || typeof res.decisionId !== 'string' || !res.decisionId.trim()) {
      failValidation('请选择一项处理方式');
    }
    const decisions = Array.isArray(req.decisions) ? req.decisions.map(record) : [];
    const decision = decisions.find(d => d.id === res.decisionId);
    if (!decision) failValidation('所选处理方式无效');
    if (req.kind === 'approval' || req.mode === 'url') {
      if (res.content !== undefined) failValidation('这一项不能附带表单内容');
      return { kind: 'decision', decisionId: decision.id };
    }
    // Form elicitation
    const needsContent = decision.outcome === 'accept';
    if (needsContent && (!res.content || typeof res.content !== 'object' || Array.isArray(res.content))) {
      failValidation('请填写需要补充的信息');
    }
    if (!needsContent && res.content !== undefined) failValidation('拒绝时不能附带表单内容');
    if (!needsContent) return { kind: 'decision', decisionId: decision.id };
    const schema = record(req.requestedSchema);
    const props = record(schema.properties);
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const content = res.content as Record<string, unknown>;
    for (const key of Object.keys(content)) {
      if (!(key in props)) failValidation(`存在未知字段：${key}`);
    }
    const cleanContent: Record<string, string | number | boolean> = {};
    for (const key of required) {
      if (!(key in content) || content[key] === '' || content[key] === undefined) {
        const spec = record(props[key]);
        failValidation(`请填写：${str(spec.title) ?? key}`);
      }
    }
    for (const [key, val] of Object.entries(content)) {
      const spec = record(props[key]);
      const title = str(spec.title) ?? key;
      if (spec.type === 'string') {
        if (typeof val !== 'string') failValidation(`${title}需要填写文字`);
        if (typeof spec.minLength === 'number' && val.length < spec.minLength) failValidation(`${title}至少需要 ${spec.minLength} 个字`);
        if (typeof spec.maxLength === 'number' && val.length > spec.maxLength) failValidation(`${title}最多 ${spec.maxLength} 个字`);
      } else if (spec.type === 'boolean') {
        if (typeof val !== 'boolean') failValidation(`${title}格式不正确`);
      } else if (spec.type === 'number' || spec.type === 'integer') {
        if (typeof val !== 'number' || !Number.isFinite(val) || (spec.type === 'integer' && !Number.isInteger(val))) {
          failValidation(`${title}需要填写${spec.type === 'integer' ? '整数' : '数字'}`);
        }
        if (typeof spec.minimum === 'number' && val < spec.minimum) failValidation(`${title}不能小于 ${spec.minimum}`);
        if (typeof spec.maximum === 'number' && val > spec.maximum) failValidation(`${title}不能大于 ${spec.maximum}`);
      }
      if (Array.isArray(spec.enum) && !spec.enum.includes(val)) failValidation(`${title}不在可选范围内`);
      cleanContent[key] = val as string | number | boolean;
    }
    return { kind: 'decision', decisionId: decision.id, content: cleanContent };
  }
  if (req.kind === 'conversation_decision') {
    const block = record(req.presentation);
    const options = Array.isArray(block.options) ? block.options.map(record) : [];
    const byId = new Map(options.map(o => [String(o.id), o]));
    if (res.kind === 'text') {
      if (req.allowTextResponse !== true) failValidation('这一项不能输入自由文字');
      const text = typeof res.text === 'string' ? res.text.trim() : '';
      if (!text || text.length > 100_000) failValidation('请填写回答');
      return { kind: 'text', text };
    }
    if (res.kind !== 'selection' || !Array.isArray(res.selectedIds)) failValidation('请选择一个选项');
    const selectedIds = (res.selectedIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (!selectedIds.length) failValidation('请至少选一项');
    if (new Set(selectedIds).size !== selectedIds.length) failValidation('同一个选项不能选两次');
    if (selectedIds.some(id => !byId.has(id))) failValidation('选项无效');
    if (block.interactiveType !== 'multi-select' && selectedIds.length !== 1) failValidation('这里只能选一项');
    if (block.interactiveType === 'multi-select' && typeof block.maxSelect === 'number' && selectedIds.length > block.maxSelect) {
      failValidation(`最多选 ${block.maxSelect} 项`);
    }
    const customInput = typeof res.customInput === 'string' && res.customInput.trim() ? res.customInput.trim() : undefined;
    if (customInput && !selectedIds.some(id => byId.get(id)?.customInput === true)) {
      failValidation('填写补充说明前需要先选中自定义项');
    }
    if (customInput && customInput.length > 100_000) failValidation('补充说明过长');
    return { kind: 'selection', selectedIds, ...(customInput ? { customInput } : {}) };
  }
  return failValidation('这一项要在运行面板里回答');
}

const nonUserClosedReasons = new Set([
  'defaulted', 'superseded', 'withdrawn', 'expired',
  'confirmation_unavailable', 'host_restarted', 'transport_lost', 'provider_cancelled', 'surface_publication_failed',
]);

/** Projects a settled `RuntimeInteractionRecord` into chat outcome state and public selected labels. */
export function runtimeTerminalState(interaction: RuntimeRecord): RuntimeTerminalSummary | null {
  const status = interaction.status;
  if (status === 'pending' || status === 'staged' || status === 'submitting') return null;
  const req = record(interaction.request), terminal = record(interaction.terminal), resp = record(terminal.response);
  const reasonCode = str(terminal.reasonCode);
  const nonUserClosed = !!reasonCode && nonUserClosedReasons.has(reasonCode);
  const state: RuntimeTerminalSummary['state'] =
    status === 'answered' && !nonUserClosed
      ? 'approved'
      : status === 'declined' && !nonUserClosed
        ? 'rejected'
        : 'closed';
  if (nonUserClosed) return { state };
  const selected: string[] = [];
  if (req.kind === 'question' && resp.kind === 'answers' && Array.isArray(req.questions)) {
    const secrets = new Set(Array.isArray(resp.secretQuestionIds) ? resp.secretQuestionIds : []);
    const indexMap = record(resp.selectedOptionIndexes);
    for (const raw of req.questions) {
      const q = record(raw);
      if (q.isSecret === true || secrets.has(q.id)) continue;
      const indexes = Array.isArray(indexMap[String(q.id)]) ? indexMap[String(q.id)] : [];
      const options = Array.isArray(q.options) ? q.options.map(record) : [];
      for (const idx of indexes) {
        if (Number.isInteger(idx) && idx >= 0 && options[idx]?.label) selected.push(String(options[idx].label));
      }
    }
  } else if (req.kind === 'conversation_decision' && resp.kind === 'selection') {
    const options = Array.isArray(record(req.presentation).options) ? record(req.presentation).options.map(record) : [];
    const chosen = new Set(Array.isArray(resp.selectedIds) ? resp.selectedIds : []);
    for (const opt of options) {
      if (chosen.has(opt.id) && str(opt.label)) selected.push(str(opt.label)!);
    }
  } else if ((req.kind === 'approval' || req.kind === 'elicitation') && resp.kind === 'decision') {
    const decisions = Array.isArray(req.decisions) ? req.decisions.map(record) : [];
    const matched = decisions.find(d => d.id === resp.decisionId);
    if (matched && str(matched.label)) selected.push(str(matched.label)!);
  }
  const unique = [...new Set(selected)];
  return { state, ...(unique.length ? { selected: unique } : {}) };
}
