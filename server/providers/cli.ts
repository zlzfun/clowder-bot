/**
 * CLI protocol adapter, adapted from Clowder AI's Claude/Codex event transforms.
 * Copyright (c) 2026 Clowder AI Contributors. MIT; see docs/provider-reference.md.
 * Each invocation replays our bounded context; native session IDs are provenance only.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentEvent, AgentProvider, AgentRequest, ProviderKind } from '../../shared/types.js';

export type CliKind = Extract<ProviderKind, 'claude-cli' | 'codex-cli' | 'gemini-cli'>;
type SpawnProcess = (command: string, args: string[], options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams;

export function buildCliCommand(kind: CliKind, model: string): { command: string; args: string[] } {
  const modelArgs = model.trim() ? ['--model', model.trim()] : [];
  if (kind === 'claude-cli') return {
    command: 'claude', args: ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...modelArgs],
  };
  if (kind === 'codex-cli') return {
    command: 'codex', args: ['exec', '--json', '--skip-git-repo-check', ...modelArgs, '-'],
  };
  return {
    // Gemini plan mode can automatically transition to YOLO in headless mode;
    // explicit default preserves normal approval handling instead.
    command: 'gemini', args: ['--output-format', 'stream-json', '--approval-mode', 'default', ...modelArgs],
  };
}

export function cliPrompt(request: AgentRequest): string {
  return request.messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
}

function failure(event: any): Error {
  const message = typeof event?.message === 'string' ? event.message
    : typeof event?.error?.message === 'string' ? event.error.message
    : typeof event?.error === 'string' ? event.error
    : typeof event?.result === 'string' ? event.result : '本地 Agent 未能完成回复。';
  return new Error(message.replace(/\bsk-[\w-]+/g, '[已隐藏密钥]').slice(0, 500));
}

/** Maintains per-message identity so a final snapshot never duplicates streamed text. */
export class CliEventParser {
  complete = false;
  textLength = 0;
  private currentId = 'default';
  private lastOutputId: string | undefined;
  private texts = new Map<string, string>();
  private seenSessions = new Set<string>();
  constructor(private readonly kind: CliKind) {}

  private text(id: string, value: unknown, snapshot = false): AgentEvent[] {
    if (typeof value !== 'string' || !value) return [];
    const previous = this.texts.get(id) ?? '';
    if (snapshot && previous && !value.startsWith(previous)) {
      throw new Error('Agent 的最终文本与已接收的增量不一致，无法安全合并。');
    }
    const delta = snapshot ? value.slice(previous.length) : value;
    this.texts.set(id, snapshot ? value : previous + value);
    if (!delta) return [];
    const separator = this.lastOutputId !== undefined && this.lastOutputId !== id ? '\n\n' : '';
    this.lastOutputId = id;
    this.textLength += delta.length;
    if (this.textLength > 4_194_304) throw new Error('Agent 回复超过长度限制，已停止。');
    return [{ type: 'delta', text: separator + delta }];
  }

  parse(event: any): AgentEvent[] {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Agent 返回了无效的 JSON 事件。');
    const sessionId = event.type === 'thread.started' ? event.thread_id
      : (event.type === 'system' && event.subtype === 'init') || event.type === 'init' ? event.session_id : undefined;
    if (typeof sessionId === 'string' && !this.seenSessions.has(sessionId)) {
      this.seenSessions.add(sessionId);
      return [{ type: 'session', sessionId }];
    }
    if (event.type === 'error' || event.type === 'turn.failed') throw failure(event);
    if (this.kind === 'claude-cli') {
      if (event.type === 'stream_event') {
        const inner = event.event;
        if (inner?.type === 'message_start' && typeof inner.message?.id === 'string') this.currentId = inner.message.id;
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          return this.text(this.currentId, inner.delta.text);
        }
      }
      if (event.type === 'assistant') {
        if (event.error || event.message?.model === '<synthetic>') throw failure(event);
        const blocks = event.message?.content;
        const value = Array.isArray(blocks) ? blocks.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('') : '';
        return this.text(event.message?.id ?? this.currentId, value, true);
      }
      if (event.type === 'result') {
        if (event.is_error || (event.subtype && event.subtype !== 'success')) throw failure(event);
        this.complete = true;
        return this.textLength ? [] : this.text('result', event.result, true);
      }
    } else if (this.kind === 'codex-cli') {
      if (event.type === 'item.agent_message.delta') return this.text(event.item_id ?? 'default', event.delta);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        return this.text(event.item.id ?? 'default', event.item.text, true);
      }
      if (event.type === 'turn.completed') this.complete = true;
    } else {
      if (event.type === 'message' && event.role === 'assistant') return this.text('gemini', event.content, event.delta !== true);
      if (event.type === 'result') {
        if (event.status === 'error' || event.error) throw failure(event);
        this.complete = true;
      }
    }
    return [];
  }
}

