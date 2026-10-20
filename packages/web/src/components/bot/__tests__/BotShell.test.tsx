import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { BotShell } from '../BotShell';

const state = vi.hoisted(() => ({ context: null as unknown, hydrate: vi.fn() }));
vi.mock('@/hooks/useActiveExecutionProjection', () => ({
  useActiveExecutionProjection: (...args: unknown[]) => state.hydrate(...args),
}));
vi.mock('../../native-conversations/NativeConversationsProvider', () => ({
  useNativeConversations: () => state.context,
}));
vi.mock('../../native-conversations/NativeConversationDirectory', () => ({
  NativeConversationDirectory: () => <aside>同事目录</aside>,
}));
vi.mock('@/stores/callbackAuthStore', () => ({ CallbackAuthSnapshotMount: () => null }));
vi.mock('../../thread-chat', () => ({
  useThreadChatRuntime: () => ({ socketConnected: true }),
  ThreadChatRuntimeProvider: ({ children }: { children: ReactNode }) => children,
  ThreadChatSurface: ({ threadId }: { threadId: string }) => <div data-thread={threadId}>原生聊天</div>,
}));
const entities = ['a', 'b'].map((key) => ({
  key,
  name: key,
  description: '工作伙伴',
  binding: { threadId: `native-${key}`, workspacePath: `/work/${key}` },
}));
let root: Root;
let container: HTMLDivElement;
let openHistory: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useChatStore.setState({ currentThreadId: 'default', messages: [], threadStates: {} });
  openHistory = vi.fn();
  const contribution = { pluginId: 'test-plugin', entities };
  state.context = {
    catalog: { contributions: [contribution] },
    activeContribution: contribution,
    openHistory,
    selectContribution: vi.fn(),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});
it('activates the canonical foreground store on first mount and when switching colleagues', async () => {
  await act(async () => root.render(<BotShell threadId="native-a" />));
  expect(useChatStore.getState().currentThreadId).toBe('native-a');
  await act(async () => root.render(<BotShell threadId="native-b" />));
  expect(useChatStore.getState().currentThreadId).toBe('native-b');
  expect(state.hydrate).toHaveBeenCalledWith('native-a', true);
  expect(state.hydrate).toHaveBeenCalledWith('native-b', true);
  expect(container.querySelectorAll('[data-thread]')).toHaveLength(1);
  expect(container.querySelector('[data-thread]')?.getAttribute('data-thread')).toBe('native-b');
});
it('restores only a remembered binding present in the current plugin catalog', async () => {
  localStorage.setItem('clowder-bot:last-conversation', 'native-b');
  await act(async () => root.render(<BotShell threadId={null} />));
  expect(openHistory).toHaveBeenCalledExactlyOnceWith(entities[1]);
});
it('ignores an obsolete or unrelated remembered thread', async () => {
  localStorage.setItem('clowder-bot:last-conversation', 'unrelated-original-thread');
  await act(async () => root.render(<BotShell threadId={null} />));
  expect(openHistory).toHaveBeenCalledExactlyOnceWith(entities[0]);
});
