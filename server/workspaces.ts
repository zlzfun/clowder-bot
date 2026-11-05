import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ApiError } from './errors.js';
import type { BotBridge } from './native/bridge.js';
import type { NativeCat, NativeMessage, NativeThread } from './native/types.js';
import type { WorkspaceFile } from './product-store.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const contained = (root: string, path: string) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)); };
const safeSegment = (value: string) => /^[\p{L}\p{N}_ .-]{1,120}$/u.test(value) && value !== '.' && value !== '..' && !value.startsWith('.');
const textTypes = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.js', '.ts', '.tsx', '.jsx', '.css', '.py', '.rs', '.go', '.java', '.yaml', '.yml', '.toml', '.xml', '.html', '.sql', '.sh', '.log']);
export function mimeFor(name: string, data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(data.subarray(0,6).toString())) return 'image/gif';
  if (data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  if (data.subarray(0,5).toString() === '%PDF-') return 'application/pdf';
  return textTypes.has(extname(name).toLowerCase()) && !data.includes(0) ? 'text/plain' : 'application/octet-stream';
}

/** Product file catalogue and native Thread workspace bindings. Execution remains in Clowder AI. */
export class Workspaces {
  private switches = new Map<string, Promise<unknown>>();
  private directoryCreates = new Map<string, Promise<string>>();
  constructor(readonly bridge: BotBridge) {}
  project(id?: string | null) {
    if (!id) return null;
    const project = this.bridge.store.state.projects.find(p => p.id === id);
    if (!project) throw new ApiError(404, '项目不存在');
    return project;
  }
  private async nativeDirectory(parent: string, name: string): Promise<string> {
    const key = join(parent,name), pending = this.directoryCreates.get(key);
    if(pending) return pending;
    const job = this.createNativeDirectory(parent,name); this.directoryCreates.set(key,job);
    try { return await job; } finally { this.directoryCreates.delete(key); }
  }
  private async createNativeDirectory(parent: string, name: string): Promise<string> {
    const root = await realpath(this.bridge.workspace).catch(()=>resolve(this.bridge.workspace));
    parent = await realpath(parent).catch(()=>resolve(parent));
    if (!safeSegment(name) || !contained(root, resolve(parent, name))) throw new ApiError(400, '工作区目录无效');
    try {
      const result = await this.bridge.native.request<{ createdPath: string }>('/api/projects/mkdir', { method: 'POST', body: { parentPath: parent, name } });
      if (resolve(result.createdPath) !== resolve(parent, name)) throw new ApiError(502, '原生工作区目录不匹配');
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      // The native browse endpoint canonicalizes and authorizes existing directories.
      const result = await this.bridge.native.request<{ current: string }>(`/api/projects/browse?path=${encodeURIComponent(join(parent, name))}`);
      if (resolve(result.current) !== resolve(parent, name)) throw new ApiError(409, '工作区目录已被重定向');
    }
    return join(parent, name);
  }
  async catPath(catId: string) {
    if (!safeSegment(catId)) throw new ApiError(400, '猫猫目录标识无效');
    return this.nativeDirectory(await this.nativeDirectory(this.bridge.workspace, 'cats'), catId);
  }
  async groupPath(key: string) {
    if (!safeSegment(key)) throw new ApiError(400, '群聊目录标识无效');
    return this.nativeDirectory(await this.nativeDirectory(this.bridge.workspace, 'groups'), key);
  }
  async view(thread: NativeThread, _cat?: NativeCat) {
    const workspacePath = typeof thread.projectPath === 'string' && thread.projectPath !== 'default' ? thread.projectPath : this.bridge.workspace;
    // Legacy directories stay where they are. The product no longer models a project selection.
    const legacyProject = this.bridge.store.state.projects.find(p => contained(p.path, workspacePath));
    return { threadId: thread.id, workspacePath, sharedPath: legacyProject?.sharedPath ?? workspacePath,
      defaultRoot: this.bridge.workspace, canSwitch: false };
  }
  private knownConversations(cat: NativeCat): string[] {
    const meta = this.bridge.store.bot(cat.id);
    return [...new Set([...(meta.activeThreadId ? [meta.activeThreadId] : []),
      ...(meta.conversationIds ?? []), ...Object.values(meta.workspaceThreads ?? {})])];
  }
  async conversations(cat: NativeCat) {
    const current = await this.bridge.direct(cat), meta = this.bridge.store.bot(cat.id);
    const conversations = await Promise.all(this.knownConversations(cat).map(async id => {
      let thread: NativeThread;
      try { thread = await this.bridge.thread(id); } catch (e) {
        if (e instanceof ApiError && e.status === 404 && id !== current.id) return null;
        throw e;
      }
      if (thread.preferredCats?.length !== 1 || thread.preferredCats[0] !== cat.id) return null;
      const legacyKey = Object.entries(meta.workspaceThreads ?? {}).find(([,tid]) => tid === id)?.[0];
      const oldProject = this.bridge.store.state.projects.find(p => p.id === legacyKey);
      return { id, title: oldProject?.name ?? thread.title ?? cat.name,
        current: id === current.id, createdAt: thread.createdAt ?? 0 };
    }));
    return { conversations: conversations.filter((c): c is NonNullable<typeof c> => c !== null) };
  }
  private async changingConversation<T>(cat: NativeCat, work: () => Promise<T>): Promise<T> {
    if (this.switches.has(cat.id)) throw new ApiError(409, '会话正在切换，请稍后重试');
    const job = work(); this.switches.set(cat.id,job);
    try { return await job; } finally { this.switches.delete(cat.id); }
  }
  private async requireIdle(id: string) {
    const queue = await this.bridge.queue(id);
    if (queue.queue.length || queue.activeInvocations.length) throw new ApiError(409, '请先完成或停止会话中的任务');
  }
  async switchConversation(cat: NativeCat, threadId: string, expectedThreadId: string) {
    return this.changingConversation(cat, async () => {
      const old = await this.bridge.direct(cat);
      if (old.id !== expectedThreadId) throw new ApiError(409, '当前会话已变化，请刷新后再切换');
      if (!this.knownConversations(cat).includes(threadId)) throw new ApiError(404, '找不到这只猫的历史对话');
      const thread = await this.bridge.thread(threadId);
      if (thread.preferredCats?.length !== 1 || thread.preferredCats[0] !== cat.id) throw new ApiError(403, '此会话不属于这只猫');
      if (threadId !== old.id) { await this.requireIdle(old.id); await this.requireIdle(threadId); }
      const meta = this.bridge.store.bot(cat.id);
      meta.conversationIds = this.knownConversations(cat);
      meta.activeThreadId = threadId;
      // Retain old references as provenance, never re-create or migrate a project.
      meta.projectId = Object.entries(meta.workspaceThreads ?? {}).find(([key,id]) => key !== 'personal' && id === threadId)?.[0] ?? null;
      this.bridge.store.save(); return this.view(thread, cat);
    });
  }
  async newConversation(cat: NativeCat) {
    return this.changingConversation(cat, async () => {
      const old = await this.bridge.direct(cat); await this.requireIdle(old.id);
      const thread = await this.bridge.newThread(cat.name, [cat.id], undefined, await this.catPath(cat.id));
      const meta = this.bridge.store.bot(cat.id);
      meta.conversationIds = [...new Set([...this.knownConversations(cat), thread.id])];
      meta.activeThreadId = thread.id; meta.projectId = null;
      this.bridge.store.save(); return thread;
    });
  }
  async root(thread: NativeThread, area: 'workspace' | 'shared' = 'workspace'): Promise<string> {
    let path = typeof thread.projectPath === 'string' && thread.projectPath !== 'default' ? thread.projectPath : this.bridge.workspace;
    if (area === 'shared') {
      const project = this.bridge.store.state.projects.find(p => contained(p.path, path));
      path = project?.sharedPath ?? path;
    }
    const root = await realpath(this.bridge.workspace), actual = await realpath(path);
    if (!contained(root, actual)) throw new ApiError(403, '工作目录不在此 Bot 管理范围内');
    return actual;
  }
  async sourcePath(thread: NativeThread, path: string, area: 'workspace' | 'shared') {
    const root = await this.root(thread, area);
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(p => p === '..' || p.startsWith('.'))) throw new ApiError(403, '文件路径不可访问');
    const candidate = resolve(root, path || '.');
    if (!contained(root, candidate)) throw new ApiError(403, '文件路径超出工作区');
    const actual = await realpath(candidate).catch(() => { throw new ApiError(404, '文件或目录不存在'); });
    if (!contained(root, actual)) throw new ApiError(403, '文件链接超出工作区');
    // Do not browse any symlink, including a directory symlink inside the workspace.
    let cursor = root;
    for (const part of relative(root, candidate).split(sep).filter(Boolean)) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new ApiError(403, '暂不支持工作区符号链接'); }
    return actual;
  }
  async tree(thread: NativeThread, path: string, area: 'workspace' | 'shared') {
    const full = await this.sourcePath(thread, path, area);
    if (!(await stat(full)).isDirectory()) throw new ApiError(400, '请选择目录');
    const entries = (await readdir(full, { withFileTypes: true })).filter(e => !e.name.startsWith('.') && !e.isSymbolicLink() && (e.isDirectory() || e.isFile()) && e.name !== 'node_modules');
    const selected = entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 200);
    return { path, area, truncated: entries.length > 200, entries: await Promise.all(selected.map(async e => ({ name: e.name, path: [path,e.name].filter(Boolean).join('/'), type: e.isDirectory() ? 'directory' : 'file', ...(!e.isDirectory() ? { size: (await stat(join(full,e.name))).size } : {}) }))) };
  }
  fileView(file: WorkspaceFile) { return { ...file, url: `/xbot-api/files/${file.id}/download`, ...(file.mime.startsWith('image/') ? { previewUrl: `/xbot-api/files/${file.id}/image` } : {}) }; }
  async saveFile(thread: NativeThread, name: string, data: Buffer, kind: WorkspaceFile['kind'], source?: { sourcePath: string; sourceMessageId?: string }) {
    if (data.length > MAX_FILE_BYTES) throw new ApiError(413, '单个文件最多 20 MB');
    if (!name || name.length > 180 || name !== basename(name) || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw new ApiError(400, '文件名无效');
    const root = await this.root(thread), id = randomUUID();
    const dir = join(root, '.clowder-bot-files');
    await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    if ((await lstat(dir)).isSymbolicLink() || await realpath(dir) !== dir) throw new ApiError(403, '文件存储目录被重定向');
    const dest = join(dir, id); await mkdir(dest, { mode: 0o700 });
    const path = join(dest, name); await writeFile(path, data, { flag: 'wx', mode: 0o600 });
    const file: WorkspaceFile = { id, threadId: thread.id, name, size: data.length, mime: mimeFor(name, data), sha256: digest(data), kind, createdAt: Date.now(), path, ...source };
    this.bridge.store.state.files[id] = file; this.bridge.store.save(); return this.fileView(file);
  }
  file(id: string) { const file = this.bridge.store.state.files[id]; if (!file) throw new ApiError(404, '文件记录不存在'); return file; }
  async bytes(file: WorkspaceFile) {
    const thread = await this.bridge.thread(file.threadId), root = await this.root(thread);
    const path = await realpath(file.path).catch(() => { throw new ApiError(404, '文件已不存在'); });
    if (!contained(root, path) || path !== file.path) throw new ApiError(403, '文件路径已变化');
    const bytes = await this.readBounded(path);
    if (digest(bytes) !== file.sha256 || bytes.length !== file.size) throw new ApiError(409, '文件内容已变化，不能作为原来的附件或交付物使用');
    return bytes;
  }
  private async readBounded(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const info = await handle.stat(); if (!info.isFile()) throw new ApiError(400, '只能使用普通文件'); if (info.size > MAX_FILE_BYTES) throw new ApiError(413, '单个文件最多 20 MB');
      const data = Buffer.alloc(info.size + 1); let offset = 0;
      while (offset < data.length) { const {bytesRead} = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      if (offset !== info.size) throw new ApiError(409, '文件正在变化，请稍后重试'); return data.subarray(0,offset);
    } finally { await handle.close(); }
  }
  async deliver(thread: NativeThread, path: string, area: 'workspace' | 'shared', sourceMessageId?: string) {
    const full = await this.sourcePath(thread, path, area);
    if (sourceMessageId) {
      const messages = await this.bridge.allMessages(thread.id), message = messages.find(m => m.id === sourceMessageId);
      const refs = message ? this.references(message) : [];
      if (!message || !refs.some(ref => resolve(ref.path) === full)) throw new ApiError(400, '来源消息未引用这个文件');
    }
    return this.saveFile(thread, basename(full), await this.readBounded(full), 'deliverable', { sourcePath: full, ...(sourceMessageId ? {sourceMessageId} : {}) });
  }
  references(message: NativeMessage): Array<{id:string;path:string;revision?:string}> {
    return Array.isArray(message.contentBlocks) ? message.contentBlocks.flatMap((b: any) => b?.type === 'context_attachment' && b.attachment?.kind === 'workspace_file' && typeof b.attachment.path === 'string' ? [b.attachment] : []) : [];
  }
  messageFiles(threadId: string, message: NativeMessage) {
    return [...this.references(message).flatMap(ref => { const file = this.bridge.store.state.files[ref.id]; return file && file.threadId === threadId && file.path === ref.path && ref.revision === `sha256:${file.sha256}` ? [this.fileView(file)] : []; }),
      ...this.bridge.nativeFiles.project(threadId, message)];
  }
  async attachments(threadId: string, ids: string[]) {
    if (ids.length > 8 || new Set(ids).size !== ids.length) throw new ApiError(400, '一次最多发送 8 个不同附件');
    return Promise.all(ids.map(async id => { const file = this.file(id); if (file.threadId !== threadId) throw new ApiError(409, '附件属于其他会话，请重新选择'); await this.bytes(file);
      return { v:1 as const, id:file.id, kind:'workspace_file' as const, path:file.path, revision:`sha256:${file.sha256}` }; }));
  }
}
