import { describe, it, expect, vi } from 'vitest';
import {
  composeHealthDigest,
  resolveBoxLabel,
} from '../server/services/health-digest.js';

// Fixed "now" so disconnect-age math is deterministic.
const NOW = 1_700_000_000_000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Build a healthy enabled binding stat; spread overrides on top. */
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

/** Build a listAll()-shaped plugin entry; spread overrides on top. */
function makePlugin(overrides = {}) {
  return {
    id: 'loxone',
    type: 'loxone',
    name: 'Loxone',
    displayName: 'Loxone Test',
    status: 'running',
    error: null,
    deletable: true,
    connected: true,
    connection: {
      connected: true,
      lastConnectedAt: NOW - 60_000,
      lastDisconnectAt: null,
      totalConnects: 3,
      currentReconnectAttempt: 0,
    },
    ...overrides,
  };
}

/** Default base inputs for composeHealthDigest; spread overrides on top. */
function baseInputs(overrides = {}) {
  return {
    plugins: [],
    getStatsForPlugin: () => null,
    configBox: 'house1',
    envBox: undefined,
    hostname: 'house1.example.com',
    host: '203.0.113.213',
    now: NOW,
    getAutoStart: () => true,
    logger: { warn: vi.fn() },
    ...overrides,
  };
}

describe('resolveBoxLabel', () => {
  it('prefers configBox over env and hostname', () => {
    expect(resolveBoxLabel({ configBox: 'house1', envBox: 'gateway1', hostname: 'nope' }))
      .toBe('house1');
  });

  it('falls through to env when configBox is null', () => {
    expect(resolveBoxLabel({ configBox: null, envBox: 'gateway1', hostname: 'nope' }))
      .toBe('gateway1');
  });

  it('falls through to hostname when configBox and env are unset', () => {
    expect(resolveBoxLabel({ configBox: null, envBox: undefined, hostname: 'house1.example.com' }))
      .toBe('house1.example.com');
  });

  it('treats empty-string configBox as unset', () => {
    expect(resolveBoxLabel({ configBox: '', envBox: undefined, hostname: 'house1.example.com' }))
      .toBe('house1.example.com');
  });

  it('treats empty-string env as unset (falls through to hostname)', () => {
    expect(resolveBoxLabel({ configBox: null, envBox: '', hostname: 'fallback.example.com' }))
      .toBe('fallback.example.com');
  });
});

describe('composeHealthDigest — envelope shape', () => {
  it('empty case: no plugins → ok_count 0, issues [], envelope filled', () => {
    const out = composeHealthDigest(baseInputs());
    expect(out).toEqual({
      box: 'house1',
      host: '203.0.113.213',
      checked_at: new Date(NOW).toISOString(),
      ok_count: 0,
      issues: [],
    });
    expect(out.checked_at).toMatch(ISO_RE);
  });
});

describe('composeHealthDigest — binding-level integration', () => {
  it('all-ok case: 1 loxone plugin + 2 ok bindings → ok_count 3, no issues', () => {
    const plugin = makePlugin({ id: 'loxone' });
    const stats = [
      makeStat({ id: 'b-ok-a', lastReason: 'changed' }),
      makeStat({ id: 'b-ok-b', lastReason: 'dedup' }),
    ];
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
      getStatsForPlugin: (id) => (id === 'loxone' ? stats : null),
    }));
    expect(out.issues).toEqual([]);
    expect(out.ok_count).toBe(3); // 2 ok bindings + 1 ok plugin
  });

  it('binding-issue only: 1 stale binding → 1 warn issue with last_event ISO, ok_count counts the other ok binding+plugin', () => {
    const plugin = makePlugin({ id: 'loxone' });
    const staleAt = NOW - 20 * 60 * 1000;
    const stats = [
      makeStat({ id: 'b-ok', lastReason: 'changed' }),
      makeStat({ id: 'b-stale', lastReceivedAt: staleAt }),
    ];
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
      getStatsForPlugin: () => stats,
    }));
    expect(out.issues).toHaveLength(1);
    const issue = out.issues[0];
    expect(issue).toMatchObject({
      plugin: 'loxone',
      kind: 'binding',
      id: 'b-stale',
      severity: 'warn',
      reason: 'input_stale',
    });
    expect(issue.last_event).toBe(new Date(staleAt).toISOString());
    expect(issue.last_event).toMatch(ISO_RE);
    expect(out.ok_count).toBe(2); // 1 ok binding + 1 ok plugin
  });

  it('binding-issue with null lastReceivedAt → last_event is null (not a bogus ISO)', () => {
    const plugin = makePlugin({ id: 'loxone' });
    // input_silent: recvCount=0, lastReceivedAt=null
    const stats = [
      makeStat({ id: 'b-silent', recvCount: 0, sendCount: 0, lastReceivedAt: null }),
    ];
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
      getStatsForPlugin: () => stats,
    }));
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].reason).toBe('input_silent');
    expect(out.issues[0].last_event).toBeNull();
  });
});

