import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeTransport } from './types.js';

/**
 * How a cat talks in this app: the way one answers in a chat, not the way a workspace assistant reports
 * (headings, bullet lists, tables, emoji). It is the default for every cat and not a setting (owner,
 * 2026-11-12: 「说话简短作为一个默认选项，不需要按钮配置」).
 *
 * Measured on the isolated runtime (2026-11-12, Claude haiku, the same two questions, a new conversation
 * each time): 387 and 600 characters in 32 and 35 lines without it; 124 and 166 characters in 3 lines each
 * with it, and still a table when a table was asked for.
 */
export const chatManner = '说话像在聊天软件里回消息：先说结论，通常两三句话说完；不用标题、列表、表格和表情符号，不复述问题，不铺垫，不在结尾总结。对方明确要清单、表格、代码或长文时照给；内容确实多时先说要点，问一句要不要展开。';

/**
 * It reaches the cats as a default behaviour of an engine pack (Clowder AI F129, unpatched): a pack's
 * `defaults.yaml` is compiled into every cat's identity as 「默认行为（用户可覆盖）」, whichever tool the cat
 * thinks with and whoever made it. Nothing is written into a cat's own role or personality. The engine
 * gives a cat its identity when a session starts (and again after its context was compacted), so a
 * conversation in progress keeps talking the way it did until then.
 *
 * The version carries the text, so changing the sentence replaces the installed pack.
 */
export const chatPack = {
  name: 'clowder-bot-chat',
  version: `1.0.0-${createHash('sha256').update(chatManner).digest('hex').slice(0, 8)}`,
  description: '在聊天软件里怎么说话：先说结论，几句话说完。',
  packType: 'style',
} as const;
export const chatPackDefaults = { behaviors: [{ id: 'chat-manner', scope: 'all-cats', behavior: chatManner, overridable: true }] } as const;

type Installed = { name?: unknown; version?: unknown };
const ours = (pack: Installed) => pack.name === chatPack.name && pack.version === chatPack.version;

/** Keeps that pack in the engine. Bookkeeping of one request only: the engine's pack store is the record. */
export class ChatPack {
  /** How long a confirmed pack is taken for granted before the engine is asked again. */
  static readonly trust = 10 * 60_000;
  private confirmed = 0;
  private flight?: Promise<boolean>;
  private said = '';
  constructor(private readonly native: NativeTransport, private readonly now: () => number = Date.now) {}

  /**
   * True when the engine has the pack. Never throws and never holds a message back: without the pack a cat
   * still answers, only at more length, and the next call tries again.
   */
  ensure(): Promise<boolean> {
    if (this.now() - this.confirmed < ChatPack.trust && this.confirmed) return Promise.resolve(true);
    return this.flight ??= this.install().then(() => { this.confirmed = this.now(); this.say(''); return true; }, error => {
      this.confirmed = 0; this.say(`chat pack not installed: ${error instanceof Error ? error.message : String(error)}`); return false;
    }).finally(() => { this.flight = undefined; });
  }

  private async install() {
    const installed = async () => (await this.native.request<{ packs?: Installed[] }>('/api/packs')).packs ?? [];
    let packs = await installed();
    if (!packs.some(ours)) {
      // The engine installs a pack from a directory it copies: written for this one request and removed again.
      const dir = await mkdtemp(join(tmpdir(), 'clowder-bot-pack-'));
      try {
        // JSON is YAML: the engine reads these with its YAML parser and validates them against its own schemas.
        await writeFile(join(dir, 'pack.yaml'), JSON.stringify(chatPack, null, 2));
        await writeFile(join(dir, 'defaults.yaml'), JSON.stringify(chatPackDefaults, null, 2));
        await this.native.request('/api/packs/add', { method: 'POST', body: { source: dir } });
      } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
      packs = await installed();
      if (!packs.some(ours)) throw new Error('the engine does not list it after installing');
    }
    // The pinned engine applies one pack, the first it lists. Another one is the owner's and stays; it is only said.
    if (!ours(packs[0] ?? {})) throw new Error(`the engine applies another pack first (${String(packs[0]?.name)})`);
  }

  /** One line per change of state, not one per message sent. */
  private say(line: string) {
    if (line === this.said) return;
    this.said = line;
    if (line) console.warn(`🐾 ${line}`);
  }
}
