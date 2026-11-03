import { describe, it, expect } from 'vitest';
import {
  INPUT_STALE_MS,
  evaluateBindingHealth,
  aggregateHealth,
} from '../plugins/lib/binding-health.js';

// Fixed "now" so the stale-boundary cases are deterministic.
const NOW = 1_700_000_000_000;

/**
 * Build a realistic enabled stat object; spread overrides on top. A healthy
 * stat by default: it has received and forwarded values recently.
 */
function makeStat(overrides = {}) {
  return {
    id: 'b-1',
    label: 'Test Binding',
    enabled: true,
    mqttTopic: 'sensors/temp',
    jsonField: '',
    targetUuid: 'uuid-1',
    value: 23.5,
    lastSentAt: NOW - 1000,
    lastReceivedAt: NOW - 1000,
    sendCount: 5,
    recvCount: 5,
    lastReason: 'changed',
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  };
}

describe('evaluateBindingHealth — OK branch', () => {
  it('lastReason "changed", sendCount>0 → ok', () => {
    const h = evaluateBindingHealth(makeStat({ lastReason: 'changed' }), NOW);
    expect(h.severity).toBe('ok');
    expect(h.reason).toBe('ok');
  });

  it('lastReason "dedup", sendCount>0 → ok (dedup is healthy, not a fault)', () => {
    const h = evaluateBindingHealth(makeStat({ lastReason: 'dedup' }), NOW);
    expect(h.severity).toBe('ok');
    expect(h.reason).toBe('ok');
  });

  it('lastReason "timer_heartbeat", sendCount>0 → ok', () => {
    const h = evaluateBindingHealth(makeStat({ lastReason: 'timer_heartbeat' }), NOW);
    expect(h.severity).toBe('ok');
    expect(h.reason).toBe('ok');
  });

  it('recvCount=5, lastReceivedAt = now−2min → NOT stale, stays ok (boundary guard)', () => {
    const h = evaluateBindingHealth(
      makeStat({ recvCount: 5, lastReceivedAt: NOW - 2 * 60 * 1000 }),
      NOW,
    );
    expect(h.severity).toBe('ok');
    expect(h.reason).toBe('ok');
  });
});

describe('evaluateBindingHealth — WARN branch', () => {
  it('recvCount=0 → warn / input_silent', () => {
    const h = evaluateBindingHealth(
      makeStat({ recvCount: 0, sendCount: 0, lastReceivedAt: null }),
      NOW,
    );
    expect(h.severity).toBe('warn');
    expect(h.reason).toBe('input_silent');
  });

  it('recvCount=5, lastReceivedAt = now−20min → warn / input_stale', () => {
    const h = evaluateBindingHealth(
      makeStat({ recvCount: 5, lastReceivedAt: NOW - 20 * 60 * 1000 }),
      NOW,
    );
    expect(h.severity).toBe('warn');
    expect(h.reason).toBe('input_stale');
  });
});

describe('evaluateBindingHealth — sourceMode (event-source flag)', () => {
  // The sourceMode field classifies the upstream publisher's cadence so
  // event-driven sources (motion sensors, door contacts, etc.) don't get
  // flagged as `input_stale` after 15 min of legitimate silence. The
  // suppression only affects the `input_stale` warn-branch — `input_silent`
  // (never received a payload) still fires regardless, because an event
  // source that has NEVER published is genuinely broken.

  it('sourceMode "event" + 20min since last receive → ok (stale suppressed)', () => {
    const h = evaluateBindingHealth(
      makeStat({ sourceMode: 'event', lastReceivedAt: NOW - 20 * 60 * 1000 }),
      NOW,
    );
    expect(h.severity).toBe('ok');
    expect(h.reason).toBe('ok');
  });

  it('sourceMode "event" + never received → warn / input_silent (silent still fires)', () => {
    const h = evaluateBindingHealth(
      makeStat({ sourceMode: 'event', recvCount: 0, sendCount: 0, lastReceivedAt: null }),
      NOW,
    );
    expect(h.severity).toBe('warn');
    expect(h.reason).toBe('input_silent');
  });

  it('sourceMode "cyclic" + 20min since last receive → warn / input_stale (backward compat)', () => {
    const h = evaluateBindingHealth(
      makeStat({ sourceMode: 'cyclic', lastReceivedAt: NOW - 20 * 60 * 1000 }),
      NOW,
    );
    expect(h.severity).toBe('warn');
    expect(h.reason).toBe('input_stale');
  });

  it('missing sourceMode + 20min since last receive → warn / input_stale (default cyclic)', () => {
    const h = evaluateBindingHealth(
      makeStat({ lastReceivedAt: NOW - 20 * 60 * 1000 }),
      NOW,
    );
    expect(h.severity).toBe('warn');
    expect(h.reason).toBe('input_stale');
  });
});

