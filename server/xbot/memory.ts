import express from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { NativeTransport } from '../native/types.js';

const kindSchema = z.enum(['profile', 'taste']);
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const revisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Owner-only native reads. No lifecycle writers, caches or memory persistence in Bot. */
export function createMemoryRouter(native: NativeTransport) {
  const router = express.Router();
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
