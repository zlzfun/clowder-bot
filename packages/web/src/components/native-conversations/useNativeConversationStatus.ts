import type { NativeConversationEntityView } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import { projectSidebarRows, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';

/** Read only projection of existing runtime and sidebar truth. */
export function useNativeConversationStatus(entity: NativeConversationEntityView) {
  const threadId = entity.binding?.threadId;
  const { rows, pendingThreadCommands } = useSidebarProjectionStore(
    useShallow((state) => ({ rows: state.rows, pendingThreadCommands: state.pendingThreadCommands })),
  );
  const row = useMemo(
    () => projectSidebarRows({ rows, pendingThreadCommands }).find((item) => item.id === threadId),
    [rows, pendingThreadCommands, threadId],
  );
  const liveness = useThreadLiveness(threadId ?? null);
  const queued = useChatStore((state) =>
    threadId === state.currentThreadId
      ? state.queue.length
      : threadId
        ? (state.threadStates[threadId]?.queue.length ?? 0)
        : 0,
  );
  let status = '可接收消息';
  if (row?.presence.status === 'error') status = '需要你处理';
  if (queued > 0) status = '排队中';
  if (entity.availability === 'unconfigured') status = '首次设置';
  if (entity.availability === 'unavailable') status = '暂不可用';
  if (liveness.hasActive || row?.presence.status === 'working') status = '正在执行';
  return { status, unreadCount: row?.unreadCount ?? 0 };
}
