import { html } from 'htm/preact';
import { useEffect, useState, useCallback } from 'preact/hooks';
import { fetchInputBindings, saveInputBindings, fetchLoxoneControlsDetailed, fetchBindingsHealth } from '../lib/api-client.js';
import { TRANSFORMS, suggestTransform, previewTransform, UNITS, suggestUnit } from '../lib/transform-utils.js';
import { TopicBrowserPanel } from '../components/topic-browser.js';
import { topicToSource, isRawScalarPayload, detectSourceMode } from '../lib/topic-to-source.js';
import { copyToClipboard } from '../lib/clipboard.js';
import {
  buildPluginExport,
  validatePluginImport,
  mergeBindingArrays,
  copyBindingArrays,
  downloadJson,
  pickJsonFile,
} from '../lib/bindings-io.js';

// ── Existing binding row (compact, expandable for edit) ────────
/** Extract the primary live value from a control's states */
function liveValue(ctrl) {
  if (!ctrl || !ctrl.states) return null;
  const s = ctrl.states;
  if (s.value != null && s.value.value != null) return s.value.value;
  if (s.actual != null && s.actual.value != null) return s.actual.value;
  if (s.active != null && s.active.value != null) return s.active.value;
  if (s.position != null && s.position.value != null) return s.position.value;
  return null;
}

/**
 * Render a number the way the binding actually transmits it: at most 3
 * decimals, with trailing zeros stripped. `21.400` → `21.4`, `21.000` → `21`.
 * Mirrors the `Math.round(v * 1000) / 1000 → String(v)` step in binding-utils
 * so the UI doesn't lie about what reaches Loxone.
 */
function fmtNumNice(n) {
  if (n == null) return null;
  if (typeof n !== 'number') return String(n);
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return parseFloat(n.toFixed(3)).toString();
}

function fmtAge(ts) {
  if (!ts) return null;
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 1) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/**
 * Conservative suffix-match heuristic for topic-drift detection. 2 segments
 * by default; 3 when the trailing segment is a generic suffix like `state`
 * that would otherwise produce too-loose matches across unrelated devices.
 *
 * Examples:
 *   inverter-proxy/device/abc123def456/state → device/abc123def456/state
 *   tasmota/wasserboiler/SENSOR                 → wasserboiler/SENSOR
 *   shellies/foo/relay/0/power                  → 0/power
 *
 * Returns null when the topic has fewer than 2 segments (cannot match a tail
 * of length < 2).
 */
// Trailing segments that are shared across many unrelated devices, so a 2-seg
// suffix would over-match. When the tail is one of these, widen to 3 segments
// to keep the suffix specific. Compared case-insensitively: Tasmota publishes
// `STATE`/`RESULT`/`LWT` uppercase, HA/Venus-style topics use lowercase. (Note:
// `tele` is a Tasmota *prefix*, never a trailing segment — intentionally absent.)
const GENERIC_TAIL_SUFFIXES = new Set(['state', 'availability', 'status', 'lwt', 'result']);

function topicSuffix(topic) {
  if (typeof topic !== 'string' || !topic) return null;
  const parts = topic.split('/');
  if (parts.length < 2) return null;
  const tail = parts[parts.length - 1];
  const segments = GENERIC_TAIL_SUFFIXES.has(tail.toLowerCase()) ? 3 : 2;
  if (parts.length < segments) return parts.slice(-2).join('/');
  return parts.slice(-segments).join('/');
}

