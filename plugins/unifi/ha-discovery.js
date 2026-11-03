/**
 * Home Assistant MQTT Discovery publisher for UniFi devices and ports.
 *
 * Phase 11 Plan 11-01 — emits one HA `device` card per UniFi unit (UDM, USW,
 * UAP) and a set of entities under each PoE-capable switch port:
 *
 *   - switch         PoE on/off via `{prefix}/{slug}/port/{idx}/cmd`
 *   - button         Cycle (`device_class: restart`, payload_press: 'cycle')
 *   - sensor power   W   (state_class: measurement, enabled_by_default: true)
 *   - sensor voltage V   (enabled_by_default: false — diagnostic)
 *   - sensor current mA  (enabled_by_default: false — diagnostic)
 *   - sensor link    Mbit/s data_rate (enabled_by_default: false — diagnostic)
 *   - binary_sensor  Connectivity (device_class: connectivity)
 *
 * Decisions pinned by tests/plugins/unifi/ha-discovery.test.js:
 *   D-HAD-01  Per-port topic layout and entity shapes
 *   D-HAD-02  device.identifiers prefixed with instanceId so two plugin
 *             instances managing the same MAC produce DISTINCT HA device
 *             cards (D-MI-02 — multi-instance isolation)
 *   D-HAD-03  availability_topic = `{prefix}/bridge/status` (existing Phase 7
 *             retained topic — `online` / `offline`)
 *   D-HAD-04  Non-PoE ports (SFP+ uplinks, WAN, etc.) produce ZERO entries.
 *             The port_poe===true gate is identical to Phase 8 telemetry's
 *             isPoeCapablePort. A port table with no PoE entries (UAP)
 *             produces zero publishes.
 *
 * Pure publish-side — no MQTT subscribe. The plugin.js lifecycle wires
 * publishDiscovery() on first poll, clearDiscovery() on stop/reload, and
 * re-publishes on structure-monitor diff events (add/rename/remove).
 *
 * Manufacturer is hard-coded to "Ubiquiti" — every UniFi-managed device
 * (gateway / switch / AP) is shipped by Ubiquiti regardless of model.
 */
import { macSlug } from '../lib/slug.js';

const MANUFACTURER = 'Ubiquiti';

/**
 * Build the seven discovery entries for one PoE-capable port.
 *
 * Returns an array of `{discoveryTopic, config}` — caller publishes each as
 * `mqtt.publish(discoveryTopic, JSON.stringify(config), {retain: true})`.
 *
 * Per D-HAD-04, callers MUST gate this with `port.port_poe === true`. We
 * still re-check here defensively so a stray non-PoE entry can't leak a
 * power sensor; returning an empty array is the safe response.
 *
 * @param {object} args
 * @param {string} args.instanceId   Plugin instance id (e.g. "unifi-dev").
 * @param {object} args.device       Structure-summary entry — {mac, name, nameSlug, model, type, port_table}.
 * @param {object} args.port         Raw port_table entry — {port_idx, port_poe, name}.
 * @param {string} args.haPrefix     Home-Assistant discovery prefix (default "homeassistant").
 * @param {string} args.topicPrefix  This plugin's MQTT topic prefix (e.g. "unifi-gateway1") — trailing slash stripped.
 * @returns {Array<{discoveryTopic: string, config: object}>}
 */
