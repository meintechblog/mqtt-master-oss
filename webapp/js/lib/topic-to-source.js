import { flattenJsonFields } from './json-fields.js';

/**
 * Detect whether `payload` looks like a JSON-object payload (has nested
 * fields the wizard can pick from). Anything else — raw numbers, raw strings,
 * "on"/"off", JSON arrays, malformed JSON — is treated as a raw scalar and
 * forwarded as-is by the backend with `jsonField=''`.
 */
export function isRawScalarPayload(payload) {
  if (payload == null) return true;
  if (typeof payload !== 'string') return typeof payload !== 'object' || Array.isArray(payload);
  const trimmed = payload.trim();
  if (!trimmed) return true;
  // Cheap shape check: a JSON-object payload always starts with `{`.
  // `[…]` arrays, bare numbers, and bare strings (with or without quotes)
  // all fall through to raw mode.
  if (trimmed[0] !== '{') return true;
  try {
    const parsed = JSON.parse(trimmed);
    return !(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return true;
  }
}

/**
 * Synthesise the wizard's `source` shape from a raw cached payload so the
 * downstream steps (StepPickField, StepReview) work unchanged with nested
 * fields like `ENERGY.Power` or `Wifi.RSSI`.
 *
 * When the payload is a raw scalar (e.g. Tasmota motion sensor publishes
 * bare `0`/`1`), the source is flagged `isRaw=true` and a single sentinel
 * field `(raw payload)` with `isRaw: true` is exposed so the wizard can
 * route the user to the review step without picking a JSON path. The
 * resulting binding stores `jsonField=''` and the backend forwards the
 * payload verbatim.
 *
 * Two additional safety branches catch ambiguous topics that previously
 * trapped users into a `jsonField: "value"` binding that could never
 * resolve:
 *   - `noPayload: true` when no cached payload exists yet (null / empty
 *     string). The binding will forward the first arriving payload as-is.
 *   - `emptyJson: true` when the payload is a valid JSON object but
 *     flattenJsonFields yields nothing pickable (e.g. `{}`). Same idea —
 *     route to raw mode instead of inventing a non-existent path.
 */
export function topicToSource(topic, payload, ts) {
  // Branch 1: no payload seen yet. We cannot infer structure, so route to
  // raw mode and let the user know in the review step. The previous
  // behaviour invented a fake `value`-key/path here — a guaranteed mismatch
  // the moment a real payload arrived.
  const payloadIsEmpty =
    payload == null ||
    (typeof payload === 'string' && payload.trim() === '');
  if (payloadIsEmpty) {
    return {
      topic, payload, ts,
      isRaw: true,
      noPayload: true,
      fields: [{
        key: '(no payload yet)',
        path: '',
        type: 'string',
        sample: '',
        isRaw: true,
      }],
    };
  }

  const raw = isRawScalarPayload(payload);
  if (raw) {
    // Try to interpret the raw payload as a number so the review step's
    // transform preview is meaningful. Falls back to a string sample.
    const s = typeof payload === 'string' ? payload.trim() : payload;
    const num = Number(s);
    const sample = Number.isFinite(num) && s !== '' && s != null ? num : String(s ?? '').substring(0, 100);
    return {
      topic, payload, ts,
      isRaw: true,
      fields: [{
        key: '(raw payload)',
        path: '',
        type: typeof sample === 'number' ? 'number' : 'string',
        sample,
        isRaw: true,
      }],
    };
  }

  const flat = flattenJsonFields(payload);
  // Branch 2: JSON object with no extractable fields (e.g. `{}` or an object
  // whose only values are null/arrays). Route to raw mode rather than
  // inventing a fake `value` path the backend will never find.
  if (flat.length === 0) {
    return {
      topic, payload, ts,
      isRaw: true,
      emptyJson: true,
      fields: [{
        key: '(empty JSON object — using raw)',
        path: '',
        type: 'string',
        sample: '',
        isRaw: true,
      }],
    };
  }

  const fields = flat.map(({ path, value, type }) => ({
    key: path,
    path,
    type,
    sample: typeof value === 'number' ? value : String(value).substring(0, 100),
  }));
  return { topic, payload, ts, fields };
}

/**
 * Classify an MQTT topic into the binding sourceMode the new-binding wizard
 * should seed by default. Output is one of the two literals consumed by
 * binding-health.js (see quick 260528-37o): 'event' for event-driven topics
 * that should NOT trigger an input_stale warning after silence, 'cyclic'
 * for topics that republish at a known cadence and SHOULD.
 *
 * The heuristic is intentionally narrow: only Tasmota stat/ topics
 * (e.g. stat/POWER, stat/wasserboiler/POWER1) are treated as event
 * sources. Everything else — tele/..., loxone-*-state, plain device
 * prefixes, the empty string, non-string inputs — falls back to
 * 'cyclic' (which matches the existing b.sourceMode || 'cyclic'
 * fallback in BindingCard's Quelle select).
 *
 * Defensive: any non-string input (null, undefined, number, object)
 * returns 'cyclic' without throwing.
 *
 * @param {unknown} topic - The MQTT topic the wizard is binding.
 * @returns {'cyclic'|'event'} Default sourceMode for the new binding.
 *
 * @example
 *   detectSourceMode('stat/POWER')                // 'event'
 *   detectSourceMode('tele/wasserboiler/SENSOR')  // 'cyclic'
 */
export function detectSourceMode(topic) {
  if (typeof topic !== 'string') return 'cyclic';
  return topic.startsWith('stat/') ? 'event' : 'cyclic';
}
