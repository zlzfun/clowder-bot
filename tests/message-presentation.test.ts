import assert from 'node:assert/strict';
import test from 'node:test';
import { messagePresentation } from '../server/native/message-presentation.js';
import type { NativeMessage } from '../server/native/types.js';

const stream = (patch: Partial<NativeMessage> = {}): NativeMessage => ({
  id: 'run', type: 'assistant', catId: 'cat-a', origin: 'stream', timestamp: 10,
  content: 'A started. Later B completed.', lifecycle: { kind: 'response', invocationId: 'turn-a', status: 'processing' }, ...patch,
});
const post = (patch: Partial<NativeMessage> = {}): NativeMessage => ({
  id: 'post', type: 'assistant', catId: 'cat-a', origin: 'callback', timestamp: 30,
  content: 'B completed', extra: { isExplicitPost: true, stream: { turnInvocationId: 'turn-a', invocationId: 'outer' } }, ...patch,
});

test('an aggregate execution becomes activity while its explicit messages keep their own content and times', () => {
  const rows = [stream(), { id: 'ask-b', type: 'user' as const, catId: null, content: 'Run B too', timestamp: 20 }, post()];
  const before = structuredClone(rows), kinds = messagePresentation(rows);
  assert.deepEqual([...kinds], [['run', 'activity'], ['ask-b', 'message'], ['post', 'message']]);
  assert.deepEqual(rows, before, 'classification must not edit or reorder native history');
});

test('missing, conflicting, other-cat and other-turn evidence cannot hide a plain answer', () => {
  for (const callback of [
    undefined,
    post({ catId: 'cat-b' }),
    post({ extra: { isExplicitPost: true, stream: { invocationId: 'outer', turnInvocationId: 'other-turn' } } }),
    post({ extra: { isExplicitPost: true, stream: { invocationId: 'turn-a' } } }),
    post({ extra: { isExplicitPost: true, turnExecution: { invocationId: 'turn-a' }, stream: { turnInvocationId: 'conflict' } } }),
    post({ extra: { stream: { turnInvocationId: 'turn-a' } } }),
  ]) assert.equal(messagePresentation([stream(), ...(callback ? [callback] : [])]).get('run'), 'message');
  assert.equal(messagePresentation([stream({ lifecycle: undefined }), post()]).get('run'), 'message');
});

test('errors and cancellations stay visible even after an earlier successful chat post', () => {
  for (const status of ['failed', 'canceled', 'cancelled']) {
    assert.equal(messagePresentation([stream({ lifecycle: { kind: 'response', invocationId: 'turn-a', status } }), post()]).get('run'), 'message');
  }
});
