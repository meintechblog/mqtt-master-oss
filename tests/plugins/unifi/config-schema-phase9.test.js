/**
 * Config schema regression for Phase 9 — one new field (cyclePortRateLimitMs)
 * inserted between heartbeatSec and dryRun.
 *
 * The form renderer at webapp/js/pages/plugin-config.js walks
 * Object.keys(schema.properties) in order — ordering matters for UX. We pin the
 * field placement so the cycle-window control sits with the other operational
 * tunables (heartbeat / cadence) and ABOVE the safety toggle (dryRun).
 *
 * Decision references:
 *   - D-RL-01 / D-RL-03 — 10s default per-(mac, port_idx) cycle window
 *   - 09-CONTEXT.md `<decisions>` block
 */
import { describe, it, expect } from 'vitest';
import { getConfigSchema } from '../../../plugins/unifi/config-schema.js';

describe('UniFi config-schema — Phase 9 additions', () => {
  const schema = getConfigSchema();
  const props = schema.properties;
  const keys = Object.keys(props);

  it('Test 1 — cyclePortRateLimitMs: integer, default=10000, minimum=1000', () => {
    expect(props.cyclePortRateLimitMs).toBeDefined();
    expect(props.cyclePortRateLimitMs.type).toBe('integer');
    expect(props.cyclePortRateLimitMs.default).toBe(10000);
    expect(props.cyclePortRateLimitMs.minimum).toBe(1000);
  });

  it('Test 2 — cyclePortRateLimitMs description references D-RL-* decision ID', () => {
    const re = /D-RL-\d+/;
    expect(
      props.cyclePortRateLimitMs.description,
      `cyclePortRateLimitMs description lacks D-RL-* ID: ${props.cyclePortRateLimitMs.description}`,
    ).toMatch(re);
  });

  it('Test 3 — Field ordering: cyclePortRateLimitMs appears AFTER heartbeatSec and BEFORE dryRun', () => {
    const idxHeartbeat = keys.indexOf('heartbeatSec');
    const idxCycleRl = keys.indexOf('cyclePortRateLimitMs');
    const idxDryRun = keys.indexOf('dryRun');

    expect(idxHeartbeat).toBeGreaterThanOrEqual(0);
    expect(idxCycleRl).toBeGreaterThanOrEqual(0);
    expect(idxDryRun).toBeGreaterThanOrEqual(0);
    expect(idxCycleRl).toBeGreaterThan(idxHeartbeat);
    expect(idxCycleRl).toBeLessThan(idxDryRun);
  });

  it('Test 4 — Phase 7 + Phase 8 fields preserved (additive)', () => {
    const required = [
      'displayName', 'host', 'username', 'password', 'site',
      'topicPrefix', 'autoStart',
      'pollDeviceListSec', 'pollPortStateSec', 'heartbeatSec',
      'dryRun', 'tlsVerify',
    ];
    for (const k of required) {
      expect(props[k], `Required field "${k}" missing from Phase 9 schema`).toBeDefined();
    }
  });

  it('Test 5 — dryRun unchanged from Phase 7: type=boolean, default=true', () => {
    expect(props.dryRun.type).toBe('boolean');
    expect(props.dryRun.default).toBe(true);
  });
});
