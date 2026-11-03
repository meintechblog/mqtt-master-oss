/**
 * UniFi WAN tab — Phase 13 Plan 13-04.
 *
 * Sibling page to UnifiPorts; reachable at `#/plugins/{id}/wan` for any
 * unifi-typed plugin. Mirrors UnifiPorts' page layout (Venus-OS dark theme,
 * page-scoped CSS using `--ve-*` tokens, live data from /ws/messages).
 *
 * Card stack per D-P13-UI-02:
 *   1. Sub-nav with "Ports" / "WAN" tabs (highlighted by hash route)
 *   2. ISP card           — name, organization, ASN, public IP
 *   3. Throughput card    — RX/TX kbps + cumulative bytes (per WAN)
 *   4. Speedtest card     — last run, dl/ul/ping, "Run speedtest" button
 *                           (rate-limit aware per D-P13-UI-02)
 *   5. Failover card      — dual-WAN side-by-side (hidden when single-WAN)
 *   6. Site Health card   — wlan/wan/lan/www/vpn rollup with status dots
 *
 * Data flows:
 *   - WAN/ISP/health state via /ws/messages on `{prefix}+/wan/+/state` + site/health
 *   - Speedtest result via `{prefix}+/wan/result` (non-retained)
 *   - Speedtest trigger via /api/mqtt/publish to {prefix}by-mac/{slug}/wan/cmd
 *
 * Backwards-compat invariant: this page does NOT depend on any new server-side
 * route — every byte comes through the existing /ws/messages and
 * /api/mqtt/publish surfaces that Phase 10 already uses.
 */

import { html } from 'htm/preact';
import { useEffect, useState, useRef, useMemo, useCallback } from 'preact/hooks';
import { publishMqtt } from '../lib/api-client.js';
import { StatusDot } from '../components/status-dot.js';
import {
  messages,
  subscribeTopic,
  unsubscribeTopic,
  connectMessagesWs,
  disconnectMessagesWs,
} from '../lib/ws-messages-client.js';
import {
  formatRate,
  formatLatency,
  formatBytes,
  speedtestButtonState,
  failoverVisible,
  statusDotColor,
  buildWanCmdTopic,
} from './unifi-wan-logic.js';

const SPEEDTEST_RATE_LIMIT_MS = 5 * 60_000;

// ─── Page-scoped CSS (Venus-OS palette tokens) ─────────────────────────────

const PAGE_CSS = `
.unifi-wan-page { display: flex; flex-direction: column; gap: 16px; }
.unifi-wan-subnav {
  display: flex; gap: 4px; padding: 6px;
  background: var(--ve-bg-surface);
  border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-sm);
  width: max-content;
}
.unifi-wan-subnav a {
  padding: 6px 14px; border-radius: var(--ve-radius-sm);
  color: var(--ve-text-dim); text-decoration: none; font-size: 13px;
  border: 1px solid transparent;
}
.unifi-wan-subnav a:hover { color: var(--ve-text-primary); }
.unifi-wan-subnav a.active {
  background: var(--ve-bg-widget); color: var(--ve-text-primary);
  border-color: var(--ve-border);
}

.unifi-wan-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
@media (max-width: 560px) {
  .unifi-wan-cards { grid-template-columns: 1fr; gap: 10px; }
  .unifi-wan-failover { grid-template-columns: 1fr; }
  .unifi-wan-kv { grid-template-columns: 110px 1fr; gap: 4px 8px; font-size: 12px; }
}
.unifi-wan-card {
  background: var(--ve-bg-widget); border: 1px solid var(--ve-border);
  border-radius: var(--ve-radius-lg); padding: 16px 18px;
}
.unifi-wan-card-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--ve-text-dim); margin-bottom: 10px;
  display: flex; align-items: center; gap: 8px;
}
.unifi-wan-kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px; font-size: 13px; }
.unifi-wan-kv-label { color: var(--ve-text-dim); }
.unifi-wan-kv-value { color: var(--ve-text-primary); font-family: var(--ve-font-mono); }

.unifi-wan-rate-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 10px;
}
.unifi-wan-rate-block { text-align: center; padding: 12px; background: var(--ve-bg-surface); border-radius: var(--ve-radius-sm); }
.unifi-wan-rate-num { font-size: 22px; font-weight: 600; color: var(--ve-text-primary); font-family: var(--ve-font-mono); }
.unifi-wan-rate-label { font-size: 10px; text-transform: uppercase; color: var(--ve-text-dim); letter-spacing: 0.5px; }

.unifi-wan-st-button {
  margin-top: 12px; padding: 8px 18px;
  border: 1px solid var(--ve-orange); background: transparent; color: var(--ve-orange);
  border-radius: var(--ve-radius-sm); font-size: 13px; cursor: pointer;
  transition: background 0.12s;
}
.unifi-wan-st-button:hover:not(:disabled) { background: rgba(240, 150, 46, 0.18); }
.unifi-wan-st-button:disabled { opacity: 0.4; cursor: not-allowed; }
.unifi-wan-st-cooldown { font-size: 11px; color: var(--ve-text-dim); margin-top: 6px; font-family: var(--ve-font-mono); }

.unifi-wan-failover { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

.unifi-wan-health-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px;
}
.unifi-wan-health-chip {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: var(--ve-bg-surface); border-radius: var(--ve-radius-sm);
}
.unifi-wan-health-chip-label { font-size: 10px; text-transform: uppercase; color: var(--ve-text-dim); letter-spacing: 0.5px; }
.unifi-wan-health-chip-value { font-size: 13px; color: var(--ve-text-primary); }

.unifi-wan-empty {
  padding: 28px 16px; text-align: center;
  color: var(--ve-text-dim); font-size: 14px;
}
`;

