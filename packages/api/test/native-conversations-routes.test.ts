import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerNativeConversationRoutes } from '../src/routes/native-conversations.js';

test('binding requires a local owner session and accepts only the bounded request', async () => {
  const app = Fastify();
  const admitted: string[] = [];
  app.addHook('preHandler', async (request) => {
    const owner = request.headers['x-test-session'];
    if (typeof owner === 'string') (request as typeof request & { sessionUserId?: string }).sessionUserId = owner;
  });
  registerNativeConversationRoutes(app, {
    catalog: async () => ({ schemaVersion: 1, contributions: [], executionTemplates: [], storageDurable: true }),
    open: async (owner) => {
      admitted.push(owner);
      return { threadId: 'bound-thread', catId: 'native-test', workspacePath: '/approved' };
    },
  });
  const payload = { pluginId: 'example.plugin', entityKey: 'one' };
  const headers = { origin: 'http://localhost:5192', host: 'localhost', 'x-test-session': 'default-user' };
  try {
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/native-conversations/open',
      payload,
      headers: { origin: headers.origin, host: headers.host, 'x-cat-cafe-user': 'default-user' },
    });
    assert.equal(anonymous.statusCode, 401);
    const remote = await app.inject({
      method: 'POST',
      url: '/api/native-conversations/open',
      payload,
      headers,
      remoteAddress: '192.0.2.10',
    });
    assert.equal(remote.statusCode, 403);
    const executable = await app.inject({
      method: 'POST',
      url: '/api/native-conversations/open',
      payload: { ...payload, command: 'codex', userId: 'other' },
      headers,
    });
    assert.equal(executable.statusCode, 400);
    const accepted = await app.inject({ method: 'POST', url: '/api/native-conversations/open', payload, headers });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(admitted, ['default-user']);
  } finally {
    await app.close();
  }
});
