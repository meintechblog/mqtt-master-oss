/*
 * Parts of this file are ported from two MIT-licensed projects:
 *
 *   - TA2k/ioBroker.dreame (main.js)
 *     Copyright (c) 2024-2026 TA2k <tombox2020@gmail.com>
 *   - Tasshack/dreame-vacuum
 *     (custom_components/dreame_vacuum/dreame/protocol.py, const.py, types.py)
 *     Copyright (c) 2022 Tasshack
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Dreamehome cloud client (login, token refresh, device list, MIOT RPC,
 * cloud MQTT push). Transport is injected (`fetch`, `mqttConnect`) so the
 * whole client runs against mocks in tests; nothing here talks to the network
 * on its own.
 *
 * Where the protocol values come from
 * -----------------------------------
 * Tasshack's protocol.py keeps its endpoint and header strings in
 * `DREAME_STRINGS`, a base64 + gzip blob holding a JSON list. We decoded it
 * once offline (base64 -> gzip -> JSON) and inline only the entries this
 * plugin needs; the index into that list is given next to each constant
 * (`S[n]`). The ioBroker.dreame adapter (main.js, BRAND_CONFIG / login() /
 * refreshToken() / sendCommand() / connectMqtt()) uses the same values in
 * clear text, which is how the decoded entries were cross-checked.
 *
 * Never logged or published: password, MD5 hash, refresh key, access token,
 * device id (did), serial, MAC, account uid. Every error message is built from
 * a status / numeric code only (never from a response body or request data),
 * and everything that reaches a logger additionally passes through `redact()`.
 */
import { createHash, createCipheriv, randomBytes } from 'node:crypto';

// ---- Constants decoded from DREAME_STRINGS (account type "dreame") ----------
const HOST_SUFFIX = '.iot.dreame.tech'; // S[0]; full host = <country> + suffix
// push broker from the device list (bindDomain): host below HOST_SUFFIX, optional port, nothing else
const PUSH_HOST = /^(?:[a-z0-9-]+\.)+iot\.dreame\.tech(?::\d{1,5})?$/i;
const PORT = 13267; // S[1]
const PASSWORD_SALT = 'RAylYC%fmSKp7%Tq'; // S[2], appended to the password before MD5
const BASIC_AUTH = 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg='; // S[4]
const DEFAULT_TENANT = '000000'; // S[5]
const TOKEN_PATH = '/dreame-auth/oauth/token'; // S[12]
const LIST_PATH = '/dreame-user-iot/iotuserbind/device/listV2'; // S[18]/S[19]/S[22]/S[23]
const COMMAND_PATH = (prefix) => `/dreame-iot-com-${prefix}/device/sendCommand`; // S[32]/S[22]/S[33]
const USER_AGENT = 'Dart/3.9 (dart:io)'; // S[79]
const META = 'cv=a_102060300'; // S[59] + S[65]
const SIGN_KEY = 'EETjszu*XI5znHsI'; // S[55], key for the request signature and the rlc header
const GRANT_PASSWORD = 'grant_type=password&scope=all&platform=ANDROID&type=account&username='; // S[74]
const GRANT_REFRESH = 'grant_type=refresh_token&scope=all&platform=ANDROID&type=account&refresh_token='; // S[77]
const DEFAULT_PREFIX = '10000'; // iotCom prefix of the dreame brand in ioBroker.dreame BRAND_CONFIG

const REFRESH_MARGIN_MS = 10 * 60 * 1000; // protocol.py _refresh_expired_key: refresh within 600 s of expiry
const OFFLINE_CODES = new Set([80001, -8]); // sendCommand: device did not answer (main.js / protocol.py)

export class DreameCloudError extends Error {
  /** @param {string} message sanitized text (status / code only) */
  constructor(message, { status, code, renewed } = {}) {
    super(message);
    this.renewed = renewed === true;
    this.name = 'DreameCloudError';
    this.status = status;
    this.code = code;
  }
}

