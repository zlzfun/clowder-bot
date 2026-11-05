/** Only native uploads are admitted; never a general URL, API or filesystem proxy. */
export function nativeUploadPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/uploads/') || value.length > 2048 || /[?#\\\x00-\x20\x7f]/.test(value)) return null;
  const parts = value.slice('/uploads/'.length).split('/');
  if (!parts.length || parts.some(part => {
    try { const decoded = decodeURIComponent(part); return !decoded || decoded === '.' || decoded === '..' || /[/\\%\x00-\x1f\x7f]/.test(decoded); }
    catch { return true; }
  })) return null;
  return value;
}
