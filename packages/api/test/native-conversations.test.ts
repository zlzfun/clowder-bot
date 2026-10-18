import assert from 'node:assert/strict';
import test from 'node:test';
import { type CatConfig, createCatId, type NativeConversationDescriptor } from '@cat-cafe/shared';
import { isMcpEnabledForCat } from '../src/config/capabilities/capability-orchestrator.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { nativeConversationAgentFacade } from '../src/domains/plugin/native-conversations/agent-facade.js';
import {
  authorizeNativeConversation,
  setNativeConversationAuthority,
} from '../src/domains/plugin/native-conversations/authority.js';
import { NativeConversationService } from '../src/domains/plugin/native-conversations/service.js';

const descriptor: NativeConversationDescriptor = {
  schemaVersion: 1,
  label: 'Partners',
  description: 'A plugin collection',
  entities: ['planner', 'researcher'].map((key) => ({
    key,
    name: key,
    description: `${key} role`,
    roleInstructions: `You are the ${key}.`,
    initials: key[0]!,
    accent: 'sage',
    composerPlaceholder: `Message ${key}`,
  })),
};
const base: CatConfig = {
  id: createCatId('codex'),
  name: 'codex',
  displayName: 'Codex',
  avatar: '/avatars/codex.png',
  color: { primary: '#789', secondary: '#abc' },
  mentionPatterns: ['@codex'],
  clientId: 'openai',
  carrier: 'cli',
  defaultModel: 'test-model',
  mcpSupport: true,
  roleDescription: 'Base',
  personality: 'Base persona',
  cli: { command: 'codex', outputFormat: 'json' },
  relationshipKey: 'base-relationship',
};

function fixture() {
  let saved: any[] = [];
  let active = true;
  const threads = new ThreadStore();
  const registered = new Map<string, CatConfig>();
  const sourceRecord = {
    pluginId: 'example.partners',
    pluginInstanceId: 'instance-1',
    packageDigest: 'digest-1',
    descriptor,
  };
  const options = {
    threads,
    storageDurable: true,
    persistence: {
      load: async () => structuredClone(saved),
      save: async (records: any[]) => {
        saved = structuredClone(records);
      },
    },
    source: {
      list: async () => (active ? [sourceRecord] : []),
      assertActive: async () => {
        if (!active) throw new Error('Plugin is disabled');
      },
    },
    templates: () => ({ codex: base }),
    register: async (configs: CatConfig[]) => {
      for (const config of configs) registered.set(config.id, config);
    },
    validateWorkspace: async (path: string) => {
      if (path !== '/approved/work') throw new Error('Workspace denied');
      return path;
    },
  };
  return {
    options,
    threads,
    registered,
    service: new NativeConversationService(options),
    disable: () => {
      active = false;
    },
  };
}
const request = (entityKey = 'planner') => ({
  pluginId: 'example.partners',
  entityKey,
  executionTemplateId: 'codex',
  workspacePath: '/approved/work',
});

test('plugin data becomes a generic native directory without executing an agent', async () => {
  const { service, registered } = fixture();
  await service.restore();
  const catalog = await service.catalog('owner');
  assert.equal(catalog.contributions.length, 1);
  assert.equal(catalog.contributions[0]!.entities.length, 2);
  assert.equal(catalog.contributions[0]!.entities[0]!.availability, 'unconfigured');
  assert.equal(registered.size, 0);
});

test('two entities share provider but retain distinct identity, relationship and native threads', async () => {
  const { service, registered, threads } = fixture();
  await service.restore();
  const a = await service.open('owner', request());
  const b = await service.open('owner', request('researcher'));
  assert.notEqual(a.catId, b.catId);
  assert.notEqual(a.threadId, b.threadId);
  assert.notEqual(registered.get(a.catId)!.relationshipKey, registered.get(b.catId)!.relationshipKey);
  assert.equal(registered.get(a.catId)!.clientId, registered.get(b.catId)!.clientId);
  assert.equal(registered.get(a.catId)!.personality, 'You are the planner.');
  assert.deepEqual(threads.get(a.threadId)!.preferredCats, [a.catId]);
  assert.equal(threads.get(a.threadId)!.createdBy, 'owner');
});

test('concurrent open and service restart recover exactly the same binding', async () => {
  const { service, options, threads } = fixture();
  await service.restore();
  const opened = await Promise.all(Array.from({ length: 8 }, () => service.open('owner', request())));
  assert.equal(new Set(opened.map((item) => item.threadId)).size, 1);
  assert.equal(threads.list('owner').length, 1);
  const restarted = new NativeConversationService(options);
  await restarted.restore();
  assert.deepEqual(await restarted.open('owner', { pluginId: 'example.partners', entityKey: 'planner' }), opened[0]);
});

