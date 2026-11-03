/**
 * WebSocket route for /ws/messages.
 * Per-client MQTT topic subscriptions with real-time message forwarding.
 */

/**
 * Match an MQTT topic against a subscription pattern.
 * Handles + (single level) and # (multi-level) wildcards.
 */
export function mqttTopicMatch(pattern, topic) {
  const patternParts = pattern.split('/');
  const topicParts = topic.split('/');

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '#') return true; // # matches everything from here
    if (i >= topicParts.length) return false; // pattern longer than topic
    if (p !== '+' && p !== topicParts[i]) return false; // literal mismatch
  }

  // Pattern consumed -- topic must also be fully consumed
  return patternParts.length === topicParts.length;
}

export default async function wsMessages(app) {
  /** Map<socket, Set<string>> -- per-client subscription tracking */
  const clients = new Map();

  function safeSend(socket, msg) {
    try {
      socket.send(msg);
    } catch {
      clients.delete(socket);
    }
  }

  // Listen for MQTT messages and forward to matching clients
  app.mqttService.on('message', (msg) => {
    const payload = JSON.stringify({
      type: 'message',
      topic: msg.topic,
      payload: msg.payload,
      timestamp: msg.timestamp,
    });

    for (const [socket, topics] of clients) {
      for (const pattern of topics) {
        if (mqttTopicMatch(pattern, msg.topic)) {
          safeSend(socket, payload);
          break; // send once per client even if multiple patterns match
        }
      }
    }
  });

  app.get('/ws/messages', { websocket: true }, (socket) => {
    clients.set(socket, new Set());

    socket.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // silently ignore invalid JSON
      }

      const { action, topic } = data;

      if (action === 'subscribe') {
        if (!topic || typeof topic !== 'string') {
          safeSend(socket, JSON.stringify({ type: 'error', message: 'Topic is required' }));
          return;
        }
        // Per-client filter only -- the broker subscription `#` is owned by
        // TopicCacheService, so every message already reaches us. Touching
        // broker subs here would tear it down for every other consumer.
        clients.get(socket)?.add(topic);
        safeSend(socket, JSON.stringify({ type: 'subscribed', topic }));

        // Replay every cached retained message that matches this pattern.
        // Without this, a fresh client (e.g. the Clients page on cold mount)
        // would sit on its empty state until the next 30s poll re-publishes
        // each retained payload. TopicCacheService keeps the latest value per
        // topic since server start; we replay matching entries newest-first
        // so the page's "process oldest→newest, most recent wins" walker
        // still resolves to the freshest values.
        const cache = app.topicCacheService;
        if (cache && typeof cache.list === 'function') {
          const snapshot = cache.list();
          for (const entry of snapshot) {
            if (mqttTopicMatch(topic, entry.topic)) {
              safeSend(socket, JSON.stringify({
                type: 'message',
                topic: entry.topic,
                payload: entry.payload,
                timestamp: entry.ts,
              }));
            }
          }
        }
        return;
      }

      if (action === 'unsubscribe') {
        if (!topic || typeof topic !== 'string') {
          safeSend(socket, JSON.stringify({ type: 'error', message: 'Topic is required' }));
          return;
        }
        clients.get(socket)?.delete(topic);
        safeSend(socket, JSON.stringify({ type: 'unsubscribed', topic }));
        return;
      }

      safeSend(socket, JSON.stringify({ type: 'error', message: 'Unknown action' }));
    });

    socket.on('close', () => {
      // Broker-side `#` subscription is owned by TopicCacheService; per-client
      // patterns are filter-only, so just drop the bookkeeping.
      clients.delete(socket);
    });
  });
}
