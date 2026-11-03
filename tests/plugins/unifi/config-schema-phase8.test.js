/**
 * Config schema regression for Phase 8 — three new cadence fields and
 * Phase 7's nine fields preserved.
 *
 * The form renderer at webapp/js/pages/plugin-config.js walks
 * Object.keys(schema.properties) in order — ordering matters for UX.
 */
import { describe, it, expect } from 'vitest';
import { getConfigSchema } from '../../../plugins/unifi/config-schema.js';

describe('UniFi config-schema — Phase 8 additions', () => {
  const schema = getConfigSchema();
  const props = schema.properties;
  const keys = Object.keys(props);

  it('Test 1 — pollDeviceListSec: integer, default=30, minimum=5', () => {
    expect(props.pollDeviceListSec).toBeDefined();
    expect(props.pollDeviceListSec.type).toBe('integer');
    expect(props.pollDeviceListSec.default).toBe(30);
    expect(props.pollDeviceListSec.minimum).toBe(5);
  });

  it('Test 2 — pollPortStateSec: integer, default=5, minimum=2', () => {
    expect(props.pollPortStateSec).toBeDefined();
    expect(props.pollPortStateSec.type).toBe('integer');
    expect(props.pollPortStateSec.default).toBe(5);
    expect(props.pollPortStateSec.minimum).toBe(2);
  });

  it('Test 3 — heartbeatSec: integer, default=60, minimum=0', () => {
    expect(props.heartbeatSec).toBeDefined();
    expect(props.heartbeatSec.type).toBe('integer');
    expect(props.heartbeatSec.default).toBe(60);
    expect(props.heartbeatSec.minimum).toBe(0);
  });

  it('Test 4 — Phase 7 fields preserved (additive)', () => {
    const required = [
      'displayName', 'host', 'username', 'password', 'site',
      'topicPrefix', 'autoStart', 'dryRun', 'tlsVerify',
    ];
    for (const k of required) {
      expect(props[k], `Phase 7 field "${k}" missing`).toBeDefined();
    }
  });

  it('Test 5 — Field ordering: cadence fields appear AFTER autoStart and BEFORE dryRun', () => {
    const idxAutoStart = keys.indexOf('autoStart');
    const idxPollDeviceListSec = keys.indexOf('pollDeviceListSec');
    const idxPollPortStateSec = keys.indexOf('pollPortStateSec');
    const idxHeartbeatSec = keys.indexOf('heartbeatSec');
    const idxDryRun = keys.indexOf('dryRun');

    expect(idxAutoStart).toBeGreaterThanOrEqual(0);
    expect(idxDryRun).toBeGreaterThanOrEqual(0);
    expect(idxPollDeviceListSec).toBeGreaterThan(idxAutoStart);
    expect(idxPollPortStateSec).toBeGreaterThan(idxPollDeviceListSec);
    expect(idxHeartbeatSec).toBeGreaterThan(idxPollPortStateSec);
    expect(idxHeartbeatSec).toBeLessThan(idxDryRun);
  });

  it('Test 6 — All cadence field descriptions reference a CONTEXT.md decision ID (D-P-* or D-H-*)', () => {
    const re = /D-[PH]-\d+/;
    expect(props.pollDeviceListSec.description, `pollDeviceListSec description lacks D-P-*/D-H-* ID: ${props.pollDeviceListSec.description}`).toMatch(re);
    expect(props.pollPortStateSec.description, `pollPortStateSec description lacks D-P-*/D-H-* ID: ${props.pollPortStateSec.description}`).toMatch(re);
    expect(props.heartbeatSec.description, `heartbeatSec description lacks D-P-*/D-H-* ID: ${props.heartbeatSec.description}`).toMatch(re);
  });
});
