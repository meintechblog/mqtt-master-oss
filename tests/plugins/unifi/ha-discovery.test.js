/**
 * plugins/unifi/ha-discovery.js — HA MQTT Discovery publisher tests.
 *
 * Phase 11 Plan 11-01.
 *
 * Pins the D-HAD-01..D-HAD-04 contract:
 *   - 6 entities per PoE-capable port (switch / button / 4 sensors / binary_sensor)
 *   - One HA device card per UniFi unit, identifiers include instanceId (D-HAD-02)
 *   - SFP+ / non-PoE ports → ZERO discovery entries (D-HAD-04)
 *   - Two plugin instances → distinct unique_id values for the same MAC (D-MI-02)
 *   - clearDiscovery publishes empty retained payload to every discovery topic
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  publishDiscovery,
  clearDiscovery,
  buildPortEntities,
  buildClientTrackerEntity,
  publishClientDiscovery,
  clearClientDiscovery,
} from '../../../plugins/unifi/ha-discovery.js';

const fixturePath = path.resolve(
  __dirname,
  '../../fixtures/unifi/stat-device-3devices.json',
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const usw = fixture.data.find((d) => d.type === 'usw');
const ucg = fixture.data.find((d) => d.type === 'udm');
const uap = fixture.data.find((d) => d.type === 'uap');

/**
 * Build a deviceEntry argument shaped like UnifiPoll.getStructureSummary()
 * entries — `{mac, name, nameSlug, model, type, port_table}` where port_table
 * carries the raw API entries (we only read `port_idx` + `port_poe` + `name`).
 */
function asDevice(raw) {
  return {
    mac: raw.mac.toLowerCase(),
    name: raw.name,
    nameSlug: raw.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    model: raw.model,
    type: raw.type,
    port_table: raw.port_table || [],
  };
}

