/**
 * REST API routes for plugin management.
 * Registered as a Fastify plugin -- expects app.pluginManager to be decorated.
 */
import { flattenJsonFields } from '../../plugins/lib/binding-utils.js';
import { aggregateHealth } from '../../plugins/lib/binding-health.js';
import { mqttTopicMatch } from './ws-messages.js';
import { isSensitiveKey } from '../services/config-service.js';

const SECRET_MASK = '••••••••';

/**
 * Deep copy with every secret replaced by the mask: schema fields with
 * format "password" plus every key the config service encrypts, at any depth
 *.
 */
function maskSecrets(value, passwordKeys = new Set()) {
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const secret = passwordKeys.has(k) || isSensitiveKey(k);
    out[k] = secret && v != null && v !== '' ? SECRET_MASK : maskSecrets(v);
  }
  return out;
}

const EMPTY_KEYS = new Set();
// Keys a request body must never carry into a config object.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Array elements are matched by the first of these fields they carry.
const IDENTITY_KEYS = ['id', 'key', 'uuid'];
// Same rule as PluginManager: an id is a plain name, never a config path.
const PLUGIN_ID = /^[a-z0-9-]+$/;

/** The client returned the mask for a secret that has no stored value. */
class MaskError extends Error {
  constructor(path) {
    super(`masked secret without stored value at ${path}`);
    this.path = path;
  }
}

function identityOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  for (const k of IDENTITY_KEYS) {
    if (typeof v[k] === 'string' || typeof v[k] === 'number') return `${k}:${v[k]}`;
  }
  return undefined;
}

/**
 * Stored counterpart of an array element: by id/key/uuid, by index only for
 * elements without identity in a list of unchanged length.
 */
function counterpartOf(item, index, incoming, existing, byIndex) {
  if (!Array.isArray(existing)) return undefined;
  const ident = identityOf(item);
  if (ident !== undefined) return existing.find((e) => identityOf(e) === ident);
  return byIndex && existing.length === incoming.length ? existing[index] : undefined;
}

/**
 * Put the stored value back wherever the client returned the mask for a
 * secret. A mask without a stored value throws MaskError instead of saving
 * an empty secret; a mask in a non-secret field is ordinary text.
 */
function restoreMasked(incoming, existing, { passwordKeys = EMPTY_KEYS, byIndex = true } = {}) {
  function walk(value, stored, path, secret, keys) {
    if (value === SECRET_MASK && secret) {
      if (stored == null || stored === '') throw new MaskError(path);
      return stored;
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => walk(v, counterpartOf(v, i, value, stored, byIndex), `${path}[${i}]`, false, EMPTY_KEYS));
    }
    if (!value || typeof value !== 'object') return value;
    const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k)) continue;
      const child = Object.hasOwn(base, k) ? base[k] : undefined;
      out[k] = walk(v, child, path ? `${path}.${k}` : k, keys.has(k) || isSensitiveKey(k), EMPTY_KEYS);
    }
    return out;
  }
  return walk(incoming, existing, '', false, passwordKeys);
}

function maskError(reply, err) {
  return reply.status(400).send({ error: 'masked_secret_without_value', detail: err.path });
}

const TOPICS_DEFAULT_LIMIT = 500;
const TOPICS_MAX_LIMIT = 5000;
/** In-memory activity log (last 100 entries) */
const activityLog = [];
const MAX_LOG_ENTRIES = 100;

function addLogEntry(entry) {
  activityLog.unshift({ ...entry, timestamp: Date.now() });
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.length = MAX_LOG_ENTRIES;
}

// Loxone UUIDs: 8-4-4-16 hex, as in LoxAPP3.json.
const LOXONE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/;
// Plain command words like "on", "pulse", "changeTo/2", "setBrightness/45.5".
const CONTROL_COMMAND = /^[A-Za-z0-9_.,+\-/]+$/;

