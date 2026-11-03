/**
 * UnifiClient — authenticated HTTPS client for the UDM / UniFi-OS controller.
 *
 * Phase 7 foundation consumed by Phases 8–12. Owns:
 *   • Login flow with `rememberMe: true` (D-11, D-18 — 30-day token lifetime)
 *   • tough-cookie@^5 cookie jar (D-22 — partitioned cookie attribute support)
 *   • CSRF capture from `x-csrf-token` + rotation via `x-updated-csrf-token` (D-22)
 *   • HTTP-status → state-machine mapping (D-19, mirrors aiounifi error hierarchy)
 *   • JSON-content-type gate before parsing (D-20 — "Host starting up" case)
 *   • Self-signed TLS via undici Agent `rejectUnauthorized: false` (D-04)
 *   • Retry-once-on-401 via the `_canRetryLogin` flag (D-19, PITFALLS §2 — no infinite loop)
 *   • UniFi-OS-vs-legacy root probe (D-17)
 *   • SSO MFA (HTTP 499) and rate-limit (429 + AUTHENTICATION_FAILED_LIMIT_REACHED) fail-fast (D-19, D-21)
 *   • Exponential-backoff session-refresh loop (base 2s, max 60s)
 *
 * Pattern mirrors plugins/loxone/loxone-ws.js for backoff + EventEmitter +
 * getConnectionStats()-shape lifecycle reporting (D-13).
 *
 * NOT in scope for Phase 7:
 *   • Device discovery / telemetry (Phase 8)
 *   • PoE writes / port_overrides RMW (Phase 9)
 *   • WebSocket event stream (deferred UNIFI-FU)
 *
 */

import { EventEmitter } from 'node:events';
import { CookieJar } from 'tough-cookie';
import { Agent } from 'undici';

// ---------------------------------------------------------------------------
// AUTH_STATE — exactly the 7 substates from D-13. Frozen so callers cannot
// mutate the enum at runtime; the plugin's getStatus() returns these strings
// verbatim and Phase 7's webapp sidebar maps them onto the 3-state dot.
// ---------------------------------------------------------------------------

export const AUTH_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  REFRESHING: 'refreshing',
  AUTH_FAILED: 'auth_failed',                 // reason: invalid_credentials | 2fa_blocked | sso_account_locked | forbidden_no_network_management_permission | rate_limited
  NETWORK_DOWN: 'network_down',               // reason: host_unreachable | tls_handshake_failed | controller_starting_up
  SESSION_EXPIRED_RECOVERING: 'session_expired_recovering',
});

// ---------------------------------------------------------------------------
// Typed errors — surface shape mirrors aiounifi/errors.py so test assertions
// and downstream phases can branch on instanceof rather than message-matching.
// ---------------------------------------------------------------------------

