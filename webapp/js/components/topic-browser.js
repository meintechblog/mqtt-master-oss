import { html } from 'htm/preact';
import { useEffect, useState, useRef, useCallback } from 'preact/hooks';
import {
  messages,
  subscriptions,
  subscribeTopic,
  unsubscribeTopic,
} from '../lib/ws-messages-client.js';
import {
  buildTopicTree,
  autoExpandAll,
  buildChildName,
} from './topic-browser-helpers.js';

// Re-export the pure helpers so external callers (and tests) can import them
// from the canonical component module too.
export { buildTopicTree, autoExpandAll, buildChildName };

/**
 * Reusable topic browser tree.
 *
 * Self-loads `/api/mqtt/topics` (server-side cache of every topic seen since
 * service start) and stays live by subscribing to `#` over the WebSocket.
 * Surfaces a leaf via `onSelect(topic, displayValue, rawPayload, ts)`.
 *
 * Drop-in for both the Live Messages page (action="+Bind") and the Input
 * Bindings wizard (action="Use →"), so users get the same explorer everywhere.
 */

function fmtValue(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v).substring(0, 60); } catch { return '[object]'; }
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  const s = String(v);
  return s.length > 60 ? s.substring(0, 57) + '...' : s;
}

function filterTree(tree, search) {
  const result = { children: {}, count: 0 };
  for (const [name, node] of Object.entries(tree.children)) {
    const fullPath = node.topic || name;
    const matches = fullPath.toLowerCase().includes(search);
    const filtered = filterTree(node, search);
    if (matches || Object.keys(filtered.children).length > 0) {
      result.children[name] = { ...node, children: matches ? node.children : filtered.children };
      result.count++;
    }
  }
  return result;
}

function TopicNode({ name, node, depth, expanded, toggleExpand, onSelect, actionLabel, prevValues, boundTopics }) {
  const hasChildren = Object.keys(node.children).length > 0;
  const isLeaf = node.topic != null;
  const isOpen = expanded.has(name);

  const prev = prevValues.current[node.topic];
  const changed = isLeaf && prev !== undefined && prev !== node.value;
  if (isLeaf) prevValues.current[node.topic] = node.value;

  // Are there bindings already pointing at this exact topic?
  const bindings = (isLeaf && boundTopics?.get?.(node.topic)) || [];
  const isBound = bindings.length > 0;
  const tooltip = isBound
    ? `Already used by ${bindings.length} binding${bindings.length === 1 ? '' : 's'}:\n` +
      bindings.map(b => `• ${b.pluginName}: ${b.label}${b.jsonField ? ' [' + b.jsonField + ']' : ''}`).join('\n')
    : null;

  return html`
    <div>
      <div class="tb-row ${changed ? 'val-ping' : ''} ${isBound ? 'tb-row--bound' : ''}" style="padding-left:${12 + depth * 16}px">
        ${hasChildren
          ? html`<span class="tb-expand ${isOpen ? 'open' : ''}" onClick=${() => toggleExpand(name)}>▶</span>`
          : html`<span class="tb-expand-spacer"></span>`
        }
        <span
          class="tb-name ${isLeaf ? '' : 'tb-name--branch'}"
          onClick=${() => hasChildren && toggleExpand(name)}
        >${name.split('/').pop()}</span>
        ${isBound && html`
          <span class="tb-bound-badge" title=${tooltip}>
            <span class="tb-bound-icon">⇄</span>${bindings.length > 1 ? html`<span class="tb-bound-count">${bindings.length}</span>` : ''}
          </span>
        `}
        ${isLeaf && html`
          <span class="tb-value">${fmtValue(node.value)}</span>
          <button
            class="tb-bind-btn"
            onClick=${() => onSelect(node.topic, node.value, node.payload, node.ts)}
            title=${isBound ? `${actionLabel} (already used in ${bindings.length} binding${bindings.length === 1 ? '' : 's'})` : actionLabel}
          >${actionLabel}</button>
        `}
      </div>
      ${isOpen && Object.entries(node.children)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([childName, childNode]) => html`
          <${TopicNode}
            key=${childName}
            name=${buildChildName(node, name, childName)}
            node=${childNode}
            depth=${depth + 1}
            expanded=${expanded}
            toggleExpand=${toggleExpand}
            onSelect=${onSelect}
            actionLabel=${actionLabel}
            prevValues=${prevValues}
            boundTopics=${boundTopics}
          />
        `)
      }
    </div>
  `;
}

/**
 * Props:
 *  - onSelect(topic, displayValue, rawPayload, ts) — required
 *  - actionLabel: leaf button text, default "+Bind"
 *  - title:       panel header, default "Topic Browser"
 *  - filterFn(topic, payload): optional pre-filter (e.g. only JSON topics)
 *  - extraTopicMap: an external Map<topic, {value, payload, ts}> to merge in
 *                   (lets the page share its own live cache)
 *  - autoSubscribe: subscribe to `#` over WS for live updates (default true)
 *  - height: max-height of the tree area
 */
