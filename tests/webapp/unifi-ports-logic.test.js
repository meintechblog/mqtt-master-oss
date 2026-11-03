/**
 * Pure-function unit tests for UnifiPorts page logic.
 *
 * Exercises ONLY the named exports from webapp/js/pages/unifi-ports.js that
 * are extracted as pure helpers (no DOM mount, no jsdom dependency). The
 * UnifiPorts component itself is verified visually in the Task 3 checkpoint.
 *
 * Coverage targets (Plan 10-02 Task 2 behavior block):
 *   1.  wattageBadgeClass()             — D-GRID-02 colour thresholds
 *   2.  applyFilter(): empty filter     — pass-through identity
 *   3.  applyFilter(): hasPoE           — drops non-PoE rows
 *   4.  applyFilter(): linkUp           — drops link-down rows
 *   5.  applyFilter(): poeOn            — drops poe_mode !== 'auto' rows
 *   6.  applyFilter(): q substring      — case-insensitive port_name OR connected_device match
 *   7.  applyFilter(): device           — single-device picker
 *   8.  isProtectedKey()                — every protectedPorts entry matches (mac compare lowercased)
 *   9.  buildCmdTopic()                 — `${prefix}by-mac/{macSlugNoColonsLower}/port/{idx}/cmd`
 *   10. buildCmdPayload('off')          — `'{"verb":"off"}'`
 *   11. derivePendingTimedOut()         — 10 s threshold (D-TOAST-02)
 */

import { describe, it, expect } from 'vitest';
// Import the pure-logic side module — kept Preact-free so vitest can resolve
// without the browser import map. See plan-deviation note in 10-02-SUMMARY.md
// (D-UI-01 implementation detail: helpers split into unifi-ports-logic.js).
import {
  wattageBadgeClass,
  applyFilter,
  isProtectedKey,
  buildCmdTopic,
  buildCmdPayload,
  derivePendingTimedOut,
} from '../../webapp/js/pages/unifi-ports-logic.js';

// ──────────────────────────────────────────────────────────────────────────
// Test 1 — wattageBadgeClass: D-GRID-02 colour thresholds
// ──────────────────────────────────────────────────────────────────────────

