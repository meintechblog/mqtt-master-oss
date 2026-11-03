/**
 * UniFi Clients tab — Phase 14 Plan 14-04.
 *
 * Sibling page to UnifiPorts / UnifiWan; reachable at `#/plugins/{id}/clients`.
 * Live presence + signal-strength + connection-detail table for every client
 * currently visible to the controller.
 *
 * Card layout per D-P14-UI-02:
 *   1. Sub-nav (Ports / WAN / Clients)
 *   2. Summary chips           total / wireless / wired / SSIDs / home / not-home
 *   3. Filter row              search + SSID + AP + wired/wireless + state + vendor
 *   4. Client table            name, MAC, IP, state-dot, connection, vendor, last_seen
 *   5. Detail drawer (modal)   on row click — full state + Copy MAC button
 *
 * Data flows:
 *   - retained per-client state via /ws/messages on `{prefix}clients/by-mac/+/state`
 *   - aggregate summary via `{prefix}clients/summary`
 *
 * Backwards-compat: no new server-side route — every byte comes through the
 * existing /ws/messages surface that Phase 10/13 already use.
 */

import { html } from 'htm/preact';
import { useEffect, useState, useRef, useMemo, useCallback } from 'preact/hooks';
import { StatusDot } from '../components/status-dot.js';
import { copyToClipboard } from '../lib/clipboard.js';
import {
  messages,
  subscribeTopic,
  unsubscribeTopic,
  connectMessagesWs,
  disconnectMessagesWs,
} from '../lib/ws-messages-client.js';
import {
  formatSignal,
  buildConnectionLabel,
  formatRelativeTime,
  extractVendor,
  summarise,
  applyClientsFilter,
  parseClientTopic,
} from './unifi-clients-logic.js';

// ─── Page-scoped CSS (Venus-OS tokens, no new globals) ─────────────────────

