/**
 * Phase-boundary regression tests — the dedicated safety net for Phase 8 ×
 * Phase 9. A future `git grep phase-boundary` surfaces this file as the
 * canonical place that asserts:
 *
 *   - Phase 9 subscribes ONLY to /cmd topics (never /state or /result)
 *   - port_overrides PUT and /cmd/devmgr POST are NEVER issued by passive
 *     lifecycle activity — they require an inbound cmd publish
 *   - retain-clear only targets /state topics, never /cmd
 *   - Phase 7 bridge/status retained semantics survive Phase 9 wiring
 *
 * Mirrors the live plugin against a UnifiClient mock (no real HTTP) and a
 * UnifiPoll real instance (so the plugin's diff handler runs against the
 * real diff path). Fake timers compress a 5-minute lifecycle into a
 * sub-second test.
 *
 * Each case maps to a CRITICAL invariant from PLAN 08-02 + 09-02:
 *   Test 1 — Every subscribe targets a /cmd topic (no /state/result subs)
 *   Test 2 — Zero PUT requests with port_overrides body across passive lifecycle
 *   Test 3 — Zero POST /cmd/devmgr calls across passive lifecycle
 *   Test 4 — Retain-clear only on /state topics, never /cmd
 *   Test 5 — Heartbeat staleness gates BEFORE republishing
 *   Test 6 — Phase 7 bridge/status retained contract preserved
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../fixtures/unifi/stat-device-3devices.json'),
    'utf8',
  ),
);

const { mockBehaviour, mockClientInstances, allRequests } = vi.hoisted(() => ({
  mockBehaviour: {
    checkUnifiOsResult: true,
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
  },
  mockClientInstances: [],
  allRequests: [],
}));

vi.mock('../../../plugins/unifi/unifi-client.js', async () => {
  const { EventEmitter } = await import('node:events');
  const AUTH_STATE = Object.freeze({ CONNECTED: 'connected', DISCONNECTED: 'disconnected' });

  class MockUnifiClient extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._state = { authState: AUTH_STATE.DISCONNECTED, authStateReason: null, lastCsrfRotationAt: null };
      this.checkUnifiOs = vi.fn(async () => mockBehaviour.checkUnifiOsResult);
      this.login = vi.fn(async () => { this._state.authState = AUTH_STATE.CONNECTED; });
      this.request = vi.fn(async (req) => {
        // Record every request for Test 2 + Test 3 to scan.
        allRequests.push({ ...req });
        const { method, path: p } = req;
        if (p === '/api/system') return mockBehaviour.sysinfoResult;
        if (typeof p === 'string' && p.endsWith('/stat/device')) return JSON.parse(JSON.stringify(FIXTURE));
        if (typeof p === 'string' && p.endsWith('/stat/sta')) return { data: [] };
        throw new Error(`Mock: unexpected ${method} ${p}`);
      });
      this.disconnect = vi.fn(async () => { this._state.authState = AUTH_STATE.DISCONNECTED; this.emit('disconnected'); });
      this.getStatus = vi.fn(() => ({ ...this._state }));
      mockClientInstances.push(this);
    }
  }
  return { UnifiClient: MockUnifiClient, AUTH_STATE };
});

const { default: UnifiPlugin } = await import('../../../plugins/unifi/plugin.js');

function createMockContext() {
  const config = {
    host: '192.0.2.1', username: 'mqtt-master', password: 'pw', site: 'default',
    pollDeviceListSec: 30, pollPortStateSec: 5, heartbeatSec: 60,
  };
  const subscribedTopics = [];
  return {
    mqttService: {
      publish: vi.fn(async () => {}),
      subscribe: vi.fn((topic) => {
        // Phase 9 subscribes /cmd topics. Hard fail if any subscribe targets
        // a /state or /result topic — those are publish-only.
        if (typeof topic === 'string' && (topic.endsWith('/state') || topic.endsWith('/result'))) {
          throw new Error(`PHASE BOUNDARY VIOLATION: subscribe to publish-only topic "${topic}"`);
        }
        subscribedTopics.push(topic);
      }),
      unsubscribe: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      _subscribedTopics: subscribedTopics,
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
  mockBehaviour.checkUnifiOsResult = true;
  mockBehaviour.sysinfoResult = { name: 'Gateway1', hostname: 'gateway1.example.com' };
  mockClientInstances.length = 0;
  allRequests.length = 0;
}

describe('UnifiPlugin — phase-boundary regression', () => {
  beforeEach(() => {
    resetMockBehaviour();
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
  });

  it('Test 1 — Every subscribe targets a /cmd topic; never /state or /result (Phase 9 invariant)', async () => {
    const plugin = new UnifiPlugin();
    const ctx = createMockContext();
    await plugin.start(ctx);

    // Exercise 5 minutes of timer activity.
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Some subscribes are EXPECTED in Phase 9 — but they must all be /cmd.
    expect(ctx.mqttService.subscribe).toHaveBeenCalled();
    for (const topic of ctx.mqttService._subscribedTopics) {
      expect(topic.endsWith('/cmd'), `Phase 9 must only subscribe /cmd topics; got: ${topic}`).toBe(true);
    }
    // And every cmd topic falls into either the slug or by-mac namespace.
    // Phase 13 adds gateway-only `/wan/cmd` alongside the per-port shape.
    for (const topic of ctx.mqttService._subscribedTopics) {
      const okPortShape = /^unifi-gateway1\/(by-mac\/[0-9a-f-]+|[^/]+)\/port\/\d+\/cmd$/.test(topic);
      const okWanShape = /^unifi-gateway1\/(by-mac\/[0-9a-f-]+|[^/]+)\/wan\/cmd$/.test(topic);
      expect(okPortShape || okWanShape, `cmd topic shape invalid: ${topic}`).toBe(true);
    }

    await plugin.stop();
  });

  it('Test 2 — Zero PUT requests with port_overrides body (Phase 9 work)', async () => {
    const plugin = new UnifiPlugin();
    const ctx = createMockContext();
    await plugin.start(ctx);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await plugin.stop();

    const offending = allRequests.find(
      (req) =>
        req.method === 'PUT' &&
        (
          (typeof req.path === 'string' && /\/rest\/device\//.test(req.path)) ||
          (req.body && Object.prototype.hasOwnProperty.call(req.body, 'port_overrides'))
        ),
    );
    expect(offending).toBeUndefined();
  });

  it('Test 3 — Zero POST /cmd/devmgr calls (Phase 9 work)', async () => {
    const plugin = new UnifiPlugin();
    const ctx = createMockContext();
    await plugin.start(ctx);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await plugin.stop();

    const offending = allRequests.find(
      (req) => req.method === 'POST' && typeof req.path === 'string' && req.path.includes('/cmd/devmgr'),
    );
    expect(offending).toBeUndefined();
  });

  it('Test 4 — CRITICAL: retain-clear ONLY targets /state topics, never /cmd', async () => {
    const plugin = new UnifiPlugin();
    const ctx = createMockContext();
    await plugin.start(ctx);

    // Trigger a synthetic rename via the real UnifiPoll on the plugin.
    // Grab the actual UnifiPoll instance from the plugin and emit a diff.
    const poll = plugin._poll;
    expect(poll).toBeDefined();

    ctx.mqttService.publish.mockClear();
    poll.emit('devices-changed', {
      added: [],
      renamed: [
        {
          mac: '02:00:00:00:00:fa',
          oldNameSlug: 'main-old',
          newNameSlug: 'main',
          entry: { mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main', model: 'USPM16P', type: 'usw', portCount: 18 },
        },
      ],
      removed: [
        { mac: '02:00:00:00:00:0e', name: 'Gateway1', nameSlug: 'gateway1', model: 'UCGMAX', type: 'udm', portCount: 5 },
      ],
      unchanged: 0,
    });

    const publishes = ctx.mqttService.publish.mock.calls;
    const empties = publishes.filter(([, payload]) => payload === '');
    expect(empties.length).toBeGreaterThan(0); // sanity — diff actually fired

    for (const [topic] of empties) {
      // Every retain-clear must end with /state (per-device + per-port) OR be a
      // Phase-11/13 HA Discovery topic ending in /config (clearDiscovery's
      // documented behaviour — entity removal). The CRITICAL invariant is the
      // /cmd negation below.
      const isStateTopic = topic.endsWith('/state');
      const isHaConfigTopic = topic.endsWith('/config');
      expect(isStateTopic || isHaConfigTopic,
        `Retain-clear MUST target /state or HA /config; got: ${topic}`).toBe(true);
      // And never include /cmd at any position.
      expect(topic.includes('/cmd'), `Retain-clear MUST NOT touch cmd; got: ${topic}`).toBe(false);
    }

    await plugin.stop();
  });

  it('Test 5 — Heartbeat staleness gates BEFORE republishing disconnected devices', async () => {
    const plugin = new UnifiPlugin();
    const ctx = createMockContext();
    await plugin.start(ctx);

    const client = mockClientInstances[0];
    // Drop the UAP from subsequent /stat/device responses.
    const reduced = JSON.parse(JSON.stringify(FIXTURE));
    const droppedDevice = reduced.data.find((d) => d.type === 'uap');
    reduced.data = reduced.data.filter((d) => d.type !== 'uap');
    client.request.mockImplementation(async (req) => {
      allRequests.push({ ...req });
      const { path: p } = req;
      if (p === '/api/system') return mockBehaviour.sysinfoResult;
      if (typeof p === 'string' && p.endsWith('/stat/device')) return reduced;
      if (typeof p === 'string' && p.endsWith('/stat/sta')) return { data: [] };
      throw new Error(`unexpected ${p}`);
    });

    // Advance past the device-list interval to update the snapshot.
    await vi.advanceTimersByTimeAsync(30_000);

    // Capture the publish set during the next heartbeat window only.
    ctx.mqttService.publish.mockClear();
    await vi.advanceTimersByTimeAsync(30_000); // total t≈60s → heartbeat fires

    const droppedMacSlug = droppedDevice.mac.toLowerCase().replace(/:/g, '-');
    const droppedSlug = 'u6-pro';

    const droppedPublishes = ctx.mqttService.publish.mock.calls.filter(
      ([t]) =>
        t.includes(`/${droppedSlug}/`) ||
        t.endsWith(`/${droppedSlug}/state`) ||
        t.includes(`/by-mac/${droppedMacSlug}/`) ||
        t.endsWith(`/by-mac/${droppedMacSlug}/state`),
    );

    // After D-H-02 staleness gating, the dropped device must NOT be heartbeat-republished.
    expect(droppedPublishes).toHaveLength(0);

    await plugin.stop();
  });

  it('Test 6 — Phase 7 bridge/status retained semantics preserved (online once, offline once)', async () => {
    const plugin = new UnifiPlugin();
    const ctx = createMockContext();

    await plugin.start(ctx);
    const onlinePublishes = ctx.mqttService.publish.mock.calls.filter(
      ([t, p]) => /\/bridge\/status$/.test(t) && p === 'online',
    );
    expect(onlinePublishes).toHaveLength(1);
    expect(onlinePublishes[0][2]).toEqual({ retain: true });

    ctx.mqttService.publish.mockClear();
    await plugin.stop();
    const offlinePublishes = ctx.mqttService.publish.mock.calls.filter(
      ([t, p]) => /\/bridge\/status$/.test(t) && p === 'offline',
    );
    expect(offlinePublishes).toHaveLength(1);
    expect(offlinePublishes[0][2]).toEqual({ retain: true });
  });
});
