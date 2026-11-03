/**
 * DreamePlugin - Dreame / Mova robot vacuums over the Dreamehome cloud.
 *
 * Replaces the Home Assistant integration for the two robots (EG / OG):
 *   - publishes state below `<topicRoot>/<key>/...` (default `haus/sauger`) as
 *     retained `{"v":..., "ts":...}` JSON: zustand, akku-prozent, fehler,
 *     verbunden, plus `<topicRoot>/online` (retained, doubles as availability);
 *   - listens on the configured Loxone state topic (`befehlThema`) of each
 *     device. The topic carries a standing value (1 start, 2 pause, 0 stop and
 *     return to base); only a value *change* after the initial sync acts
 *     (CommandGate), never a retained message, a start or a reconnect. A value
 *     counts only when the Loxone plugin shows the same value from its
 *     Miniserver connection, so a foreign publisher on the broker
 *     cannot inject a command; a value that is already gone again when its
 *     message arrives is dropped (standing values, no pulses);
 *   - acknowledges each executed command on `<topicRoot>/<key>/ereignis/befehl`
 *     (not retained).
 *
 * Lifecycle (start / stop / getStatus / getConfigSchema) follows
 * plugins/unifi/plugin.js. Secrets (password, refresh key, tokens) and device
 * ids never reach logs, topics or payloads; topics use the config `key`.
 *
 * Config (plugins.<id>): username, password and/or refreshToken, country,
 * topicRoot, pollSeconds, devices[] (see config-schema.js).
 */
import { DreameCloud } from './dreame-cloud.js';
import { CommandGate, loxoneValue } from './dreame-commands.js';
import { mapState } from './dreame-state.js';
import { getConfigSchema } from './config-schema.js';

/** Loxone uuid as the Miniserver sends it (lowercase, 8-4-4-16). */
const LOXONE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/;

const DEFAULT_ROOT = 'haus/sauger';
const MIN_POLL_SECONDS = 15;
const HEARTBEAT_MS = 10 * 60 * 1000; // republish unchanged values this often
const RETURN_DELAY_MS = 2000; // pause between "stop" and "return to base"

// unbelegt: MIOT ids are the generic ones from Tasshack/dreame-vacuum; not yet
// verified on the real X40 Ultra (r2449a) and Mova E30 Ultra (r2427a).
const PROP_STATE = { siid: 2, piid: 1 };
const PROP_ERROR = { siid: 2, piid: 2 };
const PROP_BATTERY = { siid: 3, piid: 1 };
const ACTION_START = { siid: 2, aiid: 1 };
const ACTION_PAUSE = { siid: 2, aiid: 2 };
const ACTION_STOP = { siid: 4, aiid: 2 };
const ACTION_DOCK = { siid: 3, aiid: 1 };

const KEY_RE = /^[a-z0-9-]+$/;
const pk = (p) => `${p.siid}.${p.piid}`;

/** Whole number from a raw value, or null. */
function toInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * pluginId -> device key -> (command id -> ts), shared by every run so a QoS 1 redelivery after
 * stop()/start()/reload() stays refused. The PluginManager re-imports this module with a
 * cache-bust and builds a new instance each time, so the memory lives on globalThis.
 * A process restart loses it; accepted, because mqttService connects with clean: true and the
 * broker redelivers nothing.
 */
const ID_STORE = Symbol.for('mqtt-master.dreame.ids');
function idMemoryFor(pluginId) {
  const all = globalThis[ID_STORE] ?? (globalThis[ID_STORE] = new Map());
  return all.get(pluginId) ?? all.set(pluginId, new Map()).get(pluginId);
}

export default class DreamePlugin {
  constructor() {
    this._running = false;
    this._pluginId = 'dreame';
    this._ctx = null;
    this._cloud = null;
    this._root = DEFAULT_ROOT;
    /** @type {Array<object>} per configured device: { cfg, key, gate, record, values, cmdTopic, returnTimer, cmdSeq, failing } */
    this._devs = [];
    this._resolved = false;
    this._pollTimer = null;
    this._polling = false;
    /** topic -> { v, ts } last published value (change detection + heartbeat) */
    this._last = new Map();
    this._msgHandler = null;
    this._connectedHandler = null;
    this._chains = new Map();
    this._authLogged = false;
    /** run counter: raised by start() and stop(); a command chain of an older run never sends */
    this._gen = 0;
  }

  getConfigSchema() {
    return getConfigSchema();
  }

