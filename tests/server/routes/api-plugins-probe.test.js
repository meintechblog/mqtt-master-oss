/**
 * POST /api/plugins/:type/probe route test suite (07-02 Task 3).
 *
 * Asserts the D-12 structured-response contract end-to-end through Fastify
 * `app.inject` against a mocked UnifiClient. Coverage includes the happy
 * path (status:'ok' + controllerName), each documented failure mode
 * (auth_failed / 2fa_blocked / network_down / rate_limited), the SSO-account
 * flag propagation (D-11b), input validation, type-restriction (only 'unifi'
 * for now), and the critical no-persistence invariant (T-07-08 mitigation —
 * the probe handler MUST NOT call configService.set / configService.save).
 *
 * Each `it(...)` description prefixes the CONTEXT.md decision ID it asserts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

// Mock UnifiClient before the route loads it via dynamic import. Use
// vi.hoisted so the shared behaviour object survives the vi.mock hoist.
const { mockBehaviour, mockClientInstances } = vi.hoisted(() => ({
  mockBehaviour: {
    checkUnifiOsResult: true,
    checkUnifiOsShouldThrow: false,
    checkUnifiOsError: null,
    checkUnifiOsErrorState: null, // { authState, authStateReason }
    loginShouldThrow: false,
    loginError: null,
    loginErrorState: null,        // { authState, authStateReason }
    sysinfoResult: { name: 'Gateway1', hostname: 'gateway1.example.com' },
    sysinfoShouldThrow: false,
    emitSsoWarning: false,
  },
  mockClientInstances: [],
}));

vi.mock('../../../plugins/unifi/unifi-client.js', async () => {
  const { EventEmitter } = await import('node:events');

  class MockUnifiClient extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this._state = {
        authState: 'disconnected',
        authStateReason: null,
      };
      this.checkUnifiOs = vi.fn(async () => {
        if (mockBehaviour.checkUnifiOsShouldThrow) {
          if (mockBehaviour.checkUnifiOsErrorState) {
            this._state.authState = mockBehaviour.checkUnifiOsErrorState.authState;
            this._state.authStateReason = mockBehaviour.checkUnifiOsErrorState.authStateReason;
          }
          throw mockBehaviour.checkUnifiOsError || new Error('checkUnifiOs failed');
        }
        return mockBehaviour.checkUnifiOsResult;
      });
      this.login = vi.fn(async () => {
        if (mockBehaviour.loginShouldThrow) {
          if (mockBehaviour.loginErrorState) {
            this._state.authState = mockBehaviour.loginErrorState.authState;
            this._state.authStateReason = mockBehaviour.loginErrorState.authStateReason;
          }
          throw mockBehaviour.loginError || new Error('login failed');
        }
        this._state.authState = 'connected';
        this._state.authStateReason = null;
        if (mockBehaviour.emitSsoWarning) {
          this.emit('sso_account_warning', { username: opts.username });
        }
      });
      this.request = vi.fn(async ({ path }) => {
        if (path === '/api/system') {
          if (mockBehaviour.sysinfoShouldThrow) throw new Error('sysinfo failed');
          return mockBehaviour.sysinfoResult;
        }
        throw new Error(`MockUnifiClient: unexpected path ${path}`);
      });
      this.disconnect = vi.fn(async () => {
        this._state.authState = 'disconnected';
      });
      this.getStatus = vi.fn(() => ({ ...this._state }));
      mockClientInstances.push(this);
    }
  }

  return { UnifiClient: MockUnifiClient };
});

// Import the SUT (route module) AFTER the vi.mock setup.
const { default: apiPlugins } = await import('../../../server/routes/api-plugins.js');

function resetMockBehaviour() {
  mockBehaviour.checkUnifiOsResult = true;
  mockBehaviour.checkUnifiOsShouldThrow = false;
  mockBehaviour.checkUnifiOsError = null;
  mockBehaviour.checkUnifiOsErrorState = null;
  mockBehaviour.loginShouldThrow = false;
  mockBehaviour.loginError = null;
  mockBehaviour.loginErrorState = null;
  mockBehaviour.sysinfoResult = { name: 'Gateway1', hostname: 'gateway1.example.com' };
  mockBehaviour.sysinfoShouldThrow = false;
  mockBehaviour.emitSsoWarning = false;
  mockClientInstances.length = 0;
}

function createMockConfigService() {
  return {
    get: vi.fn((key, fallback) => fallback),
    set: vi.fn(),
    save: vi.fn(async () => {}),
  };
}

function createMockPluginManager() {
  return {
    listAll: vi.fn(async () => []),
    getInstance: vi.fn(() => null),
    getTemplates: vi.fn(() => []),
    getConfig: vi.fn(() => ({})),
    setConfig: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({ status: 'stopped', error: null })),
    getSchema: vi.fn(() => ({})),
  };
}

describe('POST /api/plugins/:type/probe', () => {
  let app;
  let mockCfg;

  beforeEach(async () => {
    resetMockBehaviour();
    app = Fastify({ logger: false });
    mockCfg = createMockConfigService();
    app.decorate('configService', mockCfg);
    app.decorate('pluginManager', createMockPluginManager());
    app.decorate('mqttService', { publish: async () => {} });
    app.decorate('topicCacheService', { list: () => [], clear: () => {} });
    await app.register(apiPlugins);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function probe(payload, type = 'unifi') {
    return app.inject({
      method: 'POST',
      url: `/api/plugins/${type}/probe`,
      payload,
    });
  }

  it("[D-12] valid creds → 200 + status:'ok' + controllerName:'Gateway1' + siteName + ssoAccount:false", async () => {
    const res = await probe({
      host: '192.0.2.1',
      username: 'mqtt-master',
      password: 'test-kennwort-unifi',
      site: 'default',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      status: 'ok',
      controllerName: 'Gateway1',
      siteName: 'default',
      ssoAccount: false,
    });

    // [T-07-08] probe MUST NOT persist anything.
    expect(mockCfg.set).not.toHaveBeenCalled();
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it("[D-12] invalid creds → 200 + status:'auth_failed' + error:'Invalid credentials'", async () => {
    mockBehaviour.loginShouldThrow = true;
    mockBehaviour.loginErrorState = { authState: 'auth_failed', authStateReason: 'invalid_credentials' };
    mockBehaviour.loginError = new Error('Login refused — invalid credentials');

    const res = await probe({
      host: '192.0.2.1',
      username: 'mqtt-master',
      password: 'wrong',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('auth_failed');
    expect(body.error).toBe('Invalid credentials');
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it("[D-12] 2FA blocked → 200 + status:'2fa_blocked' + exact error '2FA admin not supported — create a local-only admin'", async () => {
    mockBehaviour.loginShouldThrow = true;
    mockBehaviour.loginErrorState = { authState: 'auth_failed', authStateReason: '2fa_blocked' };
    mockBehaviour.loginError = new Error('SSO MFA required — TOTP not supported in v1.1');

    const res = await probe({
      host: '192.0.2.1',
      username: 'sso-admin@example.com',
      password: 'whatever',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('2fa_blocked');
    expect(body.error).toBe('2FA admin not supported — create a local-only admin');
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it("[D-12] unreachable host → 200 + status:'network_down' with the original err.message", async () => {
    mockBehaviour.checkUnifiOsShouldThrow = true;
    mockBehaviour.checkUnifiOsErrorState = { authState: 'network_down', authStateReason: 'host_unreachable' };
    mockBehaviour.checkUnifiOsError = new Error('connect ECONNREFUSED 192.0.2.1:443');

    const res = await probe({
      host: '192.0.2.1',
      username: 'mqtt-master',
      password: 'x',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('network_down');
    expect(body.error).toContain('ECONNREFUSED');
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it("[D-12] rate-limited → 200 + status:'auth_failed' + 'Rate-limited by controller — wait 5 min before retrying'", async () => {
    mockBehaviour.loginShouldThrow = true;
    mockBehaviour.loginErrorState = { authState: 'auth_failed', authStateReason: 'rate_limited' };
    mockBehaviour.loginError = new Error('Login rate-limit reached — back off ≥ 5 min');

    const res = await probe({
      host: '192.0.2.1',
      username: 'mqtt-master',
      password: 'x',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('auth_failed');
    expect(body.error).toBe('Rate-limited by controller — wait 5 min before retrying');
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it("[D-11b] SSO admin detected during login → response body ssoAccount:true", async () => {
    mockBehaviour.emitSsoWarning = true;

    const res = await probe({
      host: '192.0.2.1',
      username: 'admin@example.com',
      password: 'right-password',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.controllerName).toBe('Gateway1');
    expect(body.ssoAccount).toBe(true);
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it('[Validation] missing fields → 400 with the canonical error message', async () => {
    const res = await probe({ username: 'x' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ error: 'host, username, password are required' });
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it('[Routing] non-unifi type → 404 + error containing "probe not supported"', async () => {
    const res = await probe(
      { host: 'x', username: 'x', password: 'x' },
      'loxone',
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/probe not supported/);
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it('[D-17] legacy CloudKey (checkUnifiOs:false) → status:auth_failed (no login attempted)', async () => {
    mockBehaviour.checkUnifiOsResult = false;

    const res = await probe({
      host: '192.0.2.99',
      username: 'mqtt-master',
      password: 'x',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('auth_failed');
    expect(body.error).toMatch(/Legacy CloudKey not supported/);

    // login() was never reached — the route short-circuits on isUnifiOs=false.
    const client = mockClientInstances[0];
    expect(client.login).not.toHaveBeenCalled();
    expect(mockCfg.save).not.toHaveBeenCalled();
  });

  it('[T-07-08] across every branch tested in this suite, configService.save was NEVER called', async () => {
    // Trigger one of each major branch in sequence and assert at the end.
    await probe({ host: 'h', username: 'u', password: 'p' });                              // ok
    mockBehaviour.loginShouldThrow = true;
    mockBehaviour.loginErrorState = { authState: 'auth_failed', authStateReason: 'invalid_credentials' };
    await probe({ host: 'h', username: 'u', password: 'p' });                              // auth_failed
    mockBehaviour.loginErrorState = { authState: 'auth_failed', authStateReason: '2fa_blocked' };
    await probe({ host: 'h', username: 'u', password: 'p' });                              // 2fa_blocked
    mockBehaviour.loginShouldThrow = false;
    mockBehaviour.checkUnifiOsShouldThrow = true;
    mockBehaviour.checkUnifiOsErrorState = { authState: 'network_down', authStateReason: 'host_unreachable' };
    mockBehaviour.checkUnifiOsError = new Error('ECONNREFUSED');
    await probe({ host: 'h', username: 'u', password: 'p' });                              // network_down
    await probe({ host: 'h' });                                                            // 400
    await probe({ host: 'h', username: 'u', password: 'p' }, 'loxone');                    // 404

    expect(mockCfg.set).not.toHaveBeenCalled();
    expect(mockCfg.save).not.toHaveBeenCalled();
  });
});