export class LoginRequired extends Error {
  constructor(message = 'Login required') { super(message); this.name = 'LoginRequired'; }
}
export class Forbidden extends Error {
  constructor(message = 'Forbidden') { super(message); this.name = 'Forbidden'; }
}
export class ResponseError extends Error {
  constructor(message = 'Response error', status = 0) { super(message); this.name = 'ResponseError'; this.status = status; }
}
export class AuthRateLimit extends Error {
  constructor(message = 'Authentication rate limit reached') { super(message); this.name = 'AuthRateLimit'; }
}
export class RateLimit extends Error {
  constructor(message = 'Rate limited') { super(message); this.name = 'RateLimit'; }
}
export class SsoMfaRequired extends Error {
  constructor(message = 'SSO MFA required — TOTP not supported in v1.1') { super(message); this.name = 'SsoMfaRequired'; }
}
export class BadGateway extends Error {
  constructor(message = 'Bad gateway — controller starting up') { super(message); this.name = 'BadGateway'; }
}
export class ServiceUnavailable extends Error {
  constructor(message = 'Service unavailable — controller starting up') { super(message); this.name = 'ServiceUnavailable'; }
}
export class RequestError extends Error {
  constructor(message = 'Request error') { super(message); this.name = 'RequestError'; }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REFRESH_BACKOFF_BASE_MS = 2_000;
const REFRESH_BACKOFF_MAX_MS = 60_000;
// Floor enforced after the 429 AUTHENTICATION_FAILED_LIMIT_REACHED case (D-19,
// T-07-03 mitigation). Five minutes prevents us from burning the controller's
// login-attempt budget when credentials are wrong.
const RATE_LIMIT_BACKOFF_FLOOR_MS = 300_000;

// ---------------------------------------------------------------------------
// UnifiClient
// ---------------------------------------------------------------------------

export class UnifiClient extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.host         Hostname or IP of the UDM (e.g. "192.0.2.1").
   * @param {string} opts.username     Local-admin username.
   * @param {string} opts.password     Local-admin password.
   * @param {string} [opts.site='default']
   * @param {boolean} [opts.tlsVerify=false]   Default false — UDM self-signed cert (D-04).
   * @param {boolean} [opts.rememberMe=true]   Default true — 30-day token lifetime (D-11, D-18).
   * @param {Object}  [opts.logger]            { info, warn, error, debug } compatible logger.
   */
  constructor({
    host,
    username,
    password,
    site = 'default',
    tlsVerify = false,
    rememberMe = true,
    logger,
  } = {}) {
    super();

    if (!host) throw new Error('UnifiClient: host is required');
    if (!username) throw new Error('UnifiClient: username is required');
    if (!password) throw new Error('UnifiClient: password is required');

    this._host = host;
    this._username = username;
    this._password = password;
    this._site = site;
    this._tlsVerify = tlsVerify;
    this._rememberMe = rememberMe;

    this._log = logger ? logger : {
      info: (...a) => console.log('[unifi]', ...a),
      warn: (...a) => console.warn('[unifi]', ...a),
      error: (...a) => console.error('[unifi]', ...a),
      debug: () => {},
    };

    // Cookie jar (tough-cookie@^5 supports partitioned natively per D-22).
    this._jar = new CookieJar();

    // undici Agent — single dispatcher per client, controls TLS verification.
    // D-04: rejectUnauthorized:false is the v1.1 default for the self-signed UDM cert.
    this._agent = new Agent({
      connect: { rejectUnauthorized: this._tlsVerify },
    });

    // Headers we maintain side-by-side with the cookie jar. CSRF token mirrors
    // into here every time _updateHeaders sees a fresh x-csrf-token or
    // x-updated-csrf-token (D-22). The static Cookie header is also maintained
    // for the WebSocket integration in later phases.
    this._headers = {
      'x-csrf-token': null,
    };

    // Auth state machine (D-13).
    this._authState = AUTH_STATE.DISCONNECTED;
    this._authStateReason = null;

    // PITFALLS §2 + D-19 invariant: exactly one retry per logical call. The
    // flag is flipped to false BEFORE the relogin attempt and reset to true
    // only after the retry succeeds. A sustained 401 therefore cannot loop.
    this._canRetryLogin = true;

    // UniFi-OS-vs-legacy detection cache (D-17). Filled by checkUnifiOs().
    this._isUnifiOs = null;

    // Refresh loop state.
    this._refreshTimer = null;
    this._shouldRefresh = false;
    this._refreshAttempt = 0;
    this._nextRefreshAt = null;

    // Lifecycle telemetry — mirrors loxone-ws getConnectionStats() shape.
    this._lastLoginAt = null;
    this._lastCsrfRotationAt = null;
    this._totalLogins = 0;
  }

  // -------------------------------------------------------------------------
  // Public surface — lifecycle accessors
  // -------------------------------------------------------------------------

  get host() { return this._host; }
  get site() { return this._site; }
  get isUnifiOs() { return this._isUnifiOs; }

  /**
   * Snapshot of auth state + lifecycle stats. Additive to PluginManager's
   * existing getStatus() contract — plugin layer merges this into its own
   * return value in plan 07-02.
   */
  getStatus() {
    return {
      authState: this._authState,
      authStateReason: this._authStateReason,
      host: this._host,
      site: this._site,
      lastLoginAt: this._lastLoginAt,
      lastCsrfRotationAt: this._lastCsrfRotationAt,
      totalLogins: this._totalLogins,
      currentRefreshAttempt: this._refreshAttempt,
      nextRefreshAt: this._nextRefreshAt,
      isUnifiOs: this._isUnifiOs,
    };
  }

  // -------------------------------------------------------------------------
  // checkUnifiOs — D-17 root probe
  // -------------------------------------------------------------------------

