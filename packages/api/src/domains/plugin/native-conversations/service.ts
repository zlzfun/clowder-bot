import { createHash } from 'node:crypto';
import {
  type CatConfig,
  createCatId,
  type NativeConversationCatalog,
  type NativeConversationDescriptor,
  type OpenNativeConversationRequest,
  type OpenNativeConversationResponse,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';

const entity = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500),
    roleInstructions: z.string().min(1).max(8000),
    initials: z.string().min(1).max(8),
    accent: z.enum(['sage', 'amber', 'blue']),
    composerPlaceholder: z.string().max(160),
  })
  .strict();
export const nativeConversationDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    label: z.string().trim().min(1).max(40),
    description: z.string().max(500),
    entities: z.array(entity).min(1).max(32),
  })
  .strict()
  .refine(
    (value) => new Set(value.entities.map((item) => item.key)).size === value.entities.length,
    'Duplicate entity key',
  );

export interface NativeConversationSource {
  pluginId: string;
  pluginInstanceId: string;
  packageDigest: string;
  descriptor: NativeConversationDescriptor;
}
export interface NativeConversationBinding extends NativeConversationSource {
  owner: string;
  entityKey: string;
  executionTemplateId: string;
  workspacePath: string;
  threadId?: string;
  config: CatConfig;
}
export interface NativeConversationOptions {
  threads: Pick<IThreadStore, 'ensureOwnedThread' | 'get' | 'updatePreferredCats'>;
  storageDurable: boolean;
  persistence: {
    load(): Promise<NativeConversationBinding[]>;
    save(records: NativeConversationBinding[]): Promise<void>;
  };
  source: {
    list(): Promise<NativeConversationSource[]>;
    assertActive(source: NativeConversationSource): Promise<void>;
  };
  templates(): Record<string, CatConfig>;
  register(configs: CatConfig[]): Promise<void>;
  validateWorkspace(path: string): Promise<string>;
}

/** Host-owned identity/binding metadata only. Chat, messages and execution remain native. */
export class NativeConversationService {
  private bindings: NativeConversationBinding[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: NativeConversationOptions) {}

  ownsThread(threadId: string): boolean {
    return this.bindings.some((binding) => binding.threadId === threadId);
  }

  async restore(): Promise<void> {
    this.bindings = await this.options.persistence.load();
    for (const binding of this.bindings) {
      if (!binding.config.id.startsWith('native-') || !binding.owner || !binding.workspacePath)
        throw new Error('Invalid native binding snapshot');
      nativeConversationDescriptorSchema.parse(binding.descriptor);
      if (!binding.threadId) await this.finishBinding(binding);
    }
    await this.options.register(this.bindings.map((binding) => binding.config));
  }

  async catalog(owner: string): Promise<NativeConversationCatalog> {
    const active = await this.sources();
    const liveThreads = new Set<string>();
    for (const binding of this.bindings.filter((item) => item.owner === owner && item.threadId)) {
      const thread = await this.options.threads.get(binding.threadId!);
      if (thread && !thread.deletedAt && thread.createdBy === owner && thread.projectPath === binding.workspacePath)
        liveThreads.add(thread.id);
    }
    const sources = new Map(active.map((source) => [source.pluginId, source]));
    for (const binding of this.bindings.filter((item) => item.owner === owner)) {
      if (!sources.has(binding.pluginId)) sources.set(binding.pluginId, binding);
    }
    return {
      schemaVersion: 1,
      storageDurable: this.options.storageDurable,
      executionTemplates: Object.values(this.options.templates()).map((config) => ({
        id: config.id,
        name: config.displayName,
        clientId: config.clientId,
        model: config.defaultModel,
      })),
      contributions: [...sources.values()].map((source) => ({
        pluginId: source.pluginId,
        pluginInstanceId: source.pluginInstanceId,
        label: source.descriptor.label,
        description: source.descriptor.description,
        entities: source.descriptor.entities.map((item) => {
          const binding = this.bindings.find(
            (b) => b.owner === owner && b.pluginId === source.pluginId && b.entityKey === item.key,
          );
          const live = active.find((candidate) => candidate.pluginId === source.pluginId);
          const available =
            live &&
            (!binding ||
              (binding.pluginInstanceId === live.pluginInstanceId &&
                binding.packageDigest === live.packageDigest &&
                liveThreads.has(binding.threadId!) &&
                !!this.options.templates()[binding.executionTemplateId]));
          const { roleInstructions: _, ...view } = item;
          return {
            ...view,
            availability: available
              ? binding
                ? ('ready' as const)
                : ('unconfigured' as const)
              : ('unavailable' as const),
            ...(!available ? { reason: 'Plugin, execution template or accepted conversation unavailable' } : {}),
            ...(binding?.threadId
              ? { binding: { ...this.result(binding), executionTemplateId: binding.executionTemplateId } }
              : {}),
          };
        }),
      })),
    };
  }

