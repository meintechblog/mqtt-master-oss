/**
 * unifi-poe — the SINGLE write surface for PoE control on the UniFi controller.
 *
 * This module is the ONLY place in the codebase that issues:
 *   - PUT  /proxy/network/api/s/{site}/rest/device/{_id}  (with port_overrides)
 *   - POST /proxy/network/api/s/{site}/cmd/devmgr         (with power-cycle)
 *
 * Owns all the safety-critical invariants for Phase 9:
 *   - D-RMW-02 / T-09-02  per-device mutex (Map<mac, tail-Promise>) so
 *                         concurrent writes to the SAME MAC serialise and
 *                         writes to DIFFERENT MACs proceed in parallel.
 *   - D-RMW-03 / T-09-01  read-modify-write of port_overrides: GET full
 *                         array, deep-clone, merge target entry, PUT whole
 *                         array. NEVER send a partial port_overrides body.
 *                         Pins HA #18267 invariant — Test 1 asserts every
 *                         pre-existing entry survives byte-identically.
 *   - D-RMW-04            On GET failure or unexpected shape → read_failed,
 *                         NEVER issue the PUT (partial write would be worse).
 *   - D-RL-01..03 / T-09-04  per-(mac, port_idx) cycle rate-limit, default 10s.
 *                         Timestamp is locked-in on attempt — failed cycles
 *                         also consume the window (D-RL-02).
 *   - D-CMD-03            cycle uses controller-native POST /cmd/devmgr only;
 *                         there is NO off+on fallback path in this module.
 *   - D-PROTECT-01..04 / T-09-05  off and cycle consult isProtectedPort BEFORE
 *                         any HTTPS. on bypasses (recovery action).
 *   - D-DRY-01..03 / T-09-06  dryRun short-circuits BEFORE acquireDeviceLock
 *                         AND BEFORE rate-limit consumption. Zero outbound
 *                         HTTPS across all three verbs.
 *   - D-MISC-03           not-PoE-capable target → not_poe_capable, ZERO HTTPS.
 *   - D-CMD-01            payload parser accepts case-insensitive 'on'|'off'|
 *                         'cycle' and JSON {action:'on'|'off'|'cycle'}.
 *
 * NO MQTT surface lives here — Plan 09-02 wires the dispatcher into the
 * plugin's MQTT subscribe/publish lifecycle. This file is pure logic over
 * the UnifiClient.request() surface.
 *
 * Phase boundaries (verified by grep):
 *   plugins/unifi/unifi-poe.js  must NOT mention mqttService / .publish( /
 *                               .subscribe(  — Plan 09-02's plugin wiring is
 *                               the only place those live.
 *
 * References:
 *   - HA Issue #18267 — partial port_overrides PUT silently wipes other ports
 *   - HA Issue #26598 — portconf_id reset to "All" profile on partial insert
 */

import { isProtectedPort } from './protected-ports.js';
import { isPoeCapablePort } from './unifi-telemetry.js';

/**
 * D-RESULT-01 — frozen enum of every result.status value the module can emit.
 * Plan 09-02's plugin wiring branches on these to choose retained-vs-non-retained
 * result-topic semantics.
 */
export const RESULT_STATUS = Object.freeze({
  OK: 'ok',
  PROTECTED_PORT: 'protected_port',
  RATE_LIMITED: 'rate_limited',
  READ_FAILED: 'read_failed',
  WRITE_FAILED: 'write_failed',
  INVALID_PAYLOAD: 'invalid_payload',
  UNKNOWN_DEVICE: 'unknown_device',
  UNKNOWN_PORT: 'unknown_port',
  NOT_CONNECTED: 'not_connected',
  NOT_POE_CAPABLE: 'not_poe_capable',
});

/** Max length of a port name we'll forward to the controller. Matches the
 *  UniFi UI's own input cap and keeps the cmd payload bounded. */
const PORT_NAME_MAX_LEN = 32;

/** Validate a port-name candidate. Returns the cleaned string or null when the
 *  input is not safe to push (empty, too long, control chars, non-string). */
function sanitizePortName(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > PORT_NAME_MAX_LEN) return null;
  // Reject ASCII control chars (NUL through US, plus DEL). Codepoint-based to
  // avoid the eslint no-control-regex rule and to make the intent obvious.
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}

