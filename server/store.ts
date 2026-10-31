import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppState, Bot, Conversation, Memory } from '../shared/types.js';
import { templates } from './templates.js';

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export interface StoredSession { id: string; conversationId: string; botId: string; provider: string; model: string; createdAt: string; sealedAt?: string; reason?: string }
interface DiskState { version: 1; state: AppState; sessions: StoredSession[]; xbot?: Record<string, any> }

export function makeConversation(title: string, kind: Conversation['kind'], botIds: string[]): Conversation {
  return { id: id('chat'), title, kind, botIds, createdAt: now(), updatedAt: now(), pinned: false,
    status: 'idle', summary: '', compactedMessageCount: 0, contextTokens: 0 };
}

export function makeBot(templateId: string): Bot {
  const template = templates.find(t => t.id === templateId);
  if (!template) throw new Error('未知猫猫模板');
  return { id: id('bot'), templateId, name: template.nickname, description: template.description,
    avatar: template.avatar, color: template.color, persona: template.systemPrompt,
    provider: template.defaultProvider, model: template.defaultModel, createdAt: now() };
}

function seed(): AppState {
  const bots = ['ragdoll', 'maine-coon', 'siamese'].map(makeBot);
  const group = makeConversation('猫猫协作室', 'group', bots.map(b => b.id));
  group.pinned = true;
  return { templates, bots, conversations: [group, ...bots.map(b => makeConversation(b.name, 'direct', [b.id]))],
    messages: [{ id: id('msg'), conversationId: group.id, role: 'system', status: 'complete', kind: 'notice',
      content: '欢迎来到猫猫协作室。宪宪负责架构，砚砚负责审查，烁烁负责创意。当前为演示模式，回复由本地脚本生成；可在设置中接入真实模型。', createdAt: now() }],
    memories: [], settings: { mode: 'demo', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY',
      defaultModel: '', contextBudget: 12000, maxHops: 6, cliWorkingDirectory: process.cwd() } };
}

export class Store {
  state: AppState;
  sessions: StoredSession[] = [];
  /** Original XBot UI metadata; independent from the core API's public state. */
  xbot: Record<string, any> = {};
  readonly file: string;
  constructor(file = resolve(process.env.CLOWDER_DATA_DIR ?? 'data', 'state.json')) {
    this.file = file;
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as DiskState;
      if (parsed.version !== 1 || !parsed.state || !Array.isArray(parsed.state.bots) ||
        !Array.isArray(parsed.state.conversations) || !Array.isArray(parsed.state.messages) ||
        !Array.isArray(parsed.state.memories) || !parsed.state.settings) {
        throw new Error(`数据文件格式不受支持：${file}。原文件已保留，请备份后修复。`);
      }
      this.state = parsed.state;
      this.state.templates = templates;
      this.sessions = parsed.sessions ?? [];
      this.xbot = parsed.xbot ?? {};
      // An interrupted process must not leave phantom running cats.
      for (const conversation of this.state.conversations) {
        if (conversation.status === 'running') {
          conversation.status = 'idle';
          delete conversation.activeBotId;
          this.state.messages.push({ id: id('msg'), conversationId: conversation.id, role: 'system', status: 'complete',
            kind: 'notice', content: '服务已重新启动，上次未完成的回复已停止。可以继续发送消息。', createdAt: now() });
        }
      }
      for (const message of this.state.messages) if (message.status === 'streaming') message.status = 'cancelled';
    } else this.state = seed();
    this.save();
  }
  snapshot(): AppState { return structuredClone(this.state); }
  save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, state: this.state, sessions: this.sessions, xbot: this.xbot } satisfies DiskState), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  sealSessions(conversationId: string, reason: string, botId?: string): void {
    for (const session of this.sessions) if (session.conversationId === conversationId && !session.sealedAt && (!botId || session.botId === botId)) {
      session.sealedAt = now(); session.reason = reason;
    }
  }
  remember(input: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Memory {
    const existing = this.state.memories.find(m => m.scope === input.scope && m.botId === input.botId &&
      m.conversationId === input.conversationId && m.content === input.content);
    if (existing) { existing.updatedAt = now(); return existing; }
    if (this.state.memories.length >= 5000) throw new Error('记忆条目已达上限，请清理旧记忆');
    if (this.state.memories.length >= 5000) throw new Error('记忆条目已达上限，请清理旧记忆');
    const memory: Memory = { ...input, id: id('mem'), createdAt: now(), updatedAt: now() };
    this.state.memories.push(memory);
    return memory;
  }
}
