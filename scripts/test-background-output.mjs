import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, lock } from './upstream-source.mjs';

// Route tests must not create fallback configuration in the generated runtime,
// which the real launcher deliberately requires to be a persistent-data symlink.
const sandbox = mkdtempSync(join(tmpdir(), 'bot-output-test-'));
mkdirSync(join(sandbox, '.cat-cafe'));
writeFileSync(join(sandbox, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
for (const key of ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CAFE_WORKSPACE_ROOT', 'CAT_CAFE_DATA_DIR']) process.env[key] = sandbox;
after(() => rmSync(sandbox, { recursive: true, force: true }));
const { ClaudeSdkAgentService } = await import(pathToFileURL(resolve(root, lock.build, 'packages/api/dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js')).href);
const { routeSerial } = await import(pathToFileURL(resolve(root, lock.build, 'packages/api/dist/domains/cats/services/agents/routing/route-serial.js')).href);
const { routeParallel } = await import(pathToFileURL(resolve(root, lock.build, 'packages/api/dist/domains/cats/services/agents/routing/route-parallel.js')).href);

test('a provider reply checkpoints its output while the background host remains alive', async () => {
  const previous = process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION;
  process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION = '1';
  let closes = 0, checkpointSeen = false, reachedParentIdle = false;
  const service = new ClaudeSdkAgentService({
    catId: 'opus', model: 'claude-opus-4-6', mcpServerPath: '',
    l0CompilerFn: async () => 'isolated test identity', rawArchive: { append: async () => {} },
    queryFn: ({ prompt }) => ({
      close() { closes++; },
      async *[Symbol.asyncIterator]() {
        const first = (await prompt[Symbol.asyncIterator]().next()).value;
        yield { type: 'system', subtype: 'init', session_id: 'checkpoint-session' };
        yield { type: 'system', subtype: 'session_state_changed', state: 'running' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Still working' }] } };
        yield { type: 'assistant', parent_tool_use_id: 'child-tool', message: { content: [{ type: 'text', text: 'Child internal narration' }] } };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle', parent_tool_use_id: 'child-tool' };
        yield { type: 'result', subtype: 'success', session_id: 'checkpoint-session', queued_turn_count: 0, user_message_uuids: [first.uuid] };
        assert.equal(checkpointSeen, true, 'reply must be published before any later child event');
        assert.equal(closes, 0, 'publishing a reply must not close the background host');
        reachedParentIdle = true;
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      },
    }),
  });
  try {
    const events = [];
    for await (const event of service.invoke('status', { workingDirectory: '/tmp' })) {
      events.push(event);
      if (event.outputCheckpoint === 'turn_complete') checkpointSeen = true;
    }
    assert.ok(checkpointSeen);
    assert.ok(reachedParentIdle, 'a child idle must not close the parent input stream');
    assert.equal(events.filter(e => e.type === 'done').length, 1);
    assert.equal(events.some(e => e.type === 'error'), false);
    assert.equal(events.some(e => e.content?.includes('Child internal narration')), false, 'child output must not impersonate the parent');
    assert.equal(closes, 1);
  } finally {
    if (previous === undefined) delete process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION;
    else process.env.CAT_CAFE_BOT_BACKGROUND_DELEGATION = previous;
  }
});

for (const [label, route] of [['serial', routeSerial], ['parallel', routeParallel]]) test(`${label}: short trailing reply persists at checkpoint before the next event`, async () => {
  const drafts = [], stored = new Map();
  const service = {
    async *invoke() {
      yield { type: 'text', catId: 'opus', content: 'P', timestamp: Date.now() };
      yield { type: 'text', catId: 'opus', content: 'rogress: still running', timestamp: Date.now() };
      yield { type: 'system_info', catId: 'opus', content: '{"type":"provider_turn_complete"}', outputCheckpoint: 'turn_complete', timestamp: Date.now() };
      assert.equal(drafts.at(-1)?.content, 'Progress: still running', 'short burst must not wait for another tool or child event');
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const deps = {
    services: { opus: service }, voiceMode: false,
    invocationDeps: {
      registry: { create: () => ({ invocationId: 'checkpoint-inv', callbackToken: 'test-token' }), verify: () => ({ ok: false, reason: 'unknown_invocation' }) },
      sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => '/tmp' },
      threadStore: null, apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async msg => { const row = { id: `m${stored.size}`, ...msg }; stored.set(row.id, row); return row; },
      getById: async id => stored.get(id) ?? null, getRecent: () => [], getMentionsFor: () => [], getRecentMentionsFor: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    draftStore: { delete: async () => {}, upsert: async d => { drafts.push(d); } },
  };
  const events = [];
  for await (const event of route(deps, ['opus'], 'status', 'checkpoint-owner', 'checkpoint-thread', { parentInvocationId: 'checkpoint-parent' })) events.push(event);
  assert.ok(events.some(e => e.outputCheckpoint === 'turn_complete'));
  assert.equal(events.some(e => e.type === 'error'), false);
});
