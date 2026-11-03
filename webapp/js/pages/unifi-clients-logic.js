/**
 * Pure helpers for the UnifiClients page (Phase 14 Plan 14-04).
 *
 * Split out of `unifi-clients.js` so they can be unit-tested without preact
 * scaffolding. Mirrors the unifi-ports-logic.js / unifi-wan-logic.js pattern.
 *
 * Decision pins:
 *   D-P14-UI-02 — Filter axes: search text + SSID + AP + wired/wireless + state + vendor
 *   D-P14-UI-02 — Summary card aggregates from the live client map
 *   D-P14-FIELDS-01 — Client payload shape these helpers consume
 */

/**
 * Format a signal-strength value in dBm into a short human label.
 *
 * Buckets:
 *   ≥ -60 dBm → 'excellent'
 *   ≥ -70 dBm → 'good'
 *   ≥ -80 dBm → 'fair'
 *   <  -80 dBm → 'weak'
 *   null/missing → '—'
 *
 * @param {number|null|undefined} dbm
 * @returns {{label: string, dot: 'connected'|'unknown'|'error', dbm: number|null}}
 */
export function formatSignal(dbm) {
  if (typeof dbm !== 'number' || !Number.isFinite(dbm)) {
    return { label: '—', dot: 'unknown', dbm: null };
  }
  if (dbm >= -60) return { label: 'excellent', dot: 'connected', dbm };
  if (dbm >= -70) return { label: 'good', dot: 'connected', dbm };
  if (dbm >= -80) return { label: 'fair', dot: 'unknown', dbm };
  return { label: 'weak', dot: 'error', dbm };
}

/**
 * Build a one-line connection summary for the client table.
 *
 *   wired:    `wired ${switch_name||'?'}:${switch_port_idx||'?'}`
 *   wireless: `wifi ${essid} @ ${ap_name||'?'} / ch ${channel} / ${signal_dbm} dBm`
 *
 * @param {object} client  Normalised ClientState.
 * @returns {string}
 */
export function buildConnectionLabel(client) {
  if (!client) return '';
  if (client.is_wired) {
    const sw = client.switch_name || client.switch_mac || '?';
    const port = client.switch_port_idx != null ? client.switch_port_idx : '?';
    return `wired ${sw}:${port}`;
  }
  const ssid = client.essid || '?';
  const ap = client.ap_name || client.ap_mac || '?';
  const parts = [`wifi ${ssid} @ ${ap}`];
  if (typeof client.channel === 'number') parts.push(`ch ${client.channel}`);
  if (typeof client.signal_dbm === 'number') parts.push(`${client.signal_dbm} dBm`);
  return parts.join(' / ');
}

/**
 * Humanise an ISO last_seen timestamp into a relative-time string.
 *   '5 s ago' / '3 m ago' / '2 h ago' / 'just now' / 'never'
 *
 * @param {string|null|undefined} iso
 * @param {number} [now]   For deterministic testing — defaults to Date.now().
 * @returns {string}
 */
export function formatRelativeTime(iso, now) {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const reference = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
  const ageMs = reference - t;
  if (ageMs < 0) return 'just now';
  if (ageMs < 5000) return 'just now';
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

/**
 * Vendor extraction: prefer dev_vendor; fall back to OUI; finally '—'.
 *
 * @param {object} client
 * @returns {string}
 */
export function extractVendor(client) {
  if (!client) return '—';
  if (typeof client.dev_vendor === 'string' && client.dev_vendor.length > 0) return client.dev_vendor;
  if (typeof client.oui === 'string' && client.oui.length > 0) return client.oui;
  return '—';
}

/**
 * Compute summary aggregates from a list of clients.
 *
 * @param {Array<object>} clients
 * @returns {{total:number, wireless:number, wired:number, home:number, not_home:number, ssids:Array<string>, aps:Array<string>, vendors:Array<string>}}
 */
export function summarise(clients) {
  let total = 0; let wireless = 0; let wired = 0; let home = 0; let notHome = 0;
  const ssidSet = new Set();
  const apSet = new Set();
  const vendorSet = new Set();
  for (const c of clients || []) {
    if (!c) continue;
    total += 1;
    if (c.is_wired) wired += 1; else wireless += 1;
    if (c.state === 'home') home += 1; else notHome += 1;
    if (c.essid) ssidSet.add(c.essid);
    const apLabel = c.ap_name || c.ap_mac;
    if (apLabel) apSet.add(apLabel);
    const v = extractVendor(c);
    if (v && v !== '—') vendorSet.add(v);
  }
  return {
    total, wireless, wired, home, not_home: notHome,
    ssids: Array.from(ssidSet).sort(),
    aps: Array.from(apSet).sort(),
    vendors: Array.from(vendorSet).sort(),
  };
}

/**
 * Filter the client list by the page filter state.
 *
 * @param {Array<object>} clients
 * @param {{q?:string, ssid?:string, ap?:string, wirelessOnly?:boolean, wiredOnly?:boolean, state?:string, vendor?:string}} filter
 * @returns {Array<object>}
 */
export function applyClientsFilter(clients, filter) {
  if (!Array.isArray(clients)) return [];
  const f = filter || {};
  const q = typeof f.q === 'string' ? f.q.trim().toLowerCase() : '';
  return clients.filter((c) => {
    if (!c) return false;
    if (f.wirelessOnly && c.is_wired) return false;
    if (f.wiredOnly && !c.is_wired) return false;
    if (f.ssid && f.ssid !== 'all' && c.essid !== f.ssid) return false;
    if (f.ap && f.ap !== 'all') {
      const apLabel = c.ap_name || c.ap_mac;
      if (apLabel !== f.ap) return false;
    }
    if (f.state && f.state !== 'all' && c.state !== f.state) return false;
    if (f.vendor && f.vendor !== 'all') {
      if (extractVendor(c) !== f.vendor) return false;
    }
    if (q.length > 0) {
      const haystack = [
        c.name, c.hostname, c.mac, c.ip,
        c.essid, c.ap_name, c.switch_name, c.dev_vendor, c.oui,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Parse the per-client MAC out of `${prefix}clients/by-mac/{slug}/state`.
 * @param {string} topic
 * @returns {string|null}
 */
export function parseClientTopic(topic) {
  if (typeof topic !== 'string') return null;
  const m = topic.match(/\/clients\/by-mac\/([a-z0-9-]+)\/state$/);
  if (!m) return null;
  const slug = m[1];
  // Reinsert colons: aa-bb-cc-dd-ee-ff → aa:bb:cc:dd:ee:ff
  if (slug.length !== 17) return null; // 6*2 hex + 5 dashes
  const parts = slug.split('-');
  if (parts.length !== 6) return null;
  return parts.join(':');
}
