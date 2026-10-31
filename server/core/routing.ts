// Adapted from Clowder AI a2a-mentions.ts (MIT), F046 line-start routing.
// Copyright (c) 2026 Clowder AI Contributors. See docs/licenses/clowder-ai-MIT.txt.
import type { Bot, BotTemplate } from '../../shared/types.js';

export function outsideCode(text: string): string {
  let fence = '';
  return text.split('\n').map(line => {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}

export function handles(bot: Bot, templates: BotTemplate[]): string[] {
  const template = templates.find(t => t.id === bot.templateId);
  return [...new Set([bot.id, bot.name, ...(template ? [template.nickname, template.name] : [])])];
}

export function parseMentions(text: string, bots: Bot[], templates: BotTemplate[], currentBotId?: string, lineStart = true): Bot[] {
  const candidates = bots.flatMap(bot => handles(bot, templates).map(handle => ({ bot, handle: `@${handle}`.toLowerCase(),
    canonical: handle === bot.id || handle === bot.name })));
  // Multiple bots can be created from one template. Shared template aliases must
  // never randomly select a clone; a unique display name / id takes precedence.
  const entries = candidates.filter(entry => {
    const matches = candidates.filter(other => other.handle === entry.handle);
    const canonical = matches.filter(other => other.canonical);
    return canonical.length ? entry.canonical && canonical.length === 1 : matches.length === 1;
  }).sort((a, b) => b.handle.length - a.handle.length);
  const result: Bot[] = [];
  const seen = new Set<string>();
  const lines = outsideCode(text).replace(/<memory\b[^>]*>[\s\S]*?<\/memory>/g, '').toLowerCase().split('\n');
  for (const raw of lines) {
    // Quotes are context, not executable handoffs. Lists remain accepted.
    if (raw.trimStart().startsWith('>')) continue;
    const line = raw.trimStart().replace(/^(?:(?:[-*+]\s+)|(?:\d+[.)]\s+))+/, '');
    const positions = lineStart ? [0] : Array.from(line.matchAll(/@/g), match => match.index!);
    for (const position of positions) {
      if (position && /[\p{L}\p{N}_.-]/u.test(line[position - 1]!)) continue;
      let cursor = position;
      while (line[cursor] === '@') {
        const entry = entries.find(({ handle }) => {
          if (!line.slice(cursor).startsWith(handle)) return false;
          const next = line[cursor + handle.length];
          return !next || !/[\p{L}\p{N}_.-]/u.test(next);
        });
        if (!entry) break;
        cursor += entry.handle.length;
        if (entry.bot.id !== currentBotId && !seen.has(entry.bot.id)) {
          result.push(entry.bot);
          seen.add(entry.bot.id);
          if (result.length === 2) return result;
        }
        while (/[\s,，、:：]/.test(line[cursor] ?? '') && cursor < line.length) cursor++;
      }
    }
  }
  return result;
}

export function parseMemoryTags(text: string): { scope: 'bot' | 'shared'; content: string }[] {
  return Array.from(outsideCode(text).matchAll(/^[\t ]*<memory\s+scope=["'](shared|bot)["']\s*>([\s\S]*?)<\/memory>[\t ]*$/gm))
    .slice(0, 5).map(match => ({ scope: match[1] as 'shared' | 'bot', content: match[2]!.trim().slice(0, 4000) }))
    .filter(memory => memory.content);
}

/** Hide protocol payloads, including an unfinished tag during streaming. */
export function displayText(text: string): string {
  const hide = (prose: string) => prose.replace(/^[\t ]*<memory\b[^>]*>[\s\S]*?<\/memory>[\t ]*$/gm, '')
    .replace(/(^|\n)[\t ]*<memory\b[\s\S]*$/, '$1')
    .replace(/(^|\n)[\t ]*<(?:m(?:e(?:m(?:o(?:r(?:y)?)?)?)?)?)?$/, '$1');
  let result = '', prose = '', fence = '';
  for (const line of text.split(/(?<=\n)/)) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker && !fence) { result += hide(prose) + line; prose = ''; fence = marker; }
    else if (fence) { result += line; if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = ''; }
    else prose += line;
  }
  return result + hide(prose);
}
