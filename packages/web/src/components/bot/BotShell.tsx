'use client';

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { CallbackAuthSnapshotMount } from '@/stores/callbackAuthStore';
import { useChatStore } from '@/stores/chatStore';
import { NativeConversationDirectory } from '../native-conversations/NativeConversationDirectory';
import { useNativeConversations } from '../native-conversations/NativeConversationsProvider';
import { ThreadChatRuntimeProvider, ThreadChatSurface, useThreadChatRuntime } from '../thread-chat';
import { BotSetup } from './BotSetup';
import { ConversationAppearance } from './ConversationAppearance';

const LAST_CONVERSATION = 'clowder-bot:last-conversation';

function ForegroundConversation({ threadId, children }: { threadId: string; children: ReactNode }) {
  const { socketConnected } = useThreadChatRuntime([threadId]);
  useActiveExecutionProjection(threadId, socketConnected);
  useLayoutEffect(() => {
    useChatStore.getState().setCurrentThread(threadId);
  }, [threadId]);
  return children;
}

export function BotShell({ threadId }: { threadId: string | null }) {
  const context = useNativeConversations();
  const restored = useRef(false);
  const [settings, setSettings] = useState(false);
  const contributions = context?.catalog?.contributions;
  const active = context?.activeContribution;
  const entity = active?.entities.find((item) => item.binding?.threadId === threadId);

  useEffect(() => {
    document.documentElement.dataset.shell = 'v2';
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, []);
  useEffect(() => {
    if (!context || !contributions?.length) return;
    if (!active) context.selectContribution(contributions[0].pluginId);
    if (restored.current) return;
    restored.current = true;
    if (contributions.some((item) => item.entities.some((entry) => entry.binding?.threadId === threadId))) return;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(LAST_CONVERSATION);
    } catch {
      /* preferences are optional */
    }
    const entries = contributions.flatMap((item) => item.entities);
    const previous =
      entries.find((item) => item.binding?.threadId === remembered) ?? entries.find((item) => item.binding);
    if (previous) context.openHistory(previous);
  }, [context, contributions, active, threadId]);
  useEffect(() => {
    if (!entity?.binding) return;
    try {
      localStorage.setItem(LAST_CONVERSATION, entity.binding.threadId);
    } catch {
      /* history remains on the host */
    }
  }, [entity]);

  return (
    <ConversationAppearance.Provider value="messenger">
      <ThreadChatRuntimeProvider routeThreadId={entity?.binding?.threadId ?? null}>
        <div className="bot-shell">
          <CallbackAuthSnapshotMount />
          <div className="bot-sidebar">
            <div className="bot-brand">
              <span aria-hidden="true">c.</span> Clowder Bot
            </div>
            {active ? (
              <NativeConversationDirectory
                appearance="messenger"
                onClose={() => {}}
                onConfigure={() => setSettings(true)}
              />
            ) : (
              <div className="bot-directory-empty">
                <p>{context?.loading ? '正在连接…' : '还没有同事'}</p>
                <p>{context?.error ?? '安装同事插件后，他们会出现在这里。'}</p>
                <button type="button" onClick={() => void context?.refresh()}>
                  重新连接
                </button>
              </div>
            )}
            <button className="bot-settings-entry" type="button" onClick={() => setSettings(true)}>
              连接与插件
            </button>
          </div>
          <main className="bot-conversation" aria-label="同事聊天">
            {settings ? (
              <BotSetup
                onClose={() => {
                  setSettings(false);
                  void context?.refresh();
                }}
              />
            ) : entity?.binding ? (
              <ForegroundConversation threadId={entity.binding.threadId}>
                <header className="bot-chat-header">
                  <div>
                    <h1>{entity.name}</h1>
                    <p>{entity.description}</p>
                  </div>
                  <span title={entity.binding.workspacePath} className="bot-workspace">
                    {entity.binding.workspacePath.split('/').filter(Boolean).at(-1)}
                  </span>
                </header>
                <ThreadChatSurface
                  threadId={entity.binding.threadId}
                  density="full"
                  composerPlaceholder={`给${entity.name}发消息…`}
                  emptyState={
                    <div className="bot-welcome">
                      <h2>和{entity.name}开始工作</h2>
                      <p>说说你想完成什么。</p>
                    </div>
                  }
                />
              </ForegroundConversation>
            ) : (
              <div className="bot-welcome">
                <span className="bot-welcome-mark" aria-hidden="true">
                  c.
                </span>
                <h1>一起，把事情做好。</h1>
                <p>从左边选一位同事，开始聊天。</p>
              </div>
            )}
          </main>
        </div>
      </ThreadChatRuntimeProvider>
    </ConversationAppearance.Provider>
  );
}
