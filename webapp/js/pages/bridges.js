import { html } from 'htm/preact';
import { useEffect, useState, useCallback } from 'preact/hooks';
import { StatusDot } from '../components/status-dot.js';
import {
  fetchBridges,
  fetchBridge,
  fetchBridgesStatus,
  applyBridges,
} from '../lib/api-client.js';

// ── Constants ──────────────────────────────────────────────────────
const DIRECTIONS = [
  { value: 'in',   label: 'in (subscribe from remote)' },
  { value: 'out',  label: 'out (publish to remote)' },
  { value: 'both', label: 'both (bidirectional)' },
];
const QOS_OPTIONS = [0, 1, 2];

// Example "mirror everything from a legacy broker" preset (documentation address). The typical
// migration use case (legacy central broker → mqtt-master). Keep the values
// here in sync with the server-side validation contract: connectionName
// matches /^[a-zA-Z0-9_-]{1,64}$/, topics[].direction ∈ in/out/both,
// topics[].qos ∈ 0/1/2.
const PRESET_LEGACY = {
  connectionName: 'from-legacy',
  remoteHost: '203.0.113.8',
  remotePort: 1883,
  remoteUsername: '',
  remotePassword: '',
  topics: [{ pattern: '#', direction: 'in', qos: 0 }],
  enabled: true,
};

const EMPTY_BRIDGE = {
  connectionName: '',
  remoteHost: '',
  remotePort: 1883,
  remoteUsername: '',
  remotePassword: '',
  topics: [{ pattern: '#', direction: 'in', qos: 0 }],
  enabled: true,
};

// ── Helpers ────────────────────────────────────────────────────────
/** Map a service status string to a StatusDot status. */
function dotFromState(state) {
  if (state === 'connected') return 'connected';
  if (state === 'disconnected') return 'error';
  return 'stopped'; // 'unknown' or missing
}

/** Deep-clone a plain bridge object (no functions/Dates inside). */
function cloneBridge(b) {
  return JSON.parse(JSON.stringify(b));
}

