import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '../server/errors.js';
import type { NativeTransport, NativeCat, NativeThread, NativeMessage, NativeEvent } from '../server/native/types.js';
import type { NativeRuntime } from '../server/native/bridge.js';
import { NativeAppsScript } from './apps-fixture.js';

/** Protocol fixture only; never linked from production. Real contracts run in native-integration.test.ts. */
// The engine's eight cat templates as the pinned upstream serves them (GET /api/cat-templates, read from the isolated runtime 2026-11-12).
export const catTemplates: Array<[id: string, name: string, role: string, personality: string, strengths: string, nickname: string]> = [
  ['ragdoll', '布偶猫', '主架构师和核心开发者，擅长深度思考和系统设计', '温柔但有主见，喜欢深入分析问题，写代码快但注重质量', '架构设计、写代码一把好手', '宪宪'],
  ['maine-coon', '缅因猫', '代码审查专家，擅长安全分析、测试覆盖和代码质量把控', '严谨认真，注重细节，会直言不讳地指出问题', 'Review、找 bug、coding 落地', '砚砚'],
  ['siamese', '暹罗猫', '视觉设计师和创意顾问，擅长 UI/UX 设计和视觉表达', '热血奔放，善于用视觉语言表达想法，表达力是全队最强的', '审美、前端设计风格、打破常规', '烁烁'],
  ['turkish-van', '梵花猫', '共创伙伴，擅长编码、文档与任务验收', '细心务实，保留自己的判断，愿意把事情接住做完', '编码、文档、验收', '墨墨'],
  ['dsh', '小鲸鱼', '共创与推理伙伴，负责分析问题、编码实现和交叉验证', '细心务实，先理清问题，再用可验证的结果交付', '问题分析、编码、交叉验证', '鲸鲸'],
  ['dragon-li', '狸花猫', 'GLM 对话猫；中文实证', '先证后答，机警蓄势', '实证', '小狸花'],
  ['bengal', '孟加拉猫', '混血多模型agent，擅长图片生成、浏览器自动化和视觉证据链', '精力旺盛、好奇心爆棚，什么都想试，什么都敢碰', '图片生成、截图录屏、browser automation、多模型切换', '斑斑'],
  ['golden-chinchilla', '金渐层', '开源多模型编码 agent，自带多专家编排 + LSP + 主题生态', '沉稳可靠，什么 provider 都能接，什么任务都能扛', '多专家内部编排、LSP 集成、开源生态、provider-agnostic', '金哥'],
];

/**
 * What the pinned engine requires of a pack it installs from a directory (packages/shared/src/schemas/pack.ts and
 * PackSecurityGuard, F129), for the two files this app writes: strict keys, bounded strings, the name pattern, the
 * blocklist of instruction-like phrases. Refuses as the engine does, with 400.
 */
function readPack(source: unknown) {
  const refuse = (why: string): never => { throw new ApiError(400, why); };
  if (typeof source !== 'string' || !existsSync(join(source, 'pack.yaml'))) refuse(`Source path not found or not a directory: ${String(source)}`);
  const dir = source as string;
  const strict = (value: any, keys: string[], optional: string[] = []) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key) || optional.includes(key)) && keys.every(key => key in value);
  const bounded = (value: unknown, max: number) => typeof value === 'string' && value.length >= 1 && value.length <= max;
  const extra = readdirSync(dir).filter(name => !['pack.yaml', 'defaults.yaml'].includes(name));
  if (extra.length) refuse(`Unexpected pack content in this fixture: ${extra.join(', ')}`);
  const texts = ['pack.yaml', 'defaults.yaml'].filter(name => existsSync(join(dir, name))).map(name => readFileSync(join(dir, name), 'utf8'));
  if (texts.some(text => /ignore\s+(all\s+)?(previous|above|prior)\s+instructions|you\s+are\s+now\b|from\s+now\s+on\s+you\b|forget\s+(everything|all|your)|system\s+prompt|reveal\s+your|show\s+me\s+your\s+instructions|override\s+(your|the)\s+(rules|identity|constraints|personality)|do\s+not\s+follow|disregard\b|bypass\b/i.test(text)))
    refuse('Pack security validation failed');
  const [manifest, defaults] = texts.map(text => JSON.parse(text));
  if (!strict(manifest, ['name', 'version', 'description', 'packType'], ['author', 'license', 'compatibility'])
    || !bounded(manifest.name, 100) || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(manifest.name) || !bounded(manifest.version, 20) || !bounded(manifest.description, 500)
    || !['domain', 'scenario', 'style', 'bridge', 'capability'].includes(manifest.packType)) refuse('Invalid pack.yaml');
  const behaviors: any[] = defaults === undefined ? [] : defaults?.behaviors;
  if (defaults !== undefined && (!strict(defaults, ['behaviors']) || !Array.isArray(behaviors) || behaviors.length > 50 || !behaviors.every(item => strict(item, ['id', 'scope', 'behavior', 'overridable'], ['breeds'])
    && bounded(item.id, 100) && ['all-cats', 'specific-breeds'].includes(item.scope) && bounded(item.behavior, 500) && item.overridable === true))) refuse('defaults.yaml schema error');
  return { name: manifest.name as string, version: manifest.version as string, description: manifest.description as string, packType: manifest.packType as string, behaviors: behaviors.map(item => item.behavior as string) };
}