describe('composeHealthDigest — plugin-liveness reasons', () => {
  it('connection_lost: running, connected=false, totalConnects>0 → error, last_event=ISO(lastDisconnectAt)', () => {
    const lastDisconnect = NOW - 4 * 60 * 1000;
    const plugin = makePlugin({
      id: 'gateway1',
      type: 'loxone',
      displayName: 'Loxone Gateway1',
      connection: {
        connected: false,
        lastConnectedAt: NOW - 10 * 60 * 1000,
        lastDisconnectAt: lastDisconnect,
        totalConnects: 5,
        currentReconnectAttempt: 2,
      },
    });
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
    }));
    expect(out.issues).toHaveLength(1);
    const issue = out.issues[0];
    expect(issue).toMatchObject({
      plugin: 'gateway1',
      kind: 'plugin',
      id: 'gateway1',
      severity: 'error',
      reason: 'connection_lost',
      label: 'Loxone Gateway1',
    });
    expect(issue.last_event).toBe(new Date(lastDisconnect).toISOString());
    expect(issue.last_event).toMatch(ISO_RE);
    expect(out.ok_count).toBe(0);
  });

  it('never_connected: running, connected=false, totalConnects=0, no reconnectAttempt → warn, last_event null', () => {
    const plugin = makePlugin({
      id: 'loxone',
      connection: {
        connected: false,
        lastConnectedAt: null,
        lastDisconnectAt: null,
        totalConnects: 0,
        currentReconnectAttempt: 0,
      },
    });
    const out = composeHealthDigest(baseInputs({ plugins: [plugin] }));
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({
      kind: 'plugin',
      severity: 'warn',
      reason: 'never_connected',
      last_event: null,
    });
  });

  it('not_running: autoStart=true, status=stopped → error, last_event null', () => {
    const plugin = makePlugin({
      id: 'loxone',
      status: 'stopped',
      connection: null,
    });
    // We still want plugin-liveness branch to fire for a connection-bearing type.
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
      getAutoStart: () => true,
    }));
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({
      kind: 'plugin',
      severity: 'error',
      reason: 'not_running',
      last_event: null,
    });
  });

  it('start_error: status=error, error="ECONNREFUSED ..." → error, detail starts with the error message', () => {
    const errMsg = 'ECONNREFUSED 192.0.2.128:80';
    const plugin = makePlugin({
      id: 'loxone',
      status: 'error',
      error: errMsg,
      connection: null,
    });
    const out = composeHealthDigest(baseInputs({ plugins: [plugin] }));
    expect(out.issues).toHaveLength(1);
    const issue = out.issues[0];
    expect(issue).toMatchObject({
      kind: 'plugin',
      severity: 'error',
      reason: 'start_error',
    });
    expect(issue.detail.startsWith(errMsg)).toBe(true);
    expect(issue.last_event).toBeNull();
  });

  it('start_error: missing error field → detail is the German fallback', () => {
    const plugin = makePlugin({
      id: 'loxone',
      status: 'error',
      error: null,
      connection: null,
    });
    const out = composeHealthDigest(baseInputs({ plugins: [plugin] }));
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].detail).toBe('Plugin-Start fehlgeschlagen');
  });

  it('start_error: error message longer than 200 chars is truncated', () => {
    const longErr = 'x'.repeat(500);
    const plugin = makePlugin({
      id: 'loxone',
      status: 'error',
      error: longErr,
      connection: null,
    });
    const out = composeHealthDigest(baseInputs({ plugins: [plugin] }));
    expect(out.issues[0].detail.length).toBe(200);
  });

  it('stopped-on-purpose: autoStart=false, status=stopped → no issue, no ok_count bump', () => {
    const plugin = makePlugin({
      id: 'loxone',
      status: 'stopped',
      connection: null,
    });
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
      getAutoStart: () => false,
    }));
    expect(out.issues).toEqual([]);
    expect(out.ok_count).toBe(0);
  });

  it('healthy connection: running + connected=true → no issue, ok_count += 1', () => {
    const plugin = makePlugin({ id: 'loxone' });
    const out = composeHealthDigest(baseInputs({ plugins: [plugin] }));
    expect(out.issues).toEqual([]);
    expect(out.ok_count).toBe(1);
  });
});

