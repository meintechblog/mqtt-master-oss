/**
 * Plugin × structure-monitor retain-clear tests (6 cases).
 *
 * Asserts the rename / removal / addition handling for `devices-changed`
 * events emitted by UnifiPoll. Especially the CRITICAL D-S-02 invariant:
 * retain-clear ONLY targets /state topics, NEVER /cmd topics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBehaviour, mockClientInstances, mockPollInstances } = vi.hoisted(() => ({
  mockBehaviour: {
    checkUnifiOsResult: true,
    loginShouldThrow: false,
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
    sysinfoShouldThrow: false,
    emitSsoWarning: false,
    pollMetrics: { devicesDiscovered: 3, lastPollSuccessAt: '2026-05-12T22:00:00Z', pollErrorCount: 0 },
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
      this.login = vi.fn(async () => {
        this._state.authState = AUTH_STATE.CONNECTED;
        if (mockBehaviour.emitSsoWarning) this.emit('sso_account_warning', { username: opts.username });
      });
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
      this.runOnce = vi.fn(async () => {});
      this.start = vi.fn();
      this.stop = vi.fn(async () => {});
      this.getMetrics = vi.fn(() => mockBehaviour.pollMetrics);
      mockPollInstances.push(this);
    }
  }
  return { UnifiPoll: MockUnifiPoll };
});

const { default: UnifiPlugin } = await import('../../../plugins/unifi/plugin.js');

function createMockContext() {
  const config = {
    host: '192.0.2.1', username: 'mqtt-master', password: 'pw',
    site: 'default', tlsVerify: false,
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
  mockBehaviour.checkUnifiOsResult = true;
  mockBehaviour.sysinfoResult = { name: 'Gateway1', hostname: 'gateway1.example.com' };
  mockBehaviour.sysinfoShouldThrow = false;
  mockBehaviour.emitSsoWarning = false;
  mockClientInstances.length = 0;
  mockPollInstances.length = 0;
}

const isCmdTopic = (t) => typeof t === 'string' && /\/cmd($|\/)/.test(t);
const isRetainClear = (call) => call[1] === '' && call[2] && call[2].retain === true;

describe('UnifiPlugin × structure-monitor retain-clear', () => {
  let plugin, ctx, poll;

  beforeEach(async () => {
    resetMockBehaviour();
    plugin = new UnifiPlugin();
    ctx = createMockContext();
    await plugin.start(ctx);
    poll = mockPollInstances[0];
    ctx.mqttService.publish.mockClear();
  });

  it('Test 9 — rename emits retain-clear on OLD slug state topics ONLY; new namespace + by-mac untouched', () => {
    poll.emit('devices-changed', {
      added: [],
      renamed: [
        {
          mac: '02:00:00:00:00:fa',
          oldNameSlug: 'main-old',
          newNameSlug: 'main-new',
          entry: { mac: '02:00:00:00:00:fa', name: 'Main New', nameSlug: 'main-new', model: 'USPM16P', type: 'usw', portCount: 18 },
        },
      ],
      removed: [],
      unchanged: 0,
    });

    const publishes = ctx.mqttService.publish.mock.calls;

    // Expect retain-clears for old slug device state + 18 port states.
    const oldSlugClears = publishes.filter(
      ([t, p]) => isRetainClear([t, p, { retain: true }]) && t.startsWith('unifi-gateway1/main-old/'),
    );
    // 1 device-state + 18 port-states = 19 clears under the old slug.
    expect(oldSlugClears.length).toBe(19);

    // Verify no cmd publishes anywhere.
    expect(publishes.find(([t]) => isCmdTopic(t))).toBeUndefined();

    // Verify no publishes (clear or otherwise) under the NEW slug — the next
    // poll populates new topics, not the rename handler.
    expect(publishes.find(([t]) => t.startsWith('unifi-gateway1/main-new/'))).toBeUndefined();

    // Verify no by-mac retain-clears (MACs are stable across rename — D-T-04).
    expect(publishes.find(
      ([t, p]) => isRetainClear([t, p, { retain: true }]) && t.startsWith('unifi-gateway1/by-mac/'),
    )).toBeUndefined();
  });

  it('Test 10 — removal emits retain-clear on BOTH slug AND by-mac namespaces; cmd topics untouched', () => {
    poll.emit('devices-changed', {
      added: [],
      renamed: [],
      removed: [
        { mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main', model: 'USPM16P', type: 'usw', portCount: 18 },
      ],
      unchanged: 0,
    });

    const publishes = ctx.mqttService.publish.mock.calls;

    // Slug-namespace clears: 1 device-state + 18 port-states = 19.
    const slugClears = publishes.filter(
      ([t, p]) => isRetainClear([t, p, { retain: true }]) && t.startsWith('unifi-gateway1/main/'),
    );
    expect(slugClears.length).toBe(19);

    // by-mac clears: same shape under the MAC-derived slug.
    const macClears = publishes.filter(
      ([t, p]) => isRetainClear([t, p, { retain: true }]) && t.startsWith('unifi-gateway1/by-mac/02-00-00-00-00-fa/'),
    );
    expect(macClears.length).toBe(19);

    // ZERO cmd publishes.
    expect(publishes.find(([t]) => isCmdTopic(t))).toBeUndefined();
  });

  it('Test 11 — added entries produce ZERO retain-clears (next poll publishes the new state)', () => {
    poll.emit('devices-changed', {
      added: [
        { mac: 'aa:bb:cc:dd:ee:ff', name: 'NewDevice', nameSlug: 'newdevice', model: 'U6P', type: 'uap', portCount: 0 },
      ],
      renamed: [],
      removed: [],
      unchanged: 2,
    });

    const publishes = ctx.mqttService.publish.mock.calls;
    const clears = publishes.filter(
      ([t, p]) => isRetainClear([t, p, { retain: true }]),
    );
    expect(clears.length).toBe(0);
  });

  it('Test 12 — empty-payload semantics: every retain-clear uses payload="" + retain:true', () => {
    poll.emit('devices-changed', {
      added: [],
      renamed: [],
      removed: [
        { mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main', model: 'USPM16P', type: 'usw', portCount: 2 },
      ],
      unchanged: 0,
    });

    const publishes = ctx.mqttService.publish.mock.calls;
    expect(publishes.length).toBeGreaterThan(0);

    for (const [topic, payload, opts] of publishes) {
      // Every publish in the removal handler is a retain-clear.
      expect(payload).toBe('');
      expect(opts).toEqual({ retain: true });
      expect(typeof topic).toBe('string');
      expect(topic.length).toBeGreaterThan(0);
    }
  });

  it('Test 13 — CRITICAL invariant: retain-clear NEVER touches cmd topics (D-S-02)', () => {
    // Drive rename + removal in the same diff to maximise topic coverage.
    poll.emit('devices-changed', {
      added: [],
      renamed: [
        {
          mac: '02:00:00:00:00:fa',
          oldNameSlug: 'main-old',
          newNameSlug: 'main',
          entry: { mac: '02:00:00:00:00:fa', name: 'Main', nameSlug: 'main', model: 'USPM16P', type: 'usw', portCount: 4 },
        },
      ],
      removed: [
        { mac: '02:00:00:00:00:0e', name: 'Gateway1', nameSlug: 'gateway1', model: 'UCGMAX', type: 'udm', portCount: 5 },
      ],
      unchanged: 0,
    });

    const publishes = ctx.mqttService.publish.mock.calls;
    // D-S-02 verbatim:
    const offendingPublish = publishes.find(
      ([topic, payload]) => topic.includes('/cmd') && payload === '',
    );
    expect(offendingPublish).toBeUndefined();

    // Every empty publish targets a /state topic.
    const emptyPublishes = publishes.filter(([, p]) => p === '');
    for (const [topic] of emptyPublishes) {
      expect(topic.endsWith('/state')).toBe(true);
    }
  });

  it('Test 14 — Phase 7 SSO warning flows through getStatus unchanged (regression guard)', async () => {
    // Fresh plugin instance to exercise SSO warning during start.
    await plugin.stop();
    mockBehaviour.emitSsoWarning = true;

    const plugin2 = new UnifiPlugin();
    const ctx2 = createMockContext();
    await plugin2.start(ctx2);

    const status = plugin2.getStatus();
    expect(status.ssoAccountWarning).toBe(true);
    expect(status.authState).toBe('connected');

    await plugin2.stop();
  });
});
