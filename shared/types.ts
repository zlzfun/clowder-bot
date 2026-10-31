export type ProviderKind = 'demo' | 'openai' | 'claude-cli' | 'codex-cli' | 'gemini-cli';
export interface BotTemplate {
  id: string; name: string; nickname: string; role: string; description: string;
  personality: string; strengths: string[]; avatar: string; color: string;
  defaultProvider: ProviderKind; defaultModel: string; systemPrompt: string;
}
export interface Bot {
  id: string; templateId: string; name: string; description: string; avatar: string;
  color: string; persona: string; provider: ProviderKind; model: string;
  createdAt: string;
}
export interface Message {
  id: string; conversationId: string; role: 'user' | 'assistant' | 'system';
  botId?: string; content: string; createdAt: string;
  status: 'complete' | 'streaming' | 'error' | 'cancelled';
  kind?: 'chat' | 'handoff' | 'compaction' | 'notice';
  runId?: string; targetBotId?: string;
}
export interface Conversation {
  id: string; title: string; kind: 'direct' | 'group'; botIds: string[];
  createdAt: string; updatedAt: string; pinned: boolean;
  status: 'idle' | 'running' | 'error'; activeBotId?: string;
  summary: string; compactedMessageCount: number; contextTokens: number;
}
export interface Memory {
  id: string; scope: 'shared' | 'bot' | 'conversation'; botId?: string; conversationId?: string;
  content: string; tags: string[]; createdAt: string; updatedAt: string;
  source: 'user' | 'agent';
}
export interface Settings {
  mode: 'demo' | 'live'; baseUrl: string; apiKeyEnv: string; defaultModel: string;
  contextBudget: number; maxHops: number; cliWorkingDirectory: string;
}
export interface AppState {
  templates: BotTemplate[]; bots: Bot[]; conversations: Conversation[];
  messages: Message[]; memories: Memory[]; settings: Settings;
}
export interface DeltaEvent { conversationId: string; messageId: string; delta: string }
export interface ProviderMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface AgentRequest {
  bot: Bot; messages: ProviderMessage[]; settings: Settings;
  signal: AbortSignal; sessionId?: string;
}
export type AgentEvent = { type: 'delta'; text: string } | { type: 'session'; sessionId: string };
export interface AgentProvider { stream(request: AgentRequest): AsyncIterable<AgentEvent> }
