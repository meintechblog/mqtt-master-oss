import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { StatusDot } from './status-dot.js';
import { brokerConnected, dashboardState } from '../lib/ws-client.js';
import { fetchPlugins, fetchBindingsHealth } from '../lib/api-client.js';
import { fmtMsgPerSec, fmtRate, pluginLabel } from '../lib/format.js';
import { copyToClipboard } from '../lib/clipboard.js';

export const menuOpen = signal(false);

export function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

/** Dynamic plugin items loaded from /api/plugins */
const pluginItems = signal([]);

/**
 * Per-plugin binding-health rollup from /api/bindings/health, keyed by plugin
 * id. Mirrors `pluginItems`. Drives the dot on the "Input Bindings" sub-nav.
 */
const bindingHealth = signal({});

/** Map an aggregate binding-health severity to a StatusDot status string. */
function bindingDotStatus(severity) {
  if (severity === 'error') return 'sev-error';
  if (severity === 'warn') return 'sev-warn';
  return 'sev-ok';
}

/** Build the tooltip text for an "Input Bindings" sub-nav item. */
function bindingHealthTitle(health) {
  if (!health || health.severity === 'ok' || health.severity === 'none') {
    return 'Alle Bindings OK';
  }
  const errors = health.counts?.error ?? 0;
  const warns = health.counts?.warn ?? 0;
  let title = `${errors} Fehler, ${warns} Warnungen`;
  const first = health.issues?.[0];
  if (first) title += ` — ${first.label}: ${first.detail}`;
  return title;
}

/** Plugin message rates (computed from status polling) */
const pluginMsgCounts = {};

const brokerSection = {
  title: 'Broker',
  items: [
    { label: 'Dashboard', hash: '#/dashboard' },
    { label: 'Live Messages', hash: '#/messages' },
    { label: 'MQTT Bridges', hash: '#/bridges' },
    { label: 'Documentation', hash: '#/docs' },
    { label: 'Backup', hash: '#/backup' },
  ],
};

/** Map plugin API status to StatusDot status */
function pluginDotStatus(item) {
  if (item.status === 'error') return 'error';
  if (item.status === 'running' && item.connected === false) return 'error';
  if (item.status === 'running') return 'connected';
  return 'stopped';
}