export class NativeFixture implements NativeTransport {
  calls: Array<{ path: string; method: string; body?: any }> = [];
  cats: NativeCat[] = [];
  runtimes: NativeRuntime[] = [{ id: 'codex', label: 'Codex', clientId: 'openai', installed: true, configuredModel: 'native-default', models: [], readiness: { status: 'configured', checkedAt: 1000 } }];
  threads = new Map<string, NativeThread>();
  messages = new Map<string, NativeMessage[]>();
  /** A smaller page than the callers ask for, to show paging without hundreds of messages. */
  pageLimit?: number;
  /** …or for one conversation only, by thread. */
  pageLimits = new Map<string, number>();
  queues = new Map<string, any>();
  taskRows: any[] = [];
  approvalItems: any[] = [];
  settledApprovalItems: any[] = [];
  runtimeInteractions = new Map<string, any>();
  artifactRows = new Map<string, any[]>();
  memoryViews: Record<string, any> = { profile: {readStatus:'ready',entries:[]}, taste: {readStatus:'ready',entries:[]} };
  uploads = new Map<string, Buffer>();
  fail?: ApiError;
  /** Why the engine's routing preview picks a cat when the words name none. */
  routingReason: Record<string, unknown> = { kind: 'recent_replier' };
  /** Cats that cannot run: named in the words, the preview passes them over and lists them (native: unavailableTargets). */
  routingUnavailable: string[] = [];
  /** Installed engine packs in the order the engine lists them (F129) — the first is the one it applies: the manifest and, for this fixture, the default behaviours read from the source. */
  packs: Array<{ name: string; version: string; description: string; packType: string; behaviors: string[] }> = [];
  /**
   * The engine routes behind 应用 (capability registry, plugin manager), scripted: tests/apps-fixture.ts.
   * One registry in the engine, two scripts here: the 这台电脑 entry (`computer`) is scripted below with what that
   * feature depends on (block lists, the order of writes, lost answers); every other row is scripted there with what
   * 应用 depends on (masked secrets, probes, merging installs). `GET /api/capabilities` answers both, as the engine does.
   */
  apps = new NativeAppsScript();
  /**
   * The engine's capability registry as far as an MCP entry goes (read on the isolated runtime and in the pinned
   * source, 2026-11-26): installing an entry leaves it on for every cat; who may not use it is a block list, which
   * takes an id whether or not that cat exists yet; a `project` toggle without a cat blocks or unblocks every cat in
   * one call; installing over an entry merges into it and keeps its block list; a cat created while an entry is
   * blocked for every existing cat starts blocked too, otherwise it starts with it unless its id was already listed;
   * deleting is soft (disabled) unless `hard=true`. Writes are applied one after another in the order they arrived,
   * and reads do not wait for them.
   */
  capabilities: Array<{ id: string; type: 'mcp'; source: 'external'; enabled: boolean; mcpServer: Record<string, unknown>; blockedCats?: string[] }> = [];
  /** Registry routes that refuse before anything changes, by `METHOD path` (a query string is left out) or `PATCH:<scope>` for one kind of toggle. */
  capabilityFailures = new Set<string>();
  /** Routes (same keys, also `POST /api/cats`) whose change is made and whose answer is then lost: the caller gets 503. */
  lostAnswers = new Set<string>();
  /**
   * The next registry write with this key is left waiting in the engine: the caller gets 503 at once (its request
   * timed out), the write is applied when `release` settles, and every later write waits behind it.
   */
  capabilityHold?: { key: string; release: Promise<void> };
  /** The next cat creation is left waiting in the engine the same way: 503 to the caller, the cat is made when `release` settles. */
  catHold?: { release: Promise<void> };
  /**
   * What the engine answers to a cancellation, and after how many further reads of that conversation's queue the turn
   * is gone. Infinity, the default: the queue stays as the test set it (cancelling is a request, not the end of the turn).
   */
  cancelAnswer: Record<string, unknown> = { ok: true, cancelled: true };
  cancelEndsAfterReads = Infinity;
  private ending = new Map<string, number>();
  private capabilityWrites: Promise<unknown> = Promise.resolve();
  private capabilityWrite(method: string, url: URL, parts: string[], body: any): () => unknown {
    const found = (id: string) => this.capabilities.find(entry => entry.id === id);
    if (url.pathname === '/api/capabilities/mcp/install' && method === 'POST') return () => {
      const { id, ...server } = body, existing = found(id);
      if (existing) existing.mcpServer = { ...existing.mcpServer, ...server, ...(existing.mcpServer.env || server.env ? { env: { ...(existing.mcpServer.env as object), ...server.env } } : {}) };
      else this.capabilities.push({ id, type: 'mcp', source: 'external', enabled: true, mcpServer: server });
      return { ok: true, capability: found(id), probe: { connectionStatus: 'connected', tools: [] } };
    };
    if (url.pathname === '/api/capabilities' && method === 'PATCH') return () => {
      const entry = found(body.capabilityId);
      if (!entry || body.capabilityType !== 'mcp' || body.source !== 'external') throw new ApiError(404, `Capability "${body.capabilityId}" (type=${body.capabilityType}) not found`);
      const blocked = new Set(entry.blockedCats ?? []);
      if (body.scope === 'project') { blocked.clear(); if (!body.enabled) for (const cat of this.cats) blocked.add(cat.id); }
      else if (body.scope === 'cat' && body.catId) { if (body.enabled) blocked.delete(body.catId); else blocked.add(body.catId); }
      else throw new ApiError(400, 'Unsupported toggle in this fixture');
      if (blocked.size) entry.blockedCats = [...blocked]; else delete entry.blockedCats;
      return { ok: true, capability: entry };
    };
    if (parts[3] === 'mcp' && parts[4] && method === 'DELETE') return () => {
      const entry = found(parts[4]!);
      if (!entry) throw new ApiError(404, `MCP "${parts[4]}" not found`);
      if (url.searchParams.get('hard') === 'true') { this.capabilities = this.capabilities.filter(known => known !== entry); return { ok: true, mode: 'removed' }; }
      entry.enabled = false; return { ok: true, mode: 'disabled' };
    };
    throw new Error(`Unconfigured fixture route: ${method} ${url.pathname}`);
  }
  async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    const method = options.method ?? 'GET', body = options.body;
    this.calls.push({ path, method, body });
    if (this.fail) throw this.fail;
    const url = new URL(path, 'http://fixture');
    const parts = url.pathname.split('/').map(decodeURIComponent);
    let result: unknown;
    // The `computer` entry belongs to the script below; the rest of the registry and the plugin manager to tests/apps-fixture.ts.
    const computer = body?.id === 'computer' || (parts[2] === 'capabilities' && parts[3] === 'mcp' && parts[4] === 'computer');
    const scripted = computer ? undefined : this.apps.handle(url, method, body);
    if (scripted !== undefined) return structuredClone(scripted) as T;
    if (path === '/api/health') result = { status: 'ok', callbackAuth: { backend: 'redis', durability: 'durable' } };
    else if (path === '/api/projects/mkdir' && method === 'POST') result = { createdPath: join(body.parentPath, body.name), name: body.name };
    else if (url.pathname === '/api/projects/browse') result = { current: url.searchParams.get('path'), entries: [] };
    else if (path === '/api/packs' && method === 'GET') result = { packs: this.packs.map(({ behaviors: _behaviors, ...manifest }) => manifest) };
    else if (path === '/api/packs/add' && method === 'POST') {
      const manifest = readPack(body?.source);
      // The engine lists its pack directory, not the order of installation: here, by name.
      this.packs = [...this.packs.filter(pack => pack.name !== manifest.name), manifest].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const { behaviors: _behaviors, ...listed } = manifest;
      result = { ok: true, manifest: listed };
    }
    else if (path === '/api/cat-templates') result = { templates: catTemplates.map(([id, name, roleDescription, personality, teamStrengths, nickname]) => ({ id, name, nickname, roleDescription, personality, teamStrengths, color: { primary: '#888888', secondary: '#eeeeee' } })), clientDefaults: {} };
    else if (url.pathname === '/api/cats/native-runtimes') result = { runtimes: this.runtimes };
    else if (path === '/api/accounts') result = { providers: [] };
    else if (path === '/api/cats' && method === 'GET') result = { cats: this.cats };
    else if (path === '/api/cats' && method === 'POST') {
      const cat = { ...body, id: body.catId, breedId: body.catId, configurationRevision: 'r1' } as NativeCat;
      const make = () => {
        for (const entry of this.capabilities) if (this.cats.length && this.cats.every(known => entry.blockedCats?.includes(known.id)) && !entry.blockedCats!.includes(cat.id)) entry.blockedCats!.push(cat.id);
        this.cats.push(cat);
      };
      const held = this.catHold;
      if (held) { this.catHold = undefined; void held.release.then(make); throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。'); }
      make(); result = { cat };
      if (this.lostAnswers.has('POST /api/cats')) throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。');
    }
    else if (parts[2] === 'cats' && parts[3] && method === 'DELETE') {
      // The engine deletes a member only against the revision it was last saved with
      // (routes/cats.ts: 428 without one, 409 when the member has changed since).
      const target = this.cats.find(known => known.id === parts[3]);
      if (!target) throw new ApiError(404, `Cat "${parts[3]}" not found`);
      if (body?.expectedRevision === undefined) throw new ApiError(428, '缺少成员保存版本，请重新读取成员配置后再操作。');
      if (body.expectedRevision !== target.configurationRevision) throw new ApiError(409, '成员已在其他页面修改。草稿已保留，请重新读取后核对再保存。');
      // The engine takes a deleted cat off every block list.
      this.cats = this.cats.filter(known => known.id !== parts[3]);
      for (const entry of this.capabilities) if (entry.blockedCats) { entry.blockedCats = entry.blockedCats.filter(id => id !== parts[3]); if (!entry.blockedCats.length) delete entry.blockedCats; }
      result = { deleted: true, id: parts[3] };
    }
    else if (url.pathname.startsWith('/api/capabilities')) {
      const key = `${method} ${url.pathname}`, kind = method === 'PATCH' ? `PATCH:${body?.scope}` : key;
      if (this.capabilityFailures.has(key) || this.capabilityFailures.has(kind)) throw new ApiError(500, 'capability store failed');
      if (url.pathname === '/api/capabilities' && method === 'GET')
        result = { items: [...this.apps.items(), ...this.capabilities.map(entry => ({ ...entry, cats: Object.fromEntries(this.cats.map(cat => [cat.id, !entry.blockedCats?.includes(cat.id)])) }))], catFamilies: [], projectPath: '/fixture' };
      else {
        const apply = this.capabilityWrite(method, url, parts, body), held = this.capabilityHold;
        if (held && (held.key === key || held.key === kind)) {
          this.capabilityHold = undefined;
          this.capabilityWrites = this.capabilityWrites.then(() => held.release).then(apply).catch(() => {});
          throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。');
        }
        const done = this.capabilityWrites.then(apply);
        this.capabilityWrites = done.catch(() => {});
        result = await done;
        if (this.lostAnswers.has(key) || this.lostAnswers.has(kind)) throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。');
      }
    } else if (parts[2] === 'cats' && parts[3] && method === 'PATCH') {
      const cat = this.cats.find(c => c.id === parts[3]); if (!cat) throw new ApiError(404, 'Missing cat'); Object.assign(cat, body); result = { cat };
    } else if (path === '/api/threads' && method === 'POST') {
      // Native answers a repeated creation key with the thread it made the first time.
      const made = body.idempotencyKey ? [...this.threads.values()].find(known => known.idempotencyKey === body.idempotencyKey) : undefined;
      // …and, like the pinned upstream, applies the request's members to it again.
      if (made && Array.isArray(body.preferredCats) && body.preferredCats.length) made.preferredCats = body.preferredCats;
      const thread = made ?? { ...body, id: randomUUID(), createdAt: Date.now() }; this.threads.set(thread.id, thread); result = thread;
    } else if (parts[2] === 'threads' && parts[3] && parts.length === 4) {
      const thread = this.threads.get(parts[3]); if (!thread) throw new ApiError(404, 'Missing thread');
      if (method === 'PATCH') Object.assign(thread, body); result = thread;
    } else if (parts[4] === 'queue') {
      // A cancelled turn leaves the queue only once the engine has cleaned up after it.
      const queue = this.queues.get(parts[3]!);
      for (const [key, reads] of this.ending) {
        const [threadId, catId] = key.split('|');
        if (threadId !== parts[3]) continue;
        if (reads > 0) { this.ending.set(key, reads - 1); continue; }
        this.ending.delete(key);
        if (queue) queue.activeInvocations = queue.activeInvocations.filter((run: any) => run.catId !== catId);
      }
      result = queue ?? { queue: [], activeInvocations: [] };
    }
    else if (parts[4] === 'artifacts') result = {threadId:parts[3],artifacts:this.artifactRows.get(parts[3]!) ?? []};
    else if (parts[4] === 'sessions') result = { sessions: [] };
    else if (parts[4] === 'cancel') {
      if (this.cancelAnswer.cancelled !== false) this.ending.set(`${parts[3]}|${parts[5]}`, this.cancelEndsAfterReads);
      result = this.cancelAnswer;
    }
    else if (parts[2] === 'messages' && method === 'GET') {
      // The newest page, or the one before a cursor (`<order>:<message id>`), like native: `limit` at most, and whether older ones remain.
      const all = this.messages.get(url.searchParams.get('threadId')!) ?? [], cursor = url.searchParams.get('before');
      const end = cursor ? all.findIndex(message => message.id === cursor.slice(cursor.indexOf(':') + 1)) : all.length;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, this.pageLimit ?? Infinity, this.pageLimits.get(url.searchParams.get('threadId')!) ?? Infinity), start = Math.max(0, (end < 0 ? 0 : end) - limit);
      result = { messages: all.slice(start, end < 0 ? 0 : end), hasMore: start > 0 };
    }
    // The engine's read-only routing preview, as far as these tests need it: a cat named in the words the ways the pinned
    // AgentRouter reads them (@名字, 「at 名字」, 「艾特 名字」), a line that asks every member (#ideate), else the conversation's history.
    else if (path === '/api/routing/preview' && method === 'POST') {
      const members = (this.threads.get(body.threadId)?.preferredCats ?? []).map(id => this.cats.find(cat => cat.id === id)).filter((cat): cat is NativeCat => !!cat);
      const named = this.cats.filter(cat => new RegExp(`(?:@|(?:^|\\s)(?:at|艾特)\\s*)${cat.name}(?=$|[\\s，。！？、,.:：;；])`, 'i').test(String(body.content)));
      // A named cat that cannot run is passed over and listed; with no other name left, the engine falls back on history.
      const able = named.filter(cat => !this.routingUnavailable.includes(cat.id)), skipped = named.filter(cat => this.routingUnavailable.includes(cat.id)).map(cat => cat.id);
      const unavailable = skipped.length ? { unavailableTargets: skipped } : {};
      result = able.length ? { targetCats: able.map(cat => cat.id), reason: { kind: 'current_message_mentions' }, ...unavailable }
        : /#ideate\b/i.test(String(body.content)) && members.length > 1 ? { targetCats: members.map(cat => cat.id), reason: { kind: 'preferred_parallel' }, ...unavailable }
        : { targetCats: members.slice(0, 1).map(cat => cat.id), reason: this.routingReason, ...unavailable };
    }
    else if (path === '/api/messages' && method === 'POST') result = { status: 'queued', userMessageId: 'message-1', entries: [{ entryId: 'queue-1', targetCatId: body.mentions?.[0] }], queuePosition: 1 };
    else if (url.pathname === '/api/tasks' && method === 'GET') result = {tasks:this.taskRows.filter(task=>task.threadId===url.searchParams.get('threadId'))};
    else if (url.pathname === '/api/approval-hub/pending') result = {items:this.approvalItems};
    else if (url.pathname === '/api/approval-hub/settled') result = {items:this.settledApprovalItems};
    else if (parts[2] === 'runtime-interactions' && parts[3]) {
      const id = parts[3], rec = this.runtimeInteractions.get(id);
      if (!rec) throw new ApiError(404, 'Interaction not found');
      if (method === 'GET' && parts.length === 4) result = { interaction: rec };
      else if (method === 'POST' && parts[4] === 'respond') {
        const sameConvOp = rec.request?.kind === 'conversation_decision'
          && typeof body?.operationId === 'string' && !!body.operationId
          && (rec.submission?.operationId === body.operationId || rec.terminal?.operationId === body.operationId);
        if (sameConvOp) {
          if (rec.status === 'pending' && rec.submission) {
            rec.status = rec.submission.terminal?.status ?? 'answered';
            rec.terminal = rec.submission.terminal;
            delete rec.submission;
          }
          result = { interaction: rec };
        } else {
          if (rec.status !== 'pending') throw new ApiError(409, 'runtime interaction is not pending');
          if (body?.expectedRevision !== undefined && body.expectedRevision !== rec.revision) throw new ApiError(409, 'runtime interaction revision changed');
          const response = body?.response;
          const req = rec.request;
          let status: string = 'answered', reasonCode: string = 'answered', redacted: any = response;
          if (req.kind === 'question' && response?.kind === 'answers') {
            const selectedOptionIndexes: Record<string, number[]> = {};
            for (const q of req.questions ?? []) {
              if (q.isSecret || !Array.isArray(q.options)) continue;
              const idxs = (q.options as any[]).flatMap((o, i) => (response.answers?.[q.id] ?? []).includes(o.label) ? [i] : []);
              if (idxs.length) selectedOptionIndexes[q.id] = idxs;
            }
            redacted = { kind: 'answers', answeredQuestionIds: Object.keys(response.answers ?? {}), secretQuestionIds: (req.questions ?? []).filter((q: any) => q.isSecret).map((q: any) => q.id), ...(Object.keys(selectedOptionIndexes).length ? { selectedOptionIndexes } : {}) };
          } else if ((req.kind === 'approval' || req.kind === 'elicitation') && response?.kind === 'decision') {
            const d = (req.decisions ?? []).find((c: any) => c.id === response.decisionId);
            status = d?.outcome === 'decline' ? 'declined' : d?.outcome === 'cancel' ? 'cancelled' : 'answered';
            reasonCode = d?.outcome === 'decline' ? 'user_rejected' : d?.outcome === 'cancel' ? 'user_cancelled' : 'answered';
            redacted = { kind: 'decision', decisionId: response.decisionId };
          } else if (req.kind === 'conversation_decision' && response?.kind === 'selection') {
            redacted = { kind: 'selection', selectedIds: response.selectedIds };
          }
          rec.status = status;
          rec.revision = (rec.revision ?? 1) + 1;
          rec.terminal = {
            status, reasonCode, settledAt: Date.now(), response: redacted,
            ...(typeof body?.operationId === 'string' ? { operationId: body.operationId } : {}),
          };
          this.approvalItems = this.approvalItems.filter(i => i.proposalId !== id);
          result = { interaction: rec };
        }
      } else if (method === 'POST' && parts[4] === 'reject') {
        if (rec.status !== 'pending') throw new ApiError(409, 'runtime interaction is not pending');
        if (rec.request?.kind !== 'question') throw new ApiError(400, 'only question interactions can use explicit rejection');
        rec.status = 'declined';
        rec.revision = (rec.revision ?? 1) + 1;
        rec.terminal = { status: 'declined', reasonCode: 'user_rejected', settledAt: Date.now() };
        this.approvalItems = this.approvalItems.filter(i => i.proposalId !== id);
        result = { interaction: rec };
      } else throw new Error(`Unconfigured fixture route: ${method} ${path}`);
    }
    else if (parts[2] === 'memory' && parts[3] && ['profile','taste'].includes(parts[3])) {
      if(method!=='GET')throw new Error('Fixture forbids long-term memory writes');
      if(parts[5]==='source')result={status:'ready',sources:[]};
      else result=this.memoryViews[parts[3]];
    }
    else if (parts[2] === 'memory') result = method === 'GET' ? { entries: [] } : { key: body?.key };
    else throw new Error(`Unconfigured fixture route: ${method} ${path}`);
    return structuredClone(result) as T;
  }
  async subscribe(_id: string, listener: (event: NativeEvent) => void) { listener({ type: 'resync' }); return () => {}; }
  async readFile(path:string,maxBytes:number) {
    this.calls.push({path,method:'BYTES'});
    const bytes=this.uploads.get(path);if(!bytes)throw new ApiError(404,'文件已不存在');
    if(bytes.length>maxBytes)throw new ApiError(413,'单个文件最多 20 MB');
    return Buffer.from(bytes);
  }
  async close() {}
}