let __wanCssInjected = false;
function ensureCssInjected() {
  if (__wanCssInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.setAttribute('data-unifi-wan-page', '');
  style.textContent = PAGE_CSS;
  document.head.appendChild(style);
  __wanCssInjected = true;
}

// ─── Topic parsing helpers ─────────────────────────────────────────────────

/** Match `{prefix}/by-mac/{slug}/wan/{1,2}/state` and pull out wanIdx. */
function parseWanTopic(topic) {
  const m = topic.match(/by-mac\/([a-z0-9-]+)\/wan\/(1|2)\/state$/);
  if (!m) return null;
  return { wanIdx: parseInt(m[2], 10) };
}

function parseIspTopic(topic) {
  return /\/by-mac\/[a-z0-9-]+\/wan\/isp\/state$/.test(topic);
}

function parseResultTopic(topic) {
  return /\/by-mac\/[a-z0-9-]+\/wan\/result$/.test(topic);
}

function parseSiteHealthTopic(topic, prefix) {
  return topic === `${prefix.replace(/\/+$/, '')}/site/health`;
}

// ─── Sub-components ────────────────────────────────────────────────────────

function IspCard({ isp, wan1 }) {
  return html`
    <div class="unifi-wan-card">
      <div class="unifi-wan-card-title">ISP / Public</div>
      <div class="unifi-wan-kv">
        <span class="unifi-wan-kv-label">ISP</span>
        <span class="unifi-wan-kv-value">${isp?.isp_name || '—'}</span>
        <span class="unifi-wan-kv-label">Organization</span>
        <span class="unifi-wan-kv-value">${isp?.isp_organization || '—'}</span>
        <span class="unifi-wan-kv-label">ASN</span>
        <span class="unifi-wan-kv-value">${isp?.asn ?? '—'}</span>
        <span class="unifi-wan-kv-label">Public IP</span>
        <span class="unifi-wan-kv-value">${isp?.public_ip || wan1?.ip || '—'}</span>
        <span class="unifi-wan-kv-label">Interface</span>
        <span class="unifi-wan-kv-value">${wan1?.interface || '—'}</span>
      </div>
    </div>
  `;
}

function ThroughputCard({ wan, label }) {
  return html`
    <div class="unifi-wan-card">
      <div class="unifi-wan-card-title">${label}</div>
      <div class="unifi-wan-rate-row">
        <div class="unifi-wan-rate-block">
          <div class="unifi-wan-rate-num">${formatRate(wan?.rx_rate_kbps)}</div>
          <div class="unifi-wan-rate-label">↓ Download</div>
        </div>
        <div class="unifi-wan-rate-block">
          <div class="unifi-wan-rate-num">${formatRate(wan?.tx_rate_kbps)}</div>
          <div class="unifi-wan-rate-label">↑ Upload</div>
        </div>
      </div>
      <div class="unifi-wan-kv" style="margin-top:12px;">
        <span class="unifi-wan-kv-label">Latency</span>
        <span class="unifi-wan-kv-value">${formatLatency(wan?.latency_ms)}</span>
        <span class="unifi-wan-kv-label">Total RX</span>
        <span class="unifi-wan-kv-value">${formatBytes(wan?.rx_bytes)}</span>
        <span class="unifi-wan-kv-label">Total TX</span>
        <span class="unifi-wan-kv-value">${formatBytes(wan?.tx_bytes)}</span>
        <span class="unifi-wan-kv-label">Speed</span>
        <span class="unifi-wan-kv-value">${wan?.link_speed_mbps ? `${wan.link_speed_mbps} Mbit/s` : '—'}</span>
      </div>
    </div>
  `;
}

function SpeedtestCard({ siteHealth, lastSpeedtestRun, onRun }) {
  const now = Date.now();
  const { enabled, cooldownLeftSec } = speedtestButtonState({
    lastRun: lastSpeedtestRun,
    rateLimitMs: SPEEDTEST_RATE_LIMIT_MS,
    now,
  });
  const www = siteHealth?.www || {};
  return html`
    <div class="unifi-wan-card">
      <div class="unifi-wan-card-title">Speedtest</div>
      <div class="unifi-wan-kv">
        <span class="unifi-wan-kv-label">Status</span>
        <span class="unifi-wan-kv-value">${www.speedtest_status || '—'}</span>
        <span class="unifi-wan-kv-label">Last Run</span>
        <span class="unifi-wan-kv-value">${www.speedtest_lastrun ? new Date(www.speedtest_lastrun * 1000).toLocaleString() : '—'}</span>
        <span class="unifi-wan-kv-label">Latency</span>
        <span class="unifi-wan-kv-value">${formatLatency(www.latency_ms)}</span>
        <span class="unifi-wan-kv-label">Uptime</span>
        <span class="unifi-wan-kv-value">${www.uptime != null ? `${www.uptime}%` : '—'}</span>
      </div>
      <button class="unifi-wan-st-button" disabled=${!enabled} onClick=${onRun}>
        ${enabled ? 'Run speedtest' : `Cooling down ${cooldownLeftSec} s`}
      </button>
      ${!enabled && html`<div class="unifi-wan-st-cooldown">Rate-limit: 1 speedtest per 5 min per gateway</div>`}
    </div>
  `;
}

function FailoverCard({ wan1, wan2 }) {
  return html`
    <div class="unifi-wan-card">
      <div class="unifi-wan-card-title">Failover (Dual WAN)</div>
      <div class="unifi-wan-failover">
        <div>
          <div class="unifi-wan-card-title" style="margin-bottom:6px;">WAN 1</div>
          <div class="unifi-wan-kv">
            <span class="unifi-wan-kv-label">Interface</span>
            <span class="unifi-wan-kv-value">${wan1?.interface || '—'}</span>
            <span class="unifi-wan-kv-label">Status</span>
            <span class="unifi-wan-kv-value" style="display:flex;gap:6px;align-items:center;">
              <${StatusDot} status=${wan1?.up ? 'connected' : 'error'} />
              ${wan1?.up ? 'Up' : 'Down'}
            </span>
            <span class="unifi-wan-kv-label">Latency</span>
            <span class="unifi-wan-kv-value">${formatLatency(wan1?.latency_ms)}</span>
            <span class="unifi-wan-kv-label">Availability</span>
            <span class="unifi-wan-kv-value">${wan1?.availability_pct != null ? `${wan1.availability_pct}%` : '—'}</span>
          </div>
        </div>
        <div>
          <div class="unifi-wan-card-title" style="margin-bottom:6px;">WAN 2</div>
          <div class="unifi-wan-kv">
            <span class="unifi-wan-kv-label">Interface</span>
            <span class="unifi-wan-kv-value">${wan2?.interface || '—'}</span>
            <span class="unifi-wan-kv-label">Status</span>
            <span class="unifi-wan-kv-value" style="display:flex;gap:6px;align-items:center;">
              <${StatusDot} status=${wan2?.up ? 'connected' : 'error'} />
              ${wan2?.up ? 'Up' : 'Down'}
            </span>
            <span class="unifi-wan-kv-label">Latency</span>
            <span class="unifi-wan-kv-value">${formatLatency(wan2?.latency_ms)}</span>
            <span class="unifi-wan-kv-label">Availability</span>
            <span class="unifi-wan-kv-value">${wan2?.availability_pct != null ? `${wan2.availability_pct}%` : '—'}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function SiteHealthCard({ siteHealth }) {
  const sections = ['wlan', 'wan', 'lan', 'www', 'vpn'];
  return html`
    <div class="unifi-wan-card">
      <div class="unifi-wan-card-title">Site Health</div>
      <div class="unifi-wan-health-grid">
        ${sections.map((key) => {
          const sub = siteHealth?.[key];
          const color = statusDotColor(sub?.status);
          return html`
            <div key=${key} class="unifi-wan-health-chip">
              <${StatusDot} status=${color} />
              <div>
                <div class="unifi-wan-health-chip-label">${key}</div>
                <div class="unifi-wan-health-chip-value">${sub?.status || '—'}</div>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

// ─── Main page ─────────────────────────────────────────────────────────────

export function UnifiWan({ pluginId }) {
  ensureCssInjected();

  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastSpeedtestRun, setLastSpeedtestRun] = useState(null);
  const [, setTick] = useState(0); // cooldown re-render

  const wanByGatewayRef = useRef(new Map()); // mac → {wan1, wan2, isp}
  const siteHealthRef = useRef(null);

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
          // Fallback for deployments without /api/plugins/:id — match the
          // Ports page so a stale server doesn't break the WAN tab.
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

  // Mount the messages WebSocket. Without this, the page receives zero MQTT
  // updates because the connection was previously only made by the Live
  // Messages page (pages/messages.js).
  useEffect(() => {
    connectMessagesWs();
    return () => disconnectMessagesWs();
  }, []);

  // ── Subscribe to WAN + ISP + result + site/health topics ──
  useEffect(() => {
    if (!topicPrefix) return undefined;
    const prefix = topicPrefix.replace(/\/+$/, '');
    const patterns = [
      `${prefix}/+/wan/+/state`,         // wan/{1,2}/state slug-form
      `${prefix}/+/wan/isp/state`,       // wan/isp/state slug-form
      `${prefix}/by-mac/+/wan/+/state`,
      `${prefix}/by-mac/+/wan/isp/state`,
      `${prefix}/by-mac/+/wan/result`,
      `${prefix}/site/health`,
    ];
    for (const p of patterns) subscribeTopic(p);
    return () => { for (const p of patterns) unsubscribeTopic(p); };
  }, [topicPrefix]);

  // ── Watch global messages signal for WAN / ISP / health / result ──
  const lastProcessedTsRef = useRef(0);
  useEffect(() => {
    if (!topicPrefix) return;
    const prefix = topicPrefix.replace(/\/+$/, '');
    const stream = messages.value;
    let changed = false;
    for (const msg of stream) {
      if (msg.ts <= lastProcessedTsRef.current) continue;
      if (!msg.topic.startsWith(`${prefix}/`)) continue;

      // by-mac WAN state.
      const wanMatch = msg.topic.match(/by-mac\/([a-z0-9-]+)\/wan\/(1|2)\/state$/);
      if (wanMatch) {
        const macSlug = wanMatch[1];
        const wanIdx = wanMatch[2];
        const mac = macSlug.replace(/-/g, ':');
        let entry = wanByGatewayRef.current.get(mac);
        if (!entry) { entry = { wan1: null, wan2: null, isp: null, mac }; wanByGatewayRef.current.set(mac, entry); }
        try { entry[`wan${wanIdx}`] = JSON.parse(msg.payload); changed = true; } catch { /* ignore */ }
      }
      // by-mac ISP state.
      const ispMatch = msg.topic.match(/by-mac\/([a-z0-9-]+)\/wan\/isp\/state$/);
      if (ispMatch) {
        const mac = ispMatch[1].replace(/-/g, ':');
        let entry = wanByGatewayRef.current.get(mac);
        if (!entry) { entry = { wan1: null, wan2: null, isp: null, mac }; wanByGatewayRef.current.set(mac, entry); }
        try { entry.isp = JSON.parse(msg.payload); changed = true; } catch { /* ignore */ }
      }
      // Site health.
      if (msg.topic === `${prefix}/site/health`) {
        try { siteHealthRef.current = JSON.parse(msg.payload); changed = true; } catch { /* ignore */ }
      }
      // Speedtest result.
      if (/by-mac\/[a-z0-9-]+\/wan\/result$/.test(msg.topic)) {
        // Update lastSpeedtestRun timestamp so cooldown begins.
        try {
          const r = JSON.parse(msg.payload);
          if (r.status === 'ok' || r.status === 'rate_limited') {
            setLastSpeedtestRun(Date.now());
          }
        } catch { /* ignore */ }
      }
      lastProcessedTsRef.current = msg.ts;
    }
    if (changed) setTick((t) => (t + 1) | 0);
  }, [messages.value, topicPrefix]);

  // ── Cooldown ticker ──
  useEffect(() => {
    if (!lastSpeedtestRun) return undefined;
    const iv = setInterval(() => setTick((t) => (t + 1) | 0), 1000);
    return () => clearInterval(iv);
  }, [lastSpeedtestRun]);

  const handleRunSpeedtest = useCallback(async () => {
    const firstGateway = Array.from(wanByGatewayRef.current.values())[0];
    if (!firstGateway) return;
    const topic = buildWanCmdTopic(topicPrefix, firstGateway.mac);
    try {
      await publishMqtt(topic, 'speedtest', { retain: false, qos: 0 });
      setLastSpeedtestRun(Date.now());
    } catch (err) {
      setError(err.message);
    }
  }, [topicPrefix]);

  // ── Render ──
  if (loading) {
    return html`<div class="page-placeholder">Loading UniFi WAN…</div>`;
  }

  const firstGateway = Array.from(wanByGatewayRef.current.values())[0];
  const wan1 = firstGateway?.wan1;
  const wan2 = firstGateway?.wan2;
  const isp = firstGateway?.isp;
  const siteHealth = siteHealthRef.current;

  return html`
    <div class="unifi-wan-page">
      <div class="page-header">
        ${status?.displayName || 'UniFi'} — WAN
      </div>

      <div class="unifi-subnav">
        <a href="#/plugins/${pluginId}/ports">Ports</a>
        <a href="#/plugins/${pluginId}/wan" class="active">WAN</a>
        <a href="#/plugins/${pluginId}/clients">Clients</a>
      </div>

      ${error && html`<div class="unifi-ports-error">${error}</div>`}

      ${!firstGateway
        ? html`<div class="unifi-wan-empty">Waiting for gateway data over MQTT… Make sure the plugin is connected.</div>`
        : html`
          <div class="unifi-wan-cards">
            <${IspCard} isp=${isp} wan1=${wan1} />
            <${ThroughputCard} wan=${wan1} label=${`WAN 1${wan1?.interface ? ` (${wan1.interface})` : ''}`} />
            <${SpeedtestCard}
              siteHealth=${siteHealth}
              lastSpeedtestRun=${lastSpeedtestRun}
              onRun=${handleRunSpeedtest}
            />
            <${SiteHealthCard} siteHealth=${siteHealth} />
          </div>

          ${failoverVisible({ wan1, wan2 }) && html`
            <${FailoverCard} wan1=${wan1} wan2=${wan2} />
          `}
        `
      }
    </div>
  `;
}

export default UnifiWan;
