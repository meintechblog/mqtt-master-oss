/**
 * Pure-function unit tests for the UnifiWan page logic (Phase 13 Plan 13-04).
 *
 * Exercises the helpers extracted from webapp/js/pages/unifi-wan-logic.js:
 *   - formatRate(kbps)              — human-readable kbit/s / Mbit/s string
 *   - formatLatency(ms)             — "20 ms" / "—" rendering
 *   - formatBytes(bytes)            — KiB / MiB / GiB
 *   - speedtestButtonState({lastRun, rateLimitMs, now})  — D-P13-UI-02
 *   - failoverVisible({wan1, wan2}) — only show failover card when wan2 exists
 *   - statusDotColor(status)        — site-health rollup colour
 *   - buildWanCmdTopic(prefix, mac, slug)  — uses by-mac for stability
 *
 * No DOM mount; webapp/js/pages/unifi-wan-logic.js stays Preact-free.
 */

import { describe, it, expect } from 'vitest';

import {
  formatRate,
  formatLatency,
  formatBytes,
  speedtestButtonState,
  failoverVisible,
  statusDotColor,
  buildWanCmdTopic,
} from '../../webapp/js/pages/unifi-wan-logic.js';

describe('formatRate', () => {
  it('renders kbps under 1000 as kbit/s', () => {
    expect(formatRate(500)).toBe('500 kbit/s');
    expect(formatRate(999)).toBe('999 kbit/s');
  });
  it('renders >= 1000 kbps as Mbit/s with 1 decimal', () => {
    expect(formatRate(1500)).toBe('1.5 Mbit/s');
    expect(formatRate(100000)).toBe('100.0 Mbit/s');
  });
  it('renders null/undefined/NaN as "—"', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(undefined)).toBe('—');
    expect(formatRate(NaN)).toBe('—');
  });
  it('renders 0 as "0 kbit/s" (zero is meaningful, not unknown)', () => {
    expect(formatRate(0)).toBe('0 kbit/s');
  });
});

describe('formatLatency', () => {
  it('renders ms integer with unit', () => {
    expect(formatLatency(20)).toBe('20 ms');
    expect(formatLatency(180)).toBe('180 ms');
  });
  it('renders null/undefined as "—"', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(undefined)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('renders < 1 KiB in bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });
  it('renders KiB / MiB / GiB with 1 decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MiB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GiB');
  });
});

describe('speedtestButtonState (D-P13-UI-02)', () => {
  it('returns enabled when no prior run', () => {
    const s = speedtestButtonState({ lastRun: null, rateLimitMs: 5 * 60_000, now: 1_000_000 });
    expect(s.enabled).toBe(true);
    expect(s.cooldownLeftSec).toBe(0);
  });
  it('returns disabled when within the rate-limit window', () => {
    const now = 1_000_000;
    const lastRun = now - 60_000; // 1 min ago, window 5 min → 4 min left
    const s = speedtestButtonState({ lastRun, rateLimitMs: 5 * 60_000, now });
    expect(s.enabled).toBe(false);
    expect(s.cooldownLeftSec).toBe(240);
  });
  it('returns enabled when the rate-limit window has elapsed', () => {
    const now = 1_000_000;
    const lastRun = now - 6 * 60_000;
    const s = speedtestButtonState({ lastRun, rateLimitMs: 5 * 60_000, now });
    expect(s.enabled).toBe(true);
    expect(s.cooldownLeftSec).toBe(0);
  });
});

describe('failoverVisible', () => {
  it('returns true when wan2 has an interface set (dual-WAN config)', () => {
    expect(failoverVisible({ wan1: { up: true }, wan2: { up: true, interface: 'eth3' } })).toBe(true);
  });
  it('returns false when wan2 is up=false AND interface is null (single-WAN placeholder)', () => {
    expect(failoverVisible({ wan1: { up: true }, wan2: { up: false, interface: null } })).toBe(false);
  });
  it('returns false when wan2 is missing entirely', () => {
    expect(failoverVisible({ wan1: { up: true } })).toBe(false);
  });
});

describe('statusDotColor', () => {
  it('maps "ok" → connected', () => {
    expect(statusDotColor('ok')).toBe('connected');
  });
  it('maps "warning"|"unknown"|null → unknown', () => {
    expect(statusDotColor('warning')).toBe('unknown');
    expect(statusDotColor('unknown')).toBe('unknown');
    expect(statusDotColor(null)).toBe('unknown');
  });
  it('maps "error"|"failed" → error', () => {
    expect(statusDotColor('error')).toBe('error');
    expect(statusDotColor('failed')).toBe('error');
  });
});

describe('buildWanCmdTopic (uses by-mac for rename stability)', () => {
  it('emits {prefix}by-mac/{macSlug}/wan/cmd', () => {
    const t = buildWanCmdTopic('unifi-gateway1/', '02:00:00:00:00:0e');
    expect(t).toBe('unifi-gateway1/by-mac/02-00-00-00-00-0e/wan/cmd');
  });
  it('handles uppercase mac (case-insensitive)', () => {
    expect(buildWanCmdTopic('unifi-gateway1/', '02:00:00:00:00:0E'))
      .toBe('unifi-gateway1/by-mac/02-00-00-00-00-0e/wan/cmd');
  });
  it('preserves trailing slash on prefix', () => {
    expect(buildWanCmdTopic('unifi-gateway1', '02:00:00:00:00:0e'))
      .toBe('unifi-gateway1/by-mac/02-00-00-00-00-0e/wan/cmd');
  });
});
