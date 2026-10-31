import type { AgentEvent, AgentProvider, AgentRequest } from '../../shared/types.js';

const MAX_FRAME = 1_048_576;
const MAX_OUTPUT = 4_194_304;

export function completionUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('模型服务地址不是有效的 URL。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('模型服务地址应为不含密钥或查询参数的 HTTP(S) 地址。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.toString();
}

/** SSE lines are decoded incrementally: network chunks need not align to UTF-8 or events. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let frameSize = 0;
  function accept(line: string): string | undefined {
    if (line === '') {
      const frame = data.length ? data.join('\n') : undefined;
      data = []; frameSize = 0;
      return frame;
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      frameSize += value.length;
      if (frameSize > MAX_FRAME) throw new Error('模型服务返回的单条事件过大。');
      data.push(value);
    }
    return undefined;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = pending.indexOf('\n')) !== -1) {
        const frame = accept(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
        if (frame !== undefined) yield frame;
      }
      if (pending.length > MAX_FRAME) throw new Error('模型服务返回的事件行过大。');
      if (done) {
        if (pending) accept(pending.replace(/\r$/, ''));
        const frame = accept('');
        if (frame !== undefined) yield frame;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function safeError(value: unknown, key: string): string {
  const message = typeof value === 'string' ? value : '请检查模型名称、服务地址和密钥权限。';
  return message.split(key).join('[已隐藏密钥]').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 400);
}

export class OpenAIProvider implements AgentProvider {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 120_000) {}

  async *stream(request: AgentRequest): AsyncGenerator<AgentEvent> {
    request.signal.throwIfAborted();
    const { settings, bot } = request;
    const key = process.env[settings.apiKeyEnv]?.trim();
    if (!key) throw new Error(`未找到环境变量 ${settings.apiKeyEnv}。设置密钥并重启服务后再试。`);
    const model = bot.model.trim() || settings.defaultModel.trim();
    if (!model) throw new Error('请先为这只猫猫配置模型名称。');
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('模型服务响应超时，请稍后重试。')), this.timeoutMs);
    timer.unref();
    let textLength = 0;
    let finished = false;
    try {
      const response = await this.fetcher(completionUrl(settings.baseUrl), {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: request.messages, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // Do not dump provider response bodies: they can contain prompts or credentials.
        await response.body?.cancel();
        throw new Error(`模型服务返回 HTTP ${response.status}。请检查模型名称、服务地址和密钥权限。`);
      }
      if (!response.body) throw new Error('模型服务没有返回响应流。');
      for await (const frame of parseSse(response.body)) {
        controller.signal.throwIfAborted();
        if (frame.trim() === '[DONE]') { finished = true; break; }
        let event: any;
        try { event = JSON.parse(frame); } catch { throw new Error('模型服务返回了无法解析的流式事件。'); }
        if (!event || typeof event !== 'object') throw new Error('模型服务返回了无效事件。');
        if (event.error) throw new Error(`模型服务错误：${safeError(event.error.message, key)}`);
        const choice = Array.isArray(event.choices) ? event.choices.find((item: any) => item.index === 0) ?? event.choices[0] : undefined;
        if (!choice) continue; // Usage-only final chunks are valid.
        const delta = choice.delta?.content;
        if (typeof delta === 'string' && delta) {
          textLength += delta.length;
          if (textLength > MAX_OUTPUT) throw new Error('模型回复超过长度限制，已停止。');
          yield { type: 'delta', text: delta };
        }
        if (choice.finish_reason != null) {
          if (choice.finish_reason !== 'stop') {
            throw new Error(choice.finish_reason === 'length' ? '模型回复因长度限制而中断。' : `模型未正常完成回复（${String(choice.finish_reason).slice(0, 60)}）。`);
          }
          finished = true;
        }
      }
      controller.signal.throwIfAborted();
      if (!finished) throw new Error('模型连接提前结束，回复可能不完整。');
      if (!textLength) throw new Error('模型返回了空回复。');
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