  open(owner: string, input: OpenNativeConversationRequest): Promise<OpenNativeConversationResponse> {
    const operation = this.serial.then(() => this.openSerial(owner, input));
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  private async openSerial(
    owner: string,
    input: OpenNativeConversationRequest,
  ): Promise<OpenNativeConversationResponse> {
    if (!this.options.storageDurable)
      throw new Error('Native conversations require persistent Host storage; start the Host with Redis');
    const prior = this.bindings.find(
      (b) => b.owner === owner && b.pluginId === input.pluginId && b.entityKey === input.entityKey,
    );
    if (prior) {
      await this.options.source.assertActive(prior);
      if (input.workspacePath && (await this.options.validateWorkspace(input.workspacePath)) !== prior.workspacePath)
        throw new Error('Workspace binding cannot be changed implicitly');
      if (input.executionTemplateId && input.executionTemplateId !== prior.executionTemplateId)
        throw new Error('Execution template binding cannot be changed implicitly');
      if (!prior.threadId) await this.finishBinding(prior);
      await this.authorize(prior.config.id, owner, prior.threadId!, prior.workspacePath);
      await this.options.register([prior.config]);
      return this.result(prior);
    }
    const source = (await this.sources()).find((item) => item.pluginId === input.pluginId);
    const definition = source?.descriptor.entities.find((item) => item.key === input.entityKey);
    if (!source || !definition) throw new Error('Plugin entity unavailable');
    await this.options.source.assertActive(source);
    const template = input.executionTemplateId && this.options.templates()[input.executionTemplateId];
    if (!template || !input.workspacePath) throw new Error('Choose an available execution template and workspace');
    const workspacePath = await this.options.validateWorkspace(input.workspacePath);
    const digest = createHash('sha256')
      .update(JSON.stringify([owner, source.pluginInstanceId, definition.key]))
      .digest('hex')
      .slice(0, 24);
    const catId = createCatId(`native-${digest}`);
    const binding: NativeConversationBinding = {
      ...source,
      owner,
      entityKey: definition.key,
      workspacePath,
      executionTemplateId: template.id,
      config: {
        ...template,
        id: catId,
        name: definition.name,
        displayName: definition.name,
        nickname: definition.name,
        roleDescription: definition.description,
        personality: definition.roleInstructions,
        mentionPatterns: [`@${catId}`],
        relationshipKey: catId,
        isDefaultVariant: false,
        breedId: catId,
        breedDisplayName: definition.name,
        variantLabel: undefined,
        teamStrengths: definition.description,
      },
    };
    // Persist intent before the idempotent Host thread operation; a crash can safely finish it.
    this.bindings.push(binding);
    try {
      await this.options.persistence.save(this.bindings);
    } catch (error) {
      this.bindings.pop();
      throw error;
    }
    await this.finishBinding(binding);
    await this.options.register([binding.config]);
    return this.result(binding);
  }

  async authorize(catId: string, owner: string, threadId: string, workspacePath?: string): Promise<void> {
    const binding = this.bindings.find((item) => item.config.id === catId);
    if (!binding) throw new Error('Native identity unavailable');
    if (binding.owner !== owner) throw new Error('Native identity owner mismatch');
    if (binding.threadId !== threadId) throw new Error('Native identity thread mismatch');
    const thread = await this.options.threads.get(threadId);
    if (!thread || thread.deletedAt || thread.createdBy !== owner) throw new Error('Native thread unavailable');
    if (thread.projectPath !== binding.workspacePath || (workspacePath && workspacePath !== binding.workspacePath))
      throw new Error('Native identity workspace mismatch');
    if ((await this.options.validateWorkspace(binding.workspacePath)) !== binding.workspacePath)
      throw new Error('Native workspace changed');
    if (!this.options.templates()[binding.executionTemplateId]) throw new Error('Execution template unavailable');
    await this.options.source.assertActive(binding);
  }

  executionTemplateFor(catId: string): string | undefined {
    return this.bindings.find((item) => item.config.id === catId)?.executionTemplateId;
  }

  private async sources(): Promise<NativeConversationSource[]> {
    return (await this.options.source.list()).map((source) => ({
      ...source,
      descriptor: nativeConversationDescriptorSchema.parse(source.descriptor),
    }));
  }
  private async finishBinding(binding: NativeConversationBinding): Promise<void> {
    const thread = await this.options.threads.ensureOwnedThread({
      userId: binding.owner,
      idempotencyKey: `native-conversation:${binding.config.id}`,
      title: binding.config.displayName,
      participants: [binding.config.id],
      projectPath: binding.workspacePath,
    });
    await this.options.threads.updatePreferredCats(thread.id, [binding.config.id]);
    binding.threadId = thread.id;
    await this.options.persistence.save(this.bindings);
  }
  private result(binding: NativeConversationBinding): OpenNativeConversationResponse {
    if (!binding.threadId) throw new Error('Native binding is pending');
    return { threadId: binding.threadId, catId: binding.config.id, workspacePath: binding.workspacePath };
  }
}
