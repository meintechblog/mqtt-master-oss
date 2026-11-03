/**
 * Loxone bridge plugin -- bidirectional MQTT bridge with HA Discovery.
 *
 * Orchestrates sub-modules:
 *  - LoxoneWs: WebSocket client to Miniserver
 *  - LoxoneStructure: UUID mapper / structure parser
 *  - MoodManager: mood caching, fetching, resolution
 *  - StructureMonitor: change detection, stale topic cleanup
 *  - BindingsManager: MQTT input binding lifecycle
 *  - ha-discovery: Home Assistant MQTT Discovery publishing
 */
import { LoxoneWs } from './loxone-ws.js';
import { LoxoneStructure } from './loxone-structure.js';
import { MoodManager } from './mood-manager.js';
import { StructureMonitor } from './structure-monitor.js';
import { BindingsManager } from '../lib/bindings-manager.js';
import { publishHaDiscovery } from './ha-discovery.js';

/** Plugin types whose commands come from Loxone state topics (commandSourceTopics()). */
const COMMAND_SOURCE_PLUGINS = ['dreame'];
/** Loxone uuid as the Miniserver writes it; it also takes control names in jdev/sps/io. */
const LOXONE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/;

export default class LoxonePlugin {
  constructor() {
    /** @type {LoxoneWs|null} */
    this._ws = null;
    /** @type {LoxoneStructure|null} */
    this._structure = null;
    this._running = false;
    this._connected = false;
    this._controlCount = 0;
    this._lastEvent = null;
    this._messageCount = 0;
    this._prefix = 'loxone';
    this._config = {};
    this._ctx = null;

    /** @type {Function|null} bound MQTT message handler for cleanup */
    this._mqttHandler = null;
    /** @type {object|null} stored WS event handler refs for cleanup */
    this._wsHandlers = null;

    /** @type {string[]} UUIDs of disabled controls */
    this._disabledControls = [];

    /** @type {Array<object>} active topic route definitions */
    this._topicRoutes = [];
    /** @type {Map<string, Function>} active topic route subscription handlers */
    this._routeHandlers = new Map();

    /** @type {Map<string, { value?: number, text?: string }>} stateUuid -> last known value */
    this._stateCache = new Map();
    /** @type {Map<string, string>} state topic this plugin published -> stateUuid */
    this._publishedTopics = new Map();
    /** @type {Map<string, number>} stateUuid -> value reported by the Miniserver, never by sent commands */
    this._liveValues = new Map();

    this._moodManager = new MoodManager();
    this._structureMonitor = new StructureMonitor();
    this._bindingsManager = null;

    /** @type {ReturnType<typeof setInterval>|null} */
    this._republishInterval = null;
    /** @type {number} interval in ms; 0 disables the heartbeat */
    this._republishIntervalMs = 0;
  }

