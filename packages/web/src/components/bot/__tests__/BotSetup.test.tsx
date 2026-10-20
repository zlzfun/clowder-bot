import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BotSetup } from '../BotSetup';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), refresh: vi.fn(), refreshCats: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useCatData', () => ({ refreshCatsNow: mocks.refreshCats }));
vi.mock('../../native-conversations/NativeConversationsProvider', () => ({
  useNativeConversations: () => ({ catalog: { executionTemplates: [] }, refresh: mocks.refresh }),
}));
it('connects the local CLI through the existing OpenAI member contract and refreshes the catalog', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.apiFetch.mockResolvedValue({ ok: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<BotSetup onClose={() => {}} />));
    const button = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === '连接本机 Codex',
    );
    await act(async () => button?.click());
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [path, request] = mocks.apiFetch.mock.calls[0];
    expect(path).toBe('/api/cats');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toMatchObject({
      clientId: 'openai',
      accountRef: 'codex',
      defaultModel: '',
      mcpSupport: true,
    });
    expect(mocks.refreshCats).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
