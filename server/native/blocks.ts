import type { NativeMessage } from './types.js';
import { clip } from './text.js';

/**
 * What a cat attached to a message besides words and files, as the chat can
 * draw it: the native rich blocks (`extra.rich`, written by the engine's
 * create-rich-block tool) reduced to the fields a chat shows. Files are
 * projected separately (files.ts). Kinds the chat cannot show yet are counted
 * so the message can say something is missing instead of dropping it silently.
 */
export type ChatBlock =
  | { id: string; kind: 'card'; title: string; body?: string; tone?: 'info' | 'success' | 'warning' | 'danger'; fields?: Array<{ label: string; value: string }>;
      /** Set when the card is a native request for the owner's confirmation (see approvals.ts). */
      approval?: { id: string } }
  | { id: string; kind: 'checklist'; title?: string; items: Array<{ id: string; text: string; checked: boolean }> }
  | { id: string; kind: 'choices'; mode: 'single' | 'multiple' | 'confirm'; title?: string; description?: string;
      options: Array<{ id: string; label: string; emoji?: string; description?: string; custom?: true }>;
      max?: number; template?: string; answered: boolean; selected: string[] }
  | { id: string; kind: 'diff'; file: string; diff: string };

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? clip(value, max) : undefined;
const tones = ['info', 'success', 'warning', 'danger'] as const;

export function messageBlocks(message: NativeMessage): { blocks: ChatBlock[]; hidden: number } {
  const raw = record(message.extra?.rich).blocks, blocks: ChatBlock[] = [];
  let hidden = 0;
  for (const entry of Array.isArray(raw) ? raw.slice(0, 50) : []) {
    const block = record(entry), id = text(block.id, 200);
    if (!id) { hidden++; continue; }
    if (block.kind === 'file') continue;
    if (block.kind === 'card' && text(block.title, 300)) {
      const approval = record(record(block.meta).approval), proposal = text(approval.canonicalProposalId, 200);
      const fields = (Array.isArray(block.fields) ? block.fields : []).map(record)
        .filter(field => typeof field.label === 'string' && typeof field.value === 'string').slice(0, 20)
        .map(field => ({ label: clip(field.label as string, 80), value: clip(field.value as string, 400) }));
      blocks.push({ id, kind: 'card', title: text(block.title, 300)!, ...(text(block.bodyMarkdown, 8000) ? { body: text(block.bodyMarkdown, 8000)! } : {}),
        ...(tones.includes(block.tone as never) ? { tone: block.tone as typeof tones[number] } : {}), ...(fields.length ? { fields } : {}),
        ...(proposal ? { approval: { id: proposal } } : {}) });
    } else if (block.kind === 'checklist' && Array.isArray(block.items)) {
      const items = block.items.map(record).filter(item => typeof item.id === 'string' && typeof item.text === 'string').slice(0, 100)
        .map(item => ({ id: item.id as string, text: clip(item.text as string, 500), checked: item.checked === true }));
      if (!items.length) { hidden++; continue; }
      blocks.push({ id, kind: 'checklist', ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}), items });
    } else if (block.kind === 'interactive' && Array.isArray(block.options)) {
      const options = block.options.map(record).filter(option => typeof option.id === 'string' && typeof option.label === 'string').slice(0, 40)
        .map(option => ({ id: option.id as string, label: clip(option.label as string, 200),
          ...(text(option.emoji, 16) ? { emoji: text(option.emoji, 16)! } : {}), ...(text(option.description, 400) ? { description: text(option.description, 400)! } : {}),
          ...(option.customInput === true ? { custom: true as const } : {}) }));
      if (!options.length) { hidden++; continue; }
      const selected = Array.isArray(block.selectedIds) ? block.selectedIds.filter((value): value is string => typeof value === 'string') : [];
      blocks.push({ id, kind: 'choices', mode: block.interactiveType === 'confirm' ? 'confirm' : block.interactiveType === 'multi-select' ? 'multiple' : 'single',
        ...(text(block.title, 300) ? { title: text(block.title, 300)! } : {}), ...(text(block.description, 1000) ? { description: text(block.description, 1000)! } : {}),
        options, ...(typeof block.maxSelect === 'number' && block.maxSelect > 0 ? { max: block.maxSelect } : {}),
        ...(text(block.messageTemplate, 1000) ? { template: text(block.messageTemplate, 1000)! } : {}),
        // Native marks a choice that was made by disabling the block and recording what was picked.
        answered: block.disabled === true || selected.length > 0, selected });
    } else if (block.kind === 'diff' && typeof block.diff === 'string' && typeof block.filePath === 'string') {
      const file = block.filePath.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '文件';
      blocks.push({ id, kind: 'diff', file: clip(file, 120), diff: clip(block.diff, 20000) });
    } else hidden++; // media, audio, widgets: not drawn yet
  }
  return { blocks, hidden };
}

/** One line for a contact-list preview when a message has no words: what its first block is called. */
export function blockLine(blocks: ChatBlock[]): string {
  const first = blocks[0];
  if (!first) return '';
  return first.kind === 'diff' ? first.file : first.title ?? (first.kind === 'checklist' ? first.items[0]!.text : first.kind === 'choices' ? first.options.map(option => option.label).join(' / ') : '');
}