function AddPluginButton() {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [newId, setNewId] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleOpen = async () => {
    setOpen(true);
    setError('');
    setNewId('');
    setSelectedType('');
    setSelectedPreset(null);
    try {
      const res = await fetch('/api/plugins/templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch { /* ignore */ }
  };

  const handleSelectType = (type) => {
    setSelectedType(type);
    setSelectedPreset(null);
    const tmpl = templates.find(t => t.type === type);
    // If type has presets, don't auto-fill ID yet — let preset do it
    if (!tmpl || !tmpl.presets || tmpl.presets.length === 0) {
      if (!newId) setNewId(type);
    } else {
      setNewId('');
    }
  };

  const handleSelectPreset = (preset) => {
    setSelectedPreset(preset.id);
    if (preset.suggestedId) setNewId(preset.suggestedId);
    else if (!newId) setNewId('');
  };

  const handleCreate = async () => {
    if (!newId.trim() || !selectedType) return;
    setCreating(true);
    setError('');
    try {
      const cleanId = newId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const res = await fetch('/api/plugins/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: selectedType, id: cleanId, preset: selectedPreset }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOpen(false);
      window.location.hash = '#/plugins/' + data.id;
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const currentTemplate = templates.find(t => t.type === selectedType);
  const presets = currentTemplate?.presets || [];

  return html`
    <button class="sidebar-add-btn" onClick=${handleOpen} title="Add plugin">+</button>
    ${open && html`
      <div class="ve-modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
        <div class="ve-modal">
          <div class="ve-modal-title">Add Plugin</div>
          <div class="ve-modal-type-picker">
            ${templates.map(t => html`
              <div
                key=${t.type}
                class="ve-modal-type-card ${selectedType === t.type ? 've-modal-type-card--selected' : ''}"
                onClick=${() => handleSelectType(t.type)}
              >
                <div class="ve-modal-type-label">${t.label}</div>
                <div class="ve-modal-type-desc">${t.description}</div>
              </div>
            `)}
          </div>
          ${selectedType && presets.length > 0 && !selectedPreset && html`
            <div class="ve-modal-form">
              <label class="ve-modal-field-label">Preset</label>
              <div class="ve-modal-type-picker" style="margin-top:6px">
                ${presets.map(p => html`
                  <div
                    key=${p.id}
                    class="ve-modal-type-card"
                    onClick=${() => handleSelectPreset(p)}
                  >
                    <div class="ve-modal-type-label">${p.label}</div>
                    <div class="ve-modal-type-desc">${p.description}</div>
                  </div>
                `)}
              </div>
            </div>
          `}
          ${selectedType && (presets.length === 0 || selectedPreset) && html`
            <div class="ve-modal-form">
              <label class="ve-modal-field-label">Instance Name</label>
              <input
                type="text"
                class="ve-modal-input"
                placeholder="e.g. venus-os, knx-gateway"
                value=${newId}
                onInput=${(e) => setNewId(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') handleCreate(); }}
              />
              ${selectedPreset && selectedPreset !== 'custom' && html`
                <div style="font-size:12px;color:var(--ve-text-dim);margin-top:4px;">
                  Pre-configured for ${presets.find(p => p.id === selectedPreset)?.label || selectedPreset}
                </div>
              `}
            </div>
          `}
          ${error && html`<div style="font-size:13px;color:var(--ve-red);margin-top:12px;">${error}</div>`}
          <div class="ve-modal-actions">
            <button class="lox-push-btn" onClick=${() => setOpen(false)}>Cancel</button>
            <button class="lox-cmd-btn" disabled=${!newId.trim() || !selectedType || creating} onClick=${handleCreate}>
              ${creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    `}
  `;
}

export function Sidebar({ currentHash }) {

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const plugins = await fetchPlugins();
        if (!cancelled) {
          const now = Date.now();
          pluginItems.value = plugins.map(p => {
            // Compute msg/s rate from messageCount delta
            let rate = null;
            if (p.messageCount != null) {
              const prev = pluginMsgCounts[p.id];
              if (prev) {
                const dt = (now - prev.ts) / 1000;
                if (dt > 0) rate = (p.messageCount - prev.count) / dt;
              }
              pluginMsgCounts[p.id] = { count: p.messageCount, ts: now };
            }
            // Plugin type label (technical name)
            const typeLabel = pluginLabel(p.type || p.id);
            return {
              id: p.id,
              type: p.type || p.id,
              label: p.displayName || typeLabel,
              typeLabel: p.displayName ? typeLabel : '',
              hash: '#/plugins/' + p.id,
              status: p.status,
              connected: p.connected,
              rate,
              topicPrefix: p.topicPrefix || null,
            };
          });
        }
      } catch (_) {
        // API not available yet -- keep empty
      }

      // Binding-health rollup for the "Input Bindings" sub-nav dot. Defensive:
      // on any fetch failure keep the previous value so a transient hiccup
      // doesn't blank the dots.
      try {
        const health = await fetchBindingsHealth();
        if (!cancelled && health && typeof health === 'object') {
          bindingHealth.value = health;
        }
      } catch (_) {
        // keep the last known health map
      }
    }

    load();
    const interval = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return html`
    <aside class="sidebar ${menuOpen.value ? 'open' : ''}">
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="5" cy="5" r="2.5" />
            <circle cx="19" cy="5" r="2.5" />
            <circle cx="12" cy="19" r="2.5" />
            <circle cx="12" cy="12" r="1.5" />
            <line x1="7" y1="6.5" x2="10.5" y2="11" />
            <line x1="17" y1="6.5" x2="13.5" y2="11" />
            <line x1="12" y1="13.5" x2="12" y2="16.5" />
          </svg>
          <span class="sidebar-title">MQTT Master</span>
        </div>
      </div>
      <div class="sidebar-section">
        <div class="sidebar-section-title">
          <${StatusDot} status=${brokerConnected.value ? 'connected' : 'disconnected'} />
          Lokaler Broker
          ${dashboardState.value.data.load_received_1min && html`
            <span class="sidebar-rate">${fmtRate(dashboardState.value.data.load_received_1min)}</span>
          `}
        </div>
        ${brokerSection.items.map(item => html`
          <a
            class="sidebar-nav-item ${currentHash.value === item.hash ? 'active' : ''}"
            href=${item.hash}
            onClick=${() => { menuOpen.value = false; }}
          >
            ${item.label}
          </a>
        `)}
      </div>
      <div class="sidebar-section">
        <div class="sidebar-section-title">
          Plugins <${AddPluginButton} />
        </div>
        ${pluginItems.value.length === 0
          ? html`<div style="padding:6px 16px;font-size:13px;color:var(--ve-text-dim);">No plugins</div>`
          : pluginItems.value.map(item => html`
            <a
              class="sidebar-nav-item ${currentHash.value === item.hash ? 'active' : ''}"
              href=${item.hash}
              onClick=${() => { menuOpen.value = false; }}
            >
              <span class="sidebar-plugin-status">
                <${StatusDot} status=${pluginDotStatus(item)} />
                <span class="sidebar-plugin-info">
                  <span class="sidebar-plugin-name">${item.label}</span>
                  ${item.typeLabel && html`<span class="sidebar-plugin-type">${item.typeLabel}</span>`}
                  ${item.topicPrefix && html`
                    <span
                      class="sidebar-plugin-topic"
                      title="Click to copy: ${item.topicPrefix}"
                      onClick=${(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        copyToClipboard(item.topicPrefix);
                      }}
                    >${item.topicPrefix}/</span>
                  `}
                </span>
                ${item.status === 'running' && html`<span class="sidebar-rate">${fmtMsgPerSec(item.rate ?? 0)}</span>`}
              </span>
            </a>
            ${item.type === 'loxone' && item.status === 'running' && html`
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/controls' ? 'active' : ''}"
                href="#/plugins/${item.id}/controls"
                style="padding-left:36px;font-size:13px;"
                onClick=${() => { menuOpen.value = false; }}
              >
                Elements
              </a>
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/moods' ? 'active' : ''}"
                href="#/plugins/${item.id}/moods"
                style="padding-left:36px;font-size:13px;"
                onClick=${() => { menuOpen.value = false; }}
              >
                Mood Mapping
              </a>
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/bindings' ? 'active' : ''}"
                href="#/plugins/${item.id}/bindings"
                style="padding-left:36px;font-size:13px;"
                title=${bindingHealth.value[item.id] ? bindingHealthTitle(bindingHealth.value[item.id]) : null}
                onClick=${() => { menuOpen.value = false; }}
              >
                <span class="sidebar-plugin-status">
                  ${bindingHealth.value[item.id] && bindingHealth.value[item.id].severity !== 'none' && html`
                    <${StatusDot} status=${bindingDotStatus(bindingHealth.value[item.id].severity)} />
                  `}
                  <span class="sidebar-plugin-name">Input Bindings</span>
                </span>
              </a>
            `}
            ${item.type === 'unifi' && item.status === 'running' && html`
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/ports' ? 'active' : ''}"
                href="#/plugins/${item.id}/ports"
                style="padding-left:36px;font-size:13px;"
                onClick=${() => { menuOpen.value = false; }}
              >
                Ports
              </a>
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/wan' ? 'active' : ''}"
                href="#/plugins/${item.id}/wan"
                style="padding-left:36px;font-size:13px;"
                onClick=${() => { menuOpen.value = false; }}
              >
                WAN
              </a>
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/clients' ? 'active' : ''}"
                href="#/plugins/${item.id}/clients"
                style="padding-left:36px;font-size:13px;"
                onClick=${() => { menuOpen.value = false; }}
              >
                Clients
              </a>
            `}
            ${item.type === 'mqtt-bridge' && item.status === 'running' && html`
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/elements' ? 'active' : ''}"
                href="#/plugins/${item.id}/elements"
                style="padding-left:36px;font-size:13px;"
                onClick=${() => { menuOpen.value = false; }}
              >
                Elements
              </a>
              <a
                class="sidebar-nav-item ${currentHash.value === '#/plugins/' + item.id + '/bindings' ? 'active' : ''}"
                href="#/plugins/${item.id}/bindings"
                style="padding-left:36px;font-size:13px;"
                title=${bindingHealth.value[item.id] ? bindingHealthTitle(bindingHealth.value[item.id]) : null}
                onClick=${() => { menuOpen.value = false; }}
              >
                <span class="sidebar-plugin-status">
                  ${bindingHealth.value[item.id] && bindingHealth.value[item.id].severity !== 'none' && html`
                    <${StatusDot} status=${bindingDotStatus(bindingHealth.value[item.id].severity)} />
                  `}
                  <span class="sidebar-plugin-name">Input Bindings</span>
                </span>
              </a>
            `}
          `)
        }
      </div>
    </aside>
    ${menuOpen.value && html`
      <div class="sidebar-backdrop" onClick=${toggleMenu}></div>
    `}
  `;
}
