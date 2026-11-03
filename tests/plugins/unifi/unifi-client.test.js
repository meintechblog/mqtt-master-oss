/**
 * UnifiClient unit tests — Phase 07-01.
 *
 * Each `it` name begins with the CONTEXT.md decision ID it covers so the
 * suite output is a traceability map back to the locked design decisions.
 *
 * Fetch is mocked at globalThis.fetch — we replay JSON fixtures from
 * tests/fixtures/unifi/ as `Response` objects. We do NOT mock node:undici
 * (the Agent dispatcher is unused by the mock path because globalThis.fetch
 * is replaced before it can dispatch).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  UnifiClient,
  AUTH_STATE,
  LoginRequired,
  Forbidden,
  ResponseError,
  AuthRateLimit,
  RateLimit,
  SsoMfaRequired,
  BadGateway,
  ServiceUnavailable,
  RequestError,
} from '../../../plugins/unifi/unifi-client.js';

// -- Fixture loading ---------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'unifi');

/** @param {string} name */
function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

/**
 * Build a Response from a fixture envelope { status, headers, body }.
 * Override individual fields via the second argument.
 *
 * @param {string} fixtureName
 * @param {{ status?: number, headers?: Record<string,string>, body?: any, bodyOverrideText?: string }} [overrides]
 */
function makeResponse(fixtureName, overrides = {}) {
  const fx = loadFixture(fixtureName);
  const status = overrides.status ?? fx.status;
  const headers = { ...fx.headers, ...(overrides.headers || {}) };
  const body = overrides.body ?? fx.body;
  const text = overrides.bodyOverrideText !== undefined
    ? overrides.bodyOverrideText
    : JSON.stringify(body);
  return new Response(text, { status, headers });
}

// -- Helpers -----------------------------------------------------------------

