'use client';

import type { NativeConversationCatalog, NativeConversationEntityView } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { DirectoryBrowser } from '../ThreadSidebar/DirectoryBrowser';

export function NativeConversationSetup({
  entity,
  simple = false,
  templates,
  busy,
  error,
  onCancel,
  onConfigure,
  onConfirm,
}: {
  entity: NativeConversationEntityView;
  simple?: boolean;
  templates: NativeConversationCatalog['executionTemplates'];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfigure?: () => void;
  onConfirm: (executionTemplateId: string, workspacePath: string) => void;
}) {
  const [template, setTemplate] = useState(simple && templates.length === 1 ? templates[0].id : '');
  const [workspace, setWorkspace] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      role="presentation"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="native-setup-title"
        tabIndex={-1}
        className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl border border-[var(--cafe-border)] bg-[var(--cafe-surface)] text-[var(--cafe-text)] shadow-xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            onCancel();
          }
          if (event.key !== 'Tab') return;
          const nodes = panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, select, [tabindex="0"]',
          );
          const first = nodes?.[0];
          const last = nodes?.[nodes.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="border-b border-[var(--cafe-border)] p-5">
          <h2 id="native-setup-title" className="text-lg font-semibold">
            与{entity.name}开始对话
          </h2>
          <p className="mt-1 text-sm text-[var(--cafe-text-muted)]">{entity.description}</p>
        </div>
        <div className="space-y-5 overflow-y-auto p-5">
          {(!simple || templates.length > 1) && (
            <label className="block text-sm">
              本地 Agent 配置
              <select
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                disabled={busy}
                className="mt-2 w-full rounded-lg border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2"
              >
                <option value="">选择已有配置</option>
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.model}
                  </option>
                ))}
              </select>
            </label>
          )}
          {templates.length === 0 && (
            <output className="block text-sm text-[var(--cafe-text-muted)]">
              还没有连接本地 Agent。
              {onConfigure ? (
                <button type="button" onClick={onConfigure} className="ml-2 underline">
                  连接本地 Agent
                </button>
              ) : (
                '请先在设置中配置。'
              )}
            </output>
          )}
          <div>
            <p className="text-sm">工作目录</p>
            {workspace && (
              <p className="mt-2 break-all text-sm" title={workspace}>
                {workspace}
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => setBrowsing(true)}
              className="mt-2 rounded-lg border border-[var(--cafe-border)] px-3 py-2 text-sm hover:bg-[var(--console-hover-bg)]"
            >
              选择工作目录
            </button>
          </div>
          {browsing && (
            <DirectoryBrowser
              initialPath={workspace || undefined}
              onCancel={() => setBrowsing(false)}
              onSelectCurrent={(path) => {
                setWorkspace(path);
                setBrowsing(false);
              }}
            />
          )}
          <p className="text-xs text-[var(--cafe-text-muted)]">你发送的任务将使用此配置，在所选目录中执行。</p>
          {error && (
            <p role="alert" className="break-words text-sm">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--cafe-border)] p-4">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm hover:bg-[var(--console-hover-bg)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || !template || !workspace}
            onClick={() => onConfirm(template, workspace)}
            className="rounded-lg bg-[var(--cafe-accent)] px-4 py-2 text-sm text-[var(--cafe-accent-foreground)] disabled:opacity-40"
          >
            {busy ? '正在打开…' : '开始对话'}
          </button>
        </div>
      </div>
    </div>
  );
}