export class CliProvider implements AgentProvider {
  constructor(private readonly kind: CliKind,
    private readonly spawnProcess: SpawnProcess = (command, args, options) => spawn(command, args, options),
    private readonly timeoutMs = 180_000) {}

  async *stream(request: AgentRequest): AsyncGenerator<AgentEvent> {
    request.signal.throwIfAborted();
    const cwd = resolve(request.settings.cliWorkingDirectory || process.cwd());
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error('Agent 工作目录不存在，请在设置中修改。');
    request.signal.throwIfAborted();
    const { command, args } = buildCliCommand(this.kind, request.bot.model);
    const child = this.spawnProcess(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    let closed = false;
    let stderr = '';
    let abortReason: unknown;
    let killTimer: NodeJS.Timeout | undefined;
    const completion = new Promise<{ code: number | null; error?: Error }>(done => {
      child.once('error', error => done({ code: null, error }));
      child.once('close', code => { closed = true; done({ code }); });
    });
    const kill = (signal: NodeJS.Signals) => {
      if (closed) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { child.kill(signal); }
    };
    const stop = (reason: unknown) => {
      abortReason = reason;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
      child.stdout.destroy(reason instanceof Error ? reason : new Error('已停止回复。'));
    };
    const onAbort = () => stop(request.signal.reason ?? new Error('已停止回复。'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(new Error(`${command} 响应超时，已停止进程。`)), this.timeoutMs);
    timer.unref();
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
    child.stdin.on('error', () => undefined); // EPIPE is diagnosed by the process exit/error.
    child.stdin.end(cliPrompt(request));
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const parser = new CliEventParser(this.kind);
    const parseLine = (line: string): AgentEvent[] => {
      if (!line.trim()) return [];
      if (line.length > 1_048_576) throw new Error('Agent 输出的单行事件过大。');
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new Error(`${command} 返回了无效的 JSON 行，请检查 CLI 版本。`); }
      return parser.parse(value);
    };
    try {
      if (request.signal.aborted) onAbort();
      for await (const chunk of child.stdout) {
        pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let index: number;
        while ((index = pending.indexOf('\n')) !== -1) {
          yield* parseLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
        if (pending.length > 1_048_576) throw new Error('Agent 输出的单行事件过大。');
      }
      pending += decoder.end();
      if (pending.trim()) yield* parseLine(pending);
      const result = await completion;
      if (abortReason) throw abortReason;
      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`未找到 ${command} CLI。请先安装并在终端登录，或为猫猫选择 API 接入。`);
        throw new Error(`${command} 启动失败：${result.error.message}`);
      }
      if (result.code !== 0) {
        // Classify a bounded stderr tail without exposing raw environment values or prompts.
        const hint = /auth|login|api.?key|credential|unauthorized/i.test(stderr) ? '请先在终端完成登录或配置密钥。'
          : /permission|approval|denied/i.test(stderr) ? '操作被 CLI 权限策略拒绝。'
          : /unknown|unrecognized|argument|option/i.test(stderr) ? '请检查 CLI 版本与参数兼容性。' : '请在终端检查 CLI 配置。';
        throw new Error(`${command} 退出（${result.code ?? '信号中断'}）。${hint}`);
      }
      if (!parser.complete) throw new Error(`${command} 连接提前结束，未收到回合完成事件。`);
      if (!parser.textLength) throw new Error(`${command} 返回了空回复。`);
    } catch (error) {
      if (abortReason) throw abortReason;
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      if (!closed) {
        kill('SIGTERM');
        killTimer ??= setTimeout(() => kill('SIGKILL'), 1000);
        killTimer.unref();
        void completion.then(() => { if (killTimer) clearTimeout(killTimer); });
      } else if (killTimer) clearTimeout(killTimer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}
