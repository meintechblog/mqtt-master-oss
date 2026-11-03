/**
 * UnifiPlugin multi-instance isolation tests.
 *
 * Phase 11 Plan 11-02 — pins D-MI-01..D-MI-03:
 *   - D-MI-01: two plugin instances with distinct ids + topic prefixes maintain
 *              independent UnifiClient / UnifiPoll / state (no shared module
 *              singletons; each instance has its own snapshot, port-table cache,
 *              subscribe set, dispatch queue)
 *   - D-MI-02: HA Discovery entities published by instance A do NOT collide
 *              with instance B even when both point at the SAME MAC (the
 *              unique_id + device.identifiers carry the instanceId)
 *   - D-MI-03: stopping one instance does not affect the other's bridge
 *              availability or in-memory state
 *
 * Reuses the discovery-lifecycle mock surface: MockUnifiClient + MockUnifiPoll
 * (each plugin instance gets a fresh client + poll).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBehaviour, mockClientInstances, mockPollInstances } = vi.hoisted(() => ({
  mockBehaviour: {
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
    pollMetrics: { devicesDiscovered: 1, lastPollSuccessAt: '2026-05-13T00:00:00Z', pollErrorCount: 0 },
    snapshot: new Map([
      ['02:00:00:00:00:fa', {
        mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main',
        model: 'USPM16P', type: 'usw', portCount: 1,
      }],
    ]),
    portTables: new Map([
      ['02:00:00:00:00:fa', [{ port_idx: 1, port_poe: true, name: 'Port 1' }]],
    ]),
  },
  mockClientInstances: [],
  mockPollInstances: [],
}));

vi.mock('../../../plugins/unifi/unifi-client.js', async () => {
  const { EventEmitter } = await import('node:events');
  const AUTH_STATE = Object.freeze({ CONNECTED: 'connected', DISCONNECTED: 'disconnected' });
  class MockUnifiClient extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._state = { authState: AUTH_STATE.DISCONNECTED, authStateReason: null };
      this.checkUnifiOs = vi.fn(async () => true);
      this.login = vi.fn(async () => { this._state.authState = AUTH_STATE.CONNECTED; });
      this.request = vi.fn(async ({ path }) => {
        if (path === '/api/system') return mockBehaviour.sysinfoResult;
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
      // Each poll instance gets its OWN snapshot Map (clone), so mutations
      // by one instance do not leak into another's view — this is what
      // D-MI-01 demands and what we explicitly assert in Test 1.
      this._lastSnapshot = new Map(mockBehaviour.snapshot);
      this._portTables = new Map(mockBehaviour.portTables);
      this.runOnce = vi.fn(async () => {});
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.getMetrics = vi.fn(() => mockBehaviour.pollMetrics);
      this.getStructureSummary = vi.fn(() => ({ devices: [] }));
      this.getCachedPortTables = vi.fn(() => new Map(this._portTables));
      this.getRuntimeProtectedPorts = vi.fn(() => new Set());
      mockPollInstances.push(this);
    }
  }
  return { UnifiPoll: MockUnifiPoll };
});

const { default: UnifiPlugin } = await import('../../../plugins/unifi/plugin.js');

function createMockContext(pluginId, configOverrides = {}) {
  const config = {
    host: '192.0.2.1', username: 'admin', password: 'pw',
    site: 'default', tlsVerify: false,
    // Manual prefix so the two instances don't both auto-derive to the same name.
    topicPrefix: configOverrides.topicPrefix || `${pluginId}/`,
    autoNamed: false,
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
      get: vi.fn((key, def) => (key === `plugins.${pluginId}` ? config : def)),
      set: vi.fn(),
      save: vi.fn(async () => {}),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginId,
    _config: config,
  };
}

function reset() {
  mockClientInstances.length = 0;
  mockPollInstances.length = 0;
}

const isDiscoveryTopic = (t) =>
  typeof t === 'string' && t.startsWith('homeassistant/') && t.endsWith('/config');

describe('UnifiPlugin multi-instance isolation (D-MI-01..D-MI-03)', () => {
  beforeEach(reset);

  it('Test 1 — D-MI-01: two instances have independent UnifiClient + UnifiPoll references (no shared singletons)', async () => {
    const pluginA = new UnifiPlugin();
    const pluginB = new UnifiPlugin();
    const ctxA = createMockContext('unifi-dev');
    const ctxB = createMockContext('unifi-prod');

    await pluginA.start(ctxA);
    await pluginB.start(ctxB);

    expect(mockClientInstances.length).toBe(2);
    expect(mockPollInstances.length).toBe(2);

    // Distinct object references — no module-level singleton accidentally
    // shared across instances.
    expect(pluginA._client).not.toBe(pluginB._client);
    expect(pluginA._poll).not.toBe(pluginB._poll);

    // Per-instance subscribed-topic Set is independent.
    expect(pluginA._subscribedTopics).not.toBe(pluginB._subscribedTopics);
    expect(pluginA._lastHaDevices).not.toBe(pluginB._lastHaDevices);

    // Each instance owns a poll whose snapshot map is a fresh clone.
    expect(pluginA._poll._lastSnapshot).not.toBe(pluginB._poll._lastSnapshot);

    await pluginA.stop();
    await pluginB.stop();
  });

  it('Test 2 — D-MI-02: discovery unique_id values from two instances DO NOT collide (same MAC, different instanceIds)', async () => {
    const pluginA = new UnifiPlugin();
    const pluginB = new UnifiPlugin();
    const ctxA = createMockContext('unifi-dev', { topicPrefix: 'unifi-dev/' });
    const ctxB = createMockContext('unifi-prod', { topicPrefix: 'unifi-prod/' });

    await pluginA.start(ctxA);
    await pluginB.start(ctxB);

    const aIds = new Set();
    const aDeviceIds = new Set();
    for (const [t, p] of ctxA.mqttService.publish.mock.calls) {
      if (!isDiscoveryTopic(t)) continue;
      const cfg = JSON.parse(p);
      aIds.add(cfg.unique_id);
      aDeviceIds.add(cfg.device.identifiers[0]);
    }
    const bIds = new Set();
    const bDeviceIds = new Set();
    for (const [t, p] of ctxB.mqttService.publish.mock.calls) {
      if (!isDiscoveryTopic(t)) continue;
      const cfg = JSON.parse(p);
      bIds.add(cfg.unique_id);
      bDeviceIds.add(cfg.device.identifiers[0]);
    }

    expect(aIds.size).toBeGreaterThan(0);
    expect(bIds.size).toBe(aIds.size);
    // No unique_id overlap.
    for (const id of aIds) {
      expect(bIds.has(id)).toBe(false);
    }
    // device.identifiers — distinct device cards in HA per instance.
    expect(aDeviceIds.size).toBe(1);
    expect(bDeviceIds.size).toBe(1);
    const [aId] = aDeviceIds;
    const [bId] = bDeviceIds;
    expect(aId).not.toBe(bId);
    expect(aId.includes('unifi-dev')).toBe(true);
    expect(bId.includes('unifi-prod')).toBe(true);

    await pluginA.stop();
    await pluginB.stop();
  });

  it('Test 3 — D-MI-03: stopping instance A does not touch instance B mqttService nor its in-memory state', async () => {
    const pluginA = new UnifiPlugin();
    const pluginB = new UnifiPlugin();
    const ctxA = createMockContext('unifi-dev', { topicPrefix: 'unifi-dev/' });
    const ctxB = createMockContext('unifi-prod', { topicPrefix: 'unifi-prod/' });

    await pluginA.start(ctxA);
    await pluginB.start(ctxB);

    const bPublishesBeforeAStop = ctxB.mqttService.publish.mock.calls.length;
    const bSubscribedBefore = pluginB._subscribedTopics.size;
    const bHaDevicesBefore = pluginB._lastHaDevices.size;

    await pluginA.stop();

    // B mqttService received ZERO new calls during A's shutdown.
    expect(ctxB.mqttService.publish.mock.calls.length).toBe(bPublishesBeforeAStop);
    // B's in-memory state untouched.
    expect(pluginB._subscribedTopics.size).toBe(bSubscribedBefore);
    expect(pluginB._lastHaDevices.size).toBe(bHaDevicesBefore);
    // B is still running.
    expect(pluginB._running).toBe(true);

    await pluginB.stop();
  });

  it('Test 4 — D-MI-01: each instance subscribes its OWN cmd topics on its OWN mqttService (no cross-talk)', async () => {
    const pluginA = new UnifiPlugin();
    const pluginB = new UnifiPlugin();
    const ctxA = createMockContext('unifi-dev', { topicPrefix: 'unifi-dev/' });
    const ctxB = createMockContext('unifi-prod', { topicPrefix: 'unifi-prod/' });

    await pluginA.start(ctxA);
    await pluginB.start(ctxB);

    // Each instance subscribes exactly 2 topics (slug-cmd + by-mac-cmd) for
    // its 1 PoE port. Critically, every A subscribe carries the unifi-dev/
    // prefix and every B subscribe carries unifi-prod/.
    const aSubs = ctxA.mqttService.subscribe.mock.calls.map(([t]) => t);
    const bSubs = ctxB.mqttService.subscribe.mock.calls.map(([t]) => t);
    expect(aSubs.length).toBe(2);
    expect(bSubs.length).toBe(2);
    for (const t of aSubs) {
      expect(t.startsWith('unifi-dev/')).toBe(true);
      expect(t.startsWith('unifi-prod/')).toBe(false);
    }
    for (const t of bSubs) {
      expect(t.startsWith('unifi-prod/')).toBe(true);
      expect(t.startsWith('unifi-dev/')).toBe(false);
    }

    await pluginA.stop();
    await pluginB.stop();
  });

  it('Test 5 — each instance publishes its OWN bridge/status to its OWN prefix (no shared bridge topic)', async () => {
    const pluginA = new UnifiPlugin();
    const pluginB = new UnifiPlugin();
    const ctxA = createMockContext('unifi-dev', { topicPrefix: 'unifi-dev/' });
    const ctxB = createMockContext('unifi-prod', { topicPrefix: 'unifi-prod/' });

    await pluginA.start(ctxA);
    await pluginB.start(ctxB);

    const aBridge = ctxA.mqttService.publish.mock.calls.find(
      ([t]) => /\/bridge\/status$/.test(t),
    );
    const bBridge = ctxB.mqttService.publish.mock.calls.find(
      ([t]) => /\/bridge\/status$/.test(t),
    );
    expect(aBridge[0]).toBe('unifi-dev/bridge/status');
    expect(bBridge[0]).toBe('unifi-prod/bridge/status');
    expect(aBridge[1]).toBe('online');
    expect(bBridge[1]).toBe('online');

    await pluginA.stop();
    await pluginB.stop();
  });
});
