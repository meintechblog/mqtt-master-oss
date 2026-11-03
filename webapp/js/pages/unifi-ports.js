/**
 * UniFi plugin detail page — Phase 10 Plan 10-02.
 *
 * Renders the per-device port grid, structure inspector, action buttons
 * (On / Off / Cycle), filter row, off-confirmation modal, and result-topic
 * toasts. Mirrors the loxone-controls.js pattern: live values via
 * /ws/messages, scoped Venus-OS-themed CSS, inline cmd buttons that publish
 * over the same /api/mqtt/publish channel used by the dashboard.
 *
 * Critical invariants enforced here:
 *
 *   - D-OFF-CONFIRM-01:  Off requires a modal naming the connected device.
 *                        Cycle and On do NOT.
 *
 *   - D-GRID-03 + T-07-05 + T-09-05 + T-10-05 + T-10-06:
 *                        Protected ports are gated at the JS-click-handler
 *                        layer BEFORE any publish call. `disabled` is the
 *                        UX hint; the `if (isProtected) return;`
 *                        short-circuit is the actual gate. Even if the user
 *                        removes the attribute via DevTools and fires a
 *                        click, NO MQTT publish is reached.
 *
 *   - D-TOAST-02:        Pending state has a 10 s timeout → yellow warning
 *                        toast "Command sent but no result confirmation
 *                        received". Threshold pinned by
 *                        derivePendingTimedOut + unit tests.
 *
 *   - D-THEME-01:        ALL CSS uses existing custom properties from
 *                        webapp/css/theme.css. NO new globals. Class names
 *                        prefixed `unifi-ports-` (page-scoped).
 *
 *   - T-10-07:           connected_device + port_name rendered as text
 *                        children of HTM templates — escaped by Preact. NO
 *                        innerHTML, NO dangerouslySetInnerHTML anywhere.
 *
 *   - T-10-08:           cmd topic built via pure `buildCmdTopic()` from the
 *                        mac field of getStatus().protectedPorts /
 *                        structure.devices. No user-controlled string flows
 *                        into the topic.
 */

import { html } from 'htm/preact';
import { useEffect, useState, useRef, useCallback, useMemo } from 'preact/hooks';
import { publishMqtt, getStructureRaw, refreshStructure } from '../lib/api-client.js';
import { StatusDot } from '../components/status-dot.js';
import {
  messages,
  subscribeTopic,
  unsubscribeTopic,
  connectMessagesWs,
  disconnectMessagesWs,
} from '../lib/ws-messages-client.js';
import {
  wattageBadgeClass,
  applyFilter,
  isProtectedKey,
  buildCmdTopic,
  buildCmdPayload,
  derivePendingTimedOut,
  PORT_RESULT_TIMEOUT_MS,
} from './unifi-ports-logic.js';

// Re-export the pure helpers so callers that imported them from this module
// still resolve (kept for back-compat — tests import from unifi-ports-logic.js).
export {
  wattageBadgeClass,
  applyFilter,
  isProtectedKey,
  buildCmdTopic,
  buildCmdPayload,
  derivePendingTimedOut,
};

// ═══════════════════════════════════════════════════════════════════════════
// Component-local helpers (not exported — wholly internal)
// ═══════════════════════════════════════════════════════════════════════════

/** Topic prefix → WS subscription patterns. The plugin publishes EVERY port
 *  state + result on TWO topics: the slug form (`{prefix}{slug}/port/N/...`)
 *  and the by-mac form (`{prefix}by-mac/{macSlug}/port/N/...`). MQTT's `+`
 *  wildcard matches exactly one level, so `{prefix}+/port/+/...` matches
 *  ONLY the slug form. The by-mac form needs its own subscription.
 *
 *  This page parses the by-mac form (the slug is unstable across UniFi
 *  device renames, while the MAC is forever); subscribing to slug-form too
 *  is a no-op safety net — those messages return null from parseStateTopic
 *  and are silently dropped. The fix: also subscribe to the by-mac form,
 *  otherwise no port-state / port-result message ever reaches the parser. */
function statePatternSlug(prefix)   { return `${prefix}+/port/+/state`; }
function resultPatternSlug(prefix)  { return `${prefix}+/port/+/result`; }
function statePatternByMac(prefix)  { return `${prefix}by-mac/+/port/+/state`; }
function resultPatternByMac(prefix) { return `${prefix}by-mac/+/port/+/result`; }

/** Parse a /port/{idx}/state topic into {mac, port_idx} when it matches the
 *  `by-mac` form. Returns null for slug-form topics — we de-duplicate via
 *  the mac form only so the cache key is stable across renames.
 *
 *  Accepts BOTH macSlug forms the publisher might emit:
 *    - dashed:  `02-00-00-00-00-fa`  (what unifi-poll.js / macSlug() emits today)
 *    - compact: `0200000000fa`       (legacy / belt-and-suspenders)
 *  The dashed form is the live wire format; the previous regex only matched
 *  the compact form, so result-topic toasts silently never fired and every
 *  rename / PoE write hit the 10s "no confirmation received" timeout. */
function parseStateTopic(topic) {
  const m = topic.match(/^.*\/by-mac\/([a-z0-9-]+)\/port\/(\d+)\/(state|result)$/);
  if (!m) return null;
  const slug = m[1];
  const port_idx = parseInt(m[2], 10);
  const kind = m[3];
  let mac = null;
  if (slug.length === 17 && slug.split('-').length === 6) {
    // dashed: aa-bb-cc-dd-ee-ff → aa:bb:cc:dd:ee:ff
    mac = slug.replace(/-/g, ':');
  } else if (slug.length === 12) {
    // compact: aabbccddeeff → aa:bb:cc:dd:ee:ff
    mac = `${slug.slice(0,2)}:${slug.slice(2,4)}:${slug.slice(4,6)}:${slug.slice(6,8)}:${slug.slice(8,10)}:${slug.slice(10,12)}`;
  } else {
    return null; // unknown shape — refuse so we don't fabricate a bad mac key
  }
  return { mac, port_idx, kind };
}

