import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { MAX_FILE_BYTES, mimeFor } from '../workspaces.js';
import type { BotBridge } from './bridge.js';
import { nativeUploadPath, ttsAudioPath } from './file-path.js';
import type { NativeMessage } from './types.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,199}$/);
const locatorSchema = z.tuple([identity, identity, z.enum(['content', 'rich']), z.number().int().min(0).max(10000), z.string().regex(/^[a-f0-9]{64}$/)]);
const mediaLocatorSchema = z.tuple([identity, identity, z.enum(['gallery', 'audio']), z.number().int().min(0).max(49), z.number().int().min(0).max(49), z.string().regex(/^[a-f0-9]{64}$/)]);
type Locator = z.infer<typeof locatorSchema>;
type MediaLocator = z.infer<typeof mediaLocatorSchema>;
export const AUDIO_MEDIA_MIMES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
};
const IMAGE_MEDIA_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BLOCKED_GALLERY_EXTS = new Set(['.svg', '.html', '.htm', '.xhtml', '.xml', '.js', '.mjs', '.cjs']);

export function mediaToken(threadId: string, messageId: string, kind: 'gallery' | 'audio', blockIndex: number, itemIndex: number, url: string): string | null {
  if (!identity.safeParse(threadId).success || !identity.safeParse(messageId).success) return null;
  const locator: MediaLocator = [threadId, messageId, kind, blockIndex, itemIndex, hash({ kind, url })];
  return 'nm.' + Buffer.from(JSON.stringify(locator)).toString('base64url');
}

export function isAllowedGalleryUploadExt(url: string): boolean {
  const ext = extname(url).toLowerCase();
  return !BLOCKED_GALLERY_EXTS.has(ext) && (ext === '' || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext));
}

export function isAllowedAudioUploadExt(url: string): boolean {
  return Object.hasOwn(AUDIO_MEDIA_MIMES, extname(url).toLowerCase());
}

function richMediaSource(message: NativeMessage, kind: 'gallery' | 'audio', blockIndex: number, itemIndex: number): string | null {
  const rich = record(message.extra?.rich).blocks;
  if (!Array.isArray(rich)) return null;
  const block = record(rich.slice(0, 50)[blockIndex]);
  if (kind === 'gallery') {
    if (block.kind !== 'media_gallery' || !Array.isArray(block.items)) return null;
    const item = record(block.items.slice(0, 50)[itemIndex]);
    return typeof item.url === 'string' ? item.url : null;
  }
  if (block.kind !== 'audio' || itemIndex !== 0) return null;
  return typeof block.url === 'string' ? block.url : null;
}

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
      if (!Array.isArray(catalog.artifacts)) throw new ApiError(502, '文件目录暂时读不到');
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
          files.set(id, { id, threadId, name: typeof artifact.name === 'string' ? artifact.name : '文件',
            kind: 'deliverable', mime: 'application/octet-stream', size: null, createdAt: Number(artifact.createdAt) || 0,
            sourceMessageId: message?.id ?? null, nativeSource: true, availability: 'unavailable', unavailableReason: '这份成果暂时不能下载' });
        }
      }
      const partial = catalog.complete === false;
      return { files: [...files.values()], nativeReadStatus: partial ? 'unavailable' : 'ready',
        ...(partial ? { nativeError: '有些文件暂时读不到，请重试' } : {}) };
    } catch {
      return { files: [], nativeReadStatus: 'unavailable', nativeError: '引擎里的文件暂时读不到，已保留现有文件，请重试' };
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
  async readMedia(id: string): Promise<{ mime: string; bytes: Buffer }> {
    if (!/^nm\.[A-Za-z0-9_-]{1,1800}$/.test(id)) throw new ApiError(404, '媒体来源不存在');
    let locator: MediaLocator;
    try { locator = mediaLocatorSchema.parse(JSON.parse(Buffer.from(id.slice(3), 'base64url').toString('utf8'))); }
    catch { throw new ApiError(404, '媒体来源不存在'); }
    const [threadId, messageId, kind, blockIndex, itemIndex, revision] = locator;
    await this.bridge.thread(threadId);
    const message = (await this.bridge.allMessages(threadId)).find(item => item.id === messageId);
    if (!message || message.isDraft || message.type !== 'assistant') throw new ApiError(404, '来源消息已不可读取');
    const url = richMediaSource(message, kind, blockIndex, itemIndex);
    if (!url || hash({ kind, url }) !== revision) throw new ApiError(409, '来源媒体记录已变化，请刷新后重试');
    const ttsPath = kind === 'audio' ? ttsAudioPath(url) : null;
    const uploadPath = ttsPath ? null : nativeUploadPath(url);
    if (ttsPath) {
      if (!this.bridge.native.readTtsAudio) throw new ApiError(422, '这份媒体暂时不能读取');
    } else if (!uploadPath || !this.bridge.native.readFile) {
      throw new ApiError(422, '这份媒体暂时不能读取');
    }
    const targetPath = ttsPath ?? uploadPath!;
    if (kind === 'gallery' && !isAllowedGalleryUploadExt(targetPath)) throw new ApiError(415, '此图片格式暂不支持预览');
    const audioMime = kind === 'audio' ? AUDIO_MEDIA_MIMES[extname(targetPath).toLowerCase()] : undefined;
    if (kind === 'audio' && !audioMime) throw new ApiError(415, '此音频格式暂不支持播放');
    const bytes = ttsPath
      ? await this.bridge.native.readTtsAudio!(ttsPath, MAX_FILE_BYTES)
      : await this.bridge.native.readFile!(uploadPath!, MAX_FILE_BYTES);
    const current = (await this.bridge.allMessages(threadId)).find(item => item.id === messageId);
    const currentUrl = current && !current.isDraft && current.type === 'assistant' ? richMediaSource(current, kind, blockIndex, itemIndex) : null;
    if (!currentUrl || hash({ kind, url: currentUrl }) !== revision) throw new ApiError(409, '来源媒体记录已变化，请刷新后重试');
    if (kind === 'gallery') {
      const mime = mimeFor(targetPath, bytes);
      if (!IMAGE_MEDIA_MIMES.has(mime)) throw new ApiError(415, '此文件不支持图片预览');
      return { mime, bytes };
    }
    const head = bytes.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<svg') || head.startsWith('<script')) {
      throw new ApiError(415, '此文件不支持音频播放');
    }
    return { mime: audioMime!, bytes };
  }
}