describe('composeHealthDigest — bridge plugin without connection field', () => {
  it('mqtt-bridge running + 2 ok bindings → no plugin-issue, plugin NOT counted at liveness layer, ok_count = 2', () => {
    const plugin = makePlugin({
      id: 'venus',
      type: 'mqtt-bridge',
      displayName: 'Venus OS',
      // No connection field at all — bridge-style.
      connection: undefined,
      connected: undefined,
    });
    delete plugin.connection;
    delete plugin.connected;
    const stats = [
      makeStat({ id: 'b1', lastReason: 'changed' }),
      makeStat({ id: 'b2', lastReason: 'dedup' }),
    ];
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
      getStatsForPlugin: () => stats,
    }));
    expect(out.issues).toEqual([]);
    expect(out.ok_count).toBe(2); // bindings only — bridge not counted at liveness layer
  });
});

describe('composeHealthDigest — mixed + ordering', () => {
  it('loxone connection_lost + binding send_error, plus healthy mqtt-bridge with 1 ok binding', () => {
    const lastDisconnect = NOW - 2 * 60 * 1000;
    const lox = makePlugin({
      id: 'loxone',
      displayName: 'Loxone',
      connection: {
        connected: false,
        lastConnectedAt: NOW - 10 * 60 * 1000,
        lastDisconnectAt: lastDisconnect,
        totalConnects: 5,
        currentReconnectAttempt: 1,
      },
    });
    const loxStats = [
      makeStat({ id: 'b-send-err', lastReason: 'send_error' }),
    ];
    const bridge = makePlugin({
      id: 'venus',
      type: 'mqtt-bridge',
    });
    delete bridge.connection;
    delete bridge.connected;
    const bridgeStats = [
      makeStat({ id: 'b-ok', lastReason: 'changed' }),
    ];

    const out = composeHealthDigest(baseInputs({
      plugins: [lox, bridge],
      getStatsForPlugin: (id) => (id === 'loxone' ? loxStats : bridgeStats),
    }));

    expect(out.issues).toHaveLength(2);
    // Stable ordering: error before warn; within same severity, plugin before binding.
    expect(out.issues[0]).toMatchObject({
      plugin: 'loxone',
      kind: 'plugin',
      reason: 'connection_lost',
    });
    expect(out.issues[1]).toMatchObject({
      plugin: 'loxone',
      kind: 'binding',
      reason: 'send_error',
    });
    expect(out.ok_count).toBe(1); // bridge's ok binding only
  });
});

describe('composeHealthDigest — defensive composition', () => {
  it('getStatsForPlugin throws for one plugin → logger.warn called, plugin skipped, others still contribute', () => {
    const lox = makePlugin({ id: 'loxone' });
    const bridge = makePlugin({
      id: 'venus',
      type: 'mqtt-bridge',
    });
    delete bridge.connection;
    delete bridge.connected;
    const bridgeStats = [
      makeStat({ id: 'b-ok', lastReason: 'changed' }),
    ];
    const logger = { warn: vi.fn() };
    const out = composeHealthDigest(baseInputs({
      plugins: [lox, bridge],
      getStatsForPlugin: (id) => {
        if (id === 'loxone') throw new Error('boom');
        return bridgeStats;
      },
      logger,
    }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("loxone");
    expect(logger.warn.mock.calls[0][0]).toContain('boom');
    // The bridge still contributes its ok binding.
    expect(out.ok_count).toBe(1);
    // The loxone plugin contributed nothing (no issue, no ok_count bump).
    expect(out.issues).toEqual([]);
  });
});

describe('composeHealthDigest — ISO-8601 enforcement', () => {
  it('every emitted timestamp (checked_at + non-null last_event) matches the ISO regex', () => {
    const lastDisconnect = NOW - 90_000;
    const staleAt = NOW - 20 * 60 * 1000;
    const plugin = makePlugin({
      id: 'gateway1',
      connection: {
        connected: false,
        lastConnectedAt: NOW - 10 * 60 * 1000,
        lastDisconnectAt: lastDisconnect,
        totalConnects: 5,
        currentReconnectAttempt: 1,
      },
    });
    const stats = [
      makeStat({ id: 'b-stale', lastReceivedAt: staleAt }),
    ];
    const out = composeHealthDigest(baseInputs({
      plugins: [plugin],
      getStatsForPlugin: () => stats,
    }));
    expect(out.checked_at).toMatch(ISO_RE);
    for (const issue of out.issues) {
      if (issue.last_event !== null) {
        expect(issue.last_event).toMatch(ISO_RE);
      }
    }
  });
});