// ── Edit panel ─────────────────────────────────────────────────────
function EditPanel({ initial, isNew, onSave, onCancel, saving, errorMsg, errorStderr }) {
  const [form, setForm] = useState(() => cloneBridge(initial));

  // If `initial` changes (e.g. switching from one card's edit panel to the
  // next), reset the form. The parent supplies a fresh object reference per
  // open so this works as an identity dependency.
  useEffect(() => {
    setForm(cloneBridge(initial));
  }, [initial]);

  const updateField = (key, value) => setForm(f => ({ ...f, [key]: value }));
  const updateTopic = (idx, key, value) => setForm(f => ({
    ...f,
    topics: f.topics.map((t, i) => i === idx ? { ...t, [key]: value } : t),
  }));
  const addTopic = () => setForm(f => ({
    ...f,
    topics: [...f.topics, { pattern: '#', direction: 'in', qos: 0 }],
  }));
  const removeTopic = (idx) => setForm(f => ({
    ...f,
    topics: f.topics.filter((_, i) => i !== idx),
  }));

  const handleSave = () => {
    // Pass-through (server is authoritative for validation). The page-level
    // try/catch surfaces any 400/500 with its error+stderr fields.
    const payload = {
      ...form,
      remotePort: Number(form.remotePort) || 0,
    };
    onSave(payload);
  };

  return html`
    <div class="bridges-edit">
      <div class="bridges-edit-row">
        <div class="bridges-field" style="flex:1">
          <label class="bridges-field-label">Connection Name</label>
          <input
            type="text"
            class="bridges-input"
            value=${form.connectionName}
            disabled=${!isNew}
            title=${!isNew ? 'Connection name is locked after creation — delete + recreate to rename' : 'Letters, digits, _ and -. Max 64 chars.'}
            onInput=${(e) => updateField('connectionName', e.target.value)}
            placeholder="e.g. from-legacy"
          />
        </div>
        <div class="bridges-field" style="flex:1">
          <label class="bridges-field-label">Remote Host</label>
          <input
            type="text"
            class="bridges-input"
            value=${form.remoteHost}
            onInput=${(e) => updateField('remoteHost', e.target.value)}
            placeholder="203.0.113.8"
          />
        </div>
        <div class="bridges-field">
          <label class="bridges-field-label">Port</label>
          <input
            type="number"
            min="1"
            max="65535"
            class="bridges-input"
            style="width:90px"
            value=${form.remotePort}
            onInput=${(e) => updateField('remotePort', e.target.value)}
          />
        </div>
      </div>

      <div class="bridges-edit-row" style="margin-top:8px">
        <div class="bridges-field" style="flex:1">
          <label class="bridges-field-label">Username (optional)</label>
          <input
            type="text"
            class="bridges-input"
            value=${form.remoteUsername || ''}
            onInput=${(e) => updateField('remoteUsername', e.target.value)}
            placeholder="(leave blank for no auth)"
          />
        </div>
        <div class="bridges-field" style="flex:1">
          <label class="bridges-field-label">Password (optional)</label>
          <input
            type="password"
            class="bridges-input"
            value=${form.remotePassword || ''}
            onInput=${(e) => updateField('remotePassword', e.target.value)}
            placeholder=""
          />
        </div>
      </div>

      <div style="margin-top:14px;font-size:12px;color:var(--ve-text-dim);text-transform:uppercase;letter-spacing:0.5px">
        Topics
      </div>
      <div class="bridges-topics">
        ${form.topics.map((t, idx) => html`
          <div class="bridges-topic-row" key=${idx}>
            <select
              class="bridges-select"
              value=${t.direction}
              onChange=${(e) => updateTopic(idx, 'direction', e.target.value)}
              title="Direction: in = subscribe from remote, out = publish to remote, both = bidirectional"
            >
              ${DIRECTIONS.map(d => html`<option key=${d.value} value=${d.value}>${d.label}</option>`)}
            </select>
            <input
              type="text"
              class="bridges-input"
              style="flex:1"
              value=${t.pattern}
              onInput=${(e) => updateTopic(idx, 'pattern', e.target.value)}
              placeholder="# (everything) or sensors/#"
            />
            <select
              class="bridges-select bridges-select--narrow"
              value=${t.qos}
              onChange=${(e) => updateTopic(idx, 'qos', Number(e.target.value))}
              title="Quality of Service"
            >
              ${QOS_OPTIONS.map(q => html`<option key=${q} value=${q}>QoS ${q}</option>`)}
            </select>
            <button
              type="button"
              class="bridges-topic-remove"
              onClick=${() => removeTopic(idx)}
              disabled=${form.topics.length <= 1}
              title=${form.topics.length <= 1 ? 'At least one topic is required' : 'Remove this topic'}
            >×</button>
          </div>
        `)}
      </div>
      <button
        type="button"
        class="lox-cmd-btn--small lox-cmd-btn"
        style="margin-top:6px"
        onClick=${addTopic}
      >+ Add topic</button>

      ${errorMsg && html`
        <div class="bridges-error" style="margin-top:14px">
          <div>${errorMsg}</div>
          ${errorStderr && html`<pre class="bridges-stderr">${errorStderr}</pre>`}
        </div>
      `}

      <div class="bridges-edit-actions">
        <button class="lox-push-btn" onClick=${onCancel} disabled=${saving}>Cancel</button>
        <button class="lox-cmd-btn" onClick=${handleSave} disabled=${saving}>
          ${saving ? 'Speichere…' : 'Save'}
        </button>
      </div>
    </div>
  `;
}