/**
 * Parse an MQTT payload (string or Buffer) into a canonical action descriptor.
 * D-CMD-01 — case-insensitive plain strings 'on'/'off'/'cycle' OR a JSON object
 * { action: 'on'|'off'|'cycle' }. Phase 15 also accepts a `rename` envelope:
 *   { "action": "rename", "name": "Front porch cam" }
 * which expands the return type to an object: { verb: 'rename', name }.
 * Anything else → null (which the caller maps to invalid_payload).
 *
 * @param {string|Buffer|unknown} raw
 * @returns {'on'|'off'|'cycle'|{verb:'rename',name:string}|null}
 */
function parsePayload(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text.length === 0) return null;

  // 1. Plain string — case-insensitive direct match.
  const lower = text.toLowerCase();
  if (lower === 'on' || lower === 'off' || lower === 'cycle') {
    return lower;
  }

  // 2. JSON envelope.
  if (lower.startsWith('{') || lower.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (
        parsed
        && typeof parsed === 'object'
        && typeof parsed.action === 'string'
      ) {
        const v = parsed.action.trim().toLowerCase();
        if (v === 'on' || v === 'off' || v === 'cycle') return v;
        if (v === 'rename') {
          const name = sanitizePortName(parsed.name);
          if (name) return { verb: 'rename', name };
        }
      }
    } catch {
      // fall through → invalid_payload
    }
  }

  return null;
}

/**
 * @typedef {Object} PoEControllerOpts
 * @property {string}  site                            UniFi site name (e.g. "default").
 * @property {boolean} [dryRun=false]                  Short-circuit all writes with status:'ok'+dryRun:true.
 * @property {number}  [cyclePortRateLimitMs=10000]    Per-(mac, port_idx) cycle cooldown window.
 * @property {() => Map<string, Array<object>>|null} [getPortTablesByMac]
 *   Optional accessor returning the latest cached port_table per device-mac
 *   keyed lowercase. When provided, used for the D-MISC-03 not_poe_capable gate.
 * @property {Object}  [logger]                        info/warn/error/debug compatible logger.
 */

/**
 * Build a PoE controller bound to a single UnifiClient instance. Each call
 * creates fresh mutex / rate-limit state (closure-scoped — NOT shared between
 * controllers). Plan 09-02 instantiates exactly one per plugin instance.
 *
 * @param {Object} unifiClient                     Authenticated UnifiClient.
 * @param {PoEControllerOpts} opts
 * @returns {{
 *   setOn:    (mac: string, port_idx: number) => Promise<Result>,
 *   setOff:   (mac: string, port_idx: number) => Promise<Result>,
 *   setCycle: (mac: string, port_idx: number) => Promise<Result>,
 *   dispatch: (mac: string, port_idx: number, payload: string) => Promise<Result>,
 * }}
 */
