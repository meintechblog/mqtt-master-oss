import { html } from 'htm/preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import { dashboardState, brokerConnected } from '../lib/ws-client.js';
import { fetchPlugins, fetchSystemInfo, fetchUpdateStatus, triggerUpdateCheck } from '../lib/api-client.js';
import { StatusDot } from '../components/status-dot.js';
import { fmtRate, fmtTotal, fmtUptime } from '../lib/format.js';
import { copyToClipboard } from '../lib/clipboard.js';

const MAX_SPARKLINE_POINTS = 60;

function stripVersion(v) {
  return v ? v.replace(/^mosquitto version\s*/i, '') : '--';
}

/**
 * Pick the host string a user should use to reach this server from another
 * machine. Prefer the address they already typed in the browser (works for
 * both `mqtt-master.local` and bare IPs); fall back to the first LAN IP
 * reported by the server when the page is opened via `localhost`.
 */
function preferredHost(info) {
  const browserHost = window.location.hostname;
  const isLocal = !browserHost
    || browserHost === 'localhost'
    || browserHost === '127.0.0.1'
    || browserHost === '::1';
  if (!isLocal) return browserHost;
  const lan = info?.lanIps?.[0]?.address;
  return lan || info?.hostname || browserHost || 'localhost';
}

function CopyValue({ text, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e) => {
    e.preventDefault();
    if (!text) return;
    copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return html`
    <button
      class="dash-conn-copy"
      type="button"
      onClick=${handleCopy}
      title=${label ? `Copy ${label}` : 'Copy'}
    >
      <span class="dash-conn-copy-text">${text || '--'}</span>
      <span class="dash-conn-copy-icon">${copied ? '✓' : '⧉'}</span>
    </button>
  `;
}

function ConnectionCard({ info }) {
  const host = preferredHost(info);
  const webPort = info?.web?.port ?? 80;
  const dashboardUrl = webPort === 80 ? `http://${host}` : `http://${host}:${webPort}`;
  const mqttPort = info?.mqtt?.port ?? 1883;
  const mqttScheme = info?.mqtt?.protocol === 'mqtts' ? 'mqtts' : 'mqtt';
  const mqttUrl = `${mqttScheme}://${host}:${mqttPort}`;
  const wsPort = info?.mqtt?.websocketPort ?? 9001;
  const wsUrl = `ws://${host}:${wsPort}`;
  const friendlyName = info?.hostname || host;
  const lanList = (info?.lanIps || []).map(i => i.address).join(', ');

  return html`
    <div class="dash-card">
      <div class="dash-card-title">
        <${StatusDot} status="connected" />
        Verbindungs-Info
      </div>
      <div class="dash-conn-grid">
        <div class="dash-conn-row">
          <span class="dash-conn-label">Hostname</span>
          <${CopyValue} text=${friendlyName} label="hostname" />
        </div>
        <div class="dash-conn-row">
          <span class="dash-conn-label">Dashboard</span>
          <${CopyValue} text=${dashboardUrl} label="dashboard URL" />
        </div>
        <div class="dash-conn-row">
          <span class="dash-conn-label">MQTT-Broker</span>
          <${CopyValue} text=${mqttUrl} label="broker URL" />
        </div>
        <div class="dash-conn-row">
          <span class="dash-conn-label">MQTT WebSocket</span>
          <${CopyValue} text=${wsUrl} label="WebSocket URL" />
        </div>
        ${lanList && html`
          <div class="dash-conn-row">
            <span class="dash-conn-label">LAN-IPs</span>
            <${CopyValue} text=${lanList} label="LAN IPs" />
          </div>
        `}
        ${info?.topicPrefix && html`
          <div class="dash-conn-row">
            <span class="dash-conn-label">Topic-Prefix</span>
            <${CopyValue} text=${info.topicPrefix} label="topic prefix" />
          </div>
        `}
      </div>
      <div class="dash-conn-hint">
        Diese Adressen erreichen MQTT Master und den lokalen Mosquitto-Broker aus dem LAN.
        Anonymer Zugriff ist auf Port 1883 (MQTT) und 9001 (WebSocket) konfiguriert.
      </div>
    </div>
  `;
}

function fmtRelativeTime(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function UpdateCard() {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    try { setStatus(await fetchUpdateStatus()); }
    catch (err) { setError(err.message); }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  async function handleCheck() {
    setChecking(true); setError(null);
    try { await triggerUpdateCheck(); await refresh(); }
    catch (err) { setError(err.message); }
    finally { setChecking(false); }
  }
  if (!status) return html`
    <div class="dash-card">
      <div class="dash-card-title"><${StatusDot} status="stopped" /> Update</div>
      <div style="font-size:13px;color:var(--ve-text-dim);">Loading...</div>
    </div>
  `;

  const v = status.current || {};
  const installing = status.runState?.updateStatus === 'installing';
  const rolledBack = status.runState?.rollbackHappened;
  // dev_mode = no .git checkout (e.g. rsync-deployed dev VM). Treat it as a
  // neutral info, not a real error: the auto-update path is intentionally
  // disabled, GitHub is never contacted, nothing actually broke.
  const isDevMode = status.lastError === 'dev_mode' || v.isDev;
  const realError = status.lastError && !isDevMode;
  const dotStatus = installing ? 'stopped' : (status.hasUpdate ? 'error' : (realError ? 'error' : (isDevMode ? 'stopped' : 'connected')));

  return html`
    <div class="dash-card">
      <div class="dash-card-title">
        <${StatusDot} status=${dotStatus} />
        Update
      </div>
      <div class="dash-detail-grid">
        <div class="dash-detail">
          <span class="dash-detail-label">Running</span>
          <span class="dash-detail-value">${v.version || 'dev'}</span>
        </div>
        <div class="dash-detail">
          <span class="dash-detail-label">Last check</span>
          <span class="dash-detail-value">${fmtRelativeTime(status.lastCheckedAt)}</span>
        </div>
        ${status.hasUpdate && html`
          <div class="dash-detail" style="grid-column:span 2;">
            <span class="dash-detail-label">Available</span>
            <span class="dash-detail-value" style="color:var(--ve-orange);">
              ${status.latestSha ? status.latestSha.slice(0, 7) : ''} ${status.latestCommitMessage ? '· ' + status.latestCommitMessage : ''}
            </span>
          </div>
        `}
        ${rolledBack && html`
          <div class="dash-detail" style="grid-column:span 2;">
            <span class="dash-detail-label">Last result</span>
            <span class="dash-detail-value" style="color:var(--ve-red);">
              rolled back: ${status.runState.rollbackReason || 'unknown'}
            </span>
          </div>
        `}
        ${isDevMode && !status.hasUpdate && html`
          <div class="dash-detail" style="grid-column:span 2;">
            <span class="dash-detail-label">Mode</span>
            <span class="dash-detail-value" style="color:var(--ve-text-dim);" title="No .git checkout in /opt/mqtt-master — auto-update is intentionally disabled. Re-run install.sh to enable.">
              dev mode (auto-update off)
            </span>
          </div>
        `}
        ${realError && !status.hasUpdate && html`
          <div class="dash-detail" style="grid-column:span 2;">
            <span class="dash-detail-label">Last error</span>
            <span class="dash-detail-value" style="color:var(--ve-red);">${status.lastError}</span>
          </div>
        `}
        ${!rolledBack && status.runState?.lastUpdatedAt && html`
          <div class="dash-detail" style="grid-column:span 2;">
            <span class="dash-detail-label">Last update</span>
            <span class="dash-detail-value" style="color:var(--ve-green);">
              ${v.shortSha || ''} · ${fmtRelativeTime(new Date(status.runState.lastUpdatedAt).toISOString())}
            </span>
          </div>
        `}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap;">
        <button class="msg-btn msg-btn--clear" onClick=${handleCheck} disabled=${checking}>
          ${checking ? 'Checking...' : 'Check now'}
        </button>
        <span style="font-size:12px;color:var(--ve-text-dim);margin-left:auto;">
          Manual deploy only
        </span>
      </div>
      ${error && html`<div style="margin-top:8px;font-size:12px;color:var(--ve-red);">${error}</div>`}
    </div>
  `;
}

function pluginDotStatus(p) {
  if (p.status === 'error') return 'error';
  if (p.status === 'running' && p.connected === false) return 'error';
  if (p.status === 'running') return 'connected';
  return 'stopped';
}

/** SVG sparkline from an array of values */
function Sparkline({ data, color = 'var(--ve-blue)', height = 32, width = 120 }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${height - ((v - min) / range) * (height - 4) - 2}`).join(' ');
  const lastY = height - ((data[data.length - 1] - min) / range) * (height - 4) - 2;

  return html`
    <svg class="dash-sparkline" width=${width} height=${height} viewBox="0 0 ${width} ${height}">
      <polyline points=${points} fill="none" stroke=${color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx=${width} cy=${lastY} r="2.5" fill=${color} class="dash-spark-dot" />
    </svg>
  `;
}

/** Live activity bar - shows pulses based on message rate */
function ActivityBar({ rateIn, rateOut }) {
  const inRate = parseFloat(rateIn) / 60 || 0;
  const outRate = parseFloat(rateOut) / 60 || 0;
  const maxRate = Math.max(inRate, outRate, 1);
  const inPct = Math.min((inRate / maxRate) * 100, 100);
  const outPct = Math.min((outRate / maxRate) * 100, 100);

  return html`
    <div class="dash-activity">
      <div class="dash-activity-row">
        <span class="dash-activity-label">IN</span>
        <div class="dash-activity-track">
          <div class="dash-activity-fill dash-activity-fill--in" style="width:${inPct}%"></div>
        </div>
        <span class="dash-activity-rate">${fmtRate(rateIn)}/s</span>
      </div>
      <div class="dash-activity-row">
        <span class="dash-activity-label">OUT</span>
        <div class="dash-activity-track">
          <div class="dash-activity-fill dash-activity-fill--out" style="width:${outPct}%"></div>
        </div>
        <span class="dash-activity-rate">${fmtRate(rateOut)}/s</span>
      </div>
    </div>
  `;
}

export function Dashboard() {
  const [plugins, setPlugins] = useState([]);
  const [systemInfo, setSystemInfo] = useState(null);
  const rateHistory = useRef({ in: [], out: [] });
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    fetchPlugins().then(setPlugins).catch(() => {});
    fetchSystemInfo().then(setSystemInfo).catch(() => {});
    const pluginInterval = setInterval(() => {
      fetchPlugins().then(setPlugins).catch(() => {});
    }, 5000);

    // Track rate history for sparklines
    const historyInterval = setInterval(() => {
      const d = dashboardState.value.data || {};
      const inRate = parseFloat(d.load_received_1min) / 60 || 0;
      const outRate = parseFloat(d.load_sent_1min) / 60 || 0;
      const h = rateHistory.current;
      h.in = [...h.in, inRate].slice(-MAX_SPARKLINE_POINTS);
      h.out = [...h.out, outRate].slice(-MAX_SPARKLINE_POINTS);
      setHistoryVersion(v => v + 1);
    }, 2000);

    return () => { clearInterval(pluginInterval); clearInterval(historyInterval); };
  }, []);

  const d = dashboardState.value.data || {};
  const connected = brokerConnected.value;
  const h = rateHistory.current;

  return html`
    <div>
      <h1 class="page-header">Dashboard</h1>

      <!-- Hero: rate cards with sparklines -->
      <div class="dash-hero">
        <div class="dash-hero-card dash-hero-card--accent">
          <div class="dash-hero-top">
            <div>
              <div class="dash-hero-value">${fmtRate(d.load_received_1min)}</div>
              <div class="dash-hero-unit">msg/s</div>
            </div>
            <${Sparkline} data=${h.in} color="var(--ve-blue)" />
          </div>
          <div class="dash-hero-label">Receive Rate</div>
          ${connected && html`<div class="dash-hero-glow"></div>`}
        </div>
        <div class="dash-hero-card">
          <div class="dash-hero-top">
            <div>
              <div class="dash-hero-value">${fmtRate(d.load_sent_1min)}</div>
              <div class="dash-hero-unit">msg/s</div>
            </div>
            <${Sparkline} data=${h.out} color="var(--ve-green)" />
          </div>
          <div class="dash-hero-label">Send Rate</div>
        </div>
        <div class="dash-hero-card">
          <div class="dash-hero-value">${d.clients_connected ?? '--'}</div>
          <div class="dash-hero-label">Clients</div>
        </div>
        <div class="dash-hero-card">
          <div class="dash-hero-value">${fmtUptime(d.uptime)}</div>
          <div class="dash-hero-label">Uptime</div>
        </div>
      </div>

      <!-- Activity bar -->
      <${ActivityBar} rateIn=${d.load_received_1min} rateOut=${d.load_sent_1min} />

      <!-- Connection info + auto-update side-by-side -->
      <div class="dash-row2">
        <${ConnectionCard} info=${systemInfo} />
        <${UpdateCard} />
      </div>

      <div class="dash-row2">
        <!-- Broker -->
        <div class="dash-card">
          <div class="dash-card-title">
            <${StatusDot} status=${connected ? 'connected' : 'disconnected'} />
            Lokaler Broker
          </div>
          <div class="dash-detail-grid">
            <div class="dash-detail">
              <span class="dash-detail-label">Version</span>
              <span class="dash-detail-value">${stripVersion(d.version)}</span>
            </div>
            <div class="dash-detail">
              <span class="dash-detail-label">Subscriptions</span>
              <span class="dash-detail-value">${d.subscriptions_count ?? '--'}</span>
            </div>
            <div class="dash-detail">
              <span class="dash-detail-label">Total In</span>
              <span class="dash-detail-value">${fmtTotal(d.messages_received)}</span>
            </div>
            <div class="dash-detail">
              <span class="dash-detail-label">Total Out</span>
              <span class="dash-detail-value">${fmtTotal(d.messages_sent)}</span>
            </div>
          </div>
        </div>

        <!-- Plugins -->
        <div class="dash-card">
          <div class="dash-card-title">Plugins</div>
          ${plugins.length === 0 && html`
            <div style="color:var(--ve-text-dim);font-size:13px;padding:12px 0;text-align:center;">
              No plugins configured.<br/>
              <span style="font-size:12px;">Use the <strong>+</strong> button in the sidebar to add one.</span>
            </div>
          `}
          <div class="dash-plugin-list">
            ${plugins.map(p => html`
              <a class="dash-plugin ${p.status !== 'running' ? 'dash-plugin--stopped' : ''}" key=${p.id} href="#/plugins/${p.id}">
                <${StatusDot} status=${pluginDotStatus(p)} />
                <div class="dash-plugin-info">
                  <span class="dash-plugin-name">${p.displayName || p.name}</span>
                  ${p.displayName && html`<span class="dash-plugin-type">${p.name}</span>`}
                </div>
                <div class="dash-plugin-stats">
                  ${p.controlCount != null && html`<span>${p.controlCount} elements</span>`}
                  ${p.messageCount != null && html`<span>${fmtTotal(p.messageCount)} msgs</span>`}
                  ${p.error && html`<span style="color:var(--ve-red)">${p.error}</span>`}
                </div>
              </a>
            `)}
          </div>
        </div>
      </div>
    </div>
  `;
}
