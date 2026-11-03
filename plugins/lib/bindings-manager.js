/**
 * Encapsulates MQTT input binding lifecycle: state, apply, cleanup, get/set with persistence.
 * Used by LoxonePlugin and MqttBridgePlugin to eliminate duplicated binding boilerplate.
 */
import { applyBindings, cleanupBindings } from './binding-utils.js';

export class BindingsManager {
  /**
   * @param {object} opts
   * @param {string} opts.configKey - config path (e.g. 'plugins.loxone')
   * @param {(uuid: string, value: string) => void} opts.sendToTarget - forwards value to the target device
   */
  constructor({ configKey, sendToTarget }) {
    this._configKey = configKey;
    this._sendToTarget = sendToTarget;

    /** @type {Array<object>} */
    this._bindings = [];
    /** @type {Map<string, Function>} */
    this._handlers = new Map();
    /** @type {Map<string, { ts: number, value: any }>} */
    this._lastSend = new Map();
    /**
     * Per-binding heartbeat timer handles. Cleared by `cleanup()` so
     * setInterval handles never outlive a stop()/apply() cycle.
     * @type {Map<string, ReturnType<typeof setInterval>>}
     */
    this._intervals = new Map();

    this._ctx = null;
    this._config = null;
  }

  /**
   * Initialize from plugin context. Call in plugin.start().
   * @param {{ mqttService: object, configService: object, logger: object }} ctx
   * @param {object} config - the plugin's config object (mutated for persistence)
   */
  init(ctx, config) {
    this._ctx = ctx;
    this._config = config;
    this._bindings = config.inputBindings || [];
    this.apply();
  }

  /** @returns {Array<object>} */
  getBindings() {
    return [...this._bindings];
  }

  /**
   * Per-binding live stats for the dashboard. Returned shape:
   *   { id, value, lastSentAt, lastReceivedAt, sendCount, recvCount,
   *     lastError, lastErrorAt, lastReason, mqttTopic, jsonField, targetUuid,
   *     enabled, sourceMode }
   *
   * `sourceMode` drives the health classification and one runtime detail:
   * cyclic sources stop their heartbeat after 15 min without a live value
   * (binding-utils.js), event sources keep it. Default 'cyclic' for
   * back-compat with bindings persisted before the field existed.
   *
   * Bindings that exist in config but never received a payload yet show up
   * with zero counts and empty lastSentAt — handy for debugging "Loxone says
   * nothing arrives".
   */
  getStats() {
    const out = [];
    for (const b of this._bindings) {
      const s = this._lastSend.get(b.id) || {};
      out.push({
        id: b.id,
        label: b.label || b.id,
        enabled: b.enabled !== false,
        sourceMode: b.sourceMode || 'cyclic',
        mqttTopic: b.mqttTopic,
        jsonField: b.jsonField,
        targetUuid: b.targetUuid,
        value: 'value' in s ? s.value : null,
        lastSentAt: s.ts || null,
        lastReceivedAt: s.payloadTs || null,
        sendCount: s.sendCount || 0,
        recvCount: s.recvCount || 0,
        lastReason: s.lastReason || null,
        lastError: s.lastError || null,
        lastErrorAt: s.lastErrorAt || null,
      });
    }
    return out;
  }

  /**
   * Replace bindings, persist, and re-apply subscriptions.
   * @param {Array<object>} bindings
   */
  async setBindings(bindings) {
    this._bindings = bindings;
    this._config.inputBindings = bindings;
    if (this._ctx) {
      this._ctx.configService.set(this._configKey, this._config);
      await this._ctx.configService.save();
    }
    this.apply();
  }

  /** Subscribe to MQTT topics and wire up handlers. */
  apply() {
    if (!this._ctx) return;
    applyBindings({
      bindings: this._bindings,
      mqttService: this._ctx.mqttService,
      logger: this._ctx.logger,
      sendToTarget: this._sendToTarget,
      handlerMap: this._handlers,
      lastSendMap: this._lastSend,
      intervalMap: this._intervals,
    });
  }

  /** Unsubscribe all binding handlers. Call in plugin.stop(). */
  cleanup() {
    cleanupBindings({
      mqttService: this._ctx?.mqttService,
      handlerMap: this._handlers,
      lastSendMap: this._lastSend,
      intervalMap: this._intervals,
    });
  }
}