export function buildPortEntities({ instanceId, device, port, haPrefix, topicPrefix }) {
  if (!port || port.port_poe !== true) return [];
  const portIdx = parseInt(port.port_idx, 10);
  if (!Number.isFinite(portIdx) || portIdx < 1) return [];

  const prefix = String(topicPrefix).replace(/\/+$/, '');
  const haPref = String(haPrefix || 'homeassistant').replace(/\/+$/, '');
  const macslug = macSlug(device.mac);
  const idBase = `unifi_${instanceId}_${macslug}_p${portIdx}`;
  const stateTopic = `${prefix}/${device.nameSlug}/port/${portIdx}/state`;
  const cmdTopic = `${prefix}/${device.nameSlug}/port/${portIdx}/cmd`;
  const portName = port.name || `Port ${portIdx}`;

  // D-HAD-02 — device.identifiers carry the instanceId so two plugin
  // instances managing the same physical UniFi controller produce two
  // separate HA device cards (no collision; HA shows them side-by-side).
  const deviceCard = {
    identifiers: [`unifi_${instanceId}_${macslug}`],
    name: device.name || device.nameSlug,
    manufacturer: MANUFACTURER,
    model: device.model || 'UniFi',
    via_device: 'mqtt-master',
  };

  // D-HAD-03 — single availability source per plugin instance.
  const availability = [
    {
      topic: `${prefix}/bridge/status`,
      payload_available: 'online',
      payload_not_available: 'offline',
    },
  ];

  const baseConfig = (uniqueIdSuffix, name) => ({
    name: `${device.name} ${portName} ${name}`,
    unique_id: `${idBase}_${uniqueIdSuffix}`,
    state_topic: stateTopic,
    availability,
    device: deviceCard,
  });

  // 1) switch — PoE on/off
  const switchCfg = {
    ...baseConfig('poe', 'PoE'),
    command_topic: cmdTopic,
    payload_on: 'on',
    payload_off: 'off',
    value_template: "{{ value_json.poe_mode == 'auto' }}",
    state_on: true,
    state_off: false,
  };

  // 2) button — cycle
  const buttonCfg = {
    name: `${device.name} ${portName} Cycle`,
    unique_id: `${idBase}_cycle`,
    command_topic: cmdTopic,
    payload_press: 'cycle',
    device_class: 'restart',
    availability,
    device: deviceCard,
  };

  // 3) sensor power (W)
  const powerCfg = {
    ...baseConfig('power', 'Power'),
    device_class: 'power',
    unit_of_measurement: 'W',
    state_class: 'measurement',
    value_template: '{{ value_json.poe_power_w }}',
  };

  // 4) sensor voltage (V) — diagnostic
  const voltageCfg = {
    ...baseConfig('voltage', 'Voltage'),
    device_class: 'voltage',
    unit_of_measurement: 'V',
    state_class: 'measurement',
    value_template: '{{ value_json.poe_voltage_v }}',
    enabled_by_default: false,
  };

  // 5) sensor current (mA) — diagnostic
  const currentCfg = {
    ...baseConfig('current', 'Current'),
    device_class: 'current',
    unit_of_measurement: 'mA',
    state_class: 'measurement',
    value_template: '{{ value_json.poe_current_ma }}',
    enabled_by_default: false,
  };

  // 6) sensor link_speed (Mbit/s) — diagnostic
  const linkSpeedCfg = {
    ...baseConfig('link_speed', 'Link Speed'),
    device_class: 'data_rate',
    unit_of_measurement: 'Mbit/s',
    state_class: 'measurement',
    value_template: '{{ value_json.link_speed_mbps }}',
    enabled_by_default: false,
  };

  // 7) binary_sensor — connectivity
  const linkCfg = {
    ...baseConfig('link', 'Link'),
    device_class: 'connectivity',
    value_template: '{{ value_json.link_up }}',
    payload_on: 'true',
    payload_off: 'false',
  };

  // Phase 13 — diagnostic sensors per D-P13-HA-01. All enabled_by_default:false.
  const rxRateCfg = {
    ...baseConfig('rx_rate', 'RX Rate'),
    device_class: 'data_rate',
    unit_of_measurement: 'kbit/s',
    state_class: 'measurement',
    value_template: '{{ value_json.rx_rate_kbps }}',
    enabled_by_default: false,
  };
  const txRateCfg = {
    ...baseConfig('tx_rate', 'TX Rate'),
    device_class: 'data_rate',
    unit_of_measurement: 'kbit/s',
    state_class: 'measurement',
    value_template: '{{ value_json.tx_rate_kbps }}',
    enabled_by_default: false,
  };
  // No device_class — link_down_count is a counter, not a known HA quantity.
  const linkDownCountCfg = {
    ...baseConfig('link_down_count', 'Link Down Count'),
    state_class: 'total_increasing',
    value_template: '{{ value_json.link_down_count }}',
    enabled_by_default: false,
  };

  return [
    { discoveryTopic: `${haPref}/switch/${idBase}_poe/config`, config: switchCfg },
    { discoveryTopic: `${haPref}/button/${idBase}_cycle/config`, config: buttonCfg },
    { discoveryTopic: `${haPref}/sensor/${idBase}_power/config`, config: powerCfg },
    { discoveryTopic: `${haPref}/sensor/${idBase}_voltage/config`, config: voltageCfg },
    { discoveryTopic: `${haPref}/sensor/${idBase}_current/config`, config: currentCfg },
    { discoveryTopic: `${haPref}/sensor/${idBase}_link_speed/config`, config: linkSpeedCfg },
    { discoveryTopic: `${haPref}/sensor/${idBase}_rx_rate/config`, config: rxRateCfg },
    { discoveryTopic: `${haPref}/sensor/${idBase}_tx_rate/config`, config: txRateCfg },
    { discoveryTopic: `${haPref}/sensor/${idBase}_link_down_count/config`, config: linkDownCountCfg },
    { discoveryTopic: `${haPref}/binary_sensor/${idBase}_link/config`, config: linkCfg },
  ];
}

