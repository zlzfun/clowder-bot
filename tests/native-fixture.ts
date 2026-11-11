import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiError } from '../server/errors.js';
import type { NativeTransport, NativeCat, NativeThread, NativeMessage, NativeEvent } from '../server/native/types.js';
import type { NativeRuntime } from '../server/native/bridge.js';

/** Protocol fixture only; never linked from production. Real contracts run in native-integration.test.ts. */
// The engine's eight cat templates as the pinned upstream serves them (GET /api/cat-templates, read from the isolated runtime 2026-11-12).
export const catTemplates: Array<[id: string, name: string, role: string, personality: string, strengths: string]> = [
  ['ragdoll', '布偶猫', '主架构师和核心开发者，擅长深度思考和系统设计', '温柔但有主见，喜欢深入分析问题，写代码快但注重质量', '架构设计、写代码一把好手'],
  ['maine-coon', '缅因猫', '代码审查专家，擅长安全分析、测试覆盖和代码质量把控', '严谨认真，注重细节，会直言不讳地指出问题', 'Review、找 bug、coding 落地'],
  ['siamese', '暹罗猫', '视觉设计师和创意顾问，擅长 UI/UX 设计和视觉表达', '热血奔放，善于用视觉语言表达想法，表达力是全队最强的', '审美、前端设计风格、打破常规'],
  ['turkish-van', '梵花猫', '共创伙伴，擅长编码、文档与任务验收', '细心务实，保留自己的判断，愿意把事情接住做完', '编码、文档、验收'],
  ['dsh', '小鲸鱼', '共创与推理伙伴，负责分析问题、编码实现和交叉验证', '细心务实，先理清问题，再用可验证的结果交付', '问题分析、编码、交叉验证'],
  ['dragon-li', '狸花猫', 'GLM 对话猫；中文实证', '先证后答，机警蓄势', '实证'],
  ['bengal', '孟加拉猫', '混血多模型agent，擅长图片生成、浏览器自动化和视觉证据链', '精力旺盛、好奇心爆棚，什么都想试，什么都敢碰', '图片生成、截图录屏、browser automation、多模型切换'],
  ['golden-chinchilla', '金渐层', '开源多模型编码 agent，自带多专家编排 + LSP + 主题生态', '沉稳可靠，什么 provider 都能接，什么任务都能扛', '多专家内部编排、LSP 集成、开源生态、provider-agnostic'],
];

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
  artifactRows = new Map<string, any[]>();
  memoryViews: Record<string, any> = { profile: {readStatus:'ready',entries:[]}, taste: {readStatus:'ready',entries:[]} };
  uploads = new Map<string, Buffer>();
  fail?: ApiError;
  async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    const method = options.method ?? 'GET', body = options.body;
    this.calls.push({ path, method, body });
    if (this.fail) throw this.fail;
    const url = new URL(path, 'http://fixture');
    const parts = url.pathname.split('/').map(decodeURIComponent);
    let result: unknown;
    if (path === '/api/health') result = { status: 'ok', callbackAuth: { backend: 'redis', durability: 'durable' } };
    else if (path === '/api/projects/mkdir' && method === 'POST') result = { createdPath: join(body.parentPath, body.name), name: body.name };
    else if (url.pathname === '/api/projects/browse') result = { current: url.searchParams.get('path'), entries: [] };
    else if (path === '/api/cat-templates') result = { templates: catTemplates.map(([id, name, roleDescription, personality, teamStrengths]) => ({ id, name, roleDescription, personality, teamStrengths, color: { primary: '#888888', secondary: '#eeeeee' } })), clientDefaults: {} };
    else if (url.pathname === '/api/cats/native-runtimes') result = { runtimes: this.runtimes };
    else if (path === '/api/accounts') result = { providers: [] };
    else if (path === '/api/cats' && method === 'GET') result = { cats: this.cats };
    else if (path === '/api/cats' && method === 'POST') {
      const cat = { ...body, id: body.catId, breedId: body.catId, configurationRevision: 'r1' } as NativeCat;
      this.cats.push(cat); result = { cat };
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
    } else if (parts[4] === 'queue') result = this.queues.get(parts[3]!) ?? { queue: [], activeInvocations: [] };
    else if (parts[4] === 'artifacts') result = {threadId:parts[3],artifacts:this.artifactRows.get(parts[3]!) ?? []};
    else if (parts[4] === 'sessions') result = { sessions: [] };
    else if (parts[4] === 'cancel') result = { ok: true, cancelled: true };
    else if (parts[2] === 'messages' && method === 'GET') {
      // The newest page, or the one before a cursor (`<order>:<message id>`), like native: `limit` at most, and whether older ones remain.
      const all = this.messages.get(url.searchParams.get('threadId')!) ?? [], cursor = url.searchParams.get('before');
      const end = cursor ? all.findIndex(message => message.id === cursor.slice(cursor.indexOf(':') + 1)) : all.length;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, this.pageLimit ?? Infinity, this.pageLimits.get(url.searchParams.get('threadId')!) ?? Infinity), start = Math.max(0, (end < 0 ? 0 : end) - limit);
      result = { messages: all.slice(start, end < 0 ? 0 : end), hasMore: start > 0 };
    }
    else if (path === '/api/messages' && method === 'POST') result = { status: 'queued', userMessageId: 'message-1', entries: [{ entryId: 'queue-1', targetCatId: body.mentions?.[0] }], queuePosition: 1 };
    else if (url.pathname === '/api/tasks' && method === 'GET') result = {tasks:this.taskRows.filter(task=>task.threadId===url.searchParams.get('threadId'))};
    else if (url.pathname === '/api/approval-hub/pending') result = {items:this.approvalItems};
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