  /**
   * Start the plugin: fetch structure, connect WebSocket, wire events.
   * @param {{ mqttService: object, configService: object, logger: object, pluginId: string }} context
   */
  async start(context) {
    this._ctx = context;
    const { mqttService, configService, logger, pluginId } = context;
    this._pluginId = pluginId || 'loxone';

    // 1. Read config
    this._config = configService.get(`plugins.${this._pluginId}`, {});
    const {
      ip = '127.0.0.1',
      port = 80,
      username = '',
      password = '',
      prefix = 'loxone',
      enableHaDiscovery = true,
    } = this._config;

    this._prefix = prefix;
    this._disabledControls = this._config.disabledControls || [];
    this._moodMappings = this._config.moodMappings || {};

    // 2. Create structure parser and fetch structure
    this._structure = new LoxoneStructure(prefix);
    try {
      const loxApp3 = await this._structure.fetchStructure(ip, port, username, password);
      this._structure.buildMap(loxApp3, { logger });
      this._structureVersion = loxApp3?.lastModified || null;
    } catch (err) {
      logger.error(`Failed to fetch Loxone structure: ${err.message}`);
      throw err;
    }

    const controls = this._structure.getAll();
    this._controlCount = controls.length;
    this._structureMonitor.snapshot(this._structure);
    logger.info(`Loxone structure loaded: ${this._controlCount} controls`);

    // 3. Create WebSocket client
    this._ws = new LoxoneWs({ host: ip, port, user: username, pass: password, logger });

    // 4. Wire events (store refs for cleanup)
    this._wsHandlers = {
      valueEvent: ({ uuid, value }) => this._onValueEvent(uuid, value),
      textEvent: ({ uuid, text }) => {
        logger.debug(`textEvent uuid=${uuid} text=${text.substring(0, 120)}`);
        this._onTextEvent(uuid, text);
      },
      textMessage: (text) => logger.debug(`textMessage: ${text.substring(0, 200)}`),
      debugPayload: ({ identifier, length }) => {
        logger.debug(`Unknown binary payload: identifier=0x${identifier.toString(16)}, length=${length}`);
      },
      textStateEvent: (text) => {
        logger.debug(`textStateEvent: ${text.substring(0, 200)}`);
        this._moodManager.handleTextStateEvent(text, this._structure, logger);
      },
      disconnected: () => this._onWsDisconnected(),
      reconnected: async () => {
        logger.info('Loxone WebSocket reconnected, re-fetching structure');
        await this._refreshStructure();
      },
    };
    for (const [event, handler] of Object.entries(this._wsHandlers)) {
      this._ws.on(event, handler);
    }

    // 5. Subscribe to MQTT cmd topics (name-based and UUID-based)
    mqttService.subscribe(`${prefix}/+/+/cmd`);
    mqttService.subscribe(`${prefix}/+/+/+/cmd`);
    mqttService.subscribe(`${prefix}/by-uuid/+/cmd`);

    // 6. Wire MQTT messages -> WebSocket commands
    this._mqttHandler = (msg) => this._onMqttMessage(msg);
    mqttService.on('message', this._mqttHandler);

    // 7. Connect WebSocket
    await this._ws.connect();
    this._connected = true;

    // 8. Publish HA Discovery if enabled
    if (enableHaDiscovery) {
      publishHaDiscovery({
        structure: this._structure,
        mqttService,
        prefix: this._prefix,
        isEnabled: (uuid) => this._isControlEnabled(uuid),
      });
    }

    // 9. Publish bridge status online
    mqttService.publish(`${prefix}/bridge/status`, 'online', { retain: true });

    // Heartbeat republish: re-emit all cached states every X seconds with retain=true
    // so subscribers (HA, dashboards) see a fresh timestamp even when the underlying
    // Loxone value is constant. 0 disables the heartbeat entirely.
    const republishSec = Number.isFinite(Number(this._config.republishIntervalSec))
      ? Math.max(0, Math.floor(Number(this._config.republishIntervalSec)))
      : 60;
    this._republishIntervalMs = republishSec * 1000;
    if (this._republishIntervalMs > 0) {
      this._republishInterval = setInterval(
        () => this._republishCachedStates(),
        this._republishIntervalMs,
      );
    }

    // 10. Request mood lists
    this._moodManager.requestMoodLists({
      structure: this._structure,
      ws: this._ws,
      stateCache: this._stateCache,
      logger,
    });

    // 11. Set up topic routes
    this._topicRoutes = this._config.topicRoutes || [];
    this._applyTopicRoutes();

    // 12. Set up MQTT input bindings.
    // Route through sendControlCommand so the optimistic state-cache update
    // also fires for binding-driven writes — otherwise peekControlValue()
    // would still read the pre-write Loxone value for 1-2s after each send,
    // showing the user a phantom drift on the dashboard.
    this._bindingsManager = new BindingsManager({
      configKey: `plugins.${this._pluginId}`,
      sendToTarget: (uuid, value) => {
        if (this._ws) this.sendControlCommand(uuid, value);
      },
    });
    this._bindingsManager.init(context, this._config);

    // 13. Periodic structure check
    this._structureMonitor.startPolling(() => this._refreshStructure());

    this._running = true;
    logger.info('Loxone bridge plugin started');
  }

  /**
   * Stop the plugin: disconnect, unsubscribe, clean up.
   */
  async stop() {
    if (!this._running && !this._ctx) return;

    const { mqttService, logger } = this._ctx || {};

    // 1. Publish offline status
    if (mqttService) {
      mqttService.publish(`${this._prefix}/bridge/status`, 'offline', { retain: true });
    }

    // 2. Remove WebSocket event handlers and disconnect
    if (this._ws) {
      if (this._wsHandlers) {
        for (const [event, handler] of Object.entries(this._wsHandlers)) {
          this._ws.removeListener(event, handler);
        }
        this._wsHandlers = null;
      }
      await this._ws.disconnect();
      this._ws = null;
    }

    // 3. Unsubscribe from MQTT cmd topics
    if (mqttService) {
      mqttService.unsubscribe(`${this._prefix}/+/+/cmd`);
      mqttService.unsubscribe(`${this._prefix}/+/+/+/cmd`);
      mqttService.unsubscribe(`${this._prefix}/by-uuid/+/cmd`);
    }

    // 4. Remove MQTT message listener
    if (mqttService && this._mqttHandler) {
      mqttService.removeListener('message', this._mqttHandler);
      this._mqttHandler = null;
    }

    // 5. Clean up sub-modules
    this._cleanupRouteHandlers();
    if (this._bindingsManager) this._bindingsManager.cleanup();
    this._structureMonitor.stopPolling();
    if (this._republishInterval) {
      clearInterval(this._republishInterval);
      this._republishInterval = null;
    }
    this._republishIntervalMs = 0;

    // 6. Clear state
    this._running = false;
    this._connected = false;
    this._controlCount = 0;
    this._lastEvent = null;
    this._structure = null;
    this._stateCache.clear();
    this._publishedTopics.clear();
    this._liveValues.clear();

    if (logger) logger.info('Loxone bridge plugin stopped');
  }

