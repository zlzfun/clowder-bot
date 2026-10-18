/** Experimental v1: plugin-owned identity/directory data, Host-owned conversation/runtime. */
export const NATIVE_CONVERSATION_DESCRIPTOR_TOOL = 'clowder_native_conversations_v1';

export interface NativeConversationEntityDefinition {
  key: string;
  name: string;
  description: string;
  roleInstructions: string;
  initials: string;
  accent: 'sage' | 'amber' | 'blue';
  composerPlaceholder: string;
}

/** Returned by an enabled plugin's supervised MCP contribution. Data only, never executable UI. */
export interface NativeConversationDescriptor {
  schemaVersion: 1;
  label: string;
  description: string;
  entities: NativeConversationEntityDefinition[];
}

export interface NativeConversationEntityView {
  key: string;
  name: string;
  description: string;
  initials: string;
  accent: NativeConversationEntityDefinition['accent'];
  composerPlaceholder: string;
  availability: 'ready' | 'unconfigured' | 'unavailable';
  reason?: string;
  binding?: {
    threadId: string;
    catId: string;
    workspacePath: string;
    executionTemplateId: string;
  };
}

export interface NativeConversationContributionView {
  pluginId: string;
  pluginInstanceId: string;
  label: string;
  description: string;
  entities: NativeConversationEntityView[];
}

export interface NativeConversationCatalog {
  schemaVersion: 1;
  contributions: NativeConversationContributionView[];
  executionTemplates: { id: string; name: string; clientId: string; model: string }[];
  storageDurable: boolean;
}

export interface OpenNativeConversationRequest {
  pluginId: string;
  entityKey: string;
  /** Required only when the owner first binds this entity. */
  executionTemplateId?: string;
  workspacePath?: string;
}

export interface OpenNativeConversationResponse {
  threadId: string;
  catId: string;
  workspacePath: string;
}