describe('evaluateBindingHealth — ERROR branch', () => {
  it('lastReason "field_missing" → error / field_missing', () => {
    const h = evaluateBindingHealth(makeStat({ lastReason: 'field_missing' }), NOW);
    expect(h.severity).toBe('error');
    expect(h.reason).toBe('field_missing');
  });

  it('lastReason "json_parse_failed" → error / json_parse_failed', () => {
    const h = evaluateBindingHealth(makeStat({ lastReason: 'json_parse_failed' }), NOW);
    expect(h.severity).toBe('error');
    expect(h.reason).toBe('json_parse_failed');
  });

  it('lastReason "empty_payload" → error / empty_payload', () => {
    const h = evaluateBindingHealth(makeStat({ lastReason: 'empty_payload' }), NOW);
    expect(h.severity).toBe('error');
    expect(h.reason).toBe('empty_payload');
  });

  it('lastReason "send_error" → error / send_error', () => {
    const h = evaluateBindingHealth(makeStat({ lastReason: 'send_error' }), NOW);
    expect(h.severity).toBe('error');
    expect(h.reason).toBe('send_error');
  });

  it('recvCount=3, sendCount=0, lastReason null → error / never_forwarded', () => {
    const h = evaluateBindingHealth(
      makeStat({ recvCount: 3, sendCount: 0, lastReason: null }),
      NOW,
    );
    expect(h.severity).toBe('error');
    expect(h.reason).toBe('never_forwarded');
  });
});

describe('evaluateBindingHealth — disabled short-circuit', () => {
  it('enabled:false → severity disabled regardless of other fields', () => {
    const h = evaluateBindingHealth(
      makeStat({ enabled: false, lastReason: 'send_error', recvCount: 0 }),
      NOW,
    );
    expect(h.severity).toBe('disabled');
    expect(h.reason).toBe('disabled');
  });
});

describe('aggregateHealth', () => {
  it('mix of ok+warn+error → severity error, counts correct, issues error-first', () => {
    const stats = [
      makeStat({ id: 'ok-1', lastReason: 'changed' }),
      makeStat({ id: 'warn-1', recvCount: 0, sendCount: 0, lastReceivedAt: null }),
      makeStat({ id: 'err-1', lastReason: 'send_error' }),
      makeStat({ id: 'dis-1', enabled: false }),
    ];
    const agg = aggregateHealth(stats, NOW);
    expect(agg.severity).toBe('error');
    expect(agg.total).toBe(3); // disabled excluded
    expect(agg.counts).toEqual({ ok: 1, warn: 1, error: 1, disabled: 1 });
    // ok + disabled never appear in issues; error sorts before warn.
    expect(agg.issues).toHaveLength(2);
    expect(agg.issues[0].id).toBe('err-1');
    expect(agg.issues[0].severity).toBe('error');
    expect(agg.issues[1].id).toBe('warn-1');
    expect(agg.issues[1].severity).toBe('warn');
  });

  it('all ok → severity ok, empty issues', () => {
    const stats = [
      makeStat({ id: 'a', lastReason: 'changed' }),
      makeStat({ id: 'b', lastReason: 'dedup' }),
    ];
    const agg = aggregateHealth(stats, NOW);
    expect(agg.severity).toBe('ok');
    expect(agg.total).toBe(2);
    expect(agg.issues).toEqual([]);
  });

  it('all disabled → severity none, total 0', () => {
    const stats = [
      makeStat({ id: 'a', enabled: false }),
      makeStat({ id: 'b', enabled: false }),
    ];
    const agg = aggregateHealth(stats, NOW);
    expect(agg.severity).toBe('none');
    expect(agg.total).toBe(0);
    expect(agg.counts.disabled).toBe(2);
  });

  it('empty array → severity none', () => {
    const agg = aggregateHealth([], NOW);
    expect(agg.severity).toBe('none');
    expect(agg.total).toBe(0);
    expect(agg.issues).toEqual([]);
  });
});

describe('INPUT_STALE_MS', () => {
  it('is 15 minutes in ms', () => {
    expect(INPUT_STALE_MS).toBe(15 * 60 * 1000);
  });
});
