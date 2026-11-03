/**
 * MQTT Bridge plugin -- connects to an external MQTT broker and republishes
 * selected topics on the local broker with a configurable prefix.
 *
 * Designed for Venus OS (Victron Energy) but works with any external broker.
 * Handles Venus OS keepalive requirement automatically.
 */
import mqtt from 'mqtt';
import { BindingsManager } from '../lib/bindings-manager.js';

const RECONNECT_MS = 5000;

export default class MqttBridgePlugin {
  constructor() {
    this._client = null;
    this._running = false;
    this._connected = false;
    this._config = {};
    this._ctx = null;
    this._keepaliveInterval = null;
    this._topicCount = 0;
    this._messageCount = 0;
    this._lastMessage = null;
    /** @type {string|null} detected portal ID for Venus OS */
    this._portalId = null;
    /** @type {Map<string, { localTopic: string, value: any, ts: number }>} remote topic -> state */
    this._topicCache = new Map();

    /** @type {BindingsManager|null} */
    this._bindings = null;
  }

  async start(context) {
    this._ctx = context;
    const { configService, logger, pluginId } = context;
    this._pluginId = pluginId || 'mqtt-bridge';

    this._config = configService.get(`plugins.${this._pluginId}`, {});
    const {
      brokerUrl = '',
      subscribeTopic = '#',
      localPrefix = 'venus',
      keepaliveEnabled = true,
      keepaliveIntervalMs = 30000,
    } = this._config;

    if (!brokerUrl) {
      throw new Error('brokerUrl is required (e.g. mqtt://203.0.113.146:1883)');
    }

    // Auto-fix bare IP/hostname: add mqtt:// protocol and default port
    let url = brokerUrl.trim();
    if (!url.includes('://')) {
      url = `mqtt://${url}`;
    }
    if (!url.match(/:\d+$/) && !url.match(/:\d+\//)) {
      url = `${url}:1883`;
    }

    logger.info(`MQTT Bridge connecting to ${url}...`);

    this._client = mqtt.connect(url, {
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: 10000,
      clientId: 'mqtt-master-bridge-' + Date.now(),
    });

    this._client.on('connect', () => {
      this._connected = true;
      logger.info(`MQTT Bridge connected to ${url}`);

      // Subscribe to external broker topics
      this._client.subscribe(subscribeTopic, (err) => {
        if (err) {
          logger.error(`MQTT Bridge subscribe failed: ${err.message}`);
        } else {
          logger.info(`MQTT Bridge subscribed to: ${subscribeTopic}`);
        }
      });

      // Start keepalive for Venus OS
      if (keepaliveEnabled) {
        this._startKeepalive(keepaliveIntervalMs);
      }
    });

    this._client.on('close', () => {
      this._connected = false;
      this._stopKeepalive();
    });

    this._client.on('error', (err) => {
      logger.warn(`MQTT Bridge error: ${err.message}`);
    });

    // Republish received messages on local broker (with deduplication)
    const seenTopics = new Set();
    /** @type {Map<string, string>} topic -> last published payload (for dedup) */
    const lastPublished = new Map();
    /** @type {Map<string, number>} topic -> last publish timestamp (for keepalive) */
    const lastPublishTime = new Map();
    const DEDUP_KEEPALIVE_MS = 30000; // resend unchanged values every 30s

    this._client.on('message', (topic, payload) => {
      // Skip $SYS topics from external broker
      if (topic.startsWith('$SYS/')) return;

      const msg = payload.toString();

      // Track unique topics
      if (!seenTopics.has(topic)) {
        seenTopics.add(topic);
        this._topicCount = seenTopics.size;
      }
      this._messageCount++;
      this._lastMessage = Date.now();

      // Auto-detect Venus OS portal ID from topic pattern N/{portalId}/...
      if (!this._portalId && topic.startsWith('N/')) {
        const parts = topic.split('/');
        if (parts.length >= 3) {
          this._portalId = parts[1];
          logger.info(`Venus OS portal detected: ${this._portalId}`);
        }
      }

      // Build local topic: strip N/{portalId}/ prefix if present, add localPrefix
      let localTopic;
      if (this._portalId && topic.startsWith(`N/${this._portalId}/`)) {
        const stripped = topic.slice(`N/${this._portalId}/`.length);
        localTopic = `${localPrefix}/${stripped}`;
      } else {
        localTopic = `${localPrefix}/${topic}`;
      }

      // Cache value (always update cache for Elements view)
      let parsedValue = msg;
      try {
        const json = JSON.parse(msg);
        if (json && json.value !== undefined) parsedValue = json.value;
      } catch { /* not JSON */ }
      this._topicCache.set(topic, { localTopic, value: parsedValue, ts: Date.now() });
      // Evict oldest entries if cache grows too large
      if (this._topicCache.size > 5000) {
        const oldest = [...this._topicCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 1000);
        for (const [key] of oldest) this._topicCache.delete(key);
      }

      // Deduplicate: only republish if value changed or keepalive expired
      const now = Date.now();
      const lastMsg = lastPublished.get(topic);
      const lastTime = lastPublishTime.get(topic) || 0;
      const valueChanged = lastMsg !== msg;
      const keepaliveExpired = (now - lastTime) >= DEDUP_KEEPALIVE_MS;

      if (valueChanged || keepaliveExpired) {
        context.mqttService.publish(localTopic, msg);
        lastPublished.set(topic, msg);
        lastPublishTime.set(topic, now);
      }
    });

    // Set up input bindings (local MQTT topic → Loxone control via main MQTT).
    // The forwarder hops through any running loxone-type plugin instance —
    // not just one named "loxone". Multi-Miniserver setups work too: we
    // prefer the instance whose getControls() actually claims this UUID,
    // and fall back to any running loxone for virtual inputs that don't
    // appear in the structure dump.
    this._bindings = new BindingsManager({
      configKey: `plugins.${this._pluginId}`,
      sendToTarget: async (uuid, value) => {
        const pm = this._ctx?.pluginManager;
        if (!pm) throw new Error('plugin manager unavailable');
        const all = (typeof pm.listAll === 'function') ? await pm.listAll() : [];
        const candidates = all.filter(p => p.type === 'loxone' && p.status === 'running');
        if (candidates.length === 0) throw new Error('no running Loxone plugin to forward to');

        let chosen = null;
        for (const meta of candidates) {
          const inst = pm.getInstance?.(meta.id);
          if (inst && typeof inst.getControls === 'function') {
            try {
              const ctrls = inst.getControls() || [];
              const hit = ctrls.find(c => c.uuid === uuid)
                || ctrls.flatMap(c => c.subControls || []).find(s => s.uuid === uuid);
              if (hit) { chosen = inst; break; }
            } catch { /* ignore per-plugin errors */ }
          }
        }
        // Fallback: first running loxone instance
        if (!chosen) chosen = pm.getInstance?.(candidates[0].id);
        if (!chosen || typeof chosen.sendControlCommand !== 'function') {
          throw new Error('Loxone plugin has no sendControlCommand()');
        }
        chosen.sendControlCommand(uuid, value);
      },
    });
    this._bindings.init(context, this._config);

    this._running = true;
    logger.info('MQTT Bridge plugin started');
  }

  async stop() {
    if (!this._ctx) return;
    const { logger } = this._ctx;

    this._stopKeepalive();

    if (this._client) {
      this._client.end(true);
      this._client = null;
    }

    if (this._bindings) this._bindings.cleanup();

    this._running = false;
    this._connected = false;
    this._topicCount = 0;
    this._messageCount = 0;
    this._portalId = null;
    this._topicCache.clear();

    if (logger) logger.info('MQTT Bridge plugin stopped');
  }

  getStatus() {
    return {
      running: this._running,
      connected: this._connected,
      topicCount: this._topicCount,
      messageCount: this._messageCount,
      lastMessage: this._lastMessage,
      portalId: this._portalId,
    };
  }

  // --- Input bindings ---

  getInputBindings() {
    return this._bindings.getBindings();
  }

  getInputBindingStats() {
    const stats = this._bindings?.getStats?.() || [];
    // Bindings on this bridge target Loxone control UUIDs that live on a
    // sibling loxone-type plugin. Look up the live Loxone-side value for
    // each target so the UI can show "we sent" and "Loxone reports" from
    // the same instant — eliminates poll-cadence drift between cards.
    const pm = this._ctx?.pluginManager;
    if (!pm || !stats.length) return stats;
    const all = pm._plugins ? [...pm._plugins.values?.() || []] : null;
    // Use the public discovery surface — listAll is async so we can't await
    // here. Walk the synchronous plugins map via getInstance for each
    // candidate id we know about.
    const candidates = [];
    if (typeof pm.getInstance === 'function') {
      // Iterate the same set listAll() would: fall back to scanning the
      // plugin manager's internal map which is sync.
      for (const [id, meta] of (pm.plugins?.entries?.() || [])) {
        if (meta && meta.type === 'loxone' && meta.status === 'running') {
          const inst = pm.getInstance(id);
          if (inst) candidates.push(inst);
        }
      }
    }
    for (const stat of stats) {
      for (const inst of candidates) {
        const v = inst.peekControlValue?.(stat.targetUuid);
        if (v != null) { stat.loxoneValue = v; break; }
      }
    }
    return stats;
  }

  async setInputBindings(bindings) {
    await this._bindings.setBindings(bindings);
  }

  /**
   * Get all bridged topics with live values for the Elements view.
   * @returns {Array<{ remoteTopic: string, localTopic: string, value: any, ts: number }>}
   */
  getElements() {
    const elements = [];
    for (const [remoteTopic, state] of this._topicCache) {
      elements.push({
        remoteTopic,
        localTopic: state.localTopic,
        value: state.value,
        ts: state.ts,
      });
    }
    // Sort by local topic
    elements.sort((a, b) => a.localTopic.localeCompare(b.localTopic));
    return elements;
  }

  getConfigSchema() {
    return {
      type: 'object',
      properties: {
        displayName: {
          type: 'string',
          title: 'Display Name',
          description: 'Name shown in the sidebar (e.g. "Venus OS")',
        },
        brokerUrl: {
          type: 'string',
          title: 'External Broker URL',
          description: 'MQTT broker to bridge from (e.g. mqtt://203.0.113.146:1883)',
        },
        subscribeTopic: {
          type: 'string',
          title: 'Subscribe Topic',
          default: 'N/#',
          description: 'Topic pattern to subscribe on the external broker (N/# for Venus OS)',
        },
        localPrefix: {
          type: 'string',
          title: 'Local Prefix',
          default: 'venus',
          description: 'Prefix for republished topics on local broker',
        },
        keepaliveEnabled: {
          type: 'boolean',
          title: 'Send Keepalive',
          default: true,
          description: 'Send periodic keepalive (required for Venus OS)',
        },
        keepaliveIntervalMs: {
          type: 'integer',
          title: 'Keepalive Interval (ms)',
          default: 30000,
          description: 'How often to send keepalive to external broker',
        },
        autoStart: {
          type: 'boolean',
          title: 'Auto-start',
          default: false,
          description: 'Start the plugin automatically when the server starts',
        },
      },
    };
  }

  /**
   * Start periodic keepalive for Venus OS.
   * Venus OS requires R/{portalId}/keepalive to keep sending data.
   */
  _startKeepalive(intervalMs) {
    this._stopKeepalive();

    // Send initial keepalive once portal ID is known
    const sendKeepalive = () => {
      if (this._portalId && this._client && this._connected) {
        this._client.publish(`R/${this._portalId}/keepalive`, '');
      }
    };

    // Also send a broad keepalive to trigger portal ID detection
    if (this._client && this._connected) {
      // Subscribe to all N/ topics to detect portal ID
      this._client.subscribe('N/+/system/0/Serial');
    }

    this._keepaliveInterval = setInterval(sendKeepalive, intervalMs);
    // Send first keepalive after a short delay (wait for portal ID detection)
    setTimeout(sendKeepalive, 2000);
  }

  _stopKeepalive() {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  }
}