/**
 * Phase 13 — build per-gateway WAN discovery entities (D-P13-HA-02).
 *
 * Emits 10 entities for a gateway device:
 *   - sensor wan_public_ip          state from {prefix}/{slug}/wan/isp/state
 *   - sensor wan_latency_ms         state from {prefix}/{slug}/wan/1/state
 *   - sensor wan_rx_rate / tx_rate  state from {prefix}/{slug}/wan/1/state
 *   - sensor wan_isp_name           state from .../wan/isp/state
 *   - sensor wan_uptime_sec         state from .../wan/1/state (via uptime field)
 *   - sensor speedtest_download_mbps / upload_mbps / ping_ms — state from
 *     .../site/health.www.speedtest_* (publishDiscovery wires the state topic;
 *     value_templates extract the right nested path)
 *   - button speedtest_run          publishes 'speedtest' to .../wan/cmd
 *
 * Non-gateway devices return [].
 *
 * @param {object} args
 * @param {string} args.instanceId
 * @param {object} args.device     Structure-summary entry (must carry type === 'udm'/'ugw'/'gateway').
 * @param {string} args.haPrefix
 * @param {string} args.topicPrefix
 * @returns {Array<{discoveryTopic: string, config: object}>}
 */
export function buildGatewayWanEntities({ instanceId, device, haPrefix, topicPrefix }) {
  if (!device || typeof device !== 'object') return [];
  if (device.type !== 'udm' && device.type !== 'ugw' && device.type !== 'gateway') return [];

  const prefix = String(topicPrefix).replace(/\/+$/, '');
  const haPref = String(haPrefix || 'homeassistant').replace(/\/+$/, '');
  const macslug = macSlug(device.mac);
  const idBase = `unifi_${instanceId}_${macslug}`;
  const wan1State = `${prefix}/${device.nameSlug}/wan/1/state`;
  const ispState = `${prefix}/${device.nameSlug}/wan/isp/state`;
  const siteHealth = `${prefix}/site/health`;
  const wanCmd = `${prefix}/${device.nameSlug}/wan/cmd`;

  const deviceCard = {
    identifiers: [`unifi_${instanceId}_${macslug}`],
    name: device.name || device.nameSlug,
    manufacturer: MANUFACTURER,
    model: device.model || 'UniFi',
    via_device: 'mqtt-master',
  };
  const availability = [
    {
      topic: `${prefix}/bridge/status`,
      payload_available: 'online',
      payload_not_available: 'offline',
    },
  ];

  const sensor = (suffix, name, opts = {}) => ({
    discoveryTopic: `${haPref}/sensor/${idBase}_${suffix}/config`,
    config: {
      name: `${device.name} ${name}`,
      unique_id: `${idBase}_${suffix}`,
      state_topic: opts.state_topic || wan1State,
      availability,
      device: deviceCard,
      enabled_by_default: false,
      ...opts.extra,
    },
  });

  const publicIp = sensor('wan_public_ip', 'WAN Public IP', {
    state_topic: ispState,
    extra: { value_template: '{{ value_json.public_ip }}' },
  });
  const latency = sensor('wan_latency', 'WAN Latency', {
    extra: {
      device_class: 'duration',
      unit_of_measurement: 'ms',
      state_class: 'measurement',
      value_template: '{{ value_json.latency_ms }}',
    },
  });
  const rxRate = sensor('wan_rx_rate', 'WAN RX Rate', {
    extra: {
      device_class: 'data_rate',
      unit_of_measurement: 'kbit/s',
      state_class: 'measurement',
      value_template: '{{ value_json.rx_rate_kbps }}',
    },
  });
  const txRate = sensor('wan_tx_rate', 'WAN TX Rate', {
    extra: {
      device_class: 'data_rate',
      unit_of_measurement: 'kbit/s',
      state_class: 'measurement',
      value_template: '{{ value_json.tx_rate_kbps }}',
    },
  });
  const ispName = sensor('wan_isp_name', 'WAN ISP', {
    state_topic: ispState,
    extra: { value_template: '{{ value_json.isp_name }}' },
  });
  // uptime sourced from www.uptime in site/health (closest available metric).
  const uptime = sensor('wan_uptime', 'WAN Uptime', {
    state_topic: siteHealth,
    extra: {
      device_class: 'duration',
      unit_of_measurement: 's',
      state_class: 'measurement',
      value_template: '{{ value_json.www.uptime }}',
    },
  });
  // Speedtest results live in site/health.www.{drops}/speedtest_status; for the
  // dl/ul/ping values UniFi exposes them only on the speedtest run record. We
  // expose the same site-level shape — value_templates can be tweaked later.
  const stDl = sensor('speedtest_download', 'Speedtest Download', {
    state_topic: siteHealth,
    extra: {
      device_class: 'data_rate',
      unit_of_measurement: 'Mbit/s',
      state_class: 'measurement',
      value_template: '{{ value_json.www.xput_down | default(0) }}',
    },
  });
  const stUp = sensor('speedtest_upload', 'Speedtest Upload', {
    state_topic: siteHealth,
    extra: {
      device_class: 'data_rate',
      unit_of_measurement: 'Mbit/s',
      state_class: 'measurement',
      value_template: '{{ value_json.www.xput_up | default(0) }}',
    },
  });
  const stPing = sensor('speedtest_ping', 'Speedtest Ping', {
    state_topic: siteHealth,
    extra: {
      device_class: 'duration',
      unit_of_measurement: 'ms',
      state_class: 'measurement',
      value_template: '{{ value_json.www.speedtest_ping | default(0) }}',
    },
  });

  // Button — speedtest_run. The HA button does not honour enabled_by_default
  // (the integration always shows buttons), so we omit it.
  const speedtestBtn = {
    discoveryTopic: `${haPref}/button/${idBase}_speedtest_run/config`,
    config: {
      name: `${device.name} Run Speedtest`,
      unique_id: `${idBase}_speedtest_run`,
      command_topic: wanCmd,
      payload_press: 'speedtest',
      device_class: 'restart',
      availability,
      device: deviceCard,
    },
  };

  return [publicIp, latency, rxRate, txRate, ispName, uptime, stDl, stUp, stPing, speedtestBtn];
}

