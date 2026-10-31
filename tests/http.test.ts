import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import type { AgentProvider } from '../shared/types.js';

test('HTTP running-turn guards, settings validation and SSE deltas work together', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-http-guards-'));
  const slow: AgentProvider = { async *stream(request) {
    yield { type: 'delta', text: '正在检查' };
    await new Promise<void>(resolve => {
      if (request.signal.aborted) resolve();
      else request.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } };
  const runtime = createApp({ dataFile: join(dir, 'state.json'), provider: () => slow });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await runtime.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (path: string, body: unknown = {}, method = 'POST') => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const group = runtime.store.state.conversations[0]!;
  const bot = runtime.store.state.bots[0]!;
  assert.equal((await call('/api/settings', { cliWorkingDirectory: '/definitely-missing-clowder-dir' }, 'PUT')).status, 400);
  assert.equal((await call('/api/settings', { baseUrl: 'https://user:secret@example.com/v1' }, 'PUT')).status, 400);
  assert.equal((await call('/api/settings', { contextBudget: 1999 }, 'PUT')).status, 400);
  assert.equal((await call('/api/settings', { contextBudget: 2000 }, 'PUT')).status, 200);
  assert.equal((await call(`/api/conversations/${group.id}/messages`, { content: '   ' })).status, 400);

  const controller = new AbortController();
  const response = await fetch(base + '/api/events', { signal: controller.signal });
  const reader = response.body!.getReader();
  t.after(async () => { controller.abort(); await reader.cancel().catch(() => {}); });
  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), /event: state/);

  assert.equal((await call(`/api/conversations/${group.id}/messages`, { content: '开始测试' })).status, 202);
  const streamed = await reader.read();
  let text = new TextDecoder().decode(streamed.value);
  while (!text.includes('event: delta')) {
    const next = await reader.read();
    assert.equal(next.done, false);
    text += new TextDecoder().decode(next.value);
  }
  assert.match(text, /正在检查/);
  assert.equal((await call(`/api/conversations/${group.id}/messages`, { content: '重复发送' })).status, 409);
  assert.equal((await call(`/api/bots/${bot.id}`, { name: '执行中不能改名' }, 'PATCH')).status, 409);
  assert.equal((await call('/api/settings', { mode: 'live' }, 'PUT')).status, 409);
  assert.equal((await call(`/api/conversations/${group.id}/compact`)).status, 409);
  assert.equal((await call(`/api/conversations/${group.id}/cancel`)).status, 200);
  assert.equal(runtime.store.state.conversations[0]!.status, 'idle');
  assert.equal(runtime.store.state.messages.find(m => m.role === 'assistant')?.status, 'cancelled');
  assert.equal((await call(`/api/bots/${bot.id}`, { description: '停止后可以编辑' }, 'PATCH')).status, 200);
  controller.abort(); await reader.cancel().catch(() => {});
});