const PAGE_CSS = `
.unifi-clients-page { display: flex; flex-direction: column; gap: 16px; }

.unifi-clients-subnav {
  display: flex; gap: 4px; padding: 6px;
  background: var(--ve-bg-surface);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  width: max-content;
}
.unifi-clients-subnav a {
  padding: 6px 14px; border-radius: var(--ve-radius-sm);
  color: var(--ve-text-dim); text-decoration: none; font-size: 13px;
  border: 1px solid transparent;
}
.unifi-clients-subnav a:hover { color: var(--ve-text-primary); }
.unifi-clients-subnav a.active {
  background: var(--ve-bg-widget); color: var(--ve-text-primary);
  border-color: var(--ve-border);
}

.unifi-clients-summary {
  display: flex; gap: 10px; flex-wrap: wrap;
  background: var(--ve-bg-widget);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-lg);
  padding: 14px 18px;
}
.unifi-clients-chip {
  display: flex; flex-direction: column; gap: 2px;
  padding: 6px 12px;
  background: var(--ve-bg-surface);
  border-radius: var(--ve-radius-sm);
  min-width: 90px;
}
.unifi-clients-chip-label {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--ve-text-dim);
}
.unifi-clients-chip-value {
  font-size: 18px; font-weight: 600;
  color: var(--ve-text-primary); font-family: var(--ve-font-mono);
}
.unifi-clients-chip-home   .unifi-clients-chip-value { color: var(--ve-green); }
.unifi-clients-chip-away   .unifi-clients-chip-value { color: var(--ve-orange); }

.unifi-clients-filters {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--ve-bg-surface);
  border-radius: var(--ve-radius-sm);
}
.unifi-clients-filter-input {
  flex: 1; min-width: 200px;
  padding: 6px 10px;
  background: var(--ve-bg-main);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  color: var(--ve-text-primary); font-size: 13px; outline: none;
}
.unifi-clients-filter-input:focus { border-color: var(--ve-blue); }
.unifi-clients-filter-select {
  padding: 6px 10px;
  background: var(--ve-bg-main);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  color: var(--ve-text-primary); font-size: 13px;
}
.unifi-clients-toggle {
  padding: 5px 12px;
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  background: var(--ve-bg-surface);
  color: var(--ve-text-dim); font-size: 12px;
  cursor: pointer;
}
.unifi-clients-toggle.active {
  background: var(--ve-blue); color: #fff; border-color: var(--ve-blue);
}

.unifi-clients-table {
  background: var(--ve-bg-widget);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-lg);
  padding: 6px;
}
.unifi-clients-row {
  display: grid;
  grid-template-columns: 1.4fr 1.5fr 1fr 1.6fr 0.9fr 0.9fr;
  gap: 12px; align-items: center;
  padding: 8px 10px;
  border-radius: var(--ve-radius-sm);
  font-size: 13px;
  cursor: pointer;
}
.unifi-clients-row.head {
  cursor: default;
  font-size: 10px;
  color: var(--ve-text-dim);
  text-transform: uppercase; letter-spacing: 0.5px;
}
.unifi-clients-row:hover:not(.head) { background: rgba(255, 255, 255, 0.04); }
.unifi-clients-cell-name {
  display: flex; align-items: center; gap: 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.unifi-clients-cell-mac, .unifi-clients-cell-ip {
  font-family: var(--ve-font-mono); font-size: 12px; color: var(--ve-text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.unifi-clients-cell-conn {
  font-family: var(--ve-font-mono); font-size: 12px; color: var(--ve-text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.unifi-clients-cell-vendor {
  color: var(--ve-text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.unifi-clients-cell-last-seen {
  font-family: var(--ve-font-mono); font-size: 12px; color: var(--ve-text-dim);
  text-align: right;
}

.unifi-clients-empty {
  padding: 28px 16px; text-align: center;
  color: var(--ve-text-dim); font-size: 14px;
}

/* Responsive: collapse table on narrower viewports. Drop the least-essential
 * columns first (vendor, last-seen) at tablet width, then collapse to a
 * card-style two-line row on phone. */
@media (max-width: 900px) {
  .unifi-clients-row { grid-template-columns: 1.6fr 1.4fr 1fr 1.8fr; gap: 8px; }
  .unifi-clients-cell-vendor,
  .unifi-clients-cell-last-seen { display: none; }
}
@media (max-width: 560px) {
  .unifi-clients-row {
    grid-template-columns: 1fr;
    row-gap: 2px;
    padding: 10px 10px;
  }
  .unifi-clients-row.head { display: none; }
  .unifi-clients-cell-mac, .unifi-clients-cell-ip { font-size: 11px; }
  .unifi-clients-cell-name { font-size: 14px; font-weight: 500; }
  .unifi-clients-filters { gap: 6px; padding: 8px 10px; }
  .unifi-clients-summary { gap: 6px; padding: 10px; }
  .unifi-clients-chip { min-width: 70px; padding: 4px 8px; }
  .unifi-clients-chip-value { font-size: 16px; }
}

/* Detail drawer (modal) */
.unifi-clients-drawer-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.65); z-index: 1000;
  display: flex; align-items: center; justify-content: center;
}
.unifi-clients-drawer {
  background: var(--ve-bg-surface);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-lg);
  padding: 22px;
  width: 540px; max-width: 92%;
  max-height: 80vh; overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
.unifi-clients-drawer-title {
  font-size: 16px; font-weight: 600; color: var(--ve-text-primary);
  margin-bottom: 12px;
  display: flex; align-items: center; gap: 10px;
}
.unifi-clients-drawer-kv {
  display: grid; grid-template-columns: 140px 1fr;
  gap: 6px 14px; font-size: 13px;
}
.unifi-clients-drawer-label { color: var(--ve-text-dim); }
.unifi-clients-drawer-value {
  color: var(--ve-text-primary); font-family: var(--ve-font-mono);
  word-break: break-all;
}
.unifi-clients-drawer-actions {
  display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px;
}
.unifi-clients-drawer-btn {
  padding: 7px 16px;
  border-radius: var(--ve-radius-sm);
  border: 1px solid var(--ve-border);
  background: var(--ve-bg-main);
  color: var(--ve-text-secondary);
  font-size: 13px; cursor: pointer;
}
.unifi-clients-drawer-btn:hover {
  border-color: var(--ve-blue); color: var(--ve-text-primary);
}
.unifi-clients-drawer-btn.primary {
  border-color: var(--ve-blue); background: var(--ve-blue); color: #fff;
}
`;