/**
 * Phase 14 — build per-client `device_tracker` + diagnostic `sensor` entities
 * for HA Discovery per D-P14-HA-01 / D-P14-HA-02.
 *
 * Returns:
 *   - device_tracker  unique_id `unifi_{instanceId}_client_{macslug}`, source_type:router,
 *                     value_template `{{ value_json.state }}`, payload_home/not_home.
 *   - sensor signal_dbm  (wireless clients only)
 *   - sensor last_seen   (timestamp; ISO from state payload)
 *
 * All entities have `enabled_by_default: false` so HA doesn't auto-flood the UI
 * with 26+ entities on first scan — the user enables per-MAC (e.g. their iPhone).
 *
 * @param {object} args
 * @param {string} args.instanceId
 * @param {object} args.client     Normalised ClientState — must carry mac + name + is_wired.
 * @param {string} args.topicPrefix
 * @param {string} [args.haPrefix]
 * @returns {Array<{discoveryTopic: string, config: object}>}
 */
export function buildClientTrackerEntity({ instanceId, client, topicPrefix, haPrefix }) {
  if (!client || typeof client.mac !== 'string') return [];
  const macLower = client.mac.toLowerCase();
  const macslug = macSlug(macLower);
  if (macslug === 'unknown-mac') return [];

  const prefix = String(topicPrefix).replace(/\/+$/, '');
  const haPref = String(haPrefix || 'homeassistant').replace(/\/+$/, '');
  const idBase = `unifi_${instanceId}_client_${macslug}`;
  const stateTopic = `${prefix}/clients/by-mac/${macslug}/state`;

  const niceName = client.name || client.hostname || macLower;

  const deviceCard = {
    identifiers: [`unifi_client_${macLower}`],
    name: niceName,
    manufacturer: client.dev_vendor || client.oui || 'UniFi Client',
    model: client.os_name || client.dev_family || 'Network device',
    via_device: 'mqtt-master',
  };
  const availability = [
    {
      topic: `${prefix}/bridge/status`,
      payload_available: 'online',
      payload_not_available: 'offline',
    },
  ];

  // device_tracker — the load-bearing entity for presence automations.
  const trackerCfg = {
    name: `${niceName}`,
    unique_id: idBase,
    state_topic: stateTopic,
    value_template: '{{ value_json.state }}',
    payload_home: 'home',
    payload_not_home: 'not_home',
    source_type: 'router',
    availability,
    device: deviceCard,
    enabled_by_default: false, // D-P14-HA-01
  };
  const entities = [
    { discoveryTopic: `${haPref}/device_tracker/${idBase}/config`, config: trackerCfg },
  ];

  // Per D-P14-HA-02 — last_seen sensor for ALL clients (wired + wireless).
  const lastSeenCfg = {
    name: `${niceName} Last Seen`,
    unique_id: `${idBase}_last_seen`,
    state_topic: stateTopic,
    value_template: '{{ value_json.last_seen }}',
    device_class: 'timestamp',
    availability,
    device: deviceCard,
    enabled_by_default: false,
  };
  entities.push({
    discoveryTopic: `${haPref}/sensor/${idBase}_last_seen/config`,
    config: lastSeenCfg,
  });

  // signal_dbm sensor — wireless clients only (wired has no RSSI).
  if (!client.is_wired) {
    const signalCfg = {
      name: `${niceName} Signal`,
      unique_id: `${idBase}_signal_dbm`,
      state_topic: stateTopic,
      value_template: '{{ value_json.signal_dbm }}',
      device_class: 'signal_strength',
      unit_of_measurement: 'dBm',
      state_class: 'measurement',
      availability,
      device: deviceCard,
      enabled_by_default: false,
    };
    entities.push({
      discoveryTopic: `${haPref}/sensor/${idBase}_signal_dbm/config`,
      config: signalCfg,
    });
  }

  return entities;
}

