import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import { ApiError } from '../errors.js';
import type { NativeEvent, NativeTransport } from './types.js';

export class NativeClient implements NativeTransport {
  private cookie = '';
  private csrf = '';
  private session?: Promise<void>;
  private socket?: Socket;
  private connecting?: Promise<void>;
  private closed = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private listeners = new EventEmitter();
  private rooms = new Map<string, number>();
  private cursors = new Map<string, { seq: number; epoch?: string }>();
  constructor(readonly baseUrl: string, private origin: string, private fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
      throw new Error('Native runtime must be the dedicated loopback HTTP instance.');
    }
    this.listeners.setMaxListeners(1000);
  }
  private async authenticate(): Promise<void> {
    if (this.session) return this.session;
    this.session = (async () => {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}/api/session`, {
          headers: this.cookie ? { Cookie: this.cookie } : {}, redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
      } catch { throw new ApiError(503, 'Clowder AI 运行时未连接，请运行 npm run runtime:start。'); }
      if (!response.ok) throw new ApiError(502, '无法建立 Clowder AI 会话');
      const session = await response.json() as { userId?: string; csrfToken?: string };
      if (!session.csrfToken || session.userId !== 'clowder-bot-owner') throw new ApiError(502, 'Clowder AI 实例身份不匹配，拒绝连接其他部署');
      const cookie = response.headers.getSetCookie().find(c => c.startsWith('clowder_bot_native_session='));
      if (cookie) this.cookie = cookie.split(';')[0]!;
      if (!this.cookie) throw new ApiError(502, 'Clowder AI 未签发会话 Cookie');
      this.csrf = session.csrfToken;
    })();
    try { await this.session; } finally { this.session = undefined; }
  }
  async request<T = Record<string, unknown>>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!path.startsWith('/api/') || /[\r\n\\]/.test(path) || new URL(path, this.baseUrl).origin !== this.baseUrl) throw new ApiError(400, 'Invalid native API path');
    // A session is revalidated before every operation, including after native restarts.
    // Failed mutations are never silently retried.
    await this.authenticate();
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + path, {
        method: options.method ?? 'GET',
        headers: { Cookie: this.cookie, Origin: this.origin, 'x-csrf-token': this.csrf,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new ApiError(503, 'Clowder AI 请求中断。发送结果可能已持久化，请刷新后确认。'); }
    const data = response.status === 204 ? {} : await response.json().catch(() => { throw new ApiError(502, 'Clowder AI 返回了无效的 JSON'); });
    if (!response.ok) throw new ApiError(response.status, data.error ?? `Clowder AI HTTP ${response.status}`, data);
    return data as T;
  }
  private async connect(): Promise<void> {
    if (this.socket?.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.authenticate();
      if (this.closed) throw new ApiError(503, 'Bridge is closed');
      this.socket?.removeAllListeners(); this.socket?.disconnect();
      const socket = this.socket = io(this.baseUrl, { autoConnect: false, reconnection: false,
        transports: ['websocket'], extraHeaders: { Cookie: this.cookie, Origin: this.origin } });
      socket.on('agent_message', (event: NativeEvent) => {
        if (!event.threadId || !this.rooms.has(event.threadId)) return;
        const cursor = this.cursors.get(event.threadId);
        if (event.seq !== undefined) {
          if (cursor && cursor.epoch === event.seqEpoch && event.seq <= cursor.seq) return;
          if (cursor && (cursor.epoch !== event.seqEpoch || event.seq !== cursor.seq + 1)) {
            this.listeners.emit(event.threadId, { type: 'resync', threadId: event.threadId });
          }
          this.cursors.set(event.threadId, { seq: event.seq, epoch: event.seqEpoch });
        }
        this.listeners.emit(event.threadId, event);
      });
      for (const name of ['queue_updated', 'thread_updated', 'approval_requested', 'approval_resolved', 'connector_message', 'message_updated', 'runtime_interaction_updated']) {
        socket.on(name, (event: NativeEvent) => {
          if (event.threadId) this.listeners.emit(event.threadId, { ...event, type: name });
          else for (const id of this.rooms.keys()) this.listeners.emit(id, { type: 'resync', threadId: id });
        });
      }
      socket.on('disconnect', () => {
        if (this.closed || !this.rooms.size) return;
        for (const id of this.rooms.keys()) this.listeners.emit(id, { type: 'disconnected', threadId: id });
        this.scheduleReconnect();
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { socket.disconnect(); reject(new ApiError(503, 'Clowder AI 实时连接超时')); }, 10_000);
        socket.once('connect', () => { clearTimeout(timeout); resolve(); });
        socket.once('connect_error', () => { clearTimeout(timeout); reject(new ApiError(503, 'Clowder AI 实时连接失败')); });
        socket.connect();
      });
      for (const id of this.rooms.keys()) {
        await this.join(id);
        this.listeners.emit(id, { type: 'resync', threadId: id });
      }
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private scheduleReconnect(): void {
    if (this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.connect().catch(() => { if (!this.closed && this.rooms.size) this.scheduleReconnect(); });
    }, 1500);
    this.reconnect.unref();
  }
  private async join(threadId: string): Promise<void> {
    const ack = await this.socket!.timeout(5000).emitWithAck('join_room', `thread:${threadId}`);
    if (!ack?.ok) throw new ApiError(502, 'Clowder AI 拒绝订阅该会话');
  }
  async subscribe(threadId: string, listener: (event: NativeEvent) => void): Promise<() => void> {
    const existing = this.rooms.has(threadId);
    this.rooms.set(threadId, (this.rooms.get(threadId) ?? 0) + 1);
    this.listeners.on(threadId, listener);
    const remove = () => {
      this.listeners.off(threadId, listener);
      const count = (this.rooms.get(threadId) ?? 1) - 1;
      if (count) this.rooms.set(threadId, count);
      else { this.rooms.delete(threadId); this.cursors.delete(threadId); this.socket?.emit('leave_room', `thread:${threadId}`); }
    };
    try {
      const connected = this.socket?.connected;
      await this.connect();
      if (connected && !existing) await this.join(threadId);
      return remove;
    } catch (error) { remove(); throw error; }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.reconnect);
    this.socket?.disconnect(); this.socket?.removeAllListeners();
    this.listeners.removeAllListeners(); this.rooms.clear();
  }
}
