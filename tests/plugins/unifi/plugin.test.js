/**
 * UnifiPlugin lifecycle + reload + getStatus + topic-prefix auto-derivation
 * test suite (07-02 Task 3).
 *
 * Each `it(...)` description prefixes the CONTEXT.md decision ID it asserts so
 * the lineage from a green test back to the locked design decision is grep-able
 * in one step.
 *
 * Phase-boundary invariants asserted here:
 *   - bridge/status is the ONLY MQTT publish (online on start, offline on stop)
 *   - ZERO mqttService.subscribe calls anywhere in the lifecycle (Phase 9 work)
 *   - configService.set is gated on the autoNamed flag (D-14 manual-override)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock UnifiClient + AUTH_STATE before the SUT imports them. We use
// vi.hoisted so the shared state survives the vi.mock hoist to module top.
const { mockBehaviour, mockClientInstances } = vi.hoisted(() => ({
  mockBehaviour: {
    checkUnifiOsResult: true,
    loginShouldThrow: false,
    loginError: null,
    loginAuthState: 'connected',
    loginAuthStateReason: null,
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
    sysinfoShouldThrow: false,
    emitSsoWarning: false,
  },
  mockClientInstances: [],
}));

vi.mock('../../../plugins/unifi/unifi-client.js', async () => {
  const { EventEmitter } = await import('node:events');
  const AUTH_STATE = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    REFRESHING: 'refreshing',
    AUTH_FAILED: 'auth_failed',
    NETWORK_DOWN: 'network_down',
    SESSION_EXPIRED_RECOVERING: 'session_expired_recovering',
  });

  class MockUnifiClient extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._state = {
        authState: AUTH_STATE.DISCONNECTED,
        authStateReason: null,
        lastCsrfRotationAt: null,
      };
      this.checkUnifiOs = vi.fn(async () => mockBehaviour.checkUnifiOsResult);
      this.login = vi.fn(async () => {
        if (mockBehaviour.loginShouldThrow) {
          this._state.authState = mockBehaviour.loginAuthState;
          this._state.authStateReason = mockBehaviour.loginAuthStateReason;
          throw mockBehaviour.loginError || new Error('login failed');
        }
        this._state.authState = AUTH_STATE.CONNECTED;
        this._state.authStateReason = null;
        if (mockBehaviour.emitSsoWarning) {
          this.emit('sso_account_warning', { username: opts.username });
        }
      });
      this.request = vi.fn(async ({ method, path }) => {
        if (path === '/api/system') {
          if (mockBehaviour.sysinfoShouldThrow) throw new Error('sysinfo failed');
          return mockBehaviour.sysinfoResult;
        }
        throw new Error(`MockUnifiClient: unexpected ${method} ${path}`);
      });
      this.disconnect = vi.fn(async () => {
        this._state.authState = AUTH_STATE.DISCONNECTED;
        this.emit('disconnected');
      });
      this.getStatus = vi.fn(() => ({ ...this._state }));
      mockClientInstances.push(this);
    }
  }

  return { UnifiClient: MockUnifiClient, AUTH_STATE };
});

const { default: UnifiPlugin } = await import('../../../plugins/unifi/plugin.js');

function createMockContext(configOverrides = {}, pluginId = 'unifi') {
  const defaultConfig = {
    host: '192.0.2.1',
    username: 'mqtt-master',
    password: 'test-kennwort-unifi',
    site: 'default',
    tlsVerify: false,
  };
  const config = { ...defaultConfig, ...configOverrides };

  const published = [];
  const subscribed = [];

  return {
    mqttService: {
      publish: vi.fn(async (topic, payload, opts) => {
        published.push({ topic, payload, opts });
      }),
      subscribe: vi.fn((topic) => { subscribed.push(topic); }),
      unsubscribe: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    configService: {
      get: vi.fn((key, def) => {
        if (key === `plugins.${pluginId}`) return config;
        return def;
      }),
      set: vi.fn(),
      save: vi.fn(async () => {}),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    pluginId,
    _published: published,
    _subscribed: subscribed,
    _config: config,
  };
}

function resetMockBehaviour() {
  mockBehaviour.checkUnifiOsResult = true;
  mockBehaviour.loginShouldThrow = false;
  mockBehaviour.loginError = null;
  mockBehaviour.loginAuthState = 'connected';
  mockBehaviour.loginAuthStateReason = null;
  mockBehaviour.sysinfoResult = { name: 'Gateway1', hostname: 'gateway1.example.com' };
  mockBehaviour.sysinfoShouldThrow = false;
  mockBehaviour.emitSsoWarning = false;
  mockClientInstances.length = 0;
}

describe('UnifiPlugin', () => {
  let plugin;
  let ctx;

  beforeEach(() => {
    resetMockBehaviour();
    plugin = new UnifiPlugin();
    ctx = createMockContext();
  });

  it('[Lifecycle] start publishes bridge/status=online retained as the ONLY MQTT publish', async () => {
    await plugin.start(ctx);

    // Exactly one publish — to bridge/status — with payload 'online' + retain.
    expect(ctx.mqttService.publish).toHaveBeenCalledTimes(1);
    const call = ctx.mqttService.publish.mock.calls[0];
    expect(call[0]).toMatch(/\/bridge\/status$/);
    expect(call[1]).toBe('online');
    expect(call[2]).toEqual({ retain: true });

    // The client surface was driven exactly as the contract demands.
    const client = mockClientInstances[0];
    expect(client.checkUnifiOs).toHaveBeenCalledTimes(1);
    expect(client.login).toHaveBeenCalledTimes(1);
  });

  it('[Lifecycle] stop publishes bridge/status=offline retained and disconnects the client', async () => {
    await plugin.start(ctx);
    const client = mockClientInstances[0];
    ctx.mqttService.publish.mockClear();

    await plugin.stop();

    expect(ctx.mqttService.publish).toHaveBeenCalledTimes(1);
    const call = ctx.mqttService.publish.mock.calls[0];
    expect(call[0]).toMatch(/\/bridge\/status$/);
    expect(call[1]).toBe('offline');
    expect(call[2]).toEqual({ retain: true });
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('[D-14/D-15] auto-derives topicPrefix to unifi-gateway1/ + displayName "UniFi Gateway1" from controller name', async () => {
    await plugin.start(ctx);

    // The plugin's final prefix must end with `unifi-gateway1/`.
    expect(plugin._prefix).toBe('unifi-gateway1');

    // The bridge/status topic uses the derived prefix.
    const publishCall = ctx.mqttService.publish.mock.calls[0];
    expect(publishCall[0]).toBe('unifi-gateway1/bridge/status');

    // configService.set was called with the derived values + autoNamed=true.
    expect(ctx.configService.set).toHaveBeenCalledTimes(1);
    const [key, savedCfg] = ctx.configService.set.mock.calls[0];
    expect(key).toBe('plugins.unifi');
    expect(savedCfg.topicPrefix).toBe('unifi-gateway1');
    expect(savedCfg.displayName).toBe('UniFi Gateway1');
    expect(savedCfg.autoNamed).toBe(true);

    // save() was awaited so the change is durable.
    expect(ctx.configService.save).toHaveBeenCalledTimes(1);
  });

  it('[D-14] manual override is preserved when autoNamed=false', async () => {
    ctx = createMockContext({
      topicPrefix: 'unifi-custom/',
      displayName: 'My UniFi',
      autoNamed: false,
    });

    await plugin.start(ctx);

    // Prefix is the manual one — no overwrite.
    expect(plugin._prefix).toBe('unifi-custom');

    // configService.set must NOT have been called at all (idempotency: nothing changed).
    expect(ctx.configService.set).not.toHaveBeenCalled();
    expect(ctx.configService.save).not.toHaveBeenCalled();

    // The single publish goes to the user-chosen prefix.
    const publishCall = ctx.mqttService.publish.mock.calls[0];
    expect(publishCall[0]).toBe('unifi-custom/bridge/status');
  });

  it('[D-13] getStatus exposes additive authState + authStateReason + controllerName + siteName without breaking Loxone-compatible shape', async () => {
    await plugin.start(ctx);
    const status = plugin.getStatus();

    // Existing Loxone-style fields preserved.
    expect(status).toHaveProperty('running', true);
    expect(status).toHaveProperty('connected', true);
    expect(status).toHaveProperty('controlCount', 0);
    expect(status).toHaveProperty('lastEvent');
    expect(status).toHaveProperty('messageCount');

    // Additive Phase-7 fields.
    expect(status.authState).toBe('connected');
    expect(status.authStateReason).toBeNull();
    expect(status.controllerName).toBe('Gateway1');
    expect(status.siteName).toBe('default');
    expect(status.ssoAccountWarning).toBe(false);
  });

  it('[D-17] start rejects with "Legacy CloudKey not supported in v1.1" when checkUnifiOs returns false, and does NOT publish bridge/status=online', async () => {
    mockBehaviour.checkUnifiOsResult = false;

    await expect(plugin.start(ctx)).rejects.toThrow(/Legacy CloudKey not supported in v1\.1/);

    // The fail-fast path must NOT have published bridge/status=online.
    const onlinePublishes = ctx.mqttService.publish.mock.calls.filter(
      ([, payload]) => payload === 'online',
    );
    expect(onlinePublishes).toHaveLength(0);
  });

  it('[D-21] 2FA login failure surfaces clearly via getStatus authState=auth_failed, reason=2fa_blocked', async () => {
    mockBehaviour.loginShouldThrow = true;
    mockBehaviour.loginAuthState = 'auth_failed';
    mockBehaviour.loginAuthStateReason = '2fa_blocked';
    mockBehaviour.loginError = new Error('SSO MFA required — TOTP not supported in v1.1');

    await expect(plugin.start(ctx)).rejects.toThrow(/SSO MFA required/);

    const status = plugin.getStatus();
    expect(status.running).toBe(false);
    expect(status.authState).toBe('auth_failed');
    expect(status.authStateReason).toBe('2fa_blocked');
  });

  it('[Lifecycle] reload — start/stop/start swaps in new credentials on a fresh client', async () => {
    // First start with creds A.
    await plugin.start(ctx);
    expect(mockClientInstances).toHaveLength(1);
    const firstClient = mockClientInstances[0];

    // Stop, then start a fresh plugin instance with different creds (mirrors PluginManager.reload).
    await plugin.stop();
    const plugin2 = new UnifiPlugin();
    const ctx2 = createMockContext({
      username: 'mqtt-master-v2',
      password: 'different-password-456!',
    });
    await plugin2.start(ctx2);

    // Two distinct client instances created.
    expect(mockClientInstances).toHaveLength(2);
    const secondClient = mockClientInstances[1];
    expect(secondClient).not.toBe(firstClient);
    expect(secondClient.opts.username).toBe('mqtt-master-v2');
    expect(secondClient.opts.password).toBe('different-password-456!');
  });

  it('[D-11b] sso_account_warning event flips getStatus().ssoAccountWarning to true', async () => {
    mockBehaviour.emitSsoWarning = true;

    await plugin.start(ctx);
    const status = plugin.getStatus();
    expect(status.ssoAccountWarning).toBe(true);
  });

  it('[Phase boundary] start does NOT subscribe to any MQTT cmd topics (Phase 9 work)', async () => {
    await plugin.start(ctx);
    await plugin.stop();

    // ZERO subscribe calls — Phase 7 has no inbound command path.
    expect(ctx.mqttService.subscribe).not.toHaveBeenCalled();
  });

  it('[D-14 step 1] pre-connect prefix is derived from host last-octet when no displayName/topicPrefix in config', async () => {
    // Force sysinfo failure so the post-connect auto-rename does NOT kick in;
    // we then inspect the pre-connect derivation.
    mockBehaviour.sysinfoShouldThrow = true;

    await plugin.start(ctx);

    // host '192.0.2.1' last octet = '1', slugified → '1' → 'unifi-1/'.
    expect(plugin._prefix).toBe('unifi-1');
  });

  it('[D-14 idempotency] does not call configService.set when autoNamed result equals existing config', async () => {
    // Pre-populate the config with the post-connect derived values + autoNamed:true.
    // Plugin should detect "nothing changed" and skip the persist.
    ctx = createMockContext({
      topicPrefix: 'unifi-gateway1/',
      displayName: 'UniFi Gateway1',
      autoNamed: true,
    });

    await plugin.start(ctx);

    expect(ctx.configService.set).not.toHaveBeenCalled();
    expect(ctx.configService.save).not.toHaveBeenCalled();
  });
});
