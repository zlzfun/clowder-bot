import { ApiError } from '../server/errors.js';

// The engine routes behind 应用, as the pinned upstream answered them on the isolated runtime on 2026-11-26
// (docs/apps-api.md, "上游的实际行为"): shapes, the masked secrets, what is NOT checked (ids, empty commands,
// overwriting), the plugin's lifecycle revision, and the operation defect that makes every action after the
// first fail until the operation state is reset. Scripted, so a test or the preview can put it in any state.

const MASK = '••••••';
export const WECHAT_DISCLOSURE = '不会保存截图。识别出的微信文字会进入当前猫的模型上下文和 Clowder AI invocation trace。按联系人读取由你在当前 thread 逐次授权；执行时会短暂切到微信，可能清除目标会话未读，并在结束后尽力恢复原会话、滚动位置与前台 app。';
const PLUGIN = 'official.wechat-visible-reader', OPERATION = 'visibleReadingAuthorization';

interface Server { transport: string; command: string; args: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> }
interface Row { id: string; type: string; source: string; enabled: boolean; globalEnabled?: boolean; mcpServer: Server }
export interface ScriptedPlugin {
  artifact: 'absent' | 'installed' | 'quarantined'; intent: 'disabled' | 'enabled';
  live: 'stopped' | 'starting' | 'running' | 'crashed'; lifecycleRevision: number;
  diagnostic: { code: string; message: string } | null; activationFailed: boolean | null; setEnabled: boolean;
}
const masked = (record?: Record<string, string>) => record && Object.fromEntries(Object.keys(record).map(key => [key, MASK]));
const core = (id: string): Row => ({ id, type: 'mcp', source: 'cat-cafe', enabled: true, globalEnabled: true, mcpServer: { transport: 'stdio', command: 'node', args: [`dist/${id}.js`] } });

export class NativeAppsScript {
  rows: Row[] = ['cat-cafe-collab', 'cat-cafe-memory'].map(core);
  /** How a probe of an app answers; by default a program whose name says it is missing fails, port 9 refuses, the rest connect. */
  probes: Record<string, { connectionStatus: string; tools?: Array<{ name: string; description?: string }>; error?: string }> = {};
  /** `null`: the engine has no such plugin at all (404). */
  plugin: ScriptedPlugin | null = { artifact: 'installed', intent: 'disabled', live: 'stopped', lifecycleRevision: 4, diagnostic: null, activationFailed: null, setEnabled: true };
  /** What an enable does: `ok` runs at once; `slow` stays `starting` for this many reads; `fail` ends disabled with a diagnostic; `timeout` runs but the request is cut. */
  start: 'ok' | 'fail' | 'timeout' | number = 'ok';
  /** Reads left before a `starting` plugin is `running`. */
  pending = 0;
  private armedUntil = 0;
  /** The engine's own step pointer for the operation. While set, the plugin refuses every action. */
  operationState: string | null = null;
  now: () => number = () => Date.now();

