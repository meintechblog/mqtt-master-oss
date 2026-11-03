import { signal } from '@preact/signals';
import { createWsClient } from './ws-factory.js';

/** Reactive list of received messages (newest first, max 500) */
export const messages = signal([]);

/** Set of currently active subscription topic patterns */
export const subscriptions = signal(new Set());

/** Whether the messages WebSocket is connected */
export const messagesWsConnected = signal(false);

/** Messages per second, updated every 1000ms */
export const messageRate = signal(0);

const MAX_MESSAGES = 500;

// Rate counter: increment on each message, read and reset every second
let rateCount = 0;
let rateInterval = null;

const client = createWsClient({
  path: '/ws/messages',
  onMessage(msg) {
    switch (msg.type) {
      case 'message': {
        rateCount++;
        const current = messages.value;
        const next = [msg, ...current];
        messages.value = next.length > MAX_MESSAGES ? next.slice(0, MAX_MESSAGES) : next;
        break;
      }
      case 'subscribed': {
        const next = new Set(subscriptions.value);
        next.add(msg.topic);
        subscriptions.value = next;
        break;
      }
      case 'unsubscribed': {
        const next = new Set(subscriptions.value);
        next.delete(msg.topic);
        subscriptions.value = next;
        break;
      }
      case 'error':
        console.warn('[ws-messages]', msg.message);
        break;
    }
  },
});

// Sync connected signal
client.connected.subscribe((val) => {
  messagesWsConnected.value = val;
});

/**
 * Reference-counted connect/disconnect — multiple pages (Live Messages,
 * UniFi Ports / WAN / Clients, future dashboards) all need the same WS
 * session. Previously only /messages connected and /messages disconnect
 * on unmount tore the socket down for every other consumer, so navigating
 * away from /messages to any UniFi tab left those tabs starved of MQTT
 * data and stuck on their "waiting for poll" empty state.
 *
 * Now each call to connectMessagesWs() increments a refcount; only the
 * LAST disconnect actually closes the socket. The rate-counter interval
 * still tracks message throughput for the Live Messages page.
 */
let _connectRefs = 0;

export function connectMessagesWs() {
  _connectRefs += 1;
  client.connect();
  if (!rateInterval) {
    rateInterval = setInterval(() => {
      messageRate.value = rateCount;
      rateCount = 0;
    }, 1000);
  }
}

export function disconnectMessagesWs() {
  _connectRefs = Math.max(0, _connectRefs - 1);
  if (_connectRefs > 0) return; // someone else still needs the socket

  // Last consumer — tear down for real.
  if (rateInterval) {
    clearInterval(rateInterval);
    rateInterval = null;
  }
  messageRate.value = 0;
  rateCount = 0;

  // Unsubscribe all active topics before closing
  for (const topic of subscriptions.value) {
    client.send({ action: 'unsubscribe', topic });
  }

  client.disconnect();
  subscriptions.value = new Set();
}

export function subscribeTopic(topic) {
  client.send({ action: 'subscribe', topic });
}

export function unsubscribeTopic(topic) {
  client.send({ action: 'unsubscribe', topic });
}

export function clearMessages() {
  messages.value = [];
}