function BindingCard({ binding, stats, controls, onRemove, onToggle, onUpdate, healthIssue = null }) {
  const [expanded, setExpanded] = useState(false);
  // Cached cached-payload snapshot for actionable diagnostics. Populated only
  // while the binding is stuck in a `field_missing` / `json_parse_failed`
  // state — we fetch /api/mqtt/topics, find the entry for this binding's
  // topic, and store `{ payload, ts }`. Refreshed every 5s while the bad
  // state persists; cleared once it recovers. Null = not fetched yet / cache
  // miss / fetch error (we fall back to the dim "no message yet" hint).
  const [livePayload, setLivePayload] = useState(null);
  // Topic-drift suggestion: when the binding is stale/silent but a live topic
  // with the same trailing identifier exists in /api/mqtt/topics (fresh ts,
  // different leading prefix), surface the candidate so the user can rewire
  // with one click. Null = no match / cache miss / fetch error.
  const [driftMatch, setDriftMatch] = useState(null);
  const lastReason = stats?.lastReason;
  const isStuck = lastReason === 'field_missing' || lastReason === 'json_parse_failed';
  const isStaleLike = healthIssue?.reason === 'input_stale' || healthIssue?.reason === 'input_silent';
  useEffect(() => {
    if (!isStuck && !isStaleLike) {
      // Recovered (or never stuck/stale) — drop any cached snapshot + drift hint.
      if (livePayload !== null) setLivePayload(null);
      if (driftMatch !== null) setDriftMatch(null);
      return undefined;
    }
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/mqtt/topics');
        if (!r.ok) return;
        const list = await r.json();
        // Defensive: support both array and { topics: [...] } shapes.
        const topics = Array.isArray(list) ? list : (list?.topics || []);
        if (isStuck) {
          const entry = topics.find(t => t && t.topic === binding.mqttTopic);
          if (!cancelled && entry) {
            setLivePayload({ payload: entry.payload ?? entry.value ?? null, ts: entry.ts || null });
          }
        }
        // Drift detection: only meaningful when the binding is stale-like.
        if (isStaleLike) {
          const myTail = topicSuffix(binding.mqttTopic);
          if (myTail) {
            // Strip the matched tail off MY topic so we can detect a "different
            // leading prefix". `endsWith` + slice avoids regex-escape pitfalls
            // (topics can contain `+`, `.`, etc. — though MQTT topic rules
            // exclude `+` and `#` in binding-stored topics, defensive anyway).
            const myPrefix = binding.mqttTopic.endsWith(myTail)
              ? binding.mqttTopic.slice(0, binding.mqttTopic.length - myTail.length)
              : '';
            const FRESH_MS = 5 * 60 * 1000;
            const now = Date.now();
            const match = topics.find(t =>
              t && typeof t.topic === 'string'
              && t.topic !== binding.mqttTopic
              && topicSuffix(t.topic) === myTail
              && (!myPrefix || !t.topic.startsWith(myPrefix))
              && t.ts && (now - t.ts) < FRESH_MS,
            );
            if (!cancelled) setDriftMatch(match ? { topic: match.topic, ts: match.ts } : null);
          } else if (!cancelled && driftMatch !== null) {
            setDriftMatch(null);
          }
        }
      } catch {
        // Defensive fallback: keep the existing dim hint, do not crash.
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 5000);
    return () => { cancelled = true; clearInterval(id); };
    // We intentionally re-run when the gate inputs change; we do NOT depend
    // on livePayload/driftMatch (would cause a fetch storm).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStuck, isStaleLike, binding.mqttTopic]);
  const target = controls.find(c => c.uuid === binding.targetUuid);
  const targetSub = controls.flatMap(c => c.subControls || []).find(s => s.uuid === binding.targetUuid);
  const targetCtrl = target || targetSub;
  const targetName = targetCtrl ? targetCtrl.name : binding.targetUuid.substring(0, 12) + '…';
  // Loxone-side metadata: room + type, when we resolved the control. Useful
  // both as proof that the UUID matches a real device and as the same
  // identifier the Loxone app shows.
  const targetMeta = targetCtrl
    ? [targetCtrl.room && `Raum: ${targetCtrl.room}`, targetCtrl.type].filter(Boolean).join(' · ')
    : null;
  const targetPluginName = targetCtrl?._pluginName || null;
  const transform = TRANSFORMS.find(t => t.value === binding.transform);
  // `??` (not `||`) so an explicit `keepaliveMs: 0` (heartbeat disabled by
  // user) survives the UI round-trip and isn't silently replaced with 30s.
  const keepalive = binding.keepaliveMs ?? binding.intervalMs ?? 30000;
  const keepaliveSec = Math.round(keepalive / 1000);
  // Prefer the loxoneValue baked into the stats response — it was read at
  // the same instant as `stat.value`, so any drift between "we sent" and
  // "Loxone reports" reflects reality rather than poll-cadence skew.
  const liveFromStats = stats?.loxoneValue;
  const live = liveFromStats != null ? liveFromStats : liveValue(targetCtrl);
  const liveStr = fmtNumNice(live);

  // Live MQTT-side stats: what the binding pushed last and how often.
  const stat = stats || {};
  const sentValueStr = fmtNumNice(stat.value);
  const recentSendMs = stat.lastSentAt ? Date.now() - stat.lastSentAt : Infinity;
  const recentRecvMs = stat.lastReceivedAt ? Date.now() - stat.lastReceivedAt : Infinity;
  const flashSend = recentSendMs < 3000;
  const flashRecv = recentRecvMs < 3000;
  // Connection diagnosis line
  let diagText = null;
  let diagTone = 'dim';
  if (stat.lastError) {
    diagText = stat.lastError;
    diagTone = 'red';
  } else if (!stat.lastReceivedAt) {
    diagText = 'no MQTT message received yet';
    diagTone = 'dim';
  } else if (!stat.lastSentAt) {
    diagText = `received ${stat.recvCount}× but never forwarded — ${stat.lastReason || 'unknown'}`;
    diagTone = 'orange';
  } else if (stat.lastReason === 'dedup') {
    diagText = `unchanged value, holding until keepalive (${fmtAge(stat.lastSentAt)})`;
    diagTone = 'dim';
  } else {
    diagText = `forwarded ${stat.sendCount}× · last ${stat.lastReason || 'sent'} ${fmtAge(stat.lastSentAt)}`;
    diagTone = 'green';
  }

  // Payload-aware actionable diagnostic for stuck bindings. Only fires when
  // we're in `field_missing` / `json_parse_failed` AND we successfully
  // snapshotted the live cached payload. Falls back to the plain `diagText`
  // when /api/mqtt/topics doesn't have an entry for this topic (defensive —
  // no crash if the fetch failed or the topic isn't cached).
  let richDiag = null;
  if (isStuck && livePayload && livePayload.payload != null) {
    const rawPayload = livePayload.payload;
    const sampleStr = (() => {
      const s = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
      return String(s ?? '').substring(0, 60);
    })();
    if (lastReason === 'json_parse_failed') {
      richDiag = {
        text: `Payload is not JSON (sample: \`${sampleStr}\`). Switch to raw mode?`,
        showSwitchToRaw: true,
        tone: 'orange',
      };
    } else if (lastReason === 'field_missing') {
      if (isRawScalarPayload(rawPayload)) {
        richDiag = {
          text: `Payload looks like a raw value (\`${sampleStr}\`). The field \`${binding.jsonField}\` doesn't apply here — switch to raw mode?`,
          showSwitchToRaw: true,
          tone: 'orange',
        };
      } else {
        // JSON object — list available top-level keys to help the user pick
        // a different path via the now-editable jsonField input.
        let available = '';
        try {
          const parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            available = Object.keys(parsed).join(', ');
          }
        } catch {
          // Already handled by the json_parse_failed branch — defensive only.
        }
        richDiag = {
          text: `Field \`${binding.jsonField}\` is not in the payload. Available: \`${available || '(none)'}\`.`,
          showSwitchToRaw: false,
          tone: 'orange',
        };
      }
    }
  }
  if (richDiag) {
    diagText = richDiag.text;
    diagTone = richDiag.tone;
  }

  // Aggregate-health overlay. The page banner already says "⚠ N bindings with
  // warning" — without this overlay the per-card diag line would still render
  // green `forwarded N×` because the keepalive heartbeat keeps `lastSentAt`
  // fresh even when the source topic has gone silent. Precedence:
  //   1. `stat.lastError` (red live signal) — freshest, keeps winning.
  //   2. resolved `richDiag` (field_missing / json_parse_failed with cached
  //      payload) — has the actionable "Switch to raw" button + key-list hint,
  //      strictly more useful than the health detail. Keeps winning.
  //   3. otherwise: if a health issue exists for this binding, surface its
  //      German `detail` with the matching tone (orange for warn, red for
  //      error). Consistent voice with the banner.
  const liveDiagOwnsLine = !!stat.lastError || !!richDiag;
  if (!liveDiagOwnsLine && healthIssue) {
    diagText = healthIssue.detail;
    diagTone = healthIssue.severity === 'error' ? 'red' : 'orange';
  }

  return html`
    <div class="bind-card ${binding.enabled ? '' : 'bind-card--disabled'}">
      <div class="bind-card-header">
        <input
          type="checkbox"
          checked=${binding.enabled}
          onChange=${() => onToggle(binding.id)}
          class="lox-control-toggle"
        />
        <span class="bind-card-label" onClick=${() => setExpanded(!expanded)} style="cursor:pointer">
          ${(() => {
            // Strip a leading "<targetName> " prefix from legacy auto-generated
            // labels so existing bindings don't show "Wasserboiler
            // Wasserboiler.Temperature" — display-only, the stored label is
            // unchanged so saves still round-trip.
            const raw = binding.label || binding.id;
            const ctrlName = targetCtrl?.name;
            if (ctrlName) {
              const prefix = ctrlName + ' ';
              if (raw.toLowerCase().startsWith(prefix.toLowerCase())) {
                return raw.slice(prefix.length);
              }
            }
            return raw;
          })()}
        </span>
        <button class="bind-remove" onClick=${() => onRemove(binding.id)} title="Remove">×</button>
      </div>
      <div class="bind-card-flow-grid" onClick=${() => setExpanded(!expanded)} style="cursor:pointer">
        <!-- FROM: MQTT source -->
        <div class="bind-flow-col bind-flow-col--from">
          <span class="bind-flow-label">From MQTT</span>
          <span class="bind-flow-topic ${flashRecv ? 'bind-flash' : ''}">${binding.mqttTopic}</span>
          <span class="bind-flow-field">${binding.jsonField ? '.' + binding.jsonField : '[raw]'}</span>
        </div>

        <!-- VALUE: the bridge — what we last forwarded -->
        <div class="bind-flow-col bind-flow-col--value">
          <span class="bind-flow-arrow">→</span>
          ${transform && transform.value && html`
            <span class="bind-flow-transform" title="transform applied before forwarding">${transform.label}</span>
          `}
          <span class="bind-flow-value ${flashSend ? 'bind-flash' : ''}" title="last value our plugin forwarded to Loxone via jdev/sps/io">
            ${sentValueStr ?? '—'}${binding.unit ? html`<span class="bind-flow-unit">${binding.unit}</span>` : ''}
          </span>
          <span class="bind-flow-arrow">→</span>
        </div>

        <!-- TO: target control (usually a Loxone Miniserver, possibly via the bridge plugin) -->
        <div class="bind-flow-col bind-flow-col--to">
          <span class="bind-flow-label">${targetPluginName ? `To ${targetPluginName}` : 'To Loxone'}</span>
          <span class="bind-flow-target-name" title=${binding.targetUuid}>
            ${targetName}
            ${targetCtrl?.category && html`<span class="bind-flow-target-category"> · ${targetCtrl.category}</span>`}
          </span>
          ${targetCtrl?.description && html`
            <span class="bind-flow-target-desc" title="Loxone Bezeichnung / description">${targetCtrl.description}</span>
          `}
          ${targetMeta && html`<span class="bind-flow-target-meta">${targetMeta}</span>`}
          <span
            class="bind-flow-target-uuid"
            title="Loxone UUID — click to copy"
            onClick=${(e) => { e.stopPropagation(); copyToClipboard(binding.targetUuid); }}
          >${binding.targetUuid}</span>
          ${liveStr != null && html`
            <span class="bind-flow-live" title="The value Loxone is currently reporting for this control. May differ from the value we sent if the control is fed by another source (e.g. a hardware 1-Wire sensor) — common with InfoOnlyAnalog read-only displays.">
              Loxone reports: ${liveStr}${binding.unit ? ' ' + binding.unit : ''}
            </span>
          `}
        </div>
      </div>
      ${diagText && html`
        <div class="bind-card-diag bind-card-diag--${diagTone}">
          ${diagText}
          ${richDiag && richDiag.showSwitchToRaw && html`
            <button
              class="lox-cmd-btn--small lox-cmd-btn"
              type="button"
              style="margin-left:8px"
              title="Clear jsonField — forward the entire payload as-is"
              onClick=${(e) => { e.stopPropagation(); onUpdate(binding.id, 'jsonField', ''); }}
            >Switch to raw</button>
          `}
          ${driftMatch && healthIssue && (healthIssue.reason === 'input_stale' || healthIssue.reason === 'input_silent') && html`
            <div style="margin-top:4px;font-size:12px">
              Live-Topic mit gleicher Endung gefunden: <code>${driftMatch.topic}</code>
              <button
                class="lox-cmd-btn--small lox-cmd-btn"
                type="button"
                style="margin-left:8px"
                title="Binding auf das aktive Topic umschalten — bisheriges Topic wird ersetzt"
                onClick=${(e) => { e.stopPropagation(); onUpdate(binding.id, 'mqttTopic', driftMatch.topic); }}
              >Umschalten</button>
            </div>
          `}
          <span class="bind-card-diag-meta">heartbeat ${keepalive > 0 ? `${keepaliveSec}s` : 'off'}</span>
        </div>
      `}
      ${expanded && html`
        <div class="bind-edit">
          <div class="bind-field-row">
            <div class="bind-field" style="flex:1">
              <label class="bind-field-label">Label</label>
              <input type="text" class="bind-input" value=${binding.label}
                onInput=${(e) => onUpdate(binding.id, 'label', e.target.value)} />
            </div>
            <div class="bind-field">
              <label class="bind-field-label">Transform</label>
              <select class="bind-select" value=${binding.transform || ''}
                onChange=${(e) => onUpdate(binding.id, 'transform', e.target.value)}>
                ${TRANSFORMS.map(t => html`<option key=${t.value} value=${t.value}>${t.label}</option>`)}
              </select>
            </div>
            <div class="bind-field">
              <label class="bind-field-label" title="Display-only — does not affect what's sent to Loxone">Unit</label>
              <select class="bind-select" value=${binding.unit || ''}
                onChange=${(e) => onUpdate(binding.id, 'unit', e.target.value)}>
                ${UNITS.map(u => html`<option key=${u.value} value=${u.value}>${u.label}</option>`)}
              </select>
            </div>
            <div class="bind-field">
              <label
                class="bind-field-label"
                title="Zyklisch: Quelle publisht regelmäßig — input_stale warnt nach 15 Min. Event-driven: Quelle publisht nur bei Änderung (Bewegungsmelder, Türkontakt) — input_stale wird unterdrückt."
              >Quelle</label>
              <select class="bind-select" value=${binding.sourceMode || 'cyclic'}
                onChange=${(e) => onUpdate(binding.id, 'sourceMode', e.target.value)}>
                <option value="cyclic">Zyklisch</option>
                <option value="event">Event-driven</option>
              </select>
            </div>
          </div>
          <div class="bind-field-row" style="margin-top:6px">
            <label class="bind-field-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal">
              <input
                type="checkbox"
                checked=${!!binding.invert}
                onChange=${(e) => onUpdate(binding.id, 'invert', e.target.checked)}
                title="Multiply the post-transform value by −1 before forwarding (Loxone sign convention)"
              />
              Invert sign (× −1)
            </label>
          </div>
          <div class="bind-field-row" style="margin-top:6px">
            <div class="bind-field" style="flex:1">
              <label class="bind-field-label">MQTT Topic</label>
              <input type="text" class="bind-input" value=${binding.mqttTopic} disabled style="opacity:0.6" />
            </div>
            <div class="bind-field">
              <label class="bind-field-label">JSON Field</label>
              <div style="display:flex;gap:4px;align-items:center">
                <input
                  type="text"
                  class="bind-input"
                  value=${binding.jsonField || ''}
                  placeholder="(raw)"
                  onInput=${(e) => onUpdate(binding.id, 'jsonField', e.target.value)}
                  title=${binding.jsonField ? 'Dot-notation path into the JSON payload (e.g. ENERGY.Power)' : 'Roh-Payload: forwarded without JSON extraction'}
                  style="width:120px"
                />
                <button
                  class="lox-cmd-btn--small lox-cmd-btn"
                  type="button"
                  title="Clear field — forward the whole payload as-is"
                  onClick=${() => onUpdate(binding.id, 'jsonField', '')}
                >↺ raw</button>
              </div>
            </div>
          </div>
          <div class="bind-field-row" style="margin-top:6px">
            <div class="bind-field" style="flex:1">
              <label
                class="bind-field-label"
                title="0 = aus. Sonst alle X Sekunden wird der letzte Wert erneut an Loxone gesendet (Default 30s)."
              >
                Heartbeat-Intervall (s)
              </label>
              <input
                type="number"
                min="0"
                step="1"
                class="bind-input"
                style="width:120px"
                value=${keepaliveSec}
                onChange=${(e) => {
                  const sec = Math.max(0, Math.floor(Number(e.target.value) || 0));
                  onUpdate(binding.id, 'keepaliveMs', sec * 1000);
                }}
                title="0 = aus. Sonst alle X Sekunden wird der letzte Wert erneut an Loxone gesendet (Default 30s)."
              />
              <div style="font-size:11px;color:var(--ve-text-dim);margin-top:2px">
                0 = aus · Default 30s
              </div>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

// ── Wizard: Step 1 - Browse MQTT topics ────────────────────────
function StepDiscover({ onSelect }) {
  return html`
    <div class="wiz-step">
      <div class="wiz-step-title">1. Pick MQTT Source</div>
      <div class="wiz-step-desc">
        Click <strong>Use →</strong> on any topic. The browser shows every
        topic seen since the service started, with live values.
      </div>
      <${TopicBrowserPanel}
        actionLabel="Use →"
        title="Available MQTT Topics"
        onSelect=${(topic, _value, payload, ts) => onSelect(topicToSource(topic, payload, ts))}
      />
    </div>
  `;
}

// ── Wizard: Step 2 - Pick field ────────────────────────────────
function StepPickField({ source, onSelect, onBack }) {
  const nameField = source.fields.find(f => f.key === 'name');
  const displayName = nameField ? nameField.sample : source.topic;
  // Free-text fallback for JSON sources: lets the user type any dot-path
  // (e.g. ENERGY.Power, Außen.Temperature) the auto-detect missed. State
  // is per-mount — this component unmounts when the wizard advances to
  // step 3, so no cleanup needed. Quick 260528-4lf.
  const [customPath, setCustomPath] = useState('');

  // Raw-scalar topics have nothing to pick — the only "field" is the
  // payload itself. Surface the auto-detect hint and a single big
  // confirm button so the user understands what's happening (and can
  // back out if they wanted a JSON-extract topic).
  if (source.isRaw) {
    const rawField = source.fields[0];
    return html`
      <div class="wiz-step">
        <div class="wiz-step-title">2. Roh-Payload erkannt</div>
        <div class="wiz-step-desc">
          Diese Topic veröffentlicht keinen JSON-Payload — der Wert wird direkt übernommen.
        </div>
        <div class="wiz-topic-path" style="margin-bottom:12px">${source.topic}</div>
        <div class="wiz-field-list">
          <div class="wiz-field-row" onClick=${() => onSelect(rawField)}>
            <span class="wiz-field-key">${rawField.key}</span>
            <span class="wiz-field-val">${typeof rawField.sample === 'number' ? rawField.sample.toLocaleString() : rawField.sample}</span>
            <span class="wiz-field-hint">raw</span>
          </div>
        </div>
        <button class="lox-cmd-btn--small lox-cmd-btn" style="margin-top:12px" onClick=${onBack}>Back</button>
      </div>
    `;
  }

  // Synthesise a field object from the typed path and advance the wizard.
  // sample: '?' is a intentional sentinel — there's no live payload to
  // sample from, and StepReview renders the literal '?' in the preview
  // row (honest signal "no sample available"). type: 'number' because
  // previewTransform in transform-utils gracefully passes through
  // non-numerics, so this default is safe for both numeric and string
  // leaves.
  const useCustomPath = () => {
    const trimmed = customPath.trim();
    if (!trimmed) return;
    onSelect({ key: trimmed, path: trimmed, type: 'number', sample: '?', isRaw: false });
  };

  return html`
    <div class="wiz-step">
      <div class="wiz-step-title">2. Select Field</div>
      <div class="wiz-step-desc">
        Pick the value to forward from <strong>${displayName}</strong>
      </div>
      <div class="wiz-topic-path" style="margin-bottom:12px">${source.topic}</div>
      <div class="wiz-field-list">
        ${source.fields.filter(f => f.type === 'number').map(f => html`
          <div class="wiz-field-row" key=${f.key} onClick=${() => onSelect(f)}>
            <span class="wiz-field-key">${f.key}</span>
            <span class="wiz-field-val">${typeof f.sample === 'number' ? f.sample.toLocaleString() : f.sample}</span>
            ${suggestTransform(f.key) && html`
              <span class="wiz-field-hint">${TRANSFORMS.find(t => t.value === suggestTransform(f.key))?.label}</span>
            `}
          </div>
        `)}
      </div>
      <div class="bind-field-row" style="margin-top:12px;align-items:flex-end">
        <div class="bind-field" style="flex:1">
          <label
            class="bind-field-label"
            title="Beliebigen Dot-Pfad eingeben — z.B. ENERGY.Power oder Außen.Temperature. Nützlich, wenn der gewünschte Wert oben nicht aufgelistet ist."
          >
            Eigener Pfad
          </label>
          <input
            type="text"
            class="bind-input"
            placeholder="z.B. ENERGY.Power"
            value=${customPath}
            onInput=${(e) => setCustomPath(e.target.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); useCustomPath(); } }}
          />
        </div>
        <button
          class="lox-cmd-btn--small lox-cmd-btn"
          disabled=${customPath.trim() === ''}
          onClick=${useCustomPath}
        >Use →</button>
      </div>
      <button class="lox-cmd-btn--small lox-cmd-btn" style="margin-top:12px" onClick=${onBack}>Back</button>
    </div>
  `;
}

// ── Wizard: Step 3 - Pick Loxone target ────────────────────────
function StepPickTarget({ source, field, controls, existingBindings, onSelect, onBack }) {
  const [search, setSearch] = useState('');
  const [roomFilter, setRoomFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  // Collect unique rooms and types
  const rooms = [...new Set(controls.map(c => c.room).filter(Boolean))].sort();
  const types = [...new Set(controls.map(c => c.type).filter(Boolean))].sort();

  // Set of already-bound target UUIDs
  const boundUuids = new Set(existingBindings.map(b => b.targetUuid));

  const filtered = controls.filter(c => {
    if (roomFilter && c.room !== roomFilter) return false;
    if (typeFilter && c.type !== typeFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!c.name.toLowerCase().includes(s) && !c.type.toLowerCase().includes(s)
        && !c.room.toLowerCase().includes(s)) return false;
    }
    return true;
  });

  return html`
    <div class="wiz-step">
      <div class="wiz-step-title">3. Select Target</div>
      <div class="wiz-step-desc">
        Where should <strong>${field.key}</strong> be sent to?
      </div>
      <div class="wiz-filters">
        <input
          type="text"
          class="bind-input"
          style="flex:1"
          placeholder="Search..."
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
        />
        <select class="bind-select" value=${roomFilter} onChange=${(e) => setRoomFilter(e.target.value)}>
          <option value="">All rooms</option>
          ${rooms.map(r => html`<option key=${r} value=${r}>${r}</option>`)}
        </select>
        <select class="bind-select" value=${typeFilter} onChange=${(e) => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          ${types.map(t => html`<option key=${t} value=${t}>${t}</option>`)}
        </select>
      </div>
      <div class="wiz-target-list">
        ${filtered.map(ctrl => {
          const ctrlBound = boundUuids.has(ctrl.uuid);
          return html`
            <div class="wiz-target-group" key=${ctrl.uuid}>
              <div
                class="wiz-target-row ${ctrlBound ? 'wiz-target-bound' : ''}"
                onClick=${() => { if (!ctrlBound) onSelect(ctrl); }}
              >
                <span class="wiz-target-name">${ctrl.name}</span>
                <span class="wiz-target-meta">${ctrl.type} · ${ctrl.room}</span>
                ${ctrlBound && html`<span class="wiz-target-badge">bound</span>`}
              </div>
              ${(ctrl.subControls || []).map(sub => {
                const subBound = boundUuids.has(sub.uuid);
                return html`
                  <div
                    class="wiz-target-row wiz-target-sub ${subBound ? 'wiz-target-bound' : ''}"
                    key=${sub.uuid}
                    onClick=${() => { if (!subBound) onSelect(sub); }}
                  >
                    <span class="wiz-target-name">${sub.name}</span>
                    <span class="wiz-target-meta">${sub.type}</span>
                    ${subBound && html`<span class="wiz-target-badge">bound</span>`}
                  </div>
                `;
              })}
            </div>
          `;
        })}
      </div>
      <button class="lox-cmd-btn--small lox-cmd-btn" style="margin-top:12px" onClick=${onBack}>Back</button>
    </div>
  `;
}

// ── Wizard: Step 4 - Review & Save ─────────────────────────────
function StepReview({ source, field, target, onSave, onBack }) {
  const nameField = source.fields.find(f => f.key === 'name');
  const deviceName = nameField ? nameField.sample : source.topic.split('/').pop();
  // Raw-payload override: defaults from auto-detect, user can flip it. When
  // checked the binding is saved with `jsonField=''` and the backend treats
  // the entire payload as the value. When unchecked we fall back to the
  // picked JSON field path (only meaningful if the source actually had one).
  const [rawMode, setRawMode] = useState(!!field.isRaw);
  const autoTransform = field.isRaw ? '' : suggestTransform(field.key);
  const [transform, setTransform] = useState(autoTransform);
  // Sign-invert composes with the transform select (raw → transform → invert
  // → round → forwarded). Default off so existing flow is unchanged; user
  // opts in for the Loxone "negative = consumption" convention.
  const [invert, setInvert] = useState(false);
  // Heartbeat interval in seconds (0 = disabled). Stored as seconds in UI state
  // and converted to ms only when saving so the input field never fights with
  // floor()/round() on every keystroke.
  const [heartbeatSec, setHeartbeatSec] = useState(30);
  // Default label = the JSON field path. The target's Loxone control name
  // is rendered separately on the binding card, so we don't prefix it here
  // (otherwise the label reads "Wasserboiler Wasserboiler.Temperature
  // (Wasserboiler)" — three times the same word). For raw payloads the
  // path is empty, so fall back to the topic's last segment.
  const defaultLabel = field.isRaw
    ? source.topic.split('/').pop()
    : field.key.replace(/_/g, ' ');
  const [label, setLabel] = useState(defaultLabel);
  const [unit, setUnit] = useState(field.isRaw ? '' : suggestUnit(field.key));

  const preview = previewTransform(field.sample, transform, invert);

  return html`
    <div class="wiz-step">
      <div class="wiz-step-title">4. Review & Save</div>
      ${rawMode && html`
        <div class="wiz-review-hint" style="margin-bottom:12px;padding:8px 12px;background:var(--ve-bg-soft,#1a1a1a);border-left:3px solid var(--ve-accent,#4af);color:var(--ve-text-dim);font-size:13px;">
          <div>Roh-Payload erkannt — wird direkt übernommen.</div>
          ${source.noPayload && html`
            <div style="margin-top:4px">
              Bisher kein Payload auf diesem Topic gesehen. Das Binding wird den ersten ankommenden Payload 1:1 übernehmen — du kannst es später bearbeiten.
            </div>
          `}
          ${source.emptyJson && html`
            <div style="margin-top:4px">
              Topic publisht ein leeres JSON-Objekt — kein Feld zum Auswählen, das Binding wird den Payload roh weiterleiten.
            </div>
          `}
        </div>
      `}
      <div class="wiz-review-flow">
        <div class="wiz-review-box">
          <div class="wiz-review-label">Source</div>
          <div class="wiz-review-val">${deviceName}</div>
          <div class="wiz-review-sub">${rawMode ? `(raw) = ${field.sample}` : `${field.key} = ${field.sample}`}</div>
        </div>
        <div class="wiz-review-arrow">→</div>
        <div class="wiz-review-box">
          <div class="wiz-review-label">Transform</div>
          <select class="bind-select" value=${transform} onChange=${(e) => setTransform(e.target.value)}>
            ${TRANSFORMS.map(t => html`<option key=${t.value} value=${t.value}>${t.label}</option>`)}
          </select>
          <label class="bind-field-label" style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:6px;font-weight:normal">
            <input
              type="checkbox"
              checked=${invert}
              onChange=${(e) => setInvert(e.target.checked)}
              title="Multiply the post-transform value by −1 before forwarding (Loxone sign convention)"
            />
            Invert sign (× −1)
          </label>
          <div class="wiz-review-sub">Preview: ${preview}</div>
        </div>
        <div class="wiz-review-arrow">→</div>
        <div class="wiz-review-box">
          <div class="wiz-review-label">Target</div>
          <div class="wiz-review-val">${target.name}</div>
          <div class="wiz-review-sub">${target.type}${target.room ? ' · ' + target.room : ''}</div>
        </div>
      </div>
      <div class="bind-field-row" style="margin-top:16px">
        <div class="bind-field" style="flex:1">
          <label class="bind-field-label">Label</label>
          <input type="text" class="bind-input" value=${label} onInput=${(e) => setLabel(e.target.value)} />
        </div>
        <div class="bind-field">
          <label class="bind-field-label" title="Display-only — does not affect what's sent to Loxone">Unit</label>
          <select class="bind-select" value=${unit} onChange=${(e) => setUnit(e.target.value)}>
            ${UNITS.map(u => html`<option key=${u.value} value=${u.value}>${u.label}</option>`)}
          </select>
        </div>
        <div class="bind-field">
          <label
            class="bind-field-label"
            title="0 = aus. Sonst alle X Sekunden wird der letzte Wert erneut an Loxone gesendet (Default 30s)."
          >
            Heartbeat-Intervall (s)
          </label>
          <input
            type="number"
            min="0"
            step="1"
            class="bind-input"
            style="width:100px"
            value=${heartbeatSec}
            onInput=${(e) => setHeartbeatSec(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            title="0 = aus. Default 30s."
          />
        </div>
      </div>
      <div class="bind-field-row" style="margin-top:8px">
        <label class="bind-field-label" style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input
            type="checkbox"
            checked=${rawMode}
            disabled=${field.isRaw}
            title=${field.isRaw ? 'Source publishes a raw payload — cannot extract a JSON field' : 'Forward the entire payload instead of extracting a JSON field'}
            onChange=${(e) => setRawMode(e.target.checked)}
          />
          Roh-Payload (forward entire payload, ignore JSON field)
        </label>
      </div>
      <div class="bind-actions" style="margin-top:16px">
        <button class="lox-cmd-btn--small lox-cmd-btn" onClick=${onBack}>Back</button>
        <button class="lox-cmd-btn" onClick=${() => onSave({
          id: 'b-' + Date.now(),
          enabled: true,
          mqttTopic: source.topic,
          // Raw mode: empty jsonField tells the backend to forward the full
          // payload (binding-utils.js raw-mode branch). Otherwise stash the
          // dot-notation path the user picked in step 2.
          jsonField: rawMode ? '' : field.key,
          targetUuid: target.uuid,
          transform,
          invert,
          keepaliveMs: heartbeatSec * 1000,
          label,
          unit,
          // Auto-seed sourceMode from the topic so Tasmota stat/ event-driven
          // bindings don't trip `input_stale` warnings 15 min after creation
          // (quick 260528-4lf). User can still flip this in the per-binding
          // edit panel that 260528-37o shipped.
          sourceMode: detectSourceMode(source.topic),
        })}>Save Binding</button>
      </div>
      <div style="font-size:12px;color:var(--ve-text-dim);margin-top:8px;">
        Values are sent instantly when they change. Heartbeat re-sends the last value every X seconds even when nothing changed (0 = aus).
      </div>
    </div>
  `;
}

// ── Main page ──────────────────────────────────────────────────
export function InputBindings({ pluginId = 'loxone', defaultPattern } = {}) {
  const [bindings, setBindings] = useState([]);
  const [bindingStats, setBindingStats] = useState([]);
  // Aggregate binding-health for THIS plugin (from /api/bindings/health).
  // Drives the one-line summary banner under the page header. Null until the
  // first poll resolves; stays null for plugins the endpoint omits.
  const [health, setHealth] = useState(null);
  const [controls, setControls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [pluginDisplayName, setPluginDisplayName] = useState(pluginId);

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizStep, setWizStep] = useState(1);
  const [wizSource, setWizSource] = useState(null);
  const [wizField, setWizField] = useState(null);
  const [wizTarget, setWizTarget] = useState(null);

  // Import flow state. `pendingImport` is non-null while the Merge/Replace
  // dialog is showing, and carries everything the user needs to make the
  // decision (the parsed file, its bindings, and the precomputed merge
  // preview so the modal can show "Merge will skip N duplicates").
  const [pendingImport, setPendingImport] = useState(null);
  // `pluginType` is needed for the export filename and the per-plugin
  // export shape (`pluginType` field). The display-name fetch already
  // captures everything we need; pull `type` from the same call.
  const [pluginType, setPluginType] = useState(null);

  // Reset state when plugin changes
  useEffect(() => {
    setWizardOpen(false);
    setLoading(true);
    setBindings([]);
    setToast(null);
  }, [pluginId]);

  /**
   * Pull controls from EVERY running Loxone plugin (`type === 'loxone'`)
   * and merge into one list keyed by uuid. Each control gets `_pluginName`
   * tagged so the UI can show "To Gateway1" instead of a hardcoded "To Loxone"
   * when the user named their Miniserver instance `gateway1` rather than the
   * default `loxone`.
   */
  async function fetchAllLoxoneControls() {
    const r = await fetch('/api/plugins');
    if (!r.ok) return [];
    const plugins = await r.json();
    const loxones = plugins.filter(p => p.type === 'loxone' && p.status === 'running');
    if (loxones.length === 0) return [];
    const all = await Promise.all(loxones.map(async p => {
      try {
        const cr = await fetch(`/api/plugins/${encodeURIComponent(p.id)}/controls/detailed`);
        if (!cr.ok) return [];
        const ctrls = await cr.json();
        const tagName = p.displayName || p.name || p.id;
        return ctrls.map(c => ({ ...c, _pluginId: p.id, _pluginName: tagName }));
      } catch { return []; }
    }));
    return all.flat();
  }

  useEffect(() => {
    async function load() {
      try {
        // Fetch display name + type from plugin list. Type drives the
        // pluginType field in the per-plugin export so the file is self-
        // describing even when reimported on a different machine.
        fetch('/api/plugins').then(r => r.json()).then(plugins => {
          const p = plugins.find(p => p.id === pluginId);
          if (p) {
            setPluginDisplayName(p.displayName || p.name || pluginId);
            setPluginType(p.type || null);
          }
        }).catch(() => {});

        const [b, c] = await Promise.all([
          fetchInputBindings(pluginId),
          fetchAllLoxoneControls().catch(() => []),
        ]);
        setBindings(b);
        setControls(c);
      } catch (err) {
        setToast({ type: 'error', text: err.message });
      } finally {
        setLoading(false);
      }
    }
    load();
    // Refresh controls for live values
    const interval = setInterval(async () => {
      try {
        setControls(await fetchAllLoxoneControls());
      } catch { /* ignore */ }
    }, 3000);
    // Refresh per-binding stats (live MQTT-side values + send counters) and
    // the aggregate binding-health for this plugin on the same 2s tick.
    const statsInterval = setInterval(async () => {
      try {
        const r = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/bindings/stats`);
        if (r.ok) setBindingStats(await r.json());
      } catch { /* ignore */ }
      try {
        const map = await fetchBindingsHealth();
        // Omitted from the map → this plugin has no enabled bindings; null
        // collapses the summary banner. Defensive: keep null on fetch error.
        setHealth(map && typeof map === 'object' ? (map[pluginId] || null) : null);
      } catch { /* ignore — keep last known health */ }
    }, 2000);
    return () => { clearInterval(interval); clearInterval(statsInterval); };
  }, [pluginId]);

  const showToast = useCallback((type, text) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const save = useCallback(async (newBindings) => {
    try {
      await saveInputBindings(pluginId, newBindings);
      setBindings(newBindings);
      showToast('ok', 'Bindings saved');
      return true;
    } catch (err) {
      showToast('error', err.message);
      return false;
    }
  }, [showToast]);

  const handleRemove = useCallback((id) => {
    const next = bindings.filter(b => b.id !== id);
    save(next);
  }, [bindings, save]);

  const handleToggle = useCallback((id) => {
    const next = bindings.map(b => b.id === id ? { ...b, enabled: !b.enabled } : b);
    save(next);
  }, [bindings, save]);

  const handleUpdate = useCallback((id, field, value) => {
    const next = bindings.map(b => b.id === id ? { ...b, [field]: value } : b);
    save(next);
  }, [bindings, save]);

  const startWizard = useCallback(() => {
    setWizardOpen(true);
    setWizStep(1);
    setWizSource(null);
    setWizField(null);
    setWizTarget(null);
  }, []);

  const handleWizardSave = useCallback((newBinding) => {
    const next = [...bindings, newBinding];
    save(next);
    setWizardOpen(false);
  }, [bindings, save]);

  // ─── Export / Import ──────────────────────────────────────────
  const handleExport = useCallback(() => {
    try {
      const payload = buildPluginExport({
        pluginId,
        pluginType,
        displayName: pluginDisplayName,
        bindings,
      });
      // ISO date stamp (YYYY-MM-DD) — keeps filenames sortable without
      // exposing seconds-precision noise to the user's Downloads folder.
      const date = new Date().toISOString().slice(0, 10);
      downloadJson(`bindings-${pluginId}-${date}.json`, payload);
      showToast('ok', `Exported ${bindings.length} binding${bindings.length === 1 ? '' : 's'}`);
    } catch (err) {
      showToast('error', `Export failed: ${err.message}`);
    }
  }, [bindings, pluginId, pluginType, pluginDisplayName, showToast]);

  const handleImport = useCallback(async () => {
    let picked;
    try {
      picked = await pickJsonFile();
    } catch (err) {
      showToast('error', err.message);
      return;
    }
    if (!picked) return; // user cancelled — no toast
    const validation = validatePluginImport(picked.data, pluginId);
    if (!validation.ok) {
      showToast('error', validation.errors.join(' · '));
      return;
    }
    if (validation.warnings.length > 0) {
      const proceed = window.confirm(
        validation.warnings.join('\n') + '\n\nImport anyway?'
      );
      if (!proceed) return;
    }
    // Precompute the merge preview so the modal can show the actual skip
    // count BEFORE the user picks Merge — no surprises.
    const preview = mergeBindingArrays(bindings, validation.bindings);
    setPendingImport({
      filename: picked.filename,
      incoming: validation.bindings,
      mergePreview: preview,
      sourcePluginId: picked.data.pluginId || null,
    });
  }, [bindings, pluginId, showToast]);

  const applyImport = useCallback(async (mode) => {
    if (!pendingImport) return;
    let next;
    if (mode === 'replace') {
      next = pendingImport.incoming.slice();
    } else if (mode === 'copy') {
      // Copy mode: every incoming binding is appended as a fresh clone —
      // no skipping, ids re-minted, labels suffixed with ' (copy)'.
      next = copyBindingArrays(bindings, pendingImport.incoming).merged;
    } else {
      next = pendingImport.mergePreview.merged;
    }
    setPendingImport(null);
    // A failed save (e.g. a masked secret without stored value) already
    // showed its error – no success toast on top.
    if (!(await save(next))) return;
    if (mode === 'merge') {
      const added = pendingImport.mergePreview.merged.length - bindings.length;
      const skipped = pendingImport.mergePreview.skipped.length;
      showToast('ok', `Merged: ${added} added, ${skipped} skipped (duplicates)`);
    } else if (mode === 'copy') {
      const added = pendingImport.incoming.length;
      showToast('ok', `Imported copy: ${added} binding${added === 1 ? '' : 's'} added`);
    } else {
      showToast('ok', `Replaced: ${next.length} binding${next.length === 1 ? '' : 's'}`);
    }
  }, [pendingImport, bindings, save, showToast]);

  if (loading) {
    return html`<div class="page-placeholder">Loading...</div>`;
  }

  return html`
    <div>
      <div class="page-header">
        MQTT Input Bindings
        <span style="font-size:14px;color:var(--ve-text-dim);font-weight:400;margin-left:8px;">
          MQTT → ${pluginDisplayName}
        </span>
      </div>

      ${health && (health.severity === 'error' || health.severity === 'warn') && html`
        <div class="bind-card-diag bind-card-diag--${health.severity === 'error' ? 'red' : 'orange'}"
             style="margin-bottom:12px">
          ${health.severity === 'error'
            ? `⚠ ${health.counts.error} von ${health.total} Bindings haben einen Fehler — Details unten markiert.`
            : `⚠ ${health.counts.warn} von ${health.total} Bindings mit Warnung — Details unten.`}
        </div>
      `}

      ${!wizardOpen && html`
        <!-- Existing bindings -->
        ${bindings.length > 0 && html`
          ${bindings.map(b => {
            // Per-binding health issue from `/api/bindings/health`. Defensive
            // against null health (no enabled bindings → endpoint omits this
            // plugin) and against issues being undefined. Falls back to null,
            // which BindingCard treats as "no overlay".
            const healthIssue = health && Array.isArray(health.issues)
              ? (health.issues.find(i => i.id === b.id) || null)
              : null;
            return html`
              <${BindingCard}
                key=${b.id}
                binding=${b}
                stats=${bindingStats.find(s => s.id === b.id)}
                controls=${controls}
                healthIssue=${healthIssue}
                onRemove=${handleRemove}
                onToggle=${handleToggle}
                onUpdate=${handleUpdate}
              />
            `;
          })}
        `}
        ${bindings.length === 0 && html`
          <div class="ve-card" style="padding:24px;text-align:center;color:var(--ve-text-dim);">
            No bindings yet. Create one to start feeding MQTT data into Loxone.
          </div>
        `}
        <div class="bind-actions" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="lox-cmd-btn" onClick=${startWizard}>+ New Binding</button>
          <button
            class="lox-push-btn"
            onClick=${handleExport}
            title="Download a JSON snapshot of this plugin's bindings"
            disabled=${bindings.length === 0}
          >↓ Export</button>
          <button
            class="lox-push-btn"
            onClick=${handleImport}
            title="Restore bindings from a previously exported file"
          >↑ Import</button>
        </div>
      `}

      ${pendingImport && html`
        <div class="ve-modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) setPendingImport(null); }}>
          <div class="ve-modal">
            <div class="ve-modal-title">Import bindings</div>
            <div style="font-size:13px;color:var(--ve-text-dim);margin:8px 0 16px;">
              File: <strong style="color:var(--ve-text)">${pendingImport.filename}</strong><br/>
              Currently <strong style="color:var(--ve-text)">${bindings.length}</strong> binding${bindings.length === 1 ? '' : 's'},
              file has <strong style="color:var(--ve-text)">${pendingImport.incoming.length}</strong>.
              Merge will skip <strong style="color:var(--ve-text)">${pendingImport.mergePreview.skipped.length}</strong> duplicate${pendingImport.mergePreview.skipped.length === 1 ? '' : 's'}.
            </div>
            <div class="ve-modal-actions" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
              <button class="lox-push-btn" onClick=${() => setPendingImport(null)}>Cancel</button>
              <button class="lox-push-btn" onClick=${() => applyImport('merge')}>Merge (keep existing)</button>
              <button
                class="lox-push-btn"
                title="Append every binding from the file as a fresh clone — duplicates kept, labels suffixed '(copy)'"
                onClick=${() => applyImport('copy')}
              >Import copy</button>
              <button class="lox-cmd-btn" onClick=${() => {
                if (bindings.length > 0
                  && !window.confirm(`Replace will delete the ${bindings.length} existing binding${bindings.length === 1 ? '' : 's'}. Continue?`)) {
                  return;
                }
                applyImport('replace');
              }}>Replace all</button>
            </div>
          </div>
        </div>
      `}

      ${wizardOpen && html`
        <div class="wiz-container">
          <div class="wiz-progress">
            ${[1,2,3,4].map(s => html`
              <div class="wiz-dot ${wizStep >= s ? 'active' : ''}" key=${s}>${s}</div>
            `)}
          </div>

          ${wizStep === 1 && html`
            <${StepDiscover} onSelect=${(source) => { setWizSource(source); setWizStep(2); }} />
          `}
          ${wizStep === 2 && wizSource && html`
            <${StepPickField}
              source=${wizSource}
              onSelect=${(field) => { setWizField(field); setWizStep(3); }}
              onBack=${() => setWizStep(1)}
            />
          `}
          ${wizStep === 3 && wizField && html`
            <${StepPickTarget}
              source=${wizSource}
              field=${wizField}
              controls=${controls}
              existingBindings=${bindings}
              onSelect=${(target) => { setWizTarget(target); setWizStep(4); }}
              onBack=${() => setWizStep(2)}
            />
          `}
          ${wizStep === 4 && wizTarget && html`
            <${StepReview}
              source=${wizSource}
              field=${wizField}
              target=${wizTarget}
              onSave=${handleWizardSave}
              onBack=${() => setWizStep(3)}
            />
          `}

          <button class="lox-cmd-btn--small lox-cmd-btn" style="margin-top:16px" onClick=${() => setWizardOpen(false)}>Cancel</button>
        </div>
      `}

      ${toast && html`<div class="lox-toast lox-toast--${toast.type}">${toast.text}</div>`}
    </div>
  `;
}
