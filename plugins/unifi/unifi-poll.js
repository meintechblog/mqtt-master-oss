/**
 * UnifiPoll — the 3-timer polling + publish engine for the Phase 8 plugin.
 *
 * Owns three setInterval timers and one in-flight Promise tracker:
 *   - _deviceListTimer   (default 30s)   — full /stat/device snapshot + diff
 *   - _portStateTimer    (default 5s)    — per-port telemetry refresh
 *   - _heartbeatTimer    (default 60s)   — retained republish from cache
 *
 * Pure-functions backbone consumed verbatim from Plan 08-01:
 *   - snapshotDevices + diffStructure  (./unifi-structure.js)
 *   - normalizePort, normalizeDevice, deriveConnectedDevice  (./unifi-telemetry.js)
 *   - slugify, macSlug                  (../lib/slug.js)
 *
 * Phase boundary held (asserted by tests/plugins/unifi/plugin-phase-boundary.test.js):
 *   - NEVER subscribes — receive-side is Phase 9.
 *   - NEVER publishes /cmd or /cmd/result.
 *   - NEVER calls port_overrides PUT or /cmd/devmgr POST.
 *
 * Behaviour decisions referenced inline:
 *   D-T-02/03/04 — slug + by-mac state-topic shape (every publish retain:true)
 *   D-P-04       — auth-state gating + clean stop()
 *   D-H-02       — heartbeat staleness gating (skip devices stale > 2*pollPortStateSec)
 *   D-M-01       — UAP devices: device-state yes, port-state no
 *   D-F-02       — non-PoE ports omit poe_* keys (enforced upstream in normalizePort)
 *   D-F-04       — 5-minute (mac, port_idx) cache for connected_device labels
 */
import { EventEmitter } from 'node:events';
import { snapshotDevices, diffStructure } from './unifi-structure.js';
import {
  normalizePort,
  normalizeDevice,
  deriveConnectedDevice,
  deriveConnectedDeviceDetail,
  normalizeWan,
  normalizeWanIsp,
  normalizeSiteHealth,
  normalizeClient,
  deriveClientState,
} from './unifi-telemetry.js';
import { slugify, macSlug } from '../lib/slug.js';

/** Time-to-live for the per-(mac, port_idx) connected_device label cache. */
const CONNECTED_DEVICE_TTL_MS = 5 * 60_000;

/** Schema floors per D-P-02. Anything lower hammers the UDM CPU (PITFALLS Pitfall 13). */
const FLOOR_DEVICE_LIST_SEC = 5;
const FLOOR_PORT_STATE_SEC = 2;
const FLOOR_POLL_CLIENTS_SEC = 10;     // Phase 14 — D-P14-DATA-01 floor.
/** Fixed cadences for /rest/user + /rest/wlanconf — Phase 14 D-P14-DATA-02/03. */
const USER_LIST_POLL_MS = 5 * 60_000;
const WLANCONF_POLL_MS = 10 * 60_000;
/** Phase 14 — presence-cleanup sweep cadence. */
const PRESENCE_SWEEP_INTERVAL_MS = 60_000;

