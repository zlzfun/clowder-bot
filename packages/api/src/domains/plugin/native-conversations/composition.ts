import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NATIVE_CONVERSATION_DESCRIPTOR_TOOL } from '@cat-cafe/shared';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { BuiltinPluginContributionSupervisor } from '../manager/builtin-contribution-supervisor.js';
import {
  type NativeConversationBinding,
  type NativeConversationSource,
  nativeConversationDescriptorSchema,
} from './service.js';

export function nativeConversationPersistence(path: string) {
  return {
    async load(): Promise<NativeConversationBinding[]> {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const value = JSON.parse(text);
      if (value.schemaVersion !== 1 || !Array.isArray(value.bindings))
        throw new Error('Invalid native conversation snapshot');
      return value.bindings;
    },
    async save(bindings: NativeConversationBinding[]): Promise<void> {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, bindings }), {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      await rename(temporary, path);
    },
  };
}

/** A data contribution over the existing supervised MCP transport; never executes an Agent. */
export function nativeConversationPluginSource(
  inventory: PluginInventoryStore,
  supervisor: BuiltinPluginContributionSupervisor | undefined,
) {
  const cache = new Map<string, NativeConversationSource>();
  return {
    async list(): Promise<NativeConversationSource[]> {
      if (!supervisor) return [];
      const snapshot = await inventory.snapshot();
      const result: NativeConversationSource[] = [];
      for (const instance of snapshot.instances) {
        if (instance.lifecycleState !== 'installed' || instance.activationState !== 'enabled') continue;
        try {
          const tool = (await supervisor.listPluginTools(instance.pluginId)).find(
            (item) => item.name === NATIVE_CONVERSATION_DESCRIPTOR_TOOL,
          );
          if (!tool) continue;
          const key = `${instance.pluginInstanceId}:${instance.packageDigest}`;
          let source = cache.get(key);
          if (!source) {
            const output = await supervisor.callPluginTool(instance.pluginId, tool.contributionId, tool.name, {});
            const envelope = output as {
              isError?: boolean;
              structuredContent?: unknown;
              content?: { type: string; text?: string }[];
            };
            if (envelope.isError) continue;
            const descriptor = nativeConversationDescriptorSchema.parse(
              envelope.structuredContent ??
                JSON.parse(envelope.content?.find((item) => item.type === 'text')?.text ?? 'null'),
            );
            source = {
              pluginId: instance.pluginId,
              pluginInstanceId: instance.pluginInstanceId,
              packageDigest: instance.packageDigest,
              descriptor,
            };
            cache.set(key, source);
          }
          result.push(source);
        } catch {
          // One malformed/crashed contribution must not hide other collections.
          // Accepted bindings remain visible as unavailable in the service catalog.
        }
      }
      return result;
    },
    async assertActive(source: NativeConversationSource): Promise<void> {
      const snapshot = await inventory.snapshot();
      const current = snapshot.instances.find(
        (item) => item.pluginId === source.pluginId && item.lifecycleState === 'installed',
      );
      if (
        !supervisor ||
        !current ||
        current.activationState !== 'enabled' ||
        current.pluginInstanceId !== source.pluginInstanceId ||
        current.packageDigest !== source.packageDigest
      )
        throw new Error('Plugin disabled, unavailable or accepted revision changed');
      // This checks live process, package and grant authority at dispatch time.
      const tools = await supervisor.listPluginTools(source.pluginId);
      if (!tools.some((tool) => tool.name === NATIVE_CONVERSATION_DESCRIPTOR_TOOL))
        throw new Error('Plugin contribution unavailable');
    },
  };
}
