import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, AgentRequest } from '../shared/types.js';
import { completionUrl, OpenAIProvider, parseSse } from '../server/providers/openai.js';
import { buildCliCommand, CliEventParser, CliProvider } from '../server/providers/cli.js';

const originalKey = process.env.CLOWDER_TEST_KEY;
process.env.CLOWDER_TEST_KEY = 'fixture-key';
after(() => { if (originalKey === undefined) delete process.env.CLOWDER_TEST_KEY; else process.env.CLOWDER_TEST_KEY = originalKey; });
function request(): AgentRequest {
  return {
    bot: { id: 'test', name: '猫猫', templateId: 'ragdoll', description: '', avatar: '', color: '', persona: '认真回答', provider: 'openai', model: 'fixture-model', createdAt: '' },
    settings: { mode: 'live', baseUrl: 'https://api.example.test/v1/', apiKeyEnv: 'CLOWDER_TEST_KEY', defaultModel: '', contextBudget: 8000, maxHops: 3, cliWorkingDirectory: '/private/tmp' },
    messages: [{ role: 'system', content: '认真回答' }, { role: 'user', content: '你好' }], signal: new AbortController().signal,
  };
}
async function collect(source: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of source) result.push(event); return result; }
function bytes(text: string, step = 7) {
  const value = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < value.length; i += step) controller.enqueue(value.slice(i, i + step));
    controller.close();
  } });
}
const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\r\n\r\n`;
const stop = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test('normalizes a compatibility endpoint and rejects URL credentials', () => {
  assert.equal(completionUrl('https://example.test/v1/'), 'https://example.test/v1/chat/completions');
  assert.equal(completionUrl('http://localhost:1234/v1/chat/completions/'), 'http://localhost:1234/v1/chat/completions');
  assert.throws(() => completionUrl('https://key@example.test/v1'), /HTTP/);
});
test('SSE handles split UTF-8, CRLF, comments, multiline data, and EOF', async () => {
  const frames: string[] = [];
  for await (const value of parseSse(bytes(': ping\r\ndata: 猫\r\ndata: 猫\r\n\r\ndata: done', 1))) frames.push(value);
  assert.deepEqual(frames, ['猫\n猫', 'done']);
});
test('API streams only content and sends bounded context with an environment key', async () => {
  const provider = new OpenAIProvider(async (url, init) => {
    assert.equal(url, 'https://api.example.test/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'fixture-model');
    assert.deepEqual(body.messages, request().messages);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-key');
    return new Response(bytes(sse('你好') + sse('，猫猫。') + stop, 1));
  });
  assert.deepEqual(await collect(provider.stream(request())), [{ type: 'delta', text: '你好' }, { type: 'delta', text: '，猫猫。' }]);
});
test('API rejects missing key, failed status, malformed frames, early EOF and truncation', async () => {
  const noKey = request(); noKey.settings.apiKeyEnv = 'CLOWDER_TEST_ABSENT_KEY';
  await assert.rejects(collect(new OpenAIProvider().stream(noKey)), /环境变量/);
  for (const [response, pattern] of [
    [new Response('secret', { status: 401 }), /HTTP 401/],
    [new Response(bytes('data: invalid\n\n')), /无法解析/],
    [new Response(bytes(sse('partial'))), /提前结束/],
    [new Response(bytes(sse('partial') + 'data: {"choices":[{"finish_reason":"length"}]}\n\n')), /长度限制/],
    [new Response(bytes('data: {"error":{"message":"fixture-key bad key"}}\n\n')), /已隐藏密钥/],
  ] as const) await assert.rejects(collect(new OpenAIProvider(async () => response).stream(request())), pattern);
});
test('API forwards cancellation and cancels stream readers on early consumer return', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(sse('first'))); }, cancel() { cancelled = true; } });
  const iterator = new OpenAIProvider(async () => new Response(body)).stream(request());
  assert.equal((await iterator.next()).value?.type, 'delta');
  await iterator.return(undefined);
  assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort(new Error('fixture cancellation'));
  await assert.rejects(collect(new OpenAIProvider().stream({ ...request(), signal: controller.signal })), /fixture cancellation/);
});
test('API timeout and midstream cancellation abort the pending transport', async () => {
  const stalledFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('fixture did not abort')), 100);
    init?.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal?.reason); }, { once: true });
  });
  await assert.rejects(collect(new OpenAIProvider(stalledFetch, 5).stream(request())), /响应超时/);
  const controller = new AbortController();
  const provider = new OpenAIProvider(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode(sse('partial')));
      init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), { once: true });
      setImmediate(() => controller.abort(new Error('midstream cancellation')));
    },
  })));
  await assert.rejects(collect(provider.stream({ ...request(), signal: controller.signal })), /midstream cancellation/);
});

test('Claude partial and final text are deduplicated by message identity', () => {
  const parser = new CliEventParser('claude-cli');
  assert.deepEqual(parser.parse({ type: 'system', subtype: 'init', session_id: 's1' }), [{ type: 'session', sessionId: 's1' }]);
  parser.parse({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  assert.deepEqual(parser.parse({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } }), [{ type: 'delta', text: '你好' }]);
  assert.deepEqual(parser.parse({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '你好！' }] } }), [{ type: 'delta', text: '！' }]);
  assert.deepEqual(parser.parse({ type: 'result', subtype: 'success', result: '你好！' }), []);
  assert.equal(parser.complete, true);
});
test('Codex sessions, message boundaries, errors and final events stay distinct', () => {
  const parser = new CliEventParser('codex-cli');
  assert.deepEqual(parser.parse({ type: 'thread.started', thread_id: 'c1' }), [{ type: 'session', sessionId: 'c1' }]);
  parser.parse({ type: 'item.agent_message.delta', item_id: 'i1', delta: 'hello' });
  assert.deepEqual(parser.parse({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hello' } }), []);
  assert.deepEqual(parser.parse({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } }), [{ type: 'delta', text: '\n\ndone' }]);
  assert.deepEqual(parser.parse({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', text: 'hidden' } }), []);
  parser.parse({ type: 'turn.completed' }); assert.equal(parser.complete, true);
  assert.throws(() => parser.parse({ type: 'turn.failed', error: { message: 'failure' } }), /failure/);
});
test('Gemini suppresses user messages and preserves assistant deltas', () => {
  const parser = new CliEventParser('gemini-cli');
  assert.deepEqual(parser.parse({ type: 'message', role: 'user', content: 'hidden' }), []);
  parser.parse({ type: 'message', role: 'assistant', content: 'one', delta: true });
  assert.deepEqual(parser.parse({ type: 'message', role: 'assistant', content: ' two', delta: true }), [{ type: 'delta', text: ' two' }]);
  parser.parse({ type: 'result', status: 'success' }); assert.equal(parser.complete, true);
  assert.throws(() => parser.parse({ type: 'result', status: 'error', error: 'failed' }), /failed/);
});
test('CLI argv keeps prompts out of process listings and does not bypass permissions', () => {
  for (const kind of ['claude-cli', 'codex-cli', 'gemini-cli'] as const) {
    const { args } = buildCliCommand(kind, 'test model');
    assert.ok(args.includes('test model'));
    assert.ok(!args.some(arg => /yolo|bypass|full-auto|resume/.test(arg)));
    assert.ok(!args.some(arg => ['--tools', '--permission-mode', '--sandbox'].includes(arg)));
  }
});

function fakeProcess(run: (child: ChildProcessWithoutNullStreams, input: () => string) => void) {
  const emitter = new EventEmitter();
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let input = ''; stdin.on('data', data => { input += data.toString(); });
  const child = Object.assign(emitter, { stdin, stdout, stderr, pid: undefined, kill: () => {
    stdout.end(); stderr.end(); emitter.emit('close', null); return true;
  } }) as unknown as ChildProcessWithoutNullStreams;
  stdin.once('finish', () => setImmediate(() => run(child, () => input)));
  return child;
}
test('spawn transport parses chunked NDJSON and sends context over stdin', async () => {
  const provider = new CliProvider('codex-cli', (command, args, options) => {
    assert.equal(command, 'codex'); assert.equal(options.shell, false);
    return fakeProcess((child, input) => {
      assert.match(input(), /SYSTEM:\n认真回答/); assert.match(input(), /USER:\n你好/);
      const payload = Buffer.from('{"type":"thread.started","thread_id":"s"}\n{"type":"item.completed","item":{"type":"agent_message","id":"i","text":"猫猫"}}\n{"type":"turn.completed"}');
      for (let i = 0; i < payload.length; i += 3) child.stdout.push(payload.subarray(i, i + 3));
      child.stdout.push(null); child.emit('close', 0);
    });
  });
  assert.deepEqual(await collect(provider.stream(request())), [{ type: 'session', sessionId: 's' }, { type: 'delta', text: '猫猫' }]);
});
test('spawn transport reports missing CLI and missing completion instead of falling back', async () => {
  const missing = new CliProvider('claude-cli', () => fakeProcess(child => {
    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); child.stdout.push(null); child.emit('close', -2);
  }));
  await assert.rejects(collect(missing.stream(request())), /未找到 claude CLI/);
  const incomplete = new CliProvider('codex-cli', () => fakeProcess(child => { child.stdout.push(null); child.emit('close', 0); }));
  await assert.rejects(collect(incomplete.stream(request())), /未收到回合完成事件/);
});
test('spawn cancellation terminates an active child and exposes cancellation', async () => {
  const controller = new AbortController(); let killed = false;
  const provider = new CliProvider('codex-cli', () => {
    const child = fakeProcess(() => { controller.abort(new Error('cancelled by test')); });
    const kill = child.kill.bind(child); child.kill = signal => { killed = true; return kill(signal); };
    return child;
  });
  await assert.rejects(collect(provider.stream({ ...request(), signal: controller.signal })), /cancelled by test/);
  assert.equal(killed, true);
});
test('spawn timeout terminates a stalled process', async () => {
  let killed = false;
  const provider = new CliProvider('gemini-cli', () => {
    const keepAlive = setTimeout(() => undefined, 100);
    const child = fakeProcess(() => undefined);
    const kill = child.kill.bind(child);
    child.kill = signal => { killed = true; clearTimeout(keepAlive); return kill(signal); };
    return child;
  }, 5);
  await assert.rejects(collect(provider.stream(request())), /响应超时/);
  assert.equal(killed, true);
});