  /**
   * Probe the root URL to distinguish UniFi-OS (HTTP 200) from legacy CloudKey
   * (3xx redirect). Result cached on `_isUnifiOs`.
   *
   * @returns {Promise<boolean>} true if UniFi-OS, false if legacy.
   */
  async checkUnifiOs() {
    const url = `https://${this._host}/`;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        dispatcher: this._agent,
      });
    } catch (err) {
      this._mapNetworkErrorToState(err);
      throw err;
    }

    // 200 OK ⇒ UniFi-OS landing page. 3xx Location: /manage ⇒ legacy CloudKey.
    if (res.status === 200) {
      this._isUnifiOs = true;
      return true;
    }
    if (res.status >= 300 && res.status < 400) {
      this._isUnifiOs = false;
      return false;
    }
    // Anything else is anomalous — treat as legacy / unknown.
    this._isUnifiOs = false;
    return false;
  }

  // -------------------------------------------------------------------------
  // login — D-01, D-18, D-19, D-21, D-22
  // -------------------------------------------------------------------------

  /**
   * Authenticate against `/api/auth/login` and capture the session cookie +
   * CSRF token. Mutates `_authState` and emits `'connected'` on success.
   *
   * @returns {Promise<void>}
   * @throws  {SsoMfaRequired | AuthRateLimit | LoginRequired | RequestError | ResponseError}
   */
  async login() {
    // D-17: Legacy CloudKey is explicitly out of scope in v1.1. If a previous
    // checkUnifiOs() concluded legacy, fail fast with a discoverable message —
    // the test suite asserts on this exact substring.
    if (this._isUnifiOs === false) {
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = 'invalid_credentials';
      throw new RequestError('Legacy CloudKey not supported in v1.1');
    }

    // CONNECTING is the visible "login in flight" state on the detail page.
    // Preserve any prior reason so consumers can still see *why* a previous
    // attempt failed while a fresh one is mid-flight.
    if (this._authState !== AUTH_STATE.SESSION_EXPIRED_RECOVERING) {
      this._authState = AUTH_STATE.CONNECTING;
      this._authStateReason = null;
    }

    const url = `https://${this._host}/api/auth/login`;
    const body = JSON.stringify({
      username: this._username,
      password: this._password,
      rememberMe: this._rememberMe,
    });

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        dispatcher: this._agent,
        redirect: 'manual',
      });
    } catch (err) {
      this._mapNetworkErrorToState(err);
      throw err;
    }

    // -- Branch on HTTP status (D-19) -------------------------------------------------

    if (res.status === 200) {
      // Capture cookies into the jar so downstream request() reads them via
      // jar.getCookieString(). The login endpoint's TOKEN cookie is the only
      // session bearer.
      await this._absorbSetCookies(res, url);

      // CSRF: D-22 — read BOTH headers. On first login they tend to be equal
      // but rotation begins on subsequent calls; treat either as canonical.
      this._updateHeaders(res);

      // JSON-content-type gate (D-20). The controller occasionally serves the
      // UniFi-OS setup HTML during boot; never let JSON.parse fail silently.
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        this._authState = AUTH_STATE.NETWORK_DOWN;
        this._authStateReason = 'controller_starting_up';
        throw new RequestError('Host starting up');
      }

      let payload;
      try {
        payload = await res.json();
      } catch (err) {
        throw new RequestError(`Failed to parse login response JSON: ${err.message}`);
      }

      // Success — flip state + reset retry budget + announce.
      this._authState = AUTH_STATE.CONNECTED;
      this._authStateReason = null;
      this._canRetryLogin = true;
      this._lastLoginAt = Date.now();
      this._totalLogins += 1;
      this._refreshAttempt = 0;

      // D-11b: surface the SSO-account warning when the authenticated principal
      // is not a local-only admin. Login itself still succeeds — this is
      // informational so the config UI can show an orange banner.
      const userRecord = Array.isArray(payload?.data) ? payload.data[0] : null;
      if (userRecord && userRecord.only_local_account === false) {
        this.emit('sso_account_warning', { username: userRecord.username });
      }

      this.emit('connected');
      return;
    }

    if (res.status === 401) {
      // First-time 401 on login is "credentials are wrong" — there is no
      // upstream call to retry, so AUTH_FAILED is terminal here. The retry
      // dance lives in request(), not login() (D-19).
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = 'invalid_credentials';
      throw new LoginRequired('Login refused — invalid credentials');
    }

    if (res.status === 403) {
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = 'forbidden_no_network_management_permission';
      throw new Forbidden('Login refused — missing network.management permission');
    }

    if (res.status === 429) {
      const payload = await this._safeReadJson(res);
      const code = payload?.meta?.code;
      if (code === 'AUTHENTICATION_FAILED_LIMIT_REACHED') {
        this._authState = AUTH_STATE.AUTH_FAILED;
        this._authStateReason = 'rate_limited';
        // T-07-03: schedule the next refresh ≥ 5 min out.
        this._nextRefreshAt = Date.now() + RATE_LIMIT_BACKOFF_FLOOR_MS;
        throw new AuthRateLimit('Login rate-limit reached — back off ≥ 5 min');
      }
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = 'rate_limited';
      throw new RateLimit('Login rate-limited (generic 429)');
    }

    if (res.status === 499) {
      // SSO MFA (D-21). Log mfaCookie at DEBUG only — never echo to UI / config.
      const payload = await this._safeReadJson(res);
      const mfaCookie = payload?.mfaCookie;
      if (mfaCookie && this._log.debug) {
        this._log.debug(`[unifi] SSO MFA challenged, mfaCookie=${String(mfaCookie).slice(0, 12)}…`);
      }
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = '2fa_blocked';
      throw new SsoMfaRequired('SSO MFA required — TOTP not supported in v1.1');
    }

    if (res.status === 502) {
      this._authState = AUTH_STATE.NETWORK_DOWN;
      this._authStateReason = 'controller_starting_up';
      throw new BadGateway();
    }
    if (res.status === 503) {
      this._authState = AUTH_STATE.NETWORK_DOWN;
      this._authStateReason = 'controller_starting_up';
      throw new ServiceUnavailable();
    }

    // Unknown status — surface as ResponseError, no state mutation beyond
    // returning the caller to a coherent error path.
    this._authState = AUTH_STATE.AUTH_FAILED;
    this._authStateReason = 'invalid_credentials';
    throw new ResponseError(`Unexpected login status ${res.status}`, res.status);
  }

  // -------------------------------------------------------------------------
  // request — D-19 + D-20 + D-22 + retry-once invariant
  // -------------------------------------------------------------------------

  /**
   * Issue an authenticated API call with cookie + CSRF headers.
   *
   * Implements the retry-once-on-401 contract (D-19, PITFALLS §2): a single
   * 401 triggers exactly one re-auth + replay. A sustained 401 terminates with
   * `LoginRequired` and leaves `_authState = auth_failed`. The `_canRetryLogin`
   * flag is the sole gate — flipped to `false` before relogin, reset to `true`
   * only on subsequent SUCCESS.
   *
   * @param {Object} apiRequest
   * @param {string} apiRequest.method
   * @param {string} apiRequest.path     URL path (e.g. "/api/system").
   * @param {*}      [apiRequest.body]   Optional JSON body for POST/PUT.
   * @returns {Promise<*>} Parsed JSON body of the response.
   */
  async request(apiRequest) {
    return this._requestOnce(apiRequest, /* isRetry */ false);
  }

  async _requestOnce(apiRequest, isRetry) {
    const { method, path, body } = apiRequest;
    const url = `https://${this._host}${path}`;

    const cookieHeader = await this._jar.getCookieString(url);
    const headers = {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      ...(this._headers['x-csrf-token'] ? { 'x-csrf-token': this._headers['x-csrf-token'] } : {}),
    };

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        dispatcher: this._agent,
        redirect: 'manual',
      });
    } catch (err) {
      this._mapNetworkErrorToState(err);
      throw err;
    }

    // Always check for CSRF rotation, even on error responses (D-22).
    this._updateHeaders(res);
    // Absorb any Set-Cookie rotation (rare but possible mid-stream).
    await this._absorbSetCookies(res, url);

    // -- Status mapping (D-19) --------------------------------------------------------

    if (res.status === 200 || res.status === 201) {
      // D-20: JSON-content-type gate BEFORE JSON.parse. Controllers serving
      // HTML during reboot produce a parse error that looks like our bug.
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        this._authState = AUTH_STATE.NETWORK_DOWN;
        this._authStateReason = 'controller_starting_up';
        throw new RequestError('Host starting up');
      }
      // Reset the retry budget on every successful authenticated call.
      this._canRetryLogin = true;
      return res.json();
    }

    if (res.status === 401) {
      // D-19 retry-once invariant. The flag is the entire safety guarantee.
      if (this._canRetryLogin && !isRetry) {
        this._canRetryLogin = false;
        this._authState = AUTH_STATE.SESSION_EXPIRED_RECOVERING;
        this._authStateReason = null;
        try {
          await this.login();
        } catch (loginErr) {
          // Login failed — propagate the typed error from login().
          // _authState is already set to AUTH_FAILED by login() itself.
          throw loginErr;
        }
        // Replay the original call ONCE. _canRetryLogin stays false until
        // the replay succeeds (handled at the top of this method's 200 branch).
        return this._requestOnce(apiRequest, /* isRetry */ true);
      }
      // Either this IS the retry, or _canRetryLogin was already false (a
      // prior call in flight is racing us). Terminal AUTH_FAILED.
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = 'invalid_credentials';
      this._canRetryLogin = false;
      throw new LoginRequired('Re-authentication failed — still 401 after relogin');
    }

    if (res.status === 403) {
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = 'forbidden_no_network_management_permission';
      throw new Forbidden();
    }

    if (res.status === 404) {
      throw new ResponseError(`404 Not Found: ${method} ${path}`, 404);
    }

    if (res.status === 429) {
      const payload = await this._safeReadJson(res);
      const code = payload?.meta?.code;
      if (code === 'AUTHENTICATION_FAILED_LIMIT_REACHED') {
        this._authState = AUTH_STATE.AUTH_FAILED;
        this._authStateReason = 'rate_limited';
        this._nextRefreshAt = Date.now() + RATE_LIMIT_BACKOFF_FLOOR_MS;
        throw new AuthRateLimit('Authentication rate-limit reached');
      }
      throw new RateLimit('Rate limited');
    }

    if (res.status === 499) {
      this._authState = AUTH_STATE.AUTH_FAILED;
      this._authStateReason = '2fa_blocked';
      throw new SsoMfaRequired();
    }

    if (res.status === 502) {
      this._authState = AUTH_STATE.NETWORK_DOWN;
      this._authStateReason = 'controller_starting_up';
      throw new BadGateway();
    }
    if (res.status === 503) {
      this._authState = AUTH_STATE.NETWORK_DOWN;
      this._authStateReason = 'controller_starting_up';
      throw new ServiceUnavailable();
    }

    throw new ResponseError(`Unexpected status ${res.status}: ${method} ${path}`, res.status);
  }

  // -------------------------------------------------------------------------
  // _updateHeaders — D-22 CSRF rotation
  // -------------------------------------------------------------------------

  /**
   * Read `x-csrf-token` AND `x-updated-csrf-token` from a Response. If either
   * is present and differs from the current cached token, replace and emit
   * `'csrf_rotated'`. Idempotent — repeated calls with the same headers are
   * no-ops.
   *
   * @param {Response} response
   */
  _updateHeaders(response) {
    const fromX = response.headers.get('x-csrf-token');
    const fromUpdated = response.headers.get('x-updated-csrf-token');
    // Prefer the rotated value if present — UniFi-OS sends the *new* token in
    // `x-updated-csrf-token` while still echoing the old one in `x-csrf-token`.
    const next = fromUpdated || fromX;
    if (!next) return;
    if (next === this._headers['x-csrf-token']) return;
    const prev = this._headers['x-csrf-token'];
    this._headers['x-csrf-token'] = next;
    this._lastCsrfRotationAt = Date.now();
    // Only emit `'csrf_rotated'` for an actual rotation (prev existed and
    // differs). The very first capture from login is a normal initial set,
    // not a rotation event — downstream listeners (Phase 8's WS bridge) only
    // need to react when the token *changes* mid-session.
    if (prev) {
      this.emit('csrf_rotated', { from: prev, to: next });
    }
  }

  // -------------------------------------------------------------------------
  // disconnect — clean teardown
  // -------------------------------------------------------------------------

  /**
   * Stop the refresh loop and reset to DISCONNECTED.
   */
  async disconnect() {
    this._shouldRefresh = false;
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    this._authState = AUTH_STATE.DISCONNECTED;
    this._authStateReason = null;
    this._nextRefreshAt = null;
    try { this._agent.close?.(); } catch { /* best-effort */ }
    this.emit('disconnected');
  }

  // -------------------------------------------------------------------------
  // Refresh loop — exponential backoff (base 2s, max 60s) per D-19 + Claude's discretion
  // -------------------------------------------------------------------------

  /**
   * Start the proactive refresh / failure-recovery loop. Idempotent — repeat
   * calls are no-ops if a timer is already armed.
   */
  _startRefreshLoop() {
    if (this._refreshTimer) return;
    this._shouldRefresh = true;
    this._armRefreshTimer();
  }

  _armRefreshTimer() {
    const delay = this._calcBackoff(this._refreshAttempt);
    this._refreshAttempt += 1;
    this._nextRefreshAt = Date.now() + delay;
    this._refreshTimer = setTimeout(async () => {
      this._refreshTimer = null;
      if (!this._shouldRefresh) return;
      this._authState = AUTH_STATE.REFRESHING;
      try {
        await this.login();
        // Success resets the attempt counter so the next backoff window starts
        // small again.
        this._refreshAttempt = 0;
      } catch {
        // login() already logged + set _authState. If we should keep trying,
        // arm the next tick — unless we hit the rate-limit floor, in which case
        // login() already pushed _nextRefreshAt out by 5 min and we honour that.
        if (this._shouldRefresh) {
          if (this._nextRefreshAt && this._nextRefreshAt > Date.now() + this._calcBackoff(this._refreshAttempt)) {
            // Defer to the rate-limit floor (T-07-03).
            const floorDelay = this._nextRefreshAt - Date.now();
            this._refreshTimer = setTimeout(() => this._armRefreshTimer(), floorDelay);
            return;
          }
          this._armRefreshTimer();
        }
      }
    }, delay);
  }

  /**
   * Exponential backoff with jitter — mirrors loxone-ws._calcBackoff shape but
   * with base 2s / max 60s tuned for the HTTP refresh-loop use case.
   *
   * @param {number} attempt
   * @returns {number} delay in ms
   */
  _calcBackoff(attempt) {
    const base = Math.min(REFRESH_BACKOFF_BASE_MS * Math.pow(2, attempt), REFRESH_BACKOFF_MAX_MS);
    const jitter = Math.floor(Math.random() * 1000);
    return base + jitter;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Persist all `Set-Cookie` headers from a response into the cookie jar.
   * Uses `getSetCookie()` (Node 20+) to handle the multi-header case; falls
   * back to the legacy comma-joined string if needed.
   *
   * @param {Response} response
   * @param {string} url        Origin URL the response was issued against.
   */
  async _absorbSetCookies(response, url) {
    let cookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
      cookies = response.headers.getSetCookie() || [];
    } else {
      const raw = response.headers.get('set-cookie');
      if (raw) cookies = [raw];
    }
    for (const c of cookies) {
      try {
        await this._jar.setCookie(c, url);
      } catch {
        // Malformed cookie — skip, do not break the whole login.
      }
    }
  }

  /**
   * Try to parse a response body as JSON without throwing on parse error.
   * Used in error-path branches where the body shape is advisory only.
   *
   * @param {Response} response
   * @returns {Promise<any>}
   */
  async _safeReadJson(response) {
    try {
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Translate a Node-level fetch error (TLS/DNS/conn) into an _authState
   * transition. Called from the catch of every outbound fetch.
   *
   * @param {Error & { code?: string, cause?: { code?: string } }} err
   */
  _mapNetworkErrorToState(err) {
    const code = err?.code || err?.cause?.code || '';
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
      this._authState = AUTH_STATE.NETWORK_DOWN;
      this._authStateReason = 'host_unreachable';
      return;
    }
    if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN')) {
      this._authState = AUTH_STATE.NETWORK_DOWN;
      this._authStateReason = 'tls_handshake_failed';
      return;
    }
    // Default: treat as host_unreachable so the refresh loop backs off rather
    // than slamming a clearly-broken target.
    this._authState = AUTH_STATE.NETWORK_DOWN;
    this._authStateReason = 'host_unreachable';
  }
}
