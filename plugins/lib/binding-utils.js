/**
 * Shared utilities for MQTT input binding execution.
 * Used by both Loxone and MQTT-Bridge plugins.
 */

import { INPUT_STALE_MS } from './binding-health.js';

/** Reasons the heartbeat must not overwrite – they drive the red health state. */
const ERROR_REASONS = new Set(['send_error', 'field_missing', 'json_parse_failed', 'empty_payload']);

/**
 * Extract a field from a JSON object using dot notation.
 * @param {object} obj
 * @param {string} path - e.g. "ac_power_w" or "data.power"
 * @returns {number|string|null}
 */
export function extractField(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return null;
    current = current[part];
  }
  return current ?? null;
}

/**
 * Walk a JSON object recursively and emit every leaf as
 * `{ path: 'a.b.c', value, type }`. Useful for input-binding pickers that
 * need to surface nested numeric fields (e.g. Tasmota `ENERGY.Power`).
 *
 * - Arrays are skipped (no stable path) and not recursed.
 * - `null` and `undefined` are skipped.
 * - `maxDepth` guards against runaway nesting (default 6 levels).
 */
export function flattenJsonFields(obj, { maxDepth = 6 } = {}) {
  const out = [];
  function walk(node, path, depth) {
    if (node == null || depth > maxDepth) return;
    if (typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        const next = path ? `${path}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          walk(v, next, depth + 1);
        } else if (v != null && !Array.isArray(v)) {
          out.push({ path: next, value: v, type: typeof v });
        }
      }
    }
  }
  walk(obj, '', 0);
  return out;
}

/**
 * Apply a value transform.
 * @param {number|string} value
 * @param {string|null} transform
 * @returns {number|string}
 */
export function applyTransform(value, transform) {
  if (!transform) return value;
  const num = Number(value);
  if (isNaN(num)) return value;
  switch (transform) {
    case 'div1000': return Math.round(num / 1000 * 1e3) / 1e3;
    case 'div100': return Math.round(num / 100 * 1e2) / 1e2;
    case 'mul1000': return num * 1000;
    case 'mul100': return num * 100;
    case 'round': return Math.round(num);
    case 'round1': return Math.round(num * 10) / 10;
    default: return num;
  }
}

/**
 * Apply sign inversion when `invert === true`. Numeric only — non-finite
 * values pass through unchanged so raw string payloads like "on"/"off"
 * are NOT negated into "oNaN" / NaN. Composes with `applyTransform`:
 *
 *   raw → applyTransform → applyInvert → forwarded
 *
 * Loxone-convention use case: source publishes `0.34` (kW import) but the
 * Loxone control expects `-0.34` (negative = consumption).
 *
 * @param {number|string} value
 * @param {boolean|undefined} invert
 * @returns {number|string}
 */
export function applyInvert(value, invert) {
  if (!invert) return value;
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return -num;
}

/**
 * Apply input bindings: subscribe to MQTT topics, extract values, send to targets.
 *
 * `lastSendMap` is also used to track per-binding live stats consumed by the
 * dashboard: each entry has { value, ts, payloadTs, sendCount, recvCount,
 * lastError, lastErrorAt, lastReason } so the UI can show what's flowing
 * through and why a value didn't propagate (parse error, missing path,
 * dedup, etc.). Older entries with just { value, ts } are migrated lazily.
 *
 * @param {object} opts
 * @param {Array} opts.bindings - binding definitions
 * @param {object} opts.mqttService - local MQTT service
 * @param {object} opts.logger
 * @param {Function} opts.sendToTarget - (uuid, value) => void | Promise
 * @param {Map} opts.handlerMap - Map to store handlers for cleanup
 * @param {Map} opts.lastSendMap - Map to store per-binding stats
 * @param {Map} [opts.intervalMap] - Map<bindingId, intervalHandle> for
 *   per-binding heartbeat timers. Passed in by `BindingsManager.apply()` so
 *   `cleanupBindings` can `clearInterval` on reconfigure / stop. Optional —
 *   if omitted, no heartbeat is armed (back-compat for old callers).
 */
export function applyBindings({ bindings, mqttService, logger, sendToTarget, handlerMap, lastSendMap, intervalMap }) {
  cleanupBindings({ mqttService, handlerMap, lastSendMap, intervalMap });

  for (const binding of bindings) {
    if (!binding.enabled || !binding.mqttTopic || !binding.targetUuid) continue;

    // `??` (not `||`) so an explicit user-set `keepaliveMs: 0` means "disable
    // heartbeat" instead of silently falling through to the 30s default.
    const keepaliveMs = binding.keepaliveMs ?? binding.intervalMs ?? 30000;
    mqttService.subscribe(binding.mqttTopic);

    const stat = lastSendMap.get(binding.id) || { sendCount: 0, recvCount: 0 };
    lastSendMap.set(binding.id, stat);

    const recordReason = (reason, payloadTs) => {
      stat.recvCount = (stat.recvCount || 0) + 1;
      stat.payloadTs = payloadTs;
      stat.lastReason = reason;
    };

    // Timer-driven heartbeat: re-sends the last cached value to Loxone every
    // `keepaliveMs` so an event-only sensor (e.g. a motion sensor that only
    // publishes on transition) still "looks alive" to Loxone. `recvCount` is
    // intentionally NOT bumped here — heartbeats are bridge-internal sends, not
    // received MQTT events.
    const fireHeartbeat = () => {
      if (stat.value == null) return; // never received yet
      const now = Date.now();
      // Do not keep feeding a dead source into Loxone: for cyclic publishers,
      // stop the heartbeat once no valid live MQTT value arrived for
      // INPUT_STALE_MS (the same 15 min as the `input_stale` health warning).
      // `valueTs` only moves on a usable, non-retained value, so error
      // payloads or a retained replay never keep an old value alive. Event
      // sources keep their heartbeat – they are quiet by design. Set
      // `staleAfterMs: 0` to restore the old "repeat forever" behaviour.
      // Bindings saved before `sourceMode` existed: classify like the UI
      // wizard does for new ones (detectSourceMode: Tasmota `stat/` = event),
      // so an old motion sensor does not silently lose its heartbeat.
      const sourceMode = binding.sourceMode
        || (binding.mqttTopic.startsWith('stat/') ? 'event' : 'cyclic');
      if (sourceMode !== 'event' && binding.staleAfterMs !== 0
          && now - (stat.valueTs || 0) > INPUT_STALE_MS) {
        if (!ERROR_REASONS.has(stat.lastReason)) stat.lastReason = 'stale_skip';
        return;
      }
      stat.ts = now;
      stat.sendCount = (stat.sendCount || 0) + 1;
      stat.lastReason = 'timer_heartbeat';
      try {
        const result = sendToTarget(binding.targetUuid, String(stat.value));
        if (result && typeof result.then === 'function') {
          result.then(() => {}, (err) => {
            stat.lastError = err?.message || String(err);
            stat.lastErrorAt = Date.now();
            stat.lastReason = 'send_error';
            stat.sendCount = Math.max(0, (stat.sendCount || 1) - 1);
            logger.warn?.(`Binding ${binding.label || binding.id} timer-heartbeat send failed: ${stat.lastError}`);
          });
        }
      } catch (err) {
        stat.lastError = err?.message || String(err);
        stat.lastErrorAt = Date.now();
        stat.lastReason = 'send_error';
        stat.sendCount = Math.max(0, (stat.sendCount || 1) - 1);
        logger.warn?.(`Binding ${binding.label || binding.id} timer-heartbeat send failed: ${stat.lastError}`);
      }
    };

    // Re-arm the per-binding heartbeat interval, clearing any prior one. We
    // re-arm after every real MQTT-driven send so the next heartbeat fires a
    // full interval AFTER the fresh value, not on the original schedule (which
    // could otherwise re-send 100ms after a real change).
    const armHeartbeat = () => {
      if (!intervalMap) return;
      const old = intervalMap.get(binding.id);
      if (old) clearInterval(old);
      if (keepaliveMs > 0) {
        intervalMap.set(binding.id, setInterval(fireHeartbeat, keepaliveMs));
      } else {
        intervalMap.delete(binding.id);
      }
    };

    const handler = (msg) => {
      if (msg.topic !== binding.mqttTopic) return;
      const now = Date.now();
      // Coerce payload to a string regardless of source (Buffer, Uint8Array,
      // string). MQTT.js delivers Buffer; some test mocks deliver strings.
      const payloadStr = typeof msg.payload === 'string'
        ? msg.payload
        : (msg.payload != null ? msg.payload.toString() : '');
      let raw;
      if (!binding.jsonField) {
        // Raw scalar mode — the topic publishes a bare number/string (e.g.
        // Tasmota motion sensor `stat/.../Bewegungsmelder` → `0`/`1`). No
        // JSON.parse here, so payloads like `1.5` and `"on"` both flow
        // through without surprise. Numbers are coerced, everything else is
        // passed through as a string so downstream transforms can still act.
        const s = payloadStr.trim();
        if (!s) {
          recordReason('empty_payload', now);
          stat.lastError = 'received empty payload in raw mode';
          stat.lastErrorAt = now;
          return;
        }
        const num = Number(s);
        raw = Number.isFinite(num) ? num : s;
      } else {
        let data;
        try { data = JSON.parse(payloadStr); }
        catch (err) {
          recordReason('json_parse_failed', now);
          stat.lastError = `payload not JSON: ${err.message}`;
          stat.lastErrorAt = now;
          return;
        }
        raw = extractField(data, binding.jsonField);
        if (raw == null) {
          recordReason('field_missing', now);
          stat.lastError = `path "${binding.jsonField}" not in payload`;
          stat.lastErrorAt = now;
          return;
        }
      }
      let value = applyTransform(raw, binding.transform);
      value = applyInvert(value, binding.invert);
      if (typeof value === 'number') value = Math.round(value * 1000) / 1000;
      // Freshness for the heartbeat: a retained delivery (subscribe/reconnect
      // replay) is the broker's old copy, not a sign the source is alive.
      if (!msg.retain) stat.valueTs = now;

      const valueChanged = !('value' in stat) || stat.value !== value;
      const keepaliveExpired = !stat.ts || (now - stat.ts >= keepaliveMs);
      if (!valueChanged && !keepaliveExpired) {
        recordReason('dedup', now);
        return;
      }

      // Optimistically record the send attempt first so dedup state stays
      // consistent — then track Promise rejection / sync throw on top.
      stat.value = value;
      stat.ts = now;
      stat.payloadTs = now;
      stat.recvCount = (stat.recvCount || 0) + 1;
      stat.sendCount = (stat.sendCount || 0) + 1;
      stat.lastReason = valueChanged ? 'changed' : 'keepalive';
      stat.lastError = null;
      stat.lastErrorAt = null;
      if (valueChanged) {
        logger.info(`Binding ${binding.label || binding.id}: ${value} → ${binding.targetUuid}`);
      }
      try {
        const result = sendToTarget(binding.targetUuid, String(value));
        // Async sendToTarget returns a Promise — capture rejections so they
        // surface in the stats (otherwise mqtt-bridge → loxone forwarders
        // would silently fail when the loxone plugin can't be reached).
        if (result && typeof result.then === 'function') {
          result.then(() => {}, (err) => {
            stat.lastError = err?.message || String(err);
            stat.lastErrorAt = Date.now();
            stat.lastReason = 'send_error';
            stat.sendCount = Math.max(0, (stat.sendCount || 1) - 1);
            logger.warn?.(`Binding ${binding.label || binding.id} send failed: ${stat.lastError}`);
          });
        }
      } catch (err) {
        stat.lastError = err?.message || String(err);
        stat.lastErrorAt = Date.now();
        stat.lastReason = 'send_error';
        stat.sendCount = Math.max(0, (stat.sendCount || 1) - 1);
        logger.warn?.(`Binding ${binding.label || binding.id} send failed: ${stat.lastError}`);
      }

      // A real MQTT-driven send just happened → re-arm the heartbeat so the
      // next timer-fired send is `keepaliveMs` from NOW rather than from the
      // original subscribe instant. Without this the heartbeat could re-fire
      // a fraction of a second after a real change.
      armHeartbeat();
    };

    mqttService.on('message', handler);
    handlerMap.set(binding.id, { handler, topic: binding.mqttTopic });
    // Arm the initial heartbeat. `armHeartbeat` is a no-op when keepaliveMs===0
    // (user disabled heartbeat) or when intervalMap was not provided (legacy
    // caller).
    armHeartbeat();
    const mode = binding.jsonField ? `[${binding.jsonField}]` : '[raw]';
    const hbMarker = keepaliveMs > 0 ? `heartbeat ${keepaliveMs / 1000}s` : 'heartbeat off';
    logger.info(`Input binding: ${binding.mqttTopic} ${mode} → ${binding.targetUuid} (${binding.label || binding.id}, ${hbMarker})`);
  }
}

/**
 * Clean up all binding subscription handlers, including any per-binding
 * heartbeat timers stored in `intervalMap`.
 *
 * `intervalMap` is optional so existing callers without heartbeat support
 * keep working — but new callers (BindingsManager) always pass it.
 */
export function cleanupBindings({ mqttService, handlerMap, lastSendMap, intervalMap }) {
  // Clear timers even if mqttService is missing — they're independent of MQTT
  // (an orphaned setInterval is the more dangerous leak: it keeps Node alive
  // and still calls sendToTarget every keepaliveMs after stop()).
  if (intervalMap) {
    for (const [, handle] of intervalMap) {
      clearInterval(handle);
    }
    intervalMap.clear();
  }
  if (!mqttService) return;
  for (const [, entry] of handlerMap) {
    mqttService.removeListener('message', entry.handler);
  }
  handlerMap.clear();
  lastSendMap.clear();
}
