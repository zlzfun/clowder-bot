import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const binary = resolve(import.meta.dirname, '../.runtime/clowder-ai/packages/api/dist/domains/cats/services/agents/invocation');
const { assertThreadParticipant } = await import(pathToFileURL(resolve(binary, 'thread-participant-policy.js')));
const { invokeSingleCat } = await import(pathToFileURL(resolve(binary, 'invoke-single-cat.js')));

test('native participant gate: default passthrough, authorized member, missing roster, missing thread and read error', async () => {
  const store = { get: async () => ({ preferredCats: ['member-a'] }) };
  await assertThreadParticipant(null, 'thread', 'outsider', false);
  await assertThreadParticipant(store, 'thread', 'member-a', true);
  await assert.rejects(assertThreadParticipant(store, 'thread', 'outsider', true), /not in the execution roster/);
  await assert.rejects(assertThreadParticipant({ get: async () => null }, 'thread', 'member-a', true));
  await assert.rejects(assertThreadParticipant({ get: async () => ({}) }, 'thread', 'member-a', true));
  await assert.rejects(assertThreadParticipant({ get: async () => { throw new Error('storage down'); } }, 'thread', 'member-a', true));
});
test('native invocation rejects queue/A2A/direct outsider before touching provider or session services', async () => {
  process.env.CAT_CAFE_ENFORCE_THREAD_PARTICIPANTS = '1';
  for (const extra of [{}, { a2aTriggerMessageId: 'a2a-parent' }, { executionBinding: { frozen: true } }]) {
    const events = [];
    const params = { threadId: 'restricted', catId: 'outsider', ...extra };
    Object.defineProperty(params, 'service', { get() { throw new Error('provider was touched'); } });
    for await (const event of invokeSingleCat({ threadStore: { get: async () => ({ preferredCats: ['member-a'] }) } }, params)) events.push(event);
    assert.deepEqual(events.map(e => e.type), ['error', 'done']);
    assert.equal(events[0].errorCode, 'thread_participant_policy_denied');
  }
});