  private view(row: Row) {
    const { env, headers, ...server } = row.mcpServer;
    return { ...row, mcpServer: { ...server, ...(env ? { env: masked(env), envKeys: Object.keys(env) } : {}), ...(headers ? { headers: masked(headers) } : {}) } };
  }
  /** When set, every probe answers this (the preview's "nothing connects" switch). */
  probeAll?: { connectionStatus: string; tools?: Array<{ name: string; description?: string }>; error?: string };
  private probe(row: Row) {
    const scripted = this.probeAll ?? this.probes[row.id];
    if (scripted) return scripted;
    if (row.mcpServer.url) return /:9\//.test(row.mcpServer.url) ? { connectionStatus: 'disconnected', tools: [], error: 'fetch failed' }
      : { connectionStatus: 'connected', tools: [{ name: 'search', description: 'Search the service.' }, { name: 'fetch_page' }] };
    if (!row.mcpServer.command) return { connectionStatus: 'unknown' };
    if (/missing|not-a-program/.test(row.mcpServer.command)) return { connectionStatus: 'disconnected', tools: [], error: `spawn ${row.mcpServer.command} ENOENT` };
    return { connectionStatus: 'connected', tools: [{ name: 'app_probe', description: 'Returns a fixed marker.' }] };
  }
  private pluginView() {
    const plugin = this.plugin!;
    if (plugin.live === 'starting' && --this.pending < 0) plugin.live = 'running';
    return { plugin: {
      pluginId: PLUGIN, displayName: 'WeChat Visible Reader', artifact: plugin.artifact, config: 'ready', auth: 'not-required', intent: plugin.intent, live: plugin.live,
      lifecycleRevision: plugin.lifecycleRevision, installedVersion: plugin.artifact === 'installed' ? '0.1.0-alpha.7' : undefined,
      actions: { install: plugin.artifact === 'absent', setEnabled: plugin.artifact === 'installed' && plugin.setEnabled, uninstall: plugin.artifact === 'installed', blockingReasons: plugin.setEnabled ? [] : ['config-incomplete'] },
      diagnostic: plugin.diagnostic, activationFailed: plugin.activationFailed,
      steps: ['启用插件后，在 Mac 微信中选中需要猫查看的会话', '展开插件并阅读隐私披露，再授权读取 10 分钟', '回到目标 Clowder AI thread，对猫说“看一下微信”'],
      contributions: [{ id: 'wechat-visible-reader-limb', kind: 'limb', name: 'wechat-visible-reader-limb' }],
      configFields: [{ key: OPERATION, label: 'Visible WeChat reading authorization', kind: 'operation', required: false, description: WECHAT_DISCLOSURE, currentValue: null, sensitive: false,
        actions: [{ id: 'arm', label: 'Authorize for 10 minutes', render: 'button', next: 'disarm' }, { id: 'disarm', label: 'Revoke authorization', render: 'button', next: 'arm' }, { id: 'status', label: 'Authorization status', render: 'status' }] }],
    }, catalog: { status: 'loading', refreshedAt: null } };
  }
  private status(action: string) {
    const remaining = Math.max(0, this.armedUntil - this.now()), armed = remaining > 0;
    return { ok: true, render: 'status', data: armed ? { armed, remainingMs: remaining, expiresAt: new Date(this.armedUntil).toISOString() } : { armed: false, remainingMs: 0 },
      label: armed ? 'Visible WeChat reading authorized' : 'Visible WeChat reading not authorized', currentAction: action === 'arm' ? 'disarm' : action === 'disarm' ? 'arm' : 'status', advance: true };
  }