const md5 = (s) => createHash('md5').update(s).digest('hex');

/**
 * Request signature input, ported from `_spliced` in protocol.py: keys sorted,
 * nested dicts as `k=[...]`, lists only at the top level, nested scalars
 * JSON-encoded.
 */
function splice(obj, top) {
  const parts = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const inner = splice(v, false);
      parts.push(inner ? `${k}=[${inner}]` : `${k}=]`);
    } else if (Array.isArray(v)) {
      if (top) parts.push(`${k}=${JSON.stringify(v)}`);
    } else if (typeof v === 'boolean') {
      parts.push(`${k}=${v ? 'true' : 'false'}`);
    } else if (v === null || v === undefined) {
      parts.push(`${k}=null`);
    } else if (top) {
      parts.push(`${k}=${v}`);
    } else {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return parts.join('&');
}

/** API codes are shown only when they are integers; anything else may echo request data. */
const safeCode = (c) => (Number.isInteger(c) ? c : undefined);

/** Only short upper-case codes such as ECONNRESET are safe to show. */
function netErrorLabel(err) {
  const code = err && typeof err.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(err.code) ? err.code : null;
  if (code) return code;
  if (err && err.name === 'TimeoutError') return 'timeout';
  return 'error';
}

export class DreameCloud {
  /**
   * @param {object} opts
   * @param {string} opts.username
   * @param {string} [opts.password] fallback only; the refresh key is preferred
   * @param {string} [opts.refreshToken] stored refresh key
   * @param {string} [opts.country='eu']
   * @param {(url: string, init: object) => Promise<Response>} [opts.fetch]
   * @param {(url: string, opts: object) => object} [opts.mqttConnect] mqtt.js-like connect
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {number} [opts.retries=2] retries for network errors / 429 / 5xx
   * @param {number} [opts.timeoutMs=10000]
   * @param {boolean} [opts.tlsVerify=true] verify the broker certificate of the push connection
   * @param {(token: string) => void} [opts.onRefreshToken] called whenever a new refresh key arrives
   */
  constructor(opts) {
    this._username = opts.username;
    this._password = opts.password || null;
    this._refreshToken = opts.refreshToken || null;
    this._country = /^[a-z]{2}$/i.test(opts.country || '') ? opts.country.toLowerCase() : 'eu';
    this._fetch = opts.fetch || globalThis.fetch;
    this._mqttConnect = opts.mqttConnect || null;
    this._logger = opts.logger || null;
    this._now = opts.now || Date.now;
    this._sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._retries = opts.retries ?? 2;
    this._timeoutMs = opts.timeoutMs ?? 10_000;
    this._tlsVerify = opts.tlsVerify !== false;
    this._onRefreshToken = opts.onRefreshToken || null;

    this._accessToken = null;
    this._expiresAt = 0;
    this._uid = null;
    this._region = null;
    this._lang = null;
    this._ccode = null;
    this._tenant = null;
    this._loggedIn = false;
    this._authFailed = false;
    this._loginPromise = null;
    this._id = 1 + Math.floor(Math.random() * 100); // protocol.py starts at random 1..100

    this._secrets = new Set();
    this._addSecret(this._password);
    this._addSecret(this._refreshToken);
    this._addSecret(this._username);
    if (this._password) this._addSecret(md5(this._password + PASSWORD_SALT));

    this._push = null; // { devices, handler, clients }
    this._closed = false;
    this._abort = new AbortController(); // close() aborts every call in flight
  }

  // ---- state ---------------------------------------------------------------

  isLoggedIn() { return this._loggedIn; }
  get closed() { return this._closed; }

  /**
   * Final shutdown: abort calls in flight, suppress their retries, end push.
   * Every later call fails; a restart creates a new client.
   */
  close() {
    this._closed = true;
    this._loggedIn = false;
    this._abort.abort();
    this.stopPush();
  }
  get authFailed() { return this._authFailed; }

