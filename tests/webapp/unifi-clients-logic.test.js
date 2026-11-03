/**
 * tests for webapp/js/pages/unifi-clients-logic.js — Phase 14 Plan 14-04.
 *
 * Pure helpers, no Preact / no DOM. Covers:
 *  - formatSignal       bucketed dBm → label/dot
 *  - buildConnectionLabel  wired vs wireless one-line summary
 *  - formatRelativeTime  ISO → "5 s ago"
 *  - extractVendor      dev_vendor → oui → '—'
 *  - summarise          aggregate over the live client map
 *  - applyClientsFilter filter state matrix
 *  - parseClientTopic   topic → mac
 */
import { describe, it, expect } from 'vitest';
import {
  formatSignal,
  buildConnectionLabel,
  formatRelativeTime,
  extractVendor,
  summarise,
  applyClientsFilter,
  parseClientTopic,
} from '../../webapp/js/pages/unifi-clients-logic.js';

describe('formatSignal', () => {
  it('Test L-1 — excellent bucket (≥ -60 dBm)', () => {
    expect(formatSignal(-50)).toEqual({ label: 'excellent', dot: 'connected', dbm: -50 });
    expect(formatSignal(-60)).toEqual({ label: 'excellent', dot: 'connected', dbm: -60 });
  });
  it('Test L-2 — good bucket (-61 to -70)', () => {
    expect(formatSignal(-65).label).toBe('good');
    expect(formatSignal(-70).label).toBe('good');
  });
  it('Test L-3 — fair / weak buckets', () => {
    expect(formatSignal(-75).label).toBe('fair');
    expect(formatSignal(-85).label).toBe('weak');
    expect(formatSignal(-85).dot).toBe('error');
  });
  it('Test L-4 — missing dBm', () => {
    expect(formatSignal(null)).toEqual({ label: '—', dot: 'unknown', dbm: null });
    expect(formatSignal(undefined).label).toBe('—');
  });
});

describe('buildConnectionLabel', () => {
  it('Test L-5 — wired with switch_name and port', () => {
    expect(buildConnectionLabel({
      is_wired: true, switch_name: 'MainSwitch', switch_port_idx: 5,
    })).toBe('wired MainSwitch:5');
  });
  it('Test L-6 — wireless with all fields', () => {
    expect(buildConnectionLabel({
      is_wired: false, essid: 'Gateway1', ap_name: 'Wohnzimmer-AP', channel: 36, signal_dbm: -57,
    })).toBe('wifi Gateway1 @ Wohnzimmer-AP / ch 36 / -57 dBm');
  });
  it('Test L-7 — wireless missing channel/signal still renders ssid+ap', () => {
    expect(buildConnectionLabel({ is_wired: false, essid: 'Gateway1', ap_name: 'AP-1' }))
      .toBe('wifi Gateway1 @ AP-1');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-05-13T12:00:00Z').getTime();
  it('Test L-8 — seconds ago', () => {
    const iso = new Date(now - 30_000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('30 s ago');
  });
  it('Test L-9 — minutes ago', () => {
    const iso = new Date(now - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('5 m ago');
  });
  it('Test L-10 — hours ago + days ago + never', () => {
    expect(formatRelativeTime(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3 h ago');
    expect(formatRelativeTime(new Date(now - 2 * 86400_000).toISOString(), now)).toBe('2 d ago');
    expect(formatRelativeTime(null)).toBe('never');
  });
});

describe('extractVendor', () => {
  it('Test L-11 — dev_vendor wins over oui', () => {
    expect(extractVendor({ dev_vendor: 'Apple', oui: 'Other' })).toBe('Apple');
  });
  it('Test L-12 — oui fallback', () => {
    expect(extractVendor({ oui: 'Brother' })).toBe('Brother');
  });
  it('Test L-13 — em-dash when neither', () => {
    expect(extractVendor({})).toBe('—');
    expect(extractVendor(null)).toBe('—');
  });
});

describe('summarise', () => {
  it('Test L-14 — counts wireless/wired/state + collects unique SSIDs/APs/vendors', () => {
    const clients = [
      { mac: '1', is_wired: false, essid: 'Gateway1', ap_name: 'AP-1', state: 'home', dev_vendor: 'Apple' },
      { mac: '2', is_wired: false, essid: 'Gateway1', ap_name: 'AP-2', state: 'home', dev_vendor: 'Apple' },
      { mac: '3', is_wired: true, switch_name: 'Main', state: 'home', dev_vendor: 'Brother' },
      { mac: '4', is_wired: false, essid: 'Guest', ap_name: 'AP-1', state: 'not_home', dev_vendor: 'Samsung' },
    ];
    const s = summarise(clients);
    expect(s.total).toBe(4);
    expect(s.wireless).toBe(3);
    expect(s.wired).toBe(1);
    expect(s.home).toBe(3);
    expect(s.not_home).toBe(1);
    expect(s.ssids).toEqual(['Gateway1', 'Guest']);
    expect(s.aps).toEqual(['AP-1', 'AP-2']);
    expect(s.vendors).toEqual(['Apple', 'Brother', 'Samsung']);
  });
});

describe('applyClientsFilter', () => {
  const clients = [
    { mac: 'aa:11', name: 'iPhone', is_wired: false, essid: 'Gateway1', ap_name: 'AP-1', state: 'home', dev_vendor: 'Apple' },
    { mac: 'bb:22', name: 'Printer', is_wired: true, switch_name: 'Main', state: 'home', dev_vendor: 'Brother' },
    { mac: 'cc:33', name: 'Guest-Phone', is_wired: false, essid: 'Guest', ap_name: 'AP-1', state: 'not_home', dev_vendor: 'Samsung' },
  ];

  it('Test L-15 — wirelessOnly filter', () => {
    expect(applyClientsFilter(clients, { wirelessOnly: true })).toHaveLength(2);
  });
  it('Test L-16 — wiredOnly filter', () => {
    expect(applyClientsFilter(clients, { wiredOnly: true })).toHaveLength(1);
  });
  it('Test L-17 — SSID filter', () => {
    expect(applyClientsFilter(clients, { ssid: 'Gateway1' })).toHaveLength(1);
  });
  it('Test L-18 — AP filter', () => {
    expect(applyClientsFilter(clients, { ap: 'AP-1' })).toHaveLength(2);
  });
  it('Test L-19 — state filter', () => {
    expect(applyClientsFilter(clients, { state: 'not_home' })).toHaveLength(1);
  });
  it('Test L-20 — vendor filter', () => {
    expect(applyClientsFilter(clients, { vendor: 'Apple' })).toHaveLength(1);
  });
  it('Test L-21 — search across hostname/name/mac', () => {
    expect(applyClientsFilter(clients, { q: 'Printer' })).toHaveLength(1);
    expect(applyClientsFilter(clients, { q: 'aa:11' })).toHaveLength(1);
    expect(applyClientsFilter(clients, { q: 'Guest' })).toHaveLength(1);
  });
});

describe('parseClientTopic', () => {
  it('Test L-22 — valid by-mac topic returns colon-separated mac', () => {
    expect(parseClientTopic('unifi-x/clients/by-mac/aa-bb-cc-11-22-33/state'))
      .toBe('aa:bb:cc:11:22:33');
  });
  it('Test L-23 — invalid topic returns null', () => {
    expect(parseClientTopic('unifi-x/clients/summary')).toBe(null);
    expect(parseClientTopic(null)).toBe(null);
    expect(parseClientTopic('unifi-x/clients/by-mac/not-a-mac/state')).toBe(null);
  });
});
