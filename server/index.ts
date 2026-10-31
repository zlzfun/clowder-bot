import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口号');
const runtime = createApp();
const server = runtime.app.listen(port, '127.0.0.1', () => {
  console.log(`🐾 clowder-bot listening on http://127.0.0.1:${port} (${runtime.store.state.settings.mode})`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  void runtime.close().finally(() => server.close(() => process.exit(0)));
});
