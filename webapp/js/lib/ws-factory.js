import { signal } from '@preact/signals';

const MAX_RECONNECT_DELAY = 30000;

/**
 * Create a managed WebSocket client with exponential backoff reconnection
 * and Preact signal-based state.
 *
 * @param {object} opts
 * @param {string} opts.path - WebSocket endpoint path (e.g. '/ws/dashboard')
 * @param {(msg: object) => void} opts.onMessage - handler for parsed JSON messages
 * @param {object} [opts.signals] - optional extra signals to expose
 * @returns {{ connected: Signal<boolean>, connect: () => void, disconnect: () => void, send: (data: any) => void }}
 */
export function createWsClient({ path, onMessage }) {
  const connected = signal(false);

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  /** Messages queued while the socket is CONNECTING (or before connect() has
   *  even been called). Flushed in WS order once `onopen` fires. Without this
   *  buffer, every page that calls send() right after connect() — which is
   *  every page in this app — lost its very first subscribe to the
   *  send-while-not-open race. */
  const sendQueue = [];

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${path}`;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    ws = new WebSocket(getWsUrl());

    ws.onopen = () => {
      connected.value = true;
      reconnectDelay = 1000;
      // Flush anything that was sent during CONNECTING.
      while (sendQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(sendQueue.shift());
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        onMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      connected.value = false;
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (ws) ws.close();
    };
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelay = 1000;
    // Drop anything that was queued — we're intentionally tearing down.
    sendQueue.length = 0;
    if (ws) {
      ws.onclose = null; // prevent reconnect on intentional close
      ws.close();
      ws = null;
      connected.value = false;
    }
  }

  function send(data) {
    const frame = typeof data === 'string' ? data : JSON.stringify(data);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
      return;
    }
    // CONNECTING (or null) — queue and flush on open. After the queue is
    // capped at a sane upper bound so a bug that floods send() during a
    // long disconnect can't OOM the tab.
    if (sendQueue.length < 500) sendQueue.push(frame);
  }

  return { connected, connect, disconnect, send };
}