function mockMqtt() {
  return {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
}

describe('buildPortEntities (D-HAD-01)', () => {
  it('Test 1 — PoE-capable port produces exactly 10 discovery entries (D-HAD-01 + D-P13-HA-01)', () => {
    const port = usw.port_table[0]; // port_idx 1, port_poe=true
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    // D-HAD-01 + Phase 13 enumerate 10 entities: switch + button + 7 sensors
    // (power, voltage, current, link_speed, rx_rate, tx_rate, link_down_count)
    // + binary_sensor.
    expect(entities).toHaveLength(10);
    const components = entities.map((e) => e.discoveryTopic.split('/')[1]).sort();
    expect(components).toEqual([
      'binary_sensor', 'button',
      'sensor', 'sensor', 'sensor', 'sensor', 'sensor', 'sensor', 'sensor',
      'switch',
    ]);
  });

  it('Test 2 — switch entity wiring: command_topic, payload_on/off, value_template', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const sw = entities.find((e) => e.discoveryTopic.includes('/switch/'));
    expect(sw).toBeDefined();
    expect(sw.config.command_topic).toBe(`unifi-gateway1/${device.nameSlug}/port/1/cmd`);
    expect(sw.config.payload_on).toBe('on');
    expect(sw.config.payload_off).toBe('off');
    expect(sw.config.state_topic).toBe(`unifi-gateway1/${device.nameSlug}/port/1/state`);
    expect(sw.config.value_template).toBe("{{ value_json.poe_mode == 'auto' }}");
    expect(sw.config.state_on).toBe(true);
    expect(sw.config.state_off).toBe(false);
  });

  it('Test 3 — button entity: device_class:restart, payload_press:cycle', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const btn = entities.find((e) => e.discoveryTopic.includes('/button/'));
    expect(btn).toBeDefined();
    expect(btn.config.command_topic).toBe(`unifi-gateway1/${device.nameSlug}/port/1/cmd`);
    expect(btn.config.payload_press).toBe('cycle');
    expect(btn.config.device_class).toBe('restart');
  });

  it('Test 4 — power sensor: device_class:power, unit W, state_class:measurement', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const power = entities.find((e) => e.discoveryTopic.endsWith('_power/config'));
    expect(power).toBeDefined();
    expect(power.config.device_class).toBe('power');
    expect(power.config.unit_of_measurement).toBe('W');
    expect(power.config.state_class).toBe('measurement');
    expect(power.config.value_template).toBe('{{ value_json.poe_power_w }}');
    // Power is the headline sensor → enabled by default.
    expect(power.config.enabled_by_default !== false).toBe(true);
  });

  it('Test 5 — voltage/current/link_speed sensors are enabled_by_default:false', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const voltage = entities.find((e) => e.discoveryTopic.endsWith('_voltage/config'));
    const current = entities.find((e) => e.discoveryTopic.endsWith('_current/config'));
    const linkSpeed = entities.find((e) => e.discoveryTopic.endsWith('_link_speed/config'));
    expect(voltage.config.device_class).toBe('voltage');
    expect(voltage.config.unit_of_measurement).toBe('V');
    expect(voltage.config.enabled_by_default).toBe(false);
    expect(current.config.device_class).toBe('current');
    expect(current.config.unit_of_measurement).toBe('mA');
    expect(current.config.enabled_by_default).toBe(false);
    expect(linkSpeed.config.device_class).toBe('data_rate');
    expect(linkSpeed.config.unit_of_measurement).toBe('Mbit/s');
    expect(linkSpeed.config.enabled_by_default).toBe(false);
  });

  it('Test 6 — binary_sensor link: device_class:connectivity, value_template extracts link_up', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const link = entities.find((e) => e.discoveryTopic.includes('/binary_sensor/'));
    expect(link).toBeDefined();
    expect(link.config.device_class).toBe('connectivity');
    expect(link.config.value_template).toBe('{{ value_json.link_up }}');
    expect(link.config.payload_on).toBe('true');
    expect(link.config.payload_off).toBe('false');
  });

  it('Test 7 — D-HAD-02: every port-entity shares device.identifiers = ["unifi_{iid}_{macslug}"]', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    // Compute expected macslug (lowercase, dash-separated).
    const macslug = device.mac.replace(/:/g, '-');
    const expectedId = `unifi_unifi-dev_${macslug}`;
    for (const e of entities) {
      expect(e.config.device.identifiers).toEqual([expectedId]);
      expect(e.config.device.name).toBe(device.name);
      expect(e.config.device.model).toBe(device.model);
      expect(e.config.device.manufacturer).toBe('Ubiquiti');
    }
  });

  it('Test 8 — every entity unique_id contains instanceId + macslug + port_idx + entityType', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const macslug = device.mac.replace(/:/g, '-');
    // Phase 13 adds rx_rate, tx_rate, link_down_count to the per-port suite.
    const types = [
      'poe', 'cycle', 'power', 'voltage', 'current', 'link_speed',
      'rx_rate', 'tx_rate', 'link_down_count', 'link',
    ];
    const seen = new Set();
    for (const e of entities) {
      const u = e.config.unique_id;
      expect(u.startsWith(`unifi_unifi-dev_${macslug}_p1_`)).toBe(true);
      const tail = u.split('_p1_')[1];
      expect(types).toContain(tail);
      seen.add(tail);
    }
    expect(seen.size).toBe(10);
  });

  it('Test 9 — every entity carries availability_topic = {prefix}/bridge/status (D-HAD-03)', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    for (const e of entities) {
      expect(Array.isArray(e.config.availability)).toBe(true);
      expect(e.config.availability[0].topic).toBe('unifi-gateway1/bridge/status');
      expect(e.config.availability[0].payload_available).toBe('online');
      expect(e.config.availability[0].payload_not_available).toBe('offline');
    }
  });
});

