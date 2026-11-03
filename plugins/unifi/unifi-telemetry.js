/**
 * UniFi telemetry normalisers — pure functions.
 *
 * Converts raw /stat/device + /stat/sta API shapes into the published JSON
 * shapes Plan 08-02 emits on retained MQTT topics. NO IO — no fetch, no MQTT,
 * no timers, no fs. The poll loop in 08-02 calls these in a tight inner loop.
 *
 * Field set per D-F-01..D-F-04 (08-CONTEXT.md). Wire-type coercion is
 * defensive: the controller returns strings or numbers depending on firmware
 * (UCG-MAX 5.x has been observed to return `poe_power` as a string like
 * "6.31"). We parseFloat/parseInt explicitly so downstream subscribers always
 * see canonical Number / Boolean / null.
 *
 * D-F-02 is the load-bearing invariant: NON-PoE ports omit every poe_* field
 * entirely. They are not zeroed. This distinguishes "PoE-capable port with no
 * draw" from "port has no PoE hardware" (SFP+ uplinks, WAN ports).
 */
import { isProtectedPort } from './protected-ports.js';

// API `state` integer → human-readable string. Per PITFALLS.md Pitfall 15.
const STATE_CODE_MAP = Object.freeze({
  0: 'offline',
  1: 'online',
  2: 'pending',
  4: 'upgrading',
  5: 'provisioning',
  6: 'offline', // heartbeat-missed
  7: 'offline', // adopted-by-other
});

// API `type` short code → published string. Unknown types pass through verbatim.
const TYPE_CODE_MAP = Object.freeze({
  udm: 'gateway',
  usw: 'switch',
  uap: 'ap',
});

/**
 * True when this port_table entry represents a PoE-capable port.
 *
 * The API marker is `port_poe === true` — SFP+ uplinks and WAN ports report
 * `port_poe === false` regardless of link state. Per D-F-02, this gate
 * controls whether poe_* fields appear in the published payload.
 *
 * @param {object|null|undefined} entry
 * @returns {boolean}
 */
export function isPoeCapablePort(entry) {
  return Boolean(entry && entry.port_poe === true);
}

/**
 * Coerce a wire value to boolean — accepts true/1/"1"/"true" as truthy.
 * Defensive against firmware-dependent string vs bool variance.
 * @param {unknown} v
 * @returns {boolean}
 */
function coerceBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * @typedef {Object} PublishedPortState
 * @property {number} port_idx
 * @property {string} port_name
 * @property {boolean} link_up
 * @property {number|null} link_speed_mbps     null when link_up=false.
 * @property {boolean|null} full_duplex         null when link_up=false.
 * @property {string|null} connected_device     LLDP/sta-derived; null when none known.
 * @property {object|null} connected_device_detail  D-P13-PORT-02; structured shape.
 * @property {string} [poe_mode]                Only when isPoeCapablePort.
 * @property {Array<string>} [poe_caps]         Only when API returns an array (legacy contract).
 * @property {number} [poe_power_w]             Only when isPoeCapablePort AND poe_power present.
 * @property {number} [poe_voltage_v]           Only when isPoeCapablePort AND poe_voltage present.
 * @property {number} [poe_current_ma]          Only when isPoeCapablePort AND poe_current present.
 * @property {number} [rx_bytes]                D-P13-PORT-01 cumulative since boot.
 * @property {number} [tx_bytes]                D-P13-PORT-01 cumulative since boot.
 * @property {number} [rx_rate_kbps]            D-P13-PORT-01 derived from `rx_bytes-r`.
 * @property {number} [tx_rate_kbps]            D-P13-PORT-01 derived from `tx_bytes-r`.
 * @property {number} [link_down_count]         D-P13-PORT-01 from API.
 * @property {number} [rx_errors]                Surface only when API reports a value (anomaly source).
 * @property {number} [tx_errors]                Surface only when API reports a value (anomaly source).
 * @property {number} [rx_dropped]               Surface only when API reports a value (anomaly source).
 * @property {number} [tx_dropped]               Surface only when API reports a value (anomaly source).
 * @property {boolean} [protected]              True when isProtectedPort(deviceMac, port_idx).
 */

/**
 * Round a number to N decimal places without floating-point drift.
 * @param {number} v
 * @param {number} digits
 */
