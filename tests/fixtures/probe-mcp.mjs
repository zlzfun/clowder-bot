#!/usr/bin/env node
// A dependency-free MCP server over stdio with one harmless tool. It reads and changes
// nothing; it only reports whether the secret it was configured with reached the process.
// Used to check the 自定义应用 path against a real engine (docs/apps-api.md, "验证").
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const tool = {
  name: 'app_probe',
  description: 'Returns a fixed marker and whether the configured secret reached this process. Reads and changes nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (id === undefined) return; // notifications need no answer
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'app-probe', version: '0.0.1' },
    } });
  } else if (method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
  else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: [tool] } });
  else if (method === 'tools/call' && params?.name === tool.name) {
    const secret = process.env.APP_PROBE_TOKEN ?? '';
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `PROBE-OK-7731 secret=${secret ? 'present' : 'absent'} length=${secret.length}` }] } });
  } else send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
