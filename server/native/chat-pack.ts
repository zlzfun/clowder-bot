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
 *
 * Its last sentence (2026-11-13) is what lets a cat answer with a reaction: a reply that is one emoji and nothing
 * else is drawn on the owner's message instead of as a line of its own (see reactions.ts). It names the moments a
 * person would do that — thanks, a goodbye, a reaction of the owner's with nothing to act on — and no other.
 */
export const chatManner = '说话像在聊天软件里回消息：先说结论，通常两三句话说完；不用标题、列表、表格和表情符号，不复述问题，不铺垫，不在结尾总结。对方明确要清单、表格、代码或长文时照给；内容确实多时先说要点，问一句要不要展开。对方只是道谢、道别，或只回了一个表情，而你没有别的要说、也没有要接着做的事时，只回一个表情就够了，不必写字。';

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
  /** How long a message waits for the pack at most. Installing goes on by itself after that. */
  static readonly patience = 2500;
  /** When the engine last confirmed the pack, on a clock that only goes forward; undefined while it has not. */
  private confirmed?: number;
  private flight?: Promise<boolean>;
  /** An installation that was asked for and did not come back well: the engine may hold half of it under the right name. */
  private unfinished = false;
  private said = '';
  constructor(private readonly native: NativeTransport, private readonly now: () => number = () => performance.now()) {}

  /**
   * True when the engine has the pack and applies it. Never throws: without the pack a cat still answers,
   * only at more length, and the next call tries again.
   */
  ensure(): Promise<boolean> {
    if (this.confirmed !== undefined && this.now() - this.confirmed < ChatPack.trust) return Promise.resolve(true);
    return this.flight ??= this.install().then(() => { this.confirmed = this.now(); this.say(''); return true; }, error => {
      this.confirmed = undefined; this.say(`chat pack not in effect: ${error instanceof Error ? error.message : String(error)}`); return false;
    }).finally(() => { this.flight = undefined; });
  }

  /**
   * The same, for the moment before a cat is given something to answer: a message is not held back longer
   * than `patience` by a default manner. What was started is finished (and cleaned up) regardless.
   */
  async ready(patience = ChatPack.patience): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.ensure(), new Promise<boolean>(done => { timer = setTimeout(() => done(false), patience); })]); }
    finally { clearTimeout(timer); }
  }

  private async install() {
    const installed = async () => { const packs = (await this.native.request<{ packs?: Installed[] }>('/api/packs')).packs; return Array.isArray(packs) ? packs : []; };
    let packs = await installed();
    // The pinned engine applies one pack: the first of its list, which is the order of a directory and not of
    // installation. A pack that is not this app's is the owner's: adding or replacing ours beside it could put ours
    // first and silence theirs. So beside another pack nothing is installed, and theirs stays the one in effect.
    const theirs = packs.find(pack => pack.name !== chatPack.name);
    if (theirs) {
      if (ours(packs[0] ?? {}) && !this.unfinished) return;
      throw new Error(`the engine has another pack (${String(theirs.name)}), which is left as it is`);
    }
    if (!packs.some(ours) || this.unfinished) {
      // The engine installs a pack from a directory it copies: written for this one request and removed again.
      const dir = await mkdtemp(join(tmpdir(), 'clowder-bot-pack-'));
      try {
        // JSON is YAML: the engine reads these with its YAML parser and validates them against its own schemas.
        await writeFile(join(dir, 'pack.yaml'), JSON.stringify(chatPack, null, 2));
        await writeFile(join(dir, 'defaults.yaml'), JSON.stringify(chatPackDefaults, null, 2));
        // The engine replaces a pack by removing and copying, and lists a pack by its manifest alone. A copy that broke
        // off can therefore look installed; until an installation has come back well, the list is not taken as proof.
        this.unfinished = true;
        await this.native.request('/api/packs/add', { method: 'POST', body: { source: dir } });
        this.unfinished = false;
      } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
      packs = await installed();
      if (!ours(packs[0] ?? {})) throw new Error('the engine does not list it after installing');
    }
  }

  /** One line per change of state, not one per message sent. */
  private say(line: string) {
    if (line === this.said) return;
    this.said = line;
    if (line) console.warn(`🐾 ${line}`);
  }
}
