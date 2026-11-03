import { html } from 'htm/preact';
import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { fetchLoxoneControlsDetailed, sendLoxoneCommand } from '../lib/api-client.js';
import { mqttIcon } from '../lib/format.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { primaryValue, isControllable, flattenControls, buildGroups } from '../lib/control-utils.js';

/** Build list of available commands for a control type */
function getCommands(type, moods) {
  switch (type) {
    case 'Switch':
    case 'TimedSwitch':
      return [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
        { value: 'pulse', label: 'Pulse' },
      ];
    case 'Dimmer':
      return [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
        { value: 'plus', label: 'Dimmer +' },
        { value: 'minus', label: 'Dimmer −' },
      ];
    case 'LightControllerV2': {
      const cmds = [
        { value: 'plus', label: 'Stimmung +' },
        { value: 'minus', label: 'Stimmung −' },
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off (alles aus)' },
      ];
      if (moods && moods.length > 0) {
        for (const m of moods) {
          if (m.name !== 'Aus') {
            cmds.push({ value: `changeTo/${m.name}`, label: `→ ${m.name}` });
          }
        }
      }
      return cmds;
    }
    case 'Jalousie':
      return [
        { value: 'up', label: 'Up' },
        { value: 'down', label: 'Down' },
        { value: 'FullUp', label: 'Full Up' },
        { value: 'FullDown', label: 'Full Down' },
        { value: 'stop', label: 'Stop' },
      ];
    case 'Gate':
      return [
        { value: 'open', label: 'Open' },
        { value: 'close', label: 'Close' },
        { value: 'stop', label: 'Stop' },
      ];
    case 'Slider':
    case 'ColorPickerV2':
      return [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ];
    case 'IRoomControllerV2':
      return [
        { value: 'plus', label: 'Temp +' },
        { value: 'minus', label: 'Temp −' },
        { value: 'setManual/1', label: 'Manual On' },
        { value: 'setManual/0', label: 'Manual Off' },
      ];
    case 'Alarm':
      return [
        { value: 'on', label: 'Arm' },
        { value: 'off', label: 'Disarm' },
        { value: 'delayedon', label: 'Delayed Arm' },
      ];
    case 'Ventilation':
      return [
        { value: '0', label: 'Off' },
        { value: '1', label: 'Level 1' },
        { value: '2', label: 'Level 2' },
        { value: '3', label: 'Level 3' },
        { value: '4', label: 'Level 4' },
      ];
    default:
      // Generic fallback for unknown controllable types
      return [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ];
  }
}

function CmdDropdown({ commands, onSend }) {
  const [selected, setSelected] = useState(commands[0]?.value || '');
  const [sent, setSent] = useState(false);

  const handleSend = (e) => {
    e.stopPropagation();
    if (!selected) return;
    onSend(selected);
    setSent(true);
    setTimeout(() => setSent(false), 800);
  };

  if (commands.length === 0) return null;

  return html`
    <span class="lox-cmd-inline" onClick=${(e) => e.stopPropagation()}>
      <select class="lox-cmd-select" value=${selected} onChange=${(e) => setSelected(e.target.value)}>
        ${commands.map(c => html`<option key=${c.value} value=${c.value}>${c.label}</option>`)}
      </select>
      <button class="lox-cmd-send ${sent ? 'lox-cmd-sent' : ''}" onClick=${handleSend} title="Send command">
        ${sent ? '✓' : '▶'}
      </button>
    </span>
  `;
}

function DirBadge({ dir }) {
  const title = dir === 'out' ? 'Plugin → MQTT (outgoing)' : dir === 'in' ? 'MQTT → Plugin (incoming)' : 'bidirectional';
  if (dir === 'both') {
    return html`<span class="lox-dir-badge" title=${title}>${mqttIcon}<span class="lox-dir-both"><span class="lox-topic-arrow lox-topic-dir--out">\u2190</span><span class="lox-topic-arrow lox-topic-dir--in">\u2192</span></span></span>`;
  }
  return html`<span class="lox-dir-badge" title=${title}>${mqttIcon}<span class="lox-topic-arrow lox-topic-dir--${dir}">${dir === 'out' ? '\u2190' : '\u2192'}</span></span>`;
}

