'use client';

import type { NativeConversationEntityView } from '@cat-cafe/shared';
import { useNativeConversation } from './NativeConversationsProvider';
import { useNativeConversationStatus } from './useNativeConversationStatus';

/** Bounded identity chrome; no transcript or execution state is stored here. */
export function NativeConversationIdentity({ threadId }: { threadId: string }) {
  const entity = useNativeConversation(threadId);
  if (!entity) return null;
  return <Identity entity={entity} />;
}

function Identity({ entity }: { entity: NativeConversationEntityView }) {
  const { status } = useNativeConversationStatus(entity);
  return (
    <div className="min-w-0" title={entity.binding?.workspacePath}>
      <div className="flex items-center gap-2">
        <span className="truncate font-semibold text-[var(--cafe-text)]">{entity.name}</span>
        <span className="shrink-0 text-xs text-[var(--cafe-text-muted)]">{status}</span>
      </div>
      <div className="truncate text-xs text-[var(--cafe-text-muted)]">
        {entity.availability === 'unavailable' ? (entity.reason ?? '暂不可用，可查看历史') : entity.description}
      </div>
    </div>
  );
}