describe('publishDiscovery (D-HAD-04, multi-port aggregation)', () => {
  let mqtt;
  beforeEach(() => {
    mqtt = mockMqtt();
  });

  it('Test 10 — D-HAD-04: SFP+ / non-PoE ports produce ZERO discovery entries', () => {
    const device = asDevice(usw);
    publishDiscovery({
      mqttService: mqtt,
      topicPrefix: 'unifi-gateway1',
      instanceId: 'unifi-dev',
      devices: [device],
      haPrefix: 'homeassistant',
    });
    // Walk every publish call — no topic should encode SFP+ port indexes 17 or 18.
    for (const call of mqtt.publish.mock.calls) {
      const topic = call[0];
      expect(topic).not.toMatch(/_p17_/);
      expect(topic).not.toMatch(/_p18_/);
    }
  });

  it('Test 11 — USPM16P (16 PoE ports) emits exactly 16*7 = 112 discovery topics', () => {
    const device = asDevice(usw);
    publishDiscovery({
      mqttService: mqtt,
      topicPrefix: 'unifi-gateway1',
      instanceId: 'unifi-dev',
      devices: [device],
      haPrefix: 'homeassistant',
    });
    // Count actual config publishes (filter out any non-discovery publishes).
    const configPublishes = mqtt.publish.mock.calls.filter(
      ([t]) => typeof t === 'string' && t.startsWith('homeassistant/') && t.endsWith('/config'),
    );
    // Phase 13: 10 entities per PoE port × 16 PoE ports = 160 discovery topics.
    // (Switch is not a gateway so no WAN entities added.)
    expect(configPublishes.length).toBe(16 * 10);
  });

  it('Test 12 — every publish uses retain:true (D-LIFE-02)', () => {
    const device = asDevice(usw);
    publishDiscovery({
      mqttService: mqtt,
      topicPrefix: 'unifi-gateway1',
      instanceId: 'unifi-dev',
      devices: [device],
      haPrefix: 'homeassistant',
    });
    for (const call of mqtt.publish.mock.calls) {
      expect(call[2]).toEqual({ retain: true });
    }
  });

  it('Test 13 — UAP entries publish ZERO port entities (no PoE-out)', () => {
    const device = asDevice(uap);
    publishDiscovery({
      mqttService: mqtt,
      topicPrefix: 'unifi-gateway1',
      instanceId: 'unifi-dev',
      devices: [device],
      haPrefix: 'homeassistant',
    });
    // UAPs may have entries in port_table but none are port_poe=true.
    // → zero discovery topics published.
    expect(mqtt.publish).not.toHaveBeenCalled();
  });

  it('Test 14 — D-MI-02: two instances with same MAC produce non-colliding unique_id values', () => {
    const device = asDevice(usw);
    const mqttA = mockMqtt();
    const mqttB = mockMqtt();

    publishDiscovery({
      mqttService: mqttA,
      topicPrefix: 'unifi-dev',
      instanceId: 'unifi-dev',
      devices: [device],
      haPrefix: 'homeassistant',
    });
    publishDiscovery({
      mqttService: mqttB,
      topicPrefix: 'unifi-prod',
      instanceId: 'unifi-prod',
      devices: [device],
      haPrefix: 'homeassistant',
    });

    const aIds = new Set();
    for (const [, payload] of mqttA.publish.mock.calls) {
      const cfg = JSON.parse(payload);
      aIds.add(cfg.unique_id);
    }
    const bIds = new Set();
    for (const [, payload] of mqttB.publish.mock.calls) {
      const cfg = JSON.parse(payload);
      bIds.add(cfg.unique_id);
    }
    // No overlap.
    for (const id of aIds) {
      expect(bIds.has(id)).toBe(false);
    }
    // Both produced the same NUMBER of entities.
    expect(aIds.size).toBe(bIds.size);
  });

  it('Test 15 — device.identifiers also distinct per instance (HA shows two device cards)', () => {
    const device = asDevice(usw);
    const mqttA = mockMqtt();
    const mqttB = mockMqtt();
    publishDiscovery({
      mqttService: mqttA, topicPrefix: 'unifi-dev', instanceId: 'unifi-dev',
      devices: [device], haPrefix: 'homeassistant',
    });
    publishDiscovery({
      mqttService: mqttB, topicPrefix: 'unifi-prod', instanceId: 'unifi-prod',
      devices: [device], haPrefix: 'homeassistant',
    });

    const aDeviceIds = new Set();
    const bDeviceIds = new Set();
    for (const [, p] of mqttA.publish.mock.calls) {
      const cfg = JSON.parse(p);
      aDeviceIds.add(cfg.device.identifiers[0]);
    }
    for (const [, p] of mqttB.publish.mock.calls) {
      const cfg = JSON.parse(p);
      bDeviceIds.add(cfg.device.identifiers[0]);
    }
    expect(aDeviceIds.size).toBe(1);
    expect(bDeviceIds.size).toBe(1);
    const [aId] = aDeviceIds;
    const [bId] = bDeviceIds;
    expect(aId).not.toBe(bId);
  });
});