/**
 * Enumerate the HA Discovery topics this plugin publishes for a single client
 * (device_tracker + last_seen + optional signal_dbm). Used by both
 * `publishClientDiscovery` and `clearClientDiscovery` so the publish/clear
 * topic sets stay in lockstep.
 *
 * @param {object} args
 * @param {string} args.instanceId
 * @param {object} args.client
 * @param {string} args.haPrefix
 * @returns {Array<string>}
 */
function enumerateClientDiscoveryTopics({ instanceId, client, haPrefix }) {
  if (!client || typeof client.mac !== 'string') return [];
  const macLower = client.mac.toLowerCase();
  const macslug = macSlug(macLower);
  if (macslug === 'unknown-mac') return [];
  const haPref = String(haPrefix || 'homeassistant').replace(/\/+$/, '');
  const idBase = `unifi_${instanceId}_client_${macslug}`;
  const topics = [
    `${haPref}/device_tracker/${idBase}/config`,
    `${haPref}/sensor/${idBase}_last_seen/config`,
  ];
  if (!client.is_wired) {
    topics.push(`${haPref}/sensor/${idBase}_signal_dbm/config`);
  }
  return topics;
}

/**
 * Publish HA Discovery entities for one or more clients. Retained publish per
 * entity. Caller is responsible for D-P14-PERF-02 anti-storm: pass only the
 * NEWLY-seen clients or clients whose name has changed since last publish.
 *
 * @param {object} args
 * @param {object} args.mqttService
 * @param {string} args.instanceId
 * @param {string} args.topicPrefix
 * @param {Array<object>} args.clients   Normalised ClientState entries.
 * @param {string} [args.haPrefix]
 */
