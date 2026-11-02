/** Wire contracts of the pinned Clowder AI API, not a second domain model. */
export interface NativeCat {
  id: string; name: string; displayName: string; nickname?: string; breedId?: string;
  roleDescription: string; personality?: string; teamStrengths?: string;
  clientId: string; defaultModel: string; configurationSource?: string; accountRef?: string;
  mentionPatterns: string[]; color: { primary: string; secondary: string };
  configurationRevision?: string; resolvedContext?: { windowTokens?: number; inputCeilingTokens?: number };
  [key: string]: unknown;
}
export interface NativeThread {
  id: string; title?: string; preferredCats?: string[]; createdAt: number; updatedAt?: number;
  participants?: string[]; pinned?: boolean; [key: string]: unknown;
}
export interface NativeMessage {
  id: string; type: 'user' | 'assistant' | 'system' | 'connector' | 'summary';
  content: string; catId: string | null; timestamp: number; timelineOrderAt?: number;
  replyTo?: string; isDraft?: boolean; lifecycle?: { kind: string; status?: string; [key: string]: unknown };
  extra?: Record<string, unknown>; toolEvents?: unknown[]; [key: string]: unknown;
}
export interface NativeEvent { threadId?: string; type?: string; seq?: number; seqEpoch?: string; [key: string]: unknown }
export interface NativeTransport {
  request<T = Record<string, unknown>>(path: string, options?: { method?: string; body?: unknown }): Promise<T>;
  subscribe(threadId: string, listener: (event: NativeEvent) => void): Promise<() => void>;
  close(): Promise<void>;
}
