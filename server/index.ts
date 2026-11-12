import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口号');
const runtime = createApp();
const server = runtime.app.listen(port, '127.0.0.1', () => {
  console.log(`🐾 clowder-bot listening on http://127.0.0.1:${port} (native Clowder AI)`);
});
// Every cat talks the way a chat is talked in from the start, also one the engine wakes by itself (a reminder).
// The engine may still be starting; sending a message asks again in any case.
void (async () => {
  for (let tries = 0; tries < 24 && !await runtime.bridge.manner.ensure(); tries++) await new Promise(done => setTimeout(done, 5000).unref());
})();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  void runtime.close().finally(() => server.close(() => process.exit(0)));
});