  /**
   * @param {{ mqttService: object, configService: object, logger: object, pluginId: string,
   *   deps?: { createCloud?: Function, fetch?: Function, sleep?: Function, mqttConnect?: Function } }} context
   */
  async start(context) {
    if (this._running) await this.stop();
    const { mqttService, configService, logger, pluginId } = context;
    const deps = context.deps || {};
    this._gen += 1;
    this._ctx = context;
    this._pluginId = pluginId || 'dreame';
    const cfg = configService.get(`plugins.${this._pluginId}`, {}) || {};

    // ---- 1. validate config (messages never contain values) -----------------
    if (!cfg.username) throw new Error('dreame: username is required');
    if (!cfg.password && !cfg.refreshToken) throw new Error('dreame: password or refresh key is required');
    if (!Array.isArray(cfg.devices) || cfg.devices.length === 0) throw new Error('dreame: devices must be a non-empty list');
    const root = cfg.topicRoot || DEFAULT_ROOT;
    if (!/^[^#+$\s][^#+\s]*[^/#+\s]$/.test(root)) throw new Error('dreame: topicRoot is invalid');
    const seen = new Set();
    for (const d of cfg.devices) {
      if (!d || typeof d.key !== 'string' || !KEY_RE.test(d.key) || seen.has(d.key)) {
        throw new Error('dreame: every device needs a unique key matching [a-z0-9-]+');
      }
      seen.add(d.key);
      if (!d.did && !d.name && !d.model) throw new Error(`dreame: device '${d.key}' needs did, name or model`);
    }

    this._root = root;
    this._last = new Map();
    this._resolved = false;
    this._authLogged = false;
    this._chains = new Map();
    this._pollSeconds = Math.max(MIN_POLL_SECONDS, Number(cfg.pollSeconds) || 60);
    const idMemory = idMemoryFor(this._pluginId);
    this._devs = cfg.devices.map((d) => ({
      cfg: d, key: d.key, gate: new CommandGate({
        log: (text) => logger?.warn?.(`[dreame] device '${d.key}': ${text}`),
        ids: idMemory.get(d.key) ?? idMemory.set(d.key, new Map()).get(d.key),
      }), record: null, values: {},
      cmdTopic: null, returnTimer: null, cmdSeq: 0, failing: false,
    }));

    // ---- 2. cloud client ------------------------------------------------------
    const cloudOpts = {
      username: cfg.username,
      password: cfg.password || undefined,
      refreshToken: cfg.refreshToken || undefined,
      country: cfg.country || 'eu',
      logger,
      fetch: deps.fetch,
      sleep: deps.sleep,
      mqttConnect: deps.mqttConnect ?? (deps.fetch ? null : (await import('mqtt')).default.connect),
      onRefreshToken: (token) => this._persistRefreshToken(token),
    };
    this._cloud = deps.createCloud ? deps.createCloud(cloudOpts) : new DreameCloud(cloudOpts);
    this._running = true;

    // ---- 3. commands: subscribe + message routing -----------------------------
    const seenTopics = new Set();
    for (const dev of this._devs) {
      const t = dev.cfg.befehlThema;
      if (typeof t !== 'string' || t === '' || /[#+]/.test(t) || t === root || t.startsWith(`${root}/`) || seenTopics.has(t)) {
        // would loop back into our own state topics or listen on wildcards
        logger?.warn?.(`[dreame] device '${dev.key}': command topic missing or not allowed, commands disabled`);
        continue;
      }
      seenTopics.add(t);
      dev.cmdTopic = t;
    }
    for (const dev of this._devs) {
      const list = dev.cfg.befehlVorlaeufer;
      const bad = Array.isArray(list) ? list.filter((u) => typeof u !== 'string' || !LOXONE_UUID.test(u)).length : 0;
      // a typo would leave that input writable through the Loxone plugin
      if (bad) logger?.warn?.(`[dreame] device '${dev.key}': ${bad} befehlVorlaeufer entries are no lowercase Loxone uuid, ignored`);
    }
    this._msgHandler = (msg) => this._onMessage(msg);
    this._connectedHandler = () => {
      for (const dev of this._devs) {
        if (!dev.cmdTopic) continue;
        dev.gate.reset(); // the first value after a reconnect is an initial sync again
        mqttService.subscribe(dev.cmdTopic);
      }
    };
    mqttService.on('message', this._msgHandler);
    mqttService.on('connected', this._connectedHandler);
    for (const dev of this._devs) if (dev.cmdTopic) mqttService.subscribe(dev.cmdTopic);

    // ---- 4. availability, first poll, timer -------------------------------------
    this._publish(`${root}/online`, 1, true);
    await this._pollAll();
    if (this._running) this._pollTimer = setInterval(() => { this._pollAll(); }, this._pollSeconds * 1000);
    logger?.info?.(`[dreame] plugin '${this._pluginId}' started (${this._devs.length} devices)`);
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    this._gen += 1;
    const { mqttService, logger } = this._ctx;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    for (const dev of this._devs) {
      if (dev.returnTimer) clearTimeout(dev.returnTimer);
      dev.returnTimer = null;
      if (dev.cmdTopic) { try { mqttService.unsubscribe(dev.cmdTopic); } catch { /* best-effort */ } }
    }
    try { mqttService.removeListener('message', this._msgHandler); } catch { /* best-effort */ }
    try { mqttService.removeListener('connected', this._connectedHandler); } catch { /* best-effort */ }
    try { this._cloud?.stopPush(); } catch { /* best-effort */ }
    // aborts calls in flight and their retries, so nothing reaches a robot after stop
    try { this._cloud?.close?.(); } catch { /* best-effort */ }
    this._publish(`${this._root}/online`, 0, true, true);
    logger?.info?.(`[dreame] plugin '${this._pluginId}' stopped`);
  }

  /**
   * the Loxone state topics this plugin takes commands
   * from. The Loxone plugin refuses writes to the controls behind them, so only
   * the Miniserver itself can set a command value.
   * @returns {string[]}
   */
  commandSourceTopics() {
    if (!this._running) return [];
    return this._devs.filter((d) => d.cmdTopic).map((d) => d.cmdTopic);
  }

  /**
   * Loxone inputs that feed the
   * command control in the Miniserver logic (`befehlVorlaeufer`, e.g. visualised
   * pause inputs). They are settable through jdev/sps/io as well, so the Loxone
   * plugin refuses writes to them too. Only lowercase Loxone uuids, no duplicates.
   * @returns {string[]}
   */
  commandSourceUuids() {
    if (!this._running) return [];
    const uuids = this._devs.flatMap((d) => (Array.isArray(d.cfg.befehlVorlaeufer) ? d.cfg.befehlVorlaeufer : []));
    return [...new Set(uuids.filter((u) => typeof u === 'string' && LOXONE_UUID.test(u)))];
  }

  /** Running state without any device identifiers. */
  getStatus() {
    return {
      running: this._running,
      loggedIn: !!this._cloud?.isLoggedIn?.(),
      authFailed: !!this._cloud?.authFailed,
      devices: this._devs.map((d) => ({ key: d.key, matched: !!d.record, commands: !!d.cmdTopic })),
    };
  }

  // ---- publishing -------------------------------------------------------------

  /**
   * Publish `{"v","ts"}`. Unchanged values are skipped until the heartbeat is
   * due. Synchronous so push updates show up immediately.
   */
  _publish(topic, v, retain, force = false) {
    const now = Date.now();
    const prev = this._last.get(topic);
    if (!force && prev && prev.v === v && now - prev.ts < HEARTBEAT_MS) return;
    this._last.set(topic, { v, ts: now });
    this._ctx.mqttService.publish(topic, JSON.stringify({ v, ts: now }), { retain });
  }

  _publishState(dev) {
    const base = `${this._root}/${dev.key}`;
    const code = dev.values[pk(PROP_STATE)];
    if (code !== undefined) this._publish(`${base}/zustand`, mapState(code, dev.values[pk(PROP_ERROR)]), true);
    const battery = toInt(dev.values[pk(PROP_BATTERY)]);
    if (battery !== null) this._publish(`${base}/akku-prozent`, battery, true);
    const err = toInt(dev.values[pk(PROP_ERROR)]);
    if (err !== null) this._publish(`${base}/fehler`, err, true);
    this._publish(`${base}/verbunden`, 1, true);
  }

  _publishOffline(dev) {
    this._publish(`${this._root}/${dev.key}/verbunden`, 0, true);
  }

  /** Warn once per outage, info once on recovery; text is redacted. */
  _noteFailure(dev, err) {
    if (dev.failing) return;
    dev.failing = true;
    const text = this._cloud.redact ? this._cloud.redact(err?.message ?? 'error') : 'error';
    this._ctx.logger?.warn?.(`[dreame] device '${dev.key}': cloud call failed (${text})`);
  }

  _noteOk(dev) {
    if (!dev.failing) return;
    dev.failing = false;
    this._ctx.logger?.info?.(`[dreame] device '${dev.key}': reachable again`);
  }

  // ---- cloud session, device resolution, polling ----------------------------------

  async _persistRefreshToken(token) {
    const { configService, logger } = this._ctx;
    try {
      const key = `plugins.${this._pluginId}`;
      configService.set(key, { ...(configService.get(key, {}) || {}), refreshToken: token });
      await configService.save?.();
    } catch {
      logger?.warn?.('[dreame] could not persist the refresh key');
    }
  }

  /** @returns {Promise<boolean>} true when logged in and the devices are resolved */
  async _ensureSession() {
    const cloud = this._cloud;
    if (!cloud.isLoggedIn()) {
      if (cloud.authFailed) {
        if (!this._authLogged) {
          this._authLogged = true;
          this._ctx.logger?.error?.('[dreame] cloud refused the credentials, not retrying until restart');
        }
        return false;
      }
      try { await cloud.login(); } catch (err) { this._logCloudError('login failed', err); }
      if (!this._running || !cloud.isLoggedIn()) return false;
    }
    if (!this._resolved) {
      try {
        const records = await cloud.listDevices();
        // stop() may have run meanwhile: no push connections after shutdown
        if (!this._running) return false;
        this._resolveDevices(records);
      } catch (err) {
        this._logCloudError('device list failed', err);
        return false;
      }
    }
    return true;
  }

  _logCloudError(what, err) {
    const text = this._cloud.redact ? this._cloud.redact(err?.message ?? 'error') : 'error';
    this._ctx.logger?.warn?.(`[dreame] ${what} (${text})`);
  }

  /** Match each configured device to an account record (did, name, model; first match wins). */
  _resolveDevices(records) {
    const used = new Set();
    for (const dev of this._devs) {
      const { did, name, model } = dev.cfg;
      const rec = records.find((r) => !used.has(r)
        && (!did || String(r.did) === String(did))
        && (!name || r.name === name)
        && (!model || r.model === model));
      dev.record = rec || null;
      if (rec) used.add(rec);
      else this._ctx.logger?.warn?.(`[dreame] device '${dev.key}' is not in the account`);
    }
    this._resolved = true;
    const matched = this._devs.filter((d) => d.record).map((d) => d.record);
    if (matched.length) this._cloud.startPush(matched, (id, props) => this._onPush(id, props));
  }

  async _pollAll() {
    if (this._polling || !this._running) return;
    this._polling = true;
    try {
      const ok = await this._ensureSession();
      for (const dev of this._devs) {
        if (!this._running) break;
        if (!ok || !dev.record) { this._publishOffline(dev); continue; }
        await this._pollDevice(dev);
      }
    } finally {
      this._polling = false;
    }
  }

  async _pollDevice(dev) {
    try {
      const res = await this._cloud.getProperties(dev.record, [PROP_STATE, PROP_ERROR, PROP_BATTERY]);
      if (!this._running) return;
      if (!res.reachable) { this._publishOffline(dev); return; }
      // a poll is a full snapshot: a value it no longer delivers must not be kept
      // alive by the heartbeat with a fresh timestamp
      dev.values = { ...res.values };
      this._noteOk(dev);
      this._publishState(dev);
    } catch (err) {
      this._publishOffline(dev);
      this._noteFailure(dev, err);
    }
  }

  /** Cloud push: properties_changed for one device id. Unknown ids are dropped. */
  _onPush(did, props) {
    if (!this._running) return;
    const dev = this._devs.find((d) => d.record && String(d.record.did) === String(did));
    if (!dev) return;
    for (const p of props) dev.values[`${p.siid}.${p.piid}`] = p.value;
    this._noteOk(dev);
    this._publishState(dev);
  }

  // ---- commands -------------------------------------------------------------------

  /**
   * the command topic is a Loxone state topic on a broker
   * that LAN clients may write to. A value counts only when the Loxone plugin
   * shows the same value from its Miniserver connection; anything else (foreign
   * publisher, no Loxone plugin, unknown topic) is refused before the gate, so it
   * does not touch the baseline either. Fail closed.
   * Only the forms Loxone itself publishes count: a bare 0/1/2 or its value
   * object. Loxone never sends an id, so the P3 form {v,ts,id} is foreign here
   *.
   */
  _confirmedByLoxone(dev, payload) {
    let live = null;
    try {
      live = this._ctx.pluginManager?.getInstance?.('loxone')?.peekPublishedValue?.(dev.cmdTopic) ?? null;
    } catch { live = null; }
    const v = loxoneValue(payload);
    if (v !== null && live === v) return true;
    this._ctx.logger?.warn?.(`[dreame] device '${dev.key}': command value not confirmed by Loxone, ignored`);
    return false;
  }

  _onMessage(msg) {
    if (!this._running || !msg) return;
    const dev = this._devs.find((d) => d.cmdTopic && d.cmdTopic === msg.topic);
    if (!dev) return;
    if (!msg.retain && !this._confirmedByLoxone(dev, msg.payload)) return;
    const cmd = dev.gate.accept(msg.payload, !!msg.retain);
    if (!cmd) return;
    // a new command overrides a pending return-to-base, also one whose stop call
    // is still running (the sequence number tells _execute it was superseded)
    dev.cmdSeq += 1;
    if (dev.returnTimer) { clearTimeout(dev.returnTimer); dev.returnTimer = null; }
    // one command at a time per device, in arrival order
    const prev = this._chains.get(dev.key) || Promise.resolve();
    const seq = dev.cmdSeq;
    const gen = this._gen;
    const next = prev.then(() => this._execute(dev, cmd, seq, gen)).catch(() => {});
    this._chains.set(dev.key, next);
  }

  _ack(dev, cmd, ok) {
    const now = Date.now();
    this._ctx.mqttService.publish(`${this._root}/${dev.key}/ereignis/befehl`,
      JSON.stringify({ v: cmd, ergebnis: ok ? 'ok' : 'fehler', ts: now }), { retain: false });
  }

  /** @returns {boolean} true while the run that queued a command is still the current one */
  _current(gen) {
    return this._running && this._gen === gen;
  }

  _dropReceipt(dev) {
    this._ctx?.logger?.info?.(`[dreame] receipt for '${dev.key}' dropped: the call ended after the plugin was stopped or restarted`);
  }

  async _run(dev, a, gen) {
    // checked right before sending, also after waits in the queue, the backoff or a token refresh
    if (!this._current(gen)) {
      this._ctx?.logger?.info?.(`[dreame] command for '${dev.key}' dropped: plugin was stopped or restarted`);
      return null;
    }
    try {
      const res = await this._cloud.action(dev.record, a.siid, a.aiid);
      return !!(res && res.ok);
    } catch (err) {
      this._logCloudError(`command failed on '${dev.key}'`, err);
      return false;
    }
  }

  async _execute(dev, cmd, seq, gen) {
    if (!this._current(gen)) return;
    const { logger } = this._ctx;
    if (!dev.record || !this._cloud.isLoggedIn()) {
      logger?.warn?.(`[dreame] command '${cmd}' for '${dev.key}' dropped: cloud not ready`);
      return;
    }
    if (cmd === 'start' || cmd === 'pause') {
      const ok = await this._run(dev, cmd === 'start' ? ACTION_START : ACTION_PAUSE, gen);
      if (ok === null) return;
      if (!this._current(gen)) { this._dropReceipt(dev); return; }
      this._ack(dev, cmd, ok);
      return;
    }
    // stop: halt now, acknowledge it at once, send the robot home after a short pause.
    // unbelegt: the 2 s pause between stop and return-to-base is our choice
    // (the old HA automation did stop, then return_to_base); not timed on the
    // real devices.
    const stopped = await this._run(dev, ACTION_STOP, gen);
    if (stopped === null) return;
    // the receipt belongs to the executed stop, not to the station timer a newer command may cancel
    if (!this._current(gen)) { this._dropReceipt(dev); return; }
    if (!stopped) { this._ack(dev, 'stop', false); return; }
    this._ack(dev, 'stop', true);
    // a newer command arrived while the stop call ran: it wins, no return-to-base
    if (dev.cmdSeq !== seq) return;
    dev.returnTimer = setTimeout(async () => {
      dev.returnTimer = null;
      if (!this._current(gen) || dev.cmdSeq !== seq) return;
      if (!(await this._run(dev, ACTION_DOCK, gen))) {
        logger?.warn?.(`[dreame] device '${dev.key}': return to base failed`);
      }
    }, RETURN_DELAY_MS);
  }
}