  _addSecret(v) {
    if (typeof v === 'string' && v.length >= 3) this._secrets.add(v);
  }

  /** Remove every known secret from a string (defence in depth for log lines). */
  redact(text) {
    let out = String(text);
    for (const s of [...this._secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(s).join('[redacted]');
    }
    return out;
  }

  _log(level, msg) {
    const fn = this._logger && this._logger[level];
    if (fn) fn.call(this._logger, this.redact(msg));
  }

  // ---- HTTP ----------------------------------------------------------------

  _baseUrl() {
    return `https://${this._country}${HOST_SUFFIX}:${PORT}`;
  }

  _headers(contentType, withAuth) {
    const h = {
      'user-agent': USER_AGENT,
      'dreame-meta': META,
      'tenant-id': this._tenant || DEFAULT_TENANT,
      authorization: BASIC_AUTH,
      'content-type': contentType,
    };
    if (this._region && this._lang && this._ccode) {
      // AES-128-ECB (PKCS7) of "region|lang|country" with SIGN_KEY, base64 (protocol.py _base_headers)
      const c = createCipheriv('aes-128-ecb', Buffer.from(SIGN_KEY, 'utf8'), null);
      h['dreame-rlc'] = Buffer.concat([
        c.update(`${this._region}|${this._lang}|${this._ccode}`, 'utf8'), c.final(),
      ]).toString('base64');
    }
    // unbelegt: Tasshack sends the raw token in "dreame-auth", ioBroker.dreame sends "bearer <token>".
    // The ioBroker form is used because it is the one verified in a published adapter.
    if (withAuth && this._accessToken) h['dreame-auth'] = `bearer ${this._accessToken}`;
    return h;
  }

  /**
   * POST with retry on network errors, 429 and 5xx. Returns { status, text }.
   * `idempotent: false` (robot actions) never retries: after a timeout or a
   * gateway error the request may already have reached the robot.
   */
  async _post(path, headers, body, { idempotent = true } = {}) {
    let lastError = null;
    const retries = idempotent ? this._retries : 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await this._sleep(Math.min(500 * 2 ** (attempt - 1), 2000));
      if (this._closed) throw new DreameCloudError('client closed');
      let res;
      try {
        res = await this._fetch(this._baseUrl() + path, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.any([this._abort.signal, AbortSignal.timeout(this._timeoutMs)]),
        });
      } catch (err) {
        if (this._closed) throw new DreameCloudError('client closed');
        lastError = new DreameCloudError(`network ${netErrorLabel(err)}`);
        continue;
      }
      if ([429, 502, 503, 504].includes(res.status) && attempt < retries) {
        lastError = new DreameCloudError(`HTTP ${res.status}`, { status: res.status });
        continue;
      }
      let text = '';
      try { text = await res.text(); } catch { /* body is optional */ }
      return { status: res.status, text };
    }
    throw lastError || new DreameCloudError('request failed');
  }

  _sign(params) {
    const ms = this._now();
    const sign = md5(splice(params, true) + String(ms) + SIGN_KEY);
    return { ...params, sign, timestamp: ms };
  }

  // ---- login / refresh -----------------------------------------------------

  /**
   * Log in with the refresh key when one is stored, otherwise (or when the key
   * is rejected) with username + MD5 password. Never throws for credential or
   * server problems; returns the logged-in flag.
   */
  login() {
    if (!this._loginPromise) {
      this._loginPromise = this._login().finally(() => { this._loginPromise = null; });
    }
    return this._loginPromise;
  }

  async _login() {
    this._authFailed = false;
    const useRefresh = Boolean(this._refreshToken);
    let ok = await this._tokenRequest(useRefresh ? 'refresh' : 'password');
    if (!ok && useRefresh && this._password && this._authFailed) {
      this._log('info', 'Dreame cloud: refresh key rejected, using the stored password once');
      this._refreshToken = null;
      this._authFailed = false;
      ok = await this._tokenRequest('password');
    }
    return ok;
  }

  async _tokenRequest(kind) {
    let body;
    if (kind === 'refresh') {
      body = `${GRANT_REFRESH}${encodeURIComponent(this._refreshToken)}`;
    } else {
      if (!this._password) {
        this._loggedIn = false;
        this._authFailed = true;
        this._log('error', 'Dreame cloud: no password and no refresh key available');
        return false;
      }
      body = `${GRANT_PASSWORD}${encodeURIComponent(this._username)}&password=${md5(this._password + PASSWORD_SALT)}`;
      // unbelegt: ioBroker.dreame also sends &country=DE&lang=de on the first login; protocol.py only
      // appends them once the server has told us its values. We follow protocol.py.
      if (this._ccode && this._lang) body += `&country=${encodeURIComponent(this._ccode)}&lang=${encodeURIComponent(this._lang)}`;
    }
    let res;
    try {
      res = await this._post(TOKEN_PATH, this._headers('application/x-www-form-urlencoded', false), body);
    } catch (err) {
      this._loggedIn = false;
      this._log('warn', `Dreame cloud: login failed (${err.message})`);
      return false;
    }
    if (res.status === 200) {
      let data;
      try { data = JSON.parse(res.text); } catch { data = null; }
      if (data && typeof data.access_token === 'string') {
        this._accessToken = data.access_token;
        this._addSecret(data.access_token);
        if (typeof data.refresh_token === 'string') {
          const changed = data.refresh_token !== this._refreshToken;
          this._refreshToken = data.refresh_token;
          this._addSecret(data.refresh_token);
          if (changed && this._onRefreshToken) {
            try { this._onRefreshToken(data.refresh_token); } catch { /* persisting is best effort */ }
          }
        }
        this._expiresAt = this._now() + (Number(data.expires_in) || 3600) * 1000;
        this._uid = data.uid ?? this._uid;
        this._addSecret(this._uid);
        this._region = data.region ?? this._region;
        this._lang = data.lang ?? this._lang;
        this._ccode = data.country ?? this._ccode;
        this._tenant = data.tenant_id ?? this._tenant;
        this._loggedIn = true;
        this._authFailed = false;
        if (this._push) this._restartPush();
        return true;
      }
      this._loggedIn = false;
      this._log('warn', 'Dreame cloud: login answered without a token');
      return false;
    }
    this._loggedIn = false;
    if ([400, 401, 403].includes(res.status)) {
      this._authFailed = true;
      this._log('error', `Dreame cloud: login refused (HTTP ${res.status})`);
    } else {
      // server side problems or rate limits are not credential errors (protocol.py login())
      this._log('warn', `Dreame cloud: login failed (HTTP ${res.status})`);
    }
    return false;
  }

  async _ensureFresh() {
    if (!this._loggedIn) return;
    if (this._expiresAt - this._now() <= REFRESH_MARGIN_MS) await this.login();
  }

  // ---- API calls -----------------------------------------------------------

  async _api(path, params, retried = false, postOpts = {}) {
    await this._ensureFresh();
    if (!this._loggedIn) throw new DreameCloudError('not logged in');
    const body = JSON.stringify(this._sign(params));
    const res = await this._post(path, this._headers('application/json', true), body, postOpts);
    if (res.status === 200) {
      try { return JSON.parse(res.text); } catch { throw new DreameCloudError('invalid response'); }
    }
    if (res.status === 401) {
      let code;
      try { code = JSON.parse(res.text).code; } catch { code = undefined; }
      const expired = code === undefined || code === 401; // protocol.py _auth_failure()
      // Any 401 renews the session once. Only a refused login or a fresh token that
      // is refused at once (retried) means the credentials are bad; a foreign code alone does not.
      if (!retried && (await this.login())) {
        // a 401 with a foreign code is no proof that the call was not processed: actions are never repeated
        if (expired || postOpts.idempotent !== false) return this._api(path, params, true, postOpts);
        throw new DreameCloudError('session renewed, action not repeated', { status: 401, renewed: true });
      }
      this._loggedIn = false;
      // A failed re-login sets authFailed itself, but only for a credential refusal
      // (400/401/403). A 503, 429 or network error keeps the next poll retrying.
      if (retried) this._authFailed = true;
      throw new DreameCloudError('session invalid', { status: 401 });
    }
    throw new DreameCloudError(`HTTP ${res.status}`, { status: res.status });
  }

  /** @returns {Promise<Array<object>>} normalised device records */
  async listDevices() {
    const res = await this._api(LIST_PATH, { sharedStatus: 1, current: 1, size: 100, lang: this._lang || 'en' });
    const records = res && res.code === 0 && res.data && res.data.page && res.data.page.records;
    if (!Array.isArray(records)) {
      const code = safeCode(res?.code);
      throw new DreameCloudError(`API code ${res ? (code ?? 'invalid') : 'none'}`, { code });
    }
    return records.map((r) => {
      const bind = typeof r.bindDomain === 'string' ? r.bindDomain : '';
      const device = {
        did: String(r.did),
        model: r.model,
        name: r.customName || (r.deviceInfo && r.deviceInfo.displayName) || r.model,
        uid: r.masterUid ?? this._uid,
        mac: r.mac,
        bindDomain: bind,
        prefix: /^\d+$/.test(bind.split('.')[0]) ? bind.split('.')[0] : DEFAULT_PREFIX,
        // listV2 carries the current status code and battery (ioBroker.dreame _bridgeStatusSummary)
        latestStatus: r.latestStatus ?? null,
        battery: r.battery ?? null,
      };
      this._addSecret(device.did);
      this._addSecret(device.mac);
      this._addSecret(device.uid);
      return device;
    });
  }

  async _command(device, method, params, postOpts = {}) {
    const id = ++this._id;
    const res = await this._api(COMMAND_PATH(device.prefix || DEFAULT_PREFIX), {
      did: String(device.did),
      id,
      data: { did: String(device.did), id, method, params },
    }, false, postOpts);
    return res;
  }

  /**
   * @param {object} device normalised record from listDevices()
   * @param {Array<{siid:number,piid:number}>} props
   * @returns {Promise<{reachable: boolean, values: Record<string, unknown>}>}
   */
  async getProperties(device, props) {
    const res = await this._command(device, 'get_properties',
      props.map((p) => ({ did: String(device.did), siid: p.siid, piid: p.piid })));
    if (res && OFFLINE_CODES.has(res.code)) return { reachable: false, values: {} };
    if (!res || res.code !== 0) {
      const code = safeCode(res?.code);
      throw new DreameCloudError(`API code ${res ? (code ?? 'invalid') : 'none'}`, { code });
    }
    const values = {};
    const result = res.data && res.data.result;
    for (const e of Array.isArray(result) ? result : []) {
      if (e && e.code === 0 && e.value !== undefined) values[`${e.siid}.${e.piid}`] = e.value;
    }
    // an envelope without a single valid value is no measurement
    if (props.length && !Object.keys(values).length) throw new DreameCloudError('no property values');
    return { reachable: true, values };
  }

  /**
   * @returns {Promise<{ok: true} | {ok: false, code?: number}>}
   */
  async action(device, siid, aiid, inList = []) {
    let res;
    try {
      res = await this._command(device, 'action', { did: String(device.did), siid, aiid, in: inList },
        { idempotent: false });
    } catch (err) {
      if (err instanceof DreameCloudError && err.renewed) return { ok: false }; // token renewed, action not repeated
      throw err;
    }
    if (!res || res.code !== 0) return { ok: false, code: safeCode(res?.code) };
    const result = res.data && res.data.result;
    // unbelegt: action result shape {code, out}; code 0 = accepted (protocol.py / ioBroker.dreame only check the
    // envelope). Fail closed: the confirmation must be present and explicit, i.e. a single
    // object or a non-empty array (get_properties style) whose every entry carries code 0.
    const entries = Array.isArray(result) ? result : [result];
    const bad = entries.findIndex((e) => !e || typeof e !== 'object' || e.code !== 0);
    if (!entries.length || bad !== -1) {
      return { ok: false, code: safeCode(bad !== -1 ? entries[bad]?.code : undefined) };
    }
    return { ok: true };
  }

  // ---- cloud MQTT push -----------------------------------------------------

  /**
   * Subscribe to `/status/<did>/<uid>/<model>/<country>/` on each device's
   * broker (bindDomain). Returns false when push is not possible; callers keep
   * polling either way.
   *
   * unbelegt: topic uid is the device's masterUid (protocol.py) vs. the session
   * uid (ioBroker.dreame); identical for owned devices. unbelegt: whether the
   * broker certificate validates (ioBroker.dreame sets rejectUnauthorized=false);
   * we verify unless `tlsVerify` is switched off.
   *
   * @param {Array<object>} devices
   * @param {(did: string, props: Array<{siid:number,piid:number,value:unknown}>) => void} handler
   */
  startPush(devices, handler) {
    if (this._closed || !this._loggedIn || !this._mqttConnect) return false;
    this.stopPush();
    this._push = { devices, handler, clients: [] };
    const byHost = new Map();
    for (const d of devices) {
      if (!d.bindDomain) continue;
      // the push host comes from the cloud answer; only Dreame hosts (host[:port])
      if (!PUSH_HOST.test(d.bindDomain)) {
        this._log('warn', 'Dreame push: device broker outside .iot.dreame.tech ignored');
        continue;
      }
      if (!byHost.has(d.bindDomain)) byHost.set(d.bindDomain, []);
      byHost.get(d.bindDomain).push(d);
    }
    for (const [host, list] of byHost) {
      const client = this._mqttConnect(`mqtts://${host}`, {
        clientId: `p_${randomBytes(8).toString('hex')}`,
        username: this._uid,
        password: this._accessToken,
        keepalive: 60,
        reconnectPeriod: 10_000,
        rejectUnauthorized: this._tlsVerify,
      });
      client.on('connect', () => {
        for (const d of list) {
          client.subscribe(`/status/${d.did}/${d.uid ?? this._uid}/${d.model}/${this._country}/`);
        }
      });
      client.on('message', (_topic, payload) => this._onPush(payload));
      client.on('error', (err) => this._log('warn', `Dreame push: connection error (${netErrorLabel(err)})`));
      this._push.clients.push(client);
    }
    return this._push.clients.length > 0;
  }

  _onPush(payload) {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; } // large messages arrive truncated (4096 bytes)
    if (!msg || !msg.data || msg.data.method !== 'properties_changed' || !Array.isArray(msg.data.params)) return;
    const fallbackDid = String(msg.did ?? msg.data.did ?? '');
    const byDid = new Map();
    for (const p of msg.data.params) {
      if (!p || typeof p !== 'object') continue;
      const did = String(p.did ?? fallbackDid);
      if (!byDid.has(did)) byDid.set(did, []);
      byDid.get(did).push({ siid: p.siid, piid: p.piid, value: p.value });
    }
    for (const [did, props] of byDid) {
      try { this._push && this._push.handler(did, props); } catch { /* consumer errors must not kill the stream */ }
    }
  }

  _restartPush() {
    const { devices, handler } = this._push;
    this.startPush(devices, handler); // new token -> new connection credentials
  }

  stopPush() {
    if (!this._push) return;
    const { clients } = this._push;
    this._push = null;
    for (const c of clients) {
      try { c.end(true); } catch { /* already closed */ }
    }
  }
}
