/**
 * Walk a JSON value and emit every leaf as `{ path, value, type }`.
 * Used by binding pickers so nested numerics (e.g. Tasmota `ENERGY.Power`,
 * `Wifi.RSSI`) are selectable, not just top-level keys.
 *
 * - Arrays are not recursed (no stable index path) and not emitted.
 * - `null` values are skipped.
 * - `maxDepth` (default 6) bounds recursion.
 *
 * The returned `path` uses dot notation and matches the format consumed by
 * the server-side `extractField()` in `plugins/lib/binding-utils.js`.
 */
export function flattenJsonFields(input, { maxDepth = 6 } = {}) {
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { return []; }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

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
  walk(parsed, '', 0);
  return out;
}

/**
 * Resolve a dot-notation path against an already-parsed object/value.
 * Returns `null` if any segment is missing.
 */
export function extractField(obj, path) {
  if (obj == null || !path) return null;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return null;
    current = current[part];
  }
  return current ?? null;
}

/**
 * Apply a value transform — mirrors `applyTransform` in
 * plugins/lib/binding-utils.js so the UI can preview what the server will
 * actually send. Keep the two in sync when adding new transforms.
 */
export function applyTransform(value, transform) {
  if (!transform) return value;
  const num = Number(value);
  if (Number.isNaN(num)) return value;
  switch (transform) {
    case 'div1000': return Math.round(num / 1000 * 1e3) / 1e3;
    case 'div100':  return Math.round(num / 100 * 1e2) / 1e2;
    case 'mul1000': return num * 1000;
    case 'mul100':  return num * 100;
    case 'round':   return Math.round(num);
    case 'round1':  return Math.round(num * 10) / 10;
    default: return num;
  }
}