function CategorySection({ group, search, typeFilter, expanded, setExpanded, onCmd, prevValues }) {
  const [open, setOpen] = useState(false);

  const filtered = group.rooms.map(r => ({
    ...r,
    items: r.items.filter(item => {
      if (typeFilter && item.type !== typeFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!item.name.toLowerCase().includes(s)
          && !(item.parentName || '').toLowerCase().includes(s)
          && !item.type.toLowerCase().includes(s)) return false;
      }
      return true;
    }),
  })).filter(r => r.items.length > 0);

  const totalFiltered = filtered.reduce((s, r) => s + r.items.length, 0);
  if (totalFiltered === 0) return null;

  return html`
    <div class="bridge-cat">
      <div class="bridge-cat-header" onClick=${() => setOpen(!open)}>
        <span class="bridge-cat-expand ${open ? 'open' : ''}">\u25B6</span>
        <span class="bridge-cat-label">${group.category}</span>
        <span class="bridge-cat-count">${totalFiltered}</span>
      </div>
      ${open && html`
        <div class="bridge-cat-body">
          ${filtered.map(r => html`
            ${filtered.length > 1 && html`<div class="bridge-group-label">${r.room}</div>`}
            ${r.items.map(item => {
              const val = primaryValue(item.type, item.states, { moods: item.moods, activeMoodIds: item.activeMoodIds, activeMoodName: item.activeMoodName });
              const controllable = isControllable(item.type);
              const isOn = item.type === 'Switch' ? item.states?.active?.value > 0
                : item.type === 'Dimmer' ? item.states?.position?.value > 0
                : item.type === 'LightControllerV2' ? (item.activeMoodIds?.length > 0)
                : false;
              const isExpanded = expanded === item.uuid;

              const prevVal = prevValues.current[item.uuid];
              const changed = prevVal !== undefined && prevVal !== val;
              prevValues.current[item.uuid] = val;

              const topics = [];
              const prefix = item.topic ? item.topic.split('/')[0] : 'loxone';
              if (item.topic) {
                if (item.states) {
                  for (const [key, state] of Object.entries(item.states)) {
                    if (state) {
                      const v = state.value != null ? state.value : state.text;
                      topics.push({ topic: item.topic + '/' + key + '/state', label: key, value: v, dir: 'out' });
                    }
                  }
                }
                // Mood topic for LightControllerV2
                if (item.type === 'LightControllerV2' && item.activeMoodName) {
                  topics.push({ topic: item.topic + '/mood/state', label: 'mood', value: item.activeMoodName, dir: 'out' });
                }
                if (controllable) {
                  topics.push({ topic: item.topic + '/cmd', label: 'command', value: null, dir: 'in' });
                }
                // UUID-based stable topics (rename-safe)
                if (item.type === 'LightControllerV2') {
                  topics.push({ topic: prefix + '/by-uuid/' + item.uuid + '/mood/state', label: 'mood (stable)', value: item.activeMoodName, dir: 'out', stable: true });
                }
                topics.push({ topic: prefix + '/by-uuid/' + item.uuid + '/cmd', label: 'command (stable)', value: null, dir: 'in', stable: true });
              }

              return html`
                <div class="lox-item-wrap" key=${item.uuid}>
                  <div class="lox-item ${changed ? 'val-ping' : ''}" onClick=${() => setExpanded(isExpanded ? null : item.uuid)} style="cursor:pointer">
                    <${DirBadge} dir=${controllable ? 'both' : 'out'} />
                    <div class="lox-item-info">
                      <span class="lox-item-name">
                        ${item.name}
                        ${item.parentName && html`<span class="lox-item-parent">${item.parentName}</span>`}
                      </span>
                      <span class="lox-item-meta">${item.type}</span>
                    </div>
                    <div class="lox-item-value ${val && (val === 'ON' || val === 'Active' || (controllable && isOn)) ? 'on' : ''}">${val || '--'}</div>
                    ${controllable && html`
                      <div class="lox-item-actions">
                        ${item.type === 'LightControllerV2' ? html`
                          <button class="lox-push-btn" onClick=${(e) => { e.stopPropagation(); onCmd(item.uuid, 'minus'); }} title="Previous mood">−</button>
                          <button class="lox-push-btn" onClick=${(e) => { e.stopPropagation(); onCmd(item.uuid, 'plus'); }} title="Next mood">+</button>
                        ` : item.type === 'Jalousie' ? html`
                          <button class="lox-push-btn" onClick=${(e) => { e.stopPropagation(); onCmd(item.uuid, 'up'); }} title="Up">▲</button>
                          <button class="lox-push-btn" onClick=${(e) => { e.stopPropagation(); onCmd(item.uuid, 'down'); }} title="Down">▼</button>
                        ` : html`
                          <button class="lox-push-btn" onClick=${(e) => { e.stopPropagation(); onCmd(item.uuid, 'on'); }}>On</button>
                          <button class="lox-push-btn" onClick=${(e) => { e.stopPropagation(); onCmd(item.uuid, 'off'); }}>Off</button>
                        `}
                      </div>
                    `}
                  </div>
                  ${isExpanded && topics.length > 0 && html`
                    <div class="lox-item-topics">
                      ${topics.map(t => html`
                        <div class="lox-topic-row" key=${t.topic}>
                          <span class="lox-topic-dir" title=${t.dir === 'out' ? 'Loxone → MQTT (outgoing)' : 'MQTT → Loxone (incoming)'}>
                            <svg class="lox-topic-mqtt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="5" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="12" cy="19" r="2.5"/><circle cx="12" cy="12" r="1.5"/><line x1="7" y1="6.5" x2="10.5" y2="11"/><line x1="17" y1="6.5" x2="13.5" y2="11"/><line x1="12" y1="13.5" x2="12" y2="16.5"/></svg>
                            <span class="lox-topic-arrow lox-topic-dir--${t.dir}">${t.dir === 'out' ? '\u2190' : '\u2192'}</span>
                          </span>
                          <span class="lox-topic-path">${t.topic}</span>
                          <button class="lox-topic-copy" onClick=${(e) => { e.stopPropagation(); copyToClipboard(t.topic); }} title="Copy topic">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                          </button>
                          <span class="lox-topic-label">${t.label}${t.stable ? html` <span class="lox-topic-stable" title="UUID-based — survives renames in Loxone Config">stable</span>` : ''}</span>
                          ${t.value != null && html`
                            <span class="lox-topic-val">${typeof t.value === 'number' ? (Number.isInteger(t.value) ? t.value : t.value.toFixed(3)) : t.value}</span>
                          `}
                          ${t.dir === 'in' && !t.stable && html`
                            <${CmdDropdown}
                              commands=${getCommands(item.type, item.moods)}
                              onSend=${(cmd) => onCmd(item.uuid, cmd)}
                            />
                          `}
                          ${t.dir === 'out' && t.value == null && html`<span class="lox-topic-val" style="color:var(--ve-text-dim)">--</span>`}
                        </div>
                      `)}
                    </div>
                  `}
                </div>
              `;
            })}
          `)}
        </div>
      `}
    </div>
  `;
}