export function publishClientDiscovery({ mqttService, instanceId, topicPrefix, clients, haPrefix }) {
  if (!mqttService || typeof mqttService.publish !== 'function') return;
  for (const client of clients || []) {
    if (!client) continue;
    const entities = buildClientTrackerEntity({
      instanceId,
      client,
      topicPrefix,
      haPrefix: haPrefix || 'homeassistant',
    });
    for (const e of entities) {
      mqttService.publish(e.discoveryTopic, JSON.stringify(e.config), { retain: true });
    }
  }
}

/**
 * Retain-clear (empty retained payload) every HA Discovery topic this plugin
 * previously published for the given client set. Called from the cleanup
 * sweep (D-P14-TOPIC-03 — clients absent > 24h) and from plugin.stop().
 *
 * @param {object} args
 * @param {object} args.mqttService
 * @param {string} args.instanceId
 * @param {Array<object>} args.clients
 * @param {string} [args.haPrefix]
 */
export function clearClientDiscovery({ mqttService, instanceId, clients, haPrefix }) {
  if (!mqttService || typeof mqttService.publish !== 'function') return;
  for (const client of clients || []) {
    if (!client) continue;
    const topics = enumerateClientDiscoveryTopics({
      instanceId,
      client,
      haPrefix: haPrefix || 'homeassistant',
    });
    for (const topic of topics) {
      mqttService.publish(topic, '', { retain: true });
    }
  }
}

/**
 * Compute the full set of discovery topics that publishDiscovery WOULD write
 * for the given devices. Used by clearDiscovery to retain-clear exactly the
 * topics we previously published.
 *
 * Pure — no IO. Returns a deduplicated array of topic strings (no payload).
 *
 * @param {object} args
 * @param {string} args.instanceId
 * @param {Array<object>} args.devices  Structure-summary entries.
 * @param {string} args.haPrefix
 * @returns {Array<string>}
 */
