/** Shorten display text to at most `max` UTF-16 units without cutting a surrogate pair in half. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end) + '…';
}
