import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { setNativeConversationAuthority } from '../dist/domains/plugin/native-conversations/authority.js';
import { messagesRoutes } from '../dist/routes/messages.js';

// A stale browser session must trigger apiFetch's existing 401 refresh before admission.
test('native composer rejects an expired session before admission and accepts its authenticated retry once', async () => {
  const threadId = 'bound-native-thread';
  const catId = 'native-1234567890abcdef12345678';
  const app = Fastify();
  const store = new MessageStore();
  const queue = new InvocationQueue(undefined, { resolveTargets: async () => [catId] });
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-session'] === 'fresh') request.sessionUserId = 'default-user';
  });
  setNativeConversationAuthority({ ownsThread: (id) => id === threadId });
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    messageStore: store,
    invocationQueue: queue,
    queueProcessor: { requestDrain() {}, tryAutoAppendExactEntry: async () => ({ outcome: 'rejected' }) },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: { resolveTargetsAndIntent: async () => ({ targetCats: [], intent: { intent: 'execute' } }) },
    threadStore: { get: async () => ({ id: threadId, title: 'Colleague', createdBy: 'default-user' }) },
  });
  const payload = { threadId, content: 'Do the file task', idempotencyKey: 'a1b2c3d4-1234-4234-8234-a1b2c3d4e5f6' };
  try {
    const stale = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload,
      headers: { origin: 'http://localhost:3000' },
    });
    assert.equal(stale.statusCode, 401, stale.body);
    assert.equal(store.getRecent().length, 0);
    assert.equal(queue.size(threadId, 'default-user'), 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await app.inject({
        method: 'POST',
        url: '/api/messages',
        payload,
        headers: { origin: 'http://localhost:3000', 'x-test-session': 'fresh' },
      });
      assert.equal(fresh.statusCode, 202, fresh.body);
    }
    assert.equal(store.getRecent().length, 1);
    assert.equal(queue.size(threadId, 'default-user'), 1);
    assert.equal(queue.list(threadId, 'default-user')[0].execution.ownerAuthProvenance, 'strict');
  } finally {
    setNativeConversationAuthority(undefined);
    await app.close();
  }
});