function enumerateDiscoveryTopics({ instanceId, devices, haPrefix }) {
  const haPref = String(haPrefix || 'homeassistant').replace(/\/+$/, '');
  const topics = [];
  for (const device of devices || []) {
    if (!device) continue;
    const macslug = macSlug(device.mac);
    // Port entities (unchanged port_table walk).
    if (Array.isArray(device.port_table)) {
      for (const port of device.port_table) {
        if (!port || port.port_poe !== true) continue;
        const portIdx = parseInt(port.port_idx, 10);
        if (!Number.isFinite(portIdx) || portIdx < 1) continue;
        const idBase = `unifi_${instanceId}_${macslug}_p${portIdx}`;
        topics.push(`${haPref}/switch/${idBase}_poe/config`);
        topics.push(`${haPref}/button/${idBase}_cycle/config`);
        topics.push(`${haPref}/sensor/${idBase}_power/config`);
        topics.push(`${haPref}/sensor/${idBase}_voltage/config`);
        topics.push(`${haPref}/sensor/${idBase}_current/config`);
        topics.push(`${haPref}/sensor/${idBase}_link_speed/config`);
        topics.push(`${haPref}/sensor/${idBase}_rx_rate/config`);
        topics.push(`${haPref}/sensor/${idBase}_tx_rate/config`);
        topics.push(`${haPref}/sensor/${idBase}_link_down_count/config`);
        topics.push(`${haPref}/binary_sensor/${idBase}_link/config`);
      }
    }
    // Phase 13 — gateway WAN entities.
    if (device.type === 'udm' || device.type === 'ugw' || device.type === 'gateway') {
      const idBase = `unifi_${instanceId}_${macslug}`;
      topics.push(`${haPref}/sensor/${idBase}_wan_public_ip/config`);
      topics.push(`${haPref}/sensor/${idBase}_wan_latency/config`);
      topics.push(`${haPref}/sensor/${idBase}_wan_rx_rate/config`);
      topics.push(`${haPref}/sensor/${idBase}_wan_tx_rate/config`);
      topics.push(`${haPref}/sensor/${idBase}_wan_isp_name/config`);
      topics.push(`${haPref}/sensor/${idBase}_wan_uptime/config`);
      topics.push(`${haPref}/sensor/${idBase}_speedtest_download/config`);
      topics.push(`${haPref}/sensor/${idBase}_speedtest_upload/config`);
      topics.push(`${haPref}/sensor/${idBase}_speedtest_ping/config`);
      topics.push(`${haPref}/button/${idBase}_speedtest_run/config`);
    }
  }
  return topics;
}

/**
 * Publish HA Discovery config payloads for every PoE-capable port across the
 * given devices. Every publish is retained (D-LIFE-02) so HA picks up entities
 * on restart.
 *
 * @param {object} args
 * @param {object} args.mqttService   Has `.publish(topic, payload, opts)`.
 * @param {string} args.topicPrefix   This plugin's MQTT prefix (e.g. "unifi-gateway1/").
 * @param {string} args.instanceId    Plugin instance id.
 * @param {Array<object>} args.devices Structure-summary entries.
 * @param {string} [args.haPrefix]    HA discovery prefix (default "homeassistant").
 */
export function publishDiscovery({ mqttService, topicPrefix, instanceId, devices, haPrefix }) {
  if (!mqttService || typeof mqttService.publish !== 'function') return;
  for (const device of devices || []) {
    if (!device) continue;
    // Port entities (existing).
    if (Array.isArray(device.port_table)) {
      for (const port of device.port_table) {
        const entities = buildPortEntities({
          instanceId,
          device,
          port,
          haPrefix: haPrefix || 'homeassistant',
          topicPrefix,
        });
        for (const e of entities) {
          mqttService.publish(e.discoveryTopic, JSON.stringify(e.config), { retain: true });
        }
      }
    }
    // Phase 13 — gateway WAN entities (D-P13-HA-02). Empty for non-gateway.
    const wanEntities = buildGatewayWanEntities({
      instanceId,
      device,
      haPrefix: haPrefix || 'homeassistant',
      topicPrefix,
    });
    for (const e of wanEntities) {
      mqttService.publish(e.discoveryTopic, JSON.stringify(e.config), { retain: true });
    }
  }
}

/**
 * Clear (retain-clear with empty payload) every discovery topic this plugin
 * instance has published for the given device set. Per D-LIFE-03 HA treats an
 * empty retained payload as "entity removed".
 *
 * Caller passes the device set as it existed PRIOR to the shutdown / reload —
 * i.e. the same set that publishDiscovery was last called with. Stale topics
 * for devices that have already disappeared from the structure cache need to
 * be cleared via the structure-monitor diff handler (per-device removal).
 *
 * @param {object} args
 * @param {object} args.mqttService
 * @param {string} args.instanceId
 * @param {Array<object>} args.devices
 * @param {string} [args.haPrefix]
 */
export function clearDiscovery({ mqttService, instanceId, devices, haPrefix }) {
  if (!mqttService || typeof mqttService.publish !== 'function') return;
  const topics = enumerateDiscoveryTopics({
    instanceId,
    devices: devices || [],
    haPrefix: haPrefix || 'homeassistant',
  });
  for (const topic of topics) {
    mqttService.publish(topic, '', { retain: true });
  }
}