  /**
   * Return current plugin status.
   */
  getStatus() {
    return {
      running: this._running,
      connected: this._connected,
      controlCount: this._controlCount,
      lastEvent: this._lastEvent,
      messageCount: this._messageCount,
      connection: this._ws?.getConnectionStats?.() || null,
    };
  }

  /**
   * Return JSON Schema for the plugin configuration form.
   */
  getConfigSchema() {
    return {
      type: 'object',
      properties: {
        displayName: {
          type: 'string',
          title: 'Display Name',
          description: 'Name shown in the sidebar (e.g. "Miniserver Wohnung")',
        },
        ip: {
          type: 'string',
          title: 'Miniserver IP',
          description: 'IP address or hostname of the Loxone Miniserver',
        },
        port: {
          type: 'integer',
          title: 'Port',
          default: 80,
          description: 'HTTP/WebSocket port',
        },
        username: { type: 'string', title: 'Username' },
        password: { type: 'string', title: 'Password', format: 'password' },
        prefix: {
          type: 'string',
          title: 'MQTT Topic Prefix',
          default: 'loxone',
          description: 'Root prefix for all Loxone MQTT topics',
        },
        autoStart: {
          type: 'boolean',
          title: 'Auto-start',
          default: false,
          description: 'Start the plugin automatically when the server starts',
        },
        enableHaDiscovery: {
          type: 'boolean',
          title: 'Home Assistant Discovery',
          default: true,
          description: 'Publish MQTT Discovery messages for Home Assistant auto-detection',
        },
        republishIntervalSec: {
          type: 'integer',
          title: 'Heartbeat-Intervall (s)',
          default: 60,
          minimum: 0,
          description: '0 = aus. Sonst werden alle X Sekunden alle gecachten Werte erneut gepublisht (retained), damit Empfänger einen frischen Timestamp sehen auch wenn sich der Wert nicht ändert.',
        },
      },
    };
  }

  // --- Controls management ---

  getControls() {
    if (!this._structure) return [];
    return this._structure.getAll().map(ctrl => ({
      uuid: ctrl.uuid,
      name: ctrl.name,
      type: ctrl.type,
      room: ctrl.room,
      topic: ctrl.topic,
      enabled: !this._disabledControls.includes(ctrl.uuid),
    }));
  }

  getDetailedControls() {
    if (!this._structure) return [];
    const tree = this._structure.getControlTree();

    return tree.map(ctrl => {
      const states = {};
      for (const s of ctrl.states) {
        states[s.key] = this._stateCache.get(s.uuid) || null;
      }

      const subControls = ctrl.subControls.map(sub => {
        const subStates = {};
        for (const s of sub.states) {
          subStates[s.key] = this._stateCache.get(s.uuid) || null;
        }
        return { uuid: sub.uuid, name: sub.name, type: sub.type, topic: sub.topic, states: subStates };
      });

      let moods = this._moodManager.getMoods(ctrl.uuid);

      // Determine active mood IDs
      let activeMoodIds = [];
      if (states.activeMoods && states.activeMoods.text) {
        try { activeMoodIds = JSON.parse(states.activeMoods.text); } catch { /* ignore */ }
      } else if (states.activeMoodsNum && states.activeMoodsNum.value != null) {
        activeMoodIds = [states.activeMoodsNum.value];
      }

      // Resolve mood names from config mapping (per-control override → defaults)
      if (ctrl.type === 'LightControllerV2') {
        const resolved = this._resolveMoodMapping(ctrl.uuid, activeMoodIds);
        moods = resolved.moods;
        if (resolved.activeMoodName) {
          // Attach for display
        }
      }

      return {
        uuid: ctrl.uuid,
        name: ctrl.name,
        type: ctrl.type,
        room: ctrl.room,
        category: ctrl.category || '',
        description: ctrl.description || '',
        topic: ctrl.topic,
        enabled: !this._disabledControls.includes(ctrl.uuid),
        states,
        subControls,
        moods,
        activeMoodIds,
        activeMoodName: ctrl.type === 'LightControllerV2'
          ? this._getMoodName(ctrl.uuid, activeMoodIds[0]) : null,
      };
    });
  }

