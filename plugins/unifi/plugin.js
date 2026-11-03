/**
 * UnifiPlugin — Phase 7 scaffold around the `UnifiClient` from plan 07-01.
 *
 * Lifecycle contract (start / stop / getStatus / getConfigSchema) mirrors
 * `plugins/loxone/plugin.js` so the existing PluginManager dispatch shape
 * works without modification.
 *
 * Responsibilities:
 *   - Instantiate a UnifiClient with the configured creds, run checkUnifiOs +
 *     login + GET /api/system to discover controller name.
 *   - Apply the D-14 / D-15 topic-prefix + displayName auto-derivation
 *     (idempotent: only persists back to ConfigService when something changed).
 *   - Publish the bridge availability topic — the ONLY MQTT publish in
 *     Phase 7 (`{prefix}/bridge/status` = `online` / `offline`, retained).
 *   - Surface auth-state + sub-reason in getStatus() per D-13 (additive over
 *     the existing Loxone-style return shape).
 *   - Forward client events: `csrf_rotated` for telemetry, `sso_account_warning`
 *     (D-11b) into the SSO-banner flag, `disconnected` to mirror the
 *     connected/disconnected flag.
 *
 * Explicitly NOT in scope for Phase 7:
 *   - MQTT cmd subscriptions   → Phase 9 (PoE control)
 *   - Device / port telemetry  → Phase 8
 *   - HA Discovery publishes   → Phase 11
 *
 * See:
 *   - 07-CONTEXT.md D-12, D-13, D-14, D-15, D-22
 *   - 07-02-PLAN.md `<behavior>` block
 */
import { UnifiClient, AUTH_STATE } from './unifi-client.js';
import { UnifiPoll } from './unifi-poll.js';
import { createPoEController } from './unifi-poe.js';
import { isProtectedPort, PROTECTED_PORTS } from './protected-ports.js';
import { getConfigSchema } from './config-schema.js';
import { macSlug } from '../lib/slug.js';
import {
  publishDiscovery,
  clearDiscovery,
  publishClientDiscovery,
  clearClientDiscovery,
} from './ha-discovery.js';

/**
 * Escape regex meta-characters for safe use in a topic-pattern RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Slugify a string for use in topic prefixes / instance names.
 *
 * Mirrors `LoxoneStructure.slugify` (plugins/loxone/loxone-structure.js)
 * so the user sees the same shape on both bridges — umlauts to ASCII
 * digraphs, lowercase, non-alphanumerics collapse to single hyphens, no
 * leading/trailing hyphens. Empty → `"unknown"`.
 *
 * @param {string} str
 * @returns {string}
 */