export default async function apiPlugins(app) {
  // Every :id route takes a plain plugin id, never a config path
  //.
  app.addHook('preValidation', async (request, reply) => {
    const id = request.params?.id;
    if (id !== undefined && !PLUGIN_ID.test(id)) {
      return reply.status(404).send({ error: 'Plugin not found' });
    }
  });

  /** Schema fields with format "password" (masked even without a secret-like name). */
  function schemaPasswordKeys(id) {
    const instance = app.pluginManager.getInstance(id);
    const schema = instance && typeof instance.getConfigSchema === 'function'
      ? instance.getConfigSchema()
      : app.pluginManager.getSchema(id);
    const props = (schema && schema.properties) || {};
    return new Set(Object.entries(props).filter(([, p]) => p.format === 'password').map(([k]) => k));
  }

  // GET /api/activity-log -- get recent activity
  app.get('/api/activity-log', async () => {
    return activityLog;
  });

  // DELETE /api/activity-log -- clear log
  app.delete('/api/activity-log', async () => {
    activityLog.length = 0;
    return { ok: true };
  });

  // POST /api/mqtt/publish -- publish a message to the broker
  app.post('/api/mqtt/publish', async (request, reply) => {
    const { topic, payload, retain, qos } = request.body || {};
    if (!topic || typeof topic !== 'string') {
      return reply.status(400).send({ error: 'topic is required' });
    }
    try {
      await app.mqttService.publish(topic, payload ?? '', {
        retain: !!retain,
        qos: typeof qos === 'number' ? qos : 0,
      });
      addLogEntry({ action: 'publish', topic, payload: payload ?? '', retain: !!retain, qos: typeof qos === 'number' ? qos : 0 });
      app.log.info(`MQTT Publish: ${topic} → ${payload ?? ''}`);
      return { ok: true, topic, payload: payload ?? '' };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  function enrichTopicPrefix(p) {
    const cfg = app.configService.get(`plugins.${p.id}`, {}) || {};
    let topicPrefix = null;
    if (p.type === 'loxone') topicPrefix = cfg.prefix || 'loxone';
    else if (p.type === 'mqtt-bridge') topicPrefix = cfg.localPrefix || 'venus';
    else if (p.type === 'unifi') topicPrefix = cfg.topicPrefix || 'unifi-bridge';
    return { ...p, topicPrefix };
  }

  // GET /api/plugins -- list all plugins with status + topic prefix
  app.get('/api/plugins', async () => {
    const plugins = await app.pluginManager.listAll();
    return plugins.map(enrichTopicPrefix);
  });

  // GET /api/plugins/:id -- single plugin status + topic prefix.
  // Mirrors the list-endpoint shape so the WAN / Clients pages (Phase 13/14)
  // can poll one plugin without parsing the whole list. Falls through to
  // /api/plugins/templates and /api/plugins/:type/probe via find-my-way's
  // static-segment precedence.
  app.get('/api/plugins/:id', async (request, reply) => {
    const { id } = request.params;
    if (id === 'templates') return; // defensive: find-my-way should already route this
    const plugins = await app.pluginManager.listAll();
    const match = plugins.find((p) => p.id === id);
    if (!match) {
      return reply.status(404).send({ error: `Plugin '${id}' not found` });
    }
    return enrichTopicPrefix(match);
  });

  // GET /api/bindings -- flat list of every input binding across plugins.
  // Used by the Topic Browser to flag topics that already have a binding so
  // users see at a glance which sources are already wired up.
  app.get('/api/bindings', async () => {
    const out = [];
    // Read straight from the config so stopped or never-loaded plugins still
    // contribute their bindings — listAll() only sees the in-memory instances.
    const allPlugins = app.configService.get('plugins', {}) || {};
    for (const [pluginId, cfg] of Object.entries(allPlugins)) {
      // Live plugin instance has the freshest bindings (e.g. just-saved).
      const instance = app.pluginManager.getInstance?.(pluginId);
      let bindings = null;
      if (instance && typeof instance.getInputBindings === 'function') {
        try { bindings = instance.getInputBindings(); } catch { /* fall through */ }
      }
      if (!Array.isArray(bindings)) bindings = cfg.inputBindings || [];
      const pluginName = cfg.displayName || pluginId;
      for (const b of bindings) {
        if (!b || !b.mqttTopic) continue;
        out.push({
          pluginId,
          pluginName,
          id: b.id,
          enabled: b.enabled !== false,
          mqttTopic: b.mqttTopic,
          jsonField: b.jsonField,
          targetUuid: b.targetUuid,
          label: b.label || b.id,
        });
      }
    }
    return out;
  });

  // GET /api/plugins/templates -- available plugin types for "Add Plugin"
  app.get('/api/plugins/templates', async () => {
    return app.pluginManager.getTemplates();
  });

  // POST /api/plugins/create -- create a new plugin instance
  app.post('/api/plugins/create', async (request, reply) => {
    const { type, id, preset } = request.body || {};
    if (!type || !id) {
      return reply.status(400).send({ error: 'type and id are required' });
    }
    try {
      const result = await app.pluginManager.createInstance(type, id, preset || null);
      return result;
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  /**
   * POST /api/plugins/:type/probe — one-shot Test-Connection round-trip.
   *
   * Used by the webapp's Test Connection button (D-12) to validate the user-
   * entered creds BEFORE save. Constructs a transient UnifiClient (no jar
   * reuse, rememberMe:false), runs checkUnifiOs + login + GET /api/system,
   * and returns a structured status payload so the form can render an
   * appropriate banner without surfacing raw stack traces.
   *
   * Phase-7 invariants:
   *   - NEVER persists to ConfigService — the route does not call
   *     configService.set or configService.save (T-07-08 mitigation).
   *   - NEVER echoes the password or any stack trace back to the client
   *     (T-07-07 mitigation) — only err.message from typed errors leaves
   *     the server.
   *   - Restricted to type === 'unifi' for now; future plugin types may
   *     opt-in by extending the type-switch (T-07-10 mitigation).
   *
   * Always replies 200 for credential / network failures — the structured
   * body carries the failure mode (status: 'ok' | 'auth_failed' |
   * '2fa_blocked' | 'network_down'). Only malformed input returns 400.
   */
  app.post('/api/plugins/:type/probe', async (request, reply) => {
    const { type } = request.params;
    if (type !== 'unifi') {
      return reply.status(404).send({ error: `probe not supported for plugin type '${type}'` });
    }

    const { host, username, password, site = 'default', tlsVerify = false } = request.body || {};
    if (typeof host !== 'string' || !host ||
        typeof username !== 'string' || !username ||
        typeof password !== 'string' || !password) {
      return reply.status(400).send({ error: 'host, username, password are required' });
    }

    // Dynamic import keeps the route lightweight when the unifi plugin is not
    // in use, and allows the probe to run even when no plugin instance exists.
    const { UnifiClient } = await import('../../plugins/unifi/unifi-client.js');

    const client = new UnifiClient({
      host,
      username,
      password,
      site,
      tlsVerify,
      rememberMe: false,
      logger: app.log,
    });

    // D-11b: capture sso_account_warning even though the event fires inside
    // the synchronous part of login(). We listen BEFORE calling login().
    let ssoAccount = false;
    client.on('sso_account_warning', () => { ssoAccount = true; });

    try {
      const isUnifiOs = await client.checkUnifiOs();
      if (!isUnifiOs) {
        await client.disconnect().catch(() => {});
        return reply.send({ status: 'auth_failed', error: 'Legacy CloudKey not supported in v1.1' });
      }

      await client.login();

      let controllerName = null;
      try {
        const sysinfo = await client.request({ method: 'GET', path: '/api/system' });
        controllerName = sysinfo?.name || sysinfo?.hostname || null;
      } catch {
        // Login succeeded — sysinfo failure is non-fatal for the probe.
      }

      await client.disconnect().catch(() => {});
      return reply.send({ status: 'ok', controllerName, siteName: site, ssoAccount });
    } catch (err) {
      const clientState = client.getStatus?.() || {};
      const reason = clientState.authStateReason;

      // Best-effort cleanup — never block the response on disconnect.
      await client.disconnect().catch(() => {});

      if (reason === '2fa_blocked') {
        return reply.send({ status: '2fa_blocked', error: '2FA admin not supported — create a local-only admin' });
      }
      if (reason === 'invalid_credentials') {
        return reply.send({ status: 'auth_failed', error: 'Invalid credentials' });
      }
      if (reason === 'rate_limited') {
        return reply.send({ status: 'auth_failed', error: 'Rate-limited by controller — wait 5 min before retrying' });
      }
      if (reason === 'forbidden_no_network_management_permission') {
        return reply.send({ status: 'auth_failed', error: 'Admin account lacks network.management permission' });
      }
      if (reason === 'host_unreachable' || reason === 'tls_handshake_failed' || reason === 'controller_starting_up') {
        return reply.send({ status: 'network_down', error: err.message || 'Controller unreachable' });
      }
      // Fallback — log nothing sensitive, return only err.message.
      return reply.send({ status: 'auth_failed', error: err.message || 'Unknown authentication error' });
    }
  });

  // DELETE /api/plugins/:id -- delete a plugin instance
  app.delete('/api/plugins/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      await app.pluginManager.deleteInstance(id);
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // POST /api/plugins/:id/start
  app.post('/api/plugins/:id/start', async (request, reply) => {
    const { id } = request.params;
    try {
      await app.pluginManager.start(id);
      return { ok: true };
    } catch (err) {
      if (err.message.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/plugins/:id/stop
  app.post('/api/plugins/:id/stop', async (request, reply) => {
    const { id } = request.params;
    try {
      await app.pluginManager.stop(id);
      return { ok: true };
    } catch (err) {
      if (err.message.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/plugins/:id/reload
  app.post('/api/plugins/:id/reload', async (request, reply) => {
    const { id } = request.params;
    try {
      await app.pluginManager.reload(id);
      return { ok: true };
    } catch (err) {
      if (err.message.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/plugins/:id/config
  app.get('/api/plugins/:id/config', async (request, reply) => {
    const { id } = request.params;
    try {
      // Try live instance first, fall back to schema cached at discovery time
      const instance = app.pluginManager.getInstance(id);
      let schema = {};
      if (instance && typeof instance.getConfigSchema === 'function') {
        schema = instance.getConfigSchema();
      } else {
        schema = app.pluginManager.getSchema(id);
      }
      // Mask sensitive fields in API response — never send passwords/tokens to the browser
      const props = (schema && schema.properties) || {};
      const passwordKeys = new Set(Object.entries(props).filter(([, p]) => p.format === 'password').map(([k]) => k));
      const config = maskSecrets(app.pluginManager.getConfig(id), passwordKeys);
      // Strip internal fields managed by their own endpoints
      delete config.inputBindings;
      delete config.disabledControls;
      delete config.topicRoutes;
      return { config, schema };
    } catch (err) {
      if (err.message.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message });
    }
  });

  // PUT /api/plugins/:id/config
  app.put('/api/plugins/:id/config', async (request, reply) => {
    const { id } = request.params;
    try {
      const existingConfig = app.pluginManager.getConfig(id);
      // Strip internal fields that have their own API endpoints
      const body = { ...request.body };
      delete body.inputBindings;
      delete body.disabledControls;
      delete body.topicRoutes;
      // Merge: existing config as base, UI fields on top; a returned mask
      // (at any depth) keeps the stored secret
      const restored = restoreMasked(body, existingConfig, { passwordKeys: schemaPasswordKeys(id) });
      const newConfig = { ...existingConfig, ...restored };
      await app.pluginManager.setConfig(id, newConfig);

      // If running, reload so prefix/ip/port/credential changes actually take
      // effect — setConfig only persists; the live instance still holds the
      // old config until restart. (see 260511-7d0)
      const status = app.pluginManager.getStatus(id);
      if (status.status === 'running') {
        try {
          await app.pluginManager.reload(id);
          const newStatus = app.pluginManager.getStatus(id);
          return { ok: true, reloaded: true, status: newStatus.status, error: newStatus.error };
        } catch (reloadErr) {
          return { ok: true, reloaded: false, reloadError: reloadErr.message };
        }
      }

      // Auto-start: if plugin is stopped/error, try to start it after config save
      if (status.status === 'stopped' || status.status === 'error') {
        try {
          await app.pluginManager.start(id);
          const newStatus = app.pluginManager.getStatus(id);
          return { ok: true, autoStarted: true, status: newStatus.status, error: newStatus.error };
        } catch (startErr) {
          return { ok: true, autoStarted: false, startError: startErr.message };
        }
      }

      return { ok: true };
    } catch (err) {
      if (err instanceof MaskError) return maskError(reply, err);
      if (err.message.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message });
    }
  });

  // --- Plugin-specific endpoints (dynamic :id) ---

  // GET /api/plugins/:id/controls -- list all discovered controls
  app.get('/api/plugins/:id/controls', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.getControls !== 'function') {
        return reply.status(400).send({ error: 'Plugin is not running or has no controls' });
      }
      return instance.getControls();
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/plugins/:id/controls/detailed -- controls with subcontrols and live state
  app.get('/api/plugins/:id/controls/detailed', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.getDetailedControls !== 'function') {
        return reply.status(400).send({ error: 'Plugin is not running or has no detailed controls' });
      }
      return instance.getDetailedControls();
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // PUT /api/plugins/:id/controls/:uuid -- toggle control enabled state
  app.put('/api/plugins/:id/controls/:uuid', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.setControlEnabled !== 'function') {
        return reply.status(400).send({ error: 'Plugin is not running or does not support control toggling' });
      }
      const { uuid } = request.params;
      const { enabled } = request.body || {};
      await instance.setControlEnabled(uuid, !!enabled);
      return { ok: true };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/plugins/:id/controls/:uuid/cmd -- send command to a control via WebSocket
  app.post('/api/plugins/:id/controls/:uuid/cmd', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.sendControlCommand !== 'function') {
        return reply.status(400).send({ error: 'Plugin is not running or does not support commands' });
      }
      const { uuid } = request.params;
      const { command } = request.body || {};
      if (!command || typeof command !== 'string') {
        return reply.status(400).send({ error: 'command is required' });
      }
      // the command is spliced into jdev/sps/io/<uuid>/<command>,
      // so only structure UUIDs and plain command words (no ".." anywhere, no query) pass.
      if (!LOXONE_UUID.test(uuid)) {
        return reply.status(400).send({ error: 'invalid uuid' });
      }
      if (command.length > 64 || !CONTROL_COMMAND.test(command) || command.includes('..')) {
        return reply.status(400).send({ error: 'invalid command' });
      }
      if (typeof instance.hasControl !== 'function') {
        return reply.status(400).send({ error: 'Plugin cannot confirm controls' });
      }
      if (!instance.hasControl(uuid)) {
        return reply.status(404).send({ error: 'unknown control' });
      }
      instance.sendControlCommand(uuid, command);
      return { ok: true, uuid, command };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/plugins/:id/structure/raw -- aggregate summary of the running
  // plugin's parsed LoxAPP3.json. Used by the Structure Inspector debug
  // panel so the user can verify what the plugin sees without grepping logs.
  app.get('/api/plugins/:id/structure/raw', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.getStructureSummary !== 'function') {
        return reply.status(400).send({ error: 'Plugin is not running or has no structure' });
      }
      return instance.getStructureSummary();
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/plugins/:id/structure/refresh -- on-demand re-fetch of
  // LoxAPP3.json from the Miniserver. Same path as the 60s StructureMonitor
  // poll; returns the new summary in one round-trip.
  app.post('/api/plugins/:id/structure/refresh', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.refreshStructure !== 'function') {
        return reply.status(400).send({ error: 'Plugin is not running or does not support structure refresh' });
      }
      return await instance.refreshStructure();
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/plugins/:id/moods -- get mood mappings
  app.get('/api/plugins/:id/moods', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.getMoodMappings !== 'function') {
        return reply.status(400).send({ error: 'Plugin does not support mood mappings' });
      }
      return instance.getMoodMappings();
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // PUT /api/plugins/:id/moods -- save mood mappings
  app.put('/api/plugins/:id/moods', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.setMoodMappings !== 'function') {
        return reply.status(400).send({ error: 'Plugin does not support mood mappings' });
      }
      await instance.setMoodMappings(request.body || {});
      return { ok: true };
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/plugins/:id/bindings -- list MQTT input bindings for a plugin
  app.get('/api/plugins/:id/bindings', async (request, reply) => {
    const { id } = request.params;
    try {
      const instance = app.pluginManager.getInstance(id);
      if (instance && typeof instance.getInputBindings === 'function') {
        return maskSecrets(instance.getInputBindings());
      }
      // Fallback: read from config directly
      const config = app.pluginManager.getConfig(id);
      return maskSecrets(config.inputBindings || []);
    } catch (err) {
      if (err.message.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/plugins/:id/bindings/stats -- live stats per binding
  // (last value, send/recv counts, last reason, errors). Used by the UI to
  // show what's actually flowing through.
  app.get('/api/plugins/:id/bindings/stats', async (request, reply) => {
    const { id } = request.params;
    try {
      const instance = app.pluginManager.getInstance(id);
      if (instance && typeof instance.getInputBindingStats === 'function') {
        return instance.getInputBindingStats();
      }
      return [];
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // PUT /api/plugins/:id/bindings -- save MQTT input bindings for a plugin
  app.put('/api/plugins/:id/bindings', async (request, reply) => {
    const { id } = request.params;
    try {
      // GET hands out masked secrets; put the stored ones back by binding id
      // Bindings carry ids; never fall back to the index.
      const bindings = restoreMasked(request.body || [], readBindingsForPlugin(id), { byIndex: false });
      const instance = app.pluginManager.getInstance(id);
      if (instance && typeof instance.setInputBindings === 'function') {
        await instance.setInputBindings(bindings);
      } else {
        // Store in config directly for plugins without runtime binding support
        const config = app.pluginManager.getConfig(id);
        config.inputBindings = bindings;
        await app.pluginManager.setConfig(id, config);
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof MaskError) return maskError(reply, err);
      if (err.message.includes('not found')) {
        return reply.status(404).send({ error: err.message });
      }
      return reply.status(500).send({ error: err.message });
    }
  });

  // ─── Bindings export / import (aggregate) ─────────────────────────────
  //
  // These power both the per-plugin Export/Import buttons (the file format
  // is "type":"mqtt-master-bindings-export", version 1) and the global
  // Backup page. The single-plugin endpoints (`GET|PUT /api/plugins/:id/
  // bindings`) already exist above — the aggregate endpoints below iterate
  // every plugin so the user can snapshot everything in one round-trip.

  /**
   * Read a plugin's bindings using the same precedence as
   * GET /api/plugins/:id/bindings: live instance first, config fallback.
   * Returns [] for unknown plugins so the export can't 500 mid-iteration.
   */
  function readBindingsForPlugin(pluginId) {
    try {
      const instance = app.pluginManager.getInstance?.(pluginId);
      if (instance && typeof instance.getInputBindings === 'function') {
        const live = instance.getInputBindings();
        if (Array.isArray(live)) return live;
      }
    } catch { /* fall through to config */ }
    try {
      const config = app.pluginManager.getConfig(pluginId);
      if (Array.isArray(config?.inputBindings)) return config.inputBindings;
    } catch { /* unknown plugin */ }
    return [];
  }

  /**
   * Write a plugin's bindings using the same precedence as
   * PUT /api/plugins/:id/bindings.
   */
  async function writeBindingsForPlugin(pluginId, bindings) {
    const instance = app.pluginManager.getInstance?.(pluginId);
    if (instance && typeof instance.setInputBindings === 'function') {
      await instance.setInputBindings(bindings);
      return;
    }
    const config = app.pluginManager.getConfig(pluginId);
    config.inputBindings = bindings;
    await app.pluginManager.setConfig(pluginId, config);
  }

  // GET /api/bindings/export -- single-shot snapshot of every plugin's
  // input bindings. Output shape matches the file format the UI writes.
  app.get('/api/bindings/export', async () => {
    const plugins = await app.pluginManager.listAll();
    const out = {
      type: 'mqtt-master-bindings-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      scope: 'all',
      plugins: {},
    };
    for (const p of plugins) {
      const bindings = maskSecrets(readBindingsForPlugin(p.id));
      out.plugins[p.id] = {
        pluginType: p.type || null,
        displayName: p.displayName || p.name || p.id,
        bindings,
      };
    }
    return out;
  });

  // POST /api/bindings/import -- apply a previously-exported snapshot.
  // Body: { mode: 'merge' | 'replace' | 'copy', payload: <export file> }.
  app.post('/api/bindings/import', async (request, reply) => {
    const { mode, payload } = request.body || {};
    if (mode !== 'merge' && mode !== 'replace' && mode !== 'copy') {
      return reply.status(400).send({ error: 'invalid_mode', detail: 'mode must be "merge", "replace" or "copy"' });
    }
    if (!payload || typeof payload !== 'object') {
      return reply.status(400).send({ error: 'invalid_export_file', detail: 'payload is required' });
    }
    if (payload.type !== 'mqtt-master-bindings-export') {
      return reply.status(400).send({ error: 'invalid_export_file', detail: 'wrong type' });
    }
    if (payload.version !== 1) {
      return reply.status(400).send({ error: 'invalid_export_file', detail: 'unsupported version' });
    }
    if (payload.scope !== 'all') {
      return reply.status(400).send({ error: 'invalid_export_file', detail: 'scope must be "all"' });
    }
    if (!payload.plugins || typeof payload.plugins !== 'object') {
      return reply.status(400).send({ error: 'invalid_export_file', detail: 'plugins map is required' });
    }

    const livePlugins = await app.pluginManager.listAll();
    const liveIds = new Set(livePlugins.map(p => p.id));

    // The export carries masks; restore every plugin's secrets (by binding
    // id only) before writing anything, so a stray mask changes nothing.
    const restoredBindings = new Map();
    try {
      for (const [pluginId, entry] of Object.entries(payload.plugins)) {
        if (!liveIds.has(pluginId)) continue;
        const incoming = Array.isArray(entry?.bindings) ? entry.bindings : [];
        restoredBindings.set(pluginId, restoreMasked(incoming, readBindingsForPlugin(pluginId), { byIndex: false }));
      }
    } catch (err) {
      if (err instanceof MaskError) return maskError(reply, err);
      throw err;
    }

    const applied = [];
    const skipped = [];
    const conflicts = [];

    for (const pluginId of Object.keys(payload.plugins)) {
      if (!liveIds.has(pluginId)) {
        skipped.push({ pluginId, reason: 'plugin_not_found' });
        continue;
      }
      const incoming = restoredBindings.get(pluginId);

      if (mode === 'replace') {
        await writeBindingsForPlugin(pluginId, incoming);
        applied.push({ pluginId, count: incoming.length });
        continue;
      }

      if (mode === 'copy') {
        // copy: append EVERY incoming binding as a fresh, independent clone.
        // No skipping — duplicates are intentionally kept so a user can clone
        // a setup. Each clone gets a batch-unique id and a ' (copy)' label
        // suffix (same rules as copyBindingArrays on the client).
        const existing = readBindingsForPlugin(pluginId);
        const stamp = Date.now();
        const merged = existing.slice();
        incoming.forEach((b, index) => {
          if (!b || typeof b !== 'object') return;
          const baseLabel = (typeof b.label === 'string' && b.label) || b.id || '';
          merged.push({
            ...b,
            id: 'b-' + stamp + '-' + index,
            label: `${baseLabel} (copy)`,
          });
        });
        await writeBindingsForPlugin(pluginId, merged);
        applied.push({ pluginId, count: incoming.length });
        continue;
      }

      // merge: keep existing, append non-duplicate incoming.
      const existing = readBindingsForPlugin(pluginId);
      const existingIds = new Set(existing.map(b => b?.id).filter(Boolean));
      const existingTriples = new Set(existing.map(b =>
        `${b?.mqttTopic ?? ''} ${b?.jsonField ?? ''} ${b?.targetUuid ?? ''}`));
      const merged = existing.slice();
      let added = 0;
      for (const b of incoming) {
        if (!b || typeof b !== 'object') continue;
        if (b.id && existingIds.has(b.id)) {
          conflicts.push({ pluginId, bindingId: b.id, reason: 'duplicate_id' });
          continue;
        }
        const triple = `${b.mqttTopic ?? ''} ${b.jsonField ?? ''} ${b.targetUuid ?? ''}`;
        if (existingTriples.has(triple)) {
          conflicts.push({ pluginId, bindingId: b.id, reason: 'duplicate_target' });
          continue;
        }
        merged.push(b);
        if (b.id) existingIds.add(b.id);
        existingTriples.add(triple);
        added += 1;
      }
      await writeBindingsForPlugin(pluginId, merged);
      applied.push({ pluginId, count: added });
    }

    return { ok: true, applied, skipped, conflicts };
  });

  // GET /api/bindings/health -- per-plugin binding-health rollup.
  //
  // Drives the green/orange/red dot on the "Input Bindings" sidebar entry.
  // For every plugin with a live instance exposing getInputBindingStats()
  // (i.e. running plugins), we read its stats, run aggregateHealth(), and key
  // the result by plugin id.
  //
  // Intentionally omitted from the response:
  //  - Stopped plugins / plugins without binding support — their own plugin
  //    dot already signals the stoppage; a second red dot would just be noise.
  //  - Running plugins with zero bindings — aggregate severity would be
  //    'none', so there is nothing to render.
  //
  // Per-plugin try/catch: a single plugin whose getInputBindingStats() throws
  // must not 500 the whole endpoint — it is skipped, others still returned.
  app.get('/api/bindings/health', async () => {
    const plugins = await app.pluginManager.listAll();
    const now = Date.now();
    const out = {};
    for (const p of plugins) {
      try {
        const instance = app.pluginManager.getInstance?.(p.id);
        if (!instance || typeof instance.getInputBindingStats !== 'function') {
          continue; // stopped / no binding support
        }
        const stats = instance.getInputBindingStats();
        const health = aggregateHealth(Array.isArray(stats) ? stats : [], now);
        if (health.severity === 'none') continue; // no enabled bindings
        out[p.id] = health;
      } catch (err) {
        // One bad plugin must not take down the whole endpoint.
        app.log.warn(`bindings/health: skipped plugin '${p.id}': ${err.message}`);
      }
    }
    return out;
  });

  // GET /api/mqtt/topics -- search/snapshot the server-side topic cache.
  //
  // Returns topics the broker has seen since startup, newest-first, each with
  // the latest payload, retained flag (best-effort sticky-true; see
  // topic-cache-service.js), last-seen timestamp, age in ms, and message
  // count. Built so LLM agents (and the Topic Browser UI) can FIND topics
  // without grepping a cache dump.
  //
  // Filters (optional, combinable -- a topic must satisfy every supplied one):
  //   ?q=<substr>   case-insensitive substring match on the topic name
  //   ?regex=<re>   JS regex tested against the topic name (invalid -> 400)
  //   ?filter=<pat> MQTT wildcard (+/#) via mqttTopicMatch
  // Shaping:
  //   ?limit=<n>    max topics, default 500, clamped 1..5000
  //   ?values=false drop payloads (topic names only)
  //   ?envelope=true wrap as { count, total, topics:[...] }
  //
  // Default response is a flat array (back-compat: the Topic Browser and the
  // input-bindings page iterate it directly). `?envelope=true` adds the
  // count/total metadata for agents that want it.
  app.get('/api/mqtt/topics', async (request, reply) => {
    const { q, regex, filter, limit, values, envelope } = request.query ?? {};

    let re = null;
    if (regex) {
      try {
        re = new RegExp(regex, 'i');
      } catch (err) {
        return reply.code(400).send({
          error: 'invalid_regex',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const needle = q ? String(q).toLowerCase() : null;
    const dropValues = values !== undefined && ['false', '0', 'no'].includes(String(values).toLowerCase());
    const n = Number.parseInt(limit, 10);
    const max = !Number.isFinite(n) || n <= 0 ? TOPICS_DEFAULT_LIMIT : Math.min(n, TOPICS_MAX_LIMIT);

    const snapshot = app.topicCacheService.list(); // newest-first
    const total = snapshot.length;
    const now = Date.now();
    const out = [];

    for (const entry of snapshot) {
      if (needle && !entry.topic.toLowerCase().includes(needle)) continue;
      if (re && !re.test(entry.topic)) continue;
      if (filter && !mqttTopicMatch(filter, entry.topic)) continue;

      const row = {
        topic: entry.topic,
        retained: entry.retained ?? false,
        ts: entry.ts,
        ageMs: now - entry.ts,
        count: entry.count,
      };
      if (!dropValues) row.payload = entry.payload;
      out.push(row);

      if (out.length >= max) break;
    }

    const wantEnvelope = envelope !== undefined && ['true', '1', 'yes'].includes(String(envelope).toLowerCase());
    return wantEnvelope ? { count: out.length, total, topics: out } : out;
  });

  // DELETE /api/mqtt/topics -- forget every cached topic. Useful when stale
  // entries linger after a device is removed.
  app.delete('/api/mqtt/topics', async () => {
    app.topicCacheService.clear();
    return { ok: true };
  });

  // POST /api/mqtt/discover -- subscribe to a pattern, collect messages, return topics with sample payloads
  app.post('/api/mqtt/discover', async (request, reply) => {
    const { pattern, durationMs = 3000 } = request.body || {};
    if (!pattern || typeof pattern !== 'string') {
      return reply.status(400).send({ error: 'pattern is required (e.g. "inverter-proxy/#")' });
    }
    const duration = Math.min(Math.max(Number(durationMs) || 3000, 1000), 10000);

    const collected = new Map(); // topic -> { payload, fields, ts }

    const handler = (msg) => {
      if (collected.has(msg.topic)) return; // one sample per topic
      let fields = null;
      try {
        const data = JSON.parse(msg.payload);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          // Recursive: dotted paths so nested numerics (e.g. Tasmota
          // ENERGY.Power) are picked up by the binding UI. The `key` field
          // stays for back-compat with older clients.
          fields = flattenJsonFields(data).map(({ path, value, type }) => ({
            key: path,
            path,
            type,
            sample: typeof value === 'number' ? value : String(value).substring(0, 100),
          }));
        }
      } catch { /* not JSON */ }
      collected.set(msg.topic, {
        topic: msg.topic,
        payload: msg.payload.substring(0, 500),
        fields,
        ts: Date.now(),
      });
    };

    app.mqttService.subscribe(pattern);
    app.mqttService.on('message', handler);

    await new Promise(resolve => setTimeout(resolve, duration));

    app.mqttService.removeListener('message', handler);
    app.mqttService.unsubscribe(pattern);

    return [...collected.values()];
  });

  // GET /api/plugins/:id/elements -- list bridged topics with live values
  app.get('/api/plugins/:id/elements', async (request, reply) => {
    try {
      const instance = app.pluginManager.getInstance(request.params.id);
      if (!instance || typeof instance.getElements !== 'function') {
        return reply.status(400).send({ error: 'Plugin is not running or has no elements' });
      }
      return instance.getElements();
    } catch (err) {
      return reply.status(500).send({ error: err.message });
    }
  });

}