export function createPoEController(unifiClient, opts = {}) {
  const site = opts.site;
  if (typeof site !== 'string' || site.length === 0) {
    throw new Error('createPoEController: opts.site is required');
  }
  const dryRun = Boolean(opts.dryRun);
  const cyclePortRateLimitMs = Number.isFinite(opts.cyclePortRateLimitMs)
    ? opts.cyclePortRateLimitMs
    : 10_000;
  // Phase 13 — per-gateway speedtest rate limit. Default 5 min (slow-link class
  // WANs make speedtests expensive). D-P13-SPD-01.
  const speedtestRateLimitMs = Number.isFinite(opts.speedtestRateLimitMs)
    ? opts.speedtestRateLimitMs
    : 5 * 60_000;
  const getPortTablesByMac = typeof opts.getPortTablesByMac === 'function'
    ? opts.getPortTablesByMac
    : null;
  // Optional accessor that resolves a device's Mongo `_id` from the latest
  // /stat/device snapshot. On UCG-MAX firmware, GET /rest/device/{mac} 404s
  // — only /rest/device/{_id} works. When this returns a string, the RMW path
  // uses it; otherwise falls back to MAC (legacy behaviour preserved for
  // controllers where MAC still works).
  const getDeviceIdByMac = typeof opts.getDeviceIdByMac === 'function'
    ? opts.getDeviceIdByMac
    : null;
  // Phase 9 additive — allow the caller (plugin.js) to inject an augmented
  // protected-port check that composes the hardcoded floor with the LLDP
  // runtime set. When omitted, fall back to the module's imported floor —
  // Plan 09-01's test suite passes no override and the hardcoded floor remains.
  const protectedCheck = typeof opts.isProtectedPort === 'function'
    ? opts.isProtectedPort
    : isProtectedPort;
  const logger = opts.logger || {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  };

  // ---------------------------------------------------------------------------
  // Per-instance state
  // ---------------------------------------------------------------------------
  /** mac (lowercase) → tail Promise of in-flight work for that device. */
  const _deviceLocks = new Map();

  /** `${macLower}:${port_idx}` → epoch-ms of last cycle attempt. */
  const _lastCycleAtPerKey = new Map();

  /** Phase 13 — per-gateway-mac → epoch-ms of last speedtest attempt. */
  const _lastSpeedtestAtPerMac = new Map();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const nowIso = () => new Date().toISOString();

  /**
   * D-RMW-02 per-device mutex. Acquires a serialisation lock for the given
   * lowercase MAC, runs `work`, releases the lock — even on throw. Different
   * MACs each hold their own promise chain → parallelism across devices.
   *
   * @template T
   * @param {string} macLower
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  async function acquireDeviceLock(macLower, work) {
    const prev = _deviceLocks.get(macLower) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    _deviceLocks.set(macLower, next);
    try {
      await prev; // serialise behind any prior in-flight work on this MAC
      return await work();
    } finally {
      release();
      // Cleanup: if the head pointer still references our slot, drop it so
      // _deviceLocks does not grow unbounded across long-lived processes.
      if (_deviceLocks.get(macLower) === next) {
        _deviceLocks.delete(macLower);
      }
    }
  }

  /**
   * D-RL-01..02. Returns { allowed: boolean, retryAfterMs?: number }.
   * Always updates the timestamp on `allowed:true` so a failed POST still
   * consumes the window (D-RL-02 — locked-in on attempt, not success).
   *
   * @param {string} macLower
   * @param {number} port_idx
   * @param {number} nowMs
   */
  function checkCycleRateLimit(macLower, port_idx, nowMs) {
    const key = `${macLower}:${port_idx}`;
    const last = _lastCycleAtPerKey.get(key);
    if (typeof last === 'number' && (nowMs - last) < cyclePortRateLimitMs) {
      return { allowed: false, retryAfterMs: cyclePortRateLimitMs - (nowMs - last) };
    }
    _lastCycleAtPerKey.set(key, nowMs);
    return { allowed: true };
  }

  /**
   * D-MISC-03 — consult the cached port_table (when provided) to short-circuit
   * writes to non-PoE-capable ports (SFP+, WAN). Returns true ONLY when the
   * cache has a definitive `port_poe === false` answer for this (mac, port).
   *
   * Returns false (allow through) when:
   *   - no accessor configured,
   *   - accessor returned null/undefined for the mac,
   *   - the port is not in the cache (caller will discover via RMW).
   *
   * @param {string} macLower
   * @param {number} port_idx
   * @returns {boolean}
   */
  function isCachedPortNonPoe(macLower, port_idx) {
    if (!getPortTablesByMac) return false;
    let tables;
    try {
      tables = getPortTablesByMac();
    } catch {
      return false; // accessor threw — defer to the RMW GET
    }
    if (!tables || typeof tables.get !== 'function') return false;
    const portTable = tables.get(macLower);
    if (!Array.isArray(portTable)) return false;
    const portRow = portTable.find((p) => Number(p?.port_idx) === Number(port_idx));
    if (!portRow) return false;
    // Definitive non-PoE: API marker present and explicitly false.
    return isPoeCapablePort(portRow) === false;
  }

  /**
   * D-RMW-03 — read-modify-write the port_overrides array of a single device.
   *
   * Sequence:
   *   1. GET /rest/device/{mac}
   *   2. Validate response shape; extract _id + port_overrides + port_table.
   *      If any of these are missing → return { status: read_failed }.
   *   3. Deep-clone every existing override (NEVER share a reference with the
   *      controller's response — defensive against mid-flight mutations of
   *      the fixture in test code). Merge `patch` into the target port_idx
   *      entry, or insert a new entry copying portconf_id from port_table
   *      (HA #26598 mitigation).
   *   4. PUT /rest/device/{_id} with the FULL port_overrides array.
   *
   * Called inside acquireDeviceLock — caller is responsible for the mutex.
   *
   * @param {string} macLower
   * @param {number} port_idx
   * @param {object} patch                 Fields to merge onto the target entry.
   * @returns {Promise<{status: string, error?: string}>}
   */
  async function applyPortOverride(macLower, port_idx, patch) {
    // ── 1. GET ───────────────────────────────────────────────────────────
    // UCG-MAX firmware (≥ 5.x) 404s on /rest/device/{mac} AND
    // /rest/device/{_id} for reads — only /stat/device (the polling list
    // endpoint) is honoured. /stat/device already returns _id, port_table,
    // and port_overrides for every device, so we read the full collection
    // and pick the device by mac. This also matches the polling path so a
    // controller that lets one through will let the other through too.
    let response;
    try {
      response = await unifiClient.request({
        method: 'GET',
        path: `/proxy/network/api/s/${site}/stat/device`,
      });
    } catch (err) {
      return {
        status: RESULT_STATUS.READ_FAILED,
        error: String(err?.message || err),
      };
    }

    // ── 2. Validate shape ───────────────────────────────────────────────
    // /stat/device returns `{ data: [<device>, ...] }`. Find the entry
    // whose mac matches macLower (case-insensitive comparison).
    const list = response && Array.isArray(response.data) ? response.data
      : Array.isArray(response) ? response
      : null;
    if (!list) {
      return { status: RESULT_STATUS.READ_FAILED, error: 'unexpected /stat/device response shape' };
    }
    const device = list.find((d) => typeof d?.mac === 'string' && d.mac.toLowerCase() === macLower);
    if (!device || typeof device._id !== 'string') {
      return { status: RESULT_STATUS.READ_FAILED, error: `device ${macLower} not found in /stat/device or missing _id` };
    }

    const existingOverrides = Array.isArray(device.port_overrides) ? device.port_overrides : [];
    const portTable = Array.isArray(device.port_table) ? device.port_table : [];

    // ── 3. Merge / insert (preserve every existing field byte-identically) ──
    const next = existingOverrides.map((entry) => ({ ...entry }));
    const targetIdx = next.findIndex((e) => Number(e?.port_idx) === Number(port_idx));
    if (targetIdx >= 0) {
      // Update — merge patch INTO existing fields. Existing keys win nothing;
      // patch overrides matching keys but every other field is carried over.
      next[targetIdx] = { ...next[targetIdx], ...patch };
    } else {
      // Insert — start with port_idx and (if available) portconf_id from
      // port_table to prevent HA #26598 portconf reset.
      const baseEntry = { port_idx: Number(port_idx) };
      const portRow = portTable.find((p) => Number(p?.port_idx) === Number(port_idx));
      if (portRow && typeof portRow.portconf_id === 'string') {
        baseEntry.portconf_id = portRow.portconf_id;
      }
      next.push({ ...baseEntry, ...patch });
    }

    // ── 4. PUT ───────────────────────────────────────────────────────────
    try {
      await unifiClient.request({
        method: 'PUT',
        path: `/proxy/network/api/s/${site}/rest/device/${device._id}`,
        body: { port_overrides: next },
      });
      return { status: RESULT_STATUS.OK };
    } catch (err) {
      return {
        status: RESULT_STATUS.WRITE_FAILED,
        error: String(err?.message || err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // setOn / setOff (shared body — only the poe_mode and protected gate differ)
  // ---------------------------------------------------------------------------
  /**
   * @param {string} mac
   * @param {number} port_idx
   * @param {'auto'|'off'} mode
   */
  async function setOnOrOff(mac, port_idx, mode) {
    const action = mode === 'auto' ? 'on' : 'off';
    const macLower = typeof mac === 'string' ? mac.toLowerCase() : '';
    const ts = nowIso();

    // Port index validation (D-RESULT-01 unknown_port).
    if (!Number.isInteger(port_idx) || port_idx < 1) {
      return { status: RESULT_STATUS.UNKNOWN_PORT, action, ts };
    }

    // Protected-port gate — off only. ON bypasses per D-PROTECT-02 (recovery).
    if (action === 'off' && protectedCheck(macLower, port_idx)) {
      return {
        status: RESULT_STATUS.PROTECTED_PORT,
        action,
        ts,
        reason: 'controller-uplink port — refusing off',
      };
    }

    // Cached-telemetry not-PoE-capable gate (D-MISC-03).
    if (isCachedPortNonPoe(macLower, port_idx)) {
      return { status: RESULT_STATUS.NOT_POE_CAPABLE, action, ts };
    }

    // DryRun short-circuit — BEFORE acquireDeviceLock so zero HTTPS happens
    // even when another caller holds the mutex.
    if (dryRun) {
      logger?.info?.(`[unifi-poe] DRY-RUN ${action} ${macLower}:${port_idx}`);
      return { status: RESULT_STATUS.OK, action, ts, dryRun: true };
    }

    // RMW under per-device mutex.
    return acquireDeviceLock(macLower, async () => {
      const rmw = await applyPortOverride(macLower, port_idx, { poe_mode: mode });
      return { ...rmw, action, ts };
    });
  }

  async function setOn(mac, port_idx) {
    return setOnOrOff(mac, port_idx, 'auto');
  }

  async function setOff(mac, port_idx) {
    return setOnOrOff(mac, port_idx, 'off');
  }

  // ---------------------------------------------------------------------------
  // setName — RMW the port_overrides[].name field via the same applyPortOverride
  // path the PoE writes use. Rename does NOT cut power, so the protected-port
  // gate does not apply. Validation (length, printable-only, non-empty) is
  // expected of the caller — dispatch() pre-validates and returns
  // INVALID_PAYLOAD for bad input.
  // ---------------------------------------------------------------------------
  async function setName(mac, port_idx, name) {
    const action = 'rename';
    const macLower = typeof mac === 'string' ? mac.toLowerCase() : '';
    const ts = nowIso();

    if (!Number.isInteger(port_idx) || port_idx < 1) {
      return { status: RESULT_STATUS.UNKNOWN_PORT, action, ts };
    }

    if (dryRun) {
      logger?.info?.(`[unifi-poe] DRY-RUN rename ${macLower}:${port_idx} → "${name}"`);
      return { status: RESULT_STATUS.OK, action, ts, name, dryRun: true };
    }

    // UniFi's port_overrides schema uses `port_name` (see rest-device fixture
    // — `port_overrides[].port_name: "Camera-VLAN"`). Writing `name` instead
    // silently no-ops in the UniFi UI: the controller stores the field but
    // the Port Settings dialog reads from `port_name` exclusively. We set
    // BOTH so any controller variant honours the rename — defensive belt +
    // suspenders, and the extra key is ignored on firmwares that only know
    // one of them.
    return acquireDeviceLock(macLower, async () => {
      const rmw = await applyPortOverride(macLower, port_idx, {
        port_name: name,
        name,
      });
      return { ...rmw, action, ts, name };
    });
  }

  // ---------------------------------------------------------------------------
  // setCycle — controller-native POST /cmd/devmgr (D-CMD-03)
  // ---------------------------------------------------------------------------
  async function setCycle(mac, port_idx) {
    const action = 'cycle';
    const macLower = typeof mac === 'string' ? mac.toLowerCase() : '';
    const ts = nowIso();

    if (!Number.isInteger(port_idx) || port_idx < 1) {
      return { status: RESULT_STATUS.UNKNOWN_PORT, action, ts };
    }

    // Protected-port — cycle is destructive (~100ms power loss), block it.
    if (protectedCheck(macLower, port_idx)) {
      return {
        status: RESULT_STATUS.PROTECTED_PORT,
        action,
        ts,
        reason: 'controller-uplink port — refusing cycle',
      };
    }

    if (isCachedPortNonPoe(macLower, port_idx)) {
      return { status: RESULT_STATUS.NOT_POE_CAPABLE, action, ts };
    }

    // DryRun BEFORE rate-limit consumption — dryRun must never poison the
    // operator's real cycle budget.
    if (dryRun) {
      logger?.info?.(`[unifi-poe] DRY-RUN cycle ${macLower}:${port_idx}`);
      return { status: RESULT_STATUS.OK, action, ts, dryRun: true };
    }

    // Rate-limit. The timestamp is locked-in by checkCycleRateLimit on the
    // ALLOWED path — failed POSTs also consume the window (D-RL-02).
    const rl = checkCycleRateLimit(macLower, port_idx, Date.now());
    if (!rl.allowed) {
      return {
        status: RESULT_STATUS.RATE_LIMITED,
        action,
        ts,
        retryAfterMs: rl.retryAfterMs,
      };
    }

    // POST /cmd/devmgr — NO mutex (this endpoint does not touch port_overrides).
    try {
      await unifiClient.request({
        method: 'POST',
        path: `/proxy/network/api/s/${site}/cmd/devmgr`,
        body: { cmd: 'power-cycle', mac: macLower, port_idx: Number(port_idx) },
      });
      return { status: RESULT_STATUS.OK, action, ts };
    } catch (err) {
      return {
        status: RESULT_STATUS.WRITE_FAILED,
        action,
        ts,
        error: String(err?.message || err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 13 — speedtest dispatch (D-P13-SPD-01)
  // ---------------------------------------------------------------------------
  /**
   * Trigger a controller-native speedtest on the gateway. Rate-limited to 1 per
   * `speedtestRateLimitMs` (default 5 min) per gateway MAC.
   *
   * @param {string} mac    Gateway MAC (case-insensitive).
   * @returns {Promise<{status: string, action: 'speedtest', ts: string, [k: string]: any}>}
   */
  async function speedtest(mac) {
    const action = 'speedtest';
    const macLower = typeof mac === 'string' ? mac.toLowerCase() : '';
    const ts = nowIso();

    // Auth gate.
    const authState = unifiClient?.getStatus?.()?.authState;
    if (authState !== 'connected') {
      return { status: RESULT_STATUS.NOT_CONNECTED, action, ts };
    }

    // DryRun short-circuit BEFORE rate-limit consumption — dryRun must not
    // poison the operator's real speedtest budget (mirrors cycle/D-DRY-02).
    if (dryRun) {
      logger?.info?.(`[unifi-poe] DRY-RUN speedtest ${macLower}`);
      return { status: RESULT_STATUS.OK, action, ts, dryRun: true };
    }

    // Rate-limit per gateway MAC. Timestamp locked-in on allowed path (mirrors D-RL-02).
    const now = Date.now();
    const last = _lastSpeedtestAtPerMac.get(macLower);
    if (typeof last === 'number' && (now - last) < speedtestRateLimitMs) {
      return {
        status: RESULT_STATUS.RATE_LIMITED,
        action,
        ts,
        retryAfterMs: speedtestRateLimitMs - (now - last),
      };
    }
    _lastSpeedtestAtPerMac.set(macLower, now);

    try {
      await unifiClient.request({
        method: 'POST',
        path: `/proxy/network/api/s/${site}/cmd/devmgr`,
        body: { cmd: 'speedtest', mac: macLower },
      });
      return { status: RESULT_STATUS.OK, action, ts };
    } catch (err) {
      return {
        status: RESULT_STATUS.WRITE_FAILED,
        action,
        ts,
        error: String(err?.message || err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // dispatch — single entrypoint for the MQTT handler (Plan 09-02 wires it)
  // ---------------------------------------------------------------------------
  /**
   * Parse `payload`, gate on auth, route to setOn/setOff/setCycle.
   *
   * @param {string} mac
   * @param {number} port_idx
   * @param {string|Buffer} payload
   * @returns {Promise<{status: string, action: string, ts: string, [k: string]: any}>}
   */
  async function dispatch(mac, port_idx, payload) {
    const ts = nowIso();
    const authState = unifiClient?.getStatus?.()?.authState;
    if (authState !== 'connected') {
      return { status: RESULT_STATUS.NOT_CONNECTED, action: 'unknown', ts };
    }
    const parsed = parsePayload(payload);
    if (parsed === null) {
      return { status: RESULT_STATUS.INVALID_PAYLOAD, action: 'unknown', ts };
    }
    if (parsed === 'on') return setOn(mac, port_idx);
    if (parsed === 'off') return setOff(mac, port_idx);
    if (parsed === 'cycle') return setCycle(mac, port_idx);
    if (typeof parsed === 'object' && parsed.verb === 'rename') {
      return setName(mac, port_idx, parsed.name);
    }
    // Unreachable — parsePayload returns a known shape or null.
    return { status: RESULT_STATUS.INVALID_PAYLOAD, action: 'unknown', ts };
  }

  return { setOn, setOff, setCycle, setName, speedtest, dispatch };
}
