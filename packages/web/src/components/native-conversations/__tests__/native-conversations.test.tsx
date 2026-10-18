import type { NativeConversationCatalog } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeConversationDirectory } from '../NativeConversationDirectory';
import { NativeConversationRail } from '../NativeConversationRail';
import { NativeConversationsProvider } from '../NativeConversationsProvider';

const apiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/hooks/useCatData', () => ({ refreshCatsNow: async () => ({ cats: [], fromApi: true }) }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  bootstrapSidebarThreadSnapshot: async () => true,
  refreshSidebarThreadSnapshot: async () => true,
  invalidateSidebarProjection: async () => true,
}));
vi.mock('../../ThreadSidebar/DirectoryBrowser', () => ({
  DirectoryBrowser: ({ onSelectCurrent }: { onSelectCurrent: (path: string) => void }) => (
    <button type="button" onClick={() => onSelectCurrent('/work/selected')}>
      选择此目录
    </button>
  ),
}));

const catalog: NativeConversationCatalog = {
  schemaVersion: 1,
  storageDurable: true,
  executionTemplates: [{ id: 'codex-local', name: '本地工作配置', clientId: 'codex', model: 'configured-model' }],
  contributions: [
    {
      pluginId: 'example-team',
      pluginInstanceId: 'installed-1',
      label: '设计伙伴',
      description: '一起完成日常工作',
      entities: [
        {
          key: 'pine',
          name: '松果',
          description: '研究与整理',
          initials: '松',
          accent: 'sage',
          composerPlaceholder: '交给松果处理…',
          availability: 'unconfigured',
        },
      ],
    },
  ],
};
const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });

describe('native contribution directory', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, '', '/');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    apiFetch.mockReset();
    apiFetch.mockImplementation((path: string) =>
      path.endsWith('/open')
        ? ok({ threadId: 'native-pine', catId: 'native-pine-cat', workspacePath: '/work/selected' })
        : ok(catalog),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render(threadId = 'default') {
    await act(async () =>
      root.render(
        <NativeConversationsProvider routeThreadId={threadId}>
          <NativeConversationRail />
          <NativeConversationDirectory onClose={() => {}} />
          <div data-testid="original-chat">原生聊天</div>
        </NativeConversationsProvider>,
      ),
    );
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === label || node.getAttribute('aria-label') === label,
    );
    expect(button, `button ${label}`).toBeTruthy();
    await act(async () => button?.click());
  }

  it('uses plugin labels, requires an explicit template and directory, then opens the canonical thread', async () => {
    await render();
    await click('设计伙伴');
    await click('松果');
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain('本地工作配置');
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'codex-local';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('选择工作目录');
    await click('选择此目录');
    await click('开始对话');
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/native-conversations/open',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          pluginId: 'example-team',
          entityKey: 'pine',
          executionTemplateId: 'codex-local',
          workspacePath: '/work/selected',
        }),
      }),
    );
    expect(window.location.pathname).toBe('/thread/native-pine');
    expect(container.querySelector('[data-testid="original-chat"]')?.textContent).toBe('原生聊天');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('restores the mode from a bound thread, and opens it without setup or an execution request', async () => {
    const bound = structuredClone(catalog);
    Object.assign(bound.contributions[0]!.entities[0]!, {
      availability: 'ready',
      binding: {
        threadId: 'native-pine',
        catId: 'native-pine-cat',
        workspacePath: '/work/selected',
        executionTemplateId: 'codex-local',
      },
    });
    apiFetch.mockImplementation((path: string) =>
      path.endsWith('/open')
        ? ok({ threadId: 'native-pine', catId: 'native-pine-cat', workspacePath: '/work/selected' })
        : ok(bound),
    );
    await render('native-pine');
    expect(container.textContent).toContain('研究与整理');
    await click('松果');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/native-conversations/open',
      expect.objectContaining({ body: JSON.stringify({ pluginId: 'example-team', entityKey: 'pine' }) }),
    );
    await click('返回任务列表');
    expect(container.querySelector('[aria-label="设计伙伴目录"]')).toBeNull();
    expect(
      apiFetch.mock.calls.every(([path]) => !String(path).includes('/messages') && !String(path).includes('/cancel')),
    ).toBe(true);
  });

  it('reports catalog failure and recovers through retry', async () => {
    apiFetch.mockRejectedValueOnce(new Error('连接断开'));
    await render();
    expect(container.textContent).toContain('连接断开');
    await click('重试加载原生目录');
    await click('设计伙伴');
    expect(container.textContent).toContain('松果');
  });

  it('retains a failed setup for correction and closes it with Escape without submitting again', async () => {
    apiFetch.mockImplementation((path: string) =>
      path.endsWith('/open')
        ? Promise.resolve({ ok: false, json: async () => ({ error: '所选目录不可用' }) })
        : ok(catalog),
    );
    await render();
    await click('设计伙伴');
    await click('松果');
    const confirm = [...container.querySelectorAll('button')].find((node) => node.textContent === '开始对话')!;
    expect(confirm.disabled).toBe(true);
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'codex-local';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('选择工作目录');
    await click('选择此目录');
    await click('开始对话');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('所选目录不可用');
    expect(window.location.pathname).toBe('/');
    await act(async () =>
      container
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith('/open'))).toHaveLength(1);
  });

  it('keeps disabled-plugin history accessible without creating a new binding', async () => {
    const unavailable = structuredClone(catalog);
    Object.assign(unavailable.contributions[0]!.entities[0]!, {
      availability: 'unavailable',
      reason: '插件已禁用',
      binding: {
        threadId: 'native-pine',
        catId: 'native-pine-cat',
        workspacePath: '/work/selected',
        executionTemplateId: 'codex-local',
      },
    });
    apiFetch.mockImplementation(() => ok(unavailable));
    await render('native-pine');
    expect(container.textContent).toContain('插件已禁用');
    await click('松果');
    expect(window.location.pathname).toBe('/thread/native-pine');
    expect(apiFetch.mock.calls.some(([path]) => path.endsWith('/open'))).toBe(false);
  });

  it('does not navigate back into the mode when an earlier open settles after the user leaves', async () => {
    const bound = structuredClone(catalog);
    Object.assign(bound.contributions[0]?.entities[0] ?? {}, {
      availability: 'ready',
      binding: {
        threadId: 'native-pine',
        catId: 'native-pine-cat',
        workspacePath: '/work/selected',
        executionTemplateId: 'codex-local',
      },
    });
    let settle: ((value: unknown) => void) | undefined;
    apiFetch.mockImplementation((path: string) =>
      path.endsWith('/open')
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : ok(bound),
    );
    await render();
    await click('设计伙伴');
    await click('松果');
    await click('返回任务列表');
    await act(async () => {
      settle?.({
        ok: true,
        json: async () => ({ threadId: 'native-pine', catId: 'native-pine-cat', workspacePath: '/work/selected' }),
      });
    });
    expect(window.location.pathname).toBe('/');
    expect(container.querySelector('[aria-label="设计伙伴目录"]')).toBeNull();
    expect(apiFetch.mock.calls.some(([path]) => String(path).includes('/cancel'))).toBe(false);
  });
});