describe('wattageBadgeClass (D-GRID-02)', () => {
  it('returns green for 0 < power_w < 25', () => {
    expect(wattageBadgeClass({ power_w: 5, link_up: true, poe_mode: 'auto' })).toBe('unifi-ports-badge-green');
    expect(wattageBadgeClass({ power_w: 24.9, link_up: true, poe_mode: 'auto' })).toBe('unifi-ports-badge-green');
  });

  it('returns amber for power_w >= 25', () => {
    expect(wattageBadgeClass({ power_w: 25, link_up: true, poe_mode: 'auto' })).toBe('unifi-ports-badge-amber');
    expect(wattageBadgeClass({ power_w: 60, link_up: true, poe_mode: 'auto' })).toBe('unifi-ports-badge-amber');
  });

  it('returns grey when link_up && power_w === 0', () => {
    expect(wattageBadgeClass({ power_w: 0, link_up: true, poe_mode: 'auto' })).toBe('unifi-ports-badge-grey');
    expect(wattageBadgeClass({ power_w: 0, link_up: true, poe_mode: 'off' })).toBe('unifi-ports-badge-grey');
  });

  it('returns red when !link_up && poe_mode === "auto"', () => {
    expect(wattageBadgeClass({ power_w: 0, link_up: false, poe_mode: 'auto' })).toBe('unifi-ports-badge-red');
  });

  it('returns none for non-PoE / unknown port', () => {
    expect(wattageBadgeClass({ power_w: 0, link_up: false, poe_mode: undefined })).toBe('unifi-ports-badge-none');
    expect(wattageBadgeClass({})).toBe('unifi-ports-badge-none');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyFilter fixtures — small per-device port set
// ──────────────────────────────────────────────────────────────────────────

function makePorts() {
  return [
    {
      device: { mac: 'aa:bb:cc:dd:ee:01', name: 'Main' },
      port_idx: 1, port_name: 'Port 1', poe_mode: 'auto', poe_power_w: 4.2,
      link_up: true, connected_device: 'esp32-tasmota',
    },
    {
      device: { mac: 'aa:bb:cc:dd:ee:01', name: 'Main' },
      port_idx: 2, port_name: 'Port 2', poe_mode: 'off',
      link_up: true, connected_device: 'desktop-A',
    },
    {
      device: { mac: 'aa:bb:cc:dd:ee:01', name: 'Main' },
      port_idx: 3, port_name: 'SFP+ 1', // no poe_mode → non-PoE
      link_up: false, connected_device: null,
    },
    {
      device: { mac: 'aa:bb:cc:dd:ee:02', name: 'Device2' },
      port_idx: 1, port_name: 'Port 1', poe_mode: 'auto', poe_power_w: 12.0,
      link_up: true, connected_device: 'ap-device2',
    },
  ];
}

const EMPTY_FILTER = { device: 'all', hasPoE: false, linkUp: false, poeOn: false, q: '' };

// ──────────────────────────────────────────────────────────────────────────
// Test 2 — empty filter is identity
// ──────────────────────────────────────────────────────────────────────────

describe('applyFilter — empty', () => {
  it('returns input unchanged when no filter active', () => {
    const ports = makePorts();
    const out = applyFilter(ports, EMPTY_FILTER);
    expect(out).toHaveLength(ports.length);
    expect(out.map(p => p.port_idx)).toEqual([1, 2, 3, 1]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 3 — hasPoE
// ──────────────────────────────────────────────────────────────────────────

describe('applyFilter — hasPoE', () => {
  it('drops ports with no PoE capability (no poe_mode field)', () => {
    const out = applyFilter(makePorts(), { ...EMPTY_FILTER, hasPoE: true });
    // The SFP+ port (port_idx 3) has no poe_mode and must be dropped.
    expect(out).toHaveLength(3);
    expect(out.find(p => p.port_name === 'SFP+ 1')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 4 — linkUp
// ──────────────────────────────────────────────────────────────────────────

describe('applyFilter — linkUp', () => {
  it('drops ports with link_up === false', () => {
    const out = applyFilter(makePorts(), { ...EMPTY_FILTER, linkUp: true });
    expect(out).toHaveLength(3);
    expect(out.every(p => p.link_up === true)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 5 — poeOn
// ──────────────────────────────────────────────────────────────────────────

describe('applyFilter — poeOn', () => {
  it('drops ports with poe_mode !== "auto"', () => {
    const out = applyFilter(makePorts(), { ...EMPTY_FILTER, poeOn: true });
    expect(out).toHaveLength(2);
    expect(out.every(p => p.poe_mode === 'auto')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 6 — q substring
// ──────────────────────────────────────────────────────────────────────────

describe('applyFilter — q', () => {
  it('matches case-insensitive substring on port_name OR connected_device', () => {
    const out = applyFilter(makePorts(), { ...EMPTY_FILTER, q: 'ESP' });
    expect(out).toHaveLength(1);
    expect(out[0].connected_device).toBe('esp32-tasmota');
  });

  it('matches on port_name when connected_device misses', () => {
    const out = applyFilter(makePorts(), { ...EMPTY_FILTER, q: 'sfp' });
    expect(out).toHaveLength(1);
    expect(out[0].port_name).toBe('SFP+ 1');
  });

  it('empty q is identity (does not drop null connected_device rows)', () => {
    const out = applyFilter(makePorts(), { ...EMPTY_FILTER, q: '' });
    expect(out).toHaveLength(4);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 7 — device dropdown
// ──────────────────────────────────────────────────────────────────────────

describe('applyFilter — device', () => {
  it('returns only ports whose device.name matches', () => {
    const out = applyFilter(makePorts(), { ...EMPTY_FILTER, device: 'Main' });
    expect(out).toHaveLength(3);
    expect(out.every(p => p.device.name === 'Main')).toBe(true);
  });

  it('"all" is the same as empty', () => {
    expect(applyFilter(makePorts(), { ...EMPTY_FILTER, device: 'all' })).toHaveLength(4);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 8 — isProtectedKey (T-10-05 safety pin)
// ──────────────────────────────────────────────────────────────────────────

describe('isProtectedKey (T-10-05 safety pin)', () => {
  const protectedPorts = [
    { mac: '02:00:00:00:00:fa', port_idx: 1, source: 'hardcoded' },
    { mac: 'AA:BB:CC:DD:EE:01', port_idx: 5, source: 'lldp' },
  ];

  it('returns true for every entry, regardless of source', () => {
    expect(isProtectedKey(protectedPorts, '02:00:00:00:00:fa', 1)).toBe(true);
    expect(isProtectedKey(protectedPorts, 'aa:bb:cc:dd:ee:01', 5)).toBe(true);
  });

  it('mac compare is case-insensitive', () => {
    // Hardcoded entry stored lowercase; LLDP entry stored uppercase in fixture.
    expect(isProtectedKey(protectedPorts, '02:00:00:00:00:FA', 1)).toBe(true);
    expect(isProtectedKey(protectedPorts, 'aa:bb:cc:dd:ee:01', 5)).toBe(true);
  });

  it('returns false for non-listed (mac, port_idx) pairs', () => {
    expect(isProtectedKey(protectedPorts, '02:00:00:00:00:fa', 2)).toBe(false);
    expect(isProtectedKey(protectedPorts, '00:00:00:00:00:00', 1)).toBe(false);
  });

  it('returns false for empty or missing protected list', () => {
    expect(isProtectedKey([], '02:00:00:00:00:fa', 1)).toBe(false);
    expect(isProtectedKey(null, '02:00:00:00:00:fa', 1)).toBe(false);
    expect(isProtectedKey(undefined, '02:00:00:00:00:fa', 1)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 9 — buildCmdTopic (T-10-08 topic-construction pin)
// ──────────────────────────────────────────────────────────────────────────

describe('buildCmdTopic (T-10-08 topic-construction pin)', () => {
  // CRITICAL: the slug MUST be dashed (`02-00-00-00-00-fa`), not compact
  // (`0200000000fa`). The plugin's cmd dispatch reverses `replace(/-/g, ':')`
  // and validates against /^[0-9a-f:]{17}$/. A compact slug yields no colons
  // → fails validation → status:'unknown_device' silently. Every PoE write
  // from the UI broke on this from Phase 10 until 2026-05-13.
  it('returns dashed macSlug form matching plugins/lib/slug.js macSlug()', () => {
    expect(buildCmdTopic('unifi/', '02:00:00:00:00:FA', 1))
      .toBe('unifi/by-mac/02-00-00-00-00-fa/port/1/cmd');
  });

  it('strips arbitrary separators and lowercases regardless of input case', () => {
    expect(buildCmdTopic('unifi/', 'AA:bb:CC:dd:EE:01', 7))
      .toBe('unifi/by-mac/aa-bb-cc-dd-ee-01/port/7/cmd');
  });

  it('preserves trailing slash on prefix (does not double or strip)', () => {
    expect(buildCmdTopic('unifi-gateway1/', 'aa:bb:cc:dd:ee:01', 3))
      .toBe('unifi-gateway1/by-mac/aa-bb-cc-dd-ee-01/port/3/cmd');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 9b — buildCmdPayload accepts plain on/off/cycle (the only shape the
// plugin's parsePayload returns directly; the earlier `{verb}` JSON envelope
// returned null from parsePayload → invalid_payload result).
// ──────────────────────────────────────────────────────────────────────────

describe('buildCmdPayload — plain string shape', () => {
  it('returns the bare verb string for on/off/cycle', () => {
    expect(buildCmdPayload('on')).toBe('on');
    expect(buildCmdPayload('off')).toBe('off');
    expect(buildCmdPayload('cycle')).toBe('cycle');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Test 10 — (placeholder retained for numbering; the assertion replaced by
// the plain-string test in 9b above. The previous JSON-envelope shape
// `{verb:'off'}` returned null from the plugin's parsePayload, so the entire
// PoE write path silently 'invalid_payload'd until 2026-05-13.)
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// Test 11 — derivePendingTimedOut (D-TOAST-02 threshold pin)
// ──────────────────────────────────────────────────────────────────────────

describe('derivePendingTimedOut — PORT_RESULT_TIMEOUT_MS threshold (60 s)', () => {
  // Bumped from 10s to 60s after the user reported that some UniFi
  // controllers queue port_overrides RMW writes for 10–20s when busy —
  // the result topic does eventually fire with status:ok, but the toast
  // had already gone yellow. 60s comfortably covers the worst case.
  it('returns keys whose startedAt + PORT_RESULT_TIMEOUT_MS <= nowMs', () => {
    const now = 100_000;
    const pending = new Map([
      ['aa:bb:cc:dd:ee:01:1:off',    { startedAt: 30_000 }],   // 70s old — TIMED OUT
      ['aa:bb:cc:dd:ee:01:2:cycle',  { startedAt: 95_000 }],   // 5s old — still pending
      ['aa:bb:cc:dd:ee:01:3:on',     { startedAt: 40_000 }],   // exactly 60s — TIMED OUT (boundary)
      ['aa:bb:cc:dd:ee:02:1:off',    { startedAt: 40_001 }],   // 59.999s — still pending
    ]);
    const out = derivePendingTimedOut(pending, now).sort();
    expect(out).toEqual([
      'aa:bb:cc:dd:ee:01:1:off',
      'aa:bb:cc:dd:ee:01:3:on',
    ]);
  });

  it('returns empty when no entries have crossed the 60 s threshold', () => {
    const now = 100_000;
    const pending = new Map([
      ['aa:bb:cc:dd:ee:01:1:off', { startedAt: 45_000 }], // 55s old — still pending
    ]);
    expect(derivePendingTimedOut(pending, now)).toEqual([]);
  });

  it('returns empty for an empty map', () => {
    expect(derivePendingTimedOut(new Map(), 100_000)).toEqual([]);
  });
});