test('workspace, owner and thread authority are checked before provider execution', async () => {
  const { service } = fixture();
  await service.restore();
  await assert.rejects(service.open('owner', { ...request(), workspacePath: '/forbidden' }), /Workspace denied/);
  const binding = await service.open('owner', request());
  await service.authorize(binding.catId, 'owner', binding.threadId, '/approved/work');
  await assert.rejects(service.authorize(binding.catId, 'other', binding.threadId, '/approved/work'), /owner/i);
  await assert.rejects(service.authorize(binding.catId, 'owner', 'other-thread', '/approved/work'), /thread/i);
  await assert.rejects(service.authorize(binding.catId, 'owner', binding.threadId, '/forbidden'), /workspace/i);
});

test('disable denies new dispatch but keeps the historical identity and directory binding', async () => {
  const { service, disable, registered } = fixture();
  await service.restore();
  const binding = await service.open('owner', request());
  disable();
  await assert.rejects(service.authorize(binding.catId, 'owner', binding.threadId, '/approved/work'), /disabled/i);
  await assert.rejects(service.open('owner', request()), /unavailable|disabled/i);
  const catalog = await service.catalog('owner');
  assert.equal(catalog.contributions[0]!.entities[0]!.availability, 'unavailable');
  assert.equal(catalog.contributions[0]!.entities[0]!.binding!.threadId, binding.threadId);
  assert.equal(registered.get(binding.catId)!.displayName, 'planner');
});

test('native identity inherits current MCP restrictions of its execution template', async () => {
  const { service } = fixture();
  await service.restore();
  const binding = await service.open('owner', request());
  setNativeConversationAuthority(service);
  const capability = {
    id: 'restricted',
    type: 'mcp' as const,
    name: 'Restricted',
    enabled: true,
    blockedCats: ['codex'],
  };
  assert.equal(isMcpEnabledForCat(capability, binding.catId, { accessScope: 'project' }), false);
  capability.blockedCats = [];
  assert.equal(isMcpEnabledForCat(capability, binding.catId, { accessScope: 'project' }), true);
  capability.blockedCats = [binding.catId];
  assert.equal(isMcpEnabledForCat(capability, binding.catId, { accessScope: 'project' }), false);
  assert.equal(isMcpEnabledForCat(capability, 'native-unknown'), false);
});

test('memory storage refuses durable binding and missing canonical threads are not advertised ready', async () => {
  const { service, options } = fixture();
  const temporary = new NativeConversationService({ ...options, storageDurable: false });
  await temporary.restore();
  await assert.rejects(temporary.open('owner', request()), /persistent Host storage/);
  await service.open('owner', request());
  const restarted = new NativeConversationService({ ...options, threads: new ThreadStore() });
  await restarted.restore();
  assert.equal((await restarted.catalog('owner')).contributions[0]!.entities[0]!.availability, 'unavailable');
  await assert.rejects(restarted.open('owner', request()), /thread unavailable/i);
});

test('descriptor rejects duplicate keys and executable payload fields', async () => {
  const { options } = fixture();
  const originalList = options.source.list;
  options.source.list = async () =>
    (await originalList()).map((item) => ({
      ...item,
      descriptor: { ...descriptor, entities: [descriptor.entities[0]!, descriptor.entities[0]!] },
    }));
  await assert.rejects(new NativeConversationService(options).catalog('owner'), /Duplicate entity key/);
  options.source.list = async () =>
    (await originalList()).map((item) => ({ ...item, descriptor: { ...descriptor, command: 'exec' } }));
  await assert.rejects(new NativeConversationService(options).catalog('owner'), /command/);
});

test('compatibility identity strings cannot authorize native execution', async () => {
  const { service } = fixture();
  const binding = await service.open('owner', request());
  setNativeConversationAuthority(service);
  for (const provenance of [undefined, 'unknown', 'compatibility_fallback']) {
    await assert.rejects(
      authorizeNativeConversation(binding.catId, 'owner', binding.threadId, provenance),
      /authenticated owner/,
    );
  }
  await authorizeNativeConversation(binding.catId, 'owner', binding.threadId, 'strict', '/approved/work');
  await assert.rejects(
    authorizeNativeConversation(binding.catId, 'owner', binding.threadId, 'strict', '/changed'),
    /workspace/,
  );
});

test('native facade cannot expose provider control execution outside the guarded composer path', async () => {
  let called = 0;
  const service = nativeConversationAgentFacade({
    async *invoke() {
      called++;
      yield { type: 'text', text: 'done', catId: createCatId('codex'), timestamp: 1 };
    },
    requestNativeReview: async () => {
      throw new Error('must not be exposed');
    },
    requestNativeGoal: async () => {
      throw new Error('must not be exposed');
    },
    requestNativeCompaction: async () => {
      throw new Error('must not be exposed');
    },
    requestNativeFork: async () => {
      throw new Error('must not be exposed');
    },
    openNativeRealtimeCompanion: async () => {
      throw new Error('must not be exposed');
    },
  });
  for (const method of [
    'requestNativeReview',
    'requestNativeGoal',
    'requestNativeCompaction',
    'requestNativeFork',
    'openNativeRealtimeCompanion',
  ])
    assert.equal((service as any)[method], undefined);
  for await (const _message of service.invoke('hello')) {
    /* consume normal execution */
  }
  assert.equal(called, 1);
});
