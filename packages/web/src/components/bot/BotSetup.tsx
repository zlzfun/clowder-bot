'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { refreshCatsNow } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { useNativeConversations } from '../native-conversations/NativeConversationsProvider';

const PluginManager = dynamic(
  () => import('../settings/plugin-manager/PluginManagerLiveContent').then((module) => module.PluginManagerLiveContent),
  { loading: () => <p>正在打开插件…</p> },
);

/** A small setup adapter over the existing member and plugin APIs; no colleague definitions live here. */
export function BotSetup({ onClose }: { onClose: () => void }) {
  const context = useNativeConversations();
  const [plugins, setPlugins] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = Boolean(context?.catalog?.executionTemplates.length);
  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/cats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          catId: 'bot-local-codex',
          name: '本机 Codex',
          displayName: '本机 Codex',
          clientId: 'openai',
          accountRef: 'codex',
          defaultModel: '',
          color: { primary: '#527B67', secondary: '#E3ECE6' },
          mentionPatterns: ['@bot-local-codex'],
          roleDescription: '在用户授权的工作目录内完成任务，真实执行并核验文件。',
          mcpSupport: true,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `连接失败 (${response.status})`);
      }
      await refreshCatsNow();
      await context?.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bot-setup">
      <header>
        <h1>连接与插件</h1>
        <button type="button" onClick={onClose}>
          返回聊天
        </button>
      </header>
      <section>
        <h2>本地 Agent</h2>
        <p>{connected ? '本地配置已就绪。' : '连接本机已安装的 Codex，沿用它的登录和默认模型。'}</p>
        {!connected && (
          <button type="button" disabled={busy} onClick={() => void connect()}>
            {busy ? '正在连接…' : '连接本机 Codex'}
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
      <section>
        <h2>同事插件</h2>
        <p>安装插件，让同事加入这里。插件权限由原有管理器处理。</p>
        <button type="button" aria-expanded={plugins} onClick={() => setPlugins(!plugins)}>
          {plugins ? '收起插件管理' : '管理插件'}
        </button>
      </section>
      {plugins && <PluginManager />}
    </div>
  );
}
