import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export interface BotPresentation {
  templateId?: string;
  activeThreadId?: string;
  projectId?: string | null;
  workspaceThreads?: Record<string, string>;
  /** Existing native conversations, including retired project views. No copied messages. */
  conversationIds?: string[];
  folder?: string;
  avatarSeed?: string;
  avatarData?: string;
  avatarMime?: string;
  avatarUpdated?: number;
  timezone?: string;
  pinned?: boolean;
  lastReadMessageId?: string;
  /** Provenance only; executable configuration lives on the native member. */
  sourceTemplate?: { id: string; revision: number; name: string };
}
export interface ProjectPresentation { id: string; name: string; path: string; sharedPath: string; createdAt: number }
export interface WorkspaceFile {
  id: string; threadId: string; name: string; size: number; mime: string; sha256: string;
  kind: 'attachment' | 'deliverable'; createdAt: number; path: string;
  sourcePath?: string; sourceMessageId?: string;
}
interface ProductState {
  version: 1;
  bots: Record<string, BotPresentation>;
  groupThreadIds: string[];
  folders: string[];
  deviceName?: string;
  /** Presentation sequence numbers only. Messages remain in native storage. */
  messageRefs: Record<string, Record<string, number>>;
  projects: ProjectPresentation[];
  groupProjects: Record<string, string>;
  files: Record<string, WorkspaceFile>;
}
const presentationSchema = z.object({
  version: z.literal(1),
  bots: z.record(z.string(), z.object({
    templateId: z.string().optional(), activeThreadId: z.string().optional(), folder: z.string().optional(),
    projectId: z.string().nullable().optional(), workspaceThreads: z.record(z.string(), z.string()).optional(),
    conversationIds: z.array(z.string()).optional(),
    avatarSeed: z.string().optional(), avatarData: z.string().optional(), avatarMime: z.string().optional(),
    avatarUpdated: z.number().optional(), timezone: z.string().optional(), pinned: z.boolean().optional(),
    lastReadMessageId: z.string().optional(),
    sourceTemplate: z.object({ id: z.string(), revision: z.number().int().nonnegative(), name: z.string() }).strict().optional(),
  }).strict()),
  groupThreadIds: z.array(z.string()), folders: z.array(z.string()), deviceName: z.string().optional(),
  messageRefs: z.record(z.string(), z.record(z.string(), z.number().int().positive())),
  projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string(), sharedPath: z.string(), createdAt: z.number() }).strict()).default([]),
  groupProjects: z.record(z.string(), z.string()).default({}),
  files: z.record(z.string(), z.object({ id: z.string(), threadId: z.string(), name: z.string(), size: z.number().int().nonnegative(),
    mime: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['attachment', 'deliverable']), createdAt: z.number(),
    path: z.string(), sourcePath: z.string().optional(), sourceMessageId: z.string().optional(),
  }).strict()).default({}),
}).strict();

/** Presentation, workspace references and file manifests only; never execution, messages, memory or credentials. */
export class ProductStore {
  readonly state: ProductState;
  constructor(readonly file = resolve('data/bot/presentation.json')) {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const parsed = presentationSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error('Unsupported presentation store. Legacy state.json must be migrated explicitly.');
      }
      this.state = parsed.data;
    } else this.state = { version: 1, bots: {}, groupThreadIds: [], folders: [], messageRefs: {}, projects: [], groupProjects: {}, files: {} };
  }
  bot(id: string): BotPresentation { return this.state.bots[id] ??= {}; }
  sequence(threadId: string, messageId: string): number {
    const refs = this.state.messageRefs[threadId] ??= {};
    // Reserve the next slot for XBot's UI delivery receipt.
    if (!refs[messageId]) refs[messageId] = Object.values(refs).reduce((n, seq) => Math.max(n, seq), -1) + 2;
    return refs[messageId];
  }
  messageId(threadId: string, seq: number): string | undefined {
    return Object.entries(this.state.messageRefs[threadId] ?? {}).find(([, n]) => n === seq)?.[0];
  }
  save(): void {
    presentationSchema.parse(this.state);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