export function TopicBrowserPanel({
  onSelect,
  actionLabel = '+Bind',
  title = 'Topic Browser',
  filterFn = null,
  extraTopicMap = null,
  autoSubscribe = true,
  height = '500px',
  showBoundBadges = true,
}) {
  const [expanded, setExpanded] = useState(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [, setVersion] = useState(0);
  const [boundTopics, setBoundTopics] = useState(() => new Map());
  const topicMapRef = useRef(new Map());
  const prevValues = useRef({});
  const lastProcessedRef = useRef(0);

  const toggleExpand = useCallback((name) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Load snapshot once, subscribe `#` for live updates, periodic re-sync.
  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const res = await fetch('/api/mqtt/topics');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        for (const t of data) {
          let val = t.payload;
          try {
            const parsed = JSON.parse(t.payload);
            if (parsed && typeof parsed === 'object') {
              val = parsed.value !== undefined ? parsed.value : parsed;
            }
          } catch { /* not JSON */ }
          const existing = topicMapRef.current.get(t.topic);
          if (!existing || existing.ts < t.ts) {
            topicMapRef.current.set(t.topic, { value: val, payload: t.payload, ts: t.ts });
          }
        }
        setVersion(v => v + 1);
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    }

    async function loadBindings() {
      if (!showBoundBadges) return;
      try {
        const res = await fetch('/api/bindings');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const map = new Map();
        for (const b of data) {
          const key = b.mqttTopic;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(b);
        }
        setBoundTopics(map);
      } catch { /* ignore */ }
    }

    const wildcardWasMine = autoSubscribe && !subscriptions.value.has('#');
    if (wildcardWasMine) subscribeTopic('#');

    loadSnapshot();
    loadBindings();
    const interval = setInterval(loadSnapshot, 15000);
    const bindingsInterval = setInterval(loadBindings, 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(bindingsInterval);
      if (wildcardWasMine) unsubscribeTopic('#');
    };
  }, [autoSubscribe, showBoundBadges]);

  // Live updates: pull from the global messages signal each render.
  const all = messages.value;
  if (all.length > 0 && all[0].timestamp > lastProcessedRef.current) {
    for (const m of all) {
      if (m.timestamp <= lastProcessedRef.current) break;
      let val = m.payload;
      try {
        const parsed = JSON.parse(m.payload);
        if (parsed && typeof parsed === 'object' && parsed.value !== undefined) val = parsed.value;
      } catch { /* not JSON */ }
      topicMapRef.current.set(m.topic, { value: val, payload: m.payload, ts: m.timestamp });
    }
    lastProcessedRef.current = all[0].timestamp;
  }

  // Build view: optional external map merged in, optional filter
  const merged = new Map(topicMapRef.current);
  if (extraTopicMap) {
    for (const [k, v] of extraTopicMap) {
      const cur = merged.get(k);
      if (!cur || (cur.ts || 0) < (v.ts || 0)) merged.set(k, v);
    }
  }
  const visibleMap = filterFn
    ? new Map([...merged].filter(([t, d]) => filterFn(t, d.payload)))
    : merged;

  const tree = buildTopicTree(visibleMap);
  const filteredTree = search ? filterTree(tree, search.toLowerCase()) : tree;
  const renderedTree = search ? filteredTree : tree;

  const boundVisibleCount = showBoundBadges
    ? [...visibleMap.keys()].filter(t => boundTopics.has(t)).length
    : 0;

  return html`
    <div class="tb-panel">
      <div class="tb-header">
        <span class="tb-title">${title}</span>
        <span class="tb-count">
          ${visibleMap.size} topics${boundVisibleCount > 0 ? html` · <span class="tb-count-bound">${boundVisibleCount} bound</span>` : ''}
        </span>
      </div>
      ${visibleMap.size > 10 && html`
        <input
          type="text"
          class="bind-input"
          style="margin:0 12px 8px;width:calc(100% - 24px)"
          placeholder="Filter topics..."
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
        />
      `}
      <div class="tb-tree" style="max-height:${height}">
        ${Object.entries(renderedTree.children)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([name, node]) => html`
            <${TopicNode}
              key=${name}
              name=${name}
              node=${node}
              depth=${0}
              expanded=${search ? autoExpandAll(tree) : expanded}
              toggleExpand=${toggleExpand}
              onSelect=${onSelect}
              actionLabel=${actionLabel}
              prevValues=${prevValues}
              boundTopics=${boundTopics}
            />
          `)
        }
        ${visibleMap.size === 0 && !loading && html`
          <div style="padding:16px;text-align:center;color:var(--ve-text-dim);font-size:13px;">
            ${filterFn ? 'No matching topics yet.' : 'No topics seen yet — waiting for the broker.'}
          </div>
        `}
        ${loading && visibleMap.size === 0 && html`
          <div style="padding:16px;text-align:center;color:var(--ve-text-dim);font-size:13px;">
            Loading topics...
          </div>
        `}
      </div>
    </div>
  `;
}
