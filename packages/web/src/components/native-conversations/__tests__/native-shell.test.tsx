import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarStore } from '@/stores/sidebarStore';
import { AppShell } from '../../AppShell';
import { writeShellPresentation } from '../../shell/shell-presentation';

const state = vi.hoisted(() => ({ desktop: true, runtimeMounts: 0, chatMounts: 0 }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => state.desktop }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: () => {} }));
vi.mock('@/hooks/useApprovalHub', () => ({ useApprovalHubSync: () => {} }));
vi.mock('@/hooks/usePinnedSections', () => ({ usePinnedSections: () => ({ pinned: [] }) }));
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: () => {}, destroyPlaybackRuntime: () => {} }));
vi.mock('@/stores/callbackAuthStore', () => ({ CallbackAuthSnapshotMount: () => null }));
vi.mock('../../ThreadSidebar', () => ({ ThreadSidebar: () => <aside aria-label="任务目录" /> }));
vi.mock('../../thread-chat', () => ({
  ThreadChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => {
    useEffect(() => {
      state.runtimeMounts++;
    }, []);
    return <div data-testid="native-runtime">{children}</div>;
  },
}));
vi.mock('../../concierge/ConciergeHost', () => ({ ConciergeHost: () => null }));
vi.mock('../../concierge/HomeActionHost', () => ({ HomeActionHost: () => null }));
vi.mock('../../concierge/ConciergeRailToggle', () => ({ ConciergeRailToggle: () => null }));
vi.mock('../../attention/AttentionRailButtons', () => ({ AttentionRailButtons: () => null }));
vi.mock('../../DesktopUpdatePrompt', () => ({ DesktopUpdatePrompt: () => null }));
vi.mock('../../ThemeMenu', () => ({ ThemeMenu: () => null }));
vi.mock('../../listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('../../story-player/TheaterReplayHost', () => ({ TheaterReplayHost: () => null }));
vi.mock('../../workspace/FloatingPresentationSurfaceHost', () => ({ FloatingPresentationSurfaceHost: () => null }));
vi.mock('../../shell/use-presentation-rail', () => ({ usePresentationRail: () => ({ visible: false }) }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  bootstrapSidebarThreadSnapshot: async () => true,
  refreshSidebarThreadSnapshot: async () => true,
  invalidateSidebarProjection: async () => true,
}));
vi.mock('@/utils/api-client', () => ({
  apiFetch: async () => ({
    ok: true,
    json: async () => ({
      schemaVersion: 1,
      executionTemplates: [],
      storageDurable: true,
      contributions: [
        {
          pluginId: 'team',
          pluginInstanceId: 'instance',
          label: '工作伙伴',
          description: '插件提供的目录',
          entities: [
            {
              key: 'pine',
              name: '松果',
              description: '研究',
              initials: '松',
              accent: 'sage',
              availability: 'ready',
              composerPlaceholder: '交给松果…',
              binding: { threadId: 'bound', catId: 'pine-id', executionTemplateId: 'local', workspacePath: '/work' },
            },
          ],
        },
      ],
    }),
  }),
}));

function OriginalChat() {
  useEffect(() => {
    state.chatMounts++;
  }, []);
  return <div data-testid="original-chat">既有 ChatContainer</div>;
}

describe('native contribution in AppShell', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.desktop = true;
    state.runtimeMounts = 0;
    state.chatMounts = 0;
    writeShellPresentation('classic');
    useSidebarStore.setState({ isOpen: true, initialized: true });
    window.history.replaceState({}, '', '/thread/bound');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function mount() {
    await act(async () =>
      root.render(
        <AppShell>
          <OriginalChat />
        </AppShell>,
      ),
    );
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === label || node.getAttribute('aria-label') === label,
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
  }
  it('restores exactly one directory from a bound URL and preserves the runtime and chat when leaving/re-entering', async () => {
    await mount();
    expect(container.querySelectorAll('[aria-label="工作伙伴目录"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="任务目录"]')).toBeNull();
    const chat = container.querySelector('[data-testid="original-chat"]');
    const runtime = container.querySelector('[data-testid="native-runtime"]');
    await click('返回任务列表');
    expect(container.querySelectorAll('[aria-label="任务目录"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="工作伙伴目录"]')).toBeNull();
    await click('工作伙伴');
    expect(container.querySelectorAll('[aria-label="工作伙伴目录"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="original-chat"]')).toBe(chat);
    expect(container.querySelector('[data-testid="native-runtime"]')).toBe(runtime);
    expect(state.chatMounts).toBe(1);
    expect(state.runtimeMounts).toBe(1);
  });
  it('shows only the native drawer on a narrow viewport, with close and reopen controls', async () => {
    state.desktop = false;
    await mount();
    expect(container.querySelectorAll('[aria-label="工作伙伴目录"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="任务目录"]')).toBeNull();
    await click('收起目录');
    expect(container.querySelector('[aria-label="工作伙伴目录"]')).toBeNull();
    await click('工作伙伴');
    expect(container.querySelectorAll('[aria-label="工作伙伴目录"]')).toHaveLength(1);
  });
});
