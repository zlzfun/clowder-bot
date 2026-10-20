'use client';

import type { NativeConversationEntityView } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { bootstrapSidebarThreadSnapshot, refreshSidebarThreadSnapshot } from '@/utils/sidebar-thread-snapshot';
import { NativeConversationSetup } from './NativeConversationSetup';
import { useNativeConversations } from './NativeConversationsProvider';
import { useNativeConversationStatus } from './useNativeConversationStatus';

const avatarTokens = {
  sage: { background: 'var(--semantic-success-surface)', color: 'var(--semantic-success)' },
  amber: { background: 'var(--semantic-warning-surface)', color: 'var(--semantic-warning)' },
  blue: { background: 'var(--semantic-info-surface)', color: 'var(--semantic-info)' },
};

export function NativeConversationDirectory({
  onClose,
  appearance = 'workspace',
  onConfigure,
}: {
  onClose: () => void;
  appearance?: 'workspace' | 'messenger';
  onConfigure?: () => void;
}) {
  const messenger = appearance === 'messenger';
  const context = useNativeConversations();
  const isDesktop = useIsDesktop();
  const [setup, setSetup] = useState<NativeConversationEntityView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contribution = context?.activeContribution;
  const contributionId = contribution?.pluginId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different directory must not inherit the previous setup form.
  useEffect(() => {
    setSetup(null);
    setError(null);
  }, [contributionId]);
  useEffect(() => {
    if (!contributionId) return;
    void bootstrapSidebarThreadSnapshot();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSidebarThreadSnapshot();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [contributionId]);
  if (!context || !contribution) return null;

  async function open(entity: NativeConversationEntityView, executionTemplateId?: string, workspacePath?: string) {
    if (!context || !contribution || busy) return;
    if (entity.availability === 'unavailable') {
      context.openHistory(entity);
      if (!isDesktop) onClose();
      return;
    }
    if (!entity.binding && !executionTemplateId) {
      setError(null);
      setSetup(entity);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await context.openConversation({
        pluginId: contribution.pluginId,
        entityKey: entity.key,
        ...(executionTemplateId ? { executionTemplateId, workspacePath } : {}),
      });
      setSetup(null);
      if (!isDesktop) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开对话，请重试');
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside
      aria-label={`${contribution.label}目录`}
      className="flex h-full min-w-0 flex-col border-r border-[var(--cafe-border)] bg-[var(--cafe-surface)] text-[var(--cafe-text)]"
    >
      <div className="flex items-start gap-2 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-base font-semibold">{contribution.label}</h2>
          {!messenger && (
            <p className="mt-1 break-words text-xs text-[var(--cafe-text-muted)]">{contribution.description}</p>
          )}
        </div>
        {!messenger && (
          <button
            type="button"
            onClick={onClose}
            aria-label="收起目录"
            className="rounded-lg px-2 py-1 hover:bg-[var(--console-hover-bg)]"
          >
            ‹
          </button>
        )}
      </div>
      {context.error && (
        <div className="mx-3 mb-3 rounded-lg border border-[var(--cafe-border)] p-3 text-xs" role="alert">
          <p>{context.error}</p>
          <button type="button" onClick={() => void context.refresh()} className="mt-2 underline">
            重试加载原生目录
          </button>
        </div>
      )}
      {!context.catalog?.storageDurable && (
        <output className="mx-4 mb-3 text-xs text-[var(--cafe-text-muted)]">
          当前为内存存储，重启服务后无法保留对话。
        </output>
      )}
      <div className="flex-1 space-y-1 overflow-y-auto px-2" aria-busy={busy || context.loading}>
        {contribution.entities.length === 0 && (
          <p className="p-3 text-sm text-[var(--cafe-text-muted)]">此插件暂未提供对话对象。</p>
        )}
        {contribution.entities.map((entity) => (
          <DirectoryEntry
            key={entity.key}
            entity={entity}
            busy={busy}
            selected={entity.binding?.threadId === context.routeThreadId}
            onOpen={() => void open(entity)}
          />
        ))}
        {error && !setup && (
          <p role="alert" className="p-3 text-sm">
            {error}
          </p>
        )}
      </div>
      {!messenger && (
        <div className="border-t border-[var(--cafe-border)] p-3">
          <button
            type="button"
            onClick={context.leaveMode}
            className="w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--cafe-text-muted)] hover:bg-[var(--console-hover-bg)]"
          >
            返回任务列表
          </button>
        </div>
      )}
      {setup && (
        <NativeConversationSetup
          simple={messenger}
          onConfigure={
            onConfigure
              ? () => {
                  setSetup(null);
                  onConfigure();
                }
              : undefined
          }
          entity={setup}
          templates={context.catalog?.executionTemplates ?? []}
          busy={busy}
          error={error}
          onCancel={() => setSetup(null)}
          onConfirm={(template, path) => void open(setup, template, path)}
        />
      )}
    </aside>
  );
}

function DirectoryEntry({
  entity,
  selected,
  busy,
  onOpen,
}: {
  entity: NativeConversationEntityView;
  selected: boolean;
  busy: boolean;
  onOpen: () => void;
}) {
  const { status, unreadCount } = useNativeConversationStatus(entity);
  return (
    <button
      type="button"
      aria-label={entity.name}
      aria-current={selected ? 'page' : undefined}
      disabled={busy || (entity.availability === 'unavailable' && !entity.binding)}
      onClick={onOpen}
      title={entity.reason ?? entity.description}
      className="flex w-full items-start gap-3 rounded-xl p-3 text-left hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
      style={selected ? { background: 'var(--console-rail-active)' } : undefined}
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[var(--cafe-surface)] text-sm font-semibold"
        style={avatarTokens[entity.accent]}
      >
        {entity.initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{entity.name}</span>
          {unreadCount > 0 && (
            <span className="text-xs">
              {unreadCount}
              <span className="sr-only"> 条未读</span>
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-[var(--cafe-text-muted)]">{entity.description}</span>
        <span className="mt-2 block text-xs text-[var(--cafe-text-muted)]">{status}</span>
        {entity.reason && <span className="mt-1 block text-xs text-[var(--cafe-text-muted)]">{entity.reason}</span>}
      </span>
    </button>
  );
}
