import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NativeClient } from '../server/native/client.js';
import { BotBridge } from '../server/native/bridge.js';
import { ProductStore } from '../server/product-store.js';
import { bindAgent } from '../server/native/agents.js';

// Explicit opt-in: this suite uses a running, dedicated Clowder AI + Redis deployment.
const enabled = process.env.BOT_NATIVE_TEST === '1';
test('native contracts: catalog, durable threads, notes, Socket.IO, sessions and queue', { skip: !enabled }, async () => {
  const native = new NativeClient(`http://127.0.0.1:${process.env.BOT_NATIVE_PORT || 4331}`, `http://127.0.0.1:${process.env.PORT || 3210}`);
  const suffix = randomUUID().slice(0, 8);
  const bridge = new BotBridge(native, new ProductStore(resolve(`.runtime/integration-${suffix}.json`)), resolve(process.env.BOT_RUNTIME_DATA_DIR || 'data/native', 'workspace'));
  const health = await native.request<any>('/api/health');
  assert.equal(health.callbackAuth.backend, 'redis'); assert.equal(health.callbackAuth.durability, 'durable');
  let catId: string | undefined, threadId: string | undefined;
  try {
    const cat = await bridge.createBot({ name: `验收-${suffix}`, runtimeId: 'codex', persona: 'Integration test member. Do not call external tools.' }); catId = cat.id;
    assert.equal(cat.clientId, 'openai');
    assert.equal(cat.defaultModel, '');
    const thread = await bridge.direct(cat); threadId = thread.id;
    assert.deepEqual(thread.preferredCats, [cat.id]);
    const reconnected = new NativeClient(`http://127.0.0.1:${process.env.BOT_NATIVE_PORT || 4331}`, `http://127.0.0.1:${process.env.PORT || 3210}`);
    assert.equal((await reconnected.request<any>(`/api/threads/${thread.id}`)).id, thread.id); await reconnected.close();
    const queue = await bridge.queue(thread.id); assert.deepEqual(queue.activeInvocations, []); assert.deepEqual(queue.queue, []);
    let resync = false;
    const off = await native.subscribe(thread.id, event => { if (event.type === 'resync') resync = true; }); assert.equal(resync, true); off();
    await native.request('/api/memory', { method: 'POST', body: { threadId: thread.id, key: 'verification', value: 'Native shared note', updatedBy: 'user' } });
    assert.equal((await bridge.notes(thread.id))[0]?.text, 'Native shared note');
    assert.deepEqual((await bridge.transcript(cat)).messages, []);
    assert.ok(Array.isArray((await native.request<any>(`/api/threads/${thread.id}/sessions`)).sessions));
    assert.ok(Array.isArray((await native.request<any>('/api/approval-hub/pending')).manifest));
    const rebound = await bindAgent(bridge, await bridge.cat(cat.id), 'codex');
    assert.equal(rebound.agent.id, 'codex'); assert.equal(rebound.agent.modelOverride, null);
    if (process.env.BOT_MODEL_SMOKE === '1') {
      const sent = await bridge.send(thread, { text: '这是执行链路验收。请只回复 native-ok，不调用工具，不读写文件。', idempotencyKey: randomUUID() }, cat) as any;
      assert.equal(sent.status, 'queued');
      const deadline = Date.now() + 120_000;
      let completed = false;
      while (Date.now() < deadline) {
        const page = await bridge.messages(thread.id);
        const reply = page.messages.find(m => m.catId === cat.id && m.type === 'assistant' && m.content.includes('native-ok') && !m.isDraft);
        if (reply) { completed = true; break; }
        const failure = page.messages.find(m => m.lifecycle?.kind === 'delivery_failure');
        if (failure) throw new Error(`Native invocation failed: ${failure.content}`);
        await new Promise(ok => setTimeout(ok, 1000));
      }
      assert.equal(completed, true, 'Real native CLI response was not observed');
      assert.ok((await native.request<any>(`/api/threads/${thread.id}/sessions`)).sessions.length > 0, 'Native session persisted');
    }
    assert.equal((await bridge.stop(thread.id)).status, 'ok');
  } finally {
    // Native soft-delete only this suite's synthetic thread; never flush data stores.
    if (threadId) { await bridge.stop(threadId); await native.request(`/api/threads/${threadId}`, { method: 'DELETE' }); }
    if (catId) await native.request(`/api/cats/${catId}`, { method: 'DELETE' });
    await native.close();
  }
});

test('real native queue rejects an out-of-roster member without creating its session', { skip: !enabled }, async () => {
  const native = new NativeClient(`http://127.0.0.1:${process.env.BOT_NATIVE_PORT || 4331}`, `http://127.0.0.1:${process.env.PORT || 3210}`);
  const suffix = randomUUID().slice(0, 8);
  const bridge = new BotBridge(native, new ProductStore(resolve(`.runtime/policy-${suffix}.json`)), resolve(process.env.BOT_RUNTIME_DATA_DIR || 'data/native', 'workspace'));
  const cats: string[] = []; let threadId: string | undefined;
  try {
    const member = await bridge.createBot({ name: `成员-${suffix}`, runtimeId: 'codex' }); cats.push(member.id);
    const outsider = await bridge.createBot({ name: `非成员-${suffix}`, runtimeId: 'codex' }); cats.push(outsider.id);
    const thread = await bridge.direct(member); threadId = thread.id;
    const errors: any[] = [];
    const off = await native.subscribe(thread.id, event => { if (event.type === 'error') errors.push(event); });
    await bridge.send(thread, { text: '成员限制测试，不应执行。' }, outsider);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !errors.some(e => e.errorCode === 'thread_participant_policy_denied')) await new Promise(ok => setTimeout(ok, 100));
    off();
    assert.ok(errors.some(e => e.errorCode === 'thread_participant_policy_denied'), 'Native queue must surface the participant denial');
    const { sessions } = await native.request<any>(`/api/threads/${thread.id}/sessions`);
    assert.equal(sessions.filter((s: any) => s.catId === outsider.id).length, 0);
  } finally {
    if (threadId) { await bridge.stop(threadId); await native.request(`/api/threads/${threadId}`, { method: 'DELETE' }); }
    for (const catId of cats) await native.request(`/api/cats/${catId}`, { method: 'DELETE' });
    await native.close();
  }
});
