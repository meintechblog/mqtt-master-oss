/**
 * Plan 10-01 — getStatus().protectedPorts surface + refreshStructure() hook.
 *
 * Six focused cases pin the contract documented in the plan's <behavior> block:
 *   1. Hardcoded floor (PROTECTED_PORTS) always present, every entry source='hardcoded'.
 *   2. LLDP-augmented runtime entries surface with source='lldp'.
 *   3. Dedup — hardcoded wins over LLDP for the same (mac, port_idx). D-PROTECT-04.
 *   4. Additive contract — every Phase 7/8/9 field still present.
 *   5. Pre-start / post-stop — protectedPorts is ALWAYS an array; the floor
 *      survives the lifecycle (no `_poll` reference required).
 *   6. refreshStructure() returns ok:true and calls poll.refreshNow exactly
 *      once when running; pre-start it resolves to { ok:false, reason:'not_running' }
 *      without throwing.
 *
 * Harness mirrors plugin.test.js / plugin-poll-integration.test.js — vi.hoisted
 * mock state, MockUnifiClient + MockUnifiPoll, createMockContext().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROTECTED_PORTS } from '../../../plugins/unifi/protected-ports.js';

const { mockBehaviour, mockClientInstances, mockPollInstances } = vi.hoisted(() => ({
  mockBehaviour: {
    checkUnifiOsResult: true,
    loginShouldThrow: false,
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
    pollMetrics: { devicesDiscovered: 3, lastPollSuccessAt: '2026-05-13T00:00:00Z', pollErrorCount: 0 },
    runtimeProtected: new Set(),
    refreshNowResult: undefined,
    refreshNowShouldThrow: false,
  },
  mockClientInstances: [],
  mockPollInstances: [],
}));

vi.mock('../../../plugins/unifi/unifi-client.js', async () => {
  const { EventEmitter } = await import('node:events');
  const AUTH_STATE = Object.freeze({
    DISCONNECTED: 'disconnected', CONNECTING: 'connecting', CONNECTED: 'connected',
    REFRESHING: 'refreshing', AUTH_FAILED: 'auth_failed', NETWORK_DOWN: 'network_down',
    SESSION_EXPIRED_RECOVERING: 'session_expired_recovering',
  });

  class MockUnifiClient extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._state = { authState: AUTH_STATE.DISCONNECTED, authStateReason: null, lastCsrfRotationAt: null };
      this.checkUnifiOs = vi.fn(async () => mockBehaviour.checkUnifiOsResult);
      this.login = vi.fn(async () => {
        if (mockBehaviour.loginShouldThrow) throw new Error('login failed');
        this._state.authState = AUTH_STATE.CONNECTED;
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
  const { EventEmitter } = await import('node:events');
  class MockUnifiPoll extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._lastSnapshot = new Map();
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.runOnce = vi.fn(async () => {});
      this.refreshNow = vi.fn(async () => {
        if (mockBehaviour.refreshNowShouldThrow) throw new Error('refresh failed');
        return mockBehaviour.refreshNowResult;
      });
      this.getMetrics = vi.fn(() => mockBehaviour.pollMetrics);
      this.getCachedPortTables = vi.fn(() => new Map());
      this.getRuntimeProtectedPorts = vi.fn(() => mockBehaviour.runtimeProtected);
      mockPollInstances.push(this);
    }
  }
  return { UnifiPoll: MockUnifiPoll };
});

const { default: UnifiPlugin } = await import('../../../plugins/unifi/plugin.js');

function createMockContext(configOverrides = {}, pluginId = 'unifi') {
  const config = {
    host: '192.0.2.1', username: 'mqtt-master', password: 'pw',
    site: 'default', tlsVerify: false, ...configOverrides,
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
      get: vi.fn((key, def) => (key === `plugins.${pluginId}`) ? config : def),
      set: vi.fn(),
      save: vi.fn(async () => {}),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pluginId,
  };
}

function resetMockBehaviour() {
  mockBehaviour.checkUnifiOsResult = true;
  mockBehaviour.loginShouldThrow = false;
  mockBehaviour.sysinfoResult = { name: 'Gateway1', hostname: 'gateway1.example.com' };
  mockBehaviour.pollMetrics = { devicesDiscovered: 3, lastPollSuccessAt: '2026-05-13T00:00:00Z', pollErrorCount: 0 };
  mockBehaviour.runtimeProtected = new Set();
  mockBehaviour.refreshNowResult = undefined;
  mockBehaviour.refreshNowShouldThrow = false;
  mockClientInstances.length = 0;
  mockPollInstances.length = 0;
}

describe('UnifiPlugin × getStatus().protectedPorts + refreshStructure() (Plan 10-01)', () => {
  let plugin;
  let ctx;

  beforeEach(() => {
    resetMockBehaviour();
    plugin = new UnifiPlugin();
    ctx = createMockContext();
  });

  it('Test 1 — getStatus() includes every PROTECTED_PORTS entry with source="hardcoded" when running', async () => {
    mockBehaviour.runtimeProtected = new Set(); // empty LLDP set
    await plugin.start(ctx);

    const status = plugin.getStatus();
    expect(Array.isArray(status.protectedPorts)).toBe(true);

    // Every PROTECTED_PORTS entry must appear with source='hardcoded'.
    for (const floor of PROTECTED_PORTS) {
      const match = status.protectedPorts.find(
        (e) => e.mac === floor.mac && e.port_idx === floor.port_idx,
      );
      expect(match).toBeDefined();
      expect(match.source).toBe('hardcoded');
      // mac must be lowercase already (PROTECTED_PORTS stores lowercase).
      expect(match.mac).toBe(match.mac.toLowerCase());
      expect(typeof match.port_idx).toBe('number');
    }

    // Length equals exactly PROTECTED_PORTS length when LLDP set is empty.
    expect(status.protectedPorts).toHaveLength(PROTECTED_PORTS.length);
  });

  it('Test 2 — getStatus() includes LLDP-augmented runtime entries with source="lldp"', async () => {
    mockBehaviour.runtimeProtected = new Set([
      'aa:bb:cc:dd:ee:ff:3',
      '11:22:33:44:55:66:7',
    ]);
    await plugin.start(ctx);

    const status = plugin.getStatus();

    // Hardcoded floor still present with source='hardcoded'.
    for (const floor of PROTECTED_PORTS) {
      const match = status.protectedPorts.find(
        (e) => e.mac === floor.mac && e.port_idx === floor.port_idx,
      );
      expect(match).toBeDefined();
      expect(match.source).toBe('hardcoded');
    }

    // LLDP entries present with source='lldp'.
    const lldp1 = status.protectedPorts.find(
      (e) => e.mac === 'aa:bb:cc:dd:ee:ff' && e.port_idx === 3,
    );
    expect(lldp1).toBeDefined();
    expect(lldp1.source).toBe('lldp');

    const lldp2 = status.protectedPorts.find(
      (e) => e.mac === '11:22:33:44:55:66' && e.port_idx === 7,
    );
    expect(lldp2).toBeDefined();
    expect(lldp2.source).toBe('lldp');

    // Total = hardcoded floor + 2 LLDP entries (no collisions in this fixture).
    expect(status.protectedPorts).toHaveLength(PROTECTED_PORTS.length + 2);
  });

  it('Test 3 — Dedup: hardcoded wins over LLDP for the same (mac, port_idx)', async () => {
    // Seed the runtime set with the FIRST hardcoded entry's key — collision.
    const floor = PROTECTED_PORTS[0];
    const collisionKey = `${floor.mac}:${floor.port_idx}`;
    mockBehaviour.runtimeProtected = new Set([collisionKey]);

    await plugin.start(ctx);

    const status = plugin.getStatus();

    // Entry appears EXACTLY once.
    const matches = status.protectedPorts.filter(
      (e) => e.mac === floor.mac && e.port_idx === floor.port_idx,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('hardcoded');

    // No source='lldp' entry for this pair.
    const lldpDup = status.protectedPorts.find(
      (e) => e.mac === floor.mac && e.port_idx === floor.port_idx && e.source === 'lldp',
    );
    expect(lldpDup).toBeUndefined();
  });

  it('Test 4 — Additive contract: every Phase 7/8/9 field still present', async () => {
    await plugin.start(ctx);
    const status = plugin.getStatus();

    const requiredKeys = [
      'running', 'connected', 'controlCount', 'lastEvent', 'messageCount',
      'authState', 'authStateReason', 'controllerName', 'siteName',
      'ssoAccountWarning', 'displayName', 'topicPrefix', 'lastCsrfRotationAt',
      'devicesDiscovered', 'lastPollSuccessAt', 'pollErrorCount',
      'protectedPorts',
    ];
    for (const key of requiredKeys) {
      expect(status).toHaveProperty(key);
    }
    // Pinned semantics — make sure protectedPorts is the only NEW one.
    expect(status.running).toBe(true);
    expect(status.controllerName).toBe('Gateway1');
    expect(status.devicesDiscovered).toBe(3);
  });

  it('Test 5 — protectedPorts is always an array, even pre-start (no _poll)', () => {
    // Do NOT call plugin.start() — _poll is null at this point.
    const status = plugin.getStatus();
    expect(Array.isArray(status.protectedPorts)).toBe(true);

    // Hardcoded floor survives the lifecycle — every PROTECTED_PORTS entry
    // is in the list with source='hardcoded'.
    for (const floor of PROTECTED_PORTS) {
      const match = status.protectedPorts.find(
        (e) => e.mac === floor.mac && e.port_idx === floor.port_idx,
      );
      expect(match).toBeDefined();
      expect(match.source).toBe('hardcoded');
    }
    expect(status.protectedPorts).toHaveLength(PROTECTED_PORTS.length);

    // It must NEVER be undefined.
    expect(status.protectedPorts).not.toBeUndefined();
  });

  it('Test 6a — refreshStructure() returns ok:true and calls poll.refreshNow once when running', async () => {
    await plugin.start(ctx);
    const poll = mockPollInstances[0];

    const result = await plugin.refreshStructure();
    expect(result).toEqual({ ok: true });
    expect(poll.refreshNow).toHaveBeenCalledTimes(1);
  });

  it('Test 6b — refreshStructure() pre-start resolves to { ok:false, reason:"not_running" } without throwing', async () => {
    // Do NOT call plugin.start() — plugin is not running.
    let result;
    await expect(async () => { result = await plugin.refreshStructure(); }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'not_running' });
  });
});