  /**
   * Aggregate summary of what the plugin parsed out of LoxAPP3.json.
   *
   * Derived ENTIRELY from the in-memory control tree — no second LoxAPP3.json
   * fetch, no state-cache reads. Used by the Structure Inspector debug panel
   * on the plugin detail page so the user can see live what the running
   * plugin actually sees after every "In Miniserver speichern" without
   * grepping logs or restarting the plugin.
   *
   * Returns an empty/defensive shape when the structure isn't loaded
   * (plugin stopped or pre-start). Route handler translates a missing
   * plugin instance to HTTP 400 before this is called.
   */
  getStructureSummary() {
    if (!this._structure) {
      return {
        running: false,
        controlCount: 0,
        typeCounts: {},
        rooms: [],
        categories: [],
        missingRoom: [],
        missingCategory: [],
        withDescription: 0,
        withoutDescription: 0,
        controls: [],
      };
    }

    const tree = this._structure.getControlTree();

    const typeCounts = {};
    const roomSet = new Set();
    const categorySet = new Set();
    const missingRoom = [];
    const missingCategory = [];
    let withDescription = 0;
    let withoutDescription = 0;

    const controls = tree.map(ctrl => {
      typeCounts[ctrl.type] = (typeCounts[ctrl.type] || 0) + 1;

      const hasRoom = !!ctrl.room && ctrl.room !== 'unknown';
      if (hasRoom) roomSet.add(ctrl.room);
      else missingRoom.push(ctrl.name);

      const hasCategory = !!ctrl.category;
      if (hasCategory) categorySet.add(ctrl.category);
      else missingCategory.push(ctrl.name);

      if (ctrl.description) withDescription++;
      else withoutDescription++;

      return {
        uuid: ctrl.uuid,
        name: ctrl.name,
        type: ctrl.type,
        room: ctrl.room,
        category: ctrl.category || '',
        description: ctrl.description || '',
        topic: ctrl.topic,
        stateKeys: (ctrl.states || []).map(s => s.key),
        subControlCount: (ctrl.subControls || []).length,
      };
    });

    return {
      running: this._running,
      controlCount: tree.length,
      typeCounts,
      rooms: [...roomSet].sort((a, b) => a.localeCompare(b)),
      categories: [...categorySet].sort((a, b) => a.localeCompare(b)),
      missingRoom,
      missingCategory,
      withDescription,
      withoutDescription,
      controls,
    };
  }

  /**
   * Public, on-demand wrapper around the existing private _refreshStructure()
   * flow used by the WS reconnect handler and the 60s StructureMonitor poller.
   * Re-fetches LoxAPP3.json from the Miniserver, rebuilds the structure map,
   * runs change detection (which republishes HA Discovery only on real
   * changes), and hands the freshly-derived summary back so the UI gets the
   * new state in a single round-trip.
   */
  async refreshStructure() {
    await this._refreshStructure({ force: true });
    return this.getStructureSummary();
  }

  async setControlEnabled(uuid, enabled) {
    if (enabled) {
      this._disabledControls = this._disabledControls.filter(id => id !== uuid);
    } else {
      if (!this._disabledControls.includes(uuid)) {
        this._disabledControls.push(uuid);
      }
    }
    this._config.disabledControls = this._disabledControls;
    if (this._ctx) {
      this._ctx.configService.set(`plugins.${this._pluginId}`, this._config);
      await this._ctx.configService.save();
    }
  }

  /**
   * True when `uuid` is a control or subcontrol of the loaded structure.
   * The REST command route only forwards commands for these.
   */
  hasControl(uuid) {
    if (!this._structure) return false;
    for (const ctrl of this._structure.getControlTree()) {
      if (ctrl.uuid === uuid) return true;
      if (ctrl.subControls?.some((sub) => sub.uuid === uuid)) return true;
    }
    return false;
  }

  sendControlCommand(uuid, command) {
    if (!this._ws) throw new Error('WebSocket not connected');
    // Virtual inputs outside the structure stay writable, but only by uuid:
    // a name or another spelling would bypass the command-source check.
    if (typeof uuid !== 'string' || !LOXONE_UUID.test(uuid)) throw new Error(`target is no Loxone uuid: ${uuid}`);
    if (this._isCommandSource(uuid)) throw new Error('control is a command source of another plugin');
    const cmd = `jdev/sps/io/${uuid}/${command}`;
    this._ctx.logger.info(`API→Loxone: ${uuid} → ${cmd}`);
    this._ws.sendCommand(cmd);
    this._cacheSentValue(uuid, command);
  }

  /**
   * Optimistically reflect a just-sent value in the state cache so that
   * peekControlValue() reads `command` immediately after a successful send,
   * rather than the previous Loxone-reported value. Loxone's WS state-event
   * broadcasts can lag a written value by 1-2s, which surfaced in
   * /bindings/stats as a phantom drift between `value` (sent) and
   * `loxoneValue` (cached). When Loxone's confirming event eventually
   * arrives, _onValueEvent overwrites this cache entry with the truth — so
   * if anything else touched the control on Loxone's side, the next refresh
   * still corrects the display.
   *
   * Resolves the same state UUID that peekControlValue uses, so the cache
   * key matches both for InfoOnlyAnalog (control UUID === value-state UUID)
   * and other control types where the two UUIDs differ.
   * @private
   */
  _cacheSentValue(controlUuid, command) {
    if (!this._stateCache || !this._structure) return;
    const num = Number(command);
    if (!Number.isFinite(num)) return;
    const tree = this._structure.getControlTree?.() || [];
    const stateUuidFor = (uuid) => {
      for (const c of tree) {
        if (c.uuid === uuid) {
          const states = c.states || [];
          const v = states.find(s => s.key === 'value') || states[0];
          return v?.uuid || uuid;
        }
        for (const sub of c.subControls || []) {
          if (sub.uuid === uuid) {
            const states = sub.states || [];
            const v = states.find(s => s.key === 'value') || states[0];
            return v?.uuid || uuid;
          }
        }
      }
      return uuid;
    };
    this._stateCache.set(stateUuidFor(controlUuid), { value: num });
  }