function roundTo(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Normalise one port_table entry into the published JSON shape.
 *
 * The output is built field-by-field — unknown wire keys never leak through.
 * Per the D-F-02 invariant, when isPoeCapablePort(entry) is false, NO poe_*
 * keys are added. Test 6 in tests/plugins/unifi/unifi-telemetry.test.js
 * pins this with `'poe_power_w' in out === false`.
 *
 * `connected_device` is resolved by the caller (via deriveConnectedDevice)
 * and passed as `opts.connectedDevice`. This keeps normalizePort pure and
 * free of cross-port state (the /stat/sta lookup walks the full sta list).
 *
 * @param {object} entry
 * @param {{deviceMac: string, connectedDevice?: string|null}} opts
 * @returns {PublishedPortState}
 */
export function normalizePort(entry, opts) {
  const up = coerceBool(entry.up);

  const out = {
    port_idx: parseInt(entry.port_idx, 10),
    port_name: String(entry.name ?? ''),
    link_up: up,
    link_speed_mbps: up ? (parseInt(entry.speed, 10) || null) : null,
    full_duplex: up ? coerceBool(entry.full_duplex) : null,
    connected_device: opts?.connectedDevice ?? null,
    // D-P13-PORT-02 — structured detail alongside legacy string label.
    connected_device_detail: opts?.connectedDeviceDetail ?? null,
  };

  // D-P13-PORT-01 — throughput counters + rates. Omit when not present.
  if (entry.rx_bytes !== undefined && entry.rx_bytes !== null) {
    const v = Number(entry.rx_bytes);
    if (Number.isFinite(v)) out.rx_bytes = v;
  }
  if (entry.tx_bytes !== undefined && entry.tx_bytes !== null) {
    const v = Number(entry.tx_bytes);
    if (Number.isFinite(v)) out.tx_bytes = v;
  }
  // API `rx_bytes-r` / `tx_bytes-r` are bytes/sec; convert to kbps (×8 / 1000).
  if (entry['rx_bytes-r'] !== undefined && entry['rx_bytes-r'] !== null) {
    const v = Number(entry['rx_bytes-r']);
    if (Number.isFinite(v)) out.rx_rate_kbps = roundTo((v * 8) / 1000, 3);
  }
  if (entry['tx_bytes-r'] !== undefined && entry['tx_bytes-r'] !== null) {
    const v = Number(entry['tx_bytes-r']);
    if (Number.isFinite(v)) out.tx_rate_kbps = roundTo((v * 8) / 1000, 3);
  }
  if (entry.link_down_count !== undefined && entry.link_down_count !== null) {
    const v = parseInt(entry.link_down_count, 10);
    if (Number.isFinite(v)) out.link_down_count = v;
  }
  // Error / drop counters — surface only when the controller reported them so
  // an absent field doesn't masquerade as zero. The UI rolls these up into an
  // Anomaly indicator (link_down_count > 0 || any *_errors > 0 || rx_dropped).
  for (const key of ['rx_errors', 'tx_errors', 'rx_dropped', 'tx_dropped']) {
    if (entry[key] !== undefined && entry[key] !== null) {
      const v = parseInt(entry[key], 10);
      if (Number.isFinite(v)) out[key] = v;
    }
  }

  if (isPoeCapablePort(entry)) {
    out.poe_mode = String(entry.poe_mode ?? 'off');
    if (Array.isArray(entry.poe_caps)) {
      // Defensive copy — never expose the controller's array reference.
      out.poe_caps = entry.poe_caps.slice();
    }
    if (entry.poe_power !== undefined && entry.poe_power !== null) {
      const v = parseFloat(entry.poe_power);
      if (!Number.isNaN(v)) out.poe_power_w = v;
    }
    if (entry.poe_voltage !== undefined && entry.poe_voltage !== null) {
      const v = parseFloat(entry.poe_voltage);
      if (!Number.isNaN(v)) out.poe_voltage_v = v;
    }
    if (entry.poe_current !== undefined && entry.poe_current !== null) {
      const v = parseInt(entry.poe_current, 10);
      if (!Number.isNaN(v)) out.poe_current_ma = v;
    }
  }

  // Protected-port annotation — sourced from the in-process allowlist, NEVER
  // from the controller (T-08-04 mitigation). Annotation is added only when
  // true so a `false` claim cannot be spoofed by an absent field.
  if (
    opts &&
    typeof opts.deviceMac === 'string' &&
    Number.isFinite(out.port_idx) &&
    isProtectedPort(opts.deviceMac, out.port_idx)
  ) {
    out.protected = true;
  }

  return out;
}

/**
 * @typedef {Object} PublishedDeviceState
 * @property {string} mac
 * @property {string} name
 * @property {string} model
 * @property {string} type           "gateway" | "switch" | "ap" | <pass-through>.
 * @property {string} firmware
 * @property {number} uptime_sec
 * @property {string} state          Mapped via STATE_CODE_MAP.
 * @property {number} port_count
 * @property {number} poe_on_count   Count of ports with port_poe && poe_mode!=='off' && up.
 */

/**
 * Normalise a raw device record into the published device-level JSON shape.
 *
 * Per D-F-03 the API returns "udm" for UCG-MAX — mapped to "gateway" so
 * subscribers see a human-readable type. State-code mapping per PITFALLS
 * Pitfall 15. Unknown codes/types pass through unchanged (defensive — never
 * throw on a new code we haven't catalogued).
 *
 * @param {object} raw
 * @returns {PublishedDeviceState}
 */
export function normalizeDevice(raw) {
  const macLower = typeof raw.mac === 'string' ? raw.mac.toLowerCase() : '';
  const rawType = typeof raw.type === 'string' ? raw.type : '';
  const mappedType = TYPE_CODE_MAP[rawType] ?? rawType;

  let mappedState;
  if (Object.prototype.hasOwnProperty.call(STATE_CODE_MAP, raw.state)) {
    mappedState = STATE_CODE_MAP[raw.state];
  } else {
    // Unknown state code — surface verbatim so operators notice.
    mappedState = String(raw.state);
  }

  const portTable = Array.isArray(raw.port_table) ? raw.port_table : [];
  let poeOnCount = 0;
  for (const p of portTable) {
    if (p && p.port_poe === true && p.poe_mode !== 'off' && coerceBool(p.up)) {
      poeOnCount++;
    }
  }

  const out = {
    mac: macLower,
    name: typeof raw.name === 'string' ? raw.name : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    type: mappedType,
    firmware: typeof raw.version === 'string' ? raw.version : '',
    uptime_sec: Number.isFinite(raw.uptime) ? raw.uptime : 0,
    state: mappedState,
    port_count: portTable.length,
    poe_on_count: poeOnCount,
  };

  // D-P13-DEV-01 — enriched device-level fields. Each gated to omit on absence.
  if (typeof raw.ip === 'string' && raw.ip.length > 0) out.ip = raw.ip;

  const sysStats = raw['system-stats'];
  if (sysStats && typeof sysStats === 'object') {
    if (sysStats.cpu !== undefined && sysStats.cpu !== null) {
      const v = parseFloat(sysStats.cpu);
      if (!Number.isNaN(v)) out.cpu_pct = v;
    }
    if (sysStats.mem !== undefined && sysStats.mem !== null) {
      const v = parseFloat(sysStats.mem);
      if (!Number.isNaN(v)) out.mem_pct = v;
    }
  }

  // temperature_c: max across the temperatures[] array.
  if (Array.isArray(raw.temperatures) && raw.temperatures.length > 0) {
    let maxT = -Infinity;
    for (const t of raw.temperatures) {
      const v = parseFloat(t?.value);
      if (!Number.isNaN(v) && v > maxT) maxT = v;
    }
    if (Number.isFinite(maxT)) out.temperature_c = roundTo(maxT, 1);
  }

  // total_used_power_w — switches only carry this.
  if (raw.total_used_power !== undefined && raw.total_used_power !== null) {
    const v = parseFloat(raw.total_used_power);
    if (!Number.isNaN(v)) out.total_used_power_w = roundTo(v, 2);
  }

  if (raw.rx_bytes !== undefined && raw.rx_bytes !== null) {
    const v = Number(raw.rx_bytes);
    if (Number.isFinite(v)) out.total_rx_bytes = v;
  }
  if (raw.tx_bytes !== undefined && raw.tx_bytes !== null) {
    const v = Number(raw.tx_bytes);
    if (Number.isFinite(v)) out.total_tx_bytes = v;
  }

  if (raw.num_sta !== undefined && raw.num_sta !== null) {
    const v = parseInt(raw.num_sta, 10);
    if (Number.isFinite(v)) out.num_clients = v;
  }

  out.overheating = coerceBool(raw.overheating);

  // D-P13-DEV-02 — wireless/wired client-count breakdowns. Field names vary
  // across firmware: UDM gateway exposes `wlan-num_sta`/`lan-num_sta`; UAP
  // exposes `user-wlan-num_sta` only. Try both.
  const wlanRaw = raw['wlan-num_sta'] ?? raw['user-wlan-num_sta'];
  if (wlanRaw !== undefined && wlanRaw !== null) {
    const v = parseInt(wlanRaw, 10);
    if (Number.isFinite(v)) out.client_count_wireless = v;
  }
  const lanRaw = raw['lan-num_sta'] ?? raw['user-lan-num_sta'];
  if (lanRaw !== undefined && lanRaw !== null) {
    const v = parseInt(lanRaw, 10);
    if (Number.isFinite(v)) out.client_count_wired = v;
  }

  return out;
}

/**
 * Normalise a WAN sub-record on a gateway device.
 *
 * Per D-P13-WAN-03, returns a fixed-shape JSON object with throughput/availability
 * counters extracted from the controller's wan1 / wan2 sub-key. Returns null
 * when the device is not a gateway OR the requested WAN key is absent.
 *
 * @param {object} device      Raw gateway record from /stat/device.
 * @param {'wan1'|'wan2'} wanKey
 * @returns {object|null}
 */
export function normalizeWan(device, wanKey) {
  if (!device || typeof device !== 'object') return null;
  // Only gateways have WAN sub-keys per D-P13-DEV-03.
  if (device.type !== 'udm' && device.type !== 'ugw' && device.type !== 'gateway') return null;
  const wan = device[wanKey];
  if (!wan || typeof wan !== 'object') return null;

  const out = {
    interface: typeof wan.name === 'string' ? wan.name : (wan.ifname || null),
    up: coerceBool(wan.up),
    ip: typeof wan.ip === 'string' ? wan.ip : null,
    netmask: typeof wan.netmask === 'string' ? wan.netmask : null,
    gateway_ip: typeof wan.gateway_ip === 'string' ? wan.gateway_ip : null,
    mac: typeof wan.mac === 'string' ? wan.mac : null,
    latency_ms: Number.isFinite(wan.latency) ? wan.latency : null,
    availability_pct: Number.isFinite(wan.availability) ? wan.availability : null,
    max_speed_mbps: Number.isFinite(wan.max_speed) ? wan.max_speed : null,
    link_speed_mbps: Number.isFinite(wan.speed) ? wan.speed : null,
    full_duplex: coerceBool(wan.full_duplex),
    media: typeof wan.media === 'string' ? wan.media : null,
    uplink_ifname: typeof wan.uplink_ifname === 'string' ? wan.uplink_ifname : null,
    rx_bytes: Number.isFinite(wan.rx_bytes) ? wan.rx_bytes : null,
    tx_bytes: Number.isFinite(wan.tx_bytes) ? wan.tx_bytes : null,
    rx_rate_kbps: null,
    tx_rate_kbps: null,
    rx_packets: Number.isFinite(wan.rx_packets) ? wan.rx_packets : null,
    tx_packets: Number.isFinite(wan.tx_packets) ? wan.tx_packets : null,
    rx_errors: Number.isFinite(wan.rx_errors) ? wan.rx_errors : null,
    tx_errors: Number.isFinite(wan.tx_errors) ? wan.tx_errors : null,
  };

  // Rates: API field `rx_bytes-r` is bytes/sec; convert to kbps.
  if (wan['rx_bytes-r'] !== undefined && wan['rx_bytes-r'] !== null) {
    const v = Number(wan['rx_bytes-r']);
    if (Number.isFinite(v)) out.rx_rate_kbps = roundTo((v * 8) / 1000, 3);
  }
  if (wan['tx_bytes-r'] !== undefined && wan['tx_bytes-r'] !== null) {
    const v = Number(wan['tx_bytes-r']);
    if (Number.isFinite(v)) out.tx_rate_kbps = roundTo((v * 8) / 1000, 3);
  }

  return out;
}

/**
 * Normalise per-gateway ISP / public attributes. Per D-P13-WAN-04 returns
 * {isp_name, isp_organization, asn, public_ip}. The ISP block is sourced from
 * the health.wan subsystem record (controller-level metadata); public IP
 * falls back to wan1.ip when health is unavailable.
 *
 * @param {object} device       Raw gateway record.
 * @param {object|null} healthWan  /stat/health entry with subsystem==='wan'.
 * @returns {object|null}
 */
export function normalizeWanIsp(device, healthWan) {
  if (!device || typeof device !== 'object') return null;
  if (device.type !== 'udm' && device.type !== 'ugw' && device.type !== 'gateway') return null;

  const wan1 = device.wan1;
  const wan2 = device.wan2;
  const hasWan = Boolean(wan1 || wan2);
  const hasHealth = healthWan && typeof healthWan === 'object';
  if (!hasWan && !hasHealth) return null;

  let publicIp = null;
  if (hasHealth && typeof healthWan.wan_ip === 'string') publicIp = healthWan.wan_ip;
  else if (wan1 && typeof wan1.ip === 'string') publicIp = wan1.ip;
  else if (wan2 && typeof wan2.ip === 'string') publicIp = wan2.ip;

  return {
    isp_name: hasHealth && typeof healthWan.isp_name === 'string' ? healthWan.isp_name : null,
    isp_organization: hasHealth && typeof healthWan.isp_organization === 'string'
      ? healthWan.isp_organization : null,
    asn: hasHealth && Number.isFinite(healthWan.asn) ? healthWan.asn : null,
    public_ip: publicIp,
  };
}

/**
 * Site-level health rollup per D-P13-WAN-05. The controller's /stat/health
 * endpoint returns an array of subsystem records. This function collapses them
 * into a flat `{wlan, wan, lan, www, vpn}` object — empty fields omitted only
 * at the top level (a subsystem absent from the input → its key absent from
 * the output).
 *
 * @param {Array<object>|null} subsystems  /stat/health response.
 * @returns {object}
 */
export function normalizeSiteHealth(subsystems) {
  if (!Array.isArray(subsystems)) return {};
  const out = {};
  for (const sub of subsystems) {
    if (!sub || typeof sub !== 'object') continue;
    const key = sub.subsystem;
    if (key === 'wlan') {
      out.wlan = {
        num_ap: Number.isFinite(sub.num_ap) ? sub.num_ap : null,
        num_user: Number.isFinite(sub.num_user) ? sub.num_user : null,
        status: typeof sub.status === 'string' ? sub.status : 'unknown',
      };
    } else if (key === 'wan') {
      out.wan = {
        status: typeof sub.status === 'string' ? sub.status : 'unknown',
        isp_name: typeof sub.isp_name === 'string' ? sub.isp_name : null,
        public_ip: typeof sub.wan_ip === 'string' ? sub.wan_ip : null,
        latency_ms: Number.isFinite(sub.latency) ? sub.latency : null,
      };
    } else if (key === 'lan') {
      out.lan = {
        num_sw: Number.isFinite(sub.num_sw) ? sub.num_sw : null,
        num_user: Number.isFinite(sub.num_user) ? sub.num_user : null,
        status: typeof sub.status === 'string' ? sub.status : 'unknown',
      };
    } else if (key === 'www') {
      out.www = {
        status: typeof sub.status === 'string' ? sub.status : 'unknown',
        latency_ms: Number.isFinite(sub.latency) ? sub.latency : null,
        uptime: Number.isFinite(sub.uptime) ? sub.uptime : null,
        drops: Number.isFinite(sub.drops) ? sub.drops : null,
        speedtest_status: typeof sub.speedtest_status === 'string' ? sub.speedtest_status : null,
        speedtest_lastrun: Number.isFinite(sub.speedtest_lastrun) ? sub.speedtest_lastrun : null,
      };
    } else if (key === 'vpn') {
      out.vpn = { status: typeof sub.status === 'string' ? sub.status : 'unknown' };
    }
  }
  return out;
}

/**
 * Best-effort label for the device attached to a switch port.
 *
 * Resolution order (D-F-04):
 *   1. port.lldp_table[0].system_name   (non-empty string)
 *   2. port.lldp_table[0].chassis_id    (non-empty string)
 *   3. staList match where sw_mac===deviceMac (case-insensitive)
 *      AND sw_port===port_idx → sta.hostname || sta.name || sta.mac
 *   4. null
 *
 * No caching here — Plan 08-02 layers a 5-minute (deviceMac, port_idx) cache
 * around this function so we don't hammer /stat/sta on every port poll.
 *
 * @param {object} port                  port_table entry.
 * @param {string} deviceMac             Lowercase MAC of the device hosting the port.
 * @param {Array<object>|null} staList   /stat/sta data; pass null when unavailable.
 * @returns {string|null}
 */
export function deriveConnectedDevice(port, deviceMac, staList) {
  if (!port || typeof port !== 'object') return null;

  // 1) LLDP — system_name first, then chassis_id.
  const lldpRow = Array.isArray(port.lldp_table) && port.lldp_table.length > 0
    ? port.lldp_table[0]
    : null;
  if (lldpRow) {
    if (typeof lldpRow.system_name === 'string' && lldpRow.system_name.length > 0) {
      return lldpRow.system_name;
    }
    if (typeof lldpRow.chassis_id === 'string' && lldpRow.chassis_id.length > 0) {
      return lldpRow.chassis_id;
    }
  }

  // 2) /stat/sta lookup by (sw_mac, sw_port). MAC compare is case-insensitive.
  if (Array.isArray(staList) && typeof deviceMac === 'string') {
    const macNeedle = deviceMac.toLowerCase();
    const portIdx = parseInt(port.port_idx, 10);
    if (Number.isFinite(portIdx)) {
      for (const sta of staList) {
        if (!sta || typeof sta !== 'object') continue;
        if (typeof sta.sw_mac !== 'string') continue;
        if (sta.sw_mac.toLowerCase() !== macNeedle) continue;
        if (sta.sw_port !== portIdx) continue;
        if (typeof sta.hostname === 'string' && sta.hostname.length > 0) return sta.hostname;
        if (typeof sta.name === 'string' && sta.name.length > 0) return sta.name;
        if (typeof sta.mac === 'string' && sta.mac.length > 0) return sta.mac;
        return null; // matched the port but no useful label — surface null
      }
    }
  }

  return null;
}

/**
 * Phase 14 — derive home/not_home presence state for a client.
 *
 * Per D-P14-TOPIC-03: a client absent from /stat/sta for `staleAfterMs` ≥ 5 min
 * transitions home → not_home. The lastSeen here is the wall-clock ms timestamp
 * the poll engine recorded the LAST TIME this MAC appeared in /stat/sta — NOT
 * the controller's `last_seen` (which is seconds-since-epoch from the
 * controller's clock and may drift). Passing in `now` keeps the helper pure.
 *
 * @param {object} client       Normalised ClientState (only used to disambiguate guest).
 * @param {number} lastSeenMs   Wall-clock ms epoch of last /stat/sta presence.
 * @param {number} staleAfterMs Threshold (default 5 min).
 * @param {number} now          Wall-clock ms epoch.
 * @returns {'home'|'not_home'}
 */
export function deriveClientState(client, lastSeenMs, staleAfterMs, now) {
  if (typeof lastSeenMs !== 'number' || !Number.isFinite(lastSeenMs)) return 'not_home';
  const thr = (typeof staleAfterMs === 'number' && Number.isFinite(staleAfterMs))
    ? staleAfterMs
    : 5 * 60_000;
  const t = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
  return (t - lastSeenMs) <= thr ? 'home' : 'not_home';
}

/**
 * Phase 14 — friendly-name fallback chain per D-P14-FIELDS-01.
 *
 * Order:
 *   1. /rest/user.name        (user-edited friendly name)
 *   2. /rest/user.hostname    (controller-cached hostname)
 *   3. /stat/sta.hostname     (current connection hostname)
 *   4. `{dev_vendor || oui} {last-4-of-mac}` (best-effort generated)
 *   5. mac (raw fallback)
 *
 * @param {object} sta
 * @param {object|null} user
 * @returns {string|null}
 */
function deriveFriendlyName(sta, user) {
  if (user && typeof user.name === 'string' && user.name.length > 0) return user.name;
  if (user && typeof user.hostname === 'string' && user.hostname.length > 0) return user.hostname;
  if (sta && typeof sta.hostname === 'string' && sta.hostname.length > 0) return sta.hostname;
  const vendor = sta?.dev_vendor || sta?.oui || null;
  const mac = typeof sta?.mac === 'string' ? sta.mac.toLowerCase() : null;
  if (mac) {
    const tail = mac.replace(/[:\-]/g, '').slice(-4);
    if (vendor && tail.length === 4) return `${vendor} ${tail}`.trim();
    if (tail.length === 4) return `Client ${tail}`;
  }
  return mac;
}

/**
 * Phase 14 — normalise one /stat/sta row into the published ClientState shape.
 *
 * Cross-joined with /rest/user (friendly names), /rest/wlanconf (SSID metadata),
 * and the device snapshot (ap_name resolution). Pure — no IO, deterministic
 * output for a given input. Wireless-only fields are OMITTED entirely on wired
 * clients per D-P14-FIELDS-01 (NOT zeroed / NOT null — absent).
 *
 * @param {object} rawSta         A row from /stat/sta.
 * @param {object|null} userRecord A row from /rest/user keyed by mac (cross-join).
 * @param {object|null} wlanconf  An entry from /rest/wlanconf for this client's essid.
 * @param {Map<string,object>|null} deviceMap Map<macLower, deviceRecord> for ap_name lookup.
 * @param {number} [now]          Wall-clock ms (caller passes Date.now() for determinism).
 * @returns {object}              ClientState ready for JSON publish (caller adds _lastPublishedAt).
 */
export function normalizeClient(rawSta, userRecord, wlanconf, deviceMap, now) {
  if (!rawSta || typeof rawSta !== 'object') return null;

  const macLower = typeof rawSta.mac === 'string' ? rawSta.mac.toLowerCase() : null;
  if (!macLower) return null;

  const isWired = coerceBool(rawSta.is_wired);
  const ts = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();

  const out = {
    mac: macLower,
    hostname: typeof rawSta.hostname === 'string' && rawSta.hostname.length > 0
      ? rawSta.hostname : null,
    name: deriveFriendlyName(rawSta, userRecord || null),
    ip: typeof rawSta.ip === 'string' && rawSta.ip.length > 0 ? rawSta.ip : null,
    state: 'home', // caller may overwrite via deriveClientState during cleanup sweep
    is_wired: isWired,
    last_seen: Number.isFinite(rawSta.last_seen)
      ? new Date(rawSta.last_seen * 1000).toISOString() : null,
    first_seen: Number.isFinite(rawSta.first_seen)
      ? new Date(rawSta.first_seen * 1000).toISOString() : null,
  };

  if (Number.isFinite(rawSta.uptime)) out.uptime_sec = rawSta.uptime;
  if (Number.isFinite(rawSta.idletime)) out.idletime_sec = rawSta.idletime;

  // Common (best-effort) optional fields — only emit when present.
  if (Number.isFinite(rawSta.vlan)) out.vlan = rawSta.vlan;
  if (typeof rawSta.network === 'string' && rawSta.network.length > 0) {
    out.network_name = rawSta.network;
  }
  if (typeof rawSta.authorized === 'boolean') out.authorized = rawSta.authorized;
  else if (rawSta.authorized !== undefined) out.authorized = coerceBool(rawSta.authorized);
  if (typeof rawSta.oui === 'string' && rawSta.oui.length > 0) out.oui = rawSta.oui;
  if (typeof rawSta.dev_vendor === 'string' && rawSta.dev_vendor.length > 0) {
    out.dev_vendor = rawSta.dev_vendor;
  }
  if (typeof rawSta.dev_family === 'string' && rawSta.dev_family.length > 0) {
    out.dev_family = rawSta.dev_family;
  }
  if (typeof rawSta.os_name === 'string' && rawSta.os_name.length > 0) {
    out.os_name = rawSta.os_name;
  }
  // Add `note` from /rest/user when present (visible in HA tooltip).
  if (userRecord && typeof userRecord.note === 'string' && userRecord.note.length > 0) {
    out.note = userRecord.note;
  }

  if (isWired) {
    // -- Wired-only fields. Wireless fields are OMITTED entirely (D-P14-FIELDS-01).
    if (typeof rawSta.sw_mac === 'string' && rawSta.sw_mac.length > 0) {
      out.switch_mac = rawSta.sw_mac.toLowerCase();
      // ap_name resolution doubles as switch_name resolution — same deviceMap.
      if (deviceMap instanceof Map) {
        const sw = deviceMap.get(out.switch_mac);
        if (sw && typeof sw.name === 'string' && sw.name.length > 0) {
          out.switch_name = sw.name;
        }
      }
    }
    if (Number.isFinite(rawSta.sw_port)) out.switch_port_idx = rawSta.sw_port;
  } else {
    // -- Wireless-only fields.
    if (typeof rawSta.essid === 'string' && rawSta.essid.length > 0) {
      out.essid = rawSta.essid;
    }
    if (typeof rawSta.is_guest === 'boolean') out.is_guest = rawSta.is_guest;
    else if (rawSta.is_guest !== undefined) out.is_guest = coerceBool(rawSta.is_guest);

    if (Number.isFinite(rawSta.signal)) out.signal_dbm = rawSta.signal;
    else if (Number.isFinite(rawSta.rssi)) out.signal_dbm = rawSta.rssi - 95; // UniFi rssi → dBm

    if (typeof rawSta.ap_mac === 'string' && rawSta.ap_mac.length > 0) {
      out.ap_mac = rawSta.ap_mac.toLowerCase();
      if (deviceMap instanceof Map) {
        const ap = deviceMap.get(out.ap_mac);
        if (ap && typeof ap.name === 'string' && ap.name.length > 0) {
          out.ap_name = ap.name;
        }
      }
    }
    if (typeof rawSta.radio_proto === 'string' && rawSta.radio_proto.length > 0) {
      out.radio_proto = rawSta.radio_proto;
    } else if (typeof rawSta.radio === 'string' && rawSta.radio.length > 0) {
      out.radio_proto = rawSta.radio;
    }
    if (Number.isFinite(rawSta.channel)) out.channel = rawSta.channel;
    if (Number.isFinite(rawSta.tx_rate)) out.tx_rate_kbps = rawSta.tx_rate;
    if (Number.isFinite(rawSta.rx_rate)) out.rx_rate_kbps = rawSta.rx_rate;

    // SSID security mode from /rest/wlanconf cross-join.
    if (wlanconf && typeof wlanconf.security === 'string' && wlanconf.security.length > 0) {
      out.ssid_security = wlanconf.security;
    }
  }

  // Track the lastSeen WALL CLOCK so the cleanup sweep can compute state
  // without re-fetching /stat/sta. Stored as ms-epoch for downstream consumers.
  out._lastSeenMs = ts;

  return out;
}

/**
 * D-P13-PORT-03 — derive a STRUCTURED {name, mac, ip, hostname, vlan, last_seen}
 * detail for the device connected to a switch port.
 *
 * Resolution order:
 *   1. LLDP table  → seeds `name` (system_name), `mac` (chassis_id), `ip` (mgmt_address).
 *   2. /stat/sta join on (sw_mac, sw_port) → fills in `hostname`, `ip`, `vlan`,
 *      `mac` (if not already from LLDP), `last_seen`.
 *   3. If neither LLDP nor sta produced any field → return null.
 *
 * The return object always has the full key set with `null` for missing
 * fields so consumers (HA Discovery, webapp) can rely on shape stability.
 *
 * @param {object} port
 * @param {string} deviceMac
 * @param {Array<object>|null} staList
 * @returns {object|null}
 */
export function deriveConnectedDeviceDetail(port, deviceMac, staList) {
  if (!port || typeof port !== 'object') return null;

  let name = null;
  let mac = null;
  let ip = null;
  let hostname = null;
  let vlan = null;
  let lastSeen = null;

  // 1) LLDP seed.
  const lldpRow = Array.isArray(port.lldp_table) && port.lldp_table.length > 0
    ? port.lldp_table[0]
    : null;
  if (lldpRow) {
    if (typeof lldpRow.system_name === 'string' && lldpRow.system_name.length > 0) {
      name = lldpRow.system_name;
    }
    if (typeof lldpRow.chassis_id === 'string' && lldpRow.chassis_id.length > 0) {
      mac = lldpRow.chassis_id;
    }
    if (typeof lldpRow.mgmt_address === 'string' && lldpRow.mgmt_address.length > 0) {
      ip = lldpRow.mgmt_address;
    }
  }

  // 2) /stat/sta join.
  if (Array.isArray(staList) && typeof deviceMac === 'string') {
    const macNeedle = deviceMac.toLowerCase();
    const portIdx = parseInt(port.port_idx, 10);
    if (Number.isFinite(portIdx)) {
      for (const sta of staList) {
        if (!sta || typeof sta !== 'object') continue;
        if (typeof sta.sw_mac !== 'string') continue;
        if (sta.sw_mac.toLowerCase() !== macNeedle) continue;
        if (sta.sw_port !== portIdx) continue;
        if (!hostname && typeof sta.hostname === 'string' && sta.hostname.length > 0) {
          hostname = sta.hostname;
        }
        if (!ip && typeof sta.ip === 'string' && sta.ip.length > 0) ip = sta.ip;
        if (!mac && typeof sta.mac === 'string' && sta.mac.length > 0) mac = sta.mac;
        if (vlan === null && Number.isFinite(sta.vlan)) vlan = sta.vlan;
        if (lastSeen === null && Number.isFinite(sta.last_seen)) lastSeen = sta.last_seen;
        break;
      }
    }
  }

  // 3) Empty? → null.
  if (!name && !mac && !ip && !hostname && vlan === null && lastSeen === null) return null;

  return { name, mac, ip, hostname, vlan, last_seen: lastSeen };
}
