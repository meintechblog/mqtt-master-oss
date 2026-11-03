/**
 * plugins/unifi/unifi-telemetry.js — pure normalisers (Phase 8-01 Task 3).
 *
 * Exercises:
 *  - isPoeCapablePort (gate for D-F-02 field omission)
 *  - normalizePort    (port_table → PublishedPortState, defensive wire-type coercion)
 *  - normalizeDevice  (device → PublishedDeviceState, state-code + type-code mapping)
 *  - deriveConnectedDevice (LLDP-first, /stat/sta fallback, MAC-case-insensitive)
 *
 * Tests run against the real /stat/device fixture captured from the live
 * UCG-MAX dev environment (3 devices: UCGMAX gateway, USPM16P switch with
 * 16 PoE + 2 SFP+, U6 Pro AP).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isPoeCapablePort,
  normalizePort,
  normalizeDevice,
  deriveConnectedDevice,
  deriveConnectedDeviceDetail,
  normalizeWan,
  normalizeWanIsp,
  normalizeSiteHealth,
  normalizeClient,
  deriveClientState,
} from '../../../plugins/unifi/unifi-telemetry.js';

const fixturePath = path.resolve(
  __dirname,
  '../../fixtures/unifi/stat-device-3devices.json',
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const ucg = fixture.data.find((d) => d.type === 'udm');
const usw = fixture.data.find((d) => d.type === 'usw');
const uap = fixture.data.find((d) => d.type === 'uap');

describe('isPoeCapablePort', () => {
  it('Test 1 — PoE-capable port (USPM16P port_idx 1, port_poe=true) → true', () => {
    const port1 = usw.port_table[0];
    expect(port1.port_poe).toBe(true);
    expect(isPoeCapablePort(port1)).toBe(true);
  });

  it('Test 2 — SFP+ port (port_poe=false) → false', () => {
    const sfp = usw.port_table[16]; // port_idx 17 — first SFP+
    expect(sfp.port_poe).toBe(false);
    expect(isPoeCapablePort(sfp)).toBe(false);
  });

  it('Test 3 — null input → false (defensive)', () => {
    expect(isPoeCapablePort(null)).toBe(false);
  });

  it('Test 4 — missing port_poe field defaults to false', () => {
    expect(isPoeCapablePort({})).toBe(false);
    expect(isPoeCapablePort({ port_idx: 5 })).toBe(false);
  });
});

describe('normalizePort', () => {
  it('Test 5 — PoE-capable port (USPM16P port 1) emits 11 fields including protected:true', () => {
    const raw = usw.port_table[0]; // port_idx 1
    const out = normalizePort(raw, {
      deviceMac: usw.mac,
      connectedDevice: null,
    });

    expect(out.port_idx).toBe(1);
    expect(out.port_name).toBe(raw.name);
    expect(out.link_up).toBe(raw.up);
    expect(typeof out.poe_mode).toBe('string');
    expect(typeof out.poe_power_w).toBe('number');
    expect(out.poe_power_w).toBeGreaterThanOrEqual(0);
    expect(typeof out.poe_voltage_v).toBe('number');
    expect(typeof out.poe_current_ma).toBe('number');
    expect(Number.isInteger(out.poe_current_ma)).toBe(true);

    // Protected — Main switch port 1 is the controller uplink (allowlist).
    expect(out.protected).toBe(true);

    // poe_caps on real fixture is an int bitmask, NOT an array — should be omitted
    // (per the interfaces contract: `if (Array.isArray(entry.poe_caps))` gate).
    expect('poe_caps' in out).toBe(false);

    // Pinned key set: pre-Phase-13 core fields + the optional Phase 13
    // throughput/counter additions IF the API supplied them. The fixture's
    // port 1 carries rx_bytes/tx_bytes/rx_bytes-r/tx_bytes-r so the rate +
    // bytes keys appear here. connected_device_detail is always emitted as
    // a top-level key (null when no detail).
    const keys = Object.keys(out).sort();
    expect(keys).toContain('connected_device');
    expect(keys).toContain('connected_device_detail');
    expect(keys).toContain('full_duplex');
    expect(keys).toContain('link_speed_mbps');
    expect(keys).toContain('link_up');
    expect(keys).toContain('poe_current_ma');
    expect(keys).toContain('poe_mode');
    expect(keys).toContain('poe_power_w');
    expect(keys).toContain('poe_voltage_v');
    expect(keys).toContain('port_idx');
    expect(keys).toContain('port_name');
    expect(keys).toContain('protected');
    // No `poe_caps` leakage (fixture has bitmask, not array).
    expect(keys).not.toContain('poe_caps');
  });

  it('Test 6 — D-F-02: non-PoE port (SFP+) OMITS poe_* fields entirely (not zeroed)', () => {
    const raw = usw.port_table[16]; // port_idx 17 — SFP+ 1
    const out = normalizePort(raw, {
      deviceMac: usw.mac,
      connectedDevice: null,
    });

    // Must have the link-level fields.
    expect(out).toHaveProperty('port_idx');
    expect(out).toHaveProperty('port_name');
    expect(out).toHaveProperty('link_up');
    expect(out).toHaveProperty('link_speed_mbps');
    expect(out).toHaveProperty('full_duplex');
    expect(out).toHaveProperty('connected_device');

    // CRITICAL — D-F-02: NONE of the poe_* fields. Not undefined, not 0 — absent.
    expect('poe_mode' in out).toBe(false);
    expect('poe_caps' in out).toBe(false);
    expect('poe_power_w' in out).toBe(false);
    expect('poe_voltage_v' in out).toBe(false);
    expect('poe_current_ma' in out).toBe(false);
  });

  it('Test 7 — defensive wire-type coercion (strings → numbers, truthy → bool)', () => {
    const raw = {
      port_idx: '5',
      name: 'P5',
      up: 1,
      speed: '1000',
      full_duplex: 'true',
      port_poe: true,
      poe_mode: 'auto',
      poe_caps: 9, // number bitmask, not array — should be omitted
      poe_power: '4.2',
      poe_voltage: '53.1',
      poe_current: '79',
    };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(out.port_idx).toBe(5);
    expect(out.link_up).toBe(true);
    expect(out.link_speed_mbps).toBe(1000);
    expect(out.full_duplex).toBe(true);
    expect(out.poe_power_w).toBe(4.2);
    expect(out.poe_voltage_v).toBe(53.1);
    expect(out.poe_current_ma).toBe(79);
    expect('poe_caps' in out).toBe(false); // number bitmask omitted
  });

  it('Test 8 — link_up=false zeroes/null-s link_speed_mbps + full_duplex', () => {
    const raw = {
      port_idx: 5,
      name: 'P5',
      up: false,
      speed: 0,
      full_duplex: false,
      port_poe: true,
      poe_mode: 'off',
    };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(out.link_up).toBe(false);
    expect(out.link_speed_mbps).toBeNull();
    expect(out.full_duplex).toBeNull();
  });

  it('Test 9 — connectedDevice passthrough (opts.connectedDevice carried verbatim; missing → null)', () => {
    const raw = {
      port_idx: 5,
      name: 'P5',
      up: true,
      speed: 1000,
      full_duplex: true,
      port_poe: true,
      poe_mode: 'auto',
    };
    const out = normalizePort(raw, {
      deviceMac: 'aa:bb:cc:dd:ee:ff',
      connectedDevice: 'esp32.lan',
    });
    expect(out.connected_device).toBe('esp32.lan');

    const out2 = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(out2.connected_device).toBeNull();
  });

  it('Test 10 — protected annotation: port 1 on the controller-uplink MAC is protected; other ports not', () => {
    const protectedPort = {
      port_idx: 1,
      name: 'Port 1',
      up: true,
      speed: 1000,
      full_duplex: true,
      port_poe: true,
      poe_mode: 'auto',
    };
    const out = normalizePort(protectedPort, {
      deviceMac: '02:00:00:00:00:fa',
    });
    expect(out.protected).toBe(true);

    const nonProtected = { ...protectedPort, port_idx: 2 };
    const out2 = normalizePort(nonProtected, {
      deviceMac: '02:00:00:00:00:fa',
    });
    expect(out2.protected).not.toBe(true);
    // The annotation is omitted entirely (not false) so it doesn't leak as a "false" claim.
    expect('protected' in out2).toBe(false);
  });
});

describe('normalizeDevice', () => {
  it('Test 11 — UCG-MAX (udm → gateway)', () => {
    const out = normalizeDevice(ucg);
    expect(out.mac).toBe(ucg.mac.toLowerCase());
    expect(out.name).toBe(ucg.name);
    expect(out.model).toBe('UCGMAX');
    expect(out.type).toBe('gateway');
    expect(out.firmware).toBe(ucg.version);
    expect(out.uptime_sec).toBe(ucg.uptime);
    expect(out.state).toBe('online'); // state code 1 → online
    expect(out.port_count).toBe(ucg.port_table.length);
    // Compute expected poe_on_count manually
    const expectedOn = ucg.port_table.filter(
      (p) => p.port_poe === true && p.poe_mode !== 'off' && p.up === true,
    ).length;
    expect(out.poe_on_count).toBe(expectedOn);
  });

  it('Test 12 — U6 Pro (uap → ap, poe_on_count=0)', () => {
    const out = normalizeDevice(uap);
    expect(out.type).toBe('ap');
    expect(out.poe_on_count).toBe(0); // UAP port_table either empty or no port_poe ports
  });

  it('Test 13 — state-code map (0,1,2,4,5,6,7)', () => {
    const cases = [
      [0, 'offline'],
      [1, 'online'],
      [2, 'pending'],
      [4, 'upgrading'],
      [5, 'provisioning'],
      [6, 'offline'],
      [7, 'offline'],
    ];
    for (const [code, expected] of cases) {
      const out = normalizeDevice({
        mac: 'aa:bb:cc:dd:ee:ff',
        name: 'x',
        state: code,
        port_table: [],
        type: 'usw',
        model: 'X',
        version: 'v',
        uptime: 0,
      });
      expect(out.state).toBe(expected);
    }
  });

  it('Test 14 — type-code map (udm→gateway, usw→switch, uap→ap, unknown passthrough)', () => {
    const base = {
      mac: 'aa:bb:cc:dd:ee:ff',
      name: 'x',
      state: 1,
      port_table: [],
      model: 'X',
      version: 'v',
      uptime: 0,
    };
    expect(normalizeDevice({ ...base, type: 'udm' }).type).toBe('gateway');
    expect(normalizeDevice({ ...base, type: 'usw' }).type).toBe('switch');
    expect(normalizeDevice({ ...base, type: 'uap' }).type).toBe('ap');
    expect(normalizeDevice({ ...base, type: 'unknown' }).type).toBe('unknown');
  });
});

describe('deriveConnectedDevice', () => {
  it('Test 15 — LLDP first, system_name preferred', () => {
    const port = {
      port_idx: 5,
      lldp_table: [{ system_name: 'esp32.lan', chassis_id: 'aa:bb:cc:dd:ee:ff' }],
    };
    expect(deriveConnectedDevice(port, '02:00:00:00:00:fa', null)).toBe('esp32.lan');
  });

  it('Test 16 — LLDP chassis_id fallback when system_name missing', () => {
    const port = { port_idx: 5, lldp_table: [{ chassis_id: 'ESP32-1A2B3C' }] };
    expect(deriveConnectedDevice(port, '02:00:00:00:00:fa', null)).toBe('ESP32-1A2B3C');
  });

  it('Test 17 — empty LLDP → /stat/sta lookup by (sw_mac, sw_port), hostname preferred', () => {
    const port = { port_idx: 5, lldp_table: [] };
    const staList = [
      {
        sw_mac: '02:00:00:00:00:fa',
        sw_port: 5,
        hostname: 'iphone.lan',
        mac: 'aa:bb:cc:dd:ee:ff',
      },
    ];
    expect(deriveConnectedDevice(port, '02:00:00:00:00:fa', staList)).toBe('iphone.lan');
  });

  it('Test 18 — sta fallback chain: hostname → name → mac', () => {
    const port = { port_idx: 5 };
    const stWithName = [
      { sw_mac: '02:00:00:00:00:fa', sw_port: 5, name: 'MyDevice', mac: 'aa:bb:cc:dd:ee:ff' },
    ];
    expect(deriveConnectedDevice(port, '02:00:00:00:00:fa', stWithName)).toBe('MyDevice');

    const stWithMacOnly = [
      { sw_mac: '02:00:00:00:00:fa', sw_port: 5, mac: 'aa:bb:cc:dd:ee:ff' },
    ];
    expect(deriveConnectedDevice(port, '02:00:00:00:00:fa', stWithMacOnly)).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('Test 19 — no LLDP, sta has no match → null', () => {
    const port = { port_idx: 5, lldp_table: [] };
    const staList = [{ sw_mac: 'ff:ff:ff:ff:ff:ff', sw_port: 5, hostname: 'other' }];
    expect(deriveConnectedDevice(port, '02:00:00:00:00:fa', staList)).toBeNull();
  });

  it('Test 20 — staList null + no LLDP → null', () => {
    expect(deriveConnectedDevice({ port_idx: 5 }, '02:00:00:00:00:fa', null)).toBeNull();
  });

  it('Test 21 — MAC matching is case-insensitive (sta sw_mac uppercase, deviceMac lowercase)', () => {
    const port = { port_idx: 5, lldp_table: [] };
    const staList = [{ sw_mac: '02:00:00:00:00:FA', sw_port: 5, hostname: 'x' }];
    expect(deriveConnectedDevice(port, '02:00:00:00:00:fa', staList)).toBe('x');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 13 — Extended telemetry tests (D-P13-PORT-*, D-P13-DEV-*, D-P13-WAN-*)
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizePort — Phase 13 throughput + counters (D-P13-PORT-01)', () => {
  it('P13-Test 1 — emits rx_bytes/tx_bytes/rx_rate_kbps/tx_rate_kbps from API fields', () => {
    const raw = {
      port_idx: 5,
      name: 'P5',
      up: true,
      speed: 1000,
      full_duplex: true,
      port_poe: false,
      // Per D-P13-PORT-01: rx_bytes/tx_bytes cumulative, rx_rate-max/tx_rate-max are kbps.
      rx_bytes: 38152936,
      tx_bytes: 23101778,
      'rx_bytes-r': 675,
      'tx_bytes-r': 642,
      // Bytes-per-second from API; we convert bytes/s → kbps: x*8/1000.
    };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(out.rx_bytes).toBe(38152936);
    expect(out.tx_bytes).toBe(23101778);
    // 675 bytes/s = 5.4 kbps
    expect(out.rx_rate_kbps).toBe(5.4);
    expect(out.tx_rate_kbps).toBe(5.136); // 642 * 8 / 1000
  });

  it('P13-Test 2 — omits throughput fields entirely when source data is null/undefined', () => {
    const raw = { port_idx: 5, name: 'P5', up: false, port_poe: false };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect('rx_bytes' in out).toBe(false);
    expect('tx_bytes' in out).toBe(false);
    expect('rx_rate_kbps' in out).toBe(false);
    expect('tx_rate_kbps' in out).toBe(false);
  });

  it('P13-Test 3 — emits link_down_count when API field present', () => {
    const raw = {
      port_idx: 5,
      name: 'P5',
      up: true,
      port_poe: false,
      link_down_count: 7,
    };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(out.link_down_count).toBe(7);
  });

  it('P13-Test 4 — omits link_down_count when API field absent', () => {
    const raw = { port_idx: 5, name: 'P5', up: false, port_poe: false };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect('link_down_count' in out).toBe(false);
  });

  it('Anomaly-Test 1 — emits rx_errors/tx_errors/rx_dropped/tx_dropped when API reports them', () => {
    const raw = {
      port_idx: 5,
      name: 'P5',
      up: true,
      port_poe: false,
      rx_errors: 3,
      tx_errors: 0,
      rx_dropped: 12,
      tx_dropped: 0,
    };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(out.rx_errors).toBe(3);
    expect(out.tx_errors).toBe(0);
    expect(out.rx_dropped).toBe(12);
    expect(out.tx_dropped).toBe(0);
  });

  it('Anomaly-Test 2 — omits error counters entirely when API leaves them undefined', () => {
    const raw = { port_idx: 5, name: 'P5', up: true, port_poe: false };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect('rx_errors' in out).toBe(false);
    expect('tx_errors' in out).toBe(false);
    expect('rx_dropped' in out).toBe(false);
    expect('tx_dropped' in out).toBe(false);
  });
});

describe('normalizePort — connected_device backwards compatibility (D-P13-PORT-02)', () => {
  it('P13-Test 5 — connected_device (string) preserved; new connected_device_detail emitted alongside', () => {
    const raw = {
      port_idx: 5,
      name: 'P5',
      up: true,
      speed: 1000,
      full_duplex: true,
      port_poe: false,
    };
    const detail = {
      name: 'esp32.lan',
      mac: 'aa:bb:cc:dd:ee:ff',
      ip: '192.0.2.50',
      hostname: 'esp32',
      vlan: 10,
      last_seen: 1778512308,
    };
    const out = normalizePort(raw, {
      deviceMac: '02:00:00:00:00:fa',
      connectedDevice: 'esp32.lan', // legacy string
      connectedDeviceDetail: detail,
    });
    expect(out.connected_device).toBe('esp32.lan'); // backwards compat
    expect(out.connected_device_detail).toEqual(detail);
  });

  it('P13-Test 6 — connected_device_detail null when not provided (no leak)', () => {
    const raw = { port_idx: 5, name: 'P5', up: false, port_poe: false };
    const out = normalizePort(raw, { deviceMac: 'aa:bb:cc:dd:ee:ff' });
    expect(out.connected_device).toBeNull();
    expect(out.connected_device_detail).toBeNull();
  });
});

describe('deriveConnectedDeviceDetail — D-P13-PORT-03', () => {
  it('P13-Test 7 — LLDP first: returns {name, mac, ip, hostname, vlan, last_seen} from lldp + sta', () => {
    const port = {
      port_idx: 5,
      lldp_table: [
        {
          system_name: 'esp32.lan',
          chassis_id: 'aa:bb:cc:dd:ee:ff',
          mgmt_address: '192.0.2.50',
        },
      ],
      last_connection: { last_seen: 1778512308 },
    };
    const staList = [
      {
        sw_mac: '02:00:00:00:00:fa',
        sw_port: 5,
        hostname: 'esp32',
        ip: '192.0.2.50',
        mac: 'aa:bb:cc:dd:ee:ff',
        vlan: 10,
        last_seen: 1778512308,
      },
    ];
    const out = deriveConnectedDeviceDetail(port, '02:00:00:00:00:fa', staList);
    expect(out).toMatchObject({
      name: 'esp32.lan',
      mac: 'aa:bb:cc:dd:ee:ff',
      hostname: 'esp32',
      vlan: 10,
    });
    expect(out.ip).toBe('192.0.2.50');
  });

  it('P13-Test 8 — no LLDP, sta match: returns hostname + ip + vlan from sta only', () => {
    const port = { port_idx: 5, lldp_table: [] };
    const staList = [
      {
        sw_mac: '02:00:00:00:00:fa',
        sw_port: 5,
        hostname: 'iphone.lan',
        ip: '192.0.2.42',
        mac: 'aa:bb:cc:dd:ee:00',
        vlan: 1,
        last_seen: 1778512000,
      },
    ];
    const out = deriveConnectedDeviceDetail(port, '02:00:00:00:00:fa', staList);
    expect(out.hostname).toBe('iphone.lan');
    expect(out.ip).toBe('192.0.2.42');
    expect(out.mac).toBe('aa:bb:cc:dd:ee:00');
    expect(out.vlan).toBe(1);
    expect(out.last_seen).toBe(1778512000);
  });

  it('P13-Test 9 — no LLDP and no sta match → null', () => {
    const port = { port_idx: 5, lldp_table: [] };
    expect(deriveConnectedDeviceDetail(port, '02:00:00:00:00:fa', [])).toBeNull();
    expect(deriveConnectedDeviceDetail(port, '02:00:00:00:00:fa', null)).toBeNull();
  });
});

describe('normalizeDevice — Phase 13 enriched fields (D-P13-DEV-01..02)', () => {
  it('P13-Test 10 — UCG-MAX: ip + cpu_pct + mem_pct + temperature_c + num_clients + total_*_bytes', () => {
    const out = normalizeDevice(ucg);
    expect(out.ip).toBe(ucg.ip);
    expect(out.cpu_pct).toBeCloseTo(13.3, 1);
    expect(out.mem_pct).toBeCloseTo(66.4, 1);
    // ucg fixture has temperatures[]; we surface the max.
    expect(typeof out.temperature_c).toBe('number');
    expect(out.temperature_c).toBeGreaterThan(0);
    expect(out.num_clients).toBe(ucg.num_sta);
    expect(out.total_rx_bytes).toBe(ucg.rx_bytes);
    expect(out.total_tx_bytes).toBe(ucg.tx_bytes);
    expect(out.overheating).toBe(Boolean(ucg.overheating));
  });

  it('P13-Test 11 — USPM16P switch: total_used_power_w from total_used_power', () => {
    const out = normalizeDevice(usw);
    expect(out.total_used_power_w).toBeCloseTo(32.8, 1);
    expect(out.cpu_pct).toBeCloseTo(21.2, 1);
    expect(out.mem_pct).toBeCloseTo(13.4, 1);
    expect(out.num_clients).toBe(usw.num_sta);
    expect(out.overheating).toBe(false);
  });

  it('P13-Test 12 — Gateway: client_count_wireless + client_count_wired from wlan-num_sta/lan-num_sta', () => {
    // UCG-MAX gateway carries the `wlan-num_sta` / `lan-num_sta` breakdowns.
    const out = normalizeDevice(ucg);
    expect(out.client_count_wireless).toBe(0);
    expect(out.client_count_wired).toBe(9);

    // UAP carries `user-wlan-num_sta` only (no wired breakdown on a wireless device).
    const uOut = normalizeDevice(uap);
    expect(uOut.client_count_wireless).toBe(0);
    expect('client_count_wired' in uOut).toBe(false);
  });

  it('P13-Test 13 — temperatures absent → temperature_c omitted', () => {
    const out = normalizeDevice({
      mac: 'aa:bb:cc:dd:ee:ff',
      name: 'x',
      state: 1,
      port_table: [],
      type: 'usw',
      model: 'X',
      version: 'v',
      uptime: 0,
    });
    expect('temperature_c' in out).toBe(false);
  });
});

describe('normalizeWan — D-P13-WAN-03', () => {
  it('P13-Test 14 — extracts wan1 fields from gateway record', () => {
    const wan = normalizeWan(ucg, 'wan1');
    expect(wan).not.toBeNull();
    expect(wan.interface).toBe('eth4');
    expect(wan.up).toBe(true);
    expect(wan.ip).toBe('203.0.113.169');
    expect(wan.netmask).toBe('255.192.0.0');
    expect(wan.mac).toBe('02:00:00:00:00:12');
    expect(wan.latency_ms).toBe(30);
    expect(wan.availability_pct).toBe(100);
    expect(wan.max_speed_mbps).toBe(2500);
    expect(wan.link_speed_mbps).toBe(1000);
    expect(wan.full_duplex).toBe(true);
    expect(wan.media).toBe('2.5GE');
    expect(wan.rx_bytes).toBe(38152936);
    expect(wan.tx_bytes).toBe(23101778);
    expect(wan.rx_rate_kbps).toBe(5.4); // 675 B/s * 8 / 1000
    expect(wan.tx_rate_kbps).toBe(5.136);
    expect(wan.rx_packets).toBe(222741);
    expect(wan.tx_packets).toBe(157766);
    expect(wan.rx_errors).toBe(0);
    expect(wan.tx_errors).toBe(0);
  });

  it('P13-Test 15 — extracts wan2 fields', () => {
    const wan = normalizeWan(ucg, 'wan2');
    expect(wan).not.toBeNull();
    expect(wan.interface).toBe('eth3');
    expect(wan.up).toBe(true);
    expect(wan.ip).toBe('198.51.100.102');
    expect(wan.latency_ms).toBe(15);
  });

  it('P13-Test 16 — returns null when wan key absent from device', () => {
    const noWan = { ...ucg };
    delete noWan.wan1;
    delete noWan.wan2;
    expect(normalizeWan(noWan, 'wan1')).toBeNull();
    expect(normalizeWan(noWan, 'wan2')).toBeNull();
  });

  it('P13-Test 17 — returns null for non-gateway device', () => {
    expect(normalizeWan(usw, 'wan1')).toBeNull();
    expect(normalizeWan(uap, 'wan1')).toBeNull();
  });
});

describe('normalizeWanIsp — D-P13-WAN-04', () => {
  it('P13-Test 18 — extracts ISP info from health.wan when present', () => {
    const health = {
      subsystem: 'wan',
      isp_name: 'ExampleISP',
      isp_organization: 'Space Exploration Technologies Corporation',
      asn: 14593,
      wan_ip: '198.51.100.102',
      latency: 20,
    };
    const isp = normalizeWanIsp(ucg, health);
    expect(isp.isp_name).toBe('ExampleISP');
    expect(isp.isp_organization).toBe('Space Exploration Technologies Corporation');
    expect(isp.asn).toBe(14593);
    expect(isp.public_ip).toBe('198.51.100.102');
  });

  it('P13-Test 19 — falls back to wan1 ip when health missing wan_ip', () => {
    const isp = normalizeWanIsp(ucg, { subsystem: 'wan', isp_name: 'ExampleISP' });
    expect(isp.isp_name).toBe('ExampleISP');
    expect(isp.public_ip).toBe('203.0.113.169'); // wan1.ip
  });

  it('P13-Test 20 — returns null when no health AND no wan blocks', () => {
    const noWan = { ...ucg };
    delete noWan.wan1;
    delete noWan.wan2;
    expect(normalizeWanIsp(noWan, null)).toBeNull();
  });
});

describe('normalizeSiteHealth — D-P13-WAN-05', () => {
  it('P13-Test 21 — rolls up wlan/wan/lan/www/vpn subsystems', () => {
    const subsystems = [
      { subsystem: 'wlan', num_ap: 1, num_user: 0, status: 'ok' },
      {
        subsystem: 'wan', status: 'ok',
        isp_name: 'ExampleISP', wan_ip: '198.51.100.102', latency: 20,
      },
      { subsystem: 'lan', num_sw: 1, num_user: 9, status: 'ok' },
      {
        subsystem: 'www', status: 'ok',
        latency: 18, uptime: 99, drops: 0,
        speedtest_status: 'idle', speedtest_lastrun: 1778500000,
      },
      { subsystem: 'vpn', status: 'unknown' },
    ];
    const health = normalizeSiteHealth(subsystems);
    expect(health.wlan).toEqual({ num_ap: 1, num_user: 0, status: 'ok' });
    expect(health.wan.status).toBe('ok');
    expect(health.wan.isp_name).toBe('ExampleISP');
    expect(health.wan.public_ip).toBe('198.51.100.102');
    expect(health.wan.latency_ms).toBe(20);
    expect(health.lan).toEqual({ num_sw: 1, num_user: 9, status: 'ok' });
    expect(health.www.status).toBe('ok');
    expect(health.www.latency_ms).toBe(18);
    expect(health.www.uptime).toBe(99);
    expect(health.www.speedtest_status).toBe('idle');
    expect(health.www.speedtest_lastrun).toBe(1778500000);
    expect(health.vpn).toEqual({ status: 'unknown' });
  });

  it('P13-Test 22 — empty / null subsystems returns empty health rollup', () => {
    expect(normalizeSiteHealth([])).toEqual({});
    expect(normalizeSiteHealth(null)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 14 — normalizeClient + deriveClientState (D-P14-FIELDS-01)
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase 14 — normalizeClient', () => {
  const FIXED_NOW = 1730000000000; // 2024-10-27 ish — stable for ISO format checks
  const lastSeenSec = Math.floor(FIXED_NOW / 1000) - 30;
  const firstSeenSec = Math.floor(FIXED_NOW / 1000) - 86400;

  function staWireless(overrides = {}) {
    return {
      mac: 'AA:BB:CC:11:22:33',
      hostname: 'iphone-of-john',
      ip: '192.0.2.45',
      is_wired: false,
      essid: 'Gateway1',
      signal: -57,
      ap_mac: 'aa:11:22:33:44:55',
      radio_proto: 'ax',
      channel: 36,
      tx_rate: 866000,
      rx_rate: 866000,
      oui: 'Apple',
      dev_vendor: 'Apple',
      dev_family: 'iPhone',
      os_name: 'iOS 18',
      uptime: 3600,
      idletime: 5,
      last_seen: lastSeenSec,
      first_seen: firstSeenSec,
      vlan: 10,
      authorized: true,
      is_guest: false,
      ...overrides,
    };
  }

  function staWired(overrides = {}) {
    return {
      mac: '11:22:33:44:55:66',
      hostname: 'office-printer',
      ip: '192.0.2.99',
      is_wired: true,
      sw_mac: 'CC:CC:CC:CC:CC:CC',
      sw_port: 6,
      oui: 'Brother',
      dev_vendor: 'Brother',
      uptime: 999999,
      idletime: 120,
      last_seen: lastSeenSec,
      first_seen: firstSeenSec,
      ...overrides,
    };
  }

  it('Test C-1 — wireless client emits wireless fields, OMITS switch_* entirely', () => {
    const out = normalizeClient(staWireless(), null, null, null, FIXED_NOW);
    expect(out.mac).toBe('aa:bb:cc:11:22:33');
    expect(out.is_wired).toBe(false);
    expect(out.essid).toBe('Gateway1');
    expect(out.signal_dbm).toBe(-57);
    expect(out.ap_mac).toBe('aa:11:22:33:44:55');
    expect(out.radio_proto).toBe('ax');
    expect(out.channel).toBe(36);
    expect(out.tx_rate_kbps).toBe(866000);
    expect(out.rx_rate_kbps).toBe(866000);
    // Wired-only fields MUST be absent (not null, not undefined — absent).
    expect('switch_mac' in out).toBe(false);
    expect('switch_port_idx' in out).toBe(false);
    expect('switch_name' in out).toBe(false);
  });

  it('Test C-2 — wired client emits switch_* fields, OMITS wireless fields', () => {
    const out = normalizeClient(staWired(), null, null, null, FIXED_NOW);
    expect(out.is_wired).toBe(true);
    expect(out.switch_mac).toBe('cc:cc:cc:cc:cc:cc');
    expect(out.switch_port_idx).toBe(6);
    // Wireless-only fields MUST be absent.
    expect('essid' in out).toBe(false);
    expect('signal_dbm' in out).toBe(false);
    expect('ap_mac' in out).toBe(false);
    expect('ap_name' in out).toBe(false);
    expect('radio_proto' in out).toBe(false);
    expect('channel' in out).toBe(false);
    expect('tx_rate_kbps' in out).toBe(false);
    expect('rx_rate_kbps' in out).toBe(false);
  });

  it('Test C-3 — ap_name resolved via deviceMap cross-join (ap_mac → device.name)', () => {
    const deviceMap = new Map([
      ['aa:11:22:33:44:55', { mac: 'aa:11:22:33:44:55', name: 'Wohnzimmer-AP', type: 'uap' }],
    ]);
    const out = normalizeClient(staWireless(), null, null, deviceMap, FIXED_NOW);
    expect(out.ap_name).toBe('Wohnzimmer-AP');
  });

  it('Test C-4 — switch_name resolved via deviceMap cross-join (sw_mac → device.name)', () => {
    const deviceMap = new Map([
      ['cc:cc:cc:cc:cc:cc', { mac: 'cc:cc:cc:cc:cc:cc', name: 'Main-Switch', type: 'usw' }],
    ]);
    const out = normalizeClient(staWired(), null, null, deviceMap, FIXED_NOW);
    expect(out.switch_name).toBe('Main-Switch');
  });

  it('Test C-5 — ssid_security cross-joined from wlanconf record', () => {
    const wlanconf = { name: 'Gateway1', security: 'wpa-psk', x_passphrase: '...' };
    const out = normalizeClient(staWireless(), null, wlanconf, null, FIXED_NOW);
    expect(out.ssid_security).toBe('wpa-psk');
  });

  it('Test C-6 — friendly-name fallback: /rest/user.name wins over /stat/sta.hostname', () => {
    const user = { mac: 'aa:bb:cc:11:22:33', name: 'Johns iPhone', hostname: 'iphone-of-john' };
    const out = normalizeClient(staWireless(), user, null, null, FIXED_NOW);
    expect(out.name).toBe('Johns iPhone');
    expect(out.hostname).toBe('iphone-of-john');
  });

  it('Test C-7 — friendly-name fallback: /rest/user.hostname when user.name absent', () => {
    const user = { mac: 'aa:bb:cc:11:22:33', hostname: 'iphone-of-john-2' };
    const out = normalizeClient(staWireless({ hostname: '' }), user, null, null, FIXED_NOW);
    expect(out.name).toBe('iphone-of-john-2');
  });

  it('Test C-8 — friendly-name fallback: /stat/sta.hostname when no user record', () => {
    const out = normalizeClient(staWireless(), null, null, null, FIXED_NOW);
    expect(out.name).toBe('iphone-of-john');
  });

  it('Test C-9 — friendly-name fallback: vendor + last-4-of-mac when no hostname', () => {
    const sta = staWireless({ hostname: '', dev_vendor: 'Apple', mac: '00:11:22:AA:BB:CC' });
    const out = normalizeClient(sta, null, null, null, FIXED_NOW);
    // Last 4 hex chars of MAC: aabbcc → tail 'bbcc'
    expect(out.name).toBe('Apple bbcc');
  });

  it('Test C-10 — note from /rest/user propagated to output', () => {
    const user = { mac: 'aa:bb:cc:11:22:33', name: 'iPhone', note: 'Johns phone' };
    const out = normalizeClient(staWireless(), user, null, null, FIXED_NOW);
    expect(out.note).toBe('Johns phone');
  });

  it('Test C-11 — last_seen + first_seen converted to ISO timestamps', () => {
    const out = normalizeClient(staWireless(), null, null, null, FIXED_NOW);
    expect(typeof out.last_seen).toBe('string');
    expect(out.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.first_seen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('Test C-12 — null/empty raw sta returns null (defensive)', () => {
    expect(normalizeClient(null, null, null, null)).toBe(null);
    expect(normalizeClient({}, null, null, null)).toBe(null);
    expect(normalizeClient({ mac: '' }, null, null, null)).toBe(null);
  });

  it('Test C-13 — _lastSeenMs records wall-clock now for cleanup sweep', () => {
    const out = normalizeClient(staWireless(), null, null, null, FIXED_NOW);
    expect(out._lastSeenMs).toBe(FIXED_NOW);
  });

  it('Test C-14 — rssi fallback when signal is missing (UniFi rssi-95 = dBm)', () => {
    const sta = staWireless({ signal: undefined, rssi: 38 });
    delete sta.signal;
    const out = normalizeClient(sta, null, null, null, FIXED_NOW);
    expect(out.signal_dbm).toBe(38 - 95); // -57
  });
});

describe('Phase 14 — deriveClientState', () => {
  it('Test S-1 — recent lastSeen returns home', () => {
    const now = 1000_000;
    const lastSeen = now - 60_000; // 1 min ago
    expect(deriveClientState({}, lastSeen, 5 * 60_000, now)).toBe('home');
  });

  it('Test S-2 — stale lastSeen (> threshold) returns not_home', () => {
    const now = 1000_000;
    const lastSeen = now - 6 * 60_000; // 6 min ago, threshold 5 min
    expect(deriveClientState({}, lastSeen, 5 * 60_000, now)).toBe('not_home');
  });

  it('Test S-3 — exactly-at-threshold counts as home (≤)', () => {
    const now = 1000_000;
    const lastSeen = now - 5 * 60_000;
    expect(deriveClientState({}, lastSeen, 5 * 60_000, now)).toBe('home');
  });

  it('Test S-4 — missing lastSeenMs returns not_home', () => {
    expect(deriveClientState({}, null, 5 * 60_000, 1000)).toBe('not_home');
    expect(deriveClientState({}, undefined, 5 * 60_000, 1000)).toBe('not_home');
  });
});

describe('integration — end-to-end pure flow on real fixture', () => {
  it('Test 22 — USPM16P: 18 ports through normalizePort, 16 PoE-with-poe_*, 2 SFP+ without; port 1 protected', () => {
    const ports = usw.port_table.map((p) =>
      normalizePort(p, {
        deviceMac: usw.mac,
        connectedDevice: deriveConnectedDevice(p, usw.mac, null),
      }),
    );
    expect(ports).toHaveLength(18);
    const withPoe = ports.filter((p) => 'poe_power_w' in p);
    const withoutPoe = ports.filter((p) => !('poe_power_w' in p));
    // Note: poe_power_w only appears when port_poe=true AND poe_power is set.
    // On a real switch every PoE-capable port reports a poe_power value (even 0).
    expect(withPoe.length).toBe(16);
    expect(withoutPoe.length).toBe(2);
    const port1 = ports.find((p) => p.port_idx === 1);
    expect(port1.protected).toBe(true);
  });
});
