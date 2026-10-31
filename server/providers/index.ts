import type { AgentProvider, ProviderKind } from '../../shared/types.js';
import { CliProvider } from './cli.js';
import { DemoProvider } from './demo.js';
import { OpenAIProvider } from './openai.js';

export function getProvider(kind: ProviderKind): AgentProvider {
  switch (kind) {
    case 'demo': return new DemoProvider();
    case 'openai': return new OpenAIProvider();
    case 'claude-cli': case 'codex-cli': case 'gemini-cli': return new CliProvider(kind);
    default: throw new Error(`不支持的接入方式：${String(kind)}`);
  }
}
