/**
 * Pure helpers for the UnifiWan page (Phase 13 Plan 13-04).
 *
 * Kept Preact-free so the test suite can import without an htm/preact import
 * map. The Preact-side component lives in `unifi-wan.js`.
 *
 * Decisions referenced inline:
 *   D-P13-UI-02 — speedtest button rate-limit awareness (5 min cooldown default)
 *   D-P13-UI-02 — failover card only shown when wan2 is materially present
 *   D-T-04      — by-mac MUST be used for cmd topics (rename stability)
 */

/**
 * Render a kbps rate into a human-friendly string. <1000 kbit/s → "N kbit/s";
 * ≥1000 → "N.N Mbit/s" with 1 decimal. Null/NaN → "—". Zero is meaningful and
 * shown as "0 kbit/s" (the WAN is up but idle, distinct from "unknown").
 *
 * @param {number|null|undefined} kbps
 * @returns {string}
 */
export function formatRate(kbps) {
  if (kbps === null || kbps === undefined) return '—';
  if (typeof kbps !== 'number' || Number.isNaN(kbps)) return '—';
  if (kbps < 1000) return `${Math.round(kbps)} kbit/s`;
  return `${(kbps / 1000).toFixed(1)} Mbit/s`;
}

/**
 * Render a millisecond latency as "N ms"; null/undefined → "—".
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatLatency(ms) {
  if (ms === null || ms === undefined) return '—';
  if (typeof ms !== 'number' || Number.isNaN(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

/**
 * Render a byte count as B / KiB / MiB / GiB with 1 decimal at each step.
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/**
 * Compute the speedtest button's enabled state + cooldown seconds remaining.
 * D-P13-UI-02 — button disabled for `rateLimitMs` after last run.
 *
 * @param {{lastRun: number|null, rateLimitMs: number, now: number}} opts
 * @returns {{enabled: boolean, cooldownLeftSec: number}}
 */
export function speedtestButtonState({ lastRun, rateLimitMs, now }) {
  if (lastRun === null || lastRun === undefined) {
    return { enabled: true, cooldownLeftSec: 0 };
  }
  const elapsed = now - lastRun;
  if (elapsed >= rateLimitMs) return { enabled: true, cooldownLeftSec: 0 };
  return {
    enabled: false,
    cooldownLeftSec: Math.ceil((rateLimitMs - elapsed) / 1000),
  };
}

/**
 * The failover card is only relevant for dual-WAN setups. wan2 with a real
 * interface name → show. wan2=up:false + interface:null (single-WAN placeholder
 * the plugin emits per D-P13-WAN-02) → hide.
 *
 * @param {{wan1: object|null, wan2: object|null}} wans
 * @returns {boolean}
 */
export function failoverVisible({ wan1, wan2 }) {
  if (!wan2) return false;
  if (wan2.interface && wan2.interface !== null) return true;
  return false;
}

/**
 * Map a /stat/health subsystem status string to the StatusDot enum.
 * @param {string|null|undefined} status
 * @returns {'connected'|'unknown'|'error'}
 */
export function statusDotColor(status) {
  if (status === 'ok' || status === 'connected') return 'connected';
  if (status === 'error' || status === 'failed' || status === 'critical') return 'error';
  return 'unknown';
}

/**
 * Build the by-mac wan/cmd topic for a gateway. Always uses the by-mac
 * namespace so the topic survives device rename (D-T-04 / D-MISC-01).
 *
 * @param {string} prefix      `${topicPrefix}` (trailing slash optional).
 * @param {string} mac         Gateway MAC (case-insensitive).
 * @returns {string}
 */
export function buildWanCmdTopic(prefix, mac) {
  const p = String(prefix || '').replace(/\/+$/, '');
  const hex = String(mac || '').toLowerCase().replace(/[:\-.\s]/g, '');
  const slug = [
    hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6),
    hex.slice(6, 8), hex.slice(8, 10), hex.slice(10, 12),
  ].join('-');
  return `${p}/by-mac/${slug}/wan/cmd`;
}
