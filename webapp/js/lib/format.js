import { html } from 'htm/preact';

/** Format a numeric value for display */
export function fmtNum(v) {
  if (v == null || v === '' || v === 'None') return '--';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'number') return String(v).substring(0, 60);
  if (Number.isInteger(v)) return v.toLocaleString();
  return Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(1);
}

/** Format a msg/min rate as msg/s */
export function fmtRate(val) {
  if (val == null) return '--';
  const n = parseFloat(val);
  if (isNaN(n)) return '--';
  const perSec = n / 60;
  if (perSec >= 1000) return (perSec / 1000).toFixed(1) + 'k';
  if (perSec >= 10) return Math.round(perSec).toString();
  if (perSec >= 1) return perSec.toFixed(1);
  if (perSec > 0) return '<1';
  return '0';
}

/** Format a msg/s rate (already per-second) */
export function fmtMsgPerSec(rate) {
  if (rate == null || isNaN(rate)) return '';
  if (rate >= 1000) return (rate / 1000).toFixed(1) + 'k/s';
  if (rate >= 10) return Math.round(rate) + '/s';
  if (rate >= 1) return rate.toFixed(1) + '/s';
  if (rate > 0) return '<1/s';
  return '0/s';
}

/** Format large numbers compactly (k/M/B) */
export function fmtTotal(val) {
  if (val == null) return '--';
  const n = Number(val);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toLocaleString();
}

/** Format uptime seconds as human-readable string */
export function fmtUptime(seconds) {
  if (seconds == null) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format bytes as human-readable string */
export function fmtBytes(bytes) {
  if (bytes == null) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** MQTT broker icon (14px, used in Elements direction badges) */
export const mqttIcon = html`<svg class="lox-topic-mqtt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="5" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="12" cy="19" r="2.5"/><circle cx="12" cy="12" r="1.5"/><line x1="7" y1="6.5" x2="10.5" y2="11"/><line x1="17" y1="6.5" x2="13.5" y2="11"/><line x1="12" y1="13.5" x2="12" y2="16.5"/></svg>`;

/** Plugin type labels (consistent capitalization) */
export const TYPE_LABELS = { 'loxone': 'Loxone', 'mqtt-bridge': 'MQTT-Bridge', 'unifi': 'UniFi' };

/** Get display label for a plugin type */
export function pluginLabel(idOrName) {
  return TYPE_LABELS[idOrName] || idOrName.charAt(0).toUpperCase() + idOrName.slice(1);
}
