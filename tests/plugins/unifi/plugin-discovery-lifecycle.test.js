/**
 * UnifiPlugin × HA-Discovery lifecycle integration tests.
 *
 * Phase 11 Plan 11-02 — pins:
 *   - D-LIFE-01: discovery is published AFTER the cold-start poll seeds the
 *                snapshot (start() returns with HA topics already populated)
 *   - D-LIFE-03: stop() clears every discovery topic the plugin published
 *                BEFORE publishing bridge/status=offline
 *   - D-LIFE-04: structure-monitor removal → discovery topics for the removed
 *                device are retain-cleared
 *   - D-CFG-01:  haDiscovery=false → ZERO outbound discovery publishes
 *                (phase-boundary regression: existing Phase 7-10 surface
 *                untouched when the flag is off)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBehaviour, mockClientInstances, mockPollInstances } = vi.hoisted(() => ({
  mockBehaviour: {
    checkUnifiOsResult: true,
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
    sysinfoShouldThrow: false,
    pollMetrics: { devicesDiscovered: 1, lastPollSuccessAt: '2026-05-13T00:00:00Z', pollErrorCount: 0 },
    // Snapshot the cold-start poll seeds.
    snapshot: new Map([
      ['02:00:00:00:00:fa', {
        mac: '02:00:00:00:00:fa',
        name: 'Main',
        nameSlug: 'main',
        model: 'USPM16P',
        type: 'usw',
        portCount: 2,
      }],
    ]),
    portTables: new Map([
      ['02:00:00:00:00:fa', [
        { port_idx: 1, port_poe: true, name: 'Port 1' },
        { port_idx: 2, port_poe: true, name: 'Port 2' },
      ]],
    ]),
  },
  mockClientInstances: [],
  mockPollInstances: [],
}));

vi.mock('../../../plugins/unifi/unifi-client.js', async () => {
  const { EventEmitter } = await import('node:events');
  const AUTH_STATE = Object.freeze({ CONNECTED: 'connected', DISCONNECTED: 'disconnected', AUTH_FAILED: 'auth_failed' });
  class MockUnifiClient extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._state = { authState: AUTH_STATE.DISCONNECTED, authStateReason: null };
      this.checkUnifiOs = vi.fn(async () => mockBehaviour.checkUnifiOsResult);
      this.login = vi.fn(async () => { this._state.authState = AUTH_STATE.CONNECTED; });
      this.request = vi.fn(async ({ path }) => {
        if (path === '/api/system') {
          if (mockBehaviour.sysinfoShouldThrow) throw new Error('sysinfo failed');
          return mockBehaviour.sysinfoResult;
        }
        throw new Error(`unexpected ${path}`);
      });
      this.disconnect = vi.fn(async () => { this.emit('disconnected'); });
      this.getStatus = vi.fn(() => ({ ...this._state }));
      mockClientInstances.push(this);
    }
  }
  return { UnifiClient: MockUnifiClient, AUTH_STATE };
});

vi.mock('../../../plugins/unifi/unifi-poll.js', async () => {
  const { EventEmitter } = await import('node:events');
  class MockUnifiPoll extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      // Seed the snapshot + port_tables on construction so runOnce() simply
      // marks the cold-start sync done — the real poll would have hit the
      // controller and populated these.
      this._lastSnapshot = mockBehaviour.snapshot;
      this.runOnce = vi.fn(async () => {});
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.getMetrics = vi.fn(() => mockBehaviour.pollMetrics);
      this.getStructureSummary = vi.fn(() => ({ devices: [] }));
      this.getCachedPortTables = vi.fn(() => mockBehaviour.portTables);
      this.getRuntimeProtectedPorts = vi.fn(() => new Set());
      mockPollInstances.push(this);
    }
  }
  return { UnifiPoll: MockUnifiPoll };
});

const { default: UnifiPlugin } = await import('../../../plugins/unifi/plugin.js');

function createMockContext(configOverrides = {}) {
  const config = {
    host: '192.0.2.1', username: 'mqtt-master', password: 'pw',
    site: 'default', tlsVerify: false,
    ...configOverrides,
  };
  return {
    mqttService: {
      publish: vi.fn(async () => {}),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    configService: {
      get: vi.fn((key, def) => (key === 'plugins.unifi' ? config : def)),
      set: vi.fn(),
      save: vi.fn(async () => {}),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginId: 'unifi',
    _config: config,
  };
}

function resetMockBehaviour() {
  mockBehaviour.snapshot = new Map([
    ['02:00:00:00:00:fa', {
      mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main',
      model: 'USPM16P', type: 'usw', portCount: 2,
    }],
  ]);
  mockBehaviour.portTables = new Map([
    ['02:00:00:00:00:fa', [
      { port_idx: 1, port_poe: true, name: 'Port 1' },
      { port_idx: 2, port_poe: true, name: 'Port 2' },
    ]],
  ]);
  mockClientInstances.length = 0;
  mockPollInstances.length = 0;
}

const isDiscoveryTopic = (t) =>
  typeof t === 'string' && t.startsWith('homeassistant/') && t.endsWith('/config');
const isRetainClear = ([, payload, opts]) => payload === '' && opts && opts.retain === true;

describe('UnifiPlugin × HA Discovery lifecycle', () => {
  let plugin, ctx;

  beforeEach(() => {
    resetMockBehaviour();
    plugin = new UnifiPlugin();
    ctx = createMockContext();
  });

  it('Test 1 — D-LIFE-01: start publishes HA Discovery for every PoE port after cold-start poll', async () => {
    await plugin.start(ctx);

    const discoveryPublishes = ctx.mqttService.publish.mock.calls.filter(
      ([t]) => isDiscoveryTopic(t),
    );
    // Phase 13: 2 PoE ports × 10 entities = 20 discovery topics.
    // (Phase 13 added rx_rate, tx_rate, link_down_count per port.)
    expect(discoveryPublishes.length).toBe(2 * 10);

    // Every discovery publish is retained AND non-empty (i.e. publish, not clear).
    for (const [, payload, opts] of discoveryPublishes) {
      expect(typeof payload).toBe('string');
      expect(payload.length).toBeGreaterThan(0);
      expect(opts).toEqual({ retain: true });
    }
  });

  it('Test 2 — D-LIFE-03: stop retain-clears every discovery topic it previously published, BEFORE bridge/status=offline', async () => {
    await plugin.start(ctx);
    const publishedDiscoveryTopics = ctx.mqttService.publish.mock.calls
      .filter(([t]) => isDiscoveryTopic(t))
      .map(([t]) => t)
      .sort();
    ctx.mqttService.publish.mockClear();

    await plugin.stop();

    // Every previously-published discovery topic is now retain-cleared.
    const stopPublishes = ctx.mqttService.publish.mock.calls;
    const clearedDiscovery = stopPublishes
      .filter(([t, p, o]) => isDiscoveryTopic(t) && p === '' && o?.retain === true)
      .map(([t]) => t)
      .sort();
    expect(clearedDiscovery).toEqual(publishedDiscoveryTopics);

    // Bridge offline was published.
    const bridgePublish = stopPublishes.find(
      ([t, p]) => /\/bridge\/status$/.test(t) && p === 'offline',
    );
    expect(bridgePublish).toBeDefined();

    // ORDER: every discovery clear precedes the bridge/status=offline publish.
    const offlineIdx = stopPublishes.findIndex(
      ([t, p]) => /\/bridge\/status$/.test(t) && p === 'offline',
    );
    const lastDiscoveryClearIdx = stopPublishes.findLastIndex(([t]) => isDiscoveryTopic(t));
    expect(lastDiscoveryClearIdx).toBeGreaterThan(-1);
    expect(lastDiscoveryClearIdx).toBeLessThan(offlineIdx);
  });

  it('Test 3 — haDiscovery=false → ZERO discovery publishes during start, zero clears during stop (D-CFG-01)', async () => {
    ctx = createMockContext({ haDiscovery: false });
    await plugin.start(ctx);

    const discoveryPublishes = ctx.mqttService.publish.mock.calls.filter(
      ([t]) => isDiscoveryTopic(t),
    );
    expect(discoveryPublishes.length).toBe(0);

    ctx.mqttService.publish.mockClear();
    await plugin.stop();

    const discoveryClearsOnStop = ctx.mqttService.publish.mock.calls.filter(
      ([t]) => isDiscoveryTopic(t),
    );
    expect(discoveryClearsOnStop.length).toBe(0);
  });

  it('Test 4 — D-LIFE-04: structure-monitor removal → discovery topics for the removed device are retain-cleared', async () => {
    await plugin.start(ctx);
    const poll = mockPollInstances[0];
    ctx.mqttService.publish.mockClear();

    poll.emit('devices-changed', {
      added: [],
      renamed: [],
      removed: [
        { mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main', model: 'USPM16P', type: 'usw', portCount: 2 },
      ],
      unchanged: 0,
    });

    const discoveryClears = ctx.mqttService.publish.mock.calls.filter(
      ([t, p, o]) => isDiscoveryTopic(t) && p === '' && o?.retain === true,
    );
    // Phase 13: 2 PoE ports × 10 entities = 20 discovery clears.
    expect(discoveryClears.length).toBe(2 * 10);
  });

  it('Test 5 — structure-monitor add → discovery republished for the new device set', async () => {
    await plugin.start(ctx);
    const poll = mockPollInstances[0];

    // Snapshot evolves: new device joins.
    poll._lastSnapshot.set('aa:bb:cc:dd:ee:ff', {
      mac: 'aa:bb:cc:dd:ee:ff',
      name: 'Switch2',
      nameSlug: 'switch2',
      model: 'USW8',
      type: 'usw',
      portCount: 1,
    });
    mockBehaviour.portTables.set('aa:bb:cc:dd:ee:ff', [
      { port_idx: 1, port_poe: true, name: 'P1' },
    ]);

    ctx.mqttService.publish.mockClear();

    poll.emit('devices-changed', {
      added: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'Switch2', nameSlug: 'switch2', model: 'USW8', type: 'usw', portCount: 1 }],
      renamed: [],
      removed: [],
      unchanged: 1,
    });

    // Phase 13: re-publish covers the FULL device set (both old + new), so we
    // expect 20 (old: 2 ports × 10) + 10 (new: 1 port × 10) = 30 fresh
    // discovery publishes; all non-empty + retained.
    const discoveryPublishes = ctx.mqttService.publish.mock.calls.filter(
      ([t]) => isDiscoveryTopic(t),
    );
    for (const [, p, o] of discoveryPublishes) {
      expect(p).not.toBe('');
      expect(o).toEqual({ retain: true });
    }
    expect(discoveryPublishes.length).toBe((2 + 1) * 10);
  });

  it('Test 6 — phase-boundary: bridge/status=online publish + cold-start subscribes still happen with haDiscovery=true (no regression)', async () => {
    await plugin.start(ctx);
    // bridge/status=online retained — exactly one publish.
    const bridgeOnline = ctx.mqttService.publish.mock.calls.find(
      ([t, p]) => /\/bridge\/status$/.test(t) && p === 'online',
    );
    expect(bridgeOnline).toBeDefined();
    expect(bridgeOnline[2]).toEqual({ retain: true });

    // Phase 9 cmd subscribes still wired (2 ports × 2 namespaces = 4).
    expect(ctx.mqttService.subscribe.mock.calls.length).toBe(2 * 2);
  });

  it('Test 7 — haDiscoveryPrefix override → discovery topics use the custom prefix', async () => {
    ctx = createMockContext({ haDiscoveryPrefix: 'custom-ha' });
    await plugin.start(ctx);

    const discoveryPublishes = ctx.mqttService.publish.mock.calls.filter(
      ([t]) => typeof t === 'string' && t.endsWith('/config'),
    );
    expect(discoveryPublishes.length).toBeGreaterThan(0);
    for (const [t] of discoveryPublishes) {
      expect(t.startsWith('custom-ha/')).toBe(true);
      expect(t.startsWith('homeassistant/')).toBe(false);
    }
  });
});