function slugify(str) {
  if (!str) return 'unknown';
  return String(str)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export default class UnifiPlugin {
  constructor() {
    /** @type {UnifiClient|null} */
    this._client = null;
    this._running = false;
    this._connected = false;
    this._messageCount = 0;
    this._lastEvent = null;
    this._prefix = null;
    this._displayName = null;
    this._controllerName = null;
    this._siteName = null;
    /** D-11b: flipped true when login response has `only_local_account=false`. */
    this._ssoAccountWarning = false;
    /** Auth-state cache so getStatus() answers even after stop() has cleared `_client`. */
    this._authState = AUTH_STATE.DISCONNECTED;
    this._authStateReason = null;
    this._lastCsrfRotationAt = null;
    this._config = {};
    this._ctx = null;
    this._pluginId = 'unifi';

    /** Stored client-event handler refs for clean removal in stop(). */
    this._clientHandlers = null;

    /** @type {UnifiPoll|null} Phase 8 polling engine — null pre-start / post-stop. */
    this._poll = null;

    // ---- Phase 9 — PoE control via MQTT --------------------------------------
    /** @type {ReturnType<typeof createPoEController>|null} */
    this._poe = null;
    /** mqtt 'message' listener reference for clean removeListener on stop(). */
    this._cmdHandler = null;
    /** Set<string> — every cmd topic we have an outstanding subscribe for. */
    this._subscribedTopics = new Set();
    /** Map<macLower, number[]> — which PoE ports are subscribed per device. */
    this._subscribedPortsByMac = new Map();
    /** Set<Promise> — in-flight dispatch promises awaited on stop(). */
    this._inFlightDispatches = new Set();

    // ---- Phase 11 — HA MQTT Discovery state ---------------------------------
    /**
     * Last device set published to HA Discovery (structure-summary shape).
     * Used by clearDiscovery() on stop / removal to retain-clear exactly the
     * topics we previously published. Map<macLower, deviceEntry>.
     * @type {Map<string, object>}
     */
    this._lastHaDevices = new Map();
    /** Cached HA Discovery prefix this instance is using (D-CFG-01). */
    this._haDiscoveryPrefix = 'homeassistant';
    /** Cached HA Discovery enabled flag — gates every publish/clear call. */
    this._haDiscoveryEnabled = true;

    // ---- Phase 14 — client discovery cache --------------------------------
    /**
     * Last HA-Discovery-published client state per MAC. Used to detect
     * name-change events (D-P14-PERF-02 anti-storm) — only republish when
     * niceName changes.
     * @type {Map<string, {niceName: string, isWired: boolean}>}
     */
    this._lastClientDiscoveryByMac = new Map();
  }

  /**
   * Start the plugin: read config, derive initial prefix, instantiate client,
   * login, fetch sysinfo, apply post-connect prefix derivation (D-14 step 2),
   * publish bridge availability online.
   *
   * @param {{ mqttService: object, configService: object, logger: object, pluginId: string }} context
   */
  async start(context) {
    this._ctx = context;
    const { mqttService, configService, logger, pluginId } = context;
    this._pluginId = pluginId || 'unifi';

    // ---- 1. Read config + compute initial display name / prefix --------------------

    this._config = configService.get(`plugins.${this._pluginId}`, {}) || {};
    const {
      host,
      username,
      password,
      site = 'default',
      displayName,
      topicPrefix,
      tlsVerify = false,
      autoNamed,
    } = this._config;

    if (!host) throw new Error('UniFi plugin: `host` is required (set it in plugin config)');
    if (!username) throw new Error('UniFi plugin: `username` is required');
    if (!password) throw new Error('UniFi plugin: `password` is required');

    // D-15: pre-connect display name defaults to `UniFi {host}`.
    const initialDisplayName = displayName || `UniFi ${host}`;
    this._displayName = initialDisplayName;

    // D-14 step 1: pre-connect prefix derived from user-entered displayName
    // (fallback to the host's last octet so 192.0.2.1 → "1").
    // Honour an existing topicPrefix when the user has manually overridden it
    // (autoNamed === false locks the slug).
    const initialPrefixSlug = displayName
      ? slugify(displayName)
      : slugify(String(host).split('.').pop());
    const initialPrefix = (topicPrefix && autoNamed === false)
      ? topicPrefix
      : (topicPrefix || `unifi-${initialPrefixSlug}`);
    // Normalize: strip any trailing slash so storage matches Loxone convention
    // (e.g. "unifi-gateway1" not "unifi-gateway1/"). The publish layer always
    // appends "/" when composing topics (see this._prefix + '/...' below).
    this._prefix = String(initialPrefix).replace(/\/+$/, '');
    this._siteName = site;

    // ---- 2. Instantiate UnifiClient + wire event listeners -------------------------

    this._client = new UnifiClient({
      host,
      username,
      password,
      site,
      tlsVerify,
      rememberMe: true,
      logger,
    });

    // Wire client events. Store refs so stop() can remove them cleanly.
    this._clientHandlers = {
      csrf_rotated: ({ to }) => {
        this._lastCsrfRotationAt = Date.now();
        if (logger?.debug) logger.debug(`[unifi] CSRF token rotated → ${String(to).slice(0, 8)}…`);
      },
      sso_account_warning: () => {
        this._ssoAccountWarning = true;
        if (logger?.warn) logger.warn('[unifi] SSO admin detected — recommend creating a local-only admin');
      },
      auth_failed: () => {
        // Surface terminal auth failures via the cached state; the client's
        // own getStatus() already mirrors this but we keep a defensive copy
        // for the post-stop() window when `_client` is null.
        const s = this._client?.getStatus();
        if (s) {
          this._authState = s.authState;
          this._authStateReason = s.authStateReason;
        }
      },
      disconnected: () => {
        this._connected = false;
      },
    };
    for (const [event, handler] of Object.entries(this._clientHandlers)) {
      this._client.on(event, handler);
    }

    // ---- 3. UniFi-OS-vs-legacy detection (D-17) ------------------------------------

    const isUnifiOs = await this._client.checkUnifiOs();
    if (!isUnifiOs) {
      const err = new Error('Legacy CloudKey not supported in v1.1 — please use a UniFi-OS device (UDM / UCG / UDR)');
      this._captureClientState();
      throw err;
    }

    // ---- 4. Login (typed errors surface naturally to PluginManager) ---------------

    await this._client.login();
    this._connected = true;

    // ---- 5. Sysinfo (D-15 — needed for post-connect name resolution) --------------

    let controllerName = null;
    try {
      const sysinfo = await this._client.request({ method: 'GET', path: '/api/system' });
      controllerName = sysinfo?.name || sysinfo?.hostname || null;
    } catch (err) {
      // Sysinfo failure is non-fatal — login already succeeded so the
      // session is healthy. We just can't auto-derive the name.
      if (logger?.warn) logger.warn(`[unifi] /api/system failed (${err.message}); keeping initial prefix ${this._prefix}`);
    }
    this._controllerName = controllerName;
    this._siteName = site; // multi-site deferred (D-03); store configured slug.

    // ---- 6. Apply D-14 step 2 — post-connect prefix + displayName auto-derivation --

    // The auto-derivation gate: autoNamed defaults to TRUE when the field is
    // missing (first-ever connect). User-edit to either field sets autoNamed
    // to false elsewhere; once false we never overwrite (D-14 step 3).
    const shouldAutoName = autoNamed !== false;

    if (shouldAutoName && controllerName) {
      const newSlug = slugify(controllerName);
      const newPrefix = `unifi-${newSlug}`;
      const newDisplayName = `UniFi ${controllerName}`;
      const changed = (newPrefix !== this._prefix) || (newDisplayName !== this._displayName) || (autoNamed !== true);
      if (changed) {
        this._prefix = newPrefix;
        this._displayName = newDisplayName;
        const merged = {
          ...this._config,
          topicPrefix: newPrefix,
          displayName: newDisplayName,
          autoNamed: true,
        };
        this._config = merged;
        try {
          configService.set(`plugins.${this._pluginId}`, merged);
          await configService.save?.();
          if (logger?.info) logger.info(`[unifi] auto-derived topicPrefix=${newPrefix} displayName="${newDisplayName}" from controller name "${controllerName}"`);
        } catch (err) {
          if (logger?.warn) logger.warn(`[unifi] could not persist auto-derived prefix: ${err.message}`);
        }
      }
    }

    // ---- 7. Publish bridge availability (D-22 — single retained MQTT topic) -------

    // Strip trailing slash before composing the topic to avoid `unifi-x//bridge/status`.
    const bridgeStatusTopic = `${this._prefix.replace(/\/$/, '')}/bridge/status`;
    await mqttService.publish(bridgeStatusTopic, 'online', { retain: true });

    // ---- 8. Wire polling lifecycle (Phase 8) --------------------------------------

    // Schema defaults are duplicated here so a config object that pre-dates the
    // Phase 8 schema (autoNamed-style legacy entries) still gets sensible
    // values without requiring a config migration.
    const {
      pollDeviceListSec = 30,
      pollPortStateSec = 5,
      heartbeatSec = 60,
      // Phase 14 — clients config (defaults match config-schema defaults).
      clientsEnabled = true,
      pollClientsSec = 30,
      clientsStaleAfterSec = 300,
      clientsCleanupAfterSec = 86400,
      clientsMaxPublished = 200,
    } = this._config;

    this._poll = new UnifiPoll({
      client: this._client,
      mqttService,
      topicPrefix: this._prefix,
      site: this._siteName,
      pollDeviceListSec,
      pollPortStateSec,
      heartbeatSec,
      clientsEnabled,
      pollClientsSec,
      clientsStaleAfterSec,
      clientsCleanupAfterSec,
      clientsMaxPublished,
      logger,
    });

    this._poll.on('devices-changed', (diff) => this._handleStructureDiff(diff));
    this._poll.on('poll-error', ({ kind, error }) => {
      if (logger?.warn) logger.warn(`[unifi] poll ${kind} failed: ${error.message}`);
    });
    // Phase 14 — client lifecycle → HA Discovery publish / clear.
    this._poll.on('client-seen', ({ mac, state }) => this._handleClientSeen(mac, state));
    this._poll.on('client-changed', ({ mac, state }) => this._handleClientSeen(mac, state));
    this._poll.on('client-removed', ({ mac }) => this._handleClientRemoved(mac));

    // Cold-start sync pass — publishes retained state before start() resolves
    // so subscribers see the initial telemetry surface immediately.
    try {
      await this._poll.runOnce({ kind: 'device-list' });
    } catch (err) {
      // A cold-start failure should not abort the plugin — the timers will
      // retry. Log and continue.
      if (logger?.warn) logger.warn(`[unifi] cold-start poll failed: ${err.message}`);
    }
    this._poll.start();

    // ---- 9. Wire PoE controller + MQTT cmd subscriptions (Phase 9) ----------

    const {
      dryRun = true,
      cyclePortRateLimitMs = 10000,
      speedtestRateLimitMs = 5 * 60_000, // Phase 13 — 5 min default per D-P13-SPD-01
    } = this._config;

    // D-PROTECT-04 — runtime-aware protected check that ORs the hardcoded
    // floor (protected-ports.js) with the LLDP-augmented runtime set built by
    // unifi-poll. Hardcoded TRUE always wins; runtime set EMPTY does NOT
    // disable the floor.
    const isProtectedPortAugmented = (mac, port_idx) => {
      if (isProtectedPort(mac, port_idx)) return true;
      const key = `${(mac || '').toLowerCase()}:${port_idx}`;
      const rt = this._poll?.getRuntimeProtectedPorts?.();
      return rt instanceof Set ? rt.has(key) : false;
    };

    this._poe = createPoEController(this._client, {
      site: this._siteName,
      dryRun,
      cyclePortRateLimitMs,
      speedtestRateLimitMs,
      isProtectedPort: isProtectedPortAugmented,
      getPortTablesByMac: () => this._poll?.getCachedPortTables?.() || new Map(),
      // Resolve Mongo `_id` from the latest poll snapshot so the RMW path
      // can use /rest/device/{_id} (UCG-MAX 404s on /rest/device/{mac}).
      getDeviceIdByMac: (mac) => {
        const snap = this._poll?._lastSnapshot;
        if (!(snap instanceof Map)) return null;
        const entry = snap.get(typeof mac === 'string' ? mac.toLowerCase() : '');
        return entry?._id || null;
      },
      logger,
    });

    this._cmdHandler = (msg) => this._onCmdMessage(msg);
    mqttService.on('message', this._cmdHandler);

    // Initial subscribe pass — whatever the cold-start poll discovered.
    this._syncInitialSubscriptions();

    // ---- 9.5 Phase 11 — HA MQTT Discovery (D-LIFE-01) ----------------------

    const {
      haDiscovery: haDiscoveryCfg = true,
      haDiscoveryPrefix = 'homeassistant',
    } = this._config;
    this._haDiscoveryEnabled = haDiscoveryCfg !== false;
    this._haDiscoveryPrefix = String(haDiscoveryPrefix || 'homeassistant');

    if (this._haDiscoveryEnabled) {
      this._publishHaDiscoveryFromCurrentSnapshot();
    }

    // ---- 10. Cache final state ----------------------------------------------

    this._captureClientState();
    this._running = true;
    if (logger?.info) logger.info(`[unifi] plugin '${this._pluginId}' started (controller=${controllerName || 'unknown'}, site=${site}, prefix=${this._prefix})`);
  }

  /**
   * Stop the plugin: publish offline, tear down the client.
   */
  async stop() {
    if (!this._running && !this._client) return;

    const ctx = this._ctx || {};
    const { mqttService, logger } = ctx;

    // -1. Phase 9 — detach the cmd handler FIRST so no new dispatches start
    //     while we are shutting down.
    if (mqttService && this._cmdHandler) {
      try { mqttService.removeListener('message', this._cmdHandler); } catch { /* best-effort */ }
      this._cmdHandler = null;
    }

    // -0.5 Phase 9 — unsubscribe every cmd topic we registered. Doing this
    //      before stopping the poll prevents any late diff event from racing
    //      a fresh subscribe call against an already-shutting plugin.
    if (mqttService) {
      for (const topic of this._subscribedTopics) {
        try { mqttService.unsubscribe(topic); } catch { /* best-effort */ }
      }
      this._subscribedTopics.clear();
      this._subscribedPortsByMac.clear();
    }

    // -0.25 Phase 9 — drain any in-flight dispatches BEFORE we publish offline
    //       and tear down the client. Promise.allSettled so a rejecting
    //       dispatch cannot deadlock stop().
    if (this._inFlightDispatches.size > 0) {
      try {
        await Promise.allSettled(Array.from(this._inFlightDispatches));
      } catch { /* drained */ }
      this._inFlightDispatches.clear();
    }
    this._poe = null;

    // 0. Stop polling FIRST — clean shutdown of all 3 timers + in-flight tick.
    //    Order matters: the offline publish below must not race with a tick
    //    that's mid-flight (it would re-publish online-state for some devices
    //    just after we set bridge/status=offline).
    if (this._poll) {
      try { await this._poll.stop(); } catch (err) {
        if (logger?.warn) logger.warn(`[unifi] poll.stop() error: ${err.message}`);
      }
      this._poll = null;
    }

    // 0.9 Phase 11 — clear HA Discovery topics BEFORE bridge offline (D-LIFE-03)
    // so HA removes entities cleanly while bridge is still nominally online,
    // then sees offline last.
    if (mqttService && this._haDiscoveryEnabled && this._lastHaDevices.size > 0) {
      try {
        clearDiscovery({
          mqttService,
          instanceId: this._pluginId,
          devices: Array.from(this._lastHaDevices.values()),
          haPrefix: this._haDiscoveryPrefix,
        });
      } catch (err) {
        if (logger?.warn) logger.warn(`[unifi] clearDiscovery failed: ${err.message}`);
      }
    }
    this._lastHaDevices.clear();

    // Phase 14 — also clear client discovery topics so HA removes per-client
    // device_tracker/sensor entities on plugin stop / removal.
    if (mqttService && this._haDiscoveryEnabled && this._lastClientDiscoveryByMac.size > 0) {
      const clients = [];
      for (const [mac, cached] of this._lastClientDiscoveryByMac) {
        clients.push({ mac, is_wired: cached?.isWired ?? false });
      }
      try {
        clearClientDiscovery({
          mqttService,
          instanceId: this._pluginId,
          clients,
          haPrefix: this._haDiscoveryPrefix,
        });
      } catch (err) {
        if (logger?.warn) logger.warn(`[unifi] clearClientDiscovery on stop failed: ${err.message}`);
      }
    }
    this._lastClientDiscoveryByMac.clear();

    // 1. Publish offline (after poll has settled).
    if (mqttService && this._prefix) {
      try {
        const bridgeStatusTopic = `${this._prefix.replace(/\/$/, '')}/bridge/status`;
        await mqttService.publish(bridgeStatusTopic, 'offline', { retain: true });
      } catch (err) {
        if (logger?.warn) logger.warn(`[unifi] could not publish bridge/status=offline: ${err.message}`);
      }
    }

    // 2. Remove client event handlers and disconnect.
    if (this._client) {
      if (this._clientHandlers) {
        for (const [event, handler] of Object.entries(this._clientHandlers)) {
          try { this._client.removeListener(event, handler); } catch { /* best-effort */ }
        }
        this._clientHandlers = null;
      }
      try { await this._client.disconnect(); } catch { /* best-effort */ }
      this._client = null;
    }

    // 3. Reset flags. Preserve cached auth-state so getStatus() can still
    //    show *why* a failed start left the plugin in an error state.
    this._running = false;
    this._connected = false;
    if (logger?.info) logger.info(`[unifi] plugin '${this._pluginId}' stopped`);
  }

  /**
   * Plugin status — additive over the Loxone-style return shape per D-13.
   *
   * Existing fields preserved: running, connected, controlCount, lastEvent,
   * messageCount.
   *
   * Added Phase-7 fields:
   *   - authState           — one of AUTH_STATE values from client
   *   - authStateReason     — substate string (e.g. '2fa_blocked', null on success)
   *   - controllerName      — from /api/system .name (e.g. "Gateway1"), null pre-connect
   *   - siteName            — configured UniFi site identifier
   *   - ssoAccountWarning   — D-11b; true when login response had only_local_account=false
   *   - displayName / topicPrefix — auto-derived final values for UI display
   *
   * PluginManager.getStatus() / listAll() returns this verbatim — additive
   * fields pass through without code change.
   *
   * @returns {object}
   */
  getStatus() {
    const clientStatus = this._client?.getStatus?.() || null;
    // Phase 8 additive metrics — poll may be null pre-start / post-stop.
    const pollMetrics = this._poll?.getMetrics?.() || {
      devicesDiscovered: 0, lastPollSuccessAt: null, pollErrorCount: 0,
    };

    // Phase 10 — build the union of (mac, port_idx) protected pairs.
    //
    // 1. The hardcoded floor (PROTECTED_PORTS, protected-ports.js) is ALWAYS
    //    emitted first with source: 'hardcoded'. The floor exists independently
    //    of the poll lifecycle — `getStatus()` pre-start / post-stop still
    //    returns the floor (T-10-01 mitigation, Test 5).
    //
    // 2. The LLDP-augmented runtime set (unifi-poll._runtimeProtectedPorts)
    //    is appended with source: 'lldp'. Entries with the same (mac, port_idx)
    //    as a hardcoded floor entry are SKIPPED — D-PROTECT-04: hardcoded wins.
    //    A malicious LLDP response cannot displace the floor (T-10-02).
    //
    // Runtime keys are `${mac}:${port_idx}` (see unifi-poll.js:473,495).
    // Parse robustly: port_idx is the trailing integer, mac is the prefix
    // before the last ':'.
    const protectedPorts = [];
    const seenKeys = new Set();
    for (const entry of PROTECTED_PORTS) {
      const key = `${entry.mac}:${entry.port_idx}`;
      seenKeys.add(key);
      protectedPorts.push({ mac: entry.mac, port_idx: entry.port_idx, source: 'hardcoded' });
    }
    const runtime = this._poll?.getRuntimeProtectedPorts?.();
    if (runtime instanceof Set) {
      for (const k of runtime) {
        const lastColon = k.lastIndexOf(':');
        if (lastColon < 0) continue;
        const mac = k.slice(0, lastColon).toLowerCase();
        const port_idx = Number(k.slice(lastColon + 1));
        if (!Number.isInteger(port_idx)) continue;
        const dedupKey = `${mac}:${port_idx}`;
        if (seenKeys.has(dedupKey)) continue; // hardcoded wins
        seenKeys.add(dedupKey);
        protectedPorts.push({ mac, port_idx, source: 'lldp' });
      }
    }

    return {
      running: this._running,
      connected: this._connected,
      // Phase 7 Open Question 1 resolution: controlCount surfaces the device
      // count so the sidebar shows a meaningful number once polling is up.
      controlCount: pollMetrics.devicesDiscovered,
      lastEvent: this._lastEvent,
      messageCount: this._messageCount,
      authState: clientStatus?.authState ?? this._authState,
      authStateReason: clientStatus?.authStateReason ?? this._authStateReason,
      controllerName: this._controllerName,
      siteName: this._siteName,
      ssoAccountWarning: this._ssoAccountWarning,
      displayName: this._displayName,
      topicPrefix: this._prefix,
      lastCsrfRotationAt: clientStatus?.lastCsrfRotationAt ?? this._lastCsrfRotationAt,
      // Phase 8 additive fields (preserve all Phase 7 fields above).
      devicesDiscovered: pollMetrics.devicesDiscovered,
      lastPollSuccessAt: pollMetrics.lastPollSuccessAt,
      pollErrorCount: pollMetrics.pollErrorCount,
      // Phase 10 — additive protected-port surface (D-PROTECT-04).
      protectedPorts,
    };
  }

  /**
   * Public on-demand structure refresh — used by the generic PluginManager hook
   * POST /api/plugins/:id/structure/refresh (server/routes/api-plugins.js:437).
   * Mirrors the Loxone plugin's contract (plugins/loxone/plugin.js:483).
   *
   * Delegates to UnifiPoll.refreshNow() which performs one device-list tick:
   * fetches /stat/device + /stat/sta, rebuilds the snapshot, emits
   * 'devices-changed' on diff, and republishes retained state in both
   * namespaces. Idempotent — if a tick is already in flight, runOnce awaits it
   * before kicking off a fresh one (see unifi-poll.js runOnce()).
   *
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async refreshStructure() {
    if (!this._running || !this._poll || typeof this._poll.refreshNow !== 'function') {
      return { ok: false, reason: 'not_running' };
    }
    await this._poll.refreshNow();
    return { ok: true };
  }

  /**
   * Structure summary — used by the generic PluginManager hook
   * GET /api/plugins/:id/structure/raw (server/routes/api-plugins.js:422).
   * Mirrors the Loxone plugin's `getStructureSummary()` contract.
   *
   * Returns `{ devices: Array<{ mac, name, nameSlug, model, type, port_table }> }`
   * built from the UnifiPoll in-memory caches. Empty `devices` array when the
   * poll has not produced a snapshot yet (pre-start / post-stop / pre-first-tick).
   *
   * The route handler currently 400s when this method is missing — adding it
   * here unblocks the UnifiPorts page (Plan 10-02 Task 1) which fetches
   * /structure/raw on mount.
   *
   * @returns {{ devices: Array<object> }}
   */
  getStructureSummary() {
    if (!this._poll || typeof this._poll.getStructureSummary !== 'function') {
      return { devices: [] };
    }
    return this._poll.getStructureSummary();
  }

  /**
   * Return the JSON-Schema-shaped config form definition for the webapp.
   * Delegates to the standalone module so the probe handler / templates path
   * can `import { getConfigSchema }` without instantiating a plugin.
   *
   * @returns {object}
   */
  getConfigSchema() {
    return getConfigSchema();
  }

  // -- Internals --------------------------------------------------------------

  /**
   * Snapshot the underlying UnifiClient's state into our cached fields so
   * `getStatus()` can answer correctly even after `stop()` has nulled the
   * client reference (e.g. when surfacing why a failed start left us in
   * auth_failed / 2fa_blocked).
   * @private
   */
  _captureClientState() {
    if (!this._client) return;
    const s = this._client.getStatus();
    this._authState = s.authState;
    this._authStateReason = s.authStateReason;
    if (s.lastCsrfRotationAt) this._lastCsrfRotationAt = s.lastCsrfRotationAt;
  }

  /**
   * Phase 9 — dispatch an inbound MQTT cmd message through the PoE controller.
   * Topic parsing:
   *   - by-mac: `${prefix}/by-mac/{macSlug}/port/{idx}/cmd`
   *   - slug:   `${prefix}/{deviceSlug}/port/{idx}/cmd`
   * (by-mac is matched FIRST so the literal `by-mac` segment is not
   * misinterpreted as a device slug.)
   *
   * Resolution:
   *   - by-mac: extract mac from the slug and validate format. Snapshot
   *     lookup → unknown_device on miss.
   *   - slug: reverse-lookup the snapshot for a device with the given
   *     nameSlug → unknown_device on miss.
   *
   * The dispatch promise is added to `_inFlightDispatches` so stop() can
   * drain it before publishing bridge/status=offline (D-MISC-02 / T-09-17).
   *
   * @param {{topic: string, payload: string|Buffer}} msg
   * @private
   */
  async _onCmdMessage(msg) {
    if (!msg || typeof msg.topic !== 'string') return;
    const { topic, payload } = msg;
    const prefix = this._prefix.replace(/\/+$/, '');
    if (!topic.startsWith(`${prefix}/`)) return;

    // Compile the namespace regexes once per call — prefix is per-instance
    // but the rest is fixed. Order matters: by-mac MUST be tested first so
    // its literal segment is not eaten by the slug regex.
    const escapedPrefix = escapeRegExp(prefix);
    const byMacRe = new RegExp(`^${escapedPrefix}/by-mac/([0-9a-f-]+)/port/(\\d+)/cmd$`);
    const slugRe = new RegExp(`^${escapedPrefix}/([^/]+)/port/(\\d+)/cmd$`);
    // Phase 13 — gateway-only wan/cmd topics (D-P13-SPD-01).
    const wanByMacRe = new RegExp(`^${escapedPrefix}/by-mac/([0-9a-f-]+)/wan/cmd$`);
    const wanSlugRe = new RegExp(`^${escapedPrefix}/([^/]+)/wan/cmd$`);

    // Try wan/cmd first — it's a distinct topic shape with no port_idx.
    const wanByMacMatch = topic.match(wanByMacRe);
    const wanSlugMatch = wanByMacMatch ? null : topic.match(wanSlugRe);
    if (wanByMacMatch || wanSlugMatch) {
      return this._onWanCmdMessage(topic, payload, wanByMacMatch, wanSlugMatch, prefix);
    }

    let mac = null;
    let port_idx = null;
    let resolvedSlug = null;

    const byMacMatch = topic.match(byMacRe);
    if (byMacMatch) {
      const macSlugStr = byMacMatch[1];
      mac = macSlugStr.replace(/-/g, ':');
      port_idx = parseInt(byMacMatch[2], 10);
      if (!/^[0-9a-f:]{17}$/.test(mac)) {
        this._publishResultToTopic(
          `${prefix}/by-mac/${macSlugStr}/port/${port_idx}/result`,
          { status: 'unknown_device', action: 'unknown', ts: new Date().toISOString() },
        );
        return;
      }
      const snapshot = this._poll?._lastSnapshot;
      const entry = snapshot instanceof Map ? snapshot.get(mac) : null;
      if (!entry) {
        this._publishResultToTopic(
          `${prefix}/by-mac/${macSlugStr}/port/${port_idx}/result`,
          { status: 'unknown_device', action: 'unknown', ts: new Date().toISOString() },
        );
        return;
      }
      resolvedSlug = entry.nameSlug;
    } else {
      const slugMatch = topic.match(slugRe);
      if (!slugMatch) return;          // Not a cmd topic of either shape.
      resolvedSlug = slugMatch[1];
      if (resolvedSlug === 'by-mac') return; // Defensive — by-mac already handled.
      port_idx = parseInt(slugMatch[2], 10);
      // Reverse-lookup mac by current nameSlug.
      const snapshot = this._poll?._lastSnapshot;
      if (snapshot instanceof Map) {
        for (const [m, e] of snapshot) {
          if (e?.nameSlug === resolvedSlug) { mac = m; break; }
        }
      }
      if (!mac) {
        this._publishResultToTopic(
          `${prefix}/${resolvedSlug}/port/${port_idx}/result`,
          { status: 'unknown_device', action: 'unknown', ts: new Date().toISOString() },
        );
        return;
      }
    }

    if (!this._poe) return; // Defensive — stop() in progress.

    const payloadStr = String(payload ?? '');
    const dispatchPromise = (async () => {
      try {
        const result = await this._poe.dispatch(mac, port_idx, payloadStr);
        this._publishResult(mac, port_idx, resolvedSlug, result);
      } catch (err) {
        // Defensive: dispatch should never throw, but if it does, surface a
        // write_failed result so subscribers see the failure (D-MISC-02 spirit).
        this._publishResult(mac, port_idx, resolvedSlug, {
          status: 'write_failed',
          action: 'unknown',
          ts: new Date().toISOString(),
          error: String(err?.message || err),
        });
      }
    })();
    this._inFlightDispatches.add(dispatchPromise);
    dispatchPromise.finally(() => this._inFlightDispatches.delete(dispatchPromise));
  }

  /**
   * Publish a result object to BOTH the slug-based and by-mac result topics,
   * each non-retained per D-RESULT-01.
   *
   * @param {string} mac
   * @param {number} port_idx
   * @param {string|null} slug
   * @param {object} result
   * @private
   */
  _publishResult(mac, port_idx, slug, result) {
    if (!this._ctx?.mqttService || !this._prefix) return;
    const prefix = this._prefix.replace(/\/+$/, '');
    const macLower = (mac || '').toLowerCase();
    const macSlugStr = macSlug(macLower);
    const payload = JSON.stringify(result);
    if (slug) {
      this._ctx.mqttService.publish(`${prefix}/${slug}/port/${port_idx}/result`, payload, { retain: false });
    }
    this._ctx.mqttService.publish(`${prefix}/by-mac/${macSlugStr}/port/${port_idx}/result`, payload, { retain: false });
  }

  /**
   * Publish a single result object to a specific result topic, non-retained.
   * Used for unknown_device responses where we cannot compose both namespaces.
   * @private
   */
  _publishResultToTopic(topic, result) {
    if (!this._ctx?.mqttService) return;
    this._ctx.mqttService.publish(topic, JSON.stringify(result), { retain: false });
  }

  /**
   * Initial subscribe pass — runs once after start() so whatever the
   * cold-start poll discovered is already subscribed by the time the first
   * MQTT publish arrives.
   * @private
   */
  _syncInitialSubscriptions() {
    const portTables = this._poll?.getCachedPortTables?.() || new Map();
    const snapshot = this._poll?._lastSnapshot;
    if (!(snapshot instanceof Map)) return;
    for (const [mac, entry] of snapshot) {
      this._subscribePortsForDevice(mac, entry.nameSlug, portTables.get(mac) || []);
      // Phase 13 — gateway-only wan/cmd subscriptions (D-P13-SPD-01).
      if (entry.type === 'gateway' || entry.type === 'udm' || entry.type === 'ugw') {
        this._subscribeWanCmdForGateway(mac, entry.nameSlug);
      }
    }
  }

  /**
   * Phase 13 — subscribe to {prefix}/{slug}/wan/cmd + by-mac form for one
   * gateway device. Idempotent.
   * @private
   */
  _subscribeWanCmdForGateway(mac, nameSlug) {
    if (!this._ctx?.mqttService || !this._prefix || !nameSlug) return;
    const macLower = (mac || '').toLowerCase();
    const macSlugStr = macSlug(macLower);
    const prefix = this._prefix.replace(/\/+$/, '');
    const slugTopic = `${prefix}/${nameSlug}/wan/cmd`;
    const macTopic = `${prefix}/by-mac/${macSlugStr}/wan/cmd`;
    if (!this._subscribedTopics.has(slugTopic)) {
      this._ctx.mqttService.subscribe(slugTopic);
      this._subscribedTopics.add(slugTopic);
    }
    if (!this._subscribedTopics.has(macTopic)) {
      this._ctx.mqttService.subscribe(macTopic);
      this._subscribedTopics.add(macTopic);
    }
  }

  /**
   * Phase 13 — handle wan/cmd dispatch. Only `speedtest` is currently
   * supported; any other payload returns `not_supported`.
   * @private
   */
  async _onWanCmdMessage(topic, payload, wanByMacMatch, wanSlugMatch, prefix) {
    let mac = null;
    let resolvedSlug = null;

    if (wanByMacMatch) {
      const macSlugStr = wanByMacMatch[1];
      mac = macSlugStr.replace(/-/g, ':');
      if (!/^[0-9a-f:]{17}$/.test(mac)) {
        this._publishResultToTopic(
          `${prefix}/by-mac/${macSlugStr}/wan/result`,
          { status: 'unknown_device', action: 'unknown', ts: new Date().toISOString() },
        );
        return;
      }
      const snapshot = this._poll?._lastSnapshot;
      const entry = snapshot instanceof Map ? snapshot.get(mac) : null;
      if (!entry) {
        this._publishResultToTopic(
          `${prefix}/by-mac/${macSlugStr}/wan/result`,
          { status: 'unknown_device', action: 'unknown', ts: new Date().toISOString() },
        );
        return;
      }
      resolvedSlug = entry.nameSlug;
    } else {
      resolvedSlug = wanSlugMatch[1];
      if (resolvedSlug === 'by-mac') return;
      const snapshot = this._poll?._lastSnapshot;
      if (snapshot instanceof Map) {
        for (const [m, e] of snapshot) {
          if (e?.nameSlug === resolvedSlug) { mac = m; break; }
        }
      }
      if (!mac) {
        this._publishResultToTopic(
          `${prefix}/${resolvedSlug}/wan/result`,
          { status: 'unknown_device', action: 'unknown', ts: new Date().toISOString() },
        );
        return;
      }
    }

    const payloadStr = String(payload ?? '').trim().toLowerCase();
    if (payloadStr !== 'speedtest') {
      this._publishWanResult(mac, resolvedSlug, {
        status: 'not_supported',
        action: payloadStr || 'unknown',
        ts: new Date().toISOString(),
        reason: 'only "speedtest" is currently supported',
      });
      return;
    }

    if (!this._poe || typeof this._poe.speedtest !== 'function') return;

    const dispatchPromise = (async () => {
      try {
        const result = await this._poe.speedtest(mac);
        this._publishWanResult(mac, resolvedSlug, result);
      } catch (err) {
        this._publishWanResult(mac, resolvedSlug, {
          status: 'write_failed',
          action: 'speedtest',
          ts: new Date().toISOString(),
          error: String(err?.message || err),
        });
      }
    })();
    this._inFlightDispatches.add(dispatchPromise);
    dispatchPromise.finally(() => this._inFlightDispatches.delete(dispatchPromise));
  }

  /**
   * Phase 13 — publish a wan/result envelope to both namespaces, non-retained.
   * @private
   */
  _publishWanResult(mac, slug, result) {
    if (!this._ctx?.mqttService || !this._prefix) return;
    const prefix = this._prefix.replace(/\/+$/, '');
    const macLower = (mac || '').toLowerCase();
    const macSlugStr = macSlug(macLower);
    const payload = JSON.stringify(result);
    if (slug) {
      this._ctx.mqttService.publish(`${prefix}/${slug}/wan/result`, payload, { retain: false });
    }
    this._ctx.mqttService.publish(`${prefix}/by-mac/${macSlugStr}/wan/result`, payload, { retain: false });
  }

  /**
   * Subscribe to /cmd topics for every PoE-capable port_idx in `portTable`
   * for the given (mac, nameSlug). Both namespaces (slug + by-mac).
   *
   * Idempotent — re-subscribing an already-subscribed topic is suppressed by
   * the `_subscribedTopics` set.
   *
   * @param {string} mac
   * @param {string} nameSlug
   * @param {Array<object>} portTable
   * @private
   */
  _subscribePortsForDevice(mac, nameSlug, portTable) {
    if (!this._ctx?.mqttService || !this._prefix || !nameSlug) return;
    const macLower = (mac || '').toLowerCase();
    const macSlugStr = macSlug(macLower);
    const prefix = this._prefix.replace(/\/+$/, '');
    const poePorts = [];
    for (const p of portTable) {
      if (!p || p.port_poe !== true) continue;
      const idx = Number(p.port_idx);
      if (!Number.isInteger(idx) || idx < 1) continue;
      poePorts.push(idx);
      const slugTopic = `${prefix}/${nameSlug}/port/${idx}/cmd`;
      const macTopic = `${prefix}/by-mac/${macSlugStr}/port/${idx}/cmd`;
      if (!this._subscribedTopics.has(slugTopic)) {
        this._ctx.mqttService.subscribe(slugTopic);
        this._subscribedTopics.add(slugTopic);
      }
      if (!this._subscribedTopics.has(macTopic)) {
        this._ctx.mqttService.subscribe(macTopic);
        this._subscribedTopics.add(macTopic);
      }
    }
    this._subscribedPortsByMac.set(macLower, poePorts);
  }

  /**
   * Unsubscribe /cmd topics for the given device. `keepByMac:true` is used by
   * the rename branch (D-MISC-01 — by-mac topics survive renames).
   *
   * @param {string} mac
   * @param {string} nameSlug
   * @param {{keepByMac?: boolean}} [opts]
   * @private
   */
  _unsubscribePortsForDevice(mac, nameSlug, { keepByMac = false } = {}) {
    if (!this._ctx?.mqttService || !this._prefix) return;
    const macLower = (mac || '').toLowerCase();
    const macSlugStr = macSlug(macLower);
    const prefix = this._prefix.replace(/\/+$/, '');
    const ports = this._subscribedPortsByMac.get(macLower) || [];
    for (const idx of ports) {
      if (nameSlug) {
        const slugTopic = `${prefix}/${nameSlug}/port/${idx}/cmd`;
        if (this._subscribedTopics.has(slugTopic)) {
          this._ctx.mqttService.unsubscribe(slugTopic);
          this._subscribedTopics.delete(slugTopic);
        }
      }
      if (!keepByMac) {
        const macTopic = `${prefix}/by-mac/${macSlugStr}/port/${idx}/cmd`;
        if (this._subscribedTopics.has(macTopic)) {
          this._ctx.mqttService.unsubscribe(macTopic);
          this._subscribedTopics.delete(macTopic);
        }
      }
    }
    if (!keepByMac) this._subscribedPortsByMac.delete(macLower);
  }

  /**
   * Handle a structure diff emitted by UnifiPoll. Per D-S-02 / D-S-03:
   *
   *   - Renames → retain-clear OLD slug-based state topics ONLY. The by-mac
   *     namespace is MAC-keyed (D-T-04) so it survives renames; the next poll
   *     re-publishes under the same by-mac topic with the new state.
   *   - Removals → retain-clear BOTH slug AND by-mac state topics for the
   *     removed device.
   *   - Adds → no-op. The next poll's _publishAllDevices pass populates the
   *     new topics with retained state.
   *
   * CRITICAL invariant (D-S-02 verbatim — verified in
   * tests/plugins/unifi/plugin-structure-monitor.test.js Test 13):
   * NEVER touch /cmd topics. Empty payload on a retained cmd topic
   * re-delivers to the cmd subscriber and zeros the underlying value
   * (Loxone-hard-learned lesson, see plugins/loxone/structure-monitor.js
   * lines 95-109).
   *
   * @param {{added:Array, renamed:Array, removed:Array, unchanged:number}} diff
   * @private
   */
  _handleStructureDiff(diff) {
    if (!this._ctx || !this._prefix) return;
    const { mqttService, logger } = this._ctx;
    if (!mqttService) return;

    const prefix = this._prefix.replace(/\/+$/, '');

    // --- Renames: clear OLD slug-based state topics ONLY (D-S-02) ---
    for (const r of diff.renamed || []) {
      const oldBase = `${prefix}/${r.oldNameSlug}`;
      mqttService.publish(`${oldBase}/state`, '', { retain: true });
      const portCount = r.entry?.portCount ?? 0;
      for (let idx = 1; idx <= portCount; idx++) {
        mqttService.publish(`${oldBase}/port/${idx}/state`, '', { retain: true });
      }
      if (logger?.info) {
        logger.info(`[unifi] device renamed mac=${r.mac}: ${r.oldNameSlug} -> ${r.newNameSlug}; state topics cleared (cmd preserved per D-S-02)`);
      }
      // NOTE: by-mac topics are MAC-keyed (D-T-04) and survive renames by design.
    }

    // --- Removals: clear BOTH slug AND by-mac state topics (D-S-03) ---
    for (const removed of diff.removed || []) {
      const slug = removed.nameSlug;
      const slugBase = `${prefix}/${slug}`;
      const macBase = `${prefix}/by-mac/${macSlug(removed.mac)}`;
      const portCount = removed.portCount ?? 0;

      mqttService.publish(`${slugBase}/state`, '', { retain: true });
      mqttService.publish(`${macBase}/state`, '', { retain: true });
      for (let idx = 1; idx <= portCount; idx++) {
        mqttService.publish(`${slugBase}/port/${idx}/state`, '', { retain: true });
        mqttService.publish(`${macBase}/port/${idx}/state`, '', { retain: true });
      }
      if (logger?.info) {
        logger.info(`[unifi] device removed mac=${removed.mac}: state topics cleared in both namespaces (cmd preserved)`);
      }
    }

    // --- Adds: no-op for retain-clear. Next poll publishes the new state.

    // --- Phase 9 subscribe-lifecycle (D-MISC-01) -----------------------------
    // Renames: unsubscribe OLD slug-based cmd topics, subscribe NEW slug-based.
    // by-mac stays subscribed across renames (keepByMac:true).
    const portTables = this._poll?.getCachedPortTables?.() || new Map();
    for (const r of diff.renamed || []) {
      this._unsubscribePortsForDevice(r.mac, r.oldNameSlug, { keepByMac: true });
      const newSlug = r.newNameSlug || r.entry?.nameSlug;
      this._subscribePortsForDevice(r.mac, newSlug, portTables.get((r.mac || '').toLowerCase()) || []);
    }
    // Removals: unsubscribe both namespaces.
    for (const removed of diff.removed || []) {
      this._unsubscribePortsForDevice(removed.mac, removed.nameSlug, { keepByMac: false });
    }
    // Adds: subscribe both namespaces.
    for (const added of diff.added || []) {
      this._subscribePortsForDevice(added.mac, added.nameSlug, portTables.get((added.mac || '').toLowerCase()) || []);
      // Phase 13 — add wan/cmd subscriptions for newly-added gateways.
      if (added.type === 'gateway' || added.type === 'udm' || added.type === 'ugw') {
        this._subscribeWanCmdForGateway(added.mac, added.nameSlug);
      }
    }

    // --- Phase 11 — HA Discovery refresh on structure change (D-LIFE-01) -----
    if (this._haDiscoveryEnabled) {
      // Removals → clear the discovery topics for the removed device set first.
      if ((diff.removed || []).length > 0) {
        const removedDevices = [];
        for (const removed of diff.removed) {
          const macLower = (removed.mac || '').toLowerCase();
          const prev = this._lastHaDevices.get(macLower);
          if (prev) removedDevices.push(prev);
          this._lastHaDevices.delete(macLower);
        }
        if (removedDevices.length > 0) {
          try {
            clearDiscovery({
              mqttService,
              instanceId: this._pluginId,
              devices: removedDevices,
              haPrefix: this._haDiscoveryPrefix,
            });
          } catch (err) {
            if (logger?.warn) logger.warn(`[unifi] clearDiscovery on removal failed: ${err.message}`);
          }
        }
      }

      // Adds + renames → publish (republish) the current snapshot. publishDiscovery
      // is idempotent over retained topics, so re-running it on every diff with
      // the full device set is safe.
      if ((diff.added || []).length > 0 || (diff.renamed || []).length > 0) {
        this._publishHaDiscoveryFromCurrentSnapshot();
      }
    }
  }

  /**
   * Phase 14 — handle `client-seen` / `client-changed` events from UnifiPoll.
   *
   * Publishes HA Discovery for the client EXACTLY ONCE per session unless the
   * friendly name changes (D-P14-PERF-02 anti-storm). Tracks the last-published
   * niceName per MAC in `_lastClientDiscoveryByMac`.
   *
   * @param {string} mac
   * @param {object} state  Normalised ClientState already published to MQTT.
   * @private
   */
  _handleClientSeen(mac, state) {
    if (!this._haDiscoveryEnabled) return;
    if (!this._ctx?.mqttService) return;
    if (!mac || !state) return;
    const macLower = String(mac).toLowerCase();
    const niceName = state.name || state.hostname || macLower;
    const prev = this._lastClientDiscoveryByMac.get(macLower);
    const alreadyPublished = this._poll?.hasClientDiscoveryPublished?.(macLower);
    if (alreadyPublished && prev && prev.niceName === niceName && prev.isWired === state.is_wired) {
      // No-op: discovery already published with the same name + connection type.
      return;
    }

    try {
      publishClientDiscovery({
        mqttService: this._ctx.mqttService,
        instanceId: this._pluginId,
        topicPrefix: this._prefix,
        clients: [state],
        haPrefix: this._haDiscoveryPrefix,
      });
      this._lastClientDiscoveryByMac.set(macLower, { niceName, isWired: !!state.is_wired });
      this._poll?.markClientDiscoveryPublished?.(macLower);
    } catch (err) {
      if (this._ctx?.logger?.warn) {
        this._ctx.logger.warn(`[unifi] publishClientDiscovery(${macLower}) failed: ${err.message}`);
      }
    }
  }

  /**
   * Phase 14 — handle `client-removed` events emitted by the presence-cleanup
   * sweep. Retain-clears the HA Discovery topics for the removed client.
   *
   * @param {string} mac
   * @private
   */
  _handleClientRemoved(mac) {
    if (!this._haDiscoveryEnabled) return;
    if (!this._ctx?.mqttService) return;
    if (!mac) return;
    const macLower = String(mac).toLowerCase();
    const cached = this._lastClientDiscoveryByMac.get(macLower);
    // Even if cached is null, attempt clear with a minimal client shape so the
    // standard topic set gets cleared (defensive against process restarts that
    // lost the in-memory cache between sessions).
    const clientForClear = { mac: macLower, is_wired: cached?.isWired ?? false };
    try {
      clearClientDiscovery({
        mqttService: this._ctx.mqttService,
        instanceId: this._pluginId,
        clients: [clientForClear],
        haPrefix: this._haDiscoveryPrefix,
      });
      this._lastClientDiscoveryByMac.delete(macLower);
    } catch (err) {
      if (this._ctx?.logger?.warn) {
        this._ctx.logger.warn(`[unifi] clearClientDiscovery(${macLower}) failed: ${err.message}`);
      }
    }
  }

  /**
   * Phase 11 — build the structure-summary device list from the poll's
   * in-memory caches and publish HA Discovery for every PoE-capable port.
   *
   * Drives the gated-by-haDiscovery wiring from start() AND the diff-driven
   * republish from _handleStructureDiff. The device list shape mirrors
   * UnifiPoll.getStructureSummary() — `{mac, name, nameSlug, model, type,
   * port_table}` where port_table carries the raw `{port_idx, port_poe, name}`
   * entries (ha-discovery.js gates on port_poe===true; D-HAD-04 — non-PoE
   * skipped).
   *
   * Records the published set into `_lastHaDevices` so stop() / removal can
   * later retain-clear the exact same topics.
   *
   * @private
   */
  _publishHaDiscoveryFromCurrentSnapshot() {
    if (!this._haDiscoveryEnabled) return;
    if (!this._ctx?.mqttService) return;

    const snapshot = this._poll?._lastSnapshot;
    if (!(snapshot instanceof Map) || snapshot.size === 0) return;
    const portTables = this._poll?.getCachedPortTables?.() || new Map();

    const devices = [];
    for (const [mac, entry] of snapshot) {
      const portTable = portTables.get(mac) || [];
      const device = {
        mac,
        name: entry.name || '',
        nameSlug: entry.nameSlug,
        model: entry.model || '',
        type: entry.type || '',
        port_table: portTable,
      };
      devices.push(device);
      this._lastHaDevices.set(mac, device);
    }

    try {
      publishDiscovery({
        mqttService: this._ctx.mqttService,
        topicPrefix: this._prefix,
        instanceId: this._pluginId,
        devices,
        haPrefix: this._haDiscoveryPrefix,
      });
    } catch (err) {
      if (this._ctx.logger?.warn) {
        this._ctx.logger.warn(`[unifi] publishDiscovery failed: ${err.message}`);
      }
    }
  }
}