  // --- Mood mapping ---

  /** Default mood names (apply to all LightControllerV2 unless overridden) */
  static DEFAULT_MOODS = {
    '-1': 'Manuell',
    1: 'Nacht',
    2: 'Abend',
    3: 'Tag',
    777: 'Viel Licht',
    778: 'Aus',
  };

  /**
   * Get mood name for a given activeMoodsNum value.
   * Checks per-control override first, then defaults.
   */
  _getMoodName(controlUuid, moodNum) {
    if (moodNum == null) return null;
    const perControl = this._moodMappings[controlUuid];
    if (perControl && perControl[String(moodNum)] != null) return perControl[String(moodNum)];
    const defaults = this._moodMappings._defaults || LoxonePlugin.DEFAULT_MOODS;
    if (defaults[String(moodNum)] != null) return defaults[String(moodNum)];
    return `Mood #${moodNum}`;
  }

  /**
   * Build moods array from config mapping for a control.
   * Merges defaults + per-control overrides.
   */
  _resolveMoodMapping(controlUuid, activeMoodIds) {
    const defaults = this._moodMappings._defaults || LoxonePlugin.DEFAULT_MOODS;
    const perControl = this._moodMappings[controlUuid] || {};
    const merged = { ...defaults, ...perControl };

    const moods = Object.entries(merged).map(([id, name]) => ({
      id: Number(id),
      name,
    })).sort((a, b) => a.id - b.id);

    const activeMoodName = activeMoodIds.length > 0
      ? this._getMoodName(controlUuid, activeMoodIds[0])
      : null;

    return { moods, activeMoodName };
  }

  /** Get mood mappings (defaults + per-control). */
  getMoodMappings() {
    return {
      _defaults: this._moodMappings._defaults || LoxonePlugin.DEFAULT_MOODS,
      ...Object.fromEntries(
        Object.entries(this._moodMappings).filter(([k]) => k !== '_defaults')
      ),
    };
  }

  /** Set mood mappings and persist. */
  async setMoodMappings(mappings) {
    this._moodMappings = mappings;
    this._config.moodMappings = mappings;
    if (this._ctx) {
      this._ctx.configService.set(`plugins.${this._pluginId}`, this._config);
      await this._ctx.configService.save();
    }
  }

  // --- Topic routes management ---

  getTopicRoutes() {
    return [...this._topicRoutes];
  }

  async setTopicRoutes(routes) {
    this._topicRoutes = routes;
    this._config.topicRoutes = routes;
    if (this._ctx) {
      this._ctx.configService.set(`plugins.${this._pluginId}`, this._config);
      await this._ctx.configService.save();
    }
    this._applyTopicRoutes();
  }

  // --- Input bindings management ---

  getInputBindings() {
    return this._bindingsManager.getBindings();
  }

  getInputBindingStats() {
    const stats = this._bindingsManager?.getStats?.() || [];
    // Augment with the *current* Loxone-reported value for each target so
    // the UI sees both "what we sent" and "what Loxone reports" from the
    // same instant — eliminates poll-cadence drift as a source of confusion.
    for (const stat of stats) {
      const v = this.peekControlValue(stat.targetUuid);
      if (v != null) stat.loxoneValue = v;
    }
    return stats;
  }

  /**
   * Synchronous helper for sibling plugins (mqtt-bridge) that need to read
   * the live Loxone value for a control without going through the async
   * /controls/detailed payload. Returns null when the structure isn't
   * loaded yet or the uuid isn't a known control.
   */
  peekControlValue(controlUuid) {
    if (!this._stateCache || !this._structure) return null;
    const tree = this._structure.getControlTree?.() || [];
    const findValueState = (c) => {
      if (c.uuid === controlUuid) {
        const states = c.states || [];
        const v = states.find(s => s.key === 'value') || states[0];
        return v?.uuid || null;
      }
      for (const sub of c.subControls || []) {
        if (sub.uuid === controlUuid) {
          const states = sub.states || [];
          const v = states.find(s => s.key === 'value') || states[0];
          return v?.uuid || null;
        }
      }
      return null;
    };
    for (const c of tree) {
      const stateUuid = findValueState(c);
      if (stateUuid) {
        const cached = this._stateCache.get(stateUuid);
        if (cached) return cached.value ?? cached;
        return null;
      }
    }
    return null;
  }

