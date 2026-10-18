'use client';

import type {
  NativeConversationCatalog,
  NativeConversationContributionView,
  NativeConversationEntityView,
  OpenNativeConversationRequest,
  OpenNativeConversationResponse,
} from '@cat-cafe/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { refreshCatsNow } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { pushThreadRouteWithHistory } from '../ThreadSidebar/thread-navigation';

interface NativeConversationsContextValue {
  catalog: NativeConversationCatalog | null;
  loading: boolean;
  error: string | null;
  activeContribution: NativeConversationContributionView | null;
  routeThreadId: string | null;
  selectContribution: (pluginId: string) => void;
  leaveMode: () => void;
  refresh: () => Promise<void>;
  openConversation: (request: OpenNativeConversationRequest) => Promise<void>;
  openHistory: (entity: NativeConversationEntityView) => void;
}

const NativeConversationsContext = createContext<NativeConversationsContextValue | null>(null);
export const useNativeConversations = () => useContext(NativeConversationsContext);

export function useNativeConversation(threadId: string) {
  const context = useNativeConversations();
  return context?.activeContribution?.entities.find((entity) => entity.binding?.threadId === threadId) ?? null;
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : '无法加载原生对话，请重试');
  return body as T;
}

function openThread(threadId: string) {
  // Use the same host attention projection as a click in ThreadSidebar.
  useSidebarProjectionStore
    .getState()
    .beginSidebarCommand(threadId, 'attention', { unreadCount: 0, hasUserMention: false });
  useChatStore.getState().clearUnread(threadId);
  pushThreadRouteWithHistory(threadId, window);
}

/** Directory metadata only. The existing chat runtime remains the sole socket/history/send owner. */
export function NativeConversationsProvider({
  children,
  routeThreadId,
}: {
  children: ReactNode;
  routeThreadId: string | null;
}) {
  const [catalog, setCatalog] = useState<NativeConversationCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ route: string | null; pluginId: string | null } | null>(null);
  const generation = useRef(0);
  const navigationGeneration = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: route changes invalidate pending view navigation.
  useEffect(() => {
    navigationGeneration.current++;
  }, [routeThreadId]);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = await readResponse<NativeConversationCatalog>(
        await apiFetch('/api/native-conversations', undefined, { afterCurrentGet: true }),
      );
      if (request !== generation.current) return;
      setCatalog(next);
      setError(null);
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : '无法加载原生目录');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    window.addEventListener('focus', onFocus);
    return () => {
      generation.current++;
      navigationGeneration.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const contributions = catalog?.contributions ?? [];
  const inferred = contributions.find((item) =>
    item.entities.some((entity) => entity.binding?.threadId === routeThreadId),
  );
  const pluginId = selection?.route === routeThreadId ? selection.pluginId : inferred?.pluginId;
  const activeContribution = contributions.find((item) => item.pluginId === pluginId) ?? null;
  const selectContribution = useCallback(
    (id: string) => {
      navigationGeneration.current++;
      setSelection({ route: routeThreadId, pluginId: id });
      useSidebarStore.getState().open();
    },
    [routeThreadId],
  );
  const leaveMode = useCallback(() => {
    navigationGeneration.current++;
    setSelection({ route: routeThreadId, pluginId: null });
  }, [routeThreadId]);
  const openHistory = useCallback((entity: NativeConversationEntityView) => {
    if (entity.binding) openThread(entity.binding.threadId);
  }, []);
  const openConversation = useCallback(
    async (request: OpenNativeConversationRequest) => {
      const navigation = ++navigationGeneration.current;
      const binding = await readResponse<OpenNativeConversationResponse>(
        await apiFetch('/api/native-conversations/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      );
      // Existing caches own member names and thread/unread state; never create plugin copies.
      await Promise.allSettled([refreshCatsNow(), invalidateSidebarProjection(), refresh()]);
      if (navigation !== navigationGeneration.current) return;
      setSelection({ route: binding.threadId, pluginId: request.pluginId });
      openThread(binding.threadId);
    },
    [refresh],
  );
  const value = useMemo(
    () => ({
      catalog,
      loading,
      error,
      activeContribution,
      routeThreadId,
      selectContribution,
      leaveMode,
      refresh,
      openConversation,
      openHistory,
    }),
    [
      catalog,
      loading,
      error,
      activeContribution,
      routeThreadId,
      selectContribution,
      leaveMode,
      refresh,
      openConversation,
      openHistory,
    ],
  );
  return <NativeConversationsContext.Provider value={value}>{children}</NativeConversationsContext.Provider>;
}
