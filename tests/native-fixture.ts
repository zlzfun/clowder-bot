import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiError } from '../server/errors.js';
import type { NativeTransport, NativeCat, NativeThread, NativeMessage, NativeEvent } from '../server/native/types.js';
import type { NativeRuntime } from '../server/native/bridge.js';

/** Protocol fixture only; never linked from production. Real contracts run in native-integration.test.ts. */
export class NativeFixture implements NativeTransport {
  calls: Array<{ path: string; method: string; body?: any }> = [];
  cats: NativeCat[] = [];
  runtimes: NativeRuntime[] = [{ id: 'codex', label: 'Codex', clientId: 'openai', installed: true, configuredModel: 'native-default', models: [], readiness: { status: 'configured', checkedAt: 1000 } }];
  threads = new Map<string, NativeThread>();
  messages = new Map<string, NativeMessage[]>();
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
    else if (path === '/api/cat-templates') result = { templates: ['ragdoll','maine-coon','siamese','turkish-van','dsh','dragon-li','bengal','golden-chinchilla'].map(id => ({ id, name: id, roleDescription: 'Native role', color: { primary: '#888', secondary: '#eee' } })), clientDefaults: {} };
    else if (url.pathname === '/api/cats/native-runtimes') result = { runtimes: this.runtimes };
    else if (path === '/api/accounts') result = { providers: [] };
    else if (path === '/api/cats' && method === 'GET') result = { cats: this.cats };
    else if (path === '/api/cats' && method === 'POST') {
      const cat = { ...body, id: body.catId, breedId: body.catId, configurationRevision: 'r1' } as NativeCat;
      this.cats.push(cat); result = { cat };
    } else if (parts[2] === 'cats' && parts[3] && method === 'PATCH') {
      const cat = this.cats.find(c => c.id === parts[3]); if (!cat) throw new ApiError(404, 'Missing cat'); Object.assign(cat, body); result = { cat };
    } else if (path === '/api/threads' && method === 'POST') {
      const thread = { ...body, id: randomUUID(), createdAt: Date.now() }; this.threads.set(thread.id, thread); result = thread;
    } else if (parts[2] === 'threads' && parts[3] && parts.length === 4) {
      const thread = this.threads.get(parts[3]); if (!thread) throw new ApiError(404, 'Missing thread');
      if (method === 'PATCH') Object.assign(thread, body); result = thread;
    } else if (parts[4] === 'queue') result = this.queues.get(parts[3]!) ?? { queue: [], activeInvocations: [] };
    else if (parts[4] === 'artifacts') result = {threadId:parts[3],artifacts:this.artifactRows.get(parts[3]!) ?? []};
    else if (parts[4] === 'sessions') result = { sessions: [] };
    else if (parts[4] === 'cancel') result = { ok: true, cancelled: true };
    else if (parts[2] === 'messages' && method === 'GET') result = { messages: this.messages.get(url.searchParams.get('threadId')!) ?? [], hasMore: false };
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
