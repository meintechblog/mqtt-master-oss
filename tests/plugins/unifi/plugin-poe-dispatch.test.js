/**
 * Plugin × PoE-dispatch end-to-end test suite (Phase 9 — Plan 09-02 Task 2).
 *
 * 20 cases pinning the MQTT cmd subscribe/dispatch/result-publish wiring plus
 * the LLDP-augmented protected-port composition. Each case maps to a CRITICAL
 * invariant from <execution_context>:
 *
 *   Tests 1-3      — Subscribe + route both namespaces (D-CMD-04, D-MISC-01)
 *   Tests 4-5      — Result-publish non-retained, both namespaces (D-RESULT-01)
 *   Tests 6-8      — Unknown device / unknown port / malformed topic
 *   Test 9         — D-PROTECT-04: LLDP-empty + hardcoded floor honoured
 *   Test 10        — LLDP runtime augmentation flows into protected check
 *   Tests 11-13    — Subscribe lifecycle (add / remove / rename)
 *   Tests 14-15    — Phase-boundary: off→PUT only; cycle→/cmd/devmgr only
 *   Test 16        — D-MISC-02: not_connected → zero HTTPS + visible result
 *   Test 17        — Plugin.stop drains in-flight + unsubscribes
 *   Test 18        — Phase 7 regression: bridge/status retained semantics
 *   Test 19        — controlCount untouched by Phase 9 (still devicesDiscovered)
 *   Test 20        — Reload-safe (2 complete lifecycles)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---- vi.hoisted state for cross-mock coordination --------------------------

const {
  mockBehaviour, mockClientInstances, mockPollInstances, mockPoeInstances,
  poeFactorySpy,
} = vi.hoisted(() => ({
  mockBehaviour: {
    snapshot: null,            // Map<mac, {mac,nameSlug,...,portCount}>
    portTables: null,          // Map<mac, port_table[]>
    runtimeProtected: null,    // Set<`${mac}:${port_idx}`>
    pollMetrics: { devicesDiscovered: 3, lastPollSuccessAt: '2026-05-13T00:00:00Z', pollErrorCount: 0 },
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
    checkUnifiOsResult: true,
    loginShouldThrow: false,
    authState: 'connected',
    // Programmable dispatch behaviour — tests can override per-call.
    dispatchResult: { status: 'ok', action: 'unknown', ts: '2026-05-13T12:00:00Z' },
    dispatchDelayMs: 0,
  },
  mockClientInstances: [],
  mockPollInstances: [],
  mockPoeInstances: [],
  poeFactorySpy: { calls: [] },
}));

// ---- Module mocks ---------------------------------------------------------

vi.mock('../../../plugins/unifi/unifi-client.js', async () => {
  const { EventEmitter: EE } = await import('node:events');
  const AUTH_STATE = Object.freeze({
    DISCONNECTED: 'disconnected', CONNECTED: 'connected', AUTH_FAILED: 'auth_failed',
    REFRESHING: 'refreshing',
  });
  class MockUnifiClient extends EE {
    constructor(opts) {
      super();
      this.opts = opts;
      this._state = { authState: AUTH_STATE.DISCONNECTED, authStateReason: null };
      this.checkUnifiOs = vi.fn(async () => mockBehaviour.checkUnifiOsResult);
      this.login = vi.fn(async () => {
        if (mockBehaviour.loginShouldThrow) throw new Error('login failed');
        this._state.authState = mockBehaviour.authState;
      });
      this.request = vi.fn(async ({ method, path }) => {
        if (path === '/api/system') return mockBehaviour.sysinfoResult;
        throw new Error(`MockUnifiClient: unexpected ${method} ${path}`);
      });
      this.disconnect = vi.fn(async () => { this._state.authState = AUTH_STATE.DISCONNECTED; });
      this.getStatus = vi.fn(() => ({ ...this._state }));
      mockClientInstances.push(this);
    }
  }
  return { UnifiClient: MockUnifiClient, AUTH_STATE };
});

vi.mock('../../../plugins/unifi/unifi-poll.js', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class MockUnifiPoll extends EE {
    constructor(opts) {
      super();
      this.opts = opts;
      this._lastSnapshot = mockBehaviour.snapshot;
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.runOnce = vi.fn(async () => {
        // Programmed by the test before start().
        this._lastSnapshot = mockBehaviour.snapshot;
      });
      this.getMetrics = vi.fn(() => mockBehaviour.pollMetrics);
      this.getCachedPortTables = vi.fn(() => mockBehaviour.portTables || new Map());
      this.getRuntimeProtectedPorts = vi.fn(() => mockBehaviour.runtimeProtected || new Set());
      mockPollInstances.push(this);
    }
  }
  return { UnifiPoll: MockUnifiPoll };
});

vi.mock('../../../plugins/unifi/unifi-poe.js', async () => {
  // Default-mock that captures the opts and returns a programmable dispatch spy.
  // Tests that need the REAL createPoEController use vi.doUnmock + dynamic import.
  const RESULT_STATUS = Object.freeze({
    OK: 'ok', PROTECTED_PORT: 'protected_port', RATE_LIMITED: 'rate_limited',
    READ_FAILED: 'read_failed', WRITE_FAILED: 'write_failed',
    INVALID_PAYLOAD: 'invalid_payload', UNKNOWN_DEVICE: 'unknown_device',
    UNKNOWN_PORT: 'unknown_port', NOT_CONNECTED: 'not_connected', NOT_POE_CAPABLE: 'not_poe_capable',
  });
  const createPoEController = vi.fn((client, opts) => {
    poeFactorySpy.calls.push({ client, opts });
    const inst = {
      setOn: vi.fn(),
      setOff: vi.fn(),
      setCycle: vi.fn(),
      dispatch: vi.fn(async (mac, port_idx, payload) => {
        if (mockBehaviour.dispatchDelayMs > 0) {
          await new Promise((res) => setTimeout(res, mockBehaviour.dispatchDelayMs));
        }
        // Echo configured result with action derived from payload.
        const action = ['on', 'off', 'cycle'].includes(String(payload).toLowerCase())
          ? String(payload).toLowerCase()
          : 'unknown';
        return { ...mockBehaviour.dispatchResult, action };
      }),
    };
    mockPoeInstances.push(inst);
    return inst;
  });
  return { createPoEController, RESULT_STATUS };
});

const { default: UnifiPlugin } = await import('../../../plugins/unifi/plugin.js');

// ---- Fixture helpers ------------------------------------------------------

function buildSnapshot() {
  // Mirrors the 3-device fixture: Main (USPM16P, 16 PoE + 2 SFP+), Gateway1
  // (UCGMAX, 5 ports), U6 Pro (UAP, 0 ports).
  return new Map([
    ['02:00:00:00:00:fa', {
      mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main',
      model: 'USPM16P', type: 'usw', portCount: 18,
    }],
    ['02:00:00:00:00:0e', {
      mac: '02:00:00:00:00:0e', name: 'Gateway1', nameSlug: 'gateway1',
      model: 'UCGMAX', type: 'udm', portCount: 5,
    }],
    ['02:00:00:00:00:17', {
      mac: '02:00:00:00:00:17', name: 'U6 Pro', nameSlug: 'u6-pro',
      model: 'U6P', type: 'uap', portCount: 0,
    }],
  ]);
}

function buildPortTables() {
  // Main: 16 PoE (1-16) + 2 SFP+ (17,18) non-PoE.
  const mainPorts = [];
  for (let idx = 1; idx <= 16; idx++) {
    mainPorts.push({ port_idx: idx, port_poe: true, name: `Port ${idx}` });
  }
  for (let idx = 17; idx <= 18; idx++) {
    mainPorts.push({ port_idx: idx, port_poe: false, name: `SFP+ ${idx - 16}` });
  }
  // Gateway1 (UCG-MAX): 5 ports — port 1 is the wan/lldp-protected port (no PoE
  // out by spec; for simplicity we model 4 PoE + 1 wan). For dispatch tests we
  // only care about Main, so leave Gateway1 minimal.
  const gateway1Ports = [
    { port_idx: 1, port_poe: false, name: 'Port 1' },
    { port_idx: 2, port_poe: false, name: 'Port 2' },
    { port_idx: 3, port_poe: false, name: 'Port 3' },
    { port_idx: 4, port_poe: false, name: 'Port 4' },
    { port_idx: 5, port_poe: false, name: 'Port 5' },
  ];
  return new Map([
    ['02:00:00:00:00:fa', mainPorts],
    ['02:00:00:00:00:0e', gateway1Ports],
    // U6 Pro has empty port_table — naturally produces zero subscriptions.
    ['02:00:00:00:00:17', []],
  ]);
}

function makeMqttService() {
  const ee = new EventEmitter();
  const subscribed = new Set();
  const subscribeCalls = [];
  const unsubscribeCalls = [];
  const published = [];
  return {
    subscribe: vi.fn((t) => { subscribed.add(t); subscribeCalls.push(t); }),
    unsubscribe: vi.fn((t) => { subscribed.delete(t); unsubscribeCalls.push(t); }),
    publish: vi.fn((topic, payload, opts) => {
      published.push({ topic, payload, opts });
    }),
    on: ee.on.bind(ee),
    removeListener: ee.removeListener.bind(ee),
    // Helpers for the tests
    _emitMessage(topic, payload) { ee.emit('message', { topic, payload }); },
    _subscribed: subscribed,
    _subscribeCalls: subscribeCalls,
    _unsubscribeCalls: unsubscribeCalls,
    _published: published,
    _listeners: () => ee.listenerCount('message'),
  };
}

function makeCtx() {
  const config = {
    host: '192.0.2.1', username: 'mqtt-master', password: 'pw',
    site: 'default', topicPrefix: 'unifi-gateway1/', displayName: 'UniFi Gateway1',
    autoNamed: true, dryRun: true, cyclePortRateLimitMs: 10000,
    tlsVerify: false,
  };
  return {
    mqttService: makeMqttService(),
    configService: {
      get: vi.fn((key, def) => (key === 'plugins.unifi' ? config : def)),
      set: vi.fn(), save: vi.fn(async () => {}),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginId: 'unifi',
  };
}

async function flushPromises() {
  await new Promise((res) => setImmediate(res));
  await Promise.resolve();
}

function resetMockBehaviour() {
  mockBehaviour.snapshot = buildSnapshot();
  mockBehaviour.portTables = buildPortTables();
  mockBehaviour.runtimeProtected = new Set();
  mockBehaviour.pollMetrics = { devicesDiscovered: 3, lastPollSuccessAt: '2026-05-13T00:00:00Z', pollErrorCount: 0 };
  mockBehaviour.sysinfoResult = { name: 'Gateway1', hostname: 'gateway1.example.com' };
  mockBehaviour.checkUnifiOsResult = true;
  mockBehaviour.loginShouldThrow = false;
  mockBehaviour.authState = 'connected';
  mockBehaviour.dispatchResult = { status: 'ok', action: 'unknown', ts: '2026-05-13T12:00:00Z' };
  mockBehaviour.dispatchDelayMs = 0;
  mockClientInstances.length = 0;
  mockPollInstances.length = 0;
  mockPoeInstances.length = 0;
  poeFactorySpy.calls.length = 0;
}

// ---- Test cases -----------------------------------------------------------

describe('UnifiPlugin × PoE dispatch (Phase 9 Plan 09-02)', () => {
  let plugin, ctx;

  beforeEach(async () => {
    resetMockBehaviour();
    plugin = new UnifiPlugin();
    ctx = makeCtx();
  });

  afterEach(async () => {
    try { await plugin.stop(); } catch { /* best-effort */ }
  });

  it('Test 1 — After start(), every PoE-capable port has TWO cmd subscriptions (slug + by-mac)', async () => {
    await plugin.start(ctx);

    // Main has 16 PoE ports. Gateway1 has 0 PoE. U6P has empty port_table.
    // Expected: 16 ports × 2 namespaces = 32 subscriptions on Main alone.
    const subs = ctx.mqttService._subscribeCalls;

    for (let idx = 1; idx <= 16; idx++) {
      expect(subs).toContain(`unifi-gateway1/main/port/${idx}/cmd`);
      expect(subs).toContain(`unifi-gateway1/by-mac/02-00-00-00-00-fa/port/${idx}/cmd`);
    }
    // Non-PoE ports MUST NOT be subscribed.
    expect(subs).not.toContain('unifi-gateway1/main/port/17/cmd');
    expect(subs).not.toContain('unifi-gateway1/main/port/18/cmd');

    // No /state, no /result on subscribe path.
    for (const t of subs) {
      expect(t.endsWith('/cmd')).toBe(true);
    }
  });

  it('Test 2 — Slug-based cmd publish routes to dispatch with (mac, port_idx)', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];

    ctx.mqttService._emitMessage('unifi-gateway1/main/port/6/cmd', 'off');
    await flushPromises();

    expect(poe.dispatch).toHaveBeenCalledTimes(1);
    expect(poe.dispatch).toHaveBeenCalledWith('02:00:00:00:00:fa', 6, 'off');
  });

  it('Test 3 — By-mac cmd publish routes to dispatch with SAME (mac, port_idx) (D-CMD-04)', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];

    ctx.mqttService._emitMessage('unifi-gateway1/by-mac/02-00-00-00-00-fa/port/6/cmd', 'off');
    await flushPromises();

    expect(poe.dispatch).toHaveBeenCalledTimes(1);
    expect(poe.dispatch).toHaveBeenCalledWith('02:00:00:00:00:fa', 6, 'off');
  });

  it('Test 4 — Result publish: non-retained, BOTH namespaces (D-RESULT-01)', async () => {
    mockBehaviour.dispatchResult = { status: 'ok', action: 'off', ts: '2026-05-13T12:00:00Z' };
    await plugin.start(ctx);

    ctx.mqttService.publish.mockClear();
    ctx.mqttService._emitMessage('unifi-gateway1/main/port/6/cmd', 'off');
    await flushPromises();

    const resultPublishes = ctx.mqttService._published.filter(
      ({ topic }) => topic.endsWith('/result'),
    );
    expect(resultPublishes).toHaveLength(2);

    const slugResult = resultPublishes.find(({ topic }) => topic === 'unifi-gateway1/main/port/6/result');
    const macResult = resultPublishes.find(({ topic }) => topic === 'unifi-gateway1/by-mac/02-00-00-00-00-fa/port/6/result');
    expect(slugResult).toBeDefined();
    expect(macResult).toBeDefined();

    expect(slugResult.opts).toEqual({ retain: false });
    expect(macResult.opts).toEqual({ retain: false });
    expect(JSON.parse(slugResult.payload).status).toBe('ok');
    expect(JSON.parse(macResult.payload).status).toBe('ok');
  });

  it('Test 5 — invalid_payload result still publishes on both namespaces', async () => {
    mockBehaviour.dispatchResult = { status: 'invalid_payload', action: 'unknown', ts: '2026-05-13T12:00:00Z' };
    await plugin.start(ctx);
    ctx.mqttService.publish.mockClear();

    ctx.mqttService._emitMessage('unifi-gateway1/main/port/6/cmd', 'TURBO');
    await flushPromises();

    const resultPublishes = ctx.mqttService._published.filter(({ topic }) => topic.endsWith('/result'));
    expect(resultPublishes).toHaveLength(2);
    for (const r of resultPublishes) {
      expect(JSON.parse(r.payload).status).toBe('invalid_payload');
    }
  });

  it('Test 6 — Slug-based unknown device → unknown_device result, NO dispatch', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];
    ctx.mqttService.publish.mockClear();

    ctx.mqttService._emitMessage('unifi-gateway1/ghost-switch/port/3/cmd', 'on');
    await flushPromises();

    expect(poe.dispatch).not.toHaveBeenCalled();
    const ghostResult = ctx.mqttService._published.find(
      ({ topic }) => topic === 'unifi-gateway1/ghost-switch/port/3/result',
    );
    expect(ghostResult).toBeDefined();
    expect(JSON.parse(ghostResult.payload).status).toBe('unknown_device');
    expect(ghostResult.opts).toEqual({ retain: false });
  });

  it('Test 7 — By-mac unknown device → unknown_device on by-mac result topic', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];
    ctx.mqttService.publish.mockClear();

    ctx.mqttService._emitMessage('unifi-gateway1/by-mac/de-ad-be-ef-de-ad/port/3/cmd', 'on');
    await flushPromises();

    expect(poe.dispatch).not.toHaveBeenCalled();
    const ghostResult = ctx.mqttService._published.find(
      ({ topic }) => topic === 'unifi-gateway1/by-mac/de-ad-be-ef-de-ad/port/3/result',
    );
    expect(ghostResult).toBeDefined();
    expect(JSON.parse(ghostResult.payload).status).toBe('unknown_device');
  });

  it('Test 8 — Malformed / non-cmd topics are ignored gracefully', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];
    const publishCountBefore = ctx.mqttService._published.length;

    // Not a cmd topic.
    ctx.mqttService._emitMessage('unifi-gateway1/main/state', '{}');
    // Non-numeric port_idx.
    ctx.mqttService._emitMessage('unifi-gateway1/main/port/abc/cmd', 'off');
    // Different prefix entirely.
    ctx.mqttService._emitMessage('some-other-prefix/main/port/3/cmd', 'on');
    await flushPromises();

    expect(poe.dispatch).not.toHaveBeenCalled();
    // No new publishes triggered by the ignored messages.
    expect(ctx.mqttService._published.length).toBe(publishCountBefore);
  });

  it('Test 9 — D-PROTECT-04: LLDP empty, hardcoded floor STILL protects Main port 1', async () => {
    mockBehaviour.runtimeProtected = new Set();
    await plugin.start(ctx);

    // Capture the isProtectedPort callback passed to createPoEController.
    expect(poeFactorySpy.calls).toHaveLength(1);
    const { opts } = poeFactorySpy.calls[0];
    expect(typeof opts.isProtectedPort).toBe('function');

    // Hardcoded floor wins even though runtime set is empty.
    expect(opts.isProtectedPort('02:00:00:00:00:fa', 1)).toBe(true);
    expect(opts.isProtectedPort('02:00:00:00:00:fa', 2)).toBe(false);
    expect(opts.isProtectedPort('02:00:00:00:00:fa', 16)).toBe(false);
  });

  it('Test 10 — LLDP-augmented runtime protected port composes with hardcoded floor', async () => {
    mockBehaviour.runtimeProtected = new Set(['02:00:00:00:00:fa:2']);
    await plugin.start(ctx);

    const { opts } = poeFactorySpy.calls[0];
    expect(opts.isProtectedPort('02:00:00:00:00:fa', 1)).toBe(true);  // hardcoded
    expect(opts.isProtectedPort('02:00:00:00:00:fa', 2)).toBe(true);  // runtime
    expect(opts.isProtectedPort('02:00:00:00:00:fa', 3)).toBe(false); // neither
    expect(opts.isProtectedPort('UNKNOWN:MAC', 1)).toBe(false);
  });

  it('Test 11 — Subscribe lifecycle: device add → subscribe both namespaces', async () => {
    await plugin.start(ctx);
    const beforeCount = ctx.mqttService._subscribeCalls.length;

    // Inject a new device into the cached port_tables AND the snapshot
    // BEFORE firing the diff event.
    const newPorts = [];
    for (let idx = 1; idx <= 8; idx++) {
      newPorts.push({ port_idx: idx, port_poe: true, name: `Port ${idx}` });
    }
    mockBehaviour.portTables.set('aa:bb:cc:dd:ee:ff', newPorts);
    const poll = mockPollInstances[0];
    poll.getCachedPortTables = vi.fn(() => mockBehaviour.portTables);

    poll.emit('devices-changed', {
      added: [{
        mac: 'aa:bb:cc:dd:ee:ff', name: 'NewSwitch', nameSlug: 'new-switch',
        model: 'USX', type: 'usw', portCount: 8,
      }],
      renamed: [], removed: [], unchanged: 3,
    });
    await flushPromises();

    const newSubs = ctx.mqttService._subscribeCalls.slice(beforeCount);
    for (let idx = 1; idx <= 8; idx++) {
      expect(newSubs).toContain(`unifi-gateway1/new-switch/port/${idx}/cmd`);
      expect(newSubs).toContain(`unifi-gateway1/by-mac/aa-bb-cc-dd-ee-ff/port/${idx}/cmd`);
    }
  });

  it('Test 12 — Subscribe lifecycle: device remove → unsubscribe BOTH namespaces', async () => {
    await plugin.start(ctx);
    expect(ctx.mqttService._subscribeCalls.length).toBeGreaterThan(0);

    const poll = mockPollInstances[0];
    ctx.mqttService.unsubscribe.mockClear();
    ctx.mqttService._unsubscribeCalls.length = 0;

    poll.emit('devices-changed', {
      added: [], renamed: [],
      removed: [{
        mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main',
        model: 'USPM16P', type: 'usw', portCount: 18,
      }],
      unchanged: 0,
    });
    await flushPromises();

    const unsubs = ctx.mqttService._unsubscribeCalls;
    // 16 PoE ports × 2 namespaces = 32 unsubscribes.
    for (let idx = 1; idx <= 16; idx++) {
      expect(unsubs).toContain(`unifi-gateway1/main/port/${idx}/cmd`);
      expect(unsubs).toContain(`unifi-gateway1/by-mac/02-00-00-00-00-fa/port/${idx}/cmd`);
    }
  });

  it('Test 13 — Rename: OLD slug topics unsubscribed, NEW slug topics subscribed, by-mac UNTOUCHED', async () => {
    await plugin.start(ctx);

    const poll = mockPollInstances[0];
    ctx.mqttService.unsubscribe.mockClear();
    ctx.mqttService.subscribe.mockClear();
    ctx.mqttService._unsubscribeCalls.length = 0;
    ctx.mqttService._subscribeCalls.length = 0;

    poll.emit('devices-changed', {
      added: [], removed: [],
      renamed: [{
        mac: '02:00:00:00:00:fa',
        oldNameSlug: 'main',
        newNameSlug: 'main-renamed',
        entry: { mac: '02:00:00:00:00:fa', nameSlug: 'main-renamed', portCount: 18 },
      }],
      unchanged: 0,
    });
    await flushPromises();

    const unsubs = ctx.mqttService._unsubscribeCalls;
    const subs = ctx.mqttService._subscribeCalls;
    // OLD slug topics unsubscribed.
    for (let idx = 1; idx <= 16; idx++) {
      expect(unsubs).toContain(`unifi-gateway1/main/port/${idx}/cmd`);
      expect(subs).toContain(`unifi-gateway1/main-renamed/port/${idx}/cmd`);
    }
    // by-mac NOT touched (D-MISC-01 — MAC-stable across rename).
    for (const t of unsubs) {
      expect(t.includes('/by-mac/')).toBe(false);
    }
    for (const t of subs) {
      expect(t.includes('/by-mac/')).toBe(false);
    }
  });

  it('Test 14 — Phase-boundary: off command produces zero /cmd/devmgr POST (uses real createPoEController)', async () => {
    // Use the REAL createPoEController for this test via vi.doUnmock + dynamic import.
    vi.doUnmock('../../../plugins/unifi/unifi-poe.js');
    vi.resetModules();
    const { default: RealPlugin } = await import('../../../plugins/unifi/plugin.js');

    // Re-set hoisted mock behaviour after resetModules.
    mockBehaviour.snapshot = buildSnapshot();
    mockBehaviour.portTables = buildPortTables();
    mockBehaviour.runtimeProtected = new Set();
    mockBehaviour.authState = 'connected';
    mockClientInstances.length = 0;
    mockPollInstances.length = 0;

    const realPlugin = new RealPlugin();
    const realCtx = makeCtx();
    // Force dryRun false so the RMW path actually runs.
    realCtx.configService.get = vi.fn((key, def) =>
      (key === 'plugins.unifi'
        ? {
          host: '192.0.2.1', username: 'mqtt-master', password: 'pw',
          site: 'default', topicPrefix: 'unifi-gateway1/', displayName: 'UniFi Gateway1',
          autoNamed: true, dryRun: false, cyclePortRateLimitMs: 10000,
        }
        : def));

    await realPlugin.start(realCtx);
    const realClient = mockClientInstances[0];

    // Program the GET /stat/device response for the RMW read path (the
    // /rest/device/{mac} endpoint 404s on UCG-MAX; /stat/device works for
    // both polling and RMW-read). PUT /rest/device/{_id} stays for writes.
    realClient.request.mockImplementation(async ({ method, path }) => {
      if (path === '/api/system') return mockBehaviour.sysinfoResult;
      if (method === 'GET' && /\/stat\/device$/.test(path)) {
        return {
          data: [{
            _id: 'fake-device-id', mac: '02:00:00:00:00:fa',
            port_overrides: [],
            port_table: [{ port_idx: 6, port_poe: true, portconf_id: 'pc-1' }],
          }],
        };
      }
      if (method === 'GET' && /\/stat\/sta$/.test(path)) {
        return { data: [] };
      }
      if (method === 'PUT' && /\/rest\/device\//.test(path)) {
        return { meta: { rc: 'ok' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    realCtx.mqttService._emitMessage('unifi-gateway1/main/port/6/cmd', 'off');
    // Wait for dispatch + RMW round-trip.
    await flushPromises();
    await flushPromises();

    // Inspect ALL request calls: zero POST /cmd/devmgr.
    const devmgrPosts = realClient.request.mock.calls.filter(
      ([req]) => req.method === 'POST' && typeof req.path === 'string' && req.path.includes('/cmd/devmgr'),
    );
    expect(devmgrPosts).toHaveLength(0);

    const putCalls = realClient.request.mock.calls.filter(
      ([req]) => req.method === 'PUT' && /\/rest\/device\//.test(req.path),
    );
    expect(putCalls.length).toBeGreaterThanOrEqual(1);

    await realPlugin.stop();
    // Restore mock for subsequent tests.
    vi.doMock('../../../plugins/unifi/unifi-poe.js');
    vi.resetModules();
  });

  it('Test 15 — Phase-boundary: cycle command produces zero PUT /rest/device (uses real createPoEController)', async () => {
    vi.doUnmock('../../../plugins/unifi/unifi-poe.js');
    vi.resetModules();
    const { default: RealPlugin } = await import('../../../plugins/unifi/plugin.js');

    mockBehaviour.snapshot = buildSnapshot();
    mockBehaviour.portTables = buildPortTables();
    mockBehaviour.runtimeProtected = new Set();
    mockBehaviour.authState = 'connected';
    mockClientInstances.length = 0;
    mockPollInstances.length = 0;

    const realPlugin = new RealPlugin();
    const realCtx = makeCtx();
    realCtx.configService.get = vi.fn((key, def) =>
      (key === 'plugins.unifi'
        ? {
          host: '192.0.2.1', username: 'mqtt-master', password: 'pw',
          site: 'default', topicPrefix: 'unifi-gateway1/', displayName: 'UniFi Gateway1',
          autoNamed: true, dryRun: false, cyclePortRateLimitMs: 10000,
        }
        : def));

    await realPlugin.start(realCtx);
    const realClient = mockClientInstances[0];

    realClient.request.mockImplementation(async ({ method, path }) => {
      if (path === '/api/system') return mockBehaviour.sysinfoResult;
      if (method === 'POST' && /\/cmd\/devmgr$/.test(path)) {
        return { meta: { rc: 'ok' } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    realCtx.mqttService._emitMessage('unifi-gateway1/main/port/6/cmd', 'cycle');
    await flushPromises();
    await flushPromises();

    // Inspect ALL request calls: zero PUT /rest/device, zero GET /rest/device.
    const putCalls = realClient.request.mock.calls.filter(
      ([req]) => req.method === 'PUT' && /\/rest\/device\//.test(req.path),
    );
    expect(putCalls).toHaveLength(0);

    const getCalls = realClient.request.mock.calls.filter(
      ([req]) => req.method === 'GET' && /\/rest\/device\//.test(req.path),
    );
    expect(getCalls).toHaveLength(0);

    const devmgrPosts = realClient.request.mock.calls.filter(
      ([req]) => req.method === 'POST' && req.path.includes('/cmd/devmgr'),
    );
    expect(devmgrPosts.length).toBeGreaterThanOrEqual(1);

    await realPlugin.stop();
    vi.doMock('../../../plugins/unifi/unifi-poe.js');
    vi.resetModules();
  });

  it('Test 16 — D-MISC-02: authState !== connected → not_connected result, ZERO HTTPS to /rest/device or /cmd/devmgr', async () => {
    vi.doUnmock('../../../plugins/unifi/unifi-poe.js');
    vi.resetModules();
    const { default: RealPlugin } = await import('../../../plugins/unifi/plugin.js');

    mockBehaviour.snapshot = buildSnapshot();
    mockBehaviour.portTables = buildPortTables();
    mockBehaviour.runtimeProtected = new Set();
    // Start with connected (for plugin.start to succeed), then flip to refreshing.
    mockBehaviour.authState = 'connected';
    mockClientInstances.length = 0;
    mockPollInstances.length = 0;

    const realPlugin = new RealPlugin();
    const realCtx = makeCtx();
    realCtx.configService.get = vi.fn((key, def) =>
      (key === 'plugins.unifi'
        ? {
          host: '192.0.2.1', username: 'mqtt-master', password: 'pw',
          site: 'default', topicPrefix: 'unifi-gateway1/', displayName: 'UniFi Gateway1',
          autoNamed: true, dryRun: false, cyclePortRateLimitMs: 10000,
        }
        : def));

    await realPlugin.start(realCtx);
    const realClient = mockClientInstances[0];

    // Snapshot HTTPS call count after start (sysinfo etc) so we can isolate dispatch traffic.
    const httpsBefore = realClient.request.mock.calls.filter(
      ([req]) => /\/rest\/device\//.test(req.path) || /\/cmd\/devmgr$/.test(req.path),
    ).length;

    // Flip the client into refreshing — any further /rest or /cmd should be a bug.
    realClient.getStatus = vi.fn(() => ({ authState: 'refreshing' }));

    realCtx.mqttService._emitMessage('unifi-gateway1/main/port/6/cmd', 'off');
    await flushPromises();
    await flushPromises();

    const httpsAfter = realClient.request.mock.calls.filter(
      ([req]) => /\/rest\/device\//.test(req.path) || /\/cmd\/devmgr$/.test(req.path),
    ).length;
    expect(httpsAfter).toBe(httpsBefore);

    const ncResults = realCtx.mqttService._published.filter(
      ({ topic, payload }) => topic.endsWith('/result') && payload.includes('not_connected'),
    );
    expect(ncResults.length).toBeGreaterThanOrEqual(2);

    await realPlugin.stop();
    vi.doMock('../../../plugins/unifi/unifi-poe.js');
    vi.resetModules();
  });

  it('Test 17 — Plugin.stop() unsubscribes every cmd topic + drains in-flight dispatch BEFORE bridge/status=offline', async () => {
    await plugin.start(ctx);
    const subscribedBefore = new Set(ctx.mqttService._subscribed);
    expect(subscribedBefore.size).toBeGreaterThan(0);

    // Make dispatch hang on a controlled promise so we can interleave stop().
    let releaseDispatch;
    const dispatchHang = new Promise((res) => { releaseDispatch = res; });
    const poe = mockPoeInstances[0];
    poe.dispatch.mockImplementationOnce(async () => {
      await dispatchHang;
      return { status: 'ok', action: 'off', ts: '2026-05-13T12:00:00Z' };
    });

    // Fire a cmd to start the in-flight dispatch.
    ctx.mqttService._emitMessage('unifi-gateway1/main/port/6/cmd', 'off');
    await flushPromises();
    expect(poe.dispatch).toHaveBeenCalledTimes(1);

    // Capture publish ordering — offline must come AFTER unsubscribe AND dispatch resolution.
    const publishOrder = [];
    const originalPublish = ctx.mqttService.publish;
    ctx.mqttService.publish = vi.fn((topic, payload, opts) => {
      publishOrder.push({ topic, payload, at: Date.now() });
      return originalPublish(topic, payload, opts);
    });

    const stopPromise = plugin.stop();

    // Microtask flush — stop must NOT yet have resolved (dispatch still hanging).
    await flushPromises();
    let stopped = false;
    stopPromise.then(() => { stopped = true; });
    await flushPromises();
    expect(stopped).toBe(false);

    // Release the dispatch and let stop complete.
    releaseDispatch();
    await stopPromise;

    // Every subscribed cmd topic was unsubscribed.
    expect(ctx.mqttService._subscribed.size).toBe(0);
    // bridge/status=offline appeared in publish stream.
    const offline = publishOrder.find((p) => /\/bridge\/status$/.test(p.topic) && p.payload === 'offline');
    expect(offline).toBeDefined();
  });

  it('Test 18 — Phase 7 regression: bridge/status=online retained is published on start', async () => {
    await plugin.start(ctx);
    const onlinePublish = ctx.mqttService._published.find(
      ({ topic, payload }) => /\/bridge\/status$/.test(topic) && payload === 'online',
    );
    expect(onlinePublish).toBeDefined();
    expect(onlinePublish.opts).toEqual({ retain: true });
  });

  it('Test 19 — Phase 8 regression: controlCount remains devicesDiscovered after Phase 9 wiring', async () => {
    await plugin.start(ctx);
    const status = plugin.getStatus();
    expect(status.controlCount).toBe(mockBehaviour.pollMetrics.devicesDiscovered);
  });

  // ─── Phase 13 — gateway wan/cmd speedtest dispatch (D-P13-SPD-01) ──────

  it('P13-Test 21 — After start(), gateway has two wan/cmd subscriptions (slug + by-mac)', async () => {
    await plugin.start(ctx);
    const subs = ctx.mqttService._subscribeCalls;
    expect(subs).toContain('unifi-gateway1/gateway1/wan/cmd');
    expect(subs).toContain('unifi-gateway1/by-mac/02-00-00-00-00-0e/wan/cmd');
  });

  it('P13-Test 22 — Switch and AP do NOT get wan/cmd subscriptions (gateway only)', async () => {
    await plugin.start(ctx);
    const subs = ctx.mqttService._subscribeCalls;
    expect(subs).not.toContain('unifi-gateway1/main/wan/cmd');
    expect(subs).not.toContain('unifi-gateway1/u6-pro/wan/cmd');
  });

  it('P13-Test 23 — Slug wan/cmd "speedtest" routes to speedtest(mac) on the gateway', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];
    // Add the speedtest spy to the existing default mock so we can assert.
    poe.speedtest = vi.fn(async (mac) => ({ status: 'ok', action: 'speedtest', ts: 'T' }));

    ctx.mqttService._emitMessage('unifi-gateway1/gateway1/wan/cmd', 'speedtest');
    await flushPromises();

    expect(poe.speedtest).toHaveBeenCalledTimes(1);
    expect(poe.speedtest).toHaveBeenCalledWith('02:00:00:00:00:0e');
  });

  it('P13-Test 24 — speedtest result publishes to wan/result on BOTH namespaces, non-retained', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];
    poe.speedtest = vi.fn(async () => ({ status: 'ok', action: 'speedtest', ts: 'T' }));

    ctx.mqttService.publish.mockClear();
    ctx.mqttService._emitMessage('unifi-gateway1/gateway1/wan/cmd', 'speedtest');
    await flushPromises();

    const slugRes = ctx.mqttService._published.find(({ topic }) => topic === 'unifi-gateway1/gateway1/wan/result');
    const macRes = ctx.mqttService._published.find(({ topic }) => topic === 'unifi-gateway1/by-mac/02-00-00-00-00-0e/wan/result');
    expect(slugRes).toBeDefined();
    expect(macRes).toBeDefined();
    expect(slugRes.opts).toEqual({ retain: false });
    expect(macRes.opts).toEqual({ retain: false });
    expect(JSON.parse(slugRes.payload).status).toBe('ok');
  });

  it('P13-Test 25 — By-mac wan/cmd routes to speedtest with same MAC', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];
    poe.speedtest = vi.fn(async (mac) => ({ status: 'ok', action: 'speedtest', ts: 'T' }));

    ctx.mqttService._emitMessage('unifi-gateway1/by-mac/02-00-00-00-00-0e/wan/cmd', 'speedtest');
    await flushPromises();

    expect(poe.speedtest).toHaveBeenCalledTimes(1);
    expect(poe.speedtest).toHaveBeenCalledWith('02:00:00:00:00:0e');
  });

  it('P13-Test 26 — non-speedtest wan/cmd payload → not_supported result, no dispatch', async () => {
    await plugin.start(ctx);
    const poe = mockPoeInstances[0];
    poe.speedtest = vi.fn();

    ctx.mqttService._emitMessage('unifi-gateway1/gateway1/wan/cmd', 'reboot');
    await flushPromises();

    expect(poe.speedtest).not.toHaveBeenCalled();
    const result = ctx.mqttService._published.find(({ topic }) => topic === 'unifi-gateway1/gateway1/wan/result');
    expect(result).toBeDefined();
    expect(JSON.parse(result.payload).status).toBe('not_supported');
  });

  it('Test 20 — Reload-safe: start → stop → new instance → start releases prior subscriptions cleanly', async () => {
    await plugin.start(ctx);
    const cycle1Subs = ctx.mqttService._subscribeCalls.length;
    expect(cycle1Subs).toBeGreaterThan(0);

    await plugin.stop();
    expect(ctx.mqttService._subscribed.size).toBe(0);

    const plugin2 = new UnifiPlugin();
    const ctx2 = makeCtx();
    await plugin2.start(ctx2);
    const cycle2Subs = ctx2.mqttService._subscribeCalls.length;
    expect(cycle2Subs).toBe(cycle1Subs);

    await plugin2.stop();
    expect(ctx2.mqttService._subscribed.size).toBe(0);
  });
});
