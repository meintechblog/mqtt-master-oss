import { EventEmitter } from 'node:events';

/**
 * Maps known $SYS topic paths to flat metric key names.
 */
const TOPIC_MAP = {
  '$SYS/broker/clients/connected': 'clients_connected',
  '$SYS/broker/messages/received': 'messages_received',
  '$SYS/broker/messages/sent': 'messages_sent',
  '$SYS/broker/load/publish/received/1min': 'publish_received_1min',
  '$SYS/broker/load/publish/sent/1min': 'publish_sent_1min',
  '$SYS/broker/subscriptions/count': 'subscriptions_count',
  '$SYS/broker/heap/current': 'heap_current',
  '$SYS/broker/heap/maximum': 'heap_maximum',
  '$SYS/broker/load/messages/received/1min': 'load_received_1min',
  '$SYS/broker/load/messages/received/5min': 'load_received_5min',
  '$SYS/broker/load/messages/received/15min': 'load_received_15min',
  '$SYS/broker/load/messages/sent/1min': 'load_sent_1min',
  '$SYS/broker/version': 'version',
  '$SYS/broker/uptime': 'uptime',
};

/**
 * Parse a $SYS topic value. Numeric strings become numbers.
 * Special case: uptime strings like "86400 seconds" are parsed to the numeric part.
 * Non-numeric strings (e.g., version) are kept as-is.
 */
function parseValue(key, raw) {
  if (key === 'uptime') {
    const match = raw.match(/^(\d+)/);
    return match ? Number(match[1]) : raw;
  }
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}

/**
 * SysBrokerService subscribes to $SYS/# via MqttService, aggregates
 * metrics into a structured state object, and emits debounced updates.
 */
export class SysBrokerService extends EventEmitter {
  constructor(mqttService) {
    super();
    this._mqttService = mqttService;
    this._data = {};
    this._topics = {};
    this._debounceTimer = null;

    // Subscribe to $SYS topics
    mqttService.subscribe('$SYS/#');

    // Listen for messages
    mqttService.on('message', (msg) => this._handleMessage(msg));

    // Forward connection status
    mqttService.on('connected', () => {
      this.emit('connection_status', { connected: true });
    });
    mqttService.on('disconnected', () => {
      this.emit('connection_status', { connected: false });
    });
  }

  _handleMessage({ topic, payload }) {
    if (!topic.startsWith('$SYS/')) return;

    // Update flat data via TOPIC_MAP
    const key = TOPIC_MAP[topic];
    if (key) {
      this._data[key] = parseValue(key, payload);
    }

    // Update hierarchical topics tree
    const parts = topic.split('/');
    let node = this._topics;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') {
        node[parts[i]] = {};
      }
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = payload;

    // Debounce update emission (500ms)
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this.emit('update', this.getState());
    }, 500);
  }

  getState() {
    return {
      data: { ...this._data },
      topics: structuredClone(this._topics),
    };
  }

  isConnected() {
    return this._mqttService.isConnected();
  }
}