  /**
   * the current Loxone value behind a state topic this
   * plugin itself published, taken from the Miniserver connection, not from
   * the broker. Consumers of Loxone state topics compare a received value with
   * it, so a foreign publisher on the broker cannot inject a value.
   * Only values the Miniserver reported count (not the optimistic cache of sent
   * commands), only while the control is enabled and still publishes on this
   * topic, and only until the connection drops.
   * @param {string} topic
   * @returns {number|null} null for topics never published by this plugin or without a value
   */
  peekPublishedValue(topic) {
    const uuid = this._publishedTopics.get(topic);
    if (!uuid || !this._isControlEnabled(uuid)) return null;
    const meta = this._structure?.getMeta(uuid);
    if (!meta || (topic !== `${meta.topic}/state` && topic !== `${this._prefix}/by-uuid/${meta.uuid}/state`)) return null;
    const value = this._liveValues.get(uuid);
    return typeof value === 'number' ? value : null;
  }

  /**
   * true when `uuid` is behind a Loxone state topic another
   * plugin takes commands from (Dreame `befehlThema`), or is a parent control of
   * it, or is an input the plugin names as feeding that control in the Miniserver
   * logic (commandSourceUuids()). Such a control must only change in
   * the Miniserver itself: written through this plugin, the Miniserver would
   * report the value back and peekPublishedValue() would confirm it. Fails closed
   * (true) when the command sources cannot be read.
   * @param {string} uuid
   */
  _isCommandSource(uuid) {
    try {
      return this._commandSourceUuids().has(uuid);
    } catch (err) {
      this._ctx.logger.warn(`command sources unreadable, write refused: ${err.message}`);
      return true;
    }
  }

  _commandSourceUuids() {
    const uuids = new Set();
    const pm = this._ctx.pluginManager;
    const sources = COMMAND_SOURCE_PLUGINS.flatMap((type) => pm?.getInstancesByType?.(type) ?? []);
    for (const source of sources) {
      // N1: inputs that feed the command control in the Miniserver logic
      for (const u of source?.commandSourceUuids?.() ?? []) {
        if (typeof u === 'string' && LOXONE_UUID.test(u)) uuids.add(u);
      }
      const topics = source?.commandSourceTopics?.() ?? [];
      for (const topic of topics) {
        if (typeof topic !== 'string' || !topic.endsWith('/state')) continue;
        const base = topic.slice(0, -'/state'.length);
        const byUuid = `${this._prefix}/by-uuid/`;
        const own = this._publishedTopics.get(topic) ?? (base.startsWith(byUuid) ? base.slice(byUuid.length) : null);
        let path = base;
        if (own) {
          uuids.add(own);
          path = this._structure?.getMeta(own)?.topic ?? base;
        }
        // the state's control and every parent control (subcontrol → control)
        const parts = path.split('/');
        for (let n = parts.length; n > 1; n -= 1) {
          const parent = this._structure?.topicToUuid(parts.slice(0, n).join('/'));
          if (parent) uuids.add(parent);
        }
      }
    }
    // state uuids of those controls address the same input
    for (const ctrl of this._structure?.getControlTree?.() ?? []) {
      for (const c of [ctrl, ...(ctrl.subControls || [])]) {
        if (uuids.has(c.uuid)) for (const s of c.states || []) uuids.add(s.uuid);
      }
    }
    return uuids;
  }

  /** The Miniserver sends all states again after a reconnect; until then nothing is confirmed. */
  _onWsDisconnected() {
    this._liveValues.clear();
  }

  async setInputBindings(bindings) {
    await this._bindingsManager.setBindings(bindings);
  }

  // --- Internal methods ---

  _onValueEvent(uuid, value) {
    this._stateCache.set(uuid, { value });
    this._liveValues.set(uuid, value);
    if (!this._isControlEnabled(uuid)) return;

    const meta = this._structure.getMeta(uuid);
    if (!meta) return;

    const payload = JSON.stringify({
      value, name: meta.name, type: meta.type, uuid: meta.uuid, room: meta.room,
    });
    this._publishedTopics.set(`${meta.topic}/state`, uuid);
    this._publishedTopics.set(`${this._prefix}/by-uuid/${meta.uuid}/state`, uuid);
    this._ctx.mqttService.publish(`${meta.topic}/state`, payload, { retain: true });
    this._ctx.mqttService.publish(`${this._prefix}/by-uuid/${meta.uuid}/state`, payload, { retain: true });

    // Publish resolved mood name when activeMoodsNum changes
    if (meta.stateKey === 'activeMoodsNum') {
      const controlTopic = meta.topic.replace(/\/activeMoodsNum$/, '');
      const controlUuid = this._structure.topicToUuid(controlTopic);
      if (controlUuid) this._publishMoodState(controlTopic, controlUuid, value);
    }

    this._lastEvent = Date.now();
    this._messageCount++;
  }

  _publishMoodState(controlTopic, controlUuid, moodNum) {
    const moodPayload = JSON.stringify({
      id: moodNum, name: this._getMoodName(controlUuid, moodNum), uuid: controlUuid,
    });
    this._ctx.mqttService.publish(`${controlTopic}/mood/state`, moodPayload, { retain: true });
    this._ctx.mqttService.publish(`${this._prefix}/by-uuid/${controlUuid}/mood/state`, moodPayload, { retain: true });
  }

