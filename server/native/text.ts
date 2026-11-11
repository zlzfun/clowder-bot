/** Shorten display text to at most `max` UTF-16 units without cutting a surrogate pair in half. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end) + '…';
}

/**
 * A cat's Markdown as one line of everyday words, for the contact list's
 * preview and for search snippets: the marks that would show as noise there
 * (fences, table rules and pipes, heading / quote / list markers, bold, inline
 * code, link targets) are dropped, the words stay. Display only.
 */
export function plainLine(value: string): string {
  return value
    .replace(/^[ \t]*(?:`{3,}|~{3,}).*$/gm, ' ')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/^[ \t]*\|.*$/gm, row => row.replace(/\|/g, ' '))
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ').trim();
}