/** Humanise an ISO timestamp into "5 s ago" / "2 m ago". Returns "never" for null. */
function humanizeAge(iso) {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const ageMs = Date.now() - t;
  if (ageMs < 0) return 'just now';
  const s = Math.floor(ageMs / 1000);
  if (s < 60)  return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m} m ago`;
  const h = Math.floor(m / 60);
  return `${h} h ago`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Inline page-scoped CSS — all selectors prefixed `unifi-ports-`. Reuses
// the Venus-OS palette tokens declared in webapp/css/theme.css (no new
// globals — D-THEME-01).
// ═══════════════════════════════════════════════════════════════════════════

const PAGE_CSS = `
.unifi-ports-page { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.unifi-ports-page > * { min-width: 0; }

.unifi-ports-inspector {
  background: var(--ve-bg-widget);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-lg);
  padding: 16px 20px;
  /* CSS grid with auto-fit/minmax guarantees the chips wrap into rows when
   * the page is narrow — a flex row with flex-wrap was leaving the spacer +
   * refresh button anchored to a single line and dragging the inspector
   * wider than the viewport. */
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, max-content));
  gap: 14px 18px;
  align-items: center;
}
.unifi-ports-inspector-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.unifi-ports-inspector-label {
  font-size: 11px;
  color: var(--ve-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.unifi-ports-inspector-value {
  font-size: 18px;
  font-weight: 600;
  font-family: var(--ve-font-mono);
  color: var(--ve-text-primary);
}
.unifi-ports-inspector-spacer { display: none; } /* the grid auto-spaces */
.unifi-ports-refresh-btn {
  padding: 6px 14px;
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  background: var(--ve-bg-surface);
  color: var(--ve-text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.unifi-ports-refresh-btn:hover:not(:disabled) {
  border-color: var(--ve-blue);
  background: var(--ve-bg-widget);
  color: var(--ve-text-primary);
}
.unifi-ports-refresh-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.unifi-ports-filters {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--ve-bg-surface);
  border-radius: var(--ve-radius-sm);
}
.unifi-ports-filter-input {
  flex: 1;
  min-width: 180px;
  padding: 6px 10px;
  background: var(--ve-bg-main);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  color: var(--ve-text-primary);
  font-size: 13px;
  outline: none;
}
.unifi-ports-filter-input:focus { border-color: var(--ve-blue); }
.unifi-ports-filter-select {
  padding: 6px 10px;
  background: var(--ve-bg-main);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  color: var(--ve-text-primary);
  font-size: 13px;
}
.unifi-ports-filter-toggle {
  padding: 5px 12px;
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  background: var(--ve-bg-surface);
  color: var(--ve-text-dim);
  font-size: 12px;
  cursor: pointer;
}
.unifi-ports-filter-toggle.active {
  background: var(--ve-blue);
  color: #fff;
  border-color: var(--ve-blue);
}

.unifi-ports-device-card {
  background: var(--ve-bg-widget);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-lg);
  padding: 14px 16px;
}
.unifi-ports-device-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(100, 99, 95, 0.25);
}
.unifi-ports-device-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ve-text-primary);
}
.unifi-ports-device-model {
  font-size: 11px;
  color: var(--ve-text-dim);
  font-family: var(--ve-font-mono);
}
.unifi-ports-device-badges {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.unifi-ports-device-badge {
  font-size: 11px;
  color: var(--ve-text-dim);
  background: var(--ve-bg-surface);
  padding: 3px 8px;
  border-radius: 12px;
  font-family: var(--ve-font-mono);
}

.unifi-ports-grid { display: flex; flex-direction: column; gap: 2px; }
.unifi-ports-row {
  display: grid;
  /* name | # | connected | mac | ip | activity | anomaly | power | link | actions */
  grid-template-columns: 1.4fr 32px 1.2fr 130px 110px 110px 56px 88px 64px auto;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--ve-radius-sm);
  font-size: 13px;
}
.unifi-ports-row:hover { background: rgba(255, 255, 255, 0.02); }
.unifi-ports-row-head {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--ve-text-dim);
  padding-bottom: 2px;
}
.unifi-ports-cell-idx { font-family: var(--ve-font-mono); color: var(--ve-text-dim); text-align: right; }
.unifi-ports-cell-name {
  color: var(--ve-text-primary); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: inline-flex; align-items: center; gap: 6px;
}
.unifi-ports-cell-name .name-text {
  cursor: text;
  padding: 2px 6px;
  border-radius: var(--ve-radius-sm);
  border: 1px solid transparent;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 100%;
}
.unifi-ports-cell-name .name-text:hover { border-color: var(--ve-border); background: rgba(255,255,255,0.03); }
.unifi-ports-cell-name .name-input {
  padding: 2px 6px;
  background: var(--ve-bg-main);
  border: 1px solid var(--ve-blue);
  border-radius: var(--ve-radius-sm);
  color: var(--ve-text-primary);
  font-family: inherit; font-size: 13px;
  width: 100%;
}
.unifi-ports-cell-name .name-pending {
  font-size: 10px; color: var(--ve-orange); margin-left: 4px;
}
.unifi-ports-cell-conn { color: var(--ve-text-secondary); font-family: var(--ve-font-mono); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.unifi-ports-cell-conn.is-empty { color: var(--ve-text-dim); font-style: italic; }
.unifi-ports-cell-mac, .unifi-ports-cell-ip {
  font-family: var(--ve-font-mono); font-size: 11px;
  color: var(--ve-text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.unifi-ports-cell-activity {
  font-family: var(--ve-font-mono); font-size: 11px; text-align: right;
  color: var(--ve-text-dim); line-height: 1.25;
  display: flex; flex-direction: column;
}
.unifi-ports-cell-activity .rx { color: var(--ve-text-secondary); }
.unifi-ports-cell-activity .tx { color: var(--ve-text-dim); }
.unifi-ports-cell-anomaly {
  display: flex; align-items: center; justify-content: center;
  cursor: help;
}
.unifi-ports-cell-anomaly .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: rgba(150, 149, 145, 0.30);
}
.unifi-ports-cell-anomaly.is-warn .dot { background: var(--ve-orange); }
.unifi-ports-cell-anomaly.is-err  .dot { background: var(--ve-red); }
.unifi-ports-cell-link { font-family: var(--ve-font-mono); font-size: 12px; text-align: right; color: var(--ve-text-dim); }
.unifi-ports-cell-link.up { color: var(--ve-green); }

.unifi-ports-wattage {
  display: inline-block;
  font-family: var(--ve-font-mono);
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  text-align: right;
  min-width: 60px;
}
.unifi-ports-badge-green { background: rgba(114, 184, 76, 0.18); color: var(--ve-green); }
.unifi-ports-badge-amber { background: rgba(240, 150, 46, 0.18); color: var(--ve-orange); }
.unifi-ports-badge-grey  { background: rgba(150, 149, 145, 0.18); color: var(--ve-text-dim); }
.unifi-ports-badge-red   { background: rgba(243, 92, 88, 0.20); color: var(--ve-red); }
.unifi-ports-badge-none  { color: var(--ve-text-dim); }

.unifi-ports-actions { display: inline-flex; gap: 4px; align-items: center; }
.unifi-ports-lock { font-size: 12px; margin-right: 4px; }
.unifi-ports-btn {
  padding: 4px 10px;
  border-radius: var(--ve-radius-sm);
  border: 1px solid var(--ve-border);
  background: transparent;
  color: var(--ve-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.unifi-ports-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.unifi-ports-btn-on { border-color: var(--ve-green); color: var(--ve-green); }
.unifi-ports-btn-on.is-active { background: var(--ve-green); color: #fff; }
.unifi-ports-btn-on:hover:not(:disabled) { background: rgba(114, 184, 76, 0.18); }
.unifi-ports-btn-off { border-color: var(--ve-red); color: var(--ve-red); }
.unifi-ports-btn-off.is-active { background: var(--ve-red); color: #fff; }
.unifi-ports-btn-off:hover:not(:disabled) { background: rgba(243, 92, 88, 0.18); }
.unifi-ports-btn-cycle { border-color: var(--ve-orange); color: var(--ve-orange); }
.unifi-ports-btn-cycle:hover:not(:disabled) { background: rgba(240, 150, 46, 0.18); }
.unifi-ports-btn.is-pending { opacity: 0.6; cursor: progress; }
.unifi-ports-btn.is-ok { background: var(--ve-green); color: #fff; border-color: var(--ve-green); }

/* Modal — D-OFF-CONFIRM-01 */
.unifi-ports-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.unifi-ports-modal {
  background: var(--ve-bg-surface);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-lg);
  padding: 22px;
  max-width: 420px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
.unifi-ports-modal-title { font-size: 16px; font-weight: 600; color: var(--ve-text-primary); margin-bottom: 10px; }
.unifi-ports-modal-body { font-size: 14px; color: var(--ve-text-secondary); margin-bottom: 18px; line-height: 1.45; }
.unifi-ports-modal-target { color: var(--ve-orange); font-family: var(--ve-font-mono); }
.unifi-ports-modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
.unifi-ports-modal-cancel {
  padding: 7px 16px;
  border-radius: var(--ve-radius-sm);
  border: 1px solid var(--ve-border);
  background: var(--ve-bg-main);
  color: var(--ve-text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.unifi-ports-modal-confirm {
  padding: 7px 16px;
  border-radius: var(--ve-radius-sm);
  border: 1px solid var(--ve-red);
  background: var(--ve-red);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

/* Toasts — D-TOAST-01..02 */
.unifi-ports-toasts {
  position: fixed;
  bottom: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1100;
}
.unifi-ports-toast {
  padding: 10px 16px;
  border-radius: var(--ve-radius-sm);
  font-size: 13px;
  font-family: var(--ve-font-mono);
  max-width: 380px;
  animation: unifi-ports-toast-in 0.2s ease-out;
}
.unifi-ports-toast-ok    { background: rgba(114, 184, 76, 0.22); color: var(--ve-green); }
.unifi-ports-toast-error { background: rgba(243, 92, 88, 0.22); color: var(--ve-red); }
.unifi-ports-toast-warn  { background: rgba(240, 150, 46, 0.22); color: var(--ve-orange); }
@keyframes unifi-ports-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.unifi-ports-empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--ve-text-dim);
  font-size: 14px;
}
.unifi-ports-error {
  padding: 16px;
  background: rgba(243, 92, 88, 0.10);
  border: 1px solid var(--ve-red);
  border-radius: var(--ve-radius-sm);
  color: var(--ve-red);
  font-size: 13px;
}

@media (max-width: 1200px) {
  /* Drop MAC + IP + Activity columns first — they're nice-to-have, not load-bearing. */
  .unifi-ports-row {
    grid-template-columns: 1.4fr 32px 1.2fr 56px 88px 64px auto;
  }
  .unifi-ports-cell-mac,
  .unifi-ports-cell-ip,
  .unifi-ports-cell-activity { display: none; }
}
@media (max-width: 820px) {
  /* Drop Anomaly + Link on tablet width — keep Name/#/Connected/Power/Actions. */
  .unifi-ports-row { grid-template-columns: minmax(0, 1.6fr) 28px minmax(0, 1fr) 70px auto; gap: 8px; padding: 8px 6px; }
  .unifi-ports-cell-anomaly,
  .unifi-ports-cell-link { display: none; }
}
@media (max-width: 560px) {
  /* Phone-portrait: three visual rows per port so the action buttons always
   * fit without horizontal scroll, even for protected ports (lock icon +
   * 3 buttons). Layout:
   *   line 1: name . . . . . . power
   *   line 2: connected device . . . .
   *   line 3: [   On   ][  Off  ][ Cycle ]   (full-width, equal share)
   */
  .unifi-ports-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "name    power"
      "conn    conn"
      "actions actions";
    row-gap: 4px;
    padding: 10px 8px;
    gap: 6px;
  }
  .unifi-ports-row-head { display: none; }
  .unifi-ports-cell-name  { grid-area: name; font-size: 14px; min-width: 0; }
  .unifi-ports-cell-idx   { display: none; }
  .unifi-ports-cell-conn  { grid-area: conn; font-size: 12px; min-width: 0; }
  .unifi-ports-wattage    { grid-area: power; justify-self: end; }
  .unifi-ports-actions    {
    grid-area: actions;
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 4px;
    width: 100%;
    margin-top: 2px;
  }
  .unifi-ports-actions .unifi-ports-lock { display: none; }
  .unifi-ports-btn        { padding: 6px 0; font-size: 12px; text-align: center; }
  /* Inspector + device-header chips: keep compact + wrap cleanly. */
  .unifi-ports-inspector  { padding: 10px 12px; gap: 12px; }
  .unifi-ports-inspector-stat .unifi-ports-inspector-value { font-size: 16px; }
  .unifi-ports-device-card { padding: 8px; }
  .unifi-ports-device-header { flex-wrap: wrap; gap: 6px; }
}
`;

let __cssInjected = false;
function ensureCssInjected() {
  if (__cssInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-unifi-ports-page', '');
  style.textContent = PAGE_CSS;
  document.head.appendChild(style);
  __cssInjected = true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════════════════

function StructureInspector({ status, structure, onRefresh, refreshing }) {
  const devices = structure?.devices || [];
  const deviceCount = devices.length;
  let poePortCount = 0;
  let poeOnCount = 0;
  for (const d of devices) {
    for (const p of (d.port_table || [])) {
      if (p.poe_mode !== undefined) {
        poePortCount++;
        if (p.poe_mode === 'auto') poeOnCount++;
      }
    }
  }
  const lastPoll = status?.lastPollSuccessAt || null;
  const connected = status?.connected === true;
  return html`
    <div class="unifi-ports-inspector">
      <div class="unifi-ports-inspector-stat">
        <span class="unifi-ports-inspector-label">Devices</span>
        <span class="unifi-ports-inspector-value">${deviceCount}</span>
      </div>
      <div class="unifi-ports-inspector-stat">
        <span class="unifi-ports-inspector-label">PoE Ports</span>
        <span class="unifi-ports-inspector-value">${poePortCount}</span>
      </div>
      <div class="unifi-ports-inspector-stat">
        <span class="unifi-ports-inspector-label">PoE On</span>
        <span class="unifi-ports-inspector-value">${poeOnCount}</span>
      </div>
      <div class="unifi-ports-inspector-stat">
        <span class="unifi-ports-inspector-label">Last Poll</span>
        <span class="unifi-ports-inspector-value" title=${lastPoll || ''}>${humanizeAge(lastPoll)}</span>
      </div>
      <div class="unifi-ports-inspector-stat">
        <span class="unifi-ports-inspector-label">Status</span>
        <span class="unifi-ports-inspector-value" style="display:flex;align-items:center;gap:6px;font-size:13px;">
          <${StatusDot} status=${connected ? 'connected' : 'disconnected'} />
          ${connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <div class="unifi-ports-inspector-spacer"></div>
      <button class="unifi-ports-refresh-btn" onClick=${onRefresh} disabled=${refreshing}>
        ${refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  `;
}

function PortActionButtons({ device, port, isProtected, live, pendingState, onAction }) {
  // PoE-capable signal: presence of poe_mode field (or live override).
  const effectiveMode = live?.poe_mode ?? port.poe_mode;
  const isPoeCapable = effectiveMode !== undefined && effectiveMode !== null;
  const isOnActive = effectiveMode === 'auto';
  const isOffActive = effectiveMode === 'off';

  // T-10-05 / T-10-06: clicking Off / Cycle on a protected port MUST be a
  // no-op BEFORE the publish call. Wrap each handler so even a programmatic
  // dispatchEvent (DevTools attack) cannot bypass — see handleClick below.
  const handleClick = (verb) => (e) => {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    // FLOOR: protected → no publish, ever. This is the LAYER THE USER TOUCHES.
    if (isProtected && (verb === 'off' || verb === 'cycle')) return;
    if (!isPoeCapable) return;
    onAction(device, port, verb);
  };

  const onDisabled  = !isPoeCapable;
  const offDisabled = !isPoeCapable || isProtected;
  const cycDisabled = !isPoeCapable || isProtected;

  const onPending  = pendingState === 'on:pending';
  const offPending = pendingState === 'off:pending';
  const cycPending = pendingState === 'cycle:pending';
  const okFlash    = pendingState === 'ok';

  const onClass  = `unifi-ports-btn unifi-ports-btn-on ${isOnActive ? 'is-active' : ''} ${onPending ? 'is-pending' : ''} ${okFlash ? 'is-ok' : ''}`;
  const offClass = `unifi-ports-btn unifi-ports-btn-off ${isOffActive ? 'is-active' : ''} ${offPending ? 'is-pending' : ''}`;
  const cycClass = `unifi-ports-btn unifi-ports-btn-cycle ${cycPending ? 'is-pending' : ''}`;

  const lockTitle = isProtected ? 'Controller uplink — switching disabled' : '';

  return html`
    <span class="unifi-ports-actions">
      ${isProtected && html`<span class="unifi-ports-lock" title=${lockTitle}>🔒</span>`}
      <button
        class=${onClass}
        disabled=${onDisabled}
        onClick=${handleClick('on')}
        title=${!isPoeCapable ? 'Port has no PoE hardware' : 'Turn PoE on'}
      >${onPending ? '…' : 'On'}</button>
      <button
        class=${offClass}
        disabled=${offDisabled}
        onClick=${handleClick('off')}
        title=${isProtected ? lockTitle : (!isPoeCapable ? 'Port has no PoE hardware' : 'Turn PoE off')}
      >${offPending ? '…' : 'Off'}</button>
      <button
        class=${cycClass}
        disabled=${cycDisabled}
        onClick=${handleClick('cycle')}
        title=${isProtected ? lockTitle : (!isPoeCapable ? 'Port has no PoE hardware' : 'Power-cycle PoE')}
      >${cycPending ? '…' : 'Cycle'}</button>
    </span>
  `;
}

/** Format a kbps rate for the Activity column. Compact ladder: <1 → '—',
 *  <1000 → 'X kbps', ≥1000 → 'X.X Mbps'. Never throws — returns '—' for non-numbers. */
function formatActivityRate(kbps) {
  if (typeof kbps !== 'number' || !Number.isFinite(kbps) || kbps < 1) return '—';
  if (kbps < 1000) return `${Math.round(kbps)} kbps`;
  return `${(kbps / 1000).toFixed(1)} Mbps`;
}

/** Classify a port's anomaly state from its (possibly partial) telemetry.
 *  Returns { level: 'none'|'warn'|'err', tooltip: string }. */
function deriveAnomaly(port) {
  if (!port) return { level: 'none', tooltip: '' };
  const errs = Number(port.rx_errors || 0) + Number(port.tx_errors || 0);
  const drops = Number(port.rx_dropped || 0) + Number(port.tx_dropped || 0);
  const flaps = Number(port.link_down_count || 0);
  if (errs === 0 && drops === 0 && flaps === 0) {
    return { level: 'none', tooltip: 'No errors, drops, or link flaps reported.' };
  }
  const parts = [];
  if (errs > 0) parts.push(`${errs} RX/TX errors`);
  if (drops > 0) parts.push(`${drops} dropped frames`);
  if (flaps > 0) parts.push(`${flaps} link flaps`);
  const tooltip = parts.join(' · ');
  // Errors are the most serious; drops and flaps stay yellow.
  const level = errs > 0 ? 'err' : 'warn';
  return { level, tooltip };
}

/** Inline-editable port name. Click → input; Enter or blur submits; Esc reverts.
 *  Optimistic UI: shows the new name immediately, reverts on error/timeout.
 *  `pendingRename` is a boolean for the per-port `rename:pending` slot. */
function PortNameCell({ device, port, displayedName, pendingRename, onSubmit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayedName);
  const [optimistic, setOptimistic] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      try { inputRef.current.select(); } catch { /* ignore */ }
    }
  }, [editing]);

  // When upstream port_name catches up to our optimistic value, drop the override.
  useEffect(() => {
    if (optimistic && displayedName === optimistic) setOptimistic(null);
  }, [displayedName, optimistic]);

  const shown = optimistic ?? displayedName;

  function startEdit() {
    setDraft(shown);
    setEditing(true);
  }
  async function commit() {
    const next = String(draft ?? '').trim();
    setEditing(false);
    if (next === shown || next.length === 0) {
      setDraft(shown);
      return;
    }
    setOptimistic(next);
    const ok = await onSubmit(device, port, next, (/* reason */) => {
      setOptimistic(null); // revert
    });
    if (!ok) setOptimistic(null);
  }
  function cancel() {
    setEditing(false);
    setDraft(shown);
  }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }

  if (editing) {
    return html`
      <input
        ref=${inputRef}
        class="name-input"
        type="text"
        maxLength=${32}
        value=${draft}
        onInput=${(e) => setDraft(e.target.value)}
        onBlur=${commit}
        onKeyDown=${onKey}
      />
    `;
  }
  return html`
    <span class="name-text" title=${shown} onClick=${startEdit} role="button" tabindex="0">
      ${shown}
    </span>
    ${pendingRename && html`<span class="name-pending">…</span>`}
  `;
}

function PortRow({ device, port, live, isProtected, pendingState, matchedClients, onAction, onRename }) {
  const effective = {
    poe_mode: live?.poe_mode ?? port.poe_mode,
    poe_power_w: live?.poe_power_w ?? port.poe_power_w,
    link_up: live?.link_up ?? port.link_up,
    connected_device: live?.connected_device ?? port.connected_device,
    connected_device_detail: live?.connected_device_detail ?? port.connected_device_detail,
    link_speed_mbps: live?.link_speed_mbps ?? port.link_speed_mbps,
    rx_rate_kbps: live?.rx_rate_kbps ?? port.rx_rate_kbps,
    tx_rate_kbps: live?.tx_rate_kbps ?? port.tx_rate_kbps,
    rx_errors: live?.rx_errors ?? port.rx_errors,
    tx_errors: live?.tx_errors ?? port.tx_errors,
    rx_dropped: live?.rx_dropped ?? port.rx_dropped,
    tx_dropped: live?.tx_dropped ?? port.tx_dropped,
    link_down_count: live?.link_down_count ?? port.link_down_count,
  };
  const badge = wattageBadgeClass({
    power_w: effective.poe_power_w,
    link_up: effective.link_up,
    poe_mode: effective.poe_mode,
  });
  const isPoe = effective.poe_mode !== undefined && effective.poe_mode !== null;
  const wattText = isPoe
    ? (typeof effective.poe_power_w === 'number' ? `${effective.poe_power_w.toFixed(1)} W` : '0.0 W')
    : '—';
  const linkText = effective.link_up
    ? (effective.link_speed_mbps ? `${effective.link_speed_mbps}` : 'up')
    : 'down';
  // Connected-device label: prefer the friendly names matched from the live
  // /stat/sta feed via clientsByMac (the user sees their own device names
  // exactly as they appear in the UniFi Network app + Clients tab). When the
  // controller didn't report any sta entry on this port, fall back to whatever
  // LLDP/port_table.connected_device gave us; finally em-dash.
  let conn;
  let connMac;
  let connIp;
  if (Array.isArray(matchedClients) && matchedClients.length > 0) {
    // One physical port can carry multiple wired clients (downstream switch).
    // Join names with " · " so the row stays one line; tooltip carries the
    // MAC + IP details for the curious.
    conn = matchedClients.map((c) => c.name).join(' · ');
    connMac = matchedClients.map((c) => c.mac).join(' · ');
    connIp = matchedClients.map((c) => c.ip || '—').join(' · ');
  } else {
    conn = effective.connected_device || '—';
    const detail = effective.connected_device_detail || null;
    connMac = detail?.mac || '—';
    connIp = detail?.ip || '—';
  }
  const anomaly = deriveAnomaly(effective);
  const portName = (live?.port_name ?? port.port_name) || `Port ${port.port_idx}`;
  return html`
    <div class="unifi-ports-row">
      <span class="unifi-ports-cell-name">
        <${PortNameCell}
          device=${device}
          port=${port}
          displayedName=${portName}
          pendingRename=${pendingState === 'rename:pending'}
          onSubmit=${onRename}
        />
      </span>
      <span class="unifi-ports-cell-idx">${port.port_idx}</span>
      <span class=${`unifi-ports-cell-conn ${conn === '—' ? 'is-empty' : ''}`} title=${conn}>${conn}</span>
      <span class="unifi-ports-cell-mac" title=${connMac}>${connMac}</span>
      <span class="unifi-ports-cell-ip"  title=${connIp}>${connIp}</span>
      <span class="unifi-ports-cell-activity">
        <span class="rx">↓ ${formatActivityRate(effective.rx_rate_kbps)}</span>
        <span class="tx">↑ ${formatActivityRate(effective.tx_rate_kbps)}</span>
      </span>
      <span class=${`unifi-ports-cell-anomaly is-${anomaly.level}`} title=${anomaly.tooltip}>
        <span class="dot"></span>
      </span>
      <span class=${`unifi-ports-wattage ${badge}`}>${wattText}</span>
      <span class=${`unifi-ports-cell-link ${effective.link_up ? 'up' : ''}`}>${linkText}</span>
      <${PortActionButtons}
        device=${device}
        port=${port}
        isProtected=${isProtected}
        live=${live}
        pendingState=${pendingState}
        onAction=${onAction}
      />
    </div>
  `;
}

/** Build a per-port array of friendly client info for one device's MAC. The
 *  source is the global clientsByMac map (lowercased MACs). Only wired
 *  clients with a switch_port_idx are matched. Each row holds {mac, name, ip}. */
function buildClientsOnPortForDevice(clientsByMac, deviceMac) {
  const out = new Map(); // port_idx -> Array<{mac, name, ip}>
  if (!(clientsByMac instanceof Map) || typeof deviceMac !== 'string') return out;
  const dmac = deviceMac.toLowerCase();
  for (const client of clientsByMac.values()) {
    if (!client || client.is_wired === false) continue;
    const sw = typeof client.switch_mac === 'string' ? client.switch_mac.toLowerCase() : '';
    if (sw !== dmac) continue;
    const portIdx = Number(client.switch_port_idx);
    if (!Number.isInteger(portIdx) || portIdx < 1) continue;
    const display = client.name || client.hostname || client.mac;
    const entry = { mac: client.mac, name: display, ip: client.ip || null };
    if (!out.has(portIdx)) out.set(portIdx, []);
    out.get(portIdx).push(entry);
  }
  // Stable order — alphabetical by display name so the list doesn't flicker.
  for (const arr of out.values()) arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

function DeviceCard({ device, ports, liveByKey, protectedPorts, pendingByKey, clientsByMac, onAction, onRename }) {
  const clientsOnPort = buildClientsOnPortForDevice(clientsByMac, device.mac);
  let poeCount = 0;
  let poeOnCount = 0;
  for (const p of ports) {
    if (p.poe_mode !== undefined) poeCount++;
    if (p.poe_mode === 'auto') poeOnCount++;
  }
  return html`
    <section class="unifi-ports-device-card">
      <div class="unifi-ports-device-header">
        <span class="unifi-ports-device-name">${device.name || device.mac}</span>
        ${device.model && html`<span class="unifi-ports-device-model">${device.model}</span>`}
        <div class="unifi-ports-device-badges">
          <span class="unifi-ports-device-badge">${ports.length} ports</span>
          <span class="unifi-ports-device-badge">${poeCount} PoE</span>
          <span class="unifi-ports-device-badge">${poeOnCount} on</span>
        </div>
      </div>
      <div class="unifi-ports-grid">
        <div class="unifi-ports-row unifi-ports-row-head">
          <span>Name</span>
          <span class="unifi-ports-cell-idx">#</span>
          <span>Connected</span>
          <span class="unifi-ports-cell-mac">MAC</span>
          <span class="unifi-ports-cell-ip">IP</span>
          <span class="unifi-ports-cell-activity" style="text-align:right;">Activity</span>
          <span class="unifi-ports-cell-anomaly" style="text-align:center;display:flex;justify-content:center;cursor:default;">Anom.</span>
          <span style="text-align:right;">Power</span>
          <span class="unifi-ports-cell-link" style="text-align:right;">Link</span>
          <span style="text-align:right;">Actions</span>
        </div>
        ${ports.map((p) => {
          const key = `${device.mac}:${p.port_idx}`;
          const live = liveByKey.get(key);
          const isProtected = isProtectedKey(protectedPorts, device.mac, p.port_idx);
          // Resolve a SINGLE pendingState for this row: prefer any verb in flight,
          // falling back to the ok flash.
          let pendingState = null;
          for (const verb of ['off', 'cycle', 'on', 'rename']) {
            const pk = `${key}:${verb}`;
            if (pendingByKey.has(pk)) {
              const e = pendingByKey.get(pk);
              if (e?.state === 'ok')    pendingState = 'ok';
              else if (e?.state === 'pending') { pendingState = `${verb}:pending`; break; }
            }
          }
          const matchedClients = clientsOnPort.get(p.port_idx) || null;
          return html`<${PortRow}
            key=${key}
            device=${device}
            port=${p}
            live=${live}
            isProtected=${isProtected}
            pendingState=${pendingState}
            matchedClients=${matchedClients}
            onAction=${onAction}
            onRename=${onRename}
          />`;
        })}
      </div>
    </section>
  `;
}

function OffConfirmDialog({ target, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    // Default focus on Cancel (D-OFF-CONFIRM-01).
    if (cancelRef.current && typeof cancelRef.current.focus === 'function') {
      cancelRef.current.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return html`
    <div class="unifi-ports-modal-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div class="unifi-ports-modal" role="dialog" aria-modal="true">
        <div class="unifi-ports-modal-title">Turn off PoE on port ${target.port_idx}?</div>
        <div class="unifi-ports-modal-body">
          This will cut power to <span class="unifi-ports-modal-target">${target.connected_device || 'this port'}</span>.
        </div>
        <div class="unifi-ports-modal-actions">
          <button class="unifi-ports-modal-cancel" ref=${cancelRef} onClick=${onCancel}>Cancel</button>
          <button class="unifi-ports-modal-confirm" onClick=${onConfirm}>Turn off</button>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// Top-level page
// ═══════════════════════════════════════════════════════════════════════════

export function UnifiPorts({ pluginId }) {
  ensureCssInjected();

  const [status, setStatus]       = useState(null);
  const [structure, setStructure] = useState(null);
  const [error, setError]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter]       = useState({ device: 'all', hasPoE: false, linkUp: false, poeOn: false, q: '' });
  const [offDialog, setOffDialog] = useState({ open: false, target: null });
  // liveByKey: Map<`${mac}:${port_idx}`, normalised port payload>
  const liveByKeyRef = useRef(new Map());
  const [liveTick, setLiveTick] = useState(0); // bump to force re-render after a live update
  // pendingByKey: Map<`${mac}:${port_idx}:${verb}`, { state: 'pending'|'ok', startedAt: number, timeoutId: handle }>
  const pendingByKeyRef = useRef(new Map());
  const [, setPendingTick] = useState(0);
  const [toasts, setToasts] = useState([]);
  // Wired clients indexed by (switch_mac, switch_port_idx) so each PortRow can
  // surface friendly device names even when LLDP / port_table.connected_device
  // didn't resolve. Stored by client MAC (the primary key) so a client roaming
  // to a different jack updates correctly: we remove the old (switch, port)
  // entry when the client's location changes, and an empty-payload retain-clear
  // drops the entry entirely.
  const clientsByMacRef = useRef(new Map());  // mac -> { mac, name, ip, switch_mac, switch_port_idx, ... }

  const topicPrefixRaw = status?.topicPrefix || '';
  // Normalise to trailing slash for buildCmdTopic + subscribe patterns
  const topicPrefix = useMemo(() => {
    if (!topicPrefixRaw) return '';
    return topicPrefixRaw.endsWith('/') ? topicPrefixRaw : `${topicPrefixRaw}/`;
  }, [topicPrefixRaw]);

  // ────────────────────────────────────────────────────────────────────────
  // Toast helper
  // ────────────────────────────────────────────────────────────────────────

  const showToast = useCallback((kind, text, ttlMs = 4000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, ttlMs);
  }, []);

  // ────────────────────────────────────────────────────────────────────────
  // Initial fetch + 5 s status poll
  // ────────────────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [statusRes, structRes] = await Promise.all([
        fetch(`/api/plugins/${encodeURIComponent(pluginId)}`).then(async (r) => {
          if (!r.ok) throw new Error(`status fetch ${r.status}`);
          return r.json();
        }).catch(async () => {
          // Fallback: /api/plugins (list) — older deployments may not have
          // /api/plugins/:id. Find the plugin by id.
          const list = await fetch('/api/plugins').then(r => r.json());
          return Array.isArray(list) ? list.find((p) => p.id === pluginId) : null;
        }),
        getStructureRaw(pluginId).catch((err) => ({ __err: err.message })),
      ]);
      if (statusRes) setStatus(statusRes);
      if (structRes && !structRes.__err) setStructure(structRes);
      else if (structRes?.__err) {
        // Don't blow up the whole page — structure may simply not be ready yet.
        setStructure({ devices: [] });
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [pluginId]);

  useEffect(() => {
    setLoading(true);
    loadAll();
    const interval = setInterval(() => {
      // Refresh status (and structure as a side bonus — the inspector counts
      // depend on poll-success timestamps).
      loadAll();
    }, 5000);
    return () => clearInterval(interval);
  }, [pluginId]);

  // Ensure the messages WebSocket is connected — Phase 10 onwards depended on
  // it being already open from a /messages page visit, which silently broke
  // every direct deep-link to /plugins/.../ports.
  useEffect(() => {
    connectMessagesWs();
    return () => disconnectMessagesWs();
  }, []);

  // ────────────────────────────────────────────────────────────────────────
  // /ws/messages subscription — state + result topics for this plugin
  // ────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!topicPrefix) return undefined;
    const prefix = topicPrefix.replace(/\/+$/, '');
    const patterns = [
      statePatternSlug(topicPrefix),
      resultPatternSlug(topicPrefix),
      // Without these two, every published port state + result message went
      // missing — `+` matches one level so the by-mac form never reached the
      // page. parseStateTopic only understands by-mac, so liveByKey stayed
      // empty and every pending entry timed out into the "no confirmation"
      // toast.
      statePatternByMac(topicPrefix),
      resultPatternByMac(topicPrefix),
      // Clients feed: lets us match a port to friendly device names via
      // (switch_mac, switch_port_idx). One physical port can carry multiple
      // wired clients (e.g. a desk switch downstream), so we keep an array.
      `${prefix}/clients/by-mac/+/state`,
    ];
    for (const p of patterns) subscribeTopic(p);
    return () => { for (const p of patterns) unsubscribeTopic(p); };
  }, [topicPrefix]);

  // Watch the global messages signal for matching events. Pull them off the
  // global stream by topic regex; cache the latest payload per (mac,
  // port_idx) so the UI reflects whatever the broker last published.
  //
  // We previously gated this on a "highest timestamp seen" watermark, but the
  // retained-message replay (server commit 5bbfd84) sends cached messages with
  // their ORIGINAL timestamps — which are older than any live message that
  // arrived in the same session. The watermark check would then `break` the
  // walk as soon as it saw an old retained message and silently skip every
  // remaining client/state retained payload. Replaced with a seen-id Set —
  // ws-messages-client doesn't expose ids, so we use object identity (every
  // message JSON is a fresh object). Cheap: the messages buffer is capped at
  // 500, so the Set never exceeds that.
  const seenMsgRef = useRef(new WeakSet());
  useEffect(() => {
    if (!topicPrefix) return;
    const msgList = messages.value;
    if (!Array.isArray(msgList) || msgList.length === 0) return;
    const fresh = [];
    for (const m of msgList) {
      if (!m || m.type !== 'message') continue;
      if (seenMsgRef.current.has(m)) continue;
      seenMsgRef.current.add(m);
      fresh.push(m);
    }
    if (fresh.length === 0) return;
    let liveChanged = false;
    let pendingChanged = false;
    // Process oldest→newest so the most recent live state wins over any older
    // retained copy that happened to be replayed in the same batch.
    for (const m of fresh.reverse()) {
      if (typeof m.topic !== 'string' || !m.topic.startsWith(topicPrefix)) continue;

      // Clients feed first — handled by topic shape, not parseStateTopic.
      if (m.topic.includes('/clients/by-mac/') && m.topic.endsWith('/state')) {
        let payload = m.payload;
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch { payload = null; }
        }
        // Empty-payload retain-clear → drop this client.
        if (!payload || typeof payload !== 'object') {
          // Try to extract mac from the topic so we can drop the slot.
          const macMatch = m.topic.match(/\/clients\/by-mac\/([a-z0-9-]{17})\/state$/);
          if (macMatch) {
            const mac = macMatch[1].replace(/-/g, ':');
            if (clientsByMacRef.current.delete(mac)) liveChanged = true;
          }
          continue;
        }
        if (typeof payload.mac === 'string') {
          clientsByMacRef.current.set(payload.mac.toLowerCase(), payload);
          liveChanged = true;
        }
        continue;
      }

      const parsed = parseStateTopic(m.topic);
      if (!parsed) continue;
      const key = `${parsed.mac}:${parsed.port_idx}`;
      if (parsed.kind === 'state') {
        let payload = m.payload;
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch { payload = null; }
        }
        if (payload && typeof payload === 'object') {
          liveByKeyRef.current.set(key, { ...payload, _updatedAt: Date.now() });
          liveChanged = true;
        }
      } else if (parsed.kind === 'result') {
        let payload = m.payload;
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch { payload = null; }
        }
        // Resolve any pending entry whose (mac, port_idx) matches — we don't
        // know which verb the result is for, so resolve every candidate verb
        // and show one toast based on the result body. The result envelope is
        // `{status: 'ok'|<failure>, action, ts, ...}` — success is detected by
        // status==='ok' (the older `payload.ok === true` check never matched
        // the real publish shape and silently dropped success toasts).
        for (const verb of ['off', 'cycle', 'on', 'rename']) {
          const pk = `${key}:${verb}`;
          const entry = pendingByKeyRef.current.get(pk);
          if (entry?.state === 'pending') {
            if (entry.timeoutId) clearTimeout(entry.timeoutId);
            const success = payload?.status === 'ok';
            if (success) {
              pendingByKeyRef.current.set(pk, { state: 'ok', startedAt: entry.startedAt });
              setTimeout(() => {
                pendingByKeyRef.current.delete(pk);
                setPendingTick((n) => n + 1);
              }, 2000);
              const tail = verb === 'rename' && payload?.name ? ` → "${payload.name}"` : '';
              showToast('ok', `✓ ${verb} on ${parsed.mac.slice(-5)} port ${parsed.port_idx}${tail}`);
            } else {
              pendingByKeyRef.current.delete(pk);
              const reason = payload?.reason || payload?.error || payload?.status || 'unknown error';
              showToast('error', `✗ ${verb} failed: ${reason}`, 6000);
              // Notify the rename input so it can revert its optimistic value.
              if (verb === 'rename' && entry.onError) entry.onError(reason);
            }
            pendingChanged = true;
          }
        }
      }
    }
    if (liveChanged) setLiveTick((n) => n + 1);
    if (pendingChanged) setPendingTick((n) => n + 1);
  }, [messages.value, topicPrefix, showToast]);

  // ────────────────────────────────────────────────────────────────────────
  // Refresh button — POST /structure/refresh
  // ────────────────────────────────────────────────────────────────────────

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshStructure(pluginId);
      // Re-fetch structure + status immediately so the inspector reflects the
      // new lastPollSuccessAt without waiting for the 5 s poll cycle.
      await loadAll();
    } catch (err) {
      showToast('error', `Refresh failed: ${err.message}`, 5000);
    } finally {
      setRefreshing(false);
    }
  }, [pluginId, loadAll, showToast]);

  // ────────────────────────────────────────────────────────────────────────
  // Publish path — single function for on/off/cycle.
  //
  // Defense-in-depth: re-checks protectedKeys + PoE-capable BEFORE the
  // publish call. The PortActionButtons handler short-circuits on protected
  // too; this is the second floor in case PortActionButtons logic ever
  // regresses or is bypassed via DevTools click dispatch.
  // ────────────────────────────────────────────────────────────────────────

  const protectedPorts = status?.protectedPorts || [];

  // ── Rename publish path ────────────────────────────────────────────────
  // Sends `{action: 'rename', name: <new>}` to the per-port cmd topic. The
  // plugin handles validation (length, control chars) but we mirror those
  // limits here so the caller can refuse before any MQTT round-trip.
  const publishRename = useCallback(async (device, port, newName, onError) => {
    const trimmed = String(newName ?? '').trim();
    if (trimmed.length === 0 || trimmed.length > 32) {
      showToast('error', 'Name must be 1–32 characters.', 4000);
      if (onError) onError('invalid');
      return false;
    }
    // Reject ASCII control chars before sending.
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) {
        showToast('error', 'Name contains invalid characters.', 4000);
        if (onError) onError('invalid');
        return false;
      }
    }
    if (!topicPrefix) {
      showToast('error', 'Plugin topic prefix not yet known', 4000);
      if (onError) onError('no_prefix');
      return false;
    }
    const topic = buildCmdTopic(topicPrefix, device.mac, port.port_idx);
    const payload = JSON.stringify({ action: 'rename', name: trimmed });

    const pk = `${device.mac}:${port.port_idx}:rename`;
    const startedAt = Date.now();
    const timeoutId = setTimeout(() => {
      const entry = pendingByKeyRef.current.get(pk);
      if (entry?.state === 'pending') {
        pendingByKeyRef.current.delete(pk);
        setPendingTick((n) => n + 1);
        showToast('warn', `Rename sent but no confirmation received for port ${port.port_idx}`, 6000);
        if (entry.onError) entry.onError('timeout');
      }
    }, PORT_RESULT_TIMEOUT_MS);
    pendingByKeyRef.current.set(pk, { state: 'pending', startedAt, timeoutId, onError });
    setPendingTick((n) => n + 1);

    try {
      await publishMqtt(topic, payload, { retain: false, qos: 0 });
      return true;
    } catch (err) {
      const entry = pendingByKeyRef.current.get(pk);
      if (entry?.timeoutId) clearTimeout(entry.timeoutId);
      pendingByKeyRef.current.delete(pk);
      setPendingTick((n) => n + 1);
      showToast('error', `Publish failed: ${err.message}`, 5000);
      if (onError) onError(err.message);
      return false;
    }
  }, [topicPrefix, showToast]);

  const publishCmd = useCallback(async (device, port, verb) => {
    // Re-check the protected gate AT THE PUBLISH LAYER.
    if (verb === 'off' || verb === 'cycle') {
      if (isProtectedKey(protectedPorts, device.mac, port.port_idx)) return;
    }
    // Re-check PoE capability (the buttons should already gate this, but a
    // programmatic dispatch could bypass).
    const live = liveByKeyRef.current.get(`${device.mac}:${port.port_idx}`);
    const effectiveMode = live?.poe_mode ?? port.poe_mode;
    if (effectiveMode === undefined || effectiveMode === null) return;

    if (!topicPrefix) {
      showToast('error', 'Plugin topic prefix not yet known', 4000);
      return;
    }
    const topic = buildCmdTopic(topicPrefix, device.mac, port.port_idx);
    const payload = buildCmdPayload(verb);

    const pk = `${device.mac}:${port.port_idx}:${verb}`;
    const startedAt = Date.now();
    const timeoutId = setTimeout(() => {
      // D-TOAST-02 — controller-side timeout. UniFi can queue port_overrides
      // RMW writes for 10–20 s when busy; the threshold here lives in
      // unifi-ports-logic.js → PORT_RESULT_TIMEOUT_MS (default 60s).
      const entry = pendingByKeyRef.current.get(pk);
      if (entry?.state === 'pending') {
        pendingByKeyRef.current.delete(pk);
        setPendingTick((n) => n + 1);
        showToast('warn', `Command sent but no result confirmation received (${verb} on port ${port.port_idx})`, 6000);
      }
    }, PORT_RESULT_TIMEOUT_MS);
    pendingByKeyRef.current.set(pk, { state: 'pending', startedAt, timeoutId });
    setPendingTick((n) => n + 1);

    try {
      await publishMqtt(topic, payload, { retain: false, qos: 0 });
    } catch (err) {
      // Publish failed — local error, no result topic will arrive. Resolve
      // immediately as error.
      const entry = pendingByKeyRef.current.get(pk);
      if (entry?.timeoutId) clearTimeout(entry.timeoutId);
      pendingByKeyRef.current.delete(pk);
      setPendingTick((n) => n + 1);
      showToast('error', `Publish failed: ${err.message}`, 5000);
    }
  }, [protectedPorts, topicPrefix, showToast]);

  // ────────────────────────────────────────────────────────────────────────
  // Action dispatcher — open the off-confirm modal for Off, publish
  // immediately for Cycle + On.
  // ────────────────────────────────────────────────────────────────────────

  const handleAction = useCallback((device, port, verb) => {
    if (verb === 'off') {
      // D-OFF-CONFIRM-01: open modal naming the connected device. Connected
      // device may live on the live cache (freshest) — fall back to port.
      const live = liveByKeyRef.current.get(`${device.mac}:${port.port_idx}`);
      setOffDialog({
        open: true,
        target: {
          mac: device.mac,
          port_idx: port.port_idx,
          connected_device: live?.connected_device ?? port.connected_device,
          port_name: port.port_name,
          _device: device,
          _port: port,
        },
      });
      return;
    }
    publishCmd(device, port, verb);
  }, [publishCmd]);

  const handleConfirmOff = useCallback(() => {
    const t = offDialog.target;
    setOffDialog({ open: false, target: null });
    if (!t || !t._device || !t._port) return;
    publishCmd(t._device, t._port, 'off');
  }, [offDialog, publishCmd]);

  const handleCancelOff = useCallback(() => {
    setOffDialog({ open: false, target: null });
  }, []);

  // ────────────────────────────────────────────────────────────────────────
  // Flatten + filter
  // ────────────────────────────────────────────────────────────────────────

  const devices = structure?.devices || [];
  const allPorts = useMemo(() => {
    const out = [];
    for (const d of devices) {
      for (const p of (d.port_table || [])) {
        out.push({ ...p, device: { mac: d.mac, name: d.name, nameSlug: d.nameSlug, model: d.model } });
      }
    }
    return out;
  }, [devices]);

  const filteredPorts = useMemo(() => applyFilter(allPorts, filter), [allPorts, filter, liveTick]);

  // Group filtered ports back by device for rendering.
  const filteredByDevice = useMemo(() => {
    const map = new Map();
    for (const p of filteredPorts) {
      const key = p.device.mac;
      if (!map.has(key)) map.set(key, { device: p.device, ports: [] });
      map.get(key).ports.push(p);
    }
    // Preserve original device ordering from `devices`.
    const ordered = [];
    for (const d of devices) {
      const entry = map.get(d.mac);
      if (entry && entry.ports.length > 0) ordered.push({ device: { ...d }, ports: entry.ports });
    }
    return ordered;
  }, [filteredPorts, devices]);

  const deviceOptions = useMemo(() => {
    return ['all', ...devices.map((d) => d.name || d.mac).filter(Boolean)];
  }, [devices]);

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────

  if (loading) {
    return html`<div class="page-placeholder">Loading UniFi ports…</div>`;
  }

  return html`
    <div class="unifi-ports-page">
      <div class="page-header">
        ${status?.displayName || 'UniFi'} — Ports
      </div>

      <div class="unifi-subnav">
        <a href="#/plugins/${pluginId}/ports" class="active">Ports</a>
        <a href="#/plugins/${pluginId}/wan">WAN</a>
        <a href="#/plugins/${pluginId}/clients">Clients</a>
      </div>

      ${error && html`<div class="unifi-ports-error">${error}</div>`}

      <${StructureInspector}
        status=${status}
        structure=${structure}
        onRefresh=${handleRefresh}
        refreshing=${refreshing}
      />

      <div class="unifi-ports-filters">
        <input
          type="text"
          class="unifi-ports-filter-input"
          placeholder="Search port name or connected device…"
          value=${filter.q}
          onInput=${(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
        />
        <select
          class="unifi-ports-filter-select"
          value=${filter.device}
          onChange=${(e) => setFilter((f) => ({ ...f, device: e.target.value }))}
        >
          ${deviceOptions.map((d) => html`<option key=${d} value=${d}>${d === 'all' ? 'All devices' : d}</option>`)}
        </select>
        <button
          class=${`unifi-ports-filter-toggle ${filter.hasPoE ? 'active' : ''}`}
          onClick=${() => setFilter((f) => ({ ...f, hasPoE: !f.hasPoE }))}
        >has PoE</button>
        <button
          class=${`unifi-ports-filter-toggle ${filter.linkUp ? 'active' : ''}`}
          onClick=${() => setFilter((f) => ({ ...f, linkUp: !f.linkUp }))}
        >link up</button>
        <button
          class=${`unifi-ports-filter-toggle ${filter.poeOn ? 'active' : ''}`}
          onClick=${() => setFilter((f) => ({ ...f, poeOn: !f.poeOn }))}
        >PoE on</button>
      </div>

      ${filteredByDevice.length === 0
        ? html`<div class="unifi-ports-empty">${devices.length === 0 ? 'No devices discovered yet.' : 'No ports match the current filter.'}</div>`
        : filteredByDevice.map(({ device, ports }) => html`
          <${DeviceCard}
            key=${device.mac}
            device=${device}
            ports=${ports}
            liveByKey=${liveByKeyRef.current}
            protectedPorts=${protectedPorts}
            pendingByKey=${pendingByKeyRef.current}
            clientsByMac=${clientsByMacRef.current}
            onAction=${handleAction}
            onRename=${publishRename}
          />
        `)
      }

      ${offDialog.open && html`
        <${OffConfirmDialog}
          target=${offDialog.target}
          onCancel=${handleCancelOff}
          onConfirm=${handleConfirmOff}
        />
      `}

      ${toasts.length > 0 && html`
        <div class="unifi-ports-toasts">
          ${toasts.map((t) => html`<div key=${t.id} class=${`unifi-ports-toast unifi-ports-toast-${t.kind}`}>${t.text}</div>`)}
        </div>
      `}
    </div>
  `;
}

export default UnifiPorts;
