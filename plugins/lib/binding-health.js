/**
 * Binding-health severity model — the single source of truth for turning a
 * per-binding stats object (from `getInputBindingStats()`) into a traffic-light
 * severity, and for rolling those up per plugin.
 *
 * Pure + side-effect-free so it is trivially unit-tested. The backend endpoint
 * `GET /api/bindings/health` and (transitively) the sidebar dot both consume
 * this.
 *
 * Limitation: a deleted Loxone target UUID is NOT detectable while the Loxone
 * plugin is still UP — Loxone silently accepts unknown UUIDs, so no error
 * surfaces in the stats. The output-side failure we CAN see is `send_error`
 * (the counterpart plugin is down). Anything beyond that is out of scope.
 */

/**
 * A binding whose source publishes nothing for longer than this is flagged as
 * `input_stale` (warn, not error). Documented trade-off: a source that
 * genuinely publishes slower than 15 min will show a false orange — opt out
 * per-binding by setting `sourceMode: 'event'` (motion sensors, door contacts,
 * any change-driven publisher). Cyclic sources (default) keep the 15-min
 * threshold; event sources skip the stale branch but `input_silent` still
 * fires when an event source has never published anything.
 * Kept a named constant so it's a one-line tune later.
 */
export const INPUT_STALE_MS = 15 * 60 * 1000;

/**
 * Distil one binding's stats into a severity.
 *
 * @param {object} stat - one element of `getInputBindingStats()`:
 *   { id, label, enabled, mqttTopic, jsonField, targetUuid, value,
 *     lastSentAt, lastReceivedAt, sendCount, recvCount, lastReason,
 *     lastError, lastErrorAt, sourceMode }
 *   `sourceMode` ∈ {'cyclic', 'event'}; absent/unknown is treated as 'cyclic'
 *   for backward compatibility.
 * @param {number} now - current epoch ms (injected so tests are deterministic)
 * @returns {{ severity: 'ok'|'warn'|'error'|'disabled', reason: string, detail: string }}
 */
export function evaluateBindingHealth(stat, now = Date.now()) {
  const s = stat || {};

  // Disabled bindings short-circuit — they are excluded from the aggregate
  // entirely (not counted, not in issues). The user turned them off on purpose.
  if (s.enabled === false) {
    return { severity: 'disabled', reason: 'disabled', detail: 'Binding deaktiviert' };
  }

  const recvCount = Number(s.recvCount) || 0;
  const sendCount = Number(s.sendCount) || 0;

  // ── ERROR (red) — first match wins ──────────────────────────────────────
  if (s.lastReason === 'send_error') {
    return {
      severity: 'error',
      reason: 'send_error',
      detail: 'Ziel nicht erreichbar — Gegenstück offline?',
    };
  }
  if (s.lastReason === 'field_missing') {
    return {
      severity: 'error',
      reason: 'field_missing',
      detail: 'JSON-Feld nicht im Payload',
    };
  }
  if (s.lastReason === 'json_parse_failed') {
    return {
      severity: 'error',
      reason: 'json_parse_failed',
      detail: 'Payload ist kein JSON',
    };
  }
  if (s.lastReason === 'empty_payload') {
    return {
      severity: 'error',
      reason: 'empty_payload',
      detail: 'Leerer Payload empfangen',
    };
  }
  // Messages arrive but never get forwarded (and none of the explicit error
  // reasons above fired).
  if (recvCount > 0 && sendCount === 0) {
    return {
      severity: 'error',
      reason: 'never_forwarded',
      detail: 'Empfangen, aber nie weitergeleitet',
    };
  }

  // ── WARN (orange) ───────────────────────────────────────────────────────
  if (recvCount === 0 || !s.lastReceivedAt) {
    return {
      severity: 'warn',
      reason: 'input_silent',
      detail: 'Noch keine MQTT-Nachricht empfangen',
    };
  }
  // Event-driven sources (motion sensors, door contacts, ...) legitimately
  // sit quiet for long stretches — only flag stale for cyclic publishers.
  // `input_silent` above still fires for event sources that have NEVER
  // published anything (genuinely broken).
  if (s.sourceMode !== 'event' && now - s.lastReceivedAt > INPUT_STALE_MS) {
    return {
      severity: 'warn',
      reason: 'input_stale',
      detail: 'Seit über 15 Min keine neuen Werte',
    };
  }

  // ── OK (green) ──────────────────────────────────────────────────────────
  // Everything else: lastReason ∈ changed/keepalive/dedup/timer_heartbeat,
  // sendCount > 0, no error. `dedup` and `timer_heartbeat` are HEALTHY — a
  // deduped value is normal operation, not a fault.
  return { severity: 'ok', reason: 'ok', detail: 'Binding OK' };
}

/** Sort weight so error issues bubble above warn issues. */
const SEVERITY_RANK = { error: 0, warn: 1 };

/**
 * Roll a plugin's bindings up into a single health summary.
 *
 * @param {object[]} stats - array of per-binding stats
 * @param {number} now - current epoch ms
 * @returns {{
 *   severity: 'ok'|'warn'|'error'|'none',
 *   total: number,
 *   counts: { ok: number, warn: number, error: number, disabled: number },
 *   issues: Array<{ id, label, severity, reason, detail }>
 * }}
 */
export function aggregateHealth(stats, now = Date.now()) {
  const list = Array.isArray(stats) ? stats : [];
  const counts = { ok: 0, warn: 0, error: 0, disabled: 0 };
  const issues = [];

  for (const stat of list) {
    const h = evaluateBindingHealth(stat, now);
    counts[h.severity] = (counts[h.severity] || 0) + 1;
    // ok + disabled never become issues.
    if (h.severity === 'warn' || h.severity === 'error') {
      issues.push({
        id: stat?.id ?? null,
        label: stat?.label || stat?.id || '(unbenannt)',
        severity: h.severity,
        reason: h.reason,
        detail: h.detail,
      });
    }
  }

  // Error-first ordering so the worst problem leads the tooltip.
  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const total = counts.ok + counts.warn + counts.error; // enabled bindings only
  let severity;
  if (counts.error > 0) severity = 'error';
  else if (counts.warn > 0) severity = 'warn';
  else if (total > 0) severity = 'ok';
  else severity = 'none'; // no enabled bindings at all

  return { severity, total, counts, issues };
}