  /** `undefined`: not one of these routes. */
  handle(url: URL, method: string, body: any): unknown {
    const parts = url.pathname.split('/').map(decodeURIComponent), missing = (id: string) => new ApiError(404, `MCP "${id}" not found`, { error: `MCP "${id}" not found` });
    if (url.pathname === '/api/capabilities' && method === 'GET') return { items: this.rows.map(row => this.view(row)), catFamilies: [], projectPath: '/fixture' };
    if (url.pathname === '/api/capabilities/mcp/install' && method === 'POST') {
      const existing = this.rows.find(row => row.id === body.id);
      const server: Server = { transport: body.transport ?? existing?.mcpServer.transport ?? 'stdio', command: body.command ?? existing?.mcpServer.command ?? '', args: body.args ?? existing?.mcpServer.args ?? [],
        ...(body.url ?? existing?.mcpServer.url ? { url: body.url ?? existing?.mcpServer.url } : {}) };
      const env = { ...existing?.mcpServer.env, ...body.env }, headers = { ...existing?.mcpServer.headers, ...body.headers };
      if (Object.keys(env).length) server.env = env;
      if (Object.keys(headers).length) server.headers = headers;
      const row: Row = { id: body.id, type: 'mcp', enabled: true, source: 'external', globalEnabled: true, mcpServer: server };
      this.rows = [...this.rows.filter(item => item.id !== body.id), row];
      const { envKeys: _keys, ...capabilityServer } = this.view(row).mcpServer as Record<string, unknown>;
      return { ok: true, capability: { ...row, mcpServer: capabilityServer }, probe: server.url ? null : server.command ? { connectionStatus: this.probe(row).connectionStatus, tools: this.probe(row).tools ?? [] } : null };
    }
    if (parts[1] === 'api' && parts[2] === 'capabilities' && parts[3] === 'mcp' && parts[4]) {
      const row = this.rows.find(item => item.id === parts[4]);
      if (!row) throw missing(parts[4]);
      if (parts[5] === 'env' && method === 'PATCH') { row.mcpServer.env = { ...row.mcpServer.env, ...body.env }; return { ok: true, capability: this.view(row) }; }
      if (!parts[5] && method === 'DELETE') { this.rows = this.rows.filter(item => item !== row); return { ok: true, mode: url.searchParams.get('hard') === 'true' ? 'removed' : 'disabled' }; }
    }
    if (parts[1] === 'api' && parts[2] === 'mcp' && parts[4] === 'tools' && method === 'POST') {
      const row = this.rows.find(item => item.id === parts[3]);
      if (!row) throw missing(parts[3]!);
      return { ...this.probe(row), latencyMs: 38 };
    }
    if (url.pathname === `/api/plugin-manager/plugins/_local/${PLUGIN}` && method === 'GET') {
      if (!this.plugin) throw new ApiError(404, 'Plugin not found', { error: 'Plugin not found', code: 'PLUGIN_NOT_FOUND' });
      return this.pluginView();
    }
    if (url.pathname === `/api/plugin-manager/plugins/${PLUGIN}/set-enabled` && method === 'POST') {
      const plugin = this.plugin;
      if (!plugin) throw new ApiError(404, 'Plugin not found', { error: 'Plugin not found', code: 'PLUGIN_NOT_FOUND' });
      if (body.expectedRevision !== plugin.lifecycleRevision) throw new ApiError(409, `Expected lifecycle revision ${body.expectedRevision}, current ${plugin.lifecycleRevision}`, { error: 'stale', code: 'STALE_REVISION' });
      plugin.lifecycleRevision += 2; this.armedUntil = 0;
      if (!body.enabled) Object.assign(plugin, { intent: 'disabled', live: 'stopped' });
      else if (this.start === 'fail') Object.assign(plugin, { intent: 'disabled', live: 'stopped', activationFailed: true, diagnostic: { code: 'UNEXPECTED_RUNTIME_FAILURE', message: 'Plugin runtime reported UNEXPECTED_RUNTIME_FAILURE.' } });
      else {
        Object.assign(plugin, { intent: 'enabled', activationFailed: null, diagnostic: null, live: typeof this.start === 'number' ? 'starting' : 'running' });
        if (typeof this.start === 'number') this.pending = this.start;
        if (this.start === 'timeout') throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。');
      }
      return { pluginId: PLUGIN, pluginInstanceId: 'pi_fixture' };
    }
    if (url.pathname === `/api/plugins/${PLUGIN}/operations/${OPERATION}/reset` && method === 'POST') { this.operationState = null; return { ok: true }; }
    if (url.pathname.startsWith(`/api/plugins/${PLUGIN}/actions/${OPERATION}/`) && method === 'POST') {
      const action = parts[6]!;
      if (this.plugin?.live !== 'running') throw new ApiError(409, 'Plugin has no loaded settings handler', { error: 'Plugin has no loaded settings handler' });
      if (this.operationState) throw new ApiError(502, `Action failed: wechat-visible-reader:${action} input contains an unsupported field`, { error: 'unsupported field' });
      if (action === 'arm') this.armedUntil = this.now() + 600_000;
      if (action === 'disarm') this.armedUntil = 0;
      const answer = this.status(action);
      this.operationState = answer.currentAction;
      return answer;
    }
    return undefined;
  }
}