export function LoxoneControls({ pluginId = 'loxone' } = {}) {
  const [controls, setControls] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const prevValues = useRef({});

  async function loadControls() {
    try {
      setError(null);
      const data = await fetchLoxoneControlsDetailed(pluginId);
      setControls(data);
    } catch (err) {
      setError(err.message);
      setControls([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    setControls([]);
    loadControls();
    const interval = setInterval(async () => {
      try {
        const data = await fetchLoxoneControlsDetailed(pluginId);
        setControls(data);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [pluginId]);

  const handleCmd = useCallback(async (uuid, command) => {
    try {
      await sendLoxoneCommand(uuid, command, pluginId);
      setToast({ type: 'ok', text: command });
    } catch (err) {
      setToast({ type: 'error', text: err.message });
    }
    setTimeout(() => setToast(null), 2000);
  }, []);

  if (loading) return html`<div class="page-placeholder">Loading...</div>`;

  if (error) {
    return html`
      <div>
        <div class="page-header">Elements</div>
        <div class="ve-card" style="padding:20px;color:var(--ve-text-dim);">
          Plugin not running or unavailable: ${error}
        </div>
      </div>
    `;
  }

  const allItems = flattenControls(controls);
  const types = [...new Set(allItems.map(i => i.type))].sort();
  const groups = buildGroups(allItems);

  // Count filtered items
  const filteredCount = allItems.filter(item => {
    if (typeFilter && item.type !== typeFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!item.name.toLowerCase().includes(s)
        && !(item.parentName || '').toLowerCase().includes(s)
        && !item.type.toLowerCase().includes(s)) return false;
    }
    return true;
  }).length;

  return html`
    <div>
      <div class="page-header">
        Elements
        <span style="font-size:14px;color:var(--ve-text-dim);font-weight:400;margin-left:8px;">
          (${filteredCount}${filteredCount !== allItems.length ? ' / ' + allItems.length : ''})
        </span>
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
        ${types.length > 1 && html`
          <select class="bind-select" value=${typeFilter} onChange=${(e) => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            ${types.map(t => html`<option key=${t} value=${t}>${t}</option>`)}
          </select>
        `}
        ${(search || typeFilter) && html`
          <button class="lox-push-btn" onClick=${() => { setSearch(''); setTypeFilter(''); }}>Reset</button>
        `}
      </div>
      ${groups.map(group => html`
        <${CategorySection}
          key=${group.category}
          group=${group}
          search=${search}
          typeFilter=${typeFilter}
          expanded=${expanded}
          setExpanded=${setExpanded}
          onCmd=${handleCmd}
          prevValues=${prevValues}
        />
      `)}
      ${toast && html`<div class="lox-toast lox-toast--${toast.type}">${toast.text}</div>`}
    </div>
  `;
}
