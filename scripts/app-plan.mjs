// What `npm run app` should do, decided from what is already on this machine.
// Pure, so the decisions can be tested without ports, builds or processes.

/**
 * @param {{
 *   bot: 'ours' | 'other' | 'free',      // who answers on the Bot's port
 *   native: 'ours' | 'other' | 'free',   // who answers on the engine's port
 *   busy: number[],                      // other ports this launcher needs (Redis, metrics) that are taken
 *   ports: { bot: number, native: number },
 *   runtimeBuilt: boolean,               // the engine build exists and matches upstream.lock.json
 *   frontendBuilt: boolean,              // dist/client exists
 *   frontendStale: boolean,              // client/ changed after it was built
 *   build: boolean,                      // false with --no-build
 * }} state
 * @returns {{ action: 'open' } | { action: 'stop', reason: string } | { action: 'run', steps: Array<'prepare' | 'build' | 'native' | 'bot'> }}
 */
export function launchPlan(state) {
  // Already running: only show it. Building now would swap the page under a server that has not restarted.
  if (state.bot === 'ours') return { action: 'open' };
  if (state.bot === 'other') return { action: 'stop', reason: `端口 ${state.ports.bot} 被别的程序占用。关掉它，或在 .env 里把 PORT 改成别的端口。` };
  if (state.native === 'other') return { action: 'stop', reason: `端口 ${state.ports.native} 被别的程序占用。关掉它，或在 .env 里把 BOT_NATIVE_PORT 改成别的端口。` };
  const steps = [];
  const frontend = !state.frontendBuilt || state.frontendStale;
  if (frontend && !state.build && !state.frontendBuilt) return { action: 'stop', reason: '界面还没有构建过。去掉 --no-build 再运行一次。' };
  if (state.native === 'ours') {
    // The engine was started separately (npm run runtime:start): only the app itself is missing.
    if (frontend && state.build) steps.push('build');
    return { action: 'run', steps: [...steps, 'bot'] };
  }
  if (state.busy.length) return { action: 'stop', reason: `端口 ${state.busy.join('、')} 被别的程序占用，运行环境起不来。关掉占用它的程序，或在 .env 里换端口（见 .env.example）。` };
  if (!state.runtimeBuilt) steps.push('prepare');
  if (frontend && state.build) steps.push('build');
  return { action: 'run', steps: [...steps, 'native', 'bot'] };
}

/** The page needs building when any source is newer than what was built. Times are mtimes in ms. */
export function frontendStale(sourceTimes, builtTime) {
  return builtTime === undefined || sourceTimes.some(time => time > builtTime);
}