// ── Per-bridge card ────────────────────────────────────────────────
function BridgeCard({ bridge, statusState, isExpanded, onToggleExpand, onSave, onDelete, saving, errorMsg, errorStderr }) {
  // Per-card hydration: when expanding for the first time, fetch the
  // single-bridge endpoint so the form gets the cleartext password.
  const [hydrated, setHydrated] = useState(null);
  useEffect(() => {
    if (!isExpanded) {
      setHydrated(null);
      return undefined;
    }
    let cancelled = false;
    fetchBridge(bridge.id).then((full) => {
      if (!cancelled) setHydrated(full);
    }).catch(() => { /* leave hydrated = null, fall back to masked bridge */ });
    return () => { cancelled = true; };
  }, [isExpanded, bridge.id]);

  const initial = hydrated || bridge;
  const topicCount = Array.isArray(bridge.topics) ? bridge.topics.length : 0;

  const handleDelete = () => {
    if (confirm(`Bridge "${bridge.connectionName}" wirklich löschen?`)) {
      onDelete(bridge.id);
    }
  };

  return html`
    <div class="bridges-card ${isExpanded ? 'bridges-card--expanded' : ''}">
      <div class="bridges-card-header" onClick=${onToggleExpand} style="cursor:pointer">
        <${StatusDot} status=${dotFromState(statusState)} />
        <span class="bridges-card-name">${bridge.connectionName}</span>
        <span class="bridges-card-arrow">→</span>
        <span class="bridges-card-remote">${bridge.remoteHost}:${bridge.remotePort}</span>
        <span class="bridges-card-meta">${topicCount} topic${topicCount === 1 ? '' : 's'}</span>
        <div class="bridges-card-actions">
          <button
            type="button"
            class="lox-cmd-btn--small lox-cmd-btn"
            onClick=${(e) => { e.stopPropagation(); onToggleExpand(); }}
          >${isExpanded ? 'Close' : 'Edit'}</button>
          <button
            type="button"
            class="lox-push-btn"
            style="margin-left:6px"
            onClick=${(e) => { e.stopPropagation(); handleDelete(); }}
          >Delete</button>
        </div>
      </div>
      ${isExpanded && html`
        <${EditPanel}
          initial=${initial}
          isNew=${false}
          saving=${saving}
          errorMsg=${errorMsg}
          errorStderr=${errorStderr}
          onSave=${(payload) => onSave(bridge.id, payload)}
          onCancel=${onToggleExpand}
        />
      `}
    </div>
  `;
}

