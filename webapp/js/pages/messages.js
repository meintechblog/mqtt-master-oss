import { html } from 'htm/preact';
import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import {
  messages,
  subscriptions,
  messagesWsConnected,
  messageRate,
  connectMessagesWs,
  disconnectMessagesWs,
  subscribeTopic,
  unsubscribeTopic,
  clearMessages,
} from '../lib/ws-messages-client.js';
import { flattenJsonFields, extractField, applyTransform } from '../lib/json-fields.js';
import { TopicBrowserPanel } from '../components/topic-browser.js';

function formatTimestamp(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

// ── Binding creation dialog ─────────────────────────────────────
function CreateBindingDialog({ topic, value, onClose }) {
  const [plugins, setPlugins] = useState([]);
  const [controls, setControls] = useState([]);
  const [selectedPlugin, setSelectedPlugin] = useState('');
  const [jsonField, setJsonField] = useState('value');
  const [fieldFilter, setFieldFilter] = useState('');
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [targetUuid, setTargetUuid] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const initialPickRef = useRef(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/plugins').then(r => r.json()),
    ]).then(async ([pluginData]) => {
      const running = pluginData.filter(p => p.status === 'running');
      setPlugins(running);
      // Load controls from the first loxone-type plugin
      const loxonePlugin = pluginData.find(p => p.type === 'loxone' && p.status === 'running');
      let controlData = [];
      if (loxonePlugin) {
        try {
          controlData = await fetch(`/api/plugins/${loxonePlugin.id}/controls/detailed`).then(r => r.json());
        } catch { /* ignore */ }
      }
      if (running.length > 0) setSelectedPlugin(running[0].id);
      setControls(controlData);
    }).catch(() => {});

    // Make sure the topic is actively subscribed so the live preview keeps
    // updating even if the user opened the dialog from the Topic Browser
    // without an active subscription. We only undo our own subscription on
    // close — any pre-existing wildcard or exact subscription stays.
    const wasAlreadySubscribed = subscriptions.value.has(topic);
    if (!wasAlreadySubscribed) {
      subscribeTopic(topic);
    }
    return () => {
      if (!wasAlreadySubscribed) {
        unsubscribeTopic(topic);
      }
    };
  }, []);

  // Live payload: prefer the most recent matching message from the global
  // stream so values update as MQTT messages arrive. Fall back to the static
  // sample passed in when the dialog opened (in case the stream hasn't yielded
  // a fresh message for this topic yet).
  const latest = messages.value.find(m => m.topic === topic);
  const livePayload = latest ? latest.payload : value;
  const liveTs = latest ? latest.timestamp : null;
  const fields = flattenJsonFields(livePayload);

  // Pre-select the first numeric leaf as soon as we have data — but only once,
  // so a live update doesn't yank the user's current selection away.
  if (!initialPickRef.current && fields.length > 0) {
    const firstNumeric = fields.find(f => f.type === 'number');
    if (firstNumeric) setJsonField(firstNumeric.path);
    initialPickRef.current = true;
  }

  const lowerField = jsonField.toLowerCase();
  const autoTransform = (lowerField.includes('_w') || lowerField.includes('power')) ? 'div1000' : '';

  const visibleFields = fields.filter(f => {
    if (!showAllTypes && f.type !== 'number') return false;
    if (fieldFilter && !f.path.toLowerCase().includes(fieldFilter.toLowerCase())) return false;
    return true;
  });
  const numericCount = fields.filter(f => f.type === 'number').length;
  const hiddenNonNumeric = fields.length - numericCount;
  // Group leaves by their first path segment so nested objects render as
  // labelled clusters instead of one giant button wall.
  const grouped = visibleFields.reduce((acc, f) => {
    const head = f.path.includes('.') ? f.path.split('.')[0] : '';
    (acc[head] = acc[head] || []).push(f);
    return acc;
  }, {});
  const groupOrder = Object.keys(grouped);

  const filteredControls = controls.filter(c => {
    if (!targetFilter) return true;
    const s = targetFilter.toLowerCase();
    return c.name.toLowerCase().includes(s) || c.room.toLowerCase().includes(s) || c.type.toLowerCase().includes(s);
  });

  const handleCreate = async () => {
    if (!targetUuid) { setError('Select a Loxone target'); return; }
    setCreating(true);
    setError('');
    try {
      const res = await fetch(`/api/plugins/${selectedPlugin}/bindings`);
      const existing = await res.json();
      const targetCtrl = controls.find(c => c.uuid === targetUuid) || controls.flatMap(c => c.subControls || []).find(s => s.uuid === targetUuid);
      const newBinding = {
        id: 'b-' + Date.now(),
        enabled: true,
        mqttTopic: topic,
        jsonField,
        targetUuid,
        transform: autoTransform,
        keepaliveMs: 30000,
        // Label = JSON path. The target's Loxone control name is shown
        // separately on the binding card so no need to prefix it here.
        label: jsonField,
      };
      const saveRes = await fetch(`/api/plugins/${selectedPlugin}/bindings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([...existing, newBinding]),
      });
      if (!saveRes.ok) throw new Error((await saveRes.json()).error);
      setSuccess(true);
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  if (success) {
    return html`
      <div class="ve-modal-overlay">
        <div class="ve-modal" style="text-align:center;padding:32px;">
          <div style="font-size:24px;color:var(--ve-green);margin-bottom:8px;">✓</div>
          <div style="font-size:14px;">Binding created</div>
        </div>
      </div>
    `;
  }

  return html`
    <div class="ve-modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="ve-modal" style="max-width:540px;">
        <div class="ve-modal-title">Create Input Binding</div>
        <div style="margin-bottom:12px;">
          <div class="ve-modal-field-label">Source Topic</div>
          <div style="font-family:var(--ve-font-mono);font-size:13px;color:var(--ve-blue);padding:6px 0;">${topic}</div>
        </div>
        ${fields.length > 0 && html`
          <div style="margin-bottom:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div class="ve-modal-field-label" style="display:flex;align-items:center;gap:6px;">
                <span>JSON Field</span>
                ${liveTs && html`
                  <span class="bind-live-pulse" key=${liveTs} title=${`Live from ${topic}`}></span>
                  <span style="font-size:10px;color:var(--ve-text-dim);font-weight:normal;text-transform:none;letter-spacing:0;">live</span>
                `}
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                ${hiddenNonNumeric > 0 && html`
                  <label style="font-size:11px;color:var(--ve-text-dim);display:flex;align-items:center;gap:4px;cursor:pointer;">
                    <input
                      type="checkbox"
                      checked=${showAllTypes}
                      onChange=${(e) => setShowAllTypes(e.target.checked)}
                      style="margin:0;"
                    />
                    show non-numeric (${hiddenNonNumeric})
                  </label>
                `}
              </div>
            </div>
            ${fields.length > 6 && html`
              <input
                class="ve-modal-input"
                style="margin:4px 0 6px;font-size:12px;"
                placeholder="Filter fields..."
                value=${fieldFilter}
                onInput=${(e) => setFieldFilter(e.target.value)}
              />
            `}
            <div style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-top:4px;">
              ${groupOrder.map(group => html`
                <div key=${group || '_root'}>
                  ${group && html`
                    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--ve-text-dim);margin:4px 0 4px 2px;">${group}</div>
                  `}
                  <div style="display:flex;flex-wrap:wrap;gap:6px;">
                    ${grouped[group].map(f => {
                      const leaf = group ? f.path.slice(group.length + 1) : f.path;
                      const isStr = f.type !== 'number';
                      const display = typeof f.value === 'number'
                        ? (Math.abs(f.value) >= 1000 ? f.value.toLocaleString() : f.value)
                        : String(f.value);
                      return html`
                        <button
                          key=${f.path}
                          type="button"
                          class="lox-push-btn ${jsonField === f.path ? 'lox-push-btn--active' : ''}"
                          style="font-size:12px;padding:4px 10px;${isStr ? 'opacity:0.75;' : ''}"
                          title=${f.path}
                          onClick=${() => setJsonField(f.path)}
                        >
                          ${leaf}
                          <span
                            class="bind-field-val"
                            key=${liveTs ? `${f.path}:${liveTs}` : f.path}
                          >${display}</span>
                        </button>
                      `;
                    })}
                  </div>
                </div>
              `)}
              ${visibleFields.length === 0 && html`
                <div style="font-size:12px;color:var(--ve-text-dim);padding:6px 0;">No matching fields.</div>
              `}
            </div>
            <div style="margin-top:8px;">
              <div style="font-size:11px;color:var(--ve-text-dim);margin-bottom:2px;">
                Custom path (dot notation, e.g. <code>ENERGY.Power</code>)
              </div>
              <input
                class="ve-modal-input"
                style="font-family:var(--ve-font-mono);font-size:12px;"
                value=${jsonField}
                onInput=${(e) => setJsonField(e.target.value)}
                placeholder="value"
              />
            </div>
          </div>
        `}
        ${fields.length === 0 && html`
          <div style="margin-bottom:12px;">
            <div class="ve-modal-field-label">JSON Field</div>
            <div style="font-size:11px;color:var(--ve-text-dim);margin-bottom:4px;">
              Payload is not JSON — type the field name or leave as <code>value</code>.
            </div>
            <input class="ve-modal-input" value=${jsonField} onInput=${(e) => setJsonField(e.target.value)} placeholder="value" />
          </div>
        `}
        ${jsonField && html`
          <div class="bind-preview">
            <div class="bind-preview-label">
              <span>Live Preview</span>
              ${liveTs && html`<span class="bind-live-pulse" key=${`prev:${liveTs}`}></span>`}
            </div>
            ${(() => {
              let parsed = livePayload;
              if (typeof livePayload === 'string') {
                try { parsed = JSON.parse(livePayload); } catch { parsed = null; }
              }
              const raw = parsed != null
                ? (typeof parsed === 'object' ? extractField(parsed, jsonField) : parsed)
                : null;
              const transformed = autoTransform ? applyTransform(raw, autoTransform) : raw;
              const fmt = (v) => {
                if (v == null) return '—';
                if (typeof v === 'number') {
                  const rounded = Math.round(v * 1000) / 1000;
                  return Math.abs(rounded) >= 1000 ? rounded.toLocaleString() : String(rounded);
                }
                return String(v);
              };
              const isMissing = raw == null;
              return html`
                <div class="bind-preview-body">
                  <div class="bind-preview-row">
                    <span class="bind-preview-key">${jsonField}</span>
                    <span
                      class="bind-preview-val ${isMissing ? 'bind-preview-val--missing' : ''}"
                      key=${liveTs ? `raw:${liveTs}` : 'raw'}
                    >${fmt(raw)}</span>
                  </div>
                  ${autoTransform && !isMissing && html`
                    <div class="bind-preview-row bind-preview-row--out">
                      <span class="bind-preview-key">→ ${autoTransform}</span>
                      <span
                        class="bind-preview-val bind-preview-val--out"
                        key=${liveTs ? `out:${liveTs}` : 'out'}
                      >${fmt(transformed)}</span>
                    </div>
                  `}
                  ${isMissing && html`
                    <div class="bind-preview-hint">
                      Path not found in current payload — check the dotted notation.
                    </div>
                  `}
                </div>
              `;
            })()}
          </div>
        `}
        <div style="margin-bottom:12px;">
          <div class="ve-modal-field-label">Target Plugin</div>
          <select class="bind-select" style="width:100%;margin-top:4px;" value=${selectedPlugin} onChange=${(e) => setSelectedPlugin(e.target.value)}>
            ${plugins.map(p => html`<option key=${p.id} value=${p.id}>${p.displayName || p.name} (${p.name})</option>`)}
          </select>
        </div>
        <div style="margin-bottom:12px;">
          <div class="ve-modal-field-label">Target Control</div>
          <input
            type="text"
            class="bind-input"
            style="width:100%;margin:4px 0 6px"
            placeholder="Filter controls..."
            value=${targetFilter}
            onInput=${(e) => setTargetFilter(e.target.value)}
          />
          <div style="max-height:180px;overflow-y:auto;">
            ${filteredControls.map(ctrl => html`
              <div key=${ctrl.uuid}>
                <div
                  class="tb-row ${targetUuid === ctrl.uuid ? 'tb-row--selected' : ''}"
                  style="cursor:pointer;padding:6px 10px;"
                  onClick=${() => setTargetUuid(ctrl.uuid)}
                >
                  <span class="tb-name" style="flex:1">${ctrl.name}</span>
                  <span style="font-size:11px;color:var(--ve-text-dim)">${ctrl.type} · ${ctrl.room}</span>
                </div>
                ${(ctrl.subControls || []).map(sub => html`
                  <div
                    key=${sub.uuid}
                    class="tb-row ${targetUuid === sub.uuid ? 'tb-row--selected' : ''}"
                    style="cursor:pointer;padding:6px 10px 6px 26px;"
                    onClick=${() => setTargetUuid(sub.uuid)}
                  >
                    <span class="tb-name" style="flex:1">${sub.name}</span>
                    <span style="font-size:11px;color:var(--ve-text-dim)">${sub.type}</span>
                  </div>
                `)}
              </div>
            `)}
          </div>
        </div>
        ${autoTransform && html`
          <div style="font-size:12px;color:var(--ve-orange);margin-bottom:8px;">Transform: ÷ 1000 (W → kW) will be applied</div>
        `}
        ${error && html`<div style="font-size:13px;color:var(--ve-red);margin-bottom:8px;">${error}</div>`}
        <div class="ve-modal-actions">
          <button class="lox-push-btn" onClick=${onClose}>Cancel</button>
          <button class="lox-cmd-btn" disabled=${!selectedPlugin || !jsonField || !targetUuid || creating} onClick=${handleCreate}>
            ${creating ? 'Creating...' : 'Create Binding'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Main Messages page ──────────────────────────────────────────
export function Messages() {
  const [topicInput, setTopicInput] = useState('');
  const [filter, setFilter] = useState('');
  const [userScrolled, setUserScrolled] = useState(false);
  const [view, setView] = useState('stream'); // 'stream' or 'browser'
  const [bindDialog, setBindDialog] = useState(null);
  const listRef = useRef(null);

  useEffect(() => {
    connectMessagesWs();
    return () => disconnectMessagesWs();
  }, []);

  const subs = subscriptions.value;
  const isSubscribed = subs.has(topicInput);
  const rate = messageRate.value;
  const allMessages = messages.value;

  const displayedMessages = filter
    ? allMessages.filter(m => m.topic.includes(filter) || (typeof m.payload === 'string' && m.payload.includes(filter)))
    : allMessages;

  // Auto-scroll to top (newest) when not manually scrolled
  useEffect(() => {
    if (!userScrolled && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [allMessages.length, userScrolled]);

  const handleSubscribe = useCallback(() => {
    const topic = topicInput.trim();
    if (!topic) return;
    if (subs.has(topic)) unsubscribeTopic(topic);
    else subscribeTopic(topic);
  }, [topicInput, subs]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') handleSubscribe();
  }, [handleSubscribe]);

  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    setUserScrolled(listRef.current.scrollTop !== 0);
  }, []);

  const handleRemoveSub = useCallback((topic) => {
    unsubscribeTopic(topic);
  }, []);

  const handleCreateBinding = useCallback((topic, value) => {
    setBindDialog({ topic, value });
  }, []);

  const hasSubscriptions = subs.size > 0;
  const hasMessages = allMessages.length > 0;

  return html`
    <div>
      <h1 class="page-header">Live Messages</h1>

      <div class="ve-panel msg-controls">
        <input
          type="text"
          class="msg-topic-input"
          placeholder="Topic pattern, e.g. # or venus/grid/#"
          value=${topicInput}
          onInput=${(e) => setTopicInput(e.target.value)}
          onKeyDown=${handleKeyDown}
        />
        <button
          class=${`msg-btn ${isSubscribed ? 'msg-btn--unsubscribe' : 'msg-btn--subscribe'}`}
          onClick=${handleSubscribe}
          disabled=${!topicInput.trim()}
        >${isSubscribed ? 'Unsubscribe' : 'Subscribe'}</button>
        <button class="msg-btn msg-btn--clear" onClick=${() => clearMessages()}>Clear</button>
        <span class="msg-rate" style=${rate > 0 ? 'color: var(--ve-green)' : ''}>${rate} msg/s</span>
      </div>

      ${hasSubscriptions && html`
        <div class="msg-subscriptions">
          ${[...subs].map(topic => html`
            <span class="msg-pill" key=${topic}>
              ${topic}
              <button class="msg-pill-close" onClick=${() => handleRemoveSub(topic)} title="Unsubscribe">x</button>
            </span>
          `)}
        </div>
      `}

      <!-- View toggle -->
      <div class="msg-view-toggle">
        <button class="msg-view-btn ${view === 'stream' ? 'active' : ''}" onClick=${() => setView('stream')}>Stream</button>
        <button class="msg-view-btn ${view === 'browser' ? 'active' : ''}" onClick=${() => setView('browser')}>Browser</button>
      </div>

      ${view === 'stream' && html`
        <input
          type="text"
          class="msg-filter"
          placeholder="Filter messages..."
          value=${filter}
          onInput=${(e) => setFilter(e.target.value)}
        />
        <div class="ve-card msg-list" ref=${listRef} onScroll=${handleScroll}>
          ${!hasSubscriptions && !hasMessages && html`
            <div class="msg-empty">Subscribe to a topic pattern to start seeing messages.</div>
          `}
          ${hasSubscriptions && !hasMessages && html`
            <div class="msg-empty">Waiting for messages on ${[...subs].join(', ')}...</div>
          `}
          ${displayedMessages.map((m, i) => html`
            <div class="msg-row" key=${`${m.timestamp}-${i}`}>
              <span class="msg-timestamp">${formatTimestamp(m.timestamp)}</span>
              <span class="msg-topic">${m.topic}</span>
              <span class="msg-payload">${typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}</span>
            </div>
          `)}
        </div>
      `}

      ${view === 'browser' && html`
        <${TopicBrowserPanel}
          actionLabel="+Bind"
          onSelect=${(topic, value, payload) => handleCreateBinding(topic, payload ?? value)}
        />
      `}

      ${bindDialog && html`
        <${CreateBindingDialog}
          topic=${bindDialog.topic}
          value=${bindDialog.value}
          onClose=${() => setBindDialog(null)}
        />
      `}
    </div>
  `;
}
