import express from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { NativeTransport } from '../native/types.js';

const kindSchema = z.enum(['profile', 'taste']);
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const revisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const matterRevisionSchema = z.coerce.number().int().positive();
const mattersCatalogQuerySchema = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(30).optional(),
}).strict();
const matterDetailQuerySchema = z.object({
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(30).optional(),
  expectedRevision: matterRevisionSchema.optional(),
  history: z.enum(['true', 'false']).optional(),
}).strict();
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const validId = (value: unknown) => typeof value === 'string' && idSchema.safeParse(value).success ? value : undefined;
const isMatterUnavailable = (error: unknown) =>
  error instanceof ApiError && error.status === 503 &&
  (error.message === 'matter_memory_unavailable' || record(error.details).error === 'matter_memory_unavailable');

function translateMatterError(error: unknown): never {
  if (error instanceof ApiError) {
    const code = typeof record(error.details).error === 'string' ? record(error.details).error : error.message;
    if (isMatterUnavailable(error)) throw new ApiError(503, '事项记忆当前不可用', error.details, 'matter_memory_unavailable');
    if (error.status === 404 && code === 'not_available') throw new ApiError(404, '没有找到这条事项，或当前没有权限查看', error.details, 'not_available');
    if (error.status === 409 && code === 'stale_revision') throw new ApiError(409, '这条事项已经更新，重新读取后再试', error.details, 'stale_revision');
    if (error.status === 400 && code === 'invalid_cursor') throw new ApiError(400, '分页位置已失效，请重新读取', error.details, 'invalid_cursor');
  }
  throw error;
}

