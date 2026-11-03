/**
 * Shared slug helpers for plugin topic segments.
 *
 * Extracted from plugins/loxone/loxone-structure.js LoxoneStructure.slugify so
 * Loxone and UniFi (and any future plugin) produce identical topic shapes for
 * the same input string. Loxone keeps a private copy of the same algorithm for
 * now — a dedicated quick task will consolidate Loxone onto this module later.
 *
 * Invariants:
 *   - slugify is character-for-character equivalent to LoxoneStructure.slugify
 *     across the parameterised cross-check in tests/plugins/lib/slug.test.js
 *     (D-M-02 slug-stability decision).
 *   - macSlug normalises to lowercase dash-separated hex; non-MAC input maps
 *     to "unknown-mac" so callers never crash on garbage from the controller.
 *     The intent is "telemetry never throws"; structure-monitor logs garbage
 *     via the existing logger.
 */

/**
 * Slugify a string for use in MQTT topic segments.
 *
 * Lowercase, German umlauts to ASCII digraphs (ä→ae, ö→oe, ü→ue, ß→ss),
 * non-alphanumerics collapse to single hyphen, no leading/trailing hyphens.
 * Empty/null → "unknown".
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function slugify(str) {
  if (!str) return 'unknown';
  const slug = String(str)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'unknown';
}

/**
 * Convert a MAC address (any case, colon-/dash-separated, or bare hex) to the
 * canonical topic-safe form: lowercase, dash-separated.
 *
 * Examples:
 *   "02:00:00:00:00:FA" → "02-00-00-00-00-fa"
 *   "02-00-00-00-00-fa" → "02-00-00-00-00-fa" (idempotent)
 *   "0200000000fa"      → "02-00-00-00-00-fa"
 *
 * Returns "unknown-mac" for non-string, malformed, non-hex, or wrong-length
 * input. This is intentional — telemetry should not crash on garbage. The
 * caller (e.g. structure-monitor) decides whether to log the rejection.
 *
 * @param {string|null|undefined} mac
 * @returns {string}
 */
export function macSlug(mac) {
  if (typeof mac !== 'string' || mac.length === 0) return 'unknown-mac';
  // Strip separators (colons, dashes, dots, whitespace) then validate.
  const hex = mac.replace(/[:\-.\s]/g, '').toLowerCase();
  if (hex.length !== 12) return 'unknown-mac';
  if (!/^[0-9a-f]{12}$/.test(hex)) return 'unknown-mac';
  return [
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 12),
  ].join('-');
}