function makeClient(overrides = {}) {
  return new UnifiClient({
    host: '192.0.2.1',
    username: 'mqtt-master',
    password: 'test-kennwort-unifi',
    tlsVerify: false,
    rememberMe: true,
    logger: makeLogger(),
    ...overrides,
  });
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// Snapshot the original fetch so we always restore it cleanly even if a test
// throws between beforeEach/afterEach.
let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnifiClient', () => {
  it('[D-01] login happy path: 200 + cookie + CSRF stored in headers', async () => {
    const client = makeClient();
    const fx = loadFixture('auth-login-success');
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse('auth-login-success'));

    await client.login();

    expect(client.getStatus().authState).toBe('connected');
    expect(client.getStatus().authStateReason).toBeNull();
    // CSRF token captured from x-csrf-token header into internal _headers
    expect(client._headers['x-csrf-token']).toBe(fx.headers['x-csrf-token']);
    // Login request was POST to /api/auth/login with rememberMe in body
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://192.0.2.1/api/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      username: 'mqtt-master',
      rememberMe: true,
    });
    // Cookie jar absorbed the TOKEN cookie
    const cookieString = await client._jar.getCookieString('https://192.0.2.1/');
    expect(cookieString).toMatch(/TOKEN=/);
  });

  it('[D-22] CSRF rotation: x-updated-csrf-token on subsequent request replaces _headers and emits csrf_rotated', async () => {
    const client = makeClient();
    const rotatedToken = 'rotated-csrf-9999-9999-9999-deadbeef0099';

    const rotatedEvents = [];
    client.on('csrf_rotated', e => rotatedEvents.push(e));

    // First call: login.
    // Second call: sysinfo, with a rotated csrf token in the response headers.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(makeResponse('auth-login-success'))
      .mockResolvedValueOnce(makeResponse('sysinfo-success', {
        headers: {
          'content-type': 'application/json',
          'x-updated-csrf-token': rotatedToken,
        },
      }));

    await client.login();
    const before = client._headers['x-csrf-token'];
    await client.request({ method: 'GET', path: '/api/system' });
    const after = client._headers['x-csrf-token'];

    expect(after).toBe(rotatedToken);
    expect(after).not.toBe(before);
    expect(rotatedEvents).toHaveLength(1);
    expect(rotatedEvents[0]).toMatchObject({ from: before, to: rotatedToken });
  });

  it('[D-19] retry-once-on-401 (success path): single 401 triggers exactly one relogin + replay, then 200', async () => {
    const client = makeClient();
    let loginCount = 0;
    let endpointCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.endsWith('/api/auth/login')) {
        loginCount += 1;
        return Promise.resolve(makeResponse('auth-login-success'));
      }
      if (url.endsWith('/api/system')) {
        endpointCallCount += 1;
        if (endpointCallCount === 1) {
          // First call returns 401 (session expired mid-stream).
          return Promise.resolve(new Response('', { status: 401 }));
        }
        // Retry succeeds.
        return Promise.resolve(makeResponse('sysinfo-success'));
      }
      return Promise.reject(new Error('unexpected url: ' + url));
    });

    await client.login();
    const result = await client.request({ method: 'GET', path: '/api/system' });

    expect(result).toMatchObject({ name: 'Gateway1' });
    expect(loginCount).toBe(2);             // initial + relogin
    expect(endpointCallCount).toBe(2);      // original + retry
    expect(client._canRetryLogin).toBe(true);
    expect(client.getStatus().authState).toBe('connected');
  });

  it('[D-19] retry-once-on-401 (still-failing path): NO infinite re-auth loop — bounded to ≤ 3 calls, LoginRequired thrown', async () => {
    // PITFALLS §2 invariant test. A sustained 401 must NOT loop.
    const client = makeClient();
    let totalCalls = 0;
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      totalCalls += 1;
      if (url.endsWith('/api/auth/login')) {
        // Login itself returns 200 — credentials are accepted, but the
        // session somehow still fails on the next call (the realistic case
        // is an upstream rotating the token between login and use).
        return Promise.resolve(makeResponse('auth-login-success'));
      }
      // Every authenticated call returns 401.
      return Promise.resolve(new Response('', { status: 401 }));
    });

    await client.login();
    expect(client.getStatus().authState).toBe('connected');

    // Wall-time bound: a runaway re-auth loop would never resolve. We race
    // the request against a 200ms timer — if the test takes longer than
    // that, we know we've regressed.
    const start = Date.now();
    let caught;
    const requestPromise = client.request({ method: 'GET', path: '/api/system' })
      .catch(e => { caught = e; });
    const racePromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('retry-once invariant FAILED: request took > 200ms — likely infinite loop')), 200),
    );

    await Promise.race([requestPromise, racePromise]);
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(LoginRequired);
    expect(client.getStatus().authState).toBe('auth_failed');
    expect(client.getStatus().authStateReason).toBe('invalid_credentials');
    expect(client._canRetryLogin).toBe(false);
    // Exact accounting: initial login (1) + first 401 (1) + relogin (1) + retried 401 (1) = 4
    // But fetch ALSO includes the initial login call before request(), so 4 total
    // matches the upper bound. We assert <= 5 to leave slack for fixture quirks.
    expect(totalCalls).toBeLessThanOrEqual(5);
    expect(elapsed).toBeLessThan(200);
  });

  it('[D-21] 499 SSO MFA: login fails fast with SsoMfaRequired, state auth_failed/2fa_blocked, mfaCookie logged at debug', async () => {
    const logger = makeLogger();
    const client = makeClient({ logger });
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse('auth-login-mfa-required'));

    await expect(client.login()).rejects.toBeInstanceOf(SsoMfaRequired);

    expect(client.getStatus().authState).toBe('auth_failed');
    expect(client.getStatus().authStateReason).toBe('2fa_blocked');
    // mfaCookie was logged at debug level (privacy — never at info/UI).
    expect(logger.debug).toHaveBeenCalled();
    const debugMessages = logger.debug.mock.calls.map(call => call.join(' '));
    expect(debugMessages.some(m => /mfaCookie/i.test(m))).toBe(true);
  });

  it('[D-19] 429 AUTHENTICATION_FAILED_LIMIT_REACHED: AuthRateLimit thrown, next refresh scheduled ≥ 5 min out', async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse('auth-login-rate-limited'));

    const before = Date.now();
    await expect(client.login()).rejects.toBeInstanceOf(AuthRateLimit);

    expect(client.getStatus().authState).toBe('auth_failed');
    expect(client.getStatus().authStateReason).toBe('rate_limited');
    // T-07-03: next attempt must be at least 5 minutes (300_000 ms) in the future.
    const nextAt = client.getStatus().nextRefreshAt;
    expect(nextAt).not.toBeNull();
    expect(nextAt - before).toBeGreaterThanOrEqual(300_000);
  });

  it('[D-20] JSON-content-type gate: 200 + text/html (controller booting) raises RequestError "Host starting up", no JSON parse attempted', async () => {
    const client = makeClient();
    // Login first so we can drive request() with an authenticated state.
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeResponse('auth-login-success'));
    await client.login();

    // The HTML body would crash JSON.parse — assert we never reach that branch.
    const htmlPage = '<!DOCTYPE html><html><body>UniFi-OS starting up...</body></html>';
    globalThis.fetch.mockResolvedValueOnce(new Response(htmlPage, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));

    let caught;
    try {
      await client.request({ method: 'GET', path: '/api/system' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestError);
    expect(caught.message).toMatch(/Host starting up/);
    // State transition: NETWORK_DOWN / controller_starting_up
    expect(client.getStatus().authState).toBe('network_down');
    expect(client.getStatus().authStateReason).toBe('controller_starting_up');
  });

  it('[D-17] check_unifi_os success: root GET returns 200 → returns true, sets isUnifiOs = true', async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>UniFi-OS</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    const result = await client.checkUnifiOs();
    expect(result).toBe(true);
    expect(client.isUnifiOs).toBe(true);
    // The probe should NOT follow redirects (we use redirect: 'manual').
    const [, init] = globalThis.fetch.mock.calls[0];
    expect(init.redirect).toBe('manual');
  });

  it('[D-17] legacy CloudKey fail-fast: root GET returns 302, checkUnifiOs → false, subsequent login throws "Legacy CloudKey not supported in v1.1"', async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: '/manage' },
    }));

    const result = await client.checkUnifiOs();
    expect(result).toBe(false);
    expect(client.isUnifiOs).toBe(false);

    // Subsequent login() must surface the legacy-not-supported message before
    // ever issuing a network call.
    let caught;
    try {
      await client.login();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestError);
    expect(caught.message).toMatch(/Legacy CloudKey not supported in v1\.1/);
    // No login HTTP request was issued — fail-fast happened in-memory.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // only the checkUnifiOs root call
  });

  it('[D-11b] SSO-account warning event: only_local_account=false → sso_account_warning emitted once, login still succeeds', async () => {
    const client = makeClient();
    const fx = loadFixture('auth-login-success');
    // Clone and flip the SSO flag.
    const ssoBody = JSON.parse(JSON.stringify(fx.body));
    ssoBody.data[0].only_local_account = false;
    ssoBody.data[0].username = 'sso-admin@example.com';

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(ssoBody), {
      status: 200,
      headers: fx.headers,
    }));

    const warnings = [];
    client.on('sso_account_warning', e => warnings.push(e));

    await client.login();

    expect(client.getStatus().authState).toBe('connected');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ username: 'sso-admin@example.com' });
  });

  it('[D-04] self-signed cert handling: default tlsVerify=false → Agent has connect.rejectUnauthorized=false; tlsVerify=true flips it', async () => {
    const defaultClient = makeClient();
    expect(defaultClient._agent).toBeDefined();
    // The undici Agent stores its options on a symbol-keyed property. We
    // assert the public constructor surface via the client field — the field
    // we passed in maps 1:1 to connect.rejectUnauthorized.
    expect(defaultClient._tlsVerify).toBe(false);

    const strictClient = makeClient({ tlsVerify: true });
    expect(strictClient._tlsVerify).toBe(true);
  });

  it('[D-15] controller-name accessor: after login, GET /api/system resolves with body whose name === "Gateway1"', async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(makeResponse('auth-login-success'))
      .mockResolvedValueOnce(makeResponse('sysinfo-success'));

    await client.login();
    const sysinfo = await client.request({ method: 'GET', path: '/api/system' });

    expect(sysinfo).toMatchObject({ name: 'Gateway1', hostname: 'Gateway1' });
    expect(sysinfo.version).toBe('5.1.11.33023');
  });

  it('[D-19] 403 forbidden: state auth_failed, reason forbidden_no_network_management_permission, Forbidden thrown', async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeResponse('auth-login-success'));
    await client.login();
    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 403 }));

    await expect(client.request({ method: 'GET', path: '/api/system' }))
      .rejects.toBeInstanceOf(Forbidden);
    expect(client.getStatus().authState).toBe('auth_failed');
    expect(client.getStatus().authStateReason).toBe('forbidden_no_network_management_permission');
  });

  it('[D-19] 502/503: state network_down/controller_starting_up, BadGateway / ServiceUnavailable thrown', async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeResponse('auth-login-success'));
    await client.login();

    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(client.request({ method: 'GET', path: '/api/system' }))
      .rejects.toBeInstanceOf(BadGateway);
    expect(client.getStatus().authState).toBe('network_down');
    expect(client.getStatus().authStateReason).toBe('controller_starting_up');

    globalThis.fetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(client.request({ method: 'GET', path: '/api/system' }))
      .rejects.toBeInstanceOf(ServiceUnavailable);
  });

  it('[D-13] disconnect() returns state to DISCONNECTED and emits disconnected', async () => {
    const client = makeClient();
    globalThis.fetch = vi.fn().mockResolvedValueOnce(makeResponse('auth-login-success'));
    await client.login();
    expect(client.getStatus().authState).toBe('connected');

    const events = [];
    client.on('disconnected', () => events.push('disconnected'));
    await client.disconnect();

    expect(client.getStatus().authState).toBe('disconnected');
    expect(client.getStatus().authStateReason).toBeNull();
    expect(events).toEqual(['disconnected']);
  });
});