  /**
   * After a structure reload: states of new controls may have arrived before the
   * new structure was loaded (status dump right after a reconnect). They are in
   * the state cache but were never published, because their meta was unknown.
   * Publish them once now (same retained values and enable checks as the
   * heartbeat) and derive mood/state and the mood list of every light controller
   * from this connection's cached activeMoodsNum / moodList, gated like the
   * event path by the state UUID.
   * @private
   */
  _publishAfterStructureChange() {
    this._republishCachedStates();
    for (const ctrl of this._structure.getControlTree()) {
      if (ctrl.type !== 'LightControllerV2') continue;
      const state = (key) => ctrl.states.find(s => s.key === key);
      const list = state('moodList');
      const listText = list && this._isControlEnabled(list.uuid) ? this._stateCache.get(list.uuid)?.text : undefined;
      if (listText) this._moodManager.parseMoodListText(ctrl.uuid, listText);
      const num = state('activeMoodsNum');
      const value = num && this._isControlEnabled(num.uuid) ? this._stateCache.get(num.uuid)?.value : undefined;
      if (value != null) this._publishMoodState(ctrl.topic, ctrl.uuid, value);
    }
  }

  _onTextEvent(uuid, text) {
    this._stateCache.set(uuid, { text });
    if (!this._isControlEnabled(uuid)) return;

    const meta = this._structure.getMeta(uuid);
    if (!meta) return;

    // Detect moodList state events and cache mood name→id mapping
    if (meta.stateKey === 'moodList') {
      const controlTopic = meta.topic.replace(/\/moodList$/, '');
      const controlUuid = this._structure.topicToUuid(controlTopic);
      if (controlUuid) {
        if (this._moodManager.parseMoodListText(controlUuid, text)) {
          this._ctx.logger.info(`Cached moods for ${meta.name}`);
        }
      }
    }

    const payload = JSON.stringify({
      text, name: meta.name, type: meta.type, uuid: meta.uuid, room: meta.room,
    });
    this._ctx.mqttService.publish(`${meta.topic}/state`, payload, { retain: true });
    this._ctx.mqttService.publish(`${this._prefix}/by-uuid/${meta.uuid}/state`, payload, { retain: true });
    this._lastEvent = Date.now();
    this._messageCount++;
  }

  /**
   * Heartbeat: re-publish every cached state with retain=true. Triggered on the
   * configured republishIntervalSec interval. Mirrors the per-event publishes
   * in _onValueEvent / _onTextEvent for the value and text branches, but does
   * NOT re-emit the mood/state pair from cache — the mood/state publish is
   * derived from a real activeMoodsNum *event*, and re-emitting it from cache
   * would risk drift across plugin restarts. The retained activeMoodsNum
   * publish covers the cold-start case for HA's mood resolver indirectly.
   * @private
   */
  _republishCachedStates() {
    if (!this._structure || !this._ctx) return;
    const { mqttService } = this._ctx;
    for (const [uuid, cached] of this._stateCache) {
      if (!this._isControlEnabled(uuid)) continue;
      const meta = this._structure.getMeta(uuid);
      if (!meta) continue;
      let payload;
      if (typeof cached.value !== 'undefined') {
        payload = JSON.stringify({
          value: cached.value, name: meta.name, type: meta.type, uuid: meta.uuid, room: meta.room,
        });
      } else if (typeof cached.text !== 'undefined') {
        payload = JSON.stringify({
          text: cached.text, name: meta.name, type: meta.type, uuid: meta.uuid, room: meta.room,
        });
      } else {
        continue;
      }
      mqttService.publish(`${meta.topic}/state`, payload, { retain: true });
      mqttService.publish(`${this._prefix}/by-uuid/${meta.uuid}/state`, payload, { retain: true });
    }
  }

