import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { MAX_FILE_BYTES, mimeFor } from '../workspaces.js';
import type { BotBridge } from './bridge.js';
import { nativeUploadPath } from './file-path.js';
import type { NativeMessage } from './types.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,199}$/);
const locatorSchema = z.tuple([identity, identity, z.enum(['content', 'rich']), z.number().int().min(0).max(10000), z.string().regex(/^[a-f0-9]{64}$/)]);
type Locator = z.infer<typeof locatorSchema>;
interface SourceFile { source: 'content'|'rich'; index: number; name: string; url: string; mime: string; size: number|null }
export interface NativeFileView {
  id: string; threadId: string; name: string; kind: 'attachment'|'deliverable'; mime: string; size: number|null;
  createdAt: number; sourceMessageId: string|null; nativeSource: true;
  availability: 'available'|'unavailable'; unavailableReason?: string;
}

function sourceFiles(message: NativeMessage): SourceFile[] {
  const content = Array.isArray(message.contentBlocks) ? message.contentBlocks : [];
  const rich = record(message.extra?.rich).blocks;
  const files: SourceFile[] = [];
  for (const [source, blocks] of [['content', content], ['rich', Array.isArray(rich) ? rich : []]] as const) {
    blocks.forEach((raw: unknown, index: number) => {
      const block = record(raw);
      if ((source === 'content' ? block.type : block.kind) !== 'file' || typeof block.fileName !== 'string' || typeof block.url !== 'string') return;
      const mime = typeof block.mimeType === 'string' ? block.mimeType.split(';')[0]!.trim() : '';
      files.push({ source, index, name: block.fileName.slice(0, 500), url: block.url,
        mime: ['text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'].includes(mime) ? mime
          : ['.txt', '.md', '.csv', '.json'].includes(extname(block.fileName).toLowerCase()) ? 'text/plain' : 'application/octet-stream',
        size: Number.isSafeInteger(block.fileSize) && block.fileSize >= 0 ? block.fileSize : null });
    });
  }
  return files;
}

/** Stateless references to native publications. No mirror file catalogue, uploads or source edits. */
export class NativeFiles {
  constructor(private bridge: BotBridge) {}
  project(threadId: string, message: NativeMessage): NativeFileView[] {
    if (!identity.safeParse(threadId).success || !identity.safeParse(message.id).success || message.isDraft) return [];
    return sourceFiles(message).map(source => {
      const locator: Locator = [threadId, message.id, source.source, source.index, hash(source)];
      const available = !!nativeUploadPath(source.url) && !!this.bridge.native.readFile && (source.size === null || source.size <= MAX_FILE_BYTES);
      return { id: 'nf.' + Buffer.from(JSON.stringify(locator)).toString('base64url'), threadId,
        name: source.name, kind: message.type === 'user' ? 'attachment' : 'deliverable', mime: source.mime, size: source.size,
        createdAt: message.timelineOrderAt ?? message.timestamp, sourceMessageId: message.id, nativeSource: true,
        availability: available ? 'available' : 'unavailable',
        ...(!available ? { unavailableReason: source.size !== null && source.size > MAX_FILE_BYTES ? '这份成果超过 20 MB，暂时不能下载' : '这份成果暂时不能下载' } : {}) };
    });
  }
  async list(threadId: string): Promise<{ files: NativeFileView[]; nativeReadStatus: 'ready'|'unavailable'; nativeError?: string }> {
    try {
      const catalog = await this.bridge.native.request<{ artifacts: Array<Record<string, any>>; complete?: boolean; workLineage?: string }>(`/api/threads/${encodeURIComponent(threadId)}/artifacts`);
      if (!Array.isArray(catalog.artifacts)) throw new ApiError(502, '原生成果目录暂时不可读');
      const messages = new Map((await this.bridge.allMessages(threadId)).map(message => [message.id, message]));
      const files = new Map<string, NativeFileView>();
      for (const artifact of catalog.artifacts) {
        if (artifact.type !== 'file') continue;
        const message = typeof artifact.sourceMessageId === 'string' ? messages.get(artifact.sourceMessageId) : undefined;
        const published = message ? this.project(threadId, message) : [];
        if (published.length) for (const file of published) files.set(file.id, file);
        else {
          // Ledger-only and otherwise unresolved records are not downloadable file authority.
          const id = 'nfu.' + hash([threadId, artifact.sourceMessageId, artifact.publicationItem, artifact.ref, artifact.name]);
          files.set(id, { id, threadId, name: typeof artifact.name === 'string' ? artifact.name : '原生成果',
            kind: 'deliverable', mime: 'application/octet-stream', size: null, createdAt: Number(artifact.createdAt) || 0,
            sourceMessageId: message?.id ?? null, nativeSource: true, availability: 'unavailable', unavailableReason: '这份成果暂时不能下载' });
        }
      }
      const partial = catalog.complete === false;
      return { files: [...files.values()], nativeReadStatus: partial ? 'unavailable' : 'ready',
        ...(partial ? { nativeError: '部分原生成果暂时不可读，请重试' } : {}) };
    } catch {
      return { files: [], nativeReadStatus: 'unavailable', nativeError: '原生成果暂时读不到，已保留现有文件，请重试' };
    }
  }
  async read(id: string) {
    if (!/^nf\.[A-Za-z0-9_-]{1,1800}$/.test(id)) throw new ApiError(404, '文件来源不存在');
    let locator: Locator;
    try { locator = locatorSchema.parse(JSON.parse(Buffer.from(id.slice(3), 'base64url').toString('utf8'))); }
    catch { throw new ApiError(404, '文件来源不存在'); }
    const [threadId, messageId, kind, index, revision] = locator;
    // Thread ownership and owner-visible timeline are checked again on every byte read.
    await this.bridge.thread(threadId);
    const message = (await this.bridge.allMessages(threadId)).find(item => item.id === messageId);
    if (!message || message.isDraft) throw new ApiError(404, '来源消息已不可读取');
    const source = sourceFiles(message).find(item => item.source === kind && item.index === index);
    if (!source || hash(source) !== revision) throw new ApiError(409, '来源文件记录已变化，请刷新后重试');
    const path = nativeUploadPath(source.url);
    if (!path || !this.bridge.native.readFile) throw new ApiError(422, '这份成果暂时不能下载');
    const bytes = await this.bridge.native.readFile(path, MAX_FILE_BYTES);
    // Re-check publication after the byte read; a changed source never silently changes the return coordinate.
    const current = (await this.bridge.allMessages(threadId)).find(item => item.id === messageId);
    const currentSource = current && !current.isDraft ? sourceFiles(current).find(item => item.source === kind && item.index === index) : undefined;
    if (!currentSource || hash(currentSource) !== revision) throw new ApiError(409, '来源文件记录已变化，请刷新后重试');
    return { name: source.name, mime: mimeFor(source.name, bytes), bytes };
  }
}
