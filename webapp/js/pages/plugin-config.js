import { html } from 'htm/preact';
import { useEffect, useState } from 'preact/hooks';
import { StatusDot } from '../components/status-dot.js';
import {
  fetchPlugins,
  getPluginConfig,
  savePluginConfig,
  startPlugin,
  stopPlugin,
  reloadPlugin,
  deletePlugin,
  getStructureRaw,
  refreshStructure as apiRefreshStructure,
} from '../lib/api-client.js';

/**
 * Plugin configuration page.
 * Renders plugin status, lifecycle buttons, and auto-generated config form.
 *
 * @param {{ pluginId: string }} props
 */
export function PluginConfig({ pluginId }) {
  const [pluginStatus, setPluginStatus] = useState('stopped');
  const [pluginName, setPluginName] = useState(pluginId);
  const [pluginType, setPluginType] = useState(null);
  const [isDeletable, setIsDeletable] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [schema, setSchema] = useState(null);
  const [configData, setConfigData] = useState({});
  const [feedback, setFeedback] = useState(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResults, setDiscoveryResults] = useState(null);

  // Structure Inspector (Loxone-only debug panel)
  const [structure, setStructure] = useState(null);
  const [structureLoading, setStructureLoading] = useState(false);
  const [structureError, setStructureError] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // UniFi Test Connection (D-12) + SSO warning banner (D-11b)
  const [probeResult, setProbeResult] = useState(null);
  const [probing, setProbing] = useState(false);
  const [ssoBannerDismissed, setSsoBannerDismissed] = useState(false);

  /** Map plugin status to StatusDot status */
  function dotStatus(s) {
    if (s === 'running') return 'connected';
    if (s === 'error') return 'error';
    return 'stopped';
  }

  /** Load plugin info + config */
  async function loadPlugin() {
    try {
      const [plugins, configResult] = await Promise.all([
        fetchPlugins(),
        getPluginConfig(pluginId),
      ]);
      const plugin = plugins.find(p => p.id === pluginId);
      if (plugin) {
        setPluginStatus(plugin.status);
        setPluginName(plugin.name || plugin.id);
        setPluginType(plugin.type || null);
        setIsDeletable(!!plugin.deletable);
      }
      setSchema(configResult.schema);
      setConfigData({ ...configResult.config });
    } catch (err) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  }

  /** Refresh just the status */
  async function refreshStatus() {
    try {
      const plugins = await fetchPlugins();
      const plugin = plugins.find(p => p.id === pluginId);
      if (plugin) {
        setPluginStatus(plugin.status);
      }
    } catch (_) {
      // Silently ignore refresh errors
    }
  }

  /** Show temporary feedback message */
  function showFeedback(type, text) {
    setFeedback({ type, text });
    setTimeout(() => { setFeedback(null); }, 3000);
  }

  async function handleStart() {
    try {
      await startPlugin(pluginId);
      showFeedback('success', 'Plugin started');
      await refreshStatus();
    } catch (err) {
      showFeedback('error', err.message);
    }
  }

  async function handleStop() {
    try {
      await stopPlugin(pluginId);
      showFeedback('success', 'Plugin stopped');
      await refreshStatus();
    } catch (err) {
      showFeedback('error', err.message);
    }
  }

  async function handleReload() {
    try {
      await reloadPlugin(pluginId);
      showFeedback('success', 'Plugin reloaded');
      await refreshStatus();
    } catch (err) {
      showFeedback('error', err.message);
    }
  }

  async function handleDelete() {
    try {
      await deletePlugin(pluginId);
      window.location.hash = '#/dashboard';
      window.location.reload();
    } catch (err) {
      showFeedback('error', err.message);
      setConfirmDelete(false);
    }
  }

  async function handleSave() {
    try {
      const result = await savePluginConfig(pluginId, configData);
      if (result.autoStarted && result.status === 'running') {
        showFeedback('success', 'Saved & connected');
      } else if (result.autoStarted && result.status === 'error') {
        showFeedback('error', result.error || 'Connection failed — check IP, port, and credentials');
      } else if (result.startError) {
        showFeedback('error', result.startError);
      } else {
        showFeedback('success', 'Configuration saved');
      }
      await refreshStatus();
    } catch (err) {
      showFeedback('error', err.message);
    }
  }

  /**
   * Test Connection (UniFi only). POSTs the in-progress form values to
   * /api/plugins/unifi/probe and renders the structured response inline
   * without persisting anything to ConfigService (D-12). When the response
   * flags an SSO admin (D-11b), the SSO warning banner above the form is
   * surfaced.
   */
  async function handleTestConnection() {
    setProbing(true);
    setProbeResult(null);
    try {
      const res = await fetch(`/api/plugins/${pluginType}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: configData.host,
          username: configData.username,
          password: configData.password,
          site: configData.site || 'default',
          tlsVerify: configData.tlsVerify || false,
        }),
      });
      const data = await res.json();
      setProbeResult(data || { status: 'auth_failed', error: 'Empty response' });
      if (data?.ssoAccount) setSsoBannerDismissed(false);
    } catch (err) {
      setProbeResult({ status: 'network_down', error: `Test request failed: ${err.message}` });
    } finally {
      setProbing(false);
    }
  }

  /** Update a config field value */
  function setField(key, value) {
    setConfigData(prev => ({ ...prev, [key]: value }));
  }

  useEffect(() => { loadPlugin(); }, [pluginId]);

  // Auto-load the structure summary when this is a running Loxone plugin.
  // Reset when the plugin type isn't loxone or when it isn't running so the
  // Inspector card doesn't show stale numbers from a previous instance.
  useEffect(() => {
    if (pluginType !== 'loxone' || pluginStatus !== 'running') {
      setStructure(null);
      setStructureError(null);
      return;
    }
    let cancelled = false;
    setStructureLoading(true);
    getStructureRaw(pluginId)
      .then(data => { if (!cancelled) { setStructure(data); setStructureError(null); } })
      .catch(err => { if (!cancelled) { setStructureError(err.message); setStructure(null); } })
      .finally(() => { if (!cancelled) setStructureLoading(false); });
    return () => { cancelled = true; };
  }, [pluginType, pluginStatus, pluginId]);

  async function handleStructureRefresh() {
    setStructureLoading(true);
    setStructureError(null);
    try {
      const data = await apiRefreshStructure(pluginId);
      setStructure(data);
    } catch (err) {
      setStructureError(err.message);
    } finally {
      setStructureLoading(false);
    }
  }

  /** UDP-broadcast scan for Loxone Miniservers on the LAN. */
  async function handleDiscover() {
    setDiscovering(true);
    setDiscoveryResults(null);
    try {
      const res = await fetch('/api/discovery/loxone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: 3000 }),
      });
      const data = await res.json();
      setDiscoveryResults(Array.isArray(data) ? data : []);
    } catch (err) {
      showFeedback('error', `Discovery failed: ${err.message}`);
    } finally {
      setDiscovering(false);
    }
  }

  function applyDiscoveredMiniserver(ms) {
    // Only suggest a displayName when the device gave us a real one (skip
    // the generic HTTP realm "data") and the user hasn't typed anything yet.
    const hasGoodName = ms.name && !/^data$/i.test(ms.name);
    setConfigData(prev => ({
      ...prev,
      ip: ms.ip || prev.ip,
      port: ms.port || prev.port || 80,
      ...(hasGoodName && !prev.displayName ? { displayName: ms.name } : {}),
    }));
    setDiscoveryResults(null);
    showFeedback('success', `Filled IP from ${ms.ip}`);
  }

  if (loading) {
    return html`<div class="page-placeholder">Loading plugin...</div>`;
  }

  const props = (schema && schema.properties) || {};

  return html`
    <div>
      <div class="page-header" style="display:flex;align-items:center;gap:10px;">
        <${StatusDot} status=${dotStatus(pluginStatus)} />
        <span>${pluginName}</span>
        <span style="font-size:13px;color:var(--ve-text-dim);font-weight:400;">(${pluginStatus})</span>
      </div>

      ${feedback && html`
        <div class="ve-card" style="margin-bottom:12px;padding:10px 14px;background:${feedback.type === 'error' ? 'var(--ve-red)' : 'var(--ve-green)'};color:#fff;border-radius:var(--ve-radius-sm);font-size:14px;">
          ${feedback.text}
        </div>
      `}

      <div class="ve-panel" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <button class="msg-btn msg-btn--subscribe" disabled=${pluginStatus === 'running'} onClick=${handleStart}>Start</button>
        <button class="msg-btn msg-btn--unsubscribe" disabled=${pluginStatus === 'stopped'} onClick=${handleStop}>Stop</button>
        <button class="msg-btn msg-btn--clear" onClick=${handleReload}>Reload</button>
      </div>

      ${pluginType === 'loxone' && html`
        <div class="ve-card" style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <div>
              <div style="font-size:14px;font-weight:600;">Miniserver Discovery</div>
              <div style="font-size:12px;color:var(--ve-text-dim);margin-top:2px;">
                Scan the LAN for Loxone Miniservers via UDP broadcast (port 7777).
              </div>
            </div>
            <button class="msg-btn msg-btn--subscribe" onClick=${handleDiscover} disabled=${discovering}>
              ${discovering ? 'Scanning...' : 'Scan Network'}
            </button>
          </div>
          ${discoveryResults != null && html`
            <div style="margin-top:12px;">
              ${discoveryResults.length === 0
                ? html`<div style="font-size:13px;color:var(--ve-text-dim);">
                    No Miniservers responded. Make sure the device is powered on and on the same VLAN.
                    You can still type the IP manually below.
                  </div>`
                : html`
                  <div style="font-size:12px;color:var(--ve-text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">
                    Found ${discoveryResults.length} Miniserver${discoveryResults.length === 1 ? '' : 's'} — click to fill
                  </div>
                  <div style="display:flex;flex-direction:column;gap:6px;">
                    ${discoveryResults.map(ms => html`
                      <div
                        key=${ms.ip}
                        onClick=${() => applyDiscoveredMiniserver(ms)}
                        style="cursor:pointer;padding:8px 12px;border:1px solid var(--ve-border);border-radius:var(--ve-radius-sm);display:flex;align-items:center;gap:12px;transition:background 0.15s;"
                        onMouseOver=${(e) => e.currentTarget.style.background = 'rgba(56,125,197,0.08)'}
                        onMouseOut=${(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style="flex:1;min-width:0;">
                          <div style="font-size:14px;font-weight:500;">
                            ${(ms.name && !/^data$/i.test(ms.name)) ? ms.name : 'Miniserver'}
                            <span style="color:var(--ve-text-dim);font-weight:normal;font-family:var(--ve-font-mono);font-size:13px;margin-left:6px;">${ms.ip}${ms.port && ms.port !== 80 ? `:${ms.port}` : ''}</span>
                          </div>
                          <div style="font-size:11px;color:var(--ve-text-dim);margin-top:2px;">
                            ${ms.mac || ''}${ms.mac && ms.firmware ? ' · ' : ''}${ms.firmware ? `firmware ${ms.firmware}` : ''}
                          </div>
                        </div>
                        <span style="font-size:11px;color:var(--ve-blue);text-transform:uppercase;letter-spacing:0.5px;">Use →</span>
                      </div>
                    `)}
                  </div>
                `}
            </div>
          `}
        </div>
      `}

      ${pluginType === 'loxone' && html`
        <div class="ve-card" style="margin-bottom:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <div>
              <div style="font-size:14px;font-weight:600;">Structure Inspector</div>
              <div style="font-size:12px;color:var(--ve-text-dim);margin-top:2px;">
                Was der Miniserver gerade exportiert (LoxAPP3.json)
              </div>
            </div>
            ${pluginStatus === 'running' && html`
              <button
                class="msg-btn msg-btn--subscribe"
                onClick=${handleStructureRefresh}
                disabled=${structureLoading}
              >
                ${structureLoading ? 'Lade Struktur…' : 'Struktur neu laden vom Miniserver'}
              </button>
            `}
          </div>

          ${pluginStatus !== 'running'
            ? html`
              <div style="margin-top:12px;font-size:13px;color:var(--ve-text-dim);">
                Plugin nicht aktiv — Inspector benötigt eine laufende Verbindung.
              </div>
            `
            : html`
              ${structureError && html`
                <div style="margin-top:12px;font-size:13px;color:var(--ve-red);">
                  ${structureError}
                </div>
              `}

              ${structureLoading && structure == null && html`
                <div style="margin-top:12px;font-size:13px;color:var(--ve-text-dim);">
                  Lade Struktur…
                </div>
              `}

              ${structure != null && html`
                <div style="margin-top:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;">
                  <span><strong>${structure.controlCount}</strong> Bausteine</span>
                  ${Object.entries(structure.typeCounts).sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => html`
                    <span
                      key=${t}
                      style="display:inline-block;padding:2px 8px;border:1px solid var(--ve-border);border-radius:var(--ve-radius-sm);font-size:12px;color:var(--ve-text-dim);"
                    >${t}: ${n}</span>
                  `)}
                  <span style="color:var(--ve-text-dim);">·</span>
                  <span>${structure.rooms.length} Räume</span>
                  <span style="color:var(--ve-text-dim);">·</span>
                  <span>${structure.categories.length} Kategorien</span>
                </div>

                ${(structure.missingRoom.length > 0 || structure.missingCategory.length > 0) && html`
                  <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">
                    ${structure.missingRoom.length > 0 && html`
                      <span
                        title=${structure.missingRoom.slice(0, 10).join(', ') + (structure.missingRoom.length > 10 ? `, … (+${structure.missingRoom.length - 10})` : '')}
                        style="display:inline-block;padding:2px 8px;background:var(--ve-red);color:#fff;border-radius:var(--ve-radius-sm);font-size:12px;"
                      >${structure.missingRoom.length} Bausteine ohne Raum</span>
                    `}
                    ${structure.missingCategory.length > 0 && html`
                      <span
                        title=${structure.missingCategory.slice(0, 10).join(', ') + (structure.missingCategory.length > 10 ? `, … (+${structure.missingCategory.length - 10})` : '')}
                        style="display:inline-block;padding:2px 8px;background:#caa53d;color:#000;border-radius:var(--ve-radius-sm);font-size:12px;"
                      >${structure.missingCategory.length} Bausteine ohne Kategorie</span>
                    `}
                  </div>
                `}

                <div
                  onClick=${() => setInspectorOpen(v => !v)}
                  style="margin-top:12px;cursor:pointer;font-size:13px;color:var(--ve-blue);user-select:none;"
                >
                  ${inspectorOpen ? '▼' : '▶'} Detailansicht (${structure.controlCount} Bausteine)
                </div>

                ${inspectorOpen && html`
                  <div style="margin-top:8px;overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;font-size:12px;">
                      <thead>
                        <tr style="text-align:left;color:var(--ve-text-dim);text-transform:uppercase;letter-spacing:0.5px;font-size:11px;border-bottom:1px solid var(--ve-border);">
                          <th style="padding:6px 8px;">Name</th>
                          <th style="padding:6px 8px;">Type</th>
                          <th style="padding:6px 8px;">Room</th>
                          <th style="padding:6px 8px;">Category</th>
                          <th style="padding:6px 8px;">Topic</th>
                          <th style="padding:6px 8px;">States</th>
                          <th style="padding:6px 8px;">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${structure.controls.map(ctrl => {
                          const roomEmpty = !ctrl.room || ctrl.room === 'unknown';
                          const catEmpty = !ctrl.category;
                          const states = ctrl.stateKeys.join(', ')
                            + (ctrl.subControlCount > 0 ? ` (+${ctrl.subControlCount} sub)` : '');
                          const descFull = ctrl.description || '';
                          const descShort = descFull.length > 60
                            ? descFull.slice(0, 60).trimEnd() + '…'
                            : descFull;
                          return html`
                            <tr key=${ctrl.uuid} style="border-bottom:1px solid var(--ve-border);">
                              <td style="padding:6px 8px;">${ctrl.name}</td>
                              <td style="padding:6px 8px;color:var(--ve-text-dim);">${ctrl.type}</td>
                              <td style="padding:6px 8px;${roomEmpty ? 'color:var(--ve-text-dim);' : ''}">
                                ${roomEmpty ? '—' : ctrl.room}
                              </td>
                              <td style="padding:6px 8px;${catEmpty ? 'color:var(--ve-text-dim);' : ''}">
                                ${catEmpty ? '—' : ctrl.category}
                              </td>
                              <td style="padding:6px 8px;font-family:var(--ve-font-mono);color:var(--ve-text-dim);">${ctrl.topic}</td>
                              <td style="padding:6px 8px;color:var(--ve-text-dim);">${states}</td>
                              <td style="padding:6px 8px;color:var(--ve-text-dim);" title=${descFull}>${descShort || '—'}</td>
                            </tr>
                          `;
                        })}
                      </tbody>
                    </table>
                  </div>
                `}
              `}
            `}
        </div>
      `}

      ${pluginType === 'unifi' && probeResult?.ssoAccount === true && !ssoBannerDismissed && html`
        <div
          class="ve-card"
          style="margin-bottom:12px;padding:10px 14px;background:#caa53d;color:#000;border-radius:var(--ve-radius-sm);font-size:13px;display:flex;align-items:center;gap:12px;"
        >
          <div style="flex:1;">
            ⚠ SSO admin detected — Ubiquiti recommends a local-only admin for automation. See README.
          </div>
          <button
            class="msg-btn msg-btn--clear"
            style="font-size:12px;padding:4px 10px;"
            onClick=${() => setSsoBannerDismissed(true)}
          >Dismiss</button>
        </div>
      `}

      <div class="ve-card">
        <div style="font-size:16px;font-weight:600;margin-bottom:12px;">Configuration</div>
        ${Object.keys(props).length === 0
          ? html`<div class="page-placeholder">No configurable properties</div>`
          : html`
            <div>
              ${Object.entries(props).map(([key, prop]) => {
                const value = configData[key] !== undefined ? configData[key] : (prop.default || '');
                const label = prop.title || key;

                if (prop.type === 'boolean') {
                  return html`
                    <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;">
                      <input
                        type="checkbox"
                        checked=${!!value}
                        onChange=${(e) => setField(key, e.target.checked)}
                        style="width:16px;height:16px;"
                      />
                      <label style="font-size:14px;color:var(--ve-text-secondary);">${label}</label>
                    </div>
                  `;
                }

                const inputType = prop.format === 'password' ? 'password'
                  : (prop.type === 'number' || prop.type === 'integer') ? 'number' : 'text';
                return html`
                  <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;color:var(--ve-text-dim);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${label}</label>
                    <input
                      class="msg-topic-input"
                      type=${inputType}
                      value=${value}
                      placeholder=${prop.default || ''}
                      onInput=${(e) => setField(key, inputType === 'number' ? Number(e.target.value) : e.target.value)}
                      style="width:100%;"
                    />
                  </div>
                `;
              })}
              ${pluginType === 'unifi' && html`
                <div style="margin-top:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                  <button
                    class="msg-btn msg-btn--subscribe"
                    onClick=${handleTestConnection}
                    disabled=${probing || !configData.host || !configData.username || !configData.password}
                  >${probing ? 'Probing…' : 'Test Connection'}</button>
                  ${probeResult && !probing && (() => {
                    const okStyle = 'background:var(--ve-green);color:#fff;';
                    const failStyle = 'background:var(--ve-red);color:#fff;';
                    const warnStyle = 'background:#caa53d;color:#000;';
                    let style = failStyle;
                    let text = probeResult.error || 'Unknown error';
                    if (probeResult.status === 'ok') {
                      style = okStyle;
                      text = `Connected to ${probeResult.controllerName || 'controller'} (${probeResult.siteName || 'default'})`;
                    } else if (probeResult.status === '2fa_blocked') {
                      style = failStyle;
                      text = '2FA admin not supported — create a local-only admin';
                    } else if (probeResult.status === 'network_down') {
                      style = warnStyle;
                    }
                    return html`
                      <span style="padding:6px 12px;border-radius:var(--ve-radius-sm);font-size:13px;${style}">
                        ${text}
                      </span>
                    `;
                  })()}
                </div>
              `}
              <button class="msg-btn msg-btn--subscribe" onClick=${handleSave} style="margin-top:8px;">Save</button>
            </div>
          `
        }
      </div>

      ${isDeletable && html`
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--ve-border);">
          ${!confirmDelete
            ? html`<button class="msg-btn" style="background:transparent;border:1px solid var(--ve-red);color:var(--ve-red);" onClick=${() => setConfirmDelete(true)}>Delete Plugin</button>`
            : html`
              <div style="display:flex;align-items:center;gap:12px;">
                <span style="font-size:14px;color:var(--ve-red);">Delete "${pluginName}" permanently?</span>
                <button class="msg-btn" style="background:var(--ve-red);" onClick=${handleDelete}>Yes, delete</button>
                <button class="msg-btn msg-btn--clear" onClick=${() => setConfirmDelete(false)}>Cancel</button>
              </div>
            `
          }
        </div>
      `}
    </div>
  `;
}