export class UnifiPoll extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.client          Authenticated UnifiClient (request + getStatus + EventEmitter).
   * @param {object} opts.mqttService     MqttService singleton — uses publish() only.
   * @param {string} opts.topicPrefix     e.g. "unifi-gateway1/". Trailing slash stripped internally.
   * @param {string} [opts.site]          UniFi site (default "default").
   * @param {number} [opts.pollDeviceListSec]  Default 30; floor 5.
   * @param {number} [opts.pollPortStateSec]   Default 5; floor 2.
   * @param {number} [opts.heartbeatSec]       Default 60; 0 disables.
   * @param {object} [opts.logger]        info/warn/error/debug.
   */
  constructor(opts = {}) {
    super();
    const {
      client,
      mqttService,
      topicPrefix,
      site = 'default',
      pollDeviceListSec = 30,
      pollPortStateSec = 5,
      heartbeatSec = 60,
      // Phase 14 — clients feature toggles + cadences (D-P14-CFG-01).
      clientsEnabled = true,
      pollClientsSec = 30,
      clientsStaleAfterSec = 300,
      clientsCleanupAfterSec = 86_400,
      clientsMaxPublished = 200,
      logger,
    } = opts;

    if (!client) throw new Error('UnifiPoll: opts.client is required');
    if (!mqttService) throw new Error('UnifiPoll: opts.mqttService is required');
    if (typeof topicPrefix !== 'string') throw new Error('UnifiPoll: opts.topicPrefix must be a string');

    this._client = client;
    this._mqtt = mqttService;
    this._prefix = String(topicPrefix).replace(/\/+$/, '');
    this._site = site;
    this._logger = logger || null;

    // Apply schema floors defensively — accept what the plugin passed in but
    // never go below them (the form schema also enforces this; this guard
    // protects programmatic constructors).
    this._pollDeviceListSec = Math.max(FLOOR_DEVICE_LIST_SEC, Number(pollDeviceListSec) || 30);
    this._pollPortStateSec = Math.max(FLOOR_PORT_STATE_SEC, Number(pollPortStateSec) || 5);
    this._heartbeatSec = Math.max(0, Number(heartbeatSec) || 0);
    // If the explicit input was 0 the floor is correctly 0 — disabled.
    if (Number(heartbeatSec) === 0) this._heartbeatSec = 0;

    // Phase 14 — clients feature config (subject to floor).
    this._clientsEnabled = clientsEnabled !== false;
    this._pollClientsSec = Math.max(FLOOR_POLL_CLIENTS_SEC, Number(pollClientsSec) || 30);
    this._clientsStaleAfterMs = Math.max(60_000, (Number(clientsStaleAfterSec) || 300) * 1000);
    this._clientsCleanupAfterMs = Math.max(60_000, (Number(clientsCleanupAfterSec) || 86_400) * 1000);
    this._clientsMaxPublished = Math.max(1, Number(clientsMaxPublished) || 200);

    /** @type {NodeJS.Timeout|null} */
    this._deviceListTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._portStateTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._heartbeatTimer = null;
    // Phase 14 — three additional timers.
    /** @type {NodeJS.Timeout|null} */
    this._clientsTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._userListTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._wlanconfTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this._presenceSweepTimer = null;

    /**
     * In-flight mutex per "tick lane". Splitting into two lanes prevents the
     * Phase-8 high-frequency port-state timer (5s) from starving the Phase-14
     * clients timer (30s): every clients fire coincides with a port-state fire
     * (LCM 5s, 30s = 30s) and the previous single-slot design always lost the
     * race because port-state was registered first.
     *
     * Lane assignment:
     *   - _inFlightDevice  : device-list | port-state | heartbeat
     *                        (touches _lastSnapshot, _lastPublishedByMac, _staList)
     *   - _inFlightClients : clients | user-list | wlanconf | presence-sweep
     *                        (touches _lastPublishedClients, _userMap, _wlanconfMap)
     *
     * The two state-sets are read-only or write-once across lanes, so running
     * one lane in parallel with the other is safe in single-threaded JS.
     * `runOnce()` and `stop()` awaits BOTH lanes for backward-compat with
     * callers that relied on full serialization.
     * @type {Promise<void>|null}
     */
    this._inFlightDevice = null;
    /** @type {Promise<void>|null} */
    this._inFlightClients = null;

    /** Last structure snapshot — Map<mac, StructureSnapshotEntry>. */
    this._lastSnapshot = null;

    /**
     * Cached normalised state per device — Map<mac, { device: PublishedDeviceState,
     *   ports: Array<{ slug, payload }>, nameSlug: string }>.
     */
    this._lastPublishedByMac = new Map();

    /** Per-device last successful poll timestamp (ms epoch) — drives D-H-02. */
    this._lastPolledAtPerDevice = new Map();

    /** Last /stat/sta data array — refreshed on every device-list cycle. */
    this._staList = [];

    /**
     * Per-port connected_device label cache: key = `${mac}:${port_idx}`,
     * value = { value: string|null, expiresAt: number }.
     */
    this._connectedDeviceCache = new Map();

    /**
     * Phase 9 — cached port_table per device-mac (lowercase). Built each
     * device-list / port-state tick from the latest raw device list and read
     * by plugin.js's createPoEController for the D-MISC-03 not_poe_capable gate.
     * @type {Map<string, object[]>}
     */
    this._cachedPortTables = new Map();

    /**
     * Phase 9 — LLDP-augmented runtime protected ports built each device-list
     * tick. Set entries are `${mac}:${port_idx}`. EMPTY when no uplinks /
     * LLDP entries discovered. The hardcoded floor from protected-ports.js
     * is honored INDEPENDENTLY (D-PROTECT-04) — this set is an addition.
     * @type {Set<string>}
     */
    this._runtimeProtectedPorts = new Set();

    this._lastPollSuccessAt = null;
    this._pollErrorCount = 0;

    // Phase 13 — counts device-list polls so the ISP/health republish cadence
    // (every 10 polls per D-P13-WAN-04) is deterministic.
    this._deviceListPollCount = 0;

    // Phase 13 — cached /stat/health response so heartbeat republish can carry
    // site/health forward without an extra fetch. Map<subsystem, record>.
    this._lastHealthSubsystems = null;

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 14 — clients + presence state
    // ═══════════════════════════════════════════════════════════════════════

    /** Map<macLower, userRecord> — refreshed every 5 min from /rest/user. */
    this._userMap = new Map();
    /** Map<essid, wlanconfRecord> — refreshed every 10 min from /rest/wlanconf. */
    this._wlanconfMap = new Map();
    /** Map<macLower, ms-epoch> — last time this client was seen in /stat/sta. */
    this._clientLastSeenMs = new Map();
    /** Map<macLower, ClientState> — last published state per client (for cleanup walk). */
    this._lastPublishedClients = new Map();
    /** Set<macLower> — clients that have already received an HA-Discovery publish. */
    this._haDiscoveryClientsPublished = new Set();
    /** Set<macLower> — clients in not_home state (so we don't republish 'not_home' on every sweep). */
    this._clientsInNotHomeState = new Set();
    /** Last clients summary publish payload — used to skip no-op republishes. */
    this._lastClientsSummary = null;
  }

  // ---- Public API ----------------------------------------------------------

  /** Snapshot of operational metrics for Plugin.getStatus(). */
  getMetrics() {
    return {
      devicesDiscovered: this._lastSnapshot ? this._lastSnapshot.size : 0,
      lastPollSuccessAt: this._lastPollSuccessAt,
      pollErrorCount: this._pollErrorCount,
    };
  }

  /**
   * Aggregate structure summary used by the generic PluginManager hook
   * GET /api/plugins/:id/structure/raw (server/routes/api-plugins.js:422).
   * Mirrors the Loxone plugin's `getStructureSummary()` shape (an opaque
   * JSON-serializable snapshot of "what the plugin currently sees") so the
   * UnifiPorts page (Phase 10 Plan 10-02) can render the device list +
   * per-device port grid without consuming MQTT directly on cold-load.
   *
   * Built from `_lastSnapshot` (Map<mac, {nameSlug, name, model, type}>) and
   * the per-device `_lastPublishedByMac` cache (Map<mac, {device, ports: [{port_idx, payload}], nameSlug}>).
   * Port payloads are the SAME normalised shape published to MQTT
   * (`webapp/js/pages/unifi-ports.js` consumes both this AND the live MQTT
   * stream — they MUST agree).
   *
   * No fetch — pure read of in-memory caches. Returns an empty list pre-start
   * and post-stop without throwing (matches the protectedPorts surface
   * invariant from Plan 10-01).
   *
   * @returns {{ devices: Array<{ mac: string, name: string, nameSlug: string, model: string, type: string, port_table: Array<object> }> }}
   */
  getStructureSummary() {
    const devices = [];
    if (!(this._lastSnapshot instanceof Map)) return { devices };

    for (const [mac, entry] of this._lastSnapshot) {
      const cache = this._lastPublishedByMac.get(mac);
      // port_table carries the SAME PublishedPortState shape we publish on
      // {prefix}/{slug}/port/{idx}/state — see normalizePort in unifi-telemetry.js.
      const port_table = cache && Array.isArray(cache.ports)
        ? cache.ports.map((p) => p.payload)
        : [];
      devices.push({
        mac,
        name: entry.name || '',
        nameSlug: entry.nameSlug,
        model: entry.model || '',
        type: entry.type || '',
        port_table,
      });
    }
    return { devices };
  }

  /**
   * Arm all 3 timers. Idempotent — calling start() twice is a no-op for
   * already-armed timers (defensive, but the plugin calls it exactly once).
   */
  start() {
    if (!this._deviceListTimer) {
      this._deviceListTimer = setInterval(
        () => this._safeTick('device-list'),
        this._pollDeviceListSec * 1000,
      );
    }
    if (!this._portStateTimer) {
      this._portStateTimer = setInterval(
        () => this._safeTick('port-state'),
        this._pollPortStateSec * 1000,
      );
    }
    if (this._heartbeatSec > 0 && !this._heartbeatTimer) {
      this._heartbeatTimer = setInterval(
        () => this._safeTick('heartbeat'),
        this._heartbeatSec * 1000,
      );
    }
    // Phase 14 — clients + presence timers. Subject to clientsEnabled.
    if (this._clientsEnabled) {
      if (!this._clientsTimer) {
        this._clientsTimer = setInterval(
          () => this._safeTick('clients'),
          this._pollClientsSec * 1000,
        );
      }
      if (!this._userListTimer) {
        this._userListTimer = setInterval(
          () => this._safeTick('user-list'),
          USER_LIST_POLL_MS,
        );
      }
      if (!this._wlanconfTimer) {
        this._wlanconfTimer = setInterval(
          () => this._safeTick('wlanconf'),
          WLANCONF_POLL_MS,
        );
      }
      if (!this._presenceSweepTimer) {
        this._presenceSweepTimer = setInterval(
          () => this._safeTick('presence-sweep'),
          PRESENCE_SWEEP_INTERVAL_MS,
        );
      }
    }
  }

  /**
   * Clear all 3 timers and resolve once any in-flight tick settles. Idempotent.
   */
  async stop() {
    if (this._deviceListTimer) { clearInterval(this._deviceListTimer); this._deviceListTimer = null; }
    if (this._portStateTimer) { clearInterval(this._portStateTimer); this._portStateTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    // Phase 14 — tear down clients timers.
    if (this._clientsTimer) { clearInterval(this._clientsTimer); this._clientsTimer = null; }
    if (this._userListTimer) { clearInterval(this._userListTimer); this._userListTimer = null; }
    if (this._wlanconfTimer) { clearInterval(this._wlanconfTimer); this._wlanconfTimer = null; }
    if (this._presenceSweepTimer) { clearInterval(this._presenceSweepTimer); this._presenceSweepTimer = null; }

    // Wait for any in-flight tick on either lane. Both promises are
    // catch-wrapped at the source so awaiting them here cannot throw.
    if (this._inFlightDevice) {
      try { await this._inFlightDevice; } catch { /* errors already emitted as poll-error */ }
    }
    if (this._inFlightClients) {
      try { await this._inFlightClients; } catch { /* errors already emitted as poll-error */ }
    }
  }

  /**
   * Public on-demand refresh — used by Plugin.refreshStructure() (Plan 10-01)
   * to satisfy the existing generic PluginManager hook
   * `POST /api/plugins/:id/structure/refresh`. Delegates to runOnce() with
   * kind:'device-list' so the snapshot + structure-diff emission happens
   * exactly as the periodic timer would have done. Idempotent — if a tick is
   * already in flight, runOnce() awaits it first before kicking off a fresh
   * one.
   */
  async refreshNow() {
    await this.runOnce({ kind: 'device-list' });
  }

  /**
   * Run one poll cycle synchronously. Used by Plugin.start() for a cold-start
   * sync pass (before timers are armed). Tracks the in-flight state so a
   * concurrent stop() correctly waits for the tick to settle.
   *
   * @param {{kind: 'device-list' | 'port-state' | 'heartbeat'}} req
   */
  async runOnce(req) {
    const kind = req?.kind;
    const validKinds = new Set([
      'device-list', 'port-state', 'heartbeat',
      'clients', 'user-list', 'wlanconf', 'presence-sweep',
    ]);
    if (!validKinds.has(kind)) {
      throw new Error(`UnifiPoll.runOnce: unknown kind ${kind}`);
    }
    // Conservative semantics for the public/test-facing runOnce: serialize
    // against BOTH lanes. The timer-driven _safeTick path only blocks within
    // its own lane (see the lane-doc on _inFlightDevice / _inFlightClients).
    if (this._inFlightDevice) {
      try { await this._inFlightDevice; } catch { /* already emitted */ }
    }
    if (this._inFlightClients) {
      try { await this._inFlightClients; } catch { /* already emitted */ }
    }
    const ticket = this._executeTick(kind);
    const laneKey = this._laneFor(kind);
    let wrapped;
    wrapped = ticket
      .catch(() => { /* surfaced as poll-error */ })
      .finally(() => { if (this[laneKey] === wrapped) this[laneKey] = null; });
    this[laneKey] = wrapped;
    return ticket;
  }

  /**
   * Map a tick kind to its in-flight lane slot name. Phase 8 ticks share the
   * device lane (they mutate the same snapshot caches); Phase 14 ticks share
   * the clients lane (they mutate independent client caches). See the doc on
   * _inFlightDevice / _inFlightClients for rationale.
   * @private
   */
  _laneFor(kind) {
    if (kind === 'device-list' || kind === 'port-state' || kind === 'heartbeat') {
      return '_inFlightDevice';
    }
    return '_inFlightClients';
  }

  // ---- Internals -----------------------------------------------------------

  /**
   * Timer wrapper — guards against overlapping ticks and surfaces errors via
   * 'poll-error' events without tearing down the timer chain.
   * @private
   */
  _safeTick(kind) {
    // Lane-scoped skip: if a tick on the SAME lane is already in flight, skip
    // this one — the next interval will pick up. Phase 8 ticks only block each
    // other; Phase 14 ticks only block each other. Cross-lane runs in parallel
    // by design (see _laneFor / _inFlightDevice / _inFlightClients docs).
    const laneKey = this._laneFor(kind);
    if (this[laneKey]) return;
    let wrapped;
    wrapped = this._executeTick(kind)
      .catch(() => { /* already emitted */ })
      .finally(() => { if (this[laneKey] === wrapped) this[laneKey] = null; });
    this[laneKey] = wrapped;
  }

  /**
   * Auth-gate, dispatch, and emit success/error events.
   * @private
   */
  async _executeTick(kind) {
    // D-H-03 / D-P-04 — only poll when the client is fully authenticated.
    const authState = this._client.getStatus?.()?.authState;
    if (authState !== 'connected') {
      this._logger?.debug?.(`[unifi-poll] skip ${kind}: authState=${authState}`);
      return;
    }

    const t0 = Date.now();
    try {
      if (kind === 'device-list') {
        await this._tickDeviceList();
      } else if (kind === 'port-state') {
        await this._tickPortState();
      } else if (kind === 'heartbeat') {
        await this._tickHeartbeat();
      } else if (kind === 'clients') {
        await this._tickClients();
      } else if (kind === 'user-list') {
        await this._tickUserList();
      } else if (kind === 'wlanconf') {
        await this._tickWlanconf();
      } else if (kind === 'presence-sweep') {
        this._tickPresenceSweep();
      }
      this._lastPollSuccessAt = new Date().toISOString();
      this.emit('poll-success', { kind, durationMs: Date.now() - t0 });
    } catch (error) {
      this._pollErrorCount++;
      this.emit('poll-error', { kind, error });
      this._logger?.warn?.(`[unifi-poll] ${kind} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Device-list tick: GET /stat/device + /stat/sta → snapshot + diff →
   * publish per-device + per-port retained JSON in both namespaces.
   * @private
   */
  async _tickDeviceList() {
    const [deviceBody, staBody, healthBody] = await Promise.all([
      this._client.request({ method: 'GET', path: `/proxy/network/api/s/${this._site}/stat/device` }),
      this._client.request({ method: 'GET', path: `/proxy/network/api/s/${this._site}/stat/sta` })
        .catch(() => ({ data: [] })),
      // Phase 13 — /stat/health for site rollup + ISP info. Soft-fail to null.
      this._client.request({ method: 'GET', path: `/proxy/network/api/s/${this._site}/stat/health` })
        .catch(() => ({ data: [] })),
    ]);

    const rawDevices = Array.isArray(deviceBody?.data) ? deviceBody.data : [];
    this._staList = Array.isArray(staBody?.data) ? staBody.data : [];
    this._lastHealthSubsystems = Array.isArray(healthBody?.data) ? healthBody.data : [];

    const nextSnapshot = snapshotDevices(rawDevices, { logger: this._logger });
    const diff = diffStructure(this._lastSnapshot, nextSnapshot);
    this._lastSnapshot = nextSnapshot;

    // Emit diff for the plugin's structure-monitor wiring (retain-clear).
    if (diff.added.length || diff.renamed.length || diff.removed.length) {
      this.emit('devices-changed', diff);
    }

    // Publish all devices + ports for the freshly snapshotted set.
    this._publishAllDevices(rawDevices);
    // Phase 13 — WAN + ISP + site/health publishes follow the device walk.
    this._publishPhase13Topics(rawDevices);
    this._deviceListPollCount++;
  }

  /**
   * Port-state tick: same /stat/device + /stat/sta but without emitting diff.
   * Per D-P-01 the device-list cadence is the diff source; the port-state
   * cadence is a higher-frequency telemetry refresh.
   * @private
   */
  async _tickPortState() {
    const [deviceBody, staBody] = await Promise.all([
      this._client.request({ method: 'GET', path: `/proxy/network/api/s/${this._site}/stat/device` }),
      this._client.request({ method: 'GET', path: `/proxy/network/api/s/${this._site}/stat/sta` })
        .catch(() => ({ data: [] })),
    ]);

    const rawDevices = Array.isArray(deviceBody?.data) ? deviceBody.data : [];
    this._staList = Array.isArray(staBody?.data) ? staBody.data : [];

    // Keep the snapshot fresh so heartbeat staleness gating tracks the latest
    // device-set. We do NOT emit 'devices-changed' here per D-P-01.
    this._lastSnapshot = snapshotDevices(rawDevices, { logger: this._logger });

    this._publishAllDevices(rawDevices);
    // Phase 13 — WAN per-port-state cadence so wan/N/state refreshes at the
    // fast cadence too (every 5s by default). ISP republish stays gated to the
    // device-list cadence + every-10th counter.
    this._publishWanOnly(rawDevices);
  }

  /**
   * Heartbeat tick: republish each cached device + port payload with
   * `_lastPublishedAt` updated. D-H-02 staleness gating skips devices whose
   * lastPolledAt is older than 2 * pollPortStateSec.
   * @private
   */
  async _tickHeartbeat() {
    if (!this._lastSnapshot || this._lastSnapshot.size === 0) return;

    const now = Date.now();
    const stalenessThresholdMs = 2 * this._pollPortStateSec * 1000;

    for (const [mac, entry] of this._lastSnapshot) {
      const lastPolledAt = this._lastPolledAtPerDevice.get(mac);
      if (typeof lastPolledAt === 'number' && (now - lastPolledAt) > stalenessThresholdMs) {
        // D-H-02 — disconnected device, stop republishing.
        continue;
      }

      const cached = this._lastPublishedByMac.get(mac);
      if (!cached) continue;

      const nameSlug = entry.nameSlug;
      const macSlugStr = macSlug(mac);
      const slugBase = `${this._prefix}/${nameSlug}`;
      const macBase = `${this._prefix}/by-mac/${macSlugStr}`;

      // Re-publish device state with refreshed _lastPublishedAt.
      const devicePayload = JSON.stringify({
        ...cached.device,
        _lastPublishedAt: new Date().toISOString(),
      });
      this._mqtt.publish(`${slugBase}/state`, devicePayload, { retain: true });
      this._mqtt.publish(`${macBase}/state`, devicePayload, { retain: true });

      // Re-publish ports (UAP entries have empty ports array — skipped naturally).
      for (const port of cached.ports) {
        const portPayload = JSON.stringify({
          ...port.payload,
          _lastPublishedAt: new Date().toISOString(),
        });
        this._mqtt.publish(`${slugBase}/port/${port.port_idx}/state`, portPayload, { retain: true });
        this._mqtt.publish(`${macBase}/port/${port.port_idx}/state`, portPayload, { retain: true });
      }
    }
  }

  /**
   * Walk the raw device array, normalise, publish, and update caches.
   * Used by both _tickDeviceList and _tickPortState (and indirectly by
   * runOnce). Per D-M-01, UAP devices publish device-state but NOT port-state.
   * @private
   */
  _publishAllDevices(rawDevices) {
    const now = Date.now();

    // Phase 9 — REBUILD cached port_tables + runtime-protected set before the
    // per-device publish walk. Rebuild semantics (clear + populate) — a fixture
    // that loses every uplink in a subsequent tick must NARROW the protected
    // set, not retain stale entries (see unifi-poll.test.js Test C).
    this._cachedPortTables.clear();
    this._runtimeProtectedPorts.clear();
    this._rebuildPhase9Caches(rawDevices);

    for (const raw of rawDevices) {
      if (!raw || typeof raw.mac !== 'string') continue;
      const mac = raw.mac.toLowerCase();
      const name = typeof raw.name === 'string' ? raw.name : '';
      const nameSlug = name ? slugify(name) : macSlug(mac);
      const macSlugStr = macSlug(mac);
      const slugBase = `${this._prefix}/${nameSlug}`;
      const macBase = `${this._prefix}/by-mac/${macSlugStr}`;

      // -- Device-level publish --
      const devicePayloadObj = normalizeDevice(raw);
      const deviceWire = { ...devicePayloadObj, _lastPublishedAt: new Date().toISOString() };
      const deviceJson = JSON.stringify(deviceWire);
      this._mqtt.publish(`${slugBase}/state`, deviceJson, { retain: true });
      this._mqtt.publish(`${macBase}/state`, deviceJson, { retain: true });

      // -- Per-port publishes (D-M-01: UAP skipped) --
      const skipPorts = raw.type === 'uap';
      const publishedPortsForCache = [];

      if (!skipPorts && Array.isArray(raw.port_table)) {
        for (const port of raw.port_table) {
          if (!port || typeof port !== 'object') continue;
          const portIdx = parseInt(port.port_idx, 10);
          if (!Number.isFinite(portIdx)) continue;

          const connectedDevice = this._resolveConnectedDeviceCached(port, mac, portIdx);
          // Phase 13 — structured detail alongside the string label. Pure
          // derivation against the same /stat/sta + lldp sources; no cache
          // needed (callers compose this every poll).
          const connectedDeviceDetail = deriveConnectedDeviceDetail(port, mac, this._staList);
          const portPayload = normalizePort(port, {
            deviceMac: mac, connectedDevice, connectedDeviceDetail,
          });
          const portWire = { ...portPayload, _lastPublishedAt: new Date().toISOString() };
          const portJson = JSON.stringify(portWire);

          this._mqtt.publish(`${slugBase}/port/${portIdx}/state`, portJson, { retain: true });
          this._mqtt.publish(`${macBase}/port/${portIdx}/state`, portJson, { retain: true });

          publishedPortsForCache.push({ port_idx: portIdx, payload: portPayload });
        }
      }

      // Refresh per-device cache + lastPolledAt for the heartbeat loop.
      this._lastPublishedByMac.set(mac, {
        device: devicePayloadObj,
        ports: publishedPortsForCache,
        nameSlug,
      });
      this._lastPolledAtPerDevice.set(mac, now);
    }
  }

  /**
   * Phase 13 — publish WAN + ISP + site-health topics. Called after the main
   * device walk on every device-list tick. ISP cadence: first poll, then every
   * 10th. site/health: every device-list tick.
   * @private
   */
  _publishPhase13Topics(rawDevices) {
    if (!Array.isArray(rawDevices)) return;
    const ts = new Date().toISOString();

    // Walk gateway devices and publish wan/N/state always, wan/isp/state on
    // first poll + every 10th poll (D-P13-WAN-04). Both namespaces.
    // Counter is 0-indexed BEFORE increment: poll 1 → count=0, poll 10 → count=9.
    // We want publishes on polls 1 and 10 so the user sees ISP info immediately
    // and then every 5 min (assuming default 30s device-list cadence).
    const cnt = this._deviceListPollCount;
    const ispShouldPublish = cnt === 0 || ((cnt + 1) % 10) === 0;
    const healthWan = (this._lastHealthSubsystems || []).find((s) => s?.subsystem === 'wan');

    for (const raw of rawDevices) {
      if (!raw || typeof raw.mac !== 'string') continue;
      if (raw.type !== 'udm' && raw.type !== 'ugw') continue; // gateway only (D-P13-DEV-03)
      const mac = raw.mac.toLowerCase();
      const name = typeof raw.name === 'string' ? raw.name : '';
      const nameSlug = name ? slugify(name) : macSlug(mac);
      const macSlugStr = macSlug(mac);
      const slugBase = `${this._prefix}/${nameSlug}`;
      const macBase = `${this._prefix}/by-mac/${macSlugStr}`;

      for (const wanKey of ['wan1', 'wan2']) {
        const wanIdx = wanKey === 'wan1' ? 1 : 2;
        const wan = normalizeWan(raw, wanKey);
        // Single-WAN setup: publish wan2 as up=false (per D-P13-WAN-02) so
        // subscribers see consistent topic shape.
        const payload = wan
          ? { ...wan, _lastPublishedAt: ts }
          : { interface: null, up: false, _lastPublishedAt: ts };
        const json = JSON.stringify(payload);
        this._mqtt.publish(`${slugBase}/wan/${wanIdx}/state`, json, { retain: true });
        this._mqtt.publish(`${macBase}/wan/${wanIdx}/state`, json, { retain: true });
      }

      if (ispShouldPublish) {
        const isp = normalizeWanIsp(raw, healthWan || null);
        if (isp) {
          const ispJson = JSON.stringify({ ...isp, _lastPublishedAt: ts });
          this._mqtt.publish(`${slugBase}/wan/isp/state`, ispJson, { retain: true });
          this._mqtt.publish(`${macBase}/wan/isp/state`, ispJson, { retain: true });
        }
      }
    }

    // Site-level health rollup (D-P13-WAN-05). Single topic per plugin instance.
    if (Array.isArray(this._lastHealthSubsystems) && this._lastHealthSubsystems.length > 0) {
      const health = normalizeSiteHealth(this._lastHealthSubsystems);
      const json = JSON.stringify({ ...health, _lastPublishedAt: ts });
      this._mqtt.publish(`${this._prefix}/site/health`, json, { retain: true });
    }
  }

  /**
   * Phase 13 — publish wan/N/state ONLY (no ISP/site-health). Called from
   * `_tickPortState` so WAN throughput refreshes at the faster cadence.
   * @private
   */
  _publishWanOnly(rawDevices) {
    if (!Array.isArray(rawDevices)) return;
    const ts = new Date().toISOString();

    for (const raw of rawDevices) {
      if (!raw || typeof raw.mac !== 'string') continue;
      if (raw.type !== 'udm' && raw.type !== 'ugw') continue;
      const mac = raw.mac.toLowerCase();
      const name = typeof raw.name === 'string' ? raw.name : '';
      const nameSlug = name ? slugify(name) : macSlug(mac);
      const macSlugStr = macSlug(mac);
      const slugBase = `${this._prefix}/${nameSlug}`;
      const macBase = `${this._prefix}/by-mac/${macSlugStr}`;

      for (const wanKey of ['wan1', 'wan2']) {
        const wanIdx = wanKey === 'wan1' ? 1 : 2;
        const wan = normalizeWan(raw, wanKey);
        const payload = wan
          ? { ...wan, _lastPublishedAt: ts }
          : { interface: null, up: false, _lastPublishedAt: ts };
        const json = JSON.stringify(payload);
        this._mqtt.publish(`${slugBase}/wan/${wanIdx}/state`, json, { retain: true });
        this._mqtt.publish(`${macBase}/wan/${wanIdx}/state`, json, { retain: true });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 14 — clients + presence ticks
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Phase 14 — clients tick: GET /stat/sta (already cached by device-list tick
   * but refresh here for a faster cadence). Build per-client normalised state,
   * publish to {prefix}/clients/by-mac/{macslug}/state retained, then publish
   * aggregate summary.
   *
   * Emits `client-seen` event the first time a MAC is observed (the plugin uses
   * this to publish HA Discovery for that client exactly once per session).
   * @private
   */
  async _tickClients() {
    if (!this._clientsEnabled) return;
    // Refresh /stat/sta to avoid relying on a stale snapshot from device-list.
    const staBody = await this._client.request({
      method: 'GET',
      path: `/proxy/network/api/s/${this._site}/stat/sta`,
    }).catch(() => ({ data: [] }));
    const rawStaList = Array.isArray(staBody?.data) ? staBody.data : [];
    this._staList = rawStaList;
    this._publishAllClients(rawStaList);
  }

  /**
   * Phase 14 — /rest/user tick (D-P14-DATA-02). Refreshes the friendly-name
   * cross-join cache. 5-min cadence — low-churn data.
   * @private
   */
  async _tickUserList() {
    if (!this._clientsEnabled) return;
    const body = await this._client.request({
      method: 'GET',
      path: `/proxy/network/api/s/${this._site}/rest/user`,
    }).catch(() => ({ data: [] }));
    const rows = Array.isArray(body?.data) ? body.data : [];
    this._userMap.clear();
    for (const row of rows) {
      if (row && typeof row.mac === 'string') {
        this._userMap.set(row.mac.toLowerCase(), row);
      }
    }
  }

  /**
   * Phase 14 — /rest/wlanconf tick (D-P14-DATA-03). Refreshes SSID metadata
   * cache (essid → security). 10-min cadence.
   * @private
   */
  async _tickWlanconf() {
    if (!this._clientsEnabled) return;
    const body = await this._client.request({
      method: 'GET',
      path: `/proxy/network/api/s/${this._site}/rest/wlanconf`,
    }).catch(() => ({ data: [] }));
    const rows = Array.isArray(body?.data) ? body.data : [];
    this._wlanconfMap.clear();
    for (const row of rows) {
      if (row && typeof row.name === 'string') {
        this._wlanconfMap.set(row.name, row);
      }
    }
  }

  /**
   * Phase 14 — presence-cleanup sweep. Runs every 60s.
   *
   * For each client previously published:
   *   - If lastSeenMs is older than clientsCleanupAfterMs (24h default) →
   *     retain-clear ALL state topics + emit `client-removed` so plugin.js
   *     can clear HA Discovery.
   *   - Else if older than clientsStaleAfterMs (5 min default) AND we last
   *     published 'home' → publish 'not_home' retained.
   *
   * Synchronous — no IO except mqtt publish (which is fire-and-forget).
   * @private
   */
  _tickPresenceSweep() {
    if (!this._clientsEnabled) return;
    const now = Date.now();
    const prefix = this._prefix;
    const toCleanup = [];
    const toMarkNotHome = [];

    for (const [mac, state] of this._lastPublishedClients) {
      const lastSeen = this._clientLastSeenMs.get(mac);
      if (typeof lastSeen !== 'number') continue;
      const age = now - lastSeen;
      if (age >= this._clientsCleanupAfterMs) {
        toCleanup.push({ mac, state });
        continue;
      }
      if (age >= this._clientsStaleAfterMs) {
        // Already in not_home? Skip — don't republish.
        if (this._clientsInNotHomeState.has(mac)) continue;
        toMarkNotHome.push({ mac, state });
      } else {
        // age < stale threshold → client is home; remove from not_home set.
        this._clientsInNotHomeState.delete(mac);
      }
    }

    for (const { mac, state } of toMarkNotHome) {
      const next = { ...state, state: 'not_home', _lastPublishedAt: new Date().toISOString() };
      const macSlugStr = macSlug(mac);
      this._mqtt.publish(
        `${prefix}/clients/by-mac/${macSlugStr}/state`,
        JSON.stringify(next),
        { retain: true },
      );
      this._lastPublishedClients.set(mac, next);
      this._clientsInNotHomeState.add(mac);
    }

    for (const { mac } of toCleanup) {
      const macSlugStr = macSlug(mac);
      // Retain-clear the per-client state topic.
      this._mqtt.publish(`${prefix}/clients/by-mac/${macSlugStr}/state`, '', { retain: true });
      this._lastPublishedClients.delete(mac);
      this._clientLastSeenMs.delete(mac);
      this._clientsInNotHomeState.delete(mac);
      // Plugin listens for this event and clears HA Discovery.
      this.emit('client-removed', { mac });
      this._haDiscoveryClientsPublished.delete(mac);
    }

    // Re-publish summary if anything changed.
    if (toMarkNotHome.length > 0 || toCleanup.length > 0) {
      this._publishClientsSummary();
    }
  }

  /**
   * Phase 14 — internal client publish walk used by both `_tickClients` and
   * (potentially) cold-start. Pure with side-effects: publishes per-client state
   * + summary, updates internal caches, emits `client-seen` / `client-changed`.
   * @private
   */
  _publishAllClients(rawStaList) {
    if (!this._clientsEnabled) return;
    const now = Date.now();
    const prefix = this._prefix;
    const ts = new Date(now).toISOString();

    // Build deviceMap for ap_name/switch_name resolution.
    const deviceMap = new Map();
    if (this._lastSnapshot instanceof Map) {
      for (const [mac, entry] of this._lastSnapshot) {
        deviceMap.set(mac, { mac, name: entry.name, type: entry.type });
      }
    }

    // Defensive cap (D-P14-PERF-01): most-recently-seen first.
    let workList = rawStaList;
    if (rawStaList.length > this._clientsMaxPublished) {
      workList = [...rawStaList]
        .sort((a, b) => (b?.last_seen || 0) - (a?.last_seen || 0))
        .slice(0, this._clientsMaxPublished);
      this._logger?.warn?.(
        `[unifi-poll] /stat/sta returned ${rawStaList.length} clients; capping at ${this._clientsMaxPublished}`,
      );
    }

    const seenMacs = new Set();
    for (const rawSta of workList) {
      if (!rawSta || typeof rawSta.mac !== 'string') continue;
      const mac = rawSta.mac.toLowerCase();
      const user = this._userMap.get(mac) || null;
      const wlanconf = !rawSta.is_wired && typeof rawSta.essid === 'string'
        ? (this._wlanconfMap.get(rawSta.essid) || null)
        : null;
      const state = normalizeClient(rawSta, user, wlanconf, deviceMap, now);
      if (!state) continue;
      state.state = 'home'; // active presence — derived elsewhere on stale sweep.
      const payload = { ...state, _lastPublishedAt: ts };
      const macSlugStr = macSlug(mac);
      this._mqtt.publish(
        `${prefix}/clients/by-mac/${macSlugStr}/state`,
        JSON.stringify(payload),
        { retain: true },
      );

      const wasNotHome = this._clientsInNotHomeState.has(mac);
      const isNewlySeen = !this._lastPublishedClients.has(mac);
      this._lastPublishedClients.set(mac, payload);
      this._clientLastSeenMs.set(mac, now);
      this._clientsInNotHomeState.delete(mac); // back to home

      if (isNewlySeen) {
        this.emit('client-seen', { mac, state: payload });
      } else if (wasNotHome) {
        // Returned from not_home → home — useful for HA automations to see.
        this.emit('client-changed', { mac, state: payload });
      }
      seenMacs.add(mac);
    }

    this._publishClientsSummary();
  }

  /**
   * Publish aggregate `{prefix}/clients/summary` retained JSON per D-P14-TOPIC-02.
   * Skipped when no change vs last publish (defensive against MQTT broker
   * republish-on-no-change behavior).
   * @private
   */
  _publishClientsSummary() {
    const prefix = this._prefix;
    let total = 0;
    let wireless = 0;
    let wired = 0;
    const bySsid = {};
    const byAp = {};
    let homeCount = 0;
    let notHomeCount = 0;

    for (const [, state] of this._lastPublishedClients) {
      total += 1;
      if (state.is_wired) wired += 1; else wireless += 1;
      if (state.state === 'home') homeCount += 1; else notHomeCount += 1;
      if (state.essid) bySsid[state.essid] = (bySsid[state.essid] || 0) + 1;
      const apLabel = state.ap_name || state.ap_mac;
      if (apLabel) byAp[apLabel] = (byAp[apLabel] || 0) + 1;
    }

    const summary = {
      total,
      wireless,
      wired,
      home: homeCount,
      not_home: notHomeCount,
      by_ssid: bySsid,
      by_ap: byAp,
      _lastPublishedAt: new Date().toISOString(),
    };
    // Compare without timestamp.
    const prev = this._lastClientsSummary;
    const sameShape = prev && prev.total === summary.total && prev.wireless === summary.wireless
      && prev.wired === summary.wired && prev.home === summary.home
      && prev.not_home === summary.not_home
      && JSON.stringify(prev.by_ssid) === JSON.stringify(summary.by_ssid)
      && JSON.stringify(prev.by_ap) === JSON.stringify(summary.by_ap);
    if (sameShape) {
      // Don't republish — saves broker noise. Live page re-fetches retained
      // topic on load so HA automations don't lose anything.
      return;
    }
    this._lastClientsSummary = summary;
    this._mqtt.publish(`${prefix}/clients/summary`, JSON.stringify(summary), { retain: true });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 14 — public accessors for plugin.js consumption
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Defensive copy of the current published client state map. Used by
   * plugin.js to drive HA Discovery for any client missed by the seen-event
   * (e.g. on plugin reload before the first sweep).
   * @returns {Map<string, object>}
   */
  getPublishedClients() {
    return new Map(this._lastPublishedClients);
  }

  /**
   * Mark a client as HA-discovery published. plugin.js consults this to avoid
   * a Discovery-publish storm (D-P14-PERF-02) — same client's discovery is
   * NOT republished every poll, only on first-seen or name change.
   * @param {string} mac
   */
  markClientDiscoveryPublished(mac) {
    if (typeof mac === 'string') this._haDiscoveryClientsPublished.add(mac.toLowerCase());
  }

  /**
   * Has plugin.js already published HA Discovery for this client?
   * @param {string} mac
   * @returns {boolean}
   */
  hasClientDiscoveryPublished(mac) {
    if (typeof mac !== 'string') return false;
    return this._haDiscoveryClientsPublished.has(mac.toLowerCase());
  }

  /**
   * Phase 9 — populate `_cachedPortTables` (per-mac port_table copies) and
   * `_runtimeProtectedPorts` (LLDP-augmented protected port set) from the raw
   * device list. Called once per device-list/port-state tick (after the maps
   * have been cleared by _publishAllDevices). Pure read of `rawDevices` — no
   * IO, no event emission.
   *
   * Algorithm (matches 09-02-PLAN.md <interfaces>):
   *   1. Walk rawDevices to populate _cachedPortTables[mac.lower] = port_table.
   *   2. Walk rawDevices a second time and for each device D:
   *      - If D.uplink.uplink_mac points to a mac that is itself in our
   *        snapshot AND D.uplink.uplink_remote_port is a valid port_idx,
   *        add `${uplinkMac.lower}:${uplinkRemotePort}` to runtimeProtected.
   *      - Belt-and-braces: walk D.port_table; if a port has lldp_table with
   *        chassis_id matching a controller device (type=udm/ugw) in this
   *        snapshot, add `${D.mac.lower}:${port.port_idx}` too.
   *   The hardcoded floor (Main port 1) is enforced INDEPENDENTLY by
   *   protected-ports.js — this set is purely additive (D-PROTECT-04).
   * @private
   */
  _rebuildPhase9Caches(rawDevices) {
    if (!Array.isArray(rawDevices)) return;

    // Pass 1 — populate _cachedPortTables and collect controller MACs.
    const knownMacs = new Set();
    const controllerMacs = new Set();
    for (const raw of rawDevices) {
      if (!raw || typeof raw.mac !== 'string') continue;
      const mac = raw.mac.toLowerCase();
      knownMacs.add(mac);
      if (raw.type === 'udm' || raw.type === 'ugw') controllerMacs.add(mac);
      if (Array.isArray(raw.port_table)) {
        // Shallow copy of entries so downstream readers can't mutate our cache.
        this._cachedPortTables.set(mac, raw.port_table.map((p) => ({ ...p })));
      }
    }

    // Pass 2 — LLDP/uplink correlation.
    for (const raw of rawDevices) {
      if (!raw || typeof raw.mac !== 'string') continue;
      const mac = raw.mac.toLowerCase();

      // 2a — direct uplink record: D.uplink.uplink_mac points to the host
      // device + uplink_remote_port is the port_idx on the host.
      const uplink = raw.uplink;
      if (
        uplink
        && typeof uplink.uplink_mac === 'string'
        && Number.isInteger(uplink.uplink_remote_port)
        && uplink.uplink_remote_port >= 1
      ) {
        const hostMac = uplink.uplink_mac.toLowerCase();
        if (knownMacs.has(hostMac)) {
          this._runtimeProtectedPorts.add(`${hostMac}:${uplink.uplink_remote_port}`);
        }
      }

      // 2b — LLDP table on this device's ports: if any port's LLDP table
      // mentions a controller MAC (chassis_id), protect THIS device's port.
      if (Array.isArray(raw.port_table) && controllerMacs.size > 0) {
        for (const port of raw.port_table) {
          if (!port || typeof port !== 'object') continue;
          const idx = Number(port.port_idx);
          if (!Number.isInteger(idx) || idx < 1) continue;
          const lldp = Array.isArray(port.lldp_table) ? port.lldp_table : [];
          for (const entry of lldp) {
            if (!entry || typeof entry !== 'object') continue;
            const chassisId = typeof entry.chassis_id === 'string'
              ? entry.chassis_id.toLowerCase()
              : null;
            // Normalise dash → colon for chassis MACs returned dash-separated.
            const normalisedChassis = chassisId
              ? chassisId.replace(/-/g, ':')
              : null;
            if (normalisedChassis && controllerMacs.has(normalisedChassis)) {
              this._runtimeProtectedPorts.add(`${mac}:${idx}`);
              break;
            }
          }
        }
      }
    }
  }

  // ---- Phase 9 public accessors -------------------------------------------

  /**
   * Defensive copy of the cached port-tables. Plan 09-02's plugin reads this
   * each call to construct the createPoEController getPortTablesByMac
   * accessor — copies are shallow (port entries themselves are not deep-cloned
   * for hot-path performance, callers treat them read-only).
   * @returns {Map<string, object[]>}
   */
  getCachedPortTables() {
    return new Map(this._cachedPortTables);
  }

  /**
   * Defensive copy of the runtime-augmented protected port set built each
   * device-list / port-state tick. Plan 09-02's plugin composes this with the
   * hardcoded floor (protected-ports.js) — runtime augments, never overrides.
   * @returns {Set<string>}  Entries shaped `${mac}:${port_idx}`.
   */
  getRuntimeProtectedPorts() {
    return new Set(this._runtimeProtectedPorts);
  }

  /**
   * Resolve `connected_device` with a 5-minute per-(mac, port_idx) cache.
   * Per D-F-04: first poll resolves via LLDP-first chain, subsequent polls
   * within 5 min reuse the cached label. Cache miss / expiry → re-resolve.
   * @private
   */
  _resolveConnectedDeviceCached(port, mac, portIdx) {
    const key = `${mac}:${portIdx}`;
    const now = Date.now();
    const cached = this._connectedDeviceCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const resolved = deriveConnectedDevice(port, mac, this._staList);
    this._connectedDeviceCache.set(key, { value: resolved, expiresAt: now + CONNECTED_DEVICE_TTL_MS });
    return resolved;
  }
}

// Re-export the floors for plugin-level use (config schema mirrors these).
export const POLL_FLOORS = Object.freeze({
  pollDeviceListSec: FLOOR_DEVICE_LIST_SEC,
  pollPortStateSec: FLOOR_PORT_STATE_SEC,
  pollClientsSec: FLOOR_POLL_CLIENTS_SEC,
});
