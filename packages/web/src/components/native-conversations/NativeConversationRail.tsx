'use client';

import { ShellGlyph } from '../shell/ShellIcons';
import { useNativeConversations } from './NativeConversationsProvider';

export function NativeConversationRail() {
  const context = useNativeConversations();
  if (!context) return null;
  return (
    <>
      {context.loading && !context.catalog && !context.error && (
        <output className="p-2 text-xs text-[var(--cafe-text-muted)]" aria-label="正在加载原生目录">
          …
        </output>
      )}
      {context.catalog?.contributions.map((contribution) => (
        <button
          key={contribution.pluginId}
          type="button"
          title={contribution.label}
          aria-label={contribution.label}
          aria-current={context.activeContribution?.pluginId === contribution.pluginId ? 'page' : undefined}
          onClick={() => context.selectContribution(contribution.pluginId)}
          className="flex h-10 w-10 flex-none items-center justify-center rounded-lg text-[var(--cafe-text)] hover:bg-[var(--console-rail-item)]"
          style={
            context.activeContribution?.pluginId === contribution.pluginId
              ? { background: 'var(--console-rail-active)' }
              : undefined
          }
        >
          <ShellGlyph name="users" className="h-5 w-5" />
        </button>
      ))}
      {context.error && !context.catalog && (
        <button
          type="button"
          aria-label="重试加载原生目录"
          title={context.error}
          onClick={() => void context.refresh()}
          className="h-10 w-10 rounded-lg text-[var(--cafe-text-muted)]"
        >
          !<span className="sr-only">{context.error}</span>
        </button>
      )}
    </>
  );
}
