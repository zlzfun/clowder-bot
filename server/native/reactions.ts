import type { NativeMessage } from './types.js';

// Built from a string so the source holds no flag the compile target would refuse; Node 24 knows `v` and RGI_Emoji.
const oneEmoji = new RegExp('^\\p{RGI_Emoji}$', 'v');
const emojiStyle = String.fromCodePoint(0xfe0f);

/**
 * The emoji a text consists of when it is exactly one emoji and nothing else (a thumb with a skin tone, a flag
 * and a family are one each). A symbol typed without its emoji-style mark ("❤" for "❤️") is given it. Undefined
 * for anything else, words with an emoji included.
 */
export function soleEmoji(text: string): string | undefined {
  const said = text.trim();
  if (!said || said.length > 40) return undefined;
  if (oneEmoji.test(said)) return said;
  return said.codePointAt(0)! >= 0x2000 && oneEmoji.test(said + emojiStyle) ? said + emojiStyle : undefined;
}

/**
 * A reaction as a row carries it: the native message it is (`id`, and `seq`, its number in the conversation), the
 * message it answers by the native record (`reply_to_id`: the row it is on, or an earlier reaction on that row), and who sent it.
 */
export interface ReactionMark { id: string; seq: number; reply_to_id: string; emoji: string; mine: boolean; name?: string; native_cat_id?: string; time: string }
type Row = Record<string, unknown> & { reactions?: ReactionMark[] };
const author = (message: NativeMessage) => message.type === 'user' ? 'owner' : message.catId ?? '';

/**
 * One page of a conversation, read in order, for the two things a row says about another row.
 *
 * What it quotes. A reply names the message it answers; right under that message the quote only repeats it, so
 * it is given when something else came in between. What the owner quotes is always given.
 *
 * What is drawn on it as a reaction. The engine has no reactions on a conversation's messages (pinned upstream:
 * no field, no route, nothing a cat can read or call). Here a reaction is an ordinary native message: one emoji
 * and nothing else, sent as a reply to what someone else said — the owner's to a cat's message, a cat's whole
 * answer to the owner's. The cat really receives the owner's and may go on from it; the owner really got the
 * cat's. Such a message is not drawn as a line of its own but on the row it answers, and an answer to it that
 * is again only an emoji joins it there. Display only: nothing is stored, the native records are the record,
 * and a reaction whose message is on another page stays the ordinary quoted message it is.
 */
export class PageReading {
  private lastUser?: string;
  private previous?: string;
  private rows = new Map<string, { row: Row; author: string }>();
  private roots = new Map<string, string>();
  /**
   * `invitation`: the opening line the app sent for the owner, which is never shown and never quoted.
   * `reactions`: whether the reader draws reactions. A page that does not say so (one opened before the app
   * knew of them) gets every message as the line it is, so a cat's answer of one emoji cannot go unseen.
   */
  constructor(private page: { hasMore: boolean; invitation?: string; reactions?: boolean }) {}

  /** Whether this message was drawn on another row as a reaction. */
  folded(id: string): boolean { return this.roots.has(id); }

  /** Draws this message on the earlier row it reacts to, if there is one on this page. False: it is an ordinary message here. */
  react(message: NativeMessage, mark: ReactionMark): boolean {
    if (!this.page.reactions || !message.replyTo) return false;
    const chained = this.roots.get(message.replyTo), root = chained ?? message.replyTo, target = this.rows.get(root);
    // One's own message is quoted, not reacted to — except as the answer to a reaction on it.
    if (!target || (!chained && target.author === author(message))) return false;
    (target.row.reactions ??= []).push(mark);
    this.roots.set(message.id, root);
    return true;
  }

  /** The message this one is shown as quoting (a native id), if any. Call once for every message that is not a reaction, in order. */
  quote(message: NativeMessage): string | undefined {
    const inputs = message.type !== 'user' && Array.isArray(message.lifecycle?.inputMessageIds) ? message.lifecycle.inputMessageIds as unknown[] : [];
    // An answer to a reaction answers the message that reaction is drawn on.
    const root = message.replyTo ? this.roots.get(message.replyTo) : undefined, answered = root ?? message.replyTo;
    // A reply that answers several of the owner's messages at once (the engine lists them as its inputs) stands under
    // the last of them: quoting the first, two lines up, says nothing new.
    const answersBoth = !root && this.lastUser !== undefined && inputs.includes(this.lastUser) && inputs.includes(message.replyTo);
    // At the top of a page that continues further back, what came just before is not known; no quote is guessed there.
    const quoted = answered && answered !== this.page.invitation
      && !(message.type !== 'user' && (answered === this.lastUser || answered === this.previous || answersBoth || (this.lastUser === undefined && this.page.hasMore)))
      ? answered : undefined;
    if (message.type === 'user') this.lastUser = message.id;
    // …and the same for a reply right under any other line it answers (a reminder that came due).
    this.previous = message.id;
    return quoted;
  }

  /** An ordinary message row of the owner's or a cat's, which later messages on the page may react to. */
  drawn(message: NativeMessage, row: Row) { this.rows.set(message.id, { row, author: author(message) }); }
}