// ── Top-level page ─────────────────────────────────────────────────
export function Bridges() {
  const [bridges, setBridges]       = useState([]);
  const [status, setStatus]         = useState({});
  const [loading, setLoading]       = useState(true);
  const [toast, setToast]           = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [creating, setCreating]     = useState(false);
  const [saving, setSaving]         = useState(false);
  const [errorMsg, setErrorMsg]     = useState(null);
  const [errorStderr, setErrorStderr] = useState(null);

  const showToast = useCallback((type, text) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Centralised structured-error handling. /api/bridges/* uses fetch() under
  // the hood (via api-client `request`). On a non-2xx the helper throws an
  // Error whose `.message` is the body.error. We separately want the
  // body.stderr (mosquitto's actual complaint), so we re-fetch directly when
  // a save/delete fails to capture it. Simpler than threading rejection
  // payloads through `request()`.
  const callWithStderr = async (url, init) => {
    const res = await fetch(url, {
      headers: init && init.body ? { 'Content-Type': 'application/json' } : {},
      ...init,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Request failed: ${res.status}`);
      err.stderr = body.stderr || null;
      throw err;
    }
    return body;
  };

  const clearError = () => { setErrorMsg(null); setErrorStderr(null); };

  const refresh = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([fetchBridges(), fetchBridgesStatus()]);
      setBridges(Array.isArray(list) ? list : []);
      setStatus(st && typeof st === 'object' ? st : {});
    } catch (err) {
      showToast('error', err.message || 'Konnte Bridges nicht laden');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Status polling — light endpoint, in-memory on the server. Every 2s.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const st = await fetchBridgesStatus();
        if (st && typeof st === 'object') setStatus(st);
      } catch { /* keep prior status on transient error */ }
    }, 2000);
    return () => clearInterval(id);
  }, []);

  const handleSaveExisting = async (id, payload) => {
    setSaving(true);
    clearError();
    try {
      await callWithStderr(`/api/bridges/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      await refresh();
      setExpandedId(null);
      showToast('ok', 'Bridge gespeichert');
    } catch (err) {
      setErrorMsg(err.message);
      setErrorStderr(err.stderr || null);
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveNew = async (payload) => {
    setSaving(true);
    clearError();
    try {
      await callWithStderr('/api/bridges', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await refresh();
      setCreating(false);
      showToast('ok', 'Bridge gespeichert');
    } catch (err) {
      setErrorMsg(err.message);
      setErrorStderr(err.stderr || null);
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    setSaving(true);
    clearError();
    try {
      await callWithStderr(`/api/bridges/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refresh();
      setExpandedId(null);
      showToast('ok', 'Bridge gelöscht');
    } catch (err) {
      showToast('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async () => {
    try {
      await applyBridges();
      showToast('ok', 'mosquitto reload OK');
    } catch (err) {
      showToast('error', err.message);
    }
  };

  const handleQuickPreset38 = () => {
    setCreating(true);
    setExpandedId(null);
    clearError();
  };

  // The initial form data for the create panel. Defaults to EMPTY_BRIDGE
  // unless the user opened it via the "from 3.8" preset button — in that
  // case we hydrate with PRESET_LEGACY so it's a 1-click save.
  const [createInitial, setCreateInitial] = useState(EMPTY_BRIDGE);

  const openCreatePanel = (initial) => {
    setCreateInitial(initial);
    setCreating(true);
    setExpandedId(null);
    clearError();
  };

  const isEmpty = !loading && bridges.length === 0;

  return html`
    <div class="bridges-page">
      <div class="bridges-page-header">
        <h1 class="bridges-page-title">MQTT Bridges</h1>
        <div class="bridges-page-actions">
          <button
            class="lox-cmd-btn"
            onClick=${() => openCreatePanel(EMPTY_BRIDGE)}
            disabled=${creating}
            title="Neue Bridge anlegen"
          >+ Add Bridge</button>
          <button
            class="lox-push-btn"
            onClick=${handleApply}
            title="Re-render .conf und systemctl reload mosquitto"
          >Reload mosquitto</button>
        </div>
      </div>

      <div class="bridges-page-hint">
        Verwaltet <code>/etc/mosquitto/conf.d/mqtt-master-bridges.conf</code>.
        Live-Status kommt über das retained Topic
        <code>$SYS/broker/connection/&lt;name&gt;/state</code>.
      </div>

      ${isEmpty && html`
        <div class="bridges-empty">
          <div>Keine MQTT-Bridges konfiguriert.</div>
          <div style="margin-top:6px;font-size:13px;color:var(--ve-text-dim)">
            Mit <strong>+ Add Bridge</strong> verbindest du diesen Broker mit einem anderen MQTT-Broker.
          </div>
          <div style="margin-top:12px">
            <button
              class="lox-cmd-btn"
              onClick=${() => openCreatePanel(PRESET_LEGACY)}
              title="Eine Bridge anlegen, die alles von einem anderen Broker spiegelt — typischer Migrations-Use-Case"
            >Spiegel everything from legacy broker</button>
          </div>
        </div>
      `}

      ${!isEmpty && html`
        <div class="bridges-quickpresets">
          <button
            class="lox-cmd-btn--small lox-cmd-btn"
            onClick=${() => openCreatePanel(PRESET_LEGACY)}
            title="Quick-Preset: subscribe '#' from a legacy broker"
          >Spiegel everything from legacy broker</button>
        </div>
      `}

      ${creating && html`
        <div class="bridges-card bridges-card--new bridges-card--expanded">
          <div class="bridges-card-header">
            <span class="bridges-card-name">Neue Bridge</span>
          </div>
          <${EditPanel}
            initial=${createInitial}
            isNew=${true}
            saving=${saving}
            errorMsg=${errorMsg}
            errorStderr=${errorStderr}
            onSave=${handleSaveNew}
            onCancel=${() => { setCreating(false); clearError(); }}
          />
        </div>
      `}

      ${bridges.map(b => html`
        <${BridgeCard}
          key=${b.id}
          bridge=${b}
          statusState=${status[b.connectionName]}
          isExpanded=${expandedId === b.id}
          saving=${saving}
          errorMsg=${expandedId === b.id ? errorMsg : null}
          errorStderr=${expandedId === b.id ? errorStderr : null}
          onToggleExpand=${() => {
            const next = expandedId === b.id ? null : b.id;
            setExpandedId(next);
            setCreating(false);
            clearError();
          }}
          onSave=${handleSaveExisting}
          onDelete=${handleDelete}
        />
      `)}

      ${toast && html`<div class="lox-toast lox-toast--${toast.type}">${toast.text}</div>`}
    </div>
  `;
}
