type WsEventListener<T = unknown> = (data: T) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<WsEventListener<unknown>>> = new Map();
  private reconnectTimer: number | null = null;
  private isExplicitClose = false;
  public status: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private statusListeners: Set<(status: 'connecting' | 'connected' | 'disconnected') => void> = new Set();

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isExplicitClose = false;
    this.setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.setStatus('connected');
        if (this.reconnectTimer) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload?.type) {
            const handlers = this.listeners.get(payload.type);
            handlers?.forEach((fn) => fn(payload));
          }
          // Also fan-out to wildcard listener
          const allHandlers = this.listeners.get('*');
          allHandlers?.forEach((fn) => fn(payload));
        } catch {
          // ignore malformed payloads
        }
      };

      this.ws.onclose = () => {
        this.setStatus('disconnected');
        this.ws = null;
        if (!this.isExplicitClose) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
      };
    } catch {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  private setStatus(s: 'connecting' | 'connected' | 'disconnected') {
    this.status = s;
    this.statusListeners.forEach((fn) => fn(s));
  }

  onStatus(fn: (status: 'connecting' | 'connected' | 'disconnected') => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  on<T = unknown>(type: string, fn: WsEventListener<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(fn as WsEventListener<unknown>);
    return () => {
      this.listeners.get(type)?.delete(fn as WsEventListener<unknown>);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2500);
  }

  disconnect() {
    this.isExplicitClose = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setStatus('disconnected');
  }
}

export const wsClient = new WsClient();