/** Owner-only native reads. No lifecycle writers, caches or memory persistence in Bot. */
export function createMemoryRouter(native: NativeTransport) {
  const router = express.Router();
  router.get('/memory/matters', async (req, res) => {
    const query = mattersCatalogQuerySchema.parse(req.query);
    const search = new URLSearchParams();
    if (query.query !== undefined) search.set('query', query.query);
    if (query.cursor !== undefined) search.set('cursor', query.cursor);
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    const qs = search.toString();
    let data: Record<string, any>;
    try {
      data = record(await native.request(`/api/memory/matters${qs ? `?${qs}` : ''}`));
    } catch (error) {
      if (isMatterUnavailable(error)) return res.json({ kind: 'matters', readStatus: 'unavailable', entries: [] });
      translateMatterError(error);
    }
    if (!Array.isArray(data.items)) throw new ApiError(502, '记忆返回格式不完整，请稍后重试');
    let unavailableCount = 0;
    const entries = [];
    for (const raw of data.items) {
      const item = record(raw);
      const rev = matterRevisionSchema.safeParse(item.revision);
      if (!idSchema.safeParse(item.matterId).success || !rev.success || typeof item.revision !== 'number')
        throw new ApiError(502, '记忆条目缺少有效标识或版本');
      if (item.unavailable === true) { unavailableCount++; continue; }
      entries.push({
        id: item.matterId,
        title: typeof item.title === 'string' && item.title.trim() ? item.title : '未命名事项',
        content: typeof item.description === 'string' ? item.description : '',
        revision: rev.data,
        status: ['active', 'retired'].includes(item.status) ? item.status : 'unknown',
        entryCount: Number.isSafeInteger(item.entryCount) && item.entryCount >= 0 ? item.entryCount : 0,
        ...(item.summaryStatus === 'sources_changed' ? { summaryStatus: 'sources_changed' as const } : {}),
        ...(typeof item.updatedAt === 'number' || typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
        ...(typeof item.createdAt === 'number' || typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}),
      });
    }
    const readStatus = unavailableCount > 0 ? (entries.length > 0 ? 'partial' : 'unavailable') : 'ready';
    const nextCursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : undefined;
    res.json({ kind: 'matters', readStatus, entries, ...(nextCursor ? { nextCursor } : {}) });
  });
  router.get('/memory/matters/:id', async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const query = matterDetailQuerySchema.parse(req.query);
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set('cursor', query.cursor);
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    if (query.expectedRevision !== undefined) search.set('expectedRevision', String(query.expectedRevision));
    if (query.history !== undefined) search.set('history', query.history);
    const qs = search.toString();
    let data: Record<string, any>;
    try {
      data = record(await native.request(`/api/memory/matters/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`));
    } catch (error) {
      translateMatterError(error);
    }
    const matter = record(data.matter);
    const rev = matterRevisionSchema.safeParse(matter.revision);
    if (!idSchema.safeParse(matter.matterId).success || !rev.success || typeof matter.revision !== 'number' || !Array.isArray(data.entries))
      throw new ApiError(502, '记忆返回格式不完整，请稍后重试');
    const entries = data.entries.map((raw: unknown) => {
      const entry = record(raw);
      if (!idSchema.safeParse(entry.entryId).success) throw new ApiError(502, '记忆条目缺少有效标识或版本');
      const src = record(entry.source);
      const threadId = validId(src.threadId);
      const messageId = validId(src.messageId);
      const canOpen = Boolean(threadId && messageId);
      const sourceStatus = ['current', 'changed', 'thread_only'].includes(entry.sourceStatus) ? entry.sourceStatus : 'unknown';
      const occurredAt = typeof src.timestamp === 'number' || typeof src.timestamp === 'string' ? src.timestamp : null;
      return {
        id: entry.entryId,
        status: ['active', 'superseded', 'retired'].includes(entry.status) ? entry.status : 'unknown',
        sourceStatus,
        ...(typeof entry.summary === 'string' && entry.summary.trim() ? { summary: entry.summary } : {}),
        ...(typeof entry.quote === 'string' && sourceStatus === 'current' ? { quote: entry.quote } : {}),
        ...(typeof entry.recordedAt === 'number' || typeof entry.recordedAt === 'string' ? { recordedAt: entry.recordedAt } : {}),
        source: {
          canOpen,
          ...(threadId ? { threadId } : {}),
          ...(messageId ? { messageId } : {}),
          occurredAt,
        },
      };
    });
    const nextCursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : undefined;
    res.json({
      matter: {
        id: matter.matterId,
        title: typeof matter.title === 'string' && matter.title.trim() ? matter.title : '未命名事项',
        content: typeof matter.description === 'string' ? matter.description : '',
        revision: rev.data,
        status: ['active', 'retired'].includes(matter.status) ? matter.status : 'unknown',
        ...(data.summaryStatus === 'sources_changed' ? { summaryStatus: 'sources_changed' as const } : {}),
        ...(typeof matter.updatedAt === 'number' || typeof matter.updatedAt === 'string' ? { updatedAt: matter.updatedAt } : {}),
        ...(typeof matter.createdAt === 'number' || typeof matter.createdAt === 'string' ? { createdAt: matter.createdAt } : {}),
      },
      entries,
      ...(nextCursor ? { nextCursor } : {}),
    });
  });
  router.get('/memory/:kind', async (req, res) => {
    const kind = kindSchema.parse(req.params.kind);
    const data = record(await native.request(`/api/memory/${kind}`));
    if (!['ready', 'partial', 'unavailable'].includes(data.readStatus) || !Array.isArray(data.entries))
      throw new ApiError(502, '记忆返回格式不完整，请稍后重试');
    const entries = data.entries.map((raw: unknown) => {
      const item = record(raw);
      if (!idSchema.safeParse(item.id).success || !revisionSchema.safeParse(item.revision).success)
        throw new ApiError(502, '记忆条目缺少有效标识或版本');
      const pending = kind === 'profile'
        ? (Array.isArray(item.proposals) ? item.proposals.filter((p: any) => ['pending', 'approving'].includes(p?.status)).length : 0)
        : (item.takeawayCandidate?.status === 'pending_owner_confirmation' ? 1 : 0) + (Number.isSafeInteger(item.pendingCorrectionCount) ? Math.max(0, item.pendingCorrectionCount) : 0);
      const content = kind === 'profile' ? item.content : [item.takeaway, ...strings(item.quotes), item.scene].filter(v => typeof v === 'string' && v.trim()).join('\n\n');
      if (typeof content !== 'string') throw new ApiError(502, '记忆内容暂时不可读');
      return { id: item.id, title: typeof item.title === 'string' ? item.title : kind === 'profile' ? '关于你' : '你的偏好',
        content, revision: item.revision, status: ['active', 'retired'].includes(item.status) ? item.status : 'unknown', pendingCount: pending,
        ...(typeof item.updatedAt === 'number' || typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : typeof item.when === 'string' ? { updatedAt: item.when } : {}) };
    });
    res.json({ kind, readStatus: data.readStatus, entries });
  });
  router.get('/memory/:kind/:id/source', async (req, res) => {
    const kind = kindSchema.parse(req.params.kind), id = idSchema.parse(req.params.id);
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(req.query);
    const data = record(await native.request(`/api/memory/${kind}/${encodeURIComponent(id)}/source?${new URLSearchParams({ revision })}`));
    if (!['ready', 'not_recorded', 'unavailable'].includes(data.status)) throw new ApiError(502, '记忆来源格式不完整，请稍后重试');
    // Profile has multiple coordinates; Taste exposes one settled proposal coordinate.
    // This is only a display projection, with native visibility and revision checks retained.
    if (kind === 'profile') {
      if (!Array.isArray(data.sources)) throw new ApiError(502, '记忆来源格式不完整，请稍后重试');
      res.json(data);
    } else {
      const canOpen = data.canOpen === true && typeof data.threadId === 'string' && typeof data.messageId === 'string';
      res.json({ status: data.status, sources: data.status === 'ready' ? [{
        label: typeof data.title === 'string' && data.title.trim() ? data.title : '偏好来源', occurredAt: null, canOpen,
        ...(canOpen ? {threadId:data.threadId,messageId:data.messageId} : {}),
      }] : [] });
    }
  });
  // Explicitly fail all unimplemented paths and writers under this surface.
  router.use('/memory', (_req, res) => res.status(405).json({ error: '长期记忆目前只支持查看' }));
  return router;
}
