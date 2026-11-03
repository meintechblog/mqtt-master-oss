/**
 * Command value parsing and the gate that decides whether a value from the
 * Loxone state topic may trigger a robot action.
 *
 * The command topic carries a *standing* value (Loxone state), not a pulse.
 * To make sure a restart, a reconnect or a stale retained message can never
 * start a robot, the gate acts only on a change of the value after an initial
 * sync:
 *   - messages with the MQTT retain flag are ignored completely;
 *   - the first valid value after (re)subscribe / (re)connect is only stored;
 *   - values other than 0 / 1 / 2 are ignored and do not touch the baseline;
 *   - a payload with an `id` (P3 path `steuer/...`, QoS 1, `{v, ts, id}`) acts
 *     at most once per id, so a late QoS 1 duplicate never acts again even when
 *     it is not the direct predecessor. The ids are
 *     remembered by time, not by count: a command must carry a `ts`
 *     within [now - MAX_AGE, now + MAX_FUTURE] and its id is kept for MAX_AGE,
 *     so every duplicate is either still remembered or too old. A full memory
 *     refuses new commands (fail closed).
 *
 * A command with a valid id is a single command, not a standing value: it acts at once, also right after reset() / a reconnect without an
 * initial sync. It is protected by the ignored retain flag, the ts window and
 * the id memory. It stores the baseline, so a bare value of the same size that
 * follows does not act again. An `id` property of the wrong type (null, true,
 * {}, '', 1.5 ...) is refused instead of falling back to the bare path.
 *
 * The bare Loxone value of today carries no id. It is subscribed with QoS 0 on
 * a clean session (mqttService), so the broker never redelivers it, and MQTT
 * keeps the order of one publisher on one topic.
 */

/** value -> command name (1 = start, 2 = pause, 0 = stop, then return to base) */
export const COMMANDS = Object.freeze({ 0: 'stop', 1: 'start', 2: 'pause' });

const MAX_AGE_MS = 120_000; // oldest accepted command ts, and how long an id is remembered
const MAX_FUTURE_MS = 30_000; // clock skew tolerated for a command ts
const ID_MEMORY = 1024; // upper bound of remembered ids per device
const MAX_ID_LENGTH = 128;

/** @returns {boolean} true for a non-empty string of at most 128 characters or a safe integer */
function validId(id) {
  if (typeof id === 'string') return id !== '' && id.length <= MAX_ID_LENGTH;
  return Number.isSafeInteger(id);
}

/** @returns {object|null} the JSON object of a payload, or null */
function parseObject(payload) {
  const text = String(payload ?? '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} payload raw MQTT payload: a number, JSON with "value" (Loxone), or the P3
 *   form {v, ts, id}; "v" without an id is our own state format and is refused
 * @returns {number|null} finite number or null when unparsable
 */
export function parseCommandValue(payload) {
  const text = String(payload ?? '').trim();
  if (text === '') return null;
  let v = text;
  if (text.startsWith('{')) {
    const obj = parseObject(text);
    if (!obj) return null;
    v = obj.value !== undefined ? obj.value : (obj.id !== undefined ? obj.v : null);
  }
  if (typeof v === 'string') v = v.trim() === '' ? null : Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Command value in a form Loxone itself publishes on its state topic: a bare
 * 0/1/2 or its value object {value,name,type,uuid,room} with a numeric value and
 * without an id.
 * @returns {number|null}
 */
export function loxoneValue(payload) {
  const text = String(payload ?? '');
  if (/^[012]$/.test(text)) return Number(text);
  const obj = parseObject(text);
  if (!obj || Object.hasOwn(obj, 'id') || typeof obj.value !== 'number' || !Number.isFinite(obj.value)) return null;
  return obj.value;
}

export class CommandGate {
  /**
   * @param {{ log?: (text: string) => void, ids?: Map<string, number> }} [opts] log gets short texts
   *   without payloads; ids is an id memory owned by the caller, so it can outlive this gate
   */
  constructor({ log, ids } = {}) {
    this._log = log || null;
    this._ids = ids || new Map(); // id -> command ts; survives reset() so a duplicate after a reconnect stays refused
    this.reset();
  }

  /** Forget the baseline: the next valid value is an initial sync again. */
  reset() {
    this._seen = false;
    this._last = null;
  }

  /**
   * @param {string} payload
   * @param {boolean} retain MQTT retain flag of the delivery
   * @param {number} [now] current time in ms (tests)
   * @returns {'start'|'pause'|'stop'|null} command to execute, or null
   */
  accept(payload, retain, now = Date.now()) {
    if (retain) return null;
    const value = parseCommandValue(payload);
    if (value === null || !Object.hasOwn(COMMANDS, value)) return null;
    const obj = parseObject(payload);
    const hasId = !!obj && Object.hasOwn(obj, 'id');
    if (hasId && !validId(obj.id)) {
      this._log?.('command refused: id has an invalid type or length');
      return null;
    }
    if (hasId) {
      const id = obj.id;
      const ts = typeof obj.ts === 'number' && Number.isFinite(obj.ts) ? obj.ts : null;
      if (ts === null || now - ts > MAX_AGE_MS || ts - now > MAX_FUTURE_MS) {
        this._log?.('command with an id refused: ts missing or outside the accepted window');
        return null;
      }
      for (const [k, t] of this._ids) if (now - t > MAX_AGE_MS) this._ids.delete(k);
      const key = String(id);
      if (this._ids.has(key)) return null;
      if (this._ids.size >= ID_MEMORY) {
        this._log?.('command with an id refused: id memory is full');
        return null;
      }
      this._ids.set(key, ts);
      // a single command: acts now, no initial sync; the baseline follows it, but the
      // initial sync stays open, so a standing bare value after it is still only a baseline
      this._last = value;
      return COMMANDS[value];
    }
    if (!this._seen) {
      this._seen = true;
      this._last = value;
      return null;
    }
    if (value === this._last) return null;
    this._last = value;
    return COMMANDS[value];
  }
}
