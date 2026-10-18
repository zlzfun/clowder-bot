import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NativeConversationService } from '../domains/plugin/native-conversations/service.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const openSchema = z
  .object({
    pluginId: z.string().min(1).max(128),
    entityKey: z.string().min(1).max(64),
    executionTemplateId: z.string().min(1).max(128).optional(),
    workspacePath: z.string().min(1).max(4096).optional(),
  })
  .strict();

export function registerNativeConversationRoutes(
  app: FastifyInstance,
  service: Pick<NativeConversationService, 'catalog' | 'open'>,
): void {
  app.get('/api/native-conversations', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return service.catalog(access.operator);
  });
  app.post('/api/native-conversations/open', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'write');
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = openSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid native conversation binding request' });
    try {
      return await service.open(access.operator, parsed.data);
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : 'Native conversation unavailable' });
    }
  });
}
