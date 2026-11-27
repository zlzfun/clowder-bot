/** Wording of a native schedule trigger. Pure, shared by the request list and the request cards in a chat. */
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** A native schedule trigger in everyday words; an expression it does not recognise is shown as it is. */
export function triggerWords(trigger: unknown): string {
  const t = record(trigger);
  if (t.type === 'once' && typeof t.fireAt === 'number')
    return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t.fireAt));
  // A one-off counted from the moment it is agreed to ("3 分钟后提醒我").
  if (t.type === 'once' && typeof t.delayMs === 'number' && t.delayMs > 0) {
    const minutes = Math.max(1, Math.round(t.delayMs / 60000));
    const span = minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
    return t.relativeTo === 'approval' ? `同意后 ${span}` : `${span}后`;
  }
  if (t.type === 'interval' && typeof t.ms === 'number' && t.ms > 0) {
    const minutes = Math.round(t.ms / 60000);
    return minutes % 1440 === 0 ? `每 ${minutes / 1440} 天` : minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  }
  if (t.type === 'cron' && typeof t.expression === 'string') {
    const zone = typeof t.timezone === 'string' && t.timezone ? `（${t.timezone}）` : '';
    const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(t.expression.trim());
    if (!match) return `按计划 ${t.expression}${zone}`;
    const clock = `${match[2]!.padStart(2, '0')}:${match[1]!.padStart(2, '0')}`;
    const days = match[3] === '*' ? '每天' : '每' + [...new Set(match[3]!.split(',').map(Number))].sort().map(day => weekdays[day]).join('、');
    return `${days} ${clock}${zone}`;
  }
  return '按设定的时间';
}

/**
 * What a request to change a timer would change, for the line under its title: the values only
 * ("「喝水」改为「喝温水」"), since the parameter names are the engine's. Values that are not plain
 * words or numbers are left out; an empty string when nothing can be said.
 */
export function changeWords(before: unknown, after: unknown): string {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const plain = (value: unknown): string | undefined => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 60) || undefined
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
  const was = record(before), next = record(after), said: string[] = [];
  for (const key of Object.keys(next)) {
    if (JSON.stringify(next[key]) === JSON.stringify(was[key])) continue;
    const to = plain(next[key]), from = plain(was[key]);
    if (to !== undefined) said.push(from !== undefined ? `「${from}」改为「${to}」` : `改为「${to}」`);
  }
  return said.slice(0, 3).join('；');
}

