import { html } from 'htm/preact';
import { useEffect, useState, useRef } from 'preact/hooks';
import { fmtNum, mqttIcon } from '../lib/format.js';
import { copyToClipboard } from '../lib/clipboard.js';

/** Priority order for categories - important ones first */
const CAT_ORDER = ['grid', 'pvinverter', 'system', 'battery', 'solarcharger', 'vebus', 'tank', 'temperature'];

function catPriority(cat) {
  const idx = CAT_ORDER.indexOf(cat);
  return idx >= 0 ? idx : 100;
}

/** Human-readable category labels */
const CAT_LABELS = {
  grid: 'Grid / Netz',
  pvinverter: 'PV Inverter',
  system: 'System',
  battery: 'Battery',
  solarcharger: 'Solar Charger',
  vebus: 'VE.Bus',
  tank: 'Tank',
  temperature: 'Temperature',
  settings: 'Settings',
  platform: 'Platform',
  logger: 'Logger',
  fronius: 'Fronius',
  shelly: 'Shelly',
  modbusclient: 'Modbus Client',
};

/** Build tree structure from flat topic list */
function buildTree(elements) {
  const categories = {};

  for (const el of elements) {
    const parts = el.localTopic.split('/');
    // venus/{category}/{instanceId}/...
    if (parts.length < 2) continue;
    const prefix = parts[0]; // "venus"
    const cat = parts[1];
    const instanceId = parts.length >= 3 ? parts[2] : '';
    const rest = parts.slice(3).join('/');

    if (!categories[cat]) {
      categories[cat] = {
        name: cat,
        label: CAT_LABELS[cat] || cat,
        elements: [],
        count: 0,
      };
    }
    categories[cat].elements.push({
      ...el,
      shortPath: rest || cat,
      instanceId,
    });
    categories[cat].count++;
  }

  // Sort categories by priority
  return Object.values(categories).sort((a, b) => catPriority(a.name) - catPriority(b.name));
}

/** Further group elements within a category by sub-path prefix */
function groupElements(elements) {
  const groups = {};
  for (const el of elements) {
    // Group by first segment of shortPath: e.g. "Ac/Consumption/L1/Power" → "Ac/Consumption"
    const parts = el.shortPath.split('/');
    let groupKey;
    if (parts.length <= 2) {
      groupKey = '';
    } else {
      groupKey = parts.slice(0, 2).join('/');
    }
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(el);
  }
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
}

/** Copy-to-clipboard button for the full MQTT topic path, with ✓ feedback */
function CopyTopicBtn({ topic }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e) => {
    e.stopPropagation();
    copyToClipboard(topic).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return html`
    <button class="bridge-el-copy ${copied ? 'copied' : ''}" onClick=${onCopy} title=${`Copy full path: ${topic}`}>
      ${copied
        ? html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`}
    </button>
  `;
}

function CategorySection({ cat, search, defaultOpen, prevValues }) {
  const [open, setOpen] = useState(defaultOpen);

  // Filter elements by search
  const filtered = search
    ? cat.elements.filter(el => el.localTopic.toLowerCase().includes(search) || el.shortPath.toLowerCase().includes(search))
    : cat.elements;

  if (search && filtered.length === 0) return null;

  const groups = groupElements(filtered);

  return html`
    <div class="bridge-cat">
      <div class="bridge-cat-header" onClick=${() => setOpen(!open)}>
        <span class="bridge-cat-expand ${open ? 'open' : ''}">\u25B6</span>
        <span class="bridge-cat-label">${cat.label}</span>
        <span class="bridge-cat-count">${filtered.length}</span>
      </div>
      ${open && html`
        <div class="bridge-cat-body">
          ${groups.map(([groupKey, els]) => html`
            ${groupKey && html`<div class="bridge-group-label">${groupKey}</div>`}
            ${els.map(el => {
              const prev = prevValues.current[el.localTopic];
              const changed = prev !== undefined && prev !== el.value;
              prevValues.current[el.localTopic] = el.value;
              return html`
                <div class="bridge-el ${changed ? 'val-ping' : ''}" key=${el.localTopic}>
                  <span class="lox-dir-badge" title="Plugin → MQTT (outgoing)">${mqttIcon}<span class="lox-topic-arrow lox-topic-dir--out">\u2190</span></span>
                  <span class="bridge-el-path" title=${el.localTopic}>${el.shortPath}</span>
                  <span class="bridge-el-value">${fmtNum(el.value)}</span>
                  <${CopyTopicBtn} topic=${el.localTopic} />
                </div>
              `;
            })}
          `)}
        </div>
      `}
    </div>
  `;
}

export function BridgeElements({ pluginId = 'mqtt-bridge' } = {}) {
  const [elements, setElements] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const prevValues = useRef({});

  useEffect(() => {
    setLoading(true);
    setError(null);
    setElements([]);
    async function load() {
      try {
        const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/elements`);
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        setElements(await res.json());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/elements`);
        if (res.ok) setElements(await res.json());
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [pluginId]);

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

  const tree = buildTree(elements);
  const lowerSearch = search.toLowerCase();

  // Count visible elements
  const visibleCount = search
    ? elements.filter(el => el.localTopic.toLowerCase().includes(lowerSearch)).length
    : elements.length;

  return html`
    <div>
      <div class="page-header">
        Elements
        <span style="font-size:14px;color:var(--ve-text-dim);font-weight:400;margin-left:8px;">
          (${visibleCount}${visibleCount !== elements.length ? ' / ' + elements.length : ''})
        </span>
      </div>
      <div class="wiz-filters">
        <input
          type="text"
          class="bind-input"
          style="flex:1"
          placeholder="Search topics..."
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
        />
        ${search && html`
          <button class="lox-push-btn" onClick=${() => setSearch('')}>Reset</button>
        `}
      </div>
      ${tree.map(cat => html`
        <${CategorySection}
          key=${cat.name}
          cat=${cat}
          search=${lowerSearch}
          defaultOpen=${false}
          prevValues=${prevValues}
        />
      `)}
    </div>
  `;
}