describe('clearDiscovery (D-LIFE-03)', () => {
  it('Test 16 — clearDiscovery publishes empty retained payload to every discovery topic', () => {
    const device = asDevice(usw);
    const mqttPub = mockMqtt();
    publishDiscovery({
      mqttService: mqttPub,
      topicPrefix: 'unifi-gateway1',
      instanceId: 'unifi-dev',
      devices: [device],
      haPrefix: 'homeassistant',
    });
    const publishedTopics = mqttPub.publish.mock.calls.map(([t]) => t).sort();

    const mqttClear = mockMqtt();
    clearDiscovery({
      mqttService: mqttClear,
      instanceId: 'unifi-dev',
      devices: [device],
      haPrefix: 'homeassistant',
    });
    const clearedCalls = mqttClear.publish.mock.calls;
    const clearedTopics = clearedCalls.map(([t]) => t).sort();

    expect(clearedTopics).toEqual(publishedTopics);
    for (const [, payload, opts] of clearedCalls) {
      expect(payload).toBe('');
      expect(opts).toEqual({ retain: true });
    }
  });

  it('Test 17 — clearDiscovery on empty devices array is a no-op', () => {
    const mqtt2 = mockMqtt();
    clearDiscovery({
      mqttService: mqtt2,
      instanceId: 'unifi-dev',
      devices: [],
      haPrefix: 'homeassistant',
    });
    expect(mqtt2.publish).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 13 — Extended port + gateway discovery (D-P13-HA-01..02)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPortEntities — Phase 13 throughput sensors (D-P13-HA-01)', () => {
  it('P13-Test 1 — PoE-capable port has rx_rate, tx_rate, link_down_count sensors, all enabled_by_default:false', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const rx = entities.find((e) => e.discoveryTopic.endsWith('_rx_rate/config'));
    const tx = entities.find((e) => e.discoveryTopic.endsWith('_tx_rate/config'));
    const ldc = entities.find((e) => e.discoveryTopic.endsWith('_link_down_count/config'));
    expect(rx, 'rx_rate sensor missing').toBeDefined();
    expect(tx, 'tx_rate sensor missing').toBeDefined();
    expect(ldc, 'link_down_count sensor missing').toBeDefined();
    expect(rx.config.device_class).toBe('data_rate');
    expect(rx.config.unit_of_measurement).toBe('kbit/s');
    expect(rx.config.enabled_by_default).toBe(false);
    expect(tx.config.enabled_by_default).toBe(false);
    expect(ldc.config.enabled_by_default).toBe(false);
    // Total port-level entity count grows to 10 (was 7).
    expect(entities).toHaveLength(10);
  });

  it('P13-Test 2 — link_down_count sensor has no device_class (counter, not duration/data_rate)', () => {
    const port = usw.port_table[0];
    const device = asDevice(usw);
    const entities = buildPortEntities({
      instanceId: 'unifi-dev',
      device,
      port,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const ldc = entities.find((e) => e.discoveryTopic.endsWith('_link_down_count/config'));
    expect(ldc.config.device_class).toBeUndefined();
    // value_template extracts from JSON.
    expect(ldc.config.value_template).toBe('{{ value_json.link_down_count }}');
  });
});

// New API surface introduced by Plan 13-03: per-gateway WAN entities.
import { buildGatewayWanEntities } from '../../../plugins/unifi/ha-discovery.js';

describe('buildGatewayWanEntities — Phase 13 gateway-level WAN sensors (D-P13-HA-02)', () => {
  it('P13-Test 3 — gateway emits 10 WAN entities: public_ip, latency, rx_rate, tx_rate, isp_name, uptime, speedtest_{dl,ul,ping}, speedtest_run button', () => {
    const device = asDevice(ucg);
    const entities = buildGatewayWanEntities({
      instanceId: 'unifi-dev',
      device,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    expect(entities).toHaveLength(10);
    const suffixes = entities.map((e) => e.discoveryTopic.split('/').slice(-2, -1)[0]).sort();
    expect(suffixes).toEqual([
      expect.stringMatching(/_speedtest_download$/),
      expect.stringMatching(/_speedtest_ping$/),
      expect.stringMatching(/_speedtest_run$/),
      expect.stringMatching(/_speedtest_upload$/),
      expect.stringMatching(/_wan_isp_name$/),
      expect.stringMatching(/_wan_latency$/),
      expect.stringMatching(/_wan_public_ip$/),
      expect.stringMatching(/_wan_rx_rate$/),
      expect.stringMatching(/_wan_tx_rate$/),
      expect.stringMatching(/_wan_uptime$/),
    ]);
  });

  it('P13-Test 4 — public_ip / latency / rx_rate / tx_rate sensors are enabled_by_default:false (diagnostic)', () => {
    const device = asDevice(ucg);
    const entities = buildGatewayWanEntities({
      instanceId: 'unifi-dev',
      device,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    for (const e of entities) {
      if (e.discoveryTopic.endsWith('_run/config')) continue; // button has no enabled_by_default convention
      expect(e.config.enabled_by_default, `enabled_by_default missing on ${e.discoveryTopic}`).toBe(false);
    }
  });

  it('P13-Test 5 — latency sensor has device_class:duration unit:ms; rx/tx rate device_class:data_rate unit:kbit/s', () => {
    const device = asDevice(ucg);
    const entities = buildGatewayWanEntities({
      instanceId: 'unifi-dev',
      device,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const lat = entities.find((e) => e.discoveryTopic.endsWith('_wan_latency/config'));
    expect(lat.config.device_class).toBe('duration');
    expect(lat.config.unit_of_measurement).toBe('ms');

    const rx = entities.find((e) => e.discoveryTopic.endsWith('_wan_rx_rate/config'));
    expect(rx.config.device_class).toBe('data_rate');
    expect(rx.config.unit_of_measurement).toBe('kbit/s');
  });

  it('P13-Test 6 — speedtest_run button: command_topic={prefix}/{slug}/wan/cmd, payload_press="speedtest", device_class:restart', () => {
    const device = asDevice(ucg);
    const entities = buildGatewayWanEntities({
      instanceId: 'unifi-dev',
      device,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    const btn = entities.find((e) => e.discoveryTopic.endsWith('_speedtest_run/config'));
    expect(btn).toBeDefined();
    expect(btn.config.command_topic).toBe(`unifi-gateway1/${device.nameSlug}/wan/cmd`);
    expect(btn.config.payload_press).toBe('speedtest');
    expect(btn.config.device_class).toBe('restart');
  });

  it('P13-Test 7 — non-gateway device returns ZERO entities', () => {
    const swDev = asDevice(usw);
    const apDev = asDevice(uap);
    expect(buildGatewayWanEntities({
      instanceId: 'unifi-dev', device: swDev,
      haPrefix: 'homeassistant', topicPrefix: 'unifi-gateway1',
    })).toHaveLength(0);
    expect(buildGatewayWanEntities({
      instanceId: 'unifi-dev', device: apDev,
      haPrefix: 'homeassistant', topicPrefix: 'unifi-gateway1',
    })).toHaveLength(0);
  });

  it('P13-Test 8 — every WAN entity carries availability + device.identifiers with instanceId (D-MI-02)', () => {
    const device = asDevice(ucg);
    const entities = buildGatewayWanEntities({
      instanceId: 'unifi-dev',
      device,
      haPrefix: 'homeassistant',
      topicPrefix: 'unifi-gateway1',
    });
    for (const e of entities) {
      expect(e.config.availability).toBeDefined();
      expect(e.config.availability[0].topic).toBe('unifi-gateway1/bridge/status');
      // macSlug emits dash-separated lowercase hex (e.g. aa-bb-cc-dd-ee-ff).
      expect(e.config.device.identifiers).toEqual([
        `unifi_unifi-dev_${device.mac.replace(/:/g, '-')}`,
      ]);
    }
  });
});

describe('publishDiscovery — integrates gateway WAN entities (Phase 13)', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // Phase 14 — client device_tracker discovery (D-P14-HA-01 / D-P14-HA-02)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Phase 14 — buildClientTrackerEntity', () => {
    function mkClient(overrides = {}) {
      return {
        mac: 'aa:bb:cc:11:22:33',
        name: 'Johns iPhone',
        hostname: 'iphone-of-john',
        is_wired: false,
        dev_vendor: 'Apple',
        os_name: 'iOS 18',
        signal_dbm: -57,
        essid: 'Gateway1',
        ...overrides,
      };
    }

    it('P14-Test HA-1 — wireless client: 3 entities (device_tracker + last_seen + signal_dbm)', () => {
      const entities = buildClientTrackerEntity({
        instanceId: 'unifi-dev',
        client: mkClient(),
        topicPrefix: 'unifi-gateway1',
        haPrefix: 'homeassistant',
      });
      expect(entities).toHaveLength(3);
      const components = entities.map((e) => e.discoveryTopic.split('/')[1]).sort();
      expect(components).toEqual(['device_tracker', 'sensor', 'sensor']);
    });

    it('P14-Test HA-2 — wired client: 2 entities (no signal_dbm)', () => {
      const entities = buildClientTrackerEntity({
        instanceId: 'unifi-dev',
        client: mkClient({ is_wired: true, essid: undefined, signal_dbm: undefined }),
        topicPrefix: 'unifi-gateway1',
        haPrefix: 'homeassistant',
      });
      expect(entities).toHaveLength(2);
      const components = entities.map((e) => e.discoveryTopic.split('/')[1]).sort();
      expect(components).toEqual(['device_tracker', 'sensor']);
      // No signal_dbm sensor.
      expect(entities.find((e) => e.discoveryTopic.endsWith('_signal_dbm/config'))).toBeUndefined();
    });

    it('P14-Test HA-3 — device_tracker wiring: source_type:router, value_template, payloads', () => {
      const entities = buildClientTrackerEntity({
        instanceId: 'unifi-dev',
        client: mkClient(),
        topicPrefix: 'unifi-gateway1',
        haPrefix: 'homeassistant',
      });
      const tracker = entities.find((e) => e.discoveryTopic.includes('/device_tracker/'));
      expect(tracker).toBeDefined();
      expect(tracker.config.source_type).toBe('router');
      expect(tracker.config.value_template).toBe('{{ value_json.state }}');
      expect(tracker.config.payload_home).toBe('home');
      expect(tracker.config.payload_not_home).toBe('not_home');
      expect(tracker.config.state_topic).toBe('unifi-gateway1/clients/by-mac/aa-bb-cc-11-22-33/state');
    });

    it('P14-Test HA-4 — unique_id format: unifi_{instanceId}_client_{mac-slug}', () => {
      const entities = buildClientTrackerEntity({
        instanceId: 'unifi-dev',
        client: mkClient(),
        topicPrefix: 'unifi-gateway1',
        haPrefix: 'homeassistant',
      });
      const tracker = entities.find((e) => e.discoveryTopic.includes('/device_tracker/'));
      expect(tracker.config.unique_id).toBe('unifi_unifi-dev_client_aa-bb-cc-11-22-33');
      // Discovery topic mirrors unique_id.
      expect(tracker.discoveryTopic).toBe(
        'homeassistant/device_tracker/unifi_unifi-dev_client_aa-bb-cc-11-22-33/config',
      );
    });

    it('P14-Test HA-5 — enabled_by_default: false on ALL client entities (D-P14-HA-01)', () => {
      const entities = buildClientTrackerEntity({
        instanceId: 'unifi-dev',
        client: mkClient(),
        topicPrefix: 'unifi-gateway1',
        haPrefix: 'homeassistant',
      });
      for (const e of entities) {
        expect(e.config.enabled_by_default).toBe(false);
      }
    });

    it('P14-Test HA-6 — signal_dbm sensor: signal_strength device_class, dBm unit', () => {
      const entities = buildClientTrackerEntity({
        instanceId: 'unifi-dev',
        client: mkClient(),
        topicPrefix: 'unifi-gateway1',
        haPrefix: 'homeassistant',
      });
      const signal = entities.find((e) => e.discoveryTopic.endsWith('_signal_dbm/config'));
      expect(signal).toBeDefined();
      expect(signal.config.device_class).toBe('signal_strength');
      expect(signal.config.unit_of_measurement).toBe('dBm');
      expect(signal.config.value_template).toBe('{{ value_json.signal_dbm }}');
    });

    it('P14-Test HA-7 — last_seen sensor: timestamp device_class', () => {
      const entities = buildClientTrackerEntity({
        instanceId: 'unifi-dev',
        client: mkClient(),
        topicPrefix: 'unifi-gateway1',
        haPrefix: 'homeassistant',
      });
      const ls = entities.find((e) => e.discoveryTopic.endsWith('_last_seen/config'));
      expect(ls).toBeDefined();
      expect(ls.config.device_class).toBe('timestamp');
      expect(ls.config.value_template).toBe('{{ value_json.last_seen }}');
    });

    it('P14-Test HA-8 — clearClientDiscovery emits empty retained payload on every topic publishClientDiscovery wrote', () => {
      const client = mkClient();
      const pubMqtt = mockMqtt();
      publishClientDiscovery({
        mqttService: pubMqtt,
        instanceId: 'unifi-dev',
        topicPrefix: 'unifi-gateway1',
        clients: [client],
        haPrefix: 'homeassistant',
      });
      const publishedTopics = pubMqtt.publish.mock.calls.map(([t]) => t).sort();

      const clearMqtt = mockMqtt();
      clearClientDiscovery({
        mqttService: clearMqtt,
        instanceId: 'unifi-dev',
        clients: [client],
        haPrefix: 'homeassistant',
      });
      const clearedTopics = clearMqtt.publish.mock.calls.map(([t]) => t).sort();
      expect(clearedTopics).toEqual(publishedTopics);
      // Every payload is empty string with retain=true.
      for (const call of clearMqtt.publish.mock.calls) {
        expect(call[1]).toBe('');
        expect(call[2]).toEqual({ retain: true });
      }
    });

    it('P14-Test HA-9 — invalid MAC produces zero entities (defensive)', () => {
      expect(
        buildClientTrackerEntity({
          instanceId: 'unifi-dev',
          client: { mac: 'not-a-mac' },
          topicPrefix: 'unifi-gateway1',
          haPrefix: 'homeassistant',
        }),
      ).toHaveLength(0);
      expect(
        buildClientTrackerEntity({
          instanceId: 'unifi-dev',
          client: null,
          topicPrefix: 'unifi-gateway1',
          haPrefix: 'homeassistant',
        }),
      ).toHaveLength(0);
    });
  });

  it('P13-Test 9 — publishDiscovery on a gateway device emits both port AND wan entities; clearDiscovery clears them all', () => {
    const gw = asDevice(ucg);
    const mqttPub = mockMqtt();
    publishDiscovery({
      mqttService: mqttPub,
      topicPrefix: 'unifi-gateway1',
      instanceId: 'unifi-dev',
      devices: [gw],
      haPrefix: 'homeassistant',
    });
    // UCG-MAX has 5 ports — none PoE-capable per fixture. So port-entity count is 0.
    // But gateway WAN entities should be 10.
    const wanTopics = mqttPub.publish.mock.calls
      .map(([t]) => t)
      .filter((t) => /_wan_|_speedtest_/.test(t));
    expect(wanTopics.length).toBeGreaterThanOrEqual(10);

    // clearDiscovery should clear every topic publishDiscovery emitted.
    const publishedTopics = mqttPub.publish.mock.calls.map(([t]) => t).sort();
    const mqttClear = mockMqtt();
    clearDiscovery({
      mqttService: mqttClear,
      instanceId: 'unifi-dev',
      devices: [gw],
      haPrefix: 'homeassistant',
    });
    const clearedTopics = mqttClear.publish.mock.calls.map(([t]) => t).sort();
    expect(clearedTopics).toEqual(publishedTopics);
  });
});