let __clientsCssInjected = false;
function ensureCssInjected() {
  if (__clientsCssInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-unifi-clients-page', '');
  style.textContent = PAGE_CSS;
  document.head.appendChild(style);
  __clientsCssInjected = true;
}

// ─── Sub-components ────────────────────────────────────────────────────────

function SummaryCard({ summary }) {
  return html`
    <div class="unifi-clients-summary">
      <div class="unifi-clients-chip">
        <span class="unifi-clients-chip-label">Total</span>
        <span class="unifi-clients-chip-value">${summary.total}</span>
      </div>
      <div class="unifi-clients-chip">
        <span class="unifi-clients-chip-label">Wireless</span>
        <span class="unifi-clients-chip-value">${summary.wireless}</span>
      </div>
      <div class="unifi-clients-chip">
        <span class="unifi-clients-chip-label">Wired</span>
        <span class="unifi-clients-chip-value">${summary.wired}</span>
      </div>
      <div class="unifi-clients-chip">
        <span class="unifi-clients-chip-label">SSIDs</span>
        <span class="unifi-clients-chip-value">${summary.ssids.length}</span>
      </div>
      <div class="unifi-clients-chip unifi-clients-chip-home">
        <span class="unifi-clients-chip-label">Home</span>
        <span class="unifi-clients-chip-value">${summary.home}</span>
      </div>
      <div class="unifi-clients-chip unifi-clients-chip-away">
        <span class="unifi-clients-chip-label">Not Home</span>
        <span class="unifi-clients-chip-value">${summary.not_home}</span>
      </div>
    </div>
  `;
}

function ClientRow({ client, onClick, now }) {
  const sig = formatSignal(client.signal_dbm);
  const dotStatus = client.state === 'home'
    ? (client.is_wired ? 'connected' : sig.dot)
    : 'error';
  return html`
    <div class="unifi-clients-row" onClick=${() => onClick(client)}>
      <span class="unifi-clients-cell-name">
        <${StatusDot} status=${dotStatus} />
        ${client.name || client.hostname || client.mac}
      </span>
      <span class="unifi-clients-cell-mac">${client.mac}</span>
      <span class="unifi-clients-cell-ip">${client.ip || '—'}</span>
      <span class="unifi-clients-cell-conn">${buildConnectionLabel(client)}</span>
      <span class="unifi-clients-cell-vendor">${extractVendor(client)}</span>
      <span class="unifi-clients-cell-last-seen">${formatRelativeTime(client.last_seen, now)}</span>
    </div>
  `;
}

function ClientDetailDrawer({ client, onClose }) {
  const copyMac = useCallback(() => {
    copyToClipboard(client.mac);
  }, [client.mac]);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return html`
    <div class="unifi-clients-drawer-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="unifi-clients-drawer" role="dialog" aria-modal="true">
        <div class="unifi-clients-drawer-title">
          <${StatusDot} status=${client.state === 'home' ? 'connected' : 'error'} />
          ${client.name || client.hostname || client.mac}
        </div>
        <div class="unifi-clients-drawer-kv">
          <span class="unifi-clients-drawer-label">MAC</span>
          <span class="unifi-clients-drawer-value">${client.mac}</span>
          <span class="unifi-clients-drawer-label">IP</span>
          <span class="unifi-clients-drawer-value">${client.ip || '—'}</span>
          <span class="unifi-clients-drawer-label">State</span>
          <span class="unifi-clients-drawer-value">${client.state}</span>
          <span class="unifi-clients-drawer-label">Connection</span>
          <span class="unifi-clients-drawer-value">${buildConnectionLabel(client)}</span>
          ${!client.is_wired && html`
            <span class="unifi-clients-drawer-label">SSID</span>
            <span class="unifi-clients-drawer-value">${client.essid || '—'}</span>
            <span class="unifi-clients-drawer-label">SSID Security</span>
            <span class="unifi-clients-drawer-value">${client.ssid_security || '—'}</span>
            <span class="unifi-clients-drawer-label">AP</span>
            <span class="unifi-clients-drawer-value">${client.ap_name || client.ap_mac || '—'}</span>
            <span class="unifi-clients-drawer-label">Channel</span>
            <span class="unifi-clients-drawer-value">${client.channel ?? '—'}</span>
            <span class="unifi-clients-drawer-label">Signal</span>
            <span class="unifi-clients-drawer-value">${client.signal_dbm != null ? `${client.signal_dbm} dBm (${formatSignal(client.signal_dbm).label})` : '—'}</span>
            <span class="unifi-clients-drawer-label">Radio</span>
            <span class="unifi-clients-drawer-value">${client.radio_proto || '—'}</span>
            <span class="unifi-clients-drawer-label">TX / RX</span>
            <span class="unifi-clients-drawer-value">${client.tx_rate_kbps ?? '—'} / ${client.rx_rate_kbps ?? '—'} kbps</span>
          `}
          ${client.is_wired && html`
            <span class="unifi-clients-drawer-label">Switch</span>
            <span class="unifi-clients-drawer-value">${client.switch_name || client.switch_mac || '—'}</span>
            <span class="unifi-clients-drawer-label">Port</span>
            <span class="unifi-clients-drawer-value">${client.switch_port_idx ?? '—'}</span>
          `}
          <span class="unifi-clients-drawer-label">VLAN</span>
          <span class="unifi-clients-drawer-value">${client.vlan ?? '—'}</span>
          <span class="unifi-clients-drawer-label">Network</span>
          <span class="unifi-clients-drawer-value">${client.network_name || '—'}</span>
          <span class="unifi-clients-drawer-label">Vendor</span>
          <span class="unifi-clients-drawer-value">${extractVendor(client)}</span>
          <span class="unifi-clients-drawer-label">OS / Family</span>
          <span class="unifi-clients-drawer-value">${client.os_name || client.dev_family || '—'}</span>
          <span class="unifi-clients-drawer-label">Uptime</span>
          <span class="unifi-clients-drawer-value">${client.uptime_sec != null ? `${client.uptime_sec} s` : '—'}</span>
          <span class="unifi-clients-drawer-label">Last Seen</span>
          <span class="unifi-clients-drawer-value">${client.last_seen || '—'}</span>
          <span class="unifi-clients-drawer-label">First Seen</span>
          <span class="unifi-clients-drawer-value">${client.first_seen || '—'}</span>
          ${client.note && html`
            <span class="unifi-clients-drawer-label">Note</span>
            <span class="unifi-clients-drawer-value">${client.note}</span>
          `}
        </div>
        <div class="unifi-clients-drawer-actions">
          <button class="unifi-clients-drawer-btn" onClick=${copyMac}>Copy MAC</button>
          <button class="unifi-clients-drawer-btn primary" onClick=${onClose}>Close</button>
        </div>
      </div>
    </div>
  `;
}

// ─── Top-level page ────────────────────────────────────────────────────────

export function UnifiClients({ pluginId }) {
  ensureCssInjected();

  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ q: '', ssid: 'all', ap: 'all', wirelessOnly: false, wiredOnly: false, state: 'all', vendor: 'all' });
  const [drawerClient, setDrawerClient] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());

  /** Map<mac, ClientState> — live cache built from /ws/messages. */
  const clientsRef = useRef(new Map());
  const [, setTick] = useState(0);

  const topicPrefixRaw = status?.topicPrefix || '';
  const topicPrefix = useMemo(() => {
    if (!topicPrefixRaw) return '';
    return topicPrefixRaw.endsWith('/') ? topicPrefixRaw : `${topicPrefixRaw}/`;
  }, [topicPrefixRaw]);

  // ── 5 s status poll ──
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let data = null;
        try {
          const r = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}`);
          if (r.ok) {
            const ct = r.headers.get('content-type') || '';
            if (ct.includes('application/json')) data = await r.json();
          }
        } catch { /* fall through to list endpoint */ }
        if (!data) {
          const list = await fetch('/api/plugins').then((r) => r.json());
          data = Array.isArray(list) ? list.find((p) => p.id === pluginId) : null;
        }
        if (!data) throw new Error(`Plugin '${pluginId}' not found`);
        if (!cancelled) { setStatus(data); setError(null); }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [pluginId]);

  // Mount the messages WebSocket — without this the page has no MQTT feed
  // and stays on its "No clients yet" empty state forever, even though the
  // broker has all the retained client states.
  useEffect(() => {
    connectMessagesWs();
    return () => disconnectMessagesWs();
  }, []);

  // ── Subscribe to client state + summary topics ──
  useEffect(() => {
    if (!topicPrefix) return undefined;
    const prefix = topicPrefix.replace(/\/+$/, '');
    const patterns = [
      `${prefix}/clients/by-mac/+/state`,
      `${prefix}/clients/summary`,
    ];
    for (const p of patterns) subscribeTopic(p);
    return () => { for (const p of patterns) unsubscribeTopic(p); };
  }, [topicPrefix]);

  // ── Watch /ws/messages stream for client state ──
  // Use a WeakSet of seen message objects rather than a timestamp watermark:
  // the WS server replays cached retained messages with their ORIGINAL
  // timestamps, which are older than any live message in the same session.
  // A watermark would have those retained messages silently skipped (their
  // `ts` is undefined since the server sends `timestamp` not `ts`, but even
  // a correct watermark would break on the older-than-watermark replay).
  const seenMsgRef = useRef(new WeakSet());
  useEffect(() => {
    if (!topicPrefix) return;
    const prefix = topicPrefix.replace(/\/+$/, '');
    const stream = messages.value;
    let changed = false;
    for (const msg of stream) {
      if (seenMsgRef.current.has(msg)) continue;
      seenMsgRef.current.add(msg);
      if (!msg.topic || !msg.topic.startsWith(`${prefix}/`)) continue;
      if (msg.topic.includes('/clients/by-mac/') && msg.topic.endsWith('/state')) {
        const mac = parseClientTopic(msg.topic);
        if (!mac) continue;
        // Empty payload → retain-clear; drop the client.
        if (!msg.payload || msg.payload.length === 0) {
          if (clientsRef.current.has(mac)) {
            clientsRef.current.delete(mac);
            changed = true;
          }
        } else {
          try {
            const payload = JSON.parse(msg.payload);
            clientsRef.current.set(mac, payload);
            changed = true;
          } catch { /* ignore malformed payload */ }
        }
      }
    }
    if (changed) setTick((t) => (t + 1) | 0);
  }, [messages.value, topicPrefix]);

  // ── Re-render every 10s so "last seen" times stay fresh ──
  useEffect(() => {
    const iv = setInterval(() => setNowTick(Date.now()), 10_000);
    return () => clearInterval(iv);
  }, []);

  // ── Render ──
  const clientsList = Array.from(clientsRef.current.values());
  const summary = useMemo(() => summarise(clientsList), [clientsList]);
  const filtered = useMemo(() => applyClientsFilter(clientsList, filter), [clientsList, filter]);

  // Order: home first, then by name.
  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      const sA = a.state === 'home' ? 0 : 1;
      const sB = b.state === 'home' ? 0 : 1;
      if (sA !== sB) return sA - sB;
      const nA = (a.name || a.hostname || a.mac || '').toLowerCase();
      const nB = (b.name || b.hostname || b.mac || '').toLowerCase();
      return nA.localeCompare(nB);
    });
    return out;
  }, [filtered]);

  if (loading) {
    return html`<div class="page-placeholder">Loading UniFi clients…</div>`;
  }

  return html`
    <div class="unifi-clients-page">
      <div class="page-header">
        ${status?.displayName || 'UniFi'} — Clients
      </div>

      <div class="unifi-subnav">
        <a href="#/plugins/${pluginId}/ports">Ports</a>
        <a href="#/plugins/${pluginId}/wan">WAN</a>
        <a href="#/plugins/${pluginId}/clients" class="active">Clients</a>
      </div>

      ${error && html`<div class="unifi-ports-error">${error}</div>`}

      <${SummaryCard} summary=${summary} />

      <div class="unifi-clients-filters">
        <input
          type="text"
          class="unifi-clients-filter-input"
          placeholder="Search name / hostname / MAC / IP…"
          value=${filter.q}
          onInput=${(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
        />
        <select
          class="unifi-clients-filter-select"
          value=${filter.ssid}
          onChange=${(e) => setFilter((f) => ({ ...f, ssid: e.target.value }))}
        >
          <option value="all">All SSIDs</option>
          ${summary.ssids.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
        </select>
        <select
          class="unifi-clients-filter-select"
          value=${filter.ap}
          onChange=${(e) => setFilter((f) => ({ ...f, ap: e.target.value }))}
        >
          <option value="all">All APs</option>
          ${summary.aps.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
        </select>
        <select
          class="unifi-clients-filter-select"
          value=${filter.state}
          onChange=${(e) => setFilter((f) => ({ ...f, state: e.target.value }))}
        >
          <option value="all">Home + Away</option>
          <option value="home">Home only</option>
          <option value="not_home">Not home only</option>
        </select>
        <select
          class="unifi-clients-filter-select"
          value=${filter.vendor}
          onChange=${(e) => setFilter((f) => ({ ...f, vendor: e.target.value }))}
        >
          <option value="all">All vendors</option>
          ${summary.vendors.map((v) => html`<option key=${v} value=${v}>${v}</option>`)}
        </select>
        <button
          class=${`unifi-clients-toggle ${filter.wirelessOnly ? 'active' : ''}`}
          onClick=${() => setFilter((f) => ({ ...f, wirelessOnly: !f.wirelessOnly, wiredOnly: false }))}
        >wireless only</button>
        <button
          class=${`unifi-clients-toggle ${filter.wiredOnly ? 'active' : ''}`}
          onClick=${() => setFilter((f) => ({ ...f, wiredOnly: !f.wiredOnly, wirelessOnly: false }))}
        >wired only</button>
      </div>

      <div class="unifi-clients-table">
        <div class="unifi-clients-row head">
          <span>Name</span>
          <span>MAC</span>
          <span>IP</span>
          <span>Connection</span>
          <span>Vendor</span>
          <span style="text-align:right;">Last seen</span>
        </div>
        ${sorted.length === 0
          ? html`<div class="unifi-clients-empty">${clientsList.length === 0
              ? 'No clients yet — waiting for the controller poll…'
              : 'No clients match the current filter.'}</div>`
          : sorted.map((c) => html`
              <${ClientRow}
                key=${c.mac}
                client=${c}
                now=${nowTick}
                onClick=${(cl) => setDrawerClient(cl)}
              />
            `)
        }
      </div>

      ${drawerClient && html`
        <${ClientDetailDrawer}
          client=${drawerClient}
          onClose=${() => setDrawerClient(null)}
        />
      `}
    </div>
  `;
}

export default UnifiClients;