  _onMqttMessage({ topic, payload }) {
    if (!topic.startsWith(this._prefix + '/') || !topic.endsWith('/cmd')) return;

    // Drop empty/whitespace payloads. They typically come from retained
    // cleanups (structure-monitor clearing stale topics) and would otherwise
    // forward as `jdev/sps/io/<uuid>/` — Loxone interprets that as 0 and
    // clobbers the InfoOnlyAnalog value seconds after a binding update.
    const payloadStr = (payload == null ? '' : String(payload)).trim();
    if (!payloadStr) return;

    let uuid;
    const uuidPrefix = `${this._prefix}/by-uuid/`;

    if (topic.startsWith(uuidPrefix)) {
      // UUID-based: loxone/by-uuid/{uuid}/cmd
      uuid = topic.slice(uuidPrefix.length, -4); // strip prefix and /cmd
      // Only uuids of the loaded structure: the Miniserver also takes control
      // names (and other spellings) in jdev/sps/io, which would bypass the
      // command-source check below.
      if (!this._structure.getMeta(uuid)) uuid = undefined;
    } else {
      // Name-based: loxone/{room}/{control}/cmd
      const controlTopic = topic.slice(0, -4);
      uuid = this._structure.topicToUuid(controlTopic);
    }

    if (!uuid) {
      this._ctx.logger.warn(`No UUID found for cmd topic: ${topic}`);
      return;
    }
    if (this._isCommandSource(uuid)) {
      this._ctx.logger.warn(`cmd refused, control is a command source of another plugin: ${topic}`);
      return;
    }

    // Translate changeTo/{moodName} → changeTo/{moodId} using mood mapping
    let resolvedPayload = payloadStr;
    const changeToMatch = payloadStr.match(/^changeTo\/(.+)$/);
    if (changeToMatch) {
      const moodRef = changeToMatch[1];
      // If it's not already a number, look up the name in mappings
      if (isNaN(Number(moodRef))) {
        const defaults = this._moodMappings._defaults || LoxonePlugin.DEFAULT_MOODS;
        const perControl = this._moodMappings[uuid] || {};
        const merged = { ...defaults, ...perControl };
        // Find ID by name (case-insensitive)
        const entry = Object.entries(merged).find(
          ([, name]) => name.toLowerCase() === moodRef.toLowerCase()
        );
        if (entry) {
          resolvedPayload = `changeTo/${entry[0]}`;
          this._ctx.logger.info(`Mood resolved: ${moodRef} → ID ${entry[0]}`);
        }
      }
    }

    const cmd = `jdev/sps/io/${uuid}/${resolvedPayload}`;
    this._ctx.logger.info(`MQTT→Loxone: ${topic} → ${cmd}`);
    this._ws.sendCommand(cmd);
    this._cacheSentValue(uuid, resolvedPayload);
  }

  /**
   * Re-read the structure. Without `force`, first asks the Miniserver for the
   * structure version (a few bytes) and skips the full LoxAPP3.json download
   * when it is unchanged – the periodic poll then costs the Miniserver almost
   * nothing. If the version check fails, falls back to the full fetch.
   * @param {{force?: boolean}} [opts]
   */
  async _refreshStructure({ force = false } = {}) {
    if (!this._ctx || !this._structure) return;
    const { mqttService, logger } = this._ctx;
    const { ip, port = 80, username, password, enableHaDiscovery } = this._config;

    let version = null;
    if (!force) {
      try {
        version = await this._structure.fetchVersion(ip, port, username, password);
        if (this._structureVersion && version === this._structureVersion) return;
      } catch (err) {
        logger.debug?.(`Structure version check failed, full fetch: ${err.message}`);
      }
    }

    try {
      const loxApp3 = await this._structure.fetchStructure(ip, port, username, password);
      this._structure.buildMap(loxApp3, { logger });
      this._structureVersion = loxApp3?.lastModified || version || null;
    } catch (err) {
      logger.warn(`Structure refresh failed: ${err.message}`);
      return;
    }

    this._controlCount = this._structure.getAll().length;

    const changes = this._structureMonitor.detectChanges({
      structure: this._structure,
      mqttService,
      logger,
    });

    // After every rebuild, also when detectChanges() sees nothing (e.g. only state UUIDs changed)
    this._publishAfterStructureChange();

    if (changes > 0) {
      logger.info(`Structure updated: ${changes} change(s), ${this._controlCount} controls total`);
      if (enableHaDiscovery) {
        publishHaDiscovery({
          structure: this._structure,
          mqttService,
          prefix: this._prefix,
          isEnabled: (uuid) => this._isControlEnabled(uuid),
        });
      }
    }

    this._structureMonitor.snapshot(this._structure);
  }

  _isControlEnabled(uuid) {
    const disabled = this._config.disabledControls || [];
    return !disabled.includes(uuid);
  }

  _applyTopicRoutes() {
    if (!this._ctx) return;
    const { mqttService, logger } = this._ctx;

    this._cleanupRouteHandlers();

    for (const route of this._topicRoutes) {
      if (!route.enabled) continue;
      if (route.direction !== 'inbound' && route.direction !== 'outbound') continue;

      mqttService.subscribe(route.sourceTopic);

      const handler = (msg) => {
        if (msg.topic === route.sourceTopic) {
          mqttService.publish(route.targetTopic, msg.payload);
        }
      };
      mqttService.on('message', handler);
      this._routeHandlers.set(`${route.direction}:${route.id}`, { handler, topic: route.sourceTopic });

      logger.info(`Topic route: ${route.sourceTopic} -> ${route.targetTopic} (${route.direction})`);
    }
  }

  _cleanupRouteHandlers() {
    if (!this._ctx) return;
    const { mqttService } = this._ctx;

    for (const [, entry] of this._routeHandlers) {
      mqttService.removeListener('message', entry.handler);
      mqttService.unsubscribe(entry.topic);
    }
    this._routeHandlers.clear();
  }
}
